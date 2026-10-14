// Turns one raw RFC 5322 message (as bytes) into what a reader needs: the headers, the text, and the
// attachments by name. Used by `gmail read`; nothing here touches the network.
//
// Deliberately small: multipart trees, base64 and quoted-printable, any charset Node's TextDecoder
// knows, RFC 2047 words in headers and RFC 2231 file names. HTML is reduced to text, links kept.
// Attachments are listed, never decoded to disk.

import { decodeWords, parseHeaders } from './imap-readonly.js';

export interface MailAttachment {
  filename: string;
  contentType: string;
  /** Decoded size in bytes, estimated from the encoded length. */
  size: number;
  /** The fetch stopped inside this part, so it is incomplete. */
  truncated: boolean;
}

export interface ParsedMail {
  headers: Record<string, string>;
  /** The readable text: text/plain where the sender gave it, otherwise the HTML reduced to text. */
  text: string;
  /** Whether `text` came from HTML. */
  fromHtml: boolean;
  attachments: MailAttachment[];
  /** The raw message was cut short (a fetch cap), so the end of the text or attachments is missing. */
  truncated: boolean;
}

interface Part {
  headers: Record<string, string>;
  body: Buffer;
  /** The bytes ran out before this part's closing boundary. */
  truncated: boolean;
}

/** Splits header block from body at the first empty line (CRLF or bare LF). */
function splitHead(raw: Buffer): { head: string; body: Buffer } {
  const s = raw.toString('latin1');
  const m = /\r?\n\r?\n/.exec(s);
  if (!m) return { head: Buffer.from(s, 'latin1').toString('utf-8'), body: Buffer.alloc(0) };
  // Headers are ASCII by standard, UTF-8 under SMTPUTF8; decode them as UTF-8.
  return { head: raw.subarray(0, m.index).toString('utf-8'), body: raw.subarray(m.index + m[0].length) };
}

/**
 * A structured header value, `type/sub; a=1; b="x y"`, into its value and lower-cased parameters.
 * RFC 2231 continuations (`name*0*=`, `name*1*=`) and charset-encoded values (`name*=utf-8''%D0%90`)
 * are joined and decoded.
 */
export function parseParams(value: string): { value: string; params: Record<string, string> } {
  const parts: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '"') quoted = !quoted;
    if (c === '\\' && quoted && i + 1 < value.length) { cur += c + value[++i]; continue; }
    if (c === ';' && !quoted) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  const head = (parts.shift() ?? '').trim().toLowerCase();
  const pieces: Record<string, { idx: number; text: string; encoded: boolean; starred: boolean }[]> = {};
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq <= 0) continue;
    let name = p.slice(0, eq).trim().toLowerCase();
    let v = p.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1).replace(/\\(.)/g, '$1');
    let idx = 0;
    let encoded = false;
    const starred = name.includes('*');
    const m = /^(.*?)\*(\d+)?(\*)?$/.exec(name);
    if (m && starred) {
      name = m[1];
      idx = m[2] !== undefined ? Number(m[2]) : 0;
      encoded = m[3] === '*' || (m[2] === undefined);
    }
    (pieces[name] ??= []).push({ idx, text: v, encoded, starred });
  }
  const params: Record<string, string> = {};
  for (const [name, all] of Object.entries(pieces)) {
    // `filename="x"; filename*=...` is a fallback plus the real value: the RFC 2231 form wins.
    const list = all.some((p) => p.starred) ? all.filter((p) => p.starred) : all.slice(0, 1);
    list.sort((a, b) => a.idx - b.idx);
    if (!list.some((p) => p.encoded)) {
      params[name] = decodeWords(list.map((p) => p.text).join(''));
      continue;
    }
    // One byte sequence across all pieces, decoded once: a character may be split between pieces.
    let charset = 'utf-8';
    const bytes: number[] = [];
    list.forEach((piece, n) => {
      let t = piece.text;
      if (!piece.encoded) { for (const b of Buffer.from(t, 'utf-8')) bytes.push(b); return; }
      if (n === 0) {
        const cm = /^([^']*)'[^']*'(.*)$/.exec(t);
        if (cm) { charset = cm[1] || 'utf-8'; t = cm[2]; }
      }
      for (let i = 0; i < t.length; i++) {
        if (t[i] === '%' && /^[0-9A-Fa-f]{2}$/.test(t.slice(i + 1, i + 3))) { bytes.push(parseInt(t.slice(i + 1, i + 3), 16)); i += 2; }
        else bytes.push(t.charCodeAt(i) & 0xff);
      }
    });
    params[name] = decodeCharset(Buffer.from(bytes), charset);
  }
  return { value: head, params };
}

export function decodeCharset(bytes: Buffer, charset = 'utf-8'): string {
  const cs = charset.trim().toLowerCase().replace(/^"|"$/g, '');
  try {
    return new TextDecoder(cs === 'us-ascii' || cs === 'ascii' || cs === '' ? 'utf-8' : cs).decode(bytes);
  } catch {
    return bytes.toString('utf-8');
  }
}

export function decodeQuotedPrintable(input: Buffer): Buffer {
  const s = input.toString('latin1').replace(/=\r?\n/g, '');
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) { out.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; }
    else out.push(s.charCodeAt(i) & 0xff);
  }
  return Buffer.from(out);
}

