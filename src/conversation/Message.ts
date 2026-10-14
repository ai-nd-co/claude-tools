/**
 * Message types and interfaces for Claude Code conversations
 */

import { v4 as uuidv4 } from 'uuid';

// Content block types
export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock;

// Tool use result metadata (attached to user messages)
export interface ToolUseResult {
  type?: string;
  filePath?: string;
  file?: {
    content?: string;
    filePath?: string;
    numLines?: number;
    startLine?: number;
    totalLines?: number;
  };
  originalFile?: string;
  stdout?: string;
  stderr?: string;
  content?: unknown;
  oldString?: string;
  newString?: string;
  structuredPatch?: string;
}

// Base message interface
export interface Message {
  type: 'user' | 'assistant' | 'summary' | 'file-history-snapshot' | 'queue-operation';
  uuid: string;
  parentUuid: string | null;
  timestamp: string;
  sessionId: string;
  message?: {
    role: 'user' | 'assistant';
    content: string | ContentBlock[];
    // Full API response fields (for assistant messages)
    model?: string;
    id?: string;
    type?: string;
    stop_reason?: string | null;
    stop_sequence?: string | null;
    usage?: {
      input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      output_tokens?: number;
      service_tier?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  // User message specific
  cwd?: string;
  version?: string;
  gitBranch?: string;
  isSidechain?: boolean;
  userType?: string;
  toolUseResult?: ToolUseResult;
  todos?: unknown[];
  slug?: string;
  // Summary specific
  summary?: string;
  leafUuid?: string;
  // File history specific
  snapshot?: unknown;
  messageId?: string;
  isSnapshotUpdate?: boolean;
  // Queue operation specific
  operation?: string;
  data?: unknown;
  // Assistant specific
  requestId?: string;
  // Allow additional properties
  [key: string]: unknown;
}

/**
 * Generate a unique tool_use ID
 */
export function generateToolUseId(): string {
  return `toolu_${uuidv4().replace(/-/g, '').slice(0, 24)}`;
}

/**
 * User message builder
 */
export const UserMessage = {
  /**
   * Create user message with text content
   */
  text(content: string, options: Partial<Message> = {}): Message {
    return {
      type: 'user',
      uuid: uuidv4(),
      parentUuid: null,
      timestamp: new Date().toISOString(),
      sessionId: options.sessionId || '',
      cwd: options.cwd || process.cwd(),
      version: options.version || '2.0.74',
      gitBranch: options.gitBranch || 'master',
      isSidechain: false,
      userType: 'external',
      message: {
        role: 'user',
        content: [{ type: 'text', text: content }],
      },
      ...options,
    };
  },

  /**
   * Create user message with tool result
   */
  toolResult(toolUseId: string, content: string, isError: boolean = false, options: Partial<Message> = {}): Message {
    return {
      type: 'user',
      uuid: uuidv4(),
      parentUuid: null,
      timestamp: new Date().toISOString(),
      sessionId: options.sessionId || '',
      cwd: options.cwd || process.cwd(),
      version: options.version || '2.0.74',
      gitBranch: options.gitBranch || 'master',
      isSidechain: false,
      userType: 'external',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: toolUseId,
          content,
          is_error: isError,
        }],
      },
      ...options,
    };
  },

  /**
   * Create user message with multiple tool results
   */
  toolResults(results: Array<{ toolUseId: string; content: string; isError?: boolean }>, options: Partial<Message> = {}): Message {
    return {
      type: 'user',
      uuid: uuidv4(),
      parentUuid: null,
      timestamp: new Date().toISOString(),
      sessionId: options.sessionId || '',
      cwd: options.cwd || process.cwd(),
      version: options.version || '2.0.74',
      gitBranch: options.gitBranch || 'master',
      isSidechain: false,
      userType: 'external',
      message: {
        role: 'user',
        content: results.map(r => ({
          type: 'tool_result' as const,
          tool_use_id: r.toolUseId,
          content: r.content,
          is_error: r.isError,
        })),
      },
      ...options,
    };
  },
};

/**
 * Helper to create full API response format for assistant messages
 */
