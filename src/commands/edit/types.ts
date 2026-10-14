// Types for session editing

export interface RawMessage {
  type: string;
  sessionId: string;
  parentUuid: string | null;
  uuid: string;
  timestamp?: string;
  message?: {
    role: string;
    content: string | Array<ContentBlock>;
  };
  toolUseResult?: {
    stdout?: string;
    stderr?: string;
    file?: { content: string; filePath: string };
    content?: Array<{ type: string; text?: string }>;
  };
  [key: string]: unknown;
}

export interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  content?: string | Array<{ type: string; text?: string }>;
  name?: string;
  input?: Record<string, unknown>;
  id?: string;
  tool_use_id?: string;
}

export interface DisplayMessage {
  index: number;
  uuid: string;
  type: 'user' | 'assistant' | 'tool' | 'thinking' | 'other';
  toolName?: string;
  preview: string;
  size: number;
  rawIndex: number; // index in original JSONL array
  relatedRawIndexes?: number[]; // for grouped tool call + result
}

export interface Turn {
  index: number;
  userPrompt: string;           // The user's input that started this turn
  messageCount: number;         // Number of messages in this turn
  toolCalls: string[];          // List of tool names called
  size: number;                 // Total size of all messages in turn
  rawIndexes: number[];         // All raw indexes in this turn
  preview: string;              // Preview of what was done
}

export type MarkType = 'compact' | 'delete' | 'summarize' | null;
