// SQLite database for documentation storage and search

import Database from 'better-sqlite3';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { getConfigDir } from '../config/paths.js';

let db: Database.Database | null = null;

/**
 * Get the docs database file path
 */
export function getDocsDatabasePath(): string {
  return join(getConfigDir(), 'docs.db');
}

/**
 * Get or create the docs database connection (singleton)
 */
export function getDocsDatabase(): Database.Database {
  if (db) return db;

  const dbPath = getDocsDatabasePath();
  const configDir = getConfigDir();

  // Ensure config directory exists
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  db = new Database(dbPath);

  // Enable WAL mode for better concurrent access
  db.pragma('journal_mode = WAL');

  // Initialize schema if needed
  initSchema(db);

  return db;
}

/**
 * Close the docs database connection
 */
export function closeDocsDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Initialize the docs database schema
 */
function initSchema(database: Database.Database): void {
  // Check if tables exist
  const tableExists = database.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='documents'"
  ).get();

  if (tableExists) return;

  // Create documents table
  database.exec(`
    CREATE TABLE documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL,
      title TEXT,
      content TEXT NOT NULL,
      language TEXT,
      last_modified INTEGER,
      indexed_at INTEGER NOT NULL
    );

    CREATE INDEX idx_documents_path ON documents(path);
    CREATE INDEX idx_documents_type ON documents(type);
  `);

  // Create doc_chunks table
  database.exec(`
    CREATE TABLE doc_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      heading TEXT,
      content TEXT NOT NULL,
      start_line INTEGER,
      end_line INTEGER,
      FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE
    );

    CREATE INDEX idx_doc_chunks_doc ON doc_chunks(doc_id);
  `);

  // Create FTS5 virtual table for full-text search
  database.exec(`
    CREATE VIRTUAL TABLE doc_chunks_fts USING fts5(
      content,
      heading,
      content='doc_chunks',
      content_rowid='id',
      tokenize='porter unicode61'
    );
  `);

  // Create triggers to keep FTS in sync
  database.exec(`
    CREATE TRIGGER doc_chunks_ai AFTER INSERT ON doc_chunks BEGIN
      INSERT INTO doc_chunks_fts(rowid, content, heading)
      VALUES (new.id, new.content, new.heading);
    END;

    CREATE TRIGGER doc_chunks_ad AFTER DELETE ON doc_chunks BEGIN
      INSERT INTO doc_chunks_fts(doc_chunks_fts, rowid, content, heading)
      VALUES ('delete', old.id, old.content, old.heading);
    END;

    CREATE TRIGGER doc_chunks_au AFTER UPDATE ON doc_chunks BEGIN
      INSERT INTO doc_chunks_fts(doc_chunks_fts, rowid, content, heading)
      VALUES ('delete', old.id, old.content, old.heading);
      INSERT INTO doc_chunks_fts(rowid, content, heading)
      VALUES (new.id, new.content, new.heading);
    END;
  `);

  // Create sync state table
  database.exec(`
    CREATE TABLE docs_sync_state (
      path_prefix TEXT PRIMARY KEY,
      file_count INTEGER DEFAULT 0,
      chunk_count INTEGER DEFAULT 0,
      last_sync_at INTEGER
    );
  `);
}

/**
 * Document row type from database
 */
export interface DocumentRow {
  id: number;
  path: string;
  type: string;
  title: string | null;
  content: string;
  language: string | null;
  last_modified: number | null;
  indexed_at: number;
}

/**
 * Doc chunk row type from database
 */
export interface DocChunkRow {
  id: number;
  doc_id: number;
  chunk_index: number;
  heading: string | null;
  content: string;
  start_line: number | null;
  end_line: number | null;
}

/**
 * Sync state row type
 */
export interface DocsSyncStateRow {
  path_prefix: string;
  file_count: number;
  chunk_count: number;
  last_sync_at: number | null;
}
