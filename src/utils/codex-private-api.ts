import { randomUUID } from 'crypto';
import { v5 as uuidv5 } from 'uuid';
import {
  CodexAuthError,
  CodexAuthState,
  CodexPermanentRefreshError,
  FetchLike,
  refreshCodexTokens,
  reloadCodexAuthState,
} from './codex-auth.js';
import { buildCodexUserAgent } from './codex-config.js';

export type ReasoningEffort = string;
export const PROMPT_CACHE_NAMESPACE = '75f0f17d-8430-5a44-a76d-678d5aee9c5c';

export class CodexTransportError extends Error {}
export class CodexUnauthorizedError extends CodexTransportError {}

export interface TransformResult {
  text: string;
  responseId: string | null;
  usage: Record<string, unknown> | null;
  sessionId: string;
}

export interface ClientSettings {
  baseUrl: string;
  originator: string;
  version: string;
  timeoutMs?: number;
}

interface TransformRequestOptions {
  authState: CodexAuthState;
  systemPrompt: string;
  userText: string;
  model: string;
  reasoningEffort: ReasoningEffort | null;
  fast: boolean;
}

export class CodexPrivateClient {
  private readonly settings: Required<ClientSettings>;
  private readonly fetchImpl: FetchLike;

  constructor(settings: ClientSettings, fetchImpl?: FetchLike) {
    this.settings = {
      ...settings,
      timeoutMs: settings.timeoutMs ?? 120_000,
    };
    this.fetchImpl = fetchImpl || fetch;
  }

  async transform(options: TransformRequestOptions): Promise<TransformResult> {
    const sessionId = randomUUID();
    const requestBody = buildTransformRequest({
      model: options.model,
      systemPrompt: options.systemPrompt,
      userText: options.userText,
      sessionId,
      reasoningEffort: options.reasoningEffort,
      fast: options.fast,
    });

    let currentAuth = options.authState;
    let reloadedOnce = false;
    let refreshedOnce = false;

    while (true) {
      try {
        return await this.sendOnce(currentAuth, requestBody, sessionId);
      } catch (error) {
        if (!(error instanceof CodexUnauthorizedError)) {
          throw error;
        }

        if (!reloadedOnce) {
          reloadedOnce = true;
          const reloaded = reloadCodexAuthState(currentAuth);
          if (reloaded.changed) {
            if (reloaded.state.tokens.accountId !== currentAuth.tokens.accountId) {
              throw new CodexAuthError('Codex auth account changed on disk during retry.');
            }
            currentAuth = reloaded.state;
            continue;
          }
        }

        if (!refreshedOnce) {
          refreshedOnce = true;
          currentAuth = await refreshCodexTokens(currentAuth, {
            originator: this.settings.originator,
            version: this.settings.version,
            timeoutMs: this.settings.timeoutMs,
            fetchImpl: this.fetchImpl,
          });
          continue;
        }

        throw error;
      }
    }
  }

  private async sendOnce(
    authState: CodexAuthState,
    requestBody: Record<string, unknown>,
    sessionId: string
  ): Promise<TransformResult> {
    const url = `${this.settings.baseUrl.replace(/\/+$/, '')}/responses`;
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: buildRequestHeaders({
        accessToken: authState.tokens.accessToken,
        accountId: authState.tokens.accountId,
        originator: this.settings.originator,
        version: this.settings.version,
        sessionId,
      }),
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(this.settings.timeoutMs),
    });

    const rawText = await response.text();
    if (response.status === 401) {
      throw new CodexUnauthorizedError(safeResponseText(rawText, response.status));
    }
    if (!response.ok) {
      throw new CodexTransportError(
        `Codex backend request failed with ${response.status}: ${safeResponseText(rawText, response.status)}`
      );
    }

    return consumeResponseStream(rawText.split(/\r?\n/), sessionId);
  }
}

