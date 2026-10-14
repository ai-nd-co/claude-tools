import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  MAX_BOT_UPLOAD_BYTES,
  TelegramBotService,
  appendBotLog,
  assertStateOwnership,
  claimBotState,
  botLogPath,
  loadBotOffset,
  readBotLog,
  readSentMessage,
  readSpeakableText,
  recordSentMessage,
  redactBotToken,
  saveBotOffset,
  stashSpeakableText,
  writeAll,
  type BotUpdate,
} from '../services/telegram-bot.js';
import { formatBotUpdate, registerBotCommands } from '../commands/telegram-bot/index.js';
import { Command } from 'commander';

const TOKEN = 'test-bot-token-not-a-real-credential';

/** Isolate the config dir so tests never touch the real bot state. */
function withConfigDir(run: (dir: string) => Promise<void> | void) {
  return async () => {
    const previous = process.env.CLAUDE_TOOLS_CONFIG_DIR;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-state-test-'));
    process.env.CLAUDE_TOOLS_CONFIG_DIR = dir;
    try {
      await run(dir);
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_TOOLS_CONFIG_DIR;
      else process.env.CLAUDE_TOOLS_CONFIG_DIR = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

interface StubCall {
  method: string;
  body: any;
}

/** Replace global fetch with a scripted Bot API. */
function stubApi(handler: (call: StubCall) => { status?: number; body: unknown }) {
  const calls: StubCall[] = [];
  const original = globalThis.fetch;

  globalThis.fetch = (async (url: any, init: any) => {
    const method = String(url).split('/').pop() ?? '';
    const call: StubCall = { method, body: init?.body ? JSON.parse(init.body) : undefined };
    calls.push(call);

    const { status = 200, body } = handler(call);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as any;
  }) as any;

  return { calls, restore: () => { globalThis.fetch = original; } };
}

function update(overrides: Partial<BotUpdate> = {}): BotUpdate {
  return {
    updateId: 1,
    chatId: '100000001',
    chatTitle: 'Sherbaev',
    chatType: 'private',
    messageId: 10,
    date: new Date(Date.UTC(2026, 8, 24, 21, 40)),
    sender: 'sherbaev',
    text: 'hello bot',
    ...overrides,
  };
}

// --- token safety -----------------------------------------------------------

test('redacts the configured token', () => {
  const leaked = `GET https://api.telegram.org/bot${TOKEN}/getUpdates failed`;
  const safe = redactBotToken(leaked, TOKEN);

  assert.ok(!safe.includes(TOKEN));
  assert.match(safe, /<bot-token>/);
});

test('redacts a token that is not the configured one', () => {
  // A pasted or stale token must not survive into a log either.
  const other = '111111111:BBWrongTokenButStillASecret_padpadpadpad'; // shape only, never issued
  const safe = redactBotToken(`oops ${other}`, TOKEN);

  assert.ok(!safe.includes(other));
});

test('an auth failure names the setting, never the token', async () => {
  const stub = stubApi(() => ({ status: 401, body: { ok: false, error_code: 401, description: 'Unauthorized' } }));
  try {
    await assert.rejects(
      () => new TelegramBotService(TOKEN).getMe(),
      (err: Error) => {
        assert.ok(!err.message.includes(TOKEN), 'the token must not reach the message');
        assert.match(err.message, /TELEGRAM_BOT_TOKEN|telegramBot\.token/);
        return true;
      },
    );
  } finally {
    stub.restore();
  }
});

test('a second poller is reported as a conflict, not a silent stall', async () => {
  const stub = stubApi(() => ({ status: 409, body: { ok: false, error_code: 409, description: 'Conflict' } }));
  try {
    await assert.rejects(() => new TelegramBotService(TOKEN).getUpdates(), /already polling|409/i);
  } finally {
    stub.restore();
  }
});

// --- update parsing ---------------------------------------------------------

test('parses a text message', async () => {
  const stub = stubApi(() => ({
    body: {
      ok: true,
      result: [{
        update_id: 42,
        message: {
          message_id: 7,
          date: Math.floor(Date.UTC(2026, 8, 24, 21, 40) / 1000),
          chat: { id: 100000001, type: 'private', first_name: 'Davron', last_name: 'Sherbaev' },
          from: { id: 100000001, username: 'sherbaev', first_name: 'Davron' },
          text: 'implement the bot',
        },
      }],
    },
  }));
  try {
    const { messages: [u] } = await new TelegramBotService(TOKEN).getUpdates();

    assert.equal(u.updateId, 42);
    assert.equal(u.chatId, '100000001');
    assert.equal(u.messageId, 7);
    assert.equal(u.sender, 'sherbaev');
    assert.equal(u.text, 'implement the bot');
    assert.equal(u.edited, undefined);
  } finally {
    stub.restore();
  }
});

test('parses a voice note and an edit', async () => {
  const stub = stubApi(() => ({
    body: {
      ok: true,
      result: [
        {
          update_id: 43,
          message: {
            message_id: 8,
            date: 1790000000,
            chat: { id: 1, type: 'private', first_name: 'D' },
            from: { id: 1, first_name: 'D' },
            voice: { file_id: 'AwACAgIx', duration: 13, mime_type: 'audio/ogg', file_size: 4096 },
          },
        },
        {
          update_id: 44,
          edited_message: {
            message_id: 9,
            date: 1790000000,
            edit_date: 1790000060,
            chat: { id: 1, type: 'private', first_name: 'D' },
            from: { id: 1, first_name: 'D' },
            text: 'fixed typo',
          },
        },
      ],
    },
  }));
  try {
    const { messages: [voiceUpdate, editUpdate] } = await new TelegramBotService(TOKEN).getUpdates();

    assert.equal(voiceUpdate.voice?.fileId, 'AwACAgIx');
    assert.equal(voiceUpdate.voice?.duration, 13);
    assert.equal(voiceUpdate.voice?.kind, 'voice');
    assert.equal(editUpdate.edited, true);
    assert.equal(editUpdate.text, 'fixed typo');
  } finally {
    stub.restore();
  }
});

test('ignores non-message updates but still reports a cursor past them', async () => {
  // Dropping their ids too would leave the offset stuck, and the watcher would
  // refetch the same batch forever.
  const stub = stubApi(() => ({
    body: { ok: true, result: [{ update_id: 50, callback_query: { id: 'x' } }, { update_id: 51, poll: { id: 'y' } }] },
  }));
  try {
    const batch = await new TelegramBotService(TOKEN).getUpdates();

    assert.deepEqual(batch.messages, []);
    assert.equal(batch.cursor, 51, 'the cursor must cover ignored updates');
    assert.equal(batch.received, 2);
  } finally {
    stub.restore();
  }
});

test('an empty batch has no cursor', async () => {
  const stub = stubApi(() => ({ body: { ok: true, result: [] } }));
  try {
    const batch = await new TelegramBotService(TOKEN).getUpdates();

    assert.equal(batch.cursor, null);
    assert.equal(batch.received, 0);
  } finally {
    stub.restore();
  }
});

test('requests messages and button presses, and outlives its own long poll', async () => {
  const stub = stubApi(() => ({ body: { ok: true, result: [] } }));
  try {
    await new TelegramBotService(TOKEN).getUpdates({ offset: 99, timeoutSec: 25 });

    assert.equal(stub.calls[0].method, 'getUpdates');
    assert.equal(stub.calls[0].body.offset, 99);
    assert.equal(stub.calls[0].body.timeout, 25);
    // Button presses must be requested explicitly, or a Listen button does nothing.
    assert.deepEqual(stub.calls[0].body.allowed_updates, ['message', 'edited_message', 'callback_query']);
  } finally {
    stub.restore();
  }
});

// --- sending ----------------------------------------------------------------

test('sendMessage passes the reply target and returns the new id', async () => {
  const stub = stubApi(() => ({ body: { ok: true, result: { message_id: 123 } } }));
  try {
    const id = await new TelegramBotService(TOKEN).sendMessage('100000001', 'done', { replyToId: 7, silent: true });

    assert.equal(id, 123);
    assert.equal(stub.calls[0].body.chat_id, '100000001');
    assert.equal(stub.calls[0].body.reply_to_message_id, 7);
    assert.equal(stub.calls[0].body.disable_notification, true);
    // Plain text by default: an unescaped Markdown body would be rejected.
    assert.equal(stub.calls[0].body.parse_mode, undefined);
  } finally {
    stub.restore();
  }
});

test('downloadFile refuses a file over the Bot API cap before fetching it', async () => {
  const stub = stubApi(() => ({
    body: { ok: true, result: { file_id: 'big', file_path: 'voice/x.oga', file_size: 21 * 1024 * 1024 } },
  }));
  try {
    await assert.rejects(
      () => new TelegramBotService(TOKEN).downloadFile('big', os.tmpdir()),
      /caps downloads at 20 MB/,
    );
    assert.equal(stub.calls.length, 1, 'only getFile should have been called');
  } finally {
    stub.restore();
  }
});

// --- state: offset and log --------------------------------------------------

test('offset round-trips', withConfigDir(() => {
  assert.equal(loadBotOffset('babysit'), null);
  saveBotOffset('babysit', 4242);
  assert.equal(loadBotOffset('babysit'), 4242);
}));

test('a corrupt offset re-baselines instead of wedging the watcher', withConfigDir(() => {
  saveBotOffset('babysit', 10);
  fs.writeFileSync(path.join(path.dirname(botLogPath('babysit')), 'offset.json'), '{ broken');

  assert.equal(loadBotOffset('babysit'), null);
}));

test('state namespaces are independent', withConfigDir(() => {
  saveBotOffset('agent-a', 1);
  saveBotOffset('agent-b', 999);

  assert.equal(loadBotOffset('agent-a'), 1);
  assert.equal(loadBotOffset('agent-b'), 999);
}));

test('the log appends and reads back in order', withConfigDir(() => {
  appendBotLog('babysit', [update({ updateId: 1, messageId: 1, text: 'first' })]);
  appendBotLog('babysit', [
    update({ updateId: 2, messageId: 2, text: 'second' }),
    update({ updateId: 3, messageId: 3, text: 'third' }),
  ]);

  const all = readBotLog('babysit', 10);
  assert.deepEqual(all.map((u) => u.text), ['first', 'second', 'third']);
  assert.ok(all[0].date instanceof Date, 'dates come back as Date objects');
}));

test('the log returns the newest entries when limited', withConfigDir(() => {
  appendBotLog('babysit', [1, 2, 3, 4, 5].map((n) => update({ updateId: n, messageId: n, text: `m${n}` })));

  assert.deepEqual(readBotLog('babysit', 2).map((u) => u.text), ['m4', 'm5']);
}));

test('a torn log line is skipped, not fatal', withConfigDir(() => {
  appendBotLog('babysit', [update({ text: 'good' })]);
  fs.writeFileSync(botLogPath('babysit'), '{ half written\n', { flag: 'a' });
  appendBotLog('babysit', [update({ updateId: 2, messageId: 2, text: 'also good' })]);

  assert.deepEqual(readBotLog('babysit', 10).map((u) => u.text), ['good', 'also good']);
}));

test('an empty append writes nothing', withConfigDir(() => {
  appendBotLog('babysit', []);
  assert.equal(fs.existsSync(botLogPath('babysit')), false);
  assert.deepEqual(readBotLog('babysit', 10), []);
}));

test('reading a log that does not exist is empty, not an error', withConfigDir(() => {
  assert.deepEqual(readBotLog('never-used', 10), []);
}));

// --- event formatting -------------------------------------------------------

test('formats a text message like the account watcher', () => {
  const line = formatBotUpdate(update({ text: 'hello bot' }), 400);

  assert.match(line, /^\[tg-bot\] Sherbaev \(100000001\) #10 \d{2}:\d{2} sherbaev: hello bot$/);
});

test('formats a voice note with its length and transcript', () => {
  const line = formatBotUpdate(
    update({ text: '', voice: { fileId: 'f', duration: 13.4, kind: 'voice' }, transcript: 'implement the bot' }),
    400,
  );

  assert.match(line, /\[voice 13s\] "implement the bot"/);
});

test('formats an untranscribed clip as a bare tag', () => {
  const line = formatBotUpdate(update({ text: '', voice: { fileId: 'f', duration: 185, kind: 'voice' } }), 400);

  assert.match(line, /\[voice 185s\]$/);
  assert.ok(!line.includes('"'));
});

test('marks an edit and a reply', () => {
  const line = formatBotUpdate(update({ edited: true, replyToId: 5, text: 'fixed' }), 400);

  assert.match(line, /✎\d{2}:\d{2}/);
  assert.match(line, /↩5/);
});

test('names a non-audio attachment', () => {
  const line = formatBotUpdate(update({ text: '', attachment: 'document notes.pdf' }), 400);

  assert.match(line, /\[document notes\.pdf\]$/);
});

test('folds newlines and truncates long text', () => {
  const line = formatBotUpdate(update({ text: `${'x'.repeat(500)}\nsecond line` }), 20);

  assert.ok(!line.includes('\n'), 'an event must stay on one line');
  assert.match(line, /\[\+\d+ chars\]/);
});

// --- audit regressions ------------------------------------------------------

test('a torn trailing record does not swallow the next message', withConfigDir(() => {
  // A crash can leave a truncated object with no newline. Appending onto it
  // would fuse the fragment with the replayed record, and Telegram will never
  // resend that message.
  appendBotLog('babysit', [update({ updateId: 1, messageId: 1, text: 'before crash' })]);
  fs.writeFileSync(botLogPath('babysit'), '{"updateId":2,"text":"truncated', { flag: 'a' });

  appendBotLog('babysit', [update({ updateId: 3, messageId: 3, text: 'replayed after restart' })]);

  const texts = readBotLog('babysit', 10).map((u) => u.text);
  assert.ok(texts.includes('before crash'));
  assert.ok(texts.includes('replayed after restart'), 'the replayed record must survive the torn tail');
}));

test('a failed append throws so the caller cannot confirm the batch', withConfigDir((dir) => {
  // Confirming an unlogged batch destroys it: Telegram forgets it for good.
  const blocker = path.join(dir, 'blocked');
  fs.writeFileSync(blocker, 'not a directory');
  process.env.CLAUDE_TOOLS_CONFIG_DIR = path.join(blocker, 'cfg');

  assert.throws(() => appendBotLog('babysit', [update()]));
}));

test('rejects an offset that is not a positive integer', withConfigDir(() => {
  const offsetFile = path.join(path.dirname(botLogPath('babysit')), 'offset.json');
  fs.mkdirSync(path.dirname(offsetFile), { recursive: true });

  // A negative offset has destructive queue-tail semantics in the Bot API.
  for (const bad of ['{"offset":-1}', '{"offset":0}', '{"offset":1.5}', '{"offset":"12"}', '{}']) {
    fs.writeFileSync(offsetFile, bad);
    assert.equal(loadBotOffset('babysit'), null, `${bad} should be rejected`);
  }

  fs.writeFileSync(offsetFile, '{"offset":7}');
  assert.equal(loadBotOffset('babysit'), 7);
}));

test('read filters by chat before applying the limit', withConfigDir(() => {
  // A busy chat must not hide older messages from the requested one.
  appendBotLog('babysit', [update({ updateId: 1, messageId: 1, chatId: '111', text: 'wanted, oldest' })]);
  appendBotLog('babysit', Array.from({ length: 80 }, (_, i) =>
    update({ updateId: 100 + i, messageId: 100 + i, chatId: '222', text: `noise ${i}` })));
  appendBotLog('babysit', [update({ updateId: 999, messageId: 999, chatId: '111', text: 'wanted, newest' })]);

  const wanted = readBotLog('babysit', 20, '111');
  assert.deepEqual(wanted.map((u) => u.text), ['wanted, oldest', 'wanted, newest']);
}));

test('a download timeout is reported without the token', async () => {
  const stub = stubApi((call) => call.method === 'getFile'
    ? { body: { ok: true, result: { file_id: 'f', file_path: 'voice/x.oga', file_size: 1024 } } }
    : { body: { ok: true, result: {} } });
  const originalFetch = globalThis.fetch;
  try {
    // getFile succeeds through the stub; the file fetch hangs until aborted.
    globalThis.fetch = (async (url: any, init: any) => {
      if (String(url).includes('/file/bot')) {
        return await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }
      return originalFetch(url, init);
    }) as any;

    await assert.rejects(
      () => new TelegramBotService(TOKEN).downloadFile('f', os.tmpdir(), 50),
      (err: Error) => {
        assert.match(err.message, /timed out/);
        assert.ok(!err.message.includes(TOKEN));
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
    stub.restore();
  }
});

test('a rate-limit message is redacted too', async () => {
  const stub = stubApi(() => ({
    status: 429,
    body: { ok: false, error_code: 429, description: `slow down ${TOKEN}`, parameters: { retry_after: 3 } },
  }));
  try {
    await assert.rejects(
      () => new TelegramBotService(TOKEN).getUpdates(),
      (err: Error) => {
        assert.match(err.message, /rate limit/i);
        assert.ok(!err.message.includes(TOKEN), '429 descriptions are upstream text and must be redacted');
        return true;
      },
    );
  } finally {
    stub.restore();
  }
});

test('the upload filename normalises Telegram’s .oga to .ogg', async () => {
  // Telegram serves bot voice notes as .oga; Groq accepts .ogg but 400s on .oga,
  // so every bot voice note failed until the name was normalised.
  const { uploadFilename } = await import('../commands/transcribe/groq.js');

  assert.equal(uploadFilename('/tmp/x/AwACAgIAAx.oga'), 'AwACAgIAAx.ogg');
  assert.equal(uploadFilename('/tmp/x/clip.OGA'), 'clip.ogg');
  assert.equal(uploadFilename('/tmp/x/clip.ogg'), 'clip.ogg');
  assert.equal(uploadFilename('/tmp/x/clip.mp3'), 'clip.mp3');
  assert.equal(uploadFilename('/tmp/x/no.dots.here.wav'), 'no.dots.here.wav');
});

test('a partial write is retried until every byte lands', withConfigDir((dir) => {
  // writeSync may store only a prefix when the disk is nearly full. Stopping
  // there would let the watcher confirm updates it only partly stored.
  const target = path.join(dir, 'partial.txt');
  const fd = fs.openSync(target, 'a');
  try {
    // Write at most 3 bytes per call, so the loop has to go round several times.
    writeAll(fd, 'a durable record\n', (f, buf, off, len) =>
      fs.writeSync(f, buf, off, Math.min(3, len)));
  } finally {
    fs.closeSync(fd);
  }

  assert.equal(fs.readFileSync(target, 'utf-8'), 'a durable record\n');
}));

test('a zero-progress write throws instead of silently truncating', withConfigDir((dir) => {
  const target = path.join(dir, 'stuck.txt');
  const fd = fs.openSync(target, 'a');
  try {
    assert.throws(() => writeAll(fd, 'never stored', () => 0), /Short write/);
  } finally {
    fs.closeSync(fd);
  }

  assert.equal(fs.readFileSync(target, 'utf-8'), '', 'nothing should have been stored');
}));

test('typing is sent as a chat action', async () => {
  const stub = stubApi(() => ({ body: { ok: true, result: true } }));
  try {
    await new TelegramBotService(TOKEN).sendTyping('100000001');

    assert.equal(stub.calls[0].method, 'sendChatAction');
    assert.equal(stub.calls[0].body.action, 'typing');
    assert.equal(stub.calls[0].body.chat_id, '100000001');
  } finally {
    stub.restore();
  }
});

test('keepTyping refreshes before the five-second expiry', async () => {
  const stub = stubApi(() => ({ body: { ok: true, result: true } }));
  try {
    await new TelegramBotService(TOKEN).keepTyping('1', 9);

    // Telegram clears the indicator after ~5s, so 9s needs more than one call.
    assert.ok(stub.calls.length >= 2, `expected a refresh, saw ${stub.calls.length} call(s)`);
    assert.ok(stub.calls.every((c) => c.method === 'sendChatAction'));
  } finally {
    stub.restore();
  }
});

test('keepTyping gives up quietly when the API refuses', async () => {
  // An indicator must never break the work it decorates.
  const stub = stubApi(() => ({ status: 403, body: { ok: false, error_code: 403, description: 'blocked' } }));
  try {
    await assert.doesNotReject(() => new TelegramBotService(TOKEN).keepTyping('1', 9));
    assert.equal(stub.calls.length, 1, 'it should stop after the first failure');
  } finally {
    stub.restore();
  }
});

// --- bot-owned state, and downloadable attachments --------------------------

test('an offset file records which bot owns it', withConfigDir(() => {
  saveBotOffset('shared', 100, { name: 'assistant' });
  assert.equal(loadBotOffset('shared', { name: 'assistant' }), 100);
}));

test('another bot cannot read a state that is not its own', withConfigDir(() => {
  // Submitting one bot's offset to another's queue confirms updates that bot
  // never saw, and Telegram never resends a confirmed update.
  saveBotOffset('shared', 100, { name: 'assistant' });

  assert.throws(() => loadBotOffset('shared', { name: 'personal' }), /already belongs to bot "assistant"/);
}));

test('ownership is compared case-insensitively', withConfigDir(() => {
  saveBotOffset('shared', 100, { name: 'Assistant' });
  assert.equal(loadBotOffset('shared', { name: 'assistant' }), 100);
}));

test('a legacy offset with no owner is adopted, then stamped', withConfigDir(() => {
  // An already-running watcher must keep its place across the upgrade.
  const offsetFile = path.join(path.dirname(botLogPath('babysit')), 'offset.json');
  fs.mkdirSync(path.dirname(offsetFile), { recursive: true });
  fs.writeFileSync(offsetFile, JSON.stringify({ offset: 4242 }));

  assert.equal(loadBotOffset('babysit', { name: 'assistant' }, { adopt: true }), 4242, 'an unowned offset is usable');

  saveBotOffset('babysit', 4243, { name: 'assistant' });
  assert.equal(JSON.parse(fs.readFileSync(offsetFile, 'utf8')).bot, 'assistant');
  assert.throws(() => loadBotOffset('babysit', { name: 'personal' }), /already belongs/);
}));

test('reading without naming a bot ignores ownership', withConfigDir(() => {
  saveBotOffset('shared', 7, { name: 'assistant' });
  assert.equal(loadBotOffset('shared'), 7);
}));

test('a photo is exposed at its largest size', async () => {
  // Telegram lists sizes smallest first; a screenshot is illegible at thumbnail.
  const stub = stubApi(() => ({
    body: {
      ok: true,
      result: [{
        update_id: 60,
        message: {
          message_id: 38,
          date: 1790000000,
          chat: { id: 1, type: 'private', first_name: 'D' },
          from: { id: 1, first_name: 'D' },
          photo: [
            { file_id: 'small', width: 90, height: 160, file_size: 1000 },
            { file_id: 'large', width: 1080, height: 1920, file_size: 200000 },
          ],
        },
      }],
    },
  }));
  try {
    const { messages: [u] } = await new TelegramBotService(TOKEN).getUpdates();

    assert.equal(u.file?.fileId, 'large');
    assert.equal(u.file?.kind, 'photo');
    assert.equal(u.file?.width, 1080);
    assert.equal(u.attachment, 'photo');
  } finally {
    stub.restore();
  }
});

test('a document is exposed with its name and type', async () => {
  const stub = stubApi(() => ({
    body: {
      ok: true,
      result: [{
        update_id: 61,
        message: {
          message_id: 39,
          date: 1790000000,
          chat: { id: 1, type: 'private', first_name: 'D' },
          from: { id: 1, first_name: 'D' },
          document: { file_id: 'doc1', file_name: 'report.pdf', mime_type: 'application/pdf', file_size: 5000 },
          caption: 'have a look',
        },
      }],
    },
  }));
  try {
    const { messages: [u] } = await new TelegramBotService(TOKEN).getUpdates();

    assert.equal(u.file?.fileId, 'doc1');
    assert.equal(u.file?.kind, 'document');
    assert.equal(u.file?.filename, 'report.pdf');
    assert.equal(u.text, 'have a look', 'a caption is the message text');
  } finally {
    stub.restore();
  }
});

test('a voice note exposes no separate file reference', async () => {
  // Voice already has its own field; duplicating it would double-download.
  const stub = stubApi(() => ({
    body: {
      ok: true,
      result: [{
        update_id: 62,
        message: {
          message_id: 40,
          date: 1790000000,
          chat: { id: 1, type: 'private', first_name: 'D' },
          from: { id: 1, first_name: 'D' },
          voice: { file_id: 'v1', duration: 5 },
        },
      }],
    },
  }));
  try {
    const { messages: [u] } = await new TelegramBotService(TOKEN).getUpdates();

    assert.equal(u.voice?.fileId, 'v1');
    assert.equal(u.file, undefined);
    assert.equal(u.attachment, undefined);
  } finally {
    stub.restore();
  }
});

test('the project style is rendered as HTML when sending', async () => {
  const stub = stubApi(() => ({ body: { ok: true, result: { message_id: 1 } } }));
  try {
    await new TelegramBotService(TOKEN).sendMessage('1', '__*Done*__\nsee `x`');

    assert.equal(stub.calls[0].body.parse_mode, 'HTML');
    assert.equal(stub.calls[0].body.text, '<u><b>Done</b></u>\nsee <code>x</code>');
  } finally {
    stub.restore();
  }
});

test('plain prose is sent with no parse mode at all', async () => {
  // Nothing to render means nothing that can be rejected as bad markup.
  const stub = stubApi(() => ({ body: { ok: true, result: { message_id: 1 } } }));
  try {
    await new TelegramBotService(TOKEN).sendMessage('1', 'just a sentence - with a dash.');

    assert.equal(stub.calls[0].body.parse_mode, undefined);
    assert.equal(stub.calls[0].body.text, 'just a sentence - with a dash.');
  } finally {
    stub.restore();
  }
});

test('--plain sends the source literally', async () => {
  const stub = stubApi(() => ({ body: { ok: true, result: { message_id: 1 } } }));
  try {
    await new TelegramBotService(TOKEN).sendMessage('1', '__*not a title*__', { format: 'plain' });

    assert.equal(stub.calls[0].body.parse_mode, undefined);
    assert.equal(stub.calls[0].body.text, '__*not a title*__');
  } finally {
    stub.restore();
  }
});

test('--html passes a body through untouched', async () => {
  const stub = stubApi(() => ({ body: { ok: true, result: { message_id: 1 } } }));
  try {
    await new TelegramBotService(TOKEN).sendMessage('1', '<b>mine</b>', { format: 'html' });

    assert.equal(stub.calls[0].body.parse_mode, 'HTML');
    assert.equal(stub.calls[0].body.text, '<b>mine</b>');
  } finally {
    stub.restore();
  }
});

// --- identity-based state ownership (audit round 2) -------------------------

test('ownership is decided by bot id, not the configured name', withConfigDir(() => {
  // Swapping the token behind a name must not pass: submitting the old offset
  // to a different bot's queue confirms updates it never saw.
  saveBotOffset('shared', 100, { name: 'default', id: 111 });

  assert.equal(loadBotOffset('shared', { name: 'default', id: 111 }), 100);
  assert.throws(() => loadBotOffset('shared', { name: 'default', id: 222 }), /already belongs/);
}));

test('the name is used only when no id was recorded', withConfigDir(() => {
  saveBotOffset('legacy', 5, { name: 'assistant' });

  assert.equal(loadBotOffset('legacy', { name: 'assistant', id: 999 }), 5, 'adopts on name when no id is stored');
  assert.throws(() => loadBotOffset('legacy', { name: 'personal', id: 999 }), /already belongs/);
}));

test('an unowned state with an offset is refused, not adopted', withConfigDir(() => {
  // An offset with no owner could belong to any bot; using it would skip real
  // messages, so adoption has to be a decision.
  const offsetFile = path.join(path.dirname(botLogPath('orphan')), 'offset.json');
  fs.mkdirSync(path.dirname(offsetFile), { recursive: true });
  fs.writeFileSync(offsetFile, JSON.stringify({ offset: 4242 }));

  assert.throws(() => loadBotOffset('orphan', { name: 'assistant', id: 1 }), /records no owner/);
  assert.equal(loadBotOffset('orphan', { name: 'assistant', id: 1 }, { adopt: true }), 4242);
}));

test('an empty namespace needs no adoption', withConfigDir(() => {
  assert.equal(loadBotOffset('fresh', { name: 'assistant', id: 1 }), null);
  assert.doesNotThrow(() => assertStateOwnership('fresh', { name: 'assistant', id: 1 }));
}));

test('claiming a namespace blocks a second bot before either polls', withConfigDir(() => {
  // Checking without claiming let two bots both pass on an unused namespace.
  claimBotState('race', { name: 'assistant', id: 111 });

  assert.throws(() => claimBotState('race', { name: 'personal', id: 222 }), /already belongs/);
  assert.doesNotThrow(() => claimBotState('race', { name: 'assistant', id: 111 }));
}));

test('claiming preserves an existing offset', withConfigDir(() => {
  saveBotOffset('keep', 77, { name: 'assistant', id: 111 });
  claimBotState('keep', { name: 'assistant', id: 111 });

  assert.equal(loadBotOffset('keep', { name: 'assistant', id: 111 }), 77);
}));

test('claiming an empty namespace records the owner with no offset', withConfigDir(() => {
  claimBotState('new', { name: 'assistant', id: 111 });

  assert.equal(loadBotOffset('new', { name: 'assistant', id: 111 }), null);
  assert.throws(() => claimBotState('new', { name: 'personal', id: 222 }), /already belongs/);
}));

// --- speak buttons ----------------------------------------------------------

test('a button press is parsed as a callback, not a message', async () => {
  const stub = stubApi(() => ({
    body: {
      ok: true,
      result: [{
        update_id: 70,
        callback_query: {
          id: 'q1',
          from: { id: 1, username: 'sherbaev' },
          message: { message_id: 55, chat: { id: 100000001, type: 'private' } },
          data: 'speak:abc123',
        },
      }],
    },
  }));
  try {
    const batch = await new TelegramBotService(TOKEN).getUpdates();

    assert.deepEqual(batch.messages, [], 'a press is not a message the agent must see');
    assert.equal(batch.callbacks.length, 1);
    assert.equal(batch.callbacks[0].data, 'speak:abc123');
    assert.equal(batch.callbacks[0].messageId, 55);
    assert.equal(batch.cursor, 70, 'the cursor still advances past it');
  } finally {
    stub.restore();
  }
});

test('a Listen button is attached with a key, not the text', async () => {
  // callback_data is capped at 64 bytes, so it cannot carry the message.
  const stub = stubApi(() => ({ body: { ok: true, result: { message_id: 1 } } }));
  try {
    await new TelegramBotService(TOKEN).sendMessage('1', 'hello', {
      buttons: [{ text: '🔊 Listen', callbackData: 'speak:deadbeef' }],
    });

    const markup = stub.calls[0].body.reply_markup;
    assert.equal(markup.inline_keyboard[0][0].text, '🔊 Listen');
    assert.equal(markup.inline_keyboard[0][0].callback_data, 'speak:deadbeef');
    assert.ok(markup.inline_keyboard[0][0].callback_data.length <= 64);
  } finally {
    stub.restore();
  }
});

test('no buttons means no reply_markup at all', async () => {
  const stub = stubApi(() => ({ body: { ok: true, result: { message_id: 1 } } }));
  try {
    await new TelegramBotService(TOKEN).sendMessage('1', 'hello');
    assert.equal(stub.calls[0].body.reply_markup, undefined);
  } finally {
    stub.restore();
  }
});

test('speakable text round-trips through the stash', withConfigDir(() => {
  const text = 'Audio in, audio out.';
  const key = stashSpeakableText('babysit', text);

  assert.ok(/^[0-9a-f]{24}$/.test(key), `unexpected key: ${key}`);
  assert.deepEqual(readSpeakableText('babysit', key), { text, format: 'auto' });
}));

test('the same text reuses one stash entry', withConfigDir(() => {
  assert.equal(stashSpeakableText('babysit', 'same'), stashSpeakableText('babysit', 'same'));
}));

test('an unknown or hostile key reads as nothing', withConfigDir(() => {
  // The key comes back from Telegram, so it must not be able to escape the dir.
  assert.equal(readSpeakableText('babysit', 'deadbeef'), null);
  assert.equal(readSpeakableText('babysit', '../../../etc/passwd'), null);
  assert.equal(readSpeakableText('babysit', 'a/b'), null);
  assert.equal(readSpeakableText('babysit', ''), null);
}));

test('stashes are per state', withConfigDir(() => {
  const key = stashSpeakableText('assistant', 'text');
  assert.equal(readSpeakableText('personal', key), null);
}));

test('the stash remembers how the text was sent', withConfigDir(() => {
  // Running markdown stripping over a --plain message would delete text the
  // reader can see; --html would otherwise have its tags read aloud.
  const plain = stashSpeakableText('babysit', '__*literal*__', 'plain');
  const auto = stashSpeakableText('babysit', '__*literal*__', 'auto');

  assert.notEqual(plain, auto, 'format is part of the identity');
  assert.deepEqual(readSpeakableText('babysit', plain), { text: '__*literal*__', format: 'plain' });
  assert.deepEqual(readSpeakableText('babysit', auto), { text: '__*literal*__', format: 'auto' });
}));

test('a stash entry written before formats existed still reads', withConfigDir(() => {
  const dir = path.join(path.dirname(botLogPath('babysit')), 'speak');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'abc123.txt'), 'older entry');

  assert.deepEqual(readSpeakableText('babysit', 'abc123'), { text: 'older entry', format: 'auto' });
}));

test('a corrupt stash entry reads as nothing', withConfigDir(() => {
  const dir = path.join(path.dirname(botLogPath('babysit')), 'speak');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'bad0.json'), '{ not json');

  assert.equal(readSpeakableText('babysit', 'bad0'), null);
}));

test('stale stash entries are swept when a new one is written', withConfigDir(() => {
  // The stash holds message text, so it cannot grow without bound.
  const old = stashSpeakableText('babysit', 'ancient');
  const dir = path.join(path.dirname(botLogPath('babysit')), 'speak');
  const aged = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(path.join(dir, `${old}.json`), aged, aged);

  const fresh = stashSpeakableText('babysit', 'current');

  assert.equal(readSpeakableText('babysit', old), null, 'the aged entry is gone');
  assert.equal(readSpeakableText('babysit', fresh)?.text, 'current');
}));

test('a voice upload that stalls is abandoned, not left hanging', async () => {
  const original = globalThis.fetch;
  const tmp = path.join(os.tmpdir(), `voice-${process.pid}.ogg`);
  fs.writeFileSync(tmp, 'not really opus');

  try {
    globalThis.fetch = (async (_u: any, init: any) =>
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      })) as any;

    await assert.rejects(
      () => new TelegramBotService(TOKEN).sendVoice('1', tmp, {}, 50),
      (err: Error) => {
        assert.match(err.message, /timed out/);
        assert.ok(!err.message.includes(TOKEN));
        return true;
      },
    );
  } finally {
    globalThis.fetch = original;
    fs.rmSync(tmp, { force: true });
  }
});

