// JIRA health monitor command — stuck tickets, inactive users, low pipelines

import { Command } from 'commander';
import chalk from 'chalk';
import { AgileClient, Version2Client } from 'jira.js';
import { join } from 'path';
import {
  loadConfig,
  getConfigDir,
  resolveEscalationTiers,
  resolveJiraMonitorNotify,
  resolveJiraMonitorStaleness,
  resolvePipelineStatuses,
} from '../../config/loader.js';
import type {
  JiraMonitorNotifyDestination,
  ResolvedJiraMonitorNotifyConfig,
} from '../../config/types.js';
import { TelegramService } from '../../services/telegram.js';
import {
  findStuckInProgress,
  findInactiveUsers,
  findLowPipelineUsers,
  findStaleTickets,
  type StuckIssue,
  type InactiveUser,
  type LowPipelineUser,
  type StalenessResult,
} from '../../services/jira-monitor.js';
import { fetchBacklogKeys, resolveBoardId } from '../../services/jira-board.js';
import {
  classify,
  createEmptyState,
  loadState,
  resetState,
  saveState,
  stateAfterDeliveries,
  type AlertClass,
  type AlertRef,
  type ClassificationResult,
  type ClassifiedItem,
  type JiraMonitorState,
} from '../../services/jira-monitor-state.js';

// ── Helpers ─────────────────────────────────────────────────────────

function formatDays(n: number): string {
  if (n > 365) return `${Math.floor(n / 365)}y ${n % 365}d`;
  if (n > 30) return `${Math.floor(n / 30)}mo ${n % 30}d`;
  return `${n}d`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function resolveHandle(name: string, mapping: Record<string, string>): string {
  return mapping[name] || name;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k) || [];
    list.push(item);
    map.set(k, list);
  }
  return map;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function alertRefKey(ref: AlertRef): string {
  return `${ref.alertClass}:${ref.key}`;
}

interface BuiltAlertMessage {
  text: string;
  refs: AlertRef[];
}

export interface RoutedAlertMessage extends BuiltAlertMessage {
  chat: string;
  destination: Exclude<JiraMonitorNotifyDestination, 'off'>;
}

export interface SkippedDm {
  alertClass: AlertClass;
  key: string;
  person: string;
}

export interface TelegramNotificationSender {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendMessage(
    chat: string,
    text: string,
    replyToMsgId?: number,
    parseMode?: string,
    mute?: boolean,
  ): Promise<{ messageId: number; chatId: string }>;
}

interface DeliveryStateContext {
  path: string;
  previous: JiraMonitorState;
  classified: ClassificationResult;
}

interface DeliverOptions {
  state?: DeliveryStateContext;
  /** Configured routes which could not be attempted (for example, unmapped DMs). */
  pendingRefs?: AlertRef[];
  /**
   * Deliver silently (no notification sound). From the `--mute` flag added in
   * 49c0b13. Applies to every route — group, PM and DM — so an out-of-hours run
   * cannot wake anyone through a channel that was overlooked.
   */
  mute?: boolean;
  delayMs?: number;
  now?: () => string;
  log?: (message: string) => void;
}

export interface DeliveryResult {
  sent: number;
  failedDms: Array<{ message: RoutedAlertMessage; error: unknown }>;
  deliveredRefs: AlertRef[];
}

