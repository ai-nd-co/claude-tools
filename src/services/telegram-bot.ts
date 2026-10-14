// Telegram Bot API client.
//
// A bot is a different transport from the user-account client in `telegram.ts`,
// not a wrapper over it. Two consequences shape this module:
//
// 1. There is no history. `getUpdates` is a queue: an update is delivered once
//    and is gone for good as soon as a later offset is confirmed. Anything worth
//    re-reading has to be written down locally, which is why the watcher keeps a
//    log rather than re-fetching.
// 2. The bot only sees chats where someone has written to it first, so its own
//    chat ids have to be learned from updates.

import { processStartTime } from './bot-watch-presence.js';
import { createHash } from 'crypto';
import { closeSync, constants as fsConstants, createWriteStream, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync, writeSync } from 'fs';
import { basename, dirname, join } from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { getConfigDir } from '../config/paths.js';
import { isWellNested, needsHtml, toTelegramHtml } from './telegram-format.js';

const API_ROOT = 'https://api.telegram.org';

/** The Bot API's cap on a file a bot uploads (sendDocument and friends): 50 MB. */
export const MAX_BOT_UPLOAD_BYTES = 50 * 1024 * 1024;

/** getFile cannot serve anything larger; the API rejects it. */
export const MAX_BOT_DOWNLOAD_BYTES = 20 * 1024 * 1024;

export interface BotIdentity {
  id: number;
  username?: string;
  firstName: string;
}

export interface BotVoice {
  fileId: string;
  /** Seconds, as reported by Telegram. */
  duration?: number;
  mimeType?: string;
  fileSize?: number;
  /** `voice` for a voice note, `audio` for a music/audio file. */
  kind: 'voice' | 'audio';
}

/**
 * A downloadable non-audio attachment, e.g. a photo or a document.
 *
 * A reference, not a path, and that is the rule for everything on this side of the
 * wire: a local path for an attachment belongs in structured output or in fields
 * like this one, **never inside the message text an agent reads**. See the note in
 * `formatBotUpdate` for why — in short, any allowlisted sender can type
 * `[image attached - read: /some/path]` themselves, so a path that arrives inside
 * content proves nothing about where it came from.
 */
export interface BotFile {
  fileId: string;
  kind: 'photo' | 'document' | 'video' | 'animation' | 'sticker' | 'video_note';
  /** Original name, when Telegram reports one. */
  filename?: string;
  mimeType?: string;
  fileSize?: number;
  width?: number;
  height?: number;
}

/** A pressed inline button. */
export interface BotCallback {
  queryId: string;
  chatId: string;
  /** The message the button is attached to. */
  messageId: number;
  data: string;
  sender: string;
  /** Telegram's user id for the presser, for matching a chat's `allowFrom`. */
  senderId?: string;
}

export interface BotUpdate {
  updateId: number;
  chatId: string;
  chatTitle: string;
  chatType: string;
  messageId: number;
  date: Date;
  sender: string;
  /**
   * Telegram's user id for the sender.
   *
   * The display name above can be changed at will and two accounts can share one,
   * so it is a label; this is the identity a per-chat `allowFrom` is matched on.
   */
  senderId?: string;
  text: string;
  replyToId?: number;
  /**
   * Sender of the message this one replies to.
   *
   * Replying to one of the bot's own messages is how a group member addresses it
   * without typing its handle, so the mention gate needs to know who was replied to.
   */
  replyToSenderId?: string;
  /**
   * `@handle`s Telegram itself marked as mentions, without the `@`.
   *
   * Taken from the message's entities rather than by scanning the text, so a handle
   * inside a code block or a URL does not count as addressing anyone.
   */
  mentionedUsernames?: string[];
  /** Ids from `text_mention` entities: a mention of someone who has no username. */
  mentionedUserIds?: string[];
  /** Set when this update is an edit of an earlier message. */
  edited?: boolean;
  voice?: BotVoice;
  /** Non-audio attachment, named so the log says what arrived. */
  attachment?: string;
  /** The same attachment as a downloadable reference, when there is one. */
  file?: BotFile;
  /** Filled in later by transcription, like the user-client path. */
  transcript?: string;
  /**
   * Why there is no `transcript`, when the clip was skipped rather than failed.
   *
   * The skip used to be silent, so a long clip surfaced as a bare `[voice 97s]` and the reader
   * could not tell whether transcription had failed, was still running, or had never been
   * attempted. Two 60-second-plus messages were transcribed by hand before anyone noticed there
   * was a cap at all.
   */
  transcriptSkipped?: string;
  /**
   * Who a forwarded message came from, when this is one.
   *
   * Without it a forward reads as the owner's own words, which is worse than
   * unhelpful: acting on a forwarded instruction as though he wrote it is
   * exactly the mistake the instruction-source rules exist to prevent.
   */
  forwardedFrom?: string;
}

/** Telegram's ceiling for one rich message, against 4096 for an ordinary one. */
export const RICH_MESSAGE_MAX_CHARS = 32768;

/** One `getUpdates` batch: what is worth reporting, plus where the queue now is. */
export interface BotBatch {
  messages: BotUpdate[];
  /** Button presses in this batch. */
  callbacks: BotCallback[];
  /** Highest `update_id` in the batch, ignored types included. Null when empty. */
  cursor: number | null;
  /** Raw update count, for distinguishing "nothing new" from "nothing kept". */
  received: number;
}

interface ApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

/**
 * The bot token appears in every request URL, so any error text built from a URL
 * would leak it. Everything thrown from here goes through this first.
 */
export function redactBotToken(text: string, token: string): string {
  // A short or empty token would match ordinary letters and shred the message —
  // which also breaks any caller that inspects the text, such as the send-time
  // formatting retry. Real tokens are far longer than this floor.
  let out = token.length >= 10 ? text.split(token).join('<bot-token>') : text;
  // Also catch a token that is not the configured one (e.g. a copy/paste slip).
  out = out.replace(/\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g, '<bot-token>');
  return out;
}

function senderName(from: any): string {
  if (!from) return 'Unknown';
  return from.username || [from.first_name, from.last_name].filter(Boolean).join(' ') || String(from.id);
}

function chatTitle(chat: any): string {
  if (!chat) return 'unknown';
  return chat.title || chat.username || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || String(chat.id);
}

/** Name a non-audio attachment so a log line is not silently empty. */
function describeAttachment(message: any): string | undefined {
  if (message.photo) return 'photo';
  if (message.video) return 'video';
  if (message.video_note) return 'video_note';
  if (message.sticker) return 'sticker';
  if (message.animation) return 'animation';
  if (message.document) return `document ${message.document.file_name ?? ''}`.trim();
  if (message.location) return 'location';
  if (message.contact) return 'contact';
  if (message.poll) return 'poll';
  if (message.story) return 'story';
  if (message.dice) return 'dice';
  if (message.venue) return 'venue';
  if (message.game) return 'game';
  if (message.invoice) return 'invoice';
  if (message.paid_media) return 'paid media';
  if (message.giveaway) return 'giveaway';
  return undefined;
}

/**
 * Keys that carry no content, so their presence does not make a message
 * renderable. Everything else on a message object is a candidate for the
 * unknown-content fallback below.
 */
