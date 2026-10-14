// Regression tests for `loadConfig` around the `jiraMonitor` block.
//
// The previous behaviour was: `jiraMonitor` was silently dropped unless
// `userMapping` was present. That broke the documented status-only override
// path — a user renaming a workflow status would set `jiraMonitor.statuses`
// alone and never realise the block was being ignored, and the monitor would
// silently fall back to defaults (i.e. return zero results and "look green").
//
// The current contract:
//   - Any `jiraMonitor` block in project config yields a non-null loaded value.
//   - Missing `userMapping` is normalised to `{}` so downstream code can
//     assume the field is present.
//   - The absence of `jiraMonitor` still yields `null` (unchanged).

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  loadConfig,
  resolveEscalationTiers,
  resolveJiraMonitorNotify,
  resolveJiraMonitorStaleness,
  resolvePipelineStatuses,
} from '../config/loader.js';

/**
 * Run `loadConfig` in an isolated working directory containing a synthetic
 * `.claude-tools.json`, with JIRA env vars set so the outer `jira` object
 * loads (loader requires host+email+token to build a JIRA client, and we
 * don't want to depend on the real user config here).
 */
function withProjectConfig<T>(configJson: unknown, fn: () => T): T {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-tools-loader-'));
  const originalCwd = process.cwd();
  const envBackup = { ...process.env };
  fs.writeFileSync(path.join(tmp, '.claude-tools.json'), JSON.stringify(configJson), 'utf-8');
  process.chdir(tmp);
  // Fill JIRA env vars so loader returns a non-null jira block (not needed by
  // these assertions, but avoids surprising interactions with the real user's
  // secrets file if it exists).
  process.env.JIRA_HOST = 'test-host.atlassian.net';
  process.env.JIRA_EMAIL = 'test@example.com';
  process.env.JIRA_API_TOKEN = 'test-token';
  try {
    return fn();
  } finally {
    process.chdir(originalCwd);
    // Restore env fully so other tests aren't perturbed.
    for (const k of Object.keys(process.env)) {
      if (!(k in envBackup)) delete process.env[k];
    }
    for (const [k, v] of Object.entries(envBackup)) {
      process.env[k] = v;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('loadConfig accepts a status-only jiraMonitor block (no userMapping)', () => {
  const cfg = withProjectConfig(
    {
      jira: { host: 'test-host.atlassian.net', defaultProject: 'PROJ' },
      jiraMonitor: {
        statuses: { inProgress: 'Doing', done: 'Closed' },
        browseBaseUrl: 'https://custom.example.com/browse',
      },
    },
    () => loadConfig(),
  );

  assert.ok(cfg.jiraMonitor, 'jiraMonitor block should NOT be discarded when userMapping is absent');
  assert.deepEqual(cfg.jiraMonitor!.userMapping, {}, 'missing userMapping should normalise to {}');
  assert.equal(cfg.jiraMonitor!.statuses?.inProgress, 'Doing');
  assert.equal(cfg.jiraMonitor!.statuses?.done, 'Closed');
  assert.equal(cfg.jiraMonitor!.browseBaseUrl, 'https://custom.example.com/browse');
  assert.deepEqual(cfg.jiraMonitor!.notify, {
    stuck: ['group'],
    inactive: ['group'],
    lowPipeline: ['pm'],
  });
  assert.deepEqual(cfg.jiraMonitor!.escalationTiers, [7, 14, 30, 60, 90]);
  assert.equal(cfg.jiraMonitor!.boardId, undefined);
  assert.deepEqual(cfg.jiraMonitor!.pipelineStatuses, ['Planned']);
  assert.equal(cfg.jiraMonitor!.excludeBacklog, true);
  assert.deepEqual(cfg.jiraMonitor!.staleness, {
    inProgress: { ageing: 7, stale: 14 },
    planned: { ageing: 30, stale: 90 },
  });
});

test('loadConfig preserves an explicit userMapping unchanged', () => {
  const cfg = withProjectConfig(
    {
      jira: { host: 'test-host.atlassian.net', defaultProject: 'PROJ' },
      jiraMonitor: {
        userMapping: { Alice: '@alice_tg' },
        activeUsers: ['Alice'],
      },
    },
    () => loadConfig(),
  );

  assert.ok(cfg.jiraMonitor);
  assert.deepEqual(cfg.jiraMonitor!.userMapping, { Alice: '@alice_tg' });
  assert.deepEqual(cfg.jiraMonitor!.activeUsers, ['Alice']);
});

test('loadConfig returns jiraMonitor: null when the block is absent entirely', () => {
  const cfg = withProjectConfig(
    { jira: { host: 'test-host.atlassian.net', defaultProject: 'PROJ' } },
    () => loadConfig(),
  );

  assert.equal(cfg.jiraMonitor, null, 'no jiraMonitor block -> null (unchanged from before)');
});

test('routing and escalation overrides resolve per class with safe validation', () => {
  assert.deepEqual(resolveJiraMonitorNotify({ stuck: ['dm'], inactive: [], lowPipeline: ['off'] }), {
    stuck: ['dm'],
    inactive: [],
    lowPipeline: ['off'],
  });
  assert.deepEqual(resolveEscalationTiers([3, 10, 20]), [3, 10, 20]);
  assert.throws(
    () => resolveJiraMonitorNotify({ stuck: ['off', 'group'] }),
    /off cannot be combined/,
  );
  assert.throws(
    () => resolveJiraMonitorNotify('group' as any),
    /must be an object/,
  );
  assert.throws(() => resolveEscalationTiers([7, 7]), /strictly increasing/);
});

test('pipeline and staleness defaults and overrides resolve with boundary validation', () => {
  assert.deepEqual(resolvePipelineStatuses(), ['Planned']);
  assert.deepEqual(resolvePipelineStatuses(['Planned', 'Icebox', 'Planned']), ['Planned', 'Icebox']);
  assert.deepEqual(resolveJiraMonitorStaleness({ planned: { ageing: 45 } }), {
    inProgress: { ageing: 7, stale: 14 },
    planned: { ageing: 45, stale: 90 },
  });
  assert.throws(() => resolvePipelineStatuses([]), /non-empty array/);
  assert.throws(
    () => resolveJiraMonitorStaleness({ inProgress: { ageing: 14, stale: 14 } }),
    /ageing must be less than stale/,
  );
});

test('loadConfig preserves explicit board-aware monitor settings', () => {
  const cfg = withProjectConfig(
    {
      jira: { host: 'test-host.atlassian.net', defaultProject: 'PROJ' },
      jiraMonitor: {
        boardId: 1,
        pipelineStatuses: ['Planned', 'Icebox'],
        excludeBacklog: false,
        staleness: {
          inProgress: { ageing: 5, stale: 10 },
          planned: { ageing: 20, stale: 60 },
        },
      },
    },
    () => loadConfig(),
  );
  assert.equal(cfg.jiraMonitor?.boardId, 1);
  assert.deepEqual(cfg.jiraMonitor?.pipelineStatuses, ['Planned', 'Icebox']);
  assert.equal(cfg.jiraMonitor?.excludeBacklog, false);
  assert.deepEqual(cfg.jiraMonitor?.staleness, {
    inProgress: { ageing: 5, stale: 10 },
    planned: { ageing: 20, stale: 60 },
  });
});
