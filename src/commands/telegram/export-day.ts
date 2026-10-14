import { resolveChatId as resolveCachedChat } from '../../services/telegram-search.js';
// Export messages for a specific day from synced database
// Used for daily summarization workflows

import { Command } from 'commander';
import chalk from 'chalk';
import { getDatabase, MessageRow } from '../../db/index.js';

interface DayStats {
  date: string;
  messageCount: number;
}

interface ExportOptions {
  chat?: string;
  json?: boolean;
  text?: boolean;
  stats?: boolean;
  days?: string;
  humanOnly?: boolean;
}

/**
 * Get list of days with message counts
 */
function getDayStats(chatId?: string, limit: number = 30): DayStats[] {
  const db = getDatabase();

  let sql = `
    SELECT
      date(date, 'unixepoch') as day,
      COUNT(*) as message_count
    FROM messages
  `;

  const params: any[] = [];
  if (chatId) {
    sql += ` WHERE chat_id = ?`;
    params.push(chatId);
  }

  sql += ` GROUP BY day ORDER BY day DESC LIMIT ?`;
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as { day: string; message_count: number }[];

  return rows.map(row => ({
    date: row.day,
    messageCount: row.message_count,
  }));
}

/**
 * Get all unique senders for a day
 */
function getUniqueSenders(date: string, chatId?: string): string[] {
  const db = getDatabase();

  let sql = `
    SELECT DISTINCT sender
    FROM messages
    WHERE date(date, 'unixepoch') = ?
  `;

  const params: any[] = [date];
  if (chatId) {
    sql += ` AND chat_id = ?`;
    params.push(chatId);
  }

  sql += ` AND sender IS NOT NULL ORDER BY sender`;

  const rows = db.prepare(sql).all(...params) as { sender: string }[];
  return rows.map(r => r.sender);
}

/**
 * Get messages for a specific day
 */
function getMessagesForDay(date: string, chatId?: string): MessageRow[] {
  const db = getDatabase();

  let sql = `
    SELECT * FROM messages
    WHERE date(date, 'unixepoch') = ?
  `;

  const params: any[] = [date];
  if (chatId) {
    sql += ` AND chat_id = ?`;
    params.push(chatId);
  }

  sql += ` ORDER BY date ASC, id ASC`;

  return db.prepare(sql).all(...params) as MessageRow[];
}

/**
 * Get chat_id by title
 */
function getChatIdByTitle(title: string): string | null { return resolveCachedChat(title); }

/**
 * Format messages for human-readable output
 */
function formatMessagesAsMarkdown(messages: MessageRow[], date: string): string {
  const lines: string[] = [];

  lines.push(`# Messages for ${date}`);
  lines.push(`*${messages.length} messages*`);
  lines.push('');
  lines.push('---');

  for (const msg of messages) {
    const time = new Date(msg.date * 1000).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });

    lines.push(`### [chat:${msg.chat_id}] #${msg.id} ${msg.sender || 'Unknown'} [${time}]`);

    if (msg.reply_to_id && (!msg.reply_to_peer_id || msg.reply_to_peer_id === msg.chat_id)) {
      lines.push(`↳ Reply to #${msg.reply_to_id}`);
    }

    if (msg.text) {
      lines.push(msg.text);
    }

    if (msg.has_media) {
      lines.push(`[${msg.media_type || 'media'}]`);
    }

    lines.push('---');
  }

  return lines.join('\n');
}

/**
 * Format messages as JSON for processing
 */
function formatMessagesAsJson(messages: MessageRow[], date: string): string {
  const output = {
    date,
    messageCount: messages.length,
    participants: [...new Set(messages.map(m => m.sender).filter(Boolean))],
    messages: messages.map(msg => ({
      id: msg.id,
    chatId: msg.chat_id,
    replyToPeerId: msg.reply_to_peer_id,
      sender: msg.sender,
      time: new Date(msg.date * 1000).toISOString(),
      text: msg.text,
      replyTo: msg.reply_to_id,
      hasMedia: !!msg.has_media,
      mediaType: msg.media_type,
    })),
  };

  return JSON.stringify(output, null, 2);
}

/**
 * Format messages as plain text conversation - optimized for LLM reading
 * Compact format: [HH:MM] Sender: message
 * Replies shown as: [HH:MM] Sender (replying to OtherSender): message
 */
