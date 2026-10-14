import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { botIdFromToken, configDirFor, HEARTBEAT_FRESH_MS, localBotWatchRunning, processStartTime, watchedBot, watcherBotId, watcherReceiving, watcherStateName } from '../services/bot-watch-presence.js';
import { recordSentMessage, sentHere, sentViaHub } from '../services/telegram-bot.js';

const node = (...args: string[]) => ({ pid: 1, argv: ['node', '/x/dist/cli.js', ...args], configDir: '/cfg' });

test('a bot watch command line names its bot by --bot, --bot=, its own TELEGRAM_BOT, or the default', () => {
  assert.equal(watchedBot(node('bot', 'watch', '--bot', 'assistant'), 'personal'), 'assistant');
  assert.equal(watchedBot(node('bot', 'watch', '--bot=assistant'), 'personal'), 'assistant');
  assert.equal(watchedBot({ ...node('bot', 'watch'), telegramBotEnv: 'assistant' }, 'personal'), 'assistant');
  assert.equal(watchedBot(node('bot', 'watch', '--state', 'x'), 'personal'), 'personal');
  assert.equal(watchedBot({ ...node('bot', 'watch'), telegramBotEnv: '' }, 'personal'), 'personal', 'empty TELEGRAM_BOT is unset');
});

test('anything that is not a bot watch does not count, the hub watcher included', () => {
  assert.equal(watchedBot(node('hub', 'watch', '--agent', 'agent-hub'), 'personal'), null);
  assert.equal(watchedBot(node('bot', 'send', '--bot', 'personal'), 'personal'), null);
  assert.equal(watchedBot(node('telegram', 'watch', '--state', 'bot'), 'personal'), null);
});

test('the answer is per bot id, and null when the process table cannot be read', () => {
  const ids: Record<string, number> = { assistant: 111, personal: 222 };
  const idOf = (_proc: unknown, watched: string) => ids[watched] ?? null;
  const live = () => true;
  const procs = () => [node('bot', 'watch', '--bot', 'assistant'), node('hub', 'watch')];
  assert.equal(localBotWatchRunning('assistant', 'personal', procs, 111, idOf, '/cfg', live), true);
  assert.equal(localBotWatchRunning('personal', 'personal', procs, 222, idOf, '/cfg', live), false, 'only the hub polls personal: no local answerer');
  assert.equal(localBotWatchRunning('personal', 'personal', () => null, 222, idOf, '/cfg', live), null);
  assert.equal(localBotWatchRunning('personal', undefined, () => [{ ...node('bot', 'watch'), telegramBotEnv: ' PERSONAL ' }], 222, idOf, '/cfg', live), true, 'normalised like bot selection');
  // Same name, another bot: the watcher polls a different id (another configuration, or a swapped token).
  assert.equal(localBotWatchRunning('assistant', 'personal', procs, 999, idOf, '/cfg', live), false);
  // Unknown on either side is not counted: no button beats a dead one.
  assert.equal(localBotWatchRunning('assistant', 'personal', procs, null, idOf, '/cfg', live), false);
  assert.equal(localBotWatchRunning('assistant', 'personal', procs, 111, () => null, '/cfg', live), false);
  // Another config dir cannot read the sender's stashed text; a stale heartbeat is a watcher not receiving.
  assert.equal(localBotWatchRunning('assistant', 'personal', procs, 111, idOf, '/other', live), false);
  assert.equal(localBotWatchRunning('assistant', 'personal', procs, 111, idOf, '/cfg', () => false), false);
  assert.equal(localBotWatchRunning('assistant', 'personal', procs, 111, idOf, '/cfg', () => null), false, 'no stamp: unproven, so not counted');
});

test('a heartbeat is fresh, stale, or absent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'presence-alive-'));
  const proc = { pid: 4, argv: ['node', 'cli.js', 'bot', 'watch', '--bot', 'assistant'], configDir: dir };
  assert.equal(watcherReceiving(proc, 'assistant'), null);
  fs.mkdirSync(path.join(dir, 'telegram-bot', 'assistant'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'telegram-bot', 'assistant', 'alive-4.json'), JSON.stringify({ at: 1_000_000, botId: 1, startTime: 7 }));
  assert.equal(watcherReceiving(proc, 'assistant', 1_000_000 + 60_000, () => 7), true);
  assert.equal(watcherReceiving(proc, 'assistant', 1_000_000 + HEARTBEAT_FRESH_MS + 1, () => 7), false);
  // A watcher polling with a 10-minute timeout says so, and stays fresh for one whole poll.
  fs.writeFileSync(path.join(dir, 'telegram-bot', 'assistant', 'alive-4.json'), JSON.stringify({ at: 1_000_000, botId: 1, freshForMs: 660_000, startTime: 7 }));
  assert.equal(watcherReceiving(proc, 'assistant', 1_000_000 + 600_000, () => 7), true);
  assert.equal(watcherReceiving(proc, 'assistant', 1_000_000 + 660_001, () => 7), false);
  // A failed poll withdraws it at once; a stamp left by another process is absent for this one.
  fs.writeFileSync(path.join(dir, 'telegram-bot', 'assistant', 'alive-4.json'), JSON.stringify({ at: 1_000_000, pid: 4, ok: false, freshForMs: 660_000, startTime: 7 }));
  assert.equal(watcherReceiving(proc, 'assistant', 1_000_000 + 1_000, () => 7), false);
  // Another process's file (an earlier watcher, or a second one on this state) is not this one's.
  const other = { ...proc, pid: 5 };
  assert.equal(watcherReceiving(other, 'assistant', 1_000_000), null, 'no file of its own: absent');
  fs.writeFileSync(path.join(dir, 'telegram-bot', 'assistant', 'alive-5.json'), JSON.stringify({ at: 1_000_000, ok: false, startTime: 7 }));
  assert.equal(watcherReceiving(other, 'assistant', 1_000_100, () => 7), false, 'each watcher judged by its own file');
  // A poll under way after a failure counts; a stamp from an earlier process with this pid does not.
  fs.writeFileSync(path.join(dir, 'telegram-bot', 'assistant', 'alive-5.json'), JSON.stringify({ at: 1_000_000, ok: 'polling', startTime: 77 }));
  assert.equal(watcherReceiving(other, 'assistant', 1_000_100, () => 77), true);
  assert.equal(watcherReceiving(other, 'assistant', 1_000_100, () => 78), null, 'pid reused: not this process\'s stamp');
  assert.ok(typeof processStartTime(process.pid) === 'number');
  // A stamp with no generation (an older writer) proves nothing, however fresh.
  fs.writeFileSync(path.join(dir, 'telegram-bot', 'assistant', 'alive-5.json'), JSON.stringify({ at: 1_000_000, ok: true }));
  assert.equal(watcherReceiving(other, 'assistant', 1_000_100, () => 77), null);
});

