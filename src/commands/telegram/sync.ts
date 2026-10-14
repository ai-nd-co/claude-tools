// Telegram sync command - sync messages to local SQLite database
// Automatically indexes: builds clusters and generates embeddings (if Ollama available)

import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig } from '../../config/loader.js';
import { TelegramService } from '../../services/telegram.js';
import { syncChat, syncAllChats, getSyncedChats, getMessageCount, getChatDateRange } from '../../services/telegram-sync.js';
import { getDatabaseStats } from '../../services/telegram-search.js';
import { ensureReactionsColumn, ensureEntitiesColumn } from '../../db/index.js';
import { verifyCacheAccount } from '../../services/telegram-peer.js';
import { buildClusters, getClusterStats } from '../../services/telegram-cluster.js';
import { generateMissingEmbeddings, getEmbeddingCount } from '../../services/telegram-semantic.js';
import { generateMissingClusterEmbeddings, getClusterEmbeddingCount } from '../../services/cluster-embedding.js';
import { isOllamaAvailable } from '../../services/embeddings.js';

function ensureTelegramConfig() {
  const config = loadConfig();
  if (!config.telegram) {
    console.error(chalk.red('Telegram not configured.'));
    console.log('\nTo configure Telegram:');
    console.log('  1. Get API credentials from https://my.telegram.org/apps');
    console.log('  2. Run: claude-tools telegram auth');
    process.exit(1);
  }
  return config.telegram;
}

export function registerSyncCommand(telegram: Command): void {
  telegram
    .command('sync [chat]')
    .description('Sync messages from Telegram to local database')
    .option('--months <n>', 'Number of months to sync', '1')
    .option('--all', 'Sync all chats')
    .option('--force', 'Re-sync even if already synced')
    .option('--no-index', 'Skip indexing (clustering + embeddings)')
    .option('--status', 'Show sync status without syncing')
    .addHelpText('after', `
${chalk.yellow('Examples:')}
  ${chalk.dim('# Sync and index (clusters + embeddings)')}
  claude-tools telegram sync me

  ${chalk.dim('# Sync all chats')}
  claude-tools telegram sync --all

  ${chalk.dim('# Sync last 6 months')}
  claude-tools telegram sync "DevOps" --months 6


  ${chalk.dim('# Sync only (no indexing)')}
  claude-tools telegram sync me --no-index

  ${chalk.dim('# Check sync status')}
  claude-tools telegram sync --status

${chalk.yellow('Indexing:')} After sync, automatically builds clusters and generates
embeddings for semantic search. If Ollama is not running, only clusters are built.
`)
    .action(async (chat: string | undefined, options: {
      months: string;
      all?: boolean;
      force?: boolean;
      index?: boolean;  // --no-index sets this to false
      status?: boolean;
    }) => {
      // Show status only
      if (options.status) {
        showSyncStatus();
        return;
      }

      // Must specify chat or --all
      if (!chat && !options.all) {
        console.error(chalk.red('Please specify a chat or use --all'));
        console.log('  Examples:');
        console.log('    claude-tools telegram sync me');
        console.log('    claude-tools telegram sync "MyChat"');
        console.log('    claude-tools telegram sync --all');
        process.exit(1);
      }

      const config = ensureTelegramConfig();
      const service = new TelegramService(config);
      const months = parseInt(options.months, 10);

      // Track sync results for indexing even if errors occur during disconnect
      let syncResults: { chatIds: string[]; success: boolean } = { chatIds: [], success: false };

      try {
        await service.connect();

        // Access the underlying client
        const client = (service as any).client;

        // The account first, then the cache: after a relogin the cache opens only for a verified account.
        await verifyCacheAccount(client);
        ensureReactionsColumn();
        ensureEntitiesColumn();

        if (options.all) {
          console.log(chalk.bold(`📥 Syncing all chats (last ${months} months)...\n`));

          const results = await syncAllChats(client, {
            months,
            force: options.force,
            onProgress: (count, oldestDate) => {
              process.stdout.write(`\r  ${chalk.dim(`${count} messages (${formatDate(oldestDate)})`)}`);
            },
          }, (chatTitle) => {
            console.log(`\n${chalk.cyan(chatTitle)}:`);
          });

          console.log('\n');
          console.log(chalk.green('✅ Sync complete'));
          console.log(chalk.dim(`   Total: ${results.reduce((sum, r) => sum + r.messagesAdded, 0)} new messages from ${results.length} chats`));

          syncResults = { chatIds: results.map(r => r.chatId), success: true };
        } else {
          console.log(chalk.bold(`📥 Syncing "${chat}" (last ${months} months)...\n`));

          const result = await syncChat(client, chat!, {
            months,
            force: options.force,
            onProgress: (count, oldestDate) => {
              console.log(`  ${chalk.dim(`Fetched ${count} messages (oldest: ${formatDate(oldestDate)})`)}`);
            },
          });

          console.log();
          console.log(chalk.green('✅ Synced'), chalk.cyan(result.chatTitle));
          console.log(chalk.dim(`   ${result.messagesAdded} new messages`));

          if (result.earlyTerminated) {
            console.log(chalk.dim('   Reached synced region, stopped early'));
          } else if (result.oldestMessageDate) {
            console.log(chalk.dim(`   Oldest: ${formatDate(result.oldestMessageDate)}`));
          }

          syncResults = { chatIds: [result.chatId], success: true };
        }
      } catch (err) {
        console.error(chalk.red('❌ Error:'), (err as Error).message);
        process.exit(1);
      } finally {
        // Disconnect gracefully - ignore errors since sync is already complete
        try {
          await service.disconnect();
        } catch {
          // Ignore disconnect errors
        }
      }

      // Auto-index outside the try/catch so disconnect errors don't prevent indexing
      if (syncResults.success && options.index !== false) {
        await indexChats(syncResults.chatIds);
      }
    });
}

