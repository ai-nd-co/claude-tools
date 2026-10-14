// The format check as the send commands run it: print, and refuse with its own exit status.

import chalk from 'chalk';
import { FORMAT_REFUSED_EXIT_CODE, FORMAT_RULES, gateMessage } from '../../services/message-format.js';

export const FORMAT_OK_FLAG = '--format-ok <reason>';
export const FORMAT_OK_HELP = 'Send even though the format check refuses it; the reason is printed with the result';

/** The "Format:" section of a gated command's help. */
export function formatHelpSection(): string {
  const rules = FORMAT_RULES.map((rule) => `  - ${rule}`).join('\n');
  return `\n${chalk.yellow('Format:')} checked before sending; a message that breaks it is refused (exit ${FORMAT_REFUSED_EXIT_CODE})\n${rules}\n  --format-ok "<reason>" sends it anyway and prints the reason. Literal sends (bot --plain, account --md2) are machine notices and are not checked.\n`;
}

/**
 * Check a body before anything is sent, unless it is `literal` (machine output, see below). A refusal prints the reason and the rules and exits with
 * FORMAT_REFUSED_EXIT_CODE; warnings go to stderr and the send goes ahead. Returns the note for the success line
 * (the override and its reason, or nothing). An empty `--format-ok` reason throws.
 */
export function enforceFormat(body: string, override: string | undefined, literal = false, html = false, timeLiteral = false): string {
  // Literal text (bot --plain, account --md2) is machine output: a mail feed's one-line notice carries subjects with
  // "PROJ-4393" or "#471" in them, and refusing it would make the feed retry forever with every later notice behind it.
  if (literal) return '';
  const gate = gateMessage(body, override, html, timeLiteral);
  if (!gate.send) {
    console.error(chalk.red(gate.stderr));
    process.exit(FORMAT_REFUSED_EXIT_CODE);
  }
  if (gate.stderr) console.error(chalk.yellow(gate.stderr));
  return gate.note;
}

export const RICH_HELP = 'Accepted for compatibility: rich markdown is already the default';
export const MD2_HELP = 'Send the old way instead of rich: MarkdownV2 with escaping (no tables or headings, 4096 chars). For machine notices: not format-checked';
export const PLAIN_HELP = 'Send literally, with no formatting. For machine notices: not format-checked';

/**
 * Account sends are rich unless `--md2` asks for the old path. `--rich` stays accepted, because every skill passes
 * it; both together contradict each other and are refused rather than guessed.
 */
export function accountSendsRich(options: { rich?: boolean; md2?: boolean }): boolean {
  if (options.md2 && options.rich) throw new Error('--rich and --md2 contradict each other: rich is the default, so drop --rich to send MarkdownV2.');
  return !options.md2;
}
