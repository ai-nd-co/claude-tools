import React, { useState, useEffect, useMemo } from 'react';
import { Box, Text, useInput, useApp, useStdout } from 'ink';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { formatSize, PROGRESSIVE_TARGET_RATIO } from '../../utils/compact.js';
import { summarizeSessionFile } from '../../utils/summarize.js';
import { SummaryProvider } from '../../utils/summary-provider.js';
import {
  SessionInfo,
  loadAllSessions,
  formatRelativeTime,
  matchesPattern,
} from '../../utils/session-search.js';

/**
 * Custom hook for debouncing a value
 */
function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debouncedValue;
}

/**
 * Result passed back to the parent after Ink exits.
 * The parent uses this to spawn claude in a clean terminal state.
 */
export interface ForkResult {
  sessionId: string;
  cwd: string;
}

interface Props {
  compact?: boolean;
  targetRatio?: number;
  summaryProvider?: SummaryProvider;
  summaryModel?: string;
  model?: string;
  onDone?: (result: ForkResult) => void;
}

export default function App({
  compact = true,
  targetRatio = PROGRESSIVE_TARGET_RATIO,
  summaryProvider,
  summaryModel,
  model,
  onDone,
}: Props) {
  const { exit } = useApp();
  const { stdout } = useStdout();

  // Reserve space for UI elements - be generous to avoid overflow
  // padding(2) + header(2) + search(2) + border(2) + scroll(1) + footer(2) + status(2) + margin
  const visibleRows = Math.max(5, (stdout?.rows || 40) - 16);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [filter, setFilter] = useState('');
  const [cursor, setCursor] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);  // Skip initial Enter from stdin

  // Load sessions on mount
  useEffect(() => {
    const loaded = loadAllSessions();
    setSessions(loaded);
    setLoading(false);
    // Delay ready state to skip any initial Enter from stdin buffer
    setTimeout(() => setReady(true), 200);
  }, []);

  // Debounce filter for performance (500ms delay - reduced from 2s for better responsiveness)
  const debouncedFilter = useDebounce(filter, 500);

  // Filter sessions using grep-style OR pattern matching (same as resume)
  const filteredSessions = useMemo(() => {
    if (!debouncedFilter.trim()) return sessions;
    return sessions.filter(s => matchesPattern(s, debouncedFilter));
  }, [sessions, debouncedFilter]);

  // Ensure cursor is within bounds
  useEffect(() => {
    if (cursor >= filteredSessions.length) {
      setCursor(Math.max(0, filteredSessions.length - 1));
    }
  }, [filteredSessions.length, cursor]);

  // Handle scroll
  useEffect(() => {
    if (cursor < scrollOffset) {
      setScrollOffset(cursor);
    } else if (cursor >= scrollOffset + visibleRows) {
      setScrollOffset(cursor - visibleRows + 1);
    }
  }, [cursor, scrollOffset, visibleRows]);

  // Fork session function - performs the actual fork operation
  const forkSession = (selected: SessionInfo) => {
    (async () => {
      try {
        // Create a NEW session file (preserve original)
        const newSessionId = uuidv4();
        const sessionDir = path.dirname(selected.filePath);
        const newFilePath = path.join(sessionDir, `${newSessionId}.jsonl`);

        setStatus(`Creating new session ${newSessionId.slice(0, 8)}...`);
        fs.copyFileSync(selected.filePath, newFilePath);

        if (compact) {
          setStatus('Generating AI summary (this may take a minute)...');

          const result = await summarizeSessionFile(newFilePath, {
            cutoffPercent: 60,
            summaryProvider,
            summaryModel,
            model,
          });

          const finalPercent = Math.round((result.compactedSize / result.originalSize) * 100);
          setStatus(`Summarized to ${finalPercent}%, launching...`);
        }

        // Update session ID in the new file
        const content = fs.readFileSync(newFilePath, 'utf-8');
        const updated = content.replace(new RegExp(selected.sessionId, 'g'), newSessionId);
        fs.writeFileSync(newFilePath, updated);

        // Get project path from first message with cwd
        let project = process.cwd();
        for (const line of content.split('\n').filter(l => l.trim())) {
          try {
            const msg = JSON.parse(line);
            if (msg.cwd) {
              project = msg.cwd;
              break;
            }
          } catch {}
        }

        // Add to Claude's history
        const historyPath = path.join(os.homedir(), '.claude', 'history.jsonl');
        const historyEntry = {
          display: 'Forked session',
          pastedContents: {},
          timestamp: Date.now(),
          project,
          sessionId: newSessionId,
        };
        fs.appendFileSync(historyPath, JSON.stringify(historyEntry) + '\n', 'utf8');

        // Pass the result to the parent and exit Ink.
        // The parent will wait for Ink to fully unmount (waitUntilExit),
        // then spawn claude in the same terminal with clean stdin.
        if (onDone) {
          onDone({ sessionId: newSessionId, cwd: project });
        }
        exit();
      } catch (err) {
        setStatus(`Error: ${err}`);
      }
    })();
  };

  useInput((input, key) => {
    if (key.escape) {
      exit();
      return;
    }

    if (key.upArrow) {
      setCursor(c => Math.max(0, c - 1));
      return;
    }

    if (key.downArrow) {
      setCursor(c => Math.min(filteredSessions.length - 1, c + 1));
      return;
    }

    if (key.return) {
      if (!ready || loading || status.includes('Generating') || status.includes('Creating') || status.includes('Launching')) {
        return;
      }
      if (filteredSessions.length === 0) {
        setStatus('No session selected');
        return;
      }
      forkSession(filteredSessions[cursor]);
      return;
    }

    if (key.backspace || key.delete) {
      setFilter(f => f.slice(0, -1));
      return;
    }

    // Regular character input
    // Filter out terminal escape sequences that leak through:
    // - [200~ / [201~ : bracketed paste start/end
    // - [O, [I : focus in/out events
    // - Other escape sequences starting with [ followed by letters/numbers
    if (input && !key.ctrl && !key.meta) {
      const cleanedInput = input
        .replace(/\[200~/g, '')   // Start of bracketed paste
        .replace(/\[201~/g, '')   // End of bracketed paste
        .replace(/\[O/g, '')      // Focus out
        .replace(/\[I/g, '')      // Focus in
        .replace(/\[\d*[A-Za-z]/g, '') // Generic escape sequences like [1A, [2B, etc.
        .replace(/[\r\n]+/g, ' ') // Convert newlines to spaces
        .replace(/\s+/g, ' ');    // Normalize multiple whitespace to single space
      if (cleanedInput) {
        setFilter(f => (f + cleanedInput).replace(/\s+/g, ' '));
      }
    }
  });

  if (loading) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text>Loading sessions...</Text>
      </Box>
    );
  }

  const visibleSessions = filteredSessions.slice(scrollOffset, scrollOffset + visibleRows);

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold>Interactive Fork</Text>
        <Text dimColor> - Select a session to fork (use | for OR)</Text>
      </Box>

      {/* Search box */}
      <Box marginBottom={1}>
        <Text>Filter: </Text>
        <Text color="cyan">{filter || '(type to filter, use | for OR)'}</Text>
        <Text dimColor> | {filteredSessions.length} sessions</Text>
      </Box>

      {/* Sessions list */}
      <Box flexDirection="column" borderStyle="single" paddingX={1}>
        {visibleSessions.length === 0 ? (
          <Text dimColor>No sessions found</Text>
        ) : (
          visibleSessions.map((session, idx) => {
            const actualIdx = scrollOffset + idx;
            const isSelected = actualIdx === cursor;
            const timeStr = formatRelativeTime(session.timestamp).padEnd(10);
            const sizeStr = `[${formatSize(session.size)}]`.padEnd(12);
            // Sanitize preview - remove all newlines and control characters
            const preview = session.preview.replace(/[\r\n\t\x00-\x1F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50);
            const line = `${isSelected ? '▶ ' : '  '}${timeStr} ${sizeStr} ${preview}`;

            return (
              <Text key={`${session.sessionId}-${idx}`} color={isSelected ? 'cyan' : undefined} inverse={isSelected}>
                {line}
              </Text>
            );
          })
        )}
      </Box>

      {/* Scroll indicator */}
      {filteredSessions.length > visibleRows && (
        <Text dimColor>
          Showing {scrollOffset + 1}-{Math.min(scrollOffset + visibleRows, filteredSessions.length)} of {filteredSessions.length}
        </Text>
      )}

      {/* Footer */}
      <Box marginTop={1}>
        <Text>
          <Text bold>[↑↓]</Text> Nav{' '}
          <Text bold>[Enter]</Text> Fork{compact ? '+Compact' : ''}{' '}
          <Text bold>[Esc]</Text> Quit
        </Text>
      </Box>

      {/* Status */}
      {status && (
        <Box marginTop={1}>
          <Text color="yellow">{status}</Text>
        </Box>
      )}
    </Box>
  );
}
