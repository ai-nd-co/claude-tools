import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { measureAudioLevel, silentAudioNote } from '../services/audio-silence.js';

function hasFfmpeg(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** Generate a clip with ffmpeg so the tests measure real audio, not a fixture. */
function clip(dir: string, name: string, source: string, seconds: number): string {
  const out = join(dir, name);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', source, '-t', String(seconds), '-c:a', 'libopus', out],
    { timeout: 60_000 });
  return out;
}

const ffmpeg = hasFfmpeg();

test('a silent recording is detected', { skip: !ffmpeg && 'ffmpeg not installed' }, async () => {
  // The real case: the owner's microphone was off and Telegram still sent an
  // 8.39s voice note measuring -91 dB.
  const dir = mkdtempSync(join(tmpdir(), 'silence-test-'));
  try {
    const level = await measureAudioLevel(clip(dir, 'silence.ogg', 'anullsrc=r=48000:cl=mono', 3));

    assert.equal(level.silent, true);
    assert.ok(level.maxDb !== null && level.maxDb < -70, `peak was ${level.maxDb}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('real audio is not detected as silent', { skip: !ffmpeg && 'ffmpeg not installed' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'silence-test-'));
  try {
    const level = await measureAudioLevel(clip(dir, 'tone.ogg', 'sine=frequency=440:r=48000', 2));

    assert.equal(level.silent, false);
    assert.ok(level.maxDb !== null && level.maxDb > -70, `peak was ${level.maxDb}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('very quiet speech is still transcribed, not discarded', { skip: !ffmpeg && 'ffmpeg not installed' }, async () => {
  // The threshold sits near the digital floor on purpose. A quiet or distant
  // speaker must never be thrown away to fix a cosmetic problem - losing a real
  // message is far worse than one hallucinated word.
  const dir = mkdtempSync(join(tmpdir(), 'silence-test-'));
  try {
    const out = join(dir, 'quiet.ogg');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'sine=frequency=440:r=48000', '-t', '2',
      '-af', 'volume=-45dB', '-c:a', 'libopus', out], { timeout: 60_000 });

    const level = await measureAudioLevel(out);
    assert.equal(level.silent, false, `a -45 dB signal must not count as silence (peak ${level.maxDb})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unmeasurable file is never called silent', async () => {
  // Refusing to transcribe because measurement failed would lose real messages.
  // The gate must fail open.
  const dir = mkdtempSync(join(tmpdir(), 'silence-test-'));
  try {
    const bogus = join(dir, 'not-audio.ogg');
    writeFileSync(bogus, 'this is not an audio file');

    const level = await measureAudioLevel(bogus);
    assert.equal(level.silent, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing file is never called silent', async () => {
  const level = await measureAudioLevel('/nonexistent/definitely-not-here.ogg');
  assert.equal(level.silent, false);
  assert.equal(level.maxDb, null);
});

test('the note says what happened and carries the measurement', () => {
  assert.equal(
    silentAudioNote({ maxDb: -90.3, meanDb: -91, silent: true }),
    '[silent — no audio captured (peak -90.3 dB)]',
  );
  // Without a measurement it still explains itself rather than showing "null".
  assert.equal(
    silentAudioNote({ maxDb: null, meanDb: null, silent: true }),
    '[silent — no audio captured]',
  );
});
