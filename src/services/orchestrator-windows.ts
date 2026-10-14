// Windows process orchestrator for spawning Claude sessions

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import koffi from 'koffi';

// Windows API bindings
const kernel32 = koffi.load('kernel32.dll');

// Console functions
const FreeConsole = kernel32.func('bool FreeConsole()');
const AttachConsole = kernel32.func('bool AttachConsole(uint32 dwProcessId)');
const SetConsoleTitleW = kernel32.func('bool SetConsoleTitleW(str16 lpConsoleTitle)');

// Process creation
const STARTUPINFOW = koffi.struct('STARTUPINFOW', {
  cb: 'uint32',
  lpReserved: 'str16',
  lpDesktop: 'str16',
  lpTitle: 'str16',
  dwX: 'uint32',
  dwY: 'uint32',
  dwXSize: 'uint32',
  dwYSize: 'uint32',
  dwXCountChars: 'uint32',
  dwYCountChars: 'uint32',
  dwFillAttribute: 'uint32',
  dwFlags: 'uint32',
  wShowWindow: 'uint16',
  cbReserved2: 'uint16',
  lpReserved2: 'void*',
  hStdInput: 'void*',
  hStdOutput: 'void*',
  hStdError: 'void*',
});

const PROCESS_INFORMATION = koffi.struct('PROCESS_INFORMATION', {
  hProcess: 'void*',
  hThread: 'void*',
  dwProcessId: 'uint32',
  dwThreadId: 'uint32',
});

const CreateProcessW = kernel32.func('bool CreateProcessW(str16 lpApplicationName, str16 lpCommandLine, void* lpProcessAttributes, void* lpThreadAttributes, bool bInheritHandles, uint32 dwCreationFlags, void* lpEnvironment, str16 lpCurrentDirectory, _Inout_ STARTUPINFOW* lpStartupInfo, _Out_ PROCESS_INFORMATION* lpProcessInformation)');
const CloseHandle = kernel32.func('bool CloseHandle(void* hObject)');

const CREATE_NEW_CONSOLE = 0x00000010;

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

export class ClaudeOrchestratorWindows {
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

  private renameWindow(pid: number, newTitle: string): void {
    FreeConsole();
    if (AttachConsole(pid)) {
      SetConsoleTitleW(newTitle);
      FreeConsole();
    }
  }

  spawnTask(config: TaskConfig): { taskId: string; pid: number | undefined } {
    const taskId = uuidv4().slice(0, 8);
    const taskDir = this.getTaskDir(taskId);
    fs.mkdirSync(taskDir, { recursive: true });

    // Build command line
    // Note: --dangerously-skip-permissions is temporary for convenience
    let commandLine: string;
    if (config.promptFile) {
      const filePath = config.promptFile.replace(/\\/g, '/');
      commandLine = `cmd.exe /K claude --dangerously-skip-permissions "Read the file ${filePath} and follow the instructions in it."`;
    } else {
      commandLine = 'cmd.exe /K claude --dangerously-skip-permissions';
    }

    const workingDir = config.workingDir || process.cwd();

    const startupInfo = {
      cb: koffi.sizeof(STARTUPINFOW),
      lpReserved: null, lpDesktop: null, lpTitle: null,
      dwX: 0, dwY: 0, dwXSize: 0, dwYSize: 0,
      dwXCountChars: 0, dwYCountChars: 0, dwFillAttribute: 0,
      dwFlags: 0, wShowWindow: 1, cbReserved2: 0,
      lpReserved2: null, hStdInput: null, hStdOutput: null, hStdError: null,
    };

    const processInfo = {
      hProcess: null, hThread: null, dwProcessId: 0, dwThreadId: 0,
    };

    let pid: number | undefined;

    try {
      const success = CreateProcessW(
        null, commandLine, null, null, false,
        CREATE_NEW_CONSOLE, null, workingDir,
        startupInfo, processInfo
      );

      if (success) {
        pid = processInfo.dwProcessId;
        CloseHandle(processInfo.hProcess);
        CloseHandle(processInfo.hThread);
      }

      const statusInfo: TaskInfo = {
        id: taskId,
        pid,
        name: config.name,
        status: success ? 'running' : 'error',
        promptFile: config.promptFile,
        createdAt: new Date().toISOString(),
      };
      fs.writeFileSync(path.join(taskDir, 'status.json'), JSON.stringify(statusInfo, null, 2));

      if (config.name && pid) {
        setTimeout(() => this.renameWindow(pid!, config.name!), 2000);
      }
    } catch {
      const statusInfo: TaskInfo = {
        id: taskId, pid, name: config.name, status: 'error',
        promptFile: config.promptFile, createdAt: new Date().toISOString(),
      };
      fs.writeFileSync(path.join(taskDir, 'status.json'), JSON.stringify(statusInfo, null, 2));
    }

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

  /**
   * Spawn a task with a custom command line (for fork functionality)
   */
  spawnTaskWithCommand(commandLine: string, config: { name?: string; workingDir?: string; cols?: number; rows?: number }): { taskId: string; pid: number | undefined } {
    const taskId = uuidv4().slice(0, 8);
    const taskDir = this.getTaskDir(taskId);
    fs.mkdirSync(taskDir, { recursive: true });

    const workingDir = config.workingDir || process.cwd();

    // STARTF_USECOUNTCHARS = 0x00000008
    const useSize = config.cols && config.rows;
    const startupInfo = {
      cb: koffi.sizeof(STARTUPINFOW),
      lpReserved: null, lpDesktop: null, lpTitle: null,
      dwX: 0, dwY: 0, dwXSize: 0, dwYSize: 0,
      dwXCountChars: config.cols || 120, dwYCountChars: config.rows || 40, dwFillAttribute: 0,
      dwFlags: useSize ? 0x00000008 : 0, wShowWindow: 1, cbReserved2: 0,
      lpReserved2: null, hStdInput: null, hStdOutput: null, hStdError: null,
    };

    const processInfo = {
      hProcess: null, hThread: null, dwProcessId: 0, dwThreadId: 0,
    };

    let pid: number | undefined;

    try {
      const success = CreateProcessW(
        null, commandLine, null, null, false,
        CREATE_NEW_CONSOLE, null, workingDir,
        startupInfo, processInfo
      );

      if (success) {
        pid = processInfo.dwProcessId;
        CloseHandle(processInfo.hProcess);
        CloseHandle(processInfo.hThread);
      }

      const statusInfo: TaskInfo = {
        id: taskId,
        pid,
        name: config.name,
        status: success ? 'running' : 'error',
        createdAt: new Date().toISOString(),
      };
      fs.writeFileSync(path.join(taskDir, 'status.json'), JSON.stringify(statusInfo, null, 2));

      if (config.name && pid) {
        setTimeout(() => this.renameWindow(pid!, config.name!), 2000);
      }
    } catch {
      const statusInfo: TaskInfo = {
        id: taskId, pid, name: config.name, status: 'error',
        createdAt: new Date().toISOString(),
      };
      fs.writeFileSync(path.join(taskDir, 'status.json'), JSON.stringify(statusInfo, null, 2));
    }

    return { taskId, pid };
  }
}

export default ClaudeOrchestratorWindows;
