// GitHub notifications watcher: polls the account's notification inbox and
// prints one line per thread that changed (a PR review, a comment, a merge, a
// failed workflow run, a release), so a session or an aggregator learns about
// it without anyone opening github.com/notifications.
//
// It reads through the `gh` CLI's existing login rather than a token of its
// own, so adding the watcher adds no credential to the machine.
//
// The engine is I/O-free (the fetch, the clock, output and the state file are
// injected) so baselining, dedupe and restart semantics are testable.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { getConfigDir } from '../config/paths.js';
import { backoffDelay, formatDelay, isPermanentError, parseRetryAfter } from './backoff.js';
import { redactSecrets } from './redact.js';

/** Consecutive poll failures before the watcher reports itself unhealthy. */
const FAILURES_BEFORE_ERROR = 3;

/**
 * How far back every poll asks.
 *
 * GitHub's notifications API is eventually consistent: a thread can become visible minutes after
 * the `updated_at` it carries. Measured 2026-10-02 on a live inbox: three updates surfaced after a
 * cursor that trusted `updated_at` order had already moved past them, and were lost. So no poll
 * trusts that order. Each one asks for everything updated in the last few hours and decides what
 * is new from the seen-map alone, which spans the same window.
 */
export const LOOKBACK_MS = 6 * 60 * 60_000;

const HOUR_MS = 60 * 60_000;

/** The overlap of the cursor design that state files from before the lookback were written by. */
const LEGACY_OVERLAP_MS = 2 * 60_000;

/** A window start rounded down to the hour, so the URL - and with it the ETag - stays the same between polls. */
export function windowStart(ms: number): string {
  return new Date(Math.floor(ms / HOUR_MS) * HOUR_MS).toISOString();
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The fields of a notification thread this watcher reads. GitHub sends many more. */
export interface GhThread {
  id: string;
  reason: string;
  unread: boolean;
  updated_at: string;
  subject: {
    title: string;
    url: string | null;
    latest_comment_url: string | null;
    type: string;
  };
  repository: {
    full_name: string;
    html_url: string;
  };
}

export interface FetchRequest {
  /** ISO window start: GitHub returns threads updated after it. */
  since: string;
  /** The previous response's `ETag`, for a free 304 when nothing in the window changed. */
  ifNoneMatch?: string;
}

export interface FetchResult {
  notModified: boolean;
  /** Newest first, as GitHub returns them. */
  threads: GhThread[];
  /** The server's clock (`Date` header), ISO. */
  serverDate: string;
  etag?: string;
  /** GitHub's `X-Poll-Interval`: the shortest interval it wants polled at. */
  pollIntervalSec?: number;
  /** True when the page cap was hit and older changes were not fetched. */
  truncated?: boolean;
  /**
   * True when the window spanned more than one page. The ETag then covers page 1 only, and a late
   * update that sorts onto a later page would hide behind its 304, so it must not be reused.
   */
  multiPage?: boolean;
}

export interface GithubWatchState {
  /**
   * Nothing updated at or before this is reported: the baseline instant, or an explicit `--since`.
   * A late thread carrying an older time is history, however late it shows up.
   */
  floor: string;
  /** thread id -> `updated_at` already handled, for every thread updated inside the lookback window. */
  seen: Record<string, string>;
  etag?: string;
  /** Server time of the last successful poll, so a restart can reach back over the time it was down. */
  lastPollAt?: string;
  /**
   * thread id -> fingerprint of its PR or issue when last looked at, for --drop-silent-bumps. Kept
   * for the threads still in `seen`.
   */
  subjects?: Record<string, string>;
  /** thread id -> the subject's latest-comment url at the last fingerprint, to tell a new comment from other changes. */
  comments?: Record<string, string | null>;
  /**
   * thread id -> the unchanged-looking update being rechecked (its `updated_at`) and when it was
   * first looked at (ms). A newer update of the thread starts its own window.
   */
  pending?: Record<string, { updatedAt: string; firstSeenAt: number }>;
  /** The `--participating` setting this state was built under; a change re-baselines. */
  participating?: boolean;
}

export interface GithubWatchOptions {
  intervalMs: number;
  maxText: number;
  json: boolean;
  /** `owner/repo` patterns; `*` matches any run of characters. Empty = all. */
  repos: string[];
  /** GitHub `reason` values to keep (author, comment, review_requested, ci_activity, …). Empty = all. */
  reasons: string[];
  /** Subject types to keep (PullRequest, Issue, CheckSuite, Release, …). Empty = all. */
  types: string[];
  /** Server-side filter: GitHub never returns the threads it excludes, so they cannot be marked seen. */
  participating: boolean;
  timeZone?: string;
}

/** Longest poll interval accepted. Node's timers overflow above 2^31-1 ms and fire at once instead. */
export const MAX_INTERVAL_MS = 60 * 60_000;

export interface GithubWatchIO {
  fetch(req: FetchRequest): Promise<FetchResult>;
  loadState(): GithubWatchState | null;
  saveState(state: GithubWatchState): void;
  /** Resolves once the lines are written, so the state never moves past an undelivered line. */
  emit(lines: string[]): Promise<void>;
  log(message: string): void;
  /** The clock; tests pin it. */
  now?: () => number;
  /**
   * Set to drop silent bumps: a fingerprint of the PR or issue behind a thread (its own time, state,
   * head commit, counts, people and labels), or null when it cannot tell, which keeps the line.
   */
  subjectFingerprint?: (thread: GhThread) => Promise<SubjectFingerprint | null>;
}

// ---------------------------------------------------------------------------
// State file
// ---------------------------------------------------------------------------

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_');
}

