import test from 'node:test';
import assert from 'node:assert/strict';

import { AsanaService, isGid } from '../services/asana.js';

/**
 * Asana identifiers are opaque decimal strings, and the API hands them back
 * quoted for a reason: a 17-digit gid does not survive a round trip through a
 * JS number. These tests pin the string-ness end to end, because the corruption
 * is silent - the wrong id is still a valid-looking id.
 */

/** A 16-digit gid, the shape the API returns. */
const REAL_GID = '1218000000000039';

/** A 17-digit gid, the shape that breaks under numeric parsing. */
const LONG_GID = '12180000000000053';

function fakeFetch(payload: unknown, capture?: string[]): typeof fetch {
  return (async (url: string | URL) => {
    capture?.push(String(url));
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => null },
      async text() {
        return JSON.stringify(payload);
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

test('a realistic 16-digit gid survives the service round trip as a string', async () => {
  const service = new AsanaService(
    { accessToken: 'test-token' },
    fakeFetch({
      data: {
        gid: REAL_GID,
        name: 'Decide whether to connect the home PC to the office cluster',
        completed: false,
        due_on: '2026-09-30',
        assignee: { gid: '1218000000000043', name: 'Dovron Sherbaev' },
        projects: [{ gid: '1218000000000055', name: 'Infrastructure' }],
        parent: { gid: LONG_GID, name: 'Parent task' },
      },
    }),
  );

  const task = await service.getTask(REAL_GID);

  assert.equal(typeof task.gid, 'string');
  assert.equal(task.gid, REAL_GID);
  assert.equal(task.projects[0].gid, '1218000000000055');
  assert.equal(task.parent?.gid, LONG_GID);
});

test('a 17-digit gid is corrupted by numeric parsing but not by the service', async () => {
  // The failure this guards against, made explicit.
  assert.notEqual(String(Number(LONG_GID)), LONG_GID);
  assert.ok(Number(LONG_GID) > Number.MAX_SAFE_INTEGER);

  const service = new AsanaService(
    { accessToken: 'test-token' },
    fakeFetch({ data: { gid: LONG_GID, name: 'Long gid', completed: false } }),
  );

  const task = await service.getTask(LONG_GID);
  assert.equal(task.gid, LONG_GID);
});

test('a gid is passed through the request path untouched', async () => {
  const urls: string[] = [];
  const service = new AsanaService({ accessToken: 'test-token' }, fakeFetch({ data: { gid: LONG_GID } }, urls));

  await service.getTask(LONG_GID);

  assert.equal(urls.length, 1);
  assert.ok(urls[0].startsWith(`https://app.asana.com/api/1.0/tasks/${LONG_GID}?`));
});

test('a project gid survives the service round trip as a string', async () => {
  const service = new AsanaService(
    { accessToken: 'test-token' },
    fakeFetch({
      data: {
        gid: LONG_GID,
        name: 'Warehouse rollout',
        archived: false,
        notes: 'What this project is for.',
        workspace: { gid: '1218000000000033', name: 'My workspace' },
        team: { gid: '1218000000000057', name: 'My workspace' },
      },
    }),
  );

  const project = await service.getProject(LONG_GID);

  assert.equal(typeof project.gid, 'string');
  assert.equal(project.gid, LONG_GID);
  assert.equal(project.workspace?.gid, '1218000000000033');
});

test('a project gid is passed through the request path untouched', async () => {
  const urls: string[] = [];
  const service = new AsanaService({ accessToken: 'test-token' }, fakeFetch({ data: { gid: LONG_GID } }, urls));

  await service.getProject(LONG_GID);
  await service.updateProject(LONG_GID, { archived: true });

  assert.equal(urls.length, 2);
  for (const url of urls) {
    assert.ok(url.startsWith(`https://app.asana.com/api/1.0/projects/${LONG_GID}?`), url);
  }
});

test('a created project keeps the gid Asana returned, not a rounded number', async () => {
  const service = new AsanaService(
    { accessToken: 'test-token' },
    fakeFetch({ data: { gid: LONG_GID, name: 'Warehouse rollout' } }),
  );

  const created = await service.createProject({ name: 'Warehouse rollout', workspace: '1218000000000033' });

  assert.equal(created.gid, LONG_GID);
  assert.notEqual(created.gid, String(Number(LONG_GID)));
});

test('isGid separates ids from names', () => {
  assert.equal(isGid(REAL_GID), true);
  assert.equal(isGid(LONG_GID), true);
  assert.equal(isGid(` ${REAL_GID} `), true);

  assert.equal(isGid('Infrastructure'), false);
  assert.equal(isGid('Q4 2026'), false);
  // Short numeric strings are names, not ids: a project called "2026" must not
  // be mistaken for a gid.
  assert.equal(isGid('2026'), false);
  assert.equal(isGid('12345678'), false);
  assert.equal(isGid('1218000000000013x'), false);
  assert.equal(isGid(''), false);
});
