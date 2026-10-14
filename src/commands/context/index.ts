import { resolveChatId as resolveCachedChat } from '../../services/telegram-search.js';
import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import { spawnSync } from 'child_process';
import { loadConfig } from '../../config/loader.js';
import { getDatabase, type MessageRow } from '../../db/index.js';
import { getJiraDatabase, type JiraIssueRow, type JiraCommentRow } from '../../db/jira.js';
import { applyEntities, formatMessageLink, type StoredEntity } from '../telegram/format.js';

type Source = 'telegram' | 'jira' | 'git';
type JiraEventType = 'issue_created' | 'issue_updated' | 'comment_added' | 'comment_updated';

interface BaseEvent {
  source: Source;
  timestamp: number;
}

interface TelegramEvent extends BaseEvent {
  source: 'telegram';
  chatId: string;
  chatTitle?: string | null;
  sender: string;
  messageId: number;
  link: string;
  text?: string;
  replyToId?: number | null;
  replyToSender?: string | null;
  replyToPreview?: string | null;
  hasMedia: boolean;
  mediaType?: string | null;
}

interface JiraIssueEvent extends BaseEvent {
  source: 'jira';
  eventType: 'issue_created' | 'issue_updated';
  issueKey: string;
  projectKey: string;
  summary?: string | null;
  status?: string | null;
  assignee?: string | null;
  reporter?: string | null;
  priority?: string | null;
  issueType?: string | null;
  labels?: string[];
  url?: string;
}

interface JiraCommentEvent extends BaseEvent {
  source: 'jira';
  eventType: 'comment_added' | 'comment_updated';
  issueKey: string;
  projectKey: string;
  author?: string | null;
  body?: string | null;
  url?: string;
}

interface GitCommitEvent extends BaseEvent {
  source: 'git';
  eventType: 'commit';
  org: string;
  repo: string;
  sha: string;
  fullSha: string;
  author?: string | null;
  message: string;
  body?: string | null;
  url?: string;
}

interface GhRepo {
  name: string;
  isArchived?: boolean;
  isEmpty?: boolean;
  url?: string;
}

interface GhCommitAuthor {
  name?: string;
  email?: string;
  date?: string;
}

interface GhCommit {
  sha: string;
  html_url?: string;
  commit?: {
    message?: string;
    author?: GhCommitAuthor;
    committer?: GhCommitAuthor;
  };
  author?: {
    login?: string | null;
  } | null;
}

type ContextEvent = TelegramEvent | JiraIssueEvent | JiraCommentEvent | GitCommitEvent;

interface DateRange {
  startDate: Date;
  endDate: Date;
  startUnix: number;
  endUnix: number;
  startLabel: string;
  endLabel: string;
}

interface ExportOptions {
  days?: string;
  from?: string;
  to?: string;
  sources?: string;
  chat?: string;
  project?: string;
  org?: string;
  repos?: string;
  humanOnly?: boolean;
  json?: boolean;
  output?: string;
}

function parseSources(input?: string): Source[] {
  if (!input) return ['telegram', 'jira', 'git'];
  const raw = input.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const sources: Source[] = [];
  for (const item of raw) {
    if (item === 'telegram' || item === 'jira' || item === 'git') {
      sources.push(item);
    } else {
      console.log(chalk.yellow(`Unknown source ignored: ${item}`));
    }
  }
  return sources.length > 0 ? Array.from(new Set(sources)) : ['telegram', 'jira', 'git'];
}

function parseRepoFilter(input?: string): Set<string> | null {
  if (!input) return null;
  const repos = input
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
    .map(item => (item.includes('/') ? item.split('/')[1] : item));
  return repos.length > 0 ? new Set(repos) : null;
}

