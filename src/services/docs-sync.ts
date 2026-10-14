// Docs sync service - scans markdown and code files, stores in SQLite

import { readFileSync, statSync, readdirSync, existsSync } from 'fs';
import { join, relative, extname, basename } from 'path';
import { getDocsDatabase, type DocumentRow, type DocsSyncStateRow } from '../db/docs.js';

// Supported file extensions
const MARKDOWN_EXTENSIONS = ['.md'];
const CODE_EXTENSIONS: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.dart': 'dart',
};

export interface DocsSyncOptions {
  force?: boolean;
  includeCode?: boolean;
  onProgress?: (count: number, latestFile: string) => void;
}

export interface DocsSyncResult {
  pathPrefix: string;
  filesAdded: number;
  filesUpdated: number;
  filesSkipped: number;
  totalFiles: number;
  totalChunks: number;
}

// Chunking configuration (matches jira-semantic.ts for consistency)
const CHUNK_SIZE = 1500;           // Characters per chunk
const CHUNK_OVERLAP = 300;         // Overlap between chunks
const MIN_CHUNK_SIZE = 100;        // Skip tiny chunks

/**
 * Get sync state for a path prefix
 */
export function getSyncState(pathPrefix: string): DocsSyncStateRow | null {
  const db = getDocsDatabase();
  const stmt = db.prepare('SELECT * FROM docs_sync_state WHERE path_prefix = ?');
  return stmt.get(pathPrefix) as DocsSyncStateRow | null;
}

/**
 * Update sync state for a path prefix
 */
function updateSyncState(
  pathPrefix: string,
  fileCount: number,
  chunkCount: number
): void {
  const db = getDocsDatabase();
  const stmt = db.prepare(`
    INSERT INTO docs_sync_state (path_prefix, file_count, chunk_count, last_sync_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(path_prefix) DO UPDATE SET
      file_count = excluded.file_count,
      chunk_count = excluded.chunk_count,
      last_sync_at = excluded.last_sync_at
  `);
  stmt.run(pathPrefix, fileCount, chunkCount, Math.floor(Date.now() / 1000));
}

/**
 * Recursively scan directory for files
 */
