import { Command } from 'commander';
import chalk from 'chalk';

import { loadConfig } from '../../config/loader.js';
import { TelegramService } from '../../services/telegram.js';

type ExportRangeOptions = {
  chat: string;
  months: string;
  from?: string;
  to?: string;
  limit?: string;
  json?: boolean;
};

function ensureTelegramConfig() {
  const config = loadConfig();
  if (!config.telegram) {
    console.error(chalk.red('Telegram is not configured.'));
    console.error(chalk.dim('Missing TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_SESSION_STRING'));
    process.exit(1);
  }
  return config.telegram;
}

function parseDate(raw: string | undefined, flag: string): Date | undefined {
  if (!raw) return undefined;
  const value = new Date(raw);
  if (Number.isNaN(value.getTime())) {
    throw new Error(`Invalid ${flag} date: ${raw}. Use YYYY-MM-DD or full ISO timestamp.`);
  }
  return value;
}

export function registerExportRangeCommand(telegram: Command): void {
  telegram
    .command('export-range')
    .description('Export live Telegram messages for a chat over a time range as JSON')
    .requiredOption('--chat <chat>', 'Chat ID, @username, or exact chat title')
    .option('--months <n>', 'Relative range in months when --from is omitted', '1')
    .option('--from <date>', 'Start date (YYYY-MM-DD or ISO timestamp)')
    .option('--to <date>', 'End date (YYYY-MM-DD or ISO timestamp)')
    .option('--limit <n>', 'Maximum messages to export')
    .option('--json', 'Output structured JSON (default and recommended)')
    .addHelpText('after', `
${chalk.yellow('Examples:')}
  ${chalk.dim('# Export one month of channel posts as JSON')}
  claude-tools telegram export-range --chat @somechannel --months 1 --json

  ${chalk.dim('# Export an explicit date range')}
  claude-tools telegram export-range --chat 2358999255 --from 2026-04-01 --to 2026-05-01 --json
`)
    .action(async (options: ExportRangeOptions) => {
      const config = ensureTelegramConfig();
      const service = new TelegramService(config);

      try {
        const from = parseDate(options.from, '--from');
        const to = parseDate(options.to, '--to');
        const months = Number.parseInt(options.months || '1', 10);
        const limit = options.limit ? Number.parseInt(options.limit, 10) : undefined;

        if (from && to && from > to) {
          throw new Error('--from must be earlier than --to.');
        }
        if (!from && (!Number.isFinite(months) || months <= 0)) {
          throw new Error('--months must be a positive integer when --from is omitted.');
        }
        if (limit != null && (!Number.isFinite(limit) || limit <= 0)) {
          throw new Error('--limit must be a positive integer.');
        }

        await service.connect();
        const exported = await service.exportMessagesRange({
          chatId: options.chat,
          months,
          from,
          to,
          limit,
        });
        await service.disconnect();

        const payload = {
          source: 'telegram',
          exportedAt: new Date().toISOString(),
          range: {
            chat: options.chat,
            months: from ? null : months,
            from: from ? from.toISOString() : null,
            to: to ? to.toISOString() : null,
            limit: limit ?? null,
          },
          chat: exported.chat,
          messageCount: exported.messages.length,
          messages: exported.messages,
        };

        console.log(JSON.stringify(payload, null, 2));
      } catch (err) {
        try {
          await service.disconnect();
        } catch {
          // Ignore disconnect errors on failure.
        }
        console.error(chalk.red('❌ Error:'), (err as Error).message);
        process.exit(1);
      }
    });
}
