/**
 * Whether a `bot watch` for a given bot is running on this machine right now.
 *
 * A Listen button on a message sent with the local token can only be answered by such a watcher: when the hub
 * polls the bot instead, the press goes to the hub, which can route it only for a message sent through the hub.
 * On 2026-10-08 a whole day of buttons went out with neither in place and every press did nothing, so the
 * sender checks rather than assumes.
 *
 * THE RULE: a watcher counts only when it is PROVEN to be receiving - the bot id it recorded equals the sender's,
 * it shares the sender's config dir (where the Listen text is stashed), and its own fresh heartbeat says its polls
 * are answered. Anything absent or unreadable is unknown, and unknown counts as no: a missing button is an
 * inconvenience the reader can see; a dead one is a silent failure they cannot tell from their own mistake.
 * `null` (the process table cannot be read here, no /proc) is unknown too, and the caller attaches nothing.
 */
import { readdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface WatcherProcess {
  pid: number;
  argv: string[];
  /** The process's own TELEGRAM_BOT, which picks its bot when it was started without --bot. */
  telegramBotEnv?: string;
  /** Where the process reads its configuration and keeps its watch state (unknown when its env is unreadable). */
  configDir?: string;
}

/** The state namespace a `bot watch` uses: its --state, else the bot's name (as `resolveStateName`). */
export function watcherStateName(proc: WatcherProcess, watched: string): string {
  const { argv } = proc;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--state' && i + 1 < argv.length) return argv[i + 1]!;
    if (argv[i]!.startsWith('--state=')) return argv[i]!.slice('--state='.length);
  }
  return watched;
}

/**
 * The Telegram bot id a running watcher actually polls: `bot watch` records it (from getMe) in its state when it
 * claims the namespace. A name is not an identity - two configurations can give one name to different bots, and a
 * token can change under a live watcher - so this, not the name, decides (Codex review). Null when unreadable.
 */
export function watcherBotId(proc: WatcherProcess, watched: string): number | null {
  if (proc.configDir === undefined) return null;
  try {
    const state = JSON.parse(readFileSync(join(proc.configDir, 'telegram-bot', watcherStateName(proc, watched).replace(/[^A-Za-z0-9_-]/g, '_'), 'offset.json'), 'utf-8')) as { botId?: unknown };
    return typeof state.botId === 'number' ? state.botId : null;
  } catch {
    return null;
  }
}

/**
 * A process's start time (field 22 of /proc/<pid>/stat, in clock ticks since boot), or null off Linux. With the pid
 * it names one process generation: a pid the kernel hands to a later process has a different start time, so a
 * heartbeat a predecessor left under the same pid is not read as this one's (Codex review).
 */
export function processStartTime(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
    // The command name (field 2) is parenthesised and may contain spaces; fields after it are space-separated.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const start = Number(fields[19]);
    return Number.isFinite(start) ? start : null;
  } catch {
    return null;
  }
}

/** A heartbeat older than this means the watcher is alive but not receiving (25 s polls: about seven missed). */
export const HEARTBEAT_FRESH_MS = 3 * 60_000;

/**
 * Whether the watcher is actually receiving: `bot watch` stamps alive-<pid>.json after every poll Telegram
 * answered. A revoked token keeps the same bot id but fails every poll, so the id alone cannot tell (Codex review).
 * `null` when it has no stamp of its own (a build before the stamp existed, or a reused pid): unknown, which the
 * caller does not count.
 */
export function watcherReceiving(
  proc: WatcherProcess,
  canonicalName: string,
  now = Date.now(),
  startTimeOf: (pid: number) => number | null = processStartTime,
): boolean | null {
  if (proc.configDir === undefined) return false;
  try {
    // This process's own file: another watcher on the same state, or an earlier one, writes its own.
    const path = join(proc.configDir, 'telegram-bot', watcherStateName(proc, canonicalName).replace(/[^A-Za-z0-9_-]/g, '_'), `alive-${proc.pid}.json`);
    const stamp = JSON.parse(readFileSync(path, 'utf-8')) as { at?: unknown; freshForMs?: unknown; ok?: unknown; startTime?: unknown };
    // Proof must name this process generation: a stamp without one, or from an earlier process that had this pid,
    // or one this machine cannot check, is unknown (Codex review).
    const started = startTimeOf(proc.pid);
    if (typeof stamp.startTime !== 'number' || started === null || stamp.startTime !== started) return null;
    // The watcher's own last poll failed.
    if (stamp.ok === false) return false;
    // The watcher states how long one healthy poll can take (its --timeout plus a margin): a quiet bot polled with
    // a long timeout stamps less often than HEARTBEAT_FRESH_MS without being stale (Codex review).
    const window = typeof stamp.freshForMs === 'number' ? Math.max(HEARTBEAT_FRESH_MS, stamp.freshForMs) : HEARTBEAT_FRESH_MS;
    return typeof stamp.at === 'number' && now - stamp.at <= window;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : false;
  }
}

