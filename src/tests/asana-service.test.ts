import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AsanaAmbiguousNameError,
  AsanaService,
  matchByName,
  redactAsanaToken,
} from '../services/asana.js';

/** A token-shaped string that is not a real credential. */
const TOKEN = '1/1218000000000043:abcdef0123456789abcdef0123456789';

interface FakeResponse {
  status?: number;
  body?: unknown;
  /** Raw body, for testing a non-JSON error page. */
  text?: string;
  headers?: Record<string, string>;
}

interface Recorder {
  urls: string[];
  bodies: (string | undefined)[];
  methods: string[];
}

/**
 * A fetch that serves a queue of canned responses and records what was asked
 * for. The last response repeats, so a test only queues what it cares about.
 */
function fakeFetch(responses: FakeResponse[]): { fetch: typeof fetch; calls: Recorder } {
  const calls: Recorder = { urls: [], bodies: [], methods: [] };
  let index = 0;

  const impl = async (url: string | URL, init?: RequestInit) => {
    calls.urls.push(String(url));
    calls.methods.push(init?.method || 'GET');
    calls.bodies.push(init?.body as string | undefined);

    const canned = responses[Math.min(index, responses.length - 1)];
    index++;
    const status = canned.status ?? 200;

    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: 'STATUS',
      headers: { get: (name: string) => canned.headers?.[name.toLowerCase()] ?? null },
      async text() {
        return canned.text !== undefined ? canned.text : JSON.stringify(canned.body ?? {});
      },
    } as unknown as Response;
  };

  return { fetch: impl as unknown as typeof fetch, calls };
}

function serviceWith(responses: FakeResponse[], token = TOKEN) {
  const { fetch: impl, calls } = fakeFetch(responses);
  return { service: new AsanaService({ accessToken: token }, impl), calls };
}