export function githubWatchStatePath(stateName: string): string {
  return join(getConfigDir(), 'github-watch', safeName(stateName), 'state.json');
}

export function loadGithubWatchState(path: string): GithubWatchState | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (typeof parsed?.seen !== 'object' || parsed.seen === null) return null;
    // State written before the lookback design kept a `cursor`, and a `floor` only for --since.
    // That design admitted updates down to cursor - LEGACY_OVERLAP_MS and its seen-map covered
    // that much, so that is the floor: no replay, and no late update lost that it would have kept.
    const legacy = typeof parsed.cursor === 'string' && typeof parsed.lastPollAt !== 'string';
    const legacyFloor = legacy && !Number.isNaN(Date.parse(parsed.cursor))
      ? new Date(Date.parse(parsed.cursor) - LEGACY_OVERLAP_MS).toISOString()
      : undefined;
    const candidates = [parsed.floor, legacyFloor]
      .filter((v): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v)));
    if (candidates.length === 0) return null;
    const floor = candidates.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
    return {
      floor,
      seen: parsed.seen,
      etag: typeof parsed.etag === 'string' ? parsed.etag : undefined,
      lastPollAt: typeof parsed.lastPollAt === 'string' ? parsed.lastPollAt : undefined,
      participating: typeof parsed.participating === 'boolean' ? parsed.participating : undefined,
      ...(typeof parsed.subjects === 'object' && parsed.subjects !== null ? { subjects: parsed.subjects } : {}),
      ...(typeof parsed.pending === 'object' && parsed.pending !== null ? { pending: parsed.pending } : {}),
      ...(typeof parsed.comments === 'object' && parsed.comments !== null ? { comments: parsed.comments } : {}),
    };
  } catch {
    return null;
  }
}

/** Write a complete replacement file so an interrupted process never leaves partial JSON. */
export function saveGithubWatchState(path: string, state: GithubWatchState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tempPath, JSON.stringify(state), { encoding: 'utf-8', flag: 'wx' });
    renameSync(tempPath, path);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// gh output parsing
// ---------------------------------------------------------------------------

export interface GhResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Split `gh api --include` output into status, headers and body.
 *
 * `gh` exits non-zero on a 304 as well as on a real error, so the exit code
 * cannot tell them apart; the status line can. Returns null when there is no
 * status line at all, which means the request never got an HTTP answer.
 */
