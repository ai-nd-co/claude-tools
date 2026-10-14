import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

import { loadConfig } from '../config/loader.js';

import {
  ImapAuthError,
  ImapWriteRefused,
  ReadOnlyImapClient,
  assertReadOnly,
  decodeWords,
  parseHeaders,
  parseValues,
  quote,
  splitResponses,
} from '../services/imap-readonly.js';
import {
  GmailWatcher,
  ImapMailSource,
  accountStateName,
  countSeen,
  defaultStatePath,
  gmailWatchStatePath,
  localMidnight,
  makeScrubber,
  uidRange,
  countByDay,
  dayBoundaries,
  formatMail,
  formatNotice,
  isOutgoing,
  loadGmailWatchState,
  mailTag,
  messageUrl,
  type GmailWatchState,
  type MailMeta,
  type MailSource,
} from '../services/gmail-watch.js';

// ---------------------------------------------------------------------------
// The write guard: the property the design rests on
// ---------------------------------------------------------------------------

test('assertReadOnly accepts exactly the read verbs', () => {
  for (const c of [
    'CAPABILITY', 'LOGIN "a" "b"', 'LIST "" "*"', 'EXAMINE "[Gmail]/All Mail"', 'STATUS "INBOX" (MESSAGES UNSEEN)',
    'NOOP', 'LOGOUT', 'UID SEARCH UID 5:*', 'UID SEARCH X-GM-RAW "category:social"',
    'UID FETCH 1,2 (UID X-GM-MSGID X-GM-LABELS BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])',
    'uid fetch 1 (RFC822.HEADER)',
  ]) assert.doesNotThrow(() => assertReadOnly(c), c);
});

test('assertReadOnly refuses every verb that can change the mailbox', () => {
  for (const c of [
    'SELECT "INBOX"', 'STORE 1 +FLAGS (\\Seen)', 'UID STORE 1 +FLAGS (\\Deleted)', 'EXPUNGE', 'UID EXPUNGE 1',
    'COPY 1 "Trash"', 'UID COPY 1 "Trash"', 'MOVE 1 "Trash"', 'UID MOVE 1 "[Gmail]/Trash"', 'APPEND "INBOX" {10}',
    'CREATE "x"', 'DELETE "x"', 'RENAME "a" "b"', 'SUBSCRIBE "x"', 'CLOSE', 'IDLE', 'AUTHENTICATE PLAIN', 'ENABLE UTF8=ACCEPT',
    'SEARCH ALL', 'FETCH 1 (FLAGS)',
  ]) assert.throws(() => assertReadOnly(c), ImapWriteRefused, c);
});

test('assertReadOnly refuses a FETCH that would set \\Seen', () => {
  for (const c of [
    'UID FETCH 1 (BODY[])', 'UID FETCH 1 (BODY[TEXT])', 'UID FETCH 1 (UID BODY[HEADER])',
    'UID FETCH 1 (RFC822)', 'UID FETCH 1 RFC822', 'UID FETCH 1 (RFC822.TEXT)', 'uid fetch 1 (body[1])',
  ]) assert.throws(() => assertReadOnly(c), ImapWriteRefused, c);
});

