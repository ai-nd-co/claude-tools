import React, { useState } from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';

function App() {
  const { exit } = useApp();
  const [events, setEvents] = useState<string[]>([]);

  useInput((input, key) => {
    const event = {
      input: JSON.stringify(input),
      inputLen: input.length,
      inputCharCodes: [...input].map(c => c.charCodeAt(0)),
      keyReturn: key.return,
      keyEscape: key.escape,
      keyCtrl: key.ctrl,
      keyMeta: key.meta,
    };

    console.log('INPUT EVENT:', JSON.stringify(event));
    setEvents(prev => [...prev.slice(-5), JSON.stringify(event)]);

    if (key.escape) {
      exit();
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>Press Enter key to debug (Esc to exit)</Text>
      <Text dimColor>─────────────────────────────────────</Text>
      <Text>Events logged to console above</Text>
      <Text dimColor>Captured {events.length} events</Text>
    </Box>
  );
}

render(<App />);
