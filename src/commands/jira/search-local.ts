// Jira local search command - FTS5 search in local database

import { Command } from 'commander';
import chalk from 'chalk';
import { searchIssues, listIssues, hasIssues, getDatabaseStats, getLastSyncTime, type JiraSearchResult } from '../../services/jira-search.js';
import {
  searchJiraSemantic,
  isJiraSemanticAvailable,
  type JiraSemanticSearchResult,
} from '../../services/jira-semantic.js';
import { resolveFormat, type OutputFormat } from '../../utils/output-format.js';

export function registerSearchLocalCommand(jira: Command): void {
  jira
    .command('search-local [query]')
    .description('Search issues in local database (offline, fast)')
    .option('--project <key>', 'Filter by project key')
    .option('--status <status>', 'Filter by status')
    .option('--assignee <name>', 'Filter by assignee name')
    .option('--limit <n>', 'Number of results', '20')
    .option('--fuzzy', 'Enable fuzzy (prefix) matching')
    .option('--semantic', 'Force semantic search (vector similarity)')
    .option('--keyword', 'Force keyword search (FTS)')
    .option('--board-only', 'Show only issues on the board (exclude backlog)')
    .option('--backlog-only', 'Show only issues in the backlog')
    .option('--format <type>', 'Output format: title, compact, verbose, json (default: title)')
    .option('--verbose', 'Shorthand for --format=verbose')
    .option('--json', 'Shorthand for --format=json')
    .addHelpText('after', `
${chalk.yellow('Examples:')}
  ${chalk.dim('# Search for "deployment" issues')}
  claude-tools jira search-local "deployment"

  ${chalk.dim('# List all issues (no query)')}
  claude-tools jira search-local

  ${chalk.dim('# Search in specific project')}
  claude-tools jira search-local "bug" --project PROJ

  ${chalk.dim('# Filter by status (list mode)')}
  claude-tools jira search-local --status "In Progress"

  ${chalk.dim('# Filter by assignee')}
  claude-tools jira search-local "auth" --assignee john

  ${chalk.dim('# Fuzzy prefix matching')}
  claude-tools jira search-local "deploy" --fuzzy

  ${chalk.dim('# Verbose output')}
  claude-tools jira search-local "error" --verbose

  ${chalk.dim('# Force semantic (vector) search')}
  claude-tools jira search-local "auth issues" --semantic

  ${chalk.dim('# Force keyword (FTS) search')}
  claude-tools jira search-local "deploy" --keyword

  ${chalk.dim('# Show only issues on the board (exclude backlog)')}
  claude-tools jira search-local --board-only

  ${chalk.dim('# Show only backlog issues')}
  claude-tools jira search-local --backlog-only

${chalk.yellow('Note:')}
  Run ${chalk.cyan('claude-tools jira sync <project>')} first to sync issues.
`)
    .action(async (query: string | undefined, options: {
      project?: string;
      status?: string;
      assignee?: string;
      limit: string;
      fuzzy?: boolean;
      semantic?: boolean;
      keyword?: boolean;
      boardOnly?: boolean;
      backlogOnly?: boolean;
      format?: string;
      verbose?: boolean;
      json?: boolean;
    }) => {
      const format = resolveFormat(options, 'title');
      // Check if we have any issues
      if (!hasIssues()) {
        console.log(chalk.yellow('\n⚠️  No issues synced yet.'));
        console.log(chalk.dim('Run: claude-tools jira sync <project>'));
        return;
      }

      const limit = parseInt(options.limit, 10);
      const searchQuery = query || '';

      // Determine board filter
      let boardFilter: 'board' | 'backlog' | undefined;
      if (options.boardOnly) {
        boardFilter = 'board';
      } else if (options.backlogOnly) {
        boardFilter = 'backlog';
      }

      try {
        const startTime = performance.now();

        // Determine search mode
        let useSemanticSearch = false;

        if (options.semantic) {
          const status = await isJiraSemanticAvailable();
          if (!status.available) {
            console.log(chalk.yellow('Semantic search not available:'), status.reason);
            return;
          }
          useSemanticSearch = true;
        } else if (!options.keyword && searchQuery) {
          // Auto-select semantic if available (unless --keyword forces FTS)
          const status = await isJiraSemanticAvailable();
          useSemanticSearch = status.available;
        }

        // Semantic search path
        if (useSemanticSearch && searchQuery) {
          const results = await searchJiraSemantic(searchQuery, options.project, limit);
          const duration = (performance.now() - startTime).toFixed(0);

          if (format === 'json') {
            console.log(JSON.stringify({
              query: searchQuery,
              mode: 'semantic',
              options: { project: options.project },
              totalCount: results.length,
              results: results.map(r => ({
                key: r.issue.key,
                summary: r.issue.summary,
                status: r.issue.status,
                similarity: r.similarity,
              })),
            }, null, 2));
            return;
          }

          printSemanticResults(searchQuery, results, duration, format);
          showSyncWarningIfNeeded();
          return;
        }

        // FTS search path (original logic)
        // Use search if query provided, otherwise list with filters
        const response = searchQuery
          ? searchIssues(searchQuery, {
              projectKey: options.project,
              status: options.status,
              assignee: options.assignee,
              limit,
              fuzzy: options.fuzzy,
              boardFilter,
            })
          : listIssues({
              projectKey: options.project,
              status: options.status,
              assignee: options.assignee,
              limit,
              boardFilter,
            });

        const duration = (performance.now() - startTime).toFixed(0);

        if (format === 'json') {
          console.log(JSON.stringify({
            query: searchQuery || null,
            options: {
              project: options.project,
              status: options.status,
              assignee: options.assignee,
              fuzzy: options.fuzzy,
            },
            totalCount: response.totalCount,
            page: response.page,
            perPage: response.perPage,
            results: response.results,
          }, null, 2));
          return;
        }

        // Display results
        if (response.results.length === 0) {
          if (searchQuery) {
            console.log(chalk.dim(`\n🔍 No results for "${searchQuery}"`));
          } else {
            console.log(chalk.dim('\n📋 No issues found with current filters'));
          }
          showSyncWarningIfNeeded();
          return;
        }

        // Header differs based on search vs list mode
        if (searchQuery) {
          console.log(`\n🔍 ${chalk.bold(`"${searchQuery}"`)} ${chalk.dim(`(${response.totalCount} matches in ${duration}ms)`)}`);
        } else {
          console.log(`\n📋 ${chalk.bold('Issues')} ${chalk.dim(`(${response.totalCount} total in ${duration}ms)`)}`);
        }

        // Output based on format
        console.log();
        for (const issue of response.results) {
          if (format === 'verbose') {
            printIssueVerbose(issue);
            console.log();
          } else if (format === 'compact') {
            printIssueCompact(issue);
          } else {
            // title mode (default)
            printIssueTitle(issue);
          }
        }

        // Pagination info
        if (response.totalPages > 1) {
          console.log(chalk.dim(`\nPage ${response.page} of ${response.totalPages}`));
        }

        // Show sync warning if database is stale
        showSyncWarningIfNeeded();
      } catch (err) {
        console.error(chalk.red('Error:'), (err as Error).message);
        process.exit(1);
      }
    });

  // Add stats command for database info
  jira
    .command('stats')
    .description('Show local database statistics')
    .action(() => {
      if (!hasIssues()) {
        console.log(chalk.yellow('\n⚠️  No issues synced yet.'));
        console.log(chalk.dim('Run: claude-tools jira sync <project>'));
        return;
      }

      const stats = getDatabaseStats();

      console.log(chalk.bold('\n📊 Local Database Stats\n'));
      console.log(`Total issues: ${chalk.cyan(stats.totalIssues.toLocaleString())}`);
      console.log(`Projects: ${chalk.cyan(stats.projects)}`);

      if (stats.oldestUpdated && stats.newestUpdated) {
        console.log(`Date range: ${formatDate(stats.oldestUpdated)} - ${formatDate(stats.newestUpdated)}`);
      }

      if (stats.statusBreakdown.length > 0) {
        console.log(chalk.bold('\nStatus breakdown:'));
        for (const { status, count } of stats.statusBreakdown) {
          const bar = '█'.repeat(Math.min(20, Math.round(count / stats.totalIssues * 20)));
          console.log(`  ${status.padEnd(15)} ${chalk.cyan(count.toString().padStart(5))} ${chalk.dim(bar)}`);
        }
      }
    });
}

