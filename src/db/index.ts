// SQLite database for Telegram message storage and search

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { createHash, randomUUID } from 'crypto';
import { loadConfig } from '../config/loader.js';
import { getConfigDir } from '../config/paths.js';

let db: Database.Database | null = null;

export const SCHEMA_VERSION = 3;

/**
 * Get the database file path
 */
export function getDatabasePath(): string {
  return join(getConfigDir(), 'telegram.db');
}

/**
 * Get or create the database connection (singleton)
 */
export function getDatabase(): Database.Database {
  return openDatabase(null);
}

/**
 * The account a live client just reported (getMe), and the session string that client was
 * built from. Only an open carrying both may accept a new session for the cache's own account.
 */
interface VerifiedSession { accountId: string; sessionString: string }

const fingerprintOf = (session: string | undefined) => session ? createHash('sha256').update(session).digest('hex') : 'unconfigured';

function openDatabase(verified: VerifiedSession | null): Database.Database {
  if (db) return db;

  const dbPath = getDatabasePath();
  const configDir = getConfigDir();

  // Ensure config directory exists
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  db = new Database(dbPath);

  // Enable WAL mode for better concurrent access
  db.pragma('journal_mode = WAL');

  try {
    migrateDatabase(db, dbPath);
    initSchema(db);
    validateCacheSession(db, verified);
    return db;
  } catch (error) {
    db.close();
    db = null;
    throw error;
  }
}

/**
 * Preserve old rows without guessing their peer type. The old schemas store raw
 * IDs only: a positive ID could mean a user, group, or channel. Quarantined rows
 * remain available for recovery; selected-chat sync rebuilds verified history.
 */
export function migrateDatabase(database: Database.Database, path: string): void {
  const version = database.pragma('user_version', { simple: true }) as number;
  if (version > SCHEMA_VERSION) throw new Error('Unsupported future Telegram cache schema');
  const exists = database.prepare("SELECT 1 FROM sqlite_master WHERE name='messages'").get();
  if (!exists || version === SCHEMA_VERSION) return;
  if (database.prepare("SELECT 1 FROM sqlite_master WHERE name='message_vectors'").get()) sqliteVec.load(database);
  const backup = path + '.before-v3-' + randomUUID() + '.db';
  // VACUUM INTO includes committed WAL contents in a standalone consistent backup.
  database.prepare('VACUUM INTO ?').run(backup);
  database.transaction(() => {
    database.exec(`
      DROP TRIGGER IF EXISTS messages_ai;
      DROP TRIGGER IF EXISTS messages_ad;
      DROP TRIGGER IF EXISTS messages_au;
      DROP TABLE IF EXISTS messages_fts;
      DROP TABLE IF EXISTS cluster_messages;
      DROP TABLE IF EXISTS clusters;
      DROP TABLE IF EXISTS message_vectors;
      DROP TABLE IF EXISTS vector_map;
      DROP TABLE IF EXISTS message_embeddings;
    `);
    database.exec('ALTER TABLE messages RENAME TO legacy_messages');
    const syncExists = database.prepare("SELECT 1 FROM sqlite_master WHERE name='sync_state'").get();
    if (syncExists) database.exec('ALTER TABLE sync_state RENAME TO legacy_sync_state');
    // Old index names are database-global, even after renaming the tables.
    const indexes = database.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='legacy_messages' AND sql IS NOT NULL").all() as Array<{name:string}>;
    for (const index of indexes) database.exec('DROP INDEX "' + index.name.replaceAll('"', '""') + '"');
    initSchema(database);
    database.prepare("INSERT INTO cache_metadata(key,value) VALUES ('legacy_backfill_required','1')").run();
  })();
  console.error('Telegram cache upgraded safely. Legacy messages and sync metadata are preserved in legacy_messages / legacy_sync_state and ' + backup + '. Peer types were not stored; run telegram sync <explicit-chat> --force to backfill verified history.');
}

function validateCacheSession(database: Database.Database, verified: VerifiedSession | null): void {
  const fingerprint = fingerprintOf(loadConfig().telegram?.sessionString);
  const previous = database.prepare("SELECT value FROM cache_metadata WHERE key='session'").get() as {value:string}|undefined;
  if (previous && previous.value !== fingerprint) {
    // A relogin always yields a new session string. It is the same cache owner only when a client
    // built from the configured session reports the account this cache is bound to. The session is
    // compared too, so a config rewritten while that client was connecting cannot ride its proof.
    const account = database.prepare("SELECT value FROM cache_metadata WHERE key='account'").get() as {value:string}|undefined;
    const sameSession = verified && fingerprintOf(verified.sessionString) === fingerprint;
    if (sameSession && account?.value === verified.accountId) {
      database.prepare("UPDATE cache_metadata SET value=? WHERE key='session'").run(fingerprint);
      return;
    }
    if (sameSession && account && account.value !== verified.accountId) throw new Error('Telegram account changed; use a separate config directory. Existing cache preserved.');
    throw new Error(account
      ? 'Telegram session changed since this cache was written. If you logged in again to the same account, run any live command (for example telegram read me) once: it checks the account and keeps the cache. A different account needs a separate config directory. The existing cache has been preserved.'
      : 'Telegram session changed and this cache records no account to check it against. Use a separate config directory for this account; the existing cache has been preserved.');
  }
  database.prepare("INSERT OR IGNORE INTO cache_metadata(key,value) VALUES ('session',?)").run(fingerprint);
}