function decodeTransfer(body: Buffer, encoding: string | undefined): Buffer {
  const enc = (encoding ?? '').trim().toLowerCase();
  if (enc === 'base64') return Buffer.from(body.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  if (enc === 'quoted-printable') return decodeQuotedPrintable(body);
  return body;
}

/** The children of a multipart body, split on its boundary. */
function splitMultipart(body: Buffer, boundary: string): { parts: Part[]; closed: boolean } {
  const s = body.toString('latin1');
  const delim = `--${boundary}`;
  const parts: Part[] = [];
  // A boundary line starts at the beginning of the body or after a line break.
  const re = new RegExp(`(?:^|\\r?\\n)${delim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(--)?[ \\t]*(?=\\r?\\n|$)`, 'g');
  let m: RegExpExecArray | null;
  let start = -1;
  let closed = false;
  while ((m = re.exec(s))) {
    if (start >= 0) parts.push(toPart(Buffer.from(s.slice(start, m.index), 'latin1'), false));
    if (m[1] === '--') { closed = true; start = -1; break; }
    start = m.index + m[0].length;
    const nl = /^\r?\n/.exec(s.slice(start));
    if (nl) start += nl[0].length;
  }
  // Ran out of bytes before the closing boundary: the last part is incomplete.
  if (start >= 0) parts.push(toPart(Buffer.from(s.slice(start), 'latin1'), true));
  return { parts, closed };
}

function toPart(raw: Buffer, truncated: boolean): Part {
  const { head, body } = splitHead(raw);
  return { headers: parseHeaders(head), body, truncated };
}

type Chunk = { kind: 'plain' | 'html'; text: string };

interface Walk {
  attachments: MailAttachment[];
  truncated: boolean;
}

function readableText(c: Chunk): string {
  return c.kind === 'html' ? htmlToText(c.text) : tidy(c.text);
}

function attachmentOf(part: Part, contentType: string, filename: string | undefined, w: Walk): MailAttachment {
  const enc = (part.headers['content-transfer-encoding'] ?? '').trim().toLowerCase();
  const len = part.body.length;
  const size = enc === 'base64' ? Math.floor(part.body.toString('latin1').replace(/[^A-Za-z0-9+/]/g, '').length * 3 / 4)
    : enc === 'quoted-printable' ? decodeQuotedPrintable(part.body).length : len;
  let name = filename;
  if (!name && contentType === 'message/rfc822') {
    const inner = parseHeaders(splitHead(part.body).head);
    name = inner.subject ? `${inner.subject}.eml` : 'forwarded message.eml';
  }
  // A part that runs out of bytes is cut by the fetch cap only when the fetch was capped; otherwise
  // the message itself is malformed (no closing boundary) and the part is all there is.
  return { filename: name || '(unnamed)', contentType, size, truncated: part.truncated && w.truncated };
}

function walk(part: Part, w: Walk, depth = 0): Chunk[] {
  const ct = parseParams(part.headers['content-type'] ?? 'text/plain');
  const type = ct.value || 'text/plain';
  const disp = parseParams(part.headers['content-disposition'] ?? '');
  const filename = disp.params.filename ?? ct.params.name;
  // An attached entity is an attachment whatever is inside it, a multipart one included.
  const attached = disp.value === 'attachment' || !!filename;
  if (type.startsWith('multipart/') && ct.params.boundary && depth < 20 && !attached) {
    const { parts } = splitMultipart(part.body, ct.params.boundary);
    const kids = parts.map((p) => walk(p, w, depth + 1));
    if (type === 'multipart/alternative') {
      // The plainest faithful rendering: text/plain when offered, otherwise the richest (last) one.
      // A blank alternative (an empty text/plain next to real HTML) does not count.
      const readable = kids.filter((k) => k.some((c) => readableText(c) !== ''));
      return readable.find((k) => k.some((c) => c.kind === 'plain' && readableText(c) !== '')) ?? readable[readable.length - 1] ?? [];
    }
    return kids.flat();
  }
  const isText = type === 'text/plain' || type === 'text/html';
  if (isText && !attached) {
    const text = decodeCharset(decodeTransfer(part.body, part.headers['content-transfer-encoding']), ct.params.charset);
    return [{ kind: type === 'text/html' ? 'html' : 'plain', text }];
  }
  w.attachments.push(attachmentOf(part, type, filename, w));
  return [];
}

const ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", mdash: '—', ndash: '–', hellip: '…',
  laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™', euro: '€', rsquo: '’', lsquo: '‘',
  ldquo: '“', rdquo: '”', bull: '•', middot: '·', zwnj: '', zwj: '', shy: '', times: '×',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** HTML to readable text: structure becomes line breaks, a link keeps its address after its text. */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(head|style|script|title)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<a\b[^>]*?\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi,
      (_m, _q, d: string | undefined, s1: string | undefined, bare: string | undefined, inner: string) => {
        const href = decodeEntities((d ?? s1 ?? bare ?? '').trim());
        const label = inner.replace(/<[^>]+>/g, '').trim();
        const text = decodeEntities(label).replace(/\s+/g, ' ').trim();
        if (!href || /^(#|javascript:)/i.test(href)) return label;
        const shown = href.replace(/^mailto:/i, '');
        return text && text !== shown && text !== href ? `${label} [${shown}]` : shown;
      })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<\/(p|div|tr|h[1-6]|li|ul|ol|table|blockquote|section|article|header|footer)\s*>/gi, '\n')
    .replace(/<(p|div|tr|h[1-6]|table|blockquote)\b[^>]*>/gi, '\n')
    .replace(/<\/t[dh]\s*>/gi, ' ')
    .replace(/<[^>]+>/g, '');
  return tidy(decodeEntities(s).replace(/[ \t\u00a0]+/g, ' ').replace(/ *\n */g, '\n'));
}

/** Drops invisible padding (zero-width and combining spacers in preheaders) and runs of blank lines. */
function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u200b-\u200f\u2060\ufeff\u034f\u00ad]/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function parseMail(raw: Buffer, opts: { truncated?: boolean } = {}): ParsedMail {
  const { head, body } = splitHead(raw);
  const root: Part = { headers: parseHeaders(head), body, truncated: !!opts.truncated };
  // Only the fetch cap makes a message truncated; a missing closing boundary in a complete fetch
  // is the sender's malformed MIME, and everything there was is shown.
  const w: Walk = { attachments: [], truncated: !!opts.truncated };
  const chunks = walk(root, w);
  const readable = chunks.map((c) => ({ kind: c.kind, text: readableText(c) })).filter((c) => c.text !== '');
  const fromHtml = readable.length > 0 && readable.every((c) => c.kind === 'html');
  const text = readable.map((c) => c.text).join('\n\n');
  return { headers: root.headers, text, fromHtml, attachments: w.attachments, truncated: w.truncated };
}
