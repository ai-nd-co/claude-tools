import { runPrompt, PromptOptions, PromptResult } from './claude-prompt.js';
import { loadCodexAuthState } from './codex-auth.js';
import { loadCodexDefaults, normalizeClaudeSummarizationModel, DEFAULT_CLAUDE_SUMMARIZATION_MODEL, DEFAULT_CODEX_MODEL } from './codex-config.js';
import { ClientSettings, CodexPrivateClient, CodexTransportError } from './codex-private-api.js';
import { CodexAuthError, CodexPermanentRefreshError, FetchLike } from './codex-auth.js';

export type SummaryProvider = 'codex' | 'claude';
const CODEX_MAX_SUMMARY_INPUT_CHARS = 45_000;
const CODEX_CHUNK_SUMMARY_PROMPT = `You are summarizing one chunk of a larger transcript for later merge.

Summarize only facts that appear in this chunk.
- Preserve file paths, commands, errors, decisions, status, and unfinished work
- Use concise markdown bullets and short sections
- Do not mention chunk numbers
- Do not invent missing context`;
const CODEX_MERGE_SUMMARY_PROMPT = `You are consolidating partial chunk summaries from a larger transcript.

Merge them into one smaller coherent summary.
- Deduplicate repeated facts
- Preserve file paths, commands, errors, decisions, current state, and todos
- Use concise markdown bullets and short sections`;

export interface SummaryOptionInput {
  summaryProvider?: SummaryProvider;
  summaryModel?: string;
  model?: string;
}

export interface SummaryRequestOptions extends SummaryOptionInput {
  cwd?: string;
  timeoutMs?: number;
  codexHome?: string;
  fetchImpl?: FetchLike;
  claudeRunner?: (
    data: string,
    instructions: string,
    options?: PromptOptions
  ) => Promise<PromptResult>;
}

export interface SummaryExecutionResult {
  providerUsed: SummaryProvider;
  modelUsed: string;
  text: string;
  fallbackFrom?: SummaryProvider;
  fallbackReason?: string;
}

export function resolveSummaryOptions(input: SummaryOptionInput): { provider?: SummaryProvider; model?: string } {
  if (input.summaryProvider === 'codex' && input.model && !input.summaryModel) {
    throw new Error('Legacy --model is Claude-only. Use --summary-model with --summary-provider codex.');
  }

  if (input.summaryProvider) {
    return {
      provider: input.summaryProvider,
      model: input.summaryModel || (input.summaryProvider === 'claude' ? input.model : undefined),
    };
  }

  if (input.summaryModel) {
    return { model: input.summaryModel };
  }

  if (input.model) {
    return { provider: 'claude', model: input.model };
  }

  return {};
}

export async function summarizeText(
  data: string,
  prompt: string,
  options: SummaryRequestOptions = {}
): Promise<SummaryExecutionResult> {
  const resolved = resolveSummaryOptions(options);

  if (resolved.provider === 'claude') {
    return runClaudeSummary(data, prompt, {
      model: resolved.model,
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      claudeRunner: options.claudeRunner,
    });
  }

  if (resolved.provider === 'codex') {
    return runCodexSummary(data, prompt, {
      model: resolved.model,
      codexHome: options.codexHome,
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
    });
  }

  try {
    return await runCodexSummary(data, prompt, {
      model: resolved.model,
      codexHome: options.codexHome,
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
    });
  } catch (error) {
    if (
      error instanceof CodexAuthError ||
      error instanceof CodexTransportError ||
      error instanceof CodexPermanentRefreshError
    ) {
      const fallback = await runClaudeSummary(data, prompt, {
        cwd: options.cwd,
        timeoutMs: options.timeoutMs,
        claudeRunner: options.claudeRunner,
      });

      return {
        ...fallback,
        fallbackFrom: 'codex',
        fallbackReason: error.message,
      };
    }

    throw error;
  }
}

