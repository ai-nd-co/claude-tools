import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  checkMessageFormat,
  countSentences,
  findBareHashes,
  findBareIds,
  findShorthand,
  FORMAT_EXAMPLE,
  FORMAT_REFUSED_EXIT_CODE,
  FORMAT_RULES,
  formatRefusal,
  graphemes,
  gateMessage,
  markdownAsLiteral,
  hasInlineNumbering,
  MAX_MESSAGE_CHARS,
  openingTitle,
  parseFormatOverride,
  stripExempt,
  visibleLength,
} from '../services/message-format.js';
import { accountSendsRich } from '../commands/telegram/format-gate.js';

const rules = (body: string) => checkMessageFormat(body).refusals.map((r) => r.rule);
const warns = (body: string) => checkMessageFormat(body).warnings.map((w) => w.rule);
/** n words of 6 characters each ("word0 word1 …"), about 6n visible characters with spaces. */
const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i % 10}`).join(' ');
const para = (title: string, n = 20) => `**${title}.** ${words(n)}.`;

// --- a well-formed message passes ---------------------------------------------------------

test('the printed example passes its own check with no warnings', () => {
  const report = checkMessageFormat(FORMAT_EXAMPLE);
  assert.ok(report.visibleChars > 250, 'long enough that every rule applies to it');
  assert.deepEqual(report.refusals, []);
  assert.deepEqual(report.warnings, []);
});

test('titled blocks with short paragraphs and bullets pass', () => {
  const body = [para('Result'), `${para('Details', 10)} Covered:\n- ${words(8)}\n- ${words(8)}`, para('Next', 10), '#claude'].join('\n\n');
  assert.deepEqual(rules(body), []);
});

// --- 1. length ------------------------------------------------------------------------------

test('over 800 visible characters is refused, however well shaped', () => {
  const body = Array.from({ length: 8 }, (_, i) => para(`Block ${i}`, 16)).join('\n\n');
  assert.ok(visibleLength(body) > MAX_MESSAGE_CHARS);
  assert.deepEqual(rules(body), ['length']);
  assert.match(checkMessageFormat(body).refusals[0].message, /at most 3 messages by meaning, conclusion first, each titled "1\/2 · …".*\.md file/);
});

test('code, tables and quotes count toward length; URLs and markup do not', () => {
  const code = '```\n' + words(140) + '\n```';
  assert.deepEqual(rules(`**Log.**\n\n${code}`), ['length'], 'a fence is exempt from shape, not from length');
  const table = `**Table.**\n\n| a | b |\n|---|---|\n${Array.from({ length: 30 }, () => `| ${words(3)} | ${words(2)} |`).join('\n')}`;
  assert.deepEqual(rules(table), ['length']);
  const link = `[short label](https://example.com/${'x'.repeat(2000)})`;
  assert.equal(visibleLength(link), 'short label'.length);
  assert.equal(visibleLength('**bold** and `code`'), 'bold and code'.length);
});

test('an HTML anchor counts its label; emoji count as one character each (Codex review)', () => {
  assert.equal(visibleLength(`<a href="https://example.com/${'x'.repeat(50)}">${'label '.repeat(5).trim()}</a>`), 29);
  assert.deepEqual(rules(`<b>Long.</b>\n\n<a href="https://example.com">${words(140)}</a>`).includes('length'), true);
  const family = '👨‍👩‍👧‍👦';
  assert.equal(graphemes(family), 1);
  assert.equal(visibleLength(family.repeat(700)), 700);
  assert.ok(!rules(`**Family.** ${family.repeat(700)}`).includes('length'));
  assert.ok(!rules(`**${family.repeat(70)}**\n\n${para('Body', 30)}`).includes('title'));
});

test('HTML bodies: <code>/<pre> are code, entities count as what they render (Codex review)', () => {
  assert.deepEqual(findBareIds('Fixed <code>PROJ-4393</code> and <pre>see #471</pre>.'), []);
  assert.deepEqual(rules('Fixed <code>PROJ-4393</code>.'), []);
  assert.equal(visibleLength('a &amp; b &lt;c&gt; &#8212; &#x2014; &quot;'), 'a & b <c> — — "'.length);
  assert.deepEqual(rules(`<b>Title.</b> ${'&amp;'.repeat(160)}`), [], '160 rendered characters, not 800');
  assert.deepEqual(rules(`<b>Log.</b> ${words(10)}.\n\n<pre>${words(45)}. A. B. C. D.</pre>`), [], '<pre> is exempt from shape');
});

