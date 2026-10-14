import test from 'node:test';
import assert from 'node:assert/strict';

import { parseUpdate } from '../services/telegram-bot.js';
import { formatBotUpdate } from '../commands/telegram-bot/index.js';

const BASE = {
  message_id: 258,
  date: 1790000000,
  chat: { id: 100000001, type: 'private', first_name: 'Davra_Young' },
  from: { id: 100000001, first_name: 'Davra_Young' },
};

const parse = (message: Record<string, unknown>) => {
  const update = parseUpdate({ update_id: 1, message: { ...BASE, ...message } });
  assert.ok(update, 'the update should parse');
  return update;
};

// --- the miss this file exists for -----------------------------------------

test('a message with no recognised content is never reported as empty', () => {
  // The real failure: a forwarded message matched nothing the parser knew, was
  // stored as text:"", and printed as a blank line. The owner's message was
  // silently lost and only noticed because he asked about it.
  const update = parse({ story: { id: 7 }, forward_origin: { type: 'hidden_user', sender_user_name: 'Jordan' } });

  assert.notEqual(update.attachment, undefined, 'unknown content must describe itself');
  const line = formatBotUpdate(update, 400);
  assert.ok(!line.endsWith(': '), `line rendered empty: ${line}`);
});

test('a genuinely unrecognised type names the fields it carried', () => {
  // So the next gap is diagnosable from the log alone, without a repro.
  const update = parse({ some_future_thing: { x: 1 }, another_new_field: true });

  assert.match(update.attachment ?? '', /unsupported content:/);
  assert.match(update.attachment ?? '', /another_new_field/);
  assert.match(update.attachment ?? '', /some_future_thing/);
});

test('a message carrying nothing at all still says so', () => {
  assert.equal(parse({}).attachment, 'empty message (no content fields)');
});

test('metadata alone does not count as content', () => {
  // reply_to_message and entities are about a message, not content of one.
  const update = parse({ reply_to_message: { message_id: 1 }, entities: [], has_protected_content: true });
  assert.equal(update.attachment, 'empty message (no content fields)');
});

// --- forward attribution ----------------------------------------------------

test('a forward from a named user is attributed', () => {
  const update = parse({
    text: 'look at this',
    forward_origin: { type: 'user', sender_user: { id: 5, first_name: 'Jordan' } },
  });

  assert.equal(update.forwardedFrom, 'Jordan');
  assert.match(formatBotUpdate(update, 400), /↪from Jordan: /);
});

test('a forward from a hidden account is still attributed', () => {
  // "forwarded from someone hidden" is a different fact from "he wrote this".
  const update = parse({ text: 'x', forward_origin: { type: 'hidden_user', sender_user_name: 'Someone' } });
  assert.equal(update.forwardedFrom, 'Someone');
});

test('a forward from a channel keeps the author signature', () => {
  const update = parse({
    text: 'announcement',
    forward_origin: { type: 'channel', chat: { id: -100, title: 'Dev News' }, author_signature: 'Ann' },
  });
  assert.equal(update.forwardedFrom, 'Dev News (Ann)');
});

test('the legacy pre-Bot-API-7 forward fields still work', () => {
  // Older setups deliver these instead of forward_origin.
  assert.equal(parse({ text: 'a', forward_from: { id: 5, first_name: 'Old' } }).forwardedFrom, 'Old');
  assert.equal(parse({ text: 'a', forward_from_chat: { id: -1, title: 'Old Chat' } }).forwardedFrom, 'Old Chat');
  assert.equal(parse({ text: 'a', forward_sender_name: 'Hidden One' }).forwardedFrom, 'Hidden One');
});

test('an unknown forward origin type is reported rather than dropped', () => {
  // A future origin type must not silently read as the owner's own words.
  assert.match(parse({ text: 'a', forward_origin: { type: 'something_new' } }).forwardedFrom ?? '', /something_new/);
});

test('an ordinary message is not marked as forwarded', () => {
  const update = parse({ text: 'my own words' });

  assert.equal(update.forwardedFrom, undefined);
  assert.ok(!formatBotUpdate(update, 400).includes('↪'));
});

test('attribution survives a truncated body', () => {
  // Attribution decides how the message should be treated, so it must not be
  // the thing that gets cut when the text is long.
  const update = parse({
    text: 'x'.repeat(5000),
    forward_origin: { type: 'user', sender_user: { id: 5, first_name: 'Jordan' } },
  });

  const line = formatBotUpdate(update, 50);
  assert.ok(line.includes('↪from Jordan: '), 'attribution was lost to truncation');
  assert.ok(line.includes('[+'), 'body should still be truncated');
});

test('a forwarded voice note keeps both the media marker and the attribution', () => {
  const update = parse({
    voice: { file_id: 'abc', duration: 12, mime_type: 'audio/ogg' },
    forward_origin: { type: 'user', sender_user: { id: 5, first_name: 'Jordan' } },
  });

  const line = formatBotUpdate(update, 400);
  assert.ok(line.includes('↪from Jordan'), line);
  assert.ok(line.includes('[voice 12s]'), line);
});

