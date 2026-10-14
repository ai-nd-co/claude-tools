// Telegram message sync service - fetches messages and stores in SQLite

import './telegram-schema.js'; // must precede the telegram package
import { resolvePeer, peerId, assertMessagePeer, type PeerReference } from './telegram-peer.js';
import { messageText } from './telegram-rich.js';
import { TelegramClient, Api } from 'telegram';
import { getDatabase, type MessageRow, type SyncStateRow } from '../db/index.js';

export interface SyncOptions {
  months: number;
  force?: boolean;
  onProgress?: (count: number, oldestDate: Date) => void;
}

export interface SyncResult {
  chatId: string;
  chatTitle: string;
  messagesAdded: number;
  oldestMessageDate: Date | null;
  earlyTerminated: boolean;
}

const BATCH_SIZE = 100;
const BATCH_DELAY_MS = 1500; // 1.5 seconds between batches
const EARLY_TERMINATION_THRESHOLD = 5; // Stop after N consecutive cached messages

/**
 * Sleep for a specified duration
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Calculate cutoff timestamp for sync duration
 */
function getCutoffTimestamp(months: number): number {
  const now = Date.now();
  const cutoff = now - (months * 30 * 24 * 60 * 60 * 1000);
  return Math.floor(cutoff / 1000); // Convert to seconds
}

/**
 * Get sync state for a chat
 */
export function getSyncState(chatId: string): SyncStateRow | null {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM sync_state WHERE chat_id = ?');
  return stmt.get(chatId) as SyncStateRow | null;
}

/**
 * Update sync state for a chat
 */
export function updateSyncState(
  chatId: string,
  chatTitle: string,
  lastMessageId: number | null,
  oldestMessageId: number | null,
  messageCount: number
): void {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO sync_state (chat_id, chat_title, last_message_id, oldest_message_id, message_count, last_sync_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET
      chat_title = excluded.chat_title,
      last_message_id = COALESCE(excluded.last_message_id, last_message_id),
      oldest_message_id = COALESCE(excluded.oldest_message_id, oldest_message_id),
      message_count = excluded.message_count,
      last_sync_at = excluded.last_sync_at
  `);
  stmt.run(chatId, chatTitle, lastMessageId, oldestMessageId, messageCount, Math.floor(Date.now() / 1000));
}

/**
 * Serialized entity for storage
 */
interface SerializedEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;        // For textUrl entities
  userId?: string;     // For mentionName entities
  language?: string;   // For pre (code block) entities
}

/**
 * Extract serializable entities from Telegram message
 */
function extractEntities(entities: any[] | undefined): SerializedEntity[] | null {
  if (!entities || entities.length === 0) return null;

  const serialized: SerializedEntity[] = [];

  for (const entity of entities) {
    const base: SerializedEntity = {
      type: entity.className || entity.constructor?.name || 'Unknown',
      offset: entity.offset,
      length: entity.length,
    };

    // Extract URL for textUrl entities (this is the key one for hyperlinks)
    if (entity.url) {
      base.url = entity.url;
    }

    // Extract userId for mentions
    if (entity.userId) {
      base.userId = entity.userId.toString();
    }

    // Extract language for code blocks
    if (entity.language) {
      base.language = entity.language;
    }

    serialized.push(base);
  }

  return serialized.length > 0 ? serialized : null;
}

/**
 * Insert or update a message in the database
 */
function upsertMessage(msg: {
  id: number;
  chatId: string;
  chatTitle: string;
  sender: string;
  text: string;
  date: number;
  replyToId: number | null;
  replyToPeerId?: string | null;
  hasMedia: boolean;
  mediaType: string | null;
  reactions?: Array<{ emoji: string; count: number }>;
  entities?: SerializedEntity[] | null;
}): void {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO messages (chat_id, id, chat_title, sender, text, date, reply_to_id, reply_to_peer_id, has_media, media_type, synced_at, reactions, entities)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_id, id) DO UPDATE SET
      chat_title = excluded.chat_title,
      sender = excluded.sender,
      text = excluded.text,
      reply_to_id = excluded.reply_to_id,
      reply_to_peer_id = excluded.reply_to_peer_id,
      date = excluded.date,
      has_media = excluded.has_media,
      media_type = excluded.media_type,
      synced_at = excluded.synced_at,
      reactions = excluded.reactions,
      entities = excluded.entities
  `);
  stmt.run(
    msg.chatId,
    msg.id,
    msg.chatTitle,
    msg.sender,
    msg.text,
    msg.date,
    msg.replyToId,
    msg.replyToPeerId || null,
    msg.hasMedia ? 1 : 0,
    msg.mediaType,
    Math.floor(Date.now() / 1000),
    msg.reactions ? JSON.stringify(msg.reactions) : null,
    msg.entities ? JSON.stringify(msg.entities) : null
  );
}

