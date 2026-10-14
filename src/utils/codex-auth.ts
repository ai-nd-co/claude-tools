import * as fs from 'fs';
import * as path from 'path';
import { buildCodexUserAgent, coerceNonEmptyString, resolveCodexHome } from './codex-config.js';

const REFRESH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const REFRESH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

export class CodexAuthError extends Error {}
export class CodexUnsupportedAuthModeError extends CodexAuthError {}
export class CodexMissingTokenError extends CodexAuthError {}
export class CodexPermanentRefreshError extends CodexAuthError {}

export interface ChatgptTokens {
  accessToken: string;
  refreshToken: string;
  accountId: string;
  idToken: string | null;
}

export interface CodexAuthState {
  path: string;
  authMode: string | null;
  tokens: ChatgptTokens;
  lastRefresh: string | null;
  raw: Record<string, unknown>;
}

export type FetchLike = typeof fetch;

interface RefreshOptions {
  originator: string;
  version: string;
  timeoutMs: number;
  fetchImpl?: FetchLike;
}

export function loadCodexAuthState(codexHome?: string): CodexAuthState {
  const home = resolveCodexHome(codexHome);
  const filePath = path.join(home, 'auth.json');

  if (!fs.existsSync(filePath)) {
    throw new CodexAuthError(`Codex auth file not found: ${filePath}`);
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  } catch (error) {
    throw new CodexAuthError(`Failed to read Codex auth file: ${(error as Error).message}`);
  }

  const authMode = coerceNonEmptyString(raw.auth_mode);
  if (authMode !== 'chatgpt') {
    throw new CodexUnsupportedAuthModeError(
      `Expected ChatGPT Codex login in ${filePath}, got auth_mode=${JSON.stringify(authMode)}`
    );
  }

  const tokensRaw = isRecord(raw.tokens) ? raw.tokens : null;
  if (!tokensRaw) {
    throw new CodexMissingTokenError(`ChatGPT tokens missing in ${filePath}`);
  }

  const accessToken = requiredString(tokensRaw.access_token, 'access_token', filePath);
  const refreshToken = requiredString(tokensRaw.refresh_token, 'refresh_token', filePath);
  const accountId = coerceNonEmptyString(tokensRaw.account_id) || extractAccountId(tokensRaw);
  if (!accountId) {
    throw new CodexMissingTokenError(`ChatGPT account_id missing in ${filePath}`);
  }

  return {
    path: filePath,
    authMode,
    tokens: {
      accessToken,
      refreshToken,
      accountId,
      idToken: coerceNonEmptyString(tokensRaw.id_token),
    },
    lastRefresh: coerceNonEmptyString(raw.last_refresh),
    raw,
  };
}

export function reloadCodexAuthState(previous: CodexAuthState): { state: CodexAuthState; changed: boolean } {
  const current = loadCodexAuthState(path.dirname(previous.path));
  const changed =
    current.tokens.accessToken !== previous.tokens.accessToken ||
    current.tokens.refreshToken !== previous.tokens.refreshToken ||
    current.tokens.accountId !== previous.tokens.accountId;

  return { state: current, changed };
}

export async function refreshCodexTokens(
  authState: CodexAuthState,
  options: RefreshOptions
): Promise<CodexAuthState> {
  const fetchImpl = options.fetchImpl || fetch;
  const response = await fetchImpl(REFRESH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      originator: options.originator,
      'user-agent': buildCodexUserAgent(options.originator, options.version),
    },
    body: JSON.stringify({
      client_id: REFRESH_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: authState.tokens.refreshToken,
    }),
    signal: AbortSignal.timeout(options.timeoutMs),
  });

  const body = await response.text();
  if (response.status === 401) {
    throw new CodexPermanentRefreshError(classifyRefreshFailure(body));
  }
  if (!response.ok) {
    throw new CodexAuthError(`Codex token refresh failed with ${response.status}: ${body.trim() || 'unknown error'}`);
  }

  const parsed = JSON.parse(body) as Record<string, unknown>;
  const accessToken = coerceNonEmptyString(parsed.access_token) || authState.tokens.accessToken;
  const refreshToken = coerceNonEmptyString(parsed.refresh_token) || authState.tokens.refreshToken;
  const idToken = coerceNonEmptyString(parsed.id_token) || authState.tokens.idToken;

  persistTokens(authState, {
    accessToken,
    refreshToken,
    idToken,
  });

  return loadCodexAuthState(path.dirname(authState.path));
}

function persistTokens(
  authState: CodexAuthState,
  updates: { accessToken: string; refreshToken: string; idToken: string | null }
): void {
  const payload = { ...authState.raw };
  const tokens = isRecord(payload.tokens) ? { ...payload.tokens } : {};
  tokens.access_token = updates.accessToken;
  tokens.refresh_token = updates.refreshToken;
  tokens.account_id = authState.tokens.accountId;
  if (updates.idToken) {
    tokens.id_token = updates.idToken;
  }
  payload.tokens = tokens;
  payload.last_refresh = new Date().toISOString();

  atomicWriteJson(authState.path, payload);
}

function atomicWriteJson(filePath: string, payload: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  // This file holds OAuth credentials. A rename gives the target the TEMP file's mode, so writing
  // under the default umask silently widened an existing 0600 to 0644. Carry the old mode over, and
  // default to 0600 for a new file. chmod after the write because `mode` is masked by the umask.
  // Clamp rather than copy: copying would leave a file an earlier refresh already widened at 0644
  // for ever, so the fix would never repair the machines it exists for. Strip group and other.
  let mode = 0o600;
  try {
    mode = (fs.statSync(filePath).mode & 0o700) | 0o600;
  } catch {
    // no existing file: 0600 is the right default for a credential store
  }
  fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf-8', mode });
  fs.chmodSync(tempPath, mode);
  fs.renameSync(tempPath, filePath);
}

function classifyRefreshFailure(body: string): string {
  const code = extractErrorCode(body);
  if (code === 'refresh_token_expired') {
    return 'Codex ChatGPT refresh token expired.';
  }
  if (code === 'refresh_token_reused') {
    return 'Codex ChatGPT refresh token exhausted.';
  }
  if (code === 'refresh_token_invalidated') {
    return 'Codex ChatGPT refresh token revoked.';
  }
  return 'Codex ChatGPT token refresh failed permanently.';
}

function extractErrorCode(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (isRecord(parsed.error)) {
      return coerceNonEmptyString(parsed.error.code) || coerceNonEmptyString(parsed.error.error) || null;
    }
    return coerceNonEmptyString(parsed.error) || coerceNonEmptyString(parsed.code) || null;
  } catch {
    return null;
  }
}

function extractAccountId(tokensRaw: Record<string, unknown>): string | null {
  for (const field of ['id_token', 'access_token']) {
    const token = coerceNonEmptyString(tokensRaw[field]);
    if (!token) {
      continue;
    }

    const accountId = extractAccountIdFromJwt(token);
    if (accountId) {
      return accountId;
    }
  }

  return null;
}

function extractAccountIdFromJwt(jwt: string): string | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as Record<string, unknown>;
    return coerceNonEmptyString(payload.account_id) || coerceNonEmptyString(payload.accountId) || null;
  } catch {
    return null;
  }
}

function requiredString(value: unknown, field: string, filePath: string): string {
  const result = coerceNonEmptyString(value);
  if (!result) {
    throw new CodexMissingTokenError(`ChatGPT ${field} missing in ${filePath}`);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
