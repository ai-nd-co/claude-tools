// A minimal IMAP client that can only READ.
//
// The credential behind it (a Gmail app password) cannot be scoped: the same string can delete, move
// and flag mail over IMAP and send mail over SMTP. So read-only is enforced here, by construction:
//
//   - every command passes `assertReadOnly` before it reaches the socket, and only the verbs in
//     READ_ONLY_COMMANDS are accepted - STORE, EXPUNGE, COPY, MOVE, APPEND, SELECT and the rest throw;
//   - a mailbox is opened with EXAMINE, which RFC 3501 6.3.2 defines as "No changes to the permanent
//     state of the mailbox, including per-user state";
//   - a FETCH may only ask for BODY.PEEK sections, which RFC 3501 6.4.5 says do "not implicitly set
//     the \Seen flag" - a second layer under EXAMINE, so reading never marks mail as read. The
//     sections allowed are the headers and, for `gmail read`, the whole message (`BODY.PEEK[]`,
//     optionally capped with a `<0.n>` partial); a non-PEEK BODY[...] is always refused.
//
// There is no SMTP anywhere in this tool. Do not add a write verb here to serve another command: a
// command that changes the mailbox gets its own client, its own name and its own ask.

import * as net from 'net';
import * as tls from 'tls';

/** The only verbs this client will send. `UID` is checked together with its sub-command. */
export const READ_ONLY_COMMANDS = new Set([
  'CAPABILITY', 'LOGIN', 'LIST', 'EXAMINE', 'STATUS', 'NOOP', 'LOGOUT', 'UID SEARCH', 'UID FETCH',
]);

export class ImapWriteRefused extends Error {
  constructor(command: string) {
    super(`refused to send a non-read-only IMAP command: ${command.split(' ').slice(0, 2).join(' ')}`);
    this.name = 'ImapWriteRefused';
  }
}

/** Authentication failed: the app password was revoked, changed or mistyped. Never retried. */
export class ImapAuthError extends Error {
  constructor(detail: string) {
    super(`re-authentication needed (app password revoked or changed): ${detail}`);
    this.name = 'ImapAuthError';
  }
}

export class ImapCommandError extends Error {
  constructor(public readonly status: string, public readonly text: string, command: string) {
    super(`IMAP ${command} failed: ${status} ${text}`);
    this.name = 'ImapCommandError';
  }
}

/**
 * Throws unless `command` (without its tag) is read-only. Exported for tests: this is the property the
 * whole design rests on, so it is checked directly as well as through a recorded session.
 */
export function assertReadOnly(command: string): void {
  // One command per call: a CR or LF would let a second, unchecked command ride along
  // ("NOOP\r\nX SELECT ..."), so any control character refuses the whole string.
  if (/[\x00-\x1f\x7f]/.test(command)) throw new ImapWriteRefused(command.replace(/[\x00-\x1f\x7f]/g, ' '));
  const words = command.trim().split(/\s+/);
  const verb = (words[0] ?? '').toUpperCase();
  const key = verb === 'UID' ? `UID ${(words[1] ?? '').toUpperCase()}` : verb;
  if (!READ_ONLY_COMMANDS.has(key)) throw new ImapWriteRefused(command);
  if (key === 'UID FETCH' && !isPeekFetch(command)) throw new ImapWriteRefused(command);
}

/** FETCH items that never set \Seen and never return a body. Anything else is refused. */
const FETCH_ITEMS = new Set(['UID', 'FLAGS', 'INTERNALDATE', 'RFC822.SIZE', 'RFC822.HEADER', 'X-GM-MSGID', 'X-GM-THRID', 'X-GM-LABELS']);

/**
 * True only for `UID FETCH <set> (<items>)` whose items are all metadata or a PEEK section:
 * `BODY.PEEK[HEADER]`, `BODY.PEEK[HEADER.FIELDS (A B …)]`, or the whole message `BODY.PEEK[]`
 * (optionally `BODY.PEEK[]<0.n>`). A positive grammar, so an item this client has never heard of
 * (BINARY[…], BODY[…], RFC822, RFC822.TEXT, an extension) is refused.
 */
