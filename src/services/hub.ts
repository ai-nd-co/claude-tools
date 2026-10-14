// Agent-hub client: the long poll, the send, the roster, the status line and the
// retained history.
//
// The hub is a server agents LISTEN to, not a tool they call. Only two things can
// wake an idle Claude Code session - a harness message, or a line on the stdout of
// a process it started with the Monitor tool - so `hub watch` is a `getUpdates`
// loop pointed at a different server, and everything else here exists to support
// it. The shape is deliberately the shape of `telegram-bot.ts`: one cursor stored
// locally, advanced only after the batch is durably written down, an outage ridden
// out rather than exited on.
//
// What this module does NOT do is authenticate as a person. It authenticates the
// MACHINE, with a fingerprint derived in `hub-fingerprint.ts`, and the server
// compares only a hash of it. Three rules follow and none of them are optional:
//
//  1. The fingerprint travels in `X-Hub-Fingerprint`, never in `Authorization`.
//     The house basic-auth middleware in the cluster is configured
//     `removeHeader: true` and would eat the credential (roadmap R8).
//  2. It never goes in a URL or a query string - those land in access logs - and
//     never into an error message; `redact()` below is the one place that is
//     guaranteed.
//  3. What gets printed is the 16-character machine LABEL, which is a prefix of
//     `sha256(fingerprint)` rather than of the fingerprint itself. An agent
//     transcript gets pasted into chats.
//
// The wire contract lives in the server's `packages/shared/src`. It cannot be
// imported across repositories, so the parts this client needs are mirrored below
// with the upstream file named on each one. The derivation is the only piece where
// a divergence would be silent and catastrophic, and that one is vendored whole
// and pinned by test vectors rather than mirrored.

import { closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'fs';
import { createHash } from 'crypto';
import { hostname } from 'os';
import { dirname, join } from 'path';

import { getConfigDir } from '../config/paths.js';
import { FINGERPRINT_PATTERN } from './hub-fingerprint.js';
import { parseRetryAfter } from './backoff.js';
import { withProcessLock } from './hub-owner.js';

// ---------------------------------------------------------------------------
// The wire contract, mirrored from the server's @agent-hub/shared
// ---------------------------------------------------------------------------

/** `packages/shared/src/messages.ts`, `agents.ts`, `machines.ts`. */
/**
 * The longest a message may be told to live (ISSUE-96), mirrored from `@agent-hub/shared`. A message sent with
 * a TTL stops being delivered and stops appearing in history when it expires. It is meant for operational
 * notices ("applying #148 now") that should not sit in a newcomer's history for 90 days.
 */
export const MAX_MESSAGE_TTL_SECONDS = 7 * 24 * 60 * 60;

/** `90s`, `30m`, `2h`, `1d` (or a bare number of seconds) as seconds; null if it is not one of those. */
export function parseTtl(text: string): number | null {
  const match = /^(\d+)([smhd]?)$/.exec(text.trim());
  if (!match) return null;
  const value = Number(match[1]) * ({ '': 1, s: 1, m: 60, h: 3_600, d: 86_400 } as const)[match[2] as '' | 's' | 'm' | 'h' | 'd'];
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

export const MESSAGES_PATH = '/api/messages';
/**
 * Unauthenticated, and the only request this client makes without the fingerprint. It is how the
 * watcher tells "the hub is answering" from "something is answering", by BODY: the hub returns
 * `{"ok":true,"version":"<tag>"}`. A status code proves nothing — on 2026-09-28 a host-less
 * IngressRoute sent every `/api` to another app, which answered `/api/health` with 200.
 */
export const HEALTH_PATH = '/api/health';
export const AGENTS_PATH = '/api/agents';
export const LOG_PATH = '/api/log';

/** `packages/shared/src/identity.ts`. Lower case: Node lower-cases header names. */
export const FINGERPRINT_HEADER = 'x-hub-fingerprint';
export const AGENT_HEADER = 'x-hub-agent';

/**
 * The timeout ladder — `packages/shared/src/timeouts.ts`, roadmap R7:
 *
 * ```
 * Redis BLOCK 20s  <  server hold 25s  <  client abort 40s  <  ingress >= 60s
 * ```
 *
 * **The client must be the last to give up.** If it aborts before the server's
 * hold expires it retries into a hold that is still parked on Redis, and the
 * holds accumulate one per attempt per agent until something falls over. That is
 * why the abort is 40s for a 25s hold rather than the other way round, and why
 * `assertLadder` refuses a `--timeout` that would invert it instead of trusting
 * the server to clamp.
 */
export const SERVER_HOLD_MS = 25_000;
export const CLIENT_ABORT_MS = 40_000;

/** Everything that is not a long poll. Short: none of them wait on anything. */
export const REQUEST_TIMEOUT_MS = 15_000;

/**
 * The two bootstrap cursors, and the only two values a client ever invents
 * (`packages/shared/src/messages.ts`).
 *
 * `$` means "only what arrives from now on" and is right for a fresh watcher:
 * every line this prints is a notification that costs its agent context, so a
 * hundred days of history is the wrong housewarming gift. After the first call
 * the cursor is whatever the server last returned - sending `$` again is the bug
 * that makes Redis Streams behave like pub/sub.
 */
export const CURSOR_TAIL = '$';
export const CURSOR_START = '0';

/** `1:<inbox id>:<broadcast id>` — the server's `cursor.ts`. One token, two streams. */
const CURSOR_PATTERN = /^1:\d{1,20}(-\d{1,20})?:\d{1,20}(-\d{1,20})?$/;

/** Agent names end up inside Redis key names, so the charset is fixed. */
export const AGENT_NAME_PATTERN = /^[a-z0-9-]{1,40}$/;
export const MESSAGE_KIND_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/;
export const CORRELATION_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

/** `to: "*"` is a broadcast: one write every listener reads with its own cursor. */
export const BROADCAST_TARGET = '*';

export const MAX_MESSAGE_BODY_BYTES = 8192;
export const MAX_STATUS_BYTES = 500;
export const DEFAULT_LOG_LIMIT = 50;
export const MAX_LOG_LIMIT = 200;

/**
 * The kind the hub broadcasts when a new client version lands (roadmap R13).
 *
 * A long-lived listener runs the code it loaded at startup, and nothing tells
 * anyone it is stale - that cost two duplicate bug reports on 2026-09-25. The hub
 * is its own update channel: this kind means "pull, rebuild, restart me", and the
 * watcher prints it far more loudly than an ordinary message.
 */
export const RESTART_KIND = 'restart';

/** Where the console lives, for the approval instruction. */
export const DEFAULT_HUB_ORIGIN = 'https://hub.example.com';

export type MessageStream = 'inbox' | 'broadcast';

export interface HubMessage {
  /**
   * The Redis stream id, `<ms>-<seq>`.
   *
   * **Dedupe on `(stream, id)`, never on `id` alone.** Redis keeps the sequence
   * counter per stream, so an inbox entry and a broadcast written in the same
   * millisecond are both `<ms>-0`; a client keyed on the id would silently drop
   * one of two real messages, and only under load.
   */
  id: string;
  stream: MessageStream;
  from: string;
  /** The recipient, or `*` for a broadcast. */
  to: string;
  kind: string;
  body: string;
  /** Server-assigned epoch ms. Never the sender's clock. */
  ts: number;
  corr?: string;
}

export interface MessagesResponse {
  messages: HubMessage[];
  /** Always concrete: never `$`, never empty. Persist it even for an empty batch. */
  cursor: string;
  waitedMs: number;
}

export interface SendResponse {
  id: string;
  to: string;
  ts: number;
  /**
   * ISSUE-84: the send worked, but something about OUR OWN name is wrong. Only the hub can know this — an
   * archived sender looks entirely healthy from here, which is how four messages once went out under a dead
   * name and every one of them returned an id. Printed, never swallowed.
   */
  warning: string | null;
}

export type AgentState = 'live' | 'idle' | 'offline';

export interface AgentPresence {
  agent: string;
  state: AgentState;
  lastSeen: number | null;
  status: string | null;
  label: string | null;
  host: string | null;
  pid: number | null;
  clientVersion: string | null;
  anchor: string | null;
  machine: string | null;
  firstSeen: number;
  /** When the agent last stopped cleanly and nothing has polled since (hub ISSUE-94); null otherwise or on an older hub. */
  stoppedAt: number | null;
  /** Who wrote the current status line, when another agent did; null otherwise or on an older hub. */
  statusBy: string | null;
}

/** The hub's answer to an archive (`forget`). `purgeAt` is when the sweeper deletes it unless restored. */
export interface ForgetResponse {
  agent: string;
  archived: boolean;
  purgeAt: number | null;
}

/** One preview row of a prune. */
export interface PruneCandidate {
  id: string;
  from: string;
  to: string;
  kind: string;
  ts: number;
  head: string;
  expired: boolean;
}

export interface PruneResponse {
  stream: string;
  candidates: PruneCandidate[];
  truncated: boolean;
  deleted: number;
  next?: string;
}

/** Who did what to whom: one entry of the hub's audit trail. */
export interface AuditEntry {
  id: string;
  actor: string;
  action: string;
  target: string;
  ts: number;
  detail: unknown;
}

/** The most messages one agent prune may remove (the hub's MAX_AGENT_PRUNE). */
export const MAX_AGENT_PRUNE = 100;

export interface RosterResponse {
  now: number;
  agents: AgentPresence[];
}

export interface StatusResponse {
  agent: string;
  status: string;
  ts: number;
}

export interface LogResponse {
  agent: string;
  /** Oldest first. */
  messages: HubMessage[];
}

/**
 * What `POST /api/agents/<old>/rename` answers — roadmap ISSUE-82a.
 *
 * Upstream this belongs in `packages/shared/src/agents.ts`, and unlike the console's
 * `AgentForgetResponse` it has no reason to sit anywhere else: that one lives in
 * `console.ts` because it needs `ADMIN_AGENTS_ROUTE`, and `console.ts` already imports
 * `agents.ts`, so the other direction would be a cycle. A rename is an agent renaming
 * itself under `/api/agents`, whose route constant is in `agents.ts` already.
 *
 * `renamed` is a literal `true` rather than a boolean, and it is checked as one, the
 * same way the console checks `forgotten`. A body saying anything else would mean the
 * server changed its contract, and this is the one response where believing a rename
 * that did not happen has a lasting cost: the agent would stop the watch it still
 * owns, arm one on a name the hub has never heard of, and be unreachable under both.
 */
export interface RenameResponse {
  /** The name that was renamed — the caller's own. */
  from: string;
  to: string;
  renamed: true;
  /** The server's clock, like every other response here. */
  ts: number;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * The machine is not approved (or no longer is).
 *
 * The server answers **one byte-identical 403** for unknown, pending, revoked,
 * rate-limited and malformed, on purpose: an unapproved caller must not be able
 * to tell those apart, or a guess becomes an oracle. So this error cannot say
 * which one it is either — the watcher decides from its own history, which is the
 * only place that fact can live without handing it to the internet too.
 */
export class HubNotApprovedError extends Error {
  readonly pollAfterMs: number;

  constructor(pollAfterMs: number) {
    super('This machine is not approved for the hub yet.');
    this.name = 'HubNotApprovedError';
    this.pollAfterMs = pollAfterMs;
  }
}

/**
 * Retrying cannot fix this: a revoked identity, a wrong agent name, a URL that is
 * not the hub API. A watcher stops for one of these and for nothing else.
 */
export class HubPermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HubPermanentError';
  }
}

/** The server refused our cursor. Handled by re-baselining, loudly — never silently. */
export class HubCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HubCursorError';
  }
}

