import * as fs from 'fs';
import { summarizeText, SummaryProvider } from './summary-provider.js';

export interface CodexEntry {
  timestamp?: string;
  type: string;
  payload?: any;
  [key: string]: unknown;
}

export interface CodexCompactionOptions {
  keepPercent?: number;
  summaryProvider?: SummaryProvider;
  summaryModel?: string;
  model?: string;
  dryRun?: boolean;
  maxOutputChars?: number;
  prompt?: string;
}

export interface CodexCompactionResult {
  compactedEntries: CodexEntry[];
  summary: string;
  providerUsed: SummaryProvider;
  modelUsed: string;
  fallbackFrom?: SummaryProvider;
  fallbackReason?: string;
  originalSize: number;
  compactedSize: number;
  turnsSummarized: number;
  turnsKept: number;
  cutoffIndex: number;
}

const DEFAULT_MAX_OUTPUT = 2000;
const DEFAULT_KEEP_PERCENT = 50;
const MAX_CODEX_TRANSCRIPT_CHARS = 120_000;

const DEFAULT_PROMPT = `Analyze the Codex conversation transcript above and produce a DETAILED structured summary.

This summary will replace the earlier portion of the conversation to save tokens while preserving context.

Please include these sections:

## Problem Statements
- What was the user asking for?
- What context or constraints were provided?

## Work Performed
- What investigations or actions were taken?
- What tools/commands were used?

## Files & Repos Touched
- Files read or modified (include paths)
- Any repos or directories referenced

## Decisions & Rationale
- Key choices made and why

## Current State
- Where the work stopped
- Anything pending or unresolved

## Next Steps
- Concrete next actions to continue

Be concise but specific. Include file paths, command names, and identifiers when relevant.`;

function safeParseJsonLine(line: string): CodexEntry | null {
  try {
    return JSON.parse(line) as CodexEntry;
  } catch {
    return null;
  }
}

function extractMessageText(content: any): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'input_text' || block.type === 'output_text' || block.type === 'text') {
      if (typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
  }
  return parts.join('\n').trim();
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const keepEach = Math.max(200, Math.floor(maxChars / 2));
  return `${text.slice(0, keepEach)}\n\n...TRUNCATED...\n\n${text.slice(-keepEach)}`;
}

function isUserMessageEntry(entry: CodexEntry): boolean {
  return entry.type === 'response_item' &&
    entry.payload?.type === 'message' &&
    entry.payload?.role === 'user';
}

function formatEntriesForSummary(entries: CodexEntry[], maxOutputChars: number): string {
  const perEntryBudget = Math.max(
    120,
    Math.min(600, Math.floor(MAX_CODEX_TRANSCRIPT_CHARS / Math.max(entries.length, 1)))
  );
  const lines: string[] = [];

  for (const entry of entries) {
    if (entry.type === 'response_item') {
      const payload = entry.payload || {};
      if (payload.type === 'message') {
        const role = payload.role === 'assistant' ? 'Assistant' : 'User';
        const text = truncateText(extractMessageText(payload.content), perEntryBudget);
        if (text) {
          lines.push(`${role}: ${text}`);
          lines.push('');
        }
      } else if (payload.type === 'function_call') {
        const args = typeof payload.arguments === 'string' ? payload.arguments : JSON.stringify(payload.arguments || {});
        lines.push(`Tool Call: ${payload.name || 'unknown'}`);
        lines.push(`Arguments: ${truncateText(args, Math.min(maxOutputChars, perEntryBudget))}`);
        lines.push('');
      } else if (payload.type === 'function_call_output') {
        const output = typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output || {});
        lines.push(`Tool Output (${payload.call_id || 'unknown'}):`);
        lines.push(truncateText(output, Math.min(maxOutputChars, perEntryBudget)));
        lines.push('');
      } else if (payload.type === 'web_search_call') {
        lines.push('Web Search Call:');
        lines.push(truncateText(JSON.stringify(payload, null, 2), Math.min(maxOutputChars, perEntryBudget)));
        lines.push('');
      }
      continue;
    }

    if (entry.type === 'event_msg') {
      const payload = entry.payload || {};
      if (payload.type === 'user_message' && typeof payload.message === 'string') {
        lines.push(`User (event): ${payload.message}`);
        lines.push('');
      } else if (payload.type === 'agent_message' && typeof payload.message === 'string') {
        lines.push(`Assistant (event): ${payload.message}`);
        lines.push('');
      }
    }
  }

  return lines.join('\n').trim();
}

