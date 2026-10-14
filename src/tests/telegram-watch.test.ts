import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  TelegramWatcher,
  debounceStep,
  diffMessages,
  formatWatchEvent,
  loadWatchState,
  saveWatchState,
  type ChatWatchState,
  type FetchOptions,
  type WatchChat,
  type WatchIO,
  type WatchMessage,
  type WatchOptions,
} from '../services/telegram-watch.js';

const CHAT: WatchChat = { id: '-10042', title: 'Dev', peer: null };
const OPTS: WatchOptions = {
  intervalMs: 30_000,
  quietMs: 15_000,
  maxWaitMs: 120_000,
  settleMs: 5_000,
  window: 100,
  maxText: 400,
  edits: true,
  json: false,
  timeZone: 'UTC',
};

function msg(id: number, text = `m${id}`, extra: Partial<WatchMessage> = {}): WatchMessage {
  return { id, date: new Date(Date.UTC(2026, 8, 24, 14, 5)), sender: 'Priya', text, ...extra };
}

/** Fake Telegram chat + in-memory state store driving the real engine. */
class FakeWorld {
  messages = new Map<number, WatchMessage>();
  store = new Map<string, ChatWatchState>();
  emitted: string[][] = [];
  failNext = 0;
  fetches: FetchOptions[] = [];

  add(...ms: WatchMessage[]) {
    for (const m of ms) this.messages.set(m.id, m);
  }

  io(): WatchIO {
    return {
      withConnection: async (fn) => {
        if (this.failNext > 0) {
          this.failNext--;
          throw new Error('lock busy');
        }
        return fn(async (_chat, o) => {
          this.fetches.push(o);
          return [...this.messages.values()]
            .filter((m) => (o.minId === undefined || m.id > o.minId) && (o.offsetId === undefined || m.id < o.offsetId))
            .sort((a, b) => b.id - a.id)
            .slice(0, o.limit);
        });
      },
      loadState: (id) => (this.store.has(id) ? structuredClone(this.store.get(id)!) : null),
      saveState: (id, s) => { this.store.set(id, structuredClone(s)); },
      emit: (lines) => { this.emitted.push(lines); },
      log: () => {},
    };
  }

  watcher(opts: Partial<WatchOptions> = {}, initial = {}) {
    return new TelegramWatcher([CHAT], { ...OPTS, ...opts }, this.io(), initial);
  }
}

test('first run records a baseline and reports nothing', async () => {
  const w = new FakeWorld();
  w.add(msg(1), msg(2));
  const watcher = w.watcher();
  const delay = await watcher.tick(0);
  assert.equal(delay, OPTS.intervalMs);
  assert.deepEqual(w.emitted, []);
  assert.equal(w.store.get(CHAT.id)?.lastId, 2);
});

test('a new message is printed only after the quiet window, then state is saved', async () => {
  const w = new FakeWorld();
  w.add(msg(1));
  const watcher = w.watcher();
  await watcher.tick(0);
  w.add(msg(2, 'hello'));
  assert.equal(await watcher.tick(30_000), 5_000);
  assert.deepEqual(w.emitted, []);
  assert.equal(w.store.get(CHAT.id)?.lastId, 1, 'not saved while pending');
  await watcher.tick(35_000);
  await watcher.tick(40_000);
  assert.deepEqual(w.emitted, []);
  await watcher.tick(45_000);
  assert.deepEqual(w.emitted, [['[tg] Dev (-10042) #2 14:05 Priya: hello']]);
  assert.equal(w.store.get(CHAT.id)?.lastId, 2);
});

test('a burst of messages becomes one ordered emit', async () => {
  const w = new FakeWorld();
  w.add(msg(1));
  const watcher = w.watcher();
  await watcher.tick(0);
  w.add(msg(2));
  await watcher.tick(30_000);
  w.add(msg(3));
  await watcher.tick(35_000);
  w.add(msg(4));
  await watcher.tick(40_000);
  for (let t = 45_000; t <= 55_000; t += 5_000) await watcher.tick(t);
  assert.equal(w.emitted.length, 1);
  assert.deepEqual(w.emitted[0].map((l) => l.split(' ')[3]), ['#2', '#3', '#4']);
});

