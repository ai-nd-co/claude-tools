import { parseMessageId } from '../../services/telegram-peer.js';
// Media commands - download, list media from Telegram messages

import { Command } from 'commander';
import chalk from 'chalk';
import { exec } from 'child_process';
import { writeFileSync } from 'fs';
import { homedir } from 'os';
import { loadConfig } from '../../config/loader.js';
import { TelegramService, type MediaType, type DownloadResult, type MediaMessage, type MediaGroup } from '../../services/telegram.js';

/**
 * Format a file path as relative to home directory for display
 * e.g., C:\Users\John\AppData\Roaming\claude-tools\media\photos\file.jpg
 * becomes ~/AppData/Roaming/claude-tools/media/photos/file.jpg
 */
function formatPathFromHome(filepath: string): string {
  const home = homedir();
  if (filepath.startsWith(home)) {
    const relative = filepath.slice(home.length);
    // Normalize to forward slashes and add ~ prefix
    return '~' + relative.replace(/\\/g, '/');
  }
  return filepath;
}

function ensureTelegramConfig() {
  const config = loadConfig();
  if (!config.telegram) {
    console.error(chalk.red('Telegram not configured.'));
    console.log('\nTo configure Telegram:');
    console.log('  1. Get API credentials from https://my.telegram.org/apps');
    console.log('  2. Run: claude-tools telegram auth');
    process.exit(1);
  }
  return config.telegram;
}

/**
 * Format file size in human-readable format
 */
