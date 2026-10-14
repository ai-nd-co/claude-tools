// GitHub commands. `github watch` polls the notification inbox through the
// `gh` CLI's existing login and prints one line per changed thread; it never
// exits on its own, so it runs under watch_start (or the Monitor tool).

import { Command } from 'commander';
import chalk from 'chalk';
import { execFile } from 'child_process';
import { rmSync } from 'fs';
import { formatDelay, sleep } from '../../services/backoff.js';
import { redactSecrets } from '../../services/redact.js';
import { outboxUnsupportedReason, writeOutbox } from '../../services/outbox.js';
import {
  GithubWatcher,
  MAX_INTERVAL_MS,
  fetchNotifications,
  subjectFingerprint,
  ghFailure,
  githubWatchStatePath,
  loadGithubWatchState,
  parseGhInclude,
  saveGithubWatchState,
  type GhResponse,
} from '../../services/github-watch.js';

/** A page of notifications is ~6 KB per thread with the repository object; leave room. */
const MAX_BUFFER = 64 * 1024 * 1024;
const GH_TIMEOUT_MS = 60_000;

/** Run `gh api --include`, resolving with the parsed response even when gh exits non-zero. */
function ghApi(path: string, headers: Record<string, string> = {}): Promise<GhResponse> {
  const args = ['api', '--include', '--method', 'GET'];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  args.push(path);
  return new Promise((resolve, reject) => {
    execFile('gh', args, { maxBuffer: MAX_BUFFER, timeout: GH_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        // Matches backoff's permanent patterns: nothing will install gh for us.
        reject(new Error('gh CLI not found on PATH; GitHub watch is not configured (install gh and run `gh auth login`)'));
        return;
      }
      // gh exits 1 on a 304 too, so the status line decides, not the exit code.
      const parsed = parseGhInclude(String(stdout));
      if (parsed) {
        resolve(parsed);
        return;
      }
      const failure = error as (NodeJS.ErrnoException & { killed?: boolean; signal?: string | null }) | null;
      reject(ghFailure(path, failure?.code, String(stderr), {
        killed: failure?.killed,
        signal: failure?.signal,
        timeoutMs: GH_TIMEOUT_MS,
      }));
    });
  });
}

function positiveInt(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(chalk.red(`--${name} must be a positive integer`));
    process.exit(1);
  }
  return n;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, ...value.split(',').map((v) => v.trim()).filter(Boolean)];
}

/** Set by --outbox: lines go to durable files there instead of stdout. */
let outboxDir: string | undefined;

