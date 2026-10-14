// `bot` commands - send and receive through a Telegram bot.
//
// The point of this transport is attribution: messages an agent sends arrive
// from the bot, not from the owner's own account, so a chat with an agent reads
// as a conversation instead of as notes to self, and it notifies properly.

import { Command } from 'commander';
import { redactSecrets } from '../../services/redact.js';
import chalk from 'chalk';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getConfigDir, getMediaDir } from '../../config/paths.js';
import { canonicalChatId, createTopicOnce, isDefiniteTopicRefusal, topicRecordKey, validateTopicTitle } from '../../services/telegram-topics.js';
import { loadConfig, resolveTelegramBot } from '../../config/loader.js';
import { resolveMessageArg } from '../telegram/stdin.js';
import { enforceFormat, formatHelpSection, FORMAT_OK_FLAG, FORMAT_OK_HELP, PLAIN_HELP } from '../telegram/format-gate.js';
import { HubClient } from '../../services/hub.js';
import { machineFingerprint } from '../../services/hub-fingerprint.js';
import {
  redactBotToken,
  TelegramBotService,
  type BotTransport,
  appendBotLog,
  botLogPath,
  assertStateOwnership,
  claimBotState,
  loadBotOffset,
  readBotLog,
  readSentMessage,
  readSpeakableText,
  recordSentMessage,
  recordWatchHeartbeat,
  sentHere,
  sentViaHub,
  saveBotOffset,
  stashSpeakableText,
  type SpeakableFormat,
  type BotBatch,
  type BotUpdate,
} from '../../services/telegram-bot.js';
import { effectivePrompt, resolveSttBackends, transcribeAudio, type SttBackend } from '../../services/stt.js';
import { cachedTranscriptIsSuspect, retryPolicyOf } from '../transcribe/groq.js';
import { MAX_TTS_CHARACTERS, synthesize, ttsUnavailableReason } from '../../services/tts.js';
import type { ListenOutcome } from '../../services/hub-listen.js';
import { botIdFromToken, localBotWatchRunning } from '../../services/bot-watch-presence.js';
import { toSpokenText } from '../../services/telegram-format.js';
import { readTranscriptCache, writeTranscriptCache } from '../../services/transcript-cache.js';
import { backoffDelay, formatDelay, sleep } from '../../services/backoff.js';
import { isEmojiOnly } from '../../services/emoji.js';
import {
  gateBotCallback,
  gateBotUpdate,
  isChatAuthorized,
  type BotChatAccess,
  type BotMentionIdentity,
} from '../../services/telegram-bot-policy.js';

/** Shown on a message the moment a watcher picks it up. */
const SEEN_EMOJI = '👀';

/**
  * Clips at or under this length are transcribed automatically, as on read.
  *
  * Three minutes, not one: the owner dictates while away from the keyboard and a single thought
  * regularly runs past a minute. At 60s his 97- and 64-second messages were both dropped, and the
  * one that mattered carried three instructions and a question that had to be recovered by hand.
  * Raise this rather than expecting the reader to notice a missing transcript.
  */
const DEFAULT_MAX_DURATION_SECONDS = 180;
const DEFAULT_MAX_TRANSCRIPTS = 3;

/**
 * Resolve the bot to act as. An unknown `--bot` name is fatal and lists what
 * exists: acting as the wrong bot would message the wrong person.
 */
function ensureBotConfig(name?: string) {
  const config = loadConfig();

  if (config.telegramBots.length === 0) {
    console.error(chalk.red('No remote Telegram bot configured.'));
    console.log('\nTo configure one:');
    console.log('  1. Create a bot with @BotFather and copy its token');
    console.log('  2. Add it to the claude-tools secrets file:');
    console.log('       "telegramBots": [{ "name": "assistant", "token": "...", "default": true }]');
    console.log('     or set TELEGRAM_BOT_TOKEN for a single unnamed bot');
    process.exit(1);
  }

  const bot = resolveTelegramBot(name);
  if (!bot) {
    console.error(chalk.red(`Unknown bot "${name}".`));
    console.log('\nConfigured bots:');
    for (const b of config.telegramBots) {
      console.log(`  ${b.name}${b.isDefault ? chalk.dim('  (default)') : ''}`);
    }
    process.exit(1);
  }

  return bot;
}

/**
 * A post into a forum topic goes through the hub, never the local token: the hub holds the routes, and in a
 * routed forum it lets an agent post only into its own topic. The hub judges by the caller's name, so the name
 * is given outright (`--as`) rather than taken from a configured default that may name someone else.
 */
/** The hub, called as the named agent: linking a topic is judged by the caller's name, like a post into one. */
function hubClientAs(as: string | undefined, what: string): HubClient {
  if (as === undefined || as.trim() === '') throw new Error(`${what} goes through the hub, which allows it only to the forum's default agent: pass --as <your agent name>.`);
  const machine = machineFingerprint();
  return new HubClient({ baseUrl: loadConfig().hub.url, agent: as.trim(), fingerprint: machine.fingerprint, anchorRung: machine.anchor.rung });
}

/** A topic id from the command line: digits only, and not General. */
export function parseTopicId(raw: string): number {
  const id = /^\d{1,15}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(id) || id < 2) throw new Error(`a forum topic id is a number above 1, got ${JSON.stringify(raw)}`);
  return id;
}

export function topicTransport(botName: string, topic: string, as: string | undefined): { via: BotTransport; threadId: number } {
  // Digits only: Number() would read "2e1" as 20, and the hub refuses such spellings anyway.
  const threadId = /^\d{1,15}$/.test(topic) ? Number(topic) : NaN;
  if (!Number.isSafeInteger(threadId) || threadId < 1) throw new Error(`--topic must be a forum topic id, got ${JSON.stringify(topic)}`);
  if (as === undefined || as.trim() === '') {
    throw new Error('--topic posts through the hub, which allows each agent only its own topic: pass --as <your agent name>.');
  }
  const machine = machineFingerprint();
  const client = new HubClient({
    baseUrl: loadConfig().hub.url,
    agent: as.trim(),
    fingerprint: machine.fingerprint,
    anchorRung: machine.anchor.rung,
  });
  return { via: (method, body) => client.botCall(botName, method, body), threadId };
}

/**
 * Watch state defaults to the bot's name.
 *
 * Offsets are per bot queue, so two bots sharing one state file would confirm
 * each other's updates and silently eat messages. A shared default was exactly
 * that trap.
 */
/** A group message that is only emoji, with no media and no reply target (see `--emoji`). */
export function isDroppableEmoji(update: { chatType: string; text: string; replyToId?: number; voice?: unknown; attachment?: unknown; file?: unknown }): boolean {
  if (update.chatType === 'private') return false;
  if (update.replyToId !== undefined || update.voice !== undefined || update.attachment !== undefined || update.file !== undefined) return false;
  return isEmojiOnly(update.text);
}

function resolveStateName(explicit: string | undefined, botName: string): string {
  return explicit ?? botName;
}

/**
 * Anyone can message a public bot, and a watcher hands what it receives to an
 * agent as if it were the owner speaking. The allowlist is what stops a stranger
 * from issuing instructions; with none configured the bot is open to everyone.
 *
 * Inbound delivery is decided by `gateBotUpdate`, which also holds the group rules.
 * This is the outbound side of the same question - a chat id on the command line
 * carries neither a type nor a sender, so all that can be asked of it is whether
 * the bot deals with that chat at all.
 */
function assertChatAllowed(config: { name: string } & BotChatAccess, chatId: string): void {
  if (isChatAuthorized(config, chatId)) return;
  throw new Error(
    `Chat ${chatId} is not in the allowlist for bot "${config.name}".\n` +
    'Add it to that bot\'s allowedChats (a DM) or chats (a group) in the secrets file, ' +
    'or use a chat that is listed.'
  );
}

/**
 * Said once per chat, and then never again for it.
 *
 * Only an unlisted chat is worth saying at all: it is how the owner learns that
 * someone found the bot, or that it has been added to a group he has no policy for.
 * A group gets the exact config that would let mentions through, because a bot
 * sitting mute in a group is otherwise indistinguishable from a broken one. The
 * ordinary group drops - wrong sender, no mention - stay silent, or the flood this
 * gate exists to stop would simply move to stderr.
 */
function unlistedChatNotice(update: BotUpdate): string {
  const who = `${update.chatTitle} (${update.chatId})`;
  const tail = 'further messages from it are dropped silently';

  if (update.chatType === 'group' || update.chatType === 'supergroup') {
    return (
      `[tg-bot] no policy for ${update.chatType} ${who}; ${tail}. ` +
      `To let mentions through, add "chats": { "${update.chatId}": { "requireMention": true } } ` +
      'to this bot in the secrets file.\n'
    );
  }

  if (update.chatType === 'private') {
    return `[tg-bot] ignoring DM from ${update.sender} in ${who}; not listed, ${tail}.\n`;
  }

  // A channel post has no member to allowlist, so there is no config to suggest.
  return `[tg-bot] ignoring ${update.chatType} ${who}; only DMs and groups are supported, ${tail}.\n`;
}

