// Mark as read command - mark messages as read in a chat

import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig } from '../../config/loader.js';
import { TelegramService } from '../../services/telegram.js';

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

export function registerMarkReadCommand(telegram: Command): void {
  telegram
    .command('mark-read [chat]')
    .description('Mark messages as read in a chat')
    .option('--all', 'Mark all non-muted chats as read')
    .addHelpText('after', `
${chalk.yellow('Examples:')}
  ${chalk.dim('# Mark a specific chat as read')}
  claude-tools telegram mark-read "Team Dev Chat"

  ${chalk.dim('# Mark by chat ID')}
  claude-tools telegram mark-read 1234567890

  ${chalk.dim('# Mark all non-muted chats as read')}
  claude-tools telegram mark-read --all
`)
    .action(async (chat: string | undefined, options: { all?: boolean }) => {
      const config = ensureTelegramConfig();
      const service = new TelegramService(config);

      try {
        await service.connect();

        if (options.all) {
          // Get all unread non-muted chats and mark them as read
          const chats = await service.getUnreadMessages({
            includeMuted: false,
            messagesPerChat: 1,
            chatsLimit: 100,
          });

          if (chats.length === 0) {
            console.log(chalk.green('✨ No unread messages to mark as read.'));
            await service.disconnect();
            return;
          }

          let marked = 0;
          for (const c of chats) {
            try {
              await service.markAsRead(c.id);
              marked++;
              console.log(chalk.green('✅'), chalk.dim('Marked as read:'), chalk.cyan(c.title));
            } catch (err) {
              console.log(chalk.yellow('⚠️'), chalk.dim('Could not mark:'), chalk.cyan(c.title), chalk.dim(`(${(err as Error).message})`));
            }
          }

          console.log();
          console.log(chalk.green(`✅ Marked ${marked} chats as read`));
        } else if (chat) {
          await service.markAsRead(chat);
          console.log(chalk.green('✅ Marked as read:'), chalk.cyan(chat));
        } else {
          console.error(chalk.red('Please specify a chat or use --all'));
          process.exit(1);
        }

        await service.disconnect();
      } catch (err) {
        console.error(chalk.red('❌ Error:'), (err as Error).message);
        process.exit(1);
      }
    });
}
