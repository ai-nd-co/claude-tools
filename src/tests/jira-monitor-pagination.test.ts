// Multi-page consumption tests for the JIRA monitor service.
//
// Focus of this test file:
//   - findStuckInProgress and findLowPipelineUsers previously used a single
//     `maxResults`-capped request and would silently drop everything past the
//     cap. The refactor drives them off `nextPageToken`. These tests fake a
//     jira.js Version2Client that returns THREE pages of results and asserts:
//       1) every item on every page is consumed,
//       2) the loop terminates when `nextPageToken` is absent, and
//       3) the maxResults page size is not raised (still BATCH_SIZE=100).
//
// We also cover the JQL injection guard (a status containing `"` must throw
// before any network call), and the low-pipeline "team members" query — which
// is the second, easy-to-forget paginated call inside findLowPipelineUsers.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findStuckInProgress,
  findInactiveUsers,
  findLowPipelineUsers,
  resolveStatuses,
} from '../services/jira-monitor.js';

// ── Fake client factory ─────────────────────────────────────────────

interface FakeSearchCall {
  jql: string;
  maxResults?: number;
  nextPageToken?: string;
  fields?: string[];
}

interface FakePage {
  issues: any[];
  nextPageToken?: string;
}

/**
 * Build a fake Version2Client. Each entry in `pagesByJql` is the ordered list
 * of pages to return for a matching JQL prefix (we match by first `AND` slice
 * to keep the test tolerant of whitespace/ordering tweaks).
 */
function makeFakeClient(
  pagesByJql: Record<string, FakePage[]>,
  issueByKey: Record<string, any> = {},
): { client: any; calls: FakeSearchCall[] } {
  const calls: FakeSearchCall[] = [];
  const counters: Record<string, number> = {};

  function pick(jql: string): FakePage {
    for (const prefix of Object.keys(pagesByJql)) {
      if (jql.includes(prefix)) {
        const idx = counters[prefix] ?? 0;
        const list = pagesByJql[prefix];
        const page = list[Math.min(idx, list.length - 1)];
        counters[prefix] = idx + 1;
        return page;
      }
    }
    throw new Error(`Fake client got unexpected JQL: ${jql}`);
  }

  const client = {
    issueSearch: {
      async searchForIssuesUsingJqlEnhancedSearch(params: FakeSearchCall) {
        calls.push(params);
        const page = pick(params.jql);
        return { issues: page.issues, nextPageToken: page.nextPageToken };
      },
    },
    issues: {
      async getIssue({ issueIdOrKey }: { issueIdOrKey: string }) {
        const issue = issueByKey[issueIdOrKey];
        if (!issue) throw new Error(`Fake client: no fixture for ${issueIdOrKey}`);
        return issue;
      },
    },
  };

  return { client, calls };
}

// A synthetic "stuck" issue that is well past any threshold.
function stuckIssueFixture(key: string, assignee = 'Alice') {
  const twoYearsAgo = new Date(Date.now() - 730 * 24 * 3600 * 1000).toISOString();
  return {
    key,
    fields: {
      summary: `Summary for ${key}`,
      status: { name: 'In Progress' },
      assignee: { displayName: assignee },
      updated: twoYearsAgo,
      comment: { comments: [] },
    },
    changelog: { histories: [] },
  };
}

// ── Test 1: findStuckInProgress paginates every page ────────────────

test('findStuckInProgress consumes every page and reports the paginated total', async () => {
  // Small page fixtures keep test runtime bounded: the per-issue detail loop
  // sleeps FETCH_DELAY_MS=500ms between issues, so this test stays under ~5s.
  // What we're proving is behavioural (multi-page consumption), not page size.
  const keysA = Array.from({ length: 3 }, (_, i) => `PROJ-A${i}`);
  const keysB = Array.from({ length: 3 }, (_, i) => `PROJ-B${i}`);
  const keysC = Array.from({ length: 2 }, (_, i) => `PROJ-C${i}`);
  const allKeys = [...keysA, ...keysB, ...keysC];

  const issueByKey: Record<string, any> = {};
  for (const k of allKeys) issueByKey[k] = stuckIssueFixture(k);

  const { client, calls } = makeFakeClient(
    {
      // JQL discriminator for the stuck-in-progress query.
      'status = "In Progress"': [
        { issues: keysA.map(k => ({ key: k })), nextPageToken: 'tok-A' },
        { issues: keysB.map(k => ({ key: k })), nextPageToken: 'tok-B' },
        { issues: keysC.map(k => ({ key: k })), nextPageToken: undefined },
      ],
    },
    issueByKey,
  );

  const progressCalls: Array<{ current: number; total: number; key: string }> = [];
  const stuck = await findStuckInProgress(
    client as any,
    'PROJ',
    1, // threshold in days
    (current, total, key) => progressCalls.push({ current, total, key }),
    undefined,
  );

  // Every fetched key must have flowed through onProgress with total==allKeys.length.
  assert.equal(progressCalls.length, allKeys.length, 'onProgress fired once per key');
  assert.equal(progressCalls[0].total, allKeys.length, 'total is paginated count, not page-1 length');
  assert.equal(
    progressCalls[progressCalls.length - 1].total,
    allKeys.length,
    'total stays stable across the loop',
  );
  assert.deepEqual(
    progressCalls.map(p => p.key),
    allKeys,
    'every page contributed keys in order',
  );

  // Every synthetic issue is old enough to be "stuck" -> full pass-through.
  assert.equal(stuck.length, allKeys.length);

  // Pagination request shape: 3 search calls, page size 100, token chaining.
  const searchCalls = calls;
  assert.equal(searchCalls.length, 3, 'three pages fetched');
  assert.equal(searchCalls[0].maxResults, 100, 'page size stays at BATCH_SIZE=100');
  assert.equal(searchCalls[0].nextPageToken, undefined, 'first fetch has no token');
  assert.equal(searchCalls[1].nextPageToken, 'tok-A');
  assert.equal(searchCalls[2].nextPageToken, 'tok-B');
});

