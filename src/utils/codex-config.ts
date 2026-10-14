import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const DEFAULT_CODEX_HOME = path.join(os.homedir(), '.codex');
export const DEFAULT_CHATGPT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
export const DEFAULT_ORIGINATOR = 'codex_cli_rs';
export const DEFAULT_CODEX_MODEL = 'gpt-5';
export const DEFAULT_CLAUDE_SUMMARIZATION_MODEL = 'opus';
export const ALLOWED_CLAUDE_SUMMARIZATION_MODELS = ['opus', 'sonnet', 'haiku'] as const;

export type ClaudeSummarizationModel = typeof ALLOWED_CLAUDE_SUMMARIZATION_MODELS[number];

export interface CodexDefaults {
  codexHome: string;
  model: string | null;
  reasoningEffort: string | null;
  version: string;
  originator: string;
  baseUrl: string;
}

export function resolveCodexHome(codexHome?: string): string {
  if (codexHome) {
    return codexHome;
  }

  const envHome = process.env.CODEX_HOME?.trim();
  if (envHome) {
    return envHome;
  }

  return DEFAULT_CODEX_HOME;
}

export function loadCodexDefaults(codexHome?: string): CodexDefaults {
  const home = resolveCodexHome(codexHome);
  const config = loadFlatToml(home ? path.join(home, 'config.toml') : '');
  const version = loadVersion(path.join(home, 'version.json'));
  const originator = coerceNonEmptyString(process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE) || DEFAULT_ORIGINATOR;

  return {
    codexHome: home,
    model: coerceNonEmptyString(config.model),
    reasoningEffort: coerceNonEmptyString(config.model_reasoning_effort),
    version,
    originator,
    baseUrl: DEFAULT_CHATGPT_CODEX_BASE_URL,
  };
}

export function buildCodexUserAgent(originator: string, version: string): string {
  return `${originator}/${version} (${os.type()} ${os.release()}; ${os.arch()}) Node/${process.versions.node}`;
}

export function normalizeClaudeSummarizationModel(value?: string): ClaudeSummarizationModel {
  const normalized = (coerceNonEmptyString(value) || DEFAULT_CLAUDE_SUMMARIZATION_MODEL).toLowerCase();
  if (ALLOWED_CLAUDE_SUMMARIZATION_MODELS.includes(normalized as ClaudeSummarizationModel)) {
    return normalized as ClaudeSummarizationModel;
  }

  throw new Error(
    `Claude summary model must be one of: ${ALLOWED_CLAUDE_SUMMARIZATION_MODELS.join(', ')}.`
  );
}

export function coerceNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

function loadVersion(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    return '0.0.0';
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
    return coerceNonEmptyString(parsed.latest_version) || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function loadFlatToml(filePath: string): Record<string, string> {
  if (!filePath || !fs.existsSync(filePath)) {
    return {};
  }

  const result: Record<string, string> = {};
  const lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/);
  let inRootSection = true;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    if (line.startsWith('[') && line.endsWith(']')) {
      inRootSection = false;
      continue;
    }

    if (!inRootSection) {
      continue;
    }

    const match = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+?)\s*(?:#.*)?$/);
    if (!match) {
      continue;
    }

    const [, key, rawValue] = match;
    const value = parseTomlValue(rawValue);
    if (value !== null) {
      result[key] = value;
    }
  }

  return result;
}

function parseTomlValue(rawValue: string): string | null {
  const value = rawValue.trim();
  if (!value) {
    return null;
  }

  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
    return value.slice(1, -1);
  }

  return value;
}
