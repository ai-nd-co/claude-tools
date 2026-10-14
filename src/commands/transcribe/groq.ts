// OpenAI-compatible speech-to-text provider: Groq, and the office speech cluster.
//
// Both backends serve the same `audio/transcriptions` and `audio/translations`
// endpoints, so one implementation covers them; which one is being called is
// carried by the `SttBackend` and only shows in base URL, key, model and the
// wording of errors. See `services/stt.ts` for how backends are chosen.

import * as fs from 'fs';
import * as path from 'path';
import type { GroqConfig } from '../../config/types.js';
import { STT_FLOOR_MS, STT_MS_PER_AUDIO_SECOND, requestTimeoutMs, type SttBackend } from '../../services/stt.js';
import { audioDurationSeconds } from '../../services/audio-duration.js';

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

/**
 * Container formats the ASR endpoints accept. Both backends decode Opus/Vorbis in
 * an Ogg container directly, so Telegram voice notes need no ffmpeg step — unlike
 * the Wispr path, which must transcode to 16kHz mono WAV first.
 */
const SUPPORTED_EXTENSIONS = new Set([
  '.flac', '.mp3', '.mp4', '.mpeg', '.mpga', '.m4a', '.ogg', '.oga', '.opus', '.wav', '.webm',
]);

/**
 * Groq matches the container on the *upload filename's* extension and rejects
 * `.oga`, even though it is the same Ogg/Opus container it accepts as `.ogg`.
 * The Telegram Bot API serves voice notes as `.oga`, so the name has to be
 * normalised or every bot voice note fails with a 400. The cluster accepts
 * `.oga`, but the same name is sent to both so a clip behaves the same everywhere.
 */
const UPLOAD_EXTENSION_ALIASES: Record<string, string> = {
  '.oga': '.ogg',
};

/** Groq rejects uploads above 25MB on the free tier with a 413. */
const GROQ_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * The cluster has no upload cap of its own; this one keeps a mistaken multi-hour
 * recording from being pushed through the office uplink. 100 MB is about nine
 * hours of Opus voice-note audio.
 */
const CLUSTER_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export interface GroqTranscribeOptions {
  /** ISO-639-1 hint. Omitted for auto-detection. */
  language?: string;
  /** Overrides the configured default model. */
  model?: string;
  /** Bias the decoder towards names and jargon it would otherwise mangle. */
  prompt?: string;
  /** Translate to English instead of transcribing verbatim. */
  translate?: boolean;
  /** Emit per-segment timings. */
  timestamps?: boolean;
  /**
   * The clip's length, when the caller knows it. Telegram reports one for every
   * voice note. It only sets how long the request is allowed to take; without it
   * the file's size stands in. See `requestTimeoutMs` in `services/stt.ts`.
   */
  audioSeconds?: number;
}

export interface GroqSegment {
  start: number;
  end: number;
  text: string;
}

export interface GroqTranscriptionResult {
  text: string;
  /** Absent on the translation endpoint, which always returns English. */
  language?: string;
  /** Audio duration in seconds, as reported by the backend. */
  duration?: number;
  model: string;
  segments?: GroqSegment[];
  /** Mean per-segment confidence, when the backend reported it. */
  avgLogprob?: number;
}

interface GroqVerboseResponse {
  text?: string;
  language?: string;
  duration?: number;
  segments?: Array<{ start: number; end: number; text: string; avg_logprob?: number }>;
  error?: { message?: string; type?: string; code?: string };
  /** FastAPI servers (the cluster) put their error text here instead. */
  detail?: unknown;
}

/**
 * A failed request, with the HTTP status when there was a response. The status
 * is what lets `services/stt.ts` tell "this backend is down, try the next" from
 * "this request is wrong, stop".
 */
