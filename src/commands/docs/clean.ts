// Docs clean command - clear embeddings

import { Command } from 'commander';
import chalk from 'chalk';
import { clearDocsEmbeddings, getDocsEmbeddingStats } from '../../services/docs-semantic.js';

export function registerCleanCommand(docs: Command): void {
  docs
    .command('clean')
    .description('Clear doc embeddings')
    .option('--yes', 'Skip confirmation')
    .action(async (options: { yes?: boolean }) => {
      const stats = getDocsEmbeddingStats();

      if (stats.chunkEmbeddings === 0) {
        console.log(chalk.dim('No embeddings to clear.'));
        return;
      }

      console.log(`Embeddings: ${chalk.cyan(stats.chunkEmbeddings)}`);

      if (!options.yes) {
        const readline = await import('readline');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>(resolve => {
          rl.question(chalk.yellow('Delete all embeddings? (y/N) '), resolve);
        });
        rl.close();

        if (answer.toLowerCase() !== 'y') {
          console.log('Cancelled.');
          return;
        }
      }

      const deleted = clearDocsEmbeddings();
      console.log(chalk.green(`Deleted ${deleted} embeddings.`));
    });
}