export function getKnownPeers(): Array<{id:string;title:string}> {
  return (getDatabase().prepare('SELECT chat_id AS id, chat_title AS title FROM sync_state UNION SELECT chat_id AS id, chat_title AS title FROM messages UNION SELECT id,title FROM peer_registry').all() as Array<{id:string;title:string}>).map(p=>({...p,title:p.title || ''}));
}

export function rememberPeer(id:string,title:string,username?:string): void {
  const database=getDatabase();
  database.transaction(()=>{
    if(username) database.prepare('UPDATE peer_registry SET username=NULL WHERE username=? AND id<>?').run(username.toLowerCase(),id);
    database.prepare('INSERT INTO peer_registry(id,title,username) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,username=excluded.username').run(id,title,username?.toLowerCase() || null);
  })();
}

/** `sessionString` is the session the client that reported `accountId` was built from, when known. */
export function bindCacheAccount(accountId: string, sessionString?: string): void {
  const database = openDatabase(sessionString ? { accountId, sessionString } : null);
  const previous = database.prepare("SELECT value FROM cache_metadata WHERE key='account'").get() as {value:string}|undefined;
  if (previous && previous.value !== accountId) throw new Error('Telegram account changed; use a separate config directory. Existing cache preserved.');
  database.prepare("INSERT OR IGNORE INTO cache_metadata(key,value) VALUES ('account',?)").run(accountId);
}

export function getCacheGeneration(): string {
  return (getDatabase().prepare("SELECT value FROM cache_metadata WHERE key='generation'").get() as {value:string}).value;
}

/**
 * Close the database connection
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Initialize the database schema
 */
function initSchema(database: Database.Database): void {
  // Check if tables exist
  const tableExists = database.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='messages'"
  ).get();

  if (tableExists) return;

  // Create messages table.
  //
  // Telegram message ids are unique per-chat, not globally. The real key is
  // (chat_id, id). We use a surrogate `msg_rowid` integer PK so FTS5
  // (content_rowid needs a single INTEGER) and all FK tables reference one
  // stable column, while UNIQUE(chat_id, id) enforces the Telegram pair.
  database.exec(`
    CREATE TABLE messages (
      msg_rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      id INTEGER NOT NULL,
      chat_title TEXT,
      sender TEXT,
      text TEXT,
      date INTEGER NOT NULL,
      reply_to_id INTEGER,
      reply_to_peer_id TEXT,
      has_media BOOLEAN DEFAULT FALSE,
      media_type TEXT,
      synced_at INTEGER NOT NULL,
      reactions TEXT,
      entities TEXT,
      UNIQUE(chat_id, id)
    );

    CREATE INDEX idx_messages_chat_date ON messages(chat_id, date);
    CREATE INDEX idx_messages_date ON messages(date);
    CREATE INDEX idx_messages_chat_reply ON messages(chat_id, reply_to_id);
  `);

  // Create FTS5 virtual table for full-text search
  database.exec(`
    CREATE VIRTUAL TABLE messages_fts USING fts5(
      text,
      sender,
      chat_title,
      content='messages',
      content_rowid='msg_rowid',
      tokenize='porter unicode61'
    );
  `);

  // Create triggers to keep FTS in sync
  database.exec(`
    CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, text, sender, chat_title)
      VALUES (new.msg_rowid, new.text, new.sender, new.chat_title);
    END;

    CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text, sender, chat_title)
      VALUES ('delete', old.msg_rowid, old.text, old.sender, old.chat_title);
    END;

    CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text, sender, chat_title)
      VALUES ('delete', old.msg_rowid, old.text, old.sender, old.chat_title);
      INSERT INTO messages_fts(rowid, text, sender, chat_title)
      VALUES (new.msg_rowid, new.text, new.sender, new.chat_title);
    END;
  `);

  // Create sync state table
  database.exec(`
    CREATE TABLE peer_registry (id TEXT PRIMARY KEY, title TEXT NOT NULL, username TEXT);
    CREATE TABLE cache_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE sync_state (
      chat_id TEXT PRIMARY KEY,
      chat_title TEXT,
      last_message_id INTEGER,
      oldest_message_id INTEGER,
      message_count INTEGER DEFAULT 0,
      last_sync_at INTEGER
    );
  `);

  database.prepare("INSERT INTO cache_metadata(key,value) VALUES ('generation',?)").run(randomUUID());

  // Create cluster tables
  createClusterTables(database);

  // Stamp the schema version so future incompatible changes are detected.
  database.pragma(`user_version = ${SCHEMA_VERSION}`);
}

