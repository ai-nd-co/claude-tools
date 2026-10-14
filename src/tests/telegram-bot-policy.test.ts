import test from 'node:test';
import assert from 'node:assert/strict';

import {
  gateBotCallback,
  gateBotUpdate,
  isChatAuthorized,
  isBotMentioned,
  resolveChatPolicy,
  type BotChatAccess,
  type BotMentionIdentity,
  type GateSubject,
} from '../services/telegram-bot-policy.js';
import { parseUpdate } from '../services/telegram-bot.js';

const BOT: BotMentionIdentity = { id: 777000, username: 'agent_bot' };

/** The owner's DM: a Telegram DM chat id is the user's own id. */
const OWNER = '100000001';
const GROUP = '-1001234567890';

function access(over: Partial<BotChatAccess> = {}): BotChatAccess {
  return { allowedChats: [], chats: {}, ...over };
}

/** A group message from an ordinary member that says nothing about the bot. */
function groupMessage(over: Partial<GateSubject> = {}): GateSubject {
  return { chatId: GROUP, chatType: 'supergroup', senderId: '111', text: 'deploy is out', ...over };
}

function dm(over: Partial<GateSubject> = {}): GateSubject {
  return { chatId: OWNER, chatType: 'private', senderId: OWNER, text: 'ship it', ...over };
}

/** The reason a subject was dropped, or null when it was delivered. */
function reason(a: BotChatAccess, subject: GateSubject): string | null {
  const decision = gateBotUpdate(a, BOT, subject);
  return decision.deliver ? null : decision.reason;
}

// --- groups ------------------------------------------------------------------

test('policy: a group message that does not mention the bot is dropped', () => {
  const a = access({ allowedChats: [OWNER], chats: { [GROUP]: { allowFrom: [] } } });

  assert.equal(reason(a, groupMessage()), 'mention');
});

test('policy: the same group message is delivered once it mentions the bot', () => {
  const a = access({ allowedChats: [OWNER], chats: { [GROUP]: { allowFrom: [] } } });

  assert.equal(reason(a, groupMessage({ text: '@agent_bot deploy is out', mentionedUsernames: ['agent_bot'] })), null);
});

test('policy: requireMention defaults to true when a group entry omits it', () => {
  const a = access({ chats: { [GROUP]: { allowFrom: [] } } });

  // Nothing in the resolved config says so: the default lives in the gate, which
  // is what lets the same field mean "off" for a DM.
  assert.equal(resolveChatPolicy(a, GROUP, 'supergroup')?.requireMention, undefined);
  assert.equal(reason(a, groupMessage()), 'mention');
});

test('policy: a group may opt out of the mention requirement', () => {
  const a = access({ chats: { [GROUP]: { allowFrom: [], requireMention: false } } });

  assert.equal(reason(a, groupMessage()), null);
});

test('policy: a sender outside a group allowFrom is dropped even when mentioning the bot', () => {
  const a = access({ chats: { [GROUP]: { allowFrom: [OWNER] } } });
  const mentioning = groupMessage({ senderId: '222', mentionedUsernames: ['agent_bot'] });

  assert.equal(reason(a, mentioning), 'sender');
});

test('policy: a listed sender still has to mention the bot', () => {
  const a = access({ chats: { [GROUP]: { allowFrom: ['111'] } } });

  assert.equal(reason(a, groupMessage()), 'mention');
  assert.equal(reason(a, groupMessage({ mentionedUsernames: ['agent_bot'] })), null);
});

test('policy: an empty allowFrom means any member of that group', () => {
  const a = access({ chats: { [GROUP]: { allowFrom: [] } } });

  assert.equal(reason(a, groupMessage({ senderId: '999', mentionedUsernames: ['agent_bot'] })), null);
});

test('policy: a post with no sender cannot satisfy a sender list', () => {
  const a = access({ chats: { [GROUP]: { allowFrom: ['111'] } } });
  const anonymous = groupMessage({ senderId: undefined, mentionedUsernames: ['agent_bot'] });

  assert.equal(reason(a, anonymous), 'sender');
});

test('policy: a group with no policy of its own is dropped', () => {
  const a = access({ allowedChats: [OWNER] });

  assert.equal(reason(a, groupMessage({ mentionedUsernames: ['agent_bot'] })), 'unlisted');
});