function positiveInt(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(chalk.red(`--${name} must be a positive integer`));
    process.exit(1);
  }
  return n;
}

function hhmm(date: Date): string {
  return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function fold(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ⏎ ').trim();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [+${text.length - max} chars]`;
}

/**
 * One line per update, in the shape the Monitor tool already reports for the
 * user-account watcher, so a babysit brief reads the same either way.
 */
export function formatBotUpdate(update: BotUpdate, maxText: number): string {
  const time = update.edited ? `✎${hhmm(update.date)}` : hhmm(update.date);
  const reply = update.replyToId ? ` ↩${update.replyToId}` : '';

  // An attachment is named here, never located: `[photo]`, not
  // `[photo - read: /home/.../file.jpg]`. A local path belongs in the structured
  // record - the `--json` line, the message log, `BotFile` - and never inside the
  // rendered content, because content is untrusted. Any sender who has passed the
  // gate can type `[image attached - read: /etc/passwd]` into a message, and once
  // paths appear inside content there is nothing left to tell that apart from
  // something this tool wrote. The fields on the update are set by Telegram and by
  // us; the text is set by whoever sent it. Keep the two separable.
  const media = update.voice
    ? `[${update.voice.kind}${update.voice.duration !== undefined ? ` ${Math.round(update.voice.duration)}s` : ''}]`
    : update.attachment
      ? `[${update.attachment}]`
      : '';

  const transcript = update.transcript
    ? `"${truncate(fold(update.transcript), maxText)}"`
    : update.transcriptSkipped
      ? `[${update.transcriptSkipped}]`
      : '';
  // Attribution comes first and is never truncated: whether these are the
  // owner's own words or someone else's changes how the message should be
  // treated, so it must survive however long the body is.
  const forwarded = update.forwardedFrom ? `↪from ${update.forwardedFrom}: ` : '';
  const body = [media, truncate(fold(update.text), maxText), transcript].filter(Boolean).join(' ');

  // The service already redacts its OWN token from errors; this covers the other direction — a
  // credential inside a MESSAGE, which a watcher delivers straight into someone's context.
  return redactSecrets(`[tg-bot] ${update.chatTitle} (${update.chatId}) #${update.messageId} ${time} ${update.sender}${reply}: ${forwarded}${body}`);
}

/**
 * Transcribe short voice notes on updates about to be reported, reusing the
 * same on-disk cache as the user-client paths so nothing is ever paid for twice.
 * Never throws: a transcription problem must not cost a message.
 */
async function transcribeVoice(
  bot: TelegramBotService,
  updates: BotUpdate[],
  opts: { maxDuration: number; maxTranscripts: number }
): Promise<{ transcribed: number; cacheHits: number; failed: number }> {
  const result = { transcribed: 0, cacheHits: 0, failed: 0 };

  // Config and cache access are inside the guard too: this function promises not
  // to throw, and a throw here would kill the watcher before a batch is logged.
  let stt: SttBackend[];
  try {
    stt = resolveSttBackends(loadConfig());
  } catch {
    return result;
  }
  if (stt.length === 0) return result;

  let budget = opts.maxTranscripts;
  let workDir: string | null = null;

  try {
    for (const update of updates) {
      if (!update.voice || update.voice.duration === undefined) continue;
      if (update.voice.duration > opts.maxDuration) {
        // Say so rather than skipping in silence: an unexplained missing transcript reads as a
        // failure, and the reader has no way to know a cap exists or how to raise it.
        update.transcriptSkipped =
          `not transcribed: ${Math.round(update.voice.duration)}s over the ${opts.maxDuration}s cap — raise --transcribe-max`;
        continue;
      }

      // The file id is stable per file, so it is the natural cache identity here;
      // the bot has no message ids that survive a re-send. One key per backend
      // model: a hit under any serves, a miss is filed under the one that answered.
      // The prompt belongs in the key: a transcript decoded with a configured
      // glossary is a different answer from one decoded without it.
      const keyFor = (model: string, prompt?: string) =>
        ({ source: 'tg-bot', id: update.voice!.fileId, model, translate: false, prompt });

      try {
        const cached = stt
          .map((b) => {
            const hit = readTranscriptCache(keyFor(b.model, effectivePrompt(b)));
            // Skipped when the retry policy would now redo it: see
            // `cachedTranscriptIsSuspect`.
            return hit && !cachedTranscriptIsSuspect(hit, b) ? hit : undefined;
          })
          .find(Boolean);
        if (cached) {
          update.transcript = cached.text || undefined;
          result.cacheHits++;
          continue;
        }

        if (budget <= 0) continue;

        workDir ??= mkdtempSync(`${tmpdir()}/claude-tools-bot-`);
        const file = await bot.downloadFile(update.voice.fileId, workDir);
        const { result: transcript, backend: answered } = await transcribeAudio(file, stt, {
          // Checked non-undefined by the duration gate above; it bounds the request.
          audioSeconds: update.voice.duration,
        });

        update.transcript = transcript.text || undefined;
        writeTranscriptCache(keyFor(transcript.model, effectivePrompt(answered)), {
          text: transcript.text,
          language: transcript.language,
          avgLogprob: transcript.avgLogprob,
          retriedIn: retryPolicyOf(answered),
          duration: transcript.duration,
          model: transcript.model,
        });
        result.transcribed++;
        budget--;
      } catch {
        result.failed++;
        budget--;
      }
    }
  } finally {
    // A long-running watcher would otherwise accumulate every clip it ever
    // downloaded.
    if (workDir) {
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {
        // Temp cleanup is best effort.
      }
    }
  }

  return result;
}

/** Reduce a stashed message to what should be said, honouring how it was sent. */
function speakableFrom(stashed: { text: string; format: SpeakableFormat }): string {
  if (stashed.format === 'plain') return stashed.text.trim();
  if (stashed.format === 'html') {
    return stashed.text
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
      .trim();
  }
  return toSpokenText(stashed.text);
}

/**
 * Serialises speech jobs off the poll loop.
 *
 * Awaiting synthesis inside the loop stalled everything behind it: ten presses
 * at ~15s each delayed ordinary message handling by minutes, and later callbacks
 * expired before they were answered. Jobs run one at a time (two Kokoro
 * processes are slower than one), the queue is bounded, and a repeat press for a
 * message already queued is dropped rather than synthesised twice.
 */
export class SpeechQueue {
  private running = false;
  private readonly queued = new Map<string, () => Promise<void>>();

  constructor(
    private readonly limit: number,
    private readonly onError: (message: string) => void
  ) {}

  /** Returns false when the queue is full, so the caller can say so. */
  submit(key: string, job: () => Promise<void>): boolean {
    if (this.queued.has(key)) return true;
    if (this.queued.size >= this.limit) return false;

    this.queued.set(key, job);
    void this.drain();
    return true;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      while (this.queued.size > 0) {
        const [key, job] = this.queued.entries().next().value as [string, () => Promise<void>];
        try {
          await job();
        } catch (err) {
          this.onError((err as Error).message);
        } finally {
          this.queued.delete(key);
        }
      }
    } finally {
      this.running = false;
    }
  }
}

/**
 * Whether anything will answer a Listen press on this message. Through the hub (a forum topic) the hub routes it
 * back to the sender's `hub watch`; with the local token only a running `bot watch` for this bot can. A button
 * nothing can answer is worse than none: on 2026-10-08 every press on a day of such buttons did nothing, and the
 * person pressing cannot tell that from their own mistake. When the process table cannot be read here, the old
 * behaviour (attach) is kept.
 */
function pressAnswerable(bot: { name: string; token: string }, viaHub: boolean): boolean {
  if (viaHub) return true;
  const botName = bot.name;
  const bots = loadConfig().telegramBots;
  const defaultBot = (bots.find((b) => b.isDefault) ?? bots[0])?.name;
  const running = localBotWatchRunning(botName, defaultBot, undefined, botIdFromToken(bot.token));
  // Attach only when an answerer is PROVEN live. Unknown is not proof: a missing button is an inconvenience the
  // reader can see, a dead one is a silent failure they cannot tell from their own mistake (2026-10-08).
  if (running !== true) {
    process.stderr.write(
      `[tg-bot] no Listen button: ${running === null ? 'this machine cannot see its running processes' : `no bot watch for "${botName}" here is proven to be receiving`}`
      + ', and the message does not go through the hub, so nothing is known to answer a press (in a forum topic, pass --topic to send, reply or edit)\n'
    );
  }
  return running === true;
}

/**
 * Build the Listen button, or nothing when this machine cannot speak.
 *
 * Speech needs a Python ML stack and ffmpeg, which many machines do not have.
 * Offering a button that fails on press would be worse than leaving it off, so
 * the message still goes out and the reason is reported once on stderr.
 */
