// The hub client against a real HTTP server.
//
// A stubbed `fetch` would pass while the client sent the credential in the wrong
// header, so these tests run a `node:http` server and inspect what actually
// arrived on the wire. Three of them exist for one reason each:
//
//  - the fingerprint must be in `X-Hub-Fingerprint` and NOT in `Authorization`,
//    because the cluster's basic-auth middleware is `removeHeader: true` and would
//    eat it (roadmap R8);
//  - it must never appear in a URL or query string, because those land in logs;
//  - the client must abort AFTER the server's hold, or it retries into a hold that
//    is still parked on Redis and the holds pile up (roadmap R7).

import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';

import {
  BROADCAST_TARGET,
  CLIENT_ABORT_MS,
  HubClient,
  type HubClientOptions,
  HubCursorError,
  HubNotApprovedError,
  HubNotHubError,
  HubPermanentError,
  HubRenamedError,
  HubArchiveUnreadableError,
  HubTransientError,
  MAX_MESSAGE_BODY_BYTES,
  MAX_STATUS_BYTES,
  SERVER_HOLD_MS,
  assertLadder,
  consoleUrl,
  hubOrigin,
  MAX_MESSAGE_TTL_SECONDS,
  parseTtl,
} from '../services/hub.js';

/** Shaped like a real one - 43 base64url characters - but obviously not derived. */
const FINGERPRINT = 'Ukh-4k-7jbPI1NzOHQf5YrxT882e8wSXBGbAwUvlrok';

interface Recorded {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

type Handler = (request: IncomingMessage, response: ServerResponse, recorded: Recorded) => void;

/** Run one test against a live server, and always close it. */
async function withServer(handler: Handler, run: (base: string, calls: Recorded[]) => Promise<void>): Promise<void> {
  const calls: Recorded[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const recorded: Recorded = {
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf-8'),
      };
      calls.push(recorded);
      handler(request, response, recorded);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`, calls);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function json(response: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(body);
}

function client(base: string, overrides: Partial<HubClientOptions> = {}): HubClient {
  return new HubClient({
    baseUrl: base,
    agent: 'manager',
    fingerprint: FINGERPRINT,
    clientVersion: '1.0.27',
    anchorRung: 'machine-id',
    ...overrides,
  });
}

const EMPTY_POLL = { messages: [], cursor: '1:1758787200123-0:1758787100000-4', waitedMs: 25_000 };

// ---------------------------------------------------------------------------
// How the credential travels
// ---------------------------------------------------------------------------

test('the fingerprint goes in X-Hub-Fingerprint and nowhere else', async () => {
  await withServer((_request, response) => json(response, 200, EMPTY_POLL), async (base, calls) => {
    await client(base).poll({ after: '$', waitMs: 1_000, timeoutMs: 5_000 });
    const call = calls[0]!;
    assert.equal(call.headers['x-hub-fingerprint'], FINGERPRINT);
    assert.equal(call.headers['x-hub-agent'], 'manager');
    // R8: the house basic-auth middleware strips `Authorization`. Sending the
    // credential there would work locally and fail only once deployed.
    assert.equal(call.headers['authorization'], undefined);
    // Query strings land in access logs.
    assert.ok(!call.url.includes(FINGERPRINT), `the fingerprint leaked into the URL: ${call.url}`);
    assert.ok(!call.body.includes(FINGERPRINT), 'the fingerprint leaked into the body');
  });
});

test('the poll carries the registration metadata, and never the machine', async () => {
  await withServer((_request, response) => json(response, 200, EMPTY_POLL), async (base, calls) => {
    await client(base, { label: 'ISSUE-20 worker' }).poll({ after: '$', waitMs: 1_000, timeoutMs: 5_000 });
    const query = new URL(`http://x${calls[0]!.url}`).searchParams;
    // Arming the watcher IS the registration (roadmap D2), so this is the only
    // chance to say who is arming it.
    assert.equal(query.get('clientVersion'), '1.0.27');
    assert.equal(query.get('label'), 'ISSUE-20 worker');
    assert.equal(query.get('anchor'), 'machine-id');
    assert.equal(query.get('pid'), String(process.pid));
    assert.equal(query.get('wait'), '1');
    // The anchor VALUE and the machine label are the server's to decide, from the
    // verified fingerprint: an agent must not be able to declare which machine it
    // is on.
    assert.equal(query.get('machine'), null);
  });
});

