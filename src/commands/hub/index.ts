// `hub` — the agent-hub client (roadmap ISSUE-20..ISSUE-23).
//
// Five things an agent needs and could not do before: hear from another session
// while idle, message one, publish what it is doing, see who else exists, and read
// back what was said. `watch` is the one that matters - it is a long poll whose
// every stdout line becomes a notification through the Monitor tool, which is one
// of only two mechanisms that can wake an idle Claude Code session.
//
// **Arming the watcher IS the registration** (roadmap D2). There is no register
// command, no enrolment code and nothing for a human to paste: the first poll
// puts the agent on the roster and, if this machine has never been seen, into the
// owner's approval queue. Which is why `watch` has to explain a pending approval
// well enough that the agent can tell its user what to do (ISSUE-23) - the agent is
// usually the only party present.
//
// Every line printed here costs its agent context, so stdout is rationed: traffic,
// the approval instruction, a first failure and a recovery. Routine noise -
// repeated pending polls, per-attempt backoff - goes to stderr, which the Monitor
// does not surface.

import chalk from 'chalk';
import { spawnSync } from 'child_process';
import { Command } from 'commander';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { loadConfig } from '../../config/index.js';
import { backoffDelay, formatDelay, sleep } from '../../services/backoff.js';
import {
  AGENT_NAME_PATTERN,
  MAX_AGENT_PRUNE,
  appendHubLog,
  BROADCAST_TARGET,
  CLIENT_ABORT_MS,
  consoleUrl,
  CURSOR_TAIL,
  DEFAULT_LOG_LIMIT,
  HubClient,
  HubCursorError,
  type HubMessage,
  HubNotApprovedError,
  HubNotHubError,
  HubRenamedError,
  HubArchiveUnreadableError,
  HubPermanentError,
  HubTransientError,
  findRecentSend,
  forgetSent,
  MAX_MESSAGE_TTL_SECONDS,
  parseTtl,
  readSent,
  recordSent,
  RESEND_WINDOW_MS,
  type SendKey,
  withSendLock,
  hubLogPath,
  hubOrigin,
  type HubStateUpdate,
  type HubWatchState,
  loadHubState,
  MAX_LOG_LIMIT,
  messageKey,
  readHubLog,
  RESTART_KIND,
  saveHubState,
  SERVER_HOLD_MS,
  hubStateDir,
  hubRenamedToPath,
  followRenames,
} from '../../services/hub.js';
import { acquireWatchOwnership, findUnlockedWatchers } from '../../services/hub-owner.js';
import { FingerprintError, machineFingerprint, type MachineFingerprint } from '../../services/hub-fingerprint.js';
import { listenPressOf, renderTgMessages, senderLabel, transcribeTgVoice } from '../../services/hub-telegram.js';
import { TelegramBotService } from '../../services/telegram-bot.js';
import { acceptListenPress, listenButtonFor, SpeechQueue } from '../telegram-bot/index.js';
import { ListenLedger } from '../../services/hub-listen.js';
import { resolveMessageArg } from '../telegram/stdin.js';

/**
 * How often a still-unapproved watcher repeats the instruction on stdout.
 *
 * It keeps polling every fifteen seconds - its queue slot refreshes while it does,
 * which is the reason not to back off - but one notification per fifteen seconds
 * would bury the agent in the same sentence. Every five minutes is enough for the
 * fact to survive a long conversation.
 */
const PENDING_REMINDER_MS = 5 * 60_000;

/** Failures before a transient problem is worth a notification rather than a log line. */
const FAILURES_BEFORE_ERROR = 3;
/**
 * How long the hub may be unreachable before the watcher says so. Every line it prints wakes the agent, and
 * a hub rollout or a rescheduled pod is over in a minute or two with nothing for anyone to do (Davron,
 * 2026-10-06: a watcher event nobody acts on is a defect in the watcher). An outage that lasts longer is
 * still reported, and its recovery with it, so silence never stands in for "the hub is fine".
 * Overridable only so a test can cross it.
 */
const OUTAGE_REPORT_MS = Math.max(0, Number(process.env['CLAUDE_TOOLS_HUB_OUTAGE_REPORT_MS'] ?? 120_000));
/**
 * ISSUE-91: how often a refused watcher asks again, so Restore alone brings it back. Overridable only so a test
 * can watch the whole refused -> restored cycle, and floored at 100ms so no setting can make it a hot loop.
 */
const ARCHIVE_UNREADABLE_RETRY_MS = Math.max(100, Number(process.env['CLAUDE_TOOLS_HUB_ARCHIVE_RETRY_MS']) || 60_000);

/**
 * Slowest health probe while something other than the hub is answering `/api` (ISSUE-92).
 *
 * Lower than the five-minute ceiling for ordinary failures, because a probe carries no credential and
 * costs one small unauthenticated GET, while a watcher that notices recovery minutes late is a session
 * that stays deaf for those minutes.
 */
const NOT_HUB_MAX_PROBE_MS = 60_000;

/** How many delivered `(stream, id)` keys are remembered for the dedupe. */
const DEDUPE_MEMORY = 2_000;

/** Long enough for the last status write, short enough not to hold up a shutdown. */
const SHUTDOWN_STATUS_TIMEOUT_MS = 3_000;

/**
 * The client version, sent on every poll.
 *
 * Roadmap R13: a long-lived listener runs the code it loaded at startup and
 * nothing tells anyone it is stale. The hub is its own update channel - it
 * broadcasts a `restart` when a new version lands - and this is the backstop for
 * the case a broadcast cannot reach: a listener that started stale.
 */
function clientVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // `dist/commands/hub/` and `src/commands/hub/` are the same depth, so one
  // candidate covers both a built CLI and `npm run dev`.
  for (const candidate of [join(here, '../../../package.json'), join(here, '../../../../package.json')]) {
    try {
      const version = (JSON.parse(readFileSync(candidate, 'utf-8')) as { version?: unknown }).version;
      if (typeof version === 'string' && version.length > 0) return version;
    } catch {
      // Not there, or not readable. A missing version is not a reason to refuse to run.
    }
  }
  return 'unknown';
}

/**
 * The two names every command shares, and the rule that keeps them apart:
 *
 *  - `--agent` is the agent the command is ABOUT - the one being armed, whose
 *    status is read, whose history is wanted.
 *  - `--as` is who is CALLING, for the commands where that differs (a send is
 *    about its recipient, not about the sender).
 *
 * Either resolves from `AGENT_HUB_AGENT` or the secrets file when it is omitted,
 * which is what lets an armed session run `hub send` with no flags at all.
 */
interface CommonOptions {
  /** Who is calling. Falls back to `--agent`, then to the configured name. */
  as?: string;
  /** The agent the command is about, where that is not a positional argument. */
  agent?: string;
  url?: string;
  label?: string;
}

interface Identity {
  client: HubClient;
  machine: MachineFingerprint;
  agent: string;
  origin: string;
  version: string;
}

/**
 * Derive this machine's identity and build a client, or explain and exit.
 *
 * Every failure in the derivation is fatal on purpose. The two branches that must
 * not exist are "no usable salt, carry on anyway", which would silently downgrade
 * the machine to a guessable anchor-only fingerprint, and "regenerate the salt",
 * which would re-enrol the machine and train the owner to approve without reading.
 */
function resolveIdentity(options: CommonOptions): Identity {
  const config = loadConfig();
  // `--as` wins, then the agent the command is about, then the configured default.
  // The middle rung is what makes `hub log --agent worker` work on a machine that
  // has configured no name of its own: reading another agent's history still needs
  // an identity to authenticate with, and any valid name will do.
  // The configured default is followed through any rename; an EXPLICIT --as/--agent is not.
  // AGENT_HUB_AGENT is fixed at launch, so after a rename it names the ARCHIVED name — which is how
  // a renamed agent's sends kept arriving stamped with a name that no longer exists. An explicit
  // name is taken literally: `hub log --agent <old>` reading an archived agent's history is a real
  // use, and silently redirecting it would make the archive unreadable.
  const explicit = (options.as ?? options.agent ?? '').trim();
  const agent = explicit || followRenames((config.hub.agent ?? '').trim());
  if (!agent) {
    console.error(chalk.red('No agent name.'));
    console.log('\nThe hub identifies sessions by name, so one has to be chosen:');
    console.log('  claude-tools hub watch --agent manager');
    console.log('  AGENT_HUB_AGENT=manager claude-tools hub watch');
    console.log('  or "hub": { "agent": "manager" } in the claude-tools secrets file');
    process.exit(1);
  }

  let machine: MachineFingerprint;
  try {
    machine = machineFingerprint();
  } catch (error) {
    if (error instanceof FingerprintError) {
      console.error(chalk.red(`Cannot derive this machine's hub identity (${error.code}).`));
      console.error(error.message);
      console.log('\nThe machine key is ~/.config/ai-hub/machine.key: 32 bytes, mode 0600, owned by you.');
      console.log('It is a bearer credential, so a broken one is fixed rather than worked around.');
      process.exit(1);
    }
    throw error;
  }

  const url = options.url ?? config.hub.url;
  const version = clientVersion();
  try {
    const client = new HubClient({
      baseUrl: url,
      agent,
      fingerprint: machine.fingerprint,
      clientVersion: version,
      anchorRung: machine.anchor.rung,
      ...(options.label === undefined ? {} : { label: options.label }),
    });
    return { client, machine, agent, origin: client.origin, version };
  } catch (error) {
    if (error instanceof HubPermanentError) {
      console.error(chalk.red('Error:'), error.message);
      process.exit(1);
    }
    throw error;
  }
}

/**
 * Write to stdout and wait for it to actually leave.
 *
 * `process.stdout.write` to a pipe is **asynchronous**: it can still be queued while
 * the next synchronous statements run. For an ordinary status line that does not
 * matter, but the watcher advances its cursor immediately after printing a message -
 * so a crash in that window would move the cursor past a notification that never
 * arrived, and the dedupe would then suppress the replay. Awaiting the flush closes
 * it: the cursor only moves once the bytes are gone.
 *
 * A write error means the Monitor that was reading this is gone, so the caller treats
 * it as fatal - a watcher whose stdout is closed cannot deliver anything.
 */
function writeDelivery(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(text, (error) => (error ? reject(error) : resolve()));
  });
}

/**
 * Local wall clock, to the second, with the UTC offset spelled out.
 *
 * Both halves were earned in the ISSUE-60 validation. A probe agent read an unlabelled
 * `19:15` against its own shell's `date -u` of `14:15`, concluded the hub had given it
 * no usable time at all, and reported that as a defect before finding `ts` in `--json`.
 * Minute resolution on a tool whose whole purpose is measuring delivery was the other
 * half of the same complaint: the cheap path discarded precision the hub already had.
 */
