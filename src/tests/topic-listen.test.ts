import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { listenPressOf } from '../services/hub-telegram.js';
import { HubClient } from '../services/hub.js';
import { TelegramBotService } from '../services/telegram-bot.js';
import { acceptListenPress, listenButtonFor, SpeechQueue } from '../commands/telegram-bot/index.js';
import { ListenLedger, MAX_BUTTON_RESTORES, UPLOAD_DECISION_MS, type ListenOutcome } from '../services/hub-listen.js';

const FINGERPRINT = 'Ukh-4k-7jbPI1NzOHQf5YrxT882e8wSXBGbAwUvlrok';

const press = (overrides: Record<string, unknown> = {}) => ({
  kind: 'tg.callback',
  body: JSON.stringify({
    v: 1, bot: 'personal', type: 'callback_query', chat: { id: '-1002000000001', type: 'supergroup' }, threadId: 3,
    messageId: 1808, sender: { id: '100000001', name: 'Davron' }, callback: { queryId: 'Q1', data: 'speak:abc' },
    ...overrides,
  }),
});

function withConfigDir(run: () => Promise<void>) {
  return async () => {
    const previous = process.env.CLAUDE_TOOLS_CONFIG_DIR;
    process.env.CLAUDE_TOOLS_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-listen-test-'));
    try {
      await run();
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_TOOLS_CONFIG_DIR;
      else process.env.CLAUDE_TOOLS_CONFIG_DIR = previous;
    }
  };
}

test('a Listen press the hub delivers is recognised with everything an answer needs, topic included', () => {
  assert.deepEqual(listenPressOf(press()), {
    bot: 'personal', queryId: 'Q1', chatId: '-1002000000001', messageId: 1808, data: 'speak:abc',
    sender: 'Davron [id 100000001]', threadId: 3,
  });
});

test('anything that is not a complete Listen press is left for the agent', () => {
  assert.equal(listenPressOf(press({ callback: { queryId: 'Q1', data: 'approve:1' } })), null);
  assert.equal(listenPressOf(press({ callback: { data: 'speak:abc' } })), null);
  assert.equal(listenPressOf({ ...press(), kind: 'tg' }), null);
  assert.equal(listenPressOf({ kind: 'tg.callback', body: 'not json' }), null);
});

test('a press in a topic is answered, its button removed, and every reply stays in that topic', withConfigDir(async () => {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const service = new TelegramBotService('', async (method, body) => {
    calls.push({ method, body: body as Record<string, unknown> });
    return { message_id: 1 };
  });
  const speech = new SpeechQueue(5, () => {});
  const listen = listenPressOf(press())!;
  // Nothing stashed for this message in the fresh config dir, so the job answers that it is gone, without synthesis.
  const settled: string[] = [];
  await acceptListenPress(service, speech, 'personal', 'personal', listen, (outcome) => { settled.push(outcome); });
  for (let i = 0; i < 50 && (calls.length < 3 || settled.length === 0); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  // Finished exactly once, and for good: nothing is stashed for it here, so its button must not come back.
  assert.deepEqual(settled, ['permanent']);

  assert.deepEqual(calls.slice(0, 2).map((call) => call.method), ['answerCallbackQuery', 'editMessageReplyMarkup']);
  assert.equal(calls[0]!.body['callback_query_id'], 'Q1');
  const reply = calls[2];
  assert.ok(reply, 'the job posted its answer');
  assert.match(reply.method, /^send(Rich)?Message$/);
  assert.equal(reply.body['message_thread_id'], 3);
  assert.equal(reply.body['reply_to_message_id'], 1808);
}));

test('a voice note through the hub carries the topic, and the token path is never used for it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-listen-voice-'));
  const ogg = path.join(dir, 'speech.ogg');
  fs.writeFileSync(ogg, Buffer.from('OggS-fake'));
  const sent: { params: Record<string, string | number>; audio: Buffer }[] = [];
  const service = new TelegramBotService('', async () => ({}), async (params, audio) => {
    sent.push({ params, audio });
    return { message_id: 77 };
  });
  assert.equal(await service.sendVoice('-1002000000001', ogg, { replyToId: 1808, threadId: 3 }), 77);
  assert.deepEqual(sent[0]!.params, { chat_id: '-1002000000001', message_thread_id: 3, reply_to_message_id: 1808 });
  assert.equal(sent[0]!.audio.toString(), 'OggS-fake');

  const noVoice = new TelegramBotService('', async () => ({}));
  await assert.rejects(noVoice.sendVoice('-1002000000001', ogg), /cannot upload a voice note/);
  await assert.rejects(noVoice.sendDocument('-1002000000001', ogg), /cannot upload a document/);
});

