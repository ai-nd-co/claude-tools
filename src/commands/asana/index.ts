// Asana commands - whoami, workspaces, projects, project create/update/show,
// sections, list, show, search, create, update, comment, done, reopen, assign,
// move
//
// Shaped after the Jira group: same --format/--json/--verbose options, the same
// "-" stdin convention, the same ensure*Config() failure message. The one real
// difference is identifiers: Asana has no human key like PROJ-123, so every
// argument that names a project, section, task or user also accepts a gid, and
// an ambiguous name prints its candidates instead of picking one.

import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig } from '../../config/loader.js';
import {
  AsanaService,
  AsanaAmbiguousNameError,
  isGid,
  redactAsanaToken,
  PROJECT_COLORS,
  type AsanaComment,
  type AsanaProjectDetail,
  type AsanaTask,
  type NamedResource,
} from '../../services/asana.js';
import type { AsanaConfig } from '../../config/types.js';
import { resolveFormat, type OutputFormat } from '../../utils/output-format.js';

const DUE_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Read text from stdin (for piping content)
 * Usage: cat notes.md | asana create "Title" --notes -
 */
async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    // An interactive terminal has nothing piped in, so there is nothing to wait
    // for. Otherwise wait for EOF: the Jira group's 100 ms grace period treats a
    // generator that is slow to emit its first byte as empty input, and notes
    // assembled by another process routinely take longer than that.
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }

    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8').trim()));
    process.stdin.on('error', reject);
  });
}

/**
 * Resolve a long text value - supports stdin via "-" marker
 */
async function resolveText(value: string | undefined): Promise<string | undefined> {
  // `undefined` means "not given"; `''` means "make it empty", which is how
  // notes are cleared. Collapsing the two made that impossible.
  if (value === undefined) return undefined;
  if (value === '-') {
    const stdinContent = await readStdin();
    if (!stdinContent) {
      console.error(chalk.red('Error: No input received from stdin'));
      process.exit(1);
    }
    return stdinContent;
  }
  return value;
}

function ensureAsanaConfig(): AsanaConfig {
  const config = loadConfig();
  if (!config.asana) {
    console.error(chalk.red('Asana not configured.'));
    console.log('\nTo configure Asana:');
    console.log('  1. Create a Personal Access Token at https://app.asana.com/0/my-apps');
    console.log('  2. Add to ~/.config/claude-tools/secrets.json:');
    console.log('     {"asana": {"accessToken": "..."}}');
    console.log('  3. Optional, in .claude-tools.json:');
    console.log('     {"asana": {"defaultWorkspace": "1200...", "defaultProject": "1218..."}}');
    console.log('\nOr set environment variables: ASANA_ACCESS_TOKEN (ASANA_TOKEN, ASANA_PAT)');
    process.exit(1);
  }
  return config.asana;
}

/**
 * Print an error and exit. Every message passes through the redactor: an Asana
 * error body is arbitrary upstream text, and the token must never reach a
 * terminal or a log.
 */
function fail(err: unknown, token?: string): never {
  // The redactor is applied unconditionally, including to the query the user
  // typed and to names Asana returned. Neither is a likely place for a
  // credential, but "every diagnostic is redacted" is only an invariant if it
  // has no exceptions.
  const safe = (text: string): string => redactAsanaToken(text, token);

  if (err instanceof AsanaAmbiguousNameError) {
    console.error(chalk.red(`Error: "${safe(err.query)}" matches ${err.candidates.length} ${err.kind}s:`));
    for (const candidate of err.candidates) {
      console.error(`  ${chalk.cyan(candidate.gid)}  ${safe(candidate.name) || chalk.dim('(unnamed)')}`);
    }
    console.error(chalk.dim('Pass the gid to disambiguate.'));
    process.exit(1);
  }

  const message = err instanceof Error ? err.message : String(err);
  console.error(chalk.red('Error:'), safe(message));
  process.exit(1);
}

/** One try/catch for every subcommand, so no path can print an unredacted error. */
async function run(action: (service: AsanaService, config: AsanaConfig) => Promise<void>): Promise<void> {
  const config = ensureAsanaConfig();
  const service = new AsanaService(config, fetch, (message) =>
    console.error(chalk.yellow('Warning:'), redactAsanaToken(message, config.accessToken)),
  );
  try {
    await action(service, config);
  } catch (err) {
    fail(err, config.accessToken);
  }
}