/** Send sequentially, persisting only items whose complete configured route set succeeded. */
export async function deliverNotifications(
  sender: TelegramNotificationSender,
  messages: RoutedAlertMessage[],
  options: DeliverOptions = {},
): Promise<DeliveryResult> {
  const remaining = new Map<string, number>();
  for (const message of messages) {
    for (const ref of message.refs) {
      const key = alertRefKey(ref);
      remaining.set(key, (remaining.get(key) || 0) + 1);
    }
  }
  for (const ref of options.pendingRefs || []) {
    const key = alertRefKey(ref);
    remaining.set(key, (remaining.get(key) || 0) + 1);
  }

  const delivered = new Map<string, AlertRef>();
  const failedDms: Array<{ message: RoutedAlertMessage; error: unknown }> = [];
  let persistedState = options.state?.previous;
  let sent = 0;
  let connected = false;

  try {
    await sender.connect();
    connected = true;
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      let messageId: number;
      try {
        ({ messageId } = await sender.sendMessage(
          message.chat,
          message.text,
          undefined,
          'html',
          options.mute === true,
        ));
      } catch (error) {
        if (message.destination === 'dm') {
          failedDms.push({ message, error });
          options.log?.(`  [${i + 1}/${messages.length}] DM failed for ${message.chat}; continuing`);
          continue;
        }
        throw error;
      }

      sent++;
      options.log?.(`  [${i + 1}/${messages.length}] sent to ${message.chat} (msg #${messageId})`);

      let newlyCompleted = false;
      const completedThisMessage: AlertRef[] = [];
      for (const ref of message.refs) {
        const key = alertRefKey(ref);
        const count = (remaining.get(key) || 0) - 1;
        remaining.set(key, count);
        if (count === 0) {
          delivered.set(key, ref);
          newlyCompleted = true;
          completedThisMessage.push(ref);
        }
      }

      if (newlyCompleted && options.state && persistedState) {
        const notifiedAt = options.now?.() || new Date().toISOString();
        persistedState = stateAfterDeliveries(
          persistedState,
          options.state.classified,
          completedThisMessage,
          notifiedAt,
        );
        saveState(options.state.path, persistedState);
      }

      if (i < messages.length - 1 && (options.delayMs ?? 1000) > 0) {
        await new Promise(resolve => setTimeout(resolve, options.delayMs ?? 1000));
      }
    }
  } finally {
    if (connected) await sender.disconnect();
  }

  return { sent, failedDms, deliveredRefs: [...delivered.values()] };
}

// ── Console Formatters ──────────────────────────────────────────────

function printStuckSummary(stuck: StuckIssue[], mapping: Record<string, string>): void {
  if (stuck.length === 0) {
    console.log(chalk.dim('  (none)'));
    return;
  }
  const byAssignee = groupBy(stuck, i => i.assignee || '(unassigned)');
  for (const [assignee, tickets] of byAssignee) {
    const handle = resolveHandle(assignee, mapping);
    const oldest = Math.max(...tickets.map(t => t.stuckDays));
    const label = handle !== assignee ? `${assignee} (${handle})` : assignee;
    console.log(`  ${chalk.bold(label)}: ${tickets.length} stuck, oldest ${formatDays(oldest)}`);
  }
}

function printStuckDetailed(stuck: StuckIssue[], mapping: Record<string, string>): void {
  if (stuck.length === 0) {
    console.log(chalk.dim('  (none)'));
    return;
  }
  const byAssignee = groupBy(stuck, i => i.assignee || '(unassigned)');
  for (const [assignee, tickets] of byAssignee) {
    const handle = resolveHandle(assignee, mapping);
    const label = handle !== assignee ? `${assignee} (${handle})` : assignee;
    console.log(`  ${chalk.bold(label)}:`);
    for (const t of tickets) {
      console.log(`    ${chalk.cyan(t.key.padEnd(10))} ${chalk.yellow(formatDays(t.stuckDays).padEnd(8))} "${t.summary.slice(0, 180)}"`);
    }
  }
}

function printInactiveSummary(inactive: InactiveUser[], mapping: Record<string, string>): void {
  if (inactive.length === 0) {
    console.log(chalk.dim('  (none)'));
    return;
  }
  for (const u of inactive) {
    const handle = resolveHandle(u.name, mapping);
    const label = handle !== u.name ? `${u.name} (${handle})` : u.name;
    console.log(`  ${chalk.bold(label)}: last activity ${formatDays(u.daysSinceActivity)} ago, ${u.ticketCount} open tickets`);
  }
}

