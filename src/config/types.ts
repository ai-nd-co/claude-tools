// Configuration types

import type { ChatPolicy } from '../services/telegram-bot-policy.js';

export interface TelegramSecrets {
  apiId: number;
  apiHash: string;
  sessionString: string;
}

export interface JiraSecrets {
  email: string;
  apiToken: string;
}

export interface GroqSecrets {
  apiKey: string;
  /** Expected vocabulary; see `GroqConfig.prompt`. */
  prompt?: string;
  /** ISO-639-1 code to retry with when auto-detection looks wrong. */
  fallbackLanguage?: string;
}

/**
 * The office speech cluster (gpu-cluster docs/32-speech.md). One key for
 * speech-to-text today and text-to-speech later; the URL and model have defaults.
 */
export interface SpeechSecrets {
  apiKey: string;
  /** Defaults to the cluster's public route. Must end in `/v1`. */
  baseUrl?: string;
  /** Default ASR model id as the server knows it. */
  model?: string;
  /** Expected vocabulary; see `GroqConfig.prompt`. */
  prompt?: string;
  /** ISO-639-1 code to retry with when auto-detection looks wrong. */
  fallbackLanguage?: string;
}

/**
 * Gmail over IMAP with an app password (myaccount.google.com -> Security -> App passwords).
 * The password cannot be scoped - it could also delete and send - so `claude-tools gmail` uses it
 * through a client that refuses every write command; see services/imap-readonly.ts.
 */
export interface GmailAccount {
  user: string;
  /** 16 letters; spaces as Google displays them are fine. */
  appPassword: string;
}

/** One or more mailboxes. The flat `{ user, appPassword }` form is still read, as one account. */
export interface GmailSecrets {
  accounts?: GmailAccount[];
  user?: string;
  appPassword?: string;
}

export interface AsanaSecrets {
  /** Personal Access Token from https://app.asana.com/0/my-apps */
  accessToken: string;
}

export interface TelegramBotSecrets {
  token: string;
  allowedChats?: (string | number)[];
  chats?: Record<string, TelegramChatPolicySecret>;
  mentionPatterns?: string[];
}

/**
 * How one chat is treated, keyed by chat id under a bot's `chats`.
 *
 * A group needs an entry: without one nothing from it is delivered, because every
 * line typed in a group arrives as an update and would otherwise wake an agent.
 * A DM does not — the flat `allowedChats` list still governs those.
 */
export interface TelegramChatPolicySecret {
  /** User ids allowed to reach the agent from this chat. Omitted means any member. */
  allowFrom?: (string | number)[];
  /**
   * Require the message to address the bot. Defaults to **true** for a group and
   * **false** for a DM, so a group entry needs to say nothing to be safe and a DM
   * needs to say nothing to keep working.
   */
  requireMention?: boolean;
}

/**
 * One entry in the `telegramBots` list. Ordered, so the first is the default
 * unless another is marked.
 */
export interface TelegramBotSecretEntry {
  /** Short handle used with `--bot`, e.g. `assistant`. */
  name: string;
  token: string;
  default?: boolean;
  /**
   * Chat ids this bot will talk to. Anyone can message a public bot, so without
   * this every stranger's message reaches the agent as if it were the owner's.
   * Omitted means no restriction.
   */
  allowedChats?: (string | number)[];
  /**
   * Per-chat policy, keyed by chat id. Required for a group; optional for a DM,
   * where it only serves to override a default.
   */
  chats?: Record<string, TelegramChatPolicySecret>;
  /**
   * Extra case-insensitive regexes that count as addressing the bot, for members
   * who write its name rather than its `@handle`. An unparseable pattern is
   * skipped at match time rather than failing the config.
   */
  mentionPatterns?: string[];
}

export interface Secrets {
  telegram?: TelegramSecrets;
  jira?: JiraSecrets;
  groq?: GroqSecrets;
  speech?: SpeechSecrets;
  asana?: AsanaSecrets;
  gmail?: GmailSecrets;
  /** Legacy single bot. Still honoured; `telegramBots` supersedes it. */
  telegramBot?: TelegramBotSecrets;
  telegramBots?: TelegramBotSecretEntry[];
  hub?: HubSecrets;
}

/**
 * Agent-hub settings.
 *
 * Nothing here is a secret, which is the point worth stating: the hub credential
 * is a machine fingerprint derived at run time from `~/.config/ai-hub/machine.key`
 * and it must never be written into this file or any other. These two values only
 * say *which* hub and *who this session is*.
 */