test('an HTML <blockquote> is exempt from shape, like a markdown quote (Codex review)', () => {
  assert.deepEqual(rules(`<b>Quoted.</b> ${words(10)}.\n\n<blockquote>${words(45)}. A. B. C. D.</blockquote>`), []);
});

test('code keeps its literal markup in the length; escaped brackets stay inside a link label (Codex review)', () => {
  assert.equal(visibleLength('```\n<div></div>\n```'), '<div></div>'.length);
  assert.ok(rules(`**Log.**\n\n\`\`\`\n${'<div></div>'.repeat(90)}\n\`\`\``).includes('length'));
  assert.equal(visibleLength('Run `<b>x</b> https://a.b`'), 'Run <b>x</b> https://a.b'.length);
  assert.deepEqual(findBareIds('[PROJ-4393 — fix array\\[i\\]](https://example.com) done'), []);
  assert.equal(visibleLength('[fix \\[i\\]](https://example.com)'), 'fix [i]'.length);
  assert.deepEqual(findBareIds('[PROJ-4393 — fix [array]](https://example.com) done'), [], 'nested brackets');
  assert.deepEqual(findBareIds('Run ``code with ` and PROJ-4393`` now'), [], 'a double-backtick span');
  assert.equal(visibleLength('<code>https://example.com/abc</code>'), 'https://example.com/abc'.length, 'a URL in HTML code is shown');
  assert.ok(rules(`<b>Link.</b> <code>https://example.com/${'x'.repeat(900)}</code>`).includes('length'));
  assert.deepEqual(findBareIds('<pre>\n```\n</pre>\nPROJ-4393'), ['PROJ-4393'], 'a fence inside <pre> does not hide later prose');
  assert.deepEqual(findBareIds('Run this:\n\n    curl PROJ-4393\n\nDone.'), [], 'indented code');
  assert.equal(visibleLength('``a ` b``'), 'a ` b'.length);
  assert.deepEqual(findBareIds('```\n```not-a-close\nPROJ-4393\n```\nafter'), [], 'a fence closes only on a bare fence line');
  assert.equal(visibleLength('```\n<details><summary></summary>' + 'x'.repeat(900) + '</details>\n```') > 800, true, 'details inside a fence is literal');
});

test('a collapsed <details> counts only its summary', () => {
  const body = `**Run passed.** ${words(10)}.\n\n<details><summary>Full log</summary>\n\n${words(300)}\n\n</details>`;
  assert.deepEqual(rules(body), []);
});

// --- 2. paragraphs --------------------------------------------------------------------------

test('a prose paragraph over 300 visible characters is refused', () => {
  const body = `**Title.** ${words(30)}, ${words(25)}.`;
  assert.deepEqual(rules(body), ['paragraph']);
  assert.match(checkMessageFormat(body).refusals[0].message, /\d+ characters; at most 300/);
});

test('more than 3 sentences in a paragraph is refused; 3 warns', () => {
  const s = 'One plain fact here';
  assert.deepEqual(rules(`**Title.** ${s}. ${s}. ${s}. ${s}.\n\n${para('More', 30)}`), ['sentences']);
  const three = `**Title.** ${s}. ${s}. ${s}.\n\n${para('More', 35)}`;
  assert.deepEqual(rules(three), []);
  assert.deepEqual(warns(three), ['dense']);
  assert.deepEqual(rules(`**Why it broke.** ${s}. ${s}. ${s}.\n\n${para('More', 35)}`), [], 'the bold title is not a sentence');
});

test('lines with single newlines are one paragraph; blank lines separate blocks', () => {
  const lines = Array.from({ length: 6 }, (_, i) => `**L${i}.** ${words(8)}`);
  assert.deepEqual(rules(lines.join('\n')), ['paragraph']);
  assert.deepEqual(rules(lines.join('\n\n')), []);
});

// --- 3. bullets -----------------------------------------------------------------------------

