// Telegram message clustering service - groups messages into conversation clusters

import { deleteClusterEmbeddings } from './embedding-service.js';
import { getDatabase, ensureClusterTables, type MessageRow, type ClusterRow } from '../db/index.js';

// Clustering constants
const CLUSTER_GAP_SECONDS = 10 * 60; // 10 minutes
const MIN_CLUSTER_SIZE = 3;
const MAX_CLUSTER_SIZE = 50; // Split clusters larger than this by largest gap

export interface Cluster {
  id: number;
  chatId: string;
  startTime: Date;
  endTime: Date;
  messageCount: number;
  /** Surrogate row ids (messages.msg_rowid) of the first/last message. */
  firstMsgRowid: number;
  lastMsgRowid: number;
}

export interface ClusterWithPreview extends Cluster {
  preview: string; // First ~100 chars of first message
  chatTitle: string;
}

/**
 * Convert ClusterRow to Cluster
 */
function rowToCluster(row: ClusterRow): Cluster {
  return {
    id: row.id,
    chatId: row.chat_id,
    startTime: new Date(row.start_time * 1000),
    endTime: new Date(row.end_time * 1000),
    messageCount: row.message_count,
    firstMsgRowid: row.first_msg_rowid,
    lastMsgRowid: row.last_msg_rowid,
  };
}

// Temp cluster type for building
interface TempCluster {
  messages: MessageRow[];
  startTime: number;
  endTime: number;
}

/**
 * Split a large cluster by its largest time gap that doesn't break reply chains.
 * Recursively splits until all pieces are <= MAX_CLUSTER_SIZE.
 */
function splitClusterByLargestGap(cluster: TempCluster): TempCluster[] {
  if (cluster.messages.length <= MAX_CLUSTER_SIZE) {
    return [cluster];
  }

  // Build set of message IDs in this cluster for reply chain detection
  const messageIds = new Set(cluster.messages.map(m => m.id));

  // Find gaps between consecutive messages, excluding those that would break reply chains
  interface Gap {
    index: number; // Split AFTER this index
    gap: number;   // Time gap in seconds
  }

  const gaps: Gap[] = [];

  for (let i = 0; i < cluster.messages.length - 1; i++) {
    const current = cluster.messages[i];
    const next = cluster.messages[i + 1];

    // Don't split if next message replies to current or any message before it in this cluster
    if (next.reply_to_id && (!next.reply_to_peer_id || next.reply_to_peer_id === next.chat_id) && messageIds.has(next.reply_to_id)) {
      // Check if the reply target is in the first half (before split point)
      const replyTargetIdx = cluster.messages.findIndex(m => m.id === next.reply_to_id);
      if (replyTargetIdx <= i) {
        // This would break a reply chain - skip this gap
        continue;
      }
    }

    const gap = next.date - current.date;
    gaps.push({ index: i, gap });
  }

  // If no valid split points, return as-is (reply chains prevent splitting)
  if (gaps.length === 0) {
    return [cluster];
  }

  // Find largest gap
  gaps.sort((a, b) => b.gap - a.gap);
  const splitPoint = gaps[0].index;

  // Split into two clusters
  const firstMessages = cluster.messages.slice(0, splitPoint + 1);
  const secondMessages = cluster.messages.slice(splitPoint + 1);

  const first: TempCluster = {
    messages: firstMessages,
    startTime: firstMessages[0].date,
    endTime: firstMessages[firstMessages.length - 1].date,
  };

  const second: TempCluster = {
    messages: secondMessages,
    startTime: secondMessages[0].date,
    endTime: secondMessages[secondMessages.length - 1].date,
  };

  // Recursively split if still too large
  const result: TempCluster[] = [];
  result.push(...splitClusterByLargestGap(first));
  result.push(...splitClusterByLargestGap(second));

  return result;
}

