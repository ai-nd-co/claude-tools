/**
 * A durable hand-off for watch commands: one file per output line, on disk before the caller moves
 * its cursor.
 *
 * A watcher that prints to a pipe and then saves its position loses every line still in the pipe,
 * or held by a reader that is retrying a delivery, if that reader dies (a reboot, a unit restart, an
 * OOM kill). With an outbox the line is fsynced to its own file first, and the reader deletes a file
 * only after delivering it. Delivery becomes at-least-once: a reader that dies between delivering a
 * line and deleting its file sends that one line again on restart.
 *
 * File names sort in write order under a byte-wise sort (`LC_ALL=C`). The leading key is a
 * zero-padded number that only ever grows for one outbox: the millisecond clock, but always above
 * the last key used and above every file already waiting, so a clock stepping back cannot put a
 * newer line first. Then the writer's pid and a sequence. Readers take only names ending in
 * `.line`; a file still being written has a `.tmp` name and becomes visible by an atomic rename.
 * One writer per outbox.
 */
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync, writeSync } from 'fs';
import { dirname, join, resolve } from 'path';

export const OUTBOX_SUFFIX = '.line';
const KEY_WIDTH = 15;

let sequence = 0;
/** Last key used, per outbox directory. */
const lastKeys = new Map<string, number>();

/** For tests only: forget the keys used, as a new process would. */
export function resetOutboxForTests(): void {
  lastKeys.clear();
  durableDirs.clear();
}

/** Pad to a fixed width so a byte-wise sort of names is a numeric sort. */
function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

function fsyncDir(dir: string): void {
  const fd = openSync(dir, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Outboxes whose directory chain this process has made durable, by the directory's identity. */
const durableDirs = new Map<string, string>();

/**
 * Create `dir` if needed and, once per process, fsync every directory from its parent up to the
 * root, so an unclean shutdown cannot lose the outbox's own entry while the caller's saved cursor
 * survives. Done for directories that already existed too: an earlier process may have created
 * them and died before syncing. Marked done only after every sync and the key scan succeeded.
 */
function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // A symlink's own entry is not covered by the checks below, so the outbox must be a real directory.
  if (lstatSync(dir).isSymbolicLink()) throw new Error(`outbox ${dir} is a symlink; give the real directory`);
  const st = statSync(dir);
  // Checked on every write: mkdir's mode does not apply to a directory that already existed, and
  // anyone else able to write here could delete a line after it was published.
  if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
  // A directory deleted and recreated under a running watcher is new, even if its inode number is
  // reused: the birth time tells them apart.
  const identity = `${st.dev}:${st.ino}:${st.birthtimeMs}`;
  if (durableDirs.get(dir) === identity) return;
  for (let d = dir; dirname(d) !== d; d = dirname(d)) fsyncDir(dirname(d));
  // The directory may hold lines from elsewhere (an earlier process, a restored queue): raise the
  // ordering watermark above them. Saved here, before the directory is marked done, so a failed
  // scan is simply retried by the next write.
  lastKeys.set(dir, Math.max(lastKeys.get(dir) ?? 0, highestWaitingKey(dir)));
  durableDirs.set(dir, identity);
}

/** The highest key among the files already in `dir` (0 if none). */
function highestWaitingKey(dir: string): number {
  let max = 0;
  for (const name of readdirSync(dir)) {
    const key = Number(name.slice(0, KEY_WIDTH));
    if (name.length > KEY_WIDTH && name[KEY_WIDTH] === '-' && Number.isSafeInteger(key) && key > max) max = key;
  }
  return max;
}

/**
 * Null when `--outbox` can keep its promises here, otherwise why not. Windows cannot fsync a
 * directory (EPERM) and its ACLs ignore the private modes, so the option is refused there rather
 * than silently weaker.
 */
export function outboxUnsupportedReason(platform: string = process.platform): string | null {
  return platform === 'win32'
    ? '--outbox is not supported on Windows: directories cannot be fsynced there and file modes do not make the files private'
    : null;
}

/** Write all of `data`, however many calls it takes. */
function writeAll(fd: number, data: Buffer): void {
  let offset = 0;
  while (offset < data.length) {
    const n = writeSync(fd, data, offset, data.length - offset);
    if (n <= 0) throw new Error('outbox: write made no progress');
    offset += n;
  }
}

/**
 * Write each non-empty line of `text` to its own file in `dir`, durably: the data is fsynced, the
 * file renamed into its final name, and the directory fsynced, all before this returns.
 */
export function writeOutbox(dir: string, text: string, now: () => number = Date.now): string[] {
  const box = resolve(dir);
  ensureDir(box);
  let last = lastKeys.get(box) ?? 0;
  const written: string[] = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    last = Math.max(now(), last + 1);
    // Recorded before the write: a failed write may waste a key, never reuse one.
    lastKeys.set(box, last);
    sequence += 1;
    const name = `${pad(last, KEY_WIDTH)}-${pad(process.pid, 10)}-${pad(sequence, 10)}`;
    const tmp = join(box, `${name}.tmp`);
    const final = join(box, `${name}${OUTBOX_SUFFIX}`);
    const fd = openSync(tmp, 'wx', 0o600);
    let open = true;
    try {
      writeAll(fd, Buffer.from(`${line}\n`, 'utf-8'));
      fsyncSync(fd);
      open = false;
      closeSync(fd);
      renameSync(tmp, final);
    } catch (error) {
      // No half-published or orphaned file: a retry gets a new name, so a leftover would only pile up.
      if (open) {
        try { closeSync(fd); } catch { /* the original error matters more */ }
      }
      rmSync(tmp, { force: true });
      throw error;
    }
    written.push(final);
  }
  if (written.length) {
    fsyncDir(box);
    // The outbox's own entry too, every time: cheap at one sync per line, and it covers a directory
    // renamed away and back under a running writer, which the identity cache cannot see. Renaming
    // ANCESTORS of a live outbox is outside what this guards.
    fsyncDir(dirname(box));
  }
  return written;
}
