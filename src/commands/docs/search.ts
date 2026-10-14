// Docs search command - FTS5 and semantic search in local database

import { Command } from 'commander';
import chalk from 'chalk';
import { searchDocs, listDocs, hasDocs, getDatabaseStats, type DocsSearchResult } from '../../services/docs-search.js';
import {
  searchDocsSemantic,
  isDocsSemanticAvailable,
  type DocsSemanticSearchResult,
} from '../../services/docs-semantic.js';
import { resolveFormat, type OutputFormat } from '../../utils/output-format.js';

export function registerSearchCommand(docs: Command): void {
  docs
    .command('search [query]')
    .description('Search documentation (offline, fast)')
    .option('--type <type>', 'Filter by type (docs, tasks)')
    .option('--limit <n>', 'Number of results', '20')
    .option('--fuzzy', 'Enable fuzzy (prefix) matching')
    .option('--semantic', 'Force semantic search (vector similarity)')
    .option('--keyword', 'Force keyword search (FTS)')
    .option('--format <type>', 'Output format: title, compact, verbose, json (default: verbose)')
    .option('--verbose', 'Shorthand for --format=verbose')
    .option('--json', 'Shorthand for --format=json')
    .addHelpText('after', `
${chalk.yellow('Examples:')}
  ${chalk.dim('# Search for "protected range"')}
  claude-tools docs search "protected range"

  ${chalk.dim('# List all docs (no query)')}
  claude-tools docs search

  ${chalk.dim('# Search only in tasks')}
  claude-tools docs search "fix" --type tasks

  ${chalk.dim('# Fuzzy prefix matching')}
  claude-tools docs search "protect" --fuzzy

  ${chalk.dim('# Force semantic search')}
  claude-tools docs search "how do events work" --semantic

  ${chalk.dim('# Force keyword search')}
  claude-tools docs search "protected range" --keyword

  ${chalk.dim('# Verbose output')}
  claude-tools docs search "auth" --verbose

${chalk.yellow('Note:')}
  Run ${chalk.cyan('claude-tools docs sync')} first to index documents.
`)
    .action(async (query: string | undefined, options: {
      type?: string;
      limit: string;
      fuzzy?: boolean;
      semantic?: boolean;
      keyword?: boolean;
      format?: string;
      verbose?: boolean;
      json?: boolean;
    }) => {
      const format = resolveFormat(options, 'verbose');

      // Check if we have any docs
      if (!hasDocs()) {
        console.log(chalk.yellow('\n⚠️  No documents synced yet.'));
        console.log(chalk.dim('Run: claude-tools docs sync'));
        return;
      }

      const limit = parseInt(options.limit, 10);
      const searchQuery = query || '';

      try {
        const startTime = performance.now();

        // Determine search mode
        let useSemanticSearch = false;

        if (options.semantic) {
          const status = await isDocsSemanticAvailable();
          if (!status.available) {
            console.log(chalk.yellow('Semantic search not available:'), status.reason);
            return;
          }
          useSemanticSearch = true;
        } else if (!options.keyword && searchQuery) {
          // Auto-select semantic if available (unless --keyword forces FTS)
          const status = await isDocsSemanticAvailable();
          useSemanticSearch = status.available;
        }

        // Semantic search path
        if (useSemanticSearch && searchQuery) {
          const results = await searchDocsSemantic(searchQuery, options.type, limit);
          const duration = (performance.now() - startTime).toFixed(0);

          if (format === 'json') {
            console.log(JSON.stringify({
              query: searchQuery,
              mode: 'semantic',
              options: { type: options.type },
              totalCount: results.length,
              results: results.map(r => ({
                path: r.chunk.path,
                title: r.chunk.title,
                heading: r.chunk.heading,
                content: r.chunk.content.slice(0, 200),
                similarity: r.similarity,
              })),
            }, null, 2));
            return;
          }

          printSemanticResults(searchQuery, results, duration, format);
          return;
        }

        // FTS search path
        const response = searchQuery
          ? searchDocs(searchQuery, {
              type: options.type,
              limit,
              fuzzy: options.fuzzy,
            })
          : listDocs({
              type: options.type,
              limit,
            });

        const duration = (performance.now() - startTime).toFixed(0);

        if (format === 'json') {
          console.log(JSON.stringify({
            query: searchQuery || null,
            mode: 'keyword',
            options: {
              type: options.type,
              fuzzy: options.fuzzy,
            },
            totalCount: response.totalCount,
            page: response.page,
            perPage: response.perPage,
            results: response.results.map(r => ({
              path: r.path,
              title: r.title,
              heading: r.heading,
              content: r.content.slice(0, 200),
            })),
          }, null, 2));
          return;
        }

        // Display results
        if (response.results.length === 0) {
          if (searchQuery) {
            console.log(chalk.dim(`\n🔍 No results for "${searchQuery}"`));
          } else {
            console.log(chalk.dim('\nNo documents found with current filters'));
          }
          return;
        }

        // Header
        if (searchQuery) {
          console.log(`\n🔍 "${chalk.bold(searchQuery)}" ${chalk.dim(`(${response.totalCount} matches in ${duration}ms)`)}`);
        } else {
          console.log(`\n📋 ${chalk.bold('Documents')} ${chalk.dim(`(${response.totalCount} total in ${duration}ms)`)}`);
        }

        // Output based on format
        console.log();
        for (const result of response.results) {
          if (format === 'verbose') {
            printResultVerbose(result);
            console.log();
          } else if (format === 'compact') {
            printResultCompact(result);
          } else {
            // title mode (default)
            printResultTitle(result);
          }
        }

        // Pagination info
        if (response.totalPages > 1) {
          console.log(chalk.dim(`\nPage ${response.page} of ${response.totalPages}`));
        }
      } catch (err) {
        console.error(chalk.red('Error:'), (err as Error).message);
        process.exit(1);
      }
    });

  // Add stats command for database info
  docs
    .command('stats')
    .description('Show local database statistics')
    .action(() => {
      if (!hasDocs()) {
        console.log(chalk.yellow('\n⚠️  No documents synced yet.'));
        console.log(chalk.dim('Run: claude-tools docs sync'));
        return;
      }

      const stats = getDatabaseStats();

      console.log(chalk.bold('\n📊 Docs Database Stats\n'));
      console.log(`Total documents: ${chalk.cyan(stats.totalDocs.toLocaleString())}`);
      console.log(`Total chunks: ${chalk.cyan(stats.totalChunks.toLocaleString())}`);

      if (stats.oldestIndexed && stats.newestIndexed) {
        console.log(`Indexed range: ${formatDate(stats.oldestIndexed)} - ${formatDate(stats.newestIndexed)}`);
      }

      if (stats.typeBreakdown.length > 0) {
        console.log(chalk.bold('\nType breakdown:'));
        for (const { type, count } of stats.typeBreakdown) {
          const bar = '█'.repeat(Math.min(20, Math.round(count / stats.totalDocs * 20)));
          console.log(`  ${type.padEnd(10)} ${chalk.cyan(count.toString().padStart(5))} ${chalk.dim(bar)}`);
        }
      }
    });
}

