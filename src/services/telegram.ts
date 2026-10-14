// Telegram client service using GramJS

import './telegram-schema.js'; // must precede the telegram package
import { TelegramClient, Api } from 'telegram';
import { resolvePeer, rememberClientSession, peerId, assertMessagePeer, parseMessageId } from './telegram-peer.js';
import {
  messageText,
  exportedText,
  type ExportTextFormat,
  extractTimeTokens,
  locateDates,
  formatToFlags,
  expandTimeTokensForRich,
  prepareRichMarkdown,
  RICH_MESSAGE_MAX_CHARS,
  type DateFlags,
} from './telegram-rich.js';
import { _parseMessageText } from 'telegram/client/messageParse.js';
import { generateRandomBigInt } from 'telegram/Helpers.js';
import { firstLineOf, topicOfReplyHeader, type PinnedMessage } from './telegram-pins.js';
import { StringSession } from 'telegram/sessions/index.js';
import { Logger, LogLevel } from 'telegram/extensions/Logger.js';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, extname, basename } from 'path';
import type { TelegramConfig } from '../config/types.js';
import { acquireTelegramLock, releaseTelegramLock } from '../utils/file-lock.js';
import { getMediaDir, getMediaTypeDir } from '../config/paths.js';

/** Values of a GramJS internal collection that may be a Map or a plain object. */
function collectionValues(collection: unknown): unknown[] {
  if (collection instanceof Map) return [...collection.values()];
  if (collection && typeof collection === 'object') return Object.values(collection);
  return [];
}

/**
 * Clear the 30s release timers GramJS sets for the per-DC senders that
 * sendFile() borrows. Its own cleanup reads these Maps with Object.values(),
 * which yields [] for a Map, so the timers leak and hold the event loop open.
 */
function clearExportedSenderTimers(client: unknown): void {
  const { _exportedSenderReleaseTimeouts } = client as { _exportedSenderReleaseTimeouts?: unknown };

  for (const entry of collectionValues(_exportedSenderReleaseTimeouts)) {
    // An entry is either a bare timer or a { [dcId]: timer } group.
    if (typeof (entry as NodeJS.Timeout)?.unref === 'function') {
      clearTimeout(entry as NodeJS.Timeout);
      continue;
    }
    for (const timer of collectionValues(entry)) clearTimeout(timer as NodeJS.Timeout);
  }
}

interface Disconnectable {
  disconnect: () => Promise<void>;
}

/**
 * Snapshot the entries of the exported-sender map SYNCHRONOUSLY. This must run
 * before destroy(), which empties the map while leaving the senders connected.
 * Entries may be a sender, a promise of one, or a { [dcId]: sender|promise }
 * group — we keep them raw here and resolve later, so a still-pending sender is
 * never lost to a timed-out await before the snapshot is even taken.
 */
function snapshotExportedSenderEntries(client: unknown): unknown[] {
  const { _exportedSenderPromises } = client as { _exportedSenderPromises?: unknown };

  return collectionValues(_exportedSenderPromises).flatMap((entry) =>
    // A value is a sender/sender-promise, or a { [dcId]: sender|promise } group.
    isThenable(entry) || isDisconnectable(entry) ? [entry] : collectionValues(entry)
  );
}

/** Resolve snapshotted entries (awaiting any promises) to closable senders. */
async function resolveSenders(entries: unknown[]): Promise<Disconnectable[]> {
  const resolved = await Promise.all(
    entries.map((entry) => (isThenable(entry) ? entry : Promise.resolve(entry)))
  );
  return resolved.filter(isDisconnectable);
}

function isThenable(value: unknown): value is Promise<unknown> {
  return typeof (value as Promise<unknown>)?.then === 'function';
}

function isDisconnectable(value: unknown): value is Disconnectable {
  return typeof (value as Disconnectable)?.disconnect === 'function';
}

/** Reject after `ms` so a hung network teardown can't stall the process. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
      timer.unref();
    }),
  ]);
}

export interface ReactionUser {
  id: string;
  firstName?: string;
  lastName?: string;
  username?: string;
}

export interface ReactionInfo {
  emoji: string;
  count: number;
  users?: ReactionUser[]; // Users who reacted (fetched separately via getMessageReactionsList)
}

export interface MessageEntity {
  type: 'url' | 'text_url' | 'mention' | 'bold' | 'italic' | 'code' | 'pre' | 'hashtag' | 'other';
  offset: number;
  length: number;
  url?: string;  // For text_url type
  text?: string; // The actual text at this entity position
}

export interface MuteStatus {
  muted: boolean;
  forever?: boolean;
  until?: Date;
}

export interface ForumTopic {
  id: number;
  title: string;
  unreadCount: number;
  unreadMentionsCount: number;
  isMuted: boolean;
  mutedForever?: boolean;
  mutedUntil?: Date;
  iconColor?: number;
  iconEmoji?: string;
  messages: TelegramMessage[];
}

export interface UnreadChat {
  id: string | number;
  title: string;
  unreadCount: number;
  unreadMentionsCount: number;
  isMuted: boolean;
  mutedForever?: boolean;
  mutedUntil?: Date;
  isArchived: boolean;
  isChannel: boolean;
  isGroup: boolean;
  isUser: boolean;
  isForum: boolean;  // Forum groups with topics (aggregate unread from topics)
  forumTopics?: ForumTopic[];  // Topics with unread messages (if forum)
  messages: TelegramMessage[];
}

export interface TelegramMessage {
  id: number;
  date: Date;
  sender: string;
  text: string;
  chatId?: string | number;
  chatTitle?: string;
  reactions?: ReactionInfo[]; // Emoji reactions with counts
  entities?: MessageEntity[]; // Message entities (URLs, mentions, formatting)
  hasMedia?: boolean;
  mediaType?: MediaType;
  mediaClassName?: string;
  mediaSize?: number;
  mediaFilename?: string;
  /** Audio/video/voice length in seconds, when Telegram reports one. */
  mediaDuration?: number;
  /** Speech-to-text of a voice/audio message, filled in by the read path. */
  transcript?: string;
  /** Why there is no `transcript`, when the clip was skipped rather than attempted. */
  transcriptSkipped?: string;
  /** True when this account sent the message. */
  outgoing?: boolean;
  replyToPeerId?: string;
  replyToId?: number; // Message ID this is replying to
  replyToText?: string; // Text of the replied-to message (if available)
  replyToSender?: string; // Sender of the replied-to message (if available)
  editDate?: Date; // Set when the message was edited
}

export interface ResolvedChat {
  inputEntity: Api.TypeInputPeer;
  id: string | number;
  title: string;
  username?: string;
  type: 'user' | 'group' | 'channel' | 'supergroup';
}

export interface TelegramExportMessage {
  replyToPeerId?: string;
  id: number;
  chatId: string;
  chatTitle: string;
  chatUsername: string | null;
  date: string;
  editDate: string | null;
  sender: string;
  text: string;
  /** Where `text` came from; `rich-unreadable` and `none` are how an empty `text` is told apart (telegram-rich.ts). */
  textFormat: ExportTextFormat;
  groupedId: string | null;
  replyToId: number | null;
  hasMedia: boolean;
  mediaType: MediaType | null;
  mediaClassName: string | null;
  mediaSize: number | null;
  mediaFilename: string | null;
  entities: MessageEntity[];
  link: string;
}

export interface TelegramExportChat {
  id: string;
  title: string;
  username: string | null;
  type: ResolvedChat['type'];
}

export interface TelegramParticipant {
  id: string;
  firstName?: string;
  lastName?: string;
  username?: string;
  phone?: string;
  isBot: boolean;
  isVerified: boolean;
  isPremium: boolean;
}

export interface TelegramContact {
  id: string;
  accessHash?: string;
  firstName?: string;
  lastName?: string;
  username?: string;
  phone?: string;
  isMutualContact: boolean;
}

export type MediaType = 'photo' | 'video' | 'document' | 'voice' | 'sticker' | 'audio' | 'gif' | 'unsupported';

export interface MediaInfo {
  chatId?: string;
  messageId?: number;
  type: MediaType;
  extension: string;
  size?: number;
  filename?: string;
  width?: number;
  height?: number;
  duration?: number;
  mimeType?: string;
}

export interface DownloadResult {
  chatId: string;
  messageId: number;
  filepath: string;
  type: MediaType;
  size: number;
  filename: string;
}

export interface MediaMessage {
  messageId: number;
  mediaInfo: MediaInfo;
  date: Date;
  sender: string;
  chatId: string | number;
  chatTitle: string;
  text?: string;
  groupedId?: string;
}

export interface MediaGroup {
  groupedId: string;
  messages: MediaMessage[];
  date: Date;
  sender: string;
  chatId: string | number;
  chatTitle: string;
  text?: string;
}

interface DialogCacheEntry {
  inputEntity: Api.TypeInputPeer;
  entity: any;
  title: string;
  id: string;
}

/**
 * Make literal text safe for GramJS's `md2` parse mode.
 *
 * That parser converts markdown to HTML and then runs an HTML parser over the
 * result, so any `<placeholder>` in ordinary prose is read as a tag and silently
 * dropped — including inside backticks, because the code-span conversion happens
 * first and leaves the angle brackets raw. Every command example with a
 * placeholder has been arriving with the placeholder missing.
 *
 * Escaping the three HTML-significant characters leaves the markdown markers
 * untouched, so formatting still works and the brackets survive as text.
 */
