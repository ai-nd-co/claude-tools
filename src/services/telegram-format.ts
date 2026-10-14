// Render the message style this project writes in as Telegram-ready HTML.
//
// Telegram has three parse modes and none of them fit as-is:
//
// - No parse mode leaves `__*Update*__` visible as punctuation, which is what
//   was happening: correctly authored messages arrived looking like markup.
// - Legacy `Markdown` has no underline, so the bold+underlined titles this
//   project uses for section headings cannot be expressed.
// - `MarkdownV2` has underline but requires escaping eighteen characters in
//   ordinary prose. A message containing a hyphen, a dot or a parenthesis - so,
//   any message - is rejected unless every one is escaped, and a single miss is
//   a 400 at send time.
//
// HTML needs only `&`, `<` and `>` escaped, and supports everything used here,
// so the source style is converted to HTML instead.

/** A code span's contents must survive untouched, so they are parked first. */
interface Parked {
  placeholder: string;
  html: string;
}

/**
 * Private-use characters are valid input, not safe sentinels: text containing
 * one could otherwise impersonate a placeholder and have generated markup
 * spliced into it. They carry no meaning in a message, so they are removed
 * before any parking happens.
 */
function stripSentinels(text: string): string {
  return text.replace(/[\uE000-\uF8FF]/g, '');
}

function escapeHtml(text: string): string {
  // Quotes are escaped too, so a url containing one cannot terminate the href
  // attribute it is interpolated into.
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Convert the documented style to Telegram HTML:
 *
 * - `` `code` ``      -> `<code>`
 * - ```` ```block``` ```` -> `<pre>`
 * - `[label](url)`    -> `<a href="url">` (the label is used literally)
 * - `__*title*__`     -> bold + underlined (the section-title convention)
 * - `__text__`        -> underlined
 * - `**text**`, `*text*` -> bold
 * - `~~text~~`        -> struck through
 *
 * Anything that is not one of these is escaped and passed through, so prose with
 * stray asterisks or underscores cannot produce an invalid document.
 */
export function toTelegramHtml(source: string): string {
  const parked: Parked[] = [];

  const park = (html: string): string => {
    // A placeholder must not collide with anything a person would type, and must
    // itself survive escaping, so it uses a private-use character.
    const placeholder = `${parked.length}`;
    parked.push({ placeholder, html });
    return placeholder;
  };

  let text = stripSentinels(source);

  // Fenced blocks first: their contents are literal, including backticks.
  text = text.replace(/```(?:[a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g, (_m, body: string) =>
    park(`<pre>${escapeHtml(body.replace(/\n$/, ''))}</pre>`));

  // Then inline code, for the same reason.
  text = text.replace(/`([^`\n]+)`/g, (_m, body: string) => park(`<code>${escapeHtml(body)}</code>`));

  // Links: the label is still styled, but the URL is opaque, so park the whole
  // tag and keep the label inline for further formatting.
  text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) =>
    park(`<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`));

  // Everything remaining is prose: escape it before adding tags of our own.
  text = escapeHtml(text);

  // Bold + underlined titles, in either nesting order.
  text = text.replace(/__\*(?!\s)([^*\n]+?)\*__/g, '<u><b>$1</b></u>');
  text = text.replace(/\*__(?!\s)([^_\n]+?)__\*/g, '<u><b>$1</b></u>');

  text = text.replace(/__(?!\s)([^_\n]+?)__/g, '<u>$1</u>');
  text = text.replace(/~~(?!\s)([^~\n]+?)~~/g, '<s>$1</s>');
  text = text.replace(/\*\*(?!\s)([^*\n]+?)\*\*/g, '<b>$1</b>');
  // Single asterisks are bold in Telegram's own dialect, not italic.
  text = text.replace(/\*(?!\s)([^*\n]+?)\*/g, '<b>$1</b>');

  // Restore in reverse: a later placeholder (a link) can contain an earlier one
  // (a code span in its label), so the outer must be put back first or the inner
  // is exposed after its own turn has passed.
  for (let i = parked.length - 1; i >= 0; i--) {
    text = text.split(parked[i].placeholder).join(parked[i].html);
  }

  return text;
}

/** Tags this converter emits. Anything else in the output is escaped text. */
const TAG_PATTERN = /<(\/?)(u|b|i|s|code|pre|a)(?:\s[^>]*)?>/g;

/**
 * Whether the generated markup is properly nested.
 *
 * Overlapping source markers — `__a *b__ c*` — produce crossed tags such as
 * `<u>a <b>b</u> c</b>`, which Telegram rejects outright. Counting opening and
 * closing tags does not notice, so the structure is checked with a stack and the
 * caller falls back to plain text rather than sending something that 400s.
 */
export function isWellNested(html: string): boolean {
  const stack: string[] = [];

  for (const match of html.matchAll(TAG_PATTERN)) {
    const [, closing, name] = match;
    if (closing) {
      if (stack.pop() !== name) return false;
    } else {
      stack.push(name);
    }
  }

  return stack.length === 0;
}

/**
 * True when the source contains markup worth rendering. False for plain prose,
 * which is then sent with no parse mode at all and cannot be rejected over
 * incidental punctuation.
 */
export function needsHtml(source: string): boolean {
  return toTelegramHtml(source) !== escapeHtml(stripSentinels(source));
}


/** A markdown table row: `| a | b |`. */
const TABLE_ROW = /^[ \t]*\|(.+)\|[ \t]*$/;

function cellsOf(line: string): string[] {
  const m = TABLE_ROW.exec(line);
  return m ? m[1].split('|').map((c) => c.trim()) : [];
}

/**
 * Speak a table by pairing each value with its column heading.
 *
 * Flattening a row to "Length, 4096, 32768" is readable on screen and useless
 * in the ear: by the third value the listener has lost which column it belongs
 * to, and the headings were spoken once, several rows ago. Pairing them keeps
 * each number attached to its meaning — "Length. Before: 4096. Now: 32768."
 *
 * Tables are handled as blocks rather than line by line, because a row cannot
 * be spoken without the header above it.
 */
function speakTables(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (!TABLE_ROW.test(lines[i])) {
      out.push(lines[i]);
      continue;
    }

    // Collect the whole run of adjacent rows.
    const rows: string[][] = [];
    while (i < lines.length && TABLE_ROW.test(lines[i])) rows.push(cellsOf(lines[i++]));
    i--;

    // A lone row has no heading to pair against, so read it as a list.
    if (rows.length < 2) {
      out.push(rows[0].filter(Boolean).join(', '));
      continue;
    }

    const [headers, ...body] = rows;
    for (const row of body) {
      // The first cell names the thing; the rest qualify it.
      const subject = row[0] ?? '';
      const rest = row.slice(1)
        .map((value, idx) => {
          const heading = headers[idx + 1] ?? '';
          if (!value) return '';
          return heading ? `${heading}: ${value}` : value;
        })
        .filter(Boolean);

      const spoken = rest.length ? `${subject}. ${rest.join('. ')}.` : subject;
      if (spoken.trim()) out.push(spoken.trim());
    }
  }

  return out.join('\n');
}

