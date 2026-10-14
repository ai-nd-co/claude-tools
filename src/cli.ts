#!/usr/bin/env node

// Handle GramJS async errors early - before any imports can trigger them
// GramJS throws "Request not set yet" on disconnect which is not a real error
process.on('unhandledRejection', (err: any) => {
  const errMsg = err?.message || String(err);
  // Suppress GramJS internal errors
  if (errMsg.includes('Request not set yet') ||
      errMsg.includes('TIMEOUT') ||
      errMsg.includes('CONNECTION_')) {
    return;
  }
  // Let other errors through to default handler
  console.error('Unhandled rejection:', errMsg);
  process.exit(1);
});

import { Command } from 'commander';
import chalk from 'chalk';
import { registerSpawnCommands } from './commands/spawn/index.js';
import { registerTelegramCommands } from './commands/telegram/index.js';
import { registerJiraCommands } from './commands/jira/index.js';
import { registerAsanaCommands } from './commands/asana/index.js';
import { registerContextCommands } from './commands/context/index.js';
import { registerDocsCommands } from './commands/docs/index.js';
import { registerForkCommands } from './commands/fork/index.js';
import { registerResumeCommands } from './commands/resume/index.js';
import { registerEditCommands } from './commands/edit/index.js';
import { registerStartupCommands } from './commands/startup/index.js';
import { registerTranscribeCommand } from './commands/transcribe/index.js';
import { registerUsageCommands } from './commands/usage/index.js';
import { registerBrowserCommands } from './commands/browser/index.js';
import { registerCodexCommands } from './commands/codex/index.js';
import { registerBotCommands } from './commands/telegram-bot/index.js';
import { registerHubCommands } from './commands/hub/index.js';
import { registerChannelCommands } from './commands/channel/index.js';
import { registerGithubCommands } from './commands/github/index.js';
import { registerGmailCommands } from './commands/gmail/index.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const program = new Command();

const DESCRIPTION = `
${chalk.bold('Claude Tools')} - Multi-purpose CLI for Claude Code workflows

${chalk.yellow('COMMANDS:')}
  ${chalk.cyan('spawn')}       Spawn Claude sessions with custom window titles
  ${chalk.cyan('fork')}        Fork current session to a new window
  ${chalk.cyan('resume')}      Search and resume sessions (grep-style | for OR)
  ${chalk.cyan('edit')}        Interactive session editor
  ${chalk.cyan('startup')}     Reopen recent work sessions
  ${chalk.cyan('list')}        List spawned tasks
  ${chalk.cyan('cleanup')}     Remove task records
  ${chalk.cyan('telegram')}    Telegram messaging (read, send, search)
  ${chalk.cyan('jira')}        Jira issue management (list, create, update)
  ${chalk.cyan('asana')}       Asana tasks (list, show, create, update, move)
  ${chalk.cyan('context')}     Export multi-source context events
  ${chalk.cyan('docs')}        Documentation sync and search
  ${chalk.cyan('transcribe')} Speech-to-text transcription (via Wispr Flow)
  ${chalk.cyan('usage')}      Analyze token usage and estimate API costs
  ${chalk.cyan('browser')}    Chrome tab control via extension bridge
  ${chalk.cyan('codex')}      Codex session utilities (compaction, listing)
  ${chalk.cyan('hub')}        Agent hub: watch, send, status, roster, log
  ${chalk.cyan('github')}     GitHub notification inbox watcher (via the gh login)
  ${chalk.cyan('gmail')}      Gmail new-mail watcher and counter, read-only over IMAP

${chalk.yellow('CONFIGURATION:')}
  Secrets: ${chalk.dim('~/.config/claude-tools/secrets.json')} (or %APPDATA%\\claude-tools\\secrets.json on Windows)
  Project: ${chalk.dim('.claude-tools.json')} in project root

${chalk.yellow('EXAMPLES:')}
  ${chalk.dim('# Spawn Claude session')}
  claude-tools spawn --name "Code Review"

  ${chalk.dim('# Read Telegram messages')}
  claude-tools telegram read

  ${chalk.dim('# List Jira issues')}
  claude-tools jira list PROJ

  ${chalk.dim('# Create Jira issue')}
  claude-tools jira create "Fix login bug" --project PROJ

Use ${chalk.cyan('claude-tools <command> --help')} for more information on a command.
`;

program
  .name('claude-tools')
  .description(DESCRIPTION)
  // Subcommands inherit this, so a near-miss flag says what was meant instead of only what
  // was wrong. Two agents in the ISSUE-60 hub validation lost time to a bare
  // `unknown option '--agent'` on a command that accepted `--as`.
  .showSuggestionAfterError(true)
  // The package's own version, so a session can tell which shared build it is running (a dist swap changes it
  // under every running track): `--version` printed a fixed 1.0.0 before.
  .version(packageVersion());

// Register command groups
registerSpawnCommands(program);
registerForkCommands(program);
registerResumeCommands(program);
registerEditCommands(program);
registerStartupCommands(program);
registerTelegramCommands(program);
registerJiraCommands(program);
registerAsanaCommands(program);
registerContextCommands(program);
registerDocsCommands(program);
registerTranscribeCommand(program);
registerUsageCommands(program);
registerBrowserCommands(program);
registerCodexCommands(program);
registerBotCommands(program);
registerHubCommands(program);
registerChannelCommands(program);
registerGithubCommands(program);
registerGmailCommands(program);

// Show help if no command
if (process.argv.length === 2) {
  program.help();
}

program.parse();

/**
 * The build's version. First `VERSION` inside `dist/` itself, which the shared install writes from the package.json
 * the build was made from: the installed dist sits in a checkout whose package.json may be another branch's (the
 * shared one is master's, while the dist is built from the dist branch), so the file beside `dist/` can name the wrong
 * build. Not written by `npm run build`, so an npm package (whose version is bumped AFTER its build) never carries a
 * stale one and reads its own package.json, as before. Then that package.json, then "unknown".
 */
function packageVersion(): string {
  try {
    const baked = readFileSync(fileURLToPath(new URL('./VERSION', import.meta.url)), 'utf8').trim();
    if (baked !== '') return baked;
  } catch {
    // Not installed through the procedure that writes it: fall back.
  }
  try {
    const raw = readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8');
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof version === 'string' ? version : 'unknown';
  } catch {
    return 'unknown';
  }
}
