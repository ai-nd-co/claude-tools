import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import {
  canonicalChatId, createTopicOnce, isDefiniteTopicRefusal, recordedTopic, topicRecordKey, validateTopicTitle, MAX_TOPIC_TITLE,
} from '../services/telegram-topics.js';
import { TelegramBotService } from '../services/telegram-bot.js';

async function inScratch(body: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'topic-test-'));
  try {
    await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const lost = async (): Promise<number> => { throw new Error('Telegram Bot API createForumTopic timed out after 30s'); };

test('a title is normalized the way Telegram stores it, required, and capped at 128 characters', () => {
  assert.equal(validateTopicTitle('  token revocation '), 'token revocation');
  assert.equal(validateTopicTitle('Release  \n planning\u00a0x'), 'Release planning x');
  assert.equal(validateTopicTitle('A\u2800B\u180EC\uFFFCD\u200BE\u0001F'), 'A B C D\u200BE F');
  assert.equal(validateTopicTitle('A\u0333B\u033FC\u030A'), 'ABC');
  assert.equal(validateTopicTitle('A\u{E0061}B\u3000C\u2009D'), 'A B C D');
  assert.equal(validateTopicTitle('A\r\nB\tC'), 'A B C');
  // What Telegram keeps, the record keeps: a BOM or zero-width space inside a name is not a space.
  assert.equal(validateTopicTitle('A\uFEFFB'), 'A\uFEFFB');
  assert.equal(validateTopicTitle('A\u200BB'), 'A\u200BB');
  assert.equal(validateTopicTitle('A\u200E\u200F\u200EB'), 'A\u200C\u200C\u200EB');
  assert.throws(() => validateTopicTitle('\u200B\uFEFF\u00A0'), /needs a title/);
  assert.throws(() => validateTopicTitle(' \n '), /needs a title/);
  assert.equal(validateTopicTitle('я'.repeat(MAX_TOPIC_TITLE)).length, MAX_TOPIC_TITLE);
  assert.throws(() => validateTopicTitle('x'.repeat(MAX_TOPIC_TITLE + 1)), /at most 128/);
});

test('the record key is the bot id and the numeric chat id; a username is refused', () => {
  assert.equal(topicRecordKey('12345:secret-part', ' -1002000000001 '), '12345:-1002000000001');
  assert.throws(() => topicRecordKey('not-a-token', '-1'), /malformed/);
  assert.throws(() => topicRecordKey('1:x', '@myforum'), /numeric chat id/);
  assert.equal(topicRecordKey('1:x', '-01001234567890'), topicRecordKey('1:x', '-1001234567890'));
  assert.equal(canonicalChatId(' -0100 '), '-100');
  assert.throws(() => canonicalChatId('99999999999999999999'), /out of range/);
});

test('a second create of the same title reuses the first topic', () => inScratch(async (dir) => {
  let calls = 0;
  const create = async () => { calls += 1; return 644; };
  assert.deepEqual(await createTopicOnce({ configDir: dir, key: '1:-100', title: 'token revocation', create }), { id: 644, reused: false });
  assert.deepEqual(await createTopicOnce({ configDir: dir, key: '1:-100', title: 'token revocation', create }), { id: 644, reused: true });
  assert.equal(calls, 1);
  await createTopicOnce({ configDir: dir, key: '1:-100', title: 'Other', create: async () => 645 });
  await createTopicOnce({ configDir: dir, key: '2:-100', title: 'token revocation', create: async () => 9 });
  assert.equal(recordedTopic(dir, '1:-100', 'Other'), 645);
  assert.equal(recordedTopic(dir, '2:-100', 'token revocation'), 9);
}));

test('titles spelled like object keys are ordinary rows', () => inScratch(async (dir) => {
  let calls = 0;
  for (const title of ['__proto__', 'constructor']) {
    const made = await createTopicOnce({ configDir: dir, key: '1:-100', title, create: async () => { calls += 1; return 100 + calls; } });
    assert.deepEqual(await createTopicOnce({ configDir: dir, key: '1:-100', title, create: async () => 999 }), { id: made.id, reused: true });
  }
  assert.equal(calls, 2);
}));

test('a refusal Telegram answered clears the mark, so a plain retry runs', () => inScratch(async (dir) => {
  const refused = async (): Promise<number> => { throw new Error('Telegram Bot API createForumTopic: Bad Request: not enough rights'); };
  await assert.rejects(createTopicOnce({ configDir: dir, key: '1:-100', title: 'T', create: refused, definite: isDefiniteTopicRefusal }), /not enough rights/);
  assert.equal(recordedTopic(dir, '1:-100', 'T'), undefined);
  assert.deepEqual(await createTopicOnce({ configDir: dir, key: '1:-100', title: 'T', create: async () => 7 }), { id: 7, reused: false });
}));

test('a lost reply keeps the title pending; the next create stops, --record or --retry resolves it', () => inScratch(async (dir) => {
  await assert.rejects(createTopicOnce({ configDir: dir, key: '1:-100', title: 'T', create: lost, definite: isDefiniteTopicRefusal }), /timed out/);
  assert.equal(recordedTopic(dir, '1:-100', 'T'), 'pending');
  let calls = 0;
  const create = async () => { calls += 1; return 1; };
  await assert.rejects(createTopicOnce({ configDir: dir, key: '1:-100', title: 'T', create }), /--record <id>.*--retry/s);
  assert.equal(calls, 0);
  assert.deepEqual(await createTopicOnce({ configDir: dir, key: '1:-100', title: 'T', create, record: 644 }), { id: 644, reused: true });
  assert.equal(recordedTopic(dir, '1:-100', 'T'), 644);
  await assert.rejects(createTopicOnce({ configDir: dir, key: '1:-100', title: 'U', create: lost, definite: isDefiniteTopicRefusal }));
  assert.deepEqual(await createTopicOnce({ configDir: dir, key: '1:-100', title: 'U', create: async () => 9, retry: true }), { id: 9, reused: false });
}));

test('while a create runs, every other create and override is refused, never raced', () => inScratch(async (dir) => {
  let release!: (id: number) => void;
  const first = createTopicOnce({ configDir: dir, key: '1:-100', title: 'A', create: () => new Promise<number>((resolve) => { release = resolve; }) });
  let calls = 0;
  const other = async () => { calls += 1; return 2; };
  for (const attempt of [
    { title: 'A' }, { title: 'B' }, { title: 'A', retry: true }, { title: 'A', record: 5 },
  ]) {
    await assert.rejects(createTopicOnce({ configDir: dir, key: '1:-100', create: other, ...attempt }), /Another topic create is running/);
  }
  release(1);
  assert.deepEqual(await first, { id: 1, reused: false });
  assert.equal(calls, 0);
  assert.equal(recordedTopic(dir, '1:-100', 'A'), 1);
}));

test('a result is written only over its own attempt; a changed record is reported, not overwritten', () => inScratch(async (dir) => {
  const result = createTopicOnce({
    configDir: dir, key: '1:-100', title: 'A',
    create: async () => {
      // Someone edits the row while the request is out (not possible through the CLI, which holds the lock).
      const db = new Database(join(dir, 'telegram-topics.db'));
      db.prepare("UPDATE topics SET topic_id = 77, state = 'created' WHERE title = 'A'").run();
      db.close();
      return 1;
    },
  });
  await assert.rejects(result, /Topic 1 was created, but the record .* changed meanwhile/);
  assert.equal(recordedTopic(dir, '1:-100', 'A'), 77);
}));

test('only a client-error answer from Telegram counts as a definite refusal', () => {
  const definite = (m: string) => isDefiniteTopicRefusal(new Error(m));
  assert.equal(definite('Telegram Bot API createForumTopic: Bad Request: chat not found'), true);
  assert.equal(definite('Telegram Bot API createForumTopic: Forbidden: bot is not a member'), true);
  assert.equal(definite('Telegram rejected the bot token. Check …'), true);
  assert.equal(definite('Telegram rate limit; retry after 3s: Too Many Requests'), true);
  assert.equal(definite('Telegram Bot API createForumTopic: Bad Request: Invalid result received'), false);
  assert.equal(definite('Telegram Bot API createForumTopic timed out after 30s'), false);
  assert.equal(definite('Telegram Bot API createForumTopic failed: fetch failed'), false);
  assert.equal(definite('Telegram Bot API createForumTopic: non-JSON response'), false);
  assert.equal(definite('Telegram Bot API createForumTopic: Internal Server Error'), false);
  assert.equal(definite('Telegram Bot API createForumTopic: HTTP 502'), false);
});

test('createForumTopic sends chat and name and returns the thread id', async () => {
  const seen: { method: string; body: any }[] = [];
  const service = new TelegramBotService('1:fake', async (method, body) => { seen.push({ method, body }); return { message_thread_id: 644, name: 'x' }; });
  assert.equal(await service.createForumTopic('-1002000000001', 'token revocation'), 644);
  assert.deepEqual(seen, [{ method: 'createForumTopic', body: { chat_id: '-1002000000001', name: 'token revocation' } }]);
  const empty = new TelegramBotService('1:fake', async () => ({}));
  await assert.rejects(empty.createForumTopic('-1', 'x'), /no topic id/);
});
