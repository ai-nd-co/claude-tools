// Gmail over IMAP, read-only: the new-mail watcher and the volume counter behind `claude-tools gmail`.
//
// Everything goes through ReadOnlyImapClient, which refuses any command that could change the
// mailbox (see imap-readonly.ts). This file decides WHAT to read; it cannot decide to write.
//
// "All mail except spam" is Gmail's All Mail folder (found by its \All special-use attribute, because
// the name is localised): it holds everything except Spam and Trash. Mail he sent and drafts are there
// too and are dropped by their labels. New mail is detected by UID: the folder's UIDVALIDITY plus the
// highest UID already reported. Unlike the Gmail API's history cursor, a UID does not expire, so a
// watcher that was down reports what arrived meanwhile - under the flood cap, never as a backlog dump.

import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { getConfigDir } from '../config/paths.js';
import { redactSecrets } from './redact.js';
import {
  ImapAuthError,
  ReadOnlyImapClient,
  parseHeaders,
  quote,
  type ImapConnectOptions,
  type ImapValue,
} from './imap-readonly.js';

export const GMAIL_IMAP: ImapConnectOptions = { host: 'imap.gmail.com', port: 993 };

/** Gmail's own categories, searched with X-GM-RAW. Anything in none of them is "primary". */
export const CATEGORIES = ['promotions', 'social', 'updates', 'forums'] as const;
export type Category = typeof CATEGORIES[number] | 'primary';

/**
 * The search term for a category. Gmail's IMAP search answers `category:primary` with nothing
 * (measured 2026-10-07: 0 of 358 over twelve days) but `category:personal` with the Primary tab,
 * and the five then add up to the total exactly.
 */
export function searchCategory(cat: Category): string {
  return cat === 'primary' ? 'personal' : cat;
}

/** Sender patterns counted as automated by `gmail count`. A Gmail `from:` query, so a substring match. */
export const AUTOMATED_FROM = 'from:(noreply OR no-reply OR donotreply OR do-not-reply OR notifications OR notification OR mailer-daemon OR newsletter)';

/** Labels (X-GM-LABELS) whose messages are never reported: his own outgoing mail. */
const OUTGOING_LABELS = ['\\sent', '\\draft'];

export interface MailMeta {
  uid: number;
  msgId: string | null;
  labels: string[];
  category: Category;
  from: string;
  subject: string;
  date: Date | null;
}

// ---------------------------------------------------------------------------
// The mail source: one IMAP session on the All Mail folder
// ---------------------------------------------------------------------------

export interface MailSource {
  /** Connect, log in, open All Mail read-only. */
  open(): Promise<{ uidValidity: number; mailbox: string }>;
  /** Lets the server report new mail on an open session. Also the heartbeat's proof of the login. */
  ping(): Promise<void>;
  /** UIDs above `afterUid`, ascending. */
  uidsAfter(afterUid: number): Promise<number[]>;
  /** Headers, labels and category for these UIDs. Never a body. */
  describe(uids: number[]): Promise<MailMeta[]>;
  /** Labels and category for these UIDs, without any header: enough to decide what is reportable. */
  classify(uids: number[]): Promise<Map<number, { labels: string[]; category: Category }>>;
  /** UIDs matching a Gmail search (X-GM-RAW). Ids only. */
  search(gmailQuery: string): Promise<number[]>;
  close(): Promise<void>;
}

export class ImapMailSource implements MailSource {
  private client: ReadOnlyImapClient | null = null;

  constructor(
    private readonly user: string,
    private readonly appPassword: string,
    private readonly conn: ImapConnectOptions = GMAIL_IMAP,
  ) {}

  private get c(): ReadOnlyImapClient {
    if (!this.client) throw new Error('mail source is not open');
    return this.client;
  }

