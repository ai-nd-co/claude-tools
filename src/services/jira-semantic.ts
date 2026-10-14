// Jira semantic search service - vector-based similarity search for issues
// Uses overlapping chunks for large issues (like cluster-embedding.ts)

import { getJiraDatabase, type JiraIssueRow } from '../db/jira.js';
import { getEmbeddingsDb } from '../db/embeddings.js';
import { generateEmbedding, generateEmbeddings, isOllamaAvailable } from './embeddings.js';
import {
  storeEmbedding,
  getEmbeddingCount,
  semanticSearch,
  deleteEmbeddings,
} from './embedding-service.js';

const CONTENT_TYPE = 'jira_issue' as const;

// Chunking configuration (like cluster-embedding.ts)
const CHUNK_SIZE = 1500;           // Characters per chunk
const CHUNK_OVERLAP = 300;         // Overlap between chunks
const MIN_CHUNK_SIZE = 500;        // Skip tiny final chunks
const MAX_TOTAL_TEXT = 10000;      // Max text to process per issue

export interface JiraSemanticSearchResult {
  issue: JiraIssueRow;
  similarity: number;
  distance: number;
}

/**
 * Check if semantic search is available
 */
export async function isJiraSemanticAvailable(): Promise<{
  available: boolean;
  reason?: string;
}> {
  const ollamaOk = await isOllamaAvailable();
  if (!ollamaOk) {
    return { available: false, reason: 'Ollama not running. Start with: docker compose up -d' };
  }

  const count = getEmbeddingCount(CONTENT_TYPE);
  if (count === 0) {
    return { available: false, reason: 'No embeddings. Run: jira embed --generate' };
  }

  return { available: true };
}

/**
 * Generate embedding text from issue fields
 */
function getIssueEmbeddingText(issue: JiraIssueRow): string {
  const parts = [
    issue.key,
    issue.summary || '',
    issue.description || '',
    issue.issue_type || '',
    issue.status || '',
    issue.labels || '',
  ];
  let text = parts.filter(p => p).join(' ').trim();

  // Truncate if too long
  if (text.length > MAX_TOTAL_TEXT) {
    text = text.slice(0, MAX_TOTAL_TEXT);
  }
  return text;
}

/**
 * Split large text into overlapping chunks
 * Small texts (≤CHUNK_SIZE) return single chunk
 * Large texts return multiple overlapping chunks
 */
function generateChunks(issueId: string, text: string): Array<{ id: string; text: string }> {
  if (text.length <= CHUNK_SIZE) {
    // Single chunk for small issues
    return [{ id: issueId, text }];
  }

  // Generate overlapping chunks
  const chunks: Array<{ id: string; text: string }> = [];
  const stride = CHUNK_SIZE - CHUNK_OVERLAP;

  for (let i = 0; i < text.length; i += stride) {
    const chunkText = text.slice(i, i + CHUNK_SIZE);

    // Skip tiny final chunks
    if (chunkText.length < MIN_CHUNK_SIZE) {
      break;
    }

    const chunkId = chunks.length === 0 ? issueId : `${issueId}:${chunks.length}`;
    chunks.push({ id: chunkId, text: chunkText });

    // Stop if we've reached the end
    if (i + CHUNK_SIZE >= text.length) {
      break;
    }
  }

  return chunks;
}

/**
 * Parse content ID back to issue ID
 */
function parseContentId(contentId: string): string {
  // "10001" -> "10001", "10001:1" -> "10001"
  return contentId.split(':')[0];
}

/**
 * Check if issue has any embeddings (including chunks)
 */
function hasIssueEmbedding(issueId: string): boolean {
  const db = getEmbeddingsDb();
  // Check for base ID or any chunk ID like "10001:0", "10001:1"
  const stmt = db.prepare(`
    SELECT 1 FROM embeddings
    WHERE content_type = ? AND (content_id = ? OR content_id LIKE ?)
    LIMIT 1
  `);
  return !!stmt.get(CONTENT_TYPE, issueId, `${issueId}:%`);
}

/**
 * Generate embeddings for issues without them (concurrent for ~9x speedup)
 * Uses overlapping chunks for large issues
 */
