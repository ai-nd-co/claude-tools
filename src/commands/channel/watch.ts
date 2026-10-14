/**
 * The supervisor's bookkeeping — every lifecycle rule, and nothing that spawns a process.
 *
 * `index.ts` owns the pipes and the transport. This file owns the decisions: what a watch may be
 * called, when a name may be reused, what happens to a watch that died, and how many may run at once.
 * They are here so each one can be tested for what it is — a rule — rather than inferred from the
 * behaviour of a spawned child.
 *
 * **It knows nothing about what is being watched, and that is deliberate.** A watch is a name and an
 * argv array. `tail -f`, `inotifywait -m`, `gh run watch`, `kubectl get pods -w`, a test runner and a
 * chat bridge are all the same thing here, and none of them is named in this code.
 */
import type { ChildProcess } from 'child_process';

import { backoffDelay, formatDelay } from '../../services/backoff.js';

/**
 * What a watch may be called.
 *
 * Constrained because the name is an identity used in three places — the `watch` attribute on every
 * event, the argument to `watch_stop`, and a line in `watch_list` — and a name carrying whitespace or
 * markup would be ambiguous in all three. The client escapes attribute values, so this is legibility
 * rather than injection defence.
 */
export const WATCH_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

/**
 * How many watches may run at once.
 *
 * Not a security boundary — an agent that can call `watch_start` can usually run a shell too. It is a
 * guard against the runaway case: a loop calling `watch_start` is otherwise a fork bomb with a channel
 * attached, and the first symptom would be the machine, not an error message.
 */
export const MAX_WATCHES = 16;

/**
 * How many dead watches stay on the list.
 *
 * They stay at all because a list that forgets its dead makes "it died" and "you never started it"
 * look identical — the same confusion the exit event exists to prevent. They do not stay forever
 * because a watch with `restart` and a command that fails instantly would otherwise grow the list
 * without bound.
 */
export const MAX_EXITED = 16;

/**
 * Slowest respawn of a watch started with `restart`.
 *
 * The delay doubles from about a second up to this. It used to be a fixed two seconds, and on
 * 2026-09-28 every `hub watch` in the fleet exited on each poll while a stray route answered `/api`.
 * The fixed delay turned that into a respawn every two seconds, three events per cycle, for as long as
 * the route stayed wrong: sessions lost a large share of their context to it, and each respawn
 * re-sent the machine credential to the app that was answering.
 */
export const RESTART_MAX_DELAY_MS = 60_000;

/**
 * A run at least this long counts as having worked, so the next failure starts the backoff again from
 * the bottom. A watch that crashes once a day should come back in a second, not in a minute.
 */
export const RESTART_STABLE_MS = 60_000;

/** The failure count after a run that lasted `ranMs`: a stable run starts the count again at one. */
export function nextConsecutiveFailures(previous: number, ranMs: number): number {
  return ranMs >= RESTART_STABLE_MS ? 1 : previous + 1;
}

/** Delay before respawn number `consecutive` (1 = the first failure in a row). Jittered. */
export function restartDelay(consecutive: number, rand: () => number = Math.random): number {
  return backoffDelay(consecutive, rand, RESTART_MAX_DELAY_MS);
}

/**
 * Whether this failure in a row is worth an event.
 *
 * Every event lands in the agent's context, and a crash loop is the one situation where they arrive
 * without end. The first three are announced, so the agent learns the watch is failing and how.
 * After that, only the 4th, 8th, 16th… are, so a loop that lasts all night costs a handful of lines
 * rather than hundreds. Each announcement carries the count, so a reader can tell it is the same loop.
 */
export function announceRestart(consecutive: number): boolean {
  return consecutive <= 3 || (consecutive & (consecutive - 1)) === 0;
}

export type WatchState =
  | { readonly kind: 'running' }
  | { readonly kind: 'exited'; readonly how: string; readonly at: number };

