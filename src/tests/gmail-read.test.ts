import test from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'net';

import { ImapWriteRefused, assertReadOnly, parseValues } from '../services/imap-readonly.js';
import { ImapMailSource } from '../services/gmail-watch.js';
import { decodeQuotedPrintable, htmlToText, parseMail, parseParams } from '../services/mail-mime.js';
import { formatListed, formatRead, listSearch, parseMessageRef, shortId } from '../services/gmail-read.js';

// ---------------------------------------------------------------------------
// The guard: the whole message only as a PEEK
// ---------------------------------------------------------------------------

test('assertReadOnly accepts the whole message only as BODY.PEEK[], optionally capped from 0', () => {
  for (const c of [
    'UID FETCH 7 (BODY.PEEK[])',
    'UID FETCH 7 (UID RFC822.SIZE BODY.PEEK[]<0.5000000>)',
    'uid fetch 7 (body.peek[]<0.1>)',
    'UID FETCH 1,2 (UID X-GM-MSGID X-GM-LABELS FLAGS RFC822.SIZE BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])',
  ]) assert.doesNotThrow(() => assertReadOnly(c), c);
});

test('assertReadOnly still refuses every non-PEEK or unknown body section', () => {
  for (const c of [
    'UID FETCH 7 (BODY[])', 'UID FETCH 7 (BODY[]<0.100>)', 'UID FETCH 7 (BODY.PEEK[TEXT])', 'UID FETCH 7 (BODY.PEEK[1])',
    'UID FETCH 7 (BODY.PEEK[]<5.100>)', 'UID FETCH 7 (BODY.PEEK[]<0.0>)', 'UID FETCH 7 (BODY.PEEK[]X)',
    'UID FETCH 7 (BODY.PEEK[] BODY[])', 'UID FETCH 7 (BINARY.PEEK[])', 'UID FETCH 7 (RFC822)',
    'UID FETCH 7 (BODY.PEEK[]<0.100> RFC822.TEXT)',
  ]) assert.throws(() => assertReadOnly(c), ImapWriteRefused, c);
});

test('parseValues with rawLiterals keeps the bytes of a non-UTF-8 literal', () => {
  const body = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]); // "Привет" in windows-1251
  const raw = Buffer.concat([Buffer.from(`* 1 FETCH (UID 7 BODY[]<0> {${body.length}}\r\n`), body, Buffer.from(')')]);
  const v = parseValues(raw, 2, true)[2] as string[];
  assert.equal(v[2], 'BODY[]<0>');
  assert.deepEqual(Buffer.from(v[3], 'latin1'), body);
  // The default still decodes as UTF-8, which is what destroys these bytes.
  assert.notDeepEqual(Buffer.from((parseValues(raw, 2)[2] as string[])[3], 'latin1'), body);
});

// ---------------------------------------------------------------------------
// MIME
// ---------------------------------------------------------------------------

const crlf = (s: string) => s.replace(/\r?\n/g, '\r\n');

test('multipart/alternative prefers text/plain and decodes quoted-printable', () => {
  const raw = Buffer.from(crlf(`From: A <a@x.com>
Subject: =?UTF-8?B?0J/RgNC40LLQtdGC?=
Content-Type: multipart/alternative; boundary="b1"

--b1
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: quoted-printable

Caf=C3=A9 au lait, a long line that is soft=
 wrapped.
--b1
Content-Type: text/html; charset=utf-8

<p>HTML version</p>
--b1--
`));
  const m = parseMail(raw);
  assert.equal(m.headers.subject, 'Привет');
  assert.equal(m.text, 'Café au lait, a long line that is soft wrapped.');
  assert.equal(m.fromHtml, false);
  assert.equal(m.truncated, false);
  assert.deepEqual(m.attachments, []);
});

