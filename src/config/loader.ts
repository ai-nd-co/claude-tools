// Config loading logic

import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { getSecretsPath, PROJECT_CONFIG_FILENAME } from './paths.js';
import type {
  Config,
  Secrets,
  ProjectConfig,
  TelegramConfig,
  JiraConfig,
  JiraMonitorConfig,
  GroqConfig,
  SpeechConfig,
  AsanaConfig,
  HubConfig,
  TelegramBotConfig,
  TelegramBotSecretEntry,
  TelegramChatPolicySecret,
  JiraMonitorNotifyConfig,
  JiraMonitorNotifyDestination,
  ResolvedJiraMonitorNotifyConfig,
  JiraMonitorStalenessConfig,
  ResolvedJiraMonitorStalenessConfig,
} from './types.js';
import type { BotChatAccess, ChatPolicy } from '../services/telegram-bot-policy.js';

/**
 * Groq's flagship ASR model. `whisper-large-v3-turbo` is cheaper and faster but
 * noticeably weaker on accented speech and code-switching, so the accurate
 * model is the default and callers opt into turbo explicitly.
 */
const DEFAULT_GROQ_STT_MODEL = 'whisper-large-v3';

/**
 * The office speech cluster: Whisper large-v3 on one of the GPUs, behind the same
 * OpenAI audio API as Groq (gpu-cluster docs/32-speech.md). The model id is
 * the Hugging Face repository the server loads; `whisper-large-v3` alone is not
 * known to it.
 */
const DEFAULT_SPEECH_BASE_URL = 'https://speech.example.com/v1';
const DEFAULT_SPEECH_STT_MODEL = 'Systran/faster-whisper-large-v3';

/**
 * The canonical form of a speech base URL — `origin + path`, no trailing slash —
 * or null when it is not an http(s) URL whose PATH ends in /v1. A query or a
 * fragment is refused (`?x=/v1`), and a bare `?` or `#` is dropped by the
 * canonicalisation rather than ending up in the middle of a request path.
 */
function canonicalSpeechBaseUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.search !== '' || url.hash !== '') return null;
  const pathname = url.pathname.replace(/\/+$/, '');
  if (!pathname.endsWith('/v1')) return null;
  return `${url.origin}${pathname}`;
}

/**
 * The agent hub's public route (roadmap D9/D11): public HTTPS, Let's Encrypt at
 * the k3s ingress, basic auth on `/` and fingerprint auth on `/api/`.
 *
 * Compiled in rather than required as configuration so that a session which has
 * never heard of the hub can still arm a watcher on the owner's machines, which
 * is the whole premise of automatic registration (D2, ISSUE-30).
 */
const DEFAULT_HUB_URL = 'https://hub.example.com';

const DEFAULT_NOTIFY: ResolvedJiraMonitorNotifyConfig = {
  stuck: ['group'],
  inactive: ['group'],
  lowPipeline: ['pm'],
};
const DEFAULT_ESCALATION_TIERS = [7, 14, 30, 60, 90];
const DEFAULT_PIPELINE_STATUSES = ['Planned'];
const DEFAULT_STALENESS: ResolvedJiraMonitorStalenessConfig = {
  inProgress: { ageing: 7, stale: 14 },
  planned: { ageing: 30, stale: 90 },
};
const NOTIFY_DESTINATIONS = new Set<JiraMonitorNotifyDestination>(['group', 'pm', 'dm', 'off']);

