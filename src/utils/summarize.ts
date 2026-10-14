/**
 * Summarization Compaction Utilities
 *
 * Provides Codex-first summarization for conversation compaction.
 * Used by fork, compact, and other session management commands.
 */

import * as fs from 'fs';
import * as path from 'path';
import { UserMessage, AssistantMessage } from '../conversation/Message.js';
import { summarizeText, SummaryProvider } from './summary-provider.js';

export interface ConversationMessage {
  type: string;
  message?: {
    role?: string;
    content: unknown;
  } | Record<string, unknown>;
  toolUseResult?: {
    originalFile?: string;
    file?: {
      content?: string;
      filePath?: string;
      numLines?: number;
      startLine?: number;
      totalLines?: number;
    };
    stdout?: string;
    stderr?: string;
    content?: unknown;
    oldString?: string;
    newString?: string;
    structuredPatch?: string;
    type?: string;
  };
  snapshot?: unknown;
  [key: string]: unknown;
}

export interface SummarizationResult {
  compactedMessages: ConversationMessage[];
  summary: string;
  providerUsed: SummaryProvider;
  modelUsed: string;
  fallbackFrom?: SummaryProvider;
  fallbackReason?: string;
  originalSize: number;
  compactedSize: number;
  messagesCut: number;
  messagesKept: number;
  fileContextCount: number;
}

export interface SummarizationOptions {
  cutoffPercent?: number;  // Default: 60
  maxFileContext?: number; // Default: 5
  summaryProvider?: SummaryProvider;
  summaryModel?: string;
  model?: string;          // Legacy Claude-only alias
  dryRun?: boolean;
  includeFileReads?: boolean; // Default: false - include fake Read tool calls for modified files
}

const MAX_SUMMARY_TRANSCRIPT_CHARS = 120_000;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function truncateMessage(msg: ConversationMessage): ConversationMessage {
  const copy = JSON.parse(JSON.stringify(msg)) as ConversationMessage;

  // Remove originalFile entirely (biggest space saver)
  if (copy.toolUseResult?.originalFile) {
    delete copy.toolUseResult.originalFile;
  }

  // Truncate file.content
  if (copy.toolUseResult?.file?.content && copy.toolUseResult.file.content.length > 200) {
    const content = copy.toolUseResult.file.content;
    copy.toolUseResult.file.content = content.slice(0, 100) + '\n\n...COMPACTED...\n\n' + content.slice(-100);
  }

  // Truncate stdout/stderr
  if (copy.toolUseResult?.stdout && copy.toolUseResult.stdout.length > 500) {
    const content = copy.toolUseResult.stdout;
    copy.toolUseResult.stdout = content.slice(0, 250) + '\n\n...COMPACTED...\n\n' + content.slice(-250);
  }

  // Process message content blocks
  if (copy.message?.content && Array.isArray(copy.message.content)) {
    const filteredContent: Record<string, unknown>[] = [];
    for (const block of copy.message.content as Record<string, unknown>[]) {
      // Remove thinking blocks entirely (not needed for summarization)
      if (block.type === 'thinking') {
        continue;
      }
      // Truncate tool_result content
      if (block.type === 'tool_result' && typeof block.content === 'string' && block.content.length > 500) {
        block.content = block.content.slice(0, 250) + '\n\n...COMPACTED...\n\n' + block.content.slice(-250);
      }
      filteredContent.push(block);
    }
    (copy.message as Record<string, unknown>).content = filteredContent;
  }

  return copy;
}

interface FileAccess {
  filePath: string;
  reads: number;
  edits: number;
}

function extractFileAccessPatterns(messages: ConversationMessage[]): Map<string, FileAccess> {
  const fileAccess = new Map<string, FileAccess>();

  for (const msg of messages) {
    if (msg.message?.content && Array.isArray(msg.message.content)) {
      for (const block of msg.message.content as Record<string, unknown>[]) {
        if (block.type === 'tool_use') {
          const input = block.input as Record<string, unknown> | undefined;
          const filePath = input?.file_path as string | undefined;

          if (filePath && (block.name === 'Read' || block.name === 'Edit' || block.name === 'Write')) {
            const access = fileAccess.get(filePath) || { filePath, reads: 0, edits: 0 };
            if (block.name === 'Read') {
              access.reads++;
            } else {
              access.edits++;
            }
            fileAccess.set(filePath, access);
          }
        }
      }
    }
  }

  return fileAccess;
}

