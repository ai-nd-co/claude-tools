// Jira commands - list, create, status, search, comment, sync, search-local

import { Command } from 'commander';
import chalk from 'chalk';
import { Version2Client, Version2Models } from 'jira.js';
import { loadConfig } from '../../config/loader.js';
import { applyCreateFields } from '../../services/jira-create-fields.js';
import { JiraService, type JiraIssue } from '../../services/jira.js';
import { registerSyncCommand } from './sync.js';
import { registerSearchLocalCommand } from './search-local.js';
import { registerEmbedCommand } from './embed.js';
import { registerMonitorCommand } from './monitor.js';
import { resolveFormat, type OutputFormat } from '../../utils/output-format.js';

const SEARCH_BATCH_SIZE = 100;
const SEARCH_MAX_PAGES = 100;

export interface PaginatedJiraSearchResult {
  issues: JiraIssue[];
  matched: number;
  truncated: boolean;
}

export async function searchJqlPaginated(
  client: Pick<Version2Client, 'issueSearch'>,
  jql: string,
  limit?: number,
): Promise<PaginatedJiraSearchResult> {
  const all: JiraIssue[] = [];
  let nextPageToken: string | undefined;
  let pages = 0;

  while (true) {
    if (pages >= SEARCH_MAX_PAGES) {
      throw new Error(
        `JIRA search pagination exceeded SEARCH_MAX_PAGES=${SEARCH_MAX_PAGES} for JQL: ${jql}`,
      );
    }
    const result = await client.issueSearch.searchForIssuesUsingJqlEnhancedSearch({
      jql,
      maxResults: SEARCH_BATCH_SIZE,
      nextPageToken,
      fields: ['summary', 'status', 'issuetype', 'assignee', 'priority', 'created', 'updated'],
    });
    for (const issue of result.issues || []) {
      const fields = issue.fields as Version2Models.Fields;
      all.push({
        key: issue.key,
        summary: fields.summary || '',
        status: fields.status?.name || '',
        type: fields.issuetype?.name || '',
        assignee: fields.assignee?.displayName,
        priority: fields.priority?.name,
        created: fields.created || '',
        updated: fields.updated || '',
      });
    }
    pages++;
    nextPageToken = result.nextPageToken;
    if (!nextPageToken) break;
  }

  const returned = limit === undefined ? all : all.slice(0, limit);
  return {
    issues: returned,
    matched: all.length,
    truncated: returned.length < all.length,
  };
}

/**
 * Read text from stdin (for piping content)
 * Usage: cat file.md | jira create "Title" -d -
 */
async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    // Check if stdin is a TTY (interactive terminal) - if so, no piped input
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }

    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8').trim()));
    process.stdin.on('error', reject);

    // Set timeout to avoid hanging if no input
    setTimeout(() => {
      if (chunks.length === 0) {
        resolve('');
      }
    }, 100);
  });
}

/**
 * Resolve description value - supports stdin via "-" marker
 */
async function resolveDescription(description: string | undefined): Promise<string | undefined> {
  if (!description) return undefined;
  if (description === '-') {
    const stdinContent = await readStdin();
    if (!stdinContent) {
      console.error(chalk.red('Error: No input received from stdin'));
      process.exit(1);
    }
    return stdinContent;
  }
  return description;
}

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

function formatDate(dateStr: string): string {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  return date.toLocaleDateString();
}

function getStatusColor(status: string): (text: string) => string {
  if (status.toLowerCase().includes('done')) return chalk.green;
  if (status.toLowerCase().includes('progress')) return chalk.yellow;
  return chalk.white;
}

function printIssueTitle(issue: JiraIssue): void {
  console.log(`  ${chalk.cyan(issue.key)}: ${issue.summary}`);
}

function printIssueCompact(issue: JiraIssue): void {
  const statusColor = getStatusColor(issue.status);
  console.log(
    chalk.cyan(issue.key.padEnd(12)) +
    statusColor(issue.status.slice(0, 13).padEnd(15)) +
    (issue.assignee?.slice(0, 18) || chalk.dim('Unassigned')).padEnd(20) +
    issue.summary.slice(0, 50)
  );
}