function parseDate(dateStr: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const date = new Date(`${dateStr}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function getUtcToday(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function endOfUtcDay(date: Date): Date {
  const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1));
  return new Date(next.getTime() - 1000);
}

function resolveDateRange(options: ExportOptions): DateRange {
  const days = parseInt(options.days || '3', 10);
  if (!Number.isFinite(days) || days <= 0) {
    console.error(chalk.red('Invalid --days value. Use a positive number.'));
    process.exit(1);
  }

  let startDate: Date | null = null;
  let endDate: Date | null = null;

  if (options.from || options.to) {
    const fromInput = options.from || options.to || '';
    const toInput = options.to || options.from || '';
    startDate = parseDate(fromInput);
    endDate = parseDate(toInput);
    if (!startDate || !endDate) {
      console.error(chalk.red('Invalid date format. Use YYYY-MM-DD for --from/--to.'));
      process.exit(1);
    }
  } else {
    endDate = getUtcToday();
    startDate = new Date(endDate.getTime());
    startDate.setUTCDate(endDate.getUTCDate() - (days - 1));
  }

  if (startDate.getTime() > endDate.getTime()) {
    console.error(chalk.red('Invalid range: --from must be before or equal to --to.'));
    process.exit(1);
  }

  const start = startOfUtcDay(startDate);
  const end = endOfUtcDay(endDate);

  return {
    startDate: start,
    endDate: end,
    startUnix: Math.floor(start.getTime() / 1000),
    endUnix: Math.floor(end.getTime() / 1000),
    startLabel: formatDate(start),
    endLabel: formatDate(end),
  };
}

function formatTimestamp(timestamp: number): string {
  const iso = new Date(timestamp * 1000).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`;
}

function runGh(args: string[], errorContext: string): string {
  const result = spawnSync('gh', args, {
    encoding: 'utf-8',
    maxBuffer: 50 * 1024 * 1024,
  });

  if (result.error) {
    console.error(chalk.red(`Failed to run gh (${errorContext}): ${result.error.message}`));
    process.exit(1);
  }

  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    console.error(chalk.red(`gh error (${errorContext})`));
    if (stderr) {
      console.error(stderr);
    }
    process.exit(1);
  }

  return (result.stdout || '').trim();
}

function parseJsonArray<T>(output: string, errorContext: string): T[] {
  if (!output) return [];
  try {
    const parsed = JSON.parse(output);
    if (Array.isArray(parsed)) return parsed as T[];
    return [parsed as T];
  } catch {
    console.error(chalk.red(`Failed to parse JSON (${errorContext})`));
    process.exit(1);
  }
}

function parseEntities(raw: string | null): StoredEntity[] | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredEntity[];
  } catch {
    return null;
  }
}

function resolveChatId(chatTitle: string): string | null { return resolveCachedChat(chatTitle); }

function getTelegramEvents(range: DateRange, chatId?: string, humanOnly: boolean = false): TelegramEvent[] {
  const db = getDatabase();

  let sql = `
    SELECT * FROM messages
    WHERE date BETWEEN ? AND ?
  `;
  const params: any[] = [range.startUnix, range.endUnix];

  if (chatId) {
    sql += ` AND chat_id = ?`;
    params.push(chatId);
  }

  if (humanOnly) {
    sql += ` AND COALESCE(sender, '') != 'Team Notifications'`;
  }

  sql += ` ORDER BY date ASC, id ASC`;

  const rows = db.prepare(sql).all(...params) as MessageRow[];
  const msgMap = new Map<string, MessageRow>();
  for (const row of rows) {
    msgMap.set(`${row.chat_id}:${row.id}`, row);
  }

  return rows.map(row => {
    const replyTo = row.reply_to_id ? msgMap.get(`${row.reply_to_peer_id || row.chat_id}:${row.reply_to_id}`) : null;
    const replyPreview = replyTo?.text
      ? replyTo.text.replace(/\n/g, ' ').slice(0, 80)
      : null;

    const entities = parseEntities(row.entities);
    const formattedText = row.text ? applyEntities(row.text, entities) : undefined;

    return {
      source: 'telegram',
      timestamp: row.date,
      chatId: row.chat_id,
      chatTitle: row.chat_title,
      sender: row.sender || 'Unknown',
      messageId: row.id,
      link: formatMessageLink(row.chat_id, row.id),
      text: formattedText,
      replyToId: row.reply_to_id,
      replyToSender: replyTo?.sender || null,
      replyToPreview: replyPreview,
      hasMedia: !!row.has_media,
      mediaType: row.media_type,
    };
  });
}

