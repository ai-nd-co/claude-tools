# Claude Tools

Multi-purpose CLI for Claude Code workflows - spawn sessions, Telegram messaging, Jira and Asana integration.

**Before installing, read [SECURITY.md](SECURITY.md)**: it lists what this tool does to
your machine, including a dependency patched at install time, a localhost bridge the browser
extension trusts, and subcommands that launch Claude Code with permission checks disabled.
Third-party licence notices are in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Installation

```bash
npm install -g @davronsherbaev/claude-tools   # published package
```

From a checkout:

```bash
npm install
npm run build
```

## Usage

```bash
# Show all commands
claude-tools --help

# Fork current Claude session with Codex-first summarization
claude-tools fork <marker>
claude-tools fork <marker> --summary-provider claude --summary-model sonnet

# Spawn Claude session with custom window title
claude-tools spawn --name "Code Review"
claude-tools spawn prompt.txt --name "My Task"

# Telegram commands
claude-tools telegram chats              # List your chats
claude-tools telegram read               # Read saved messages
claude-tools telegram read @username     # Read from user
claude-tools telegram send @user "Hi"    # Send message
claude-tools telegram search "keyword"   # Search messages

# Codex commands
claude-tools codex list                  # List Codex session files
claude-tools codex compact <session>     # Enhanced compaction (keep last 50% intact)

# Jira commands
claude-tools jira list                   # List issues
claude-tools jira list PROJ               # List project issues
claude-tools jira create "Bug title"     # Create issue
claude-tools jira status PROJ-123 "Done"  # Update status
claude-tools jira comment PROJ-123 "msg"  # Add comment
claude-tools jira search "assignee = me" # JQL search

# Asana commands
claude-tools asana list                  # My incomplete tasks
claude-tools asana show <gid|name>       # Task details (--comments for the feed)
claude-tools asana create "Task title" --project Personal
claude-tools asana done <gid|name>       # Completion is a boolean, not a transition
claude-tools asana move <gid> --section "In progress"
claude-tools asana search "mobile release"

# Agent hub commands (inter-agent messaging)
claude-tools hub watch --agent manager   # long-poll; arming it IS the registration
claude-tools hub send worker -           # message another agent (body on stdin)
claude-tools hub status --set "on ISSUE-20" # publish one status line
claude-tools hub rename manager          # rename on the hub and in tmux, in one command
claude-tools hub roster                  # who exists, their state and last seen
claude-tools hub log --agent worker      # retained history

# Browser commands (requires extension)
claude-tools browser list-tabs
claude-tools browser attach 123
claude-tools browser eval 123 "document.title"
claude-tools browser html 123
claude-tools browser logs 123 --duration 10000
claude-tools browser network 123 --duration 10000
claude-tools browser response-body 123 REQUEST_ID
```

Summarization defaults to the local Codex ChatGPT backend and falls back to Claude automatically unless you explicitly force a provider. Forked sessions still resume in Claude.

## Configuration

### Secrets (never commit)

Location: `~/.config/claude-tools/secrets.json` (Linux/Mac) or `%APPDATA%\claude-tools\secrets.json` (Windows)

```json
{
  "telegram": {
    "apiId": 12345678,
    "apiHash": "your_api_hash",
    "sessionString": "your_session_string"
  },
  "jira": {
    "email": "you@company.com",
    "apiToken": "your_jira_api_token"
  },
  "speech": {
    "apiKey": "the office speech cluster's key",
    "baseUrl": "https://speech.example.com/v1",
    "model": "Systran/faster-whisper-large-v3"
  },
  "groq": {
    "apiKey": "gsk_..."
  },
  "asana": {
    "accessToken": "your_asana_personal_access_token"
  },
  "telegramBots": [
    { "name": "assistant", "token": "123456789:AA...", "default": true },
    { "name": "personal", "token": "987654321:AA..." }
  ],
  "hub": {
    "url": "https://hub.example.com",
    "agent": "manager"
  }
}
```

The `hub` block is the one entry here that holds **no credential**: the agent hub authenticates this
machine with a fingerprint derived at run time from `~/.config/ai-hub/machine.key`, which is never
written into this file and never sent anywhere but the `X-Hub-Fingerprint` header.

### Project Config (can commit)

Location: `.claude-tools.json` in project root

```json
{
  "jira": {
    "host": "yourcompany.atlassian.net",
    "defaultProject": "PROJ"
  },
  "telegram": {
    "defaultChat": "me"
  },
  "asana": {
    "defaultWorkspace": "1218000000000033",
    "defaultProject": "1218000000000035"
  },
  "jiraMonitor": {
    "notifyChat": "Team Dev Chat",
    "pmChat": "me",
    "userMapping": { "Full Name": "@telegram_handle" },
    "activeUsers": ["Full Name"],
    "boardId": 1,
    "pipelineStatuses": ["Planned"],
    "excludeBacklog": true,
    "staleness": {
      "inProgress": { "ageing": 7, "stale": 14 },
      "planned": { "ageing": 30, "stale": 90 }
    },
    "notify": {
      "stuck": ["group"],
      "inactive": ["group"],
      "lowPipeline": ["pm"]
    },
    "escalationTiers": [7, 14, 30, 60, 90]
  }
}
```

