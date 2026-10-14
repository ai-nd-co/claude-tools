/**
 * Usage command - analyze Claude Code token usage and costs
 */

import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Anthropic Opus 4.5 pricing (as of 2026)
const OPUS_4_5_PRICING = {
  input: 5.00,      // $5 per 1M input tokens
  output: 25.00,    // $25 per 1M output tokens
  cacheWrite: 6.25, // $6.25 per 1M cache write tokens (25% more than input)
  cacheRead: 0.50,  // $0.50 per 1M cache read tokens (90% less than input)
};

// Legacy Opus 4.1 pricing (for comparison)
const OPUS_4_1_PRICING = {
  input: 15.00,
  output: 75.00,
  cacheWrite: 18.75,
  cacheRead: 1.50,
};

interface UsageData {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface Message {
  type: string;
  timestamp?: string;
  requestId?: string;
  message?: {
    usage?: UsageData;
  };
}

interface ConversationStats {
  sessionId: string;
  filePath: string;
  messageCount: number;
  apiCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  startTime?: string;
  endTime?: string;
}

function analyzeConversation(filePath: string): ConversationStats | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());

    const sessionId = path.basename(filePath, '.jsonl');
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheWriteTokens = 0;
    let cacheReadTokens = 0;
    let apiCalls = 0;
    let startTime: string | undefined;
    let endTime: string | undefined;
    const seenRequestIds = new Set<string>();

    for (const line of lines) {
      try {
        const msg = JSON.parse(line) as Message;

        if (msg.timestamp) {
          if (!startTime || msg.timestamp < startTime) startTime = msg.timestamp;
          if (!endTime || msg.timestamp > endTime) endTime = msg.timestamp;
        }

        // Deduplicate by requestId - Claude Code logs multiple entries per API call
        if (msg.type === 'assistant' && msg.message?.usage && msg.requestId) {
          if (seenRequestIds.has(msg.requestId)) continue;
          seenRequestIds.add(msg.requestId);

          apiCalls++;
          const usage = msg.message.usage;

          inputTokens += usage.input_tokens || 0;
          outputTokens += usage.output_tokens || 0;
          cacheWriteTokens += usage.cache_creation_input_tokens || 0;
          cacheReadTokens += usage.cache_read_input_tokens || 0;
        }
      } catch {
        // Skip invalid JSON
      }
    }

    return {
      sessionId,
      filePath,
      messageCount: lines.length,
      apiCalls,
      inputTokens,
      outputTokens,
      cacheWriteTokens,
      cacheReadTokens,
      startTime,
      endTime,
    };
  } catch {
    return null;
  }
}

function calculateCost(stats: ConversationStats, pricing = OPUS_4_5_PRICING): number {
  return (
    (stats.inputTokens / 1_000_000) * pricing.input +
    (stats.outputTokens / 1_000_000) * pricing.output +
    (stats.cacheWriteTokens / 1_000_000) * pricing.cacheWrite +
    (stats.cacheReadTokens / 1_000_000) * pricing.cacheRead
  );
}

function formatNumber(num: number): string {
  return num.toLocaleString();
}

function getProjectDirs(): string[] {
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(claudeDir)) return [];

  return fs.readdirSync(claudeDir)
    .filter(f => fs.statSync(path.join(claudeDir, f)).isDirectory())
    .map(f => path.join(claudeDir, f));
}

