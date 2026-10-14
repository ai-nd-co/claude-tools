import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { GroqConfig } from '../config/types.js';
import type { DownloadResult, TelegramMessage, TelegramService } from '../services/telegram.js';
import { assertUsableAudio, transcribeWithGroq } from '../commands/transcribe/groq.js';
import { attachVoiceTranscripts } from '../services/voice-transcription.js';
import { readTranscriptCache, writeTranscriptCache } from '../services/transcript-cache.js';

const GROQ: GroqConfig = { apiKey: 'gsk_test', model: 'whisper-large-v3' };

/** Scratch directory plus an isolated transcript cache, torn down afterwards. */
function withSandbox(run: (ctx: { dir: string; audio: (name?: string) => string }) => Promise<void> | void) {
  return async () => {
    const previousCache = process.env.CLAUDE_TOOLS_STT_CACHE_DIR;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-voice-test-'));
    process.env.CLAUDE_TOOLS_STT_CACHE_DIR = path.join(dir, 'cache');

    const audio = (name = 'clip.ogg') => {
      const filepath = path.join(dir, name);
      // Content is never inspected: every test stubs the HTTP call.
      fs.writeFileSync(filepath, Buffer.alloc(2048, 7));
      return filepath;
    };

    try {
      await run({ dir, audio });
    } finally {
      if (previousCache === undefined) delete process.env.CLAUDE_TOOLS_STT_CACHE_DIR;
      else process.env.CLAUDE_TOOLS_STT_CACHE_DIR = previousCache;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

interface StubCall {
  url: string;
  model?: string;
  language?: string;
  responseFormat?: string;
  prompt?: string;
  hasFile: boolean;
}

/** Replace global fetch, recording what the provider actually sent. */
function stubFetch(
  handler: (call: StubCall) => { status?: number; body: unknown }
): { calls: StubCall[]; restore: () => void } {
  const calls: StubCall[] = [];
  const original = globalThis.fetch;

  globalThis.fetch = (async (url: any, init: any) => {
    const form = init?.body as FormData;
    const call: StubCall = {
      url: String(url),
      model: form?.get('model') as string | undefined ?? undefined,
      language: (form?.get('language') as string | null) ?? undefined,
      responseFormat: (form?.get('response_format') as string | null) ?? undefined,
      prompt: (form?.get('prompt') as string | null) ?? undefined,
      hasFile: form?.has('file') ?? false,
    };
    calls.push(call);

    const { status = 200, body } = handler(call);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    } as any;
  }) as any;

  return { calls, restore: () => { globalThis.fetch = original; } };
}

function voiceMessage(id: number, duration: number | undefined, extra: Partial<TelegramMessage> = {}): TelegramMessage {
  return {
    id,
    date: new Date(Date.UTC(2026, 8, 24, 20, 0)),
    sender: 'Sherbaev',
    text: '',
    hasMedia: true,
    mediaType: 'voice',
    mediaDuration: duration,
    ...extra,
  };
}

/** Telegram stand-in that records downloads and hands back a real local file. */
function fakeService(audioPath: string): { service: TelegramService; downloads: number[] } {
  const downloads: number[] = [];
  const service = {
    async downloadMedia(_chatId: unknown, messageId: number): Promise<DownloadResult> {
      downloads.push(messageId);
      return {
        chatId: '-10042',
        messageId,
        filepath: audioPath,
        type: 'voice',
        size: fs.statSync(audioPath).size,
        filename: path.basename(audioPath),
      };
    },
  } as unknown as TelegramService;

  return { service, downloads };
}

// --- provider ---------------------------------------------------------------

test('groq: posts the file to the transcription endpoint', withSandbox(async ({ audio }) => {
  const stub = stubFetch(() => ({ body: { text: '  hello world  ', language: 'English', duration: 3.5 } }));
  try {
    const result = await transcribeWithGroq(audio(), GROQ);

    assert.equal(result.text, 'hello world', 'text should be trimmed');
    assert.equal(result.language, 'English');
    assert.equal(result.model, 'whisper-large-v3');
    assert.equal(stub.calls.length, 1);
    assert.match(stub.calls[0].url, /audio\/transcriptions$/);
    assert.equal(stub.calls[0].model, 'whisper-large-v3');
    assert.equal(stub.calls[0].hasFile, true);
    // Always the verbose format: it is the only one that carries the per-segment
    // confidence, which is stored with every transcript so that turning the
    // language retry on later can tell which cached clips it would change.
    // Segments are still kept out of the result unless `--timestamps` asked.
    assert.equal(stub.calls[0].responseFormat, 'verbose_json');
    assert.equal(result.segments, undefined, 'no segments unless they were asked for');
    // No language hint means auto-detect; sending an empty one would pin it.
    assert.equal(stub.calls[0].language, undefined);
  } finally {
    stub.restore();
  }
}));

test('groq: --translate switches endpoint and drops the language hint', withSandbox(async ({ audio }) => {
  const stub = stubFetch(() => ({ body: { text: 'translated' } }));
  try {
    await transcribeWithGroq(audio(), GROQ, { translate: true, language: 'ru' });

    assert.match(stub.calls[0].url, /audio\/translations$/);
    assert.equal(stub.calls[0].language, undefined, 'translations endpoint takes no language');
  } finally {
    stub.restore();
  }
}));

test('groq: forwards model, language, prompt and timestamps', withSandbox(async ({ audio }) => {
  const stub = stubFetch(() => ({
    body: { text: 'x', segments: [{ start: 0, end: 1, text: ' seg ' }] },
  }));
  try {
    const result = await transcribeWithGroq(audio(), GROQ, {
      model: 'whisper-large-v3-turbo',
      language: 'ru',
      prompt: 'Dokku, Headscale',
      timestamps: true,
    });

    assert.equal(stub.calls[0].model, 'whisper-large-v3-turbo');
    assert.equal(stub.calls[0].language, 'ru');
    assert.equal(stub.calls[0].prompt, 'Dokku, Headscale');
    assert.equal(stub.calls[0].responseFormat, 'verbose_json');
    assert.equal(result.model, 'whisper-large-v3-turbo', 'result reports the model actually used');
    assert.deepEqual(result.segments, [{ start: 0, end: 1, text: 'seg' }]);
  } finally {
    stub.restore();
  }
}));

test('groq: surfaces the API error message', withSandbox(async ({ audio }) => {
  const stub = stubFetch(() => ({ status: 401, body: { error: { message: 'Invalid API Key' } } }));
  try {
    await assert.rejects(
      () => transcribeWithGroq(audio(), GROQ),
      /Invalid API Key/,
    );
  } finally {
    stub.restore();
  }
}));

test('groq: reports a rate limit distinctly', withSandbox(async ({ audio }) => {
  const stub = stubFetch(() => ({ status: 429, body: { error: { message: 'slow down' } } }));
  try {
    await assert.rejects(() => transcribeWithGroq(audio(), GROQ), /rate limit/i);
  } finally {
    stub.restore();
  }
}));

test('groq: a 200 with no text is an error, not an empty transcript', withSandbox(async ({ audio }) => {
  const stub = stubFetch(() => ({ body: { language: 'English' } }));
  try {
    await assert.rejects(() => transcribeWithGroq(audio(), GROQ), /no transcript/i);
  } finally {
    stub.restore();
  }
}));

test('groq: rejects unusable input before spending a request', withSandbox(async ({ dir, audio }) => {
  const stub = stubFetch(() => ({ body: { text: 'unreachable' } }));
  try {
    await assert.rejects(() => transcribeWithGroq(path.join(dir, 'nope.ogg'), GROQ), /not found/i);

    const wrongType = path.join(dir, 'notes.txt');
    fs.writeFileSync(wrongType, 'hello');
    await assert.rejects(() => transcribeWithGroq(wrongType, GROQ), /Unsupported audio format/);

    const empty = path.join(dir, 'empty.ogg');
    fs.writeFileSync(empty, '');
    await assert.rejects(() => transcribeWithGroq(empty, GROQ), /empty/i);

    const huge = path.join(dir, 'huge.ogg');
    fs.writeFileSync(huge, Buffer.alloc(26 * 1024 * 1024));
    await assert.rejects(() => transcribeWithGroq(huge, GROQ), /limit is/i);

    assert.equal(stub.calls.length, 0, 'no request should be sent for invalid input');
    void audio;
  } finally {
    stub.restore();
  }
}));

// --- auto-transcribe orchestration -----------------------------------------

test('attach: transcribes a short voice note and caches it', withSandbox(async ({ audio }) => {
  const { service, downloads } = fakeService(audio());
  const stub = stubFetch(() => ({ body: { text: 'short clip', language: 'English', duration: 4 } }));
  try {
    const messages = [voiceMessage(7, 4)];
    const summary = await attachVoiceTranscripts(service, '-10042', messages, GROQ);

    assert.equal(messages[0].transcript, 'short clip');
    assert.deepEqual(summary, { transcribed: 1, cacheHits: 0, skipped: 0, failed: 0, cacheWriteFailures: 0, empty: 0, silent: 0 });
    assert.deepEqual(downloads, [7]);
    assert.equal(readTranscriptCache({ source: 'tg', id: '-10042:7', model: GROQ.model, translate: false })?.text, 'short clip');
  } finally {
    stub.restore();
  }
}));

test('attach: a cached transcript costs no download and no request', withSandbox(async ({ audio }) => {
  writeTranscriptCache(
    { source: 'tg', id: '-10042:7', model: GROQ.model, translate: false },
    { text: 'from cache', model: GROQ.model },
  );

  const { service, downloads } = fakeService(audio());
  const stub = stubFetch(() => ({ body: { text: 'should not be called' } }));
  try {
    const messages = [voiceMessage(7, 4)];
    const summary = await attachVoiceTranscripts(service, '-10042', messages, GROQ);

    assert.equal(messages[0].transcript, 'from cache');
    assert.deepEqual(summary, { transcribed: 0, cacheHits: 1, skipped: 0, failed: 0, cacheWriteFailures: 0, empty: 0, silent: 0 });
    assert.deepEqual(downloads, [], 'cache hit must skip the download');
    assert.equal(stub.calls.length, 0, 'cache hit must skip the API');
  } finally {
    stub.restore();
  }
}));

test('attach: the cache is scoped per chat', withSandbox(async ({ audio }) => {
  writeTranscriptCache(
    { source: 'tg', id: '-10042:7', model: GROQ.model, translate: false },
    { text: 'other chat', model: GROQ.model },
  );

  const { service } = fakeService(audio());
  const stub = stubFetch(() => ({ body: { text: 'this chat' } }));
  try {
    const messages = [voiceMessage(7, 4)];
    await attachVoiceTranscripts(service, '-99999', messages, GROQ);

    assert.equal(messages[0].transcript, 'this chat', 'message #7 in another chat must not be reused');
  } finally {
    stub.restore();
  }
}));

test('attach: skips long clips, unknown durations and non-audio', withSandbox(async ({ audio }) => {
  const { service, downloads } = fakeService(audio());
  const stub = stubFetch(() => ({ body: { text: 'unreachable' } }));
  try {
    const messages = [
      voiceMessage(1, 181),                                           // over the 180s default
      voiceMessage(2, undefined),                                     // no duration reported
      voiceMessage(3, 5, { mediaType: 'photo' }),                     // not audio
      { ...voiceMessage(4, 5), hasMedia: false, mediaType: undefined } as TelegramMessage, // plain text
    ];
    const summary = await attachVoiceTranscripts(service, '-10042', messages, GROQ);

    assert.equal(summary.transcribed, 0);
    assert.equal(summary.skipped, 2, 'only the two audio messages count as skipped');
    assert.deepEqual(downloads, []);
    assert.equal(stub.calls.length, 0);
    assert.ok(messages.every((m) => m.transcript === undefined));

    // The skip now carries its own reason. Silence was the worse half of the original bug: a missing
    // transcript is indistinguishable from a failure, and nothing told the reader a cap existed.
    assert.match(messages[0]!.transcriptSkipped ?? '', /181s over the 180s cap/);
    assert.match(messages[1]!.transcriptSkipped ?? '', /no duration/);
    assert.equal(messages[2]!.transcriptSkipped, undefined, 'a photo is not a skipped clip');
    assert.equal(messages[3]!.transcriptSkipped, undefined, 'plain text is not a skipped clip');
  } finally {
    stub.restore();
  }
}));

test('attach: honours a raised duration threshold', withSandbox(async ({ audio }) => {
  const { service } = fakeService(audio());
  const stub = stubFetch(() => ({ body: { text: 'long one' } }));
  try {
    const messages = [voiceMessage(1, 90)];
    const summary = await attachVoiceTranscripts(service, '-10042', messages, GROQ, { maxDurationSeconds: 120 });

    assert.equal(summary.transcribed, 1);
    assert.equal(messages[0].transcript, 'long one');
  } finally {
    stub.restore();
  }
}));

test('attach: the default cap is three new clips', withSandbox(async ({ audio }) => {
  const { service, downloads } = fakeService(audio());
  const stub = stubFetch(() => ({ body: { text: 'clip' } }));
  try {
    const messages = [1, 2, 3, 4, 5].map((id) => voiceMessage(id, 3));
    const summary = await attachVoiceTranscripts(service, '-10042', messages, GROQ);

    assert.equal(summary.transcribed, 3, 'default cap is 3');
    assert.equal(summary.skipped, 2);
    assert.equal(downloads.length, 3);
    assert.equal(messages[3].transcript, undefined);
  } finally {
    stub.restore();
  }
}));

test('attach: stops at the per-read cap', withSandbox(async ({ audio }) => {
  const { service, downloads } = fakeService(audio());
  const stub = stubFetch(() => ({ body: { text: 'clip' } }));
  try {
    const messages = [voiceMessage(1, 3), voiceMessage(2, 3), voiceMessage(3, 3)];
    const summary = await attachVoiceTranscripts(service, '-10042', messages, GROQ, { maxMessages: 2 });

    assert.equal(summary.transcribed, 2);
    assert.equal(summary.skipped, 1);
    assert.equal(downloads.length, 2, 'cap must bound downloads, not just requests');
    assert.equal(messages[2].transcript, undefined);
  } finally {
    stub.restore();
  }
}));

test('attach: a cached entry does not consume the cap', withSandbox(async ({ audio }) => {
  writeTranscriptCache(
    { source: 'tg', id: '-10042:1', model: GROQ.model, translate: false },
    { text: 'cached', model: GROQ.model },
  );

  const { service } = fakeService(audio());
  const stub = stubFetch(() => ({ body: { text: 'fresh' } }));
  try {
    const messages = [voiceMessage(1, 3), voiceMessage(2, 3)];
    const summary = await attachVoiceTranscripts(service, '-10042', messages, GROQ, { maxMessages: 1 });

    assert.deepEqual(summary, { transcribed: 1, cacheHits: 1, skipped: 0, failed: 0, cacheWriteFailures: 0, empty: 0, silent: 0 });
    assert.equal(messages[0].transcript, 'cached');
    assert.equal(messages[1].transcript, 'fresh');
  } finally {
    stub.restore();
  }
}));

test('attach: one failure does not abort the rest of the read', withSandbox(async ({ audio }) => {
  const { service } = fakeService(audio());
  let attempt = 0;
  const stub = stubFetch(() => (
    ++attempt === 1
      ? { status: 500, body: { error: { message: 'boom' } } }
      : { body: { text: 'second ok' } }
  ));
  try {
    const messages = [voiceMessage(1, 3), voiceMessage(2, 3)];
    const summary = await attachVoiceTranscripts(service, '-10042', messages, GROQ);

    assert.equal(summary.failed, 1);
    assert.equal(summary.transcribed, 1);
    assert.equal(messages[0].transcript, undefined, 'failed message keeps no transcript');
    assert.equal(messages[1].transcript, 'second ok');
  } finally {
    stub.restore();
  }
}));

test('attach: a failure is not cached', withSandbox(async ({ audio }) => {
  const { service } = fakeService(audio());
  const stub = stubFetch(() => ({ status: 500, body: { error: { message: 'boom' } } }));
  try {
    const messages = [voiceMessage(1, 3)];
    await attachVoiceTranscripts(service, '-10042', messages, GROQ);

    assert.equal(
      readTranscriptCache({ source: 'tg', id: '-10042:1', model: GROQ.model, translate: false }),
      null,
      'a failed transcription must be retried next time, not cached',
    );
  } finally {
    stub.restore();
  }
}));

test('attach: a download failure is counted, not thrown', withSandbox(async () => {
  const service = {
    async downloadMedia(): Promise<DownloadResult> {
      throw new Error('FILE_REFERENCE_EXPIRED');
    },
  } as unknown as TelegramService;

  const messages = [voiceMessage(1, 3)];
  const summary = await attachVoiceTranscripts(service, '-10042', messages, GROQ);

  assert.deepEqual(summary, { transcribed: 0, cacheHits: 0, skipped: 0, failed: 1, cacheWriteFailures: 0, empty: 0, silent: 0 });
  assert.equal(messages[0].transcript, undefined);
}));

test('attach: an empty message list does nothing', withSandbox(async () => {
  const service = {
    async downloadMedia(): Promise<DownloadResult> {
      throw new Error('should not be reached');
    },
  } as unknown as TelegramService;

  const summary = await attachVoiceTranscripts(service, '-10042', [], GROQ);
  assert.deepEqual(summary, { transcribed: 0, cacheHits: 0, skipped: 0, failed: 0, cacheWriteFailures: 0, empty: 0, silent: 0 });
}));

test('attach: audio messages are transcribed too, not just voice notes', withSandbox(async ({ audio }) => {
  const { service } = fakeService(audio());
  const stub = stubFetch(() => ({ body: { text: 'music note' } }));
  try {
    const messages = [voiceMessage(1, 8, { mediaType: 'audio' })];
    const summary = await attachVoiceTranscripts(service, '-10042', messages, GROQ);

    assert.equal(summary.transcribed, 1);
    assert.equal(messages[0].transcript, 'music note');
  } finally {
    stub.restore();
  }
}));

// --- audit regressions ------------------------------------------------------

test('attach: reports a cache-write failure instead of hiding it', withSandbox(async ({ dir, audio }) => {
  // A silently unwritable cache would re-bill the same clip on every read.
  const blocker = path.join(dir, 'blocked');
  fs.writeFileSync(blocker, 'not a directory');
  process.env.CLAUDE_TOOLS_STT_CACHE_DIR = path.join(blocker, 'cache');

  const { service } = fakeService(audio());
  const stub = stubFetch(() => ({ body: { text: 'billed but not stored' } }));
  try {
    const messages = [voiceMessage(1, 5)];
    const summary = await attachVoiceTranscripts(service, '-10042', messages, GROQ);

    assert.equal(summary.transcribed, 1);
    assert.equal(summary.cacheWriteFailures, 1);
    assert.equal(messages[0].transcript, 'billed but not stored', 'the read still gets its text');
  } finally {
    stub.restore();
  }
}));

test('attach: re-checks the cache after the download, before paying', withSandbox(async ({ audio }) => {
  // The download is slow; another process may have cached the clip meanwhile.
  const audioPath = audio();
  const key = { source: 'tg', id: '-10042:1', model: GROQ.model, translate: false };
  const service = {
    async downloadMedia(_chatId: unknown, messageId: number): Promise<DownloadResult> {
      writeTranscriptCache(key, { text: 'won the race', model: GROQ.model });
      return {
        chatId: '-10042', messageId, filepath: audioPath, type: 'voice',
        size: fs.statSync(audioPath).size, filename: 'clip.ogg',
      };
    },
  } as unknown as TelegramService;

  const stub = stubFetch(() => ({ body: { text: 'paid twice' } }));
  try {
    const messages = [voiceMessage(1, 5)];
    const summary = await attachVoiceTranscripts(service, '-10042', messages, GROQ);

    assert.equal(stub.calls.length, 0, 'must not call Groq for a transcript that landed mid-download');
    assert.equal(summary.cacheHits, 1);
    assert.equal(summary.transcribed, 0);
    assert.equal(messages[0].transcript, 'won the race');
  } finally {
    stub.restore();
  }
}));

test('attach: an empty result is counted, cached, and shows nothing', withSandbox(async ({ audio }) => {
  const { service } = fakeService(audio());
  const stub = stubFetch(() => ({ body: { text: '   ' } }));
  try {
    const messages = [voiceMessage(1, 5)];
    const summary = await attachVoiceTranscripts(service, '-10042', messages, GROQ);

    assert.equal(summary.empty, 1);
    assert.equal(summary.transcribed, 1, 'it was billed, so it counts as transcribed');
    assert.equal(messages[0].transcript, undefined, 'nothing to render for silence');

    // Cached, so a silent clip is not re-billed on the next read.
    const again = [voiceMessage(1, 5)];
    const second = await attachVoiceTranscripts(service, '-10042', again, GROQ);
    assert.equal(second.cacheHits, 1);
    assert.equal(stub.calls.length, 1, 'silence must not be re-billed');
  } finally {
    stub.restore();
  }
}));

test('attach: a cached empty transcript stays undefined, not an empty string', withSandbox(async ({ audio }) => {
  writeTranscriptCache(
    { source: 'tg', id: '-10042:1', model: GROQ.model, translate: false },
    { text: '', model: GROQ.model },
  );

  const { service } = fakeService(audio());
  const stub = stubFetch(() => ({ body: { text: 'should not be called' } }));
  try {
    const messages = [voiceMessage(1, 5)];
    const summary = await attachVoiceTranscripts(service, '-10042', messages, GROQ);

    assert.equal(summary.cacheHits, 1);
    assert.equal(stub.calls.length, 0);
    assert.equal(messages[0].transcript, undefined);
  } finally {
    stub.restore();
  }
}));

test('attach: a shared budget spans several chats', withSandbox(async ({ audio }) => {
  // How the watcher spends one burst budget across chats: three calls total,
  // not three per chat.
  const { service, downloads } = fakeService(audio());
  const stub = stubFetch(() => ({ body: { text: 'clip' } }));
  try {
    const chats = [['-1', [1, 2]], ['-2', [3, 4]], ['-3', [5, 6]]] as const;
    let remaining = 3;
    let billed = 0;

    for (const [chatId, ids] of chats) {
      if (remaining <= 0) break;
      const messages = ids.map((id) => voiceMessage(id, 5));
      const summary = await attachVoiceTranscripts(service, chatId, messages, GROQ, {
        maxMessages: remaining,
      });
      remaining -= summary.transcribed + summary.failed;
      billed += summary.transcribed;
    }

    assert.equal(billed, 3, 'the burst budget is shared, not per chat');
    assert.equal(downloads.length, 3);
  } finally {
    stub.restore();
  }
}));

test('attach: a zero budget still serves cache hits', withSandbox(async ({ audio }) => {
  // How the watcher keeps the cache-hit exemption once the burst budget is gone.
  writeTranscriptCache(
    { source: 'tg', id: '-10042:1', model: GROQ.model, translate: false },
    { text: 'already cached', model: GROQ.model },
  );

  const { service, downloads } = fakeService(audio());
  const stub = stubFetch(() => ({ body: { text: 'must not be called' } }));
  try {
    const messages = [voiceMessage(1, 5), voiceMessage(2, 5)];
    const summary = await attachVoiceTranscripts(service, '-10042', messages, GROQ, { maxMessages: 0 });

    assert.equal(summary.cacheHits, 1, 'a cached clip is free, so no budget is needed');
    assert.equal(summary.transcribed, 0);
    assert.equal(summary.skipped, 1, 'the uncached one is skipped');
    assert.equal(messages[0].transcript, 'already cached');
    assert.equal(messages[1].transcript, undefined);
    assert.equal(downloads.length, 0);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
}));

test('attach: an exhausted burst budget still transcribes nothing but keeps later cache hits', withSandbox(async ({ audio }) => {
  // Mirrors the watcher loop: chat A spends the budget, chat B is cached.
  writeTranscriptCache(
    { source: 'tg', id: '-2:9', model: GROQ.model, translate: false },
    { text: 'cached in chat B', model: GROQ.model },
  );

  const { service } = fakeService(audio());
  const stub = stubFetch(() => ({ body: { text: 'fresh' } }));
  try {
    let remaining = 1;
    const chatA = [voiceMessage(1, 5)];
    const chatB = [voiceMessage(9, 5)];

    const a = await attachVoiceTranscripts(service, '-1', chatA, GROQ, { maxMessages: Math.max(remaining, 0) });
    remaining -= a.transcribed + a.failed;
    const b = await attachVoiceTranscripts(service, '-2', chatB, GROQ, { maxMessages: Math.max(remaining, 0) });

    assert.equal(a.transcribed, 1);
    assert.equal(remaining, 0, 'budget is spent');
    assert.equal(b.cacheHits, 1, 'chat B still gets its cached transcript');
    assert.equal(chatB[0].transcript, 'cached in chat B');
    assert.equal(stub.calls.length, 1, 'only chat A was billed');
  } finally {
    stub.restore();
  }
}));

test('groq: the provider validator is reusable before hashing a file', withSandbox(async ({ dir }) => {
  // The command calls this before hashing, so an oversized file is refused
  // without being read into memory.
  const huge = path.join(dir, 'huge.ogg');
  fs.writeFileSync(huge, Buffer.alloc(26 * 1024 * 1024));
  assert.throws(() => assertUsableAudio(huge), /limit is/i);

  const ok = path.join(dir, 'fine.ogg');
  fs.writeFileSync(ok, Buffer.alloc(1024));
  assert.equal(assertUsableAudio(ok), 1024, 'returns the validated size');
}));