export interface HubSecrets {
  /** The hub origin, or its `/api` form. Defaults to the production route. */
  url?: string;
  /** Default agent name for this machine when no `--agent` is given. */
  agent?: string;
}

export interface TelegramProjectConfig {
  defaultChat?: string;
}

export interface JiraProjectConfig {
  host: string;
  defaultProject?: string;
}

export interface AsanaProjectConfig {
  /** Workspace gid used when a command needs one and none is given. */
  defaultWorkspace?: string;
  /**
   * Project gid used by `asana create` when no `--project` is given.
   * Deliberately NOT applied to `asana list`, whose documented default is "my
   * incomplete tasks" - scoping that to one project would hide work. `asana
   * sections` takes its project as a required argument and never reads this.
   */
  defaultProject?: string;
}

export interface JiraMonitorStatusConfig {
  /** Status name identifying "In Progress" tickets (default: "In Progress"). */
  inProgress?: string;
  /** Status name identifying "Planned" tickets (default: "Planned"). */
  planned?: string;
  /** Status name identifying "Icebox" tickets (default: "Icebox"). */
  icebox?: string;
  /** Status name identifying "Done" tickets (default: "Done"). */
  done?: string;
  /**
   * Statuses excluded from the open-work JQL used by inactive users and the
   * low-pipeline fallback roster.
   * Currently `["Done", "Test"]`.
   */
  openWorkExclude?: string[];
}

export interface JiraMonitorStalenessThresholdConfig {
  ageing?: number;
  stale?: number;
}

export interface JiraMonitorStalenessConfig {
  inProgress?: JiraMonitorStalenessThresholdConfig;
  planned?: JiraMonitorStalenessThresholdConfig;
}

export interface ResolvedJiraMonitorStalenessThresholdConfig {
  ageing: number;
  stale: number;
}

export interface ResolvedJiraMonitorStalenessConfig {
  inProgress: ResolvedJiraMonitorStalenessThresholdConfig;
  planned: ResolvedJiraMonitorStalenessThresholdConfig;
}

export type JiraMonitorNotifyDestination = 'group' | 'pm' | 'dm' | 'off';

/** Raw, per-class notification routing overrides. */
export interface JiraMonitorNotifyConfig {
  stuck?: JiraMonitorNotifyDestination[];
  inactive?: JiraMonitorNotifyDestination[];
  lowPipeline?: JiraMonitorNotifyDestination[];
}

/** Fully resolved routing used by the command after defaults are applied. */
export interface ResolvedJiraMonitorNotifyConfig {
  stuck: JiraMonitorNotifyDestination[];
  inactive: JiraMonitorNotifyDestination[];
  lowPipeline: JiraMonitorNotifyDestination[];
}

/**
 * Loaded, resolved JIRA monitor config as returned by `loadConfig`.
 *
 * `userMapping` is REQUIRED here — the loader normalises a missing map to
 * `{}` so downstream consumers can rely on the field's presence and do not
 * need a `?.userMapping` chain everywhere.
 *
 * For the raw project-file shape (where every field is optional), see
 * `ProjectJiraMonitorConfig`.
 */
export interface JiraMonitorConfig {
  notifyChat?: string;
  pmChat?: string;
  userMapping: Record<string, string>;
  activeUsers?: string[];
  /** Optional overrides for JIRA workflow status names. All fields optional; missing values fall back to today's literals. */
  statuses?: JiraMonitorStatusConfig;
  /** Explicit Agile board. When absent, the command discovers the only board for the project. */
  boardId?: number;
  /** Statuses counted as queued pipeline work. Defaults to `["Planned"]`. */
  pipelineStatuses: string[];
  /** Whether Agile backlog issues are excluded from pipeline counts. Defaults to `true`. */
  excludeBacklog: boolean;
  /** Fully resolved ageing/stale day thresholds for active and queued work. */
  staleness: ResolvedJiraMonitorStalenessConfig;
  /**
   * Optional override for the JIRA browse URL prefix (no trailing slash).
   * Defaults to `https://<jira.host>/browse` derived from the JIRA host config.
   */
  browseBaseUrl?: string;
  /** Per-alert-class Telegram destinations; defaults preserve historical routing. */
  notify: ResolvedJiraMonitorNotifyConfig;
  /** Day thresholds which trigger repeat stuck/inactive notifications. */
  escalationTiers: number[];
}