const NON_CONTENT_KEYS = new Set([
  'message_id', 'message_thread_id', 'from', 'sender_chat', 'sender_boost_count',
  'date', 'edit_date', 'chat', 'is_topic_message', 'is_automatic_forward',
  'forward_origin', 'forward_from', 'forward_from_chat', 'forward_from_message_id',
  'forward_signature', 'forward_sender_name', 'forward_date', 'quote',
  'reply_to_message', 'external_reply', 'via_bot', 'has_protected_content',
  'media_group_id', 'author_signature', 'entities', 'caption_entities',
  'link_preview_options', 'reply_markup', 'effect_id', 'show_caption_above_media',
  'has_media_spoiler', 'business_connection_id', 'is_from_offline',
]);

/**
 * Flatten a rich message into readable text.
 *
 * Rich messages are Telegram's block format and the only way to send a real
 * table — the same mechanism this tool uses for `bot table`. They carry no
 * `text` field, so an incoming one read as an empty message until now.
 *
 * Unknown block types contribute whatever string they carry rather than being
 * dropped: a block format will grow, and losing a paragraph because it arrived
 * inside an unfamiliar wrapper is the failure this whole path exists to stop.
 */
function richMessageText(rich: any): string | undefined {
  const blocks = rich?.blocks;
  if (!Array.isArray(blocks)) return undefined;

  const parts = blocks.map((b) => richBlockText(b, 0)).filter(Boolean);
  const text = parts.join('\n').trim();
  return text || undefined;
}

/**
 * Pull the text out of a rich-text value, whatever shape it arrives in.
 *
 * A block's `text` is **not** reliably a string: Telegram's rich text is a tree
 * of nodes (plain, bold, concat, url…), so a first attempt that only accepted
 * strings rendered every paragraph as an empty `[paragraph]` while tables —
 * whose cells happened to hold plain strings — came through fine.
 *
 * Rather than encode a schema that is still moving, this walks whatever it is
 * given and collects the strings. Over-collecting costs a little duplicated
 * text; under-collecting loses the owner's message, which is the failure this
 * whole path exists to prevent.
 */
function richTextOf(node: any, depth = 0): string {
  if (node == null || depth > 12) return '';
  if (typeof node === 'string') return node;
  if (typeof node !== 'object') return '';
  if (Array.isArray(node)) return node.map((n) => richTextOf(n, depth + 1)).join('');

  // Concatenation nodes hold their children under `texts`; styled nodes wrap a
  // single child under `text`. Both may nest arbitrarily.
  if (node.texts !== undefined) return richTextOf(node.texts, depth + 1);
  if (node.text !== undefined) return richTextOf(node.text, depth + 1);
  // A custom emoji carries no text but does carry what it stands for.
  if (typeof node.alt === 'string') return node.alt;
  return '';
}

/** Render one block. Tables become rows, lists become bullets, the rest is text. */
function richBlockText(block: any, depth: number): string {
  if (!block || typeof block !== 'object' || depth > 8) return '';

  const cells = block.cells ?? block.rows;
  if (Array.isArray(cells)) {
    return cells
      .filter(Array.isArray)
      .map((row: any[]) => row.map((c) => richTextOf(c, depth + 1).trim()).join(' | '))
      .join('\n');
  }

  // A list keeps its entries under `items`; each entry is either rich text or
  // nested blocks of its own.
  if (Array.isArray(block.items)) {
    return block.items
      .map((item: any) => {
        const body = Array.isArray(item?.blocks)
          ? item.blocks.map((b: any) => richBlockText(b, depth + 1)).filter(Boolean).join('\n')
          : richTextOf(item, depth + 1);
        return body.trim() ? `- ${body.trim()}` : '';
      })
      .filter(Boolean)
      .join('\n');
  }

  if (Array.isArray(block.blocks)) {
    return block.blocks.map((b: any) => richBlockText(b, depth + 1)).filter(Boolean).join('\n');
  }

  const text = richTextOf(block.text ?? block.caption, depth + 1).trim();
  if (text) return text;

  // Nothing readable: name it rather than dropping it, so the gap stays visible.
  return block.type || block.className ? `[${block.type ?? block.className}]` : '';
}

/**
 * Describe a message that produced no text, no caption and no known attachment.
 *
 * This exists because of a real miss: a forwarded message arrived, matched
 * nothing the parser knew about, and was stored as `text: ""` — so the watcher
 * printed an empty line and the owner's message was silently lost. An
 * unrecognised message must announce itself, naming the fields it carried, so
 * the gap is visible immediately and fixable from the log alone.
 */
function describeUnknown(message: any): string | undefined {
  const keys = Object.keys(message).filter((k) => !NON_CONTENT_KEYS.has(k));
  if (!keys.length) return 'empty message (no content fields)';
  return `unsupported content: ${keys.sort().join(', ')}`;
}

/**
 * Attribute a forwarded message.
 *
 * Bot API 7.0 replaced `forward_from`/`forward_from_chat` with the tagged
 * `forward_origin`, but the legacy fields are still delivered by older setups,
 * so both are read. A user who forwards with a hidden account yields only
 * `sender_name`, which is still worth showing — "forwarded from someone
 * hidden" is a different fact from "the owner wrote this".
 */
function describeForward(message: any): string | undefined {
  const origin = message.forward_origin;
  if (origin) {
    switch (origin.type) {
      case 'user': return senderName(origin.sender_user);
      case 'hidden_user': return origin.sender_user_name || 'hidden user';
      case 'chat': return chatTitle(origin.sender_chat) || 'a chat';
      case 'channel': {
        const name = chatTitle(origin.chat) || 'a channel';
        return origin.author_signature ? `${name} (${origin.author_signature})` : name;
      }
      default: return origin.type ? `unknown origin (${origin.type})` : undefined;
    }
  }

  if (message.forward_from) return senderName(message.forward_from);
  if (message.forward_from_chat) return chatTitle(message.forward_from_chat) || 'a chat';
  if (message.forward_sender_name) return message.forward_sender_name;
  return undefined;
}

/**
 * Extract a downloadable reference for a non-audio attachment.
 *
 * `message.photo` is an array of sizes, smallest first; the last is the largest
 * Telegram kept. Reading a screenshot needs the largest, or the text in it is
 * illegible.
 */
function extractFile(message: any): BotFile | undefined {
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const largest = message.photo[message.photo.length - 1];
    return {
      fileId: largest.file_id,
      kind: 'photo',
      fileSize: largest.file_size,
      width: largest.width,
      height: largest.height,
    };
  }

  for (const [key, kind] of [
    ['document', 'document'],
    ['video', 'video'],
    ['animation', 'animation'],
    ['sticker', 'sticker'],
    ['video_note', 'video_note'],
  ] as const) {
    const media = message[key];
    if (media?.file_id) {
      return {
        fileId: media.file_id,
        kind,
        filename: media.file_name,
        mimeType: media.mime_type,
        fileSize: media.file_size,
        width: media.width,
        height: media.height,
      };
    }
  }

  return undefined;
}

function parseCallback(raw: any): BotCallback | null {
  const query = raw.callback_query;
  if (!query?.message?.chat || typeof query.data !== 'string') return null;

  return {
    queryId: String(query.id),
    chatId: String(query.message.chat.id),
    messageId: query.message.message_id,
    data: query.data,
    sender: senderName(query.from),
    senderId: query.from?.id === undefined ? undefined : String(query.from.id),
  };
}

/**
 * Mentions, as Telegram marked them.
 *
 * Entities index the text they came with, so the caption path has to be read
 * against `caption_entities` and the text path against `entities` - crossing them
 * would slice at the wrong offsets and invent handles that nobody wrote.
 *
 * `bot_command` counts alongside `mention`: `/status@thebot` names the bot as
 * precisely as `@thebot` does, and Telegram types it as a command.
 */
