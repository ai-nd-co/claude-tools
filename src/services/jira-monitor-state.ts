// Persistent notification state for the JIRA monitor.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { dirname } from 'path';
import type {
  InactiveUser,
  LowPipelineUser,
  StuckIssue,
} from './jira-monitor.js';

export type AlertClass = 'stuck' | 'inactive' | 'lowPipeline';
export type AlertClassification = 'new' | 'escalated' | 'unchanged';

export interface DaysStateEntry {
  firstSeenAt: string;
  lastNotifiedAt: string;
  notifiedAtDays: number;
}

export interface PipelineStateEntry {
  firstSeenAt: string;
  lastNotifiedAt: string;
  notifiedAtTotal: number;
}

export interface JiraMonitorState {
  version: 1;
  lastRunAt: string;
  stuck: Record<string, DaysStateEntry>;
  inactive: Record<string, DaysStateEntry>;
  lowPipeline: Record<string, PipelineStateEntry>;
}

export interface MonitorSnapshot {
  stuck?: StuckIssue[];
  inactive?: InactiveUser[];
  lowPipeline?: LowPipelineUser[];
}

export interface ClassifiedItem<T> {
  key: string;
  item: T;
  classification: AlertClassification;
}

export interface ClassificationResult {
  stuck?: ClassifiedItem<StuckIssue>[];
  inactive?: ClassifiedItem<InactiveUser>[];
  lowPipeline?: ClassifiedItem<LowPipelineUser>[];
  resolved: Record<AlertClass, string[]>;
}

export interface AlertRef {
  alertClass: AlertClass;
  key: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isDaysEntry(value: unknown): value is DaysStateEntry {
  return isRecord(value)
    && typeof value.firstSeenAt === 'string'
    && typeof value.lastNotifiedAt === 'string'
    && isFiniteNumber(value.notifiedAtDays);
}

function isPipelineEntry(value: unknown): value is PipelineStateEntry {
  return isRecord(value)
    && typeof value.firstSeenAt === 'string'
    && typeof value.lastNotifiedAt === 'string'
    && isFiniteNumber(value.notifiedAtTotal);
}

function isEntryMap<T>(
  value: unknown,
  predicate: (entry: unknown) => entry is T,
): value is Record<string, T> {
  return isRecord(value) && Object.values(value).every(predicate);
}

function isState(value: unknown): value is JiraMonitorState {
  return isRecord(value)
    && value.version === 1
    && typeof value.lastRunAt === 'string'
    && isEntryMap(value.stuck, isDaysEntry)
    && isEntryMap(value.inactive, isDaysEntry)
    && isEntryMap(value.lowPipeline, isPipelineEntry);
}

export function createEmptyState(): JiraMonitorState {
  return {
    version: 1,
    lastRunAt: '',
    stuck: {},
    inactive: {},
    lowPipeline: {},
  };
}

/** Missing, malformed, or unsupported state is intentionally treated as empty. */
export function loadState(path: string): JiraMonitorState {
  if (!existsSync(path)) return createEmptyState();

  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    return isState(parsed) ? parsed : createEmptyState();
  } catch {
    return createEmptyState();
  }
}

