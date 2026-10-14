import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { isGroqConfigured, loadConfig } from '../config/loader.js';

const ENV_KEYS = ['GROQ_API_KEY', 'GROQ_STT_MODEL', 'CLAUDE_TOOLS_CONFIG_DIR'] as const;

/**
 * Run with an empty config directory so the developer's real secrets file
 * cannot decide the outcome, and with the Groq env vars under test control.
 */
function withEnv(vars: Partial<Record<typeof ENV_KEYS[number], string>>, secrets?: unknown) {
  return () => {
    const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'groq-config-test-'));

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

test('groq is null when nothing is configured', () => {
  assert.equal(withEnv({})().groq, null);
});

test('GROQ_API_KEY alone is enough, with a default model', () => {
  const config = withEnv({ GROQ_API_KEY: 'gsk_from_env' })();

  assert.ok(config.groq);
  assert.equal(config.groq.apiKey, 'gsk_from_env');
  assert.equal(config.groq.model, 'whisper-large-v3');
});

test('GROQ_STT_MODEL overrides the default model', () => {
  const config = withEnv({ GROQ_API_KEY: 'gsk_x', GROQ_STT_MODEL: 'whisper-large-v3-turbo' })();

  assert.equal(config.groq?.model, 'whisper-large-v3-turbo');
});

test('the key can come from the secrets file', () => {
  const config = withEnv({}, { groq: { apiKey: 'gsk_from_secrets' } })();

  assert.equal(config.groq?.apiKey, 'gsk_from_secrets');
});

test('the environment wins over the secrets file', () => {
  const config = withEnv({ GROQ_API_KEY: 'gsk_env' }, { groq: { apiKey: 'gsk_secrets' } })();

  assert.equal(config.groq?.apiKey, 'gsk_env');
});

test('a model with no key does not produce a config', () => {
  // Without a key there is nothing to call, so a half-configured Groq block
  // must read as absent rather than fail later at request time.
  assert.equal(withEnv({ GROQ_STT_MODEL: 'whisper-large-v3-turbo' })().groq, null);
});

test('adding groq leaves the other sections alone', () => {
  const config = withEnv({ GROQ_API_KEY: 'gsk_x' })();

  assert.ok('telegram' in config);
  assert.ok('jira' in config);
  assert.ok('jiraMonitor' in config);
});

test('isGroqConfigured tracks the resolved config', () => {
  const saved = process.env.GROQ_API_KEY;
  const savedDir = process.env.CLAUDE_TOOLS_CONFIG_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'groq-flag-test-'));
  process.env.CLAUDE_TOOLS_CONFIG_DIR = dir;

  try {
    delete process.env.GROQ_API_KEY;
    assert.equal(isGroqConfigured(), false);

    process.env.GROQ_API_KEY = 'gsk_x';
    assert.equal(isGroqConfigured(), true);
  } finally {
    if (saved === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = saved;
    if (savedDir === undefined) delete process.env.CLAUDE_TOOLS_CONFIG_DIR;
    else process.env.CLAUDE_TOOLS_CONFIG_DIR = savedDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