function formatTimestamp(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/** An open task past its due date is the one thing worth colouring in a list. */
function isOverdue(task: AsanaTask): boolean {
  return !task.completed && Boolean(task.dueOn) && task.dueOn! < new Date().toISOString().slice(0, 10);
}

function statusMark(task: AsanaTask): string {
  return task.completed ? chalk.green('done') : chalk.yellow('open');
}

function printTaskTitle(task: AsanaTask): void {
  console.log(`  ${chalk.cyan(task.gid)}: ${task.name}`);
}

function printTaskCompact(task: AsanaTask): void {
  // Pad before colouring: ANSI escapes count toward padEnd and would shift
  // every column right. gids get a wide column on purpose - a gid is the only
  // handle the other subcommands take.
  const status = task.completed ? chalk.green('done'.padEnd(9)) : chalk.yellow('open'.padEnd(9));
  const due = (task.dueOn || '-').padEnd(12);
  const assignee = (task.assignee?.slice(0, 16) || 'Unassigned').padEnd(18);

  console.log(
    chalk.cyan(task.gid.padEnd(18)) +
      status +
      (isOverdue(task) ? chalk.red(due) : due) +
      (task.assignee ? assignee : chalk.dim(assignee)) +
      task.name.slice(0, 48),
  );
}

function sectionLabel(task: AsanaTask): string {
  const parts = task.memberships
    .map((m) => (m.project && m.section ? `${m.project} / ${m.section}` : m.project || m.section))
    .filter(Boolean);
  if (parts.length > 0) return parts.join(', ');
  return task.projects.map((p) => p.name).join(', ');
}

function printTaskVerbose(task: AsanaTask): void {
  console.log();
  console.log(chalk.cyan(task.gid), statusMark(task));
  console.log(`  ${chalk.bold(task.name)}`);
  console.log(`  Assignee: ${task.assignee || chalk.dim('Unassigned')}  Due: ${task.dueOn || chalk.dim('none')}`);
  const where = sectionLabel(task);
  if (where) console.log(`  In: ${where}`);
  if (task.permalinkUrl) console.log(chalk.dim(`  URL: ${task.permalinkUrl}`));
  console.log(chalk.dim('  ---'));
}

function printTasks(tasks: AsanaTask[], format: OutputFormat, heading: string): void {
  if (format === 'json') {
    console.log(JSON.stringify(tasks, null, 2));
    return;
  }

  console.log(chalk.bold(`\n${heading}\n`));
  if (tasks.length === 0) {
    console.log(chalk.dim('No tasks found'));
  } else {
    if (format === 'compact') {
      console.log(
        chalk.dim('Gid'.padEnd(18) + 'Status'.padEnd(9) + 'Due'.padEnd(12) + 'Assignee'.padEnd(18) + 'Task'),
      );
      console.log(chalk.dim('-'.repeat(88)));
    }
    for (const task of tasks) {
      if (format === 'verbose') printTaskVerbose(task);
      else if (format === 'title') printTaskTitle(task);
      else printTaskCompact(task);
    }
  }
  console.log(chalk.dim(`\nTotal: ${tasks.length}`));
}

function printNamed<T extends NamedResource>(
  items: T[],
  format: OutputFormat,
  heading: string,
  extra?: (item: T) => string,
): void {
  if (format === 'json') {
    console.log(JSON.stringify(items, null, 2));
    return;
  }

  console.log(chalk.bold(`\n${heading}\n`));
  if (items.length === 0) {
    console.log(chalk.dim('Nothing found'));
  } else {
    for (const item of items) {
      if (format === 'title') console.log(`  ${item.name || chalk.dim('(unnamed)')}`);
      else console.log(`  ${chalk.cyan(item.gid.padEnd(18))}${item.name || chalk.dim('(unnamed)')}${extra ? extra(item) : ''}`);
    }
  }
  console.log(chalk.dim(`\nTotal: ${items.length}`));
}

/**
 * A project in full.
 *
 * The description is printed last and always labelled, empty included: a future
 * session reading this is the reason the field is stored at all, and a silent
 * gap where it should be reads like a display bug rather than "nobody wrote one".
 */
function printProjectDetail(detail: AsanaProjectDetail): void {
  console.log();
  console.log(chalk.cyan(detail.gid), chalk.bold(detail.name || '(unnamed)'));
  console.log(chalk.dim('-'.repeat(60)));
  console.log(`Status:   ${detail.archived ? chalk.yellow('archived') : chalk.green('active')}`);
  console.log(`Access:   ${detail.isPublic ? 'visible to the workspace' : 'private to its members'}`);
  console.log(`Color:    ${detail.color && detail.color !== 'none' ? detail.color : chalk.dim('none')}`);
  if (detail.owner) console.log(`Owner:    ${detail.owner}`);
  if (detail.workspace) {
    console.log(`In:       ${detail.workspace.name}${detail.team ? ` / ${detail.team}` : ''}`);
  }
  if (detail.startOn || detail.dueOn) {
    console.log(`Dates:    ${detail.startOn || 'no start'} -> ${detail.dueOn || 'no due date'}`);
  }
  if (detail.currentStatus) console.log(`Update:   ${detail.currentStatus}`);
  console.log(`Created:  ${formatTimestamp(detail.createdAt)}`);
  // Asana does not advance a project's modified_at when its name, description
  // or color change - probed with three writes against the live API, including
  // the PUT's own echo, and it never moved. Printed bare it reads as "the
  // description was last touched then", which is exactly what it does not mean.
  console.log(
    `Modified: ${formatTimestamp(detail.modifiedAt)} ` +
      chalk.dim('(Asana does not move this for name/description/color edits)'),
  );

  console.log();
  console.log(chalk.bold('Description:'));
  if (detail.notesMarkdown) {
    for (const line of detail.notesMarkdown.split('\n')) console.log(`  ${line}`);
  } else {
    console.log(chalk.dim('  none - set one with: asana project update <project> --notes "..."'));
  }

  if (detail.permalinkUrl) console.log(chalk.dim(`\nURL: ${detail.permalinkUrl}`));
}

function printComments(comments: AsanaComment[]): void {
  console.log();
  console.log(chalk.bold(`Comments (${comments.length}):`));
  if (comments.length === 0) {
    console.log(chalk.dim('  none'));
    return;
  }
  for (const comment of comments) {
    console.log();
    console.log(`  ${chalk.cyan(comment.createdBy || 'unknown')} ${chalk.dim(formatTimestamp(comment.createdAt))}`);
    for (const line of comment.text.split('\n')) console.log(`    ${line}`);
  }
}

function assertDueDate(value: string | undefined, flag: string): void {
  if (value !== undefined && !DUE_DATE.test(value)) {
    console.error(chalk.red(`Error: ${flag} must be a date as YYYY-MM-DD`));
    process.exit(1);
  }
}

function parseLimit(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const limit = parseInt(value, 10);
  if (!Number.isInteger(limit) || limit <= 0) {
    console.error(chalk.red('Error: --limit must be a positive integer'));
    process.exit(1);
  }
  return limit;
}

/**
 * Resolve the project a command should act on: the flag, else the configured
 * default. `list` deliberately does not use the default - its documented
 * behaviour is "my incomplete tasks", and silently scoping that to one project
 * would hide work.
 */
async function resolveProjectOption(
  service: AsanaService,
  config: AsanaConfig,
  workspace: string,
  value: string | undefined,
  { useDefault = true }: { useDefault?: boolean } = {},
): Promise<string | undefined> {
  const wanted = value || (useDefault ? config.defaultProject : undefined);
  if (!wanted) return undefined;
  return service.resolveProject(workspace, wanted);
}

export function registerAsanaCommands(program: Command): void {
  const asana = program.command('asana').description('Asana task management commands');

  // ------------------------------------------------------------------ whoami
  asana
    .command('whoami')
    .description('Show the authenticated Asana user and their workspaces')
    .option('--json', 'Output as JSON')
    .action(async (options: { json?: boolean }) =>
      run(async (service) => {
        const me = await service.whoAmI();
        if (options.json) {
          console.log(JSON.stringify(me, null, 2));
          return;
        }
        console.log();
        console.log(chalk.bold(me.name), chalk.dim(`<${me.email || 'no email'}>`));
        console.log(`User gid: ${chalk.cyan(me.gid)}`);
        console.log(chalk.bold('\nWorkspaces:'));
        for (const workspace of me.workspaces || []) {
          console.log(`  ${chalk.cyan(workspace.gid.padEnd(18))}${workspace.name}`);
        }
      }),
    );

  // -------------------------------------------------------------- workspaces
  asana
    .command('workspaces')
    .description('List workspaces')
    .option('--format <type>', 'Output format: title, compact, json (default: compact)')
    .option('--json', 'Shorthand for --format=json')
    .action(async (options: { format?: string; json?: boolean }) =>
      run(async (service) => {
        const workspaces = await service.listWorkspaces();
        printNamed(workspaces, resolveFormat(options, 'compact'), 'Workspaces:');
      }),
    );

  // ----------------------------------------------------------------- projects
  asana
    .command('projects [workspace]')
    .description('List projects in a workspace (gid or name)')
    .option('--archived', 'Include archived projects')
    .option('--limit <n>', 'Number of results')
    .option('--format <type>', 'Output format: title, compact, json (default: compact)')
    .option('--json', 'Shorthand for --format=json')
    .addHelpText(
      'after',
      `
${chalk.yellow('Examples:')}
  ${chalk.dim('# Projects in the only (or configured default) workspace')}
  claude-tools asana projects

  ${chalk.dim('# A named workspace, including archived projects')}
  claude-tools asana projects "My workspace" --archived
`,
    )
    .action(async (workspace: string | undefined, options: { archived?: boolean; limit?: string; format?: string; json?: boolean }) =>
      run(async (service) => {
        const workspaceGid = await service.resolveDefaultWorkspace(workspace);
        const projects = await service.listProjects(workspaceGid, {
          limit: options.limit === undefined ? undefined : parseLimit(options.limit, 100),
          includeArchived: options.archived === true,
        });
        printNamed(projects, resolveFormat(options, 'compact'), 'Projects:', (project) =>
          project.archived ? chalk.dim('  (archived)') : '',
        );
      }),
    );

  // ------------------------------------------------------------------ project
  // A sub-group rather than more top-level verbs, so bare `create`, `update`
  // and `show` keep meaning "a task", which is what they have always meant.
  const project = asana
    .command('project')
    .description('Create, describe, archive and read a project')
    .addHelpText(
      'after',
      `
${chalk.yellow('Note:')}
  There is deliberately no ${chalk.bold('project delete')}: deleting an Asana project
  destroys its tasks with it. Use ${chalk.bold('project update <project> --archive')},
  which is reversible with --unarchive.
`,
    );

  // --------------------------------------------------------- project create
  project
    .command('create <name>')
    .description('Create a project, with a description the agent can read back later')
    .option('--workspace <name|gid>', 'Workspace')
    .option('--notes <text>', 'Description, as Markdown (use "-" for stdin)')
    .option('--color <name>', `Project color: ${PROJECT_COLORS.join(', ')}`)
    .option('--public', 'Visible to everyone in the workspace')
    .option('--private', 'Visible only to its members (Asana\'s default)')
    .addHelpText(
      'after',
      `
${chalk.yellow('Examples:')}
  claude-tools asana project create "Warehouse rollout" --notes "What this is for, in Markdown"

  ${chalk.dim('# Description from a file - the usual way to write a long one')}
  cat charter.md | claude-tools asana project create "Warehouse rollout" --notes - --color dark-teal

${chalk.yellow('Note:')}
  Only a workspace is needed; in "My workspace" Asana supplies the team itself.
  In an organization Asana requires a team and this command does not guess one.

  Asana reads colors back under other names (light-purple becomes "purple"), and
  rejects those names on a write. Both spellings are accepted here.
`,
    )
    .action(async (name: string, options: {
      workspace?: string;
      notes?: string;
      color?: string;
      public?: boolean;
      private?: boolean;
    }) =>
      run(async (service) => {
        if (options.public && options.private) {
          console.error(chalk.red('Error: --public and --private cannot both be given'));
          process.exit(1);
        }
        const notes = await resolveText(options.notes);
        const workspace = await service.resolveDefaultWorkspace(options.workspace);

        const created = await service.createProject({
          name,
          workspace,
          notes,
          color: options.color,
          // Left undefined unless asked for, so Asana's own default applies.
          isPublic: options.public ? true : options.private ? false : undefined,
        });

        console.log(chalk.green('Created project:'), chalk.cyan(created.gid), `- ${created.name}`);
        if (created.permalinkUrl) console.log(chalk.dim(`URL: ${created.permalinkUrl}`));
      }),
    );

  // --------------------------------------------------------- project update
  project
    .command('update <project>')
    .description('Update a project\'s name, description or color, or archive it')
    .option('--workspace <name|gid>', 'Workspace to resolve the project name in')
    .option('--name <text>', 'New name')
    .option('--notes <text>', 'New description, as Markdown (use "-" for stdin, replaces the old one)')
    .option('--color <name>', `New color: ${PROJECT_COLORS.join(', ')}`)
    .option('--archive', 'Archive the project (reversible; hides it from the default listing)')
    .option('--unarchive', 'Bring an archived project back')
    .addHelpText(
      'after',
      `
${chalk.yellow('Examples:')}
  cat charter.md | claude-tools asana project update "Warehouse rollout" --notes -
  claude-tools asana project update 1218000000000037 --name "Warehouse rollout (2026)"
  claude-tools asana project update "Warehouse rollout" --archive

${chalk.yellow('Note:')}
  --notes replaces the description, it does not append. Archiving is the
  reversible alternative to deletion, which would destroy the project's tasks.
`,
    )
    .action(async (projectArg: string, options: {
      workspace?: string;
      name?: string;
      notes?: string;
      color?: string;
      archive?: boolean;
      unarchive?: boolean;
    }) =>
      run(async (service) => {
        if (options.archive && options.unarchive) {
          console.error(chalk.red('Error: --archive and --unarchive cannot both be given'));
          process.exit(1);
        }

        const notes = await resolveText(options.notes);
        const workspace = await service.resolveDefaultWorkspace(options.workspace);
        // An archived project is still returned by typeahead, and the fallback
        // listing asks for archived ones too, so --unarchive works by name.
        const gid = await service.resolveProject(workspace, projectArg);

        const updated = await service.updateProject(gid, {
          name: options.name,
          notes,
          color: options.color,
          archived: options.archive ? true : options.unarchive ? false : undefined,
        });

        console.log(chalk.green('Updated project:'), chalk.cyan(updated.gid));
        if (options.name) console.log(`  Name: ${updated.name}`);
        if (notes) {
          // Collapsed to one line: a description is routinely several
          // paragraphs, and a raw 50-character slice of it spills over the
          // labelled summary it is supposed to be.
          const preview = notes.replace(/\s+/g, ' ').trim();
          console.log(`  Description: ${preview.slice(0, 50)}${preview.length > 50 ? '...' : ''}`);
        } else if (notes === '') console.log('  Description: cleared');
        // Asana's own echo, not the requested value: it collapses some colors
        // (dark-blue becomes light-blue) and renames them again on the next
        // read, so echoing shows the coercion instead of hiding it.
        if (options.color) console.log(`  Color: ${updated.color || 'none'}`);
        if (options.archive || options.unarchive) {
          console.log(`  Status: ${updated.archived ? 'archived' : 'active'}`);
        }
      }),
    );

  // ----------------------------------------------------------- project show
  project
    .command('show <project>')
    .description('Show a project\'s description and metadata (gid or name)')
    .option('--workspace <name|gid>', 'Workspace to resolve the project name in')
    .option('--json', 'Output as JSON')
    .addHelpText(
      'after',
      `
${chalk.yellow('Examples:')}
  claude-tools asana project show Personal
  claude-tools asana project show 1218000000000035 --json

${chalk.yellow('Note:')}
  This is the command that answers "what is this project for" - the description
  is stored on the project itself, so it survives between sessions.
`,
    )
    .action(async (projectArg: string, options: { workspace?: string; json?: boolean }) =>
      run(async (service) => {
        const workspace = await service.resolveDefaultWorkspace(options.workspace);
        const gid = await service.resolveProject(workspace, projectArg);
        const detail = await service.getProject(gid);

        if (options.json) {
          console.log(JSON.stringify(detail, null, 2));
          return;
        }
        printProjectDetail(detail);
      }),
    );

  // ----------------------------------------------------------------- sections
  asana
    .command('sections <project>')
    .description('List the sections of a project (gid or name)')
    .option('--workspace <name|gid>', 'Workspace to resolve the project in')
    .option('--format <type>', 'Output format: title, compact, json (default: compact)')
    .option('--json', 'Shorthand for --format=json')
    .action(async (project: string, options: { workspace?: string; format?: string; json?: boolean }) =>
      run(async (service) => {
        const workspace = await service.resolveDefaultWorkspace(options.workspace);
        const projectGid = await service.resolveProject(workspace, project);
        const sections = await service.listSections(projectGid);
        printNamed(sections, resolveFormat(options, 'compact'), `Sections of ${project}:`);
      }),
    );

  // ------------------------------------------------------------------ section
  // Singular, mirroring `project` vs `projects`: `sections` reads, `section`
  // writes.
  const section = asana
    .command('section')
    .description('Create the board columns of a project');

  // ----------------------------------------------------------- section create
  section
    .command('create <project> <names...>')
    .description('Create one or more sections in a project, in the order given')
    .option('--workspace <name|gid>', 'Workspace to resolve the project in')
    .addHelpText(
      'after',
      `
${chalk.yellow('Examples:')}
  claude-tools asana section create Personal Now Next Later Done
  claude-tools asana section create "Acme Core" "Waiting on someone"

${chalk.yellow('Note:')}
  Asana appends each new section after the existing ones, so the order you pass
  is the order they appear on the board.

  A name that already exists in the project is skipped, not duplicated - Asana
  itself would happily create a second column with the same name, which would
  then make ${chalk.bold('move --section')} ambiguous forever.

  A project always has one section already, usually called "Untitled section",
  holding everything imported into it. Creating columns does not move any task;
  use ${chalk.bold('move --section')} for that.
`,
    )
    .action(async (projectName: string, names: string[], options: { workspace?: string }) =>
      run(async (service) => {
        const workspace = await service.resolveDefaultWorkspace(options.workspace);
        const projectGid = await service.resolveProject(workspace, projectName);

        const existing = await service.listSections(projectGid);
        const taken = new Set(existing.map((s) => s.name.trim().toLowerCase()));

        for (const name of names) {
          const wanted = name.trim();
          if (taken.has(wanted.toLowerCase())) {
            console.log(chalk.yellow('Exists:'), wanted, chalk.dim('(skipped)'));
            continue;
          }
          const created = await service.createSection(projectGid, wanted);
          taken.add(wanted.toLowerCase());
          console.log(chalk.green('Created section:'), chalk.cyan(created.gid), created.name);
        }
      }),
    );

  // ----------------------------------------------------------- section delete
  section
    .command('delete <project> <names...>')
    .description('Delete empty sections from a project (a section holding tasks is refused)')
    .option('--workspace <name|gid>', 'Workspace to resolve the project in')
    .addHelpText(
      'after',
      `
${chalk.yellow('Examples:')}
  ${chalk.dim('# Tidy up the column an import left behind')}
  claude-tools asana section delete Personal "Untitled section"
  claude-tools asana section delete Infrastructure Backlog Active Completed

${chalk.yellow('Why this is safe, unlike deleting a project:')}
  Asana refuses to delete a section that still holds tasks, so this cannot lose
  work. It also refuses to delete a project's only remaining section. Both
  refusals are reported per section and the rest still run.

  Tasks are never deleted here. Move them out first with ${chalk.bold('move --section')}, then
  delete the empty column.
`,
    )
    .action(async (projectName: string, names: string[], options: { workspace?: string }) =>
      run(async (service) => {
        const workspace = await service.resolveDefaultWorkspace(options.workspace);
        const projectGid = await service.resolveProject(workspace, projectName);
        const sections = await service.listSections(projectGid);

        let failures = 0;
        for (const name of names) {
          const wanted = name.trim().toLowerCase();
          const hit = sections.find((s) => s.name.trim().toLowerCase() === wanted);
          if (!hit) {
            console.log(chalk.yellow('Not found:'), name, chalk.dim('(skipped)'));
            continue;
          }

          // Checked here rather than left to Asana so the reason names the count,
          // which is what tells the caller what to move.
          const held = await service.listTasks({ section: hit.gid, includeCompleted: true, limit: 1 });
          if (held.length > 0) {
            failures++;
            console.log(chalk.red('Not empty:'), hit.name, chalk.dim('- move its tasks out first'));
            continue;
          }

          try {
            await service.deleteSection(hit.gid);
            console.log(chalk.green('Deleted section:'), chalk.cyan(hit.gid), hit.name);
          } catch (err) {
            failures++;
            console.log(chalk.red('Refused:'), hit.name, chalk.dim(`- ${err instanceof Error ? err.message : String(err)}`));
          }
        }
        if (failures > 0) process.exitCode = 1;
      }),
    );

  // --------------------------------------------------------------------- list
  asana
    .command('list')
    .description('List tasks (defaults to your own incomplete tasks)')
    .option('--workspace <name|gid>', 'Workspace')
    .option('--project <name|gid>', 'List a project\'s tasks instead')
    .option('--section <name|gid>', 'List a section\'s tasks (needs --project for a name)')
    .option('--assignee <me|name|gid>', 'Assignee for the default view', 'me')
    .option('--completed', 'Include completed tasks')
    .option('--due-before <YYYY-MM-DD>', 'Only tasks due before this date')
    .option('--limit <n>', 'Number of results', '50')
    .option('--format <type>', 'Output format: title, compact, verbose, json (default: compact)')
    .option('--verbose', 'Shorthand for --format=verbose')
    .option('--json', 'Shorthand for --format=json')
    .addHelpText(
      'after',
      `
${chalk.yellow('Examples:')}
  ${chalk.dim('# What is on my plate')}
  claude-tools asana list

  ${chalk.dim('# A project, by name, including completed tasks')}
  claude-tools asana list --project "Acme Core" --completed

  ${chalk.dim('# One section of a project')}
  claude-tools asana list --project Personal --section "In progress"

  ${chalk.dim('# Overdue-ish view, machine readable')}
  claude-tools asana list --due-before 2026-10-01 --json

${chalk.yellow('Note:')}
  With no --project this lists YOUR incomplete tasks across the workspace; a
  configured asana.defaultProject is not applied here.
`,
    )
    .action(async (options: {
      workspace?: string;
      project?: string;
      section?: string;
      assignee: string;
      completed?: boolean;
      dueBefore?: string;
      limit: string;
      format?: string;
      verbose?: boolean;
      json?: boolean;
    }) =>
      run(async (service, config) => {
        assertDueDate(options.dueBefore, '--due-before');
        const format = resolveFormat(options, 'compact');
        const workspace = await service.resolveDefaultWorkspace(options.workspace);
        const project = await resolveProjectOption(service, config, workspace, options.project, { useDefault: false });

        let section: string | undefined;
        if (options.section) {
          if (isGid(options.section)) section = options.section.trim();
          else if (project) section = await service.resolveSection(project, options.section);
          else {
            console.error(chalk.red('Error: --section by name needs --project (or pass the section gid)'));
            process.exit(1);
          }
        }

        const assignee = project || section ? undefined : await service.resolveUser(workspace, options.assignee);

        const tasks = await service.listTasks({
          workspace,
          project,
          section,
          assignee,
          includeCompleted: options.completed === true,
          dueBefore: options.dueBefore,
          limit: parseLimit(options.limit, 50),
        });

        const heading = options.section
          ? `Tasks in section ${options.section}:`
          : options.project
            ? `Tasks in ${options.project}:`
            : `Tasks for ${options.assignee}:`;
        printTasks(tasks, format, heading);
      }),
    );

  // --------------------------------------------------------------------- show
  asana
    .command('show <task>')
    .description('Show a task in full (gid or name)')
    .option('--workspace <name|gid>', 'Workspace to resolve a task name in')
    .option('--comments', 'Also print the comment feed')
    .option('--json', 'Output as JSON')
    .action(async (task: string, options: { workspace?: string; comments?: boolean; json?: boolean }) =>
      run(async (service) => {
        const workspace = await service.resolveDefaultWorkspace(options.workspace);
        const gid = await service.resolveTask(workspace, task);
        const detail = await service.getTask(gid);
        const comments = options.comments ? await service.listComments(gid) : undefined;

        if (options.json) {
          console.log(JSON.stringify(comments ? { ...detail, comments } : detail, null, 2));
          return;
        }

        console.log();
        console.log(chalk.cyan(detail.gid), chalk.bold(detail.name));
        console.log(chalk.dim('-'.repeat(60)));
        console.log(`Status:   ${detail.completed ? chalk.green('done') : chalk.yellow('open')}`);
        console.log(`Assignee: ${detail.assignee || 'Unassigned'}`);
        console.log(`Due:      ${detail.dueAt || detail.dueOn || 'none'}`);
        const where = sectionLabel(detail);
        if (where) console.log(`In:       ${where}`);
        if (detail.parent) console.log(`Parent:   ${detail.parent.name} (${detail.parent.gid})`);
        if (detail.numSubtasks) console.log(`Subtasks: ${detail.numSubtasks}`);
        if (detail.tags.length > 0) console.log(`Tags:     ${detail.tags.join(', ')}`);
        for (const field of detail.customFields) console.log(`${(field.name + ':').padEnd(10)}${field.value}`);
        console.log(`Created:  ${formatTimestamp(detail.createdAt)}`);
        console.log(`Modified: ${formatTimestamp(detail.modifiedAt)}`);
        if (detail.completedAt) console.log(`Finished: ${formatTimestamp(detail.completedAt)}`);

        if (detail.notesMarkdown) {
          console.log();
          console.log(chalk.bold('Notes:'));
          for (const line of detail.notesMarkdown.split('\n')) console.log(`  ${line}`);
        }

        if (comments) printComments(comments);

        if (detail.permalinkUrl) console.log(chalk.dim(`\nURL: ${detail.permalinkUrl}`));
      }),
    );

  // ------------------------------------------------------------------- search
  asana
    .command('search <text>')
    .description('Full-text task search across a workspace')
    .option('--workspace <name|gid>', 'Workspace')
    .option('--incomplete', 'Only incomplete tasks')
    .option('--limit <n>', 'Number of results', '50')
    .option('--format <type>', 'Output format: title, compact, verbose, json (default: compact)')
    .option('--verbose', 'Shorthand for --format=verbose')
    .option('--json', 'Shorthand for --format=json')
    .addHelpText(
      'after',
      `
${chalk.yellow('Examples:')}
  claude-tools asana search "mobile release"
  claude-tools asana search cluster --incomplete --limit 10

${chalk.yellow('Note:')}
  Uses Asana's premium tasks/search endpoint, which has no offset pagination -
  pages are walked with a created_at cursor, so results come back oldest first.
  On a free workspace Asana answers 402 and the error says so.
`,
    )
    .action(async (text: string, options: { workspace?: string; incomplete?: boolean; limit: string; format?: string; verbose?: boolean; json?: boolean }) =>
      run(async (service) => {
        const workspace = await service.resolveDefaultWorkspace(options.workspace);
        const tasks = await service.searchTasks(workspace, {
          text,
          limit: parseLimit(options.limit, 50),
          completed: options.incomplete ? false : undefined,
        });
        printTasks(tasks, resolveFormat(options, 'compact'), `Search: ${text}`);
      }),
    );

  // ------------------------------------------------------------------- create
  asana
    .command('create <name>')
    .description('Create a task')
    .option('--workspace <name|gid>', 'Workspace')
    .option('--project <name|gid>', 'Project to create it in')
    .option('--section <name|gid>', 'Section within the project')
    .option('--notes <text>', 'Notes, as Markdown (use "-" for stdin)')
    .option('--assignee <me|name|gid>', 'Assignee')
    .option('--due <YYYY-MM-DD>', 'Due date')
    .option('--parent <name|gid>', 'Create as a subtask of this task')
    .addHelpText(
      'after',
      `
${chalk.yellow('Examples:')}
  claude-tools asana create "Renew the domain" --project Personal --due 2026-10-01 --assignee me

  ${chalk.dim('# Notes from a file; Markdown becomes Asana rich text')}
  cat notes.md | claude-tools asana create "Write the postmortem" --project Infrastructure --notes -

  ${chalk.dim('# A subtask')}
  claude-tools asana create "Book the flight" --parent 1218000000000039

${chalk.yellow('Stdin support:')} --notes - reads the notes from stdin
`,
    )
    .action(async (name: string, options: {
      workspace?: string;
      project?: string;
      section?: string;
      notes?: string;
      assignee?: string;
      due?: string;
      parent?: string;
    }) =>
      run(async (service, config) => {
        assertDueDate(options.due, '--due');
        const notes = await resolveText(options.notes);
        const workspace = await service.resolveDefaultWorkspace(options.workspace);
        const project = await resolveProjectOption(service, config, workspace, options.project);
        const parent = options.parent ? await service.resolveTask(workspace, options.parent, { forWrite: true }) : undefined;
        const assignee = options.assignee ? await service.resolveUser(workspace, options.assignee, { forWrite: true }) : undefined;

        let section: string | undefined;
        if (options.section) {
          if (!project) {
            console.error(chalk.red('Error: --section needs --project (or asana.defaultProject)'));
            process.exit(1);
          }
          section = await service.resolveSection(project, options.section);
        }

        const task = await service.createTask({
          name,
          workspace,
          projects: project ? [project] : undefined,
          parent,
          notes,
          assignee,
          dueOn: options.due,
        });

        // The task exists from here on. Print it before attempting anything
        // else, so a failure in the section placement below cannot hide the gid
        // and get the command retried into a duplicate task. Same shape as
        // `jira create`, which warns rather than fails on assign/status.
        console.log(chalk.green('Created:'), chalk.cyan(task.gid), `- ${task.name}`);
        if (task.permalinkUrl) console.log(chalk.dim(`URL: ${task.permalinkUrl}`));

        // A task can only join a section of a project it already belongs to, so
        // this is a second call rather than a field on create.
        if (section) {
          try {
            await service.moveToSection(section, task.gid);
          } catch (moveErr) {
            // Redacted like every other diagnostic: this local catch is exactly
            // the path that bypasses run()'s handler, and a transport-level
            // exception is not formatted by the service.
            console.error(
              chalk.yellow('Warning:'),
              redactAsanaToken(
                `Created, but could not move it into "${options.section}": ${(moveErr as Error).message}`,
                config.accessToken,
              ),
            );
          }
        }
      }),
    );

  // ------------------------------------------------------------------- update
  asana
    .command('update <task>')
    .description('Update a task\'s name, notes or due date')
    .option('--workspace <name|gid>', 'Workspace to resolve a task name in')
    .option('--name <text>', 'New name')
    .option('--notes <text>', 'New notes, as Markdown (use "-" for stdin, replaces the old notes)')
    .option('--due <YYYY-MM-DD>', 'New due date')
    .option('--clear-due', 'Remove the due date')
    .addHelpText(
      'after',
      `
${chalk.yellow('Examples:')}
  claude-tools asana update 1218000000000039 --name "Renew the domain (autorenew on)"
  cat notes.md | claude-tools asana update 1218000000000039 --notes -
  claude-tools asana update 1218000000000039 --clear-due

${chalk.yellow('Note:')}
  For completion use done/reopen, for assignment use assign, for sections use move.
`,
    )
    .action(async (task: string, options: { workspace?: string; name?: string; notes?: string; due?: string; clearDue?: boolean }) =>
      run(async (service) => {
        assertDueDate(options.due, '--due');
        if (options.due && options.clearDue) {
          console.error(chalk.red('Error: --due and --clear-due cannot both be given'));
          process.exit(1);
        }

        const notes = await resolveText(options.notes);
        const workspace = await service.resolveDefaultWorkspace(options.workspace);
        const gid = await service.resolveTask(workspace, task, { forWrite: true });

        const updated = await service.updateTask(gid, {
          name: options.name,
          notes,
          dueOn: options.clearDue ? null : options.due,
        });

        console.log(chalk.green('Updated:'), chalk.cyan(updated.gid));
        if (options.name) console.log(`  Name: ${updated.name}`);
        if (notes) console.log(`  Notes: ${notes.slice(0, 50)}${notes.length > 50 ? '...' : ''}`);
        else if (notes === '') console.log('  Notes: cleared');
        if (options.due) console.log(`  Due: ${options.due}`);
        if (options.clearDue) console.log('  Due: cleared');
      }),
    );

  // ------------------------------------------------------------------ comment
  asana
    .command('comment <task> <text>')
    .description('Comment on a task (use "-" to read from stdin)')
    .option('--workspace <name|gid>', 'Workspace to resolve a task name in')
    .addHelpText(
      'after',
      `
${chalk.yellow('Examples:')}
  claude-tools asana comment 1218000000000039 "Deployed, watching the logs"
  cat update.md | claude-tools asana comment 1218000000000039 -

${chalk.yellow('Note:')}
  Comments are attributed to the token's owner in Asana, and stories reject
  headings, so "# Title" becomes bold rather than failing the write.
`,
    )
    .action(async (task: string, text: string, options: { workspace?: string }) =>
      run(async (service) => {
        const resolved = await resolveText(text);
        if (!resolved) {
          console.error(chalk.red('Error: Comment text is required'));
          process.exit(1);
        }
        const workspace = await service.resolveDefaultWorkspace(options.workspace);
        const gid = await service.resolveTask(workspace, task, { forWrite: true });
        const comment = await service.addComment(gid, resolved);
        console.log(chalk.green('Comment added'), `to ${chalk.cyan(gid)} (gid: ${comment.gid})`);
      }),
    );

  // --------------------------------------------------------------- done/reopen
  const completion = (verb: 'done' | 'reopen') =>
    asana
      .command(`${verb} <task>`)
      .description(verb === 'done' ? 'Mark a task complete' : 'Mark a task incomplete')
      .option('--workspace <name|gid>', 'Workspace to resolve a task name in')
      .action(async (task: string, options: { workspace?: string }) =>
        run(async (service) => {
          const workspace = await service.resolveDefaultWorkspace(options.workspace);
          const gid = await service.resolveTask(workspace, task, { forWrite: true });
          const updated = await service.setCompleted(gid, verb === 'done');
          console.log(
            chalk.green(verb === 'done' ? 'Completed:' : 'Reopened:'),
            chalk.cyan(updated.gid),
            `- ${updated.name}`,
          );
        }),
      );
  completion('done');
  completion('reopen');

  // ------------------------------------------------------------------- assign
  asana
    .command('assign <task> <assignee>')
    .description('Assign a task ("me", a name, a gid, an email, or "none" to unassign)')
    .option('--workspace <name|gid>', 'Workspace to resolve names in')
    .action(async (task: string, assignee: string, options: { workspace?: string }) =>
      run(async (service) => {
        const workspace = await service.resolveDefaultWorkspace(options.workspace);
        const gid = await service.resolveTask(workspace, task, { forWrite: true });
        const clear = ['none', 'nobody', 'unassign'].includes(assignee.trim().toLowerCase());
        const resolved = clear ? null : await service.resolveUser(workspace, assignee, { forWrite: true });

        await service.updateTask(gid, { assignee: resolved });
        console.log(chalk.green('Assigned:'), chalk.cyan(gid), `-> ${clear ? 'nobody' : assignee}`);
      }),
    );

  // --------------------------------------------------------------------- move
  asana
    .command('move <task>')
    .description('Move a task into a section (and optionally into another project)')
    .requiredOption('--section <name|gid>', 'Target section')
    .option('--project <name|gid>', 'Target project (adds the task to it if needed)')
    .option('--from <name|gid>', 'Project to drop afterwards, making this a real move rather than a copy')
    .option('--workspace <name|gid>', 'Workspace to resolve names in')
    .addHelpText(
      'after',
      `
${chalk.yellow('Examples:')}
  claude-tools asana move 1218000000000039 --section "In progress"
  claude-tools asana move "Renew the domain" --project Personal --section Done

  ${chalk.dim('# A real move: land it in Infrastructure and stop it showing in Personal')}
  claude-tools asana move 1218000000000041 --project Infrastructure --section Backlog --from Personal

${chalk.yellow('Note:')}
  Without --project the section is looked up among the projects the task is
  already in, and an ambiguous name lists the candidates. Sections are board
  columns - completion itself is done/reopen.

${chalk.yellow('--project adds; only --from removes.')}
  A task can belong to several projects, so ${chalk.bold('--project')} alone leaves it in the
  old one too and it shows on both boards. Pass ${chalk.bold('--from')} to drop that
  membership once the move has landed.

  ${chalk.bold('--from')} refuses to leave the task in no project at all. A task with no
  project is invisible on every board and only reachable through "My tasks", so
  removing its last membership is treated as a mistake rather than obeyed.
`,
    )
    .action(async (task: string, options: { section: string; project?: string; from?: string; workspace?: string }) =>
      run(async (service) => {
        const workspace = await service.resolveDefaultWorkspace(options.workspace);
        const gid = await service.resolveTask(workspace, task, { forWrite: true });
        const project = options.project ? await service.resolveProject(workspace, options.project) : undefined;

        let section: string;
        if (isGid(options.section)) {
          section = options.section.trim();
        } else if (project) {
          section = await service.resolveSection(project, options.section);
        } else {
          // No project given: search the sections of the projects this task is
          // already in, so `move <task> --section Done` works on a single-project
          // task without naming the project again.
          const detail = await service.getTask(gid);
          const wanted = options.section.trim().toLowerCase();
          const hits: { project: NamedResource; section: NamedResource }[] = [];
          for (const membership of detail.projects) {
            for (const candidate of await service.listSections(membership.gid)) {
              if (candidate.name.trim().toLowerCase() === wanted) hits.push({ project: membership, section: candidate });
            }
          }

          // Thrown, not printed here, so these go through the same redacting
          // handler as every other diagnostic.
          if (hits.length === 0) {
            const where = detail.projects.map((p) => p.name).join(', ') || 'none';
            throw new Error(`No section "${options.section}" in this task's projects (${where}). Pass --project.`);
          }
          if (hits.length > 1) {
            throw new AsanaAmbiguousNameError(
              'section',
              options.section,
              hits.map((hit) => ({ gid: hit.section.gid, name: `${hit.project.name} / ${hit.section.name}` })),
            );
          }
          section = hits[0].section.gid;
        }

        // addProject can place a task in a section of a project it is not in
        // yet; addTask only works within a project it already belongs to.
        if (project) await service.addToProject(gid, project, section);
        else await service.moveToSection(section, gid);

        // Resolved after the add, so the freshly added target counts towards the
        // "would this orphan the task" check below.
        if (options.from) {
          const from = await service.resolveProject(workspace, options.from);
          if (from === project) throw new Error('--from names the same project as --project; nothing to drop.');

          const after = await service.getTask(gid);
          const remaining = after.projects.filter((p) => p.gid !== from);
          if (!after.projects.some((p) => p.gid === from)) {
            throw new Error(`This task is not in "${options.from}", so there is no membership to drop.`);
          }
          if (remaining.length === 0) {
            throw new Error(
              `Dropping "${options.from}" would leave this task in no project at all, where it is invisible on every board. Pass --project to give it a home first.`,
            );
          }

          await service.removeFromProject(gid, from);
          console.log(
            chalk.green('Moved:'),
            chalk.cyan(gid),
            `-> ${options.section}`,
            chalk.dim(`(dropped ${options.from}; now in ${remaining.map((p) => p.name).join(', ')})`),
          );
          return;
        }

        console.log(chalk.green('Moved:'), chalk.cyan(gid), `-> ${options.section}`);
      }),
    );
}