function printLowPipelineSummary(low: LowPipelineUser[], mapping: Record<string, string>): void {
  if (low.length === 0) {
    console.log(chalk.dim('  (none)'));
    return;
  }
  for (const u of low) {
    const handle = resolveHandle(u.name, mapping);
    const label = handle !== u.name ? `${u.name} (${handle})` : u.name;
    console.log(`  ${chalk.bold(label)}: ${u.plannedCount} planned on-board (total: ${u.totalPipeline})`);
  }
}

function printStalenessTier(
  tickets: StalenessResult['ageing'],
  mapping: Record<string, string>,
): void {
  if (tickets.length === 0) {
    console.log(chalk.dim('  (none)'));
    return;
  }
  const byAssignee = groupBy(tickets, ticket => ticket.assignee || '(unassigned)');
  for (const [assignee, personTickets] of byAssignee) {
    const handle = resolveHandle(assignee, mapping);
    const label = handle !== assignee ? `${assignee} (${handle})` : assignee;
    console.log(`  ${chalk.bold(label)}:`);
    for (const ticket of personTickets) {
      console.log(
        `    ${chalk.cyan(ticket.key.padEnd(10))} ${ticket.status.padEnd(12)} ` +
          `idle ${chalk.yellow(formatDays(ticket.idleDays).padEnd(8))} ` +
          `created ${formatDays(ticket.createdDays).padEnd(8)} "${ticket.summary.slice(0, 180)}"`,
      );
    }
  }
}

// ── Telegram Message Builders ───────────────────────────────────────

const BATCH_TICKETS = 3;
const DEFAULT_STATE_PATH = join(getConfigDir(), 'jira-monitor', 'state.json');

function escapeName(assignee: string, mapping: Record<string, string>): string {
  const handle = mapping[assignee];
  return handle ? handle : escapeHtml(assignee);
}

const SUMMARY_TRUNCATE = 180;

/** Build the JIRA browse URL prefix (no trailing slash) from config, deriving from jira.host if not overridden. */
function resolveBrowseBaseUrl(
  jiraHost: string,
  browseBaseUrlOverride: string | undefined,
): string {
  if (browseBaseUrlOverride) {
    return browseBaseUrlOverride.replace(/\/+$/, '');
  }
  const host = jiraHost.startsWith('http') ? jiraHost : `https://${jiraHost}`;
  return `${host.replace(/\/+$/, '')}/browse`;
}

function jiraLink(key: string, browseBaseUrl: string): string {
  return `<a href="${browseBaseUrl}/${key}">${key}</a>`;
}

function buildStuckMessages(
  classified: ClassifiedItem<StuckIssue>[],
  mapping: Record<string, string>,
  detailed: boolean,
  days: number,
  browseBaseUrl: string,
): BuiltAlertMessage[] {
  const stuck = classified.map(entry => entry.item);
  if (stuck.length === 0) return [];

  const refFor = (item: StuckIssue): AlertRef => ({ alertClass: 'stuck', key: item.key });

  if (!detailed) {
    const byAssignee = groupBy(stuck, i => i.assignee || '(unassigned)');
    let msg = `<b><u>⚠️ Stuck In Progress</u></b> (${stuck.length} tickets, ${days}+ days no activity)\n`;
    for (const [assignee, tickets] of byAssignee) {
      const oldest = Math.max(...tickets.map(t => t.stuckDays));
      msg += `\n${escapeName(assignee, mapping)}: ${tickets.length} stuck, oldest ${formatDays(oldest)}`;
    }
    msg += '\n\n#jira_monitor';
    return [{ text: msg, refs: stuck.map(refFor) }];
  }

  const messages: BuiltAlertMessage[] = [];
  const byAssignee = groupBy(stuck, i => i.assignee || '(unassigned)');

  for (const [assignee, tickets] of byAssignee) {
    const name = escapeName(assignee, mapping);
    const batches = chunk(tickets, BATCH_TICKETS);

    for (let bi = 0; bi < batches.length; bi++) {
      const batch = batches[bi];
      let msg = `<b><u>⚠️ Stuck In Progress</u></b> — ${name}`;
      if (batches.length > 1) msg += ` (${bi + 1}/${batches.length})`;

      for (const t of batch) {
        msg += `\n\n${jiraLink(t.key, browseBaseUrl)}: ${escapeHtml(t.summary.slice(0, SUMMARY_TRUNCATE))}`;
        msg += `\nStuck: <b>${formatDays(t.stuckDays)}</b>`;
      }
      msg += '\n\n#jira_monitor';
      messages.push({ text: msg, refs: batch.map(refFor) });
    }
  }

  return messages;
}

