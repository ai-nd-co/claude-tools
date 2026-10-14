import { parseMessageId } from '../../services/telegram-peer.js';
import { redactSecrets } from '../../services/redact.js';
// Telegram commands - read, send, search messages

import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig } from '../../config/loader.js';
import { TelegramService, type TelegramMessage, type MessageEntity } from '../../services/telegram.js';
import { renderPins, sortPins } from '../../services/telegram-pins.js';
import { registerSyncCommand } from './sync.js';
import { registerReadAroundCommand } from './read-around.js';
import { registerUnreadCommand } from './unread.js';
import { registerReplyCommand } from './reply.js';
import { accountSendsRich, enforceFormat, formatHelpSection, FORMAT_OK_FLAG, FORMAT_OK_HELP, MD2_HELP, RICH_HELP } from './format-gate.js';
import { registerWatchCommand } from './watch.js';
import { registerMarkReadCommand } from './mark-read.js';
import { registerClustersCommand, registerClustersSearchCommand } from './clusters.js';
import { registerEmbedCommand } from './embed.js';
import { registerCleanCommand } from './clean.js';
import { registerPeopleCommands } from './people.js';
import { registerContactsCommand } from './contacts.js';
import { registerPruneContactsCommand } from './prune-contacts.js';
import { registerMediaCommands } from './media.js';
import { attachVoiceTranscripts } from '../../services/voice-transcription.js';
import { resolveSttBackends } from '../../services/stt.js';
import { pruneTranscriptCache } from '../../services/transcript-cache.js';
import { registerExportDayCommand } from './export-day.js';
import { registerExportRangeCommand } from './export-range.js';
import { registerSummarizeDayCommand } from './summarize-day.js';
import { searchMessages, hasMessages, resolveChatId, getMessage, getLastSyncTime, getRecentMessages, findMissingReplyTargets, enrichReplyContextFromDb, type SearchResponse, type SearchResult } from '../../services/telegram-search.js';
import { syncChat, getSyncState } from '../../services/telegram-sync.js';
import { ensureReactionsColumn, ensureEntitiesColumn } from '../../db/index.js';
import { semanticSearch, isSemanticSearchAvailable, type SemanticSearchResult } from '../../services/telegram-semantic.js';
import {
  formatReactions,
  formatShortDate,
  formatMediaIndicator,
  formatReplyVerbose,
  formatReplyCompact,
  truncateText,
  formatMessageCompact,
  formatMessageVerbose,
  formatMessageLink,
  sentLabel,
  sentLink,
  type MessageData,
} from './format.js';
import { resolveMessageArg } from './stdin.js';

/**
 * Format message text as Markdown, expanding hidden URLs and formatting entities
 */
function formatTextAsMarkdown(text: string, entities?: MessageEntity[]): string {
  if (!entities || entities.length === 0) {
    return text;
  }

  // Sort entities by offset in reverse order so we can replace from end to start
  // without messing up the offsets
  const sortedEntities = [...entities].sort((a, b) => b.offset - a.offset);

  let result = text;

  for (const entity of sortedEntities) {
    const before = result.substring(0, entity.offset);
    const entityText = result.substring(entity.offset, entity.offset + entity.length);
    const after = result.substring(entity.offset + entity.length);

    switch (entity.type) {
      case 'text_url':
        // Hidden URL: convert "Link" to "[Link](url)"
        result = `${before}[${entityText}](${entity.url})${after}`;
        break;
      case 'url':
        // Plain URL in text - keep as is (already visible)
        break;
      case 'bold':
        result = `${before}**${entityText}**${after}`;
        break;
      case 'italic':
        result = `${before}_${entityText}_${after}`;
        break;
      case 'code':
        result = `${before}\`${entityText}\`${after}`;
        break;
      case 'pre':
        result = `${before}\n\`\`\`\n${entityText}\n\`\`\`\n${after}`;
        break;
      // mention, hashtag, other - keep as-is
    }
  }

  return result;
}

/**
 * Format message text with terminal styling (bold, italic, underline, code)
 * Uses chalk for actual terminal formatting instead of markdown syntax
 */
function formatTextForTerminal(text: string, entities?: MessageEntity[]): string {
  if (!entities || entities.length === 0) {
    return text;
  }

  // Sort entities by offset in reverse order so we can replace from end to start
  const sortedEntities = [...entities].sort((a, b) => b.offset - a.offset);

  let result = text;

  for (const entity of sortedEntities) {
    const before = result.substring(0, entity.offset);
    const entityText = result.substring(entity.offset, entity.offset + entity.length);
    const after = result.substring(entity.offset + entity.length);

    switch (entity.type) {
      case 'text_url':
        // Show link text underlined, with URL in dim after
        result = `${before}${chalk.underline(entityText)} ${chalk.dim(`(${entity.url})`)}${after}`;
        break;
      case 'url':
        // Plain URL - make it underlined
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
      // hashtag, other - keep as-is
    }
  }

  return result;
}

/**
 * Get media indicator for display
 */
function getMediaIndicator(msg: TelegramMessage): string {
  if (!msg.hasMedia || !msg.mediaType) return '';

  if (msg.mediaType === 'unsupported') {
    const className = msg.mediaClassName ? `: ${msg.mediaClassName}` : '';
    return `[\u26A0 unsupported${className}]`;
  }

  const icons: Record<string, string> = {
    photo: '\u{1F4F7}',    // camera
    video: '\u{1F3AC}',    // clapper
    document: '\u{1F4C4}', // page
    voice: '\u{1F3A4}',    // microphone
    audio: '\u{1F3B5}',    // music note
    sticker: '\u{1F3A8}',  // palette
    gif: '\u{1F3AC}',      // clapper
  };

  const icon = icons[msg.mediaType] || '\u{1F4CE}'; // paperclip fallback
  let indicator = `[${icon} ${msg.mediaType}`;

  if (msg.mediaFilename) {
    indicator += ` ${msg.mediaFilename}`;
  } else if (msg.mediaSize && msg.mediaSize > 1024 * 1024) {
    indicator += ` ${(msg.mediaSize / (1024 * 1024)).toFixed(1)}MB`;
  }

  // Length is what decides whether a clip was auto-transcribed, so show it.
  if (msg.mediaDuration !== undefined && (msg.mediaType === 'voice' || msg.mediaType === 'audio')) {
    indicator += ` ${Math.round(msg.mediaDuration)}s`;
  }

  indicator += ']';

  // Quoted so a transcript is never mistaken for the sender's typed text.
  if (msg.transcript) {
    const quoted = msg.transcript.split('\n').map((line) => `> ${line}`).join('\n');
    indicator += `\n${quoted}`;
  }

  return indicator;
}

/**
 * Format reply context for display
 * @param msg - Message with reply info
 * @param maxLength - Maximum length for reply preview text (default 50)
 * @returns Formatted reply context string or empty string if no reply
 */
function formatReplyContext(msg: TelegramMessage, maxLength: number = 50): string {
  if (!msg.replyToId) return '';

  const sender = msg.replyToSender || 'unknown';
  let preview = '';

  if (msg.replyToText) {
    // Truncate and clean up the reply text
    const cleanText = msg.replyToText.replace(/\n/g, ' ').trim();
    preview = cleanText.length > maxLength
      ? cleanText.slice(0, maxLength) + '…'
      : cleanText;
  }

  if (preview) {
    return `↳ #${msg.replyToId} (${sender}): "${preview}"`;
  } else {
    return `↳ #${msg.replyToId} (${sender})`;
  }
}

/** What a button's payload is, so a url and a callback token are not both printed bare. */
function payload_label(kind: string): string {
  return kind === 'Url' ? '-> ' : kind === 'SwitchInline' ? 'query: ' : 'data: ';
}

/**
 * Convert TelegramMessage to MessageData for shared formatting
 */
