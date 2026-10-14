#!/usr/bin/env node
/**
 * Telegram Session Generator
 *
 * Interactive script to generate a Telegram session string.
 * Run with: claude-tools telegram auth
 *
 * Prerequisites:
 * 1. Get API credentials from https://my.telegram.org/apps
 * 2. Have your phone number ready
 * 3. Have access to Telegram to receive the code
 */

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import * as readline from 'readline';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import { getSecretsPath, getConfigDir } from '../config/paths.js';
import type { Secrets } from '../config/types.js';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

async function main(): Promise<void> {
  console.log('\n===========================================');
  console.log('       Telegram Session Generator');
  console.log('===========================================\n');
  console.log('Get API credentials from: https://my.telegram.org/apps\n');

  // Get API credentials
  const apiIdStr = await ask('API ID: ');
  const apiId = parseInt(apiIdStr, 10);
  if (isNaN(apiId)) {
    console.error('Invalid API ID');
    rl.close();
    process.exit(1);
  }

  const apiHash = await ask('API Hash: ');
  if (!apiHash) {
    console.error('API Hash is required');
    rl.close();
    process.exit(1);
  }

  console.log('\nConnecting to Telegram...\n');

  const session = new StringSession('');
  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 3,
  });

  try {
    await client.start({
      phoneNumber: () => ask('Phone number (with country code, e.g., +1234567890): '),
      password: () => ask('2FA Password (if enabled, press Enter if none): '),
      phoneCode: () => ask('Code from Telegram: '),
      onError: (err) => console.error('Error:', err.message),
    });

    const sessionString = client.session.save() as unknown as string;

    console.log('\n===========================================');
    console.log('         Session Created Successfully!');
    console.log('===========================================\n');

    // Ask if user wants to save to secrets file
    const save = await ask('Save to secrets.json? (y/n): ');

    if (save.toLowerCase() === 'y') {
      const configDir = getConfigDir();
      const secretsPath = getSecretsPath();

      // Ensure directory exists
      if (!existsSync(configDir)) {
        mkdirSync(configDir, { recursive: true, mode: 0o700 });
      }

      // Load existing secrets or create new
      let secrets: Secrets = {};
      if (existsSync(secretsPath)) {
        try {
          secrets = JSON.parse(readFileSync(secretsPath, 'utf-8'));
        } catch {
          // Invalid JSON, start fresh
        }
      }

      // Update Telegram section
      secrets.telegram = {
        apiId,
        apiHash,
        sessionString,
      };

      // This file holds the session string and the API hash: anyone who reads it can act as the
      // account. Create it 0600 rather than inheriting the umask, and tighten it if it already
      // exists more permissively, because writeFileSync does not change an existing file's mode.
      writeFileSync(secretsPath, JSON.stringify(secrets, null, 2), { mode: 0o600 });
      chmodSync(secretsPath, 0o600);
      console.log(`\nSaved to: ${secretsPath}`);
    } else {
      // Just print the session string
      console.log('\nSession String (save this securely):');
      console.log('-------------------------------------------');
      console.log(sessionString);
      console.log('-------------------------------------------');

      console.log('\nAdd to ~/.config/claude-tools/secrets.json:');
      console.log(JSON.stringify({
        telegram: { apiId, apiHash, sessionString }
      }, null, 2));
    }

    await client.disconnect();
  } catch (err) {
    console.error('Authentication failed:', (err as Error).message);
    process.exit(1);
  } finally {
    rl.close();
  }
}

main().catch(console.error);