function speakButton(
  wanted: boolean | undefined,
  state: string,
  text: string,
  format: SpeakableFormat
): { text: string; callbackData: string }[] | undefined {
  // Commander maps `--no-tts` to `tts: false`; anything else means attach it.
  // On by default because the person driving this is usually listening, and a
  // message he cannot play is more annoying than a button he ignores.
  if (wanted === false) return undefined;

  const reason = ttsUnavailableReason();
  if (reason) {
    process.stderr.write(`[tg-bot] no Listen button: ${reason}\n`);
    return undefined;
  }

  // Check the length synthesis will actually see: a message can fit Telegram's
  // limit and still be refused, leaving a button that can never work.
  const spoken = speakableFrom({ text, format });
  if (!spoken || spoken.length > MAX_TTS_CHARACTERS) {
    process.stderr.write(
      `[tg-bot] no Listen button: ${spoken ? `${spoken.length} characters exceeds the ${MAX_TTS_CHARACTERS} limit` : 'nothing to read aloud'}\n`
    );
    return undefined;
  }

  return [{ text: '🔊 Listen', callbackData: `speak:${stashSpeakableText(state, text, format)}` }];
}

/**
 * How a Listen press ended: spoken; failed in a way another press could fix (synthesis, upload); or failed for good
 * (the text is no longer stashed here, or is only formatting), when putting the button back would only repeat it.
 */
export type { ListenOutcome };

/**
 * Speak a message back when its Listen button is pressed.
 *
 * The watcher does this itself rather than handing it to the agent: the agent
 * may be mid-task, and a button that only works when someone is paying
 * attention is worse than no button. Never throws - a failed synthesis reports
 * itself in the chat and the watch loop carries on.
 */
async function handleSpeakCallback(
  service: TelegramBotService,
  state: string,
  botName: string,
  callback: ListenPress
): Promise<ListenOutcome> {
  // In a forum topic every answer names the topic: Telegram would otherwise post it in General, and the hub
  // refuses a post outside the agent's own topic.
  const thread = callback.threadId === undefined ? {} : { threadId: callback.threadId };
  const key = callback.data.slice('speak:'.length);

  // Prefer the message id: it is unambiguous and does not depend on the watch
  // state matching whatever the sender used. The hash stash stays as a fallback
  // so buttons created before this still work.
  const stashed =
    readSentMessage(botName, callback.chatId, callback.messageId) ??
    readSpeakableText(state, key) ??
    // Older buttons were stashed under whatever --state the sender used, which
    // defaulted to the bot name. Messages sent without --state therefore landed
    // somewhere the watcher never looked.
    readSpeakableText(botName, key);

  // `permanent` only once the reason has reached the presser: if it could not be sent, the press is `retryable`, so
  // the button comes back rather than leaving them with neither audio nor an answer (Codex review).
  const explain = async (text: string): Promise<ListenOutcome> =>
    service.sendMessage(callback.chatId, text, { replyToId: callback.messageId, ...thread }).then(
      () => 'permanent' as const,
      () => 'retryable' as const,
    );

  if (!stashed) return explain('That message is no longer available to read aloud.');

  // Normalise the way it was sent. Running markdown stripping over a message
  // sent with --plain would delete text the reader can see, and an --html body
  // would otherwise have its tags read aloud.
  const spoken = speakableFrom(stashed);
  if (!spoken) return explain('That message is only formatting — there is nothing to read aloud.');

  let result;
  try {
    await service.sendTyping(callback.chatId, callback.threadId).catch(() => {});
    result = await synthesize(spoken);
  } catch (error: any) {
    process.stdout.write(`[tg-bot] ERROR speech failed on #${callback.messageId}: ${error.message}\n`);
    await service
      .sendMessage(callback.chatId, `Could not read that aloud: ${error.message}`, { replyToId: callback.messageId, ...thread })
      .catch(() => {});
    return 'retryable';
  }

  try {
    await service.sendVoice(callback.chatId, result.oggPath, { replyToId: callback.messageId, ...thread });
    return 'spoken';
  } catch (error: any) {
    process.stdout.write(`[tg-bot] ERROR sending speech failed on #${callback.messageId}: ${error.message}\n`);
    return 'retryable';
  } finally {
    rmSync(result.workDir, { recursive: true, force: true });
  }
}

/** One Listen press, as either watcher receives it: `threadId` is set when the message is in a forum topic. */
export interface ListenPress {
  queryId: string;
  chatId: string;
  messageId: number;
  data: string;
  sender: string;
  threadId?: number;
}

/** The button a press removes, rebuilt from the press: put back when the watcher stops before speaking it. */
export function listenButtonFor(press: Pick<ListenPress, 'data'>): { text: string; callbackData: string }[] {
  return [{ text: '🔊 Listen', callbackData: press.data }];
}

/**
 * Take one Listen press: answer it, remove the button, and queue the speech. Shared by `bot watch`, which reads
 * the bot itself, and `hub watch`, which receives a press on a message it sent through the hub (a forum topic).
 * `onSettled` runs once the press is finished with, saying how it ended (a full queue is `retryable`; its button
 * is already back).
 */
export async function acceptListenPress(
  service: TelegramBotService,
  speech: SpeechQueue,
  state: string,
  botName: string,
  callback: ListenPress,
  onSettled: (outcome: ListenOutcome) => void = () => {},
  /** Replies sent without being awaited are handed here, so a caller with an exit deadline can bound them. */
  track: (request: Promise<unknown>) => void = () => {}
): Promise<void> {
  // stderr, not stdout: speech is handled entirely inside this watcher,
  // so a successful press needs no agent involvement. On stdout it
  // would become a notification and cost context for work nobody has
  // to do. Failures below go to stdout precisely because those DO need
  // an agent - a dead Listen button is something the owner must hear
  // about from someone.
  process.stderr.write(
    `[tg-bot] ${callback.sender} pressed Listen on #${callback.messageId} (${callback.chatId})\n`
  );

  // Answer here, immediately. Telegram spins the button for only a few
  // seconds, and synthesis takes far longer than that. Not awaited: the only
  // step a later restore of this button must wait for is the removal below.
  track(service.answerCallback(callback.queryId, 'Reading it aloud…').catch(() => {}));

  // Take the button away at once. Deduping a second press works, but
  // removing the button means there is no second press to dedupe, and
  // the message visibly stops inviting one.
  //
  // A failure here is reported rather than swallowed: silently leaving
  // the button in place looks identical to removing it from this side,
  // and the dedupe is then the only thing preventing a double run.
  await service.clearButtons(callback.chatId, callback.messageId).catch((err: Error) => {
    process.stderr.write(`[tg-bot] could not remove the Listen button on #${callback.messageId}: ${err.message}\n`);
  });

  // Keyed by bot too: two bots can each have a message with the same id in the same chat (Codex review).
  const accepted = speech.submit(`${botName}:${callback.chatId}:${callback.messageId}`, async () => {
    let outcome: ListenOutcome = 'retryable';
    try {
      outcome = await handleSpeakCallback(service, state, botName, callback);
      if (outcome === 'spoken') process.stderr.write(`[tg-bot] spoke #${callback.messageId}\n`);
    } finally {
      onSettled(outcome);
    }
  });

  if (!accepted) {
    // The button was already removed above; without it back, "try again" could not be done (Codex review). Once it
    // is back the press is `restored`; if putting it back failed, the caller must keep the press and retry.
    const restored = await service.setButtons(callback.chatId, callback.messageId, listenButtonFor(callback)).then(
      () => true,
      (err: Error) => {
        process.stderr.write(`[tg-bot] could not put the Listen button back on #${callback.messageId}: ${err.message}\n`);
        return false;
      },
    );
    onSettled(restored ? 'restored' : 'retryable');
    // Not awaited: a restore of this button waits for this function, and an explanation stuck in a retry window must
    // not hold it past a watcher's exit deadline (Codex review).
    track(service
      .sendMessage(callback.chatId, 'Too many messages queued to read aloud — try again shortly.', {
        replyToId: callback.messageId,
        ...(callback.threadId === undefined ? {} : { threadId: callback.threadId }),
      })
      .catch(() => {}));
  }
}

