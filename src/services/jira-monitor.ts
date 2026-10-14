// JIRA health monitoring service — detects stuck tickets, inactive users, low pipelines

import { Version2Client } from 'jira.js';
import type {
  JiraMonitorStatusConfig,
  ResolvedJiraMonitorStalenessConfig,
} from '../config/types.js';

const BATCH_SIZE = 100;
const FETCH_DELAY_MS = 500;
// Hard upper bound on paginated fetches per query so a malformed / repeating
// `nextPageToken` cannot spin forever. 100 pages * 100 issues = 10k tickets,
// well beyond any realistic PROJ project size.
const MAX_PAGES = 100;

// ── Types ───────────────────────────────────────────────────────────

export interface StuckIssue {
  key: string;
  summary: string;
  assignee: string | null;
  stuckDays: number;
  lastActivityAt: string;
  lastActivitySource: 'status_change' | 'comment' | 'updated_field';
  commentCount: number;
}

export interface InactiveUser {
  name: string;
  daysSinceActivity: number;
  ticketCount: number;
  mostRecentTicket: string;
  mostRecentUpdated: string;
}

export interface LowPipelineUser {
  name: string;
  plannedCount: number;
  iceboxCount: number;
  totalPipeline: number;
}

export interface StaleTicket {
  key: string;
  summary: string;
  assignee: string | null;
  status: string;
  idleDays: number;
  createdDays: number;
}

export interface StalenessResult {
  ageing: StaleTicket[];
  stale: StaleTicket[];
}

export interface MonitorResult {
  stuck: StuckIssue[];
  inactive: InactiveUser[];
  lowPipeline: LowPipelineUser[];
}

/** Fully resolved status set used inside the monitor after defaults are applied. */
export interface ResolvedStatuses {
  inProgress: string;
  planned: string;
  icebox: string;
  done: string;
  openWorkExclude: string[];
}

/** Optional per-call overrides for the monitor service. */
export interface MonitorOptions {
  statuses?: JiraMonitorStatusConfig;
  pipelineStatuses?: string[];
  excludeBacklog?: boolean;
  backlogKeys?: ReadonlySet<string>;
  staleness?: ResolvedJiraMonitorStalenessConfig;
}

const DEFAULT_STATUSES: ResolvedStatuses = {
  inProgress: 'In Progress',
  planned: 'Planned',
  icebox: 'Icebox',
  done: 'Done',
  openWorkExclude: ['Done', 'Test'],
};
const DEFAULT_PIPELINE_STATUSES = ['Planned'];
const DEFAULT_STALENESS: ResolvedJiraMonitorStalenessConfig = {
  inProgress: { ageing: 7, stale: 14 },
  planned: { ageing: 30, stale: 90 },
};

// ── Helpers ─────────────────────────────────────────────────────────

function daysAgo(dateStr: string): number {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Validate a JQL literal before it is interpolated into a JQL string.
 *
 * Status names are user-configurable, so a bad config must not be able to
 * emit a malformed or surprising query. We reject any character that could
 * break out of the surrounding double-quoted string (double quote, backslash,
 * newline, carriage return) or produce an empty literal.
 */
function assertSafeJqlLiteral(value: string, path: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid JQL literal at ${path}: must be a non-empty string`);
  }
  if (/["\\\r\n]/.test(value)) {
    throw new Error(
      `Invalid JQL literal at ${path}: value contains a disallowed character (", \\, CR, LF): ${JSON.stringify(value)}`,
    );
  }
}

/** Quote a validated status name as a JQL string literal, e.g. `In Progress` -> `"In Progress"`. */
function quoteJqlStatus(value: string, path: string): string {
  assertSafeJqlLiteral(value, path);
  return `"${value}"`;
}

/**
 * Resolve a possibly-partial status config against the built-in defaults.
 * Every returned field is guaranteed to be safe for JQL interpolation.
 */