#### `jiraMonitor` — optional workflow overrides

The `jira monitor` command paginates every JIRA search using `nextPageToken`
(no silent truncation). Low-pipeline counts are board-aware: by default they
count only assigned `Planned` issues and exclude issues in the Agile backlog.
If your workflow renames statuses, override only the values you need.

```json
{
  "jiraMonitor": {
    "boardId": 1,
    "pipelineStatuses": ["Planned"],
    "excludeBacklog": true,
    "staleness": {
      "inProgress": { "ageing": 7, "stale": 14 },
      "planned": { "ageing": 30, "stale": 90 }
    },
    "statuses": {
      "inProgress": "In Progress",
      "planned": "Planned",
      "icebox": "Icebox",
      "done": "Done",
      "openWorkExclude": ["Done", "Test"]
    },
    "browseBaseUrl": "https://yourcompany.atlassian.net/browse"
  }
}
```

- `boardId` — optional. When omitted, the monitor discovers the project's only
  Agile board. Discovery fails with all candidate names if more than one board
  matches; it never silently picks one.
- `pipelineStatuses` — statuses counted as queued work; defaults to
  `["Planned"]`. `Icebox` is deliberately not counted by default.
- `excludeBacklog` — defaults to `true`; removes Agile backlog issues from
  pipeline counts. `activeUsers` selects who appears in the low-pipeline report,
  not which issues are counted.
- `staleness` — inclusive day thresholds measured from each ticket's `updated`
  timestamp. Defaults are In Progress ageing at 7 days / stale at 14, and
  Planned ageing at 30 days / stale at 90.
- `statuses.openWorkExclude` — statuses excluded from the "open work" query
  that drives the inactive-users check.
- `browseBaseUrl` — optional. Defaults to `https://<jira.host>/browse`, so you
  usually do not need to set this at all.
- Status values are interpolated into JQL and are validated: any value
  containing `"`, `\`, or a newline is rejected at load time.

`jira monitor --staleness` is an opt-in, read-only report of ageing and stale
on-board In Progress and configured pipeline tickets. It is not included in a
no-flag monitor run and cannot be combined with `--notify`.

#### `jira monitor` state and notification routing

Dedupe is opt-in. Pass `--state <path>` to notify only for new items or
escalations; pass `--state` without a path to use
`%APPDATA%\claude-tools\jira-monitor\state.json` on Windows. Omitting the flag
keeps the historical stateless behaviour. `--reset-state` safely deletes the
selected/default state before the run.

```powershell
# Inspect classifications without sending or changing state
claude-tools jira monitor --state C:\monitor-data\jira-state.json

# Scheduled/interactive notification run (records only confirmed deliveries)
claude-tools jira monitor --notify --state C:\monitor-data\jira-state.json
```

Ordinary dry runs never write state; `--reset-state` is the explicit deletion
operation. A missing, deleted, or corrupt state file is treated as empty, so all
current items are shown as `NEW`. Stuck and inactive alerts
repeat only after entering a higher `escalationTiers` day tier. Low-pipeline
alerts repeat only if that person's pipeline total decreases. Resolved items
are pruned without sending a resolution message.

Each `jiraMonitor.notify` array accepts `group`, `pm`, `dm`, or `off`; `[]` also
mutes a class. Defaults preserve the original routing: stuck and inactive go to
`notifyChat`, while low-pipeline goes to `pmChat` (falling back to
`notifyChat`). DMs are disabled by default. When enabled, each person receives
only their own items using `userMapping`; missing mappings are reported as
skipped. Unassigned stuck items always fall back to the group.

The Windows scheduling wrapper is
`C:\projects\workspace\scripts\jira-monitor.ps1`. It invokes the built CLI with
an explicit config-directory state path and appends output to
`C:\projects\workspace\data\jira-monitor\monitor.log`. The wrapper only defines
the job command; it does not register a Scheduled Task.

### Environment Variables

Override config with environment variables:

```bash
# Telegram
TELEGRAM_API_ID=12345678
TELEGRAM_API_HASH=abc123...
TELEGRAM_SESSION_STRING=...

# Jira
JIRA_HOST=yourcompany.atlassian.net
JIRA_EMAIL=you@company.com
JIRA_API_TOKEN=...

# Remote Telegram bot (separate identity from the user account above)
TELEGRAM_BOT=personal                  # pin one configured bot for this session
TELEGRAM_BOT_TOKEN=123456789:AA...     # or a single unnamed bot, named "default"

# Asana (one token is the whole credential - no host, no email)
ASANA_ACCESS_TOKEN=...                 # ASANA_TOKEN and ASANA_PAT also accepted
ASANA_DEFAULT_WORKSPACE=1200...        # optional; discovered when the account has one workspace
ASANA_DEFAULT_PROJECT=1218...          # optional; used by `asana create`

# Agent hub (inter-agent messaging). Neither of these is a secret: the credential is a
# machine fingerprint derived at run time from ~/.config/ai-hub/machine.key and never configured.
AGENT_HUB_URL=https://hub.example.com   # optional; the /api form is accepted too
AGENT_HUB_AGENT=manager                         # this session's name on the hub

