// On-disk cache for speech-to-text results.
//
// Reading a chat repeatedly must not re-bill the same voice notes, so every
// transcript is keyed by its inputs and stored as one small JSON file. The cache
// lives under the OS temp directory: transcripts are cheap to regenerate, so
// losing them to a temp sweep is harmless, while keeping them out of the config
// directory means they never end up in a backup or a synced folder.

import { createHash } from 'crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const CACHE_DIR_NAME = 'claude-tools-stt';

/**
 * Entries nobody has read for this long are dropped. The clock is the file's
 * mtime and a cache hit bumps it, so an entry still in use never expires:
 * expiry retires transcripts nobody asks for, it never re-bills a live one.
 */
const MAX_IDLE_MS = 30 * 24 * 60 * 60 * 1000;

export interface CachedTranscript {
  text: string;
  language?: string;
  duration?: number;
  model: string;
  /**
   * The model's mean segment confidence when this text was produced, if the
   * backend reported it.
   *
   * Stored rather than keyed. A change of retry policy must invalidate the
   * transcripts the policy would have changed - the low-confidence ones - and
   * nothing else: putting the policy in the key instead renames every file and
   * re-transcribes, and re-bills, the whole cache. See `cachedTranscriptIsSuspect`.
   */
  avgLogprob?: number;
  /**
   * The language-retry policy in force when this text was produced, as an ISO
   * code, or absent when there was none. Compared against the current policy to
   * decide whether this entry is still what that policy would produce - see
   * `cachedTranscriptIsSuspect`.
   */
  retriedIn?: string;
  /** Unix epoch ms when this entry was first written. Informational. */
  cachedAt: number;
}

export interface TranscriptCacheKey {
  /** Namespace, e.g. `tg` for a Telegram message or `file` for a local path. */
  source: string;
  /** Stable identity within the namespace. */
  id: string;
  model: string;
  language?: string;
  translate?: boolean;
  /**
   * Decoding prompt. Part of the identity because it changes the transcript: a
   * prompted result must not be served to an unprompted caller, or vice versa.
   */
  prompt?: string;
}

export function getTranscriptCacheDir(): string {
  // Overridable so tests get an isolated directory, and so a caller can point
  // the cache at a longer-lived location than the OS temp sweep allows.
  return process.env.CLAUDE_TOOLS_STT_CACHE_DIR || join(tmpdir(), CACHE_DIR_NAME);
}

/**
 * Hash the key rather than building a filename from it. Chat titles and file
 * paths contain characters that are illegal in filenames on at least one
 * supported platform, and a hash sidesteps length limits too.
 */
function keyToFilename(key: TranscriptCacheKey): string {
  // FROZEN. Every field added here changes every existing filename, so an
  // upgrade would turn the whole cache into a miss and re-transcribe - and
  // re-bill - everything already read. Before adding one, ask whether the thing
  // belongs in the RECORD instead: `avgLogprob` does, which is how the language
  // retry invalidates only the entries it would actually change.
  const canonical = [
    key.source,
    key.id,
    key.model,
    key.language ?? '',
    key.translate ? 'translate' : 'transcribe',
    key.prompt ?? '',
  ].join('\u0000');

  return `${createHash('sha256').update(canonical).digest('hex').slice(0, 32)}.json`;
}

/** Identity for a local file: content hash, so a moved or renamed file still hits. */
export function hashFileContents(filepath: string): string {
  return createHash('sha256').update(readFileSync(filepath)).digest('hex').slice(0, 32);
}

export function readTranscriptCache(key: TranscriptCacheKey): CachedTranscript | null {
  const filepath = join(getTranscriptCacheDir(), keyToFilename(key));

  let mtimeMs: number;
  try {
    mtimeMs = statSync(filepath).mtimeMs;
  } catch {
    return null;
  }

  if (Date.now() - mtimeMs > MAX_IDLE_MS) {
    try {
      unlinkSync(filepath);
    } catch {
      // Another process may have pruned it already.
    }
    return null;
  }

  let entry: CachedTranscript;
  try {
    entry = JSON.parse(readFileSync(filepath, 'utf-8')) as CachedTranscript;
  } catch {
    // Unreadable or malformed entry: treat as a miss and let it be overwritten.
    return null;
  }

  // A truncated write or a hand-edited file must not surface as a transcript.
  if (typeof entry.text !== 'string' || typeof entry.model !== 'string') return null;

  // Keep an entry alive while it is in use, so expiry cannot re-bill audio that
  // is still being read.
  try {
    const now = new Date();
    utimesSync(filepath, now, now);
  } catch {
    // A read-only cache still serves hits; it just cannot refresh the clock.
  }

  return entry;
}

/**
 * Persist a transcript. Returns false when it could not be stored, which callers
 * must surface: a silently unwritable cache means every later read pays for the
 * same audio again, which is exactly what the cache exists to prevent.
 */
export function writeTranscriptCache(
  key: TranscriptCacheKey,
  value: Omit<CachedTranscript, 'cachedAt'>
): boolean {
  const dir = getTranscriptCacheDir();

  try {
    mkdirSync(dir, { recursive: true });

    const target = join(dir, keyToFilename(key));
    const entry: CachedTranscript = { ...value, cachedAt: Date.now() };

    // Write-then-rename so a concurrent reader never sees a half-written file.
    const temp = `${target}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(entry), { mode: 0o600 });

    try {
      // POSIX rename replaces the target atomically, leaving no window in which
      // a concurrent reader misses an entry that already existed.
      renameSync(temp, target);
    } catch (err) {
      // Windows rename fails when the target exists, so there it must go first.
      // Only that platform justifies deleting a usable entry.
      if (process.platform !== 'win32') throw err;
      try {
        unlinkSync(target);
      } catch {
        // Held open elsewhere; the retry reports the real failure.
      }
      renameSync(temp, target);
    }

    return true;
  } catch {
    try {
      unlinkSync(join(dir, `${keyToFilename(key)}.${process.pid}.tmp`));
    } catch {
      // Best effort: never leave a stray temp file behind after a failure.
    }
    return false;
  }
}

/**
 * Delete entries nobody has read for `MAX_IDLE_MS`. Called after a read that
 * actually transcribed something, so a long-lived cache directory stays bounded
 * without a background timer.
 */
export function pruneTranscriptCache(): number {
  const dir = getTranscriptCacheDir();
  if (!existsSync(dir)) return 0;

  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }

  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const filepath = join(dir, name);
    try {
      if (Date.now() - statSync(filepath).mtimeMs > MAX_IDLE_MS) {
        unlinkSync(filepath);
        removed++;
      }
    } catch {
      // Vanished between readdir and stat, or not ours to remove.
    }
  }

  return removed;
}
