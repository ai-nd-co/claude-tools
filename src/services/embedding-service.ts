// Unified embedding service for all content types (messages, clusters, jira issues, etc.)

import {
  getEmbeddingsDb,
  loadEmbeddingsVectorExtension,
  isEmbeddingsVectorLoaded,
  type ContentType,
  type EmbeddingRow,
} from '../db/embeddings.js';
import { getCacheGeneration } from '../db/index.js';
import { generateEmbedding, isOllamaAvailable, getEmbeddingModel } from './embeddings.js';

// Threshold for using KNN vs in-memory search
const KNN_THRESHOLD = 1000;

export function ensureTelegramEmbeddingGeneration(): void {
  const generation = getCacheGeneration();
  const db = getEmbeddingsDb();
  db.exec('CREATE TABLE IF NOT EXISTS telegram_identity (id INTEGER PRIMARY KEY CHECK(id=1), generation TEXT NOT NULL)');
  const previous = db.prepare('SELECT generation FROM telegram_identity WHERE id=1').get() as {generation:string}|undefined;
  if (previous?.generation === generation) return;
  // Idempotent across crashes: stamp only after both types and vectors are cleared.
  deleteEmbeddings('message');
  deleteEmbeddings('cluster');
  db.prepare('INSERT OR REPLACE INTO telegram_identity(id,generation) VALUES (1,?)').run(generation);
}


export interface EmbeddableContent {
  type: ContentType;
  id: string;
  text: string;
}

export interface SemanticSearchResult {
  contentType: string;
  contentId: string;
  distance: number;
  similarity: number;
}

/**
 * Check if semantic search is available for a content type
 */
export async function isSemanticSearchAvailable(contentType?: ContentType): Promise<{
  available: boolean;
  reason?: string;
}> {
  // Check Ollama
  const ollamaOk = await isOllamaAvailable();
  if (!ollamaOk) {
    return { available: false, reason: 'Ollama not running. Start with: docker compose up -d' };
  }

  // Check if we have any embeddings
  const count = getEmbeddingCount(contentType);
  if (count === 0) {
    const typeLabel = contentType || 'any content';
    return { available: false, reason: `No embeddings for ${typeLabel}. Run: telegram embed --generate` };
  }

  return { available: true };
}

/**
 * Store embedding for content
 */