# Speech-to-text: the office speech cluster first, Groq as the fallback
SPEECH_API_KEY=...                                        # the cluster's one key
SPEECH_BASE_URL=https://speech.example.com/v1    # optional, this is the default
SPEECH_STT_MODEL=Systran/faster-whisper-large-v3         # optional, this is the default
GROQ_API_KEY=gsk_...
GROQ_STT_MODEL=whisper-large-v3        # optional
CLAUDE_TOOLS_STT_CACHE_DIR=/tmp/stt    # optional, defaults to the OS temp dir
```

## Telegram Setup

1. Get API credentials from https://my.telegram.org/apps
2. Run the session generator:
   ```bash
   claude-tools telegram auth
   ```
3. Follow the prompts to authenticate
4. Session is saved to secrets.json

## Jira Setup

1. Get API token from https://id.atlassian.com/manage-profile/security/api-tokens
2. Add to secrets.json or set environment variables

## Asana Setup

1. Create a Personal Access Token at https://app.asana.com/0/my-apps
2. Add it to secrets.json as `asana.accessToken`, or set `ASANA_ACCESS_TOKEN`
3. Check it with `claude-tools asana whoami`, which also prints the workspace gids

A PAT carries the full access of the account that created it - every workspace it
can see, read and write - and Asana does not scope or expire them, so treat it
like the other tokens in that file. `asana.defaultWorkspace` is optional: with a
single-workspace account every command discovers it.

## Commands

### Spawn Commands

| Command | Description |
|---------|-------------|
| `spawn [file]` | Spawn Claude session |
| `list` | List all tasks |
| `cleanup` | Remove task records |

Options: `--name` (window title), `--dir` (working directory)

### Telegram Commands

| Command | Description |
|---------|-------------|
| `telegram auth` | Generate session |
| `telegram chats` | List your chats |
| `telegram read [chat]` | Read messages |
| `telegram send <chat> <msg>` | Send message (rich markdown by default; `--md2` for the old path) |
| `telegram search <query>` | Search messages |
| `telegram watch <chats...>` | Print one line per new/edited message, forever (for the Claude Code Monitor tool) |

Chat can be: `me`, `@username`, chat ID, or chat title

**Rich messages and dates.** `send`, `reply` and `edit` send rich markdown by default: Telegram's servers render `**bold**`, `- ` bullets, `[named links](url)`, real tables, headings, `- [ ]` task lists, `<details>` blocks and footnotes (up to 32768 characters). `--rich` is still accepted and changes nothing; `--md2` sends the old MarkdownV2 way (no tables or headings, 4096 characters). Any message can carry `{{time:2026-09-26 18:00}}` (bare times are Tashkent; `{{time:<when>|<format>|<label>}}` with format `r` or `w?[dD]?[tT]?`), which each reader sees in their own time zone.

**Format check.** `telegram send/reply/edit` and `bot send/reply/edit` check the body before anything is sent, so the writing rules reach a session even after compaction has dropped them from its skill. Lengths are visible characters: link labels count, URLs and markup do not. A send is **refused** (exit status 3, nothing sent) when:

- it is over 800 visible characters, one phone screen (code, tables and quotes count; a collapsed `<details>` counts only its summary). Split it into at most 3 messages by meaning, or send a short message plus an attached `.md` file;
- it contains a bare PR or ticket reference, `PR 471`, `#471` or `PROJ-4393`, outside a link label or code. A ticket key is letters then 2+ digits, so `GPT-5` or `AES-256` is not one; hashtags like `#claude` never match;

and, for a body over 250 visible characters, when:

- the first line is not a bold title (`**…**` or a `#` heading), or the title is over 80 characters;
- a prose paragraph does not open with a bold title. Exempt: bullet lists, a short `…:` lead-in line right before a list, a paragraph under a heading or a title-only line, a closing line of only hashtags or mentions, and a last one-line paragraph of 60 characters or less ("Reply A or B.");
- a prose paragraph is over 300 characters or has more than 3 sentences (the opening bold title is not counted; abbreviations such as `т.е.`, `и т.д.`, `e.g.`, initials, versions, file names and ellipses do not split a sentence);
- a bullet is over 200 characters;
- numbered points run inline in one paragraph, `(1) … (2) …` or `1) … 2) …`.

Fenced code, tables, blockquotes and `<details>` are exempt from the shape rules. It **warns** on stderr and still sends for: a paragraph of 3 sentences, more than one question mark outside numbered questions (`**1. …?**`), a bare commit hash, two or more lines starting with ✅/🔴, and `P0`–`P3` or `rule-7` shorthand. The refusal names each failure with the actual and allowed numbers and an excerpt, then prints the rules and a corrected example. `--format-ok "<reason>"` sends anyway and prints the reason on the success line; an empty reason is an error. Literal sends are machine notices and are not checked at all: `bot send/reply/edit --plain` and the account's `--md2` (a mail feed's one-line notice may carry `PROJ-4393` in a subject, and a refusal would make it retry forever). `bot --html` is checked. `hub send` is not checked. Every threshold is a named constant at the top of `src/services/message-format.ts`.