export interface WatchEntry {
  readonly name: string;
  readonly command: readonly string[];
  /** Whether permission requests are handed to this watch. Off unless asked for, per watch. */
  readonly permissions: boolean;
  /** Whether this watch's stderr becomes events too, instead of going to our own log. */
  readonly stderr: boolean;
  /** Whether this watch is respawned when it ends. */
  readonly restart: boolean;
  readonly startedAt: number;
  /** The live child, when there is one. Absent in tests, and after the child has gone. */
  proc?: ChildProcess;
  /** How many lines this watch has turned into events — the cheapest proof it is doing anything. */
  lines: number;
  state: WatchState;
  /** Set by `watch_stop`, so a restarting watch does not come back from the dead. */
  stopping: boolean;
  /** Failed runs in a row, for the restart backoff. Reset by a run that lasted `RESTART_STABLE_MS`. */
  consecutiveFailures: number;
  /** When a pending respawn is due, while one is. Shown by `watch_list`. */
  respawnAt?: number;
  /** The pending respawn, so `watch_stop` can cancel it rather than race it. */
  respawnTimer?: ReturnType<typeof setTimeout>;
  /** Why the last spawn failed, carried to the one failure event that the `close` after it produces. */
  spawnError?: string;
}

export interface WatchRequest {
  readonly name: string;
  readonly command: readonly string[];
  readonly permissions?: boolean;
  readonly stderr?: boolean;
  readonly restart?: boolean;
}

/** A claim succeeded and here is the entry, or it was refused and here is what to tell the caller. */
export type ClaimResult = { readonly entry: WatchEntry } | { readonly refused: string };

export interface WatchRegistry {
  /** Register a new watch, or say why not. Does not spawn anything. */
  claim(request: WatchRequest, now?: number): ClaimResult;
  get(name: string): WatchEntry | undefined;
  /** Record that a watch ended. The entry stays listed as evidence. */
  markExited(name: string, how: string, now?: number): void;
  /**
   * Put a restarting watch back into the running state.
   *
   * `startedAt` is reset because the uptime a reader wants is this process's, not the first one's;
   * `lines` is deliberately cumulative, so a restart loop shows its total output rather than resetting
   * to zero every few seconds and looking idle.
   */
  markRunning(name: string, now?: number): void;
  /** Drop an entry entirely — used when a watch was stopped on purpose. */
  forget(name: string): void;
  /** Insertion-ordered, so the list reads as a history rather than a set. */
  list(): readonly WatchEntry[];
  running(): readonly WatchEntry[];
  /** The running watches that permission requests may be handed to. */
  approvers(): readonly WatchEntry[];
}

export function createWatchRegistry(
  maxWatches: number = MAX_WATCHES,
  maxExited: number = MAX_EXITED,
): WatchRegistry {
  // Insertion-ordered by specification, which is what makes `list()` a history and lets the eviction
  // below find the oldest dead entry without a second index.
  const entries = new Map<string, WatchEntry>();

  const isRunning = (e: WatchEntry): boolean => e.state.kind === 'running';
  // A watch waiting to respawn is not finished: it holds a slot and must never be evicted as history,
  // or its restart would be silently abandoned (Codex review, round 1).
  const isActive = (e: WatchEntry): boolean => isRunning(e) || e.respawnAt !== undefined;

  return {
    claim(request: WatchRequest, now: number = Date.now()): ClaimResult {
      const { name, command } = request;
      if (!WATCH_NAME.test(name)) {
        return {
          refused:
            `"${name}" is not a usable watch name. Use 1-32 characters of letters, digits, `
            + 'underscore or hyphen, starting with a letter or digit.',
        };
      }
      if (command.length === 0) return { refused: 'command must have at least one element' };
      if (command.some((arg) => typeof arg !== 'string')) {
        return { refused: 'command must be an array of strings' };
      }

      const existing = entries.get(name);
      if (existing && isRunning(existing)) {
        // Refused rather than replaced. Replacing would kill a watch the caller still believes in,
        // and ignoring would leave it believing its new command is running when the old one is.
        return {
          refused:
            `a watch named "${name}" is already running (pid ${existing.proc?.pid ?? '?'}): `
            + `${existing.command.join(' ')}. Stop it first, or choose another name.`,
        };
      }
      // Capacity BEFORE the old entry is touched: deleting it first and then refusing the new one lost a
      // watch that was waiting to respawn, with nothing left to say so (Codex review, round 1). The entry
      // being replaced does not count against the limit, since the new one takes its place.
      const activeNow = [...entries.values()].filter((e) => e !== existing && isActive(e)).length;
      if (activeNow >= maxWatches) {
        return { refused: `already running ${activeNow} watches (limit ${maxWatches}); stop one first` };
      }
      // A name whose watch has ended is free again — otherwise every restart would need a new name.
      if (existing) entries.delete(name);

      const entry: WatchEntry = {
        name,
        command: [...command],
        permissions: request.permissions === true,
        stderr: request.stderr === true,
        restart: request.restart === true,
        startedAt: now,
        lines: 0,
        state: { kind: 'running' },
        stopping: false,
        consecutiveFailures: 0,
      };
      entries.set(name, entry);

      // Evict the oldest dead entry, never a live one or one waiting to respawn, so the bound can never
      // cost a watch that is still meant to run.
      let dead = [...entries.values()].filter((e) => !isActive(e));
      while (dead.length > maxExited) {
        entries.delete(dead[0]!.name);
        dead = dead.slice(1);
      }
      return { entry };
    },

    get(name: string): WatchEntry | undefined {
      return entries.get(name);
    },

    markExited(name: string, how: string, now: number = Date.now()): void {
      const entry = entries.get(name);
      if (!entry) return;
      entry.state = { kind: 'exited', how, at: now };
      entry.proc = undefined;
    },

    markRunning(name: string, now: number = Date.now()): void {
      const entry = entries.get(name);
      if (!entry) return;
      entry.state = { kind: 'running' };
      // `startedAt` is readonly to everyone else; the registry owns the transition, and a restart
      // genuinely is a new process whose uptime starts now.
      (entry as { startedAt: number }).startedAt = now;
    },

    forget(name: string): void {
      entries.delete(name);
    },

    list(): readonly WatchEntry[] {
      return [...entries.values()];
    },

    running(): readonly WatchEntry[] {
      return [...entries.values()].filter(isRunning);
    },

    approvers(): readonly WatchEntry[] {
      return [...entries.values()].filter((e) => isRunning(e) && e.permissions);
    },
  };
}

