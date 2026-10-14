import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AsanaService,
  PROJECT_COLORS,
  PROJECT_COLOR_ALIASES,
  normalizeProjectColor,
} from '../services/asana.js';

/**
 * The project surface: create, update, archive and read.
 *
 * The expectations here are not guesses about the API - every one of them was
 * probed against the live workspace first, and the surprises are called out
 * where they are pinned: a project's `html_notes` rejects `<p>`, `<br>` and
 * `<div>` although a task's accepts them, and the colour enum has a
 * `light-yellow` with no dark twin.
 */

const TOKEN = '1/1218000000000043:abcdef0123456789abcdef0123456789';
const WORKSPACE = '1218000000000033';
const PROJECT = '1218000000000037';

interface FakeResponse {
  status?: number;
  body?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

interface Recorder {
  urls: string[];
  bodies: (string | undefined)[];
  methods: string[];
}

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

function sentData(body: string | undefined): Record<string, unknown> {
  return (JSON.parse(body || '{}') as { data?: Record<string, unknown> }).data || {};
}

// -------------------------------------------------------------------- reads

test('a project read names every field it renders', async () => {
  const { service, calls } = serviceWith([{ body: { data: { gid: PROJECT, name: 'Warehouse rollout' } } }]);

  await service.getProject(PROJECT);

  const fields = (queryOf(calls.urls[0]).get('opt_fields') || '').split(',');
  // The description is the point of the command; the rest is what `show` prints.
  for (const field of ['notes', 'html_notes', 'color', 'public', 'archived', 'owner.name', 'workspace.name']) {
    assert.ok(fields.includes(field), `opt_fields is missing ${field}: ${fields.join(',')}`);
  }
});

test('a project listing stays narrow even though it shares the detail mapper', async () => {
  const { service, calls } = serviceWith([{ body: { data: [{ gid: PROJECT, name: 'Warehouse rollout' }] } }]);

  await service.listProjects(WORKSPACE);

  // The listing prints gids and names. Asking it for every project's full
  // description would make `asana projects` pay for text nobody sees.
  const fields = (queryOf(calls.urls[0]).get('opt_fields') || '').split(',');
  assert.deepEqual(fields, ['name', 'archived', 'permalink_url']);
});

test('a project description is rendered back to markdown for display', async () => {
  const { service } = serviceWith([
    {
      body: {
        data: {
          gid: PROJECT,
          name: 'Warehouse rollout',
          html_notes:
            '<body><h1>Charter</h1>\nShip the <strong>pilot</strong> site.<ul><li>one</li></ul></body>',
        },
      },
    },
  ]);

  const detail = await service.getProject(PROJECT);

  assert.match(detail.notesMarkdown || '', /# Charter/);
  assert.match(detail.notesMarkdown || '', /\*\*pilot\*\*/);
  assert.match(detail.notesMarkdown || '', /- one/);
});

test('a plain-text description survives when Asana returns no html_notes', async () => {
  const { service } = serviceWith([{ body: { data: { gid: PROJECT, notes: 'Plain text only.' } } }]);

  const detail = await service.getProject(PROJECT);

  assert.equal(detail.notesMarkdown, 'Plain text only.');
});

test('a project with only the compact default fields does not crash the mapper', async () => {
  const { service } = serviceWith([{ body: { data: { gid: PROJECT, resource_type: 'project' } } }]);

  const detail = await service.getProject(PROJECT);

  assert.equal(detail.gid, PROJECT);
  assert.equal(detail.name, '');
  assert.equal(detail.notesMarkdown, undefined);
  assert.equal(detail.color, undefined);
  assert.equal(detail.workspace, undefined);
});

test('both of Asana\'s ways of saying "no colour" map to the same thing', async () => {
  // A freshly created project reports `null`; one whose colour was cleared
  // reports the string "none". Both were seen on the live API.
  const fresh = serviceWith([{ body: { data: { gid: PROJECT, color: null } } }]);
  assert.equal((await fresh.service.getProject(PROJECT)).color, undefined);

  const cleared = serviceWith([{ body: { data: { gid: PROJECT, color: 'none' } } }]);
  assert.equal((await cleared.service.getProject(PROJECT)).color, 'none');
});

test('a project status update is folded into one readable line', async () => {
  const { service } = serviceWith([
    { body: { data: { gid: PROJECT, current_status: { title: 'On track', text: 'Pilot next week' } } } },
  ]);

  assert.equal((await service.getProject(PROJECT)).currentStatus, 'On track - Pilot next week');
});

// ------------------------------------------------------------------- create

test('creating a project needs only a workspace, and never invents a team', async () => {
  const { service, calls } = serviceWith([{ body: { data: { gid: PROJECT, name: 'Warehouse rollout' } } }]);

  await service.createProject({ name: 'Warehouse rollout', workspace: WORKSPACE });

  assert.equal(calls.methods[0], 'POST');
  assert.ok(calls.urls[0].startsWith('https://app.asana.com/api/1.0/projects?'), calls.urls[0]);
  const data = sentData(calls.bodies[0]);
  assert.equal(data.workspace, WORKSPACE);
  assert.equal(data.name, 'Warehouse rollout');
  // A personal workspace supplies its own implicit team, and there is no right
  // team to guess in an organization.
  assert.ok(!('team' in data), JSON.stringify(data));
});

test('a description is sent as html_notes, converted from markdown, and never alongside notes', async () => {
  const { service, calls } = serviceWith([{ body: { data: { gid: PROJECT } } }]);

  await service.createProject({
    name: 'Warehouse rollout',
    workspace: WORKSPACE,
    notes: '# Charter\n\nShip the **pilot** site.',
  });

  const data = sentData(calls.bodies[0]);
  assert.match(String(data.html_notes), /^<body>/);
  assert.match(String(data.html_notes), /<h1>Charter<\/h1>/);
  assert.match(String(data.html_notes), /<strong>pilot<\/strong>/);
  // Asana rejects a payload carrying both.
  assert.ok(!('notes' in data), JSON.stringify(data));
});

test('a project description never contains the tags Asana answers 400 for', async () => {
  // Probed against the live API: on a *project* `html_notes`, <p>, <br> and
  // <div> are each an "XML is invalid" 400, even though a task's notes take
  // them. Multi-paragraph markdown with hard breaks is exactly the input a
  // naive converter would emit them for, so this pins the whole pipeline.
  const { service, calls } = serviceWith([{ body: { data: { gid: PROJECT } } }]);

  await service.createProject({
    name: 'Warehouse rollout',
    workspace: WORKSPACE,
    notes: [
      '# Charter',
      '',
      // Both of Markdown's real hard breaks - two trailing spaces and a
      // trailing backslash - because those are the constructs a converter would
      // reach for <br> to render. A bare newline is only a soft break and would
      // not exercise this at all.
      'First line, two trailing spaces.  ',
      'Second line, trailing backslash.\\',
      'Third line.',
      '',
      'Second paragraph with a [link](https://example.com).',
      '',
      '- one',
      '  - nested',
      '',
      '> a quote',
      '',
      '```ts',
      'const a = 1;',
      '```',
      '',
      '| a | b |',
      '| --- | --- |',
      '| 1 | 2 |',
    ].join('\n'),
  });

  const html = String(sentData(calls.bodies[0]).html_notes);
  for (const tag of ['<p>', '<p ', '<br', '<div']) {
    assert.ok(!html.includes(tag), `project html_notes must not contain ${tag}: ${html}`);
  }
});

test('visibility is only sent when asked for, so Asana\'s default stands', async () => {
  const silent = serviceWith([{ body: { data: { gid: PROJECT } } }]);
  await silent.service.createProject({ name: 'p', workspace: WORKSPACE });
  assert.ok(!('public' in sentData(silent.calls.bodies[0])));

  const open = serviceWith([{ body: { data: { gid: PROJECT } } }]);
  await open.service.createProject({ name: 'p', workspace: WORKSPACE, isPublic: true });
  assert.equal(sentData(open.calls.bodies[0]).public, true);

  const shut = serviceWith([{ body: { data: { gid: PROJECT } } }]);
  await shut.service.createProject({ name: 'p', workspace: WORKSPACE, isPublic: false });
  assert.equal(sentData(shut.calls.bodies[0]).public, false);
});

test('a create rejected for want of a team explains what that means', async () => {
  const { service } = serviceWith([
    { status: 400, body: { errors: [{ message: 'team: Missing input' }] } },
  ]);

  await assert.rejects(
    service.createProject({ name: 'p', workspace: '9999999999999999' }),
    (err: Error) => {
      assert.match(err.message, /organization/i);
      assert.match(err.message, /does not guess/i);
      return true;
    },
  );
});

test('a 5xx does NOT retry a project creation, because Asana may have committed it', async () => {
  const { service, calls } = serviceWith([{ status: 502, text: 'bad gateway' }]);

  await assert.rejects(service.createProject({ name: 'p', workspace: WORKSPACE }), /502/);
  assert.equal(calls.urls.length, 1);
});

// ------------------------------------------------------------------- update

test('an update sends only the fields it was given', async () => {
  const { service, calls } = serviceWith([{ body: { data: { gid: PROJECT, name: 'New name' } } }]);

  await service.updateProject(PROJECT, { name: 'New name' });

  assert.equal(calls.methods[0], 'PUT');
  assert.deepEqual(sentData(calls.bodies[0]), { name: 'New name' });
});

test('an empty update is refused before a request is made', async () => {
  const { service, calls } = serviceWith([{ body: { data: {} } }]);

  await assert.rejects(service.updateProject(PROJECT, {}), /No fields to update/);
  assert.equal(calls.urls.length, 0);
});

test('an empty description clears it rather than being ignored', async () => {
  const { service, calls } = serviceWith([{ body: { data: { gid: PROJECT } } }]);

  await service.updateProject(PROJECT, { notes: '' });

  assert.equal(sentData(calls.bodies[0]).html_notes, '<body></body>');
});

test('archiving and unarchiving are one boolean field, and neither sends a DELETE', async () => {
  const archive = serviceWith([{ body: { data: { gid: PROJECT, archived: true } } }]);
  const archived = await archive.service.setProjectArchived(PROJECT, true);
  assert.deepEqual(archive.calls.methods, ['PUT']);
  assert.deepEqual(sentData(archive.calls.bodies[0]), { archived: true });
  assert.equal(archived.archived, true);

  const restore = serviceWith([{ body: { data: { gid: PROJECT, archived: false } } }]);
  const active = await restore.service.setProjectArchived(PROJECT, false);
  // Asserted on the restore path too: an "unarchive" reimplemented as a DELETE
  // would destroy the project's tasks, and that must fail here, not in Asana.
  assert.deepEqual(restore.calls.methods, ['PUT']);
  assert.deepEqual(sentData(restore.calls.bodies[0]), { archived: false });
  assert.equal(active.archived, false);

  // The deliberate omission, checked as traffic rather than as a method name:
  // no request this service makes to a project is a DELETE.
  for (const recorder of [archive.calls, restore.calls]) {
    assert.ok(!recorder.methods.includes('DELETE'), recorder.methods.join(','));
  }
});

test('an update also asks for the fields it prints back', async () => {
  const { service, calls } = serviceWith([{ body: { data: { gid: PROJECT } } }]);

  await service.updateProject(PROJECT, { name: 'New name' });

  const fields = (queryOf(calls.urls[0]).get('opt_fields') || '').split(',');
  assert.ok(fields.includes('archived'), fields.join(','));
  assert.ok(fields.includes('color'), fields.join(','));
});

// ------------------------------------------------------------------- colour

test('the colour enum is the one the API itself reports', () => {
  // Quoted from a live 400: "color: Must be one of {...}".
  assert.deepEqual(PROJECT_COLORS, [
    'dark-blue',
    'dark-brown',
    'dark-green',
    'dark-orange',
    'dark-pink',
    'dark-purple',
    'dark-red',
    'dark-teal',
    'dark-warm-gray',
    'light-blue',
    'light-green',
    'light-orange',
    'light-pink',
    'light-purple',
    'light-red',
    'light-teal',
    'light-warm-gray',
    'light-yellow',
    'none',
  ]);

  // The two shapes that look obvious and are not: yellow exists in one weight
  // only, and the grey is spelled the American way.
  assert.ok(PROJECT_COLORS.includes('light-yellow'));
  assert.ok(!PROJECT_COLORS.includes('dark-yellow'));
  assert.ok(!PROJECT_COLORS.some((color) => color.includes('grey')));
});

test('a colour is normalised, and an unknown one is refused before any request', async () => {
  assert.equal(normalizeProjectColor('  Dark-Teal '), 'dark-teal');
  assert.equal(normalizeProjectColor('none'), 'none');
  assert.throws(() => normalizeProjectColor('dark-yellow'), /Asana accepts:.*light-yellow/s);
  assert.throws(() => normalizeProjectColor('dark-warm-grey'), /gray/);

  const created = serviceWith([{ body: { data: { gid: PROJECT } } }]);
  await assert.rejects(
    created.service.createProject({ name: 'p', workspace: WORKSPACE, color: 'periwinkle' }),
    /Unknown project color/,
  );
  // Nothing was created, so there is no half-made project to clean up.
  assert.equal(created.calls.urls.length, 0);

  const updated = serviceWith([{ body: { data: { gid: PROJECT } } }]);
  await assert.rejects(updated.service.updateProject(PROJECT, { color: 'periwinkle' }), /Unknown project color/);
  assert.equal(updated.calls.urls.length, 0);
});

test('the colour Asana reads back can be written back', async () => {
  // The live API rejects its own output: GET answers `purple`, and
  // `PUT color=purple` is a 400 listing only the dark-*/light-* enum. Reading a
  // project and writing one field back is the obvious agent move, so every name
  // `project show` can print has to be accepted here.
  const readForms = [
    'blue',
    'blue-green',
    'cool-gray',
    'aqua',
    'green',
    'hot-pink',
    'indigo',
    'magenta',
    'orange',
    'pink',
    'purple',
    'red',
    'yellow',
    'yellow-green',
    'yellow-orange',
    'none',
  ];

  for (const name of readForms) {
    const resolved = normalizeProjectColor(name);
    assert.ok(
      PROJECT_COLORS.includes(resolved),
      `"${name}" resolved to "${resolved}", which Asana would answer 400 for`,
    );
  }

  // Every alias target must itself be a writable value, or the map only moves
  // the 400 somewhere less obvious.
  for (const [read, write] of Object.entries(PROJECT_COLOR_ALIASES)) {
    assert.ok(PROJECT_COLORS.includes(write), `${read} -> ${write} is not in the write enum`);
  }

  const { service, calls } = serviceWith([{ body: { data: { gid: PROJECT } } }]);
  await service.updateProject(PROJECT, { color: 'purple' });
  assert.equal(sentData(calls.bodies[0]).color, 'light-purple');
});

test('a colour named after an Object.prototype member is refused, not resolved', async () => {
  // `PROJECT_COLOR_ALIASES[color]` on a plain object also answers for anything
  // inherited: `constructor` resolved to the `Object` function and `__proto__`
  // to the prototype itself. `JSON.stringify` drops a function, so the write
  // went out with no `color` field and still reported success - a silently
  // ignored flag, and for `create` a project made with the wrong appearance.
  for (const key of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']) {
    assert.throws(() => normalizeProjectColor(key), /Unknown project color/, `"${key}" was accepted`);
  }

  const { service, calls } = serviceWith([{ body: { data: { gid: PROJECT } } }]);
  await assert.rejects(
    service.updateProject(PROJECT, { name: 'still here', color: 'constructor' }),
    /Unknown project color/,
  );
  // And nothing partially applied: the name did not go out on its own.
  assert.equal(calls.urls.length, 0);
});

test('a valid colour reaches the payload normalised', async () => {
  const { service, calls } = serviceWith([{ body: { data: { gid: PROJECT, color: 'dark-teal' } } }]);

  await service.createProject({ name: 'p', workspace: WORKSPACE, color: 'DARK-TEAL' });

  assert.equal(sentData(calls.bodies[0]).color, 'dark-teal');
});
