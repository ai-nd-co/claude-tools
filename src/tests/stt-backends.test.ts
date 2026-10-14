import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { execFileSync } from 'child_process';

import { loadConfig } from '../config/loader.js';
import { audioDurationSeconds } from '../services/audio-duration.js';
import { transcribeWithGroq } from '../commands/transcribe/groq.js';
import { SttRequestError, cachedTranscriptIsSuspect, retryPolicyOf } from '../commands/transcribe/groq.js';
import {
  STT_FLOOR_MS,
  clusterBackend,
  effectivePrompt,
  groqBackend,
  isRetriableSttFailure,
  requestTimeoutMs,
  resolveSttBackends,
  transcribeAudio,
  type SttBackend,
} from '../services/stt.js';
import { attachVoiceTranscripts, type TranscribableMessage } from '../services/voice-transcription.js';
import { readTranscriptCache, writeTranscriptCache } from '../services/transcript-cache.js';

const ENV_KEYS = [
  'GROQ_API_KEY', 'GROQ_STT_MODEL', 'SPEECH_API_KEY', 'SPEECH_BASE_URL', 'SPEECH_STT_MODEL',
  'STT_PROMPT', 'STT_FALLBACK_LANGUAGE', 'CLAUDE_TOOLS_CONFIG_DIR', 'CLAUDE_TOOLS_STT_CACHE_DIR',
] as const;

const CLUSTER_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

const CLUSTER: SttBackend = clusterBackend({
  apiKey: CLUSTER_KEY,
  baseUrl: 'https://speech.example.test/v1',
  model: 'Systran/faster-whisper-large-v3',
});
const GROQ: SttBackend = groqBackend({ apiKey: 'gsk_test', model: 'whisper-large-v3' });

/**
 * The upload share of a request's bound, at the 1 Mbit/s the policy assumes.
 * Computed here rather than hard-coded so these tests state the formula: the
 * deadline covers the whole request, so the body has to get there first.
 */
const upload = (file: string) => Math.ceil(fs.statSync(file).size / 128);

/**
 * Run with an empty config directory and a private cache directory so the
 * developer's real secrets file and cache cannot decide the outcome.
 */
function withEnv<T>(vars: Partial<Record<typeof ENV_KEYS[number], string>>, secrets: unknown, fn: () => T): T {
  const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-backends-test-'));

  for (const key of ENV_KEYS) delete process.env[key];
  process.env.CLAUDE_TOOLS_CONFIG_DIR = dir;
  process.env.CLAUDE_TOOLS_STT_CACHE_DIR = path.join(dir, 'cache');
  for (const [key, value] of Object.entries(vars)) process.env[key] = value;
  if (secrets !== undefined) fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify(secrets));

  const restore = () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  };

  // An async body must keep the environment until it settles; restoring in a
  // plain `finally` would hand the cache back to the real directory mid-test.
  let result: T;
  try {
    result = fn();
  } catch (error) {
    restore();
    throw error;
  }
  if (result instanceof Promise) {
    return result.finally(restore) as T;
  }
  restore();
  return result;
}

/** A scripted fetch that answers per call and records what each backend was sent. */
function stubFetch(script: Array<{ status?: number; body?: unknown; throw?: Error }>) {
  const calls: Array<{ url: string; auth: string | undefined }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), auth: init?.headers?.Authorization });
    const step = script[Math.min(calls.length - 1, script.length - 1)];
    if (step.throw) throw step.throw;
    const status = step.status ?? 200;
    const text = JSON.stringify(step.body ?? {});
    return {
      ok: status < 400,
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      text: async () => text,
      json: async () => JSON.parse(text),
    } as unknown as Response;
  }) as any;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function clip(): { file: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-clip-'));
  const file = path.join(dir, 'note.ogg');
  fs.writeFileSync(file, Buffer.from('OggS'));
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// --- config -----------------------------------------------------------------

test('speech config: the key alone turns the cluster on, with the cluster defaults', () => {
  const config = withEnv({}, { speech: { apiKey: CLUSTER_KEY } }, loadConfig);

  assert.ok(config.speech);
  assert.equal(config.speech.apiKey, CLUSTER_KEY);
  assert.equal(config.speech.baseUrl, 'https://speech.example.com/v1');
  assert.equal(config.speech.model, 'Systran/faster-whisper-large-v3');
});

test('speech config: env wins over the file, and a trailing slash is dropped', () => {
  const config = withEnv(
    { SPEECH_API_KEY: 'from-env-0123456789abcdef0123456789abcdef', SPEECH_BASE_URL: 'http://127.0.0.1:18000/v1/', SPEECH_STT_MODEL: 'whisper-1' },
    { speech: { apiKey: 'from-file', baseUrl: 'https://file.example/v1', model: 'x' } },
    loadConfig
  );

  assert.equal(config.speech?.apiKey, 'from-env-0123456789abcdef0123456789abcdef');
  assert.equal(config.speech?.baseUrl, 'http://127.0.0.1:18000/v1');
  assert.equal(config.speech?.model, 'whisper-1');
});

test('speech config: a base URL that is not http(s), or does not end in /v1, is refused', () => {
  assert.throws(
    () => withEnv({}, { speech: { apiKey: CLUSTER_KEY, baseUrl: 'speech.example.com/v1' } }, loadConfig),
    /Invalid speech.baseUrl/
  );
  assert.throws(
    () => withEnv({}, { speech: { apiKey: CLUSTER_KEY, baseUrl: 'https://speech.example' } }, loadConfig),
    /ending in \/v1/
  );
  assert.throws(
    () => withEnv({}, { speech: { apiKey: CLUSTER_KEY, baseUrl: 'https://speech.example/?x=/v1' } }, loadConfig),
    /ending in \/v1/
  );
  // A bare `?` or `#` and a trailing slash are dropped, so the request path is always `.../v1/audio/...`.
  for (const raw of ['https://speech.example/v1?', 'https://speech.example/v1#', 'https://speech.example/v1/']) {
    assert.equal(withEnv({}, { speech: { apiKey: CLUSTER_KEY, baseUrl: raw } }, loadConfig).speech?.baseUrl, 'https://speech.example/v1', raw);
  }
});

test('a complete 200 that is not JSON is an error, not a fallback', async () => {
  const { file, cleanup } = clip();
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return { ok: true, status: 200, statusText: 'OK', text: async () => '<html>proxy</html>' } as any; }) as any;
  try {
    await assert.rejects(() => transcribeAudio(file, [CLUSTER, GROQ]), /non-JSON answer/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
    cleanup();
  }
});