function extractMentions(message: any): { usernames: string[]; userIds: string[] } {
  const hasText = typeof message.text === 'string';
  const source: string = hasText ? message.text : typeof message.caption === 'string' ? message.caption : '';
  const entities: any[] = (hasText ? message.entities : message.caption_entities) ?? [];

  const usernames: string[] = [];
  const userIds: string[] = [];

  for (const entity of Array.isArray(entities) ? entities : []) {
    if (!entity) continue;

    if (entity.type === 'mention' || entity.type === 'bot_command') {
      if (typeof entity.offset !== 'number' || typeof entity.length !== 'number') continue;
      const handle = source.slice(entity.offset, entity.offset + entity.length).match(/@([A-Za-z0-9_]{1,64})/);
      if (handle) usernames.push(handle[1]);
      continue;
    }

    // A member with no username is mentioned by name, with the id in the entity.
    if (entity.type === 'text_mention' && entity.user?.id !== undefined) {
      userIds.push(String(entity.user.id));
    }
  }

  return { usernames, userIds };
}

/** Exported for tests: the shape of an incoming update is where content gets lost. */
export function parseUpdate(raw: any): BotUpdate | null {
  const edited = Boolean(raw.edited_message);
  const message = raw.message ?? raw.edited_message;

  // Ignore callback queries, polls, join events and the rest: this transport is
  // a message channel, and anything else would only add noise to the log.
  if (!message?.chat) return null;

  const voiceSource = message.voice ?? message.audio;
  const voice: BotVoice | undefined = voiceSource
    ? {
        fileId: voiceSource.file_id,
        duration: voiceSource.duration,
        mimeType: voiceSource.mime_type,
        fileSize: voiceSource.file_size,
        kind: message.voice ? 'voice' : 'audio',
      }
    : undefined;

  const text = message.text ?? message.caption ?? richMessageText(message.rich_message) ?? '';
  const attachment = voice ? undefined : describeAttachment(message);
  const mentions = extractMentions(message);

  return {
    updateId: raw.update_id,
    chatId: String(message.chat.id),
    chatTitle: chatTitle(message.chat),
    chatType: message.chat.type ?? 'private',
    messageId: message.message_id,
    date: new Date((message.edit_date ?? message.date) * 1000),
    sender: senderName(message.from),
    senderId: message.from?.id === undefined ? undefined : String(message.from.id),
    text,
    replyToId: message.reply_to_message?.message_id,
    replyToSenderId:
      message.reply_to_message?.from?.id === undefined
        ? undefined
        : String(message.reply_to_message.from.id),
    // Empty lists are left off entirely: every update is written to the message
    // log verbatim, and two empty arrays per line is pure weight.
    mentionedUsernames: mentions.usernames.length ? mentions.usernames : undefined,
    mentionedUserIds: mentions.userIds.length ? mentions.userIds : undefined,
    edited: edited || undefined,
    voice,
    // A message that matched nothing still has to say so. Reporting it as an
    // attachment keeps it visible in the log instead of rendering as a blank
    // line, which is how a forwarded message was lost entirely.
    attachment: attachment ?? (text || voice ? undefined : describeUnknown(message)),
    file: voice ? undefined : extractFile(message),
    forwardedFrom: describeForward(message),
  };
}

/**
 * Telegram refused a rich message's content: invalid rich markdown, a server that
 * ignores `rich_message` and then finds no text, or one without the rich method at
 * all ("Not Found"). Only these justify resending the same text as HTML or plain.
 */
export function isRichContentRefusal(message: string): boolean {
  return /RICH_MESSAGE|message text is empty|text must be non-empty|can't parse|entities/i.test(message) || /\bNot Found\b/.test(message);
}

/** Makes a Bot API call somewhere other than api.telegram.org: the hub's bot broker (see `HubClient.botCall`). */
export type BotTransport = (method: string, body: unknown) => Promise<unknown>;

/** Uploads a voice note the same way: parameters and the audio bytes (see `HubClient.botVoice`). */
export type BotVoiceTransport = (params: Record<string, string | number>, audio: Buffer) => Promise<unknown>;

export class TelegramBotService {
  /**
   * `via`: send every call through this transport instead of the token, e.g. the hub for a forum topic.
   * `viaVoice`: the same for voice notes; with `via` set and no `viaVoice`, an upload is refused rather than sent
   * with the token, which would bypass the hub's topic guard.
   */
  constructor(
    private readonly token: string,
    private readonly via?: BotTransport,
    private readonly viaVoice?: BotVoiceTransport,
  ) {}

  /** Single redaction point, so no error can carry the token out of this class. */
  private redact(text: string): string {
    return redactBotToken(text, this.token);
  }

