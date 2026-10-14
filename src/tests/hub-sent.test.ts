/**
 * #406: no duplicate messages after an outage.
 *
 * Two mechanisms doubled traffic on 2026-09-28. Sessions resent what they could not see (`hub log` shows
 * the inbox, never one's own sends), and re-arms left a second watcher running, so every message was
 * delivered twice. The first is answered by a record of confirmed sends and a refusal to repeat one; the
 * second by one watcher per agent, held as an OS-level lock that a newer watcher takes over by asking.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createConnection } from 'node:net';
import type { AddressInfo } from 'node:net';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
  findRecentSend, forgetSent, hubSentPath, readSent, recordSent, RESEND_WINDOW_MS, withSendLock,
} from '../services/hub.js';
import { acquireWatchOwnership, findUnlockedWatchers, ownerAddress, withProcessLock } from '../services/hub-owner.js';

const ORIGIN = 'https://hub.example';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function withConfig(run: (home: string) => void | Promise<void>) {
  return async () => {
    const home = mkdtempSync(join(tmpdir(), 'hub-sent-'));
    const before = process.env.CLAUDE_TOOLS_CONFIG_DIR;
    process.env.CLAUDE_TOOLS_CONFIG_DIR = join(home, 'claude-tools');
    try {
      await run(home);
    } finally {
      if (before === undefined) delete process.env.CLAUDE_TOOLS_CONFIG_DIR;
      else process.env.CLAUDE_TOOLS_CONFIG_DIR = before;
      rmSync(home, { recursive: true, force: true });
    }
  };
}

// ---------------------------------------------------------------------------
// the send record
// ---------------------------------------------------------------------------

test('record: same hub, recipient, text, kind and corr within the hour, by THIS machine\'s clock', withConfig(async () => {
  const now = Date.now();
  const key = { to: 'peer', body: 'hello there' };
  // The server's ts is far in the future; it must not stretch or shrink the window.
  await recordSent('me', { id: '1-0', to: 'peer', ts: now + 10 * RESEND_WINDOW_MS }, key, ORIGIN, now - 60_000);
  assert.equal(findRecentSend('me', key, ORIGIN, now)?.id, '1-0');
  assert.equal(findRecentSend('me', { ...key, body: 'hello there!' }, ORIGIN, now), undefined, 'different text');
  assert.equal(findRecentSend('me', { ...key, to: 'other' }, ORIGIN, now), undefined, 'different recipient');
  assert.equal(findRecentSend('me', key, 'https://other.hub', now), undefined, 'different hub');
  assert.equal(findRecentSend('me', { ...key, corr: 'q-2' }, ORIGIN, now), undefined, 'a reply to another corr is a new message');
  assert.equal(findRecentSend('me', { ...key, kind: 'restart' }, ORIGIN, now), undefined, 'another kind is a new message');
  assert.equal(findRecentSend('me', key, ORIGIN, now - 60_000 + RESEND_WINDOW_MS + 1), undefined, 'older than the hour');
}));

test('record: a pruned message is not a duplicate: forgetting it lets the same text be sent again', withConfig(async () => {
  const now = Date.now();
  const key = { to: '*', body: 'K3S APPLY HOLD' };
  await recordSent('me', { id: '7-0', to: '*', ts: now }, key, ORIGIN, now - 1_000);
  await recordSent('me', { id: '7-0', to: '*', ts: now }, key, 'https://other.hub', now - 1_000);
  await recordSent('me', { id: '8-0', to: 'peer', ts: now }, { to: 'peer', body: 'keep me' }, ORIGIN, now - 1_000);
  assert.equal(findRecentSend('me', key, ORIGIN, now)?.id, '7-0');
  // The same id in another stream (an inbox) is another message, and stays protected.
  await recordSent('me', { id: '7-0', to: 'peer', ts: now }, { to: 'peer', body: 'same id, other stream' }, ORIGIN, now - 1_000);
  assert.equal(await forgetSent('me', ORIGIN, [{ id: '7-0', to: '*' }]), 1);
  assert.equal(findRecentSend('me', { to: 'peer', body: 'same id, other stream' }, ORIGIN, now)?.id, '7-0');
  assert.equal(findRecentSend('me', key, ORIGIN, now), undefined, 'pruned on this hub: no longer a duplicate');
  assert.equal(findRecentSend('me', key, 'https://other.hub', now)?.id, '7-0', 'the same id on another hub is another message');
  assert.equal(findRecentSend('me', { to: 'peer', body: 'keep me' }, ORIGIN, now)?.id, '8-0', 'other records stay');
  assert.equal(await forgetSent('me', ORIGIN, [{ id: '7-0', to: '*' }]), 0);
  assert.equal(await forgetSent('nobody', ORIGIN, [{ id: '7-0', to: '*' }]), 0, 'no record file at all');
}));

test('record: an expired message is not a duplicate: once gone from the hub, it may be sent again', withConfig(async () => {
  const now = Date.now();
  await recordSent('me', { id: 'ttl-1', to: 'peer', ts: 1 }, { to: 'peer', body: 'applying now', ttlSeconds: 30 }, ORIGIN, now);
  assert.equal(findRecentSend('me', { to: 'peer', body: 'applying now' }, ORIGIN, now + 10_000)?.id, 'ttl-1', 'still live');
  assert.equal(findRecentSend('me', { to: 'peer', body: 'applying now' }, ORIGIN, now + 31_000), undefined, 'expired');
}));

test('record: a match is found however many sends came after it', withConfig(async () => {
  const now = Date.now();
  await recordSent('me', { id: 'first', to: 'peer', ts: 1 }, { to: 'peer', body: 'the one' }, ORIGIN, now - 1_000);
  for (let i = 0; i < 600; i += 1) {
    await recordSent('me', { id: `n${i}`, to: 'peer', ts: 1 }, { to: 'peer', body: `other ${i}` }, ORIGIN, now);
  }
  assert.equal(findRecentSend('me', { to: 'peer', body: 'the one' }, ORIGIN, now)?.id, 'first');
}));

test('record: a torn last line is skipped, and the NEXT confirmation is still found', withConfig(async () => {
  await recordSent('me', { id: '2-0', to: 'peer', ts: 1 }, { to: 'peer', body: `long ${'x'.repeat(200)}` }, ORIGIN);
  appendFileSync(hubSentPath('me'), '{"id":"3-0","to":"pe');
  assert.equal(readSent('me', 10, ORIGIN).length, 1);
  assert.ok(readSent('me', 10, ORIGIN)[0]!.head.length <= 81, 'only a short head of the body is kept');
  await recordSent('me', { id: '4-0', to: 'peer', ts: 1 }, { to: 'peer', body: 'after the tear' }, ORIGIN);
  assert.equal(findRecentSend('me', { to: 'peer', body: 'after the tear' }, ORIGIN)?.id, '4-0');
}));

test('record: pruning keeps every confirmation inside the hour, and bounds only older history', withConfig(async () => {
  const now = Date.now();
  for (let i = 0; i < 2_500; i += 1) {
    await recordSent('me', { id: `old${i}`, to: 'p', ts: 1 }, { to: 'p', body: `old ${i}` }, ORIGIN, now - 2 * RESEND_WINDOW_MS);
  }
  await recordSent('me', { id: 'keep', to: 'p', ts: 1 }, { to: 'p', body: 'recent one' }, ORIGIN, now - 60_000);
  for (let i = 0; i < 2_000; i += 1) {
    await recordSent('me', { id: `new${i}`, to: 'p', ts: 1 }, { to: 'p', body: `new ${i}` }, ORIGIN, now);
  }
  assert.equal(findRecentSend('me', { to: 'p', body: 'recent one' }, ORIGIN, now)?.id, 'keep');
  const lines = readFileSync(hubSentPath('me'), 'utf8').trim().split('\n').length;
  assert.ok(lines < 4_501, `older history was pruned, got ${lines} lines`);
}));

test('send lock: the same message is serialised; a different one is not; a dead holder\'s lock expires', withConfig(async () => {
  const key = { to: 'peer', body: 'same' };
  const order: string[] = [];
  const slow = (tag: string) => async () => { order.push(`${tag}+`); await sleep(150); order.push(`${tag}-`); };
  await Promise.all([withSendLock('me', key, ORIGIN, slow('a')), withSendLock('me', key, ORIGIN, slow('b'))]);
  assert.ok(order.join() === 'a+,a-,b+,b-' || order.join() === 'b+,b-,a+,a-', `serialised: ${order}`);

  order.length = 0;
  await Promise.all([
    withSendLock('me', key, ORIGIN, slow('a')),
    withSendLock('me', { ...key, body: 'different' }, ORIGIN, slow('c')),
  ]);
  assert.equal(order.slice(0, 2).sort().join(), 'a+,c+', 'different messages do not wait for each other');

  // A holder that dies releases the lock at once: the kernel drops its socket with the process. An
  // age-based lock file used to make a dead holder block for a minute and a slow live one lose its lock.
  const holder = spawn(process.execPath, ['--input-type=module', '-e',
    `const m = await import(${JSON.stringify(resolve('dist/services/hub-owner.js'))});`
    + `await m.withProcessLock('probe', ['held-by-child'], () => { console.log('held'); return new Promise(() => {}); });`,
  ], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((done) => holder.stdout!.once('data', () => done()));
  const waiting = withProcessLock('probe', ['held-by-child'], async () => 'mine', 10_000);
  await sleep(300);
  holder.kill('SIGKILL');
  const started = Date.now();
  assert.equal(await waiting, 'mine');
  assert.ok(Date.now() - started < 2_000, 'a dead holder must release the lock at once');
}));

// ---------------------------------------------------------------------------
// one watcher per agent
// ---------------------------------------------------------------------------

test('owner: the address is exact to the identity, never shared through sanitising', () => {
  const a = ownerAddress({ origin: ORIGIN, agent: 'x', state: 'a/b' })!;
  assert.notEqual(a, ownerAddress({ origin: ORIGIN, agent: 'x', state: 'a_b' }));
  assert.notEqual(a, ownerAddress({ origin: 'https://other', agent: 'x', state: 'a/b' }));
  assert.equal(a, ownerAddress({ origin: ORIGIN, agent: 'x', state: 'a/b' }));
});

test('owner: a newer claimant takes over by asking; the owner is told and leaves', withConfig(async () => {
  const id = { origin: ORIGIN, agent: 'me', state: `me-${process.pid}-1` };
  let aLeft = false;
  const a = await acquireWatchOwnership(id, () => { aLeft = true; a.close(); });
  assert.equal(a.tookOver, false);
  const b = await acquireWatchOwnership(id, () => b.close());
  assert.ok(aLeft, 'the earlier owner must have been asked');
  assert.equal(b.tookOver, true);
  b.close();
}));

test('owner: a request naming another identity is refused, and the owner stays', withConfig(async () => {
  const id = { origin: ORIGIN, agent: 'me', state: `me-${process.pid}-2` };
  let asked = false;
  const a = await acquireWatchOwnership(id, () => { asked = true; });
  const reply = await new Promise<string>((done) => {
    const socket = createConnection(ownerAddress(id)!);
    socket.on('connect', () => socket.write(`${JSON.stringify({ op: 'takeover', ...id, agent: 'someone-else' })}\n`));
    socket.on('data', (b: Buffer) => { done(String(b)); socket.destroy(); });
  });
  assert.match(reply, /"ok":false/);
  // Valid JSON of the wrong shape is refused too, and does not crash the owner.
  const nullReply = await new Promise<string>((done) => {
    const socket = createConnection(ownerAddress(id)!);
    socket.on('connect', () => socket.write('null\n'));
    socket.on('data', (b: Buffer) => { done(String(b)); socket.destroy(); });
  });
  assert.match(nullReply, /"ok":false/);
  assert.equal(asked, false);
  a.close();
}));

test('owner: an owner that will not let go means "takeover failed", never two owners', withConfig(async () => {
  const id = { origin: ORIGIN, agent: 'me', state: `me-${process.pid}-3` };
  const a = await acquireWatchOwnership(id, () => { /* ignores the request */ });
  await assert.rejects(() => acquireWatchOwnership(id, () => undefined, { timeoutMs: 1_500 }), /did not hand over/);
  a.close();
}));

