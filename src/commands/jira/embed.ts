// Jira embed command - show embedding status

import { Command } from 'commander';
import chalk from 'chalk';
import { getJiraEmbeddingStats } from '../../services/jira-semantic.js';
import { hasIssues } from '../../services/jira-search.js';

export function registerEmbedCommand(jira: Command): void {
  jira
    .command('embed')
    .description('Show embedding status for semantic search')
    .addHelpText('after', `
${chalk.yellow('Examples:')}
  claude-tools jira embed

${chalk.yellow('Note:')}
  Embeddings are automatically generated during sync.
  Run ${chalk.cyan('jira sync <project>')} to sync and index issues.
`)
    .action(async () => {
      try {
        if (!hasIssues()) {
          console.log(chalk.yellow('No issues synced yet.'));
          console.log(chalk.dim('Run: claude-tools jira sync <project>'));
          return;
        }

        const stats = getJiraEmbeddingStats();
        console.log(chalk.bold('\nJira Embedding Status'));
        console.log(`Issue embeddings: ${chalk.cyan(stats.issueEmbeddings)}`);
        console.log(`Total issues: ${chalk.cyan(stats.totalIssues)}`);
        console.log(`Coverage: ${chalk.cyan(stats.coverage.toFixed(1))}%`);
      } catch (err) {
        console.error(chalk.red('Error:'), (err as Error).message);
        process.exit(1);
      }
    });
}
