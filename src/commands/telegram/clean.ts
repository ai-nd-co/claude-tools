// Telegram clean command - wipe clusters and embeddings for reindexing

import { resolveChatId } from '../../services/telegram-search.js';
import { Command } from 'commander';
import chalk from 'chalk';
import { getDatabase, ensureClusterTables } from '../../db/index.js';
import { deleteEmbeddings, deleteClusterEmbeddings, getEmbeddingStats } from '../../services/embedding-service.js';

/**
 * Clean clusters from telegram.db
 */
function cleanClusters(chatId?: string): number {
  const db = getDatabase();
  ensureClusterTables();

  const oldClusters = db.prepare('SELECT id FROM clusters' + (chatId ? ' WHERE chat_id=?' : '')).all(...(chatId ? [chatId] : [])) as Array<{id:number}>;
  deleteClusterEmbeddings(oldClusters.map(c=>c.id));
  if (chatId) {
    // Delete cluster_messages first (foreign key)
    db.prepare(`
      DELETE FROM cluster_messages
      WHERE cluster_id IN (SELECT id FROM clusters WHERE chat_id = ?)
    `).run(chatId);

    const result = db.prepare('DELETE FROM clusters WHERE chat_id = ?').run(chatId);
    return result.changes;
  } else {
    // Delete all
    db.prepare('DELETE FROM cluster_messages').run();
    const result = db.prepare('DELETE FROM clusters').run();
    return result.changes;
  }
}

export function registerCleanCommand(telegram: Command): void {
  telegram
    .command('clean')
    .description('Clean clusters and embeddings for reindexing')
    .option('--clusters', 'Clean clusters only')
    .option('--embeddings', 'Clean embeddings only')
    .option('--all', 'Clean everything (clusters + all embeddings)')
    .option('--chat <chat>', 'Clean only specific chat (clusters only)')
    .addHelpText('after', `
${chalk.yellow('Examples:')}
  ${chalk.dim('# Clean clusters and embeddings (for reindexing)')}
  claude-tools telegram clean --all

  ${chalk.dim('# Clean only clusters')}
  claude-tools telegram clean --clusters

  ${chalk.dim('# Clean only embeddings')}
  claude-tools telegram clean --embeddings

  ${chalk.dim('# Clean clusters for specific chat')}
  claude-tools telegram clean --clusters --chat "Team Dev Chat"

${chalk.yellow('After cleaning:')}
  Run: telegram sync <chat>  # to rebuild clusters and embeddings
`)
    .action(async (options: {
      clusters?: boolean;
      embeddings?: boolean;
      all?: boolean;
      chat?: string;
    }) => {
      try {
        if (options.chat) { const id=resolveChatId(options.chat); if(!id) throw new Error('Chat not cached: '+options.chat); options.chat=id; }
        // Default to --all if nothing specified
        const cleanAll = options.all || (!options.clusters && !options.embeddings);
        const cleanClustersFlag = cleanAll || options.clusters;
        const cleanEmbeddingsFlag = cleanAll || options.embeddings;

        console.log(chalk.bold('🧹 Cleaning...'));

        // Show current stats first
        const stats = getEmbeddingStats();
        console.log(chalk.dim(`\nCurrent state:`));
        console.log(chalk.dim(`  Embeddings: ${stats.total}`));
        for (const [type, count] of Object.entries(stats.byType)) {
          console.log(chalk.dim(`    - ${type}: ${count}`));
        }

        // Clean clusters
        if (cleanClustersFlag) {
          const deleted = cleanClusters(options.chat);
          console.log(chalk.yellow(`\n🗑️  Deleted ${deleted} clusters`));
        }

        // Clean embeddings
        if (cleanEmbeddingsFlag) {
          if (options.chat) {
            console.log(chalk.dim('Note: --chat filter only applies to clusters, not embeddings'));
          }

          // Delete message embeddings
          const msgDeleted = deleteEmbeddings('message');
          console.log(chalk.yellow(`🗑️  Deleted ${msgDeleted} message embeddings`));

          // Delete cluster embeddings
          const clusterDeleted = deleteEmbeddings('cluster');
          console.log(chalk.yellow(`🗑️  Deleted ${clusterDeleted} cluster embeddings`));
        }

        console.log(chalk.green('\n✅ Clean complete'));
        console.log(chalk.dim('Run: telegram sync <chat>  # to rebuild'));
      } catch (err) {
        console.error(chalk.red('❌ Error:'), (err as Error).message);
        process.exit(1);
      }
    });
}