  async open(): Promise<{ uidValidity: number; mailbox: string }> {
    await this.close();
    const client = new ReadOnlyImapClient(this.conn);
    this.client = client;
    await client.connect();
    await client.login(this.user, this.appPassword.replace(/\s+/g, ''));
    const caps = (await client.capabilities()).map((c) => c.toUpperCase());
    if (!caps.includes('X-GM-EXT-1')) throw new Error('the IMAP server is not Gmail (no X-GM-EXT-1 capability)');
    const mailbox = await client.findSpecialUse('\\All');
    if (!mailbox) throw new Error('Gmail has no folder marked \\All (All Mail is hidden from IMAP in Gmail settings?)');
    const { uidValidity } = await client.examine(mailbox);
    return { uidValidity, mailbox };
  }

  async ping(): Promise<void> {
    await this.c.noop();
  }

  /** Message and unread counts of a mailbox (STATUS); `gmail check` compares them around a read. */
  async status(mailbox: string): Promise<{ messages: number; unseen: number }> {
    return this.c.status(mailbox);
  }

  /** The underlying client, for `gmail check` to prove the write guard. */
  get imap(): ReadOnlyImapClient {
    return this.c;
  }

  async uidsAfter(afterUid: number): Promise<number[]> {
    // "n:*" always includes the highest UID even when it is below n, so filter.
    const uids = await this.c.uidSearch(`UID ${afterUid + 1}:*`);
    return uids.filter((u) => u > afterUid).sort((a, b) => a - b);
  }

  async search(gmailQuery: string): Promise<number[]> {
    return this.c.uidSearch(`X-GM-RAW ${quote(gmailQuery)}`);
  }

  /** Category per UID, from one search per category over the UIDs' range (short command lines). */
  private async categories(uids: number[]): Promise<Map<number, Category>> {
    const category = new Map<number, Category>();
    if (uids.length === 0) return category;
    const wanted = new Set(uids);
    const range = uidRange(uids);
    for (const cat of CATEGORIES) {
      for (const uid of await this.c.uidSearch(`UID ${range} X-GM-RAW ${quote(`category:${cat}`)}`)) {
        if (wanted.has(uid)) category.set(uid, cat);
      }
    }
    return category;
  }

  async classify(uids: number[]): Promise<Map<number, { labels: string[]; category: Category }>> {
    const out = new Map<number, { labels: string[]; category: Category }>();
    // Bounded batches: one huge FETCH or search would time out and repeat forever.
    for (let i = 0; i < uids.length; i += CLASSIFY_BATCH) {
      const batch = uids.slice(i, i + CLASSIFY_BATCH);
      const fetched = await this.c.uidFetch(uidRange(batch), 'UID X-GM-LABELS');
      const category = await this.categories(batch);
      for (const uid of batch) {
        const item = fetched.get(uid);
        if (!item) continue; // expunged since the search: nothing to report
        const labels = item.get('X-GM-LABELS');
        out.set(uid, { labels: Array.isArray(labels) ? labels.map(String) : [], category: category.get(uid) ?? 'primary' });
      }
    }
    return out;
  }

  async describe(uids: number[]): Promise<MailMeta[]> {
    if (uids.length === 0) return [];
    const fetched = await this.c.uidFetch(uids.join(','), 'UID X-GM-MSGID X-GM-LABELS BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)]');
    const category = await this.categories(uids);
    const out: MailMeta[] = [];
    for (const uid of uids) {
      const item = fetched.get(uid);
      if (!item) continue; // expunged since the search: nothing to report
      if (![...item.keys()].some((k) => k.startsWith('BODY[HEADER.FIELDS'))) {
        // Present but without its headers: a partial answer. Fail the cycle so the cursor does not
        // move past a message that was never described; the next cycle asks again.
        throw new Error(`IMAP FETCH returned no headers for UID ${uid}`);
      }
      out.push(toMeta(uid, item, category.get(uid) ?? 'primary'));
    }
    return out;
  }

  /**
   * For `gmail list`: headers, labels, unread flag, size and category of these UIDs, in the order
   * given. Header-only PEEK, so nothing is marked read. Messages expunged meanwhile are skipped.
   */
  async summarize(uids: number[]): Promise<ListedMail[]> {
    // Bounded batches, as classify() does: one FETCH for a large --limit could time out whole.
    const out: ListedMail[] = [];
    for (let i = 0; i < uids.length; i += SUMMARY_BATCH) out.push(...await this.summarizeBatch(uids.slice(i, i + SUMMARY_BATCH)));
    return out;
  }

