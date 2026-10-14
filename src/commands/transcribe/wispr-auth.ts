// Wispr Flow authentication utilities

import * as fs from 'fs';
import * as path from 'path';

// Wispr Flow data locations
const WISPR_SESSION_PATH = path.join(
  process.env.APPDATA || '',
  'Wispr Flow',
  'session.json'
);

const WISPR_CONFIG_PATH = path.join(
  process.env.APPDATA || '',
  'Wispr Flow',
  'config.json'
);

interface WisprSession {
  'sb-dodjkfqhwrzqjwkfnthl-auth-token': string;
}

interface SupabaseToken {
  access_token: string;
  token_type: string;
  expires_in: number;
  expires_at: number;
  refresh_token: string;
  user: {
    id: string;
    email: string;
  };
}

export interface WisprCredentials {
  accessToken: string;
  userId: string;
  email: string;
  expiresAt: Date;
}

export async function getWisprCredentials(): Promise<WisprCredentials> {
  if (!fs.existsSync(WISPR_SESSION_PATH)) {
    throw new Error(
      `Wispr Flow session not found. Make sure Wispr Flow is installed and you're logged in.\n` +
      `Expected path: ${WISPR_SESSION_PATH}`
    );
  }

  const sessionData: WisprSession = JSON.parse(
    fs.readFileSync(WISPR_SESSION_PATH, 'utf-8')
  );

  const tokenKey = 'sb-dodjkfqhwrzqjwkfnthl-auth-token';
  const tokenStr = sessionData[tokenKey];

  if (!tokenStr) {
    throw new Error('No auth token found in Wispr session file. Please log in to Wispr Flow.');
  }

  const token: SupabaseToken = JSON.parse(tokenStr);

  return {
    accessToken: token.access_token,
    userId: token.user.id,
    email: token.user.email,
    expiresAt: new Date(token.expires_at * 1000),
  };
}

export async function getSessionId(): Promise<string> {
  if (!fs.existsSync(WISPR_CONFIG_PATH)) {
    return crypto.randomUUID();
  }

  const configData = JSON.parse(fs.readFileSync(WISPR_CONFIG_PATH, 'utf-8'));
  return configData.prefs?.sessionId || crypto.randomUUID();
}