test('quote escapes and refuses line breaks', () => {
  assert.equal(quote('a"b\\c'), '"a\\"b\\\\c"');
  assert.throws(() => quote('a\r\nb'));
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test('splitResponses keeps a literal inside its response and waits for a partial one', () => {
  const full = Buffer.from('* 1 FETCH (UID 7 BODY[HEADER.FIELDS (SUBJECT)] {13}\r\nSubject: hi\r\n)\r\nR1 OK done\r\n');
  const { responses, rest } = splitResponses(full);
  assert.equal(responses.length, 2);
  assert.match(responses[0].toString(), /Subject: hi/);
  assert.equal(rest.length, 0);

  const partial = full.subarray(0, 60);
  const p = splitResponses(partial);
  assert.equal(p.responses.length, 0);
  assert.equal(p.rest.length, 60);
});

test('parseValues reads atoms, quoted strings, NIL, nested lists and literals', () => {
  const hdr = 'From: A <a@x>\r\nSubject: ü\r\n';
  const raw = Buffer.from('* 3 FETCH (UID 42 X-GM-MSGID 1803000000000000001 X-GM-LABELS ("\\\\Inbox" "\\\\Important" Work) ' +
    `BODY[HEADER.FIELDS (FROM SUBJECT)] {${Buffer.byteLength(hdr)}}\r\n${hdr} NIL)`);
  const v = parseValues(raw, 2);
  assert.equal(v[0], '3');
  assert.equal(v[1], 'FETCH');
  const list = v[2] as unknown[];
  assert.deepEqual(list.slice(0, 4), ['UID', '42', 'X-GM-MSGID', '1803000000000000001']);
  assert.deepEqual(list[5], ['\\Inbox', '\\Important', 'Work']);
  assert.equal(list[6], 'BODY[HEADER.FIELDS (FROM SUBJECT)]');
  assert.match(String(list[7]), /Subject: ü/);
  assert.equal(list[8], null);
});

test('decodeWords handles B and Q encodings and joins adjacent words', () => {
  assert.equal(decodeWords('=?UTF-8?B?0J/RgNC40LLQtdGC?='), 'Привет');
  assert.equal(decodeWords('=?iso-8859-1?Q?Caf=E9_ok?='), 'Café ok');
  assert.equal(decodeWords('=?UTF-8?Q?a?= =?UTF-8?Q?b?='), 'ab');
  assert.equal(decodeWords('plain text'), 'plain text');
});

test('parseHeaders unfolds and decodes', () => {
  const h = parseHeaders('From: "Bob" <bob@x.com>\r\nSubject: =?UTF-8?Q?Hello?=\r\n world\r\nDate: Tue, 7 Oct 2026 10:00:00 +0500\r\n');
  assert.equal(h.from, '"Bob" <bob@x.com>');
  assert.equal(h.subject, 'Hello world');
  assert.equal(h.date, 'Tue, 7 Oct 2026 10:00:00 +0500');
});

// ---------------------------------------------------------------------------
// A fake Gmail IMAP server: records every command, answers the read-only subset
// ---------------------------------------------------------------------------

interface FakeOptions {
  loginOk?: boolean;
  /** Refuse the login the other way: an untagged BYE, then hang up. */
  loginBye?: boolean;
  readOnly?: boolean;
  /** Override the tagged EXAMINE text. */
  examineText?: string;
  /** After each requested FETCH response, also send an unsolicited flags-only one. */
  unsolicitedFlags?: boolean;
  /** Label list to return for every message. */
  labels?: string;
  /** Answer a header FETCH without the headers (a partial response). */
  dropHeaders?: boolean;
  uids?: number[];
  categories?: Record<string, number[]>;
}

function startFake(opts: FakeOptions = {}): Promise<{ port: number; received: string[]; close: () => void }> {
  const received: string[] = [];
  const uids = opts.uids ?? [10, 11, 12];
  const server = net.createServer((sock) => {
    sock.write('* OK Gimap ready\r\n');
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      let idx: number;
      while ((idx = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const [tag, ...rest] = line.split(' ');
        const cmd = rest.join(' ');
        received.push(cmd);
        const upper = cmd.toUpperCase();
        const ok = (text = 'Success') => sock.write(`${tag} OK ${text}\r\n`);
        if (upper.startsWith('LOGIN')) {
          if (opts.loginBye) { sock.write('* BYE [AUTHENTICATIONFAILED] Invalid credentials (Failure)\r\n'); sock.end(); return; }
          if (opts.loginOk === false) sock.write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)\r\n`);
          else ok();
        } else if (upper === 'CAPABILITY') {
          sock.write('* CAPABILITY IMAP4rev1 UNSELECT IDLE X-GM-EXT-1 UIDPLUS\r\n'); ok();
        } else if (upper.startsWith('LIST')) {
          sock.write('* LIST (\\HasNoChildren) "/" "INBOX"\r\n');
          sock.write('* LIST (\\All \\HasNoChildren) "/" "[Gmail]/All Mail"\r\n');
          sock.write('* LIST (\\HasNoChildren \\Junk) "/" "[Gmail]/Spam"\r\n'); ok();
        } else if (upper.startsWith('EXAMINE')) {
          sock.write(`* ${uids.length} EXISTS\r\n* OK [UIDVALIDITY 555] UIDs valid\r\n* OK [UIDNEXT ${Math.max(0, ...uids) + 1}] next\r\n`);
          ok(opts.examineText ?? (opts.readOnly === false ? '[READ-WRITE] Success' : '[READ-ONLY] Examine completed'));
        } else if (upper.startsWith('UID SEARCH X-GM-RAW') || /^UID SEARCH UID [\d,:]+ X-GM-RAW/.test(upper)) {
          const cat = /category:(\w+)/i.exec(cmd)?.[1] ?? '';
          const hits = (opts.categories ?? {})[cat] ?? [];
          sock.write(`* SEARCH${hits.map((h) => ` ${h}`).join('')}\r\n`); ok();
        } else if (upper.startsWith('UID SEARCH UID')) {
          const from = Number(/UID (\d+):\*/.exec(upper)?.[1] ?? 1);
          const hits = uids.filter((u) => u >= from);
          if (hits.length === 0 && uids.length) hits.push(uids[uids.length - 1]); // n:* quirk
          sock.write(`* SEARCH${hits.map((h) => ` ${h}`).join('')}\r\n`); ok();
        } else if (upper.startsWith('UID FETCH')) {
          const spec = /UID FETCH ([\d,:]+)/.exec(upper)?.[1] ?? '';
          const set = spec.includes(':')
            ? uids.filter((u) => u >= Number(spec.split(':')[0]) && u <= Number(spec.split(':')[1]))
            : spec.split(',').map(Number);
          set.forEach((uid, i) => {
            const hdr = `From: Sender ${uid} <s${uid}@example.com>\r\nSubject: Message ${uid}\r\nDate: Tue, 07 Oct 2026 08:0${i}:00 +0000\r\n\r\n`;
            const labels = opts.labels ?? (uid === 11 ? '("\\\\Sent")' : '("\\\\Inbox")');
            if (!/BODY\.PEEK/.test(upper) || opts.dropHeaders) {
              sock.write(`* ${i + 1} FETCH (X-GM-LABELS ${labels} UID ${uid})\r\n`);
              return;
            }
            sock.write(`* ${i + 1} FETCH (X-GM-MSGID ${1800000000000000000n + BigInt(uid)} X-GM-LABELS ${labels} UID ${uid} ` +
              `BODY[HEADER.FIELDS (FROM SUBJECT DATE)] {${Buffer.byteLength(hdr)}}\r\n${hdr})\r\n`);
            if (opts.unsolicitedFlags) sock.write(`* ${i + 1} FETCH (UID ${uid} FLAGS ())\r\n`);
          });
          ok();
        } else if (upper.startsWith('STATUS')) {
          sock.write('* STATUS "INBOX" (MESSAGES 100 UNSEEN 7)\r\n'); ok();
        } else if (upper === 'NOOP') {
          ok();
        } else if (upper === 'LOGOUT') {
          sock.write('* BYE\r\n'); ok(); sock.end();
        } else {
          sock.write(`${tag} BAD unexpected command\r\n`);
        }
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({ port, received, close: () => server.close() });
    });
  });
}

const READ_VERBS = /^(CAPABILITY|LOGIN|LIST|EXAMINE|STATUS|NOOP|LOGOUT|UID SEARCH|UID FETCH)\b/i;

test('ImapMailSource opens All Mail with EXAMINE and sends only read commands', async () => {
  const fake = await startFake({ categories: { promotions: [12] } });
  try {
    const src = new ImapMailSource('me@gmail.com', 'abcd efgh ijkl mnop', { host: '127.0.0.1', port: fake.port, tls: false });
    const opened = await src.open();
    assert.deepEqual(opened, { uidValidity: 555, mailbox: '[Gmail]/All Mail' });
    const uids = await src.uidsAfter(9);
    assert.deepEqual(uids, [10, 11, 12]);
    const metas = await src.describe(uids);
    assert.equal(metas.length, 3);
    assert.equal(metas[0].from, 'Sender 10 <s10@example.com>');
    assert.equal(metas[0].subject, 'Message 10');
    assert.equal(metas[2].category, 'promotions');
    assert.equal(metas[0].category, 'primary');
    assert.ok(isOutgoing(metas[1]));
    await src.close();

    // Every command the server saw is a read; the mailbox was EXAMINEd, never SELECTed; no body section.
    for (const c of fake.received) assert.match(c, READ_VERBS, c);
    assert.ok(fake.received.some((c) => c.startsWith('EXAMINE "[Gmail]/All Mail"')));
    assert.ok(!fake.received.some((c) => /^SELECT/i.test(c)));
    assert.ok(fake.received.filter((c) => /^UID FETCH/i.test(c)).every((c) => /BODY\.PEEK\[HEADER\.FIELDS/.test(c) && !/BODY\[/.test(c)));
    // Spaces in the app password are stripped before LOGIN.
    assert.ok(fake.received.some((c) => c === 'LOGIN "me@gmail.com" "abcdefghijklmnop"'));
  } finally {
    fake.close();
  }
});

test('the client masks the password in its own record of sent commands', async () => {
  const fake = await startFake();
  try {
    const client = new ReadOnlyImapClient({ host: '127.0.0.1', port: fake.port, tls: false });
    await client.connect();
    await client.login('me@gmail.com', 'secretpassword12');
    assert.ok(client.sent.every((c) => !c.includes('secretpassword12')));
    await client.logout();
  } finally {
    fake.close();
  }
});

test('a refused login is an ImapAuthError', async () => {
  const fake = await startFake({ loginOk: false });
  try {
    const src = new ImapMailSource('me@gmail.com', 'x', { host: '127.0.0.1', port: fake.port, tls: false });
    await assert.rejects(src.open(), ImapAuthError);
    await src.close();
  } finally {
    fake.close();
  }
});

test('a server that does not confirm READ-ONLY on EXAMINE is not trusted', async () => {
  const fake = await startFake({ readOnly: false });
  try {
    const src = new ImapMailSource('me@gmail.com', 'x', { host: '127.0.0.1', port: fake.port, tls: false });
    await assert.rejects(src.open(), /READ-ONLY/);
    await src.close();
  } finally {
    fake.close();
  }
});

test('a write command never reaches the socket', async () => {
  const fake = await startFake();
  try {
    const client = new ReadOnlyImapClient({ host: '127.0.0.1', port: fake.port, tls: false });
    try {
      await client.connect();
      await assert.rejects(client.command('UID STORE 1 +FLAGS (\\Seen)'), ImapWriteRefused);
      await assert.rejects(client.command('UID FETCH 1 (BODY[])'), ImapWriteRefused);
      await client.logout();
      assert.ok(!fake.received.some((c) => /STORE|BODY\[\]/i.test(c)));
    } finally {
      client.close();
    }
  } finally {
    fake.close();
  }
});

// ---------------------------------------------------------------------------
// The watcher, against an in-memory source
// ---------------------------------------------------------------------------

function meta(uid: number, extra: Partial<MailMeta> = {}): MailMeta {
  return { uid, msgId: String(1800000000000000000n + BigInt(uid)), labels: ['\\Inbox'], category: 'primary',
    from: `s${uid}@example.com`, subject: `Message ${uid}`, date: new Date('2026-10-07T08:00:00Z'), ...extra };
}

class MemorySource implements MailSource {
  uidValidity = 1;
  messages: MailMeta[] = [];
  opens = 0;
  async open() { this.opens++; return { uidValidity: this.uidValidity, mailbox: '[Gmail]/All Mail' }; }
  async ping() {}
  async uidsAfter(after: number) { return this.messages.map((m) => m.uid).filter((u) => u > after).sort((a, b) => a - b); }
  async describe(uids: number[]) { return this.messages.filter((m) => uids.includes(m.uid)); }
  async classify(uids: number[]) {
    return new Map(this.messages.filter((m) => uids.includes(m.uid)).map((m) => [m.uid, { labels: m.labels, category: m.category }] as const));
  }
  async search(_q: string): Promise<number[]> { return []; }
  async close() {}
}

function harness(source: MemorySource, opts: Partial<{ maxPerPoll: number; exclude: string[] }> = {}) {
  let state: GmailWatchState | null = null;
  const lines: string[] = [];
  const make = () => new GmailWatcher(
    { maxText: 200, json: false, timeZone: 'UTC', maxPerPoll: opts.maxPerPoll ?? 20, maxBacklog: 2000, excludeCategories: (opts.exclude ?? []) as never },
    { source, loadState: () => state, saveState: (s) => { state = s; }, emit: async (l) => { lines.push(...l); } },
  );
  return { make, lines, state: () => state };
}

test('first run records a baseline and prints nothing; new mail is reported once', async () => {
  const src = new MemorySource();
  src.messages = [meta(1), meta(2)];
  const h = harness(src);
  const w = h.make();
  await w.tick();
  assert.deepEqual(h.lines, []);
  assert.equal(h.state()?.lastUid, 2);

  src.messages.push(meta(3, { subject: 'Hello' }));
  await w.tick();
  assert.equal(h.lines.length, 1);
  assert.match(h.lines[0], /^\[mail\] 08:00 primary s3@example\.com: Hello https:\/\/mail\.google\.com\/mail\/u\/0\/#all\//);
  await w.tick();
  assert.equal(h.lines.length, 1);
});

test('a restarted watcher reports what arrived while it was down', async () => {
  const src = new MemorySource();
  src.messages = [meta(1)];
  const h = harness(src);
  await h.make().tick();
  src.messages.push(meta(2), meta(3));
  await h.make().tick(); // a new process, same saved state
  assert.equal(h.lines.length, 2);
});

test('his own sent mail and drafts are not reported; excluded categories are dropped', async () => {
  const src = new MemorySource();
  const h = harness(src, { exclude: ['promotions'] });
  const w = h.make();
  await w.tick();
  src.messages.push(meta(1, { labels: ['\\Sent'] }), meta(2, { labels: ['\\Draft'] }), meta(3, { category: 'promotions' }), meta(4));
  await w.tick();
  assert.equal(h.lines.length, 1);
  assert.match(h.lines[0], /s4@example\.com/);
});

test('the flood cap prints at most N lines plus one summary, and reads no headers past the cap', async () => {
  const src = new MemorySource();
  const described: number[] = [];
  const orig = src.describe.bind(src);
  src.describe = async (uids) => { described.push(...uids); return orig(uids); };
  const h = harness(src, { maxPerPoll: 3 });
  const w = h.make();
  await w.tick();
  for (let i = 1; i <= 10; i++) src.messages.push(meta(i));
  await w.tick();
  assert.equal(h.lines.length, 4);
  assert.match(h.lines[3], /^\[mail\] \+7 more/);
  assert.deepEqual(described, [1, 2, 3]);
  assert.equal(h.state()?.lastUid, 10);
});

test('a renumbered mailbox (UIDVALIDITY change) re-baselines with one line and no backlog', async () => {
  const src = new MemorySource();
  src.messages = [meta(1), meta(2)];
  const h = harness(src);
  await h.make().tick();
  src.uidValidity = 2;
  src.messages = [meta(1), meta(2), meta(3)];
  await h.make().tick();
  assert.equal(h.lines.length, 1);
  assert.match(h.lines[0], /renumbered/);
  assert.equal(h.state()?.uidValidity, 2);
});

// ---------------------------------------------------------------------------
// Formatting and counting
// ---------------------------------------------------------------------------

test('formatMail folds, truncates and links; JSON carries no body', () => {
  const m = meta(5, { subject: 'a\r\nb  c', from: 'X <x@y>' });
  assert.equal(formatMail(m, { maxText: 200, json: false, timeZone: 'UTC' }),
    `[mail] 08:00 primary X <x@y>: a b c ${messageUrl(m.msgId)}`);
  const j = JSON.parse(formatMail(m, { maxText: 3, json: true }));
  assert.equal(j.subject, 'a b… [+2 chars]');
  assert.deepEqual(Object.keys(j).sort(), ['account', 'category', 'from', 'id', 'labels', 'subject', 'time', 'uid', 'url']);
  assert.equal(messageUrl('1803000000000000001'), `https://mail.google.com/mail/u/0/#all/${(1803000000000000001n).toString(16)}`);
});

test('dayBoundaries are local midnights in the zone, oldest first, ending tomorrow', () => {
  const b = dayBoundaries(2, new Date('2026-10-07T08:00:00Z'), 'Asia/Tashkent');
  assert.deepEqual(b.map((d) => d.toISOString()), ['2026-10-05T19:00:00.000Z', '2026-10-06T19:00:00.000Z', '2026-10-07T19:00:00.000Z']);
});

test('countByDay searches with epoch-second bounds and spam/sent excluded', async () => {
  const queries: string[] = [];
  const src = new MemorySource();
  src.search = async (q: string) => { queries.push(q); return q.includes('category:updates') ? [1, 2] : q.includes('category:') ? [] : [1, 2, 3]; };
  const rows = await countByDay(src, 1, new Date('2026-10-07T08:00:00Z'), 'Asia/Tashkent');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].day, '2026-10-07');
  assert.equal(rows[0].total, 3);
  assert.equal(rows[0].categories.updates, 2);
  // Primary is searched as category:personal; category:primary returns nothing over IMAP.
  assert.ok(queries.some((q) => q.endsWith('category:personal')));
  assert.ok(!queries.some((q) => q.includes('category:primary')));
  assert.ok(queries.every((q) => q.includes('-in:spam') && q.includes('-in:sent') && q.includes('after:')));
  assert.ok(queries[0].includes(`after:${Date.parse('2026-10-06T19:00:00Z') / 1000} before:${Date.parse('2026-10-07T19:00:00Z') / 1000}`));
});

test('every line names its mailbox and links into that account', () => {
  const m = meta(6);
  const line = formatMail(m, { maxText: 200, json: false, timeZone: 'UTC', account: 'a@x.com' });
  assert.ok(line.startsWith('[mail a@x.com] 08:00 primary '));
  assert.ok(line.endsWith(`https://mail.google.com/mail/u/a%40x.com/#all/${BigInt(m.msgId!).toString(16)}`));
  assert.equal(mailTag(), '[mail]');
  assert.equal(mailTag('a@x.com', '📬 personal'), '[📬 personal]');
  assert.ok(formatMail(m, { maxText: 200, json: false, timeZone: 'UTC', account: 'a@x.com', label: '🏢 workspace' }).startsWith('[🏢 workspace] 08:00 '));
  assert.equal(JSON.parse(formatMail(m, { maxText: 200, json: true, account: 'a@x.com', label: 'L' })).account, 'a@x.com');
  assert.equal(JSON.parse(formatMail(m, { maxText: 200, json: true, account: 'a@x.com' })).account, 'a@x.com');
});

test('the watcher\'s own notices name the mailbox too', async () => {
  const src = new MemorySource();
  let state: GmailWatchState | null = null;
  const lines: string[] = [];
  const w = new GmailWatcher(
    { maxText: 200, json: false, timeZone: 'UTC', maxPerPoll: 1, maxBacklog: 2000, excludeCategories: [], account: 'b@y.com' },
    { source: src, loadState: () => state, saveState: (s) => { state = s; }, emit: async (l) => { lines.push(...l); } },
  );
  await w.tick();
  src.messages.push(meta(1), meta(2));
  await w.tick();
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => l.startsWith('[mail b@y.com] ')));
});

function gmailFromSecrets(secrets: unknown) {
  const saved = process.env.CLAUDE_TOOLS_CONFIG_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-config-test-'));
  process.env.CLAUDE_TOOLS_CONFIG_DIR = dir;
  try {
    fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify(secrets));
    return loadConfig().gmail;
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_TOOLS_CONFIG_DIR; else process.env.CLAUDE_TOOLS_CONFIG_DIR = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('gmail config reads the accounts list, the flat legacy form, and drops incomplete entries', () => {
  assert.deepEqual(gmailFromSecrets({}), []);
  assert.deepEqual(gmailFromSecrets({ gmail: { accounts: [{ user: 'a@x', appPassword: 'p1' }, { user: 'b@y', appPassword: 'p2' }] } }),
    [{ user: 'a@x', appPassword: 'p1' }, { user: 'b@y', appPassword: 'p2' }]);
  assert.deepEqual(gmailFromSecrets({ gmail: { user: 'c@z', appPassword: 'p3' } }), [{ user: 'c@z', appPassword: 'p3' }]);
  assert.deepEqual(gmailFromSecrets({ gmail: { accounts: [{ user: 'a@x' }, { appPassword: 'p' }, { user: 'b@y', appPassword: 'p2' }] } }),
    [{ user: 'b@y', appPassword: 'p2' }]);
});

// ---------------------------------------------------------------------------
// Regressions for the Codex audit of e359a16 (one test per finding)
// ---------------------------------------------------------------------------

test('audit 1 (High): a CR or LF can never smuggle a second command past the guard', async () => {
  for (const c of ['NOOP\r\nW1 SELECT "INBOX"', 'NOOP\nW2 UID STORE 1 +FLAGS (\\Seen)', 'UID SEARCH ALL\r', 'NOOP\x00']) {
    assert.throws(() => assertReadOnly(c), ImapWriteRefused, JSON.stringify(c));
  }
  const fake = await startFake();
  const client = new ReadOnlyImapClient({ host: '127.0.0.1', port: fake.port, tls: false });
  try {
    await client.connect();
    await assert.rejects(client.command('NOOP\r\nW1 SELECT "INBOX"\r\nW2 UID STORE 1 +FLAGS (\\Seen)'), ImapWriteRefused);
    await client.noop();
    assert.ok(!fake.received.some((c) => /SELECT|STORE/i.test(c)), fake.received.join(' | '));
  } finally {
    client.close();
    fake.close();
  }
});

test('audit 2: EXAMINE must answer with the [READ-ONLY] response code, not just mention it', async () => {
  const fake = await startFake({ examineText: '[READ-WRITE] not READ-ONLY' });
  try {
    const src = new ImapMailSource('me@gmail.com', 'x', { host: '127.0.0.1', port: fake.port, tls: false });
    await assert.rejects(src.open(), /READ-ONLY/);
    await src.close();
  } finally {
    fake.close();
  }
});

test('audit 3: a raw LOGIN through command() is masked in the record too', async () => {
  const fake = await startFake();
  const client = new ReadOnlyImapClient({ host: '127.0.0.1', port: fake.port, tls: false });
  try {
    await client.connect();
    await client.command('LOGIN "me@gmail.com" "abcdefghijklmnop"');
    assert.ok(client.sent.every((c) => !c.includes('abcdefghijklmnop')), client.sent.join(' | '));
  } finally {
    client.close();
    fake.close();
  }
});

test('audit 4: an unquoted label containing "[" does not swallow the rest of the response', () => {
  const hdr = 'Subject: x\r\n';
  const raw = Buffer.from(`* 1 FETCH (X-GM-LABELS (project[2026 Work) UID 9 BODY[HEADER.FIELDS (SUBJECT)] {${hdr.length}}\r\n${hdr})`);
  const list = parseValues(raw, 2)[2] as unknown[];
  assert.deepEqual(list[1], ['project[2026', 'Work']);
  assert.equal(list[2], 'UID');
  assert.equal(list[3], '9');
  assert.equal(list[4], 'BODY[HEADER.FIELDS (SUBJECT)]');
});

test('audit 5: an unsolicited flags-only FETCH does not replace the fetched headers', async () => {
  const fake = await startFake({ unsolicitedFlags: true });
  try {
    const src = new ImapMailSource('me@gmail.com', 'x', { host: '127.0.0.1', port: fake.port, tls: false });
    await src.open();
    const metas = await src.describe([10, 12]);
    assert.deepEqual(metas.map((m) => m.subject), ['Message 10', 'Message 12']);
    await src.close();
  } finally {
    fake.close();
  }
});

test('audit 6: a login refused with BYE [AUTHENTICATIONFAILED] is an auth error, not a retryable one', async () => {
  const fake = await startFake({ loginBye: true });
  try {
    const src = new ImapMailSource('me@gmail.com', 'x', { host: '127.0.0.1', port: fake.port, tls: false });
    await assert.rejects(src.open(), ImapAuthError);
    await src.close();
  } finally {
    fake.close();
  }
});

test('audit 7: free text ending in {n} on a tagged line is not a literal', () => {
  const { responses, rest } = splitResponses(Buffer.from('R2 OK finished {12}\r\n* 3 EXISTS\r\n'));
  assert.deepEqual(responses.map(String), ['R2 OK finished {12}', '* 3 EXISTS']);
  assert.equal(rest.length, 0);
});

test('audit 8: sent mail and excluded categories neither take a place under the cap nor count as overflow', async () => {
  const src = new MemorySource();
  const h = harness(src, { maxPerPoll: 1, exclude: ['promotions'] });
  const w = h.make();
  await w.tick();
  src.messages.push(meta(1, { labels: ['\\Sent'] }), meta(2, { category: 'promotions' }), meta(3));
  await w.tick();
  assert.deepEqual(h.lines.length, 1, h.lines.join('\n'));
  assert.match(h.lines[0], /s3@example\.com/);
  assert.equal(w.takeReportedCount(), 1);

  src.messages.push(meta(4, { labels: ['\\Sent'] }), meta(5, { labels: ['\\Sent'] }));
  await w.tick();
  assert.equal(h.lines.length, 1, 'only his own mail arrived: nothing to report, no "+N more"');
  assert.equal(h.state()?.lastUid, 5);
});

test('audit 5: a message present without its headers fails the cycle instead of being skipped', async () => {
  const fake = await startFake({ dropHeaders: true });
  try {
    const src = new ImapMailSource('me@gmail.com', 'x', { host: '127.0.0.1', port: fake.port, tls: false });
    await src.open();
    const classes = await src.classify([10, 11, 12]);
    assert.equal(classes.get(11)?.labels[0], '\\Sent');
    await assert.rejects(src.describe([10]), /no headers for UID 10/);
    await src.close();
  } finally {
    fake.close();
  }
});

test('audit 9: a saved position from another account re-baselines instead of being reused', async () => {
  const src = new MemorySource();
  src.messages = [meta(1), meta(2)];
  let state: GmailWatchState | null = { account: 'old@x.com', mailbox: '[Gmail]/All Mail', uidValidity: 1, lastUid: 999 };
  const lines: string[] = [];
  const w = new GmailWatcher(
    { maxText: 200, json: false, timeZone: 'UTC', maxPerPoll: 20, maxBacklog: 2000, excludeCategories: [], account: 'new@y.com' },
    { source: src, loadState: () => state, saveState: (s) => { state = s; }, emit: async (l) => { lines.push(...l); } },
  );
  await w.tick();
  assert.equal(state!.account, 'new@y.com');
  assert.equal(state!.lastUid, 2);
  assert.match(lines[0], /^\[mail new@y\.com\] the saved position belonged to another account/);
  src.messages.push(meta(3));
  await w.tick();
  assert.equal(lines.length, 2);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-state-'));
  const f = path.join(dir, 'state.json');
  fs.writeFileSync(f, JSON.stringify({ account: 'a@b', mailbox: 'm', uidValidity: 1, lastUid: 2 }));
  assert.equal(loadGmailWatchState(f)?.account, 'a@b');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('audit 10: in JSON mode every line the watcher prints is JSON', async () => {
  const src = new MemorySource();
  let state: GmailWatchState | null = null;
  const lines: string[] = [];
  const w = new GmailWatcher(
    { maxText: 200, json: true, maxPerPoll: 1, maxBacklog: 2000, excludeCategories: [], account: 'j@x.com' },
    { source: src, loadState: () => state, saveState: (s) => { state = s; }, emit: async (l) => { lines.push(...l); } },
  );
  await w.tick();
  src.messages.push(meta(1), meta(2));
  await w.tick();
  src.uidValidity = 7;
  await w.reset();
  await w.tick();
  assert.equal(lines.length, 3);
  for (const l of lines) assert.doesNotThrow(() => JSON.parse(l), l);
  assert.deepEqual(JSON.parse(formatNotice('alive', { account: 'j@x.com', json: true })), { account: 'j@x.com', notice: 'alive' });
});

test('audit 11: day boundaries stay on local midnight across a DST change', () => {
  // Berlin moved to summer time on 2026-03-29: that day is 23 hours long.
  const b = dayBoundaries(2, new Date('2026-03-29T12:00:00Z'), 'Europe/Berlin');
  assert.deepEqual(b.map((d) => d.toISOString()), ['2026-03-27T23:00:00.000Z', '2026-03-28T23:00:00.000Z', '2026-03-29T22:00:00.000Z']);
});

test('audit 11: count rows are labelled with their own local date across a DST change', async () => {
  const src = new MemorySource();
  src.search = async () => [];
  const rows = await countByDay(src, 2, new Date('2026-03-29T12:00:00Z'), 'Europe/Berlin');
  assert.deepEqual(rows.map((r) => r.day), ['2026-03-28', '2026-03-29']);
});

// ---------------------------------------------------------------------------
// Regressions for Codex audit round 2 (on 425feb4)
// ---------------------------------------------------------------------------

test('r2-1: FETCH is a positive grammar - BINARY[], BODY[] and unknown items are refused', () => {
  for (const c of [
    'UID FETCH 1 (BINARY[1])', 'UID FETCH 1 (BINARY.SIZE[1])', 'UID FETCH 1 (BODY[HEADER])', 'UID FETCH 1 (BODYSTRUCTURE)',
    'UID FETCH 1 (X-UNKNOWN)', 'UID FETCH 1 (UID) (BODY[])', 'UID FETCH 1 UID', 'UID FETCH 1 (BODY.PEEK[TEXT])', 'UID FETCH 1 (BODY.PEEK[1])',
  ]) assert.throws(() => assertReadOnly(c), ImapWriteRefused, c);
  for (const c of [
    'UID FETCH 1:5 (UID X-GM-LABELS)', 'UID FETCH 1,2 (UID FLAGS)', 'UID FETCH 1 (BODY.PEEK[HEADER])',
    'UID FETCH 1 (UID X-GM-MSGID X-GM-LABELS BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])',
  ]) assert.doesNotThrow(() => assertReadOnly(c), c);
});

test('r2-2: any LOGIN, even malformed, is recorded without its arguments', async () => {
  const fake = await startFake();
  const client = new ReadOnlyImapClient({ host: '127.0.0.1', port: fake.port, tls: false });
  try {
    await client.connect();
    await client.command('LOGIN "me@example.com""abcdefghijklmnop"');
    assert.deepEqual(client.sent, ['LOGIN [REDACTED]']);
  } finally {
    client.close();
    fake.close();
  }
});

test('r2-3: a label that starts with BODY[ inside the label list does not swallow UID', () => {
  const hdr = 'Subject: x\r\n';
  const raw = Buffer.from(`* 1 FETCH (X-GM-LABELS (BODY[2026 BINARY[work) UID 9 BODY[HEADER.FIELDS (SUBJECT)] {${hdr.length}}\r\n${hdr})`);
  const list = parseValues(raw, 2)[2] as unknown[];
  assert.deepEqual(list[1], ['BODY[2026', 'BINARY[work']);
  assert.deepEqual(list.slice(2, 5), ['UID', '9', 'BODY[HEADER.FIELDS (SUBJECT)]']);
});

test('r2-4: a BYE [AUTHENTICATIONFAILED] greeting is an auth error, and a BYE fails the pending command at once', async () => {
  const greet = net.createServer((sock) => { sock.write('* BYE [AUTHENTICATIONFAILED] Invalid credentials\r\n'); });
  await new Promise<void>((r) => greet.listen(0, '127.0.0.1', () => r()));
  try {
    const client = new ReadOnlyImapClient({ host: '127.0.0.1', port: (greet.address() as net.AddressInfo).port, tls: false });
    await assert.rejects(client.connect(), ImapAuthError);
    client.close();
  } finally {
    greet.close();
  }

  // BYE then silence (no close): the pending LOGIN must fail now, not after the timeout.
  const lazy = net.createServer((sock) => {
    sock.write('* OK ready\r\n');
    sock.on('data', () => sock.write('* BYE [AUTHENTICATIONFAILED] Invalid credentials\r\n'));
  });
  await new Promise<void>((r) => lazy.listen(0, '127.0.0.1', () => r()));
  try {
    const client = new ReadOnlyImapClient({ host: '127.0.0.1', port: (lazy.address() as net.AddressInfo).port, tls: false, timeoutMs: 20_000 });
    await client.connect();
    const t0 = Date.now();
    await assert.rejects(client.login('me@x', 'p'), ImapAuthError);
    assert.ok(Date.now() - t0 < 5_000, 'failed at the BYE, not at the timeout');
    client.close();
  } finally {
    lazy.close();
  }
});

test('r2-5: free text ending in {n} on an untagged status response is not a literal', () => {
  const { responses } = splitResponses(Buffer.from('* OK maintenance notice {12}\r\n* BYE [AUTHENTICATIONFAILED] Invalid {3}\r\nR1 OK x\r\n'));
  assert.deepEqual(responses.map(String), ['* OK maintenance notice {12}', '* BYE [AUTHENTICATIONFAILED] Invalid {3}', 'R1 OK x']);
});

test('r2-6: a huge backlog reports a count and moves on; uidRange never spreads arguments', async () => {
  const big = Array.from({ length: 300_000 }, (_, i) => i + 1);
  assert.equal(uidRange(big), '1:300000');

  const src = new MemorySource();
  let classified = 0;
  src.classify = async (uids: number[]) => { classified += uids.length; return new Map(); };
  const h = harness(src);
  const w = h.make();
  await w.tick();
  for (let i = 1; i <= 2500; i++) src.messages.push(meta(i));
  await w.tick();
  assert.equal(classified, 0);
  assert.equal(h.lines.length, 1);
  assert.match(h.lines[0], /2500 new messages since the last check, more than 2000; not listed/);
  assert.equal(h.state()?.lastUid, 2500);
});

test('r2-7: a message re-categorised between classify and describe is still excluded', async () => {
  const src = new MemorySource();
  const h = harness(src, { exclude: ['promotions'] });
  const w = h.make();
  await w.tick();
  src.messages.push(meta(1));
  src.describe = async (uids) => src.messages.filter((m) => uids.includes(m.uid)).map((m) => ({ ...m, category: 'promotions' as const }));
  await w.tick();
  assert.deepEqual(h.lines, []);
  assert.equal(h.state()?.lastUid, 1);
});

test('r2-8: duplicate accounts (legacy + list, any case) collapse to one entry, the list winning', () => {
  assert.deepEqual(
    gmailFromSecrets({ gmail: { user: 'A@x.com', appPassword: 'legacy', accounts: [{ user: 'a@x.com', appPassword: 'list' }, { user: ' a@X.com ', appPassword: 'dup' }] } }),
    [{ user: 'a@x.com', appPassword: 'list' }]);
});

test('r2-9: default state names differ for addresses that safeName would merge', () => {
  assert.notEqual(accountStateName("o'brien@example.com"), accountStateName('o_brien@example.com'));
  assert.equal(accountStateName('A@x.com'), accountStateName('a@x.com'));
});

test('r2-10: a day whose midnight does not exist starts at its first real instant, on that day', () => {
  // São Paulo, 2018-11-04: clocks went from 23:59:59 (-03) straight to 01:00 (-02).
  assert.equal(new Date(localMidnight('2018-11-04', 'America/Sao_Paulo')).toISOString(), '2018-11-04T03:00:00.000Z');
  assert.equal(new Date(localMidnight('2018-11-03', 'America/Sao_Paulo')).toISOString(), '2018-11-03T03:00:00.000Z');
  assert.equal(new Date(localMidnight('2026-10-07', 'Asia/Tashkent')).toISOString(), '2026-10-06T19:00:00.000Z');
});

test('scrubPasswords removes each configured password, raw and space-stripped', async () => {
  const { scrubPasswords } = await import('../commands/gmail/index.js');
  const out = scrubPasswords('NO [x] abcd efgh ijkl mnop / abcdefghijklmnop / other', [{ user: 'u', appPassword: 'abcd efgh ijkl mnop' }]);
  assert.equal(out, 'NO [x] [redacted] / [redacted] / other');
});

// ---------------------------------------------------------------------------
// Regressions for Codex audit round 3 (on 8029c07)
// ---------------------------------------------------------------------------

test('r3-1: passwords are scrubbed before truncation and before JSON escaping', () => {
  const scrub = makeScrubber(['ab"cdefgh\\ijklmn']);
  const m = meta(7, { subject: `xxxx ab"cdefgh\\ijklmn yyyy` });
  const plain = formatMail(m, { maxText: 12, json: false, timeZone: 'UTC', scrub });
  assert.ok(!plain.includes('ab"cdef'), plain);
  const j = formatMail(m, { maxText: 200, json: true, scrub });
  assert.ok(!j.includes('cdefgh'), j);
  assert.ok(!formatNotice('NO ab"cdefgh\\ijklmn', { json: true, scrub }).includes('cdefgh'));
});

test('r3-2: the process scrubber keeps a password after the secrets file changes', async () => {
  const { scrubPasswords } = await import('../commands/gmail/index.js');
  const saved = process.env.CLAUDE_TOOLS_CONFIG_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-scrub-'));
  process.env.CLAUDE_TOOLS_CONFIG_DIR = dir;
  try {
    fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify({ gmail: { accounts: [{ user: 'a@x', appPassword: 'firstpassword123' }] } }));
    assert.equal(scrubPasswords('e firstpassword123'), 'e [redacted]');
    fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify({ gmail: { accounts: [{ user: 'a@x', appPassword: 'secondpassword45' }] } }));
    assert.equal(scrubPasswords('e firstpassword123'), 'e [redacted]');
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_TOOLS_CONFIG_DIR; else process.env.CLAUDE_TOOLS_CONFIG_DIR = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('r3-3: a BYE in answer to LOGIN is an auth error whatever its wording', async () => {
  const srv = net.createServer((sock) => {
    sock.write('* OK ready\r\n');
    sock.on('data', () => sock.write('* BYE [ALERT] Application-specific password required\r\n'));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  try {
    const client = new ReadOnlyImapClient({ host: '127.0.0.1', port: (srv.address() as net.AddressInfo).port, tls: false });
    await client.connect();
    await assert.rejects(client.login('me@x', 'p'), ImapAuthError);
    client.close();
  } finally {
    srv.close();
  }
});

test('r3-4: the default state carries over the pre-hash file of the same account', () => {
  const saved = process.env.CLAUDE_TOOLS_CONFIG_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-migrate-'));
  process.env.CLAUDE_TOOLS_CONFIG_DIR = dir;
  try {
    const legacy = gmailWatchStatePath('Me@x.com');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, JSON.stringify({ mailbox: 'm', uidValidity: 1, lastUid: 100 }));
    const p = defaultStatePath('Me@x.com');
    assert.notEqual(p, legacy);
    assert.equal(loadGmailWatchState(p)?.lastUid, 100);

    // Another account's legacy file is not adopted.
    const other = gmailWatchStatePath('b@y.com');
    fs.mkdirSync(path.dirname(other), { recursive: true });
    fs.writeFileSync(other, JSON.stringify({ account: 'c@z.com', mailbox: 'm', uidValidity: 1, lastUid: 7 }));
    assert.equal(loadGmailWatchState(defaultStatePath('b@y.com')), null);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_TOOLS_CONFIG_DIR; else process.env.CLAUDE_TOOLS_CONFIG_DIR = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('r3-5: a change of capitalisation alone keeps the saved position', async () => {
  const src = new MemorySource();
  src.messages = [meta(1)];
  let state: GmailWatchState | null = { account: 'Me@X.com', mailbox: '[Gmail]/All Mail', uidValidity: 1, lastUid: 1 };
  const lines: string[] = [];
  const w = new GmailWatcher(
    { maxText: 200, json: false, timeZone: 'UTC', maxPerPoll: 20, maxBacklog: 2000, excludeCategories: [], account: 'me@x.com' },
    { source: src, loadState: () => state, saveState: (s) => { state = s; }, emit: async (l) => { lines.push(...l); } },
  );
  src.messages.push(meta(2));
  await w.tick();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /s2@example\.com/);
});

test('r3-6: a connection closed before any greeting fails connect() at once', async () => {
  const srv = net.createServer((sock) => sock.end());
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  try {
    const client = new ReadOnlyImapClient({ host: '127.0.0.1', port: (srv.address() as net.AddressInfo).port, tls: false, timeoutMs: 20_000 });
    const t0 = Date.now();
    await assert.rejects(client.connect(), /closed/);
    assert.ok(Date.now() - t0 < 5_000);
  } finally {
    srv.close();
  }
});

test('r3-7: a skipped calendar date keeps its own label and an empty interval', async () => {
  const src = new MemorySource();
  src.search = async () => [];
  const rows = await countByDay(src, 3, new Date('2012-01-01T00:00:00Z'), 'Pacific/Apia');
  assert.deepEqual(rows.map((r) => r.day), ['2011-12-30', '2011-12-31', '2012-01-01']);

  const b = dayBoundaries(3, new Date('2012-01-01T00:00:00Z'), 'Pacific/Apia');
  for (let i = 1; i < b.length; i++) assert.ok(b[i].getTime() >= b[i - 1].getTime());
});

test('r2-11: check counts a missing FLAGS answer as unknown, never as unread', () => {
  const f = (flags: unknown) => new Map([['FLAGS', flags as never]]);
  assert.equal(countSeen([1, 2], new Map([[1, f([])], [2, f(['\\Seen'])]])), 1);
  assert.equal(countSeen([1, 2], new Map([[1, f([])]])), null);
  assert.equal(countSeen([1], new Map([[1, new Map()]])), null);
});

// ---------------------------------------------------------------------------
// Regressions for Codex audit round 4 (on 2fbbc2c)
// ---------------------------------------------------------------------------

test('r4-1: day boundaries use the next calendar date, not +24h, on both DST changes', async () => {
  // Spring: 2026-03-28 23:30 in Berlin is the day before the clocks go forward.
  const spring = dayBoundaries(1, new Date('2026-03-28T22:30:00Z'), 'Europe/Berlin');
  assert.deepEqual(spring.map((d) => d.toISOString()), ['2026-03-27T23:00:00.000Z', '2026-03-28T23:00:00.000Z']);
  // Autumn: 2026-10-25 is 25 hours long in Berlin.
  const autumn = dayBoundaries(1, new Date('2026-10-24T22:30:00Z'), 'Europe/Berlin');
  assert.deepEqual(autumn.map((d) => d.toISOString()), ['2026-10-24T22:00:00.000Z', '2026-10-25T23:00:00.000Z']);

  const src = new MemorySource();
  src.search = async () => [];
  assert.deepEqual((await countByDay(src, 1, new Date('2026-03-28T22:30:00Z'), 'Europe/Berlin')).map((r) => r.day), ['2026-03-28']);
  assert.deepEqual((await countByDay(src, 1, new Date('2026-10-24T22:30:00Z'), 'Europe/Berlin')).map((r) => r.day), ['2026-10-25']);
});

test('r4-2: the command fixes its scrubber from the accounts it selected, before any rotation', async () => {
  const { scrubPasswords, selectAccounts, resetScrubberForTests } = await import('../commands/gmail/index.js');
  const saved = process.env.CLAUDE_TOOLS_CONFIG_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-scrub2-'));
  process.env.CLAUDE_TOOLS_CONFIG_DIR = dir;
  try {
    resetScrubberForTests();
    fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify({ gmail: { accounts: [{ user: 'a@x', appPassword: 'passwordinuse123' }] } }));
    const accounts = selectAccounts();
    assert.equal(accounts[0].appPassword, 'passwordinuse123');
    // Rotated while the command runs; the first scrub happens only now, in an error path.
    fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify({ gmail: { accounts: [{ user: 'a@x', appPassword: 'rotatedpassword9' }] } }));
    assert.equal(scrubPasswords('NO passwordinuse123'), 'NO [redacted]');
  } finally {
    resetScrubberForTests();
    if (saved === undefined) delete process.env.CLAUDE_TOOLS_CONFIG_DIR; else process.env.CLAUDE_TOOLS_CONFIG_DIR = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('r4-3: migration is one-time and a reset can never fall back to the legacy checkpoint', () => {
  const saved = process.env.CLAUDE_TOOLS_CONFIG_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-reset-'));
  process.env.CLAUDE_TOOLS_CONFIG_DIR = dir;
  try {
    const legacy = gmailWatchStatePath('me@x.com');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, JSON.stringify({ mailbox: 'm', uidValidity: 1, lastUid: 100 }));
    const p = defaultStatePath('me@x.com');
    assert.equal(loadGmailWatchState(p)?.lastUid, 100);
    assert.ok(!fs.existsSync(legacy), 'the legacy file is retired after one migration');

    // A legacy file reappearing (or never migrated) is retired by a reset, and nothing comes back.
    fs.writeFileSync(legacy, JSON.stringify({ mailbox: 'm', uidValidity: 1, lastUid: 50 }));
    defaultStatePath('me@x.com', { reset: true });
    assert.ok(!fs.existsSync(p));
    assert.ok(!fs.existsSync(legacy));
    assert.equal(loadGmailWatchState(defaultStatePath('me@x.com')), null);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_TOOLS_CONFIG_DIR; else process.env.CLAUDE_TOOLS_CONFIG_DIR = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('r5-1: a reset never retires another account\'s legacy checkpoint at a colliding path', () => {
  const saved = process.env.CLAUDE_TOOLS_CONFIG_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-reset2-'));
  process.env.CLAUDE_TOOLS_CONFIG_DIR = dir;
  try {
    // o'brien@ and o_brien@ share the pre-hash path; the file there is o_brien's.
    const shared = gmailWatchStatePath("o'brien@example.com");
    assert.equal(shared, gmailWatchStatePath('o_brien@example.com'));
    fs.mkdirSync(path.dirname(shared), { recursive: true });
    fs.writeFileSync(shared, JSON.stringify({ account: 'o_brien@example.com', mailbox: 'm', uidValidity: 1, lastUid: 42 }));
    defaultStatePath("o'brien@example.com", { reset: true });
    assert.ok(fs.existsSync(shared), "o'brien's reset left o_brien's file alone");
    assert.equal(loadGmailWatchState(defaultStatePath('o_brien@example.com'))?.lastUid, 42);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_TOOLS_CONFIG_DIR; else process.env.CLAUDE_TOOLS_CONFIG_DIR = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
