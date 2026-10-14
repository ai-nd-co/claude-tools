// People configuration for Telegram contacts
// Note: Aliases have been removed. Use docs/team-directory.md for team member info.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getConfigDir } from './paths.js';

const PEOPLE_FILE = join(getConfigDir(), 'people.json');

export interface PersonEntry {
  firstName?: string;
  lastName?: string;
  username?: string;
  lastSeen?: string;  // Chat title where last seen
}

export interface PeopleConfig {
  people: Record<string, PersonEntry>;
  defaultChat?: string;
}

/**
 * Load people config from %APPDATA%/claude-tools/people.json
 */
export function loadPeopleConfig(): PeopleConfig {
  if (!existsSync(PEOPLE_FILE)) {
    return { people: {} };
  }
  try {
    const data = JSON.parse(readFileSync(PEOPLE_FILE, 'utf-8'));
    // Migration: convert old 'aliases' format to new 'people' format
    if (data.aliases && !data.people) {
      return { people: {}, defaultChat: data.defaultChat };
    }
    return data;
  } catch {
    return { people: {} };
  }
}

/**
 * Save people config to %APPDATA%/claude-tools/people.json
 */
export function savePeopleConfig(config: PeopleConfig): void {
  const configDir = getConfigDir();
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
  writeFileSync(PEOPLE_FILE, JSON.stringify(config, null, 2));
}

/**
 * Get the people config file path
 */
export function getPeopleConfigPath(): string {
  return PEOPLE_FILE;
}
