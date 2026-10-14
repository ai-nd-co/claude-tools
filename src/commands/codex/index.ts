import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import { compactCodexSessionEnhanced } from '../../utils/codex-compact.js';
import { findCodexSessionFile, listCodexSessionFiles } from '../../utils/codex-sessions.js';
import { SummaryProvider } from '../../utils/summary-provider.js';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function registerCodexCommands(program: Command): void {
  const codex = program
    .command('codex')
    .description('Codex session utilities (compaction, listing)');

  codex
    .command('list')
    .description('List Codex session files (optionally by size)')
    .option('--largest <count>', 'Show largest N sessions (default: 10)', '10')
    .option('--root <path>', 'Override Codex sessions root')
    .action((options: { largest?: string; root?: string }) => {
      const sessions = listCodexSessionFiles(options.root);
      if (sessions.length === 0) {
        console.log(chalk.yellow('No Codex session files found.'));
        return;
      }

      const count = Math.max(1, parseInt(options.largest || '10', 10));
      const sorted = sessions.sort((a, b) => b.size - a.size).slice(0, count);

      console.log(chalk.dim(`Found ${sessions.length} session files. Showing top ${sorted.length} by size:`));
      for (const s of sorted) {
        const rel = s.path;
        console.log(`${formatBytes(s.size).padStart(8)}  ${rel}`);
      }
    });

  codex
    .command('compact <session>')
    .description('Enhanced compaction for Codex sessions (summarize first part, keep tail intact)')
    .option('--keep <percent>', 'Percent of conversation to keep intact (default: 50)', '50')
    .option('--summary-provider <provider>', 'Summary provider: codex or claude')
    .option('--summary-model <model>', 'Provider-specific summary model override')
    .option('--model <model>', 'Legacy Claude-only summary model alias (implies Claude when used alone)')
    .option('--max-output <chars>', 'Max chars to include per tool output (default: 2000)', '2000')
    .option('--output <file>', 'Output JSONL path (default: <input>.codex-compact.jsonl)')
    .option('--dry-run', 'Show stats only, do not write output')
    .action(async (session: string, options: {
      keep?: string;
      summaryProvider?: SummaryProvider;
      summaryModel?: string;
      model?: string;
      maxOutput?: string;
      output?: string;
      dryRun?: boolean;
    }) => {
      const sessionPath = findCodexSessionFile(session);
      if (!sessionPath) {
        console.log(chalk.red(`Could not find Codex session: ${session}`));
        process.exit(1);
      }

      const keepPercent = parseInt(options.keep || '50', 10);
      const maxOutputChars = parseInt(options.maxOutput || '2000', 10);

      console.log(chalk.dim(`Compacting Codex session: ${sessionPath}`));
      console.log(chalk.dim(`Keep intact: ${keepPercent}%`));

      const result = await compactCodexSessionEnhanced(sessionPath, {
        keepPercent,
        summaryProvider: options.summaryProvider,
        summaryModel: options.summaryModel,
        model: options.model,
        maxOutputChars,
        dryRun: options.dryRun,
      });

      const savedBytes = result.originalSize - result.compactedSize;
      const savedPercent = result.originalSize > 0
        ? Math.round((savedBytes / result.originalSize) * 100)
        : 0;

      const providerLine = result.fallbackFrom
        ? `Summary provider: ${result.providerUsed} (fallback from ${result.fallbackFrom}: ${result.fallbackReason})`
        : `Summary provider: ${result.providerUsed} (${result.modelUsed})`;

      console.log(chalk.green(providerLine));
      console.log(chalk.green(`Turns summarized: ${result.turnsSummarized}`));
      console.log(chalk.green(`Turns kept: ${result.turnsKept}`));
      console.log(chalk.green(`Size: ${formatBytes(result.originalSize)} → ${formatBytes(result.compactedSize)} (saved ${savedPercent}%)`));

      if (options.dryRun) {
        console.log(chalk.yellow('Dry run - no output written.'));
        return;
      }

      const outputPath = options.output
        ? path.resolve(options.output)
        : path.join(path.dirname(sessionPath), `${path.basename(sessionPath, '.jsonl')}.codex-compact.jsonl`);

      const output = result.compactedEntries.map(e => JSON.stringify(e)).join('\n') + '\n';
      fs.writeFileSync(outputPath, output, 'utf-8');
      console.log(chalk.green(`Wrote compacted session: ${outputPath}`));
    });
}