/** Awaited stdout write: the state is only saved once the line is actually gone. */
function writeOut(text: string): Promise<void> {
  // Everything this command prints passes here, so redaction here covers lines built from flags
  // too. Event lines were already redacted; a second pass changes nothing in them.
  const safe = redactSecrets(text);
  if (outboxDir) {
    // Synchronous and fsynced: the line is on disk before the caller saves its state.
    try {
      writeOutbox(outboxDir, safe);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  }
  return new Promise((resolve, reject) => {
    process.stdout.write(safe, (error) => (error ? reject(error) : resolve()));
  });
}

interface WatchCliOptions {
  interval: string;
  maxText: string;
  state: string;
  since?: string;
  reset?: boolean;
  json?: boolean;
  once?: boolean;
  outbox?: string;
  dropSilentBumps?: boolean;
  participating?: boolean;
  repo: string[];
  reason: string[];
  type: string[];
}

export function registerGithubCommands(program: Command): void {
  const github = program
    .command('github')
    .description('GitHub notifications through the gh CLI login');

  github
    .command('watch')
    .description('Watch the GitHub notification inbox and print one line per changed thread (for watch_start / Monitor)')
    .option('--interval <sec>', 'Poll interval in seconds; GitHub\'s X-Poll-Interval is honoured when longer', '60')
    .option('--max-text <n>', 'Truncate titles to this many characters', '300')
    .option('--state <name>', 'State namespace; use a distinct one per agent watching the same inbox', 'default')
    .option('--since <iso>', 'Report changes after this time (overrides saved state)')
    .option('--reset', 'Discard saved state and re-baseline at the newest notification')
    .option('--participating', 'Only threads you participate in or were mentioned in')
    .option('--repo <pattern>', 'Keep only these owner/repo patterns (* wildcard; repeat or comma-separate)', collect, [])
    .option('--reason <reason>', 'Keep only these reasons: author, comment, mention, review_requested, ci_activity, state_change, … (repeatable)', collect, [])
    .option('--type <type>', 'Keep only these subject types: PullRequest, Issue, CheckSuite, Release, … (repeatable)', collect, [])
    .option('--json', 'Print one JSON object per line')
    .option('--once', 'Poll once and exit (for checking the setup)')
    .option('--drop-silent-bumps', 'Skip a PR or issue update when the PR or issue itself did not change (GitHub moves threads on its own)')
    .option('--outbox <dir>', 'Write each line as its own fsynced file in <dir> instead of stdout; the reader deletes a file once delivered')
    .addHelpText('after', `
${chalk.yellow('Behaviour:')}
  Reads https://github.com/notifications through \`gh api\`, so it uses the gh
  login and adds no credential. Every --interval seconds it asks for every
  thread updated in the last six hours and reports the ones it has not seen,
  because GitHub can show a notification minutes after the time it carries.
  The ETag makes an unchanged window a 304 that does not count against the
  rate limit. State is saved under <config dir>/github-watch/<state>/, so a
  restarted watcher reports what changed while it was down. The first run (no
  saved state) only records a baseline.

  Workflow-run failures appear as type CheckSuite only when "Actions"
  notifications are enabled in GitHub's notification settings.

${chalk.yellow('Line format:')}
  [gh] <owner/repo> <PR#n|Issue#n|CI|Release|…> <reason|change> <HH:MM>: <title> <url>

  The third field is GitHub's reason (why you are subscribed: comment,
  mention, review_requested, …). With --drop-silent-bumps it is instead
  what changed when this update's check succeeded and could be compared
  with an earlier look at the same PR or issue; otherwise (a first look, a
  failed, paused or over-budget check, a subject newer than the
  notification) it stays GitHub's reason. Change words, joined by "+":
  merged, closed, reopened, ready for review, converted to draft, pushed,
  reviewed, review comments, commented, review requested, review request
  removed, review requests changed, assigned, unassigned, assignees
  changed, labelled, unlabelled, labels changed, or updated (a change it
  cannot classify, for example an edit). With a change word and no new
  comment, the link goes to the PR, not a comment. --json lines keep
  "reason" and add "change" only when there is one.

  --drop-silent-bumps skips a PR or issue update when the PR or issue
  itself did not change. Accepted limit: a second real change in the same
  second as the one just reported can be skipped (one-second timestamps);
  the change itself stays on GitHub, only its line is lost.

${chalk.yellow('Examples:')}
  ${chalk.dim('# Everything in the inbox')}
  claude-tools github watch

  ${chalk.dim('# Only PRs and CI in one organisation')}
  claude-tools github watch --repo 'otherorg/*' --type PullRequest,CheckSuite

  ${chalk.dim('# From Claude Code')}
  watch_start({ name: "gh", command: ["node", "<path>/dist/cli.js", "github", "watch", "--state", "<agent>"] })
`)
    .action(async (options: WatchCliOptions) => {
      const intervalMs = positiveInt(options.interval, 'interval') * 1000;
      if (intervalMs > MAX_INTERVAL_MS) {
        console.error(chalk.red(`--interval must be at most ${MAX_INTERVAL_MS / 1000} seconds`));
        process.exit(1);
      }
      const opts = {
        intervalMs,
        maxText: positiveInt(options.maxText, 'max-text'),
        json: !!options.json,
        repos: options.repo,
        reasons: options.reason,
        types: options.type,
        participating: !!options.participating,
      };
      if (options.since !== undefined && Number.isNaN(Date.parse(options.since))) {
        console.error(chalk.red('--since must be an ISO date or time, e.g. 2026-10-01T12:00:00Z'));
        process.exit(1);
      }

      outboxDir = options.outbox;
      // An empty value (an unset variable in a unit file) must not fall back to stdout silently.
      const unsupported = options.outbox === undefined ? null
        : options.outbox.trim() === '' ? '--outbox needs a directory; it was given an empty value'
          : outboxUnsupportedReason();
      if (unsupported) {
        console.error(chalk.red(unsupported));
        process.exit(1);
      }
      const statePath = githubWatchStatePath(options.state);
      if (options.reset) rmSync(statePath, { force: true });

      // The reader went away (the watch was stopped, or `| head` closed): nothing left to deliver to.
      process.stdout.on('error', (error: NodeJS.ErrnoException) => process.exit(error.code === 'EPIPE' ? 0 : 1));
      process.on('SIGINT', () => process.exit(0));
      process.on('SIGTERM', () => process.exit(0));
      process.on('SIGHUP', () => process.exit(0));

      const watcher = new GithubWatcher(opts, {
        fetch: (req) => fetchNotifications(ghApi, req, !!options.participating),
        subjectFingerprint: options.dropSilentBumps ? (thread) => subjectFingerprint(ghApi, thread) : undefined,
        loadState: () => loadGithubWatchState(statePath),
        saveState: (state) => saveGithubWatchState(statePath, state),
        emit: (lines) => writeOut(`${lines.join('\n')}\n`),
        log: (message) => {
          process.stderr.write(`[gh-watch] ${new Date().toISOString()} ${message}\n`);
        },
      }, { since: options.since });
      if (watcher.rebaselined) {
        await writeOut('[gh-watch] --participating changed since the saved state; re-baselining, nothing before now is reported\n');
      }

      let delay: number;
      try {
        delay = await watcher.tick();
      } catch (err) {
        const message = (err as Error).message;
        await writeOut(`[gh-watch] ERROR ${message}\n`);
        process.exit(1);
      }

      // A check of the setup must not pass on a poll that failed.
      if (options.once && watcher.lastFailure()) {
        await writeOut(`[gh-watch] ERROR ${watcher.lastFailure()}\n`);
        process.exit(1);
      }

      const filters = [
        opts.repos.length ? `repo ${opts.repos.join(',')}` : '',
        opts.reasons.length ? `reason ${opts.reasons.join(',')}` : '',
        opts.types.length ? `type ${opts.types.join(',')}` : '',
        options.participating ? 'participating' : '',
      ].filter(Boolean).join('; ');
      await writeOut(
        // The floor is fixed at the first run; print the advancing position beside it, or a reader
        // takes the fixed date for a stuck cursor.
        `[gh-watch] watching GitHub notifications; baseline ${watcher.floor() ?? '(pending)'}, last poll ${watcher.lastPollAt() ?? '(none yet)'}; ` +
        `poll ${formatDelay(delay)}${filters ? `; ${filters}` : ''}\n`
      );
      if (options.once) process.exit(0);

      for (;;) {
        await sleep(delay);
        try {
          delay = await watcher.tick();
        } catch (err) {
          const message = (err as Error).message;
          await writeOut(`[gh-watch] ERROR ${message}\n`);
          process.exit(1);
        }
      }
    });
}