  private async summarizeBatch(uids: number[]): Promise<ListedMail[]> {
    if (uids.length === 0) return [];
    const fetched = await this.c.uidFetch(uids.join(','),
      'UID X-GM-MSGID X-GM-LABELS FLAGS RFC822.SIZE BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)]');
    const category = await this.categories(uids);
    const out: ListedMail[] = [];
    for (const uid of uids) {
      const item = fetched.get(uid);
      if (!item) continue;
      // A partial answer (say, only an unsolicited FLAGS update) must not print as a blank message.
      if (![...item.keys()].some((k) => k.startsWith('BODY[HEADER.FIELDS'))) {
        throw new Error(`IMAP FETCH returned no headers for UID ${uid}`);
      }
      const flags = item.get('FLAGS');
      const size = Number(item.get('RFC822.SIZE'));
      out.push({
        ...toMeta(uid, item, category.get(uid) ?? 'primary'),
        unread: Array.isArray(flags) ? !flags.some((f) => String(f).toLowerCase() === '\\seen') : null,
        size: Number.isFinite(size) ? size : null,
      });
    }
    return out;
  }

  /** The UID in All Mail of the message with this X-GM-MSGID (decimal), or null. */
  async findByGmailId(msgId: string): Promise<number | null> {
    if (!/^\d{1,20}$/.test(msgId)) throw new Error(`not a Gmail message id: ${msgId}`);
    const uids = await this.c.uidSearch(`X-GM-MSGID ${msgId}`);
    return uids.length ? uids[0] : null;
  }

  /**
   * The raw message, at most `maxBytes` of it, read with BODY.PEEK[] so it stays unread. `truncated`
   * says the cap cut it; `size` is the whole message's size.
   */
  async fetchRaw(uid: number, maxBytes: number): Promise<{ raw: Buffer; size: number | null; truncated: boolean } | null> {
    const fetched = await this.c.uidFetch(String(uid), `UID RFC822.SIZE BODY.PEEK[]<0.${maxBytes}>`, { rawLiterals: true });
    const item = fetched.get(uid);
    if (!item) return null;
    let body: string | null = null;
    for (const [k, v] of item) if (/^BODY\[\](<\d+>)?$/.test(k) && typeof v === 'string') body = v;
    if (body === null) throw new Error(`IMAP FETCH returned no message body for UID ${uid}`);
    const raw = Buffer.from(body, 'latin1');
    const size = Number(item.get('RFC822.SIZE'));
    const known = Number.isFinite(size) ? size : null;
    return { raw, size: known, truncated: known !== null ? raw.length < known : raw.length >= maxBytes };
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = null;
    if (c) await c.logout();
  }
}

/** A message as `gmail list` shows it. `unread` / `size` are null when the server did not say. */
export interface ListedMail extends MailMeta {
  unread: boolean | null;
  size: number | null;
}

/** Most UIDs classified per round trip. */
const CLASSIFY_BATCH = 500;

/** Most UIDs summarised (headers fetched) per round trip by `gmail list`. */
const SUMMARY_BATCH = 200;

/** "min:max" of a UID list, by iteration: spreading a huge list into Math.min would throw. */
export function uidRange(uids: number[]): string {
  let lo = Infinity;
  let hi = -Infinity;
  for (const u of uids) { if (u < lo) lo = u; if (u > hi) hi = u; }
  return `${lo}:${hi}`;
}

function toMeta(uid: number, item: Map<string, ImapValue>, category: Category): MailMeta {
  let headerBlock = '';
  for (const [k, v] of item) if (k.startsWith('BODY[HEADER.FIELDS') && typeof v === 'string') headerBlock = v;
  const h = parseHeaders(headerBlock);
  const labelsValue = item.get('X-GM-LABELS');
  const labels = Array.isArray(labelsValue) ? labelsValue.map((l) => String(l)) : [];
  const date = h.date ? new Date(h.date) : null;
  const msgId = item.get('X-GM-MSGID');
  return {
    uid,
    msgId: typeof msgId === 'string' && /^\d+$/.test(msgId) ? msgId : null,
    labels,
    category,
    from: h.from ?? '',
    subject: h.subject ?? '',
    date: date && !Number.isNaN(date.getTime()) ? date : null,
  };
}

