// Resume command - search and resume Claude sessions with grep-style OR patterns

import { Command } from 'commander';
import { render } from 'ink';
import React from 'react';
import chalk from 'chalk';
import { spawnSync } from 'child_process';
import ResumeApp, { ResumeResult } from './App.js';

export function registerResumeCommands(program: Command): void {
  program
    .command('resume [pattern]')
    .description('Search and resume Claude sessions with grep-style OR patterns')
    .addHelpText('after', `
${chalk.yellow('Pattern Syntax:')}
  Use ${chalk.cyan('|')} for OR matching (grep-style):
    ${chalk.dim('api|auth')}        - matches sessions with "api" OR "auth"
    ${chalk.dim('bug|fix|error')}   - matches sessions with any of these words

  Space-separated words within an OR group are AND:
    ${chalk.dim('api auth')}        - matches sessions with "api" AND "auth"
    ${chalk.dim('api auth|bug fix')} - matches (api AND auth) OR (bug AND fix)

${chalk.yellow('Examples:')}
  ${chalk.dim('# Interactive mode (browse all sessions)')}
  claude-tools resume

  ${chalk.dim('# Pre-filter with pattern')}
  claude-tools resume "telegram|jira"

  ${chalk.dim('# Search for specific feature work')}
  claude-tools resume "auth login|session token"

${chalk.yellow('Navigation:')}
  ${chalk.dim('[↑↓]')}     Navigate sessions
  ${chalk.dim('[Enter]')}  Resume selected session
  ${chalk.dim('[Esc]')}    Quit
  ${chalk.dim('[Type]')}   Filter sessions (use | for OR)
`)
    .action(async (pattern: string | undefined) => {
      let resumeResult: ResumeResult | null = null;
      const { waitUntilExit } = render(React.createElement(ResumeApp, {
        initialFilter: pattern || '',
        onDone: (result: ResumeResult) => { resumeResult = result; },
      }));

      // Wait for Ink to fully unmount — stdin is completely released after this.
      await waitUntilExit();

      if (resumeResult) {
        const { sessionId, cwd } = resumeResult;
        const claudeArgs = ['--dangerously-skip-permissions', '--resume', sessionId];
        const result = spawnSync('claude', claudeArgs, {
          stdio: 'inherit',
          shell: true,
          cwd,
        });
        process.exit(result.status || 0);
      }
    });
}
