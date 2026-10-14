// Who a bot listens to, per chat.
//
// A bot in a one-to-one DM needs nothing more than "is this chat mine?", which is
// what the flat `allowedChats` list answered. A bot in a group does: every line
// anyone types there arrives as an update, and a watcher hands each one to an
// agent as if it were addressed to it. In a working group chat that is a day of
// unrelated traffic, one turn per message.
//
// So the policy is per chat and depends on the chat's type:
//
//   private          the flat allowlist, exactly as before — a DM that works
//                    today keeps working with no config change
//   group/supergroup an entry of its own: an optional sender list, and a mention
//                    requirement that defaults to ON, so ordinary chatter is
//                    dropped and only messages addressed to the bot get through
//   anything else    dropped (a channel post has no sender to allowlist)
//
// This module is deliberately pure and knows nothing about the Bot API client or
// the config loader: a gate that cannot be exercised without a network call or a
// secrets file is a gate nobody tests.

/** How one chat is treated. Keyed by chat id in a bot's `chats` map. */
export interface ChatPolicy {
  /**
   * User ids allowed to reach the agent from this chat. Empty means any member.
   *
   * Ids, never usernames: a username can be changed, and a freed one can be
   * re-registered by someone else, so an allowlist keyed on it is an allowlist
   * that can be inherited.
   */
  allowFrom: string[];
  /**
   * Whether a message must address the bot to be delivered.
   *
   * Left undefined when the config does not say, because the default depends on
   * the chat type and that decision belongs to the gate below, not to the loader.
   */
  requireMention?: boolean;
}

/** The parts of a bot's config that decide delivery. `TelegramBotConfig` satisfies it. */
export interface BotChatAccess {
  /** Chat ids this bot will talk to at all. Empty means unrestricted. */
  allowedChats: string[];
  /** Per-chat policy, keyed by chat id. */
  chats: Record<string, ChatPolicy>;
  /** Extra case-insensitive regexes that count as addressing the bot. */
  mentionPatterns?: string[];
}

/** Who the bot is, for deciding whether a message addresses it. */
export interface BotMentionIdentity {
  id?: number | string;
  username?: string;
}

/**
 * The fields of an update the gate reads — all of them set by Telegram, none of
 * them derived from what a sender chose to write, except `text`, whose one use is
 * documented in `isBotMentioned`.
 */
export interface GateSubject {
  chatId: string;
  chatType: string;
  senderId?: string;
  text?: string;
  /** `@handle`s Telegram marked as mentions, without the `@`. */
  mentionedUsernames?: string[];
  /** Ids from `text_mention` entities: a mention of someone who has no username. */
  mentionedUserIds?: string[];
  /** Sender of the message this one replies to, when it replies to anything. */
  replyToSenderId?: string;
}

/**
 * Why an update was not delivered.
 *
 * `unlisted` is the only one worth telling the owner about: it is how he learns
 * someone found the bot, or that it was added to a group he has no policy for.
 * `sender` and `mention` are the ordinary case in a busy group and must stay
 * silent, or the noise this gate exists to stop simply moves to stderr.
 */
export type DropReason = 'unlisted' | 'sender' | 'mention' | 'chat-type';

export type GateDecision =
  | { deliver: true }
  | { deliver: false; reason: DropReason };

const DELIVER: GateDecision = { deliver: true };

function drop(reason: DropReason): GateDecision {
  return { deliver: false, reason };
}

function isGroup(chatType: string): boolean {
  return chatType === 'group' || chatType === 'supergroup';
}

/**
 * Is this chat one the bot deals with at all?
 *
 * Used for outbound sends and for button presses, where there is no message to
 * gate on: a chat id on the command line carries no type and no sender. A chat
 * with a policy entry counts as listed, so configuring a group does not also mean
 * repeating its id in `allowedChats`.
 */
export function isChatAuthorized(access: BotChatAccess, chatId: string): boolean {
  const id = String(chatId);
  if (access.chats[id]) return true;
  return access.allowedChats.length === 0 || access.allowedChats.includes(id);
}

/**
 * The policy for a chat, or null when there is none and the chat type requires one.
 *
 * The one piece of migration logic lives here. A group id that appears in the flat
 * `allowedChats` of a config written before this file existed is treated as an
 * implicit entry rather than being dropped: listing a chat id was the only way to
 * say "this chat is mine", and silently ceasing to answer in a group somebody
 * deliberately listed would be a regression dressed as a security fix. Such a
 * group still gets `requireMention` ON, which is the whole point of the change —
 * mentions get through, chatter no longer does.
 *
 * Note what does NOT bridge: an empty `allowedChats` ("unrestricted", i.e. any DM
 * from anyone). Anybody can add a public bot to a group, so an unrestricted bot
 * plus an implicit group entry would let a stranger wake the agent by creating a
 * group and mentioning it. A group needs to be named somewhere.
 */
