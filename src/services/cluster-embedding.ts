// Cluster embedding service - semantic embeddings for conversation clusters
// Uses overlapping windows for large clusters to capture multiple topics

import { getDatabase, getCacheGeneration, type MessageRow, ensureClusterTables, type ClusterRow } from '../db/index.js';
import { getEmbeddingsDb, type ContentType } from '../db/embeddings.js';
import { generateEmbedding, isOllamaAvailable } from './embeddings.js';
import {
  ensureTelegramEmbeddingGeneration,
  storeEmbedding as storeUnifiedEmbedding,
  hasEmbedding as hasUnifiedEmbedding,
  semanticSearch as unifiedSemanticSearch,
  getEmbeddingCount as getUnifiedEmbeddingCount,
} from './embedding-service.js';
import { getCluster, getClusterMessages } from './telegram-cluster.js';

// Configuration constants
const CLUSTER_WINDOW_SIZE = 5;        // Messages per window
const CLUSTER_WINDOW_OVERLAP = 2;     // Messages overlap between windows
const CLUSTER_MIN_SIZE = 3;           // Skip clusters smaller than this
const CLUSTER_MAX_TEXT_LENGTH = 2000; // Truncate window text if too long

export interface ClusterWindow {
  clusterId: number;
  windowIndex: number;
  messageIds: number[];
  text: string;
}

export interface ClusterSearchResult {
  clusterId: number;
  windowIndex: number;
  similarity: number;
  preview: string;
  messageCount: number;
  startTime: Date;
  endTime: Date;
  chatId: string;
  chatTitle: string;
}

/**
 * Generate overlapping windows for a cluster's messages
 * Small clusters (≤WINDOW_SIZE) get a single window
 * Large clusters get multiple overlapping windows
 */
export function generateClusterWindows(clusterId: number): ClusterWindow[] {
  const messages = getClusterMessages(clusterId);

  if (messages.length < CLUSTER_MIN_SIZE) {
    // Too small for meaningful clustering
    return [];
  }

  if (messages.length <= CLUSTER_WINDOW_SIZE) {
    // Single window for small clusters
    return [{
      clusterId,
      windowIndex: 0,
      messageIds: messages.map(m => m.id),
      text: getWindowText(messages),
    }];
  }

  // Generate overlapping windows
  const windows: ClusterWindow[] = [];
  const stride = CLUSTER_WINDOW_SIZE - CLUSTER_WINDOW_OVERLAP;

  for (let i = 0; i < messages.length; i += stride) {
    const windowMessages = messages.slice(i, i + CLUSTER_WINDOW_SIZE);

    // Skip tiny final windows (less than half the window size)
    if (windowMessages.length < Math.ceil(CLUSTER_WINDOW_SIZE / 2)) {
      break;
    }

    windows.push({
      clusterId,
      windowIndex: windows.length,
      messageIds: windowMessages.map(m => m.id),
      text: getWindowText(windowMessages),
    });

    // Stop if we've reached the end
    if (i + CLUSTER_WINDOW_SIZE >= messages.length) {
      break;
    }
  }

  return windows;
}

/**
 * Get concatenated text for a window of messages
 * Includes sender names for context
 */
function getWindowText(messages: MessageRow[]): string {
  const parts: string[] = [];

  for (const msg of messages) {
    if (!msg.text) continue;

    // Include sender for context
    const sender = msg.sender || 'Unknown';
    const text = msg.text.slice(0, 500); // Limit individual message length
    parts.push(`[${sender}]: ${text}`);
  }

  let combined = parts.join('\n\n');

  // Truncate if too long
  if (combined.length > CLUSTER_MAX_TEXT_LENGTH) {
    combined = combined.slice(0, CLUSTER_MAX_TEXT_LENGTH) + '...';
  }

  return combined;
}

/**
 * Generate content ID for a cluster window
 * Format: "clusterId" for single window, "clusterId:windowIndex" for multiple
 */
function getClusterContentId(clusterId: number, windowIndex: number, totalWindows: number): string {
  return `tg3:${getCacheGeneration()}:${clusterId}:${windowIndex}`;
}

/**
 * Parse content ID back to cluster ID and window index
 */
function parseClusterContentId(contentId: string): { clusterId: number; windowIndex: number } {
  const prefix = `tg3:${getCacheGeneration()}:`;
  if (!contentId.startsWith(prefix)) return {clusterId:NaN, windowIndex:NaN};
  contentId = contentId.slice(prefix.length);
  if (contentId.includes(':')) {
    const [clusterStr, windowStr] = contentId.split(':');
    return {
      clusterId: parseInt(clusterStr, 10),
      windowIndex: parseInt(windowStr, 10),
    };
  }
  return {
    clusterId: parseInt(contentId, 10),
    windowIndex: 0,
  };
}

/**
 * Check if a cluster has any embeddings
 */
export function hasClusterEmbedding(clusterId: number): boolean {
  // Check for both single-window and multi-window formats
  if (hasUnifiedEmbedding('cluster', getClusterContentId(clusterId, 0, 1))) {
    return true;
  }
  // Check for windowed format
  if (hasUnifiedEmbedding('cluster', getClusterContentId(clusterId, 0, 1))) {
    return true;
  }
  return false;
}

/**
 * Store embeddings for all windows of a cluster
 */
