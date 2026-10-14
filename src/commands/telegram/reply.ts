// Reply command - send a reply to a specific message in a chat

import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig } from '../../config/loader.js';
import { TelegramService } from '../../services/telegram.js';
import { formatMessageLink, sentLabel, sentLink } from './format.js';
import { resolveMessageArg } from './stdin.js';
import { accountSendsRich, enforceFormat, formatHelpSection, FORMAT_OK_FLAG, FORMAT_OK_HELP, MD2_HELP, RICH_HELP } from './format-gate.js';

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

export function registerReplyCommand(telegram: Command): void {
  telegram
    .command('reply <chat> <message> <msgId>')
    .description('Reply to a specific message in a chat (msgId required, use "-" to read from stdin)')
    .addHelpText('after', `
${chalk.yellow('Examples:')}
  ${chalk.dim('# Reply to message #102188')}
  claude-tools telegram reply "Team Dev Chat" "Got it!" 102188

  ${chalk.dim('# Reply to saved messages')}
  claude-tools telegram reply me "Note to self" 12345

  ${chalk.dim('# Reply with multiline text from stdin')}
  cat message.txt | claude-tools telegram reply "Team Dev Chat" - 102188

  ${chalk.dim('# Reply without sound (outside working hours)')}
  claude-tools telegram reply "Team Dev Chat" "Checked, all good" 102188 --mute

  ${chalk.dim('# Replies are rich markdown (bold titles, bullets, tables); {{time:...}} works in any reply')}
  cat report.md | claude-tools telegram reply "Team Dev Chat" - 102188

  ${chalk.dim('# The old MarkdownV2 path, without rich formatting')}
  claude-tools telegram reply me "Note to self" 12345 --md2
${formatHelpSection()}`)
    .option('--mute', 'Send without sound/notification (message still delivered)')
    .option('--rich', RICH_HELP)
    .option('--md2', MD2_HELP)
    .option(FORMAT_OK_FLAG, FORMAT_OK_HELP)
    .action(async (chat: string, message: string, msgId: string, options: { mute?: boolean; rich?: boolean; md2?: boolean; formatOk?: string }) => {
      const replyToMsgId = parseInt(msgId, 10);
      if (isNaN(replyToMsgId)) {
        console.error(chalk.red('❌ Invalid message ID:'), msgId);
        process.exit(1);
      }

      try {
        const rich = accountSendsRich(options);
        const resolvedMessage = await resolveMessageArg(message);
        // Checked before the config and the connection: a refused message never reaches Telegram.
        const note = enforceFormat(resolvedMessage, options.formatOk, !rich);
        const config = ensureTelegramConfig();
        const service = new TelegramService(config);
        await service.connect();
        const result = rich
          ? await service.sendRichMessage(chat, resolvedMessage, replyToMsgId, options.mute === true)
          : await service.sendMessage(chat, resolvedMessage, replyToMsgId, 'md2', options.mute === true);
        const replyToLink = formatMessageLink(result.chatId, replyToMsgId);
        console.log(chalk.green(`${sentLabel('Replied', { mute: options.mute, rich })}${note} to`), chalk.dim(replyToLink), chalk.green('→'), chalk.dim(sentLink(result)));
        await service.disconnect();
      } catch (err) {
        console.error(chalk.red('❌ Error:'), (err as Error).message);
        process.exit(1);
      }
    });
}
