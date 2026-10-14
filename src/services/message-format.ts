/**
 * The shape check every outgoing Telegram message passes before it is sent.
 *
 * The owner asked for messages that read as sections: a bold title, one idea per paragraph, bullets for lists, PRs as
 * named links, one phone screen at most, and not so short that they stop explaining (2026-10-14). The rules lived
 * only in a skill, and a session loses the end of a skill at compaction, so it kept sending walls of text. This check
 * gives the rules back at the moment they matter: a refusal names what broke, with the actual and allowed numbers,
 * and prints the whole format, every time, whatever is left in the session's context.
 *
 * Pure: no I/O. The commands print `formatRefusal` / `formatWarnings` and exit with FORMAT_REFUSED_EXIT_CODE.
 */

// --- Every threshold, in one place ---------------------------------------------------------------------------------

/** Exit status of a send refused for its shape: not 0 (sent) and not 1 (failed). */
export const FORMAT_REFUSED_EXIT_CODE = 3;
/** One phone screen. Applies to every message, short or long. */
export const MAX_MESSAGE_CHARS = 800;
/** At or below this many visible characters only the length rule applies: a short reply is one idea already. */
export const SHAPE_MIN_CHARS = 250;
/** The longest prose paragraph. */
export const MAX_PARAGRAPH_CHARS = 300;
/** More sentences than this in a paragraph is refused (the owner's limit, 2026-10-14). */
export const MAX_PARAGRAPH_SENTENCES = 3;
/** A paragraph with this many sentences draws a warning. */
export const WARN_PARAGRAPH_SENTENCES = 3;
/** The longest bullet. */
export const MAX_BULLET_CHARS = 200;
/** The longest opening title. */
export const MAX_TITLE_CHARS = 80;
/** More unnumbered question marks than this (outside code) draws a warning: questions are numbered, **1. …?**. */
export const MAX_QUESTIONS = 1;
/** This many lines starting with ✅/🔴 make a status board. */
export const STATUS_BOARD_LINES = 2;
/** A closing one-line paragraph this short ("Reply A or B.") needs no title. */
export const MAX_SIGNOFF_CHARS = 60;
/** The messages a long answer may be split into before it should be a file. */
export const MAX_SPLIT_MESSAGES = 3;

export type FormatRule =
  | 'length' | 'paragraph' | 'sentences' | 'bullet' | 'inline-list' | 'title' | 'block-title' | 'bare-id' // refusals
  | 'dense' | 'questions' | 'bare-hash' | 'status-board' | 'shorthand'; // warnings

export interface FormatFinding {
  rule: FormatRule;
  /** One line saying what is wrong, with the actual and the allowed number. */
  message: string;
  /** The start of the offending paragraph or line, when there is one. */
  excerpt?: string;
}

export interface FormatReport {
  refusals: FormatFinding[];
  warnings: FormatFinding[];
  /** Visible characters of the whole body: link labels count, URLs and markup do not; code, tables and quotes do. */
  visibleChars: number;
}

/** A paragraph or one list item: the unit the paragraph rules measure. */
interface Unit {
  text: string;
  kind: 'paragraph' | 'item' | 'heading';
}

const LIST_ITEM = /^\s*(?:[-*+•]|\d{1,3}[.)])\s+/;
const HEADING = /^\s{0,3}#{1,6}\s/;
const FENCE = /^\s{0,3}(```+|~~~+)/;
/** HTML code elements (bot --html): rendered literally, like markdown code. */
const HTML_CODE = /<(pre|code)\b[^>]*>([\s\S]*?)<\/\1>/gi;
const ENTITY = /&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|(amp|lt|gt|quot|apos|nbsp));/gi;
const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntity(_: string, dec?: string, hex?: string, name?: string): string {
  if (name) return NAMED_ENTITIES[name.toLowerCase()];
  const code = dec ? Number(dec) : parseInt(hex!, 16);
  return code <= 0x10ffff ? String.fromCodePoint(code) : '';
}

function decodeEntities(text: string): string {
  return text.replace(ENTITY, decodeEntity);
}

/** Inline code: a run of backticks, content (which may hold shorter runs) and a run of the same length (Codex review). */
const INLINE_CODE = /(?<!`)(`+)([^`\n]|[^\n]*?[^`\n])\1(?!`)/g;