export function scanDirectory(dirPath: string, basePath: string, includeCode: boolean = false): string[] {
  const files: string[] = [];

  if (!existsSync(dirPath)) {
    return files;
  }

  const entries = readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);

    // Skip common non-content directories
    if (entry.isDirectory()) {
      if (['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.dart_tool', 'coverage'].includes(entry.name)) {
        continue;
      }
      files.push(...scanDirectory(fullPath, basePath, includeCode));
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase();
      if (MARKDOWN_EXTENSIONS.includes(ext)) {
        files.push(fullPath);
      } else if (includeCode && ext in CODE_EXTENSIONS) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

/**
 * Extract title from markdown content
 */
function extractTitle(content: string, filePath: string): string {
  // Try to find # header
  const match = content.match(/^#\s+(.+)$/m);
  if (match) {
    return match[1].trim();
  }
  // Fall back to filename
  return basename(filePath, '.md');
}

/**
 * Parse markdown content into chunks by ## headers
 */
export function parseMarkdown(content: string): Array<{ heading: string | null; content: string; startLine: number; endLine: number }> {
  const lines = content.split('\n');
  const chunks: Array<{ heading: string | null; content: string; startLine: number; endLine: number }> = [];

  let currentHeading: string | null = null;
  let currentContent: string[] = [];
  let currentStartLine = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Check for ## header (section break)
    const headerMatch = line.match(/^##\s+(.+)$/);

    if (headerMatch) {
      // Save previous chunk if it has content
      if (currentContent.length > 0) {
        const chunkContent = currentContent.join('\n').trim();
        if (chunkContent.length >= MIN_CHUNK_SIZE) {
          chunks.push({
            heading: currentHeading,
            content: chunkContent,
            startLine: currentStartLine,
            endLine: lineNum - 1,
          });
        }
      }

      // Start new chunk
      currentHeading = headerMatch[1].trim();
      currentContent = [];
      currentStartLine = lineNum;
    } else {
      currentContent.push(line);
    }
  }

  // Don't forget the last chunk
  if (currentContent.length > 0) {
    const chunkContent = currentContent.join('\n').trim();
    if (chunkContent.length >= MIN_CHUNK_SIZE) {
      chunks.push({
        heading: currentHeading,
        content: chunkContent,
        startLine: currentStartLine,
        endLine: lines.length,
      });
    }
  }

  // If no chunks were created (no ## headers), create one chunk from the whole content
  if (chunks.length === 0 && content.trim().length >= MIN_CHUNK_SIZE) {
    chunks.push({
      heading: null,
      content: content.trim(),
      startLine: 1,
      endLine: lines.length,
    });
  }

  // Split large chunks
  return chunks.flatMap(chunk => splitLargeChunk(chunk));
}

/**
 * Split a chunk into overlapping segments if it exceeds CHUNK_SIZE
 * Uses stride = CHUNK_SIZE - CHUNK_OVERLAP for 300 char overlap
 */
function splitLargeChunk(chunk: { heading: string | null; content: string; startLine: number; endLine: number }): Array<{ heading: string | null; content: string; startLine: number; endLine: number }> {
  if (chunk.content.length <= CHUNK_SIZE) {
    return [chunk];
  }

  // Generate overlapping chunks (like jira-semantic.ts)
  const results: Array<{ heading: string | null; content: string; startLine: number; endLine: number }> = [];
  const text = chunk.content;
  const stride = CHUNK_SIZE - CHUNK_OVERLAP;

  for (let i = 0; i < text.length; i += stride) {
    const chunkText = text.slice(i, i + CHUNK_SIZE).trim();

    // Skip tiny final chunks
    if (chunkText.length < MIN_CHUNK_SIZE) {
      break;
    }

    results.push({
      heading: results.length === 0 ? chunk.heading : `${chunk.heading || 'Content'} (cont.)`,
      content: chunkText,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
    });

    // Stop if we've reached the end
    if (i + CHUNK_SIZE >= text.length) {
      break;
    }
  }

  return results;
}

/**
 * Parse code file into chunks by functions/classes
 */
export function parseCode(content: string, language: string): Array<{ heading: string | null; content: string; startLine: number; endLine: number }> {
  const lines = content.split('\n');
  const chunks: Array<{ heading: string | null; content: string; startLine: number; endLine: number }> = [];

  if (language === 'typescript' || language === 'javascript') {
    chunks.push(...parseTypeScript(lines));
  } else if (language === 'dart') {
    chunks.push(...parseDart(lines));
  }

  // If no functions/classes found, chunk the whole file
  if (chunks.length === 0 && content.trim().length >= MIN_CHUNK_SIZE) {
    chunks.push({
      heading: null,
      content: content.trim(),
      startLine: 1,
      endLine: lines.length,
    });
  }

  // Split large chunks with overlap
  return chunks.flatMap(chunk => splitLargeChunk(chunk));
}

/**
 * Parse TypeScript/JavaScript file for functions, classes, and interfaces
 */
function parseTypeScript(lines: string[]): Array<{ heading: string | null; content: string; startLine: number; endLine: number }> {
  const chunks: Array<{ heading: string | null; content: string; startLine: number; endLine: number }> = [];

  // Patterns for TypeScript/JavaScript
  const patterns = [
    // export function name(
    /^export\s+(?:async\s+)?function\s+(\w+)/,
    // export const name = (
    /^export\s+const\s+(\w+)\s*=\s*(?:async\s*)?\(/,
    // export const name = async (
    /^export\s+const\s+(\w+)\s*=\s*async\s*\(/,
    // function name(
    /^(?:async\s+)?function\s+(\w+)/,
    // const name = (
    /^const\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::\s*\w+)?\s*=>/,
    // export class Name
    /^export\s+class\s+(\w+)/,
    // class Name
    /^class\s+(\w+)/,
    // export interface Name
    /^export\s+interface\s+(\w+)/,
    // interface Name
    /^interface\s+(\w+)/,
    // export type Name
    /^export\s+type\s+(\w+)/,
  ];

  let currentName: string | null = null;
  let currentContent: string[] = [];
  let currentStartLine = 1;
  let braceDepth = 0;
  let inBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmedLine = line.trim();

    // Check for function/class start
    if (!inBlock) {
      for (const pattern of patterns) {
        const match = trimmedLine.match(pattern);
        if (match) {
          // Save previous chunk if exists
          if (currentContent.length > 0 && currentName) {
            const chunkContent = currentContent.join('\n').trim();
            if (chunkContent.length >= MIN_CHUNK_SIZE) {
              chunks.push({
                heading: currentName,
                content: chunkContent,
                startLine: currentStartLine,
                endLine: lineNum - 1,
              });
            }
          }

          currentName = match[1];
          currentContent = [line];
          currentStartLine = lineNum;
          braceDepth = (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
          inBlock = braceDepth > 0 || line.includes('=>');
          break;
        }
      }
    }

    if (inBlock && currentName) {
      if (!currentContent.includes(line)) {
        currentContent.push(line);
      }

      // Track brace depth
      braceDepth += (line.match(/{/g) || []).length;
      braceDepth -= (line.match(/}/g) || []).length;

      // End of block
      if (braceDepth <= 0 && currentContent.length > 1) {
        const chunkContent = currentContent.join('\n').trim();
        if (chunkContent.length >= MIN_CHUNK_SIZE) {
          chunks.push({
            heading: currentName,
            content: chunkContent,
            startLine: currentStartLine,
            endLine: lineNum,
          });
        }
        currentName = null;
        currentContent = [];
        inBlock = false;
        braceDepth = 0;
      }
    }
  }

  // Don't forget the last chunk
  if (currentContent.length > 0 && currentName) {
    const chunkContent = currentContent.join('\n').trim();
    if (chunkContent.length >= MIN_CHUNK_SIZE) {
      chunks.push({
        heading: currentName,
        content: chunkContent,
        startLine: currentStartLine,
        endLine: lines.length,
      });
    }
  }

  return chunks;
}

/**
 * Parse Dart file for functions and classes
 */
function parseDart(lines: string[]): Array<{ heading: string | null; content: string; startLine: number; endLine: number }> {
  const chunks: Array<{ heading: string | null; content: string; startLine: number; endLine: number }> = [];

  // Patterns for Dart
  const patterns = [
    // class Name
    /^class\s+(\w+)/,
    // abstract class Name
    /^abstract\s+class\s+(\w+)/,
    // mixin Name
    /^mixin\s+(\w+)/,
    // extension Name
    /^extension\s+(\w+)/,
    // Future<Type> functionName(
    /^(?:Future<[^>]+>|void|String|int|bool|double|dynamic|\w+)\s+(\w+)\s*\(/,
    // static Type functionName(
    /^static\s+(?:\w+\s+)?(\w+)\s*\(/,
  ];

  let currentName: string | null = null;
  let currentContent: string[] = [];
  let currentStartLine = 1;
  let braceDepth = 0;
  let inBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmedLine = line.trim();

    // Skip comments and imports
    if (trimmedLine.startsWith('//') || trimmedLine.startsWith('import ') || trimmedLine.startsWith('part ')) {
      continue;
    }

    // Check for function/class start
    if (!inBlock) {
      for (const pattern of patterns) {
        const match = trimmedLine.match(pattern);
        if (match) {
          // Save previous chunk
          if (currentContent.length > 0 && currentName) {
            const chunkContent = currentContent.join('\n').trim();
            if (chunkContent.length >= MIN_CHUNK_SIZE) {
              chunks.push({
                heading: currentName,
                content: chunkContent,
                startLine: currentStartLine,
                endLine: lineNum - 1,
              });
            }
          }

          currentName = match[1];
          currentContent = [line];
          currentStartLine = lineNum;
          braceDepth = (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
          inBlock = braceDepth > 0;
          break;
        }
      }
    }

    if (inBlock && currentName) {
      if (!currentContent.includes(line)) {
        currentContent.push(line);
      }

      braceDepth += (line.match(/{/g) || []).length;
      braceDepth -= (line.match(/}/g) || []).length;

      if (braceDepth <= 0 && currentContent.length > 1) {
        const chunkContent = currentContent.join('\n').trim();
        if (chunkContent.length >= MIN_CHUNK_SIZE) {
          chunks.push({
            heading: currentName,
            content: chunkContent,
            startLine: currentStartLine,
            endLine: lineNum,
          });
        }
        currentName = null;
        currentContent = [];
        inBlock = false;
        braceDepth = 0;
      }
    }
  }

  // Last chunk
  if (currentContent.length > 0 && currentName) {
    const chunkContent = currentContent.join('\n').trim();
    if (chunkContent.length >= MIN_CHUNK_SIZE) {
      chunks.push({
        heading: currentName,
        content: chunkContent,
        startLine: currentStartLine,
        endLine: lines.length,
      });
    }
  }

  return chunks;
}

/**
 * Insert or update a document in the database
 */
function upsertDocument(
  path: string,
  type: string,
  title: string,
  content: string,
  lastModified: number,
  language: string | null = null
): { id: number; action: 'inserted' | 'updated' | 'skipped' } {
  const db = getDocsDatabase();

  // Check if document exists and is up to date
  const existing = db.prepare('SELECT id, last_modified FROM documents WHERE path = ?').get(path) as { id: number; last_modified: number } | undefined;

  if (existing && existing.last_modified === lastModified) {
    return { id: existing.id, action: 'skipped' };
  }

  const action = existing ? 'updated' : 'inserted';

  // Delete old chunks if updating
  if (existing) {
    db.prepare('DELETE FROM doc_chunks WHERE doc_id = ?').run(existing.id);
  }

  // Upsert document
  const stmt = db.prepare(`
    INSERT INTO documents (path, type, title, content, language, last_modified, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      type = excluded.type,
      title = excluded.title,
      content = excluded.content,
      language = excluded.language,
      last_modified = excluded.last_modified,
      indexed_at = excluded.indexed_at
  `);
  stmt.run(path, type, title, content, language, lastModified, Math.floor(Date.now() / 1000));

  // Get the document ID
  const doc = db.prepare('SELECT id FROM documents WHERE path = ?').get(path) as { id: number };
  return { id: doc.id, action };
}

/**
 * Insert chunks for a document
 */
function insertChunks(
  docId: number,
  chunks: Array<{ heading: string | null; content: string; startLine: number; endLine: number }>
): number {
  const db = getDocsDatabase();
  const stmt = db.prepare(`
    INSERT INTO doc_chunks (doc_id, chunk_index, heading, content, start_line, end_line)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    stmt.run(docId, i, chunk.heading, chunk.content, chunk.startLine, chunk.endLine);
  }

  return chunks.length;
}

/**
 * Determine document type from path and extension
 */
function getDocType(relativePath: string, ext: string): string {
  // Check if it's a code file
  if (ext in CODE_EXTENSIONS) {
    return 'code';
  }
  // Check path-based types
  if (relativePath.startsWith('docs/') || relativePath.startsWith('docs\\')) {
    return 'docs';
  }
  if (relativePath.startsWith('tasks/') || relativePath.startsWith('tasks\\')) {
    return 'tasks';
  }
  return 'other';
}

/**
 * Get language from file extension
 */
function getLanguage(ext: string): string | null {
  return CODE_EXTENSIONS[ext] || null;
}

/**
 * Extract title from code file (first export or class name, or filename)
 */
function extractCodeTitle(content: string, filePath: string): string {
  // Try to find main export or class
  const exportMatch = content.match(/^export\s+(?:default\s+)?(?:class|function|const)\s+(\w+)/m);
  if (exportMatch) {
    return exportMatch[1];
  }
  const classMatch = content.match(/^class\s+(\w+)/m);
  if (classMatch) {
    return classMatch[1];
  }
  // Fall back to filename
  return basename(filePath).replace(/\.[^.]+$/, '');
}

/**
 * Sync markdown and code files from a directory to the local database
 */
export function syncDocs(
  dirPath: string,
  basePath: string,
  options: DocsSyncOptions = {}
): DocsSyncResult {
  const files = scanDirectory(dirPath, basePath, options.includeCode);
  const pathPrefix = relative(basePath, dirPath).replace(/\\/g, '/') || basename(dirPath);

  let filesAdded = 0;
  let filesUpdated = 0;
  let filesSkipped = 0;
  let totalChunks = 0;
  let processed = 0;

  for (const filePath of files) {
    try {
      const stat = statSync(filePath);
      const lastModified = Math.floor(stat.mtimeMs / 1000);
      const content = readFileSync(filePath, 'utf-8');
      const relativePath = relative(basePath, filePath).replace(/\\/g, '/');
      const ext = extname(filePath).toLowerCase();
      const language = getLanguage(ext);
      const isCode = language !== null;

      // Extract title based on file type
      const title = isCode ? extractCodeTitle(content, filePath) : extractTitle(content, filePath);
      const type = getDocType(relativePath, ext);

      // Upsert document
      const { id: docId, action } = upsertDocument(
        relativePath,
        type,
        title,
        content,
        options.force ? Date.now() : lastModified,
        language
      );

      if (action === 'skipped' && !options.force) {
        filesSkipped++;
      } else {
        // Parse and insert chunks based on file type
        const chunks = isCode ? parseCode(content, language!) : parseMarkdown(content);
        totalChunks += insertChunks(docId, chunks);

        if (action === 'inserted') {
          filesAdded++;
        } else {
          filesUpdated++;
        }
      }

      processed++;
      options.onProgress?.(processed, relativePath);
    } catch (err) {
      console.error(`Failed to process ${filePath}:`, (err as Error).message);
    }
  }

  // Update sync state
  const totalFiles = filesAdded + filesUpdated + filesSkipped;
  updateSyncState(pathPrefix, totalFiles, totalChunks);

  return {
    pathPrefix,
    filesAdded,
    filesUpdated,
    filesSkipped,
    totalFiles,
    totalChunks,
  };
}

/**
 * Get list of synced path prefixes
 */
export function getSyncedPrefixes(): DocsSyncStateRow[] {
  const db = getDocsDatabase();
  const stmt = db.prepare('SELECT * FROM docs_sync_state ORDER BY last_sync_at DESC');
  return stmt.all() as DocsSyncStateRow[];
}

/**
 * Get database statistics
 */
export function getDocsDatabaseStats(): {
  totalDocs: number;
  totalChunks: number;
  byType: { type: string; count: number }[];
  oldestDoc: Date | null;
  newestDoc: Date | null;
} {
  const db = getDocsDatabase();

  const docsCount = db.prepare('SELECT COUNT(*) as count FROM documents').get() as { count: number };
  const chunksCount = db.prepare('SELECT COUNT(*) as count FROM doc_chunks').get() as { count: number };

  const byType = db.prepare(`
    SELECT type, COUNT(*) as count
    FROM documents
    GROUP BY type
    ORDER BY count DESC
  `).all() as { type: string; count: number }[];

  const oldest = db.prepare('SELECT MIN(indexed_at) as date FROM documents').get() as { date: number | null };
  const newest = db.prepare('SELECT MAX(indexed_at) as date FROM documents').get() as { date: number | null };

  return {
    totalDocs: docsCount.count,
    totalChunks: chunksCount.count,
    byType,
    oldestDoc: oldest.date ? new Date(oldest.date * 1000) : null,
    newestDoc: newest.date ? new Date(newest.date * 1000) : null,
  };
}

/**
 * Get document count
 */
export function getDocCount(type?: string): number {
  const db = getDocsDatabase();
  if (type) {
    const stmt = db.prepare('SELECT COUNT(*) as count FROM documents WHERE type = ?');
    const result = stmt.get(type) as { count: number };
    return result.count;
  } else {
    const stmt = db.prepare('SELECT COUNT(*) as count FROM documents');
    const result = stmt.get() as { count: number };
    return result.count;
  }
}

/**
 * Get chunk count
 */
export function getChunkCount(): number {
  const db = getDocsDatabase();
  const stmt = db.prepare('SELECT COUNT(*) as count FROM doc_chunks');
  const result = stmt.get() as { count: number };
  return result.count;
}