function queryOf(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

// --------------------------------------------------------------- redaction

test('redactAsanaToken removes the configured token verbatim', () => {
  const leaked = `request failed with Authorization: Bearer ${TOKEN}`;
  const safe = redactAsanaToken(leaked, TOKEN);

  assert.ok(!safe.includes(TOKEN), safe);
  assert.ok(!safe.includes('abcdef0123456789'), safe);
});

test('redactAsanaToken removes a token-shaped string even without the config', () => {
  const other = '2/9988776655443322:0f1e2d3c4b5a69788796a5b4c3d2e1f0';
  const safe = redactAsanaToken(`stray ${other} in a log`, undefined);

  assert.ok(!safe.includes(other), safe);
  assert.equal(safe, 'stray <redacted> in a log');
});

test('redactAsanaToken removes any Bearer value, whatever its shape', () => {
  assert.equal(redactAsanaToken('Authorization: Bearer opaque-future-format'), 'Authorization: Bearer <redacted>');
});

test('redactAsanaToken is a no-op for text with no credential', () => {
  assert.equal(redactAsanaToken('Asana could not find /tasks/123'), 'Asana could not find /tasks/123');
});

test('a 401 body that echoes the token is redacted before it is thrown', async () => {
  // The realistic leak: a proxy or error body repeating the Authorization header.
  const { service } = serviceWith([
    { status: 401, body: { errors: [{ message: `Not Authorized: Bearer ${TOKEN}` }] } },
  ]);

  await assert.rejects(service.getTask('1218000000000039'), (err: Error) => {
    assert.ok(!err.message.includes(TOKEN), err.message);
    assert.ok(err.message.includes('<redacted>'), err.message);
    assert.match(err.message, /ASANA_ACCESS_TOKEN|asana\.accessToken/);
    return true;
  });
});

test('a 402 names the premium endpoint rather than a bare status', async () => {
  const { service } = serviceWith([{ status: 402, body: { errors: [{ message: 'Payment Required' }] } }]);

  await assert.rejects(service.searchTasks('1218000000000033', { text: 'x' }), /premium|tasks\/search/i);
});

test('a non-JSON error page still produces a readable, redacted error', async () => {
  const { service } = serviceWith([{ status: 400, text: `<html>bad gateway ${TOKEN}</html>` }]);

  await assert.rejects(service.getTask('1'), (err: Error) => {
    assert.ok(!err.message.includes(TOKEN), err.message);
    assert.match(err.message, /Asana API error 400/);
    return true;
  });
});

// --------------------------------------------------------------- opt_fields

test('every task read names the fields it renders', async () => {
  const { service, calls } = serviceWith([{ body: { data: { gid: '1218000000000039', name: 'x' } } }]);

  await service.getTask('1218000000000039');

  const fields = queryOf(calls.urls[0]).get('opt_fields') || '';
  // The default compact task carries none of these, which is the trap.
  for (const field of ['name', 'completed', 'due_on', 'assignee.name', 'permalink_url', 'html_notes']) {
    assert.ok(fields.split(',').includes(field), `missing ${field} in ${fields}`);
  }
});

test('a task list asks for the columns it prints, and scopes by assignee and workspace', async () => {
  const { service, calls } = serviceWith([{ body: { data: [] } }]);

  await service.listTasks({ workspace: '1218000000000033', assignee: 'me' });

  const query = queryOf(calls.urls[0]);
  assert.equal(query.get('assignee'), 'me');
  assert.equal(query.get('workspace'), '1218000000000033');
  assert.equal(query.get('completed_since'), 'now');
  assert.deepEqual((query.get('opt_fields') || '').split(','), [
    'name',
    'completed',
    'due_on',
    'assignee.name',
    'permalink_url',
  ]);
});

test('a write also asks for the fields it prints back', async () => {
  const { service, calls } = serviceWith([{ body: { data: { gid: '1', name: 'new' } } }]);

  await service.createTask({ name: 'new', workspace: '1218000000000033' });

  assert.equal(calls.methods[0], 'POST');
  assert.ok((queryOf(calls.urls[0]).get('opt_fields') || '').includes('permalink_url'));
});

// -------------------------------------------------------------- pagination

test('offset pagination follows the token Asana hands back and never invents one', async () => {
  const { service, calls } = serviceWith([
    { body: { data: [{ gid: '1', name: 'a' }], next_page: { offset: 'opaque-offset-1' } } },
    { body: { data: [{ gid: '2', name: 'b' }], next_page: { offset: 'opaque-offset-2' } } },
    { body: { data: [{ gid: '3', name: 'c' }], next_page: null } },
  ]);

  const projects = await service.listProjects('1218000000000033');

  assert.deepEqual(projects.map((p) => p.gid), ['1', '2', '3']);
  assert.equal(calls.urls.length, 3);
  assert.equal(queryOf(calls.urls[0]).get('offset'), null);
  assert.equal(queryOf(calls.urls[1]).get('offset'), 'opaque-offset-1');
  assert.equal(queryOf(calls.urls[2]).get('offset'), 'opaque-offset-2');
  assert.equal(queryOf(calls.urls[0]).get('limit'), '100');
});

test('a limit stops paging early and counts only tasks that are shown', async () => {
  const page = Array.from({ length: 100 }, (_v, i) => ({ gid: String(i + 1), name: `t${i}`, completed: i % 2 === 0 }));
  const { service, calls } = serviceWith([{ body: { data: page, next_page: { offset: 'next' } } }]);

  const tasks = await service.listTasks({ workspace: 'w', assignee: 'me', limit: 3 });

  assert.equal(tasks.length, 3);
  // Completed tasks are filtered out client-side, so the limit still yields 3
  // *incomplete* tasks rather than 3 rows of which some are hidden.
  assert.ok(tasks.every((t) => !t.completed));
  assert.equal(calls.urls.length, 1);
});

test('archived projects are hidden unless asked for', async () => {
  const body = {
    body: {
      data: [
        { gid: '1', name: 'Live', archived: false },
        { gid: '2', name: 'Old', archived: true },
      ],
      next_page: null,
    },
  };

  const hidden = serviceWith([body]);
  assert.deepEqual((await hidden.service.listProjects('w')).map((p) => p.name), ['Live']);

  const shown = serviceWith([body]);
  assert.deepEqual(
    (await shown.service.listProjects('w', { includeArchived: true })).map((p) => p.name),
    ['Live', 'Old'],
  );
});

test('a due-before filter drops undated tasks and tasks due later', async () => {
  const { service } = serviceWith([
    {
      body: {
        data: [
          { gid: '1', name: 'early', due_on: '2026-09-01', completed: false },
          { gid: '2', name: 'late', due_on: '2026-12-01', completed: false },
          { gid: '3', name: 'undated', completed: false },
        ],
        next_page: null,
      },
    },
  ]);

  const tasks = await service.listTasks({ workspace: 'w', assignee: 'me', dueBefore: '2026-10-01' });
  assert.deepEqual(tasks.map((t) => t.name), ['early']);
});

test('a runaway paginator is bounded rather than looping forever', async () => {
  // Always returns a fresh offset, which is exactly how an endpoint with a bug
  // (or a synthesised offset) would behave.
  const { service, calls } = serviceWith([{ body: { data: [{ gid: '1', name: 'x' }], next_page: { offset: 'more' } } }]);

  await assert.rejects(service.listProjects('w'), /MAX_PAGES=100/);
  assert.equal(calls.urls.length, 100);
});

test('tasks/search pages with a created_at cursor because it has no offset', async () => {
  const createdAt = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
  const first = Array.from({ length: 100 }, (_v, i) => ({
    gid: String(1000 + i),
    name: `t${i}`,
    completed: false,
    created_at: createdAt(i),
  }));
  const second = [{ gid: '2000', name: 'last', completed: false, created_at: '2026-02-01T00:00:00.000Z' }];

  const { service, calls } = serviceWith([{ body: { data: first } }, { body: { data: second } }]);

  const tasks = await service.searchTasks('1218000000000033', { text: 'thing', limit: 200 });

  assert.equal(tasks.length, 101);
  assert.equal(calls.urls.length, 2);

  const firstQuery = queryOf(calls.urls[0]);
  assert.equal(firstQuery.get('text'), 'thing');
  assert.equal(firstQuery.get('sort_by'), 'created_at');
  assert.equal(firstQuery.get('sort_ascending'), 'true');
  // The offset parameter does not exist on this endpoint; sending one is an error.
  assert.equal(firstQuery.get('offset'), null);
  assert.equal(firstQuery.get('created_at.after'), null);

  const secondQuery = queryOf(calls.urls[1]);
  // The cursor is the last timestamp strictly BELOW the final row's, so a group
  // of tasks sharing that instant is re-fetched rather than skipped.
  assert.equal(secondQuery.get('created_at.after'), createdAt(98));
  assert.equal(secondQuery.get('offset'), null);
});

test('a search page that repeats what was already seen stops the walk', async () => {
  // Whatever the cursor does, a full page that adds nothing must end the walk -
  // otherwise a boundary the cursor cannot cross becomes an endless loop.
  const page = Array.from({ length: 100 }, (_v, i) => ({
    gid: String(i),
    name: `t${i}`,
    created_at: '2026-01-01T00:00:00.000Z',
  }));
  const { service, calls } = serviceWith([{ body: { data: page } }]);

  const tasks = await service.searchTasks('w', { text: 'x', limit: 500 });

  assert.equal(tasks.length, 100);
  assert.equal(calls.urls.length, 2, 'one extra request proves the cursor, then it stops');
});

test('a short search page is the last page', async () => {
  const { service, calls } = serviceWith([{ body: { data: [{ gid: '1', name: 'only' }] } }]);

  const tasks = await service.searchTasks('w', { text: 'x', limit: 50 });

  assert.equal(tasks.length, 1);
  assert.equal(calls.urls.length, 1);
});

test('search passes the completed filter only when asked', async () => {
  const off = serviceWith([{ body: { data: [] } }]);
  await off.service.searchTasks('w', { text: 'x' });
  assert.equal(queryOf(off.calls.urls[0]).get('completed'), null);

  const on = serviceWith([{ body: { data: [] } }]);
  await on.service.searchTasks('w', { text: 'x', completed: false });
  assert.equal(queryOf(on.calls.urls[0]).get('completed'), 'false');
});

// ----------------------------------------------------------- rate limiting

test('a 429 is waited out with the Retry-After delay, then retried', async () => {
  const { service, calls } = serviceWith([
    { status: 429, headers: { 'retry-after': '1' }, body: { errors: [{ message: 'Too Many Requests' }] } },
    { body: { data: { gid: '1218000000000039', name: 'after the wait' } } },
  ]);

  const started = Date.now();
  const task = await service.getTask('1218000000000039');
  const waited = Date.now() - started;

  assert.equal(task.name, 'after the wait');
  assert.equal(calls.urls.length, 2);
  assert.ok(waited >= 900, `expected to honour Retry-After, waited ${waited}ms`);
});

test('a retry budget that runs out surfaces the error instead of hammering', async () => {
  const { service, calls } = serviceWith([
    { status: 429, headers: { 'retry-after': '3600' }, body: { errors: [{ message: 'Rate limit' }] } },
  ]);

  // An hour-long Retry-After is a wall, not a hiccup: report it, do not sleep.
  await assert.rejects(service.getTask('1'), /429|Rate limit/);
  assert.equal(calls.urls.length, 1);
});

// ------------------------------------------------------------- name lookup

test('matchByName prefers an exact match over a longer name that starts with it', () => {
  const candidates = [
    { gid: '1', name: 'Personal Finance' },
    { gid: '2', name: 'Personal' },
  ];
  assert.equal(matchByName(candidates, 'Personal', 'project').gid, '2');
  assert.equal(matchByName(candidates, 'personal', 'project').gid, '2');
});

test('matchByName falls back from prefix to substring', () => {
  const candidates = [{ gid: '1', name: 'Uzbek Voice Agents' }];
  assert.equal(matchByName(candidates, 'Uzbek', 'project').gid, '1');
  assert.equal(matchByName(candidates, 'Voice', 'project').gid, '1');
});

test('matchByName refuses to guess between equal candidates', () => {
  const candidates = [
    { gid: '1218000000000045', name: 'Acme Core' },
    { gid: '1218000000000047', name: 'Acme Portal' },
  ];

  assert.throws(
    () => matchByName(candidates, 'Acme', 'project'),
    (err: unknown) => {
      assert.ok(err instanceof AsanaAmbiguousNameError);
      assert.equal(err.kind, 'project');
      assert.equal(err.query, 'Acme');
      assert.deepEqual(err.candidates.map((c) => c.gid), ['1218000000000045', '1218000000000047']);
      // The gids must be in the message, since they are the way out.
      assert.match(err.message, /1218000000000045/);
      assert.match(err.message, /1218000000000047/);
      return true;
    },
  );
});

test('matchByName reports what does exist when nothing matches', () => {
  assert.throws(
    () => matchByName([{ gid: '1', name: 'Personal' }], 'Nope', 'project'),
    /No project matches "Nope".*Known projects: Personal/,
  );
});

test('a gid argument resolves without a network call', async () => {
  const { service, calls } = serviceWith([{ body: { data: [] } }]);

  assert.equal(await service.resolveProject('w', '1218000000000035'), '1218000000000035');
  assert.equal(await service.resolveTask('w', ' 1218000000000039 '), '1218000000000039');
  assert.equal(await service.resolveSection('p', '1218000000000049'), '1218000000000049');
  assert.equal(calls.urls.length, 0);
});

test('a name resolves through typeahead', async () => {
  const { service, calls } = serviceWith([
    { body: { data: [{ gid: '1218000000000035', name: 'Personal' }] } },
  ]);

  assert.equal(await service.resolveProject('1218000000000033', 'Personal'), '1218000000000035');

  const query = queryOf(calls.urls[0]);
  assert.ok(calls.urls[0].includes('/workspaces/1218000000000033/typeahead'));
  assert.equal(query.get('resource_type'), 'project');
  assert.equal(query.get('query'), 'Personal');
});

test('an ambiguous name surfaces every candidate with its gid', async () => {
  const { service } = serviceWith([
    {
      body: {
        data: [
          { gid: '1218000000000045', name: 'Acme Core' },
          { gid: '1218000000000047', name: 'Acme Portal' },
        ],
      },
    },
  ]);

  await assert.rejects(service.resolveProject('w', 'Acme'), (err: unknown) => {
    assert.ok(err instanceof AsanaAmbiguousNameError);
    assert.equal(err.candidates.length, 2);
    return true;
  });
});

test('a project typeahead miss falls back to the full project list', async () => {
  const { service, calls } = serviceWith([
    { body: { data: [] } },
    { body: { data: [{ gid: '1218000000000035', name: 'Personal' }], next_page: null } },
  ]);

  assert.equal(await service.resolveProject('w', 'Personal'), '1218000000000035');
  assert.equal(calls.urls.length, 2);
  assert.ok(calls.urls[1].includes('/workspaces/w/projects'));
});

test('a section name resolves from the project it belongs to', async () => {
  const { service, calls } = serviceWith([
    { body: { data: [{ gid: '111111111111', name: 'In progress' }, { gid: '222222222222', name: 'Done' }], next_page: null } },
  ]);

  assert.equal(await service.resolveSection('1218000000000035', 'Done'), '222222222222');
  assert.ok(calls.urls[0].includes('/projects/1218000000000035/sections'));
});

test('me, an email and a gid assignee need no lookup', async () => {
  const { service, calls } = serviceWith([{ body: { data: [] } }]);

  assert.equal(await service.resolveUser('w', 'me'), 'me');
  assert.equal(await service.resolveUser('w', 'ME'), 'ME');
  assert.equal(await service.resolveUser('w', 'someone@example.com'), 'someone@example.com');
  assert.equal(await service.resolveUser('w', '1218000000000043'), '1218000000000043');
  assert.equal(calls.urls.length, 0);
});

test('a display name resolves to a user gid', async () => {
  const { service, calls } = serviceWith([{ body: { data: [{ gid: '1218000000000043', name: 'Dovron Sherbaev' }] } }]);

  assert.equal(await service.resolveUser('w', 'Dovron'), '1218000000000043');
  assert.equal(queryOf(calls.urls[0]).get('resource_type'), 'user');
});

// ---------------------------------------------------------- workspace default

test('a single-workspace account needs no --workspace', async () => {
  const { service } = serviceWith([
    { body: { data: { gid: '1', name: 'Dovron', workspaces: [{ gid: '1218000000000033', name: 'My workspace' }] } } },
  ]);

  assert.equal(await service.resolveDefaultWorkspace(), '1218000000000033');
});

test('several workspaces and no default is an error that lists them', async () => {
  const { service } = serviceWith([
    {
      body: {
        data: {
          gid: '1',
          name: 'Dovron',
          workspaces: [
            { gid: '1218000000000033', name: 'My workspace' },
            { gid: '1218000000000051', name: 'Client org' },
          ],
        },
      },
    },
  ]);

  await assert.rejects(service.resolveDefaultWorkspace(), /My workspace.*Client org|--workspace/s);
});

test('a configured default workspace is used without a lookup', async () => {
  const { fetch: impl, calls } = fakeFetch([{ body: { data: {} } }]);
  const service = new AsanaService({ accessToken: TOKEN, defaultWorkspace: '1218000000000033' }, impl);

  assert.equal(await service.resolveDefaultWorkspace(), '1218000000000033');
  assert.equal(calls.urls.length, 0);
});

// ------------------------------------------------------------------- writes

test('notes are sent as html_notes, converted from markdown', async () => {
  const { service, calls } = serviceWith([{ body: { data: { gid: '1', name: 'x' } } }]);

  await service.createTask({ name: 'x', workspace: 'w', notes: '# Title\n\n- **bold** item' });

  const body = JSON.parse(calls.bodies[0] as string);
  assert.equal(body.data.html_notes, '<body><h1>Title</h1>\n<ul><li><strong>bold</strong> item</li></ul></body>');
  assert.equal(body.data.notes, undefined);
});

test('a comment converts headings to bold, because stories reject them', async () => {
  const { service, calls } = serviceWith([{ body: { data: { gid: '9', created_at: 'now' } } }]);

  await service.addComment('1218000000000039', '# Heads up\n\ndeployed');

  const body = JSON.parse(calls.bodies[0] as string);
  assert.equal(body.data.html_text, '<body><strong>Heads up</strong>\n\ndeployed</body>');
  assert.ok(!body.data.html_text.includes('<h1>'));
});

test('completion is a boolean update, not a transition', async () => {
  const { service, calls } = serviceWith([{ body: { data: { gid: '1', name: 'x', completed: true } } }]);

  await service.setCompleted('1218000000000039', true);

  assert.equal(calls.methods[0], 'PUT');
  assert.deepEqual(JSON.parse(calls.bodies[0] as string), { data: { completed: true } });
});

test('clearing a due date sends null, and an empty update is refused', async () => {
  const { service, calls } = serviceWith([{ body: { data: { gid: '1', name: 'x' } } }]);

  await service.updateTask('1', { dueOn: null });
  assert.deepEqual(JSON.parse(calls.bodies[0] as string), { data: { due_on: null } });

  await assert.rejects(service.updateTask('1', {}), /No fields to update/);
});

test('creating with a project does not also send a workspace', async () => {
  const { service, calls } = serviceWith([{ body: { data: { gid: '1', name: 'x' } } }]);

  await service.createTask({ name: 'x', workspace: 'w', projects: ['1218000000000035'] });

  const body = JSON.parse(calls.bodies[0] as string);
  assert.deepEqual(body.data.projects, ['1218000000000035']);
  assert.equal(body.data.workspace, undefined);
});

test('a subtask is anchored on its parent alone', async () => {
  const { service, calls } = serviceWith([{ body: { data: { gid: '1', name: 'x' } } }]);

  await service.createTask({ name: 'x', workspace: 'w', parent: '1218000000000039' });

  const body = JSON.parse(calls.bodies[0] as string);
  assert.equal(body.data.parent, '1218000000000039');
  assert.equal(body.data.workspace, undefined);
});

test('a task with no anchor at all is rejected before the request', async () => {
  const { service, calls } = serviceWith([{ body: { data: {} } }]);

  await assert.rejects(service.createTask({ name: 'x' }), /workspace, project or parent/);
  assert.equal(calls.urls.length, 0);
});

test('moving to a section uses addTask, and adding to a project uses addProject', async () => {
  const move = serviceWith([{ body: { data: {} } }]);
  await move.service.moveToSection('222222222222', '1218000000000039');
  assert.ok(move.calls.urls[0].endsWith('/sections/222222222222/addTask'));
  assert.deepEqual(JSON.parse(move.calls.bodies[0] as string), { data: { task: '1218000000000039' } });

  const add = serviceWith([{ body: { data: {} } }]);
  await add.service.addToProject('1218000000000039', '1218000000000035', '222222222222');
  assert.ok(add.calls.urls[0].endsWith('/tasks/1218000000000039/addProject'));
  assert.deepEqual(JSON.parse(add.calls.bodies[0] as string), {
    data: { project: '1218000000000035', section: '222222222222', insert_before: null },
  });
});

test('removing a project membership posts removeProject with just the project', async () => {
  const { service, calls } = serviceWith([{ body: { data: {} } }]);

  await service.removeFromProject('1218000000000039', '1218000000000035');

  assert.equal(calls.methods[0], 'POST');
  assert.ok(calls.urls[0].endsWith('/tasks/1218000000000039/removeProject'));
  assert.deepEqual(JSON.parse(calls.bodies[0] as string), { data: { project: '1218000000000035' } });
});

test('creating a section posts the name under the project and returns the new gid', async () => {
  const { service, calls } = serviceWith([
    { body: { data: { gid: '333333333333', name: 'Now' } } },
  ]);

  const created = await service.createSection('1218000000000035', 'Now');

  assert.equal(calls.methods[0], 'POST');
  assert.ok(calls.urls[0].includes('/projects/1218000000000035/sections'));
  assert.deepEqual(JSON.parse(calls.bodies[0] as string), { data: { name: 'Now' } });
  assert.deepEqual(created, { gid: '333333333333', name: 'Now' });
});

test('deleting a section is a DELETE on the section itself, with no body', async () => {
  const { service, calls } = serviceWith([{ body: { data: {} } }]);

  await service.deleteSection('333333333333');

  assert.equal(calls.methods[0], 'DELETE');
  assert.ok(calls.urls[0].endsWith('/sections/333333333333'));
  assert.equal(calls.bodies[0], undefined);
});

// ------------------------------------------------------------------ stories

test('the stories feed is filtered to comments', async () => {
  const { service } = serviceWith([
    {
      body: {
        data: [
          { gid: '1', resource_subtype: 'assigned', text: 'assigned to Dovron', created_at: 'a' },
          { gid: '2', resource_subtype: 'comment_added', text: 'looks good', created_by: { name: 'Dovron' }, created_at: 'b' },
          { gid: '3', resource_subtype: 'added_to_project', text: 'added to Personal', created_at: 'c' },
        ],
        next_page: null,
      },
    },
  ]);

  const comments = await service.listComments('1218000000000039');

  assert.equal(comments.length, 1);
  assert.equal(comments[0].text, 'looks good');
  assert.equal(comments[0].createdBy, 'Dovron');
});

test('a comment with rich text is rendered back to markdown', async () => {
  const { service } = serviceWith([
    {
      body: {
        data: [
          {
            gid: '2',
            resource_subtype: 'comment_added',
            html_text: '<body><strong>done</strong> - see <a href="https://example.com">this</a></body>',
            created_at: 'b',
          },
        ],
        next_page: null,
      },
    },
  ]);

  const comments = await service.listComments('1');
  assert.equal(comments[0].text, '**done** - see [this](https://example.com)');
});

// -------------------------------------------------------------------- shape

test('a task with only the compact default fields does not crash the mapper', async () => {
  // Exactly what Asana returns with no opt_fields: the trap this guards.
  const { service } = serviceWith([
    { body: { data: { gid: '1218000000000039', resource_type: 'task', name: 'Bare', resource_subtype: 'default_task' } } },
  ]);

  const task = await service.getTask('1218000000000039');

  assert.equal(task.name, 'Bare');
  assert.equal(task.completed, false);
  assert.equal(task.dueOn, undefined);
  assert.equal(task.assignee, undefined);
  assert.deepEqual(task.projects, []);
  assert.deepEqual(task.tags, []);
  assert.deepEqual(task.customFields, []);
});

test('my-tasks ordering puts open work first, then earliest due date', async () => {
  const { service } = serviceWith([
    {
      body: {
        data: [
          { gid: '1', name: 'later', due_on: '2026-12-01', completed: false },
          { gid: '2', name: 'undated', completed: false },
          { gid: '3', name: 'sooner', due_on: '2026-09-01', completed: false },
          { gid: '4', name: 'closed', due_on: '2026-01-01', completed: true },
        ],
        next_page: null,
      },
    },
  ]);

  const tasks = await service.listTasks({ workspace: 'w', assignee: 'me', includeCompleted: true });
  assert.deepEqual(tasks.map((t) => t.name), ['sooner', 'later', 'undated', 'closed']);
});

test('a project listing keeps Asana board order', async () => {
  const { service, calls } = serviceWith([
    {
      body: {
        data: [
          { gid: '1', name: 'third by date', due_on: '2026-12-01', completed: false },
          { gid: '2', name: 'first by date', due_on: '2026-01-01', completed: false },
        ],
        next_page: null,
      },
    },
  ]);

  const tasks = await service.listTasks({ workspace: 'w', project: '1218000000000035' });

  assert.deepEqual(tasks.map((t) => t.name), ['third by date', 'first by date']);
  assert.ok(calls.urls[0].includes('/projects/1218000000000035/tasks'));
});

// --------------------------------------------------------------------------
// Regressions from the Codex audit of 2026-09-25.
// --------------------------------------------------------------------------

/** Like `serviceWith`, but also captures the warnings the service emits. */
function serviceWithWarnings(responses: FakeResponse[]) {
  const { fetch: impl, calls } = fakeFetch(responses);
  const warnings: string[] = [];
  return {
    service: new AsanaService({ accessToken: TOKEN }, impl, (message) => warnings.push(message)),
    calls,
    warnings,
  };
}

test('a 5xx does NOT retry a task creation, because Asana may have committed it', async () => {
  // POST /tasks has no idempotency key: retrying a 502 can create the task
  // again, so one command would produce up to four tasks.
  const { service, calls } = serviceWith([
    { status: 502, body: { errors: [{ message: 'Bad Gateway' }] } },
    { body: { data: { gid: '1', name: 'would be a duplicate' } } },
  ]);

  await assert.rejects(service.createTask({ name: 'x', workspace: 'w' }), /502|Bad Gateway/);
  assert.equal(calls.urls.length, 1, 'the write must not be repeated');
});

test('a 5xx does not retry a comment either', async () => {
  const { service, calls } = serviceWith([{ status: 503, body: { errors: [{ message: 'Unavailable' }] } }]);

  await assert.rejects(service.addComment('1', 'hello'), /503|Unavailable/);
  assert.equal(calls.urls.length, 1);
});

test('a 5xx is still retried for a read, which is idempotent', async () => {
  const { service, calls } = serviceWith([
    { status: 500, headers: { 'retry-after': '1' }, body: { errors: [{ message: 'oops' }] } },
    { body: { data: { gid: '1', name: 'recovered' } } },
  ]);

  const task = await service.getTask('1');
  assert.equal(task.name, 'recovered');
  assert.equal(calls.urls.length, 2);
});

test('a 429 IS retried for a write: the request was rejected, not committed', async () => {
  const { service, calls } = serviceWith([
    { status: 429, headers: { 'retry-after': '1' }, body: { errors: [{ message: 'Rate limit' }] } },
    { body: { data: { gid: '1', name: 'created once' } } },
  ]);

  const task = await service.createTask({ name: 'x', workspace: 'w' });
  assert.equal(task.name, 'created once');
  assert.equal(calls.urls.length, 2);
});

test('a saturated typeahead says so, because it cannot prove uniqueness', async () => {
  // matchByName only sees the returned window; a second same-named resource
  // outside it would look unambiguous.
  const saturated = Array.from({ length: 100 }, (_v, i) => ({ gid: String(1000 + i), name: `Task ${i}` }));
  const { service, warnings } = serviceWithWarnings([{ body: { data: saturated } }]);

  await service.typeahead('w', 'task', 'Task');

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /pass a gid/i);
});