/** Anything worth another attempt: 5xx, 429, a dropped socket, a timeout. */
/**
 * The name this watcher polls under was renamed, and the hub says what to.
 *
 * Its own class because the watcher must **stop** rather than retry. Before this, a `410` fell into the
 * transient bucket and a watcher on the old name retried with backoff forever — the fourth and last
 * symptom of `AGENT_HUB_AGENT` being fixed at launch, and the most wasteful: it polls a name that will
 * never answer again, for as long as the session lives.
 *
 * `to` is carried rather than only printed, so a caller can act on it without re-parsing a message.
 */
export class HubRenamedError extends Error {
  constructor(readonly from: string, readonly to: string, readonly detail: string) {
    super(detail);
    this.name = 'HubRenamedError';
  }
}

/**
 * ISSUE-91: the hub refuses a name whose archive marker it cannot read, on every path, until an operator clicks
 * Restore in the console (owner's decision, option B). `agent` is the name the refusal is about, which for a
 * send is the RECIPIENT rather than the caller.
 */
export class HubArchiveUnreadableError extends Error {
  constructor(readonly agent: string, readonly detail: string) {
    super(detail);
    this.name = 'HubArchiveUnreadableError';
  }
}

export class HubTransientError extends Error {
  readonly status: number | null;
  readonly retryAfterMs: number | null;