function formatMessagesAsText(messages: MessageRow[], date: string, filtered: boolean = false): string {
  const lines: string[] = [];

  // Header with metadata
  const participants = [...new Set(messages.map(m => m.sender).filter(Boolean))];
  const humanParticipants = participants.filter(p => p !== 'Team Notifications');

  lines.push(`=== Telegram messages - ${date} ===`);
  lines.push(`Total: ${messages.length} messages${filtered ? ' (human only)' : ''}`);
  lines.push(`Participants: ${humanParticipants.join(', ')}`);
  lines.push('');
  lines.push('--- CONVERSATION ---');
  lines.push('');

  // Build a map of message IDs to senders for reply context
  const msgMap = new Map<string, { sender: string; text: string }>();
  for (const msg of messages) {
    msgMap.set(`${msg.chat_id}:${msg.id}`, { sender: msg.sender || 'Unknown', text: msg.text || '' });
  }

  for (const msg of messages) {
    const time = new Date(msg.date * 1000).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });

    const sender = msg.sender || 'Unknown';
    let line = `[${time}] [chat:${msg.chat_id}] #${msg.id} ${sender}`;

    // Add reply context
    if (msg.reply_to_id) {
      const replyTo = msgMap.get(`${msg.reply_to_peer_id || msg.chat_id}:${msg.reply_to_id}`);
      if (replyTo) {
        const preview = replyTo.text?.substring(0, 50).replace(/\n/g, ' ') || '';
        line += ` (replying to ${replyTo.sender}: "${preview}${replyTo.text && replyTo.text.length > 50 ? '...' : ''}")`;
      }
    }

    line += ':';

    // Message content
    if (msg.text) {
      // Indent multiline messages
      const textLines = msg.text.split('\n');
      if (textLines.length === 1) {
        line += ` ${msg.text}`;
      } else {
        line += '\n' + textLines.map(l => '  ' + l).join('\n');
      }
    }

    // Media indicator
    if (msg.has_media && !msg.text) {
      line += ` [${msg.media_type || 'media'}]`;
    } else if (msg.has_media) {
      line += ` [+${msg.media_type || 'media'}]`;
    }

    lines.push(line);
  }

  return lines.join('\n');
}

export function registerExportDayCommand(telegram: Command): void {
  telegram
    .command('export-day [date]')
    .description('Export messages for a specific day (YYYY-MM-DD)')
    .option('--chat <name>', 'Filter by chat title')
    .option('--json', 'Output as JSON (structured data)')
    .option('--text', 'Output as plain text conversation (default, optimized for LLM)')
    .option('--human-only', 'Exclude automated bot messages (Team Notifications)')
    .option('--stats', 'Show day statistics instead of messages')
    .option('--days <n>', 'Show stats for last N days', '30')
    .addHelpText('after', `
${chalk.yellow('Examples:')}
  ${chalk.dim('# Export today\'s messages')}
  claude-tools telegram export-day 2026-01-08

  ${chalk.dim('# Export as plain text (default, best for LLM summarization)')}
  claude-tools telegram export-day 2026-01-07 > day.txt

  ${chalk.dim('# Export without bot messages (human conversations only)')}
  claude-tools telegram export-day 2026-01-07 --human-only > day.txt

  ${chalk.dim('# Export as JSON for structured processing')}
  claude-tools telegram export-day 2026-01-07 --json > day.json

  ${chalk.dim('# Show message counts per day')}
  claude-tools telegram export-day --stats --days 14

${chalk.yellow('Daily Summary with Claude CLI:')}
  1. Export day:  export-day 2026-01-07 > day.txt
  2. Summarize:   claude --model opus -p "Read day.txt and summarize"
`)
    .action(async (date: string | undefined, options: ExportOptions) => {
      try {
        // Handle --stats flag
        if (options.stats) {
          const days = parseInt(options.days || '30', 10);
          showDayStats(options.chat, days);
          return;
        }

        // Require date for non-stats operation
        if (!date) {
          console.error(chalk.red('Date required. Use YYYY-MM-DD or --stats for statistics'));
          process.exit(1);
        }

        // Validate date format
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          console.error(chalk.red('Invalid date format. Use YYYY-MM-DD'));
          process.exit(1);
        }

        // Get chat ID if filtering by chat
        let chatId: string | undefined;
        if (options.chat) {
          chatId = getChatIdByTitle(options.chat) || undefined;
          if (!chatId) {
            console.error(chalk.red(`Chat "${options.chat}" not found in synced chats`));
            process.exit(1);
          }
        }

        let messages = getMessagesForDay(date, chatId);

        // Filter out bot messages if --human-only
        if (options.humanOnly) {
          messages = messages.filter(m => m.sender !== 'Team Notifications');
        }

        if (messages.length === 0) {
          console.error(chalk.yellow(`No messages found for ${date}`));
          process.exit(0);
        }

        if (options.json) {
          console.log(formatMessagesAsJson(messages, date));
        } else {
          // Default to text format (optimized for LLM)
          console.log(formatMessagesAsText(messages, date, !!options.humanOnly));
        }

      } catch (err) {
        console.error(chalk.red('Error:'), (err as Error).message);
        process.exit(1);
      }
    });
}

function showDayStats(chatName: string | undefined, days: number): void {
  let chatId: string | undefined;
  if (chatName) {
    chatId = getChatIdByTitle(chatName) || undefined;
    if (!chatId) {
      console.error(chalk.red(`Chat "${chatName}" not found`));
      process.exit(1);
    }
  }

  const stats = getDayStats(chatId, days);

  console.log(chalk.bold('\n📊 Messages per Day\n'));

  if (chatName) {
    console.log(chalk.dim(`Chat: ${chatName}\n`));
  }

  for (const day of stats) {
    const bar = '█'.repeat(Math.min(Math.floor(day.messageCount / 20), 40));
    console.log(`${day.date}  ${chalk.cyan(day.messageCount.toString().padStart(4))}  ${chalk.dim(bar)}`);
  }

  const total = stats.reduce((sum, d) => sum + d.messageCount, 0);
  console.log(chalk.dim(`\nTotal: ${total.toLocaleString()} messages over ${stats.length} days`));
  console.log(chalk.dim(`Average: ${Math.round(total / stats.length)} messages/day`));
}
