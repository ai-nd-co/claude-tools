/**
 * Pinned messages: what a chat has pinned, as a list a person or an agent can read before touching it.
 *
 * Telegram keeps the pin as a flag on the message, so the list is a search with the pinned filter. What the message
 * does NOT carry is who pinned it or when: those are only in the admin log, which Telegram keeps for 48 hours. A row
 * therefore shows the message's author and send time, labelled as such, and never presents the author as the pinner.
 *
 * Pure: the shaping and the rendering. The service does the request.
 */

/** One pinned message. `topic` is the forum topic it is in, `null` for a chat without topics or for General. */
export interface PinnedMessage {
  readonly id: number;
  readonly topic: number | null;
  readonly author: string;
  readonly sentAt: Date;
  /** The first line of the text, or a stand-in for media with no text. */
  readonly firstLine: string;
}

const FIRST_LINE_MAX = 100;

/** The forum topic a message sits in, from its reply header: Telegram marks a topic message with `forumTopic`. */
export function topicOfReplyHeader(replyTo: { forumTopic?: boolean; replyToTopId?: number; replyToMsgId?: number } | undefined): number | null {
  if (replyTo === undefined || replyTo.forumTopic !== true) return null;
  // A reply inside a topic names the topic in replyToTopId; a plain topic message names it in replyToMsgId.
  return replyTo.replyToTopId ?? replyTo.replyToMsgId ?? null;
}

export function firstLineOf(text: string, hasMedia: boolean): string {
  const line = text.split('\n').map((part) => part.trim()).find((part) => part.length > 0) ?? '';
  if (line.length === 0) return hasMedia ? '[media]' : '[no text]';
  return line.length > FIRST_LINE_MAX ? `${line.slice(0, FIRST_LINE_MAX - 1)}…` : line;
}

/** Newest first, as Telegram shows pins, and grouped so a forum's topics read as sections. */
export function sortPins(pins: readonly PinnedMessage[]): PinnedMessage[] {
  return [...pins].sort((a, b) => (a.topic ?? 0) - (b.topic ?? 0) || b.id - a.id);
}

export function renderPins(chat: string, pins: readonly PinnedMessage[], scope: { topic?: number; truncated: boolean }): string[] {
  const where = scope.topic === undefined ? `chat ${chat}` : `chat ${chat}, topic ${scope.topic}`;
  if (pins.length === 0) return [`No pinned messages in ${where}.`];
  const lines = [`${pins.length} pinned message(s) in ${where}${scope.truncated ? ' (more exist; raise --limit)' : ''}. Author and time are when the message was SENT; who pinned it is not recorded on the message.`];
  for (const pin of sortPins(pins)) {
    const topic = pin.topic === null ? 'general' : `topic ${pin.topic}`;
    lines.push(`  #${pin.id}  ${topic}  ${pin.sentAt.toISOString().slice(0, 16).replace('T', ' ')}Z  ${pin.author}: ${pin.firstLine}`);
  }
  return lines;
}