test('a bullet over 200 characters is refused; many short bullets are not one paragraph', () => {
  const list = `**Findings.**\n${Array.from({ length: 10 }, () => `- ${words(10)}`).join('\n')}`;
  assert.deepEqual(rules(list), []);
  assert.deepEqual(rules(`**Findings.**\n- ${words(40)}\n- ${words(5)}`), ['bullet']);
  const numbered = `**Steps.**\n1) ${words(10)}\n2) ${words(10)}\n• ${words(10)}\n  continued ${words(3)}`;
  assert.deepEqual(rules(numbered), []);
});

// --- 4. inline numbering --------------------------------------------------------------------

test('numbered points run inline are refused, as (1) … (2) or 1) … 2)', () => {
  assert.deepEqual(rules(`**Two checks.** ${words(8)}: (1) the first point, (2) the second point. ${words(15)}\n\n${para('More', 12)}`), ['inline-list']);
  assert.deepEqual(rules(`**Two checks.** ${words(8)}: 1) the first point; 2) the second point. ${words(15)}\n\n${para('More', 12)}`), ['inline-list']);
  assert.ok(!hasInlineNumbering('Section 395.30(1) and App. A 4.3.2.3(2) are cited'), 'legal references are not a list');
  assert.ok(!hasInlineNumbering('Only (1) here'));
});

// --- 5. titles ------------------------------------------------------------------------------

test('a message over 250 characters must open with a bold title of at most 80 characters', () => {
  assert.deepEqual(rules(`${words(15)}.\n\n${words(30)}.`), ['title', 'block-title']);
  assert.deepEqual(rules(`**${words(15)}.**\n\n${para('Body', 30)}`), ['title']);
  assert.match(checkMessageFormat(`**${words(15)}.**\n\n${para('Body', 30)}`).refusals[0].message, /title is \d+ characters; at most 80/);
  assert.deepEqual(rules(`# Heading\n\n${words(45)}.`), [], 'a heading is a title, and titles the paragraph under it');
  assert.deepEqual(rules(`@someone **Title.** ${words(40)}.`), [], 'a leading mention is fine');
  assert.equal(openingTitle('[**#483 team driving**](https://x) — closed'), '#483 team driving');
});

test('every prose paragraph opens with a bold title; lists, tag lines and title-only lines are exempt', () => {
  const missing = `${para('Result', 25)}\n\n${words(20)} without a title.`;
  assert.deepEqual(rules(missing), ['block-title']);
  const refusal = checkMessageFormat(missing).refusals[0];
  assert.equal(refusal.excerpt!.length <= 60, true);
  assert.ok(refusal.excerpt!.startsWith('word0 word1'));
  assert.deepEqual(rules(`**Why it broke.**\n\n${words(25)}.\n\n${para('Fix', 10)}`), [], 'a title-only line titles the paragraph after it');
  assert.deepEqual(rules(`${para('Result', 20)}\n\n- ${words(8)}\n- ${words(8)}\n\n#claude #task @someone`), [], 'a list and a tag line need no title');
  assert.deepEqual(rules(`${para('Result', 20)}\n\nWriters covered:\n- ${words(8)}\n- ${words(8)}`), [], 'a short lead-in to a list belongs to it');
});

// --- exemptions -----------------------------------------------------------------------------

test('a short one-line closing such as "Reply A or B." needs no title; a longer or earlier one does', () => {
  const options = `**1. Which fix do we ship?** ${words(20)}.\n\n- **A (recommended):** ${words(6)}, so ${words(3)}\n- **B:** ${words(6)}, so ${words(3)}`;
  assert.deepEqual(rules(`${options}\n\nReply A or B.`), []);
  assert.deepEqual(warns(`${options}\n\nReply A or B.`), []);
  assert.deepEqual(rules(`${options}\n\nReply A or B.\n\n#claude`), [], 'a tag line after it does not change that');
  assert.deepEqual(rules(`${options}\n\n${words(12)}.`), ['block-title'], 'over 60 characters needs a title');
  assert.deepEqual(rules(`${para('Start', 30)}\n\nReply A or B.\n\n${para('End', 10)}`), ['block-title'], 'only the last block is exempt');
});

test('250 characters or less skips the shape rules; the length rule is the only one that always applies', () => {
  const short = 'One. Two. Three. Four. Five. Six: (1) a (2) b.';
  assert.deepEqual(rules(short), []);
  assert.ok(stripExempt('a\n```\nb\n```\nc').split('\n').filter(Boolean).join(',') === 'a,c');
});