  private async call<T>(method: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
    if (this.via !== undefined) return (await this.via(method, body ?? {})) as T;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let payload: ApiResponse<T>;
    let httpStatus = 0;
    try {
      const response = await fetch(`${API_ROOT}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      httpStatus = response.status;
      // Parsed inside the guarded region: a response whose headers arrive but
      // whose body stalls would otherwise hang forever, because the timer used
      // to be cleared as soon as fetch resolved.
      payload = (await response.json().catch(() => ({ ok: false, description: 'non-JSON response' }))) as ApiResponse<T>;
    } catch (err) {
      const message = (err as Error).name === 'AbortError'
        ? `Telegram Bot API ${method} timed out after ${Math.round(timeoutMs / 1000)}s`
        : `Telegram Bot API ${method} failed: ${(err as Error).message}`;
      throw new Error(this.redact(message));
    } finally {
      clearTimeout(timer);
    }

    if (!payload.ok) {
      const detail = payload.description ?? `HTTP ${httpStatus}`;

      // 409 means someone else is polling the same bot. Say so plainly: the
      // symptom otherwise looks like a silent watcher.
      if (payload.error_code === 409) {
        throw new Error(
          'Another process is already polling this bot (Telegram 409 Conflict).\n' +
          'Stop the other poller, or use a different bot token.'
        );
      }
      if (payload.error_code === 401) {
        throw new Error('Telegram rejected the bot token. Check TELEGRAM_BOT_TOKEN or the telegramBot.token secret.');
      }
      // A bot cannot open a conversation, so this is what an unstarted bot looks
      // like. The bare API wording sends people hunting for a wrong chat id.
      if (/chat not found/i.test(detail) && method === 'sendMessage') {
        throw new Error(
          'Chat not found. A bot cannot start a conversation, so the person has to message it first ' +
          '(or press Start). Ask them to send it anything, then retry.'
        );
      }
      if (payload.error_code === 403 && /blocked/i.test(detail)) {
        throw new Error('That person has blocked this bot, so it cannot message them.');
      }
      if (payload.error_code === 429) {
        const wait = payload.parameters?.retry_after;
        // `detail` is arbitrary upstream text, so it is redacted like any other.
        throw new Error(this.redact(`Telegram rate limit${wait ? `; retry after ${wait}s` : ''}: ${detail}`));
      }

      throw new Error(this.redact(`Telegram Bot API ${method}: ${detail}`));
    }

    return payload.result as T;
  }

  async getMe(): Promise<BotIdentity> {
    const me = await this.call<any>('getMe');
    return { id: me.id, username: me.username, firstName: me.first_name };
  }

  /**
   * Long-poll for updates.
   *
   * `offset` confirms everything below it, so the caller must only advance it
   * once an update has been dealt with — otherwise a crash loses messages that
   * cannot be fetched again.
   */
  async getUpdates(opts: { offset?: number; limit?: number; timeoutSec?: number } = {}): Promise<BotBatch> {
    const timeoutSec = opts.timeoutSec ?? 25;
    const raw = await this.call<any[]>(
      'getUpdates',
      {
        offset: opts.offset,
        limit: opts.limit ?? 100,
        timeout: timeoutSec,
        allowed_updates: ['message', 'edited_message', 'callback_query'],
      },
      // Outlive the long poll itself, or the request is aborted every time.
      (timeoutSec + 15) * 1000
    );

    // The cursor comes from every update in the batch, including the ones
    // filtered out. Deriving it from the kept messages only would leave the
    // offset stuck whenever a batch held nothing but ignored update types, and
    // the loop would re-fetch it forever.
    const cursor = raw.length ? Math.max(...raw.map((u) => Number(u.update_id))) : null;

    return {
      messages: raw.map(parseUpdate).filter((u): u is BotUpdate => u !== null),
      callbacks: raw.map(parseCallback).filter((c): c is BotCallback => c !== null),
      cursor,
      received: raw.length,
    };
  }

  /**
   * Send a message. Returns the sent message id.
   *
   * `format` defaults to `auto`, which renders this project's message style
   * (bold+underlined titles, inline code, links) as Telegram HTML. Without a
   * parse mode Telegram shows that style as literal punctuation, which is what
   * it used to do.
   */
  async sendMessage(
    chatId: string,
    text: string,
    opts: {
      replyToId?: number;
      silent?: boolean;
      format?: 'auto' | 'plain' | 'html' | 'rich';
      buttons?: { text: string; callbackData: string }[];
      /** A forum topic (`message_thread_id`). */
      threadId?: number;
    } = {}
  ): Promise<number> {
    const format = opts.format ?? 'auto';

    // A rich message is markdown parsed by Telegram's own server: real tables
    // and headings, and a 32768-character ceiling instead of 4096. It makes
    // toTelegramHtml unnecessary rather than better - all that escaping, tag
    // parking and nesting validation exists to work around a problem the
    // server does not have. Buttons are supported here too, so the Listen
    // button survives.
    if (format === 'rich') {
      try {
        return await this.sendRich(chatId, text, opts);
      } catch (err) {
        // Never lose a message to a formatting failure: fall through to the
        // ordinary path, which can still deliver it as HTML or plain text.
        // Anything else is reported. A refusal (a hub's 403, a blocked bot) is not
        // a formatting problem, and a timeout or a 5xx may mean the message already
        // landed, so a plain retry would deliver it twice or around the refusal
        // while printing success.
        const message = (err as Error).message;
        if (!isRichContentRefusal(message)) throw err;
        process.stderr.write(`[tg-bot] rich send refused, falling back: ${this.redact(message)}\n`);
      }
    }

    let body = text;
    let parseMode: string | undefined;

    if (format === 'html') {
      parseMode = 'HTML';
    } else if (format === 'auto') {
      // Plain prose is sent without a parse mode at all, so a message with no
      // markup cannot be rejected over an unbalanced tag.
      if (needsHtml(text)) {
        const html = toTelegramHtml(text);

        // Overlapping markers produce crossed tags that Telegram rejects. A
        // message delivered unformatted beats one that fails to send, so the
        // structure is checked and the conversion dropped if it is unsound.
        if (isWellNested(html)) {
          body = html;
          parseMode = 'HTML';
        }
      }
    }

    const payload = {
      chat_id: chatId,
      text: body,
      message_thread_id: opts.threadId,
      reply_to_message_id: opts.replyToId,
      disable_notification: opts.silent || undefined,
      parse_mode: parseMode,
      link_preview_options: { is_disabled: true },
      reply_markup: opts.buttons?.length
        ? { inline_keyboard: [opts.buttons.map((b) => ({ text: b.text, callback_data: b.callbackData }))] }
        : undefined,
    };

    try {
      const sent = await this.call<any>('sendMessage', payload);
      return sent.message_id;
    } catch (err) {
      // Well-nested markup can still be refused - an empty <pre>, a link
      // Telegram will not parse. Structure checking cannot catch every such
      // case, so a rejection attributable to formatting retries once as plain
      // text: an unformatted message beats a message that never arrives.
      const message = (err as Error).message;
      const isFormatting = parseMode !== undefined && /can't parse|entities|unsupported start tag|tag .* is unsupported|url host is empty/i.test(message);
      if (!isFormatting || format === 'plain') throw err;

      const sent = await this.call<any>('sendMessage', { ...payload, text, parse_mode: undefined });
      return sent.message_id;
    }
  }

  /**
   * Replace the text of a message the bot sent, keeping its id, so a digest is
   * corrected in place instead of followed up or deleted and resent.
   *
   * Rendering follows sendMessage: rich markdown first, then the HTML or plain
   * path if Telegram refuses it. `buttons` replaces the inline keyboard, and an
   * edit without one removes it, so callers pass the Listen button again.
   * Telegram answers "message is not modified" when the text is unchanged; that
   * is success, since the message already says what was asked.
   */
  async editMessage(
    chatId: string,
    messageId: number,
    text: string,
    opts: {
      format?: 'auto' | 'plain' | 'html' | 'rich';
      buttons?: { text: string; callbackData: string }[];
    } = {}
  ): Promise<void> {
    const format = opts.format ?? 'auto';
    const replyMarkup = opts.buttons?.length
      ? { inline_keyboard: [opts.buttons.map((b) => ({ text: b.text, callback_data: b.callbackData }))] }
      : undefined;
    const edit = async (fields: Record<string, unknown>): Promise<void> => {
      try {
        await this.call('editMessageText', { chat_id: chatId, message_id: messageId, reply_markup: replyMarkup, ...fields });
      } catch (err) {
        if (/message is not modified/i.test((err as Error).message)) return;
        throw err;
      }
    };

    if (format === 'rich') {
      if (text.length > RICH_MESSAGE_MAX_CHARS) {
        throw new Error(`Rich message is ${text.length} characters; the limit is ${RICH_MESSAGE_MAX_CHARS}.`);
      }
      try {
        await edit({ rich_message: { markdown: text } });
        return;
      } catch (err) {
        // Fall back only when Telegram refused the content itself: invalid rich
        // markdown, or a server that ignores rich_message and then finds no text.
        // Anything else (a timeout, a 5xx, a missing message) may mean the edit
        // already landed, and a plain retry would overwrite the formatted text with
        // raw markdown while reporting success (review of this change).
        const message = (err as Error).message;
        if (!isRichContentRefusal(message)) throw err;
        process.stderr.write(`[tg-bot] rich edit refused, falling back: ${this.redact(message)}\n`);
      }
    }

    let body = text;
    let parseMode: string | undefined;
    if (format === 'html') {
      parseMode = 'HTML';
    } else if (format === 'auto') {
      if (needsHtml(text)) {
        const html = toTelegramHtml(text);
        if (isWellNested(html)) {
          body = html;
          parseMode = 'HTML';
        }
      }
    }

    // After a refused rich edit this is plain text, exactly as sendMessage does it.
    try {
      await edit({ text: body, parse_mode: parseMode, link_preview_options: { is_disabled: true } });
    } catch (err) {
      const message = (err as Error).message;
      const isFormatting = parseMode !== undefined && /can't parse|entities|unsupported start tag|tag .* is unsupported|url host is empty/i.test(message);
      if (!isFormatting || format === 'plain') throw err;
      await edit({ text, link_preview_options: { is_disabled: true } });
    }
  }

  /**
   * Delete a message the bot sent. The Bot API only lets a bot remove its own
   * messages, and only within 48 hours - which is exactly the noise-cleanup
   * case this exists for: prune a progress message once the result has landed.
   * A message that is already gone or too old comes back as an API error.
   */
  async deleteMessage(chatId: string, messageId: number): Promise<void> {
    await this.call<boolean>('deleteMessage', { chat_id: chatId, message_id: messageId });
  }

  /**
   * Pin a message the bot can see. `silent` pins without a notification, which
   * suits a living ledger re-pinned as it changes. The bot needs pin rights in
   * a group; in a private chat it can pin freely.
   */
  async pinMessage(chatId: string, messageId: number, silent = true): Promise<void> {
    await this.call<boolean>('pinChatMessage', {
      chat_id: chatId,
      message_id: messageId,
      disable_notification: silent,
    });
  }

  /** Unpin one message, or the most recent pin when no id is given. */
  async unpinMessage(chatId: string, messageId?: number): Promise<void> {
    await this.call<boolean>('unpinChatMessage', {
      chat_id: chatId,
      ...(messageId !== undefined ? { message_id: messageId } : {}),
    });
  }

  /**
   * Send markdown for Telegram's server to parse.
   *
   * The field is `rich_message.markdown`, which is not clearly documented. It
   * was found by probing with empty values: a recognised field rejects the
   * *content* (`RICH_MESSAGE_MARKDOWN_INVALID`) while an unknown one falls
   * through to the generic "rich message must be non-empty".
   */
  async sendRich(
    chatId: string,
    markdown: string,
    opts: { replyToId?: number; silent?: boolean; buttons?: { text: string; callbackData: string }[]; threadId?: number } = {}
  ): Promise<number> {
    if (markdown.length > RICH_MESSAGE_MAX_CHARS) {
      throw new Error(`Rich message is ${markdown.length} characters; the limit is ${RICH_MESSAGE_MAX_CHARS}.`);
    }

    const sent = await this.call<any>('sendRichMessage', {
      chat_id: chatId,
      rich_message: { markdown },
      message_thread_id: opts.threadId,
      reply_to_message_id: opts.replyToId,
      disable_notification: opts.silent || undefined,
      reply_markup: opts.buttons?.length
        ? { inline_keyboard: [opts.buttons.map((b) => ({ text: b.text, callback_data: b.callbackData }))] }
        : undefined,
    });
    return sent.message_id;
  }

  /**
   * Send a rich message: Telegram's block format, which is the only way to get a
   * real table. Blocks are passed through as given.
   */
  async sendRichMessage(
    chatId: string,
    blocks: unknown[],
    opts: { replyToId?: number; silent?: boolean } = {}
  ): Promise<number> {
    const sent = await this.call<any>('sendRichMessage', {
      chat_id: chatId,
      rich_message: { blocks },
      reply_parameters: opts.replyToId ? { message_id: opts.replyToId } : undefined,
      link_preview_options: { is_disabled: true },
    });
    return sent.message_id;
  }

  /**
   * React to a message, e.g. 👀 to show it has been picked up.
   *
   * Telegram accepts only a fixed set of emoji as reactions; an unsupported one
   * is rejected, so callers stick to the common set.
   */
  async setReaction(chatId: string, messageId: number, emoji: string): Promise<void> {
    await this.call('setMessageReaction', {
      chat_id: chatId,
      message_id: messageId,
      reaction: emoji ? [{ type: 'emoji', emoji }] : [],
    });
  }

  /** Upload an Ogg/Opus file as a voice note. */
  async sendVoice(
    chatId: string,
    oggPath: string,
    opts: { replyToId?: number; caption?: string; threadId?: number } = {},
    uploadTimeoutMs = 120_000
  ): Promise<number> {
    if (this.via !== undefined) {
      if (this.viaVoice === undefined) throw new Error('This transport cannot upload a voice note.');
      const params: Record<string, string | number> = { chat_id: chatId };
      if (opts.threadId !== undefined) params['message_thread_id'] = opts.threadId;
      if (opts.replyToId) params['reply_to_message_id'] = opts.replyToId;
      if (opts.caption) params['caption'] = opts.caption;
      const sent = (await this.viaVoice(params, this.readCapped(oggPath))) as { message_id?: unknown } | null;
      if (typeof sent?.message_id !== 'number') throw new Error('The hub sent the voice note but returned no message id.');
      return sent.message_id;
    }
    return this.upload('sendVoice', 'voice', chatId, oggPath, 'speech.ogg', 'voice note', opts, uploadTimeoutMs);
  }

  /**
   * Upload any file as a document (a PDF, a log, an export), under its own file name.
   *
   * Refused before anything is read or sent when it is over the Bot API's upload cap, so a large file fails
   * with a clear reason instead of a long upload and an opaque 413.
   */
  async sendDocument(
    chatId: string,
    filePath: string,
    opts: { replyToId?: number; caption?: string; silent?: boolean } = {},
    uploadTimeoutMs = 300_000
  ): Promise<number> {
    return this.upload('sendDocument', 'document', chatId, filePath, basename(filePath), 'document', opts, uploadTimeoutMs);
  }

  /** Create a forum topic and return its id (the bot must be an admin with the right to manage topics). */
  async createForumTopic(chatId: string, name: string): Promise<number> {
    const result = await this.call<{ message_thread_id?: unknown }>('createForumTopic', { chat_id: chatId, name });
    const id = result?.message_thread_id;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) throw new Error('Telegram created no topic id.');
    return id;
  }

  /**
   * The file's bytes, read ONCE through one handle and never more than the upload cap plus one byte (Codex
   * review): a size check followed by a separate read let a file that grew in between past the cap, and a huge
   * file was read whole into memory before being refused. Filesystem errors are redacted like every other.
   */
  private readCapped(filePath: string): Buffer {
    let fd: number | undefined;
    try {
      // Non-blocking, so a named pipe with no writer is refused below instead of hanging here before any check
      // or timeout can run. Reads of a regular file are unaffected. (No such flag on Windows: plain read-only.)
      fd = openSync(filePath, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
      if (!fstatSync(fd).isFile()) throw new Error(`${filePath} is not a regular file`);
      const buffer = Buffer.alloc(MAX_BOT_UPLOAD_BYTES + 1);
      let length = 0;
      for (;;) {
        const read = readSync(fd, buffer, length, buffer.length - length, null);
        if (read === 0) break;
        length += read;
        if (length > MAX_BOT_UPLOAD_BYTES) {
          throw new Error(
            `${basename(filePath)} is over ${MAX_BOT_UPLOAD_BYTES / 1_048_576} MB; the Bot API accepts uploads up to `
            + `${MAX_BOT_UPLOAD_BYTES / 1_048_576} MB`,
          );
        }
      }
      return buffer.subarray(0, length);
    } catch (err) {
      throw new Error(this.redact((err as Error).message));
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  /** One multipart upload. The deadline spans the upload and the response body. */
  private async upload(
    method: 'sendVoice' | 'sendDocument',
    field: 'voice' | 'document',
    chatId: string,
    filePath: string,
    fileName: string,
    what: string,
    opts: { replyToId?: number; caption?: string; silent?: boolean; threadId?: number },
    uploadTimeoutMs: number,
  ): Promise<number> {
    // A file never goes with the token when calls are meant to go elsewhere: that would bypass the hub's topic guard.
    if (this.via !== undefined) throw new Error(`This transport cannot upload a ${what}.`);
    const form = new FormData();
    form.append('chat_id', chatId);
    if (opts.threadId !== undefined) form.append('message_thread_id', String(opts.threadId));
    form.append(field, new Blob([this.readCapped(filePath)]), fileName);
    if (opts.caption) form.append('caption', opts.caption);
    if (opts.replyToId) form.append('reply_to_message_id', String(opts.replyToId));
    if (opts.silent) form.append('disable_notification', 'true');

    // The deadline spans the upload and the response body: a stall in either
    // would otherwise hold the caller open past every other timeout, keeping the
    // temp directory alive with it.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), uploadTimeoutMs);

    let payload: ApiResponse<any>;
    try {
      const response = await fetch(`${API_ROOT}/bot${this.token}/${method}`, {
        method: 'POST',
        body: form,
        signal: controller.signal,
      });
      payload = (await response.json().catch(() => ({ ok: false, description: `HTTP ${response.status}` }))) as ApiResponse<any>;
    } catch (err) {
      const message = (err as Error).name === 'AbortError'
        ? `Uploading the ${what} timed out after ${Math.round(uploadTimeoutMs / 1000)}s`
        : `Uploading the ${what} failed: ${(err as Error).message}`;
      throw new Error(this.redact(message));
    } finally {
      clearTimeout(timer);
    }

    if (!payload.ok) {
      throw new Error(this.redact(`Telegram Bot API ${method}: ${payload.description ?? 'failed'}`));
    }
    return payload.result.message_id;
  }

  /**
   * Remove a message's inline keyboard.
   *
   * Used to take a button away the instant it is pressed, so it cannot be
   * pressed again while the work it started is still running.
   */
  async clearButtons(chatId: string, messageId: number): Promise<void> {
    await this.call('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    });
  }

  /** Put an inline keyboard (one row) back on a message, e.g. a Listen button whose press could not be finished. */
  async setButtons(chatId: string, messageId: number, buttons: { text: string; callbackData: string }[]): Promise<void> {
    await this.call('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [buttons.map((b) => ({ text: b.text, callback_data: b.callbackData }))] },
    });
  }

  /**
   * Stop the spinner on a pressed button. Telegram shows it until this is
   * answered, so a slow job must answer first and deliver afterwards.
   */
  async answerCallback(callbackQueryId: string, text?: string): Promise<void> {
    await this.call('answerCallbackQuery', { callback_query_id: callbackQueryId, text });
  }

  /**
   * Show "typing…" in the chat.
   *
   * Telegram clears the indicator after about five seconds, so a caller that
   * wants it to persist has to repeat the call — see `keepTyping`.
   */
  async sendTyping(chatId: string, threadId?: number): Promise<void> {
    await this.call('sendChatAction', { chat_id: chatId, action: 'typing', message_thread_id: threadId });
  }

  /**
   * Hold "typing…" in a chat for `seconds`, refreshing before each expiry.
   * Resolves when the time is up. Failures are ignored: an indicator is a
   * courtesy and must never break the work it is decorating.
   */
  async keepTyping(chatId: string, seconds: number): Promise<void> {
    const deadline = Date.now() + seconds * 1000;

    while (Date.now() < deadline) {
      try {
        await this.sendTyping(chatId);
      } catch {
        return;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      await new Promise((resolve) => setTimeout(resolve, Math.min(4000, remaining)));
    }
  }

  /**
   * Download a file by id into `destDir`, returning the local path. Used for
   * voice notes so they can go through the same transcription cache as the
   * user-client path.
   */
  async downloadFile(fileId: string, destDir: string, downloadTimeoutMs = 120_000): Promise<string> {
    const file = await this.call<any>('getFile', { file_id: fileId });

    if (!file.file_path) {
      throw new Error(`Telegram returned no path for file ${fileId}`);
    }
    if (file.file_size && file.file_size > MAX_BOT_DOWNLOAD_BYTES) {
      throw new Error(
        `File is ${(file.file_size / (1024 * 1024)).toFixed(1)} MB; the Bot API caps downloads at 20 MB.`
      );
    }

    // Keep Telegram's extension so the transcriber can tell the container type.
    const extension = file.file_path.includes('.') ? file.file_path.slice(file.file_path.lastIndexOf('.')) : '.bin';
    const target = join(destDir, `${fileId.slice(0, 32).replace(/[^A-Za-z0-9_-]/g, '_')}${extension}`);

    mkdirSync(dirname(target), { recursive: true });

    // A stalled download would otherwise hold a whole watcher batch forever,
    // because transcription runs before the batch is logged and emitted.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), downloadTimeoutMs);

    try {
      const response = await fetch(`${API_ROOT}/file/bot${this.token}/${file.file_path}`, {
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(this.redact(`Downloading ${fileId} failed: HTTP ${response.status}`));
      }

      // Stream to disk: a 20MB buffer in memory is avoidable.
      await pipeline(Readable.fromWeb(response.body as any), createWriteStream(target));
      return target;
    } catch (err) {
      const message = (err as Error).name === 'AbortError'
        ? `Downloading ${fileId} timed out after ${Math.round(downloadTimeoutMs / 1000)}s`
        : `Downloading ${fileId} failed: ${(err as Error).message}`;
      throw new Error(this.redact(message));
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// Local state: the confirmed offset, and a log of what was received
// ---------------------------------------------------------------------------

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_');
}

export function botStateDir(stateName: string): string {
  return join(getConfigDir(), 'telegram-bot', safeName(stateName));
}

export function botOffsetPath(stateName: string): string {
  return join(botStateDir(stateName), 'offset.json');
}

/**
 * A running `bot watch` stamps this after every poll Telegram answered, so a sender can tell a watcher that is
 * actually receiving from one that is alive but failing (a revoked token, an outage) before it attaches a Listen
 * button only that watcher could answer (bot-watch-presence.ts).
 */
export function recordWatchHeartbeat(
  stateName: string,
  botId: number | undefined,
  freshForMs?: number,
  ok: boolean | 'polling' = true
): void {
  try {
    const dir = botStateDir(stateName);
    mkdirSync(dir, { recursive: true });
    // One file per process (alive-<pid>.json): two watchers on one state must not overwrite each other's status,
    // and a file an earlier watcher left behind is simply not this one's (Codex review). `ok: false` after a failed
    // poll withdraws it at once instead of letting the last good stamp run out its window.
    writeFileSync(
      join(dir, `alive-${process.pid}.json`),
      JSON.stringify({ at: Date.now(), botId, pid: process.pid, startTime: processStartTime(process.pid), ok, ...(freshForMs === undefined ? {} : { freshForMs }) }),
      { mode: 0o600 }
    );
    pruneHeartbeats(dir);
  } catch {
    // A courtesy for senders: never a reason to stop watching.
  }
}

/** Heartbeat files of watchers gone more than a day: they would otherwise pile up, one per restart. */
function pruneHeartbeats(dir: string): void {
  const cutoff = Date.now() - 24 * 60 * 60_000;
  try {
    for (const name of readdirSync(dir)) {
      if (!/^alive(-\d+)?\.json$/.test(name)) continue;
      const path = join(dir, name);
      if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
    }
  } catch {
    // Housekeeping only.
  }
}

/** One JSON object per line, appended as updates arrive. */
export function botLogPath(stateName: string): string {
  return join(botStateDir(stateName), 'messages.jsonl');
}

/**
 * Read the confirmed offset for a state.
 *
 * `botName` guards against two bots sharing a state. Offsets are per-bot queues,
 * so submitting one bot's offset to another's `getUpdates` confirms updates that
 * were never seen — messages Telegram then never resends. A mismatch is a
 * configuration mistake, so it throws rather than quietly re-baselining.
 *
 * An entry written before offsets carried a bot name is accepted and adopted, so
 * an existing watcher keeps its place.
 */
/** Who a state namespace belongs to. `id` is the real Telegram bot id. */
export interface StateOwner {
  name: string;
  id?: number;
}

interface StoredState {
  offset?: unknown;
  bot?: unknown;
  botId?: unknown;
}

function readState(stateName: string): StoredState | null {
  const path = botOffsetPath(stateName);
  if (!existsSync(path)) return null;

  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as StoredState;
  } catch {
    return null;
  }
}

/**
 * Fail unless `owner` may use this state namespace.
 *
 * Identity is the bot **id** where known, not the configured name: swapping the
 * token behind a name would otherwise pass, and submitting the old offset to the
 * new bot's queue permanently confirms updates it never saw. The name is only a
 * fallback for state written before ids were recorded.
 *
 * A namespace with no recorded owner is refused rather than adopted: an offset
 * from some other bot is indistinguishable from one of ours, and using it would
 * skip real messages. `adopt` is the explicit opt-in.
 */
export function assertStateOwnership(
  stateName: string,
  owner: StateOwner,
  opts: { adopt?: boolean } = {}
): void {
  const state = readState(stateName);
  if (!state) return;

  const storedId = typeof state.botId === 'number' ? state.botId : undefined;
  const storedName = typeof state.bot === 'string' ? state.bot : undefined;

  if (storedId !== undefined && owner.id !== undefined) {
    if (storedId !== owner.id) throw new BotStateConflictError(stateName, String(storedName ?? storedId), owner.name);
    return;
  }

  if (storedName !== undefined) {
    if (storedName.toLowerCase() !== owner.name.toLowerCase()) {
      throw new BotStateConflictError(stateName, storedName, owner.name);
    }
    return;
  }

  // Unowned state that already holds an offset.
  if (typeof state.offset === 'number' && !opts.adopt) {
    throw new BotStateAdoptionError(stateName, owner.name);
  }
}

export function loadBotOffset(
  stateName: string,
  owner?: StateOwner,
  opts: { adopt?: boolean } = {}
): number | null {
  const path = botOffsetPath(stateName);
  if (!existsSync(path)) return null;

  if (owner) assertStateOwnership(stateName, owner, opts);

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as StoredState;
    const offset = parsed.offset;

    // A negative offset has destructive queue-tail semantics in the Bot API, and
    // a fractional one is meaningless, so anything but a positive integer is
    // treated as corrupt rather than passed through.
    if (typeof offset !== 'number' || !Number.isInteger(offset) || offset <= 0) return null;
    return offset;
  } catch (err) {
    // A cross-bot collision is a real misconfiguration and must surface.
    if (err instanceof BotStateConflictError || err instanceof BotStateAdoptionError) throw err;
    // A corrupt offset must not wedge the watcher; re-baseline instead.
    return null;
  }
}

/**
 * Record ownership before polling, so two bots racing for an unused namespace
 * cannot both proceed. Checking without claiming left exactly that gap.
 */
export function claimBotState(stateName: string, owner: StateOwner, opts: { adopt?: boolean } = {}): void {
  const path = botOffsetPath(stateName);
  mkdirSync(dirname(path), { recursive: true });

  const stamp = JSON.stringify({ bot: owner.name, botId: owner.id });

  // Claiming an unused namespace has to be atomic, or two watchers can both
  // pass the check and the loser then adopts the winner's offset — confirming
  // updates it never saw. `wx` fails if the file exists, and that failure is the
  // exclusion: whoever creates it owns the namespace.
  try {
    writeFileSync(path, stamp, { flag: 'wx', mode: 0o600 });
    return;
  } catch (err: any) {
    if (err?.code !== 'EEXIST') throw err;
  }

  // It already existed — either ours from a previous run, or someone else's.
  assertStateOwnership(stateName, owner, opts);

  const existing = readState(stateName);
  writeFileSync(
    path,
    JSON.stringify({
      offset: typeof existing?.offset === 'number' ? existing.offset : undefined,
      bot: owner.name,
      botId: owner.id,
    }),
    { mode: 0o600 }
  );
}

/**
 * Park the text behind a button.
 *
 * `callback_data` is limited to 64 bytes, so the button carries a short key and
 * the text lives here. Stored beside the watcher's state so a restart can still
 * answer a button pressed before it went down.
 */
/**
 * Everything the bot has said, keyed by message id under the BOT's name.
 *
 * The Bot API never returns a bot its own messages, so this is the only record
 * of them. Keyed by bot rather than by watch state on purpose: the stash used to
 * live under `--state`, which the sender and the watcher had to agree on, and
 * when they did not the button resolved to nothing and the message could never
 * be read aloud.
 */
export function sentMessagePath(botName: string, chatId: string, messageId: number): string {
  // Chat id is part of the key, not decoration: Telegram message ids are unique
  // within a chat, not across a bot. Keying on the id alone let message 121 in
  // one chat overwrite message 121 in another, and a Listen button then read
  // somebody else's text aloud.
  return join(
    getConfigDir(),
    'telegram-bot',
    '_sent',
    safeName(botName),
    safeName(chatId),
    `${messageId}.json`
  );
}

export function recordSentMessage(
  botName: string,
  chatId: string,
  messageId: number,
  text: string,
  format: SpeakableFormat,
  /**
   * Sent through the hub, which records who sent it, so a Listen press on it can be routed back. `null` keeps it
   * unknown (an edit of a message whose origin this machine cannot tell): never downgraded to false (Codex review).
   */
  viaHub: boolean | null = false,
  /**
   * True when this machine SENT the message (send/reply); an edit passes null and keeps what the record already
   * said, or false when there was none - an edit is not authorship (Codex review).
   */
  authored: boolean | null = true
): void {
  const path = sentMessagePath(botName, chatId, messageId);
  try {
    mkdirSync(dirname(path), { recursive: true });
    if (authored === null) authored = sentHere(botName, chatId, messageId);
    // Written as true or false whenever it is known, so a reader can tell "sent locally" from a record older than
    // the field; left out when unknown, which reads back as unknown.
    writeFileSync(path, JSON.stringify({ text, format, at: Date.now(), authored, ...(viaHub === null ? {} : { viaHub }) }), { mode: 0o600 });
    pruneSpeakables(dirname(path));
  } catch {
    // A message that cannot be recorded still sends; it just cannot be replayed.
  }
}

export function readSentMessage(botName: string, chatId: string, messageId: number): SpeakableText | null {
  if (!Number.isInteger(messageId) || messageId <= 0) return null;

  try {
    const path = sentMessagePath(botName, chatId, messageId);
    if (!existsSync(path)) return null;

    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<SpeakableText>;
    if (typeof parsed.text !== 'string') return null;

    const format = parsed.format;
    return { text: parsed.text, format: format === 'plain' || format === 'html' ? format : 'auto' };
  } catch {
    return null;
  }
}

/**
 * Whether this machine sent the message through the hub (and so the hub knows who to hand its Listen press to).
 * `null` when it cannot be known here: no record (pruned after seven days, or sent elsewhere), or a record written
 * before the field existed. Missing metadata is not proof of a local send (Codex review).
 */
export function sentViaHub(botName: string, chatId: string, messageId: number): boolean | null {
  if (!Number.isInteger(messageId) || messageId <= 0) return null;
  try {
    const path = sentMessagePath(botName, chatId, messageId);
    if (!existsSync(path)) return null;
    const viaHub = (JSON.parse(readFileSync(path, 'utf-8')) as { viaHub?: unknown }).viaHub;
    return typeof viaHub === 'boolean' ? viaHub : null;
  } catch {
    return null;
  }
}

/**
 * Whether this machine originally sent the message (its record says `authored: true`). A record written by an edit,
 * or one older than the field, is not proof: false.
 */
export function sentHere(botName: string, chatId: string, messageId: number): boolean {
  if (!Number.isInteger(messageId) || messageId <= 0) return false;
  try {
    const path = sentMessagePath(botName, chatId, messageId);
    if (!existsSync(path)) return false;
    return (JSON.parse(readFileSync(path, 'utf-8')) as { authored?: unknown }).authored === true;
  } catch {
    return false;
  }
}

export type SpeakableFormat = 'auto' | 'plain' | 'html' | 'rich';

export interface SpeakableText {
  text: string;
  /** How the text was sent, so it is normalised the same way before speaking. */
  format: SpeakableFormat;
}

/** Entries older than this are swept when a new one is written. */
const SPEAK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function stashSpeakableText(stateName: string, text: string, format: SpeakableFormat = 'auto'): string {
  // The format is part of the identity: the same source spoken as plain and as
  // markdown are different readings.
  const key = createHash('sha256').update(`${format}\u0000${text}`).digest('hex').slice(0, 24);
  const dir = join(botStateDir(stateName), 'speak');

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${key}.json`), JSON.stringify({ text, format }), { mode: 0o600 });

  pruneSpeakables(dir);
  return key;
}

export function readSpeakableText(stateName: string, key: string): SpeakableText | null {
  // The key comes back from Telegram, so it must not be able to escape the dir.
  if (!/^[0-9a-f]{1,64}$/.test(key)) return null;

  const dir = join(botStateDir(stateName), 'speak');

  try {
    const file = join(dir, `${key}.json`);
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<SpeakableText>;
      if (typeof parsed.text !== 'string') return null;
      const format = parsed.format;
      return {
        text: parsed.text,
        format: format === 'plain' || format === 'html' ? format : 'auto',
      };
    }

    // Entries written before the format was recorded.
    const legacy = join(dir, `${key}.txt`);
    if (existsSync(legacy)) return { text: readFileSync(legacy, 'utf-8'), format: 'auto' };
  } catch {
    return null;
  }