test('HubClient.botVoice posts the raw audio with its parameters in the query', async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const client = new HubClient({
    baseUrl: 'http://hub.test',
    agent: 'agent-hub',
    fingerprint: FINGERPRINT,
    clientVersion: '1.0.0',
    anchorRung: 'machine-id',
    fetchImpl: async (input, init) => {
      seen.push({ url: String(input), init: init! });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), { status: 200 });
    },
  });
  const result = await client.botVoice('personal', { chat_id: '-1002000000001', message_thread_id: 3 }, Buffer.from('abc'));
  assert.deepEqual(result, { message_id: 9 });
  assert.equal(seen[0]!.url, 'http://hub.test/api/bots/personal/voice?chat_id=-1002000000001&message_thread_id=3');
  assert.equal(seen[0]!.init.method, 'POST');
  assert.equal(Buffer.from(seen[0]!.init.body as Uint8Array).toString(), 'abc');

  const refusing = new HubClient({
    baseUrl: 'http://hub.test', agent: 'agent-hub', fingerprint: FINGERPRINT, anchorRung: 'machine-id',
    fetchImpl: async () => new Response(JSON.stringify({ error: 'topic_not_yours' }), { status: 403 }),
  });
  await assert.rejects(refusing.botVoice('personal', { chat_id: '1' }, Buffer.from('a')), /topic_not_yours|403/);

  // Something other than the hub answering is classified as such, so the watcher quarantines on it.
  const foreign = new HubClient({
    baseUrl: 'http://hub.test', agent: 'agent-hub', fingerprint: FINGERPRINT, anchorRung: 'machine-id',
    fetchImpl: async () => new Response('<html>welcome</html>', { status: 200 }),
  });
  await assert.rejects(foreign.botVoice('personal', { chat_id: '1' }, Buffer.from('a')), (error: Error) => error.name === 'HubNotHubError');
});

test('a press the watcher could not finish gets its own button back, so a second press works', async () => {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const service = new TelegramBotService('', async (method, body) => {
    calls.push({ method, body: body as Record<string, unknown> });
    return true;
  });
  const listen = listenPressOf(press())!;
  await service.setButtons(listen.chatId, listen.messageId, listenButtonFor(listen));
  assert.deepEqual(calls, [{
    method: 'editMessageReplyMarkup',
    body: { chat_id: '-1002000000001', message_id: 1808, reply_markup: { inline_keyboard: [[{ text: '🔊 Listen', callback_data: 'speak:abc' }]] } },
  }]);
});

test('a press refused by a full speech queue gets its button back and is reported finished', async () => {
  const methods: string[] = [];
  const service = new TelegramBotService('', async (method) => {
    methods.push(method);
    return { message_id: 1 };
  });
  const speech = new SpeechQueue(0, () => {});
  let settled = 0;
  await acceptListenPress(service, speech, 'personal', 'personal', listenPressOf(press())!, () => { settled += 1; });
  assert.equal(settled, 1);
  // answer, remove, put back, then the "try again" reply.
  assert.deepEqual(methods.slice(0, 3), ['answerCallbackQuery', 'editMessageReplyMarkup', 'editMessageReplyMarkup']);
});