/**
 * Insert or update a message from API data (public wrapper for caching on-demand fetches)
 */
export function upsertMessageFromApi(msg: {
  reactions?: Array<{emoji:string;count:number}>;
  entities?: SerializedEntity[] | null;
  id: number;
  chatId: string;
  chatTitle: string;
  sender: string;
  text: string;
  date: number;
  replyToId: number | null;
  replyToPeerId?: string | null;
  hasMedia: boolean;
  mediaType: string | null;
}): void {
  upsertMessage({
    reactions:msg.reactions,
    entities:msg.entities,
    id: msg.id,
    chatId: msg.chatId,
    chatTitle: msg.chatTitle,
    sender: msg.sender,
    text: msg.text,
    date: msg.date,
    replyToId: msg.replyToId,
    replyToPeerId: msg.replyToPeerId,
    hasMedia: msg.hasMedia,
    mediaType: msg.mediaType,
  });
}

/**
 * Check if a message already exists in the database
 */
function messageExists(chatId: string, messageId: number): boolean {
  const db = getDatabase();
  const stmt = db.prepare('SELECT 1 FROM messages WHERE chat_id = ? AND id = ? LIMIT 1');
  return stmt.get(chatId, messageId) !== undefined;
}

/**
 * Get message count for a chat
 */
export function getMessageCount(chatId?: string): number {
  const db = getDatabase();
  if (chatId) {
    const stmt = db.prepare('SELECT COUNT(*) as count FROM messages WHERE chat_id = ?');
    const result = stmt.get(chatId) as { count: number };
    return result.count;
  } else {
    const stmt = db.prepare('SELECT COUNT(*) as count FROM messages');
    const result = stmt.get() as { count: number };
    return result.count;
  }
}

/**
 * Get list of synced chats
 */
export function getSyncedChats(): SyncStateRow[] {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM sync_state ORDER BY last_sync_at DESC');
  return stmt.all() as SyncStateRow[];
}

/**
 * Get date range (oldest and newest message dates) for a chat
 */
