import { Command } from 'commander';
import chalk from 'chalk';
import {
  BrowserBridge,
  type LogEvent,
  type NetworkEvent,
  type TabInfo,
} from '../../services/browser-bridge.js';

interface BridgeCliOptions {
  host?: string;
  port?: string;
  wait?: string;
  timeout?: string;
  maxEvents?: string;
  json?: boolean;
}

interface StreamOptions extends BridgeCliOptions {
  duration?: string;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = '7331';
const DEFAULT_WAIT = '5000';
const DEFAULT_TIMEOUT = '5000';
const DEFAULT_MAX_EVENTS = '2000';

export function registerBrowserCommands(program: Command): void {
  const browser = program
    .command('browser')
    .description('Chrome browser control via local extension bridge');

  browser
    .command('list-tabs')
    .description('List open Chrome tabs')
    .option('--host <host>', 'Bridge host', DEFAULT_HOST)
    .option('--port <port>', 'Bridge port', DEFAULT_PORT)
    .option('--wait <ms>', 'Wait for extension connection', DEFAULT_WAIT)
    .option('--timeout <ms>', 'Request timeout', DEFAULT_TIMEOUT)
    .option('--max-events <n>', 'Event buffer size', DEFAULT_MAX_EVENTS)
    .option('--json', 'Output JSON')
    .action(async (options: BridgeCliOptions) => {
      await withBridge(options, async (bridge, timeoutMs, json) => {
        const result = await bridge.request('listTabs', {}, timeoutMs);
        if (json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        printTabs(result.tabs);
      });
    });

  browser
    .command('attach <tabId>')
    .description('Attach debugger to a tab')
    .option('--host <host>', 'Bridge host', DEFAULT_HOST)
    .option('--port <port>', 'Bridge port', DEFAULT_PORT)
    .option('--wait <ms>', 'Wait for extension connection', DEFAULT_WAIT)
    .option('--timeout <ms>', 'Request timeout', DEFAULT_TIMEOUT)
    .option('--max-events <n>', 'Event buffer size', DEFAULT_MAX_EVENTS)
    .option('--json', 'Output JSON')
    .action(async (tabIdValue: string, options: BridgeCliOptions) => {
      const tabId = parseIntOption(tabIdValue, 'tabId');
      await withBridge(options, async (bridge, timeoutMs, json) => {
        const result = await bridge.request('attachTab', { tabId }, timeoutMs);
        if (json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(chalk.green(`Attached to tab ${result.tabId}.`));
      });
    });

  browser
    .command('detach <tabId>')
    .description('Detach debugger from a tab')
    .option('--host <host>', 'Bridge host', DEFAULT_HOST)
    .option('--port <port>', 'Bridge port', DEFAULT_PORT)
    .option('--wait <ms>', 'Wait for extension connection', DEFAULT_WAIT)
    .option('--timeout <ms>', 'Request timeout', DEFAULT_TIMEOUT)
    .option('--max-events <n>', 'Event buffer size', DEFAULT_MAX_EVENTS)
    .option('--json', 'Output JSON')
    .action(async (tabIdValue: string, options: BridgeCliOptions) => {
      const tabId = parseIntOption(tabIdValue, 'tabId');
      await withBridge(options, async (bridge, timeoutMs, json) => {
        const result = await bridge.request('detachTab', { tabId }, timeoutMs);
        if (json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(chalk.yellow(`Detached from tab ${result.tabId}.`));
      });
    });

  browser
    .command('eval <tabId> <expression>')
    .description('Evaluate JavaScript in a tab')
    .option('--host <host>', 'Bridge host', DEFAULT_HOST)
    .option('--port <port>', 'Bridge port', DEFAULT_PORT)
    .option('--wait <ms>', 'Wait for extension connection', DEFAULT_WAIT)
    .option('--timeout <ms>', 'Request timeout', DEFAULT_TIMEOUT)
    .option('--max-events <n>', 'Event buffer size', DEFAULT_MAX_EVENTS)
    .option('--no-return-by-value', 'Return remote object handle instead of JSON')
    .option('--no-await-promise', 'Do not await promise resolution')
    .option('--json', 'Output JSON')
    .action(async (tabIdValue: string, expression: string, options: BridgeCliOptions & {
      returnByValue?: boolean;
      awaitPromise?: boolean;
    }) => {
      const tabId = parseIntOption(tabIdValue, 'tabId');
      await withBridge(options, async (bridge, timeoutMs, json) => {
        const result = await bridge.request('evalJs', {
          tabId,
          expression,
          returnByValue: options.returnByValue,
          awaitPromise: options.awaitPromise,
        }, timeoutMs);
        if (json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        if (result.exceptionDetails) {
          console.log(chalk.red(`Exception: ${result.exceptionDetails.text}`));
        }
        console.log(chalk.cyan(`Result type: ${result.result.type}`));
        if (result.result.value !== undefined) {
          console.log(result.result.value);
        } else if (result.result.description) {
          console.log(result.result.description);
        }
      });
    });

  browser
    .command('html <tabId>')
    .description('Fetch outer HTML from a tab')
    .option('--host <host>', 'Bridge host', DEFAULT_HOST)
    .option('--port <port>', 'Bridge port', DEFAULT_PORT)
    .option('--wait <ms>', 'Wait for extension connection', DEFAULT_WAIT)
    .option('--timeout <ms>', 'Request timeout', DEFAULT_TIMEOUT)
    .option('--max-events <n>', 'Event buffer size', DEFAULT_MAX_EVENTS)
    .option('--json', 'Output JSON')
    .action(async (tabIdValue: string, options: BridgeCliOptions) => {
      const tabId = parseIntOption(tabIdValue, 'tabId');
      await withBridge(options, async (bridge, timeoutMs, json) => {
        const result = await bridge.request('getOuterHtml', { tabId }, timeoutMs);
        if (json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(result.html);
      });
    });

  browser
    .command('logs <tabId>')
    .description('Stream console/page logs from a tab')
    .option('--host <host>', 'Bridge host', DEFAULT_HOST)
    .option('--port <port>', 'Bridge port', DEFAULT_PORT)
    .option('--wait <ms>', 'Wait for extension connection', DEFAULT_WAIT)
    .option('--timeout <ms>', 'Request timeout', DEFAULT_TIMEOUT)
    .option('--max-events <n>', 'Event buffer size', DEFAULT_MAX_EVENTS)
    .option('--duration <ms>', 'Stop after duration (ms)')
    .option('--json', 'Output JSON lines')
    .action(async (tabIdValue: string, options: StreamOptions) => {
      const tabId = parseIntOption(tabIdValue, 'tabId');
      await withBridge(options, async (bridge, timeoutMs, json) => {
        await bridge.request('attachTab', { tabId }, timeoutMs);
        await bridge.request('enableLog', { tabId }, timeoutMs);
        console.log(chalk.dim('Listening for log events... (Ctrl+C to stop)'));

        const unsubscribe = bridge.onLog((event) => {
          if (event.tabId !== tabId) {
            return;
          }
          printEvent(event, json);
        });

        await waitForStop(options.duration);
        unsubscribe();
      });
    });

  browser
    .command('network <tabId>')
    .description('Stream network events from a tab')
    .option('--host <host>', 'Bridge host', DEFAULT_HOST)
    .option('--port <port>', 'Bridge port', DEFAULT_PORT)
    .option('--wait <ms>', 'Wait for extension connection', DEFAULT_WAIT)
    .option('--timeout <ms>', 'Request timeout', DEFAULT_TIMEOUT)
    .option('--max-events <n>', 'Event buffer size', DEFAULT_MAX_EVENTS)
    .option('--duration <ms>', 'Stop after duration (ms)')
    .option('--json', 'Output JSON lines')
    .action(async (tabIdValue: string, options: StreamOptions) => {
      const tabId = parseIntOption(tabIdValue, 'tabId');
      await withBridge(options, async (bridge, timeoutMs, json) => {
        await bridge.request('attachTab', { tabId }, timeoutMs);
        await bridge.request('enableNetwork', { tabId }, timeoutMs);
        console.log(chalk.dim('Listening for network events... (Ctrl+C to stop)'));

        const unsubscribe = bridge.onNetwork((event) => {
          if (event.tabId !== tabId) {
            return;
          }
          printEvent(event, json);
        });

        await waitForStop(options.duration);
        unsubscribe();
      });
    });

  browser
    .command('response-body <tabId> <requestId>')
    .description('Fetch a response body for a network request ID')
    .option('--host <host>', 'Bridge host', DEFAULT_HOST)
    .option('--port <port>', 'Bridge port', DEFAULT_PORT)
    .option('--wait <ms>', 'Wait for extension connection', DEFAULT_WAIT)
    .option('--timeout <ms>', 'Request timeout', DEFAULT_TIMEOUT)
    .option('--max-events <n>', 'Event buffer size', DEFAULT_MAX_EVENTS)
    .option('--json', 'Output JSON')
    .action(async (tabIdValue: string, requestId: string, options: BridgeCliOptions) => {
      const tabId = parseIntOption(tabIdValue, 'tabId');
      await withBridge(options, async (bridge, timeoutMs, json) => {
        const result = await bridge.request('getResponseBody', { tabId, requestId }, timeoutMs);
        if (json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(result.body);
        if (result.base64Encoded) {
          console.log(chalk.dim('(base64 encoded)'));
        }
      });
    });
}

async function withBridge(
  options: BridgeCliOptions,
  handler: (bridge: BrowserBridge, timeoutMs: number, json: boolean) => Promise<void>
): Promise<void> {
  const host = options.host ?? DEFAULT_HOST;
  const port = parseIntOption(options.port ?? DEFAULT_PORT, 'port');
  const waitMs = parseIntOption(options.wait ?? DEFAULT_WAIT, 'wait');
  const timeoutMs = parseIntOption(options.timeout ?? DEFAULT_TIMEOUT, 'timeout');
  const maxEvents = parseIntOption(options.maxEvents ?? DEFAULT_MAX_EVENTS, 'max-events');
  const json = options.json ?? false;

  const bridge = new BrowserBridge({ host, port, maxEvents });

  try {
    await bridge.waitForConnection(waitMs);
    await handler(bridge, timeoutMs, json);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`Error: ${message}`));
    process.exitCode = 1;
  } finally {
    await bridge.close();
  }
}

function parseIntOption(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid ${name} value: ${value}`);
  }
  return parsed;
}

function printTabs(tabs: TabInfo[]): void {
  if (tabs.length === 0) {
    console.log(chalk.dim('No tabs found.'));
    return;
  }

  console.log();
  for (const tab of tabs) {
    const title = tab.title ? ` - ${tab.title}` : '';
    const url = tab.url ? chalk.dim(` (${tab.url})`) : '';
    const active = tab.active ? chalk.green(' [active]') : '';
    console.log(`${chalk.cyan(`#${tab.id}`)}${active}${title}${url}`);
  }
  console.log();
}

function printEvent(event: LogEvent | NetworkEvent, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(event));
    return;
  }
  const prefix = chalk.dim(`[${event.timestamp}]`);
  console.log(`${prefix} ${chalk.cyan(event.method)} ${chalk.dim(`tab=${event.tabId}`)}`);
  if (event.params !== undefined) {
    console.log(chalk.dim(JSON.stringify(event.params)));
  }
}

async function waitForStop(duration?: string): Promise<void> {
  const durationMs = duration ? parseIntOption(duration, 'duration') : undefined;

  await new Promise<void>((resolve) => {
    let timeout: NodeJS.Timeout | undefined;

    const finish = () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      process.off('SIGINT', finish);
      resolve();
    };

    process.on('SIGINT', finish);

    if (durationMs !== undefined) {
      timeout = setTimeout(finish, durationMs);
    }
  });
}
