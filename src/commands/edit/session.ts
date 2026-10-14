// Session parsing and manipulation

import * as fs from 'fs';
import * as path from 'path';
import { RawMessage, DisplayMessage, ContentBlock, Turn } from './types.js';
import { truncateContent, DEFAULT_MAX_OUTPUT } from '../../utils/compact.js';
import { findSessionFileById, findSessionByMarker } from '../../utils/session.js';

// Re-export session utilities for backward compatibility
export { findSessionByMarker };
export { findSessionFileById as findSessionFile };

/**
 * Load session from JSONL file
 */
export function loadSession(filePath: string): RawMessage[] {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n').filter(line => line.trim());
  return lines.map(line => JSON.parse(line) as RawMessage);
}

/**
 * Check if a message is a real user input (not a tool result)
 */
function isRealUserInput(msg: RawMessage): boolean {
  if (msg.type !== 'user') return false;
  if (!msg.message?.content) return false;
  // Real user input has string content, tool results have array content
  return typeof msg.message.content === 'string';
}

/**
 * Group messages into turns. A turn starts with a real user input
 * and includes all subsequent messages until the next user input.
 */
interface TurnBuilder {
  userPrompt: string;
  rawIndexes: number[];
  toolCalls: string[];
  size: number;
}

function buildTurnPreview(toolCalls: string[]): string {
  if (toolCalls.length === 0) return 'text response';
  const unique = [...new Set(toolCalls)].slice(0, 3);
  return `${toolCalls.length} tools: ${unique.join(', ')}${toolCalls.length > 3 ? '...' : ''}`;
}

function saveTurn(turns: Turn[], builder: TurnBuilder): void {
  turns.push({
    index: turns.length,
    userPrompt: builder.userPrompt,
    messageCount: builder.rawIndexes.length,
    toolCalls: builder.toolCalls,
    size: builder.size,
    rawIndexes: builder.rawIndexes,
    preview: buildTurnPreview(builder.toolCalls),
  });
}

export function toTurns(raw: RawMessage[]): Turn[] {
  const turns: Turn[] = [];
  let currentTurn: TurnBuilder | null = null;

  for (let idx = 0; idx < raw.length; idx++) {
    const msg = raw[idx];

    // Skip metadata
    if (msg.type === 'file-history-snapshot' || msg.type === 'summary') {
      continue;
    }

    const msgSize = JSON.stringify(msg).length;

    if (isRealUserInput(msg)) {
      // Save previous turn
      if (currentTurn) {
        saveTurn(turns, currentTurn);
      }

      // Start new turn
      currentTurn = {
        userPrompt: (msg.message!.content as string).slice(0, 60),
        rawIndexes: [idx],
        toolCalls: [],
        size: msgSize,
      };
    } else if (currentTurn) {
      // Add to current turn
      currentTurn.rawIndexes.push(idx);
      currentTurn.size += msgSize;

      // Track tool calls
      if (msg.type === 'assistant' && msg.message?.content && Array.isArray(msg.message.content)) {
        for (const block of msg.message.content as ContentBlock[]) {
          if (block.type === 'tool_use' && block.name) {
            currentTurn.toolCalls.push(block.name);
          }
        }
      }
    }
  }

  // Save last turn
  if (currentTurn) {
    saveTurn(turns, currentTurn);
  }

  return turns;
}

/**
 * Save session to JSONL file
 */
export function saveSession(filePath: string, messages: RawMessage[]): void {
  const content = messages.map(m => JSON.stringify(m)).join('\n') + '\n';
  fs.writeFileSync(filePath, content, 'utf8');
}

/**
 * Create backup of session file with timestamp
 */
export function createBackup(filePath: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupPath = filePath.replace('.jsonl', `.backup-${timestamp}.jsonl`);
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

/**
 * Get message size in bytes
 */
function getMessageSize(msg: RawMessage): number {
  return JSON.stringify(msg).length;
}

/**
 * Get preview text for a message
 */
function getPreview(msg: RawMessage, maxLen = 60): string {
  if (msg.type === 'user' && msg.message?.content) {
    const content = msg.message.content;
    if (typeof content === 'string') {
      return content.slice(0, maxLen) + (content.length > maxLen ? '...' : '');
    }
    // Check for tool_result
    for (const block of content) {
      if (block.type === 'tool_result') {
        return '[tool result]';
      }
    }
  }
  if (msg.type === 'assistant' && msg.message?.content) {
    const content = msg.message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          return block.text.slice(0, maxLen) + (block.text.length > maxLen ? '...' : '');
        }
        if (block.type === 'tool_use' && block.name) {
          return `→ ${block.name}`;
        }
        if (block.type === 'thinking') {
          return '[thinking]';
        }
      }
    }
  }
  return `[${msg.type}]`;
}

