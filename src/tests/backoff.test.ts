import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_BACKOFF_MS,
  backoffDelay,
  formatDelay,
  isPermanentError,
  retryForever, parseRetryAfter, } from '../services/backoff.js';

// A deterministic "random" so jitter does not make the tests flaky. 1 gives the
// top of each jitter band, 0 the bottom, 0.5 the middle.
const fixed = (v: number) => () => v;

test('the first retry is quick', () => {
  // The owner asked for fast initial retries: most failures are a blip.
  assert.ok(backoffDelay(1, fixed(1)) <= 1000, 'first retry should be about a second');
  assert.ok(backoffDelay(1, fixed(0)) >= 500, 'equal jitter keeps at least half the delay');
});

test('delays double until the ceiling', () => {
  const mid = (n: number) => backoffDelay(n, fixed(0.5));

  // Equal jitter at 0.5 gives exactly 3/4 of the nominal delay, so the ratio
  // between consecutive attempts is still 2.
  for (let n = 1; n < 8; n++) {
    assert.equal(mid(n + 1), mid(n) * 2, `attempt ${n + 1} should be double attempt ${n}`);
  }
});

test('never exceeds the five-minute ceiling', () => {
  for (const n of [10, 20, 50, 1000]) {
    assert.ok(backoffDelay(n, fixed(1)) <= MAX_BACKOFF_MS, `attempt ${n} exceeded the cap`);
  }
  assert.equal(MAX_BACKOFF_MS, 300_000);
});

test('a very long outage does not overflow into NaN', () => {
  // 2 ** 1024 is Infinity; an uncapped exponent would make the delay NaN and
  // the watcher would busy-loop instead of waiting.
  const delay = backoffDelay(5000, fixed(0.5));
  assert.ok(Number.isFinite(delay), `delay was ${delay}`);
  assert.ok(delay > 0 && delay <= MAX_BACKOFF_MS);
});

test('reaches the ceiling fast enough to ride out a 15-minute outage cheaply', () => {
  // The practical requirement: a quarter-hour drop should cost a handful of
  // attempts, not hundreds.
  let elapsed = 0;
  let attempts = 0;
  while (elapsed < 15 * 60_000) {
    attempts++;
    elapsed += backoffDelay(attempts, fixed(0.5));
  }
  assert.ok(attempts < 15, `took ${attempts} attempts to cover 15 minutes`);
});

test('jitter spreads retries instead of aligning them', () => {
  // Four watchers share one Telegram session, so an outage fails them at the
  // same instant. Identical delays would make them retry in lockstep for ever.
  const delays = new Set(Array.from({ length: 50 }, () => backoffDelay(6)));
  assert.ok(delays.size > 10, `jitter produced only ${delays.size} distinct delays`);
});

// --- which failures are worth retrying -------------------------------------

test('network-shaped failures are transient', () => {
  // The real one that killed a watcher tonight.
  assert.equal(isPermanentError(new Error('Request was unsuccessful 5 time(s)')), false);
  for (const m of ['ETIMEDOUT', 'socket hang up', 'ECONNRESET', 'getaddrinfo EAI_AGAIN', 'TIMEOUT']) {
    assert.equal(isPermanentError(new Error(m)), false, `${m} should retry`);
  }
});

test('an unrecognised failure defaults to retrying', () => {
  // Deliberate: during an outage an unknown error is far more likely to be the
  // outage than a permanent fault, and the cost of guessing wrong is one log
  // line every five minutes rather than a watcher that silently stopped.
  assert.equal(isPermanentError(new Error('something nobody predicted')), false);
  assert.equal(isPermanentError(undefined), false);
});

test('a mistyped chat or revoked session is permanent', () => {
  // These must fail fast: retrying a typo for ever would look identical to a
  // working watcher that never reports anything.
  for (const m of [
    'No chat matched "Carwsh Alerts"',
    'PEER_ID_INVALID',
    'USERNAME_NOT_OCCUPIED',
    'AUTH_KEY_UNREGISTERED',
    'SESSION_REVOKED',
    'Telegram is not configured',
  ]) {
    assert.equal(isPermanentError(new Error(m)), true, `${m} should not retry`);
  }
});

// --- the loop ---------------------------------------------------------------

test('retryForever returns once the attempt succeeds', async () => {
  let calls = 0;
  const value = await retryForever(
    async () => {
      calls++;
      if (calls < 4) throw new Error('ECONNRESET');
      return 'ok';
    },
    { rand: fixed(0) }
  );

  assert.equal(value, 'ok');
  assert.equal(calls, 4);
});

test('retryForever reports each retry with its delay', async () => {
  const seen: Array<{ failures: number; delayMs: number }> = [];
  let calls = 0;

  await retryForever(
    async () => {
      calls++;
      if (calls < 3) throw new Error('socket hang up');
      return null;
    },
    { rand: fixed(0), onRetry: (failures, delayMs) => seen.push({ failures, delayMs }) }
  );

  assert.deepEqual(seen.map((s) => s.failures), [1, 2]);
  assert.ok(seen[1].delayMs > seen[0].delayMs, 'the second wait should be longer');
});

test('retryForever rethrows a permanent error instead of looping', async () => {
  let calls = 0;
  await assert.rejects(
    () => retryForever(async () => { calls++; throw new Error('PEER_ID_INVALID'); }, { rand: fixed(0) }),
    /PEER_ID_INVALID/
  );
  assert.equal(calls, 1, 'a permanent error must not be retried at all');
});

test('formatDelay reads as a duration', () => {
  assert.equal(formatDelay(1000), '1s');
  assert.equal(formatDelay(45_000), '45s');
  assert.equal(formatDelay(60_000), '1m');
  assert.equal(formatDelay(100_000), '1m40s');
  assert.equal(formatDelay(MAX_BACKOFF_MS), '5m');
});

test('Retry-After: seconds and HTTP dates, clamped so a timer cannot overflow into a tight loop', () => {
  const now = Date.parse('2026-09-28T17:00:00Z');
  assert.equal(parseRetryAfter('7', now), 7_000);
  assert.equal(parseRetryAfter(' 120 ', now), 120_000);
  // 2147484 s is past Node's 2^31-1 ms timer limit, which fires after ~1 ms instead: clamped, not passed on.
  assert.equal(parseRetryAfter('2147484', now), MAX_BACKOFF_MS);
  assert.equal(parseRetryAfter('9'.repeat(400), now), null, 'Infinity is no floor at all');
  assert.equal(parseRetryAfter('Mon, 28 Sep 2026 17:00:30 GMT', now), 30_000);
  assert.equal(parseRetryAfter('Mon, 28 Sep 2026 16:59:00 GMT', now), null, 'a date already past');
  for (const junk of [null, '', '0', '-5', '1.5', 'soon']) assert.equal(parseRetryAfter(junk, now), null, String(junk));
});