Both need MTProto layer 229, newer than GramJS 2.26 ships. `src/services/telegram-schema.ts` swaps in a schema vendored from TDLib before GramJS builds its classes; refresh it with `node scripts/update-telegram-schema.mjs [tdlib-commit]`.

Voice and audio messages up to 1 minute are transcribed automatically when a speech backend is configured (the cluster or Groq, see `transcribe`), and appear as a quoted line under the media indicator. Transcripts are cached per (chat, message, model) in the OS temp directory, so re-reading a chat costs nothing. Use `--transcribe-max <seconds>` for longer clips, `--transcribe-limit <n>` to change the per-read cap (default 3), or `--no-transcribe` to switch it off. The `--use-cache` read path does not transcribe.

### Transcribe Commands

| Command | Description |
|---------|-------------|
| `transcribe <audio-file>` | Transcribe a local audio file |
| `transcribe --tg <msgId> --chat <chat>` | Download and transcribe a Telegram voice/audio message |

Two OpenAI-compatible backends are known: the **office speech cluster** (`speech.apiKey`; Whisper large-v3 on our own GPU, nothing billed, audio stays in the office) and **Groq** (`groq.apiKey`). When both are configured the cluster is tried first and Groq takes the same clip if the cluster is unreachable, times out or answers 5xx — the command says so on stderr and the `via:` line names the backend that answered. A rejected key (401/403) is never papered over by a fallback. Auto-detection occasionally picks the wrong language and then transcribes fluently into it, which is worse than failing because nothing marks it as wrong: measured over 29 voice notes, one 9-second English clip came back as confident Turkish. Setting `speech.fallbackLanguage` / `groq.fallbackLanguage` (or `STT_FALLBACK_LANGUAGE` for both) to an ISO-639-1 code turns on a **confidence-gated retry** — when the model's own mean segment confidence falls below -0.4, the clip is sent once more with that language named and the better-scoring answer is kept. The threshold is bounded by measurement from both sides: correctly detected clips scored -0.027 to -0.231, the mis-detected one -0.836, and naming the right language moved it to -0.075. Only the clips that need it pay, about one in thirty. The confidence is stored with every cached transcript, so turning the retry on later re-transcribes the clips it would have changed and leaves the rest as cache hits — the cache key itself is untouched, because keying on the policy would invalidate every entry and re-bill the lot. Unset, nothing changes — detection is left alone, which matters in a chat that also carries Russian and Uzbek.

Both backends accept an **expected vocabulary** — `speech.prompt` or `groq.prompt` in the secrets file, or `STT_PROMPT` in the environment, which covers both. Whisper takes it as decoding context, so a name in there is recognised where it would otherwise be guessed at phonetically: measured on real voice notes, `Codex` arrives as "codec" and `markdown` as "smart down" without it, and correctly with it, at no measurable cost in time. Nothing is configured by default, because a shared tool should not carry one installation's product names. Keep it to a few dozen words and **put the important terms last**: a 442-word prompt lost a term placed at the start and kept the same term placed at the end, so the model keeps the tail. A per-call `--prompt` overrides the configured one.

Every request is bounded: thirty seconds for a voice note, or a quarter of the clip's length for a longer recording — that is, the backend must keep up at four times real time, against a cluster measured at about twenty. The clip's length comes from the caller when it knows it (Telegram reports one for every voice note) and from ffprobe otherwise; with neither, the file's size stands in and that guess is capped at ten minutes. On top of it sits time for the upload itself, reckoned pessimistically at 1 Mbit/s, because the deadline covers the body going out and a clip's length says nothing about how long that takes. That bound is what reaches the fallback when a backend accepts the connection and then goes quiet — including on Groq, which is last in the chain and so has nothing behind it. `--provider cluster` or `--provider groq` uses that one alone; `--provider wispr` uses a local Wispr Flow session instead (Windows only). Both backends accept ogg/opus, mp3, m4a, wav, webm and flac directly; Groq up to 25MB, the cluster up to 100MB.

`transcribe` shares one transcript cache with `telegram read` and `telegram watch`, so the same audio is never transcribed twice through the account client: a Telegram clip is keyed on (chat, message, model) and a local file on its contents, and a cached `--tg` does not even download. (`bot watch` uses the same store but keys on the Bot API file id, so a clip seen through both clients is transcribed once per client.) Each backend names its model differently, so a clip has one cache entry per backend: a hit under either is served, and a miss is filed under the backend that actually answered. `--timestamps` always calls a backend, since per-segment timings are not cached. A transcript that cannot be cached produces a warning, because the next run would otherwise pay again.

| Option | Description |
|--------|-------------|
| `--provider <name>` | `cluster`, `groq` or `wispr` (default: cluster, then Groq, whichever is configured) |
| `--model <model>` | ASR model id for the first backend (defaults: `Systran/faster-whisper-large-v3` on the cluster, `whisper-large-v3` on Groq); the ids differ per backend, so this switches the fallback off |
| `--language <lang>` | Language hint; omit to auto-detect |
| `--prompt <text>` | Bias decoding towards names and jargon |
| `--translate` | Translate to English instead of verbatim |
| `--timestamps` | Include per-segment timings |
| `--no-cache` | Ignore any cached transcript and transcribe again |
| `--json` / `--quiet` | Raw JSON, or text only |

