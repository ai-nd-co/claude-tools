import React, { useState, useEffect, useMemo } from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';

// Simulate the fork app's useDebounce hook
function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debouncedValue;
}

// Fake sessions
const fakeSessions = [
  { id: '1', name: 'Session 1' },
  { id: '2', name: 'Session 2' },
  { id: '3', name: 'Session 3' },
];

function App() {
  const { exit } = useApp();
  const [filter, setFilter] = useState('');
  const [cursor, setCursor] = useState(0);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [sessions, setSessions] = useState<typeof fakeSessions>([]);
  const [debugLog, setDebugLog] = useState<string[]>([]);

  const log = (msg: string) => {
    console.log(msg);
    setDebugLog(prev => [...prev.slice(-10), msg]);
  };

  // Simulate loading like the real app
  useEffect(() => {
    log('Loading sessions...');
    setSessions(fakeSessions);
    setLoading(false);
    log('Sessions loaded: ' + fakeSessions.length);
  }, []);

  // Debounce filter (2s like real app)
  const debouncedFilter = useDebounce(filter, 2000);

  // Filter sessions
  const filteredSessions = useMemo(() => {
    if (!debouncedFilter.trim()) return sessions;
    return sessions.filter(s => s.name.toLowerCase().includes(debouncedFilter.toLowerCase()));
  }, [sessions, debouncedFilter]);

  useInput((input, key) => {
    log(`useInput called: key.return=${key.return}, input=${JSON.stringify(input)}, filteredSessions.length=${filteredSessions.length}`);

    if (key.escape) {
      log('Escape pressed, exiting');
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
      log('Enter key detected in handler!');

      if (filteredSessions.length === 0) {
        log('No sessions available!');
        setStatus('No session selected');
        return;
      }

      const selected = filteredSessions[cursor];
      log(`Selected session: ${selected.id} - ${selected.name}`);
      setStatus(`Forking ${selected.id}...`);

      // Simulate the setTimeout like real app
      setTimeout(() => {
        log('Inside setTimeout - would fork now');
        setStatus('Would launch claude here...');

        // Don't actually exit, just show it worked
        setTimeout(() => {
          log('Fork simulation complete');
          exit();
        }, 1000);
      }, 100);

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
        <Text>Loading...</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>Debug Fork App (Esc to exit)</Text>
      <Text dimColor>─────────────────────────────────────</Text>
      <Text>Filter: {filter || '(empty)'}</Text>
      <Text>Sessions: {filteredSessions.length}</Text>
      <Text>Cursor: {cursor}</Text>
      <Text>Status: {status || '(none)'}</Text>
      <Text dimColor>─────────────────────────────────────</Text>
      {filteredSessions.map((s, i) => (
        <Text key={s.id} color={i === cursor ? 'cyan' : undefined}>
          {i === cursor ? '▶ ' : '  '}{s.name}
        </Text>
      ))}
      <Text dimColor>─────────────────────────────────────</Text>
      <Text dimColor>Debug log (last entries):</Text>
      {debugLog.slice(-5).map((log, i) => (
        <Text key={i} dimColor>{log}</Text>
      ))}
    </Box>
  );
}

render(<App />);