function toMessageData(msg: TelegramMessage, chatId?: string, chatTitle?: string): MessageData {
  // Format text with terminal styling (bold, italic, underline) if entities are present
  const formattedText = msg.entities?.length
    ? formatTextForTerminal(msg.text, msg.entities)
    : undefined;

  return {
    chatId: msg.chatId?.toString() || chatId,
    id: msg.id,
    sender: msg.sender,
    text: msg.text,
    date: msg.date,
    chatTitle,
    hasMedia: msg.hasMedia,
    mediaType: msg.mediaType,
    reactions: msg.reactions,
    replyToId: msg.replyToId,
    replyToChatId: msg.replyToPeerId,
    replyToSender: msg.replyToSender,
    replyToText: msg.replyToText,
    formattedText,
  };
}

/**
 * Format a single message as Markdown (for telegram read default output)
 * Uses shared formatting functions for consistency
 */
function formatMessageAsMarkdown(msg: TelegramMessage, chatId?: string): string {
  const date = formatShortDate(msg.date);
  const msgChatId = chatId || msg.chatId?.toString();
  const messageLink = formatMessageLink(msgChatId, msg.id);

  const formattedText = formatTextAsMarkdown(msg.text, msg.entities);
  const mediaIndicator = getMediaIndicator(msg);

  // Media before text
  const textWithMedia = mediaIndicator
    ? (formattedText ? `${mediaIndicator}\n\n${formattedText}` : mediaIndicator)
    : formattedText;

  // Add reply context if this is a reply (verbose format, with chatId for link)
  const replyContext = msg.replyToId
    ? formatReplyVerbose(msg.replyToId, msg.replyToSender, msg.replyToText, msg.replyToPeerId || msgChatId)
    : '';
  const replyLine = replyContext ? `\n${replyContext}\n` : '';

  // Reactions at the bottom
  const reactionsLine = msg.reactions?.length ? `\n${formatReactions(msg.reactions)}` : '';

  // This is the path that printed a live bot token from the BotFather chat: the message quotes the
  // token verbatim and this renderer faithfully reproduced it. Nothing had asked for it.
  return redactSecrets(`### ${messageLink} | ${msg.sender}
*${date}*${replyLine}

${textWithMedia}${reactionsLine}`);
}

/**
 * Parse a numeric CLI option, rejecting values that would silently disable the
 * guard they configure (`--transcribe-limit 0`, `--transcribe-max abc`).
 */
function parsePositiveNumber(
  raw: string | undefined,
  fallback: number,
  flag: string,
  integer = false
): number {
  if (raw === undefined) return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid ${flag}: expected a positive number, got "${raw}"`);
  }
  // A fractional count would overshoot the budget: it is compared before each
  // decrement, so 1.5 allows two calls.
  if (integer && !Number.isInteger(value)) {
    throw new Error(`Invalid ${flag}: expected a whole number, got "${raw}"`);
  }
  return value;
}

/**
 * Transcribe short voice messages in a read result, when a backend is configured
 * (the speech cluster, Groq, or both — see services/stt.ts).
 *
 * Silent when neither is configured: `read` is the most-used command in this CLI and
 * must not start warning about an unconfigured optional feature on every call.
 */
async function maybeAttachTranscripts(
  service: TelegramService,
  chatId: string,
  messages: TelegramMessage[],
  options: { json?: boolean; transcribe?: boolean; transcribeMax?: string; transcribeLimit?: string }
): Promise<void> {
  // Commander maps `--no-transcribe` to `transcribe: false`.
  if (options.transcribe === false) return;
  if (!messages.some((m) => m.hasMedia && (m.mediaType === 'voice' || m.mediaType === 'audio'))) return;

  const stt = resolveSttBackends(loadConfig());
  if (stt.length === 0) return;

  const summary = await attachVoiceTranscripts(service, chatId, messages, stt, {
    maxDurationSeconds: parsePositiveNumber(options.transcribeMax, 60, '--transcribe-max'),
    maxMessages: parsePositiveNumber(options.transcribeLimit, 3, '--transcribe-limit', true),
  });

  // Only a read that actually paid for something sweeps the cache, so the common
  // all-cached read stays a pure set of file reads.
  if (summary.transcribed > 0) pruneTranscriptCache();

  // Progress goes to stderr so `--json` stdout stays machine-readable.
  if (!options.json && (summary.transcribed > 0 || summary.failed > 0)) {
    const parts = [`${summary.transcribed} transcribed`];
    if (summary.cacheHits > 0) parts.push(`${summary.cacheHits} cached`);
    if (summary.empty > 0) parts.push(`${summary.empty} no speech`);
    if (summary.failed > 0) parts.push(`${summary.failed} failed`);
    process.stderr.write(chalk.dim(`Voice: ${parts.join(', ')}\n`));
  }

  // Losing the cache silently means re-paying on every later read, so say so
  // even though the read itself succeeded.
  if (summary.cacheWriteFailures > 0) {
    process.stderr.write(chalk.yellow(
      `Warning: ${summary.cacheWriteFailures} transcript(s) could not be cached; ` +
      `these will be transcribed again next read. Check ${'CLAUDE_TOOLS_STT_CACHE_DIR'} or temp space.\n`
    ));
  }
}

/**
 * Display messages fetched from live Telegram API (original behavior)
 */
function displayLiveMessages(
  messages: TelegramMessage[],
  chatId: string,
  options: { verbose?: boolean; plain?: boolean; json?: boolean }
): void {
  if (options.json) {
    console.log(JSON.stringify(messages, null, 2));
  } else if (options.verbose || options.plain) {
    console.log(chalk.bold(`\n\u{1F4E8} Messages from: ${chatId}\n`));
    for (const msg of messages) {
      const msgData = toMessageData(msg);
      const msgChatId = msg.chatId?.toString();

      const dateStr = formatShortDate(msg.date);
      const messageLink = formatMessageLink(msgChatId, msg.id);
      console.log(
        chalk.blue(messageLink) + ' ' +
        chalk.dim(dateStr) + ' ' +
        chalk.cyan.bold(msg.sender)
      );

      if (msg.replyToId) {
        const replyLink = formatMessageLink(msg.replyToPeerId || msgChatId, msg.replyToId);
        const replyPreview = msg.replyToText
          ? `"${msg.replyToText.replace(/\n/g, ' ').slice(0, 30)}${msg.replyToText.length > 30 ? '...' : ''}"`
          : '';
        console.log(chalk.dim(`  ↳ ${replyLink} (${msg.replyToSender || 'unknown'})${replyPreview ? ' ' + replyPreview : ''}`));
      }

      if (msg.hasMedia && msg.mediaType) {
        const duration = msg.mediaDuration !== undefined ? ` ${Math.round(msg.mediaDuration)}s` : '';
        console.log(chalk.yellow(`  [${msg.mediaType}${duration}]`));
        if (msg.transcript) {
          for (const line of msg.transcript.split('\n')) {
            console.log(chalk.dim(`  > ${line}`));
          }
        }
      }

      const displayText = msgData.formattedText || msg.text;
      if (displayText) {
        for (const line of displayText.split('\n')) {
          console.log(`  ${line}`);
        }
      }

      if (msg.reactions?.length) {
        console.log(chalk.dim(`  ${formatReactions(msg.reactions)}`));
      }

      console.log();
    }
    console.log(chalk.dim(`Total: ${messages.length} messages`));
  } else {
    console.log(`## Messages from: ${chatId}`);
    console.log(`*${messages.length} messages*`);
    console.log('---');
    for (const msg of messages) {
      console.log(formatMessageAsMarkdown(msg));
      console.log('---');
    }
  }
}

/**
 * Display messages from SQLite cache with enriched reply context
 */
