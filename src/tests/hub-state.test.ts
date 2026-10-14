// The watcher's local state: the cursor it resumes from, and the log of what it was
// handed.
//
// Everything here exists because of one asymmetry: a cursor that has moved past a
// message cannot be walked back. So the cursor is written atomically, the log is
// written and fsynced BEFORE the cursor advances, a torn tail from an earlier crash
// is repaired rather than fused with the next record, and a cursor belonging to
// another agent is refused rather than adopted.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  appendHubLog,
  HubPermanentError,
  type HubMessage,
  hubCursorPath,
  hubLogPath,
  isUsableCursor,
  loadHubState,
  LOG_ROTATE_BYTES,
  messageKey,
  readHubLog,
  saveHubState,
  writeAll,
} from '../services/hub.js';

/** Isolate the config dir so a test never touches a live watcher's state. */
function withConfigDir(run: (dir: string) => void) {
  return () => {
    const previous = process.env.CLAUDE_TOOLS_CONFIG_DIR;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-state-test-'));
    process.env.CLAUDE_TOOLS_CONFIG_DIR = dir;
    try {
      run(dir);
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_TOOLS_CONFIG_DIR;
      else process.env.CLAUDE_TOOLS_CONFIG_DIR = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** The hub a test's cursor belongs to. A cursor is only meaningful against one. */
const HUB = 'https://hub.example.com';

function message(overrides: Partial<HubMessage> = {}): HubMessage {
  return {
    id: '1758787200123-0',
    stream: 'inbox',
    from: 'worker',
    to: 'manager',
    kind: 'msg',
    body: 'ISSUE-20 done',
    ts: 1758787200123,
    ...overrides,
  };
}

test('only the server\'s own cursor format is submitted back', () => {
  assert.ok(isUsableCursor('1:1758787200123-0:1758787100000-4'));
  assert.ok(isUsableCursor('1:0-0:0-0'));
  assert.ok(isUsableCursor('1:1758787200123:1758787100000'));
  // `$` and `0` are bootstrap values the client invents, not values it stores: a
  // stored `$` would silently re-tail the watcher and skip whatever arrived while
  // it was down.
  assert.ok(!isUsableCursor('$'));
  assert.ok(!isUsableCursor('0'));
  assert.ok(!isUsableCursor('2:1-0:1-0'), 'a future cursor version must not be replayed as if understood');
  assert.ok(!isUsableCursor('1:nope:nope'));
  assert.ok(!isUsableCursor(''));
  assert.ok(!isUsableCursor(undefined));
});

test('a cursor round-trips, and the file is not world-readable', withConfigDir(() => {
  saveHubState('manager', { cursor: '1:1-0:2-0', agent: 'manager', origin: HUB, machine: 'ee1d927edaf31124', approvedAt: 1758787200000 });
  const { state, repaired } = loadHubState('manager', 'manager');
  assert.equal(repaired, null);
  assert.equal(state.cursor, '1:1-0:2-0');
  assert.equal(state.machine, 'ee1d927edaf31124');
  assert.equal(state.approvedAt, 1758787200000);
  assert.equal(fs.statSync(hubCursorPath('manager')).mode & 0o777, 0o600);
}));

test('a fresh state tails rather than replaying', withConfigDir(() => {
  const { state } = loadHubState('manager', 'manager');
  assert.equal(state.cursor, null);
  assert.equal(state.approvedAt, null);
}));

test('another agent\'s cursor is refused, not adopted', withConfigDir(() => {
  // A cursor is a position in one agent's inbox. Submitting it for another would
  // skip everything the other had already been sent, invisibly.
  saveHubState('shared', { cursor: '1:1-0:1-0', agent: 'manager', origin: HUB, machine: null, approvedAt: null });
  assert.throws(() => loadHubState('shared', 'worker'), (error: unknown) => {
    assert.ok(error instanceof HubPermanentError);
    assert.match(error.message, /belongs to agent "manager"/);
    return true;
  });
}));

test('a corrupt cursor file is reported and re-baselined, never fatal', withConfigDir(() => {
  const file = hubCursorPath('manager');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"cursor": "1:not-a-str', { mode: 0o600 });
  const { state, repaired } = loadHubState('manager', 'manager');
  assert.equal(state.cursor, null);
  assert.match(String(repaired), /not readable JSON/);
}));

test('an unusable cursor value is reported rather than sent to the hub', withConfigDir(() => {
  const file = hubCursorPath('manager');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ cursor: '$', agent: 'manager' }), { mode: 0o600 });
  const { state, repaired } = loadHubState('manager', 'manager');
  assert.equal(state.cursor, null);
  assert.match(String(repaired), /unusable cursor/);
}));

test('the state name is sanitised into a directory name', withConfigDir((dir) => {
  saveHubState('otherorg/36', { cursor: '1:1-0:1-0', agent: 'manager', origin: HUB, machine: null, approvedAt: null });
  // A name with a slash must not be able to write outside the state directory.
  assert.ok(hubCursorPath('otherorg/36').startsWith(path.join(dir, 'hub')));
  assert.ok(fs.existsSync(hubCursorPath('otherorg/36')));
}));

