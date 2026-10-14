// Shared message formatting functions for Telegram CLI
// All functions return plain strings (no chalk) - colors are applied by callers

import { redactSecrets } from '../../services/redact.js';

/**
 * Entity stored in database (extracted from Telegram)
 */
export interface StoredEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;        // For textUrl entities
  userId?: string;     // For mentionName entities
  language?: string;   // For pre (code block) entities
}

/**
 * Apply entities to text, converting to markdown format
 * Handles textUrl entities (hyperlinks) and other formatting
 *
 * @param text - Original plain text
 * @param entities - Array of entities from database (JSON parsed)
 * @returns Text with entities applied as markdown
 */
export function applyEntities(text: string, entities?: StoredEntity[] | null): string {
  if (!entities || entities.length === 0 || !text) return text;

  // Sort entities by offset in reverse order (process from end to start)
  // This ensures offsets remain valid as we modify the string
  const sorted = [...entities].sort((a, b) => b.offset - a.offset);

  let result = text;

  for (const entity of sorted) {
    const start = entity.offset;
    const end = entity.offset + entity.length;

    // Validate bounds
    if (start < 0 || end > text.length) continue;

    const originalText = text.slice(start, end);

    let replacement: string;

    switch (entity.type) {
      case 'MessageEntityTextUrl':
        // Convert "Link" text to markdown link with actual URL
        replacement = entity.url ? `[${originalText}](${entity.url})` : originalText;
        break;

      case 'MessageEntityUrl':
        // URL is already in the text, no change needed
        replacement = originalText;
        break;

      case 'MessageEntityBold':
        replacement = `**${originalText}**`;
        break;

      case 'MessageEntityItalic':
        replacement = `_${originalText}_`;
        break;

      case 'MessageEntityCode':
        replacement = `\`${originalText}\``;
        break;

      case 'MessageEntityPre':
        const lang = entity.language || '';
        replacement = `\`\`\`${lang}\n${originalText}\n\`\`\``;
        break;

      case 'MessageEntityStrike':
        replacement = `~~${originalText}~~`;
        break;

      case 'MessageEntityMention':
      case 'MessageEntityMentionName':
        // Keep mentions as-is
        replacement = originalText;
        break;

      case 'MessageEntityHashtag':
        // Keep hashtags as-is
        replacement = originalText;
        break;

      default:
        // Unknown entity type, keep original
        replacement = originalText;
    }

    // Apply replacement
    result = result.slice(0, start) + replacement + result.slice(end);
  }

  return result;
}

export interface ReactionUser {
  id: string;
  firstName?: string;
  lastName?: string;
  username?: string;
}

export interface ReactionInfo {
  emoji: string;
  count: number;
  users?: ReactionUser[]; // Users who reacted (fetched separately)
}

export interface MessageData {
  id: number;
  sender: string;
  text: string;
  date: Date;
  chatId?: string;           // Chat ID for generating message links
  chatTitle?: string;
  hasMedia?: boolean;
  mediaType?: string | null;
  reactions?: ReactionInfo[];
  replyToId?: number | null;
  replyToChatId?: string | null;
  replyToSender?: string | null;
  replyToText?: string | null;
  // Optional: text with markdown formatting (bold, italic, links) for verbose mode
  formattedText?: string;
  // Optional: entities from database for applying formatting
  entities?: StoredEntity[] | null;
}

/**
 * Generate a Telegram message link
 * For private groups/channels: https://t.me/c/<channel_id>/<message_id>
 * The channel_id is the chat ID without the -100 prefix
 *
 * @param chatId - The chat ID (e.g., "-1002000000002")
 * @param messageId - The message ID
 * @returns The full Telegram message link, or just #messageId for Saved Messages or unknown chats
 */
export function formatMessageLink(chatId: string | undefined, messageId: number): string {
  if (!chatId) {
    return `#${messageId}`;
  }

  if (/^-\d+$/.test(chatId) && BigInt(chatId) <= -1000000000000n) {
    return `https://t.me/c/${(-BigInt(chatId)-1000000000000n).toString()}/${messageId}`;
  }
  return `[chat:${chatId}] #${messageId}`;
}

export interface MessageFormatOptions {
  showChatName?: boolean;      // true for multi-chat contexts (search, unread)
  showClusterId?: number;      // cluster ID to display
  showSimilarity?: number;     // similarity percentage for semantic search
  isTarget?: boolean;          // true for target message in read-around
  maxTextLength?: number;      // max text length for compact mode (default 80)
}

/**
 * Format reactions for display
 * With users: [👍 Davron, Alex +2 more]
 * Without users: [👍×2 🔥]
 * Returns empty string if no reactions
 * Shows first 3 users, then "+N more" for the rest
 */