/**
 * Create cluster tables (migration-safe)
 */
function createClusterTables(database: Database.Database): void {
  // Check if clusters table exists
  const clustersExists = database.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='clusters'"
  ).get();

  if (clustersExists) return;

  database.exec(`
    CREATE TABLE clusters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      start_time INTEGER NOT NULL,
      end_time INTEGER NOT NULL,
      message_count INTEGER,
      first_msg_rowid INTEGER REFERENCES messages(msg_rowid),
      last_msg_rowid INTEGER REFERENCES messages(msg_rowid)
    );

    CREATE INDEX idx_clusters_chat ON clusters(chat_id);
    CREATE INDEX idx_clusters_time ON clusters(chat_id, start_time);

    CREATE TABLE cluster_messages (
      cluster_id INTEGER REFERENCES clusters(id),
      msg_rowid INTEGER REFERENCES messages(msg_rowid),
      PRIMARY KEY (cluster_id, msg_rowid)
    );

    CREATE INDEX idx_cluster_messages_msg ON cluster_messages(msg_rowid);
  `);
}

/**
 * Ensure cluster tables exist (for existing databases)
 */
export function ensureClusterTables(): void {
  const database = getDatabase();
  createClusterTables(database);

  // Add missing index for existing databases (migration-safe)
  const indexExists = database.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_cluster_messages_msg'"
  ).get();

  if (!indexExists) {
    try {
      database.exec('CREATE INDEX idx_cluster_messages_msg ON cluster_messages(msg_rowid)');
    } catch {
      // Table might not exist yet, ignore
    }
  }
}

/**
 * Ensure reactions column exists in messages table (migration-safe)
 */
export function ensureReactionsColumn(): void {
  const database = getDatabase();

  // Check if reactions column exists
  const columnExists = database.prepare(
    "SELECT 1 FROM pragma_table_info('messages') WHERE name = 'reactions'"
  ).get();

  if (!columnExists) {
    try {
      database.exec('ALTER TABLE messages ADD COLUMN reactions TEXT');
    } catch {
      // Column might already exist, ignore
    }
  }
}

/**
 * Ensure entities column exists in messages table (migration-safe)
 * Entities store Telegram message formatting (links, bold, italic, etc.)
 */
export function ensureEntitiesColumn(): void {
  const database = getDatabase();

  // Check if entities column exists
  const columnExists = database.prepare(
    "SELECT 1 FROM pragma_table_info('messages') WHERE name = 'entities'"
  ).get();

  if (!columnExists) {
    try {
      database.exec('ALTER TABLE messages ADD COLUMN entities TEXT');
    } catch {
      // Column might already exist, ignore
    }
  }
}

/**
 * Message row type from database
 */
export interface MessageRow {
  msg_rowid: number;
  id: number;
  chat_id: string;
  chat_title: string | null;
  sender: string | null;
  text: string | null;
  date: number;
  reply_to_id: number | null;
  reply_to_peer_id?: string | null;
  has_media: number;
  media_type: string | null;
  synced_at: number;
  reactions: string | null;  // JSON: '[{"emoji":"👍","count":3}]'
  entities: string | null;   // JSON: '[{"type":"textUrl","offset":0,"length":4,"url":"https://..."}]'
}

/**
 * Sync state row type
 */
export interface SyncStateRow {
  chat_id: string;
  chat_title: string | null;
  last_message_id: number | null;
  oldest_message_id: number | null;
  message_count: number;
  last_sync_at: number | null;
}

/**
 * Cluster row type
 */
export interface ClusterRow {
  id: number;
  chat_id: string;
  start_time: number;
  end_time: number;
  message_count: number;
  first_msg_rowid: number;
  last_msg_rowid: number;
}

/**
 * Cluster message row type
 */
export interface ClusterMessageRow {
  cluster_id: number;
  msg_rowid: number;
}

// Note: message embeddings live in the separate unified embeddings store
// (src/db/embeddings.ts, content_vectors). The legacy per-message vector
// tables that used to live here keyed on a global message id and were unused;
// they were removed with the v2 (chat_id, id) rework.
