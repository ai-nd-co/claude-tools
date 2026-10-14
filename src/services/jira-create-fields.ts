/**
 * Apply `--status` and `--assignee` to an issue that was just created, and prove they took (PROJ-4329).
 *
 * `jira create` used to print "Created:" whatever happened to those two fields. On 2026-09-30 a ticket landed
 * Icebox and unassigned while the command reported success: the status transition got a 404, only as a
 * warning, and the assignment was silently gone by the time the ticket was read back. An Icebox, unassigned
 * ticket is invisible on the board, so a real finding can sit unseen.
 *
 * Both failures sit in the seconds after the create. A brand-new issue can answer 404 before it is readable
 * everywhere, and something on Jira's side (an on-create rule) can reset an assignee made immediately after.
 * So this waits until the issue is readable, retries a transition that 404s, assigns, then READS THE ISSUE
 * BACK and re-applies anything that did not stick, once. Whatever still is not applied is reported by field,
 * and the command exits non-zero.
 */

export interface CreateFieldOps {
  getIssue(key: string): Promise<{ status: string; assignee?: string; assigneeAccountId?: string }>;
  /** Returns the status the transition leads to. */
  updateStatus(key: string, status: string): Promise<string>;
  assignIssue(key: string, assignee: string): Promise<{ accountId: string; displayName: string }>;
}

export interface CreateFieldsResult {
  applied: Array<'status' | 'assignee'>;
  failed: Array<{ field: 'status' | 'assignee'; reason: string }>;
  /** What the issue said on the last read. */
  final?: { status: string; assignee?: string };
}

export interface ApplyOptions {
  sleep?: (ms: number) => Promise<void>;
  /** Attempts for a step that may 404 while a new issue settles. */
  attempts?: number;
  /** How long to let the issue settle before reading it back. */
  settleMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A 404 right after a create means "not there yet"; anything else is an answer. Judged on the HTTP status when
 * the error carries one, and otherwise only on the client's exact wording, so a message that merely contains
 * "404" (say, a transition named 404) is not retried.
 */
function notYet(error: unknown): boolean {
  const status = (error as { response?: { status?: unknown } } | null)?.response?.status;
  if (typeof status === 'number') return status === 404;
  return /status code 404\b/.test(error instanceof Error ? error.message : String(error));
}

async function retrying<T>(step: () => Promise<T>, attempts: number, sleep: (ms: number) => Promise<void>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await step();
    } catch (error) {
      if (!notYet(error) || attempt >= attempts) throw error;
      await sleep(500 * 2 ** (attempt - 1));
    }
  }
}

export async function applyCreateFields(
  ops: CreateFieldOps,
  key: string,
  want: { status?: string; assignee?: string },
  options: ApplyOptions = {},
): Promise<CreateFieldsResult> {
  const sleep = options.sleep ?? defaultSleep;
  // A finite, positive whole number, or the retry bound means nothing.
  const attempts = Number.isInteger(options.attempts) && (options.attempts as number) > 0 ? (options.attempts as number) : 5;
  const settleMs = options.settleMs ?? 2_000;
  const result: CreateFieldsResult = { applied: [], failed: [] };
  if (want.status === undefined && want.assignee === undefined) return result;

  // Readable first: every later step 404s on an issue that is not there yet.
  try {
    await retrying(() => ops.getIssue(key), attempts, sleep);
  } catch (error) {
    const reason = `the new issue could not be read back (${(error as Error).message})`;
    if (want.status !== undefined) result.failed.push({ field: 'status', reason });
    if (want.assignee !== undefined) result.failed.push({ field: 'assignee', reason });
    return result;
  }

  let statusError: string | undefined;
  let reachedStatus: string | undefined;
  let assignedTo: { accountId: string; displayName: string } | undefined;
  let assignError: string | undefined;

  const transition = async (): Promise<void> => {
    try {
      reachedStatus = await retrying(() => ops.updateStatus(key, want.status!), attempts, sleep);
      statusError = undefined;
    } catch (error) {
      statusError = (error as Error).message;
    }
  };
  const assign = async (): Promise<void> => {
    try {
      assignedTo = await retrying(() => ops.assignIssue(key, want.assignee!), attempts, sleep);
      assignError = undefined;
    } catch (error) {
      assignError = (error as Error).message;
    }
  };

  if (want.status !== undefined) await transition();
  if (want.assignee !== undefined) await assign();

  // Verified against the status the transition LEADS TO, which is what the issue should now say.
  const statusOk = (read: { status: string }) =>
    read.status.toLowerCase() === (reachedStatus ?? want.status!).toLowerCase();
  const assigneeOk = (read: { assigneeAccountId?: string }) =>
    assignedTo !== undefined && Boolean(assignedTo.accountId) && read.assigneeAccountId === assignedTo.accountId;

  // The read-backs retry like every other step, and a read that still fails leaves the fields UNVERIFIED rather
  // than escaping and losing the per-field report (Codex review).
  const readBack = async () => {
    try {
      return await retrying(() => ops.getIssue(key), attempts, sleep);
    } catch (error) {
      return new Error((error as Error).message);
    }
  };
  const unverified = (error: Error): CreateFieldsResult => {
    const reason = `could not be verified: the issue could not be read back (${error.message})`;
    if (want.status !== undefined) result.failed.push({ field: 'status', reason: statusError ?? reason });
    if (want.assignee !== undefined) result.failed.push({ field: 'assignee', reason: assignError ?? reason });
    return result;
  };

  // Read back after a pause, and re-apply once whatever did not stick: an on-create rule can undo an
  // assignment made in the first seconds, and the second attempt lands after it.
  await sleep(settleMs);
  let read = await readBack();
  if (read instanceof Error) return unverified(read);
  const retryStatus = want.status !== undefined && statusError === undefined && !statusOk(read);
  const retryAssignee = want.assignee !== undefined && assignError === undefined && !assigneeOk(read);
  if (retryStatus || retryAssignee) {
    if (retryStatus) await transition();
    if (retryAssignee) await assign();
    await sleep(settleMs);
    read = await readBack();
    if (read instanceof Error) return unverified(read);
  }
  result.final = { status: read.status, ...(read.assignee === undefined ? {} : { assignee: read.assignee }) };

  if (want.status !== undefined) {
    if (statusOk(read)) result.applied.push('status');
    else result.failed.push({ field: 'status', reason: statusError ?? `the issue is "${read.status}" after the transition` });
  }
  if (want.assignee !== undefined) {
    if (assigneeOk(read)) result.applied.push('assignee');
    else result.failed.push({
      field: 'assignee',
      reason: assignError ?? `the issue is assigned to ${read.assignee ?? 'nobody'} after assigning ${assignedTo?.displayName ?? want.assignee}`,
    });
  }
  return result;
}