function buildInactiveMessages(
  classified: ClassifiedItem<InactiveUser>[],
  mapping: Record<string, string>,
  days: number,
): BuiltAlertMessage[] {
  const inactive = classified.map(entry => entry.item);
  if (inactive.length === 0) return [];

  let msg = `<b><u>⚠️ Inactive Users</u></b> (no JIRA activity in ${days}+ days)\n`;
  for (const u of inactive) {
    msg += `\n${escapeName(u.name, mapping)}: last activity <b>${formatDays(u.daysSinceActivity)}</b> ago, ${u.ticketCount} open tickets`;
  }
  msg += '\n\n#jira_monitor';
  return [{
    text: msg,
    refs: inactive.map(item => ({ alertClass: 'inactive', key: item.name })),
  }];
}

function buildLowPipelineMessages(
  classified: ClassifiedItem<LowPipelineUser>[],
  mapping: Record<string, string>,
  minTasks: number,
): BuiltAlertMessage[] {
  const low = classified.map(entry => entry.item);
  if (low.length === 0) return [];

  let msg = `<b><u>⚠️ Low Pipeline</u></b> (fewer than ${minTasks} planned on-board tasks)\n`;
  for (const u of low) {
    msg += `\n${escapeName(u.name, mapping)}: ${u.plannedCount} planned on-board`;
  }
  msg += '\n\n#jira_monitor';
  return [{
    text: msg,
    refs: low.map(item => ({ alertClass: 'lowPipeline', key: item.name })),
  }];
}

function notificationCandidates<T>(items: ClassifiedItem<T>[] | undefined): ClassifiedItem<T>[] {
  return items?.filter(item => item.classification !== 'unchanged') || [];
}

function notificationCandidateCount(classified: ClassificationResult): number {
  return notificationCandidates(classified.stuck).length
    + notificationCandidates(classified.inactive).length
    + notificationCandidates(classified.lowPipeline).length;
}

function appendAtDestination(
  target: RoutedAlertMessage[],
  built: BuiltAlertMessage[],
  chat: string,
  destination: Exclude<JiraMonitorNotifyDestination, 'off'>,
): void {
  for (const message of built) {
    target.push({ ...message, chat, destination });
  }
}

