import '../services/telegram-schema.js'; // must precede the telegram package
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Api } from 'telegram';
import {
  parseWhen,
  formatToFlags,
  tashkentLabel,
  expandTimeTokensForRich,
  prepareRichMarkdown,
  extractTimeTokens,
  locateDates,
  hasTimeTokens,
  richMessageToMarkdown,
  messageText,
  exportedText,
} from '../services/telegram-rich.js';
import { SCHEMA_LAYER } from '../services/telegram-schema.js';

const require = createRequire(import.meta.url);
const R = Api as any;

// 2026-09-26 18:00 Tashkent = 13:00 UTC
const SEP26_1800 = Date.UTC(2026, 8, 26, 13, 0) / 1000;

test('schema: GramJS announces layer 229 and knows the rich constructors', () => {
  assert.equal(SCHEMA_LAYER, 229);
  assert.equal(require('telegram/tl/AllTLObjects.js').LAYER, 229);
  assert.equal(typeof R.InputRichMessageMarkdown, 'function');
  assert.equal(typeof R.MessageEntityFormattedDate, 'function');
});

test('schema: messages.sendMessage serializes rich_message with the layer-229 constructor', () => {
  const request = new R.messages.SendMessage({
    peer: new Api.InputPeerSelf(),
    message: '',
    randomId: BigInt(1) as any,
    richMessage: new R.InputRichMessageMarkdown({ markdown: '| a |\n|---|\n| 1 |' }),
  });
  const bytes: Buffer = request.getBytes();
  assert.equal(bytes.readUInt32LE(0), 0xfef48f62);
  assert.equal(bytes.readUInt32LE(4) & (1 << 23), 1 << 23, 'rich_message flag set');
  assert.ok(bytes.includes(Buffer.from('| a |')));
});

test('schema: communities look like channels, their dialogs like folders', async () => {
  const { utils } = await import('telegram');
  const community = new R.Community({ id: BigInt(42) as any, accessHash: BigInt(7) as any, title: 'Team', photo: new Api.ChatPhotoEmpty(), date: 0 });
  assert.ok(community instanceof Api.Channel);
  assert.equal(utils.getPeerId(community), '-10042');

  const dialog = new R.DialogCommunity({ communityId: BigInt(42) as any, notifySettings: new Api.PeerNotifySettings({}) });
  assert.ok(dialog instanceof Api.DialogFolder, 'getDialogs skips folders');
  assert.equal(utils.getPeerId(dialog.peer), '-10042');
});

test('schema: importing it after the telegram package fails loudly', () => {
  const schema = fileURLToPath(new URL('../services/telegram-schema.js', import.meta.url));
  const script = `await import('telegram'); await import(${JSON.stringify('file:///' + schema.replace(/\\/g, '/'))});`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', cwd: process.cwd() });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /must be imported before the telegram package/);
});

test('parseWhen: bare times are Tashkent, offsets and unix are honoured', () => {
  assert.equal(parseWhen('2026-09-26 18:00'), SEP26_1800);
  assert.equal(parseWhen('2026-09-26T18:00'), SEP26_1800);
  assert.equal(parseWhen('2026-09-26T13:00Z'), SEP26_1800);
  assert.equal(parseWhen('2026-09-26T08:00-05:00'), SEP26_1800);
  assert.equal(parseWhen(String(SEP26_1800)), SEP26_1800);
  assert.equal(parseWhen('2026-09-26'), Date.UTC(2026, 8, 25, 19, 0) / 1000);
  assert.throws(() => parseWhen('tomorrow'), /Invalid time/);
  assert.throws(() => parseWhen('2026-13-40 99:00'), /Invalid time/);
});