test('speech config: absent means null, and Groq is untouched', () => {
  const config = withEnv({ GROQ_API_KEY: 'gsk_x' }, undefined, loadConfig);

  assert.equal(config.speech, null);
  assert.equal(config.groq?.apiKey, 'gsk_x');
});

// --- backend order ------------------------------------------------------------

test('backends: the cluster goes first, Groq second, and each alone is fine', () => {
  const both = resolveSttBackends({ speech: { apiKey: CLUSTER_KEY, baseUrl: 'https://s/v1', model: 'm' }, groq: { apiKey: 'gsk_x', model: 'g' } });
  assert.deepEqual(both.map((b) => b.provider), ['cluster', 'groq']);

  assert.deepEqual(resolveSttBackends({ speech: null, groq: { apiKey: 'gsk_x', model: 'g' } }).map((b) => b.provider), ['groq']);
  assert.deepEqual(resolveSttBackends({ speech: { apiKey: CLUSTER_KEY, baseUrl: 'https://s/v1', model: 'm' }, groq: null }).map((b) => b.provider), ['cluster']);
  assert.deepEqual(resolveSttBackends({ speech: null, groq: null }), []);
});

test('backends: both requests carry a bound — Groq is the last one, so unbounded there had no fallback behind it', () => {
  assert.ok(CLUSTER.timeoutMs && CLUSTER.timeoutMs > 0);
  assert.ok(GROQ.timeoutMs && GROQ.timeoutMs > 0);
  assert.equal(CLUSTER.msPerAudioSecond, GROQ.msPerAudioSecond);
});

// --- fallback -----------------------------------------------------------------

test('fallback: a 5xx from the cluster sends the same clip to Groq and says so', async () => {
  const { file, cleanup } = clip();
  const stub = stubFetch([
    { status: 503, body: { detail: 'model is loading' } },
    { body: { text: 'from groq', language: 'en' } },
  ]);
  const fallbacks: string[] = [];
  try {
    const outcome = await transcribeAudio(file, [CLUSTER, GROQ], {}, (from, _reason, next) => {
      fallbacks.push(`${from.provider}->${next.provider}`);
    });

    assert.equal(outcome.result.text, 'from groq');
    assert.equal(outcome.backend.provider, 'groq');
    assert.equal(outcome.result.model, 'whisper-large-v3', 'the answering backend names the model');
    assert.equal(outcome.fellBackFrom?.backend.provider, 'cluster');
    assert.deepEqual(fallbacks, ['cluster->groq']);
    assert.equal(stub.calls.length, 2);
    assert.ok(stub.calls[0].url.startsWith('https://speech.example.test/v1/audio/transcriptions'));
    assert.ok(stub.calls[1].url.startsWith('https://api.groq.com/openai/v1/audio/transcriptions'));
    assert.equal(stub.calls[0].auth, `Bearer ${CLUSTER_KEY}`);
    assert.equal(stub.calls[1].auth, 'Bearer gsk_test');
  } finally {
    stub.restore();
    cleanup();
  }
});

test('fallback: an unreachable cluster falls back too, and the error names no key', async () => {
  const { file, cleanup } = clip();
  const stub = stubFetch([
    { throw: Object.assign(new TypeError('fetch failed'), { cause: new Error(`connect ECONNREFUSED ${CLUSTER_KEY}`) }) },
    { body: { text: 'from groq' } },
  ]);
  let reason = '';
  try {
    const outcome = await transcribeAudio(file, [CLUSTER, GROQ], {}, (_from, why) => { reason = why; });

    assert.equal(outcome.backend.provider, 'groq');
    assert.match(reason, /unreachable/);
    assert.ok(!reason.includes(CLUSTER_KEY), 'the cluster key must never appear in an error');
    assert.ok(reason.includes('***'));
  } finally {
    stub.restore();
    cleanup();
  }
});

test('fallback: a rejected key is a configuration error, never a silent fallback', async () => {
  const { file, cleanup } = clip();
  const stub = stubFetch([{ status: 403, body: { detail: 'Not authenticated' } }]);
  try {
    await assert.rejects(
      () => transcribeAudio(file, [CLUSTER, GROQ]),
      (error: any) => {
        assert.ok(error instanceof SttRequestError);
        assert.equal(error.status, 403);
        assert.match(error.message, /the speech cluster rejected the API key/);
        assert.match(error.message, /SPEECH_API_KEY/);
        return true;
      }
    );
    assert.equal(stub.calls.length, 1, 'Groq must not have been called');
  } finally {
    stub.restore();
    cleanup();
  }
});