function getJiraIssueEvents(range: DateRange, projectKey?: string, host?: string): JiraIssueEvent[] {
  const db = getJiraDatabase();

  let sql = `
    SELECT * FROM jira_issues
    WHERE (created BETWEEN ? AND ?) OR (updated BETWEEN ? AND ?)
  `;
  const params: any[] = [range.startUnix, range.endUnix, range.startUnix, range.endUnix];

  if (projectKey) {
    sql += ` AND project_key = ?`;
    params.push(projectKey);
  }

  sql += ` ORDER BY updated ASC`;

  const rows = db.prepare(sql).all(...params) as JiraIssueRow[];
  const events: JiraIssueEvent[] = [];

  for (const row of rows) {
    const createdInRange = row.created >= range.startUnix && row.created <= range.endUnix;
    const updatedInRange = row.updated >= range.startUnix && row.updated <= range.endUnix;
    const labels = row.labels ? JSON.parse(row.labels) as string[] : [];
    const url = host ? `https://${host.replace(/^https?:\/\//, '')}/browse/${row.key}` : undefined;

    if (createdInRange) {
      events.push({
        source: 'jira',
        eventType: 'issue_created',
        timestamp: row.created,
        issueKey: row.key,
        projectKey: row.project_key,
        summary: row.summary,
        status: row.status,
        assignee: row.assignee_name,
        reporter: row.reporter_name,
        priority: row.priority,
        issueType: row.issue_type,
        labels,
        url,
      });
    }

    if (updatedInRange && row.updated !== row.created) {
      events.push({
        source: 'jira',
        eventType: 'issue_updated',
        timestamp: row.updated,
        issueKey: row.key,
        projectKey: row.project_key,
        summary: row.summary,
        status: row.status,
        assignee: row.assignee_name,
        reporter: row.reporter_name,
        priority: row.priority,
        issueType: row.issue_type,
        labels,
        url,
      });
    }
  }

  return events;
}

function getJiraCommentEvents(range: DateRange, projectKey?: string, host?: string): JiraCommentEvent[] {
  const db = getJiraDatabase();

  let sql = `
    SELECT c.*, i.project_key
    FROM jira_comments c
    JOIN jira_issues i ON i.id = c.issue_id
    WHERE (c.created BETWEEN ? AND ?) OR (c.updated BETWEEN ? AND ?)
  `;
  const params: any[] = [range.startUnix, range.endUnix, range.startUnix, range.endUnix];

  if (projectKey) {
    sql += ` AND i.project_key = ?`;
    params.push(projectKey);
  }

  sql += ` ORDER BY c.created ASC`;

  const rows = db.prepare(sql).all(...params) as (JiraCommentRow & { project_key: string })[];
  const events: JiraCommentEvent[] = [];

  for (const row of rows) {
    const createdInRange = row.created >= range.startUnix && row.created <= range.endUnix;
    const updatedInRange = row.updated ? (row.updated >= range.startUnix && row.updated <= range.endUnix) : false;
    const url = host ? `https://${host.replace(/^https?:\/\//, '')}/browse/${row.issue_key}` : undefined;

    if (createdInRange) {
      events.push({
        source: 'jira',
        eventType: 'comment_added',
        timestamp: row.created,
        issueKey: row.issue_key,
        projectKey: row.project_key,
        author: row.author_name,
        body: row.body,
        url,
      });
    }

    if (updatedInRange && row.updated && row.updated !== row.created) {
      events.push({
        source: 'jira',
        eventType: 'comment_updated',
        timestamp: row.updated,
        issueKey: row.issue_key,
        projectKey: row.project_key,
        author: row.author_name,
        body: row.body,
        url,
      });
    }
  }

  return events;
}

