// Asana client service using plain fetch.
//
// Deliberately hand-written rather than the official `asana` npm package: that
// package is CommonJS swagger-codegen output that drags `superagent` in, and
// the three things that actually matter here - `opt_fields` defaults, the two
// different pagination models, and Retry-After handling - are easier to get
// right directly than to steer through a generated client.

import type { AsanaConfig } from '../config/types.js';
import { markdownToAsanaHtml, asanaHtmlToMarkdown } from '../utils/markdown-to-asana-html.js';

const BASE_URL = 'https://app.asana.com/api/1.0';

/** Asana's own maximum page size. */
const PAGE_SIZE = 100;

/** Runaway bound, same shape as the JIRA paginators. */
const MAX_PAGES = 100;

const MAX_RETRIES = 3;

/** A Retry-After longer than this is a wall, not a hiccup - report it instead. */
const MAX_RETRY_WAIT_MS = 60_000;

/** Asana's maximum for a typeahead request. */
const TYPEAHEAD_COUNT = 100;

/**
 * Asana returns *compact* resources by default: for a task that is only
 * `gid`, `resource_type`, `name`, `resource_subtype` and `created_by` - no
 * assignee, no due date, not even `completed`. Every read therefore names the
 * fields it renders, and these two sets are the canonical ones.
 */
export const TASK_LIST_FIELDS = [
  'name',
  'completed',
  'due_on',
  'assignee.name',
  'permalink_url',
];

export const TASK_DETAIL_FIELDS = [
  ...TASK_LIST_FIELDS,
  'notes',
  'html_notes',
  'created_at',
  'modified_at',
  'completed_at',
  'due_at',
  'start_on',
  'num_subtasks',
  'parent.name',
  'projects.name',
  'tags.name',
  'memberships.project.name',
  'memberships.section.name',
  'custom_fields.name',
  'custom_fields.display_value',
];

export const PROJECT_FIELDS = ['name', 'archived', 'permalink_url'];

/**
 * Everything `project show` renders. The compact project Asana returns by
 * default is `gid`, `name` and `resource_type` - the description, which is the
 * whole reason a project is worth reading, is not in it.
 */
export const PROJECT_DETAIL_FIELDS = [
  ...PROJECT_FIELDS,
  'notes',
  'html_notes',
  'color',
  'public',
  'created_at',
  'modified_at',
  'owner.name',
  'team.name',
  'workspace.name',
  'due_on',
  'start_on',
  'default_view',
  'current_status.title',
  'current_status.text',
];

export const STORY_FIELDS = ['created_at', 'created_by.name', 'resource_subtype', 'text', 'html_text'];

/**
 * Asana's project colour enum, quoted from the 400 the API itself answers an
 * unknown value with. Two traps live in this list: there is a `light-yellow`
 * but no `dark-yellow`, and the grey is spelled `gray`. `none` clears it.
 */
export const PROJECT_COLORS = [
  'dark-blue',
  'dark-brown',
  'dark-green',
  'dark-orange',
  'dark-pink',
  'dark-purple',
  'dark-red',
  'dark-teal',
  'dark-warm-gray',
  'light-blue',
  'light-green',
  'light-orange',
  'light-pink',
  'light-purple',
  'light-red',
  'light-teal',
  'light-warm-gray',
  'light-yellow',
  'none',
];

/**
 * Asana **reads a project's colour back under a different name than it accepts
 * on a write**, and rejects its own output with a 400: `PUT color=light-purple`
 * then `GET` answers `purple`, and `PUT color=purple` is
 * "Must be one of {dark-blue, ...}, not: purple". So the obvious round trip -
 * read a project, write one field back - fails on the colour alone.
 *
 * This map closes that, and was built by writing all 19 accepted values and
 * reading each one back. It is also where the write enum's own aliases show up:
 * `dark-blue` and `light-blue` are both stored as `blue`, and `light-yellow` is
 * stored as `dark-brown`, so Asana normalises the pair away.
 */
export const PROJECT_COLOR_ALIASES: Record<string, string> = {
  blue: 'light-blue',
  'blue-green': 'light-teal',
  'cool-gray': 'light-warm-gray',
  aqua: 'dark-teal',
  green: 'dark-green',
  'hot-pink': 'dark-pink',
  indigo: 'dark-purple',
  magenta: 'light-pink',
  orange: 'dark-orange',
  pink: 'light-red',
  purple: 'light-purple',
  red: 'dark-red',
  yellow: 'dark-brown',
  'yellow-green': 'light-green',
  'yellow-orange': 'light-orange',
};

/**
 * Settle on a colour Asana will accept, rather than letting it answer 400: the
 * message can then name the whole enum, and a name `project show` printed is
 * translated instead of refused. Applied to `create` and `update` alike, so
 * neither can accept what the other rejects.
 */
