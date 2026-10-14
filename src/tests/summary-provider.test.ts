import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveSummaryOptions, summarizeText } from '../utils/summary-provider.js';

test('resolveSummaryOptions preserves legacy Claude model behavior', () => {
  assert.deepEqual(resolveSummaryOptions({ model: 'sonnet' }), {
    provider: 'claude',
    model: 'sonnet',
  });

  assert.deepEqual(resolveSummaryOptions({ summaryProvider: 'claude', summaryModel: 'haiku' }), {
    provider: 'claude',
    model: 'haiku',
  });

  assert.deepEqual(resolveSummaryOptions({ summaryProvider: 'codex', summaryModel: 'gpt-5.4' }), {
    provider: 'codex',
    model: 'gpt-5.4',
  });
});

test('resolveSummaryOptions rejects legacy model alias for explicit codex provider', () => {
  assert.throws(
    () => resolveSummaryOptions({ summaryProvider: 'codex', model: 'sonnet' }),
    /Legacy --model is Claude-only/
  );
});

test('summarizeText falls back to Claude when default Codex path fails', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-tools-summary-provider-'));
  const codexHome = path.join(tempDir, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(
    path.join(codexHome, 'auth.json'),
    JSON.stringify(
      {
        auth_mode: 'chatgpt',
        tokens: {
          access_token: 'token',
          refresh_token: 'refresh',
          account_id: 'account-1',
        },
      },
      null,
      2
    ),
    'utf-8'
  );
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "gpt-5.4"\n', 'utf-8');

  const result = await summarizeText('conversation', 'prompt', {
    codexHome,
    fetchImpl: async () => new Response('backend failure', { status: 500 }),
    claudeRunner: async () => ({
      success: true,
      output: 'Claude fallback summary',
      sessionId: 'claude-session',
    }),
  });

  assert.equal(result.providerUsed, 'claude');
  assert.equal(result.fallbackFrom, 'codex');
  assert.equal(result.text, 'Claude fallback summary');
});

test('summarizeText does not fall back when Codex is explicitly required', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-tools-summary-provider-explicit-'));
  const codexHome = path.join(tempDir, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(
    path.join(codexHome, 'auth.json'),
    JSON.stringify(
      {
        auth_mode: 'chatgpt',
        tokens: {
          access_token: 'token',
          refresh_token: 'refresh',
          account_id: 'account-1',
        },
      },
      null,
      2
    ),
    'utf-8'
  );

  await assert.rejects(
    () =>
      summarizeText('conversation', 'prompt', {
        summaryProvider: 'codex',
        codexHome,
        fetchImpl: async () => new Response('backend failure', { status: 500 }),
        claudeRunner: async () => ({
          success: true,
          output: 'should not be used',
          sessionId: 'claude-session',
        }),
      }),
    /Codex backend request failed/
  );
});

test('summarizeText chunks oversized Codex input instead of failing on context window limits', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-tools-summary-provider-chunking-'));
  const codexHome = path.join(tempDir, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(
    path.join(codexHome, 'auth.json'),
    JSON.stringify(
      {
        auth_mode: 'chatgpt',
        tokens: {
          access_token: 'token',
          refresh_token: 'refresh',
          account_id: 'account-1',
        },
      },
      null,
      2
    ),
    'utf-8'
  );
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "gpt-5.4"\n', 'utf-8');

  const seenBodies: string[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    seenBodies.push(bodyText);
    return new Response(
      [
        'data: {"type":"response.output_text.delta","delta":"chunk summary"}',
        '',
        'data: {"type":"response.completed","response":{"id":"resp_1"}}',
        '',
      ].join('\n'),
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    );
  };

  const largeInput = 'A'.repeat(60_000);
  const result = await summarizeText(largeInput, 'final prompt', {
    summaryProvider: 'codex',
    codexHome,
    fetchImpl,
  });

  assert.equal(result.providerUsed, 'codex');
  assert.equal(result.text, 'chunk summary');
  assert.ok(seenBodies.length >= 2, `expected multiple codex calls, got ${seenBodies.length}`);
});
