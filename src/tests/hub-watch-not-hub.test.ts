/**
 * ISSUE-92: when something other than the hub answers `/api`, the watcher waits for the hub instead of
 * exiting, and sends the machine credential to nothing while it waits.
 *
 * Reproduces 2026-09-28: a host-less IngressRoute sent `/api` on every host to another app for twelve
 * minutes. That app answered `/api/messages` with an HTML 404 and `/api/health` with a 200 of its own.
 * Every `hub watch` exited on the 404, and its supervisor respawned it every two seconds, each time
 * sending the fingerprint to the app.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

interface Seen { path: string; fingerprinted: boolean; phase: 'foreign' | 'hub' }

test('compiled CLI: a foreign /api answer is waited out without the credential, then the watch resumes', async () => {
  let phase: 'foreign' | 'hub' = 'foreign';
  const seen: Seen[] = [];
  const server: Server = createServer((request: IncomingMessage, response) => {
    const path = (request.url ?? '').split('?')[0]!;
    seen.push({ path, fingerprinted: request.headers['x-hub-fingerprint'] !== undefined, phase });
    if (phase === 'foreign') {
      if (path === '/api/health') {
        // What the other app said: a 200 that is not the hub. A status-code check calls this recovered.
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: 'ok', timestamp: '2026-09-28T17:08:06Z' }));
        return;
      }
      response.writeHead(404, { 'content-type': 'text/html' });
      response.end('<!DOCTYPE html><html><body>404: This page could not be found.</body></html>');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    if (path === '/api/health') {
      response.end(JSON.stringify({ ok: true, version: '52475ae9b61e' }));
      return;
    }
    // Hold briefly, like a long poll, so the watcher is not spinning while the test reads its output.
    setTimeout(() => response.end(JSON.stringify({ messages: [], cursor: '1:1-0:1-0', waitedMs: 0 })), 200);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const home = mkdtempSync(join(tmpdir(), 'hub-not-hub-'));
  const proc = spawn(process.execPath, [resolve('dist/cli.js'), 'hub', 'watch', '--agent', 'probe-test', '--url', base], {
    env: {
      ...process.env,
      XDG_CONFIG_HOME: home,
      CLAUDE_TOOLS_CONFIG_DIR: join(home, 'claude-tools'),
      AGENT_HUB_AGENT: '',
      AGENT_HUB_URL: '',
      // This test is about what is reported, so it reports at once rather than after the default quiet spell.
      CLAUDE_TOOLS_HUB_OUTAGE_REPORT_MS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let exitCode: number | null | undefined;
  proc.stdout.on('data', (b: Buffer) => { stdout += String(b); });
  proc.on('exit', (code) => { exitCode = code; });
  const until = async (ok: () => boolean, what: string, ms = 15_000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!ok()) {
      if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}. stdout so far:\n${stdout}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  try {
    await until(() => /something other than the hub answered/.test(stdout), 'the not-the-hub report');
    // Long enough for the old code to have exited, and for the new code to probe more than once.
    await new Promise((r) => setTimeout(r, 3_000));
    assert.equal(exitCode, undefined, `the watcher exited (${exitCode}) instead of waiting for the hub`);
    assert.doesNotMatch(stdout, /Check the hub URL/, 'the URL was fine; the old text sent people to edit it');
    assert.match(stdout, /body: <!DOCTYPE html>/, 'the report must say what answered instead');

    const foreign = seen.filter((s) => s.phase === 'foreign');
    const fingerprinted = foreign.filter((s) => s.fingerprinted);
    assert.equal(fingerprinted.length, 1, `only the request that met the foreign app may carry the credential: ${JSON.stringify(foreign)}`);
    assert.ok(foreign.filter((s) => s.path === '/api/health').length >= 2, 'it should be probing /api/health');
    assert.equal(stdout.match(/\[hub\] ERROR/g)?.length, 1, 'reported once, not once per probe');

    phase = 'hub';
    await until(() => /\[hub\] recovered/.test(stdout), 'the watcher resuming against the hub');
    assert.ok(seen.some((s) => s.phase === 'hub' && s.path === '/api/messages' && s.fingerprinted));
  } finally {
    proc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(home, { recursive: true, force: true });
  }
});

test('compiled CLI: stopping while the hub is not answering sends nothing carrying the credential', async () => {
  const seen: Array<{ method: string; path: string; fingerprinted: boolean }> = [];
  const server: Server = createServer((request, response) => {
    seen.push({
      method: request.method ?? '',
      path: (request.url ?? '').split('?')[0]!,
      fingerprinted: request.headers['x-hub-fingerprint'] !== undefined,
    });
    response.writeHead(404, { 'content-type': 'text/html' });
    response.end('<html>not here</html>');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const home = mkdtempSync(join(tmpdir(), 'hub-not-hub-stop-'));
  const proc = spawn(process.execPath, [resolve('dist/cli.js'), 'hub', 'watch', '--agent', 'probe-test', '--url', base], {
    env: {
      ...process.env, XDG_CONFIG_HOME: home, CLAUDE_TOOLS_CONFIG_DIR: join(home, 'claude-tools'), AGENT_HUB_AGENT: '', AGENT_HUB_URL: '',
      CLAUDE_TOOLS_HUB_OUTAGE_REPORT_MS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  proc.stdout.on('data', (b: Buffer) => { stdout += String(b); });
  const exited = new Promise<number | null>((done) => proc.on('exit', (code) => done(code)));
  try {
    const deadline = Date.now() + 15_000;
    while (!/something other than the hub/.test(stdout)) {
      if (Date.now() > deadline) assert.fail(`no not-the-hub report; stdout:\n${stdout}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    const before = seen.filter((s) => s.fingerprinted).length;
    // What watch_stop and a closing session send.
    proc.kill('SIGTERM');
    assert.equal(await exited, 0, 'a stop during the wait is still a clean exit');
    const after = seen.filter((s) => s.fingerprinted);
    assert.equal(after.length, before, `the stop sent the credential to whatever answers: ${JSON.stringify(after)}`);
    assert.ok(!seen.some((s) => s.method === 'PUT'), 'no status write while the hub is not answering');
  } finally {
    proc.kill('SIGKILL');
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(home, { recursive: true, force: true });
  }
});

/** A hub that is down until `up` is set, then serves `messages` once. */
async function flakyHub(messages: unknown[] = []) {
  const state = { up: false, served: false };
  const server: Server = createServer((request, response) => {
    const path = (request.url ?? '').split('?')[0]!;
    if (!state.up) {
      // What the ingress says while the hub pod is being replaced.
      response.writeHead(503, { 'content-type': 'text/plain' });
      response.end('no available server');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    if (path === '/api/health') {
      response.end(JSON.stringify({ ok: true, version: '52475ae9b61e' }));
      return;
    }
    const batch = state.served ? [] : messages;
    state.served = true;
    setTimeout(() => response.end(JSON.stringify({ messages: batch, cursor: '1:1-0:1-0', waitedMs: 0 })), 200);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { state, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

function watch(base: string, home: string, env: Record<string, string> = {}) {
  const proc = spawn(process.execPath, [resolve('dist/cli.js'), 'hub', 'watch', '--agent', 'probe-test', '--url', base], {
    env: { ...process.env, XDG_CONFIG_HOME: home, CLAUDE_TOOLS_CONFIG_DIR: join(home, 'claude-tools'), AGENT_HUB_AGENT: '', AGENT_HUB_URL: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = { stdout: '', stderr: '' };
  proc.stdout.on('data', (b: Buffer) => { out.stdout += String(b); });
  proc.stderr.on('data', (b: Buffer) => { out.stderr += String(b); });
  return { proc, out };
}

async function until(ok: () => boolean, what: string, out: { stdout: string }, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}. stdout so far:\n${out.stdout}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('compiled CLI: a short hub outage wakes nobody — no ERROR line and no "recovered"', async () => {
  // Davron, 2026-10-06: a watcher event nobody acts on is a defect in the watcher. A rollout is a minute.
  const hub = await flakyHub();
  const home = mkdtempSync(join(tmpdir(), 'hub-quiet-'));
  const { proc, out } = watch(hub.base, home);
  try {
    await until(() => /poll failed|not the hub answering/.test(out.stderr), 'the outage to be seen', out);
    await new Promise((r) => setTimeout(r, 2_500));
    hub.state.up = true;
    await until(() => /resuming|connected as/.test(out.stderr + out.stdout), 'the watcher resuming', out, 20_000);
    await new Promise((r) => setTimeout(r, 500));
    assert.doesNotMatch(out.stdout, /\[hub\] ERROR/, 'a short outage must not wake the agent');
    assert.doesNotMatch(out.stdout, /\[hub\] recovered/, 'nor its end, which nobody was told began');
  } finally {
    proc.kill('SIGKILL');
    await new Promise<void>((done) => hub.server.close(() => done()));
    rmSync(home, { recursive: true, force: true });
  }
});

test('compiled CLI: an outage past the quiet spell is reported once, and so is its end', async () => {
  const hub = await flakyHub();
  const home = mkdtempSync(join(tmpdir(), 'hub-long-'));
  const { proc, out } = watch(hub.base, home, { CLAUDE_TOOLS_HUB_OUTAGE_REPORT_MS: '1500' });
  try {
    await until(() => /\[hub\] ERROR/.test(out.stdout), 'the outage report', out);
    hub.state.up = true;
    await until(() => /\[hub\] recovered/.test(out.stdout), 'the recovery report', out, 30_000);
    assert.equal(out.stdout.match(/\[hub\] ERROR/g)?.length, 1, 'reported once, not once per retry');
  } finally {
    proc.kill('SIGKILL');
    await new Promise<void>((done) => hub.server.close(() => done()));
    rmSync(home, { recursive: true, force: true });
  }
});

test('compiled CLI: an agent is not woken by its own broadcast, and still gets everyone else\'s', async () => {
  const at = Date.now();
  const hub = await flakyHub([
    { id: '1-0', stream: 'broadcast', from: 'probe-test', to: '*', kind: 'msg', body: 'MINE, sent to all', ts: at },
    { id: '2-0', stream: 'broadcast', from: 'coordinator', to: '*', kind: 'msg', body: 'THEIRS, sent to all', ts: at },
    { id: '3-0', stream: 'inbox', from: 'probe-test', to: 'probe-test', kind: 'msg', body: 'A NOTE TO SELF', ts: at },
  ]);
  hub.state.up = true;
  const home = mkdtempSync(join(tmpdir(), 'hub-own-'));
  const { proc, out } = watch(hub.base, home);
  try {
    await until(() => /THEIRS/.test(out.stdout), 'the other agent\'s broadcast', out);
    await new Promise((r) => setTimeout(r, 500));
    assert.doesNotMatch(out.stdout, /MINE/, 'its own broadcast must not wake the sender');
    assert.match(out.stdout, /A NOTE TO SELF/, 'a direct message to itself is deliberate and still delivered');
  } finally {
    proc.kill('SIGKILL');
    await new Promise<void>((done) => hub.server.close(() => done()));
    rmSync(home, { recursive: true, force: true });
  }
});