function generateFileContextMessages(fileAccess: Map<string, FileAccess>, maxFiles: number = 5): ConversationMessage[] {
  const contextMessages: ConversationMessage[] = [];

  const sortedFiles = Array.from(fileAccess.values())
    .filter(f => f.edits > 0)
    .sort((a, b) => (b.edits + b.reads) - (a.edits + a.reads))
    .slice(0, maxFiles);

  for (const file of sortedFiles) {
    if (fs.existsSync(file.filePath)) {
      try {
        const content = fs.readFileSync(file.filePath, 'utf-8');
        const lines = content.split('\n');
        const formattedContent = lines
          .map((line, i) => `${String(i + 1).padStart(5)}→${line}`)
          .join('\n');

        let finalContent = formattedContent;
        if (formattedContent.length > 10000) {
          const keepChars = 4500;
          finalContent = formattedContent.slice(0, keepChars) +
            '\n\n... [FILE TRUNCATED FOR CONTEXT] ...\n\n' +
            formattedContent.slice(-keepChars);
        }

        // Generate a proper tool_use_id format (like toolu_xxx)
        const toolUseId = `toolu_context_${Math.random().toString(36).slice(2, 14)}`;

        // Match the exact format Claude Code expects
        contextMessages.push({
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                tool_use_id: toolUseId,
                type: 'tool_result',
                content: `[AUTO-READ FOR CONTEXT] Current state of ${file.filePath} (${file.edits} edits in previous conversation):\n\n${finalContent}`,
              },
            ],
          },
          // Add toolUseResult field that Claude Code expects
          toolUseResult: {
            type: 'text',
            file: {
              filePath: file.filePath,
              content: finalContent,
              numLines: lines.length,
              startLine: 1,
              totalLines: lines.length,
            },
          },
        });
      } catch {
        // Skip files we can't read
      }
    }
  }

  return contextMessages;
}

const SUMMARY_PROMPT = `Analyze the conversation above and create a DETAILED structured summary for context preservation. This summary will be used to continue work in a new conversation.

IMPORTANT: Be thorough. The summary should be comprehensive enough that someone can continue the work without reading the full conversation.

Please provide a comprehensive summary with these sections:

## Problem Statements
- What were the initial problems, bugs, or feature requests?
- What were the symptoms or error messages?
- What was the user trying to accomplish?

## Solutions Implemented
- What fixes or implementations were made?
- What was the approach/algorithm used?
- What trade-offs were considered?

## Working Directory and Files
- What is the main working directory?
- List all files that were created, modified, or read
- For each important file, describe what it does and what changes were made

## Related Commits
- List any git commits mentioned with their short messages
- Note any branches that were created, merged, or switched

## References to Reread
- List specific files and line ranges that would be helpful to reread
- Note any important functions, classes, or patterns
- Include any documentation files that were referenced

## Current State
- Where exactly did the work stop?
- What was the last action taken?
- Are there any failing tests or pending issues?

## Todo List
- What tasks are still pending?
- What was planned but not yet implemented?
- Any known issues that need attention?

## Commands Reference
- Important build/test/deploy commands used
- Any environment setup or configuration needed

Be thorough and specific. Include file paths, function names, and line numbers where relevant. This summary should enable someone to continue the work without reading the full conversation.`;

