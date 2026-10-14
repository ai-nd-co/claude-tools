import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'child_process';
import { createInterface } from 'readline';
import * as path from 'path';
import * as url from 'url';

import {
  createPermissionRelay,
  parseVerdictLine,
  PERMISSION_REQUEST_METHOD,
  PERMISSION_METHOD,
  PERMISSION_CAPABILITY,
  REQUEST_ID,
  MAX_OUTSTANDING,
} from '../commands/channel/permission.js';
import { serveInstructions } from '../commands/channel/index.js';

const CLI = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'cli.js');

const request = (request_id: string) => ({
  request_id,
  tool_name: 'Bash',
  description: 'run a command',
  input_preview: '{ command: "ls" }',
});

test('request id: five letters, and never an l', () => {
  // The client builds these from a 25-letter alphabet with `l` removed, because somebody is going to
  // read the id off a phone screen where `l`, `1` and `I` are the same three pixels.
  assert.ok(REQUEST_ID.test('abcde'));
  assert.ok(REQUEST_ID.test('zzzzz'));
  assert.ok(!REQUEST_ID.test('abcle'), 'l is not in the alphabet the client draws from');
  assert.ok(!REQUEST_ID.test('abcd'), 'four is not five');
  assert.ok(!REQUEST_ID.test('abcdef'), 'six is not five');
  assert.ok(!REQUEST_ID.test('abc de'));
});

test('verdict: y allows and n denies', () => {
  assert.deepEqual(parseVerdictLine('y abcde'), { request_id: 'abcde', behavior: 'allow' });
  assert.deepEqual(parseVerdictLine('n abcde'), { request_id: 'abcde', behavior: 'deny' });
  assert.deepEqual(parseVerdictLine('yes abcde'), { request_id: 'abcde', behavior: 'allow' });
  assert.deepEqual(parseVerdictLine('no abcde'), { request_id: 'abcde', behavior: 'deny' });
});

test('verdict: a phone that capitalises the first letter still gets through', () => {
  // The plugin's regex is case-insensitive for exactly this reason, and the id is normalised down
  // because the client lowercases before it looks for a pending entry.
  assert.deepEqual(parseVerdictLine('Y ABCDE'), { request_id: 'abcde', behavior: 'allow' });
  assert.deepEqual(parseVerdictLine('  No   abcde  '), { request_id: 'abcde', behavior: 'deny' });
});

test('verdict: conversation is not approval', () => {
  // This is the whole reason the regex is strict rather than a substring search. Somebody agreeing
  // with a sentence must never be able to approve a tool call by accident.
  assert.equal(parseVerdictLine('yes'), undefined, 'a bare yes approves nothing');
  assert.equal(parseVerdictLine('sure, y abcde'), undefined, 'no chatter before it');
  assert.equal(parseVerdictLine('y abcde please'), undefined, 'no chatter after it');
  assert.equal(parseVerdictLine('yabcde'), undefined, 'the separator is required');
  assert.equal(parseVerdictLine('maybe abcde'), undefined);
  assert.equal(parseVerdictLine(''), undefined);
  assert.equal(parseVerdictLine('   '), undefined);
});

test('verdict: the JSON form is the object we put on the wire', () => {
  assert.deepEqual(parseVerdictLine('{"request_id":"abcde","behavior":"allow"}'), {
    request_id: 'abcde',
    behavior: 'allow',
  });
  assert.deepEqual(parseVerdictLine('{"request_id":"ABCDE","behavior":"deny"}'), {
    request_id: 'abcde',
    behavior: 'deny',
  });
  // Only the client's own two values. Anything else is not a verdict, and guessing at what "yes",
  // "true" or "approve" was meant to mean is how a deny becomes an allow.
  assert.equal(parseVerdictLine('{"request_id":"abcde","behavior":"yes"}'), undefined);
  assert.equal(parseVerdictLine('{"request_id":"abcde","behavior":true}'), undefined);
  assert.equal(parseVerdictLine('{"request_id":"abcde"}'), undefined);
  assert.equal(parseVerdictLine('{"behavior":"allow"}'), undefined);
  assert.equal(parseVerdictLine('{not json'), undefined);
});

test('relay: a verdict for an id we never issued is dropped', () => {
  // The forgery case. Claude Code drops an unknown id as well, but a wrapper that forwards whatever
  // it is handed is an approval-forgery hole no matter who else happens to catch it.
  const relay = createPermissionRelay();
  const outcome = relay.accept('y zzzzz');
  assert.ok('dropped' in outcome, 'nothing was issued, so nothing may be answered');
  assert.match((outcome as { dropped: string }).dropped, /never issued/);
  assert.equal(relay.outstanding, 0);
});