test('fenced code, tables and quotes are not measured for shape', () => {
  const body = `**Result.** The run passed.\n\n\`\`\`\n${words(40)}. A. B. C. D.\n\`\`\`\n\n| a | b |\n|---|---|\n| ${words(4)} | x |\n\n> ${words(30)}. One. Two. Three. Four.`;
  assert.deepEqual(rules(body), []);
});

// --- sentences --------------------------------------------------------------------------------

test('the sentence splitter tolerates abbreviations, initials, versions, files, domains and ellipses', () => {
  const one = [
    'Tests, lint etc. Then deploy.',
    'Писатели: mobile, dashboard и т.д. Всё проверено.',
    'Ждём и т.п. Потом мерж.',
    'Иванов и др. Согласны.',
    'В 2026 г. Начнём.',
  ];
  for (const t of one) assert.equal(countSentences(t), 1, t);
  const two = [
    'Роли на месте, т.е. всё ок. Дальше деплой.',
    'Сделано, т.к. ревью прошло. Мерж.',
    'См. стр. 5 отчёта. Готово.',
    'Use e.g. this. Then stop.',
    'Done, i.e. merged. Next.',
    'Compare A vs. B today. Fine.',
    'Approx. 5 hours. Fine.',
    'А. Иванов проверил. Хорошо.',
    'Released v1.2.3 with a 0.5 ratio. Fine.',
    'Edited SKILL.md on api.github.com today. Fine.',
    'Wait... Then it worked. Ok… next one.',
  ];
  for (const t of two) assert.equal(countSentences(t), 2, t);
  assert.equal(countSentences('Is it done? Yes! Shipped.'), 3);
});

// --- references ----------------------------------------------------------------------------

test('bare PR numbers, #123 and ticket keys are refused at any length; links, code and hashtags are fine', () => {
  assert.deepEqual(findBareIds('Merged #484 and PR 122, see PROJ-4393 and NF-327.'), ['PR 122', '#484', 'PROJ-4393', 'NF-327']);
  assert.deepEqual(findBareIds('PR #325 is up'), ['PR #325'], 'reported once');
  assert.deepEqual(findBareIds('[backend #471 — fix](https://x/pull/471), `PROJ-1`, #claude #task'), []);
  assert.deepEqual(findBareIds('```\nPROJ-4393 #12\n```'), [], 'fenced code is fine');
  assert.deepEqual(findBareIds('UTF-8, SHA-256 and ISO-8601 are not tickets'), []);
  assert.deepEqual(findBareIds('Released GPT-5 today; AES-256 and COVID-19 and X-1 are not tickets either'), [], 'Codex review');
  assert.deepEqual(rules('Merged #484.'), ['bare-id']);
  const message = checkMessageFormat('See PROJ-4393.').refusals[0].message;
  assert.match(message, /"PROJ-4393"/);
  assert.match(message, /\[PROJ-4393 — title\]\(https:\/\/yourcompany\.atlassian\.net\/browse\/PROJ-4393\)/);
});

test('bare commit hashes only warn', () => {
  assert.deepEqual(findBareHashes('Checked a43fc799. Done.'), ['a43fc799']);
  assert.deepEqual(rules('Checked a43fc799.'), []);
  assert.deepEqual(warns('Checked a43fc799.'), ['bare-hash']);
});

// --- warnings -------------------------------------------------------------------------------

test('more than one question, status boards and P1/rule-7 shorthand warn', () => {
  assert.deepEqual(warns('Ready? Merge now?'), ['questions']);
  assert.deepEqual(warns('**1. Ready?**\n**2. Merge now?**'), [], 'numbered questions are the format');
  assert.deepEqual(warns('Ready?'), []);
  assert.deepEqual(warns('Run `a?b?c`.'), [], 'question marks in code do not count');
  assert.deepEqual(warns('✅ backend\n✅ mobile\n🔴 dashboard'), ['status-board']);
  assert.deepEqual(warns('✅ Done.'), []);
  assert.deepEqual(findShorthand('Two P1 and a P3, see rule-7 and rule7; HTTP2 is fine'), ['P1', 'P3', 'rule-7', 'rule7']);
  assert.deepEqual(warns('One P1 left.'), ['shorthand']);
});