function printIssueTitle(issue: JiraSearchResult): void {
  console.log(`  ${chalk.cyan(issue.key)}: ${issue.summary}`);
}

function printIssueCompact(issue: JiraSearchResult): void {
  const statusColor = getStatusColor(issue.statusCategory);
  const assignee = issue.assigneeName?.split(' ')[0] || chalk.dim('Unassigned');
  const date = formatDateShort(issue.updated);

  console.log(
    `  ${chalk.cyan(issue.key.padEnd(10))} ${date} ` +
    `${statusColor(`[${issue.status.slice(0, 12)}]`.padEnd(14))} ` +
    `${assignee.slice(0, 10).padEnd(10)}: ` +
    `${issue.summary.slice(0, 50)}${issue.summary.length > 50 ? '...' : ''}`
  );
}

function printIssueVerbose(issue: JiraSearchResult): void {
  const statusColor = getStatusColor(issue.statusCategory);

  console.log(`${chalk.cyan(issue.key)} ${statusColor(`[${issue.status}]`)}`);
  console.log(`  ${chalk.bold(issue.summary)}`);
  console.log(`  Assignee: ${issue.assigneeName || chalk.dim('Unassigned')}`);
  console.log(`  Type: ${issue.issueType || 'Task'}  Priority: ${issue.priority || 'None'}`);
  console.log(`  Updated: ${formatDate(issue.updated)}`);

  if (issue.labels.length > 0) {
    console.log(`  Labels: ${issue.labels.join(', ')}`);
  }

  if (issue.description) {
    const desc = issue.description.slice(0, 200).replace(/\n/g, ' ');
    console.log();
    console.log(chalk.dim(`    ${desc}${issue.description.length > 200 ? '...' : ''}`));
  }

  console.log(chalk.dim('  ---'));
}

