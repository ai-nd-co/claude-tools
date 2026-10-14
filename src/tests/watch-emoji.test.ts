import test from 'node:test';
import assert from 'node:assert/strict';

import { isEmojiOnly } from '../services/emoji.js';
import { diffMessages, type WatchMessage } from '../services/telegram-watch.js';
import { isDroppableEmoji } from '../commands/telegram-bot/index.js';

// Davron #1470: watchers drop messages that are only emoji, so a 👍 or a 🔥 does not wake an agent for nothing.

test('emoji-only means pictographs and their glue, nothing else', () => {
  for (const text of ['👍', '🔥🔥', ' 🎉 ', '👍🏽', '🇺🇿', '❤️', '👨‍👩‍👧', '🤝 🙏']) assert.equal(isEmojiOnly(text), true, text);
  // Anything with words, digits or a keycap is an answer, not a reaction.
  for (const text of ['ok 👍', '👍 да', 'спасибо', '5', '1️⃣', '#', '*', '', '   ']) assert.equal(isEmojiOnly(text), false, text);
});

const chat = { id: '-1001', title: 'Group' };
const msg = (id: number, text: string, extra: Partial<WatchMessage> = {}): WatchMessage => ({ id, date: new Date(1_790_000_000_000), sender: 'Someone', text, ...extra });
const state = { lastId: 10, recent: {} };

test('telegram watch drops an emoji-only message but still moves past it, so it is never reported later', () => {
  const { events, next } = diffMessages(state, [msg(11, '🔥'), msg(12, 'real text')], chat, { window: 50, edits: true, ignoreEmoji: true });
  assert.deepEqual(events.map((e) => e.msg.id), [12]);
  assert.equal(next.lastId, 12);
  const again = diffMessages(next, [msg(11, '🔥'), msg(12, 'real text')], chat, { window: 50, edits: true, ignoreEmoji: true });
  assert.deepEqual(again.events, []);
});

test('telegram watch keeps an emoji reply, emoji with media, and everything when the filter is off', () => {
  const kept = diffMessages(state, [msg(11, '👍', { replyToId: 9 }), msg(12, '🔥', { hasMedia: true, mediaType: 'photo' })], chat, { window: 50, edits: true, ignoreEmoji: true });
  assert.deepEqual(kept.events.map((e) => e.msg.id), [11, 12]);
  const off = diffMessages(state, [msg(11, '🔥')], chat, { window: 50, edits: true, ignoreEmoji: false });
  assert.deepEqual(off.events.map((e) => e.msg.id), [11]);
});

test('a reaction alone (edit time bumped, content unchanged) is never an event', () => {
  const first = diffMessages(state, [msg(11, 'hello')], chat, { window: 50, edits: true, ignoreEmoji: true });
  const reacted = diffMessages(first.next, [msg(11, 'hello', { editDate: new Date(1_790_000_060_000) })], chat, { window: 50, edits: true, ignoreEmoji: true });
  assert.deepEqual(reacted.events, []);
});

test('bot watch drops emoji-only group messages but keeps the private chat, replies and media', () => {
  assert.equal(isDroppableEmoji({ chatType: 'supergroup', text: '🔥' }), true);
  assert.equal(isDroppableEmoji({ chatType: 'private', text: '👍' }), false);
  assert.equal(isDroppableEmoji({ chatType: 'group', text: '👍', replyToId: 4 }), false);
  assert.equal(isDroppableEmoji({ chatType: 'group', text: '🔥', file: {} }), false);
  assert.equal(isDroppableEmoji({ chatType: 'group', text: 'ok 🔥' }), false);
});