// --- rich messages ----------------------------------------------------------
// The owner forwarded one and it read as "[unsupported content: rich_message]".
// Rich messages are how this tool sends tables, so it was producing a format it
// could not itself read back.

test('a forwarded rich message is read, not reported as unsupported', () => {
  const update = parse({
    rich_message: {
      blocks: [
        { type: 'paragraph', text: 'Release notes' },
        { type: 'table', cells: [[{ text: 'round' }, { text: 'findings' }], [{ text: '1' }, { text: '9' }]] },
      ],
    },
    forward_origin: { type: 'user', sender_user: { id: 5, first_name: 'Жордан' } },
  });

  assert.equal(update.text, 'Release notes\nround | findings\n1 | 9');
  assert.equal(update.attachment, undefined, 'it is readable, so it is not an unsupported attachment');
  assert.match(formatBotUpdate(update, 400), /↪from Жордан: /);
});

test('a table-only rich message still yields its rows', () => {
  const update = parse({
    rich_message: { blocks: [{ type: 'table', cells: [[{ text: 'a' }, { text: 'b' }]] }] },
  });
  assert.equal(update.text, 'a | b');
});

test('an unfamiliar block contributes its text rather than being dropped', () => {
  // Block formats grow; losing a paragraph to an unfamiliar wrapper is exactly
  // the silent loss this path exists to prevent.
  const update = parse({
    rich_message: { blocks: [{ type: 'heading_v2', text: 'Still readable' }] },
  });
  assert.equal(update.text, 'Still readable');
});

test('an unreadable block names its type instead of vanishing', () => {
  const update = parse({ rich_message: { blocks: [{ type: 'chart', data: [1, 2, 3] }] } });
  assert.equal(update.text, '[chart]');
});

test('a malformed rich message falls back to the unsupported description', () => {
  // Nothing readable at all: better to say so than to print a blank line.
  const update = parse({ rich_message: { blocks: 'not-an-array' } });
  assert.equal(update.text, '');
  assert.match(update.attachment ?? '', /rich_message/);
});

test('plain text still wins over a rich message when both are present', () => {
  const update = parse({ text: 'plain', rich_message: { blocks: [{ type: 'paragraph', text: 'rich' }] } });
  assert.equal(update.text, 'plain');
});

// Rich text is a node tree, not a string. A first attempt accepted only
// strings, so every paragraph rendered as an empty "[paragraph]" while tables
// (whose cells held plain strings) came through fine.

test('a paragraph whose text is a node tree is read', () => {
  const update = parse({
    rich_message: { blocks: [{ type: 'paragraph', text: { type: 'plain', text: 'Telegram skill' } }] },
  });
  assert.equal(update.text, 'Telegram skill');
});

test('concatenated and styled nodes are flattened in order', () => {
  const update = parse({
    rich_message: {
      blocks: [{
        type: 'paragraph',
        text: { type: 'concat', texts: [
          { type: 'plain', text: 'rich ' },
          { type: 'bold', text: { type: 'plain', text: 'messages' } },
          { type: 'plain', text: ' and dates' },
        ] },
      }],
    },
  });
  assert.equal(update.text, 'rich messages and dates');
});

test('a list yields its items as bullets', () => {
  const update = parse({
    rich_message: { blocks: [{ type: 'list', items: [
      { text: { type: 'plain', text: 'first' } },
      { text: { type: 'plain', text: 'second' } },
    ] }] },
  });
  assert.equal(update.text, '- first\n- second');
});

test('a list item made of nested blocks is read', () => {
  const update = parse({
    rich_message: { blocks: [{ type: 'list', items: [
      { blocks: [{ type: 'paragraph', text: 'nested body' }] },
    ] }] },
  });
  assert.equal(update.text, '- nested body');
});

test('table cells holding node trees are no longer blank', () => {
  // The observed bug: the middle column came through empty.
  const update = parse({
    rich_message: { blocks: [{ type: 'table', cells: [[
      { text: 'Rich-сообщение' },
      { text: { type: 'bold', text: { type: 'plain', text: 'markdown' } } },
      { text: { type: 'plain', text: 'server-parsed' } },
    ]] }] },
  });
  assert.equal(update.text, 'Rich-сообщение | markdown | server-parsed');
});

test('a custom emoji contributes what it stands for', () => {
  const update = parse({
    rich_message: { blocks: [{ type: 'paragraph', text: { type: 'custom_emoji', alt: '🔥' } }] },
  });
  assert.equal(update.text, '🔥');
});

test('a self-referential block cannot hang the parser', () => {
  const block: any = { type: 'paragraph' };
  block.text = { type: 'concat', texts: [block] };
  const update = parse({ rich_message: { blocks: [block] } });
  assert.equal(typeof update.text, 'string');
});
