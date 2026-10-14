// How a hub message reads on one line.
//
// Every assertion here comes from the ISSUE-60 validation, where two agents who had never
// seen the tool were asked to use it and report what was wrong. Three of their findings
// were about this function: a truncation marker that named no way to recover the body,
// a clock with no zone and no seconds, and no record of when a message was received as
// opposed to sent. An agent reads this line and nothing else, so what the line omits is
// what the agent does not know.

import test from 'node:test';
import assert from 'node:assert/strict';

import { formatHubMessage } from '../commands/hub/index.js';
import { BROADCAST_TARGET, type HubMessage } from '../services/hub.js';

function message(over: Partial<HubMessage> = {}): HubMessage {
  return {
    id: '1790345748584-0',
    stream: 'inbox' as HubMessage['stream'],
    from: 'hub-probe-alpha',
    to: 'hub-probe-beta',
    kind: 'msg',
    body: 'short body',
    ts: 1790345748584,
    ...over,
  };
}

test('a body under the limit is passed through untouched', () => {
  const line = formatHubMessage(message({ body: 'short body' }), 'hub-probe-beta', 400);
  assert.match(line, /: short body$/);
  assert.doesNotMatch(line, /chars/);
});

test('a truncated body names the command that returns the rest', () => {
  // The exact failure: a probe acted on an instruction cut mid-sentence and could only
  // recover it because the sender had warned it inside the same truncated line.
  const line = formatHubMessage(message({ body: 'x'.repeat(904) }), 'hub-probe-beta', 400, {
    recover: 'hub log --json',
  });
  assert.match(line, /… \[\+504 chars, hub log --json for the rest\]$/);
});

test('the recovery hint defaults to --json for callers that already have a shell', () => {
  const line = formatHubMessage(message({ body: 'x'.repeat(500) }), 'hub-probe-beta', 400);
  assert.match(line, /\[\+100 chars, --json for the rest\]$/);
});

test('receivedAt renders the hub leg, which is the only latency this process can claim', () => {
  const ts = 1790345748584;
  const line = formatHubMessage(message({ ts }), 'hub-probe-beta', 400, { receivedAt: ts + 6432 });
  assert.match(line, /\(\+6\.4s\)/);
});

test('without receivedAt there is no lag field at all, rather than a zero', () => {
  // A zero would read as "delivered instantly", which is a claim the caller never made.
  const line = formatHubMessage(message(), 'hub-probe-beta', 400);
  assert.doesNotMatch(line, /\(\+/);
});

test('the clock carries seconds and a labelled UTC offset', () => {
  // Computed independently of the implementation: an agent compared an unlabelled `19:15`
  // against its shell's `date -u` of `14:15` and concluded the hub exposed no usable time.
  const ts = 1790345748584;
  const at = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;

  const west = at.getTimezoneOffset();
  const abs = Math.abs(west);
  const rest = abs % 60;
  const offset = `${west > 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}${rest === 0 ? '' : pad(rest)}`;

  const line = formatHubMessage(message({ ts }), 'hub-probe-beta', 400);
  assert.match(line, new RegExp(`^\\[hub\\] ${clock}\\${offset[0]}\\d{2,4} `));
  assert.ok(line.includes(`${clock}${offset}`), `expected ${clock}${offset} in: ${line}`);
});

test('the offset is always present, so the zone is never left to be guessed', () => {
  const line = formatHubMessage(message(), 'hub-probe-beta', 400);
  assert.match(line, /^\[hub\] \d{2}:\d{2}:\d{2}[+-]\d{2,4} /);
});

test('the recipient reads as me for my own inbox and all for a broadcast', () => {
  const mine = formatHubMessage(message({ to: 'hub-probe-beta' }), 'hub-probe-beta', 400);
  assert.match(mine, / → me: /);

  const all = formatHubMessage(message({ to: BROADCAST_TARGET }), 'hub-probe-beta', 400);
  assert.match(all, / → all: /);

  const other = formatHubMessage(message({ to: 'someone-else' }), 'hub-probe-beta', 400);
  assert.match(other, / → someone-else: /);
});

test('newlines fold so one message stays one event line', () => {
  const line = formatHubMessage(message({ body: 'first\nsecond' }), 'hub-probe-beta', 400);
  assert.ok(!line.includes('\n'), 'a folded body must not reintroduce a newline');
  assert.match(line, /first ⏎ second/);
});

test('history lines carry the date and, past an hour, the age; live lines stay short', () => {
  const ts = new Date(2026, 8, 27, 3, 44, 12).getTime(); // local time, 27 Sep 2026
  const now = ts + 2 * 86_400_000 + 3_600_000;
  const dated = formatHubMessage(message({ ts }), 'hub-probe-beta', 400, { dated: true, now });
  assert.match(dated, /^\[hub\] 2026-09-27 03:44:12[+-]\d{2,4} \(2d ago\) /);
  const recent = formatHubMessage(message({ ts }), 'hub-probe-beta', 400, { dated: true, now: ts + 90 * 60_000 });
  assert.match(recent, / \(1h ago\) /);
  const fresh = formatHubMessage(message({ ts }), 'hub-probe-beta', 400, { dated: true, now: ts + 60_000 });
  assert.doesNotMatch(fresh, /ago\)/, 'under an hour needs no age');
  const live = formatHubMessage(message({ ts }), 'hub-probe-beta', 400);
  assert.doesNotMatch(live, /2026-09-27/, 'a live watcher line stays time-only');
});

test('history age switches exactly at 1 hour and at 48 hours', () => {
  const ts = Date.UTC(2026, 8, 27, 12, 0, 0);
  const at = (ms: number) => formatHubMessage(message({ ts }), 'hub-probe-beta', 400, { dated: true, now: ts + ms });
  assert.doesNotMatch(at(3_600_000 - 1), /ago\)/);
  assert.match(at(3_600_000), / \(1h ago\) /);
  assert.match(at(48 * 3_600_000 - 1), / \(47h ago\) /);
  assert.match(at(48 * 3_600_000), / \(2d ago\) /);
});

test('the date and offset are those of the message moment, in the reader\'s zone, across midnight', () => {
  const before = process.env.TZ;
  try {
    // 2026-09-28 20:30 UTC is already 29 September in Tashkent (+05) and still 28 September in New York (-04, DST).
    const ts = Date.UTC(2026, 8, 28, 20, 30, 0);
    process.env.TZ = 'Asia/Tashkent';
    assert.match(formatHubMessage(message({ ts }), 'x', 400, { dated: true, now: ts }), /^\[hub\] 2026-09-29 01:30:00\+05 /);
    process.env.TZ = 'America/New_York';
    assert.match(formatHubMessage(message({ ts }), 'x', 400, { dated: true, now: ts }), /^\[hub\] 2026-09-28 16:30:00-04 /);
  } finally {
    if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
  }
});

test('a live line is exactly the short form: no date, no age', () => {
  const ts = Date.UTC(2026, 8, 20, 12, 0, 0);
  const live = formatHubMessage(message({ ts, body: 'b' }), 'hub-probe-beta', 400);
  assert.match(live, /^\[hub\] \d{2}:\d{2}:\d{2}[+-]\d{2,4} \S+ → \S+: b$/);
});