test('owner: three claimants at once end with exactly one owner', withConfig(async () => {
  const id = { origin: ORIGIN, agent: 'me', state: `me-${process.pid}-4` };
  const live = new Map<string, { close(): void }>();
  const claim = async (tag: string) => {
    const o = await acquireWatchOwnership(id, () => { live.delete(tag); o.close(); });
    live.set(tag, o);
  };
  await claim('a');
  await Promise.all([claim('b'), claim('c')]);
  await sleep(300);
  assert.equal(live.size, 1, `exactly one owner, got ${[...live.keys()]}`);
  for (const o of live.values()) o.close();
}));

test('unlocked watchers: exact argv tokens only; wrappers, supervisors and --once are not reported', async () => {
  const idle = 'setTimeout(() => {}, 30000)';
  const legacy = spawn(process.execPath, ['-e', idle, 'hub', 'watch', '--agent', 'legacy-x']);
  const otherHub = spawn(process.execPath, ['-e', idle, 'hub', 'watch', '--agent', 'legacy-x', '--url', 'https://elsewhere']);
  const otherAgentSameState = spawn(process.execPath, ['-e', idle, 'hub', 'watch', '--agent', 'y', '--state', 'legacy-x']);
  const once = spawn(process.execPath, ['-e', idle, 'hub', 'watch', '--agent', 'legacy-x', '--once']);
  const supervisor = spawn(process.execPath, ['-e', idle, 'channel', 'serve', '--watch', 'hub', '--', 'hub', 'watch', '--agent', 'legacy-x']);
  const wrapper = spawn('sh', ['-c', 'sleep 30 # hub watch --agent legacy-x']);
  try {
    await sleep(300);
    const found = findUnlockedWatchers({ origin: ORIGIN, agent: 'legacy-x', state: 'legacy-x' });
    assert.deepEqual(found, [legacy.pid]);
    assert.deepEqual(findUnlockedWatchers({ origin: ORIGIN, agent: 'other', state: 'other' }), []);
  } finally {
    for (const p of [legacy, otherHub, otherAgentSameState, once, supervisor, wrapper]) p.kill('SIGKILL');
  }
});