test('a chat that never goes quiet is flushed at max-wait', async () => {
  const w = new FakeWorld();
  w.add(msg(1));
  const watcher = w.watcher();
  await watcher.tick(0);
  let id = 2;
  let t = 30_000;
  while (w.emitted.length === 0 && t < 200_000) {
    w.add(msg(id++));
    await watcher.tick(t);
    t += 5_000;
  }
  assert.equal(w.emitted.length, 1);
  assert.ok(t - 5_000 >= 30_000 + OPTS.maxWaitMs, 'flushed no earlier than max-wait');
  assert.ok(t - 5_000 <= 30_000 + OPTS.maxWaitMs + OPTS.settleMs, 'flushed at max-wait');
});

test('a watcher killed while settling replays the burst after restart', async () => {
  const w = new FakeWorld();
  w.add(msg(1));
  const first = w.watcher();
  await first.tick(0);
  w.add(msg(2), msg(3));
  await first.tick(30_000); // pending, then "killed"

  const second = w.watcher();
  await second.tick(100_000);
  await second.tick(115_000);
  assert.equal(w.emitted.length, 1);
  assert.equal(w.emitted[0].length, 2);
});

test('--since reports everything after the given ID', async () => {
  const w = new FakeWorld();
  w.add(msg(5), msg(6), msg(7));
  const watcher = w.watcher({}, { sinceId: 5 });
  await watcher.tick(0);
  await watcher.tick(15_000);
  assert.deepEqual(w.emitted[0].map((l) => l.split(' ')[3]), ['#6', '#7']);
});

test('an edit of a printed message is one ✎ line with the old text; repeats and reactions are ignored', async () => {
  const w = new FakeWorld();
  w.add(msg(1, 'old text'));
  const watcher = w.watcher();
  await watcher.tick(0);
  w.add(msg(1, 'new text', { editDate: new Date(Date.UTC(2026, 8, 24, 14, 7)) }));
  await watcher.tick(30_000);
  await watcher.tick(45_000);
  assert.deepEqual(w.emitted, [['[tg] Dev (-10042) #1 ✎14:07 Priya: new text (was: old text)']]);

  // Same editDate again (e.g. a reaction changed) -> nothing
  await watcher.tick(75_000);
  await watcher.tick(105_000);
  assert.equal(w.emitted.length, 1);
});

test('--no-edits ignores edits', async () => {
  const w = new FakeWorld();
  w.add(msg(1, 'a'));
  const watcher = w.watcher({ edits: false });
  await watcher.tick(0);
  w.add(msg(1, 'b', { editDate: new Date() }));
  await watcher.tick(30_000);
  await watcher.tick(60_000);
  assert.deepEqual(w.emitted, []);
});

test('an edit before the burst flushes is merged into the new-message line', async () => {
  const w = new FakeWorld();
  w.add(msg(1));
  const watcher = w.watcher();
  await watcher.tick(0);
  w.add(msg(2, 'typo'));
  await watcher.tick(30_000);
  w.add(msg(2, 'fixed', { editDate: new Date(Date.UTC(2026, 8, 24, 14, 6)) }));
  await watcher.tick(35_000);
  await watcher.tick(50_000);
  assert.deepEqual(w.emitted, [['[tg] Dev (-10042) #2 14:05 Priya: fixed']]);
});

test('a burst larger than the window is paged back to lastId without a gap', async () => {
  const w = new FakeWorld();
  w.add(msg(1));
  const watcher = w.watcher({ window: 10 });
  await watcher.tick(0);
  for (let id = 2; id <= 36; id++) w.add(msg(id));
  await watcher.tick(30_000);
  await watcher.tick(45_000);
  const ids = w.emitted[0].map((l) => Number(l.split(' ')[3].slice(1)));
  assert.deepEqual(ids, Array.from({ length: 35 }, (_, i) => i + 2));
  assert.ok(w.fetches.some((f) => f.minId === 1 && f.offsetId !== undefined));
});

test('poll failures: one ERROR line after 3 in a row, then recovered', async () => {
  const w = new FakeWorld();
  w.add(msg(1));
  const watcher = w.watcher();
  await watcher.tick(0);
  w.failNext = 4;
  for (let i = 1; i <= 4; i++) await watcher.tick(i * 30_000);
  assert.deepEqual(w.emitted, [['[tg-watch] ERROR lock busy (retrying)']]);
  await watcher.tick(150_000);
  assert.deepEqual(w.emitted[1], ['[tg-watch] recovered']);
});

