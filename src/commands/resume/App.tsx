import React, { useState, useEffect, useMemo } from 'react';
import { Box, Text, useInput, useApp, useStdout } from 'ink';
import * as fs from 'fs';
import { formatSize } from '../../utils/compact.js';
import {
  SessionInfo,
  loadAllSessions,
  formatRelativeTime,
  matchesPattern,
  getMatchedTerms,
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
 */
export interface ResumeResult {
  sessionId: string;
  cwd: string;
}

interface Props {
  initialFilter?: string;
  onDone?: (result: ResumeResult) => void;
}

export default function App({ initialFilter = '', onDone }: Props) {
  const { exit } = useApp();
  const { stdout } = useStdout();

  const visibleRows = Math.max(5, (stdout?.rows || 40) - 16);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [filter, setFilter] = useState(initialFilter);
  const [cursor, setCursor] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);

  // Load sessions on mount
  useEffect(() => {
    const loaded = loadAllSessions();
    setSessions(loaded);
    setLoading(false);
    setTimeout(() => setReady(true), 200);
  }, []);

  // Debounce filter for performance (500ms - faster than fork since no AI)
  const debouncedFilter = useDebounce(filter, 500);

  // Filter sessions using grep-style OR pattern matching
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
      if (!ready || loading || status.includes('Launching')) {
        return;
      }

      if (filteredSessions.length === 0) {
        setStatus('No session selected');
        return;
      }

      const selected = filteredSessions[cursor];

      // Get project path from session file
      let project = process.cwd();
      try {
        const content = fs.readFileSync(selected.filePath, 'utf8');
        for (const line of content.split('\n').filter(l => l.trim())) {
          try {
            const msg = JSON.parse(line);
            if (msg.cwd) {
              project = msg.cwd;
              break;
            }
          } catch {}
        }
      } catch {}

      // Pass result to parent and exit Ink.
      // The parent will wait for Ink to fully unmount (waitUntilExit),
      // then spawn claude in the same terminal with clean stdin.
      setStatus('Launching claude...');
      if (onDone) {
        onDone({ sessionId: selected.sessionId, cwd: project });
      }
      exit();

      return;
    }

    if (key.backspace || key.delete) {
      setFilter(f => f.slice(0, -1));
      return;
    }

    // Regular character input
    if (input && !key.ctrl && !key.meta) {
      setFilter(f => f + input);
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

  // Get matched terms for status display
  const matchedTerms = filter.trim() && filteredSessions.length > 0 && cursor < filteredSessions.length
    ? getMatchedTerms(filteredSessions[cursor], filter)
    : [];

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold>Resume Session</Text>
        <Text dimColor> - Search and resume (use | for OR)</Text>
      </Box>

      {/* Search box */}
      <Box marginBottom={1}>
        <Text>Search: </Text>
        <Text color="cyan">{filter || '(type to search, use | for OR)'}</Text>
        <Text dimColor> | {filteredSessions.length} matches</Text>
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

      {/* Matched terms indicator */}
      {matchedTerms.length > 0 && (
        <Box marginTop={1}>
          <Text dimColor>Matched: </Text>
          <Text color="green">{matchedTerms.join(', ')}</Text>
        </Box>
      )}

      {/* Footer */}
      <Box marginTop={1}>
        <Text>
          <Text bold>[↑↓]</Text> Nav{' '}
          <Text bold>[Enter]</Text> Resume{' '}
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
