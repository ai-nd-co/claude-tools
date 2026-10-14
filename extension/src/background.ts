const WS_URL = 'ws://127.0.0.1:7331';
const HEALTH_URL = 'http://127.0.0.1:7331/healthz';
const RECONNECT_DELAY_MS = 1000;
const HEALTH_TIMEOUT_MS = 1000;
const WS_OPEN = 1;

interface TabInfo {
  id: number;
  title?: string;
  url?: string;
  windowId: number;
  active: boolean;
}

interface RemoteObject {
  type: string;
  subtype?: string;
  value?: unknown;
  description?: string;
}

interface ExceptionDetails {
  text: string;
  lineNumber: number;
  columnNumber: number;
  url?: string;
  exception?: RemoteObject;
  stackTrace?: {
    callFrames: Array<{
      functionName: string;
      url: string;
      lineNumber: number;
      columnNumber: number;
    }>;
  };
}

interface RuntimeEvaluateResponse {
  result: RemoteObject;
  exceptionDetails?: ExceptionDetails;
}

interface DomGetDocumentResponse {
  root: {
    nodeId: number;
  };
}

interface DomGetOuterHtmlResponse {
  outerHTML: string;
}

interface NetworkGetResponseBodyResponse {
  body: string;
  base64Encoded: boolean;
}

type ExtensionMethod =
  | 'listTabs'
  | 'attachTab'
  | 'detachTab'
  | 'evalJs'
  | 'getOuterHtml'
  | 'enableLog'
  | 'enableNetwork'
  | 'getResponseBody';

type ExtensionRequest = {
  type: 'request';
  id: string;
  method: ExtensionMethod;
  params: Record<string, unknown>;
};

type ExtensionResponse =
  | {
      type: 'response';
      id: string;
      success: true;
      result: unknown;
    }
  | {
      type: 'response';
      id: string;
      success: false;
      error: { message: string };
    };

type ExtensionEvent = {
  type: 'event';
  event: 'log' | 'network';
  tabId: number;
  method: string;
  params?: unknown;
  timestamp: string;
};

let socket: WebSocket | null = null;
let reconnectTimer: number | null = null;
let connectInProgress = false;

const attachedTabs = new Set<number>();
const logEnabledTabs = new Set<number>();
const networkEnabledTabs = new Set<number>();

startBridgeDiscovery();

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (!tabId) {
    return;
  }

  if (method === 'Runtime.consoleAPICalled' || method === 'Log.entryAdded') {
    if (!logEnabledTabs.has(tabId)) {
      return;
    }
    sendEvent({
      type: 'event',
      event: 'log',
      tabId,
      method,
      params: params ?? null,
      timestamp: new Date().toISOString()
    });
    return;
  }

  if (method.startsWith('Network.')) {
    if (!networkEnabledTabs.has(tabId)) {
      return;
    }
    sendEvent({
      type: 'event',
      event: 'network',
      tabId,
      method,
      params: params ?? null,
      timestamp: new Date().toISOString()
    });
  }
});

chrome.debugger.onDetach.addListener((source) => {
  const tabId = source.tabId;
  if (!tabId) {
    return;
  }
  attachedTabs.delete(tabId);
  logEnabledTabs.delete(tabId);
  networkEnabledTabs.delete(tabId);
});

function startBridgeDiscovery(): void {
  scheduleHealthCheck(0);
}

