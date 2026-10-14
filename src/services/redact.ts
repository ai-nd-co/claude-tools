/**
 * Redact credentials out of anything we are about to print.
 *
 * Standing rule from the owner, 2026-09-28: *"no password rotation is needed. our conversations are
 * trusted. but anyway try to replace passwords in the output so you dont see them."* This is output
 * hygiene, not secrecy from him — the point is that a value never has to be un-seen.
 *
 * It lives at the point of OUTPUT rather than at the point of reading, because the leak is not in
 * holding a message, it is in rendering it into someone's context. A concrete case drove this: reading
 * the BotFather conversation prints *"Use this token to access the HTTP API: <token>"* verbatim, so the
 * ordinary act of looking at a chat emitted a live bot token with nothing asking for it.
 *
 * WHAT THIS DOES NOT COVER, stated here because the next person to read this file will otherwise
 * conclude that credential output is "handled": it protects only text that passes through OUR renderers.
 * A secret you read out of a file or a command's stdout — `cat`, `git show`, a grep of a compose file,
 * `dokku postgres:info` — reaches a transcript without touching any code in this repo, and no version of
 * this module can reach it. Two of the three real exposures on 2026-09-28 were that shape.
 *
 * The whole problem divides into three, and only the first is tooled:
 *   1. text through a renderer we own (Telegram) — handled here;
 *   2. a NAMED command that always emits a secret (`dokku config:show`, `dokku postgres:info`,
 *      `kubectl get secret -o yaml`, `printenv`) — preventable by refusing the command, not by
 *      redacting it, since there is no chokepoint to redact at;
 *   3. reading a file that happens to contain a credential — the command is innocent and the content
 *      is the secret, so this is neither, and probably never will be.
 *
 * A `PostToolUse` hook does NOT provide a fourth option, measured 2026-09-28 on 2.1.283: the hook fires
 * after the call, receives the full `tool_response` including the secret, and **cannot replace it**. A
 * scrubbed copy returned under `updatedOutput`, `toolResponse`, `tool_response` and the same three inside
 * `hookSpecificOutput` — valid JSON, exit 0 — changed nothing; the model still read the original value.
 * A hook can observe and append, which means a warning arrives after the credential has already been
 * delivered. It is also one more place the secret flows.
 *
 * Category 3 is discipline, permanently: prefer a form that never emits the value, pipe through a
 * redaction when there is no quiet form, and name where a value lives instead of quoting it. Saying
 * "we will tool our way out of this eventually" is its own false comfort.
 *
 * Deliberately NARROW. Each pattern matches a shape that is a credential and almost nothing else, because
 * an over-eager redactor that eats prose gets switched off, and a redactor that is switched off protects
 * nothing. Set `CLAUDE_TOOLS_RAW_SECRETS=1` when a value is genuinely the thing being worked on.
 */

/** The marker left behind. Distinctive so it is obvious in a transcript that redaction happened. */
export const REDACTED = '[redacted]';

interface Rule {
  readonly name: string;
  readonly pattern: RegExp;
  readonly replace: (...groups: string[]) => string;
}

const RULES: Rule[] = [
  {
    // Telegram bot token: `<bot id>:<35 chars>`. The id half is public — it is the bot's user id and
    // appears in callback data — so only the secret half is replaced, which keeps the output useful:
    // you can still tell WHICH bot a message is about.
    name: 'telegram-bot-token',
    pattern: /\b(\d{8,12}):([A-Za-z0-9_-]{30,})/g,
    replace: (_m: string, id: string) => `${id}:${REDACTED}`,
  },
  {
    // A password inside a connection string, which is how `dokku postgres:info` leaks one.
    // Keeps the scheme, the user and the host: everything needed to say where the value lives.
    name: 'dsn-password',
    pattern: /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^:@\s/]+:)([^@\s/]+)(@)/g,
    replace: (_m: string, prefix: string, _secret: string, at: string) => `${prefix}${REDACTED}${at}`,
  },
  {
    // `PASSWORD=`, `SECRET=`, `TOKEN=`, `API_KEY=` and friends, as they appear in env dumps and
    // `docker run` lines. Requires 8+ non-space characters so `TOKEN=` or `PASSWORD=x` in prose about
    // a variable is left alone.
    name: 'assigned-secret',
    pattern: /\b([A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|CREDENTIALS?)[A-Z0-9_]*)(\s*[=:]\s*)("?)([^\s"']{8,})\3/gi,
    replace: (_m: string, key: string, sep: string, quote: string) => `${key}${sep}${quote}${REDACTED}${quote}`,
  },
  {
    // A bare `Authorization: Bearer <jwt-ish>` header value.
    name: 'bearer',
    pattern: /\b(Bearer\s+)([A-Za-z0-9._~+/-]{16,}=*)/g,
    replace: (_m: string, prefix: string) => `${prefix}${REDACTED}`,
  },
];

/** True when the caller has explicitly asked for unredacted output. */
export function rawSecretsRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env['CLAUDE_TOOLS_RAW_SECRETS'];
  return raw === '1' || raw === 'true';
}

/**
 * Replace credential-shaped substrings. Returns the input unchanged when nothing matches, so this is
 * safe to wrap around every rendered line.
 */
export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  if (text.length === 0 || rawSecretsRequested(env)) return text;
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.pattern, rule.replace as (...args: unknown[]) => string);
  }
  return out;
}

/** Which rules a string would trip, for a test or a `--why` style explanation. Never returns the values. */
export function secretsFound(text: string): string[] {
  return RULES.filter((rule) => new RegExp(rule.pattern.source, rule.pattern.flags).test(text)).map((rule) => rule.name);
}
