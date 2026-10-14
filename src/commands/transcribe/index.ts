// Transcribe command - speech-to-text via the office speech cluster, Groq, or Wispr Flow

import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync } from 'fs';
import * as path from 'path';
import { loadConfig } from '../../config/loader.js';
import { TelegramService } from '../../services/telegram.js';
import { transcribe as transcribeWithWispr } from './wispr.js';
import {
  assertUsableAudio,
  cachedTranscriptIsSuspect,
  maxUploadBytes,
  retryPolicyOf,
  type GroqTranscriptionResult,
} from './groq.js';
import {
  effectivePrompt,
  resolveSttBackends,
  transcribeAudio,
  type SttBackend,
  type SttProvider,
} from '../../services/stt.js';
import {
  hashFileContents,
  pruneTranscriptCache,
  readTranscriptCache,
  writeTranscriptCache,
  type TranscriptCacheKey,
} from '../../services/transcript-cache.js';

type Provider = SttProvider | 'wispr';

interface TranscribeCommandOptions {
  provider?: string;
  model?: string;
  language?: string;
  prompt?: string;
  translate?: boolean;
  timestamps?: boolean;
  json?: boolean;
  quiet?: boolean;
  tg?: string;
  chat?: string;
  cache?: boolean;
}

/**
 * Pick the backends to try, in order.
 *
 * Unasked, the configured OpenAI-compatible backends are used as `resolveSttBackends`
 * orders them — the cluster first, Groq as its fallback — and Wispr only when
 * neither exists, because Wispr reads a local Wispr Flow session that only exists
 * on a Windows desktop where the app is installed and logged in. A named provider
 * is used alone: asking for one is asking for its answer, not a silent substitute.
 */
function resolveBackends(requested: string | undefined, configured: SttBackend[]): SttBackend[] | 'wispr' {
  if (requested) {
    const normalized = requested.toLowerCase();
    if (normalized === 'wispr') return 'wispr';
    if (normalized !== 'cluster' && normalized !== 'groq') {
      throw new Error(`Unknown provider "${requested}". Expected: cluster, groq, wispr`);
    }
    const backend = configured.find((b) => b.provider === normalized);
    if (!backend) {
      throw new Error(
        normalized === 'groq'
          ? 'Groq is not configured.\n  Set GROQ_API_KEY, or add {"groq":{"apiKey":"gsk_..."}} to the secrets file.'
          : 'The speech cluster is not configured.\n  Set SPEECH_API_KEY, or add {"speech":{"apiKey":"..."}} to the secrets file.'
      );
    }
    return [backend];
  }

  return configured.length > 0 ? configured : 'wispr';
}

