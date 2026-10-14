/**
 * Conversation class for manipulating Claude Code conversation files
 *
 * Provides a clean API for loading, manipulating, and saving conversations
 * while handling the complexity of chain management, timestamps, and validation.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { Message, AssistantMessage, getAllToolUseIds, getAllToolResultIds, ToolResultBlock } from './Message.js';

export interface ConversationOptions {
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
}

export interface TruncateOptions {
  maxLength?: number;
  targets?: {
    toolResults?: boolean;
    toolInputs?: boolean;
    thinking?: boolean;
    originalFile?: boolean;
    stdout?: boolean;
    stderr?: boolean;
  };
  marker?: string;
}

export interface ValidationError {
  rule: string;
  message: string;
  messageIndex?: number;
  messageUuid?: string;
}

const COMPACTED_MARKER = '...COMPACTED...';

export class Conversation {
  private _messages: Message[] = [];
  private _sessionId: string;
  private _cwd: string;
  private _gitBranch: string;
  private _version: string;
  private _filePath: string | null = null;

  private constructor(options: ConversationOptions = {}) {
    this._sessionId = options.sessionId || uuidv4();
    this._cwd = options.cwd || process.cwd();
    this._gitBranch = options.gitBranch || 'master';
    this._version = options.version || '2.0.74';
  }

  // ==================== Static Factory Methods ====================

  /**
   * Load conversation from JSONL file
   */
  static load(filePath: string): Conversation {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    const messages: Message[] = [];
    for (let i = 0; i < lines.length; i++) {
      try {
        messages.push(JSON.parse(lines[i]) as Message);
      } catch (e) {
        // Skip invalid JSON lines (corrupted or malformed entries)
        console.warn(`Skipping invalid JSON at line ${i + 1} in ${filePath}: ${(e as Error).message}`);
      }
    }

    // Extract session metadata from first user message
    const firstUser = messages.find(m => m.type === 'user');
    const conv = new Conversation({
      sessionId: firstUser?.sessionId || path.basename(filePath, '.jsonl'),
      cwd: firstUser?.cwd,
      gitBranch: firstUser?.gitBranch,
      version: firstUser?.version,
    });

    conv._messages = messages;
    conv._filePath = filePath;

    return conv;
  }

  /**
   * Create conversation from raw messages array
   */
  static fromMessages(messages: Message[], options: ConversationOptions = {}): Conversation {
    const firstUser = messages.find(m => m.type === 'user');
    const conv = new Conversation({
      sessionId: options.sessionId || firstUser?.sessionId || uuidv4(),
      cwd: options.cwd || firstUser?.cwd,
      gitBranch: options.gitBranch || firstUser?.gitBranch,
      version: options.version || firstUser?.version,
    });

    conv._messages = [...messages];
    return conv;
  }

  /**
   * Create empty conversation with session metadata
   */
  static create(options: ConversationOptions = {}): Conversation {
    return new Conversation(options);
  }

  // ==================== Properties ====================

  get sessionId(): string {
    return this._sessionId;
  }

  get cwd(): string {
    return this._cwd;
  }

  get filePath(): string | null {
    return this._filePath;
  }

  get messages(): ReadonlyArray<Message> {
    return this._messages;
  }

  get length(): number {
    return this._messages.length;
  }

  get size(): number {
    return this._messages.reduce((sum, m) => sum + JSON.stringify(m).length, 0);
  }

  // ==================== Query Methods ====================

  /**
   * Get root message (parentUuid = null)
   */
  getRoot(): Message | null {
    return this._messages.find(m => m.parentUuid === null && (m.type === 'user' || m.type === 'assistant')) || null;
  }

  /**
   * Get leaf message (newest timestamp among user/assistant messages)
   */
  getLeaf(): Message | null {
    const conversationMsgs = this._messages.filter(m => m.type === 'user' || m.type === 'assistant');
    if (conversationMsgs.length === 0) return null;

    return conversationMsgs.reduce((newest, msg) => {
      if (!newest) return msg;
      return new Date(msg.timestamp) > new Date(newest.timestamp) ? msg : newest;
    }, null as Message | null);
  }

  /**
   * Get active chain (from root to leaf following parentUuid)
   */
  getChain(): Message[] {
    const leaf = this.getLeaf();
    if (!leaf) return [];

    const byUuid = new Map<string, Message>();
    for (const m of this._messages) {
      if (m.uuid) byUuid.set(m.uuid, m);
    }

    // Trace back from leaf to root
    const chain: Message[] = [];
    let current: Message | undefined = leaf;
    while (current) {
      chain.unshift(current);
      if (!current.parentUuid) break;
      current = byUuid.get(current.parentUuid);
    }

    return chain;
  }

  /**
   * Find message by UUID
   */
  findByUuid(uuid: string): Message | null {
    return this._messages.find(m => m.uuid === uuid) || null;
  }

  /**
   * Get message at index
   */
  at(index: number): Message | null {
    return this._messages[index] || null;
  }

  /**
   * Filter messages by predicate
   */
  filter(predicate: (msg: Message) => boolean): Message[] {
    return this._messages.filter(predicate);
  }

  /**
   * Get all tool_use IDs in the conversation
   */
  getToolUseIds(): Set<string> {
    const ids = new Set<string>();
    for (const msg of this._messages) {
      if (msg.type === 'assistant') {
        for (const id of getAllToolUseIds(msg)) {
          ids.add(id);
        }
      }
    }
    return ids;
  }

  // ==================== Manipulation Methods ====================

  /**
   * Append message at the end (updates parentUuid to previous message)
   */
  append(message: Message): this {
    const lastMsg = this._messages[this._messages.length - 1];
    message.parentUuid = lastMsg?.uuid || null;
    message.sessionId = this._sessionId;
    this._messages.push(message);
    return this;
  }

  /**
   * Append multiple messages at the end
   */
  appendAll(messages: Message[]): this {
    for (const msg of messages) {
      this.append(msg);
    }
    return this;
  }

  /**
   * Insert message after specific UUID
   */
  insertAfter(uuid: string, message: Message): this {
    const index = this._messages.findIndex(m => m.uuid === uuid);
    if (index === -1) {
      throw new Error(`Message with uuid ${uuid} not found`);
    }

    message.parentUuid = uuid;
    message.sessionId = this._sessionId;
    this._messages.splice(index + 1, 0, message);

    return this;
  }

  /**
   * Insert summary assistant message after first user message
   */
  insertSummary(summaryText: string): this {
    const firstUserIndex = this._messages.findIndex(m => m.type === 'user');
    if (firstUserIndex === -1) {
      throw new Error('No user message found to insert summary after');
    }

    const firstUser = this._messages[firstUserIndex];
    const summary = AssistantMessage.summary(summaryText, {
      sessionId: this._sessionId,
      cwd: this._cwd,
      gitBranch: this._gitBranch,
      version: this._version,
    });

    summary.parentUuid = firstUser.uuid;
    this._messages.splice(firstUserIndex + 1, 0, summary);

    return this;
  }

  /**
   * Remove messages by index range [startIndex, endIndex)
   */
  removeRange(startIndex: number, endIndex: number): this {
    this._messages.splice(startIndex, endIndex - startIndex);
    return this;
  }

  /**
   * Remove messages by predicate
   */
  removeWhere(predicate: (msg: Message) => boolean): this {
    this._messages = this._messages.filter(m => !predicate(m));
    return this;
  }

  /**
   * Split conversation at N% (by bytes of user/assistant messages)
   * Returns [first, second] - two conversations
   * - first: for summarization (first N% of conversation messages)
   * - second: to append after summary (last (100-N)%)
   *
   * Metadata (file-history-snapshot, queue-operation, summary) is NOT included.
   * These take up 80-90% of file size and are not needed for forked sessions.
   *
   * Smart split: ensures we don't cut between tool_use and tool_result pairs
   */
  splitAt(percent: number): [Conversation, Conversation] {
    // Use ONLY messages from the active chain, not all messages
    // This ensures we don't include messages from abandoned branches
    const activeChain = this.getChain();
    const conversationMsgs = activeChain.filter(m => m.type === 'user' || m.type === 'assistant');

    // No metadata - it's not needed for forked sessions and takes up 80-90% of file size

    const totalBytes = conversationMsgs.reduce((sum, m) => sum + JSON.stringify(m).length, 0);
    const cutoffBytes = totalBytes * (percent / 100);

    let cumulative = 0;
    let cutoffIndex = conversationMsgs.length;
    for (let i = 0; i < conversationMsgs.length; i++) {
      cumulative += JSON.stringify(conversationMsgs[i]).length;
      if (cumulative >= cutoffBytes) {
        cutoffIndex = i;
        break;
      }
    }

    // Smart adjustment: find a clean split point where:
    // 1. We don't break tool_use/tool_result pairs
    // 2. Second part starts with a user message (for proper alternation after summary)
    // 3. First part doesn't end with an orphan tool_use
    //
    // Strategy: advance cutoffIndex until we land on a user message that is NOT
    // a tool_result for a tool_use in the first part
    while (cutoffIndex < conversationMsgs.length) {
      const msgAtCutoff = conversationMsgs[cutoffIndex];

      // We want second part to start with user
      if (msgAtCutoff.type === 'user') {
        // Check if this user message is a tool_result for a tool_use we'd be cutting
        const toolResultIds = getAllToolResultIds(msgAtCutoff);
        if (toolResultIds.length > 0 && cutoffIndex > 0) {
          // Check if previous message has the matching tool_use
          const prevMsg = conversationMsgs[cutoffIndex - 1];
          if (prevMsg.type === 'assistant') {
            const toolUseIds = getAllToolUseIds(prevMsg);
            if (toolResultIds.some(id => toolUseIds.includes(id))) {
              // This user is a tool_result for previous assistant's tool_use
              // Include both in first part, continue searching
              cutoffIndex++;
              continue;
            }
          }
        }
        // This is a clean user message to start second part
        break;
      }

      // Current is assistant - include it in first part and continue
      cutoffIndex++;

      // If this assistant has tool_use, also include the following tool_result
      if (cutoffIndex < conversationMsgs.length) {
        const prevMsg = conversationMsgs[cutoffIndex - 1];
        const toolUseIds = getAllToolUseIds(prevMsg);
        if (toolUseIds.length > 0) {
          const nextMsg = conversationMsgs[cutoffIndex];
          if (nextMsg.type === 'user') {
            const resultIds = getAllToolResultIds(nextMsg);
            if (resultIds.some(id => toolUseIds.includes(id))) {
              cutoffIndex++; // Include the tool_result with its tool_use
            }
          }
        }
      }
    }

    // FINAL CHECK: Ensure first part doesn't end with orphan tool_use
    // If it does, move the orphan message(s) to second part
    while (cutoffIndex > 0) {
      const lastMsg = conversationMsgs[cutoffIndex - 1];
      if (lastMsg.type !== 'assistant') break;

      const toolUseIds = getAllToolUseIds(lastMsg);
      if (toolUseIds.length === 0) break;

      // Check if there's a matching tool_result in the first part (before cutoffIndex)
      let hasMatchingResult = false;
      for (let i = 0; i < cutoffIndex; i++) {
        const msg = conversationMsgs[i];
        if (msg.type === 'user') {
          const resultIds = getAllToolResultIds(msg);
          if (resultIds.some(id => toolUseIds.includes(id))) {
            hasMatchingResult = true;
            break;
          }
        }
      }

      if (hasMatchingResult) break;

      // No matching result found - this is an orphan tool_use
      // Move it to second part by decrementing cutoffIndex
      cutoffIndex--;
    }

    // First part: just conversation messages for summarization
    const first = Conversation.fromMessages(conversationMsgs.slice(0, cutoffIndex), {
      sessionId: this._sessionId,
      cwd: this._cwd,
      gitBranch: this._gitBranch,
      version: this._version,
    });

    // Second part: remaining conversation messages only (no metadata)
    const secondMsgs = conversationMsgs.slice(cutoffIndex);
    const second = Conversation.fromMessages(secondMsgs, {
      sessionId: this._sessionId,
      cwd: this._cwd,
      gitBranch: this._gitBranch,
      version: this._version,
    });

    return [first, second];
  }

  /**
   * Truncate large outputs in messages
   */
  truncateOutputs(options: TruncateOptions = {}): this {
    const maxLen = options.maxLength || 200;
    const marker = options.marker || COMPACTED_MARKER;
    const targets = {
      toolResults: true,
      toolInputs: true,
      thinking: true,
      originalFile: true,
      stdout: true,
      stderr: true,
      ...options.targets,
    };

    const truncate = (content: string, max: number): string => {
      if (content.length <= max) return content;
      const keepEach = Math.max(10, Math.floor(max / 2));
      return content.slice(0, keepEach) + `\n\n${marker}\n\n` + content.slice(-keepEach);
    };

    for (const msg of this._messages) {
      // Remove originalFile entirely (biggest space saver)
      if (targets.originalFile && msg.toolUseResult?.originalFile) {
        delete msg.toolUseResult.originalFile;
      }

      // Truncate stdout/stderr
      if (targets.stdout && msg.toolUseResult?.stdout && msg.toolUseResult.stdout.length > maxLen) {
        msg.toolUseResult.stdout = truncate(msg.toolUseResult.stdout, maxLen);
      }
      if (targets.stderr && msg.toolUseResult?.stderr && msg.toolUseResult.stderr.length > maxLen) {
        msg.toolUseResult.stderr = truncate(msg.toolUseResult.stderr, maxLen);
      }

      // Truncate file content
      if (msg.toolUseResult?.file?.content && msg.toolUseResult.file.content.length > maxLen) {
        msg.toolUseResult.file.content = truncate(msg.toolUseResult.file.content, maxLen);
      }

      // Truncate message content blocks
      if (msg.message?.content && Array.isArray(msg.message.content)) {
        for (const block of msg.message.content as unknown as Record<string, unknown>[]) {
          // Tool results
          if (targets.toolResults && block.type === 'tool_result' && typeof block.content === 'string' && block.content.length > maxLen) {
            block.content = truncate(block.content as string, maxLen);
          }
          // Thinking blocks
          if (targets.thinking && block.type === 'thinking' && typeof block.thinking === 'string' && (block.thinking as string).length > maxLen) {
            block.thinking = truncate(block.thinking as string, maxLen);
          }
          // Tool use inputs
          if (targets.toolInputs && block.type === 'tool_use' && block.input) {
            const input = block.input as Record<string, unknown>;
            if (typeof input.command === 'string' && input.command.length > maxLen) {
              input.command = truncate(input.command, maxLen);
            }
            if (typeof input.content === 'string' && input.content.length > maxLen) {
              input.content = truncate(input.content, maxLen);
            }
            if (typeof input.old_string === 'string' && input.old_string.length > maxLen) {
              input.old_string = truncate(input.old_string, maxLen);
            }
            if (typeof input.new_string === 'string' && input.new_string.length > maxLen) {
              input.new_string = truncate(input.new_string, maxLen);
            }
          }
        }
      }
    }

    return this;
  }

  // ==================== Chain Management ====================

  /**
   * Rebuild parentUuid chain from first message
   * Each message points to the previous one
   */
  rebuildChain(): this {
    let previousUuid: string | null = null;

    for (const msg of this._messages) {
      // Skip metadata messages
      if (msg.type === 'summary' || msg.type === 'file-history-snapshot' || msg.type === 'queue-operation') {
        continue;
      }

      msg.parentUuid = previousUuid;
      previousUuid = msg.uuid;
    }

    return this;
  }

  /**
   * Update timestamps to be sequential (ensures newest is displayed)
   */
  updateTimestamps(startTime?: Date): this {
    let ts = startTime ? startTime.getTime() : Date.now();

    for (const msg of this._messages) {
      // Skip metadata messages
      if (msg.type === 'summary' || msg.type === 'file-history-snapshot' || msg.type === 'queue-operation') {
        continue;
      }

      msg.timestamp = new Date(ts).toISOString();
      ts += 100; // Each message 100ms later
    }

    return this;
  }

  /**
   * Remove orphan tool_use (no matching result) and orphan tool_results (no matching use)
   */
  filterOrphans(): this {
    // First pass: collect all tool_use IDs and tool_result IDs
    const toolUseIds = new Set<string>();
    const toolResultIds = new Set<string>();

    for (const msg of this._messages) {
      if (msg.type === 'assistant') {
        for (const id of getAllToolUseIds(msg)) {
          toolUseIds.add(id);
        }
      }
      if (msg.type === 'user' && msg.message?.content && Array.isArray(msg.message.content)) {
        for (const block of msg.message.content as unknown as Record<string, unknown>[]) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            toolResultIds.add(block.tool_use_id as string);
          }
        }
      }
    }

    // Second pass: filter out orphan tool_use from assistant messages
    this._messages = this._messages.filter(msg => {
      if (msg.type === 'assistant' && msg.message?.content && Array.isArray(msg.message.content)) {
        const content = msg.message.content as unknown as Record<string, unknown>[];

        // Filter out orphan tool_use (no matching result)
        const filteredContent = content.filter(block => {
          if (block.type === 'tool_use') {
            const toolId = block.id as string;
            return toolResultIds.has(toolId);
          }
          return true;
        });

        // If all content was filtered out, remove the message
        if (filteredContent.length === 0) {
          return false;
        }

        // Update content
        (msg.message as Record<string, unknown>).content = filteredContent;
      }
      return true;
    });

    // Third pass: filter out orphan tool_results from user messages
    // Recollect tool_use IDs after filtering
    const remainingToolUseIds = new Set<string>();
    for (const msg of this._messages) {
      if (msg.type === 'assistant') {
        for (const id of getAllToolUseIds(msg)) {
          remainingToolUseIds.add(id);
        }
      }
    }

    this._messages = this._messages.filter(msg => {
      if (msg.type !== 'user') return true;

      if (msg.message?.content && Array.isArray(msg.message.content)) {
        const content = msg.message.content as unknown as Record<string, unknown>[];

        // Filter out orphan tool_results
        const filteredContent = content.filter(block => {
          if (block.type === 'tool_result') {
            const toolUseId = block.tool_use_id as string;
            return remainingToolUseIds.has(toolUseId);
          }
          return true;
        });

        // If all content was filtered out, remove the message
        if (filteredContent.length === 0) {
          return false;
        }

        // Update content
        (msg.message as Record<string, unknown>).content = filteredContent;

        // Also remove toolUseResult if it's orphaned
        if (msg.toolUseResult && filteredContent.length === 0) {
          delete msg.toolUseResult;
        }
      }

      return true;
    });

    // Fourth pass: remove ALL metadata messages
    // These are Claude Code internal state and should not be included in forked/compacted sessions:
    // - summary: Native compaction summaries (we generate our own as type: 'assistant')
    // - file-history-snapshot: Undo/revert file backups (takes up 80-90% of file size!)
    // - queue-operation: Pending tool execution tracking
    this._messages = this._messages.filter(msg =>
      msg.type !== 'summary' &&
      msg.type !== 'file-history-snapshot' &&
      msg.type !== 'queue-operation'
    );

    // Fifth pass: strip usage stats from assistant messages
    // This prevents Claude Code from using cached token counts from before compaction
    // The API will recalculate tokens fresh on next request
    for (const msg of this._messages) {
      if (msg.type === 'assistant' && msg.message) {
        delete (msg.message as Record<string, unknown>).usage;
      }
    }

    return this;
  }

  /**
   * Update session ID in all messages
   */
  updateSessionId(newSessionId?: string): this {
    this._sessionId = newSessionId || uuidv4();

    for (const msg of this._messages) {
      if (msg.sessionId !== undefined) {
        msg.sessionId = this._sessionId;
      }
    }

    return this;
  }

  // ==================== Validation ====================

  /**
   * Validate conversation structure
   * Throws ValidationError if invalid
   */
  validate(): this {
    const errors = this.getErrors();
    if (errors.length > 0) {
      throw new Error(`Conversation validation failed: ${errors.map(e => e.message).join(', ')}`);
    }
    return this;
  }

  /**
   * Check if valid (returns boolean instead of throwing)
   */
  isValid(): boolean {
    return this.getErrors().length === 0;
  }

  /**
   * Get validation errors
   */
  getErrors(): ValidationError[] {
    const errors: ValidationError[] = [];

    // Filter to conversation messages
    const convMsgs = this._messages.filter(m => m.type === 'user' || m.type === 'assistant');

    // Rule 1: Root must exist
    const root = convMsgs.find(m => m.parentUuid === null);
    if (!root) {
      errors.push({
        rule: 'ROOT_EXISTS',
        message: 'Root message must exist (parentUuid = null)',
      });
    }

    // Rule 2: Root must be user type
    if (root && root.type !== 'user') {
      errors.push({
        rule: 'ROOT_IS_USER',
        message: `Root message must be type "user", got "${root.type}"`,
        messageUuid: root.uuid,
      });
    }

    // Rule 3: All parentUuid references must exist
    const uuids = new Set(this._messages.map(m => m.uuid).filter(Boolean));
    for (let i = 0; i < convMsgs.length; i++) {
      const msg = convMsgs[i];
      if (msg.parentUuid && !uuids.has(msg.parentUuid)) {
        errors.push({
          rule: 'CHAIN_VALID',
          message: `Message ${msg.uuid?.slice(0, 8)} references non-existent parent ${msg.parentUuid?.slice(0, 8)}`,
          messageIndex: i,
          messageUuid: msg.uuid,
        });
      }
    }

    // Rule 4: Tool results must have matching tool_use
    const toolUseIds = this.getToolUseIds();
    for (let i = 0; i < convMsgs.length; i++) {
      const msg = convMsgs[i];
      if (msg.type === 'user') {
        for (const toolResultId of getAllToolResultIds(msg)) {
          if (!toolUseIds.has(toolResultId)) {
            errors.push({
              rule: 'TOOL_RESULT_HAS_USE',
              message: `Tool result ${toolResultId.slice(0, 8)} has no matching tool_use`,
              messageIndex: i,
              messageUuid: msg.uuid,
            });
          }
        }
      }
    }

    return errors;
  }

  // ==================== Saving ====================

  /**
   * Save to JSONL file
   */
  save(filePath: string): this {
    const content = this._messages.map(m => JSON.stringify(m)).join('\n') + '\n';
    fs.writeFileSync(filePath, content, 'utf-8');
    this._filePath = filePath;
    return this;
  }

  /**
   * Export to JSONL string
   */
  toJSONL(): string {
    return this._messages.map(m => JSON.stringify(m)).join('\n') + '\n';
  }

  /**
   * Get raw messages array (for compatibility)
   */
  toMessages(): Message[] {
    return [...this._messages];
  }

  /**
   * Clone the conversation
   */
  clone(): Conversation {
    const cloned = new Conversation({
      sessionId: this._sessionId,
      cwd: this._cwd,
      gitBranch: this._gitBranch,
      version: this._version,
    });
    cloned._messages = JSON.parse(JSON.stringify(this._messages));
    cloned._filePath = this._filePath;
    return cloned;
  }
}

