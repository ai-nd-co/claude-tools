/**
 * Permission relay for `channel serve --permissions`.
 *
 * ## Why this exists
 *
 * A gated tool call stops the session dead until somebody is physically at that terminal pane. That
 * has already cost this workspace real time: an agent holding a production apply, and a token
 * extension, both waiting on the owner to walk to a specific window. A channel that declares
 * `claude/channel/permission` is offered the request instead, and the verdict it sends back is
 * applied exactly as if the dialog had been answered locally.
 *
 * The local dialog stays live and **whichever answer arrives first wins** — the client resolves a
 * pending entry once and drops anything that follows.
 *
 * ## Where these wire shapes come from — read, not inferred
 *
 * Two sources, cross-checked against each other:
 *
 * 1. The official Telegram plugin, `external_plugins/telegram/server.ts`, which already implements
 *    this correctly: the capability (`server.ts:396-405`), the inbound handler (`:427-452`), the
 *    outbound verdict (`:779-782`, `:936-942`) and the reply regex (`:93`).
 * 2. Claude Code 2.1.283 itself, whose bundled `chunk-bh4fcz2t.js` carries the zod schemas the client
 *    validates against, and `chunk-a3a624zv.js` the id generator and the capability filter. That is
 *    the authority; the plugin agrees with it in every particular.
 *
 * From the client's own schema:
 *
 * ```js
 * ChannelPermissionNotificationSchema = { method: "notifications/claude/channel/permission",
 *                                         params: { request_id: string, behavior: "allow"|"deny" } }
 * CHANNEL_PERMISSION_REQUEST_METHOD   = "notifications/claude/channel/permission_request"
 * ```
 *
 * and the request it sends is `{ request_id, tool_name, description, input_preview }` — four strings,
 * with credentials masked and long values elided **by the client** before we ever see them.
 *
 * ## What declaring the capability asserts
 *
 * That the server authenticates whoever answers. We cannot: the server relays to whatever command
 * it was given. So the flag is opt-in, the trust boundary is the wrapped command, and the one thing
 * this module can enforce it does enforce — a verdict is only forwarded for a `request_id` the server
 * actually issued. Claude Code drops unknown ids too, but a wrapper that forwards arbitrary verdicts
 * is an approval-forgery hole regardless of who else catches it.
 */
import { z } from 'zod';

/**
 * The capability that opts a channel into permission relay.
 *
 * Three gates, all of which must pass, and only the first is ours: the server declares **both** this
 * and `claude/channel` (`chunk-a3a624zv.js`: the connected-client filter tests each with
 * `experimental?.[name]`); the session registered that server as a channel, via `--channels` or
 * `--dangerously-load-development-channels`, which is how a permission request reaches us at all; and
 * the connection did not negotiate the modern protocol revision. So declaring this capability opts us
 * in — it does not by itself let anything through.
 */
export const PERMISSION_CAPABILITY = 'claude/channel/permission';

/** Inbound: the client is asking for a verdict on a gated tool call. */
export const PERMISSION_REQUEST_METHOD = 'notifications/claude/channel/permission_request';

/** Outbound: our answer. */
export const PERMISSION_METHOD = 'notifications/claude/channel/permission';

/** The fd the wrapped command answers on. Dedicated, so a log line can never read as an approval. */
export const VERDICT_FD = 3;

/** Named in the child's environment so a wrapped command can tell whether it may answer at all. */
export const VERDICT_FD_ENV = 'CLAUDE_CHANNEL_PERMISSION_FD';

/**
 * How many unanswered requests we remember.
 *
 * Most requests are never answered here — the owner answers the local dialog and the client silently
 * resolves its own pending entry, telling us nothing. So the set only ever grows, and it needs a
 * bound. Oldest-first, because a request nobody answered in the last sixty-odd is not about to be.
 */
export const MAX_OUTSTANDING = 64;

/**
 * The notification the client sends us, in the shape the client itself validates.
 *
 * `z.object` drops unknown keys, so a field added to the client's params in a later release is
 * ignored rather than fatal — which matters for a research-preview contract.
 */
export const PermissionRequestNotification = z.object({
  method: z.literal(PERMISSION_REQUEST_METHOD),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
});

export type PermissionRequest = z.infer<typeof PermissionRequestNotification>['params'];

export type Behavior = 'allow' | 'deny';

export interface PermissionVerdict {
  readonly request_id: string;
  readonly behavior: Behavior;
}