test('formatToFlags: maps Telegram format letters and rejects others', () => {
  assert.deepEqual(formatToFlags('r'), { relative: true, dayOfWeek: undefined, shortDate: undefined, longDate: undefined, shortTime: undefined, longTime: undefined });
  const wDt = formatToFlags('wDt');
  assert.equal(wDt.dayOfWeek, true);
  assert.equal(wDt.longDate, true);
  assert.equal(wDt.shortTime, true);
  assert.equal(wDt.shortDate, undefined);
  assert.throws(() => formatToFlags('rw'), /Invalid time format/);
  assert.throws(() => formatToFlags('tD'), /Invalid time format/);
});

test('tashkentLabel: reads as the team clock', () => {
  assert.equal(tashkentLabel(SEP26_1800), 'Sat 26 Sep 18:00 Tashkent');
});

test('rich: tokens become tg://time links', () => {
  assert.equal(
    expandTimeTokensForRich('Deploy {{time:2026-09-26 18:00}} and {{time:2026-09-26 18:00|r|soon}}'),
    `Deploy ![Sat 26 Sep 18:00 Tashkent](tg://time?unix=${SEP26_1800}&format=wDt) and ![soon](tg://time?unix=${SEP26_1800}&format=r)`,
  );
  assert.equal(expandTimeTokensForRich('no tokens | here'), 'no tokens | here');
});

test('plain: tokens become labels, located in the parsed text in order', () => {
  const { text, dates } = extractTimeTokens('A {{time:2026-09-26 18:00|t|18:00}} then B {{time:2026-09-26 18:00|t|18:00}}');
  assert.equal(text, 'A 18:00 then B 18:00');
  const located = locateDates('A 18:00 then B 18:00', dates);
  assert.deepEqual(located.map((d) => d.offset), [2, 15]);
  assert.ok(located.every((d) => d.length === 5 && d.unix === SEP26_1800));
  assert.equal(hasTimeTokens('x {{time:1790000000}}'), true);
  assert.equal(hasTimeTokens('x {time:1}'), false);
});

test('plain: offsets are UTF-16, like Telegram', () => {
  const { dates } = extractTimeTokens('{{time:2026-09-26 18:00|t|18:00}}');
  assert.equal(locateDates('🚀 deploy 18:00', dates)[0].offset, 10);
});

// A rich message as GramJS decodes it (the shape of message #579241 in the prototype).
const plain = (text: string) => ({ className: 'TextPlain', text });
const cell = (text: string, header = false) => ({ className: 'PageTableCell', header, text: plain(text) });
const richFixture = {
  className: 'RichMessage',
  blocks: [
    { className: 'PageBlockHeading2', text: plain('Status') },
    { className: 'PageBlockParagraph', text: { className: 'TextConcat', texts: [plain('Deploy '), { className: 'TextBold', text: plain('done') }, plain(' at '), { className: 'TextDate', text: plain('18:00'), date: SEP26_1800 }] } },
    {
      className: 'PageBlockTable',
      title: { className: 'TextEmpty' },
      rows: [
        { className: 'PageTableRow', cells: [cell('Service', true), cell('State', true)] },
        { className: 'PageTableRow', cells: [cell('backend'), cell('ok | fast')] },
      ],
    },
    {
      className: 'PageBlockList',
      items: [
        { className: 'PageListItemText', checkbox: true, checked: true, text: plain('table') },
        { className: 'PageListItemText', checkbox: true, text: plain('checklist') },
      ],
    },
    { className: 'PageBlockDetails', title: plain('More'), blocks: [{ className: 'PageBlockPreformatted', language: 'sh', text: plain('npm test') }] },
  ],
};

test('read: rich messages render back to markdown', () => {
  assert.equal(richMessageToMarkdown(richFixture), [
    '## Status',
    'Deploy **done** at 18:00',
    '| Service | State |\n| --- | --- |\n| backend | ok \\| fast |',
    '- [x] table\n- [ ] checklist',
    '▸ More\n```sh\nnpm test\n```',
  ].join('\n\n'));
});