test('HTML-only mail becomes text with its links, no script, no style, no preheader padding', () => {
  const raw = Buffer.from(crlf(`Content-Type: text/html; charset="windows-1251"
Content-Transfer-Encoding: base64

${Buffer.concat([
    Buffer.from('<html><head><style>p{color:red}</style></head><body><div style="display:none">&zwnj;&#8203;&zwnj;</div><p>'),
    Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]),
    Buffer.from(' &amp; <a href="https://x.com/a?b=1&amp;c=2">open</a><br>line&nbsp;two</p><script>alert(1)</script>'),
    Buffer.from('<a href="mailto:me@x.com">me@x.com</a></body></html>'),
  ]).toString('base64')}
`));
  const m = parseMail(raw);
  assert.equal(m.fromHtml, true);
  assert.equal(m.text, 'Привет & open [https://x.com/a?b=1&c=2]\nline two\nme@x.com');
});

test('attachments are listed by name and size, RFC 2231 names decoded, and never become text', () => {
  const pdf = Buffer.alloc(3000, 1).toString('base64').replace(/(.{76})/g, '$1\r\n');
  const raw = Buffer.from(crlf(`Content-Type: multipart/mixed; boundary=outer

preamble
--outer
Content-Type: multipart/alternative; boundary="inner"

--inner
Content-Type: text/plain

Body text.
--inner--
--outer
Content-Type: application/pdf
Content-Disposition: attachment; filename*=utf-8''%D0%A1%D1%87%D1%91%D1%82.pdf
Content-Transfer-Encoding: base64

${pdf}
--outer
Content-Type: text/plain; name="notes.txt"
Content-Disposition: attachment

not the body
--outer
Content-Type: message/rfc822

Subject: Forwarded thing
From: b@x.com

inner body
--outer--
`));
  const m = parseMail(raw);
  assert.equal(m.text, 'Body text.');
  assert.deepEqual(m.attachments.map((a) => [a.filename, a.contentType, a.truncated]), [
    ['Счёт.pdf', 'application/pdf', false],
    ['notes.txt', 'text/plain', false],
    ['Forwarded thing.eml', 'message/rfc822', false],
  ]);
  assert.equal(m.attachments[0].size, 3000);
});

test('a message cut by the fetch cap is flagged, and so is the attachment it stopped in', () => {
  const raw = Buffer.from(crlf(`Content-Type: multipart/mixed; boundary=z

--z
Content-Type: text/plain

Hello.
--z
Content-Type: image/png
Content-Disposition: attachment; filename="big.png"
Content-Transfer-Encoding: base64

iVBORw0KGgoAAAANSUhEUgAA`));
  const m = parseMail(raw, { truncated: true });
  assert.equal(m.text, 'Hello.');
  assert.equal(m.truncated, true);
  assert.equal(m.attachments[0].filename, 'big.png');
  assert.equal(m.attachments[0].truncated, true);
});

test('parseParams handles quotes, semicolons inside quotes and RFC 2231 continuations', () => {
  assert.deepEqual(parseParams('Text/Plain; charset="utf-8"; name="a; b.txt"'), {
    value: 'text/plain', params: { charset: 'utf-8', name: 'a; b.txt' },
  });
  assert.equal(parseParams(`attachment; filename*0*=utf-8''%D0%90; filename*1=bc.txt`).params.filename, 'Аbc.txt');
});

test('quoted-printable decoding and plain-text tidying', () => {
  assert.equal(decodeQuotedPrintable(Buffer.from('a=3Db=\r\nc')).toString(), 'a=bc');
  const m = parseMail(Buffer.from('Content-Type: text/plain\r\n\r\nline one   \r\n\r\n\r\n\r\nline\u200b two\r\n'));
  assert.equal(m.text, 'line one\n\nline two');
});

test('htmlToText keeps a link whose text is its address only once', () => {
  assert.equal(htmlToText('<a href="https://a.com">https://a.com</a> <a href="#top">top</a>'), 'https://a.com top');
});

// ---------------------------------------------------------------------------
// Search, ids, output
// ---------------------------------------------------------------------------

