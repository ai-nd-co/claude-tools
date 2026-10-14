// Debug script to see what Ink receives when Enter is pressed
// Run with: node __tests__/debug-enter-key.js

const React = require('react');
const { render, Box, Text, useInput, useApp } = require('ink');

function App() {
  const { exit } = useApp();
  const [events, setEvents] = React.useState([]);

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

  return React.createElement(Box, { flexDirection: 'column', padding: 1 },
    React.createElement(Text, { bold: true }, 'Press Enter key to debug (Esc to exit)'),
    React.createElement(Text, { dimColor: true }, '─────────────────────────────────────'),
    React.createElement(Text, null, 'Events logged to console above'),
    React.createElement(Text, { dimColor: true }, `Captured ${events.length} events`)
  );
}

render(React.createElement(App));