export class SttRequestError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'SttRequestError';
  }
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${(bytes / 1024).toFixed(1)} KB`;
}

/** The upload cap a backend enforces, for validating before the request. */
export function maxUploadBytes(provider: SttBackend['provider']): number {
  return provider === 'groq' ? GROQ_MAX_UPLOAD_BYTES : CLUSTER_MAX_UPLOAD_BYTES;
}

/**
 * Validate the file before spending a round-trip on it. The backends' own errors
 * for an unsupported container are opaque ("could not process file"), so the
 * extension and size are checked locally where the message can name the fix.
 * The size cap is Groq's unless told otherwise; the command validates before it
 * knows which backend will answer, and Groq's is the tighter of the two.
 */
export function assertUsableAudio(absolutePath: string, limitBytes = GROQ_MAX_UPLOAD_BYTES, label = 'Groq'): number {
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Audio file not found: ${absolutePath}`);
  }

  const stat = fs.statSync(absolutePath);
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${absolutePath}`);
  }
  if (stat.size === 0) {
    throw new Error(`Audio file is empty: ${absolutePath}`);
  }
  if (stat.size > limitBytes) {
    throw new Error(
      `Audio file is ${formatBytes(stat.size)}; ${label}'s limit is ${formatBytes(limitBytes)}.\n` +
      `Downsample it first, e.g.: ffmpeg -i "${absolutePath}" -ar 16000 -ac 1 -c:a libopus out.ogg`
    );
  }

  const ext = path.extname(absolutePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    throw new Error(
      `Unsupported audio format "${ext || '(none)'}" for ${label}.\n` +
      `Supported: ${[...SUPPORTED_EXTENSIONS].join(', ')}`
    );
  }

  return stat.size;
}

/**
 * Strip anything that looks like an API key out of text about to be printed.
 * Neither backend is expected to echo the credential, but an error body is
 * arbitrary upstream text and the key must never reach a terminal or a log.
 * Groq keys have a recognisable prefix; the cluster key is matched literally.
 */
function redactKeys(text: string, apiKey?: string): string {
  let out = text.replace(/gsk_[A-Za-z0-9]{8,}/g, 'gsk_***');
  if (apiKey && apiKey.length >= 8) out = out.split(apiKey).join('***');
  return out;
}

/**
 * Surface the backend's own error text rather than a bare status. A wrong key
 * returns 401/403 with a body explaining which header it rejected, and that
 * detail is the difference between a one-line fix and a guessing game.
 */
async function readError(response: Response, backend: SttBackend): Promise<never> {
  const body = await response.text();

  let detail = body;
  try {
    const parsed = JSON.parse(body) as GroqVerboseResponse;
    if (parsed.error?.message) detail = parsed.error.message;
    else if (typeof parsed.detail === 'string') detail = parsed.detail;
    else if (parsed.detail !== undefined) detail = JSON.stringify(parsed.detail);
  } catch {
    // Non-JSON body (proxy error page); the raw text is the best we have.
  }

  const redact = (s: string) => redactKeys(s, backend.apiKey);
  const { label, provider } = backend;
  const keyHint = provider === 'groq'
    ? 'Check GROQ_API_KEY or the groq.apiKey secret.'
    : 'Check SPEECH_API_KEY or the speech.apiKey secret.';

  // Every branch is redacted, including `statusText`, which is also upstream text.
  if (response.status === 401 || response.status === 403) {
    throw new SttRequestError(redact(`${label} rejected the API key: ${detail}\n${keyHint}`), response.status);
  }
  if (response.status === 429) {
    throw new SttRequestError(redact(`${label} rate limit reached: ${detail}`), response.status);
  }
  if (response.status === 413) {
    throw new SttRequestError(redact(`Audio too large for ${label}: ${detail}`), response.status);
  }

  throw new SttRequestError(
    redact(`${label} API error ${response.status} ${response.statusText}: ${detail}`),
    response.status
  );
}

/** The name sent to the backend, with a container alias applied if needed. */
export function uploadFilename(absolutePath: string): string {
  const base = path.basename(absolutePath);
  const ext = path.extname(base).toLowerCase();
  const alias = UPLOAD_EXTENSION_ALIASES[ext];

  return alias ? `${base.slice(0, base.length - ext.length)}${alias}` : base;
}