test('the log is appended, fsynced and read back oldest first', withConfigDir(() => {
  appendHubLog('manager', [message({ id: '1-0', body: 'first' }), message({ id: '2-0', body: 'second' })]);
  appendHubLog('manager', [message({ id: '3-0', body: 'third' })]);
  const read = readHubLog('manager', 10);
  assert.deepEqual(read.map((m) => m.body), ['first', 'second', 'third']);
  assert.equal(fs.statSync(hubLogPath('manager')).mode & 0o777, 0o600);
}));

test('a torn tail from an earlier crash does not swallow the next message', withConfigDir(() => {
  // The failure this prevents: appending straight onto a truncated record fuses the
  // fragment with the next one into a single unparseable line, and the real message
  // is lost while the cursor moves past it.
  const file = hubLogPath('manager');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(message({ id: '1-0', body: 'complete' }))}\n{"id":"2-0","stream":"inb`);

  appendHubLog('manager', [message({ id: '3-0', body: 'after the crash' })]);

  const read = readHubLog('manager', 10);
  assert.deepEqual(read.map((m) => m.body), ['complete', 'after the crash']);
  const lines = fs.readFileSync(file, 'utf-8').split('\n').filter((line) => line.length > 0);
  assert.equal(lines.length, 3, 'the fragment should still be its own line, not fused with the new record');
}));

test('an empty batch writes nothing at all', withConfigDir(() => {
  appendHubLog('manager', []);
  assert.ok(!fs.existsSync(hubLogPath('manager')));
}));

test('a short write throws instead of reporting success', withConfigDir(() => {
  // Most plausible on a nearly full disk, which is exactly when it matters: a
  // partially written record with a confirmed cursor is a message nobody can prove
  // arrived.
  const file = path.join(os.tmpdir(), `hub-short-write-${process.pid}`);
  const fd = fs.openSync(file, 'w');
  try {
    assert.throws(() => writeAll(fd, 'abcdef', () => 0), /Short write/);
    // A prefix write is retried from where it stopped rather than restarted.
    let calls = 0;
    writeAll(fd, 'abcdef', (_fd, buffer, offset, length) => {
      calls += 1;
      return fs.writeSync(_fd, buffer, offset, Math.min(2, length));
    });
    assert.equal(calls, 3);
    assert.equal(fs.readFileSync(file, 'utf-8'), 'abcdef');
  } finally {
    fs.closeSync(fd);
    fs.rmSync(file, { force: true });
  }
}));

test('the dedupe key is (stream, id), never the id alone', () => {
  // Redis keeps a stream's sequence counter ON THE STREAM, so an inbox entry and a
  // broadcast written in the same millisecond are both `<ms>-0`. Keying on the id
  // would silently drop one of two real messages, and only under load.
  const inbox = message({ id: '1758787200123-0', stream: 'inbox' });
  const broadcast = message({ id: '1758787200123-0', stream: 'broadcast', to: '*' });
  assert.notEqual(messageKey(inbox), messageKey(broadcast));
  assert.equal(messageKey(inbox), 'inbox:1758787200123-0');
});

test('the log survives a line the reader cannot parse', withConfigDir(() => {
  const file = hubLogPath('manager');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `not json\n${JSON.stringify(message({ id: '9-0', body: 'still here' }))}\n`);
  assert.deepEqual(readHubLog('manager', 10).map((m) => m.body), ['still here']);
}));

test('the log read is bounded by the limit, newest last', withConfigDir(() => {
  appendHubLog('manager', Array.from({ length: 5 }, (_, i) => message({ id: `${i}-0`, body: `m${i}` })));
  assert.deepEqual(readHubLog('manager', 2).map((m) => m.body), ['m3', 'm4']);
}));

// ---------------------------------------------------------------------------
// Regressions from the Codex audit of this diff (2026-09-25)
// ---------------------------------------------------------------------------

test('a cursor from a different hub is not resumed against this one', withConfigDir(() => {
  // A stream id means nothing on another server. Pointing --url at a local hub and
  // back would otherwise submit a position from one to the other: syntactically
  // valid, and it skips everything before that position on the new hub.
  saveHubState('manager', { cursor: '1:9-0:9-0', agent: 'manager', origin: 'http://127.0.0.1:8787', machine: null, approvedAt: 1 });
  const moved = loadHubState('manager', 'manager', HUB);
  assert.equal(moved.state.cursor, null);
  assert.match(String(moved.repaired), /last talked to http:\/\/127\.0\.0\.1:8787/);
  // The approval history survives, because that is about the machine rather than
  // about a stream position - the client still knows it was once approved.
  assert.equal(moved.state.approvedAt, 1);
  // And the same origin resumes normally.
  const same = loadHubState('manager', 'manager', 'http://127.0.0.1:8787');
  assert.equal(same.state.cursor, '1:9-0:9-0');
  assert.equal(same.repaired, null);
}));

