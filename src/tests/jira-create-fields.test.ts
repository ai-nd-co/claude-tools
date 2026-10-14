import test from 'node:test';
import assert from 'node:assert/strict';

import { applyCreateFields, type CreateFieldOps } from '../services/jira-create-fields.js';

const notFound = () => Object.assign(new Error('Request failed with status code 404'), { response: { status: 404 } });

/**
 * A fake Jira with the 2026-09-30 faults switchable PER OPERATION and per read phase, and transitions whose
 * destination can differ from their name.
 */
function fakeJira(options: {
  getFails?: number[];        // 1-based getIssue call numbers that 404
  statusFails404?: number;    // updateStatus calls that 404 first
  assignFails404?: number;    // assignIssue calls that 404 first
  resetsAssignee?: number;    // assignments an on-create rule undoes
  transitions?: Array<{ name: string; to: string }>;
  noAccountId?: boolean;
} = {}) {
  let status = 'Icebox';
  let assignee: { accountId: string; displayName: string } | undefined;
  let gets = 0;
  let statusFails = options.statusFails404 ?? 0;
  let assignFails = options.assignFails404 ?? 0;
  let resets = options.resetsAssignee ?? 0;
  const transitions = options.transitions ?? [{ name: 'Planned', to: 'Planned' }, { name: 'Done', to: 'Done' }];
  const calls: string[] = [];
  const ops: CreateFieldOps = {
    async getIssue() {
      gets += 1;
      calls.push(`get#${gets}`);
      if (options.getFails?.includes(gets)) throw notFound();
      return { status, ...(assignee ? { assignee: assignee.displayName, assigneeAccountId: assignee.accountId } : {}) };
    },
    async updateStatus(_key, wanted) {
      calls.push(`status:${wanted}`);
      if (statusFails > 0) { statusFails -= 1; throw notFound(); }
      const t = transitions.find((x) => x.to.toLowerCase() === wanted.toLowerCase())
        ?? transitions.find((x) => x.name.toLowerCase() === wanted.toLowerCase());
      if (!t) throw new Error(`Transition "${wanted}" not found. Available: ${transitions.map((x) => x.name).join(', ')}`);
      status = t.to;
      return t.to;
    },
    async assignIssue(_key, name) {
      calls.push(`assign:${name}`);
      if (assignFails > 0) { assignFails -= 1; throw notFound(); }
      if (options.noAccountId) throw new Error(`User "${name}" was found without an account id; it cannot be assigned`);
      const user = { accountId: 'acc-dana', displayName: name };
      if (resets > 0) { resets -= 1; assignee = undefined; } else { assignee = user; }
      return user;
    },
  };
  return { ops, calls };
}

const fast = { sleep: async () => {}, settleMs: 0 };
const count = (calls: string[], prefix: string) => calls.filter((c) => c.startsWith(prefix)).length;

test('both fields applied and verified by reading the issue back', async () => {
  const jira = fakeJira();
  const result = await applyCreateFields(jira.ops, 'PROJ-1', { status: 'Planned', assignee: 'Dana Rivera' }, fast);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.applied.sort(), ['assignee', 'status']);
});

test('the transition itself 404s at first: it is retried, not reported as failed', async () => {
  const jira = fakeJira({ statusFails404: 2 });
  const result = await applyCreateFields(jira.ops, 'PROJ-1', { status: 'Planned' }, fast);
  assert.deepEqual(result.failed, [], JSON.stringify(result));
  assert.equal(count(jira.calls, 'status:'), 3);
});

test('the assignment 404s at first: it is retried', async () => {
  const jira = fakeJira({ assignFails404: 1 });
  const result = await applyCreateFields(jira.ops, 'PROJ-1', { assignee: 'Dana Rivera' }, fast);
  assert.deepEqual(result.failed, [], JSON.stringify(result));
  assert.equal(count(jira.calls, 'assign:'), 2);
});