/** One request. The retry policy lives in `transcribeWithBackend`, which calls this. */
async function sendOnce(
  audioFile: string,
  backend: SttBackend,
  options: GroqTranscribeOptions = {}
): Promise<GroqTranscriptionResult> {
  const absolutePath = path.resolve(audioFile);
  assertUsableAudio(absolutePath, maxUploadBytes(backend.provider), backend.label);

  // The bound is worked out here, in the one place that actually issues the
  // request, so no caller can reach the network without one. It depends on this
  // clip, not on the backend, which is reused for every clip a watcher reads.
  // `transcribeWithGroq` goes straight through here and used to miss it.
  const audioSeconds = options.audioSeconds ?? (await audioDurationSeconds(absolutePath)) ?? undefined;
  const timeoutMs = requestTimeoutMs(backend, absolutePath, audioSeconds);

  const model = options.model || backend.model;
  // The translation endpoint takes no `language` parameter — it always targets
  // English — and returns no detected language.
  const endpoint = options.translate ? 'audio/translations' : 'audio/transcriptions';

  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(absolutePath)]), uploadFilename(absolutePath));
  form.append('model', model);
  // Always `verbose_json`, because it is the only format that carries the
  // per-segment confidence.
  //
  // It is requested even with no retry policy configured, and that is the point:
  // the score is stored with every transcript, so turning the policy on later can
  // tell which cached clips it would have changed. Asking only when the policy is
  // already on would mean every clip cached beforehand has no score, is treated
  // as sound, and never gets corrected - which is exactly what I measured before
  // changing this. The cost is a slightly larger response body and no extra work
  // for the backend; segments stay out of the caller's result unless asked for.
  form.append('response_format', 'verbose_json');
  // An explicit per-call prompt wins; otherwise the configured vocabulary is
  // sent on every request, which is the point of configuring it.
  const prompt = options.prompt ?? backend.prompt;
  if (prompt) form.append('prompt', prompt);
  if (options.language && !options.translate) form.append('language', options.language);
  if (options.timestamps) form.append('timestamp_granularities[]', 'segment');

  let response: Response;
  try {
    response = await fetch(`${backend.baseUrl.replace(/\/+$/, '')}/${endpoint}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${backend.apiKey}` },
      body: form,
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    });
  } catch (error: any) {
    // No response at all: unreachable host, refused connection, TLS failure, or
    // the timeout above. No status, which is what marks it as "try the next one".
    const why = error?.name === 'TimeoutError'
      ? `no answer within ${Math.round((timeoutMs ?? 0) / 1000)}s`
      : redactKeys(String(error?.cause?.message ?? error?.message ?? error), backend.apiKey);
    throw new SttRequestError(`${backend.label} is unreachable: ${why}`);
  }

  // The body is read under the same guard as the connection: the timeout can
  // fire, or the link drop, after the headers arrived. A failure here keeps the
  // status it came with, so a stalled 403 still stops and a stalled 503 still
  // falls back.
  let bodyText: string;
  try {
    if (!response.ok) {
      await readError(response, backend);
    }
    bodyText = await response.text();
  } catch (error: any) {
    if (error instanceof SttRequestError) throw error;
    const why = error?.name === 'TimeoutError'
      ? `no complete answer within ${Math.round((timeoutMs ?? 0) / 1000)}s`
      : redactKeys(String(error?.cause?.message ?? error?.message ?? error), backend.apiKey);
    throw new SttRequestError(
      `${backend.label} answered ${response.status} but the response could not be read: ${why}`,
      response.ok ? undefined : response.status
    );
  }

  // A complete 200 that is not JSON is a wrong answer, not a dropped one: it is
  // reported, never retried elsewhere.
  let payload: GroqVerboseResponse;
  try {
    payload = JSON.parse(bodyText) as GroqVerboseResponse;
  } catch {
    throw new Error(`${backend.label} returned a non-JSON answer for ${path.basename(absolutePath)}`);
  }

  // A 200 with an empty `text` means the backend decoded the container but found
  // no speech. Returning "" would look like a successful empty transcript.
  if (typeof payload.text !== 'string') {
    throw new Error(`${backend.label} returned no transcript for ${path.basename(absolutePath)}`);
  }

  return {
    text: payload.text.trim(),
    language: payload.language,
    duration: payload.duration,
    model,
    // `verbose_json` is requested whenever a fallback language is configured, to
    // get the confidence - but that is an internal need, and the caller's output
    // must not change shape because of it. Segments are returned only when they
    // were asked for, so a fresh result and a cached one look the same.
    segments: options.timestamps
      ? payload.segments?.map((s) => ({ start: s.start, end: s.end, text: s.text.trim() }))
      : undefined,
    avgLogprob: averageLogprob(payload.segments),
  };
}