test('fallback: a named single backend fails on its own error', async () => {
  const { file, cleanup } = clip();
  const stub = stubFetch([{ status: 500, body: { detail: 'boom' } }]);
  try {
    await assert.rejects(() => transcribeAudio(file, [CLUSTER]), /the speech cluster API error 500/);
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
    cleanup();
  }
});

test('fallback: nothing configured is a clear error', async () => {
  const { file, cleanup } = clip();
  try {
    await assert.rejects(() => transcribeAudio(file, []), /not configured/);
  } finally {
    cleanup();
  }
});

test('retriable: no status, 429 and 5xx retry; other 4xx and plain errors do not', () => {
  assert.equal(isRetriableSttFailure(new SttRequestError('down')), true);
  assert.equal(isRetriableSttFailure(new SttRequestError('busy', 429)), true);
  assert.equal(isRetriableSttFailure(new SttRequestError('oops', 502)), true);
  assert.equal(isRetriableSttFailure(new SttRequestError('bad key', 401)), false);
  assert.equal(isRetriableSttFailure(new SttRequestError('too big', 413)), false);
  assert.equal(isRetriableSttFailure(new Error('file not found')), false);
});

// --- cache across backends ------------------------------------------------------

function fakeService(file: string) {
  return {
    downloadMedia: async () => ({ filepath: file, type: 'voice', size: 4, filename: 'note.ogg', chatId: '-1', messageId: 1 }),
  } as any;
}

test('cache: a transcript Groq produced earlier is served when the cluster is now first', async () => {
  const { file, cleanup } = clip();
  await withEnv({}, undefined, async () => {
    const stub = stubFetch([{ status: 500 }]);
    try {
      writeTranscriptCache({ source: 'tg', id: '-1:7', model: GROQ.model, translate: false }, { text: 'old groq text', model: GROQ.model });
      const messages: TranscribableMessage[] = [{ id: 7, hasMedia: true, mediaType: 'voice', mediaDuration: 5 }];

      const summary = await attachVoiceTranscripts(fakeService(file), '-1', messages, [CLUSTER, GROQ]);

      assert.equal(messages[0].transcript, 'old groq text');
      assert.equal(summary.cacheHits, 1);
      assert.equal(stub.calls.length, 0, 'no backend is called on a cache hit');
    } finally {
      stub.restore();
    }
  });
  cleanup();
});

test('cache: a miss is filed under the backend that answered, not the first one tried', async () => {
  const { file, cleanup } = clip();
  await withEnv({}, undefined, async () => {
    const stub = stubFetch([
      { status: 502, body: { detail: 'bad gateway' } },
      { body: { text: 'groq answered', language: 'en', duration: 5 } },
    ]);
    try {
      const messages: TranscribableMessage[] = [{ id: 8, hasMedia: true, mediaType: 'voice', mediaDuration: 5 }];
      // The 4-byte "clip" is not real audio; the silence check cannot measure it and
      // reports not-silent, so the clip reaches the backends — the path under test.
      const summary = await attachVoiceTranscripts(fakeService(file), '-1', messages, [CLUSTER, GROQ]);

      assert.equal(summary.transcribed, 1, JSON.stringify(summary));
      assert.equal(messages[0].transcript, 'groq answered');
      assert.equal(readTranscriptCache({ source: 'tg', id: '-1:8', model: GROQ.model, translate: false })?.text, 'groq answered');
      assert.equal(readTranscriptCache({ source: 'tg', id: '-1:8', model: CLUSTER.model, translate: false }), null,
        'nothing is filed under the cluster model for an answer the cluster did not give');
    } finally {
      stub.restore();
    }
  });
  cleanup();
});

test('fallback: a body that cannot be read keeps its status — a stalled 403 stops, a stalled 503 falls back', async () => {
  const { file, cleanup } = clip();
  const original = globalThis.fetch;
  const stalled = (status: number) => ({
    ok: status < 400, status, statusText: 'x',
    text: async () => { throw new TypeError('terminated'); },
    json: async () => { throw new TypeError('terminated'); },
  }) as unknown as Response;
  try {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return calls === 1 ? stalled(503) : { ok: true, status: 200, statusText: 'OK', text: async () => '{"text":"groq"}', json: async () => ({ text: 'groq' }) } as any; }) as any;
    const outcome = await transcribeAudio(file, [CLUSTER, GROQ]);
    assert.equal(outcome.backend.provider, 'groq');
    assert.equal(calls, 2);

    calls = 0;
    globalThis.fetch = (async () => { calls++; return stalled(403); }) as any;
    await assert.rejects(() => transcribeAudio(file, [CLUSTER, GROQ]), (e: any) => e instanceof SttRequestError && e.status === 403);
    assert.equal(calls, 1, 'a 403 whose body stalled must not fall back');

    calls = 0;
    globalThis.fetch = (async () => { calls++; return calls === 1 ? stalled(200) : { ok: true, status: 200, statusText: 'OK', text: async () => '{"text":"groq"}', json: async () => ({ text: 'groq' }) } as any; }) as any;
    const okButCut = await transcribeAudio(file, [CLUSTER, GROQ]);
    assert.equal(okButCut.backend.provider, 'groq', 'a 200 whose body was cut off is retriable');
  } finally {
    globalThis.fetch = original;
    cleanup();
  }
});

