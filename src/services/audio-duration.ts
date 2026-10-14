// How long a clip actually is, for the one caller that cannot be told.
//
// The request bound in `stt.ts` scales with the audio's length, and every
// automated path already knows it — Telegram reports a duration for every voice
// note. A file named on the command line does not come with one, and guessing it
// from the file's size is wrong by more than an order of magnitude across
// formats: two minutes of 44.1 kHz stereo WAV is about 21 MB, which a
// bytes-per-second guess reads as hours. The container knows; ask it.

import { execFile } from 'child_process';
import { promisify } from 'util';

const run = promisify(execFile);

/**
 * The clip's length in seconds, or null when it cannot be established.
 *
 * Never throws. ffprobe may be missing, the file may be unreadable, and a
 * stream may carry no duration at all — in every one of those cases the caller
 * falls back to its own conservative estimate rather than refusing to transcribe.
 *
 * Bounded at two seconds: this runs before the request it is sizing, so it must
 * not become the delay it exists to prevent.
 */
export async function audioDurationSeconds(absolutePath: string): Promise<number | null> {
  try {
    const { stdout } = await run(
      'ffprobe',
      [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        absolutePath,
      ],
      { timeout: 2_000, maxBuffer: 64 * 1024 }
    );

    const seconds = Number(String(stdout).trim());
    // ffprobe prints "N/A" for a stream with no duration, which is NaN here.
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
  } catch {
    return null;
  }
}