function connectSocket(): void {
  connectInProgress = true;
  const ws = new WebSocket(WS_URL);
  socket = ws;

  ws.onopen = () => {
    connectInProgress = false;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  ws.onmessage = (event) => {
    void handleIncomingMessage(event.data);
  };

  ws.onclose = () => {
    connectInProgress = false;
    scheduleHealthCheck(RECONNECT_DELAY_MS);
  };

  ws.onerror = () => {
    connectInProgress = false;
    scheduleHealthCheck(RECONNECT_DELAY_MS);
  };
}

function scheduleHealthCheck(delayMs: number): void {
  if (reconnectTimer !== null) {
    return;
  }
  reconnectTimer = setTimeout(() => {
    void pollAndConnect();
  }, delayMs);
}

async function pollAndConnect(): Promise<void> {
  reconnectTimer = null;
  if (socket && socket.readyState === WS_OPEN) {
    return;
  }
  if (connectInProgress) {
    scheduleHealthCheck(RECONNECT_DELAY_MS);
    return;
  }
  const isAvailable = await checkBridgeHealth();
  if (isAvailable) {
    connectSocket();
    return;
  }
  scheduleHealthCheck(RECONNECT_DELAY_MS);
}

async function checkBridgeHealth(): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(HEALTH_URL, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function handleIncomingMessage(data: unknown): Promise<void> {
  const text = await decodeMessage(data);
  if (!text) {
    return;
  }
  const parsed = safeJsonParse(text);
  if (!parsed || typeof parsed !== 'object') {
    return;
  }

  const message = parsed as ExtensionRequest;
  if (message.type !== 'request' || typeof message.id !== 'string') {
    return;
  }

  try {
    const result = await handleRequest(message);
    sendResponse({
      type: 'response',
      id: message.id,
      success: true,
      result
    });
  } catch (error) {
    const errMessage = error instanceof Error ? error.message : 'Unknown error';
    sendResponse({
      type: 'response',
      id: message.id,
      success: false,
      error: { message: errMessage }
    });
  }
}

async function handleRequest(message: ExtensionRequest): Promise<unknown> {
  switch (message.method) {
    case 'listTabs':
      return listTabs();
    case 'attachTab':
      return attachTab(getNumberParam(message.params, 'tabId'));
    case 'detachTab':
      return detachTab(getNumberParam(message.params, 'tabId'));
    case 'evalJs':
      {
        const tabId = getNumberParam(message.params, 'tabId');
        const expression = getStringParam(message.params, 'expression');
        const returnByValue = getOptionalBooleanParam(message.params, 'returnByValue');
        const awaitPromise = getOptionalBooleanParam(message.params, 'awaitPromise');
        const args: { tabId: number; expression: string; returnByValue?: boolean; awaitPromise?: boolean } = {
          tabId,
          expression
        };
        if (returnByValue !== undefined) {
          args.returnByValue = returnByValue;
        }
        if (awaitPromise !== undefined) {
          args.awaitPromise = awaitPromise;
        }
        return evalJs(args);
      }
    case 'getOuterHtml':
      return getOuterHtml(getNumberParam(message.params, 'tabId'));
    case 'enableLog':
      return enableLog(getNumberParam(message.params, 'tabId'));
    case 'enableNetwork':
      return enableNetwork(getNumberParam(message.params, 'tabId'));
    case 'getResponseBody':
      return getResponseBody({
        tabId: getNumberParam(message.params, 'tabId'),
        requestId: getStringParam(message.params, 'requestId')
      });
    default:
      throw new Error(`Unknown method: ${message.method}`);
  }
}

async function listTabs(): Promise<{ tabs: TabInfo[] }> {
  const tabs = await chromeCall<chrome.tabs.Tab[]>((cb) => chrome.tabs.query({}, cb));
  const result = tabs.flatMap((tab) => {
    if (tab.id === undefined) {
      return [];
    }
    const info: TabInfo = {
      id: tab.id,
      windowId: tab.windowId ?? 0,
      active: tab.active ?? false
    };
    if (tab.title !== undefined) {
      info.title = tab.title;
    }
    if (tab.url !== undefined) {
      info.url = tab.url;
    }
    return [info];
  });
  return { tabs: result };
}

async function attachTab(tabId: number): Promise<{ tabId: number; attached: boolean }> {
  if (!attachedTabs.has(tabId)) {
    await chromeCallVoid((cb) => chrome.debugger.attach({ tabId }, '1.3', cb));
    attachedTabs.add(tabId);
  }

  await debuggerCommand<Record<string, never>>(tabId, 'Runtime.enable');
  await debuggerCommand<Record<string, never>>(tabId, 'DOM.enable');

  return { tabId, attached: true };
}

async function detachTab(tabId: number): Promise<{ tabId: number; detached: boolean }> {
  if (attachedTabs.has(tabId)) {
    await chromeCallVoid((cb) => chrome.debugger.detach({ tabId }, cb));
    attachedTabs.delete(tabId);
    logEnabledTabs.delete(tabId);
    networkEnabledTabs.delete(tabId);
  }
  return { tabId, detached: true };
}

async function evalJs(args: {
  tabId: number;
  expression: string;
  returnByValue?: boolean;
  awaitPromise?: boolean;
}): Promise<{ tabId: number; result: RemoteObject; exceptionDetails?: ExceptionDetails }> {
  await ensureAttached(args.tabId);

  const evalParams: Record<string, unknown> = {
    expression: args.expression,
    returnByValue: args.returnByValue ?? true,
    awaitPromise: args.awaitPromise ?? true
  };

  const response = await debuggerCommand<RuntimeEvaluateResponse>(
    args.tabId,
    'Runtime.evaluate',
    evalParams
  );

  const result: { tabId: number; result: RemoteObject; exceptionDetails?: ExceptionDetails } = {
    tabId: args.tabId,
    result: response.result
  };

  if (response.exceptionDetails !== undefined) {
    result.exceptionDetails = response.exceptionDetails;
  }

  return result;
}

async function getOuterHtml(tabId: number): Promise<{ tabId: number; html: string }> {
  await ensureAttached(tabId);

  const doc = await debuggerCommand<DomGetDocumentResponse>(tabId, 'DOM.getDocument', {
    depth: 0,
    pierce: false
  });

  const outer = await debuggerCommand<DomGetOuterHtmlResponse>(tabId, 'DOM.getOuterHTML', {
    nodeId: doc.root.nodeId
  });

  return { tabId, html: outer.outerHTML };
}

async function enableLog(tabId: number): Promise<{ tabId: number; ok: boolean }> {
  await ensureAttached(tabId);
  await debuggerCommand<Record<string, never>>(tabId, 'Runtime.enable');
  await debuggerCommand<Record<string, never>>(tabId, 'Log.enable');
  logEnabledTabs.add(tabId);
  return { tabId, ok: true };
}

async function enableNetwork(tabId: number): Promise<{ tabId: number; ok: boolean }> {
  await ensureAttached(tabId);
  await debuggerCommand<Record<string, never>>(tabId, 'Network.enable');
  networkEnabledTabs.add(tabId);
  return { tabId, ok: true };
}

async function getResponseBody(args: {
  tabId: number;
  requestId: string;
}): Promise<{ tabId: number; requestId: string; body: string; base64Encoded: boolean }> {
  await ensureAttached(args.tabId);
  const response = await debuggerCommand<NetworkGetResponseBodyResponse>(
    args.tabId,
    'Network.getResponseBody',
    { requestId: args.requestId }
  );
  return {
    tabId: args.tabId,
    requestId: args.requestId,
    body: response.body,
    base64Encoded: response.base64Encoded
  };
}

async function ensureAttached(tabId: number): Promise<void> {
  if (!attachedTabs.has(tabId)) {
    await attachTab(tabId);
  }
}

function sendResponse(message: ExtensionResponse): void {
  sendMessage(message);
}

function sendEvent(message: ExtensionEvent): void {
  sendMessage(message);
}

function sendMessage(message: ExtensionResponse | ExtensionEvent): void {
  if (!socket || socket.readyState !== WS_OPEN) {
    return;
  }
  socket.send(JSON.stringify(message));
}

function getNumberParam(params: Record<string, unknown>, key: string): number {
  const value = params[key];
  if (typeof value !== 'number') {
    throw new Error(`Expected number param: ${key}`);
  }
  return value;
}

function getStringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string') {
    throw new Error(`Expected string param: ${key}`);
  }
  return value;
}

function getOptionalBooleanParam(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new Error(`Expected boolean param: ${key}`);
  }
  return value;
}

function safeJsonParse(input: string): unknown | null {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return null;
  }
}

async function decodeMessage(data: unknown): Promise<string | null> {
  if (typeof data === 'string') {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }
  if (data instanceof Blob) {
    return await data.text();
  }
  return null;
}

function chromeCall<T>(fn: (cb: (result: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    fn((result) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(result);
    });
  });
}

function chromeCallVoid(fn: (cb: () => void) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    fn(() => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve();
    });
  });
}

function debuggerCommand<TResult>(
  tabId: number,
  method: string,
  params?: Record<string, unknown>
): Promise<TResult> {
  return chromeCall<TResult>((cb) =>
    chrome.debugger.sendCommand({ tabId }, method, params, (result) =>
      cb(result as TResult)
    )
  );
}