// --- how long one request is allowed ----------------------------------------

test('the request bound is the floor for a voice note and grows with a long recording', () => {
  const { file, cleanup } = clip();
  try {
    // Thirty seconds, not ten minutes: this is the regression that let a stuck
    // cluster swallow a voice note instead of falling back to Groq.
    assert.equal(STT_FLOOR_MS, 30_000);
    assert.equal(CLUSTER.timeoutMs, 30_000);
    assert.equal(GROQ.timeoutMs, 30_000);

    // Anything up to two minutes of audio sits on the floor, plus the upload.
    const post = upload(file);
    assert.equal(requestTimeoutMs(CLUSTER, file, 5), 30_000 + post);
    assert.equal(requestTimeoutMs(CLUSTER, file, 120), 30_000 + post);

    // Past that, a quarter of the clip's length — the backend must keep up at
    // four times real time, against a cluster measured at about twenty. A
    // 60-minute recording it transcribes in about three minutes gets fifteen.
    assert.equal(requestTimeoutMs(CLUSTER, file, 129), 32_250 + post);
    assert.equal(requestTimeoutMs(CLUSTER, file, 3600), 900_000 + post);

    // Both backends are bounded. Groq is the last one, so unbounded there meant
    // a wait with nothing after it.
    assert.equal(requestTimeoutMs(GROQ, file, 3600), 900_000 + post);
  } finally {
    cleanup();
  }
});

test('with no duration to hand, the file size stands in — and a nonsense duration cannot shorten the bound', () => {
  const { file, cleanup } = clip();
  try {
    // A four-byte clip: the size says nothing, so the floor carries it.
    assert.equal(requestTimeoutMs(CLUSTER, file), 30_000 + upload(file));

    // A missing file, and a duration that is negative or not a number, are
    // ignored — the size stands in, and on a tiny file that means the floor.
    // What they must never do is produce no bound, or one below the floor.
    assert.equal(requestTimeoutMs(CLUSTER, path.join(path.dirname(file), 'gone.ogg')), 30_000);
    assert.equal(requestTimeoutMs(CLUSTER, file, -5), 30_000 + upload(file));
    assert.equal(requestTimeoutMs(CLUSTER, file, Number.NaN), 30_000 + upload(file));

    // 2 MB of Opus is at least a quarter of an hour of speech, and is allowed for it.
    fs.writeFileSync(file, Buffer.alloc(2 * 1024 * 1024));
    assert.equal(requestTimeoutMs(CLUSTER, file), 256_000 + upload(file));

    // Past that the transcribing share is capped at the ten minutes this change
    // replaced, so a size-only estimate can never amount to no bound at all.
    fs.writeFileSync(file, Buffer.alloc(21 * 1024 * 1024));
    assert.equal(requestTimeoutMs(CLUSTER, file), 600_000 + upload(file));

    // A backend with no floor of its own stays unbounded, which is what the
    // hand-made backends in these tests rely on.
    assert.equal(requestTimeoutMs({ ...CLUSTER, timeoutMs: undefined }, file, 10), undefined);
  } finally {
    cleanup();
  }
});

test('a backend that accepts the connection and then goes quiet falls back within its bound', async () => {
  const { file, cleanup } = clip();
  const original = globalThis.fetch;
  const seen: string[] = [];

  // A tiny bound stands in for the real thirty seconds so the test takes
  // milliseconds; what is under test is that the bound is honoured at all and
  // that the next backend gets the clip.
  const stuck: SttBackend = { ...CLUSTER, timeoutMs: 60, msPerAudioSecond: 1 };

  globalThis.fetch = (async (url: any, init: any) => {
    seen.push(String(url));
    if (seen.length === 1) {
      // Accepted, then silent: resolves only when the caller's own signal aborts.
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error: any = new Error('aborted');
          error.name = 'TimeoutError';
          reject(error);
        });
      });
    }
    return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ text: 'from the fallback' }) } as any;
  }) as any;

  // `AbortSignal.timeout` schedules an unref'd timer, so a fake fetch that only
  // settles on abort leaves nothing to keep the loop alive and the test would be
  // cancelled rather than finished. A real request has its socket for that.
  const keepAlive = setInterval(() => {}, 10);

  try {
    const started = Date.now();
    const outcome = await transcribeAudio(file, [stuck, GROQ], { audioSeconds: 5 });
    const elapsed = Date.now() - started;

    assert.equal(outcome.result.text, 'from the fallback');
    assert.equal(outcome.backend.provider, 'groq');
    assert.match(outcome.fellBackFrom?.reason ?? '', /no answer within/);
    assert.equal(seen.length, 2);
    // The point of the change: the wait ended on its own. Ten minutes would
    // have been a hung watcher and no transcript at all.
    assert.ok(elapsed < 5_000, `fell back after ${elapsed}ms`);
  } finally {
    clearInterval(keepAlive);
    globalThis.fetch = original;
    cleanup();
  }
});

// --- the clip's real length, rather than its size ---------------------------