function buildTurns(entries: CodexEntry[]): Array<{ start: number; end: number }> {
  const userIndexes: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (isUserMessageEntry(entries[i])) {
      userIndexes.push(i);
    }
  }

  if (userIndexes.length === 0) {
    return entries.length > 0 ? [{ start: 0, end: entries.length - 1 }] : [];
  }

  const turns: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < userIndexes.length; i++) {
    const start = userIndexes[i];
    const end = (i + 1 < userIndexes.length) ? userIndexes[i + 1] - 1 : entries.length - 1;
    turns.push({ start, end });
  }

  return turns;
}

function getFirstTimestamp(entries: CodexEntry[]): Date | null {
  for (const entry of entries) {
    if (entry.timestamp) {
      const d = new Date(entry.timestamp);
      if (!isNaN(d.getTime())) {
        return d;
      }
    }
  }
  return null;
}

function buildSummaryEntries(summary: string, baseTime?: Date | null): CodexEntry[] {
  const summaryText = `## Code Tools 3.3 Summary\n\n${summary}`;
  const base = baseTime ? baseTime.getTime() : Date.now();
  const tsEvent = new Date(base - 2).toISOString();
  const tsMessage = new Date(base - 1).toISOString();

  return [
    {
      timestamp: tsEvent,
      type: 'event_msg',
      payload: {
        type: 'agent_message',
        message: summaryText,
      },
    },
    {
      timestamp: tsMessage,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: summaryText,
          },
        ],
      },
    },
  ];
}

function cloneEntry(entry: CodexEntry): CodexEntry {
  return JSON.parse(JSON.stringify(entry)) as CodexEntry;
}

export async function compactCodexSessionEnhanced(
  filePath: string,
  options: CodexCompactionOptions = {}
): Promise<CodexCompactionResult> {
  const {
    keepPercent = DEFAULT_KEEP_PERCENT,
    summaryProvider,
    summaryModel,
    model,
    maxOutputChars = DEFAULT_MAX_OUTPUT,
    prompt = DEFAULT_PROMPT,
  } = options;

  const raw = fs.readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim());
  const entries = lines.map(safeParseJsonLine).filter(Boolean) as CodexEntry[];

  const originalSize = entries.reduce((sum, e) => sum + JSON.stringify(e).length, 0);
  const turns = buildTurns(entries);
  const keepClamp = Math.max(0, Math.min(100, keepPercent));
  const summarizePercent = Math.max(0, Math.min(100, 100 - keepClamp));
  const summarizeTurns = Math.floor(turns.length * (summarizePercent / 100));

  if (turns.length === 0 || summarizeTurns <= 0) {
    return {
      compactedEntries: entries.map(cloneEntry),
      summary: '',
      providerUsed: 'codex',
      modelUsed: 'none',
      originalSize,
      compactedSize: originalSize,
      turnsSummarized: 0,
      turnsKept: turns.length,
      cutoffIndex: -1,
    };
  }

  const cutoffTurnIndex = Math.max(0, Math.min(turns.length - 1, summarizeTurns - 1));
  const cutoffIndex = turns[cutoffTurnIndex].end;

  const firstPart = entries.slice(0, cutoffIndex + 1);
  const secondPart = entries.slice(cutoffIndex + 1);

  const transcript = formatEntriesForSummary(firstPart, maxOutputChars);
  const sessionCwd = entries.find(e => e.type === 'session_meta')?.payload?.cwd as string | undefined;
  const summaryResult = await summarizeText(transcript, prompt, {
    summaryProvider,
    summaryModel,
    model,
    timeoutMs: 600_000,
    cwd: sessionCwd || process.cwd(),
  });
  const summary = summaryResult.text;

  const sessionMeta = entries.find(e => e.type === 'session_meta');
  const lastTurnContext = [...entries].reverse().find(e => e.type === 'turn_context');
  const baseTime = getFirstTimestamp(secondPart);

  const compacted: CodexEntry[] = [];
  if (sessionMeta) compacted.push(cloneEntry(sessionMeta));
  if (lastTurnContext) compacted.push(cloneEntry(lastTurnContext));
  compacted.push(...buildSummaryEntries(summary, baseTime));
  compacted.push(...secondPart.map(cloneEntry));

  const compactedSize = compacted.reduce((sum, e) => sum + JSON.stringify(e).length, 0);

  return {
    compactedEntries: compacted,
    summary,
    providerUsed: summaryResult.providerUsed,
    modelUsed: summaryResult.modelUsed,
    fallbackFrom: summaryResult.fallbackFrom,
    fallbackReason: summaryResult.fallbackReason,
    originalSize,
    compactedSize,
    turnsSummarized: summarizeTurns,
    turnsKept: turns.length - summarizeTurns,
    cutoffIndex,
  };
}
