/**
 * Claude Prompt Utility
 *
 * Run prompts through Claude CLI by creating temporary sessions.
 * This bypasses the limitations of piping content to `claude -p`.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import { v4 as uuidv4 } from 'uuid';

export interface PromptOptions {
  /** Model to use: opus, sonnet, haiku (default: opus) */
  model?: string;
  /** Timeout in milliseconds (default: 300000 = 5 minutes) */
  timeout?: number;
  /** Working directory for the session */
  cwd?: string;
}

export interface PromptResult {
  success: boolean;
  output: string;
  error?: string;
  sessionId: string;
}

/**
 * Get Claude's projects directory for a given working directory
 * Claude Code uses: replace /\: with - and remove leading dashes
 */
function getClaudeProjectsDir(cwd: string): string {
  const encoded = cwd.replace(/[/\\:]/g, '-').replace(/^-+/, '');
  return path.join(os.homedir(), '.claude', 'projects', encoded);
}

/**
 * Sanitize text to remove invalid Unicode surrogates
 * These cause "no low surrogate" errors in the Claude API
 */
function sanitizeText(text: string): string {
  // Remove lone surrogates (invalid Unicode)
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

/**
 * Run a prompt through Claude CLI
 *
 * Creates a temporary session with the content, runs Claude to process it,
 * and returns the output.
 *
 * The structure mirrors how fork/compact summarization works:
 * 1. First user message: the DATA to analyze
 * 2. Second user message: the INSTRUCTIONS (what to do with the data)
 * 3. Run `claude -r <sessionId> -p "short trigger"` to get the output
 *
 * @param data - The data/content to analyze
 * @param instructions - Detailed instructions for what to do with the data
 * @param trigger - Short trigger prompt for the -p flag (default: "Generate the output now.")
 * @param options - Model, timeout, cwd options
 */
export async function runPrompt(
  data: string,
  instructions: string,
  options: PromptOptions = {}
): Promise<PromptResult> {
  const {
    model = 'opus',
    timeout = 300000,
    cwd = process.cwd(),
  } = options;

  // Import Conversation API
  const { Conversation, UserMessage } = await import('../conversation/index.js');

  // Create a new conversation
  const sessionId = uuidv4();
  const conv = Conversation.create({
    sessionId,
    cwd,
    gitBranch: 'master',
    version: '2.0.74',
  });

  // First message: the data to analyze (sanitized)
  const dataMsg = UserMessage.text(sanitizeText(data), { sessionId, cwd });
  conv.append(dataMsg as any);

  // Second message: the instructions (sanitized)
  const instructionMsg = UserMessage.text(sanitizeText(instructions), { sessionId, cwd });
  conv.append(instructionMsg as any);

  conv.rebuildChain().updateTimestamps();

  // Save to Claude's projects directory
  const projectsDir = getClaudeProjectsDir(cwd);
  if (!fs.existsSync(projectsDir)) {
    fs.mkdirSync(projectsDir, { recursive: true });
  }
  const sessionPath = path.join(projectsDir, `${sessionId}.jsonl`);
  conv.save(sessionPath);

  try {
    // Run claude with --resume to process the session
    // Use a clear instruction that references the previous messages
    const result = spawnSync('claude', [
      '-r', sessionId,
      '-p', 'Follow the instructions from my previous message to analyze the data and produce the structured markdown output.',
      '--output-format', 'text',
      '--model', model,
    ], {
      cwd,
      encoding: 'utf-8',
      timeout,
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer
      shell: os.platform() === 'win32',
    });

    if (result.error) {
      console.error(`Session kept for debugging: ${sessionPath}`);
      return {
        success: false,
        output: '',
        error: `Execution error: ${result.error.message}`,
        sessionId,
      };
    }

    if (result.status !== 0) {
      console.error(`Claude stderr: ${result.stderr}`);
      console.error(`Session kept for debugging: ${sessionPath}`);
      return {
        success: false,
        output: result.stdout || '',
        error: `Exit code ${result.status}: ${result.stderr}`,
        sessionId,
      };
    }

    // Only cleanup on success
    try { fs.unlinkSync(sessionPath); } catch {}

    const output = result.stdout.trim();
    if (!output) {
      return {
        success: false,
        output: '',
        error: 'Empty response from Claude',
        sessionId,
      };
    }

    return {
      success: true,
      output,
      sessionId,
    };

  } catch (error) {
    // Cleanup on error
    try { fs.unlinkSync(sessionPath); } catch {}

    return {
      success: false,
      output: '',
      error: `Exception: ${(error as Error).message}`,
      sessionId,
    };
  }
}

/**
 * Run a prompt with content from a file
 */
export async function runPromptWithFile(
  promptFile: string,
  dataFile: string,
  instruction: string,
  options: PromptOptions = {}
): Promise<PromptResult> {
  const prompt = fs.readFileSync(promptFile, 'utf-8');
  const data = fs.readFileSync(dataFile, 'utf-8');

  const content = `${prompt}\n\n---\n\nHere is the content to process:\n\n${data}`;

  return runPrompt(content, instruction, options);
}