export function resolveChatPolicy(
  access: BotChatAccess,
  chatId: string,
  chatType: string
): ChatPolicy | null {
  const id = String(chatId);
  const entry = access.chats[id];
  if (entry) return entry;

  if (chatType === 'private') {
    const listed = access.allowedChats.length === 0 || access.allowedChats.includes(id);
    // No entry, but the chat is allowed: today's behaviour, unchanged — a DM is
    // never gated on a mention unless the config explicitly asks for it.
    return listed ? { allowFrom: [] } : null;
  }

  if (isGroup(chatType)) {
    return access.allowedChats.includes(id) ? { allowFrom: [] } : null;
  }

  return null;
}

/**
 * Does this message address the bot?
 *
 * Signals, in order: an `@handle` Telegram marked as a mention, a `text_mention`
 * of the bot's user id, a reply to one of the bot's own messages (replying to
 * someone is addressing them), and finally any configured pattern.
 *
 * `/status@thebot` counts too. Telegram types it as `bot_command` rather than
 * `mention`, and a command aimed at the bot by name is as explicit as it gets.
 *
 * The literal-`@handle`-in-the-text fallback is the one place this file reads
 * content, and it is safe for exactly one reason: a mention decides *attention*,
 * never *authority*. `allowFrom` decides authority and reads only the sender id
 * Telegram set. A sender who forges a mention of the bot can at worst wake an
 * agent from a chat and an account that were already allowed to wake it. Contrast
 * an attachment path: see the note in `formatBotUpdate`, where content-derived
 * provenance would be a real forgery.
 *
 * The fallback exists because entities do not always arrive — a rich message
 * carries none — and a dropped message somebody expected to be read is the worst
 * failure this gate can have.
 */
export function isBotMentioned(
  subject: GateSubject,
  identity: BotMentionIdentity,
  patterns: string[] = []
): boolean {
  const text = subject.text ?? '';
  const handle = identity.username?.replace(/^@/, '').toLowerCase();

  if (handle) {
    const marked = subject.mentionedUsernames ?? [];
    if (marked.some((name) => name.replace(/^@/, '').toLowerCase() === handle)) return true;
    if (new RegExp(`(^|[^\\w@])@${escapeRegExp(handle)}\\b`, 'i').test(text)) return true;
  }

  const botId = identity.id === undefined ? undefined : String(identity.id);
  if (botId) {
    if ((subject.mentionedUserIds ?? []).includes(botId)) return true;
    if (subject.replyToSenderId === botId) return true;
  }

  for (const pattern of patterns) {
    try {
      if (new RegExp(pattern, 'i').test(text)) return true;
    } catch {
      // A pattern comes from the config file, so a typo is a bad regex, not a
      // crash: skip it. Skipping can only ever drop a message, never deliver one.
    }
  }

  return false;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Should this update reach the agent? */
export function gateBotUpdate(
  access: BotChatAccess,
  identity: BotMentionIdentity,
  subject: GateSubject
): GateDecision {
  if (subject.chatType !== 'private' && !isGroup(subject.chatType)) {
    // A channel post, a business message, whatever Telegram adds next: no member
    // list to check and no conversation to be part of.
    return drop('chat-type');
  }

  const policy = resolveChatPolicy(access, subject.chatId, subject.chatType);
  if (!policy) return drop('unlisted');

  if (policy.allowFrom.length > 0) {
    // No sender id at all (an anonymous admin posting as the group, a channel
    // relay) cannot be matched against a sender list, so it is not on it.
    if (!subject.senderId || !policy.allowFrom.includes(subject.senderId)) return drop('sender');
  }

  // The default that makes this task worth doing: ON for a group, OFF for a DM.
  const requireMention = policy.requireMention ?? isGroup(subject.chatType);
  if (requireMention && !isBotMentioned(subject, identity, access.mentionPatterns)) {
    return drop('mention');
  }

  return DELIVER;
}

/**
 * Should this button press be handled?
 *
 * No mention check: pressing a button on one of the bot's own messages is
 * addressing it about as directly as Telegram allows. The chat and the sender are
 * still checked, because a button lives in a message anyone in the group can see.
 */
export function gateBotCallback(
  access: BotChatAccess,
  press: { chatId: string; senderId?: string }
): GateDecision {
  if (!isChatAuthorized(access, press.chatId)) return drop('unlisted');

  const policy = access.chats[String(press.chatId)];
  if (policy && policy.allowFrom.length > 0) {
    if (!press.senderId || !policy.allowFrom.includes(press.senderId)) return drop('sender');
  }

  return DELIVER;
}
