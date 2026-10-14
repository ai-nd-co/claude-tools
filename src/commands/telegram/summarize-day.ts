import { resolveChatId as resolveCachedChat } from '../../services/telegram-search.js';
/**
 * Summarize a day's Telegram messages using Codex by default.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import { getDatabase, MessageRow } from '../../db/index.js';
import { summarizeText, SummaryProvider } from '../../utils/summary-provider.js';

// Re-use the text formatting from export-day
function formatMessagesAsText(messages: MessageRow[], date: string): string {
  const lines: string[] = [];

  const participants = [...new Set(messages.map(m => m.sender).filter(Boolean))];
  lines.push(`=== Messages - ${date} ===`);
  lines.push(`Total: ${messages.length} messages`);
  lines.push(`Participants: ${participants.join(', ')}`);
  lines.push('');
  lines.push('--- CONVERSATION ---');
  lines.push('');

  const msgMap = new Map<string, { sender: string; text: string }>();
  for (const msg of messages) {
    msgMap.set(`${msg.chat_id}:${msg.id}`, { sender: msg.sender || 'Unknown', text: msg.text || '' });
  }

  for (const msg of messages) {
    const time = new Date(msg.date * 1000).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });

    const sender = msg.sender || 'Unknown';
    let line = `[${time}] [chat:${msg.chat_id}] #${msg.id} ${sender}`;

    if (msg.reply_to_id && (!msg.reply_to_peer_id || msg.reply_to_peer_id === msg.chat_id)) {
      const replyTo = msgMap.get(`${msg.reply_to_peer_id || msg.chat_id}:${msg.reply_to_id}`);
      if (replyTo) {
        const preview = replyTo.text?.substring(0, 50).replace(/\n/g, ' ') || '';
        line += ` (replying to ${replyTo.sender}: "${preview}${replyTo.text && replyTo.text.length > 50 ? '...' : ''}")`;
      }
    }

    line += ':';

    if (msg.text) {
      const textLines = msg.text.split('\n');
      if (textLines.length === 1) {
        line += ` ${msg.text}`;
      } else {
        line += '\n' + textLines.map(l => '  ' + l).join('\n');
      }
    }

    if (msg.has_media && !msg.text) {
      line += ` [${msg.media_type || 'media'}]`;
    } else if (msg.has_media) {
      line += ` [+${msg.media_type || 'media'}]`;
    }

    lines.push(line);
  }

  return lines.join('\n');
}

function getMessagesForDay(date: string, chatId?: string): MessageRow[] {
  const db = getDatabase();

  let sql = `SELECT * FROM messages WHERE date(date, 'unixepoch') = ?`;
  const params: any[] = [date];

  if (chatId) {
    sql += ` AND chat_id = ?`;
    params.push(chatId);
  }

  sql += ` ORDER BY date ASC, id ASC`;

  return db.prepare(sql).all(...params) as MessageRow[];
}

function getChatIdByTitle(title: string): string | null { return resolveCachedChat(title); }

// Default prompt for daily summaries
const DEFAULT_PROMPT = `You are analyzing a day's worth of Telegram messages from a team chat.

**IMPORTANT: You MUST output a COMPLETE summary using the FULL format specified below. Do not abbreviate or summarize briefly. Include ALL sections with tables and details.**

## What to Extract

### 1. Issues & Bugs
For each problem discussed:
- Brief description of the issue
- Who reported it
- Affected system/client if mentioned
- Resolution status: RESOLVED / PENDING / INVESTIGATING / BLOCKED
- Who is handling it

### 2. Deployments & Releases
- Service deployed
- Who triggered deployment
- Success or failure
- Notable changes or fixes included

### 3. Feature Requests & Discussions
- What feature was requested/discussed
- Who requested it
- Technical decisions made
- Who will implement (if assigned)

### 4. Action Items
Explicit tasks mentioned that need follow-up:
- Task description
- Assignee (if clear)
- Mark as HIGH priority if: urgent language used, client waiting, or blocking other work

### 5. Key Decisions
Technical or policy decisions made during discussions that affect how things work.

### 6. Client Issues
Track which clients/companies had problems:
- Client/company name
- Issue summary

## Output Format

# Daily Summary: [DATE]

## Overview
- Messages analyzed: [N]
- Active team members: [names]
- Main themes: [2-3 key topics]

## Issues & Bugs

| Issue | Reporter | Status | Owner |
|-------|----------|--------|-------|
| ... | ... | ... | ... |

**Details:**
- **[Issue]**: [What happened, what was done]

## Deployments

| Time | Service | Result | Changes |
|------|---------|--------|---------|
| HH:MM | service-name | OK/FAILED | brief notes |

## Feature Discussions

**[Feature Name]**
- Request: [what was asked]
- Decision: [what was decided]
- Assigned: [who or TBD]

## Action Items

- [ ] **[HIGH]** [task] → [assignee]
- [ ] [task] → [assignee]

## Key Decisions

1. [Decision]: [Brief reasoning or context]

## Client Activity

| Client | Issue | Status |
|--------|-------|--------|
| ... | ... | ... |

## Notes

[Recurring problems, patterns, or observations worth noting]

---

## Guidelines

1. **Be concise** - summary, not transcript
2. **Use real names** - not Telegram usernames when possible
3. **Mark uncertainty** - say "unclear" rather than guess
4. **Prioritize**: bugs > deployments > features > chat
5. **Skip noise** - greetings, reactions, off-topic
6. **Group related** - combine thread discussions into single items
7. **Preserve context** - if a decision references a client request, note it
8. **Track threads** - replies often contain resolution info for earlier issues

---

**FINAL INSTRUCTION: Output the COMPLETE summary with ALL sections (Overview, Issues & Bugs table + Details, Deployments table, Feature Discussions, Action Items, Key Decisions, Client Activity table, Notes). Do NOT output a brief summary - use the full structured format above.**`;

export function registerSummarizeDayCommand(telegram: Command): void {
  telegram
    .command('summarize-day <date>')
    .description('Generate AI summary of a day\'s Telegram messages')
    .option('--chat <name>', 'Filter by chat title')
    .option('--output <file>', 'Save summary to file')
    .option('--summary-provider <provider>', 'Summary provider: codex or claude')
    .option('--summary-model <model>', 'Provider-specific summary model override')
    .option('--model <model>', 'Legacy Claude-only summary model alias (implies Claude when used alone)')
    .option('--prompt <file>', 'Custom prompt file (default: built-in)')
    .addHelpText('after', `
${chalk.yellow('Examples:')}
  ${chalk.dim('# Summarize yesterday')}
  claude-tools telegram summarize-day 2026-01-07

  ${chalk.dim('# Save to file')}
  claude-tools telegram summarize-day 2026-01-07 --output summary.md

  ${chalk.dim('# Use faster model')}
  claude-tools telegram summarize-day 2026-01-07 --summary-provider claude --summary-model sonnet

  ${chalk.dim('# Multiple days')}
  for d in 2026-01-05 2026-01-06 2026-01-07; do
    claude-tools telegram summarize-day $d --output summary-$d.md
  done
`)
    .action(async (date: string, options: {
      chat?: string;
      output?: string;
      summaryProvider?: SummaryProvider;
      summaryModel?: string;
      model?: string;
      prompt?: string;
    }) => {
      // Validate date
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        console.error(chalk.red('Invalid date format. Use YYYY-MM-DD'));
        process.exit(1);
      }

      // Get chat ID if specified
      let chatId: string | null = null;
      if (options.chat) {
        chatId = getChatIdByTitle(options.chat);
        if (!chatId) {
          console.error(chalk.red(`Chat "${options.chat}" not found in synced chats`));
          process.exit(1);
        }
      }

      // Get messages
      const messages = getMessagesForDay(date, chatId || undefined);

      if (messages.length === 0) {
        console.error(chalk.yellow(`No messages found for ${date}`));
        process.exit(0);
      }

      console.log(chalk.dim(`Found ${messages.length} messages for ${date}`));

      // Format messages
      const conversationText = formatMessagesAsText(messages, date);

      // Load prompt
      let prompt = DEFAULT_PROMPT;
      if (options.prompt) {
        if (!fs.existsSync(options.prompt)) {
          console.error(chalk.red(`Prompt file not found: ${options.prompt}`));
          process.exit(1);
        }
        prompt = fs.readFileSync(options.prompt, 'utf-8');
      }

      console.log(chalk.dim('Running summarization...'));

      const result = await summarizeText(
        conversationText,  // First: the data
        prompt,            // Second: the instructions
        {
          summaryProvider: options.summaryProvider,
          summaryModel: options.summaryModel,
          model: options.model,
          timeoutMs: 600_000, // 10 minutes
          cwd: process.cwd(),
        }
      );

      const providerLine = result.fallbackFrom
        ? `Summary provider: ${result.providerUsed} (fallback from ${result.fallbackFrom}: ${result.fallbackReason})`
        : `Summary provider: ${result.providerUsed} (${result.modelUsed})`;
      console.log(chalk.dim(providerLine));

      // Output
      if (options.output) {
        fs.writeFileSync(options.output, result.text, 'utf-8');
        console.log(chalk.green(`Summary saved to ${options.output}`));
        console.log(chalk.dim(`${result.text.split('\n').length} lines`));
      } else {
        console.log('\n' + result.text);
      }
    });
}