export function resolveStatuses(config?: JiraMonitorStatusConfig): ResolvedStatuses {
  const inProgress = config?.inProgress ?? DEFAULT_STATUSES.inProgress;
  const planned = config?.planned ?? DEFAULT_STATUSES.planned;
  const icebox = config?.icebox ?? DEFAULT_STATUSES.icebox;
  const done = config?.done ?? DEFAULT_STATUSES.done;
  const openWorkExclude = config?.openWorkExclude ?? DEFAULT_STATUSES.openWorkExclude;

  assertSafeJqlLiteral(inProgress, 'jiraMonitor.statuses.inProgress');
  assertSafeJqlLiteral(planned, 'jiraMonitor.statuses.planned');
  assertSafeJqlLiteral(icebox, 'jiraMonitor.statuses.icebox');
  assertSafeJqlLiteral(done, 'jiraMonitor.statuses.done');
  if (!Array.isArray(openWorkExclude)) {
    throw new Error('Invalid JIRA monitor status at jiraMonitor.statuses.openWorkExclude: must be an array of strings');
  }
  if (openWorkExclude.length === 0) {
    // An empty array would render as `status not in ()`, which JIRA rejects at
    // query time and would silently break the inactive-users check. Reject
    // this up-front with a clear error — the user must either drop the config
    // key entirely (falls back to the default `["Done", "Test"]`) or provide
    // at least one status name.
    throw new Error(
      'Invalid JIRA monitor status at jiraMonitor.statuses.openWorkExclude: must contain at least one status name (omit the key entirely to use the default ["Done", "Test"])',
    );
  }
  openWorkExclude.forEach((s, i) =>
    assertSafeJqlLiteral(s, `jiraMonitor.statuses.openWorkExclude[${i}]`),
  );

  // If `planned` and `icebox` are configured to the SAME status,
  // `findLowPipelineUsers` would double-count every matching ticket (both
  // `if` branches fire) and hide low-pipeline users. This is virtually never
  // what the operator wants — reject at config-load time so the monitor
  // fails loud instead of returning silently wrong counts.
  if (planned === icebox) {
    throw new Error(
      `Invalid JIRA monitor status: 'planned' and 'icebox' must be different statuses (both are ${JSON.stringify(planned)}). Low-pipeline counting would double-count every matching ticket.`,
    );
  }

  return { inProgress, planned, icebox, done, openWorkExclude };
}

/** Build `("A", "B", "C")` JQL list, validating each entry. */
function jqlList(values: string[], path: string): string {
  return `(${values.map((v, i) => quoteJqlStatus(v, `${path}[${i}]`)).join(', ')})`;
}

function resolvePipelineStatuses(options?: MonitorOptions): string[] {
  const values = options?.pipelineStatuses ?? DEFAULT_PIPELINE_STATUSES;
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('Invalid JIRA monitor pipeline statuses: must be a non-empty array');
  }
  values.forEach((value, i) => assertSafeJqlLiteral(value, `jiraMonitor.pipelineStatuses[${i}]`));
  return [...new Set(values)];
}

/**
 * Iterate every page of an enhanced-search JQL query.
 *
 * - Uses `nextPageToken` (jira.js v5) rather than `startAt`.
 * - Enforces `MAX_PAGES` so a malformed or repeating token cannot spin forever.
 * - Sleeps `FETCH_DELAY_MS` between pages to stay under JIRA rate limits.
 *
 * The callback runs synchronously (per page) — pagination happens BEFORE the
 * next fetch. The generator-free shape keeps the call sites readable.
 */
