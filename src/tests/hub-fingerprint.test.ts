// The one place client and server MUST agree byte for byte.
//
// The hub authenticates a machine by `base64url(HMAC-SHA256(salt, context + anchor))`
// and stores only `sha256` of it. If this client's derivation drifts from the
// server's by a single byte, every machine stops authenticating at once - and the
// symptom is not an error that says so. It is an approval prompt: the hub sees an
// unknown fingerprint, queues it, and the owner is told to approve a machine he
// already approved. That reads as an enrolment problem and it would be debugged as
// one, which is why the agreement is pinned here as literals rather than left to
// two copies of the same algorithm.
//
// **Every literal below was produced by the SERVER's own compiled module**
// (agent-hub `packages/shared/dist/fingerprint.js` at 86fd524), and the same
// literals are pinned in that repo's `packages/shared/src/fingerprint.test.ts`.
// A divergence fails a test on both sides.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  ANCHOR_FILENAME,
  appSpecificId,
  configDirectory,
  deriveFingerprint,
  FINGERPRINT_APP_ID,
  FINGERPRINT_CONTEXT,
  FingerprintError,
  fingerprintHash,
  loadSalt,
  MACHINE_LABEL_LENGTH,
  machineFingerprint,
  machineLabel,
  resolveAnchor,
  SALT_BYTES,
  SALT_FILENAME,
  saltPath,
  type FingerprintEnvironment,
} from '../services/hub-fingerprint.js';

/**
 * The systemd vector. `appSpecificId` implements systemd's
 * `sd_id128_get_machine_app_specific`: HMAC-SHA256 keyed by the machine id over the app
 * id, first 16 bytes, with the UUID version-4 and RFC4122 variant bits set. These vectors
 * come from a synthetic machine id and an independent implementation of that algorithm, so
 * the test checks the code against the specification rather than against itself.
 */
const MACHINE_ID = '0123456789abcdef0123456789abcdef';
const VECTOR_APP_ID = '4e7f4b2a1c9d4f6e8a0b1c2d3e4f5061';
const VECTOR_ANCHOR = 'f2ac35fb06144cdd8d03d3057c792f17';

/** The same machine id under the app id this client and the hub actually use. */
const PRODUCTION_ANCHOR = '7fe4b3f259a14bd7b1edf529d2c8958d';

/** A fixed, obviously-not-real salt: 32 bytes of 0x07. */
const SALT = Buffer.alloc(SALT_BYTES, 7);

/** The whole chain, from that machine id to what the owner would see in the console. */
const CHAIN = {
  fingerprint: 'Lyewr77-KHxgSDRaBssFeG8_Dz6ZrniRgBC-c9TY5FE',
  hash: 'abffb929937d244da0d43160398042a69e1630b2aeafa6f66422dba10e112bae',
  label: 'abffb929937d244d',
};

/** The same, through the production app id rather than the systemd vector's. */
const PRODUCTION_CHAIN = {
  fingerprint: 'dE1q_hh8Tt4wmgZ6YQEeB6CNbahXl06ZoGMR7al0O5I',
  hash: '801b8154ff72e253a27bd93217d495ec2a65481338c0033449d6e01102be97fa',
  label: '801b8154ff72e253',
};

function withHome(run: (home: string) => void) {
  return () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-fingerprint-test-'));
    try {
      run(home);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  };
}

/** No OS probe succeeds, so the anchor falls all the way to the random file. */
function env(home: string, overrides: Partial<FingerprintEnvironment> = {}): FingerprintEnvironment {
  return { configHome: home, platform: 'linux', readTextFile: () => null, runCommand: () => null, ...overrides };
}

// ---------------------------------------------------------------------------
// The cross-repo vectors
// ---------------------------------------------------------------------------

test('the app-specific id reproduces systemd byte for byte', () => {
  assert.equal(appSpecificId(Buffer.from(MACHINE_ID, 'hex'), VECTOR_APP_ID), VECTOR_ANCHOR);
});