test('a pressed button is taken away, not just deduped', async () => {
  // Removing it means there is no second press to race with the first.
  const stub = stubApi(() => ({ body: { ok: true, result: true } }));
  try {
    await new TelegramBotService(TOKEN).clearButtons('100000001', 74);

    assert.equal(stub.calls[0].method, 'editMessageReplyMarkup');
    assert.equal(stub.calls[0].body.chat_id, '100000001');
    assert.equal(stub.calls[0].body.message_id, 74);
    assert.deepEqual(stub.calls[0].body.reply_markup.inline_keyboard, []);
  } finally {
    stub.restore();
  }
});

test('sent messages are recorded per bot, not per watch state', withConfigDir(() => {
  // The stash used to live under --state, which the sender and the watcher had
  // to agree on; when they did not, the button resolved to nothing.
  recordSentMessage('assistant', '100000001', 121, '__*Report*__\nbody', 'auto');

  assert.deepEqual(readSentMessage('assistant', '100000001', 121), { text: '__*Report*__\nbody', format: 'auto' });
  assert.equal(readSentMessage('personal', '100000001', 121), null, 'each bot keeps its own record');
}));

test('a message id that was never recorded reads as nothing', withConfigDir(() => {
  assert.equal(readSentMessage('assistant', '1', 999), null);
  assert.equal(readSentMessage('assistant', '1', -1), null);
  assert.equal(readSentMessage('assistant', '1', 0), null);
}));