test('listSearch excludes spam, trash and his own mail unless asked, and narrows by each option', () => {
  assert.equal(listSearch({}), '-in:spam -in:trash -in:chats -in:sent -in:drafts');
  assert.equal(
    listSearch({ days: 2, from: 'github.com', unread: true, category: 'primary', includeSent: true, query: ' has:attachment ' }),
    '-in:spam -in:trash -in:chats newer_than:2d from:(github.com) is:unread category:personal has:attachment',
  );
});

test('parseMessageRef takes the hex id, the decimal id, or a Gmail link with its mailbox', () => {
  const dec = '1880466469271926015';
  const hex = shortId(dec)!;
  assert.equal(hex, '1a18c24a68fc74ff');
  assert.deepEqual(parseMessageRef(hex), { msgId: dec, account: undefined });
  assert.deepEqual(parseMessageRef(dec), { msgId: dec, account: undefined });
  assert.deepEqual(parseMessageRef(`https://mail.google.com/mail/u/me%40gmail.com/#all/${hex}`), { msgId: dec, account: 'me@gmail.com' });
  assert.deepEqual(parseMessageRef(`https://mail.google.com/mail/u/0/#label/Work/${hex}`), { msgId: dec, account: undefined });
  assert.ok('error' in parseMessageRef('https://mail.google.com/mail/u/0/#inbox/FMfcgzQXJWDsKNbHfwPLMWxBHlfBnNqg'));
  assert.ok('error' in parseMessageRef('not-an-id'));
});

test('formatRead scrubs the app password from the text and cuts it at --max-chars', () => {
  const mail = parseMail(Buffer.from('From: x@y.com\r\nSubject: s\r\nContent-Type: text/plain\r\n\r\nkey abcdefghijklmnop then a long tail'));
  const out = formatRead(mail, {
    account: 'me@gmail.com', msgId: '1880466469271926015', labels: ['\\Inbox'], unread: true, size: 100,
    maxChars: 20, json: false, scrub: (t) => t.split('abcdefghijklmnop').join('[redacted]'),
  });
  assert.match(out, /^From: {5}x@y\.com$/m);
  assert.match(out, /^Status: {3}unread \(reading it did not change that\)$/m);
  assert.match(out, /key \[redacted\] then ?… \[\+\d+ chars\]/);
  assert.ok(!out.includes('abcdefghijklmnop'));
});

test('formatListed prints the id gmail read takes, and a dot for unread', () => {
  const line = formatListed({
    uid: 5, msgId: '1880466469271926015', labels: [], category: 'primary', from: 'A <a@x.com>', subject: 'Hi',
    date: new Date('2026-10-13T10:00:00Z'), unread: true, size: 10,
  }, { account: 'me@gmail.com', maxText: 50, json: false, timeZone: 'Asia/Tashkent', scrub: (t) => t });
  assert.equal(line, '1a18c24a68fc74ff  Oct 13 15:00  • primary    A <a@x.com>: Hi');
});

// ---------------------------------------------------------------------------
// The read path against a fake server: only read commands, the body only as a PEEK
// ---------------------------------------------------------------------------

