import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { OUTBOX_SUFFIX, outboxUnsupportedReason, resetOutboxForTests, writeOutbox } from '../services/outbox.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-test-'));
}

test('outbox: one file per non-empty line, each ending in a newline', () => {
  const dir = path.join(tempDir(), 'box');
  const written = writeOutbox(dir, 'first\n\nsecond\nthird\n');
  assert.equal(written.length, 3);
  assert.deepEqual(written.map((f) => fs.readFileSync(f, 'utf-8')), ['first\n', 'second\n', 'third\n']);
});

test('outbox: a byte-wise sort of the names is the write order, even within one millisecond', () => {
  const dir = tempDir();
  const lines = Array.from({ length: 25 }, (_, i) => `line ${i}`);
  // A frozen clock: only the sequence can order these.
  for (const line of lines) writeOutbox(dir, `${line}\n`, () => 1_791_460_000_000);
  // A later write with a later clock still sorts after them.
  writeOutbox(dir, 'later\n', () => 1_791_460_000_001);
  const names = fs.readdirSync(dir).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  assert.deepEqual(names.map((n) => fs.readFileSync(path.join(dir, n), 'utf-8').trimEnd()), [...lines, 'later']);
});

test('outbox: no temporary file is left behind, and only finished files carry the suffix', () => {
  const dir = tempDir();
  writeOutbox(dir, 'a\nb\n');
  const names = fs.readdirSync(dir);
  assert.equal(names.length, 2);
  assert.ok(names.every((n) => n.endsWith(OUTBOX_SUFFIX)));
});