export function registerUsageCommands(program: Command): void {
  program
    .command('usage')
    .description('Analyze Claude Code token usage and estimate API costs')
    .option('--project <name>', 'Filter by project name (partial match)')
    .option('--days <n>', 'Only analyze last N days', '30')
    .option('--top <n>', 'Show top N conversations by cost', '10')
    .option('--monthly', 'Show monthly breakdown')
    .option('--json', 'Output as JSON')
    .addHelpText('after', `
${chalk.yellow('Examples:')}
  ${chalk.dim('# Analyze all usage')}
  claude-tools usage

  ${chalk.dim('# Last 7 days only')}
  claude-tools usage --days 7

  ${chalk.dim('# Filter by project')}
  claude-tools usage --project your-project

  ${chalk.dim('# Show monthly breakdown')}
  claude-tools usage --monthly
`)
    .action((options: {
      project?: string;
      days?: string;
      top?: string;
      monthly?: boolean;
      json?: boolean;
    }) => {
      const projectDirs = getProjectDirs();
      const days = parseInt(options.days || '30', 10);
      const topN = parseInt(options.top || '10', 10);
      const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

      let allFiles: string[] = [];

      for (const dir of projectDirs) {
        if (options.project && !dir.toLowerCase().includes(options.project.toLowerCase())) {
          continue;
        }

        const files = fs.readdirSync(dir)
          .filter(f => f.endsWith('.jsonl') && !f.includes('.backup'))
          .map(f => path.join(dir, f));

        allFiles = allFiles.concat(files);
      }

      if (!options.json) {
        console.log(chalk.bold('Claude Code Token Usage Analysis'));
        console.log('='.repeat(70));
        console.log(`Analyzing ${allFiles.length} conversation files (last ${days} days)\n`);
      }

      const allStats: ConversationStats[] = [];

      for (const file of allFiles) {
        const stats = analyzeConversation(file);
        if (stats && stats.apiCalls > 0) {
          // Filter by date
          if (stats.startTime && stats.startTime >= cutoffDate) {
            allStats.push(stats);
          }
        }
      }

      // Sort by cost descending
      allStats.sort((a, b) => calculateCost(b) - calculateCost(a));

      // Calculate totals
      const totals = allStats.reduce((acc, s) => ({
        inputTokens: acc.inputTokens + s.inputTokens,
        outputTokens: acc.outputTokens + s.outputTokens,
        cacheWriteTokens: acc.cacheWriteTokens + s.cacheWriteTokens,
        cacheReadTokens: acc.cacheReadTokens + s.cacheReadTokens,
        apiCalls: acc.apiCalls + s.apiCalls,
      }), { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, apiCalls: 0 });

      const totalCost =
        (totals.inputTokens / 1_000_000) * OPUS_4_5_PRICING.input +
        (totals.outputTokens / 1_000_000) * OPUS_4_5_PRICING.output +
        (totals.cacheWriteTokens / 1_000_000) * OPUS_4_5_PRICING.cacheWrite +
        (totals.cacheReadTokens / 1_000_000) * OPUS_4_5_PRICING.cacheRead;

      const avgCost = allStats.length > 0 ? totalCost / allStats.length : 0;

      if (options.json) {
        const output = {
          period: { days, cutoffDate },
          conversations: allStats.length,
          apiCalls: totals.apiCalls,
          tokens: {
            input: totals.inputTokens,
            output: totals.outputTokens,
            cacheWrite: totals.cacheWriteTokens,
            cacheRead: totals.cacheReadTokens,
          },
          cost: {
            total: parseFloat(totalCost.toFixed(2)),
            average: parseFloat(avgCost.toFixed(2)),
          },
          pricing: OPUS_4_5_PRICING,
          topConversations: allStats.slice(0, topN).map(s => ({
            sessionId: s.sessionId,
            apiCalls: s.apiCalls,
            cost: parseFloat(calculateCost(s).toFixed(2)),
            startTime: s.startTime,
          })),
        };
        console.log(JSON.stringify(output, null, 2));
        return;
      }

      // Top conversations
      console.log(`Top ${topN} Conversations by Cost:`);
      console.log('-'.repeat(90));
      console.log(
        'Session ID'.padEnd(40) +
        'API Calls'.padStart(12) +
        'Output'.padStart(12) +
        'Cache Write'.padStart(15) +
        'Cost'.padStart(12)
      );
      console.log('-'.repeat(90));

      for (const stats of allStats.slice(0, topN)) {
        const cost = calculateCost(stats);
        console.log(
          stats.sessionId.slice(0, 36).padEnd(40) +
          formatNumber(stats.apiCalls).padStart(12) +
          formatNumber(stats.outputTokens).padStart(12) +
          formatNumber(stats.cacheWriteTokens).padStart(15) +
          `$${cost.toFixed(2)}`.padStart(12)
        );
      }

      // Totals
      console.log('\n' + '='.repeat(70));
      console.log(chalk.bold('TOTALS'));
      console.log('='.repeat(70));
      console.log(`Conversations: ${allStats.length}`);
      console.log(`API Calls:     ${formatNumber(totals.apiCalls)}`);
      console.log(`\nTokens:`);
      console.log(`  Input:       ${formatNumber(totals.inputTokens)}`);
      console.log(`  Output:      ${formatNumber(totals.outputTokens)}`);
      console.log(`  Cache Write: ${formatNumber(totals.cacheWriteTokens)}`);
      console.log(`  Cache Read:  ${formatNumber(totals.cacheReadTokens)}`);

      console.log(`\n${chalk.bold('Cost Breakdown')} (Opus 4.5 @ $5/$25 per 1M):`);
      console.log(`  Input:       $${((totals.inputTokens / 1_000_000) * OPUS_4_5_PRICING.input).toFixed(2)}`);
      console.log(`  Output:      $${((totals.outputTokens / 1_000_000) * OPUS_4_5_PRICING.output).toFixed(2)}`);
      console.log(`  Cache Write: $${((totals.cacheWriteTokens / 1_000_000) * OPUS_4_5_PRICING.cacheWrite).toFixed(2)}`);
      console.log(`  Cache Read:  $${((totals.cacheReadTokens / 1_000_000) * OPUS_4_5_PRICING.cacheRead).toFixed(2)}`);
      console.log(chalk.green(`  TOTAL:       $${totalCost.toFixed(2)}`));
      console.log(`\nAverage per conversation: $${avgCost.toFixed(2)}`);

      // Monthly breakdown
      if (options.monthly) {
        console.log('\n' + '='.repeat(70));
        console.log(chalk.bold('MONTHLY BREAKDOWN'));
        console.log('='.repeat(70));

        const byMonth = new Map<string, { conversations: number; cost: number; apiCalls: number }>();

        for (const stats of allStats) {
          if (!stats.startTime) continue;
          const date = new Date(stats.startTime);
          const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

          const existing = byMonth.get(monthKey) || { conversations: 0, cost: 0, apiCalls: 0 };
          existing.conversations++;
          existing.cost += calculateCost(stats);
          existing.apiCalls += stats.apiCalls;
          byMonth.set(monthKey, existing);
        }

        const sortedMonths = Array.from(byMonth.entries()).sort((a, b) => a[0].localeCompare(b[0]));

        console.log('\n' + 'Month'.padEnd(12) + 'Conv'.padStart(10) + 'API Calls'.padStart(12) + 'API Cost'.padStart(15) + 'vs Max $200'.padStart(15));
        console.log('-'.repeat(64));

        for (const [month, data] of sortedMonths) {
          const diff = data.cost - 200;
          const diffStr = diff > 0
            ? chalk.green(`+$${diff.toFixed(0)} saved`)
            : chalk.red(`-$${Math.abs(diff).toFixed(0)} under`);

          console.log(
            month.padEnd(12) +
            data.conversations.toString().padStart(10) +
            formatNumber(data.apiCalls).padStart(12) +
            `$${data.cost.toFixed(2)}`.padStart(15) +
            diffStr.padStart(25)
          );
        }
      }

      // Max plan comparison
      console.log('\n' + '='.repeat(70));
      console.log(chalk.bold('MAX PLAN COMPARISON'));
      console.log('='.repeat(70));
      const maxPlanCost = 200 * Math.ceil(days / 30);
      const savings = totalCost - maxPlanCost;
      if (savings > 0) {
        console.log(chalk.green(`Max plan saves you: $${savings.toFixed(2)} over ${days} days`));
        console.log(chalk.green(`That's ${((savings / totalCost) * 100).toFixed(0)}% savings vs API pricing`));
      } else {
        console.log(chalk.yellow(`API pricing would cost $${Math.abs(savings).toFixed(2)} less for this period`));
      }
    });
}