function startFake(message: Buffer): Promise<{ port: number; received: string[]; close: () => void }> {
  const received: string[] = [];
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
        const ok = () => sock.write(`${tag} OK Success\r\n`);
        if (upper.startsWith('LOGIN') || upper === 'NOOP') ok();
        else if (upper === 'CAPABILITY') { sock.write('* CAPABILITY IMAP4rev1 X-GM-EXT-1\r\n'); ok(); }
        else if (upper.startsWith('LIST')) { sock.write('* LIST (\\All \\HasNoChildren) "/" "[Gmail]/All Mail"\r\n'); ok(); }
        else if (upper.startsWith('EXAMINE')) { sock.write('* 1 EXISTS\r\n* OK [UIDVALIDITY 9] ok\r\n'); sock.write(`${tag} OK [READ-ONLY] done\r\n`); }
        else if (upper.startsWith('UID SEARCH X-GM-MSGID')) { sock.write(upper.endsWith(' 1880466469271926015') ? '* SEARCH 42\r\n' : '* SEARCH\r\n'); ok(); }
        else if (upper.startsWith('UID SEARCH')) { sock.write('* SEARCH\r\n'); ok(); }
        else if (upper.startsWith('UID FETCH 42 (UID RFC822.SIZE BODY.PEEK[]<0.')) {
          const cap = Number(/<0\.(\d+)>/.exec(upper)![1]);
          const part = message.subarray(0, cap);
          sock.write(Buffer.concat([Buffer.from(`* 1 FETCH (UID 42 RFC822.SIZE ${message.length} BODY[]<0> {${part.length}}\r\n`), part, Buffer.from(')\r\n')]));
          ok();
        } else if (upper.startsWith('UID FETCH 42 (')) {
          const hdr = 'From: A <a@x.com>\r\nSubject: S\r\n\r\n';
          sock.write(`* 1 FETCH (UID 42 X-GM-MSGID 1880466469271926015 X-GM-LABELS ("\\\\Inbox") FLAGS () RFC822.SIZE ${message.length} ` +
            `BODY[HEADER.FIELDS (FROM SUBJECT DATE)] {${hdr.length}}\r\n${hdr})\r\n`);
          ok();
        } else if (upper === 'LOGOUT') { sock.write('* BYE\r\n'); ok(); sock.end(); }
        else sock.write(`${tag} BAD unexpected\r\n`);
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ port: (server.address() as net.AddressInfo).port, received, close: () => server.close() });
  }));
}

test('the read path finds the message by its Gmail id and fetches it only with BODY.PEEK[]', async () => {
  const message = Buffer.concat([
    Buffer.from('From: A <a@x.com>\r\nSubject: S\r\nContent-Type: text/plain; charset=windows-1251\r\n\r\n'),
    Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]),
  ]);
  const fake = await startFake(message);
  try {
    const src = new ImapMailSource('me@gmail.com', 'abcd efgh ijkl mnop', { host: '127.0.0.1', port: fake.port, tls: false });
    await src.open();
    assert.equal(await src.findByGmailId('1'), null);
    const uid = await src.findByGmailId('1880466469271926015');
    assert.equal(uid, 42);
    const [meta] = await src.summarize([42]);
    assert.equal(meta.unread, true);
    assert.equal(meta.subject, 'S');
    const whole = await src.fetchRaw(42, 1_000_000);
    assert.equal(whole?.truncated, false);
    assert.equal(parseMail(whole!.raw).text, 'Привет');
    const cut = await src.fetchRaw(42, 20);
    assert.equal(cut?.truncated, true);
    assert.equal(cut?.raw.length, 20);
    await src.close();

    const fetches = fake.received.filter((c) => /^UID FETCH/i.test(c));
    assert.ok(fetches.length > 0);
    for (const c of fake.received) assert.doesNotThrow(() => assertReadOnly(c === 'LOGIN [REDACTED]' ? 'LOGIN' : c), c);
    assert.ok(fetches.every((c) => !/BODY\[/i.test(c)), 'no non-PEEK body section');
    assert.ok(!fake.received.some((c) => /^SELECT/i.test(c)));
  } finally {
    fake.close();
  }
});

test('findByGmailId refuses anything but a decimal id before it reaches the server', async () => {
  const src = new ImapMailSource('me@gmail.com', 'x');
  await assert.rejects(src.findByGmailId('1 OR ALL'), /not a Gmail message id/);
});

