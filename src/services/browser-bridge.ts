import { randomUUID } from 'node:crypto';
import * as http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { WebSocketServer } from 'ws';
import type { RawData, WebSocket } from 'ws';

const WS_OPEN = 1;

export interface TabInfo {
  id: number;
  title?: string;
  url?: string;
  windowId: number;
  active: boolean;
}

export interface RemoteObjectResult {
  type: string;
  subtype?: string;
  value?: unknown;
  description?: string;
}

export interface ExceptionDetailsResult {
  text: string;
  lineNumber: number;
  columnNumber: number;
  url?: string;
  exception?: RemoteObjectResult;
  stackTrace?: {
    callFrames: Array<{
      functionName: string;
      url: string;
      lineNumber: number;
      columnNumber: number;
    }>;
  };
}

export interface EvalResult {
  tabId: number;
  result: RemoteObjectResult;
  exceptionDetails?: ExceptionDetailsResult;
}

export interface OuterHtmlResult {
  tabId: number;
  html: string;
}

export interface ResponseBodyResult {
  tabId: number;
  requestId: string;
  body: string;
  base64Encoded: boolean;
}

export interface SimpleAckResult {
  tabId: number;
  ok: boolean;
}

export interface LogEvent {
  id: number;
  tabId: number;
  method: string;
  params?: unknown;
  timestamp: string;
}

export interface NetworkEvent {
  id: number;
  tabId: number;
  method: string;
  params?: unknown;
  timestamp: string;
}

interface ExtensionRequestMap {
  listTabs: {
    params: Record<string, never>;
    result: { tabs: TabInfo[] };
  };
  attachTab: {
    params: { tabId: number };
    result: { tabId: number; attached: boolean };
  };
  detachTab: {
    params: { tabId: number };
    result: { tabId: number; detached: boolean };
  };
  evalJs: {
    params: {
      tabId: number;
      expression: string;
      returnByValue?: boolean;
      awaitPromise?: boolean;
    };
    result: EvalResult;
  };
  getOuterHtml: {
    params: { tabId: number };
    result: OuterHtmlResult;
  };
  enableLog: {
    params: { tabId: number };
    result: SimpleAckResult;
  };
  enableNetwork: {
    params: { tabId: number };
    result: SimpleAckResult;
  };
  getResponseBody: {
    params: { tabId: number; requestId: string };
    result: ResponseBodyResult;
  };
}

export type ExtensionMethod = keyof ExtensionRequestMap;
export type ExtensionParams<M extends ExtensionMethod> = ExtensionRequestMap[M]['params'];
export type ExtensionResult<M extends ExtensionMethod> = ExtensionRequestMap[M]['result'];

interface ExtensionResponseSuccess {
  type: 'response';
  id: string;
  success: true;
  result: unknown;
}

interface ExtensionResponseError {
  type: 'response';
  id: string;
  success: false;
  error: { message: string };
}

type ExtensionResponse = ExtensionResponseSuccess | ExtensionResponseError;

interface ExtensionEventMessage {
  type: 'event';
  event: 'log' | 'network';
  tabId: number;
  method: string;
  params?: unknown;
  timestamp: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export interface BrowserBridgeOptions {
  host: string;
  port: number;
  maxEvents: number;
}

type LogListener = (event: LogEvent) => void;
type NetworkListener = (event: NetworkEvent) => void;

export class BrowserBridge {
  private readonly httpServer: http.Server;
  private readonly wsServer: WebSocketServer;
  private readonly serverReady: Promise<void>;
  private socket: WebSocket | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private logEvents: LogEvent[] = [];
  private networkEvents: NetworkEvent[] = [];
  private logCounter = 0;
  private networkCounter = 0;
  private readonly maxEvents: number;
  private readonly logListeners = new Set<LogListener>();
  private readonly networkListeners = new Set<NetworkListener>();
  private readonly connectionWaiters = new Set<{
    resolve: () => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>();

  constructor(options: BrowserBridgeOptions) {
    this.maxEvents = options.maxEvents;
    this.httpServer = http.createServer((req, res) => {
      this.handleHttpRequest(req, res);
    });
    this.wsServer = new WebSocketServer({ noServer: true });

    this.serverReady = new Promise((resolve, reject) => {
      this.httpServer.once('listening', () => resolve());
      this.httpServer.once('error', (error) => reject(error));
    });

    this.httpServer.on('upgrade', (request, socket, head) => {
      this.wsServer.handleUpgrade(request, socket, head, (client) => {
        this.wsServer.emit('connection', client, request);
      });
    });

    this.wsServer.on('connection', (socket) => {
      this.attachSocket(socket);
    });

    this.httpServer.listen(options.port, options.host);
  }

  isConnected(): boolean {
    return this.socket?.readyState === WS_OPEN;
  }

  async waitForConnection(timeoutMs: number): Promise<void> {
    await this.serverReady;
    if (this.isConnected()) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.connectionWaiters.delete(waiter);
        reject(new Error(`Extension did not connect within ${timeoutMs}ms.`));
      }, timeoutMs);