export function escapeForMarkdownV2(text: string): string {
  return protectCode(text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;'));
}

/**
 * Code must arrive exactly as written, and the md2 parser does not leave it
 * alone: it runs bold, underline, strikethrough and spoiler over the WHOLE
 * text, code included, before it marks code. So `scp ~/.ssh/id ~/.kube/config`
 * arrived as `scp /.ssh/id /.kube/config` and `ls *.ts *.js` as `ls .ts .js`,
 * fenced or not (2026-10-06, a setup command sent to a developer).
 *
 * Inside a fence or a code span, each character any of those rules reads is
 * written as a numeric entity, which the HTML pass turns back into the
 * character after the markdown rules have run. Segments are found the way the
 * parser finds them: every fence first, then inline code with its exact
 * pattern in the text between fences. Prose keeps its markdown. One case is
 * left: an inline span wrapped around a whole fence is not protected outside
 * the fence, since nobody writes one. `-` is included although our postinstall
 * patch disables upstream's -italic- rule: that patch is skipped by
 * --ignore-scripts and may not survive a GramJS upgrade (Codex review).
 */
function protectCode(text: string): string {
  const literal = (body: string) => body.replace(/[*_~|\[\]!`-]/g, (c) => `&#${c.charCodeAt(0)};`);
  return text
    .split(/(```[\s\S]*?```)/)
    .map((part, i) => i % 2 === 1
      ? '```' + literal(part.slice(3, -3)) + '```'
      : part.replace(/`(.*?)`/g, (_m, body: string) => '`' + literal(body) + '`'))
    .join('');
}

/**
 * Layer-229 constructors. GramJS's typings are generated for layer 198, so the
 * classes telegram-schema.ts adds at runtime are reached through this view.
 */
const RichApi = Api as unknown as {
  InputRichMessageMarkdown: new (args: { markdown: string }) => unknown;
  MessageEntityFormattedDate: new (args: { offset: number; length: number; date: number } & DateFlags) => Api.TypeMessageEntity;
  messages: {
    SendMessage: new (args: Record<string, unknown>) => Api.AnyRequest;
    EditMessage: new (args: Record<string, unknown>) => Api.AnyRequest;
  };
};

/**
 * The id of the message a raw send created. Private chats answer with a short
 * update, everything else with an update list that maps our random id to it.
 * Returns 0 when Telegram gave no id - the message was still sent.
 */
function sentMessageId(result: any, randomId: { toString(): string }): number {
  if (result?.className === 'UpdateShortSentMessage') return result.id;
  const updates: any[] = result?.updates ?? [];
  const mapped = updates.find((u) => u.className === 'UpdateMessageID' && u.randomId?.toString() === randomId.toString());
  if (mapped) return mapped.id;
  const created = updates.find((u) => u.className === 'UpdateNewMessage' || u.className === 'UpdateNewChannelMessage');
  return created?.message?.id ?? 0;
}

function assertRichSize(markdown: string): void {
  if (markdown.length > RICH_MESSAGE_MAX_CHARS) {
    throw new Error(`Rich message is ${markdown.length} characters; Telegram allows ${RICH_MESSAGE_MAX_CHARS}. Split it or upload it as a file.`);
  }
}

export class TelegramService {
  private client: TelegramClient | null = null;
  private config: TelegramConfig;
  private dialogCache: Map<string, DialogCacheEntry> = new Map();
  private dialogCachePopulated: boolean = false;

  constructor(config: TelegramConfig) {
    this.config = config;
  }

  /**
   * Extract entities from a Telegram message
   */
  private extractEntities(msg: any): MessageEntity[] | undefined {
    const entities: MessageEntity[] = [];
    const msgEntities = msg.entities as any[] | undefined;
    const text = msg.message as string;

    if (!msgEntities || msgEntities.length === 0) {
      return undefined;
    }

    for (const entity of msgEntities) {
      const offset = entity.offset as number;
      const length = entity.length as number;
      const entityText = text.substring(offset, offset + length);

      let type: MessageEntity['type'] = 'other';
      let url: string | undefined;

      switch (entity.className) {
        case 'MessageEntityUrl':
          type = 'url';
          url = entityText; // The URL is in the text itself
          break;
        case 'MessageEntityTextUrl':
          type = 'text_url';
          url = entity.url; // Hidden URL
          break;
        case 'MessageEntityMention':
          type = 'mention';
          break;
        case 'MessageEntityBold':
          type = 'bold';
          break;
        case 'MessageEntityItalic':
          type = 'italic';
          break;
        case 'MessageEntityCode':
          type = 'code';
          break;
        case 'MessageEntityPre':
          type = 'pre';
          break;
        case 'MessageEntityHashtag':
          type = 'hashtag';
          break;
        default:
          type = 'other';
      }

      entities.push({
        type,
        offset,
        length,
        url,
        text: entityText,
      });
    }

    return entities.length > 0 ? entities : undefined;
  }

  /**
   * Refresh the dialog cache by fetching all dialogs
   */
  private async refreshDialogCache(limit: number = 500): Promise<void> {
    if (!this.client) {
      throw new Error('Telegram client not connected');
    }

    this.dialogCache.clear();
    const dialogs = await this.client.getDialogs({ limit });

    for (const dialog of dialogs) {
      const entity = dialog.entity as any;
      const id = entity ? peerId(entity) : '';
      if (!id) continue;

      this.dialogCache.set(id, {
        inputEntity: dialog.inputEntity,
        entity,
        title: dialog.title || entity?.firstName || entity?.username || 'Unknown',
        id,
      });
    }

    this.dialogCachePopulated = true;
  }

  /**
   * Resolve a chat identifier to an InputPeer entity
   * @param identifier - Can be:
   *   - "@username" - By username
   *   - "Chat Title" - By chat title/name (human-readable)
   *   - "1234567890" - Numeric ID as string
   *   - 1234567890 - Numeric ID as number
   *   - "-1001234567890" - Channel/supergroup with -100 prefix
   *   - "me" - Saved messages
   */
  async resolveChat(identifier: string | number | ResolvedChat): Promise<ResolvedChat> {
    if (!this.client) {
      throw new Error('Telegram client not connected');
    }

    return resolvePeer(this.client, identifier);
  }

  async connect(): Promise<void> {
    if (this.client) return;

    // Acquire lock to prevent multiple sessions
    await acquireTelegramLock();

    const session = new StringSession(this.config.sessionString);
    this.client = new TelegramClient(session, this.config.apiId, this.config.apiHash, {
      connectionRetries: 3,
      baseLogger: new Logger(LogLevel.NONE),
    });
    rememberClientSession(this.client, this.config.sessionString);

    await this.client.connect();
  }

  async disconnect(): Promise<void> {
    const client = this.client;
    this.client = null;

    try {
      if (client) {
        // sendFile() borrows a sender per DC to upload chunks in parallel. GramJS
        // is meant to release them, but its cleanup reads the backing Maps with
        // Object.values(), which yields [] for a Map — so the borrowed socket and
        // its 30s release timer survive teardown and hold the event loop open.
        // The CLI printed "Uploaded" and then sat there for ~30s.
        //
        // Teardown is best-effort: a socket stuck mid-reconnect must never wedge
        // the CLI, and the lock release in `finally` has to happen regardless.

        // Snapshot the borrowed senders SYNCHRONOUSLY before destroy() empties
        // the map. Keep them raw (unresolved) so a still-pending sender is not
        // lost to a timed-out await before we even have a handle to it.
        const senderEntries = snapshotExportedSenderEntries(client);

        try {
          clearExportedSenderTimers(client);
          await withTimeout(client.destroy(), 5000);
        } catch {
          // Fall through: closing the borrowed senders is what frees the loop.
        }

        // Close what GramJS left behind, via each sender's own disconnect(): it
        // sets `userDisconnected`, which suppresses auto-reconnect, and unrefs
        // the socket. Destroying the raw socket instead makes GramJS redial and
        // spawn fresh timers, hanging the process longer than the original bug.
        clearExportedSenderTimers(client);
        try {
          const senders = await withTimeout(resolveSenders(senderEntries), 5000);
          await Promise.all(
            senders.map(async (sender) => {
              try {
                await withTimeout(sender.disconnect(), 5000);
              } catch {
                // Ignore: never fail a command that already did its work.
              }
            })
          );
        } catch {
          // A sender that never resolves within the timeout can't be closed by
          // hand; let the process exit anyway rather than wedge on it.
        }
      }
    } finally {
      // Always release the lock, even if teardown throws unexpectedly.
      releaseTelegramLock();
    }
  }

  private buildMessageLink(chat: ResolvedChat, messageId: number): string {
    if (chat.username) {
      const username = chat.username.startsWith('@') ? chat.username.slice(1) : chat.username;
      return `https://t.me/${username}/${messageId}`;
    }
    const rawId = String(chat.id).startsWith('-100')
      ? String(chat.id).slice(4)
      : String(chat.id).replace(/^-/, '');
    return `https://t.me/c/${rawId}/${messageId}`;
  }

  async exportMessagesRange(args: {
    chatId: string | number;
    months?: number;
    from?: Date;
    to?: Date;
    limit?: number;
  }): Promise<{ chat: TelegramExportChat; messages: TelegramExportMessage[] }> {
    if (!this.client) {
      throw new Error('Telegram client not connected');
    }

    const resolved = await this.resolveChat(args.chatId);
    const toDate = args.to ?? new Date();
    const fromDate =
      args.from ??
      new Date(toDate.getTime() - Math.max(1, args.months ?? 1) * 30 * 24 * 60 * 60 * 1000);
    const limit = args.limit ?? Number.POSITIVE_INFINITY;

    const messages: TelegramExportMessage[] = [];
    let offsetId = 0;
    let reachedCutoff = false;

    while (messages.length < limit && !reachedCutoff) {
      const remaining = Number.isFinite(limit) ? Math.max(1, Math.min(100, limit - messages.length)) : 100;
      const batch = await this.client.getMessages(resolved.inputEntity, { limit: remaining, offsetId });
      if (batch.length === 0) break;

      for (const msg of batch) {
        if (!msg.date) continue;

        const msgDate = new Date(msg.date * 1000);
        if (msgDate > toDate) continue;
        if (msgDate < fromDate) {
          reachedCutoff = true;
          break;
        }

        const msgAny = msg as any;
        const sender = msg.sender as any;
        const mediaInfo = msg.media ? this.extractMediaInfo(msg.media) : null;
        const groupedId = msgAny.groupedId?.toString?.() ?? null;
        const replyToId =
          typeof msgAny.replyTo?.replyToMsgId === 'number' ? msgAny.replyTo.replyToMsgId : null;
        const editDate =
          typeof msgAny.editDate === 'number'
            ? new Date(msgAny.editDate * 1000)
            : msgAny.editDate instanceof Date
              ? msgAny.editDate
              : null;

        messages.push({
          id: msg.id,
          chatId: String(resolved.id),
          chatTitle: resolved.title,
          chatUsername: resolved.username ?? null,
          date: msgDate.toISOString(),
          editDate: editDate ? editDate.toISOString() : null,
          sender: sender?.firstName || sender?.username || sender?.title || 'Unknown',
          // A rich send keeps its body in `richMessage.blocks` and leaves `message` empty: reading `message` alone
          // exported every rich message as blank, with nothing to mark it (2026-10-09).
          ...exportedText(msgAny),
          groupedId,
          replyToPeerId: msgAny.replyTo?.replyToPeerId ? peerId(msgAny.replyTo.replyToPeerId) : undefined,
          replyToId,
          hasMedia: Boolean(msg.media),
          mediaType: mediaInfo?.type ?? (msg.media ? 'unsupported' : null),
          mediaClassName: msgAny.media?.className ?? null,
          mediaSize: mediaInfo?.size ?? null,
          mediaFilename: mediaInfo?.filename ?? null,
          entities: this.extractEntities(msg) ?? [],
          link: this.buildMessageLink(resolved, msg.id),
        });
      }

      const last = batch[batch.length - 1];
      if (!last || reachedCutoff) break;
      offsetId = last.id;
      if (batch.length < remaining) break;
    }

    messages.sort((left, right) => {
      if (left.date === right.date) return left.id - right.id;
      return left.date.localeCompare(right.date);
    });

    return {
      chat: {
        id: String(resolved.id),
        title: resolved.title,
        username: resolved.username ?? null,
        type: resolved.type,
      },
      messages,
    };
  }

  /**
   * Get messages from a chat
   * @param chatId - Chat username, ID, title, or "me" for saved messages
   * @param limit - Maximum number of messages
   */
  async getMessages(chatId: string | number | ResolvedChat = 'me', limit: number = 50, opts: { minId?: number; offsetId?: number } = {}): Promise<TelegramMessage[]> {
    if (!this.client) {
      throw new Error('Telegram client not connected');
    }

    const messages: TelegramMessage[] = [];
    // Map to store messages by ID for reply lookups within the batch
    const messageMap = new Map<number, { text: string; sender: string; hasMedia: boolean; mediaType?: string }>();

    try {
      // Resolve the chat to get the proper inputEntity
      const resolved = await this.resolveChat(chatId);
      const result = await this.client.getMessages(resolved.inputEntity, {
        limit,
        ...(opts.minId ? { minId: opts.minId } : {}),
        ...(opts.offsetId ? { offsetId: opts.offsetId } : {}),
      });

      // First pass: build message map for reply lookups
      for (const msg of result) {
        if (messageText(msg) || msg.media) {
          const sender = msg.sender as any;
          const senderName = sender?.firstName || sender?.username || sender?.title || 'Unknown';
          const msgAny = msg as any;
          let mediaType: string | undefined;
          if (msgAny.media) {
            const mediaInfo = this.extractMediaInfo(msgAny.media);
            mediaType = mediaInfo?.type || 'unsupported';
          }
          messageMap.set(msg.id, {
            text: messageText(msg),
            sender: senderName,
            hasMedia: !!msg.media,
            mediaType,
          });
        }
      }

      // Second pass: extract full message info with reply context
      for (const msg of result) {
        // Include messages with text or media
        if (messageText(msg) || msg.media) {
          const sender = msg.sender as any;
          const msgAny = msg as any;

          // Extract reactions if present (with counts)
          const reactions: ReactionInfo[] = [];
          if (msgAny.reactions?.results) {
            for (const r of msgAny.reactions.results) {
              // ReactionEmoji has emoticon (standard emoji like 👍)
              // ReactionCustomEmoji has documentId (premium custom emoji)
              const emoji = r.reaction?.emoticon || (r.reaction?.className === 'ReactionCustomEmoji' ? '⭐' : null);
              if (emoji) {
                reactions.push({ emoji, count: r.count || 1 });
              }
            }
          }

          // Extract entities (URLs, mentions, etc.)
          const entities = this.extractEntities(msg);

          // Extract media info if present
          let hasMedia: boolean | undefined;
          let mediaType: MediaType | undefined;
          let mediaClassName: string | undefined;
          let mediaSize: number | undefined;
          let mediaFilename: string | undefined;
          let mediaDuration: number | undefined;

          if (msg.media) {
            hasMedia = true;
            mediaClassName = (msg as any).media?.className;
            const mediaInfo = this.extractMediaInfo(msg.media);
            if (mediaInfo) {
              mediaType = mediaInfo.type;
              mediaSize = mediaInfo.size;
              mediaFilename = mediaInfo.filename;
              mediaDuration = mediaInfo.duration;
            } else {
              mediaType = 'unsupported';
            }
          }

          // Extract reply info
          let replyToId: number | undefined;
          let replyToText: string | undefined;
          let replyToSender: string | undefined;

          if (msgAny.replyTo?.replyToMsgId) {
            replyToId = msgAny.replyTo.replyToMsgId as number;
            // Try to get reply context from messages in the same batch
            const replyMsg = !msgAny.replyTo?.replyToPeerId || peerId(msgAny.replyTo.replyToPeerId) === peerId(msgAny.peerId) ? messageMap.get(replyToId) : undefined;
            if (replyMsg) {
              replyToSender = replyMsg.sender;
              if (replyMsg.text) {
                replyToText = replyMsg.text;
              } else if (replyMsg.hasMedia && replyMsg.mediaType) {
                replyToText = `[${replyMsg.mediaType}]`;
              }
            }
          }

          messages.push({
            id: msg.id,
            date: new Date(msg.date * 1000),
            sender: sender?.firstName || sender?.username || sender?.title || 'Unknown',
            text: messageText(msg),
            chatId: resolved.id.toString(),  // Use resolved numeric ID for links
            chatTitle: resolved.title,
            reactions: reactions.length > 0 ? reactions : undefined,
            entities,
            hasMedia,
            mediaType,
            mediaClassName,
            mediaSize,
            mediaFilename,
            mediaDuration,
            outgoing: msgAny.out === true,
            replyToPeerId: msgAny.replyTo?.replyToPeerId ? peerId(msgAny.replyTo.replyToPeerId) : undefined,
            replyToId,
            replyToText,
            replyToSender,
            editDate: msgAny.editDate ? new Date(msgAny.editDate * 1000) : undefined,
          });
        }
      }
    } catch (err) {
      throw new Error(`Error fetching messages: ${(err as Error).message}`);
    }

    return messages;
  }

  /**
   * Fetch a single message by ID from the Telegram API
   * Used for on-demand reply chain resolution when message is not in SQLite cache
   */
  async getContextById(chat: string | ResolvedChat, messageId: number, before: number, after: number): Promise<TelegramMessage[]> {
    if (!this.client) throw new Error('Telegram client not connected');
    const resolved = await this.resolveChat(chat);
    const target = await this.client.getMessages(resolved.inputEntity, {ids:[messageId]});
    if (!target[0] || (target[0] as any).className === 'MessageEmpty') return [];
    assertMessagePeer(target[0], String(resolved.id));
    const [older, newer] = await Promise.all([
      before ? this.client.getMessages(resolved.inputEntity, {offsetId:messageId, limit:before}) : [],
      after ? this.client.getMessages(resolved.inputEntity, {offsetId:messageId, reverse:true, limit:after}) : [],
    ]);
    const neighbors = [...older, ...newer];
    const messages = [...new Map([...neighbors, target[0]].filter(Boolean).map(m => [m.id,m])).values()];
    return messages.map(msg => {
      assertMessagePeer(msg, String(resolved.id));
      const m = msg as any;
      return {id:msg.id, chatId:resolved.id, chatTitle:resolved.title,
        date:new Date(msg.date*1000), sender:m.sender?.firstName || m.sender?.title || m.sender?.username || 'Unknown',
        text:messageText(msg), hasMedia:!!msg.media, mediaType:msg.media ? this.extractMediaInfo(msg.media)?.type : undefined,
        reactions:m.reactions?.results?.map((r:any) => ({emoji:r.reaction?.emoticon || r.reaction?.documentId?.toString(), count:r.count})).filter((r:any) => r.emoji),
        entities:this.extractEntities(msg), replyToId:m.replyTo?.replyToMsgId,
        replyToPeerId:m.replyTo?.replyToPeerId ? peerId(m.replyTo.replyToPeerId) : undefined};
    });
  }

  async getMessageById(chatId: string | number | ResolvedChat, messageId: number): Promise<TelegramMessage | null> {
    if (!this.client) {
      throw new Error('Telegram client not connected');
    }

    try {
      const resolved = await this.resolveChat(chatId);
      const result = await this.client.getMessages(resolved.inputEntity, { ids: [messageId] });

      if (result.length === 0 || !result[0] || !result[0].message && !result[0].media) {
        return null;
      }

      const msg = result[0];
      if (!msg || (msg as any).className === 'MessageEmpty') return null;
      assertMessagePeer(msg, String(resolved.id));
      const sender = msg.sender as any;
      const msgAny = msg as any;

      // Extract media info
      let hasMedia: boolean | undefined;
      let mediaType: MediaType | undefined;
      let mediaDuration: number | undefined;
      if (msg.media) {
        hasMedia = true;
        const mediaInfo = this.extractMediaInfo(msg.media);
        mediaType = mediaInfo?.type || 'unsupported';
        mediaDuration = mediaInfo?.duration;
      }

      // Extract reply info
      let replyToId: number | undefined;
      if (msgAny.replyTo?.replyToMsgId) {
        replyToId = msgAny.replyTo.replyToMsgId as number;
      }

      // Extract entities
      const entities = this.extractEntities(msg);

      return {
        id: msg.id,
        date: new Date(msg.date * 1000),
        sender: sender?.firstName || sender?.username || sender?.title || 'Unknown',
        text: messageText(msg),
        chatId: resolved.id.toString(),
        chatTitle: resolved.title,
        hasMedia,
        mediaType,
        mediaDuration,
        entities,
        reactions:msgAny.reactions?.results?.map((r:any)=>({emoji:r.reaction?.emoticon || r.reaction?.documentId?.toString(),count:r.count})).filter((r:any)=>r.emoji),
        replyToPeerId: msgAny.replyTo?.replyToPeerId ? peerId(msgAny.replyTo.replyToPeerId) : undefined,
        replyToId,
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * The inline keyboard attached to a message, which is where some bots put their real content.
   *
   * BotFather answers `/mybots` with the words "Choose a bot from the list below:" and puts the actual
   * list in `reply_markup`. Read as text, that message says nothing at all — so a whole class of bot
   * conversation is invisible to a reader that only sees `message`. This is deliberately its own method
   * rather than a field on the read path: buttons matter for a handful of messages and plumbing them
   * through the cache would touch the schema for something almost never looked at.
   *
   * Returns `null` when the message has no keyboard, so "no buttons" and "message not found" stay
   * distinguishable — an empty array would collapse them.
   */
  async getInlineKeyboard(
    chatId: string | number,
    messageId: number,
  ): Promise<{ rows: { text: string; kind: string; payload: string | null }[][] } | null> {
    if (!this.client) {
      throw new Error('Telegram client not connected');
    }
    const resolved = await this.resolveChat(chatId);
    const result = await this.client.getMessages(resolved.inputEntity, { ids: [messageId] });
    const msg = result[0] as any;
    if (!msg || msg.className === 'MessageEmpty') return null;
    assertMessagePeer(msg, String(resolved.id));
    const markup = msg.replyMarkup;
    if (!markup || !Array.isArray(markup.rows)) return null;

    const rows = markup.rows.map((row: any) =>
      (row?.buttons ?? []).map((button: any) => {
        // TWO SCHEMAS, and reading only the older one is silently wrong. The classic layer puts `data`
        // and `url` on the button itself (`KeyboardButtonCallback`, `KeyboardButtonUrl`); the newer
        // `KeyboardInlineButton` wraps them in a `type` object (`InlineButtonTypeCallback`). Checked
        // against BotFather, whose buttons are the newer shape: reading only `button.data` reported
        // `payload: null` for every one of them, which looks exactly like a keyboard that carries no
        // payload at all.
        const inner = button?.type ?? button;
        const kind: string = String(inner?.className ?? button?.className ?? 'unknown');
        // Callback data is bytes and its encoding is the bot's business: decode for reading, and say
        // plainly when it is not text rather than printing replacement characters as if they were data.
        let payload: string | null = null;
        const data = inner?.data ?? button?.data;
        if (data) {
          const buffer = Buffer.from(data.data ?? data);
          const raw = buffer.toString('utf8');
          payload = /^[\x20-\x7e]*$/.test(raw) ? raw : `<${buffer.toString('hex')}>`;
        } else if (typeof (inner?.url ?? button?.url) === 'string') {
          payload = inner?.url ?? button.url;
        } else if (typeof (inner?.query ?? button?.query) === 'string') {
          payload = inner?.query ?? button.query;
        }
        return { text: String(button?.text ?? inner?.text ?? ''), kind, payload };
      }),
    );
    return { rows };
  }


  /**
   * Press an inline button, by the coordinates `getInlineKeyboard` prints.
   *
   * The pair matters: a keyboard you can read but not press leaves any paginated or menu-driven bot
   * half-visible — BotFather's `/mybots` shows six bots and a `»`, and the rest exist only behind a
   * callback. Returns whatever the bot answers (often nothing); the useful effect is usually that the
   * bot EDITS the original message, so re-read its keyboard afterwards rather than expecting a reply.
   */
  async pressInlineButton(
    chatId: string | number,
    messageId: number,
    row: number,
    column: number,
  ): Promise<{ pressed: string; answer: string | null }> {
    if (!this.client) {
      throw new Error('Telegram client not connected');
    }
    const keyboard = await this.getInlineKeyboard(chatId, messageId);
    if (keyboard === null) throw new Error(`message #${messageId} has no inline keyboard`);
    const button = keyboard.rows[row]?.[column];
    if (button === undefined) {
      throw new Error(`no button at [${row},${column}]; the keyboard is ${keyboard.rows.map((r) => r.length).join('x')}`);
    }
    if (button.payload === null) throw new Error(`the button at [${row},${column}] ("${button.text}") carries no callback data`);

    const resolved = await this.resolveChat(chatId);
    const result: any = await this.client.invoke(
      new Api.messages.GetBotCallbackAnswer({
        peer: resolved.inputEntity,
        msgId: messageId,
        data: Buffer.from(button.payload.replace(/^<|>$/g, ''), button.payload.startsWith('<') ? 'hex' : 'utf8'),
      }),
    );
    return { pressed: button.text, answer: typeof result?.message === 'string' && result.message.length > 0 ? result.message : null };
  }

  /**
   * Send a message to a chat
   * @param chatId - Chat username, ID, title, or "me" for saved messages
   * @param text - Message text to send
   * @param replyToMsgId - Optional message ID to reply to
   * @param parseMode - Parse mode for the message body
   * @param mute - Deliver without sound/notification (message still arrives normally)
   */
  async sendMessage(chatId: string | number, text: string, replyToMsgId?: number, parseMode: string = 'md2', mute: boolean = false): Promise<{ messageId: number; chatId: string }> {
    if (!this.client) {
      throw new Error('Telegram client not connected');
    }

    // Resolve the chat to get the proper inputEntity
    if (replyToMsgId !== undefined) parseMessageId(String(replyToMsgId));
    const resolved = await this.resolveChat(chatId);

    const options: any = await this.prepareText(text, parseMode);
    if (replyToMsgId) {
      options.replyTo = replyToMsgId;
    }
    if (mute) {
      options.silent = true;
    }

    const result = await this.client.sendMessage(resolved.inputEntity, options);
    return { messageId: result.id, chatId: resolved.id.toString() };
  }

  /**
   * Send a file to a chat
   * @param chatId - Chat username, ID, title, or "me" for saved messages
   * @param filePath - Path to the file to send
   * @param caption - Optional caption for the file
   * @param replyToMsgId - Optional message ID to reply to
   * @param progressCallback - Optional callback for upload progress
   * @param parseMode - Parse mode for the caption
   * @param mute - Deliver without sound/notification (file still arrives normally)
   */
  async sendFile(
    chatId: string | number,
    filePath: string,
    caption?: string,
    replyToMsgId?: number,
    progressCallback?: (progress: number) => void,
    parseMode: string = 'md2',
    mute: boolean = false
  ): Promise<{ messageId: number; chatId: string }> {
    if (!this.client) {
      throw new Error('Telegram client not connected');
    }

    const resolved = await this.resolveChat(chatId);

    const options: any = {
      file: filePath,
      forceDocument: true, // Always send as document, not media preview
    };

    if (caption) {
      options.caption = parseMode === 'md2' ? escapeForMarkdownV2(caption) : caption;
      // GramJS only formats the caption when parseMode is set on sendFile options.
      // Without this, HTML/Markdown tags in the caption appear as literal text.
      options.parseMode = parseMode;
    }

    if (replyToMsgId) {
      options.replyTo = replyToMsgId;
    }

    if (progressCallback) {
      options.progressCallback = (uploaded: number, total: number) => {
        progressCallback(uploaded / total);
      };
    }

    if (mute) {
      options.silent = true;
    }

    const result = await this.client.sendFile(resolved.inputEntity, options);
    return { messageId: result.id, chatId: resolved.id.toString() };
  }

  /**
   * Edit a message
   * @param chatId - Chat username, ID, title, or "me" for saved messages
   * @param messageId - ID of the message to edit
   * @param newText - New text content
   */
  async editMessage(chatId: string | number, messageId: number, newText: string, parseMode: string = 'md2'): Promise<void> {
    if (!this.client) {
      throw new Error('Telegram client not connected');
    }

    const resolved = await this.resolveChat(chatId);

    const prepared = await this.prepareText(newText, parseMode);
    await this.client.editMessage(resolved.inputEntity, {
      message: messageId,
      text: prepared.message,
      ...(prepared.formattingEntities ? { formattingEntities: prepared.formattingEntities } : { parseMode: prepared.parseMode }),
    });
  }

  /**
   * Delete messages. `revoke` removes them for everyone, not just locally,
   * which is the noise-cleanup case: prune progress messages once the result
   * has landed. Only your own messages delete freely; a chat may cap this at
   * ~48h. Deleting an already-gone id is a no-op on Telegram's side.
   */
  async deleteMessages(chatId: string | number, messageIds: number[]): Promise<void> {
    if (!this.client) {
      throw new Error('Telegram client not connected');
    }
    const resolved = await this.resolveChat(chatId);
    await this.client.deleteMessages(resolved.inputEntity, messageIds, { revoke: true });
  }

  /**
   * Pin a message. `notify: false` pins quietly (no service message / no ping),
   * which is right for a living ledger you re-pin as it changes. Only your own
   * pins are unrestricted; a group may require admin rights to pin.
   */
  async pinMessage(chatId: string | number, messageId: number, notify = false): Promise<void> {
    if (!this.client) {
      throw new Error('Telegram client not connected');
    }
    const resolved = await this.resolveChat(chatId);
    await this.client.pinMessage(resolved.inputEntity, messageId, { notify });
  }

  /**
   * Unpin one message, or every pin when no id is given: of the whole chat, or of one forum topic with `topic`.
   * The command asks for `--all` and shows `listPins` first; this method does what it is told.
   */
  async unpinMessage(chatId: string | number, messageId?: number, topic?: number): Promise<void> {
    if (!this.client) {
      throw new Error('Telegram client not connected');
    }
    const resolved = await this.resolveChat(chatId);
    if (messageId !== undefined) {
      await this.client.unpinMessage(resolved.inputEntity, messageId);
      return;
    }
    // Telegram may do it in batches: a positive `offset` in the answer means "call again", until it is 0.
    // Bounded, so a server that never reports 0 cannot keep this here.
    for (let round = 0; round < 50; round += 1) {
      const affected = await this.client.invoke(new Api.messages.UnpinAllMessages({
        peer: resolved.inputEntity,
        ...(topic === undefined ? {} : { topMsgId: topic }),
      })) as Api.messages.AffectedHistory;
      if (!(affected.offset > 0)) return;
    }
    throw new Error('Telegram kept reporting more pins to remove after 50 rounds; check with "telegram pins" and run again');
  }

  /**
   * Every pinned message of a chat, or of one forum topic. Each carries the topic it is in, so a forum's list across
   * topics says where each pin is. A direct `messages.search` rather than GramJS `getMessages`: given a topic, that
   * helper switches to `getReplies` and drops the pinned filter.
   */
  async listPins(chatId: string | number, options: { topic?: number; limit?: number } = {}): Promise<{ pins: PinnedMessage[]; truncated: boolean }> {
    if (!this.client) {
      throw new Error('Telegram client not connected');
    }
    const resolved = await this.resolveChat(chatId);
    const limit = options.limit ?? 100;
    const result = await this.client.invoke(new Api.messages.Search({
      peer: resolved.inputEntity,
      q: '',
      filter: new Api.InputMessagesFilterPinned(),
      ...(options.topic === undefined ? {} : { topMsgId: options.topic }),
      minDate: 0,
      maxDate: 0,
      offsetId: 0,
      addOffset: 0,
      limit,
      maxId: 0,
      minId: 0,
      hash: generateRandomBigInt(),
    })) as Api.messages.Messages | Api.messages.MessagesSlice | Api.messages.ChannelMessages;
    const names = new Map<string, string>();
    for (const user of (result as { users?: Api.TypeUser[] }).users ?? []) {
      const u = user as Api.User;
      names.set(`user:${String(u.id)}`, [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username || String(u.id));
    }
    for (const chat of (result as { chats?: Api.TypeChat[] }).chats ?? []) {
      const c = chat as Api.Channel;
      names.set(`chat:${String(c.id)}`, c.title ?? String(c.id));
    }
    const pins: PinnedMessage[] = [];
    for (const raw of result.messages) {
      if (!(raw instanceof Api.Message)) continue;
      const from = raw.fromId;
      const author = from instanceof Api.PeerUser ? names.get(`user:${String(from.userId)}`)
        : from instanceof Api.PeerChannel ? names.get(`chat:${String(from.channelId)}`)
        // An unsigned channel post carries no sender at all; the channel it is in is its author.
        : from === undefined || from === null ? (raw.peerId instanceof Api.PeerChannel ? names.get(`chat:${String(raw.peerId.channelId)}`) : undefined)
        : undefined;
      const header = raw.replyTo instanceof Api.MessageReplyHeader ? raw.replyTo : undefined;
      // A signed channel post names its real author in post_author; the peer is only the channel.
      const signed = typeof raw.postAuthor === 'string' && raw.postAuthor.trim() !== '' ? raw.postAuthor : undefined;
      pins.push({
        id: raw.id,
        topic: topicOfReplyHeader(header === undefined ? undefined : {
          forumTopic: header.forumTopic === true,
          ...(header.replyToTopId === undefined ? {} : { replyToTopId: header.replyToTopId }),
          ...(header.replyToMsgId === undefined ? {} : { replyToMsgId: header.replyToMsgId }),
        }) ?? options.topic ?? null,
        author: signed ?? author ?? 'unknown',
        sentAt: new Date(raw.date * 1000),
        firstLine: firstLineOf(messageText(raw), raw.media !== undefined && raw.media !== null),
      });
    }
    const total = (result as { count?: number }).count ?? pins.length;
    return { pins, truncated: total > pins.length };
  }

  /**
   * Turn outgoing text into GramJS send options. `{{time:...}}` tokens become
   * their labels with date entities on top, so readers see the moment in their
   * own time zone; that needs the parsed text, so such messages are parsed here
   * rather than by GramJS.
   */
  private async prepareText(text: string, parseMode: string): Promise<{ message: string; parseMode?: string; formattingEntities?: Api.TypeMessageEntity[] }> {
    const { text: body, dates } = extractTimeTokens(text);
    const source = parseMode === 'md2' ? escapeForMarkdownV2(body) : body;
    if (dates.length === 0) return { message: source, parseMode };

    const [message, entities] = await _parseMessageText(this.client!, source, parseMode);
    const dateEntities = locateDates(message, dates).map((d) => new RichApi.MessageEntityFormattedDate({
      offset: d.offset,
      length: d.length,
      date: d.unix,
      ...formatToFlags(d.format),
    }));
    const formattingEntities = [...entities, ...dateEntities].sort((a: any, b: any) => a.offset - b.offset);
    return { message, formattingEntities };
  }

  /**
   * Send a rich message: markdown that Telegram's servers turn into headings,
   * real tables, task lists, collapsible details and dates. `{{time:...}}`
   * tokens become local-time dates.
   */
  async sendRichMessage(chatId: string | number, markdown: string, replyToMsgId?: number, mute: boolean = false): Promise<{ messageId: number; chatId: string }> {
    if (!this.client) {
      throw new Error('Telegram client not connected');
    }

    if (replyToMsgId !== undefined) parseMessageId(String(replyToMsgId));
    const body = expandTimeTokensForRich(prepareRichMarkdown(markdown));
    assertRichSize(body);
    const resolved = await this.resolveChat(chatId);

    const randomId = generateRandomBigInt();
    const result = await this.client.invoke(new RichApi.messages.SendMessage({
      peer: resolved.inputEntity,
      message: '',
      randomId,
      richMessage: new RichApi.InputRichMessageMarkdown({ markdown: body }),
      replyTo: replyToMsgId ? new Api.InputReplyToMessage({ replyToMsgId }) : undefined,
      silent: mute || undefined,
    }));
    return { messageId: sentMessageId(result, randomId), chatId: resolved.id.toString() };
  }

  /**
   * Replace a message's content with rich markdown (see sendRichMessage).
   *
   * A message that carries media (a document, a photo, a voice note) has a caption, not a body, and a caption
   * cannot be a rich message: the rich edit blanked it. Such a message gets its caption edited through the
   * ordinary markdown path instead, so bold, italics, code and links survive. Tables and headings have no caption
   * form. Returns `caption: true` in that case so the caller can say so.
   */
  async editRichMessage(chatId: string | number, messageId: number, markdown: string): Promise<{ caption: boolean }> {
    if (!this.client) {
      throw new Error('Telegram client not connected');
    }

    const resolved = await this.resolveChat(chatId);
    const [current] = await this.client.getMessages(resolved.inputEntity, { ids: [messageId] });
    if (!current) throw new Error(`Message #${messageId} not found in this chat`);
    const media = (current as any).media;
    if (media && !(media instanceof Api.MessageMediaWebPage)) {
      await this.editMessage(chatId, messageId, markdown, 'md2');
      return { caption: true };
    }

    const body = expandTimeTokensForRich(prepareRichMarkdown(markdown));
    assertRichSize(body);

    await this.client.invoke(new RichApi.messages.EditMessage({
      peer: resolved.inputEntity,
      id: messageId,
      richMessage: new RichApi.InputRichMessageMarkdown({ markdown: body }),
    }));
    return { caption: false };
  }

  /**
   * Search messages in a chat
   * @param query - Search query
   * @param chatId - Optional chat username, ID, title, or "me" for saved messages
   * @param limit - Maximum number of results
   */
  async searchMessages(query: string, chatId?: string | number, limit: number = 20): Promise<TelegramMessage[]> {
    if (!this.client) {
      throw new Error('Telegram client not connected');
    }

    const messages: TelegramMessage[] = [];
    const searchOpts: any = { limit, search: query };

    try {
      // If chatId specified, resolve and search in that chat; otherwise search in saved messages
      let target: Api.TypeInputPeer | string = 'me';
      let targetChatId: string | number = 'me';

      if (chatId) {
        const resolved = await this.resolveChat(chatId);
        target = resolved.inputEntity;
        targetChatId = resolved.id;
      }

      const result = await this.client.getMessages(target, searchOpts);

      for (const msg of result) {
        if (messageText(msg)) {
          const sender = msg.sender as any;
          const msgAny = msg as any;

          // Extract reactions if present (with counts)
          const reactions: ReactionInfo[] = [];
          if (msgAny.reactions?.results) {
            for (const r of msgAny.reactions.results) {
              // ReactionEmoji has emoticon (standard emoji like 👍)
              // ReactionCustomEmoji has documentId (premium custom emoji)
              const emoji = r.reaction?.emoticon || (r.reaction?.className === 'ReactionCustomEmoji' ? '⭐' : null);
              if (emoji) {
                reactions.push({ emoji, count: r.count || 1 });
              }
            }
          }

          messages.push({
            id: msg.id,
            date: new Date(msg.date * 1000),
            sender: sender?.firstName || sender?.username || sender?.title || 'Unknown',
            text: messageText(msg),
            chatId: targetChatId,
            reactions: reactions.length > 0 ? reactions : undefined,
          });
        }
      }
    } catch (err) {
      throw new Error(`Error searching messages: ${(err as Error).message}`);
    }

    return messages;
  }

  /**
   * Get list of dialogs (chats)
   */
  async getDialogs(limit: number = 20): Promise<Array<{ id: string | number; title: string; unreadCount: number }>> {
    if (!this.client) {
      throw new Error('Telegram client not connected');
    }

    const dialogs: Array<{ id: string | number; title: string; unreadCount: number }> = [];

    const result = await this.client.getDialogs({ limit });
    for (const dialog of result) {
      const entity = dialog.entity as any;
      dialogs.push({
        id: peerId(entity),
        title: dialog.title || entity?.firstName || entity?.username || 'Unknown',
        unreadCount: dialog.unreadCount || 0,
      });
    }

    return dialogs;
  }

  /**
   * Search chats using Telegram's contacts.Search API (supports cross-literal matching)
   * @param query - Search query (e.g., "Alex" will find "Алекс")
   * @param limit - Maximum number of results
   */
  async searchChats(query: string, limit: number = 20): Promise<Array<{ id: string; title: string; type: 'user' | 'group' | 'channel' }>> {
    if (!this.client) {
      throw new Error('Telegram client not connected');
    }

    const results: Array<{ id: string; title: string; type: 'user' | 'group' | 'channel' }> = [];

    const searchResult = await this.client.invoke(
      new Api.contacts.Search({
        q: query,
        limit,
      })
    );

    // Add users
    for (const user of searchResult.users) {
      const u = user as Api.User;
      results.push({
        id: peerId(u),
        title: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username || 'Unknown',
        type: 'user',
      });
    }

    // Add chats/channels
    for (const chat of searchResult.chats) {
      const c = chat as any;
      results.push({
        id: peerId(c),
        title: c.title || c.username || 'Unknown',
        type: c.className === 'Channel' ? (c.megagroup ? 'group' : 'channel') : 'group',
      });
    }

    return results;
  }

  /**
   * Show "typing…" in a chat.
   *
   * Telegram clears it after about five seconds, so a caller that wants it held
   * has to repeat the call.
   */
  async sendTyping(chatId: string | number): Promise<void> {
    if (!this.client) {
      throw new Error('Telegram client not connected');
    }

    const resolved = await this.resolveChat(chatId);
    await this.client.invoke(
      new Api.messages.SetTyping({
        peer: resolved.inputEntity,
        action: new Api.SendMessageTypingAction(),
      })
    );
  }

  /**
   * Add a reaction to a message
   * @param chatId - Chat username, ID, title, or "me" for saved messages
   * @param messageId - Message ID to react to
   * @param emoji - Emoji reaction (e.g., '👍', '❤️', '🔥')
   */
  async addReaction(chatId: string | number, messageId: number, emoji: string): Promise<void> {
    if (!this.client) {
      throw new Error('Telegram client not connected');
    }

    try {
      // Resolve the chat to get the proper inputEntity
      const resolved = await this.resolveChat(chatId);
      await this.client.invoke(
        new Api.messages.SendReaction({
          peer: resolved.inputEntity,
          msgId: messageId,
          reaction: [new Api.ReactionEmoji({ emoticon: emoji })],
        })
      );
    } catch (err) {
      throw new Error(`Error adding reaction: ${(err as Error).message}`);
    }
  }

  /**
   * Remove all reactions from a message
   * @param chatId - Chat username, ID, title, or "me" for saved messages
   * @param messageId - Message ID to remove reactions from
   */
  async removeReaction(chatId: string | number, messageId: number): Promise<void> {
    if (!this.client) {
      throw new Error('Telegram client not connected');
    }

    try {
      // Resolve the chat to get the proper inputEntity
      const resolved = await this.resolveChat(chatId);
      await this.client.invoke(
        new Api.messages.SendReaction({
          peer: resolved.inputEntity,
          msgId: messageId,
          reaction: [], // Empty array removes reactions
        })
      );
    } catch (err) {
      throw new Error(`Error removing reaction: ${(err as Error).message}`);
    }
  }

  /**
   * Get detailed reaction list for a message including who reacted
   * @param chatId - Chat username, ID, title, or "me" for saved messages
   * @param messageId - Message ID to get reactions for
   * @returns Array of ReactionInfo with users populated
   */
  async getMessageReactionsList(chatId: string | number | ResolvedChat, messageId: number): Promise<ReactionInfo[]> {
    if (!this.client) {
      throw new Error('Telegram client not connected');
    }

    try {
      const resolved = await this.resolveChat(chatId);
      const result = await this.client.invoke(
        new Api.messages.GetMessageReactionsList({
          peer: resolved.inputEntity,
          id: messageId,
          limit: 100,
        })
      );

      // Build a map of users from the response
      const userMap = new Map<string, ReactionUser>();
      if (result.users) {
        for (const user of result.users) {
          const u = user as Api.User;
          userMap.set(u.id.toString(), {
            id: u.id.toString(),
            firstName: u.firstName ?? undefined,
            lastName: u.lastName ?? undefined,
            username: u.username ?? undefined,
          });
        }
      }

      // Group reactions by emoji
      const reactionMap = new Map<string, ReactionInfo>();
      if (result.reactions) {
        for (const r of result.reactions) {
          const rAny = r as any;
          const emoji = rAny.reaction?.emoticon ||
            (rAny.reaction?.className === 'ReactionCustomEmoji' ? '⭐' : null);
          if (!emoji) continue;

          const userId = rAny.peerId?.userId?.toString();
          const user = userId ? userMap.get(userId) : undefined;

          if (!reactionMap.has(emoji)) {
            reactionMap.set(emoji, { emoji, count: 0, users: [] });
          }
          const info = reactionMap.get(emoji)!;
          info.count++;
          if (user) {
            info.users!.push(user);
          }
        }
      }

      return Array.from(reactionMap.values());
    } catch (err) {
      // If we can't get reaction details (e.g., no permission), return empty
      // This happens in some channels where only admins can see who reacted
      return [];
    }
  }

  /**
   * Check mute status for a dialog's notify settings
   */
  private getMuteStatus(notifySettings: Api.PeerNotifySettings | undefined): MuteStatus {
    if (!notifySettings) {
      return { muted: false };
    }

    const muteUntil = notifySettings.muteUntil;
    const now = Math.floor(Date.now() / 1000);

    // muteUntil = undefined or 0 means not muted
    if (muteUntil === undefined || muteUntil === null || muteUntil === 0) {
      return { muted: false };
    }

    // muteUntil = INT32_MAX (2147483647) means muted forever
    if (muteUntil === 2147483647) {
      return { muted: true, forever: true };
    }

    // muteUntil is a timestamp - check if still active
    if (muteUntil > now) {
      return { muted: true, forever: false, until: new Date(muteUntil * 1000) };
    }

    // Mute has expired
    return { muted: false };
  }

  /**
   * Get forum topics with unread messages
   * @param forumMuted - Whether the forum group itself is muted (overrides topic settings)
   */
  private async getForumTopicsWithUnread(
    inputEntity: Api.TypeInputPeer,
    forumTitle: string,
    chatId: string | number,
    includeMuted: boolean,
    messagesPerTopic: number,
    forumMuted: boolean
  ): Promise<ForumTopic[]> {
    if (!this.client) {
      throw new Error('Telegram client not connected');
    }

    const result: ForumTopic[] = [];

    // Fetch forum topics
    const topicsResult = await this.client.invoke(
      new Api.channels.GetForumTopics({
        channel: inputEntity,
        offsetDate: 0,
        offsetId: 0,
        offsetTopic: 0,
        limit: 50,
      })
    );

    const topics = topicsResult.topics as (Api.ForumTopic | Api.ForumTopicDeleted)[];
    const topicMessages = topicsResult.messages as Api.Message[];

    // Create a map of topic ID to latest message
    const messagesByTopic = new Map<number, Api.Message[]>();
    for (const msg of topicMessages) {
      const topicId = (msg as any).replyTo?.replyToTopId || 1; // General topic is ID 1
      if (!messagesByTopic.has(topicId)) {
        messagesByTopic.set(topicId, []);
      }
      messagesByTopic.get(topicId)!.push(msg);
    }

    for (const topic of topics) {
      // Skip deleted topics
      if (topic.className === 'ForumTopicDeleted') {
        continue;
      }

      const t = topic as Api.ForumTopic;

      // Skip topics with no unread
      if (t.unreadCount === 0) {
        continue;
      }

      // Check mute status - topic is muted if:
      // 1. The forum group itself is muted, OR
      // 2. The topic has its own mute setting
      const notifySettings = t.notifySettings as Api.PeerNotifySettings | undefined;
      const topicMuteStatus = this.getMuteStatus(notifySettings);

      // Forum-level mute overrides topic settings
      const isMuted = forumMuted || topicMuteStatus.muted;

      // Skip muted topics unless requested
      if (isMuted && !includeMuted) {
        continue;
      }

      // Get messages for this topic
      const messages: TelegramMessage[] = [];
      const topicMsgs = messagesByTopic.get(t.id) || [];

      // Build message map for reply lookups within topic
      const messageMap = new Map<number, { text: string; sender: string; hasMedia: boolean; mediaType?: string }>();
      for (const msg of topicMsgs) {
        if (messageText(msg) || msg.media) {
          const sender = msg.sender as any;
          const senderName = sender?.firstName || sender?.username || sender?.title || 'Unknown';
          const msgAny = msg as any;
          let mediaType: string | undefined;
          if (msgAny.media) {
            const mediaInfo = this.extractMediaInfo(msgAny.media);
            if (mediaInfo) mediaType = mediaInfo.type;
          }
          messageMap.set(msg.id, {
            text: messageText(msg),
            sender: senderName,
            hasMedia: !!msg.media,
            mediaType,
          });
        }
      }

      for (const msg of topicMsgs.slice(0, messagesPerTopic)) {
        if (messageText(msg) || msg.media) {
          const sender = msg.sender as any;
          const msgAny = msg as any;

          // Extract reactions
          const reactions: ReactionInfo[] = [];
          if (msgAny.reactions?.results) {
            for (const r of msgAny.reactions.results) {
              const emoji = r.reaction?.emoticon || (r.reaction?.className === 'ReactionCustomEmoji' ? '⭐' : null);
              if (emoji) {
                reactions.push({ emoji, count: r.count || 1 });
              }
            }
          }

          // Extract reply info
          let replyToId: number | undefined;
          let replyToText: string | undefined;
          let replyToSender: string | undefined;

          if (msgAny.replyTo?.replyToMsgId) {
            replyToId = msgAny.replyTo.replyToMsgId as number;
            const replyMsg = !msgAny.replyTo?.replyToPeerId || peerId(msgAny.replyTo.replyToPeerId) === peerId(msgAny.peerId) ? messageMap.get(replyToId) : undefined;
            if (replyMsg) {
              replyToSender = replyMsg.sender;
              if (replyMsg.text) {
                replyToText = replyMsg.text;
              } else if (replyMsg.hasMedia && replyMsg.mediaType) {
                replyToText = `[${replyMsg.mediaType}]`;
              }
            }
          }

          messages.push({
            id: msg.id,
            date: new Date(msg.date * 1000),
            sender: sender?.firstName || sender?.username || sender?.title || 'Unknown',
            text: messageText(msg),
            chatId,
            chatTitle: `${forumTitle} › ${t.title}`,
            reactions: reactions.length > 0 ? reactions : undefined,
            replyToPeerId: msgAny.replyTo?.replyToPeerId ? peerId(msgAny.replyTo.replyToPeerId) : undefined,
            replyToId,
            replyToText,
            replyToSender,
          });
        }
      }

      result.push({
        id: t.id,
        title: t.title,
        unreadCount: t.unreadCount,
        unreadMentionsCount: t.unreadMentionsCount,
        isMuted,
        mutedForever: forumMuted ? undefined : topicMuteStatus.forever,
        mutedUntil: forumMuted ? undefined : topicMuteStatus.until,
        iconColor: t.iconColor,
        messages,
      });
    }

    return result;
  }

  /**
   * Get unread messages from chats
   * @param options.includeMuted - Include muted chats/topics (default: false)
   * @param options.includeArchived - Include archived chats (default: false)
   * @param options.expandForums - Expand forum groups to show individual topics (default: true)
   * @param options.messagesPerChat - Max messages to fetch per chat/topic (default: 5)
   * @param options.chatsLimit - Max number of chats to check (default: 50)
   */
  async getUnreadMessages(options?: {
    includeMuted?: boolean;
    includeArchived?: boolean;
    expandForums?: boolean;
    messagesPerChat?: number;
    chatsLimit?: number;
  }): Promise<UnreadChat[]> {
    if (!this.client) {
      throw new Error('Telegram client not connected');
    }

    const {
      includeMuted = false,
      includeArchived = false,
      expandForums = true,
      messagesPerChat = 5,
      chatsLimit = 50,
    } = options || {};

    const result: UnreadChat[] = [];
    const dialogs = await this.client.getDialogs({ limit: chatsLimit });

    for (const dialog of dialogs) {
      const unreadCount = dialog.unreadCount || 0;

      // Skip chats with no unread messages
      if (unreadCount === 0) {
        continue;
      }

      // Skip archived unless requested
      if (dialog.archived && !includeArchived) {
        continue;
      }

      const entity = dialog.entity as any;

      // Check if this is a forum group (has topics inside)
      const isForum = entity?.forum === true;

      // Check mute status at the chat level
      const notifySettings = dialog.dialog.notifySettings as Api.PeerNotifySettings | undefined;
      const muteStatus = this.getMuteStatus(notifySettings);

      const chatId = peerId(entity);

      // Handle forum groups
      if (isForum) {
        try {
          const forumTopics = await this.getForumTopicsWithUnread(
            dialog.inputEntity,
            dialog.title || 'Unknown',
            chatId,
            includeMuted,
            messagesPerChat,
            muteStatus.muted  // Pass forum-level mute status
          );

          // Filter to non-muted topics with unread
          const relevantTopics = forumTopics.filter(
            topic => topic.unreadCount > 0 && (includeMuted || !topic.isMuted)
          );

          // Skip forum if no relevant topics
          if (relevantTopics.length === 0) {
            continue;
          }

          if (expandForums) {
            // Add each topic as a separate entry
            for (const topic of relevantTopics) {
              result.push({
                id: chatId,
                title: `${dialog.title || 'Unknown'} › ${topic.title}`,
                unreadCount: topic.unreadCount,
                unreadMentionsCount: topic.unreadMentionsCount,
                isMuted: topic.isMuted,
                mutedForever: topic.mutedForever,
                mutedUntil: topic.mutedUntil,
                isArchived: dialog.archived,
                isChannel: dialog.isChannel,
                isGroup: dialog.isGroup,
                isUser: dialog.isUser,
                isForum: true,
                forumTopics: [topic],
                messages: topic.messages,
              });
            }
          } else {
            // Add forum as single entry with aggregated counts from non-muted topics
            const totalUnread = relevantTopics.reduce((sum, t) => sum + t.unreadCount, 0);
            const totalMentions = relevantTopics.reduce((sum, t) => sum + t.unreadMentionsCount, 0);
            const allMessages = relevantTopics.flatMap(t => t.messages).slice(0, messagesPerChat);

            result.push({
              id: chatId,
              title: dialog.title || 'Unknown',
              unreadCount: totalUnread,
              unreadMentionsCount: totalMentions,
              isMuted: muteStatus.muted,
              mutedForever: muteStatus.forever,
              mutedUntil: muteStatus.until,
              isArchived: dialog.archived,
              isChannel: dialog.isChannel,
              isGroup: dialog.isGroup,
              isUser: dialog.isUser,
              isForum: true,
              forumTopics: relevantTopics,
              messages: allMessages,
            });
          }
        } catch {
          // If we can't fetch topics, skip this forum
        }
        continue;
      }

      // Skip muted regular chats unless requested
      if (muteStatus.muted && !includeMuted) {
        continue;
      }

      // Fetch unread messages for regular chats
      const messages: TelegramMessage[] = [];
      try {
        // Get the last N unread messages
        const limit = Math.min(messagesPerChat, unreadCount);
        const msgs = await this.client.getMessages(dialog.inputEntity, { limit });

        // Build message map for reply lookups
        const messageMap = new Map<number, { text: string; sender: string; hasMedia: boolean; mediaType?: string }>();
        for (const msg of msgs) {
          if (messageText(msg) || msg.media) {
            const sender = msg.sender as any;
            const senderName = sender?.firstName || sender?.username || sender?.title || 'Unknown';
            const msgAny = msg as any;
            let mediaType: string | undefined;
            if (msgAny.media) {
              const mediaInfo = this.extractMediaInfo(msgAny.media);
              if (mediaInfo) mediaType = mediaInfo.type;
            }
            messageMap.set(msg.id, {
              text: messageText(msg),
              sender: senderName,
              hasMedia: !!msg.media,
              mediaType,
            });
          }
        }

        for (const msg of msgs) {
          if (messageText(msg) || msg.media) {
            const sender = msg.sender as any;
            const msgAny = msg as any;

            // Extract reactions
            const reactions: ReactionInfo[] = [];
            if (msgAny.reactions?.results) {
              for (const r of msgAny.reactions.results) {
                const emoji = r.reaction?.emoticon || (r.reaction?.className === 'ReactionCustomEmoji' ? '⭐' : null);
                if (emoji) {
                  reactions.push({ emoji, count: r.count || 1 });
                }
              }
            }

            // Extract reply info
            let replyToId: number | undefined;
            let replyToText: string | undefined;
            let replyToSender: string | undefined;

            if (msgAny.replyTo?.replyToMsgId) {
              replyToId = msgAny.replyTo.replyToMsgId as number;
              const replyMsg = !msgAny.replyTo?.replyToPeerId || peerId(msgAny.replyTo.replyToPeerId) === peerId(msgAny.peerId) ? messageMap.get(replyToId) : undefined;
              if (replyMsg) {
                replyToSender = replyMsg.sender;
                if (replyMsg.text) {
                  replyToText = replyMsg.text;
                } else if (replyMsg.hasMedia && replyMsg.mediaType) {
                  replyToText = `[${replyMsg.mediaType}]`;
                }
              }
            }

            messages.push({
              id: msg.id,
              date: new Date(msg.date * 1000),
              sender: sender?.firstName || sender?.username || sender?.title || 'Unknown',
              text: messageText(msg),
              chatId,
              chatTitle: dialog.title || 'Unknown',
              reactions: reactions.length > 0 ? reactions : undefined,
              replyToPeerId: msgAny.replyTo?.replyToPeerId ? peerId(msgAny.replyTo.replyToPeerId) : undefined,
              replyToId,
              replyToText,
              replyToSender,
            });
          }
        }
      } catch {
        // Skip chats we can't read from
        continue;
      }

      result.push({
        id: chatId,
        title: dialog.title || 'Unknown',
        unreadCount,
        unreadMentionsCount: dialog.unreadMentionsCount || 0,
        isMuted: muteStatus.muted,
        mutedForever: muteStatus.forever,
        mutedUntil: muteStatus.until,
        isArchived: dialog.archived,
        isChannel: dialog.isChannel,
        isGroup: dialog.isGroup,
        isUser: dialog.isUser,
        isForum,
        messages,
      });
    }

    // Sort by unread count descending (most unread first)
    result.sort((a, b) => b.unreadCount - a.unreadCount);

    return result;
  }

  /**
   * Mark messages as read in a chat
   * @param chatId - Chat username, ID, title, or "me" for saved messages
   * @param maxId - Mark all messages up to this ID as read (optional, defaults to latest)
   */
  async markAsRead(chatId: string | number, maxId?: number): Promise<void> {
    if (!this.client) {
      throw new Error('Telegram client not connected');
    }

    try {
      // Resolve the chat to get the proper inputEntity
      const resolved = await this.resolveChat(chatId);
      const entity = resolved.inputEntity;

      // Determine if it's a channel or regular chat
      const entityAny = entity as any;
      const isChannel = entityAny.className === 'InputPeerChannel' || entityAny.className === 'InputChannel';

      if (isChannel) {
        // For channels/supergroups, use channels.ReadHistory
        await this.client.invoke(
          new Api.channels.ReadHistory({
            channel: entity,
            maxId: maxId || 0, // 0 means read all
          })
        );
      } else {
        // For regular chats/users, use messages.ReadHistory
        await this.client.invoke(
          new Api.messages.ReadHistory({
            peer: entity,
            maxId: maxId || 0, // 0 means read all
          })
        );
      }
    } catch (err) {
      throw new Error(`Error marking messages as read: ${(err as Error).message}`);
    }
  }

  /**
   * Get participants from a chat (channel, supergroup, or regular group)
   * @param chatId - Chat username, ID, title
   * @param limit - Maximum number of participants to fetch
   */
  async getParticipants(chatId: string | number, limit: number = 100): Promise<TelegramParticipant[]> {
    if (!this.client) {
      throw new Error('Telegram client not connected');
    }

    const resolved = await this.resolveChat(chatId);
    const participants: TelegramParticipant[] = [];

    try {
      if (resolved.type === 'channel' || resolved.type === 'supergroup') {
        // For channels/supergroups, use channels.GetParticipants
        const result = await this.client.invoke(
          new Api.channels.GetParticipants({
            channel: resolved.inputEntity,
            filter: new Api.ChannelParticipantsRecent(),
            offset: 0,
            limit,
            hash: BigInt(0) as any,
          })
        );

        // Result could be ChannelParticipants or ChannelParticipantsNotModified
        if ('users' in result) {
          for (const user of result.users) {
            const u = user as any;
            if (u.className === 'User') {
              participants.push({
                id: u.id.toString(),
                firstName: u.firstName,
                lastName: u.lastName,
                username: u.username,
                phone: u.phone,
                isBot: u.bot || false,
                isVerified: u.verified || false,
                isPremium: u.premium || false,
              });
            }
          }
        }
      } else if (resolved.type === 'group') {
        // For regular groups (Chat), use messages.GetFullChat
        // Need to extract the chat ID from the input entity
        const entityAny = resolved.inputEntity as any;
        const chatIdNum = entityAny.chatId;

        if (chatIdNum) {
          const fullChat = await this.client.invoke(
            new Api.messages.GetFullChat({
              chatId: chatIdNum,
            })
          );

          for (const user of fullChat.users) {
            const u = user as any;
            if (u.className === 'User') {
              participants.push({
                id: u.id.toString(),
                firstName: u.firstName,
                lastName: u.lastName,
                username: u.username,
                phone: u.phone,
                isBot: u.bot || false,
                isVerified: u.verified || false,
                isPremium: u.premium || false,
              });
            }
          }
        }
      } else {
        // For direct user chats, just return that user
        // Try to get user info
        try {
          const entity = await this.client.getEntity(resolved.inputEntity);
          const u = entity as any;
          if (u.className === 'User') {
            participants.push({
              id: u.id.toString(),
              firstName: u.firstName,
              lastName: u.lastName,
              username: u.username,
              phone: u.phone,
              isBot: u.bot || false,
              isVerified: u.verified || false,
              isPremium: u.premium || false,
            });
          }
        } catch {
          // Could not get user entity
        }
      }
    } catch (err) {
      throw new Error(`Error fetching participants: ${(err as Error).message}`);
    }

    return participants;
  }

  /**
   * Fetch the logged-in account's saved Telegram contacts.
   *
   * Uses contacts.GetContacts, which returns the full saved contact list as
   * User objects. Unlike arbitrary group participants, your own saved contacts
   * have their `phone` field populated by Telegram, so this is the correct
   * source for exporting contacts with phone numbers (e.g. to a vCard).
   */
  async getContacts(): Promise<TelegramContact[]> {
    if (!this.client) {
      throw new Error('Telegram client not connected');
    }

    const contacts: TelegramContact[] = [];

    try {
      // hash: 0 forces the server to return the full Contacts object (never
      // ContactsNotModified, which is only returned when the hash matches).
      const result = await this.client.invoke(
        new Api.contacts.GetContacts({ hash: BigInt(0) as any })
      );

      if ('users' in result) {
        for (const user of result.users) {
          const u = user as any;
          // Skip non-users, deleted accounts, and bots - they are not real
          // address-book contacts.
          if (u.className !== 'User' || u.deleted || u.bot) {
            continue;
          }
          contacts.push({
            id: u.id.toString(),
            accessHash: u.accessHash?.toString(),
            firstName: u.firstName,
            lastName: u.lastName,
            username: u.username,
            phone: u.phone,
            isMutualContact: u.mutualContact || false,
          });
        }
      }
    } catch (err) {
      throw new Error(`Error fetching contacts: ${(err as Error).message}`);
    }

    return contacts;
  }

  /**
   * Return the set of user IDs (as strings) that have a 1-on-1 chat (dialog).
   *
   * Used to distinguish contacts you've actually talked to from contacts with no
   * chat history (e.g. address-book contacts auto-imported by Sync Contacts).
   */
  async getDialogUserIds(limit: number = 1000): Promise<Set<string>> {
    if (!this.client) {
      throw new Error('Telegram client not connected');
    }

    const userIds = new Set<string>();
    const result = await this.client.getDialogs({ limit });
    for (const dialog of result) {
      if (!dialog.isUser) continue;
      const entity = dialog.entity as any;
      if (entity?.id != null) {
        userIds.add(entity.id.toString());
      }
    }
    return userIds;
  }

  /**
   * Authoritatively check whether a 1-on-1 chat with the given user has any
   * message history. The dialog list (getDialogs) only contains open/recent
   * conversations, so cleared or old chats are missing from it even though
   * history still exists - this checks history directly.
   *
   * Returns true if at least one message exists in the chat.
   */
  async hasChatHistory(userId: string): Promise<boolean> {
    if (!this.client) {
      throw new Error('Telegram client not connected');
    }
    try {
      const msgs = await this.client.getMessages(userId, { limit: 1 });
      return msgs.length > 0;
    } catch {
      // If we can't resolve/read the chat, be conservative and treat it as
      // having history so we never propose deleting it.
      return true;
    }
  }

  /**
   * Delete saved contacts from the Telegram account (server-side / all devices).
   *
   * Accepts the contact id + accessHash pairs returned by getContacts(). Note:
   * this removes the contact entry only — it does not delete the chat history or
   * block the user.
   */
  async deleteContacts(refs: Array<{ id: string; accessHash?: string }>): Promise<void> {
    if (!this.client) {
      throw new Error('Telegram client not connected');
    }
    if (refs.length === 0) return;

    const inputUsers = refs.map(
      (r) =>
        new Api.InputUser({
          userId: BigInt(r.id) as any,
          accessHash: BigInt(r.accessHash ?? '0') as any,
        })
    );

    // Chunk to keep each request small.
    const CHUNK = 50;
    for (let i = 0; i < inputUsers.length; i += CHUNK) {
      const batch = inputUsers.slice(i, i + CHUNK);
      await this.client.invoke(new Api.contacts.DeleteContacts({ id: batch }));
    }
  }

  /**
   * Extract media info from a GramJS message media object
   */
  private extractMediaInfo(media: Api.TypeMessageMedia): MediaInfo | null {
    if (media instanceof Api.MessageMediaPhoto) {
      const photo = media.photo;
      if (photo instanceof Api.Photo) {
        // Get the largest photo size
        let maxSize = 0;
        let width = 0;
        let height = 0;
        for (const size of photo.sizes) {
          if (size instanceof Api.PhotoSize || size instanceof Api.PhotoSizeProgressive) {
            const s = size as any;
            if (s.size && s.size > maxSize) {
              maxSize = s.size;
              width = s.w || 0;
              height = s.h || 0;
            }
          }
        }
        return {
          type: 'photo',
          extension: '.jpg',
          size: maxSize,
          width,
          height,
        };
      }
      return { type: 'photo', extension: '.jpg' };
    }

    if (media instanceof Api.MessageMediaDocument) {
      const doc = media.document;
      if (doc instanceof Api.Document) {
        let type: MediaType = 'document';
        let extension = '';
        let filename: string | undefined;
        let width: number | undefined;
        let height: number | undefined;
        let duration: number | undefined;

        // Check attributes for type
        for (const attr of doc.attributes) {
          if (attr instanceof Api.DocumentAttributeVideo) {
            type = attr.roundMessage ? 'video' : 'video';
            extension = '.mp4';
            width = attr.w;
            height = attr.h;
            duration = attr.duration;
          } else if (attr instanceof Api.DocumentAttributeAudio) {
            type = attr.voice ? 'voice' : 'audio';
            extension = attr.voice ? '.ogg' : '.mp3';
            duration = attr.duration;
          } else if (attr instanceof Api.DocumentAttributeSticker) {
            type = 'sticker';
            extension = '.webp';
          } else if (attr instanceof Api.DocumentAttributeAnimated) {
            type = 'gif';
            extension = '.mp4';
          } else if (attr instanceof Api.DocumentAttributeFilename) {
            filename = attr.fileName;
            if (!extension) {
              extension = extname(attr.fileName) || '';
            }
          } else if (attr instanceof Api.DocumentAttributeImageSize) {
            width = attr.w;
            height = attr.h;
          }
        }

        return {
          type,
          extension,
          size: Number(doc.size),
          filename,
          width,
          height,
          duration,
          mimeType: doc.mimeType,
        };
      }
    }

    return null;
  }

  /**
   * Get media info from a message
   * @param chatId - Chat identifier
   * @param messageId - Message ID
   */
  async getMediaInfo(chatId: string | number | ResolvedChat, messageId: number): Promise<MediaInfo | null> {
    if (!this.client) {
      throw new Error('Telegram client not connected');
    }

    parseMessageId(String(messageId));
    const resolved = await this.resolveChat(chatId);
    const messages = await this.client.getMessages(resolved.inputEntity, { ids: messageId });

    if (messages.length === 0) {
      throw new Error(`Message #${messageId} not found`);
    }

    const msg = messages[0];
    assertMessagePeer(msg, String(resolved.id));
    if (!msg.media) {
      return null;
    }

    const info = this.extractMediaInfo(msg.media);
    return info ? {...info, chatId: String(resolved.id), messageId} : null;
  }

  /**
   * Download media from a message
   * @param chatId - Chat identifier
   * @param messageId - Message ID
   * @param options.outputPath - Optional custom output path
   * @param options.progressCallback - Optional progress callback
   */
  async downloadMedia(
    chatId: string | number | ResolvedChat,
    messageId: number,
    options?: {
      outputPath?: string;
      progressCallback?: (downloaded: { toJSNumber(): number }, total: { toJSNumber(): number }) => void;
    }
  ): Promise<DownloadResult> {
    if (!this.client) {
      throw new Error('Telegram client not connected');
    }

    const resolved = await this.resolveChat(chatId);
    const messages = await this.client.getMessages(resolved.inputEntity, { ids: messageId });

    if (messages.length === 0) {
      throw new Error(`Message #${messageId} not found`);
    }

    const msg = messages[0];
    assertMessagePeer(msg, String(resolved.id));
    if (!msg.media) {
      throw new Error(`Message #${messageId} has no media`);
    }

    const mediaInfo = this.extractMediaInfo(msg.media);
    if (!mediaInfo) {
      throw new Error(`Unsupported media type in message #${messageId}`);
    }

    // Download the media
    const buffer = await this.client.downloadMedia(msg.media, {
      progressCallback: options?.progressCallback,
    });

    if (!buffer) {
      throw new Error('Failed to download media');
    }

    // Determine output path
    let filepath: string;
    let filename: string;

    if (options?.outputPath) {
      filepath = options.outputPath;
      filename = filepath.split(/[/\\]/).pop() || `chat_${resolved.id}_msg_${messageId}${mediaInfo.extension}`;
    } else {
      // Create directory structure
      const typeDir = this.getMediaTypeDir(mediaInfo.type);
      if (!existsSync(typeDir)) {
        mkdirSync(typeDir, { recursive: true });
      }

      // Build filename: msg_{messageId}_{originalFilename}.{extension}
      if (mediaInfo.filename) {
        filename = `chat_${resolved.id}_msg_${messageId}_${basename(mediaInfo.filename.replaceAll('\\\\', '/'))}`;
      } else {
        filename = `chat_${resolved.id}_msg_${messageId}${mediaInfo.extension}`;
      }
      filepath = join(typeDir, filename);
    }

    // Write the file
    writeFileSync(filepath, buffer);

    return {
      chatId: String(resolved.id),
      messageId,
      filepath,
      type: mediaInfo.type,
      size: buffer.length,
      filename,
    };
  }

  /**
   * Get the media type directory path
   */
  private getMediaTypeDir(type: MediaType): string {
    const typeMap: Record<MediaType, 'photos' | 'videos' | 'documents' | 'voice' | 'audio' | 'stickers'> = {
      photo: 'photos',
      video: 'videos',
      document: 'documents',
      voice: 'voice',
      audio: 'audio',
      sticker: 'stickers',
      gif: 'videos',
      unsupported: 'documents',
    };
    return getMediaTypeDir(typeMap[type]);
  }

  /**
   * List messages with media in a chat
   * @param chatId - Chat identifier
   * @param options.limit - Max messages to check (default 50)
   * @param options.type - Filter by media type
   */
  async listMedia(
    chatId: string | number | ResolvedChat,
    options?: {
      limit?: number;
      type?: MediaType | 'all';
    }
  ): Promise<MediaMessage[]> {
    if (!this.client) {
      throw new Error('Telegram client not connected');
    }

    const { limit = 50, type = 'all' } = options || {};
    const resolved = await this.resolveChat(chatId);
    const result: MediaMessage[] = [];

    // Fetch messages - we might need to fetch more to find enough with media
    const messages = await this.client.getMessages(resolved.inputEntity, { limit: limit * 2 });

    for (const msg of messages) {
      if (result.length >= limit) break;

      if (!msg.media) continue;

      const mediaInfo = this.extractMediaInfo(msg.media);
      if (!mediaInfo) continue;

      // Filter by type if specified
      if (type !== 'all' && mediaInfo.type !== type) continue;

      const sender = msg.sender as any;
      const groupedId = (msg as any).groupedId?.toString();

      result.push({
        messageId: msg.id,
        mediaInfo,
        date: new Date(msg.date * 1000),
        sender: sender?.firstName || sender?.username || sender?.title || 'Unknown',
        chatId: resolved.id,
        chatTitle: resolved.title,
        text: messageText(msg) || undefined,
        groupedId,
      });
    }

    return result;
  }

  /**
   * List media grouped by groupedId (for albums/media groups)
   */
  async listMediaGrouped(
    chatId: string | number,
    options?: {
      limit?: number;
      type?: MediaType | 'all';
    }
  ): Promise<Array<MediaMessage | MediaGroup>> {
    const mediaList = await this.listMedia(chatId, options);

    // Group by groupedId
    const groups = new Map<string, MediaMessage[]>();
    const standalone: MediaMessage[] = [];

    for (const item of mediaList) {
      if (item.groupedId) {
        const existing = groups.get(item.groupedId) || [];
        existing.push(item);
        groups.set(item.groupedId, existing);
      } else {
        standalone.push(item);
      }
    }

    // Convert to result array
    const result: Array<MediaMessage | MediaGroup> = [];

    // Add grouped items
    for (const [groupedId, messages] of groups) {
      // Sort by messageId to get consistent order
      messages.sort((a, b) => a.messageId - b.messageId);
      const first = messages[0];

      result.push({
        groupedId,
        messages,
        date: first.date,
        sender: first.sender,
        chatId: first.chatId,
        chatTitle: first.chatTitle,
        text: messages.find(m => m.text)?.text,
      });
    }

    // Add standalone items
    result.push(...standalone);

    // Sort by date descending
    result.sort((a, b) => {
      const dateA = 'messages' in a ? a.date : a.date;
      const dateB = 'messages' in b ? b.date : b.date;
      return dateB.getTime() - dateA.getTime();
    });

    return result;
  }

  /**
   * Download all media from a group (album)
   */
  async downloadMediaGroup(
    chatId: string | number,
    messageIds: number[],
    options?: {
      outputPath?: string;
    }
  ): Promise<DownloadResult[]> {
    const results: DownloadResult[] = [];

    for (const messageId of messageIds) {
      const result = await this.downloadMedia(chatId, messageId, options);
      results.push(result);
    }

    return results;
  }

  /**
   * Create a new session interactively (for auth command)
   */
  static async createSession(
    apiId: number,
    apiHash: string,
    callbacks: {
      getPhoneNumber: () => Promise<string>;
      getPhoneCode: () => Promise<string>;
      getPassword: () => Promise<string>;
    }
  ): Promise<string> {
    const session = new StringSession('');
    const client = new TelegramClient(session, apiId, apiHash, {
      connectionRetries: 3,
    });

    await client.start({
      phoneNumber: callbacks.getPhoneNumber,
      phoneCode: callbacks.getPhoneCode,
      password: callbacks.getPassword,
      onError: (err) => console.error('Auth error:', err),
    });

    const sessionString = client.session.save() as unknown as string;
    await client.disconnect();
    return sessionString;
  }
}

export default TelegramService;