function formatTimestamp(seconds: number): string {
  const total = Math.floor(seconds);
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

/**
 * Download a Telegram voice note / audio message and return its local path.
 * Kept here rather than in the media command so `transcribe --tg` is a single
 * call instead of download-then-copy-the-path.
 */
/**
 * Resolve `--tg` to a canonical chat id without transferring anything, so the
 * cache can be consulted before a download. The read path keys transcripts on
 * this same canonical id, so both share entries.
 */
async function resolveTelegramTarget(
  messageIdRaw: string,
  chat: string | undefined
): Promise<{ chatId: string; messageId: number }> {
  const messageId = Number(messageIdRaw);
  if (!Number.isInteger(messageId) || messageId <= 0) {
    throw new Error(`Invalid --tg message id: ${messageIdRaw}`);
  }

  const config = loadConfig();
  if (!config.telegram) {
    throw new Error('Telegram not configured. Run: claude-tools telegram auth');
  }

  const selector = chat || config.telegram.defaultChat;
  if (!selector) {
    throw new Error('No chat given. Pass --chat <chat> or set telegram.defaultChat.');
  }

  const service = new TelegramService(config.telegram);
  try {
    await service.connect();
    const resolved = await service.resolveChat(selector);
    return { chatId: String(resolved.id), messageId };
  } finally {
    await service.disconnect();
  }
}

/** Download the audio for an already-resolved Telegram message. */
async function downloadTelegramAudio(
  chatId: string,
  messageId: number,
  quiet: boolean
): Promise<string> {
  const config = loadConfig();
  const service = new TelegramService(config.telegram!);
  try {
    await service.connect();

    if (!quiet) {
      console.log(chalk.dim(`Downloading #${messageId} from ${chatId}...`));
    }

    const result = await service.downloadMedia(chatId, messageId);

    // Transcribing a photo wastes a round-trip and returns a confusing error
    // from Groq, so reject anything that is not audio up front.
    if (result.type !== 'voice' && result.type !== 'audio') {
      throw new Error(`Message #${messageId} is ${result.type}, not audio.`);
    }

    return result.filepath;
  } finally {
    await service.disconnect();
  }
}

function printGroqResult(result: GroqTranscriptionResult, options: TranscribeCommandOptions, via?: string): void {
  if (options.json) {
    // `avgLogprob` is how the language retry decides; it is not part of the
    // transcript anyone asked for, and a cached answer cannot supply it, so
    // printing it would make the two shapes differ.
    const { avgLogprob: _score, ...shown } = result;
    console.log(JSON.stringify(shown, null, 2));
    return;
  }

  if (options.quiet) {
    console.log(result.text);
    return;
  }

  console.log('');
  console.log(chalk.bold(options.translate ? 'Translation:' : 'Transcription:'));
  console.log(result.text);

  if (result.segments?.length) {
    console.log('');
    console.log(chalk.bold('Segments:'));
    for (const segment of result.segments) {
      console.log(`${chalk.dim(`[${formatTimestamp(segment.start)}]`)} ${segment.text}`);
    }
  }

  const meta = [
    result.language ? `language: ${result.language}` : null,
    result.duration !== undefined ? `duration: ${result.duration.toFixed(1)}s` : null,
    `model: ${result.model}`,
    via ? `via: ${via}` : null,
  ].filter(Boolean);

  console.log('');
  console.log(chalk.dim(meta.join(' | ')));
}

export function registerTranscribeCommand(program: Command) {
  program
    .command('transcribe [audio-file]')
    .description('Transcribe audio to text (via the speech cluster, Groq, or Wispr Flow)')
    .option('--provider <name>', 'cluster, groq or wispr (default: cluster, then Groq, whichever is configured)')
    .option('--model <model>', 'ASR model id for the first backend (default: its own; disables the fallback)')
    .option('--language <lang>', 'Language hint, e.g. en, ru, uz (default: auto-detect)')
    .option('--prompt <text>', 'Bias decoding towards names/jargon (not Wispr)')
    .option('--translate', 'Translate to English instead of verbatim (not Wispr)')
    .option('--timestamps', 'Include per-segment timings (not Wispr)')
    .option('--tg <messageId>', 'Transcribe a Telegram voice/audio message')
    .option('--chat <chat>', 'Chat for --tg (default: telegram.defaultChat)')
    .option('--json', 'Output raw JSON response')
    .option('--quiet', 'Only output transcribed text')
    .option('--no-cache', 'Ignore any cached transcript and transcribe again')
    .action(async (audioFile: string | undefined, options: TranscribeCommandOptions) => {
      try {
        if (!audioFile && !options.tg) {
          throw new Error('Nothing to transcribe. Pass an audio file or --tg <messageId>.');
        }
        if (audioFile && options.tg) {
          throw new Error('Pass either an audio file or --tg <messageId>, not both.');
        }

        const config = loadConfig();
        const backends = resolveBackends(options.provider, resolveSttBackends(config));
        const quiet = Boolean(options.quiet || options.json);

        // Resolve the target first but download nothing yet: for `--tg` the
        // cache can be answered from the chat id alone, which saves the transfer.
        const target = options.tg
          ? await resolveTelegramTarget(options.tg, options.chat)
          : null;

        if (backends === 'wispr') {
          for (const [flag, value] of [
            ['--translate', options.translate],
            ['--timestamps', options.timestamps],
            ['--prompt', options.prompt],
            ['--model', options.model],
          ] as const) {
            if (value) {
              throw new Error(`${flag} is not supported by the wispr provider.`);
            }
          }

          // Wispr's API requires an explicit language; it has no auto-detect.
          await transcribeWithWispr(
            target ? await downloadTelegramAudio(target.chatId, target.messageId, quiet) : audioFile!,
            {
              language: options.language || 'en',
              json: options.json,
              quiet: options.quiet,
            }
          );
          return;
        }

        // `--model` names a model of ONE backend (the ids differ between them), so
        // it applies to the first backend and switches the fallback off: Groq would
        // reject the cluster's id and the cluster Groq's, and that failure would
        // read as an outage.
        const tried = options.model ? [backends[0]] : backends;

        // Validate before hashing: `hashFileContents` reads the whole file, so an
        // oversized or unsupported one has to be rejected first — otherwise a
        // multi-gigabyte recording is loaded into memory only to be refused. The
        // cap is the first backend's; a fallback re-checks against its own.
        if (!target) assertUsableAudio(path.resolve(audioFile!), maxUploadBytes(tried[0].provider), tried[0].label);

        // `--timestamps` needs per-segment data the cache does not store, so it
        // always calls a backend. Everything else shares the read path's cache: a
        // Telegram clip keys on (chat, message), a local file on its contents,
        // so the same audio is never paid for twice. The cache keys on the model
        // id and each backend names its model differently, so there is one key
        // per backend: a hit under any of them is served, a miss is filed under
        // the backend that answered. The content hash is taken once: the file is
        // what was uploaded, not what is on disk when the answer comes back.
        const caching = options.cache !== false && !options.timestamps;
        // Hashing reads the whole file, so it only happens when the cache is in play.
        const cacheId = !caching ? '' : target ? `${target.chatId}:${target.messageId}` : hashFileContents(audioFile!);
        const cacheKeyFor = (model: string, prompt?: string): TranscriptCacheKey => ({
          source: target ? 'tg' : 'file',
          // A local file keys on its contents, so a copy or a rename hits.
          id: cacheId,
          model,
          language: options.language,
          translate: Boolean(options.translate),
          // A different decoding prompt yields a different transcript — and the
          // prompt can come from config, not only from `--prompt`.
          prompt,
        });
        // One key per backend, since each carries its own configured vocabulary.
        // Every backend sharing a key is kept against it: two can share a model
        // and a vocabulary while running different retry policies, and either
        // may have written the entry.
        const cacheKeys: Array<{ key: TranscriptCacheKey; backends: SttBackend[] }> = [];
        if (caching) {
          const grouped = new Map<string, { key: TranscriptCacheKey; backends: SttBackend[] }>();
          for (const backend of tried) {
            const model = options.model ?? backend.model;
            const prompt = effectivePrompt(backend, options.prompt);
            const dedupe = `${model}\u0000${prompt ?? ''}`;
            const existing = grouped.get(dedupe);
            if (existing) {
              existing.backends.push(backend);
              continue;
            }
            grouped.set(dedupe, { key: cacheKeyFor(model, prompt), backends: [backend] });
          }
          cacheKeys.push(...grouped.values());
        }
        const readAnyCached = () => {
          for (const { key, backends } of cacheKeys) {
            const cached = readTranscriptCache(key);
            if (!cached) continue;
            // Skipped only when EVERY backend sharing this key disagrees with
            // the policy it was made under.
            if (backends.every((b) => cachedTranscriptIsSuspect(cached, b, {
              language: options.language,
              translate: Boolean(options.translate),
            }))) continue;
            return cached;
          }
          return null;
        };

        {
          const cached = readAnyCached();
          if (cached) {
            if (!quiet) console.log(chalk.dim('Using cached transcript.'));
            printGroqResult(
              {
                text: cached.text,
                language: cached.language,
                duration: cached.duration,
                model: cached.model,
              },
              options
            );
            return;
          }
        }

        // Only now, on a genuine miss, is the audio worth transferring.
        const resolvedFile = target
          ? await downloadTelegramAudio(target.chatId, target.messageId, quiet)
          : audioFile!;

        // The download is slow; another process may have cached this clip while
        // it ran, so re-check before paying — as the read path does.
        if (cacheKeys.length > 0 && target) {
          const racedIn = readAnyCached();
          if (racedIn) {
            if (!quiet) console.log(chalk.dim('Using cached transcript.'));
            printGroqResult(
              { text: racedIn.text, language: racedIn.language, duration: racedIn.duration, model: racedIn.model },
              options
            );
            return;
          }
        }

        if (!quiet) {
          console.log(chalk.dim(`Transcribing with ${tried[0].label} (${options.model || tried[0].model})...`));
        }

        // A fallback is said out loud: the user should know which backend
        // produced the text, and that the cluster needs looking at.
        const { result, backend } = await transcribeAudio(
          resolvedFile,
          tried,
          {
            language: options.language,
            model: options.model,
            prompt: options.prompt,
            translate: options.translate,
            timestamps: options.timestamps,
          },
          (from, reason, next) => {
            console.error(chalk.yellow(`${from.label} failed (${reason.split('\n')[0]}); trying ${next.label}.`));
          }
        );

        if (cacheKeys.length > 0) {
          if (writeTranscriptCache(cacheKeyFor(result.model, effectivePrompt(backend, options.prompt)), {
            text: result.text,
            language: result.language,
            avgLogprob: result.avgLogprob,
            retriedIn: retryPolicyOf(backend, { language: options.language, translate: Boolean(options.translate) }),
            duration: result.duration,
            model: result.model,
          })) {
            // This path also creates entries, so it also has to sweep old ones.
            pruneTranscriptCache();
          } else {
            console.error(chalk.yellow('Warning: transcript could not be cached; a rerun will bill again.'));
          }
        }

        printGroqResult(result, options, backend.label);
      } catch (error: any) {
        console.error(chalk.red('Error:'), error.message);
        process.exit(1);
      }
    });
}