/** A bot's id from its token: the digits before the colon (Bot API token format). Null when it is not that shape. */
export function botIdFromToken(token: string): number | null {
  const match = /^(\d{5,15}):/.exec(token.trim());
  return match ? Number(match[1]) : null;
}

/** The configuration a process with this environment reads (mirrors `getConfigDir`, Linux branch). */
export function configDirFor(env: Readonly<Record<string, string | undefined>>, home = homedir()): string {
  if (env['CLAUDE_TOOLS_CONFIG_DIR']) return env['CLAUDE_TOOLS_CONFIG_DIR'];
  return join(env['XDG_CONFIG_HOME'] || join(env['HOME'] || home, '.config'), 'claude-tools');
}

/** The bot a `bot watch` command line watches, or null when the command line is not a bot watch. */
export function watchedBot(proc: WatcherProcess, defaultBot: string | undefined): string | null {
  const { argv } = proc;
  const at = argv.findIndex((arg, i) => arg === 'bot' && argv[i + 1] === 'watch');
  if (at < 0) return null;
  for (let i = at + 2; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--bot' && i + 1 < argv.length) return argv[i + 1]!;
    if (arg.startsWith('--bot=')) return arg.slice('--bot='.length);
  }
  // An empty TELEGRAM_BOT is unset, as config loading treats it (Codex review).
  return proc.telegramBotEnv?.trim() || defaultBot || null;
}

function readProcesses(): WatcherProcess[] | null {
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return null;
  }
  const out: WatcherProcess[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    try {
      const argv = readFileSync(`/proc/${entry}/cmdline`, 'utf-8').split('\0').filter((part) => part.length > 0);
      if (!argv.includes('watch') || !argv.includes('bot')) continue;
      let env: Record<string, string> | undefined;
      try {
        env = {};
        for (const pair of readFileSync(`/proc/${entry}/environ`, 'utf-8').split('\0')) {
          const at = pair.indexOf('=');
          if (at > 0) env[pair.slice(0, at)] = pair.slice(at + 1);
        }
      } catch {
        // Another user's process: its configuration cannot be read, so it is not counted (see localBotWatchRunning).
        env = undefined;
      }
      out.push({
        pid,
        argv,
        ...(env?.['TELEGRAM_BOT'] === undefined ? {} : { telegramBotEnv: env['TELEGRAM_BOT'] }),
        ...(env === undefined ? {} : { configDir: configDirFor(env) }),
      });
    } catch {
      // The process exited while being read.
    }
  }
  return out;
}

/** True or false when the process table could be read; null when it cannot be read on this machine. */
export function localBotWatchRunning(
  botName: string,
  defaultBot: string | undefined,
  processes: () => WatcherProcess[] | null = readProcesses,
  /** The id of the bot the sender will send as (`botIdFromToken` of its token). */
  botId: number | null,
  botIdOf: (proc: WatcherProcess, watched: string) => number | null = watcherBotId,
  /**
   * The sender's config dir. The Listen text is stashed there and the watcher reads it from its own, so only a
   * watcher sharing it can speak the message (Codex review).
   */
  configDir: string = configDirFor(process.env),
  receiving: (proc: WatcherProcess, watched: string) => boolean | null = (proc, watched) => watcherReceiving(proc, watched),
): boolean | null {
  const list = processes();
  if (list === null) return null;
  // Normalised as bot selection normalises a name (trimmed, case-insensitive), so a watcher started with
  // TELEGRAM_BOT=' PERSONAL ' still counts (Codex review).
  const norm = (name: string): string => name.trim().toLowerCase();
  return list.some((proc) => {
    const watched = watchedBot(proc, defaultBot);
    if (watched === null || norm(watched) !== norm(botName)) return false;
    // The same bot only if the watcher polls the same bot id the sender sends as. An unknown id on either side is
    // not counted: no button beats a dead one.
    // Looked up under the canonical name (the sender's, which matched): a watcher selected by ' PERSONAL ' keeps its
    // state under the name its configuration gives the bot, as `resolveStateName` does.
    if (botId === null || botIdOf(proc, botName) !== botId) return false;
    if (proc.configDir !== configDir) return false;
    // Proven receiving only by its own fresh stamp. No stamp (an older build, a reused pid) is unknown, and
    // unknown is not counted: no button beats a dead one.
    return receiving(proc, botName) === true;
  });
}
