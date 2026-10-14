// Telegram read-around command - read context around a specific message (like grep -A/-B)

import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig } from '../../config/loader.js';
import { parseMessageId, parseContextCount } from '../../services/telegram-peer.js';
import {
  getMessagesAround,
  getMessage,
  resolveChatId,
  type SearchResult,
} from '../../services/telegram-search.js';
import { findClusterForMessage, getClusterMessages } from '../../services/telegram-cluster.js';
import { upsertMessageFromApi } from '../../services/telegram-sync.js';
import { TelegramService } from '../../services/telegram.js';
import {
  formatMessageCompact,
  formatMessageVerbose,
  formatReplyVerbose,
  type MessageData,
} from './format.js';

// Maximum depth for following reply chains (prevent infinite loops)
const MAX_REPLY_DEPTH = 2;

export function registerReadAroundCommand(telegram: Command): void {
  telegram
    .command('read-around <messageId>')
    .description('Read messages around a specific message (like grep -A/-B)')
    .requiredOption('--chat <name>', 'Explicit chat name, marked ID, @username, or me')
    .option('--before <n>', 'Number of messages before', '5')
    .option('--after <n>', 'Number of messages after', '5')
    .option('--context <n>', 'Number of messages before and after (overrides --before/--after)')
    .option('--cluster', 'Show entire cluster containing this message')
    .option('--verbose', 'Show detailed format with full messages')
    .option('--json', 'Output as JSON')
    .option('--follow-replies', 'Also show context around replied-to messages (default: true)', true)
    .option('--no-follow-replies', 'Skip fetching context for replied-to messages')
    .addHelpText('after', `
${chalk.yellow('Examples:')}
  ${chalk.dim('# Read 5 messages before and after in an explicit chat')}
  claude-tools telegram read-around 12345 --chat "Team Dev Chat"

  ${chalk.dim('# Specify the chat explicitly')}
  claude-tools telegram read-around 12345 --chat "Team Dev Chat"

  ${chalk.dim('# Read 10 messages before and after')}
  claude-tools telegram read-around 12345 --chat "Team Dev Chat" --context 10

  ${chalk.dim('# Show entire cluster containing the message')}
  claude-tools telegram read-around 12345 --chat "Team Dev Chat" --cluster

  ${chalk.dim('# Output as JSON')}
  claude-tools telegram read-around 12345 --chat "Team Dev Chat" --json

  ${chalk.dim('# Skip reply chain following')}
  claude-tools telegram read-around 12345 --chat "Team Dev Chat" --no-follow-replies

${chalk.yellow('Note:')} Telegram message IDs are unique ${chalk.bold('per chat')}, not globally.
An explicit --chat is always required, even if the local cache contains only one match.
Message IDs are shown in search results (e.g., #12345).
`)
    .action(async (messageId: string, options: {
      chat?: string;
      before: string;
      after: string;
      context?: string;
      cluster?: boolean;
      verbose?: boolean;
      json?: boolean;
      followReplies?: boolean;
    }) => {
      try {
        const msgId = parseMessageId(messageId);
        const before = parseContextCount(options.context ?? options.before);
        const after = parseContextCount(options.context ?? options.after);
        if (!options.chat?.trim()) throw new Error('--chat is required');
        let contextSource: 'cache' | 'telegram' = 'cache';
        let chatId = resolveChatId(options.chat);
        let targetMsg = chatId ? getMessage(chatId, msgId) : null;
        if (!targetMsg) {
          const config = loadConfig();
          if (!config.telegram) throw new Error('Message is not cached in the selected chat and Telegram is not configured');
          const service = new TelegramService(config.telegram);
          try {
            await service.connect();
            const resolved = await service.resolveChat(options.chat);
            chatId = String(resolved.id);
            const fetched = await service.getContextById(resolved, msgId, before, after);
            contextSource = 'telegram';
            for (const msg of fetched) upsertMessageFromApi({
              id:msg.id, chatId, chatTitle:msg.chatTitle || resolved.title, sender:msg.sender, text:msg.text,
              date:Math.floor(msg.date.getTime()/1000), replyToId:msg.replyToId || null,
              replyToPeerId:msg.replyToPeerId, reactions:msg.reactions, entities:msg.entities || null, hasMedia:!!msg.hasMedia, mediaType:msg.mediaType || null,
            });
            targetMsg = getMessage(chatId, msgId);
          } finally { await service.disconnect(); }
        }
        if (!targetMsg || !chatId) throw new Error(`Message #${msgId} not found in selected chat "${options.chat}"`);

        if (contextSource === 'cache') console.error('Context is from the local cache and may be incomplete; use telegram sync <explicit-chat> --force to refresh history.');

        // Cluster mode: show entire cluster
        if (options.cluster) {
          const cluster = findClusterForMessage(chatId, msgId);
          if (!cluster) {
            if (options.json) { console.log(JSON.stringify({chatId, target:targetMsg, cluster:null, messages:[]})); return; }
            console.error(chalk.yellow('Message not in any cluster.'));
            console.log(chalk.dim('Run: telegram clusters --build to create clusters'));
            return;
          }

          const clusterMessages = getClusterMessages(cluster.id);
          const messages = clusterMessages.map(m => {
            let reactions: Array<{ emoji: string; count: number }> | undefined;
            if (m.reactions) {
              try {
                reactions = JSON.parse(m.reactions);
              } catch {
                // Ignore invalid JSON
              }
            }
            return {
              id: m.id,
              chatId: m.chat_id,
              chatTitle: m.chat_title || '',
              sender: m.sender || 'Unknown',
              text: m.text || '',
              date: new Date(m.date * 1000),
              replyToId: m.reply_to_id,
              replyToPeerId: m.reply_to_peer_id,
              hasMedia: m.has_media === 1,
              mediaType: m.media_type,
              reactions,
            };
          });

          if (options.json) {
            console.log(JSON.stringify({ cluster, messages }, null, 2));
          } else if (options.verbose) {
            printClusterContext(messages, msgId, `${targetMsg.chatTitle} [${chatId}]`, cluster.id);
          } else {
            printClusterContext(messages, msgId, `${targetMsg.chatTitle} [${chatId}]`, cluster.id);
          }
          return;
        }

        // Get surrounding messages
        const messages = getMessagesAround(chatId, msgId, before, after);

        // Collect reply chain contexts if followReplies is enabled
        const replyChainContexts: Array<{
          targetId: number;
          chatTitle: string;
          messages: SearchResult[];
          depth: number;
        }> = [];

        if (options.followReplies !== false && targetMsg.replyToId && (!targetMsg.replyToPeerId || targetMsg.replyToPeerId === chatId)) {
          collectReplyChainContexts(
            chatId,
            targetMsg.replyToId,
            before,
            after,
            1,
            replyChainContexts
          );
        }

        if (options.json) {
          console.log(JSON.stringify({
            contextSource,
            contextComplete: contextSource === 'telegram',
            target: targetMsg,
            context: messages,
            before,
            after,
            replyChains: replyChainContexts.map(rc => ({
              targetId: rc.targetId,
              chatTitle: rc.chatTitle,
              messages: rc.messages,
              depth: rc.depth,
            })),
          }, null, 2));
        } else if (options.verbose) {
          printVerboseContext(messages, msgId, `${targetMsg.chatTitle} [${chatId}]`);
          // Print reply chain contexts
          for (const rc of replyChainContexts) {
            console.log();
            console.log(chalk.cyan(`↳ Reply context for #${rc.targetId}:`));
            printVerboseContext(rc.messages, rc.targetId, rc.chatTitle);
          }
        } else {
          printCompactContext(messages, msgId, `${targetMsg.chatTitle} [${chatId}]`);
          // Print reply chain contexts
          for (const rc of replyChainContexts) {
            console.log();
            console.log(chalk.cyan(`↳ Reply context for #${rc.targetId}:`));
            printCompactContext(rc.messages, rc.targetId, rc.chatTitle);
          }
        }
      } catch (err) {
        console.error(chalk.red('❌ Error:'), (err as Error).message);
        process.exit(1);
      }
    });
}