export function storeEmbedding(content: EmbeddableContent, embedding: number[]): void {
  if (content.type === 'message' || content.type === 'cluster') ensureTelegramEmbeddingGeneration();
  const db = getEmbeddingsDb();
  const model = getEmbeddingModel();
  const embeddingBlob = Buffer.from(new Float32Array(embedding).buffer);

  // Store in embeddings table
  const insertEmbed = db.prepare(`
    INSERT OR REPLACE INTO embeddings (content_type, content_id, embedding, model, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  insertEmbed.run(content.type, content.id, embeddingBlob, model, Math.floor(Date.now() / 1000));

  // Store in vec0 + mapping table for KNN search (if extension loaded)
  if (loadEmbeddingsVectorExtension()) {
    try {
      // Check if already exists in vector_content_map
      const existing = db.prepare(
        'SELECT vec_rowid FROM vector_content_map WHERE content_type = ? AND content_id = ?'
      ).get(content.type, content.id) as { vec_rowid: number } | undefined;

      if (existing) {
        // Delete old vector and mapping
        db.prepare('DELETE FROM content_vectors WHERE rowid = ?').run(existing.vec_rowid);
        db.prepare('DELETE FROM vector_content_map WHERE content_type = ? AND content_id = ?')
          .run(content.type, content.id);
      }

      // Insert new vector
      const insertVec = db.prepare('INSERT INTO content_vectors (embedding) VALUES (?)');
      const info = insertVec.run(JSON.stringify(embedding));

      // Create mapping
      db.prepare('INSERT INTO vector_content_map (vec_rowid, content_type, content_id) VALUES (?, ?, ?)')
        .run(info.lastInsertRowid, content.type, content.id);
    } catch (err) {
      // KNN storage failed, but we still have embeddings table as fallback
      console.error('KNN storage failed:', (err as Error).message);
    }
  }
}

/**
 * Check if content has an embedding
 */
export function hasEmbedding(type: ContentType, id: string): boolean {
  if (type === 'message' || type === 'cluster') ensureTelegramEmbeddingGeneration();
  const db = getEmbeddingsDb();
  const stmt = db.prepare('SELECT 1 FROM embeddings WHERE content_type = ? AND content_id = ?');
  return !!stmt.get(type, id);
}

/**
 * Get count of embeddings
 */
export function getEmbeddingCount(type?: ContentType): number {
  if (type === 'message' || type === 'cluster') ensureTelegramEmbeddingGeneration();
  const db = getEmbeddingsDb();

  if (type) {
    const stmt = db.prepare('SELECT COUNT(*) as count FROM embeddings WHERE content_type = ?');
    const result = stmt.get(type) as { count: number };
    return result.count;
  } else {
    const stmt = db.prepare('SELECT COUNT(*) as count FROM embeddings');
    const result = stmt.get() as { count: number };
    return result.count;
  }
}

/**
 * Get content IDs that don't have embeddings yet
 */
export function getContentWithoutEmbeddings(
  type: ContentType,
  contentIds: string[]
): string[] {
  if (type === 'message' || type === 'cluster') ensureTelegramEmbeddingGeneration();
  if (contentIds.length === 0) return [];

  const db = getEmbeddingsDb();
  const placeholders = contentIds.map(() => '?').join(',');

  const existingRows = db.prepare(`
    SELECT content_id FROM embeddings
    WHERE content_type = ? AND content_id IN (${placeholders})
  `).all(type, ...contentIds) as { content_id: string }[];

  const existingIds = new Set(existingRows.map(r => r.content_id));
  return contentIds.filter(id => !existingIds.has(id));
}

/**
 * Semantic search within a content type
 */
export async function semanticSearch(
  query: string,
  type: ContentType,
  limit: number = 20
): Promise<SemanticSearchResult[]> {
  const count = getEmbeddingCount(type);

  // Use KNN search for large datasets
  if (count >= KNN_THRESHOLD && loadEmbeddingsVectorExtension()) {
    return semanticSearchKNN(query, type, limit);
  }

  // Use in-memory search for small datasets
  return semanticSearchInMemory(query, type, limit);
}

/**
 * Semantic search across all content types
 */
export async function semanticSearchAll(
  query: string,
  limit: number = 20
): Promise<SemanticSearchResult[]> {
  ensureTelegramEmbeddingGeneration();
  const count = getEmbeddingCount();

  // Use KNN search for large datasets
  if (count >= KNN_THRESHOLD && loadEmbeddingsVectorExtension()) {
    return semanticSearchKNNAll(query, limit);
  }

  // Use in-memory search for small datasets
  return semanticSearchInMemoryAll(query, limit);
}

/**
 * KNN search within a content type
 */
async function semanticSearchKNN(
  query: string,
  type: ContentType,
  limit: number
): Promise<SemanticSearchResult[]> {
  const queryEmbedding = await generateEmbedding(query);
  const db = getEmbeddingsDb();

  // KNN search with type filter
  // Note: We need to fetch more results and filter, since vec0 doesn't support WHERE on joins
  const stmt = db.prepare(`
    SELECT
      vcm.content_type,
      vcm.content_id,
      v.distance
    FROM content_vectors v
    JOIN vector_content_map vcm ON v.rowid = vcm.vec_rowid
    JOIN embeddings e ON e.content_type = vcm.content_type AND e.content_id = vcm.content_id
    WHERE v.embedding MATCH ? AND k = ?
    ORDER BY v.distance ASC
  `);

  // Fetch more than needed to filter by type
  const rows = stmt.all(JSON.stringify(queryEmbedding), limit * 5) as Array<{
    content_type: string;
    content_id: string;
    distance: number;
  }>;

  // Filter by type and limit
  const filtered = rows
    .filter(r => r.content_type === type)
    .slice(0, limit);

  return filtered.map(row => ({
    contentType: row.content_type,
    contentId: row.content_id,
    distance: row.distance,
    similarity: 1 - row.distance,
  }));
}

/**
 * KNN search across all content types
 */
async function semanticSearchKNNAll(
  query: string,
  limit: number
): Promise<SemanticSearchResult[]> {
  const queryEmbedding = await generateEmbedding(query);
  const db = getEmbeddingsDb();

  const stmt = db.prepare(`
    SELECT
      vcm.content_type,
      vcm.content_id,
      v.distance
    FROM content_vectors v
    JOIN vector_content_map vcm ON v.rowid = vcm.vec_rowid
    JOIN embeddings e ON e.content_type = vcm.content_type AND e.content_id = vcm.content_id
    WHERE v.embedding MATCH ? AND k = ?
    ORDER BY v.distance ASC
  `);

  const rows = stmt.all(JSON.stringify(queryEmbedding), limit) as Array<{
    content_type: string;
    content_id: string;
    distance: number;
  }>;

  return rows.map(row => ({
    contentType: row.content_type,
    contentId: row.content_id,
    distance: row.distance,
    similarity: 1 - row.distance,
  }));
}

/**
 * In-memory cosine similarity search within a content type
 */
async function semanticSearchInMemory(
  query: string,
  type: ContentType,
  limit: number
): Promise<SemanticSearchResult[]> {
  const queryEmbedding = await generateEmbedding(query);
  const db = getEmbeddingsDb();

  const stmt = db.prepare(`
    SELECT content_type, content_id, embedding
    FROM embeddings
    WHERE content_type = ?
  `);

  const rows = stmt.all(type) as EmbeddingRow[];
  return computeSimilarities(queryEmbedding, rows, limit);
}

/**
 * In-memory cosine similarity search across all content types
 */
async function semanticSearchInMemoryAll(
  query: string,
  limit: number
): Promise<SemanticSearchResult[]> {
  const queryEmbedding = await generateEmbedding(query);
  const db = getEmbeddingsDb();

  const stmt = db.prepare('SELECT content_type, content_id, embedding FROM embeddings');
  const rows = stmt.all() as EmbeddingRow[];

  return computeSimilarities(queryEmbedding, rows, limit);
}

/**
 * Compute similarities and return top results
 */
function computeSimilarities(
  queryEmbedding: number[],
  rows: EmbeddingRow[],
  limit: number
): SemanticSearchResult[] {
  const results: SemanticSearchResult[] = [];

  for (const row of rows) {
    const embeddingArray = new Float32Array(
      row.embedding.buffer,
      row.embedding.byteOffset,
      row.embedding.length / 4
    );
    const similarity = cosineSimilarity(queryEmbedding, Array.from(embeddingArray));

    results.push({
      contentType: row.content_type,
      contentId: row.content_id,
      distance: 1 - similarity,
      similarity,
    });
  }

  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, limit);
}

/**
 * Calculate cosine similarity between two vectors
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

/**
 * Delete all embeddings for a content type
 */
export function deleteEmbeddings(type: ContentType, loadVectors = loadEmbeddingsVectorExtension, contentIds?: string[]): number {
  const db = getEmbeddingsDb();
  if (contentIds?.length === 0) return 0;
  const suffix = contentIds ? ` AND content_id IN (${contentIds.map(() => '?').join(',')})` : '';
  const params = [type, ...(contentIds || [])];
  const vectorsExist = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='content_vectors'").get();
  const vectorsReady = loadVectors();
  if (vectorsExist && !vectorsReady) throw new Error('Cannot invalidate Telegram vectors: sqlite-vec is unavailable. Existing vectors and mappings preserved for retry.');
  return db.transaction(() => {
    if (vectorsReady) {
      const rowids = db.prepare('SELECT vec_rowid FROM vector_content_map WHERE content_type=?' + suffix).all(...params) as Array<{vec_rowid:number}>;
      for (const row of rowids) db.prepare('DELETE FROM content_vectors WHERE rowid=?').run(row.vec_rowid);
      db.prepare('DELETE FROM vector_content_map WHERE content_type=?' + suffix).run(...params);
    }
    return db.prepare('DELETE FROM embeddings WHERE content_type=?' + suffix).run(...params).changes;
  })();
}

export function deleteClusterEmbeddings(clusterIds:number[]): void {
  if (!clusterIds.length) return;
  const prefix = `tg3:${getCacheGeneration()}:`;
  const ids = new Set(clusterIds);
  const rows = getEmbeddingsDb().prepare("SELECT content_id FROM embeddings WHERE content_type='cluster'").all() as Array<{content_id:string}>;
  const keys=rows.filter(r=>r.content_id.startsWith(prefix) && ids.has(Number(r.content_id.slice(prefix.length).split(':')[0]))).map(r=>r.content_id);
  // Keep the SQL parameter count bounded for long histories.
  for(let offset=0;offset<keys.length;offset+=500) deleteEmbeddings('cluster',loadEmbeddingsVectorExtension,keys.slice(offset,offset+500));
}

/**
 * Get embedding statistics
 */
export function getEmbeddingStats(): {
  total: number;
  byType: Record<string, number>;
} {
  const db = getEmbeddingsDb();

  const totalStmt = db.prepare('SELECT COUNT(*) as count FROM embeddings');
  const total = (totalStmt.get() as { count: number }).count;

  const byTypeStmt = db.prepare(`
    SELECT content_type, COUNT(*) as count
    FROM embeddings
    GROUP BY content_type
  `);
  const byTypeRows = byTypeStmt.all() as { content_type: string; count: number }[];

  const byType: Record<string, number> = {};
  for (const row of byTypeRows) {
    byType[row.content_type] = row.count;
  }

  return { total, byType };
}