`telegram watch` polls every `--interval` seconds (default 30), taking the session lock only for each poll, so other commands keep working. After a change it polls every 5s and prints the whole burst once the chat has been quiet for `--quiet` seconds (default 15), so a burst of messages arrives as one Monitor notification. The last reported message ID is saved per chat under `<config dir>/telegram-watch/<state>/`, so a restarted watcher reports what arrived while it was down. Voice and audio messages up to 1 minute are transcribed and the text is appended to the event line in quotes (at most 3 new clips per burst; `--no-transcribe`, `--transcribe-max`, `--transcribe-limit` adjust it). Only messages actually being reported are transcribed, and the same transcript cache is used, so a restart never re-bills. See `claude-tools telegram watch --help`.

### Remote Bot Commands

A **remote Telegram bot** is a second, separate transport: messages it sends arrive **from the bot**,
so a chat with an agent reads as a conversation rather than as notes to self, and it notifies like any
other contact. It is how a session is driven remotely — from a phone, without a terminal.

Several bots can be configured and picked per session, so different agents or projects appear as
different identities:

```bash
claude-tools bot list                      # configured names (never tokens)
claude-tools bot info --bot personal       # act as one for a single command
TELEGRAM_BOT=personal claude-tools bot …   # pin one for a whole session
```

Selection order: `--bot <name>`, then `TELEGRAM_BOT`, then the entry marked `"default": true`, then
the first entry. An unknown name is a hard error listing what exists, rather than falling back and
messaging the wrong person. `TELEGRAM_BOT_TOKEN` and a legacy single `telegramBot` secret both appear
as a bot called `default`, so existing one-bot setups keep working.

| Command | Description |
|---------|-------------|
| `bot info` | Bot identity, confirmed offset, log path, chats seen |
| `bot watch` | Long-poll and print one line per message (for the Monitor tool) |
| `bot send <chat> -` | Send as the bot (body on stdin) |
| `bot reply <chat> - <messageId>` | Reply as the bot (`-` = body on stdin) |
| `bot typing <chat>` | Hold "typing…" while you work on a reply |
| `bot read` | Show received messages from the local log |
| `bot list` | List configured bots (names only) |
| `bot download <msgId>` | Download a received photo, document or voice note (`--chat` to disambiguate) |
| `bot table <chat>` | Send a real table (rows as pipe- or tab-separated stdin lines) |

Two properties of the Bot API shape these commands:

- **There is no history.** `getUpdates` is a queue, and an update is gone for good once a later
  offset is confirmed. `bot watch` therefore writes every update to
  `<config dir>/telegram-bot/<state>/messages.jsonl` **before** advancing the offset, and `bot read`
  serves that log. A bot also cannot see anything sent before someone first wrote to it — until then
  `sendMessage` fails with "chat not found", because a bot cannot open a conversation.
- **Only one poller per bot.** A second `bot watch` on the same token gets HTTP 409; the command says
  so rather than appearing to stall. `--state` defaults to the bot's name, and a namespace records the bot
  **id** that owns it, so a second bot is refused rather than confirming updates it never saw — including
  when a token is swapped behind an unchanged name. A namespace with an offset but no recorded owner
  needs `--adopt-state`, since an unowned offset could belong to any bot. `bot watch` claims the
  namespace before its first poll, so two bots cannot race onto one.

**Who the bot listens to is per chat**, because a group is not a DM. `allowedChats` lists the chats the
bot deals with at all — omitted means *any*, which is worth avoiding: anyone can find a bot, and a
watcher hands what it receives to an agent as if the owner had written it. A **group needs an entry of
its own** under `chats`, and that entry **requires a mention by default**. Without that default, every
line typed in the group would wake the agent, which in a working team chat is a day of unrelated
traffic at one turn each.

```json
"telegramBots": [{
  "name": "assistant",
  "token": "…",
  "allowedChats": ["100000001"],
  "chats": {
    "-1001234567890": { "allowFrom": ["100000001"], "requireMention": true }
  },
  "mentionPatterns": ["\\bclaude\\b"]
}]
```

`allowFrom` is user ids and an empty or omitted list means any member — ids rather than usernames,
because a username can be changed and a freed one re-registered by someone else. `requireMention`
defaults to **true** for a group and **false** for a DM, so a group entry can be `{}` and a DM needs no
entry at all. A message addresses the bot when it carries its `@handle`, a mention of its id,
`/command@handle`, a reply to one of its own messages, or anything matching `mentionPatterns`. A group
message that does not is dropped **silently**; an unlisted chat is reported once on stderr with the
config line that would let it through. `bot info` lists the sender ids it has seen, which is where an
`allowFrom` list comes from.

Existing configs need no change: a flat `allowedChats` still governs DMs exactly as before, and a group
id already listed there keeps working, now with mentions required.

Messages are sent as **rich markdown** by default, parsed by Telegram's servers: `**bold**` is bold,
`- ` lines are bullets, `[label](url)` is a link, and tables and headings render for real (up to 32768
characters). A message the rich parser refuses falls back to the ordinary path, so nothing is lost.
`--plain` sends the source literally, `--html` passes your own HTML through, and `--auto` uses the older
HTML conversion. `bot send`/`reply`/`edit` run the same format check as the account commands (see
Telegram Commands above), with the same `--format-ok "<reason>"` override.