/**
 * A request id is exactly five letters from `a-z` **minus `l`**.
 *
 * Not a guess: the client builds it from a 25-letter alphabet, `"abcdefghijkmnopqrstuvwxyz"`, five
 * characters of an FNV-1a hash of the tool-use id (`chunk-a3a624zv.js`). `l` is out because it is
 * indistinguishable from `1` and `I` in most fonts, and someone is going to read this id off a phone
 * screen and type it back.
 */
export const REQUEST_ID = /^[a-km-z]{5}$/;

/**
 * The human reply form, copied verbatim from the Telegram plugin (`server.ts:93`), which took it from
 * `claude-cli-internal`'s `channelPermissions.ts`.
 *
 * Deliberately strict, and the strictness is the point: no bare `yes` (conversational — someone
 * agreeing with a sentence is not approving a tool call), and no chatter before or after it.
 * Case-insensitive because phone keyboards capitalise the first letter without being asked.
 */
export const PERMISSION_REPLY = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;

/**
 * Read one line from the wrapped command as a verdict, or decide it is not one.
 *
 * Two accepted forms, and no third:
 *
 * - **JSON** — `{"request_id":"abcde","behavior":"allow"}`, which is exactly the `params` object we
 *   put on the wire. A forwarder that speaks JSON writes the thing it wants sent.
 * - **`y|yes|n|no <id>`** — the plugin's form, so a verdict typed by a human anywhere in the chain
 *   arrives here unchanged.
 *
 * The JSON form carries the id opaquely, so it keeps working if the client's id shape ever changes;
 * the text form cannot, because its regex has the current shape baked in.
 */
export function parseVerdictLine(line: string): PermissionVerdict | undefined {
  const text = line.trim();
  if (text === '') return undefined;

  if (text.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return undefined;
    }
    const { request_id, behavior } = (parsed ?? {}) as { request_id?: unknown; behavior?: unknown };
    if (typeof request_id !== 'string') return undefined;
    if (behavior !== 'allow' && behavior !== 'deny') return undefined;
    const id = request_id.trim().toLowerCase();
    return id === '' ? undefined : { request_id: id, behavior };
  }

  const match = PERMISSION_REPLY.exec(text);
  if (!match) return undefined;
  return {
    request_id: match[2]!.toLowerCase(),
    // `y` and `yes` are the only two spellings the regex admits on the allow side, so the first
    // letter decides it — same test the plugin makes.
    behavior: match[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny',
  };
}

/** A verdict we will forward, or the reason we will not. */
export type VerdictOutcome = { readonly verdict: PermissionVerdict } | { readonly dropped: string };

export interface PermissionRelay {
  /** Record a request as ours, and render the single line the wrapped command reads on stdin. */
  issue(params: PermissionRequest): string;
  /** Validate one line from the wrapped command against the requests we actually issued. */
  accept(line: string): VerdictOutcome;
  /** How many issued requests are still answerable. */
  readonly outstanding: number;
}

/**
 * The gate.
 *
 * Nothing here talks to a process or a transport, which is the whole reason it is its own function:
 * the rule that matters — *only an id we issued* — is then testable without spawning anything.
 */
export function createPermissionRelay(max: number = MAX_OUTSTANDING): PermissionRelay {
  // Insertion-ordered by specification, so `values().next()` is the oldest entry and the bound below
  // needs no separate bookkeeping.
  const issued = new Set<string>();

  return {
    issue(params: PermissionRequest): string {
      // Matched case-insensitively throughout, because a verdict may have made a round trip through a
      // phone keyboard. The client generates lowercase and lowercases again before resolving.
      issued.add(params.request_id.toLowerCase());
      while (issued.size > max) {
        const oldest = issued.values().next().value;
        if (oldest === undefined) break;
        issued.delete(oldest);
      }
      // The line IS the notification, minus JSON-RPC framing — self-describing, and it invents no
      // field of its own. `params` goes through verbatim: relaying it faithfully matters more than
      // normalising it, and only our own matching needs a canonical form.
      return JSON.stringify({ method: PERMISSION_REQUEST_METHOD, params });
    },

    accept(line: string): VerdictOutcome {
      const verdict = parseVerdictLine(line);
      if (!verdict) return { dropped: 'not a verdict' };
      // `delete` is the check and the consumption in one step, so the same request cannot be answered
      // twice — a second verdict finds nothing to remove.
      if (!issued.delete(verdict.request_id)) {
        return { dropped: `request_id "${verdict.request_id}" was never issued (stale, or forged)` };
      }
      return { verdict };
    },

    get outstanding(): number {
      return issued.size;
    },
  };
}