export function resolveJiraMonitorNotify(
  notify?: JiraMonitorNotifyConfig,
): ResolvedJiraMonitorNotifyConfig {
  if (notify !== undefined && (!notify || typeof notify !== 'object' || Array.isArray(notify))) {
    throw new Error('Invalid JIRA monitor routing at jiraMonitor.notify: must be an object');
  }
  const resolveClass = (
    value: JiraMonitorNotifyDestination[] | undefined,
    fallback: JiraMonitorNotifyDestination[],
    path: string,
  ): JiraMonitorNotifyDestination[] => {
    if (value === undefined) return [...fallback];
    if (!Array.isArray(value)) {
      throw new Error(`Invalid JIRA monitor routing at ${path}: must be an array`);
    }
    for (const destination of value) {
      if (!NOTIFY_DESTINATIONS.has(destination)) {
        throw new Error(
          `Invalid JIRA monitor routing at ${path}: ${JSON.stringify(destination)} is not group, pm, dm, or off`,
        );
      }
    }
    const unique = [...new Set(value)];
    if (unique.includes('off') && unique.length > 1) {
      throw new Error(`Invalid JIRA monitor routing at ${path}: off cannot be combined with another destination`);
    }
    return unique;
  };

  return {
    stuck: resolveClass(notify?.stuck, DEFAULT_NOTIFY.stuck, 'jiraMonitor.notify.stuck'),
    inactive: resolveClass(notify?.inactive, DEFAULT_NOTIFY.inactive, 'jiraMonitor.notify.inactive'),
    lowPipeline: resolveClass(notify?.lowPipeline, DEFAULT_NOTIFY.lowPipeline, 'jiraMonitor.notify.lowPipeline'),
  };
}

export function resolveEscalationTiers(tiers?: number[]): number[] {
  if (tiers === undefined) return [...DEFAULT_ESCALATION_TIERS];
  if (!Array.isArray(tiers) || tiers.length === 0) {
    throw new Error('Invalid jiraMonitor.escalationTiers: must be a non-empty array');
  }
  for (let i = 0; i < tiers.length; i++) {
    if (!Number.isInteger(tiers[i]) || tiers[i] < 0) {
      throw new Error('Invalid jiraMonitor.escalationTiers: every tier must be a non-negative integer');
    }
    if (i > 0 && tiers[i] <= tiers[i - 1]) {
      throw new Error('Invalid jiraMonitor.escalationTiers: tiers must be strictly increasing');
    }
  }
  return [...tiers];
}

export function resolvePipelineStatuses(statuses?: string[]): string[] {
  if (statuses === undefined) return [...DEFAULT_PIPELINE_STATUSES];
  if (!Array.isArray(statuses) || statuses.length === 0) {
    throw new Error('Invalid jiraMonitor.pipelineStatuses: must be a non-empty array');
  }
  for (const status of statuses) {
    if (typeof status !== 'string' || status.length === 0) {
      throw new Error('Invalid jiraMonitor.pipelineStatuses: every status must be a non-empty string');
    }
  }
  return [...new Set(statuses)];
}

export function resolveJiraMonitorStaleness(
  config?: JiraMonitorStalenessConfig,
): ResolvedJiraMonitorStalenessConfig {
  if (config !== undefined && (!config || typeof config !== 'object' || Array.isArray(config))) {
    throw new Error('Invalid jiraMonitor.staleness: must be an object');
  }

  const resolveBucket = (
    bucket: 'inProgress' | 'planned',
  ): { ageing: number; stale: number } => {
    const value = config?.[bucket];
    if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) {
      throw new Error(`Invalid jiraMonitor.staleness.${bucket}: must be an object`);
    }
    const ageing = value?.ageing ?? DEFAULT_STALENESS[bucket].ageing;
    const stale = value?.stale ?? DEFAULT_STALENESS[bucket].stale;
    if (!Number.isInteger(ageing) || ageing < 0 || !Number.isInteger(stale) || stale < 0) {
      throw new Error(`Invalid jiraMonitor.staleness.${bucket}: ageing and stale must be non-negative integers`);
    }
    if (ageing >= stale) {
      throw new Error(`Invalid jiraMonitor.staleness.${bucket}: ageing must be less than stale`);
    }
    return { ageing, stale };
  };

  return {
    inProgress: resolveBucket('inProgress'),
    planned: resolveBucket('planned'),
  };
}

/**
 * Load secrets from ~/.config/claude-tools/secrets.json
 */
