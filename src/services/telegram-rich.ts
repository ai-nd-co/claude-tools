// Rich messages and local-time dates for the user account.
//
// Rich messages (layer 229) carry real structure - headings, tables, task lists,
// collapsible details - and Telegram's servers parse them from markdown, so
// sending is just the markdown string. Reading is the reverse: a rich message
// has an empty `message` and its content in `richMessage.blocks`, which is
// rendered back to markdown here so read/search/watch show it as text.
//
// Dates use `{{time:...}}` tokens in the message body. The reader's client shows
// the moment in their own time zone and locale; the token's label is what
// clients that cannot render the date fall back to.

/** Telegram's cap on the text of one rich message. */
export const RICH_MESSAGE_MAX_CHARS = 32768;

/** Team times are Tashkent times unless an offset says otherwise (UTC+5, no DST). */
const DEFAULT_OFFSET = '+05:00';
const DEFAULT_FORMAT = 'wDt';

const TIME_TOKEN = /\{\{time:([^|}]+)(?:\|([^|}]*))?(?:\|([^}]*))?\}\}/g;
const FORMAT_RE = /^(r|w?[dD]?[tT]?)$/;

export interface DateFlags {
  relative?: boolean;
  dayOfWeek?: boolean;
  shortDate?: boolean;
  longDate?: boolean;
  shortTime?: boolean;
  longTime?: boolean;
}

export interface TimeToken {
  unix: number;
  format: string;
  label: string;
}

/**
 * Parse the moment in a time token: unix seconds, an ISO timestamp with an
 * offset, or a bare `YYYY-MM-DD[ HH:MM[:SS]]` taken as Tashkent time.
 */
export function parseWhen(raw: string): number {
  const value = raw.trim();
  if (/^\d{9,11}$/.test(value)) return Number(value);

  const bare = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2})?))?$/.exec(value);
  const iso = bare ? `${bare[1]}T${bare[2] ?? '00:00'}${DEFAULT_OFFSET}` : value.replace(' ', 'T');
  const ms = Date.parse(iso);
  if (Number.isNaN(ms) || !(bare || /(Z|[+-]\d{2}:?\d{2})$/i.test(value))) {
    throw new Error(`Invalid time "${raw}" in {{time:...}}. Use 2026-09-26 18:00 (Tashkent), 2026-09-26T13:00Z, or unix seconds.`);
  }
  return Math.floor(ms / 1000);
}

export function formatToFlags(format: string): DateFlags {
  if (!FORMAT_RE.test(format)) {
    throw new Error(`Invalid time format "${format}". Use r, or any of w, d|D, t|T in that order (e.g. wDt).`);
  }
  return {
    relative: format === 'r' || undefined,
    dayOfWeek: format.includes('w') || undefined,
    shortDate: format.includes('d') || undefined,
    longDate: format.includes('D') || undefined,
    shortTime: format.includes('t') || undefined,
    longTime: format.includes('T') || undefined,
  };
}

/** The fallback text: the moment as the team reads it, in Tashkent. */
export function tashkentLabel(unix: number): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tashkent',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(unix * 1000));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('weekday')} ${get('day')} ${get('month')} ${get('hour')}:${get('minute')} Tashkent`;
}

function readToken(match: RegExpExecArray): TimeToken {
  const unix = parseWhen(match[1]);
  const format = (match[2] ?? DEFAULT_FORMAT).trim();
  formatToFlags(format);
  const label = match[3]?.trim() || tashkentLabel(unix);
  return { unix, format, label };
}

export function hasTimeTokens(text: string): boolean {
  TIME_TOKEN.lastIndex = 0;
  return TIME_TOKEN.test(text);
}

/** Rich markdown: each token becomes Telegram's `![label](tg://time?...)` date. */
export function expandTimeTokensForRich(markdown: string): string {
  return markdown.replace(TIME_TOKEN, (...args) => {
    const token = readToken(args as unknown as RegExpExecArray);
    const format = token.format ? `&format=${token.format}` : '';
    return `![${token.label.replace(/[[\]]/g, '')}](tg://time?unix=${token.unix}${format})`;
  });
}

/**
 * Rich markdown as the team writes it, made safe for Telegram's parser.
 *
 * Two things Telegram's markdown does differently from a plain message, both
 * measured against the live API on 2026-09-28:
 *
 *  - A line that STARTS with `#tag` is parsed as a heading. The `#` is dropped,
 *    no hashtag is created, and hashtag search no longer finds the message -
 *    which broke `#task` / `#issue` / `#pr` at the end of every notification.
 *    Escaping the `#` keeps it a real, searchable hashtag. A heading needs a
 *    space after its `#`, so `# Title` and `## Title` are left alone.
 *  - A single newline inside a paragraph is a soft break and renders as a
 *    space, so `Assignee: @a` / `cc: @b` on two lines arrive as one line.
 *    A trailing backslash makes it a hard break.
 *
 * Fenced code, tables, lists, headings, quotes, dividers and HTML are passed
 * through untouched.
 */
