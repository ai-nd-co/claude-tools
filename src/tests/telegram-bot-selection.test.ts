import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { isTelegramBotConfigured, loadConfig, resolveTelegramBot } from '../config/loader.js';

const ENV_KEYS = ['TELEGRAM_BOT', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_DEFAULT_CHAT', 'CLAUDE_TOOLS_CONFIG_DIR'] as const;

/**
 * Run against a throwaway config dir with the bot env vars under test control,
 * so the developer's real secrets cannot decide an outcome.
 */
function withSecrets(
  secrets: unknown,
  env: Partial<Record<typeof ENV_KEYS[number], string>>,
  run: () => void
): () => void {
  return () => {
    const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-select-test-'));

    for (const key of ENV_KEYS) delete process.env[key];
    process.env.CLAUDE_TOOLS_CONFIG_DIR = dir;
    for (const [key, value] of Object.entries(env)) process.env[key] = value;

    if (secrets !== undefined) {
      fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify(secrets));
    }

    try {
      run();
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

const TWO_BOTS = {
  telegramBots: [
    { name: 'assistant', token: 'tok-assistant', default: true },
    { name: 'personal', token: 'tok-personal' },
  ],
};

test('no bots configured', withSecrets({}, {}, () => {
  const config = loadConfig();

  assert.deepEqual(config.telegramBots, []);
  assert.equal(config.telegramBot, null);
  assert.equal(isTelegramBotConfigured(), false);
}));

test('lists every bot in declaration order', withSecrets(TWO_BOTS, {}, () => {
  assert.deepEqual(loadConfig().telegramBots.map((b) => b.name), ['assistant', 'personal']);
  assert.equal(isTelegramBotConfigured(), true);
}));

test('the entry marked default is selected', withSecrets(TWO_BOTS, {}, () => {
  const selected = loadConfig().telegramBot;

  assert.equal(selected?.name, 'assistant');
  assert.equal(selected?.token, 'tok-assistant');
  assert.equal(selected?.isDefault, true);
}));

test('the first entry is the default when none is marked', withSecrets({
  telegramBots: [{ name: 'second', token: 'b' }, { name: 'third', token: 'c' }],
}, {}, () => {
  const config = loadConfig();

  assert.equal(config.telegramBot?.name, 'second');
  assert.equal(config.telegramBots[0].isDefault, true);
  assert.equal(config.telegramBots[1].isDefault, false);
}));

test('a later default wins over position', withSecrets({
  telegramBots: [{ name: 'first', token: 'a' }, { name: 'second', token: 'b', default: true }],
}, {}, () => {
  assert.equal(loadConfig().telegramBot?.name, 'second');
}));

test('TELEGRAM_BOT pins a bot for the session', withSecrets(TWO_BOTS, { TELEGRAM_BOT: 'personal' }, () => {
  const selected = loadConfig().telegramBot;

  assert.equal(selected?.name, 'personal');
  assert.equal(selected?.token, 'tok-personal');
}));

test('TELEGRAM_BOT ignores case and surrounding space', withSecrets(TWO_BOTS, { TELEGRAM_BOT: '  PERSONAL ' }, () => {
  assert.equal(loadConfig().telegramBot?.name, 'personal');
}));

test('an unknown TELEGRAM_BOT selects nothing rather than the wrong bot', withSecrets(TWO_BOTS, { TELEGRAM_BOT: 'nope' }, () => {
  // Falling back to the default here would message the wrong person.
  const config = loadConfig();

  assert.equal(config.telegramBot, null);
  assert.equal(config.telegramBots.length, 2, 'the bots are still listed, so a caller can report them');
}));

test('resolveTelegramBot picks by name, and the session default without one', withSecrets(TWO_BOTS, {}, () => {
  assert.equal(resolveTelegramBot('personal')?.token, 'tok-personal');
  assert.equal(resolveTelegramBot('assistant')?.token, 'tok-assistant');
  assert.equal(resolveTelegramBot()?.name, 'assistant');
  assert.equal(resolveTelegramBot('missing'), null);
}));

test('an explicit name overrides a pinned session', withSecrets(TWO_BOTS, { TELEGRAM_BOT: 'personal' }, () => {
  assert.equal(resolveTelegramBot('assistant')?.name, 'assistant');
}));

test('a legacy single telegramBot still works, as "default"', withSecrets({
  telegramBot: { token: 'legacy-token' },
}, {}, () => {
  const config = loadConfig();

  assert.equal(config.telegramBots.length, 1);
  assert.equal(config.telegramBot?.name, 'default');
  assert.equal(config.telegramBot?.token, 'legacy-token');
  assert.equal(config.telegramBot?.isDefault, true);
}));

test('TELEGRAM_BOT_TOKEN appears as "default" and outranks the legacy entry', withSecrets({
  telegramBot: { token: 'from-secrets' },
}, { TELEGRAM_BOT_TOKEN: 'from-env' }, () => {
  const config = loadConfig();

  assert.equal(config.telegramBots.length, 1, 'both describe the same unnamed bot');
  assert.equal(config.telegramBot?.token, 'from-env');
}));

test('a named list coexists with TELEGRAM_BOT_TOKEN', withSecrets(TWO_BOTS, { TELEGRAM_BOT_TOKEN: 'env-token' }, () => {
  const config = loadConfig();

  // The env token is an extra bot called `default`, and being first it wins
  // unless a named entry is explicitly marked default.
  assert.deepEqual(config.telegramBots.map((b) => b.name), ['default', 'assistant', 'personal']);
  assert.equal(resolveTelegramBot('personal')?.token, 'tok-personal');
  assert.equal(resolveTelegramBot('default')?.token, 'env-token');
}));

test('a duplicate name is ignored rather than shadowing the first', withSecrets({
  telegramBots: [
    { name: 'assistant', token: 'first-wins' },
    { name: 'assistant', token: 'ignored' },
  ],
}, {}, () => {
  const config = loadConfig();

  assert.equal(config.telegramBots.length, 1);
  assert.equal(config.telegramBot?.token, 'first-wins');
}));

test('unusable entries are skipped, not fatal', withSecrets({
  telegramBots: [
    { name: '', token: 'no-name' },
    { name: '   ', token: 'blank-name' },
    { name: 'no-token', token: '' },
    { name: 'good', token: 'tok' },
  ],
}, {}, () => {
  // One malformed entry must not take the whole bot config down with it.
  const config = loadConfig();

  assert.deepEqual(config.telegramBots.map((b) => b.name), ['good']);
  assert.equal(config.telegramBot?.isDefault, true);
}));

test('a name is matched after trimming', withSecrets({
  telegramBots: [{ name: '  padded  ', token: 'tok' }],
}, {}, () => {
  assert.equal(loadConfig().telegramBots[0].name, 'padded');
  assert.equal(resolveTelegramBot('padded')?.token, 'tok');
}));

test('adding bots leaves the other config sections alone', withSecrets({
  ...TWO_BOTS,
  groq: { apiKey: 'gsk_x' },
}, {}, () => {
  const config = loadConfig();

  assert.equal(config.groq?.apiKey, 'gsk_x');
  assert.ok('telegram' in config);
  assert.ok('jira' in config);
}));

// --- chat allowlist ---------------------------------------------------------

test('allowedChats is normalised to strings', withSecrets({
  telegramBots: [{ name: 'a', token: 't', allowedChats: [100000001, ' 123 ', 'x'] }],
}, {}, () => {
  assert.deepEqual(loadConfig().telegramBots[0].allowedChats, ['100000001', '123', 'x']);
}));

test('no allowlist means unrestricted', withSecrets({
  telegramBots: [{ name: 'a', token: 't' }],
}, {}, () => {
  assert.deepEqual(loadConfig().telegramBots[0].allowedChats, []);
}));

test('a malformed allowlist degrades to unrestricted, not to a crash', withSecrets({
  telegramBots: [
    { name: 'a', token: 't', allowedChats: 'not-an-array' as unknown as string[] },
    { name: 'b', token: 't2', allowedChats: [null, undefined, {}] as unknown as string[] },
  ],
}, {}, () => {
  // Worth knowing: "empty" means open, so a wholly malformed list opens the bot.
  const bots = loadConfig().telegramBots;
  assert.deepEqual(bots[0].allowedChats, []);
  assert.deepEqual(bots[1].allowedChats, []);
}));

test('each bot keeps its own allowlist', withSecrets({
  telegramBots: [
    { name: 'assistant', token: 'a', allowedChats: ['1'] },
    { name: 'personal', token: 'b', allowedChats: ['2', '3'] },
  ],
}, {}, () => {
  assert.deepEqual(resolveTelegramBot('assistant')?.allowedChats, ['1']);
  assert.deepEqual(resolveTelegramBot('personal')?.allowedChats, ['2', '3']);
}));

test('a legacy single bot can carry an allowlist too', withSecrets({
  telegramBot: { token: 'legacy', allowedChats: [42] },
}, {}, () => {
  assert.deepEqual(loadConfig().telegramBot?.allowedChats, ['42']);
}));

// --- per-chat policy --------------------------------------------------------

test('a config written before per-chat policy loads with no policies at all', withSecrets({
  telegramBots: [{ name: 'a', token: 't', allowedChats: ['100000001'] }],
}, {}, () => {
  const bot = loadConfig().telegramBots[0];

  assert.deepEqual(bot.allowedChats, ['100000001']);
  assert.deepEqual(bot.chats, {});
  assert.deepEqual(bot.mentionPatterns, []);
}));

test('a chat policy is normalised: ids to strings, requireMention left absent', withSecrets({
  telegramBots: [{
    name: 'a',
    token: 't',
    chats: {
      '-1001': { allowFrom: [100000001, ' 7 '] },
      '-1002': { requireMention: false },
    },
  }],
}, {}, () => {
  const chats = loadConfig().telegramBots[0].chats;

  assert.deepEqual(chats['-1001'], { allowFrom: ['100000001', '7'], requireMention: undefined });
  assert.deepEqual(chats['-1002'], { allowFrom: [], requireMention: false });
}));

test('a malformed chat policy keeps its chat rather than dropping the key', withSecrets({
  telegramBots: [{
    name: 'a',
    token: 't',
    chats: {
      '-1001': 'nonsense' as unknown as Record<string, never>,
      '-1002': { allowFrom: 'not-an-array' as unknown as string[], requireMention: 'yes' as unknown as boolean },
    },
  }],
}, {}, () => {
  // The presence of the key is what says "this group is mine". Dropping it over a
  // typo in one field would turn a config mistake into a silently deaf bot.
  const chats = loadConfig().telegramBots[0].chats;

  assert.deepEqual(chats['-1001'], { allowFrom: [], requireMention: undefined });
  assert.deepEqual(chats['-1002'], { allowFrom: [], requireMention: undefined });
}));

test('a malformed chats map degrades to no policies', withSecrets({
  telegramBots: [{ name: 'a', token: 't', chats: [] as unknown as Record<string, never> }],
}, {}, () => {
  assert.deepEqual(loadConfig().telegramBots[0].chats, {});
}));

test('mentionPatterns keep only usable strings', withSecrets({
  telegramBots: [{ name: 'a', token: 't', mentionPatterns: [' \\bclaude\\b ', '', 7 as unknown as string] }],
}, {}, () => {
  assert.deepEqual(loadConfig().telegramBots[0].mentionPatterns, ['\\bclaude\\b']);
}));

test('a legacy single bot can carry chat policies too', withSecrets({
  telegramBot: { token: 'legacy', chats: { '-1001': { allowFrom: [42] } }, mentionPatterns: ['claude'] },
}, {}, () => {
  const bot = loadConfig().telegramBot;

  assert.deepEqual(bot?.chats['-1001'].allowFrom, ['42']);
  assert.deepEqual(bot?.mentionPatterns, ['claude']);
}));