`send`/`reply` attach a Listen button by default; pressing it returns the message as a voice note, and
the button is removed on that first press so it cannot be run twice. `--no-tts` leaves it off.
Synthesis is `agent-tools ttsify` (Kokoro for English, Silero for Russian), converted to Ogg/Opus with
ffmpeg, and the watcher answers the press itself so it works while an agent is busy.

Speech is **optional**: it needs that Python stack and ffmpeg, and on a machine without them the
button is simply not attached — the message still sends, and the reason is printed once on stderr.
Set `AGENT_TOOLS_BIN` if the CLI is installed somewhere unusual.

The text is rewritten for listening before synthesis: markup is stripped deterministically, then
ttsify's LLM transform turns terse prose into narration, because a commit hash or a table read
literally is unintelligible. If no LLM provider is reachable the transform is skipped and the text is
read verbatim rather than failing.

Photos, documents and other attachments are recorded with a file reference, so `bot download <msgId>`
fetches them later — a photo at its largest available size, which is what makes a screenshot legible.
The reference comes from the local log, so only messages received while watching can be fetched.

An arriving message is marked 👀 the moment a watcher picks it up, and the chat shows "typing…", so
"seen and working on it" is distinguishable from "not received". `--no-seen` and `--no-typing` turn
each off independently, which is worth doing in a busy group. Both watchers do this, and the account
watcher skips its own sends and Saved Messages.

When a message arrives, `bot watch` shows "typing…" in that chat before transcribing or logging, so a
voice note that takes a few seconds does not look ignored (`--no-typing` disables it). Telegram clears
the indicator after about five seconds; `bot typing <chat> --seconds <n>` holds it across longer work.

Voice and audio messages up to 1 minute are transcribed with the same backends and cache as the account
client, keyed on the file id. Telegram serves bot voice notes as `.oga`, which Groq rejects, so the
upload filename is normalised to `.ogg`. `--no-transcribe`, `--transcribe-max` and `--transcribe-limit` apply.

### Agent Hub Commands

The **agent hub** is a server sessions listen to, so two agents can reach each other, leave a status
line, and read back what was said. It exists because the harness's own `SendMessage` keeps no history,
offers no status board, queues nothing for a session that has exited, and gives the owner no way to
see the traffic without a live agent relaying it. The server is a separate component; point the client
at your own with `--url` or the `hub.url` config key.

```bash
claude-tools hub watch --agent manager        # the long poll, for the Monitor tool
claude-tools hub send worker - --as manager   # body on stdin, like the bot commands
claude-tools hub broadcast - --kind restart   # every listener at once
claude-tools hub status --set "ISSUE-20 review"  # one line, not a report
claude-tools hub rename manager               # the hub and the tmux session, one command
claude-tools hub roster                       # states and last-seen
claude-tools hub log --agent worker --limit 20
claude-tools hub whoami                       # this machine's identity and the resolved URL
```

`hub send` and `hub broadcast` refuse to repeat the identical text to the same recipient within an hour
and name the earlier matching message's id instead. Exit status: `0` sent, `3` not sent because of that check (the
hub already has it; `--again` sends anyway), `1` failed. A script that alarms on any non-zero status
should pass `--again` for notices that are meant to repeat, or treat `3` separately.

`--agent` names the agent a command is **about**; `--as` names who is **calling**, for the commands
where those differ (a send is about its recipient). Both fall back to `AGENT_HUB_AGENT` or the
`hub.agent` entry in the secrets file.

**`hub rename` moves three things and reports all three separately.** A session launched without
`AGENT_HUB_AGENT` registers as `<directory>-<4 hex>`, which tells the roster nothing, so `hub watch`
says so at registration — and this is what that warning is for. The hub rename is the only fatal step:
it goes first, and the two after it are local.

```
hub     ✅ "otherorg-8ad9" → "manager"; the old name is archived, then swept
tmux    ⏭ not inside tmux (TMUX_PANE is unset) — no session to rename
claude  ⏭ run `/rename manager` yourself — a slash command is user input, which no CLI can send
```

- **tmux** is `rename-session`, targeted at the pane in `TMUX_PANE` — this process's own environment,
  never a pane list, which would answer for whatever the tmux server considers current and rename the
  wrong session on a machine running several. No pane is the normal case for a `--bg` session, so it is
  reported as skipped; a tmux that refuses is reported as itself and the command still exits 0, because
  the hub rename has already happened and a non-zero exit would say the opposite.
- **The Claude session name cannot be done from here and is not faked.** `/rename` is user input, and
  typing into a session's pane is prohibited outright, so the line to run is printed instead.
- **The watch is finished** the moment the rename lands: a poll on the old name answers a redirect
  naming its successor. Stopping it and arming one for the new name is the agent's own call — a watch
  is an MCP tool, not something a CLI can reach — so the exact command is printed.

