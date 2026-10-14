// Spawn commands - spawn Claude sessions with custom window titles

import { Command } from 'commander';
import chalk from 'chalk';
import { getOrchestrator } from '../../services/orchestrator.js';

export function registerSpawnCommands(program: Command): void {
  // Spawn command
  program
    .command('spawn [prompt-file]')
    .description('Spawn a new Claude session in a separate window')
    .option('--name <name>', 'Window title')
    .option('--dir <path>', 'Working directory')
    .addHelpText('after', `
${chalk.yellow('Examples:')}
  ${chalk.dim('# Spawn interactive session')}
  claude-tools spawn --name "My Task"

  ${chalk.dim('# Spawn with prompt file')}
  claude-tools spawn prompt.txt --name "Code Review"

  ${chalk.dim('# Spawn in specific directory')}
  claude-tools spawn --dir C:\\projects\\myapp --name "MyApp"
`)
    .action(async (promptFile: string | undefined, options: { name?: string; dir?: string }) => {
      const orchestrator = await getOrchestrator();
      const { taskId, pid } = await orchestrator.spawnTask({
        promptFile,
        name: options.name,
        workingDir: options.dir,
      });
      console.log(`${chalk.green('Spawned:')} Task ${chalk.cyan(taskId)}, PID: ${chalk.yellow(pid || 'N/A')}`);
    });

  // List command
  program
    .command('list')
    .description('List all spawned tasks')
    .action(async () => {
      const orchestrator = await getOrchestrator();
      const tasks = orchestrator.listTasks();
      if (tasks.length === 0) {
        console.log(chalk.dim('No tasks'));
        return;
      }

      console.log(chalk.bold('Tasks from metadata:'));
      for (const task of tasks) {
        const statusColor = task.status === 'running' ? chalk.green :
                           task.status === 'error' ? chalk.red : chalk.dim;
        console.log(`  ${chalk.cyan(task.id)} [${statusColor(task.status)}] ${task.name || chalk.dim('(unnamed)')}`);
      }
    });

  // Cleanup command
  program
    .command('cleanup')
    .description('Remove all task records')
    .action(async () => {
      const orchestrator = await getOrchestrator();
      const cleaned = orchestrator.cleanup();
      console.log(`${chalk.green('Cleaned:')} ${cleaned} task(s)`);
    });
}
