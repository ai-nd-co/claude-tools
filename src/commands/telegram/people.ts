// People/contacts commands - list participants in chats

import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig } from '../../config/loader.js';
import { TelegramService, type TelegramParticipant } from '../../services/telegram.js';

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

/**
 * Format full name from first/last name
 */
function formatName(firstName?: string, lastName?: string): string {
  const parts = [firstName, lastName].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : '-';
}

/**
 * Format username with @ prefix
 */
function formatUsername(username?: string): string {
  return username ? `@${username}` : '-';
}

export function registerPeopleCommands(telegram: Command): void {
  // List participants command
  telegram
    .command('people <chat>')
    .description('List participants in a chat')
    .option('--limit <n>', 'Max participants to show', '50')
    .option('--json', 'Output as JSON')
    .option('--no-bots', 'Exclude bots from the list')
    .addHelpText('after', `
${chalk.yellow('Examples:')}
  ${chalk.dim('# List participants in a group')}
  claude-tools telegram people "Team Dev Chat"

  ${chalk.dim('# List up to 100 participants')}
  claude-tools telegram people "My Group" --limit 100

  ${chalk.dim('# Output as JSON')}
  claude-tools telegram people "My Group" --json
`)
    .action(async (chat: string, options: { limit: string; json?: boolean; bots?: boolean }) => {
      const config = ensureTelegramConfig();
      const service = new TelegramService(config);

      try {
        await service.connect();
        const participants = await service.getParticipants(chat, parseInt(options.limit, 10));

        // Filter bots if requested
        const filtered = options.bots === false
          ? participants.filter(p => !p.isBot)
          : participants;

        if (options.json) {
          console.log(JSON.stringify(filtered, null, 2));
        } else {
          console.log(chalk.bold(`\n👥 ${chat} (${filtered.length} participants)\n`));

          // Calculate dynamic column widths based on content
          const idWidth = Math.max(12, ...filtered.map(p => p.id.length + 2));
          const usernameWidth = Math.max(10, ...filtered.map(p => formatUsername(p.username).length + 2));
          const nameWidth = Math.max(10, ...filtered.map(p => formatName(p.firstName, p.lastName).length + 2));

          console.log(
            chalk.dim(
              'ID'.padEnd(idWidth) +
              'Username'.padEnd(usernameWidth) +
              'Name'
            )
          );
          console.log(chalk.dim('─'.repeat(idWidth + usernameWidth + nameWidth)));

          for (const p of filtered) {
            const name = formatName(p.firstName, p.lastName);
            const username = formatUsername(p.username);

            const displayId = p.id.padEnd(idWidth);
            const displayUsername = username.padEnd(usernameWidth);

            // Bot indicator
            const botIcon = p.isBot ? chalk.dim(' [bot]') : '';

            console.log(
              `${displayId}${chalk.cyan(displayUsername)}${name}${botIcon}`
            );
          }
        }

        await service.disconnect();
      } catch (err) {
        console.error(chalk.red('❌ Error:'), (err as Error).message);
        process.exit(1);
      }
    });
}
