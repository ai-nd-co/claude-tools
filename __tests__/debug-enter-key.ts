// Debug script to see what Ink receives when Enter is pressed
import React, { useState } from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';

function App() {
  const { exit } = useApp();
  const [events, setEvents] = useState<string[]>([]);

  useInput((input, key) => {
    const event = {
      input: JSON.stringify(input),
      inputCharCodes: [...input].map(c => c.charCodeAt(0)),
      key: {
        return: key.return,
        escape: key.escape,
        ctrl: key.ctrl,
        meta: key.meta,
        shift: key.shift,
        backspace: key.backspace,
        delete: key.delete,
        tab: key.tab,
        upArrow: key.upArrow,
        downArrow: key.downArrow,
      }
    };

    setEvents(prev => [...prev.slice(-10), JSON.stringify(event, null, 2)]);

    if (key.escape) {
      exit();
    }
  });

  return React.createElement(Box, { flexDirection: 'column', padding: 1 },
    React.createElement(Text, { bold: true }, 'Press keys to see what Ink receives (Esc to exit)'),
    React.createElement(Text, { dimColor: true }, '─────────────────────────────────────'),
    ...events.map((e, i) => React.createElement(Text, { key: i }, e))
  );
}

render(React.createElement(App));