function hhmm(ms: number): string {
  const at = new Date(ms);
  const clock = at.toLocaleTimeString('en-GB', {
    // `hourCycle: 'h23'` states the cycle outright. `hour12: false` leaves it to the locale's
    // default, which for en-GB is h24 in some ICU builds — printing midnight as `24:00:00`.
    // It resolves to h23 on this build, so this is a latent difference, not an observed bug.
    hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  // getTimezoneOffset is minutes WEST of UTC, so the sign flips to read as an offset.
  const west = at.getTimezoneOffset();
  const abs = Math.abs(west);
  const minutes = abs % 60;
  const hours = String(Math.floor(abs / 60)).padStart(2, '0');
  return `${clock}${west > 0 ? '-' : '+'}${hours}${minutes === 0 ? '' : String(minutes).padStart(2, '0')}`;
}

function fold(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ⏎ ').trim();
}

/**
 * `recover` names the command that returns the rest, because the bare marker taught an
 * agent nothing. In the ISSUE-60 validation a probe was handed an instruction cut at
 * `[+504 chars]` — over half the message, including one of its two numbered asks — and
 * recovered it only because the sender had warned it inside that same truncated line.
 * Acting on a truncated instruction is a correctness failure, not a cosmetic one.
 */
function truncate(text: string, max: number, recover: string): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}… [+${text.length - max} chars, ${recover} for the rest]`;
}

function ago(ms: number | null, now: number): string {
  if (ms === null) return 'never';
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
}

/**
 * One line per message, in the shape the Telegram watchers already use so a
 * babysit brief reads the same whichever watcher produced it.
 *
 * `to` is rendered as `me` for this agent's own inbox and `all` for a broadcast,
 * because "who else got this" changes how a message should be answered.
 */
export function formatHubMessage(
  message: HubMessage,
  me: string,
  maxText: number,
  options: { recover?: string; receivedAt?: number; dated?: boolean; now?: number } = {},
): string {
  const to = message.to === BROADCAST_TARGET ? 'all' : message.to === me ? 'me' : message.to;
  const kind = message.kind === 'msg' ? '' : ` [${message.kind}]`;
  const corr = message.corr ? ` ↩${message.corr}` : '';
  // The hub→client leg: the only latency this process can honestly claim, since it cannot see
  // how long the reader then took to notice. Both ISSUE-60 probes tried to measure delivery and
  // could only state an upper bound, because nothing recorded when a message was actually READ
  // as opposed to when it was sent.
  const lag = options.receivedAt === undefined
    ? ''
    : ` (+${((options.receivedAt - message.ts) / 1000).toFixed(1)}s)`;
  const body = truncate(fold(message.body), maxText, options.recover ?? '--json');
  // History (`hub log`) is read long after it was written, so it carries the DATE and, past an hour, the
  // age. Time alone made a two-day-old "APPLYING in ~30s" read as current (Davron, 2026-09-29). A live
  // watcher line is current by definition and keeps the short form.
  const when = options.dated ? `${ymd(message.ts)} ${hhmm(message.ts)}${historyAge(message.ts, options.now ?? Date.now())}` : hhmm(message.ts);
  return `[hub] ${when}${lag} ${message.from} → ${to}${kind}${corr}: ${body}`;
}

/** Local calendar date, `YYYY-MM-DD`, in the same zone `hhmm` prints its offset for. */
function ymd(ms: number): string {
  const at = new Date(ms);
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
}

/** ` (3h ago)`, ` (2d ago)`, or nothing under an hour: the age is what a reader actually needs. */
function historyAge(ms: number, now: number): string {
  const hours = Math.floor((now - ms) / 3_600_000);
  if (hours < 1) return '';
  return hours < 48 ? ` (${hours}h ago)` : ` (${Math.floor(hours / 24)}d ago)`;
}

function positiveInt(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(chalk.red(`--${name} must be a positive integer`));
    process.exit(1);
  }
  return n;
}

/** Everything a command that is not `watch` shares: resolve, run, report, exit. */
/**
 * Exit status of `hub send`/`hub broadcast` when the message was NOT sent because this machine already sent the
 * identical text within the hour: not 0, which a script reads as "sent", and not 1, which means it failed. A forwarder
 * doing `hub send … || alarm` used to lose every repeat of its alert silently (2026-10-07, the notifications track).
 */
export const DUPLICATE_EXIT_CODE = 3;

interface SendOptions {
  kind?: string;
  corr?: string;
  ttl?: string;
  json?: boolean;
  again?: boolean;
}

/**
 * Send, unless this exact text already went to this recipient recently; record what was confirmed.
 *
 * #406. After the outage, sessions resent messages they could not see — `hub log` shows an agent its
 * inbox, never its own sends — and each resend carried a new id, so every recipient got it twice.
 * Guidance did not stop it: a session that had diagnosed exactly this resent anyway, because "did that
 * land?" had no cheap answer. So the check is mechanical. A printed `#id` means the hub has it; an
 * identical resend within the hour is refused naming that id; `hub sent` lists what landed.
 */
async function sendOnce(
  identity: Identity,
  to: string,
  body: string,
  options: SendOptions,
  confirmed: (id: string, recipient: string) => string,
): Promise<void> {
  const { client, agent, origin } = identity;
  let ttlSeconds: number | undefined;
  if (options.ttl !== undefined) {
    const parsed = parseTtl(options.ttl);
    if (parsed === null || parsed > MAX_MESSAGE_TTL_SECONDS) {
      throw new Error(`--ttl ${JSON.stringify(options.ttl)}: use a duration like 30m, 2h or 1d, at most 7d.`);
    }
    ttlSeconds = parsed;
  }
  const key: SendKey = {
    to,
    body,
    ...(options.kind === undefined ? {} : { kind: options.kind }),
    ...(options.corr === undefined ? {} : { corr: options.corr }),
  };
  // Check, send and record under one lock, so a second session sending the same message at the same
  // moment waits, then finds this one's record instead of sending again.
  await withSendLock(agent, key, origin, async () => {
    if (!options.again) {
      const earlier = findRecentSend(agent, key, origin);
      if (earlier) {
        process.exitCode = DUPLICATE_EXIT_CODE;
        if (options.json) {
          // The same shape as a send, plus the flag: a caller reading `id` gets the confirmed id either way.
          console.log(JSON.stringify({ id: earlier.id, to: earlier.to, ts: earlier.ts, duplicate: true }));
          return;
        }
        const mins = Math.max(1, Math.round((Date.now() - earlier.at) / 60_000));
        console.log(chalk.yellow(
          `Already sent to ${to === BROADCAST_TARGET ? 'all' : to} as #${earlier.id} at ${hhmm(earlier.at)} (${mins} min ago): `
          + 'identical message, so it was NOT sent again. The hub confirmed that #id when it was sent; '
          + 'this check reads this machine\'s send record, not the hub, so a prune made elsewhere is not seen here. '
          + `If it has been removed, or to send it twice anyway, use --again (the check covers ${Math.round(RESEND_WINDOW_MS / 60_000)} min). `
          + `Exit status ${DUPLICATE_EXIT_CODE}: not sent.`,
        ));
        return;
      }
    }
    let sent;
    try {
      sent = await client.send({ ...key, ...(ttlSeconds === undefined ? {} : { ttlSeconds }) });
    } catch (error) {
      // No HTTP answer at all (a timeout, a dropped connection) is the one case where the hub may have
      // the message although we never heard back. Say so, and say how to check, instead of inviting a
      // blind resend.
      if (error instanceof HubTransientError && error.status === null && !(error instanceof HubNotHubError)) {
        throw new Error(
          `${error.message}\nThe hub may or may not have received it. Before sending again, check with `
          + `\`hub log --agent ${to === BROADCAST_TARGET ? agent : to}\`.`,
        );
      }
      throw error;
    }
    try {
      await recordSent(agent, sent, { ...key, ...(ttlSeconds === undefined ? {} : { ttlSeconds }) }, origin);
    } catch (error) {
      // The send itself succeeded; losing the local record only weakens the resend check.
      console.error(chalk.yellow(`Sent, but could not record it locally: ${(error as Error).message}`));
    }
    if (options.json) {
      console.log(JSON.stringify(sent));
      return;
    }
    console.log(chalk.green(confirmed(sent.id, sent.to)));
    // A broadcast with no TTL is read by every new session until someone prunes it. Right for a standing rule, and
    // the usual source of a stale stream otherwise: say so where the author still decides (coordinator, 2026-10-13).
    if (to === BROADCAST_TARGET && ttlSeconds === undefined) {
      console.log(chalk.dim('No --ttl: every new session reads this until it is pruned. For news rather than a standing rule, send it with --ttl (e.g. 1d).'));
    }
    // ISSUE-84: the whole point is that this reaches a human. A warning the client drops leaves the sender
    // exactly where it was: a message id, and no idea its own name is gone.
    if (sent.warning) console.log(chalk.yellow(`⚠ ${sent.warning}`));
  });
}

/**
 * A write about another agent, or about shared history, is audited under the caller's name, so the caller must be
 * named outright. The configured default is not enough: AGENT_HUB_AGENT is fixed at launch and has been seen naming
 * the wrong agent, which would put someone else's name on the audit trail (Codex review).
 */
function requireAs(options: CommonOptions, what: string): void {
  if (options.as === undefined || options.as.trim() === '') {
    console.error(chalk.red(`${what} is recorded under your name: pass --as <your agent name>.`));
    process.exit(1);
  }
}

async function runSimple(options: CommonOptions, body: (identity: Identity) => Promise<void>): Promise<void> {
  const identity = resolveIdentity(options);
  try {
    await body(identity);
  } catch (error) {
    if (error instanceof HubNotApprovedError) {
      console.error(chalk.red(`This machine is not approved for the hub yet.`));
      console.log(`\nApprove machine ${chalk.bold(identity.machine.label)} in the console: ${consoleUrl(identity.origin)}`);
      console.log('An agent with a watcher running does not need to do anything else - it keeps polling.');
      process.exit(1);
    }
    if (error instanceof HubArchiveUnreadableError) {
      console.error(chalk.red(error.detail));
      process.exit(1);
    }
    if (error instanceof HubRenamedError) {
      // ISSUE-84: the hub refused because the name we called as has moved. `Error: <detail>` would already say
      // so, but the retry is the useful half and only this branch knows the successor.
      console.error(chalk.red(`"${error.from}" is no longer your name on the hub.`));
      console.log(`It was renamed to ${chalk.bold(error.to)}. Nothing was sent.`);
      console.log(`Retry with ${chalk.bold(`--as ${error.to}`)}, or run ${chalk.bold('hub whoami')} to see what this session resolves to.`);
      process.exit(1);
    }
    console.error(chalk.red('Error:'), (error as Error).message);
    process.exit(1);
  }
}

/**
 * Whether this name was generated rather than chosen.
 *
 * The registration hook derives `<working-directory>-<4 hex>` when nothing pins a name — `otherorg-8ad9`,
 * `myrepo-e26d`, `otherorg-2d13`. Those accumulate: the roster held nine by the time anyone looked, and
 * none said what its agent was for, so a live worker was indistinguishable from an abandoned shell. A
 * derived name means the launch omitted `AGENT_HUB_AGENT`, and registration is the only moment an agent is
 * certain to be reading.
 *
 * A heuristic on purpose: a chosen name ending in four hex characters is flagged wrongly, which costs one
 * ignorable line. Missing the litter costs a roster nobody trusts.
 */
export function looksDerived(name: string): boolean {
  return /-[0-9a-f]{4}$/.test(name);
}

// ---------------------------------------------------------------------------
// rename — one command, three targets (ISSUE-82)
// ---------------------------------------------------------------------------

/**
 * One of the three things a rename has to move, and how that went.
 *
 * **Three outcomes, not one verdict.** The hub, the tmux session and the Claude session
 * name are moved by three different mechanisms and fail independently, and a reader who
 * is told only "renamed" cannot tell which of them actually landed. Only the hub is
 * fatal: it goes first, so once it has succeeded, a local failure after it makes this
 * report incomplete rather than the rename undone.
 */
export interface RenameStep {
  target: 'hub' | 'tmux' | 'claude';
  /** `done` moved it, `skipped` had nothing to move, `failed` tried and could not. */
  state: 'done' | 'skipped' | 'failed';
  detail: string;
}

/** What `renameTmuxSession` needs from `spawnSync`, so a test can hand it a stub instead. */
export type TmuxRunner = (args: readonly string[]) => {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

function spawnTmux(args: readonly string[]): ReturnType<TmuxRunner> {
  const result = spawnSync('tmux', [...args], {
    encoding: 'utf-8',
    // A wedged tmux server must not hold up a command whose important half has already
    // succeeded. Five seconds is the same bound the fingerprint's anchor probes use.
    timeout: 5_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.trim() ?? '';
}

/**
 * Rename the tmux session this process is running in.
 *
 * **The session is resolved from `TMUX_PANE` in this process's own environment**, never
 * from a pane list: `tmux list-panes` answers for whatever the server considers current,
 * which on a machine running several sessions is a guess, and renaming the wrong session
 * is not a mistake its agent would ever see. A pane id resolves to its session, so
 * `-t <pane>` needs no lookup at all.
 *
 * **Not being in tmux is the common case, not an error.** A `--bg` session has no pane,
 * so an unset `TMUX_PANE` is reported as skipped and nothing is spawned.
 */
export function renameTmuxSession(
  to: string,
  env: NodeJS.ProcessEnv = process.env,
  run: TmuxRunner = spawnTmux,
): RenameStep {
  const pane = (env['TMUX_PANE'] ?? '').trim();
  if (pane === '') {
    return { target: 'tmux', state: 'skipped', detail: 'not inside tmux (TMUX_PANE is unset) — no session to rename' };
  }

  // Best effort, and only so the report can name what changed: the rename below targets
  // the pane either way, so a tmux that cannot answer this is no reason to skip the thing
  // that was actually asked for.
  const before = run(['display-message', '-p', '-t', pane, '#{session_name}']);
  const was = before.status === 0 ? before.stdout.trim() : '';

  const renamed = run(['rename-session', '-t', pane, to]);
  const fix = `\`tmux rename-session -t ${pane} ${to}\` is the whole fix`;
  if (renamed.error !== undefined) {
    // No tmux on PATH, or it could not be spawned at all - which is possible even with
    // TMUX_PANE set, in a container that inherited the environment but not the binary.
    return { target: 'tmux', state: 'failed', detail: `cannot run tmux (${renamed.error.message}); ${fix}` };
  }
  if (renamed.status !== 0) {
    return {
      target: 'tmux',
      state: 'failed',
      detail: `tmux refused it: ${firstLine(renamed.stderr) || `exit ${renamed.status ?? 'signal'}`}; ${fix}`,
    };
  }
  return {
    target: 'tmux',
    state: 'done',
    detail: was === '' ? `session renamed to "${to}"` : `session "${was}" → "${to}"`,
  };
}

/**
 * The Claude session name: the one target a CLI cannot reach, and must not pretend to.
 *
 * `/rename` is a slash command, which is *user input* typed into the session's own input
 * box. No child process can invoke it, and typing into a pane is prohibited outright -
 * the `agent-hub` skill's Messaging section records why: it fights whoever is already
 * typing there, and one evening it came a keystroke away from submitting a half-written
 * line of the owner's as though an agent had written it.
 *
 * So this step is always `skipped`, never attempted and never reported as done. Printing
 * the exact line for the agent to run is the whole of what is possible here.
 */
export function claudeRenameStep(to: string): RenameStep {
  return {
    target: 'claude',
    state: 'skipped',
    detail: `run \`/rename ${to}\` yourself — a slash command is user input, which no CLI can send`,
  };
}

const RENAME_MARK: Record<RenameStep['state'], string> = { done: '✅', skipped: '⏭', failed: '⚠️' };

/**
 * The per-target report, and the two things the agent still has to do itself.
 *
 * The watch is the reason this ends in instructions rather than a tick. After the rename
 * the old name answers a poll with a redirect (ISSUE-82a), so the watch that is running is
 * already finished - and a watch is a channel or Monitor call the agent makes, which no
 * child process can make for it. Saying so is the difference between a rename and a
 * session that has quietly gone deaf under both names.
 */
export function formatRenameReport(
  from: string,
  to: string,
  steps: readonly RenameStep[],
  watchCommand: string,
): string {
  const width = Math.max(...steps.map((step) => step.target.length));
  const lines = steps.map((step) => `${step.target.padEnd(width)}  ${RENAME_MARK[step.state]} ${step.detail}`);
  lines.push(
    '',
    `Your watch is finished: the next poll on "${from}" fails with a redirect naming "${to}".`,
    'Stop it (watch_stop, or drop the Monitor) and arm one for the new name:',
    `  ${watchCommand}`,
    `It starts a fresh cursor, so read whatever arrived in between with \`hub log --agent ${to}\`.`,
  );
  if (looksDerived(from)) {
    // Closing the loop the registration warning opened: it tells an agent its name was
    // generated, and this is the only moment the fix for the NEXT session is in view.
    lines.push(
      `"${from}" was a derived name: pass AGENT_HUB_AGENT=${to} at launch, or the next session is named that way again.`,
    );
  }
  return lines.join('\n');
}

/**
 * The exact command that arms a watch for the new name.
 *
 * Resolved to this CLI's own entry point because `claude-tools` is usually not on an
 * agent's PATH - the skill has sessions invoke `node <root>/dist/cli.js` - and an
 * instruction that does not run as printed is worse than none.
 */
function watchCommand(agent: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // `dist/commands/hub/` → `dist/cli.js`. Under `npm run dev` there is no built entry to
  // point at, so the package's bin name is the honest fallback.
  const built = join(here, '../../cli.js');
  const entry = existsSync(built) ? `node ${built}` : 'claude-tools';
  return `${entry} hub watch --agent ${agent} --label "$PWD"`;
}

export function registerHubCommands(program: Command): void {
  const hub = program
    .command('hub')
    .description('Inter-agent messaging, presence and history through the agent hub')
    // Said once, here, because the two names are the only thing about this command
    // group that is not obvious: `--agent` is the agent a command is about, `--as`
    // is who is calling when that differs. Both default to AGENT_HUB_AGENT or the
    // `hub.agent` entry in the secrets file.
    .addHelpText('after', [
      '',
      'Naming:',
      '  --agent <name>   the agent the command is about (armed, read, asked)',
      '  --as <name>      who is calling, when that differs from --agent',
      '',
      'Arming a watcher is the registration: there is no register command and no code to paste.',
      'A machine the hub has never seen is refused until the owner approves it in the console;',
      '`hub watch` says so and keeps polling.',
    ].join('\n'));

  // -------------------------------------------------------------------------
  // watch
  // -------------------------------------------------------------------------
  hub
    .command('watch')
    .description('Long-poll the hub and print one line per message (for the Claude Code Monitor tool)')
    .option('--agent <name>', 'This session\'s agent name on the hub')
    .option('--as <name>', 'Alias for --agent; every subcommand accepts both spellings')
    .option('--url <url>', 'Hub URL; the origin or its /api form')
    .option('--label <text>', 'A human label for this session, shown in the console roster')
    .option('--state <name>', 'Cursor namespace; defaults to the agent name')
    .option('--timeout <sec>', 'How long one poll may wait on the server', String(SERVER_HOLD_MS / 1000))
    .option('--max-text <n>', 'Truncate a message body to this many characters', '2000')
    .option('--reset', 'Discard the stored cursor and start from now')
    .option('--once', 'Run a single poll and exit (for scripts and checks)')
    .option('--json', 'Print each MESSAGE as a JSON object; status lines stay plain "[hub] …" text')
    .option('--exit-on-restart', 'Exit 0 on a hub restart broadcast, for a supervisor that re-arms the watcher')
    .action(async (options: {
      agent?: string; as?: string; url?: string; label?: string; state?: string; timeout: string; maxText: string;
      reset?: boolean; once?: boolean; json?: boolean; exitOnRestart?: boolean;
    }) => {
      const identity = resolveIdentity(options);
      const { client, machine, agent } = identity;
      const state = options.state ?? agent;
      const maxText = positiveInt(options.maxText, 'max-text');

      // Clamped, not refused: the server clamps the wait it is given, but the
      // CLIENT's abort has to stay the longest deadline in the ladder (R7), and a
      // wait longer than the hold could not be honoured anyway.
      const requested = positiveInt(options.timeout, 'timeout') * 1000;
      const waitMs = Math.min(requested, SERVER_HOLD_MS);
      if (requested > SERVER_HOLD_MS) {
        process.stderr.write(`[hub] --timeout clamped to ${SERVER_HOLD_MS / 1000}s: the server's hold is the ceiling\n`);
      }

      // #406: ONE watcher per agent on this machine, and ownership comes FIRST — before the cursor and
      // the dedupe history are read. A predecessor may deliver and save one more batch while it hands
      // over, and a successor that had already read the older cursor would print that batch again.
      // `--once` is a check, not a watcher: it takes no ownership and displaces nobody.
      let handOverRequested = false;
      let delivering = false;
      let leaveForSuccessor = (): void => {
        handOverRequested = true;
      };
      // Voice transcripts still being made in the background (hub-telegram.ts). The successor will not see those
      // messages again, and it gives the predecessor only seconds to let go, so a handover cannot wait for them:
      // it names each one, loudly, with its file id, instead of dropping it silently (Codex review).
      const pendingTranscripts = new Map<Promise<unknown>, string>();
      // Listen presses on messages this agent sent into a forum topic: the hub hands them here, and this watcher
      // speaks them as `bot watch` does in a direct chat. One job at a time, through the hub (which holds the token
      // and lets this agent post only into its own topic); synthesis runs on this machine, from its own stash.
      const speech = new SpeechQueue(5, (message) => process.stderr.write(`[hub] speech job failed: ${message}\n`));
      const listenServices = new Map<string, TelegramBotService>();
      const listenService = (bot: string): TelegramBotService => {
        let service = listenServices.get(bot);
        if (service === undefined) {
          // Every call checks the quarantine at the moment it is made: a synthesis that finishes after something
          // other than the hub started answering /api must not post to it with this machine's fingerprint.
          const guard = (): void => {
            if (quarantined) throw new Error('not sent: something other than the hub is answering /api');
          };
          // A speech call can be the first request to meet a foreign /api. Callers swallow failures (a callback
          // answer, a button removal), so the transport itself quarantines, before any later call can carry the
          // fingerprint or audio there. A successful poll lifts it (Codex review).
          const noticing = async <T>(call: Promise<T>): Promise<T> => {
            try {
              return await call;
            } catch (error) {
              if (error instanceof HubNotHubError) {
                setQuarantined(true);
                quarantineEpoch += 1;
              }
              throw error;
            }
          };
          service = new TelegramBotService(
            '',
            async (method, body) => { guard(); return noticing(client.botCall(bot, method, body)); },
            async (params, audio) => {
              guard();
              // Released: this press's button is back, so a late voice note would be heard twice (hub-listen.ts).
              if (listen.closed) throw new Error('not sent: the watcher is leaving and the button was put back');
              const upload = noticing(client.botVoice(bot, params, audio));
              // Registered under its press, so a release now waits for its outcome instead of restoring over it.
              listen.uploading(bot, String(params['chat_id']), Number(params['reply_to_message_id']), upload);
              return upload;
            },
          );
          listenServices.set(bot, service);
        }
        return service;
      };
      // Presses taken but not finished with. The cursor is already past them and their buttons are gone, so the
      // ledger is their only record; see hub-listen.ts for the rule and the four ways an entry may leave it.
      const listen = new ListenLedger({
        accept: (press, onSettled, track) => acceptListenPress(listenService(press.bot), speech, press.bot, press.bot, press, onSettled, track),
        answerRepeat: (press) => listenService(press.bot).answerCallback(press.queryId, 'Already reading it aloud…'),
        restoreButton: (press) => listenService(press.bot).setButtons(press.chatId, press.messageId, listenButtonFor(press)),
        canReachHub: () => !quarantined,
        report: (line) => writeDelivery(`[hub] ${hhmm(Date.now())} ${line}\n`).catch(() => undefined),
      });
      const releaseLines = (lines: readonly string[]): string => lines.map((line) => `[hub] ${hhmm(Date.now())} ${line}\n`).join('');
      /**
       * Called when the watch loop ends. With nothing Listen started still outstanding this does nothing, so every
       * existing exit behaves as before. Otherwise it releases the presses (buttons back), waits up to 2 s for those
       * restores and any unawaited replies, names the presses, and exits: a queued synthesis or a request in its retry
       * window would otherwise keep this watcher alive long after it was meant to be gone.
       */
      const abandonPendingSpeech = async (why: string): Promise<void> => {
        if (!listen.busy) return;
        const speechLeft = listen.release(why);
        // `restored` covers the restores and then every reply still in flight (hub-listen.ts).
        await Promise.race([speechLeft.restored, sleep(2_000)]);
        await writeDelivery(releaseLines(speechLeft.lines)).catch(() => undefined);
        process.exit(process.exitCode ?? 0);
      };
      if (!options.once) {
        const watchIdentity = { origin: identity.origin, agent, state };
        try {
          const ownership = await acquireWatchOwnership(watchIdentity, () => {
            handOverRequested = true;
            if (!delivering) leaveForSuccessor();
          });
          if (!ownership.supported) {
            process.stderr.write('[hub] this platform has no kernel-held lock; one watcher per agent is not enforced here\n');
          }
          if (ownership.tookOver) {
            process.stdout.write(
              `[hub] took over from an earlier watcher for "${agent}". Only one watcher per agent delivers, `
              + 'so nothing arrives twice.\n',
            );
          }
          // Looked for later rather than now: a watcher starting at the same moment as this one is a
          // contender that the lock sorts out within seconds, not a leftover. What is still there after
          // that holds no lock at all, which only a watcher from before this change does. Reported as a
          // possibility, never with an instruction to kill: this process cannot see whose session it serves.
          setTimeout(() => {
            const unlocked = findUnlockedWatchers(watchIdentity);
            if (unlocked.length > 0 && !stopping) {
              process.stdout.write(
                `[hub] another \`hub watch\` for "${agent}" is running without the one-watcher lock (pid `
                + `${unlocked.join(', ')}), probably an older client version. If it serves this same agent, every `
                + 'message arrives twice until that watch is stopped in its own session.\n',
              );
            }
          }, 15_000).unref();
        } catch (error) {
          process.stdout.write(`[hub] ERROR ${(error as Error).message}. Not starting a second watcher.\n`);
          process.exitCode = 1;
          return;
        }
      }

      let stored: HubWatchState;
      let hubChanged = false;
      try {
        // The origin is part of the question: a cursor is a position in one hub's
        // streams, so resuming against a different one would skip whatever sits
        // before that position on the new server.
        const loaded = loadHubState(state, agent, identity.origin);
        stored = loaded.state;
        hubChanged = stored.origin !== null && stored.origin !== identity.origin;
        if (loaded.repaired) process.stderr.write(`[hub] ${loaded.repaired}\n`);
      } catch (error) {
        // A cursor belonging to another agent. Nothing to do but say which.
        process.stdout.write(`[hub] ERROR ${(error as Error).message}\n`);
        process.exitCode = 1;
        return;
      }

      if (options.reset) {
        stored = { ...stored, cursor: null };
        process.stdout.write('[hub] reset; starting from now\n');
      }

      if (stored.approvedAt !== null && (hubChanged || (stored.machine !== null && stored.machine !== machine.label))) {
        // Approval is per machine AND per hub. Carrying it across either would make a
        // brand-new pending machine report itself as "most likely revoked", which sends
        // the owner looking for a revocation that never happened.
        process.stderr.write(
          `[hub] this state was approved as ${stored.machine ?? 'another machine'} on ${stored.origin ?? 'another hub'}; ` +
          'treating this machine as new\n'
        );
        stored = { ...stored, approvedAt: null };
      }

      // Seeded from the log because delivery is at-least-once: a watcher that dies
      // between printing a batch and saving its cursor is handed the same batch
      // again, and printing it twice would cost its agent a second notification for
      // a message it has already answered. The window that matters is one batch, so
      // the 2000-key bound is slack rather than a target.
      //
      // **Scoped to this hub's records**, because a stream id is only unique within one
      // server: an id from a hub this state once pointed at must never be able to
      // suppress a new message here, and that has to be decided per record rather than
      // per run - the next start would otherwise read the foreign records straight back
      // in. `--reset` skips the seed entirely: the operator asked to start from now.
      const history = options.reset ? [] : readHubLog(state, DEDUPE_MEMORY, { origin: identity.origin });
      const seen = new Set<string>(history.map(messageKey));
      const order: string[] = [...seen];
      const remember = (key: string): void => {
        seen.add(key);
        order.push(key);
        while (order.length > DEDUPE_MEMORY) {
          const dropped = order.shift();
          if (dropped !== undefined) seen.delete(dropped);
        }
      };

      process.stdout.write(
        `[hub] ${agent} watching ${identity.origin} — machine ${machine.label} (${machine.anchor.rung}), client ${identity.version}\n`
      );

      // The last act of a clean exit: a final heartbeat and a status that says the
      // session quit rather than died. No timestamp alone can tell those apart, and
      // the roster's whole job is to answer that question.
      let stopping = false;
      // ISSUE-92: set while something other than the hub is answering /api. Nothing that carries the
      // fingerprint may be sent then, and that includes the courtesy status write on the way out
      // (Codex review, round 1: a `watch_stop` during the wait would otherwise send it to that app).
      let quarantined = false;
      // Bumped each time a speech call quarantines. Only a poll that STARTED after the bump may lift it: a long poll
      // already held by the real hub when the foreign answer arrived proves nothing about the route now (Codex review).
      let quarantineEpoch = 0;
      /** The epoch the current poll started in. */
      let pollEpoch = 0;
      /**
       * The one way quarantine changes. The client's credential hold follows it, so while it is set NO request that
       * carries the fingerprint leaves this process, whichever code path makes it (Codex review).
       */
      const setQuarantined = (held: boolean): void => {
        quarantined = held;
        client.holdCredential(held);
      };
      const shutdown = (signal: NodeJS.Signals): void => {
        if (stopping) return;
        stopping = true;
        process.stderr.write(`[hub] ${signal}: stopping\n`);
        if (quarantined) {
          process.stderr.write('[hub] not the hub answering /api; leaving without the status write\n');
          // Nothing carrying the fingerprint may go to /api now, so a pending press cannot get its button back here;
          // it is named to the agent instead of vanishing.
          // `canReachHub` is false here, so release() only names the presses.
          const speechLeft = listen.release(`the watcher stopped (${signal})`);
          if (speechLeft.lines.length === 0 && !listen.busy) process.exit(0);
          // Replies already in flight are waited for like on every other exit path, inside the same 1 s deadline;
          // nothing new is sent (Codex review).
          setTimeout(() => process.exit(0), 1_000).unref();
          const written = new Promise<void>((resolve) => {
            if (speechLeft.lines.length === 0) resolve();
            else process.stdout.write(releaseLines(speechLeft.lines), () => resolve());
          });
          void Promise.allSettled([written, speechLeft.restored]).then(() => process.exit(0));
          return;
        }
        const speechLeft = listen.release(`the watcher stopped (${signal})`);
        if (speechLeft.lines.length > 0) process.stdout.write(releaseLines(speechLeft.lines));
        Promise.allSettled([
          client.setStatus('stopped (clean)'),
          // Best effort, inside the same deadline: a button left off is reported in the line above.
          speechLeft.restored,
        ]).finally(() => process.exit(0));
        // Belt: if the write hangs past the socket timeout, leave anyway.
        setTimeout(() => process.exit(0), SHUTDOWN_STATUS_TIMEOUT_MS).unref();
      };
      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);

      // Handed over to a newer watcher: exit 0 and write no status, because the successor is the one
      // alive now and a "stopped (clean)" landing after its first poll would tell the roster the opposite.
      // Exit 0 also keeps a restarting supervisor from bringing this one back.
      let leaving = false;
      leaveForSuccessor = () => {
        if (leaving) return;
        leaving = true;
        stopping = true;
        const done = () => process.exit(0);
        const finish = () => {
          process.stdout.write('[hub] a newer watcher for this agent took over; this one is finished.\n', done);
          setTimeout(done, 1_000).unref();
        };
        const speechLeft = listen.release('a newer watcher took over first');
        if (pendingTranscripts.size === 0 && speechLeft.lines.length === 0) {
          if (!listen.busy) {
            finish();
            return;
          }
          // No press to name, but Listen replies are still in flight: wait for them, inside the same 1 s deadline.
          setTimeout(done, 1_000).unref();
          void speechLeft.restored.finally(finish);
          return;
        }
        const interrupted = [...pendingTranscripts.values()]
          .map((what) => `[hub] ${hhmm(Date.now())} voice ${what}: transcription interrupted by a watcher handover; the text will not follow here. Download it with bot file and transcribe it.\n`)
          .join('') + releaseLines(speechLeft.lines);
        // The exit deadline is armed before the write, so a backpressured pipe cannot hold the lock past the
        // successor's takeover timeout (Codex review).
        setTimeout(done, 1_000).unref();
        // The button restores must reach the hub before the exit, or the message stays buttonless with nobody to
        // retry it; the 1 s deadline above still bounds the whole handover (Codex review).
        process.stdout.write(interrupted, () => { void speechLeft.restored.finally(finish); });
      };
      if (handOverRequested) leaveForSuccessor();

      let failures = 0;
      // ISSUE-92: health probes in a row that found something other than the hub. Reset only by a poll
      // that succeeds, so a hub whose health is fine but whose API this client cannot read keeps backing
      // off instead of alternating probe, request, probe every second.
      let notHubProbes = 0;
      let errorReported = false;
      // When the current outage began; null while polls succeed. Its lines wait for OUTAGE_REPORT_MS.
      let outageSince: number | null = null;
      const outageIsLong = (): boolean => outageSince !== null && Date.now() - outageSince >= OUTAGE_REPORT_MS;
      // ISSUE-91: set while the hub is refusing this name over an unreadable archive marker.
      let archiveUnreadableReported = false;
      let logErrorReported = false;
      let stateErrorReported = false;
      let pendingSince: number | null = null;
      let pendingRemindedAt = 0;

      /**
       * Advance the stored cursor.
       *
       * Guarded, because a failure here used to escape the loop's own error handling
       * and kill the watcher: a read-only home directory or a full disk would stop
       * message delivery, which is the one thing this process exists to do. The
       * in-memory cursor moves either way, so nothing is re-printed; the cost of a
       * failed write is a replay after a restart, which the dedupe absorbs.
       */
      const persist = (next: Partial<HubStateUpdate>): void => {
        stored = { ...stored, ...next, agent, origin: identity.origin };
        try {
          saveHubState(state, { ...stored, agent, origin: identity.origin });
          stateErrorReported = false;
        } catch (error) {
          if (!stateErrorReported) {
            process.stdout.write(
              `[hub] ERROR cannot save the cursor: ${(error as Error).message}\n` +
              '[hub] still watching, but a restart would resume from the last position that DID save — ' +
              'and from now if none ever did, which would skip whatever arrived meanwhile. Fix the disk.\n'
            );
            stateErrorReported = true;
          }
        }
      };

      try {
        for (;;) {
          let batch;
          try {
            // **A fresh watcher baselines with a zero-wait poll first.** With `$` the
            // server resolves the tail BEFORE it starts waiting, so if a 25-second hold
            // returned a message and its response were lost to a socket error, the retry
            // would send `$` again and start after that message. A non-blocking poll
            // costs one round trip, returns a concrete cursor, and shrinks that window
            // from the whole hold to a single request.
            //
            // The residual cannot be closed from this side, and is written down rather
            // than implied: if the baseline response itself is lost, the retry tails
            // again, so a message sent in that gap reaches the hub's history but not this
            // watcher's stdout. Closing it would need a server-side idempotent
            // "establish my position" call, which this contract does not have. It applies
            // only to a watcher with no stored cursor - never to a restart.
            const bootstrapping = stored.cursor === null;
            // A speech call met something other than the hub: the poll carries the fingerprint, so it waits for the
            // credential-free probe loop below to verify the hub first, exactly as after a foreign poll answer
            // (Codex review).
            if (quarantined) {
              throw new HubNotHubError('/api/messages', null, 'a Listen call met something other than the hub; verifying /api/health before polling again');
            }
            pollEpoch = quarantineEpoch;
            batch = await client.poll({
              after: stored.cursor ?? CURSOR_TAIL,
              waitMs: bootstrapping ? 0 : waitMs,
              timeoutMs: CLIENT_ABORT_MS,
            });
            if (errorReported) {
              const minutes = outageSince === null ? 0 : Math.round((Date.now() - outageSince) / 60_000);
              process.stdout.write(`[hub] recovered${minutes > 0 ? ` after ${minutes} min` : ''}\n`);
              errorReported = false;
            }
            outageSince = null;
            if (pendingSince !== null) {
              process.stdout.write(`[hub] approved; machine ${machine.label} is on the bus\n`);
              pendingSince = null;
            } else if (stored.approvedAt === null) {
              // The first poll of a first run. Worth one line, because "registration
              // happened and there is nothing else to do" is not otherwise visible.
              process.stdout.write(`[hub] connected as "${agent}"; this poll is the registration\n`);
              if (looksDerived(agent)) {
                // Said once, at the only moment an agent is certain to read it.
                process.stdout.write(
                  `[hub] "${agent}" is a DERIVED name — whoever launched this session omitted `
                  + `AGENT_HUB_AGENT, so the roster cannot say what you are. Set a status line now `
                  + `(\`hub status "<what you work on>"\`) so the roster stays readable, and tell `
                  + `whoever launched you to pass AGENT_HUB_AGENT=<name> next time.\n`,
                );
              }
            }
            failures = 0;
            notHubProbes = 0;
            // A poll that started after the latest quarantine and succeeded proves the hub itself is answering, so
            // that quarantine is over. An older poll that happens to finish now proves nothing.
            if (pollEpoch === quarantineEpoch) {
              setQuarantined(false);
              // The hub just answered, so a button restore that failed earlier gets another try. Only now: a stale
              // poll proves nothing, and a restore refused by the guard must not count as a failed attempt.
              listen.hubVerified();
            } else {
              // A newer foreign answer arrived while this poll was held: its batch is not processed (rendering it
              // would download files and echo transcripts) and the cursor does not move, so it comes back once the
              // probe loop at the top of the next turn has verified the hub (Codex review).
              continue;
            }
          } catch (error) {
            if (error instanceof HubRenamedError) {
              // ISSUE-82. This name will never answer again, so retrying is the one thing not to do — before this
              // branch a renamed watcher backed off and polled a dead name for the life of the session, which was
              // the last of four symptoms of AGENT_HUB_AGENT being fixed at launch. One line naming the successor,
              // one saying what to run, then a clean return: the watch ended for a known reason, not a failure.
              process.stdout.write(`[hub] "${error.from || identity.agent}" was renamed to "${error.to}". This watch is finished.\n`);
              process.stdout.write(`[hub] Start one for the new name: ${watchCommand(error.to)}\n`);
              process.stdout.write(`[hub] It begins from a fresh cursor, so read the gap with: hub log --agent ${error.to}\n`);
              return;
            }
            if (error instanceof HubNotApprovedError) {
              // ISSUE-23. The server's refusal is byte-identical for pending, revoked,
              // unknown and rate-limited, so which of those it is can only be
              // answered from what this client already knows: a machine that was
              // approved and now is not was revoked.
              const revoked = stored.approvedAt !== null;
              const first = pendingSince === null;
              pendingSince ??= Date.now();

              if (first || Date.now() - pendingRemindedAt >= PENDING_REMINDER_MS) {
                pendingRemindedAt = Date.now();
                if (revoked) {
                  process.stdout.write(
                    `[hub] ERROR the hub no longer accepts this machine. It was approved until ${hhmm(stored.approvedAt as number)}, ` +
                    `so machine ${machine.label} has most likely been revoked.\n` +
                    `[hub] Tell your user: re-approve machine ${machine.label} at ${consoleUrl(identity.origin)} if that was not deliberate. ` +
                    'This watcher keeps polling and needs no restart.\n'
                  );
                } else {
                  process.stdout.write(
                    `[hub] PENDING APPROVAL — this machine is not on the hub yet, so no messages can arrive.\n` +
                    `[hub] Tell your user: open ${consoleUrl(identity.origin)} and approve machine ${machine.label}. ` +
                    'Nothing has to be pasted anywhere; this watcher keeps polling and picks it up within 15s.\n'
                  );
                }
              } else {
                process.stderr.write(`[hub] still ${revoked ? 'revoked' : 'pending'} after ${formatDelay(Date.now() - pendingSince)}\n`);
              }

              if (options.once) {
                process.exitCode = 1;
                return;
              }
              // Deliberately NOT a backoff: the pending queue entry refreshes while
              // the machine keeps polling, so slowing down is how a genuine
              // enrolment ages out of a queue an attacker is filling.
              await sleep(error.pollAfterMs);
              continue;
            }

            if (error instanceof HubCursorError) {
              // Loud, and on stdout. Re-baselining skips whatever arrived between the
              // stored position and now; the history is still on the hub, so the one
              // useful thing to say is where to find it.
              process.stdout.write(
                `[hub] ERROR ${(error as Error).message}. Starting from now instead — anything missed is still readable ` +
                `with \`claude-tools hub log --agent ${agent}\`.\n`
              );
              persist({ cursor: null });
              if (options.once) {
                process.exitCode = 1;
                return;
              }
              continue;
            }

            if (error instanceof HubArchiveUnreadableError) {
              // ISSUE-91. Loud ONCE, then quiet: every line this prints wakes the agent, so repeating it each minute
              // would flood the one channel the owner uses to reach it. The watcher keeps polling rather than
              // exiting, so the single action the owner chose — clicking Restore — is enough on its own; a
              // watcher that had exited would also need re-arming, which nobody would think to do.
              if (!archiveUnreadableReported) {
                process.stdout.write(`[hub] ERROR ${error.detail} Polling every minute until then.\n`);
                archiveUnreadableReported = true;
              }
              if (options.once) {
                process.exitCode = 1;
                return;
              }
              await sleep(ARCHIVE_UNREADABLE_RETRY_MS);
              continue;
            }

            if (error instanceof HubPermanentError) {
              // A wrong name, a URL that is not the hub, basic auth in front of the
              // API, a redirect that would forward the credential. None of those get
              // better by waiting.
              process.stdout.write(`[hub] ERROR ${(error as Error).message}\n`);
              // `exitCode` and a return, never `process.exit`: exiting can truncate a
              // pipe that has not drained, and the line above is the only explanation
              // the agent gets.
              process.exitCode = 1;
              return;
            }

            if (error instanceof HubNotHubError) {
              // Reported once, immediately. Unlike an ordinary blip it is not going to clear on the next
              // try, and it is the line that tells a reader the URL is fine and a route is not.
              if (options.once) {
                process.stdout.write(`[hub] ERROR ${error.message}\n`);
                process.exitCode = 1;
                return;
              }
              outageSince ??= Date.now();
              const notHubMessage = error.message;
              const reportIfLong = (): void => {
                if (errorReported || !outageIsLong()) return;
                process.stdout.write(`[hub] ERROR ${notHubMessage} Still retrying.\n`);
                errorReported = true;
              };
              reportIfLong();
              // Probe, never poll, until the hub itself answers: the poll carries the fingerprint, and
              // whatever is answering in its place has no business receiving it. Exponential, with
              // jitter, so a fleet that failed together does not probe in lockstep.
              setQuarantined(true);
              quarantineEpoch += 1;
              // A Retry-After on the answer that started this is honoured on the first wait.
              let floorMs = error.retryAfterMs ?? 0;
              for (;;) {
                notHubProbes++;
                const delayMs = Math.max(backoffDelay(notHubProbes, Math.random, NOT_HUB_MAX_PROBE_MS), floorMs);
                floorMs = 0;
                process.stderr.write(`[hub] not the hub answering; probing /api/health in ${formatDelay(delayMs)}\n`);
                await sleep(delayMs);
                if (stopping) return;
                // Like a poll, a probe may lift only the quarantine that was current when it started: a speech call can
                // quarantine again while it is in flight (Codex review).
                const probeEpoch = quarantineEpoch;
                const probe = await client.probeHub();
                if (stopping) return;
                if (probe.hub && probeEpoch !== quarantineEpoch) {
                  process.stderr.write('[hub] /api/health answered as the hub, but a newer foreign answer arrived meanwhile; probing again\n');
                  continue;
                }
                if (probe.hub) {
                  process.stderr.write(`[hub] /api/health answers as the hub (${probe.detail}); resuming\n`);
                  setQuarantined(false);
                  listen.hubVerified();
                  break;
                }
                process.stderr.write(`[hub] /api/health is still not the hub: ${probe.detail}\n`);
                reportIfLong();
                floorMs = probe.retryAfterMs ?? 0;
              }
              continue;
            }

            failures++;
            outageSince ??= Date.now();
            const message = (error as Error).message;
            process.stderr.write(`[hub] poll failed (${failures}): ${message}\n`);
            if (failures >= FAILURES_BEFORE_ERROR && outageIsLong() && !errorReported) {
              process.stdout.write(`[hub] ERROR ${message} (retrying)\n`);
              errorReported = true;
            }
            // Stay alive. The owner's link drops for up to fifteen minutes at a
            // time, and a watcher that exits during one looks alive in the process
            // list while missing every message that arrives after it died.
            if (options.once) {
              // A single-poll invocation is a check, and a check that silently retried
              // for ever would hang whatever script is waiting on it.
              process.stdout.write(`[hub] ERROR ${message}\n`);
              process.exitCode = 1;
              return;
            }
            // Retry-After, when the answer carried one, is a floor under the backoff: retrying sooner than
            // asked only earns another 429 (Codex review, round 2: it was parsed and never used).
            const retryAfterMs = error instanceof HubTransientError ? error.retryAfterMs ?? 0 : 0;
            const delayMs = Math.max(backoffDelay(failures), retryAfterMs);
            if (failures === FAILURES_BEFORE_ERROR) {
              process.stderr.write(`[hub] backing off, next attempt in ${formatDelay(delayMs)}\n`);
            }
            await sleep(delayMs);
            continue;
          }

          // A handover asked for while this poll was in flight: leave BEFORE printing anything. The cursor
          // has not moved, so the successor receives this batch instead — once. Starting to print here would
          // race the exit that the handover has already scheduled (Codex review).
          if (handOverRequested || stopping) {
            if (handOverRequested) leaveForSuccessor();
            return;
          }
          if (archiveUnreadableReported) {
            process.stdout.write(`[hub] "${agent}" was restored and is back on the hub.\n`);
            archiveUnreadableReported = false;
          }

          const fresh = batch.messages.filter((message) => !seen.has(messageKey(message)));
          // From the first printed line to the saved cursor, a handover waits: leaving in between would make
          // the successor print this batch again.
          delivering = true;
          try {

          // **Printed first, recorded second, cursor last** — and the order is the
          // opposite of the Telegram watcher's on purpose.
          //
          // There, the local log is the ONLY copy: Telegram forgets an update the moment
          // the offset passes it, so the loop must refuse to confirm a batch it could not
          // write down. Here the hub retains the same history (`hub log --agent <name>`),
          // so the local file is a mirror, and stdout is what actually delivers a message
          // to the agent.
          //
          // Writing the log first bought nothing and cost two real failures: a crash
          // between the fsync and the print left a record that the restarted watcher
          // deduped against, suppressing a message the agent never saw; and a log failure
          // on a FRESH watcher re-polled from `$`, which silently re-baselined past the
          // batch it had just refused to record. Printing first makes the worst case a
          // duplicate line, which the dedupe usually absorbs anyway, rather than a lost
          // one.
          if (fresh.length > 0) {
            // A Telegram message the hub delivered is JSON; the line says who wrote what, and a voice note is
            // transcribed, so the agent can actually answer it (hub-telegram.ts). The JSON stays in `hub log --json`.
            // Voice files come through the hub (the cluster's network path), and a transcript slower than the
            // deadline is printed as its own line when it arrives instead of holding every later message.
            // Late lines wait until this batch has printed, so a transcript never arrives before its context.
            let batchPrinted = false;
            const lateLines: string[] = [];
            // A broadcast this agent sent comes back on the shared stream. It is recorded and confirmed like any
            // other message, but not printed: the sender wrote it, so the line would wake it for nothing.
            const visible = fresh.filter((message) => !(message.from === agent && message.to === BROADCAST_TARGET));
            // A Listen press is answered below, not printed: like a successful press in `bot watch`, it needs no agent.
            const presses = visible.map(listenPressOf).filter((press) => press !== null);
            // `--once` is a check that exits at once, so it cannot finish a press: it prints it instead of dropping it.
            const printable = options.once ? visible : visible.filter((message) => listenPressOf(message) === null);
            const shown = options.json ? printable : await renderTgMessages(
              printable,
              (event) => {
                const work = transcribeTgVoice(event, (bot, fileId) => client.botFile(bot, fileId));
                // Echo the transcript back under the voice note, as the old `bot watch` did: the owner speaks to
                // the fleet by voice and otherwise never sees how he was heard, so a mis-transcription surfaces only
                // as a track acting on the wrong instruction. Silent, plain, not a reply (a reply pings), into the
                // same chat and topic, through the hub (which lets this agent post only there).
                void work.then(async (result) => {
                  if (!result.text?.trim() || event.bot === undefined || event.chat?.id === undefined) return;
                  try {
                    await client.botCall(event.bot, 'sendMessage', {
                      chat_id: event.chat.id,
                      text: `🎙 ${result.text.trim()}`,
                      disable_notification: true,
                      link_preview_options: { is_disabled: true },
                      ...(event.threadId !== undefined ? { message_thread_id: event.threadId } : {}),
                    });
                  } catch (error) {
                    // A courtesy echo must never cost the message, but a silent failure would look like a working one.
                    void writeDelivery(`[hub] ${hhmm(Date.now())} could not echo the transcript of msg ${event.messageId ?? '?'} back to Telegram: ${(error as Error).message.slice(0, 200)}\n`).catch(() => undefined);
                  }
                }, () => undefined);
                pendingTranscripts.set(work, `from ${senderLabel(event)} (msg ${event.messageId ?? '?'}, chat ${event.chat?.id ?? '?'}${event.threadId !== undefined ? `, topic ${event.threadId}` : ''}; file --bot ${event.bot ?? '?'} ${event.file?.fileId ?? '?'})`);
                // Both handlers settle quietly: this tracking chain must never become an unhandled rejection.
                const forget = () => { pendingTranscripts.delete(work); };
                work.then(forget, forget);
                return work;
              },
              undefined,
              (event, transcript) => {
                const who = senderLabel(event);
                const where = `msg ${event.messageId ?? '?'}, chat ${event.chat?.id ?? '?'}${event.threadId !== undefined ? `, topic ${event.threadId}` : ''}`;
                const text = transcript.text !== undefined
                  ? `transcript of ${who}'s voice (${where}): "${transcript.text.trim()}"`
                  : `voice from ${who} (${where}) could not be transcribed: ${transcript.error ?? 'unknown'}; file ${event.file?.fileId ?? '?'}`;
                const line = `[hub] ${hhmm(Date.now())} tg-${event.bot ?? '?'} → me [tg]: ${text}\n`;
                if (batchPrinted) void writeDelivery(line).catch(() => undefined);
                else lateLines.push(line);
              },
            );
            const lines = shown.map((message) =>
              options.json
                ? JSON.stringify(message)
                // A rendered Telegram line is printed whole: its transcript exists only here, since `hub log
                // --json` holds the file id, not the words (Codex review).
                : formatHubMessage(message, agent, message.kind === 'tg' ? Number.MAX_SAFE_INTEGER : maxText, {
                    // A watcher line is read far from any shell, so it names the command that
                    // recovers a truncated body rather than assuming the reader knows.
                    recover: 'hub log --json',
                    receivedAt: Date.now(),
                  })
            );
            try {
              // Awaited, so the cursor below cannot outrun the notification.
              if (lines.length > 0) await writeDelivery(`${lines.join('\n')}\n`);
              batchPrinted = true;
              for (const line of lateLines.splice(0)) void writeDelivery(line).catch(() => undefined);
            } catch (error) {
              // Nothing is reading us any more; carrying on would advance the cursor
              // past messages with nowhere to deliver them.
              process.stderr.write(`[hub] stdout closed (${(error as Error).message}); stopping without confirming this batch\n`);
              process.exitCode = 1;
              return;
            }
            for (const message of fresh) remember(messageKey(message));
            // After the batch is printed, so a press never delays a message. `--once` is a check, not the watcher.
            if (!options.once) {
              for (const press of presses) {
                listen.take(press);
              }
            }

            try {
              appendHubLog(state, fresh, identity.origin);
              logErrorReported = false;
            } catch (error) {
              // Reported, never swallowed - a mirror that silently stopped mirroring
              // looks exactly like one that works - but never fatal and never a reason
              // to hold the cursor: the message has already reached the agent, and the
              // hub still has it.
              if (!logErrorReported) {
                process.stdout.write(
                  `[hub] ERROR cannot write the local message log: ${(error as Error).message}\n` +
                  '[hub] still watching; the hub keeps the history, so use `hub log` rather than --local\n'
                );
                logErrorReported = true;
              }
            }

            // R13's update channel, called out rather than left as one more line: a
            // listener cannot fix its own staleness, so the agent has to act.
            const restart = fresh.find((message) => message.kind === RESTART_KIND);
            if (restart) {
              process.stdout.write(
                `[hub] RESTART REQUESTED by ${restart.from}: this watcher is running claude-tools ${identity.version} ` +
                'and must be stopped, updated and re-armed. A running listener cannot update itself.\n'
              );
            }
            if (restart && options.exitOnRestart) {
              persist({ cursor: batch.cursor, machine: machine.label, approvedAt: Date.now() });
              // A return rather than `process.exit(0)`: the lines above are the whole
              // point of this exit, and exiting can drop a pipe that has not drained.
              return;
            }
          }

          // Saved from EVERY response, including an empty one and one that was all
          // duplicates: the server resolves `$` to real stream ids before it starts
          // waiting, so a client that skipped this would send `$` again and re-tail.
          persist({ cursor: batch.cursor, machine: machine.label, approvedAt: Date.now() });
          } finally {
            // Every way out of the delivery section, including the early returns inside it, ends it.
            delivering = false;
          }
          if (handOverRequested) {
            leaveForSuccessor();
            return;
          }

          if (options.once) {
            if (batch.messages.length === 0) {
              process.stdout.write(`[hub] no messages (held ${Math.round(batch.waitedMs / 1000)}s)\n`);
            }
            return;
          }
        }
      } finally {
        // However the loop ends (an update restart, a closed stdout, an error), presses it took but has not spoken
        // must not keep the process alive behind minutes of synthesis, nor be lost with the cursor already past them.
        await abandonPendingSpeech('the watcher exited');
      }
    });

  // -------------------------------------------------------------------------
  // send / broadcast
  // -------------------------------------------------------------------------
  hub
    .command('send <to> [message]')
    .description('Message another agent ("-" reads the body from stdin)')
    .option('--as <name>', 'Who to send as; defaults to the configured agent name')
    .option('--agent <name>', 'Alias for --as; every subcommand accepts both spellings')
    .option('--url <url>', 'Hub URL; the origin or its /api form')
    .option('--kind <kind>', 'Message kind the receiving client can switch on')
    .option('--corr <id>', 'Correlation id, so a reply can point at what it answers')
    .option('--again', 'Send even if the identical text went to the same recipient within the last hour')
    .option('--ttl <duration>', 'Let the message expire, e.g. 30m, 2h, 1d (max 7d): for operational notices that should not stay in history')
    .option('--json', 'Print the hub response as JSON')
    .addHelpText('after', `\nExit status: 0 sent; ${DUPLICATE_EXIT_CODE} not sent, because the identical text already went within the hour (the hub has it; --again sends anyway); 1 failed.`)
    .action(async (to: string, message: string | undefined, options: CommonOptions & SendOptions) => {
      // "all" is how a broadcast is DISPLAYED (`coordinator → all: …`), so it is the name agents naturally
      // type — and it is not an address. office-cluster did exactly this with a pre-apply announcement on
      // 2026-09-28: the hub refused it loudly, but a script that did not gate on the send went ahead and
      // merged anyway. Refused here, before stdin is read or the hub contacted, with the command that works.
      // Deliberately an error and not an alias: silently turning a recipient into "every agent" is the
      // worse failure of the two.
      if (to.trim().toLowerCase() === 'all') {
        console.error(chalk.red('"all" is not an agent.'));
        console.log(`To message every agent, use ${chalk.bold('hub broadcast')} — broadcasts are shown as "→ all", but that is not an address.`);
        process.exit(1);
      }
      await runSimple(options, async (identity) => {
        const body = await resolveMessageArg(message ?? '-');
        await sendOnce(identity, to, body, options, (id, recipient) => `✅ Sent to ${recipient} #${id}`);
      });
    });

  hub
    .command('broadcast [message]')
    .description('Message every agent at once ("-" reads the body from stdin)')
    .option('--as <name>', 'Who to send as; defaults to the configured agent name')
    .option('--agent <name>', 'Alias for --as; every subcommand accepts both spellings')
    .option('--url <url>', 'Hub URL; the origin or its /api form')
    .option('--kind <kind>', `Message kind; "${RESTART_KIND}" is the client-update channel`)
    .option('--corr <id>', 'Correlation id')
    .option('--again', 'Send even if the identical text was broadcast within the last hour')
    .option('--ttl <duration>', 'Let the message expire, e.g. 30m, 2h, 1d (max 7d): for operational notices that should not stay in history')
    .option('--json', 'Print the hub response as JSON')
    .addHelpText('after', `\nExit status: 0 sent; ${DUPLICATE_EXIT_CODE} not sent, because the identical text already went within the hour (the hub has it; --again sends anyway); 1 failed.`)
    .action(async (message: string | undefined, options: CommonOptions & SendOptions) => {
      await runSimple(options, async (identity) => {
        const body = await resolveMessageArg(message ?? '-');
        await sendOnce(identity, BROADCAST_TARGET, body, options, (id) => `✅ Broadcast #${id}`);
      });
    });

  hub
    .command('sent')
    .description('What this agent sent, confirmed by the hub: the answer to "did that land?"')
    .option('--as <name>', 'Whose sends to list; defaults to the configured agent name')
    .option('--agent <name>', 'Alias for --as; every subcommand accepts both spellings')
    .option('--url <url>', 'Hub URL; the origin or its /api form')
    .option('--limit <n>', 'How many of the most recent sends', '20')
    .option('--json', 'One JSON object per line')
    .action((options: CommonOptions & { limit?: string; json?: boolean }) => {
      const identity = resolveIdentity(options);
      const records = readSent(identity.agent, positiveInt(options.limit ?? '20', 'limit'), identity.origin);
      if (options.json) {
        for (const r of records) console.log(JSON.stringify(r));
        return;
      }
      if (records.length === 0) {
        console.log(`No confirmed sends recorded for "${identity.agent}" on this machine.`);
        return;
      }
      for (const r of records) {
        console.log(`${hhmm(r.ts)}  #${r.id}  → ${r.to === BROADCAST_TARGET ? 'all' : r.to}: ${r.head}`);
      }
    });

  // -------------------------------------------------------------------------
  // status
  // -------------------------------------------------------------------------
  hub
    // `[text]` is accepted as well as `--set`, because `hub status "working on X"` is the
    // obvious guess and used to fail with `too many arguments for 'status'` — a message that
    // says the shape is wrong without saying what the right shape is. Found by tripping over
    // it while fixing the other ISSUE-60 findings.
    .command('status [text]')
    .description('Read or set an agent status line')
    .option('--agent <name>', 'Whose status; defaults to this session\'s own')
    .option('--as <name>', 'Who to call as, when that differs from --agent')
    .option('--url <url>', 'Hub URL; the origin or its /api form')
    .option('--set <text>', 'Publish this status ("-" reads it from stdin); same as the positional')
    .option('--json', 'Print JSON')
    .action(async (text: string | undefined, options: CommonOptions & { set?: string; json?: boolean }) => {
      if (text !== undefined && options.set !== undefined && text !== options.set) {
        // Two different statuses in one call is a mistake, not a precedence question.
        console.error(chalk.red('Two different statuses given. Pass the text positionally or with --set, not both.'));
        process.exit(1);
      }
      options = { ...options, set: options.set ?? text };
      // Setting: `--agent` names whose line to write and the caller stays this session (or `--as`), so writing
      // another agent's line is attributed to the writer rather than forged under the target's name. Any agent
      // may set any agent's line; the hub shows who wrote it.
      const writing = options.set !== undefined;
      if (writing && options.agent !== undefined && options.agent !== options.as) {
        requireAs(options, `Setting ${options.agent}'s status`);
      }
      const callAs: CommonOptions = writing ? { ...options, agent: undefined } : options;
      await runSimple(callAs, async ({ client, agent }) => {
        if (writing) {
          const text = await resolveMessageArg(options.set as string);
          const result = await client.setStatus(text, options.agent ?? agent);
          if (options.json) {
            console.log(JSON.stringify(result));
            return;
          }
          console.log(chalk.green(`✅ ${result.agent}: ${result.status}`) + (result.agent === agent ? '' : chalk.dim(` (set by ${agent})`)));
          return;
        }

        // Reading is a roster read: the status lives on the presence record, so
        // there is no second endpoint and no second round trip.
        const wanted = options.agent ?? agent;
        const roster = await client.roster();
        const row = roster.agents.find((entry) => entry.agent === wanted);
        if (!row) {
          console.log(chalk.dim(`No agent "${wanted}" on the hub yet. An agent appears once it has armed a watcher.`));
          return;
        }
        if (options.json) {
          console.log(JSON.stringify(row));
          return;
        }
        console.log(`${chalk.bold(row.agent)}  ${row.state}  ${chalk.dim(ago(row.lastSeen, roster.now))}`
          + (row.stoppedAt === null ? '' : chalk.dim(`  stopped cleanly ${ago(row.stoppedAt, roster.now)}`)));
        console.log((row.status ?? chalk.dim('(no status set)')) + (row.statusBy === null ? '' : chalk.dim(`  (set by ${row.statusBy})`)));
      });
    });

  // -------------------------------------------------------------------------
  // forget / restore / prune / audit — any agent controls any agent's roster entry and history
  // (Davron, 2026-10-06). The hub records every action with its caller; an agent archives but never purges,
  // and its prunes keep copies for 7 days.
  // -------------------------------------------------------------------------
  hub
    .command('forget <agent>')
    .description('Archive an offline agent: off the roster now, deleted after 7 days unless restored (audited)')
    .option('--as <name>', 'Who to call as; defaults to the configured agent name')
    .option('--url <url>', 'Hub URL; the origin or its /api form')
    .option('--json', 'Print JSON')
    .action(async (target: string, options: CommonOptions & { json?: boolean }) => {
      requireAs(options, 'An archive');
      await runSimple({ ...options, agent: undefined }, async ({ client, agent }) => {
        const result = await client.forget(target);
        if (options.json) {
          console.log(JSON.stringify(result));
          return;
        }
        const until = result.purgeAt === null ? '' : `; restorable until ${new Date(result.purgeAt).toISOString().slice(0, 16)}Z`;
        console.log(chalk.green(`✅ ${result.agent} archived by ${agent}${until}`));
        console.log(chalk.dim(`Undo: claude-tools hub restore ${result.agent}`));
      });
    });

  hub
    .command('restore <agent>')
    .description('Put an archived agent back on the roster (audited)')
    .option('--as <name>', 'Who to call as; defaults to the configured agent name')
    .option('--url <url>', 'Hub URL; the origin or its /api form')
    .option('--json', 'Print JSON')
    .action(async (target: string, options: CommonOptions & { json?: boolean }) => {
      requireAs(options, 'A restore');
      await runSimple({ ...options, agent: undefined }, async ({ client, agent }) => {
        const result = await client.restore(target);
        if (options.json) {
          console.log(JSON.stringify(result));
          return;
        }
        console.log(chalk.green(`✅ ${result.agent} restored by ${agent}`));
      });
    });

  hub
    .command('prune <stream>')
    .description('Preview, or with --confirm remove, retained messages in an agent\'s inbox or "*" for broadcasts (audited; copies kept 7 days)')
    .option('--match <text>', 'Only messages whose body contains this (case-insensitive)')
    .option('--before <time>', 'Only messages older than this (ISO time or epoch ms)')
    .option('--expired-only', 'Only messages whose TTL has passed')
    .option('--ids <ids>', 'Exactly these message ids (comma-separated), as a preview printed them')
    .option('--confirm', 'Remove what the preview selects (or exactly --ids); without it nothing is removed')
    .option('--as <name>', 'Who to call as; defaults to the configured agent name')
    .option('--url <url>', 'Hub URL; the origin or its /api form')
    .option('--json', 'Print JSON')
    .action(async (stream: string, options: CommonOptions & { match?: string; before?: string; expiredOnly?: boolean; ids?: string; confirm?: boolean; json?: boolean }) => {
      if (stream !== BROADCAST_TARGET && !AGENT_NAME_PATTERN.test(stream)) {
        console.error(chalk.red(`Invalid stream ${JSON.stringify(stream)}: an agent name, or "*" for broadcasts.`));
        process.exit(1);
      }
      let before: number | undefined;
      if (options.before !== undefined) {
        before = /^\d+$/.test(options.before) ? Number(options.before) : Date.parse(options.before);
        if (!Number.isFinite(before)) {
          console.error(chalk.red(`--before ${JSON.stringify(options.before)} is neither an ISO time nor epoch ms.`));
          process.exit(1);
        }
      }
      const filter = {
        stream,
        ...(options.match === undefined ? {} : { match: options.match }),
        ...(before === undefined ? {} : { before }),
        ...(options.expiredOnly ? { expiredOnly: true } : {}),
      };
      if (options.confirm) requireAs(options, 'A prune');
      if (!options.match && before === undefined && !options.expiredOnly && options.ids === undefined) {
        console.error(chalk.red('Give a filter (--match, --before, --expired-only) or --ids; a prune of a whole stream is not a default.'));
        process.exit(1);
      }
      await runSimple({ ...options, agent: undefined }, async ({ client, agent }) => {
        const preview = await client.prune(filter);
        const wanted = options.ids === undefined ? null : new Set(options.ids.split(',').map((id) => id.trim()).filter(Boolean));
        const selected = wanted === null ? preview.candidates : preview.candidates.filter((c) => wanted.has(c.id));
        if (!options.confirm) {
          if (options.json) {
            console.log(JSON.stringify({ ...preview, candidates: selected }));
            return;
          }
          for (const c of selected) {
            console.log(`${c.id}  ${hhmm(c.ts)}  ${c.from} → ${c.to === BROADCAST_TARGET ? 'all' : c.to}${c.expired ? chalk.dim(' (expired)') : ''}: ${c.head}`);
          }
          console.log(chalk.dim(`${selected.length} message(s) would be removed${preview.truncated ? ' (more match; narrow the filter)' : ''}. Nothing was removed; add --confirm.`));
          return;
        }
        if (wanted !== null && selected.length !== wanted.size) {
          console.error(chalk.red(`${wanted.size - selected.length} of the given ids are not in the preview for this filter. Nothing was removed.`));
          process.exit(1);
        }
        if (selected.length === 0) {
          console.log('Nothing matches. Nothing was removed.');
          return;
        }
        if (selected.length > MAX_AGENT_PRUNE) {
          console.error(chalk.red(`${selected.length} messages match; one prune removes at most ${MAX_AGENT_PRUNE}. Narrow the filter or pass --ids.`));
          process.exit(1);
        }
        const done = await client.prune({ ...filter, ids: selected.map((c) => c.id), confirm: true });
        // Some may go between the preview and the confirm (another prune, or a message changed). That fails the
        // command in every output mode, so a script never reads a partial removal as the one it asked for.
        const partial = done.deleted < selected.length;
        // What was pruned is no longer on the hub, so this machine's record of having sent it must not keep
        // refusing an identical resend as a duplicate (coordinator, 2026-10-13: a mistaken prune, then a re-post
        // refused with "the hub has it" while the hub did not).
        // Each message under the agent that SENT it, on this machine; and only when every selected message went, since
        // the hub's answer counts deletions without naming them, and forgetting a message still retained would let it
        // be sent twice (Codex review).
        if (!partial && done.deleted > 0) {
          const bySender = new Map<string, { id: string; to: string }[]>();
          for (const c of selected) bySender.set(c.from, [...(bySender.get(c.from) ?? []), { id: c.id, to: c.to }]);
          for (const [sender, removed] of bySender) await forgetSent(sender, client.origin, removed).catch(() => 0);
        }
        if (partial) process.exitCode = 1;
        if (options.json) {
          console.log(JSON.stringify({ ...done, requested: selected.length }));
          return;
        }
        const where = stream === BROADCAST_TARGET ? 'broadcasts' : stream;
        if (partial) {
          console.error(chalk.yellow(`⚠ ${agent} removed ${done.deleted} of ${selected.length} message(s) from ${where}; the rest were already gone or no longer match.`));
        } else {
          console.log(chalk.green(`✅ ${agent} removed ${done.deleted} message(s) from ${where}`));
        }
        if (done.deleted > 0) console.log(chalk.dim('Copies are kept for 7 days: claude-tools hub audit'));
      });
    });

  hub
    .command('broadcasts')
    .description('List the broadcasts a session reads on its first "hub log", oldest first. Read-only')
    .option('--expired', 'Also list expired broadcasts: still stored, but no session is shown them')
    .option('--as <name>', 'Who to call as; defaults to the configured agent name')
    .option('--url <url>', 'Hub URL; the origin or its /api form')
    .option('--json', 'Print JSON')
    .action(async (options: CommonOptions & { json?: boolean; expired?: boolean }) => {
      // The prune endpoint's PREVIEW: it lists a stream exactly and removes nothing without `confirm`. A filter is
      // required there, so "sent before a day from now" stands for "all of them".
      await runSimple({ ...options, agent: undefined }, async ({ client }) => {
        const preview = await client.prune({ stream: BROADCAST_TARGET, before: Date.now() + 86_400_000 });
        // By default what a session is actually shown: the hub does not serve an expired broadcast to anyone's log,
        // so counting it here would overstate what a newcomer reads (coordinator, 2026-10-13: 33 stored, 9 seen).
        const all = [...preview.candidates].sort((a, b) => a.ts - b.ts);
        const rows = options.expired ? all : all.filter((c) => !c.expired);
        const hidden = all.length - rows.length;
        if (options.json) {
          console.log(JSON.stringify({ broadcasts: rows, expiredNotShown: options.expired ? 0 : hidden, truncated: preview.truncated }));
          return;
        }
        if (rows.length === 0) {
          // Only a complete listing may say "none": a truncated page of expired entries says nothing about the rest.
          if (preview.truncated) console.log(`The first ${all.length} stored broadcast(s) are all expired, and more exist that are not listed here; this cannot say whether any is shown to sessions.`);
          else console.log(`No broadcast is shown to sessions.${hidden > 0 ? ` ${hidden} expired one(s) are still stored: --expired lists them.` : ''}`);
          return;
        }
        for (const c of rows) {
          console.log(`${c.id}  ${new Date(c.ts).toISOString().slice(0, 16).replace('T', ' ')}Z  ${c.from}${c.expired ? chalk.dim(' (expired)') : ''}: ${c.head}`);
        }
        const what = options.expired ? 'stored' : 'shown to every session on its first hub log';
        console.log(chalk.dim(`${rows.length} broadcast(s) ${what}${preview.truncated ? ', and more not listed' : ''}`
          + `${!options.expired && hidden > 0 ? `; ${hidden} expired one(s) are stored but not shown (--expired)` : ''}. Remove one with: hub prune '*' --ids <id> --confirm --as <you>`));
      });
    });

  hub
    .command('audit')
    .description('Who archived, restored, pruned or set whose status, newest first; --copies shows what a prune removed')
    .option('--limit <n>', 'How many entries', '20')
    .option('--copies <id>', 'Print the messages one prune removed (the id its audit entry names)')
    .option('--as <name>', 'Who to call as; defaults to the configured agent name')
    .option('--url <url>', 'Hub URL; the origin or its /api form')
    .option('--json', 'Print JSON')
    .action(async (options: CommonOptions & { limit?: string; copies?: string; json?: boolean }) => {
      await runSimple({ ...options, agent: undefined }, async ({ client }) => {
        if (options.copies !== undefined) {
          const messages = await client.auditCopies(options.copies);
          if (options.json) {
            console.log(JSON.stringify(messages));
            return;
          }
          for (const m of messages) console.log(`${m.id}  ${hhmm(m.ts)}  ${m.from} → ${m.to === BROADCAST_TARGET ? 'all' : m.to}: ${m.body}`);
          return;
        }
        const entries = await client.audit(positiveInt(options.limit ?? '20', 'limit'));
        if (options.json) {
          for (const e of entries) console.log(JSON.stringify(e));
          return;
        }
        if (entries.length === 0) {
          console.log('The audit trail is empty.');
          return;
        }
        for (const e of entries) {
          const detail = e.detail as Record<string, unknown> | null;
          const extra = e.action === 'prune' && detail !== null
            ? ` deleted=${String(detail['deleted'])}${detail['copies'] ? ` copies=${String(detail['copies'])}` : ''}`
            : e.action === 'status' && detail !== null ? ` "${String(detail['status'])}"` : '';
          console.log(`${hhmm(e.ts)}  ${e.actor}  ${e.action}  ${e.target === BROADCAST_TARGET ? 'broadcasts' : e.target}${extra}`);
        }
      });
    });

  // -------------------------------------------------------------------------
  // rename
  // -------------------------------------------------------------------------
  hub
    .command('rename <new>')
    .description('Rename this agent on the hub, and its tmux session with it')
    // No `--agent`-as-subject here, and that is the family convention rather than an
    // omission: an agent renames ITSELF, so the subject and the caller are the same name
    // and both spellings resolve the same identity. Accepting both keeps `hub rename`
    // callable from a script that passes `--agent` to every subcommand.
    .option('--as <name>', 'The name being renamed; defaults to this session\'s own')
    .option('--agent <name>', 'Alias for --as; every subcommand accepts both spellings')
    .option('--url <url>', 'Hub URL; the origin or its /api form')
    .option('--json', 'Print the per-target outcome as JSON')
    .action(async (next: string, options: CommonOptions & { json?: boolean }) => {
      // Refused before the config is read and before a fingerprint is derived. The server
      // moves the status, the status log, the cursor mirror and the inbox and then frees
      // the old name, so a target name the hub was always going to refuse must not get as
      // far as being sent: a half-rename is the one outcome here with no obvious cure.
      if (!AGENT_NAME_PATTERN.test(next)) {
        console.error(chalk.red(`Invalid new name ${JSON.stringify(next)}. Nothing was renamed.`));
        console.log('\nAn agent name is 1-40 characters of a-z, 0-9 and "-": it ends up inside a Redis key name.');
        process.exit(1);
      }
      if (options.agent !== undefined && options.as !== undefined && options.agent !== options.as) {
        // The same rule as `status --set`, for the same reason: an agent owns its own
        // record and nothing else's, so two different names here is a mistake rather than
        // a precedence question. Saying it now beats a 409 that reads like a collision.
        console.error(chalk.red('An agent can only rename itself. Drop --agent, or set --as to the same name.'));
        process.exit(1);
      }

      await runSimple(options, async ({ client }) => {
        // The hub first, and fatally: it is the only target whose failure means the rename
        // did not happen. `runSimple` prints the error and exits 1, so nothing below runs -
        // in particular the tmux session is not renamed to a name the hub refused.
        const renamed = await client.rename(next);
        // Leave a breadcrumb for the registration hook, which resolves a name from AGENT_HUB_AGENT and
        // therefore cannot see that this agent has moved. Without it the hook keeps naming the OLD name,
        // and an agent that obeys it re-registers an archived name — un-archiving it and undoing the
        // archive this rename just created. Best-effort: the rename has already happened server-side, so
        // a local write failure must never be reported as a failed rename.
        try {
          mkdirSync(hubStateDir(renamed.from), { recursive: true });
          writeFileSync(hubRenamedToPath(renamed.from), `${renamed.to}\n`, { mode: 0o600 });
        } catch (error) {
          process.stderr.write(
            `[hub] renamed, but could not record the successor locally: `
            + `${error instanceof Error ? error.message : String(error)}. `
            + `The registration hook may keep naming "${renamed.from}" — ignore it.\n`,
          );
        }
        const steps: RenameStep[] = [
          { target: 'hub', state: 'done', detail: `"${renamed.from}" → "${renamed.to}"; the old name is archived, then swept` },
          // Local, and after the fact. A failure here is reported as itself and never
          // turned into a failure of the command: the rename HAS happened, and exiting
          // non-zero would tell a caller the opposite of what is true.
          renameTmuxSession(renamed.to),
          claudeRenameStep(renamed.to),
        ];

        if (options.json) {
          console.log(JSON.stringify({ from: renamed.from, to: renamed.to, ts: renamed.ts, steps }));
          return;
        }
        console.log(formatRenameReport(renamed.from, renamed.to, steps, watchCommand(renamed.to)));
      });
    });

  // -------------------------------------------------------------------------
  // roster
  // -------------------------------------------------------------------------
  hub
    .command('roster')
    .description('Who exists, what state they are in and when they were last seen')
    .option('--as <name>', 'Who to call as; defaults to the configured agent name')
    .option('--agent <name>', 'Alias for --as; every subcommand accepts both spellings')
    .option('--url <url>', 'Hub URL; the origin or its /api form')
    .option('--json', 'Print JSON')
    .action(async (options: CommonOptions & { json?: boolean }) => {
      await runSimple(options, async ({ client }) => {
        const roster = await client.roster();
        if (options.json) {
          console.log(JSON.stringify(roster));
          return;
        }
        if (roster.agents.length === 0) {
          console.log(chalk.dim('No agents on the hub yet. An agent appears once it has armed a watcher.'));
          return;
        }
        const width = Math.max(...roster.agents.map((entry) => entry.agent.length));
        console.log(chalk.bold('\nAgents'));
        for (const entry of roster.agents) {
          const colour = entry.state === 'live' ? chalk.green : entry.state === 'idle' ? chalk.yellow : chalk.dim;
          const machine = entry.machine ? chalk.dim(` ${entry.machine}`) : '';
          const version = entry.clientVersion ? chalk.dim(` client ${entry.clientVersion}`) : '';
          console.log(
            `  ${entry.agent.padEnd(width)}  ${colour(entry.state.padEnd(7))} ${chalk.dim(ago(entry.lastSeen, roster.now).padEnd(9))}` +
            `${machine}${version}`
          );
          if (entry.status) console.log(`  ${' '.repeat(width)}  ${entry.status}`);
        }
        console.log('');
      });
    });

  // -------------------------------------------------------------------------
  // log
  // -------------------------------------------------------------------------
  hub
    .command('log')
    .description('Retained history for an agent')
    .option('--agent <name>', 'Whose history; defaults to this session\'s own')
    .option('--as <name>', 'Who to call as, when that differs from --agent')
    .option('--url <url>', 'Hub URL; the origin or its /api form')
    .option('--limit <n>', 'How many messages', String(DEFAULT_LOG_LIMIT))
    .option('--max-text <n>', 'Truncate a message body to this many characters', '2000')
    .option('--local', 'Read this watcher\'s own local log instead of the hub\'s')
    .option('--state <name>', 'Cursor namespace for --local; defaults to the agent name')
    .option('--json', 'Print one JSON object per line')
    .action(async (options: CommonOptions & {
      limit: string; maxText: string; local?: boolean; state?: string; json?: boolean;
    }) => {
      const limit = Math.min(positiveInt(options.limit, 'limit'), MAX_LOG_LIMIT);
      const maxText = positiveInt(options.maxText, 'max-text');

      if (options.local) {
        // No network, no identity: this is what the watcher wrote down. Useful
        // precisely when the hub is the thing that is unreachable.
        const config = loadConfig();
        const agent = (options.agent ?? config.hub.agent ?? '').trim();
        const state = options.state ?? agent;
        if (!state) {
          console.error(chalk.red('--local needs --state or --agent to know which log to read.'));
          process.exit(1);
        }
        const messages = readHubLog(state, limit);
        if (messages.length === 0) {
          console.log(chalk.dim(`Nothing logged locally yet (${hubLogPath(state)}).`));
          return;
        }
        for (const message of messages) {
          console.log(options.json ? JSON.stringify(message) : formatHubMessage(message, agent, maxText, { dated: true }));
        }
        return;
      }

      await runSimple(options, async ({ client, agent }) => {
        const history = await client.history({
          // Absent means "mine": the hub defaults the subject to the caller, so
          // there is nothing to fill in here.
          ...(options.agent === undefined ? {} : { agent: options.agent }),
          limit,
        });
        if (history.messages.length === 0) {
          console.log(chalk.dim(`No history for ${history.agent}.`));
          return;
        }
        for (const message of history.messages) {
          console.log(options.json ? JSON.stringify(message) : formatHubMessage(message, agent, maxText, { dated: true }));
        }
      });
    });

  // A URL typo is the one configuration mistake that produces a confusing failure
  // rather than an obvious one, so it is worth being able to see what was resolved
  // without sending anything anywhere.
  hub
    .command('whoami')
    .description('Show this machine\'s hub identity and the URL that would be used')
    .option('--agent <name>', 'This session\'s agent name on the hub')
    .option('--as <name>', 'Alias for --agent, for symmetry with the other commands')
    .option('--url <url>', 'Hub URL; the origin or its /api form')
    .action((options: CommonOptions) => {
      const config = loadConfig();
      let machine: MachineFingerprint;
      try {
        machine = machineFingerprint();
      } catch (error) {
        console.error(chalk.red('Error:'), (error as Error).message);
        process.exit(1);
      }
      let origin: string;
      try {
        origin = hubOrigin(options.url ?? config.hub.url);
      } catch (error) {
        console.error(chalk.red('Error:'), (error as Error).message);
        process.exit(1);
      }
      console.log(chalk.bold('\nHub'));
      console.log(`  api      ${origin}/api`);
      console.log(`  console  ${consoleUrl(origin)}`);
      console.log(chalk.bold('\nThis machine'));
      // The label, never the fingerprint: an agent transcript gets pasted into chats.
      console.log(`  machine  ${machine.label}  ${chalk.dim(`(anchor: ${machine.anchor.rung})`)}`);
      // whoami must answer with the name the hub actually knows, and SAY when that differs from what
      // the environment claims. It previously printed the raw configured value, so after a rename the one
      // command whose whole job is "what name am I?" reported the ARCHIVED name while every other command
      // resolved correctly — anyone verifying a rename through the obvious diagnostic would conclude it had
      // failed. Showing both is better than silently correcting: the stale variable is the thing to fix.
      const declared = (options.as ?? options.agent ?? config.hub.agent ?? '').trim();
      const effective = (options.as ?? options.agent ?? '').trim() || followRenames(declared);
      const shown = declared === ''
        ? chalk.dim('(none configured; pass --agent)')
        : effective === declared
          ? effective
          : `${effective}  ${chalk.dim(`(AGENT_HUB_AGENT still says "${declared}" — renamed; pass AGENT_HUB_AGENT=${effective} at next launch)`)}`;
      console.log(`  agent    ${shown}`);
      console.log(`  client   ${clientVersion()}\n`);
    });
}