/** A silent 16-bit WAV of the given length: a real file ffprobe can read. */
function wav(seconds: number, rate = 8000, channels = 1): { file: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-wav-'));
  const file = path.join(dir, `clip-${seconds}s.wav`);
  const data = Buffer.alloc(rate * 2 * channels * seconds);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2 * channels, 28);
  header.writeUInt16LE(2 * channels, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, data]));
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const HAS_FFPROBE = (() => {
  try {
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
})();

test('the container is asked how long the clip is, so a WAV is not mistaken for hours of audio', async (t) => {
  if (!HAS_FFPROBE) return t.skip('ffprobe is not installed');

  // The case the review raised, to its own numbers: two minutes of 44.1 kHz
  // stereo is about 21 MB, which a bytes-per-second guess reads as hours.
  const { file, cleanup } = wav(120, 44_100, 2);
  try {
    assert.ok(fs.statSync(file).size > 20 * 1024 * 1024, 'the fixture should be the large-for-its-length case');

    const seconds = await audioDurationSeconds(file);
    assert.ok(seconds !== null && Math.abs(seconds - 120) < 1, `ffprobe said ${seconds}`);

    // Asking the container puts the transcribing share of a two-minute clip back
    // on the floor; guessing from its size runs all the way into the ceiling,
    // which is a bound in name only for a clip needing about six seconds of work.
    assert.equal(requestTimeoutMs(CLUSTER, file, seconds!), 30_000 + upload(file));
    assert.equal(requestTimeoutMs(CLUSTER, file), 600_000 + upload(file));

    // And the whole point of the upload share: the deadline covers the body
    // going out, so a 21 MB file must not get a bound that only a 5.6 Mbit/s
    // uplink could meet. At the 1 Mbit/s assumed here it is allowed about two
    // and a half minutes for the upload alone.
    const bound = requestTimeoutMs(CLUSTER, file, seconds!)!;
    assert.ok(bound > 150_000, `a 21 MB upload was allowed only ${bound} ms`);
    assert.ok(bound - 30_000 >= upload(file), 'the upload share must survive the floor');
  } finally {
    cleanup();
  }
});

test('a file ffprobe cannot read reports no duration rather than throwing', async (t) => {
  if (!HAS_FFPROBE) return t.skip('ffprobe is not installed');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-notaudio-'));
  try {
    const file = path.join(dir, 'notes.ogg');
    fs.writeFileSync(file, 'this is not audio');
    assert.equal(await audioDurationSeconds(file), null);
    assert.equal(await audioDurationSeconds(path.join(dir, 'absent.ogg')), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('every path to the network carries a bound, the single-backend helper included', async () => {
  const { file, cleanup } = clip();
  const original = globalThis.fetch;
  const signals: Array<AbortSignal | undefined> = [];

  globalThis.fetch = (async (_url: any, init: any) => {
    signals.push(init?.signal);
    return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ text: 'ok' }) } as any;
  }) as any;

  try {
    await transcribeAudio(file, [CLUSTER], { audioSeconds: 5 });
    // `transcribeWithGroq` reaches `transcribeWithBackend` directly, so a bound
    // applied one layer higher would have missed it entirely.
    await transcribeWithGroq(file, { apiKey: 'gsk_test', model: 'whisper-large-v3' }, { audioSeconds: 3600 });

    assert.equal(signals.length, 2);
    for (const signal of signals) assert.ok(signal instanceof AbortSignal, 'the request went out unbounded');
  } finally {
    globalThis.fetch = original;
    cleanup();
  }
});

// --- the vocabulary the transcriber should expect ---------------------------

/** Captures the multipart body so a test can see which fields were sent. */
function captureFetch(answer = 'ok') {
  const bodies: FormData[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any) => {
    bodies.push(init?.body as FormData);
    return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ text: answer }) } as any;
  }) as any;
  return { bodies, restore: () => { globalThis.fetch = original; } };
}

test('a configured vocabulary is sent on every request, and an explicit one wins', async () => {
  const { file, cleanup } = clip();
  const cap = captureFetch();
  const cluster = clusterBackend({
    apiKey: CLUSTER_KEY, baseUrl: 'https://s/v1', model: 'm',
    prompt: 'Context: Kubernetes, Longhorn.',
  });

  try {
    await transcribeAudio(file, [cluster], { audioSeconds: 3 });
    assert.equal(cap.bodies[0].get('prompt'), 'Context: Kubernetes, Longhorn.');

    // A caller that knows better than the config overrides it.
    await transcribeAudio(file, [cluster], { audioSeconds: 3, prompt: 'just this once' });
    assert.equal(cap.bodies[1].get('prompt'), 'just this once');

    // And with nothing configured the field is absent rather than empty: an
    // empty prompt is not the same request as no prompt.
    await transcribeAudio(file, [CLUSTER], { audioSeconds: 3 });
    assert.equal(cap.bodies[2].get('prompt'), null);
  } finally {
    cap.restore();
    cleanup();
  }
});

test('the vocabulary reaches Groq too, since either backend may answer', async () => {
  const { file, cleanup } = clip();
  const cap = captureFetch();
  try {
    const groq = groqBackend({ apiKey: 'gsk_x', model: 'whisper-large-v3', prompt: 'Context: PubAck.' });
    await transcribeAudio(file, [groq], { audioSeconds: 2 });
    assert.equal(cap.bodies[0].get('prompt'), 'Context: PubAck.');
  } finally {
    cap.restore();
    cleanup();
  }
});

