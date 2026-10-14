// Gmail commands, READ-ONLY over IMAP with an app password from the secrets file.
//
//   gmail watch   one line per new message (for watch_start / a systemd unit)
//   gmail count   messages per day by category, from Gmail searches - ids only, nothing fetched
//   gmail check   the setup, and proof that reading leaves the unread count unchanged
//   gmail list    recent messages, one line each, narrowed like a Gmail search
//   gmail read    one message: headers, attachments by name, and the text (it stays unread)
//
// The client underneath refuses every command that could change the mailbox, and this tool has no
// SMTP at all; see services/imap-readonly.ts. Marking read, archiving or sending would be separate
// commands with their own names, never flags on these.

import { Command } from 'commander';
import chalk from 'chalk';
import { rmSync } from 'fs';
import { loadConfig } from '../../config/loader.js';
import type { GmailAccount } from '../../config/types.js';
import { backoffDelay, formatDelay, sleep } from '../../services/backoff.js';
import { redactSecrets } from '../../services/redact.js';
import { outboxUnsupportedReason, writeOutbox } from '../../services/outbox.js';
import { ImapAuthError, ImapWriteRefused } from '../../services/imap-readonly.js';
import {
  CATEGORIES,
  GmailWatcher,
  ImapMailSource,
  countByDay,
  countSeen,
  defaultStatePath,
  formatNotice,
  makeScrubber,
  gmailWatchStatePath,
  loadGmailWatchState,
  saveGmailWatchState,
  type Category,
} from '../../services/gmail-watch.js';
import { formatListed, formatRead, isCategory, listSearch, parseMessageRef } from '../../services/gmail-read.js';
import { parseMail } from '../../services/mail-mime.js';

/** Exit code for a login the server refused: the watcher stops and a human re-creates the password. */
export const EXIT_AUTH = 3;

const DEFAULT_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

function positiveInt(value: string, name: string, allowZero = false): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || (!allowZero && n === 0)) {
    console.error(chalk.red(`--${name} must be a ${allowZero ? 'non-negative' : 'positive'} integer`));
    process.exit(1);
  }
  return n;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, ...value.split(',').map((v) => v.trim().toLowerCase()).filter(Boolean)];
}

/**
 * Removes every configured app password from text, raw and with spaces stripped. Server error text is
 * printed, and nothing guarantees a server never echoes a credential, so it is scrubbed regardless.
 */
export function scrubPasswords(text: string, accounts?: GmailAccount[]): string {
  return (accounts ? makeScrubber(accounts.map((a) => a.appPassword)) : processScrubber())(text);
}

/**
 * The scrubber for this process, built ONCE from the credentials configured at start: a password
 * still in use stays covered even if the secrets file is rotated while the watcher runs.
 */
let scrubberForProcess: ((text: string) => string) | null = null;
/** For tests only: forget the process scrubber so a test can build it from a known file. */
export function resetScrubberForTests(): void {
  scrubberForProcess = null;
}
function initScrubber(accounts: GmailAccount[]): void {
  scrubberForProcess ??= makeScrubber(accounts.map((a) => a.appPassword));
}
function processScrubber(): (text: string) => string {
  if (!scrubberForProcess) initScrubber(loadConfig().gmail);
  return scrubberForProcess!;
}

/** Set by --outbox: lines go to durable files there instead of stdout. */
let outboxDir: string | undefined;