/** A closing fence: the opening character, at least as long, and nothing after it but whitespace (Codex review). */
function closesFence(line: string, fence: string): boolean {
  const m = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(line);
  return m !== null && m[1][0] === fence[0] && m[1].length >= fence.length;
}
const DETAILS = /<details\b[^>]*>([\s\S]*?)<\/details>/gi;

/** A collapsed `<details>` takes one line on screen: only its summary counts. */
function collapseDetails(text: string): string {
  return text.replace(DETAILS, (_, inner: string) => `\n\n${/<summary\b[^>]*>([\s\S]*?)<\/summary>/i.exec(inner)?.[1] ?? ''}\n\n`);
}

/**
 * Remove what the shape rules do not measure: fenced code, `<details>` blocks, table rows and blockquotes. Each is
 * replaced by a blank line, so the text on either side stays a separate paragraph. The length rule still counts them.
 */
export function stripExempt(body: string): string {
  const text = body.replace(/\r\n?/g, '\n').replace(DETAILS, '\n\n')
    // HTML code and quotes (bot --html) are exempt as their markdown forms are (Codex review).
    .replace(/<(pre|blockquote)\b[^>]*>[\s\S]*?<\/\1>/gi, '\n\n');
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of text.split('\n')) {
    const mark = FENCE.exec(line)?.[1] ?? null;
    if (fence) {
      if (closesFence(line, fence)) fence = null;
      out.push('');
      continue;
    }
    if (mark) {
      fence = mark;
      out.push('');
      continue;
    }
    if (/^\s*\|/.test(line) || /^\s{0,3}>/.test(line)) {
      out.push('');
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/** Text a reader sees: links become their label, URLs and markup are dropped, inline code keeps its content. */
/** A markdown link; the label may hold escaped or one level of nested brackets, `[fix \[i\]]`, `[fix [a]]` (Codex review). */
const MD_LINK = /(?<!\\)!?\[((?:\\.|\[(?:\\.|[^[\]\\])*\]|[^[\]\\])*)\]\([^)\s]*(?:\s+"[^"]*")?\)/g;

export function visibleText(markdown: string): string {
  // Inline code renders literally: set it aside so tag, URL and entity handling cannot touch it (Codex review).
  const code: string[] = [];
  return markdown
    // Code first: link syntax inside a code span is shown as written, not as its label (Codex review).
    .replace(INLINE_CODE, (_, _ticks: string, inner: string) => `\u0000${code.push(inner) - 1}\u0000`)
    .replace(MD_LINK, (_, label: string) => label.replace(/\\([[\]])/g, '$1'))
    // So is HTML <code>/<pre>: a URL in it is shown, not hidden behind a label (Codex review).
    .replace(HTML_CODE, (_, _tag: string, inner: string) => `\u0000${code.push(decodeEntities(inner)) - 1}\u0000`)
    // Tags before URLs: an <a href="https://…"> keeps its label, which the reader sees (Codex review).
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/https?:\/\/\S+/g, '')
    // HTML bodies (bot --html) are measured as rendered: &amp; is one character (Codex review).
    .replace(ENTITY, decodeEntity)
    .replace(/\*\*|__|~~/g, '')
    // A time token shows its own label when it gives one, else a generated date of about this length (Codex review).
    .replace(/\{\{time:([^}]*)\}\}/g, (_, spec: string) => spec.split('|').slice(2).join('|').trim() || 'Mon, 1 Jan 18:00')
    .replace(/\u0000(\d+)\u0000/g, (_, i: string) => code[Number(i)]);
}

