// Watch command - long-running chat watcher for the Claude Code Monitor tool.
// Prints one stdout line per new/edited message; never exits on its own.

import { Command } from 'commander';
import chalk from 'chalk';
import { rmSync } from 'fs';
import { loadConfig } from '../../config/loader.js';
import { TelegramService, type ResolvedChat } from '../../services/telegram.js';
import { releaseTelegramLock } from '../../utils/file-lock.js';
import {
  TelegramWatcher,
  loadWatchState,
  saveWatchState,
  watchStatePath,
  type WatchChat,
  type WatchIO,
  type WatchMessage,
} from '../../services/telegram-watch.js';
import { attachVoiceTranscripts, DEFAULT_MAX_DURATION_SECONDS } from '../../services/voice-transcription.js';
import { resolveSttBackends } from '../../services/stt.js';
import { pruneTranscriptCache } from '../../services/transcript-cache.js';
import { formatDelay, retryForever } from '../../services/backoff.js';

const SETTLE_POLL_MS = 5000;

/** Shown on a message the moment the watcher picks it up. */
const SEEN_EMOJI = '\u{1F440}';

function ensureTelegramConfig() {
  const config = loadConfig();
  if (!config.telegram) {
    console.error(chalk.red('Telegram not configured.'));
    console.log('\nTo configure Telegram:');
    console.log('  1. Get API credentials from https://my.telegram.org/apps');
    console.log('  2. Run: claude-tools telegram auth');
    process.exit(1);
  }
  return config.telegram;
}

function positiveInt(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(chalk.red(`--${name} must be a positive integer`));
    process.exit(1);
  }
  return n;
}

interface WatchCliOptions {
  interval: string;
  quiet: string;
  maxWait: string;
  maxText: string;
  window: string;
  state: string;
  since?: string;
  reset?: boolean;
  edits: boolean;
  /** Commander maps `--emoji` to true; absent means emoji-only messages are dropped. */
  emoji?: boolean;
  json?: boolean;
  transcribe: boolean;
  transcribeMax: string;
  transcribeLimit: string;
  seen: boolean;
  typing: boolean;
}