/**
 * Recursively collect contexts around replied-to messages
 */
function collectReplyChainContexts(
  chatId: string,
  replyToId: number,
  before: number,
  after: number,
  depth: number,
  results: Array<{
    targetId: number;
    chatTitle: string;
    messages: SearchResult[];
    depth: number;
  }>
): void {
  // Stop if we've reached max depth
  if (depth > MAX_REPLY_DEPTH || results.some(r => r.targetId === replyToId)) {
    return;
  }

  // Get the replied-to message (always in the same chat as the reply)
  const replyMsg = getMessage(chatId, replyToId);
  if (!replyMsg) {
    return;
  }

  // Get context around the replied-to message
  const replyContext = getMessagesAround(chatId, replyToId, before, after);

  results.push({
    targetId: replyToId,
    chatTitle: replyMsg.chatTitle,
    messages: replyContext,
    depth,
  });

  // Recursively follow if this message is also a reply
  if (replyMsg.replyToId && (!replyMsg.replyToPeerId || replyMsg.replyToPeerId === chatId)) {
    collectReplyChainContexts(
      chatId,
      replyMsg.replyToId,
      before,
      after,
      depth + 1,
      results
    );
  }
}

/**
 * Convert SearchResult to MessageData, enriching reply context from the message set
 */
function toMessageData(msg: SearchResult, allMessages: SearchResult[]): MessageData {
  // Find reply context from within the message set
  let replyToSender: string | null = null;
  let replyToText: string | null = null;

  if (msg.replyToId && (!msg.replyToPeerId || msg.replyToPeerId === msg.chatId)) {
    const replyMsg = allMessages.find(m => m.id === msg.replyToId && m.chatId === msg.chatId);
    if (replyMsg) {
      replyToSender = replyMsg.sender;
      replyToText = replyMsg.text;
    }
  }

  return {
    id: msg.id,
    sender: msg.sender,
    text: msg.text,
    date: msg.date,
    chatTitle: msg.chatTitle,
    chatId: msg.chatId,
    replyToChatId: msg.replyToPeerId,
    hasMedia: msg.hasMedia,
    mediaType: msg.mediaType,
    reactions: msg.reactions,
    replyToId: msg.replyToId,
    replyToSender,
    replyToText,
    entities: msg.entities,
  };
}

