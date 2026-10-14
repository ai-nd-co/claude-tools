import test from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  classify,
  createEmptyState,
  loadState,
  saveState,
  stateAfterDeliveries,
  type AlertRef,
  type JiraMonitorState,
  type MonitorSnapshot,
} from '../services/jira-monitor-state.js';
import {
  buildRoutedMessages,
  deliverNotifications,
  type RoutedAlertMessage,
  type TelegramNotificationSender,
} from '../commands/jira/monitor.js';
import { resolveJiraMonitorNotify } from '../config/loader.js';

const TIERS = [7, 14, 30, 60, 90];

function stuck(key: string, days: number, assignee: string | null = 'Alice') {
  return {
    key,
    summary: `Summary ${key}`,
    assignee,
    stuckDays: days,
    lastActivityAt: '2026-07-01T00:00:00.000Z',
    lastActivitySource: 'updated_field' as const,
    commentCount: 0,
  };
}

function inactive(name: string, days: number) {
  return {
    name,
    daysSinceActivity: days,
    ticketCount: 2,
    mostRecentTicket: 'PROJ-1',
    mostRecentUpdated: '2026-07-01T00:00:00.000Z',
  };
}

function lowPipeline(name: string, total: number) {
  return {
    name,
    plannedCount: total,
    iceboxCount: 0,
    totalPipeline: total,
  };
}

function allRefs(snapshot: MonitorSnapshot): AlertRef[] {
  return [
    ...(snapshot.stuck || []).map(item => ({ alertClass: 'stuck' as const, key: item.key })),
    ...(snapshot.inactive || []).map(item => ({ alertClass: 'inactive' as const, key: item.name })),
    ...(snapshot.lowPipeline || []).map(item => ({ alertClass: 'lowPipeline' as const, key: item.name })),
  ];
}

function confirmedState(snapshot: MonitorSnapshot): JiraMonitorState {
  const classified = classify(createEmptyState(), snapshot, TIERS);
  return stateAfterDeliveries(
    createEmptyState(),
    classified,
    allRefs(snapshot),
    '2026-08-01T00:00:00.000Z',
  );
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-monitor-state-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function withTempDirAsync<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-monitor-state-'));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('first run classifies every current item as new', () => {
  const current = {
    stuck: [stuck('PROJ-1', 8)],
    inactive: [inactive('Alice', 12)],
    lowPipeline: [lowPipeline('Bob', 1)],
  };
  const result = classify(createEmptyState(), current, TIERS);
  assert.deepEqual(result.stuck?.map(item => item.classification), ['new']);
  assert.deepEqual(result.inactive?.map(item => item.classification), ['new']);
  assert.deepEqual(result.lowPipeline?.map(item => item.classification), ['new']);
});

test('identical second run suppresses everything and builds zero outbound messages', () => {
  const current = {
    stuck: [stuck('PROJ-1', 8)],
    inactive: [inactive('Alice', 12)],
    lowPipeline: [lowPipeline('Bob', 1)],
  };
  const second = classify(confirmedState(current), current, TIERS);
  assert.deepEqual(second.stuck?.map(item => item.classification), ['unchanged']);
  assert.deepEqual(second.inactive?.map(item => item.classification), ['unchanged']);
  assert.deepEqual(second.lowPipeline?.map(item => item.classification), ['unchanged']);

  const routed = buildRoutedMessages(
    second,
    resolveJiraMonitorNotify(),
    { Alice: '@alice', Bob: '@bob' },
    'group',
    'pm',
    false,
    7,
    2,
    'https://example.test/browse',
  );
  assert.equal(routed.messages.length, 0, 'unchanged second run must have zero outbound messages');
});

test('crossing a configured day tier escalates exactly once', () => {
  const previousSnapshot = { stuck: [stuck('PROJ-1', 8)] };
  const previous = confirmedState(previousSnapshot);
  const crossed = classify(previous, { stuck: [stuck('PROJ-1', 14)] }, TIERS);
  assert.equal(crossed.stuck?.[0].classification, 'escalated');

  const updated = stateAfterDeliveries(
    previous,
    crossed,
    [{ alertClass: 'stuck', key: 'PROJ-1' }],
    '2026-08-02T00:00:00.000Z',
  );
  const sameTier = classify(updated, { stuck: [stuck('PROJ-1', 20)] }, TIERS);
  assert.equal(sameTier.stuck?.[0].classification, 'unchanged');
});

