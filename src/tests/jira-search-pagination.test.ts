import test from 'node:test';
import assert from 'node:assert/strict';
import { searchJqlPaginated } from '../commands/jira/index.js';

function issue(key: string) {
  return {
    key,
    fields: {
      summary: `Summary ${key}`,
      status: { name: 'Planned' },
      issuetype: { name: 'Task' },
      assignee: { displayName: 'Alice' },
      priority: { name: 'Medium' },
      created: '2026-01-01T00:00:00.000Z',
      updated: '2026-08-01T00:00:00.000Z',
    },
  };
}

function fakeClient(pages: Array<{ issues: any[]; nextPageToken?: string }>) {
  const calls: Array<{ nextPageToken?: string; maxResults?: number }> = [];
  return {
    calls,
    client: {
      issueSearch: {
        async searchForIssuesUsingJqlEnhancedSearch(params: { nextPageToken?: string; maxResults?: number }) {
          calls.push(params);
          return pages[calls.length - 1];
        },
      },
    },
  };
}

test('jira search consumes every enhanced-search page when no limit is set', async () => {
  const pages = [
    { issues: Array.from({ length: 100 }, (_, i) => issue(`PROJ-${i + 1}`)), nextPageToken: 'page-2' },
    { issues: Array.from({ length: 67 }, (_, i) => issue(`PROJ-${i + 101}`)) },
  ];
  const { client, calls } = fakeClient(pages);
  const result = await searchJqlPaginated(client as any, 'project="PROJ" AND status="Planned"');

  assert.equal(result.issues.length, 167);
  assert.equal(result.matched, 167);
  assert.equal(result.truncated, false);
  assert.deepEqual(calls.map(call => call.nextPageToken), [undefined, 'page-2']);
  assert.ok(calls.every(call => call.maxResults === 100));
});

test('jira search with an explicit limit still counts all matches and marks truncation', async () => {
  const pages = [
    { issues: Array.from({ length: 100 }, (_, i) => issue(`PROJ-${i + 1}`)), nextPageToken: 'page-2' },
    { issues: Array.from({ length: 67 }, (_, i) => issue(`PROJ-${i + 101}`)) },
  ];
  const { client, calls } = fakeClient(pages);
  const result = await searchJqlPaginated(client as any, 'project="PROJ" AND status="Planned"', 20);

  assert.equal(calls.length, 2, 'all pages are fetched so the warning can state the exact matched total');
  assert.equal(result.issues.length, 20);
  assert.equal(result.matched, 167);
  assert.equal(result.truncated, true);
});

test('jira search continues across an empty intermediate page with a token', async () => {
  const { client, calls } = fakeClient([
    { issues: [], nextPageToken: 'page-2' },
    { issues: [issue('PROJ-2868')] },
  ]);
  const result = await searchJqlPaginated(client as any, 'project="PROJ"');
  assert.equal(calls.length, 2);
  assert.deepEqual(result.issues.map(item => item.key), ['PROJ-2868']);
});
