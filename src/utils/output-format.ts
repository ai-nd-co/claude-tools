// Shared output format utilities for consistent CLI output across commands

import chalk from 'chalk';

export type OutputFormat = 'title' | 'compact' | 'verbose' | 'json';

/**
 * Parse --format option with backward compatibility for --json and -v/--verbose
 */
export function resolveFormat(options: {
  format?: string;
  json?: boolean;
  verbose?: boolean;
}, defaultFormat: OutputFormat): OutputFormat {
  // Explicit --format takes precedence
  if (options.format) {
    const f = options.format.toLowerCase();
    if (f === 'title' || f === 'compact' || f === 'verbose' || f === 'json') {
      return f;
    }
    console.error(chalk.yellow(`Unknown format "${options.format}", using ${defaultFormat}`));
    return defaultFormat;
  }

  // Backward compatibility
  if (options.json) return 'json';
  if (options.verbose) return 'verbose';

  return defaultFormat;
}

/**
 * Add --format option to a command with help text
 */
export function formatOptionHelp(): string {
  return '--format <type>: title (key+title), compact (one-line), verbose (full), json';
}
