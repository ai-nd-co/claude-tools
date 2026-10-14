// Unread messages command - show unread from non-muted chats

import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig } from '../../config/loader.js';
import { TelegramService, UnreadChat, type TelegramMessage, type MessageEntity } from '../../services/telegram.js';
import {
  formatSmartDate,
  formatReplyVerbose,
  formatReplyCompact,
  formatReactions,
  formatMessageCompact,
  formatMessageVerbose,
  formatMessageLink,
  type MessageData,
} from './format.js';

/**
 * Format message text with terminal styling (bold, italic, underline, code)
 * Uses chalk for actual terminal formatting instead of markdown syntax
 */
function formatTextForTerminal(text: string, entities?: MessageEntity[]): string {
  if (!entities || entities.length === 0) {
    return text;
  }

  const sortedEntities = [...entities].sort((a, b) => b.offset - a.offset);
  let result = text;

  for (const entity of sortedEntities) {
    const before = result.substring(0, entity.offset);
    const entityText = result.substring(entity.offset, entity.offset + entity.length);
    const after = result.substring(entity.offset + entity.length);

    switch (entity.type) {
      case 'text_url':
        result = `${before}${chalk.underline(entityText)} ${chalk.dim(`(${entity.url})`)}${after}`;
        break;
      case 'url':
        result = `${before}${chalk.underline(entityText)}${after}`;
        break;
      case 'bold':
        result = `${before}${chalk.bold(entityText)}${after}`;
        break;
      case 'italic':
        result = `${before}${chalk.italic(entityText)}${after}`;
        break;
      case 'code':
        result = `${before}${chalk.bgGray.white(` ${entityText} `)}${after}`;
        break;
      case 'pre':
        result = `${before}\n${chalk.bgGray.white(entityText)}\n${after}`;
        break;
      case 'mention':
        result = `${before}${chalk.cyan(entityText)}${after}`;
        break;
    }
  }

  return result;
}

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
 * Get chat type icon
 */
function getChatIcon(chat: UnreadChat): string {
  if (chat.isForum) return '📂';  // Forum with topics
  if (chat.isUser) return '👤';
  if (chat.isGroup) return '👥';
  if (chat.isChannel) return '📢';
  return '💬';
}

/**
 * Convert TelegramMessage to MessageData for shared formatting
 */
export function toMessageData(msg: TelegramMessage, chatTitle?: string): MessageData {
  // Format text with terminal styling (bold, italic, underline) if entities are present
  const formattedText = msg.entities?.length
    ? formatTextForTerminal(msg.text, msg.entities)
    : undefined;

  return {
    id: msg.id,
    chatId: msg.chatId?.toString(),
    replyToChatId: msg.replyToPeerId,
    sender: msg.sender,
    text: msg.text,
    date: msg.date,
    chatTitle,
    hasMedia: msg.hasMedia,
    mediaType: msg.mediaType,
    reactions: msg.reactions,
    replyToId: msg.replyToId,
    replyToSender: msg.replyToSender,
    replyToText: msg.replyToText,
    formattedText,
  };
}

/**
 * Print compact unread summary
 */