export async function generateJiraEmbeddings(
  projectKey?: string,
  limit: number = 100,
  onProgress?: (done: number, total: number, key: string) => void
): Promise<{ generated: number; skipped: number }> {
  const db = getJiraDatabase();

  // Get issues
  let sql = 'SELECT * FROM jira_issues';
  const params: any[] = [];
  if (projectKey) {
    sql += ' WHERE project_key = ?';
    params.push(projectKey);
  }
  sql += ' ORDER BY updated DESC';

  const allIssues = db.prepare(sql).all(...params) as JiraIssueRow[];

  // Find which need embeddings and generate all chunks
  const toEmbed: JiraIssueRow[] = [];
  const allChunks: Array<{ issue: JiraIssueRow; chunk: { id: string; text: string } }> = [];

  for (const issue of allIssues) {
    if (!hasIssueEmbedding(issue.id)) {
      const text = getIssueEmbeddingText(issue);
      if (!text) continue;

      toEmbed.push(issue);
      const chunks = generateChunks(issue.id, text);
      for (const chunk of chunks) {
        allChunks.push({ issue, chunk });
      }

      if (toEmbed.length >= limit) break;
    }
  }

  const skipped = allIssues.length - toEmbed.length;
  if (allChunks.length === 0) {
    return { generated: 0, skipped };
  }

  // Generate all embeddings concurrently
  const texts = allChunks.map(item => item.chunk.text);

  // Track progress by issue (not chunk)
  const issueProgress = new Map<string, boolean>();
  let lastReportedIssue = -1;

  const embeddings = await generateEmbeddings(texts, (done, total) => {
    // Find which issue this chunk belongs to and report progress per issue
    const { issue } = allChunks[done - 1];
    if (!issueProgress.has(issue.id)) {
      issueProgress.set(issue.id, true);
      const issuesDone = issueProgress.size;
      if (issuesDone > lastReportedIssue) {
        lastReportedIssue = issuesDone;
        onProgress?.(issuesDone, toEmbed.length, issue.key);
      }
    }
  });

  // Store all embeddings
  let generated = 0;
  for (let i = 0; i < allChunks.length; i++) {
    const { issue, chunk } = allChunks[i];
    const embedding = embeddings[i];
    if (embedding) {
      try {
        storeEmbedding({ type: CONTENT_TYPE, id: chunk.id, text: chunk.text }, embedding);
        generated++;
      } catch (err) {
        console.error(`Failed to store embedding for ${issue.key} chunk ${chunk.id}:`, (err as Error).message);
      }
    }
  }

  return { generated, skipped };
}

/**
 * Semantic search for Jira issues
 * Deduplicates results when multiple chunks from same issue match
 * (like cluster-embedding.ts:searchClusters)
 */
export async function searchJiraSemantic(
  query: string,
  projectKey?: string,
  limit: number = 20
): Promise<JiraSemanticSearchResult[]> {
  // Fetch more to account for deduplication
  const fetchLimit = limit * 3;
  const results = await semanticSearch(query, CONTENT_TYPE, fetchLimit);
  if (results.length === 0) return [];

  // Deduplicate by issue ID (keep highest similarity)
  const issueMap = new Map<string, { contentId: string; similarity: number; distance: number }>();
  for (const result of results) {
    const issueId = parseContentId(result.contentId);
    const existing = issueMap.get(issueId);
    if (!existing || result.similarity > existing.similarity) {
      issueMap.set(issueId, {
        contentId: result.contentId,
        similarity: result.similarity,
        distance: result.distance,
      });
    }
  }

  // Fetch issue details
  const db = getJiraDatabase();
  const issueIds = Array.from(issueMap.keys());
  const placeholders = issueIds.map(() => '?').join(',');

  let sql = `SELECT * FROM jira_issues WHERE id IN (${placeholders})`;
  const params: any[] = [...issueIds];
  if (projectKey) {
    sql += ' AND project_key = ?';
    params.push(projectKey);
  }

  const issues = db.prepare(sql).all(...params) as JiraIssueRow[];
  const issueDetailsMap = new Map(issues.map(i => [i.id, i]));

  // Combine with similarity scores
  const combined: JiraSemanticSearchResult[] = [];
  for (const [issueId, { similarity, distance }] of issueMap) {
    const issue = issueDetailsMap.get(issueId);
    if (issue) {
      combined.push({ issue, similarity, distance });
    }
  }

  // Sort by similarity and limit
  combined.sort((a, b) => b.similarity - a.similarity);
  return combined.slice(0, limit);
}

/**
 * Get embedding statistics
 */
export function getJiraEmbeddingStats(): {
  issueEmbeddings: number;
  totalIssues: number;
  coverage: number;
} {
  const issueEmbeddings = getEmbeddingCount(CONTENT_TYPE);
  const db = getJiraDatabase();
  const { count: totalIssues } = db.prepare('SELECT COUNT(*) as count FROM jira_issues').get() as { count: number };
  const coverage = totalIssues > 0 ? (issueEmbeddings / totalIssues) * 100 : 0;
  return { issueEmbeddings, totalIssues, coverage };
}

/**
 * Clear all Jira embeddings
 */
export function clearJiraEmbeddings(): number {
  return deleteEmbeddings(CONTENT_TYPE);
}
