// Convert markdown to Asana rich text (`html_notes` / `html_text`) and back.
//
// Asana rich text is not HTML. It is a small XML subset wrapped in <body>, and
// markup outside that subset is *rejected*, not ignored: the write fails with
// `400 xml_parsing_error`. So this converter never passes anything through -
// every input is escaped first and only known-good tags are re-introduced.
//
// Probed against the live API on 2026-09-25 (task created, each form PUT as
// html_notes, task deleted):
//
//   accepted  <strong> <em> <u> <s> <code> <ol> <ul> <li> <a href>
//             <blockquote> <pre> <h1> <h2> <hr/>, and <ul>/<ol> inside <li>
//   400       <div>, and <img> with an external src (xml_parsing_error)
//   500       <blockquote> inside <li>
//
// The 500 is the important one: an unsupported nesting can take the request
// down harder than an unsupported tag, so blockquotes, headings and code
// blocks are flattened to text inside list items rather than emitted there.
// Anything markdown can express and Asana cannot (tables, images, h3+) also
// degrades to text, because a plainer note always beats a failed write.

/** Tags Asana rejects outright are never emitted, so this list is the whole vocabulary. */
export interface AsanaHtmlOptions {
  /**
   * Tasks accept `<h1>`, `<h2>` and `<hr/>`; comments (stories) do not, so
   * headings degrade to bold lines and rules disappear there.
   */
  headings?: boolean;
}

/**
 * Characters XML 1.0 forbids outright - no escape exists for them - so they are
 * dropped before anything else. Legal: tab, LF, CR, #x20-#xD7FF, #xE000-#xFFFD
 * and every astral code point. That leaves the C0 controls, U+FFFE, U+FFFF and
 * **lone surrogates**; a matched surrogate pair is a real character and stays.
 */
const ILLEGAL_XML_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Placeholder marker for already-rendered inline spans. Safe because
 * `markdownToAsanaHtml` strips this character range from the input first, so a
 * marker can never collide with real text.
 */
const MARK = '\u0001';
const MARK_PATTERN = /\u0001(\d+)\u0001/g;

/** Only schemes a link can carry; anything else degrades to its label text. */
const SAFE_URL = /^(?:https?:\/\/|mailto:)/i;

/**
 * A link destination. One level of nested parentheses is allowed, which is what
 * `.../Function_(mathematics)` needs - stopping at the first `)` truncated the
 * URL and left a stray character in the text.
 */
const DESTINATION = '(?:[^()\\s]|\\([^()\\s]*\\))+';

/**
 * What may follow a destination inside the parentheses: an optional title, or
 * nothing. Deliberately not a catch-all - a trailing `[^)]*` let a destination
 * this pattern cannot express match only its first part, silently pointing the
 * link somewhere else. Now the whole construct stays literal text instead.
 */
const LINK_TITLE = '(?:\\s+"[^"]*"|\\s+\'[^\']*\'|\\s*)';

