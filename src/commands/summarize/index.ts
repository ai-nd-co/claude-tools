/**
 * Summarize command - summarizes any markdown file using Codex by default
 */

import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import { summarizeText, SummaryProvider } from '../../utils/summary-provider.js';

const DEFAULT_TIMELINE_PROMPT = `You are analyzing a day's activity timeline from a software development team.

The timeline includes events from multiple sources:
- **Telegram** - Team chat messages
- **Jira** - Ticket changes, comments, new tickets
- **GitHub** - Code commits

## Output Format

# Daily Summary: [DATE]

## Overview
- Total events: [N]
- Active team members: [names]
- Main themes: [2-3 key topics]

## Development Activity
| Developer | Repository | Changes |
|-----------|------------|---------|
| name | repo | summary |

## Jira Activity
### New Tickets
| Key | Summary | Assignee |
|-----|---------|----------|

### Status Changes
| Ticket | Change | By |
|--------|--------|-----|

## Issues & Bugs
| Issue | Reporter | Status | Owner |
|-------|----------|--------|-------|

## Deployments
| Service | Result | Changes |
|---------|--------|---------|

## Action Items
- [ ] **[HIGH]** task -> assignee
- [ ] task -> assignee

## Key Decisions
1. Decision: context

## Notes
Patterns, recurring issues, observations

---

**Guidelines:**
1. Be concise - summary, not transcript
2. Use real names
3. Prioritize: bugs > deployments > features
4. Skip noise - greetings, off-topic
5. Correlate sources - link related Telegram/Jira/GitHub items
6. If a section has no data, write "No activity"`;

export function registerSummarizeCommand(program: Command): void {
  program
    .command('summarize <file>')
    .description('Summarize a markdown file using Codex by default')
    .option('-o, --output <file>', 'Output file (default: stdout)')
    .option('--summary-provider <provider>', 'Summary provider: codex or claude')
    .option('--summary-model <model>', 'Provider-specific summary model override')
    .option('--model <model>', 'Legacy Claude-only summary model alias (implies Claude when used alone)')
    .option('--prompt <file>', 'Custom prompt file')
    .action(async (file: string, options: {
      output?: string;
      summaryProvider?: SummaryProvider;
      summaryModel?: string;
      model?: string;
      prompt?: string;
    }) => {
      if (!fs.existsSync(file)) {
        console.error(chalk.red(`File not found: ${file}`));
        process.exit(1);
      }

      const content = fs.readFileSync(file, 'utf-8');
      console.error(chalk.dim(`Read ${content.split('\n').length} lines from ${file}`));

      let prompt = DEFAULT_TIMELINE_PROMPT;
      if (options.prompt) {
        if (!fs.existsSync(options.prompt)) {
          console.error(chalk.red(`Prompt file not found: ${options.prompt}`));
          process.exit(1);
        }
        prompt = fs.readFileSync(options.prompt, 'utf-8');
      }

      console.error(chalk.dim('Running summarization...'));

      const result = await summarizeText(
        content,
        prompt,
        {
          summaryProvider: options.summaryProvider,
          summaryModel: options.summaryModel,
          model: options.model,
          timeoutMs: 600_000,
          cwd: process.cwd(),
        }
      );

      const providerLine = result.fallbackFrom
        ? `Summary provider: ${result.providerUsed} (fallback from ${result.fallbackFrom}: ${result.fallbackReason})`
        : `Summary provider: ${result.providerUsed} (${result.modelUsed})`;
      console.error(chalk.dim(providerLine));

      if (options.output) {
        fs.writeFileSync(options.output, result.text, 'utf-8');
        console.error(chalk.green(`Summary saved to ${options.output}`));
      } else {
        console.log(result.text);
      }
    });
}