  constructor(message: string, status: number | null = null, retryAfterMs: number | null = null) {
    super(message);
    this.name = 'HubTransientError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Something other than the hub answered an `/api` request (ISSUE-92).
 *
 * Covers every status, not only 404 (Codex review, round 1): the same capture could as well have
 * answered 503 from the ingress, 401 from a basic-auth middleware, a 403 page, or a redirect. What
 * matters is whether the hub wrote the answer, not which status it carries.
 *
 * Transient, because the configured URL is almost certainly right: what changed is a route in front
 * of the hub. On 2026-09-28 a host-less IngressRoute captured `/api` on every host for twelve minutes.
 * The 404 that app returned was classed as permanent here, with a message blaming the hub URL, so
 * every watcher in the fleet exited and its supervisor respawned it every two seconds, re-sending the
 * machine fingerprint to that app each time. A watcher that meets this error stops sending the
 * fingerprint and waits for `/api/health` to answer as the hub (`HubClient.probeHub`).
 *
 * How it is recognised: every error the hub itself returns is JSON carrying an `error` code, and every
 * success is JSON this client can parse. Anything else did not come from the hub.
 */
export class HubNotHubError extends HubTransientError {
  /**
   * The ingress answered that no hub pod is ready (a deploy or restart). The request never reached the hub, so
   * repeating it cannot do anything twice: this is the one failure a send may safely retry.
   */
  readonly notReady: boolean;
  constructor(path: string, status: number | null, what: string, retryAfterMs: number | null = null, noBackend = false) {
    super(
      noBackend
        // The route is right and nothing is wrong with it: the hub is restarting. Said as exactly that.
        ? `the hub is not ready on ${path} (HTTP ${status ?? '?'}): ${what}. Retrying without sending this machine's ` +
          'credential until /api/health answers as the hub.'
        : `something other than the hub answered ${path} (${status === null ? '' : `HTTP ${status}, `}${what}). ` +
          'The hub URL is probably fine: a route in front of the hub is sending /api somewhere else. ' +
          'Nothing carrying this machine\'s credential is sent until /api/health answers as the hub.',
      status,
      retryAfterMs,
    );
    this.name = 'HubNotHubError';
    this.notReady = noBackend;
  }
}

/** The first characters of a body, flattened, for naming what answered without quoting all of it. */
function bodyHead(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat === '') return 'empty body';
  return `body: ${flat.length <= max ? flat : `${flat.slice(0, max)}…`}`;
}

// ---------------------------------------------------------------------------
// URL handling
// ---------------------------------------------------------------------------

/**
 * Normalise a configured hub URL to its origin.
 *
 * The public route is `hub.example.com/api/` → API and `/` → console
 * (roadmap D11), so "the hub URL" is ambiguous in exactly one way: half the time
 * someone will paste the `/api` form. Both are accepted and reduced to the
 * origin, because every path here is built from the upstream route constants,
 * which already start with `/api`. Getting this wrong produces `/api/api/messages`
 * and a 404 that looks like a broken deployment.
 */
export function hubOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new HubPermanentError(`Not a valid hub URL: ${JSON.stringify(raw)}. Expected something like ${DEFAULT_HUB_ORIGIN}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HubPermanentError(`The hub URL must be http or https, got ${url.protocol}`);
  }
  const path = url.pathname.replace(/\/+$/, '');
  // Only a trailing `/api` is stripped. A deeper path is left alone and will fail
  // loudly on the first request rather than being silently "fixed" into something
  // the operator did not configure.
  const base = path === '/api' ? '' : path;
  return `${url.protocol}//${url.host}${base}`;
}

/** The console's address, for the approval instruction: the origin without `/api`. */
export function consoleUrl(origin: string): string {
  return `${origin.replace(/\/+$/, '')}/`;
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export interface HubClientOptions {
  /** Origin or `<origin>/api`; normalised either way. */
  baseUrl: string;
  agent: string;
  /** 43 base64url characters. Never logged, never printed, never in a URL. */
  fingerprint: string;
  /** Sent on every poll so the hub can tell a stale listener it is stale (R13). */
  clientVersion?: string;
  /** Which rung produced the machine anchor — the name, never the anchor itself. */
  anchorRung?: string;
  label?: string;
  /** How long a request waits out a hub restart (default HubClient.NOT_READY_RETRY_MS); tests shorten it. */
  notReadyRetryMs?: number;
  host?: string | null;
  pid?: number;
  /** Injected by the tests; the real one is Node's global `fetch`. */
  fetchImpl?: typeof fetch;
}

interface RequestOptions {
  method: 'GET' | 'POST' | 'PUT';
  path: string;
  /** Retry while the hub is restarting (see HubNotHubError.notReady). Off for the long poll, which has its own loop. */
  retryNotReady?: boolean;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  timeoutMs?: number;
}

export class HubClient {
  readonly origin: string;
  readonly agent: string;
  private readonly fingerprint: string;
  private readonly options: HubClientOptions;
  private readonly fetchImpl: typeof fetch;
  /**
   * Set while something other than the hub is known to answer /api. Every request that carries the fingerprint is
   * then refused BEFORE it is sent - whoever calls, from wherever - and only the credential-free `probeHub()` goes
   * out. One gate here instead of a guard at each call site, so a new call site cannot leak the credential.
   */
  private credentialHeld = false;

  constructor(options: HubClientOptions) {
    this.origin = hubOrigin(options.baseUrl);
    this.agent = options.agent;
    this.fingerprint = options.fingerprint;
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;

    if (!FINGERPRINT_PATTERN.test(options.fingerprint)) {
      // A truncated or hand-copied credential would otherwise produce the same
      // opaque 403 an unapproved machine gets, and be debugged as an approval
      // problem. The server length-checks the same pattern before hashing.
      throw new HubPermanentError(
        'The machine fingerprint is not 43 base64url characters. It is derived, never typed: ' +
        'delete nothing and check ~/.config/ai-hub/machine.key is 32 bytes, mode 0600.'
      );
    }
    if (!AGENT_NAME_PATTERN.test(options.agent)) {
      // Locally, so the failure names the rule. The server answers `invalid_agent`
      // with no pattern in it, deliberately: it must not describe its own charset
      // to an unapproved caller.
      throw new HubPermanentError(
        `Invalid agent name ${JSON.stringify(options.agent)}: use 1-40 characters of a-z, 0-9 and "-".`
      );
    }
  }

  /**
   * Strip the credential from anything about to be shown or thrown.
   *
   * One redaction point, like `TelegramBotService.redact`. The fingerprint is
   * never put into a URL or a body, so this should have nothing to do — which is
   * precisely why it is cheap to guarantee rather than to reason about.
   */
  private redact(text: string): string {
    return text.split(this.fingerprint).join('<fingerprint redacted>');
  }

  /**
   * Is the hub itself answering `/api`? Judged by BODY, and sent WITHOUT the fingerprint.
   *
   * The watcher calls this instead of retrying a real request after `HubNotHubError`, so a route that
   * sends `/api` to another app receives no credential however long it lasts. Never throws: a probe
   * that fails is just "not yet".
   */
  /** Hold, or release, every fingerprint-carrying request (see `credentialHeld`). */
  holdCredential(held: boolean): void {
    this.credentialHeld = held;
  }

  /** Thrown instead of sending, while the credential is held. */
  private refuseWhileHeld(path: string): void {
    if (this.credentialHeld) {
      throw new HubNotHubError(path, null, 'not sent: something other than the hub answered /api, and it is not verified again yet');
    }
  }

  async probeHub(
    timeoutMs: number = REQUEST_TIMEOUT_MS,
  ): Promise<{ hub: boolean; detail: string; retryAfterMs?: number | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.origin}${HEALTH_PATH}`, {
        method: 'GET',
        signal: controller.signal,
        // The same refusal as every other request: a probe that followed a redirect would be judging
        // whatever it was sent to.
        redirect: 'error',
      });
      const text = await response.text();
      const record = jsonRecord(text);
      const hub = response.status === 200
        && record?.['ok'] === true
        && typeof record['version'] === 'string'
        && (record['version'] as string).length > 0;
      // A rate-limited probe says when to come back, and probing sooner only earns another 429 — from a
      // limiter that may extend its cooldown for it (Codex review, round 3).
      return {
        hub,
        detail: `HTTP ${response.status}, ${bodyHead(this.redact(text))}`,
        retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
      };
    } catch (err) {
      const error = err as Error;
      const detail = error.name === 'AbortError'
        ? `no response within ${Math.round(timeoutMs / 1000)}s`
        : `${this.redact(error.message)}${causeText(error, (text) => this.redact(text))}`;
      return { hub: false, detail };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A hub deploy or restart is ~30-90 s with no hub pod (one replica, `Recreate`), and a send made then used to fail
   * outright: a track's reply to Davron simply did not go (Davron chose this fix, 2026-10-06). While the ingress
   * says no hub pod is ready, the request has provably not reached the hub, so it is repeated for up to this long.
   */
  static readonly NOT_READY_RETRY_MS = 90_000;

  private async request<T>(opts: RequestOptions, parse: (payload: unknown) => T): Promise<T> {
    const deadline = Date.now() + (this.options.notReadyRetryMs ?? HubClient.NOT_READY_RETRY_MS);
    for (let attempt = 0; ; attempt += 1) {
      // A retry gets only what is left of the window, so the whole call never outlives it by a request timeout.
      const remaining = deadline - Date.now();
      const attemptOpts = attempt === 0 ? opts : { ...opts, timeoutMs: Math.min(opts.timeoutMs ?? REQUEST_TIMEOUT_MS, remaining) };
      try {
        return await this.requestOnce(attemptOpts, parse);
      } catch (error) {
        const restarting = error instanceof HubNotHubError && error.notReady && opts.retryNotReady !== false;
        if (!restarting) throw error;
        const waitMs = Math.min(2_000 * 2 ** attempt, 10_000);
        // Retry only if, after the pause, at least a second of the window is left to try in.
        if (Date.now() + waitMs > deadline - 1_000) throw error;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
  }

  private async requestOnce<T>(opts: RequestOptions, parse: (payload: unknown) => T): Promise<T> {
    this.refuseWhileHeld(opts.path);
    const url = new URL(`${this.origin}${opts.path}`);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    }

    const controller = new AbortController();
    const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    let text: string;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: opts.method,
        headers: {
          [FINGERPRINT_HEADER]: this.fingerprint,
          [AGENT_HEADER]: this.agent,
          ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
        // **Not `follow`, which is the default.** `fetch` strips `Authorization` on a
        // cross-origin redirect but keeps every OTHER header, and the fingerprint is
        // deliberately not in `Authorization` (roadmap R8) - so a 302 from anything in
        // front of the hub would hand this machine's credential to another origin.
        // Verified on this Node build: the second origin received the header in full.
        // The hub API never redirects, so refusing is free and a redirect is a
        // misconfiguration worth reporting rather than following.
        redirect: 'error',
      });
      // Read inside the guarded region. A response whose headers arrive and whose
      // body then stalls would otherwise hang for ever - the same bug the bot
      // client had when it cleared the timer as soon as `fetch` resolved.
      text = await response.text();
    } catch (err) {
      const error = err as Error;
      // `fetch` reports every network failure as the same "fetch failed", and puts
      // the useful part in `cause`. An outage log that cannot tell ECONNREFUSED from
      // ENOTFOUND from an expired certificate is a log nobody can act on.
      // The reason lives in `cause`, not in the message: `fetch` reports a refused
      // redirect as the same "fetch failed" it reports a dead socket as, with
      // `cause: "unexpected redirect"` behind it. Verified on this Node build.
      const detailText = `${this.redact(error.message)}${causeText(error, (text) => this.redact(text))}`;
      if (/redirect/i.test(detailText)) {
        // Never followed: the fingerprint header would be forwarded to the redirect target. The hub
        // never redirects, so something else is answering — a route in front of the hub, like any
        // other foreign answer. The watcher waits it out WITHOUT the credential rather than exiting
        // and being respawned to send it again (ISSUE-92; this used to be permanent).
        throw new HubNotHubError(
          opts.path, null,
          `a redirect, which this client refuses to follow because it would forward the credential; ` +
          `if it persists, check --url is the hub API itself (currently ${this.origin})`,
        );
      }
      const detail = error.name === 'AbortError'
        ? `no response within ${Math.round(timeoutMs / 1000)}s`
        : detailText;
      throw new HubTransientError(this.redact(`${opts.method} ${opts.path} failed: ${detail}`));
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw this.failure(response, text, opts);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new HubNotHubError(opts.path, response.status, `not JSON, ${bodyHead(this.redact(text))}`);
    }
    try {
      return parse(payload);
    } catch (err) {
      // A response this client cannot read is not a reason to advance anything.
      // Either another app answered with JSON of its own, or this client and the hub disagree about
      // the contract. The health probe tells those apart; retrying blind cannot.
      // Redacted BEFORE `bodyHead` cuts it: truncating first can leave 42 of the credential's 43
      // characters, which no longer match the redaction (Codex review, round 1).
      throw new HubNotHubError(
        opts.path, response.status,
        `unexpected JSON: ${this.redact((err as Error).message)}; ${bodyHead(this.redact(text))}`,
      );
    }
  }

  /** Turn a non-2xx into the narrowest error that fits, because the watcher branches on the type. */
  private failure(response: Response, text: string, opts: RequestOptions): Error {
    // Redacted once, here, and every branch below truncates the REDACTED copy. The
    // other order is a real leak: `snippet` cuts at 200 characters, so a body that
    // reflected the fingerprint at offset 158 would come back with 42 of its 43
    // characters intact and no longer matching the redaction.
    const safe = this.redact(text);
    const record = jsonRecord(text);
    // Redacted at extraction, because it is interpolated into messages below and is server-controlled:
    // a body of `{"error":"<fingerprint>"}` would otherwise print the credential whole.
    const code = typeof record?.['error'] === 'string' ? this.redact(record['error'] as string) : undefined;
    // Every error the hub itself writes is a JSON object with a string `error`, or the one 403 body that
    // says `{"status":"pending"}`. Anything else was written by something in front of it — including JSON
    // with some other `status`, which a foreign app can easily send (Codex review, round 2).
    const pending = response.status === 403 && record?.['status'] === 'pending';
    const fromHub = code !== undefined || pending;
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));

    if (response.status === 410 && code === 'renamed') {
      // ISSUE-82: the successor is the whole point of the redirect, so refusing to parse it would
      // leave the caller knowing only that something is wrong.
      // Names are checked against the agent-name rule, not just read: they are printed and pasted into a
      // command, and a reflected header in them would put the credential on stdout (Codex review, round 2).
      const name = (field: string): string => {
        const value = record?.[field];
        return typeof value === 'string' && AGENT_NAME_PATTERN.test(value) ? value : '';
      };
      const to = name('to');
      const from = name('from');
      const detail = typeof record?.['detail'] === 'string' ? this.redact(record['detail'] as string) : '';
      if (to) {
        return new HubRenamedError(from, to, detail || `"${from}" was renamed to "${to}".`);
      }
    }
    if (pending) {
      const wait = record['poll_after_ms'];
      return new HubNotApprovedError(typeof wait === 'number' && wait > 0 ? wait : 15_000);
    }
    if (response.status === 413 && opts.body !== undefined) {
      // Before the hub-shape rule, and only for a request that HAS a body: too large is too large, and
      // retrying the same body cannot change it. A 413 to a bodyless poll cannot be about this request,
      // so it falls to the rule below like any other foreign answer (Codex review, round 2).
      return new HubPermanentError(`${opts.path} refused the request as too large: ${snippet(safe)}`);
    }
    if (response.status === 401 && !fromHub) {
      // The hub never answers 401 (an unapproved machine gets 403). This is basic auth in front of it:
      // either the basic-auth middleware on the /api route, which strips the fingerprint header
      // (roadmap R8, D11), or another app answering /api. Waited out without the credential, not exited.
      return new HubNotHubError(
        opts.path, 401,
        `a basic-auth challenge (${snippet(this.redact(response.headers.get('www-authenticate') ?? 'no challenge'))}); ` +
        'if it persists, the /api route carries the basic-auth middleware, which strips the fingerprint header (roadmap R8)',
      );
    }
    if (!fromHub && response.status === 503 && /no available server/i.test(text)) {
      // Traefik's own answer when the hub's route exists but no hub pod is ready: a deploy or a restart (the
      // server runs one replica, `strategy: Recreate`, so each deploy is ~30-90s of this). Named as such, so
      // nobody goes hunting a misrouted /api the way last night's outage taught everyone to (office-cluster).
      return new HubNotHubError(
        opts.path, 503,
        'the hub route is up but no hub server is ready yet, most likely a deploy or restart in progress',
        retryAfterMs,
        true,
      );
    }
    if (!fromHub) {
      // Every other status: a 404 or 403 page, an ingress 502/503/504, the ingress's rate limit, anything.
      // "Check your URL" sent people editing a config that was correct (ISSUE-92). A 429 is included: the
      // house rate limit is the ingress's middleware, not the hub, and its Retry-After is carried so the
      // wait honours it — but whoever wrote it is not proven to be ours, so it is waited out without
      // the credential too.
      return new HubNotHubError(opts.path, response.status, bodyHead(safe), retryAfterMs);
    }
    if (response.status === 429) {
      return new HubTransientError(`the hub is rate limiting this machine`, 429, retryAfterMs);
    }
    if (response.status === 400 && code === 'invalid_cursor') {
      const detail = typeof record?.['detail'] === 'string' ? `: ${snippet(this.redact(record['detail'] as string))}` : '';
      // Redacted like every other message built from a response: these two branches
      // interpolate server-controlled text, and a reflected header would otherwise
      // put the credential on the watcher's stdout.
      return new HubCursorError(`the hub refused the stored cursor${detail}`);
    }
    if (response.status === 400 && (code === 'agent_required' || code === 'invalid_agent')) {
      return new HubPermanentError(
        `The hub rejected the agent name ${JSON.stringify(this.agent)} (${code}). Use 1-40 characters of a-z, 0-9 and "-".`
      );
    }
    if (response.status === 404 && code === 'unknown_agent') {
      return new HubPermanentError(
        'The hub has no such agent. An agent exists once it has armed its watcher (`hub watch`), ' +
        'so check the name and that the other session has started one.'
      );
    }
    if (response.status === 404) {
      return new HubPermanentError(
        `${opts.path} answered 404 from the hub itself (${code}): this client and the hub disagree about the API. ` +
        `Update claude-tools, or check the hub URL (${this.origin}) is the hub's API origin.`
      );
    }
    if (response.status === 423 && code === 'archive_unreadable') {
      // Its own branch, ahead of the generic ones. It must not be read as the 409 rename conflict — that stops
      // the watcher — and it is not transient either: nothing but an operator's Restore changes the answer.
      const agent = typeof record?.['agent'] === 'string' ? (record['agent'] as string) : this.agent;
      const detail = typeof record?.['detail'] === 'string'
        ? this.redact(record['detail'] as string)
        : `"${agent}" has an archive record the hub cannot read; an operator must restore it with POST /api/admin/agents/${agent}/restore (the console has no Restore control yet).`;
      return new HubArchiveUnreadableError(agent, detail);
    }
    if (response.status === 409 && code !== 'topic_taken') {
      // A rename (ISSUE-82a); a topic link's 409 says its own reason and takes the general branch below.: the new name already exists, or the name
      // being renamed is not this caller's own. Permanent, because a retry sends the
      // same two names to the same hub — and it must not land in the transient bucket,
      // where `hub rename` would sit in a backoff loop over a decision the agent has to
      // take. The server's own code is quoted rather than branched on: the contract
      // fixes the status and the two reasons, not the string that names them.
      return new HubPermanentError(
        `${opts.path} answered 409${code === undefined ? `: ${snippet(safe)}` : ` (${code})`}. ` +
        'Either the new name is already on the hub, or the name being renamed is not this machine\'s own agent. ' +
        '`hub roster` shows which.'
      );
    }
    if (response.status >= 400 && response.status < 500) {
      // Any other refusal the hub itself wrote (a JSON `error`): a topic guard's `topic_not_yours`, a reserved
      // name, an invalid body. The same request gets the same answer, so it is permanent, not something a loop
      // should retry; the hub's `detail` says why.
      const detail = typeof record?.['detail'] === 'string' ? `: ${snippet(this.redact(record['detail'] as string))}` : '';
      return new HubPermanentError(`${opts.path} was refused by the hub (${response.status} ${code})${detail}`);
    }
    return new HubTransientError(`${opts.path} answered ${response.status}: ${snippet(safe)}`, response.status);
  }

  /**
   * One long poll. **This is also the registration** (roadmap D2): arming the
   * watcher is what puts the agent on the roster, and the metadata rides along on
   * the query string because there is no separate register call to carry it.
   *
   * The machine is not among that metadata: the server fills it in from the
   * verified fingerprint, so an agent cannot declare which machine it is on.
   */
  async poll(opts: { after: string; waitMs?: number; timeoutMs?: number } = { after: CURSOR_TAIL }): Promise<MessagesResponse> {
    const waitMs = Math.min(opts.waitMs ?? SERVER_HOLD_MS, SERVER_HOLD_MS);
    const timeoutMs = opts.timeoutMs ?? CLIENT_ABORT_MS;
    // The wire carries SECONDS, so the ladder has to be checked against the rounded
    // value rather than the requested one: 24.6s rounds up to a 25s hold, and a 24.7s
    // abort would then fire inside it.
    const waitSeconds = Math.round(waitMs / 1000);
    assertLadder(waitSeconds * 1000, timeoutMs);

    return this.request<MessagesResponse>(
      {
        method: 'GET',
        path: MESSAGES_PATH,
        // The watcher's loop already waits a restart out, and reports it; a silent retry here would hide it.
        retryNotReady: false,
        timeoutMs,
        query: {
          after: opts.after,
          // Seconds, which is what the server parses; it clamps to its own hold.
          wait: waitSeconds,
          label: this.options.label,
          host: this.options.host === null ? undefined : (this.options.host ?? hostname()),
          pid: this.options.pid ?? process.pid,
          clientVersion: this.options.clientVersion,
          anchor: this.options.anchorRung,
        },
      },
      parseMessagesResponse
    );
  }

  async send(message: { to: string; body: string; kind?: string; corr?: string; ttlSeconds?: number }): Promise<SendResponse> {
    const to = message.to;
    if (to !== BROADCAST_TARGET && !AGENT_NAME_PATTERN.test(to)) {
      throw new HubPermanentError(`Invalid recipient ${JSON.stringify(to)}: an agent name, or "*" for everyone.`);
    }
    if (message.body.length === 0) {
      throw new HubPermanentError('Nothing to send: the message body is empty.');
    }
    const bytes = Buffer.byteLength(message.body, 'utf-8');
    if (bytes > MAX_MESSAGE_BODY_BYTES) {
      // Checked here so the operator is told the size, rather than being handed a
      // 413 after the whole body has gone over the wire.
      throw new HubPermanentError(
        `The message is ${bytes} bytes; the hub caps one message at ${MAX_MESSAGE_BODY_BYTES}. Send a summary and a path, not a file.`
      );
    }
    if (message.kind !== undefined && !MESSAGE_KIND_PATTERN.test(message.kind)) {
      throw new HubPermanentError(`Invalid --kind ${JSON.stringify(message.kind)}: lower-case letters, digits, ".", "_" and "-".`);
    }
    if (message.ttlSeconds !== undefined
      && (!Number.isInteger(message.ttlSeconds) || message.ttlSeconds < 1 || message.ttlSeconds > MAX_MESSAGE_TTL_SECONDS)) {
      throw new HubPermanentError(`Invalid --ttl: between 1 second and ${MAX_MESSAGE_TTL_SECONDS / 86_400} days.`);
    }
    if (message.corr !== undefined && !CORRELATION_PATTERN.test(message.corr)) {
      throw new HubPermanentError(`Invalid --corr ${JSON.stringify(message.corr)}: up to 64 characters of A-Z a-z 0-9 . _ : -`);
    }

    return this.request<SendResponse>(
      {
        method: 'POST',
        path: MESSAGES_PATH,
        body: {
          to,
          body: message.body,
          ...(message.kind === undefined ? {} : { kind: message.kind }),
          ...(message.corr === undefined ? {} : { corr: message.corr }),
          ...(message.ttlSeconds === undefined ? {} : { ttlSeconds: message.ttlSeconds }),
        },
      },
      parseSendResponse
    );
  }

  /**
   * Set a status line: this agent's own by default, or another agent's. Any agent may set any agent's line; the
   * hub marks who wrote it on the roster and in its audit trail.
   */
  async setStatus(status: string, target: string = this.agent): Promise<StatusResponse> {
    const bytes = Buffer.byteLength(status, 'utf-8');
    if (bytes > MAX_STATUS_BYTES) {
      throw new HubPermanentError(`The status is ${bytes} bytes; the hub caps it at ${MAX_STATUS_BYTES}. It is one line, not a report.`);
    }
    requireAgentName(target);
    return this.request<StatusResponse>(
      { method: 'PUT', path: `${AGENTS_PATH}/${target}/status`, body: { status } },
      parseStatusResponse
    );
  }

  /** Archive an offline agent: off the roster now, deleted by the hub after 7 days unless restored. Audited. */
  async forget(target: string): Promise<ForgetResponse> {
    requireAgentName(target);
    return this.request<ForgetResponse>({ method: 'POST', path: `${AGENTS_PATH}/${target}/forget`, body: {} }, (payload) => {
      const record = requireRecord(payload, 'forget response');
      return { agent: requireString(record, 'agent', 'forget response'), archived: record['archived'] === true, purgeAt: optionalNumber(record, 'purgeAt') };
    });
  }

  /** Put an archived agent back on the roster. Audited. */
  async restore(target: string): Promise<{ agent: string; restored: boolean }> {
    requireAgentName(target);
    return this.request({ method: 'POST', path: `${AGENTS_PATH}/${target}/restore`, body: {} }, (payload) => {
      const record = requireRecord(payload, 'restore response');
      return { agent: requireString(record, 'agent', 'restore response'), restored: record['restored'] === true };
    });
  }

  /**
   * Preview (default) or confirm a prune of retained messages in one stream: an agent's inbox, or `*` for
   * broadcasts. A confirm removes exactly `ids` that still match the filter; the hub keeps copies for 7 days.
   */
  async prune(body: { stream: string; match?: string; before?: number; expiredOnly?: boolean; from?: string; ids?: string[]; confirm?: boolean }): Promise<PruneResponse> {
    return this.request<PruneResponse>({ method: 'POST', path: '/api/messages/prune', body }, parsePruneResponse);
  }

  /** The audit trail, newest first. */
  async audit(limit: number): Promise<AuditEntry[]> {
    return this.request({ method: 'GET', path: '/api/audit', query: { limit } }, (payload) => {
      const record = requireRecord(payload, 'audit response');
      const rows = record['entries'];
      if (!Array.isArray(rows)) throw new Error('the audit response "entries" was not an array');
      return rows.map((row, index) => {
        const entry = requireRecord(row, `audit row ${index}`);
        return {
          id: requireString(entry, 'id', `audit row ${index}`),
          actor: requireString(entry, 'actor', `audit row ${index}`),
          action: requireString(entry, 'action', `audit row ${index}`),
          target: requireString(entry, 'target', `audit row ${index}`),
          ts: requireNumber(entry, 'ts', `audit row ${index}`),
          detail: entry['detail'] ?? null,
        };
      });
    });
  }

  /** The messages one agent prune removed, while the hub keeps them (7 days). */
  async auditCopies(id: string): Promise<HubMessage[]> {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new HubPermanentError(`Invalid copies id ${JSON.stringify(id)}: it is the UUID an audit entry names.`);
    return this.request({ method: 'GET', path: `/api/audit/${id}` }, (payload) =>
      parseMessageList(requireRecord(payload, 'copies response')['messages'], 'copies response'));
  }

  /**
   * Rename this agent (ISSUE-82). **An agent renames itself** — the subject is always the
   * caller, which is why the fingerprint is the whole authorisation and no operator
   * token appears anywhere near it.
   *
   * Both names are checked here before the request goes out. Not defensiveness: this is
   * the one call whose failure the caller may have to undo by hand, since the server
   * moves the status, the status log, the cursor mirror and the inbox, so a request that
   * was never going to be accepted is worth refusing while nothing has moved.
   */
  async rename(to: string): Promise<RenameResponse> {
    if (!AGENT_NAME_PATTERN.test(to)) {
      throw new HubPermanentError(
        `Invalid new name ${JSON.stringify(to)}: use 1-40 characters of a-z, 0-9 and "-". ` +
        'The name ends up inside a Redis key name, which is why the charset is fixed.'
      );
    }
    if (to === this.agent) {
      throw new HubPermanentError(`"${to}" is already this agent's name on the hub; nothing to rename.`);
    }
    const result = await this.request<RenameResponse>(
      { method: 'POST', path: `${AGENTS_PATH}/${this.agent}/rename`, body: { to } },
      parseRenameResponse
    );
    // The caller is the subject, so the echo can only be this agent's own name. A
    // mismatch would mean the hub moved something else, and the report built from it
    // would then tell the agent to stop a watch it does not own.
    if (result.from !== this.agent || result.to !== to) {
      throw new HubTransientError(
        `the hub answered a rename of "${result.from}" → "${result.to}", but this call renamed ` +
        `"${this.agent}" → "${to}". Nothing here can be trusted to have moved; check \`hub roster\`.`
      );
    }
    return result;
  }

  /**
   * One Bot API call made by the hub on this agent's behalf (bot broker). The hub holds the token, and in a routed
   * forum it lets the agent post only into its own topic. Returns Telegram's `result`.
   */
  async botCall(bot: string, method: string, params: unknown): Promise<unknown> {
    if (!/^[a-z0-9-]{1,32}$/.test(bot)) throw new HubPermanentError(`Invalid bot name ${JSON.stringify(bot)}.`);
    if (!/^[A-Za-z]{1,40}$/.test(method)) throw new HubPermanentError(`Invalid Bot API method ${JSON.stringify(method)}.`);
    return this.request({ method: 'POST', path: `/api/bots/${bot}/call/${method}`, body: params ?? {} }, (payload) => {
      const record = requireRecord(payload, 'bot call response');
      if (record['ok'] !== true) throw new Error(`the hub answered a bot call without ok: ${JSON.stringify(record).slice(0, 200)}`);
      return record['result'];
    });
  }

  /**
   * Link a forum topic to an agent on the hub, at once and without a route in the cluster config. Only the forum's
   * default agent may, and only a topic nothing names yet. `delivered` counts the messages written in the topic
   * before the link, which the hub held and has now handed to the agent.
   */
  async botTopicLink(bot: string, chatId: string, topic: number, agent: string): Promise<{ topic: number; agent: string; created: boolean; delivered: number }> {
    HubClient.assertTopicCall(bot, chatId, topic);
    if (!/^[a-z0-9-]{1,40}$/.test(agent)) throw new HubPermanentError(`Invalid agent name ${JSON.stringify(agent)}.`);
    return this.request({ method: 'POST', path: `/api/bots/${bot}/topics/link`, body: { chat_id: chatId, topic_id: topic, agent } }, (payload) => {
      const record = requireRecord(payload, 'topic link response');
      if (record['ok'] !== true) throw new Error(`the hub answered a topic link without ok: ${JSON.stringify(record).slice(0, 200)}`);
      return {
        topic: requireNumber(record, 'topic', 'topic link response'),
        agent: requireString(record, 'agent', 'topic link response'),
        created: record['created'] === true,
        delivered: requireNumber(record, 'delivered', 'topic link response'),
      };
    });
  }

  /** Remove a run-time topic link. Messages written in the topic afterwards are held again until it is linked. */
  async botTopicUnlink(bot: string, chatId: string, topic: number): Promise<{ removed: boolean }> {
    HubClient.assertTopicCall(bot, chatId, topic);
    return this.request({ method: 'POST', path: `/api/bots/${bot}/topics/unlink`, body: { chat_id: chatId, topic_id: topic } }, (payload) => {
      const record = requireRecord(payload, 'topic unlink response');
      if (record['ok'] !== true) throw new Error(`the hub answered a topic unlink without ok: ${JSON.stringify(record).slice(0, 200)}`);
      return { removed: record['removed'] === true };
    });
  }

  /** Every topic of a forum that has an agent: `route` from the cluster config, `link` made at run time. */
  async botTopics(bot: string, chatId: string): Promise<{ defaultAgent: string | null; topics: { topic: number; agent: string; source: 'route' | 'link' }[] }> {
    HubClient.assertTopicCall(bot, chatId, 2);
    return this.request({ method: 'GET', path: `/api/bots/${bot}/topics`, query: { chat_id: chatId } }, (payload) => {
      const record = requireRecord(payload, 'topics response');
      const list = record['topics'];
      if (!Array.isArray(list)) throw new Error('the topics response "topics" was not an array');
      return {
        defaultAgent: typeof record['defaultAgent'] === 'string' ? record['defaultAgent'] : null,
        topics: list.map((entry, index) => {
          const item = requireRecord(entry, `topic ${index}`);
          return {
            topic: requireNumber(item, 'topic', `topic ${index}`),
            agent: requireString(item, 'agent', `topic ${index}`),
            source: item['source'] === 'link' ? 'link' as const : 'route' as const,
          };
        }),
      };
    });
  }

  private static assertTopicCall(bot: string, chatId: string, topic: number): void {
    if (!/^[a-z0-9-]{1,32}$/.test(bot)) throw new HubPermanentError(`Invalid bot name ${JSON.stringify(bot)}.`);
    if (!/^-?\d{1,20}$/.test(chatId)) throw new HubPermanentError(`Invalid chat id ${JSON.stringify(chatId)}: a numeric chat id.`);
    if (!Number.isSafeInteger(topic) || topic < 2) throw new HubPermanentError(`Invalid topic id ${JSON.stringify(topic)}: a forum topic id, and not General.`);
  }

  /**
   * A file a bot received, fetched by the hub (GET /api/bots/<bot>/files/<fileId>), so the download runs on the
   * cluster's network path and needs no token on this machine. Returns the bytes; a refusal is permanent.
   */
  async botFile(bot: string, fileId: string, timeoutMs = 90_000): Promise<Buffer> {
    if (!/^[a-z0-9-]{1,32}$/.test(bot)) throw new HubPermanentError(`Invalid bot name ${JSON.stringify(bot)}.`);
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(fileId)) throw new HubPermanentError(`Invalid file id ${JSON.stringify(fileId)}.`);
    this.refuseWhileHeld(`/api/bots/${bot}/files`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.origin}/api/bots/${bot}/files/${encodeURIComponent(fileId)}`, {
        method: 'GET',
        headers: { [FINGERPRINT_HEADER]: this.fingerprint, [AGENT_HEADER]: this.agent },
        signal: controller.signal,
        // Never follow: a redirect would carry the fingerprint header to another origin (see request()).
        redirect: 'error',
      });
      const body = Buffer.from(await response.arrayBuffer());
      if (response.status !== 200) {
        const head = this.redact(body.toString('utf-8', 0, 300));
        const error = `${this.redact(`/api/bots/${bot}/files`)} answered ${response.status}: ${head}`;
        throw response.status >= 400 && response.status < 500 ? new HubPermanentError(error) : new HubTransientError(error, response.status);
      }
      return body;
    } catch (err) {
      if (err instanceof HubPermanentError || err instanceof HubTransientError) throw err;
      const error = err as Error;
      throw new HubTransientError(this.redact(error.name === 'AbortError'
        ? `the hub sent no file within ${Math.round(timeoutMs / 1000)}s`
        : `file download failed: ${error.message}`));
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A voice note sent by the hub on this agent's behalf (POST /api/bots/<bot>/voice): the audio is the raw body and
   * every other parameter is in the query string. In a routed forum the hub lets it go only into the agent's own
   * topic, so `message_thread_id` must name it. Returns Telegram's `result`.
   */
  async botVoice(bot: string, params: Readonly<Record<string, string | number>>, audio: Buffer, timeoutMs = 120_000): Promise<unknown> {
    if (!/^[a-z0-9-]{1,32}$/.test(bot)) throw new HubPermanentError(`Invalid bot name ${JSON.stringify(bot)}.`);
    this.refuseWhileHeld(`/api/bots/${bot}/voice`);
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) query.set(key, String(value));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.origin}/api/bots/${bot}/voice?${query.toString()}`, {
        method: 'POST',
        headers: { [FINGERPRINT_HEADER]: this.fingerprint, [AGENT_HEADER]: this.agent, 'content-type': 'audio/ogg' },
        body: new Uint8Array(audio),
        signal: controller.signal,
        // Never follow: a redirect would carry the fingerprint header to another origin (see request()).
        redirect: 'error',
      });
      const text = await response.text();
      // Classified exactly as request() classifies an answer, so one written by something other than the hub is a
      // HubNotHubError and the watcher quarantines on it (Codex review).
      const path = `/api/bots/${bot}/voice`;
      if (!response.ok) throw this.failure(response, text, { method: 'POST', path });
      let record: Record<string, unknown>;
      try {
        record = requireRecord(JSON.parse(text), 'bot voice response');
      } catch {
        throw new HubNotHubError(path, response.status, `not the hub's JSON, ${bodyHead(this.redact(text))}`);
      }
      if (record['ok'] !== true) throw new HubNotHubError(path, response.status, `unexpected JSON: ${bodyHead(this.redact(text))}`);
      return record['result'];
    } catch (err) {
      if (err instanceof HubPermanentError || err instanceof HubTransientError) throw err;
      const error = err as Error;
      if (/redirect/i.test(`${error.message}${causeText(error, (t) => this.redact(t))}`)) {
        // Refused, as request() refuses one: following it would forward the credential.
        throw new HubNotHubError(`/api/bots/${bot}/voice`, null, 'a redirect, which this client refuses to follow because it would forward the credential');
      }
      throw new HubTransientError(this.redact(error.name === 'AbortError'
        ? `the hub did not take the voice note within ${Math.round(timeoutMs / 1000)}s`
        : `voice upload failed: ${error.message}`));
    } finally {
      clearTimeout(timer);
    }
  }

  async roster(): Promise<RosterResponse> {
    return this.request<RosterResponse>({ method: 'GET', path: AGENTS_PATH }, parseRosterResponse);
  }

  async history(opts: { agent?: string; limit?: number } = {}): Promise<LogResponse> {
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? DEFAULT_LOG_LIMIT), 1), MAX_LOG_LIMIT);
    if (opts.agent !== undefined && !AGENT_NAME_PATTERN.test(opts.agent)) {
      throw new HubPermanentError(`Invalid --agent ${JSON.stringify(opts.agent)}: 1-40 characters of a-z, 0-9 and "-".`);
    }
    return this.request<LogResponse>(
      { method: 'GET', path: LOG_PATH, query: { agent: opts.agent, limit } },
      parseLogResponse
    );
  }
}