export function isPeekFetch(command: string): boolean {
  const m = /^UID\s+FETCH\s+([0-9,:*]+)\s+\((.*)\)\s*$/i.exec(command.trim());
  if (!m) return false;
  const rest = m[2]
    .replace(/BODY\.PEEK\[HEADER\.FIELDS \((?:[A-Za-z0-9-]+ ?)+\)\]/gi, ' ')
    .replace(/BODY\.PEEK\[HEADER\]/gi, ' ')
    .replace(/BODY\.PEEK\[\](?:<0\.[1-9][0-9]{0,9}>)?(?=\s|$)/gi, ' ');
  const items = rest.trim().split(/\s+/).filter(Boolean);
  return items.every((i) => FETCH_ITEMS.has(i.toUpperCase()));
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/** A parsed IMAP value: an atom or string, NIL, or a parenthesised list. */
export type ImapValue = string | null | ImapValue[];

/**
 * Splits a buffer into complete responses. A response is one line, unless it carries literals
 * (`{n}\r\n` followed by n bytes), in which case it continues after each literal until a CRLF that
 * is not followed by one. Returns the responses and the unconsumed remainder.
 */
export function splitResponses(buf: Buffer): { responses: Buffer[]; rest: Buffer } {
  const responses: Buffer[] = [];
  let start = 0;
  let pos = 0;
  for (;;) {
    const eol = buf.indexOf('\r\n', pos);
    if (eol < 0) break;
    // Only untagged data ("* ...") carries literals. A tagged or "+" line ending in "{12}" is free
    // text, and treating it as a literal would swallow the responses after it.
    const head = buf.subarray(start, Math.min(buf.length, start + 12)).toString('latin1');
    const dataResponse = head.startsWith('* ') && !/^\* (OK|NO|BAD|BYE|PREAUTH)\b/i.test(head);
    const m = dataResponse ? /\{(\d+)\}$/.exec(buf.subarray(pos, eol).toString('latin1')) : null;
    if (m) {
      const end = eol + 2 + Number(m[1]);
      if (end > buf.length) break;
      pos = end;
      continue;
    }
    responses.push(buf.subarray(start, eol));
    start = pos = eol + 2;
  }
  return { responses, rest: buf.subarray(start) };
}

/**
 * Parses the tokens of one response from `from`. Literals are decoded as UTF-8, or as latin1 with
 * `rawLiterals`, which keeps every byte (`Buffer.from(value, 'latin1')` gives them back): a whole
 * message may be in any charset, and a UTF-8 decode would destroy the ones that are not.
 */
export function parseValues(raw: Buffer, from = 0, rawLiterals = false): ImapValue[] {
  const stack: ImapValue[][] = [[]];
  let i = from;
  const top = () => stack[stack.length - 1];
  while (i < raw.length) {
    const c = raw[i];
    if (c === 0x20) { i++; continue; }
    if (c === 0x28) { const list: ImapValue[] = []; top().push(list); stack.push(list); i++; continue; }
    if (c === 0x29) { if (stack.length > 1) stack.pop(); i++; continue; }
    if (c === 0x22) {
      let s = '';
      i++;
      while (i < raw.length && raw[i] !== 0x22) {
        if (raw[i] === 0x5c && i + 1 < raw.length) i++;
        s += String.fromCharCode(raw[i]);
        i++;
      }
      i++;
      top().push(Buffer.from(s, 'latin1').toString('utf-8'));
      continue;
    }
    if (c === 0x7b) {
      const close = raw.indexOf('}', i);
      const n = Number(raw.subarray(i + 1, close).toString('latin1'));
      const startData = close + 3; // }\r\n
      top().push(raw.subarray(startData, startData + n).toString(rawLiterals ? 'latin1' : 'utf-8'));
      i = startData + n;
      continue;
    }
    // Atom. Only a BODY[...]/BINARY[...] section keeps its brackets (and the list inside them) in
    // the atom; anywhere else a "[" is an ordinary character, so a label like project[2026 cannot
    // swallow the rest of the response.
    let j = i;
    let depth = 0;
    // Attribute-name position: directly inside the message's attribute list, at an even index.
    // A label list is nested one level deeper, so a label like BODY[2026 is never sectioned.
    const namePosition = stack.length === 2 && top().length % 2 === 0;
    const sectioned = namePosition && /^(BODY|BINARY)(\.PEEK)?\[/i.test(raw.subarray(i, Math.min(raw.length, i + 12)).toString('latin1'));
    while (j < raw.length) {
      const d = raw[j];
      if (sectioned && d === 0x5b) depth++;
      else if (sectioned && d === 0x5d) depth = Math.max(0, depth - 1);
      else if (depth === 0 && (d === 0x20 || d === 0x28 || d === 0x29)) break;
      j++;
    }
    const atom = raw.subarray(i, j).toString('latin1');
    top().push(atom.toUpperCase() === 'NIL' ? null : atom);
    i = j;
  }
  return stack[0];
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface ImapConnectOptions {
  host: string;
  port: number;
  /** false only in tests, against a local fake server. */
  tls?: boolean;
  timeoutMs?: number;
}

export interface ImapTaggedResult {
  untagged: Buffer[];
  status: string;
  text: string;
}

interface Pending {
  tag: string;
  command: string;
  untagged: Buffer[];
  resolve: (r: ImapTaggedResult) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class ReadOnlyImapClient {
  private socket: net.Socket | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private counter = 0;
  private pending: Pending | null = null;
  private greeting: ((ok: boolean, line: string) => void) | null = null;
  private closedError: Error | null = null;
  /** The text of a BYE, so a closed connection can say why (and an auth refusal stays one). */
  private byeText: string | null = null;
  /** Every command line sent, password masked. Read by tests to prove nothing else went out. */
  readonly sent: string[] = [];

  constructor(private readonly opts: ImapConnectOptions) {}

  async connect(): Promise<void> {
    const timeoutMs = this.opts.timeoutMs ?? 30_000;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`IMAP connect to ${this.opts.host} timed out`)), timeoutMs);
      this.greeting = (ok, line) => {
        clearTimeout(timer);
        if (ok) { resolve(); return; }
        const err = isAuthRefusal(line) ? new ImapAuthError(line) : new Error(`IMAP server refused the connection: ${line}`);
        this.fail(err);
        reject(err);
        this.socket?.destroy();
      };
      const socket = this.opts.tls === false
        ? net.connect({ host: this.opts.host, port: this.opts.port })
        : tls.connect({ host: this.opts.host, port: this.opts.port, servername: this.opts.host });
      this.socket = socket;
      socket.on('data', (chunk: Buffer) => this.onData(chunk));
      socket.on('error', (err) => { clearTimeout(timer); this.fail(err); reject(err); });
      socket.on('close', () => {
        const err = new Error('IMAP connection closed');
        this.fail(err);
        // Closed before any greeting: settle connect() now rather than at its timeout.
        if (this.greeting) {
          this.greeting = null;
          clearTimeout(timer);
          reject(this.closedError ?? err);
        }
      });
    });
  }

  private fail(err: Error): void {
    // A BYE in answer to LOGIN is a refusal of the login whatever its wording ("Application-specific
    // password required", a localised text): never retried, because retrying can lock the account.
    const duringLogin = !!this.pending && /^LOGIN\b/i.test(this.pending.command);
    if (this.byeText && (isAuthRefusal(this.byeText) || duringLogin)) {
      err = new ImapAuthError(this.byeText);
    } else if (this.byeText && err.message === 'IMAP connection closed') {
      err = new Error(`IMAP connection closed by the server: ${this.byeText}`);
    }
    if (!this.closedError) this.closedError = err;
    const p = this.pending;
    this.pending = null;
    if (p) { clearTimeout(p.timer); p.reject(err); }
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const { responses, rest } = splitResponses(this.buffer);
    this.buffer = rest;
    for (const r of responses) this.onResponse(r);
  }

  private onResponse(raw: Buffer): void {
    const line = raw.toString('latin1');
    if (this.greeting) {
      const g = this.greeting;
      this.greeting = null;
      if (/^\* BYE\b/i.test(line)) this.byeText = line.replace(/^\* BYE\s*/i, '');
      g(/^\* (OK|PREAUTH)/i.test(line), line);
      return;
    }
    if (/^\* BYE\b/i.test(line)) {
      this.byeText = line.replace(/^\* BYE\s*/i, '');
      // BYE is terminal. During LOGOUT it is the expected goodbye; anywhere else, fail the pending
      // command now (as an auth error when it says so) instead of waiting for the close or a timeout.
      if (!(this.pending && /^LOGOUT\b/i.test(this.pending.command))) {
        this.fail(new Error('IMAP connection closed'));
        this.socket?.destroy();
        return;
      }
    }
    const p = this.pending;
    if (!p) return; // An unsolicited untagged response between commands; the next NOOP repeats it.
    if (line.startsWith(`${p.tag} `)) {
      const m = /^\S+ (OK|NO|BAD)\s?(.*)$/i.exec(line);
      this.pending = null;
      clearTimeout(p.timer);
      p.resolve({ untagged: p.untagged, status: (m?.[1] ?? 'BAD').toUpperCase(), text: m?.[2] ?? line });
      return;
    }
    if (line.startsWith('* ')) p.untagged.push(raw);
  }

  /** Sends one command and waits for its tagged response. Refuses anything that is not read-only. */
  async command(command: string, logAs?: string): Promise<ImapTaggedResult> {
    assertReadOnly(command);
    if (this.closedError) throw this.closedError;
    if (!this.socket) throw new Error('IMAP client is not connected');
    if (this.pending) throw new Error('IMAP client sends one command at a time');
    const tag = `R${++this.counter}`;
    // LOGIN is masked here, whoever called, so the password never lands in the record.
    const record = /^LOGIN\b/i.test(command.trim()) ? 'LOGIN [REDACTED]' : (logAs ?? command);
    this.sent.push(record);
    const timeoutMs = this.opts.timeoutMs ?? 30_000;
    const result = await new Promise<ImapTaggedResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new Error(`IMAP ${command.split(' ')[0]} timed out after ${timeoutMs / 1000}s`));
        this.socket?.destroy();
      }, timeoutMs);
      this.pending = { tag, command, untagged: [], resolve, reject, timer };
      this.socket!.write(`${tag} ${command}\r\n`);
    });
    return result;
  }

  private async ok(command: string, logAs?: string): Promise<ImapTaggedResult> {
    const r = await this.command(command, logAs);
    if (r.status !== 'OK') throw new ImapCommandError(r.status, r.text, (logAs ?? command).split(' ')[0]);
    return r;
  }

  async login(user: string, password: string): Promise<void> {
    let r: ImapTaggedResult;
    try {
      r = await this.command(`LOGIN ${quote(user)} ${quote(password)}`);
    } catch (err) {
      // A server may refuse with "* BYE [AUTHENTICATIONFAILED]" and hang up instead of a tagged NO.
      if (this.closedError instanceof ImapAuthError) throw this.closedError;
      throw err;
    }
    if (r.status !== 'OK') throw new ImapAuthError(r.text);
  }

  async capabilities(): Promise<string[]> {
    const r = await this.ok('CAPABILITY');
    const line = r.untagged.map((b) => b.toString('latin1')).find((l) => /^\* CAPABILITY /i.test(l)) ?? '';
    return line.replace(/^\* CAPABILITY /i, '').split(/\s+/).filter(Boolean);
  }

  /** The mailbox carrying a special-use attribute such as `\All`, found with LIST (names are localised). */
  async findSpecialUse(attribute: string): Promise<string | null> {
    const r = await this.ok('LIST "" "*"');
    for (const raw of r.untagged) {
      const values = parseValues(raw, 2); // after "* "
      if (String(values[0]).toUpperCase() !== 'LIST') continue;
      const flags = (Array.isArray(values[1]) ? values[1] : []).map((f) => String(f).toLowerCase());
      if (flags.includes(attribute.toLowerCase())) return String(values[3]);
    }
    return null;
  }

  /** Opens `mailbox` READ-ONLY and returns its UIDVALIDITY and UIDNEXT. */
  async examine(mailbox: string): Promise<{ uidValidity: number; uidNext: number | null; exists: number }> {
    const r = await this.ok(`EXAMINE ${quote(mailbox)}`);
    let uidValidity = NaN;
    let uidNext: number | null = null;
    let exists = 0;
    for (const raw of r.untagged) {
      const l = raw.toString('latin1');
      const v = /\[UIDVALIDITY (\d+)\]/i.exec(l); if (v) uidValidity = Number(v[1]);
      const n = /\[UIDNEXT (\d+)\]/i.exec(l); if (n) uidNext = Number(n[1]);
      const e = /^\* (\d+) EXISTS/i.exec(l); if (e) exists = Number(e[1]);
    }
    if (!/^\[READ-ONLY\]/i.test(r.text.trim())) {
      // EXAMINE must answer [READ-ONLY]; a server that does not is not one this client trusts.
      throw new Error(`IMAP EXAMINE did not confirm READ-ONLY access (${r.text})`);
    }
    if (Number.isNaN(uidValidity)) throw new Error('IMAP EXAMINE returned no UIDVALIDITY');
    return { uidValidity, uidNext, exists };
  }

  /** `STATUS <mailbox> (MESSAGES UNSEEN)`: counts, without opening the mailbox. */
  async status(mailbox: string): Promise<{ messages: number; unseen: number }> {
    const r = await this.ok(`STATUS ${quote(mailbox)} (MESSAGES UNSEEN)`);
    const line = r.untagged.map((b) => b.toString('utf-8')).find((l) => /^\* STATUS /i.test(l)) ?? '';
    const messages = /MESSAGES (\d+)/i.exec(line);
    const unseen = /UNSEEN (\d+)/i.exec(line);
    if (!messages || !unseen) throw new Error(`IMAP STATUS gave no counts (${line || r.text})`);
    return { messages: Number(messages[1]), unseen: Number(unseen[1]) };
  }

  async noop(): Promise<void> {
    await this.ok('NOOP');
  }

  /** `UID SEARCH <criteria>`; returns the UIDs. */
  async uidSearch(criteria: string): Promise<number[]> {
    const r = await this.ok(`UID SEARCH ${criteria}`);
    const uids: number[] = [];
    for (const raw of r.untagged) {
      const l = raw.toString('latin1');
      if (!/^\* SEARCH\b/i.test(l)) continue;
      for (const t of l.replace(/^\* SEARCH/i, '').trim().split(/\s+/)) if (/^\d+$/.test(t)) uids.push(Number(t));
    }
    return uids;
  }

  /**
   * `UID FETCH <set> (<items>)`; returns each message's item map keyed by upper-cased item name.
   * With `rawLiterals`, literal values are latin1 strings holding the exact bytes (see parseValues).
   */
  async uidFetch(set: string, items: string, opts: { rawLiterals?: boolean } = {}): Promise<Map<number, Map<string, ImapValue>>> {
    const r = await this.ok(`UID FETCH ${set} (${items})`);
    const out = new Map<number, Map<string, ImapValue>>();
    for (const raw of r.untagged) {
      const values = parseValues(raw, 2, !!opts.rawLiterals);
      if (values.length < 3 || String(values[1]).toUpperCase() !== 'FETCH' || !Array.isArray(values[2])) continue;
      const list = values[2];
      const attrs = new Map<string, ImapValue>();
      for (let k = 0; k + 1 < list.length; k += 2) attrs.set(String(list[k]).toUpperCase(), list[k + 1]);
      const uid = Number(attrs.get('UID'));
      if (!Number.isInteger(uid)) continue;
      // A server may send several FETCH responses for one message (an unsolicited FLAGS update
      // next to the requested data). Merge them; a later partial one must not replace the headers.
      const merged = out.get(uid) ?? new Map<string, ImapValue>();
      for (const [k, v] of attrs) merged.set(k, v);
      out.set(uid, merged);
    }
    return out;
  }

  async logout(): Promise<void> {
    try { await this.command('LOGOUT'); } catch { /* closing anyway */ }
    this.socket?.destroy();
    this.socket = null;
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
  }
}