export function buildRoutedMessages(
  classified: ClassificationResult,
  routing: ResolvedJiraMonitorNotifyConfig,
  mapping: Record<string, string>,
  groupChat: string,
  pmChat: string,
  detailed: boolean,
  days: number,
  minTasks: number,
  browseBaseUrl: string,
): { messages: RoutedAlertMessage[]; skippedDms: SkippedDm[]; pendingRefs: AlertRef[] } {
  const messages: RoutedAlertMessage[] = [];
  const skippedDms: SkippedDm[] = [];
  const pendingRefs: AlertRef[] = [];

  const stuck = notificationCandidates(classified.stuck);
  const inactive = notificationCandidates(classified.inactive);
  const lowPipeline = notificationCandidates(classified.lowPipeline);

  const routeStandard = <T>(
    alertClass: AlertClass,
    items: ClassifiedItem<T>[],
    routes: JiraMonitorNotifyDestination[],
    build: (selected: ClassifiedItem<T>[]) => BuiltAlertMessage[],
    personOf: (item: T) => string | null,
  ): void => {
    if (routes.length === 0 || routes.includes('off')) return;

    if (routes.includes('group')) appendAtDestination(messages, build(items), groupChat, 'group');
    if (routes.includes('pm') && (!routes.includes('group') || pmChat !== groupChat)) {
      appendAtDestination(messages, build(items), pmChat, 'pm');
    }

    if (!routes.includes('dm')) return;
    const byPerson = groupBy(items, entry => personOf(entry.item) || '(unassigned)');
    for (const [person, ownItems] of byPerson) {
      if (person === '(unassigned)') {
        // Unassigned work has no DM target. If it was not already included in
        // the configured group route, add the mandatory group fallback now.
        if (!routes.includes('group')) {
          appendAtDestination(messages, build(ownItems), groupChat, 'group');
        }
        continue;
      }

      const handle = mapping[person];
      if (!handle) {
        for (const entry of ownItems) {
          skippedDms.push({ alertClass, key: entry.key, person });
          pendingRefs.push({ alertClass, key: entry.key });
        }
        continue;
      }
      appendAtDestination(messages, build(ownItems), handle, 'dm');
    }
  };

  routeStandard(
    'stuck',
    stuck,
    routing.stuck,
    selected => buildStuckMessages(selected, mapping, detailed, days, browseBaseUrl),
    item => item.assignee,
  );
  routeStandard(
    'inactive',
    inactive,
    routing.inactive,
    selected => buildInactiveMessages(selected, mapping, days),
    item => item.name,
  );
  routeStandard(
    'lowPipeline',
    lowPipeline,
    routing.lowPipeline,
    selected => buildLowPipelineMessages(selected, mapping, minTasks),
    item => item.name,
  );

  return { messages, skippedDms, pendingRefs };
}

function printClassification(classified: ClassificationResult, statePath: string): void {
  console.log(chalk.bold(`State classification (${statePath})`));
  const print = <T>(
    alertClass: AlertClass,
    items: ClassifiedItem<T>[] | undefined,
    describe: (entry: ClassifiedItem<T>) => string,
  ) => {
    for (const entry of items || []) {
      const label = entry.classification === 'unchanged' ? 'suppressed' : entry.classification.toUpperCase();
      console.log(`  [${label}] ${alertClass}: ${describe(entry)}`);
    }
  };
  print('stuck', classified.stuck, entry => `${entry.key} (${entry.item.assignee || '(unassigned)'})`);
  print('inactive', classified.inactive, entry => entry.key);
  print('lowPipeline', classified.lowPipeline, entry => entry.key);
  const resolved = Object.values(classified.resolved).reduce((sum, keys) => sum + keys.length, 0);
  console.log(`  resolved: ${resolved}`);
}

function printSkippedDms(skippedDms: SkippedDm[]): void {
  for (const skipped of skippedDms) {
    console.log(chalk.yellow(
      `Skipped DM for ${skipped.alertClass} ${skipped.key}: no mapped @handle for ${skipped.person}`,
    ));
  }
}

// ── Command Registration ────────────────────────────────────────────