function getOrgRepos(org: string, filter?: Set<string>): GhRepo[] {
  const output = runGh(
    ['repo', 'list', org, '--limit', '1000', '--json', 'name,isArchived,isEmpty,url'],
    `repo list ${org}`
  );
  const repos = parseJsonArray<GhRepo>(output, `repo list ${org}`);

  if (!filter) {
    return repos.filter(repo => !repo.isArchived && !repo.isEmpty);
  }

  const byName = new Map(repos.map(repo => [repo.name, repo]));
  const selected: GhRepo[] = [];
  const missing: string[] = [];

  for (const name of filter) {
    const repo = byName.get(name);
    if (repo) {
      selected.push(repo);
    } else {
      missing.push(name);
    }
  }

  if (missing.length > 0) {
    console.log(chalk.yellow(`Repos not found in ${org}: ${missing.join(', ')}`));
  }

  return selected;
}

function fetchRepoCommits(org: string, repo: string, sinceIso: string, untilIso: string): GhCommit[] {
  const commits: GhCommit[] = [];
  const perPage = 100;
  let page = 1;
  const maxPages = 200;

  while (page <= maxPages) {
    const params = new URLSearchParams({
      since: sinceIso,
      until: untilIso,
      per_page: perPage.toString(),
      page: page.toString(),
    });
    const output = runGh(
      ['api', `repos/${org}/${repo}/commits?${params.toString()}`],
      `commits ${org}/${repo} page ${page}`
    );

    const pageCommits = parseJsonArray<GhCommit>(output, `commits ${org}/${repo} page ${page}`);
    if (pageCommits.length === 0) {
      break;
    }

    commits.push(...pageCommits);

    if (pageCommits.length < perPage) {
      break;
    }

    page += 1;
  }

  return commits;
}

function getGitEvents(range: DateRange, org: string, repoFilter?: Set<string>): { events: GitCommitEvent[]; repos: string[] } {
  const repos = getOrgRepos(org, repoFilter);
  const sinceIso = range.startDate.toISOString();
  const untilIso = range.endDate.toISOString();
  const events: GitCommitEvent[] = [];

  for (const repo of repos) {
    const commits = fetchRepoCommits(org, repo.name, sinceIso, untilIso);
    for (const commit of commits) {
      const message = (commit.commit?.message || '').trim();
      const [subjectLine, ...bodyLines] = message.split(/\r?\n/);
      const body = bodyLines.join('\n').trim();

      const dateStr = commit.commit?.committer?.date || commit.commit?.author?.date;
      if (!dateStr) {
        continue;
      }

      const timestamp = Math.floor(new Date(dateStr).getTime() / 1000);
      if (timestamp < range.startUnix || timestamp > range.endUnix) {
        continue;
      }

      const author = commit.commit?.author?.name || commit.author?.login || commit.commit?.committer?.name || null;
      const subject = subjectLine || '(no message)';

      events.push({
        source: 'git',
        eventType: 'commit',
        timestamp,
        org,
        repo: repo.name,
        sha: commit.sha.slice(0, 7),
        fullSha: commit.sha,
        author,
        message: subject,
        body: body || null,
        url: commit.html_url || repo.url,
      });
    }
  }

  return { events, repos: repos.map(repo => repo.name) };
}

function pushTextBlock(lines: string[], label: string, text?: string | null): void {
  if (!text) return;
  lines.push(`${label}:`);
  const textLines = text.split('\n');
  for (const line of textLines) {
    lines.push(`  ${line}`);
  }
}

