// Retry pacing for anything that must outlive a network outage.
//
// The watchers are meant to run unattended for hours. The owner's link drops
// for up to fifteen minutes at a time, and a watcher that gives up during one
// is worse than useless: it looks alive in the process list while silently
// missing every message that arrives after it died.
//
// So nothing here ever stops retrying. What changes is only how often.

/** First delay. Short, because most failures are a blip and recover at once. */
const BASE_MS = 1_000;

/**
 * Slowest retry. The owner asked for a five-minute ceiling: long enough that a
 * dead link costs nothing, short enough that recovery is noticed promptly.
 */
export const MAX_BACKOFF_MS = 5 * 60_000;

/**
 * Delay before retry number `failures` (1 = the first retry).
 *
 * Doubling from a second reaches the five-minute ceiling after about ten
 * consecutive failures, roughly eight minutes in — so a fifteen-minute outage
 * is ridden out with a handful of attempts rather than hundreds.
 *
 * The delay carries **equal jitter**: half fixed, half random. Four watchers
 * share one Telegram session on this machine, so an outage fails them at the
 * same instant; without jitter they would retry in lockstep for ever, and each
 * retry storm would be its own small outage. Half-fixed keeps the backoff
 * shape intact, which full jitter would flatten.
 */
export function backoffDelay(
  failures: number,
  rand: () => number = Math.random,
  /** A lower ceiling for a caller whose retries are cheap and whose recovery should be noticed sooner. */
  maxMs: number = MAX_BACKOFF_MS,
): number {
  const exponent = Math.max(0, failures - 1);
  // Cap the exponent before shifting: 2 ** 1024 is Infinity, and a watcher that
  // has been failing for days should not produce NaN when it finally computes.
  const uncapped = BASE_MS * 2 ** Math.min(exponent, 30);
  const ceiling = Math.min(uncapped, maxMs);
  return Math.round(ceiling / 2 + rand() * (ceiling / 2));
}

/**
 * Errors worth retrying for ever.
 *
 * The default is **retry**: an unrecognised failure during a network outage is
 * far more likely to be the outage than a permanent fault, and the cost of
 * retrying a truly fatal error is one log line every five minutes. The cost of
 * the opposite mistake is a watcher that quietly stopped hours ago.
 *
 * Only failures that cannot possibly fix themselves are treated as permanent —
 * a mistyped chat name, or credentials that have been revoked. Those must fail
 * fast and loudly, or a typo becomes a watcher that waits for ever.
 */
const PERMANENT_PATTERNS = [
  /no chat matched/i,
  /chat not found/i,
  /could not find/i,
  /PEER_ID_INVALID/i,
  /CHAT_ID_INVALID/i,
  /USERNAME_NOT_OCCUPIED/i,
  /USERNAME_INVALID/i,
  /AUTH_KEY_UNREGISTERED/i,
  /AUTH_KEY_INVALID/i,
  /SESSION_REVOKED/i,
  /SESSION_EXPIRED/i,
  /USER_DEACTIVATED/i,
  /\bunauthorized\b/i,
  /not configured/i,
];

export function isPermanentError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return PERMANENT_PATTERNS.some((p) => p.test(message));
}

/** Human-readable delay for a log line: "3s", "1m40s". */
export function formatDelay(ms: number): string {
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s ? `${m}m${s}s` : `${m}m`;
}

/**
 * `Retry-After` as a wait in milliseconds, or null when absent, malformed or already past.
 *
 * Both forms the header allows: delay-seconds and an HTTP date. The result is **clamped to
 * `MAX_BACKOFF_MS`**, for two reasons (Codex review, round 3). Node's timers overflow above 2^31-1 ms
 * and fire after about one millisecond instead, so an honest-looking `Retry-After: 2147484` would have
 * turned the floor under the backoff into a tight loop. And a watcher told to wait a day is a deaf
 * watcher: waiting longer than the backoff's own ceiling buys nothing the ceiling does not.
 */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number | null {
  if (header === null) return null;
  const value = header.trim();
  if (value === '') return null;
  let ms: number;
  if (/^\d+$/.test(value)) {
    ms = Number(value) * 1000;
  } else {
    const at = Date.parse(value);
    if (Number.isNaN(at)) return null;
    ms = at - now;
  }
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.min(ms, MAX_BACKOFF_MS);
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Run `attempt` until it succeeds, backing off between tries.
 *
 * Returns the value on success. Throws only on a permanent error, which is the
 * one case a caller should stop for.
 */
export async function retryForever<T>(
  attempt: () => Promise<T>,
  opts: {
    /** Called before each wait, for the operator-visible log line. */
    onRetry?: (failures: number, delayMs: number, err: Error) => void;
    rand?: () => number;
  } = {}
): Promise<T> {
  for (let failures = 1; ; failures++) {
    try {
      return await attempt();
    } catch (err) {
      if (isPermanentError(err)) throw err;
      const delay = backoffDelay(failures, opts.rand);
      opts.onRetry?.(failures, delay, err as Error);
      await sleep(delay);
    }
  }
}
