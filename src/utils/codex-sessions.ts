import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface CodexSessionFile {
  path: string;
  name: string;
  size: number;
  mtimeMs: number;
}

export function getCodexSessionsDir(): string {
  return path.join(os.homedir(), '.codex', 'sessions');
}

function walkDir(dir: string, results: CodexSessionFile[]): void {
  if (!fs.existsSync(dir)) return;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(fullPath, results);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;

    const stat = fs.statSync(fullPath);
    results.push({
      path: fullPath,
      name: entry.name,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    });
  }
}

export function listCodexSessionFiles(rootDir?: string): CodexSessionFile[] {
  const root = rootDir || getCodexSessionsDir();
  const results: CodexSessionFile[] = [];
  walkDir(root, results);
  return results;
}

export function findCodexSessionFile(query: string, rootDir?: string): string | null {
  if (fs.existsSync(query)) {
    return query;
  }

  const sessions = listCodexSessionFiles(rootDir);
  const lowerQuery = query.toLowerCase();

  const match = sessions.find(s =>
    s.name.toLowerCase().includes(lowerQuery) ||
    s.path.toLowerCase().includes(lowerQuery)
  );

  return match ? match.path : null;
}