// --- the refusal text and the override ------------------------------------------------------------

test('the refusal names the failure with numbers and prints every rule, the example and the override', () => {
  const text = formatRefusal(checkMessageFormat(`**Title.** ${words(60)}.`));
  assert.match(text, /A paragraph is \d+ characters; at most 300/);
  for (const rule of FORMAT_RULES) assert.ok(text.includes(rule), rule);
  assert.ok(text.includes('Plan the message as titled blocks first: each paragraph opens with a bold title (**Why it broke.**), then at most 3 sentences.'));
  assert.ok(text.includes(FORMAT_EXAMPLE));
  assert.match(text, /--format-ok "<why>"/);
  assert.match(text, new RegExp(`Exit status ${FORMAT_REFUSED_EXIT_CODE}: not sent`));
});

test('--format-ok needs a reason and skips the check', () => {
  const bad = 'Merged #484.';
  assert.equal(gateMessage(bad, undefined).send, false);
  const ok = gateMessage(bad, 'verbatim log');
  assert.equal(ok.send, true);
  assert.equal(ok.note, ' (format override: verbatim log)');
  assert.throws(() => parseFormatOverride('  '), /needs a reason/);
  assert.equal(gateMessage('Short and fine.', undefined).send, true);
});

test('account sends are rich unless --md2; --rich is a no-op; both together are refused', () => {
  assert.equal(accountSendsRich({}), true);
  assert.equal(accountSendsRich({ rich: true }), true);
  assert.equal(accountSendsRich({ md2: true }), false);
  assert.throws(() => accountSendsRich({ rich: true, md2: true }), /contradict/);
});

// --- CLI wiring, no network --------------------------------------------------------------