// ---------------------------------------------------------------------------------------------------------------
// ListenLedger: the rule "a pressed button never ends up gone with no way to press it again", path by path.
// ---------------------------------------------------------------------------------------------------------------

function ledgerRig(opts: { reachable?: boolean; restoreFails?: number } = {}) {
  const rig = {
    reachable: opts.reachable ?? true,
    restoreFailures: opts.restoreFails ?? 0,
    accepted: 0,
    repeats: 0,
    restores: 0,
    lines: [] as string[],
    settle: undefined as undefined | ((outcome: ListenOutcome) => void),
  };
  const ledger = new ListenLedger({
    accept: async (_press, onSettled) => { rig.accepted += 1; rig.settle = onSettled; },
    answerRepeat: async () => { rig.repeats += 1; },
    restoreButton: async () => {
      rig.restores += 1;
      if (rig.restoreFailures > 0) { rig.restoreFailures -= 1; throw new Error('hub 502'); }
    },
    canReachHub: () => rig.reachable,
    report: (line) => { rig.lines.push(line); },
  });
  return { rig, ledger, tick: () => new Promise((resolve) => setTimeout(resolve, 0)) };
}

test('ledger exits 1 and 2: spoken, permanent or already restored leaves without another restore', async () => {
  for (const outcome of ['spoken', 'permanent', 'restored'] as const) {
    const { rig, ledger, tick } = ledgerRig();
    ledger.take(listenPressOf(press())!);
    await tick();
    rig.settle!(outcome);
    await tick();
    assert.equal(ledger.size, 0);
    assert.equal(rig.restores, 0, outcome);
  }
});

test('ledger exit 2: a retryable failure gets its button back at once when the hub is reachable', async () => {
  const { rig, ledger, tick } = ledgerRig();
  ledger.take(listenPressOf(press())!);
  await tick();
  rig.settle!('retryable');
  await tick(); await tick();
  assert.equal(rig.restores, 1);
  assert.equal(ledger.size, 0);
  assert.match(rig.lines[0]!, /button is back/);
});

test('ledger exit 2, quarantined: the press waits, and its button goes back once the hub is verified', async () => {
  const { rig, ledger, tick } = ledgerRig({ reachable: false });
  ledger.take(listenPressOf(press())!);
  await tick();
  rig.settle!('retryable');
  await tick();
  assert.equal(rig.restores, 0);
  assert.equal(ledger.size, 1, 'kept while the hub cannot be called');
  rig.reachable = true;
  ledger.hubVerified();
  await tick(); await tick();
  assert.equal(rig.restores, 1);
  assert.equal(ledger.size, 0);
});

test('ledger exit 3: a failing restore is retried after each verified poll, then given up loudly', async () => {
  const { rig, ledger, tick } = ledgerRig({ restoreFails: 99 });
  ledger.take(listenPressOf(press())!);
  await tick();
  rig.settle!('retryable');
  await tick(); await tick();
  for (let i = 1; i < MAX_BUTTON_RESTORES; i += 1) {
    assert.equal(ledger.size, 1, `still tracked after ${i} failed restores`);
    ledger.hubVerified();
    await tick(); await tick();
  }
  assert.equal(rig.restores, MAX_BUTTON_RESTORES);
  assert.equal(ledger.size, 0);
  assert.match(rig.lines.at(-1)!, /could not be put back.*send the message again/);
});

test('ledger exit 4: release at exit puts back every button still out, mid-speech included, and names each', async () => {
  const { rig, ledger, tick } = ledgerRig();
  ledger.take(listenPressOf(press())!);
  ledger.take(listenPressOf(press({ messageId: 1809, callback: { queryId: 'Q2', data: 'speak:def' } }))!);
  await tick();
  const { lines, restored } = ledger.release('a newer watcher took over first');
  await restored;
  assert.equal(rig.restores, 2);
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /msg 1808 .*topic 3.*interrupted: a newer watcher took over first/);
  assert.equal(ledger.size, 0);
});