function printIssueVerbose(issue: JiraIssue, host?: string): void {
  const statusColor = getStatusColor(issue.status);
  console.log();
  console.log(chalk.cyan(issue.key), statusColor(`[${issue.status}]`));
  console.log(`  ${chalk.bold(issue.summary)}`);
  console.log(`  Type: ${issue.type}  Priority: ${issue.priority || 'None'}`);
  console.log(`  Assignee: ${issue.assignee || chalk.dim('Unassigned')}`);
  console.log(`  Updated: ${formatDate(issue.updated)}`);
  if (host) {
    console.log(chalk.dim(`  URL: https://${host}/browse/${issue.key}`));
  }
  console.log(chalk.dim('  ---'));
}

export function registerJiraCommands(program: Command): void {
  const jira = program
    .command('jira')
    .description('Jira issue management commands');

  // Register sync, local search, and embed commands
  registerSyncCommand(jira);
  registerSearchLocalCommand(jira);
  registerEmbedCommand(jira);
  registerMonitorCommand(jira);

  // List issues command
  jira
    .command('list [project]')
    .description('List issues')
    .option('--status <status>', 'Filter by status')
    .option('--assignee <user>', 'Filter by assignee (use "me" for yourself)')
    .option('--limit <n>', 'Number of results', '20')
    .option('--format <type>', 'Output format: title, compact, verbose, json (default: compact)')
    .option('--verbose', 'Shorthand for --format=verbose')
    .option('--json', 'Shorthand for --format=json')
    .addHelpText('after', `
${chalk.yellow('Examples:')}
  ${chalk.dim('# List issues in default project')}
  claude-tools jira list

  ${chalk.dim('# List issues in specific project')}
  claude-tools jira list PROJ

  ${chalk.dim('# List my open issues')}
  claude-tools jira list --assignee me --status "In Progress"

  ${chalk.dim('# Different output formats')}
  claude-tools jira list --format=title
  claude-tools jira list --format=verbose
  claude-tools jira list --json
`)
    .action(async (project: string | undefined, options: { status?: string; assignee?: string; limit: string; format?: string; verbose?: boolean; json?: boolean }) => {
      const config = ensureJiraConfig();
      const service = new JiraService(config);
      const format = resolveFormat(options, 'compact');

      try {
        const issues = await service.listIssues({
          project,
          status: options.status,
          assignee: options.assignee,
          limit: parseInt(options.limit, 10),
        });

        if (format === 'json') {
          console.log(JSON.stringify(issues, null, 2));
        } else {
          console.log(chalk.bold('\nIssues:\n'));
          if (issues.length === 0) {
            console.log(chalk.dim('No issues found'));
          } else {
            if (format === 'compact') {
              console.log(chalk.dim('Key'.padEnd(12) + 'Status'.padEnd(15) + 'Assignee'.padEnd(20) + 'Summary'));
              console.log(chalk.dim('-'.repeat(80)));
            }
            for (const issue of issues) {
              if (format === 'verbose') {
                printIssueVerbose(issue, config.host);
              } else if (format === 'title') {
                printIssueTitle(issue);
              } else {
                printIssueCompact(issue);
              }
            }
          }
          console.log(chalk.dim(`\nTotal: ${issues.length}`));
        }
      } catch (err) {
        console.error(chalk.red('Error:'), (err as Error).message);
        process.exit(1);
      }
    });

  // Search issues command
  jira
    .command('search <jql>')
    .description('Search issues using JQL')
    .option('--limit <n>', 'Maximum number of results (all matches are fetched to detect truncation)')
    .option('--format <type>', 'Output format: title, compact, verbose, json (default: title)')
    .option('--verbose', 'Shorthand for --format=verbose')
    .option('--json', 'Shorthand for --format=json')
    .addHelpText('after', `
${chalk.yellow('JQL Examples:')}
  ${chalk.dim('# All open issues assigned to me')}
  claude-tools jira search "assignee = currentUser() AND status != Done"

  ${chalk.dim('# Issues updated this week')}
  claude-tools jira search "updated >= -7d"

  ${chalk.dim('# Bugs in project')}
  claude-tools jira search "project = PROJ AND type = Bug"
`)
    .action(async (jql: string, options: { limit?: string; format?: string; verbose?: boolean; json?: boolean }) => {
      const config = ensureJiraConfig();
      const format = resolveFormat(options, 'title');
      const limit = options.limit === undefined ? undefined : parseInt(options.limit, 10);

      if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
        console.error(chalk.red('Error: --limit must be a positive integer'));
        process.exit(1);
      }

      try {
        const client = new Version2Client({
          host: config.host.startsWith('http') ? config.host : `https://${config.host}`,
          authentication: { basic: { email: config.email, apiToken: config.apiToken } },
        });
        const search = await searchJqlPaginated(client, jql, limit);
        const issues = search.issues;
        if (search.truncated) {
          console.error(chalk.yellow(
            `Warning: jira search returned ${issues.length} of ${search.matched} matched issues because --limit ${limit} was set.`,
          ));
        }

        if (format === 'json') {
          console.log(JSON.stringify(issues, null, 2));
        } else {
          console.log(chalk.bold(`\nSearch: ${jql}\n`));
          if (issues.length === 0) {
            console.log(chalk.dim('No issues found'));
          } else {
            if (format === 'compact') {
              console.log(chalk.dim('Key'.padEnd(12) + 'Status'.padEnd(15) + 'Assignee'.padEnd(20) + 'Summary'));
              console.log(chalk.dim('-'.repeat(80)));
            }
            for (const issue of issues) {
              if (format === 'verbose') {
                printIssueVerbose(issue, config.host);
              } else if (format === 'compact') {
                printIssueCompact(issue);
              } else {
                printIssueTitle(issue);
              }
            }
          }
          console.log(chalk.dim(`\nTotal: ${issues.length}`));
        }
      } catch (err) {
        console.error(chalk.red('Error:'), (err as Error).message);
        process.exit(1);
      }
    });

  // Create issue command
  jira
    .command('create <summary>')
    .description('Create a new issue')
    .option('--project <key>', 'Project key')
    .option('--description <text>', 'Description (supports Markdown)')
    .option('--assignee <name>', 'Assignee name')
    .option('--status <status>', 'Initial status: Icebox, Planned, In Progress, Test, Done')
    .option('--priority <priority>', 'Priority (e.g., High, Medium, Low)')
    .addHelpText('after', `
${chalk.yellow('Examples:')}
  ${chalk.dim('# Create task with all options')}
  claude-tools jira create "Fix login button" --project PROJ --assignee "Dana" --status "Planned" --description "Button not responding"

  ${chalk.dim('# Create with Markdown description')}
  claude-tools jira create "Feature request" --project PROJ --description "## Summary
- First point
- Second point

**Important:** Use markdown formatting"

  ${chalk.dim('# Create with description from file (stdin)')}
  cat description.md | claude-tools jira create "Feature request" --project PROJ --description -

${chalk.yellow('Available statuses:')} Icebox (default), Planned, In Progress, Test, Done
${chalk.yellow('Stdin support:')} Use --description - to read description from stdin (pipe from file)
`)
    .action(async (summary: string, options: { project?: string; description?: string; assignee?: string; status?: string; priority?: string }) => {
      const config = ensureJiraConfig();
      const service = new JiraService(config);

      try {
        // Resolve description (supports stdin via "-")
        const description = await resolveDescription(options.description);

        const result = await service.createIssue({
          summary,
          project: options.project,
          description,
          priority: options.priority,
        });

        // PROJ-4329: apply --status and --assignee, READ THE ISSUE BACK, and say by field what did not take.
        // "Created:" alone used to be printed while a ticket sat Icebox and unassigned.
        const fields = await applyCreateFields(service, result.key, {
          ...(options.status === undefined ? {} : { status: options.status }),
          ...(options.assignee === undefined ? {} : { assignee: options.assignee }),
        });
        const url = `https://${config.host}/browse/${result.key}`;
        if (fields.failed.length === 0) {
          const extras: string[] = [];
          if (options.assignee) extras.push(`assigned to ${fields.final?.assignee ?? options.assignee}`);
          if (options.status) extras.push(`status: ${fields.final?.status ?? options.status}`);
          const extrasStr = extras.length > 0 ? chalk.dim(` (${extras.join(', ')})`) : '';
          console.log(chalk.green('Created:'), chalk.cyan(result.key), `- ${summary}${extrasStr}`);
          console.log(chalk.dim(`URL: ${url}`));
          return;
        }
        // The ticket exists, so its key is printed; but the request was NOT honoured in full, and the exit
        // code says so, naming each field and the command that fixes it.
        console.error(chalk.red(`Created ${result.key}, but NOT everything asked for was applied:`));
        for (const failure of fields.failed) {
          const fix = failure.field === 'status'
            ? `claude-tools jira status ${result.key} "${options.status}"`
            : `claude-tools jira assign ${result.key} "${options.assignee}"`;
          console.error(chalk.red(`  ${failure.field}: ${failure.reason}`));
          console.error(chalk.dim(`    fix with: ${fix}`));
        }
        console.error(chalk.dim(`URL: ${url}`));
        process.exit(2);
      } catch (err) {
        console.error(chalk.red('Error:'), (err as Error).message);
        process.exit(1);
      }
    });

  // Update status command
  jira
    .command('status <issue> <status>')
    .description('Update issue status (transition)')
    .addHelpText('after', `
${chalk.yellow('Examples:')}
  ${chalk.dim('# Move to In Progress')}
  claude-tools jira status PROJ-123 "In Progress"

  ${chalk.dim('# Mark as Done')}
  claude-tools jira status PROJ-123 Done

${chalk.yellow('Note:')}
  Available transitions depend on your workflow. If a transition fails,
  the error will show available options.
`)
    .action(async (issue: string, status: string) => {
      const config = ensureJiraConfig();
      const service = new JiraService(config);

      try {
        await service.updateStatus(issue, status);
        console.log(chalk.green('Updated:'), chalk.cyan(issue), `-> ${status}`);
      } catch (err) {
        console.error(chalk.red('Error:'), (err as Error).message);
        process.exit(1);
      }
    });

  // Update issue fields command
  jira
    .command('update <issue>')
    .description('Update issue fields (summary, description, priority, labels)')
    .option('--title <text>', 'New summary/title')
    .option('--description <text>', 'New description (supports Markdown)')
    .option('--priority <priority>', 'New priority (e.g., High, Medium, Low)')
    .option('--labels <labels>', 'Comma-separated labels (replaces existing)')
    .addHelpText('after', `
${chalk.yellow('Examples:')}
  ${chalk.dim('# Update title/summary')}
  claude-tools jira update PROJ-123 --title "New title for the issue"

  ${chalk.dim('# Update description')}
  claude-tools jira update PROJ-123 --description "Updated description text"

  ${chalk.dim('# Update priority')}
  claude-tools jira update PROJ-123 --priority High

  ${chalk.dim('# Set labels')}
  claude-tools jira update PROJ-123 --labels "bug,urgent"

  ${chalk.dim('# Update description from file (stdin)')}
  cat description.md | claude-tools jira update PROJ-123 --description -

${chalk.yellow('Note:')}
  For status changes use: jira status <issue> <status>
  For assignment use: jira assign <issue> <user>
${chalk.yellow('Stdin support:')} Use --description - to read description from stdin (pipe from file)
`)
    .action(async (issue: string, options: { title?: string; description?: string; priority?: string; labels?: string }) => {
      const config = ensureJiraConfig();
      const service = new JiraService(config);

      try {
        // Resolve description (supports stdin via "-")
        const description = await resolveDescription(options.description);

        const labels = options.labels ? options.labels.split(',').map(l => l.trim()) : undefined;
        await service.updateIssue(issue, {
          summary: options.title,
          description,
          priority: options.priority,
          labels,
        });
        console.log(chalk.green('Updated:'), chalk.cyan(issue));
        if (options.title) console.log(`  Title: ${options.title}`);
        if (description) console.log(`  Description: ${description.slice(0, 50)}...`);
        if (options.priority) console.log(`  Priority: ${options.priority}`);
        if (labels) console.log(`  Labels: ${labels.join(', ')}`);
      } catch (err) {
        console.error(chalk.red('Error:'), (err as Error).message);
        process.exit(1);
      }
    });

  // Add comment command
  jira
    .command('comment <issue> <text>')
    .description('Add a comment to an issue (use "-" to read from stdin)')
    .addHelpText('after', `
${chalk.yellow('Examples:')}
  ${chalk.dim('# Add a comment')}
  claude-tools jira comment PROJ-123 "Working on this now"

  ${chalk.dim('# Add multi-line comment from file (stdin)')}
  cat comment.md | claude-tools jira comment PROJ-123 -

${chalk.yellow('Stdin support:')} Use "-" as text to read from stdin (pipe from file)
`)
    .action(async (issue: string, text: string) => {
      const config = ensureJiraConfig();
      const service = new JiraService(config);

      try {
        // Resolve text (supports stdin via "-")
        const resolvedText = await resolveDescription(text);
        if (!resolvedText) {
          console.error(chalk.red('Error: Comment text is required'));
          process.exit(1);
        }
        const commentId = await service.addComment(issue, resolvedText);
        console.log(chalk.green('Comment added'), `to ${chalk.cyan(issue)} (ID: ${commentId})`);
      } catch (err) {
        console.error(chalk.red('Error:'), (err as Error).message);
        process.exit(1);
      }
    });

  // Assign issue command
  jira
    .command('assign <issue> <assignee>')
    .description('Assign an issue to a user')
    .addHelpText('after', `
${chalk.yellow('Examples:')}
  ${chalk.dim('# Assign to user by name')}
  claude-tools jira assign PROJ-123 "Dana"

  ${chalk.dim('# Assign to yourself')}
  claude-tools jira assign PROJ-123 "John Doe"
`)
    .action(async (issue: string, assignee: string) => {
      const config = ensureJiraConfig();
      const service = new JiraService(config);

      try {
        await service.assignIssue(issue, assignee);
        console.log(chalk.green('Assigned:'), chalk.cyan(issue), `-> ${assignee}`);
      } catch (err) {
        console.error(chalk.red('Error:'), (err as Error).message);
        process.exit(1);
      }
    });

  // Team command - list assignable users
  jira
    .command('team [project]')
    .description('List users assignable to a project')
    .option('--limit <n>', 'Number of results', '50')
    .option('--json', 'Output as JSON')
    .addHelpText('after', `
${chalk.yellow('Examples:')}
  ${chalk.dim('# List assignable users in default project')}
  claude-tools jira team

  ${chalk.dim('# List assignable users in specific project')}
  claude-tools jira team PROJ

  ${chalk.dim('# Limit results')}
  claude-tools jira team --limit 10

  ${chalk.dim('# Output as JSON')}
  claude-tools jira team --json
`)
    .action(async (project: string | undefined, options: { limit: string; json?: boolean }) => {
      const config = ensureJiraConfig();
      const service = new JiraService(config);
      const limit = parseInt(options.limit, 10);

      try {
        const users = await service.listAssignableUsers(project, limit);
        const projectKey = project || config.defaultProject || 'Unknown';

        if (options.json) {
          console.log(JSON.stringify(users, null, 2));
        } else {
          console.log(chalk.bold(`\nAssignable Users (${projectKey}):\n`));
          if (users.length === 0) {
            console.log(chalk.dim('No assignable users found'));
          } else {
            console.log(chalk.dim('Name'.padEnd(32) + 'Account ID'));
            console.log(chalk.dim('-'.repeat(60)));

            for (const user of users) {
              const shortId = user.accountId.length > 20
                ? user.accountId.slice(0, 17) + '...'
                : user.accountId;
              console.log(
                user.displayName.slice(0, 30).padEnd(32) +
                chalk.dim(shortId)
              );
            }
          }
          console.log(chalk.dim(`\nTotal: ${users.length}`));
        }
      } catch (err) {
        console.error(chalk.red('Error:'), (err as Error).message);
        process.exit(1);
      }
    });

  // Show issue command
  jira
    .command('show <issue>')
    .description('Show issue details')
    .option('--json', 'Output as JSON')
    .action(async (issue: string, options: { json?: boolean }) => {
      const config = ensureJiraConfig();
      const service = new JiraService(config);

      try {
        const issueData = await service.getIssue(issue);

        if (options.json) {
          console.log(JSON.stringify(issueData, null, 2));
        } else {
          console.log();
          console.log(chalk.cyan(issueData.key), chalk.bold(issueData.summary));
          console.log(chalk.dim('-'.repeat(60)));
          console.log(`Type:     ${issueData.type}`);
          console.log(`Status:   ${issueData.status}`);
          console.log(`Priority: ${issueData.priority || 'None'}`);
          console.log(`Assignee: ${issueData.assignee || 'Unassigned'}`);
          console.log(`Created:  ${formatDate(issueData.created)}`);
          console.log(`Updated:  ${formatDate(issueData.updated)}`);

          // Display description if present
          if (issueData.description) {
            console.log();
            console.log(chalk.bold('Description:'));
            // Indent description lines for readability
            const descLines = issueData.description.split('\n');
            for (const line of descLines) {
              console.log(`  ${line}`);
            }
          }

          console.log(chalk.dim(`\nURL: https://${config.host}/browse/${issue}`));
        }
      } catch (err) {
        console.error(chalk.red('Error:'), (err as Error).message);
        process.exit(1);
      }
    });
}