function printResultTitle(result: DocsSearchResult): void {
  const heading = result.heading ? ` > ${result.heading}` : '';
  const lineInfo = result.language && result.startLine ? `:${result.startLine}` : '';
  console.log(`  ${chalk.cyan(result.path)}${chalk.dim(lineInfo)}${chalk.dim(heading)}`);
}

function printResultCompact(result: DocsSearchResult): void {
  const type = result.type.padEnd(5);
  const heading = result.heading ? ` [${result.heading.slice(0, 20)}]` : '';
  const preview = result.content.slice(0, 60).replace(/\n/g, ' ');
  const lang = result.language ? chalk.magenta(`[${result.language}]`) : '';

  console.log(
    `  ${chalk.dim(type)} ${chalk.cyan(result.path.slice(0, 35).padEnd(35))}${chalk.dim(heading)} ${lang}`
  );
  console.log(`       ${chalk.dim(preview)}...`);
}

function printResultVerbose(result: DocsSearchResult): void {
  const langBadge = result.language ? chalk.magenta(` [${result.language}]`) : '';
  console.log(`${chalk.cyan(result.path)}${langBadge} ${chalk.dim(`(${result.type})`)}`);
  console.log(`  ${chalk.bold(result.title)}`);
  if (result.heading) {
    console.log(`  ${result.language ? 'Function:' : 'Section:'} ${result.heading}`);
  }
  if (result.startLine && result.endLine) {
    console.log(`  Lines: ${result.startLine}-${result.endLine}`);
  }

  // For code, show the actual code (not flattened)
  if (result.language) {
    const lines = result.content.split('\n').slice(0, 10);
    console.log();
    for (const line of lines) {
      console.log(chalk.dim(`    ${line}`));
    }
    if (result.content.split('\n').length > 10) {
      console.log(chalk.dim('    ...'));
    }
  } else {
    const preview = result.content.slice(0, 300).replace(/\n/g, ' ');
    console.log();
    console.log(chalk.dim(`    ${preview}${result.content.length > 300 ? '...' : ''}`));
  }
  console.log(chalk.dim('  ---'));
}

