import test from 'node:test';
import assert from 'node:assert/strict';
import { renderTgMessages, renderTgEvent, MAX_VOICES_PER_BATCH } from '../services/hub-telegram.js';

const voice = (messageId: number, durationSec: number) => ({
  kind: 'tg',
  body: JSON.stringify({ v: 1, bot: 'personal', type: 'message', chat: { id: '100000001', type: 'private' }, messageId,
    sender: { id: '100000001', name: 'Davron' }, file: { kind: 'voice', fileId: `F${messageId}`, durationSec } }),
});

test('a voice note is transcribed into the line, with the ids a reply needs', async () => {
  const [line] = await renderTgMessages([voice(2350, 31)], async (event) => ({ text: `heard ${event.file?.fileId}` }));
  assert.equal(line!.body, 'Davron [id 100000001] (msg 2350, chat 100000001): 🎤 31s "heard F2350"');
});

test('the bot watch limits hold: over three minutes is not fetched, and at most three per batch', async () => {
  const asked: string[] = [];
  const lines = await renderTgMessages([voice(1, 181), voice(2, 5), voice(3, 5), voice(4, 5), voice(5, 5)], async (event) => {
    asked.push(event.file!.fileId!);
    return { text: 'ok' };
  });
  assert.deepEqual(asked, ['F2', 'F3', 'F4']);
  assert.match(lines[0]!.body, /longer than 180s; file F1/);
  assert.match(lines[4]!.body, new RegExp(`more than ${MAX_VOICES_PER_BATCH} voice notes at once; file F5`));
});

test('a failed transcription still shows the file id, and other messages pass untouched', async () => {
  const other = { kind: 'msg', body: 'plain hub message' };
  const lines = await renderTgMessages([voice(9, 4), other], async () => { throw new Error('speech cluster down'); });
  assert.match(lines[0]!.body, /transcription failed: speech cluster down; file F9/);
  assert.deepEqual(lines[1], other);
});

test('text, topic, reply and edits read as a sentence, and broken JSON keeps the original body', async () => {
  assert.equal(
    renderTgEvent({ type: 'edited_message', chat: { id: '-1002000000001' }, threadId: 3, messageId: 15, replyToMessageId: 14, sender: { name: 'Davron' }, text: 'status?' }),
    'Davron [no sender id] (edited) (msg 15, chat -1002000000001, topic 3, reply to 14): status?',
  );
  const broken = { kind: 'tg', body: 'not json' };
  assert.deepEqual(await renderTgMessages([broken], async () => ({ text: 'x' })), [broken]);
});

test('a slow transcription gives way to the line at once, and its text follows in its own line', async () => {
  let release!: (value: { text: string }) => void;
  const pending = new Promise<{ text: string }>((resolve) => { release = resolve; });
  const late: string[] = [];
  const started = Date.now();
  const [line] = await renderTgMessages([voice(7, 5)], () => pending, 50, (event, t) => late.push(`${event.messageId}:${t.text}`), 2_000);
  assert.ok(Date.now() - started < 1_000);
  assert.match(line!.body, /transcribing; the text follows in its own line; file F7/);
  release({ text: 'hello later' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(late, ['7:hello later']);
});

test('a transcription that never ends is reported as given up at the hard limit', async () => {
  const late: string[] = [];
  await renderTgMessages([voice(8, 5)], () => new Promise(() => {}), 20, (_e, t) => late.push(t.error ?? ''), 60);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(late, ['transcription gave up after 0s']);
});

test('without a late handler a slow transcription is reported as timed out, never silently', async () => {
  const [line] = await renderTgMessages([voice(9, 5)], () => new Promise(() => {}), 20);
  assert.match(line!.body, /transcription took over 0s; file F9/);
});

test('an event of an unexpected shape falls back to its JSON instead of throwing', async () => {
  const odd = { kind: 'tg', body: JSON.stringify({ file: null, sender: 7 }) };
  const [line] = await renderTgMessages([odd], async () => ({ text: 'x' }));
  assert.ok(typeof line!.body === 'string');
});

test('a reply shows what it answers, and a forward where it came from', () => {
  assert.equal(
    renderTgEvent({ type: 'message', chat: { id: '-100' }, threadId: 3, messageId: 21, replyToMessageId: 18, replyToSender: 'DavronPersonalBot',
      replyToText: 'Received here\nonly', sender: { name: 'Davron' }, text: 'good' }),
    'Davron [no sender id] (msg 21, chat -100, topic 3, reply to 18): good [replying to DavronPersonalBot: "Received here only"]',
  );
  assert.equal(
    renderTgEvent({ type: 'message', chat: { id: '1' }, messageId: 5, forwardedFrom: 'Priya', sender: { name: 'Davron' }, text: 'see this' }),
    'Davron [no sender id] (msg 5, chat 1) [forwarded from Priya]: see this',
  );
});

test('every line names the sender by Telegram id as well as name, including button presses', () => {
  assert.equal(
    renderTgEvent({ type: 'message', chat: { id: '-100' }, threadId: 4, messageId: 9, sender: { id: '5550001', name: 'Davron' }, text: 'merge it' }),
    'Davron [id 5550001] (msg 9, chat -100, topic 4): merge it',
  );
  assert.equal(
    renderTgEvent({ type: 'callback_query', chat: { id: '-100' }, messageId: 9, sender: { id: '777', name: 'Colleague' }, callback: { data: 'ok' } }),
    'Colleague [id 777] pressed a button (msg 9, chat -100): ok',
  );
});

test('a message in a topic no agent has says whether it is held, and how to link the topic', () => {
  const held = renderTgEvent({ bot: 'personal', type: 'message', chat: { id: '-1002000000001' }, threadId: 3847, messageId: 40, sender: { id: '100000001', name: 'Davron' }, withheld: 'unrouted-topic', held: true });
  assert.match(held, /topic 3847 has no agent yet: the message is held/);
  // The bot is named, and the negative chat id sits after `--`, so the command links under the right bot and parses.
  assert.match(held, /bot topic link --bot personal --as <you> -- -1002000000001 3847 <agent>/);
  const dropped = renderTgEvent({ type: 'message', chat: { id: '-1002000000001' }, threadId: 3847, messageId: 40, sender: { id: '100000001', name: 'Davron' }, withheld: 'unrouted-topic' });
  assert.match(dropped, /content was withheld and is not kept/);
});