test('the compiled-in app id and context string match the hub', () => {
  // These two are the derivation's version number. Changing either re-derives every
  // fingerprint on every machine, which reads at the hub as a fleet of new pending
  // machines - so they are pinned, on both sides.
  assert.equal(FINGERPRINT_APP_ID, 'd52c0138296aa0b9bdca559f7e4b97c8');
  assert.equal(FINGERPRINT_CONTEXT, 'ai-hub/fingerprint/v1\n');
  assert.equal(appSpecificId(Buffer.from(MACHINE_ID, 'hex')), PRODUCTION_ANCHOR);
});

test('the whole chain matches the hub: fingerprint, hash and label', () => {
  // Produced by the server's own module. If this fails, the client and the server
  // no longer agree on who this machine is, and no amount of approving will fix it.
  const fingerprint = deriveFingerprint(SALT, VECTOR_ANCHOR);
  assert.equal(fingerprint, CHAIN.fingerprint);
  assert.equal(fingerprintHash(fingerprint), CHAIN.hash);
  assert.equal(machineLabel(fingerprint), CHAIN.label);

  const production = deriveFingerprint(SALT, PRODUCTION_ANCHOR);
  assert.equal(production, PRODUCTION_CHAIN.fingerprint);
  assert.equal(fingerprintHash(production), PRODUCTION_CHAIN.hash);
  assert.equal(machineLabel(production), PRODUCTION_CHAIN.label);
});

test('the hash is over the wire value, not the bytes it decodes to', () => {
  // The server hashes the header it received. If the two sides ever disagree about
  // what gets hashed, every machine stops authenticating and nothing says why.
  assert.equal(
    fingerprintHash('A'.repeat(43)),
    '0f007385b6f9d4b7eeb2748605afe1a984a0a3bfa3f014d09e2a784ce9e5cd1a'
  );
});

test('the fingerprint is 43 base64url characters - 256 bits', () => {
  const fingerprint = deriveFingerprint(SALT, VECTOR_ANCHOR);
  assert.match(fingerprint, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(fingerprint, 'base64url').byteLength, 32);
});

test('the derivation is domain-separated, so the salt cannot mean something else', () => {
  const naive = createHmac('sha256', SALT).update(VECTOR_ANCHOR, 'utf8').digest('base64url');
  assert.notEqual(deriveFingerprint(SALT, VECTOR_ANCHOR), naive);
});

test('the label is a prefix of the HASH, never of the credential', () => {
  // ISSUE-13's finding, and the reason it is a test rather than a comment: the server
  // cannot tell a derived fingerprint from an invented one, so a prefix of the
  // fingerprint would be chosen by whoever sent it - anyone could appear in the
  // approval screen under a real machine's identifier, and one mistaken click is
  // bus access.
  const fingerprint = deriveFingerprint(SALT, VECTOR_ANCHOR);
  const label = machineLabel(fingerprint);
  assert.equal(label.length, MACHINE_LABEL_LENGTH);
  assert.equal(label, fingerprintHash(fingerprint).slice(0, MACHINE_LABEL_LENGTH));
  assert.ok(!fingerprint.startsWith(label), 'the label must not be a prefix of the fingerprint');
});

test('a salt of the wrong length is refused, not worked around', () => {
  // "No usable salt, carry on anyway" would silently downgrade every machine to the
  // anchor-only form, which is reproducible by anyone who has held a copy of the
  // filesystem - and nobody would notice.
  for (const wrong of [Buffer.alloc(0), Buffer.alloc(16, 1), Buffer.alloc(64, 1)]) {
    assert.throws(() => deriveFingerprint(wrong, VECTOR_ANCHOR), FingerprintError);
  }
});

// ---------------------------------------------------------------------------
// The salt file
// ---------------------------------------------------------------------------

test('the salt is created once, 0600, and never regenerated', withHome((home) => {
  const first = loadSalt(env(home));
  assert.equal(first.byteLength, SALT_BYTES);

  const file = saltPath(env(home));
  assert.equal(file, path.join(home, 'ai-hub', SALT_FILENAME));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);

  // The same machine must re-derive the same identity, or every restart is a new
  // pending machine in the owner's queue.
  assert.deepEqual(loadSalt(env(home)), first);
}));

test('a leftover temp file is not left behind for the next run to read', withHome((home) => {
  loadSalt(env(home));
  const entries = fs.readdirSync(path.join(home, 'ai-hub'));
  assert.deepEqual(entries.filter((name) => name.endsWith('.tmp')), []);
}));