test('lowPipeline shrinking escalates while an unchanged total is suppressed', () => {
  const previous = confirmedState({ lowPipeline: [lowPipeline('Alice', 2)] });
  assert.equal(
    classify(previous, { lowPipeline: [lowPipeline('Alice', 1)] }, TIERS).lowPipeline?.[0].classification,
    'escalated',
  );
  assert.equal(
    classify(previous, { lowPipeline: [lowPipeline('Alice', 2)] }, TIERS).lowPipeline?.[0].classification,
    'unchanged',
  );
});

test('disappearing items are resolved and pruned from the next state', () => {
  const previous = confirmedState({
    stuck: [stuck('PROJ-1', 8)],
    inactive: [inactive('Alice', 12)],
  });
  const result = classify(previous, { stuck: [], inactive: [] }, TIERS);
  assert.deepEqual(result.resolved.stuck, ['PROJ-1']);
  assert.deepEqual(result.resolved.inactive, ['Alice']);
  const next = stateAfterDeliveries(previous, result, [], '2026-08-02T00:00:00.000Z');
  assert.deepEqual(next.stuck, {});
  assert.deepEqual(next.inactive, {});
  assert.equal(
    classify(next, { stuck: [stuck('PROJ-1', 8)] }, TIERS).stuck?.[0].classification,
    'new',
    'a later recurrence must not be suppressed by stale pre-resolution state',
  );
});

test('missing and corrupt state files both degrade to empty/all-new', () => withTempDir((dir) => {
  const missing = path.join(dir, 'missing.json');
  assert.deepEqual(loadState(missing), createEmptyState());

  const corrupt = path.join(dir, 'corrupt.json');
  fs.writeFileSync(corrupt, '{ definitely not json', 'utf-8');
  const loaded = loadState(corrupt);
  assert.deepEqual(loaded, createEmptyState());
  assert.equal(
    classify(loaded, { stuck: [stuck('PROJ-1', 8)] }, TIERS).stuck?.[0].classification,
    'new',
  );
}));

test('dry-run load and classification leave state contents and mtime unchanged', () => withTempDir((dir) => {
  const file = path.join(dir, 'state.json');
  saveState(file, confirmedState({ stuck: [stuck('PROJ-1', 8)] }));
  const beforeHash = sha256(file);
  const beforeMtime = fs.statSync(file).mtimeMs;

  const previous = loadState(file);
  classify(previous, { stuck: [stuck('PROJ-1', 14)] }, TIERS);

  assert.equal(sha256(file), beforeHash);
  assert.equal(fs.statSync(file).mtimeMs, beforeMtime);
}));

class FakeSender implements TelegramNotificationSender {
  calls: RoutedAlertMessage[] = [];
  connected = false;
  disconnected = false;

  constructor(
    private readonly messages: RoutedAlertMessage[],
    private readonly failAt: Set<number>,
  ) {}

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.disconnected = true;
  }

  /** Mute flag observed per send, in call order. */
  muteFlags: Array<boolean | undefined> = [];

  async sendMessage(
    chat: string,
    text: string,
    _replyToMsgId?: number,
    _parseMode?: string,
    mute?: boolean,
  ): Promise<{ messageId: number; chatId: string }> {
    const index = this.calls.length;
    const message = this.messages[index];
    assert.equal(chat, message.chat);
    assert.equal(text, message.text);
    this.calls.push(message);
    this.muteFlags.push(mute);
    if (this.failAt.has(index)) throw new Error(`synthetic send failure ${index}`);
    return { messageId: index + 1, chatId: chat };
  }
}

function singleItemMessages(count: number, destination: 'group' | 'dm' = 'group'): RoutedAlertMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    text: `message ${index + 1}`,
    chat: destination === 'dm' ? `@user${index + 1}` : 'group',
    destination,
    refs: [{ alertClass: 'stuck', key: `PROJ-${index + 1}` }],
  }));
}