function formatSize(bytes: number | undefined): string {
  if (!bytes) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Get media type icon
 */
function getMediaIcon(type: MediaType): string {
  const icons: Record<MediaType, string> = {
    photo: '\u{1F4F7}',   // camera
    video: '\u{1F3AC}',   // clapper
    document: '\u{1F4C4}', // page
    voice: '\u{1F3A4}',   // microphone
    audio: '\u{1F3B5}',   // music note
    sticker: '\u{1F3A8}', // palette
    gif: '\u{1F3AC}',     // clapper
    unsupported: '\u26A0', // warning
  };
  return icons[type] || '\u{1F4CE}'; // paperclip as fallback
}

/**
 * Escape CSV field value
 */
function escapeCsvField(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Generate CSV content from download results
 */
function generateCsv(results: Array<{ messageId: number; result: DownloadResult; date: Date; sender: string; chatTitle: string }>): string {
  const headers = ['message_id', 'filepath', 'type', 'size_bytes', 'filename', 'date', 'sender', 'chat'];
  const rows = results.map(r => [
    r.messageId.toString(),
    escapeCsvField(r.result.filepath),
    r.result.type,
    r.result.size.toString(),
    escapeCsvField(r.result.filename),
    r.date.toISOString(),
    escapeCsvField(r.sender),
    escapeCsvField(r.chatTitle),
  ].join(','));

  return [headers.join(','), ...rows].join('\n');
}

export function registerMediaCommands(telegram: Command): void {
  // Download media command (supports single ID or comma-separated list)
  telegram
    .command('download <messageIds>')
    .description('Download media from message(s) - accepts single ID or comma-separated list')
    .requiredOption('--chat <chatId>', 'Chat ID or name')
    .option('--output <path>', 'Output directory (for multiple) or file path (for single)')
    .option('--open', 'Open file after download (Windows)')
    .option('--json', 'Output as JSON')
    .addHelpText('after', `
${chalk.yellow('Examples:')}
  ${chalk.dim('# Download a single photo')}
  claude-tools telegram download 12345 --chat "DevOps"

  ${chalk.dim('# Download multiple messages (comma-separated)')}
  claude-tools telegram download 12345,12346,12347 --chat "DevOps"

  ${chalk.dim('# Download multiple to custom directory')}
  claude-tools telegram download 12345,12346 --chat "DevOps" --output ./downloads/

  ${chalk.dim('# Download and open (single file only)')}
  claude-tools telegram download 12345 --chat "DevOps" --open
`)
    .action(async (messageIds: string, options: { chat: string; output?: string; open?: boolean; json?: boolean }) => {
      const config = ensureTelegramConfig();
      const service = new TelegramService(config);

      // Parse comma-separated message IDs
      const ids = messageIds.split(',').map(id => parseMessageId(id.trim()));

      if (ids.length === 0) {
        console.error(chalk.red('\u274C Error: No valid message IDs provided'));
        process.exit(1);
      }

      try {
        await service.connect();
        const selectedPeer = await service.resolveChat(options.chat);

        const results: DownloadResult[] = [];
        const errors: Array<{ id: number; error: string }> = [];

        for (let i = 0; i < ids.length; i++) {
          const id = ids[i];

          try {
          // For single file, use output as file path; for multiple, use as directory
          let outputPath: string | undefined;
          if (options.output && ids.length === 1) {
            outputPath = options.output;
          } else if (options.output && ids.length > 1) {
            // Will be set after we know the extension
            const resolved = selectedPeer;
            const info = await service.getMediaInfo(selectedPeer, id);
            outputPath = `${options.output}/chat_${resolved.id}_msg_${id}${info?.extension || ''}`;
          }

            if (ids.length > 1 && !options.json) {
              process.stdout.write(`  [${i + 1}/${ids.length}] #${id}...`);
            }

            const result = await service.downloadMedia(selectedPeer, id, { outputPath });
            results.push(result);

            if (ids.length > 1 && !options.json) {
              console.error(chalk.green(` \u2713 ${formatPathFromHome(result.filepath)}`));
            }
          } catch (err) {
            errors.push({ id, error: (err as Error).message });
            if (ids.length > 1 && !options.json) {
              console.error(chalk.red(` \u2717 ${(err as Error).message}`));
            }
          }
        }

        // Output results
        if (options.json) {
          console.log(JSON.stringify({ results, errors }, null, 2));
        } else if (ids.length === 1 && results.length === 1) {
          // Single file output
          const result = results[0];
          console.log(chalk.green(`${getMediaIcon(result.type)} Downloaded:`), formatPathFromHome(result.filepath));
          console.log(chalk.dim(`   Type: ${result.type} | Size: ${formatSize(result.size)}`));

          if (options.open && process.platform === 'win32') {
            exec(`start "" "${result.filepath}"`);
          }
        } else {
          // Multiple files summary
          console.log(chalk.bold(`\n\u2705 Downloaded ${results.length}/${ids.length} files`));
          if (errors.length > 0) {
            console.log(chalk.yellow(`\u26A0 ${errors.length} errors`));
          }
          const totalSize = results.reduce((sum, r) => sum + r.size, 0);
          console.log(chalk.dim(`Total size: ${formatSize(totalSize)}`));
        }

        await service.disconnect();
        process.exit(errors.length ? 1 : 0);
      } catch (err) {
        console.error(chalk.red('\u274C Error:'), (err as Error).message);
        process.exit(1);
      }
    });

  // List media in chat command
  telegram
    .command('media <chatId>')
    .description('List messages with media in a chat (groups albums together)')
    .option('--limit <n>', 'Max messages to check', '20')
    .option('--type <type>', 'Filter by type: photo, video, document, voice, audio, sticker')
    .option('--flat', 'Show individual messages instead of grouping albums')
    .option('--json', 'Output as JSON')
    .addHelpText('after', `
${chalk.yellow('Examples:')}
  ${chalk.dim('# List all media in a chat (albums grouped)')}
  claude-tools telegram media "DevOps"

  ${chalk.dim('# List individual messages (no grouping)')}
  claude-tools telegram media "DevOps" --flat

  ${chalk.dim('# List only photos')}
  claude-tools telegram media "DevOps" --type photo

  ${chalk.dim('# List last 50 items')}
  claude-tools telegram media "DevOps" --limit 50
`)
    .action(async (chatId: string, options: { limit: string; type?: string; flat?: boolean; json?: boolean }) => {
      const config = ensureTelegramConfig();
      const service = new TelegramService(config);

      try {
        await service.connect();

        const mediaType = options.type as MediaType | undefined;

        if (options.flat) {
          // Flat listing (original behavior)
          const mediaList = await service.listMedia(chatId, {
            limit: parseInt(options.limit, 10),
            type: mediaType || 'all',
          });

          if (options.json) {
            console.log(JSON.stringify(mediaList, null, 2));
          } else {
            if (mediaList.length === 0) {
              console.log(chalk.dim('No media found in this chat'));
              await service.disconnect();
              process.exit(0);
              return;
            }

            console.log(chalk.bold(`\n\u{1F4CE} Media in ${chatId} (${mediaList.length} items)\n`));
            printMediaTable(mediaList, chatId);
          }
        } else {
          // Grouped listing (default)
          const grouped = await service.listMediaGrouped(chatId, {
            limit: parseInt(options.limit, 10),
            type: mediaType || 'all',
          });

          if (options.json) {
            console.log(JSON.stringify(grouped, null, 2));
          } else {
            if (grouped.length === 0) {
              console.log(chalk.dim('No media found in this chat'));
              await service.disconnect();
              process.exit(0);
              return;
            }

            // Count total items
            let totalItems = 0;
            for (const item of grouped) {
              totalItems += isMediaGroup(item) ? item.messages.length : 1;
            }

            console.log(chalk.bold(`\n\u{1F4CE} Media in ${chatId} (${totalItems} items in ${grouped.length} entries)\n`));

            // Table header
            const idWidth = 20;
            const dateWidth = 14;
            const typeWidth = 12;
            const sizeWidth = 10;
            const senderWidth = 15;

            console.log(
              chalk.dim(
                'ID(s)'.padEnd(idWidth) +
                'Date'.padEnd(dateWidth) +
                'Type'.padEnd(typeWidth) +
                'Size'.padEnd(sizeWidth) +
                'Sender'
              )
            );
            console.log(chalk.dim('\u2500'.repeat(idWidth + dateWidth + typeWidth + sizeWidth + senderWidth + 5)));

            for (const item of grouped) {
              if (isMediaGroup(item)) {
                // Media group (album)
                const ids = item.messages.map(m => m.messageId).join(',');
                const date = item.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
                const totalSize = item.messages.reduce((sum, m) => sum + (m.mediaInfo.size || 0), 0);
                const types = [...new Set(item.messages.map(m => m.mediaInfo.type))];
                const typeStr = `\u{1F4F7} ${types.join('+')} x${item.messages.length}`;

                console.log(
                  chalk.yellow(`${ids.slice(0, idWidth - 1).padEnd(idWidth)}`) +
                  `${date.padEnd(dateWidth)}` +
                  `${typeStr.padEnd(typeWidth)}` +
                  `${formatSize(totalSize).padEnd(sizeWidth)}` +
                  chalk.cyan(item.sender.slice(0, senderWidth))
                );
              } else {
                // Single media
                const date = item.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
                const icon = getMediaIcon(item.mediaInfo.type);
                const size = formatSize(item.mediaInfo.size);
                const filename = item.mediaInfo.filename ? chalk.dim(` (${item.mediaInfo.filename.slice(0, 15)})`) : '';

                console.log(
                  `${String(item.messageId).padEnd(idWidth)}` +
                  `${date.padEnd(dateWidth)}` +
                  `${icon} ${item.mediaInfo.type.padEnd(typeWidth - 2)}` +
                  `${size.padEnd(sizeWidth)}` +
                  `${chalk.cyan(item.sender.slice(0, senderWidth))}` +
                  filename
                );
              }
            }

            console.log(chalk.dim(`\nUse: telegram download <id,id,...> -c "${chatId}" to download (albums use comma-separated IDs)`));
          }
        }

        await service.disconnect();
        process.exit(0);
      } catch (err) {
        console.error(chalk.red('\u274C Error:'), (err as Error).message);
        process.exit(1);
      }
    });

  function isMediaGroup(item: MediaMessage | MediaGroup): item is MediaGroup {
    return 'messages' in item;
  }

  function printMediaTable(mediaList: MediaMessage[], chatId: string): void {
    const idWidth = 10;
    const dateWidth = 14;
    const typeWidth = 10;
    const sizeWidth = 10;
    const senderWidth = 15;

    console.log(
      chalk.dim(
        'ID'.padEnd(idWidth) +
        'Date'.padEnd(dateWidth) +
        'Type'.padEnd(typeWidth) +
        'Size'.padEnd(sizeWidth) +
        'Sender'
      )
    );
    console.log(chalk.dim('\u2500'.repeat(idWidth + dateWidth + typeWidth + sizeWidth + senderWidth + 10)));

    for (const item of mediaList) {
      const date = item.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const icon = getMediaIcon(item.mediaInfo.type);
      const size = formatSize(item.mediaInfo.size);
      const filename = item.mediaInfo.filename ? chalk.dim(` (${item.mediaInfo.filename.slice(0, 20)})`) : '';
      const groupIcon = item.groupedId ? chalk.yellow(' [album]') : '';

      console.log(
        `${String(item.messageId).padEnd(idWidth)}` +
        `${date.padEnd(dateWidth)}` +
        `${icon} ${item.mediaInfo.type.padEnd(typeWidth - 2)}` +
        `${size.padEnd(sizeWidth)}` +
        `${chalk.cyan(item.sender.slice(0, senderWidth))}` +
        filename +
        groupIcon
      );
    }

    console.log(chalk.dim(`\nUse: telegram download <id> --chat "${chatId}" to download`));
  }

  // Get media info command
  telegram
    .command('media-info <messageId>')
    .description('Get media info from a message without downloading')
    .requiredOption('--chat <chatId>', 'Chat ID or name')
    .option('--json', 'Output as JSON')
    .addHelpText('after', `
${chalk.yellow('Examples:')}
  ${chalk.dim('# Get info about media in a message')}
  claude-tools telegram media-info 12345 --chat "DevOps"
`)
    .action(async (messageId: string, options: { chat: string; json?: boolean }) => {
      const config = ensureTelegramConfig();
      const service = new TelegramService(config);

      try {
        await service.connect();

        const info = await service.getMediaInfo(options.chat, parseMessageId(messageId));

        if (!info) {
          console.log(options.json ? 'null' : chalk.dim('No media in this message'));
          await service.disconnect();
          return;
        }

        if (options.json) {
          console.log(JSON.stringify(info, null, 2));
        } else {
          console.log(chalk.bold(`\n${getMediaIcon(info.type)} Media Info\n`));
          console.log(`   ${chalk.dim('Type:')}      ${info.type}`);
          console.log(`   ${chalk.dim('Extension:')} ${info.extension}`);
          if (info.size) console.log(`   ${chalk.dim('Size:')}      ${formatSize(info.size)}`);
          if (info.filename) console.log(`   ${chalk.dim('Filename:')}  ${info.filename}`);
          if (info.width && info.height) console.log(`   ${chalk.dim('Dimensions:')} ${info.width}x${info.height}`);
          if (info.duration) console.log(`   ${chalk.dim('Duration:')}  ${info.duration}s`);
          if (info.mimeType) console.log(`   ${chalk.dim('MIME:')}      ${info.mimeType}`);
          console.log();
        }

        await service.disconnect();
        process.exit(0);
      } catch (err) {
        console.error(chalk.red('\u274C Error:'), (err as Error).message);
        process.exit(1);
      }
    });

  // Batch download media command
  telegram
    .command('download-all <chatId>')
    .description('Download multiple media files from a chat')
    .option('--limit <n>', 'Max messages to check', '20')
    .option('--type <type>', 'Filter by type: photo, video, document, voice, audio, sticker')
    .option('--output <dir>', 'Output directory (default: media cache)')
    .option('--csv <path>', 'Export download results to CSV file')
    .option('--json', 'Output as JSON')
    .option('--dry-run', 'List files that would be downloaded without downloading')
    .addHelpText('after', `
${chalk.yellow('Examples:')}
  ${chalk.dim('# Download all photos from a chat')}
  claude-tools telegram download-all "DevOps" --type photo

  ${chalk.dim('# Download last 50 media files and export to CSV')}
  claude-tools telegram download-all "DevOps" --limit 50 --csv ./downloads.csv

  ${chalk.dim('# Preview what would be downloaded')}
  claude-tools telegram download-all "DevOps" --limit 10 --dry-run

  ${chalk.dim('# Download documents to custom directory')}
  claude-tools telegram download-all "DevOps" --type document --output ./docs/
`)
    .action(async (chatId: string, options: {
      limit: string;
      type?: string;
      output?: string;
      csv?: string;
      json?: boolean;
      dryRun?: boolean;
    }) => {
      const config = ensureTelegramConfig();
      const service = new TelegramService(config);

      try {
        await service.connect();
        const selectedPeer = await service.resolveChat(chatId);

        const mediaType = options.type as MediaType | undefined;
        const mediaList = await service.listMedia(selectedPeer, {
          limit: parseInt(options.limit, 10),
          type: mediaType || 'all',
        });

        if (mediaList.length === 0) {
          console.log(chalk.dim('No media found in this chat'));
          await service.disconnect();
          return;
        }

        // Dry run - just show what would be downloaded
        if (options.dryRun) {
          console.log(chalk.bold(`\n\u{1F4CB} Would download ${mediaList.length} files:\n`));
          let totalSize = 0;
          for (const item of mediaList) {
            const icon = getMediaIcon(item.mediaInfo.type);
            const size = item.mediaInfo.size || 0;
            totalSize += size;
            console.log(`  ${icon} #${item.messageId} - ${item.mediaInfo.type} (${formatSize(size)})`);
          }
          console.log(chalk.dim(`\nTotal size: ${formatSize(totalSize)}`));
          await service.disconnect();
          return;
        }

        console.error(chalk.bold(`\n\u{1F4E5} Downloading ${mediaList.length} files...\n`));

        const results: Array<{
          messageId: number;
          result: DownloadResult;
          date: Date;
          sender: string;
          chatTitle: string;
        }> = [];
        const errors: Array<{ messageId: number; error: string }> = [];

        for (let i = 0; i < mediaList.length; i++) {
          const item = mediaList[i];
          const icon = getMediaIcon(item.mediaInfo.type);

          try {
            process.stderr.write(`  [${i + 1}/${mediaList.length}] ${icon} #${item.messageId}...`);

            const result = await service.downloadMedia(selectedPeer, item.messageId, {
              outputPath: options.output ? `${options.output}/chat_${item.chatId}_msg_${item.messageId}${item.mediaInfo.extension}` : undefined,
            });

            results.push({
              messageId: item.messageId,
              result,
              date: item.date,
              sender: item.sender,
              chatTitle: item.chatTitle,
            });

            console.error(chalk.green(` \u2713 ${formatPathFromHome(result.filepath)}`));
          } catch (err) {
            errors.push({ messageId: item.messageId, error: (err as Error).message });
            console.error(chalk.red(` \u2717 ${(err as Error).message}`));
          }
        }

        // Output results
        if (options.json) {
          console.log(JSON.stringify({ results, errors }, null, 2));
        } else {
          console.log(chalk.bold(`\n\u2705 Downloaded ${results.length}/${mediaList.length} files`));
          if (errors.length > 0) {
            console.log(chalk.yellow(`\u26A0 ${errors.length} errors`));
          }

          // Show total size
          const totalSize = results.reduce((sum, r) => sum + r.result.size, 0);
          console.log(chalk.dim(`Total size: ${formatSize(totalSize)}`));
        }

        // Export to CSV if requested
        if (options.csv && results.length > 0) {
          const csv = generateCsv(results);
          writeFileSync(options.csv, csv);
          console.error(chalk.green(`\n\u{1F4BE} Exported to ${options.csv}`));
        }

        await service.disconnect();
        process.exit(errors.length ? 1 : 0);
      } catch (err) {
        console.error(chalk.red('\u274C Error:'), (err as Error).message);
        process.exit(1);
      }
    });
}
