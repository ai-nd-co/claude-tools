import test from 'node:test';
import assert from 'node:assert/strict';

import { markdownToAsanaHtml, asanaHtmlToMarkdown } from '../utils/markdown-to-asana-html.js';

/**
 * Asana's `html_notes` is a strict XML subset, and markup outside it is
 * rejected with 400 rather than ignored. The rules below were probed against
 * the live API on 2026-09-25, so these tests encode observed behaviour, not
 * documentation: <div> and an external <img> are 400s, and a <blockquote>
 * inside an <li> is a 500.
 */

/** The only tags Asana accepts. Anything else in the output would be a 400 waiting to happen. */
const ALLOWED = new Set(['body', 'strong', 'em', 'u', 's', 'code', 'ol', 'ul', 'li', 'a', 'blockquote', 'pre', 'h1', 'h2', 'hr']);

function tagsIn(html: string): string[] {
  return [...html.matchAll(/<\/?([a-zA-Z0-9]+)[^>]*>/g)].map((m) => m[1].toLowerCase());
}

function assertOnlyAllowedTags(html: string): void {
  for (const tag of tagsIn(html)) {
    assert.ok(ALLOWED.has(tag), `unexpected tag <${tag}> in ${html}`);
  }
}

/** Rough well-formedness check: every tag closes, in order. */
function assertBalanced(html: string): void {
  const stack: string[] = [];
  for (const match of html.matchAll(/<(\/?)([a-zA-Z0-9]+)([^>]*)>/g)) {
    const [, slash, tag, rest] = match;
    if (rest.trim().endsWith('/')) continue; // self-closing, e.g. <hr/>
    if (slash) {
      assert.equal(stack.pop(), tag.toLowerCase(), `unbalanced </${tag}> in ${html}`);
    } else {
      stack.push(tag.toLowerCase());
    }
  }
  assert.deepEqual(stack, [], `unclosed tags in ${html}`);
}

test('everything is wrapped in a single body element', () => {
  assert.equal(markdownToAsanaHtml('hello'), '<body>hello</body>');
  assert.equal(markdownToAsanaHtml(''), '<body></body>');
  assert.equal(markdownToAsanaHtml('   \n  '), '<body></body>');
});

test('inline markdown becomes the supported inline tags', () => {
  assert.equal(markdownToAsanaHtml('**bold** and *italic*'), '<body><strong>bold</strong> and <em>italic</em></body>');
  assert.equal(markdownToAsanaHtml('~~gone~~'), '<body><s>gone</s></body>');
  assert.equal(markdownToAsanaHtml('`x = 1`'), '<body><code>x = 1</code></body>');
  assert.equal(markdownToAsanaHtml('***both***'), '<body><strong><em>both</em></strong></body>');
});

test('a code span is not reinterpreted as emphasis', () => {
  // `snake_case_name` inside a code span must not turn into <em>.
  const html = markdownToAsanaHtml('use `a_b_c` here');
  assert.equal(html, '<body>use <code>a_b_c</code> here</body>');
});

test('a link keeps its URL intact and escapes the ampersand', () => {
  const html = markdownToAsanaHtml('[report](https://example.com/a?b=1&c=2)');
  assert.equal(html, '<body><a href="https://example.com/a?b=1&amp;c=2">report</a></body>');
  assertBalanced(html);
});

test('an underscore inside a URL stays an underscore', () => {
  const html = markdownToAsanaHtml('[x](https://example.com/a_b_c)');
  assert.equal(html, '<body><a href="https://example.com/a_b_c">x</a></body>');
});

test('an unsafe link scheme degrades to its label', () => {
  const html = markdownToAsanaHtml('[click](javascript:alert(1))');
  // No anchor is emitted. The stray ")" is the honest result of markdown's own
  // parenthesis ambiguity in a URL, and text is the safe place for it.
  assert.ok(!html.includes('<a '), html);
  assert.ok(html.includes('click'), html);
  assertOnlyAllowedTags(html);
});

