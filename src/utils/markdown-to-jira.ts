// Convert markdown to JIRA wiki markup
// JIRA API v2 uses wiki markup format for descriptions

/**
 * Convert markdown text to JIRA wiki markup
 *
 * Conversions:
 * - # Heading -> h1. Heading
 * - ## Heading -> h2. Heading
 * - **bold** -> *bold*
 * - *italic* or _italic_ -> _italic_
 * - `code` -> {{code}}
 * - ```code block``` -> {code}...{code}
 * - - item -> * item
 * - [text](url) -> [text|url]
 * - > quote -> {quote}...{quote}
 *
 * Emphasis and code interact, so both directions mask code spans and blocks out of the
 * string before any emphasis rule runs, then restore them. Without that masking three
 * things went wrong, all observed in filed tickets:
 *
 *   1. `**bold**` became Jira ITALIC. The bold rule produced `*bold*` and the italic
 *      rule immediately re-matched its own output. Bold was unreachable, and bold and
 *      italic collapsed to the same markup.
 *   2. An asterisk inside the span defeated bold entirely: `**a `*.x` b**` kept its
 *      literal `**` because the bold pattern could not cross the `*`.
 *   3. Reading back, `_` inside `{{...}}` or `{code}` was rewritten to `*`, so
 *      `{{20260616164918_create_..._rpc.sql}}` displayed as a filename that does not
 *      exist. That made `jira show` unsafe to verify a description with.
 */
/**
 * Placeholders for text that later rules must not see. Each is `<sentinel><index><sentinel>`, where the
 * sentinel is a Unicode private-use character chosen to be ABSENT from the input, so real text can never be
 * mistaken for a placeholder (Codex review: a fixed \u0000 could occur in a JS string and collide).
 */
class Placeholders {
  private readonly values: string[] = [];
  readonly sentinel: string;

  constructor(input: string, avoid: string[] = []) {
    let code = 0xe000;
    while (input.includes(String.fromCharCode(code)) || avoid.includes(String.fromCharCode(code))) code += 1;
    this.sentinel = String.fromCharCode(code);
  }

  /** Store `value` (already in its final form) and return the placeholder that stands for it. */
  hold(value: string): string {
    this.values.push(value);
    return `${this.sentinel}${this.values.length - 1}${this.sentinel}`;
  }

  /**
   * Put every held value back, in ONE pass: a restored value is never rescanned, so a placeholder can never
   * be captured inside another and leak into the output. An index that was never issued is left as it is.
   */
  restore(text: string): string {
    const pattern = new RegExp(`${this.sentinel}(\\d+)${this.sentinel}`, 'g');
    return text.replace(pattern, (match, index) => {
      const value = this.values[Number(index)];
      return value === undefined ? match : value;
    });
  }
}

