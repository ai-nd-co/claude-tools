// Fork command - find current session, optionally compact it, and fork to a new window

import { Command } from 'commander';
import { render } from 'ink';
import React from 'react';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { compactMessagesProgressive, findFailedBashRetries, formatSize, PROGRESSIVE_TARGET_RATIO } from '../../utils/compact.js';
import { summarizeSessionFile, printSummarizationResult } from '../../utils/summarize.js';
import { findSessionByMarker, findSessionFileById } from '../../utils/session.js';
import ForkApp, { ForkResult } from './App.js';
import { loadAllSessions, SessionInfo } from '../../utils/session-search.js';
import { SummaryProvider } from '../../utils/summary-provider.js';

/**
 * Find a session matching a query string
 * Searches preview, project name, session ID, and searchable content
 */
function findSessionByQuery(query: string): SessionInfo | null {
  const sessions = loadAllSessions();
  const lowerQuery = query.toLowerCase();

  return sessions.find(s =>
    s.preview.toLowerCase().includes(lowerQuery) ||
    s.projectName.toLowerCase().includes(lowerQuery) ||
    s.sessionId.toLowerCase().includes(lowerQuery) ||
    (s.searchableContent && s.searchableContent.toLowerCase().includes(lowerQuery))
  ) || null;
}

interface CompactOptions {
  targetRatio?: number;
  dryRun?: boolean;
  keepRetries?: boolean;
}

interface CompactResult {
  originalSize: number;
  compactedSize: number;
  removedRetries: number;
  stats: { total: number; truncated: number };
}

/**
 * Compact a session JSONL file using progressive compaction:
 * 1. Remove failed bash retries
 * 2. Apply progressive compaction (aggressive at start, preserve end)
 *    - 0-50% bytes: aggressive truncation
 *    - 50-80% bytes: moderate truncation
 *    - 80-100% bytes: preserved (except bash output)
 *    - Target: 40% of original size
 */
function compactSession(filePath: string, options: CompactOptions = {}): CompactResult {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n').filter(line => line.trim());
  let messages = lines.map(line => JSON.parse(line) as Record<string, unknown>);

  let removedRetries = 0;

  // Step 1: Remove failed bash retries (default: enabled)
  if (!options.keepRetries) {
    const toRemove = findFailedBashRetries(messages);
    removedRetries = toRemove.size;
    if (toRemove.size > 0) {
      messages = messages.filter((_, idx) => !toRemove.has(idx));
      console.log(chalk.dim(`Removed ${removedRetries} failed bash retry messages`));
    }
  }

  // Step 2: Apply progressive compaction
  const result = compactMessagesProgressive(messages, {
    targetRatio: options.targetRatio ?? PROGRESSIVE_TARGET_RATIO,
  });

  if (!options.dryRun) {
    const compactedContent = result.messages.map(m => JSON.stringify(m)).join('\n') + '\n';
    fs.writeFileSync(filePath, compactedContent, 'utf8');
  }

  return { ...result, removedRetries };
}

/**
 * Print compaction results to console
 */
function printCompactResult(result: CompactResult, dryRun?: boolean): void {
  const savedBytes = result.originalSize - result.compactedSize;
  const savedPercent = Math.round((savedBytes / result.originalSize) * 100);
  const finalPercent = Math.round((result.compactedSize / result.originalSize) * 100);

  if (dryRun) {
    console.log(chalk.yellow('Dry run - no changes made'));
  }

  const retriesInfo = result.removedRetries > 0 ? `, ${result.removedRetries} retries removed` : '';
  console.log(chalk.green(`Progressive compaction: ${result.stats.truncated}/${result.stats.total} messages truncated${retriesInfo}`));
  console.log(chalk.green(`Size: ${formatSize(result.originalSize)} → ${formatSize(result.compactedSize)} (${finalPercent}% of original)`));
  console.log(chalk.green(`Saved: ${formatSize(savedBytes)} (${savedPercent}%)`));
}