export function formatReactions(reactions?: ReactionInfo[]): string {
  if (!reactions || reactions.length === 0) return '';
  const formatted = reactions
    .map(r => {
      // If we have user info, show names (max 3)
      if (r.users && r.users.length > 0) {
        const firstThree = r.users.slice(0, 3);
        const names = firstThree.map(u => u.firstName || u.username || 'Unknown').join(', ');
        const remaining = r.users.length - 3;
        if (remaining > 0) {
          return `${r.emoji} ${names} +${remaining} more`;
        }
        return `${r.emoji} ${names}`;
      }
      // Fallback to count display
      return r.count > 1 ? `${r.emoji}×${r.count}` : r.emoji;
    })
    .join(' | ');
  return `[${formatted}]`;
}

/**
 * Format date in short format: "Dec 22 14:30"
 */
export function formatShortDate(date: Date): string {
  const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const timeStr = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${dateStr} ${timeStr}`;
}

/**
 * Format date for display, showing only time if today
 */
export function formatSmartDate(date: Date): string {
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const timeStr = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });

  if (isToday) {
    return timeStr;
  }

  const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${dateStr} ${timeStr}`;
}

/**
 * Format media indicator: [photo], [video], etc.
 */
export function formatMediaIndicator(mediaType?: string | null): string {
  if (!mediaType) return '';
  return `[${mediaType}]`;
}

/**
 * Truncate text with ellipsis
 */
export function truncateText(text: string, maxLength: number): string {
  const singleLine = text.replace(/\n/g, ' ').trim();
  if (singleLine.length <= maxLength) return singleLine;
  return singleLine.slice(0, maxLength) + '…';
}

/**
 * Format reply context for compact mode: ↳ [#123](link) "preview text..."
 * @param replyToId - ID of the message being replied to
 * @param replyToText - Text of the message being replied to (optional)
 * @param chatId - Chat ID for generating message link (optional)
 * @param maxLength - Maximum preview length (default 60)
 */
export function formatReplyCompact(
  replyToId: number,
  replyToText?: string | null,
  chatId?: string,
  maxLength: number = 60
): string {
  const link = formatMessageLink(chatId, replyToId);
  if (!replyToText) {
    return `↳ ${link}`;
  }
  const preview = truncateText(replyToText, maxLength);
  return `↳ ${link} "${preview}"`;
}

/**
 * Format reply context for verbose mode: ↳ [#123](link) (sender): "preview text..."
 * @param replyToId - ID of the message being replied to
 * @param replyToSender - Sender of the message being replied to
 * @param replyToText - Text of the message being replied to (optional)
 * @param chatId - Chat ID for generating message link (optional)
 * @param maxLength - Maximum preview length (default 60)
 */
export function formatReplyVerbose(
  replyToId: number,
  replyToSender?: string | null,
  replyToText?: string | null,
  chatId?: string,
  maxLength: number = 60
): string {
  const sender = replyToSender || 'unknown';
  const link = formatMessageLink(chatId, replyToId);
  if (!replyToText) {
    return `↳ ${link} (${sender})`;
  }
  const preview = truncateText(replyToText, maxLength);
  return `↳ ${link} (${sender}): "${preview}"`;
}

/**
 * Format a message in compact mode (single line)
 * Format: <link> Dec 22 14:30 [Chat] Sender: [photo] text... ↳ "reply" [👍×2]
 */
export function formatMessageCompact(msg: MessageData, options: MessageFormatOptions = {}): string {
  // Redacted on the way OUT, not on the way in: the leak is in rendering a message into someone's
  // context, not in holding it. Wrapping the whole rendered line covers the body, the reply preview
  // and anything a future field adds, which a per-field call would not.
  return redactSecrets(formatMessageCompactRaw(msg, options));
}