/**
 * How many of `uids` carry \Seen in a FLAGS fetch result, or null when any of them did not report
 * its FLAGS (expunged meanwhile, or a partial answer): an unknown is never counted as unread.
 */
export function countSeen(uids: number[], fetched: Map<number, Map<string, ImapValue>>): number | null {
  let seen = 0;
  for (const u of uids) {
    const flags = fetched.get(u)?.get('FLAGS');
    if (!Array.isArray(flags)) return null;
    if (flags.some((f) => String(f).toLowerCase() === '\\seen')) seen++;
  }
  return seen;
}

export function isOutgoing(meta: Pick<MailMeta, 'labels'>): boolean {
  return meta.labels.some((l) => OUTGOING_LABELS.includes(l.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function fold(text: string): string {
  return text.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [+${text.length - max} chars]`;
}

function hhmm(date: Date, timeZone?: string): string {
  return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone });
}

/**
 * The line prefix: names the mailbox, because several can be watched. A label replaces the address
 * when lines from several mailboxes share one chat and must be told apart at a glance.
 */
export function mailTag(account?: string, label?: string): string {
  if (label) return `[${label}]`;
  return account ? `[mail ${account}]` : '[mail]';
}

/**
 * The web link for a message: Gmail's decimal X-GM-MSGID is the hex id the web UI uses. With an
 * account, `u/<address>` opens it in that mailbox even when another is the browser's default.
 */
export function messageUrl(msgId: string | null, account?: string): string | null {
  if (!msgId) return null;
  try {
    return `https://mail.google.com/mail/u/${account ? encodeURIComponent(account) : '0'}/#all/${BigInt(msgId).toString(16)}`;
  } catch {
    return null;
  }
}

/**
 * A function that removes the given secrets (each raw and with whitespace stripped) from text.
 * Built once from the credentials a process uses, so a later change to the secrets file cannot drop
 * a password that is still in use from the list.
 */
export function makeScrubber(secrets: string[]): (text: string) => string {
  const values = [...new Set(secrets.flatMap((v) => [v, v.replace(/\s+/g, '')]))].filter((v) => v.length >= 8);
  return (text: string) => values.reduce((out, v) => out.split(v).join('[redacted]'), text);
}

export interface FormatOptions {
  /** Applied to every field before it is folded, truncated or serialised. */
  scrub?: (text: string) => string;
  /** The mailbox address, named on every line. */
  account?: string;
  /** Short text shown instead of the address in the prefix, e.g. "📬 personal". */
  label?: string;
  maxText: number;
  json: boolean;
  timeZone?: string;
}

export function formatMail(meta: MailMeta, opts: FormatOptions): string {
  const clean = (t: string) => redactSecrets((opts.scrub ?? ((x: string) => x))(t));
  const from = truncate(fold(clean(meta.from)), 120);
  const subject = truncate(fold(clean(meta.subject)), opts.maxText);
  const url = messageUrl(meta.msgId, opts.account);
  if (opts.json) {
    return JSON.stringify({
      account: opts.account ?? null,
      uid: meta.uid,
      id: meta.msgId,
      time: meta.date?.toISOString() ?? null,
      category: meta.category,
      labels: meta.labels,
      from,
      subject,
      url,
    });
  }
  const time = meta.date ? hhmm(meta.date, opts.timeZone) : '--:--';
  return `${mailTag(opts.account, opts.label)} ${time} ${meta.category} ${from}: ${subject || '(no subject)'}${url ? ` ${url}` : ''}`;
}

/**
 * A status line (start, heartbeat, error, overflow, re-baseline): `[mail <account>] <text>`, or in
 * JSON mode `{"account":…,"notice":…}`, so a JSON-lines reader never meets a plain-text line.
 */
export function formatNotice(text: string, opts: Pick<FormatOptions, 'account' | 'json' | 'label' | 'scrub'>): string {
  text = redactSecrets((opts.scrub ?? ((x: string) => x))(text));
  return opts.json ? JSON.stringify({ account: opts.account ?? null, notice: text }) : `${mailTag(opts.account, opts.label)} ${text}`;
}

/** The notice standing for messages past the flood cap. They were not read, so no detail. */
export function overflowLine(count: number, opts: Pick<FormatOptions, 'account' | 'json' | 'label' | 'scrub'>): string {
  const where = `https://mail.google.com/mail/u/${opts.account ? encodeURIComponent(opts.account) : '0'}/#all`;
  return formatNotice(`+${count} more new message(s) not listed (flood cap); see ${where}`, opts);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface GmailWatchState {
  /** The account the cursor belongs to; a different account re-baselines rather than reusing it. */
  account?: string;
  mailbox: string;
  uidValidity: number;
  lastUid: number;
  /** When the server last answered a command; the heartbeat's measure of health. */
  lastOkAt?: string;
}

function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]/g, '_') || 'default';
}