function displayCachedMessages(
  messages: SearchResult[],
  chatId: string,
  chatTitle: string,
  replyContext: Map<string, SearchResult | null>,
  options: { verbose?: boolean; plain?: boolean; json?: boolean }
): void {
  // Build a lookup for messages in the current batch + external reply context.
  // This view is single-chat, so a bare id key is unambiguous within the batch.
  const batchMap = new Map<number, SearchResult>();
  for (const msg of messages) {
    batchMap.set(msg.id, msg);
  }

  // Helper: resolve reply target — check batch first, then external context
  // (the external map is keyed per-chat as `${chatId}:${replyToId}`).
  function resolveReply(replyToId: number): SearchResult | null {
    return batchMap.get(replyToId) || replyContext.get(`${chatId}:${replyToId}`) || null;
  }

  if (options.json) {
    const enriched = messages.map(msg => ({
      ...msg,
      replyToSender: msg.replyToId && (!msg.replyToPeerId || msg.replyToPeerId === chatId) ? resolveReply(msg.replyToId)?.sender : undefined,
      replyToText: msg.replyToId && (!msg.replyToPeerId || msg.replyToPeerId === chatId) ? resolveReply(msg.replyToId)?.text : undefined,
    }));
    console.log(JSON.stringify(enriched, null, 2));
    return;
  }

  if (options.verbose || options.plain) {
    console.log(chalk.bold(`\n\u{1F4E8} Messages from: ${chatTitle}\n`));
    for (const msg of messages) {
      const dateStr = formatShortDate(msg.date);
      const messageLink = formatMessageLink(chatId, msg.id);
      console.log(
        chalk.blue(messageLink) + ' ' +
        chalk.dim(dateStr) + ' ' +
        chalk.cyan.bold(msg.sender)
      );

      // Reply context — check batch first, then external context
      if (msg.replyToId) {
        const replyMsg = !msg.replyToPeerId || msg.replyToPeerId === chatId ? resolveReply(msg.replyToId) : null;
        const replyLink = formatMessageLink(msg.replyToPeerId || chatId, msg.replyToId);
        if (replyMsg) {
          const replyPreview = replyMsg.text
            ? `"${replyMsg.text.replace(/\n/g, ' ').slice(0, 50)}${replyMsg.text.length > 50 ? '...' : ''}"`
            : '';
          console.log(chalk.dim(`  ↳ ${replyLink} (${replyMsg.sender})${replyPreview ? ' ' + replyPreview : ''}`));
        } else {
          console.log(chalk.dim(`  ↳ ${replyLink} (not synced)`));
        }
      }

      if (msg.hasMedia && msg.mediaType) {
        console.log(chalk.yellow(`  [${msg.mediaType}]`));
      }

      if (msg.text) {
        for (const line of msg.text.split('\n')) {
          console.log(`  ${line}`);
        }
      }

      if (msg.reactions?.length) {
        console.log(chalk.dim(`  ${formatReactions(msg.reactions)}`));
      }

      console.log();
    }
    console.log(chalk.dim(`Total: ${messages.length} messages`));
  } else {
    // Default: Markdown output
    console.log(`## Messages from: ${chatTitle}`);
    console.log(`*${messages.length} messages*`);
    console.log('---');
    for (const msg of messages) {
      const date = formatShortDate(msg.date);
      const messageLink = formatMessageLink(chatId, msg.id);

      // Build reply context line
      let replyLine = '';
      if (msg.replyToId) {
        const replyMsg = !msg.replyToPeerId || msg.replyToPeerId === chatId ? resolveReply(msg.replyToId) : null;
        if (replyMsg) {
          replyLine = `\n${formatReplyVerbose(msg.replyToId, replyMsg.sender, replyMsg.text, msg.replyToPeerId || chatId)}\n`;
        } else {
          replyLine = `\n${formatReplyVerbose(msg.replyToId, null, null, msg.replyToPeerId || chatId)}\n`;
        }
      }

      const mediaIndicator = msg.hasMedia && msg.mediaType ? `[${msg.mediaType}]` : '';
      const textWithMedia = mediaIndicator
        ? (msg.text ? `${mediaIndicator}\n\n${msg.text}` : mediaIndicator)
        : msg.text;

      const reactionsLine = msg.reactions?.length ? `\n${formatReactions(msg.reactions)}` : '';

      console.log(`### ${messageLink} | ${msg.sender}
*${date}*${replyLine}

${textWithMedia}${reactionsLine}`);
      console.log('---');
    }
  }
}

function ensureTelegramConfig() {
  const config = loadConfig();
  if (!config.telegram) {
    console.error(chalk.red('Telegram not configured.'));
    console.log('\nTo configure Telegram:');
    console.log('  1. Get API credentials from https://my.telegram.org/apps');
    console.log('  2. Run: claude-tools telegram auth');
    console.log('  3. Or set environment variables: TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION_STRING');
    process.exit(1);
  }
  return config.telegram;
}

