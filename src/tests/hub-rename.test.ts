// `hub rename` — one command, three targets (roadmap ISSUE-82, decisions in ISSUE-82a).
//
// The three targets fail independently, so what is tested here is mostly *which* of them
// landed rather than whether "the rename worked":
//
//  - the hub is the only fatal one, and it must refuse a bad target name before it moves
//    anything, because the server moves four keys and then frees the old name;
//  - tmux must no-op cleanly when there is no pane, which is the NORMAL case for a `--bg`
//    session, and a tmux failure must not be reported as a failed rename;
//  - the Claude session name is never attempted, only printed.
//
// The wire half runs against a `node:http` server rather than a stubbed `fetch`, for the
// reason `hub-client.test.ts` gives: a stub would pass while the client sent the request
// to the wrong path or the credential in the wrong header.

import test from 'node:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { resolve } from 'node:path';

import {
  claudeRenameStep,
  formatRenameReport,
  renameTmuxSession,
  type RenameStep,
  type TmuxRunner,
} from '../commands/hub/index.js';
import {
  FINGERPRINT_HEADER, HubClient, HubPermanentError, HubTransientError,
  hubRenamedToPath, hubStateDir, followRenames,
} from '../services/hub.js';

/** Shaped like a real one — 43 base64url characters — but obviously not derived. */
const FINGERPRINT = 'Ukh-4k-7jbPI1NzOHQf5YrxT882e8wSXBGbAwUvlrok';

