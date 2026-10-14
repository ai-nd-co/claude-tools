// Detect a recording that captured nothing, before it reaches the transcriber.
//
// Whisper is trained on subtitles, so given silence it does not return an empty
// string - it invents plausible filler. A real 8.39-second voice note measured
// at -91 dB (digital silence, nothing recorded, the owner's microphone was off)
// produced "you" in English and "Продолжение следует..." in Russian. Both are
// well-known outputs for silent input, and both look exactly like a short
// message someone meant to send.
//
// That is the dangerous part. An empty transcript is obviously empty; a
// hallucinated one is a sentence an agent may act on. Catching it here costs one
// ffmpeg call and removes a whole class of confidently wrong input.

import { execFile } from 'child_process';
import { promisify } from 'util';

const run = promisify(execFile);

/**
 * Below this, treat the recording as empty.
 *
 * 16-bit digital silence sits around -91 dB. Real speech, even quiet or distant,
 * peaks far above this - a whisper across a room still clears -60. The threshold
 * is deliberately near the floor so it catches "nothing was recorded" and never
 * a genuinely quiet person.
 */
const SILENCE_PEAK_DB = -70;

export interface AudioLevel {
  /** Loudest sample in the file, in dBFS. Null when it could not be measured. */
  maxDb: number | null;
  meanDb: number | null;
  /** True only when measurement succeeded AND the peak is below the floor. */
  silent: boolean;
}

/**
 * Measure a file's peak level with ffmpeg.
 *
 * Never throws. If ffmpeg is missing or the file cannot be read, this reports
 * `silent: false` — an unmeasurable file must still be transcribed, because
 * refusing to transcribe on a measurement failure would lose real messages to
 * fix a cosmetic problem.
 */
export async function measureAudioLevel(absolutePath: string): Promise<AudioLevel> {
  try {
    const { stderr } = await run(
      'ffmpeg',
      ['-hide_banner', '-nostdin', '-i', absolutePath, '-af', 'volumedetect', '-f', 'null', '-'],
      { timeout: 30_000, maxBuffer: 1024 * 1024 }
    ).catch((err: any) => {
      // ffmpeg writes volumedetect to stderr and can still exit non-zero on
      // some inputs, so a rejection may still carry the numbers.
      if (typeof err?.stderr === 'string' && err.stderr.includes('volumedetect')) return err;
      throw err;
    });

    const max = /max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/.exec(stderr ?? '');
    const mean = /mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/.exec(stderr ?? '');
    if (!max) return { maxDb: null, meanDb: null, silent: false };

    const maxDb = Number(max[1]);
    return {
      maxDb,
      meanDb: mean ? Number(mean[1]) : null,
      silent: Number.isFinite(maxDb) && maxDb <= SILENCE_PEAK_DB,
    };
  } catch {
    // No ffmpeg, unreadable file, timeout: say nothing rather than block.
    return { maxDb: null, meanDb: null, silent: false };
  }
}

/** What to show instead of a hallucinated transcript. */
export function silentAudioNote(level: AudioLevel): string {
  const peak = level.maxDb === null ? '' : ` (peak ${level.maxDb.toFixed(1)} dB)`;
  return `[silent — no audio captured${peak}]`;
}