  return null;
}

/** Keep the stash bounded: it holds message text indefinitely otherwise. */
function pruneSpeakables(dir: string): void {
  try {
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      try {
        if (Date.now() - statSync(file).mtimeMs > SPEAK_MAX_AGE_MS) unlinkSync(file);
      } catch {
        // Vanished, or not ours to remove.
      }
    }
  } catch {
    // Pruning is opportunistic; failing it must not fail the send.
  }
}

/** Thrown when a state namespace has no recorded owner and adoption was not requested. */
export class BotStateAdoptionError extends Error {
  constructor(stateName: string, requested: string) {
    super(
      `State "${stateName}" holds an offset but records no owner, so it cannot be assumed to be "${requested}"'s.\n` +
      'Using another bot\'s offset would skip messages permanently.\n' +
      'Pass --adopt-state to claim it, or use a different --state (it defaults to the bot name).'
    );
    this.name = 'BotStateAdoptionError';
  }
}

/** Thrown when a state file belongs to a different bot than the caller. */
export class BotStateConflictError extends Error {
  constructor(stateName: string, owner: string, requested: string) {
    super(
      `State "${stateName}" already belongs to bot "${owner}", but "${requested}" tried to use it.\n` +
      'Offsets are per-bot queues, so sharing one would confirm messages the other never saw.\n' +
      `Use a different --state for "${requested}" (it defaults to the bot name).`
    );
    this.name = 'BotStateConflictError';
  }
}