/**
 * The client's own half of roadmap R7, enforced rather than assumed.
 *
 * The server clamps the wait it is asked for, so an inverted ladder would not be
 * refused by anything else — it would just quietly produce an abort in the middle
 * of a live hold, one extra parked hold per retry, and a pile-up that only shows
 * up under load.
 */
export function assertLadder(waitMs: number, abortMs: number): void {
  // Finite and inside the timer's range, because `setTimeout` silently collapses
  // anything above 2^31-1 ms to about 1ms - so an `Infinity` abort would fire
  // immediately while passing a naive `abortMs > waitMs` comparison.
  const MAX_TIMER_MS = 2_147_483_647;
  if (!Number.isFinite(waitMs) || !Number.isFinite(abortMs) || abortMs > MAX_TIMER_MS) {
    throw new HubPermanentError(
      `Both timeouts must be finite and at most ${MAX_TIMER_MS}ms, got wait=${waitMs}ms abort=${abortMs}ms. ` +
      'setTimeout collapses a larger delay to ~1ms, which would abort inside the server hold.'
    );
  }
  // A zero wait is legitimate - it is how a caller drains whatever is already
  // queued without holding - so the requirement is only that the abort is strictly
  // later, and positive.
  if (waitMs < 0 || !(abortMs > 0) || !(abortMs > waitMs)) {
    throw new HubPermanentError(
      `The timeout ladder is inverted: the client must abort (${abortMs}ms) strictly after the server's hold (${waitMs}ms), ` +
      'or it retries into a hold that is still running. See roadmap R7.'
    );
  }
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function jsonRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * ` (ECONNREFUSED)` when `fetch` hid the real reason in `cause`, else nothing.
 *
 * `redact` is applied **before** the 120-character cut, not after. Redaction matches
 * the whole 43-character fingerprint, so truncating first could slice one character
 * off the front of a reflected credential and leave the other 42 in the log.
 */
function causeText(error: Error, redact: (text: string) => string): string {
  const cause = (error as { cause?: unknown }).cause;
  if (cause === undefined || cause === null) return '';
  const code = (cause as { code?: unknown }).code;
  if (typeof code === 'string') return ` (${redact(code)})`;
  const message = (cause as { message?: unknown }).message;
  return typeof message === 'string' && message.length > 0 ? ` (${redact(message).slice(0, 120)})` : '';
}

/** Error bodies are shown to a human, so they are bounded rather than trusted. */
function snippet(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= 200 ? flat : `${flat.slice(0, 200)}…`;
}

function requireRecord(payload: unknown, what: string): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error(`the ${what} was not a JSON object`);
  }
  return payload as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, field: string, what: string, allowEmpty = false): string {
  const value = record[field];
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new Error(`${what} "${field}" was ${JSON.stringify(value)}, expected a string`);
  }
  return value;
}