/** Opening fence: the delimiter character and its run length both matter. */
const FENCE_OPEN = /^\s*(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*)$/;
const RULE = /^ {0,3}(?:-{3,}|_{3,}|\*{3,})\s*$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)\d+[.)]\s+(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_DIVIDER = /^\s*\|[\s:|-]+\|\s*$/;

/**
 * An opening fence, or null when the line only looks like one.
 *
 * A backtick fence's info string may not itself contain a backtick - that is
 * what separates an opener like ```ts from the inline code span ```x```, which
 * was being read as an opener and swallowed the rest of the note.
 *
 * The block dispatcher and the paragraph-termination check must agree on this:
 * a line the dispatcher treats as a paragraph but the paragraph loop breaks on
 * would never be consumed, and the walk would not advance.
 */
function openingFence(line: string): string | null {
  const match = FENCE_OPEN.exec(line);
  if (!match) return null;

  const info = line.slice(line.indexOf(match[1]) + match[1].length);
  if (match[1][0] === '`' && info.includes('`')) return null;

  return match[1];
}

/**
 * Undo a code span's boundary padding, the way any Markdown reader does.
 *
 * One space is removed from each end when both ends are spaces and the payload
 * is not entirely spaces. That padding is how a payload beginning or ending with
 * a backtick - or with a significant space - is written at all, so the reader
 * has to strip it or the spaces become code content.
 */
function stripCodePadding(code: string): string {
  if (code.length >= 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim().length > 0) {
    return code.slice(1, -1);
  }
  return code;
}

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Quote an attribute value that has already been through `escapeText`.
 *
 * Re-escaping it would double the ampersands and corrupt every query string:
 * `?a=1&b=2` became `?a=1&amp;amp;b=2` before this was split out.
 */
function quoteAttribute(escaped: string): string {
  return escaped.replace(/"/g, '&quot;');
}

/**
 * Apply the inline emphasis rules.
 *
 * `strict` forbids a span from covering a `<` or `>`, which after escaping can
 * only be a tag an earlier rule produced. That is the repair for crossed
 * delimiters (see `safeEmphasis`); it is not the default because it would also
 * refuse the legitimate nesting in `*a **b** c*`.
 */
function emphasis(escaped: string, strict = false): string {
  const inner = strict ? '<>' : '';
  const rules: [RegExp, string][] = [
    [new RegExp(`\\*\\*\\*([^*${inner}]+)\\*\\*\\*`, 'g'), '<strong><em>$1</em></strong>'],
    [new RegExp(`\\*\\*([^*${inner}]+)\\*\\*`, 'g'), '<strong>$1</strong>'],
    [new RegExp(`__([^_${inner}]+)__`, 'g'), '<strong>$1</strong>'],
    [new RegExp(`(?<!\\*)\\*([^*\\n${inner}]+)\\*(?!\\*)`, 'g'), '<em>$1</em>'],
    [new RegExp(`(?<![\\w_])_([^_\\n${inner}]+)_(?![\\w_])`, 'g'), '<em>$1</em>'],
    [new RegExp(`~~([^~${inner}]+)~~`, 'g'), '<s>$1</s>'],
  ];

  let out = escaped;
  for (const [pattern, replacement] of rules) out = out.replace(pattern, replacement);
  return out;
}

/** True when every tag in a generated fragment closes, in order. */
function isWellNested(fragment: string): boolean {
  const stack: string[] = [];

  for (const match of fragment.matchAll(/<(\/?)([a-zA-Z0-9]+)([^>]*)>/g)) {
    const [, slash, tag, rest] = match;
    if (rest.trim().endsWith('/')) continue;
    if (slash) {
      if (stack.pop() !== tag.toLowerCase()) return false;
    } else {
      stack.push(tag.toLowerCase());
    }
  }

  return stack.length === 0;
}

/**
 * Emphasis that cannot produce malformed XML.
 *
 * Markdown lets delimiters cross - `**a _b** c_` is legal input - but XML does
 * not: the naive substitutions turn it into `<strong>a <em>b</strong> c</em>`,
 * which Asana rejects with 400. So the relaxed result is checked, a stricter
 * pass is tried, and failing both the delimiters stay literal text. A plainer
 * note beats a failed write.
 */
function safeEmphasis(escaped: string): string {
  const relaxed = emphasis(escaped);
  if (isWellNested(relaxed)) return relaxed;

  const strict = emphasis(escaped, true);
  if (isWellNested(strict)) return strict;

  return escaped;
}

/**
 * Render one run of markdown as inline Asana markup.
 *
 * Code spans and links are parked as placeholders so emphasis rules cannot
 * reach inside them - an underscore in a URL is a URL, not italics.
 */
function inline(raw: string): string {
  // Each parked span keeps both forms: the markup for body text, and the
  // original characters for an attribute, where markup would be illegal.
  const parked: { html: string; text: string }[] = [];
  const park = (html: string, text: string): string => `${MARK}${parked.push({ html, text }) - 1}${MARK}`;

  /** Resolve markers to plain characters - for a URL, which cannot hold tags. */
  const unpark = (value: string): string => {
    MARK_PATTERN.lastIndex = 0;
    return value.replace(MARK_PATTERN, (_m, index: string) => parked[Number(index)]?.text ?? '');
  };

  let out = escapeText(raw);

  // A run of N backticks opens a code span and the next run of *exactly* N
  // closes it, so ```x``` is one span rather than a stray fence followed by text,
  // and a ``double`` span can carry backticks in its payload. The lookarounds
  // enforce whole runs on both sides: without them the payload could eat half of
  // an interior run, and the opening capture could shrink by backtracking, which
  // both mis-paired the delimiters and made an unmatched run disappear. Spans do
  // not cross lines, so an unmatched backtick stays literal.
  out = out.replace(/(?<!`)(`+)(?!`)([^\n]*?)(?<!`)\1(?!`)/g, (_m, ticks: string, code: string) =>
    // The markup gets the unpadded payload; the plain form, used inside a URL,
    // keeps exactly what was typed.
    park(`<code>${stripCodePadding(code)}</code>`, `${ticks}${code}${ticks}`),
  );

  // Images: Asana only accepts <img> pointing at one of its own attachments, so
  // an external image becomes a link (or plain text) instead of a 400.
  out = out.replace(new RegExp(`!\\[([^\\]]*)\\]\\(\\s*(${DESTINATION})${LINK_TITLE}\\)`, 'g'), (match: string, alt: string, url: string) => {
    const href = unpark(url);
    const label = alt.trim() || href;
    return SAFE_URL.test(href)
      ? park(`<a href="${quoteAttribute(href)}">${safeEmphasis(label)}</a>`, unpark(match))
      : park(label, unpark(match));
  });

  out = out.replace(new RegExp(`\\[([^\\]]+)\\]\\(\\s*(${DESTINATION})${LINK_TITLE}\\)`, 'g'), (match: string, label: string, url: string) => {
    const href = unpark(url);
    const text = safeEmphasis(label);
    return SAFE_URL.test(href)
      ? park(`<a href="${quoteAttribute(href)}">${text}</a>`, unpark(match))
      : park(text, unpark(match));
  });

  out = safeEmphasis(out);

  // A parked link label can itself hold a parked code span, so restore until
  // no markers remain (bounded, so a pathological input cannot spin).
  for (let pass = 0; pass < 10 && MARK_PATTERN.test(out); pass++) {
    MARK_PATTERN.lastIndex = 0;
    out = out.replace(MARK_PATTERN, (_m, index: string) => parked[Number(index)]?.html ?? '');
  }
  MARK_PATTERN.lastIndex = 0;

  return out;
}

/** Inline markup with every block construct flattened - used inside <li>. */
function flatInline(raw: string): string {
  return inline(raw.replace(/^ {0,3}(?:#{1,6}\s+|>\s?)/, ''));
}

interface ListItem {
  level: number;
  ordered: boolean;
  text: string;
}

/**
 * Render nested lists. Asana accepts a `<ul>`/`<ol>` inside an `<li>`, which is
 * how the app draws indentation, so real nesting survives.
 */
function renderList(items: ListItem[], start: number, level: number): { html: string; next: number } {
  const ordered = items[start].ordered;
  const parts: string[] = [];
  let i = start;

  while (i < items.length && items[i].level >= level) {
    const item = items[i];

    if (item.level > level) {
      const nested = renderList(items, i, item.level);
      if (parts.length === 0) parts.push(`<li>${nested.html}</li>`);
      // A replacement *function*, because nested.html is user content: a literal
      // `$&` or `` $` `` in a list item would otherwise be expanded as a
      // replacement pattern and duplicate or unbalance the markup.
      else parts[parts.length - 1] = parts[parts.length - 1].replace(/<\/li>$/, () => `${nested.html}</li>`);
      i = nested.next;
      continue;
    }

    // A different marker at the same depth starts a new list rather than
    // silently joining an ordered run onto a bulleted one.
    if (item.ordered !== ordered) break;

    parts.push(`<li>${flatInline(item.text)}</li>`);
    i++;
  }

  const tag = ordered ? 'ol' : 'ul';
  return { html: `<${tag}>${parts.join('')}</${tag}>`, next: i };
}

