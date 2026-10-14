// Shared compaction utilities

import { gzipSync } from 'zlib';

export const DEFAULT_MAX_OUTPUT = 200; // chars to keep (100 before + 100 after)
export const DEFAULT_MAX_THINKING = 200;
export const SIMILARITY_THRESHOLD = 0.13; // NCD threshold: 0 = identical, <0.13 = very similar

// Progressive truncation settings
export const PROGRESSIVE_TARGET_RATIO = 0.40; // Target 40% of original size
export const PROGRESSIVE_CUTOFF = 0.50; // Aggressive truncation for first 50% of bytes
export const PROGRESSIVE_PRESERVE = 0.80; // Preserve last 20% (80-100%) except bash
export const PROGRESSIVE_MIN_CHARS = 20; // Minimum chars at position 0%
export const PROGRESSIVE_MAX_CHARS = 200; // Maximum chars at position 50%

// Compaction marker
export const COMPACTED_MARKER = '...COMPACTED...';

/**
 * Truncate content to max length (keeps beginning and end)
 */
export function truncateContent(content: string, maxLen: number = DEFAULT_MAX_OUTPUT): string {
  if (content.length <= maxLen) return content;
  const keepEach = Math.max(10, Math.floor(maxLen / 2));
  const first = content.slice(0, keepEach);
  const last = content.slice(-keepEach);
  return `${first}\n\n${COMPACTED_MARKER}\n\n${last}`;
}

/**
 * Format size for display
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Normalized Compression Distance (NCD) using gzip
 * Returns 0-1: 0 = identical, 1 = completely different
 */
export function ncd(a: string, b: string): number {
  if (!a || !b) return 1;
  if (a === b) return 0;

  const ca = gzipSync(Buffer.from(a)).length;
  const cb = gzipSync(Buffer.from(b)).length;
  const cab = gzipSync(Buffer.from(a + b)).length;

  return (cab - Math.min(ca, cb)) / Math.max(ca, cb);
}

/**
 * Check if two strings are similar using NCD
 */
export function isSimilar(a: string, b: string, threshold: number = SIMILARITY_THRESHOLD): boolean {
  return ncd(a, b) < threshold;
}

/**
 * Marker for duplicate/similar content
 */
export const DUPLICATE_MARKER = '[Similar to previous result - content hidden]';

/**
 * Extract content string from a tool result message for similarity comparison
 */
export function extractToolContent(msg: Record<string, unknown>): string | null {
  // Check message.content for tool_result
  const msgContent = msg.message as Record<string, unknown> | undefined;
  if (msgContent?.content && Array.isArray(msgContent.content)) {
    for (const block of msgContent.content as Array<Record<string, unknown>>) {
      if (block.type === 'tool_result' && typeof block.content === 'string') {
        return block.content;
      }
    }
  }

  // Check toolUseResult
  const tur = msg.toolUseResult as Record<string, unknown> | undefined;
  if (tur) {
    if (typeof tur.stdout === 'string' && tur.stdout.length > 0) return tur.stdout;
    if (typeof tur.content === 'string' && tur.content.length > 0) return tur.content;
    if (tur.file && typeof (tur.file as Record<string, unknown>).content === 'string') {
      return (tur.file as Record<string, unknown>).content as string;
    }
  }

  return null;
}

export interface CompactResult {
  messages: Record<string, unknown>[];
  originalSize: number;
  compactedSize: number;
  stats: {
    truncated: number;
    deduplicated: number;
    total: number;
  };
}

/**
 * Compact an array of messages by truncating large outputs and deduplicating similar results
 */