/**
 * Apply colors to verbose header line
 */
function applyVerboseColors(header: string): string {
  const parts = header.split(' ');
  const colored: string[] = [];

  for (const part of parts) {
    if (part.startsWith('#')) {
      colored.push(chalk.dim(part));
    } else if (/^[A-Z][a-z]{2}$/.test(part) || /^\d{1,2}$/.test(part) || /^\d{2}:\d{2}$/.test(part)) {
      colored.push(chalk.dim(part));
    } else {
      colored.push(chalk.cyan(part));
    }
  }

  return colored.join(' ');
}

/**
 * Print verbose context
 */
function printVerboseContext(messages: SearchResult[], targetId: number, chatTitle: string): void {
  console.log(chalk.bold(`\n📖 Context around #${targetId} in "${chatTitle}"\n`));

  for (const msg of messages) {
    const isTarget = msg.id === targetId;
    const msgData = toMessageData(msg, messages);
    const lines = formatMessageVerbose(msgData);

    if (isTarget) {
      // Highlight target message
      console.log(chalk.bgYellow.black(' ▶ ') + ' ' + chalk.yellow(lines[0]));
      for (let i = 1; i < lines.length; i++) {
        console.log(chalk.yellow(lines[i]));
      }
    } else {
      // Normal message with colors
      console.log(applyVerboseColors(lines[0]));
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim().startsWith('↳')) {
          console.log(chalk.dim(line));
        } else if (line.trim().startsWith('[') && line.includes('×')) {
          console.log(chalk.dim(line));
        } else {
          console.log(line);
        }
      }
    }
    console.log();
  }

  console.log(chalk.dim(`Showing ${messages.length} messages`));
}

