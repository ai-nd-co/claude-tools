import { getKnownPeers } from '../../db/index.js';
import { resolveChatId } from '../../services/telegram-search.js';
// Telegram cluster commands - list and read message clusters

import { Command } from 'commander';
import chalk from 'chalk';
import {
  buildClusters,
  getClusters,
  getClusterMessages,
  getCluster,
  getClusterStats,
  type ClusterWithPreview,
} from '../../services/telegram-cluster.js';
import { getSyncedChats } from '../../services/telegram-sync.js';
import {
  searchClusters,
  isClusterSearchAvailable,
  getClusterEmbeddingCount,
  type ClusterSearchResult,
} from '../../services/cluster-embedding.js';
import {
  formatDuration,
  formatShortDate,
  formatMessageCompact,
  formatMessageVerbose,
  type MessageData,
} from './format.js';

/**
 * Format a date with time for cluster display
 */
function formatClusterDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * Register cluster commands
 */
export function registerClustersCommand(telegram: Command): void {
  // List clusters command
  telegram
    .command('clusters')
    .description('List message clusters (conversation threads)')
    .option('--chat <chat>', 'Filter by chat ID')
    .option('--limit <n>', 'Number of clusters to show', '20')
    .option('--build [chat]', 'Build/rebuild clusters for a chat')
    .option('--json', 'Output as JSON')
    .addHelpText('after', `
${chalk.yellow('Examples:')}
  ${chalk.dim('# List recent clusters across all chats')}
  claude-tools telegram clusters

  ${chalk.dim('# Filter clusters by chat')}
  claude-tools telegram clusters --chat "123456789"

  ${chalk.dim('# Build clusters for a specific chat')}
  claude-tools telegram clusters --build "123456789"

  ${chalk.dim('# Build clusters for all synced chats')}
  claude-tools telegram clusters --build

${chalk.yellow('Note:')} Run "telegram sync <chat>" first to populate messages.
`)
    .action(async (options: {
      chat?: string;
      limit: string;
      build?: string | boolean;
      json?: boolean;
    }) => {
      try {
        if (options.chat) { const id=resolveChatId(options.chat); if (!id) throw new Error('Chat not cached: '+options.chat); options.chat=id; }
        if (typeof options.build === 'string') { const id=resolveChatId(options.build); if (!id) throw new Error('Chat not cached: '+options.build); options.build=id; }
        // Build responses are JSON arrays for both single-chat and all-chat runs.
        if (options.build !== undefined) {
          const syncedChats = getSyncedChats();
          const chats = typeof options.build === 'string'
            ? [syncedChats.find(chat => chat.chat_id === options.build) || {chat_id: options.build, chat_title: getKnownPeers().find(peer => peer.id === options.build)?.title || options.build}]
            : syncedChats;
          const results: Array<{chatId:string;chatTitle:string;clustersBuilt:number}> = [];
          for (const chat of chats) {
            console.error(chalk.dim(`Building clusters for ${chat.chat_title || chat.chat_id}`));
            results.push({chatId:chat.chat_id, chatTitle:chat.chat_title || chat.chat_id, clustersBuilt:buildClusters(chat.chat_id)});
          }
          if (options.json) console.log(JSON.stringify(results,null,2));
          else console.log(chalk.green(`Created ${results.reduce((sum,r)=>sum+r.clustersBuilt,0)} clusters across ${results.length} chats`));
          return;
        }

        // List clusters
        const limit = parseInt(options.limit, 10);
        const clusters = getClusters(options.chat, limit);

        if (options.json) { console.log(JSON.stringify(clusters, null, 2)); return; }
        if (clusters.length === 0) {
          console.log(chalk.yellow('No clusters found.'));
          console.log(chalk.dim('Run: claude-tools telegram clusters --build'));
          return;
        }


        // Get stats
        const stats = getClusterStats(options.chat);
        console.log(chalk.bold('📦 Message Clusters') + chalk.dim(` (${stats.totalClusters} total, avg ${stats.avgMessagesPerCluster} msgs/cluster)`));
        console.log();

        for (const cluster of clusters) {
          printClusterSummary(cluster);
        }

        if (clusters.length >= limit) {
          console.log(chalk.dim(`\nUse --limit ${limit * 2} for more clusters`));
        }
      } catch (err) {
        console.error(chalk.red('❌ Error:'), (err as Error).message);
        process.exit(1);
      }
    });

  // Read a specific cluster
  telegram
    .command('cluster <id>')
    .description('Read all messages in a cluster')
    .option('--verbose', 'Show detailed format with timestamps')
    .option('--json', 'Output as JSON')
    .addHelpText('after', `
${chalk.yellow('Examples:')}
  ${chalk.dim('# Read messages in cluster #5')}
  claude-tools telegram cluster 5

  ${chalk.dim('# Verbose output with timestamps')}
  claude-tools telegram cluster 5 --verbose

  ${chalk.dim('# JSON output')}
  claude-tools telegram cluster 5 --json
`)
    .action(async (id: string, options: { verbose?: boolean; json?: boolean }) => {
      try {
        const clusterId = parseInt(id, 10);
        const cluster = getCluster(clusterId);

        if (!cluster) {
          console.log(chalk.red(`Cluster #${clusterId} not found`));
          return;
        }

        const messages = getClusterMessages(clusterId);

        if (options.json) {
          console.log(JSON.stringify({ cluster, messages }, null, 2));
          return;
        }

        // Header
        const duration = formatDuration(cluster.startTime, cluster.endTime);
        console.log(chalk.bold(`📦 Cluster #${cluster.id}`) + chalk.dim(` (${messages.length} messages, ${duration})`));
        console.log(chalk.dim(`  ${formatClusterDate(cluster.startTime)} → ${formatClusterDate(cluster.endTime)}`));
        console.log();

        // Convert messages and find reply contexts within the cluster
        const messageDataList: MessageData[] = messages.map(msg => {
          const date = new Date(msg.date * 1000);

          // Parse reactions from JSON
          let reactions: Array<{ emoji: string; count: number }> | undefined;
          if (msg.reactions) {
            try {
              reactions = JSON.parse(msg.reactions);
            } catch {
              // Ignore invalid JSON
            }
          }

          // Find reply context within cluster
          let replyToSender: string | null = null;
          let replyToText: string | null = null;
          if (msg.reply_to_id && (!msg.reply_to_peer_id || msg.reply_to_peer_id === msg.chat_id)) {
            const replyMsg = messages.find(m => m.id === msg.reply_to_id && m.chat_id === msg.chat_id);
            if (replyMsg) {
              replyToSender = replyMsg.sender || 'Unknown';
              replyToText = replyMsg.text || '';
            }
          }

          return {
            id: msg.id,
            chatId: msg.chat_id,
            replyToChatId: msg.reply_to_peer_id,
            sender: msg.sender || 'Unknown',
            text: msg.text || '',
            date,
            hasMedia: msg.has_media === 1,
            mediaType: msg.media_type,
            reactions,
            replyToId: msg.reply_to_id,
            replyToSender,
            replyToText,
          };
        });

        // Print messages using shared formatting
        for (const msgData of messageDataList) {
          if (options.verbose) {
            const lines = formatMessageVerbose(msgData);
            // Apply colors
            const headerParts = lines[0].split(' ');
            const coloredHeader = chalk.dim(headerParts[0]) + ' ' +
              chalk.dim(headerParts.slice(1, 3).join(' ')) + ' ' +
              chalk.cyan(headerParts.slice(3).join(' '));
            console.log(coloredHeader);

            for (let i = 1; i < lines.length; i++) {
              const line = lines[i];
              if (line.trim().startsWith('↳')) {
                console.log(chalk.dim(line));
              } else if (line.trim().startsWith('[') && line.includes('×')) {
                console.log(chalk.dim(line));
              } else if (line.trim().startsWith('[')) {
                console.log(chalk.dim(line));
              } else {
                console.log(line);
              }
            }
            console.log();
          } else {
            const formatted = formatMessageCompact(msgData, { maxTextLength: 100 });
            // Apply colors
            let colored = formatted;
            colored = colored.replace(/^(#\d+)/, chalk.dim('$1'));
            colored = colored.replace(/([A-Z][a-z]{2} \d{1,2} \d{2}:\d{2})/, chalk.dim('$1'));
            colored = colored.replace(/(\d{2}:\d{2}\s+)([^:]+)(:)/, '$1' + chalk.cyan('$2') + '$3');
            colored = colored.replace(/(\[(?:photo|video|document|voice|audio|sticker|gif)\])/, chalk.dim('$1'));
            colored = colored.replace(/(\[[^\]]*×[^\]]*\])$/, chalk.dim('$1'));
            colored = colored.replace(/(↳\s+"[^"]*")/, chalk.dim('$1'));
            console.log(colored);
          }
        }
      } catch (err) {
        console.error(chalk.red('❌ Error:'), (err as Error).message);
        process.exit(1);
      }
    });
}

/**
 * Print a cluster summary line
 */
function printClusterSummary(cluster: ClusterWithPreview): void {
  const duration = formatDuration(cluster.startTime, cluster.endTime);
  const dateStr = formatClusterDate(cluster.startTime);
  const preview = cluster.preview.replace(/\n/g, ' ').slice(0, 60);

  console.log(
    chalk.dim(`#${cluster.id}`) + ' ' +
    chalk.cyan(cluster.chatTitle.slice(0, 15).padEnd(15)) + ' ' +
    chalk.dim(dateStr.padEnd(16)) + ' ' +
    chalk.yellow(`${cluster.messageCount} msgs`.padEnd(10)) + ' ' +
    chalk.dim(`(${duration})`)
  );
  console.log(chalk.dim(`    ${preview}${preview.length >= 60 ? '…' : ''}`));
}

/**
 * Print a cluster search result
 */
function printClusterSearchResult(result: ClusterSearchResult): void {
  const similarity = Math.round(result.similarity * 100);
  const duration = formatDuration(result.startTime, result.endTime);
  const dateStr = formatClusterDate(result.startTime);
  const preview = result.preview.replace(/\n/g, ' ').slice(0, 60);

  console.log(
    chalk.green(`📦 Cluster #${result.clusterId}`) + ' ' +
    chalk.yellow(`(${similarity}% similar)`) + ' ' +
    chalk.dim(`- ${dateStr}, ${result.messageCount} messages`)
  );
  console.log(chalk.dim(`   "${preview}${preview.length >= 60 ? '…' : ''}"`));
  console.log(chalk.dim(`   → telegram cluster ${result.clusterId}`));
  console.log();
}

/**
 * Register cluster search command
 */
export function registerClustersSearchCommand(telegram: Command): void {
  telegram
    .command('clusters-search <query>')
    .description('Semantic search over conversation clusters')
    .option('--limit <n>', 'Maximum results', '10')
    .option('--chat <chat>', 'Filter by chat ID')
    .option('--json', 'Output as JSON')
    .addHelpText('after', `
${chalk.yellow('Examples:')}
  ${chalk.dim('# Search clusters for a topic')}
  claude-tools telegram clusters-search "deployment issues"

  ${chalk.dim('# Search by topic')}
  claude-tools telegram clusters-search "database migration"

  ${chalk.dim('# Filter by chat')}
  claude-tools telegram clusters-search "API errors" --chat "123456789"

  ${chalk.dim('# Limit results')}
  claude-tools telegram clusters-search "performance" --limit 5

${chalk.yellow('Note:')} Run "telegram sync <chat>" first to build cluster embeddings.
`)
    .action(async (query: string, options: {
      limit: string;
      chat?: string;
      json?: boolean;
    }) => {
      try {
        if (options.chat) { const id=resolveChatId(options.chat); if(!id) throw new Error('Chat not cached: '+options.chat); options.chat=id; }
        // Check if search is available
        const { available, reason } = await isClusterSearchAvailable();
        if (!available) {
          if(options.json) console.log('[]'); else console.error(chalk.yellow(reason));
          return;
        }

        const limit = parseInt(options.limit, 10);
        console.error(chalk.bold(`🧠 Searching clusters for: "${query}"\n`));

        const results = await searchClusters(query, limit, options.chat);

        if (results.length === 0) {
          console.log(options.json ? '[]' : chalk.dim('No matching clusters found.'));
          return;
        }

        if (options.json) {
          console.log(JSON.stringify(results, null, 2));
          return;
        }

        console.log(chalk.dim(`Found ${results.length} cluster matches:\n`));

        for (const result of results) {
          printClusterSearchResult(result);
        }

        const embeddingCount = getClusterEmbeddingCount();
        console.log(chalk.dim(`\nSearched ${embeddingCount} cluster embeddings`));
      } catch (err) {
        console.error(chalk.red('❌ Error:'), (err as Error).message);
        process.exit(1);
      }
    });
}
