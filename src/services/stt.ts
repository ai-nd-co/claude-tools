// Speech-to-text backends: the office cluster first, Groq as the fallback.
//
// Both speak the same OpenAI audio API, so a backend is nothing more than a base
// URL, a key and a model id. This module decides which ones are configured, in
// what order they are tried, and when a failure on one justifies paying for the
// other. The HTTP call itself lives in `commands/transcribe/groq.ts`.

import * as fs from 'fs';

import type { Config, GroqConfig, SpeechConfig } from '../config/types.js';
import {
  SttRequestError,
  groqBackend,
  transcribeWithBackend,
  type GroqTranscribeOptions,
  type GroqTranscriptionResult,
} from '../commands/transcribe/groq.js';

export { groqBackend };

export type SttProvider = 'cluster' | 'groq';

export interface SttBackend {
  provider: SttProvider;
  /** Human name for messages: "the speech cluster", "Groq". */
  label: string;
  /** Ends in `/v1`; the audio paths are appended. */
  baseUrl: string;
  apiKey: string;
  model: string;
  /**
   * Floor for one request's bound, in milliseconds. A longer clip raises it
   * through `msPerAudioSecond`; `requestTimeoutMs` works out the actual bound.
   */
  timeoutMs?: number;
  /**
   * Vocabulary the transcriber should expect, from config. Used when the caller
   * passes no `prompt` of its own.
   */
  prompt?: string;
  /**
   * ISO-639-1 code to retry with when the backend's language detection looks
   * wrong. See `transcribeWithBackend`.
   */
  fallbackLanguage?: string;
  /**
   * How much time one second of audio is allowed, on top of the floor. Set on
   * both backends: a long recording legitimately takes longer than a voice note,
   * and a flat bound either cuts the recording off or lets a short note hang.
   */
  msPerAudioSecond?: number;
}

/**
 * Thirty seconds for anything up to two minutes of audio, then four times real
 * time — both measured on the real card on 2026-10-03, not guessed.
 *
 * What was measured: 8.2 s of Russian came back in 3.0 s, 10.3 s of English in
 * 2.2 s, and 129 s of mixed speech in 6.5 s — about twenty times real time, with
 * requests served one after another. Groq answered the same clips in 1.1 s and
 * 3.3 s. The model never unloads (`STT_MODEL_TTL=-1`) and readiness holds
 * traffic until it is loaded, so the 71 s first load is not in a client's path.
 *
 * So the floor carries a tenfold margin over the worst short-clip measurement,
 * which leaves room for a clip or two queued ahead of this one, and the
 * per-second rate carries a fivefold margin over the long-clip measurement.
 *
 * Why it matters that the floor is thirty seconds and not ten minutes: when a
 * backend accepts the connection and then goes quiet, this bound is the only
 * thing that ends the wait. At ten minutes a stuck cluster meant a voice note
 * got no text at all, because the fallback was never reached; at thirty seconds
 * Groq answers it in about a second.
 */
export const STT_FLOOR_MS = 30 * 1000;
export const STT_MS_PER_AUDIO_SECOND = 250;

/**
 * Last resort, when neither the caller nor ffprobe can say how long the clip is.
 *
 * File size is a poor proxy and is wrong in both directions across formats: at
 * 2 kB/s a two-minute 44.1 kHz stereo WAV of about 21 MB reads as three hours,
 * while 6 kbit/s Opus reads as roughly a third of its real length. The low rate
 * keeps the error on the safe side — a request allowed too long merely stays
 * stuck longer, one cut short loses a transcript — and `SIZE_DERIVED_CEILING_MS`
 * stops the over-estimate from becoming no bound at all.
 */
const BYTES_PER_AUDIO_SECOND = 2048;

/**
 * Ten minutes, the bound this whole change replaced, kept for the one case that
 * cannot do better than guess. A clip whose length nothing could establish is
 * allowed no more than the old flat timeout, so that path is never worse than it
 * was, while every path that knows the length gets seconds.
 */
const SIZE_DERIVED_CEILING_MS = 10 * 60 * 1000;

/**
 * The bound governs the whole request, upload included, so the file has to get
 * there before any of the transcribing time is of use. A clip's length says
 * nothing about that: two minutes of 44.1 kHz stereo is about 21 MB, and on a
 * slow uplink thirty seconds would abort a perfectly healthy request before the
 * body finished going out.
 *
 * 128 bytes per millisecond is roughly 1 Mbit/s. Unlike the rest of this policy
 * that figure is **an assumption, not a measurement** — the client can be
 * anywhere, so there is no uplink to measure — and it is deliberately
 * pessimistic: it costs half a second on a voice note, where it does not matter,
 * and buys about two and a half minutes on a 21 MB file, where it decides
 * whether the request can succeed at all.
 */
const UPLOAD_BYTES_PER_MS = 128;

/**
 * The bound for one request: the backend's floor, or a quarter of the audio's
 * length when that is longer, plus time for the file to be uploaded.
 *
 * `audioSeconds` is what the caller knows, or what ffprobe found; without either
 * the file's size stands in, capped. A backend that sets no floor gets no bound,
 * which is how the tests' hand-made backends stay unbounded.
 */