**Arming the watcher is the registration.** There is no register command, no enrolment code and
nothing for a human to paste — agents launch headlessly, so there is usually nobody at the machine to
paste one. The first poll puts the agent on the roster and, if the hub has never seen this machine,
into the owner's approval queue. `hub watch` prints that plainly, keeps polling every 15 seconds and
picks the approval up by itself:

```
[hub] PENDING APPROVAL — this machine is not on the hub yet, so no messages can arrive.
[hub] Tell your user: open https://hub.example.com/ and approve machine 2c51c1046ace6da3.
```

Four properties are load-bearing rather than incidental:

- **The credential is this machine, and it never travels in `Authorization`.** The fingerprint is
  `base64url(HMAC-SHA256(salt, "ai-hub/fingerprint/v1\n" + app-specific machine anchor))`, where the salt is
  32 CSPRNG bytes written once to `~/.config/ai-hub/machine.key` (`0600`, `O_EXCL`) and the hub stores
  only `sha256` of the result. It is sent in `X-Hub-Fingerprint`, because the cluster's basic-auth
  middleware is configured `removeHeader: true` and would eat `Authorization`. What gets printed is the
  16-character **label** — a prefix of the hash, never of the credential, because an agent transcript
  gets pasted into chats. The derivation is vendored from the server rather than reimplemented, and
  `src/tests/hub-fingerprint.test.ts` pins the whole chain to literals the server's own module produced;
  the same literals are asserted in the server's suite. A silent divergence there would look like an
  enrolment problem, not a client bug.
- **The client is the last to give up.** Redis blocks 20s, the server holds 25s, the client aborts at
  40s, the ingress allows at least 60s. A client that gave up first would retry into a hold still
  parked on Redis and the holds would pile up, so an inverted `--timeout` is refused rather than
  clamped silently.
- **An outage is ridden out, never exited on.** The owner's link drops for up to fifteen minutes; the
  watcher backs off exponentially to a five-minute ceiling with jitter and keeps going. Only a
  permanent fault stops it — a rejected agent name, a URL that is not the hub, or basic auth in front
  of `/api`. A refused *machine* is not permanent: a revoked watcher keeps polling and recovers by
  itself when the owner re-approves it, with no restart.
- **The cursor moves last.** Every message is written to
  `<config dir>/hub/<state>/messages.jsonl` and fsynced **before** the cursor advances, and the cursor
  is saved from every response including an empty one. Delivery is at-least-once, so the watcher
  dedupes on `(stream, id)` — never on the id alone, because Redis keeps a stream's sequence counter
  per stream and an inbox message and a broadcast landing in the same millisecond share an id.

A long-lived listener runs the code it loaded at startup, so the hub is its own update channel: a
`--kind restart` broadcast tells every watcher to stop, update and re-arm, and the client version
rides on every poll as the backstop for a listener that started stale. `hub log --local` reads the
watcher's own log without touching the network, which is what you want when the hub is the thing that
is unreachable.

### GitHub Commands

| Command | Description |
|---------|-------------|
| `github watch` | Print one line per changed notification thread, forever (for `watch_start` or the Monitor tool) |

`github watch` reads the notification inbox through `gh api`, so it uses the existing `gh` login and adds no credential. Every `--interval` seconds (default 60, or GitHub's `X-Poll-Interval` when that is longer) it asks for every thread updated in the last six hours and reports the ones it has not seen. It does not trust `updated_at` order, because GitHub can show a notification minutes after the time it carries. An unchanged window costs a 304 through the ETag. Each line reads `[gh] <owner/repo> <PR#n|Issue#n|CI|Release> <reason|change> <HH:MM>: <title> <url>`. The third field is GitHub's reason (why you are subscribed), except with `--drop-silent-bumps` when the update's check succeeded and could be compared with an earlier look at the same PR or issue: then it names what changed, joined by `+` (`pushed+commented`, `merged`, `unlabelled`, or `updated` for a change it cannot classify, such as an edit). A first look, a failed, paused or over-budget check, or a subject newer than the notification keeps GitHub's reason. `--json` lines keep `reason` and add `change` only when there is one. `--drop-silent-bumps` skips a PR or issue update when the PR or issue itself did not change; a second real change in the same second as the one just reported can be skipped, though the change itself stays on GitHub. State is saved under `<config dir>/github-watch/<state>/`, so a restarted watcher reports what changed while it was down; the first run only records a baseline. `--repo 'org/*'`, `--reason` and `--type` filter, `--since <iso>` replays, `--once` checks the setup. Workflow-run failures arrive as type `CheckSuite` only when "Actions" notifications are enabled in GitHub's notification settings. See `claude-tools github watch --help`.

### Jira Commands

| Command | Description |
|---------|-------------|
| `jira list [project]` | List issues |
| `jira search <jql>` | JQL search |
| `jira create <summary>` | Create issue |
| `jira status <issue> <status>` | Update status |
| `jira comment <issue> <text>` | Add comment |
| `jira show <issue>` | Show details |

### Asana Commands

Every argument that names a project, section, task or user takes a **gid or a
name**. Names resolve through Asana's typeahead (sections from the project's own
section list), and an ambiguous one prints the candidates with their gids instead
of picking one. A query that saturates the typeahead window says so, because a
same-named resource outside it cannot be ruled out - pass a gid when it matters.