export function registerTelegramCommands(program: Command): void {
  const telegram = program
    .command('telegram')
    .description('Telegram messaging commands')
    .addHelpText('after', `
${chalk.yellow('Important:')} Telegram message IDs are unique ${chalk.bold('per chat')}, not globally.
The same numeric ID exists in many chats. Commands that take a message ID
(read-around, reply, edit, react, unreact) need the chat too — pass --chat or
the <chat> argument so the right message is resolved.
`);

  // Auth command
  telegram
    .command('auth')
    .description('Generate a new Telegram session (interactive)')
    .action(async () => {
      // Run the generator rather than printing instructions to run this command again. The compiled
      // script ships in dist/, so this works from the published package and from a checkout alike.
      await import('../../scripts/generate-telegram-session.js');
    });

  // List chats command
  telegram
    .command('chats [filter]')
    .description('List your Telegram chats')
    .option('--limit <n>', 'Number of chats to show', '20')
    .option('--verbose', 'Show detailed table format')
    .action(async (filter: string | undefined, options: { limit: string; verbose?: boolean }) => {
      const config = ensureTelegramConfig();
      const service = new TelegramService(config);

      try {
        await service.connect();

        // If filter provided, use contacts.Search for cross-literal matching
        if (filter) {
          const results = await service.searchChats(filter, parseInt(options.limit, 10));

          if (results.length === 0) {
            console.log(chalk.dim(`No chats found for "${filter}"`));
          } else {
            console.log(chalk.bold(`💬 Chats matching "${filter}"`));
            for (const chat of results) {
              const icon = chat.type === 'user' ? '👤' : chat.type === 'channel' ? '📢' : '👥';
              console.log(`${icon} ${chalk.cyan(chat.title)} ${chalk.dim(`#${chat.id}`)}`);
            }
          }
        } else {
          const dialogs = await service.getDialogs(parseInt(options.limit, 10));

          if (options.verbose) {
            console.log(chalk.bold('\n💬 Your Chats\n'));
            console.log(chalk.dim('ID'.padEnd(15) + 'Title'.padEnd(35) + 'Unread'));
            console.log(chalk.dim('─'.repeat(60)));
            for (const dialog of dialogs) {
              const unread = dialog.unreadCount > 0 ? chalk.yellow(dialog.unreadCount.toString()) : chalk.dim('0');
              console.log(`${String(dialog.id).slice(0, 14).padEnd(15)}${dialog.title.slice(0, 33).padEnd(35)}${unread}`);
            }
            console.log(chalk.dim('\nUse: claude-tools telegram read <chat-id>'));
          } else {
            console.log(chalk.bold('💬 Chats'));
            for (const dialog of dialogs) {
              const unread = dialog.unreadCount > 0 ? chalk.yellow(`(${dialog.unreadCount})`) : '';
              const icon = dialog.unreadCount > 0 ? '📩' : '📭';
              console.log(`${icon} ${chalk.cyan(dialog.title.slice(0, 35))} ${unread} ${chalk.dim(`#${dialog.id}`)}`);
            }
          }
        }

        await service.disconnect();
      } catch (err) {
        console.error(chalk.red('❌ Error:'), (err as Error).message);
        process.exit(1);
      }
    });

  // Read messages command
  telegram
    .command('read [chat]')
    .description('Read messages from a chat (Markdown output by default)')
    .option('--limit <n>', 'Number of messages', '20')
    .option('--verbose', 'Show detailed format with full messages (plain text)')
    .option('--plain', 'Output as plain text (no markdown)')
    .option('--json', 'Output as JSON')
    .option('--use-cache', 'Read from local cache (sync + SQLite + reply enrichment)')
    .option('--no-transcribe', 'Do not auto-transcribe short voice messages')
    .option('--transcribe-max <seconds>', 'Longest voice message to auto-transcribe', '60')
    .option('--transcribe-limit <n>', 'Most voice messages to transcribe per read', '3')
    .addHelpText('after', `
${chalk.yellow('Chat Identification:')}
  ${chalk.cyan('me')}              Saved Messages (default)
  ${chalk.cyan('@username')}       By username
  ${chalk.cyan('Chat Title')}      By chat title/name
  ${chalk.cyan('-1001234...')}     By numeric chat ID

${chalk.yellow('Examples:')}
  ${chalk.dim('# Read your saved messages (markdown output)')}
  claude-tools telegram read

  ${chalk.dim('# Read from a specific user')}
  claude-tools telegram read @someuser

  ${chalk.dim('# Read from a group by name')}
  claude-tools telegram read "My Group"

  ${chalk.dim('# Read as plain text')}
  claude-tools telegram read "My Group" --plain

  ${chalk.dim('# Read last 50 messages as JSON from Telegram')}
  claude-tools telegram read @channel --limit 50 --json

  ${chalk.dim('# Use the local cache instead of reading from Telegram')}
  claude-tools telegram read "My Group" --use-cache
`)
    .action(async (chat: string | undefined, options: { limit: string; verbose?: boolean; plain?: boolean; json?: boolean; useCache?: boolean; transcribe?: boolean; transcribeMax?: string; transcribeLimit?: string }) => {
      const config = ensureTelegramConfig();
      const service = new TelegramService(config);
      const chatId = chat || config.defaultChat || 'me';

      try {
        await service.connect();
        const selectedPeer = await service.resolveChat(chatId);

        if (!options.useCache) {
          // Live API mode: default behavior
          const messages = await service.getMessages(selectedPeer, parseInt(options.limit, 10));

          // Fetch detailed reaction info (who reacted) for messages with reactions
          for (const msg of messages) {
            if (msg.reactions?.length) {
              const detailedReactions = await service.getMessageReactionsList(selectedPeer, msg.id);
              if (detailedReactions.length > 0) {
                msg.reactions = detailedReactions;
              }
            }
          }

          await maybeAttachTranscripts(service, String(selectedPeer.id), messages, options);

          displayLiveMessages(messages, String(selectedPeer.id), options);
          await service.disconnect();
          return;
        }

        // Cache-based mode: sync + read from SQLite + resolve reply chains
        const client = (service as any).client;

        // Ensure DB schema is up to date
        ensureReactionsColumn();
        ensureEntitiesColumn();

        // Keep the verified peer across sync and reply retrieval; selectors may be reassigned.
        let resolvedChatId: string | null = String(selectedPeer.id);
        let chatTitle = selectedPeer.title;

        // Check if cache needs sync
        const syncState = resolvedChatId ? getSyncState(resolvedChatId) : null;
        const needsSync = !syncState || !syncState.last_sync_at ||
          (Date.now() - syncState.last_sync_at * 1000) > 60 * 60 * 1000; // 1 hour

        if (needsSync) {
          process.stderr.write(chalk.dim('Syncing... '));
          const result = await syncChat(client, selectedPeer, {
            months: 1,
            onProgress: (count, oldestDate) => {
              process.stderr.write(`\r${chalk.dim(`Syncing... ${count} messages`)}`);
            },
          });
          // Use the resolved chatId from sync (handles "me", "@username", etc.)
          resolvedChatId = result.chatId;
          chatTitle = result.chatTitle;
          if (result.earlyTerminated) {
            console.error(`\r${chalk.dim(`Synced ${result.messagesAdded} new messages (reached cached region)`)}`);
          } else {
            console.error(`\r${chalk.dim(`Synced ${result.messagesAdded} new messages`)}`);
          }
        } else if (syncState) {
          chatTitle = syncState.chat_title || chatId;
        }

        if (!resolvedChatId) {
          console.error(chalk.red('Chat not found in cache. Try running: telegram sync'), chatId);
          await service.disconnect();
          return;
        }

        // Read from SQLite cache
        const messages = getRecentMessages(resolvedChatId, parseInt(options.limit, 10));

        // Resolve reply chains: find missing reply targets and fetch from SQLite
        const replyContext = enrichReplyContextFromDb(messages);

        // For reply targets NOT in SQLite, fetch from Telegram API on-demand.
        // All targets here belong to resolvedChatId (replies are same-chat).
        const missingReplyTargets = findMissingReplyTargets(messages);
        for (const { replyToId: replyId } of missingReplyTargets) {
          const key = `${resolvedChatId}:${replyId}`;
          if (!replyContext.get(key)) {
            // Not in SQLite — fetch from API
            const apiMsg = await service.getMessageById(selectedPeer, replyId);
            if (apiMsg) {
              if(String(apiMsg.chatId) !== resolvedChatId) throw new Error('Reply message belongs to another chat');
              // Cache in SQLite for future use
              const { upsertMessageFromApi } = await import('../../services/telegram-sync.js');
              upsertMessageFromApi({
                id: apiMsg.id,
                chatId: resolvedChatId,
                chatTitle,
                sender: apiMsg.sender,
                text: apiMsg.text,
                date: Math.floor(apiMsg.date.getTime() / 1000),
                replyToId: apiMsg.replyToId || null,
                replyToPeerId: apiMsg.replyToPeerId,
                entities: apiMsg.entities,
                reactions: apiMsg.reactions,
                hasMedia: !!apiMsg.hasMedia,
                mediaType: apiMsg.mediaType || null,
              });
              // Add to context map as SearchResult
              replyContext.set(key, {
                id: apiMsg.id,
                chatId: resolvedChatId,
                chatTitle,
                sender: apiMsg.sender,
                text: apiMsg.text,
                date: apiMsg.date,
                replyToId: apiMsg.replyToId || null,
                replyToPeerId: apiMsg.replyToPeerId,
                entities: apiMsg.entities,
                reactions: apiMsg.reactions,
                hasMedia: !!apiMsg.hasMedia,
                mediaType: apiMsg.mediaType || null,
              });
            }
          }
        }

        // Display messages with enriched reply context
        displayCachedMessages(messages, resolvedChatId, chatTitle, replyContext, options);

        await service.disconnect();
      } catch (err) {
        console.error(chalk.red('❌ Error:'), (err as Error).message);
        process.exit(1);
      }
    });

  // Send message command
  telegram
    .command('send <chat> <message>')
    .description('Send a message to a chat (use "-" to read from stdin)')
    .addHelpText('after', `
${chalk.yellow('Examples:')}
  ${chalk.dim('# Send to saved messages')}
  claude-tools telegram send me "Hello!"

  ${chalk.dim('# Send to a user')}
  claude-tools telegram send @username "Hey there"

  ${chalk.dim('# Send to a group')}
  claude-tools telegram send "My Group" "Meeting in 5 minutes"

  ${chalk.dim('# Send using an alias')}
  claude-tools telegram send @Alex "Hey, check this out"

  ${chalk.dim('# Send multiline text from stdin')}
  cat message.txt | claude-tools telegram send "Team Dev Chat" -

  ${chalk.dim('# Send without sound (outside working hours)')}
  claude-tools telegram send "Team Dev Chat" "Deploy finished" --mute

  ${chalk.dim('# Messages are rich markdown: **bold** titles, - bullets, [named links](url), tables, headings')}
  cat report.md | claude-tools telegram send "Team Dev Chat" -

  ${chalk.dim('# The old MarkdownV2 path, without rich formatting')}
  claude-tools telegram send me "Plain note" --md2

  ${chalk.dim('# A time every reader sees in their own time zone (bare times are Tashkent)')}
  claude-tools telegram send "Team Dev Chat" "Deploy at {{time:2026-09-26 18:00}}"

${chalk.yellow('Times:')} {{time:<when>[|<format>][|<label>]}} shows <when> in each reader's time zone.
  <when>    2026-09-26 18:00 (Tashkent), 2026-09-26T13:00Z, or unix seconds
  <format>  r (relative) or w?[dD]?[tT]? - weekday, short/long date, short/long time (default wDt)
  <label>   fallback text for old clients (default: the Tashkent time)
${formatHelpSection()}`)
    .option('--mute', 'Send without sound/notification (message still delivered)')
    .option('--rich', RICH_HELP)
    .option('--md2', MD2_HELP)
    .option(FORMAT_OK_FLAG, FORMAT_OK_HELP)
    .action(async (chat: string, message: string, options: { mute?: boolean; rich?: boolean; md2?: boolean; formatOk?: string }) => {
      try {
        const rich = accountSendsRich(options);
        const resolvedMessage = await resolveMessageArg(message);
        // Checked before the config and the connection: a refused message never reaches Telegram.
        const note = enforceFormat(resolvedMessage, options.formatOk, !rich);
        const config = ensureTelegramConfig();
        const service = new TelegramService(config);
        await service.connect();
        const result = rich
          ? await service.sendRichMessage(chat, resolvedMessage, undefined, options.mute === true)
          : await service.sendMessage(chat, resolvedMessage, undefined, 'md2', options.mute === true);
        console.log(chalk.green(sentLabel('Sent', { mute: options.mute, rich }) + note), chalk.dim(sentLink(result)));
        await service.disconnect();
      } catch (err) {
        console.error(chalk.red('❌ Error:'), (err as Error).message);
        process.exit(1);
      }
    });

  // Upload file command
  telegram
    .command('upload <chat> <file>')
    .description('Upload a file to a chat')
    .option('--caption <text>', 'Caption for the file')
    .option('--reply <msgId>', 'Message ID to reply to')
    .option('--mute', 'Send without sound/notification (file still delivered)')
    .addHelpText('after', `
${chalk.yellow('Examples:')}
  ${chalk.dim('# Upload a file to saved messages')}
  claude-tools telegram upload me /path/to/file.pdf

  ${chalk.dim('# Upload with caption')}
  claude-tools telegram upload "My Group" /path/to/doc.pdf --caption "Here is the document"

  ${chalk.dim('# Upload as reply to a message')}
  claude-tools telegram upload "Team Dev Chat" ./app.apk --reply 12345 --caption "New build"

  ${chalk.dim('# Upload without sound (outside working hours)')}
  claude-tools telegram upload "Team Dev Chat" ./report.md --mute
`)
    .action(async (chat: string, file: string, options: { caption?: string; reply?: string; mute?: boolean }) => {
      const config = ensureTelegramConfig();
      const service = new TelegramService(config);

      // Check if file exists
      const { existsSync, statSync } = await import('fs');
      const { resolve, basename } = await import('path');

      const filePath = resolve(file);
      if (!existsSync(filePath)) {
        console.error(chalk.red('❌ File not found:'), file);
        process.exit(1);
      }

      const stats = statSync(filePath);
      const fileName = basename(filePath);
      const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(1);

      console.log(chalk.dim(`Uploading ${fileName} (${fileSizeMB}MB)...`));

      try {
        await service.connect();

        let lastProgress = 0;
        const result = await service.sendFile(
          chat,
          filePath,
          options.caption,
          options.reply ? parseMessageId(options.reply) : undefined,
          (progress) => {
            const percent = Math.floor(progress * 100);
            if (percent >= lastProgress + 10) {
              process.stdout.write(`\r${chalk.dim(`Uploading... ${percent}%`)}`);
              lastProgress = percent;
            }
          },
          'md2',
          options.mute === true
        );

        const link = formatMessageLink(result.chatId, result.messageId);
        console.log(`\r${chalk.green(options.mute ? '✅ Uploaded (muted)' : '✅ Uploaded')} ${fileName} ${chalk.dim(link)}`);
        await service.disconnect();
      } catch (err) {
        console.error(chalk.red('\n❌ Error:'), (err as Error).message);
        process.exit(1);
      }
    });

  // Edit message command
  telegram
    .command('edit <chat> <messageId> <message>')
    .description('Edit a message you sent (use "-" to read from stdin)')
    .addHelpText('after', `
${chalk.yellow('Examples:')}
  ${chalk.dim('# Edit a message in saved messages')}
  claude-tools telegram edit me 12345 "Corrected text"

  ${chalk.dim('# Edit a message in a group')}
  claude-tools telegram edit "Team Dev Chat" 102379 "Fixed typo here"

  ${chalk.dim('# Edit with multiline text from stdin')}
  cat message.txt | claude-tools telegram edit "Team Dev Chat" 102379 -

  ${chalk.dim('# Replace a message with the old MarkdownV2 text instead of rich markdown')}
  claude-tools telegram edit me 12345 "Plain note" --md2

${chalk.yellow('Note:')} You can only edit your own messages, and there may be a time limit (~48h) in some chats.
${formatHelpSection()}`)
    .option('--rich', RICH_HELP)
    .option('--md2', MD2_HELP)
    .option(FORMAT_OK_FLAG, FORMAT_OK_HELP)
    .action(async (chat: string, messageId: string, message: string, options: { rich?: boolean; md2?: boolean; formatOk?: string }) => {
      try {
        const rich = accountSendsRich(options);
        const resolvedMessage = await resolveMessageArg(message);
        const note = enforceFormat(resolvedMessage, options.formatOk, !rich);
        const config = ensureTelegramConfig();
        const service = new TelegramService(config);
        await service.connect();
        if (rich) {
          const { caption } = await service.editRichMessage(chat, parseMessageId(messageId), resolvedMessage);
          if (caption) {
            console.error(chalk.yellow('Note: that message has media, so its caption was edited with standard markdown; tables and headings have no caption form.'));
          }
        } else {
          await service.editMessage(chat, parseMessageId(messageId), resolvedMessage);
        }
        console.log(chalk.green(`✅ Edited${note}`), chalk.dim(`#${messageId}`));
        await service.disconnect();
      } catch (err) {
        console.error(chalk.red('❌ Error:'), (err as Error).message);
        process.exit(1);
      }
    });

  // Delete command: prune your own messages (noise cleanup after a result lands)
  telegram
    .command('delete <chat> <messageIds...>')
    .description('Delete one or more of your own messages (noise cleanup: prune progress after the result)')
    .addHelpText('after', `
  ${chalk.dim('# Delete a progress message once the result is posted')}
  claude-tools telegram delete "Team Dev Chat" 102379

  ${chalk.dim('# Delete several at once')}
  claude-tools telegram delete "Team Dev Chat" 102379 102380 102381

${chalk.yellow('Note:')} You can only delete your own messages, and a chat may cap this at ~48h. It removes them for everyone.
`)
    .action(async (chat: string, messageIds: string[], _options: unknown) => {
      const config = ensureTelegramConfig();
      const service = new TelegramService(config);

      try {
        const ids = messageIds.map((raw) => parseMessageId(raw));
        await service.connect();
        await service.deleteMessages(chat, ids);
        console.log(chalk.green(`\u2705 Deleted ${ids.length}`), chalk.dim(ids.map((i) => `#${i}`).join(' ')));
        await service.disconnect();
      } catch (err) {
        console.error(chalk.red('\u274c Error:'), (err as Error).message);
        process.exit(1);
      }
    });

  // Pin / unpin: keep a living ledger at the top of a chat
  telegram
    .command('pin <chat> <messageId>')
    .description('Pin one of your messages (e.g. a living ledger) to the top of a chat')
    .option('--notify', 'Pin loudly (send the pin notification); default is quiet')
    .action(async (chat: string, messageId: string, options: { notify?: boolean }) => {
      const config = ensureTelegramConfig();
      const service = new TelegramService(config);
      try {
        await service.connect();
        await service.pinMessage(chat, parseMessageId(messageId), options.notify === true);
        console.log(chalk.green('\u2705 Pinned'), chalk.dim(`#${messageId}`));
        await service.disconnect();
      } catch (err) {
        console.error(chalk.red('\u274c Error:'), (err as Error).message);
        process.exit(1);
      }
    });

  telegram
    .command('pins <chat>')
    .description('List the pinned messages of a chat: across every forum topic, or one with --topic')
    .option('--topic <id>', 'Only this forum topic')
    .option('--limit <n>', 'At most this many', '100')
    .option('--json', 'Print JSON')
    .action(async (chat: string, options: { topic?: string; limit: string; json?: boolean }) => {
      const config = ensureTelegramConfig();
      const service = new TelegramService(config);
      try {
        const topic = options.topic === undefined ? undefined : parseMessageId(options.topic);
        const limit = Number(options.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('--limit must be between 1 and 100');
        await service.connect();
        const { pins, truncated } = await service.listPins(chat, { ...(topic === undefined ? {} : { topic }), limit });
        await service.disconnect();
        if (options.json) console.log(JSON.stringify({ chat, ...(topic === undefined ? {} : { topic }), truncated, pins: sortPins(pins) }, null, 2));
        else for (const line of renderPins(chat, pins, { ...(topic === undefined ? {} : { topic }), truncated })) console.log(line);
      } catch (err) {
        console.error(chalk.red('\u274c Error:'), (err as Error).message);
        process.exit(1);
      }
    });

  telegram
    .command('unpin <chat> [messageId]')
    .description('Unpin one message. With no id, every pin of the chat (or of --topic) - shown first, and done only with --all')
    .option('--all', 'Really unpin everything listed (needed when no message id is given)')
    .option('--topic <id>', 'With no message id: only this forum topic\'s pins')
    .action(async (chat: string, messageId: string | undefined, options: { all?: boolean; topic?: string }) => {
      const config = ensureTelegramConfig();
      const service = new TelegramService(config);
      try {
        const topic = options.topic === undefined ? undefined : parseMessageId(options.topic);
        if (messageId !== undefined && topic !== undefined) throw new Error('--topic is for unpinning everything in a topic; one message is unpinned by its id alone');
        await service.connect();
        if (messageId !== undefined) {
          await service.unpinMessage(chat, parseMessageId(messageId));
          console.log(chalk.green('\u2705 Unpinned'), chalk.dim(`#${messageId}`));
          await service.disconnect();
          return;
        }
        // A bulk unpin with nothing to look at first is how pins get lost: show the target, and act only on --all.
        const { pins, truncated } = await service.listPins(chat, { ...(topic === undefined ? {} : { topic }), limit: 100 });
        // Said BEFORE the list as well as after it: a list printed by an unpin command reads like a report of what
        // it just removed, and here, without --all, it is the opposite.
        if (pins.length > 0 && options.all !== true) console.log(chalk.yellow('Nothing has been unpinned. This is what --all would unpin:'));
        for (const line of renderPins(chat, pins, { ...(topic === undefined ? {} : { topic }), truncated })) console.log(line);
        if (pins.length === 0) {
          await service.disconnect();
          return;
        }
        if (options.all !== true) {
          await service.disconnect();
          console.log(chalk.yellow(`Nothing was unpinned. Run again with --all to unpin ${truncated ? 'all of these and more' : pins.length === 1 ? 'it' : `all ${pins.length}`}.`));
          process.exitCode = 1;
          return;
        }
        await service.unpinMessage(chat, undefined, topic);
        await service.disconnect();
        console.log(chalk.green('\u2705 Unpinned'), chalk.dim(topic === undefined ? '(all, whole chat)' : `(all in topic ${topic})`));
      } catch (err) {
        console.error(chalk.red('\u274c Error:'), (err as Error).message);
        process.exit(1);
      }
    });

  // Sync command (from sync.ts)
  registerSyncCommand(telegram);

  // Read-around command (from read-around.ts)
  registerReadAroundCommand(telegram);

  // Embed command (from embed.ts)
  registerEmbedCommand(telegram);

  // Search messages command (uses local SQLite database)
  telegram
    .command('search <query>')
    .description('Search messages (auto-picks best method)')
    .option('--chat <chat>', 'Limit search to specific chat (name or ID)')
    .option('--keyword', 'Force keyword search (FTS)')
    .option('--fuzzy', 'Enable fuzzy/prefix matching (keyword mode)')
    .option('--semantic', 'Force semantic search')
    .option('--from <date>', 'Start date (YYYY-MM-DD)')
    .option('--page <n>', 'Page number', '1')
    .option('--limit <n>', 'Results per page', '20')
    .option('--verbose', 'Show detailed format with full messages')
    .option('--json', 'Output as JSON')
    .addHelpText('after', `
${chalk.yellow('Examples:')}
  ${chalk.dim('# Smart search (uses semantic if available, else keyword)')}
  claude-tools telegram search "deployment issues"

  ${chalk.dim('# Search in specific chat')}
  claude-tools telegram search "meeting" --chat "Сохраненные сообщения"

  ${chalk.dim('# Force keyword search')}
  claude-tools telegram search "exact phrase" --keyword

  ${chalk.dim('# Fuzzy search (typo-tolerant)')}
  claude-tools telegram search "deploymnt" --fuzzy

${chalk.yellow('Note:')} Run "telegram sync <chat>" first to index messages.
`)
    .action(async (query: string, options: {
      chat?: string;
      keyword?: boolean;
      fuzzy?: boolean;
      semantic?: boolean;
      from?: string;
      page: string;
      limit: string;
      verbose?: boolean;
      json?: boolean;
    }) => {
      try {
        // Check if database has messages
        if (!hasMessages()) {
          throw new Error('No messages synced yet. Run: telegram sync <explicit-chat>');
        }

        // Resolve chat name to ID if provided
        let chatId: string | undefined;
        if (options.chat) {
          chatId = resolveChatId(options.chat) || undefined;
          if (!chatId) {
            throw new Error(`Chat not found: "${options.chat}". Use telegram sync --status`);
          }
        }

        const limit = parseInt(options.limit, 10);

        // Determine search mode: semantic, keyword, or auto
        let useSemanticSearch = false;

        if (options.semantic) {
          // User explicitly requested semantic
          const status = await isSemanticSearchAvailable();
          if (!status.available) {
            console.error(chalk.yellow('Semantic search not available:'), status.reason);
            console.error(chalk.dim('Falling back to keyword search...'));
          } else {
            useSemanticSearch = true;
          }
        } else if (options.keyword || options.fuzzy) {
          // User explicitly requested keyword/fuzzy
          useSemanticSearch = false;
        } else {
          // Auto mode: try semantic first if available
          const status = await isSemanticSearchAvailable();
          useSemanticSearch = status.available;
        }

        // Execute search
        if (useSemanticSearch) {
          const results = await semanticSearch(query, limit, chatId);

          if (options.json) {
            console.log(JSON.stringify(results, null, 2));
          } else {
            printSemanticResults(query, results, options.verbose);
            showTelegramSyncWarningIfNeeded();
          }
        } else {
          // Keyword/FTS search
          const page = parseInt(options.page, 10);
          const resultsPerPage = parseInt(options.limit, 10);
          const offset = (page - 1) * resultsPerPage;

          const response = searchMessages(query, {
            chatId,
            fuzzy: options.fuzzy,
            fromDate: options.from ? new Date(options.from) : undefined,
            limit: resultsPerPage,
            offset,
          });

          if (options.json) {
            console.log(JSON.stringify(response, null, 2));
          } else if (options.verbose) {
            printVerboseResults(query, response);
            showTelegramSyncWarningIfNeeded();
          } else {
            printCompactResults(query, response, options.fuzzy);
            showTelegramSyncWarningIfNeeded();
          }
        }
      } catch (err) {
        console.error(chalk.red('❌ Error:'), (err as Error).message);
        process.exit(1);
      }
    });

  // React to message command
  telegram
    .command('react <chat> <messageId> <emoji>')
    .description('Add a reaction to a message')
    .addHelpText('after', `
${chalk.yellow('Examples:')}
  ${chalk.dim('# React with thumbs up to message #123 in saved messages')}
  claude-tools telegram react me 123 👍

  ${chalk.dim('# React with heart to a message in a group')}
  claude-tools telegram react "My Group" 456 ❤️

  ${chalk.dim('# Common reactions: 👍 👎 ❤️ 🔥 🎉 😢 😮 💯')}
`)
    .action(async (chat: string, messageId: string, emoji: string) => {
      const config = ensureTelegramConfig();
      const service = new TelegramService(config);

      try {
        await service.connect();
        await service.addReaction(chat, parseMessageId(messageId), emoji);
        console.log(chalk.green('✅ Reacted'), `${emoji} to message #${messageId}`);
        await service.disconnect();
      } catch (err) {
        console.error(chalk.red('❌ Error:'), (err as Error).message);
        process.exit(1);
      }
    });

  // Remove reaction command
  telegram
    .command('unreact <chat> <messageId>')
    .description('Remove your reaction from a message')
    .action(async (chat: string, messageId: string) => {
      const config = ensureTelegramConfig();
      const service = new TelegramService(config);

      try {
        await service.connect();
        await service.removeReaction(chat, parseMessageId(messageId));
        console.log(chalk.green('✅ Removed reaction from message'), `#${messageId}`);
        await service.disconnect();
      } catch (err) {
        console.error(chalk.red('❌ Error:'), (err as Error).message);
        process.exit(1);
      }
    });

  telegram
    .command('buttons <chat> <messageId>')
    .description("Show a message's inline keyboard — where some bots put their actual content")
    .option('--json', 'Print the keyboard as JSON')
    .action(async (chat: string, messageId: string, options: { json?: boolean }) => {
      const config = ensureTelegramConfig();
      const service = new TelegramService(config);

      try {
        await service.connect();
        const keyboard = await service.getInlineKeyboard(chat, parseMessageId(messageId));
        await service.disconnect();
        if (keyboard === null) {
          // Not an error, and not an empty list either: "this message has no buttons" is a real answer.
          console.log(chalk.dim(`#${messageId} has no inline keyboard`));
          return;
        }
        if (options.json) {
          console.log(JSON.stringify(keyboard));
          return;
        }
        const total = keyboard.rows.reduce((sum, row) => sum + row.length, 0);
        console.log(chalk.bold(`${total} button${total === 1 ? '' : 's'} in ${keyboard.rows.length} row${keyboard.rows.length === 1 ? '' : 's'}`));
        keyboard.rows.forEach((row, r) => {
          row.forEach((button, c) => {
            const kind = button.kind.replace(/^KeyboardButton/, '') || 'plain';
            const payload = button.payload === null ? '' : chalk.dim(`  ${payload_label(kind)}${button.payload}`);
            console.log(`  [${r},${c}] ${button.text}${chalk.dim(` (${kind})`)}${payload}`);
          });
        });
      } catch (err) {
        console.error(chalk.red('❌ Error:'), (err as Error).message);
        process.exit(1);
      }
    });

  telegram
    .command('press <chat> <messageId> <row> <column>')
    .description("Press an inline button by its [row,column] from `telegram buttons`")
    .action(async (chat: string, messageId: string, row: string, column: string) => {
      const config = ensureTelegramConfig();
      const service = new TelegramService(config);

      try {
        await service.connect();
        const result = await service.pressInlineButton(chat, parseMessageId(messageId), Number(row), Number(column));
        console.log(chalk.green('✅ Pressed'), result.pressed);
        if (result.answer) console.log(chalk.dim(`  bot answered: ${result.answer}`));
        // The usual effect is an EDIT of the same message, not a reply, so say where to look next
        // rather than leaving the caller to conclude nothing happened.
        console.log(chalk.dim(`  the bot usually edits #${messageId} in place — re-read its buttons to see the result`));
        await service.disconnect();
      } catch (err) {
        console.error(chalk.red('❌ Error:'), (err as Error).message);
        process.exit(1);
      }
    });

  // Unread messages command (from unread.ts)
  registerUnreadCommand(telegram);

  // Quick reply command (from reply.ts)
  registerReplyCommand(telegram);

  // Watch chats for new/edited messages (Monitor tool)
  registerWatchCommand(telegram);

  // Mark as read command (from mark-read.ts)
  registerMarkReadCommand(telegram);

  // Cluster commands (from clusters.ts)
  registerClustersCommand(telegram);

  // Cluster search command (from clusters.ts)
  registerClustersSearchCommand(telegram);

  // Clean command (from clean.ts)
  registerCleanCommand(telegram);

  // People/alias commands (from people.ts)
  registerPeopleCommands(telegram);

  // Contacts export command (from contacts.ts)
  registerContactsCommand(telegram);

  // Prune no-chat contacts (from prune-contacts.ts)
  registerPruneContactsCommand(telegram);

  // Media commands (from media.ts)
  registerMediaCommands(telegram);

  // Export day command (from export-day.ts)
  registerExportDayCommand(telegram);

  // Export range command (live JSON export for downstream ingestion)
  registerExportRangeCommand(telegram);

  // Summarize day command (from summarize-day.ts)
  registerSummarizeDayCommand(telegram);
}

/**
 * Convert SearchResult to MessageData for shared formatting
 */
export function searchResultToMessageData(msg: SearchResult): MessageData {
  // Get reply context from database if available (reply target is same-chat)
  const replyMsg = msg.replyToId && (!msg.replyToPeerId || msg.replyToPeerId === msg.chatId) ? getMessage(msg.chatId, msg.replyToId) : null;

  return {
    id: msg.id,
    chatId: msg.chatId?.toString(),
    sender: msg.sender,
    text: msg.text,
    date: msg.date,
    chatTitle: msg.chatTitle,
    hasMedia: msg.hasMedia,
    mediaType: msg.mediaType,
    reactions: msg.reactions,
    replyToId: msg.replyToId,
    replyToChatId: msg.replyToPeerId,
    replyToSender: replyMsg?.sender,
    replyToText: replyMsg?.text,
  };
}

/**
 * Print verbose search results
 */
function printVerboseResults(query: string, response: SearchResponse): void {
  console.log(chalk.bold(`\n🔍 Search results for: "${query}"\n`));

  if (response.results.length === 0) {
    console.log(chalk.dim('No messages found'));
    return;
  }

  for (const msg of response.results) {
    const msgData = searchResultToMessageData(msg);
    const lines = formatMessageVerbose(msgData, {
      showChatName: true,
      showClusterId: msg.clusterId,
    });

    // Apply colors and highlight query in output
    // Header line
    console.log(applyVerboseHeaderColors(lines[0]));

    // Remaining lines
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().startsWith('↳')) {
        console.log(chalk.dim(line));
      } else if (line.trim().startsWith('[') && !line.includes('×')) {
        // Media or cluster indicator
        console.log(chalk.dim(line));
      } else if (line.trim().startsWith('[') && line.includes('×')) {
        // Reactions
        console.log(chalk.dim(line));
      } else {
        // Text - highlight query terms
        console.log(highlightQuery(line, query));
      }
    }
    console.log();
  }

  console.log(chalk.dim(`Page ${response.page}/${response.totalPages} (${response.totalCount} total)`));
  if (response.page < response.totalPages) {
    console.log(chalk.dim(`Use --page ${response.page + 1} for more results`));
  }
}

/**
 * Apply colors to verbose header line
 */
function applyVerboseHeaderColors(header: string): string {
  // Header format: #id [cluster:X] Dec 22 14:30 [Chat] Sender
  const parts = header.split(' ');
  const colored: string[] = [];

  for (const part of parts) {
    if (part.startsWith('#')) {
      colored.push(chalk.dim(part));
    } else if (part.startsWith('[cluster:')) {
      colored.push(chalk.magenta(part));
    } else if (part.startsWith('[') && part.endsWith(']')) {
      colored.push(chalk.dim(part));
    } else if (/^[A-Z][a-z]{2}$/.test(part) || /^\d{1,2}$/.test(part) || /^\d{2}:\d{2}$/.test(part)) {
      // Date/time parts
      colored.push(chalk.dim(part));
    } else {
      // Sender name
      colored.push(chalk.cyan(part));
    }
  }

  return colored.join(' ');
}

/**
 * Get reply context for a message (fetches the replied-to message text)
 */
function getReplyContext(msg: SearchResult): string | null {
  if (!msg.replyToId || (msg.replyToPeerId && msg.replyToPeerId !== msg.chatId)) return null;

  // Reply target is in the same chat as the replying message.
  const replyMsg = getMessage(msg.chatId, msg.replyToId);
  if (!replyMsg || !replyMsg.text) return null;

  // Get first 50 chars of reply, clean up newlines
  const replyText = replyMsg.text.replace(/\n/g, ' ').slice(0, 50);
  return replyText + (replyMsg.text.length > 50 ? '…' : '');
}

/**
 * Print compact search results
 */
function printCompactResults(query: string, response: SearchResponse, fuzzy?: boolean): void {
  const modeLabel = fuzzy ? 'fuzzy' : 'keyword';
  console.log(chalk.bold(`🔍 "${query}"`) + chalk.dim(` (${response.totalCount} ${modeLabel} matches, page ${response.page}/${response.totalPages})`));

  if (response.results.length === 0) {
    console.log(chalk.dim('No results'));
    return;
  }

  for (const msg of response.results) {
    const msgData = searchResultToMessageData(msg);
    const formatted = formatMessageCompact(msgData, {
      showChatName: true,
      showClusterId: msg.clusterId,
    });

    // Apply colors and highlighting to compact format
    // Format: #id [cluster:X] Dec 22 14:30 [Chat] Sender: [media] text... ↳ "reply" [reactions]
    const colored = applyCompactColors(formatted, query);
    console.log(colored);
  }

  if (response.page < response.totalPages) {
    console.log(chalk.dim(`\nUse --page ${response.page + 1} for more results`));
  }
}

/**
 * Apply colors to compact format line and highlight query
 */
function applyCompactColors(line: string, query?: string): string {
  // Parse the compact format and apply colors
  let result = line;

  // Color the message ID
  result = result.replace(/^(#\d+)/, chalk.dim('$1'));

  // Color cluster ID
  result = result.replace(/(\[cluster:\d+\])/, chalk.magenta('$1'));

  // Color date/time (Dec 22 14:30)
  result = result.replace(/([A-Z][a-z]{2} \d{1,2} \d{2}:\d{2})/, chalk.dim('$1'));

  // Color chat name in brackets
  result = result.replace(/(\[[^\]]+\])(?=\s+[^:]+:)/, chalk.dim('$1'));

  // Color sender (word before the colon that follows the date)
  result = result.replace(/(\d{2}:\d{2}(?:\s+\[[^\]]+\])?\s+)([^:]+)(:)/, '$1' + chalk.cyan('$2') + '$3');

  // Color media indicator
  result = result.replace(/(\[(?:photo|video|document|voice|audio|sticker|gif)\])/, chalk.dim('$1'));

  // Color reactions at end
  result = result.replace(/(\[[^\]]*×[^\]]*\])$/, chalk.dim('$1'));

  // Color reply context
  result = result.replace(/(↳\s+"[^"]*")/, chalk.dim('$1'));

  // Highlight query terms if provided
  if (query) {
    const words = query.trim().split(/\s+/);
    for (const word of words) {
      try {
        const regex = new RegExp(`(${escapeRegex(word)})`, 'gi');
        result = result.replace(regex, chalk.yellow('$1'));
      } catch {
        // Skip invalid regex
      }
    }
  }

  return result;
}