/**
 * Convert raw messages to display format, grouping tool calls with results
 */
export function toDisplayMessages(raw: RawMessage[]): DisplayMessage[] {
  const display: DisplayMessage[] = [];
  const toolUseMap = new Map<string, { rawIndex: number; name: string; input: unknown }>();

  // First pass: collect tool_use info
  raw.forEach((msg, idx) => {
    if (msg.type === 'assistant' && msg.message?.content && Array.isArray(msg.message.content)) {
      for (const block of msg.message.content as ContentBlock[]) {
        if (block.type === 'tool_use' && block.id && block.name) {
          toolUseMap.set(block.id, { rawIndex: idx, name: block.name, input: block.input });
        }
      }
    }
  });

  // Second pass: build display messages
  const processedToolResults = new Set<number>();

  raw.forEach((msg, idx) => {
    // Skip file-history-snapshot and other metadata
    if (msg.type === 'file-history-snapshot' || msg.type === 'summary') {
      return;
    }

    // Check if this is a tool result message
    if (msg.type === 'user' && msg.message?.content && Array.isArray(msg.message.content)) {
      const content = msg.message.content as ContentBlock[];
      const toolResult = content.find(b => b.type === 'tool_result');
      if (toolResult && toolResult.tool_use_id) {
        const toolUse = toolUseMap.get(toolResult.tool_use_id);
        if (toolUse) {
          // This is a tool result - create a combined entry
          display.push({
            index: display.length,
            uuid: msg.uuid,
            type: 'tool',
            toolName: toolUse.name,
            preview: formatToolPreview(toolUse.name, toolUse.input),
            size: getMessageSize(msg),
            rawIndex: idx,
            relatedRawIndexes: [toolUse.rawIndex, idx],
          });
          processedToolResults.add(idx);
          return;
        }
      }
      // Regular user message (not tool result)
      const textContent = content.find(b => b.type !== 'tool_result');
      if (textContent || content.length === 0) {
        display.push({
          index: display.length,
          uuid: msg.uuid,
          type: 'user',
          preview: getPreview(msg),
          size: getMessageSize(msg),
          rawIndex: idx,
        });
      }
      return;
    }

    // Assistant message
    if (msg.type === 'assistant' && msg.message?.content) {
      const content = msg.message.content as ContentBlock[];
      if (Array.isArray(content)) {
        // Check for thinking
        const thinking = content.find(b => b.type === 'thinking');
        if (thinking) {
          display.push({
            index: display.length,
            uuid: msg.uuid,
            type: 'thinking',
            preview: '[thinking]',
            size: thinking.thinking?.length || 0,
            rawIndex: idx,
          });
          return;
        }

        // Check for text (not tool_use which we handle via tool_result)
        const textBlock = content.find(b => b.type === 'text');
        if (textBlock && textBlock.text) {
          display.push({
            index: display.length,
            uuid: msg.uuid,
            type: 'assistant',
            preview: textBlock.text.slice(0, 40) + (textBlock.text.length > 40 ? '...' : ''),
            size: getMessageSize(msg),
            rawIndex: idx,
          });
          return;
        }

        // Skip pure tool_use messages (they'll be shown with tool_result)
        const hasOnlyToolUse = content.every(b => b.type === 'tool_use');
        if (hasOnlyToolUse) {
          return;
        }
      }
    }

    // User message (plain text)
    if (msg.type === 'user' && msg.message?.content && typeof msg.message.content === 'string') {
      display.push({
        index: display.length,
        uuid: msg.uuid,
        type: 'user',
        preview: msg.message.content.slice(0, 40) + (msg.message.content.length > 40 ? '...' : ''),
        size: getMessageSize(msg),
        rawIndex: idx,
      });
    }
  });

  return display;
}