export function saveBotOffset(stateName: string, offset: number, owner?: StateOwner): void {
  const path = botOffsetPath(stateName);
  mkdirSync(dirname(path), { recursive: true });
  // Stamping the owner is what makes a collision detectable later.
  writeFileSync(path, JSON.stringify({ offset, bot: owner?.name, botId: owner?.id }), { mode: 0o600 });
}

/**
 * Append received updates to the local log. This is the only record that
 * survives: once the offset moves past an update, Telegram will never send it
 * again, so a failure to log is worth reporting rather than swallowing.
 */
/**
 * Append received updates to the local log, durably.
 *
 * This is the only record that survives: once the offset moves past an update,
 * Telegram will never send it again. So this throws on failure — the caller must
 * not confirm a batch it could not write down — and it fsyncs, because a file
 * the OS has not flushed is not a record that survives a crash.
 */
export function appendBotLog(stateName: string, updates: BotUpdate[]): void {
  if (updates.length === 0) return;

  const path = botLogPath(stateName);
  mkdirSync(dirname(path), { recursive: true });

  const lines = updates.map((u) => JSON.stringify({ ...u, date: u.date.toISOString() })).join('\n');

  const fd = openSync(path, 'a');
  try {
    // A crash can leave a previous record truncated mid-object with no trailing
    // newline. Appending straight onto it would fuse the fragment with the next
    // record, producing one unparseable line — and silently losing a real
    // message that Telegram will never resend. Terminate the fragment first.
    if (fstatSync(fd).size > 0 && !endsWithNewline(path)) {
      writeAll(fd, '\n');
    }

    writeAll(fd, `${lines}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Write every byte, or throw.
 *
 * `writeSync` may write only a prefix — most plausibly when the disk is nearly
 * full, which is exactly when this matters. Returning as if it succeeded would
 * let the watcher confirm updates whose records were only partly stored, and
 * Telegram never resends a confirmed update.
 */
export function writeAll(
  fd: number,
  text: string,
  // Injectable so a test can force the short-write case; `fs.writeSync` cannot be
  // patched on an ESM namespace object.
  write: (fd: number, buffer: Buffer, offset: number, length: number) => number = writeSync
): void {
  const buffer = Buffer.from(text, 'utf-8');
  let written = 0;

  while (written < buffer.length) {
    const n = write(fd, buffer, written, buffer.length - written);
    if (n <= 0) {
      throw new Error(`Short write to the message log: ${written}/${buffer.length} bytes`);
    }
    written += n;
  }
}

/** Read just the final byte, rather than the whole log, to test for a torn tail. */
function endsWithNewline(path: string): boolean {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return true;

    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] === 0x0a;
  } finally {
    closeSync(fd);
  }
}

/**
 * Read back logged updates, newest last.
 *
 * `chatId` filters *before* `limit` is applied: filtering afterwards would let a
 * busy chat hide every older message in the requested one, even though the log
 * still holds them.
 */
export function readBotLog(stateName: string, limit: number, chatId?: string): BotUpdate[] {
  const path = botLogPath(stateName);
  if (!existsSync(path)) return [];

  let lines: string[];
  try {
    lines = readFileSync(path, 'utf-8').split('\n').filter((l) => l.trim().length > 0);
  } catch {
    return [];
  }

  const parsed: BotUpdate[] = [];
  for (const line of lines) {
    try {
      const raw = JSON.parse(line);
      if (chatId !== undefined && String(raw.chatId) !== chatId) continue;
      parsed.push({ ...raw, date: new Date(raw.date) });
    } catch {
      // Skip a torn line rather than failing the whole read.
    }
  }

  return parsed.slice(-limit);
}