/**
 * Raw project-file shape for `jiraMonitor`. Every field is optional so a
 * status-only or browseBaseUrl-only override is accepted; the loader
 * normalises to `JiraMonitorConfig` before exposing to callers.
 */
export interface ProjectJiraMonitorConfig {
  notifyChat?: string;
  pmChat?: string;
  userMapping?: Record<string, string>;
  activeUsers?: string[];
  statuses?: JiraMonitorStatusConfig;
  boardId?: number;
  pipelineStatuses?: string[];
  excludeBacklog?: boolean;
  staleness?: JiraMonitorStalenessConfig;
  browseBaseUrl?: string;
  notify?: JiraMonitorNotifyConfig;
  escalationTiers?: number[];
}

export interface ProjectConfig {
  telegram?: TelegramProjectConfig;
  jira?: JiraProjectConfig;
  jiraMonitor?: ProjectJiraMonitorConfig;
  asana?: AsanaProjectConfig;
}

export interface TelegramConfig {
  apiId: number;
  apiHash: string;
  sessionString: string;
  defaultChat?: string;
}

export interface JiraConfig {
  host: string;
  email: string;
  apiToken: string;
  defaultProject?: string;
}

/**
 * Resolved Asana config. Unlike JIRA there is no host and no email: one token
 * is the whole credential, so the secrets file alone is a complete setup and
 * the workspace/project gids are conveniences discoverable at runtime.
 */
export interface AsanaConfig {
  accessToken: string;
  defaultWorkspace?: string;
  defaultProject?: string;
}

export interface GroqConfig {
  apiKey: string;
  /** Default ASR model. Overridable per call with `--model`. */
  model: string;
  /**
   * Words the transcriber should expect: names, products, jargon. Whisper takes
   * it as decoding context, so a term in here is recognised where it would
   * otherwise be guessed at phonetically. Overridable per call with `--prompt`.
   */
  prompt?: string;
  /**
   * ISO-639-1 code to try when the backend's own language detection looks to
   * have gone wrong. Left unset, a mis-detected clip is returned as it came.
   */
  fallbackLanguage?: string;
}

/** Resolved speech-cluster config: tried before Groq whenever it is present. */
export interface SpeechConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Expected vocabulary, as in `GroqConfig.prompt`. */
  prompt?: string;
  /** Retry language, as in `GroqConfig.fallbackLanguage`. */
  fallbackLanguage?: string;
}

export interface TelegramBotConfig {
  /** Short handle used with `--bot`. `default` for a legacy single-bot config. */
  name: string;
  token: string;
  /** True for the bot chosen when no `--bot` or `TELEGRAM_BOT` is given. */
  isDefault: boolean;
  /** Chat ids this bot may read from and send to. Empty means unrestricted. */
  allowedChats: string[];
  /**
   * Per-chat delivery policy, keyed by chat id. Consumed by
   * `gateBotUpdate` in `services/telegram-bot-policy.ts`, which also owns the
   * per-chat-type defaults.
   */
  chats: Record<string, ChatPolicy>;
  /** Extra regexes that count as addressing the bot. */
  mentionPatterns: string[];
  /** Default chat for `bot send`, learned from the first update when unset. */
  defaultChat?: string;
}

/**
 * Resolved agent-hub config. Never null: the URL has a default, so `hub watch`
 * needs nothing configured on a machine that talks to the production hub — which
 * is what lets the `SessionStart` hook (ISSUE-30) arm a watcher with no setup step.
 */
export interface HubConfig {
  /** Normalised to an origin by `hubOrigin`; both `<origin>` and `<origin>/api` are accepted. */
  url: string;
  /** The agent name to use when no `--agent` is given, or null to require one. */
  agent: string | null;
}

export interface Config {
  telegram: TelegramConfig | null;
  /** The bot selected for this process: `TELEGRAM_BOT`, else the default. */
  telegramBot: TelegramBotConfig | null;
  /** Every configured bot, in declaration order. */
  telegramBots: TelegramBotConfig[];
  jira: JiraConfig | null;
  jiraMonitor: JiraMonitorConfig | null;
  groq: GroqConfig | null;
  speech: SpeechConfig | null;
  asana: AsanaConfig | null;
  /** Configured Gmail mailboxes; empty when none. */
  gmail: GmailAccount[];
  hub: HubConfig;
}