      const waiter = { resolve, reject, timeout };
      this.connectionWaiters.add(waiter);
    });
  }

  onLog(listener: LogListener): () => void {
    this.logListeners.add(listener);
    return () => {
      this.logListeners.delete(listener);
    };
  }

  onNetwork(listener: NetworkListener): () => void {
    this.networkListeners.add(listener);
    return () => {
      this.networkListeners.delete(listener);
    };
  }

  getLogEvents(sinceId?: number, limit = 200): { events: LogEvent[]; latestId: number } {
    return {
      events: this.getEventsSlice(this.logEvents, sinceId, limit),
      latestId: this.logCounter,
    };
  }

  getNetworkEvents(
    sinceId?: number,
    limit = 200
  ): { events: NetworkEvent[]; latestId: number } {
    return {
      events: this.getEventsSlice(this.networkEvents, sinceId, limit),
      latestId: this.networkCounter,
    };
  }

  async request<M extends ExtensionMethod>(
    method: M,
    params: ExtensionParams<M>,
    timeoutMs = 5000
  ): Promise<ExtensionResult<M>> {
    if (!this.socket || this.socket.readyState !== WS_OPEN) {
      throw new Error('Extension is not connected.');
    }

    const id = randomUUID();
    const payload = JSON.stringify({
      type: 'request',
      id,
      method,
      params,
    });

    return new Promise<ExtensionResult<M>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Extension request timed out: ${method}`));
      }, timeoutMs);

      const resolveUnknown = (value: unknown) => {
        resolve(value as ExtensionResult<M>);
      };
      const rejectError = (error: Error) => {
        reject(error);
      };
      this.pending.set(id, { resolve: resolveUnknown, reject: rejectError, timeout });

      this.socket?.send(payload, (error) => {
        if (error) {
          clearTimeout(timeout);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  async close(): Promise<void> {
    await this.serverReady.catch(() => undefined);
    if (this.socket && this.socket.readyState === WS_OPEN) {
      this.socket.close(1000, 'Server shutting down');
    }

    await new Promise<void>((resolve) => {
      this.wsServer.close(() => resolve());
    });

    await new Promise<void>((resolve) => {
      this.httpServer.close(() => resolve());
    });
  }

  private getEventsSlice<T extends { id: number }>(
    events: T[],
    sinceId: number | undefined,
    limit: number
  ): T[] {
    const filtered = sinceId ? events.filter((event) => event.id > sinceId) : [...events];
    if (filtered.length <= limit) {
      return filtered;
    }
    return filtered.slice(filtered.length - limit);
  }

  private attachSocket(socket: WebSocket): void {
    if (this.socket && this.socket.readyState === WS_OPEN) {
      this.socket.close(1000, 'Replaced by a new connection');
    }

    this.socket = socket;

    socket.on('message', (data) => {
      this.handleMessage(data);
    });

    socket.on('close', () => {
      this.handleDisconnect();
    });

    socket.on('error', () => {
      this.handleDisconnect();
    });

    for (const waiter of this.connectionWaiters) {
      clearTimeout(waiter.timeout);
      waiter.resolve();
    }
    this.connectionWaiters.clear();
  }

  private handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    if (req.method === 'GET' && req.url === '/healthz') {
      const payload = JSON.stringify({ status: 'ok' });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      });
      res.end(payload);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }

  private handleDisconnect(): void {
    this.socket = null;
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(`Extension disconnected (pending: ${id})`));
    }
    this.pending.clear();
  }

  private handleMessage(data: RawData): void {
    const text = data.toString();
    const parsed = safeJsonParse(text);
    if (!parsed || !isRecord(parsed)) {
      return;
    }

    if (parsed.type === 'response') {
      this.handleResponse(parsed);
      return;
    }

    if (parsed.type === 'event') {
      this.handleEvent(parsed);
    }
  }

  private handleResponse(message: unknown): void {
    if (!isExtensionResponse(message)) {
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(message.id);

    if (!message.success) {
      pending.reject(new Error(message.error.message));
      return;
    }

    pending.resolve(message.result);
  }

  private handleEvent(message: unknown): void {
    if (!isExtensionEvent(message)) {
      return;
    }

    if (message.event === 'log') {
      this.logCounter += 1;
      const event: LogEvent = {
        id: this.logCounter,
        tabId: message.tabId,
        method: message.method,
        params: message.params,
        timestamp: message.timestamp,
      };
      this.logEvents.push(event);
      this.logEvents = trimEvents(this.logEvents, this.maxEvents);
      for (const listener of this.logListeners) {
        listener(event);
      }
      return;
    }

    if (message.event === 'network') {
      this.networkCounter += 1;
      const event: NetworkEvent = {
        id: this.networkCounter,
        tabId: message.tabId,
        method: message.method,
        params: message.params,
        timestamp: message.timestamp,
      };
      this.networkEvents.push(event);
      this.networkEvents = trimEvents(this.networkEvents, this.maxEvents);
      for (const listener of this.networkListeners) {
        listener(event);
      }
    }
  }
}

function trimEvents<T>(events: T[], maxEvents: number): T[] {
  if (events.length <= maxEvents) {
    return events;
  }
  return events.slice(events.length - maxEvents);
}

function safeJsonParse(input: string): unknown | null {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isExtensionResponse(value: unknown): value is ExtensionResponse {
  if (!isRecord(value)) {
    return false;
  }
  if (value.type !== 'response') {
    return false;
  }
  if (typeof value.id !== 'string') {
    return false;
  }
  if (typeof value.success !== 'boolean') {
    return false;
  }
  if (value.success) {
    return true;
  }
  const error = value.error;
  return isRecord(error) && typeof error.message === 'string';
}

function isExtensionEvent(value: unknown): value is ExtensionEventMessage {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.type === 'event' &&
    (value.event === 'log' || value.event === 'network') &&
    typeof value.tabId === 'number' &&
    typeof value.method === 'string' &&
    typeof value.timestamp === 'string'
  );
}