export function gmailWatchStatePath(stateName: string): string {
  return join(getConfigDir(), 'gmail-watch', safeName(stateName), 'state.json');
}

/**
 * The default state name for a mailbox: readable, plus a hash of the exact lower-cased address,
 * because safeName() is lossy (o'brien@ and o_brien@ would otherwise share one file).
 */
/**
 * The state file for a mailbox's default state name. When the hashed file does not exist yet but the
 * name used before hashing does (safeName of the address) and it belongs to this account, it is
 * carried over, so an upgrade does not silently re-baseline past mail that arrived meanwhile.
 */
export function defaultStatePath(account: string, opts: { reset?: boolean } = {}): string {
  const path = gmailWatchStatePath(accountStateName(account));
  const legacy = gmailWatchStatePath(account);
  // The pre-hash name is lossy, so the file there may be ANOTHER account's: only ever adopt or
  // retire it when it is this account's (or carries no account at all).
  const old = existsSync(legacy) ? loadGmailWatchState(legacy) : null;
  const ours = !!old && (!old.account || old.account.trim().toLowerCase() === account.trim().toLowerCase());
  if (opts.reset) {
    // A reset is permanent: drop the hashed file AND retire our pre-hash one, so a later run cannot
    // fall back to an old checkpoint and replay mail already reported.
    rmSync(path, { force: true });
    if (ours) renameSync(legacy, `${legacy}.retired`);
    return path;
  }
  if (existsSync(path)) return path;
  if (ours && old) {
    saveGmailWatchState(path, { ...old, account });
    // One-time: the pre-hash file is retired once carried over, never read again.
    renameSync(legacy, `${legacy}.migrated`);
  }
  return path;
}

export function accountStateName(account: string): string {
  const key = account.trim().toLowerCase();
  return `${safeName(key)}-${createHash('sha256').update(key).digest('hex').slice(0, 10)}`;
}

export function loadGmailWatchState(path: string): GmailWatchState | null {
  try {
    const p = JSON.parse(readFileSync(path, 'utf-8'));
    if (typeof p?.mailbox !== 'string' || !Number.isInteger(p.uidValidity) || !Number.isInteger(p.lastUid)) return null;
    return {
      account: typeof p.account === 'string' ? p.account : undefined,
      mailbox: p.mailbox,
      uidValidity: p.uidValidity,
      lastUid: p.lastUid,
      lastOkAt: typeof p.lastOkAt === 'string' ? p.lastOkAt : undefined,
    };
  } catch {
    return null;
  }
}

