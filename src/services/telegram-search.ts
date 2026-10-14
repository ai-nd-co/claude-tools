// Telegram message search service - FTS5 keyword and fuzzy search

import { getDatabase, getKnownPeers, type MessageRow } from '../db/index.js';
import { selectPeer } from './telegram-peer.js';
import { findClustersForMessages } from './telegram-cluster.js';

export interface SearchOptions {
  chatId?: string;
  fromDate?: Date;
  limit?: number;
  offset?: number;
  fuzzy?: boolean;
}

export interface SearchResult {
  /** Surrogate row id (internal join key); Telegram message id is `id`. */
  msgRowid?: number;
  id: number;
  chatId: string;
  chatTitle: string;
  sender: string;
  text: string;
  date: Date;
  replyToId: number | null;
  replyToPeerId?: string | null;
  hasMedia: boolean;
  mediaType: string | null;
  clusterId?: number;
  reactions?: Array<{ emoji: string; count: number }>;
  entities?: Array<{ type: string; offset: number; length: number; url?: string; userId?: string; language?: string }>;
}

export interface SearchResponse {
  results: SearchResult[];
  totalCount: number;
  page: number;
  perPage: number;
  totalPages: number;
}

/**
 * Convert a MessageRow to a SearchResult
 */
function rowToResult(row: MessageRow): SearchResult {
  let reactions: Array<{ emoji: string; count: number }> | undefined;
  if (row.reactions) {
    try {
      reactions = JSON.parse(row.reactions);
    } catch {
      // Ignore invalid JSON
    }
  }

  let entities: Array<{ type: string; offset: number; length: number; url?: string; userId?: string; language?: string }> | undefined;
  if (row.entities) {
    try {
      entities = JSON.parse(row.entities);
    } catch {
      // Ignore invalid JSON
    }
  }

  return {
    msgRowid: row.msg_rowid,
    id: row.id,
    chatId: row.chat_id,
    chatTitle: row.chat_title || '',
    sender: row.sender || 'Unknown',
    text: row.text || '',
    date: new Date(row.date * 1000),
    replyToId: row.reply_to_id,
    replyToPeerId: row.reply_to_peer_id,
    hasMedia: row.has_media === 1,
    mediaType: row.media_type,
    reactions,
    entities,
  };
}

/**
 * Escape special FTS5 characters in query
 */