test('mid-sequence non-DM failure records only confirmed earlier sends, never items 3-7', async () => {
  await withTempDirAsync(async (dir) => {
    const current = { stuck: Array.from({ length: 7 }, (_, index) => stuck(`PROJ-${index + 1}`, 8)) };
    const previous = createEmptyState();
    const classified = classify(previous, current, TIERS);
    const messages = singleItemMessages(7);
    const sender = new FakeSender(messages, new Set([2]));
    const statePath = path.join(dir, 'state.json');

    await assert.rejects(
      deliverNotifications(sender, messages, {
        state: { path: statePath, previous, classified },
        delayMs: 0,
        now: () => '2026-08-03T00:00:00.000Z',
      }),
      /synthetic send failure 2/,
    );

    const saved = loadState(statePath);
    assert.deepEqual(Object.keys(saved.stuck).sort(), ['PROJ-1', 'PROJ-2']);
    for (let index = 3; index <= 7; index++) {
      assert.equal(saved.stuck[`PROJ-${index}`], undefined, `PROJ-${index} was not delivered`);
    }
    assert.equal(sender.calls.length, 3, 'messages after the failed group send were not attempted');
    assert.equal(sender.disconnected, true);
  });
});

test('a failed DM is reported, not recorded, and does not abort later notifications', async () => {
  await withTempDirAsync(async (dir) => {
    const current = { stuck: [stuck('PROJ-1', 8), stuck('PROJ-2', 8)] };
    const previous = createEmptyState();
    const classified = classify(previous, current, TIERS);
    const messages = [
      ...singleItemMessages(1, 'dm'),
      { ...singleItemMessages(2, 'group')[1], text: 'message 2' },
    ];
    const sender = new FakeSender(messages, new Set([0]));
    const statePath = path.join(dir, 'state.json');
    const result = await deliverNotifications(sender, messages, {
      state: { path: statePath, previous, classified },
      delayMs: 0,
      now: () => '2026-08-03T00:00:00.000Z',
    });

    assert.equal(result.failedDms.length, 1);
    assert.equal(sender.calls.length, 2, 'later group notification still sent');
    const saved = loadState(statePath);
    assert.equal(saved.stuck['PROJ-1'], undefined, 'failed DM remains eligible for retry');
    assert.ok(saved.stuck['PROJ-2'], 'later confirmed group send is recorded');
  });
});

test('incremental saves preserve the first successful delivery timestamp per item', async () => {
  await withTempDirAsync(async (dir) => {
    const current = { stuck: [stuck('PROJ-1', 8), stuck('PROJ-2', 8)] };
    const previous = createEmptyState();
    const classified = classify(previous, current, TIERS);
    const messages = singleItemMessages(2);
    const sender = new FakeSender(messages, new Set());
    const times = ['2026-08-03T00:00:01.000Z', '2026-08-03T00:00:02.000Z'];
    const statePath = path.join(dir, 'state.json');
    await deliverNotifications(sender, messages, {
      state: { path: statePath, previous, classified },
      delayMs: 0,
      now: () => times.shift()!,
    });

    const saved = loadState(statePath);
    assert.equal(saved.stuck['PROJ-1'].firstSeenAt, '2026-08-03T00:00:01.000Z');
    assert.equal(saved.stuck['PROJ-1'].lastNotifiedAt, '2026-08-03T00:00:01.000Z');
    assert.equal(saved.stuck['PROJ-2'].firstSeenAt, '2026-08-03T00:00:02.000Z');
  });
});