async function forEachIssuePage(
  client: Version2Client,
  jql: string,
  fields: string[],
  handlePage: (issues: any[]) => void,
): Promise<void> {
  let nextPageToken: string | undefined;
  let pages = 0;
  while (true) {
    if (pages >= MAX_PAGES) {
      throw new Error(
        `JIRA monitor pagination exceeded MAX_PAGES=${MAX_PAGES} for JQL: ${jql}. ` +
          `This indicates a malformed nextPageToken loop or an unexpectedly large result set.`,
      );
    }
    const result = await client.issueSearch.searchForIssuesUsingJqlEnhancedSearch({
      jql,
      maxResults: BATCH_SIZE,
      nextPageToken,
      fields,
    });
    const issues = result.issues || [];
    handlePage(issues);
    pages++;

    // Per Atlassian's paginated search contract, an intermediate page MAY be
    // empty while still carrying a valid `nextPageToken` — so termination is
    // driven exclusively by the absence of a token. Runaway protection is the
    // MAX_PAGES check at the top of the loop, not the empty-page shortcut.
    nextPageToken = result.nextPageToken;
    if (!nextPageToken) break;
    await sleep(FETCH_DELAY_MS);
  }
}

// ── Mode 1: Stuck In Progress ───────────────────────────────────────

export async function findStuckInProgress(
  client: Version2Client,
  project: string,
  thresholdDays: number,
  onProgress?: (current: number, total: number, key: string) => void,
  activeUsers?: string[],
  options?: MonitorOptions,
): Promise<StuckIssue[]> {
  const statuses = resolveStatuses(options?.statuses);
  const projectQuoted = quoteJqlStatus(project, 'project');

  // Fetch ALL In Progress tickets across every page before we start the
  // per-issue detail loop, so `onProgress.total` reflects the true count
  // (not the first page's).
  const jql =
    `project = ${projectQuoted} AND status = ${quoteJqlStatus(statuses.inProgress, 'jiraMonitor.statuses.inProgress')} ` +
    `AND issuetype != Epic ORDER BY updated ASC`;

  const issueKeys: string[] = [];
  await forEachIssuePage(client, jql, ['key'], (issues) => {
    for (const i of issues) {
      if (i.key) issueKeys.push(i.key);
    }
  });

  const stuck: StuckIssue[] = [];

  for (let i = 0; i < issueKeys.length; i++) {
    const key = issueKeys[i];
    onProgress?.(i + 1, issueKeys.length, key);

    const issue = await client.issues.getIssue({
      issueIdOrKey: key,
      fields: ['summary', 'status', 'assignee', 'updated', 'comment'],
      expand: 'changelog',
    });

    const fields = issue.fields as any;
    const changelog = (issue as any).changelog;

    // Find last status change
    let lastStatusChangeAt: string | null = null;
    if (changelog?.histories) {
      for (const history of changelog.histories) {
        for (const item of history.items || []) {
          if (item.field === 'status') {
            if (!lastStatusChangeAt || history.created > lastStatusChangeAt) {
              lastStatusChangeAt = history.created;
            }
          }
        }
      }
    }

    // Find latest comment
    let latestCommentAt: string | null = null;
    let commentCount = 0;
    const comments = fields.comment;
    if (comments?.comments && Array.isArray(comments.comments)) {
      commentCount = comments.comments.length;
      for (const c of comments.comments) {
        const commentDate = c.updated || c.created;
        if (commentDate && (!latestCommentAt || commentDate > latestCommentAt)) {
          latestCommentAt = commentDate;
        }
      }
    }

    // Determine real last activity
    const candidates: Array<{ date: string; source: StuckIssue['lastActivitySource'] }> = [];
    if (lastStatusChangeAt) candidates.push({ date: lastStatusChangeAt, source: 'status_change' });
    if (latestCommentAt) candidates.push({ date: latestCommentAt, source: 'comment' });
    candidates.push({ date: fields.updated, source: 'updated_field' });
    candidates.sort((a, b) => b.date.localeCompare(a.date));

    const best = candidates[0];
    const days = daysAgo(best.date);

    if (days >= thresholdDays) {
      stuck.push({
        key,
        summary: fields.summary || '',
        assignee: fields.assignee?.displayName || null,
        stuckDays: days,
        lastActivityAt: best.date,
        lastActivitySource: best.source,
        commentCount,
      });
    }

    if (i < issueKeys.length - 1) {
      await sleep(FETCH_DELAY_MS);
    }
  }

  // Sort by stuckDays descending
  stuck.sort((a, b) => b.stuckDays - a.stuckDays);

  // Filter to active users only if configured
  if (activeUsers) {
    const set = new Set(activeUsers);
    return stuck.filter(i => !i.assignee || set.has(i.assignee));
  }
  return stuck;
}

