/**
 * Creating a forum topic once (`bot topic create`).
 *
 * The Bot API can create a topic but cannot list them, so it cannot tell whether a title already exists. A retry after
 * a lost reply, or two sessions asked for the same track at once, would leave two topics a track could be routed to
 * (2026-10-07: one was a minute away). So every topic this machine creates is recorded by bot, chat and title in a
 * small SQLite database, and a second create of the same title returns the recorded id instead.
 *
 * The record is also the lock. Before the request goes out, the title is committed as PENDING (synchronous=FULL, so it
 * survives a crash). Anyone else asking for that title meanwhile is refused, and a reply lost to a timeout leaves the
 * mark in place, so the next attempt stops instead of making a second topic. SQLite's own locking serializes the
 * check-and-mark across processes and is released by the OS when a process dies, so nothing can be left locked.
 *
 * A second SQLite file is held (BEGIN EXCLUSIVE) for the whole create, from before the mark until after the id is
 * written, and so are `--retry` and `--record`. The OS releases it only when its holder exits, and a suspended holder
 * still holds it. So an override can only run once no creator is alive, and no clock or timeout decides that.
 * (Lock files with pid checks and an age-based in-flight window were tried first; Codex review of #26 found races
 * in each.)
 */
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { mkdirSync } from 'fs';
import { join } from 'path';

/** Telegram's limit on a topic name. */
export const MAX_TOPIC_TITLE = 128;

/**
 * The title exactly as Telegram stores it: a port of TDLib's clean_input_string, replace_offending_characters and
 * clean_name (strip_empty_characters) from td/telegram/misc.cpp, which createForumTopic applies. Recording any other
 * spelling lets two requests that Telegram stores identically make two topics (Codex review of #26, several rounds,
 * each finding one more character; this ports the rules instead of listing characters).
 */
export function telegramTopicName(title: string): string {
  // clean_input_string: control characters except \n become spaces, \r is dropped, U+2028..U+202E and the vertical
  // line marks U+0333, U+033F, U+030A are removed.
  let s = title
    .replace(/\r/g, '')
    .replace(/[\u0000-\u0009\u000B\u000C\u000E-\u001F]/g, ' ')
    .replace(/[\u2028-\u202E\u0333\u033F\u030A]/g, '');
  // replace_offending_characters: in a run of LRM/RLM marks, all but the last become ZERO WIDTH NON-JOINER.
  s = s.replace(/[\u200E\u200F]{2,}/g, (run) => '\u200C'.repeat(run.length - 1) + run.slice(-1));
  // strip_empty_characters: these space-like characters and the tag block U+E0000..U+E007F become spaces.
  s = s.replace(/[\u1680\u180E\u2000-\u200A\u202F\u205F\u2800\u3000\uFFFC]|[\u{E0000}-\u{E007F}]/gu, ' ');
  s = trimAscii(s);
  // A name made only of empty characters is empty.
  if (/^[ \n\u200B-\u200F\u202E\uFEFF\u00A0]*$/u.test(s)) return '';
  // clean_name: runs of space, newline and no-break space become one space; trimmed.
  return trimAscii(s.replace(/[ \n\u00A0]+/g, ' '));
}

/** td::trim: strips ASCII whitespace and control characters (code points up to U+0020) at both ends. */
function trimAscii(s: string): string {
  return s.replace(/^[\u0000- ]+|[\u0000- ]+$/g, '');
}

export function validateTopicTitle(title: string): string {
  const clean = telegramTopicName(title);
  if (clean === '') throw new Error('A topic needs a title.');
  if ([...clean].length > MAX_TOPIC_TITLE) throw new Error(`A topic title is at most ${MAX_TOPIC_TITLE} characters.`);
  return clean;
}

/**
 * The record key: the bot's numeric id (public, the part of the token before ":") and the chat's numeric id. A
 * username is refused: "@forum" and its numeric id would be two keys for one chat, and a username can change hands.
 */
export function topicRecordKey(token: string, chat: string): string {
  const botId = token.split(':')[0] ?? '';
  if (!/^\d+$/.test(botId)) throw new Error('The configured bot token is malformed.');
  return `${botId}:${canonicalChatId(chat)}`;
}

/**
 * The chat id in the one decimal spelling Telegram's parser would read it as: "-0100…" and "-100…" are one chat, so
 * they must be one key, and the request uses the same spelling (Codex review). Usernames are refused.
 */
export function canonicalChatId(chat: string): string {
  const text = chat.trim();
  if (!/^-?\d{1,20}$/.test(text)) throw new Error(`Give the group's numeric chat id (e.g. -100…), not ${JSON.stringify(chat)}.`);
  const id = BigInt(text);
  const limit = BigInt('9223372036854775807');
  if (id > limit || id < -limit) throw new Error(`${JSON.stringify(chat)} is out of range for a chat id.`);
  return id.toString();
}

type Row = { topic_id: number | null; state: 'pending' | 'created'; attempt: string };

function openRecord(configDir: string): Database.Database {
  mkdirSync(configDir, { recursive: true });
  const db = new Database(join(configDir, 'telegram-topics.db'));
  db.pragma('busy_timeout = 5000');
  // WAL with FULL makes a committed PENDING mark survive power loss; DELETE journaling with FULL does not (Codex review).
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.exec(`CREATE TABLE IF NOT EXISTS topics (
    key TEXT NOT NULL,
    title TEXT NOT NULL,
    topic_id INTEGER CHECK (topic_id IS NULL OR topic_id > 0),
    state TEXT NOT NULL CHECK (state IN ('pending', 'created')),
    attempt TEXT NOT NULL,
    PRIMARY KEY (key, title)
  )`);
  return db;
}