/**
 * Extract the project path from a session file by reading the cwd from the first user message
 */
function getProjectFromSessionFile(sessionFilePath: string): string {
  const content = fs.readFileSync(sessionFilePath, 'utf8');
  const lines = content.split('\n').filter(line => line.trim());

  for (const line of lines) {
    try {
      const msg = JSON.parse(line);
      if (msg.cwd) {
        return msg.cwd;
      }
    } catch {
      // Skip invalid lines
    }
  }

  return process.cwd();
}

/**
 * Add a new session entry to Claude's history.jsonl file
 */
function addToHistory(sessionId: string, project: string, displayText: string = 'Forked session'): void {
  const historyPath = path.join(os.homedir(), '.claude', 'history.jsonl');

  const entry = {
    display: displayText,
    pastedContents: {},
    timestamp: Date.now(),
    project,
    sessionId,
  };

  fs.appendFileSync(historyPath, JSON.stringify(entry) + '\n', 'utf8');
}

/**
 * Update session ID in all messages of a JSONL file
 */
function updateSessionId(filePath: string, oldSessionId: string, newSessionId: string): void {
  const content = fs.readFileSync(filePath, 'utf8');
  const updated = content.replace(new RegExp(oldSessionId, 'g'), newSessionId);
  fs.writeFileSync(filePath, updated, 'utf8');
}

/**
 * Resume a forked session in the current terminal, replacing this process flow.
 */
function resumeForkedSession(sessionId: string, workingDir?: string): never {
  const cwd = workingDir || process.cwd();
  const claudeArgs = ['--dangerously-skip-permissions', '--resume', sessionId];

  console.log(chalk.dim(`Resuming forked session in current terminal...`));
  console.log(chalk.dim(`Working dir: ${cwd}`));

  const result = spawnSync('claude', claudeArgs, {
    stdio: 'inherit',
    shell: os.platform() === 'win32',
    cwd,
  });

  process.exit(result.status || 0);
}