test('a recorded send keeps its format', withConfigDir(() => {
  recordSentMessage('assistant', '1', 5, 'literal __*text*__', 'plain');
  assert.equal(readSentMessage('assistant', '1', 5)?.format, 'plain');
}));

test('the same message id in two chats does not collide', withConfigDir(() => {
  // Telegram ids are unique within a chat, not across a bot. Keying on the id
  // alone let one chat's text be read aloud in another.
  recordSentMessage('assistant', 'chatA', 121, 'private to A', 'auto');
  recordSentMessage('assistant', 'chatB', 121, 'private to B', 'auto');

  assert.equal(readSentMessage('assistant', 'chatA', 121)?.text, 'private to A');
  assert.equal(readSentMessage('assistant', 'chatB', 121)?.text, 'private to B');
}));

test('bot document: the file goes up as multipart sendDocument under its own name, with caption and reply', async () => {
  const original = globalThis.fetch;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-doc-'));
  const file = path.join(dir, 'report 2026-09-30.pdf');
  fs.writeFileSync(file, '%PDF-1.4 not really a pdf');
  let seen: { url: string; form: FormData } | undefined;
  try {
    globalThis.fetch = (async (url: any, init: any) => {
      seen = { url: String(url), form: init.body as FormData };
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 42 } }) } as any;
    }) as any;
    const id = await new TelegramBotService(TOKEN).sendDocument('100000001', file, { caption: 'Monthly report', replyToId: 7, silent: true });
    assert.equal(id, 42);
    assert.ok(seen!.url.endsWith('/sendDocument'));
    const doc = seen!.form.get('document') as File;
    assert.equal(doc.name, 'report 2026-09-30.pdf', 'the reader sees the real file name');
    assert.equal(await doc.text(), '%PDF-1.4 not really a pdf');
    assert.equal(seen!.form.get('chat_id'), '100000001');
    assert.equal(seen!.form.get('caption'), 'Monthly report');
    assert.equal(seen!.form.get('reply_to_message_id'), '7');
    assert.equal(seen!.form.get('disable_notification'), 'true');
  } finally {
    globalThis.fetch = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bot document: a file over the upload cap is refused before anything is sent', async () => {
  const original = globalThis.fetch;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-doc-big-'));
  const file = path.join(dir, 'huge.bin');
  fs.writeFileSync(file, '');
  fs.truncateSync(file, MAX_BOT_UPLOAD_BYTES + 1); // sparse: costs no disk
  let called = false;
  try {
    globalThis.fetch = (async () => { called = true; return {} as any; }) as any;
    await assert.rejects(() => new TelegramBotService(TOKEN).sendDocument('1', file), /accepts uploads up to 50 MB/);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bot document: a refused upload never carries the token in its error', async () => {
  const original = globalThis.fetch;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-doc-err-'));
  const file = path.join(dir, 'a.txt');
  fs.writeFileSync(file, 'x');
  try {
    globalThis.fetch = (async () => ({ ok: false, status: 400, json: async () => ({ ok: false, description: `Bad Request: chat not found for bot${TOKEN}` }) })) as any;
    await assert.rejects(() => new TelegramBotService(TOKEN).sendDocument('1', file), (err: Error) => {
      assert.match(err.message, /sendDocument/);
      assert.ok(!err.message.includes(TOKEN), err.message);
      return true;
    });
  } finally {
    globalThis.fetch = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sendVoice still uploads as before through the shared routine: endpoint, field, file name', async () => {
  const original = globalThis.fetch;
  const tmp = path.join(os.tmpdir(), `voice-ok-${process.pid}.ogg`);
  fs.writeFileSync(tmp, 'OggS');
  let seen: { url: string; form: FormData } | undefined;
  try {
    globalThis.fetch = (async (url: any, init: any) => {
      seen = { url: String(url), form: init.body as FormData };
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 5 } }) } as any;
    }) as any;
    assert.equal(await new TelegramBotService(TOKEN).sendVoice('1', tmp, { caption: 'c' }), 5);
    assert.ok(seen!.url.endsWith('/sendVoice'));
    assert.equal((seen!.form.get('voice') as File).name, 'speech.ogg');
    assert.equal(seen!.form.get('caption'), 'c');
  } finally {
    globalThis.fetch = original;
    fs.rmSync(tmp, { force: true });
  }
});