async function runCodexSummary(
  data: string,
  prompt: string,
  options: {
    model?: string;
    codexHome?: string;
    timeoutMs?: number;
    fetchImpl?: FetchLike;
  }
): Promise<SummaryExecutionResult> {
  const defaults = loadCodexDefaults(options.codexHome);
  const effectiveModel = options.model || defaults.model || DEFAULT_CODEX_MODEL;
  const settings: ClientSettings = {
    baseUrl: defaults.baseUrl,
    originator: defaults.originator,
    version: defaults.version,
    timeoutMs: options.timeoutMs ?? 600_000,
  };
  const summaryReasoningEffort = null;

  const client = new CodexPrivateClient(settings, options.fetchImpl);
  const executeCodex = async (systemPrompt: string, userText: string): Promise<string> => {
    const authState = loadCodexAuthState(defaults.codexHome);
    const result = await client.transform({
      authState,
      systemPrompt,
      userText,
      model: effectiveModel,
      reasoningEffort: summaryReasoningEffort,
      fast: false,
    });
    return result.text;
  };

  let text: string;
  if (data.length > CODEX_MAX_SUMMARY_INPUT_CHARS) {
    text = await summarizeLargeTextWithCodex(data, prompt, executeCodex);
  } else {
    try {
      text = await executeCodex(prompt, data);
    } catch (error) {
      if (isCodexContextWindowError(error)) {
        text = await summarizeLargeTextWithCodex(data, prompt, executeCodex);
      } else {
        throw error;
      }
    }
  }

  return {
    providerUsed: 'codex',
    modelUsed: effectiveModel,
    text,
  };
}

async function runClaudeSummary(
  data: string,
  prompt: string,
  options: {
    model?: string;
    cwd?: string;
    timeoutMs?: number;
    claudeRunner?: (
      data: string,
      instructions: string,
      promptOptions?: PromptOptions
    ) => Promise<PromptResult>;
  }
): Promise<SummaryExecutionResult> {
  const model = normalizeClaudeSummarizationModel(options.model || DEFAULT_CLAUDE_SUMMARIZATION_MODEL);
  const runner = options.claudeRunner || runPrompt;
  const result = await runner(data, prompt, {
    model,
    timeout: options.timeoutMs ?? 600_000,
    cwd: options.cwd,
  });

  if (!result.success) {
    throw new Error(`Claude summarization failed: ${result.error || 'unknown error'}`);
  }

  return {
    providerUsed: 'claude',
    modelUsed: model,
    text: result.output,
  };
}

async function summarizeLargeTextWithCodex(
  data: string,
  finalPrompt: string,
  executeCodex: (systemPrompt: string, userText: string) => Promise<string>
): Promise<string> {
  const chunks = splitTextIntoChunks(data, CODEX_MAX_SUMMARY_INPUT_CHARS);
  const partials: string[] = [];

  for (let index = 0; index < chunks.length; index++) {
    const chunkPrompt = `${CODEX_CHUNK_SUMMARY_PROMPT}

Target final summary requirements:
${finalPrompt}

This is part ${index + 1} of ${chunks.length}.`;
    partials.push(await executeCodex(chunkPrompt, chunks[index]));
  }

  let merged = partials.map((summary, index) => `## Partial Summary ${index + 1}\n${summary}`).join('\n\n');

  while (merged.length > CODEX_MAX_SUMMARY_INPUT_CHARS) {
    const mergedChunks = splitTextIntoChunks(merged, CODEX_MAX_SUMMARY_INPUT_CHARS);
    const reduced: string[] = [];
    for (let index = 0; index < mergedChunks.length; index++) {
      const mergePrompt = `${CODEX_MERGE_SUMMARY_PROMPT}

Target final summary requirements:
${finalPrompt}

This is merge batch ${index + 1} of ${mergedChunks.length}.`;
      reduced.push(await executeCodex(mergePrompt, mergedChunks[index]));
    }
    merged = reduced.map((summary, index) => `## Reduced Summary ${index + 1}\n${summary}`).join('\n\n');
  }

  return executeCodex(
    `${CODEX_MERGE_SUMMARY_PROMPT}

Target final summary requirements:
${finalPrompt}`,
    `The following are partial summaries from a larger transcript.\n\n${merged}`
  );
}

function splitTextIntoChunks(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) {
    return [text];
  }

  const paragraphs = text.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = '';

  const flushCurrent = (): void => {
    const trimmed = current.trim();
    if (trimmed) {
      chunks.push(trimmed);
    }
    current = '';
  };

  for (const paragraph of paragraphs) {
    if (!paragraph) {
      continue;
    }

    if (paragraph.length > maxChars) {
      flushCurrent();
      for (let start = 0; start < paragraph.length; start += maxChars) {
        chunks.push(paragraph.slice(start, start + maxChars));
      }
      continue;
    }

    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length > maxChars) {
      flushCurrent();
      current = paragraph;
    } else {
      current = candidate;
    }
  }

  flushCurrent();
  return chunks;
}

function isCodexContextWindowError(error: unknown): boolean {
  return error instanceof CodexTransportError && /context window/i.test(error.message);
}
