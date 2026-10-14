/**
 * A Telegram message the hub's poller delivered (kind `tg`), made readable in a watcher line. Since the hub
 * became the reader of a bot (2026-10-06), its messages arrive as hub messages whose body is JSON; an agent
 * reading `{"v":1,...}` cannot answer a voice note it cannot hear. So the watcher renders who wrote what, where,
 * and transcribes short voice notes the way `bot watch` did (Davron speaks to the fleet mostly in voice).
 *
 * The JSON stays the source of truth (`hub log --json`); this only changes what one line says.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { loadConfig, resolveTelegramBot } from '../config/loader.js';
import { resolveSttBackends, transcribeAudio } from './stt.js';
import { TelegramBotService } from './telegram-bot.js';

/** The fields of the poller's event this rendering reads (agent-hub `telegram/updates.ts`). */
export interface TgEvent {
  bot?: string;
  type?: string;
  chat?: { id?: string; type?: string; title?: string };
  threadId?: number;
  messageId?: number;
  sender?: { id?: string; name?: string; username?: string };
  text?: string;
  replyToMessageId?: number;
  /** The replied-to message's text (hub poller, cut at 300 chars) and its author. */
  replyToText?: string;
  replyToSender?: string;
  /** For a forward: whom it came from. */
  forwardedFrom?: string;
  file?: { kind?: string; fileId?: string; durationSec?: number; name?: string };
  callback?: { queryId?: string; data?: string };
  /** The hub left the content out: the message is in a forum topic no agent has (`unrouted-topic`). */
  withheld?: string;
  /** With `withheld`: the hub kept the whole message and delivers it to the topic's agent once the topic is linked. */
  held?: boolean;
}

/** A Listen press delivered to the agent that sent the message (`tg.callback` whose data is `speak:<key>`). */
export interface HubListenPress {
  bot: string;
  queryId: string;
  chatId: string;
  messageId: number;
  data: string;
  sender: string;
  threadId?: number;
}

/**
 * The Listen press in this hub message, or null when it is anything else. The watcher answers a press itself, as
 * `bot watch` does in a direct chat, so it is never printed: it is the watcher's work, not the agent's.
 */
export function listenPressOf(message: { kind: string; body: string }): HubListenPress | null {
  if (message.kind !== 'tg.callback') return null;
  const event = parseTgEvent(message.body);
  const data = event?.callback?.data;
  const queryId = event?.callback?.queryId;
  if (event === null || typeof data !== 'string' || !data.startsWith('speak:') || typeof queryId !== 'string' || queryId === '') return null;
  if (typeof event.bot !== 'string' || typeof event.chat?.id !== 'string' || typeof event.messageId !== 'number') return null;
  return {
    bot: event.bot,
    queryId,
    chatId: event.chat.id,
    messageId: event.messageId,
    data,
    sender: senderLabel(event),
    ...(typeof event.threadId === 'number' ? { threadId: event.threadId } : {}),
  };
}

/** The same limits `bot watch` uses: transcribe a clip up to three minutes, at most three per batch. */
export const MAX_VOICE_SECONDS = 180;
export const MAX_VOICES_PER_BATCH = 3;
/**
 * How long one transcription may hold the watcher. Every later line waits behind it, and the speech backend's
 * own timeout is minutes, so the watcher gives up first and prints the file id instead.
 */
export const TRANSCRIBE_DEADLINE_MS = 20_000;
/** The longest a transcript keeps being waited for in the background before its line says it failed. */
export const TRANSCRIBE_HARD_LIMIT_MS = 180_000;

const SPOKEN = new Set(['voice', 'audio', 'video_note']);

export function parseTgEvent(body: string): TgEvent | null {
  try {
    const value: unknown = JSON.parse(body);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as TgEvent) : null;
  } catch {
    return null;
  }
}

/** Whether this event is a voice note short enough to transcribe. */
export function wantsTranscript(event: TgEvent): boolean {
  return SPOKEN.has(event.file?.kind ?? '') && typeof event.file?.fileId === 'string'
    && (event.file?.durationSec ?? Number.POSITIVE_INFINITY) <= MAX_VOICE_SECONDS;
}