export function parseGhInclude(stdout: string): GhResponse | null {
  const match = /^HTTP\/[\d.]+ (\d{3})[^\r\n]*\r?\n/.exec(stdout);
  if (!match) return null;
  const rest = stdout.slice(match[0].length);
  const split = /\r?\n\r?\n/.exec(rest);
  const headerBlock = split ? rest.slice(0, split.index) : rest;
  const body = split ? rest.slice(split.index + split[0].length) : '';
  const headers: Record<string, string> = {};
  for (const line of headerBlock.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { status: Number(match[1]), headers, body };
}

/**
 * The error for a `gh` call that got no HTTP answer.
 *
 * `gh` exits 4 when it has no login at all: nothing went over the network, so no status line is
 * printed. That is as permanent as a revoked token, and is worded to match backoff's permanent
 * patterns; anything else without a status line (DNS, a dropped link) stays retryable.
 */
export function ghFailure(
  path: string,
  exitCode: number | string | undefined,
  stderr: string,
  how: { killed?: boolean; signal?: string | null; timeoutMs?: number } = {},
): Error {
  if (exitCode === 4) {
    return new Error('GitHub authentication is not configured for gh; run `gh auth login` or set GH_TOKEN');
  }
  const endpoint = `gh api ${path.split('?')[0]}`;
  // Name the cause rather than echoing the command line: the operator needs to know whether
  // GitHub was slow, gh was killed, or gh said why.
  let message: string;
  if (how.killed && how.timeoutMs) message = `${endpoint}: no answer within ${Math.round(how.timeoutMs / 1000)}s`;
  else if (how.signal) message = `${endpoint}: gh was stopped by ${how.signal}`;
  else message = `${endpoint}: ${stderr.trim().split('\n').pop() || `gh exited ${exitCode ?? 'abnormally'} without an HTTP answer or an error message`}`;
  // No HTTP answer means nothing reached GitHub's auth, so this is retryable whatever the text
  // says: a proxy line containing "unauthorized" must not stop the watcher.
  // gh's stderr is outside text and reaches stdout on an ERROR line, so it is redacted here.
  return Object.assign(new Error(redactSecrets(message)), { retryable: true });
}

/** True for an error that must stop the watcher: a permanent cause not explicitly marked retryable. */
export function stopsWatcher(err: unknown): boolean {
  return isPermanentError(err) && !(err as { retryable?: boolean } | null)?.retryable;
}

/** The `rel="next"` target of a `Link` header, as a path `gh api` accepts. */
export function nextPagePath(link: string | undefined): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (m) return m[1].replace(/^https:\/\/api\.github\.com\//, '');
  }
  return null;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function fold(text: string): string {
  return text.replace(/\r?\n/g, ' ⏎ ').trim();
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… [+${text.length - max} chars]`;
}

function hhmm(date: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).format(date);
}

function issueNumber(url: string | null): string | null {
  const m = url ? /\/(?:pulls|issues|discussions)\/(\d+)$/.exec(url) : null;
  return m ? m[1] : null;
}

/** A short label: `PR#12`, `Issue#7`, `CI`, `Release`. */
export function subjectLabel(thread: GhThread): string {
  const n = issueNumber(thread.subject.url);
  switch (thread.subject.type) {
    case 'PullRequest': return n ? `PR#${n}` : 'PR';
    case 'Issue': return n ? `Issue#${n}` : 'Issue';
    case 'Discussion': return n ? `Discussion#${n}` : 'Discussion';
    case 'CheckSuite': return 'CI';
    default: return thread.subject.type;
  }
}

/**
 * The page a person would open, built from the API URL GitHub gives.
 *
 * The notification only carries API URLs. A workflow-run notification
 * (`CheckSuite`) carries none at all, so it links to the repository's Actions tab.
 */
export function subjectHtmlUrl(thread: GhThread): string {
  const repoUrl = thread.repository.html_url || `https://github.com/${thread.repository.full_name}`;
  const url = thread.subject.url;
  if (thread.subject.type === 'CheckSuite' || !url) return `${repoUrl}/actions`;
  let m = /\/pulls\/(\d+)$/.exec(url);
  if (m) return `${repoUrl}/pull/${m[1]}${commentAnchor(thread)}`;
  m = /\/issues\/(\d+)$/.exec(url);
  if (m) return `${repoUrl}/issues/${m[1]}${commentAnchor(thread)}`;
  m = /\/commits\/([0-9a-f]+)$/.exec(url);
  if (m) return `${repoUrl}/commit/${m[1]}`;
  if (/\/releases\/\d+$/.test(url)) return `${repoUrl}/releases`;
  m = /\/discussions\/(\d+)$/.exec(url);
  if (m) return `${repoUrl}/discussions/${m[1]}`;
  return repoUrl;
}

function commentAnchor(thread: GhThread): string {
  const latest = thread.subject.latest_comment_url;
  const m = latest ? /\/issues\/comments\/(\d+)$/.exec(latest) : null;
  return m ? `#issuecomment-${m[1]}` : '';
}

/**
 * One line for a thread. `change` - what changed on the PR or issue, when --drop-silent-bumps could
 * tell - replaces GitHub's `reason` (why you are subscribed, not what happened). Without a new
 * comment the link goes to the PR or issue, not to the old comment.
 */
export function formatGithubEvent(
  thread: GhThread,
  opts: Pick<GithubWatchOptions, 'maxText' | 'json' | 'timeZone'>,
  change?: string,
): string {
  // Redact the whole title before cutting it: a cut can split a DSN or token so the pattern no
  // longer matches, and the secret's head would print.
  const title = truncate(fold(redactSecrets(thread.subject.title)), opts.maxText);
  const noNewComment = change !== undefined && !change.split('+').includes('commented');
  const url = noNewComment ? subjectHtmlUrl(thread).replace(/#issuecomment-\d+$/, '') : subjectHtmlUrl(thread);
  if (opts.json) {
    return redactSecrets(JSON.stringify({
      type: 'github',
      id: thread.id,
      repo: thread.repository.full_name,
      subjectType: thread.subject.type,
      label: subjectLabel(thread),
      reason: thread.reason,
      ...(change !== undefined ? { change } : {}),
      unread: thread.unread,
      updatedAt: thread.updated_at,
      title,
      url,
    }));
  }
  const time = hhmm(new Date(thread.updated_at), opts.timeZone);
  // A notification title is text other people wrote, delivered into a context unprompted.
  return redactSecrets(`[gh] ${thread.repository.full_name} ${subjectLabel(thread)} ${change ?? thread.reason} ${time}: ${title} ${url}`);
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

export function threadMatches(thread: GhThread, opts: Pick<GithubWatchOptions, 'repos' | 'reasons' | 'types'>): boolean {
  if (opts.repos.length && !opts.repos.some((p) => globToRegExp(p).test(thread.repository.full_name))) return false;
  if (opts.reasons.length && !opts.reasons.some((r) => r.toLowerCase() === thread.reason.toLowerCase())) return false;
  if (opts.types.length && !opts.types.some((t) => t.toLowerCase() === thread.subject.type.toLowerCase())) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Diffing
// ---------------------------------------------------------------------------

/**
 * Which threads are news, and the state after reporting them.
 *
 * A thread is news when its `updated_at` is after the floor and is not one this watcher has
 * already handled. Order is never trusted, so a thread that shows up late is still reported once.
 * Threads the filters drop are still recorded, so a filter change never replays history.
 * The seen-map keeps every entry inside the window (`windowFrom`): GitHub returns nothing older,
 * so an entry before it can never be needed again.
 */
export function diffThreads(
  state: GithubWatchState,
  threads: GhThread[],
  opts: Pick<GithubWatchOptions, 'repos' | 'reasons' | 'types'>,
  windowFrom: number,
): { report: GhThread[]; next: GithubWatchState } {
  const floorMs = Date.parse(state.floor);
  const seen = { ...state.seen };
  const report: GhThread[] = [];

  // Oldest first, so a burst reads in the order it happened.
  const ordered = [...threads].sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at));
  for (const thread of ordered) {
    const at = Date.parse(thread.updated_at);
    if (Number.isNaN(at) || at <= floorMs) continue;
    if (seen[thread.id] !== undefined && Date.parse(seen[thread.id]) >= at) continue;
    seen[thread.id] = thread.updated_at;
    if (threadMatches(thread, opts)) report.push(thread);
  }

  for (const [id, at] of Object.entries(seen)) {
    if (Date.parse(at) < windowFrom) delete seen[id];
  }

  return { report, next: { ...state, seen } };
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class GithubWatcher {
  private state: GithubWatchState | null;
  private failures = 0;
  private errorReported = false;
  private pollIntervalMs: number;
  /** Until the first successful poll, the window also reaches back over downtime or a `--since`. */
  private firstPoll = true;
  /** True when a changed `--participating` discarded the saved state. */
  rebaselined = false;

  constructor(
    private readonly opts: GithubWatchOptions,
    private readonly io: GithubWatchIO,
    init: { since?: string } = {},
  ) {
    this.pollIntervalMs = Math.min(opts.intervalMs, MAX_INTERVAL_MS);
    if (init.since !== undefined) {
      this.state = { floor: new Date(init.since).toISOString(), seen: {}, participating: opts.participating };
      return;
    }
    const loaded = io.loadState();
    if (loaded && (loaded.participating ?? false) !== opts.participating) {
      // The server filtered differently before, so threads it hid were never recorded.
      // Replaying them would be history printed as news; start over instead.
      this.rebaselined = true;
      this.state = null;
    } else {
      this.state = loaded;
    }
  }

  /** Server time of the last successful poll, for the start line; null before the first. */
  lastPollAt(): string | null {
    return this.state?.lastPollAt ?? null;
  }

  /** The floor, for the start line; null until the first poll has baselined. */
  floor(): string | null {
    return this.state?.floor ?? null;
  }

  /** Where this poll's window starts. */
  private windowFrom(now: number): number {
    let from = now - LOOKBACK_MS;
    if (this.state?.lastPollAt) {
      // Reach back one lookback behind the last successful poll, not behind now. In normal running
      // that is the same window; after an outage - a restart or a long run of failed polls - it
      // also covers the gap, so an update that surfaced late during it is still asked for.
      from = Math.min(from, Date.parse(this.state.lastPollAt) - LOOKBACK_MS);
    } else if (this.firstPoll && this.state) {
      // A `--since` replay starts at its floor.
      from = Math.min(from, Date.parse(this.state.floor));
    }
    return Date.parse(windowStart(from));
  }

  /** Run one poll; returns the delay before the next one. */
  async tick(): Promise<number> {
    const windowFrom = this.windowFrom((this.io.now ?? Date.now)());
    let result: FetchResult;
    try {
      result = await this.io.fetch({ since: new Date(windowFrom).toISOString(), ifNoneMatch: this.state?.etag });
    } catch (err) {
      // A revoked login or a missing `gh` cannot fix itself; retrying would be a silent hang.
      if (stopsWatcher(err)) throw err;
      return this.failed(err as Error);
    }

    if (this.errorReported) await this.io.emit(['[gh-watch] recovered']);
    this.lastError = null;
    this.failures = 0;
    this.errorReported = false;
    this.firstPoll = false;
    if (result.pollIntervalSec) {
      this.pollIntervalMs = Math.min(Math.max(this.opts.intervalMs, result.pollIntervalSec * 1000), MAX_INTERVAL_MS);
    }

    if (this.state === null) {
      // First run: everything already in the inbox is history, not news. The floor makes that
      // hold for threads the baseline did not see too, such as ones beyond the page cap.
      const seen: Record<string, string> = {};
      for (const t of result.threads) seen[t.id] = t.updated_at;
      const newest = result.threads.reduce((max, t) => Math.max(max, Date.parse(t.updated_at) || 0), 0);
      const floor = new Date(Math.max(Date.parse(result.serverDate) || 0, newest)).toISOString();
      this.state = { floor, seen, etag: result.multiPage ? undefined : result.etag, lastPollAt: result.serverDate, participating: this.opts.participating };
      this.io.saveState(this.state);
      return this.pollIntervalMs;
    }

    if (result.notModified) {
      this.state = { ...this.state, lastPollAt: result.serverDate };
      this.io.saveState(this.state);
      return this.pollIntervalMs;
    }

    const diffed = diffThreads(this.state, result.threads, this.opts, windowFrom);
    const { report, next, deferred, changes } = await this.dropSilentBumps(diffed.report, this.state, diffed.next);
    const lines = report.map((t) => formatGithubEvent(t, this.opts, changes.get(t.id)));
    if (result.truncated) {
      lines.unshift(`[gh-watch] more changes since ${new Date(windowFrom).toISOString()} than one poll fetches; the oldest were skipped, see https://github.com/notifications`);
    }
    // Print, then save: a crash in between replays a line rather than losing one.
    if (lines.length) await this.io.emit(lines);
    // A deferred bump must be asked about again next poll, so no 304 may hide it.
    const etag = result.multiPage || deferred ? undefined : result.etag;
    this.state = { ...next, etag, lastPollAt: result.serverDate };
    this.io.saveState(this.state);
    return this.pollIntervalMs;
  }

  /** Until when subject checks are paused after a failure (a rate limit), ms. */
  private checksPausedUntil = 0;

  /**
   * GitHub moves a thread's `updated_at` for things nobody did - after a merge it bumped one PR
   * twice in eight minutes with no comment, review or event behind either. Reported, each reads
   * "comment" while nobody commented, which teaches the reader the word means nothing.
   *
   * With `subjectFingerprint`, a PR or issue thread is dropped only when its subject's fingerprint
   * is identical to the one recorded at the previous update of that thread. Everything else is kept:
   * other subject types, a subject never fingerprinted before, a changed fingerprint, a failed or
   * unanswerable check, checks paused after a failure or over the per-poll budget. An unchanged
   * fingerprint on a bump younger than SILENT_BUMP_RECHECK_MS is not dropped yet but left unseen,
   * so the next poll asks again: the subject's record can lag the notification.
   */
  private async dropSilentBumps(
    threads: GhThread[],
    before: GithubWatchState,
    next: GithubWatchState,
  ): Promise<{ report: GhThread[]; next: GithubWatchState; deferred: boolean; changes: Map<string, string> }> {
    const fingerprint = this.io.subjectFingerprint;
    if (!fingerprint) {
      // Off: keep no baselines, or a later run with the option on would describe changes against
      // a state from before the lines printed meanwhile.
      const { subjects: _s, comments: _c, pending: _p, ...rest } = next;
      return { report: threads, next: rest, deferred: false, changes: new Map() };
    }
    const subjects: Record<string, string> = {};
    for (const [id, fp] of Object.entries(before.subjects ?? {})) if (next.seen[id] !== undefined) subjects[id] = fp;
    const comments: Record<string, string | null> = {};
    for (const [id, c] of Object.entries(before.comments ?? {})) if (next.seen[id] !== undefined) comments[id] = c;
    const changes = new Map<string, string>();
    // An update the filters dropped (seen, not reported) moved the subject without a line: its
    // baseline no longer describes what the reader last saw.
    const reported = new Set(threads.map((t) => t.id));
    for (const [id, at] of Object.entries(next.seen)) {
      if (!reported.has(id) && before.seen[id] !== at) {
        delete subjects[id];
        delete comments[id];
      }
    }
    const pending: Record<string, { updatedAt: string; firstSeenAt: number }> = {};
    for (const [id, p] of Object.entries(before.pending ?? {})) {
      if (next.seen[id] !== undefined && typeof p?.updatedAt === 'string' && Number.isFinite(p?.firstSeenAt)) pending[id] = p;
    }
    const seen = { ...next.seen };
    const now = (this.io.now ?? Date.now)();
    const report: GhThread[] = [];
    let checks = 0;
    let deferred = false;
    for (const thread of threads) {
      if (!SILENT_BUMP_TYPES.has(thread.subject.type) || now < this.checksPausedUntil || checks >= MAX_SUBJECT_CHECKS_PER_POLL) {
        // Reported unchecked: forget the baseline, so the next line is not described against a
        // state older than this one.
        delete subjects[thread.id];
        delete comments[thread.id];
        delete pending[thread.id];
        report.push(thread);
        continue;
      }
      checks++;
      let sub: SubjectFingerprint | null;
      try {
        sub = await fingerprint(thread);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const wait = Math.max((err as GhRetryError)?.retryAfterMs ?? 0, SUBJECT_CHECK_PAUSE_MS);
        this.checksPausedUntil = now + wait;
        this.io.log(`subject check failed for ${thread.repository.full_name} ${subjectLabel(thread)}, keeping lines unchecked for ${formatDelay(wait)}: ${redactSecrets(message)}`);
        delete subjects[thread.id];
        delete comments[thread.id];
        delete pending[thread.id];
        report.push(thread);
        continue;
      }
      const previous = subjects[thread.id];
      if (sub === null) {
        delete subjects[thread.id];
        delete comments[thread.id];
        delete pending[thread.id];
        report.push(thread);
        continue;
      }
      if (Date.parse(sub.updatedAt) > Date.parse(thread.updated_at)) {
        // The subject already holds something newer than this notification: report it, and record
        // no baseline, so that newer change is judged on its own notification.
        delete subjects[thread.id];
        delete comments[thread.id];
        delete pending[thread.id];
        report.push(thread);
        continue;
      }
      if (previous === undefined || sub.fingerprint !== previous) {
        if (previous !== undefined) {
          const words = describeChange(previous, sub.fingerprint, comments[thread.id], thread.subject.latest_comment_url);
          if (words) changes.set(thread.id, words);
        }
        subjects[thread.id] = sub.fingerprint;
        comments[thread.id] = thread.subject.latest_comment_url;
        delete pending[thread.id];
        report.push(thread);
        continue;
      }
      // Unchanged. Drop only after a second unchanged look at least SILENT_BUMP_RECHECK_MS after
      // the first, in case the subject's record lags the notification; until then leave it unseen.
      const held = pending[thread.id];
      const first = held?.updatedAt === thread.updated_at ? held.firstSeenAt : undefined;
      if (first === undefined || now - first < SILENT_BUMP_RECHECK_MS) {
        if (first === undefined) pending[thread.id] = { updatedAt: thread.updated_at, firstSeenAt: now };
        if (before.seen[thread.id] === undefined) delete seen[thread.id];
        else seen[thread.id] = before.seen[thread.id];
        deferred = true;
        continue;
      }
      delete pending[thread.id];
      this.io.log(`dropped a silent bump: ${thread.repository.full_name} ${subjectLabel(thread)} at ${thread.updated_at}`);
    }
    return { report, next: { ...next, seen, subjects, comments, pending }, deferred, changes };
  }

  /** The last poll's error, or null when it succeeded. */
  lastFailure(): string | null {
    return this.lastError;
  }

  private lastError: string | null = null;

  private failed(err: Error): number {
    // Errors from the injected fetch are not all built by ghFailure/httpError; redact on the way out too.
    this.lastError = redactSecrets(err.message);
    this.failures++;
    this.io.log(`poll failed (${this.failures}): ${this.lastError}`);
    if (this.failures >= FAILURES_BEFORE_ERROR && !this.errorReported) {
      // Not awaited: an unhealthy watcher must keep its retry schedule even if stdout is slow.
      void this.io.emit([`[gh-watch] ERROR ${this.lastError} (retrying)`]);
      this.errorReported = true;
    }
    const delayMs = Math.max(backoffDelay(this.failures), (err as GhRetryError).retryAfterMs ?? 0);
    if (this.failures === FAILURES_BEFORE_ERROR) this.io.log(`backing off, next attempt in ${formatDelay(delayMs)}`);
    return delayMs;
  }
}

/** An error that carries the server's own wait (rate limit), honoured over the backoff. */
export interface GhRetryError extends Error {
  retryAfterMs?: number;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

const PER_PAGE = 50;
/** Most pages one poll follows. Past this the line says so instead of paging for minutes. */
const MAX_PAGES = 20;

/** A parsed JSON value as text. JSON.parse yields only plain data, so stringify cannot throw on a cycle. */
function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

export function httpError(res: GhResponse): GhRetryError {
  let raw: unknown;
  try {
    raw = JSON.parse(res.body)?.message;
  } catch {
    raw = undefined;
  }
  // GitHub's error text is outside text that reaches stdout on an ERROR line; redact it once here.
  // It is normally a string, but a body is not trusted to be: a number must not crash the classifier.
  const message = redactSecrets(typeof raw === 'string' ? raw : raw == null ? '' : jsonText(raw));
  const err: GhRetryError = new Error(`GitHub answered HTTP ${res.status}${message ? `: ${message}` : ''}`);
  const limited = res.status === 429 || (res.status === 403 && (res.headers['x-ratelimit-remaining'] === '0' || /rate limit/i.test(message)));
  if (res.status === 401) {
    // "unauthorized" matches backoff's permanent patterns: the login was revoked or expired.
    err.message = `GitHub answered HTTP 401 unauthorized; run \`gh auth login\` (${message || 'bad credentials'})`;
  } else if (res.status === 403 && !limited) {
    err.message = `GitHub answered HTTP 403 unauthorized for notifications; the gh token needs the notifications or repo scope (${message || 'forbidden'})`;
  } else if (limited) {
    const reset = Number(res.headers['x-ratelimit-reset']);
    err.retryAfterMs = parseRetryAfter(res.headers['retry-after'] ?? null)
      ?? (Number.isFinite(reset) ? parseRetryAfter(String(Math.max(0, Math.ceil(reset - Date.now() / 1000)))) ?? undefined : undefined);
  }
  return err;
}

/** One `gh api --include` call: the command runs gh, tests pass a fake. */
export type GhApi = (path: string, headers?: Record<string, string>) => Promise<GhResponse>;

/** Subject types whose own record says whether anything happened; only these can be silent bumps. */
export const SILENT_BUMP_TYPES = new Set(['PullRequest', 'Issue']);


/** Most subject checks in one poll; past it, lines are kept unchecked. */
export const MAX_SUBJECT_CHECKS_PER_POLL = 10;
/** How long subject checks pause after one fails, unless the server asks for longer. */
export const SUBJECT_CHECK_PAUSE_MS = 15 * 60_000;
/** How long an unchanged-looking bump is re-asked before it is dropped, in case the subject lags. */
export const SILENT_BUMP_RECHECK_MS = 2 * 60_000;

/**
 * A fingerprint of the PR or issue behind `thread`: its own `updated_at` plus what a person can
 * change on it - state, merge, draft, head commit, comment / review-comment / commit counts,
 * requested reviewers and teams, assignees and labels. Equal fingerprints mean nothing anyone can
 * name happened in between (GitHub's bumps on PR 324 after its merge left all of these alone).
 * One request; null when the subject is not a PR or issue or the answer has no `updated_at`.
 */
export interface SubjectFingerprint {
  fingerprint: string;
  /** The subject's own `updated_at`. */
  updatedAt: string;
}

export async function subjectFingerprint(api: GhApi, thread: GhThread): Promise<SubjectFingerprint | null> {
  const m = /^https:\/\/api\.github\.com\/(repos\/[^/]+\/[^/]+\/(?:pulls|issues)\/\d+)$/.exec(thread.subject.url ?? '');
  if (!m) return null;
  const res = await api(m[1]);
  if (res.status !== 200) throw httpError(res);
  const s = JSON.parse(res.body) as Record<string, unknown>;
  if (typeof s?.updated_at !== 'string') return null;
  const ids = (v: unknown, key: string) => (Array.isArray(v) ? v.map((x) => (x as Record<string, unknown>)?.[key]).sort() : null);
  // A review with no body moves none of the fields below, so a PR also counts its reviews: with one
  // per page, the last page's number is the count.
  let reviews: number | null = null;
  if (m[1].includes('/pulls/')) {
    const r = await api(`${m[1]}/reviews?per_page=1`);
    if (r.status !== 200) throw httpError(r);
    const last = lastPagePath(r.headers['link']);
    const n = last ? Number(/[?&]page=(\d+)/.exec(last)?.[1]) : (JSON.parse(r.body) as unknown[]).length;
    if (!Number.isSafeInteger(n)) return null;
    reviews = n;
  }
  const fingerprint = JSON.stringify([
    s.updated_at, s.state, s.merged_at ?? null, s.draft ?? null, (s.head as { sha?: unknown } | undefined)?.sha ?? null,
    s.comments ?? null, s.review_comments ?? null, s.commits ?? null,
    ids(s.requested_reviewers, 'id'), ids(s.requested_teams, 'id'), ids(s.assignees, 'id'), ids(s.labels, 'name'), reviews,
  ]);
  return { fingerprint, updatedAt: s.updated_at };
}

/**
 * What changed between two fingerprints of one subject, in words joined by "+" ("pushed+reviewed"),
 * or null when either is unreadable. "commented" also when the latest-comment url moved. When only
 * the subject's time moved, "updated": an edit of a comment, the title or the body, or another
 * change the fingerprint does not itemise (on sample-service PR 112, a bot editing its own comment).
 */
export function describeChange(before: string, after: string, commentBefore: string | null | undefined, commentAfter: string | null): string | null {
  let a: unknown[];
  let b: unknown[];
  try {
    a = JSON.parse(before);
    b = JSON.parse(after);
  } catch {
    return null;
  }
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return null;
  const same = (i: number) => JSON.stringify(a[i]) === JSON.stringify(b[i]);
  const more = (i: number) => typeof a[i] === 'number' && typeof b[i] === 'number' && (b[i] as number) > (a[i] as number);
  const words: string[] = [];
  if (a[2] === null && b[2] !== null) words.push('merged');
  else if (a[1] === 'open' && b[1] === 'closed') words.push('closed');
  else if (a[1] === 'closed' && b[1] === 'open') words.push('reopened');
  if (a[3] === true && b[3] === false) words.push('ready for review');
  if (a[3] === false && b[3] === true) words.push('converted to draft');
  if (!same(4) || !same(7)) words.push('pushed');
  if (more(12)) words.push('reviewed');
  if (more(6)) words.push('review comments');
  // A new comment: the count grew, or the latest-comment url moved to another comment (not away).
  if (more(5) || (commentBefore !== undefined && commentAfter !== null && commentBefore !== commentAfter)) words.push('commented');
  // People lists: say whether someone was added, removed, or both.
  const people = (i: number, added: string, removed: string, both: string) => {
    if (same(i)) return;
    const was = new Set((Array.isArray(a[i]) ? a[i] : []).map((x) => JSON.stringify(x)));
    const now = new Set((Array.isArray(b[i]) ? b[i] : []).map((x) => JSON.stringify(x)));
    const plus = [...now].some((x) => !was.has(x));
    const minus = [...was].some((x) => !now.has(x));
    words.push(plus && minus ? both : plus ? added : removed);
  };
  if (!same(8) || !same(9)) {
    const reqBefore = [...(Array.isArray(a[8]) ? a[8] : []), ...(Array.isArray(a[9]) ? a[9] : []).map((t) => `team:${String(t)}`)];
    const reqAfter = [...(Array.isArray(b[8]) ? b[8] : []), ...(Array.isArray(b[9]) ? b[9] : []).map((t) => `team:${String(t)}`)];
    const plus = reqAfter.some((x) => !reqBefore.includes(x));
    const minus = reqBefore.some((x) => !reqAfter.includes(x));
    words.push(plus && minus ? 'review requests changed' : plus ? 'review requested' : 'review request removed');
  }
  people(10, 'assigned', 'unassigned', 'assignees changed');
  people(11, 'labelled', 'unlabelled', 'labels changed');
  if (words.length === 0) words.push('updated');
  return words.join('+');
}

/** The `rel="last"` page of a Link header, as an api path. */
export function lastPagePath(link: string | undefined): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="last"/.exec(part);
    if (m) return m[1].replace(/^https:\/\/api\.github\.com\//, '');
  }
  return null;
}

export async function fetchNotifications(api: GhApi, req: FetchRequest, participating: boolean): Promise<FetchResult> {
  // Up to MAX_PAGES pages of PER_PAGE, newest first.
  const params = new URLSearchParams({ per_page: String(PER_PAGE), all: 'true', since: req.since });
  if (participating) params.set('participating', 'true');

  const first = await api(`notifications?${params}`, req.ifNoneMatch ? { 'If-None-Match': req.ifNoneMatch } : {});
  const serverDate = new Date(Date.parse(first.headers['date'] ?? '') || Date.now()).toISOString();
  const pollIntervalSec = Number(first.headers['x-poll-interval']) || undefined;
  if (first.status === 304) {
    return { notModified: true, threads: [], serverDate, etag: req.ifNoneMatch, pollIntervalSec };
  }
  if (first.status !== 200) throw httpError(first);

  const threads: GhThread[] = [];
  let page: GhResponse = first;
  for (let pages = 1; ; pages++) {
    const parsed = JSON.parse(page.body);
    if (!Array.isArray(parsed)) throw new Error('GitHub notifications response was not a list');
    threads.push(...(parsed as GhThread[]));
    const next = nextPagePath(page.headers['link']);
    if (!next || pages >= MAX_PAGES) {
      return {
        notModified: false,
        threads,
        serverDate,
        etag: first.headers['etag'],
        pollIntervalSec,
        truncated: Boolean(next),
        // A full first page counts too: one more late update would open a page 2 that a 304 on
        // the unchanged page 1 would hide.
        multiPage: pages > 1 || Boolean(next) || threads.length >= PER_PAGE,
      };
    }
    page = await api(next);
    if (page.status !== 200) throw httpError(page);
  }
}
