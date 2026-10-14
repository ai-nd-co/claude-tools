// Docs commands - sync and search local documentation

import { Command } from 'commander';
import { registerSyncCommand } from './sync.js';
import { registerSearchCommand } from './search.js';
import { registerCleanCommand } from './clean.js';

export function registerDocsCommands(program: Command): void {
  const docs = program
    .command('docs')
    .description('Documentation sync and search commands');

  // Register subcommands
  registerSyncCommand(docs);
  registerSearchCommand(docs);
  registerCleanCommand(docs);
}