function loadSecrets(): Secrets {
  const secretsPath = getSecretsPath();
  if (!existsSync(secretsPath)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(secretsPath, 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * Find and load project config by walking up directories
 */
function loadProjectConfig(): ProjectConfig {
  let dir = process.cwd();

  while (true) {
    const configPath = join(dir, PROJECT_CONFIG_FILENAME);
    if (existsSync(configPath)) {
      try {
        return JSON.parse(readFileSync(configPath, 'utf-8'));
      } catch {
        // Invalid JSON, continue searching
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break; // Reached root
    dir = parent;
  }

  return {};
}

/**
 * Get environment variable value (supports multiple names)
 */
function getEnv(...names: string[]): string | undefined {
  for (const name of names) {
    if (process.env[name]) return process.env[name];
  }
  return undefined;
}

/**
 * Load complete config with priority:
 * 1. Environment variables (highest)
 * 2. Secrets file
 * 3. Project config (lowest)
 */
export function loadConfig(): Config {
  const secrets = loadSecrets();
  const project = loadProjectConfig();

  // Build Telegram config
  let telegram: TelegramConfig | null = null;
  const telegramApiId = getEnv('TELEGRAM_API_ID') || secrets.telegram?.apiId?.toString();
  const telegramApiHash = getEnv('TELEGRAM_API_HASH') || secrets.telegram?.apiHash;
  const telegramSession = getEnv('TELEGRAM_SESSION_STRING', 'TELEGRAM_SESSION') || secrets.telegram?.sessionString;

  if (telegramApiId && telegramApiHash && telegramSession) {
    telegram = {
      apiId: parseInt(telegramApiId, 10),
      apiHash: telegramApiHash,
      sessionString: telegramSession,
      defaultChat: getEnv('TELEGRAM_DEFAULT_CHAT') || project.telegram?.defaultChat,
    };
  }

  // Build Jira config
  let jira: JiraConfig | null = null;
  const jiraHost = getEnv('JIRA_HOST') || project.jira?.host;
  const jiraEmail = getEnv('JIRA_EMAIL') || secrets.jira?.email;
  const jiraToken = getEnv('JIRA_API_TOKEN', 'JIRA_TOKEN') || secrets.jira?.apiToken;

  if (jiraHost && jiraEmail && jiraToken) {
    jira = {
      host: jiraHost,
      email: jiraEmail,
      apiToken: jiraToken,
      defaultProject: getEnv('JIRA_DEFAULT_PROJECT') || project.jira?.defaultProject,
    };
  }

  // Build Jira Monitor config.
  // Previously this required `userMapping` to be present. That gate silently
  // dropped status-only / browseBaseUrl-only configs — the very reason this
  // task exists (a scheduled monitor cannot silently fall back to defaults
  // when the workflow gets renamed). The gate is loosened to "any jiraMonitor
  // block builds a config", with `userMapping` normalized to `{}` when
  // missing so downstream code can rely on the field's presence. This is
  // strictly more permissive than the old behaviour — configs that were valid
  // before are still valid and unchanged.
  const jiraMonitor: JiraMonitorConfig | null = project.jiraMonitor
    ? {
        notifyChat: project.jiraMonitor.notifyChat,
        pmChat: project.jiraMonitor.pmChat,
        userMapping: project.jiraMonitor.userMapping ?? {},
        activeUsers: project.jiraMonitor.activeUsers,
        statuses: project.jiraMonitor.statuses,
        boardId: project.jiraMonitor.boardId,
        pipelineStatuses: resolvePipelineStatuses(project.jiraMonitor.pipelineStatuses),
        excludeBacklog: project.jiraMonitor.excludeBacklog ?? true,
        staleness: resolveJiraMonitorStaleness(project.jiraMonitor.staleness),
        browseBaseUrl: project.jiraMonitor.browseBaseUrl,
        notify: resolveJiraMonitorNotify(project.jiraMonitor.notify),
        escalationTiers: resolveEscalationTiers(project.jiraMonitor.escalationTiers),
      }
    : null;

  if (jiraMonitor?.boardId !== undefined && (!Number.isInteger(jiraMonitor.boardId) || jiraMonitor.boardId <= 0)) {
    throw new Error('Invalid jiraMonitor.boardId: must be a positive integer');
  }
  if (jiraMonitor && typeof jiraMonitor.excludeBacklog !== 'boolean') {
    throw new Error('Invalid jiraMonitor.excludeBacklog: must be a boolean');
  }

  // Build Groq config. Only the key is required; the model has a default so
  // `transcribe` works with nothing but GROQ_API_KEY set.
  // One setting for both backends: the expected vocabulary is a property of who
  // is talking, not of which transcriber answers. Deliberately not shipped with
  // a default — a shared tool should not carry one installation's product names.
  const sttPrompt = getEnv('STT_PROMPT');
  // The language to assume when detection looks wrong. One setting for both
  // backends, and unset by default: forcing a language on every clip is what
  // this is designed to avoid, since the same chats carry Russian and Uzbek.
  const sttFallbackLanguage = getEnv('STT_FALLBACK_LANGUAGE');

  let groq: GroqConfig | null = null;
  const groqApiKey = getEnv('GROQ_API_KEY') || secrets.groq?.apiKey;
  if (groqApiKey) {
    groq = {
      apiKey: groqApiKey,
      model: getEnv('GROQ_STT_MODEL') || DEFAULT_GROQ_STT_MODEL,
      prompt: sttPrompt || secrets.groq?.prompt || undefined,
      fallbackLanguage: sttFallbackLanguage || secrets.groq?.fallbackLanguage || undefined,
    };
  }

  // Build the speech-cluster config. Only the key is required; the URL and model
  // default to the cluster so one secret turns the cluster on. A URL that is not
  // http(s) is a typo, and the trailing slash is dropped so paths append cleanly.
  let speech: SpeechConfig | null = null;
  const speechApiKey = getEnv('SPEECH_API_KEY') || secrets.speech?.apiKey;
  if (speechApiKey) {
    const configured = getEnv('SPEECH_BASE_URL') || secrets.speech?.baseUrl || DEFAULT_SPEECH_BASE_URL;
    // The audio paths are appended under /v1, and the cluster's ingress routes
    // nothing else, so a URL without it would fail on every request with a 404
    // that looks like an outage. Refuse it here, where the message can say why.
    const baseUrl = canonicalSpeechBaseUrl(configured);
    if (!baseUrl) {
      throw new Error(`Invalid speech.baseUrl: ${configured} (expected an http(s) URL ending in /v1)`);
    }
    speech = {
      apiKey: speechApiKey,
      baseUrl,
      model: getEnv('SPEECH_STT_MODEL') || secrets.speech?.model || DEFAULT_SPEECH_STT_MODEL,
      prompt: sttPrompt || secrets.speech?.prompt || undefined,
      fallbackLanguage: sttFallbackLanguage || secrets.speech?.fallbackLanguage || undefined,
    };
  }

  // Build Asana config. Only the token is required - Asana needs no host and no
  // email - so the secrets file alone is a complete setup and the workspace is
  // discovered at runtime when no default is configured.
  let asana: AsanaConfig | null = null;
  const asanaToken = getEnv('ASANA_ACCESS_TOKEN', 'ASANA_TOKEN', 'ASANA_PAT') || secrets.asana?.accessToken;
  if (asanaToken) {
    asana = {
      accessToken: asanaToken,
      defaultWorkspace: getEnv('ASANA_DEFAULT_WORKSPACE') || project.asana?.defaultWorkspace,
      defaultProject: getEnv('ASANA_DEFAULT_PROJECT') || project.asana?.defaultProject,
    };
  }

  // Gmail: both halves or nothing. The secrets file only; no env var, so the app password never
  // sits in a unit file or a shell's environment.
  const gmailEntries = [
    ...(Array.isArray(secrets.gmail?.accounts) ? secrets.gmail.accounts : []),
    ...(secrets.gmail?.user ? [{ user: secrets.gmail.user, appPassword: secrets.gmail.appPassword ?? '' }] : []),
  ];
  // One entry per address (case-insensitive): an `accounts[]` entry wins over the legacy flat one,
  // so a half-migrated file never logs in to the same mailbox twice.
  const seenGmail = new Set<string>();
  const gmail = gmailEntries
    .filter((a) => typeof a?.user === 'string' && a.user && typeof a?.appPassword === 'string' && a.appPassword)
    .map((a) => ({ user: a.user.trim(), appPassword: a.appPassword }))
    .filter((a) => {
      const key = a.user.toLowerCase();
      if (seenGmail.has(key)) return false;
      seenGmail.add(key);
      return true;
    });

  // Build Telegram Bot config. Independent of the user-account client above:
  // a bot is a separate identity with its own token.
  const telegramBots = buildTelegramBots(secrets);
  const telegramBot = selectTelegramBot(telegramBots, getEnv('TELEGRAM_BOT'));

  // Build the agent-hub config. Always present, unlike the others: the URL has a
  // default, and the credential is not configuration at all - it is derived from
  // this machine at run time, so nothing here is ever a secret.
  const hub: HubConfig = {
    url: getEnv('AGENT_HUB_URL', 'HUB_URL') || secrets.hub?.url || DEFAULT_HUB_URL,
    agent: getEnv('AGENT_HUB_AGENT', 'HUB_AGENT') || secrets.hub?.agent || null,
  };

  return { telegram, telegramBot, telegramBots, jira, jiraMonitor, groq, speech, asana, gmail, hub };
}

/**
 * Chat ids arrive as numbers or strings and are compared as strings. A malformed
 * list is dropped rather than throwing, but note an empty result means
 * "unrestricted" — so a list that is entirely malformed opens the bot up, and
 * that is worth a warning from callers that care.
 */
function normaliseChatList(raw: (string | number)[] | undefined): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v) => typeof v === 'string' || typeof v === 'number')
    .map((v) => String(v).trim())
    .filter((v) => v.length > 0);
}

/**
 * Per-chat policy, keyed by chat id.
 *
 * A malformed entry becomes the empty policy rather than disappearing: for a group
 * the *presence* of a key is what says "this chat is mine", and dropping the key
 * over a typo inside it would turn a mistake in one field into a silently deaf bot.
 */
function normaliseChatPolicies(
  raw: Record<string, TelegramChatPolicySecret> | undefined
): Record<string, ChatPolicy> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};

  const policies: Record<string, ChatPolicy> = {};
  for (const [key, value] of Object.entries(raw)) {
    const chatId = String(key).trim();
    if (chatId.length === 0) continue;

    const entry = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    policies[chatId] = {
      allowFrom: normaliseChatList(entry.allowFrom),
      // Absent stays absent. The default depends on the chat type, and the gate is
      // where that is known; deciding it here would give a DM a group's default.
      requireMention: typeof entry.requireMention === 'boolean' ? entry.requireMention : undefined,
    };
  }
  return policies;
}

