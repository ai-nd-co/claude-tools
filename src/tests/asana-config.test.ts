import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { isAsanaConfigured, loadConfig } from '../config/loader.js';

const ENV_KEYS = [
  'ASANA_ACCESS_TOKEN',
  'ASANA_TOKEN',
  'ASANA_PAT',
  'ASANA_DEFAULT_WORKSPACE',
  'ASANA_DEFAULT_PROJECT',
  'CLAUDE_TOOLS_CONFIG_DIR',
] as const;

/**
 * Run with an empty config directory so the developer's real secrets file
 * cannot decide the outcome, and with the Asana env vars under test control.
 */
function withEnv(vars: Partial<Record<(typeof ENV_KEYS)[number], string>>, secrets?: unknown) {
  return () => {
    const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asana-config-test-'));

    for (const key of ENV_KEYS) delete process.env[key];
    process.env.CLAUDE_TOOLS_CONFIG_DIR = dir;
    for (const [key, value] of Object.entries(vars)) process.env[key] = value;

    if (secrets !== undefined) {
      fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify(secrets));
    }

    try {
      return loadConfig();
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('asana is null when nothing is configured', () => {
  assert.equal(withEnv({})().asana, null);
});

test('the token alone is a complete config - Asana needs no host or email', () => {
  const config = withEnv({}, { asana: { accessToken: 'pat-from-secrets' } })();

  assert.ok(config.asana);
  assert.equal(config.asana.accessToken, 'pat-from-secrets');
  assert.equal(config.asana.defaultWorkspace, undefined);
  assert.equal(config.asana.defaultProject, undefined);
});

test('each accepted environment variable name works', () => {
  assert.equal(withEnv({ ASANA_ACCESS_TOKEN: 'a' })().asana?.accessToken, 'a');
  assert.equal(withEnv({ ASANA_TOKEN: 'b' })().asana?.accessToken, 'b');
  assert.equal(withEnv({ ASANA_PAT: 'c' })().asana?.accessToken, 'c');
});

test('the environment wins over the secrets file', () => {
  const config = withEnv({ ASANA_ACCESS_TOKEN: 'from-env' }, { asana: { accessToken: 'from-secrets' } })();
  assert.equal(config.asana?.accessToken, 'from-env');
});

test('workspace and project defaults come from the environment', () => {
  const config = withEnv({
    ASANA_ACCESS_TOKEN: 'x',
    ASANA_DEFAULT_WORKSPACE: '1218000000000033',
    ASANA_DEFAULT_PROJECT: '1218000000000035',
  })();

  // Gids stay strings here too: parsed as numbers they would be unusable.
  assert.equal(config.asana?.defaultWorkspace, '1218000000000033');
  assert.equal(config.asana?.defaultProject, '1218000000000035');
});

test('adding asana leaves the other sections alone', () => {
  const config = withEnv({ ASANA_ACCESS_TOKEN: 'x' })();

  assert.ok('telegram' in config);
  assert.ok('jira' in config);
  assert.ok('jiraMonitor' in config);
  assert.ok('groq' in config);
});

test('isAsanaConfigured tracks the resolved config', () => {
  const saved = process.env.ASANA_ACCESS_TOKEN;
  const savedDir = process.env.CLAUDE_TOOLS_CONFIG_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asana-flag-test-'));
  process.env.CLAUDE_TOOLS_CONFIG_DIR = dir;

  try {
    delete process.env.ASANA_ACCESS_TOKEN;
    assert.equal(isAsanaConfigured(), false);

    process.env.ASANA_ACCESS_TOKEN = 'x';
    assert.equal(isAsanaConfigured(), true);
  } finally {
    if (saved === undefined) delete process.env.ASANA_ACCESS_TOKEN;
    else process.env.ASANA_ACCESS_TOKEN = saved;
    if (savedDir === undefined) delete process.env.CLAUDE_TOOLS_CONFIG_DIR;
    else process.env.CLAUDE_TOOLS_CONFIG_DIR = savedDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
