import test from 'node:test';
import assert from 'node:assert/strict';
import { firstLineOf, renderPins, sortPins, topicOfReplyHeader, type PinnedMessage } from '../services/telegram-pins.js';

test('a pin knows its forum topic, and a message outside a topic has none', () => {
  // A plain message in topic 3 points at the topic's creation message.
  assert.equal(topicOfReplyHeader({ forumTopic: true, replyToMsgId: 3 }), 3);
  // A reply inside topic 3 names the topic separately from the message it answers.
  assert.equal(topicOfReplyHeader({ forumTopic: true, replyToTopId: 3, replyToMsgId: 2840 }), 3);
  // An ordinary reply, or no header at all: General, or a chat without topics.
  assert.equal(topicOfReplyHeader({ replyToMsgId: 2840 }), null);
  assert.equal(topicOfReplyHeader(undefined), null);
});

test('the first line is the first non-empty one, cut to fit, with a stand-in for media', () => {
  assert.equal(firstLineOf('\n\n  **Ledger**  \nsecond', false), '**Ledger**');
  assert.equal(firstLineOf('', true), '[media]');
  assert.equal(firstLineOf('   ', false), '[no text]');
  const long = firstLineOf('x'.repeat(300), false);
  assert.equal(long.length, 100);
  assert.ok(long.endsWith('…'));
});

test('a forum list names each pin\'s topic and says the time is when it was sent, not pinned', () => {
  const pins: PinnedMessage[] = [
    { id: 10, topic: null, author: 'Davron', sentAt: new Date('2026-10-01T09:00:00Z'), firstLine: 'general rules' },
    { id: 900, topic: 3, author: 'DavronPersonalBot', sentAt: new Date('2026-10-12T14:00:00Z'), firstLine: 'ledger' },
    { id: 700, topic: 3, author: 'DavronPersonalBot', sentAt: new Date('2026-10-10T08:00:00Z'), firstLine: 'older ledger' },
  ];
  assert.deepEqual(sortPins(pins).map((p) => p.id), [10, 900, 700]);
  const lines = renderPins('-1002000000001', pins, { truncated: false });
  assert.match(lines[0]!, /3 pinned message\(s\) in chat -1002000000001\. Author and time are when the message was SENT; who pinned it is not recorded/);
  assert.equal(lines[1], '  #10  general  2026-10-01 09:00Z  Davron: general rules');
  assert.equal(lines[2], '  #900  topic 3  2026-10-12 14:00Z  DavronPersonalBot: ledger');
  assert.match(renderPins('-100', pins, { topic: 3, truncated: true })[0]!, /in chat -100, topic 3 \(more exist; raise --limit\)/);
  assert.deepEqual(renderPins('-100', [], { truncated: false }), ['No pinned messages in chat -100.']);
});
