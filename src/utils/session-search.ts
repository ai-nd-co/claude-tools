/**
 * Shared session search utilities for resume and fork commands
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface SessionInfo {
  sessionId: string;
  filePath: string;
  projectName: string;
  timestamp: string;
  size: number;
  messageCount: number;
  preview: string;
  searchableContent?: string;
}

/**
 * Normalize text for consistent searching:
 * - Collapse multiple whitespace/newlines to single space
 * - Trim leading/trailing whitespace
 * - Remove common markdown formatting noise
 * - Normalize unicode whitespace characters
 */
export function normalizeText(text: string): string {
  return text
    // Normalize unicode whitespace (non-breaking spaces, etc.)
    .replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000]/g, ' ')
    // Remove markdown code fence markers (but keep code content)
    .replace(/```\w*\n?/g, ' ')
    // Remove markdown bold/italic markers
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1')
    .replace(/_{1,2}([^_]+)_{1,2}/g, '$1')
    // Remove markdown headers (keep text)
    .replace(/^#{1,6}\s+/gm, '')
    // Replace newlines and tabs with spaces
    .replace(/[\r\n\t]+/g, ' ')
    // Collapse multiple spaces to single space (do this last!)
    .replace(/\s{2,}/g, ' ')
    // Trim
    .trim();
}

/**
 * Get info from a JSONL session file
 */
export function getSessionInfo(filePath: string, projectName: string): SessionInfo | null {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.trim().split('\n').filter(l => l.trim());

    if (lines.length === 0) return null;

    let sessionId = '';
    let timestamp = '';
    let preview = '';
    const searchableContent: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      try {
        const parsed = JSON.parse(lines[i]);

        if (!sessionId && parsed.sessionId) {
          sessionId = parsed.sessionId;
        }
        if (!timestamp && parsed.timestamp) {
          timestamp = parsed.timestamp;
        }

        // Collect all text content for searching
        if (parsed.type === 'user' && parsed.message?.content) {
          const msgContent = parsed.message.content;
          if (typeof msgContent === 'string') {
            searchableContent.push(msgContent);
            if (!preview) {
              preview = msgContent.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
            }
          } else if (Array.isArray(msgContent)) {
            for (const block of msgContent) {
              // Extract text blocks (user questions)
              if (block.type === 'text' && block.text) {
                searchableContent.push(block.text);
                if (!preview) {
                  preview = block.text.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
                }
              }
              // Extract tool_result content (string or array)
              if (block.type === 'tool_result') {
                if (typeof block.content === 'string') {
                  searchableContent.push(block.content);
                } else if (Array.isArray(block.content)) {
                  for (const inner of block.content) {
                    if (inner.type === 'text' && inner.text) {
                      searchableContent.push(inner.text);
                    }
                  }
                }
              }
            }
          }
        }
        if (parsed.type === 'assistant' && parsed.message?.content) {
          const msgContent = parsed.message.content;
          if (Array.isArray(msgContent)) {
            for (const block of msgContent) {
              if (block.type === 'text' && block.text) {
                searchableContent.push(block.text);
              }
              if (block.type === 'tool_use' && block.input) {
                const input = block.input;
                // Extract all string values from tool input for comprehensive search
                for (const value of Object.values(input)) {
                  if (typeof value === 'string') {
                    searchableContent.push(value);
                  }
                }
              }
            }
          }
        }
        // Summary messages (from context compaction)
        if (parsed.type === 'summary' && parsed.summary) {
          searchableContent.push(parsed.summary);
        }
        if (parsed.toolUseResult) {
          if (parsed.toolUseResult.stdout) searchableContent.push(parsed.toolUseResult.stdout);
          if (parsed.toolUseResult.stderr) searchableContent.push(parsed.toolUseResult.stderr);
          if (parsed.toolUseResult.file?.content) searchableContent.push(parsed.toolUseResult.file.content);
          if (typeof parsed.toolUseResult.content === 'string') searchableContent.push(parsed.toolUseResult.content);
        }
      } catch {
        // Skip invalid JSON
      }
    }

    if (!sessionId) return null;

    const stat = fs.statSync(filePath);

    return {
      sessionId,
      filePath,
      projectName,
      timestamp: timestamp || stat.mtime.toISOString(),
      size: stat.size,
      messageCount: lines.length,
      preview: preview || '[No preview]',
      searchableContent: normalizeText(searchableContent.join(' ')),
    };
  } catch {
    return null;
  }
}

/**
 * Load all sessions from Claude projects directory
 */
export function loadAllSessions(): SessionInfo[] {
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');

  if (!fs.existsSync(claudeDir)) {
    return [];
  }

  const projects = fs.readdirSync(claudeDir).filter(f =>
    fs.statSync(path.join(claudeDir, f)).isDirectory()
  );

  const sessions: SessionInfo[] = [];

  for (const project of projects) {
    const projectDir = path.join(claudeDir, project);
    const jsonlFiles = fs.readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-') && !f.includes('.backup'));

    for (const f of jsonlFiles) {
      const filePath = path.join(projectDir, f);
      const info = getSessionInfo(filePath, project);
      if (info) {
        sessions.push(info);
      }
    }
  }

  // Sort by timestamp (most recent first)
  sessions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  return sessions;
}

/**
 * Format relative time
 */
export function formatRelativeTime(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

/**
 * Match session against grep-style OR pattern
 * Pattern: "word1|word2|word3" matches if ANY word is found (case-insensitive)
 * Multiple words without | are treated as AND
 */
export function matchesPattern(session: SessionInfo, pattern: string): boolean {
  // Normalize and lowercase the search text for consistent matching
  const searchText = normalizeText([
    session.preview,
    session.projectName,
    session.sessionId,
    session.searchableContent || '',
  ].join(' ')).toLowerCase();

  // Normalize the search pattern too
  const normalizedPattern = normalizeText(pattern);

  // Split by | for OR groups
  const orGroups = normalizedPattern.split('|').map(g => g.trim()).filter(g => g);

  if (orGroups.length === 0) return true;

  // Each OR group can have multiple AND terms (space-separated)
  // Match if ANY OR group matches entirely
  for (const group of orGroups) {
    const andTerms = group.toLowerCase().split(/\s+/).filter(t => t);
    const allMatch = andTerms.every(term => searchText.includes(term));
    if (allMatch) return true;
  }

  return false;
}

/**
 * Get which pattern terms matched (for highlighting)
 */
export function getMatchedTerms(session: SessionInfo, pattern: string): string[] {
  const searchText = normalizeText([
    session.preview,
    session.projectName,
    session.sessionId,
    session.searchableContent || '',
  ].join(' ')).toLowerCase();

  const normalizedPattern = normalizeText(pattern);
  const allTerms = normalizedPattern.split(/[|\s]+/).map(t => t.trim().toLowerCase()).filter(t => t);
  return allTerms.filter(term => searchText.includes(term));
}