test('the local log is rolled once instead of growing without bound', withConfigDir(() => {
  // Nothing else bounds this file: an agent that runs for months would fill a disk
  // one message at a time, and the first symptom would be a watcher that cannot
  // write its log. One generation is enough because the hub retains the same
  // history, so the oldest generation is expendable.
  const file = hubLogPath('manager');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'x'.repeat(LOG_ROTATE_BYTES + 1));
  appendHubLog('manager', [message({ id: '1-0', body: 'after the roll' })]);
  assert.ok(fs.existsSync(`${file}.1`), 'the previous generation should be kept');
  assert.ok(fs.statSync(file).size < 1_000, 'the live log should have started over');
  assert.deepEqual(readHubLog('manager', 10).map((m) => m.body), ['after the roll']);
}));

test('reading the log does not load the whole file into memory', withConfigDir(() => {
  // The read happens at watcher startup, where the alternative is holding every
  // message the agent has ever received in memory to return the last few.
  const file = hubLogPath('manager');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const filler = `${JSON.stringify(message({ id: '0-0', body: 'y'.repeat(4_000) }))}\n`;
  // Comfortably past the 1 MiB tail window, so the read has to skip a prefix - and
  // the skipped prefix is what makes a cut inside a multi-byte character safe.
  fs.writeFileSync(file, filler.repeat(400));
  appendHubLog('manager', [message({ id: '7-0', body: 'the newest one' })]);
  const read = readHubLog('manager', 5);
  assert.equal(read[read.length - 1]?.body, 'the newest one');
  assert.ok(read.length <= 5);
}));

test('a multi-byte body survives a tail read that cuts mid-character', withConfigDir(() => {
  const file = hubLogPath('manager');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const cyrillic = `${JSON.stringify(message({ id: '0-0', body: 'проверка '.repeat(400) }))}\n`;
  fs.writeFileSync(file, cyrillic.repeat(200));
  appendHubLog('manager', [message({ id: '8-0', body: 'после' })]);
  const read = readHubLog('manager', 3);
  assert.equal(read[read.length - 1]?.body, 'после');
  for (const entry of read) assert.ok(!entry.body.includes('�'), 'a record must not come back with a replacement character');
}));

test('a read that cannot fill its limit falls through to the previous generation', withConfigDir(() => {
  // Rotation must not look like data loss: the older generation is still there, and a
  // young live log should not report that the history is gone.
  const file = hubLogPath('manager');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.1`, [1, 2, 3].map((n) => JSON.stringify(message({ id: `${n}-0`, body: `old${n}` }))).join('\n') + '\n');
  appendHubLog('manager', [message({ id: '9-0', body: 'new' })]);
  assert.deepEqual(readHubLog('manager', 10).map((m) => m.body), ['old1', 'old2', 'old3', 'new']);
  // And a limit that the live log alone satisfies does not reach back.
  assert.deepEqual(readHubLog('manager', 1).map((m) => m.body), ['new']);
}));

test('another hub\'s records never seed this hub\'s dedupe, in any generation', withConfigDir(() => {
  // The failure this closes: a state that once pointed at hub A keeps A's records, and
  // an id that is unique on A can collide with a genuinely new message on B. Skipping
  // the seed for one run was not enough - the next start read them straight back in,
  // including out of the rolled `.1` generation. So the scoping is on the record.
  const other = 'http://127.0.0.1:8787';
  appendHubLog('manager', [message({ id: '1-0', body: 'from hub A' })], other);
  fs.renameSync(hubLogPath('manager'), `${hubLogPath('manager')}.1`);
  appendHubLog('manager', [message({ id: '2-0', body: 'from hub B' })], HUB);

  // A dedupe seed for hub B sees only B's record, even though A's is right there.
  assert.deepEqual(readHubLog('manager', 10, { origin: HUB }).map((m) => m.body), ['from hub B']);
  assert.deepEqual(readHubLog('manager', 10, { origin: other }).map((m) => m.body), ['from hub A']);
  // A human read shows everything the watcher was ever handed.
  assert.deepEqual(readHubLog('manager', 10).map((m) => m.body), ['from hub A', 'from hub B']);
  // And a record written before the field existed belongs to no hub, so it is excluded
  // from a scoped read rather than assumed to be this one's.
  appendHubLog('manager', [message({ id: '3-0', body: 'no hub recorded' })]);
  assert.deepEqual(readHubLog('manager', 10, { origin: HUB }).map((m) => m.body), ['from hub B']);
}));

test('an empty or newline-free log reads as nothing rather than throwing', withConfigDir(() => {
  const file = hubLogPath('manager');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  assert.deepEqual(readHubLog('manager', 5), []);
  fs.writeFileSync(file, '{"id":"1-0","stream":"inb');
  assert.deepEqual(readHubLog('manager', 5), []);
}));