test('a transition named differently from its destination is verified against the destination', async () => {
  const jira = fakeJira({ transitions: [{ name: 'Start Progress', to: 'In Progress' }] });
  const byName = await applyCreateFields(jira.ops, 'PROJ-1', { status: 'Start Progress' }, fast);
  assert.deepEqual(byName.failed, [], JSON.stringify(byName));
  const jira2 = fakeJira({ transitions: [{ name: 'Start Progress', to: 'In Progress' }] });
  const byDestination = await applyCreateFields(jira2.ops, 'PROJ-1', { status: 'In Progress' }, fast);
  assert.deepEqual(byDestination.failed, [], JSON.stringify(byDestination));
});

test('an assignment undone right after create is re-applied once, and verified', async () => {
  const jira = fakeJira({ resetsAssignee: 1 });
  const result = await applyCreateFields(jira.ops, 'PROJ-1', { assignee: 'Dana Rivera' }, fast);
  assert.deepEqual(result.failed, [], JSON.stringify(result));
  assert.equal(count(jira.calls, 'assign:'), 2);
});

test('an assignment that never sticks is reported by field, not silently dropped', async () => {
  const jira = fakeJira({ resetsAssignee: 99 });
  const result = await applyCreateFields(jira.ops, 'PROJ-1', { status: 'Planned', assignee: 'Dana Rivera' }, fast);
  assert.deepEqual(result.applied, ['status']);
  assert.equal(result.failed[0]?.field, 'assignee');
  assert.match(result.failed[0]!.reason, /assigned to nobody/);
});

test('a user without an account id is a failed assignee, never a false success', async () => {
  const jira = fakeJira({ noAccountId: true });
  const result = await applyCreateFields(jira.ops, 'PROJ-1', { assignee: 'Ghost' }, fast);
  assert.equal(result.failed[0]?.field, 'assignee');
  assert.match(result.failed[0]!.reason, /without an account id/);
});

test('a read-back that keeps failing reports both fields as unverified instead of throwing', async () => {
  // Call 1 is the readiness check; every later read (the verification) fails.
  const jira = fakeJira({ getFails: [2, 3, 4, 5, 6, 7, 8, 9] });
  const result = await applyCreateFields(jira.ops, 'PROJ-1', { status: 'Planned', assignee: 'X' }, { ...fast, attempts: 3 });
  assert.deepEqual(result.failed.map((f) => f.field).sort(), ['assignee', 'status']);
  assert.match(result.failed[0]!.reason, /could not be verified/);
});

test('an unknown status fails at once, listing the transitions, without retrying', async () => {
  const jira = fakeJira();
  const result = await applyCreateFields(jira.ops, 'PROJ-1', { status: 'Nonsense' }, fast);
  assert.equal(result.failed[0]?.field, 'status');
  assert.match(result.failed[0]!.reason, /Available: Planned/);
  assert.equal(count(jira.calls, 'status:'), 1);
});

test('a message that merely contains "404" is an answer, not a reason to retry', async () => {
  const jira = fakeJira({ transitions: [{ name: 'Planned', to: 'Planned' }] });
  const result = await applyCreateFields(jira.ops, 'PROJ-1', { status: '404' }, fast);
  assert.equal(result.failed[0]?.field, 'status');
  assert.equal(count(jira.calls, 'status:'), 1);
});

test('an issue that never becomes readable fails both fields by name', async () => {
  const jira = fakeJira({ getFails: Array.from({ length: 50 }, (_, i) => i + 1) });
  const result = await applyCreateFields(jira.ops, 'PROJ-1', { status: 'Planned', assignee: 'X' }, { ...fast, attempts: 3 });
  assert.deepEqual(result.failed.map((f) => f.field).sort(), ['assignee', 'status']);
  assert.equal(count(jira.calls, 'get#'), 3, 'bounded by attempts');
});

test('nothing requested, nothing called', async () => {
  const jira = fakeJira();
  const result = await applyCreateFields(jira.ops, 'PROJ-1', {}, fast);
  assert.deepEqual(result, { applied: [], failed: [] });
  assert.deepEqual(jira.calls, []);
});