interface Block {
  html: string;
  /** Paragraph-like blocks get a blank line between them; block elements do not. */
  text: boolean;
}

/**
 * Convert markdown to the `<body>`-wrapped rich text Asana accepts.
 *
 * The result is always well-formed: unsupported markup is escaped or dropped,
 * never forwarded, so this function does not produce a 400.
 */
export function markdownToAsanaHtml(markdown: string, options: AsanaHtmlOptions = {}): string {
  const headings = options.headings !== false;
  const source = (markdown ?? '').replace(ILLEGAL_XML_CHARS, '').replace(/\r\n?/g, '\n');
  if (!source.trim()) return '<body></body>';

  const lines = source.split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    // Fenced code. The closing fence must use the same character and be at least
    // as long as the opening one, so a ```` ```` ```` block can contain a ```` ``` ````
    // example - closing on any fence swallowed the inner one and turned the code
    // into paragraphs. An unterminated fence runs to the end of the input,
    // matching how editors render it.
    const fence = openingFence(line);
    if (fence) {
      const marker = fence[0];
      const width = fence.length;
      const closes = (candidate: string): boolean => {
        const match = FENCE_OPEN.exec(candidate);
        return Boolean(match && match[1][0] === marker && match[1].length >= width && candidate.trim() === match[1].trim());
      };

      const body: string[] = [];
      i++;
      while (i < lines.length && !closes(lines[i])) body.push(lines[i++]);
      if (i < lines.length) i++;
      blocks.push({ html: `<pre>${escapeText(body.join('\n'))}</pre>`, text: false });
      continue;
    }

    const rule = RULE.exec(line);
    if (rule) {
      // No <hr/> in a comment, and an empty paragraph there would be noise.
      if (headings) blocks.push({ html: '<hr/>', text: false });
      i++;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const content = inline(heading[2].replace(/\s+#+\s*$/, ''));
      // Asana has exactly two heading levels; h3 and below fold into h2.
      if (headings) {
        const tag = heading[1].length === 1 ? 'h1' : 'h2';
        blocks.push({ html: `<${tag}>${content}</${tag}>`, text: false });
      } else {
        // The whole line is bold here, so an inner <strong> would only nest a
        // tag inside itself - valid XML, but sloppy output that renders as a
        // stray `**` when converted back.
        blocks.push({ html: `<strong>${content.replace(/<\/?strong>/g, '')}</strong>`, text: true });
      }
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length) {
        const match = QUOTE.exec(lines[i]);
        if (!match) break;
        quoted.push(flatInline(match[1]));
        i++;
      }
      blocks.push({ html: `<blockquote>${quoted.join('\n')}</blockquote>`, text: false });
      continue;
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      const items: ListItem[] = [];
      // Indentation widths, one per open level. A stack rather than
      // width/2 arithmetic because the only rule that matters is *relative*:
      // two items indented the same must land on the same level, whether the
      // author used 2 spaces or 8.
      const widths: number[] = [];

      while (i < lines.length) {
        const bullet = BULLET.exec(lines[i]);
        const numbered = bullet ? null : ORDERED.exec(lines[i]);
        const match = bullet || numbered;
        if (!match) break;

        const width = match[1].replace(/\t/g, '  ').length;
        while (widths.length > 0 && width < widths[widths.length - 1]) widths.pop();
        if (widths.length === 0 || width > widths[widths.length - 1]) widths.push(width);

        items.push({ level: widths.length - 1, ordered: Boolean(numbered), text: match[2] });
        i++;
      }

      let cursor = 0;
      while (cursor < items.length) {
        const rendered = renderList(items, cursor, items[cursor].level);
        blocks.push({ html: rendered.html, text: false });
        cursor = rendered.next > cursor ? rendered.next : cursor + 1;
      }
      continue;
    }

    // Tables have no Asana equivalent; keep the cells as readable lines.
    if (TABLE_ROW.test(line)) {
      const rows: string[] = [];
      while (i < lines.length && TABLE_ROW.test(lines[i])) {
        const row = lines[i++];
        if (TABLE_DIVIDER.test(row)) continue;
        const cells = row.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
        rows.push(inline(cells.join(' | ')));
      }
      if (rows.length > 0) blocks.push({ html: rows.join('\n'), text: true });
      continue;
    }

    const paragraph: string[] = [];
    while (i < lines.length) {
      const current = lines[i];
      if (!current.trim()) break;
      if (openingFence(current) || RULE.test(current) || HEADING.test(current)) break;
      if (QUOTE.test(current) || BULLET.test(current) || ORDERED.test(current)) break;
      if (TABLE_ROW.test(current)) break;
      paragraph.push(inline(current));
      i++;
    }
    blocks.push({ html: paragraph.join('\n'), text: true });
  }

  let body = '';
  for (let b = 0; b < blocks.length; b++) {
    if (b > 0) body += blocks[b].text && blocks[b - 1].text ? '\n\n' : '\n';
    body += blocks[b].html;
  }

  return `<body>${body}</body>`;
}

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/**
 * Index of the closing tag that balances an element opened just before `from`.
 * Nested lists make a non-greedy regex match the *inner* close tag, so depth is
 * counted explicitly. Only same-name tags are counted, which is why an `<ol>`
 * inside a `<ul>` does not disturb the `</ul>` search.
 */