export function registerBotCommands(program: Command): void {
  const bot = program.command('bot').description('Send and receive through a Telegram bot');

  bot
    .command('list')
    .description('List configured remote bots (names only, never tokens)')
    .action(() => {
      const config = loadConfig();
      if (config.telegramBots.length === 0) {
        console.log(chalk.dim('No remote bots configured.'));
        return;
      }

      const pinned = process.env.TELEGRAM_BOT;
      console.log(chalk.bold('\nRemote bots'));
      for (const b of config.telegramBots) {
        const marks = [
          b.isDefault ? 'default' : null,
          pinned && b.name.toLowerCase() === pinned.trim().toLowerCase() ? 'pinned by TELEGRAM_BOT' : null,
        ].filter(Boolean);
        const scope = b.allowedChats.length
          ? `chats: ${b.allowedChats.join(', ')}`
          : chalk.yellow('open to any chat');
        // A group is reached through its own policy entry rather than the flat list,
        // so a bot configured only for groups would otherwise read as "open".
        const policies = Object.keys(b.chats).length;
        const extra = policies ? `, ${policies} chat polic${policies === 1 ? 'y' : 'ies'}` : '';
        console.log(`  ${b.name}${marks.length ? chalk.dim(`  (${marks.join(', ')})`) : ''}  ${chalk.dim(scope + extra)}`);
      }
      console.log(chalk.dim('\nSelect one with --bot <name>, or pin a session with TELEGRAM_BOT=<name>.'));
    });

  bot
    .command('info')
    .description('Show the bot identity and local state')
    .option('--bot <name>', 'Which configured bot to use')
    .option('--state <name>', 'State namespace (default: the bot name)')
    .action(async (options: { bot?: string; state?: string }) => {
      try {
        const config = ensureBotConfig(options.bot);
        const service = new TelegramBotService(config.token);
        const state = resolveStateName(options.state, config.name);
        const me = await service.getMe();
        const owner = { name: config.name, id: me.id };

        console.log(chalk.bold('\nBot'), chalk.dim(`(${config.name}${config.isDefault ? ', default' : ''})`));
        console.log(`  ${me.firstName}${me.username ? ` (@${me.username})` : ''}  id ${me.id}`);

        let offset: number | null;
        try {
          offset = loadBotOffset(state, owner, { adopt: true });
        } catch (error: any) {
          console.error(chalk.red('Error:'), error.message);
          process.exit(1);
        }
        console.log(chalk.bold('\nState'), chalk.dim(`(${state})`));
        console.log(`  confirmed offset: ${offset ?? '(none yet)'}`);
        console.log(`  log: ${botLogPath(state)}`);

        const seen = readBotLog(state, 1000);
        const chats = new Map(seen.map((u) => [u.chatId, u.chatTitle]));
        if (chats.size) {
          console.log(chalk.bold('\nChats seen'));
          for (const [id, title] of chats) console.log(`  ${id}  ${title}`);
        } else {
          console.log(chalk.dim('\nNo messages received yet. Send the bot a message first.'));
        }

        // A group's `allowFrom` is written in user ids, and nothing else in this tool
        // shows one: the watch line carries a display name, which is not an identity.
        // Without this, the only way to fill in a sender list is to guess.
        const senders = new Map<string, string>();
        for (const update of seen) {
          if (!update.senderId) continue;
          senders.set(`${update.chatId}:${update.senderId}`, `  ${update.senderId}  ${update.sender}  ${chalk.dim(update.chatTitle)}`);
        }
        if (senders.size) {
          console.log(chalk.bold('\nSenders seen'), chalk.dim('(ids for a chat\'s allowFrom)'));
          for (const line of [...senders.values()].slice(-20)) console.log(line);
        }
      } catch (error: any) {
        console.error(chalk.red('Error:'), error.message);
        process.exit(1);
      }
    });

  bot
    .command('watch')
    .description('Long-poll the bot and print one line per message (for the Claude Code Monitor tool)')
    .option('--bot <name>', 'Which configured bot to use')
    .option('--state <name>', 'State namespace; defaults to the bot name')
    .option('--timeout <sec>', 'Long-poll timeout per request', '25')
    .option('--max-text <n>', 'Truncate text to this many characters', '400')
    .option('--reset', 'Discard any pending backlog and start from now')
    .option('--adopt-state', 'Claim a state namespace that records no owner')
    .option('--no-transcribe', 'Do not transcribe short voice messages')
    .option('--transcribe-max <sec>', 'Longest voice message to transcribe', String(DEFAULT_MAX_DURATION_SECONDS))
    .option('--transcribe-limit <n>', 'Most voice messages to transcribe per batch', '3')
    .option('--no-typing', 'Do not show "typing…" when a message arrives')
    .option('--no-seen', 'Do not react with 👀 when a message arrives')
    .option('--no-echo', 'Do not reply to a voice note with its transcript')
    .option('--emoji', 'Also deliver messages that are only emoji in group chats (dropped by default unless they reply to something)')
    .option('--json', 'Print one JSON object per line')
    .action(async (options: {
      bot?: string; state?: string; timeout: string; maxText: string; reset?: boolean; adoptState?: boolean;
      transcribe: boolean; transcribeMax: string; transcribeLimit: string;
      typing: boolean; seen: boolean; echo: boolean; json?: boolean; emoji?: boolean;
    }) => {
      const config = ensureBotConfig(options.bot);
      const service = new TelegramBotService(config.token);
      const state = resolveStateName(options.state, config.name);
      const timeoutSec = positiveInt(options.timeout, 'timeout');
      const maxText = positiveInt(options.maxText, 'max-text');
      const maxDuration = positiveInt(options.transcribeMax, 'transcribe-max');
      const maxTranscripts = positiveInt(options.transcribeLimit, 'transcribe-limit');

      // Identity comes first: the state guard compares real bot ids, and the
      // namespace is claimed before any poll so two bots cannot both start on it.
      const speech = new SpeechQueue(5, (message) =>
        process.stderr.write(`[tg-bot] speech job failed: ${message}\n`));

      let owner: { name: string; id?: number };
      // Who the bot is, for the mention gate: a group message counts as addressed
      // to it when it names this handle, mentions this id, or replies to it.
      let identity: BotMentionIdentity = {};
      let offset: number | undefined;
      try {
        const me = await service.getMe();
        owner = { name: config.name, id: me.id };
        identity = { id: me.id, username: me.username };

        claimBotState(state, owner, { adopt: options.adoptState });
        offset = loadBotOffset(state, owner, { adopt: options.adoptState }) ?? undefined;

        process.stdout.write(
          `[tg-bot] watching @${me.username ?? me.id} as "${config.name}" (state ${state}) after offset ${offset ?? '(new)'}\n`
        );
      } catch (error: any) {
        process.stdout.write(`[tg-bot] ERROR ${error.message}\n`);
        process.exit(1);
      }

      if (options.reset) {
        // Drain to the end of the queue. One page is at most 100 updates, so
        // stopping there would report the rest as new on the next poll.
        //
        // The drain is bounded: without a cutoff, a chat that keeps receiving
        // messages would keep every page non-empty, and reset would discard live
        // traffic forever instead of finishing. Bounding it means a very large
        // backlog may leave a tail to be reported normally, which is the safe
        // way to be wrong.
        const RESET_MAX_PAGES = 50;
        try {
          let skipped = 0;
          let pages = 0;
          for (; pages < RESET_MAX_PAGES; pages++) {
            const batch = await service.getUpdates({ offset, timeoutSec: 0 });
            if (batch.cursor === null) break;

            skipped += batch.received;
            offset = batch.cursor + 1;
            saveBotOffset(state, offset, owner);
          }
          process.stdout.write(`[tg-bot] reset; skipped ${skipped} pending update(s)\n`);
          if (pages >= RESET_MAX_PAGES) {
            process.stdout.write(
              `[tg-bot] reset stopped after ${RESET_MAX_PAGES} pages; anything still queued will be reported normally\n`
            );
          }
        } catch (error: any) {
          process.stdout.write(`[tg-bot] ERROR during reset: ${error.message}\n`);
          process.exit(1);
        }
      }

      let failures = 0;
      let errorReported = false;
      let logErrorReported = false;
      // Chats already reported as unlisted. Without this, a group the bot has been
      // added to but has no policy for would print a line per batch, all day.
      const announced = new Set<string>();

      // Long polling means no sleep loop: each request parks on the server until
      // a message arrives or the timeout expires.
      for (;;) {
        let batch: BotBatch;
        try {
          // A poll under way can receive a press, even right after a failure: say so before parking in it, or a
          // recovered watcher on a quiet bot reads as failed for a whole --timeout (Codex review). A revoked token
          // fails at once and writes `false` in the catch below.
          if (failures > 0) recordWatchHeartbeat(state, owner.id, timeoutSec * 1000 + 60_000, 'polling');
          batch = await service.getUpdates({ offset, timeoutSec });
          // Fresh for one whole long poll plus a minute, so a quiet bot polled with a long --timeout is not stale.
          recordWatchHeartbeat(state, owner.id, timeoutSec * 1000 + 60_000);
          if (errorReported) {
            process.stdout.write('[tg-bot] recovered\n');
            errorReported = false;
          }
          failures = 0;
        } catch (error: any) {
          failures++;
          // Not receiving: withdraw the heartbeat now, so senders stop attaching buttons only this watcher could
          // answer (Codex review).
          recordWatchHeartbeat(state, owner.id, timeoutSec * 1000 + 60_000, false);
          process.stderr.write(`[tg-bot] poll failed (${failures}): ${error.message}\n`);
          if (failures >= 3 && !errorReported) {
            process.stdout.write(`[tg-bot] ERROR ${error.message} (retrying)\n`);
            errorReported = true;
          }
          // Back off, but stay alive: the watcher is meant to outlive an outage,
          // not just a blip. Linear steps capped at a minute meant a fifteen
          // minute drop cost fifteen wasted round trips; exponential with a
          // five minute ceiling rides it out in a handful.
          const delayMs = backoffDelay(failures);
          if (failures === 3) {
            process.stderr.write(`[tg-bot] backing off, next attempt in ${formatDelay(delayMs)}\n`);
          }
          await sleep(delayMs);
          continue;
        }

        // Nothing arrived at all: the long poll simply timed out.
        if (batch.cursor === null) continue;

        // Button presses are handled here and never reported as messages: they
        // are the watcher's own work, not something the agent has to see.
        for (const callback of batch.callbacks) {
          if (!gateBotCallback(config, callback).deliver) continue;
          if (!callback.data.startsWith('speak:')) continue;

          await acceptListenPress(service, speech, state, config.name, callback);
        }

        // Gate before anything else looks at the content: a message that is not for
        // this agent must never reach it, the log, the transcriber, or the reaction
        // - a 👀 on a stranger's message tells him the bot is live and listening.
        const decisions = batch.messages.map((update) => ({
          update,
          gate: gateBotUpdate(config, identity, update),
        }));
        // Emoji-only messages in a GROUP wake the agent for nothing (Davron #1470), so they are dropped unless they
        // reply to something: a 👍 answering a question is an answer. A private chat with the bot keeps
        // everything, since every message there is addressed to the agent.
        const updates = decisions
          .filter((d) => d.gate.deliver)
          .map((d) => d.update)
          .filter((u) => options.emoji === true || !isDroppableEmoji(u));

        for (const { update, gate } of decisions) {
          if (gate.deliver) continue;
          if (gate.reason !== 'unlisted' && gate.reason !== 'chat-type') continue;
          if (announced.has(update.chatId)) continue;
          announced.add(update.chatId);
          process.stderr.write(unlistedChatNotice(update));
        }

        // A batch of only ignored update types still has to move the cursor, or
        // the next poll refetches it immediately and spins.
        // Nothing left to report (e.g. the batch was only button presses).
        if (updates.length === 0) {
          offset = batch.cursor + 1;
          saveBotOffset(state, offset, owner);
          continue;
        }

        for (const update of updates) assertChatAllowed(config, update.chatId);

        // Mark the message seen before anything slow happens, so the reaction
        // is the signal that it was picked up rather than that work finished.
        if (options.seen !== false) {
          for (const update of updates) {
            await service.setReaction(update.chatId, update.messageId, SEEN_EMOJI).catch(() => {
              // Reactions are unavailable in some chats; never cost a message.
            });
          }
        }

        // Show "typing…" straight away, before transcription and logging, so a
        // voice note that takes a few seconds to process does not look ignored.
        if (options.typing !== false) {
          for (const chatId of new Set(updates.map((u) => u.chatId))) {
            try {
              await service.sendTyping(chatId);
            } catch {
              // A courtesy indicator must never cost a message.
            }
          }
        }

        if (options.transcribe !== false) {
          await transcribeVoice(service, updates, { maxDuration, maxTranscripts });

          // Echo each transcript back as a reply to the voice note it came from.
          //
          // The owner drives this chat by voice and cannot otherwise see how he
          // was heard: a mis-transcription only surfaces later, as an agent
          // acting on the wrong instruction. "inbox agent" for "inter-agent"
          // cost a round trip and nearly cost a wrongly-scoped roadmap.
          //
          // It belongs here rather than in the agent for the same reason the
          // reaction does: this runs on receipt, so the echo arrives whether or
          // not an agent is awake, busy, or about to misread it.
          if (options.echo !== false) {
            for (const update of updates) {
              if (!update.transcript?.trim()) continue;
              await service
                .sendMessage(update.chatId, `🎙 ${update.transcript.trim()}`, {
                  // NOT a reply, deliberately. Telegram treats a reply to your
                  // own message as a mention, and a mention pushes through a
                  // silent send - so threading it was the thing generating the
                  // notifications the owner did not want. In a one-to-one chat
                  // the transcript lands directly under the audio anyway, so
                  // the thread bought nothing and cost a ping per voice note.
                  //
                  // `silent` is still set, but note what it actually means:
                  // disable_notification is "notify without sound", not "do not
                  // notify". Dropping the mention is what removes the push.
                  silent: true,
                  format: 'plain',
                })
                .catch((err: Error) => {
                  // A courtesy echo must never cost the message itself - but a
                  // silently swallowed failure is indistinguishable from a
                  // working feature, which is the whole class of bug this echo
                  // exists to expose. Report and carry on.
                  process.stdout.write(
                    `[tg-bot] ERROR could not echo the transcript of #${update.messageId}: ${err.message}\n`
                  );
                });
            }
          }
        }

        // The log is written BEFORE the offset is confirmed, and a failure here
        // must NOT confirm: Telegram forgets an update as soon as the offset
        // passes it, so advancing over a batch we could not record would destroy
        // it. Leaving the offset alone means the batch is retried instead.
        try {
          appendBotLog(state, updates);
          logErrorReported = false;
        } catch (error: any) {
          if (!logErrorReported) {
            process.stdout.write(
              `[tg-bot] ERROR cannot write the message log: ${error.message}\n` +
              '[tg-bot] holding the queue - messages are NOT confirmed until this is fixed\n'
            );
            logErrorReported = true;
          }
          // Back off so a full or read-only disk does not become a hot loop.
          await new Promise((resolve) => setTimeout(resolve, 30_000));
          continue;
        }

        const lines = updates.map((u) =>
          options.json
            ? JSON.stringify({ ...u, date: u.date.toISOString() })
            : formatBotUpdate(u, maxText)
        );
        process.stdout.write(`${lines.join('\n')}\n`);

        offset = batch.cursor + 1;
        saveBotOffset(state, offset, owner);
      }
    });

  bot
    .command('send <chat> [message]')
    .description('Send a message as the bot ("-" reads the body from stdin)')
    .option('--bot <name>', 'Which configured bot to send as')
    .option('--mute, --silent', 'Deliver without a notification')
    .option('--plain', PLAIN_HELP)
    .option('--html', 'The body is already Telegram HTML')
    .option('--no-tts', 'Do not attach the Listen button')
    .option('--auto', 'Use the old HTML conversion instead of a server-parsed rich message')
    .option('--state <name>', 'State the button text is stashed under (default: the bot name)')
    .option('--topic <id>', 'Post into this forum topic, through the hub (needs --as)')
    .option('--as <name>', 'Your agent name, which the hub checks against the topic')
    .option(FORMAT_OK_FLAG, FORMAT_OK_HELP)
    .addHelpText('after', formatHelpSection())
    .action(async (chat: string, message: string | undefined, options: { bot?: string; silent?: boolean; plain?: boolean; html?: boolean; auto?: boolean; tts?: boolean; state?: string; topic?: string; as?: string; formatOk?: string }) => {
      try {
        // The body and its format first: a refused message exits 3 whatever the bot or topic config says.
        const text = await resolveMessageArg(message ?? '-');
        if (!text.trim()) throw new Error('Nothing to send: the message body is empty.');
        const note = enforceFormat(text, options.formatOk, options.plain === true, options.html === true, true);

        const config = ensureBotConfig(options.bot);
        const topic = options.topic === undefined ? undefined : topicTransport(config.name, options.topic, options.as);
        const service = new TelegramBotService(config.token, topic?.via);

        assertChatAllowed(config, chat);
        // Rich is the default: server-parsed markdown, real tables and headings,
        // and 32768 characters. It falls back to the ordinary path on failure,
        // so nothing is lost if a message is not valid markdown.
        const sendFormat = options.plain ? 'plain' : options.html ? 'html' : options.auto ? 'auto' : 'rich';
        const id = await service.sendMessage(chat, text, {
          silent: options.silent,
          format: sendFormat,
          // In a topic the press goes to the hub, which hands it to this agent's `hub watch` to answer.
          buttons: options.tts === false || !pressAnswerable(config, topic !== undefined)
            ? undefined
            : speakButton(options.tts, resolveStateName(options.state, config.name), text, sendFormat),
          ...(topic ? { threadId: topic.threadId } : {}),
        });
        recordSentMessage(config.name, chat, id, text, sendFormat, topic !== undefined);
        console.log(chalk.green(`✅ Sent [bot chat:${chat}${topic ? ` topic:${topic.threadId}` : ''}] #${id}${note}`));
      } catch (error: any) {
        console.error(chalk.red('Error:'), error.message);
        process.exit(1);
      }
    });

  bot
    .command('document <chat> <file>')
    .description('Send a file as a document (a PDF, a log, an export), under its own name')
    .option('--bot <name>', 'Which configured bot to send as')
    .option('--caption <text>', 'A caption shown under the file')
    .option('--reply <messageId>', 'Send it as a reply to this message')
    .option('--mute, --silent', 'Deliver without a notification')
    .action(async (chat: string, file: string, options: { bot?: string; caption?: string; reply?: string; silent?: boolean }) => {
      try {
        const config = ensureBotConfig(options.bot);
        if (!existsSync(file)) throw new Error(redactBotToken(`No such file: ${file}`, config.token));
        assertChatAllowed(config, chat);
        const replyToId = options.reply === undefined ? undefined : Number(options.reply);
        if (replyToId !== undefined && (!Number.isInteger(replyToId) || replyToId <= 0)) {
          throw new Error(`--reply must be a message id, got ${JSON.stringify(options.reply)}`);
        }
        const service = new TelegramBotService(config.token);
        const id = await service.sendDocument(chat, file, {
          ...(options.caption ? { caption: options.caption } : {}),
          ...(replyToId ? { replyToId } : {}),
          ...(options.silent ? { silent: true } : {}),
        });
        console.log(chalk.green(`✅ Sent [bot chat:${chat}] #${id}`), chalk.dim(redactBotToken(file, config.token)));
      } catch (error: any) {
        console.error(chalk.red('Error:'), error.message);
        process.exit(1);
      }
    });

  const topic = bot.command('topic').description('Forum topics in a group the bot administers');
  topic
    .command('create <chat> <title>')
    .description('Create a forum topic and print its id (the bot needs the right to manage topics). '
      + 'A title this machine already created in that chat returns the existing id instead of a second topic.')
    .option('--bot <name>', 'Which configured bot creates it')
    .option('--json', 'Print {"id":…,"title":…,"reused":…}')
    .option('--retry', 'Create it even though an earlier attempt got no clear answer (check the group first)')
    .option('--record <id>', 'Record an existing topic id for this title instead of creating one')
    .option('--agent <name>', 'Also link the topic to this agent on the hub, so it is connected at once (needs --as)')
    .option('--as <name>', 'Your agent name; the hub lets only the forum\'s default agent link a topic')
    .action(async (chat: string, rawTitle: string, options: { bot?: string; json?: boolean; retry?: boolean; record?: string; agent?: string; as?: string }) => {
      try {
        const config = ensureBotConfig(options.bot);
        assertChatAllowed(config, chat);
        const title = validateTopicTitle(rawTitle);
        const chatId = canonicalChatId(chat);
        // Before the topic exists: a link that cannot be asked for must not leave a topic nobody is connected to.
        if (options.agent !== undefined && !/^[a-z0-9-]{1,40}$/.test(options.agent)) throw new Error(`--agent must be an agent name (a-z, 0-9, "-"), got ${JSON.stringify(options.agent)}`);
        // The hub names bots in its own alphabet; a configured name outside it could never be linked.
        if (options.agent !== undefined && !/^[a-z0-9-]{1,32}$/.test(config.name)) throw new Error(`--agent links through the hub, which cannot name the bot ${JSON.stringify(config.name)} (a-z, 0-9, "-")`);
        const hub = options.agent === undefined ? undefined : hubClientAs(options.as, '--agent');
        let record: number | undefined;
        if (options.record !== undefined) {
          record = /^\d{1,15}$/.test(options.record) ? Number(options.record) : NaN;
          if (!Number.isSafeInteger(record) || record <= 0) throw new Error(`--record must be a topic id, got ${JSON.stringify(options.record)}`);
          // General cannot be linked, so recording it for a title that is then to be linked would leave a record no link can follow.
          if (record === 1 && options.agent !== undefined) throw new Error('--record 1 is General, which cannot be linked to an agent: drop --agent, or record the topic\'s own id');
        }
        const service = new TelegramBotService(config.token);
        const { id, reused } = await createTopicOnce({
          configDir: getConfigDir(),
          key: topicRecordKey(config.token, chatId),
          title,
          create: () => service.createForumTopic(chatId, title),
          definite: isDefiniteTopicRefusal,
          ...(options.retry ? { retry: true } : {}),
          ...(record !== undefined ? { record } : {}),
        });
        let link: { agent: string; created: boolean; delivered: number } | undefined;
        if (hub !== undefined && options.agent !== undefined) {
          try {
            link = await hub.botTopicLink(config.name, chatId, id, options.agent);
          } catch (error: any) {
            // The topic exists and people can already write in it. Say so with its id, so the link is retried
            // (`bot topic link`) rather than a second topic created; what is written meanwhile is held by the hub.
            if (options.json) console.log(JSON.stringify({ id, title, reused, linked: false, error: error.message }));
            else console.log(chalk.yellow(`⚠ Topic ${id} "${title}" exists but is NOT linked to ${options.agent}: ${error.message}`)
              + `\n  Retry: bot topic link --bot ${config.name} --as ${options.as} -- ${chat} ${id} ${options.agent}`);
            process.exit(1);
          }
        }
        if (options.json) console.log(JSON.stringify({ id, title, reused, ...(link === undefined ? {} : { linked: true, agent: link.agent, delivered: link.delivered }) }));
        else console.log(chalk.green(`✅ Topic ${id} "${title}" [bot chat:${chat}]`) + (reused ? chalk.dim('  (already created from this machine)') : '')
          + (link === undefined ? '' : chalk.green(`  → ${link.agent}`) + (link.delivered > 0 ? chalk.dim(`  (${link.delivered} held message(s) delivered)`) : '')));
      } catch (error: any) {
        console.error(chalk.red('Error:'), error.message);
        process.exit(1);
      }
    });

  topic
    .command('link <chat> <topicId> <agent>')
    .description('Link an existing forum topic to an agent on the hub, at once: its messages go to that agent, and it may post there. '
      + 'Messages written in the topic before the link are delivered now. Only the forum\'s default agent may, and only a topic no agent has.')
    .option('--bot <name>', 'Which configured bot the forum belongs to')
    .requiredOption('--as <name>', 'Your agent name')
    .option('--json', 'Print {"topic":…,"agent":…,"created":…,"delivered":…}')
    .action(async (chat: string, topicId: string, agent: string, options: { bot?: string; as: string; json?: boolean }) => {
      try {
        const config = ensureBotConfig(options.bot);
        // The same local rule as create, send and reply, asked of the id as Telegram reads it: "-0100" is chat -100.
        const chatId = canonicalChatId(chat);
        assertChatAllowed(config, chatId);
        const result = await hubClientAs(options.as, 'A topic link').botTopicLink(config.name, chatId, parseTopicId(topicId), agent);
        if (options.json) console.log(JSON.stringify(result));
        else console.log(chalk.green(`✅ Topic ${result.topic} → ${result.agent}`) + (result.created ? '' : chalk.dim('  (already linked)'))
          + (result.delivered > 0 ? chalk.dim(`  (${result.delivered} held message(s) delivered)`) : ''));
      } catch (error: any) {
        console.error(chalk.red('Error:'), error.message);
        process.exit(1);
      }
    });

  topic
    .command('unlink <chat> <topicId>')
    .description('Remove a topic link made with "topic link". Messages written there afterwards are held until it is linked again.')
    .option('--bot <name>', 'Which configured bot the forum belongs to')
    .requiredOption('--as <name>', 'Your agent name')
    .action(async (chat: string, topicId: string, options: { bot?: string; as: string }) => {
      try {
        const config = ensureBotConfig(options.bot);
        // The same local rule as create, send and reply, asked of the id as Telegram reads it: "-0100" is chat -100.
        const chatId = canonicalChatId(chat);
        assertChatAllowed(config, chatId);
        const id = parseTopicId(topicId);
        const { removed } = await hubClientAs(options.as, 'A topic unlink').botTopicUnlink(config.name, chatId, id);
        console.log(removed ? chalk.green(`✅ Topic ${id} unlinked`) : chalk.dim(`Topic ${id} had no link.`));
      } catch (error: any) {
        console.error(chalk.red('Error:'), error.message);
        process.exit(1);
      }
    });

  topic
    .command('links <chat>')
    .description('Which agent each topic of a forum belongs to: "route" from the cluster config, "link" made on the hub')
    .option('--bot <name>', 'Which configured bot the forum belongs to')
    .requiredOption('--as <name>', 'Your agent name')
    .option('--json', 'Print JSON')
    .action(async (chat: string, options: { bot?: string; as: string; json?: boolean }) => {
      try {
        const config = ensureBotConfig(options.bot);
        // The same local rule as create, send and reply, asked of the id as Telegram reads it: "-0100" is chat -100.
        const chatId = canonicalChatId(chat);
        assertChatAllowed(config, chatId);
        const result = await hubClientAs(options.as, 'A topic listing').botTopics(config.name, chatId);
        if (options.json) { console.log(JSON.stringify(result)); return; }
        console.log(chalk.dim(`default agent: ${result.defaultAgent ?? 'none'}`));
        for (const entry of result.topics) console.log(`${String(entry.topic).padStart(6)}  ${entry.agent}${entry.source === 'link' ? chalk.dim('  (link)') : ''}`);
      } catch (error: any) {
        console.error(chalk.red('Error:'), error.message);
        process.exit(1);
      }
    });

  bot
    .command('reply <chat> <message> <messageId>')
    .description('Reply to a message as the bot (pass "-" to read the body from stdin)')
    .option('--bot <name>', 'Which configured bot to reply as')
    .option('--mute, --silent', 'Deliver without a notification')
    .option('--plain', PLAIN_HELP)
    .option('--html', 'The body is already Telegram HTML')
    .option('--no-tts', 'Do not attach the Listen button')
    .option('--auto', 'Use the old HTML conversion instead of a server-parsed rich message')
    .option('--state <name>', 'State the button text is stashed under (default: the bot name)')
    .option('--topic <id>', 'The forum topic the message is in; posts through the hub (needs --as)')
    .option('--as <name>', 'Your agent name, which the hub checks against the topic')
    .option(FORMAT_OK_FLAG, FORMAT_OK_HELP)
    .addHelpText('after', formatHelpSection())
    .action(async (
      chat: string,
      message: string,
      messageId: string,
      options: { bot?: string; silent?: boolean; plain?: boolean; html?: boolean; auto?: boolean; tts?: boolean; state?: string; topic?: string; as?: string; formatOk?: string }
    ) => {
      try {
        // The body and its format first: a refused message exits 3 whatever the bot or topic config says.
        const text = await resolveMessageArg(message);
        if (!text.trim()) throw new Error('Nothing to send: the message body is empty.');
        const note = enforceFormat(text, options.formatOk, options.plain === true, options.html === true, true);

        const config = ensureBotConfig(options.bot);
        const topic = options.topic === undefined ? undefined : topicTransport(config.name, options.topic, options.as);
        const service = new TelegramBotService(config.token, topic?.via);

        const replyToId = Number(messageId);
        if (!Number.isInteger(replyToId) || replyToId <= 0) {
          throw new Error(`Invalid message id: ${messageId}`);
        }

        assertChatAllowed(config, chat);
        // Rich is the default: server-parsed markdown, real tables and headings,
        // and 32768 characters. It falls back to the ordinary path on failure,
        // so nothing is lost if a message is not valid markdown.
        const sendFormat = options.plain ? 'plain' : options.html ? 'html' : options.auto ? 'auto' : 'rich';
        const id = await service.sendMessage(chat, text, {
          replyToId,
          silent: options.silent,
          format: sendFormat,
          buttons: options.tts === false || !pressAnswerable(config, topic !== undefined)
            ? undefined
            : speakButton(options.tts, resolveStateName(options.state, config.name), text, sendFormat),
          ...(topic ? { threadId: topic.threadId } : {}),
        });
        recordSentMessage(config.name, chat, id, text, sendFormat, topic !== undefined);
        console.log(chalk.green(`✅ Replied to #${replyToId} [bot chat:${chat}] → #${id}${note}`));
      } catch (error: any) {
        console.error(chalk.red('Error:'), error.message);
        process.exit(1);
      }
    });

  bot
    .command('edit <chat> <messageId> [message]')
    .description('Replace the text of a message the bot sent, in place ("-" or no message reads stdin)')
    .option('--bot <name>', 'Which configured bot sent it')
    .option('--plain', PLAIN_HELP)
    .option('--html', 'The body is already Telegram HTML')
    .option('--no-tts', 'Do not attach the Listen button')
    .option('--auto', 'Use the old HTML conversion instead of a server-parsed rich message')
    .option('--state <name>', 'State the button text is stashed under (default: the bot name)')
    .option('--topic <id>', 'The forum topic the message is in, when this machine sent it there through the hub: its Listen button is kept')
    .option(FORMAT_OK_FLAG, FORMAT_OK_HELP)
    .addHelpText('after', formatHelpSection())
    .action(async (
      chat: string,
      messageId: string,
      message: string | undefined,
      options: { bot?: string; plain?: boolean; html?: boolean; auto?: boolean; tts?: boolean; state?: string; topic?: string; formatOk?: string }
    ) => {
      try {
        // The body and its format first: a refused message exits 3 whatever the bot config says.
        const text = await resolveMessageArg(message ?? '-');
        if (!text.trim()) throw new Error('Nothing to send: the message body is empty.');
        const note = enforceFormat(text, options.formatOk, options.plain === true, options.html === true, true);

        const config = ensureBotConfig(options.bot);
        const service = new TelegramBotService(config.token);

        const id = Number(messageId);
        if (!Number.isInteger(id) || id <= 0) throw new Error(`Invalid message id: ${messageId}`);
        // Validated exactly as send/reply validate it (topicTransport): a wrong --topic here would persist a false
        // "sent through the hub" and keep attaching a dead button on every later edit (Codex review).
        if (options.topic !== undefined) {
          const thread = /^\d{1,15}$/.test(options.topic) ? Number(options.topic) : NaN;
          if (!Number.isSafeInteger(thread) || thread < 1) throw new Error(`--topic must be a forum topic id, got ${JSON.stringify(options.topic)}`);
        }

        assertChatAllowed(config, chat);
        // Sent through the hub originally? Then the hub still routes a press on it back to its sender. A topic message
        // was (a topic is only posted to through the hub), so --topic says so for a message sent before the via-hub
        // record existed - but only when THIS machine sent it (its record says authored): the press goes to the
        // sender's watcher, which reads the text this edit rewrites. A message sent from another machine would be read
        // there in its old wording, or not at all, so without a local record it stays unknown (Codex review).
        const viaHub = options.topic !== undefined && sentHere(config.name, chat, id) ? true : sentViaHub(config.name, chat, id);
        // Rendered exactly as send renders it. The Listen button is attached
        // again, because an edit without a keyboard removes the old one, and the
        // stored text is replaced so Listen reads the new version.
        const sendFormat = options.plain ? 'plain' : options.html ? 'html' : options.auto ? 'auto' : 'rich';
        await service.editMessage(chat, id, text, {
          format: sendFormat,
          // Unknown origin (no or old record) is not proof the hub will route it: only a local answerer can justify it.
          buttons: options.tts === false || !pressAnswerable(config, viaHub === true)
            ? undefined
            : speakButton(options.tts, resolveStateName(options.state, config.name), text, sendFormat),
        });
        recordSentMessage(config.name, chat, id, text, sendFormat, viaHub, null);
        console.log(chalk.green(`✅ Edited #${id} [bot chat:${chat}]${note}`));
      } catch (error: any) {
        console.error(chalk.red('Error:'), error.message);
        process.exit(1);
      }
    });

  bot
    .command('delete <chat> <messageIds...>')
    .description('Delete one or more messages the bot sent (noise cleanup: prune progress after the result)')
    .option('--bot <name>', 'Which configured bot to delete as')
    .action(async (chat: string, messageIds: string[], options: { bot?: string }) => {
      try {
        const config = ensureBotConfig(options.bot);
        const service = new TelegramBotService(config.token);
        assertChatAllowed(config, chat);

        const ids = messageIds.map((raw) => {
          const id = Number(raw);
          if (!Number.isInteger(id) || id <= 0) throw new Error(`Invalid message id: ${raw}`);
          return id;
        });

        let deleted = 0;
        const failures: string[] = [];
        for (const id of ids) {
          try {
            await service.deleteMessage(chat, id);
            deleted++;
          } catch (error: any) {
            // A bot may only delete its own messages, within 48h. One that is
            // already gone or too old should not sink the rest of the batch.
            failures.push(`#${id}: ${error.message}`);
          }
        }

        if (deleted > 0) console.log(chalk.green(`\u2705 Deleted ${deleted}/${ids.length} [bot chat:${chat}]`));
        if (failures.length) {
          console.error(chalk.yellow(`Could not delete ${failures.length}:`));
          for (const f of failures) console.error(chalk.dim(`  ${f}`));
          if (deleted === 0) process.exit(1);
        }
      } catch (error: any) {
        console.error(chalk.red('Error:'), error.message);
        process.exit(1);
      }
    });

  bot
    .command('pin <chat> <messageId>')
    .description('Pin a message to the top of a chat (e.g. a living ledger)')
    .option('--bot <name>', 'Which configured bot to pin as')
    .option('--notify', 'Pin loudly (send the pin notification); default is quiet')
    .action(async (chat: string, messageId: string, options: { bot?: string; notify?: boolean }) => {
      try {
        const config = ensureBotConfig(options.bot);
        const service = new TelegramBotService(config.token);
        assertChatAllowed(config, chat);
        const id = Number(messageId);
        if (!Number.isInteger(id) || id <= 0) throw new Error(`Invalid message id: ${messageId}`);
        await service.pinMessage(chat, id, options.notify !== true);
        console.log(chalk.green(`\u2705 Pinned #${id} [bot chat:${chat}]`));
      } catch (error: any) {
        console.error(chalk.red('Error:'), error.message);
        process.exit(1);
      }
    });

  bot
    .command('unpin <chat> [messageId]')
    .description('Unpin one message, or the most recent pin when no id is given')
    .option('--bot <name>', 'Which configured bot to unpin as')
    .action(async (chat: string, messageId: string | undefined, options: { bot?: string }) => {
      try {
        const config = ensureBotConfig(options.bot);
        const service = new TelegramBotService(config.token);
        assertChatAllowed(config, chat);
        let id: number | undefined;
        if (messageId !== undefined) {
          id = Number(messageId);
          if (!Number.isInteger(id) || id <= 0) throw new Error(`Invalid message id: ${messageId}`);
        }
        await service.unpinMessage(chat, id);
        console.log(chalk.green(`\u2705 Unpinned ${id ? `#${id}` : '(latest)'} [bot chat:${chat}]`));
      } catch (error: any) {
        console.error(chalk.red('Error:'), error.message);
        process.exit(1);
      }
    });

  bot
    .command('typing <chat>')
    .description('Show "typing…" in a chat while you work on a reply')
    .option('--bot <name>', 'Which configured bot to appear as')
    .option('--seconds <n>', 'How long to hold it', '5')
    .action(async (chat: string, options: { bot?: string; seconds: string }) => {
      try {
        const config = ensureBotConfig(options.bot);
        const service = new TelegramBotService(config.token);
        const seconds = positiveInt(options.seconds, 'seconds');

        assertChatAllowed(config, chat);
        await service.keepTyping(chat, seconds);
        console.log(chalk.dim(`Held "typing…" in ${chat} for ${seconds}s`));
      } catch (error: any) {
        console.error(chalk.red('Error:'), error.message);
        process.exit(1);
      }
    });

  bot
    .command('file <fileId>')
    .description('Download a file by its Telegram file id, e.g. a photo or document a hub watch line names')
    .option('--bot <name>', 'Which configured bot received it')
    .option('--out <dir>', 'Where to save it (default: the claude-tools media dir)')
    .action(async (fileId: string, options: { bot?: string; out?: string }) => {
      try {
        // Since the hub became the reader of a bot, its updates are no longer in the local log that `download`
        // searches; the hub watch line carries the file id instead. getFile does not compete with the hub's polling.
        if (!/^[A-Za-z0-9_-]{10,256}$/.test(fileId)) throw new Error(`Invalid file id: ${JSON.stringify(fileId)}`);
        const config = ensureBotConfig(options.bot);
        const dir = options.out ?? join(getMediaDir(), 'bot');
        mkdirSync(dir, { recursive: true });
        const path = await new TelegramBotService(config.token).downloadFile(fileId, dir);
        console.log(path);
      } catch (error: any) {
        console.error(chalk.red('Error:'), error.message);
        process.exit(1);
      }
    });

  bot
    .command('download <messageId>')
    .description('Download a photo, document or voice note the bot received')
    .option('--bot <name>', 'Which configured bot to use')
    .option('--state <name>', 'State namespace (default: the bot name)')
    .option('--chat <chatId>', 'Disambiguate when the id exists in several chats')
    .option('--out <dir>', 'Where to save it (default: the claude-tools media dir)')
    .action(async (messageId: string, options: { bot?: string; state?: string; chat?: string; out?: string }) => {
      try {
        const config = ensureBotConfig(options.bot);
        const state = resolveStateName(options.state, config.name);

        // This command already talks to Telegram, so it can check the real bot
        // id rather than a name that a token swap would leave unchanged.
        const service = new TelegramBotService(config.token);
        const me = await service.getMe();
        assertStateOwnership(state, { name: config.name, id: me.id }, { adopt: true });

        const id = Number(messageId);
        if (!Number.isInteger(id) || id <= 0) throw new Error(`Invalid message id: ${messageId}`);

        // The log is the only record of what arrived, so the file reference comes
        // from there rather than from a fetch the Bot API cannot repeat.
        // Message ids are per chat, so an id alone can be ambiguous.
        const matches = readBotLog(state, Number.MAX_SAFE_INTEGER, options.chat)
          .filter((u) => u.messageId === id);

        if (matches.length === 0) {
          throw new Error(
            `Message #${id} is not in the "${state}" log` +
            `${options.chat ? ` for chat ${options.chat}` : ''}. ` +
            'Only messages received while watching are recorded.'
          );
        }

        const chats = new Set(matches.map((u) => u.chatId));
        if (chats.size > 1) {
          throw new Error(
            `Message #${id} exists in several chats (${[...chats].join(', ')}). ` +
            'Telegram message ids are per chat - pass --chat <chatId>.'
          );
        }

        const update = matches[matches.length - 1];

        const fileId = update.file?.fileId ?? update.voice?.fileId;
        if (!fileId) throw new Error(`Message #${id} has nothing to download (${update.attachment ?? 'text only'}).`);

        const destination = options.out ?? join(getMediaDir(), 'bot');
        mkdirSync(destination, { recursive: true });

        const saved = await service.downloadFile(fileId, destination);

        const kind = update.file?.kind ?? update.voice?.kind ?? 'file';
        console.log(chalk.green(`✅ Downloaded ${kind}: ${saved}`));
        if (update.file?.width && update.file?.height) {
          console.log(chalk.dim(`   ${update.file.width}x${update.file.height}`));
        }
      } catch (error: any) {
        console.error(chalk.red('Error:'), error.message);
        process.exit(1);
      }
    });

  bot
    .command('table <chat>')
    .description('Send a real table (rows on stdin: pipe- or tab-separated)')
    .option('--bot <name>', 'Which configured bot to send as')
    .option('--title <text>', 'Paragraph shown above the table')
    .option('--mute, --silent', 'Deliver without a notification')
    .action(async (chat: string, options: { bot?: string; title?: string; silent?: boolean }) => {
      try {
        const config = ensureBotConfig(options.bot);
        const service = new TelegramBotService(config.token);

        const raw = await resolveMessageArg('-');
        const rows = raw
          .split('\n')
          .map((line) => line.trim())
          // A markdown separator row (|---|---|) is layout, not data.
          .filter((line) => line.length > 0 && !/^\|?[\s:|-]+\|?$/.test(line))
          .map((line) => (line.includes('\t') ? line.split('\t') : line.replace(/^\||\|$/g, '').split('|'))
            .map((cell) => ({ text: cell.trim() })));

        if (rows.length === 0) throw new Error('No rows given. Pipe pipe- or tab-separated lines on stdin.');

        const widths = new Set(rows.map((r) => r.length));
        if (widths.size > 1) {
          throw new Error(`Rows have different column counts (${[...widths].join(', ')}); Telegram needs a rectangular table.`);
        }

        const blocks: unknown[] = [];
        if (options.title) blocks.push({ type: 'paragraph', text: options.title });
        blocks.push({ type: 'table', cells: rows });

        assertChatAllowed(config, chat);
        const id = await service.sendRichMessage(chat, blocks, { silent: options.silent });
        console.log(chalk.green(`✅ Sent table (${rows.length} rows x ${rows[0].length}) [bot chat:${chat}] #${id}`));
      } catch (error: any) {
        console.error(chalk.red('Error:'), error.message);
        process.exit(1);
      }
    });

  bot
    .command('read')
    .description('Show messages the bot has received (from the local log)')
    .option('--bot <name>', 'Which configured bot to read for')
    .option('--state <name>', 'State namespace (default: the bot name)')
    .option('--limit <n>', 'Number of messages', '20')
    .option('--chat <chatId>', 'Only this chat')
    .option('--json', 'Output as JSON')
    .action(async (options: { bot?: string; state?: string; limit: string; chat?: string; json?: boolean }) => {
      try {
        const config = ensureBotConfig(options.bot);
        const state = resolveStateName(options.state, config.name);
        // Without this, `--bot personal --state assistant` would quietly read
        // another bot's messages.
        assertStateOwnership(state, { name: config.name }, { adopt: true });

        const limit = positiveInt(options.limit, 'limit');
        const updates = readBotLog(state, limit, options.chat);

        if (options.json) {
          console.log(JSON.stringify(updates.map((u) => ({ ...u, date: u.date.toISOString() })), null, 2));
          return;
        }

        if (updates.length === 0) {
          console.log(chalk.dim('No messages logged yet.'));
          console.log(chalk.dim('A bot cannot read history, so only messages received while watching appear here.'));
          return;
        }

        for (const u of updates) {
          console.log(formatBotUpdate(u, 4000).replace(/^\[tg-bot\] /, ''));
        }
      } catch (error: any) {
        console.error(chalk.red('Error:'), error.message);
        process.exit(1);
      }
    });
}
