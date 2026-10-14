import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildRequestHeaders,
  buildTransformRequest,
  CodexPrivateClient,
  consumeResponseStream,
  PROMPT_CACHE_NAMESPACE,
} from '../utils/codex-private-api.js';
import { loadCodexAuthState } from '../utils/codex-auth.js';
import { v5 as uuidv5 } from 'uuid';

test('buildTransformRequest includes reasoning, priority, and prompt cache key', () => {
  const request = buildTransformRequest({
    model: 'gpt-5',
    systemPrompt: 'rewrite',
    userText: 'hello',
    sessionId: 'session-1',
    reasoningEffort: 'medium',
    fast: true,
  });

  assert.equal(request.instructions, 'rewrite');
  assert.equal((request.input as any[])[0].role, 'user');
  assert.deepEqual(request.reasoning, { effort: 'medium', summary: 'auto' });
  assert.equal(request.service_tier, 'priority');
  assert.equal(request.prompt_cache_key, uuidv5('rewrite', PROMPT_CACHE_NAMESPACE));
});

test('buildRequestHeaders sets Codex-specific headers', () => {
  const headers = buildRequestHeaders({
    accessToken: 'access',
    accountId: 'account',
    originator: 'codex_cli_rs',
    version: '0.125.0',
    sessionId: 'session-1',
  });

  assert.equal(headers.authorization, 'Bearer access');
  assert.equal(headers['chatgpt-account-id'], 'account');
  assert.equal(headers.originator, 'codex_cli_rs');
  assert.equal(headers.session_id, 'session-1');
});

test('consumeResponseStream accumulates text deltas and completion metadata', () => {
  const result = consumeResponseStream(
    [
      'data: {"type":"response.output_text.delta","delta":"hello "}',
      '',
      'data: {"type":"response.output_text.delta","delta":"world"}',
      '',
      'data: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":1}}}',
      '',
    ],
    'session-1'
  );

  assert.equal(result.text, 'hello world');
  assert.equal(result.responseId, 'resp_1');
  assert.deepEqual(result.usage, { input_tokens: 1 });
});

test('CodexPrivateClient reloads or refreshes auth after 401 and persists new tokens', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-tools-codex-auth-'));
  const codexHome = path.join(tempDir, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(
    path.join(codexHome, 'auth.json'),
    JSON.stringify(
      {
        auth_mode: 'chatgpt',
        tokens: {
          access_token: 'expired-token',
          refresh_token: 'refresh-token',
          account_id: 'account-1',
        },
      },
      null,
      2
    ),
    'utf-8'
  );

  const requestsSeen: Array<{ url: string; authHeader: string | null }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const authHeader = init?.headers && !Array.isArray(init.headers)
      ? new Headers(init.headers as any).get('authorization')
      : null;
    requestsSeen.push({ url, authHeader });

    if (url === 'https://auth.openai.com/oauth/token') {
      return new Response(
        JSON.stringify({ access_token: 'fresh-token', refresh_token: 'fresh-refresh' }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    if (authHeader === 'Bearer expired-token') {
      return new Response('unauthorized', { status: 401 });
    }

    if (authHeader === 'Bearer fresh-token') {
      return new Response(
        [
          'data: {"type":"response.output_text.delta","delta":"done"}',
          '',
          'data: {"type":"response.completed","response":{"id":"resp_1"}}',
          '',
        ].join('\n'),
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }
      );
    }

    throw new Error(`Unexpected authorization header: ${authHeader}`);
  };

  const client = new CodexPrivateClient(
    {
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      originator: 'codex_cli_rs',
      version: '0.125.0',
    },
    fetchImpl
  );

  const authState = loadCodexAuthState(codexHome);
  const result = await client.transform({
    authState,
    systemPrompt: 'rewrite',
    userText: 'hello',
    model: 'gpt-5',
    reasoningEffort: null,
    fast: false,
  });

  assert.equal(result.text, 'done');
  assert.ok(requestsSeen.some(request => request.url === 'https://auth.openai.com/oauth/token'));

  const stored = JSON.parse(fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf-8'));
  assert.equal(stored.tokens.access_token, 'fresh-token');
  assert.equal(stored.tokens.refresh_token, 'fresh-refresh');
});