test('headings fold into the two levels Asana has, and comments get bold instead', () => {
  assert.equal(markdownToAsanaHtml('# One'), '<body><h1>One</h1></body>');
  assert.equal(markdownToAsanaHtml('## Two'), '<body><h2>Two</h2></body>');
  // h3+ has no Asana equivalent, so it degrades rather than being emitted.
  assert.equal(markdownToAsanaHtml('#### Four'), '<body><h2>Four</h2></body>');
  // Stories (comments) reject h1/h2/hr entirely.
  assert.equal(markdownToAsanaHtml('# One', { headings: false }), '<body><strong>One</strong></body>');
  // No <strong> inside <strong>: the whole degraded line is already bold.
  assert.equal(
    markdownToAsanaHtml('## deployed, **watching** the logs', { headings: false }),
    '<body><strong>deployed, watching the logs</strong></body>',
  );
  // The rule disappears and the two paragraphs stay paragraphs.
  assert.equal(markdownToAsanaHtml('text\n\n---\n\nmore', { headings: false }), '<body>text\n\nmore</body>');
});

test('lists nest with a list inside the list item, which Asana accepts', () => {
  const html = markdownToAsanaHtml('- outer\n  - inner\n- second');
  assert.equal(html, '<body><ul><li>outer<ul><li>inner</li></ul></li><li>second</li></ul></body>');
  assertBalanced(html);
  assertOnlyAllowedTags(html);
});

test('an ordered list becomes ol, and a marker change starts a new list', () => {
  assert.equal(markdownToAsanaHtml('1. one\n2. two'), '<body><ol><li>one</li><li>two</li></ol></body>');
  const mixed = markdownToAsanaHtml('- bullet\n1. number');
  assert.equal(mixed, '<body><ul><li>bullet</li></ul>\n<ol><li>number</li></ol></body>');
  assertBalanced(mixed);
});

test('block constructs inside a list item are flattened, never nested', () => {
  // A <blockquote> inside an <li> returned HTTP 500 from Asana, so it must not
  // be emitted even though markdown allows the shape.
  const html = markdownToAsanaHtml('- > quoted inside an item');
  assert.ok(!html.includes('<blockquote>'), html);
  assert.equal(html, '<body><ul><li>quoted inside an item</li></ul></body>');
  assertBalanced(html);
});

test('unsupported markup degrades to text instead of producing a 400', () => {
  // <div> is a 400 (xml_parsing_error) when passed through; escaped it is text.
  const div = markdownToAsanaHtml('<div>raw html</div>');
  assert.equal(div, '<body>&lt;div&gt;raw html&lt;/div&gt;</body>');
  assertOnlyAllowedTags(div);

  // An external <img> is also a 400, so an image becomes a link.
  const image = markdownToAsanaHtml('![shot](https://example.com/a.png)');
  assert.ok(!image.includes('<img'), image);
  assert.equal(image, '<body><a href="https://example.com/a.png">shot</a></body>');

  // Tables have no Asana equivalent; the cells stay readable.
  const table = markdownToAsanaHtml('| a | b |\n|---|---|\n| 1 | 2 |');
  assert.equal(table, '<body>a | b\n1 | 2</body>');
  assertOnlyAllowedTags(table);

  // A script tag is text, not markup.
  const script = markdownToAsanaHtml('<script>alert(1)</script>');
  assert.ok(!script.includes('<script'), script);
  assertOnlyAllowedTags(script);
});

test('characters that would break the XML are escaped or dropped', () => {
  assert.equal(markdownToAsanaHtml('a & b < c > d'), '<body>a &amp; b &lt; c &gt; d</body>');
  // XML 1.0 has no escape for these, so they are removed rather than encoded.
  assert.equal(markdownToAsanaHtml('bell\u0007and\u0000null'), '<body>bellandnull</body>');
});

test('a fenced code block becomes pre with its content escaped', () => {
  const html = markdownToAsanaHtml('```ts\nif (a < b) return "x";\n```');
  assert.equal(html, '<body><pre>if (a &lt; b) return "x";</pre></body>');
  assertBalanced(html);
});

test('an unterminated fence still produces well-formed output', () => {
  const html = markdownToAsanaHtml('```\nunclosed');
  assert.equal(html, '<body><pre>unclosed</pre></body>');
  assertBalanced(html);
});

test('every generated document is balanced and uses only accepted tags', () => {
  const kitchenSink = [
    '# Title',
    '',
    'A paragraph with **bold**, `code`, a [link](https://example.com) and a & b.',
    '',
    '## Sub',
    '',
    '- one',
    '  - nested',
    '    - deeper',
    '1. first',
    '',
    '> quoted',
    '> more',
    '',
    '```',
    'raw <div>',
    '```',
    '',
    '---',
    '',
    '| h1 | h2 |',
    '|----|----|',
    '| a  | b  |',
    '',
    '<div>injected</div>',
    '![img](https://example.com/x.png)',
  ].join('\n');

  const html = markdownToAsanaHtml(kitchenSink);
  assertBalanced(html);
  assertOnlyAllowedTags(html);
  assert.ok(html.startsWith('<body>') && html.endsWith('</body>'));
});