| Command | Description |
|---------|-------------|
| `asana whoami` | Authenticated user and workspace gids |
| `asana workspaces` | List workspaces |
| `asana projects [workspace]` | List projects (`--archived`) |
| `asana sections <project>` | List a project's sections |
| `asana list` | Your incomplete tasks; `--project`, `--section`, `--assignee`, `--completed`, `--due-before` |
| `asana show <task>` | Task details; `--comments` |
| `asana search <text>` | Workspace full-text search (premium endpoint) |
| `asana create <name>` | Create a task; `--project`, `--section`, `--notes`, `--assignee`, `--due`, `--parent` |
| `asana update <task>` | `--name`, `--notes`, `--due`, `--clear-due` |
| `asana comment <task> <text>` | Add a comment |
| `asana done <task>` / `asana reopen <task>` | Toggle completion |
| `asana assign <task> <user>` | Assign, or `none` to unassign |
| `asana move <task> --section <s>` | Move between board sections; `--project` to add it to one |

Three Asana-specific things worth knowing:

- **`opt_fields` is mandatory in practice.** A compact task carries only
  `gid`, `name`, `resource_type`, `resource_subtype` and `created_by` - no
  assignee, due date or completion - so every read here names the fields it
  renders.
- **gids are opaque strings**, 16+ digits, and above `Number.MAX_SAFE_INTEGER`
  they do not survive being parsed as numbers. They stay strings throughout.
- **`search` has no offset pagination.** It is walked with a `created_at`
  cursor, so its results come back oldest first, and it needs a paid workspace
  (Asana answers 402 otherwise). The cursor steps back to the last distinct
  timestamp so a group of tasks created in the same instant is not skipped at a
  page boundary, but a group larger than one page cannot be traversed at all:
  a very broad search is best-effort, and says so on stderr when it is. The
  search index also lags, so a just-created or just-deleted task can be missing
  from, or still present in, its results.

### Browser Commands (Extension Required)

The browser commands require a Chrome MV3 extension that connects to a local WebSocket bridge (default `127.0.0.1:7331`).
In this monorepo, the extension source is in `C:\projects\workspace\repos\claude-tools\extension`.

| Command | Description |
|---------|-------------|
| `browser list-tabs` | List open tabs |
| `browser attach <tabId>` | Attach debugger to tab |
| `browser detach <tabId>` | Detach debugger |
| `browser eval <tabId> <expression>` | Evaluate JS in tab |
| `browser html <tabId>` | Fetch outer HTML |
| `browser logs <tabId>` | Stream console/page logs |
| `browser network <tabId>` | Stream network events |
| `browser response-body <tabId> <requestId>` | Fetch response body |

## Development

```bash
# Run in dev mode
npm run dev

# Build
npm run build

# Build the Chrome extension
npm run build:extension

# Generate Telegram session
claude-tools telegram auth
```

## Dependencies

- **commander** - CLI framework
- **chalk** - Terminal colors
- **telegram** - GramJS Telegram client
- **jira.js** - Jira Cloud API client
- Asana uses Node's global `fetch` - no client library
- **koffi** - Windows API bindings (for spawn)

## Telegram message identity and cache upgrades

Message IDs are scoped to a chat. Always pass the chat explicitly:

```bash
claude-tools telegram read-around 12345 --chat "-1002000000002" --context 10 --json
claude-tools telegram media-info 12345 --chat "-1002000000002"
claude-tools telegram download 12345 --chat "-1002000000002"
```

`read-around` requires `--chat`, even when only one cached message has that ID.
Context counts are 0–100; message IDs are positive 32-bit integers. Missing targets
are fetched only from the selected peer; there is no global discovery or sync.
For commands with a positional chat, put flags first and use the option terminator,
for example \`telegram read --json -- -1002000000002\` or
\`telegram sync --force -- -1002000000002\`. Names must resolve uniquely. Use the marked ID from `telegram chats` when titles
collide: positive user IDs, negative basic-group IDs, and channel/supergroup IDs
below -1000000000000 retain separate namespaces. Legacy raw positive IDs are
accepted only when the known peer namespaces do not collide. Usernames and `me`
are resolved through Telegram.

Cache schema v3 creates a consistent `telegram.db.before-v3-<uuid>.db` backup and
preserves old messages/sync metadata in `legacy_messages` and
`legacy_sync_state`. Earlier schemas did not record peer types, so those rows are
quarantined instead of guessing a chat. Run `telegram sync <explicit-chat> --force`
to backfill verified history. Previously overwritten messages require Telegram
backfill. New messages use a surrogate row ID plus unique chat/message identity.
Upgrades rebuild FTS and clusters; stale Telegram embeddings are invalidated while
Jira/document embeddings remain intact. Future schemas fail without deleting data.

The cache is bound to the configured session fingerprint and verified account.
Use `CLAUDE_TOOLS_CONFIG_DIR` for a separate account/config directory; changing
sessions fails with the old cache preserved. Do not reuse another account's cache.
Cross-chat reply references are labeled but are not followed automatically.
Default media filenames include chat and message IDs.

After source updates run `npm run build`; shared skills execute `dist/cli.js`.
Run `npm test` for the full build and regression suite.