test('terminal control sequences in a mail never reach the terminal output; JSON keeps its own escaping', () => {
  const mail = parseMail(Buffer.from(
    'From: =?UTF-8?Q?Evil=1B[2J?= <e@x.com>\r\nSubject: hi\x1b]52;c;aGk=\x07\r\nContent-Type: text/plain\r\n' +
    'Content-Transfer-Encoding: quoted-printable\r\n\r\nbody=1B]52;c;cHduZWQ=3D=07 end\tok\r\n'));
  const base = { account: 'me@gmail.com', msgId: '1880466469271926015', labels: [], unread: false, size: 1, maxChars: 1000, scrub: (t: string) => t };
  const out = formatRead(mail, { ...base, json: false });
  assert.ok(!/[\x1b\x07]/.test(out), JSON.stringify(out));
  assert.match(out, /body\]52;c;cHduZWQ= end\tok/);
  const json = JSON.parse(formatRead(mail, { ...base, json: true }));
  assert.match(json.text, /\x1b/);
  const line = formatListed({ uid: 1, msgId: null, labels: [], category: 'primary', from: 'a\x1b[31m', subject: 's\x9b2J', date: null, unread: false, size: 1 },
    { account: 'me@gmail.com', maxText: 50, json: false, scrub: (t) => t });
  assert.ok(!/[\x1b\x9b]/.test(line), JSON.stringify(line));
});

test('an RFC 2231 file name wins over its plain fallback', () => {
  assert.equal(parseParams(`attachment; filename="fallback.pdf"; filename*=UTF-8''r%C3%A9port.pdf`).params.filename, 'réport.pdf');
  assert.equal(parseParams(`attachment; filename*0*=UTF-8''r%C3%A9; filename="fb.pdf"; filename*1=port.pdf`).params.filename, 'réport.pdf');
  assert.equal(parseParams('attachment; filename="a.pdf"; filename="b.pdf"').params.filename, 'a.pdf');
});

test('an attached multipart is one attachment, and its text is not the body', () => {
  const raw = Buffer.from(crlf(`Content-Type: multipart/mixed; boundary=o

--o
Content-Type: text/plain

Real body.
--o
Content-Type: multipart/alternative; boundary=i
Content-Disposition: attachment; filename="bundle"

--i
Content-Type: text/plain

attached text
--i--
--o--
`));
  const m = parseMail(raw);
  assert.equal(m.text, 'Real body.');
  assert.deepEqual(m.attachments.map((a) => [a.filename, a.contentType]), [['bundle', 'multipart/alternative']]);
});

test('a quoted-printable attachment is sized after decoding', () => {
  const raw = Buffer.from(crlf(`Content-Type: multipart/mixed; boundary=o

--o
Content-Type: application/octet-stream; name="q.bin"
Content-Transfer-Encoding: quoted-printable

=FF=FF=FF=FF=FF=FF
--o--
`));
  assert.equal(parseMail(raw).attachments[0].size, 6);
});

test('an attachment name with an encoded newline stays on its own line', () => {
  const raw = Buffer.from(crlf(`Content-Type: multipart/mixed; boundary=o

--o
Content-Type: text/plain

Body.
--o
Content-Type: application/pdf
Content-Disposition: attachment; filename*=utf-8''a.pdf%0ASubject:%20forged

x
--o--
`));
  const out = formatRead(parseMail(raw), {
    account: 'me@gmail.com', msgId: '1', labels: [], unread: false, size: 1, maxChars: 100, json: false, scrub: (t) => t,
  });
  assert.ok(!/^Subject: {2}forged/m.test(out), out);
  assert.match(out, /^Attached: a\.pdf Subject: forged \(application\/pdf/m);
});

test('a blank text/plain alternative falls back to the HTML one', () => {
  const raw = Buffer.from(crlf(`Content-Type: multipart/alternative; boundary=a

--a
Content-Type: text/plain

  
--a
Content-Type: text/html

<p>The real text</p>
--a--
`));
  const m = parseMail(raw);
  assert.equal(m.text, 'The real text');
  assert.equal(m.fromHtml, true);
});

test('a complete fetch of a message missing its closing boundary is not called truncated', () => {
  const raw = Buffer.from(crlf(`Content-Type: multipart/mixed; boundary=z

--z
Content-Type: text/plain

Hello.
--z
Content-Type: image/png; name="p.png"
Content-Transfer-Encoding: base64

iVBORw0KGgo=
`));
  const m = parseMail(raw);
  assert.equal(m.truncated, false);
  assert.equal(m.attachments[0].truncated, false);
  assert.equal(m.text, 'Hello.');
});
