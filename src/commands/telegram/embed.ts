// Telegram embed command - show embedding status

import { Command } from 'commander';
import chalk from 'chalk';
import { hasMessages } from '../../services/telegram-search.js';
import { getEmbeddingStats } from '../../services/embedding-service.js';

export function registerEmbedCommand(telegram: Command): void {
  telegram
    .command('embed')
    .description('Show embedding status for semantic search')
    .addHelpText('after', `
${chalk.yellow('Examples:')}
  claude-tools telegram embed

${chalk.yellow('Note:')}
  Embeddings are automatically generated during sync.
  Run ${chalk.cyan('telegram sync <chat>')} to sync and index messages.
`)
    .action(async () => {
      try {
        if (!hasMessages()) {
          console.log(chalk.yellow('No messages synced yet.'));
          console.log(chalk.dim('Run: claude-tools telegram sync <chat>'));
          return;
        }

        const stats = getEmbeddingStats();
        console.log(chalk.bold('\nTelegram Embedding Status'));
        console.log(`Total embeddings: ${chalk.cyan(stats.total)}`);
        if (Object.keys(stats.byType).length > 0) {
          console.log(chalk.dim('\nBy type:'));
          for (const [type, count] of Object.entries(stats.byType)) {
            console.log(`  ${type}: ${chalk.cyan(count)}`);
          }
        }
      } catch (err) {
        console.error(chalk.red('Error:'), (err as Error).message);
        process.exit(1);
      }
    });
}
