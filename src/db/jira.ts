// SQLite database for Jira issue storage and search

import Database from 'better-sqlite3';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { getConfigDir } from '../config/paths.js';

let db: Database.Database | null = null;

/**
 * Get the Jira database file path
 */
export function getJiraDatabasePath(): string {
  return join(getConfigDir(), 'jira.db');
}

/**
 * Get or create the Jira database connection (singleton)
 */
export function getJiraDatabase(): Database.Database {
  if (db) return db;

  const dbPath = getJiraDatabasePath();
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
 * Close the Jira database connection
 */
export function closeJiraDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Initialize the Jira database schema
 */
function initSchema(database: Database.Database): void {
  // Check if tables exist
  const tableExists = database.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='jira_issues'"
  ).get();

  if (tableExists) return;

  // Create issues table
  database.exec(`
    CREATE TABLE jira_issues (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      project_key TEXT NOT NULL,
      summary TEXT,
      description TEXT,
      status TEXT,
      status_category TEXT,
      assignee_id TEXT,
      assignee_name TEXT,
      reporter_id TEXT,
      reporter_name TEXT,
      priority TEXT,
      issue_type TEXT,
      labels TEXT,
      created INTEGER NOT NULL,
      updated INTEGER NOT NULL,
      resolved INTEGER,
      synced_at INTEGER NOT NULL,
      in_backlog INTEGER DEFAULT 0
    );

    CREATE INDEX idx_jira_issues_project ON jira_issues(project_key);
    CREATE INDEX idx_jira_issues_key ON jira_issues(key);
    CREATE INDEX idx_jira_issues_updated ON jira_issues(updated);
    CREATE INDEX idx_jira_issues_status ON jira_issues(status);
    CREATE INDEX idx_jira_issues_assignee ON jira_issues(assignee_id);
    CREATE INDEX idx_jira_issues_backlog ON jira_issues(in_backlog);
  `);

  // Create FTS5 virtual table for full-text search
  database.exec(`
    CREATE VIRTUAL TABLE jira_issues_fts USING fts5(
      key,
      summary,
      description,
      assignee_name,
      reporter_name,
      labels,
      content='jira_issues',
      content_rowid='rowid',
      tokenize='porter unicode61'
    );
  `);

  // Create triggers to keep FTS in sync
  database.exec(`
    CREATE TRIGGER jira_issues_ai AFTER INSERT ON jira_issues BEGIN
      INSERT INTO jira_issues_fts(rowid, key, summary, description, assignee_name, reporter_name, labels)
      VALUES (new.rowid, new.key, new.summary, new.description, new.assignee_name, new.reporter_name, new.labels);
    END;

    CREATE TRIGGER jira_issues_ad AFTER DELETE ON jira_issues BEGIN
      INSERT INTO jira_issues_fts(jira_issues_fts, rowid, key, summary, description, assignee_name, reporter_name, labels)
      VALUES ('delete', old.rowid, old.key, old.summary, old.description, old.assignee_name, old.reporter_name, old.labels);
    END;

    CREATE TRIGGER jira_issues_au AFTER UPDATE ON jira_issues BEGIN
      INSERT INTO jira_issues_fts(jira_issues_fts, rowid, key, summary, description, assignee_name, reporter_name, labels)
      VALUES ('delete', old.rowid, old.key, old.summary, old.description, old.assignee_name, old.reporter_name, old.labels);
      INSERT INTO jira_issues_fts(rowid, key, summary, description, assignee_name, reporter_name, labels)
      VALUES (new.rowid, new.key, new.summary, new.description, new.assignee_name, new.reporter_name, new.labels);
    END;
  `);

  // Create comments table
  database.exec(`
    CREATE TABLE jira_comments (
      id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL,
      issue_key TEXT NOT NULL,
      author_id TEXT,
      author_name TEXT,
      body TEXT,
      created INTEGER NOT NULL,
      updated INTEGER,
      synced_at INTEGER NOT NULL,
      FOREIGN KEY (issue_id) REFERENCES jira_issues(id)
    );

    CREATE INDEX idx_jira_comments_issue ON jira_comments(issue_id);
    CREATE INDEX idx_jira_comments_issue_key ON jira_comments(issue_key);
  `);

  // Create sync state table
  database.exec(`
    CREATE TABLE jira_sync_state (
      project_key TEXT PRIMARY KEY,
      project_name TEXT,
      last_updated_at TEXT,
      issue_count INTEGER DEFAULT 0,
      last_sync_at INTEGER
    );
  `);
}

/**
 * Issue row type from database
 */
export interface JiraIssueRow {
  id: string;
  key: string;
  project_key: string;
  summary: string | null;
  description: string | null;
  status: string | null;
  status_category: string | null;
  assignee_id: string | null;
  assignee_name: string | null;
  reporter_id: string | null;
  reporter_name: string | null;
  priority: string | null;
  issue_type: string | null;
  labels: string | null;
  created: number;
  updated: number;
  resolved: number | null;
  synced_at: number;
  in_backlog: number;
}

/**
 * Comment row type from database
 */
export interface JiraCommentRow {
  id: string;
  issue_id: string;
  issue_key: string;
  author_id: string | null;
  author_name: string | null;
  body: string | null;
  created: number;
  updated: number | null;
  synced_at: number;
}

/**
 * Sync state row type
 */
export interface JiraSyncStateRow {
  project_key: string;
  project_name: string | null;
  last_updated_at: string | null;
  issue_count: number;
  last_sync_at: number | null;
}
