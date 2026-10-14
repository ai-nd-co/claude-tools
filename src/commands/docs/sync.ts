// Docs sync command - sync markdown and code files to local SQLite database

import { Command } from 'commander';
import chalk from 'chalk';
import { join } from 'path';
import { existsSync } from 'fs';
import { syncDocs, getSyncedPrefixes, getDocsDatabaseStats } from '../../services/docs-sync.js';
import { generateDocsEmbeddings, getDocsEmbeddingStats } from '../../services/docs-semantic.js';
import { isOllamaAvailable } from '../../services/embeddings.js';

// Default paths to index (relative to basePath)
const DEFAULT_DOC_PATHS = ['docs', 'tasks'];

export function registerSyncCommand(docs: Command): void {
  docs
    .command('sync [path]')
    .description('Sync markdown and code files to local database')
    .option('--base <path>', 'Base path for documentation', process.cwd())
    .option('--force', 'Re-sync all files (full sync)')
    .option('--no-embed', 'Skip embedding generation after sync')
    .option('--status', 'Show sync status without syncing')
    .option('--include-code', 'Also index code files (.ts, .tsx, .dart)')
    .option('--repo <name>', 'Index a specific repo (e.g., my-backend)')
    .option('--verbose', 'Show detailed progress')
    .addHelpText('after', `
${chalk.yellow('Examples:')}
  ${chalk.dim('# Show sync status')}
  claude-tools docs sync --status

  ${chalk.dim('# Sync default directories (docs/, tasks/)')}
  claude-tools docs sync

  ${chalk.dim('# Sync a specific directory')}
  claude-tools docs sync docs/fmcsa-handbook

  ${chalk.dim('# Force full resync')}
  claude-tools docs sync --force

  ${chalk.dim('# Include code files')}
  claude-tools docs sync --include-code

  ${chalk.dim('# Sync a specific repo with code')}
  claude-tools docs sync --repo my-backend --include-code

  ${chalk.dim('# Sync with custom base path')}
  claude-tools docs sync --base /path/to/project
`)
    .action(async (path: string | undefined, options: {
      base: string;
      force?: boolean;
      embed?: boolean;
      status?: boolean;
      includeCode?: boolean;
      repo?: string;
      verbose?: boolean;
    }) => {
      // Show status only
      if (options.status) {
        showSyncStatus();
        return;
      }

      const basePath = options.base.replace(/\//g, '/');

      // Determine paths to sync
      const pathsToSync: string[] = [];

      if (options.repo) {
        // Sync specific repo
        const repoPath = `repos/${options.repo}`;
        const fullPath = join(basePath, repoPath);
        if (!existsSync(fullPath)) {
          console.error(chalk.red(`Repo not found: ${fullPath}`));
          process.exit(1);
        }
        pathsToSync.push(repoPath);
      } else if (path) {
        // Sync specific path
        const fullPath = join(basePath, path);
        if (!existsSync(fullPath)) {
          console.error(chalk.red(`Path not found: ${fullPath}`));
          process.exit(1);
        }
        pathsToSync.push(path);
      } else {
        // Sync default doc paths
        for (const defaultPath of DEFAULT_DOC_PATHS) {
          const fullPath = join(basePath, defaultPath);
          if (existsSync(fullPath)) {
            pathsToSync.push(defaultPath);
          }
        }
      }

      if (pathsToSync.length === 0) {
        console.error(chalk.red('No directories to sync.'));
        console.log(chalk.dim(`Checked: ${DEFAULT_DOC_PATHS.join(', ')} in ${basePath}`));
        process.exit(1);
      }

      console.log(chalk.bold(`\nSyncing from ${chalk.cyan(basePath)}...`));
      if (options.force) {
        console.log(chalk.dim('   Full resync mode'));
      }
      if (options.includeCode) {
        console.log(chalk.dim('   Including code files (.ts, .tsx, .dart)'));
      }
      console.log();

      let totalAdded = 0;
      let totalUpdated = 0;
      let totalSkipped = 0;
      let totalChunks = 0;

      for (const syncPath of pathsToSync) {
        const fullPath = join(basePath, syncPath);
        if (options.verbose) {
          console.log(chalk.dim(`  Scanning ${syncPath}/...`));
        }

        try {
          const result = syncDocs(fullPath, basePath, {
            force: options.force,
            includeCode: options.includeCode,
            onProgress: options.verbose ? (count, latestFile) => {
              process.stdout.write(`\r  ${chalk.dim(`${count} files processed (${latestFile.slice(0, 40)}...)`)}`);
            } : undefined,
          });

          totalAdded += result.filesAdded;
          totalUpdated += result.filesUpdated;
          totalSkipped += result.filesSkipped;
          totalChunks += result.totalChunks;

          if (options.verbose) {
            console.log(`\r  ${chalk.green(syncPath)}: ${result.filesAdded} added, ${result.filesUpdated} updated, ${result.filesSkipped} unchanged`);
          }
        } catch (err) {
          console.error(chalk.red(`\n  Error syncing ${syncPath}:`), (err as Error).message);
        }
      }

      console.log();
      console.log(chalk.green('Sync complete'));
      console.log(chalk.dim(`   Files: ${totalAdded} added, ${totalUpdated} updated, ${totalSkipped} unchanged`));
      console.log(chalk.dim(`   Total chunks: ${totalChunks}`));

      // Auto-embed unless --no-embed
      if (options.embed !== false) {
        await indexDocs();
      }
    });
}

function showSyncStatus(): void {
  const stats = getDocsDatabaseStats();
  const syncedPrefixes = getSyncedPrefixes();

  console.log(chalk.bold('\n📊 Docs Sync Status\n'));

  if (stats.totalDocs === 0) {
    console.log(chalk.dim('No documents synced yet.'));
    console.log(chalk.dim('Run: claude-tools docs sync'));
    return;
  }

  console.log(`Total documents: ${chalk.cyan(stats.totalDocs.toLocaleString())}`);
  console.log(`Total chunks: ${chalk.cyan(stats.totalChunks.toLocaleString())}`);

  if (stats.byType.length > 0) {
    console.log(chalk.bold('\nBy type:'));
    for (const { type, count } of stats.byType) {
      console.log(`  ${type}: ${chalk.cyan(count)}`);
    }
  }

  if (syncedPrefixes.length > 0) {
    console.log(chalk.bold('\nSynced paths:'));
    for (const prefix of syncedPrefixes) {
      const lastSync = prefix.last_sync_at ? new Date(prefix.last_sync_at * 1000) : null;
      console.log(`  ${chalk.cyan(prefix.path_prefix)}: ${prefix.file_count} files, ${prefix.chunk_count} chunks`);
      if (lastSync) {
        console.log(chalk.dim(`    Last synced: ${formatDate(lastSync)}`));
      }
    }
  }

  // Show embedding stats
  const embedStats = getDocsEmbeddingStats();
  console.log(chalk.bold('\nEmbeddings:'));
  console.log(`  Chunks with embeddings: ${chalk.cyan(embedStats.chunkEmbeddings)} / ${embedStats.totalChunks}`);
  console.log(`  Coverage: ${chalk.cyan(embedStats.coverage.toFixed(1) + '%')}`);
}

function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
    hour: 'numeric',
    minute: '2-digit',
  });
}

async function indexDocs(): Promise<void> {
  const ollamaOk = await isOllamaAvailable();
  if (!ollamaOk) {
    console.log(chalk.dim('Embeddings skipped (Ollama not running)'));
    return;
  }

  const statsBefore = getDocsEmbeddingStats();
  const toGenerate = statsBefore.totalChunks - statsBefore.chunkEmbeddings;

  if (toGenerate === 0) {
    console.log(chalk.dim(`Embeddings up to date (${statsBefore.chunkEmbeddings} total)`));
    return;
  }

  console.log(chalk.dim(`Generating ${toGenerate} embeddings...`));
  const result = await generateDocsEmbeddings(undefined, Infinity);
  const stats = getDocsEmbeddingStats();
  console.log(chalk.dim(`Done. ${result.generated} new embeddings (${stats.chunkEmbeddings} total)`));
}
