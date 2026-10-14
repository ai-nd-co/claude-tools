import { AgileClient } from 'jira.js';

const BATCH_SIZE = 100;
const FETCH_DELAY_MS = 500;
// Same runaway bound as the enhanced-search paginator in jira-monitor.ts.
// Agile endpoints use startAt/total rather than nextPageToken.
const MAX_PAGES = 100;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function resolveBoardId(
  agile: AgileClient,
  projectKey: string,
  configuredId?: number,
): Promise<number> {
  if (configuredId !== undefined) return configuredId;

  const boards: Array<{ id?: number; name?: string; type?: string }> = [];
  let startAt = 0;
  let pages = 0;

  while (true) {
    if (pages >= MAX_PAGES) {
      throw new Error(
        `JIRA board discovery exceeded MAX_PAGES=${MAX_PAGES} for project ${projectKey}.`,
      );
    }
    const result = await agile.board.getAllBoards({
      projectKeyOrId: projectKey,
      startAt,
      maxResults: BATCH_SIZE,
    });
    const values = result.values || [];
    boards.push(...values);
    pages++;

    const responseStart = result.startAt ?? startAt;
    const hasTotal = Number.isInteger(result.total) && result.total! >= 0;
    if (result.isLast === true || (hasTotal && responseStart + values.length >= result.total!)) {
      break;
    }
    if (values.length === 0) {
      // Some Jira deployments omit both `total` and `isLast`. In that case an
      // empty page is the only reliable end marker. If metadata says more data
      // exists, however, an empty page would silently under-discover boards.
      if (!hasTotal && result.isLast === undefined) break;
      throw new Error(
        `JIRA board discovery returned an empty page at startAt=${startAt} before pagination completed for project ${projectKey}.`,
      );
    }
    startAt = responseStart + values.length;
    await sleep(FETCH_DELAY_MS);
  }

  if (boards.length === 0) {
    throw new Error(`No JIRA Agile board found for project ${projectKey}. Set jiraMonitor.boardId explicitly.`);
  }
  if (boards.length > 1) {
    const candidates = boards
      .map(board => `${board.id ?? '?'}: ${board.name || '(unnamed)'} (${board.type || 'unknown'})`)
      .join(', ');
    throw new Error(
      `Multiple JIRA Agile boards found for project ${projectKey}: ${candidates}. Set jiraMonitor.boardId explicitly.`,
    );
  }
  const id = boards[0].id;
  if (!Number.isInteger(id)) {
    throw new Error(`JIRA Agile board for project ${projectKey} did not include a valid numeric id.`);
  }
  return id!;
}

export async function fetchBacklogKeys(
  agile: AgileClient,
  boardId: number,
): Promise<Set<string>> {
  const keys = new Set<string>();
  let startAt = 0;
  let pages = 0;
  let fetchedCount = 0;

  while (true) {
    if (pages >= MAX_PAGES) {
      throw new Error(
        `JIRA backlog pagination exceeded MAX_PAGES=${MAX_PAGES} for board ${boardId}. ` +
          'This indicates a malformed startAt/total loop or an unexpectedly large backlog.',
      );
    }
    const result = await agile.board.getIssuesForBacklog({
      boardId,
      startAt,
      maxResults: BATCH_SIZE,
      fields: ['key'],
    });
    const issues = result.issues || [];
    for (const issue of issues) {
      if (issue.key) keys.add(issue.key);
    }
    fetchedCount += issues.length;
    pages++;

    if (!Number.isInteger(result.total) || result.total < 0) {
      throw new Error(`JIRA backlog response for board ${boardId} did not include a valid total.`);
    }
    const responseStart = result.startAt ?? startAt;
    if (responseStart + issues.length >= result.total) {
      if (fetchedCount !== result.total || keys.size !== result.total) {
        throw new Error(
          `JIRA backlog fetch for board ${boardId} was incomplete: ` +
            `fetched ${fetchedCount} issues / ${keys.size} unique keys of reported total ${result.total}.`,
        );
      }
      break;
    }
    if (issues.length === 0) {
      throw new Error(
        `JIRA backlog returned an empty page at startAt=${startAt} before total=${result.total} for board ${boardId}.`,
      );
    }
    startAt = responseStart + issues.length;
    await sleep(FETCH_DELAY_MS);
  }

  return keys;
}