/**
 * The model's own mean confidence over the segments, when it reported any.
 *
 * This is what tells a wrong-language transcript from a right one. Measured over
 * 29 of one speaker's voice notes: the 28 correctly detected clips scored between
 * -0.027 and -0.231, while the one detected as Turkish instead of English scored
 * **-0.836** and read as fluent nonsense. Forcing the right language on that clip
 * moved it to -0.075; forcing a third language gave -0.635.
 */
function averageLogprob(segments?: Array<{ avg_logprob?: number }>): number | undefined {
  const scored = (segments ?? []).map((s) => s.avg_logprob).filter((v): v is number => typeof v === 'number');
  if (scored.length === 0) return undefined;
  return scored.reduce((a, b) => a + b, 0) / scored.length;
}

/**
 * Below this, assume the language was detected wrongly and try again.
 *
 * Bounded from both sides by the measurement above rather than chosen as a round
 * number: 1.7× below the worst correctly-detected clip (-0.231) and 1.6× above
 * the observed failure (-0.836). A clip that scores in between is ambiguous, and
 * paying one extra request to find out is the cheaper mistake — the failure is a
 * confident, fluent transcript in the wrong language, which nothing downstream
 * can tell from a good one.
 */
const LANGUAGE_RETRY_LOGPROB = -0.4;

/**
 * Language names as the two backends actually report them, reduced to an ISO
 * code so they can be compared.
 *
 * They do not agree: on the same six clips our cluster returned `en` and Groq
 * returned `English`. Comparing those raw would make every low-confidence
 * English clip from Groq look like a different language and buy a second,
 * billed request that could not improve on the first.
 *
 * Only the languages this chat carries are mapped, and anything unrecognised
 * falls through lower-cased: a name we do not know simply fails to match, which
 * is the behaviour without this function and costs one retry rather than a
 * wrong transcript.
 */
const LANGUAGE_NAMES: Record<string, string> = {
  english: 'en', russian: 'ru', uzbek: 'uz', turkish: 'tr', ukrainian: 'uk',
  kazakh: 'kk', kyrgyz: 'ky', tajik: 'tg', german: 'de', french: 'fr', spanish: 'es',
};

function isoLanguage(value?: string): string | undefined {
  if (!value) return undefined;
  const lower = value.trim().toLowerCase();
  return LANGUAGE_NAMES[lower] ?? lower;
}

/**
 * The retry policy a backend is operating under, as an ISO code. Stored with
 * every transcript so a later read can tell which policy produced it.
 */
export function retryPolicyOf(
  backend: SttBackend,
  options: { language?: string; translate?: boolean } = {}
): string | undefined {
  // Mirrors `transcribeWithBackend`: these requests are never retried, so no
  // policy was in force for them.
  if (options.language || options.translate) return undefined;
  return isoLanguage(backend.fallbackLanguage);
}