// ==================== Utility Functions ====================

/**
 * Find session file by session ID across all projects
 */
export function findSessionFile(sessionId: string): string | null {
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');

  if (!fs.existsSync(claudeDir)) {
    return null;
  }

  const projects = fs.readdirSync(claudeDir).filter(f =>
    fs.statSync(path.join(claudeDir, f)).isDirectory()
  );

  for (const project of projects) {
    const filePath = path.join(claudeDir, project, `${sessionId}.jsonl`);
    if (fs.existsSync(filePath)) {
      return filePath;
    }
  }

  return null;
}

/**
 * Get projects directory for a given project path
 */
export function getProjectsDir(projectPath: string): string {
  const encoded = projectPath.replace(/[/\\:]/g, '-').replace(/^-+/, '');
  return path.join(os.homedir(), '.claude', 'projects', encoded);
}

/**
 * Add session to Claude's history
 */
export function addToHistory(sessionId: string, project: string, displayText: string = 'Session'): void {
  const historyPath = path.join(os.homedir(), '.claude', 'history.jsonl');

  const entry = {
    display: displayText,
    pastedContents: {},
    timestamp: Date.now(),
    project,
    sessionId,
  };

  fs.appendFileSync(historyPath, JSON.stringify(entry) + '\n', 'utf8');
}