function formatMessagesForSummary(messages: ConversationMessage[], projectDir: string): string {
  const truncatedMessages = messages.map(truncateMessage);
  const perMessageBudget = Math.max(
    120,
    Math.min(600, Math.floor(MAX_SUMMARY_TRANSCRIPT_CHARS / Math.max(truncatedMessages.length, 1)))
  );
  const lines: string[] = [];

  lines.push(`Working directory: ${projectDir}`);
  lines.push('');

  for (const msg of truncatedMessages) {
    const role = msg.message?.role === 'assistant' ? 'Assistant' : 'User';
    const content = truncateMiddle(extractSummaryContent(msg), perMessageBudget);
    if (!content) {
      continue;
    }

    lines.push(`${role}:`);
    lines.push(content);
    lines.push('');
  }

  return lines.join('\n').trim();
}

function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  const keepEach = Math.max(40, Math.floor((maxChars - 20) / 2));
  return `${text.slice(0, keepEach)}\n\n...TRUNCATED...\n\n${text.slice(-keepEach)}`;
}

function extractSummaryContent(message: ConversationMessage): string {
  const content = message.message?.content;
  if (typeof content === 'string') {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return '';
  }

  const parts: string[] = [];
  for (const block of content as Record<string, unknown>[]) {
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text.trim());
      continue;
    }

    if (block.type === 'tool_use') {
      const args = block.input ? JSON.stringify(block.input, null, 2) : '{}';
      parts.push(`Tool Call: ${block.name || 'unknown'}\nArguments:\n${args}`);
      continue;
    }

    if (block.type === 'tool_result') {
      const toolResultContent = typeof block.content === 'string'
        ? block.content
        : JSON.stringify(block.content ?? '', null, 2);
      parts.push(`Tool Result (${block.tool_use_id || 'unknown'}):\n${toolResultContent}`);
    }
  }

  return parts.join('\n\n').trim();
}

/**
 * Perform summarization compaction on a list of messages
 * Uses the Conversation API for clean manipulation
 */
export async function summarizeMessages(
  messages: ConversationMessage[],
  projectDir: string,
  options: SummarizationOptions = {}
): Promise<SummarizationResult> {
  const {
    cutoffPercent = 60,
    summaryProvider,
    summaryModel,
    model,
    includeFileReads = false,
  } = options;

  // Import Conversation class
  const { Conversation, AssistantMessage } = await import('../conversation/index.js');

  // Load conversation and split at cutoff
  const conv = Conversation.fromMessages(messages as any);
  const originalSize = conv.size;
  const [first, second] = conv.splitAt(cutoffPercent);

  const transcript = formatMessagesForSummary(first.toMessages() as ConversationMessage[], projectDir);
  console.log('Generating summary...');
  const summaryResult = await summarizeText(transcript, SUMMARY_PROMPT, {
    summaryProvider,
    summaryModel,
    model,
    cwd: projectDir,
    timeoutMs: 300_000,
  });

  // Extract file access patterns (for stats)
  const fileAccess = extractFileAccessPatterns(first.toMessages() as ConversationMessage[]);
  const fileContextMessages: ConversationMessage[] = [];

  // Get first user message
  const firstUser = conv.getRoot() || (conv.toMessages().find(m => m.type === 'user') as any) || (messages.find(m => m.type === 'user') as any);
  if (!firstUser) {
    throw new Error('No root user message found');
  }

  // Second part is appended after summary
  const lastMessages = second.toMessages();

  // Get important files to read for context (if enabled)
  let filesToRead: Awaited<ReturnType<typeof import('./file-stats.js').getImportantFiles>> = [];
  if (includeFileReads) {
    const { getImportantFiles } = await import('./file-stats.js');
    filesToRead = getImportantFiles(first.toMessages() as ConversationMessage[], {
      maxBytes: 100000,
      maxFiles: 10,
    });
    console.log(`File context: ${filesToRead.length} files, ${(filesToRead.reduce((s, f) => s + f.bytes, 0) / 1024).toFixed(1)}KB`);
  } else {
    console.log('File context: disabled');
  }

  // Build result: first user + file reads + summary + second part
  const compacted = Conversation.create({
    sessionId: conv.sessionId,
    cwd: firstUser.cwd,
    gitBranch: firstUser.gitBranch,
    version: firstUser.version,
  });

  compacted.append({ ...firstUser, parentUuid: null } as any);

  // Add Read tool_use + tool_result pairs for important files (if enabled)
  if (includeFileReads && filesToRead.length > 0) {
    const { readFileContent } = await import('./file-stats.js');
    for (const file of filesToRead) {
      // Create assistant message with Read tool_use (proper API format)
      const readToolUseMsg = AssistantMessage.toolUse('Read', {
        file_path: file.path,
        ...(file.ranges ? { offset: file.ranges[0].start, limit: file.ranges[file.ranges.length - 1].end - file.ranges[0].start } : {}),
      }, { sessionId: conv.sessionId });
      compacted.append(readToolUseMsg as any);

      // Get the tool_use ID from the message we just created
      const toolUseId = (readToolUseMsg.message?.content as any[])?.[0]?.id;

      // User message with tool_result containing file content
      let fileContent: string;
      try {
        fileContent = readFileContent(file);
      } catch (e) {
        fileContent = `Error reading file: ${e}`;
      }

      const readToolResult = UserMessage.toolResult(toolUseId, fileContent, false, { sessionId: conv.sessionId });
      compacted.append(readToolResult as any);
    }
  }

  compacted.append(AssistantMessage.summary(summaryResult.text) as any);
  compacted.appendAll(lastMessages as any[]);
  compacted.filterOrphans().rebuildChain().updateTimestamps();

  const compactedMessages = compacted.toMessages() as ConversationMessage[];
  const compactedSize = compacted.size;

  return {
    compactedMessages,
    summary: summaryResult.text,
    providerUsed: summaryResult.providerUsed,
    modelUsed: summaryResult.modelUsed,
    fallbackFrom: summaryResult.fallbackFrom,
    fallbackReason: summaryResult.fallbackReason,
    originalSize,
    compactedSize,
    messagesCut: first.length,
    messagesKept: lastMessages.length,
    fileContextCount: fileContextMessages.length,
  };
}

