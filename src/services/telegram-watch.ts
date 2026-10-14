// Telegram chat watcher: polls chats and prints one line per new or edited
// message, debounced so a burst of messages becomes one Monitor notification.
//
// The engine is I/O-free (connection, clock, output and state files are
// injected) so the debounce, edit detection and restart semantics are testable.

import { createHash } from 'crypto';
import { redactSecrets } from './redact.js';
import { isEmojiOnly } from './emoji.js';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { getConfigDir } from '../config/paths.js';
import { backoffDelay, formatDelay } from './backoff.js';

/** Stored text per message; only used for the "was:" part of edit lines. */
const STORED_TEXT_MAX = 1000;
/** Upper bound on messages fetched to close a gap after a long pause. */
const MAX_BACKLOG = 1000;
/** Consecutive poll failures before the watcher reports itself unhealthy. */
const FAILURES_BEFORE_ERROR = 3;

export interface WatchMessage {
  id: number;
  date: Date;
  sender: string;
  text: string;
  hasMedia?: boolean;
  mediaType?: string;
  /** Audio/voice length in seconds, when Telegram reports one. */
  mediaDuration?: number;
  /** Speech-to-text, filled in by the enrich hook just before the event is emitted. */
  transcript?: string;
  /** Why there is no `transcript`, when the clip was skipped rather than attempted. */
  transcriptSkipped?: string;
  /** True when this account sent the message, so a watcher can skip its own. */
  outgoing?: boolean;
  replyToId?: number;
  editDate?: Date;
}

export interface WatchChat {
  id: string;
  title: string;
  /** Opaque handle passed back to the fetch function (a ResolvedChat in the CLI). */
  peer: unknown;
}

export interface ChatWatchState {
  lastId: number;
  /**
   * Recent messages by ID: e = editDate (unix seconds, 0 = never edited),
   * t = text kept for showing what an edit replaced, h = fingerprint of the
   * whole message used to decide whether it actually changed.
   */
  recent: Record<string, { e: number; t: string; h?: string }>;
}

export interface WatchEvent {
  kind: 'new' | 'edit';
  chatId: string;
  chatTitle: string;
  msg: WatchMessage;
  previousText?: string;
}

export interface FetchOptions {
  limit: number;
  minId?: number;
  offsetId?: number;
}

export type FetchFn = (chat: WatchChat, opts: FetchOptions) => Promise<WatchMessage[]>;

export interface WatchIO {
  /** Open a connection (and the session lock) for the duration of one poll. */
  withConnection<T>(fn: (fetch: FetchFn) => Promise<T>): Promise<T>;
  loadState(chatId: string): ChatWatchState | null;
  saveState(chatId: string, state: ChatWatchState): void;
  /** Event lines for the agent (stdout). Written in one call so they arrive as one notification. */
  emit(lines: string[]): void;
  /** Diagnostics (stderr). */
  log(message: string): void;
  /**
   * Last chance to add to events before they are formatted and emitted, used to
   * transcribe voice notes. Runs only on events that are actually being
   * reported, so messages the diff discarded never cost an API call.
   */
  enrich?(events: WatchEvent[]): Promise<void>;
}

export interface WatchOptions {
  intervalMs: number;
  quietMs: number;
  maxWaitMs: number;
  settleMs: number;
  window: number;
  maxText: number;
  edits: boolean;
  json: boolean;
  timeZone?: string;
  /**
   * Drop a new message that is only emoji, has no media and replies to nothing (Davron #1470). A reply is kept:
   * a 👍 answering a question is an answer. Default on in the CLI; `--emoji` turns it off.
   */
  ignoreEmoji?: boolean;
}

// ---------------------------------------------------------------------------
// State files
// ---------------------------------------------------------------------------

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_');
}

export function watchStatePath(stateName: string, chatId: string): string {
  return join(getConfigDir(), 'telegram-watch', safeName(stateName), `${safeName(chatId)}.json`);
}

export function loadWatchState(path: string): ChatWatchState | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (typeof parsed?.lastId !== 'number' || typeof parsed?.recent !== 'object' || parsed.recent === null) return null;
    return parsed as ChatWatchState;
  } catch {
    return null;
  }
}

/** Write a complete replacement file so an interrupted process never leaves partial JSON. */
export function saveWatchState(path: string, state: ChatWatchState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tempPath, JSON.stringify(state), { encoding: 'utf-8', flag: 'wx' });
    renameSync(tempPath, path);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Diffing
// ---------------------------------------------------------------------------