test('relay: issuing one id does not answer for another', () => {
  const relay = createPermissionRelay();
  relay.issue(request('abcde'));
  assert.ok('dropped' in relay.accept('y qrstu'), 'a different id is still a forgery');
  assert.equal(relay.outstanding, 1, 'and the real request is still answerable');
  assert.deepEqual(relay.accept('n abcde'), {
    verdict: { request_id: 'abcde', behavior: 'deny' },
  });
});

test('relay: a request is answerable exactly once', () => {
  // Consumed on use, so a replayed line cannot turn a deny into an allow after the fact.
  const relay = createPermissionRelay();
  relay.issue(request('abcde'));
  assert.ok('verdict' in relay.accept('n abcde'));
  assert.ok('dropped' in relay.accept('y abcde'), 'the second answer has nothing left to answer');
});

test('relay: case does not decide whether a verdict lands', () => {
  const relay = createPermissionRelay();
  relay.issue(request('ABCDE'));
  assert.deepEqual(relay.accept('y abcde'), {
    verdict: { request_id: 'abcde', behavior: 'allow' },
  });
});

test('relay: the outstanding set is bounded', () => {
  // Most requests are answered in the terminal and the client never tells us, so ids only accumulate.
  // Without a bound a long-lived channel leaks one entry per gated tool call, forever.
  const relay = createPermissionRelay(3);
  for (const id of ['aaaaa', 'bbbbb', 'ccccc', 'ddddd']) relay.issue(request(id));
  assert.equal(relay.outstanding, 3);
  assert.ok('dropped' in relay.accept('y aaaaa'), 'the oldest was evicted first');
  assert.ok('verdict' in relay.accept('y ddddd'), 'the newest is still answerable');
  assert.equal(MAX_OUTSTANDING, 64, 'the shipped default, recorded so a change is deliberate');
});

test('relay: the stdin line is the notification itself, params untouched', () => {
  // A forwarder needs to know what it is looking at without being taught a private format, and the
  // params must arrive exactly as the client sent them — the description and preview are what the
  // person approving actually reads.
  const relay = createPermissionRelay();
  const params = request('abcde');
  const line = relay.issue(params);
  assert.ok(!line.includes('\n'), 'one line, or the reader loses framing');
  assert.deepEqual(JSON.parse(line), { method: PERMISSION_REQUEST_METHOD, params });
});

test('instructions: permission text appears only when the relay is on', () => {
  const off = serveInstructions('probe');
  const on = serveInstructions('probe', true);
  assert.ok(!/PERMISSION/.test(off), 'a channel that cannot relay approvals must not claim it can');
  assert.match(on, /PERMISSION/);
  assert.match(on, /first answer to arrive\s+wins/, 'wrap-tolerant: the text is joined with newlines');
});

/** Drive one `channel serve` process over real JSON-RPC and hand back what it wrote. */
interface Harness {
  readonly proc: ChildProcess;
  readonly initialize: Promise<Record<string, unknown>>;
  readonly events: Array<{ content: string; meta: Record<string, string> }>;
  readonly verdicts: Array<{ request_id: string; behavior: string }>;
  send(message: Record<string, unknown>): void;
}