// ── Mode 2: Inactive Users ──────────────────────────────────────────

export async function findInactiveUsers(
  client: Version2Client,
  project: string,
  thresholdDays: number,
  activeUsers?: string[],
  options?: MonitorOptions,
): Promise<InactiveUser[]> {
  const statuses = resolveStatuses(options?.statuses);
  const projectQuoted = quoteJqlStatus(project, 'project');
  const excludeList = jqlList(statuses.openWorkExclude, 'jiraMonitor.statuses.openWorkExclude');
  const jql =
    `project = ${projectQuoted} AND status not in ${excludeList} ` +
    `AND assignee is not EMPTY ORDER BY updated DESC`;

  const userActivity = new Map<string, { latestUpdate: string; ticketCount: number; mostRecentKey: string }>();

  await forEachIssuePage(client, jql, ['assignee', 'updated'], (issues) => {
    for (const issue of issues) {
      const fields = issue.fields as any;
      const name = fields.assignee?.displayName;
      if (!name) continue;

      const existing = userActivity.get(name);
      if (!existing || fields.updated > existing.latestUpdate) {
        userActivity.set(name, {
          latestUpdate: fields.updated,
          ticketCount: (existing?.ticketCount || 0) + 1,
          mostRecentKey: issue.key!,
        });
      } else {
        existing.ticketCount++;
      }
    }
  });

  const inactive: InactiveUser[] = [];
  for (const [name, info] of userActivity) {
    const days = daysAgo(info.latestUpdate);
    if (days >= thresholdDays) {
      inactive.push({
        name,
        daysSinceActivity: days,
        ticketCount: info.ticketCount,
        mostRecentTicket: info.mostRecentKey,
        mostRecentUpdated: info.latestUpdate,
      });
    }
  }

  inactive.sort((a, b) => b.daysSinceActivity - a.daysSinceActivity);

  if (activeUsers) {
    const set = new Set(activeUsers);
    return inactive.filter(u => set.has(u.name));
  }
  return inactive;
}

// ── Mode 3: Low Pipeline ────────────────────────────────────────────

export async function findLowPipelineUsers(
  client: Version2Client,
  project: string,
  minTasks: number,
  activeUsers?: string[],
  options?: MonitorOptions,
): Promise<LowPipelineUser[]> {
  const statuses = resolveStatuses(options?.statuses);
  const pipelineStatuses = resolvePipelineStatuses(options);
  const excludeBacklog = options?.excludeBacklog ?? true;
  if (excludeBacklog && !options?.backlogKeys) {
    throw new Error('Board-aware pipeline counting requires backlogKeys when excludeBacklog is true');
  }
  const projectQuoted = quoteJqlStatus(project, 'project');
  const pipelineList = jqlList(pipelineStatuses, 'jiraMonitor.pipelineStatuses');
  const openWorkExclude = jqlList(statuses.openWorkExclude, 'jiraMonitor.statuses.openWorkExclude');

  // Query 1: all configured pipeline tickets with assignees (paginated).
  const pipelineJql =
    `project = ${projectQuoted} AND status in ${pipelineList} ` +
    `AND assignee is not EMPTY`;

  const configuredStatuses = new Set(pipelineStatuses);
  const counts = new Map<string, number>();
  await forEachIssuePage(client, pipelineJql, ['key', 'status', 'assignee'], (issues) => {
    for (const issue of issues) {
      if (excludeBacklog && issue.key && options!.backlogKeys!.has(issue.key)) continue;
      const fields = issue.fields as any;
      const name = fields.assignee?.displayName;
      if (!name) continue;
      const statusName = fields.status?.name;
      if (!configuredStatuses.has(statusName)) continue;
      counts.set(name, (counts.get(name) || 0) + 1);
    }
  });

  // Query 2: all active team members — use the same configured definition of
  // open work as the inactive-users check (paginated).
  const teamJql =
    `project = ${projectQuoted} AND status not in ${openWorkExclude} ` +
    `AND assignee is not EMPTY`;

  const allMembers = new Set<string>();
  await forEachIssuePage(client, teamJql, ['assignee'], (issues) => {
    for (const issue of issues) {
      const name = (issue.fields as any).assignee?.displayName;
      if (name) allMembers.add(name);
    }
  });

  // Use activeUsers if configured, otherwise all members with open tickets.
  const membersToCheck = activeUsers ? new Set(activeUsers) : allMembers;

  const lowPipeline: LowPipelineUser[] = [];
  for (const member of membersToCheck) {
    const total = counts.get(member) || 0;
    if (total < minTasks) {
      lowPipeline.push({
        name: member,
        plannedCount: total,
        iceboxCount: 0,
        totalPipeline: total,
      });
    }
  }

  lowPipeline.sort((a, b) => a.totalPipeline - b.totalPipeline);
  return lowPipeline;
}

