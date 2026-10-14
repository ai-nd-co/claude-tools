// Automatic transcription of short voice notes for the `telegram read` path.
//
// Reading a chat should show what a voice note says, not just `[voice]`. Only
// short clips are transcribed automatically: a long recording is usually a
// deliberate hand-off that deserves an explicit `transcribe --tg`, and the cost
// and latency of a 10-minute upload does not belong in a routine read.

import type { GroqConfig } from '../config/types.js';
import type { TelegramService } from './telegram.js';
import { asBackends, effectivePrompt, transcribeAudio, type SttBackend } from './stt.js';
import { cachedTranscriptIsSuspect, retryPolicyOf } from '../commands/transcribe/groq.js';
import { readTranscriptCache, writeTranscriptCache, type TranscriptCacheKey } from './transcript-cache.js';
import { measureAudioLevel, silentAudioNote } from './audio-silence.js';

/** Clips at or under this length are transcribed without being asked. */
/**
 * Three minutes, not one.
 *
 * The owner dictates away from the keyboard and a single thought regularly runs past a minute; at 60s
 * his 97- and 64-second messages were both dropped. `bot watch` was raised to 180 on 2026-09-26 and
 * **this shared default was missed**, so the user-account watcher — the one reading team chats — kept
 * silently discarding anything over a minute. Found by a peer session reviewing that fix.
 */
export const DEFAULT_MAX_DURATION_SECONDS = 180;

/**
 * Ceiling on API calls per read. A chat full of voice notes would otherwise turn
 * one `read` into dozens of uploads; the cap keeps the first read bounded, and
 * the cache makes every later read free.
 */
export const DEFAULT_MAX_MESSAGES = 3;

/**
 * The minimum a message must expose to be transcribed. Declared structurally so
 * both `TelegramMessage` (from reads) and `WatchMessage` (from the watcher)
 * qualify without either shape depending on the other.
 */
export interface TranscribableMessage {
  id: number;
  hasMedia?: boolean;
  mediaType?: string;
  mediaDuration?: number;
  transcript?: string;
  /** Why there is no `transcript`, when the clip was skipped rather than attempted. */
  transcriptSkipped?: string;
}

export interface AutoTranscribeOptions {
  maxDurationSeconds?: number;
  maxMessages?: number;
  model?: string;
  language?: string;
}

export interface AutoTranscribeSummary {
  /** Sent to a backend (the cluster, or Groq and billed). */
  transcribed: number;
  /** Served from the on-disk cache; no download, no API call. */
  cacheHits: number;
  /** Too long, or past the per-read cap. */
  skipped: number;
  failed: number;
  /**
   * Transcribed, but the transcript could not be cached, so the same audio will
   * be billed again next time. Callers should surface this.
   */
  cacheWriteFailures: number;
  /** The backend found no speech. Cached, so a silent clip is never re-sent. */
  empty: number;
  /** Recordings that captured no audio at all, so were never sent to Whisper. */
  silent: number;
}

function isTranscribable(message: TranscribableMessage): boolean {
  return message.hasMedia === true && (message.mediaType === 'voice' || message.mediaType === 'audio');
}

function cacheKeyFor(
  chatId: string,
  message: TranscribableMessage,
  model: string,
  language?: string,
  prompt?: string
): TranscriptCacheKey {
  return {
    source: 'tg',
    id: `${chatId}:${message.id}`,
    model,
    language,
    translate: false,
    // Part of the identity: a transcript decoded with a glossary is not the same
    // answer as one decoded without it, so configuring or changing one must not
    // be answered from an entry made under the old vocabulary.
    prompt,
  };
}

/**
 * The cache entry a clip would have under each backend, primary first.
 *
 * The cache keys on the model id, and the cluster and Groq name their models
 * differently, so one clip has one entry per backend. A hit under ANY of them is
 * a transcript of this audio and is served; a miss is written under the backend
 * that actually answered, so a fallback to Groq is never filed as the cluster's.
 */
function cacheKeysFor(
  chatId: string,
  message: TranscribableMessage,
  backends: SttBackend[],
  options: AutoTranscribeOptions
): Array<{ key: TranscriptCacheKey; backends: SttBackend[] }> {
  // Keyed per model and prompt, since those are what the filename is made of -
  // but every backend that shares a key is kept against it. Two backends can
  // share a model and a vocabulary while running different retry policies, and
  // either of them may have written the entry; dropping one of the two means an
  // entry the other produced is judged by a policy that never applied to it, and
  // re-transcribed on every read.
  const grouped = new Map<string, { key: TranscriptCacheKey; backends: SttBackend[] }>();
  for (const backend of backends) {
    const model = options.model ?? backend.model;
    const prompt = effectivePrompt(backend);
    const dedupe = `${model}\u0000${prompt ?? ''}`;
    const existing = grouped.get(dedupe);
    if (existing) {
      existing.backends.push(backend);
      continue;
    }
    grouped.set(dedupe, {
      key: cacheKeyFor(chatId, message, model, options.language, prompt),
      backends: [backend],
    });
  }
  return [...grouped.values()];
}