function renderEvent(event: ContextEvent): string[] {
  const lines: string[] = [];
  lines.push('=== EVENT ===');
  lines.push(`time: ${formatTimestamp(event.timestamp)}`);
  lines.push(`source: ${event.source}`);

  if (event.source === 'telegram') {
    lines.push(`chat: ${event.chatTitle || event.chatId}`);
    lines.push(`sender: ${event.sender}`);
    lines.push(`message_id: ${event.messageId}`);
    lines.push(`link: ${event.link}`);
    if (event.replyToId) {
      const replyInfo = event.replyToSender
        ? `${event.replyToId} (${event.replyToSender})`
        : `${event.replyToId}`;
      const preview = event.replyToPreview ? ` "${event.replyToPreview}"` : '';
      lines.push(`reply_to: ${replyInfo}${preview}`);
    }
    pushTextBlock(lines, 'text', event.text);
    if (event.hasMedia) {
      lines.push(`media: ${event.mediaType || 'media'}`);
    }
  }

  if (event.source === 'jira') {
    lines.push(`type: ${event.eventType}`);
    lines.push(`issue: ${event.issueKey}`);
    lines.push(`project: ${event.projectKey}`);
    if ('summary' in event && event.summary) {
      lines.push(`summary: ${event.summary}`);
    }
    if ('status' in event && event.status) {
      lines.push(`status: ${event.status}`);
    }
    if ('assignee' in event && event.assignee) {
      lines.push(`assignee: ${event.assignee}`);
    }
    if ('reporter' in event && event.reporter) {
      lines.push(`reporter: ${event.reporter}`);
    }
    if ('priority' in event && event.priority) {
      lines.push(`priority: ${event.priority}`);
    }
    if ('issueType' in event && event.issueType) {
      lines.push(`issue_type: ${event.issueType}`);
    }
    if ('labels' in event && event.labels && event.labels.length > 0) {
      lines.push(`labels: ${event.labels.join(', ')}`);
    }
    if ('author' in event && event.author) {
      lines.push(`author: ${event.author}`);
    }
    if ('body' in event && event.body) {
      pushTextBlock(lines, 'text', event.body);
    }
    if (event.url) {
      lines.push(`url: ${event.url}`);
    }
  }

  if (event.source === 'git') {
    lines.push(`type: ${event.eventType}`);
    lines.push(`org: ${event.org}`);
    lines.push(`repo: ${event.repo}`);
    lines.push(`sha: ${event.sha}`);
    lines.push(`full_sha: ${event.fullSha}`);
    if (event.author) {
      lines.push(`author: ${event.author}`);
    }
    lines.push(`message: ${event.message}`);
    if (event.body) {
      pushTextBlock(lines, 'body', event.body);
    }
    if (event.url) {
      lines.push(`url: ${event.url}`);
    }
  }

  return lines;
}