test('a watcher\'s bot id is the one its state recorded; a sender\'s is its token\'s prefix', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'presence-state-'));
  fs.mkdirSync(path.join(dir, 'telegram-bot', 'babysit'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'telegram-bot', 'babysit', 'offset.json'), JSON.stringify({ offset: 5, bot: 'assistant', botId: 8870034492 }));
  const proc = { pid: 2, argv: ['node', 'cli.js', 'bot', 'watch', '--bot', 'assistant', '--state', 'babysit'], configDir: dir };
  assert.equal(watcherStateName(proc, 'assistant'), 'babysit');
  assert.equal(watcherBotId(proc, 'assistant'), 8870034492);
  assert.equal(watcherBotId({ ...proc, argv: ['node', 'cli.js', 'bot', 'watch', '--bot', 'assistant'] }, 'assistant'), null, 'no state named assistant here');
  assert.equal(watcherBotId({ pid: 3, argv: proc.argv }, 'assistant'), null, 'unreadable environment: unknown');
  assert.equal(botIdFromToken('8870034492:abc-def_GHI'), 8870034492);
  assert.equal(botIdFromToken('not a token'), null);
  assert.equal(configDirFor({ CLAUDE_TOOLS_CONFIG_DIR: '/a' }), '/a');
  assert.equal(configDirFor({ XDG_CONFIG_HOME: '/x' }), '/x/claude-tools');
  assert.equal(configDirFor({ HOME: '/h' }), '/h/.config/claude-tools');
});

test('a message sent through the hub is remembered as such, so an edit keeps its button', () => {
  const previous = process.env.CLAUDE_TOOLS_CONFIG_DIR;
  process.env.CLAUDE_TOOLS_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'presence-test-'));
  try {
    recordSentMessage('personal', '-1002000000001', 10, 'hello', 'rich', true);
    recordSentMessage('personal', '-1002000000001', 11, 'hello', 'rich');
    assert.equal(sentViaHub('personal', '-1002000000001', 10), true);
    assert.equal(sentViaHub('personal', '-1002000000001', 11), false);
    assert.equal(sentViaHub('personal', '-1002000000001', 12), null, 'no record: unknown, not assumed local');
    // An edit that could not tell keeps it unknown, so a second edit does not strip the button either.
    recordSentMessage('personal', '-1002000000001', 12, 'edited', 'rich', null);
    assert.equal(sentViaHub('personal', '-1002000000001', 12), null);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_TOOLS_CONFIG_DIR;
    else process.env.CLAUDE_TOOLS_CONFIG_DIR = previous;
  }
});

test('bot edit takes --topic, so editing a topic message keeps its Listen button', async () => {
  const { Command } = await import('commander');
  const { registerBotCommands } = await import('../commands/telegram-bot/index.js');
  const program = new Command();
  registerBotCommands(program);
  const edit = program.commands.find((c) => c.name() === 'bot')!.commands.find((c) => c.name() === 'edit')!;
  assert.ok(edit.options.some((o) => o.long === '--topic'), 'bot edit --topic exists');
});

test('authorship: a send is authored here, an edit keeps what was there and never creates it', () => {
  const previous = process.env.CLAUDE_TOOLS_CONFIG_DIR;
  process.env.CLAUDE_TOOLS_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'presence-authored-'));
  try {
    recordSentMessage('personal', '-1002000000001', 20, 'sent', 'rich', true);
    assert.equal(sentHere('personal', '-1002000000001', 20), true);
    recordSentMessage('personal', '-1002000000001', 20, 'edited', 'rich', true, null);
    assert.equal(sentHere('personal', '-1002000000001', 20), true, 'an edit keeps authorship');
    // Another machine's message, edited here: the record the edit creates does not claim authorship.
    recordSentMessage('personal', '-1002000000001', 21, 'edited elsewhere-sent', 'rich', null, null);
    assert.equal(sentHere('personal', '-1002000000001', 21), false);
    recordSentMessage('personal', '-1002000000001', 21, 'edited again', 'rich', null, null);
    assert.equal(sentHere('personal', '-1002000000001', 21), false, 'a second edit does not make it authored');
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_TOOLS_CONFIG_DIR;
    else process.env.CLAUDE_TOOLS_CONFIG_DIR = previous;
  }
});
