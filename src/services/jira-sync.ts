// Jira issue sync service - fetches issues and stores in SQLite

import { Version2Client, Version2Models, AgileClient } from 'jira.js';
import { getJiraDatabase, type JiraIssueRow, type JiraSyncStateRow } from '../db/jira.js';

type Issue = Version2Models.Issue;

export interface JiraSyncOptions {
  months: number;
  force?: boolean;
  onProgress?: (count: number, latestKey: string) => void;
}

export interface JiraSyncResult {
  projectKey: string;
  projectName: string;
  issuesAdded: number;
  issuesUpdated: number;
  totalIssues: number;
}

const BATCH_SIZE = 100;
const BATCH_DELAY_MS = 1500; // 1.5 seconds between batches

/**
 * Fetch all issue keys that are in the board's backlog
 */
export async function fetchBacklogKeys(
  agileClient: AgileClient,
  boardId: number,
  onProgress?: (count: number) => void
): Promise<Set<string>> {
  const backlogKeys = new Set<string>();
  let startAt = 0;

  while (true) {
    const response = await agileClient.board.getIssuesForBacklog({
      boardId,
      startAt,
      maxResults: BATCH_SIZE,
      fields: ['key'],
    });

    for (const issue of response.issues || []) {
      if (issue.key) {
        backlogKeys.add(issue.key);
      }
    }

    onProgress?.(backlogKeys.size);

    if (!response.issues || response.issues.length < BATCH_SIZE) {
      break;
    }
    startAt += BATCH_SIZE;

    // Rate limiting
    await sleep(500);
  }

  return backlogKeys;
}

/**
 * Get the board ID for a project (returns first board found)
 */
export async function getBoardIdForProject(
  agileClient: AgileClient,
  projectKey: string
): Promise<number | null> {
  try {
    const boards = await agileClient.board.getAllBoards({ projectKeyOrId: projectKey });
    if (boards.values && boards.values.length > 0) {
      return boards.values[0].id ?? null;
    }
  } catch {
    // Board API might not be available
  }
  return null;
}

/**
 * Sleep for a specified duration
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Calculate cutoff date for sync duration
 */
function getCutoffDate(months: number): string {
  const date = new Date();
  date.setMonth(date.getMonth() - months);
  return date.toISOString().split('T')[0];
}

/**
 * Get sync state for a project
 */
export function getSyncState(projectKey: string): JiraSyncStateRow | null {
  const db = getJiraDatabase();
  const stmt = db.prepare('SELECT * FROM jira_sync_state WHERE project_key = ?');
  return stmt.get(projectKey) as JiraSyncStateRow | null;
}

/**
 * Update sync state for a project
 */
function updateSyncState(
  projectKey: string,
  projectName: string,
  lastUpdatedAt: string | null,
  issueCount: number
): void {
  const db = getJiraDatabase();
  const stmt = db.prepare(`
    INSERT INTO jira_sync_state (project_key, project_name, last_updated_at, issue_count, last_sync_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(project_key) DO UPDATE SET
      project_name = excluded.project_name,
      last_updated_at = COALESCE(excluded.last_updated_at, last_updated_at),
      issue_count = excluded.issue_count,
      last_sync_at = excluded.last_sync_at
  `);
  stmt.run(projectKey, projectName, lastUpdatedAt, issueCount, Math.floor(Date.now() / 1000));
}

/**
 * Extract plain text from Atlassian Document Format (ADF)
 */
function extractTextFromAdf(adf: any): string {
  if (!adf || typeof adf !== 'object') return '';
  if (typeof adf === 'string') return adf;

  let text = '';
  function traverse(node: any): void {
    if (node.type === 'text' && node.text) {
      text += node.text + ' ';
    }
    if (node.content && Array.isArray(node.content)) {
      for (const child of node.content) {
        traverse(child);
      }
    }
  }
  traverse(adf);
  return text.trim();
}

/**
 * Parse ISO date string to Unix timestamp
 */
function parseDate(dateStr: string | undefined | null): number {
  if (!dateStr) return 0;
  return Math.floor(new Date(dateStr).getTime() / 1000);
}

/**
 * Insert or update an issue in the database
 * Returns 'inserted' or 'updated'
 */
