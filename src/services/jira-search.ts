// Jira issue search service - FTS5 keyword and fuzzy search

import { getJiraDatabase, type JiraIssueRow } from '../db/jira.js';

export interface JiraSearchOptions {
  projectKey?: string;
  status?: string;
  assignee?: string;
  fromDate?: Date;
  limit?: number;
  offset?: number;
  fuzzy?: boolean;
  /** Filter by board/backlog status: 'board' = on board only, 'backlog' = backlog only, undefined = all */
  boardFilter?: 'board' | 'backlog';
}

export interface JiraSearchResult {
  id: string;
  key: string;
  projectKey: string;
  summary: string;
  description: string;
  status: string;
  statusCategory: string;
  assigneeName: string | null;
  reporterName: string | null;
  priority: string | null;
  issueType: string | null;
  labels: string[];
  created: Date;
  updated: Date;
  resolved: Date | null;
}

export interface JiraSearchResponse {
  results: JiraSearchResult[];
  totalCount: number;
  page: number;
  perPage: number;
  totalPages: number;
}

/**
 * Convert a JiraIssueRow to a JiraSearchResult
 */
function rowToResult(row: JiraIssueRow): JiraSearchResult {
  return {
    id: row.id,
    key: row.key,
    projectKey: row.project_key,
    summary: row.summary || '',
    description: row.description || '',
    status: row.status || '',
    statusCategory: row.status_category || '',
    assigneeName: row.assignee_name,
    reporterName: row.reporter_name,
    priority: row.priority,
    issueType: row.issue_type,
    labels: row.labels ? JSON.parse(row.labels) : [],
    created: new Date(row.created * 1000),
    updated: new Date(row.updated * 1000),
    resolved: row.resolved ? new Date(row.resolved * 1000) : null,
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

  if (words.length === 0) {
    return '*'; // Match all if empty query
  }

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
export function countMatches(query: string, options: JiraSearchOptions = {}): number {
  const db = getJiraDatabase();
  const ftsQuery = buildFtsQuery(query, options.fuzzy || false);

  let sql = `
    SELECT COUNT(*) as count
    FROM jira_issues i
    JOIN jira_issues_fts fts ON i.rowid = fts.rowid
    WHERE jira_issues_fts MATCH ?
  `;

  const params: any[] = [ftsQuery];

  if (options.projectKey) {
    sql += ' AND i.project_key = ?';
    params.push(options.projectKey);
  }

  if (options.status) {
    sql += ' AND i.status = ?';
    params.push(options.status);
  }

  if (options.assignee) {
    sql += ' AND i.assignee_name LIKE ?';
    params.push(`%${options.assignee}%`);
  }

  if (options.fromDate) {
    sql += ' AND i.updated >= ?';
    params.push(Math.floor(options.fromDate.getTime() / 1000));
  }

  if (options.boardFilter === 'board') {
    sql += ' AND i.in_backlog = 0';
  } else if (options.boardFilter === 'backlog') {
    sql += ' AND i.in_backlog = 1';
  }

  const stmt = db.prepare(sql);
  const result = stmt.get(...params) as { count: number };
  return result.count;
}

/**
 * Search issues using FTS5
 * If query is empty, falls back to listIssues for browsing
 */
export function searchIssues(query: string, options: JiraSearchOptions = {}): JiraSearchResponse {
  const db = getJiraDatabase();
  const trimmedQuery = query.trim();

  // If empty query, use list instead of FTS
  if (trimmedQuery.length === 0) {
    return listIssues(options);
  }

  const ftsQuery = buildFtsQuery(trimmedQuery, options.fuzzy || false);

  const limit = options.limit || 20;
  const offset = options.offset || 0;
  const page = Math.floor(offset / limit) + 1;

  // Get total count first
  const totalCount = countMatches(trimmedQuery, options);
  const totalPages = Math.ceil(totalCount / limit);

  // Build search query
  let sql = `
    SELECT i.*
    FROM jira_issues i
    JOIN jira_issues_fts fts ON i.rowid = fts.rowid
    WHERE jira_issues_fts MATCH ?
  `;

  const params: any[] = [ftsQuery];

  if (options.projectKey) {
    sql += ' AND i.project_key = ?';
    params.push(options.projectKey);
  }

  if (options.status) {
    sql += ' AND i.status = ?';
    params.push(options.status);
  }

  if (options.assignee) {
    sql += ' AND i.assignee_name LIKE ?';
    params.push(`%${options.assignee}%`);
  }

  if (options.fromDate) {
    sql += ' AND i.updated >= ?';
    params.push(Math.floor(options.fromDate.getTime() / 1000));
  }

  if (options.boardFilter === 'board') {
    sql += ' AND i.in_backlog = 0';
  } else if (options.boardFilter === 'backlog') {
    sql += ' AND i.in_backlog = 1';
  }

  sql += ' ORDER BY i.updated DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const stmt = db.prepare(sql);
  const rows = stmt.all(...params) as JiraIssueRow[];

  return {
    results: rows.map(rowToResult),
    totalCount,
    page,
    perPage: limit,
    totalPages,
  };
}

/**
 * List issues without FTS (for browsing)
 */
export function listIssues(options: JiraSearchOptions = {}): JiraSearchResponse {
  const db = getJiraDatabase();

  const limit = options.limit || 20;
  const offset = options.offset || 0;
  const page = Math.floor(offset / limit) + 1;

  // Build count query
  let countSql = 'SELECT COUNT(*) as count FROM jira_issues i WHERE 1=1';
  const countParams: any[] = [];

  if (options.projectKey) {
    countSql += ' AND i.project_key = ?';
    countParams.push(options.projectKey);
  }

  if (options.status) {
    countSql += ' AND i.status = ?';
    countParams.push(options.status);
  }

  if (options.assignee) {
    countSql += ' AND i.assignee_name LIKE ?';
    countParams.push(`%${options.assignee}%`);
  }

  if (options.fromDate) {
    countSql += ' AND i.updated >= ?';
    countParams.push(Math.floor(options.fromDate.getTime() / 1000));
  }

  if (options.boardFilter === 'board') {
    countSql += ' AND i.in_backlog = 0';
  } else if (options.boardFilter === 'backlog') {
    countSql += ' AND i.in_backlog = 1';
  }

  const countStmt = db.prepare(countSql);
  const countResult = countStmt.get(...countParams) as { count: number };
  const totalCount = countResult.count;
  const totalPages = Math.ceil(totalCount / limit);

  // Build list query
  let sql = 'SELECT * FROM jira_issues i WHERE 1=1';
  const params: any[] = [];

  if (options.projectKey) {
    sql += ' AND i.project_key = ?';
    params.push(options.projectKey);
  }

  if (options.status) {
    sql += ' AND i.status = ?';
    params.push(options.status);
  }

  if (options.assignee) {
    sql += ' AND i.assignee_name LIKE ?';
    params.push(`%${options.assignee}%`);
  }

  if (options.fromDate) {
    sql += ' AND i.updated >= ?';
    params.push(Math.floor(options.fromDate.getTime() / 1000));
  }

  if (options.boardFilter === 'board') {
    sql += ' AND i.in_backlog = 0';
  } else if (options.boardFilter === 'backlog') {
    sql += ' AND i.in_backlog = 1';
  }

  sql += ' ORDER BY i.updated DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const stmt = db.prepare(sql);
  const rows = stmt.all(...params) as JiraIssueRow[];

  return {
    results: rows.map(rowToResult),
    totalCount,
    page,
    perPage: limit,
    totalPages,
  };
}

/**
 * Get a single issue by key
 */
export function getIssueByKey(key: string): JiraSearchResult | null {
  const db = getJiraDatabase();
  const stmt = db.prepare('SELECT * FROM jira_issues WHERE key = ?');
  const row = stmt.get(key) as JiraIssueRow | undefined;

  if (!row) return null;
  return rowToResult(row);
}

/**
 * Check if database has any issues
 */
export function hasIssues(): boolean {
  const db = getJiraDatabase();
  const stmt = db.prepare('SELECT COUNT(*) as count FROM jira_issues');
  const result = stmt.get() as { count: number };
  return result.count > 0;
}

/**
 * Get the most recent sync timestamp across all projects
 * Returns null if no sync has occurred
 */
export function getLastSyncTime(): Date | null {
  const db = getJiraDatabase();
  const stmt = db.prepare('SELECT MAX(last_sync_at) as last_sync FROM jira_sync_state');
  const result = stmt.get() as { last_sync: number | null };
  return result.last_sync ? new Date(result.last_sync * 1000) : null;
}

/**
 * Get database statistics
 */
export function getDatabaseStats(): {
  totalIssues: number;
  projects: number;
  statusBreakdown: { status: string; count: number }[];
  oldestUpdated: Date | null;
  newestUpdated: Date | null;
} {
  const db = getJiraDatabase();

  const countStmt = db.prepare('SELECT COUNT(*) as count FROM jira_issues');
  const countResult = countStmt.get() as { count: number };

  const projectsStmt = db.prepare('SELECT COUNT(DISTINCT project_key) as count FROM jira_issues');
  const projectsResult = projectsStmt.get() as { count: number };

  const statusStmt = db.prepare(`
    SELECT status, COUNT(*) as count
    FROM jira_issues
    GROUP BY status
    ORDER BY count DESC
    LIMIT 10
  `);
  const statusBreakdown = statusStmt.all() as { status: string; count: number }[];

  const oldestStmt = db.prepare('SELECT MIN(updated) as date FROM jira_issues');
  const oldestResult = oldestStmt.get() as { date: number | null };

  const newestStmt = db.prepare('SELECT MAX(updated) as date FROM jira_issues');
  const newestResult = newestStmt.get() as { date: number | null };

  return {
    totalIssues: countResult.count,
    projects: projectsResult.count,
    statusBreakdown,
    oldestUpdated: oldestResult.date ? new Date(oldestResult.date * 1000) : null,
    newestUpdated: newestResult.date ? new Date(newestResult.date * 1000) : null,
  };
}
