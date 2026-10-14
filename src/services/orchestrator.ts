// Cross-platform process orchestrator for spawning Claude sessions

import * as os from 'os';

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

export interface IClaudeOrchestrator {
  spawnTask(config: TaskConfig): Promise<{ taskId: string; pid: number | undefined }> | { taskId: string; pid: number | undefined };
  spawnTaskWithCommand(command: string, config: { name?: string; workingDir?: string; cols?: number; rows?: number }): Promise<{ taskId: string; pid: number | undefined }> | { taskId: string; pid: number | undefined };
  checkTask(taskId: string): TaskInfo;
  listTasks(): TaskInfo[];
  cleanup(): number;
}

let orchestratorInstance: IClaudeOrchestrator | null = null;

async function createOrchestrator(baseDir?: string): Promise<IClaudeOrchestrator> {
  const platform = os.platform();

  if (platform === 'darwin') {
    const { ClaudeOrchestratorMacOS } = await import('./orchestrator-macos.js');
    return new ClaudeOrchestratorMacOS(baseDir);
  } else if (platform === 'win32') {
    const { ClaudeOrchestratorWindows } = await import('./orchestrator-windows.js');
    return new ClaudeOrchestratorWindows(baseDir);
  } else if (platform === 'linux') {
    const { ClaudeOrchestratorLinux } = await import('./orchestrator-linux.js');
    return new ClaudeOrchestratorLinux(baseDir);
  } else {
    throw new Error(`Unsupported platform: ${platform}. Only Windows, macOS, and Linux are supported.`);
  }
}

export async function getOrchestrator(baseDir?: string): Promise<IClaudeOrchestrator> {
  if (!orchestratorInstance) {
    orchestratorInstance = await createOrchestrator(baseDir);
  }
  return orchestratorInstance;
}

// For backwards compatibility, export a class that lazily initializes
export class ClaudeOrchestrator implements IClaudeOrchestrator {
  private _impl: IClaudeOrchestrator | null = null;
  private _baseDir?: string;
  private _initPromise: Promise<IClaudeOrchestrator> | null = null;

  constructor(baseDir?: string) {
    this._baseDir = baseDir;
  }

  private async getImpl(): Promise<IClaudeOrchestrator> {
    if (this._impl) return this._impl;
    if (!this._initPromise) {
      this._initPromise = createOrchestrator(this._baseDir);
    }
    this._impl = await this._initPromise;
    return this._impl;
  }

  async spawnTask(config: TaskConfig): Promise<{ taskId: string; pid: number | undefined }> {
    const impl = await this.getImpl();
    return impl.spawnTask(config);
  }

  async spawnTaskWithCommand(command: string, config: { name?: string; workingDir?: string; cols?: number; rows?: number }): Promise<{ taskId: string; pid: number | undefined }> {
    const impl = await this.getImpl();
    return impl.spawnTaskWithCommand(command, config);
  }

  checkTask(taskId: string): TaskInfo {
    if (!this._impl) {
      throw new Error('Orchestrator not initialized. Call an async method first.');
    }
    return this._impl.checkTask(taskId);
  }

  listTasks(): TaskInfo[] {
    if (!this._impl) {
      return [];
    }
    return this._impl.listTasks();
  }

  cleanup(): number {
    if (!this._impl) {
      return 0;
    }
    return this._impl.cleanup();
  }
}

export default ClaudeOrchestrator;