export function buildTransformRequest(options: {
  model: string;
  systemPrompt: string;
  userText: string;
  sessionId: string;
  reasoningEffort: ReasoningEffort | null;
  fast: boolean;
}): Record<string, unknown> {
  const promptCacheKey = uuidv5(options.systemPrompt, PROMPT_CACHE_NAMESPACE);
  const request: Record<string, unknown> = {
    model: options.model,
    instructions: options.systemPrompt,
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: options.userText }],
      },
    ],
    tools: [],
    tool_choice: 'auto',
    parallel_tool_calls: false,
    store: false,
    stream: true,
    include: [],
    prompt_cache_key: promptCacheKey,
  };

  if (options.reasoningEffort) {
    request.reasoning = { effort: options.reasoningEffort, summary: 'auto' };
    request.include = ['reasoning.encrypted_content'];
  }

  if (options.fast) {
    request.service_tier = 'priority';
  }

  return request;
}

export function buildRequestHeaders(options: {
  accessToken: string;
  accountId: string;
  originator: string;
  version: string;
  sessionId: string;
}): Record<string, string> {
  return {
    authorization: `Bearer ${options.accessToken}`,
    'chatgpt-account-id': options.accountId,
    'content-type': 'application/json',
    accept: 'text/event-stream',
    originator: options.originator,
    'user-agent': buildCodexUserAgent(options.originator, options.version),
    session_id: options.sessionId,
    version: options.version,
  };
}

export function* iterSsePayloads(lines: Iterable<string>): Iterable<string> {
  let dataLines: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!line) {
      if (dataLines.length > 0) {
        yield dataLines.join('\n');
        dataLines = [];
      }
      continue;
    }

    if (line.startsWith(':')) {
      continue;
    }

    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (dataLines.length > 0) {
    yield dataLines.join('\n');
  }
}

export function consumeResponseStream(lines: Iterable<string>, sessionId: string): TransformResult {
  const outputText: string[] = [];
  const assistantItems: Record<string, unknown>[] = [];
  let responseId: string | null = null;
  let usage: Record<string, unknown> | null = null;
  let completed = false;

  for (const payload of iterSsePayloads(lines)) {
    if (payload === '[DONE]') {
      continue;
    }

    const event = JSON.parse(payload) as Record<string, unknown>;
    const eventType = event.type;

    if (eventType === 'response.output_text.delta') {
      if (typeof event.delta === 'string') {
        outputText.push(event.delta);
      }
      continue;
    }

    if (eventType === 'response.output_item.done') {
      if (isRecord(event.item)) {
        assistantItems.push(event.item);
      }
      continue;
    }

    if (eventType === 'response.completed') {
      if (isRecord(event.response)) {
        responseId = typeof event.response.id === 'string' ? event.response.id : null;
        usage = isRecord(event.response.usage) ? event.response.usage : null;
      }
      completed = true;
      continue;
    }

    if (eventType === 'response.failed') {
      throw new CodexTransportError(buildFailedResponseMessage(event));
    }

    if (eventType === 'response.incomplete') {
      throw new CodexTransportError('Codex backend returned response.incomplete.');
    }
  }

  if (!completed) {
    throw new CodexTransportError('Codex stream closed before response.completed.');
  }

  const text = outputText.join('') || extractAssistantText(assistantItems);
  return {
    text,
    responseId,
    usage,
    sessionId,
  };
}

export function extractAssistantText(items: Record<string, unknown>[]): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.type !== 'message' || item.role !== 'assistant' || !Array.isArray(item.content)) {
      continue;
    }

    const parts: string[] = [];
    for (const contentItem of item.content) {
      if (!isRecord(contentItem) || contentItem.type !== 'output_text' || typeof contentItem.text !== 'string') {
        continue;
      }
      parts.push(contentItem.text);
    }

    if (parts.length > 0) {
      return parts.join('');
    }
  }

  return '';
}

function buildFailedResponseMessage(event: Record<string, unknown>): string {
  if (isRecord(event.response) && isRecord(event.response.error) && typeof event.response.error.message === 'string') {
    return event.response.error.message.trim();
  }
  return 'Codex backend returned response.failed.';
}

function safeResponseText(body: string, status: number): string {
  const redacted = body.replace(/Bearer\s+[^\s"]+/g, 'Bearer [REDACTED]').trim();
  return redacted || `HTTP ${status}`;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