export function registerMonitorCommand(jira: Command): void {
  jira
    .command('monitor')
    .description('Monitor JIRA health: stuck tickets, inactive users, low pipelines, staleness')
    .option('--stuck', 'Check only stuck In Progress tickets')
    .option('--inactive', 'Check only users with no activity')
    .option('--low-pipeline', 'Check only users with few planned tasks')
    .option('--staleness', 'Check ageing and stale on-board In Progress/Planned tickets')
    .option('--days <n>', 'Days threshold for stuck/inactive', '7')
    .option('--min-tasks <n>', 'Min pipeline tasks threshold', '2')
    .option('--project <key>', 'Project key')
    .option('--notify', 'Send Telegram notifications instead of dry run')
    .option('--state [path]', 'Enable dedupe state (default: config directory jira-monitor/state.json)')
    .option('--reset-state', 'Delete the selected/default state file before this run')
    .option('--mute', 'Send notifications without sound (message still delivered)')
    .option('--detailed', 'Show individual tickets (default: summary per person)')
    .option('--json', 'Output as JSON')
    .addHelpText('after', `
${chalk.yellow('Examples:')}
  ${chalk.dim('# Dry run summary (default)')}
  claude-tools jira monitor

  ${chalk.dim('# Detailed with ticket list')}
  claude-tools jira monitor --detailed

  ${chalk.dim('# Only stuck tickets, 14-day threshold')}
  claude-tools jira monitor --stuck --days 14

  ${chalk.dim('# Ageing and stale on-board tickets (read-only)')}
  claude-tools jira monitor --staleness

  ${chalk.dim('# Send notifications to Telegram group')}
  claude-tools jira monitor --notify

  ${chalk.dim('# Notify without sound (outside working hours)')}
  claude-tools jira monitor --notify --mute

  ${chalk.dim('# Detailed notifications (batched, 3 per message)')}
  claude-tools jira monitor --notify --detailed

  ${chalk.dim('# Dedupe-enabled dry run with an explicit state file')}
  claude-tools jira monitor --state C:\\temp\\jira-monitor-state.json
`)
    .action(async (options) => {
      const config = loadConfig();

      if (!config.jira) {
        console.error(chalk.red('JIRA not configured. Set JIRA_HOST, JIRA_EMAIL, JIRA_API_TOKEN.'));
        process.exit(1);
      }

      const jiraConfig = config.jira;
      const monitorConfig = config.jiraMonitor;
      const mapping = monitorConfig?.userMapping || {};
      const activeUsers = monitorConfig?.activeUsers;
      const statuses = monitorConfig?.statuses;
      const pipelineStatuses = monitorConfig?.pipelineStatuses || resolvePipelineStatuses();
      const excludeBacklog = monitorConfig?.excludeBacklog ?? true;
      const staleness = monitorConfig?.staleness || resolveJiraMonitorStaleness();
      const monitorOptions = { statuses, pipelineStatuses, excludeBacklog, staleness };
      const browseBaseUrl = resolveBrowseBaseUrl(jiraConfig.host, monitorConfig?.browseBaseUrl);
      const routing = monitorConfig?.notify || resolveJiraMonitorNotify();
      const escalationTiers = monitorConfig?.escalationTiers || resolveEscalationTiers();
      const project = options.project || jiraConfig.defaultProject;

      if (!project) {
        console.error(chalk.red('Project key required. Use --project or set JIRA_DEFAULT_PROJECT.'));
        process.exit(1);
      }

      const days = parseInt(options.days, 10);
      const minTasks = parseInt(options.minTasks, 10);
      const detailed = !!options.detailed;
      const notify = !!options.notify;
      const jsonOutput = !!options.json;
      const statePath = typeof options.state === 'string'
        ? options.state
        : options.state === true || options.resetState
          ? DEFAULT_STATE_PATH
          : undefined;

      if (options.resetState) {
        resetState(statePath!);
        if (!jsonOutput) console.log(chalk.dim(`Reset state: ${statePath}`));
      }

      // Determine which modes to run
      const runAll = !options.stuck && !options.inactive && !options.lowPipeline && !options.staleness;
      const runStuck = runAll || !!options.stuck;
      const runInactive = runAll || !!options.inactive;
      const runLowPipeline = runAll || !!options.lowPipeline;
      const runStaleness = !!options.staleness;

      if (notify && runStaleness) {
        throw new Error('--staleness is a read-only report and cannot be combined with --notify');
      }

      const clientConfig = {
        host: jiraConfig.host.startsWith('http') ? jiraConfig.host : `https://${jiraConfig.host}`,
        authentication: {
          basic: { email: jiraConfig.email, apiToken: jiraConfig.apiToken },
        },
      };
      const client = new Version2Client(clientConfig);
      const agile = new AgileClient(clientConfig);
      let backlogKeysPromise: Promise<Set<string>> | undefined;
      const getBacklogKeys = (): Promise<Set<string>> => {
        backlogKeysPromise ??= (async () => {
          const boardId = await resolveBoardId(agile, project, monitorConfig?.boardId);
          return fetchBacklogKeys(agile, boardId);
        })();
        return backlogKeysPromise;
      };

      const result: {
        stuck?: StuckIssue[];
        inactive?: InactiveUser[];
        lowPipeline?: LowPipelineUser[];
        staleness?: StalenessResult;
      } = {};

      // Progress output goes to stderr so --json stays clean
      const progress = jsonOutput ? process.stderr : process.stdout;

      // Run checks
      if (runStuck) {
        progress.write(chalk.dim(`Checking stuck In Progress tickets...`));
        result.stuck = await findStuckInProgress(client, project, days, (cur, total, key) => {
          progress.clearLine?.(0);
          progress.cursorTo?.(0);
          progress.write(chalk.dim(`Checking stuck tickets... ${cur}/${total} (${key})`));
        }, activeUsers, monitorOptions);
        progress.clearLine?.(0);
        progress.cursorTo?.(0);
        progress.write(chalk.dim(`Stuck tickets: ${result.stuck.length} found\n`));
      }

      if (runInactive) {
        progress.write(chalk.dim('Checking inactive users...'));
        result.inactive = await findInactiveUsers(client, project, days, activeUsers, monitorOptions);
        progress.clearLine?.(0);
        progress.cursorTo?.(0);
        progress.write(chalk.dim(`Inactive users: ${result.inactive.length} found\n`));
      }

      if (runLowPipeline) {
        progress.write(chalk.dim('Checking low pipeline...'));
        const backlogKeys = excludeBacklog ? await getBacklogKeys() : undefined;
        result.lowPipeline = await findLowPipelineUsers(
          client,
          project,
          minTasks,
          activeUsers,
          { ...monitorOptions, backlogKeys },
        );
        progress.clearLine?.(0);
        progress.cursorTo?.(0);
        progress.write(chalk.dim(`Low pipeline: ${result.lowPipeline.length} found\n`));
      }

      if (runStaleness) {
        progress.write(chalk.dim('Checking ticket staleness...'));
        const backlogKeys = await getBacklogKeys();
        result.staleness = await findStaleTickets(
          client,
          project,
          { ...monitorOptions, backlogKeys },
        );
        progress.clearLine?.(0);
        progress.cursorTo?.(0);
        progress.write(chalk.dim(
          `Ticket staleness: ${result.staleness.ageing.length} ageing, ${result.staleness.stale.length} stale\n`,
        ));
      }

      const previousState = statePath ? loadState(statePath) : createEmptyState();
      const classified = classify(previousState, result, escalationTiers);
      const chatId = monitorConfig?.notifyChat || 'Team Dev Chat';
      const pmChat = monitorConfig?.pmChat || chatId;
      const routed = buildRoutedMessages(
        classified,
        routing,
        mapping,
        chatId,
        pmChat,
        detailed,
        days,
        minTasks,
        browseBaseUrl,
      );

      // JSON output
      if (jsonOutput) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      // Console output
      if (!notify) {
        const date = new Date().toISOString().split('T')[0];
        console.log(`\n📊 ${chalk.bold(`JIRA Monitor — ${project}`)} (${date})\n`);

        if (result.stuck) {
          console.log(chalk.yellow.bold(`⚠️  STUCK IN PROGRESS (${days}+ days no activity)`));
          if (detailed) {
            printStuckDetailed(result.stuck, mapping);
          } else {
            printStuckSummary(result.stuck, mapping);
          }
          console.log();
        }

        if (result.inactive) {
          console.log(chalk.yellow.bold(`⚠️  INACTIVE USERS (${days}+ days no JIRA activity)`));
          printInactiveSummary(result.inactive, mapping);
          console.log();
        }

        if (result.lowPipeline) {
          console.log(chalk.yellow.bold(`⚠️  LOW PIPELINE (<${minTasks} planned on-board tasks)`));
          printLowPipelineSummary(result.lowPipeline, mapping);
          console.log();
        }

        if (result.staleness) {
          console.log(chalk.yellow.bold('⚠️  AGEING ON-BOARD TICKETS'));
          printStalenessTier(result.staleness.ageing, mapping);
          console.log();
          console.log(chalk.red.bold('🛑 STALE ON-BOARD TICKETS'));
          printStalenessTier(result.staleness.stale, mapping);
          console.log();
        }

        // Summary line
        const parts: string[] = [];
        if (result.stuck) parts.push(`${result.stuck.length} stuck`);
        if (result.inactive) parts.push(`${result.inactive.length} inactive`);
        if (result.lowPipeline) parts.push(`${result.lowPipeline.length} low pipeline`);
        if (result.staleness) {
          parts.push(`${result.staleness.ageing.length} ageing`);
          parts.push(`${result.staleness.stale.length} stale`);
        }
        console.log(chalk.dim(`Summary: ${parts.join(', ')}`));
        if (statePath) {
          console.log();
          printClassification(classified, statePath);
        }
        printSkippedDms(routed.skippedDms);
        return;
      }

      // Notify mode — send to Telegram
      if (!config.telegram) {
        console.error(chalk.red('Telegram not configured. Cannot send notifications.'));
        process.exit(1);
      }

      const { messages, skippedDms, pendingRefs } = routed;
      printSkippedDms(skippedDms);
      const resolved = Object.values(classified.resolved).reduce((sum, keys) => sum + keys.length, 0);
      if (statePath) console.log(chalk.dim(`Resolved since confirmed state: ${resolved}`));

      if (messages.length === 0) {
        const candidateCount = notificationCandidateCount(classified);
        if (!statePath && candidateCount === 0 && skippedDms.length === 0) {
          console.log(chalk.green('✅ Nothing to report — all clear!'));
          return;
        }
        const reason = skippedDms.length > 0
          ? 'no routable notifications'
          : candidateCount > 0
            ? 'new/escalated items are muted by routing'
          : statePath
            ? 'no new or escalated items'
            : 'all clear';
        if (statePath && resolved > 0) {
          // Resolution pruning only removes suppression; it cannot claim that
          // an unsent alert was delivered. Dry runs never reach this branch.
          saveState(
            statePath,
            stateAfterDeliveries(previousState, classified, [], new Date().toISOString()),
          );
        }
        console.log(chalk.green(`✅ Nothing sent — ${reason}${resolved ? `; ${resolved} resolved` : ''}.`));
        return;
      }

      console.log(chalk.dim(`Sending ${messages.length} message(s) to Telegram...`));

      const telegramService = new TelegramService(config.telegram);
      const delivery = await deliverNotifications(telegramService, messages, {
        state: statePath ? { path: statePath, previous: previousState, classified } : undefined,
        pendingRefs,
        // Preserved from 49c0b13 (`--mute`): applies to EVERY route — group, PM
        // and DM alike. The original flag lived in the old inline send loop that
        // this call replaced, so it is threaded through deliverNotifications here.
        mute: options.mute === true,
        log: message => console.log(chalk.dim(message)),
      });
      if (delivery.failedDms.length > 0) {
        console.log(chalk.yellow(
          `⚠️ ${delivery.failedDms.length} DM notification(s) failed and remain eligible for retry.`,
        ));
      }
      if (statePath && resolved > 0 && delivery.deliveredRefs.length === 0) {
        // All alert routes were incomplete/failed, but pruning stale resolved
        // keys is still safe: it can only make a future recurrence NEW.
        saveState(
          statePath,
          stateAfterDeliveries(previousState, classified, [], new Date().toISOString()),
        );
      }
      console.log(chalk.green(`✅ ${delivery.sent} notification(s) sent`));
    });
}