/**
 * Build clusters for a specific chat
 * Algorithm:
 * 1. Time-based: Messages >10 minutes apart = new cluster
 * 2. Reply chains: If message B replies to message A in cluster X, B joins cluster X
 * 3. Minimum size: Clusters with <3 messages merge with adjacent cluster
 * 4. Maximum size: Clusters >50 messages are split by largest gap (respecting reply chains)
 */
export function buildClusters(chatId: string): number {
  const db = getDatabase();
  ensureClusterTables();
  const oldClusterIds = db.prepare('SELECT id FROM clusters WHERE chat_id=?').all(chatId) as Array<{id:number}>;
  deleteClusterEmbeddings(oldClusterIds.map(c=>c.id));
  db.prepare('DELETE FROM cluster_messages WHERE cluster_id IN (SELECT id FROM clusters WHERE chat_id=?)').run(chatId);
  db.prepare('DELETE FROM clusters WHERE chat_id=?').run(chatId);

  // Get all messages for this chat, ordered by date
  const messages = db.prepare(`
    SELECT * FROM messages
    WHERE chat_id = ?
    ORDER BY date ASC, id ASC
  `).all(chatId) as MessageRow[];

  if (messages.length === 0) {
    return 0;
  }

  // Phase 1: Initial clustering by time gaps
  const tempClusters: TempCluster[] = [];
  let currentCluster: TempCluster | null = null;

  for (const msg of messages) {
    if (!currentCluster) {
      // Start first cluster
      currentCluster = {
        messages: [msg],
        startTime: msg.date,
        endTime: msg.date,
      };
    } else {
      const timeSinceLastMessage = msg.date - currentCluster.endTime;

      if (timeSinceLastMessage > CLUSTER_GAP_SECONDS) {
        // Time gap too large - save current cluster, start new one
        tempClusters.push(currentCluster);
        currentCluster = {
          messages: [msg],
          startTime: msg.date,
          endTime: msg.date,
        };
      } else {
        // Add to current cluster
        currentCluster.messages.push(msg);
        currentCluster.endTime = msg.date;
      }
    }
  }

  // Don't forget the last cluster
  if (currentCluster) {
    tempClusters.push(currentCluster);
  }

  // Phase 2: Handle reply chains
  // Build a map of message ID to cluster index
  const msgToClusterIdx = new Map<number, number>();
  for (let i = 0; i < tempClusters.length; i++) {
    for (const msg of tempClusters[i].messages) {
      msgToClusterIdx.set(msg.id, i);
    }
  }

  // Move messages that reply to earlier clusters
  for (let i = 0; i < tempClusters.length; i++) {
    const cluster = tempClusters[i];
    const messagesToMove: MessageRow[] = [];
    const messagesToKeep: MessageRow[] = [];

    for (const msg of cluster.messages) {
      if (msg.reply_to_id && (!msg.reply_to_peer_id || msg.reply_to_peer_id === msg.chat_id)) {
        const replyToClusterIdx = msgToClusterIdx.get(msg.reply_to_id);
        if (replyToClusterIdx !== undefined && replyToClusterIdx < i) {
          // This message replies to an earlier cluster - move it there
          messagesToMove.push(msg);
          const targetCluster = tempClusters[replyToClusterIdx];
          targetCluster.messages.push(msg);
          targetCluster.endTime = Math.max(targetCluster.endTime, msg.date);
          msgToClusterIdx.set(msg.id, replyToClusterIdx);
          continue;
        }
      }
      messagesToKeep.push(msg);
    }

    cluster.messages = messagesToKeep;
  }

  // Remove empty clusters
  const nonEmptyClusters = tempClusters.filter(c => c.messages.length > 0);

  // Phase 3: Merge small clusters with adjacent ones
  const finalClusters: TempCluster[] = [];

  for (const cluster of nonEmptyClusters) {
    if (cluster.messages.length < MIN_CLUSTER_SIZE && finalClusters.length > 0) {
      // Merge with previous cluster
      const prevCluster = finalClusters[finalClusters.length - 1];
      prevCluster.messages.push(...cluster.messages);
      prevCluster.endTime = Math.max(prevCluster.endTime, cluster.endTime);
    } else if (cluster.messages.length < MIN_CLUSTER_SIZE && finalClusters.length === 0) {
      // First cluster but too small - keep it for now, may merge with next
      finalClusters.push(cluster);
    } else {
      // Check if we should absorb a previous small cluster
      if (finalClusters.length > 0) {
        const prevCluster = finalClusters[finalClusters.length - 1];
        if (prevCluster.messages.length < MIN_CLUSTER_SIZE) {
          // Merge previous small cluster into this one
          cluster.messages = [...prevCluster.messages, ...cluster.messages];
          cluster.startTime = Math.min(cluster.startTime, prevCluster.startTime);
          finalClusters.pop();
        }
      }
      finalClusters.push(cluster);
    }
  }

  // Sort messages within each cluster by date
  for (const cluster of finalClusters) {
    cluster.messages.sort((a, b) => a.date - b.date || a.id - b.id);
    cluster.startTime = cluster.messages[0].date;
    cluster.endTime = cluster.messages[cluster.messages.length - 1].date;
  }

  // Phase 3.5: Split large clusters by largest time gap
  const splitClusters: TempCluster[] = [];
  for (const cluster of finalClusters) {
    if (cluster.messages.length <= MAX_CLUSTER_SIZE) {
      splitClusters.push(cluster);
      continue;
    }

    // Recursively split by largest gap until all pieces are small enough
    const pieces = splitClusterByLargestGap(cluster);
    splitClusters.push(...pieces);
  }

  // Phase 4: Save clusters to database
  const deleteClusterMessages = db.prepare(`
    DELETE FROM cluster_messages
    WHERE cluster_id IN (SELECT id FROM clusters WHERE chat_id = ?)
  `);

  const deleteClusters = db.prepare('DELETE FROM clusters WHERE chat_id = ?');

  const insertCluster = db.prepare(`
    INSERT INTO clusters (chat_id, start_time, end_time, message_count, first_msg_rowid, last_msg_rowid)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertClusterMessage = db.prepare(`
    INSERT INTO cluster_messages (cluster_id, msg_rowid)
    VALUES (?, ?)
  `);

  let clustersCreated = 0;

  const transaction = db.transaction(() => {
    // Clear existing clusters for this chat (inside transaction for atomicity)
    deleteClusterMessages.run(chatId);
    deleteClusters.run(chatId);

    for (const cluster of splitClusters) {
      if (cluster.messages.length === 0) continue;

      const firstMsg = cluster.messages[0];
      const lastMsg = cluster.messages[cluster.messages.length - 1];

      const result = insertCluster.run(
        chatId,
        cluster.startTime,
        cluster.endTime,
        cluster.messages.length,
        firstMsg.msg_rowid,
        lastMsg.msg_rowid
      );

      const clusterId = result.lastInsertRowid;

      for (const msg of cluster.messages) {
        insertClusterMessage.run(clusterId, msg.msg_rowid);
      }

      clustersCreated++;
    }
  });

  transaction();

  return clustersCreated;
}

/**
 * Get clusters for a chat
 */
export function getClusters(chatId?: string, limit: number = 50): ClusterWithPreview[] {
  const db = getDatabase();
  ensureClusterTables();

  let sql: string;
  const params: any[] = [];

  if (chatId) {
    sql = `
      SELECT c.*, m.text as preview_text, m.chat_title
      FROM clusters c
      LEFT JOIN messages m ON m.msg_rowid = c.first_msg_rowid
      WHERE c.chat_id = ?
      ORDER BY c.end_time DESC
      LIMIT ?
    `;
    params.push(chatId, limit);
  } else {
    sql = `
      SELECT c.*, m.text as preview_text, m.chat_title
      FROM clusters c
      LEFT JOIN messages m ON m.msg_rowid = c.first_msg_rowid
      ORDER BY c.end_time DESC
      LIMIT ?
    `;
    params.push(limit);
  }

  const rows = db.prepare(sql).all(...params) as (ClusterRow & { preview_text: string | null; chat_title: string | null })[];

  return rows.map(row => ({
    ...rowToCluster(row),
    preview: (row.preview_text || '').slice(0, 100),
    chatTitle: row.chat_title || '',
  }));
}

/**
 * Get all messages in a cluster
 */
export function getClusterMessages(clusterId: number): MessageRow[] {
  const db = getDatabase();
  ensureClusterTables();

  const messages = db.prepare(`
    SELECT m.*
    FROM messages m
    JOIN cluster_messages cm ON cm.msg_rowid = m.msg_rowid
    WHERE cm.cluster_id = ?
    ORDER BY m.date ASC
  `).all(clusterId) as MessageRow[];

  return messages;
}

/**
 * Get a single cluster by ID
 */
export function getCluster(clusterId: number): Cluster | null {
  const db = getDatabase();
  ensureClusterTables();

  const row = db.prepare('SELECT * FROM clusters WHERE id = ?').get(clusterId) as ClusterRow | undefined;

  if (!row) return null;
  return rowToCluster(row);
}

/**
 * Get cluster statistics for a chat
 */
export function getClusterStats(chatId?: string): {
  totalClusters: number;
  totalMessages: number;
  avgMessagesPerCluster: number;
} {
  const db = getDatabase();
  ensureClusterTables();

  let sql: string;
  const params: any[] = [];

  if (chatId) {
    sql = `
      SELECT
        COUNT(*) as total_clusters,
        COALESCE(SUM(message_count), 0) as total_messages
      FROM clusters
      WHERE chat_id = ?
    `;
    params.push(chatId);
  } else {
    sql = `
      SELECT
        COUNT(*) as total_clusters,
        COALESCE(SUM(message_count), 0) as total_messages
      FROM clusters
    `;
  }

  const result = db.prepare(sql).get(...params) as {
    total_clusters: number;
    total_messages: number;
  };

  return {
    totalClusters: result.total_clusters,
    totalMessages: result.total_messages,
    avgMessagesPerCluster: result.total_clusters > 0
      ? Math.round(result.total_messages / result.total_clusters)
      : 0,
  };
}

/**
 * Find which cluster a message belongs to.
 *
 * Message ids are per-chat, so the chat must be supplied to resolve the
 * surrogate row id before looking up cluster membership.
 */
export function findClusterForMessage(chatId: string, messageId: number): Cluster | null {
  const db = getDatabase();
  ensureClusterTables();

  const row = db.prepare(`
    SELECT c.*
    FROM clusters c
    JOIN cluster_messages cm ON cm.cluster_id = c.id
    JOIN messages m ON m.msg_rowid = cm.msg_rowid
    WHERE m.chat_id = ? AND m.id = ?
  `).get(chatId, messageId) as ClusterRow | undefined;

  if (!row) return null;
  return rowToCluster(row);
}

/**
 * Batch lookup: find cluster IDs for multiple (chat, message id) pairs.
 * Returns Map keyed `${chatId}:${messageId}` -> clusterId.
 */
export function findClustersForMessages(
  messages: Array<{ chatId: string; messageId: number }>
): Map<string, number> {
  const result = new Map<string, number>();
  if (messages.length === 0) return result;

  const db = getDatabase();
  ensureClusterTables();

  // Join cluster_messages back to messages so we can key by (chat_id, id).
  const placeholders = messages.map(() => '(?, ?)').join(',');
  const params: any[] = [];
  for (const m of messages) {
    params.push(m.chatId, m.messageId);
  }

  const rows = db.prepare(`
    SELECT m.chat_id, m.id, cm.cluster_id
    FROM cluster_messages cm
    JOIN messages m ON m.msg_rowid = cm.msg_rowid
    WHERE (m.chat_id, m.id) IN (${placeholders})
  `).all(...params) as { chat_id: string; id: number; cluster_id: number }[];

  for (const row of rows) {
    result.set(`${row.chat_id}:${row.id}`, row.cluster_id);
  }

  return result;
}