function readAnyCached(
  keys: Array<{ key: TranscriptCacheKey; backends: SttBackend[] }>,
  options: AutoTranscribeOptions
) {
  for (const { key, backends } of keys) {
    const cached = readTranscriptCache(key);
    if (!cached) continue;
    // Kept when ANY backend sharing this key would still produce it. Rejecting
    // it needs every one of them to disagree with what it was made under;
    // otherwise an entry written by one backend is condemned by another's policy
    // and re-transcribed for ever.
    if (backends.every((b) => cachedTranscriptIsSuspect(cached, b, { language: options.language }))) continue;
    return cached;
  }
  return null;
}

/**
 * Fill in `transcript` on every short voice/audio message in `messages`.
 *
 * `stt` is the ordered backend list from `resolveSttBackends` (the cluster, then
 * Groq); a bare `GroqConfig` is still accepted and means Groq alone.
 *
 * Never throws: a transcription failure degrades the read to the plain
 * `[voice]` indicator rather than losing the messages the caller asked for.
 * Mutates the given messages in place and returns what it did.
 */
export async function attachVoiceTranscripts(
  service: TelegramService,
  chatId: string,
  messages: TranscribableMessage[],
  stt: SttBackend[] | GroqConfig,
  options: AutoTranscribeOptions = {}
): Promise<AutoTranscribeSummary> {
  const maxDuration = options.maxDurationSeconds ?? DEFAULT_MAX_DURATION_SECONDS;
  const maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const backends = asBackends(stt);
  if (backends.length === 0) {
    return { transcribed: 0, cacheHits: 0, skipped: 0, failed: 0, cacheWriteFailures: 0, empty: 0, silent: 0 };
  }

  const summary: AutoTranscribeSummary = {
    transcribed: 0, cacheHits: 0, skipped: 0, failed: 0, cacheWriteFailures: 0, empty: 0, silent: 0,
  };
  let budget = maxMessages;

  for (const message of messages) {
    if (!isTranscribable(message)) continue;

    // Telegram reports a duration for voice notes; when it is missing we cannot
    // tell a 5-second clip from an hour-long one, so leave it alone.
    if (message.mediaDuration === undefined || message.mediaDuration > maxDuration) {
      // Say WHY rather than skipping in silence. An unexplained missing transcript reads as a
      // transcription failure, and the reader has no way to know a cap exists or how to raise it —
      // which is how a 60s cap went unnoticed until two of the owner's messages were lost to it.
      message.transcriptSkipped =
        message.mediaDuration === undefined
          ? 'not transcribed: Telegram reported no duration for this clip'
          : `not transcribed: ${Math.round(message.mediaDuration)}s over the ${maxDuration}s cap — raise --transcribe-max`;
      summary.skipped++;
      continue;
    }

    const keys = cacheKeysFor(chatId, message, backends, options);
    const cached = readAnyCached(keys, options);
    if (cached) {
      // An empty cached transcript means "no speech", not "not yet transcribed".
      message.transcript = cached.text || undefined;
      summary.cacheHits++;
      continue;
    }

    // Past the cap: leave the rest untranscribed rather than partially billing a
    // huge chat. They stay reachable with `transcribe --tg <id>`.
    if (budget <= 0) {
      summary.skipped++;
      continue;
    }

    try {
      const download = await service.downloadMedia(chatId, message.id);

      // The download is the slow part, so another process may have transcribed
      // and cached this clip while it ran. Re-check before paying for it.
      const racedIn = readAnyCached(keys, options);
      if (racedIn) {
        message.transcript = racedIn.text || undefined;
        summary.cacheHits++;
        continue;
      }

      // A recording that captured nothing must never reach Whisper. It is
      // trained on subtitles, so silence does not yield an empty string - it
      // yields invented filler. A real 8.39s clip at -91 dB produced "you",
      // and "Продолжение следует..." with a Russian hint. Both read as a short
      // message someone meant to send, which is precisely the danger: an agent
      // acts on the sentence instead of reporting that nothing was recorded.
      const level = await measureAudioLevel(download.filepath);
      if (level.silent) {
        const note = silentAudioNote(level);
        message.transcript = note;
        summary.silent++;
        // Cached like any other answer: the clip will not become audible later,
        // and re-measuring it on every read costs an ffmpeg run for nothing.
        if (!writeTranscriptCache(keys[0].key, { text: note, model: options.model ?? '' })) {
          summary.cacheWriteFailures++;
        }
        budget--;
        continue;
      }

      const { result, backend: answered } = await transcribeAudio(download.filepath, backends, {
        model: options.model,
        language: options.language,
        // Checked non-undefined by the duration gate above. It sets how long the
        // backend is allowed, so a stuck one falls back in seconds.
        audioSeconds: message.mediaDuration,
      });

      // An empty result is a real answer ("no speech"), so it is cached to avoid
      // paying again, but there is nothing to show for it.
      message.transcript = result.text || undefined;
      if (!result.text) summary.empty++;

      // Filed under the model that answered, which is the key of that backend.
      const stored = writeTranscriptCache(
        cacheKeyFor(chatId, message, result.model, options.language, effectivePrompt(answered)), {
        text: result.text,
        language: result.language,
        // Stored so a later change of retry policy can tell which transcripts it
        // would have changed, without invalidating the ones it would not.
        avgLogprob: result.avgLogprob,
        retriedIn: retryPolicyOf(answered, { language: options.language }),
        duration: result.duration,
        model: result.model,
      });
      if (!stored) summary.cacheWriteFailures++;

      summary.transcribed++;
      budget--;
    } catch {
      // Swallowed deliberately: see the contract above.
      summary.failed++;
      budget--;
    }
  }

  return summary;
}
