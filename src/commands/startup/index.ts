// Startup command - find and reopen recent work sessions

import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getOrchestrator } from '../../services/orchestrator.js';

interface SessionInfo {
  sessionId: string;
  filePath: string;
  projectName: string;
  lastModified: Date;
  preview: string;
}

/**
 * Get session info from a JSONL file
 */
function getSessionInfo(filePath: string, projectName: string): SessionInfo | null {
  try {
    const stat = fs.statSync(filePath);
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.trim().split('\n').filter(l => l.trim());

    if (lines.length === 0) return null;

    let sessionId = '';
    let preview = '';

    // Get session ID and first user message for preview
    for (let i = 0; i < Math.min(20, lines.length); i++) {
      try {
        const parsed = JSON.parse(lines[i]);
        if (!sessionId && parsed.sessionId) {
          sessionId = parsed.sessionId;
        }
        if (!preview && parsed.type === 'user' && parsed.message?.content) {
          const msgContent = parsed.message.content;
          if (typeof msgContent === 'string') {
            preview = msgContent.slice(0, 50);
          }
        }
        if (sessionId && preview) break;
      } catch {
        // Skip invalid JSON
      }
    }

    if (!sessionId) return null;

    return {
      sessionId,
      filePath,
      projectName,
      lastModified: stat.mtime,
      preview: preview || '[No preview]',
    };
  } catch {
    return null;
  }
}

/**
 * Load all sessions from Claude projects directory
 */
function loadAllSessions(): SessionInfo[] {
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');

  if (!fs.existsSync(claudeDir)) {
    return [];
  }

  const projects = fs.readdirSync(claudeDir).filter(f =>
    fs.statSync(path.join(claudeDir, f)).isDirectory()
  );

  const sessions: SessionInfo[] = [];

  for (const project of projects) {
    const projectDir = path.join(claudeDir, project);
    const jsonlFiles = fs.readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-') && !f.includes('.backup'));

    for (const f of jsonlFiles) {
      const filePath = path.join(projectDir, f);
      const info = getSessionInfo(filePath, project);
      if (info) {
        sessions.push(info);
      }
    }
  }

  return sessions;
}

/**
 * Format relative time for display
 */
function formatRelativeTime(date: Date): string {
  const now = Date.now();
  const then = date.getTime();
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

/**
 * Format file size
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function registerStartupCommands(program: Command): void {
  program
    .command('startup')
    .description('Reopen recent work sessions (finds sessions edited within 15 mins of latest)')
    .option('--window <minutes>', 'Time window in minutes (default: 15)', '15')
    .option('--dry-run', 'Show what would be opened without opening')
    .option('--compact', 'Compact sessions before opening (target 40%)')
    .addHelpText('after', `
${chalk.yellow('How it works:')}
  1. Finds the most recently edited session (by file modification time)
  2. Finds all other sessions edited within the time window of that session
  3. Opens each session in a new window with --resume

${chalk.yellow('Examples:')}
  ${chalk.dim('# Reopen recent work (default 15 min window)')}
  claude-tools startup

  ${chalk.dim('# Use 30 minute window')}
  claude-tools startup --window 30

  ${chalk.dim('# Preview without opening')}
  claude-tools startup --dry-run
`)
    .action(async (options: { window?: string; dryRun?: boolean; compact?: boolean }) => {
      const windowMinutes = parseInt(options.window || '15', 10);
      const windowMs = windowMinutes * 60 * 1000;

      // Load all sessions
      const sessions = loadAllSessions();

      if (sessions.length === 0) {
        console.log(chalk.yellow('No sessions found.'));
        return;
      }

      // Sort by last modified (most recent first)
      sessions.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());

      // Find the latest session
      const latest = sessions[0];
      const latestTime = latest.lastModified.getTime();

      console.log(chalk.bold('Latest session:'));
      console.log(`  ${chalk.cyan(latest.sessionId.slice(0, 8))} - ${formatRelativeTime(latest.lastModified)}`);
      console.log(`  ${chalk.dim(latest.preview)}`);
      console.log();

      // Find all sessions within the time window
      const toOpen = sessions.filter(s => {
        const diff = latestTime - s.lastModified.getTime();
        return diff >= 0 && diff <= windowMs;
      });

      if (toOpen.length === 0) {
        console.log(chalk.yellow('No sessions found within the time window.'));
        return;
      }

      console.log(chalk.bold(`Sessions within ${windowMinutes} minute window: ${toOpen.length}`));
      console.log();

      for (const session of toOpen) {
        const stat = fs.statSync(session.filePath);
        console.log(`  ${chalk.cyan(session.sessionId.slice(0, 8))} ${formatRelativeTime(session.lastModified).padEnd(10)} ${formatSize(stat.size).padStart(10)}`);
        console.log(`  ${chalk.dim(session.preview)}`);
        console.log();
      }

      if (options.dryRun) {
        console.log(chalk.yellow('Dry run - no windows opened.'));
        return;
      }

      // Open each session in a new window
      const orchestrator = await getOrchestrator();
      const platform = os.platform();

      for (const session of toOpen) {
        let commandLine: string;
        if (platform === 'win32') {
          commandLine = `cmd.exe /K claude --dangerously-skip-permissions --resume ${session.sessionId}`;
        } else {
          commandLine = `claude --resume ${session.sessionId}`;
        }
        const { taskId, pid } = await orchestrator.spawnTaskWithCommand(commandLine, {
          name: session.preview.slice(0, 30) || `Session ${session.sessionId.slice(0, 8)}`,
          workingDir: process.cwd(),
        });
        console.log(`${chalk.green('Opened:')} ${session.sessionId.slice(0, 8)} - Task ${chalk.cyan(taskId)}, PID: ${chalk.yellow(pid || 'N/A')}`);

        // Small delay between window spawns
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      console.log();
      console.log(chalk.green(`Opened ${toOpen.length} session(s).`));
    });
}
