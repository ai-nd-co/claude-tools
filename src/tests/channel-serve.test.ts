import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface } from 'readline';
import * as path from 'path';
import * as url from 'url';

import {
  createWatchRegistry, truncateLine, exitEvent, formatWatchList, WATCH_NAME, MAX_WATCHES,
  announceRestart, restartDelay, nextConsecutiveFailures, RESTART_MAX_DELAY_MS, RESTART_STABLE_MS,
} from '../commands/channel/watch.js';
import { serveInstructions } from '../commands/channel/index.js';

const CLI = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'cli.js');
const req = (name: string, command: readonly string[]) => ({ name, command });

// ---------------------------------------------------------------------------
// the registry: what may be watched, and what a reader can still learn afterwards
// ---------------------------------------------------------------------------

test('name: a watch name is an identifier, not free text', () => {
  // The name is the `watch=` attribute on every event and the argument to watch_stop. Whitespace or a
  // quote in it would make the attribute unparseable and the stop argument ambiguous.
  for (const ok of ['logs', 'ci-2', 'a_b', 'x'.repeat(32)]) assert.match(ok, WATCH_NAME, ok);
  for (const bad of ['', 'has space', 'quote"', '-leading', 'x'.repeat(33), 'semi;colon']) {
    assert.doesNotMatch(bad, WATCH_NAME, bad);
  }
});

test('claim: the same name twice is refused, not silently replaced', () => {
  const r = createWatchRegistry();
  assert.ok('entry' in r.claim(req('logs', ['true'])));
  const second = r.claim(req('logs', ['true']));
  assert.ok('refused' in second, 'replacing it would orphan the first child with nothing listing it');
});

test('claim: an empty command is refused', () => {
  const r = createWatchRegistry();
  assert.ok('refused' in r.claim(req('x', [])));
});

test('claim: a runaway loop cannot become a fork bomb', () => {
  const r = createWatchRegistry();
  for (let i = 0; i < MAX_WATCHES; i += 1) assert.ok('entry' in r.claim(req(`w${i}`, ['true'])), `w${i}`);
  const over = r.claim(req('one-too-many', ['true']));
  assert.ok('refused' in over, 'an agent calling watch_start in a loop must hit a wall');
});

test('exit: a dead watch stays listed, because that is the evidence', () => {
  // The whole reason this beats a Monitor: an expired Monitor and a crashed one are both silence.
  const r = createWatchRegistry();
  r.claim(req('ci', ['true']));
  r.markExited('ci', 'code 1');
  const entry = r.get('ci');
  assert.equal(entry?.state.kind, 'exited');
  assert.match(formatWatchList(r.list()), /ci/);
});

test('stop: forgetting is what removes an entry', () => {
  const r = createWatchRegistry();
  r.claim(req('ci', ['true']));
  r.forget('ci');
  assert.equal(r.get('ci'), undefined);
  assert.match(formatWatchList(r.list()), /No watches/);
});

test('restart: uptime resets but the line count does not', () => {
  // A restart loop that reset `lines` to zero every couple of seconds would read as an idle watch.
  const r = createWatchRegistry();
  const claimed = r.claim(req('flaky', ['true']));
  assert.ok('entry' in claimed);
  claimed.entry.lines = 7;
  r.markExited('flaky', 'code 1');
  r.markRunning('flaky', Date.now() + 5_000);
  assert.equal(r.get('flaky')?.lines, 7);
  assert.equal(r.get('flaky')?.state.kind, 'running');
});

test('approvers: only watches that asked for permissions, and only while running', () => {
  const r = createWatchRegistry();
  r.claim({ name: 'a', command: ['true'], permissions: true });
  r.claim({ name: 'b', command: ['true'] });
  assert.deepEqual(r.approvers().map((e) => e.name), ['a']);
  r.markExited('a', 'code 0');
  assert.deepEqual(r.approvers().map((e) => e.name), [], 'a dead child cannot answer anything');
});

test('truncate: reports exactly how much was dropped', () => {
  assert.equal(truncateLine('short', 400), 'short');
  assert.match(truncateLine('a'.repeat(120), 100), /\[\+20 chars\]$/);
});

test('exit event: a signal death never reads as exit 0', () => {
  // `code` is null when a child dies on a signal. Reporting that as 0 would tell the reader the
  // watcher finished normally — the worst available lie.
  assert.equal(exitEvent('w', 0, null).meta.exit, '0');
  assert.equal(exitEvent('w', null, 'SIGKILL').meta.exit, 'SIGKILL');
  assert.match(exitEvent('w', null, 'SIGKILL').content, /SIGKILL/);
});