export function normalizeProjectColor(value: string): string {
  const color = value.trim().toLowerCase();
  if (PROJECT_COLORS.includes(color)) return color;

  // Own properties only. A plain index lookup also answers for anything on
  // `Object.prototype`: `--color constructor` returned the `Object` function and
  // `--color __proto__` returned the prototype itself, and because
  // `JSON.stringify` drops a function value the write would then go out with no
  // `color` field at all and report success.
  const alias = Object.prototype.hasOwnProperty.call(PROJECT_COLOR_ALIASES, color)
    ? PROJECT_COLOR_ALIASES[color]
    : undefined;
  if (alias !== undefined) return alias;

  throw new Error(
    `Unknown project color "${value}". Asana accepts: ${PROJECT_COLORS.join(', ')}. ` +
      `The names it reads back are also taken: ${Object.keys(PROJECT_COLOR_ALIASES).sort().join(', ')}. ` +
      'There is no dark-yellow, and the grey is spelled "gray".',
  );
}

/**
 * Anything that looks like an Asana personal access token, whatever shape a
 * future one takes: `<digit>/<numeric id>:<secret>`. The token format is
 * documented as opaque and subject to change, so the configured value is also
 * matched literally.
 */
const TOKEN_PATTERN = /\b\d\/\d{6,}:[A-Za-z0-9]{8,}\b/g;

/**
 * Strip the credential out of text about to be printed or thrown. An Asana
 * error body is arbitrary upstream text and a proxy in front of it may well
 * echo the Authorization header, so nothing reaches a terminal unredacted.
 */
export function redactAsanaToken(text: string, token?: string): string {
  let out = text;
  // split/join, not a regex, because the token is not a safe pattern.
  if (token && token.length >= 8) out = out.split(token).join('<redacted>');
  return out.replace(TOKEN_PATTERN, '<redacted>').replace(/Bearer\s+\S+/gi, 'Bearer <redacted>');
}

/**
 * True for a value that is already an Asana gid rather than a name to resolve.
 *
 * Real gids are 16 digits and growing; the 9-digit floor keeps a project called
 * "2026" from being read as an id. A resource whose *name* is nine or more
 * digits has to be addressed by gid.
 */
export function isGid(value: string): boolean {
  return /^\d{9,}$/.test(value.trim());
}

export interface NamedResource {
  gid: string;
  name: string;
}

export interface AsanaWorkspace extends NamedResource {
  isOrganization?: boolean;
}

export interface AsanaUser extends NamedResource {
  email?: string;
  workspaces?: AsanaWorkspace[];
}

export interface AsanaProject extends NamedResource {
  archived?: boolean;
  permalinkUrl?: string;
}

/**
 * A project read with `PROJECT_DETAIL_FIELDS`. The listing returns the same
 * shape with the extra fields simply absent, so one mapper serves both.
 */
export interface AsanaProjectDetail extends AsanaProject {
  notes?: string;
  htmlNotes?: string;
  /** `html_notes` rendered back to markdown, for terminal display. */
  notesMarkdown?: string;
  color?: string;
  /** Asana's `public`, renamed: `public` is awkward to read as a field. */
  isPublic?: boolean;
  createdAt?: string;
  modifiedAt?: string;
  owner?: string;
  team?: string;
  workspace?: NamedResource;
  dueOn?: string;
  startOn?: string;
  defaultView?: string;
  currentStatus?: string;
}

export type AsanaSection = NamedResource;

export interface AsanaMembership {
  project?: string;
  section?: string;
}

export interface AsanaTask {
  gid: string;
  name: string;
  completed: boolean;
  dueOn?: string;
  dueAt?: string;
  startOn?: string;
  assignee?: string;
  permalinkUrl?: string;
  notes?: string;
  htmlNotes?: string;
  /** `html_notes` rendered back to markdown, for terminal display. */
  notesMarkdown?: string;
  createdAt?: string;
  modifiedAt?: string;
  completedAt?: string;
  numSubtasks?: number;
  parent?: NamedResource;
  projects: NamedResource[];
  memberships: AsanaMembership[];
  tags: string[];
  customFields: { name: string; value: string }[];
}

export interface AsanaComment {
  gid: string;
  text: string;
  createdBy?: string;
  createdAt: string;
}

/** Raw compact shapes. Every gid stays a string - see `mapTask`. */
interface RawNamed {
  gid?: string;
  name?: string;
}

interface RawTask extends RawNamed {
  completed?: boolean;
  due_on?: string | null;
  due_at?: string | null;
  start_on?: string | null;
  assignee?: RawNamed | null;
  permalink_url?: string;
  notes?: string;
  html_notes?: string;
  created_at?: string;
  modified_at?: string;
  completed_at?: string | null;
  num_subtasks?: number;
  parent?: RawNamed | null;
  projects?: RawNamed[];
  memberships?: { project?: RawNamed | null; section?: RawNamed | null }[];
  tags?: RawNamed[];
  custom_fields?: { name?: string; display_value?: string | null }[];
}

interface RawProject extends RawNamed {
  archived?: boolean;
  permalink_url?: string;
  notes?: string;
  html_notes?: string;
  color?: string | null;
  public?: boolean;
  created_at?: string;
  modified_at?: string;
  owner?: RawNamed | null;
  team?: RawNamed | null;
  workspace?: RawNamed | null;
  due_on?: string | null;
  start_on?: string | null;
  default_view?: string;
  current_status?: { title?: string; text?: string } | null;
}

interface RawStory {
  gid?: string;
  created_at?: string;
  created_by?: RawNamed | null;
  resource_subtype?: string;
  text?: string;
  html_text?: string;
}

interface AsanaEnvelope<T> {
  data?: T;
  next_page?: { offset?: string } | null;
  errors?: { message?: string; help?: string; error?: string }[];
}

