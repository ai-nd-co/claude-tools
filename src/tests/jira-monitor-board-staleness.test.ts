import test from 'node:test';
import assert from 'node:assert/strict';
import { findLowPipelineUsers, findStaleTickets } from '../services/jira-monitor.js';

function searchClient(handler: (jql: string) => any[]) {
  return {
    issueSearch: {
      async searchForIssuesUsingJqlEnhancedSearch(params: { jql: string }) {
        return { issues: handler(params.jql), nextPageToken: undefined };
      },
    },
  };
}

test('low pipeline defaults to Planned-only, excludes backlog, and keeps iceboxCount at zero', async () => {
  const pipeline = [
    { key: 'PROJ-676', fields: { status: { name: 'Planned' }, assignee: { displayName: 'Alice' } } },
    { key: 'PROJ-2868', fields: { status: { name: 'Planned' }, assignee: { displayName: 'Alice' } } },
    { key: 'PROJ-I1', fields: { status: { name: 'Icebox' }, assignee: { displayName: 'Bob' } } },
  ];
  const team = ['Alice', 'Bob'].map((name, i) => ({
    key: `PROJ-T${i}`,
    fields: { assignee: { displayName: name } },
  }));
  const client = searchClient(jql => jql.includes('status not in') ? team : pipeline);

  const low = await findLowPipelineUsers(
    client as any,
    'PROJ',
    2,
    ['Alice', 'Bob'],
    { backlogKeys: new Set(['PROJ-676']) },
  );
  assert.deepEqual(low, [
    { name: 'Bob', plannedCount: 0, iceboxCount: 0, totalPipeline: 0 },
    { name: 'Alice', plannedCount: 1, iceboxCount: 0, totalPipeline: 1 },
  ]);
});

test('excludeBacklog false with Planned+Icebox reproduces old combined pipeline totals', async () => {
  const pipeline = [
    { key: 'PROJ-P1', fields: { status: { name: 'Planned' }, assignee: { displayName: 'Alice' } } },
    { key: 'PROJ-I1', fields: { status: { name: 'Icebox' }, assignee: { displayName: 'Alice' } } },
  ];
  const team = [{ key: 'PROJ-T1', fields: { assignee: { displayName: 'Alice' } } }];
  const client = searchClient(jql => jql.includes('status not in') ? team : pipeline);

  const low = await findLowPipelineUsers(
    client as any,
    'PROJ',
    3,
    ['Alice'],
    { pipelineStatuses: ['Planned', 'Icebox'], excludeBacklog: false },
  );
  assert.deepEqual(low, [
    { name: 'Alice', plannedCount: 2, iceboxCount: 0, totalPipeline: 2 },
  ]);
});

test('board-aware default refuses to run without a backlog set', async () => {
  const client = searchClient(() => []);
  await assert.rejects(
    findLowPipelineUsers(client as any, 'PROJ', 2),
    /requires backlogKeys/,
  );
});

const DAY_MS = 24 * 60 * 60 * 1000;
function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS - 60_000).toISOString();
}

function staleFixture(key: string, status: string, idleDays: number) {
  return {
    key,
    fields: {
      summary: `Summary ${key}`,
      assignee: { displayName: 'Alice' },
      status: { name: status },
      updated: daysAgo(idleDays),
      created: daysAgo(200),
    },
  };
}

test('staleness uses inclusive ageing/stale boundaries and excludes backlog', async () => {
  const issues = [
    staleFixture('PROJ-676', 'Planned', 100),
    staleFixture('PROJ-2868', 'Planned', 90),
    staleFixture('PROJ-P30', 'Planned', 30),
    staleFixture('PROJ-P29', 'Planned', 29),
    staleFixture('PROJ-IP14', 'In Progress', 14),
    staleFixture('PROJ-IP7', 'In Progress', 7),
    staleFixture('PROJ-IP6', 'In Progress', 6),
  ];
  let observedJql = '';
  const client = searchClient(jql => {
    observedJql = jql;
    return issues;
  });

  const result = await findStaleTickets(
    client as any,
    'PROJ',
    { backlogKeys: new Set(['PROJ-676']) },
  );
  assert.deepEqual(result.ageing.map(ticket => ticket.key).sort(), ['PROJ-IP7', 'PROJ-P30']);
  assert.deepEqual(result.stale.map(ticket => ticket.key).sort(), ['PROJ-2868', 'PROJ-IP14']);
  assert.ok(![...result.ageing, ...result.stale].some(ticket => ticket.key === 'PROJ-676'));
  assert.equal(result.stale.find(ticket => ticket.key === 'PROJ-2868')?.createdDays, 200);
  assert.doesNotMatch(observedJql, /issuetype/, 'staleness must classify every matching board ticket, including Epics');
});

test('staleness classifies all on-board tickets regardless of the low-pipeline active roster', async () => {
  const issues = [
    staleFixture('PROJ-ACTIVE', 'Planned', 90),
    {
      ...staleFixture('PROJ-OUTSIDE-ROSTER', 'Planned', 90),
      fields: {
        ...staleFixture('PROJ-OUTSIDE-ROSTER', 'Planned', 90).fields,
        assignee: { displayName: 'Outside roster' },
      },
    },
  ];
  const client = searchClient(() => issues);

  const result = await findStaleTickets(
    client as any,
    'PROJ',
    { backlogKeys: new Set() },
  );

  assert.deepEqual(
    result.stale.map(ticket => ticket.key).sort(),
    ['PROJ-ACTIVE', 'PROJ-OUTSIDE-ROSTER'],
  );
});