function launch(args: readonly string[]): Harness {
  const proc = spawn(process.execPath, [CLI, 'channel', 'serve', ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const events: Array<{ content: string; meta: Record<string, string> }> = [];
  const verdicts: Array<{ request_id: string; behavior: string }> = [];
  let settle: (result: Record<string, unknown>) => void = () => {};
  const initialize = new Promise<Record<string, unknown>>((resolve) => {
    settle = resolve;
  });

  createInterface({ input: proc.stdout!, crlfDelay: Infinity }).on('line', (line) => {
    if (line.trim() === '') return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Our stdout IS the transport. One stray byte here and the channel dies with a parse error, so
      // fail on it rather than time out somewhere unrelated.
      assert.fail(`non-JSON on the MCP transport: ${line.slice(0, 200)}`);
    }
    if (msg.id === 1) settle((msg.result ?? {}) as Record<string, unknown>);
    else if (msg.method === 'notifications/claude/channel') {
      events.push(msg.params as { content: string; meta: Record<string, string> });
    } else if (msg.method === PERMISSION_METHOD) {
      verdicts.push(msg.params as { request_id: string; behavior: string });
    }
  });

  const send = (message: Record<string, unknown>): void => {
    proc.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  };
  send({
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
  });
  return { proc, initialize, events, verdicts, send };
}

/** Poll instead of sleeping a fixed interval, so a slow machine does not turn into a flake. */
async function until(predicate: () => boolean, what: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('serve: the permission capability is absent unless --permissions is passed', async () => {
  // Requirement 3, checked the only way that counts: from the initialize result the client reads.
  // Declaring this capability is an assertion that the server authenticates whoever answers, so it
  // must never appear for a caller who did not ask for it.
  const plain = launch(['--name', 'probe']);
  const gated = launch(['--permissions', '--name', 'probe']);
  try {
    const [a, b] = await Promise.all([plain.initialize, gated.initialize]);
    const caps = (r: Record<string, unknown>) =>
      ((r.capabilities as { experimental?: Record<string, unknown> } | undefined)?.experimental) ?? {};
    assert.ok('claude/channel' in caps(a), 'it is still a channel');
    assert.ok(!(PERMISSION_CAPABILITY in caps(a)), 'off unless asked for');
    assert.ok('claude/channel' in caps(b));
    assert.ok(PERMISSION_CAPABILITY in caps(b), '--permissions is what turns it on');
  } finally {
    plain.proc.kill();
    gated.proc.kill();
  }
});

/**
 * End-to-end: a request out on stdin, a verdict back on fd 3, over the real transport.
 *
 * The wrapped command answers a forged id first and the real one second, on the same pipe and in that
 * order. So if exactly one verdict reaches the wire, the forgery was dropped — no timing assumption
 * needed, because a notification that was going to be sent would already have been sent.
 */
test('serve: a verdict from the wrapped command lands, and a forged one does not', async () => {
  const forwarder = [
    'const fs = require("fs");',
    // The child is spawned only once the client has initialized, so this line is also the handshake:
    // until it arrives as an event there is no stdin to write a request to.
    'console.log("ready");',
    'let buf = "";',
    'process.stdin.on("data", (d) => {',
    '  buf += d;',
    '  let i;',
    '  while ((i = buf.indexOf("\\n")) >= 0) {',
    '    const line = buf.slice(0, i); buf = buf.slice(i + 1);',
    '    const id = JSON.parse(line).params.request_id;',
    '    console.log("asked about " + id);',
    '    fs.writeSync(3, "y zzzzz\\n");',
    '    fs.writeSync(3, "y " + id + "\\n");',
    '  }',
    '});',
  ].join('');

  const h = launch(['--permissions', '--name', 'probe']);
  try {
    const result = await h.initialize;
    assert.ok(
      PERMISSION_CAPABILITY in
        (((result.capabilities as { experimental?: Record<string, unknown> }).experimental) ?? {}),
    );
    h.send({ method: 'notifications/initialized' });
    h.send({
      id: 50, method: 'tools/call',
      params: {
        name: 'watch_start',
        // permissions:true is what makes this watch one the relay may hand a request to.
        arguments: { name: 'fwd', command: [process.execPath, '-e', forwarder], permissions: true },
      },
    });
    await until(() => h.events.some((e) => e.content === 'ready'), 'the wrapped command to start');
    h.send({
      method: PERMISSION_REQUEST_METHOD,
      params: {
        request_id: 'abcde',
        tool_name: 'Bash',
        description: 'delete the old data',
        input_preview: '{ command: "rm -rf /tmp/x" }',
      },
    });

    await until(() => h.verdicts.length > 0, 'a verdict on the wire');
    assert.deepEqual(h.verdicts, [{ request_id: 'abcde', behavior: 'allow' }], 'exactly one, ours');

    // The forwarder printed a line too, which proves the log path still works alongside the relay
    // rather than being replaced by it.
    await until(() => h.events.some((e) => e.content === 'asked about abcde'), 'the log line');
    assert.ok(
      h.events.every((e) => !e.content.includes('zzzzz')),
      'a dropped verdict must not leak into the event stream either',
    );
  } finally {
    h.proc.kill();
  }
});

test('serve: without --permissions a permission_request is never relayed', async () => {
  // The capability is absent so the client would not send one — but if it ever did, a wrapper that is
  // not in the approval business must stay out of it, and the child must not be handed a stdin.
  // A watch that runs and echoes anything it reads, so the assertion below is about an actual child
  // rather than the absence of one — a test that passes because nothing ran is worse than no test.
  const echoStdin =
    'console.log("ready"); '
    + 'process.stdin.on("data", (d) => console.log("READ " + String(d).trim())); '
    + 'setTimeout(() => {}, 30000);';
  const h = launch(['--name', 'probe']);
  try {
    await h.initialize;
    h.send({ method: 'notifications/initialized' });
    h.send({
      id: 51, method: 'tools/call',
      params: {
        // permissions deliberately omitted — this watch must never be handed a request.
        name: 'watch_start',
        arguments: { name: 'echo', command: [process.execPath, '-e', echoStdin] },
      },
    });
    await until(() => h.events.some((e) => e.content === 'ready'), 'the watch to start');
    h.send({ method: PERMISSION_REQUEST_METHOD, params: request('abcde') });
    await new Promise((r) => setTimeout(r, 1500));
    assert.deepEqual(h.verdicts, [], 'no verdict may be produced');
    assert.ok(h.events.every((e) => !e.content.startsWith('READ ')), 'the child saw nothing on stdin');
  } finally {
    h.proc.kill();
  }
});
