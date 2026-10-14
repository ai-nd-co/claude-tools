// Docs search service - FTS5 keyword search

import { getDocsDatabase, type DocChunkRow, type DocumentRow } from '../db/docs.js';

export interface DocsSearchOptions {
  type?: string;
  limit?: number;
  offset?: number;
  fuzzy?: boolean;
}

export interface DocsSearchResult {
  id: number;
  docId: number;
  path: string;
  type: string;
  title: string;
  heading: string | null;
  content: string;
  startLine: number | null;
  endLine: number | null;
  language: string | null;
}

export interface DocsSearchResponse {
  results: DocsSearchResult[];
  totalCount: number;
  page: number;
  perPage: number;
  totalPages: number;
}

/**
 * Escape special FTS5 characters in query
 */
function escapeFtsQuery(query: string): string {
  return query.replace(/"/g, '""');
}

/**
 * Build FTS5 query from user input
 */
function buildFtsQuery(query: string, fuzzy: boolean): string {
  const words = query.trim().split(/\s+/).filter(w => w.length > 0);

  if (words.length === 0) {
    return '*';
  }

  if (fuzzy) {
    return words.map(w => `"${escapeFtsQuery(w)}"*`).join(' OR ');
  } else {
    return words.map(w => `"${escapeFtsQuery(w)}"`).join(' AND ');
  }
}

/**
 * Count total matches for a query
 */
export function countMatches(query: string, options: DocsSearchOptions = {}): number {
  const db = getDocsDatabase();
  const ftsQuery = buildFtsQuery(query, options.fuzzy || false);

  let sql = `
    SELECT COUNT(*) as count
    FROM doc_chunks c
    JOIN doc_chunks_fts fts ON c.id = fts.rowid
    JOIN documents d ON c.doc_id = d.id
    WHERE doc_chunks_fts MATCH ?
  `;

  const params: any[] = [ftsQuery];

  if (options.type) {
    sql += ' AND d.type = ?';
    params.push(options.type);
  }

  const stmt = db.prepare(sql);
  const result = stmt.get(...params) as { count: number };
  return result.count;
}

/**
 * Search chunks using FTS5
 */
export function searchDocs(query: string, options: DocsSearchOptions = {}): DocsSearchResponse {
  const db = getDocsDatabase();
  const trimmedQuery = query.trim();

  if (trimmedQuery.length === 0) {
    return listDocs(options);
  }

  const ftsQuery = buildFtsQuery(trimmedQuery, options.fuzzy || false);

  const limit = options.limit || 20;
  const offset = options.offset || 0;
  const page = Math.floor(offset / limit) + 1;

  const totalCount = countMatches(trimmedQuery, options);
  const totalPages = Math.ceil(totalCount / limit);

  let sql = `
    SELECT c.*, d.path, d.type, d.title, d.language
    FROM doc_chunks c
    JOIN doc_chunks_fts fts ON c.id = fts.rowid
    JOIN documents d ON c.doc_id = d.id
    WHERE doc_chunks_fts MATCH ?
  `;

  const params: any[] = [ftsQuery];

  if (options.type) {
    sql += ' AND d.type = ?';
    params.push(options.type);
  }

  sql += ' ORDER BY rank LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const stmt = db.prepare(sql);
  const rows = stmt.all(...params) as Array<DocChunkRow & { path: string; type: string; title: string; language: string | null }>;

  return {
    results: rows.map(row => ({
      id: row.id,
      docId: row.doc_id,
      path: row.path,
      type: row.type,
      title: row.title,
      heading: row.heading,
      content: row.content,
      startLine: row.start_line,
      endLine: row.end_line,
      language: row.language,
    })),
    totalCount,
    page,
    perPage: limit,
    totalPages,
  };
}

/**
 * List chunks without FTS (for browsing)
 */
export function listDocs(options: DocsSearchOptions = {}): DocsSearchResponse {
  const db = getDocsDatabase();

  const limit = options.limit || 20;
  const offset = options.offset || 0;
  const page = Math.floor(offset / limit) + 1;

  let countSql = `
    SELECT COUNT(*) as count
    FROM doc_chunks c
    JOIN documents d ON c.doc_id = d.id
    WHERE 1=1
  `;
  const countParams: any[] = [];

  if (options.type) {
    countSql += ' AND d.type = ?';
    countParams.push(options.type);
  }

  const countResult = db.prepare(countSql).get(...countParams) as { count: number };
  const totalCount = countResult.count;
  const totalPages = Math.ceil(totalCount / limit);

  let sql = `
    SELECT c.*, d.path, d.type, d.title, d.language
    FROM doc_chunks c
    JOIN documents d ON c.doc_id = d.id
    WHERE 1=1
  `;
  const params: any[] = [];

  if (options.type) {
    sql += ' AND d.type = ?';
    params.push(options.type);
  }

  sql += ' ORDER BY d.indexed_at DESC, c.chunk_index ASC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows = db.prepare(sql).all(...params) as Array<DocChunkRow & { path: string; type: string; title: string; language: string | null }>;

  return {
    results: rows.map(row => ({
      id: row.id,
      docId: row.doc_id,
      path: row.path,
      type: row.type,
      title: row.title,
      heading: row.heading,
      content: row.content,
      startLine: row.start_line,
      endLine: row.end_line,
      language: row.language,
    })),
    totalCount,
    page,
    perPage: limit,
    totalPages,
  };
}

/**
 * Get a single document by path
 */
export function getDocByPath(path: string): DocumentRow | null {
  const db = getDocsDatabase();
  const stmt = db.prepare('SELECT * FROM documents WHERE path = ?');
  return stmt.get(path) as DocumentRow | null;
}

/**
 * Get chunks for a document
 */
export function getDocChunks(docId: number): DocChunkRow[] {
  const db = getDocsDatabase();
  const stmt = db.prepare('SELECT * FROM doc_chunks WHERE doc_id = ? ORDER BY chunk_index');
  return stmt.all(docId) as DocChunkRow[];
}

/**
 * Check if database has any documents
 */
export function hasDocs(): boolean {
  const db = getDocsDatabase();
  const stmt = db.prepare('SELECT COUNT(*) as count FROM documents');
  const result = stmt.get() as { count: number };
  return result.count > 0;
}

/**
 * Get database statistics
 */
export function getDatabaseStats(): {
  totalDocs: number;
  totalChunks: number;
  typeBreakdown: { type: string; count: number }[];
  oldestIndexed: Date | null;
  newestIndexed: Date | null;
} {
  const db = getDocsDatabase();

  const docsCount = db.prepare('SELECT COUNT(*) as count FROM documents').get() as { count: number };
  const chunksCount = db.prepare('SELECT COUNT(*) as count FROM doc_chunks').get() as { count: number };

  const typeBreakdown = db.prepare(`
    SELECT type, COUNT(*) as count
    FROM documents
    GROUP BY type
    ORDER BY count DESC
  `).all() as { type: string; count: number }[];

  const oldest = db.prepare('SELECT MIN(indexed_at) as date FROM documents').get() as { date: number | null };
  const newest = db.prepare('SELECT MAX(indexed_at) as date FROM documents').get() as { date: number | null };

  return {
    totalDocs: docsCount.count,
    totalChunks: chunksCount.count,
    typeBreakdown,
    oldestIndexed: oldest.date ? new Date(oldest.date * 1000) : null,
    newestIndexed: newest.date ? new Date(newest.date * 1000) : null,
  };
}
