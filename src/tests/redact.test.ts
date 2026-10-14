// Credential redaction on the way OUT (owner's standing rule, 2026-09-28).
//
// The case that motivated it is the first test: reading the BotFather chat printed a live bot token,
// because BotFather quotes it verbatim and `telegram read` renders whatever a message contains. Nothing
// asked for the token; looking at a conversation was enough.
//
// What these tests are really pinning is the NARROWNESS. An over-eager redactor that eats ordinary prose
// gets switched off, and a redactor that is switched off protects nothing — so the false-positive cases
// matter more here than the true positives.

import test from 'node:test';
import assert from 'node:assert/strict';

import { REDACTED, redactSecrets, secretsFound, rawSecretsRequested } from '../services/redact.js';

const NO_ENV = {} as NodeJS.ProcessEnv;

// A made-up token in BotFather's format. Never paste a real one here, even a revoked one: this file is
// read by everyone who sweeps the repo for credentials.
test('a Telegram bot token is redacted but its bot id survives', () => {
  const line = 'Use this token to access the HTTP API:\n1234567890:AAFakeTokenForRedactTestsOnly000000';
  const out = redactSecrets(line, NO_ENV);
  assert.ok(!out.includes('AAFakeTokenForRedactTestsOnly000000'), 'the secret half survived');
  // The id half is public — it is the bot's user id and appears in callback data — and keeping it is what
  // makes the redacted line still useful: you can tell WHICH bot the message is about.
  assert.ok(out.includes('1234567890:'), 'the bot id should be kept');
  assert.ok(out.includes(REDACTED));
  assert.deepEqual(secretsFound(line), ['telegram-bot-token']);
});

test("a DSN keeps everything that says where the value lives, and drops only the value", () => {
  const out = redactSecrets('postgres://appuser:sup3rs3cretvalue@db.internal:5432/appdb', NO_ENV);
  assert.equal(out, `postgres://appuser:${REDACTED}@db.internal:5432/appdb`);
  // "the password is in the appdb DSN" is a complete answer, and this output still supports it.
  assert.ok(out.includes('appuser') && out.includes('db.internal'));
});

test('assigned secrets are redacted across the usual spellings', () => {
  for (const line of [
    'HUB_ADMIN_TOKEN=ZmFrZS1hZG1pbi10b2tlbi12YWx1ZQ==',
    'GROQ_API_KEY: gsk_notarealkeybutlongenough',
    'export DB_PASSWORD="hunter2hunter2"',
  ]) {
    const out = redactSecrets(line, NO_ENV);
    assert.ok(out.includes(REDACTED), `not redacted: ${line}`);
    // The KEY is kept on purpose: naming where a value lives is the safe, useful answer.
    assert.ok(/[A-Z_]+/.test(out.split(/[=:]/)[0] ?? ''), `the key name was lost: ${out}`);
  }
});

test('prose about credentials is left alone', () => {
  // These are the strings that get a redactor switched off. None of them carries a value.
  for (const line of [
    'rotate the TOKEN= line in the values file',
    'the PASSWORD is in sops, not here',
    'see step 1: it prints the password',
    'ratio 1234567890:1 is not a token',            // digits:digits, too short a second half
    'commit 5bab040 touched one file',
  ]) {
    assert.equal(redactSecrets(line, NO_ENV), line, `wrongly redacted: ${line}`);
  }
});

test('an empty string and a clean string come back identical', () => {
  assert.equal(redactSecrets('', NO_ENV), '');
  const clean = 'watch "hub" ended (code 0)';
  assert.equal(redactSecrets(clean, NO_ENV), clean);
});

test('CLAUDE_TOOLS_RAW_SECRETS=1 turns it off, because sometimes the value IS the work', () => {
  const line = 'TOKEN=abcdefghijklmnop';
  assert.equal(redactSecrets(line, { CLAUDE_TOOLS_RAW_SECRETS: '1' } as NodeJS.ProcessEnv), line);
  assert.ok(rawSecretsRequested({ CLAUDE_TOOLS_RAW_SECRETS: 'true' } as NodeJS.ProcessEnv));
  assert.ok(!rawSecretsRequested(NO_ENV));
  // And the default is ON, which is the half worth pinning: a redactor that defaults to off is decoration.
  assert.ok(redactSecrets(line, NO_ENV).includes(REDACTED));
});

test('redaction is idempotent, so a line rendered twice does not accumulate markers', () => {
  const once = redactSecrets('postgres://u:secretvalue@h/db', NO_ENV);
  assert.equal(redactSecrets(once, NO_ENV), once);
});