/** A server text that says the credentials were refused. */
export function isAuthRefusal(text: string): boolean {
  return /AUTHENTICATIONFAILED|AUTHORIZATIONFAILED|Invalid credentials|Web login required/i.test(text);
}

/** An IMAP quoted string. Refuses CR/LF, which no legitimate value here contains. */
export function quote(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error('IMAP string contains a line break');
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// ---------------------------------------------------------------------------
// Header decoding
// ---------------------------------------------------------------------------

/** Decodes RFC 2047 encoded-words (`=?charset?B|Q?...?=`), joining adjacent ones. */
export function decodeWords(text: string): string {
  const joined = text.replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, '$1');
  return joined.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_m, charset: string, enc: string, data: string) => {
    let bytes: Buffer;
    if (enc.toUpperCase() === 'B') bytes = Buffer.from(data, 'base64');
    else {
      const s = data.replace(/_/g, ' ');
      const arr: number[] = [];
      for (let i = 0; i < s.length; i++) {
        if (s[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) { arr.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; }
        else arr.push(s.charCodeAt(i) & 0xff);
      }
      bytes = Buffer.from(arr);
    }
    try {
      return new TextDecoder(charset.toLowerCase().replace(/\*.*$/, '')).decode(bytes);
    } catch {
      return bytes.toString('utf-8');
    }
  });
}

/** Parses a header block into lower-cased name -> decoded value, unfolding continuation lines. */
export function parseHeaders(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  const unfolded = block.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    if (!(name in out)) out[name] = decodeWords(line.slice(idx + 1).trim());
  }
  return out;
}