export function compactMessages(
  messages: Record<string, unknown>[],
  options: { maxLen?: number; deduplicate?: boolean } = {}
): CompactResult {
  const maxLen = options.maxLen ?? DEFAULT_MAX_OUTPUT;
  const deduplicate = options.deduplicate ?? true;

  const originalSize = messages.reduce((sum, m) => sum + JSON.stringify(m).length, 0);
  const seenContents: string[] = [];
  let truncated = 0;
  let deduplicated = 0;

  const result = messages.map(msg => {
    const copy = JSON.parse(JSON.stringify(msg)) as Record<string, unknown>;
    let modified = false;

    // Extract content for deduplication check
    if (deduplicate) {
      const content = extractToolContent(copy);
      if (content && content.length > 100) {
        // Check against previous contents
        for (const seen of seenContents) {
          if (isSimilar(content, seen)) {
            // Replace with duplicate marker
            replaceMsgContent(copy, DUPLICATE_MARKER);
            deduplicated++;
            modified = true;
            break;
          }
        }
        if (!modified) {
          seenContents.push(content);
        }
      }
    }

    // Truncate if not deduplicated
    if (!modified) {
      if (truncateMsg(copy, maxLen)) {
        truncated++;
      }
    }

    return copy;
  });

  const compactedSize = result.reduce((sum, m) => sum + JSON.stringify(m).length, 0);

  return {
    messages: result,
    originalSize,
    compactedSize,
    stats: {
      truncated,
      deduplicated,
      total: messages.length,
    },
  };
}

/**
 * Check if a message is a Bash tool result
 */
function isBashResult(msg: Record<string, unknown>): boolean {
  const tur = msg.toolUseResult as Record<string, unknown> | undefined;
  return !!(tur && (tur.stdout !== undefined || tur.stderr !== undefined));
}

/**
 * Remove all thinking blocks from messages EXCEPT the last assistant message
 * (API requires latest thinking blocks to remain unchanged)
 */
export function removeThinkingBlocks(messages: Record<string, unknown>[]): { messages: Record<string, unknown>[]; removed: number } {
  let removed = 0;

  // Find the last assistant message index
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i] as any).type === 'assistant') {
      lastAssistantIdx = i;
      break;
    }
  }

  const result = messages.map((msg, idx) => {
    // Skip the last assistant message - can't modify its thinking blocks
    if (idx === lastAssistantIdx) {
      return msg;
    }

    const copy = JSON.parse(JSON.stringify(msg)) as Record<string, unknown>;
    const msgContent = copy.message as Record<string, unknown> | undefined;

    if (msgContent?.content && Array.isArray(msgContent.content)) {
      const content = msgContent.content as Array<Record<string, unknown>>;
      const filtered = content.filter(block => {
        if (block.type === 'thinking' || block.type === 'redacted_thinking') {
          removed++;
          return false;
        }
        return true;
      });

      if (filtered.length !== content.length) {
        msgContent.content = filtered;
      }
    }

    return copy;
  });

  return { messages: result, removed };
}

/**
 * Check if a Bash result indicates failure (non-zero exit code or error)
 */
