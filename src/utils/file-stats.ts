/**
 * Analyze file access patterns from conversation history
 * to determine which files are most important for context
 */

import * as fs from 'fs';
import * as path from 'path';

interface FileAccess {
  path: string;
  reads: number;
  writes: number;
  edits: number;
  lineRanges: Array<{ start: number; end: number }>;
  lastAccess: number;
}

export interface FileToRead {
  path: string;
  ranges: Array<{ start: number; end: number }> | null;
  bytes: number;
}

export interface ConversationMessage {
  type: string;
  message?: {
    content?: unknown;
  };
}

const MERGE_GAP = 5; // Merge ranges within 5 lines of each other

/**
 * Merge overlapping or close line ranges
 */
function mergeRanges(ranges: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (sorted[i].start <= last.end + MERGE_GAP) {
      last.end = Math.max(last.end, sorted[i].end);
    } else {
      merged.push(sorted[i]);
    }
  }
  return merged;
}

/**
 * Check if a file path is a debug/test file that should be skipped
 */
function isDebugFile(filePath: string): boolean {
  return filePath.includes('/scripts/') || filePath.includes('\\scripts\\') ||
         filePath.includes('/__tests__/') || filePath.includes('\\__tests__\\') ||
         filePath.includes('/test/') || filePath.includes('\\test\\') ||
         filePath.includes('.test.') || filePath.includes('.spec.');
}

/**
 * Extract file access patterns from conversation messages
 */
export function extractFileStats(messages: ConversationMessage[]): Map<string, FileAccess> {
  const fileStats = new Map<string, FileAccess>();

  function getOrCreate(filePath: string): FileAccess {
    if (!fileStats.has(filePath)) {
      fileStats.set(filePath, {
        path: filePath,
        reads: 0,
        writes: 0,
        edits: 0,
        lineRanges: [],
        lastAccess: 0,
      });
    }
    return fileStats.get(filePath)!;
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.type !== 'assistant') continue;

    const content = msg.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content as Record<string, unknown>[]) {
      if (block.type !== 'tool_use') continue;

      const input = block.input as Record<string, unknown> | undefined;
      if (!input) continue;

      const filePath = (input.file_path || input.path) as string | undefined;
      if (!filePath) continue;

      const stats = getOrCreate(filePath);
      stats.lastAccess = i;

      switch (block.name) {
        case 'Read':
          stats.reads++;
          if (input.offset && input.limit) {
            stats.lineRanges.push({
              start: input.offset as number,
              end: (input.offset as number) + (input.limit as number),
            });
          }
          break;
        case 'Write':
          stats.writes++;
          break;
        case 'Edit':
          stats.edits++;
          break;
      }
    }
  }

  return fileStats;
}

/**
 * Get the most important files to read for context
 */
export function getImportantFiles(
  messages: ConversationMessage[],
  options: {
    maxBytes?: number;
    maxFiles?: number;
  } = {}
): FileToRead[] {
  const { maxBytes = 100000, maxFiles = 10 } = options;

  const fileStats = extractFileStats(messages);
  const totalMessages = messages.length;

  // Sort by importance: edits > writes > reads, weighted by recency
  const sorted = Array.from(fileStats.values()).sort((a, b) => {
    const scoreA = (a.edits * 10 + a.writes * 5 + a.reads) * (1 + a.lastAccess / totalMessages);
    const scoreB = (b.edits * 10 + b.writes * 5 + b.reads) * (1 + b.lastAccess / totalMessages);
    return scoreB - scoreA;
  });

  const filesToRead: FileToRead[] = [];
  let totalBytes = 0;

  for (const f of sorted) {
    if (filesToRead.length >= maxFiles) break;

    // Skip debug/test files
    if (isDebugFile(f.path)) continue;

    // Check if file exists and is not a directory
    let fileSize = 0;
    let exists = false;
    try {
      const stat = fs.statSync(f.path);
      if (stat.isDirectory()) continue;
      fileSize = stat.size;
      exists = true;
    } catch {
      continue;
    }

    // Merge line ranges
    const mergedRanges = mergeRanges(f.lineRanges);

    // Estimate bytes to read
    let bytesToRead: number;
    if (mergedRanges.length > 0) {
      // Estimate ~80 bytes per line for ranges
      bytesToRead = mergedRanges.reduce((sum, r) => sum + (r.end - r.start) * 80, 0);
    } else {
      bytesToRead = fileSize;
    }

    // Check if we have room
    if (totalBytes + bytesToRead > maxBytes) continue;

    totalBytes += bytesToRead;
    filesToRead.push({
      path: f.path,
      ranges: mergedRanges.length > 0 ? mergedRanges : null,
      bytes: bytesToRead,
    });
  }

  return filesToRead;
}

/**
 * Read file content, optionally with line ranges
 */
export function readFileContent(file: FileToRead): string {
  const content = fs.readFileSync(file.path, 'utf-8');

  if (!file.ranges) {
    return content;
  }

  // Extract specific line ranges
  const lines = content.split('\n');
  const parts: string[] = [];

  for (const range of file.ranges) {
    const start = Math.max(0, range.start - 1); // 1-based to 0-based
    const end = Math.min(lines.length, range.end);
    parts.push(`// Lines ${range.start}-${range.end}:`);
    parts.push(lines.slice(start, end).join('\n'));
  }

  return parts.join('\n\n');
}