export function getChatDateRange(chatId: string): { oldest: Date | null; newest: Date | null } {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT MIN(date) as oldest, MAX(date) as newest
    FROM messages
    WHERE chat_id = ?
  `);
  const result = stmt.get(chatId) as { oldest: number | null; newest: number | null };
  return {
    oldest: result.oldest ? new Date(result.oldest * 1000) : null,
    newest: result.newest ? new Date(result.newest * 1000) : null,
  };
}

/**
 * Resolve chat entity and get normalized ID and title
 * Supports: "me", chat names, usernames (@user), numeric IDs, negative IDs (-100...)
 */
async function resolveChatEntity(
  client: TelegramClient,
  chatId: string | number | PeerReference
): Promise<{ id: string; title: string; entity: any }> {
  return resolvePeer(client, chatId);
}

/**
 * Sync messages from a chat to the local database
 */
export async function syncChat(
  client: TelegramClient,
  chatId: string | number | PeerReference,
  options: SyncOptions
): Promise<SyncResult> {
  const cutoffTimestamp = getCutoffTimestamp(options.months);
  const { id: resolvedChatId, title: chatTitle, entity } = await resolveChatEntity(client, chatId);

  // Get existing sync state
  const syncState = getSyncState(resolvedChatId);
  let minId: number | undefined;

  // For incremental sync, start after the last synced message
  if (!options.force && syncState?.last_message_id) {
    minId = syncState.last_message_id;
  }

  let messagesAdded = 0;
  let oldestMessageDate: Date | null = null;
  let newestMessageId: number | null = null;
  let oldestMessageId: number | null = syncState?.oldest_message_id || null;
  let offsetId: number | undefined;
  let reachedCutoff = false;
  let consecutiveCachedCount = 0;
  let earlyTerminated = false;

  // Fetch messages in batches - use the resolved entity for fetching
  while (!reachedCutoff) {
    const fetchOptions: any = {
      limit: BATCH_SIZE,
    };

    if (offsetId) {
      fetchOptions.offsetId = offsetId;
    }

    if (minId) {
      fetchOptions.minId = minId;
    }

    let messages;
    try {
      messages = await client.getMessages(entity, fetchOptions);
    } catch (err) {
      const errMsg = (err as Error).message;
      // GramJS throws "Request not set yet" on disconnect - treat as end of messages
      if (errMsg.includes('Request not set yet') ||
          errMsg.includes('TIMEOUT') ||
          errMsg.includes('CONNECTION_')) {
        break; // Exit loop but save what we have
      }
      throw err; // Re-throw other errors
    }

    if (messages.length === 0) {
      break;
    }

    // Process each message
    for (const msg of messages) {
      if (!msg || (msg as any).className === 'MessageEmpty') continue;
      assertMessagePeer(msg, resolvedChatId);
      const msgDate = msg.date; // Unix timestamp in seconds

      // Check if we've reached the cutoff date
      if (msgDate < cutoffTimestamp) {
        reachedCutoff = true;
        break;
      }

      // Early termination: skip messages already in cache
      if (!options.force && messageExists(resolvedChatId, msg.id)) {
        consecutiveCachedCount++;
        if (consecutiveCachedCount >= EARLY_TERMINATION_THRESHOLD) {
          earlyTerminated = true;
          reachedCutoff = true;
          break;
        }
        // Still track oldest for offset pagination
        const currentDate = new Date(msgDate * 1000);
        if (!oldestMessageDate || currentDate < oldestMessageDate) {
          oldestMessageDate = currentDate;
        }
        continue;
      }
      consecutiveCachedCount = 0;

      // Extract message data
      const sender = msg.sender as any;
      const senderName = sender?.firstName || sender?.username || sender?.title || 'Unknown';

      // Check for media
      let hasMedia = false;
      let mediaType: string | null = null;
      const msgAny = msg as any;
      if (msgAny.media) {
        hasMedia = true;
        if (msgAny.media.photo) mediaType = 'photo';
        else if (msgAny.media.document) {
          const mimeType = msgAny.media.document.mimeType || '';
          if (mimeType.startsWith('video')) mediaType = 'video';
          else if (mimeType.startsWith('audio')) mediaType = 'audio';
          else mediaType = 'document';
        }
        else if (msgAny.media.webpage) mediaType = 'webpage';
        else mediaType = 'other';
      }

      // Get reply info
      const replyToId = msgAny.replyTo?.replyToMsgId || null;

      // Extract reactions
      const reactions: Array<{ emoji: string; count: number }> = [];
      if (msgAny.reactions?.results) {
        for (const r of msgAny.reactions.results) {
          const emoji = r.reaction?.emoticon || r.reaction?.documentId?.toString();
          if (emoji) {
            reactions.push({ emoji, count: r.count || 1 });
          }
        }
      }

      // Extract entities (links, bold, italic, etc.)
      const entities = extractEntities(msgAny.entities);

      // Insert into database
      upsertMessage({
        id: msg.id,
        chatId: resolvedChatId,
        chatTitle,
        sender: senderName,
        text: messageText(msg),
        date: msgDate,
        replyToId,
        replyToPeerId: msgAny.replyTo?.replyToPeerId ? peerId(msgAny.replyTo.replyToPeerId) : null,
        hasMedia,
        mediaType,
        reactions: reactions.length > 0 ? reactions : undefined,
        entities,
      });

      messagesAdded++;

      // Track newest and oldest message IDs
      if (!newestMessageId || msg.id > newestMessageId) {
        newestMessageId = msg.id;
      }
      if (!oldestMessageId || msg.id < oldestMessageId) {
        oldestMessageId = msg.id;
      }

      // Track oldest date for progress
      const currentDate = new Date(msgDate * 1000);
      if (!oldestMessageDate || currentDate < oldestMessageDate) {
        oldestMessageDate = currentDate;
      }
    }

    // Progress callback
    if (options.onProgress && oldestMessageDate) {
      options.onProgress(messagesAdded, oldestMessageDate);
    }

    // Get the offset for the next batch (oldest message in current batch)
    const lastMessage = messages[messages.length - 1];
    if (lastMessage) {
      offsetId = lastMessage.id;
    }

    // Rate limiting - wait between batches
    if (!reachedCutoff && messages.length === BATCH_SIZE) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  // Update sync state
  const totalCount = getMessageCount(resolvedChatId);
  updateSyncState(resolvedChatId, chatTitle, newestMessageId, oldestMessageId, totalCount);

  return {
    chatId: resolvedChatId,
    chatTitle,
    messagesAdded,
    oldestMessageDate,
    earlyTerminated,
  };
}

/**
 * Sync all chats
 */
export async function syncAllChats(
  client: TelegramClient,
  options: SyncOptions,
  onChatStart?: (chatTitle: string) => void
): Promise<SyncResult[]> {
  const dialogs = await client.getDialogs({ limit: 50 });
  const results: SyncResult[] = [];

  for (const dialog of dialogs) {
    const entity = dialog.entity as any;
    const chatId = entity ? peerId(entity) : null;

    if (!chatId) continue;

    if (onChatStart) {
      onChatStart(dialog.title || 'Unknown');
    }

    try {
      const result = await syncChat(client, {id:chatId, title:dialog.title || 'Unknown', inputEntity:dialog.inputEntity || entity, entity}, options);
      results.push(result);
    } catch (err) {
      // Skip chats that fail (e.g., deleted, restricted)
      console.error(`Failed to sync "${dialog.title}": ${(err as Error).message}`);
    }

    // Delay between chats
    await sleep(BATCH_DELAY_MS);
  }

  return results;
}