test('policy: an unrestricted bot still needs the group named somewhere', () => {
  // Empty allowedChats means "any DM". It must not also mean "any group anyone
  // adds this bot to", or a stranger could wake the agent by creating one.
  const a = access();

  assert.equal(reason(a, groupMessage({ mentionedUsernames: ['agent_bot'] })), 'unlisted');
});

test('policy: a group id in the old flat allowedChats keeps working, with mentions required', () => {
  const a = access({ allowedChats: [OWNER, GROUP] });

  assert.equal(reason(a, groupMessage({ mentionedUsernames: ['agent_bot'] })), null);
  assert.equal(reason(a, groupMessage()), 'mention');
});

// --- DMs: nothing that works today may break ---------------------------------

test('policy: a DM under an old flat config still delivers', () => {
  const a = access({ allowedChats: [OWNER] });

  assert.equal(reason(a, dm()), null);
});

test('policy: a DM from a chat that is not listed is dropped', () => {
  const a = access({ allowedChats: [OWNER] });

  assert.equal(reason(a, dm({ chatId: '4242', senderId: '4242' })), 'unlisted');
});

test('policy: an unrestricted config delivers any DM, as before', () => {
  assert.equal(reason(access(), dm({ chatId: '4242', senderId: '4242' })), null);
});

test('policy: a DM entry does not inherit the group mention default', () => {
  const a = access({ allowedChats: [OWNER], chats: { [OWNER]: { allowFrom: [] } } });

  assert.equal(reason(a, dm()), null);
});

test('policy: a DM entry that asks for a mention gets one', () => {
  const a = access({ chats: { [OWNER]: { allowFrom: [], requireMention: true } } });

  assert.equal(reason(a, dm()), 'mention');
  assert.equal(reason(a, dm({ mentionedUsernames: ['agent_bot'] })), null);
});

test('policy: a chat entry authorises the DM without repeating it in allowedChats', () => {
  const a = access({ allowedChats: ['1'], chats: { [OWNER]: { allowFrom: [] } } });

  assert.equal(reason(a, dm()), null);
});

// --- everything else ---------------------------------------------------------

test('policy: a channel post is dropped whatever the config says', () => {
  const a = access({ chats: { [GROUP]: { allowFrom: [], requireMention: false } } });

  assert.equal(reason(a, groupMessage({ chatType: 'channel' })), 'chat-type');
});

// --- what counts as addressing the bot ---------------------------------------

test('mention: a text_mention of the bot id counts', () => {
  const a = access({ chats: { [GROUP]: { allowFrom: [] } } });

  assert.equal(reason(a, groupMessage({ mentionedUserIds: ['777000'] })), null);
});

test('mention: a reply to one of the bot messages counts', () => {
  const a = access({ chats: { [GROUP]: { allowFrom: [] } } });

  assert.equal(reason(a, groupMessage({ replyToSenderId: '777000' })), null);
  assert.equal(reason(a, groupMessage({ replyToSenderId: '555' })), 'mention');
});

test('mention: a handle in the text counts when the message carries no entities', () => {
  // A rich message has no entities at all, so entity-only detection would drop it.
  assert.equal(isBotMentioned({ chatId: GROUP, chatType: 'supergroup', text: 'hey @agent_bot look' }, BOT), true);
});

test('mention: a handle that merely starts the same is not a mention', () => {
  const near = { chatId: GROUP, chatType: 'supergroup', text: 'ask @agent_botox about it' };
  const email = { chatId: GROUP, chatType: 'supergroup', text: 'write to user@agent_bot.example' };

  assert.equal(isBotMentioned(near, BOT), false);
  assert.equal(isBotMentioned(email, BOT), false);
});

test('mention: a configured pattern counts as addressing the bot', () => {
  const a = access({ chats: { [GROUP]: { allowFrom: [] } }, mentionPatterns: ['\\bclaude\\b'] });

  assert.equal(reason(a, groupMessage({ text: 'claude, what broke?' })), null);
  assert.equal(reason(a, groupMessage({ text: 'clauded it' })), 'mention');
});

test('mention: an unparseable pattern is skipped rather than throwing', () => {
  const a = access({ chats: { [GROUP]: { allowFrom: [] } }, mentionPatterns: ['('] });

  assert.equal(reason(a, groupMessage()), 'mention');
});

test('mention: a bot with no username falls back to id and patterns', () => {
  const nameless: BotMentionIdentity = { id: 777000 };

  assert.equal(isBotMentioned({ chatId: GROUP, chatType: 'group', text: '@agent_bot' }, nameless), false);
  assert.equal(isBotMentioned({ chatId: GROUP, chatType: 'group', replyToSenderId: '777000' }, nameless), true);
});