test('instructions: say the command is chosen at runtime, and flag the exit event', () => {
  const text = serveInstructions('watch');
  assert.match(text, /watch_start/);
  assert.match(text, /exit/);
  assert.doesNotMatch(text, /telegram|agent-hub|hub watch/i, 'the watcher knows nothing about its callers');
});

// ---------------------------------------------------------------------------
// end to end, over the real transport
// ---------------------------------------------------------------------------

/** Drive a real `channel serve` over JSON-RPC and collect its channel notifications. */
async function withServer(
  body: (
    call: (name: string, args: unknown) => number,
    events: Array<Record<string, string>>,
    replies: Map<number, unknown>,
  ) => Promise<void>,
): Promise<void> {
  const proc: ChildProcessWithoutNullStreams = spawn(
    process.execPath, [CLI, 'channel', 'serve', '--name', 'probe'], { stdio: ['pipe', 'pipe', 'pipe'] },
  ) as ChildProcessWithoutNullStreams;
  const events: Array<Record<string, string>> = [];
  const replies = new Map<number, unknown>();
  let id = 100;
  const send = (msg: unknown) => proc.stdin.write(`${JSON.stringify(msg)}\n`);
  const call = (name: string, args: unknown) => {
    id += 1;
    send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    return id;
  };

  const ready = new Promise<void>((resolve) => {
    createInterface({ input: proc.stdout, crlfDelay: Infinity }).on('line', (line) => {
      if (line.trim() === '') return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // stdout IS the transport. A stray console.log anywhere in this command lands here, and a
        // silent parse failure in a real client is the hardest version of this bug to find.
        assert.fail(`non-JSON on the MCP transport: ${line.slice(0, 200)}`);
      }
      if (msg.id === 1) { send({ jsonrpc: '2.0', method: 'notifications/initialized' }); resolve(); return; }
      if (typeof msg.id === 'number') { replies.set(msg.id, msg.result ?? msg.error); return; }
      if (msg.method === 'notifications/claude/channel') {
        const p = msg.params as { content: string; meta: Record<string, string> };
        events.push({ ...p.meta, content: p.content, at: String(Date.now()) });
      }
    });
  });

  send({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
  });
  await ready;
  try {
    await body(call, events, replies);
  } finally {
    proc.kill();
  }
}

const until = async (predicate: () => boolean, what: string, ms = 15_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`timed out waiting for ${what}`);
};

test('serve: a command chosen at runtime becomes events tagged with its watch name', async () => {
  await withServer(async (call, events) => {
    call('watch_start', { name: 'lines', command: ['printf', 'first\\nsecond\\n'] });
    await until(() => events.some((e) => e.exit !== undefined), 'the exit event');
    assert.deepEqual(
      events.filter((e) => e.exit === undefined).map((e) => e.content),
      ['first', 'second'],
      'each stdout line becomes one event, in order',
    );
    assert.ok(events.every((e) => e.watch === 'lines'), 'every event names the watch it came from');
    assert.equal(events.find((e) => e.exit !== undefined)?.exit, '0');
  });
});

test('serve: two watches run at once and stay distinguishable', async () => {
  await withServer(async (call, events) => {
    call('watch_start', { name: 'alpha', command: ['printf', 'A\\n'] });
    call('watch_start', { name: 'beta', command: ['printf', 'B\\n'] });
    await until(
      () => events.filter((e) => e.exit !== undefined).length === 2,
      'both watches to finish',
    );
    assert.equal(events.find((e) => e.content === 'A')?.watch, 'alpha');
    assert.equal(events.find((e) => e.content === 'B')?.watch, 'beta');
  });
});