test('ledger exit 4, quarantined: release cannot call the hub, so it only names the presses', async () => {
  const { rig, ledger, tick } = ledgerRig({ reachable: false });
  ledger.take(listenPressOf(press())!);
  await tick();
  const { lines, restored } = ledger.release('the watcher stopped (SIGTERM)');
  await restored;
  assert.equal(rig.restores, 0);
  assert.match(lines[0]!, /could not be put back, because the hub was not answering/);
});

test('ledger: a repeat press is only answered, and a failed take counts as retryable', async () => {
  const { rig, ledger, tick } = ledgerRig();
  const first = listenPressOf(press())!;
  ledger.take(first);
  ledger.take({ ...first, queryId: 'Q9' });
  await tick();
  assert.equal(rig.accepted, 1);
  assert.equal(rig.repeats, 1);

  const failing = new ListenLedger({
    accept: async () => { throw new Error('hub 500 on answerCallbackQuery'); },
    answerRepeat: async () => {},
    restoreButton: async () => { rig.restores += 1; },
    canReachHub: () => true,
    report: (line) => { rig.lines.push(line); },
  });
  failing.take(listenPressOf(press({ messageId: 1810 }))!);
  await tick(); await tick(); await tick();
  assert.equal(failing.size, 0);
  assert.ok(rig.restores >= 1, 'the button of a press that failed while being taken goes back');
});

test('a full queue whose button cannot be put back reports retryable, so the ledger keeps it', async () => {
  const service = new TelegramBotService('', async (method) => {
    if (method === 'editMessageReplyMarkup') throw new Error('hub 502');
    return { message_id: 1 };
  });
  const outcomes: string[] = [];
  await acceptListenPress(service, new SpeechQueue(0, () => {}), 'personal', 'personal', listenPressOf(press())!, (o) => { outcomes.push(o); });
  assert.deepEqual(outcomes, ['retryable']);
});

test('a "no longer available" reply that cannot be sent makes the press retryable, not permanent', withConfigDir(async () => {
  const service = new TelegramBotService('', async (method) => {
    if (method === 'sendMessage' || method === 'sendRichMessage') throw new Error('not sent: quarantined');
    return true;
  });
  const outcomes: string[] = [];
  await acceptListenPress(service, new SpeechQueue(5, () => {}), 'personal', 'personal', listenPressOf(press())!, (o) => { outcomes.push(o); });
  for (let i = 0; i < 50 && outcomes.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(outcomes, ['retryable']);
}));

test('ledger: an unawaited reply keeps it busy until it settles, so an exit still bounds it', async () => {
  let finish!: () => void;
  const reply = new Promise<void>((resolve) => { finish = resolve; });
  let settle!: (outcome: ListenOutcome) => void;
  const ledger = new ListenLedger({
    accept: async (_press, onSettled, track) => { track(reply); settle = onSettled; },
    answerRepeat: async () => {},
    restoreButton: async () => {},
    canReachHub: () => true,
    report: () => {},
  });
  ledger.take(listenPressOf(press())!);
  await new Promise((resolve) => setTimeout(resolve, 0));
  settle('spoken');
  assert.equal(ledger.size, 0);
  assert.equal(ledger.busy, true, 'the press is done, but its reply is still in flight');
  finish();
  await ledger.drained();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ledger.busy, false);
});