/** Write a complete replacement file so an interrupted process never leaves partial JSON. */
export function saveState(path: string, state: JiraMonitorState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf-8', flag: 'wx' });
    renameSync(tempPath, path);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

export function resetState(path: string): void {
  rmSync(path, { force: true });
}

function escalationTier(value: number, tiers: number[]): number {
  let matched = Number.NEGATIVE_INFINITY;
  for (const tier of tiers) {
    if (value >= tier) matched = Math.max(matched, tier);
  }
  return matched;
}

function classifyDaysItem(
  previous: DaysStateEntry | undefined,
  currentDays: number,
  tiers: number[],
): AlertClassification {
  if (!previous) return 'new';
  return escalationTier(currentDays, tiers) > escalationTier(previous.notifiedAtDays, tiers)
    ? 'escalated'
    : 'unchanged';
}

function classifyClass<T>(
  previous: Record<string, unknown>,
  current: T[] | undefined,
  keyOf: (item: T) => string,
  classifyItem: (previousEntry: unknown, item: T) => AlertClassification,
): { items?: ClassifiedItem<T>[]; resolved: string[] } {
  if (current === undefined) return { items: undefined, resolved: [] };

  const currentKeys = new Set<string>();
  const items = current.map((item) => {
    const key = keyOf(item);
    currentKeys.add(key);
    return { key, item, classification: classifyItem(previous[key], item) };
  });
  const resolved = Object.keys(previous).filter(key => !currentKeys.has(key));
  return { items, resolved };
}

/** Purely compare a current snapshot with prior confirmed-delivery state. */
export function classify(
  previous: JiraMonitorState,
  current: MonitorSnapshot,
  tiers: number[],
): ClassificationResult {
  const stuck = classifyClass(
    previous.stuck,
    current.stuck,
    item => item.key,
    (entry, item) => classifyDaysItem(entry as DaysStateEntry | undefined, item.stuckDays, tiers),
  );
  const inactive = classifyClass(
    previous.inactive,
    current.inactive,
    item => item.name,
    (entry, item) => classifyDaysItem(entry as DaysStateEntry | undefined, item.daysSinceActivity, tiers),
  );
  const lowPipeline = classifyClass(
    previous.lowPipeline,
    current.lowPipeline,
    item => item.name,
    (entry, item) => {
      const prior = entry as PipelineStateEntry | undefined;
      if (!prior) return 'new';
      return item.totalPipeline < prior.notifiedAtTotal ? 'escalated' : 'unchanged';
    },
  );

  return {
    stuck: stuck.items,
    inactive: inactive.items,
    lowPipeline: lowPipeline.items,
    resolved: {
      stuck: stuck.resolved,
      inactive: inactive.resolved,
      lowPipeline: lowPipeline.resolved,
    },
  };
}

function cloneState(state: JiraMonitorState): JiraMonitorState {
  return {
    version: 1,
    lastRunAt: state.lastRunAt,
    stuck: Object.fromEntries(Object.entries(state.stuck).map(([key, value]) => [key, { ...value }])),
    inactive: Object.fromEntries(Object.entries(state.inactive).map(([key, value]) => [key, { ...value }])),
    lowPipeline: Object.fromEntries(Object.entries(state.lowPipeline).map(([key, value]) => [key, { ...value }])),
  };
}

/**
 * Build state from confirmed deliveries only. Resolved entries are pruned when
 * a state save is triggered by at least one successful notification.
 */
export function stateAfterDeliveries(
  previous: JiraMonitorState,
  classified: ClassificationResult,
  delivered: AlertRef[],
  notifiedAt: string,
): JiraMonitorState {
  const next = cloneState(previous);

  for (const alertClass of ['stuck', 'inactive', 'lowPipeline'] as const) {
    for (const key of classified.resolved[alertClass]) {
      delete next[alertClass][key];
    }
  }

  const uniqueRefs = new Map(delivered.map(ref => [`${ref.alertClass}:${ref.key}`, ref]));
  for (const { alertClass, key } of uniqueRefs.values()) {
    if (alertClass === 'stuck') {
      const match = classified.stuck?.find(item => item.key === key);
      if (!match) continue;
      const prior = next.stuck[key];
      next.stuck[key] = {
        firstSeenAt: prior?.firstSeenAt || notifiedAt,
        lastNotifiedAt: notifiedAt,
        notifiedAtDays: match.item.stuckDays,
      };
    } else if (alertClass === 'inactive') {
      const match = classified.inactive?.find(item => item.key === key);
      if (!match) continue;
      const prior = next.inactive[key];
      next.inactive[key] = {
        firstSeenAt: prior?.firstSeenAt || notifiedAt,
        lastNotifiedAt: notifiedAt,
        notifiedAtDays: match.item.daysSinceActivity,
      };
    } else {
      const match = classified.lowPipeline?.find(item => item.key === key);
      if (!match) continue;
      const prior = next.lowPipeline[key];
      next.lowPipeline[key] = {
        firstSeenAt: prior?.firstSeenAt || notifiedAt,
        lastNotifiedAt: notifiedAt,
        notifiedAtTotal: match.item.totalPipeline,
      };
    }
  }

  next.lastRunAt = notifiedAt;
  return next;
}