test('a salt readable by anyone else is a hard error', withHome((home) => {
  const file = saltPath(env(home));
  loadSalt(env(home));
  fs.chmodSync(file, 0o644);
  assert.throws(() => loadSalt(env(home)), (error: unknown) => {
    assert.ok(error instanceof FingerprintError);
    assert.equal(error.code, 'salt_permissions');
    return true;
  });
}));

test('a truncated salt stops the client instead of re-enrolling it', withHome((home) => {
  const file = saltPath(env(home));
  loadSalt(env(home));
  fs.writeFileSync(file, Buffer.alloc(8), { mode: 0o600 });
  assert.throws(() => loadSalt(env(home)), (error: unknown) => {
    assert.ok(error instanceof FingerprintError);
    assert.equal(error.code, 'salt_malformed');
    return true;
  });
}));

test('a symlinked salt is refused', withHome((home) => {
  const dir = path.join(home, 'ai-hub');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const elsewhere = path.join(home, 'elsewhere.key');
  fs.writeFileSync(elsewhere, Buffer.alloc(SALT_BYTES, 3), { mode: 0o600 });
  fs.symlinkSync(elsewhere, path.join(dir, SALT_FILENAME));
  assert.throws(() => loadSalt(env(home)), (error: unknown) => {
    assert.ok(error instanceof FingerprintError);
    assert.equal(error.code, 'salt_permissions');
    return true;
  });
}));

test('a world-writable config directory is refused', withHome((home) => {
  const dir = path.join(home, 'ai-hub');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  loadSalt(env(home));
  fs.chmodSync(dir, 0o777);
  try {
    assert.throws(() => loadSalt(env(home)), (error: unknown) => {
      assert.ok(error instanceof FingerprintError);
      assert.equal(error.code, 'salt_permissions');
      return true;
    });
  } finally {
    fs.chmodSync(dir, 0o700);
  }
}));

// ---------------------------------------------------------------------------
// The anchor
// ---------------------------------------------------------------------------

test('the machine-id rung and the dbus rung produce the same anchor', withHome((home) => {
  // Falling through from one to the other must NOT re-enrol the machine.
  const fromMachineId = resolveAnchor(env(home, { readTextFile: (p) => (p === '/etc/machine-id' ? MACHINE_ID : null) }));
  const fromDbus = resolveAnchor(env(home, {
    readTextFile: (p) => (p === '/var/lib/dbus/machine-id' ? MACHINE_ID : null),
  }));
  assert.equal(fromMachineId.rung, 'machine-id');
  assert.equal(fromDbus.rung, 'dbus-machine-id');
  assert.equal(fromMachineId.value, fromDbus.value);
  assert.equal(fromMachineId.value, PRODUCTION_ANCHOR);
}));

test('an uninitialized machine-id is not taken as an anchor', withHome((home) => {
  // systemd bind-mounts a transient `/etc/machine-id` on a read-only root and the
  // value changes per boot until it is committed. Taking it would hand every boot a
  // different fingerprint.
  const anchor = resolveAnchor(env(home, { readTextFile: () => 'uninitialized' }));
  assert.equal(anchor.rung, 'random-file');
  assert.ok(fs.existsSync(path.join(home, 'ai-hub', ANCHOR_FILENAME)));
}));

test('the full client identity is stable across calls on one machine', withHome((home) => {
  const first = machineFingerprint(env(home, { readTextFile: (p) => (p === '/etc/machine-id' ? MACHINE_ID : null) }));
  const second = machineFingerprint(env(home, { readTextFile: (p) => (p === '/etc/machine-id' ? MACHINE_ID : null) }));
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.label, second.label);
  assert.equal(first.hash, fingerprintHash(first.fingerprint));
  assert.equal(first.anchor.value, PRODUCTION_ANCHOR);
  assert.match(first.fingerprint, /^[A-Za-z0-9_-]{43}$/);
}));

test('the config directory is ~/.config/ai-hub, not claude-tools\' own', withHome((home) => {
  // Deliberate: the salt is shared by every hub client on the machine, and D14 puts
  // it at ~/.config/ai-hub/machine.key. Moving it under claude-tools would give a
  // second client a second identity for the same machine.
  assert.equal(configDirectory({ configHome: home }), path.join(home, 'ai-hub'));
}));