test('ledger: drained() also waits for a reply registered while it was already waiting', async () => {
  let track!: (request: Promise<unknown>) => void;
  const ledger = new ListenLedger({
    accept: async (_press, _onSettled, t) => { track = t; },
    answerRepeat: async () => {},
    restoreButton: async () => {},
    canReachHub: () => true,
    report: () => {},
  });
  ledger.take(listenPressOf(press())!);
  await new Promise((resolve) => setTimeout(resolve, 0));
  let finishFirst!: () => void;
  let finishLate!: () => void;
  track(new Promise<void>((resolve) => { finishFirst = resolve; }));
  let done = false;
  const draining = ledger.drained().then(() => { done = true; });
  track(new Promise<void>((resolve) => { finishLate = resolve; }));
  finishFirst();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(done, false, 'the late reply is still in flight');
  finishLate();
  await draining;
  assert.equal(done, true);
});

test('ledger: a second exit path still waits for the restores a first release started', async () => {
  let finishRestore!: () => void;
  const ledger = new ListenLedger({
    accept: async () => {},
    answerRepeat: async () => {},
    restoreButton: () => new Promise<void>((resolve) => { finishRestore = resolve; }),
    canReachHub: () => true,
    report: () => {},
  });
  ledger.take(listenPressOf(press())!);
  await new Promise((resolve) => setTimeout(resolve, 0));
  ledger.release('a newer watcher took over first');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ledger.size, 0);
  assert.equal(ledger.busy, true, 'the handover release is still restoring');
  let done = false;
  const draining = ledger.drained().then(() => { done = true; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(done, false);
  finishRestore();
  await draining;
  assert.equal(ledger.busy, false);
});

test('ledger: what release() hands every exit path also waits for replies still in flight', async () => {
  let finishReply!: () => void;
  let settle!: (outcome: ListenOutcome) => void;
  const ledger = new ListenLedger({
    accept: async (_press, onSettled, track) => {
      settle = onSettled;
      track(new Promise<void>((resolve) => { finishReply = resolve; }));
    },
    answerRepeat: async () => {},
    restoreButton: async () => {},
    canReachHub: () => true,
    report: () => {},
  });
  ledger.take(listenPressOf(press())!);
  await new Promise((resolve) => setTimeout(resolve, 0));
  settle('restored'); // the full-queue case: entry gone, its explanation still sending
  let done = false;
  const { restored } = ledger.release('the watcher stopped (SIGTERM)');
  void restored.then(() => { done = true; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(done, false, 'still waiting for the reply');
  finishReply();
  await restored;
  assert.equal(done, true);
});

test('ledger: a press arriving after release() is left alone, button and all', async () => {
  const { rig, ledger } = ledgerRig();
  ledger.release('the watcher stopped (SIGTERM)');
  ledger.take(listenPressOf(press())!);
  assert.equal(rig.accepted, 0, 'not answered and its button not removed');
  assert.equal(ledger.size, 0);
});

test('ledger: closed after release(), which is what refuses a late voice note', () => {
  const { ledger } = ledgerRig();
  assert.equal(ledger.closed, false);
  ledger.release('a newer watcher took over first');
  assert.equal(ledger.closed, true);
});

test('ledger: a release waits for an upload already under way, and restores only if it failed', async () => {
  for (const delivered of [true, false]) {
    const { rig, ledger, tick } = ledgerRig();
    const listen = listenPressOf(press())!;
    ledger.take(listen);
    await tick();
    let finish!: (ok: boolean) => void;
    const upload = new Promise<void>((resolve, reject) => { finish = (ok) => (ok ? resolve() : reject(new Error('hub 502'))); });
    ledger.uploading(listen.bot, listen.chatId, listen.messageId, upload);
    const { restored } = ledger.release('a newer watcher took over first');
    await tick();
    assert.equal(rig.restores, 0, 'nothing restored while the upload is undecided');
    finish(delivered);
    await restored;
    assert.equal(rig.restores, delivered ? 0 : 1, delivered ? 'delivered: button stays off' : 'failed: button back');
  }
});

test('ledger: an upload still undecided at exit gets its button back anyway, inside the decision window', async () => {
  const { rig, ledger, tick } = ledgerRig();
  const listen = listenPressOf(press())!;
  ledger.take(listen);
  await tick();
  ledger.uploading(listen.bot, listen.chatId, listen.messageId, new Promise(() => {})); // never settles
  const started = Date.now();
  const { restored } = ledger.release('the watcher stopped (SIGTERM)');
  await restored;
  assert.equal(rig.restores, 1, 'undecided: the rule wins, the button goes back');
  assert.ok(Date.now() - started < UPLOAD_DECISION_MS + 400, 'decided within the window, not the upload timeout');
});

test('ledger: the final "send the message again" report keeps the ledger busy until it is written', async () => {
  let written!: () => void;
  const ledger = new ListenLedger({
    accept: async (_press, onSettled) => { onSettled('retryable'); },
    answerRepeat: async () => {},
    restoreButton: async () => { throw new Error('hub 502'); },
    canReachHub: () => true,
    report: () => new Promise<void>((resolve) => { written = resolve; }),
  });
  ledger.take(listenPressOf(press())!);
  for (let i = 0; i < MAX_BUTTON_RESTORES + 2; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    ledger.hubVerified();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ledger.size, 0, 'given up after the last restore');
  assert.equal(ledger.busy, true, 'but the report is still being written');
  written();
  await ledger.drained();
  assert.equal(ledger.busy, false);
});

test('ledger: a restore already running when release() starts is waited for, and not reported twice', async () => {
  let finishRestore!: () => void;
  const lines: string[] = [];
  let first = true;
  const ledger = new ListenLedger({
    accept: async (_press, onSettled) => { onSettled('retryable'); },
    answerRepeat: async () => {},
    restoreButton: () => (first ? (first = false, new Promise<void>((resolve) => { finishRestore = resolve; })) : Promise.resolve()),
    canReachHub: () => true,
    report: (line) => { lines.push(line); },
  });
  ledger.take(listenPressOf(press())!);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0)); // the retryable restore is now running
  const { restored } = ledger.release('a newer watcher took over first');
  let done = false;
  void restored.then(() => { done = true; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(done, false, 'the earlier restore is still running');
  finishRestore();
  await restored;
  assert.equal(lines.filter((l) => /button is back/.test(l)).length, 0, 'the release already named it');
});

test('ledger: hubVerified() while the hub may not be called spends no restore attempt', async () => {
  const { rig, ledger, tick } = ledgerRig({ reachable: false });
  ledger.take(listenPressOf(press())!);
  await tick();
  rig.settle!('retryable');
  for (let i = 0; i < MAX_BUTTON_RESTORES + 2; i += 1) ledger.hubVerified();
  await tick();
  assert.equal(rig.restores, 0);
  assert.equal(ledger.size, 1, 'still waiting for a real verification');
  rig.reachable = true;
  ledger.hubVerified();
  await tick(); await tick();
  assert.equal(rig.restores, 1);
  assert.equal(ledger.size, 0);
});

test('HubClient: while the credential is held, nothing that carries the fingerprint is sent', async () => {
  let sent = 0;
  const client = new HubClient({
    baseUrl: 'http://hub.test', agent: 'agent-hub', fingerprint: FINGERPRINT, anchorRung: 'machine-id',
    fetchImpl: async () => { sent += 1; return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }); },
  });
  client.holdCredential(true);
  await assert.rejects(client.botCall('personal', 'sendChatAction', { chat_id: '1' }), (e: Error) => e.name === 'HubNotHubError');
  await assert.rejects(client.botVoice('personal', { chat_id: '1' }, Buffer.from('a')), (e: Error) => e.name === 'HubNotHubError');
  await assert.rejects(client.botFile('personal', 'F1'), (e: Error) => e.name === 'HubNotHubError');
  assert.equal(sent, 0);
  client.holdCredential(false);
  await client.botCall('personal', 'sendChatAction', { chat_id: '1' });
  assert.equal(sent, 1);
});