/** Visible length of a whole body, the measure of the length rule. */
export function visibleLength(body: string): number {
  const prose: string[] = [];
  const literal: string[] = [];
  let fence: string | null = null;
  // Fences first: a <details> inside a code block is literal code, not a collapsed section (Codex review).
  for (const line of body.replace(/\r\n?/g, '\n').split('\n')) {
    const mark = FENCE.exec(line)?.[1] ?? null;
    if (fence) {
      if (closesFence(line, fence)) fence = null;
      else literal.push(line); // fenced code renders as written, markup and URLs included (Codex review)
      continue;
    }
    if (mark) {
      fence = mark;
      continue;
    }
    if (/^(?: {4}|\t)\S/.test(line)) {
      literal.push(line); // four-space indented code renders as written, as proseOnly treats it (Codex review)
      continue;
    }
    if (/^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line)) continue; // a table's separator row
    // Table pipes become spaces, but not the separators inside a {{time:…|format|label}} token.
    prose.push(line.replace(/^\s{0,3}(?:>\s?|#{1,6}\s)/, '').replace(/\{\{time:[^}]*\}\}|\|/g, (m) => (m === '|' ? ' ' : m)));
  }
  return graphemes(flat([visibleText(collapseDetails(prose.join('\n'))), ...literal].join(' ')));
}

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Characters as a reader counts them: one emoji or accented letter is one, whatever its UTF-16 length (Codex review). */
export function graphemes(text: string): number {
  let n = 0;
  for (const _ of SEGMENTER.segment(text)) n++;
  return n;
}

function flat(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Paragraphs and list items. A list item is its own unit, so a long list of short bullets is not one wall. */
function units(stripped: string): Unit[] {
  const result: Unit[] = [];
  for (const block of stripped.split(/\n\s*\n/)) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    let current: Unit | null = null;
    for (const line of lines) {
      if (HEADING.test(line)) {
        if (current) result.push(current);
        result.push({ text: line.replace(HEADING, ''), kind: 'heading' });
        current = null;
      } else if (LIST_ITEM.test(line)) {
        if (current) result.push(current);
        current = { text: line.replace(LIST_ITEM, ''), kind: 'item' };
      } else if (current) {
        current.text += `\n${line.trim()}`;
      } else {
        current = { text: line.trim(), kind: 'paragraph' };
      }
    }
    if (current) result.push(current);
  }
  return result;
}

// Abbreviations that end in a dot without ending a sentence. With a limit of 3, an overcount refuses a good paragraph,
// so ones that can also close a sentence (etc., и т.д., и т.п., и др.) are treated as never closing one.
const ABBREVIATIONS = /(?:^|[\s(])(?:e\.g|i\.e|etc|vs|cf|approx|Mr|Mrs|Ms|Dr|St|No|Nr|App|Sec|Fig|Ch|Vol|Inc|Ltd|т\.е|т\.к|т\.д|т\.п|т\.н|др|пр|см|напр|г|гг|ст|стр|рис|им|ул|д|ok)\.$/i;

/**
 * Sentences in a paragraph: split on . ! ? followed by whitespace and a word that is not lowercase. Never split: dots
 * with no space after them (1.2.3, 0.5, SKILL.md, api.github.com), abbreviations, initials (А. Иванов), ellipses.
 */
export function countSentences(paragraph: string): number {
  // Code and URLs become a word, so a dot inside them never ends a sentence.
  const text = flat(visibleText(paragraph.replace(INLINE_CODE, 'code').replace(/https?:\/\/\S+/g, 'link')));
  if (!text) return 0;
  let count = 0;
  let start = 0;
  const boundary = /[.!?…]+(?=\s+(\S))/g;
  let m: RegExpExecArray | null;
  while ((m = boundary.exec(text)) !== null) {
    const end = m.index + m[0].length;
    const next = m[1];
    // A lowercase continuation ("т.е. так", "e.g. this", "etc. and") is not a new sentence.
    if (/\p{Ll}/u.test(next)) continue;
    // An ellipsis is a pause inside a sentence, not its end.
    if (/^(?:…|\.{2,})$/.test(m[0])) continue;
    const before = text.slice(start, end);
    // A dot after an abbreviation or a single capital initial ("A. Smith") does not end one either.
    if (m[0] === '.' && (ABBREVIATIONS.test(before) || /(?:^|\s)\p{Lu}\.$/u.test(before))) continue;
    if (/\p{L}/u.test(before)) count++;
    start = end;
  }
  if (/\p{L}/u.test(text.slice(start))) count++;
  return count;
}

/** Numbered points run together inside one paragraph: "(1) … (2) …" or "1) … 2) …". */
export function hasInlineNumbering(paragraph: string): boolean {
  const text = flat(visibleText(paragraph));
  const paren = /(?:^|[\s:;,—–-])\(1\)\s[\s\S]*?(?:^|[\s:;,—–-])\(2\)\s/;
  const half = /(?:^|[\s:;,—–-])1\)\s[\s\S]*?[\s:;,—–-]2\)\s/;
  return paren.test(text) || half.test(text);
}

/** Text outside fenced code, inline code, link targets and URLs: where bare ids and question marks are looked for. */
function proseOnly(body: string): string {
  // HTML code (bot --html) first, so a fence line inside <pre> cannot swallow the prose after it (Codex review).
  return stripCodeFences(body.replace(HTML_CODE, ' '))
    // Four-space indented lines are code, as the rich path treats them (Codex review).
    .replace(/^(?: {4}|\t)[^\n]*$/gm, ' ')
    .replace(MD_LINK, ' ')
    .replace(INLINE_CODE, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/<a\b[\s\S]*?<\/a>/gi, ' ');
}

function stripCodeFences(body: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of body.replace(/\r\n?/g, '\n').split('\n')) {
    const mark = FENCE.exec(line)?.[1] ?? null;
    if (fence) {
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    if (mark) {
      fence = mark;
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/** Upper-case prefixes that look like a ticket key in "AES-256" but name a standard, product or encoding. */
const NOT_TICKET_KEYS = [
  'AES', 'ANSI', 'API', 'ARM', 'ASCII', 'BS', 'CPU', 'COVID', 'CVE', 'DDR', 'DIN', 'EAN', 'ECMA', 'ES', 'FIPS', 'GPT',
  'GPU', 'GTX', 'HDMI', 'HTTP', 'HTTPS', 'IEC', 'IEEE', 'IPV', 'ISBN', 'ISO', 'JPEG', 'LTE', 'MD', 'MPEG', 'NIST', 'PCI',
  'PEP', 'POSIX', 'RFC', 'RSA', 'RTX', 'SHA', 'SQL', 'SSL', 'TLS', 'USB', 'UTC', 'UTF', 'WPA',
];

// PR numbers first, so "PR #325" is one finding; hashtags (#task, #claude) never match, as a reference needs digits.
const BARE_IDS: RegExp[] = [
  /\bPR\s*#?\d+\b/gi,
  /(?<![\w/#&])#\d+\b/g,
  // Jira-style keys: a letters-only project key and a number of 2+ digits (PROJ-4393, NF-327). Product, standard and
  // encoding names share the shape (GPT-5 has one digit; AES-256, COVID-19 are listed) and are not tickets (Codex review).
  new RegExp(`\\b(?!(?:${NOT_TICKET_KEYS.join('|')})-)[A-Z]{2,10}-\\d{2,}\\b`, 'g'),
];
const BARE_HASH = /(?<![\w/.-])(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40}(?![\w/-]|\.\w)/g;

/** Bare PR numbers, #123 references and ticket keys outside link labels and code: refused. Deduplicated, in order. */
export function findBareIds(body: string): string[] {
  const found = new Set<string>();
  let rest = proseOnly(body);
  // Each match consumed, so "PR #325" is reported once and not again as "#325".
  for (const re of BARE_IDS) {
    rest = rest.replace(re, (m) => {
      found.add(m);
      return ' ';
    });
  }
  return [...found];
}

/** Bare commit hashes outside links and code: a warning only, since a hex-looking word is often not a commit. */
export function findBareHashes(body: string): string[] {
  return [...new Set(proseOnly(body).match(BARE_HASH) ?? [])];
}

/** Team shorthand a reader outside the review has to decode: P0–P3, rule-7. */
export function findShorthand(body: string): string[] {
  const text = proseOnly(body);
  return [...new Set([...text.matchAll(/(?<![\w-])(?:P[0-3]|rule-?\d+)(?![\w-])/gi)].map((m) => m[0]))];
}

function excerpt(text: string, max = 140): string {
  const f = flat(text);
  return f.length > max ? `${f.slice(0, max - 1)}…` : f;
}

/** The title opening the message: the bold span or heading on its first line (after any @mentions), or null. */
export function openingTitle(stripped: string): string | null {
  const first = stripped.split('\n').find((l) => l.trim() !== '');
  if (!first) return null;
  if (HEADING.test(first)) return first.replace(HEADING, '').trim();
  const line = first.trim().replace(/^(?:@\w+[\s,]+)+/, '').replace(/^\p{Extended_Pictographic}️?\s*/u, '');
  // **Title**, __Title__, <b>Title</b>, or a bold link [**Title**](url).
  const m = /^(?:\*\*(.+?)\*\*|__(.+?)__|<(?:b|strong)>(.+?)<\/(?:b|strong)>|\[\*\*(.+?)\*\*\]\([^)]*\))/i.exec(line);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? m[4] ?? null;
}

/** Only #hashtags and @mentions: the tag line closing a message, which needs no title. */
const TAG_LINE = /^(?:[#@][\p{L}\p{N}_]+[\s,]*)+$/u;

/**
 * Whether a prose paragraph carries its title: it opens with a bold phrase, or the unit before it is a heading or a
 * title-only line ("**Why it broke.**" on a line of its own, then the paragraph). A tag line needs none.
 */
function titledParagraph(unit: Unit, previous: Unit | undefined): boolean {
  if (TAG_LINE.test(flat(unit.text))) return true;
  if (openingTitle(unit.text) !== null) return true;
  if (!previous) return false;
  if (previous.kind === 'heading') return true;
  if (previous.kind !== 'paragraph') return false;
  const title = openingTitle(previous.text);
  return title !== null && flat(visibleText(previous.text)).replace(/^(?:@\w+[\s,]+)+/, '') === flat(visibleText(title));
}

/** A paragraph's text after its opening bold title (and any @mentions before it). */
function withoutTitle(text: string): string {
  return text.trim()
    .replace(/^(?:@\w+[\s,]+)*\p{Extended_Pictographic}?\uFE0F?\s*(?:\*\*.+?\*\*|__.+?__|<(?:b|strong)>.+?<\/(?:b|strong)>|\[\*\*.+?\*\*\]\([^)]*\))/iu, '');
}

/** A one-line closing like "Reply A or B." or a short sign-off. */
function isSignOff(unit: Unit): boolean {
  return !unit.text.includes('\n') && graphemes(flat(visibleText(unit.text))) <= MAX_SIGNOFF_CHARS;
}

/** A short line ending in a colon that introduces the list right after it ("Writers covered:"): part of that list. */
function leadIn(unit: Unit, next: Unit | undefined): boolean {
  const text = flat(visibleText(unit.text));
  return next?.kind === 'item' && text.endsWith(':') && graphemes(text) <= MAX_TITLE_CHARS;
}

/** Check a message body. Refusals block the send (unless overridden); warnings are printed and the send goes ahead. */
export function checkMessageFormat(body: string): FormatReport {
  const visibleChars = visibleLength(body);
  const stripped = stripExempt(body);
  const refusals: FormatFinding[] = [];
  const warnings: FormatFinding[] = [];

  if (visibleChars > MAX_MESSAGE_CHARS) {
    refusals.push({
      rule: 'length',
      message: `The message is ${visibleChars} visible characters; at most ${MAX_MESSAGE_CHARS} (one phone screen). `
        + `Split it into at most ${MAX_SPLIT_MESSAGES} messages by meaning, conclusion first, each titled "1/2 · …"; `
        + 'for anything longer, send a short message plus an attached .md file.',
    });
  }

  const ids = findBareIds(body);
  if (ids.length > 0) {
    refusals.push({
      rule: 'bare-id',
      message: `Bare reference${ids.length > 1 ? 's' : ''} ${ids.slice(0, 5).map((id) => `"${id}"`).join(', ')}${ids.length > 5 ? ', …' : ''}: every PR or ticket is a link with a name, `
        + '[backend #471 — what it does](https://github.com/acme/backend/pull/471) or '
        + '[PROJ-4393 — title](https://yourcompany.atlassian.net/browse/PROJ-4393).',
    });
  }

  const shaped = visibleChars > SHAPE_MIN_CHARS;
  const parts = units(stripped);

  if (shaped) {
    // The opening block itself must carry the title: a quote, code or table first is not a title, even if one follows
    // once the exempt blocks are stripped (Codex review).
    const opening = body.replace(/\r\n?/g, '\n').trim().split(/\n\s*\n/)[0] ?? '';
    const title = stripExempt(opening).trim() === '' ? null : openingTitle(stripped);
    if (title === null) {
      const first = stripped.split('\n').find((l) => l.trim() !== '') ?? '';
      refusals.push({ rule: 'title', message: `A message over ${SHAPE_MIN_CHARS} characters must open with a bold title (**Title.** or a # heading); the first line has none.`, excerpt: excerpt(first) });
    } else {
      const chars = graphemes(flat(visibleText(title)));
      if (chars > MAX_TITLE_CHARS) {
        refusals.push({ rule: 'title', message: `The title is ${chars} characters; at most ${MAX_TITLE_CHARS}.`, excerpt: excerpt(title) });
      }
    }
  }

  // The last unit that is not a tag line: a short sign-off there needs no title.
  let lastProse = parts.length - 1;
  while (lastProse >= 0 && TAG_LINE.test(flat(parts[lastProse].text))) lastProse--;

  parts.forEach((unit, index) => {
    if (unit.kind === 'heading') return;
    const chars = graphemes(flat(visibleText(unit.text)));
    // The bold title is a label, not a sentence: "**Why it broke.** A. B. C." is three sentences.
    const sentences = countSentences(withoutTitle(unit.text));
    if (shaped) {
      if (unit.kind === 'paragraph' && index > 0 && !titledParagraph(unit, parts[index - 1]) && !leadIn(unit, parts[index + 1])
        && !(index === lastProse && isSignOff(unit))) {
        refusals.push({ rule: 'block-title', message: 'A paragraph has no bold title: open it with one, like **Why it broke.**', excerpt: excerpt(unit.text, 60) });
      }
      if (unit.kind === 'item' && chars > MAX_BULLET_CHARS) {
        refusals.push({ rule: 'bullet', message: `A bullet is ${chars} characters; at most ${MAX_BULLET_CHARS}.`, excerpt: excerpt(unit.text) });
        return;
      }
      if (unit.kind === 'paragraph' && chars > MAX_PARAGRAPH_CHARS) {
        refusals.push({ rule: 'paragraph', message: `A paragraph is ${chars} characters; at most ${MAX_PARAGRAPH_CHARS}.`, excerpt: excerpt(unit.text) });
        return;
      }
      if (sentences > MAX_PARAGRAPH_SENTENCES) {
        refusals.push({ rule: 'sentences', message: `A ${unit.kind === 'item' ? 'bullet' : 'paragraph'} has ${sentences} sentences; at most ${MAX_PARAGRAPH_SENTENCES}.`, excerpt: excerpt(unit.text) });
        return;
      }
      if (hasInlineNumbering(unit.text)) {
        refusals.push({ rule: 'inline-list', message: 'Numbered points run inline, "(1) … (2) …": make them "- " bullets, one per line.', excerpt: excerpt(unit.text) });
        return;
      }
    }
    if (sentences >= WARN_PARAGRAPH_SENTENCES && sentences <= MAX_PARAGRAPH_SENTENCES) {
      warnings.push({ rule: 'dense', message: `A paragraph has ${sentences} sentences; one idea per paragraph reads easier.`, excerpt: excerpt(unit.text, 80) });
    }
  });

  // A numbered question ("**1. …?**" or "1. …?") is the format; only loose ones count.
  const questions = (proseOnly(body).split('\n').filter((l) => !/^\s*(?:\*\*|__)?\d{1,2}[.)]\s/.test(l)).join('\n').match(/[?？]/g) ?? []).length;
  if (questions > MAX_QUESTIONS) {
    warnings.push({ rule: 'questions', message: `${questions} questions outside a numbered list: number them (**1. …?**) and give options as lettered bullets (- **A (recommended):** …).` });
  }

  const hashes = findBareHashes(body);
  if (hashes.length > 0) {
    warnings.push({ rule: 'bare-hash', message: `Bare commit hash${hashes.length > 1 ? 'es' : ''} ${hashes.slice(0, 5).join(', ')}: link the commit, [repo abc1234 — what it changes](url).` });
  }

  const board = stripCodeFences(body).split('\n').filter((l) => /^\s*(?:[-*+•]\s+)?(?:✅|🔴)/u.test(l));
  if (board.length >= STATUS_BOARD_LINES) {
    warnings.push({ rule: 'status-board', message: `${board.length} lines start with ✅/🔴: a status board, not sentences. Say what happened in plain words.`, excerpt: excerpt(board[0]) });
  }

  const shorthand = findShorthand(body);
  if (shorthand.length > 0) {
    warnings.push({ rule: 'shorthand', message: `Shorthand ${shorthand.slice(0, 5).join(', ')}: say what it means in plain words.` });
  }

  return { refusals, warnings, visibleChars };
}

/** The format: printed on every refusal and in the help of every gated command. */
export const FORMAT_RULES = [
  `At most ${MAX_MESSAGE_CHARS} characters per message, one phone screen. Longer: split into at most ${MAX_SPLIT_MESSAGES} messages by meaning, conclusion first, each titled "1/2 · …". Even longer: a short message plus an attached .md file.`,
  `Open with a bold title of ${MAX_TITLE_CHARS} characters or less.`,
  'Plan the message as titled blocks first: each paragraph opens with a bold title (**Why it broke.**), then at most 3 sentences.',
  `One idea per paragraph: at most 3 sentences and ${MAX_PARAGRAPH_CHARS} characters, with a blank line between blocks.`,
  `Lists are "- " bullets, one item per line, each ${MAX_BULLET_CHARS} characters or less; never inline (1)(2).`,
  'Questions are numbered (**1. …?**), options are lettered bullets (- **A (recommended):** …, - **B:** …), each with its consequence; end with \'Reply A or B.\'',
  'Every PR, ticket or commit is a link with a name, like [backend #471 — session address fix](url). Never a bare id.',
  'Plain words in a colleague\'s voice. No ✅ boards, no P1/rule-7 shorthand.',
  'Not too short: explain the reason and consequence so the reader can act.',
];

/** The corrected example a refusal prints; a test keeps it passing its own check with no warnings. */
export const FORMAT_EXAMPLE = `**Release on hold until the backend refuses cleanly.**

[PROJ-4393 — refuse forbidden combinations](https://example.atlassian.net/browse/PROJ-4393) stays on dev for now. A refused row must not fail the whole sync batch, or a driver cannot tell whether the log was saved.

**What we check.** The status code a refused row gets, for every writer:
- mobile and web
- dashboard and email-service

**Next.** I post the go/no-go here when the check is done.`;

/** The refusal text: what failed (actual vs allowed, with an excerpt), the rules, a corrected example and the override. */
export function formatRefusal(report: FormatReport): string {
  const lines: string[] = ['Not sent: the message does not follow the Telegram format.', ''];
  for (const r of report.refusals) {
    lines.push(`- ${r.message}`);
    if (r.excerpt) lines.push(`    "${r.excerpt}"`);
  }
  lines.push('', 'The format:', ...FORMAT_RULES.map((rule) => `- ${rule}`), '', 'Example:', FORMAT_EXAMPLE, '',
    `Rewrite it and send again. To send this text as it is: --format-ok "<why>" (the reason is printed). Exit status ${FORMAT_REFUSED_EXIT_CODE}: not sent.`);
  return lines.join('\n');
}

/** Warnings, one per line, for stderr. */
export function formatWarnings(report: FormatReport): string {
  return report.warnings
    .map((w) => `Format warning (sent anyway): ${w.message}${w.excerpt ? ` "${w.excerpt}"` : ''}`)
    .join('\n');
}

/** `--format-ok` must carry a reason: an empty one is an error, not a silent bypass. */
export function parseFormatOverride(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const reason = value.trim();
  if (!reason) throw new Error('--format-ok needs a reason, e.g. --format-ok "verbatim log excerpt".');
  return reason;
}

export interface GateOutcome {
  /** False when the send must not happen; the caller exits with FORMAT_REFUSED_EXIT_CODE. */
  send: boolean;
  /** Text for stderr: the refusal, or the warnings, or nothing. */
  stderr: string;
  /** Appended to the success line: the override and its reason, so the bypass is visible. */
  note: string;
}

/**
 * An HTML body (bot --html) is parsed by Telegram as HTML only, so markdown syntax in it is literal text: a
 * `[PROJ-4393 — fix](url)` is shown as written, brackets and URL included. Swap each markdown marker for a look-alike of
 * the same length, so the checker measures it as the reader sees it and no longer reads it as a link, code or title
 * (Codex review).
 */
export function markdownAsLiteral(body: string): string {
  const swap: Record<string, string> = { '[': '\u2045', ']': '\u2046', '`': '\u02CB', '*': '\u2217', '_': '\u2017', '~': '\u223C' };
  return body
    // An entity that renders as a marker (&#42; is *) is literal too: swap it before markdown handling sees it (Codex review).
    .replace(ENTITY, (m: string, dec?: string, hex?: string, name?: string) => swap[decodeEntity(m, dec, hex, name)] ?? m)
    .replace(/[[\]`*_~]/g, (c) => swap[c]!)
    // Only heading and table syntax: a "#claude" or "#471" line is ordinary text in either mode.
    .replace(/^(\s*)(#{1,6})(?=\s)/gm, (_, lead: string, marks: string) => lead + '\uFF03'.repeat(marks.length))
    .replace(/^(\s*)\|/gm, '$1\u2502');
}

/** Everything a command needs: check unless overridden, and say what to print. `html`: the body is parsed as HTML. */
export function gateMessage(body: string, override: string | undefined, html = false, timeLiteral = false): GateOutcome {
  const reason = parseFormatOverride(override);
  if (reason !== undefined) return { send: true, stderr: '', note: ` (format override: ${reason})` };
  let text = html ? markdownAsLiteral(body) : body;
  // Only account sends expand {{time:…}}; the bot sends the token as written, so it is measured as written (Codex review).
  if (timeLiteral) text = text.replace(/\{\{time:/g, '\uFF5B\uFF5Btime:');
  const report = checkMessageFormat(text);
  if (report.refusals.length > 0) return { send: false, stderr: formatRefusal(report), note: '' };
  return { send: true, stderr: formatWarnings(report), note: '' };
}