test('asana html renders back to readable markdown', () => {
  assert.equal(asanaHtmlToMarkdown('<body><strong>b</strong> and <em>i</em></body>'), '**b** and *i*');
  assert.equal(asanaHtmlToMarkdown('<body><h1>T</h1>\ntext</body>'), '# T\ntext');
  assert.equal(
    asanaHtmlToMarkdown('<body><a href="https://example.com">x</a></body>'),
    '[x](https://example.com)',
  );
  assert.equal(asanaHtmlToMarkdown('<body>a &amp; b &lt; c</body>'), 'a & b < c');
  assert.equal(asanaHtmlToMarkdown('<body><blockquote>one\ntwo</blockquote></body>'), '> one\n> two');
});

test('a nested list renders back with its nesting, not flattened', () => {
  const markdown = asanaHtmlToMarkdown('<body><ul><li>outer<ul><li>inner</li></ul></li><li>second</li></ul></body>');
  assert.equal(markdown, '- outer\n  - inner\n- second');
});

test('an ordered list renumbers per level', () => {
  const markdown = asanaHtmlToMarkdown('<body><ol><li>a</li><li>b<ol><li>b1</li></ol></li></ol></body>');
  assert.equal(markdown, '1. a\n2. b\n  1. b1');
});

test('a list round-trips through both converters', () => {
  const source = '- outer\n  - inner\n- second';
  assert.equal(asanaHtmlToMarkdown(markdownToAsanaHtml(source)), source);
});

test('markup inside a code block survives rendering', () => {
  // The tag-stripping pass must not reach inside <pre>: a fenced block that
  // contains markup is exactly where that content matters.
  assert.equal(
    asanaHtmlToMarkdown('<body><pre>raw &lt;div&gt; inside a fence</pre></body>'),
    '```\nraw <div> inside a fence\n```',
  );
  // And it round-trips.
  const source = '```\nif (a < b) { return "<x>"; }\n```';
  assert.equal(asanaHtmlToMarkdown(markdownToAsanaHtml(source)), source);
});

test('unknown tags are stripped when rendering, so display never fails', () => {
  assert.equal(asanaHtmlToMarkdown('<body><table><tr><td>x</td></tr></table></body>'), 'x');
  assert.equal(asanaHtmlToMarkdown('<body><u>underlined</u></body>'), 'underlined');
});

// --------------------------------------------------------------------------
// Regressions from the Codex audit of 2026-09-25. Each of these produced
// malformed XML (a 400), corrupted output, or lost content before the fix.
// --------------------------------------------------------------------------

test('crossed emphasis delimiters do not produce crossed tags', () => {
  // Legal markdown, illegal XML: the naive substitutions gave
  // <strong>a <em>b</strong> c</em>, which Asana rejects with 400.
  const html = markdownToAsanaHtml('**a _b** c_');
  assertBalanced(html);
  assertOnlyAllowedTags(html);
  assert.ok(html.includes('_b'), `the unmatched delimiter should stay literal: ${html}`);
});

test('legitimate nesting is still converted', () => {
  // The repair must not cost this case, which is properly nested.
  assert.equal(markdownToAsanaHtml('*a **b** c*'), '<body><em>a <strong>b</strong> c</em></body>');
});

test('a replacement pattern in a nested list item is literal text', () => {
  // `$&` and `` $` `` are replacement patterns to String.replace; as user text
  // they were expanded and unbalanced the markup.
  for (const injected of ['$&', "$'", '$`', '$1']) {
    const html = markdownToAsanaHtml(`- outer\n  - ${injected}`);
    assertBalanced(html);
    assert.ok(html.includes(injected.replace(/&/g, '&amp;')), `${injected} lost in ${html}`);
  }
});

test('a code span inside a link destination cannot put markup in the attribute', () => {
  // A literal < inside an XML attribute is not well-formed.
  const html = markdownToAsanaHtml('[x](https://example.com/`q`)');
  assertBalanced(html);
  assert.ok(!/href="[^"]*</.test(html), `markup leaked into the attribute: ${html}`);
  assert.ok(!html.includes('<code>q</code>"'), html);
});

test('a quote inside a link destination is escaped in the attribute', () => {
  const html = markdownToAsanaHtml('[x](https://example.com/a"b)');
  assertBalanced(html);
  assert.ok(!/href="[^"]*"[^>]*"[^>]*>/.test(html.replace('&quot;', '')), html);
  assert.ok(html.includes('&quot;'), html);
});