/**
 * One readable line for the event: `Davron (msg 2350, chat 100000001, topic 3): text`, a voice note's transcript
 * in quotes, or why there is none. Ids stay in the line because a reply needs them.
 */
/**
 * Who sent it, as identity and not just a name: the Telegram user id Telegram stamped, beside the display name.
 * Anyone in the Agent Control Supergroup may write to a track (Davron, 2026-10-06), and a name is chosen by its
 * owner, so a track tells the owner from a colleague by the id. Missing id is said outright.
 */
export function senderLabel(event: TgEvent): string {
  const name = event.sender?.name ?? event.sender?.username ?? 'someone';
  return event.sender?.id !== undefined ? `${name} [id ${event.sender.id}]` : `${name} [no sender id]`;
}

export function renderTgEvent(event: TgEvent, transcript?: { text?: string; error?: string }): string {
  const who = senderLabel(event);
  const where = [
    `msg ${event.messageId ?? '?'}`,
    `chat ${event.chat?.id ?? '?'}`,
    ...(event.threadId !== undefined ? [`topic ${event.threadId}`] : []),
    ...(event.replyToMessageId !== undefined ? [`reply to ${event.replyToMessageId}`] : []),
  ].join(', ');
  const edited = event.type === 'edited_message' ? ' (edited)' : '';
  if (event.type === 'callback_query') return `${who} pressed a button (${where}): ${event.callback?.data ?? ''}`;
  const parts: string[] = [];
  if (event.file !== undefined) {
    const length = event.file.durationSec !== undefined ? ` ${event.file.durationSec}s` : '';
    if (transcript?.text !== undefined) parts.push(`🎤${length} "${transcript.text.trim()}"`);
    else if (SPOKEN.has(event.file.kind ?? '')) {
      const why = transcript?.error ?? (wantsTranscript(event) ? 'not transcribed' : `longer than ${MAX_VOICE_SECONDS}s`);
      parts.push(`🎤${length} (${why}; file ${event.file.fileId ?? '?'})`);
    } else parts.push(`[${event.file.kind ?? 'file'}${event.file.name ? ` ${event.file.name}` : ''}: bot file --bot ${event.bot ?? '?'} ${event.file.fileId ?? '?'}]`);
  }
  if (event.text) parts.push(event.text);
  // A topic no agent has: the content is not ours to read, so say what happened to it and how to connect the topic.
  if (event.withheld !== undefined) {
    parts.push(event.held === true
      ? `[topic ${event.threadId ?? '?'} has no agent yet: the message is held and reaches its agent once the topic is linked (bot topic link --bot ${event.bot ?? '<bot>'} --as <you> -- ${event.chat?.id ?? '<chat>'} ${event.threadId ?? '<topic>'} <agent>)]`
      : `[topic ${event.threadId ?? '?'} has no agent: the content was withheld and is not kept]`);
  }
  // What a reply answers, quoted, so a track does not answer the wrong question; and where a forward came from.
  const quote = event.replyToText !== undefined
    ? ` [replying to ${event.replyToSender ?? 'a message'}: "${event.replyToText.replace(/\s+/g, ' ').trim()}"]`
    : '';
  const forwarded = event.forwardedFrom !== undefined ? ` [forwarded from ${event.forwardedFrom}]` : '';
  return `${who}${edited} (${where})${forwarded}: ${parts.join(' ') || '(empty)'}${quote}`;
}

/** Fetches a bot's file by id: through the hub when a client is at hand, else with the local token. */
export type FileFetcher = (bot: string, fileId: string) => Promise<Buffer>;

/**
 * Download a voice note and transcribe it on the configured speech backends (the office speech cluster first,
 * Groq as fallback). The download goes through the hub when `fetchFile` is given: Telegram's getFile from an
 * agent machine was seen stalling for 30-40 s while the cluster's path answered in about 3 s (2026-10-06).
 * The bot's own token is the fallback; `getFile` does not compete with the hub's polling either way.
 */