test('read: messageText prefers plain text and falls back to rich content', () => {
  assert.equal(messageText({ message: 'hi', richMessage: richFixture }), 'hi');
  assert.match(messageText({ message: '', richMessage: richFixture }), /^## Status/);
  assert.equal(messageText({ message: '' }), '');
  assert.equal(messageText(undefined), '');
});

test('export: a rich message is exported as its markdown, and an empty text always says why it is empty', () => {
  assert.deepEqual(exportedText({ message: 'hi', richMessage: richFixture }), { text: 'hi', textFormat: 'plain' });
  // A rich send leaves `message` empty and keeps the body in the block tree: the export must read it.
  const rich = exportedText({ message: '', richMessage: richFixture });
  assert.equal(rich.textFormat, 'rich-markdown');
  assert.match(rich.text, /^## Status/);
  // Rich content this path cannot render is NOT a blank message.
  assert.deepEqual(exportedText({ message: '', richMessage: { className: 'RichMessage', blocks: [] } }), { text: '', textFormat: 'rich-unreadable' });
  assert.deepEqual(exportedText({ message: '', richMessage: { className: 'RichMessage' } }), { text: '', textFormat: 'rich-unreadable' });
  assert.deepEqual(exportedText({ message: '' }), { text: '', textFormat: 'none' });
  assert.deepEqual(exportedText(undefined), { text: '', textFormat: 'none' });
});

test('rich: a hashtag at the start of a line is escaped so it stays a hashtag', () => {
  assert.equal(prepareRichMarkdown('#task'), '\\#task');
  assert.equal(prepareRichMarkdown('text\n\n#issue'), 'text\n\n\\#issue');
  assert.equal(prepareRichMarkdown('  #pr done'), '  \\#pr done');
  assert.equal(prepareRichMarkdown('#задача'), '\\#задача');
});

test('rich: real headings and inline hashtags are left alone', () => {
  for (const s of ['# Title', '## Title', '###### Deep', '#', 'Tags: #task', 'see PROJ-1 #4308']) {
    assert.equal(prepareRichMarkdown(s), s);
  }
});

test('rich: a single newline inside a paragraph becomes a hard break', () => {
  assert.equal(prepareRichMarkdown('Assignee: @a\ncc: @b\n#task'), 'Assignee: @a\\\ncc: @b\\\n\\#task');
  assert.equal(prepareRichMarkdown('one\ntwo\n\nthree'), 'one\\\ntwo\n\nthree');
});

test('rich: existing hard breaks are not doubled', () => {
  assert.equal(prepareRichMarkdown('one  \ntwo'), 'one  \ntwo');
  assert.equal(prepareRichMarkdown('one\\\ntwo'), 'one\\\ntwo');
});

test('rich: tables, lists, headings, quotes, dividers and html are untouched', () => {
  for (const s of [
    '| a | b |\n|---|---|\n| 1 | 2 |',
    '- one\n- two\n- [ ] three',
    '1. one\n2. two',
    '## Title\ntext',
    'text\n## Title',
    '> quote\n> more',
    'text\n---\nmore',
    '<details><summary>T</summary>\nbody\n</details>',
    'text\n- item',
  ]) {
    assert.equal(prepareRichMarkdown(s), s);
  }
});

test('rich: fenced code is passed through verbatim, hashes and newlines included', () => {
  const code = '```bash\n#!/bin/sh\n#comment\necho a\necho b\n```';
  assert.equal(prepareRichMarkdown(code), code);
  assert.equal(prepareRichMarkdown(`before\n\n${code}\n\n#task`), `before\n\n${code}\n\n\\#task`);
});

test('rich: time tokens still expand after preparation', () => {
  const out = expandTimeTokensForRich(prepareRichMarkdown('Deploy {{time:2026-09-26 18:00}}\n#task'));
  assert.match(out, /tg:\/\/time\?unix=/);
  assert.match(out, /\\#task$/);
});