test('stt config: the vocabulary comes from either section, and the env wins over both', () => {
  const both = withEnv({}, {
    speech: { apiKey: CLUSTER_KEY, prompt: 'from the speech section' },
    groq: { apiKey: 'gsk_x', prompt: 'from the groq section' },
  }, loadConfig);
  assert.equal(both.speech?.prompt, 'from the speech section');
  assert.equal(both.groq?.prompt, 'from the groq section');

  const env = withEnv({ STT_PROMPT: 'from the environment' }, {
    speech: { apiKey: CLUSTER_KEY, prompt: 'from the speech section' },
    groq: { apiKey: 'gsk_x' },
  }, loadConfig);
  assert.equal(env.speech?.prompt, 'from the environment');
  assert.equal(env.groq?.prompt, 'from the environment', 'one setting covers both backends');

  // Unset stays undefined, so nothing is sent and transcription is unchanged.
  const none = withEnv({}, { speech: { apiKey: CLUSTER_KEY }, groq: { apiKey: 'gsk_x' } }, loadConfig);
  assert.equal(none.speech?.prompt, undefined);
  assert.equal(none.groq?.prompt, undefined);
});

test('the cache keys on the vocabulary, so configuring one does not serve pre-glossary text', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-prompt-cache-'));
  const saved = process.env.CLAUDE_TOOLS_STT_CACHE_DIR;
  process.env.CLAUDE_TOOLS_STT_CACHE_DIR = dir;
  try {
    const base = { source: 'tg', id: 'chat:1', model: 'm', translate: false };

    // What an unprompted run cached.
    assert.ok(writeTranscriptCache({ ...base }, { text: 'the Codec is stuck', model: 'm' }));

    // A glossary is now configured. The old entry must not answer for it...
    assert.equal(readTranscriptCache({ ...base, prompt: 'Context: Codex.' }), null);
    // ...and the unprompted caller must still get its own.
    assert.equal(readTranscriptCache({ ...base })?.text, 'the Codec is stuck');

    // Changing the glossary is likewise a different request.
    assert.ok(writeTranscriptCache({ ...base, prompt: 'Context: Codex.' }, { text: 'Codex is stuck', model: 'm' }));
    assert.equal(readTranscriptCache({ ...base, prompt: 'Context: Codex.' })?.text, 'Codex is stuck');
    assert.equal(readTranscriptCache({ ...base, prompt: 'Context: Codex, PROJ.' }), null);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_TOOLS_STT_CACHE_DIR;
    else process.env.CLAUDE_TOOLS_STT_CACHE_DIR = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the effective vocabulary is the caller\'s, else the backend\'s', () => {
  const configured = clusterBackend({ apiKey: CLUSTER_KEY, baseUrl: 'https://s/v1', model: 'm', prompt: 'from config' });
  assert.equal(effectivePrompt(configured), 'from config');
  assert.equal(effectivePrompt(configured, 'from the caller'), 'from the caller');
  assert.equal(effectivePrompt(CLUSTER), undefined);
  assert.equal(effectivePrompt(CLUSTER, 'from the caller'), 'from the caller');
});

// --- a mis-detected language, caught by the model's own confidence -----------

/**
 * Answers in sequence and records the `language` field of each request, so a
 * test can see both what was asked and how many passes it took.
 */
function scriptFetch(answers: Array<{ text: string; language?: string; logprob?: number }>) {
  const asked: Array<string | null> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any) => {
    const body = init?.body as FormData;
    asked.push((body.get('language') as string) ?? null);
    const a = answers[Math.min(asked.length - 1, answers.length - 1)];
    const payload: any = { text: a.text, language: a.language };
    if (a.logprob !== undefined) {
      payload.segments = [{ start: 0, end: 1, text: a.text, avg_logprob: a.logprob }];
    }
    return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(payload) } as any;
  }) as any;
  return { asked, restore: () => { globalThis.fetch = original; } };
}

const RU_PRONE = (over: Partial<Parameters<typeof clusterBackend>[0]> = {}) => clusterBackend({
  apiKey: CLUSTER_KEY, baseUrl: 'https://s/v1', model: 'm', fallbackLanguage: 'en', ...over,
});

test('a confident transcript is returned as it came, with one request', async () => {
  const { file, cleanup } = clip();
  const f = scriptFetch([{ text: 'all good here', language: 'en', logprob: -0.12 }]);
  try {
    const out = await transcribeAudio(file, [RU_PRONE()], { audioSeconds: 4 });
    assert.equal(out.result.text, 'all good here');
    assert.deepEqual(f.asked, [null], 'auto-detect only, no language named');
  } finally { f.restore(); cleanup(); }
});

test('a transcript the model has no confidence in is retried in the configured language, and the better one wins', async () => {
  const { file, cleanup } = clip();
  // The real case: Turkish nonsense at -0.836, the same clip at -0.075 once
  // English is named.
  const f = scriptFetch([
    { text: 'Bu hükümeti nasıl zorlamıştınız?', language: 'tr', logprob: -0.836 },
    { text: 'How did you make this rule be forced?', language: 'en', logprob: -0.075 },
  ]);
  try {
    const out = await transcribeAudio(file, [RU_PRONE()], { audioSeconds: 9 });
    assert.equal(out.result.text, 'How did you make this rule be forced?');
    assert.equal(out.result.language, 'en');
    assert.deepEqual(f.asked, [null, 'en'], 'one auto pass, then one with the language named');
  } finally { f.restore(); cleanup(); }
});

test('the retry keeps the first answer when naming a language makes it worse, and never loops', async () => {
  const { file, cleanup } = clip();
  const f = scriptFetch([
    { text: 'first, poor but better', language: 'tr', logprob: -0.50 },
    { text: 'second, worse still', language: 'en', logprob: -0.90 },
  ]);
  try {
    const out = await transcribeAudio(file, [RU_PRONE()], { audioSeconds: 9 });
    assert.equal(out.result.text, 'first, poor but better');
    assert.equal(f.asked.length, 2, 'exactly one retry, whatever it returns');
  } finally { f.restore(); cleanup(); }
});