test('routing defaults keep DMs off and unmapped DMs are explicitly skipped', () => {
  const current = {
    stuck: [stuck('PROJ-1', 8, 'Alice')],
    inactive: [inactive('Bob', 12)],
    lowPipeline: [lowPipeline('Carol', 1)],
  };
  const classified = classify(createEmptyState(), current, TIERS);
  const defaults = buildRoutedMessages(
    classified,
    resolveJiraMonitorNotify(),
    {},
    'group',
    'pm',
    false,
    7,
    2,
    'https://example.test/browse',
  );
  assert.deepEqual(defaults.messages.map(message => message.destination), ['group', 'group', 'pm']);
  assert.equal(defaults.skippedDms.length, 0, 'DM is off by default');

  const dmOnly = buildRoutedMessages(
    classified,
    { stuck: ['dm'], inactive: ['off'], lowPipeline: [] },
    {},
    'group',
    'pm',
    false,
    7,
    2,
    'https://example.test/browse',
  );
  assert.equal(dmOnly.messages.length, 0);
  assert.deepEqual(dmOnly.skippedDms, [{ alertClass: 'stuck', key: 'PROJ-1', person: 'Alice' }]);
  assert.deepEqual(dmOnly.pendingRefs, [{ alertClass: 'stuck', key: 'PROJ-1' }]);
});

test('a skipped configured DM prevents a successful group copy from suppressing the item', async () => {
  await withTempDirAsync(async (dir) => {
    const current = { stuck: [stuck('PROJ-1', 8, 'Alice')] };
    const previous = createEmptyState();
    const classified = classify(previous, current, TIERS);
    const routed = buildRoutedMessages(
      classified,
      { stuck: ['group', 'dm'], inactive: ['off'], lowPipeline: ['off'] },
      {},
      'group',
      'pm',
      false,
      7,
      2,
      'https://example.test/browse',
    );
    const sender = new FakeSender(routed.messages, new Set());
    const statePath = path.join(dir, 'state.json');
    await deliverNotifications(sender, routed.messages, {
      state: { path: statePath, previous, classified },
      pendingRefs: routed.pendingRefs,
      delayMs: 0,
    });

    assert.equal(fs.existsSync(statePath), false, 'incomplete configured route must not mark delivery');
    assert.equal(classify(previous, current, TIERS).stuck?.[0].classification, 'new');
  });
});

test('unassigned stuck items configured for DM fall back to the group', () => {
  const classified = classify(createEmptyState(), { stuck: [stuck('PROJ-1', 8, null)] }, TIERS);
  const routed = buildRoutedMessages(
    classified,
    { stuck: ['dm'], inactive: ['off'], lowPipeline: ['off'] },
    {},
    'group',
    'pm',
    false,
    7,
    2,
    'https://example.test/browse',
  );
  assert.equal(routed.messages.length, 1);
  assert.equal(routed.messages[0].destination, 'group');
  assert.equal(routed.messages[0].chat, 'group');
  assert.equal(routed.skippedDms.length, 0);
});

// ── Regression: `--mute` (49c0b13) must survive the routing rewrite ──────────
// The flag originally lived in an inline send loop that deliverNotifications
// replaced. It was silently lost in that rewrite and restored during the merge;
// these tests exist so it cannot be dropped again.

test('mute propagates to every route — group, pm and dm alike', async () => {
  await withTempDirAsync(async (dir) => {
    const messages: RoutedAlertMessage[] = [
      { text: 'group msg', chat: 'group', destination: 'group', refs: [{ alertClass: 'stuck', key: 'PROJ-1' }] },
      { text: 'pm msg', chat: 'pm', destination: 'pm', refs: [{ alertClass: 'lowPipeline', key: 'Someone' }] },
      { text: 'dm msg', chat: '@user1', destination: 'dm', refs: [{ alertClass: 'stuck', key: 'PROJ-2' }] },
    ];
    const sender = new FakeSender(messages, new Set());
    await deliverNotifications(sender, messages, {
      mute: true,
      delayMs: 0,
      now: () => '2026-08-05T00:00:00.000Z',
    });
    assert.equal(sender.calls.length, 3);
    assert.deepEqual(sender.muteFlags, [true, true, true], 'every route must be muted');
  });
});

test('mute defaults to false when the flag is absent', async () => {
  await withTempDirAsync(async (dir) => {
    const messages = singleItemMessages(2);
    const sender = new FakeSender(messages, new Set());
    await deliverNotifications(sender, messages, {
      delayMs: 0,
      now: () => '2026-08-05T00:00:00.000Z',
    });
    assert.deepEqual(sender.muteFlags, [false, false], 'unmuted sends must stay audible');
  });
});