export async function storeClusterEmbeddings(clusterId: number): Promise<number> {
  const windows = generateClusterWindows(clusterId);

  if (windows.length === 0) {
    return 0;
  }

  let stored = 0;

  for (const window of windows) {
    // Skip windows with empty or whitespace-only text
    if (!window.text || window.text.trim().length === 0) {
      continue;
    }

    const contentId = getClusterContentId(clusterId, window.windowIndex, windows.length);

    // Skip if already embedded
    if (hasUnifiedEmbedding('cluster', contentId)) {
      continue;
    }

    try {
      const embedding = await generateEmbedding(window.text);
      storeUnifiedEmbedding(
        { type: 'cluster', id: contentId, text: window.text },
        embedding
      );
      stored++;
    } catch (err) {
      console.error(`Failed to embed cluster ${clusterId} window ${window.windowIndex}:`, (err as Error).message);
    }
  }

  return stored;
}

/**
 * Get clusters that don't have embeddings yet
 */
export function getClustersWithoutEmbeddings(chatId?: string, limit: number = 50): ClusterRow[] {
  const db = getDatabase();
  ensureClusterTables();
  const embeddingsDb = getEmbeddingsDb();

  // Get clusters, filtering by chat if specified
  let sql = `
    SELECT * FROM clusters
    WHERE message_count >= ?
  `;
  const params: any[] = [CLUSTER_MIN_SIZE];

  if (chatId) {
    sql += ' AND chat_id = ?';
    params.push(chatId);
  }

  // Handle Infinity by using a large but finite limit
  const effectiveLimit = Number.isFinite(limit) ? limit * 2 : 1000000;
  sql += ' ORDER BY end_time DESC LIMIT ?';
  params.push(effectiveLimit);

  const clusters = db.prepare(sql).all(...params) as ClusterRow[];

  // Filter out clusters that already have embeddings
  const result: ClusterRow[] = [];

  for (const cluster of clusters) {
    if (!hasClusterEmbedding(cluster.id)) {
      result.push(cluster);
      if (result.length >= limit) break;
    }
  }

  return result;
}

/**
 * Generate embeddings for all clusters without embeddings
 */
export async function generateMissingClusterEmbeddings(
  limit: number = 50,
  chatId?: string,
  onProgress?: (completed: number, total: number) => void
): Promise<number> {
  const clusters = getClustersWithoutEmbeddings(chatId, limit);

  if (clusters.length === 0) {
    return 0;
  }

  let totalStored = 0;

  for (let i = 0; i < clusters.length; i++) {
    const cluster = clusters[i];
    const stored = await storeClusterEmbeddings(cluster.id);
    totalStored += stored;

    if (onProgress) {
      onProgress(i + 1, clusters.length);
    }
  }

  return totalStored;
}

/**
 * Get count of cluster embeddings
 */
export function getClusterEmbeddingCount(): number {
  return getUnifiedEmbeddingCount('cluster');
}

/**
 * Search clusters by semantic similarity
 * Deduplicates results when multiple windows from same cluster match
 */
export async function searchClusters(
  query: string,
  limit: number = 10,
  chatId?: string
): Promise<ClusterSearchResult[]> {
  // Get more results to account for deduplication
  const fetchLimit = limit * 3;

  // Search using unified service
  ensureTelegramEmbeddingGeneration();
  const results = await unifiedSemanticSearch(query, 'cluster', fetchLimit);

  if (results.length === 0) {
    return [];
  }

  // Deduplicate by cluster ID (keep highest similarity)
  const clusterMap = new Map<number, { contentId: string; similarity: number }>();

  for (const result of results) {
    const { clusterId } = parseClusterContentId(result.contentId);

    const existing = clusterMap.get(clusterId);
    if (!existing || result.similarity > existing.similarity) {
      clusterMap.set(clusterId, {
        contentId: result.contentId,
        similarity: result.similarity,
      });
    }
  }

  // Enrich with cluster data
  const enriched: ClusterSearchResult[] = [];
  const db = getDatabase();

  for (const [clusterId, { contentId, similarity }] of clusterMap) {
    const cluster = getCluster(clusterId);
    if (!cluster) continue;

    // Filter by chat if specified
    if (chatId && cluster.chatId !== chatId) continue;

    // Get first message for preview and chat title
    const messages = getClusterMessages(clusterId);
    const firstMsg = messages[0];

    const preview = firstMsg?.text?.slice(0, 100).replace(/\n/g, ' ') || '';
    const chatTitle = firstMsg?.chat_title || '';

    const { windowIndex } = parseClusterContentId(contentId);

    enriched.push({
      clusterId,
      windowIndex,
      similarity,
      preview,
      messageCount: cluster.messageCount,
      startTime: cluster.startTime,
      endTime: cluster.endTime,
      chatId: cluster.chatId,
      chatTitle,
    });

    if (enriched.length >= limit) break;
  }

  // Sort by similarity (descending)
  enriched.sort((a, b) => b.similarity - a.similarity);

  return enriched;
}

/**
 * Check if cluster semantic search is available
 */
export async function isClusterSearchAvailable(): Promise<{
  available: boolean;
  reason?: string;
}> {
  const ollamaOk = await isOllamaAvailable();
  if (!ollamaOk) {
    return { available: false, reason: 'Ollama not running. Start with: docker compose up -d' };
  }

  const count = getClusterEmbeddingCount();
  if (count === 0) {
    return { available: false, reason: 'No cluster embeddings. Run: telegram sync <chat>' };
  }

  return { available: true };
}