// ── Test 2: findLowPipelineUsers paginates BOTH queries ─────────────

test('findLowPipelineUsers paginates BOTH the pipeline query and the team query', async () => {
  // Pipeline query pages (Planned + Icebox with assignees):
  // Alice ends up with 1 planned + 0 icebox = 1 total (below minTasks=2)
  // Bob   ends up with 0 planned + 5 icebox = 5 total (above threshold)
  const pipelinePage1 = {
    issues: [
      { key: 'PROJ-P1', fields: { status: { name: 'Planned' }, assignee: { displayName: 'Alice' } } },
      { key: 'PROJ-P2', fields: { status: { name: 'Icebox' }, assignee: { displayName: 'Bob' } } },
    ],
    nextPageToken: 'pip-1',
  };
  const pipelinePage2 = {
    issues: [
      { key: 'PROJ-P3', fields: { status: { name: 'Icebox' }, assignee: { displayName: 'Bob' } } },
      { key: 'PROJ-P4', fields: { status: { name: 'Icebox' }, assignee: { displayName: 'Bob' } } },
    ],
    nextPageToken: 'pip-2',
  };
  const pipelinePage3 = {
    issues: [
      { key: 'PROJ-P5', fields: { status: { name: 'Icebox' }, assignee: { displayName: 'Bob' } } },
      { key: 'PROJ-P6', fields: { status: { name: 'Icebox' }, assignee: { displayName: 'Bob' } } },
    ],
    nextPageToken: undefined,
  };

  // Team query pages (non-Done with assignees) — three pages, third has Carol only.
  const teamPage1 = {
    issues: [{ key: 'PROJ-T1', fields: { assignee: { displayName: 'Alice' } } }],
    nextPageToken: 'team-1',
  };
  const teamPage2 = {
    issues: [{ key: 'PROJ-T2', fields: { assignee: { displayName: 'Bob' } } }],
    nextPageToken: 'team-2',
  };
  const teamPage3 = {
    issues: [{ key: 'PROJ-T3', fields: { assignee: { displayName: 'Carol' } } }],
    nextPageToken: undefined,
  };

  const { client, calls } = makeFakeClient({
    // The two queries differ; use unambiguous JQL substrings as discriminators.
    'status in ("Planned"': [pipelinePage1, pipelinePage2, pipelinePage3],
    'status not in ("Done", "Test")': [teamPage1, teamPage2, teamPage3],
  });

  const low = await findLowPipelineUsers(
    client as any,
    'PROJ',
    2,
    undefined,
    { pipelineStatuses: ['Planned', 'Icebox'], excludeBacklog: false },
  );

  // 3 pipeline pages + 3 team pages = 6 total search calls.
  assert.equal(calls.length, 6, 'both queries paginated fully');

  // Team roster must include Carol (page 3 of team query) — this is the
  // exact bug the test is guarding against.
  const names = low.map(u => u.name).sort();
  assert.ok(names.includes('Carol'), 'Carol arrives on team page 3 and must appear as low-pipeline (0 tasks)');
  assert.ok(names.includes('Alice'), 'Alice has 1 planned (below min 2)');
  assert.ok(!names.includes('Bob'), 'Bob has 5 icebox items — above threshold');

  const alice = low.find(u => u.name === 'Alice')!;
  assert.equal(alice.plannedCount, 1);
  assert.equal(alice.iceboxCount, 0);

  const carol = low.find(u => u.name === 'Carol')!;
  assert.equal(carol.totalPipeline, 0);

  // Token chaining sanity on both queries.
  const pipCalls = calls.filter(c => c.jql.includes('status in ("Planned"'));
  assert.deepEqual(
    pipCalls.map(c => c.nextPageToken),
    [undefined, 'pip-1', 'pip-2'],
  );
  const teamCalls = calls.filter(c => c.jql.includes('status not in ("Done", "Test")'));
  assert.deepEqual(
    teamCalls.map(c => c.nextPageToken),
    [undefined, 'team-1', 'team-2'],
  );
});

// ── Test 3a: empty intermediate page still keeps paginating ─────────

