// Telegram semantic search service - delegates to unified embedding service

import { getDatabase, getCacheGeneration, type MessageRow } from '../db/index.js';
import { generateEmbedding, isOllamaAvailable } from './embeddings.js';
import {
  ensureTelegramEmbeddingGeneration,
  storeEmbedding as storeUnifiedEmbedding,
  hasEmbedding as hasUnifiedEmbedding,
  getEmbeddingCount as getUnifiedEmbeddingCount,
  semanticSearch as unifiedSemanticSearch,
  type SemanticSearchResult as UnifiedSearchResult,
} from './embedding-service.js';
import { findClustersForMessages } from './telegram-cluster.js';

export interface SemanticSearchResult {
  id: number;
  chatId: string;
  chatTitle: string;
  sender: string;
  text: string;
  date: Date;
  distance: number;
  similarity: number;
  clusterId?: number;
}

/**
 * Check if semantic search is available
 */
export async function isSemanticSearchAvailable(): Promise<{ available: boolean; reason?: string }> {
  const ollamaOk = await isOllamaAvailable();
  if (!ollamaOk) {
    return { available: false, reason: 'Ollama not running. Start with: docker compose up -d' };
  }

  const count = getEmbeddingCount();
  if (count === 0) {
    return { available: false, reason: 'No embeddings generated. Run: telegram embed --generate' };
  }

  return { available: true };
}

/**
 * Build the unified-store content id for a message.
 * Message ids repeat across chats, so the key must include the chat.
 */
function messageContentId(chatId: string, messageId: number): string {
  return `tg3:${getCacheGeneration()}:${chatId}:${messageId}`;
}

/**
 * Store embedding for a message (delegates to unified service)
 */
export function storeEmbedding(chatId: string, messageId: number, embedding: number[]): void {
  storeUnifiedEmbedding(
    { type: 'message', id: messageContentId(chatId, messageId), text: '' },
    embedding
  );
}

/**
 * Check if a message has an embedding
 */
export function hasEmbedding(chatId: string, messageId: number): boolean {
  return hasUnifiedEmbedding('message', messageContentId(chatId, messageId));
}

/**
 * Get count of messages with embeddings
 */
export function getEmbeddingCount(): number {
  return getUnifiedEmbeddingCount('message');
}

/**
 * Get messages that don't have embeddings yet
 * @param chatId - Optional chat ID to filter by (if not provided, gets from all chats)
 * @param limit - Maximum number of messages to return
 */
export function getMessagesWithoutEmbeddings(limit: number = 100, chatId?: string): MessageRow[] {
  const db = getDatabase();

  // Build query with optional chat filter
  let sql = `
    SELECT * FROM messages
    WHERE text IS NOT NULL AND text != ''
  `;
  const params: any[] = [];

  if (chatId) {
    sql += ' AND chat_id = ?';
    params.push(chatId);
  }

  // Handle Infinity by removing LIMIT clause
  const effectiveLimit = Number.isFinite(limit) ? limit * 2 : 1000000;
  sql += ' ORDER BY date DESC LIMIT ?';
  params.push(effectiveLimit);

  const messagesStmt = db.prepare(sql);
  const allMessages = messagesStmt.all(...params) as MessageRow[];

  // Filter out ones that already have embeddings
  const result: MessageRow[] = [];
  for (const msg of allMessages) {
    if (!hasEmbedding(msg.chat_id, msg.id)) {
      result.push(msg);
      if (result.length >= limit) break;
    }
  }

  return result;
}

/**
 * Generate and store embeddings for messages that don't have them
 * @param limit - Maximum number of embeddings to generate
 * @param onProgress - Progress callback
 * @param chatId - Optional chat ID to filter by
 */