/**
 * Fingerprint of everything an edit could change.
 *
 * The stored text is truncated for display, so comparing that alone misses an
 * edit past the cut-off, and it ignores attachments entirely — swapping a photo
 * while keeping the caption would look like no change at all. Hashing the full
 * text plus the media identity catches both.
 */
function contentFingerprint(msg: WatchMessage): string {
  const media = [msg.mediaType ?? '', msg.mediaDuration ?? '', msg.transcript ? '' : ''].join('\u0001');
  return createHash('sha256').update(`${msg.text}\u0000${media}`).digest('hex').slice(0, 16);
}

function editSeconds(msg: WatchMessage): number {
  return msg.editDate ? Math.floor(msg.editDate.getTime() / 1000) : 0;
}

function sortedUnique(messages: WatchMessage[]): WatchMessage[] {
  const byId = new Map<number, WatchMessage>();
  for (const msg of messages) byId.set(msg.id, msg);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

function trimRecent(recent: ChatWatchState['recent'], window: number): ChatWatchState['recent'] {
  const ids = Object.keys(recent).map(Number).sort((a, b) => b - a).slice(0, window);
  const trimmed: ChatWatchState['recent'] = {};
  for (const id of ids) trimmed[id] = recent[id];
  return trimmed;
}

/**
 * Compare a fetched window against the chat state.
 * With no prior state the window becomes the baseline and nothing is reported.
 * An edit is only reported for a message already tracked in `recent`, so a
 * message seen for the first time with an old editDate is never a false edit.
 */
export function diffMessages(
  state: ChatWatchState | null,
  messages: WatchMessage[],
  chat: Pick<WatchChat, 'id' | 'title'>,
  opts: { window: number; edits: boolean; ignoreEmoji?: boolean }
): { events: WatchEvent[]; next: ChatWatchState } {
  const sorted = sortedUnique(messages);
  const recent: ChatWatchState['recent'] = { ...(state?.recent ?? {}) };
  let lastId = state?.lastId ?? 0;
  const events: WatchEvent[] = [];

  for (const msg of sorted) {
    const e = editSeconds(msg);
    const known = recent[msg.id];
    if (state && msg.id > state.lastId) {
      // Still recorded below, so it is never reported later either: dropped, not deferred.
      const emojiOnly = opts.ignoreEmoji === true && !msg.hasMedia && msg.replyToId === undefined && isEmojiOnly(msg.text);
      if (!emojiOnly) events.push({ kind: 'new', chatId: chat.id, chatTitle: chat.title, msg });
    } else if (state && opts.edits && known && e > known.e) {
      // A reaction bumps the edit timestamp without touching the text, so
      // comparing timestamps alone reports an "edit" whose before and after are
      // identical. Since this watcher reacts 👀 to what it picks up, that turned
      // every message into a phantom edit of itself.
      //
      // The comparison is on a fingerprint of the whole message, not the stored
      // (truncated) text: otherwise an edit past the cut-off, or one that only
      // swaps an attachment, would be silently dropped. State written before
      // fingerprints existed falls back to the text it has.
      const changed = known.h !== undefined
        ? contentFingerprint(msg) !== known.h
        : msg.text.slice(0, STORED_TEXT_MAX) !== known.t;

      if (changed) {
        events.push({ kind: 'edit', chatId: chat.id, chatTitle: chat.title, msg, previousText: known.t });
      }
    }
    recent[msg.id] = { e, t: msg.text.slice(0, STORED_TEXT_MAX), h: contentFingerprint(msg) };
    lastId = Math.max(lastId, msg.id);
  }

  return { events, next: { lastId, recent: trimRecent(recent, opts.window) } };
}

// ---------------------------------------------------------------------------
// Debounce
// ---------------------------------------------------------------------------

export interface DebounceState {
  firstAt: number | null;
  lastChangeAt: number | null;
}

/**
 * Decide whether to flush pending events and when to poll next.
 * Pending events flush once `quietMs` pass without a change, or `maxWaitMs`
 * after the first change. While settling the chat is polled every `settleMs`.
 */
export function debounceStep(
  d: DebounceState,
  now: number,
  changed: boolean,
  opts: Pick<WatchOptions, 'intervalMs' | 'quietMs' | 'maxWaitMs' | 'settleMs'>
): { flush: boolean; next: DebounceState; delayMs: number } {
  const firstAt = changed ? (d.firstAt ?? now) : d.firstAt;
  const lastChangeAt = changed ? now : d.lastChangeAt;
  if (firstAt === null || lastChangeAt === null) {
    return { flush: false, next: { firstAt: null, lastChangeAt: null }, delayMs: opts.intervalMs };
  }
  const quietLeft = opts.quietMs - (now - lastChangeAt);
  const waitLeft = opts.maxWaitMs - (now - firstAt);
  if (quietLeft <= 0 || waitLeft <= 0) {
    return { flush: true, next: { firstAt: null, lastChangeAt: null }, delayMs: opts.intervalMs };
  }
  return {
    flush: false,
    next: { firstAt, lastChangeAt },
    delayMs: Math.max(0, Math.min(opts.settleMs, quietLeft, waitLeft)),
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function fold(text: string): string {
  return text.replace(/\r?\n/g, ' ⏎ ').trim();
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… [+${text.length - max} chars]`;
}

function hhmm(date: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone }).format(date);
}

export function formatWatchEvent(ev: WatchEvent, opts: Pick<WatchOptions, 'maxText' | 'json' | 'timeZone'>): string {
  const { msg } = ev;
  const mediaKind = msg.hasMedia ? (msg.mediaType || 'media') : undefined;
  // Length explains why a clip was or was not transcribed.
  const media = mediaKind && msg.mediaDuration !== undefined
    ? `${mediaKind} ${Math.round(msg.mediaDuration)}s`
    : mediaKind;
  const text = truncate(fold(msg.text), opts.maxText);
  // A skipped clip says why. Silence here is indistinguishable from a transcription failure, and the
  // reader has no way to learn that a duration cap exists — which is how a 60s cap went unnoticed in
  // team chats until two of the owner's voice messages were dropped by it.
  const transcript = msg.transcript
    ? truncate(fold(msg.transcript), opts.maxText)
    : msg.transcriptSkipped
      ? `[${msg.transcriptSkipped}]`
      : undefined;

  if (opts.json) {
    return JSON.stringify({
      type: ev.kind,
      chatId: ev.chatId,
      chatTitle: ev.chatTitle,
      id: msg.id,
      date: msg.date.toISOString(),
      editDate: msg.editDate?.toISOString(),
      sender: msg.sender,
      text,
      transcript,
      replyToId: msg.replyToId,
      media: mediaKind,
      mediaDuration: msg.mediaDuration,
      previousText: ev.previousText !== undefined ? truncate(fold(ev.previousText), opts.maxText) : undefined,
    });
  }

  const time = ev.kind === 'edit' ? `✎${hhmm(msg.editDate ?? msg.date, opts.timeZone)}` : hhmm(msg.date, opts.timeZone);
  const reply = msg.replyToId ? ` ↩${msg.replyToId}` : '';
  // A real transcript is quoted; a skip note already carries its own brackets and must not be.
  const rendered = msg.transcript ? (transcript ? `"${transcript}"` : '') : (transcript ?? '');
  const body = [media ? `[${media}]` : '', text, rendered]
    .filter(Boolean)
    .join(' ');
  const was = ev.kind === 'edit' && ev.previousText !== undefined
    ? ` (was: ${truncate(fold(ev.previousText), Math.ceil(opts.maxText / 2)) || '∅'})`
    : '';
  // Same reason as the bot watcher: a watched chat delivers its contents into a context unprompted.
  return redactSecrets(`[tg] ${ev.chatTitle} (${ev.chatId}) #${msg.id} ${time} ${msg.sender}${reply}: ${body}${was}`);
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class TelegramWatcher {
  private saved = new Map<string, ChatWatchState | null>();
  private mem = new Map<string, ChatWatchState | null>();
  private pending = new Map<string, WatchEvent>();
  private debounce: DebounceState = { firstAt: null, lastChangeAt: null };
  private failures = 0;
  private errorReported = false;
  private cappedChats = new Set<string>();

  constructor(
    private readonly chats: WatchChat[],
    private readonly opts: WatchOptions,
    private readonly io: WatchIO,
    initial: { sinceId?: number } = {}
  ) {
    for (const chat of chats) {
      const state = initial.sinceId !== undefined
        ? { lastId: initial.sinceId, recent: {} }
        : io.loadState(chat.id);
      this.saved.set(chat.id, state);
      this.mem.set(chat.id, state);
    }
  }

  /** Last reported (saved) message ID; pending messages are not counted. */
  lastId(chatId: string): number {
    return this.saved.get(chatId)?.lastId ?? 0;
  }

  hasPending(): boolean {
    return this.pending.size > 0;
  }

  /** Fetch the newest window; if all of it is new, page back to lastId so nothing is skipped. */
  private async fetchChat(fetch: FetchFn, chat: WatchChat): Promise<WatchMessage[]> {
    const state = this.mem.get(chat.id);
    const messages = await fetch(chat, { limit: this.opts.window });
    if (!state || messages.length === 0 || !messages.every((m) => m.id > state.lastId)) return messages;

    let offsetId = Math.min(...messages.map((m) => m.id));
    while (offsetId > state.lastId + 1) {
      if (messages.length >= MAX_BACKLOG) {
        this.cappedChats.add(chat.id);
        break;
      }
      const page = await fetch(chat, { limit: this.opts.window, minId: state.lastId, offsetId });
      if (page.length === 0) break;
      messages.push(...page);
      offsetId = Math.min(...page.map((m) => m.id));
    }
    return messages;
  }

  private addPending(ev: WatchEvent): void {
    const key = `${ev.chatId}:${ev.msg.id}`;
    const existing = this.pending.get(key);
    // A message edited before its burst flushed is reported once, with its latest text.
    this.pending.set(key, existing ? { ...existing, msg: ev.msg } : ev);
  }

  private async flush(): Promise<void> {
    const chatOrder = new Map(this.chats.map((c, i) => [c.id, i]));
    const events = [...this.pending.values()].sort(
      (a, b) => (chatOrder.get(a.chatId)! - chatOrder.get(b.chatId)!) || (a.msg.id - b.msg.id)
    );

    if (events.length && this.io.enrich) {
      // Never let enrichment lose an event: on failure the burst is emitted
      // as-is, exactly as it would have been without the hook.
      try {
        await this.io.enrich(events);
      } catch (err) {
        this.io.log(`enrich failed: ${(err as Error).message}`);
      }
    }

    const lines = events.map((ev) => formatWatchEvent(ev, this.opts));
    for (const chatId of this.cappedChats) {
      const title = this.chats.find((c) => c.id === chatId)?.title ?? chatId;
      lines.push(`[tg-watch] ${title} (${chatId}): more than ${MAX_BACKLOG} new messages; older ones were skipped, use telegram read`);
    }
    if (lines.length) this.io.emit(lines);
    this.pending.clear();
    this.cappedChats.clear();
    this.persist();
  }

  /** State is saved only when nothing is pending, so a kill mid-burst replays the burst on restart. */
  private persist(): void {
    for (const chat of this.chats) {
      const next = this.mem.get(chat.id);
      if (!next) continue;
      if (JSON.stringify(next) === JSON.stringify(this.saved.get(chat.id))) continue;
      this.io.saveState(chat.id, next);
      this.saved.set(chat.id, next);
    }
  }

  /** Run one poll; returns the delay before the next one. */
  async tick(now: number): Promise<number> {
    let changed = false;
    try {
      const results = await this.io.withConnection(async (fetch) => {
        const out = new Map<string, WatchMessage[]>();
        for (const chat of this.chats) out.set(chat.id, await this.fetchChat(fetch, chat));
        return out;
      });
      for (const chat of this.chats) {
        const { events, next } = diffMessages(this.mem.get(chat.id) ?? null, results.get(chat.id) ?? [], chat, this.opts);
        this.mem.set(chat.id, next);
        for (const ev of events) this.addPending(ev);
        if (events.length) changed = true;
      }
      if (this.errorReported) this.io.emit(['[tg-watch] recovered']);
      this.failures = 0;
      this.errorReported = false;
    } catch (err) {
      this.failures++;
      const message = (err as Error).message;
      this.io.log(`poll failed (${this.failures}): ${message}`);
      if (this.failures >= FAILURES_BEFORE_ERROR && !this.errorReported) {
        this.io.emit([`[tg-watch] ERROR ${message} (retrying)`]);
        this.errorReported = true;
      }

      // Back off rather than hammering a dead link at the normal poll interval.
      // Four watchers share one Telegram session here, so retrying in lockstep
      // during an outage is its own small denial of service. Pending events are
      // deliberately left queued: they flush once the connection returns.
      const delayMs = backoffDelay(this.failures);
      if (this.failures === FAILURES_BEFORE_ERROR) {
        this.io.log(`backing off, next attempt in ${formatDelay(delayMs)}`);
      }
      return delayMs;
    }

    const step = debounceStep(this.debounce, now, changed, this.opts);
    this.debounce = step.next;
    if (step.flush) await this.flush();
    else if (!this.hasPending()) this.persist();
    return step.delayMs;
  }
}