function printSemanticResults(
  query: string,
  results: DocsSemanticSearchResult[],
  duration: string,
  format: OutputFormat
): void {
  console.log(
    chalk.bold(`\n"${query}"`) +
    chalk.dim(` (${results.length} semantic matches in ${duration}ms)`)
  );

  if (results.length === 0) {
    console.log(chalk.dim('No results. Try: docs sync'));
    return;
  }

  console.log();
  for (const { chunk, similarity } of results) {
    const sim = (similarity * 100).toFixed(0) + '%';

    if (format === 'verbose') {
      const langBadge = chunk.language ? chalk.magenta(` [${chunk.language}]`) : '';
      console.log(`${chalk.cyan(chunk.path)}${langBadge} ${chalk.dim(`(${chunk.type})`)} ${chalk.yellow(sim)}`);
      console.log(`  ${chalk.bold(chunk.title)}`);
      if (chunk.heading) {
        console.log(`  ${chunk.language ? 'Function:' : 'Section:'} ${chunk.heading}`);
      }
      if (chunk.start_line && chunk.end_line) {
        console.log(`  Lines: ${chunk.start_line}-${chunk.end_line}`);
      }

      // For code, show the actual code (not flattened)
      if (chunk.language) {
        const lines = chunk.content.split('\n').slice(0, 15);
        console.log();
        for (const line of lines) {
          console.log(chalk.dim(`    ${line}`));
        }
        if (chunk.content.split('\n').length > 15) {
          console.log(chalk.dim('    ...'));
        }
      } else {
        const preview = chunk.content.slice(0, 300).replace(/\n/g, ' ');
        console.log();
        console.log(chalk.dim(`    ${preview}${chunk.content.length > 300 ? '...' : ''}`));
      }
      console.log(chalk.dim('  ---'));
    } else if (format === 'compact') {
      const heading = chunk.heading ? ` [${chunk.heading.slice(0, 20)}]` : '';
      const preview = chunk.content.slice(0, 50).replace(/\n/g, ' ');
      console.log(
        `  ${chalk.yellow(sim.padStart(4))} ${chalk.cyan(chunk.path.slice(0, 40).padEnd(40))}${chalk.dim(heading)}`
      );
      console.log(`       ${chalk.dim(preview)}...`);
    } else {
      // title mode
      const heading = chunk.heading ? ` > ${chunk.heading}` : '';
      console.log(`  ${chalk.cyan(chunk.path)}${chalk.dim(heading)} ${chalk.yellow(`(${sim})`)}`);
    }
  }
}

function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
  });
}