/**
 * Apply colors to compact format line
 */
function applyCompactColors(line: string): string {
  let result = line;
  result = result.replace(/^(#\d+)/, chalk.dim('$1'));
  result = result.replace(/([A-Z][a-z]{2} \d{1,2} \d{2}:\d{2})/, chalk.dim('$1'));
  result = result.replace(/(\d{2}:\d{2}\s+)([^:]+)(:)/, '$1' + chalk.cyan('$2') + '$3');
  result = result.replace(/(\[(?:photo|video|document|voice|audio|sticker|gif)\])/, chalk.dim('$1'));
  result = result.replace(/(\[[^\]]*×[^\]]*\])$/, chalk.dim('$1'));
  result = result.replace(/(↳\s+"[^"]*")/, chalk.dim('$1'));
  return result;
}

/**
 * Print compact context
 */
function printCompactContext(messages: SearchResult[], targetId: number, chatTitle: string): void {
  console.log(chalk.bold(`📖 #${targetId}`) + chalk.dim(` in ${chatTitle} (${messages.length} messages)`));
  console.log();

  for (const msg of messages) {
    const isTarget = msg.id === targetId;
    const msgData = toMessageData(msg, messages);
    const formatted = formatMessageCompact(msgData);

    if (isTarget) {
      // Highlight target message
      console.log(chalk.bgYellow.black(' ▶ ') + ' ' + chalk.yellow(formatted));
    } else {
      console.log('   ' + applyCompactColors(formatted));
    }
  }
}

/**
 * Print cluster context
 */
interface ClusterMessage {
  id: number;
  chatTitle: string;
  sender: string;
  text: string;
  date: Date;
  hasMedia: boolean;
  mediaType: string | null;
  reactions?: Array<{ emoji: string; count: number }>;
  replyToId?: number | null;
  replyToPeerId?: string | null;
  chatId?: string;
}

/**
 * Convert ClusterMessage to MessageData, enriching reply context from the message set
 */
function clusterToMessageData(msg: ClusterMessage, allMessages: ClusterMessage[]): MessageData {
  let replyToSender: string | null = null;
  let replyToText: string | null = null;

  if (msg.replyToId && (!msg.replyToPeerId || msg.replyToPeerId === msg.chatId)) {
    const replyMsg = allMessages.find(m => m.id === msg.replyToId);
    if (replyMsg) {
      replyToSender = replyMsg.sender;
      replyToText = replyMsg.text;
    }
  }

  return {
    id: msg.id,
    sender: msg.sender,
    text: msg.text,
    date: msg.date,
    chatTitle: msg.chatTitle,
    chatId: msg.chatId,
    replyToChatId: msg.replyToPeerId,
    hasMedia: msg.hasMedia,
    mediaType: msg.mediaType,
    reactions: msg.reactions,
    replyToId: msg.replyToId,
    replyToSender,
    replyToText,
  };
}

function printClusterContext(
  messages: ClusterMessage[],
  targetId: number,
  chatTitle: string,
  clusterId: number
): void {
  console.log(chalk.bold(`📦 Cluster #${clusterId}`) + chalk.dim(` in ${chatTitle} (${messages.length} messages)`));
  console.log();

  for (const msg of messages) {
    const isTarget = msg.id === targetId;
    const msgData = clusterToMessageData(msg, messages);
    const formatted = formatMessageCompact(msgData);

    if (isTarget) {
      console.log(chalk.bgYellow.black(' ▶ ') + ' ' + chalk.yellow(formatted));
    } else {
      console.log('   ' + applyCompactColors(formatted));
    }
  }
}