/**
 * Cap one line so a pathological input cannot become an unbounded notification.
 *
 * The head is kept rather than the tail because the start of a log line carries the timestamp and
 * source, and the count says exactly what was dropped so nobody mistakes a truncation for the whole
 * message.
 */
export function truncateLine(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [+${text.length - max} chars]`;
}

/**
 * The event that makes this better than a Monitor: a watch ended, and here is how.
 *
 * A Monitor that hit its deadline and a Monitor whose command crashed both produce silence, so an
 * agent cannot tell "nothing is happening" from "nothing will ever happen again". The `exit`
 * attribute is what distinguishes them, and a signal name is reported in place of a code because
 * `SIGKILL` and `code 0` mean very different things to whoever reads it.
 */
export function exitEvent(name: string, code: number | null, signal: NodeJS.Signals | null): {
  content: string;
  meta: Record<string, string>;
} {
  const how = signal ? `signal ${signal}` : `code ${code ?? 0}`;
  return {
    content: `watch "${name}" ended (${how})`,
    meta: { exit: signal ?? String(code ?? 0) },
  };
}

/** Coarse on purpose: nobody reading a watch list needs milliseconds. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/**
 * What `watch_list` returns.
 *
 * One line per watch, state first, because "is it still running" is the question being asked. A dead
 * watch reports how it died and how long ago, so its line answers the follow-up question too. The
 * command is included because a name chosen an hour ago is not a reminder of what it runs.
 */
export function formatWatchList(entries: readonly WatchEntry[], now: number = Date.now()): string {
  if (entries.length === 0) {
    return 'No watches. Start one with watch_start({ name, command: [...] }).';
  }
  const rows = entries.map((e) => {
    const command = e.command.join(' ');
    const lines = `${e.lines} ${e.lines === 1 ? 'line' : 'lines'}`;
    if (e.state.kind === 'running') {
      return `running  ${e.name}  pid ${e.proc?.pid ?? '?'}  up ${formatDuration(now - e.startedAt)}  ${lines}  ${command}`;
    }
    const ran = formatDuration(e.state.at - e.startedAt);
    const ago = formatDuration(now - e.state.at);
    // A watch waiting to respawn is neither running nor finished, and the list must say so: listing it
    // as merely "exited" is how a reader concludes nothing will run under that name again.
    const pending = e.respawnAt === undefined
      ? ''
      : `  restarting in ${formatDelay(Math.max(0, e.respawnAt - now))} (${e.consecutiveFailures} failed in a row)`;
    return `exited   ${e.name}  ${e.state.how}  ran ${ran}, ${ago} ago${pending}  ${lines}  ${command}`;
  });
  const running = entries.filter((e) => e.state.kind === 'running').length;
  const header = `${entries.length} ${entries.length === 1 ? 'watch' : 'watches'}, ${running} running`;
  return [header, ...rows].join('\n');
}