interface Recorded {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

async function withServer(handler: Handler, run: (base: string, calls: Recorded[]) => Promise<void>): Promise<void> {
  const calls: Recorded[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      calls.push({
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf-8'),
      });
      handler(request, response);
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`, calls);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

function client(base: string, agent = 'otherorg-8ad9'): HubClient {
  return new HubClient({ baseUrl: base, agent, fingerprint: FINGERPRINT, clientVersion: '1.0.33' });
}

/** A runner that records what tmux was asked and answers however the test wants. */
function recorder(answers: ReturnType<TmuxRunner>[]): { run: TmuxRunner; calls: string[][] } {
  const calls: string[][] = [];
  let index = 0;
  return {
    calls,
    run: (args) => {
      calls.push([...args]);
      return answers[Math.min(index++, answers.length - 1)] ?? { status: 0, stdout: '', stderr: '' };
    },
  };
}

const OK: ReturnType<TmuxRunner> = { status: 0, stdout: '', stderr: '' };

// ---------------------------------------------------------------------------
// tmux
// ---------------------------------------------------------------------------

test('tmux: no pane in the environment is a clean skip, and nothing is spawned', () => {
  const never: TmuxRunner = () => {
    assert.fail('tmux must not be spawned when this process is not in a session');
  };
  for (const env of [{}, { TMUX_PANE: '' }, { TMUX_PANE: '  ' }] as NodeJS.ProcessEnv[]) {
    const step = renameTmuxSession('manager', env, never);
    assert.equal(step.state, 'skipped');
    assert.equal(step.target, 'tmux');
    // The reason has to name the variable it read: this is the common case for a `--bg`
    // session, and "skipped" with no cause reads like a bug the agent should chase.
    assert.match(step.detail, /TMUX_PANE/);
  }
});

test('tmux: the session is resolved from TMUX_PANE, never from a pane list', () => {
  // A pane id resolves to its session, so `-t %7` is the lookup. `list-panes` would answer
  // for whatever the tmux server considers current, which is how the wrong session gets
  // renamed on a machine running several.
  const { run, calls } = recorder([{ status: 0, stdout: 'otherorg-8ad9\n', stderr: '' }, OK]);
  const step = renameTmuxSession('manager', { TMUX_PANE: '%7' }, run);

  assert.equal(step.state, 'done');
  assert.deepEqual(calls[1], ['rename-session', '-t', '%7', 'manager']);
  assert.ok(calls.every((args) => !args.includes('list-panes')), 'no pane list is consulted');
  assert.match(step.detail, /"otherorg-8ad9" → "manager"/);
});

test('tmux: the rename still happens when tmux cannot say what the session was called', () => {
  // `display-message` is for the report only. Skipping the rename because it failed would
  // drop the one thing that was asked for.
  const { run, calls } = recorder([{ status: 1, stdout: '', stderr: 'no server running\n' }, OK]);
  const step = renameTmuxSession('manager', { TMUX_PANE: '%3' }, run);
  assert.equal(step.state, 'done');
  assert.deepEqual(calls[1], ['rename-session', '-t', '%3', 'manager']);
  assert.match(step.detail, /renamed to "manager"/);
});

test('tmux: a refusal is reported as a tmux failure, with the command that fixes it', () => {
  const { run } = recorder([OK, { status: 1, stdout: '', stderr: "duplicate session: manager\nusage: rename-session\n" }]);
  const step = renameTmuxSession('manager', { TMUX_PANE: '%2' }, run);
  assert.equal(step.state, 'failed');
  assert.match(step.detail, /duplicate session: manager/);
  // One line of stderr, not tmux's usage block after it.
  assert.ok(!step.detail.includes('usage:'), step.detail);
  assert.match(step.detail, /tmux rename-session -t %2 manager/);
});

test('tmux: a missing binary is a failure, not a crash', () => {
  // Possible with TMUX_PANE set: a container that inherited the environment but not tmux.
  const { run } = recorder([{ status: null, stdout: '', stderr: '', error: new Error('spawnSync tmux ENOENT') }]);
  const step = renameTmuxSession('manager', { TMUX_PANE: '%1' }, run);
  assert.equal(step.state, 'failed');
  assert.match(step.detail, /ENOENT/);
  assert.match(step.detail, /tmux rename-session -t %1 manager/);
});

// ---------------------------------------------------------------------------
// The Claude session name
// ---------------------------------------------------------------------------

test('claude: always skipped, and the exact line to run is printed verbatim', () => {
  const step = claudeRenameStep('manager');
  assert.equal(step.state, 'skipped');
  // `/rename <new>` is user input. A CLI cannot send it and typing into the pane is
  // prohibited, so the only honest outcome is the instruction itself.
  assert.match(step.detail, /`\/rename manager`/);
  assert.match(step.detail, /user input/);
});

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

const HUB_DONE: RenameStep = { target: 'hub', state: 'done', detail: '"otherorg-8ad9" → "manager"; the old name is archived, then swept' };
const WATCH = 'node /repo/dist/cli.js hub watch --agent manager --label "$PWD"';

function report(tmux: RenameStep, from = 'manager-old'): string {
  return formatRenameReport(from, 'manager', [HUB_DONE, tmux, claudeRenameStep('manager')], WATCH);
}

test('report: hub-renamed-but-tmux-skipped does not read like total success', () => {
  const skipped = report(renameTmuxSession('manager', {}, () => OK));
  const done = report(renameTmuxSession('manager', { TMUX_PANE: '%4' }, recorder([{ status: 0, stdout: 'old\n', stderr: '' }, OK]).run));

  assert.notEqual(skipped, done);
  // Both say the hub moved, and only one says a tmux session did.
  for (const text of [skipped, done]) assert.match(text, /hub .*→ "manager"/);
  assert.match(skipped, /tmux .*TMUX_PANE/);
  assert.match(done, /tmux .*"old" → "manager"/);
  assert.ok(!done.includes('TMUX_PANE'), 'a renamed session must not also claim it was skipped');
  // Three targets, three lines, one marker each: a reader has to be able to tell which
  // landed without counting words.
  assert.equal(skipped.split('\n').filter((line) => /^(hub|tmux|claude)\s/.test(line)).length, 3);
});

test('report: a tmux failure is visible and still not a failed rename', () => {
  const failed = report(renameTmuxSession('manager', { TMUX_PANE: '%2' }, recorder([OK, { status: 1, stdout: '', stderr: 'duplicate session\n' }]).run));
  assert.match(failed, /^hub .*✅/m);
  assert.match(failed, /^tmux .*⚠️.*duplicate session/m);
});

test('report: the watch is the thing the agent still has to do, and the command is spelled out', () => {
  const text = report(renameTmuxSession('manager', {}, () => OK));
  // After the rename the old name answers a poll with a redirect (ISSUE-82a), so a watch left
  // running is already dead. Arming one is an MCP call this process cannot make.
  assert.match(text, /watch is finished/);
  assert.match(text, /"manager-old" fails with a redirect naming "manager"/);
  assert.ok(text.includes(WATCH), 'the arm command is printed as it should be run');
  assert.match(text, /hub log --agent manager/);
});

test('report: the derived-name warning is closed out only when the old name was derived', () => {
  assert.match(report(renameTmuxSession('manager', {}, () => OK), 'otherorg-8ad9'), /AGENT_HUB_AGENT=manager/);
  assert.ok(!report(renameTmuxSession('manager', {}, () => OK), 'worker-two').includes('AGENT_HUB_AGENT'));
});

// ---------------------------------------------------------------------------
// The wire (ISSUE-82a's contract)
// ---------------------------------------------------------------------------

test('hub: POST /api/agents/<old>/rename with {"to":…}, credential in the header', async () => {
  await withServer(
    (_request, response) => json(response, 200, { from: 'otherorg-8ad9', to: 'manager', renamed: true, ts: 1_700_000_000_000 }),
    async (base, calls) => {
      const result = await client(base).rename('manager');
      assert.deepEqual(result, { from: 'otherorg-8ad9', to: 'manager', renamed: true, ts: 1_700_000_000_000 });
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.method, 'POST');
      assert.equal(calls[0]?.url, '/api/agents/otherorg-8ad9/rename');
      assert.deepEqual(JSON.parse(calls[0]?.body ?? '{}'), { to: 'manager' });
      // An agent renames itself: the fingerprint is the whole authorisation, and it must
      // not be in the URL, where it would land in an access log.
      assert.equal(calls[0]?.headers[FINGERPRINT_HEADER], FINGERPRINT);
      assert.ok(!(calls[0]?.url ?? '').includes(FINGERPRINT));
    },
  );
});

test('hub: an unusable target name is refused before the request goes out', async () => {
  await withServer(
    (_request, response) => json(response, 200, { from: 'a', to: 'b', renamed: true, ts: 1 }),
    async (base, calls) => {
      for (const bad of ['Manager', 'manager_one', 'manager.one', '', 'a'.repeat(41), 'agent name']) {
        await assert.rejects(() => client(base).rename(bad), HubPermanentError, bad);
      }
      // Renaming to the name it already has is the same kind of mistake: the server would
      // have to refuse it, and refusing here costs nothing.
      await assert.rejects(() => client(base).rename('otherorg-8ad9'), /already this agent's name/);
      assert.equal(calls.length, 0, 'nothing may be asked of the hub for a name it would refuse');
    },
  );
});

test('hub: a 409 is permanent — a retry sends the same two names to the same hub', async () => {
  await withServer(
    (_request, response) => json(response, 409, { error: 'name_taken' }),
    async (base) => {
      await assert.rejects(() => client(base).rename('manager'), (error: Error) => {
        assert.ok(error instanceof HubPermanentError, `${error.name} would have been retried in a backoff loop`);
        assert.match(error.message, /409 \(name_taken\)/);
        // The contract fixes the status and the two reasons, not which one it was.
        assert.match(error.message, /already on the hub/);
        assert.match(error.message, /not this machine's own agent/);
        return true;
      });
    },
  );
});

test('hub: a body that does not say renamed:true is not believed', async () => {
  // The cost of believing it is lasting: the agent stops the watch it still owns and arms
  // one on a name the hub never accepted, which leaves it unreachable under both.
  await withServer(
    (_request, response) => json(response, 200, { from: 'otherorg-8ad9', to: 'manager', ts: 1 }),
    async (base) => {
      await assert.rejects(() => client(base).rename('manager'), (error: Error) => {
        assert.ok(error instanceof HubTransientError);
        assert.match(error.message, /"renamed" was undefined/);
        return true;
      });
    },
  );
});

test('compiled CLI: an invalid new name exits 1 and touches nothing at all', async () => {
  await withServer(
    (_request, response) => json(response, 200, { from: 'a', to: 'b', renamed: true, ts: 1 }),
    async (base, calls) => {
      const cli = resolve('dist/cli.js');
      const run = (args: string[]) => spawnSync(process.execPath, [cli, 'hub', 'rename', ...args, '--url', base], {
        // No AGENT_HUB_AGENT: the refusal has to come before the identity is resolved, so
        // this also proves the ORDER — an invalid name is refused without a name to rename.
        env: { ...process.env, AGENT_HUB_AGENT: '' },
        encoding: 'utf8',
      });

      const bad = run(['Manager']);
      assert.notEqual(bad.status, 0);
      assert.match(bad.stderr, /Invalid new name "Manager"\. Nothing was renamed\./);
      assert.equal(calls.length, 0);

      // Same command with a legal name gets further — to the missing identity, still
      // without asking the hub anything.
      const nameless = run(['manager']);
      assert.notEqual(nameless.status, 0);
      assert.match(nameless.stderr, /No agent name/);
      assert.equal(calls.length, 0);
    },
  );
});

test('compiled CLI: --agent and --as may not disagree about who is being renamed', () => {
  const cli = resolve('dist/cli.js');
  const clash = spawnSync(process.execPath, [cli, 'hub', 'rename', 'manager', '--agent', 'one', '--as', 'two'], {
    env: { ...process.env, AGENT_HUB_AGENT: '' },
    encoding: 'utf8',
  });
  assert.notEqual(clash.status, 0);
  assert.match(clash.stderr, /can only rename itself/);
});

test('hub: a rename of someone else is not accepted as this agent\'s own', async () => {
  // The caller is the subject, so the echo can only be this name. Believing a different
  // one would build the report - "stop the watch on <from>" - around the wrong session.
  await withServer(
    (_request, response) => json(response, 200, { from: 'someone-else', to: 'manager', renamed: true, ts: 1 }),
    async (base) => {
      await assert.rejects(() => client(base).rename('manager'), /renamed "otherorg-8ad9" → "manager"/);
    },
  );
});

test('rename: records the successor beside the old cursor, for the registration hook', () => {
  // The hook resolves a name from AGENT_HUB_AGENT, fixed at launch, so it cannot see a rename. Without
  // this marker it keeps naming the OLD name — and an archived name un-archives itself on its next poll,
  // so an agent obeying the hook would resurrect the entry its own rename had just archived. The path is
  // the contract between the CLI and the hook; if it moves, the hook must move with it.
  assert.equal(
    hubRenamedToPath('old-name'),
    join(hubStateDir('old-name'), 'renamed-to'),
    'the hook looks for exactly this file, beside the cursor',
  );
});

test('identity: the configured default follows a rename, an explicit name does not', () => {
  // Three symptoms came from one cause: AGENT_HUB_AGENT is fixed at launch, so every fallback to it
  // named the ARCHIVED name after a rename. The worst was `hub send`, which stamped messages with a name
  // that no longer existed on the roster — and succeeded, returning ids, telling the sender nothing.
  const dir = mkdtempSync(join(tmpdir(), 'hub-follow-'));
  try {
    mkdirSync(join(dir, 'hub', 'old-name'), { recursive: true });
    writeFileSync(join(dir, 'hub', 'old-name', 'renamed-to'), 'new-name\n');
    const prev = process.env.CLAUDE_TOOLS_CONFIG_DIR;
    process.env.CLAUDE_TOOLS_CONFIG_DIR = dir;
    try {
      assert.equal(followRenames('old-name'), 'new-name', 'a stale configured name resolves forward');
      assert.equal(followRenames('unrelated'), 'unrelated', 'a name with no marker is already current');
      // A chain, because a name renamed twice must not resolve to the middle.
      mkdirSync(join(dir, 'hub', 'new-name'), { recursive: true });
      writeFileSync(join(dir, 'hub', 'new-name', 'renamed-to'), 'final-name\n');
      assert.equal(followRenames('old-name'), 'final-name');
      // A cycle must terminate rather than hang: this hook and this CLI both run on every prompt.
      mkdirSync(join(dir, 'hub', 'final-name'), { recursive: true });
      writeFileSync(join(dir, 'hub', 'final-name', 'renamed-to'), 'old-name\n');
      const settled = followRenames('old-name');
      assert.ok(['old-name', 'new-name', 'final-name'].includes(settled), 'a cycle stops at the hop cap');
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_TOOLS_CONFIG_DIR;
      else process.env.CLAUDE_TOOLS_CONFIG_DIR = prev;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
