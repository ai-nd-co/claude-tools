// Prune contacts command - interactively delete saved Telegram contacts that
// have no 1-on-1 chat history (e.g. junk auto-imported by "Sync Contacts").

import { Command } from 'commander';
import chalk from 'chalk';
import * as readline from 'readline';
import { writeFileSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { loadConfig } from '../../config/loader.js';
import { TelegramService, type TelegramContact } from '../../services/telegram.js';

const CSV_HEADER = 'delete,name,username,phone,id,accessHash';
const DELETE_TRUTHY = new Set(['yes', 'y', 'x', 'true', '1', 'delete', 'd']);

/** Quote a CSV field if it contains comma, quote, or newline (RFC 4180). */
function csvField(value: string): string {
  const v = value ?? '';
  if (/[",\n\r]/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

/** Build the reviewable CSV text from candidates (delete column defaults to "no"). */
function buildCandidatesCsv(candidates: TelegramContact[]): string {
  const rows = candidates.map((c) =>
    [
      'no',
      csvField(displayName(c)),
      csvField(c.username ?? ''),
      csvField(c.phone ?? ''),
      csvField(c.id),
      csvField(c.accessHash ?? ''),
    ].join(',')
  );
  return [CSV_HEADER, ...rows].join('\n') + '\n';
}

/** Parse one CSV line into fields, handling quoted values. */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

/**
 * Read a reviewed CSV and return the rows marked for deletion.
 * Expects the header produced by buildCandidatesCsv; tolerates column reordering
 * by matching header names, falling back to positional order.
 */
function readMarkedRows(filePath: string): Array<{ name: string; username: string; id: string; accessHash: string }> {
  const text = readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    throw new Error('File is empty.');
  }

  const header = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const col = (name: string, fallback: number) => {
    const idx = header.indexOf(name);
    return idx >= 0 ? idx : fallback;
  };
  const di = col('delete', 0);
  const ni = col('name', 1);
  const ui = col('username', 2);
  const ii = col('id', 4);
  const ai = col('accesshash', 5);

  const marked: Array<{ name: string; username: string; id: string; accessHash: string }> = [];
  for (let i = 1; i < lines.length; i++) {
    const f = parseCsvLine(lines[i]);
    const flag = (f[di] ?? '').trim().toLowerCase();
    if (!DELETE_TRUTHY.has(flag)) continue;
    const id = (f[ii] ?? '').trim();
    if (!id) continue; // can't delete without an id
    marked.push({
      name: (f[ni] ?? '').trim(),
      username: (f[ui] ?? '').trim(),
      id,
      accessHash: (f[ai] ?? '').trim(),
    });
  }
  return marked;
}

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

function displayName(c: TelegramContact): string {
  const parts = [c.firstName, c.lastName].filter(Boolean);
  if (parts.length > 0) return parts.join(' ');
  if (c.username) return `@${c.username}`;
  return '(no name)';
}

function makeAsker() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, (a) => resolve(a.trim().toLowerCase())));
  return { ask, close: () => rl.close() };
}