export function markdownToJira(markdown: string): string {
  if (!markdown) return markdown;

  // Code first, in ONE left-to-right pass over the original text, so spans cannot overlap or nest: a fenced
  // block or an inline span is converted to its Jira form and held out of reach of every rule below. Text
  // inside inline code that looks like a Jira code block stays literal (Codex review: masking the converted
  // output in two passes nested one placeholder inside another and leaked it).
  const code = new Placeholders(markdown);
  // URLs (a link's destination, or a bare one) are held verbatim in the same pass: a `*` or `~~` in a query
  // string is not emphasis, and converting it points the link somewhere else (Codex review). A bare URL never
  // ends on an emphasis marker or punctuation, and holds `**` only as a path glob right after a `/`, so
  // `**see https://x.io**` and `**https://x.io**/health` still close their bold while `.../artifact/**/*zip*/`
  // stays whole.
  let result = markdown.replace(
    /```(\w*)\n([\s\S]*?)```|`([^`\n]+)`|\]\(([^)\s]+)\)|(https?:\/\/(?:[^\s<>()[\]*]|(?<=\/)\*\*|\*(?!\*))*[^\s<>()[\]*_~.,;:!?'"])/g,
    (_match, lang, block, inline, dest, url) => {
      if (dest !== undefined) return `](${code.hold(dest)})`;
      if (url !== undefined) return code.hold(url);
      if (inline !== undefined) return code.hold(`{{${inline}}}`);
      const langAttr = lang ? `:${lang}` : '';
      return code.hold(`{code${langAttr}}\n${String(block).trim()}\n{code}`);
    },
  );

  // Headers (must handle before bold since # could conflict)
  result = result.replace(/^######\s+(.+)$/gm, 'h6. $1');
  result = result.replace(/^#####\s+(.+)$/gm, 'h5. $1');
  result = result.replace(/^####\s+(.+)$/gm, 'h4. $1');
  result = result.replace(/^###\s+(.+)$/gm, 'h3. $1');
  result = result.replace(/^##\s+(.+)$/gm, 'h2. $1');
  result = result.replace(/^#\s+(.+)$/gm, 'h1. $1');

  // Bold: **text** -> *text*. Held out immediately: Jira bold is also a single `*`, so leaving it in the string
  // would let the italic rule below re-match it and silently turn every bold into italic. Italic INSIDE the bold
  // span is converted first (Codex review: holding the whole span hid `*italic*` in `**bold *italic* text**`).
  // The span is lazy rather than [^*]+ so a lone asterisk inside it (a glob like *.example.com) does not
  // defeat the match.
  // An italic may wrap onto the next line (CommonMark does), but not across a paragraph break.
  const italic = (text: string) =>
    text.replace(/(?<!\*)\*(?!\s)((?:[^*\n]|\n(?![ \t]*\n))+)(?<!\s)\*(?!\*)/g, '_$1_');
  const bold = new Placeholders(result, [code.sentinel]);
  // A `***` run is shared by a bold and an italic, and the stars go to whichever span is still open. An odd
  // star count inside the bold means the italic opened (or closes) inside it: `**bold *italic***`,
  // `***a* b**`. Otherwise the spare star belongs to an italic around the bold: `*italic **bold***`,
  // `***a** b*`, and both spare stars together wrap the content: `***both***` (Codex review).
  // Like italic, a bold may wrap onto the next line but not across a paragraph break (cross-service review).
  result = result.replace(/(\*?)\*\*(?!\s)((?:[^\n]|\n(?![ \t]*\n))+?)\*\*(\*?)/g, (_match, lead: string, text: string, spare: string) => {
    const innerOpen = (text.match(/\*/g) ?? []).length % 2 === 1;
    if (innerOpen && lead) [text, lead] = [`*${text}`, ''];
    else if (innerOpen && spare) [text, spare] = [`${text}*`, ''];
    else if (lead && spare) [text, lead, spare] = [`*${text}*`, '', ''];
    return lead + bold.hold(`*${italic(text)}*`) + spare;
  });

  // Italic: *text* -> _text_. Bold is held out, so a remaining single `*` is italic.
  result = italic(result);

  result = bold.restore(result);

  // Strikethrough: ~~text~~ -> -text-
  result = result.replace(/~~([^~]+)~~/g, '-$1-');

  // Bullet lists: - item -> * item
  result = result.replace(/^(\s*)-\s+/gm, '$1* ');

  // Numbered lists: 1. item -> # item
  result = result.replace(/^(\s*)\d+\.\s+/gm, '$1# ');

  // Links: [text](url) -> [text|url]
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '[$1|$2]');

  // Blockquotes: > text -> {quote}text{quote}
  // Handle multi-line quotes
  const lines = result.split('\n');
  const processedLines: string[] = [];
  let inQuote = false;

  for (const line of lines) {
    if (line.startsWith('> ')) {
      if (!inQuote) {
        processedLines.push('{quote}');
        inQuote = true;
      }
      processedLines.push(line.substring(2));
    } else {
      if (inQuote) {
        processedLines.push('{quote}');
        inQuote = false;
      }
      processedLines.push(line);
    }
  }
  if (inQuote) {
    processedLines.push('{quote}');
  }
  result = processedLines.join('\n');

  // Horizontal rules: --- or *** -> ----
  result = result.replace(/^(-{3,}|\*{3,})$/gm, '----');

  return code.restore(result);
}

/**
 * Convert JIRA wiki markup back to markdown (for display)
 */
export function jiraToMarkdown(jira: string): string {
  if (!jira) return jira;

  let result = jira;

  // Code first, in ONE pass over the original markup, converted to its markdown form and held out of reach of
  // the emphasis rules. Skipping this once rewrote every `_` inside code as `*`, which turned a migration
  // filename into one that does not exist and made `jira show` unsafe for verifying a description.
  const code = new Placeholders(jira);
  // `}}(?!})`: an inline span ends at the LAST `}}` of a run, so `{{{code}}}` is monospace `{code}`, not `{code`
  // followed by a stray `}`. A block's own trailing newline is dropped, so it is not doubled on the way back.
  // URLs are held the same way: `a_b_c` in a path is not italic. Known ambiguity, left as is: Jira bold is a single
  // `*`, which is also legal inside a URL, so `*https://x.io*/health` keeps its stars. No real ticket measured hits it.
  result = result.replace(
    /\{code(?::(\w+))?\}\n?([\s\S]*?)\{code\}|\{\{([\s\S]*?)\}\}(?!\})|\|([^\]\s|]+)\]|(https?:\/\/[^\s<>()[\]|]*[^\s<>()[\]|*_\-.,;:!?'"])/g,
    (_match, lang, block, inline, dest, url) => {
      if (dest !== undefined) return `|${code.hold(dest)}]`;
      if (url !== undefined) return code.hold(url);
      return inline !== undefined
        ? code.hold(`\`${inline}\``)
        : code.hold(`\`\`\`${lang ?? ''}\n${String(block).replace(/\n$/, '')}\n\`\`\``);
    },
  );

  // Headers
  result = result.replace(/^h1\.\s+(.+)$/gm, '# $1');
  result = result.replace(/^h2\.\s+(.+)$/gm, '## $1');
  result = result.replace(/^h3\.\s+(.+)$/gm, '### $1');
  result = result.replace(/^h4\.\s+(.+)$/gm, '#### $1');
  result = result.replace(/^h5\.\s+(.+)$/gm, '##### $1');
  result = result.replace(/^h6\.\s+(.+)$/gm, '###### $1');

  // Bullet lists: * item -> - item (must be done before bold)
  // JIRA uses * at start of line for bullets
  result = result.replace(/^\*\s+/gm, '- ');

  // Bold: *text* -> **text**, at word boundaries. Bullets were converted above, so a line may start with bold.
  result = result.replace(/(?<![\p{L}\p{N}*])\*(?![\s*])([^*\n]+?)(?<!\s)\*(?![\p{L}\p{N}*])/gu, '**$1**');

  // Italic: _text_ -> *text*. As in Jira itself, a `_` opens or closes only at a word boundary, so
  // `user_id and group_id` stays put and `_redaction of api_key_` is one span. A span may wrap onto the next
  // line, but not across a paragraph break.
  result = result.replace(
    /(?<![\p{L}\p{N}_])_(?![\s_])((?:[^\n]|\n(?![ \t]*\n))+?)(?<!\s)_(?![\p{L}\p{N}_])/gu,
    '*$1*',
  );

  // Strikethrough: -text- -> ~~text~~
  result = result.replace(/(?<=\s)-([^-\n]+)-(?=\s|$|[.,!?;:])/g, '~~$1~~');

  // Numbered lists: # item -> 1. item
  let listCounter = 0;
  result = result.replace(/^#\s+/gm, () => `${++listCounter}. `);

  // Links: [text|url] -> [text](url)
  result = result.replace(/\[([^|\]]+)\|([^\]]+)\]/g, '[$1]($2)');

  // Blockquotes: {quote}...{quote} -> > text
  result = result.replace(/\{quote\}\n?([\s\S]*?)\{quote\}/g, (_match, content) => {
    return content.split('\n').map((line: string) => `> ${line}`).join('\n');
  });

  // Horizontal rules
  result = result.replace(/^----$/gm, '---');

  result = code.restore(result);

  return result;
}
