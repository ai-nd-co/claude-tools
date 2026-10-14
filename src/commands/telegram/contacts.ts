// Contacts command - export saved Telegram contacts to a vCard (.vcf) file
// for importing into a phone address book (e.g. Android) so incoming calls
// show the caller's name.

import { Command } from 'commander';
import chalk from 'chalk';
import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { loadConfig } from '../../config/loader.js';
import { TelegramService, type TelegramContact } from '../../services/telegram.js';

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

/**
 * Build a display name (FN) from first/last name, falling back to username.
 */
function fullName(contact: TelegramContact): string {
  const parts = [contact.firstName, contact.lastName].filter(Boolean);
  if (parts.length > 0) return parts.join(' ');
  if (contact.username) return `@${contact.username}`;
  return 'Telegram Contact';
}

/**
 * Escape a value for a vCard field per RFC 6350: backslash, comma, semicolon
 * and newlines must be escaped.
 */
function vcardEscape(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

/**
 * Normalize a Telegram phone number to E.164 (leading +). Telegram usually
 * returns the number without the +, with only digits.
 */
function toE164(phone: string): string {
  const digits = phone.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  return `+${digits}`;
}

/**
 * Build a single vCard 3.0 block for a contact.
 */
function buildVCard(contact: TelegramContact, withUsername: boolean): string {
  const first = vcardEscape(contact.firstName ?? '');
  const last = vcardEscape(contact.lastName ?? '');
  const fn = vcardEscape(fullName(contact));
  const tel = toE164(contact.phone ?? '');

  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    // N: Last;First;Middle;Prefix;Suffix
    `N:${last};${first};;;`,
    `FN:${fn}`,
    `TEL;TYPE=CELL:${tel}`,
  ];

  if (withUsername && contact.username) {
    lines.push(`X-TELEGRAM:@${vcardEscape(contact.username)}`);
    lines.push(`NOTE:Telegram @${vcardEscape(contact.username)}`);
  }

  lines.push('END:VCARD');
  // vCard spec uses CRLF line endings; Android also accepts LF.
  return lines.join('\r\n');
}

export function registerContactsCommand(telegram: Command): void {
  telegram
    .command('contacts')
    .description('Export saved Telegram contacts to a vCard (.vcf) file for Android import')
    .option('--out <path>', 'Output .vcf file path', 'telegram-contacts.vcf')
    .option('--json', 'Print contacts as JSON instead of writing a file')
    .option('--with-username', 'Include Telegram @username as a note in each card')
    .addHelpText('after', `
${chalk.yellow('Examples:')}
  ${chalk.dim('# Export all saved contacts to telegram-contacts.vcf')}
  claude-tools telegram contacts

  ${chalk.dim('# Export to a specific file')}
  claude-tools telegram contacts --out my-contacts.vcf

  ${chalk.dim('# Include each Telegram @username as a note')}
  claude-tools telegram contacts --with-username

  ${chalk.dim('# Inspect contacts as JSON without writing a file')}
  claude-tools telegram contacts --json

${chalk.yellow('Import on Android:')}
  ${chalk.dim('Transfer the .vcf to your phone (Telegram Saved Messages, email, USB),')}
  ${chalk.dim('then open Contacts → Settings → Import → from .vcf file.')}
`)
    .action(async (options: { out: string; json?: boolean; withUsername?: boolean }) => {
      const config = ensureTelegramConfig();
      const service = new TelegramService(config);

      try {
        await service.connect();
        const contacts = await service.getContacts();

        if (options.json) {
          console.log(JSON.stringify(contacts, null, 2));
          await service.disconnect();
          return;
        }

        const withPhone = contacts.filter(c => c.phone && c.phone.trim().length > 0);
        const skipped = contacts.length - withPhone.length;

        if (withPhone.length === 0) {
          console.log(chalk.yellow('\nNo contacts with phone numbers were found.'));
          console.log(chalk.dim('Telegram only exposes phone numbers for your saved contacts.'));
          await service.disconnect();
          return;
        }

        const vcardText = withPhone
          .map(c => buildVCard(c, options.withUsername === true))
          .join('\r\n') + '\r\n';

        const outPath = resolve(process.cwd(), options.out);
        writeFileSync(outPath, vcardText, 'utf8');

        console.log(
          chalk.green(`\n✅ Wrote ${withPhone.length} contact${withPhone.length === 1 ? '' : 's'} to `) +
          chalk.bold(outPath)
        );
        if (skipped > 0) {
          console.log(chalk.dim(`   Skipped ${skipped} contact${skipped === 1 ? '' : 's'} without a phone number.`));
        }
        console.log(chalk.dim('   Import on Android: Contacts → Settings → Import → from .vcf file.'));
        console.log(chalk.dim('   Note: re-importing may create duplicates on some devices.'));

        await service.disconnect();
      } catch (err) {
        console.error(chalk.red('❌ Error:'), (err as Error).message);
        process.exit(1);
      }
    });
}
