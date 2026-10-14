// Platform-specific configuration paths

import { homedir } from 'os';
import { join } from 'path';

/**
 * Get the config directory for secrets
 * - Windows: %APPDATA%\claude-tools
 * - Linux/Mac: ~/.config/claude-tools
 */
export function getConfigDir(): string {
  if (process.env.CLAUDE_TOOLS_CONFIG_DIR) return process.env.CLAUDE_TOOLS_CONFIG_DIR;
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'claude-tools');
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'claude-tools');
}

/**
 * Get the secrets file path
 */
export function getSecretsPath(): string {
  return join(getConfigDir(), 'secrets.json');
}

/**
 * Project config filename (can be committed)
 */
export const PROJECT_CONFIG_FILENAME = '.claude-tools.json';

/**
 * Get the media directory for downloaded Telegram files
 */
export function getMediaDir(): string {
  return join(getConfigDir(), 'media');
}

/**
 * Get subdirectory for a specific media type
 */
export function getMediaTypeDir(type: 'photos' | 'videos' | 'documents' | 'voice' | 'audio' | 'stickers'): string {
  return join(getMediaDir(), type);
}
