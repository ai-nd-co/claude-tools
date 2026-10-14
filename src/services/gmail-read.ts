// `gmail list` and `gmail read`: the search, the id a reader passes between them, and the output.
// Read-only like the rest of `gmail`: the list reads headers, the reader fetches the message with
// BODY.PEEK[], and both run on All Mail opened with EXAMINE (see imap-readonly.ts).

import { redactSecrets } from './redact.js';
import { CATEGORIES, messageUrl, searchCategory, type Category, type ListedMail } from './gmail-watch.js';
import type { ParsedMail } from './mail-mime.js';

export interface ListQuery {
  days?: number;
  from?: string;
  unread?: boolean;
  category?: Category;
  /** Include his own sent mail and drafts. */
  includeSent?: boolean;
  /** Any further Gmail search, as typed in the Gmail search box. */
  query?: string;
}

/** The Gmail search (X-GM-RAW) for a list: everything but spam and trash, narrowed by the options. */
export function listSearch(q: ListQuery): string {
  const terms = ['-in:spam', '-in:trash', '-in:chats'];
  if (!q.includeSent) terms.push('-in:sent', '-in:drafts');
  if (q.days) terms.push(`newer_than:${q.days}d`);
  if (q.from) terms.push(`from:(${q.from})`);
  if (q.unread) terms.push('is:unread');
  if (q.category) terms.push(`category:${searchCategory(q.category)}`);
  if (q.query?.trim()) terms.push(q.query.trim());
  return terms.join(' ');
}

export function isCategory(value: string): value is Category {
  return value === 'primary' || (CATEGORIES as readonly string[]).includes(value);
}

/** A message's short id: Gmail's X-GM-MSGID in hex, the same id the web address ends with. */
export function shortId(msgId: string | null): string | null {
  if (!msgId) return null;
  try { return BigInt(msgId).toString(16); } catch { return null; }
}

/**
 * What `gmail read` was given, as a decimal X-GM-MSGID plus the mailbox when a link names one.
 * Accepts the hex id `gmail list` prints, the decimal id `--json` carries, or a Gmail web link
 * (`…/mail/u/<account>/#all/<hex>`). Returns an error text for anything else.
 */
export function parseMessageRef(input: string): { msgId: string; account?: string } | { error: string } {
  const text = input.trim();
  const url = /^https?:\/\/mail\.google\.com\/mail\/(?:u\/([^/#?]+)\/)?[^#]*#[^/]+(?:\/[^/]+)*\/([^/?#]+)\s*$/i.exec(text);
  const token = url ? url[2] : text;
  const account = url?.[1] && !/^\d+$/.test(url[1]) ? decodeURIComponent(url[1]) : undefined;
  if (/^\d{17,20}$/.test(token)) return { msgId: token, account };
  if (/^[0-9a-f]{1,16}$/i.test(token)) return { msgId: BigInt(`0x${token}`).toString(10), account };
  return {
    error: `"${input}" is not a message id. Pass the id \`gmail list\` prints (hex, like 19a2b3c4d5e6f708), ` +
      'or a Gmail link ending in one. Links of the newer kind (#inbox/FMfcg…) carry no usable id.',
  };
}

/**
 * Removes terminal control characters (ESC, the other C0 controls but tab and newline, DEL and C1),
 * so a sender cannot put an escape sequence (an OSC that sets the clipboard, a cursor move) into
 * text printed to a terminal. JSON output escapes them itself and is left alone.
 */
export function stripControls(text: string): string {
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

function fold(text: string): string {
  return text.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [+${text.length - max} chars]`;
}

function stamp(date: Date | null, timeZone?: string): string {
  if (!date) return '--- --:--';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('month')} ${get('day')} ${get('hour')}:${get('minute')}`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export interface ListFormat {
  account: string;
  maxText: number;
  json: boolean;
  timeZone?: string;
  scrub: (text: string) => string;
}

/** One line per message: `<id> <Mon DD HH:MM> <• if unread> <category> <from>: <subject>`. */
export function formatListed(m: ListedMail, f: ListFormat): string {
  const clean = (t: string) => redactSecrets(f.scrub(t));
  const from = cut(fold(clean(m.from)), 80);
  const subject = cut(fold(clean(m.subject)), f.maxText);
  const id = shortId(m.msgId);
  if (f.json) {
    return JSON.stringify({
      account: f.account, id, gmailId: m.msgId, uid: m.uid, time: m.date?.toISOString() ?? null, unread: m.unread,
      category: m.category, labels: m.labels, from, subject, size: m.size, url: messageUrl(m.msgId, f.account),
    });
  }
  return stripControls(`${id ?? '?'.padEnd(16)}  ${stamp(m.date, f.timeZone)}  ${m.unread ? '•' : ' '} ${m.category.padEnd(10)} ${from}: ${subject || '(no subject)'}`);
}

export interface ReadFormat {
  account: string;
  msgId: string;
  labels: string[];
  unread: boolean | null;
  size: number | null;
  maxChars: number;
  json: boolean;
  timeZone?: string;
  scrub: (text: string) => string;
}

/** The message as a reader wants it: the main headers, the attachments by name, then the text. */
export function formatRead(mail: ParsedMail, f: ReadFormat): string {
  const clean = (t: string) => redactSecrets(f.scrub(t));
  const h = (name: string) => clean(fold(mail.headers[name] ?? ''));
  const date = mail.headers.date ? new Date(mail.headers.date) : null;
  const when = date && !Number.isNaN(date.getTime())
    ? `${date.toLocaleString('sv-SE', { timeZone: f.timeZone, hour12: false })}${f.timeZone ? ` (${f.timeZone})` : ''}`
    : h('date');
  const body = clean(mail.text);
  const text = cut(body, f.maxChars);
  const url = messageUrl(f.msgId, f.account);
  // One line each: a decoded file name may carry a newline that would forge a header line below.
  const attachments = mail.attachments.map((a) => ({ ...a, filename: fold(clean(a.filename)), contentType: fold(clean(a.contentType)) }));
  if (f.json) {
    return JSON.stringify({
      account: f.account, id: shortId(f.msgId), gmailId: f.msgId, url,
      from: h('from'), to: h('to'), cc: h('cc') || null, replyTo: h('reply-to') || null, date: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null,
      subject: h('subject'), labels: f.labels, unread: f.unread, size: f.size,
      attachments, text, textChars: body.length, textCut: body.length > f.maxChars, fromHtml: mail.fromHtml, truncated: mail.truncated,
    }, null, 2);
  }
  const lines: string[] = [];
  const add = (label: string, value: string) => { if (value) lines.push(`${label.padEnd(10)}${value}`); };
  add('From:', h('from'));
  add('To:', h('to'));
  add('Cc:', h('cc'));
  add('Reply-To:', h('reply-to'));
  add('Date:', when);
  add('Subject:', h('subject') || '(no subject)');
  add('Labels:', f.labels.join(', '));
  if (f.unread !== null) add('Status:', f.unread ? 'unread (reading it did not change that)' : 'read');
  add('Link:', url ?? '');
  for (const a of attachments) {
    lines.push(`Attached: ${a.filename} (${a.contentType}, ${formatSize(a.size)}${a.truncated ? ', cut off by the fetch cap' : ''})`);
  }
  lines.push('');
  lines.push(text || (mail.attachments.length ? '(no text; see the attachments above)' : '(no text)'));
  if (mail.fromHtml) lines.push('', '[text reduced from HTML]');
  if (mail.truncated) lines.push('', '[the message is larger than --max-bytes; its end was not fetched]');
  return stripControls(lines.join('\n'));
}