export async function transcribeTgVoice(event: TgEvent, fetchFile?: FileFetcher): Promise<{ text?: string; error?: string }> {
  const fileId = event.file?.fileId;
  if (fileId === undefined) return { error: 'no file id' };
  const directory = mkdtempSync(join(tmpdir(), 'hub-tg-voice-'));
  try {
    let path: string | undefined;
    let hubError: string | undefined;
    if (fetchFile !== undefined && event.bot !== undefined) {
      try {
        path = join(directory, `${fileId.slice(0, 32)}.oga`);
        writeFileSync(path, await fetchFile(event.bot, fileId));
      } catch (error) {
        path = undefined;
        hubError = (error as Error).message.slice(0, 120);
      }
    }
    if (path === undefined) {
      const bot = event.bot === undefined ? undefined : resolveTelegramBot(event.bot);
      if (bot === undefined || bot === null) return { error: `${hubError ? `hub download failed (${hubError}) and ` : ''}no local token for bot "${event.bot ?? '?'}"` };
      path = await new TelegramBotService(bot.token).downloadFile(fileId, directory, 90_000);
    }
    const outcome = await transcribeAudio(path, resolveSttBackends(loadConfig()));
    const text = outcome.result.text;
    return typeof text === 'string' ? { text } : { error: 'transcription returned no text' };
  } catch (error) {
    return { error: `transcription failed: ${(error as Error).message.slice(0, 160)}` };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * The watcher's step: each `tg` message's body replaced by its readable line, voice notes transcribed (at most
 * MAX_VOICES_PER_BATCH per batch, the rest say so). Any other message is returned untouched. Never throws: a
 * failure to render leaves the original JSON body, which still carries everything.
 */
export async function renderTgMessages<M extends { kind: string; body: string }>(
  messages: readonly M[],
  transcribe: (event: TgEvent) => Promise<{ text?: string; error?: string }> = (event) => transcribeTgVoice(event),
  deadlineMs = TRANSCRIBE_DEADLINE_MS,
  /**
   * Called with a transcript that missed the deadline, when it arrives (or fails) up to TRANSCRIBE_HARD_LIMIT_MS
   * later. The line was already printed saying the text follows; this is the text. Without it, a slow
   * transcript is reported as failed rather than delivered late.
   */
  onLate?: (event: TgEvent, transcript: { text?: string; error?: string }) => void,
  hardLimitMs = TRANSCRIBE_HARD_LIMIT_MS,
): Promise<M[]> {
  const bounded = (event: TgEvent): Promise<{ text?: string; error?: string }> => {
    let timer: NodeJS.Timeout | undefined;
    const work = transcribe(event).catch((error: Error) => ({ error: `transcription failed: ${error.message}` }));
    const late = new Promise<{ error: string; late: true }>((resolve) => {
      // Not unref'd: while a line is being rendered this timer may be the only thing keeping the watcher alive.
      timer = setTimeout(() => resolve({ error: `transcription took over ${Math.round(deadlineMs / 1000)}s`, late: true }), deadlineMs);
    });
    return Promise.race([work, late]).then((first) => {
      clearTimeout(timer);
      if (!('late' in first) || onLate === undefined) return first;
      // Late: say so now, deliver the text when it comes, and give up loudly at the hard limit.
      let cap: NodeJS.Timeout | undefined;
      const capped = new Promise<{ error: string }>((resolve) => {
        cap = setTimeout(() => resolve({ error: `transcription gave up after ${Math.round(hardLimitMs / 1000)}s` }), hardLimitMs);
      });
      void Promise.race([work, capped]).then((result) => {
        clearTimeout(cap);
        onLate(event, result);
      });
      return { error: 'transcribing; the text follows in its own line' };
    });
  };
  let voices = 0;
  const out: M[] = [];
  for (const message of messages) {
    if (message.kind !== 'tg' && message.kind !== 'tg.callback') {
      out.push(message);
      continue;
    }
    const event = parseTgEvent(message.body);
    if (event === null) {
      out.push(message);
      continue;
    }
    // Per message, so one event of an unexpected shape falls back to its JSON instead of stopping the batch.
    try {
      let transcript: { text?: string; error?: string } | undefined;
      if (wantsTranscript(event)) {
        voices += 1;
        transcript = voices <= MAX_VOICES_PER_BATCH
          ? await bounded(event)
          : { error: `more than ${MAX_VOICES_PER_BATCH} voice notes at once` };
      }
      out.push({ ...message, body: renderTgEvent(event, transcript) });
    } catch {
      out.push(message);
    }
  }
  return out;
}