function upsertIssue(issue: Issue, inBacklog: boolean = false): 'inserted' | 'updated' {
  const db = getJiraDatabase();
  const fields = issue.fields as any;

  // Check if issue exists
  const existingStmt = db.prepare('SELECT id FROM jira_issues WHERE id = ?');
  const existing = existingStmt.get(issue.id);

  // Extract description text from ADF or string
  let description = '';
  if (fields.description) {
    if (typeof fields.description === 'string') {
      description = fields.description;
    } else {
      description = extractTextFromAdf(fields.description);
    }
  }

  // Extract labels as JSON string
  const labels = fields.labels ? JSON.stringify(fields.labels) : '[]';

  const stmt = db.prepare(`
    INSERT INTO jira_issues (
      id, key, project_key, summary, description, status, status_category,
      assignee_id, assignee_name, reporter_id, reporter_name, priority,
      issue_type, labels, created, updated, resolved, synced_at, in_backlog
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      key = excluded.key,
      project_key = excluded.project_key,
      summary = excluded.summary,
      description = excluded.description,
      status = excluded.status,
      status_category = excluded.status_category,
      assignee_id = excluded.assignee_id,
      assignee_name = excluded.assignee_name,
      reporter_id = excluded.reporter_id,
      reporter_name = excluded.reporter_name,
      priority = excluded.priority,
      issue_type = excluded.issue_type,
      labels = excluded.labels,
      created = excluded.created,
      updated = excluded.updated,
      resolved = excluded.resolved,
      synced_at = excluded.synced_at,
      in_backlog = excluded.in_backlog
  `);

  stmt.run(
    issue.id,
    issue.key,
    fields.project?.key || '',
    fields.summary || '',
    description,
    fields.status?.name || '',
    fields.status?.statusCategory?.name || '',
    fields.assignee?.accountId || null,
    fields.assignee?.displayName || null,
    fields.reporter?.accountId || null,
    fields.reporter?.displayName || null,
    fields.priority?.name || null,
    fields.issuetype?.name || '',
    labels,
    parseDate(fields.created),
    parseDate(fields.updated),
    parseDate(fields.resolutiondate),
    Math.floor(Date.now() / 1000),
    inBacklog ? 1 : 0
  );

  return existing ? 'updated' : 'inserted';
}

/**
 * Get issue count for a project
 */
export function getIssueCount(projectKey?: string): number {
  const db = getJiraDatabase();
  if (projectKey) {
    const stmt = db.prepare('SELECT COUNT(*) as count FROM jira_issues WHERE project_key = ?');
    const result = stmt.get(projectKey) as { count: number };
    return result.count;
  } else {
    const stmt = db.prepare('SELECT COUNT(*) as count FROM jira_issues');
    const result = stmt.get() as { count: number };
    return result.count;
  }
}

/**
 * Get list of synced projects
 */
export function getSyncedProjects(): JiraSyncStateRow[] {
  const db = getJiraDatabase();
  const stmt = db.prepare('SELECT * FROM jira_sync_state ORDER BY last_sync_at DESC');
  return stmt.all() as JiraSyncStateRow[];
}

/**
 * Get date range (oldest and newest issue updated dates) for a project
 */
export function getProjectDateRange(projectKey: string): { oldest: Date | null; newest: Date | null } {
  const db = getJiraDatabase();
  const stmt = db.prepare(`
    SELECT MIN(updated) as oldest, MAX(updated) as newest
    FROM jira_issues
    WHERE project_key = ?
  `);
  const result = stmt.get(projectKey) as { oldest: number | null; newest: number | null };
  return {
    oldest: result.oldest ? new Date(result.oldest * 1000) : null,
    newest: result.newest ? new Date(result.newest * 1000) : null,
  };
}

/**
 * Sync issues from a Jira project to the local database
 * Uses token-based pagination (nextPageToken) instead of deprecated startAt
 *
 * @param backlogKeys - Optional set of issue keys that are in the backlog
 */