test('characters XML cannot represent are dropped, and real ones survive', () => {
  // U+FFFF and a lone surrogate are illegal in XML 1.0 at any escape.
  assert.equal(markdownToAsanaHtml('a￿b'), '<body>ab</body>');
  assert.equal(markdownToAsanaHtml('a￾b'), '<body>ab</body>');
  assert.equal(markdownToAsanaHtml('a\uD800b'), '<body>ab</body>');
  assert.equal(markdownToAsanaHtml('a\uDC00b'), '<body>ab</body>');
  // A matched pair is one real character and must stay intact.
  assert.equal(markdownToAsanaHtml('a\u{1F600}b'), '<body>a\u{1F600}b</body>');
});

test('markup inside a list item, heading or quote survives rendering', () => {
  // Same class as the <pre> bug: the document-wide pass stripped the tags that
  // the inner pass had already decoded.
  assert.equal(asanaHtmlToMarkdown(markdownToAsanaHtml('- `<div>`')), '- `<div>`');
  assert.equal(asanaHtmlToMarkdown(markdownToAsanaHtml('# a `<b>` c')), '# a `<b>` c');
  assert.equal(asanaHtmlToMarkdown(markdownToAsanaHtml('> a `<b>` c')), '> a `<b>` c');
});

test('equal indentation means equal nesting, whatever the width', () => {
  // Four-space indentation is ordinary markdown, and the old width/2 rule made
  // each sibling one level deeper than the last.
  const four = markdownToAsanaHtml('- outer\n    - first\n    - second');
  assert.equal(four, '<body><ul><li>outer<ul><li>first</li><li>second</li></ul></li></ul></body>');

  const eight = markdownToAsanaHtml('- outer\n        - first\n        - second');
  assert.equal(eight, '<body><ul><li>outer<ul><li>first</li><li>second</li></ul></li></ul></body>');

  // And dedenting returns to the right level.
  assert.equal(
    markdownToAsanaHtml('- a\n    - b\n- c'),
    '<body><ul><li>a<ul><li>b</li></ul></li><li>c</li></ul></body>',
  );
});

test('three indentation levels round-trip', () => {
  const source = '- a\n  - b\n    - c\n- d';
  assert.equal(asanaHtmlToMarkdown(markdownToAsanaHtml(source)), source);
});

// ---- Round 2 of the Codex audit -------------------------------------------

test('a link destination may contain balanced parentheses', () => {
  const html = markdownToAsanaHtml('[reference](https://en.wikipedia.org/wiki/Function_(mathematics))');
  assert.equal(
    html,
    '<body><a href="https://en.wikipedia.org/wiki/Function_(mathematics)">reference</a></body>',
  );
  assertBalanced(html);
});

test('a link title after the destination is still accepted', () => {
  assert.equal(
    markdownToAsanaHtml('[x](https://example.com/a "the title")'),
    '<body><a href="https://example.com/a">x</a></body>',
  );
});

test('a longer fence can contain a shorter one', () => {
  // The inner ``` must not close the outer ````.
  const source = ['````markdown', '```js', 'const x = 1;', '```', '````'].join('\n');
  const html = markdownToAsanaHtml(source);

  assert.equal(html, '<body><pre>```js\nconst x = 1;\n```</pre></body>');
  assertBalanced(html);
});

test('a tilde fence does not close a backtick fence', () => {
  const html = markdownToAsanaHtml(['```', '~~~', 'still inside', '~~~', '```'].join('\n'));
  assert.equal(html, '<body><pre>~~~\nstill inside\n~~~</pre></body>');
});

test('blank lines inside a code block survive the round trip', () => {
  // Layout normalisation used to collapse them, changing the code itself.
  const source = '```\na\n\n\nb\n```';
  assert.equal(markdownToAsanaHtml(source), '<body><pre>a\n\n\nb</pre></body>');
  assert.equal(asanaHtmlToMarkdown(markdownToAsanaHtml(source)), source);
});

test('a rendered fence is longer than any backtick run it contains', () => {
  // Otherwise the block closes itself when the markdown is read back.
  const source = ['````', '```js', 'const x = 1;', '```', '````'].join('\n');
  assert.equal(asanaHtmlToMarkdown(markdownToAsanaHtml(source)), source);
});

// ---- Round 3 of the Codex audit -------------------------------------------