function escapeFtsQuery(query: string): string {
  // FTS5 special characters: " * ^ - : ( )
  // Escape quotes and wrap in quotes for exact phrase matching
  return query.replace(/"/g, '""');
}

/**
 * Build FTS5 query from user input
 * - For fuzzy mode, add * suffix to each word for prefix matching
 * - For regular mode, use AND between words
 */
function buildFtsQuery(query: string, fuzzy: boolean): string {
  const words = query.trim().split(/\s+/).filter(w => w.length > 0);

  if (fuzzy) {
    // Fuzzy: prefix matching with *
    return words.map(w => `"${escapeFtsQuery(w)}"*`).join(' OR ');
  } else {
    // Exact: all words must match
    return words.map(w => `"${escapeFtsQuery(w)}"`).join(' AND ');
  }
}

/**
 * Count total matches for a query (for pagination)
 */
export function countMatches(query: string, options: SearchOptions = {}): number {
  const db = getDatabase();
  const ftsQuery = buildFtsQuery(query, options.fuzzy || false);

  let sql = `
    SELECT COUNT(*) as count
    FROM messages m
    JOIN messages_fts fts ON m.msg_rowid = fts.rowid
    WHERE messages_fts MATCH ?
  `;

  const params: any[] = [ftsQuery];

  if (options.chatId) {
    sql += ' AND m.chat_id = ?';
    params.push(options.chatId);
  }

  if (options.fromDate) {
    sql += ' AND m.date >= ?';
    params.push(Math.floor(options.fromDate.getTime() / 1000));
  }

  const stmt = db.prepare(sql);
  const result = stmt.get(...params) as { count: number };
  return result.count;
}

/**
 * Search messages using FTS5
 */
export function searchMessages(query: string, options: SearchOptions = {}): SearchResponse {
  const db = getDatabase();
  const ftsQuery = buildFtsQuery(query, options.fuzzy || false);

  const limit = options.limit || 20;
  const offset = options.offset || 0;
  const page = Math.floor(offset / limit) + 1;

  // Get total count first
  const totalCount = countMatches(query, options);
  const totalPages = Math.ceil(totalCount / limit);

  // Build search query
  let sql = `
    SELECT m.*
    FROM messages m
    JOIN messages_fts fts ON m.msg_rowid = fts.rowid
    WHERE messages_fts MATCH ?
  `;

  const params: any[] = [ftsQuery];

  if (options.chatId) {
    sql += ' AND m.chat_id = ?';
    params.push(options.chatId);
  }

  if (options.fromDate) {
    sql += ' AND m.date >= ?';
    params.push(Math.floor(options.fromDate.getTime() / 1000));
  }

  sql += ' ORDER BY m.date DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const stmt = db.prepare(sql);
  const rows = stmt.all(...params) as MessageRow[];

  // Batch lookup cluster IDs (keyed per-chat, since message ids repeat across chats)
  const clusterMap = findClustersForMessages(
    rows.map(r => ({ chatId: r.chat_id, messageId: r.id }))
  );

  // Convert to results with cluster info
  const results = rows.map(row => {
    const result = rowToResult(row);
    const clusterId = clusterMap.get(`${row.chat_id}:${row.id}`);
    if (clusterId !== undefined) {
      result.clusterId = clusterId;
    }
    return result;
  });

  return {
    results,
    totalCount,
    page,
    perPage: limit,
    totalPages,
  };
}

/**
 * Get messages around a specific message (for context reading).
 *
 * Telegram message ids are unique per-chat, so the chat must be supplied —
 * looking up by id alone would resolve to whichever chat happens to match.
 */
export function getMessagesAround(
  chatId: string,
  messageId: number,
  before: number = 5,
  after: number = 5
): SearchResult[] {
  const db = getDatabase();

  // First get the target message to find its date within the chat
  const targetStmt = db.prepare('SELECT * FROM messages WHERE chat_id = ? AND id = ?');
  const target = targetStmt.get(chatId, messageId) as MessageRow | undefined;

  if (!target) {
    return [];
  }

  // Get messages before the target
  const beforeStmt = db.prepare(`
    SELECT * FROM messages
    WHERE chat_id = ? AND (date < ? OR (date = ? AND id < ?))
    ORDER BY date DESC, id DESC
    LIMIT ?
  `);
  const beforeRows = beforeStmt.all(target.chat_id, target.date, target.date, target.id, before) as MessageRow[];

  // Get messages after the target
  const afterStmt = db.prepare(`
    SELECT * FROM messages
    WHERE chat_id = ? AND (date > ? OR (date = ? AND id > ?))
    ORDER BY date ASC, id ASC
    LIMIT ?
  `);
  const afterRows = afterStmt.all(target.chat_id, target.date, target.date, target.id, after) as MessageRow[];

  // Combine: before (reversed) + target + after
  const allRows = [...beforeRows.reverse(), target, ...afterRows];

  return allRows.map(rowToResult);
}

/**
 * Get a single message by its (chat, Telegram message id) pair.
 *
 * Message ids are per-chat, so `chatId` is required to resolve unambiguously.
 */
export function getMessage(chatId: string, messageId: number): SearchResult | null {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM messages WHERE chat_id = ? AND id = ?');
  const row = stmt.get(chatId, messageId) as MessageRow | undefined;

  if (!row) return null;
  return rowToResult(row);
}

/**
 * Find every chat that contains a message with the given Telegram id.
 *
 * Because message ids repeat across chats, a bare id may match multiple chats.
 * Callers use this to disambiguate (e.g. prompting for --chat).
 */
export function findMessagesByTelegramId(
  messageId: number
): Array<{ chatId: string; chatTitle: string; msgRowid: number }> {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT chat_id, chat_title, msg_rowid
    FROM messages
    WHERE id = ?
    ORDER BY date DESC, id DESC
  `).all(messageId) as Array<{ chat_id: string; chat_title: string | null; msg_rowid: number }>;

  return rows.map(r => ({
    chatId: r.chat_id,
    chatTitle: r.chat_title || '',
    msgRowid: r.msg_rowid,
  }));
}

/**
 * Check if database has any messages
 */
export function hasMessages(): boolean {
  const db = getDatabase();
  const stmt = db.prepare('SELECT COUNT(*) as count FROM messages');
  const result = stmt.get() as { count: number };
  return result.count > 0;
}

/**
 * Get the most recent sync timestamp across all chats
 * Returns null if no sync has occurred
 */
export function getLastSyncTime(): Date | null {
  const db = getDatabase();
  const stmt = db.prepare('SELECT MAX(last_sync_at) as last_sync FROM sync_state');
  const result = stmt.get() as { last_sync: number | null };
  return result.last_sync ? new Date(result.last_sync * 1000) : null;
}

/**
 * Resolve chat name to chat ID
 * Searches by exact match first, then partial match
 */
export function resolveChatId(chatName: string): string | null {
  if (chatName.toLowerCase() === 'me') return (getDatabase().prepare("SELECT value FROM cache_metadata WHERE key='account'").get() as {value:string}|undefined)?.value || null;
  if (chatName.startsWith('@')) {
    const rows=getDatabase().prepare('SELECT id FROM peer_registry WHERE username=?').all(chatName.slice(1).toLowerCase()) as Array<{id:string}>;
    if(rows.length>1) throw new Error('Ambiguous cached username; resolve it through Telegram');
    return rows[0]?.id || null;
  }
  return selectPeer(chatName, getKnownPeers())?.id || null;
}

/**
 * Get the most recent N messages from a chat (for cache-based reading)
 */
export function getRecentMessages(chatId: string, limit: number = 20): SearchResult[] {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT * FROM messages
    WHERE chat_id = ?
    ORDER BY date DESC, id DESC
    LIMIT ?
  `);
  const rows = stmt.all(chatId, limit) as MessageRow[];
  // Reverse so messages are in chronological order (oldest first)
  return rows.reverse().map(rowToResult);
}

