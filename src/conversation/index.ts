/**
 * Conversation API for Claude Code JSONL files
 *
 * Example usage:
 *
 * ```typescript
 * import { Conversation, UserMessage, AssistantMessage } from './conversation/index.js';
 *
 * // Load, manipulate, save
 * const conv = Conversation.load(filePath);
 * conv
 *   .keepLast(40)           // Keep last 40%
 *   .insertSummary('...')   // Add summary
 *   .filterOrphans()        // Remove orphan tool_results
 *   .rebuildChain()         // Fix parentUuid chain
 *   .updateTimestamps()     // Fix timestamps
 *   .save(newPath);
 *
 * // Create from scratch
 * const conv = Conversation.create({ cwd: '/projects/myapp' });
 * conv
 *   .append(UserMessage.text('Hello'))
 *   .append(AssistantMessage.text('Hi there!'))
 *   .save('new-session.jsonl');
 * ```
 */

export { Conversation, findSessionFile, getProjectsDir, addToHistory } from './Conversation.js';
export type { ConversationOptions, TruncateOptions, ValidationError } from './Conversation.js';

export {
  UserMessage,
  AssistantMessage,
  generateToolUseId,
  getToolUseId,
  getAllToolUseIds,
  getAllToolResultIds,
} from './Message.js';

export type {
  Message,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ThinkingBlock,
  ToolUseResult,
} from './Message.js';