test('a destination the converter cannot express stays literal, never half-matched', () => {
  // Truncating the URL to `https://example.com/a` and dropping the rest into the
  // text pointed the link somewhere else, which is worse than not linking.
  const html = markdownToAsanaHtml('[x](https://example.com/a(b(c)d))');

  assert.ok(!html.includes('<a '), html);
  assert.ok(html.includes('https://example.com/a(b(c)d)'), html);
  assertBalanced(html);
  assertOnlyAllowedTags(html);
});

test('a single level of nesting, and titles, still link', () => {
  assert.equal(
    markdownToAsanaHtml('[a](https://example.com/x_(y))'),
    '<body><a href="https://example.com/x_(y)">a</a></body>',
  );
  assert.equal(
    markdownToAsanaHtml("[a](https://example.com/x 'single quoted')"),
    '<body><a href="https://example.com/x">a</a></body>',
  );
});

test('an inline code span on its own line is not an opening fence', () => {
  // ```SELECT 1;``` is a code span. Treated as a fence it ate the line's content
  // and turned the following prose into code.
  const html = markdownToAsanaHtml('```SELECT 1;```\nKeep this note');

  assert.ok(html.includes('SELECT 1;'), `the code was dropped: ${html}`);
  assert.ok(html.includes('Keep this note'), `the prose was swallowed: ${html}`);
  assert.equal(html, '<body><code>SELECT 1;</code>\nKeep this note</body>');
  assertBalanced(html);
});

test('a real fence with an info string still opens a block', () => {
  assert.equal(markdownToAsanaHtml('```ts\nconst a = 1;\n```'), '<body><pre>const a = 1;</pre></body>');
});

test('a multi-backtick code span keeps a backtick-bearing payload', () => {
  assert.equal(markdownToAsanaHtml('``a `b` c``'), '<body><code>a `b` c</code></body>');
});

// ---- Round 4 of the Codex audit -------------------------------------------

test('a code span pairs whole backtick runs', () => {
  // The payload must not eat half of an interior run...
  assert.equal(markdownToAsanaHtml('`a``b`'), '<body><code>a``b</code></body>');
  // ...and an unmatched run must stay literal rather than vanish.
  assert.equal(markdownToAsanaHtml('Use `` here'), '<body>Use `` here</body>');
  assert.equal(markdownToAsanaHtml('Use ` here'), '<body>Use ` here</body>');
  // The ordinary forms still work.
  assert.equal(markdownToAsanaHtml('`x`'), '<body><code>x</code></body>');
  assert.equal(markdownToAsanaHtml('``a `b` c``'), '<body><code>a `b` c</code></body>');
  assert.equal(markdownToAsanaHtml('```SELECT 1;```'), '<body><code>SELECT 1;</code></body>');
});

test('a code span is serialised with a delimiter its payload cannot close', () => {
  // `a `b` c` would read back as two spans with different content.
  assert.equal(asanaHtmlToMarkdown('<body><code>a `b` c</code></body>'), '``a `b` c``');
  assert.equal(asanaHtmlToMarkdown('<body><code>a``b</code></body>'), '```a``b```');
  // A payload touching a backtick at either edge needs the space the reader strips.
  assert.equal(asanaHtmlToMarkdown('<body><code>`x`</code></body>'), '`` `x` ``');
  assert.equal(asanaHtmlToMarkdown('<body><code>plain</code></body>'), '`plain`');
});

test('code-span padding is added and stripped as a pair', () => {
  // The serialiser's pad must not become part of the payload when read back.
  assert.equal(markdownToAsanaHtml('`` `x` ``'), '<body><code>`x`</code></body>');
  // A payload that is all spaces keeps them, as every Markdown reader does.
  assert.equal(markdownToAsanaHtml('`  `'), '<body><code>  </code></body>');
  // And a payload whose own boundary spaces matter survives the round trip.
  assert.equal(asanaHtmlToMarkdown('<body><code> a </code></body>'), '`  a  `');
  assert.equal(markdownToAsanaHtml('`  a  `'), '<body><code> a </code></body>');
});

test('a backtick-bearing code span survives a full round trip', () => {
  for (const source of ['``a `b` c``', '`a``b`', '`plain`', '```SELECT 1;```', '`` `x` ``', '`  a  `', '`  `']) {
    const html = markdownToAsanaHtml(source);
    // Re-converting the rendered markdown must give the same markup, which is
    // the property that matters: the code content is unchanged.
    assert.equal(markdownToAsanaHtml(asanaHtmlToMarkdown(html)), html, `round trip changed ${source}`);
  }
});