export function requestTimeoutMs(
  backend: SttBackend,
  audioFile: string,
  audioSeconds?: number
): number | undefined {
  if (backend.timeoutMs === undefined) return undefined;
  if (backend.msPerAudioSecond === undefined) return backend.timeoutMs;

  let bytes = 0;
  try {
    bytes = fs.statSync(audioFile).size;
  } catch {
    // Unreadable here means the request is about to fail on the same file; the
    // floor is enough to carry it to that error.
  }
  const upload = Math.ceil(bytes / UPLOAD_BYTES_PER_MS);

  if (audioSeconds !== undefined && Number.isFinite(audioSeconds) && audioSeconds >= 0) {
    return Math.max(backend.timeoutMs, Math.ceil(audioSeconds * backend.msPerAudioSecond)) + upload;
  }

  // Nothing could say how long it is, so the file's size stands in — and the
  // transcribing part of that guess is capped, because a guess that reads a
  // two-minute WAV as three hours would otherwise be a bound in name only.
  const fromSize = Math.ceil((bytes / BYTES_PER_AUDIO_SECOND) * backend.msPerAudioSecond);
  return Math.max(backend.timeoutMs, Math.min(fromSize, SIZE_DERIVED_CEILING_MS)) + upload;
}

/**
 * The vocabulary a request will actually be decoded with: the caller's if it
 * gave one, otherwise the backend's configured one.
 *
 * Exported because the transcript cache has to key on it. A prompted transcript
 * is a different transcript, so serving one to an unprompted caller — or a
 * pre-glossary transcript after a glossary is configured — returns text the
 * request would not have produced. That is the mistake this exists to prevent.
 */
export function effectivePrompt(backend: SttBackend, callerPrompt?: string): string | undefined {
  return callerPrompt ?? backend.prompt;
}

/**
 * The retry language a request would actually use. Exported for the same reason
 * as `effectivePrompt`: it changes which transcript comes back, so the cache has
 * to key on it or a change of policy never reaches an already-cached clip.
 */
export function effectiveFallbackLanguage(
  backend: SttBackend,
  callerLanguage?: string,
  translate?: boolean
): string | undefined {
  // Both exclusions mirror `transcribeWithBackend`, which skips the retry in
  // exactly these cases: a caller that named its own language, and the
  // translation endpoint, which takes no language at all. The policy cannot
  // change either answer, so it must not split their cache entries.
  if (callerLanguage || translate) return undefined;
  return backend.fallbackLanguage;
}

export function clusterBackend(config: SpeechConfig): SttBackend {
  return {
    provider: 'cluster',
    label: 'the speech cluster',
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    prompt: config.prompt,
    fallbackLanguage: config.fallbackLanguage,
    timeoutMs: STT_FLOOR_MS,
    msPerAudioSecond: STT_MS_PER_AUDIO_SECOND,
  };
}

/**
 * The backends to try, in order. The cluster goes first because it is ours:
 * audio never leaves the office and nothing is billed. Groq follows as the
 * fallback. An empty list means speech-to-text is not configured at all.
 */
export function resolveSttBackends(config: Pick<Config, 'speech' | 'groq'>): SttBackend[] {
  const backends: SttBackend[] = [];
  if (config.speech) backends.push(clusterBackend(config.speech));
  if (config.groq) backends.push(groqBackend(config.groq));
  return backends;
}

/**
 * Callers that still hold a bare `GroqConfig` (older code paths and the tests)
 * get a one-backend list; everything downstream only ever sees backends.
 */
export function asBackends(stt: SttBackend[] | GroqConfig): SttBackend[] {
  return Array.isArray(stt) ? stt : [groqBackend(stt)];
}

export interface SttOutcome {
  result: GroqTranscriptionResult;
  /** The backend that produced `result` — not necessarily the first one tried. */
  backend: SttBackend;
  /** Set when an earlier backend failed and the next one answered. */
  fellBackFrom?: { backend: SttBackend; reason: string };
}

/**
 * Whether a failure on one backend is worth retrying on the next.
 *
 * Unreachable, timed out, 5xx and 429 are the backend's problem, so the next one
 * gets the same clip. A 4xx other than 429 says the request itself is wrong (bad
 * key, bad file, too large) and would fail again anywhere — and silently
 * falling back on a 401/403 would hide a broken configuration behind a bill.
 */
export function isRetriableSttFailure(error: unknown): boolean {
  if (error instanceof SttRequestError) {
    return error.status === undefined || error.status === 429 || error.status >= 500;
  }
  return false;
}

/**
 * Transcribe with the first backend that answers.
 *
 * `onFallback` is told about each skipped backend so a command can say which
 * one answered; the watchers pass nothing and stay quiet. The last error is
 * rethrown when every backend fails.
 */
export async function transcribeAudio(
  audioFile: string,
  backends: SttBackend[],
  options: GroqTranscribeOptions = {},
  onFallback?: (from: SttBackend, reason: string, next: SttBackend) => void
): Promise<SttOutcome> {
  if (backends.length === 0) {
    throw new Error('Speech-to-text is not configured: add speech.apiKey or groq.apiKey to the secrets file.');
  }

  let fellBackFrom: SttOutcome['fellBackFrom'];

  for (let i = 0; i < backends.length; i++) {
    const backend = backends[i];
    const next = backends[i + 1];
    try {
      const result = await transcribeWithBackend(audioFile, backend, options);
      return { result, backend, fellBackFrom };
    } catch (error: any) {
      if (!next || !isRetriableSttFailure(error)) throw error;
      const reason = String(error?.message ?? error);
      fellBackFrom = { backend, reason };
      onFallback?.(backend, reason, next);
    }
  }

  // Unreachable: the loop returns or throws on the last backend.
  throw new Error('No speech-to-text backend answered.');
}