test('an unsaturated typeahead warns about nothing', async () => {
  const { service, warnings } = serviceWithWarnings([{ body: { data: [{ gid: '1', name: 'Personal' }] } }]);

  assert.equal(await service.resolveProject('w', 'Personal'), '1');
  assert.deepEqual(warnings, []);
});

test('a stalled search cursor is reported, not passed off as the full result', async () => {
  const page = Array.from({ length: 100 }, (_v, i) => ({
    gid: String(i),
    name: `t${i}`,
    created_at: '2026-01-01T00:00:00.000Z',
  }));
  const { service, warnings } = serviceWithWarnings([{ body: { data: page } }]);

  const tasks = await service.searchTasks('w', { text: 'x', limit: 500 });

  assert.equal(tasks.length, 100);
  // Two notices: the whole page shares one timestamp, and then the next page
  // brought nothing new. The caller must not read this as a complete answer.
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /share the creation timestamp/);
  assert.match(warnings[1], /nothing new, so this result set may be incomplete/);
});

test('a search that exhausts the page budget throws instead of looking complete', async () => {
  // Every page is full and every cursor advances, so the walk never ends on its
  // own. Returning 10,000 rows quietly would read as the whole answer.
  let tick = 0;
  const { service } = serviceWithWarnings([]);
  const impl = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: () => null },
    async text() {
      const data = Array.from({ length: 100 }, (_v, i) => ({
        gid: `${tick}-${i}`,
        name: 'x',
        created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, tick * 100 + i)).toISOString(),
      }));
      tick++;
      return JSON.stringify({ data });
    },
  }) as unknown as Response;

  const bounded = new AsanaService({ accessToken: TOKEN }, impl as unknown as typeof fetch);
  await assert.rejects(bounded.searchTasks('w', { text: 'x', limit: 20000 }), /MAX_PAGES=100/);
  assert.ok(service);
});