export function saveGmailWatchState(path: string, state: GmailWatchState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tempPath, JSON.stringify(state), { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
    renameSync(tempPath, path);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// The watcher
// ---------------------------------------------------------------------------

export interface GmailWatchOptions extends FormatOptions {
  /** Most message lines per cycle; the rest become one summary line. */
  maxPerPoll: number;
  /** Above this many new messages in one cycle, report the count only and classify nothing. */
  maxBacklog: number;
  excludeCategories: Category[];
}

export interface GmailWatchIO {
  source: MailSource;
  loadState: () => GmailWatchState | null;
  saveState: (state: GmailWatchState) => void;
  emit: (lines: string[]) => Promise<void>;
  now?: () => Date;
}

export class GmailWatcher {
  private state: GmailWatchState | null;
  private opened = false;
  private reportedSince = 0;

  constructor(private readonly opts: GmailWatchOptions, private readonly io: GmailWatchIO) {
    this.state = io.loadState();
  }

  /** Lines reported since the last call; for the heartbeat. */
  takeReportedCount(): number {
    const n = this.reportedSince;
    this.reportedSince = 0;
    return n;
  }

  lastOkAt(): string | null {
    return this.state?.lastOkAt ?? null;
  }

  private now(): Date {
    return (this.io.now ?? (() => new Date()))();
  }

  /** Reopens the session after an error. The caller decides when (backoff). */
  async reset(): Promise<void> {
    this.opened = false;
    try { await this.io.source.close(); } catch { /* already gone */ }
  }

  /**
   * One cycle: open if needed, ask the server for new mail, report it, save the cursor.
   * The first run (no state) and a changed UIDVALIDITY only record a baseline.
   */
  async tick(): Promise<void> {
    const src = this.io.source;
    if (!this.opened) {
      const { uidValidity, mailbox } = await src.open();
      this.opened = true;
      const account = this.opts.account;
      const norm = (a?: string) => a?.trim().toLowerCase();
      const otherAccount = !!this.state && norm(this.state.account) !== norm(account);
      if (!this.state || otherAccount || this.state.uidValidity !== uidValidity || this.state.mailbox !== mailbox) {
        const hadState = this.state !== null;
        const all = await src.uidsAfter(0);
        const lastUid = all.length ? all[all.length - 1] : 0;
        this.state = { account, mailbox, uidValidity, lastUid, lastOkAt: this.now().toISOString() };
        this.io.saveState(this.state);
        if (hadState) {
          const why = otherAccount
            ? 'the saved position belonged to another account'
            : 'the mailbox was renumbered (UIDVALIDITY changed)';
          await this.io.emit([formatNotice(`${why}; re-baselined, mail before now is not reported`, this.opts)]);
        }
        return;
      }
    } else {
      await src.ping();
    }

    const state = this.state!;
    const uids = await src.uidsAfter(state.lastUid);
    if (uids.length > this.opts.maxBacklog) {
      // Far more than anyone reads as lines (a long outage, or a bulk import): say how many and move
      // on, instead of classifying them all. Classification is what would otherwise time out forever.
      await this.io.emit([formatNotice(`${uids.length} new messages since the last check, more than ${this.opts.maxBacklog}; not listed. See the mailbox.`, this.opts)]);
      this.reportedSince += uids.length;
      this.state = { ...state, lastUid: uids[uids.length - 1], lastOkAt: this.now().toISOString() };
      this.io.saveState(this.state);
      return;
    }
    if (uids.length === 0) {
      this.state = { ...state, lastOkAt: this.now().toISOString() };
      this.io.saveState(this.state);
      return;
    }

    // Decide what is reportable from labels and categories first, so his own sent mail and excluded
    // categories neither take a place under the flood cap nor count in the overflow. Then read the
    // headers of at most a cap's worth; past it only the count is reported.
    const classes = await src.classify(uids);
    const eligible = uids.filter((u) => {
      const c = classes.get(u);
      return c && !isOutgoing(c) && !this.opts.excludeCategories.includes(c.category);
    });
    const shown = eligible.slice(0, this.opts.maxPerPoll);
    // Filter again on what describe() saw: a message re-categorised or labelled between the two
    // calls must not print in a category he excluded.
    const metas = (await src.describe(shown)).filter((m) => !isOutgoing(m) && !this.opts.excludeCategories.includes(m.category));
    const lines = metas.map((m) => formatMail(m, this.opts));
    const rest = eligible.length - shown.length;
    if (rest > 0) lines.push(overflowLine(rest, this.opts));
    if (lines.length) await this.io.emit(lines);
    this.reportedSince += metas.length + rest;

    this.state = { ...state, lastUid: uids[uids.length - 1], lastOkAt: this.now().toISOString() };
    this.io.saveState(this.state);
  }
}

export { ImapAuthError };

// ---------------------------------------------------------------------------
// Volume counting
// ---------------------------------------------------------------------------

export interface DayCount {
  day: string;
  total: number;
  categories: Record<Category, number>;
  automated: number;
}

/**
 * Midnight of each of the last `days` local dates in `timeZone`, oldest first, plus the midnight
 * that ends today. Each midnight is resolved on its own date, so a day that crosses a DST change is
 * 23 or 25 hours long rather than shifted.
 */
export function dayBoundaries(days: number, now: Date, timeZone: string): Date[] {
  // The requested calendar dates plus the NEXT CALENDAR DATE, by date arithmetic - never by adding
  // 24 elapsed hours, which lands on the wrong date across a DST change.
  const requested = localDates(days, now, timeZone);
  const last = requested[requested.length - 1];
  const dates = [...requested, new Date(Date.parse(`${last}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)];
  // A calendar date that a zone skipped entirely (Pacific/Apia, 2011-12-30) resolves to the next
  // day's start, so its interval is simply empty; never earlier than the boundary before it.
  const out: Date[] = [];
  for (const date of dates) {
    const t = localMidnight(date, timeZone);
    out.push(new Date(out.length ? Math.max(t, out[out.length - 1].getTime()) : t));
  }
  return out;
}

/** The last `days` calendar dates (YYYY-MM-DD) in `timeZone`, oldest first, today last. */
export function localDates(days: number, now: Date, timeZone: string): string[] {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const today = Date.parse(`${fmt.format(now)}T00:00:00Z`); // today's local date, as a UTC calendar day
  const out: string[] = [];
  for (let d = days - 1; d >= 0; d--) out.push(new Date(today - d * 86_400_000).toISOString().slice(0, 10));
  return out;
}

/**
 * The first instant of local `date` (YYYY-MM-DD) in `timeZone`. Usually 00:00; where a DST change
 * skips midnight (e.g. São Paulo 2018-11-04 went 23:59:59 -> 01:00), it is the first instant that
 * exists, and it always belongs to `date` itself, never to the day before.
 */
export function localMidnight(date: string, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const localDate = (t: number) => fmt.format(new Date(t));
  const asUtc = Date.parse(`${date}T00:00:00Z`);
  let t = asUtc - zoneOffsetMs(new Date(asUtc), timeZone);
  t = asUtc - zoneOffsetMs(new Date(t), timeZone);
  const STEP = 15 * 60_000;
  // Move forward while still on the previous date, then back while the previous step is still `date`.
  for (let i = 0; i < 4 * 26 && localDate(t) < date; i++) t += STEP;
  for (let i = 0; i < 4 * 26 && localDate(t - STEP) === date; i++) t -= STEP;
  // Fine-tune to the minute inside the last 15-minute step.
  for (let i = 0; i < 15 && localDate(t - 60_000) === date; i++) t -= 60_000;
  return t;
}

function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * Counts incoming mail per day with Gmail searches on All Mail. Only ids come back; no message is
 * fetched. Gmail's `after:`/`before:` take epoch seconds, so day boundaries are exact in `timeZone`.
 */
export async function countByDay(source: MailSource, days: number, now: Date, timeZone: string): Promise<DayCount[]> {
  const bounds = dayBoundaries(days, now, timeZone);
  const dates = localDates(days, now, timeZone);
  const out: DayCount[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const from = Math.floor(bounds[i].getTime() / 1000);
    const to = Math.floor(bounds[i + 1].getTime() / 1000);
    const base = `-in:spam -in:trash -in:sent -in:drafts -in:chats after:${from} before:${to}`;
    const total = (await source.search(base)).length;
    const categories = { primary: 0, promotions: 0, social: 0, updates: 0, forums: 0 } as Record<Category, number>;
    for (const cat of ['primary', ...CATEGORIES] as Category[]) {
      categories[cat] = (await source.search(`${base} category:${searchCategory(cat)}`)).length;
    }
    const automated = (await source.search(`${base} ${AUTOMATED_FROM}`)).length;
    out.push({ day: dates[i], total, categories, automated });
  }
  return out;
}