function writeOut(text: string): Promise<void> {
  const safe = scrubPasswords(redactSecrets(text));
  if (outboxDir) {
    // Synchronous and fsynced: the line is on disk before the caller saves its cursor.
    try {
      writeOutbox(outboxDir, safe);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  }
  return new Promise((resolve, reject) => {
    process.stdout.write(safe, (error) => (error ? reject(error) : resolve()));
  });
}

/**
 * The configured mailboxes matching `selector` (a full address, or the part before the @), or all of
 * them. Exits when none is configured or the selector matches nothing.
 */
export function selectAccounts(selector?: string): GmailAccount[] {
  const accounts = loadConfig().gmail;
  // The scrubber is fixed HERE, from the very account objects this command will log in with, before
  // any connection: a rotation of the secrets file later cannot leave the password in use uncovered.
  initScrubber(accounts);
  if (accounts.length === 0) {
    console.error(chalk.red('Gmail is not configured: add "gmail": { "accounts": [ { "user": "...", "appPassword": "..." } ] } to the claude-tools secrets file.'));
    console.error(chalk.dim('The app password comes from myaccount.google.com -> Security -> App passwords (needs 2-Step Verification).'));
    process.exit(1);
  }
  if (!selector) return accounts;
  const want = selector.toLowerCase();
  const hit = accounts.filter((a) => a.user.toLowerCase() === want || a.user.toLowerCase().split('@')[0] === want);
  if (hit.length === 0) {
    console.error(chalk.red(`No Gmail account matches "${selector}". Configured: ${accounts.map((a) => a.user).join(', ')}`));
    process.exit(1);
  }
  return hit;
}

function exitOnSignals(): void {
  process.stdout.on('error', (error: NodeJS.ErrnoException) => process.exit(error.code === 'EPIPE' ? 0 : 1));
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGHUP', () => process.exit(0));
}

interface WatchCliOptions {
  account?: string;
  label?: string;
  interval: string;
  maxText: string;
  maxPerPoll: string;
  maxBacklog: string;
  heartbeat: string;
  state?: string;
  reset?: boolean;
  json?: boolean;
  once?: boolean;
  outbox?: string;
  excludeCategory: string[];
}

export function registerGmailCommands(program: Command): void {
  const gmail = program
    .command('gmail')
    .description('Gmail, read-only over IMAP (app password in the secrets file)');

  gmail
    .command('watch')
    .description('Print one line per new message in All Mail, spam excluded (for watch_start / Monitor)')
    .option('--account <address>', 'Which mailbox (address, or the part before @); needed when several are configured')
    .option('--label <text>', 'Prefix lines with [<text>] instead of [mail <address>], e.g. "📬 personal"')
    .option('--interval <sec>', 'Poll interval in seconds', '30')
    .option('--max-text <n>', 'Truncate subjects to this many characters', '200')
    .option('--max-per-poll <n>', 'Most message lines per poll; the rest become one summary line', '20')
    .option('--max-backlog <n>', 'Above this many new messages at once, report only the count', '2000')
    .option('--heartbeat <hours>', 'Print an "alive" line this often, proven by a server round trip (0 = off)', '24')
    .option('--state <name>', 'State namespace (default: the mailbox address); distinct per watcher of one mailbox')
    .option('--reset', 'Discard saved state and re-baseline at the newest message')
    .option('--exclude-category <cat>', `Drop these Gmail categories: ${CATEGORIES.join(', ')}, primary (repeatable)`, collect, [])
    .option('--json', 'Print one JSON object per line')
    .option('--once', 'Poll once and exit (for checking the setup)')
    .option('--outbox <dir>', 'Write each line as its own fsynced file in <dir> instead of stdout; the reader deletes a file once delivered')
    .addHelpText('after', `
${chalk.yellow('Behaviour:')}
  Opens Gmail's All Mail folder READ-ONLY (EXAMINE) and reports messages that
  arrive after the saved position: everything except Spam and Trash, minus his
  own sent mail and drafts. Only From, Subject and Date are read, with
  BODY.PEEK, so nothing is marked read. The first run records a baseline and
  prints nothing. A restarted watcher reports what arrived while it was down,
  at most --max-per-poll lines per poll plus one "+N more" line.

  One process watches one mailbox, and every line names it, so several watchers
  fail independently and their lines can share a destination.

  A refused login prints "[mail <account>] ERROR re-authentication needed" and exits ${EXIT_AUTH}
  without retrying; repeated failed logins can lock the account. Changing the
  Google password revokes the app password.

${chalk.yellow('Line format:')}
  [mail <account>] <HH:MM> <category> <from>: <subject> <link>

${chalk.yellow('Examples:')}
  claude-tools gmail watch --account me@gmail.com --exclude-category promotions,social
  watch_start({ name: "mail", command: ["node", "<path>/dist/cli.js", "gmail", "watch", "--account", "me@gmail.com"] })
`)
    .action(async (options: WatchCliOptions) => {
      const selected = selectAccounts(options.account);
      if (selected.length !== 1) {
        console.error(chalk.red(`Several Gmail accounts are configured; pick one with --account (${selected.map((a) => a.user).join(', ')}). Run one watcher per mailbox.`));
        process.exit(1);
      }
      const creds = selected[0];
      outboxDir = options.outbox;
      // An empty value (an unset variable in a unit file) must not fall back to stdout silently.
      const unsupported = options.outbox === undefined ? null
        : options.outbox.trim() === '' ? '--outbox needs a directory; it was given an empty value'
          : outboxUnsupportedReason();
      if (unsupported) {
        console.error(chalk.red(unsupported));
        process.exit(1);
      }
      const json = !!options.json;
      const notice = (text: string) => writeOut(`${formatNotice(text, { account: creds.user, label: options.label, json, scrub: processScrubber() })}\n`);
      const intervalMs = positiveInt(options.interval, 'interval') * 1000;
      const heartbeatMs = positiveInt(options.heartbeat, 'heartbeat', true) * 3_600_000;
      const exclude = options.excludeCategory as Category[];
      for (const c of exclude) {
        if (c !== 'primary' && !(CATEGORIES as readonly string[]).includes(c)) {
          console.error(chalk.red(`--exclude-category: unknown category "${c}"`));
          process.exit(1);
        }
      }
      const statePath = options.state ? gmailWatchStatePath(options.state) : defaultStatePath(creds.user, { reset: options.reset });
      if (options.reset && options.state) rmSync(statePath, { force: true });
      exitOnSignals();

      const watcher = new GmailWatcher({
        maxText: positiveInt(options.maxText, 'max-text'),
        maxPerPoll: positiveInt(options.maxPerPoll, 'max-per-poll'),
        json,
        timeZone: DEFAULT_TZ,
        excludeCategories: exclude,
        maxBacklog: positiveInt(options.maxBacklog, 'max-backlog'),
        scrub: processScrubber(),
        account: creds.user,
        label: options.label,
      }, {
        source: new ImapMailSource(creds.user, creds.appPassword),
        loadState: () => loadGmailWatchState(statePath),
        saveState: (s) => saveGmailWatchState(statePath, s),
        emit: (lines) => writeOut(`${lines.join('\n')}\n`),
      });

      let failures = 0;
      let lastHeartbeat = Date.now();
      let announced = false;
      for (;;) {
        try {
          await watcher.tick();
          if (failures > 0) await notice('recovered');
          failures = 0;
          if (!announced) {
            announced = true;
            await notice(`watching All Mail (read-only); poll ${formatDelay(intervalMs)}` +
              `${exclude.length ? `; excluding ${exclude.join(',')}` : ''}`);
            if (options.once) process.exit(0);
          }
          if (heartbeatMs > 0 && Date.now() - lastHeartbeat >= heartbeatMs) {
            lastHeartbeat = Date.now();
            const n = watcher.takeReportedCount();
            await notice(`alive; server answered at ${watcher.lastOkAt()}; ${n} new message(s) reported in the last ${options.heartbeat}h`);
          }
          await sleep(intervalMs);
        } catch (err) {
          if (err instanceof ImapAuthError) {
            await notice(`ERROR ${err.message}`);
            process.exit(EXIT_AUTH);
          }
          if (err instanceof ImapWriteRefused) {
            // A bug in this tool, never a server condition: stop rather than retry.
            await notice(`ERROR ${err.message}`);
            process.exit(1);
          }
          failures++;
          const delay = backoffDelay(failures);
          // Say it once per outage, not once per retry.
          if (failures === 1) await notice(`ERROR ${(err as Error).message} (retrying)`);
          if (options.once) process.exit(1);
          await watcher.reset();
          await sleep(delay);
        }
      }
    });

  gmail
    .command('count')
    .description('Count incoming mail per day by Gmail category (ids only; no message is read)')
    .option('--account <address>', 'Only this mailbox (default: every configured one, each counted separately)')
    .option('--days <n>', 'How many days back, today included', '30')
    .option('--tz <zone>', 'Time zone for day boundaries', DEFAULT_TZ)
    .option('--json', 'Print JSON')
    .action(async (options: { account?: string; days: string; tz: string; json?: boolean }) => {
      const days = positiveInt(options.days, 'days');
      const results: { account: string; rows?: Awaited<ReturnType<typeof countByDay>>; error?: string }[] = [];
      for (const creds of selectAccounts(options.account)) {
        const source = new ImapMailSource(creds.user, creds.appPassword);
        try {
          await source.open();
          results.push({ account: creds.user, rows: await countByDay(source, days, new Date(), options.tz) });
        } catch (err) {
          // One mailbox failing must not hide the others' numbers.
          results.push({ account: creds.user, error: scrubPasswords(redactSecrets((err as Error).message)) });
          if (err instanceof ImapAuthError) process.exitCode = EXIT_AUTH;
          else if (!process.exitCode) process.exitCode = 1;
        } finally {
          await source.close();
        }
      }
      if (options.json) {
        console.log(JSON.stringify(results, null, 2));
        return;
      }
      const cols = ['primary', 'updates', 'promotions', 'social', 'forums'] as const;
      for (const r of results) {
        console.log(chalk.bold(`\n${r.account}`));
        if (r.error || !r.rows) {
          console.log(chalk.red(`  FAILED: ${r.error}`));
          continue;
        }
        console.log(['day       ', 'total', ...cols, 'automated'].join('\t'));
        const sum = { total: 0, automated: 0, ...Object.fromEntries(cols.map((c) => [c, 0])) } as Record<string, number>;
        for (const row of r.rows) {
          console.log([row.day, row.total, ...cols.map((c) => row.categories[c]), row.automated].join('\t'));
          sum.total += row.total; sum.automated += row.automated;
          for (const c of cols) sum[c] += row.categories[c];
        }
        console.log(['total     ', sum.total, ...cols.map((c) => sum[c]), sum.automated].join('\t'));
        console.log(chalk.dim(`Per day: ${(sum.total / days).toFixed(1)} on average over ${days} day(s), time zone ${options.tz}.`));
      }
      console.log(chalk.dim('\nCategories are Gmail\'s own tabs and add up to the total. ' +
        '"automated" is a sender-address match and overlaps them.'));
    });

  gmail
    .command('check')
    .description('Check each mailbox: login, All Mail found, the write guard holds, and reading leaves unread mail unread')
    .option('--account <address>', 'Only this mailbox (default: every configured one)')
    .action(async (options: { account?: string }) => {
      let failed = false;
      const say = (ok: boolean, text: string) => {
        if (!ok) failed = true;
        console.log(`${ok ? chalk.green('ok  ') : chalk.red('FAIL')} ${text}`);
      };
      for (const creds of selectAccounts(options.account)) {
        console.log(chalk.bold(`\n${creds.user}`));
        const source = new ImapMailSource(creds.user, creds.appPassword);
        try {
          const { mailbox, uidValidity } = await source.open();
          say(true, `logged in; All Mail is "${mailbox}" (UIDVALIDITY ${uidValidity}), opened READ-ONLY`);

          // The guard is local: prove it refuses before anything reaches the server.
          try {
            await source.imap.command('UID STORE 1 +FLAGS (\\Seen)');
            say(false, 'the write guard let STORE through');
          } catch (e) {
            say(e instanceof ImapWriteRefused, `the write guard refuses STORE (${(e as Error).message})`);
          }

          // The control that matters: read the headers of UNREAD messages, then confirm they are
          // still unread. Reading mail that is already read could not show a \Seen leak.
          const unread = (await source.imap.uidSearch('UNSEEN')).sort((a, b) => a - b).slice(-3);
          // Every sampled message must answer with FLAGS both times; a missing answer (expunged, or
          // a partial response) makes the check inconclusive, never a pass.
          const seenFlags = async (): Promise<number | null> => countSeen(unread, await source.imap.uidFetch(unread.join(','), 'UID FLAGS'));
          if (unread.length === 0) {
            say(true, 'no unread mail to test the read-only claim against (skipped, not passed)');
          } else {
            const before = await seenFlags();
            const metas = await source.describe(unread);
            // The whole message too, as `gmail read` fetches it (BODY.PEEK[]), capped small.
            let bodies = 0;
            for (const uid of unread) if (await source.fetchRaw(uid, 65_536)) bodies++;
            const after = await seenFlags();
            say(metas.length === unread.length, `read the headers of ${unread.length} unread message(s)`);
            say(bodies === unread.length, `read the text of the same ${unread.length}, as gmail read does`);
            if (before === null || after === null) {
              say(false, 'inconclusive: a sampled message did not report its flags (expunged meanwhile?); run check again');
            } else {
              say(before === 0 && after === 0, `they are still unread afterwards (\\Seen on ${before} before, ${after} after)`);
            }
            const inbox = await source.status('INBOX');
            console.log(chalk.dim(`  INBOX: ${inbox.messages} messages, ${inbox.unseen} unread`));
          }
        } catch (err) {
          say(false, scrubPasswords(redactSecrets((err as Error).message)));
          if (err instanceof ImapAuthError) process.exitCode = EXIT_AUTH;
        } finally {
          await source.close();
        }
      }
      if (failed && !process.exitCode) process.exitCode = 1;
    });
  gmail
    .command('list')
    .description('List recent messages, newest first, one line each (headers only; nothing is marked read)')
    .option('--account <address>', 'Only this mailbox (default: every configured one)')
    .option('--limit <n>', 'Most messages per mailbox', '20')
    .option('--days <n>', 'Only the last n days')
    .option('--from <sender>', 'Only from this sender (an address, a domain or a name, as Gmail matches it)')
    .option('--unread', 'Only unread messages')
    .option('--category <cat>', `Only this Gmail category: primary, ${CATEGORIES.join(', ')}`)
    .option('--include-sent', 'Include his own sent mail and drafts')
    .option('--query <search>', 'Any further Gmail search, as typed in the Gmail search box (e.g. "has:attachment invoice")')
    .option('--max-text <n>', 'Truncate subjects to this many characters', '120')
    .option('--tz <zone>', 'Time zone for the times shown', DEFAULT_TZ)
    .option('--json', 'Print one JSON object per message')
    .addHelpText('after', `
${chalk.yellow('Line format:')}
  <id>  <Mon DD HH:MM>  <• when unread> <category> <from>: <subject>

  The id is Gmail's own (the end of the message's web address); pass it to
  \`gmail read <id>\`. Spam and trash are never listed; his sent mail and drafts
  only with --include-sent.

${chalk.yellow('Examples:')}
  claude-tools gmail list --account me@gmail.com --limit 10
  claude-tools gmail list --unread --days 2 --category primary
  claude-tools gmail list --from github.com --query "has:attachment"
`)
    .action(async (options: {
      account?: string; limit: string; days?: string; from?: string; unread?: boolean; category?: string;
      includeSent?: boolean; query?: string; maxText: string; tz: string; json?: boolean;
    }) => {
      const limit = positiveInt(options.limit, 'limit');
      const days = options.days === undefined ? undefined : positiveInt(options.days, 'days');
      const maxText = positiveInt(options.maxText, 'max-text');
      const category = options.category?.trim().toLowerCase();
      if (category !== undefined && !isCategory(category)) {
        console.error(chalk.red(`--category: unknown category "${options.category}" (primary, ${CATEGORIES.join(', ')})`));
        process.exit(1);
      }
      const search = listSearch({
        days, from: options.from, unread: options.unread, category: category as Category | undefined,
        includeSent: options.includeSent, query: options.query,
      });
      const accounts = selectAccounts(options.account);
      for (const creds of accounts) {
        const source = new ImapMailSource(creds.user, creds.appPassword);
        try {
          await source.open();
          const matching = (await source.search(search)).sort((a, b) => b - a);
          const shown = await source.summarize(matching.slice(0, limit));
          if (!options.json && accounts.length > 1) console.log(chalk.bold(`\n${creds.user}`));
          for (const m of shown) {
            console.log(formatListed(m, { account: creds.user, maxText, json: !!options.json, timeZone: options.tz, scrub: processScrubber() }));
          }
          if (!options.json) {
            console.log(chalk.dim(matching.length === 0
              ? `No messages match (${creds.user}).`
              : `${shown.length} of ${matching.length} matching shown (${creds.user}); read one with: gmail read <id>`));
          }
        } catch (err) {
          const message = scrubPasswords(redactSecrets((err as Error).message));
          if (options.json) console.log(JSON.stringify({ account: creds.user, error: message }));
          else console.error(chalk.red(`${creds.user}: FAILED: ${message}`));
          if (err instanceof ImapAuthError) process.exitCode = EXIT_AUTH;
          else if (!process.exitCode) process.exitCode = 1;
        } finally {
          await source.close();
        }
      }
    });

  gmail
    .command('read <id>')
    .description('Print one message: headers, attachments by name, and its text. It stays unread')
    .option('--account <address>', 'The mailbox it is in (default: a link\'s own mailbox, else each configured one in turn)')
    .option('--max-chars <n>', 'Cut the text after this many characters', '20000')
    .option('--max-bytes <n>', 'Fetch at most this many bytes of the raw message (attachments past it are cut)', '5000000')
    .option('--tz <zone>', 'Time zone for the date shown', DEFAULT_TZ)
    .option('--json', 'Print JSON')
    .addHelpText('after', `
${chalk.yellow('Behaviour:')}
  <id> is the id \`gmail list\` prints, or a Gmail web link ending in one.
  The message is fetched with BODY.PEEK[] from All Mail opened READ-ONLY, so
  it is not marked read. HTML-only mail is reduced to text with its links kept.
  Attachments are named with their size; nothing is saved to disk.

${chalk.yellow('Examples:')}
  claude-tools gmail read 19a2b3c4d5e6f708 --account me@gmail.com
  claude-tools gmail read "https://mail.google.com/mail/u/me%40gmail.com/#all/19a2b3c4d5e6f708"
`)
    .action(async (id: string, options: { account?: string; maxChars: string; maxBytes: string; tz: string; json?: boolean }) => {
      const ref = parseMessageRef(id);
      if ('error' in ref) {
        console.error(chalk.red(ref.error));
        process.exit(1);
      }
      const maxChars = positiveInt(options.maxChars, 'max-chars');
      const maxBytes = positiveInt(options.maxBytes, 'max-bytes');
      const accounts = selectAccounts(options.account ?? ref.account);
      const failures: string[] = [];
      for (const creds of accounts) {
        const source = new ImapMailSource(creds.user, creds.appPassword);
        try {
          await source.open();
          const uid = await source.findByGmailId(ref.msgId);
          if (uid === null) continue;
          const [meta] = await source.summarize([uid]);
          const fetched = await source.fetchRaw(uid, maxBytes);
          if (!fetched) continue; // expunged between the search and the fetch
          const mail = parseMail(fetched.raw, { truncated: fetched.truncated });
          console.log(formatRead(mail, {
            account: creds.user, msgId: ref.msgId, labels: meta?.labels ?? [], unread: meta?.unread ?? null,
            size: fetched.size, maxChars, json: !!options.json, timeZone: options.tz, scrub: processScrubber(),
          }));
          // Found: a mailbox that failed before this one is worth a warning, not a failed command.
          for (const f of failures) console.error(chalk.yellow(`warning: could not search ${f}`));
          process.exitCode = 0;
          return;
        } catch (err) {
          failures.push(`${creds.user}: ${scrubPasswords(redactSecrets((err as Error).message))}`);
          if (err instanceof ImapAuthError) process.exitCode = EXIT_AUTH;
        } finally {
          await source.close();
        }
      }
      for (const f of failures) console.error(chalk.red(`FAILED ${f}`));
      console.error(chalk.red(`No message ${id} in ${accounts.map((a) => a.user).join(', ')}${failures.length ? ' (a mailbox could not be searched; see above)' : ''}.`));
      if (!process.exitCode) process.exitCode = 1;
    });
}