test('every offset page goes through the same retry-aware request path', async () => {
  // paginate() used to carry its own copy of the retry loop; a behavioural
  // difference between the two was invisible.
  const { service, calls } = serviceWith([
    { status: 500, headers: { 'retry-after': '1' }, body: { errors: [{ message: 'transient' }] } },
    { body: { data: [{ gid: '1', name: 'Live' }], next_page: null } },
  ]);

  const projects = await service.listProjects('w');
  assert.deepEqual(projects.map((p) => p.name), ['Live']);
  assert.equal(calls.urls.length, 2);
});

test('empty notes clear the field rather than being ignored', async () => {
  const { service, calls } = serviceWith([{ body: { data: { gid: '1', name: 'x' } } }]);

  await service.updateTask('1', { notes: '' });

  assert.deepEqual(JSON.parse(calls.bodies[0] as string), { data: { html_notes: '<body></body>' } });
});

// ---- Round 2 of the Codex audit -------------------------------------------

test('a saturated task lookup is refused for a write and only warned for a read', async () => {
  const saturated = Array.from({ length: 100 }, (_v, i) => ({ gid: String(1000 + i), name: i === 0 ? 'Ship it' : `Ship it ${i}` }));

  // A read may proceed: the wrong row on screen is a nuisance, not damage.
  const read = serviceWithWarnings([{ body: { data: saturated } }]);
  assert.equal(await read.service.resolveTask('w', 'Ship it'), '1000');
  assert.equal(read.warnings.length, 1);

  // A write must not: it would mutate the wrong task and report success.
  const write = serviceWithWarnings([{ body: { data: saturated } }]);
  await assert.rejects(
    write.service.resolveTask('w', 'Ship it', { forWrite: true }),
    /Refusing to change a task chosen from an incomplete list/,
  );
});