test('formatting: folded newlines, truncation, media, reply, json', () => {
  const base = { kind: 'new' as const, chatId: '-1', chatTitle: 'C' };
  const long = formatWatchEvent({ ...base, msg: msg(9, 'line1\nline2' + 'x'.repeat(20), { replyToId: 3 }) }, { ...OPTS, maxText: 10 });
  assert.equal(long, '[tg] C (-1) #9 14:05 Priya ↩3: line1 ⏎ li… [+23 chars]');

  const media = formatWatchEvent({ ...base, msg: msg(9, '', { hasMedia: true, mediaType: 'photo' }) }, OPTS);
  assert.equal(media, '[tg] C (-1) #9 14:05 Priya: [photo]');

  const json = JSON.parse(formatWatchEvent({ ...base, msg: msg(9, 'hi') }, { ...OPTS, json: true }));
  assert.equal(json.type, 'new');
  assert.equal(json.id, 9);
  assert.equal(json.chatId, '-1');
  assert.equal(json.text, 'hi');
});

test('diffMessages ignores edits of untracked messages', () => {
  const state: ChatWatchState = { lastId: 10, recent: {} };
  const { events, next } = diffMessages(state, [msg(5, 'x', { editDate: new Date() })], CHAT, { window: 100, edits: true });
  assert.deepEqual(events, []);
  assert.ok(next.recent['5']);
});

test('debounceStep never waits past the quiet or max-wait deadline', () => {
  const s = debounceStep({ firstAt: 0, lastChangeAt: 12_000 }, 13_000, false, OPTS);
  assert.equal(s.flush, false);
  assert.equal(s.delayMs, 5_000);
  const t = debounceStep({ firstAt: 0, lastChangeAt: 0 }, 13_000, false, OPTS);
  assert.equal(t.delayMs, 2_000);
});

test('state files round-trip atomically', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-watch-'));
  const file = path.join(dir, 'nested', 'chat.json');
  assert.equal(loadWatchState(file), null);
  saveWatchState(file, { lastId: 3, recent: { 3: { e: 0, t: 'x' } } });
  assert.deepEqual(loadWatchState(file), { lastId: 3, recent: { 3: { e: 0, t: 'x' } } });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['chat.json']);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- voice transcription in emitted events ---------------------------------

test('formatWatchEvent shows duration and a quoted transcript', () => {
  const line = formatWatchEvent(
    {
      kind: 'new',
      chatId: '-10042',
      chatTitle: 'Dev',
      msg: msg(9, '', { hasMedia: true, mediaType: 'voice', mediaDuration: 13.4, transcript: 'let us make it a minute' }),
    },
    { maxText: 400, json: false, timeZone: 'UTC' },
  );

  assert.match(line, /\[voice 13s\] "let us make it a minute"/);
});

test('formatWatchEvent leaves an untranscribed clip as a bare tag', () => {
  const line = formatWatchEvent(
    {
      kind: 'new',
      chatId: '-10042',
      chatTitle: 'Dev',
      msg: msg(9, '', { hasMedia: true, mediaType: 'voice', mediaDuration: 185 }),
    },
    { maxText: 400, json: false, timeZone: 'UTC' },
  );

  assert.match(line, /\[voice 185s\]$/);
  assert.ok(!line.includes('"'), 'no empty quotes when there is no transcript');
});

test('formatWatchEvent carries transcript and duration into JSON', () => {
  const line = formatWatchEvent(
    {
      kind: 'new',
      chatId: '-10042',
      chatTitle: 'Dev',
      msg: msg(9, '', { hasMedia: true, mediaType: 'voice', mediaDuration: 6, transcript: 'do not retranscribe' }),
    },
    { maxText: 400, json: true, timeZone: 'UTC' },
  );

  const parsed = JSON.parse(line);
  assert.equal(parsed.transcript, 'do not retranscribe');
  assert.equal(parsed.mediaDuration, 6);
  assert.equal(parsed.media, 'voice');
});