/**
 * Reduce a message to what should be *said*, not shown.
 *
 * Synthesis was previously handed the raw source, so a title written
 * `__*Done*__` was read aloud as "underscore underscore asterisk Done". Markup
 * is punctuation for the eye; the ear needs it removed.
 *
 * Code is dropped rather than spoken: a commit hash or a shell line read
 * character by character is noise, and the text remains on screen for anyone who
 * wants it. Link URLs go the same way, keeping only the label.
 */
export function toSpokenText(source: string): string {
  let text = stripSentinels(source);

  // Fenced blocks first, so their contents cannot be mistaken for markup.
  text = text.replace(/```[a-zA-Z0-9_+-]*\n[\s\S]*?```/g, ' ');

  text = text.replace(/`([^`\n]+)`/g, '$1');
  text = text.replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, '$1');

  text = text.replace(/__\*(?!\s)([^*\n]+?)\*__/g, '$1');
  text = text.replace(/\*__(?!\s)([^_\n]+?)__\*/g, '$1');
  text = text.replace(/__(?!\s)([^_\n]+?)__/g, '$1');
  text = text.replace(/~~(?!\s)([^~\n]+?)~~/g, '$1');
  text = text.replace(/\*\*(?!\s)([^*\n]+?)\*\*/g, '$1');
  text = text.replace(/\*(?!\s)([^*\n]+?)\*/g, '$1');

  // A heading marker is punctuation for the eye: spoken, it becomes "hash hash
  // What this deletes". Rich messages use real headings, so this is now common.
  text = text.replace(/^[ \t]*#{1,6}[ \t]+/gm, '');

  // A table separator row is pure layout and reads as "dash dash dash, dash
  // dash dash". Dropped before rows are flattened, or it survives as cells.
  // The trailing newline goes with it, or the removal leaves a blank line
  // between the header and the rows, which speaks as an odd pause.
  text = text.replace(/^[ \t]*\|?[\s:|-]*-[\s:|-]*\|?[ \t]*(\n|$)/gm, '');

  // A list marker is layout; the pause from the line break is enough.
  text = text.replace(/^[ \t]*[-*\u2022][ \t]+/gm, '');

  text = speakTables(text);

  // Collapse what the removals left behind, so there are no long silences and
  // no lines that are only leftover whitespace.
  return text
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