// ---------------------------------------------------------------------------
// through the compiled CLI, against a fake hub
// ---------------------------------------------------------------------------

interface FakeHub {
  base: string;
  posts: () => number;
  release: () => void;
  close: () => Promise<void>;
}

/**
 * A hub with one message, `m1`, which is held back until `release()` and then handed to any poll whose
 * cursor is not past it. POSTs are answered after a short delay, to widen any check-then-send window.
 */
async function fakeHub(opts: { dropPosts?: boolean; body?: string; kind?: string; pollStatus?: number } = {}): Promise<FakeHub> {
  let posts = 0;
  let seq = 0;
  let released = false;
  const waiting: Array<() => void> = [];
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://x');
    const chunks: Buffer[] = [];
    request.on('data', (c: Buffer) => chunks.push(c));
    request.on('end', () => {
      const reply = (status: number, body: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      };
      if (request.method === 'POST' && url.pathname === '/api/messages') {
        if (opts.dropPosts) { request.socket.destroy(); return; }
        posts += 1;
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { to: string };
        setTimeout(() => reply(201, { id: `17906${++seq}-0`, to: body.to, ts: Date.now() }), 300);
        return;
      }
      if (url.pathname === '/api/messages' && opts.pollStatus !== undefined) {
        reply(opts.pollStatus, { error: 'not_found' });
        return;
      }
      if (url.pathname === '/api/messages') {
        const after = url.searchParams.get('after');
        const answer = () => {
          if (released && after !== 'c1') {
            reply(200, {
              messages: [{
                id: '1-0', stream: 'inbox', from: 'peer', to: 'me', kind: opts.kind ?? 'message',
                body: opts.body ?? 'm1-body', ts: Date.now(),
              }],
              cursor: 'c1',
              waitedMs: 0,
            });
          } else {
            reply(200, { messages: [], cursor: after === 'c1' ? 'c1' : 'c0', waitedMs: 0 });
          }
        };
        if (!released && url.searchParams.get('wait') !== '0') {
          const timer = setTimeout(answer, 2_000);
          waiting.push(() => { clearTimeout(timer); answer(); });
          return;
        }
        setTimeout(answer, 100);
        return;
      }
      reply(200, { ok: true, version: 'test' });
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    posts: () => posts,
    release: () => { released = true; for (const w of waiting.splice(0)) w(); },
    close: () => new Promise<void>((done) => { server.closeAllConnections?.(); server.close(() => done()); }),
  };
}

function cliEnv(home: string): NodeJS.ProcessEnv {
  return { ...process.env, XDG_CONFIG_HOME: home, CLAUDE_TOOLS_CONFIG_DIR: join(home, 'claude-tools'), AGENT_HUB_AGENT: '', AGENT_HUB_URL: '' };
}

/** Run the CLI WITHOUT blocking this process: `spawnSync` would freeze the fake hub's event loop. */
function runCli(home: string, args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const proc = spawn(process.execPath, [resolve('dist/cli.js'), ...args], { env: cliEnv(home), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (b: Buffer) => { stdout += String(b); });
    proc.stderr.on('data', (b: Buffer) => { stderr += String(b); });
    proc.on('close', (status) => done({ status, stdout, stderr }));
  });
}

