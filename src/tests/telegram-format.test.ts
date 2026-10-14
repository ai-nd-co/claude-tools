import test from 'node:test';
import assert from 'node:assert/strict';

import { needsHtml, toSpokenText, toTelegramHtml } from '../services/telegram-format.js';

test('renders a bold+underlined title', () => {
  // The project's section-title convention. Without a parse mode this arrived as
  // literal punctuation, which is the bug this module exists to fix.
  assert.equal(toTelegramHtml('__*Update*__'), '<u><b>Update</b></u>');
  assert.equal(toTelegramHtml('*__Update__*'), '<u><b>Update</b></u>');
});

test('renders the rest of the supported style', () => {
  assert.equal(toTelegramHtml('__under__'), '<u>under</u>');
  assert.equal(toTelegramHtml('**strong**'), '<b>strong</b>');
  assert.equal(toTelegramHtml('*strong*'), '<b>strong</b>', 'a single asterisk is bold in Telegram, not italic');
  assert.equal(toTelegramHtml('~~gone~~'), '<s>gone</s>');
});

test('escapes HTML in prose', () => {
  // A message about shell pipes or comparisons must not become invalid markup.
  assert.equal(toTelegramHtml('5 > 3 && 2 < 4'), '5 &gt; 3 &amp;&amp; 2 &lt; 4');
  assert.equal(toTelegramHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
});

test('leaves MarkdownV2 minefield characters alone', () => {
  // These are exactly the characters MarkdownV2 would reject unescaped.
  const prose = 'a hyphen - a dot. a (paren) a [bracket] a +plus= a |pipe| a {brace} a !bang #hash';
  assert.equal(toTelegramHtml(prose), prose);
  assert.equal(needsHtml(prose), false, 'plain prose should need no parse mode');
});

test('inline code keeps its contents literal', () => {
  assert.equal(
    toTelegramHtml('run `git commit -m "*x*"` now'),
    'run <code>git commit -m &quot;*x*&quot;</code> now',
  );
  // Asterisks and underscores inside code are not formatting.
  assert.equal(toTelegramHtml('`a * b _ c`'), '<code>a * b _ c</code>');
});

test('code spans escape HTML but not markup', () => {
  assert.equal(toTelegramHtml('`a < b & c`'), '<code>a &lt; b &amp; c</code>');
});

test('fenced blocks become pre', () => {
  assert.equal(toTelegramHtml('```\nline one\nline two\n```'), '<pre>line one\nline two</pre>');
});

test('a fenced block ignores a language tag and inner backticks', () => {
  assert.equal(toTelegramHtml('```bash\necho `date`\n```'), '<pre>echo `date`</pre>');
});

test('a quote in a url cannot escape the href attribute', () => {
  const out = toTelegramHtml('[x](https://example.com/a"onmouseover=alert(1))');

  assert.ok(!/href="[^"]*"[a-z]/i.test(out), `attribute broke out: ${out}`);
  assert.ok(out.includes('&quot;'));
});

test('links become anchors with the url untouched', () => {
  assert.equal(
    toTelegramHtml('see [PR 123](https://example.com/a_b*c)'),
    'see <a href="https://example.com/a_b*c">PR 123</a>',
    'underscores and asterisks in a url must not be treated as markup',
  );
});

test('unbalanced markup passes through instead of producing invalid HTML', () => {
  // The failure mode to avoid is a 400 at send time for an unclosed tag.
  for (const input of ['a lone * asterisk', 'a lone _ underscore', 'unclosed **bold', 'trailing __']) {
    const out = toTelegramHtml(input);
    const opens = (out.match(/<[a-z]+>/g) ?? []).length;
    const closes = (out.match(/<\/[a-z]+>/g) ?? []).length;
    assert.equal(opens, closes, `${input} produced unbalanced tags: ${out}`);
  }
});

test('does not style across a line break', () => {
  // A stray asterisk on one line must not bold everything up to the next one.
  const out = toTelegramHtml('first * line\nsecond * line');
  assert.ok(!out.includes('<b>'), `unexpected bold: ${out}`);
});

test('does not treat a leading space as an opener', () => {
  assert.equal(toTelegramHtml('2 * 3 * 4'), '2 * 3 * 4');
});

test('needsHtml is false only when nothing would change', () => {
  assert.equal(needsHtml('nothing to do here'), false);
  assert.equal(needsHtml('a < b'), false, 'escaping alone does not require a parse mode');
  assert.equal(needsHtml('__*Title*__'), true);
  assert.equal(needsHtml('`code`'), true);
});

test('handles a realistic multi-section message', () => {
  const source = [
    '__*Pushed*__',
    '',
    'claude-tools `8fd2b6f` - see [the commit](https://example.com/c/8fd2b6f).',
    'Tests: **195 pass**, 0 fail.',
  ].join('\n');

  const out = toTelegramHtml(source);

  assert.ok(out.startsWith('<u><b>Pushed</b></u>'));
  assert.ok(out.includes('<code>8fd2b6f</code>'));
  assert.ok(out.includes('<a href="https://example.com/c/8fd2b6f">the commit</a>'));
  assert.ok(out.includes('<b>195 pass</b>'));
  assert.ok(!out.includes('__'), 'no source markup should survive');
});

test('is idempotent on already-converted output in the sense of staying valid', () => {
  const once = toTelegramHtml('__*Title*__ and `code`');
  const twice = toTelegramHtml(once);

  // Re-running escapes the tags rather than nesting them, which is safe: the
  // caller converts exactly once, and a double pass cannot emit broken markup.
  assert.ok(!twice.includes('<u><b>'), 'a second pass should not produce live tags');
  assert.ok(twice.includes('&lt;'), 'it escapes instead');
});

// --- what gets spoken -------------------------------------------------------

test('speech drops markup instead of pronouncing it', () => {
  // The bug this exists for: Kokoro read `__*Done*__` aloud as underscores and
  // asterisks, because it was handed the raw source.
  assert.equal(toSpokenText('__*Done*__'), 'Done');
  assert.equal(toSpokenText('**bold** and *single* and __under__ and ~~struck~~'),
    'bold and single and under and struck');
});

test('speech keeps inline code contents but not the backticks', () => {
  assert.equal(toSpokenText('commit `fa53d2b` landed'), 'commit fa53d2b landed');
});

test('speech drops fenced blocks entirely', () => {
  // A shell line read character by character is noise; it stays on screen.
  assert.equal(toSpokenText('before\n```bash\necho hi\n```\nafter'), 'before\n\nafter');
});

test('speech keeps a link label and drops its url', () => {
  assert.equal(toSpokenText('see [the commit](https://example.com/a_b)'), 'see the commit');
});

test('speech drops list markers', () => {
  assert.equal(toSpokenText('- first\n- second'), 'first\nsecond');
});

test('speech pairs each table value with its column heading', () => {
  // "1, 9" is readable on screen and useless in the ear: by the second value
  // the listener has lost which column it belongs to.
  assert.equal(toSpokenText('| round | findings |\n| 1 | 9 |'), '1. findings: 9.');
});

test('speech leaves plain prose untouched', () => {
  const prose = 'A sentence with a hyphen - a dot. And a (paren).';
  assert.equal(toSpokenText(prose), prose);
});

test('speech collapses the gaps left by removals', () => {
  const out = toSpokenText('a\n\n\n\n```\ncode\n```\n\n\nb');
  assert.ok(!/\n{3,}/.test(out), `long silence remains: ${JSON.stringify(out)}`);
  assert.ok(!/^\s+$/m.test(out), `whitespace-only line remains: ${JSON.stringify(out)}`);
});

test('a message that is only formatting has nothing to say', () => {
  assert.equal(toSpokenText('```\ncode only\n```'), '');
});

// Rich messages use real markdown headings and tables, so speech has to cope
// with both. Before this, a heading was read aloud as "hash hash What".

test('speech drops heading markers', () => {
  assert.equal(toSpokenText('# Decision 1'), 'Decision 1');
  assert.equal(toSpokenText('### Deeper'), 'Deeper');
  assert.equal(toSpokenText('#hashtag stays'), '#hashtag stays', 'a bare # is not a heading');
});

test('speech drops the table separator row', () => {
  // It would otherwise read as "dash dash dash, dash dash dash".
  assert.equal(toSpokenText('| a | b |\n| --- | --- |\n| 1 | 2 |'), '1. b: 2.');
});

test('speech handles an aligned separator row too', () => {
  assert.equal(toSpokenText('| a | b |\n|:---|---:|\n| 1 | 2 |'), '1. b: 2.');
});

test('a three-column table keeps every value attached to its heading', () => {
  assert.equal(
    toSpokenText('| What | Before | Now |\n| --- | --- | --- |\n| Length | 4096 | 32768 |'),
    'Length. Before: 4096. Now: 32768.',
  );
});

test('a lone table row has no heading to pair with, so it reads as a list', () => {
  assert.equal(toSpokenText('| just | one | row |'), 'just, one, row');
});

test('an empty cell is skipped rather than spoken as its heading alone', () => {
  assert.equal(toSpokenText('| a | b | c |\n| --- | --- | --- |\n| x |  | z |'), 'x. c: z.');
});

test('two tables in one message do not bleed into each other', () => {
  const spoken = toSpokenText('| a | b |\n| --- | --- |\n| 1 | 2 |\n\ntext\n\n| c | d |\n| --- | --- |\n| 3 | 4 |');
  assert.equal(spoken, '1. b: 2.\n\ntext\n\n3. d: 4.');
});

test('a realistic rich message reads cleanly', () => {
  const spoken = toSpokenText([
    '# Decision 1: yes',
    '',
    'The field is `rich_message.markdown`.',
    '',
    '| What | Before | Now |',
    '| --- | --- | --- |',
    '| Length | 4096 | 32768 |',
  ].join('\n'));

  assert.ok(!spoken.includes('#'), `heading marker survived: ${spoken}`);
  assert.ok(!spoken.includes('---'), `separator survived: ${spoken}`);
  assert.ok(!spoken.includes('|'), `pipes survived: ${spoken}`);
  assert.ok(spoken.includes('Length. Before: 4096. Now: 32768.'), spoken);
});