test('formatWatchEvent truncates a long transcript', () => {
  const line = formatWatchEvent(
    {
      kind: 'new',
      chatId: '-10042',
      chatTitle: 'Dev',
      msg: msg(9, '', { hasMedia: true, mediaType: 'voice', mediaDuration: 50, transcript: 'x'.repeat(500) }),
    },
    { maxText: 20, json: false, timeZone: 'UTC' },
  );

  assert.match(line, /\[\+\d+ chars\]"/, 'transcript should be truncated like text');
});

test('the enrich hook runs on emitted events only, and a throw still emits', async () => {
  // The watcher must report the burst even if transcription blows up.
  const world = new FakeWorld();
  world.messages.set(1, msg(1, '', { hasMedia: true, mediaType: 'voice', mediaDuration: 5 }));

  const seen: number[][] = [];
  const io = world.io();
  const watcher = new TelegramWatcher([CHAT], OPTS, {
    ...io,
    enrich: async (events) => {
      seen.push(events.map((e) => e.msg.id));
      throw new Error('groq down');
    },
  }, { sinceId: 0 });

  await watcher.tick(0);
  await watcher.tick(OPTS.quietMs + OPTS.settleMs + 1);

  assert.deepEqual(seen, [[1]], 'enrich saw exactly the emitted event');
  assert.equal(world.emitted.length, 1, 'burst is still emitted after enrich throws');
  assert.match(world.emitted[0][0], /#1/);
});

test('a transcript added by enrich reaches the emitted line', async () => {
  const world = new FakeWorld();
  world.messages.set(1, msg(1, '', { hasMedia: true, mediaType: 'voice', mediaDuration: 5 }));

  const io = world.io();
  const watcher = new TelegramWatcher([CHAT], OPTS, {
    ...io,
    enrich: async (events) => {
      for (const ev of events) ev.msg.transcript = 'transcribed by the hook';
    },
  }, { sinceId: 0 });

  await watcher.tick(0);
  await watcher.tick(OPTS.quietMs + OPTS.settleMs + 1);

  assert.match(world.emitted[0][0], /"transcribed by the hook"/);
});

test('a reaction does not become a phantom edit', () => {
  // Reacting bumps the edit timestamp without touching the text. Comparing
  // timestamps alone reported an "edit" whose before and after were identical -
  // and since the watcher reacts to what it picks up, that was every message.
  const first = diffMessages(null, [msg(1, 'hello')], CHAT, OPTS);
  const seen = diffMessages(first.next, [msg(1, 'hello')], CHAT, OPTS);
  assert.deepEqual(seen.events, []);

  const reacted = { ...msg(1, 'hello'), editDate: new Date(Date.UTC(2026, 8, 24, 14, 9)) };
  const afterReaction = diffMessages(seen.next, [reacted], CHAT, OPTS);
  assert.deepEqual(afterReaction.events, [], 'unchanged text is not an edit');

  const edited = { ...msg(1, 'hello, actually'), editDate: new Date(Date.UTC(2026, 8, 24, 14, 10)) };
  const afterEdit = diffMessages(afterReaction.next, [edited], CHAT, OPTS);
  assert.equal(afterEdit.events.length, 1, 'a real edit still reports');
  assert.equal(afterEdit.events[0].kind, 'edit');
});

test('an edit past the stored text cut-off is still reported', () => {
  // The stored text is truncated for display; comparing that alone silently
  // dropped any edit that only changed the tail of a long message.
  const long = 'x'.repeat(1200);
  const first = diffMessages(null, [msg(1, long)], CHAT, OPTS);
  const seen = diffMessages(first.next, [msg(1, long)], CHAT, OPTS);
  assert.deepEqual(seen.events, []);

  const edited = { ...msg(1, `${long}CHANGED`), editDate: new Date(Date.UTC(2026, 8, 24, 14, 10)) };
  const after = diffMessages(seen.next, [edited], CHAT, OPTS);

  assert.equal(after.events.length, 1, 'a change beyond the prefix must still report');
  assert.equal(after.events[0].kind, 'edit');
});

test('swapping an attachment counts as an edit', () => {
  // Replacing a photo while keeping the caption changes no text at all.
  const withPhoto = msg(1, 'same caption', { hasMedia: true, mediaType: 'photo' });
  const first = diffMessages(null, [withPhoto], CHAT, OPTS);

  const swapped = {
    ...msg(1, 'same caption', { hasMedia: true, mediaType: 'video' }),
    editDate: new Date(Date.UTC(2026, 8, 24, 14, 10)),
  };
  const after = diffMessages(first.next, [swapped], CHAT, OPTS);

  assert.equal(after.events.length, 1, 'an attachment change is a change');
});

test('state written before fingerprints still works', () => {
  // An upgrade must not lose edit detection for messages already in state.
  const legacy = { lastId: 1, recent: { 1: { e: 0, t: 'original' } } };
  const edited = { ...msg(1, 'different now'), editDate: new Date(Date.UTC(2026, 8, 24, 14, 10)) };

  const after = diffMessages(legacy as any, [edited], CHAT, OPTS);
  assert.equal(after.events.length, 1);
  assert.equal(after.events[0].kind, 'edit');
});