function matchingClose(html: string, from: number, tag: string): number {
  const token = new RegExp(`<${tag}>|</${tag}>`, 'g');
  token.lastIndex = from;
  let depth = 1;
  let match: RegExpExecArray | null;

  while ((match = token.exec(html))) {
    depth += match[0][1] === '/' ? -1 : 1;
    if (depth === 0) return match.index;
  }
  return -1;
}

/** Inner text of each top-level `<li>` in a list body. */
function listItems(content: string): string[] {
  const items: string[] = [];
  const token = /<li>|<\/li>/g;
  let depth = 0;
  let start = -1;
  let match: RegExpExecArray | null;

  while ((match = token.exec(content))) {
    if (match[0] === '<li>') {
      if (depth === 0) start = match.index + 4;
      depth++;
    } else if (depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        items.push(content.slice(start, match.index));
        start = -1;
      }
    }
  }

  return items;
}

/** Turn one `<ul>`/`<ol>` body into markdown list lines, recursing into nested lists. */
function listToMarkdown(content: string, ordered: boolean, depth: number): string {
  const indent = '  '.repeat(depth);
  let counter = 0;
  const lines: string[] = [];

  for (const item of listItems(content)) {
    const nested: string[] = [];
    const text = extractLists(item, depth + 1, nested);
    const marker = ordered ? `${++counter}. ` : '- ';
    lines.push(`${indent}${marker}${inlineToMarkdown(text).trim()}`);
    lines.push(...nested);
  }

  return lines.join('\n');
}