test('the retry stays out of the way when it has nothing to add', async () => {
  const { file, cleanup } = clip();

  for (const [why, backend, options] of [
    ['no fallback is configured', CLUSTER, { audioSeconds: 9 }],
    ['the caller already named a language', RU_PRONE(), { audioSeconds: 9, language: 'ru' }],
    ['it is a translation, which takes no language', RU_PRONE(), { audioSeconds: 9, translate: true }],
  ] as const) {
    const f = scriptFetch([{ text: 'low confidence', language: 'tr', logprob: -0.9 }]);
    try {
      await transcribeAudio(file, [backend as SttBackend], options as any);
      assert.equal(f.asked.length, 1, `should not retry when ${why}`);
    } finally { f.restore(); }
  }

  // And when the backend reports no confidence at all there is nothing to judge,
  // so the answer stands rather than being second-guessed.
  const noScore = scriptFetch([{ text: 'no segments, no logprob', language: 'tr' }]);
  try {
    const out = await transcribeAudio(file, [RU_PRONE()], { audioSeconds: 9 });
    assert.equal(out.result.text, 'no segments, no logprob');
    assert.equal(noScore.asked.length, 1);
  } finally { noScore.restore(); cleanup(); }
});

test('a retry that fails outright does not cost us the first transcript', async () => {
  const { file, cleanup } = clip();
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 1) {
      return { ok: true, status: 200, statusText: 'OK', text: async () =>
        JSON.stringify({ text: 'poor but real', language: 'tr',
                         segments: [{ start: 0, end: 1, text: 'poor but real', avg_logprob: -0.8 }] }) } as any;
    }
    throw new Error('connection reset on the retry');
  }) as any;
  try {
    const out = await transcribeAudio(file, [RU_PRONE()], { audioSeconds: 9 });
    assert.equal(out.result.text, 'poor but real', 'a poor transcript beats none');
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; cleanup(); }
});

test('stt config: the retry language comes from either section, and the env wins', () => {
  const file = withEnv({}, {
    speech: { apiKey: CLUSTER_KEY, fallbackLanguage: 'en' },
    groq: { apiKey: 'gsk_x', fallbackLanguage: 'ru' },
  }, loadConfig);
  assert.equal(file.speech?.fallbackLanguage, 'en');
  assert.equal(file.groq?.fallbackLanguage, 'ru');

  const env = withEnv({ STT_FALLBACK_LANGUAGE: 'uz' }, {
    speech: { apiKey: CLUSTER_KEY, fallbackLanguage: 'en' }, groq: { apiKey: 'gsk_x' },
  }, loadConfig);
  assert.equal(env.speech?.fallbackLanguage, 'uz');
  assert.equal(env.groq?.fallbackLanguage, 'uz');

  // Unset is the default, so detection is left alone and Russian and Uzbek
  // messages from the rest of the team keep working.
  const none = withEnv({}, { speech: { apiKey: CLUSTER_KEY }, groq: { apiKey: 'gsk_x' } }, loadConfig);
  assert.equal(none.speech?.fallbackLanguage, undefined);
  assert.equal(none.groq?.fallbackLanguage, undefined);
});

test('a backend that spells the language out is not retried for no reason', async () => {
  const { file, cleanup } = clip();
  // Our cluster reports `en`; Groq reports `English` for the same clip. Compared
  // raw, every low-confidence English clip from Groq would buy a second billed
  // request that could not improve on the first.
  for (const spelling of ['English', 'english', ' EN ']) {
    const f = scriptFetch([{ text: 'low confidence but already English', language: spelling, logprob: -0.9 }]);
    try {
      const out = await transcribeAudio(file, [RU_PRONE()], { audioSeconds: 9 });
      assert.equal(f.asked.length, 1, `should not retry when the backend said ${spelling}`);
      assert.equal(out.result.text, 'low confidence but already English');
    } finally { f.restore(); }
  }

  // A language we do not recognise still gets its retry, which is the behaviour
  // without any mapping at all.
  const other = scriptFetch([
    { text: 'nonsense', language: 'Klingon', logprob: -0.9 },
    { text: 'the real thing', language: 'en', logprob: -0.1 },
  ]);
  try {
    const out = await transcribeAudio(file, [RU_PRONE()], { audioSeconds: 9 });
    assert.deepEqual(other.asked, [null, 'en']);
    assert.equal(out.result.text, 'the real thing');
  } finally { other.restore(); cleanup(); }
});