/**
 * Highlight query terms in text
 */
function highlightQuery(text: string, query: string): string {
  const words = query.trim().split(/\s+/);
  let result = text;

  for (const word of words) {
    try {
      const regex = new RegExp(`(${escapeRegex(word)})`, 'gi');
      result = result.replace(regex, chalk.yellow('$1'));
    } catch {
      // Skip invalid regex
    }
  }

  return result;
}

/**
 * Escape special regex characters
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Format time elapsed since a date in human-readable form
 */
function formatTimeAgo(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays > 0) {
    return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
  } else if (diffHours > 0) {
    return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
  } else {
    return 'less than an hour ago';
  }
}

/**
 * Show a warning if the database hasn't been synced in 24+ hours
 */
function showTelegramSyncWarningIfNeeded(): void {
  const lastSync = getLastSyncTime();
  if (!lastSync) return;

  const now = new Date();
  const diffMs = now.getTime() - lastSync.getTime();
  const diffHours = diffMs / (1000 * 60 * 60);

  if (diffHours >= 24) {
    console.log();
    console.log(chalk.yellow(`\u26a0\ufe0f  Database last synced ${formatTimeAgo(lastSync)}. Run: claude-tools telegram sync <chat>`));
  }
}

/**
 * Print semantic search results
 */