function printCompact(chats: UnreadChat[], showMuted: boolean): void {
  const totalMessages = chats.reduce((sum, c) => sum + c.unreadCount, 0);
  const mutedLabel = showMuted ? ' (including muted)' : '';

  console.log(chalk.bold(`📬 Unread Messages`) + chalk.dim(` (${chats.length} chats, ${totalMessages} messages${mutedLabel})\n`));

  if (chats.length === 0) {
    console.log(chalk.green('✨ All caught up! No unread messages.'));
    return;
  }

  for (const chat of chats) {
    const icon = getChatIcon(chat);
    const muteIndicator = chat.isMuted ? chalk.dim(' 🔇') : '';
    const mentionIndicator = chat.unreadMentionsCount > 0 ? chalk.yellow(` @${chat.unreadMentionsCount}`) : '';

    console.log(`${icon} ${chalk.cyan(chat.title)} ${chalk.yellow(`(${chat.unreadCount} unread)`)}${mentionIndicator}${muteIndicator}`);

    // Show recent messages using shared formatting
    for (const msg of chat.messages) {
      const msgData = toMessageData(msg, chat.title);
      const formatted = formatMessageCompact(msgData);

      // Apply colors to compact format
      // Format: #id Dec 22 14:30 Sender: [media] text... ↳ "reply" [reactions]
      let colored = formatted;
      colored = colored.replace(/^(#\d+)/, chalk.dim('$1'));
      colored = colored.replace(/([A-Z][a-z]{2} \d{1,2} \d{2}:\d{2})/, chalk.dim('$1'));
      colored = colored.replace(/(\d{2}:\d{2}\s+)([^:]+)(:)/, '$1' + chalk.cyan('$2') + '$3');
      colored = colored.replace(/(\[(?:photo|video|document|voice|audio|sticker|gif)\])/, chalk.dim('$1'));
      colored = colored.replace(/(\[[^\]]*×[^\]]*\])$/, chalk.dim('$1'));
      colored = colored.replace(/(↳\s+"[^"]*")/, chalk.dim('$1'));
      console.log(`  ${colored}`);
    }

    if (chat.unreadCount > chat.messages.length) {
      console.log(chalk.dim(`  ... and ${chat.unreadCount - chat.messages.length} more`));
    }

    console.log();
  }
}

/**
 * Print verbose unread summary with message IDs
 */
function printVerbose(chats: UnreadChat[], showMuted: boolean): void {
  const totalMessages = chats.reduce((sum, c) => sum + c.unreadCount, 0);
  const mutedLabel = showMuted ? ' (including muted)' : '';

  console.log(chalk.bold(`\n📬 Unread Messages`) + chalk.dim(` (${chats.length} chats, ${totalMessages} messages${mutedLabel})\n`));

  if (chats.length === 0) {
    console.log(chalk.green('✨ All caught up! No unread messages.'));
    return;
  }

  for (const chat of chats) {
    const icon = getChatIcon(chat);
    const muteIndicator = chat.isMuted ? chalk.dim(' 🔇') : '';
    const mentionIndicator = chat.unreadMentionsCount > 0 ? chalk.yellow(` @${chat.unreadMentionsCount} mentions`) : '';
    const typeLabel = chat.isUser ? 'DM' : chat.isGroup ? 'Group' : 'Channel';

    console.log(`${icon} ${chalk.bold.cyan(chat.title)} ${chalk.yellow(`(${chat.unreadCount} unread)`)}${mentionIndicator}${muteIndicator}`);
    console.log(chalk.dim(`   ID: ${chat.id} | Type: ${typeLabel}`));
    console.log();

    // Show messages with colorful formatting
    for (const msg of chat.messages) {
      const msgData = toMessageData(msg, chat.title);
      const dateStr = formatSmartDate(msg.date);
      const chatIdStr = chat.id?.toString();
      const messageLink = formatMessageLink(chatIdStr, msg.id);

      // Header line: blue link, dim date, cyan sender
      console.log(
        '  ' + chalk.blue(messageLink) + ' ' +
        chalk.dim(dateStr) + ' ' +
        chalk.cyan.bold(msg.sender)
      );

      // Reply context (if any) - dim with arrow and link
      if (msg.replyToId) {
        const replyLink = formatMessageLink(msg.replyToPeerId || chatIdStr, msg.replyToId);
        const replyPreview = msg.replyToText
          ? `"${msg.replyToText.replace(/\n/g, ' ').slice(0, 30)}${msg.replyToText.length > 30 ? '…' : ''}"`
          : '';
        console.log(chalk.dim(`    ↳ ${replyLink} (${msg.replyToSender || 'unknown'})${replyPreview ? ' ' + replyPreview : ''}`));
      }

      // Media indicator - yellow
      if (msg.hasMedia && msg.mediaType) {
        console.log(chalk.yellow(`    [${msg.mediaType}]`));
      }

      // Message text - normal/white, with terminal formatting applied
      const displayText = msgData.formattedText || msg.text;
      if (displayText) {
        const textLines = displayText.split('\n');
        for (const line of textLines) {
          console.log(`    ${line}`);
        }
      }

      // Reactions - dim
      if (msg.reactions?.length) {
        const reactionsStr = msg.reactions.map(r => r.count > 1 ? `${r.emoji}×${r.count}` : r.emoji).join(' ');
        console.log(chalk.dim(`    [${reactionsStr}]`));
      }

      console.log();
    }

    if (chat.unreadCount > chat.messages.length) {
      console.log(chalk.dim(`  ... and ${chat.unreadCount - chat.messages.length} more unread messages`));
      console.log();
    }

    console.log(chalk.dim('─'.repeat(60)));
    console.log();
  }
}

/**
 * Print chats-only summary (no messages)
 */
function printChatsOnly(chats: UnreadChat[], showMuted: boolean): void {
  const totalMessages = chats.reduce((sum, c) => sum + c.unreadCount, 0);
  const mutedLabel = showMuted ? ' (including muted)' : '';

  console.log(chalk.bold(`📬 Unread Summary`) + chalk.dim(` (${chats.length} chats, ${totalMessages} messages${mutedLabel})\n`));

  if (chats.length === 0) {
    console.log(chalk.green('✨ All caught up! No unread messages.'));
    return;
  }

  for (const chat of chats) {
    const icon = getChatIcon(chat);
    const muteIndicator = chat.isMuted ? chalk.dim(' 🔇') : '';
    const mentionIndicator = chat.unreadMentionsCount > 0 ? chalk.yellow(` @${chat.unreadMentionsCount}`) : '';

    console.log(`${icon} ${chalk.cyan(chat.title.slice(0, 40))} ${chalk.yellow(chat.unreadCount.toString().padStart(5))} unread${mentionIndicator}${muteIndicator} ${chalk.dim(`#${chat.id}`)}`);
  }
}

export function registerUnreadCommand(telegram: Command): void {
  telegram
    .command('unread')
    .description('Show unread messages from non-muted chats and forum topics')
    .option('--all', 'Include muted chats and topics')
    .option('--limit <n>', 'Messages per chat/topic', '5')
    .option('--list', 'Only show chat list with counts')
    .option('--verbose', 'Show full messages with IDs')
    .option('--archived', 'Include archived chats')
    .option('--no-forums', 'Do not expand forum topics (show as single chat)')
    .option('--json', 'Output as JSON')
    .addHelpText('after', `
${chalk.yellow('Examples:')}
  ${chalk.dim('# Show unread from non-muted chats and topics')}
  claude-tools telegram unread

  ${chalk.dim('# Include muted chats/topics too')}
  claude-tools telegram unread --all

  ${chalk.dim('# Just show chat counts')}
  claude-tools telegram unread --list

  ${chalk.dim('# Verbose with message IDs for replying')}
  claude-tools telegram unread --verbose

  ${chalk.dim('# Do not expand forum topics')}
  claude-tools telegram unread --no-forums
`)
    .action(async (options: {
      all?: boolean;
      limit: string;
      list?: boolean;
      verbose?: boolean;
      archived?: boolean;
      forums?: boolean;  // defaults to true, --no-forums sets to false
      json?: boolean;
    }) => {
      const config = ensureTelegramConfig();
      const service = new TelegramService(config);

      try {
        await service.connect();

        const chats = await service.getUnreadMessages({
          includeMuted: options.all,
          includeArchived: options.archived,
          expandForums: options.forums !== false,  // default true, --no-forums sets to false
          messagesPerChat: parseInt(options.limit, 10),
          chatsLimit: 100,
        });

        if (options.json) {
          console.log(JSON.stringify(chats, null, 2));
        } else if (options.list) {
          printChatsOnly(chats, !!options.all);
        } else if (options.verbose) {
          printVerbose(chats, !!options.all);
        } else {
          printCompact(chats, !!options.all);
        }

        await service.disconnect();
      } catch (err) {
        console.error(chalk.red('❌ Error:'), (err as Error).message);
        process.exit(1);
      }
    });
}