function requireNumber(record: Record<string, unknown>, field: string, what: string): number {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${what} "${field}" was ${JSON.stringify(value)}, expected a number`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  return typeof value === 'string' ? value : null;
}

function optionalNumber(record: Record<string, unknown>, field: string): number | null {
  const value = record[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseMessage(payload: unknown, index: number): HubMessage {
  const record = requireRecord(payload, `message ${index}`);
  const stream = requireString(record, 'stream', `message ${index}`);
  if (stream !== 'inbox' && stream !== 'broadcast') {
    throw new Error(`message ${index} came from an unknown stream ${JSON.stringify(stream)}`);
  }
  const corr = record['corr'];
  return {
    id: requireString(record, 'id', `message ${index}`),
    stream,
    from: requireString(record, 'from', `message ${index}`),
    to: requireString(record, 'to', `message ${index}`),
    kind: requireString(record, 'kind', `message ${index}`),
    body: requireString(record, 'body', `message ${index}`, true),
    ts: requireNumber(record, 'ts', `message ${index}`),
    ...(typeof corr === 'string' ? { corr } : {}),
  };
}

function parseMessageList(value: unknown, what: string): HubMessage[] {
  if (!Array.isArray(value)) throw new Error(`the ${what} "messages" was not an array`);
  return value.map((entry, index) => parseMessage(entry, index));
}

export function parseMessagesResponse(payload: unknown): MessagesResponse {
  const record = requireRecord(payload, 'poll response');
  const cursor = requireString(record, 'cursor', 'poll response');
  if (cursor === CURSOR_TAIL) {
    // A cursor the client cannot store would silently re-baseline the watcher on
    // the next poll, which is the one failure the server promises never to cause.
    throw new Error('the poll response returned "$" instead of a resolved cursor');
  }
  return {
    messages: parseMessageList(record['messages'], 'poll response'),
    cursor,
    waitedMs: requireNumber(record, 'waitedMs', 'poll response'),
  };
}

export function parseSendResponse(payload: unknown): SendResponse {
  const record = requireRecord(payload, 'send response');
  return {
    id: requireString(record, 'id', 'send response'),
    to: requireString(record, 'to', 'send response'),
    ts: requireNumber(record, 'ts', 'send response'),
    // Absent on every hub older than ISSUE-84, so this stays optional rather than becoming a parse error that
    // would stop a current client talking to a hub that has not been rolled out yet.
    warning: optionalString(record, 'warning'),
  };
}

export function parseStatusResponse(payload: unknown): StatusResponse {
  const record = requireRecord(payload, 'status response');
  return {
    agent: requireString(record, 'agent', 'status response'),
    status: requireString(record, 'status', 'status response', true),
    ts: requireNumber(record, 'ts', 'status response'),
  };
}

export function parseRenameResponse(payload: unknown): RenameResponse {
  const record = requireRecord(payload, 'rename response');
  // Checked first and checked literally: `from` and `to` could both be well-formed names
  // in a body that never says the move happened.
  if (record['renamed'] !== true) {
    throw new Error(`the rename response "renamed" was ${JSON.stringify(record['renamed'])}, expected true`);
  }
  return {
    from: requireString(record, 'from', 'rename response'),
    to: requireString(record, 'to', 'rename response'),
    renamed: true,
    ts: requireNumber(record, 'ts', 'rename response'),
  };
}

export function parseRosterResponse(payload: unknown): RosterResponse {
  const record = requireRecord(payload, 'roster response');
  const rows = record['agents'];
  if (!Array.isArray(rows)) throw new Error('the roster response "agents" was not an array');
  const agents: AgentPresence[] = rows.map((row, index) => {
    const entry = requireRecord(row, `roster row ${index}`);
    const state = requireString(entry, 'state', `roster row ${index}`);
    if (state !== 'live' && state !== 'idle' && state !== 'offline') {
      throw new Error(`roster row ${index} has an unknown state ${JSON.stringify(state)}`);
    }
    return {
      agent: requireString(entry, 'agent', `roster row ${index}`),
      state,
      lastSeen: optionalNumber(entry, 'lastSeen'),
      status: optionalString(entry, 'status'),
      label: optionalString(entry, 'label'),
      host: optionalString(entry, 'host'),
      pid: optionalNumber(entry, 'pid'),
      clientVersion: optionalString(entry, 'clientVersion'),
      anchor: optionalString(entry, 'anchor'),
      machine: optionalString(entry, 'machine'),
      firstSeen: requireNumber(entry, 'firstSeen', `roster row ${index}`),
      stoppedAt: optionalNumber(entry, 'stoppedAt'),
      statusBy: optionalString(entry, 'statusBy'),
    };
  });
  return { now: requireNumber(record, 'now', 'roster response'), agents };
}

export function parsePruneResponse(payload: unknown): PruneResponse {
  const record = requireRecord(payload, 'prune response');
  const rows = record['candidates'];
  if (!Array.isArray(rows)) throw new Error('the prune response "candidates" was not an array');
  const next = optionalString(record, 'next');
  return {
    stream: requireString(record, 'stream', 'prune response'),
    candidates: rows.map((row, index) => {
      const entry = requireRecord(row, `prune row ${index}`);
      return {
        id: requireString(entry, 'id', `prune row ${index}`),
        from: requireString(entry, 'from', `prune row ${index}`),
        to: requireString(entry, 'to', `prune row ${index}`),
        kind: requireString(entry, 'kind', `prune row ${index}`),
        ts: requireNumber(entry, 'ts', `prune row ${index}`),
        head: requireString(entry, 'head', `prune row ${index}`, true),
        expired: entry['expired'] === true,
      };
    }),
    truncated: record['truncated'] === true,
    deleted: requireNumber(record, 'deleted', 'prune response'),
    ...(next === null ? {} : { next }),
  };
}

function requireAgentName(name: string): void {
  if (!AGENT_NAME_PATTERN.test(name)) {
    throw new HubPermanentError(`Invalid agent name ${JSON.stringify(name)}: 1-40 characters of a-z, 0-9 and "-".`);
  }
}

export function parseLogResponse(payload: unknown): LogResponse {
  const record = requireRecord(payload, 'log response');
  return {
    agent: requireString(record, 'agent', 'log response'),
    messages: parseMessageList(record['messages'], 'log response'),
  };
}

// ---------------------------------------------------------------------------
// Local state: the cursor, and the log of what was delivered
// ---------------------------------------------------------------------------

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_');
}

export function hubStateDir(state: string): string {
  return join(getConfigDir(), 'hub', safeName(state));
}

/**
 * `~/.config/claude-tools/hub/<old>/renamed-to` — one line, the successor's name.
 *
 * Written by `hub rename` so the registration hook can follow a rename it had no way to see. The hook
 * resolves a session's name from `AGENT_HUB_AGENT`, which is fixed at launch and therefore still holds
 * the OLD name after a rename — so it kept telling a renamed agent to arm a watcher under the name it
 * had just left. That is not merely noise: an archived name un-archives itself on its next poll, so an
 * agent obeying the hook would resurrect the entry the rename had just archived and undo ISSUE-69.
 *
 * A file rather than a hub lookup on purpose: this hook runs on every prompt, and the rename is the one
 * moment both names are known for certain. No network, no staleness.
 */
export function hubRenamedToPath(state: string): string {
  return join(hubStateDir(state), 'renamed-to');
}

/**
 * Follow `renamed-to` markers to the name this agent answers to now.
 *
 * `AGENT_HUB_AGENT` is fixed when a session launches, so after a rename every fallback to it yields the
 * ARCHIVED name. That produced three separate symptoms before the cause was fixed in one place: the
 * registration hook told renamed agents to arm the old name (and an archived name un-archives itself on
 * poll, undoing ISSUE-69), a watcher on the old name retried its 410 forever, and — the one that reached
 * other agents — `hub send` stamped every message with the old name, so a renamed agent appeared on the
 * hub under a name that no longer exists.
 *
 * Bounded, because a hand-edited marker could form a cycle even though the server refuses a rename onto a
 * live or archived name. An absent or malformed marker means "this name is current", so the failure mode
 * is the unfixed behaviour rather than no behaviour.
 */
export function followRenames(agent: string, hops = 8): string {
  let current = agent;
  for (let hop = 0; hop < hops; hop += 1) {
    let next: string;
    try {
      next = readFileSync(hubRenamedToPath(current), 'utf-8').trim();
    } catch {
      return current;
    }
    if (!next || next === current || !/^[a-z0-9-]{1,40}$/.test(next)) return current;
    current = next;
  }
  return current;
}

export function hubCursorPath(state: string): string {
  return join(hubStateDir(state), 'cursor.json');
}

/** One JSON object per line, appended as messages arrive. */
export function hubLogPath(state: string): string {
  return join(hubStateDir(state), 'messages.jsonl');
}

// ---------------------------------------------------------------------------
// What this agent sent (#406)
// ---------------------------------------------------------------------------

/**
 * How long an identical send to the same recipient is refused as a resend.
 *
 * An hour covers the outage that caused #406 (twelve minutes) with room to spare, and is short enough
 * that a message deliberately repeated tomorrow is not blocked by one sent today.
 */
export const RESEND_WINDOW_MS = 60 * 60_000;

/**
 * One confirmed send. The body is kept only as a digest and a short head: the digest is what the
 * resend check compares, and the head is what `hub sent` shows a reader.
 */
export interface SentRecord {
  id: string;
  to: string;
  /** The hub's timestamp, for display. */
  ts: number;
  /**
   * When THIS machine got the confirmation. The resend window is measured on it, never on `ts`: the
   * server's clock can run behind or ahead of this one, which would expire a confirmation at once or
   * hold it for far longer than the hour (Codex review).
   */
  at: number;
  /** The hub it went to, so a record from another hub never counts as a send to this one. */
  hub: string;
  sha256: string;
  /** Part of what makes two sends the same message: a reply to another correlation id is a new one. */
  kind: string;
  corr: string;
  head: string;
  /** Local epoch ms after which the message is gone from the hub (ISSUE-96); absent: it never expires. */
  exp?: number;
}

/** What identifies a message for the resend check: everything that makes two sends different. */
export interface SendKey {
  to: string;
  body: string;
  kind?: string;
  corr?: string;
  /** Not part of the message's identity: only when the confirmation stops counting as a live send. */
  ttlSeconds?: number;
}

/** Records kept in the file. Older ones are pruned on write; the window only ever looks back an hour. */
const SENT_KEEP = 2_000;

/**
 * `~/.config/claude-tools/hub/<sender>/sent.jsonl`.
 *
 * #406: after the outage, sessions resent messages because nothing let them see what they had already
 * sent — `hub log` shows an agent its inbox, never its own sends — and a resend has a new id, so no
 * dedupe can catch it. Several sessions resent while fully understanding why they should not: "did that
 * land?" had no cheap answer. This file is that answer.
 */
export function hubSentPath(agent: string): string {
  return join(hubStateDir(agent), 'sent.jsonl');
}

export function bodyDigest(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/**
 * Append one confirmed send. Called only AFTER the hub returned an id: a record here means the hub
 * accepted the message, never that a send was merely attempted.
 */
export async function recordSent(
  agent: string,
  sent: { id: string; to: string; ts: number },
  key: SendKey,
  origin: string,
  now: number = Date.now(),
): Promise<void> {
  // One writer at a time per sender: sends of DIFFERENT messages take different send locks, but all of
  // them append to, and prune, this one file (Codex review: a prune could rename an older snapshot over
  // another send's fresh confirmation).
  await withProcessLock('sentlog', [hubSentPath(agent)], async () => appendSent(agent, sent, key, origin, now));
}

function appendSent(
  agent: string,
  sent: { id: string; to: string; ts: number },
  key: SendKey,
  origin: string,
  now: number,
): void {
  const path = hubSentPath(agent);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const flat = key.body.replace(/\s+/g, ' ').trim();
  const record: SentRecord = {
    id: sent.id,
    to: sent.to,
    ts: sent.ts,
    at: now,
    hub: origin,
    sha256: bodyDigest(key.body),
    kind: key.kind ?? '',
    corr: key.corr ?? '',
    // The same exposure as the watcher's own `messages.jsonl`, which keeps every received body whole at
    // the same permissions; hub bodies carry no credentials by rule. Kept because `hub sent` without it
    // would list ids nobody can match to a message.
    head: flat.length <= 80 ? flat : `${flat.slice(0, 80)}…`,
    ...(key.ttlSeconds === undefined ? {} : { exp: now + key.ttlSeconds * 1000 }),
  };
  const fd = openSync(path, 'a', 0o600);
  try {
    // A crash can leave the last record torn, with no newline. Appending onto it would fuse this record
    // with the fragment into one unreadable line, and the confirmation would be lost (Codex review).
    if (fstatSync(fd).size > 0 && !endsWithNewline(path)) writeAll(fd, '\n');
    writeAll(fd, `${JSON.stringify(record)}\n`);
  } finally {
    closeSync(fd);
  }
  pruneSent(path, now);
}

/**
 * Keep the file bounded once it grows past twice `SENT_KEEP` records: keep EVERY confirmation still
 * inside the resend window, however many, and the newest older ones up to `SENT_KEEP`. A count alone
 * could drop a confirmation made minutes ago (Codex review). Runs under the sender-log lock.
 */
function pruneSent(path: string, now: number): void {
  let lines: string[];
  try {
    lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '');
  } catch {
    return;
  }
  if (lines.length <= SENT_KEEP * 2) return;
  const recent = (line: string): boolean => {
    try {
      const at = (JSON.parse(line) as { at?: unknown }).at;
      return typeof at === 'number' && now - at <= RESEND_WINDOW_MS;
    } catch {
      return false;
    }
  };
  const older = lines.filter((l) => !recent(l)).slice(-SENT_KEEP);
  const keep = new Set([...older, ...lines.filter(recent)]);
  const kept = lines.filter((l) => keep.has(l));
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${kept.join('\n')}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Forget confirmed sends whose messages were pruned from the hub, so the resend check stops refusing them: a
 * record says "the hub has this", and after a prune that is no longer true. Matched by hub and id, so a prune of
 * one hub never touches another's records. Returns how many records were dropped. Written like `pruneSent`.
 */
export async function forgetSent(agent: string, origin: string, removed: readonly { readonly id: string; readonly to: string }[]): Promise<number> {
  // Under the same lock as a confirmed send's record, so a send confirmed in the same moment is not lost to this rewrite.
  return withProcessLock('sentlog', [hubSentPath(agent)], async () => forgetSentLocked(agent, origin, removed));
}

function forgetSentLocked(agent: string, origin: string, removed: readonly { readonly id: string; readonly to: string }[]): number {
  const path = hubSentPath(agent);
  if (removed.length === 0 || !existsSync(path)) return 0;
  // A stream id is unique only within its stream, so a record is matched by recipient AND id: an inbox entry and a
  // broadcast can share an id, and pruning one must not unprotect the other (Codex review).
  const gone = new Set(removed.map((r) => `${r.to}\u0000${r.id}`));
  const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '');
  const kept = lines.filter((line) => {
    try {
      const r = JSON.parse(line) as { hub?: unknown; id?: unknown; to?: unknown };
      return !(r.hub === origin && typeof r.id === 'string' && typeof r.to === 'string' && gone.has(`${r.to}\u0000${r.id}`));
    } catch {
      return true;
    }
  });
  if (kept.length === lines.length) return 0;
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, kept.length === 0 ? '' : `${kept.join('\n')}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  return lines.length - kept.length;
}

