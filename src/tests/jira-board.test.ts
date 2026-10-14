import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchBacklogKeys, resolveBoardId } from '../services/jira-board.js';

test('resolveBoardId returns an explicit board without discovery', async () => {
  let calls = 0;
  const agile = {
    board: {
      async getAllBoards() {
        calls++;
        return { values: [] };
      },
    },
  };
  assert.equal(await resolveBoardId(agile as any, 'PROJ', 17), 17);
  assert.equal(calls, 0);
});

test('resolveBoardId auto-discovers one board and names every ambiguous candidate', async () => {
  const single = {
    board: {
      async getAllBoards() {
        return { values: [{ id: 1, name: 'PROJ', type: 'simple' }], startAt: 0, total: 1, isLast: true };
      },
    },
  };
  assert.equal(await resolveBoardId(single as any, 'PROJ'), 1);

  const ambiguous = {
    board: {
      async getAllBoards() {
        return {
          values: [
            { id: 1, name: 'PROJ Delivery', type: 'simple' },
            { id: 9, name: 'PROJ Cleanup', type: 'kanban' },
          ],
          startAt: 0,
          total: 2,
          isLast: true,
        };
      },
    },
  };
  await assert.rejects(
    resolveBoardId(ambiguous as any, 'PROJ'),
    /1: PROJ Delivery \(simple\).*9: PROJ Cleanup \(kanban\)/,
  );
});

test('resolveBoardId keeps paging when total and isLast are both absent', async () => {
  const calls: number[] = [];
  const pages = [
    { values: [{ id: 1, name: 'PROJ Delivery', type: 'simple' }] },
    { values: [{ id: 9, name: 'PROJ Cleanup', type: 'kanban' }] },
    { values: [] },
  ];
  const agile = {
    board: {
      async getAllBoards(params: { startAt?: number }) {
        calls.push(params.startAt ?? 0);
        return pages[calls.length - 1];
      },
    },
  };

  await assert.rejects(
    resolveBoardId(agile as any, 'PROJ'),
    /1: PROJ Delivery \(simple\).*9: PROJ Cleanup \(kanban\)/,
  );
  assert.deepEqual(calls, [0, 1, 2]);
});

test('fetchBacklogKeys follows Agile startAt/total pagination and preserves board split oracle keys', async () => {
  const calls: Array<{ startAt?: number; maxResults?: number }> = [];
  const pages = [
    {
      issues: [{ key: 'PROJ-676' }, { key: 'PROJ-700' }],
      startAt: 0,
      maxResults: 2,
      total: 3,
    },
    {
      issues: [{ key: 'PROJ-701' }],
      startAt: 2,
      maxResults: 2,
      total: 3,
    },
  ];
  const agile = {
    board: {
      async getIssuesForBacklog(params: { startAt?: number; maxResults?: number }) {
        calls.push(params);
        return pages[calls.length - 1];
      },
    },
  };

  const keys = await fetchBacklogKeys(agile as any, 1);
  assert.deepEqual(calls.map(call => call.startAt), [0, 2]);
  assert.ok(calls.every(call => call.maxResults === 100));
  assert.equal(keys.size, 3);
  assert.ok(keys.has('PROJ-676'), 'known backlog issue must be in the backlog set');
  assert.ok(!keys.has('PROJ-2868'), 'known on-board issue must not be in the backlog set');
});

test('fetchBacklogKeys fails loud when total says an empty page lost data', async () => {
  const agile = {
    board: {
      async getIssuesForBacklog() {
        return { issues: [], startAt: 0, maxResults: 100, total: 148 };
      },
    },
  };
  await assert.rejects(fetchBacklogKeys(agile as any, 1), /empty page.*total=148/);
});

test('fetchBacklogKeys verifies fetched and unique-key counts against the reported total', async () => {
  const agile = {
    board: {
      async getIssuesForBacklog() {
        return {
          issues: [{ key: 'PROJ-676' }, { key: 'PROJ-676' }],
          startAt: 0,
          maxResults: 100,
          total: 2,
        };
      },
    },
  };
  await assert.rejects(
    fetchBacklogKeys(agile as any, 1),
    /fetched 2 issues \/ 1 unique keys of reported total 2/,
  );
});
