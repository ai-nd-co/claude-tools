// Jira sync command - sync issues to local SQLite database

import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig } from '../../config/loader.js';
import { JiraService } from '../../services/jira.js';
import { syncProject, getSyncedProjects, getJiraDatabaseStats, getProjectDateRange, fetchBacklogKeys, getBoardIdForProject } from '../../services/jira-sync.js';
import { generateJiraEmbeddings, getJiraEmbeddingStats } from '../../services/jira-semantic.js';
import { isOllamaAvailable } from '../../services/embeddings.js';
import { Version2Client, AgileClient } from 'jira.js';

function ensureJiraConfig() {
  const config = loadConfig();
  if (!config.jira) {
    console.error(chalk.red('Jira not configured.'));
    console.log('\nTo configure Jira:');
    console.log('  1. Get API token from https://id.atlassian.com/manage-profile/security/api-tokens');
    console.log('  2. Add to ~/.config/claude-tools/secrets.json:');
    console.log('     {"jira": {"email": "you@example.com", "apiToken": "..."}}');
    console.log('  3. Add to .claude-tools.json:');
    console.log('     {"jira": {"host": "yourcompany.atlassian.net", "defaultProject": "PROJ"}}');
    console.log('\nOr set environment variables: JIRA_HOST, JIRA_EMAIL, JIRA_API_TOKEN');
    process.exit(1);
  }
  return config.jira;
}

export function registerSyncCommand(jira: Command): void {
  jira
    .command('sync [project]')
    .description('Sync issues from Jira to local database')
    .option('--months <n>', 'Number of months to sync', '3')
    .option('--force', 'Re-sync even if already synced (full sync)')
    .option('--no-embed', 'Skip embedding generation after sync')
    .option('--status', 'Show sync status without syncing')
    .addHelpText('after', `
${chalk.yellow('Examples:')}
  ${chalk.dim('# Sync a project (last 3 months)')}
  claude-tools jira sync PROJ

  ${chalk.dim('# Sync last 6 months')}
  claude-tools jira sync PROJ --months 6

  ${chalk.dim('# Force full resync')}
  claude-tools jira sync PROJ --force

  ${chalk.dim('# Show sync status')}
  claude-tools jira sync --status
`)
    .action(async (project: string | undefined, options: {
      months: string;
      force?: boolean;
      embed?: boolean;
      status?: boolean;
    }) => {
      // Show status only
      if (options.status) {
        showSyncStatus();
        return;
      }

      const config = ensureJiraConfig();

      // Use default project if not specified
      const projectKey = project || config.defaultProject;
      if (!projectKey) {
        console.error(chalk.red('Please specify a project or set defaultProject in config'));
        console.log('  Examples:');
        console.log('    claude-tools jira sync PROJ');
        console.log('    claude-tools jira sync --list');
        process.exit(1);
      }

      const months = parseInt(options.months, 10);

      // Create Jira clients
      const host = config.host.startsWith('http') ? config.host : `https://${config.host}`;
      const authConfig = {
        basic: {
          email: config.email,
          apiToken: config.apiToken,
        },
      };

      const client = new Version2Client({ host, authentication: authConfig });
      const agileClient = new AgileClient({ host, authentication: authConfig });

      console.log(chalk.bold(`📥 Syncing ${chalk.cyan(projectKey)} (last ${months} months)...`));
      if (options.force) {
        console.log(chalk.dim('   Full resync mode'));
      }
      console.log();

      try {
        // Fetch backlog keys first (to mark issues as in_backlog during sync)
        let backlogKeys: Set<string> | undefined;
        const boardId = await getBoardIdForProject(agileClient, projectKey);
        if (boardId) {
          process.stdout.write(chalk.dim('  Fetching backlog status...'));
          backlogKeys = await fetchBacklogKeys(agileClient, boardId, (count) => {
            process.stdout.write(`\r${chalk.dim(`  Fetching backlog status... ${count} issues`)}`);
          });
          console.log(`\r${chalk.dim(`  Backlog: ${backlogKeys.size} issues`)}                    `);
        } else {
          console.log(chalk.dim('  No board found, skipping backlog detection'));
        }

        const result = await syncProject(client, projectKey, {
          months,
          force: options.force,
          onProgress: (count, latestKey) => {
            process.stdout.write(`\r  ${chalk.dim(`${count} issues synced (${latestKey})`)}`);
          },
        }, backlogKeys);

        console.log('\n');
        console.log(chalk.green('✅ Sync complete'));
        console.log(chalk.dim(`   Project: ${result.projectName} (${result.projectKey})`));
        console.log(chalk.dim(`   Added: ${result.issuesAdded}, Updated: ${result.issuesUpdated}`));
        console.log(chalk.dim(`   Total issues: ${result.totalIssues}`));

        // Auto-embed unless --no-embed
        if (options.embed !== false) {
          await indexProject(projectKey);
        }
      } catch (err) {
        console.error(chalk.red('\n❌ Error:'), (err as Error).message);
        process.exit(1);
      }
    });
}

function showSyncStatus(): void {
  const stats = getJiraDatabaseStats();
  const syncedProjects = getSyncedProjects();

  console.log(chalk.bold('\n📊 Jira Sync Status\n'));

  if (stats.totalIssues === 0) {
    console.log(chalk.dim('No issues synced yet.'));
    console.log(chalk.dim('Run: claude-tools jira sync <project>'));
    return;
  }

  console.log(`Total issues: ${chalk.cyan(stats.totalIssues.toLocaleString())}`);
  console.log(`Projects synced: ${chalk.cyan(stats.projects)}`);

  if (stats.oldestIssue) {
    console.log(`Date range: ${chalk.dim(formatDate(stats.oldestIssue))} - ${chalk.dim(formatDate(stats.newestIssue!))}`);
  }

  if (syncedProjects.length > 0) {
    console.log(chalk.bold('\nProjects:'));
    for (const proj of syncedProjects) {
      const lastSync = proj.last_sync_at ? new Date(proj.last_sync_at * 1000) : null;
      const dateRange = getProjectDateRange(proj.project_key);
      console.log(`  ${chalk.cyan(proj.project_key)}: ${proj.issue_count} issues`);
      if (dateRange.oldest && dateRange.newest) {
        console.log(chalk.dim(`    Issues updated: ${formatDate(dateRange.oldest)} - ${formatDate(dateRange.newest)}`));
      }
      if (lastSync) {
        console.log(chalk.dim(`    Last synced: ${formatDate(lastSync)}`));
      }
    }
  }
}

function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
  });
}

async function indexProject(projectKey: string): Promise<void> {
  console.log(chalk.dim('\nIndexing...'));

  const ollamaOk = await isOllamaAvailable();
  if (!ollamaOk) {
    console.log(chalk.dim('   Embeddings skipped (Ollama not running)'));
    return;
  }

  const result = await generateJiraEmbeddings(projectKey, Infinity, (done, total, key) => {
    process.stdout.write(`\r   ${chalk.dim(`Embeddings: ${done}/${total} (${key})`)}`);
  });

  const stats = getJiraEmbeddingStats();
  if (result.generated > 0) {
    console.log(`\r   ${chalk.dim(`${result.generated} new embeddings (${stats.issueEmbeddings} total)`)}`);
  } else {
    console.log(`\r   ${chalk.dim(`Embeddings up to date (${stats.issueEmbeddings} total)`)}`);
  }
}