export function registerContextCommands(program: Command): void {
  const context = program
    .command('context')
    .description('Export multi-source context with events');

  context
    .command('export-range')
    .description('Export events from Telegram, Jira, and GitHub for a date range')
    .option('--days <n>', 'Number of days ending today (default: 3)', '3')
    .option('--from <date>', 'Start date (YYYY-MM-DD)')
    .option('--to <date>', 'End date (YYYY-MM-DD)')
    .option('--sources <list>', 'Sources to include: telegram,jira,git', 'telegram,jira,git')
    .option('--chat <name>', 'Telegram chat title (defaults to project defaultChat if set)')
    .option('--project <key>', 'Jira project key (defaults to project defaultProject if set)')
    .option('--org <name>', 'GitHub org (required, or set GITHUB_ORG)')
    .option('--repos <list>', 'Comma-separated GitHub repos to include (optional)')
    .option('--human-only', 'Exclude automated bot messages (Team Notifications)')
    .option('--json', 'Output JSON instead of text')
    .option('--output <file>', 'Save output to file')
    .addHelpText('after', `
${chalk.yellow('Examples:')}
  ${chalk.dim('# Export last 3 days (default)')}
  claude-tools context export-range

  ${chalk.dim('# Export last 7 days')}
  claude-tools context export-range --days 7

  ${chalk.dim('# Export specific range')}
  claude-tools context export-range --from 2026-01-01 --to 2026-01-07

  ${chalk.dim('# Telegram only')}
  claude-tools context export-range --sources telegram --chat "Team Dev Chat"

  ${chalk.dim('# GitHub only (org scope)')}
  claude-tools context export-range --sources git --org acme
`)
    .action((options: ExportOptions) => {
      const range = resolveDateRange(options);
      const sources = parseSources(options.sources);
      const config = loadConfig();

      let chatId: string | undefined;
      if (sources.includes('telegram')) {
        const chatTitle = options.chat || config.telegram?.defaultChat || process.env.TELEGRAM_DEFAULT_CHAT;
        if (chatTitle) {
          const resolvedChatId = resolveChatId(chatTitle);
          if (!resolvedChatId) {
            console.error(chalk.red(`Chat "${chatTitle}" not found in synced chats`));
            process.exit(1);
          }
          chatId = resolvedChatId;
        }
      }

      const projectKey = options.project || config.jira?.defaultProject || process.env.JIRA_DEFAULT_PROJECT || undefined;
      const host = config.jira?.host || process.env.JIRA_HOST || undefined;
      const gitOrg = options.org || process.env.GITHUB_ORG;
      const repoFilter = parseRepoFilter(options.repos);

      let events: ContextEvent[] = [];
      let gitRepos: string[] = [];

      if (sources.includes('telegram')) {
        events = events.concat(getTelegramEvents(range, chatId, !!options.humanOnly));
      }

      if (sources.includes('jira')) {
        events = events.concat(getJiraIssueEvents(range, projectKey, host));
        events = events.concat(getJiraCommentEvents(range, projectKey, host));
      }

      if (sources.includes('git')) {
        if (!gitOrg) {
          throw new Error('A GitHub org is required for --sources git: pass --org <name> or set GITHUB_ORG.');
        }
        const gitResult = getGitEvents(range, gitOrg, repoFilter ?? undefined);
        gitRepos = gitResult.repos;
        events = events.concat(gitResult.events);
      }

      events.sort((a, b) => a.timestamp - b.timestamp || a.source.localeCompare(b.source));

      if (events.length === 0) {
        console.log(chalk.yellow(`No events found for ${range.startLabel} to ${range.endLabel}`));
        process.exit(0);
      }

      if (options.json) {
        const jsonOutput = {
          range: {
            from: range.startLabel,
            to: range.endLabel,
            timezone: 'UTC',
          },
          sources,
          git: sources.includes('git')
            ? {
                org: gitOrg,
                repos: gitRepos,
              }
            : undefined,
          events: events.map(event => ({
            ...event,
            time: formatTimestamp(event.timestamp),
          })),
        };

        const jsonText = JSON.stringify(jsonOutput, null, 2);
        if (options.output) {
          fs.writeFileSync(options.output, jsonText, 'utf-8');
          console.log(chalk.green(`Output saved to ${options.output}`));
        } else {
          console.log(jsonText);
        }
        return;
      }

      const lines: string[] = [];
      lines.push('# Context Export');
      lines.push(`Range: ${range.startLabel} to ${range.endLabel} (UTC)`);
      lines.push(`Sources: ${sources.join(', ')}`);
      lines.push(`Events: ${events.length}`);
      if (chatId) {
        const chatTitle = options.chat || config.telegram?.defaultChat || chatId;
        lines.push(`Telegram chat: ${chatTitle}`);
      }
      if (projectKey) {
        lines.push(`Jira project: ${projectKey}`);
      }
      if (sources.includes('git')) {
        lines.push(`GitHub org: ${gitOrg}`);
        if (repoFilter) {
          lines.push(`GitHub repos: ${Array.from(repoFilter).join(', ')}`);
        } else if (gitRepos.length > 0) {
          lines.push(`GitHub repos: ${gitRepos.length}`);
        }
      }
      lines.push('');

      for (const event of events) {
        lines.push(...renderEvent(event));
        lines.push('');
      }

      const outputText = lines.join('\n');
      if (options.output) {
        fs.writeFileSync(options.output, outputText, 'utf-8');
        console.log(chalk.green(`Output saved to ${options.output}`));
      } else {
        console.log(outputText);
      }
    });
}