/**
 * Recursively follow reply_to_id chain in SQLite
 * Returns the chain of replied-to messages (deepest first)
 */
export function resolveReplyChain(
  chatId: string,
  messageId: number,
  maxDepth: number = 2,
  visited: Set<string> = new Set()
): SearchResult[] {
  const key = `${chatId}:${messageId}`;
  if (visited.has(key) || visited.size >= maxDepth) {
    return [];
  }
  visited.add(key);

  // Reply targets are always in the same chat as the replying message.
  const message = getMessage(chatId, messageId);
  if (!message) return [];

  const chain: SearchResult[] = [message];

  if (message.replyToId && (!message.replyToPeerId || message.replyToPeerId === chatId)) {
    const parentChain = resolveReplyChain(chatId, message.replyToId, maxDepth, visited);
    chain.push(...parentChain);
  }

  return chain;
}

/**
 * Find reply targets whose message is not present in the given batch.
 *
 * Reply targets are same-chat, so membership and the returned targets are
 * tracked per-chat as (chatId, replyToId) pairs — a bare id would collide
 * across chats.
 */
export function findMissingReplyTargets(
  messages: SearchResult[]
): Array<{ chatId: string; replyToId: number }> {
  const present = new Set(messages.map(m => `${m.chatId}:${m.id}`));
  const missing = new Map<string, { chatId: string; replyToId: number }>();

  for (const msg of messages) {
    if (msg.replyToId == null || (msg.replyToPeerId && msg.replyToPeerId !== msg.chatId)) continue;
    const key = `${msg.chatId}:${msg.replyToId}`;
    if (!present.has(key)) {
      missing.set(key, { chatId: msg.chatId, replyToId: msg.replyToId });
    }
  }

  return [...missing.values()];
}

/**
 * Enrich messages with reply context from SQLite.
 * For each message whose replyToId points outside the batch,
 * resolve the replied-to message from the database.
 * Returns a map keyed `chatId:replyToId` -> resolved message (or null).
 */
export function enrichReplyContextFromDb(
  messages: SearchResult[],
  _maxDepth: number = 2
): Map<string, SearchResult | null> {
  const missing = findMissingReplyTargets(messages);
  const resolved = new Map<string, SearchResult | null>();

  for (const { chatId, replyToId } of missing) {
    resolved.set(`${chatId}:${replyToId}`, getMessage(chatId, replyToId));
  }

  return resolved;
}

/**
 * Get database statistics
 */
export function getDatabaseStats(): {
  totalMessages: number;
  chats: number;
  oldestMessage: Date | null;
  newestMessage: Date | null;
} {
  const db = getDatabase();

  const countStmt = db.prepare('SELECT COUNT(*) as count FROM messages');
  const countResult = countStmt.get() as { count: number };

  const chatsStmt = db.prepare('SELECT COUNT(DISTINCT chat_id) as count FROM messages');
  const chatsResult = chatsStmt.get() as { count: number };

  const oldestStmt = db.prepare('SELECT MIN(date) as date FROM messages');
  const oldestResult = oldestStmt.get() as { date: number | null };

  const newestStmt = db.prepare('SELECT MAX(date) as date FROM messages');
  const newestResult = newestStmt.get() as { date: number | null };

  return {
    totalMessages: countResult.count,
    chats: chatsResult.count,
    oldestMessage: oldestResult.date ? new Date(oldestResult.date * 1000) : null,
    newestMessage: newestResult.date ? new Date(newestResult.date * 1000) : null,
  };
}
