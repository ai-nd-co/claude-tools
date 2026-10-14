// macOS process orchestrator for spawning Claude sessions

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';

export interface TaskConfig {
  promptFile?: string;
  workingDir?: string;
  name?: string;
}

export interface TaskInfo {
  id: string;
  pid?: number;
  name?: string;
  status: 'pending' | 'running' | 'done' | 'error';
  promptFile?: string;
  createdAt: string;
}

export class ClaudeOrchestratorMacOS {
  private baseDir: string;
  private tasksDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir || path.join(process.cwd(), 'tmp', 'claude-tools');
    this.tasksDir = path.join(this.baseDir, 'tasks');
    this.ensureDirectories();
  }

  private ensureDirectories(): void {
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
    if (!fs.existsSync(this.tasksDir)) {
      fs.mkdirSync(this.tasksDir, { recursive: true });
    }
  }

  private getTaskDir(taskId: string): string {
    return path.join(this.tasksDir, taskId);
  }

  /**
   * Check if iTerm2 is installed
   */
  private async hasITerm(): Promise<boolean> {
    return new Promise((resolve) => {
      const check = spawn('osascript', ['-e', 'tell application "System Events" to (name of processes) contains "iTerm2"']);
      check.on('close', (code) => {
        if (code === 0) {
          // Try to actually tell iTerm something
          const test = spawn('osascript', ['-e', 'tell application "iTerm" to count windows']);
          test.on('close', (c) => resolve(c === 0));
          test.on('error', () => resolve(false));
        } else {
          resolve(false);
        }
      });
      check.on('error', () => resolve(false));
    });
  }

  /**
   * Spawn a new terminal window with the given command (iTerm2 preferred, fallback to Terminal.app)
   */
  private async spawnTerminal(command: string, workingDir: string, windowTitle?: string): Promise<number | undefined> {
    const useITerm = await this.hasITerm();

    if (useITerm) {
      return this.spawnITerm(command, workingDir, windowTitle);
    } else {
      return this.spawnTerminalApp(command, workingDir, windowTitle);
    }
  }

  /**
   * Spawn using iTerm2
   */
  private spawnITerm(command: string, workingDir: string, windowTitle?: string): Promise<number | undefined> {
    return new Promise((resolve) => {
      const escapedCommand = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const escapedDir = workingDir.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const title = windowTitle || 'Claude Session';
      const escapedTitle = title.replace(/"/g, '\\"');

      const appleScript = `
        tell application "iTerm"
          activate
          set newWindow to (create window with default profile)
          tell current session of newWindow
            write text "cd \\"${escapedDir}\\" && ${escapedCommand}"
          end tell
          tell newWindow
            set name to "${escapedTitle}"
          end tell
          return id of newWindow
        end tell
      `;

      const osascript = spawn('osascript', ['-e', appleScript]);
      let stdout = '';

      osascript.stdout.on('data', (data) => { stdout += data.toString(); });
      osascript.on('close', (code) => {
        if (code === 0) {
          const windowId = parseInt(stdout.trim(), 10);
          resolve(isNaN(windowId) ? undefined : windowId);
        } else {
          resolve(undefined);
        }
      });
      osascript.on('error', () => resolve(undefined));
    });
  }

  /**
   * Spawn using Terminal.app (fallback)
   */
  private spawnTerminalApp(command: string, workingDir: string, windowTitle?: string): Promise<number | undefined> {
    return new Promise((resolve) => {
      const escapedCommand = command.replace(/'/g, "'\"'\"'");
      const escapedDir = workingDir.replace(/'/g, "'\"'\"'");
      const title = windowTitle || 'Claude Session';
      const escapedTitle = title.replace(/'/g, "'\"'\"'");

      const appleScript = `
        tell application "Terminal"
          activate
          set newWindow to do script "cd '${escapedDir}' && ${escapedCommand}"
          set custom title of front window to "${escapedTitle}"
          return id of front window
        end tell
      `;

      const osascript = spawn('osascript', ['-e', appleScript]);
      let stdout = '';

      osascript.stdout.on('data', (data) => { stdout += data.toString(); });
      osascript.on('close', (code) => {
        if (code === 0) {
          const windowId = parseInt(stdout.trim(), 10);
          resolve(isNaN(windowId) ? undefined : windowId);
        } else {
          resolve(undefined);
        }
      });
      osascript.on('error', () => resolve(undefined));
    });
  }

  async spawnTask(config: TaskConfig): Promise<{ taskId: string; pid: number | undefined }> {
    const taskId = uuidv4().slice(0, 8);
    const taskDir = this.getTaskDir(taskId);
    fs.mkdirSync(taskDir, { recursive: true });

    let command: string;
    if (config.promptFile) {
      const filePath = config.promptFile;
      command = `claude "Read the file ${filePath} and follow the instructions in it."`;
    } else {
      command = 'claude';
    }

    const workingDir = config.workingDir || process.cwd();

    let pid: number | undefined;
    let status: 'running' | 'error' = 'error';

    try {
      pid = await this.spawnTerminal(command, workingDir, config.name);
      status = pid !== undefined ? 'running' : 'error';
    } catch (err) {
      console.error('Failed to spawn terminal:', err);
    }

    const statusInfo: TaskInfo = {
      id: taskId,
      pid,
      name: config.name,
      status,
      promptFile: config.promptFile,
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(taskDir, 'status.json'), JSON.stringify(statusInfo, null, 2));

    return { taskId, pid };
  }

  /**
   * Spawn a task with a custom command line (for fork functionality)
   */
  async spawnTaskWithCommand(command: string, config: { name?: string; workingDir?: string }): Promise<{ taskId: string; pid: number | undefined }> {
    const taskId = uuidv4().slice(0, 8);
    const taskDir = this.getTaskDir(taskId);
    fs.mkdirSync(taskDir, { recursive: true });

    const workingDir = config.workingDir || process.cwd();

    let pid: number | undefined;
    let status: 'running' | 'error' = 'error';

    try {
      pid = await this.spawnTerminal(command, workingDir, config.name);
      status = pid !== undefined ? 'running' : 'error';
    } catch (err) {
      console.error('Failed to spawn terminal:', err);
    }

    const statusInfo: TaskInfo = {
      id: taskId,
      pid,
      name: config.name,
      status,
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(taskDir, 'status.json'), JSON.stringify(statusInfo, null, 2));

    return { taskId, pid };
  }

  checkTask(taskId: string): TaskInfo {
    const taskDir = this.getTaskDir(taskId);
    if (!fs.existsSync(taskDir)) {
      throw new Error(`Task ${taskId} not found`);
    }

    const statusFile = path.join(taskDir, 'status.json');
    if (!fs.existsSync(statusFile)) {
      throw new Error(`Status file not found for task ${taskId}`);
    }

    return JSON.parse(fs.readFileSync(statusFile, 'utf-8'));
  }

  listTasks(): TaskInfo[] {
    if (!fs.existsSync(this.tasksDir)) {
      return [];
    }

    return fs.readdirSync(this.tasksDir)
      .map(taskId => {
        try {
          return this.checkTask(taskId);
        } catch {
          return null;
        }
      })
      .filter((t): t is TaskInfo => t !== null)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  cleanup(): number {
    let cleaned = 0;
    for (const task of this.listTasks()) {
      fs.rmSync(this.getTaskDir(task.id), { recursive: true, force: true });
      cleaned++;
    }
    return cleaned;
  }
}

export default ClaudeOrchestratorMacOS;