/** Non-empty strings only; anything else in the list is ignored. */
function normaliseStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

/** Names are compared case-insensitively, so this is the identity key. */
function botKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Collect every configured bot, in declaration order.
 *
 * `TELEGRAM_BOT_TOKEN` and the legacy single `telegramBot` entry both appear as a
 * bot named `default`, so an existing one-bot setup keeps working untouched.
 */
function buildTelegramBots(secrets: Secrets): TelegramBotConfig[] {
  const defaultChat = getEnv('TELEGRAM_BOT_DEFAULT_CHAT');
  const bots: TelegramBotConfig[] = [];
  const seen = new Set<string>();

  const add = (
    name: string,
    token: string,
    explicitDefault: boolean,
    access: Partial<BotChatAccess> = {}
  ) => {
    const trimmed = name.trim();
    const key = botKey(trimmed);

    // Deduplicate on the same key selection uses. Comparing raw names here while
    // matching case-insensitively later would keep `personal` and `Personal` as
    // two entries that neither spelling could reach.
    if (key.length === 0 || seen.has(key)) return;
    seen.add(key);
    bots.push({
      name: trimmed,
      token,
      isDefault: explicitDefault,
      defaultChat,
      allowedChats: access.allowedChats ?? [],
      chats: access.chats ?? {},
      mentionPatterns: access.mentionPatterns ?? [],
    });
  };

  // Named entries are collected first so an explicitly configured bot is never
  // discarded by a synthesized one that happens to share its name.
  //
  // A malformed `telegramBots` must not take the whole bot config down, so a
  // non-array value is ignored rather than iterated.
  const entries = Array.isArray(secrets.telegramBots) ? secrets.telegramBots : [];
  for (const entry of entries) {
    if (!isUsableBotEntry(entry)) continue;
    add(entry.name, entry.token, entry.default === true, {
      allowedChats: normaliseChatList(entry.allowedChats),
      chats: normaliseChatPolicies(entry.chats),
      mentionPatterns: normaliseStringList(entry.mentionPatterns),
    });
  }

  // An ambient token overrides the *token* of a bot called `default`, keeping
  // that entry's position and its default flag. With no such entry it becomes
  // one, placed first so a legacy single-bot setup still selects it.
  const ambient = getEnv('TELEGRAM_BOT_TOKEN') ?? secrets.telegramBot?.token;
  if (ambient) {
    const existing = bots.find((b) => botKey(b.name) === 'default');
    if (existing) existing.token = ambient;
    else bots.unshift({
      name: 'default',
      token: ambient,
      isDefault: false,
      defaultChat,
      allowedChats: normaliseChatList(secrets.telegramBot?.allowedChats),
      chats: normaliseChatPolicies(secrets.telegramBot?.chats),
      mentionPatterns: normaliseStringList(secrets.telegramBot?.mentionPatterns),
    });
  }

  // Exactly one entry ends up default: an explicit flag if any, else the first
  // declared bot (which is the synthesized one for a legacy single-bot setup).
  const explicit = bots.filter((b) => b.isDefault);
  for (const bot of bots) bot.isDefault = false;
  if (explicit.length > 0) explicit[0].isDefault = true;
  else if (bots.length > 0) bots[0].isDefault = true;

  return bots;
}

