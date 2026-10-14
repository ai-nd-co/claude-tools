import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadCodexDefaults } from '../utils/codex-config.js';

test('loadCodexDefaults reads top-level config and version files', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-tools-codex-config-'));
  const codexHome = path.join(tempDir, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });

  fs.writeFileSync(
    path.join(codexHome, 'config.toml'),
    [
      'model = "gpt-5.4"',
      'model_reasoning_effort = "xhigh"',
      '',
      '[projects."/tmp/example"]',
      'trust_level = "trusted"',
      '',
    ].join('\n'),
    'utf-8'
  );
  fs.writeFileSync(
    path.join(codexHome, 'version.json'),
    JSON.stringify({ latest_version: '0.125.0' }),
    'utf-8'
  );

  const defaults = loadCodexDefaults(codexHome);
  assert.equal(defaults.codexHome, codexHome);
  assert.equal(defaults.model, 'gpt-5.4');
  assert.equal(defaults.reasoningEffort, 'xhigh');
  assert.equal(defaults.version, '0.125.0');
});