// ── Mode 4: Two-tier staleness ─────────────────────────────────────

export async function findStaleTickets(
  client: Version2Client,
  project: string,
  options?: MonitorOptions,
): Promise<StalenessResult> {
  const statuses = resolveStatuses(options?.statuses);
  const pipelineStatuses = resolvePipelineStatuses(options);
  const backlogKeys = options?.backlogKeys;
  if (!backlogKeys) {
    throw new Error('Board-aware staleness classification requires backlogKeys');
  }
  const thresholds = options?.staleness ?? DEFAULT_STALENESS;
  const projectQuoted = quoteJqlStatus(project, 'project');
  const relevantStatuses = [...new Set([statuses.inProgress, ...pipelineStatuses])];
  const relevantList = jqlList(relevantStatuses, 'jiraMonitor.staleness.statuses');
  const pipelineSet = new Set(pipelineStatuses);
  const result: StalenessResult = { ageing: [], stale: [] };

  const jql =
    `project = ${projectQuoted} AND status in ${relevantList} ORDER BY updated ASC`;

  await forEachIssuePage(client, jql, ['key', 'summary', 'assignee', 'status', 'updated', 'created'], (issues) => {
    for (const issue of issues) {
      if (!issue.key || backlogKeys.has(issue.key)) continue;
      const fields = issue.fields as any;
      const assignee = fields.assignee?.displayName || null;
      const status = fields.status?.name;
      const bucket = status === statuses.inProgress
        ? 'inProgress'
        : pipelineSet.has(status)
          ? 'planned'
          : undefined;
      if (!bucket) continue;
      if (!fields.updated || Number.isNaN(new Date(fields.updated).getTime())) {
        throw new Error(`JIRA issue ${issue.key} has an invalid updated timestamp`);
      }
      if (!fields.created || Number.isNaN(new Date(fields.created).getTime())) {
        throw new Error(`JIRA issue ${issue.key} has an invalid created timestamp`);
      }
      const ticket: StaleTicket = {
        key: issue.key,
        summary: fields.summary || '',
        assignee,
        status,
        idleDays: daysAgo(fields.updated),
        createdDays: daysAgo(fields.created),
      };
      const threshold = thresholds[bucket];
      if (ticket.idleDays >= threshold.stale) result.stale.push(ticket);
      else if (ticket.idleDays >= threshold.ageing) result.ageing.push(ticket);
    }
  });

  result.ageing.sort((a, b) => b.idleDays - a.idleDays);
  result.stale.sort((a, b) => b.idleDays - a.idleDays);
  return result;
}