export async function generateMissingEmbeddings(
  limit: number = 100,
  onProgress?: (completed: number, total: number, text: string) => void,
  chatId?: string
): Promise<number> {
  const messages = getMessagesWithoutEmbeddings(limit, chatId);

  if (messages.length === 0) {
    return 0;
  }

  let count = 0;
  for (const msg of messages) {
    if (!msg.text) continue;

    try {
      const embedding = await generateEmbedding(msg.text);
      // Store with full content info for unified service (keyed per-chat)
      storeUnifiedEmbedding(
        { type: 'message', id: messageContentId(msg.chat_id, msg.id), text: msg.text },
        embedding
      );
      count++;

      if (onProgress) {
        const preview = msg.text.slice(0, 50).replace(/\n/g, ' ');
        onProgress(count, messages.length, preview);
      }
    } catch (err) {
      console.error(`Failed to embed message ${msg.id}:`, (err as Error).message);
    }
  }

  return count;
}

/**
 * Semantic search - uses unified service and enriches with message data
 * @param query - Search query
 * @param limit - Maximum results
 * @param chatId - Optional chat ID to filter results
 */
export async function semanticSearch(
  query: string,
  limit: number = 20,
  chatId?: string
): Promise<SemanticSearchResult[]> {
  ensureTelegramEmbeddingGeneration();
  // Get more results if filtering by chat (we'll filter after)
  const fetchLimit = chatId ? limit * 5 : limit;

  // Get results from unified service
  const results = await unifiedSemanticSearch(query, 'message', fetchLimit);

  // Enrich with message data from telegram.db
  let enriched = enrichMessageResults(results);

  // Filter by chat if specified
  if (chatId) {
    enriched = enriched.filter(r => r.chatId === chatId).slice(0, limit);
  }

  return enriched;
}

/**
 * Enrich unified search results with message data
 */
function enrichMessageResults(results: UnifiedSearchResult[]): SemanticSearchResult[] {
  if (results.length === 0) return [];

  const db = getDatabase();

  // content_id is `${chatId}:${messageId}`. Split on the LAST colon since a
  // chat id is always numeric and the message id has no colon.
  const parseContentId = (id: string): { chatId: string; messageId: number } | null => {
    const prefix = `tg3:${getCacheGeneration()}:`;
    if (!id.startsWith(prefix)) return null;
    id = id.slice(prefix.length);
    const sep = id.lastIndexOf(':');
    if (sep < 0) return null;
    const messageId = parseInt(id.slice(sep + 1), 10);
    if (Number.isNaN(messageId)) return null;
    return { chatId: id.slice(0, sep), messageId };
  };

  const pairs = results
    .map(r => parseContentId(r.contentId))
    .filter((p): p is { chatId: string; messageId: number } => p !== null);

  if (pairs.length === 0) return [];

  const placeholders = pairs.map(() => '(?, ?)').join(',');
  const params: any[] = [];
  for (const p of pairs) {
    params.push(p.chatId, p.messageId);
  }

  const messages = db.prepare(`
    SELECT * FROM messages WHERE (chat_id, id) IN (${placeholders})
  `).all(...params) as MessageRow[];

  // Map keyed by `${chatId}:${id}` for quick lookup
  const messageMap = new Map<string, MessageRow>();
  for (const msg of messages) {
    messageMap.set(`${msg.chat_id}:${msg.id}`, msg);
  }

  // Batch lookup cluster IDs
  const clusterMap = findClustersForMessages(
    pairs.map(p => ({ chatId: p.chatId, messageId: p.messageId }))
  );

  // Build enriched results maintaining order
  const enriched: SemanticSearchResult[] = [];
  for (const result of results) {
    const parsed = parseContentId(result.contentId);
    if (!parsed) continue;
    const key = `${parsed.chatId}:${parsed.messageId}`;
    const msg = messageMap.get(key);
    if (!msg) continue;

    enriched.push({
      id: msg.id,
      chatId: msg.chat_id,
      chatTitle: msg.chat_title || '',
      sender: msg.sender || 'Unknown',
      text: msg.text || '',
      date: new Date(msg.date * 1000),
      distance: result.distance,
      similarity: result.similarity,
      clusterId: clusterMap.get(key),
    });
  }

  return enriched;
}