test('a cached transcript is redone only when the retry policy has changed since it was made', () => {
  const underEn = RU_PRONE();                       // fallbackLanguage: 'en'
  const underRu = RU_PRONE({ fallbackLanguage: 'ru' });

  // The real numbers: his Turkish clip scored -0.836, every correct clip -0.231
  // or better. A confident transcript is never affected by the retry, so it stays
  // a cache hit whatever the policy does — that is what keeps this free.
  assert.equal(cachedTranscriptIsSuspect({ avgLogprob: -0.231 }, underEn), false);
  assert.equal(cachedTranscriptIsSuspect({ avgLogprob: -0.075, retriedIn: 'en' }, underEn), false);

  // Made with no policy, now there is one: redone. This is the case the retry
  // was added for.
  assert.equal(cachedTranscriptIsSuspect({ avgLogprob: -0.836 }, underEn), true);

  // Made under this very policy: kept, however it came about — the retry ran and
  // won, ran and lost, threw, or was skipped because the clip was already in
  // that language. Re-running an unchanged policy cannot produce anything else,
  // and dropping it would re-transcribe the clip on every single read.
  assert.equal(cachedTranscriptIsSuspect({ avgLogprob: -0.9, retriedIn: 'en' }, underEn), false);

  // The policy changed: redone, because no Russian retry has been tried on it.
  assert.equal(cachedTranscriptIsSuspect({ avgLogprob: -0.9, retriedIn: 'en' }, underRu), true);

  // Turned off again: an entry made under a policy is no longer what no-policy
  // would produce, so it is redone rather than silently kept.
  assert.equal(cachedTranscriptIsSuspect({ avgLogprob: -0.9, retriedIn: 'en' }, CLUSTER), true);
  assert.equal(cachedTranscriptIsSuspect({ avgLogprob: -0.9 }, CLUSTER), false);

  // Spelling of the stored language does not matter.
  assert.equal(cachedTranscriptIsSuspect({ avgLogprob: -0.9, retriedIn: 'English' }, underEn), false);

  // A caller that named a language, and a translation, are never retried, so no
  // policy is in force and their entries are never thrown away.
  assert.equal(cachedTranscriptIsSuspect({ avgLogprob: -0.9 }, underEn, { language: 'ru' }), false);
  assert.equal(cachedTranscriptIsSuspect({ avgLogprob: -0.9 }, underEn, { translate: true }), false);

  // An entry from before the score was stored has no score and is kept: the
  // alternative is invalidating every transcript ever cached.
  assert.equal(cachedTranscriptIsSuspect({}, underEn), false);
});

test('the stored policy is the answering backend\'s, so each entry is judged by its own', () => {
  const cluster = RU_PRONE();
  const groq = groqBackend({ apiKey: 'gsk_x', model: 'whisper-large-v3', fallbackLanguage: 'ru' });

  assert.equal(retryPolicyOf(cluster), 'en');
  assert.equal(retryPolicyOf(groq), 'ru');
  assert.equal(retryPolicyOf(CLUSTER), undefined);

  // Never retried, so no policy was in force for these requests.
  assert.equal(retryPolicyOf(cluster, { language: 'ru' }), undefined);
  assert.equal(retryPolicyOf(cluster, { translate: true }), undefined);

  // The cluster's own low-confidence English entry is sound under the cluster's
  // policy, and must not be condemned by Groq's different one.
  const entry = { avgLogprob: -0.9, retriedIn: 'en' };
  assert.equal(cachedTranscriptIsSuspect(entry, cluster), false);
  assert.equal(cachedTranscriptIsSuspect(entry, groq), true, 'judged by the wrong backend it would be redone for ever');
});

test('the cache filename is unchanged when no retry policy applies, so an upgrade is not a cache flush', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-cache-format-'));
  const saved = process.env.CLAUDE_TOOLS_STT_CACHE_DIR;
  process.env.CLAUDE_TOOLS_STT_CACHE_DIR = dir;
  try {
    const key = { source: 'tg', id: 'chat:7', model: 'whisper-large-v3', language: 'en', translate: false, prompt: 'Context: Codex.' };
    assert.ok(writeTranscriptCache(key, { text: 'hello', model: 'whisper-large-v3' }));

    // The form as it was BEFORE the retry policy existed, written out in full.
    // Adding a field to the canonical string would rename every file on disk and
    // turn the whole cache into a miss — re-transcribing, and re-billing,
    // everything already read. This pins it.
    const legacy = ['tg', 'chat:7', 'whisper-large-v3', 'en', 'transcribe', 'Context: Codex.'].join('\u0000');
    const expected = createHash('sha256').update(legacy).digest('hex').slice(0, 32) + '.json';
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.json')), [expected]);

    // And the retry policy does NOT appear here: it lives in the record, so
    // configuring it leaves every filename alone.
    assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length, 1);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_TOOLS_STT_CACHE_DIR;
    else process.env.CLAUDE_TOOLS_STT_CACHE_DIR = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('backends sharing a cache key are all kept against it, so neither condemns the other\'s entry', () => {
  // Same model and no vocabulary, so one filename — but different retry policies.
  const asEn = clusterBackend({ apiKey: CLUSTER_KEY, baseUrl: 'https://s/v1', model: 'shared', fallbackLanguage: 'en' });
  const asRu = groqBackend({ apiKey: 'gsk_x', model: 'shared', fallbackLanguage: 'ru' });

  // An entry one of them wrote under ru: the other's en policy rejects it...
  const writtenUnderRu = { avgLogprob: -0.9, retriedIn: 'ru' };
  assert.equal(cachedTranscriptIsSuspect(writtenUnderRu, asEn), true);
  assert.equal(cachedTranscriptIsSuspect(writtenUnderRu, asRu), false);

  // ...so the reader's rule has to be that EVERY sharer disagrees before the
  // entry is thrown away. With `some`, or with only the first backend kept, this
  // entry is re-transcribed on every single read.
  const sharers = [asEn, asRu];
  assert.equal(sharers.every((b) => cachedTranscriptIsSuspect(writtenUnderRu, b)), false, 'kept');

  // And an entry made under a policy neither backend runs any more is dropped.
  const stale = { avgLogprob: -0.9, retriedIn: 'tr' };
  assert.equal(sharers.every((b) => cachedTranscriptIsSuspect(stale, b)), true, 'dropped');
});