test('a saturated assignee lookup is refused for a write', async () => {
  const saturated = Array.from({ length: 100 }, (_v, i) => ({ gid: String(i), name: i === 0 ? 'Dovron' : `Dovron ${i}` }));
  const { service } = serviceWithWarnings([{ body: { data: saturated } }]);

  await assert.rejects(service.resolveUser('w', 'Dovron', { forWrite: true }), /Refusing to change a user/);
});

test('an unsaturated write lookup proceeds silently', async () => {
  const { service, warnings } = serviceWithWarnings([{ body: { data: [{ gid: '1218000000000039', name: 'Ship it' }] } }]);

  assert.equal(await service.resolveTask('w', 'Ship it', { forWrite: true }), '1218000000000039');
  assert.deepEqual(warnings, []);
});

test('a saturated project lookup is answered from the full listing, not refused', async () => {
  // Projects can be enumerated, so certainty is available without a gid.
  const saturated = Array.from({ length: 100 }, (_v, i) => ({ gid: String(i), name: `Project ${i}` }));
  const { service, calls } = serviceWithWarnings([
    { body: { data: saturated } },
    { body: { data: [{ gid: '1218000000000035', name: 'Personal' }], next_page: null } },
  ]);

  assert.equal(await service.resolveProject('w', 'Personal'), '1218000000000035');
  assert.equal(calls.urls.length, 2);
  assert.ok(calls.urls[1].includes('/projects'));
});