/** The most recent confirmed sends to `origin`, oldest first. A malformed line is skipped, not fatal. */
export function readSent(agent: string, limit: number, origin: string): SentRecord[] {
  return readAllSent(agent, origin).slice(-limit);
}

function readAllSent(agent: string, origin: string): SentRecord[] {
  const path = hubSentPath(agent);
  if (!existsSync(path)) return [];
  const records: SentRecord[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const r = JSON.parse(line) as SentRecord;
      if (r.hub === origin && typeof r.id === 'string' && typeof r.sha256 === 'string') records.push(r);
    } catch {
      // A torn last line from a crash; the rest of the record is still good.
    }
  }
  return records;
}

/**
 * The confirmed send this one would repeat, if one is recent: same hub, recipient, body, kind and
 * correlation, confirmed within the window by this machine's clock. Every record is searched, however
 * many were sent since.
 */
export function findRecentSend(
  agent: string,
  key: SendKey,
  origin: string,
  now: number = Date.now(),
  windowMs: number = RESEND_WINDOW_MS,
): SentRecord | undefined {
  const digest = bodyDigest(key.body);
  const kind = key.kind ?? '';
  const corr = key.corr ?? '';
  return readAllSent(agent, origin)
    .reverse()
    .find((r) => r.to === key.to && r.sha256 === digest && (r.kind ?? '') === kind && (r.corr ?? '') === corr
      && typeof r.at === 'number' && now - r.at >= 0 && now - r.at <= windowMs
      // An expired message is gone from the hub: sending it again is not a duplicate (Codex review).
      && (typeof r.exp !== 'number' || now < r.exp));
}