export function prepareRichMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let fence: string | null = null;

  const isFence = (line: string) => /^\s{0,3}(```+|~~~+)/.exec(line)?.[1] ?? null;
  // A line that is its own block, or continues one: never joined with a hard break.
  const isStructural = (line: string) =>
    /^\s*$/.test(line) ||
    /^\s{0,3}#{1,6}(\s|$)/.test(line) || // heading
    /^\s*\|/.test(line) || // table row
    /^\s*([-*+]|\d+[.)])\s/.test(line) || // list item
    /^\s{0,3}>/.test(line) || // quote
    /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line) || // divider
    /^\s{0,3}<\/?[a-zA-Z]/.test(line) || // html block
    /^\s{4,}\S/.test(line) || // indented continuation / code
    /^\s{0,3}(=+|-+)\s*$/.test(line); // setext underline

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const mark = isFence(line);
    if (fence) {
      if (mark && mark[0] === fence[0] && mark.length >= fence.length) fence = null;
      out.push(line);
      continue;
    }
    if (mark) {
      fence = mark;
      out.push(line);
      continue;
    }

    // `#tag` at the start of a line: keep it a hashtag, not a heading.
    line = line.replace(/^(\s{0,3})#(?=[^\s#])/, '$1\\#');

    const next = lines[i + 1];
    const alreadyHard = /(\\| {2,})$/.test(line);
    if (
      next !== undefined &&
      !alreadyHard &&
      !isStructural(line) &&
      !isStructural(next) &&
      !isFence(next)
    ) {
      line = `${line}\\`;
    }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * Plain messages: each token becomes its label, and the dates are returned in
 * order so the caller can attach date entities once the text is parsed.
 */
export function extractTimeTokens(text: string): { text: string; dates: TimeToken[] } {
  const dates: TimeToken[] = [];
  const out = text.replace(TIME_TOKEN, (...args) => {
    const token = readToken(args as unknown as RegExpExecArray);
    dates.push(token);
    return token.label;
  });
  return { text: out, dates };
}

/**
 * Locate each date's label in the final (parsed) text, in order. Offsets are
 * UTF-16 code units, which is what both JS strings and Telegram use.
 */
export function locateDates(parsed: string, dates: TimeToken[]): Array<TimeToken & { offset: number; length: number }> {
  const located: Array<TimeToken & { offset: number; length: number }> = [];
  let from = 0;
  for (const date of dates) {
    const offset = parsed.indexOf(date.label, from);
    if (offset < 0) continue;
    located.push({ ...date, offset, length: date.label.length });
    from = offset + date.label.length;
  }
  return located;
}

// ---------------------------------------------------------------------------
// Reading: RichMessage -> markdown

type Tl = { className?: string; [key: string]: any };

export function richTextToMarkdown(node: Tl | string | undefined): string {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string') return node;

  const inner = () => richTextToMarkdown(node.text);
  switch (node.className) {
    case 'TextEmpty': return '';
    case 'TextPlain': return String(node.text ?? '');
    case 'TextConcat': return (node.texts ?? []).map(richTextToMarkdown).join('');
    case 'TextBold': return `**${inner()}**`;
    case 'TextItalic': return `_${inner()}_`;
    case 'TextStrike': return `~~${inner()}~~`;
    case 'TextFixed': return `\`${inner()}\``;
    case 'TextSpoiler': return `||${inner()}||`;
    case 'TextMarked': return `==${inner()}==`;
    case 'TextUrl': return `[${inner()}](${node.url})`;
    case 'TextMath': return `$${node.source}$`;
    case 'TextCustomEmoji': return node.alt ?? '';
    case 'TextImage': return '[image]';
    default:
      // Underline, links to emails/phones, mentions, dates, anchors, buttons...:
      // the wrapped text is what a reader needs.
      return node.text !== undefined ? inner() : '';
  }
}

function caption(c: Tl | undefined): string {
  const text = c ? richTextToMarkdown(c.text) : '';
  return text ? ` ${text}` : '';
}

function tableToMarkdown(block: Tl): string {
  const rows: string[][] = (block.rows ?? []).map((row: Tl) => {
    const cells: string[] = [];
    for (const cell of row.cells ?? []) {
      cells.push(richTextToMarkdown(cell.text).replace(/\|/g, '\\|').replace(/\n/g, ' '));
      for (let i = 1; i < (cell.colspan ?? 1); i++) cells.push('');
    }
    return cells;
  });
  if (rows.length === 0) return '';

  const width = Math.max(...rows.map((r) => r.length));
  const line = (r: string[]) => `| ${[...r, ...Array(width - r.length).fill('')].join(' | ')} |`;
  const title = richTextToMarkdown(block.title);
  return [
    ...(title ? [`**${title}**`] : []),
    line(rows[0]),
    `|${' --- |'.repeat(width)}`,
    ...rows.slice(1).map(line),
  ].join('\n');
}

function listItem(item: Tl, marker: string): string {
  const box = item.checkbox ? (item.checked ? '[x] ' : '[ ] ') : '';
  const body = item.blocks ? blocksToMarkdown(item.blocks, ' ') : richTextToMarkdown(item.text);
  return `${marker} ${box}${body}`;
}

export function blockToMarkdown(block: Tl): string {
  const text = () => richTextToMarkdown(block.text);
  switch (block.className) {
    case 'PageBlockTitle':
    case 'PageBlockHeading1': return `# ${text()}`;
    case 'PageBlockSubtitle':
    case 'PageBlockHeader':
    case 'PageBlockHeading2': return `## ${text()}`;
    case 'PageBlockSubheader':
    case 'PageBlockHeading3': return `### ${text()}`;
    case 'PageBlockHeading4': return `#### ${text()}`;
    case 'PageBlockHeading5': return `##### ${text()}`;
    case 'PageBlockHeading6': return `###### ${text()}`;
    case 'PageBlockParagraph':
    case 'PageBlockKicker':
    case 'PageBlockFooter': return text();
    case 'PageBlockThinking': return `_(thinking) ${text()}_`;
    case 'PageBlockPreformatted': return `\`\`\`${block.language ?? ''}\n${text()}\n\`\`\``;
    case 'PageBlockDivider': return '---';
    case 'PageBlockAnchor': return '';
    case 'PageBlockMath': return `$$${block.source}$$`;
    case 'PageBlockAuthorDate': return richTextToMarkdown(block.author);
    case 'PageBlockList': return (block.items ?? []).map((i: Tl) => listItem(i, '-')).join('\n');
    case 'PageBlockOrderedList':
      return (block.items ?? []).map((i: Tl, n: number) => listItem(i, `${i.num ?? n + (block.start ?? 1)}.`)).join('\n');
    case 'PageBlockBlockquote':
    case 'PageBlockPullquote':
      return `${text()}${caption({ text: block.caption })}`.split('\n').map((l) => `> ${l}`).join('\n');
    case 'PageBlockBlockquoteBlocks':
      return blocksToMarkdown(block.blocks ?? []).split('\n').map((l) => `> ${l}`).join('\n');
    case 'PageBlockDetails':
      return `▸ ${richTextToMarkdown(block.title)}\n${blocksToMarkdown(block.blocks ?? [])}`;
    case 'PageBlockTable': return tableToMarkdown(block);
    case 'PageBlockPhoto': return `[photo]${caption(block.caption)}`;
    case 'PageBlockVideo': return `[video]${caption(block.caption)}`;
    case 'PageBlockAudio': return `[audio]${caption(block.caption)}`;
    case 'PageBlockDocument': return `[document]${caption(block.caption)}`;
    case 'PageBlockMap': return `[map]${caption(block.caption)}`;
    case 'PageBlockCollage':
    case 'PageBlockSlideshow': return `[${(block.items ?? []).length} media]${caption(block.caption)}`;
    case 'PageBlockButtonRow':
      return (block.buttons ?? []).map((b: Tl) => `[${richTextToMarkdown(b.text)}]`).join(' ');
    default: return `[${block.className ?? 'block'}]`;
  }
}

export function blocksToMarkdown(blocks: Tl[], separator = '\n\n'): string {
  return blocks.map(blockToMarkdown).filter((s) => s.length > 0).join(separator);
}

export function richMessageToMarkdown(rich: Tl | undefined): string {
  return rich?.blocks ? blocksToMarkdown(rich.blocks) : '';
}

/**
 * Where an exported message's `text` came from, so a caller can tell a blank message from one it cannot read:
 * `plain` (the message field; `entities` describe its formatting), `rich-markdown` (a rich message's block tree
 * rendered as markdown; its formatting is IN the text and `entities` is empty by design), `rich-unreadable` (a rich
 * message whose blocks rendered to nothing - the content exists and this path cannot show it), `none` (no text).
 */
export type ExportTextFormat = 'plain' | 'rich-markdown' | 'rich-unreadable' | 'none';

/** The text an export records for a message, and where it came from. */
export function exportedText(msg: { message?: string; richMessage?: Tl } | null | undefined): { text: string; textFormat: ExportTextFormat } {
  if (msg?.message) return { text: msg.message, textFormat: 'plain' };
  if (msg?.richMessage) {
    const text = richMessageToMarkdown(msg.richMessage);
    return text ? { text, textFormat: 'rich-markdown' } : { text: '', textFormat: 'rich-unreadable' };
  }
  return { text: '', textFormat: 'none' };
}

/** A message's readable text: its plain text, or its rich content as markdown. */
export function messageText(msg: { message?: string; richMessage?: Tl } | null | undefined): string {
  if (!msg) return '';
  if (msg.message) return msg.message;
  return richMessageToMarkdown(msg.richMessage);
}
