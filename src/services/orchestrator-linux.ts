// Linux process orchestrator for spawning Claude sessions
// Runs commands in the current terminal using exec

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
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

export class ClaudeOrchestratorLinux {
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
   * Execute command in current terminal (replaces current process)
   */
  private execInPlace(command: string, workingDir: string): void {
    // Use exec to replace the current process with the new command
    execSync(command, {
      cwd: workingDir,
      stdio: 'inherit',
    });
  }

  spawnTask(config: TaskConfig): { taskId: string; pid: number | undefined } {
    const taskId = uuidv4().slice(0, 8);
    const taskDir = this.getTaskDir(taskId);
    fs.mkdirSync(taskDir, { recursive: true });

    const workingDir = config.workingDir || process.cwd();

    let command: string;
    if (config.promptFile) {
      const filePath = config.promptFile;
      command = `claude --dangerously-skip-permissions "Read the file ${filePath} and follow the instructions in it."`;
    } else {
      command = 'claude --dangerously-skip-permissions';
    }

    const statusInfo: TaskInfo = {
      id: taskId,
      pid: process.pid,
      name: config.name,
      status: 'running',
      promptFile: config.promptFile,
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(taskDir, 'status.json'), JSON.stringify(statusInfo, null, 2));

    // This will block and run in the current terminal
    this.execInPlace(command, workingDir);

    return { taskId, pid: process.pid };
  }

  /**
   * Spawn a task with a custom command line (for fork functionality)
   * Runs in the current terminal
   */
  spawnTaskWithCommand(commandLine: string, config: { name?: string; workingDir?: string; cols?: number; rows?: number }): { taskId: string; pid: number | undefined } {
    const taskId = uuidv4().slice(0, 8);
    const taskDir = this.getTaskDir(taskId);
    fs.mkdirSync(taskDir, { recursive: true });

    const workingDir = config.workingDir || process.cwd();

    const statusInfo: TaskInfo = {
      id: taskId,
      pid: process.pid,
      name: config.name,
      status: 'running',
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(taskDir, 'status.json'), JSON.stringify(statusInfo, null, 2));

    // Run in current terminal
    this.execInPlace(commandLine, workingDir);

    return { taskId, pid: process.pid };
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

export default ClaudeOrchestratorLinux;