test('an error message never carries the credential', async () => {
  await withServer((_request, response) => {
    response.writeHead(500, { 'content-type': 'text/plain' });
    // A server that echoes a header into an error page is not hypothetical.
    response.end(`upstream failed for ${FINGERPRINT}`);
  }, async (base) => {
    await assert.rejects(
      () => client(base).roster(),
      (error: unknown) => {
        assert.ok(error instanceof HubTransientError);
        assert.ok(!error.message.includes(FINGERPRINT), `the credential leaked into an error: ${error.message}`);
        assert.match(error.message, /fingerprint redacted/);
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// The refusals, and telling them apart
// ---------------------------------------------------------------------------

test('a pending machine is a typed error carrying the retry interval', async () => {
  await withServer((_request, response) => json(response, 403, {
    status: 'pending',
    message: 'This machine is not approved. Ask the owner to approve it in the hub UI.',
    poll_after_ms: 15_000,
  }), async (base) => {
    await assert.rejects(
      () => client(base).poll({ after: '$', waitMs: 1_000, timeoutMs: 5_000 }),
      (error: unknown) => {
        assert.ok(error instanceof HubNotApprovedError);
        assert.equal(error.pollAfterMs, 15_000);
        return true;
      }
    );
  });
});

test('a 401 is reported as the ingress, not the hub', async () => {
  // D11 puts basic auth on the console route and none on /api, because that
  // middleware strips the fingerprint. A 401 therefore means a misconfigured route —
  // or another app answering /api. Either way it is waited out without the
  // credential rather than exited on (ISSUE-92), and the message still names R8.
  await withServer((_request, response) => {
    response.writeHead(401, { 'www-authenticate': 'Basic realm="hub"' });
    response.end('Unauthorized');
  }, async (base) => {
    await assert.rejects(
      () => client(base).roster(),
      (error: unknown) => {
        assert.ok(error instanceof HubNotHubError, 'waited out without the credential, not exited (ISSUE-92)');
        assert.match(error.message, /basic-auth/i);
        assert.match(error.message, /R8/);
        return true;
      }
    );
  });
});

test('a refused cursor is its own error, so the watcher can re-baseline loudly', async () => {
  await withServer((_request, response) => json(response, 400, {
    error: 'invalid_cursor',
    detail: 'cursor holds something that is not a stream id',
  }), async (base) => {
    await assert.rejects(
      () => client(base).poll({ after: '1:bad:bad', waitMs: 1_000, timeoutMs: 5_000 }),
      (error: unknown) => {
        assert.ok(error instanceof HubCursorError);
        assert.match(error.message, /not a stream id/);
        return true;
      }
    );
  });
});

test('a rejected agent name and an unknown recipient are permanent, not retried', async () => {
  await withServer((request, response) => {
    if (request.method === 'POST') {
      json(response, 404, { error: 'unknown_agent' });
      return;
    }
    json(response, 400, { error: 'invalid_agent' });
  }, async (base) => {
    await assert.rejects(() => client(base).roster(), HubPermanentError);
    await assert.rejects(
      () => client(base).send({ to: 'ghost', body: 'hello' }),
      (error: unknown) => {
        assert.ok(error instanceof HubPermanentError);
        assert.match(error.message, /armed its watcher/);
        return true;
      }
    );
  });
});

test('a 5xx and a rate limit are transient, and a 429 reports its Retry-After', async () => {
  await withServer((request, response) => {
    if (request.url?.startsWith('/api/log')) {
      json(response, 429, { error: 'slow_down' }, { 'retry-after': '7' });
      return;
    }
    json(response, 503, { error: 'redis_unavailable' });
  }, async (base) => {
    await assert.rejects(() => client(base).roster(), HubTransientError);
    await assert.rejects(
      () => client(base).history({ limit: 5 }),
      (error: unknown) => {
        assert.ok(error instanceof HubTransientError);
        assert.equal(error.status, 429);
        assert.equal(error.retryAfterMs, 7_000);
        return true;
      }
    );
  });
});

test('an HTML answer is transient rather than parsed as a message', async () => {
  // What a misrouted ingress or a captive portal actually returns.
  await withServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<html><body>hub console</body></html>');
  }, async (base) => {
    await assert.rejects(
      () => client(base).poll({ after: '$', waitMs: 1_000, timeoutMs: 5_000 }),
      (error: unknown) => {
        assert.ok(error instanceof HubTransientError);
        assert.match(error.message, /not JSON/);
        return true;
      }
    );
  });
});

test('a poll response that re-tails instead of resolving the cursor is refused', async () => {
  // The contract says the cursor is always concrete. Storing `$` would silently
  // re-baseline the watcher on the next poll, which is the one failure the server
  // promises never to cause - so the client refuses rather than persisting it.
  await withServer((_request, response) => json(response, 200, { messages: [], cursor: '$', waitedMs: 10 }), async (base) => {
    await assert.rejects(
      () => client(base).poll({ after: '$', waitMs: 1_000, timeoutMs: 5_000 }),
      HubTransientError
    );
  });
});

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

test('the ladder puts the client last, and an inverted one is refused', () => {
  assert.equal(SERVER_HOLD_MS, 25_000);
  assert.equal(CLIENT_ABORT_MS, 40_000);
  assert.ok(CLIENT_ABORT_MS > SERVER_HOLD_MS, 'the client must be the last to give up');
  assert.doesNotThrow(() => assertLadder(SERVER_HOLD_MS, CLIENT_ABORT_MS));
  // Equal is not enough: the abort would fire while the hold was still answering.
  assert.throws(() => assertLadder(25_000, 25_000), HubPermanentError);
  assert.throws(() => assertLadder(30_000, 25_000), HubPermanentError);
});

test('a poll asking to wait longer than the hold is clamped, not sent', async () => {
  await withServer((_request, response) => json(response, 200, EMPTY_POLL), async (base, calls) => {
    await client(base).poll({ after: '$', waitMs: 120_000, timeoutMs: CLIENT_ABORT_MS });
    assert.equal(new URL(`http://x${calls[0]!.url}`).searchParams.get('wait'), String(SERVER_HOLD_MS / 1000));
  });
});

test('a server that never answers becomes a transient timeout, not a hang', async () => {
  await withServer(() => {
    // Hold the socket open and say nothing, which is what a hung ingress looks like.
  }, async (base) => {
    const started = Date.now();
    await assert.rejects(
      () => client(base).poll({ after: '$', waitMs: 1_000, timeoutMs: 1_500 }),
      (error: unknown) => {
        assert.ok(error instanceof HubTransientError);
        assert.match(error.message, /no response within/);
        return true;
      }
    );
    assert.ok(Date.now() - started < 5_000, 'the abort did not fire');
  });
});

// ---------------------------------------------------------------------------
// Local validation, so the operator is told the rule rather than shown a 413
// ---------------------------------------------------------------------------

test('the caps are checked here, before a body goes over the wire', async () => {
  await withServer((_request, response) => json(response, 201, { id: '1-0', to: 'worker', ts: 1 }), async (base, calls) => {
    const hub = client(base);
    await assert.rejects(
      () => hub.send({ to: 'worker', body: 'x'.repeat(MAX_MESSAGE_BODY_BYTES + 1) }),
      (error: unknown) => {
        assert.ok(error instanceof HubPermanentError);
        assert.match(error.message, /8192/);
        return true;
      }
    );
    await assert.rejects(() => hub.setStatus('y'.repeat(MAX_STATUS_BYTES + 1)), HubPermanentError);
    await assert.rejects(() => hub.send({ to: 'worker', body: '' }), HubPermanentError);
    await assert.rejects(() => hub.send({ to: 'Worker', body: 'hi' }), HubPermanentError);
    await assert.rejects(() => hub.send({ to: 'worker', body: 'hi', kind: 'NOT OK' }), HubPermanentError);
    await assert.rejects(() => hub.send({ to: 'worker', body: 'hi', corr: 'no spaces allowed' }), HubPermanentError);
    // Nothing reached the server: every one of those was refused locally.
    assert.equal(calls.length, 0);
  });
});

test('a broadcast is a send to "*"', async () => {
  await withServer((_request, response) => json(response, 201, { id: '5-0', to: '*', ts: 2 }), async (base, calls) => {
    const sent = await client(base).send({ to: BROADCAST_TARGET, body: 'restart your watcher', kind: 'restart' });
    assert.equal(sent.to, '*');
    assert.deepEqual(JSON.parse(calls[0]!.body), { to: '*', body: 'restart your watcher', kind: 'restart' });
  });
});

test('an invalid agent name is refused before a client exists', () => {
  assert.throws(
    () => new HubClient({ baseUrl: 'http://127.0.0.1:1', agent: 'Manager', fingerprint: FINGERPRINT }),
    HubPermanentError
  );
  assert.throws(
    () => new HubClient({ baseUrl: 'http://127.0.0.1:1', agent: 'manager', fingerprint: 'too-short' }),
    HubPermanentError
  );
});

// ---------------------------------------------------------------------------
// The URL
// ---------------------------------------------------------------------------

test('both the origin and its /api form resolve to the same API', () => {
  // Half the time someone will paste the /api form, because that is what the
  // Traefik route looks like. `/api/api/messages` is a 404 that reads as a broken
  // deployment.
  assert.equal(hubOrigin('https://hub.example.com'), 'https://hub.example.com');
  assert.equal(hubOrigin('https://hub.example.com/'), 'https://hub.example.com');
  assert.equal(hubOrigin('https://hub.example.com/api'), 'https://hub.example.com');
  assert.equal(hubOrigin('https://hub.example.com/api/'), 'https://hub.example.com');
  assert.equal(hubOrigin('http://127.0.0.1:8787/api'), 'http://127.0.0.1:8787');
  assert.equal(consoleUrl(hubOrigin('https://hub.example.com/api')), 'https://hub.example.com/');
  assert.throws(() => hubOrigin('not a url'), HubPermanentError);
  assert.throws(() => hubOrigin('ftp://hub.example'), HubPermanentError);
});

test('a poll hits /api/messages on the resolved origin', async () => {
  await withServer((_request, response) => json(response, 200, EMPTY_POLL), async (base, calls) => {
    await client(`${base}/api`).poll({ after: '$', waitMs: 1_000, timeoutMs: 5_000 });
    assert.ok(calls[0]!.url.startsWith('/api/messages?'), `unexpected path: ${calls[0]!.url}`);
  });
});

test('messages come back parsed, with the stream they arrived on', async () => {
  await withServer((_request, response) => json(response, 200, {
    messages: [
      { id: '1758787200123-0', stream: 'inbox', from: 'worker', to: 'manager', kind: 'msg', body: 'ISSUE-20 done', ts: 1758787200123 },
      { id: '1758787200123-0', stream: 'broadcast', from: 'owner', to: '*', kind: 'restart', body: 'update', ts: 1758787200123, corr: 'r-1' },
    ],
    cursor: '1:1758787200123-0:1758787200123-0',
    waitedMs: 12,
  }), async (base) => {
    const batch = await client(base).poll({ after: '$', waitMs: 1_000, timeoutMs: 5_000 });
    assert.equal(batch.messages.length, 2);
    // The same id on two streams is legitimate: Redis keeps the sequence counter per
    // stream. A client keyed on the id alone would drop one of these.
    assert.equal(batch.messages[0]!.id, batch.messages[1]!.id);
    assert.equal(batch.messages[0]!.stream, 'inbox');
    assert.equal(batch.messages[1]!.stream, 'broadcast');
    assert.equal(batch.messages[1]!.corr, 'r-1');
    assert.equal(batch.cursor, '1:1758787200123-0:1758787200123-0');
  });
});

test('a refused connection names the reason rather than saying "fetch failed"', async () => {
  // Node's fetch reports every network failure with the same message and hides the
  // useful part in `cause`. An outage log that cannot tell a refused port from a
  // bad hostname from an expired certificate is a log nobody can act on.
  // A port that was listening a moment ago and is not any more, which is exactly
  // what killing the hub mid-poll looks like from here.
  let port = 0;
  await withServer(() => {}, async (base) => {
    port = Number(new URL(base).port);
  });
  const hub = new HubClient({ baseUrl: `http://127.0.0.1:${port}`, agent: 'manager', fingerprint: FINGERPRINT });
  await assert.rejects(
    () => hub.poll({ after: '$', waitMs: 500, timeoutMs: 3_000 }),
    (error: unknown) => {
      assert.ok(error instanceof HubTransientError);
      assert.match(error.message, /ECONNREFUSED/);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// Regressions from the Codex audit of this diff (2026-09-25)
// ---------------------------------------------------------------------------

test('a redirect is refused, so the credential cannot be forwarded to another origin', async () => {
  // `fetch` strips `Authorization` on a cross-origin redirect and keeps every other
  // header - and the fingerprint deliberately is NOT in `Authorization` (roadmap R8).
  // Measured on this Node build before the fix: the second origin received the
  // fingerprint in full. So redirects are refused rather than followed.
  const elsewhere: Recorded[] = [];
  const second: Server = createServer((request, response) => {
    elsewhere.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers, body: '' });
    json(response, 200, EMPTY_POLL);
  });
  await new Promise<void>((resolve) => second.listen(0, '127.0.0.1', resolve));
  const secondPort = (second.address() as AddressInfo).port;
  try {
    await withServer((_request, response) => {
      response.writeHead(302, { location: `http://127.0.0.1:${secondPort}/api/messages` });
      response.end();
    }, async (base) => {
      await assert.rejects(
        () => client(base).poll({ after: '$', waitMs: 1_000, timeoutMs: 5_000 }),
        (error: unknown) => {
          assert.ok(error instanceof HubNotHubError, 'a redirect is something else answering (ISSUE-92)');
          assert.match(error.message, /redirect/i);
          return true;
        }
      );
    });
    assert.deepEqual(elsewhere, [], 'the redirect target must never be contacted at all');
  } finally {
    await new Promise<void>((resolve) => second.close(() => resolve()));
  }
});

test('a ladder that setTimeout would collapse is refused', () => {
  // `setTimeout` reduces anything past 2^31-1 ms to about 1ms, so an Infinity abort
  // passes a naive `abort > wait` comparison and then fires inside the server's hold.
  // Zero is legitimate: it drains what is already queued without holding at all.
  assert.doesNotThrow(() => assertLadder(0, 5_000));
  assert.throws(() => assertLadder(25_000, Number.POSITIVE_INFINITY), HubPermanentError);
  assert.throws(() => assertLadder(25_000, 2_147_483_648), HubPermanentError);
  assert.throws(() => assertLadder(Number.NaN, 40_000), HubPermanentError);
});

test('the ladder is checked against the wait that is actually sent, not the one asked for', async () => {
  // The wire carries seconds: 24.6s is sent as a 25s hold, so a 24.7s abort would
  // fire inside it even though the millisecond comparison looks fine.
  await withServer((_request, response) => json(response, 200, EMPTY_POLL), async (base) => {
    await assert.rejects(
      () => client(base).poll({ after: '$', waitMs: 24_600, timeoutMs: 24_700 }),
      HubPermanentError
    );
  });
});

test('a reflected fingerprint is redacted on every error branch, including 401 and invalid_cursor', async () => {
  await withServer((request, response) => {
    if (request.url?.startsWith('/api/log')) {
      // A server that echoes a header into a detail field is not hypothetical, and
      // this branch used to interpolate it unredacted straight onto the watcher's stdout.
      json(response, 400, { error: 'invalid_cursor', detail: `bad cursor ${FINGERPRINT}` });
      return;
    }
    response.writeHead(401, { 'www-authenticate': `Basic realm="${FINGERPRINT}"` });
    response.end('Unauthorized');
  }, async (base) => {
    await assert.rejects(() => client(base).roster(), (error: unknown) => {
      assert.ok(!(error as Error).message.includes(FINGERPRINT), 'the 401 branch leaked the credential');
      return true;
    });
    await assert.rejects(() => client(base).history({ limit: 5 }), (error: unknown) => {
      assert.ok(error instanceof HubCursorError);
      assert.ok(!error.message.includes(FINGERPRINT), 'the invalid_cursor branch leaked the credential');
      return true;
    });
  });
});

test('a reflected credential cannot survive truncation', async () => {
  // `snippet` cuts at 200 characters, so redacting afterwards would slice one
  // character off the front of a reflected fingerprint and leave the other 42 in the
  // error - a credential with one character missing. Redaction therefore happens
  // before every truncation.
  const padding = 'p'.repeat(158);
  await withServer((request, response) => {
    if (request.url?.startsWith('/api/log')) {
      json(response, 400, { error: 'invalid_cursor', detail: `${padding}${FINGERPRINT}` });
      return;
    }
    response.writeHead(500, { 'content-type': 'text/plain' });
    response.end(`${padding}${FINGERPRINT}`);
  }, async (base) => {
    for (const call of [() => client(base).roster(), () => client(base).history({ limit: 3 })]) {
      await assert.rejects(call, (error: unknown) => {
        const message = (error as Error).message;
        // Not one contiguous run of the credential longer than a handful of characters.
        for (let length = FINGERPRINT.length; length >= 8; length -= 1) {
          assert.ok(
            !message.includes(FINGERPRINT.slice(0, length)) && !message.includes(FINGERPRINT.slice(-length)),
            `a ${length}-character run of the credential survived: ${message}`
          );
        }
        return true;
      });
    }
  });
});

// ---------------------------------------------------------------------------
// ISSUE-92: telling the hub from something else answering /api
// ---------------------------------------------------------------------------

test('a 404 without the hub\'s error code is something else answering: transient, and says so', async () => {
  await withServer((_request, response) => {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('404 page not found');
  }, async (base) => {
    await assert.rejects(
      () => client(base).poll({ after: '$', waitMs: 1_000, timeoutMs: 5_000 }),
      (error: unknown) => {
        assert.ok(error instanceof HubNotHubError);
        assert.ok(error instanceof HubTransientError, 'a watcher must not exit on it');
        assert.match(error.message, /something other than the hub answered \/api\/messages/);
        assert.match(error.message, /body: 404 page not found/);
        assert.doesNotMatch(error.message, /console/, 'the old text blamed a URL that was correct');
        return true;
      },
    );
  });
});

test('a 404 the hub itself sends is still permanent', async () => {
  await withServer((_request, response) => json(response, 404, { error: 'not_found' }), async (base) => {
    await assert.rejects(
      () => client(base).poll({ after: '$', waitMs: 1_000, timeoutMs: 5_000 }),
      (error: unknown) => {
        assert.ok(error instanceof HubPermanentError);
        assert.match(error.message, /from the hub itself \(not_found\)/);
        return true;
      },
    );
  });
});

test('a 200 of JSON the client cannot read is not taken as the hub either', async () => {
  await withServer((_request, response) => json(response, 200, { status: 'ok' }), async (base) => {
    await assert.rejects(
      () => client(base).poll({ after: '$', waitMs: 1_000, timeoutMs: 5_000 }),
      HubNotHubError,
    );
  });
});

test('the health probe judges by body, and never sends the credential', async () => {
  let body: unknown = { status: 'ok', timestamp: '2026-09-28T17:08:06Z' };
  await withServer((_request, response) => json(response, 200, body), async (base, calls) => {
    const probe = await client(base).probeHub(5_000);
    assert.equal(probe.hub, false, 'a 200 from another app is not the hub');
    assert.match(probe.detail, /HTTP 200, body: \{"status":"ok"/);

    body = { ok: true, version: '52475ae9b61e' };
    assert.equal((await client(base).probeHub(5_000)).hub, true);

    for (const call of calls) {
      assert.equal(call.url, '/api/health');
      assert.equal(call.headers['x-hub-fingerprint'], undefined, 'the probe exists so the credential is not sent');
      assert.equal(call.headers['x-hub-agent'], undefined);
    }
  });
});

test('a probe that cannot connect is "not yet", never a throw', async () => {
  const probe = await client('http://127.0.0.1:9').probeHub(2_000);
  assert.equal(probe.hub, false);
  assert.ok(probe.detail.length > 0);
});

test('a non-hub answer on any status is not the hub; the hub\'s own JSON errors are unchanged', async () => {
  await withServer((request, response) => {
    if (request.url?.startsWith('/api/log')) {
      response.writeHead(503, { 'content-type': 'text/html' });
      response.end('<html>Service Unavailable</html>');
      return;
    }
    json(response, 503, { error: 'redis_unavailable' });
  }, async (base) => {
    await assert.rejects(() => client(base).history({ limit: 5 }), (error: unknown) => {
      assert.ok(error instanceof HubNotHubError, 'an ingress 503 is not the hub');
      assert.match(error.message, /HTTP 503, body: <html>Service Unavailable/);
      return true;
    });
    await assert.rejects(() => client(base).roster(), (error: unknown) => {
      assert.ok(error instanceof HubTransientError);
      assert.ok(!(error instanceof HubNotHubError), 'the hub\'s own 503 is an ordinary transient error');
      return true;
    });
  });
});

test('the new branches never print a reflected credential, whole or truncated', async () => {
  let payload = '';
  let status = 404;
  await withServer((_request, response) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(payload);
  }, async (base) => {
    const leaks = (message: string) => message.includes(FINGERPRINT.slice(0, 12));
    // The credential as the error code of a hub-shaped 404.
    payload = JSON.stringify({ error: FINGERPRINT });
    await assert.rejects(() => client(base).poll({ after: '$', waitMs: 1_000, timeoutMs: 5_000 }), (error: Error) => {
      assert.ok(!leaks(error.message), error.message);
      return true;
    });
  });
});

test('a credential cut by the 60-character excerpt is still redacted', async () => {
  // Starting at offset 18, the excerpt keeps exactly 42 of its 43 characters: truncating before redacting
  // would leave a fragment the exact-match redaction no longer recognises.
  const prefix = '{"s":"' + 'p'.repeat(12);
  assert.equal(prefix.length, 18);
  await withServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(`${prefix}${FINGERPRINT}","m":"${'x'.repeat(80)}"}`);
  }, async (base) => {
    await assert.rejects(() => client(base).poll({ after: '$', waitMs: 1_000, timeoutMs: 5_000 }), (error: Error) => {
      assert.ok(error instanceof HubNotHubError);
      assert.ok(!error.message.includes(FINGERPRINT.slice(0, 20)), error.message);
      return true;
    });
  });
});

test('foreign JSON is not the hub, whatever "status" it carries; only the 403 pending body is', async () => {
  let reply: { status: number; body: unknown } = { status: 404, body: { status: 'not_found' } };
  await withServer((_request, response) => json(response, reply.status, reply.body), async (base) => {
    const poll = () => client(base).poll({ after: '$', waitMs: 1_000, timeoutMs: 5_000 });
    await assert.rejects(poll, HubNotHubError);
    reply = { status: 503, body: { status: 'unavailable' } };
    await assert.rejects(poll, HubNotHubError);
    reply = { status: 403, body: { status: 'pending', poll_after_ms: 15_000 } };
    await assert.rejects(poll, HubNotApprovedError);
  });
});

test('a foreign 429 is waited out without the credential, carrying its Retry-After; a 413 to a poll too', async () => {
  let status = 429;
  await withServer((_request, response) => {
    response.writeHead(status, { 'content-type': 'text/plain', 'retry-after': '7' });
    response.end(status === 429 ? 'Too Many Requests' : 'Request Entity Too Large');
  }, async (base) => {
    await assert.rejects(() => client(base).poll({ after: '$', waitMs: 1_000, timeoutMs: 5_000 }), (error: unknown) => {
      assert.ok(error instanceof HubNotHubError);
      assert.equal(error.retryAfterMs, 7_000);
      return true;
    });
    status = 413;
    await assert.rejects(() => client(base).poll({ after: '$', waitMs: 1_000, timeoutMs: 5_000 }), HubNotHubError);
    // With a body, too large is about this request, and permanent.
    await assert.rejects(() => client(base).send({ to: 'ghost', body: 'hello' }), HubPermanentError);
  });
});

test('a renamed answer cannot put a reflected credential on stdout through from, to or detail', async () => {
  let body: Record<string, unknown> = {};
  await withServer((_request, response) => json(response, 410, body), async (base) => {
    const poll = () => client(base).poll({ after: '$', waitMs: 1_000, timeoutMs: 5_000 });
    const clean = (error: Error & { from?: string; to?: string; detail?: string }) => {
      for (const text of [error.message, error.from ?? '', error.to ?? '', error.detail ?? '']) {
        assert.ok(!text.includes(FINGERPRINT.slice(0, 12)), `leaked: ${text}`);
      }
      return true;
    };
    body = { error: 'renamed', from: FINGERPRINT, to: 'manager-2', detail: `moved; ${FINGERPRINT}` };
    await assert.rejects(poll, clean);
    body = { error: 'renamed', from: 'manager', to: FINGERPRINT, detail: 'moved' };
    await assert.rejects(poll, clean);
  });
});

test('a rate-limited health probe says when to come back', async () => {
  await withServer((_request, response) => {
    response.writeHead(429, { 'content-type': 'text/plain', 'retry-after': '120' });
    response.end('Too Many Requests');
  }, async (base) => {
    const probe = await client(base).probeHub(5_000);
    assert.equal(probe.hub, false);
    assert.equal(probe.retryAfterMs, 120_000);
  });
});

// ---------------------------------------------------------------------------
// ISSUE-84: the hub telling a sender its own name is wrong
// ---------------------------------------------------------------------------

test('a send warning about OUR OWN name survives parsing, because only the hub can see it', async () => {
  // An archived sender looks entirely healthy from here: the send returns 201 with an id. Four messages went
  // out under a dead name that way, and every one of them looked correct. The warning is the only signal.
  const warning = 'you are sending as "myrepo-af", which is archived and off the roster';
  await withServer((_request, response) => json(response, 201, { id: '1-0', to: 'coordinator', ts: 1, warning }), async (base) => {
    const sent = await client(base).send({ to: 'coordinator', body: 'hello' });
    assert.equal(sent.warning, warning);
  });
});

test('an ordinary send has no warning, and an older hub that omits the field still parses', async () => {
  // Rolled out client-first, so a current client must keep working against a hub that has never heard of the
  // field. A parse error here would break every send until the server caught up.
  await withServer((_request, response) => json(response, 201, { id: '1-0', to: 'coordinator', ts: 1 }), async (base) => {
    assert.equal((await client(base).send({ to: 'coordinator', body: 'hello' })).warning, null);
  });
});

test('a renamed SENDER is a typed error naming the successor, not a generic failure', async () => {
  // The send half of the redirect. `hub send` must be able to say "retry as <new>" without re-parsing prose,
  // which is why HubRenamedError carries `to` rather than only a message.
  const body = { error: 'renamed', from: 'myrepo-af', to: 'cross-service-routing', detail: '"myrepo-af" was renamed to "cross-service-routing"; nothing was sent.' };
  await withServer((_request, response) => json(response, 410, body), async (base) => {
    await assert.rejects(
      () => client(base, { agent: 'myrepo-af' }).send({ to: 'coordinator', body: 'hello' }),
      (error: unknown) => {
        assert.ok(error instanceof HubRenamedError, `expected HubRenamedError, got ${(error as Error).name}`);
        assert.equal(error.from, 'myrepo-af');
        assert.equal(error.to, 'cross-service-routing');
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// `hub send all` — the displayed name of a broadcast is not an address
// ---------------------------------------------------------------------------

test('`hub send all` is refused before contacting the hub, and names `hub broadcast`', async () => {
  const { spawnSync } = await import('node:child_process');
  const { resolve } = await import('node:path');
  // Port 1: nothing listens there. If the CLI tried the hub, the error would be about the connection.
  const run = spawnSync(process.execPath, [resolve('dist/cli.js'), 'hub', 'send', '--as', 'tester', '--url', 'http://127.0.0.1:1', 'all', 'hello'], {
    encoding: 'utf8',
    env: { ...process.env, AGENT_HUB_AGENT: 'tester' },
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr + run.stdout, /hub broadcast/);
  assert.doesNotMatch(run.stderr + run.stdout, /ECONNREFUSED|unreachable|fetch failed/i, 'it contacted the hub');
});

// ---------------------------------------------------------------------------
// ISSUE-91: a name whose archive marker the hub cannot read (owner's decision, option B)
// ---------------------------------------------------------------------------

const UNREADABLE = {
  error: 'archive_unreadable',
  agent: 'manager',
  detail: '"manager" has an archive record this hub cannot read, so it is kept off the hub rather than guessed about. An operator must click Restore for "manager" in the hub console; nothing else will let it back in.',
};

test('a 423 archive_unreadable is its own typed error, not the 409 rename conflict and not transient', async () => {
  // 409 would stop the watcher with a message about names already being taken; transient would back off as if
  // waiting could help. Only an operator's Restore changes this answer.
  await withServer((_request, response) => json(response, 423, UNREADABLE), async (base) => {
    await assert.rejects(
      () => client(base).poll({ after: '$', waitMs: 1_000, timeoutMs: 5_000 }),
      (error: unknown) => {
        assert.ok(error instanceof HubArchiveUnreadableError, `expected HubArchiveUnreadableError, got ${(error as Error).name}`);
        assert.equal(error.agent, 'manager');
        assert.match(error.detail, /Restore/);
        return true;
      },
    );
  });
});

test('the watcher says so ONCE while refused, keeps polling quietly, and says once more when restored', async () => {
  // The whole experience of option B: one loud line the owner can act on, no flood (every line wakes the
  // agent), and no re-arming needed afterwards — clicking Restore is enough on its own.
  const { spawn } = await import('node:child_process');
  const { resolve } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'hub-ah91-'));   // never the real config: the live watcher's cursor lives there
  let polls = 0;
  await withServer((_request, response) => {
    polls += 1;
    if (polls <= 3) json(response, 423, UNREADABLE);
    else json(response, 200, EMPTY_POLL);
  }, async (base) => {
    const child = spawn(process.execPath, [resolve('dist/cli.js'), 'hub', 'watch', '--url', base, '--timeout', '1'], {
      env: { ...process.env, AGENT_HUB_AGENT: 'manager', CLAUDE_TOOLS_CONFIG_DIR: dir, CLAUDE_TOOLS_HUB_ARCHIVE_RETRY_MS: '100' },
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    try {
      for (let i = 0; i < 100 && !stdout.includes('was restored'); i += 1) await new Promise((r) => setTimeout(r, 50));
    } finally {
      child.kill('SIGTERM');
      rmSync(dir, { recursive: true, force: true });
    }
    const errors = stdout.split('\n').filter((line) => line.includes('ERROR'));
    assert.equal(errors.length, 1, `expected exactly one ERROR line across three refusals, got:\n${stdout}`);
    assert.match(errors[0] ?? '', /Restore/);
    assert.equal(stdout.split('\n').filter((line) => line.includes('was restored')).length, 1, stdout);
    assert.ok(polls >= 4, `the watcher should have kept polling through the refusal (polled ${polls} times)`);
  });
});

test('--ttl durations: seconds, minutes, hours, days; nonsense is refused', () => {
  assert.equal(parseTtl('90'), 90);
  assert.equal(parseTtl('90s'), 90);
  assert.equal(parseTtl('30m'), 1_800);
  assert.equal(parseTtl('2h'), 7_200);
  assert.equal(parseTtl('7d'), MAX_MESSAGE_TTL_SECONDS);
  for (const bad of ['', '0', '0m', '-5m', '1.5h', 'soon', '2w', '3 h']) assert.equal(parseTtl(bad), null, bad);
});

test('a send with a TTL carries ttlSeconds; an out-of-range one never leaves the client', async () => {
  await withServer((_request, response) => json(response, 201, { id: '1-0', to: 'peer', ts: 1 }), async (base, calls) => {
    await client(base).send({ to: 'peer', body: 'applying now', ttlSeconds: 1_800 });
    assert.equal(JSON.parse(calls[0]!.body).ttlSeconds, 1_800);
    await client(base).send({ to: 'peer', body: 'no ttl' });
    assert.equal(JSON.parse(calls[1]!.body).ttlSeconds, undefined, 'no TTL means the field is absent');
    await assert.rejects(() => client(base).send({ to: 'peer', body: 'x', ttlSeconds: MAX_MESSAGE_TTL_SECONDS + 1 }), HubPermanentError);
    assert.equal(calls.length, 2);
  });
});

test("Traefik's own 503 is named as the hub restarting, not as a misrouted /api", async () => {
  await withServer((_request, response) => {
    response.writeHead(503, { 'content-type': 'text/plain' });
    response.end('no available server');
  }, async (base) => {
    await assert.rejects(() => client(base).poll({ after: '$', waitMs: 1_000, timeoutMs: 5_000 }), (error: Error) => {
      assert.ok(error instanceof HubNotHubError, 'still waited out without the credential');
      assert.match(error.message, /not ready/);
      assert.match(error.message, /deploy or restart/);
      assert.doesNotMatch(error.message, /somewhere else/, 'the route is right; saying otherwise sends people hunting');
      return true;
    });
  });
});

// ---------------------------------------------------------------------------
// Any agent controls any agent's roster entry and history (hub, 2026-10-06)
// ---------------------------------------------------------------------------

test('another agent\'s status goes to that agent\'s path, sent as this agent', async () => {
  await withServer((_request, response) => json(response, 200, { agent: 'stale', status: 'retired', ts: 1 }), async (base, calls) => {
    const result = await client(base).setStatus('retired', 'stale');
    assert.equal(result.agent, 'stale');
    assert.equal(calls[0]!.method, 'PUT');
    assert.equal(calls[0]!.url, '/api/agents/stale/status');
    assert.equal(calls[0]!.headers['x-hub-agent'], 'manager');
  });
});

test('forget, restore, prune and audit hit their routes and parse the answers', async () => {
  await withServer((request, response) => {
    const url = request.url ?? '';
    if (url === '/api/agents/stale/forget') return json(response, 200, { agent: 'stale', forgotten: true, archived: true, purgeAt: 5, ts: 1 });
    if (url === '/api/agents/stale/restore') return json(response, 200, { agent: 'stale', restored: true, ts: 2 });
    if (url === '/api/messages/prune') return json(response, 200, { stream: '*', candidates: [{ id: '1-0', from: 'a', to: '*', kind: 'msg', ts: 3, head: 'FREEZE', expired: false }], truncated: false, deleted: 0 });
    if (url.startsWith('/api/audit?')) return json(response, 200, { entries: [{ id: '9-0', actor: 'manager', action: 'prune', target: '*', ts: 4, detail: { deleted: 1, copies: null } }] });
    if (url === '/api/audit/0f0e2a4c-1b2d-4e5f-8a9b-0c1d2e3f4a5b') return json(response, 200, { id: 'x', messages: [{ id: '1-0', stream: 'broadcast', from: 'a', to: '*', kind: 'msg', body: 'FREEZE', ts: 3 }] });
    return json(response, 404, { error: 'not_found' });
  }, async (base, calls) => {
    const hub = client(base);
    assert.deepEqual(await hub.forget('stale'), { agent: 'stale', archived: true, purgeAt: 5 });
    assert.deepEqual(await hub.restore('stale'), { agent: 'stale', restored: true });
    const preview = await hub.prune({ stream: '*', match: 'freeze' });
    assert.deepEqual(preview.candidates.map((c) => c.head), ['FREEZE']);
    assert.deepEqual(JSON.parse(calls[2]!.body), { stream: '*', match: 'freeze' });
    const audit = await hub.audit(5);
    assert.equal(audit[0]!.actor, 'manager');
    assert.match(calls[3]!.url, /limit=5/);
    const copies = await hub.auditCopies('0f0e2a4c-1b2d-4e5f-8a9b-0c1d2e3f4a5b');
    assert.equal(copies[0]!.body, 'FREEZE');
  });
});

test('control calls refuse a malformed target before anything goes over the wire', async () => {
  await withServer((_request, response) => json(response, 500, {}), async (base, calls) => {
    const hub = client(base);
    await assert.rejects(() => hub.forget('Not Valid'), HubPermanentError);
    await assert.rejects(() => hub.restore('../x'), HubPermanentError);
    await assert.rejects(() => hub.setStatus('x', 'BAD'), HubPermanentError);
    await assert.rejects(() => hub.auditCopies('not-a-uuid'), HubPermanentError);
    assert.equal(calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Bot calls through the hub (forum topics, 2026-10-06)
// ---------------------------------------------------------------------------

test('a bot call goes to the hub as this agent and returns Telegram\'s result', async () => {
  await withServer((_request, response) => json(response, 200, { ok: true, result: { message_id: 14 } }), async (base, calls) => {
    const result = await client(base).botCall('personal', 'sendMessage', { chat_id: '-1002000000001', message_thread_id: 3, text: 'hi' });
    assert.deepEqual(result, { message_id: 14 });
    assert.equal(calls[0]!.url, '/api/bots/personal/call/sendMessage');
    assert.equal(calls[0]!.headers['x-hub-agent'], 'manager');
    assert.deepEqual(JSON.parse(calls[0]!.body), { chat_id: '-1002000000001', message_thread_id: 3, text: 'hi' });
  });
});

test('a topic link, unlink and listing go to the hub as this agent', async () => {
  await withServer((request, response) => {
    if (request.url === '/api/bots/personal/topics/link') return json(response, 200, { ok: true, chat: '-1002000000001', topic: 3847, agent: 'business-entity', created: true, delivered: 3 });
    if (request.url === '/api/bots/personal/topics/unlink') return json(response, 200, { ok: true, chat: '-1002000000001', topic: 3847, removed: true });
    return json(response, 200, { chat: '-1002000000001', defaultAgent: 'coordinator', topics: [{ topic: 3, agent: 'agent-hub', source: 'route' }, { topic: 3847, agent: 'business-entity', source: 'link' }] });
  }, async (base, calls) => {
    assert.deepEqual(await client(base).botTopicLink('personal', '-1002000000001', 3847, 'business-entity'), { topic: 3847, agent: 'business-entity', created: true, delivered: 3 });
    assert.deepEqual(JSON.parse(calls[0]!.body), { chat_id: '-1002000000001', topic_id: 3847, agent: 'business-entity' });
    assert.equal(calls[0]!.headers['x-hub-agent'], 'manager');
    assert.deepEqual(await client(base).botTopicUnlink('personal', '-1002000000001', 3847), { removed: true });
    assert.deepEqual(JSON.parse(calls[1]!.body), { chat_id: '-1002000000001', topic_id: 3847 });
    const listed = await client(base).botTopics('personal', '-1002000000001');
    assert.equal(calls[2]!.url, '/api/bots/personal/topics?chat_id=-1002000000001');
    assert.deepEqual(listed, { defaultAgent: 'coordinator', topics: [{ topic: 3, agent: 'agent-hub', source: 'route' }, { topic: 3847, agent: 'business-entity', source: 'link' }] });
  });
});

test('a taken topic is refused with the hub\'s own reason, not the rename advice, and bad ids never leave', async () => {
  await withServer((_request, response) => json(response, 409, { error: 'topic_taken', detail: 'topic 4 is routed to "team-support" in the cluster config' }), async (base, calls) => {
    await assert.rejects(() => client(base).botTopicLink('personal', '-1002000000001', 4, 'zcode'),
      (error: unknown) => error instanceof HubPermanentError && /topic_taken.*routed to "team-support"/.test((error as Error).message) && !/rename/.test((error as Error).message));
    assert.equal(calls.length, 1);
    await assert.rejects(() => client(base).botTopicLink('personal', '-1002000000001', 1, 'zcode'), HubPermanentError);
    await assert.rejects(() => client(base).botTopicLink('personal', '@agents', 5, 'zcode'), HubPermanentError);
    await assert.rejects(() => client(base).botTopicLink('personal', '-1002000000001', 5, 'Not A Name'), HubPermanentError);
    await assert.rejects(() => client(base).botTopicUnlink('Bad Bot', '-1002000000001', 5), HubPermanentError);
    assert.equal(calls.length, 1);
  });
});

test('a topic refusal from the hub surfaces with its reason, and malformed names never leave', async () => {
  await withServer((_request, response) => json(response, 403, { error: 'topic_not_yours', detail: 'topic 4 belongs to "team-support"' }), async (base, calls) => {
    // Permanent, with the hub's own reason: the same request would get the same refusal, so nothing retries it.
    await assert.rejects(() => client(base).botCall('personal', 'sendMessage', {}),
      (error: unknown) => error instanceof HubPermanentError && /topic_not_yours.*topic 4 belongs to/.test((error as Error).message));
    await assert.rejects(() => client(base).botCall('Bad Bot', 'sendMessage', {}), HubPermanentError);
    await assert.rejects(() => client(base).botCall('personal', 'send/../x', {}), HubPermanentError);
    assert.equal(calls.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Riding out a hub restart
// ---------------------------------------------------------------------------

const NOT_READY = (response: ServerResponse) => {
  response.writeHead(503, { 'content-type': 'text/plain' });
  response.end('no available server');
};

test('a send made while the hub restarts is repeated until the hub is back, and lands once', async () => {
  let calls = 0;
  await withServer((_request, response) => {
    calls += 1;
    if (calls <= 2) return NOT_READY(response);
    json(response, 201, { id: '1-0', to: 'worker', ts: 1 });
  }, async (base) => {
    const sent = await client(base, { notReadyRetryMs: 20_000 }).send({ to: 'worker', body: 'during a deploy' });
    assert.equal(sent.id, '1-0');
    assert.equal(calls, 3);
  });
});

test('a send gives up when the hub stays down past the window, and says the hub is not ready', async () => {
  await withServer((_request, response) => NOT_READY(response), async (base) => {
    await assert.rejects(() => client(base, { notReadyRetryMs: 100 }).send({ to: 'worker', body: 'x' }), /hub is not ready/);
  });
});

test('only "no hub pod ready" is retried: a refusal from the hub itself fails at once', async () => {
  let calls = 0;
  await withServer((_request, response) => { calls += 1; json(response, 404, { error: 'unknown_agent' }); }, async (base) => {
    await assert.rejects(() => client(base, { notReadyRetryMs: 20_000 }).send({ to: 'nobody', body: 'x' }), HubPermanentError);
    assert.equal(calls, 1);
  });
});