export function registerWatchCommand(telegram: Command): void {
  telegram
    .command('watch <chats...>')
    .description('Watch chats and print one line per new or edited message (for the Claude Code Monitor tool)')
    .option('--interval <sec>', 'Idle poll interval in seconds', '30')
    .option('--quiet <sec>', 'Debounce: print once the chat has been quiet this long', '15')
    .option('--max-wait <sec>', 'Print anyway this long after the first pending message', '120')
    .option('--max-text <n>', 'Truncate message text to this many characters', '400')
    .option('--window <n>', 'Recent messages checked per poll (edits older than this are not seen)', '100')
    .option('--state <name>', 'State namespace; use a distinct one per agent watching the same chat', 'default')
    .option('--since <msgId>', 'Report messages after this ID (overrides saved state)')
    .option('--reset', 'Discard saved state and re-baseline at the latest message')
    .option('--no-edits', 'Report new messages only')
    .option('--emoji', 'Also report messages that are only emoji (dropped by default unless they reply to something)')
    .option('--json', 'Print one JSON object per line')
    .option('--no-transcribe', 'Do not transcribe short voice messages')
    .option('--no-seen', 'Do not react with 👀 when a message arrives')
    .option('--no-typing', 'Do not show "typing…" when a message arrives')
    .option('--transcribe-max <sec>', 'Longest voice message to transcribe', String(DEFAULT_MAX_DURATION_SECONDS))
    .option('--transcribe-limit <n>', 'Most voice messages to transcribe per burst', '3')
    .addHelpText('after', `
${chalk.yellow('Behaviour:')}
  Polls every --interval seconds, taking the Telegram session lock only for the
  poll itself, so send/reply/read keep working. When something changes it keeps
  polling every 5s and prints the whole burst once the chat has been quiet for
  --quiet seconds. The last reported message ID is saved per chat, so a
  restarted watcher reports what arrived while it was down. The first run
  (no saved state) only records a baseline.

${chalk.yellow('Examples:')}
  ${chalk.dim('# Watch saved messages')}
  claude-tools telegram watch me

  ${chalk.dim('# Watch a group by canonical ID (negative IDs go after --)')}
  claude-tools telegram watch --interval 20 -- -1002000000002

  ${chalk.dim('# From Claude Code: Monitor({command: "claude-tools telegram watch -- <chatId>", timeout_ms: 1800000})')}
`)
    .action(async (chatArgs: string[], options: WatchCliOptions) => {
      const config = ensureTelegramConfig();

      // Commander maps `--no-transcribe` to `transcribe: false`.
      const transcribeEnabled = options.transcribe !== false;
      const seenEnabled = options.seen !== false;
      const typingEnabled = options.typing !== false;
      const transcribeMax = positiveInt(options.transcribeMax, 'transcribe-max');
      const transcribeLimit = positiveInt(options.transcribeLimit, 'transcribe-limit');

      const opts = {
        intervalMs: positiveInt(options.interval, 'interval') * 1000,
        quietMs: positiveInt(options.quiet, 'quiet') * 1000,
        maxWaitMs: positiveInt(options.maxWait, 'max-wait') * 1000,
        settleMs: SETTLE_POLL_MS,
        window: Math.min(positiveInt(options.window, 'window'), 100),
        maxText: positiveInt(options.maxText, 'max-text'),
        edits: options.edits,
        ignoreEmoji: !options.emoji,
        json: !!options.json,
      };
      const sinceId = options.since !== undefined ? positiveInt(options.since, 'since') : undefined;

      const shutdown = () => {
        releaseTelegramLock();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      process.on('SIGHUP', shutdown);

      const io: WatchIO = {
        async withConnection(fn) {
          const service = new TelegramService(config);
          try {
            await service.connect();
            return await fn((chat, fetchOpts) =>
              service.getMessages(chat.peer as ResolvedChat, fetchOpts.limit, {
                minId: fetchOpts.minId,
                offsetId: fetchOpts.offsetId,
              })
            );
          } finally {
            await service.disconnect();
          }
        },
        loadState: (chatId) => loadWatchState(watchStatePath(options.state, chatId)),
        saveState: (chatId, state) => saveWatchState(watchStatePath(options.state, chatId), state),
        emit: (lines) => {
          process.stdout.write(`${lines.join('\n')}\n`);
        },
        log: (message) => {
          process.stderr.write(`[tg-watch] ${new Date().toISOString()} ${message}\n`);
        },
        enrich: (transcribeEnabled || seenEnabled || typingEnabled)
          ? async (events) => {
              // Acknowledge first: these are the cheap signals that the message
              // was picked up, and must not wait behind transcription.
              if (seenEnabled || typingEnabled) {
                const service = new TelegramService(config);
                try {
                  await service.connect();
                  // Saved Messages resolves to the account's own id.
                  const savedMessagesId = await service
                    .resolveChat('me')
                    .then((c) => String(c.id))
                    .catch(() => null);

                  const typingChats = new Set<string>();

                  // Failing open would resume reacting to our own notes, which
                  // is what the exclusion exists to prevent. Skip reactions for
                  // this batch instead; transcription and reporting continue.
                  if (savedMessagesId === null) {
                    process.stderr.write('[tg-watch] could not identify this account; skipping reactions\n');
                  }

                  for (const ev of events) {
                    if (savedMessagesId === null) break;
                    // Only new messages; re-acknowledging an edit says nothing.
                    if (ev.kind !== 'new') continue;
                    // Never acknowledge our own sends. The outgoing flag is not
                    // reliable in Saved Messages, where every message is yours,
                    // so that whole chat is excluded by id as well.
                    if (ev.msg.outgoing) continue;
                    if (savedMessagesId && ev.chatId === savedMessagesId) continue;

                    if (seenEnabled) {
                      await service.addReaction(ev.chatId, ev.msg.id, SEEN_EMOJI).catch(() => {
                        // Reactions are not allowed everywhere; never cost an event.
                      });
                    }
                    typingChats.add(ev.chatId);
                  }

                  // Then "typing…", once per chat rather than once per message,
                  // so a burst does not fire the same indicator repeatedly.
                  if (typingEnabled) {
                    for (const chatId of typingChats) {
                      await service.sendTyping(chatId).catch(() => {
                        // A courtesy indicator must never cost a message.
                      });
                    }
                  }
                } finally {
                  await service.disconnect();
                }
              }

              if (!transcribeEnabled) return;

              const stt = resolveSttBackends(loadConfig());
              if (stt.length === 0) return;

              // Events can span chats, and the cache is per chat, so group them.
              const byChat = new Map<string, WatchMessage[]>();
              for (const ev of events) {
                if (!ev.msg.hasMedia) continue;
                if (ev.msg.mediaType !== 'voice' && ev.msg.mediaType !== 'audio') continue;
                if (ev.msg.transcript) continue;
                const list = byChat.get(ev.chatId) ?? [];
                list.push(ev.msg);
                byChat.set(ev.chatId, list);
              }
              if (byChat.size === 0) return;

              const service = new TelegramService(config);
              try {
                await service.connect();

                // One budget for the whole burst, not one per chat: watching four
                // chats must not quadruple what a single flush can spend.
                let remaining = transcribeLimit;
                let cacheWriteFailures = 0;

                let transcribedAny = false;

                for (const [chatId, msgs] of byChat) {
                  // Keep going with a zero budget rather than breaking: a cache
                  // hit costs nothing and must still reach later chats' events.
                  const summary = await attachVoiceTranscripts(service, chatId, msgs, stt, {
                    maxDurationSeconds: transcribeMax,
                    maxMessages: Math.max(remaining, 0),
                  });
                  remaining -= summary.transcribed + summary.failed;
                  cacheWriteFailures += summary.cacheWriteFailures;
                  if (summary.transcribed > 0) transcribedAny = true;
                }

                // Same bound as the read path: only a burst that paid sweeps.
                if (transcribedAny) pruneTranscriptCache();

                if (cacheWriteFailures > 0) {
                  process.stderr.write(
                    `[tg-watch] warning: ${cacheWriteFailures} transcript(s) could not be cached; ` +
                    `they will be transcribed again\n`
                  );
                }
              } finally {
                await service.disconnect();
              }
            }
          : undefined,
      };

      // Resolve once and keep the peers: later polls pass them back and skip the dialog lookup.
      //
      // This used to exit(1) on any failure, which made a watcher die at startup
      // over a momentary network blip — the poll loop below survives outages, but
      // nothing ever reached it. Now a transient failure retries for ever; only a
      // genuinely permanent one (a mistyped chat, revoked credentials) still exits,
      // because retrying those would hang silently instead of telling anyone.
      let chats: WatchChat[] = [];
      try {
        chats = await retryForever(
          async () => {
            const resolver = new TelegramService(config);
            try {
              await resolver.connect();
              const resolved: WatchChat[] = [];
              for (const arg of chatArgs) {
                const peer = await resolver.resolveChat(arg);
                resolved.push({ id: String(peer.id), title: peer.title, peer });
              }
              return resolved;
            } finally {
              // A fresh connection per attempt: a half-open one is often what
              // broke, and reusing it would retry into the same dead socket.
              await resolver.disconnect().catch(() => {});
            }
          },
          {
            onRetry: (failures, delayMs, err) => {
              process.stdout.write(
                `[tg-watch] resolving chats failed (${failures}): ${err.message} — retrying in ${formatDelay(delayMs)}\n`
              );
            },
          }
        );
      } catch (err) {
        const message = (err as Error).message;
        process.stdout.write(`[tg-watch] ERROR resolving chats: ${message}\n`);
        console.error(chalk.red('❌ Error:'), message);
        process.exit(1);
      }

      if (options.reset) {
        for (const chat of chats) rmSync(watchStatePath(options.state, chat.id), { force: true });
      }

      const watcher = new TelegramWatcher(chats, opts, io, { sinceId });
      let delay = await watcher.tick(Date.now());

      const summary = chats.map((c) => `${c.title} (${c.id}) after #${watcher.lastId(c.id)}`).join(', ');
      process.stdout.write(
        `[tg-watch] watching ${summary}; poll ${opts.intervalMs / 1000}s, quiet ${opts.quietMs / 1000}s${opts.edits ? ', edits on' : ''}\n`
      );

      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = await watcher.tick(Date.now());
      }
    });
}