/** Remove nested lists from a list item, appending their markdown to `collected`. */
function extractLists(html: string, depth: number, collected: string[]): string {
  let text = '';
  let rest = html;

  while (true) {
    const open = /<(ul|ol)>/.exec(rest);
    if (!open) return text + rest;

    const tag = open[1];
    const contentStart = open.index + open[0].length;
    const close = matchingClose(rest, contentStart, tag);
    if (close < 0) return text + rest;

    text += rest.slice(0, open.index);
    collected.push(listToMarkdown(rest.slice(contentStart, close), tag === 'ol', depth));
    rest = rest.slice(close + tag.length + 3);
  }
}

/** Replace top-level lists in place, keeping their position in the surrounding text. */
function convertLists(html: string, park: (markdown: string) => string): string {
  let out = '';
  let rest = html;

  while (true) {
    const open = /<(ul|ol)>/.exec(rest);
    if (!open) return out + rest;

    const tag = open[1];
    const contentStart = open.index + open[0].length;
    const close = matchingClose(rest, contentStart, tag);
    if (close < 0) return out + rest;

    out += rest.slice(0, open.index);
    out += `\n${park(listToMarkdown(rest.slice(contentStart, close), tag === 'ol', 0))}\n`;
    rest = rest.slice(close + tag.length + 3);
  }
}

/**
 * Serialise one inline code span.
 *
 * The delimiter has to be longer than the longest backtick run in the payload,
 * or re-reading the markdown splits it into several spans and changes the code -
 * the inline twin of the fenced-block problem. A payload that starts or ends
 * with a backtick also needs a space, which `stripCodePadding` removes on the
 * way back in.
 */