function createAssistantMessageFormat(
  content: ContentBlock[],
  stopReason: 'end_turn' | 'tool_use' = 'end_turn'
): Message['message'] {
  return {
    model: 'claude-opus-4-5-20251101',
    id: `msg_${uuidv4().replace(/-/g, '').slice(0, 24)}`,
    type: 'message',
    role: 'assistant',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 0,
      service_tier: 'standard',
    },
  };
}

/**
 * Assistant message builder
 * All methods create messages with full API response format for Claude Code compatibility
 */
export const AssistantMessage = {
  /**
   * Create assistant message with text content
   */
  text(content: string, options: Partial<Message> = {}): Message {
    return {
      type: 'assistant',
      uuid: uuidv4(),
      parentUuid: null,
      timestamp: new Date().toISOString(),
      sessionId: options.sessionId || '',
      requestId: `req_${uuidv4().replace(/-/g, '').slice(0, 24)}`,
      message: createAssistantMessageFormat([{ type: 'text', text: content }], 'end_turn'),
      ...options,
    };
  },

  /**
   * Create assistant message with tool use
   */
  toolUse(name: string, input: Record<string, unknown>, options: Partial<Message> = {}): Message {
    const toolUseId = generateToolUseId();
    return {
      type: 'assistant',
      uuid: uuidv4(),
      parentUuid: null,
      timestamp: new Date().toISOString(),
      sessionId: options.sessionId || '',
      requestId: `req_${uuidv4().replace(/-/g, '').slice(0, 24)}`,
      message: createAssistantMessageFormat([{
        type: 'tool_use',
        id: toolUseId,
        name,
        input,
      }], 'tool_use'),
      _toolUseId: toolUseId, // Store for easy access
      ...options,
    };
  },

  /**
   * Create assistant message with multiple content blocks
   */
  blocks(blocks: ContentBlock[], options: Partial<Message> = {}): Message {
    // Determine stop_reason based on content
    const hasToolUse = blocks.some(b => b.type === 'tool_use');
    return {
      type: 'assistant',
      uuid: uuidv4(),
      parentUuid: null,
      timestamp: new Date().toISOString(),
      sessionId: options.sessionId || '',
      requestId: `req_${uuidv4().replace(/-/g, '').slice(0, 24)}`,
      message: createAssistantMessageFormat(blocks, hasToolUse ? 'tool_use' : 'end_turn'),
      ...options,
    };
  },

  /**
   * Create summary assistant message
   * Uses full API response format that Claude Code expects
   */
  summary(summaryText: string, options: Partial<Message> = {}): Message {
    return {
      type: 'assistant',
      uuid: `summary-${Date.now()}`,
      parentUuid: null,
      timestamp: new Date().toISOString(),
      sessionId: options.sessionId || '',
      requestId: `req_summary_${Date.now()}`,
      message: createAssistantMessageFormat(
        [{ type: 'text', text: `## Summary of Previous Work\n\n${summaryText}` }],
        'end_turn'
      ),
      ...options,
    };
  },
};

/**
 * Get tool_use ID from an assistant message (if it has one)
 */
export function getToolUseId(msg: Message): string | null {
  if (msg._toolUseId) return msg._toolUseId as string;

  if (msg.message?.content && Array.isArray(msg.message.content)) {
    for (const block of msg.message.content) {
      if ((block as ToolUseBlock).type === 'tool_use') {
        return (block as ToolUseBlock).id;
      }
    }
  }
  return null;
}

/**
 * Get all tool_use IDs from an assistant message
 */
export function getAllToolUseIds(msg: Message): string[] {
  const ids: string[] = [];
  if (msg.message?.content && Array.isArray(msg.message.content)) {
    for (const block of msg.message.content) {
      if ((block as ToolUseBlock).type === 'tool_use') {
        ids.push((block as ToolUseBlock).id);
      }
    }
  }
  return ids;
}

/**
 * Get all tool_result IDs from a user message
 */
export function getAllToolResultIds(msg: Message): string[] {
  const ids: string[] = [];
  if (msg.message?.content && Array.isArray(msg.message.content)) {
    for (const block of msg.message.content) {
      if ((block as ToolResultBlock).type === 'tool_result') {
        ids.push((block as ToolResultBlock).tool_use_id);
      }
    }
  }
  return ids;
}