function getStatusColor(statusCategory: string): (text: string) => string {
  switch (statusCategory.toLowerCase()) {
    case 'done':
      return chalk.green;
    case 'in progress':
      return chalk.yellow;
    default:
      return chalk.white;
  }
}

function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
  });
}

function formatDateShort(date: Date): string {
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  }).padEnd(7);
}

/**
 * Format time elapsed since a date in human-readable form
 */
function formatTimeAgo(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays > 0) {
    return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
  } else if (diffHours > 0) {
    return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
  } else {
    return 'less than an hour ago';
  }
}

/**
 * Show a warning if the database hasn't been synced in 24+ hours
 */
function showSyncWarningIfNeeded(): void {
  const lastSync = getLastSyncTime();
  if (!lastSync) return;

  const now = new Date();
  const diffMs = now.getTime() - lastSync.getTime();
  const diffHours = diffMs / (1000 * 60 * 60);

  if (diffHours >= 24) {
    console.log();
    console.log(chalk.yellow(`\u26a0\ufe0f  Database last synced ${formatTimeAgo(lastSync)}. Run: claude-tools jira sync <project>`));
  }
}

function printSemanticResults(
  query: string,
  results: JiraSemanticSearchResult[],
  duration: string,
  format: OutputFormat
): void {
  console.log(
    chalk.bold(`\n🧠 "${query}"`) +
    chalk.dim(` (${results.length} semantic matches in ${duration}ms)`)
  );

  if (results.length === 0) {
    console.log(chalk.dim('No results. Try: jira embed --generate'));
    return;
  }

  console.log();
  for (const { issue, similarity } of results) {
    const statusColor = getStatusColor(issue.status_category || '');
    const sim = (similarity * 100).toFixed(0) + '%';
    const date = formatDateShort(new Date(issue.updated * 1000));

    if (format === 'verbose') {
      console.log(`${chalk.cyan(issue.key)} ${statusColor(`[${issue.status || ''}]`)} ${chalk.yellow(sim)}`);
      console.log(`  ${chalk.bold(issue.summary || '')}`);
      console.log(`  Updated: ${formatDate(new Date(issue.updated * 1000))}`);
      if (issue.description) {
        const desc = issue.description.slice(0, 200).replace(/\n/g, ' ');
        console.log(chalk.dim(`    ${desc}${issue.description.length > 200 ? '...' : ''}`));
      }
      console.log(chalk.dim('  ---'));
    } else if (format === 'compact') {
      console.log(
        `  ${chalk.cyan(issue.key.padEnd(10))} ${date} ` +
        `${statusColor(`[${(issue.status || '').slice(0, 12)}]`.padEnd(14))} ` +
        `${chalk.yellow(sim.padStart(4))} ` +
        `${(issue.summary || '').slice(0, 45)}${(issue.summary || '').length > 45 ? '...' : ''}`
      );
    } else {
      // title mode
      console.log(`  ${chalk.cyan(issue.key)}: ${issue.summary || ''}`);
    }
  }
}
