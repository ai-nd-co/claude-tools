// Shared session utilities for finding and loading Claude sessions

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';

/**
 * Find session file path by session ID
 */
export function findSessionFileById(sessionId: string): string | null {
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');

  if (!fs.existsSync(claudeDir)) {
    return null;
  }

  const projects = fs.readdirSync(claudeDir).filter(f =>
    fs.statSync(path.join(claudeDir, f)).isDirectory()
  );

  for (const project of projects) {
    const filePath = path.join(claudeDir, project, `${sessionId}.jsonl`);
    if (fs.existsSync(filePath)) {
      return filePath;
    }
  }

  return null;
}

/**
 * Get the last line's timestamp and sessionId from a JSONL file
 */
function getLastLineInfo(filePath: string): { sessionId: string; timestamp: string } | null {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.trim().split('\n');

    // Check last few lines (some might be metadata)
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
      try {
        const parsed = JSON.parse(lines[i]);
        if (parsed.sessionId && parsed.timestamp) {
          return { sessionId: parsed.sessionId, timestamp: parsed.timestamp };
        }
      } catch {
        // Skip invalid JSON
      }
    }
  } catch {
    // File read error
  }
  return null;
}

/**
 * Search for marker in a file and return the timestamp when it was found
 */
function findMarkerInFile(filePath: string, marker: string): { sessionId: string; timestamp: string } | null {
  try {
    const content = fs.readFileSync(filePath, 'utf8');

    // Search for the marker in the content
    if (!content.includes(marker)) {
      return null;
    }

    // Find the line containing the marker and get its timestamp
    const lines = content.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line.includes(marker)) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.sessionId && parsed.timestamp) {
            return { sessionId: parsed.sessionId, timestamp: parsed.timestamp };
          }
        } catch {
          // Try to find sessionId from nearby lines
          for (let j = i; j >= Math.max(0, i - 5); j--) {
            try {
              const nearby = JSON.parse(lines[j]);
              if (nearby.sessionId) {
                return { sessionId: nearby.sessionId, timestamp: nearby.timestamp || new Date().toISOString() };
              }
            } catch {}
          }
        }
      }
    }
  } catch {
    // File read error
  }
  return null;
}

/**
 * Find session by searching for the marker in conversation content.
 * Returns the session where the marker appears with the MOST RECENT timestamp.
 * Falls back to most recent session if marker is empty or not found.
 */
export async function findSessionByMarker(marker: string): Promise<{ sessionId: string; filePath: string } | null> {
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');

  if (!fs.existsSync(claudeDir)) {
    return null;
  }

  const projects = fs.readdirSync(claudeDir).filter(f =>
    fs.statSync(path.join(claudeDir, f)).isDirectory()
  );

  // If marker provided, search for it in ALL files and pick the one with most recent marker occurrence
  if (marker && marker.length > 8) {
    const matches: { sessionId: string; filePath: string; timestamp: string }[] = [];

    for (const project of projects) {
      const projectDir = path.join(claudeDir, project);
      const jsonlFiles = fs.readdirSync(projectDir)
        .filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-') && !f.includes('.backup.'));

      for (const f of jsonlFiles) {
        const filePath = path.join(projectDir, f);
        const result = findMarkerInFile(filePath, marker);
        if (result) {
          matches.push({ sessionId: result.sessionId, filePath, timestamp: result.timestamp });
        }
      }
    }

    // Sort by timestamp (most recent first) and return the top one
    if (matches.length > 0) {
      matches.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      return { sessionId: matches[0].sessionId, filePath: matches[0].filePath };
    }
  }

  // Fallback: find session with most recent last-line timestamp
  const files: { path: string; sessionId: string; timestamp: string }[] = [];

  for (const project of projects) {
    const projectDir = path.join(claudeDir, project);
    const jsonlFiles = fs.readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-') && !f.includes('.backup.'));

    for (const f of jsonlFiles) {
      const filePath = path.join(projectDir, f);
      const info = getLastLineInfo(filePath);
      if (info) {
        files.push({ path: filePath, ...info });
      }
    }
  }

  // Sort by timestamp (most recent first) and return the top one
  files.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  if (files.length > 0) {
    return { sessionId: files[0].sessionId, filePath: files[0].path };
  }

  return null;
}