/**
 * Whether a cached transcript should be thrown away because the retry policy has
 * changed since it was made.
 *
 * One comparison does the whole job: the policy that produced the entry against
 * the policy in force now. An entry made under the same policy is kept however
 * it came about - the retry ran and won, ran and lost, threw, or was skipped
 * because the clip was already in that language - because re-running it under an
 * unchanged policy cannot produce anything different. An entry made under a
 * different policy, or none, is redone.
 *
 * Confined to low-confidence entries, which is what keeps this cheap: a
 * confident transcript is never affected by the retry, so it stays a cache hit
 * whatever the policy does. An entry written before the score was stored has no
 * score and is likewise kept - the alternative is invalidating every transcript
 * ever cached, which costs a re-transcription, and a bill, for each one.
 */
export function cachedTranscriptIsSuspect(
  cached: { avgLogprob?: number; retriedIn?: string },
  backend: SttBackend,
  options: { language?: string; translate?: boolean } = {}
): boolean {
  if (cached.avgLogprob === undefined || cached.avgLogprob >= LANGUAGE_RETRY_LOGPROB) return false;
  return isoLanguage(cached.retriedIn) !== retryPolicyOf(backend, options);
}

/**
 * Transcribe, and give the backend a second chance when it mis-detects the
 * language.
 *
 * Only the clips that need it pay: with a `fallbackLanguage` configured, a first
 * pass that scores below the threshold is retried with that language named, and
 * whichever answer the model is more confident in is returned. Measured at about
 * one clip in thirty, costing roughly 1.5 s on a 9-second note.
 *
 * Nothing happens here when the caller already named a language, when none is
 * configured, when the backend reported no confidence, or when this is a
 * translation — that endpoint takes no language at all.
 */
export async function transcribeWithBackend(
  audioFile: string,
  backend: SttBackend,
  options: GroqTranscribeOptions = {}
): Promise<GroqTranscriptionResult> {
  const first = await sendOnce(audioFile, backend, options);

  const fallback = backend.fallbackLanguage;
  if (
    !fallback ||
    options.language ||
    options.translate ||
    first.avgLogprob === undefined ||
    first.avgLogprob >= LANGUAGE_RETRY_LOGPROB ||
    // Already the language we would ask for, however it chose to spell it: a
    // retry could only repeat the same request.
    isoLanguage(first.language) === isoLanguage(fallback)
  ) {
    return first;
  }

  // A failure to transcribe the second time is not a reason to lose the first
  // answer: a poor transcript beats none, and the caller's fallback chain is
  // for backends that did not answer at all.
  let retried: GroqTranscriptionResult;
  try {
    retried = await sendOnce(audioFile, backend, { ...options, language: fallback });
  } catch {
    return first;
  }

  if (retried.avgLogprob === undefined) return first;
  return retried.avgLogprob > first.avgLogprob ? retried : first;
}

/** Groq as a backend. Lives here, next to its URL, so `services/stt.ts` need not know it. */
export function groqBackend(config: GroqConfig): SttBackend {
  return {
    provider: 'groq',
    label: 'Groq',
    baseUrl: GROQ_BASE_URL,
    apiKey: config.apiKey,
    model: config.model,
    prompt: config.prompt,
    fallbackLanguage: config.fallbackLanguage,
    // Bounded on the same terms as the cluster, and for a sharper reason: Groq is
    // the last backend, so when it accepts a connection and goes quiet there is
    // nothing after it to fall back to. Unbounded, that was a wait with no end.
    // It is also the faster of the two (1.1 s and 3.3 s on the same clips), so
    // the cluster's floor is generous here.
    timeoutMs: STT_FLOOR_MS,
    msPerAudioSecond: STT_MS_PER_AUDIO_SECOND,
  };
}

/** Groq alone, for callers that hold only a `GroqConfig`. */
export async function transcribeWithGroq(
  audioFile: string,
  config: GroqConfig,
  options: GroqTranscribeOptions = {}
): Promise<GroqTranscriptionResult> {
  return transcribeWithBackend(audioFile, groqBackend(config), options);
}