function formatToolPreview(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return name;
  const inp = input as Record<string, unknown>;

  switch (name) {
    case 'Read':
      return inp.file_path ? `${(inp.file_path as string).split(/[/\\]/).pop()}` : name;
    case 'Bash':
      const cmd = (inp.command as string) || '';
      return cmd.slice(0, 30) + (cmd.length > 30 ? '...' : '');
    case 'Grep':
      return `"${inp.pattern}"`;
    case 'Glob':
      return `${inp.pattern}`;
    case 'Edit':
    case 'Write':
      return inp.file_path ? `${(inp.file_path as string).split(/[/\\]/).pop()}` : name;
    case 'Task':
      return `${inp.subagent_type}: ${((inp.description as string) || '').slice(0, 20)}`;
    default:
      return name;
  }
}

// Re-export formatSize from shared utils
export { formatSize } from '../../utils/compact.js';

/**
 * Apply compact to a message
 */
export function compactMessage(msg: RawMessage, maxLen = DEFAULT_MAX_OUTPUT): RawMessage {
  const result = JSON.parse(JSON.stringify(msg)) as RawMessage;

  if (result.message?.content && Array.isArray(result.message.content)) {
    for (const block of result.message.content as ContentBlock[]) {
      if (block.type === 'tool_result' && typeof block.content === 'string' && block.content.length > maxLen) {
        block.content = truncateContent(block.content, maxLen);
      }
      if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.length > maxLen) {
        block.thinking = truncateContent(block.thinking, maxLen);
      }
    }
  }

  if (result.toolUseResult) {
    const tur = result.toolUseResult as Record<string, unknown>;

    // Bash stdout/stderr
    if (typeof tur.stdout === 'string' && tur.stdout.length > maxLen) {
      tur.stdout = truncateContent(tur.stdout, maxLen);
    }
    if (typeof tur.stderr === 'string' && tur.stderr.length > maxLen) {
      tur.stderr = truncateContent(tur.stderr, maxLen);
    }

    // Read file content
    if (tur.file && typeof (tur.file as Record<string, unknown>).content === 'string') {
      const file = tur.file as Record<string, unknown>;
      if ((file.content as string).length > maxLen) {
        file.content = truncateContent(file.content as string, maxLen);
      }
    }

    // Edit tool - originalFile, oldString, newString, structuredPatch
    if (typeof tur.originalFile === 'string' && tur.originalFile.length > maxLen) {
      tur.originalFile = truncateContent(tur.originalFile, maxLen);
    }
    if (typeof tur.oldString === 'string' && tur.oldString.length > maxLen) {
      tur.oldString = truncateContent(tur.oldString, maxLen);
    }
    if (typeof tur.newString === 'string' && tur.newString.length > maxLen) {
      tur.newString = truncateContent(tur.newString, maxLen);
    }
    if (typeof tur.structuredPatch === 'string' && tur.structuredPatch.length > maxLen) {
      tur.structuredPatch = truncateContent(tur.structuredPatch, maxLen);
    }

    // Write tool - content
    if (typeof tur.content === 'string' && tur.content.length > maxLen) {
      tur.content = truncateContent(tur.content, maxLen);
    }
  }

  return result;
}

/**
 * Build a map of tool_use_id -> index for all tool_use blocks
 * and a map of tool_use_id -> index for all tool_result blocks
 */
function buildToolMaps(messages: RawMessage[]): {
  toolUseMap: Map<string, number>;      // tool_use_id -> message index containing tool_use
  toolResultMap: Map<string, number>;   // tool_use_id -> message index containing tool_result
} {
  const toolUseMap = new Map<string, number>();
  const toolResultMap = new Map<string, number>();

  messages.forEach((msg, idx) => {
    if (!msg.message?.content || !Array.isArray(msg.message.content)) return;

    for (const block of msg.message.content as ContentBlock[]) {
      // tool_use blocks have id and name
      if (block.type === 'tool_use' && block.id) {
        toolUseMap.set(block.id, idx);
      }
      // tool_result blocks have tool_use_id
      if (block.type === 'tool_result' && block.tool_use_id) {
        toolResultMap.set(block.tool_use_id, idx);
      }
    }
  });

  return { toolUseMap, toolResultMap };
}

/**
 * Expand indexesToRemove to include paired tool_use/tool_result messages.
 * If a tool_use is removed, its tool_result must also be removed.
 * If a tool_result is removed, its tool_use must also be removed.
 */