function runCli(args: string[], secrets?: object) {
  const dir = mkdtempSync(join(tmpdir(), 'ct-format-'));
  try {
    if (secrets) writeFileSync(join(dir, 'secrets.json'), JSON.stringify(secrets));
    // A clean environment: no Telegram credentials, a config dir with nothing but the fixture, cwd outside any project.
    const env = { PATH: process.env.PATH ?? '', HOME: dir, CLAUDE_TOOLS_CONFIG_DIR: dir, FORCE_COLOR: '0' };
    return spawnSync(process.execPath, [resolve('dist/cli.js'), ...args], { encoding: 'utf8', env, cwd: dir, timeout: 30_000 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const WALL = `${words(100)}.`;

test('telegram send: a wall is refused with exit 3 before any config or connection', () => {
  const run = runCli(['telegram', 'send', 'me', WALL]);
  assert.equal(run.status, FORMAT_REFUSED_EXIT_CODE, run.stderr);
  assert.match(run.stderr, /Not sent: the message does not follow the Telegram format/);
  assert.match(run.stderr, /--format-ok/);
});

test('telegram send/reply/edit: --format-ok passes the gate (then stops at the missing config)', () => {
  for (const args of [['telegram', 'send', 'me', WALL], ['telegram', 'reply', 'me', WALL, '5'], ['telegram', 'edit', 'me', '5', WALL]]) {
    const refused = runCli(args);
    assert.equal(refused.status, FORMAT_REFUSED_EXIT_CODE, `${args[1]}: ${refused.stderr}`);
    const passed = runCli([...args, '--format-ok', 'fixture']);
    assert.equal(passed.status, 1, `${args[1]}: ${passed.stderr}`);
    assert.match(passed.stderr + passed.stdout, /Telegram not configured/);
  }
  const empty = runCli(['telegram', 'send', 'me', WALL, '--format-ok', ' ']);
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /needs a reason/);
});

test('telegram send: --rich --md2 together is an error, not a guess', () => {
  const run = runCli(['telegram', 'send', 'me', 'hi', '--rich', '--md2']);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /contradict/);
});

test('bot send/reply/edit: refused with exit 3; --format-ok reaches the chat allowlist', () => {
  const secrets = { telegramBots: [{ name: 'fixture', token: '123:fixture', allowedChats: ['1'] }] };
  for (const args of [['bot', 'send', '2', WALL], ['bot', 'reply', '2', WALL, '5'], ['bot', 'edit', '2', '5', WALL], ['bot', 'send', '2', 'Merged #484.']]) {
    const refused = runCli(args, secrets);
    assert.equal(refused.status, FORMAT_REFUSED_EXIT_CODE, `${args[1]}: ${refused.stderr}`);
    const passed = runCli([...args, '--format-ok', 'fixture'], secrets);
    assert.equal(passed.status, 1, `${args[1]}: ${passed.stderr}`);
    assert.match(passed.stderr, /not in the allowlist/);
  }
});

test('bot send/reply/edit: the format is checked before the bot config, so a refusal is exit 3 with no bot configured', () => {
  for (const args of [['bot', 'send', '2', WALL], ['bot', 'reply', '2', WALL, '5'], ['bot', 'edit', '2', '5', WALL], ['bot', 'send', '2', WALL, '--bot', 'nope'], ['bot', 'send', '2', WALL, '--topic', 'x']]) {
    const run = runCli(args);
    assert.equal(run.status, FORMAT_REFUSED_EXIT_CODE, `${args.join(' ')}: ${run.stderr}`);
  }
});

test('literal sends are machine output and skip the check: bot --plain, account --md2', () => {
  const secrets = { telegramBots: [{ name: 'fixture', token: '123:fixture', allowedChats: ['1'] }] };
  const notice = '14:02 · work · alice@example.com · Re: PROJ-4393 #471 deploy · https://mail.example.com/x';
  const long = `${notice} ${words(150)}`;
  for (const body of [notice, long]) {
    const plain = runCli(['bot', 'send', '--bot', 'fixture', '--mute', '--plain', '2', body], secrets);
    assert.equal(plain.status, 1, plain.stderr);
    assert.match(plain.stderr, /not in the allowlist/, 'got past the gate to the chat check');
    assert.doesNotMatch(plain.stderr, /Format warning|Not sent/);
    const md2 = runCli(['telegram', 'send', 'me', body, '--md2']);
    assert.equal(md2.status, 1, md2.stderr);
    assert.match(md2.stderr + md2.stdout, /Telegram not configured/);
  }
  assert.equal(runCli(['bot', 'send', '2', notice], secrets).status, FORMAT_REFUSED_EXIT_CODE, 'the same body without --plain is refused');
});

test('bot send --topic: a refusal is exit 3 with the text on stderr, and --format-ok then sends through the hub', async () => {
  // The bridges' contract: exit 3 means "refused for its format" and nothing else; the override posts it.
  const calls: string[] = [];
  const hub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      calls.push(`${req.method} ${req.url} ${raw}`);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, result: { message_id: 77, date: 0, chat: { id: 2, type: 'supergroup' } } }));
    });
  });
  await new Promise<void>((r) => hub.listen(0, '127.0.0.1', r));
  const dir = mkdtempSync(join(tmpdir(), 'ct-format-hub-'));
  try {
    writeFileSync(join(dir, 'secrets.json'), JSON.stringify({ telegramBots: [{ name: 'fixture', token: '123:fixture', allowedChats: ['2'] }] }));
    const env = { PATH: process.env.PATH ?? '', HOME: dir, CLAUDE_TOOLS_CONFIG_DIR: dir, FORCE_COLOR: '0', AGENT_HUB_URL: `http://127.0.0.1:${(hub.address() as AddressInfo).port}` };
    // Asynchronous, so this process keeps serving the fake hub while the CLI runs.
    const run = (args: string[]) => new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
      const child = spawn(process.execPath, [resolve('dist/cli.js'), ...args], { env, cwd: dir });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => { stdout += c; });
      child.stderr.on('data', (c) => { stderr += c; });
      child.on('close', (status) => done({ status, stdout, stderr }));
    });
    const args = ['bot', 'send', '--bot', 'fixture', '--no-tts', '--topic', '5', '--as', 'fixture-agent', '2', WALL];
    const refused = await run(args);
    assert.equal(refused.status, FORMAT_REFUSED_EXIT_CODE, refused.stderr);
    assert.match(refused.stderr, /Not sent: the message does not follow the Telegram format/);
    assert.match(refused.stderr, /The format:/);
    assert.equal(refused.stdout, '');
    assert.equal(calls.length, 0, 'nothing reached the hub');

    const sent = await run([...args, '--format-ok', 'bridge relay']);
    assert.equal(sent.status, 0, sent.stderr);
    assert.match(sent.stdout, /✅ Sent \[bot chat:2 topic:5\] #77 \(format override: bridge relay\)/);
    assert.ok(calls.some((c) => /^POST \/api\/bots\/fixture\/call\/send(Rich)?Message /.test(c)), calls.join('\n'));
  } finally {
    hub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failure that is not the format check exits 1, never 3', () => {
  const secrets = { telegramBots: [{ name: 'fixture', token: '123:fixture', allowedChats: ['1'] }] };
  for (const args of [['bot', 'send', '2', 'Fine.'], ['bot', 'send', '2', 'Fine.', '--topic', 'x'], ['bot', 'send', '2', 'Fine.', '--topic', '5'], ['bot', 'reply', '1', 'Fine.', 'x']]) {
    assert.equal(runCli(args, secrets).status, 1, args.join(' '));
  }
});