test('pagination continues across an empty intermediate page that carries a token', async () => {
  // Regression: the paginator previously exited early on the first empty
  // `issues` array even when `nextPageToken` was set. Atlassian's contract
  // allows an intermediate page to be empty, so the loop must keep going
  // until the token itself is absent.
  const { client, calls } = makeFakeClient({
    'status in ("Planned"': [
      { issues: [], nextPageToken: 'pip-empty' },  // empty but has more
      {
        issues: [
          { key: 'PROJ-P9', fields: { status: { name: 'Planned' }, assignee: { displayName: 'Dave' } } },
        ],
        nextPageToken: undefined,
      },
    ],
    // Team query is single-page so it doesn't dominate the assertion below.
    'status not in ("Done", "Test")': [
      {
        issues: [{ key: 'PROJ-T9', fields: { assignee: { displayName: 'Dave' } } }],
        nextPageToken: undefined,
      },
    ],
  });

  const low = await findLowPipelineUsers(
    client as any,
    'PROJ',
    2,
    undefined,
    { pipelineStatuses: ['Planned', 'Icebox'], excludeBacklog: false },
  );
  // Dave's Planned ticket from page 2 of the pipeline query must be counted.
  const dave = low.find(u => u.name === 'Dave');
  assert.ok(dave, 'Dave should be classified as low-pipeline');
  assert.equal(dave!.plannedCount, 1, 'the Planned ticket on the SECOND page must be counted');

  const pipCalls = calls.filter(c => c.jql.includes('status in ("Planned"'));
  assert.equal(pipCalls.length, 2, 'paginator must fetch page 2 despite page 1 being empty');
});

// ── Test 3: absence of nextPageToken terminates the loop ────────────

test('pagination loop exits when nextPageToken is undefined', async () => {
  const { client, calls } = makeFakeClient({
    'status in ("Planned"': [{ issues: [], nextPageToken: undefined }],
    'status not in ("Done", "Test")': [{ issues: [], nextPageToken: undefined }],
  });

  const result = await findLowPipelineUsers(
    client as any,
    'PROJ',
    2,
    undefined,
    { pipelineStatuses: ['Planned', 'Icebox'], excludeBacklog: false },
  );
  assert.deepEqual(result, []);
  // Exactly one call per query, no runaway.
  assert.equal(calls.length, 2);
});

// ── Test 4: JQL injection guard ─────────────────────────────────────

test('resolveStatuses rejects a status containing a JQL-breaking character', () => {
  assert.throws(
    () => resolveStatuses({ inProgress: 'In "Progress"' }),
    /disallowed character/,
    'a status containing a double quote must throw',
  );
  assert.throws(
    () => resolveStatuses({ done: 'Done\nOR 1=1' }),
    /disallowed character/,
    'a status containing a newline must throw',
  );
  assert.throws(
    () => resolveStatuses({ planned: '' }),
    /non-empty string/,
    'an empty status must throw',
  );
  assert.throws(
    () => resolveStatuses({ openWorkExclude: ['Done', 'Test"bad'] }),
    /disallowed character/,
    'a bad element inside openWorkExclude must throw',
  );
  assert.throws(
    () => resolveStatuses({ openWorkExclude: [] }),
    /at least one status name/,
    'an empty openWorkExclude must throw (would render "status not in ()")',
  );
  // planned === icebox would double-count in findLowPipelineUsers because both
  // `if` branches would fire for every matching ticket. resolveStatuses must
  // reject this misconfiguration up-front.
  assert.throws(
    () => resolveStatuses({ planned: 'Backlog', icebox: 'Backlog' }),
    /must be different statuses/,
    'planned === icebox must throw (would double-count and hide low-pipeline users)',
  );
});

test('resolveStatuses defaults reproduce today\'s literal set', () => {
  const resolved = resolveStatuses(undefined);
  assert.equal(resolved.inProgress, 'In Progress');
  assert.equal(resolved.planned, 'Planned');
  assert.equal(resolved.icebox, 'Icebox');
  assert.equal(resolved.done, 'Done');
  assert.deepEqual(resolved.openWorkExclude, ['Done', 'Test']);
});

test('all monitor queries quote and reject unsafe project keys', async () => {
  const { client, calls } = makeFakeClient({
    'status in ("Planned"': [{ issues: [], nextPageToken: undefined }],
    'status not in ("Done", "Test")': [{ issues: [], nextPageToken: undefined }],
  });
  await findLowPipelineUsers(client as any, 'PROJ', 2, undefined, { excludeBacklog: false });
  assert.ok(calls.every(call => call.jql.startsWith('project = "PROJ"')));

  const unsafeProject = 'PROJ" OR project != "PROJ';
  await assert.rejects(findStuckInProgress(client as any, unsafeProject, 2), /disallowed character/);
  await assert.rejects(findInactiveUsers(client as any, unsafeProject, 2), /disallowed character/);
  await assert.rejects(
    findLowPipelineUsers(client as any, unsafeProject, 2, undefined, { excludeBacklog: false }),
    /disallowed character/,
  );
});