// --- outbound and button presses ---------------------------------------------

test('policy: outbound is allowed to a group configured only through chats', () => {
  const a = access({ allowedChats: [OWNER], chats: { [GROUP]: { allowFrom: [] } } });

  assert.equal(isChatAuthorized(a, GROUP), true);
  assert.equal(isChatAuthorized(a, OWNER), true);
  assert.equal(isChatAuthorized(a, '4242'), false);
  assert.equal(isChatAuthorized(access(), '4242'), true);
});

test('policy: a button press is gated on chat and sender, not on a mention', () => {
  const a = access({ allowedChats: [OWNER], chats: { [GROUP]: { allowFrom: ['111'] } } });

  assert.equal(gateBotCallback(a, { chatId: GROUP, senderId: '111' }).deliver, true);
  assert.equal(gateBotCallback(a, { chatId: OWNER, senderId: OWNER }).deliver, true);

  const stranger = gateBotCallback(a, { chatId: GROUP, senderId: '222' });
  assert.deepEqual(stranger, { deliver: false, reason: 'sender' });

  const elsewhere = gateBotCallback(a, { chatId: '4242', senderId: '4242' });
  assert.deepEqual(elsewhere, { deliver: false, reason: 'unlisted' });
});

// --- the fields the gate reads -----------------------------------------------

function rawMessage(message: Record<string, unknown>): any {
  return {
    update_id: 9,
    message: {
      message_id: 1,
      date: 1_700_000_000,
      chat: { id: Number(GROUP), type: 'supergroup', title: 'Team Dev Chat' },
      from: { id: 111, username: 'member' },
      ...message,
    },
  };
}

test('parse: an update carries the sender id and the mentions Telegram marked', () => {
  const update = parseUpdate(rawMessage({
    text: '@agent_bot status?',
    entities: [{ type: 'mention', offset: 0, length: 10 }],
  }));

  assert.equal(update?.senderId, '111');
  assert.deepEqual(update?.mentionedUsernames, ['agent_bot']);
  assert.equal(gateBotUpdate(access({ chats: { [GROUP]: { allowFrom: [] } } }), BOT, update!).deliver, true);
});

test('parse: a command addressed to the bot is a mention', () => {
  const update = parseUpdate(rawMessage({
    text: '/status@agent_bot',
    entities: [{ type: 'bot_command', offset: 0, length: 17 }],
  }));

  assert.deepEqual(update?.mentionedUsernames, ['agent_bot']);
});

test('parse: a caption mention is read against the caption entities', () => {
  const update = parseUpdate(rawMessage({
    photo: [{ file_id: 'photo-1' }],
    caption: 'look at this @agent_bot',
    caption_entities: [{ type: 'mention', offset: 13, length: 10 }],
  }));

  assert.deepEqual(update?.mentionedUsernames, ['agent_bot']);
});

test('parse: a mention of a member with no username arrives as an id', () => {
  const update = parseUpdate(rawMessage({
    text: 'Bot, look',
    entities: [{ type: 'text_mention', offset: 0, length: 3, user: { id: 777000, first_name: 'Bot' } }],
  }));

  assert.deepEqual(update?.mentionedUserIds, ['777000']);
  assert.equal(update?.mentionedUsernames, undefined);
});

test('parse: a reply records who was replied to', () => {
  const update = parseUpdate(rawMessage({
    text: 'yes',
    reply_to_message: { message_id: 7, from: { id: 777000, username: 'agent_bot', is_bot: true } },
  }));

  assert.equal(update?.replyToId, 7);
  assert.equal(update?.replyToSenderId, '777000');
});

test('parse: an ordinary message records no empty mention lists', () => {
  const update = parseUpdate(rawMessage({ text: 'morning' }));

  // Every update is written to the message log verbatim; two empty arrays per
  // line would be pure weight.
  assert.equal(update?.mentionedUsernames, undefined);
  assert.equal(update?.mentionedUserIds, undefined);
  assert.equal(update?.replyToSenderId, undefined);
});

test('parse: a malformed entity is skipped rather than slicing at nothing', () => {
  const update = parseUpdate(rawMessage({
    text: '@agent_bot',
    entities: [{ type: 'mention' }, null, { type: 'mention', offset: 0, length: 10 }],
  }));

  assert.deepEqual(update?.mentionedUsernames, ['agent_bot']);
});