export async function syncProject(
  client: Version2Client,
  projectKey: string,
  options: JiraSyncOptions,
  backlogKeys?: Set<string>
): Promise<JiraSyncResult> {
  const cutoffDate = getCutoffDate(options.months);

  // Get existing sync state
  const syncState = getSyncState(projectKey);

  // Build JQL query
  let jql = `project = ${projectKey}`;

  if (!options.force && syncState?.last_updated_at) {
    // Incremental sync - only fetch issues updated after last sync
    jql += ` AND updated >= "${syncState.last_updated_at}"`;
  } else {
    // Full sync - use cutoff date
    jql += ` AND updated >= "${cutoffDate}"`;
  }

  // Sort by updated ASC to process oldest first, with secondary sort by key for determinism
  jql += ' ORDER BY updated ASC, key ASC';

  let issuesAdded = 0;
  let issuesUpdated = 0;
  let latestUpdated: string | null = null;
  let projectName = projectKey;
  let nextPageToken: string | undefined;

  while (true) {
    try {
      // Use enhanced search with nextPageToken pagination (not deprecated startAt)
      const response = await client.issueSearch.searchForIssuesUsingJqlEnhancedSearch({
        jql,
        maxResults: BATCH_SIZE,
        nextPageToken,
        fields: [
          'summary',
          'description',
          'status',
          'assignee',
          'reporter',
          'created',
          'updated',
          'resolutiondate',
          'priority',
          'issuetype',
          'labels',
          'project'
        ],
      });

      const issues = response.issues || [];

      for (const issue of issues) {
        // Check if this issue is in the backlog
        const inBacklog = backlogKeys?.has(issue.key || '') ?? false;
        const result = upsertIssue(issue, inBacklog);
        if (result === 'inserted') {
          issuesAdded++;
        } else {
          issuesUpdated++;
        }

        const fields = issue.fields as any;

        // Track latest updated timestamp
        if (fields.updated && (fields.updated > (latestUpdated || ''))) {
          latestUpdated = fields.updated;
        }

        // Get project name from first issue
        if (fields.project?.name) {
          projectName = fields.project.name;
        }
      }

      // Progress callback
      if (options.onProgress && issues.length > 0) {
        const lastIssue = issues[issues.length - 1];
        options.onProgress(issuesAdded + issuesUpdated, lastIssue.key || '');
      }

      // Check if there are more results using nextPageToken
      nextPageToken = response.nextPageToken;
      if (!nextPageToken || issues.length === 0) {
        break;
      }

      // Rate limiting - wait between batches
      await sleep(BATCH_DELAY_MS);
    } catch (err: any) {
      // Handle rate limiting (HTTP 429)
      if (err.status === 429) {
        const retryAfter = parseInt(err.headers?.['retry-after'] || '5', 10);
        console.log(`Rate limited, waiting ${retryAfter} seconds...`);
        await sleep(retryAfter * 1000);
        continue; // Retry the same batch
      }
      throw err;
    }
  }

  // Update sync state
  const totalIssues = getIssueCount(projectKey);
  updateSyncState(projectKey, projectName, latestUpdated, totalIssues);

  return {
    projectKey,
    projectName,
    issuesAdded,
    issuesUpdated,
    totalIssues,
  };
}

/**
 * Get database statistics
 */
export function getJiraDatabaseStats(): {
  totalIssues: number;
  projects: number;
  oldestIssue: Date | null;
  newestIssue: Date | null;
} {
  const db = getJiraDatabase();

  const countStmt = db.prepare('SELECT COUNT(*) as count FROM jira_issues');
  const countResult = countStmt.get() as { count: number };

  const projectsStmt = db.prepare('SELECT COUNT(DISTINCT project_key) as count FROM jira_issues');
  const projectsResult = projectsStmt.get() as { count: number };

  const oldestStmt = db.prepare('SELECT MIN(updated) as date FROM jira_issues');
  const oldestResult = oldestStmt.get() as { date: number | null };

  const newestStmt = db.prepare('SELECT MAX(updated) as date FROM jira_issues');
  const newestResult = newestStmt.get() as { date: number | null };

  return {
    totalIssues: countResult.count,
    projects: projectsResult.count,
    oldestIssue: oldestResult.date ? new Date(oldestResult.date * 1000) : null,
    newestIssue: newestResult.date ? new Date(newestResult.date * 1000) : null,
  };
}