function showSyncStatus(): void {
  const stats = getDatabaseStats();
  const syncedChats = getSyncedChats();

  console.log(chalk.bold('\n📊 Sync Status\n'));

  if (stats.totalMessages === 0) {
    console.log(chalk.dim('No messages synced yet.'));
    console.log(chalk.dim('Run: claude-tools telegram sync <chat>'));
    return;
  }

  console.log(`Total messages: ${chalk.cyan(stats.totalMessages.toLocaleString())}`);
  console.log(`Chats synced: ${chalk.cyan(stats.chats)}`);

  if (stats.oldestMessage) {
    console.log(`Date range: ${chalk.dim(formatDate(stats.oldestMessage))} - ${chalk.dim(formatDate(stats.newestMessage!))}`);
  }

  if (syncedChats.length > 0) {
    console.log(chalk.bold('\nChats:'));
    for (const chat of syncedChats) {
      const lastSync = chat.last_sync_at ? new Date(chat.last_sync_at * 1000) : null;
      const dateRange = getChatDateRange(chat.chat_id);
      console.log(`  ${chalk.cyan(chat.chat_title || chat.chat_id)}: ${chat.message_count} messages`);
      if (dateRange.oldest && dateRange.newest) {
        console.log(chalk.dim(`    Messages: ${formatDate(dateRange.oldest)} - ${formatDate(dateRange.newest)}`));
      }
      if (lastSync) {
        console.log(chalk.dim(`    Last synced: ${formatDate(lastSync)}`));
      }
    }
  }
}

function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
  });
}

/**
 * Index chats: build clusters and generate embeddings
 * Falls back gracefully if Ollama is not available
 * Only indexes the specified chats (not all messages)
 */
async function indexChats(chatIds: string[]): Promise<void> {
  console.log(chalk.dim('\n📊 Indexing...'));

  // Step 1: Build clusters (always works)
  let totalClusters = 0;
  for (const chatId of chatIds) {
    const count = buildClusters(chatId);
    totalClusters += count;
  }
  console.log(chalk.dim(`   ✓ ${totalClusters} clusters`));

  // Step 2: Generate embeddings (if Ollama available)
  const ollamaOk = await isOllamaAvailable();
  if (!ollamaOk) {
    console.log(chalk.dim('   ⊘ Embeddings skipped (Ollama not running)'));
    return;
  }

  // Step 2a: Generate MESSAGE embeddings (limit to 100 per chat)
  const embeddingsBefore = getEmbeddingCount();
  let totalMessageEmbeddings = 0;

  for (const chatId of chatIds) {
    const count = await generateMissingEmbeddings(Infinity, (completed, total) => {
      process.stdout.write(`\r   ${chalk.dim(`⟳ Message embeddings: ${totalMessageEmbeddings + completed}`)}`);
    }, chatId);
    totalMessageEmbeddings += count;
  }

  const embeddingsAfter = getEmbeddingCount();

  if (totalMessageEmbeddings > 0) {
    console.log(`\r   ${chalk.dim(`✓ ${totalMessageEmbeddings} new message embeddings (${embeddingsAfter} total)`)}`);
  } else {
    console.log(`\r   ${chalk.dim(`✓ Message embeddings up to date (${embeddingsAfter} total)`)}`);
  }

  // Step 2b: Generate CLUSTER embeddings (limit to 50 per chat)
  const clusterEmbeddingsBefore = getClusterEmbeddingCount();
  let totalClusterEmbeddings = 0;

  for (const chatId of chatIds) {
    const count = await generateMissingClusterEmbeddings(Infinity, chatId, (completed, total) => {
      process.stdout.write(`\r   ${chalk.dim(`⟳ Cluster embeddings: ${totalClusterEmbeddings + completed}`)}`);
    });
    totalClusterEmbeddings += count;
  }

  const clusterEmbeddingsAfter = getClusterEmbeddingCount();

  if (totalClusterEmbeddings > 0) {
    console.log(`\r   ${chalk.dim(`✓ ${totalClusterEmbeddings} new cluster embeddings (${clusterEmbeddingsAfter} total)`)}`);
  } else {
    console.log(`\r   ${chalk.dim(`✓ Cluster embeddings up to date (${clusterEmbeddingsAfter} total)`)}`);
  }
}
