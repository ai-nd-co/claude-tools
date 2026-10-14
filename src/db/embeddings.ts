// Unified embedding database for all content types (messages, clusters, jira issues, etc.)

import Database from 'better-sqlite3';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { getConfigDir } from '../config/paths.js';
import * as sqliteVec from 'sqlite-vec';

let embeddingsDb: Database.Database | null = null;
let vecLoaded = false;

// Content types for embeddings
export type ContentType = 'message' | 'cluster' | 'jira_issue' | 'jira_comment' | 'doc_chunk' | 'code_chunk';

/**
 * Get the embeddings database file path
 */
export function getEmbeddingsDbPath(): string {
  return join(getConfigDir(), 'embeddings.db');
}

/**
 * Get or create the embeddings database connection (singleton)
 */
export function getEmbeddingsDb(): Database.Database {
  if (embeddingsDb) return embeddingsDb;

  const dbPath = getEmbeddingsDbPath();
  const configDir = getConfigDir();

  // Ensure config directory exists
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  embeddingsDb = new Database(dbPath);

  // Enable WAL mode for better concurrent access
  embeddingsDb.pragma('journal_mode = WAL');

  // Initialize schema
  initEmbeddingsSchema(embeddingsDb);

  return embeddingsDb;
}

/**
 * Close the embeddings database connection
 */
export function closeEmbeddingsDb(): void {
  if (embeddingsDb) {
    embeddingsDb.close();
    embeddingsDb = null;
    vecLoaded = false;
  }
}

/**
 * Initialize the embeddings database schema
 */
function initEmbeddingsSchema(database: Database.Database): void {
  // Check if tables exist
  const tableExists = database.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='embeddings'"
  ).get();

  if (tableExists) return;

  // Create unified embeddings table
  database.exec(`
    CREATE TABLE embeddings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_type TEXT NOT NULL,
      content_id TEXT NOT NULL,
      embedding BLOB NOT NULL,
      model TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(content_type, content_id)
    );

    CREATE INDEX idx_embeddings_type_id ON embeddings(content_type, content_id);
    CREATE INDEX idx_embeddings_type ON embeddings(content_type);
  `);
}

/**
 * Load sqlite-vec extension and create vector tables
 */
export function loadEmbeddingsVectorExtension(): boolean {
  if (vecLoaded) return true;

  try {
    const database = getEmbeddingsDb();
    sqliteVec.load(database);
    vecLoaded = true;

    // Create vector tables if not exists
    createVectorTables(database);

    return true;
  } catch (err) {
    console.error('Failed to load sqlite-vec for embeddings:', (err as Error).message);
    return false;
  }
}

/**
 * Check if vector extension is loaded
 */
export function isEmbeddingsVectorLoaded(): boolean {
  return vecLoaded;
}

/**
 * Create vector tables (migration-safe)
 */
function createVectorTables(database: Database.Database): void {
  // Check if content_vectors table exists
  const vectorsExists = database.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='content_vectors'"
  ).get();

  if (vectorsExists) return;

  // Create the vec0 virtual table for KNN search
  // 768 dimensions for nomic-embed-text
  database.exec(`
    CREATE VIRTUAL TABLE content_vectors USING vec0(
      embedding FLOAT[768] distance_metric=cosine
    );

    CREATE TABLE vector_content_map (
      vec_rowid INTEGER PRIMARY KEY,
      content_type TEXT NOT NULL,
      content_id TEXT NOT NULL,
      UNIQUE(content_type, content_id)
    );

    CREATE INDEX idx_vcm_type ON vector_content_map(content_type);
    CREATE INDEX idx_vcm_type_id ON vector_content_map(content_type, content_id);
  `);
}

/**
 * Ensure vector tables exist
 */
export function ensureEmbeddingsVectorTables(): boolean {
  if (!loadEmbeddingsVectorExtension()) {
    return false;
  }
  const database = getEmbeddingsDb();
  createVectorTables(database);
  return true;
}

/**
 * Embedding row type from database
 */
export interface EmbeddingRow {
  id: number;
  content_type: string;
  content_id: string;
  embedding: Buffer;
  model: string;
  created_at: number;
}

/**
 * Vector content map row type
 */
export interface VectorContentMapRow {
  vec_rowid: number;
  content_type: string;
  content_id: string;
}