function isUsableBotEntry(entry: TelegramBotSecretEntry | undefined): entry is TelegramBotSecretEntry {
  return Boolean(
    entry &&
    typeof entry.name === 'string' && entry.name.trim().length > 0 &&
    typeof entry.token === 'string' && entry.token.length > 0
  );
}

/**
 * Pick the bot for this process. `TELEGRAM_BOT` pins one for a whole session;
 * an unknown or blank name resolves to null so the caller can list what exists
 * rather than silently acting as the wrong bot.
 */
function selectTelegramBot(bots: TelegramBotConfig[], requested?: string): TelegramBotConfig | null {
  if (bots.length === 0) return null;

  if (requested !== undefined) {
    const wanted = botKey(requested);
    // A selector that expanded to nothing (an unset shell variable) is a
    // mistake, not a request for the default.
    if (wanted.length === 0) return null;
    return bots.find((b) => botKey(b.name) === wanted) ?? null;
  }

  return bots.find((b) => b.isDefault) ?? bots[0];
}

/**
 * Resolve a bot by name, or the session default when no name is given.
 * Returns null when the name is unknown or blank; callers report the available
 * names rather than falling back.
 */
export function resolveTelegramBot(name?: string): TelegramBotConfig | null {
  const config = loadConfig();
  return name === undefined ? config.telegramBot : selectTelegramBot(config.telegramBots, name);
}

/**
 * Check if Telegram is configured
 */
export function isTelegramConfigured(): boolean {
  return loadConfig().telegram !== null;
}

/**
 * Check if Jira is configured
 */
export function isJiraConfigured(): boolean {
  return loadConfig().jira !== null;
}

/**
 * Check if Groq is configured
 */
export function isGroqConfigured(): boolean {
  return loadConfig().groq !== null;
}

/**
 * Check if any speech-to-text backend is configured
 */
export function isSttConfigured(): boolean {
  const config = loadConfig();
  return config.speech !== null || config.groq !== null;
}

/**
 * Check if Asana is configured
 */
export function isAsanaConfigured(): boolean {
  return loadConfig().asana !== null;
}

/**
 * Check if the Telegram Bot API is configured
 */
/**
 * Whether any bot credentials exist. Note this is not "a bot is selected": with
 * an unknown `TELEGRAM_BOT` this is true while `config.telegramBot` is null.
 */
export function isTelegramBotConfigured(): boolean {
  return loadConfig().telegramBots.length > 0;
}

export { getSecretsPath, getConfigDir } from './paths.js';
