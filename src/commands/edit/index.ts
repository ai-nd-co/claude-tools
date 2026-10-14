// Interactive session editor command

import { Command } from 'commander';
import { render } from 'ink';
import React from 'react';
import chalk from 'chalk';
import * as os from 'os';
import App from './App.js';
import { findSessionFile, findSessionByMarker } from './session.js';
import { getOrchestrator } from '../../services/orchestrator.js';

export function registerEditCommands(program: Command): void {
  program
    .command('edit [marker]')
    .description('Interactively edit a Claude session (compact/remove messages)')
    .option('--interactive', 'Launch in a new interactive window')
    .option('--session <id>', 'Directly specify session ID (skip marker search)')
    .addHelpText('after', `
${chalk.yellow('Usage:')}
  claude-tools edit <marker>                Find session by marker
  claude-tools edit --session <session-id>  Use session ID directly

${chalk.yellow('Controls:')}
  ${chalk.dim('[↑↓]')}     Navigate through messages
  ${chalk.dim('[c]')}       Mark message for compact (truncate large content)
  ${chalk.dim('[d]')}       Mark message for delete
  ${chalk.dim('[p]')}       Progressive compact to 40% (aggressive at start, preserves end)
  ${chalk.dim('[u]')}       Undo mark on current message
  ${chalk.dim('[v]')}       View full message content
  ${chalk.dim('[Enter]')}   Apply changes (creates backup first)
  ${chalk.dim('[f]')}       Apply and fork to new window
  ${chalk.dim('[q]')}       Quit without saving

${chalk.yellow('Visual indicators:')}
  ${chalk.dim('◯')}  Unchanged
  ${chalk.yellow('◉')}  Marked for compact
  ${chalk.red('✗')}  Marked for delete
  ${chalk.blue('Σ')}  Marked for summarize
  ${chalk.dim('⚠️')}  Large message (top 10% by size)

${chalk.yellow('Examples:')}
  claude-tools edit 1766797630431919700 --interactive
  claude-tools edit --session ad1a0958-208c-4ab3-abbe-a9bf64c328bb
`)
    .action(async (marker: string | undefined, options: { interactive?: boolean; session?: string }) => {
      let sessionId: string | null = null;
      let filePath: string | null = null;

      if (options.session) {
        sessionId = options.session;
        filePath = findSessionFile(sessionId);
        console.log(chalk.green(`Using session: ${sessionId}`));
      } else {
        // Use marker if provided, otherwise search for 'edit' command itself
        const searchMarker = marker || 'claude-tools edit';
        // Wait for Claude to flush JSONL to disk
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
        console.log(chalk.red(`Session file not found: ${sessionId}`));
        process.exit(1);
      }

      if (options.interactive) {
        // Launch in new window
        const orchestrator = await getOrchestrator();
        const platform = os.platform();
        let commandLine: string;
        if (platform === 'win32') {
          commandLine = `cmd.exe /K node "${process.cwd()}/repos/claude-tools/dist/cli.js" edit --session ${sessionId}`;
        } else {
          commandLine = `node "${process.cwd()}/repos/claude-tools/dist/cli.js" edit --session ${sessionId}`;
        }
        const { taskId, pid } = await orchestrator.spawnTaskWithCommand(commandLine, {
          name: `Edit ${sessionId!.slice(0, 8)}`,
          workingDir: process.cwd(),
        });
        console.log(`${chalk.green('Launched:')} Task ${chalk.cyan(taskId)}, PID: ${chalk.yellow(pid || 'N/A')}`);
        return;
      }

      // Render the Ink app
      render(React.createElement(App, { sessionId: sessionId!, filePath }));
    });
}