/**
 * Serialise sends of the same message by this agent on this machine: check, send and record happen
 * under one lock, so two sessions sending the same thing at once cannot both find no record and both
 * send. The lock is held by the kernel (see `withProcessLock`), so a holder that died releases it at once
 * and a slow live one is never mistaken for a dead one — which an age-based lock file allowed.
 */
export async function withSendLock<T>(agent: string, key: SendKey, origin: string, run: () => Promise<T>): Promise<T> {
  return withProcessLock(
    'send',
    [hubStateDir(agent), origin, key.to, key.kind ?? '', key.corr ?? '', bodyDigest(key.body)],
    run,
    REQUEST_TIMEOUT_MS * 3,
  );
}


export interface HubWatchState {
  /** The last cursor the server returned, or null for a fresh watcher. */
  cursor: string | null;
  /** Which agent this namespace belongs to. Two agents must not share a cursor. */
  agent: string | null;
  /**
   * Which hub the cursor is a position in.
   *
   * A stream id means nothing on a different server: pointing `--url` at a local
   * hub and back would otherwise submit a cursor from one to the other, which is
   * syntactically valid and skips whatever sits before that position. So an origin
   * change re-baselines rather than resuming, loudly.
   */
  origin: string | null;
  /** The machine label last seen on this state, for the re-enrolment notice. */
  machine: string | null;
  /**
   * When this machine was last approved, as far as this client knows.
   *
   * The whole point of storing it: the server's refusal is byte-identical for
   * pending and revoked, so "you were thrown out" versus "you were never let in"
   * can only be answered from the client's own history. Without this the watcher
   * would tell its user to go and approve a machine that the owner had just
   * deliberately revoked.
   */
  approvedAt: number | null;
}

/**
 * What may be WRITTEN back.
 *
 * `agent` is required here while it is nullable on the read side, and that is the
 * point: a caller that forgot to carry the agent name forward would store a cursor
 * with no owner, and the ownership check would then wave through a different
 * agent's watcher onto this one's inbox position. Making it a type error is cheaper
 * than remembering.
 */