export function registerPruneContactsCommand(telegram: Command): void {
  telegram
    .command('prune-contacts')
    .description('Delete saved contacts that have no chat history (interactive, file-review, or list)')
    .option('--dry-run', 'List candidates without deleting anything')
    .option('--export <file>', 'Write no-chat candidates to a reviewable CSV (no deletion)')
    .option('--from-file <file>', 'Delete contacts marked delete=yes in a reviewed CSV')
    .option('--limit <n>', 'Max dialogs to scan for chat history', '1000')
    .option('--no-backup-check', 'Skip the "have you backed up?" confirmation gate')
    .option('--yes', 'Skip all confirmation prompts (non-interactive; use with --from-file)')
    .addHelpText('after', `
${chalk.yellow('Before you run this:')}
  ${chalk.dim('1. Back up first: claude-tools telegram contacts --out backup.vcf')}
  ${chalk.dim('2. On your phone, turn OFF Settings -> Privacy & Security ->')}
  ${chalk.dim('   Contacts -> "Sync Contacts" (and tap "Delete Synced Contacts").')}
  ${chalk.dim('   Otherwise deleted contacts get re-imported from your phonebook.')}

${chalk.yellow('Review-as-file workflow (recommended for large lists):')}
  ${chalk.dim('# 1. Export candidates to a CSV you can open in Excel/Sheets')}
  claude-tools telegram prune-contacts --export candidates.csv
  ${chalk.dim('# 2. Edit the file: set the "delete" column to yes for ones to remove')}
  ${chalk.dim('# 3. Delete only the marked rows')}
  claude-tools telegram prune-contacts --from-file candidates.csv

${chalk.yellow('Other modes:')}
  ${chalk.dim('# Safe terminal preview, deletes nothing')}
  claude-tools telegram prune-contacts --dry-run

  ${chalk.dim('# Interactive deletion (d=delete, s=skip, q=quit)')}
  claude-tools telegram prune-contacts
`)
    .action(async (options: { dryRun?: boolean; export?: string; fromFile?: string; limit: string; backupCheck?: boolean; yes?: boolean }) => {
      const config = ensureTelegramConfig();
      const service = new TelegramService(config);

      try {
        await service.connect();

        const [contacts, chatUserIds] = await Promise.all([
          service.getContacts(),
          service.getDialogUserIds(parseInt(options.limit, 10)),
        ]);

        // ---- Mode: delete from a reviewed CSV (--from-file) ----
        // This path deletes exactly the rows the user marked, validated against the
        // live contact list. It does NOT depend on the no-chat filter.
        if (options.fromFile) {
          const inPath = resolve(process.cwd(), options.fromFile);
          let marked: ReturnType<typeof readMarkedRows>;
          try {
            marked = readMarkedRows(inPath);
          } catch (err) {
            console.error(chalk.red(`❌ Could not read ${inPath}: ${(err as Error).message}`));
            await service.disconnect();
            process.exit(1);
          }

          if (marked.length === 0) {
            console.log(chalk.yellow('\nNo rows marked for deletion (delete column not set to "yes").'));
            await service.disconnect();
            return;
          }

          // Validate each marked id against the live contact list. Only delete
          // contacts that still exist; report anything stale/unknown.
          const byId = new Map(contacts.map((c) => [c.id, c]));
          const toDelete: TelegramContact[] = [];
          const unknown: typeof marked = [];
          for (const m of marked) {
            const live = byId.get(m.id);
            if (live) toDelete.push(live);
            else unknown.push(m);
          }

          console.log(chalk.bold(`\n📇 ${marked.length} rows marked for deletion in ${options.fromFile}.`));
          if (unknown.length > 0) {
            console.log(chalk.yellow(`⚠  ${unknown.length} marked row(s) no longer match a live contact and will be skipped:`));
            unknown.slice(0, 10).forEach((m) => console.log(chalk.dim(`   - ${m.name || m.username || m.id}`)));
            if (unknown.length > 10) console.log(chalk.dim(`   ...and ${unknown.length - 10} more`));
          }
          if (toDelete.length === 0) {
            console.log(chalk.green('Nothing valid to delete.'));
            await service.disconnect();
            return;
          }

          console.log(chalk.green('\nℹ  This removes the CONTACT entry only. Chat history and messages are NOT deleted.'));
          console.log(chalk.yellow('⚠  Deleting removes these contacts from Telegram on ALL your devices.'));
          console.log(chalk.yellow('⚠  Turn OFF "Sync Contacts" on your phone first or they get re-imported.'));

          if (options.yes) {
            console.log(chalk.dim(`\n--yes: skipping prompts, deleting ${toDelete.length} contact(s)...`));
          } else {
            const { ask, close } = makeAsker();
            if (options.backupCheck !== false) {
              const ok = await ask(
                chalk.bold('\nHave you backed up (telegram contacts --out backup.vcf)? Type "yes": ')
              );
              if (ok !== 'yes') {
                console.log(chalk.dim('Aborted. Back up first, then re-run.'));
                close();
                await service.disconnect();
                return;
              }
            }
            const confirm = await ask(
              chalk.bold(`Delete ${toDelete.length} contact(s)? Type "yes" to confirm: `)
            );
            close();
            if (confirm !== 'yes') {
              console.log(chalk.dim('Aborted. Nothing deleted.'));
              await service.disconnect();
              return;
            }
          }

          // Delete in ONE batched request (service chunks at 50). Telegram
          // flood-limits rapid per-contact calls, so batching avoids FLOOD_WAIT.
          let deleted = 0;
          let failed = 0;
          try {
            await service.deleteContacts(
              toDelete.map((c) => ({ id: c.id, accessHash: c.accessHash }))
            );
            deleted = toDelete.length;
            console.log(chalk.green(`  ✅ deleted ${deleted} contact(s) in one batch.`));
          } catch (err) {
            failed = toDelete.length;
            const msg = (err as Error).message;
            console.log(chalk.red(`  ❌ batch delete failed: ${msg}`));
            if (/wait of (\d+) seconds/i.test(msg)) {
              const secs = msg.match(/wait of (\d+) seconds/i)?.[1];
              console.log(chalk.yellow(`  ⚠  Telegram rate limit (FLOOD_WAIT). Wait ~${secs}s and re-run the same command.`));
              console.log(chalk.dim('     Already-deleted contacts are auto-skipped on re-run.'));
            }
          }
          console.log(chalk.bold(`\nDone. Deleted ${deleted}${failed ? `, ${failed} failed` : ''}${unknown.length ? `, ${unknown.length} skipped (stale)` : ''}.`));
          if (deleted > 0) {
            console.log(chalk.dim('Tip: re-export your cleaned list: telegram contacts --out contacts.vcf'));
          }
          await service.disconnect();
          return;
        }

        // Accurate "no chat history" detection (two-phase):
        //   1. Fast positive - anyone in the recent dialog list definitely has a
        //      chat, so skip the per-contact API call.
        //   2. For the rest, check message history directly. The dialog list omits
        //      cleared/old chats, so this catches contacts you HAVE talked to that
        //      are missing from getDialogs (the source of earlier false positives).
        const maybeNoChat = contacts.filter((c) => !chatUserIds.has(c.id));
        console.log(
          chalk.bold(`\n📇 ${contacts.length} saved contacts.`) +
          chalk.dim(` ${chatUserIds.size} have open chats; verifying ${maybeNoChat.length} others...`)
        );

        const candidates: TelegramContact[] = [];
        let checked = 0;
        for (const c of maybeNoChat) {
          checked++;
          const hasChat = await service.hasChatHistory(c.id);
          if (!hasChat) candidates.push(c);
          if (checked % 25 === 0 || checked === maybeNoChat.length) {
            process.stdout.write(
              chalk.dim(`\r   checked ${checked}/${maybeNoChat.length}, ${candidates.length} with no chat history   `)
            );
          }
        }
        process.stdout.write('\n');

        console.log(chalk.bold(`${candidates.length} contacts have no chat history (deletion candidates).`));

        if (candidates.length === 0) {
          console.log(chalk.green('Nothing to prune.'));
          await service.disconnect();
          return;
        }

        // ---- Mode: export candidates to a reviewable CSV (--export) ----
        if (options.export) {
          const outPath = resolve(process.cwd(), options.export);
          writeFileSync(outPath, buildCandidatesCsv(candidates), 'utf8');
          console.log(chalk.green(`\n✅ Wrote ${candidates.length} candidates to `) + chalk.bold(outPath));
          console.log(chalk.dim('   Open it, set the "delete" column to yes for contacts to remove, then run:'));
          console.log(chalk.dim(`   claude-tools telegram prune-contacts --from-file ${options.export}`));
          await service.disconnect();
          return;
        }

        // Warnings
        console.log(chalk.green('\nℹ  This removes the CONTACT entry only. Chat history and messages are NOT deleted.'));
        console.log(chalk.yellow('⚠  Deleting a contact removes it from Telegram on ALL your devices.'));
        console.log(chalk.yellow('⚠  If "Sync Contacts" is ON on your phone, deleted contacts will'));
        console.log(chalk.yellow('   be re-imported. Turn it OFF first (Settings -> Privacy &'));
        console.log(chalk.yellow('   Security -> Contacts -> Sync Contacts -> Delete Synced Contacts).'));

        if (options.dryRun) {
          console.log(chalk.cyan('\n[dry-run] Candidates (no deletion):\n'));
          candidates.forEach((c, i) => {
            console.log(
              `  ${chalk.dim(String(i + 1).padStart(3))}. ${displayName(c)} ` +
              `${chalk.cyan(c.username ? '@' + c.username : '')} ${chalk.dim(c.phone ? '+' + c.phone : '(no phone)')}`
            );
          });
          console.log(chalk.dim(`\nRe-run without --dry-run to delete interactively.`));
          await service.disconnect();
          return;
        }

        const { ask, close } = makeAsker();

        // Backup gate
        if (options.backupCheck !== false) {
          const ok = await ask(
            chalk.bold('\nHave you backed up (telegram contacts --out backup.vcf)? Type "yes" to continue: ')
          );
          if (ok !== 'yes') {
            console.log(chalk.dim('Aborted. Back up first, then re-run.'));
            close();
            await service.disconnect();
            return;
          }
        }

        let deleted = 0;
        let skipped = 0;
        let deleteRest = false;
        let aborted = false;

        for (let i = 0; i < candidates.length; i++) {
          const c = candidates[i];
          const label =
            `${chalk.bold(displayName(c))} ` +
            `${chalk.cyan(c.username ? '@' + c.username : '')} ` +
            `${chalk.dim(c.phone ? '+' + c.phone : '(no phone)')}`;

          let answer: string;
          if (deleteRest) {
            answer = 'd';
          } else {
            answer = await ask(
              `\n[${i + 1}/${candidates.length}] ${label}\n  [d]elete / [s]kip / [a]ll-remaining / [q]uit: `
            );
          }

          if (answer === 'q') {
            aborted = true;
            break;
          } else if (answer === 's' || answer === '') {
            skipped++;
            continue;
          } else if (answer === 'a' && !deleteRest) {
            const confirm = await ask(
              chalk.yellow(`  Delete THIS and all ${candidates.length - i} remaining without asking? Type "yes": `)
            );
            if (confirm !== 'yes') {
              skipped++;
              continue;
            }
            deleteRest = true;
            answer = 'd';
          }

          if (answer === 'd') {
            try {
              await service.deleteContacts([{ id: c.id, accessHash: c.accessHash }]);
              deleted++;
              console.log(chalk.green(`  ✅ deleted ${displayName(c)}`));
            } catch (err) {
              console.log(chalk.red(`  ❌ failed to delete ${displayName(c)}: ${(err as Error).message}`));
            }
          } else {
            // Unrecognized input - treat as skip to be safe.
            skipped++;
          }
        }

        close();

        const remaining = candidates.length - deleted - skipped;
        console.log(
          chalk.bold(`\nDone. Deleted ${deleted}, skipped ${skipped}` +
          (aborted ? `, ${remaining} not reviewed (quit).` : '.'))
        );
        if (deleted > 0) {
          console.log(chalk.dim('Tip: re-export your filtered list with: telegram contacts --out contacts.vcf'));
        }

        await service.disconnect();
      } catch (err) {
        console.error(chalk.red('❌ Error:'), (err as Error).message);
        process.exit(1);
      }
    });
}
