/**
 * One watcher per agent on a machine (#406), held by the operating system rather than by a file.
 *
 * Two watchers for the same agent each deliver every message, so the agent sees everything twice. That
 * doubled whole sessions' traffic after the 2026-09-28 outage, when re-arms left orphans behind.
 *
 * **The lock is a listening socket.** On Linux it is an abstract Unix socket, on Windows a named pipe:
 * binding one is exclusive, and the kernel releases it the instant the owning process dies, however it
 * dies. So there is no pidfile to go stale and no pid to be reused, and ownership can never be
 * "claimed" by two processes at once. Other platforms have no such address and run unlocked, saying so.
 *
 * **Taking over is a handshake, not a signal.** A newer watcher that finds the address taken connects
 * and asks. The owner checks the request names exactly its own hub, agent and state, answers, and leaves
 * with exit 0 at the next point where no delivery is half done. Exit 0 matters: a supervisor that
 * restarts dead watches does not restart a clean exit, so two sessions cannot fight over one name. The
 * newcomer only proceeds once it holds the address itself, so a predecessor that did not leave means
 * "takeover failed", never two watchers.
 *
 * Replaces a pidfile design that review showed was not exclusive: two starters could both claim it, a
 * signal could arrive before its handler existed, and a verified pid could be reused before the signal.
 */
import { createHash } from 'crypto';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { createConnection, createServer, type Server, type Socket } from 'net';

export interface WatchIdentity {
  origin: string;
  agent: string;
  state: string;
}

/** How long a newcomer waits for the owner to answer and then let go. */
export const TAKEOVER_TIMEOUT_MS = 10_000;

/**
 * A kernel-held lock address for `parts`: an abstract Unix socket on Linux, a named pipe on Windows.
 * Both vanish the instant their owner dies. Null elsewhere: a socket FILE survives its owner, and
 * cleaning up a stale one cannot be made race-free without yet another lock (Codex review), so those
 * platforms run without one and say so rather than pretend.
 */
export function lockAddress(kind: string, parts: readonly string[], platform: NodeJS.Platform = process.platform): string | null {
  const key = createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
  if (platform === 'win32') return `\\\\.\\pipe\\claude-tools-hub-${kind}-${key}`;
  if (platform === 'linux') return `\0claude-tools-hub-${kind}-${key}`;
  return null;
}

/**
 * The address this identity's watcher owns. Derived from a hash of the exact identity, so two states
 * that sanitise to the same directory name, or the same agent on two hubs, never share a lock.
 */
export function ownerAddress(identity: WatchIdentity, platform: NodeJS.Platform = process.platform): string | null {
  return lockAddress('watch', [identity.origin, identity.agent, identity.state], platform);
}

/**
 * Run `fn` holding the lock `kind`/`parts`, waiting for it if another process holds it.
 *
 * The lock is a listening socket that nobody connects to: binding is exclusive, and the kernel releases
 * it when the holder exits, so a holder that died never blocks anyone and a slow live holder is never
 * mistaken for a dead one (an age-based lock file allowed both — Codex review). Where no such address
 * exists (see `lockAddress`) `fn` runs unlocked.
 */
export async function withProcessLock<T>(
  kind: string,
  parts: readonly string[],
  fn: () => Promise<T>,
  timeoutMs = 30_000,
): Promise<T> {
  const address = lockAddress(kind, parts);
  if (address === null) return fn();
  const server = createServer((socket) => socket.destroy());
  server.unref();
  for (const deadline = Date.now() + timeoutMs; ;) {
    if ((await listen(server, address)) === 'ok') break;
    if (Date.now() > deadline) throw new Error(`timed out waiting for the ${kind} lock held by another process`);
    await new Promise((r) => setTimeout(r, 50));
  }
  try {
    return await fn();
  } finally {
    server.close();
  }
}

export interface Ownership {
  /** Whether an earlier watcher was running and handed over to this one. */
  readonly tookOver: boolean;
  /** False where this platform has no kernel-held lock, so one-watcher-per-agent is not enforced. */
  readonly supported: boolean;
  /** Stop listening; the address is free again. */
  close(): void;
}

function listen(server: Server, address: string): Promise<'ok' | 'taken'> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off('listening', onListening);
      if (error.code === 'EADDRINUSE') resolve('taken');
      else reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve('ok');
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(address);
  });
}

type AskResult = { answer: 'granted' | 'refused'; detail: string; socket: Socket } | { answer: 'gone' };

