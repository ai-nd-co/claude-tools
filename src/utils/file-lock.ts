// Simple file-based lock mechanism for Telegram sessions
// Prevents multiple clients from using the same session simultaneously

import { existsSync, writeFileSync, unlinkSync, readFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

const LOCK_DIR = join(homedir(), '.claude-tools');
const LOCK_FILE = join(LOCK_DIR, 'telegram.lock');
const LOCK_TIMEOUT_MS = 60000; // 1 minute timeout for stale locks
const POLL_INTERVAL_MS = 500; // Check every 500ms

interface LockInfo {
  pid: number;
  timestamp: number;
}

function ensureLockDir(): void {
  if (!existsSync(LOCK_DIR)) {
    mkdirSync(LOCK_DIR, { recursive: true });
  }
}

function readLock(): LockInfo | null {
  try {
    if (!existsSync(LOCK_FILE)) return null;
    const content = readFileSync(LOCK_FILE, 'utf-8');
    return JSON.parse(content) as LockInfo;
  } catch {
    return null;
  }
}

function writeLock(): void {
  ensureLockDir();
  const info: LockInfo = {
    pid: process.pid,
    timestamp: Date.now(),
  };
  writeFileSync(LOCK_FILE, JSON.stringify(info));
}

function isLockStale(lock: LockInfo): boolean {
  // Check if lock is older than timeout
  if (Date.now() - lock.timestamp > LOCK_TIMEOUT_MS) {
    return true;
  }

  // Check if process is still running (Unix-like check)
  try {
    process.kill(lock.pid, 0); // Signal 0 = check if process exists
    return false; // Process exists
  } catch {
    return true; // Process doesn't exist
  }
}

/**
 * Acquire a lock for Telegram session.
 * Waits if another process holds the lock.
 * @param timeoutMs Maximum time to wait for lock (default: 30s)
 */
export async function acquireTelegramLock(timeoutMs: number = 30000): Promise<void> {
  const startTime = Date.now();

  while (true) {
    const existingLock = readLock();

    // No lock exists, or lock is stale - acquire it
    if (!existingLock || isLockStale(existingLock)) {
      writeLock();
      return;
    }

    // Lock is held by another active process
    if (Date.now() - startTime > timeoutMs) {
      throw new Error(
        `Telegram session is locked by another process (PID: ${existingLock.pid}). ` +
        `Waited ${Math.round(timeoutMs / 1000)}s. Try again later.`
      );
    }

    // Wait and retry
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/**
 * Release the Telegram session lock.
 */
export function releaseTelegramLock(): void {
  try {
    const lock = readLock();
    // Only release if we own the lock
    if (lock && lock.pid === process.pid) {
      unlinkSync(LOCK_FILE);
    }
  } catch {
    // Ignore errors on release
  }
}

/**
 * Update lock timestamp to prevent timeout while still active.
 * Call this periodically during long operations.
 */
export function refreshTelegramLock(): void {
  const lock = readLock();
  if (lock && lock.pid === process.pid) {
    writeLock();
  }
}