test('compiled CLI: a resend is refused naming the first id, with the same JSON shape; corr and --again send', async () => {
  const hub = await fakeHub();
  const home = mkdtempSync(join(tmpdir(), 'hub-sent-cli-'));
  const run = (...args: string[]) => runCli(home, ['hub', ...args, '--as', 'me', '--url', hub.base]);
  try {
    const first = await run('send', 'peer', 'the build is green');
    assert.equal(first.status, 0, first.stderr);
    const id = /#(\S+)/.exec(first.stdout)?.[1];
    assert.ok(id, first.stdout);

    const again = await run('send', 'peer', 'the build is green');
    assert.equal(again.status, 3, 'a refused duplicate exits 3: not sent, and not a failure');
    assert.match(again.stdout, /Exit status 3: not sent/);
    assert.match(again.stdout, new RegExp(`Already sent to peer as #${id}`));
    assert.equal(hub.posts(), 1, 'the duplicate must not reach the hub');

    const jsonRun = await run('send', 'peer', 'the build is green', '--json');
    assert.equal(jsonRun.status, 3, '--json exits 3 on a duplicate too');
    const json = JSON.parse(jsonRun.stdout) as Record<string, unknown>;
    assert.equal(json.id, id, 'a caller reading `id` gets the confirmed id');
    assert.equal(json.duplicate, true);
    assert.equal(json.head, undefined, 'the duplicate answer carries confirmation metadata only');

    assert.equal((await run('send', 'peer', 'the build is green', '--corr', 'q-7')).status, 0);
    assert.equal(hub.posts(), 2, 'the same text answering another corr is a new message');

    assert.equal((await run('send', 'peer', 'the build is green', '--again')).status, 0);
    assert.equal(hub.posts(), 3, '--again sends anyway');

    assert.equal((await run('broadcast', 'all hands at noon')).status, 0);
    const twice = await run('broadcast', 'all hands at noon');
    assert.equal(twice.status, 3, 'a repeated broadcast exits 3 as well');
    assert.equal(hub.posts(), 4, 'the repeated broadcast must not reach the hub');

    const sent = await run('sent');
    assert.equal(sent.status, 0, sent.stderr);
    assert.equal(sent.stdout.trim().split('\n').length, 4);
    assert.match(sent.stdout, new RegExp(`#${id}  → peer: the build is green`));
  } finally {
    await hub.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('compiled CLI: --ttl sends ttlSeconds; an out-of-range --ttl never reaches the hub', async () => {
  const bodies: unknown[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (c: Buffer) => chunks.push(c));
    request.on('end', () => {
      if (request.method === 'POST') bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: `9-${bodies.length}`, to: 'peer', ts: Date.now() }));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const home = mkdtempSync(join(tmpdir(), 'hub-sent-ttl-'));
  try {
    const ok = await runCli(home, ['hub', 'send', 'peer', 'applying #9', '--ttl', '30m', '--as', 'me', '--url', base]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal((bodies[0] as { ttlSeconds?: number }).ttlSeconds, 1_800);
    const tooLong = await runCli(home, ['hub', 'send', 'peer', 'other', '--ttl', '8d', '--as', 'me', '--url', base]);
    assert.notEqual(tooLong.status, 0);
    assert.match(tooLong.stderr, /at most 7d/);
    assert.equal(bodies.length, 1, 'the refused send must not reach the hub');
  } finally {
    await new Promise<void>((done) => { server.closeAllConnections?.(); server.close(() => done()); });
    rmSync(home, { recursive: true, force: true });
  }
});

test('compiled CLI: two sessions sending the same message at once send it once', async () => {
  const hub = await fakeHub();
  const home = mkdtempSync(join(tmpdir(), 'hub-sent-race-'));
  try {
    const both = await Promise.all([
      runCli(home, ['hub', 'send', 'peer', 'at the same moment', '--as', 'me', '--url', hub.base]),
      runCli(home, ['hub', 'send', 'peer', 'at the same moment', '--as', 'me', '--url', hub.base]),
    ]);
    assert.deepEqual(both.map((r) => r.status).sort(), [0, 3], 'one sends (0), the other is refused as a duplicate (3)');
    assert.equal(hub.posts(), 1, 'exactly one POST');
    assert.equal(both.filter((r) => /Already sent/.test(r.stdout)).length, 1);
  } finally {
    await hub.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('compiled CLI: a send whose answer never came says it may have landed, and how to check', async () => {
  const hub = await fakeHub({ dropPosts: true });
  const home = mkdtempSync(join(tmpdir(), 'hub-sent-drop-'));
  try {
    const started = Date.now();
    const out = await runCli(home, ['hub', 'send', 'peer', 'hi', '--as', 'me', '--url', hub.base]);
    assert.ok(Date.now() - started < 10_000, 'a dropped connection, not the 15s timeout, must be what this measures');
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /may or may not have received it/);
    assert.match(out.stderr, /hub log --agent peer/);
    assert.ok(!existsSync(join(home, 'claude-tools', 'hub', 'me', 'sent.jsonl')), 'an unconfirmed send is not recorded');
  } finally {
    await hub.close();
    rmSync(home, { recursive: true, force: true });
  }
});

function startWatcher(home: string, base: string, extra: string[] = []) {
  const proc = spawn(process.execPath, [resolve('dist/cli.js'), 'hub', 'watch', '--agent', 'me', '--url', base, ...extra], {
    env: cliEnv(home), stdio: ['ignore', 'pipe', 'pipe'],
  }) as unknown as ChildProcessWithoutNullStreams;
  const out = { text: '', code: undefined as number | null | undefined };
  proc.stdout.on('data', (b: Buffer) => { out.text += String(b); });
  proc.on('exit', (code) => { out.code = code; });
  return { proc, out };
}

async function until(ok: () => boolean, what: string, ms = 15_000): Promise<void> {
  for (const deadline = Date.now() + ms; !ok();) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

test('compiled CLI: a takeover that arrives mid-delivery waits for it; the message is delivered once', async () => {
  // The body is larger than a pipe buffer and A's stdout is not read, so A is provably stuck INSIDE its
  // delivery when B asks it to hand over. Only when A's output is drained can it finish, save its cursor
  // and leave; B, which reads the cursor only after it owns the lock, must then not print m1 again.
  const big = `m1-body ${'z'.repeat(3_000_000)}`;
  const hub = await fakeHub({ body: big });
  const home = mkdtempSync(join(tmpdir(), 'hub-sent-mid-'));
  const a = startWatcher(home, hub.base, ['--max-text', '4000000']);
  let b: ReturnType<typeof startWatcher> | undefined;
  try {
    await until(() => /watching/.test(a.out.text), 'the first watcher to start');
    a.proc.stdout.pause();
    hub.release();
    await sleep(800); // A is now blocked writing m1
    b = startWatcher(home, hub.base, ['--max-text', '4000000']);
    await sleep(1_500); // B has asked; A cannot leave yet
    assert.equal(a.out.code, undefined, 'A must not leave in the middle of a delivery');
    a.proc.stdout.resume();
    await until(() => a.out.code !== undefined, 'A to finish and leave');
    assert.equal(a.out.code, 0);
    await until(() => /took over from an earlier watcher/.test(b!.out.text), 'the takeover line');
    await sleep(1_500);
    const printed = (a.out.text.match(/m1-body/g)?.length ?? 0) + (b.out.text.match(/m1-body/g)?.length ?? 0);
    assert.equal(printed, 1, 'm1 must be delivered exactly once across both watchers');
  } finally {
    a.proc.kill('SIGKILL');
    b?.proc.kill('SIGKILL');
    await hub.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('compiled CLI: a watcher that stops for a permanent reason actually exits', async () => {
  const hub = await fakeHub({ pollStatus: 404 });
  const home = mkdtempSync(join(tmpdir(), 'hub-sent-exit-'));
  const w = startWatcher(home, hub.base);
  try {
    await until(() => w.out.code !== undefined, 'the watcher to exit after a permanent error', 10_000);
    assert.equal(w.out.code, 1);
  } finally {
    w.proc.kill('SIGKILL');
    await hub.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('compiled CLI: --exit-on-restart exits, rather than holding its lock and hanging', async () => {
  const hub = await fakeHub({ kind: 'restart' });
  const home = mkdtempSync(join(tmpdir(), 'hub-sent-restart-'));
  const w = startWatcher(home, hub.base, ['--exit-on-restart']);
  try {
    await until(() => /watching/.test(w.out.text), 'the watcher to start');
    hub.release();
    await until(() => w.out.code !== undefined, 'the watcher to exit on the restart broadcast', 10_000);
    assert.equal(w.out.code, 0);
  } finally {
    w.proc.kill('SIGKILL');
    await hub.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('compiled CLI: a takeover that fails refuses to start, and the process exits', withConfig(async (home) => {
  const hub = await fakeHub();
  // The owner, in this process, answers ok and never leaves.
  const owner = await acquireWatchOwnership({ origin: hub.base, agent: 'me', state: 'me' }, () => undefined);
  const w = startWatcher(home, hub.base);
  try {
    await until(() => w.out.code !== undefined, 'the refused watcher to exit', 20_000);
    assert.equal(w.out.code, 1);
    assert.match(w.out.text, /Not starting a second watcher/);
  } finally {
    owner.close();
    w.proc.kill('SIGKILL');
    await hub.close();
  }
}));

test('compiled CLI: three watchers started together leave exactly one running', async () => {
  const hub = await fakeHub();
  const home = mkdtempSync(join(tmpdir(), 'hub-sent-three-'));
  const all = [startWatcher(home, hub.base)];
  try {
    await until(() => /watching/.test(all[0]!.out.text), 'the first watcher');
    all.push(startWatcher(home, hub.base), startWatcher(home, hub.base));
    await until(() => all.filter((w) => w.out.code !== undefined).length >= 2, 'two of them to leave', 25_000);
    await sleep(1_000);
    const running = all.filter((w) => w.out.code === undefined);
    assert.equal(running.length, 1, 'exactly one watcher delivers');
    for (const w of all.filter((x) => x.out.code !== undefined)) assert.equal(w.out.code, 0, w.out.text);
  } finally {
    for (const w of all) w.proc.kill('SIGKILL');
    await hub.close();
    rmSync(home, { recursive: true, force: true });
  }
});

void mkdirSync; void dirname;