export function recordedTopic(configDir: string, key: string, title: string): number | 'pending' | undefined {
  const db = openRecord(configDir);
  try {
    const row = db.prepare('SELECT topic_id, state, attempt FROM topics WHERE key = ? AND title = ?').get(key, title) as Row | undefined;
    if (row === undefined) return undefined;
    return row.state === 'created' && row.topic_id !== null ? row.topic_id : 'pending';
  } finally {
    db.close();
  }
}

/**
 * Hold the machine-wide create lock: an EXCLUSIVE transaction on its own SQLite file, kept open until `release`.
 * Refused at once when another create holds it, alive or suspended.
 */
function holdCreateLock(configDir: string): () => void {
  mkdirSync(configDir, { recursive: true });
  const lock = new Database(join(configDir, 'telegram-topics.lock.db'));
  lock.pragma('busy_timeout = 2000');
  try {
    lock.exec('BEGIN EXCLUSIVE');
  } catch (error: any) {
    lock.close();
    if (error?.code === 'SQLITE_BUSY') throw new Error('Another topic create is running on this machine; retry when it finishes.');
    throw error;
  }
  return () => {
    try { lock.exec('ROLLBACK'); } finally { lock.close(); }
  };
}

/**
 * Create the topic unless this machine already did; `create` is the Bot API call.
 *
 * Only a refusal Telegram answered (`definite`) removes the PENDING mark. A mark found while holding the create lock
 * belongs to a creator that is gone, so `retry` may replace it once the caller has checked the group; `record` stores
 * an id found there. Each attempt carries its own id, and the result is written only over that attempt's mark.
 */
export async function createTopicOnce(opts: {
  configDir: string;
  key: string;
  title: string;
  create: () => Promise<number>;
  definite?: (error: unknown) => boolean;
  retry?: boolean;
  record?: number;
}): Promise<{ id: number; reused: boolean }> {
  const release = holdCreateLock(opts.configDir);
  const db = openRecord(opts.configDir);
  try {
    if (opts.record !== undefined) {
      if (!Number.isSafeInteger(opts.record) || opts.record <= 0) throw new Error(`A topic id is a positive integer, got ${opts.record}.`);
      db.prepare(`INSERT INTO topics (key, title, topic_id, state, attempt) VALUES (?, ?, ?, 'created', ?)
        ON CONFLICT (key, title) DO UPDATE SET topic_id = excluded.topic_id, state = 'created', attempt = excluded.attempt`)
        .run(opts.key, opts.title, opts.record, randomUUID());
      return { id: opts.record, reused: true };
    }

    const attempt = randomUUID();
    const claim = db.transaction((): { reuse: number } | null => {
      const row = db.prepare('SELECT topic_id, state, attempt FROM topics WHERE key = ? AND title = ?').get(opts.key, opts.title) as Row | undefined;
      if (row?.state === 'created' && row.topic_id !== null) return { reuse: row.topic_id };
      if (row !== undefined && !opts.retry) {
        throw new Error(
          `An earlier create of "${opts.title}" got no clear answer, so the topic may exist. Check the group: if it is there, `
          + 'record its id with --record <id>; if not, run again with --retry.',
        );
      }
      db.prepare(`INSERT INTO topics (key, title, topic_id, state, attempt) VALUES (?, ?, NULL, 'pending', ?)
        ON CONFLICT (key, title) DO UPDATE SET topic_id = NULL, state = 'pending', attempt = excluded.attempt`).run(opts.key, opts.title, attempt);
      return null;
    });
    const claimed = claim.immediate();
    if (claimed !== null) return { id: claimed.reuse, reused: true };

    let id: number;
    try {
      id = await opts.create();
    } catch (error) {
      if (opts.definite?.(error)) {
        db.prepare("DELETE FROM topics WHERE key = ? AND title = ? AND state = 'pending' AND attempt = ?").run(opts.key, opts.title, attempt);
      }
      throw error;
    }
    const written = db.prepare("UPDATE topics SET topic_id = ?, state = 'created' WHERE key = ? AND title = ? AND state = 'pending' AND attempt = ?")
      .run(id, opts.key, opts.title, attempt);
    if (written.changes !== 1) throw new Error(`Topic ${id} was created, but the record for "${opts.title}" changed meanwhile; check the group for a duplicate.`);
    return { id, reused: false };
  } finally {
    db.close();
    release();
  }
}

/**
 * Whether a failed createForumTopic was a refusal Telegram itself answered, so no topic exists. Only its client-error
 * answers count ("Bad Request", "Forbidden", "Not Found"), a rejected token, or a rate limit. A timeout, a dropped
 * connection, any 5xx, a body that was not Telegram's JSON, and "Invalid result received" (a 400 Telegram returns when
 * the create ran but its result could not be read) leave it unknown, and keep the PENDING mark (Codex review of #26).
 */
export function isDefiniteTopicRefusal(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/Invalid result/i.test(message)) return false;
  return /^Telegram Bot API createForumTopic: (Bad Request|Forbidden|Not Found)\b/.test(message)
    || /^Telegram rejected the bot token/.test(message)
    || /^Telegram rate limit/.test(message);
}