/**
 * Summarize a session file in place (with backup)
 */
export async function summarizeSessionFile(
  filePath: string,
  options: SummarizationOptions = {}
): Promise<SummarizationResult> {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  const messages: ConversationMessage[] = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      messages.push(JSON.parse(lines[i]) as ConversationMessage);
    } catch (e) {
      console.warn(`Skipping invalid JSON at line ${i + 1}: ${(e as Error).message}`);
    }
  }

  // Get project dir from first user message's cwd
  const firstUser = messages.find(m => m.type === 'user');
  const projectDir = (firstUser?.cwd as string) || process.cwd();

  const result = await summarizeMessages(messages, projectDir, options);

  if (!options.dryRun) {
    // Create backup
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupPath = filePath.replace('.jsonl', `.backup-${timestamp}.jsonl`);
    fs.copyFileSync(filePath, backupPath);
    console.log(`Backup: ${path.basename(backupPath)}`);

    // Write compacted file
    const compactedContent = result.compactedMessages.map(m => JSON.stringify(m)).join('\n') + '\n';
    fs.writeFileSync(filePath, compactedContent);
  }

  return result;
}

/**
 * Print summarization results
 */
export function printSummarizationResult(result: SummarizationResult, dryRun?: boolean): void {
  const savedBytes = result.originalSize - result.compactedSize;
  const savedPercent = Math.round((savedBytes / result.originalSize) * 100);

  if (dryRun) {
    console.log('Dry run - no changes made');
  }

  const providerLine = result.fallbackFrom
    ? `Summary provider: ${result.providerUsed} (fallback from ${result.fallbackFrom}: ${result.fallbackReason})`
    : `Summary provider: ${result.providerUsed} (${result.modelUsed})`;

  console.log(providerLine);
  console.log(`Messages: ${result.messagesCut} summarized, ${result.messagesKept} kept`);
  console.log(`File context: ${result.fileContextCount} files auto-read`);
  console.log(`Size: ${formatBytes(result.originalSize)} → ${formatBytes(result.compactedSize)}`);
  console.log(`Saved: ${formatBytes(savedBytes)} (${savedPercent}%)`);
}