test('serve: nothing runs until the client has initialized', async () => {
  // connect() resolves when the TRANSPORT is up, before the client has initialized — and Claude Code
  // drops events for a server it has not yet registered as a channel, silently and with no error.
  const proc = spawn(process.execPath, [CLI, 'channel', 'serve', '--name', 'probe'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const seen: string[] = [];
  createInterface({ input: proc.stdout, crlfDelay: Infinity }).on('line', (l) => { if (l.trim()) seen.push(l); });
  // A tools/call before `initialize` must not produce channel traffic.
  proc.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0', id: 9, method: 'tools/call',
    params: { name: 'watch_start', arguments: { name: 'early', command: ['printf', 'x\\n'] } },
  })}\n`);
  await new Promise((r) => setTimeout(r, 1_500));
  proc.kill();
  assert.equal(
    seen.filter((l) => l.includes('notifications/claude/channel')).length, 0,
    'no channel event may be emitted before the client is initialized',
  );
  // Refused, not silently ignored: the caller is there to retry, and a command whose output is
  // dropped looks identical to one that printed nothing.
  const reply = seen.map((l) => JSON.parse(l) as Record<string, unknown>).find((m) => m.id === 9);
  assert.ok(reply, 'the early call must be answered, not dropped');
  assert.match(JSON.stringify(reply), /has not finished initializing/);
});

test('restart: a clean exit is not respawned, and says so', async () => {
  // `restart` means "respawn if it DIED". A command that exits 0 has finished, and respawning it is an
  // infinite loop — found in a live session: `hub watch` on a renamed name exits 0 on purpose to name its
  // successor, and a code-blind restart turned that into a fresh process every couple of seconds. Worse
  // than the retry it replaced, because it is a whole spawn rather than one poll.
  await withServer(async (call, events) => {
    call('watch_start', { name: 'quick', command: ['printf', 'once\\n'], restart: true });
    await until(() => events.some((e) => e.restart === 'declined'), 'the declined-restart event');
    // Give a code-blind restart time to prove itself wrong: the first restart delay is under 1s.
    await new Promise((r) => setTimeout(r, 5_000));
    assert.equal(
      events.filter((e) => e.content === 'once').length, 1,
      'the command must run exactly once; more than one means restart ignored the exit code',
    );
    assert.equal(events.filter((e) => e.exit === 'restarting').length, 0, 'nothing should have restarted');
  });
});

// ---------------------------------------------------------------------------
// restart backoff and stopping a restart that is pending (#395: ISSUE-92/ISSUE-93)
// ---------------------------------------------------------------------------

test('restart: the delay doubles from about a second and stops at a minute', () => {
  const top = () => 1; // the top of the jitter band, so the shape is exact
  assert.equal(restartDelay(1, top), 1_000);
  assert.equal(restartDelay(2, top), 2_000);
  assert.equal(restartDelay(3, top), 4_000);
  assert.equal(restartDelay(7, top), RESTART_MAX_DELAY_MS);
  assert.equal(restartDelay(500, top), RESTART_MAX_DELAY_MS);
  // Jitter keeps at least half, so a fleet that failed together does not retry in lockstep, and never
  // collapses the delay to nothing.
  assert.equal(restartDelay(3, () => 0), 2_000);
});

test('restart: a long crash loop is announced at 1, 2, 3, then only at powers of two', () => {
  const announced = Array.from({ length: 40 }, (_, i) => i + 1).filter(announceRestart);
  assert.deepEqual(announced, [1, 2, 3, 4, 8, 16, 32]);
});

test('list: a watch waiting to respawn says so, rather than looking finished', () => {
  const r = createWatchRegistry();
  const claim = r.claim(req('hub', ['false']), 1_000);
  assert.ok('entry' in claim);
  r.markExited('hub', '1', 2_000);
  claim.entry.consecutiveFailures = 3;
  claim.entry.respawnAt = 6_000;
  assert.match(formatWatchList(r.list(), 2_000), /restarting in 4s \(3 failed in a row\)/);
});

test('restart: consecutive failures back off, and each announcement carries the count', async () => {
  await withServer(async (call, events) => {
    call('watch_start', { name: 'crashy', command: ['sh', '-c', 'echo run; exit 3'], restart: true });
    await until(() => events.some((e) => e.failures === '3'), 'the third failure in a row', 20_000);
    call('watch_stop', { name: 'crashy' });
    const delays = ['1', '2', '3'].map((n) => Number(events.find((e) => e.failures === n)?.restart));
    assert.ok(delays[0]! <= 1 && delays[1]! >= 1 && delays[2]! >= 2, `delays should grow: ${delays}`);
    assert.equal(events.filter((e) => e.exit === 'restarting').length, 0, 'no separate restarting event any more');
  });
});

test('stop: watch_stop during a pending restart cancels it, and nothing respawns (ISSUE-93)', async () => {
  await withServer(async (call, events, replies) => {
    call('watch_start', { name: 'loop', command: ['sh', '-c', 'echo run; exit 3'], restart: true });
    await until(() => events.some((e) => e.watch === 'loop' && e.failures === '1'), 'the first failure');
    // The respawn is now pending (0.5-1s). Before the fix, this stop forgot the entry but left the
    // timer armed, and the timer started a child no list showed and no stop could reach.
    const id = call('watch_stop', { name: 'loop' });
    await until(() => replies.has(id), 'the stop reply');
    assert.match(JSON.stringify(replies.get(id)), /pending restart is cancelled/);
    await new Promise((r) => setTimeout(r, 3_000));
    assert.equal(events.filter((e) => e.watch === 'loop' && e.content === 'run').length, 1, 'it must not have run again');
  });
});

test('restart: a run that lasted resets the count, so an occasional crash comes back fast', () => {
  assert.equal(nextConsecutiveFailures(0, 10), 1);
  assert.equal(nextConsecutiveFailures(5, RESTART_STABLE_MS - 1), 6);
  assert.equal(nextConsecutiveFailures(5, RESTART_STABLE_MS), 1);
});

test('registry: a watch waiting to respawn holds its slot and is never evicted as history', () => {
  const r = createWatchRegistry(2, 1);
  const a = r.claim(req('a', ['x']));
  assert.ok('entry' in a);
  r.markExited('a', '1');
  a.entry.respawnAt = Date.now() + 5_000; // pending restart
  assert.ok('entry' in r.claim(req('b', ['x'])));
  // One slot left for a and b together would be exceeded by c: a is still meant to run.
  assert.ok('refused' in r.claim(req('c', ['x'])), 'a pending restart must count against the limit');
  // Dead history is bounded at 1 here; ending b and adding d must evict b, never the pending a.
  r.markExited('b', '1');
  const r2 = createWatchRegistry(3, 0);
  const p = r2.claim(req('p', ['x']));
  assert.ok('entry' in p);
  r2.markExited('p', '1');
  p.entry.respawnAt = Date.now() + 5_000;
  r2.claim(req('q', ['x']));
  assert.ok(r2.get('p'), 'eviction took a watch that was waiting to respawn');
});

test('registry: a claim refused for capacity leaves the entry it would have replaced', () => {
  // The order inside claim(): the old code deleted the existing entry and THEN checked capacity, so a
  // refused reuse silently lost what was there (a watch waiting to respawn, or a dead watch's evidence).
  const r = createWatchRegistry(1, 16);
  assert.ok('entry' in r.claim(req('a', ['x'])));
  r.markExited('a', '1');
  assert.ok('entry' in r.claim(req('b', ['x'])), 'a is dead, so b fits');
  assert.ok('refused' in r.claim(req('a', ['y'])), 'b holds the only slot');
  assert.equal(r.get('a')?.state.kind, 'exited', 'the refused claim must not have deleted a');
});

test('restart: the respawns are really scheduled further and further apart', async () => {
  await withServer(async (call, events) => {
    call('watch_start', { name: 'spaced', command: ['sh', '-c', 'echo run; exit 3'], restart: true });
    await until(() => events.filter((e) => e.watch === 'spaced' && e.content === 'run').length >= 5, 'five runs', 30_000);
    call('watch_stop', { name: 'spaced' });
    const at = events.filter((e) => e.watch === 'spaced' && e.content === 'run').map((e) => Number(e.at));
    const gaps = at.slice(1).map((x, i) => x - at[i]!);
    // Delays are drawn from [0.5,1], [1,2], [2,4], [4,8] seconds. The fourth gap cannot be under 4s with
    // backoff, and cannot be over 2s with the old fixed schedule, so this one bound tells them apart.
    assert.ok(gaps[0]! >= 400 && gaps[1]! >= 900 && gaps[2]! >= 1_900 && gaps[3]! >= 3_900, `gaps should grow: ${gaps}`);
  });
});

test('restart: a command that cannot start is one event per failure, not two', async () => {
  await withServer(async (call, events) => {
    call('watch_start', { name: 'nx', command: ['/nonexistent-command-for-test'], restart: true });
    await until(() => events.some((e) => e.watch === 'nx' && e.failures === '2'), 'the second failure');
    call('watch_stop', { name: 'nx' });
    const mine = events.filter((e) => e.watch === 'nx');
    assert.equal(mine.length, 2, `expected one event per failure: ${JSON.stringify(mine)}`);
    assert.ok(mine.every((e) => e.exit === 'spawn-failed' && /could not start/.test(e.content!)));
  });
});

test('stop: a stopped child ending late does not mark its replacement as exited', async () => {
  await withServer(async (call, events, replies) => {
    // Ignores SIGTERM, so it outlives the stop by ~3s until the SIGKILL.
    call('watch_start', { name: 'rp', command: ['sh', '-c', 'trap "" TERM; while :; do sleep 0.2; done'] });
    await new Promise((r) => setTimeout(r, 300));
    call('watch_stop', { name: 'rp' });
    call('watch_start', { name: 'rp', command: ['sleep', '30'] });
    await new Promise((r) => setTimeout(r, 4_500)); // the old child is SIGKILLed and closes in here
    const list = call('watch_list', {});
    await until(() => replies.has(list), 'the list');
    assert.match(JSON.stringify(replies.get(list)), /running {2}rp/, 'the replacement must still be listed as running');
    const stop = call('watch_stop', { name: 'rp' });
    await until(() => replies.has(stop), 'the stop');
    assert.match(JSON.stringify(replies.get(stop)), /stopped \\"rp\\"/);
    assert.equal(events.filter((e) => e.watch === 'rp' && e.exit !== undefined).length, 0, 'stopped watches make no exit events');
  });
});
