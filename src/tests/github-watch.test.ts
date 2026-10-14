import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { isPermanentError } from '../services/backoff.js';
import {
  GithubWatcher,
  LOOKBACK_MS,
  MAX_INTERVAL_MS,
  diffThreads,
  fetchNotifications,
  formatGithubEvent,
  ghFailure,
  httpError,
  stopsWatcher,
  loadGithubWatchState,
  nextPagePath,
  parseGhInclude,
  saveGithubWatchState,
  subjectHtmlUrl,
  subjectLabel,
  threadMatches,
  windowStart,
  type FetchRequest,
  type FetchResult,
  type GhApi,
  type GhResponse,
  type GhThread,
  type GithubWatchIO,
  type GithubWatchOptions,
  type GithubWatchState,
  subjectFingerprint,
  describeChange,
  SILENT_BUMP_RECHECK_MS,
  MAX_SUBJECT_CHECKS_PER_POLL,
} from '../services/github-watch.js';

const OPTS: GithubWatchOptions = {
  intervalMs: 60_000,
  maxText: 300,
  json: false,
  repos: [],
  reasons: [],
  types: [],
  participating: false,
  timeZone: 'UTC',
};

const T0 = Date.parse('2026-10-01T12:00:00Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString().replace('.000Z', 'Z');

function thread(id: string, updatedAt: string, extra: Partial<GhThread> & { repo?: string } = {}): GhThread {
  const repo = extra.repo ?? 'otherorg/gpu-cluster';
  return {
    id,
    reason: 'author',
    unread: true,
    updated_at: updatedAt,
    subject: {
      title: `PR ${id}`,
      url: `https://api.github.com/repos/${repo}/pulls/${id}`,
      latest_comment_url: null,
      type: 'PullRequest',
    },
    repository: { full_name: repo, html_url: `https://github.com/${repo}` },
    ...extra,
  };
}

/**
 * A fake inbox that models what GitHub actually does: a thread update is *visible* only from some
 * moment on, which can be later than the `updated_at` it carries. `since` filters on updated_at,
 * and the ETag changes whenever the visible window changes.
 */
class FakeInbox {
  /** What the API returns right now. */
  visible: GhThread[] = [];
  clock = T0;
  failNext = 0;
  failWith = 'connect ETIMEDOUT';
  requests: FetchRequest[] = [];
  state: GithubWatchState | null = null;
  out: string[] = [];
  logs: string[] = [];

  /** Make an update visible now; it replaces any earlier version of the same thread. */
  show(t: GhThread) {
    this.visible = this.visible.filter((x) => x.id !== t.id).concat(t);
  }

  advance(minutes: number) {
    this.clock += minutes * 60_000;
  }

  private window(since: string): GhThread[] {
    return this.visible
      .filter((t) => Date.parse(t.updated_at) > Date.parse(since))
      .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  }

  io(): GithubWatchIO {
    return {
      now: () => this.clock,
      fetch: async (req) => {
        this.requests.push(req);
        if (this.failNext > 0) {
          this.failNext--;
          throw new Error(this.failWith);
        }
        const threads = this.window(req.since);
        const etag = `W/"${threads.map((t) => `${t.id}@${t.updated_at}`).join(',')}"`;
        const serverDate = new Date(this.clock).toISOString();
        if (req.ifNoneMatch === etag) return { notModified: true, threads: [], serverDate, etag };
        return { notModified: false, threads, serverDate, etag } satisfies FetchResult;
      },
      loadState: () => (this.state ? JSON.parse(JSON.stringify(this.state)) : null),
      saveState: (s) => {
        this.state = JSON.parse(JSON.stringify(s));
      },
      emit: async (lines) => {
        this.out.push(...lines);
      },
      log: (m) => {
        this.logs.push(m);
      },
    };
  }
}

const labels = (out: string[]) => out.map((l) => l.split(' ')[2]);

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

test('first run baselines: nothing already in the inbox is reported', async () => {
  const inbox = new FakeInbox();
  inbox.show(thread('1', at(-120)));
  inbox.show(thread('2', at(-1)));
  await new GithubWatcher(OPTS, inbox.io()).tick();
  assert.deepEqual(inbox.out, []);
  assert.equal(inbox.state?.floor, '2026-10-01T12:00:00.000Z');
  assert.equal(inbox.requests[0].since, windowStart(T0 - LOOKBACK_MS));
});

test('a thread that changes after the baseline is reported once', async () => {
  const inbox = new FakeInbox();
  const w = new GithubWatcher(OPTS, inbox.io());
  await w.tick();
  inbox.advance(5);
  inbox.show(thread('7', at(5)));
  await w.tick();
  inbox.advance(1);
  await w.tick();
  assert.equal(inbox.out.length, 1);
  assert.match(inbox.out[0], /^\[gh\] otherorg\/gpu-cluster PR#7 author 12:05: PR 7 https:\/\/github\.com\/otherorg\/gpu-cluster\/pull\/7$/);
});

test('an update that becomes visible late, carrying an older time, is still reported once', async () => {
  // The live failure of 2026-10-02: thread 9 is updated at 12:05 but GitHub shows it only at
  // 12:20, after thread 8 (12:10) was already reported.
  const inbox = new FakeInbox();
  const w = new GithubWatcher(OPTS, inbox.io());
  await w.tick();
  inbox.advance(10);
  inbox.show(thread('8', at(10)));
  await w.tick();
  inbox.advance(10);
  inbox.show(thread('9', at(5)));
  await w.tick();
  inbox.advance(1);
  await w.tick();
  assert.deepEqual(labels(inbox.out), ['PR#8', 'PR#9']);
});

test('a late update is still caught hours later, as long as it is inside the lookback', async () => {
  const inbox = new FakeInbox();
  const w = new GithubWatcher(OPTS, inbox.io());
  await w.tick();
  for (let i = 1; i <= 12; i++) {
    inbox.advance(15);
    inbox.show(thread(`n${i}`, at(15 * i)));
    await w.tick();
  }
  // Three hours in, an update from 12:30 surfaces.
  inbox.show(thread('late', at(30)));
  await w.tick();
  assert.equal(inbox.out.length, 13);
  assert.match(inbox.out[12], /: PR late https/);
});

test('a late update from before the baseline is history, however late it shows up', async () => {
  const inbox = new FakeInbox();
  const w = new GithubWatcher(OPTS, inbox.io());
  await w.tick();
  inbox.advance(20);
  inbox.show(thread('old', at(-3)));
  await w.tick();
  assert.deepEqual(inbox.out, []);
});

test('an unchanged window is asked with the ETag and reports nothing', async () => {
  const inbox = new FakeInbox();
  const w = new GithubWatcher(OPTS, inbox.io());
  await w.tick();
  inbox.advance(1);
  await w.tick();
  assert.ok(inbox.requests[1].ifNoneMatch);
  assert.equal(inbox.requests[1].ifNoneMatch, inbox.state?.etag);
  assert.deepEqual(inbox.out, []);
  assert.equal(inbox.state?.lastPollAt, new Date(inbox.clock).toISOString(), 'a 304 still records the poll');
});

test('the window start is rounded to the hour, so the URL is stable between polls', async () => {
  const inbox = new FakeInbox();
  const w = new GithubWatcher(OPTS, inbox.io());
  await w.tick();
  inbox.advance(1);
  await w.tick();
  inbox.advance(1);
  await w.tick();
  assert.equal(new Set(inbox.requests.map((r) => r.since)).size, 1);
  assert.equal(windowStart(Date.parse('2026-10-01T05:59:59Z')), '2026-10-01T05:00:00.000Z');
});

test('a later update to the same thread is reported again', async () => {
  const inbox = new FakeInbox();
  const w = new GithubWatcher(OPTS, inbox.io());
  await w.tick();
  inbox.advance(5);
  inbox.show(thread('7', at(5)));
  await w.tick();
  inbox.advance(1);
  inbox.show(thread('7', at(6), { reason: 'comment' }));
  await w.tick();
  assert.equal(inbox.out.length, 2);
  assert.match(inbox.out[1], / PR#7 comment 12:06: /);
});

test('a burst is printed oldest first', async () => {
  const inbox = new FakeInbox();
  const w = new GithubWatcher(OPTS, inbox.io());
  await w.tick();
  inbox.advance(10);
  inbox.show(thread('3', at(9)));
  inbox.show(thread('2', at(7)));
  await w.tick();
  assert.deepEqual(labels(inbox.out), ['PR#2', 'PR#3']);
});

test('a restarted watcher reports what changed while it was down, including late updates in the gap', async () => {
  const inbox = new FakeInbox();
  await new GithubWatcher(OPTS, inbox.io()).tick();
  // Down for ten hours; one update from early in the gap surfaced late.
  inbox.advance(600);
  inbox.show(thread('gap', at(30)));
  inbox.show(thread('recent', at(590)));
  const w = new GithubWatcher(OPTS, inbox.io());
  await w.tick();
  assert.equal(inbox.out.length, 2);
  assert.match(inbox.out.join('\n'), /: PR gap https/);
  assert.match(inbox.out.join('\n'), /: PR recent https/);
  assert.ok(Date.parse(inbox.requests.at(-1)!.since) <= T0, 'the first poll after a restart reaches back over the gap');

  // After that first poll the window is the normal lookback again.
  inbox.advance(1);
  await w.tick();
  assert.equal(inbox.requests.at(-1)!.since, windowStart(inbox.clock - LOOKBACK_MS));
});

test('a running watcher that fails for longer than the window recovers the whole outage', async () => {
  const inbox = new FakeInbox();
  const w = new GithubWatcher(OPTS, inbox.io());
  await w.tick();
  inbox.failNext = 1_000;
  for (let i = 0; i < 7; i++) {
    inbox.advance(60);
    await w.tick();
  }
  // Seven hours of failures; an update from half an hour into the outage is visible now.
  inbox.show(thread('early', at(30)));
  inbox.failNext = 0;
  await w.tick();
  assert.match(inbox.out.filter((l) => l.startsWith('[gh]')).join('\n'), /: PR early https/);
  assert.ok(Date.parse(inbox.requests.at(-1)!.since) <= T0 - LOOKBACK_MS + 60 * 60_000);
});

test('a legacy state migrates to cursor - 2 min, so a late update just behind the cursor is kept', async () => {
  const inbox = new FakeInbox();
  inbox.advance(11);
  // What loadGithubWatchState produces for { cursor: 12:10, floor: 10:00 } from an older build.
  inbox.state = { floor: new Date(T0 + 8 * 60_000).toISOString(), seen: {} };
  inbox.show(thread('just-behind', at(9)));
  await new GithubWatcher(OPTS, inbox.io()).tick();
  assert.equal(inbox.out.length, 1);
  assert.match(inbox.out[0], /: PR just-behind https/);
});

test('--since replays from that time, and is a floor for later polls too', async () => {
  const inbox = new FakeInbox();
  inbox.show(thread('before', at(-61)));
  inbox.show(thread('at', at(-60)));
  inbox.show(thread('after', at(-59)));
  const w = new GithubWatcher(OPTS, inbox.io(), { since: at(-60) });
  await w.tick();
  assert.equal(inbox.out.length, 1);
  assert.match(inbox.out[0], /: PR after https/);
  assert.equal(inbox.state?.floor, '2026-10-01T11:00:00.000Z');

  // The floor survives a restart: a late update from before it stays history.
  inbox.advance(1);
  inbox.show(thread('late-before', at(-90)));
  await new GithubWatcher(OPTS, inbox.io()).tick();
  assert.equal(inbox.out.length, 1);
});

test('a --since older than the lookback is asked for on the first poll only', async () => {
  const inbox = new FakeInbox();
  inbox.show(thread('yesterday', at(-1000)));
  const w = new GithubWatcher(OPTS, inbox.io(), { since: at(-1440) });
  await w.tick();
  assert.equal(inbox.out.length, 1);
  assert.equal(inbox.requests[0].since, windowStart(T0 - 1440 * 60_000));
  inbox.advance(1);
  await w.tick();
  assert.equal(inbox.requests[1].since, windowStart(inbox.clock - LOOKBACK_MS));
  assert.equal(inbox.out.length, 1);
});

test('the seen-map is bounded by the window: entries older than it are dropped', () => {
  const state: GithubWatchState = {
    floor: at(-600),
    seen: { stale: at(-400), kept: at(-200) },
  };
  const windowFrom = T0 - LOOKBACK_MS;
  const { next } = diffThreads(state, [thread('n', at(0))], OPTS, windowFrom);
  assert.equal(next.seen.stale, undefined);
  assert.equal(next.seen.kept, at(-200));
  assert.equal(next.seen.n, at(0));
});

test('filtered-out threads are recorded, so a filter never replays them later', () => {
  const state: GithubWatchState = { floor: at(0), seen: {} };
  const t = thread('4', at(1), { repo: 'acme/backend' });
  const { report, next } = diffThreads(state, [t], { repos: ['otherorg/*'], reasons: [], types: [] }, T0 - LOOKBACK_MS);
  assert.deepEqual(report, []);
  assert.equal(next.seen['4'], at(1));
});

test('a changed --participating re-baselines instead of replaying what the server hid', async () => {
  const inbox = new FakeInbox();
  inbox.show(thread('hidden', at(-1)));
  await new GithubWatcher({ ...OPTS, participating: true }, inbox.io()).tick();
  assert.equal(inbox.state?.participating, true);

  inbox.advance(1);
  const w = new GithubWatcher(OPTS, inbox.io());
  assert.equal(w.rebaselined, true);
  await w.tick();
  inbox.advance(1);
  await w.tick();
  assert.deepEqual(inbox.out, []);
  assert.equal(inbox.state?.participating, false);
  assert.equal(new GithubWatcher(OPTS, inbox.io()).rebaselined, false);
});

test('transient failures back off, report once after three, then say recovered', async () => {
  const inbox = new FakeInbox();
  const w = new GithubWatcher(OPTS, inbox.io());
  await w.tick();
  inbox.failNext = 3;
  const delays = [await w.tick(), await w.tick(), await w.tick()];
  assert.ok(delays[0] < delays[2], 'delays grow');
  assert.deepEqual(inbox.out, ['[gh-watch] ERROR connect ETIMEDOUT (retrying)']);
  assert.equal(await w.tick(), OPTS.intervalMs);
  assert.deepEqual(inbox.out, ['[gh-watch] ERROR connect ETIMEDOUT (retrying)', '[gh-watch] recovered']);
});

test('lastFailure reports a failed poll and clears on success', async () => {
  const inbox = new FakeInbox();
  const w = new GithubWatcher(OPTS, inbox.io());
  inbox.failNext = 1;
  await w.tick();
  assert.equal(w.lastFailure(), 'connect ETIMEDOUT');
  await w.tick();
  assert.equal(w.lastFailure(), null);
});

test('a permanent failure is thrown, not retried silently', async () => {
  const inbox = new FakeInbox();
  inbox.failNext = 1;
  inbox.failWith = 'GitHub answered HTTP 401 unauthorized; run `gh auth login`';
  await assert.rejects(() => new GithubWatcher(OPTS, inbox.io()).tick(), /unauthorized/);
});

test('a gh failure without an HTTP answer keeps retrying even if its text reads as permanent', async () => {
  const inbox = new FakeInbox();
  const w = new GithubWatcher(OPTS, {
    ...inbox.io(),
    fetch: async () => {
      throw ghFailure('notifications?x=1', 1, 'proxy: 407 unauthorized\n');
    },
  });
  assert.ok((await w.tick()) > 0);
  assert.match(w.lastFailure() ?? '', /unauthorized/);
});

test('error text from gh or GitHub is redacted before it can reach stdout', async () => {
  // Pre-merge Codex: stderr lines and GitHub's error text used to reach ERROR lines unredacted.
  const fromGh = ghFailure('notifications?x=1', 1, 'proxyconnect tcp: dial postgres://app:hunter2@db:5432/x refused\n');
  assert.doesNotMatch(fromGh.message, /hunter2/);
  const fromGithub = httpError({ status: 500, headers: {}, body: '{"message":"boom postgres://app:hunter2@db/x"}' });
  assert.doesNotMatch(fromGithub.message, /hunter2/);

  // Pre-merge Codex, second pass: a non-string message must not crash classification.
  const numeric401 = httpError({ status: 401, headers: {}, body: '{"message":123}' });
  assert.equal(isPermanentError(numeric401), true);
  assert.match(numeric401.message, /123/);
  const limited = httpError({ status: 429, headers: { 'retry-after': '30' }, body: '{"message":{"x":1}}' });
  assert.equal(limited.retryAfterMs, 30_000);
  // An object whose toString is not callable: String() would throw.
  const odd = httpError({ status: 401, headers: {}, body: '{"message":{"toString":null}}' });
  assert.equal(isPermanentError(odd), true);

  const inbox = new FakeInbox();
  const w = new GithubWatcher(OPTS, {
    ...inbox.io(),
    fetch: async () => {
      throw new Error('raw postgres://app:hunter2@db/x');
    },
  });
  for (let i = 0; i < 3; i++) await w.tick();
  assert.equal(inbox.out.length, 1);
  assert.doesNotMatch(inbox.out[0], /hunter2/);
  assert.doesNotMatch(inbox.logs.join('\n'), /hunter2/);
  assert.doesNotMatch(w.lastFailure() ?? '', /hunter2/);
});

test('a rate-limit wait from the server is honoured over the backoff', async () => {
  const inbox = new FakeInbox();
  const w = new GithubWatcher(OPTS, {
    ...inbox.io(),
    fetch: async () => {
      throw Object.assign(new Error('GitHub answered HTTP 403: API rate limit exceeded'), { retryAfterMs: 120_000 });
    },
  });
  assert.equal(await w.tick(), 120_000);
});

test('X-Poll-Interval raises the interval, never lowers it, and every interval is capped', async () => {
  const inbox = new FakeInbox();
  const io = inbox.io();
  const withInterval = (sec: number) => ({ ...io, fetch: async (r: FetchRequest) => ({ ...(await io.fetch(r)), pollIntervalSec: sec }) });
  assert.equal(await new GithubWatcher(OPTS, withInterval(120)).tick(), 120_000);
  assert.equal(await new GithubWatcher(OPTS, withInterval(10)).tick(), 60_000);
  assert.equal(await new GithubWatcher(OPTS, withInterval(10_000_000)).tick(), MAX_INTERVAL_MS);
  assert.equal(await new GithubWatcher({ ...OPTS, intervalMs: 10 * MAX_INTERVAL_MS }, io).tick(), MAX_INTERVAL_MS);
});

test('a truncated fetch says so instead of pretending it saw everything', async () => {
  const inbox = new FakeInbox();
  const io = inbox.io();
  let truncated = false;
  const w = new GithubWatcher(OPTS, { ...io, fetch: async (r) => ({ ...(await io.fetch(r)), truncated }) });
  await w.tick();
  truncated = true;
  inbox.advance(10);
  inbox.show(thread('1', at(10)));
  await w.tick();
  assert.match(inbox.out[0], /^\[gh-watch\] more changes since .* the oldest were skipped/);
  assert.match(inbox.out[1], /PR#1/);
});

test('a window that spans pages is never asked with the ETag, which covers page 1 only', async () => {
  // Codex round 4: page 1 can stay byte-identical (and 304) while a late update lands on page 2.
  const inbox = new FakeInbox();
  const io = inbox.io();
  let multiPage = true;
  const w = new GithubWatcher(OPTS, { ...io, fetch: async (r) => ({ ...(await io.fetch(r)), multiPage }) });
  await w.tick();
  assert.equal(inbox.state?.etag, undefined);
  inbox.advance(1);
  await w.tick();
  assert.equal(inbox.requests[1].ifNoneMatch, undefined);

  // Back to one page: the ETag is used again.
  multiPage = false;
  inbox.advance(1);
  await w.tick();
  inbox.advance(1);
  await w.tick();
  assert.ok(inbox.requests[3].ifNoneMatch);
});

test('state is saved only after the lines are written', async () => {
  const inbox = new FakeInbox();
  const order: string[] = [];
  const io = inbox.io();
  const w = new GithubWatcher(OPTS, {
    ...io,
    emit: async (lines) => {
      order.push('emit');
      await io.emit(lines);
    },
    saveState: (s) => {
      order.push('save');
      io.saveState(s);
    },
  });
  await w.tick();
  order.length = 0;
  inbox.advance(10);
  inbox.show(thread('1', at(10)));
  await w.tick();
  assert.deepEqual(order, ['emit', 'save']);
});

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

function page(threads: GhThread[], next: string | null, etag = 'W/"e1"'): GhResponse {
  const headers: Record<string, string> = { date: 'Thu, 01 Oct 2026 12:00:00 GMT', etag, 'x-poll-interval': '60' };
  if (next) headers.link = `<https://api.github.com/${next}>; rel="next"`;
  return { status: 200, headers, body: JSON.stringify(threads) };
}

test('fetch sends since, participating and If-None-Match, and maps a 304', async () => {
  const calls: Array<{ path: string; headers?: Record<string, string> }> = [];
  const api: GhApi = async (p, headers) => {
    calls.push({ path: p, headers });
    return { status: 304, headers: { date: 'Thu, 01 Oct 2026 12:00:00 GMT' }, body: '' };
  };
  const r = await fetchNotifications(api, { since: '2026-10-01T06:00:00.000Z', ifNoneMatch: 'W/"x"' }, true);
  assert.equal(r.notModified, true);
  assert.equal(r.etag, 'W/"x"');
  assert.match(calls[0].path, /participating=true/);
  assert.match(calls[0].path, /since=2026-10-01T06%3A00%3A00.000Z/);
  assert.match(calls[0].path, /all=true/);
  assert.equal(calls[0].headers?.['If-None-Match'], 'W/"x"');
});

test('fetch follows pages, keeps the first page\'s ETag, and flags the page cap', async () => {
  const calls: string[] = [];
  const api: GhApi = async (p) => {
    calls.push(p);
    const n = calls.length;
    return page([thread(`p${n}`, at(-n))], `notifications?page=${n + 1}`, `W/"e${n}"`);
  };
  const r = await fetchNotifications(api, { since: '2026-10-01T06:00:00.000Z' }, false);
  assert.equal(calls.length, 20);
  assert.equal(r.threads.length, 20);
  assert.equal(r.etag, 'W/"e1"');
  assert.equal(r.truncated, true);
  assert.equal(r.multiPage, true);

  const short = await fetchNotifications(async () => page([thread('a', at(0))], null), { since: 'x' }, false);
  assert.equal(short.truncated, false);
  assert.equal(short.multiPage, false);

  // Exactly one full page and no next link: still treated as multi-page.
  const full = Array.from({ length: 50 }, (_, i) => thread(`f${i}`, at(-i)));
  const exact = await fetchNotifications(async () => page(full, null), { since: 'x' }, false);
  assert.equal(exact.truncated, false);
  assert.equal(exact.multiPage, true);
});

test('httpError: 401 and scope-403 are permanent, a rate-limit 403 carries the wait', () => {
  const e401 = httpError({ status: 401, headers: {}, body: '{"message":"Bad credentials"}' });
  assert.equal(isPermanentError(e401), true);
  const scope = httpError({ status: 403, headers: { 'x-ratelimit-remaining': '4999' }, body: '{"message":"Missing scope"}' });
  assert.equal(isPermanentError(scope), true);
  const limited = httpError({ status: 403, headers: { 'x-ratelimit-remaining': '0', 'retry-after': '90' }, body: '{"message":"API rate limit exceeded"}' });
  assert.equal(isPermanentError(limited), false);
  assert.equal(limited.retryAfterMs, 90_000);
});

test('gh with no login at all (exit 4, no status line) is permanent; a dropped link is not', () => {
  const noLogin = ghFailure('notifications?per_page=50', 4, 'To get started with GitHub CLI, please run:  gh auth login\n');
  assert.match(noLogin.message, /not configured/);
  assert.equal(isPermanentError(noLogin), true);
  const dropped = ghFailure('notifications?per_page=50', 1, 'error connecting to api.github.com\n');
  assert.equal(dropped.message, 'gh api notifications: error connecting to api.github.com');
  assert.equal(isPermanentError(dropped), false);

  // The cases that used to print only "Command failed: <the whole command line>".
  const slow = ghFailure('notifications?x=1', undefined, '', { killed: true, signal: 'SIGTERM', timeoutMs: 60_000 });
  assert.equal(slow.message, 'gh api notifications: no answer within 60s');
  const killed = ghFailure('notifications?x=1', undefined, '', { killed: false, signal: 'SIGKILL' });
  assert.equal(killed.message, 'gh api notifications: gh was stopped by SIGKILL');
  const silent = ghFailure('notifications?x=1', 1, '');
  assert.equal(silent.message, 'gh api notifications: gh exited 1 without an HTTP answer or an error message');
  // Codex round 6: stderr text that reads as permanent must not stop the watcher.
  const proxy = ghFailure('notifications?x=1', 1, 'proxy: 407 unauthorized, not configured\n');
  assert.equal(stopsWatcher(proxy), false);
  assert.equal(stopsWatcher(noLogin), true);
  for (const e of [slow, killed, silent, proxy]) {
    assert.equal(stopsWatcher(e), false, e.message);
    assert.doesNotMatch(e.message, /If-None-Match|--include/);
  }
});

test('parseGhInclude: status, headers and body, including a 304 with no body', () => {
  const ok = parseGhInclude('HTTP/2.0 200 OK\r\nX-Poll-Interval: 60\r\nETag: W/"abc"\r\n\r\n[{"id":"1"}]');
  assert.equal(ok?.status, 200);
  assert.equal(ok?.headers['x-poll-interval'], '60');
  assert.equal(ok?.headers['etag'], 'W/"abc"');
  assert.equal(ok?.body, '[{"id":"1"}]');
  const notModified = parseGhInclude('HTTP/2.0 304 Not Modified\nDate: x\n\n');
  assert.equal(notModified?.status, 304);
  assert.equal(notModified?.body, '');
  assert.equal(parseGhInclude('error connecting to api.github.com'), null);
});

test('nextPagePath: follows rel="next" as a path gh accepts', () => {
  const link = '<https://api.github.com/notifications?per_page=2&page=2>; rel="next", <https://api.github.com/notifications?per_page=2&page=228>; rel="last"';
  assert.equal(nextPagePath(link), 'notifications?per_page=2&page=2');
  assert.equal(nextPagePath('<https://api.github.com/notifications?page=1>; rel="prev"'), null);
  assert.equal(nextPagePath(undefined), null);
});

// ---------------------------------------------------------------------------
// State file
// ---------------------------------------------------------------------------

test('state file round-trips, reads the pre-lookback format, and rejects a corrupt one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-watch-'));
  try {
    const p = path.join(dir, 'nested', 'state.json');
    const state: GithubWatchState = { floor: at(0), seen: { a: at(-1) }, etag: 'W/"e"', lastPollAt: at(0), participating: false };
    saveGithubWatchState(p, state);
    assert.deepEqual(loadGithubWatchState(p), state);

    fs.writeFileSync(p, JSON.stringify({ cursor: at(5), lastModified: 'x', seen: { b: at(4) }, participating: true }));
    // The old design admitted updates down to cursor - 2 min, so that is the migrated floor.
    assert.deepEqual(loadGithubWatchState(p), { floor: new Date(T0 + 3 * 60_000).toISOString(), seen: { b: at(4) }, etag: undefined, lastPollAt: undefined, participating: true });

    // A pre-lookback state built with --since has both: the newer of the old floor and cursor - 2 min.
    fs.writeFileSync(p, JSON.stringify({ cursor: at(10), floor: at(-120), seen: {} }));
    assert.equal(loadGithubWatchState(p)?.floor, new Date(T0 + 8 * 60_000).toISOString());
    // In the new format the floor stands as written.
    fs.writeFileSync(p, JSON.stringify({ floor: at(-1440), lastPollAt: at(5), seen: {} }));
    assert.equal(loadGithubWatchState(p)?.floor, at(-1440));

    fs.writeFileSync(p, '{"floor":"not a date","seen":{}}');
    assert.equal(loadGithubWatchState(p), null);
    fs.writeFileSync(p, '{');
    assert.equal(loadGithubWatchState(p), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Formatting and filters
// ---------------------------------------------------------------------------

test('filters: repo glob, reason and type are case-insensitive and combine', () => {
  const t = thread('1', at(0), { repo: 'otherorg/sample-service' });
  assert.equal(threadMatches(t, { repos: ['otherorg/*'], reasons: [], types: [] }), true);
  assert.equal(threadMatches(t, { repos: ['acme/*'], reasons: [], types: [] }), false);
  assert.equal(threadMatches(t, { repos: [], reasons: ['AUTHOR'], types: ['pullrequest'] }), true);
  assert.equal(threadMatches(t, { repos: [], reasons: ['comment'], types: [] }), false);
  // A dot in a pattern is literal, not "any character".
  assert.equal(threadMatches(t, { repos: ['otherorg/sample.service'], reasons: [], types: [] }), false);
});

test('labels and links per subject type', () => {
  const repo = 'otherorg/sample-service';
  const pr = thread('12', at(0), { repo });
  pr.subject.latest_comment_url = `https://api.github.com/repos/${repo}/issues/comments/555`;
  assert.equal(subjectLabel(pr), 'PR#12');
  assert.equal(subjectHtmlUrl(pr), `https://github.com/${repo}/pull/12#issuecomment-555`);

  const ci = thread('x', at(0), { repo, reason: 'ci_activity' });
  ci.subject = { title: 'Run failed', url: null, latest_comment_url: null, type: 'CheckSuite' };
  assert.equal(subjectLabel(ci), 'CI');
  assert.equal(subjectHtmlUrl(ci), `https://github.com/${repo}/actions`);

  const issue = thread('y', at(0), { repo });
  issue.subject = { title: 'Bug', url: `https://api.github.com/repos/${repo}/issues/3`, latest_comment_url: null, type: 'Issue' };
  assert.equal(subjectLabel(issue), 'Issue#3');
  assert.equal(subjectHtmlUrl(issue), `https://github.com/${repo}/issues/3`);

  const rel = thread('z', at(0), { repo });
  rel.subject = { title: 'v1', url: `https://api.github.com/repos/${repo}/releases/99`, latest_comment_url: null, type: 'Release' };
  assert.equal(subjectLabel(rel), 'Release');
  assert.equal(subjectHtmlUrl(rel), `https://github.com/${repo}/releases`);
});

test('format: folds newlines, truncates, and has a JSON form', () => {
  const t = thread('1', at(0));
  t.subject.title = 'line one\nline two ' + 'x'.repeat(50);
  assert.match(formatGithubEvent(t, { ...OPTS, maxText: 20 }), /line one ⏎ line two ?… \[\+\d+ chars\]/);

  const json = JSON.parse(formatGithubEvent(thread('2', at(0)), { ...OPTS, json: true }));
  assert.equal(json.type, 'github');
  assert.equal(json.label, 'PR#2');
  assert.equal(json.url, 'https://github.com/otherorg/gpu-cluster/pull/2');
});

test('a secret in a title is redacted before the title is cut', () => {
  const t = thread('1', at(0));
  t.subject.title = 'postgres://app:hunter2@db/x';
  for (const maxText of [12, 18, 22, 26, 300]) {
    assert.doesNotMatch(formatGithubEvent(t, { ...OPTS, maxText }), /hunter2|hunter|hunt/, `maxText ${maxText}`);
    assert.doesNotMatch(formatGithubEvent(t, { ...OPTS, maxText, json: true }), /hunter2|hunter|hunt/, `json maxText ${maxText}`);
  }
});

// ---------------------------------------------------------------------------
// Silent bumps (--drop-silent-bumps)
// ---------------------------------------------------------------------------

/** A fake api answering the subject URL with the PR record `pr()`, and its reviews with `reviews()` of them. */
function subjectApi(pr: () => Record<string, unknown> | undefined, calls: string[] = [], reviews: () => number = () => 0): GhApi {
  return async (path) => {
    calls.push(path);
    if (path.includes('/reviews')) {
      const n = reviews();
      const headers: Record<string, string> = n > 1
        ? { link: `<https://api.github.com/${path}&page=2>; rel="next", <https://api.github.com/${path}&page=${n}>; rel="last"` }
        : {};
      return { status: 200, headers, body: JSON.stringify(n > 0 ? [{ id: 1 }] : []) };
    }
    return { status: 200, headers: {}, body: JSON.stringify(pr() ?? {}) };
  };
}

const prRecord = (updated: string, extra: Record<string, unknown> = {}) => ({
  number: 324, updated_at: updated, state: 'open', merged_at: null, draft: false, head: { sha: 'aaa' },
  comments: 3, review_comments: 2, commits: 4, requested_reviewers: [], requested_teams: [], assignees: [], labels: [], ...extra,
});

const pr324 = (updatedAt: string) => thread('324', updatedAt, { repo: 'acme/mobile', reason: 'comment' });

/** Watcher with --drop-silent-bumps over a fake inbox; `pr` is the PR record the api answers with. */
function bumpWatcher(inbox: FakeInbox, pr: () => Record<string, unknown> | undefined, calls: string[] = []) {
  const api = subjectApi(pr, calls);
  return new GithubWatcher({ ...OPTS, timeZone: 'Asia/Tashkent' }, { ...inbox.io(), subjectFingerprint: (t) => subjectFingerprint(api, t) });
}

test('silent bumps: PR 324 replayed gives the comment and the merge, not the two bumps after it', async () => {
  let pr = prRecord('2026-10-08T12:50:00Z');
  const inbox = new FakeInbox();
  inbox.clock = Date.parse('2026-10-08T12:55:00Z');
  inbox.show(pr324('2026-10-08T12:50:00Z'));
  const w = bumpWatcher(inbox, () => pr);
  await w.tick();
  const merged = prRecord('2026-10-08T14:19:22Z', { state: 'closed', merged_at: '2026-10-08T14:19:19Z', comments: 4 });
  for (const [update, record] of [
    ['2026-10-08T13:02:33Z', prRecord('2026-10-08T13:02:29Z', { comments: 4 })],
    ['2026-10-08T14:19:22Z', merged],
    ['2026-10-08T14:21:40Z', merged],
    ['2026-10-08T14:27:01Z', merged],
  ] as const) {
    pr = record;
    inbox.show(pr324(update));
    // Poll every minute until the next update, as the unit does.
    const until = Date.parse(update) + 5 * 60_000;
    for (inbox.clock = Date.parse(update) + 30_000; inbox.clock < until; inbox.advance(1)) await w.tick();
  }
  assert.deepEqual(inbox.out.map((l) => l.split(' ')[4]), ['18:02:', '19:19:']);
  assert.equal(inbox.logs.filter((l) => l.startsWith('dropped a silent bump')).length, 2);
});

test('silent bumps: a change in the same second is not confused with the last one when anything else moved', async () => {
  // A body-less approval by a requested reviewer in the same second: updated_at is equal, but the
  // reviewer leaves requested_reviewers, so the fingerprint differs.
  const t = pr324('2026-10-08T14:19:23Z');
  const before = await subjectFingerprint(subjectApi(() => prRecord('2026-10-08T14:19:22Z', { requested_reviewers: [{ id: 7 }] })), t);
  const after = await subjectFingerprint(subjectApi(() => prRecord('2026-10-08T14:19:22Z')), t);
  assert.notEqual(before?.fingerprint, after?.fingerprint);
  // An unrequested reviewer's body-less approval in the same second moves only the review count.
  const one = await subjectFingerprint(subjectApi(() => prRecord('2026-10-08T14:19:22Z'), [], () => 1), t);
  const two = await subjectFingerprint(subjectApi(() => prRecord('2026-10-08T14:19:22Z'), [], () => 2), t);
  assert.notEqual(one?.fingerprint, two?.fingerprint);
  const many = await subjectFingerprint(subjectApi(() => prRecord('2026-10-08T14:19:22Z'), [], () => 37), t);
  assert.match(many?.fingerprint ?? '', /,37\]$/);
});

test('silent bumps: a subject that lags the notification is rechecked, then reported once it catches up', async () => {
  let pr = prRecord('2026-10-08T12:00:00Z');
  const inbox = new FakeInbox();
  inbox.clock = Date.parse('2026-10-08T12:05:00Z');
  inbox.show(pr324('2026-10-08T12:00:00Z'));
  const w = bumpWatcher(inbox, () => pr);
  await w.tick();
  inbox.show(pr324('2026-10-08T12:06:00Z'));
  await w.tick();                       // fingerprint recorded (first look): reported
  assert.equal(inbox.out.length, 1);
  // A review lands; the notification shows it before the PR record does.
  inbox.show(pr324('2026-10-08T12:10:00Z'));
  inbox.clock = Date.parse('2026-10-08T12:10:20Z');
  await w.tick();
  assert.equal(inbox.out.length, 1, 'held, not dropped');
  pr = prRecord('2026-10-08T12:10:01Z');
  inbox.advance(1);
  await w.tick();
  assert.equal(inbox.out.length, 2, 'reported once the PR record caught up');
});

test('silent bumps: an unchanged bump is dropped only after the recheck window', async () => {
  const pr = prRecord('2026-10-08T12:00:00Z');
  const inbox = new FakeInbox();
  inbox.clock = Date.parse('2026-10-08T12:05:00Z');
  inbox.show(pr324('2026-10-08T12:00:00Z'));
  const w = bumpWatcher(inbox, () => pr);
  await w.tick();
  inbox.show(pr324('2026-10-08T12:06:00Z'));
  await w.tick();
  inbox.show(pr324('2026-10-08T12:10:00Z'));
  inbox.clock = Date.parse('2026-10-08T12:10:10Z');
  await w.tick();
  assert.equal(inbox.logs.filter((l) => l.startsWith('dropped')).length, 0);
  // The window runs from the first unchanged look, not from the notification's own time.
  inbox.clock = Date.parse('2026-10-08T12:10:10Z') + SILENT_BUMP_RECHECK_MS - 1000;
  await w.tick();
  assert.equal(inbox.logs.filter((l) => l.startsWith('dropped')).length, 0);
  inbox.clock = Date.parse('2026-10-08T12:10:10Z') + SILENT_BUMP_RECHECK_MS + 1000;
  await w.tick();
  assert.equal(inbox.logs.filter((l) => l.startsWith('dropped')).length, 1);
  assert.equal(inbox.out.length, 1);
});

test('silent bumps: one request to the subject itself; unreadable answers keep the line', async () => {
  const calls: string[] = [];
  await subjectFingerprint(subjectApi(() => prRecord('2026-10-08T14:30:00Z'), calls), pr324('2026-10-08T14:30:05Z'));
  assert.deepEqual(calls, ['repos/acme/mobile/pulls/324', 'repos/acme/mobile/pulls/324/reviews?per_page=1']);
  assert.equal(await subjectFingerprint(subjectApi(() => ({})), pr324('2026-10-08T14:30:05Z')), null);
  const release = thread('7', '2026-10-08T14:30:05Z', { subject: { title: 'v1', url: 'https://api.github.com/repos/o/r/releases/7', latest_comment_url: null, type: 'Release' } });
  assert.equal(await subjectFingerprint(subjectApi(() => prRecord('x')), release), null);
});

test('silent bumps: a failed check keeps lines and pauses checks across polls for the server\'s wait', async () => {
  const inbox = new FakeInbox();
  const asked: string[] = [];
  let fail = true;
  const io = {
    ...inbox.io(),
    subjectFingerprint: async (t: GhThread) => {
      asked.push(t.id);
      if (fail) { const e = Object.assign(new Error('rate limited'), { retryAfterMs: 30 * 60_000 }); throw e; }
      return { fingerprint: 'same', updatedAt: '2000-01-01T00:00:00Z' };
    },
  };
  inbox.show(thread('1', at(-10)));
  inbox.show(thread('3', at(-10)));
  const w = new GithubWatcher(OPTS, io);
  await w.tick();
  inbox.show(thread('1', at(1)));
  inbox.show(thread('3', at(2)));
  inbox.advance(3);
  await w.tick();
  assert.equal(inbox.out.length, 2);
  assert.deepEqual(asked, ['1']);
  fail = false;
  inbox.show(thread('1', at(5)));
  inbox.advance(5);
  await w.tick();
  assert.equal(inbox.out.length, 3, 'still paused: kept unchecked');
  assert.deepEqual(asked, ['1']);
  inbox.advance(30);
  inbox.show(thread('1', at(40)));
  await w.tick();
  assert.deepEqual(asked, ['1', '1'], 'checks resume after the wait');
});

test('silent bumps: a non-Error rejection keeps the line', async () => {
  const inbox = new FakeInbox();
  const io = { ...inbox.io(), subjectFingerprint: async () => { throw null; } };
  inbox.show(thread('1', at(-10)));
  const w = new GithubWatcher(OPTS, io);
  await w.tick();
  inbox.show(thread('1', at(1)));
  inbox.advance(2);
  await w.tick();
  assert.equal(inbox.out.length, 1);
});

test('silent bumps: CI threads are never checked, and checks stop at the per-poll budget', async () => {
  const inbox = new FakeInbox();
  const asked: string[] = [];
  const io = { ...inbox.io(), subjectFingerprint: async (t: GhThread) => { asked.push(t.id); return { fingerprint: 'same', updatedAt: '2000-01-01T00:00:00Z' }; } };
  const ci = { title: 'CI', url: null, latest_comment_url: null, type: 'CheckSuite' };
  inbox.show(thread('ci', at(-10), { subject: ci }));
  for (let i = 0; i < MAX_SUBJECT_CHECKS_PER_POLL + 3; i++) inbox.show(thread(`p${i}`, at(-10)));
  const w = new GithubWatcher(OPTS, io);
  await w.tick();
  inbox.show(thread('ci', at(1), { subject: ci }));
  for (let i = 0; i < MAX_SUBJECT_CHECKS_PER_POLL + 3; i++) inbox.show(thread(`p${i}`, at(1)));
  inbox.advance(2);
  await w.tick();
  assert.ok(!asked.includes('ci'));
  assert.equal(asked.length, MAX_SUBJECT_CHECKS_PER_POLL);
  assert.equal(inbox.out.length, MAX_SUBJECT_CHECKS_PER_POLL + 4, 'all kept: first fingerprints, unchecked ones, CI');
});

test('silent bumps: off by default, every update is reported as before', async () => {
  const inbox = new FakeInbox();
  inbox.show(thread('1', at(-10)));
  const w = new GithubWatcher(OPTS, inbox.io());
  await w.tick();
  inbox.show(thread('1', at(1)));
  inbox.advance(2);
  await w.tick();
  assert.equal(inbox.out.length, 1);
});

test('silent bumps: recorded fingerprints survive a restart', async () => {
  const pr = prRecord('2026-10-08T12:00:00Z');
  const inbox = new FakeInbox();
  inbox.clock = Date.parse('2026-10-08T12:05:00Z');
  inbox.show(pr324('2026-10-08T12:00:00Z'));
  await bumpWatcher(inbox, () => pr).tick();
  inbox.show(pr324('2026-10-08T12:06:00Z'));
  await bumpWatcher(inbox, () => pr).tick();
  assert.ok(inbox.state?.subjects?.['324']);
  inbox.show(pr324('2026-10-08T12:10:00Z'));
  inbox.clock = Date.parse('2026-10-08T12:10:10Z');
  await bumpWatcher(inbox, () => pr).tick();
  assert.ok(inbox.state?.pending?.['324'], 'the first unchanged look is remembered');
  inbox.clock += SILENT_BUMP_RECHECK_MS + 1000;
  await bumpWatcher(inbox, () => pr).tick();
  assert.equal(inbox.out.length, 1);
  assert.equal(inbox.logs.filter((l) => l.startsWith('dropped')).length, 1);
});

test('silent bumps: a bump already older than the window on its first look is still rechecked', async () => {
  const pr = prRecord('2026-10-08T12:00:00Z');
  const inbox = new FakeInbox();
  inbox.clock = Date.parse('2026-10-08T12:05:00Z');
  inbox.show(pr324('2026-10-08T12:00:00Z'));
  const w = bumpWatcher(inbox, () => pr);
  await w.tick();
  inbox.show(pr324('2026-10-08T12:06:00Z'));
  await w.tick();
  inbox.show(pr324('2026-10-08T12:10:00Z'));
  inbox.clock = Date.parse('2026-10-08T12:40:00Z');   // after downtime
  await w.tick();
  assert.equal(inbox.logs.filter((l) => l.startsWith('dropped')).length, 0);
});

test('silent bumps: a subject newer than the notification is reported and leaves no baseline', async () => {
  let pr = prRecord('2026-10-08T12:00:00Z');
  const inbox = new FakeInbox();
  inbox.clock = Date.parse('2026-10-08T12:05:00Z');
  inbox.show(pr324('2026-10-08T12:00:00Z'));
  const w = bumpWatcher(inbox, () => pr);
  await w.tick();
  inbox.show(pr324('2026-10-08T12:06:00Z'));
  pr = prRecord('2026-10-08T12:06:30Z', { comments: 9 });   // a review B lands while A is processed
  inbox.clock = Date.parse('2026-10-08T12:06:40Z');
  await w.tick();
  assert.equal(inbox.out.length, 1);
  assert.equal(inbox.state?.subjects?.['324'], undefined);
  inbox.show(pr324('2026-10-08T12:06:31Z'));
  inbox.advance(1);
  await w.tick();
  assert.equal(inbox.out.length, 2, "B's own notification is reported, not matched against a baseline that already held it");
});

test('silent bumps: a newer update does not inherit an older bump\'s recheck window', async () => {
  const pr = prRecord('2026-10-08T12:00:00Z');
  const inbox = new FakeInbox();
  inbox.clock = Date.parse('2026-10-08T12:05:00Z');
  inbox.show(pr324('2026-10-08T12:00:00Z'));
  const w = bumpWatcher(inbox, () => pr);
  await w.tick();
  inbox.show(pr324('2026-10-08T12:06:00Z'));
  await w.tick();
  // Silent bump A, first looked at 12:10:10.
  inbox.show(pr324('2026-10-08T12:10:00Z'));
  inbox.clock = Date.parse('2026-10-08T12:10:10Z');
  await w.tick();
  // Real update B just before A's window ends; the PR record has not caught up yet.
  inbox.show(pr324('2026-10-08T12:12:05Z'));
  inbox.clock = Date.parse('2026-10-08T12:10:10Z') + SILENT_BUMP_RECHECK_MS + 1000;
  await w.tick();
  assert.equal(inbox.logs.filter((l) => l.startsWith('dropped')).length, 0, 'B gets its own window');
  assert.equal(inbox.state?.pending?.['324']?.updatedAt, '2026-10-08T12:12:05Z');
});

// ---------------------------------------------------------------------------
// Naming the change (with --drop-silent-bumps)
// ---------------------------------------------------------------------------

const fp = (over: Partial<Record<number, unknown>> = {}) => {
  const base: unknown[] = ['2026-10-08T20:26:09Z', 'open', null, false, 'c5357e7', 2, 6, 33, [], [], [], [], 1];
  for (const [i, v] of Object.entries(over)) base[Number(i)] = v;
  return JSON.stringify(base);
};

test('describeChange names what moved', () => {
  const c = 'https://api.github.com/repos/o/r/issues/comments/1';
  assert.equal(describeChange(fp(), fp({ 0: 'later', 1: 'closed', 2: '2026-10-08T21:00:00Z' }), c, c), 'merged');
  assert.equal(describeChange(fp(), fp({ 0: 'later', 1: 'closed' }), c, c), 'closed');
  assert.equal(describeChange(fp(), fp({ 0: 'later', 4: 'abc1234', 7: 34, 12: 2 }), c, c), 'pushed+reviewed');
  assert.equal(describeChange(fp(), fp({ 0: 'later', 11: ['bug'] }), c, c), 'labelled');
  assert.equal(describeChange(fp(), fp({ 0: 'later', 8: [7] }), c, c), 'review requested');
  assert.equal(describeChange(fp(), fp({ 0: 'later' }), c, c), 'updated');
  assert.equal(describeChange(fp(), fp({ 0: 'later' }), c, 'https://api.github.com/repos/o/r/issues/comments/2'), 'commented');
  assert.equal(describeChange('not json', fp(), c, c), null);
  // Removals read as removals.
  assert.equal(describeChange(fp({ 8: [7] }), fp({ 0: 'later', 8: [] }), c, c), 'review request removed');
  assert.equal(describeChange(fp({ 8: [7] }), fp({ 0: 'later', 8: [9] }), c, c), 'review requests changed');
  assert.equal(describeChange(fp({ 10: [3] }), fp({ 0: 'later', 10: [] }), c, c), 'unassigned');
  assert.equal(describeChange(fp(), fp({ 0: 'later', 10: [3] }), c, c), 'assigned');
  assert.equal(describeChange(fp({ 11: ['bug'] }), fp({ 0: 'later', 11: [] }), c, c), 'unlabelled');
  assert.equal(describeChange(fp({ 11: ['bug'] }), fp({ 0: 'later', 11: ['p0'] }), c, c), 'labels changed');
  // A comment url going away is not a new comment.
  assert.equal(describeChange(fp(), fp({ 0: 'later', 5: 1 }), c, null), 'updated');
});

test('sample-service PR 112 replayed: a bot editing its own comment reads "updated" and links to the PR', async () => {
  const comment = 'https://api.github.com/repos/acme/sample-service/issues/comments/6068414353';
  const pr112 = (updatedAt: string) => thread('112', updatedAt, {
    repo: 'acme/sample-service', reason: 'comment',
    subject: { title: 'PROJ-4381: pipeline optimization plan', url: 'https://api.github.com/repos/acme/sample-service/pulls/112', latest_comment_url: comment, type: 'PullRequest' },
  });
  let pr = prRecord('2026-10-08T20:10:00Z', { head: { sha: 'old' }, commits: 32, comments: 1 });
  const inbox = new FakeInbox();
  inbox.clock = Date.parse('2026-10-08T20:12:00Z');
  inbox.show(pr112('2026-10-08T20:10:00Z'));
  const w = bumpWatcher(inbox, () => pr);
  await w.tick();
  inbox.show(pr112('2026-10-08T20:13:00Z'));
  inbox.advance(2);
  await w.tick();                               // first fingerprint: GitHub's own word
  pr = prRecord('2026-10-08T20:26:09Z', { head: { sha: 'c5357e7' }, commits: 33, comments: 2 });
  inbox.show(pr112('2026-10-08T20:26:12Z'));
  inbox.clock = Date.parse('2026-10-08T20:26:40Z');
  await w.tick();                               // push + new comment
  pr = prRecord('2026-10-08T20:33:43Z', { head: { sha: 'c5357e7' }, commits: 33, comments: 2 });
  inbox.show(pr112('2026-10-08T20:33:45Z'));
  inbox.clock = Date.parse('2026-10-08T20:34:10Z');
  await w.tick();                               // the bot's edit
  assert.equal(inbox.out.length, 3);
  assert.equal(inbox.out[0].split(' ')[3], 'comment');
  assert.equal(inbox.out[1].split(' ')[3], 'pushed+commented');
  assert.equal(inbox.out[2].split(' ')[3], 'updated');
  assert.match(inbox.out[1], /#issuecomment-6068414353$/);
  assert.match(inbox.out[2], /\/pull\/112$/, 'no new comment: link to the PR, not the old comment');
});

test('the json line carries the change beside the reason', () => {
  const line = JSON.parse(formatGithubEvent(pr324('2026-10-08T14:19:22Z'), { maxText: 100, json: true }, 'merged'));
  assert.equal(line.reason, 'comment');
  assert.equal(line.change, 'merged');
  assert.equal(JSON.parse(formatGithubEvent(pr324('2026-10-08T14:19:22Z'), { maxText: 100, json: true })).change, undefined);
});

test('change words: an update reported unchecked resets the baseline', async () => {
  const inbox = new FakeInbox();
  let fail = false;
  let record = prRecord('2026-10-08T12:00:00Z');
  const api = subjectApi(() => record);
  const io = { ...inbox.io(), subjectFingerprint: async (t: GhThread) => { if (fail) throw Object.assign(new Error('rate limited'), { retryAfterMs: 60_000 }); return subjectFingerprint(api, t); } };
  inbox.clock = Date.parse('2026-10-08T12:05:00Z');
  inbox.show(pr324('2026-10-08T12:00:00Z'));
  const w = new GithubWatcher(OPTS, io);
  await w.tick();
  inbox.show(pr324('2026-10-08T12:06:00Z'));
  inbox.advance(2);
  await w.tick();                                   // baseline fingerprint recorded
  assert.ok(inbox.state?.subjects?.['324']);
  fail = true;
  record = prRecord('2026-10-08T12:10:00Z', { comments: 9 });
  inbox.show(pr324('2026-10-08T12:10:01Z'));
  inbox.advance(6);
  await w.tick();                                   // reported unchecked
  assert.equal(inbox.state?.subjects?.['324'], undefined);
  fail = false;
  record = prRecord('2026-10-08T12:20:00Z', { comments: 9, labels: [{ name: 'p0' }] });
  inbox.show(pr324('2026-10-08T12:20:01Z'));
  inbox.advance(15);
  await w.tick();
  assert.equal(inbox.out.at(-1)?.split(' ')[3], 'comment', 'no stale "commented+labelled"');
});

test('change words: an update the filters dropped resets the baseline', async () => {
  const inbox = new FakeInbox();
  let record = prRecord('2026-10-08T12:00:00Z');
  const api = subjectApi(() => record);
  const opts = { ...OPTS, reasons: ['comment'] };
  const w = new GithubWatcher(opts, { ...inbox.io(), subjectFingerprint: (t) => subjectFingerprint(api, t) });
  inbox.clock = Date.parse('2026-10-08T12:05:00Z');
  inbox.show(pr324('2026-10-08T12:00:00Z'));
  await w.tick();
  inbox.show(pr324('2026-10-08T12:06:00Z'));
  inbox.advance(2);
  await w.tick();
  assert.ok(inbox.state?.subjects?.['324']);
  // A label change arrives under a reason the filter drops.
  record = prRecord('2026-10-08T12:10:00Z', { labels: [{ name: 'p0' }] });
  inbox.show({ ...pr324('2026-10-08T12:10:01Z'), reason: 'state_change' });
  inbox.advance(6);
  await w.tick();
  assert.equal(inbox.state?.subjects?.['324'], undefined);
  record = prRecord('2026-10-08T12:20:00Z', { labels: [{ name: 'p0' }], comments: 9 });
  inbox.show(pr324('2026-10-08T12:20:01Z'));
  inbox.advance(15);
  await w.tick();
  assert.equal(inbox.out.at(-1)?.split(' ')[3], 'comment', 'not "commented+labelled"');
});