/** Ask the current owner to hand over. Resolves with its answer; the socket is kept to watch it leave. */
function ask(address: string, identity: WatchIdentity, timeoutMs: number): Promise<AskResult> {
  return new Promise((resolve) => {
    const socket = createConnection(address);
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ answer: 'refused', detail: `no answer within ${Math.round(timeoutMs / 1000)}s`, socket });
    }, timeoutMs);
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ op: 'takeover', ...identity, pid: process.pid })}\n`);
    });
    socket.on('data', (chunk: Buffer) => {
      buffer += String(chunk);
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      clearTimeout(timer);
      try {
        const reply = JSON.parse(buffer.slice(0, end)) as { ok?: unknown; reason?: unknown };
        resolve(reply.ok === true
          ? { answer: 'granted', detail: '', socket }
          : { answer: 'refused', detail: typeof reply.reason === 'string' ? reply.reason : 'refused', socket });
      } catch {
        resolve({ answer: 'refused', detail: 'an answer that is not the watch protocol', socket });
      }
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      // The owner left between our bind attempt and this connect: try the address again.
      void error;
      resolve({ answer: 'gone' });
    });
  });
}

/**
 * Become the one watcher for this identity, taking over from an earlier one if needed.
 *
 * `onTakeoverRequest` is called in the OWNER when a newer watcher asks; it must arrange for this process
 * to leave with exit 0 once no delivery is half done. Throws if an earlier watcher is running and did not
 * let go: the caller then refuses to start, rather than become a second watcher.
 */
export async function acquireWatchOwnership(
  identity: WatchIdentity,
  onTakeoverRequest: () => void,
  opts: { timeoutMs?: number; platform?: NodeJS.Platform } = {},
): Promise<Ownership> {
  const platform = opts.platform ?? process.platform;
  const address = ownerAddress(identity, platform);
  const timeoutMs = opts.timeoutMs ?? TAKEOVER_TIMEOUT_MS;
  if (address === null) return { tookOver: false, supported: false, close: () => undefined };

  let handingOver = false;
  // Kept so that `close()` can end them: a newcomer learns the owner has gone when ITS connection closes,
  // and `server.close()` alone stops accepting without closing the ones already open. A process that exits
  // closes them anyway; an owner that lets go while staying alive must do it itself.
  const connections = new Set<Socket>();
  const server = createServer((socket) => {
    // Unreferenced, like the server: holding ownership must never be the thing that keeps a watcher's
    // process alive. A watcher that has stopped polling for any reason should exit, and its exit is what
    // releases the address (Codex review: every ordinary return used to leave the process hanging).
    socket.unref();
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += String(chunk);
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(buffer.slice(0, end));
      } catch {
        parsed = null;
      }
      // Valid JSON of the wrong shape (`null`, a number) must be refused, not crash the owner.
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        socket.end(`${JSON.stringify({ ok: false, reason: 'not the watch protocol' })}\n`);
        return;
      }
      const request = parsed as Record<string, unknown>;
      // The address is derived from the identity, so a mismatch here means a hash collision or a
      // stranger. Either way the owner stays.
      const same = request.op === 'takeover'
        && request.origin === identity.origin && request.agent === identity.agent && request.state === identity.state;
      if (!same) {
        socket.end(`${JSON.stringify({ ok: false, reason: 'a different watcher identity' })}\n`);
        return;
      }
      socket.write(`${JSON.stringify({ ok: true })}\n`);
      // The socket stays open: the newcomer learns that we have gone when it closes with our process.
      if (!handingOver) {
        handingOver = true;
        onTakeoverRequest();
      }
    });
    socket.on('error', () => {
      // A newcomer that gave up; nothing to do.
    });
  });

  server.unref();
  const deadline = Date.now() + timeoutMs;
  let tookOver = false;
  for (;;) {
    if ((await listen(server, address)) === 'ok') {
      return {
        tookOver,
        supported: true,
        close: () => {
          server.close();
          for (const socket of connections) socket.destroy();
        },
      };
    }
    if (Date.now() > deadline) {
      throw new Error('an earlier watcher for this agent is still running and did not hand over in time');
    }
    const result = await ask(address, identity, Math.max(1_000, deadline - Date.now()));
    if (result.answer === 'refused') {
      result.socket.destroy();
      throw new Error(`an earlier watcher for this agent refused to hand over (${result.detail})`);
    }
    if (result.answer === 'granted') {
      tookOver = true;
      // Wait for the owner to leave: its end of the connection closes with its process. Destroyed on the
      // way out whatever happened, so a predecessor that said yes and never left cannot hold THIS process
      // open after it has given up (Codex review).
      try {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
          timer.unref();
          result.socket.once('close', () => { clearTimeout(timer); resolve(); });
        });
      } finally {
        result.socket.destroy();
      }
    }
    // 'gone', or granted and left: try the address again. Another newcomer may win the race, in which
    // case the next round asks IT to hand over; exactly one of us ends up holding the address.
  }
}

/**
 * Watchers from before this change, which hold no lock and cannot be asked to leave (Linux only).
 *
 * Found by exact argv tokens — `hub` then `watch` as separate arguments, naming this agent or state — so
 * a shell wrapper whose script merely contains the words does not match, and neither does the `channel
 * serve` supervisor whose argv carries the watch command, nor a `--once` check. Reported, never
 * signalled: this process cannot prove whose session such a watcher serves.
 */
export function findUnlockedWatchers(identity: WatchIdentity, selfPid: number = process.pid): number[] {
  // Agent AND state AND (when the argv names one) hub must all match, so a watcher of the same state on
  // another hub, or of another agent, is never reported (Codex review).
  if (!existsSync('/proc')) return [];
  const found: number[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync('/proc').filter((name) => /^\d+$/.test(name));
  } catch {
    return [];
  }
  for (const name of entries) {
    const pid = Number(name);
    if (pid === selfPid) continue;
    let argv: string[];
    try {
      argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter((a) => a !== '');
    } catch {
      continue;
    }
    const at = argv.findIndex((a, i) => a === 'hub' && argv[i + 1] === 'watch');
    if (at < 0) continue;
    if (argv.some((a, i) => a === 'channel' && argv[i + 1] === 'serve')) continue;
    const args = argv.slice(at + 2);
    if (args.includes('--once')) continue;
    const value = (flag: string) => {
      const i = args.indexOf(flag);
      return i >= 0 ? args[i + 1] : undefined;
    };
    const agent = value('--agent') ?? value('--as');
    const state = value('--state') ?? agent;
    const url = value('--url');
    // A watcher naming no agent takes it from its environment, which this process cannot read; it is
    // left out rather than reported as a guess.
    if (agent === undefined || agent !== identity.agent || state !== identity.state) continue;
    if (url !== undefined && url.replace(/\/api\/?$/, '').replace(/\/+$/, '') !== identity.origin) continue;
    found.push(pid);
  }
  return found;
}