function isBashFailure(msg: Record<string, unknown>): boolean {
  const tur = msg.toolUseResult as Record<string, unknown> | undefined;
  if (!tur) return false;

  // Check for error/interrupted flags
  if (tur.error || tur.interrupted) return true;

  // Check message content for tool_result with is_error
  const msgContent = msg.message as Record<string, unknown> | undefined;
  if (msgContent?.content && Array.isArray(msgContent.content)) {
    for (const block of msgContent.content as Array<Record<string, unknown>>) {
      if (block.type === 'tool_result' && block.is_error) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Remove failed bash commands that were followed by another bash command (retry pattern).
 * Returns indexes of messages to remove.
 */
export function findFailedBashRetries(messages: Record<string, unknown>[]): Set<number> {
  const toRemove = new Set<number>();

  for (let i = 0; i < messages.length - 2; i++) {
    const msg = messages[i];

    // Check if this is a failed bash result
    if (!isBashResult(msg) || !isBashFailure(msg)) continue;

    // Look for the corresponding tool_use (should be 1-2 messages before)
    let toolUseIdx = -1;
    for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
      const prevMsg = messages[j];
      const content = (prevMsg.message as Record<string, unknown>)?.content;
      if (Array.isArray(content)) {
        for (const block of content as Array<Record<string, unknown>>) {
          if (block.type === 'tool_use' && block.name === 'Bash') {
            toolUseIdx = j;
            break;
          }
        }
      }
      if (toolUseIdx >= 0) break;
    }

    if (toolUseIdx < 0) continue;

    // Check if followed by another bash command (within next 5 messages)
    for (let k = i + 1; k < Math.min(messages.length, i + 6); k++) {
      const nextMsg = messages[k];
      const content = (nextMsg.message as Record<string, unknown>)?.content;
      if (Array.isArray(content)) {
        for (const block of content as Array<Record<string, unknown>>) {
          if (block.type === 'tool_use' && block.name === 'Bash') {
            // Found a retry - mark the failed pair for removal
            toRemove.add(toolUseIdx);
            toRemove.add(i);
            break;
          }
        }
      }
      if (toRemove.has(i)) break;
    }
  }

  return toRemove;
}

/**
 * Compact messages in a specific range (by percentage of total messages).
 * Optionally filter by tool type.
 */
export function compactMessagesInRange(
  messages: Record<string, unknown>[],
  options: {
    startPercent?: number;  // 0-100, default 0
    endPercent?: number;    // 0-100, default 100
    maxLen?: number;
    toolFilter?: 'bash' | 'all';  // Only compact specific tool types
  } = {}
): CompactResult {
  const startPercent = options.startPercent ?? 0;
  const endPercent = options.endPercent ?? 100;
  const maxLen = options.maxLen ?? DEFAULT_MAX_OUTPUT;
  const toolFilter = options.toolFilter ?? 'all';

  const startIdx = Math.floor(messages.length * startPercent / 100);
  const endIdx = Math.floor(messages.length * endPercent / 100);

  const originalSize = messages.reduce((sum, m) => sum + JSON.stringify(m).length, 0);
  let truncated = 0;

  const result = messages.map((msg, idx) => {
    // Only process messages in the specified range
    if (idx < startIdx || idx >= endIdx) {
      return msg;
    }

    // Filter by tool type
    if (toolFilter === 'bash' && !isBashResult(msg)) {
      return msg;
    }

    const copy = JSON.parse(JSON.stringify(msg)) as Record<string, unknown>;
    if (truncateMsg(copy, maxLen)) {
      truncated++;
    }
    return copy;
  });

  const compactedSize = result.reduce((sum, m) => sum + JSON.stringify(m).length, 0);

  return {
    messages: result,
    originalSize,
    compactedSize,
    stats: {
      truncated,
      deduplicated: 0,
      total: messages.length,
    },
  };
}

/**
 * Calculate maxLen for a message based on its byte position (0-1).
 * Position 0 = start of conversation (most aggressive truncation)
 * Position 0.5 = middle (normal truncation)
 * Position > 0.5 = no truncation (preserve)
 */
export function getProgressiveMaxLen(bytePosition: number): number {
  if (bytePosition >= PROGRESSIVE_CUTOFF) {
    return Infinity; // No truncation after cutoff
  }
  // Linear interpolation from MIN at 0% to MAX at 50%
  const ratio = bytePosition / PROGRESSIVE_CUTOFF;
  return Math.round(PROGRESSIVE_MIN_CHARS + ratio * (PROGRESSIVE_MAX_CHARS - PROGRESSIVE_MIN_CHARS));
}

/**
 * Progressive compaction: truncate messages more aggressively at the start,
 * preserve messages after 80% of total bytes. Goal is to reduce total size to ~40%.
 *
 * Zones (by byte position):
 *   0-50%:   Aggressive truncation (minChars → maxChars gradient)
 *   50-80%:  Moderate truncation (maxChars)
 *   80-100%: Preserved (no truncation) EXCEPT bash output
 *
 * Uses BYTE POSITION (cumulative content size) not message index.
 * This means large messages early in the conversation get truncated more
 * aggressively, while small messages don't waste the truncation budget.
 */
export function compactMessagesProgressive(
  messages: Record<string, unknown>[],
  options: {
    targetRatio?: number;  // Target size ratio (default 0.40 = 40%)
    cutoffPercent?: number; // Aggressive zone ends at this % (default 50)
    preservePercent?: number; // Preserve after this % except bash (default 80)
    minChars?: number;     // Min chars at byte position 0 (default 20)
    maxChars?: number;     // Max chars at byte cutoff (default 200)
  } = {}
): CompactResult {
  const targetRatio = options.targetRatio ?? PROGRESSIVE_TARGET_RATIO;
  const cutoff = (options.cutoffPercent ?? (PROGRESSIVE_CUTOFF * 100)) / 100;
  const preserve = (options.preservePercent ?? (PROGRESSIVE_PRESERVE * 100)) / 100;
  const minChars = options.minChars ?? PROGRESSIVE_MIN_CHARS;
  const maxChars = options.maxChars ?? PROGRESSIVE_MAX_CHARS;

  // Calculate message sizes and cumulative byte positions
  const messageSizes = messages.map(m => JSON.stringify(m).length);
  const originalSize = messageSizes.reduce((sum, s) => sum + s, 0);
  const targetSize = originalSize * targetRatio;
  const cutoffBytes = originalSize * cutoff;
  const preserveBytes = originalSize * preserve;

  // Build cumulative size array (byte position at END of each message)
  const cumulativeSizes: number[] = [];
  let cumulative = 0;
  for (const size of messageSizes) {
    cumulative += size;
    cumulativeSizes.push(cumulative);
  }

  // Find which messages are in which zone and calculate bytes
  let bytesInAggressiveZone = 0;
  let bytesInModerateZone = 0;
  let bytesInPreserveZone = 0;
  for (let i = 0; i < messages.length; i++) {
    const bytePositionStart = i > 0 ? cumulativeSizes[i - 1] : 0;
    if (bytePositionStart < cutoffBytes) {
      bytesInAggressiveZone += messageSizes[i];
    } else if (bytePositionStart < preserveBytes) {
      bytesInModerateZone += messageSizes[i];
    } else {
      bytesInPreserveZone += messageSizes[i];
    }
  }

  // Calculate how aggressive we need to be
  // We can only reduce the aggressive and moderate zones
  const targetReductionZoneSize = Math.max(0, targetSize - bytesInPreserveZone);
  const currentReductionZoneSize = bytesInAggressiveZone + bytesInModerateZone;
  let scaleFactor = 1.0;
  if (currentReductionZoneSize > 0 && targetReductionZoneSize < currentReductionZoneSize) {
    scaleFactor = Math.max(0.1, targetReductionZoneSize / currentReductionZoneSize);
  }

  let truncated = 0;

  const result = messages.map((msg, idx) => {
    // Calculate byte position at the START of this message (0-1 scale)
    const bytePositionStart = idx > 0 ? cumulativeSizes[idx - 1] : 0;
    const bytePosition = bytePositionStart / originalSize;

    // Check if this is a bash result
    const isBash = isBashResult(msg);

    // Preserve zone (80-100%): no truncation except bash
    if (bytePosition >= preserve) {
      if (isBash) {
        // Still truncate bash output even in preserve zone
        const copy = JSON.parse(JSON.stringify(msg)) as Record<string, unknown>;
        if (truncateMsg(copy, maxChars)) {
          truncated++;
        }
        return copy;
      }
      return msg;
    }

    // Moderate zone (50-80%): use maxChars
    if (bytePosition >= cutoff) {
      const copy = JSON.parse(JSON.stringify(msg)) as Record<string, unknown>;
      const maxLen = Math.max(minChars, Math.round(maxChars * scaleFactor));
      if (truncateMsg(copy, maxLen)) {
        truncated++;
      }
      return copy;
    }

    // Aggressive zone (0-50%): gradient from minChars to maxChars
    const ratio = bytePosition / cutoff;
    const baseMaxLen = minChars + ratio * (maxChars - minChars);
    const maxLen = Math.max(minChars, Math.round(baseMaxLen * scaleFactor));

    const copy = JSON.parse(JSON.stringify(msg)) as Record<string, unknown>;
    if (truncateMsg(copy, maxLen)) {
      truncated++;
    }
    return copy;
  });

  const compactedSize = result.reduce((sum, m) => sum + JSON.stringify(m).length, 0);

  return {
    messages: result,
    originalSize,
    compactedSize,
    stats: {
      truncated,
      deduplicated: 0,
      total: messages.length,
    },
  };
}

/**
 * Replace all content in a message with a marker
 */
function replaceMsgContent(msg: Record<string, unknown>, marker: string): void {
  const msgContent = msg.message as Record<string, unknown> | undefined;
  if (msgContent?.content && Array.isArray(msgContent.content)) {
    for (const block of msgContent.content as Array<Record<string, unknown>>) {
      if (block.type === 'tool_result' && typeof block.content === 'string') {
        block.content = marker;
      }
    }
  }

  const tur = msg.toolUseResult as Record<string, unknown> | undefined;
  if (tur) {
    if (typeof tur.stdout === 'string') tur.stdout = marker;
    if (typeof tur.stderr === 'string' && tur.stderr.length > 0) tur.stderr = marker;
    if (typeof tur.content === 'string') tur.content = marker;
    if (tur.file && typeof (tur.file as Record<string, unknown>).content === 'string') {
      (tur.file as Record<string, unknown>).content = marker;
    }
    if (typeof tur.originalFile === 'string') tur.originalFile = marker;
    if (typeof tur.oldString === 'string') tur.oldString = marker;
    if (typeof tur.newString === 'string') tur.newString = marker;
    if (typeof tur.structuredPatch === 'string') tur.structuredPatch = marker;
  }
}

/**
 * Truncate large content in a message, returns true if anything was truncated
 */
function truncateMsg(msg: Record<string, unknown>, maxLen: number): boolean {
  let modified = false;

  const msgContent = msg.message as Record<string, unknown> | undefined;
  if (msgContent?.content && Array.isArray(msgContent.content)) {
    for (const block of msgContent.content as Array<Record<string, unknown>>) {
      // Tool results
      if (block.type === 'tool_result' && typeof block.content === 'string' && block.content.length > maxLen) {
        block.content = truncateContent(block.content, maxLen);
        modified = true;
      }
      // Thinking blocks
      if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.length > maxLen) {
        block.thinking = truncateContent(block.thinking, maxLen);
        modified = true;
      }
      // Tool use inputs (the actual tool call)
      if (block.type === 'tool_use' && block.input && typeof block.input === 'object') {
        const input = block.input as Record<string, unknown>;
        // Bash command
        if (typeof input.command === 'string' && input.command.length > maxLen) {
          input.command = truncateContent(input.command, maxLen);
          modified = true;
        }
        // Write content
        if (typeof input.content === 'string' && input.content.length > maxLen) {
          input.content = truncateContent(input.content, maxLen);
          modified = true;
        }
        // Edit old_string / new_string
        if (typeof input.old_string === 'string' && input.old_string.length > maxLen) {
          input.old_string = truncateContent(input.old_string, maxLen);
          modified = true;
        }
        if (typeof input.new_string === 'string' && input.new_string.length > maxLen) {
          input.new_string = truncateContent(input.new_string, maxLen);
          modified = true;
        }
        // Task prompt
        if (typeof input.prompt === 'string' && input.prompt.length > maxLen) {
          input.prompt = truncateContent(input.prompt, maxLen);
          modified = true;
        }
      }
    }
  }

  const tur = msg.toolUseResult as Record<string, unknown> | undefined;
  if (tur) {
    if (typeof tur.stdout === 'string' && tur.stdout.length > maxLen) {
      tur.stdout = truncateContent(tur.stdout, maxLen);
      modified = true;
    }
    if (typeof tur.stderr === 'string' && tur.stderr.length > maxLen) {
      tur.stderr = truncateContent(tur.stderr, maxLen);
      modified = true;
    }
    if (tur.file && typeof (tur.file as Record<string, unknown>).content === 'string') {
      const file = tur.file as Record<string, unknown>;
      if ((file.content as string).length > maxLen) {
        file.content = truncateContent(file.content as string, maxLen);
        modified = true;
      }
    }
    if (typeof tur.originalFile === 'string' && tur.originalFile.length > maxLen) {
      tur.originalFile = truncateContent(tur.originalFile, maxLen);
      modified = true;
    }
    if (typeof tur.oldString === 'string' && tur.oldString.length > maxLen) {
      tur.oldString = truncateContent(tur.oldString, maxLen);
      modified = true;
    }
    if (typeof tur.newString === 'string' && tur.newString.length > maxLen) {
      tur.newString = truncateContent(tur.newString, maxLen);
      modified = true;
    }
    if (typeof tur.structuredPatch === 'string' && tur.structuredPatch.length > maxLen) {
      tur.structuredPatch = truncateContent(tur.structuredPatch, maxLen);
      modified = true;
    }
    if (typeof tur.content === 'string' && tur.content.length > maxLen) {
      tur.content = truncateContent(tur.content, maxLen);
      modified = true;
    }
  }

  return modified;
}