test('help of every gated command shows the Format section', () => {
  for (const cmd of [['telegram', 'send'], ['telegram', 'reply'], ['telegram', 'edit'], ['bot', 'send'], ['bot', 'reply'], ['bot', 'edit']]) {
    const run = runCli([...cmd, '--help']);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Format:.*\n {2}- At most 800 characters per message/, cmd.join(' '));
    assert.match(run.stdout, /--format-ok <reason>/, cmd.join(' '));
  }
});

test('an --html body is measured as HTML: markdown syntax in it is literal (Codex review)', () => {
  const body = '<b>Release.</b> See [PROJ-4393 — fix](https://example.com/x) for details.';
  assert.equal(gateMessage(body, undefined).send, true, 'as markdown the ticket sits in a link label');
  const html = gateMessage(body, undefined, true);
  assert.equal(html.send, false, 'as HTML the brackets are shown, so the key is bare');
  assert.match(html.stderr, /PROJ-4393/);
  assert.equal(markdownAsLiteral('#claude\n#471').includes('#claude'), true, 'hashtags are left alone');
  assert.equal(markdownAsLiteral('# Title').startsWith('\uFF03'), true, 'a heading marker is not a heading in HTML');
  assert.equal(markdownAsLiteral('[a](b) `c` **d**').length, '[a](b) `c` **d**'.length, 'lengths are unchanged');
});

test('a time token counts its own label toward the length (Codex review)', () => {
  const label = 'x'.repeat(801);
  assert.ok(rules(`**Deploy.** {{time:2026-09-26 18:00|wDt|${label}}}`).includes('length'));
  assert.ok(!rules('**Deploy.** {{time:2026-09-26 18:00|wDt|Fri 18:00}}').includes('length'));
  assert.ok(!rules('**Deploy.** {{time:2026-09-26 18:00}}').includes('length'));
});

test('round 10: indented code, escaped links, marker entities and bot time tokens are measured as shown (Codex review)', () => {
  assert.ok(rules(`**Log.**\n\n    ${'<div></div>'.repeat(100)}`).includes('length'), 'indented code is literal');
  assert.ok(rules('**Fix.** See \\[PROJ-4393 — fix](https://example.com) now.').includes('bare-id'), 'an escaped opener is not a link');
  assert.equal(gateMessage(`<b>Title.</b> ${'&#42;'.repeat(900)}`, undefined, true).send, false, 'entity stars are shown');
  const token = `{{time:${'9'.repeat(900)}}}`;
  assert.equal(gateMessage(`**Deploy.** ${token}`, undefined, false, true).send, false, 'the bot shows the raw token');
  assert.equal(gateMessage('**Deploy.** {{time:2026-09-26 18:00}}', undefined, false, true).send, true);
});

test('round 11: a leading quote is not a title, code keeps link syntax, labels keep their pipes (Codex review)', () => {
  assert.ok(rules(`> ${'q'.repeat(300)}\n\n**Result.** Done.`).includes('title'), 'a quote first is not a title');
  assert.ok(rules(`**Log.** \`[x](https://example.com/${'a'.repeat(900)})\``).includes('length'), 'code shows the whole link');
  assert.ok(rules(`**Deploy.** {{time:2026-09-26 18:00|wDt|short|${'x'.repeat(801)}}}`).includes('length'), 'a label keeps its pipes');
  assert.ok(!rules('**Result.** Done.\n\n> quoted context').includes('title'), 'a quote after the title is fine');
});