export type QueryParams = Record<string, string | number | boolean | undefined>;

/**
 * A name that matched more than one resource. Carries the candidates so the
 * command layer can print them with their gids instead of guessing.
 */
export class AsanaAmbiguousNameError extends Error {
  constructor(
    readonly kind: string,
    readonly query: string,
    readonly candidates: NamedResource[],
  ) {
    super(
      `Multiple ${kind}s match "${query}": ` +
        candidates.map((c) => `${c.gid}: ${c.name || '(unnamed)'}`).join(', ') +
        '. Pass the gid.',
    );
    this.name = 'AsanaAmbiguousNameError';
  }
}

/**
 * Pick the one resource a name refers to.
 *
 * Exact match wins over prefix, prefix over substring, so "Personal" resolves
 * even when "Personal Finance" exists. A tie at the winning tier is ambiguous
 * and never resolved by position.
 */
export function matchByName<T extends NamedResource>(candidates: T[], query: string, kind: string): T {
  const wanted = query.trim().toLowerCase();
  const named = candidates.filter((c) => typeof c.name === 'string' && c.name.length > 0);

  const tiers = [
    named.filter((c) => c.name.toLowerCase() === wanted),
    named.filter((c) => c.name.toLowerCase().startsWith(wanted)),
    named.filter((c) => c.name.toLowerCase().includes(wanted)),
  ];

  for (const tier of tiers) {
    if (tier.length === 1) return tier[0];
    if (tier.length > 1) throw new AsanaAmbiguousNameError(kind, query, tier);
  }

  const known = named.slice(0, 10).map((c) => c.name).join(', ');
  throw new Error(
    `No ${kind} matches "${query}".` + (known ? ` Known ${kind}s: ${known}` : ''),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AsanaService {
  private readonly config: AsanaConfig;
  private readonly fetchImpl: typeof fetch;
  /**
   * Where a "this result may be incomplete" notice goes. The service does not
   * own the terminal, so the command layer supplies the printer and tests can
   * assert on it.
   */
  private readonly warn: (message: string) => void;
  /** `whoami` is needed to resolve `me`, and the answer never changes mid-run. */
  private cachedUser?: AsanaUser;

  constructor(config: AsanaConfig, fetchImpl: typeof fetch = fetch, warn: (message: string) => void = () => {}) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.warn = warn;
  }

  // ---------------------------------------------------------------- transport

  private buildUrl(path: string, params?: QueryParams): string {
    const url = new URL(BASE_URL + path);
    for (const [key, value] of Object.entries(params || {})) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private redact(text: string): string {
    return redactAsanaToken(text, this.config.accessToken);
  }

  private async fail(response: Response, path: string): Promise<never> {
    const body = await response.text().catch(() => '');
    let detail = body;
    try {
      const parsed = JSON.parse(body) as AsanaEnvelope<unknown>;
      const messages = (parsed.errors || []).map((e) => e.message || e.error).filter(Boolean);
      if (messages.length > 0) detail = messages.join('; ');
    } catch {
      // Non-JSON body (a proxy error page); the raw text is the best we have.
    }
    detail = this.redact(detail).slice(0, 600);

    if (response.status === 401) {
      throw new Error(
        `Asana rejected the access token: ${detail}\n` +
          'Check ASANA_ACCESS_TOKEN or the asana.accessToken secret, and that the token is still listed at https://app.asana.com/0/my-apps',
      );
    }
    if (response.status === 402) {
      throw new Error(
        `Asana says this needs a paid workspace: ${detail}\n` +
          'tasks/search is premium-only; `asana list --project ...` works on every plan.',
      );
    }
    if (response.status === 403) {
      throw new Error(`Asana denied access to ${path}: ${detail}`);
    }
    if (response.status === 404) {
      throw new Error(`Asana could not find ${path}: ${detail}`);
    }

    throw new Error(this.redact(`Asana API error ${response.status} ${response.statusText} on ${path}: ${detail}`));
  }

  /**
   * One request, with bounded Retry-After backoff, returning the whole envelope
   * because pagination needs `next_page` as well as `data`.
   *
   * **A 5xx is only retried for a GET.** Asana may well have committed a POST
   * before a gateway returned 502, and `POST /tasks` has no idempotency key, so
   * retrying it can create the task twice - up to four times over the budget.
   * A 429 is different: the request was *rejected*, nothing ran, and rejected
   * requests still count against the quota, so it is waited out with the
   * header's own delay for every method.
   */
  private async requestEnvelope<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    options: { params?: QueryParams; body?: unknown } = {},
  ): Promise<AsanaEnvelope<T>> {
    const url = this.buildUrl(path, options.params);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.accessToken}`,
      Accept: 'application/json',
    };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';

    for (let attempt = 0; ; attempt++) {
      const response = await this.fetchImpl(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });

      const serverError = response.status >= 500 && response.status < 600;
      const retryable = response.status === 429 || (serverError && method === 'GET');
      if (retryable && attempt < MAX_RETRIES) {
        const header = Number(response.headers?.get?.('retry-after'));
        const waitMs = Number.isFinite(header) && header > 0 ? header * 1000 : 1000 * 2 ** attempt;
        if (waitMs <= MAX_RETRY_WAIT_MS) {
          await sleep(waitMs);
          continue;
        }
      }

      if (!response.ok) return this.fail(response, path);

      const text = await response.text();
      if (!text) return {} as AsanaEnvelope<T>;
      // Parsed as ordinary JSON: Asana already sends every gid quoted, and
      // nothing here coerces one to a number, which would silently round any
      // gid above Number.MAX_SAFE_INTEGER.
      return JSON.parse(text) as AsanaEnvelope<T>;
    }
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    options: { params?: QueryParams; body?: unknown } = {},
  ): Promise<T> {
    return (await this.requestEnvelope<T>(method, path, options)).data as T;
  }

  /**
   * Offset pagination, used by every endpoint except `tasks/search`.
   *
   * An offset is only ever one Asana handed back - they expire and must never
   * be synthesised - so the loop simply follows `next_page.offset`.
   */
  private async paginate<T>(
    path: string,
    params: QueryParams,
    options: { limit?: number; keep?: (item: T) => boolean } = {},
  ): Promise<T[]> {
    const out: T[] = [];
    let offset: string | undefined;

    for (let page = 0; page < MAX_PAGES; page++) {
      const envelope = await this.requestEnvelope<T[]>('GET', path, {
        params: { ...params, limit: PAGE_SIZE, offset },
      });

      for (const item of envelope.data || []) {
        if (options.keep && !options.keep(item)) continue;
        out.push(item);
        if (options.limit !== undefined && out.length >= options.limit) return out;
      }

      offset = envelope.next_page?.offset;
      if (!offset) return out;
    }

    throw new Error(`Asana pagination exceeded MAX_PAGES=${MAX_PAGES} for ${path}`);
  }

  // ----------------------------------------------------------------- mapping

  private static mapTask(raw: RawTask): AsanaTask {
    const htmlNotes = raw.html_notes || undefined;
    return {
      gid: String(raw.gid ?? ''),
      name: raw.name || '',
      completed: raw.completed ?? false,
      dueOn: raw.due_on || undefined,
      dueAt: raw.due_at || undefined,
      startOn: raw.start_on || undefined,
      assignee: raw.assignee?.name || undefined,
      permalinkUrl: raw.permalink_url,
      notes: raw.notes || undefined,
      htmlNotes,
      notesMarkdown: htmlNotes ? asanaHtmlToMarkdown(htmlNotes) : raw.notes || undefined,
      createdAt: raw.created_at,
      modifiedAt: raw.modified_at,
      completedAt: raw.completed_at || undefined,
      numSubtasks: raw.num_subtasks,
      parent: raw.parent?.gid ? { gid: String(raw.parent.gid), name: raw.parent.name || '' } : undefined,
      projects: (raw.projects || []).map((p) => ({ gid: String(p.gid ?? ''), name: p.name || '' })),
      memberships: (raw.memberships || []).map((m) => ({
        project: m.project?.name || undefined,
        section: m.section?.name || undefined,
      })),
      tags: (raw.tags || []).map((t) => t.name || '').filter(Boolean),
      customFields: (raw.custom_fields || [])
        .filter((f) => f.display_value)
        .map((f) => ({ name: f.name || '', value: f.display_value || '' })),
    };
  }

  private static mapNamed(raw: RawNamed): NamedResource {
    return { gid: String(raw.gid ?? ''), name: raw.name || '' };
  }

  private static mapProject(raw: RawProject): AsanaProjectDetail {
    const htmlNotes = raw.html_notes || undefined;
    return {
      ...AsanaService.mapNamed(raw),
      archived: raw.archived,
      permalinkUrl: raw.permalink_url,
      notes: raw.notes || undefined,
      htmlNotes,
      notesMarkdown: htmlNotes ? asanaHtmlToMarkdown(htmlNotes) : raw.notes || undefined,
      // A project created without a colour reports `null`; one that has had its
      // colour cleared reports the string "none". Both mean the same thing.
      color: raw.color || undefined,
      isPublic: raw.public,
      createdAt: raw.created_at,
      modifiedAt: raw.modified_at,
      owner: raw.owner?.name || undefined,
      team: raw.team?.name || undefined,
      workspace: raw.workspace?.gid ? AsanaService.mapNamed(raw.workspace) : undefined,
      dueOn: raw.due_on || undefined,
      startOn: raw.start_on || undefined,
      defaultView: raw.default_view,
      currentStatus:
        [raw.current_status?.title, raw.current_status?.text].filter(Boolean).join(' - ') || undefined,
    };
  }

  // -------------------------------------------------------------------- reads

  async whoAmI(): Promise<AsanaUser> {
    if (this.cachedUser) return this.cachedUser;
    const raw = await this.request<{ gid?: string; name?: string; email?: string; workspaces?: RawNamed[] }>(
      'GET',
      '/users/me',
      { params: { opt_fields: 'gid,name,email,workspaces.name' } },
    );
    this.cachedUser = {
      gid: String(raw.gid ?? ''),
      name: raw.name || '',
      email: raw.email,
      workspaces: (raw.workspaces || []).map(AsanaService.mapNamed),
    };
    return this.cachedUser;
  }

  async listWorkspaces(): Promise<AsanaWorkspace[]> {
    const raw = await this.paginate<RawNamed & { is_organization?: boolean }>('/workspaces', {
      opt_fields: 'name,is_organization',
    });
    return raw.map((w) => ({ ...AsanaService.mapNamed(w), isOrganization: w.is_organization }));
  }

  async listProjects(
    workspace: string,
    options: { limit?: number; includeArchived?: boolean } = {},
  ): Promise<AsanaProject[]> {
    const raw = await this.paginate<RawProject>(
      `/workspaces/${workspace}/projects`,
      { opt_fields: PROJECT_FIELDS.join(',') },
      {
        limit: options.limit,
        keep: (project) => options.includeArchived === true || project.archived !== true,
      },
    );
    return raw.map(AsanaService.mapProject);
  }

  /**
   * One project in full, description included.
   *
   * This is the read the whole project surface exists for: a description stored
   * on the project is how a later session finds out what the project is *for*
   * without being told again.
   */
  async getProject(gid: string): Promise<AsanaProjectDetail> {
    const raw = await this.request<RawProject>('GET', `/projects/${gid}`, {
      params: { opt_fields: PROJECT_DETAIL_FIELDS.join(',') },
    });
    return AsanaService.mapProject(raw);
  }

  async listSections(project: string): Promise<AsanaSection[]> {
    const raw = await this.paginate<RawNamed>(`/projects/${project}/sections`, { opt_fields: 'name' });
    return raw.map(AsanaService.mapNamed);
  }

  /**
   * Create a section - a board column - in a project.
   *
   * Asana appends it after the existing sections, so creating several in order
   * gives the board that order. There is no upsert: a second create with the
   * same name yields a second section with the same name, which is why the CLI
   * checks the existing list first rather than relying on Asana to refuse.
   */
  async createSection(project: string, name: string): Promise<AsanaSection> {
    const raw = await this.request<RawNamed>('POST', `/projects/${project}/sections`, {
      params: { opt_fields: 'name' },
      body: { data: { name } },
    });
    return AsanaService.mapNamed(raw);
  }

  /**
   * Delete a section. Asana refuses while it still holds tasks, which is the
   * safety property this relies on: unlike deleting a project, this cannot take
   * tasks with it. A project's last remaining section cannot be deleted either.
   */
  async deleteSection(section: string): Promise<void> {
    await this.request<unknown>('DELETE', `/sections/${section}`);
  }

  /**
   * List tasks from whichever collection the filters imply. Asana's task list
   * endpoints each require a scope: a section, a project, or an assignee paired
   * with a workspace.
   */
  async listTasks(options: {
    workspace?: string;
    project?: string;
    section?: string;
    assignee?: string;
    includeCompleted?: boolean;
    dueBefore?: string;
    limit?: number;
  }): Promise<AsanaTask[]> {
    const params: QueryParams = { opt_fields: TASK_LIST_FIELDS.join(',') };
    let path: string;
    let sortByDue = false;

    if (options.section) {
      path = `/sections/${options.section}/tasks`;
    } else if (options.project) {
      path = `/projects/${options.project}/tasks`;
    } else {
      if (!options.workspace) throw new Error('A workspace is required to list tasks by assignee');
      path = '/tasks';
      params.assignee = options.assignee || 'me';
      params.workspace = options.workspace;
      sortByDue = true;
    }

    // `completed_since=now` is Asana's idiom for "incomplete only". The
    // client-side filter below is not redundant: it also covers the project and
    // section endpoints, and keeps `--limit` counting tasks that are shown.
    if (!options.includeCompleted) params.completed_since = 'now';

    const raw = await this.paginate<RawTask>(path, params, {
      limit: options.limit,
      keep: (task) => {
        if (!options.includeCompleted && task.completed === true) return false;
        if (options.dueBefore) {
          if (!task.due_on) return false;
          if (task.due_on >= options.dueBefore) return false;
        }
        return true;
      },
    });

    const tasks = raw.map(AsanaService.mapTask);
    if (!sortByDue) return tasks;

    // A project or section listing keeps Asana's board order, which is
    // meaningful there. "My tasks" has no such order, so it gets due date.
    return tasks.sort((a, b) => {
      if (a.completed !== b.completed) return a.completed ? 1 : -1;
      const left = a.dueOn || '9999-12-31';
      const right = b.dueOn || '9999-12-31';
      return left === right ? a.name.localeCompare(b.name) : left.localeCompare(right);
    });
  }

  async getTask(gid: string): Promise<AsanaTask> {
    const raw = await this.request<RawTask>('GET', `/tasks/${gid}`, {
      params: { opt_fields: TASK_DETAIL_FIELDS.join(',') },
    });
    return AsanaService.mapTask(raw);
  }

  /**
   * Comments only. The stories feed mixes them with system activity
   * ("assigned to X", "added to project Y"), which reads as noise.
   */
  async listComments(gid: string): Promise<AsanaComment[]> {
    const raw = await this.paginate<RawStory>(`/tasks/${gid}/stories`, {
      opt_fields: STORY_FIELDS.join(','),
    });
    return raw
      .filter((story) => story.resource_subtype === 'comment_added')
      .map((story) => ({
        gid: String(story.gid ?? ''),
        text: story.html_text ? asanaHtmlToMarkdown(story.html_text) : story.text || '',
        createdBy: story.created_by?.name || undefined,
        createdAt: story.created_at || '',
      }));
  }

  /**
   * Full-text search. Premium-only, and the one endpoint with no `offset`
   * pagination: pages are walked forward with a `created_at` cursor instead,
   * deduplicated by gid because the boundary may be inclusive.
   */
  async searchTasks(
    workspace: string,
    options: { text: string; limit?: number; completed?: boolean },
  ): Promise<AsanaTask[]> {
    const limit = options.limit ?? 50;
    const seen = new Set<string>();
    const out: AsanaTask[] = [];
    let after: string | undefined;

    for (let page = 0; page < MAX_PAGES; page++) {
      const params: QueryParams = {
        text: options.text,
        limit: PAGE_SIZE,
        sort_by: 'created_at',
        sort_ascending: true,
        opt_fields: [...TASK_LIST_FIELDS, 'created_at'].join(','),
        completed: options.completed,
        'created_at.after': after,
      };
      const batch = await this.request<RawTask[]>('GET', `/workspaces/${workspace}/tasks/search`, { params });
      const rows = batch || [];

      let added = 0;
      for (const raw of rows) {
        const gid = String(raw.gid ?? '');
        if (!gid || seen.has(gid)) continue;
        seen.add(gid);
        out.push(AsanaService.mapTask(raw));
        added++;
        if (out.length >= limit) return out;
      }

      // A short page is the last page.
      if (rows.length < PAGE_SIZE) return out;

      // Step the cursor back to the last timestamp *strictly below* the final
      // row's. Tasks created in the same instant are adjacent in this sort, so a
      // tie group split across the page boundary would be skipped entirely by an
      // exclusive `created_at.after` on the final row's own timestamp. Backing
      // off re-fetches that group, and the gid set above discards the duplicates.
      const timestamps = rows.map((raw) => raw.created_at).filter((value): value is string => Boolean(value));
      const last = timestamps[timestamps.length - 1];
      const next = timestamps.filter((value) => last !== undefined && value < last).pop();

      // A full page of rows already seen means the walk is stuck, whatever the
      // timestamps say. This is checked before the step-back below, so no branch
      // can keep requesting a page that yields nothing new.
      if (added === 0) {
        this.warn(
          `Asana search stopped after ${out.length} results before reaching the requested ${limit}: ` +
            'a full page contained nothing new, so this result set may be incomplete.',
        );
        return out;
      }

      // No smaller timestamp on a full page means one instant fills the whole
      // page: the cursor cannot back off without stalling, so it advances past
      // the group and says what that costs.
      if (last !== undefined && next === undefined) {
        this.warn(
          `Asana search: at least ${PAGE_SIZE} matching tasks share the creation timestamp ${last}, ` +
            'which fills a whole page. The created_at cursor cannot step back into that group, so any ' +
            'task in it beyond this page may be omitted.',
        );
        after = last;
        continue;
      }

      // A cursor that cannot move means the walk is stuck. Stopping is right;
      // silence is not, because the caller asked for more than came back.
      if (next === undefined || next === after) {
        this.warn(
          `Asana search stopped after ${out.length} results before reaching the requested ${limit}: ` +
            'the created_at cursor could not advance, so this result set may be incomplete. ' +
            'tasks/search has no offset pagination, so completeness cannot be guaranteed for a very broad query.',
        );
        return out;
      }

      after = next;
    }

    // Consistent with `paginate`: 100 pages of 100 is not a result set, it is a
    // query that needs narrowing, and returning it quietly would look complete.
    throw new Error(
      `Asana search pagination exceeded MAX_PAGES=${MAX_PAGES} for "${options.text}". Narrow the query or lower --limit.`,
    );
  }

  // ------------------------------------------------------------------- writes

  async createTask(options: {
    name: string;
    workspace?: string;
    projects?: string[];
    parent?: string;
    notes?: string;
    assignee?: string;
    dueOn?: string;
  }): Promise<AsanaTask> {
    const data: Record<string, unknown> = { name: options.name };

    // Asana needs exactly one anchor: a workspace, a project, or a parent task.
    if (options.parent) data.parent = options.parent;
    if (options.projects && options.projects.length > 0) data.projects = options.projects;
    if (!options.parent && (!options.projects || options.projects.length === 0)) {
      if (!options.workspace) throw new Error('A workspace, project or parent task is required to create a task');
      data.workspace = options.workspace;
    }
    if (options.notes) data.html_notes = markdownToAsanaHtml(options.notes);
    if (options.assignee) data.assignee = options.assignee;
    if (options.dueOn) data.due_on = options.dueOn;

    const raw = await this.request<RawTask>('POST', '/tasks', {
      params: { opt_fields: TASK_LIST_FIELDS.join(',') },
      body: { data },
    });
    return AsanaService.mapTask(raw);
  }

  async updateTask(
    gid: string,
    fields: { name?: string; notes?: string; dueOn?: string | null; completed?: boolean; assignee?: string | null },
  ): Promise<AsanaTask> {
    const data: Record<string, unknown> = {};
    if (fields.name !== undefined) data.name = fields.name;
    if (fields.notes !== undefined) data.html_notes = markdownToAsanaHtml(fields.notes);
    if (fields.dueOn !== undefined) data.due_on = fields.dueOn;
    if (fields.completed !== undefined) data.completed = fields.completed;
    if (fields.assignee !== undefined) data.assignee = fields.assignee;

    if (Object.keys(data).length === 0) throw new Error('No fields to update');

    const raw = await this.request<RawTask>('PUT', `/tasks/${gid}`, {
      params: { opt_fields: TASK_LIST_FIELDS.join(',') },
      body: { data },
    });
    return AsanaService.mapTask(raw);
  }

  /** Completion in Asana is a boolean, not a workflow transition. */
  setCompleted(gid: string, completed: boolean): Promise<AsanaTask> {
    return this.updateTask(gid, { completed });
  }

  async addComment(gid: string, markdown: string): Promise<AsanaComment> {
    const raw = await this.request<RawStory>('POST', `/tasks/${gid}/stories`, {
      params: { opt_fields: STORY_FIELDS.join(',') },
      // Stories reject <h1>/<h2>/<hr/>, so headings degrade to bold here.
      body: { data: { html_text: markdownToAsanaHtml(markdown, { headings: false }) } },
    });
    return {
      gid: String(raw.gid ?? ''),
      text: raw.text || markdown,
      createdBy: raw.created_by?.name || undefined,
      createdAt: raw.created_at || '',
    };
  }

  /** Move a task into a section of a project it is already a member of. */
  async moveToSection(section: string, task: string): Promise<void> {
    await this.request<unknown>('POST', `/sections/${section}/addTask`, { body: { data: { task } } });
  }

  /**
   * Add a task to a project, optionally landing it in a section. Also the call
   * that reorders a task already in that project.
   */
  async addToProject(task: string, project: string, section?: string): Promise<void> {
    const data: Record<string, unknown> = { project };
    if (section) {
      data.section = section;
      // `insert_before: null` means "bottom of the section"; without one of the
      // insert hints the task lands wherever Asana defaults to.
      data.insert_before = null;
    }
    await this.request<unknown>('POST', `/tasks/${task}/addProject`, { body: { data } });
  }

  /**
   * Drop a task's membership of one project. The task itself survives, and so do
   * its other memberships - this is the other half of `addToProject`, which is
   * what makes a real move possible.
   *
   * Removing the last membership leaves the task in no project at all, which is
   * legal in Asana and almost never wanted: it then shows up only in "My tasks"
   * and is invisible on every board. The caller is expected to check first; the
   * CLI's `move --from` does.
   */
  async removeFromProject(task: string, project: string): Promise<void> {
    await this.request<unknown>('POST', `/tasks/${task}/removeProject`, { body: { data: { project } } });
  }

  /**
   * Create a project.
   *
   * A workspace is the only anchor needed: in a personal workspace Asana fills
   * in its own implicit team, which a live create confirmed with a 201. An
   * *organization* does require a team, and there is no right one to guess, so
   * that rejection is passed on with what it means instead of being papered over.
   */
  async createProject(options: {
    name: string;
    workspace: string;
    notes?: string;
    color?: string;
    isPublic?: boolean;
  }): Promise<AsanaProjectDetail> {
    const data: Record<string, unknown> = { name: options.name, workspace: options.workspace };
    // `notes` and `html_notes` are mutually exclusive, so only the rich one is
    // ever sent - the same choice `createTask` makes.
    if (options.notes !== undefined) data.html_notes = markdownToAsanaHtml(options.notes);
    if (options.color !== undefined) data.color = normalizeProjectColor(options.color);
    if (options.isPublic !== undefined) data.public = options.isPublic;

    try {
      const raw = await this.request<RawProject>('POST', '/projects', {
        params: { opt_fields: PROJECT_DETAIL_FIELDS.join(',') },
        body: { data },
      });
      return AsanaService.mapProject(raw);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/\bteam\b/i.test(message)) {
        throw new Error(
          `${message}\nA project in an Asana organization must belong to a team, and this command does ` +
            'not guess one. Create it in the Asana web app, or report this so --team can be added.',
        );
      }
      throw err;
    }
  }

  async updateProject(
    gid: string,
    fields: { name?: string; notes?: string; color?: string; archived?: boolean },
  ): Promise<AsanaProjectDetail> {
    const data: Record<string, unknown> = {};
    if (fields.name !== undefined) data.name = fields.name;
    if (fields.notes !== undefined) data.html_notes = markdownToAsanaHtml(fields.notes);
    if (fields.color !== undefined) data.color = normalizeProjectColor(fields.color);
    if (fields.archived !== undefined) data.archived = fields.archived;

    if (Object.keys(data).length === 0) throw new Error('No fields to update');

    const raw = await this.request<RawProject>('PUT', `/projects/${gid}`, {
      params: { opt_fields: PROJECT_DETAIL_FIELDS.join(',') },
      body: { data },
    });
    return AsanaService.mapProject(raw);
  }

  /**
   * Archiving is a field on the project, and it is the *only* removal this
   * service offers: `DELETE /projects/{gid}` takes the project's tasks with it,
   * and nothing here should be able to do that by accident.
   */
  setProjectArchived(gid: string, archived: boolean): Promise<AsanaProjectDetail> {
    return this.updateProject(gid, { archived });
  }

  // --------------------------------------------------------------- resolution

  /**
   * Asana's fuzzy name lookup, with the saturation flag callers need.
   *
   * `count` is asked for at the endpoint's maximum, but the returned window is
   * still all the evidence `matchByName` has: if it comes back full, a second
   * identically-named resource may sit outside it, and a "unique" exact match
   * cannot be trusted.
   */
  private async typeaheadWindow(
    workspace: string,
    resourceType: 'task' | 'project' | 'user' | 'section' | 'tag',
    query: string,
    count = TYPEAHEAD_COUNT,
  ): Promise<{ candidates: NamedResource[]; saturated: boolean }> {
    const raw = await this.request<RawNamed[]>('GET', `/workspaces/${workspace}/typeahead`, {
      params: { resource_type: resourceType, query, count, opt_fields: 'name' },
    });
    const candidates = (raw || []).map(AsanaService.mapNamed);
    return { candidates, saturated: candidates.length >= count };
  }

  async typeahead(
    workspace: string,
    resourceType: 'task' | 'project' | 'user' | 'section' | 'tag',
    query: string,
    count = TYPEAHEAD_COUNT,
  ): Promise<NamedResource[]> {
    const { candidates, saturated } = await this.typeaheadWindow(workspace, resourceType, query, count);
    if (saturated) this.warn(AsanaService.saturationNotice(query, resourceType, count));
    return candidates;
  }

  private static saturationNotice(query: string, kind: string, count: number): string {
    return (
      `"${query}" matched at least ${count} ${kind}s, which is all Asana's typeahead returns. ` +
      'A same-named one outside that window would not be seen - pass a gid to be certain.'
    );
  }

  /**
   * A write must not act on a name the lookup cannot pin down. A warning is
   * enough for a read - the wrong row on screen is a nuisance - but `done`,
   * `assign` or `update` would mutate the wrong task and print success, so a
   * saturated window is refused there instead.
   */
  private static refuseSaturated(query: string, kind: string, count: number): never {
    throw new Error(
      `${AsanaService.saturationNotice(query, kind, count)} Refusing to change a ${kind} chosen from an incomplete list.`,
    );
  }

  /** Workspaces are few, so this resolves from the full list rather than typeahead. */
  async resolveWorkspace(value: string): Promise<string> {
    if (isGid(value)) return value.trim();
    return matchByName(await this.listWorkspaces(), value, 'workspace').gid;
  }

  async resolveProject(workspace: string, value: string): Promise<string> {
    if (isGid(value)) return value.trim();
    const { candidates, saturated } = await this.typeaheadWindow(workspace, 'project', value);

    // Projects are few enough to enumerate, so an empty or saturated window is
    // answered exhaustively rather than guessed at or refused. Typeahead is
    // fuzzy and does sometimes miss an exact name.
    if (candidates.length === 0 || saturated) {
      return matchByName(await this.listProjects(workspace, { includeArchived: true }), value, 'project').gid;
    }
    return matchByName(candidates, value, 'project').gid;
  }

  /**
   * `forWrite` marks a resolution whose result will be mutated. There is no
   * exhaustive task listing to fall back on, so a saturated window is refused.
   */
  async resolveTask(workspace: string, value: string, options: { forWrite?: boolean } = {}): Promise<string> {
    if (isGid(value)) return value.trim();
    const { candidates, saturated } = await this.typeaheadWindow(workspace, 'task', value);
    if (saturated) {
      if (options.forWrite) AsanaService.refuseSaturated(value, 'task', TYPEAHEAD_COUNT);
      this.warn(AsanaService.saturationNotice(value, 'task', TYPEAHEAD_COUNT));
    }
    return matchByName(candidates, value, 'task').gid;
  }

  async resolveSection(project: string, value: string): Promise<string> {
    if (isGid(value)) return value.trim();
    return matchByName(await this.listSections(project), value, 'section').gid;
  }

  /**
   * Resolve an assignee. `me` and an email address are passed straight through -
   * Asana's update endpoint accepts both - so only a display name costs a lookup.
   */
  async resolveUser(workspace: string, value: string, options: { forWrite?: boolean } = {}): Promise<string> {
    const trimmed = value.trim();
    if (trimmed.toLowerCase() === 'me' || trimmed.includes('@') || isGid(trimmed)) return trimmed;
    const { candidates, saturated } = await this.typeaheadWindow(workspace, 'user', trimmed);
    if (saturated) {
      if (options.forWrite) AsanaService.refuseSaturated(trimmed, 'user', TYPEAHEAD_COUNT);
      this.warn(AsanaService.saturationNotice(trimmed, 'user', TYPEAHEAD_COUNT));
    }
    return matchByName(candidates, trimmed, 'user').gid;
  }

  /**
   * The workspace a command should act in: the explicit flag, the configured
   * default, or the only workspace the account has.
   */
  async resolveDefaultWorkspace(explicit?: string): Promise<string> {
    if (explicit) return this.resolveWorkspace(explicit);
    if (this.config.defaultWorkspace) return this.config.defaultWorkspace;

    const me = await this.whoAmI();
    const workspaces = me.workspaces || [];
    if (workspaces.length === 1) return workspaces[0].gid;
    if (workspaces.length === 0) throw new Error('This Asana account has no workspaces');
    throw new Error(
      `This account has several workspaces: ${workspaces.map((w) => `${w.gid}: ${w.name}`).join(', ')}. ` +
        'Pass --workspace, or set asana.defaultWorkspace in .claude-tools.json',
    );
  }
}

export default AsanaService;