function printSemanticResults(query: string, results: SemanticSearchResult[], verbose?: boolean): void {
  console.log(chalk.bold(`🧠 "${query}"`) + chalk.dim(` (${results.length} semantic matches)`));

  if (results.length === 0) {
    console.log(chalk.dim('No results. Try generating embeddings: telegram embed --generate'));
    return;
  }

  for (const msg of results) {
    const similarity = msg.similarity * 100;
    const msgData: MessageData = {
      id: msg.id,
      chatId: msg.chatId?.toString(),
      sender: msg.sender,
      text: msg.text,
      date: msg.date,
      chatTitle: msg.chatTitle,
    };

    if (verbose) {
      const lines = formatMessageVerbose(msgData, {
        showChatName: true,
        showClusterId: msg.clusterId,
        showSimilarity: similarity,
      });

      console.log();
      console.log(applyVerboseHeaderColors(lines[0]));
      for (let i = 1; i < lines.length; i++) {
        console.log(lines[i]);
      }
    } else {
      const formatted = formatMessageCompact(msgData, {
        showChatName: true,
        showClusterId: msg.clusterId,
        showSimilarity: similarity,
        maxTextLength: 70,
      });

      // Apply colors - similarity is green, rest follows compact pattern
      let colored = formatted;
      colored = colored.replace(/^(\d+\.\d+%)/, chalk.green('$1'));
      colored = colored.replace(/(#\d+)/, chalk.dim('$1'));
      colored = colored.replace(/(\[cluster:\d+\])/, chalk.magenta('$1'));
      colored = colored.replace(/([A-Z][a-z]{2} \d{1,2} \d{2}:\d{2})/, chalk.dim('$1'));
      colored = colored.replace(/(\[[^\]]+\])(?=\s+[^:]+:)/, chalk.dim('$1'));
      colored = colored.replace(/(\d{2}:\d{2}(?:\s+\[[^\]]+\])?\s+)([^:]+)(:)/, '$1' + chalk.cyan('$2') + '$3');
      console.log(colored);
    }
  }
}
