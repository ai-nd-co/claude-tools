// Docs semantic search service - vector-based similarity search for doc chunks

import { getDocsDatabase, type DocChunkRow } from '../db/docs.js';
import { getEmbeddingsDb } from '../db/embeddings.js';
import { generateEmbedding, generateEmbeddings, isOllamaAvailable } from './embeddings.js';
import {
  storeEmbedding,
  getEmbeddingCount,
  semanticSearch,
  deleteEmbeddings,
} from './embedding-service.js';

const CONTENT_TYPE = 'doc_chunk' as const;

export interface DocsSemanticSearchResult {
  chunk: DocChunkRow & { path: string; type: string; title: string; language: string | null };
  similarity: number;
  distance: number;
}

/**
 * Check if semantic search is available
 */
export async function isDocsSemanticAvailable(): Promise<{
  available: boolean;
  reason?: string;
}> {
  const ollamaOk = await isOllamaAvailable();
  if (!ollamaOk) {
    return { available: false, reason: 'Ollama not running. Start with: docker compose up -d' };
  }

  const count = getEmbeddingCount(CONTENT_TYPE);
  if (count === 0) {
    return { available: false, reason: 'No embeddings. Run: docs sync' };
  }

  return { available: true };
}

/**
 * Generate embedding text from chunk
 */
function getChunkEmbeddingText(chunk: DocChunkRow & { path: string; title: string }): string {
  const parts = [
    chunk.title || '',
    chunk.heading || '',
    chunk.content || '',
  ];
  return parts.filter(p => p).join(' ').trim();
}

/**
 * Check if chunk has an embedding
 */
function hasChunkEmbedding(chunkId: number): boolean {
  const db = getEmbeddingsDb();
  const stmt = db.prepare('SELECT 1 FROM embeddings WHERE content_type = ? AND content_id = ? LIMIT 1');
  return !!stmt.get(CONTENT_TYPE, String(chunkId));
}

/**
 * Generate embeddings for chunks without them (concurrent for ~9x speedup)
 */
export async function generateDocsEmbeddings(
  type?: string,
  limit: number = 100,
  onProgress?: (done: number, total: number, path: string) => void
): Promise<{ generated: number; skipped: number }> {
  const db = getDocsDatabase();

  // Get chunks with document info
  let sql = `
    SELECT c.*, d.path, d.type, d.title
    FROM doc_chunks c
    JOIN documents d ON c.doc_id = d.id
  `;
  const params: any[] = [];

  if (type) {
    sql += ' WHERE d.type = ?';
    params.push(type);
  }

  sql += ' ORDER BY d.indexed_at DESC';

  const allChunks = db.prepare(sql).all(...params) as Array<DocChunkRow & { path: string; type: string; title: string }>;

  // Find which need embeddings and prepare texts
  const toEmbed: Array<{ chunk: DocChunkRow & { path: string; type: string; title: string }; text: string }> = [];
  for (const chunk of allChunks) {
    if (!hasChunkEmbedding(chunk.id)) {
      const text = getChunkEmbeddingText(chunk);
      if (text) {
        toEmbed.push({ chunk, text });
        if (toEmbed.length >= limit) break;
      }
    }
  }

  const skipped = allChunks.length - toEmbed.length;
  if (toEmbed.length === 0) {
    return { generated: 0, skipped };
  }

  // Generate all embeddings concurrently
  const texts = toEmbed.map(item => item.text);
  let lastProgressIdx = -1;

  const embeddings = await generateEmbeddings(texts, (done, total) => {
    if (done > lastProgressIdx) {
      lastProgressIdx = done;
      const item = toEmbed[done - 1];
      onProgress?.(done, total, item.chunk.path);
    }
  });

  // Store all embeddings
  let generated = 0;
  for (let i = 0; i < toEmbed.length; i++) {
    const { chunk, text } = toEmbed[i];
    const embedding = embeddings[i];
    if (embedding) {
      try {
        storeEmbedding({ type: CONTENT_TYPE, id: String(chunk.id), text }, embedding);
        generated++;
      } catch (err) {
        console.error(`Failed to store embedding for chunk ${chunk.id}:`, (err as Error).message);
      }
    }
  }

  return { generated, skipped };
}

/**
 * Semantic search for doc chunks
 */
export async function searchDocsSemantic(
  query: string,
  type?: string,
  limit: number = 20
): Promise<DocsSemanticSearchResult[]> {
  const results = await semanticSearch(query, CONTENT_TYPE, limit * 2);
  if (results.length === 0) return [];

  // Fetch chunk details
  const db = getDocsDatabase();
  const chunkIds = results.map(r => parseInt(r.contentId, 10));
  const placeholders = chunkIds.map(() => '?').join(',');

  let sql = `
    SELECT c.*, d.path, d.type, d.title, d.language
    FROM doc_chunks c
    JOIN documents d ON c.doc_id = d.id
    WHERE c.id IN (${placeholders})
  `;
  const params: any[] = [...chunkIds];

  if (type) {
    sql += ' AND d.type = ?';
    params.push(type);
  }

  const chunks = db.prepare(sql).all(...params) as Array<DocChunkRow & { path: string; type: string; title: string; language: string | null }>;
  const chunkMap = new Map(chunks.map(c => [c.id, c]));

  // Combine with similarity scores
  const combined: DocsSemanticSearchResult[] = [];
  for (const result of results) {
    const chunk = chunkMap.get(parseInt(result.contentId, 10));
    if (chunk) {
      combined.push({
        chunk,
        similarity: result.similarity,
        distance: result.distance,
      });
    }
  }

  // Sort by similarity and limit
  combined.sort((a, b) => b.similarity - a.similarity);
  return combined.slice(0, limit);
}

/**
 * Get embedding statistics
 */
export function getDocsEmbeddingStats(): {
  chunkEmbeddings: number;
  totalChunks: number;
  coverage: number;
} {
  const chunkEmbeddings = getEmbeddingCount(CONTENT_TYPE);
  const db = getDocsDatabase();
  const { count: totalChunks } = db.prepare('SELECT COUNT(*) as count FROM doc_chunks').get() as { count: number };
  const coverage = totalChunks > 0 ? (chunkEmbeddings / totalChunks) * 100 : 0;
  return { chunkEmbeddings, totalChunks, coverage };
}

/**
 * Clear all doc embeddings
 */
export function clearDocsEmbeddings(): number {
  return deleteEmbeddings(CONTENT_TYPE);
}