test('outbox: the directory is private and so is every file', () => {
  const dir = path.join(tempDir(), 'private');
  const [file] = writeOutbox(dir, 'subject line\n');
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('outbox: empty text writes nothing and does not fail', () => {
  const dir = tempDir();
  assert.deepEqual(writeOutbox(dir, ''), []);
  assert.deepEqual(writeOutbox(dir, '\n\n'), []);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('outbox: an unwritable directory throws instead of dropping the line', () => {
  const parent = tempDir();
  const blocker = path.join(parent, 'not-a-dir');
  fs.writeFileSync(blocker, 'x');
  assert.throws(() => writeOutbox(blocker, 'must not vanish\n'));
});

function contentsInNameOrder(dir: string): string[] {
  return fs.readdirSync(dir).filter((n) => n.endsWith(OUTBOX_SUFFIX))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((n) => fs.readFileSync(path.join(dir, n), 'utf-8').trimEnd());
}

test('outbox: a clock stepping back cannot put a newer line first', () => {
  const dir = tempDir();
  writeOutbox(dir, 'before the step\n', () => 1_791_460_000_000);
  writeOutbox(dir, 'after the step\n', () => 1_791_459_000_000);
  assert.deepEqual(contentsInNameOrder(dir), ['before the step', 'after the step']);
});

test('outbox: a new process with an earlier clock still sorts after lines already waiting', () => {
  const dir = tempDir();
  writeOutbox(dir, 'left by the last run\n', () => 1_791_460_000_000);
  resetOutboxForTests();
  writeOutbox(dir, 'first of this run\n', () => 1_791_000_000_000);
  assert.deepEqual(contentsInNameOrder(dir), ['left by the last run', 'first of this run']);
});

test('outbox: creates missing parent directories', () => {
  const dir = path.join(tempDir(), 'a', 'b', 'outbox');
  writeOutbox(dir, 'deep\n');
  assert.deepEqual(contentsInNameOrder(dir), ['deep']);
});

test('outbox: multi-byte text is written whole', () => {
  const dir = tempDir();
  const line = '[📬 personal] 10:00 personal ü@x: Ünïcödé ✅ '.repeat(200);
  writeOutbox(dir, `${line}\n`);
  assert.deepEqual(contentsInNameOrder(dir), [line.trimEnd()]);
});

test('outbox: a batch that fails part-way never lets a later line sort before its written lines', () => {
  const dir = tempDir();
  writeOutbox(dir, 'seed\n', () => 1_791_460_000_000);
  // The clock fails on the third line: A and B are on disk, C is not.
  let calls = 0;
  const failsThird = () => {
    calls += 1;
    if (calls === 3) throw new Error('simulated failure');
    return 1_791_460_000_000;
  };
  assert.throws(() => writeOutbox(dir, 'A\nB\nC\n', failsThird));
  // The same frozen clock afterwards: the next key must still come after B's.
  writeOutbox(dir, 'after the failure\n', () => 1_791_460_000_000);
  assert.deepEqual(contentsInNameOrder(dir), ['seed', 'A', 'B', 'after the failure']);
});

test('outbox: an existing directory open to others is made private before use', () => {
  const dir = tempDir();
  fs.chmodSync(dir, 0o777);
  resetOutboxForTests();
  writeOutbox(dir, 'private\n');
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
});

test('outbox: a failed rename leaves no temporary file behind', () => {
  const dir = tempDir();
  // A directory where the final name should go makes the rename fail after the data is written.
  const clock = () => 1_791_470_000_000;
  resetOutboxForTests();
  const probe = writeOutbox(dir, 'probe\n', clock)[0];
  const next = path.basename(probe).replace(/^\d{15}/, String(1_791_470_000_001).padStart(15, '0'))
    .replace(/-(\d{10})\.line$/, (_, seq: string) => `-${String(Number(seq) + 1).padStart(10, '0')}.line`);
  fs.mkdirSync(path.join(dir, next));
  fs.writeFileSync(path.join(dir, next, 'occupied'), 'x');
  assert.throws(() => writeOutbox(dir, 'blocked\n', clock));
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);
});

test('outbox: refused on Windows, allowed on Linux and macOS', () => {
  assert.match(outboxUnsupportedReason('win32') ?? '', /not supported on Windows/);
  assert.equal(outboxUnsupportedReason('linux'), null);
  assert.equal(outboxUnsupportedReason('darwin'), null);
});

test('outbox: a directory deleted and recreated under a running writer is made private again', () => {
  const dir = path.join(tempDir(), 'box');
  resetOutboxForTests();
  writeOutbox(dir, 'first\n');
  fs.rmSync(dir, { recursive: true });
  fs.mkdirSync(dir, { mode: 0o777 });
  fs.chmodSync(dir, 0o777);
  writeOutbox(dir, 'second\n');
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.deepEqual(contentsInNameOrder(dir), ['second']);
});

test('outbox: permissions loosened on a directory already in use are tightened on the next write', () => {
  const dir = path.join(tempDir(), 'box');
  resetOutboxForTests();
  writeOutbox(dir, 'first\n');
  fs.chmodSync(dir, 0o777);
  writeOutbox(dir, 'second\n');
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
});

test('outbox: a symlinked outbox is refused', () => {
  const base = tempDir();
  fs.mkdirSync(path.join(base, 'real'));
  fs.symlinkSync(path.join(base, 'real'), path.join(base, 'link'));
  assert.throws(() => writeOutbox(path.join(base, 'link'), 'x\n'), /symlink/);
  assert.deepEqual(fs.readdirSync(path.join(base, 'real')), []);
});

test('outbox: a replaced directory holding later keys is ordered after, not before', () => {
  const base = tempDir();
  const dir = path.join(base, 'box');
  resetOutboxForTests();
  writeOutbox(dir, 'old directory\n', () => 1_000);
  // Replace it with a restored queue whose waiting line has a higher key.
  const restored = path.join(base, 'restored');
  writeOutbox(restored, 'restored line\n', () => 2_000);
  fs.rmSync(dir, { recursive: true });
  fs.renameSync(restored, dir);
  writeOutbox(dir, 'written after the swap\n', () => 900);
  assert.deepEqual(contentsInNameOrder(dir), ['restored line', 'written after the swap']);
});

test('outbox: an empty write on a fresh directory still raises the watermark', () => {
  const base = tempDir();
  const dir = path.join(base, 'box');
  writeOutbox(dir, 'waiting\n', () => 2_000);
  resetOutboxForTests();
  writeOutbox(dir, '', () => 900);
  writeOutbox(dir, 'next\n', () => 900);
  assert.deepEqual(contentsInNameOrder(dir), ['waiting', 'next']);
});
