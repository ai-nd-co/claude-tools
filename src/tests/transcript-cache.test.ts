import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  getTranscriptCacheDir,
  hashFileContents,
  pruneTranscriptCache,
  readTranscriptCache,
  writeTranscriptCache,
  type TranscriptCacheKey,
} from '../services/transcript-cache.js';

const KEY: TranscriptCacheKey = {
  source: 'tg',
  id: '-10042:7',
  model: 'whisper-large-v3',
};

/** Point the cache at a fresh directory and restore the env afterwards. */
function withIsolatedCache(run: (dir: string) => void): void {
  const previous = process.env.CLAUDE_TOOLS_STT_CACHE_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-cache-test-'));
  process.env.CLAUDE_TOOLS_STT_CACHE_DIR = dir;

  try {
    run(dir);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_TOOLS_STT_CACHE_DIR;
    else process.env.CLAUDE_TOOLS_STT_CACHE_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The single file the cache wrote, so a test can corrupt or age it. */
function onlyEntry(dir: string): string {
  const entries = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  assert.equal(entries.length, 1, `expected exactly one cache entry, saw ${entries.length}`);
  return path.join(dir, entries[0]);
}

test('cache dir honours the env override', () => {
  withIsolatedCache((dir) => {
    assert.equal(getTranscriptCacheDir(), dir);
  });
});

test('round-trips a transcript', () => {
  withIsolatedCache(() => {
    writeTranscriptCache(KEY, {
      text: 'this is a validation audio',
      language: 'English',
      duration: 22.6,
      model: KEY.model,
    });

    const hit = readTranscriptCache(KEY);
    assert.ok(hit);
    assert.equal(hit.text, 'this is a validation audio');
    assert.equal(hit.language, 'English');
    assert.equal(hit.duration, 22.6);
    assert.equal(typeof hit.cachedAt, 'number');
  });
});

test('misses on an unknown key', () => {
  withIsolatedCache(() => {
    assert.equal(readTranscriptCache(KEY), null);
  });
});

test('every key field changes the identity', () => {
  // A transcript produced with a different model, language, or direction is a
  // different result; serving one for another would be a silent wrong answer.
  const variants: TranscriptCacheKey[] = [
    { ...KEY, id: '-10042:8' },
    { ...KEY, source: 'file' },
    { ...KEY, model: 'whisper-large-v3-turbo' },
    { ...KEY, language: 'ru' },
    { ...KEY, translate: true },
  ];

  for (const variant of variants) {
    withIsolatedCache(() => {
      writeTranscriptCache(KEY, { text: 'original', model: KEY.model });
      assert.equal(readTranscriptCache(variant), null, `${JSON.stringify(variant)} should miss`);
    });
  }
});

test('an explicit language is distinct from auto-detect', () => {
  withIsolatedCache(() => {
    writeTranscriptCache({ ...KEY, language: 'en' }, { text: 'forced en', model: KEY.model });
    assert.equal(readTranscriptCache(KEY), null);
    assert.equal(readTranscriptCache({ ...KEY, language: 'en' })?.text, 'forced en');
  });
});

test('treats a corrupt entry as a miss', () => {
  withIsolatedCache((dir) => {
    writeTranscriptCache(KEY, { text: 'good', model: KEY.model });
    fs.writeFileSync(onlyEntry(dir), '{ this is not json');

    assert.equal(readTranscriptCache(KEY), null);
  });
});

test('rejects an entry with no usable text', () => {
  withIsolatedCache((dir) => {
    writeTranscriptCache(KEY, { text: 'good', model: KEY.model });
    fs.writeFileSync(onlyEntry(dir), JSON.stringify({ model: 'x', cachedAt: Date.now() }));

    assert.equal(readTranscriptCache(KEY), null);
  });
});

test('expires and deletes an entry nobody has read', () => {
  withIsolatedCache((dir) => {
    writeTranscriptCache(KEY, { text: 'old', model: KEY.model });

    const file = onlyEntry(dir);
    const idle = (Date.now() - 31 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(file, idle, idle);

    assert.equal(readTranscriptCache(KEY), null);
    assert.equal(fs.existsSync(file), false, 'expired entry should be removed');
  });
});

test('a cache hit refreshes the idle clock, so live entries never expire', () => {
  // Expiry must retire transcripts nobody wants, never re-bill one in daily use.
  withIsolatedCache((dir) => {
    writeTranscriptCache(KEY, { text: 'still wanted', model: KEY.model });

    const file = onlyEntry(dir);
    const nearlyIdle = (Date.now() - 29 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(file, nearlyIdle, nearlyIdle);

    assert.equal(readTranscriptCache(KEY)?.text, 'still wanted');
    assert.ok(
      Date.now() - fs.statSync(file).mtimeMs < 5000,
      'reading the entry should have bumped its mtime',
    );

    // Two more days pass; the refreshed clock keeps it alive.
    const later = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(file, later, later);
    assert.equal(readTranscriptCache(KEY)?.text, 'still wanted');
  });
});

test('reports whether the write succeeded', () => {
  withIsolatedCache(() => {
    assert.equal(writeTranscriptCache(KEY, { text: 'x', model: KEY.model }), true);
  });
});

test('overwrites an existing entry rather than duplicating it', () => {
  withIsolatedCache((dir) => {
    writeTranscriptCache(KEY, { text: 'first', model: KEY.model });
    writeTranscriptCache(KEY, { text: 'second', model: KEY.model });

    assert.equal(readTranscriptCache(KEY)?.text, 'second');
    assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.json')).length, 1);
  });
});

test('leaves no temp files behind', () => {
  withIsolatedCache((dir) => {
    writeTranscriptCache(KEY, { text: 'x', model: KEY.model });
    assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')).length, 0);
  });
});

test('a write failure does not throw', () => {
  const previous = process.env.CLAUDE_TOOLS_STT_CACHE_DIR;
  // A path under a regular file can never be created, standing in for a
  // read-only or exhausted temp directory.
  const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stt-blocked-')), 'file');
  fs.writeFileSync(blocker, 'not a directory');
  process.env.CLAUDE_TOOLS_STT_CACHE_DIR = path.join(blocker, 'cache');

  try {
    let stored: boolean | undefined;
    assert.doesNotThrow(() => { stored = writeTranscriptCache(KEY, { text: 'x', model: KEY.model }); });
    assert.equal(stored, false, 'an unwritable cache must report the failure, not hide it');
    assert.equal(readTranscriptCache(KEY), null);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_TOOLS_STT_CACHE_DIR;
    else process.env.CLAUDE_TOOLS_STT_CACHE_DIR = previous;
    fs.rmSync(path.dirname(blocker), { recursive: true, force: true });
  }
});

test('hashes file contents, not the path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-hash-'));
  try {
    const a = path.join(dir, 'a.ogg');
    const b = path.join(dir, 'b.ogg');
    const c = path.join(dir, 'c.ogg');
    fs.writeFileSync(a, 'same audio bytes');
    fs.writeFileSync(b, 'same audio bytes');
    fs.writeFileSync(c, 'different bytes');

    assert.equal(hashFileContents(a), hashFileContents(b));
    assert.notEqual(hashFileContents(a), hashFileContents(c));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('prune removes aged entries and keeps fresh ones', () => {
  withIsolatedCache((dir) => {
    writeTranscriptCache(KEY, { text: 'fresh', model: KEY.model });
    writeTranscriptCache({ ...KEY, id: '-10042:99' }, { text: 'stale', model: KEY.model });

    const files = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => path.join(dir, n));
    const stale = files.find((f) => JSON.parse(fs.readFileSync(f, 'utf-8')).text === 'stale')!;
    const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
    fs.utimesSync(stale, old / 1000, old / 1000);

    assert.equal(pruneTranscriptCache(), 1);
    assert.equal(fs.existsSync(stale), false);
    assert.equal(readTranscriptCache(KEY)?.text, 'fresh');
  });
});

test('prune on a missing directory is a no-op', () => {
  const previous = process.env.CLAUDE_TOOLS_STT_CACHE_DIR;
  process.env.CLAUDE_TOOLS_STT_CACHE_DIR = path.join(os.tmpdir(), 'stt-does-not-exist-12345');
  try {
    assert.equal(pruneTranscriptCache(), 0);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_TOOLS_STT_CACHE_DIR;
    else process.env.CLAUDE_TOOLS_STT_CACHE_DIR = previous;
  }
});

test('the decoding prompt is part of the cache identity', () => {
  // A prompted transcript differs from an unprompted one, so serving one for the
  // other would silently return the wrong text.
  withIsolatedCache(() => {
    writeTranscriptCache({ ...KEY, prompt: 'Dokku, Headscale' }, { text: 'prompted', model: KEY.model });

    assert.equal(readTranscriptCache(KEY), null, 'unprompted must not reuse a prompted entry');
    assert.equal(readTranscriptCache({ ...KEY, prompt: 'other' }), null);
    assert.equal(readTranscriptCache({ ...KEY, prompt: 'Dokku, Headscale' })?.text, 'prompted');
  });
});