export interface HubStateUpdate extends Omit<HubWatchState, 'agent' | 'origin'> {
  agent: string;
  origin: string;
}

const EMPTY_STATE: HubWatchState = { cursor: null, agent: null, origin: null, machine: null, approvedAt: null };

/** A cursor this client may submit: the server's own format, or nothing. */
export function isUsableCursor(value: unknown): value is string {
  return typeof value === 'string' && CURSOR_PATTERN.test(value);
}

/**
 * Read the stored cursor for a state namespace.
 *
 * A cursor belongs to one agent, because it is a position in *that agent's*
 * inbox. Submitting one agent's cursor for another would skip everything the
 * other had already been sent, so a mismatch is a hard error rather than a quiet
 * re-baseline: the fix is a different `--state`, and nobody can make that choice
 * except the person who named them.
 *
 * A corrupt or unreadable file is treated as absent, with the caller told so it
 * can say it on stdout. That is safe in the direction that matters - it tails
 * rather than replaying - and it cannot wedge a watcher on a bad byte.
 */
export function loadHubState(state: string, agent: string, origin?: string): { state: HubWatchState; repaired: string | null } {
  const path = hubCursorPath(state);
  if (!existsSync(path)) return { state: { ...EMPTY_STATE }, repaired: null };

  let record: Record<string, unknown> | null;
  try {
    record = jsonRecord(readFileSync(path, 'utf-8'));
  } catch (err) {
    return { state: { ...EMPTY_STATE }, repaired: `could not read ${path}: ${(err as Error).message}` };
  }
  if (!record) {
    return { state: { ...EMPTY_STATE }, repaired: `${path} is not readable JSON; starting from the tail` };
  }

  const owner = typeof record['agent'] === 'string' ? (record['agent'] as string) : null;
  if (owner !== null && owner !== agent) {
    throw new HubPermanentError(
      `State "${state}" belongs to agent "${owner}", but "${agent}" tried to use it.\n` +
      "A cursor is a position in one agent's inbox, so sharing one would skip the other's messages.\n" +
      `Pass --state <name> for "${agent}" (it defaults to the agent name).`
    );
  }

  const cursor = record['cursor'];
  const storedOrigin = optionalString(record, 'origin');
  const movedHub = origin !== undefined && storedOrigin !== null && storedOrigin !== origin;
  const usable = isUsableCursor(cursor) && !movedHub;

  return {
    state: {
      cursor: usable ? (cursor as string) : null,
      agent: owner,
      origin: storedOrigin,
      machine: optionalString(record, 'machine'),
      approvedAt: optionalNumber(record, 'approvedAt'),
    },
    repaired: movedHub
      ? `this state last talked to ${storedOrigin}, not ${origin}; a cursor is a position in one hub's streams, so starting from the tail`
      : cursor !== undefined && !isUsableCursor(cursor)
        ? `${path} held an unusable cursor (${JSON.stringify(cursor)}); starting from the tail`
        : null,
  };
}

/**
 * Write the cursor.
 *
 * Published by rename, not by writing in place: a crash mid-write would otherwise
 * leave a truncated file, and the watcher would resume from the tail and silently
 * drop whatever arrived in between. 0600 because this file names the machine.
 */
export function saveHubState(state: string, next: HubStateUpdate): void {
  const path = hubCursorPath(state);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ ...next, updatedAt: Date.now() })}\n`, { mode: 0o600 });
  // `rename` within a directory is atomic, so a reader sees the old file or the
  // new one and never a half of either.
  renameSync(temp, path);
}

/**
 * Write every byte, or throw.
 *
 * `writeSync` may write only a prefix - most plausibly on a nearly full disk,
 * which is exactly when this matters. Returning as though it succeeded would let
 * the watcher advance its cursor past messages whose record was only partly
 * stored.
 *
 * The same routine exists in `telegram-bot.ts`. It is duplicated rather than
 * shared on purpose, for now: that file is loaded by long-running watchers in this
 * shared checkout (roadmap R14), and rewriting it underneath them to save
 * twenty-five lines is the wrong trade. Unify the two the next time that file is
 * being edited anyway.
 */
export function writeAll(
  fd: number,
  text: string,
  write: (fd: number, buffer: Buffer, offset: number, length: number) => number = writeSync
): void {
  const buffer = Buffer.from(text, 'utf-8');
  let written = 0;
  while (written < buffer.length) {
    const n = write(fd, buffer, written, buffer.length - written);
    if (n <= 0) throw new Error(`Short write to the hub message log: ${written}/${buffer.length} bytes`);
    written += n;
  }
}

/** Read just the final byte, rather than the whole log, to test for a torn tail. */
function endsWithNewline(path: string): boolean {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return true;
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] === 0x0a;
  } finally {
    closeSync(fd);
  }
}

/**
 * Append delivered messages to the local log, durably, before the cursor moves.
 *
 * Unlike Telegram the hub retains its own history, so this is not the only copy -
 * but it is the only record of what THIS listener was actually handed, which is
 * what the dedupe reads on restart and what `hub log --local` shows. It throws
 * rather than swallowing: a batch that could not be written down must not be
 * confirmed, because the alternative is a cursor that has moved past messages
 * nobody can prove were seen.
 */
export function appendHubLog(state: string, messages: HubMessage[], origin?: string): void {
  if (messages.length === 0) return;

  const path = hubLogPath(state);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  rotateHubLog(path);
  // **`hub` is written on every record**, and it is what makes the dedupe safe rather
  // than merely usually-safe. A stream id is unique within ONE server, so a record
  // from another hub must never be able to suppress a message here just because the
  // two ids collide. Scoping it on the record beats any amount of moving files around:
  // a mixed log stays readable for a human and stops being a dedupe source for the
  // wrong hub, in one field.
  const lines = messages
    .map((m) => JSON.stringify(origin === undefined ? m : { ...m, hub: origin }))
    .join('\n');

  const fd = openSync(path, 'a', 0o600);
  try {
    // A crash can leave a previous record truncated with no trailing newline.
    // Appending straight onto it would fuse the fragment with the next record into
    // one unparseable line, losing a real message; terminate the fragment first.
    if (fstatSync(fd).size > 0 && !endsWithNewline(path)) {
      writeAll(fd, '\n');
    }
    writeAll(fd, `${lines}\n`);
    // A file the OS has not flushed is not a record that survives a crash.
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Roll the log once when it gets large.
 *
 * Unlike the Telegram watcher's log this one is a mirror - the hub retains the same
 * history - so one generation is enough and the oldest generation is expendable. It
 * is here because nothing else bounds the file: an agent that runs for months would
 * otherwise fill a disk one 8 KB message at a time, and the first symptom would be
 * a watcher that cannot write its log.
 */
export const LOG_ROTATE_BYTES = 8 * 1024 * 1024;

/**
 * How much of the tail a read looks at, per generation.
 *
 * Bounded because the read happens at watcher startup, where the alternative is to
 * hold every message the agent has ever received in memory to return the last fifty.
 * Four MiB is tens of thousands of realistic records and ~500 at the hub's 8 KB body
 * cap - comfortably past `MAX_LOG_LIMIT` and past what the dedupe needs, which is one
 * batch (at most 100 messages per poll).
 *
 * **It is not a guarantee.** That 8 KB cap is on the body BEFORE JSON escaping, so a
 * body of 8192 control characters becomes a ~49 KiB record and the window holds only
 * about 85 of them. The consequence is bounded and in the safe direction: a crash
 * between logging such a batch and saving its cursor replays it, and the replay is
 * PRINTED AGAIN rather than lost. Correctness of the dedupe does not rest on the
 * window - `origin` scoping does.
 */
const LOG_READ_TAIL_BYTES = 4 * 1024 * 1024;

function rotateHubLog(path: string): void {
  try {
    if (!existsSync(path) || statSync(path).size < LOG_ROTATE_BYTES) return;
    renameSync(path, `${path}.1`);
  } catch {
    // A log that cannot be rolled is still a log that can be appended to. Never
    // cost a message over housekeeping.
  }
}

/**
 * Read back logged messages, newest last. A torn line is skipped, not fatal.
 *
 * `origin` filters to the records written while talking to that hub, and a **dedupe
 * seed must always pass it**: without it, a log that has ever pointed at a second hub
 * can suppress a message here on an id collision. A human read (`hub log --local`)
 * deliberately omits it and shows everything the watcher was ever handed.
 */
export function readHubLog(state: string, limit: number, opts: { origin?: string } = {}): HubMessage[] {
  const path = hubLogPath(state);
  const previous = `${path}.1`;
  const out = existsSync(path) ? parseLogLines(path, limit, opts.origin) : [];
  // Short, or missing entirely: a young log, or one that was just rolled. Fall
  // through to the previous generation rather than reporting that the history is gone
  // when the file next to it holds it.
  if (out.length >= limit || !existsSync(previous)) {
    return out.slice(-limit);
  }
  return [...parseLogLines(previous, limit - out.length, opts.origin), ...out].slice(-limit);
}

/** One generation's tail, parsed. A torn line is skipped, never fatal. */
function parseLogLines(path: string, limit: number, origin?: string): HubMessage[] {
  let lines: string[];
  try {
    lines = readLogTail(path).split('\n').filter((line) => line.trim().length > 0);
  } catch {
    return [];
  }

  const out: HubMessage[] = [];
  for (const line of lines) {
    try {
      const raw = JSON.parse(line) as { hub?: unknown };
      // A record with no `hub` predates the field, so it belongs to no known server and
      // is excluded from a scoped read rather than assumed to be this one's.
      if (origin !== undefined && raw.hub !== origin) continue;
      out.push(parseMessage(raw, out.length));
    } catch {
      // A half-written tail from an earlier crash. Skipping it beats failing the
      // whole read, which would take the dedupe down with it.
    }
  }
  return out.slice(-limit);
}

/**
 * The last `LOG_READ_TAIL_BYTES` of the file, minus the partial line at the front.
 *
 * Dropping that first line is what makes the byte-offset read safe: a cut inside a
 * multi-byte UTF-8 character lands in the discarded prefix, so the remaining text is
 * always whole records.
 */
function readLogTail(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - LOG_READ_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    if (buffer.length === 0) return '';
    readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString('utf-8');
    if (start === 0) return text;
    const firstNewline = text.indexOf('\n');
    return firstNewline === -1 ? '' : text.slice(firstNewline + 1);
  } finally {
    closeSync(fd);
  }
}

/** `(stream, id)` — never the id alone. See `HubMessage.id`. */
export function messageKey(message: Pick<HubMessage, 'stream' | 'id'>): string {
  return `${message.stream}:${message.id}`;
}