function codeSpan(code: string): string {
  const longest = Math.max(0, ...[...code.matchAll(/`+/g)].map((run) => run[0].length));
  const ticks = '`'.repeat(longest + 1);
  // Pad when a delimiter would otherwise touch a backtick, and also when the
  // payload's own boundary spaces would be eaten by the reader's strip.
  const touchesTick = code.startsWith('`') || code.endsWith('`');
  const boundarySpaces = code.startsWith(' ') && code.endsWith(' ') && code.trim().length > 0;
  const pad = touchesTick || boundarySpaces ? ' ' : '';
  return `${ticks}${pad}${code}${pad}${ticks}`;
}

function inlineToMarkdown(html: string): string {
  return unescapeXml(
    html
      .replace(/<code>([\s\S]*?)<\/code>/g, (_m, code: string) => codeSpan(code))
      .replace(/<strong>([\s\S]*?)<\/strong>/g, '**$1**')
      .replace(/<b>([\s\S]*?)<\/b>/g, '**$1**')
      .replace(/<em>([\s\S]*?)<\/em>/g, '*$1*')
      .replace(/<i>([\s\S]*?)<\/i>/g, '*$1*')
      .replace(/<s>([\s\S]*?)<\/s>/g, '~~$1~~')
      // Markdown has no underline, so the emphasis is dropped and the text kept.
      .replace(/<\/?u>/g, '')
      .replace(/<a href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, '[$2]($1)')
      .replace(/<[^>]+>/g, ''),
  );
}

/**
 * Render Asana rich text as markdown for terminal display.
 *
 * Display-only and deliberately forgiving: unknown tags are stripped rather
 * than reported, so `show` never fails on markup a newer Asana emits.
 */
export function asanaHtmlToMarkdown(html: string): string {
  if (!html) return html;

  // Every block converted here is parked, not substituted in place. Its output
  // is finished markdown that may legitimately contain `<div>` or `` ` ``, and
  // the document-wide `inlineToMarkdown` pass below strips tags and decodes
  // entities - which silently deleted markup out of code blocks, list items,
  // headings and quotes before this was parked.
  const parked: string[] = [];
  const park = (markdown: string): string => `${MARK}${parked.push(markdown) - 1}${MARK}`;

  let out = html
    .replace(ILLEGAL_XML_CHARS, '')
    .replace(/^\s*<body>/, '')
    .replace(/<\/body>\s*$/, '');

  out = out.replace(/<pre>([\s\S]*?)<\/pre>/g, (_m, code: string) => {
    const body = unescapeXml(code);
    // A fence has to be longer than the longest backtick run it contains, or a
    // code block holding a markdown example closes itself when re-read.
    const longest = Math.max(0, ...[...body.matchAll(/`+/g)].map((run) => run[0].length));
    const fence = '`'.repeat(Math.max(3, longest + 1));
    return park(`\n${fence}\n${body}\n${fence}\n`);
  });
  out = out.replace(/<blockquote>([\s\S]*?)<\/blockquote>/g, (_m, quoted: string) =>
    park(
      inlineToMarkdown(quoted)
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n'),
    ),
  );
  out = out.replace(/<h1>([\s\S]*?)<\/h1>/g, (_m, text: string) => park(`# ${inlineToMarkdown(text)}`));
  out = out.replace(/<h2>([\s\S]*?)<\/h2>/g, (_m, text: string) => park(`## ${inlineToMarkdown(text)}`));
  out = out.replace(/<hr\s*\/?>/g, '---');
  out = convertLists(out, park);

  // Collapse the layout *before* restoring: a fenced block may legitimately
  // contain blank lines, and normalising after restoration rewrote the code
  // itself. Nothing touches the content once it is back.
  let rendered = inlineToMarkdown(out).replace(/\n{3,}/g, '\n\n').trim();

  // A parked list can contain a parked block of its own, so restore until no
  // markers remain (bounded, so a pathological input cannot spin).
  for (let pass = 0; pass < 10; pass++) {
    MARK_PATTERN.lastIndex = 0;
    if (!MARK_PATTERN.test(rendered)) break;
    MARK_PATTERN.lastIndex = 0;
    rendered = rendered.replace(MARK_PATTERN, (_m, index: string) => parked[Number(index)] ?? '');
  }
  MARK_PATTERN.lastIndex = 0;

  return rendered.trim();
}