export function registerForkCommands(program: Command): void {
  program
    .command('fork [marker]')
    .description('Fork a Claude session and resume it in the current terminal, optionally compacting it first')
    .option('-i, --interactive', 'Interactive mode: browse and select from all sessions')
    .option('--interactive-inline', 'Interactive mode inline (used internally, runs in current terminal)')
    .option('--query <keyword>', 'Quick search: find first session matching keyword and fork immediately')
    .option('--name <name>', 'Window title for the forked session')
    .option('--dir <path>', 'Working directory for the forked session')
    .option('--session <id>', 'Directly specify session ID (skip marker search)')
    .option('--compact', 'Compact session using progressive compaction (target 40%)')
    .option('--no-summary', 'Disable AI summarization (summary is enabled by default)')
    .option('--summary-provider <provider>', 'Summary provider: codex or claude')
    .option('--summary-model <model>', 'Provider-specific summary model override')
    .option('--model <model>', 'Legacy Claude-only summary model alias (implies Claude when used alone)')
    .option('--cutoff <percent>', 'Summarization cutoff percentage (default: 60)', '60')
    .option('--file-reads', 'Include fake Read tool calls for modified files in summary (disabled by default)')
    .option('--target <percent>', 'Target size as percentage for progressive compact (default: 40)', '40')
    .option('--keep-retries', 'Keep failed bash retries (default: remove them)')
    .option('--no-backup', 'Skip creating backup before compacting')
    .option('--dry-run', 'Show what would be compacted without making changes')
    .addHelpText('after', `
${chalk.yellow('How it works:')}
  1. Claude calls this command with a unique marker UUID
  2. The command searches recent JSONL files for that marker
  3. Optionally compacts the session using progressive compaction
  4. The current terminal resumes the forked session with --resume <sessionId>

${chalk.yellow('Interactive Mode:')}
  Use --interactive to browse all sessions interactively:
  - Type to filter sessions by content/project name
  - Arrow keys to navigate, Enter to fork+compact, Esc to quit

${chalk.yellow('Summarization (enabled by default):')}
  Uses Codex by default to generate an intelligent summary of first 60% of conversation.
  - Generates detailed summary with problem statements, solutions, files, todos
  - Falls back to Claude automatically if Codex auth/backend is unavailable
  - Use --no-summary to disable and fork without summarization

${chalk.yellow('Progressive Compaction (--compact):')}
  Simple truncation-based compaction to ~40% of original size.
  - 0-50% of bytes: aggressive truncation (gradient 20-200 chars)
  - 50-80% of bytes: moderate truncation (200 chars)
  - 80-100% of bytes: preserved (except bash output)
  - Faster but less intelligent than summarization

${chalk.yellow('Examples:')}
  ${chalk.dim('# Interactive mode (browse all sessions)')}
  claude-tools fork --interactive

  ${chalk.dim('# Quick search: find first session matching keyword and fork immediately')}
  claude-tools fork --query "vim mode"

  ${chalk.dim('# Fork with AI summarization (default)')}
  claude-tools fork abc123-marker --name "Summarized Session"

  ${chalk.dim('# Fork without summarization')}
  claude-tools fork abc123-marker --no-summary --name "Plain Fork"

  ${chalk.dim('# Fork with custom cutoff for summarization')}
  claude-tools fork abc123-marker --cutoff 50

  ${chalk.dim('# Force Claude summary provider')}
  claude-tools fork abc123-marker --summary-provider claude --summary-model sonnet
`)
    .action(async (marker: string | undefined, options: {
      interactive?: boolean;
      interactiveInline?: boolean;
      query?: string;
      name?: string;
      dir?: string;
      session?: string;
      compact?: boolean;
      summary?: boolean;  // --no-summary sets this to false
      summaryProvider?: SummaryProvider;
      summaryModel?: string;
      model?: string;
      cutoff?: string;
      fileReads?: boolean;  // --no-file-reads sets this to false
      target?: string;
      keepRetries?: boolean;
      backup?: boolean;
      dryRun?: boolean;
    }) => {
      // Interactive mode - runs in current terminal
      if (options.interactive || options.interactiveInline) {
        // Use a shared result object so the component can pass back
        // the session ID and cwd without trying to spawn claude itself.
        let forkResult: ForkResult | null = null;
        const { waitUntilExit } = render(React.createElement(ForkApp, {
          compact: true,
          summaryProvider: options.summaryProvider,
          summaryModel: options.summaryModel,
          model: options.model,
          onDone: (result: ForkResult) => { forkResult = result; },
        }));

        // Wait for Ink to fully unmount — this ensures stdin is completely
        // released and no longer in raw mode before we spawn claude.
        await waitUntilExit();

        if (forkResult) {
          const { sessionId, cwd } = forkResult;
          resumeForkedSession(sessionId, cwd);
        }
        return;
      }

      // Quick search mode - find first matching session and fork immediately
      if (options.query) {
        const session = findSessionByQuery(options.query);
        if (!session) {
          console.log(chalk.red(`No session found matching: "${options.query}"`));
          process.exit(1);
        }

        console.log(chalk.green(`Found session: ${session.sessionId.slice(0, 8)}...`));
        console.log(chalk.dim(`Project: ${session.projectName}`));
        console.log(chalk.dim(`Preview: ${session.preview.slice(0, 100)}...`));

        // Create a NEW session file (preserve original)
        const newSessionId = uuidv4();
        const sessionDir = path.dirname(session.filePath);
        const newFilePath = path.join(sessionDir, `${newSessionId}.jsonl`);

        console.log(chalk.dim(`Creating new session ${newSessionId.slice(0, 8)}...`));
        fs.copyFileSync(session.filePath, newFilePath);

        // Apply AI summarization by default
        if (options.summary !== false) {
          const cutoffPercent = parseInt(options.cutoff || '60', 10);
          console.log(chalk.dim(`Generating AI summary (cutoff: ${cutoffPercent}%)...`));

          const result = await summarizeSessionFile(newFilePath, {
            cutoffPercent,
            summaryProvider: options.summaryProvider,
            summaryModel: options.summaryModel,
            model: options.model,
            dryRun: options.dryRun,
            includeFileReads: options.fileReads === true,
          });

          if (options.dryRun) {
            printSummarizationResult(result, true);
            fs.unlinkSync(newFilePath);
            return;
          }

          printSummarizationResult(result);
        }

        // Update session ID in the new file
        const content = fs.readFileSync(newFilePath, 'utf-8');
        const updated = content.replace(new RegExp(session.sessionId, 'g'), newSessionId);
        fs.writeFileSync(newFilePath, updated);

        // Get project path and add to history
        const project = getProjectFromSessionFile(session.filePath);
        addToHistory(newSessionId, project, options.name || 'Forked session');
        console.log(chalk.dim(`Added to history for project: ${project}`));

        // Use project dir as working dir
        const workingDir = options.dir || project;

        resumeForkedSession(newSessionId, workingDir);
      }

      let sessionId: string | null = null;
      let filePath: string | null = null;

      if (options.session) {
        sessionId = options.session;
        filePath = findSessionFileById(sessionId);
        console.log(chalk.green(`Using session: ${sessionId}`));
      } else {
        // Use marker if provided, otherwise search for 'fork' command itself
        const searchMarker = marker || 'claude-tools fork';
        await new Promise(resolve => setTimeout(resolve, 2000));

        const result = await findSessionByMarker(searchMarker);
        if (!result) {
          console.log(chalk.red('Could not find current session.'));
          process.exit(1);
        }

        sessionId = result.sessionId;
        filePath = result.filePath;
        console.log(chalk.green(`Found session: ${sessionId}`));
      }

      if (!filePath) {
        console.log(chalk.red(`Could not find session file for: ${sessionId}`));
        process.exit(1);
      }

      // Always create a new session file for fork (so original is preserved)
      const newSessionId = uuidv4();
      const sessionDir = path.dirname(filePath);
      const newFilePath = path.join(sessionDir, `${newSessionId}.jsonl`);

      // Copy original to new file
      fs.copyFileSync(filePath, newFilePath);
      console.log(chalk.dim(`Created new session: ${newSessionId.slice(0, 8)}...`));

      // Summarization is enabled by default (unless --no-summary)
      if (options.summary !== false) {
        const cutoffPercent = parseInt(options.cutoff || '60', 10);
        console.log(chalk.dim(`Using AI summarization (cutoff: ${cutoffPercent}%)...`));

        const result = await summarizeSessionFile(newFilePath, {
          cutoffPercent,
          summaryProvider: options.summaryProvider,
          summaryModel: options.summaryModel,
          model: options.model,
          dryRun: options.dryRun,
          includeFileReads: options.fileReads === true,
        });

        if (options.dryRun) {
          printSummarizationResult(result, true);
          fs.unlinkSync(newFilePath);
          return;
        }

        printSummarizationResult(result);
      } else if (options.compact || options.dryRun) {
        // Simple progressive compaction
        const targetRatio = parseInt(options.target || '40', 10) / 100;

        const result = compactSession(newFilePath, {
          targetRatio,
          dryRun: options.dryRun,
          keepRetries: options.keepRetries,
        });

        if (options.dryRun) {
          printCompactResult(result, true);
          fs.unlinkSync(newFilePath);
          return;
        }

        printCompactResult(result);
      }

      // Update session ID in the new file
      updateSessionId(newFilePath, sessionId!, newSessionId);

      // Get project path and add to history
      const project = getProjectFromSessionFile(filePath);
      addToHistory(newSessionId, project, options.name || 'Forked session');
      console.log(chalk.dim(`Added to history for project: ${project}`));

      // Use project dir as working dir
      const workingDir = options.dir || project;

      resumeForkedSession(newSessionId, workingDir);
    });

  // Session ID lookup command
  program
    .command('session-id <marker>')
    .description('Find and print the session ID containing the marker')
    .action(async (marker: string) => {
      await new Promise(resolve => setTimeout(resolve, 500));

      const result = await findSessionByMarker(marker);

      if (result) {
        console.log(result.sessionId);
      } else {
        console.error('Session not found');
        process.exit(1);
      }
    });

  // Standalone compact command
  program
    .command('compact <session-id>')
    .description('Compact a session using progressive compaction or AI summarization')
    .option('--no-summary', 'Disable AI summarization (summary is enabled by default)')
    .option('--summary-provider <provider>', 'Summary provider: codex or claude')
    .option('--summary-model <model>', 'Provider-specific summary model override')
    .option('--model <model>', 'Legacy Claude-only summary model alias (implies Claude when used alone)')
    .option('--cutoff <percent>', 'Summarization cutoff percentage (default: 60)', '60')
    .option('--file-reads', 'Include fake Read tool calls for modified files in summary (disabled by default)')
    .option('--target <percent>', 'Target size for progressive compact (default: 40)', '40')
    .option('--keep-retries', 'Keep failed bash retries (default: remove them)')
    .option('--no-backup', 'Skip creating backup')
    .option('--dry-run', 'Show what would be compacted without making changes')
    .action(async (sessionId: string, options: {
      summary?: boolean;  // --no-summary sets this to false
      summaryProvider?: SummaryProvider;
      summaryModel?: string;
      model?: string;
      cutoff?: string;
      fileReads?: boolean;  // --no-file-reads sets this to false
      target?: string;
      keepRetries?: boolean;
      backup?: boolean;
      dryRun?: boolean;
    }) => {
      const filePath = findSessionFileById(sessionId);

      if (!filePath) {
        console.log(chalk.red(`Could not find session file for: ${sessionId}`));
        process.exit(1);
      }

      // Summarization is enabled by default (unless --no-summary)
      if (options.summary !== false) {
        const cutoffPercent = parseInt(options.cutoff || '60', 10);
        console.log(chalk.dim(`Using AI summarization (cutoff: ${cutoffPercent}%)...`));

        const result = await summarizeSessionFile(filePath, {
          cutoffPercent,
          summaryProvider: options.summaryProvider,
          summaryModel: options.summaryModel,
          model: options.model,
          dryRun: options.dryRun,
          includeFileReads: options.fileReads === true,
        });

        printSummarizationResult(result, options.dryRun);
        return;
      }

      // Progressive compaction mode
      const targetRatio = parseInt(options.target || '40', 10) / 100;

      // Create backup unless disabled or dry run
      if (!options.dryRun && options.backup !== false) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const backupPath = filePath.replace('.jsonl', `.backup-${timestamp}.jsonl`);
        fs.copyFileSync(filePath, backupPath);
        console.log(chalk.dim(`Backup: ${backupPath}`));
      }

      console.log(chalk.dim(`Compacting session ${sessionId} (target: ${Math.round(targetRatio * 100)}%)...`));

      const result = compactSession(filePath, {
        targetRatio,
        dryRun: options.dryRun,
        keepRetries: options.keepRetries,
      });

      printCompactResult(result, options.dryRun);
    });

  // Current session ID command - searches for itself in recent JSONL files
  program
    .command('current-session')
    .description('Get the current session ID (searches for this command in recent sessions)')
    .action(async () => {
      // Small delay to ensure command is written to JSONL
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Find the session with the most recent 'current-session' marker
      const result = await findSessionByMarker('current-session');

      if (result) {
        console.log(result.sessionId);
      } else {
        console.error('Could not find current session');
        process.exit(1);
      }
    });
}
