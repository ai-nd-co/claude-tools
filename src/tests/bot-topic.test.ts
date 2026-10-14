import test from 'node:test';
import assert from 'node:assert/strict';
import { topicTransport } from '../commands/telegram-bot/index.js';
import { TelegramBotService } from '../services/telegram-bot.js';

test('a topic post needs a topic id and the caller named outright', () => {
  assert.throws(() => topicTransport('personal', '3', undefined), /pass --as/);
  assert.throws(() => topicTransport('personal', '3', '  '), /pass --as/);
  for (const bad of ['0', '-3', '2e1', 'x']) assert.throws(() => topicTransport('personal', bad, 'agent-hub'), /--topic must be a forum topic id/);
});

test('with a transport every call goes through it, never to the token, and carries the topic', async () => {
  const seen: { method: string; body: any }[] = [];
  const service = new TelegramBotService('123:fake-token-never-used', async (method, body) => { seen.push({ method, body }); return { message_id: 7 }; });
  const id = await service.sendMessage('-1002000000001', 'hello', { format: 'plain', threadId: 3 });
  assert.equal(id, 7);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.method, 'sendMessage');
  assert.equal(seen[0]!.body.message_thread_id, 3);
  assert.ok(!JSON.stringify(seen).includes('fake-token'));
  const rich = await service.sendMessage('-1002000000001', '**hi**', { format: 'rich', threadId: 3 });
  assert.equal(rich, 7);
  assert.equal(seen[1]!.method, 'sendRichMessage');
  assert.equal(seen[1]!.body.message_thread_id, 3);
});