test('the search cursor steps back so a tie group at a page boundary is not skipped', async () => {
  // 99 distinct timestamps, then A and B sharing T. An exclusive after=T would
  // drop every other task created at T.
  const at = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
  const tie = at(500);
  const first = [
    ...Array.from({ length: 99 }, (_v, i) => ({ gid: `a${i}`, name: `t${i}`, created_at: at(i) })),
    { gid: 'A', name: 'tie A', created_at: tie },
  ];
  const second = [
    { gid: 'A', name: 'tie A', created_at: tie },
    { gid: 'B', name: 'tie B', created_at: tie },
  ];

  const { service, calls, warnings } = serviceWithWarnings([{ body: { data: first } }, { body: { data: second } }]);
  const tasks = await service.searchTasks('w', { text: 'x', limit: 500 });

  // The cursor is the last timestamp BELOW the tie, not the tie itself.
  assert.equal(queryOf(calls.urls[1]).get('created_at.after'), at(98));
  // B is found, and the repeated A is deduplicated rather than listed twice.
  assert.equal(tasks.filter((t) => t.name === 'tie A').length, 1);
  assert.equal(tasks.filter((t) => t.name === 'tie B').length, 1);
  assert.equal(tasks.length, 101);
  assert.deepEqual(warnings, []);
});

test('a tie group larger than a page is reported, not silently dropped', async () => {
  const tie = '2026-01-01T00:00:00.000Z';
  const page = Array.from({ length: 100 }, (_v, i) => ({ gid: `g${i}`, name: `t${i}`, created_at: tie }));
  const { service, calls, warnings } = serviceWithWarnings([
    { body: { data: page } },
    { body: { data: [{ gid: 'later', name: 'after the group', created_at: '2026-02-01T00:00:00.000Z' }] } },
  ]);

  const tasks = await service.searchTasks('w', { text: 'x', limit: 500 });

  // It advances past the group rather than stalling on it, and says what that costs.
  assert.equal(queryOf(calls.urls[1]).get('created_at.after'), tie);
  assert.equal(tasks.length, 101);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /share the creation timestamp/);
});
