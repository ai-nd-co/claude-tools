#!/usr/bin/env node

/**
 * Postinstall script to patch GramJS MarkdownV2Parser
 *
 * Fixes:
 * 1. Moves inline URL regex to run FIRST (before other formatting)
 * 2. Disables italic regex (-text-) which conflicts with hyphens in URLs
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const candidates = [
  join(__dirname, '../node_modules/telegram/extensions/markdownv2.js'),
  join(__dirname, '../../telegram/extensions/markdownv2.js'),
];
const markdownv2Path = candidates.find((p) => existsSync(p));
if (!markdownv2Path) {
  // A hoisted or pnpm layout puts the dependency elsewhere. The patch is an optional improvement to
  // link handling, so a miss must never fail someone's install.
  console.log('ℹ GramJS MarkdownV2Parser not found; skipping the optional patch');
  process.exit(0);
}

try {
  let content = readFileSync(markdownv2Path, 'utf8');

  // Check if already patched
  if (content.includes('PATCHED')) {
    console.log('✓ GramJS MarkdownV2Parser already patched');
    process.exit(0);
  }

  // Replace the parse function with fixed version
  const originalParse = `static parse(message) {
        // Bold
        message = message.replace(/\\*(.*?)\\*/g, "<b>$1</b>");
        // underline
        message = message.replace(/__(.*?)__/g, "<u>$1</u>");
        // strikethrough
        message = message.replace(/~(.*?)~/g, "<s>$1</s>");
        // italic
        message = message.replace(/-(.*?)-/g, "<i>$1</i>");
        // pre
        message = message.replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, "<pre>$1</pre>");
        // code
        message = message.replace(/\`(.*?)\`/g, "<code>$1</code>");
        // Spoiler
        message = message.replace(/\\|\\|(.*?)\\|\\|/g, "<spoiler>$1</spoiler>");
        // Inline URL
        message = message.replace(/(?<!\\!)\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2">$1</a>');
        // Emoji
        message = message.replace(/!\\[([^\\]]+)\\]\\(tg:\\/\\/emoji\\?id=(\\d+)\\)/g, '<tg-emoji emoji-id="$2">$1</tg-emoji>');`;

  const patchedParse = `static parse(message) {
        // PATCHED: Fixed URL parsing - see scripts/postinstall.js
        // Inline URL - MUST be first to protect URLs from other regex
        message = message.replace(/(?<!\\!)\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2">$1</a>');
        // Emoji
        message = message.replace(/!\\[([^\\]]+)\\]\\(tg:\\/\\/emoji\\?id=(\\d+)\\)/g, '<tg-emoji emoji-id="$2">$1</tg-emoji>');
        // Bold
        message = message.replace(/\\*(.*?)\\*/g, "<b>$1</b>");
        // underline
        message = message.replace(/__(.*?)__/g, "<u>$1</u>");
        // strikethrough
        message = message.replace(/~(.*?)~/g, "<s>$1</s>");
        // italic - DISABLED: conflicts with hyphens in URLs
        // message = message.replace(/-(.*?)-/g, "<i>$1</i>");
        // pre
        message = message.replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, "<pre>$1</pre>");
        // code
        message = message.replace(/\`(.*?)\`/g, "<code>$1</code>");
        // Spoiler
        message = message.replace(/\\|\\|(.*?)\\|\\|/g, "<spoiler>$1</spoiler>");`;

  if (content.includes(originalParse)) {
    content = content.replace(originalParse, patchedParse);
    writeFileSync(markdownv2Path, content);
    console.log('✓ Patched GramJS MarkdownV2Parser');
  } else {
    // Try simpler approach - just fix the key issues
    let patched = false;

    // Disable italic regex
    if (content.includes('message = message.replace(/-(.*?)-/g, "<i>$1</i>");')) {
      content = content.replace(
        'message = message.replace(/-(.*?)-/g, "<i>$1</i>");',
        '// PATCHED: italic disabled - conflicts with URLs\n        // message = message.replace(/-(.*?)-/g, "<i>$1</i>");'
      );
      patched = true;
    }

    if (patched) {
      writeFileSync(markdownv2Path, content);
      console.log('✓ Patched GramJS MarkdownV2Parser (italic disabled)');
    } else {
      console.log('⚠ Could not find expected code to patch - may already be patched or file structure changed');
    }
  }
} catch (err) {
  console.error('Failed to patch GramJS:', err.message);
  process.exit(1);
}