test('bot document: a path carrying the token never shows it in a filesystem error', async () => {
  await assert.rejects(() => new TelegramBotService(TOKEN).sendDocument('1', `/nonexistent/${TOKEN}/file.pdf`), (err: Error) => {
    assert.ok(!err.message.includes(TOKEN), err.message);
    return true;
  });
});

test('bot document: a named pipe with no writer is refused, not waited on', { skip: process.platform === 'win32' }, async () => {
  const { spawnSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-doc-fifo-'));
  const fifo = path.join(dir, 'pipe');
  try {
    spawnSync('mkfifo', [fifo]);
    await assert.rejects(() => new TelegramBotService(TOKEN).sendDocument('1', fifo), /not a regular file/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--silent and --mute actually mute: the option lands where every bot send command reads it', () => {
  // Commander names a two-long-flag option after the LAST flag. Declared as "--silent, --mute" it was stored as
  // `mute` while the actions read `options.silent`, so neither flag ever suppressed a notification.
  const program = new Command();
  registerBotCommands(program);
  const bot = program.commands.find((c) => c.name() === 'bot')!;
  for (const name of ['send', 'reply', 'document', 'table']) {
    const command = bot.commands.find((c) => c.name() === name);
    assert.ok(command, name);
    const option = command!.options.find((o) => o.long === '--silent' || o.long === '--mute');
    assert.equal(option?.attributeName(), 'silent', `${name}: the flag must be read as options.silent`);
  }
});

// --- editing a sent message ---------------------------------------------------

const LISTEN = [{ text: '🔊 Listen', callbackData: 'speak:abc' }];

test('editMessage sends rich markdown in place and keeps the Listen button', async () => {
  const stub = stubApi(() => ({ body: { ok: true, result: true } }));
  try {
    await new TelegramBotService(TOKEN).editMessage('100000001', 42, '**Digest** v2', { format: 'rich', buttons: LISTEN });

    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].method, 'editMessageText');
    assert.deepEqual(stub.calls[0].body, {
      chat_id: '100000001',
      message_id: 42,
      reply_markup: { inline_keyboard: [[{ text: '🔊 Listen', callback_data: 'speak:abc' }]] },
      rich_message: { markdown: '**Digest** v2' },
    });
  } finally {
    stub.restore();
  }
});

test('a refused rich edit falls back to plain text, as send does', async () => {
  const stub = stubApi((call) =>
    call.body.rich_message
      ? { status: 400, body: { ok: false, description: 'Bad Request: RICH_MESSAGE_MARKDOWN_INVALID' } }
      : { body: { ok: true, result: true } }
  );
  const stderr = process.stderr.write;
  process.stderr.write = (() => true) as any;
  try {
    await new TelegramBotService(TOKEN).editMessage('100000001', 42, '**Digest** v2', { format: 'rich', buttons: LISTEN });

    assert.equal(stub.calls.length, 2);
    assert.equal(stub.calls[1].body.text, '**Digest** v2');
    assert.equal(stub.calls[1].body.parse_mode, undefined);
    assert.equal(stub.calls[1].body.rich_message, undefined);
    // The fallback keeps the Listen button: an edit without a keyboard removes it.
    assert.deepEqual(stub.calls[1].body.reply_markup, { inline_keyboard: [[{ text: '🔊 Listen', callback_data: 'speak:abc' }]] });
  } finally {
    process.stderr.write = stderr;
    stub.restore();
  }
});

test('an unchanged edit is success, not an error', async () => {
  const stub = stubApi(() => ({
    status: 400,
    body: { ok: false, description: 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same' },
  }));
  try {
    await new TelegramBotService(TOKEN).editMessage('100000001', 42, 'same', { format: 'plain' });
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});

test('a missing message fails once, without a fallback attempt', async () => {
  const stub = stubApi(() => ({ status: 400, body: { ok: false, description: 'Bad Request: message to edit not found' } }));
  try {
    await assert.rejects(
      new TelegramBotService(TOKEN).editMessage('100000001', 42, 'v2', { format: 'rich' }),
      /message to edit not found/
    );
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});

test('an auto edit converts markup to HTML and retries plain if Telegram refuses the tags', async () => {
  const stub = stubApi((call) =>
    call.body.parse_mode === 'HTML'
      ? { status: 400, body: { ok: false, description: "Bad Request: can't parse entities" } }
      : { body: { ok: true, result: true } }
  );
  try {
    await new TelegramBotService(TOKEN).editMessage('100000001', 42, 'see `code`', { format: 'auto' });

    assert.equal(stub.calls[0].body.parse_mode, 'HTML');
    assert.equal(stub.calls[1].body.text, 'see `code`');
    assert.equal(stub.calls[1].body.parse_mode, undefined);
  } finally {
    stub.restore();
  }
});

test('a server that ignores rich_message falls back to plain text', async () => {
  const stub = stubApi((call) =>
    call.body.rich_message
      ? { status: 400, body: { ok: false, description: 'Bad Request: message text is empty' } }
      : { body: { ok: true, result: true } }
  );
  const stderr = process.stderr.write;
  process.stderr.write = (() => true) as any;
  try {
    await new TelegramBotService(TOKEN).editMessage('100000001', 42, 'v2', { format: 'rich' });
    assert.equal(stub.calls.length, 2);
    assert.equal(stub.calls[1].body.text, 'v2');
  } finally {
    process.stderr.write = stderr;
    stub.restore();
  }
});

test('a transient failure of a rich edit is reported, never retried as plain text', async () => {
  // The edit may already have landed; a plain retry would overwrite it with raw markdown.
  const stub = stubApi(() => ({ status: 502, body: { ok: false, description: 'Bad Gateway' } }));
  try {
    await assert.rejects(
      new TelegramBotService(TOKEN).editMessage('100000001', 42, '**Digest** v2', { format: 'rich' }),
      /Bad Gateway/
    );
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});

// --- a rich send falls back only on a content refusal --------------------------

test('a refused rich send falls back to the ordinary path', async () => {
  const stub = stubApi((call) =>
    call.method === 'sendRichMessage'
      ? { status: 400, body: { ok: false, description: 'Bad Request: RICH_MESSAGE_MARKDOWN_INVALID' } }
      : { body: { ok: true, result: { message_id: 7 } } }
  );
  const stderr = process.stderr.write;
  process.stderr.write = (() => true) as any;
  try {
    const id = await new TelegramBotService(TOKEN).sendMessage('100000001', 'hello', { format: 'rich' });
    assert.equal(id, 7);
    assert.deepEqual(stub.calls.map((c) => c.method), ['sendRichMessage', 'sendMessage']);
  } finally {
    process.stderr.write = stderr;
    stub.restore();
  }
});

for (const [label, status, description] of [
  ['a 403 refusal', 403, 'Forbidden: bot is not a member of the supergroup chat'],
  ['a transient 502', 502, 'Bad Gateway'],
] as const) {
  test(`${label} of a rich send is reported, never resent as plain text`, async () => {
    // A refusal is not a formatting problem, and a 5xx may mean the message already landed.
    const stub = stubApi(() => ({ status, body: { ok: false, error_code: status, description } }));
    try {
      await assert.rejects(new TelegramBotService(TOKEN).sendMessage('100000001', 'hello', { format: 'rich' }));
      assert.equal(stub.calls.length, 1);
    } finally {
      stub.restore();
    }
  });
}