function expandToolPairs(messages: RawMessage[], indexesToRemove: Set<number>): Set<number> {
  const { toolUseMap, toolResultMap } = buildToolMaps(messages);
  const expanded = new Set(indexesToRemove);

  // For each removed index, check if it contains tool_use or tool_result blocks
  for (const idx of indexesToRemove) {
    const msg = messages[idx];
    if (!msg.message?.content || !Array.isArray(msg.message.content)) continue;

    for (const block of msg.message.content as ContentBlock[]) {
      if (block.type === 'tool_use' && block.id) {
        // Find and remove the corresponding tool_result
        const resultIdx = toolResultMap.get(block.id);
        if (resultIdx !== undefined) {
          expanded.add(resultIdx);
        }
      }
      if (block.type === 'tool_result' && block.tool_use_id) {
        // Find and remove the corresponding tool_use
        const useIdx = toolUseMap.get(block.tool_use_id);
        if (useIdx !== undefined) {
          expanded.add(useIdx);
        }
      }
    }
  }

  return expanded;
}

/**
 * Validate that after removal, all remaining tool_result blocks have their
 * corresponding tool_use blocks in the correct position.
 * Returns a list of additional indexes that need to be removed to maintain validity.
 */
function validateToolPairing(messages: RawMessage[], indexesToRemove: Set<number>): Set<number> {
  const remaining = messages.filter((_, i) => !indexesToRemove.has(i));
  const { toolUseMap, toolResultMap } = buildToolMaps(remaining);
  const additionalRemoves = new Set<number>();

  // Check each tool_result has a matching tool_use
  for (const [toolUseId, resultIdx] of toolResultMap) {
    const useIdx = toolUseMap.get(toolUseId);
    if (useIdx === undefined) {
      // tool_use was removed but tool_result wasn't - find original index
      const originalIdx = messages.findIndex((msg, i) => {
        if (indexesToRemove.has(i)) return false;
        if (!msg.message?.content || !Array.isArray(msg.message.content)) return false;
        return (msg.message.content as ContentBlock[]).some(
          b => b.type === 'tool_result' && b.tool_use_id === toolUseId
        );
      });
      if (originalIdx >= 0) {
        additionalRemoves.add(originalIdx);
      }
    }
  }

  // Check each tool_use has a matching tool_result
  for (const [toolUseId, useIdx] of toolUseMap) {
    const resultIdx = toolResultMap.get(toolUseId);
    if (resultIdx === undefined) {
      // tool_result was removed but tool_use wasn't - find original index
      const originalIdx = messages.findIndex((msg, i) => {
        if (indexesToRemove.has(i)) return false;
        if (!msg.message?.content || !Array.isArray(msg.message.content)) return false;
        return (msg.message.content as ContentBlock[]).some(
          b => b.type === 'tool_use' && b.id === toolUseId
        );
      });
      if (originalIdx >= 0) {
        additionalRemoves.add(originalIdx);
      }
    }
  }

  return additionalRemoves;
}

/**
 * Remove messages and fix parentUuid chain.
 * Also ensures tool_use/tool_result pairs are kept together.
 */
export function removeMessages(messages: RawMessage[], indexesToRemove: Set<number>): RawMessage[] {
  // First expand the removal set to include paired tool_use/tool_result
  let toRemove = expandToolPairs(messages, indexesToRemove);

  // Validate and expand until stable
  let prevSize = 0;
  while (toRemove.size !== prevSize) {
    prevSize = toRemove.size;
    const additional = validateToolPairing(messages, toRemove);
    for (const idx of additional) {
      toRemove.add(idx);
    }
    toRemove = expandToolPairs(messages, toRemove);
  }

  const result: RawMessage[] = [];
  const uuidMap = new Map<string, string>(); // old uuid -> new parent uuid

  for (let i = 0; i < messages.length; i++) {
    if (toRemove.has(i)) {
      // Map this uuid to its parent for chain fixing
      const msg = messages[i];
      if (msg.uuid && msg.parentUuid !== undefined) {
        uuidMap.set(msg.uuid, msg.parentUuid || '');
      }
      continue;
    }

    const msg = { ...messages[i] };

    // Fix parentUuid if it points to a removed message
    if (msg.parentUuid) {
      let newParent = msg.parentUuid;
      while (uuidMap.has(newParent)) {
        newParent = uuidMap.get(newParent)!;
      }
      msg.parentUuid = newParent || null;
    }

    result.push(msg);
  }

  return result;
}