function formatMessageCompactRaw(msg: MessageData, options: MessageFormatOptions = {}): string {
  const maxLen = options.maxTextLength ?? 160;
  const parts: string[] = [];

  // Similarity prefix (for semantic search)
  if (options.showSimilarity !== undefined) {
    parts.push(`${options.showSimilarity.toFixed(1)}%`);
  }

  // Message link at START
  parts.push(formatMessageLink(msg.chatId, msg.id));

  // Cluster ID (if provided)
  if (options.showClusterId !== undefined) {
    parts.push(`[cluster:${options.showClusterId}]`);
  }

  // Date
  parts.push(formatShortDate(msg.date));

  // Chat name (only in multi-chat contexts)
  if (options.showChatName && msg.chatTitle) {
    parts.push(`[${msg.chatTitle}]`);
  }

  // Sender with colon
  parts.push(`${msg.sender}:`);

  // Media indicator BEFORE text
  if (msg.hasMedia && msg.mediaType) {
    parts.push(formatMediaIndicator(msg.mediaType));
  }

  // Text (truncated)
  if (msg.text) {
    parts.push(truncateText(msg.text, maxLen));
  }

  // Reply context (compact) - pass chatId for link generation
  if (msg.replyToId) {
    parts.push(formatReplyCompact(msg.replyToId, msg.replyToText, msg.replyToChatId || msg.chatId));
    if (msg.replyToChatId && msg.replyToChatId !== msg.chatId) parts.push('[external chat; context not followed]');
  }

  // Reactions at END in brackets
  if (msg.reactions?.length) {
    parts.push(formatReactions(msg.reactions));
  }

  return parts.join(' ');
}

/**
 * Format a message in verbose mode (multi-line)
 * Returns an array of lines to print
 *
 * Format:
 * <link> Dec 22 14:30 [Chat] Sender
 *   ↳ <link> (Jane): "reply preview..."
 *   [photo]
 *   Full message text here
 *   [👍×2 🔥×3]
 */
export function formatMessageVerbose(msg: MessageData, options: MessageFormatOptions = {}): string[] {
  return formatMessageVerboseRaw(msg, options).map((line) => redactSecrets(line));
}

function formatMessageVerboseRaw(msg: MessageData, options: MessageFormatOptions = {}): string[] {
  const lines: string[] = [];

  // Header line: <link> date [chat] sender
  const headerParts: string[] = [];

  // Similarity prefix (for semantic search)
  if (options.showSimilarity !== undefined) {
    headerParts.push(`${options.showSimilarity.toFixed(1)}%`);
  }

  // Message link at START
  headerParts.push(formatMessageLink(msg.chatId, msg.id));

  // Cluster ID (if provided)
  if (options.showClusterId !== undefined) {
    headerParts.push(`[cluster:${options.showClusterId}]`);
  }

  // Date
  headerParts.push(formatShortDate(msg.date));

  // Chat name (only in multi-chat contexts)
  if (options.showChatName && msg.chatTitle) {
    headerParts.push(`[${msg.chatTitle}]`);
  }

  // Sender (no colon in verbose mode)
  headerParts.push(msg.sender);

  lines.push(headerParts.join(' '));

  // Reply context (verbose) - indented, with chatId for link
  if (msg.replyToId) {
    lines.push(`  ${formatReplyVerbose(msg.replyToId, msg.replyToSender, msg.replyToText, msg.replyToChatId || msg.chatId)}`);
    if (msg.replyToChatId && msg.replyToChatId !== msg.chatId) lines.push('  [external chat; context not followed]');
  }

  // Media indicator - indented
  if (msg.hasMedia && msg.mediaType) {
    lines.push(`  ${formatMediaIndicator(msg.mediaType)}`);
  }

  // Full message text - indented, preserving line breaks
  // Use formattedText if available, otherwise apply entities to plain text
  let displayText = msg.formattedText;
  if (!displayText && msg.text) {
    // Apply entities to convert links, bold, etc. to markdown
    displayText = applyEntities(msg.text, msg.entities);
  }
  if (displayText) {
    const textLines = displayText.split('\n');
    for (const line of textLines) {
      lines.push(`  ${line}`);
    }
  }

  // Reactions at END - indented
  if (msg.reactions?.length) {
    lines.push(`  ${formatReactions(msg.reactions)}`);
  }

  return lines;
}

/**
 * Format duration between two dates: "2h 15m", "3d 5h", etc.
 */
export function formatDuration(start: Date, end: Date): string {
  const diffMs = end.getTime() - start.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays > 0) {
    return `${diffDays}d ${diffHours % 24}h`;
  } else if (diffHours > 0) {
    return `${diffHours}h ${diffMins % 60}m`;
  } else {
    return `${diffMins}m`;
  }
}

/** "✅ Sent", "✅ Sent rich (muted)", ... - the mode is echoed so a wrong one is visible. */
export function sentLabel(verb: string, options: { mute?: boolean; rich?: boolean }): string {
  return `✅ ${verb}${options.rich ? ' rich' : ''}${options.mute ? ' (muted)' : ''}`;
}

/** Link to a sent message; a raw send can succeed without Telegram returning the id. */
export function sentLink(result: { chatId: string; messageId: number }): string {
  return result.messageId ? formatMessageLink(result.chatId, result.messageId) : '(id not returned - check with read)';
}
