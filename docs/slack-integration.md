# Slack integration — thread commands & continuous output

This page documents the Slack thread-command feature (tickets TASK-056..TASK-068)
that sits on top of the base [Slack bridge](slack-bridge.md). Where the base
bridge covers the Web API client, OAuth, transports and the raw two-way proxy,
this page covers what was added on top: **continuous output posting**, **in-thread
commands answered by the app**, and the **security scrubbing** applied to
anything the app posts to Slack.

Every claim below is traceable to source; file/line references are given so each
statement can be checked.

## What the feature does and why

When the Slack tab is connected the app uses **one Slack thread** as a two-way
bridge between the `claude` (cmd) pane and Slack:

- **Connect posts a single anchor message** and reuses its `thread_ts` for the
  whole session. The header text is
  `":robot_face: Claude session started · <folder>. Reply in this thread to talk
  to Claude; Claude's output will be posted here."`, and its `ts` becomes
  `s.threadTs` — the one thread every outbound post is threaded into. On post
  failure the session is **not** marked connected and `threadTs` stays `null`, so
  no stale/duplicate thread is left behind.
  (`renderer/renderer.js` — the connect flow around lines 7408-7434.)
- **Claude's terminal output is posted back to that thread — continuously.**
  While the proxy is active, `onCmdData` accumulates the cmd pane's raw output
  into `s.captureBuffer` (`renderer/renderer.js:1168`). A periodic flush posts
  progress **every 30 s** during a long run, and a final flush posts the
  remainder when the run goes idle.
- **Slack thread replies are captured and typed into Claude.** Replies in the
  anchor thread are read via `conversations.replies` (history polling alone never
  returns thread replies) and, when accepted, pushed onto an inbox and written
  into the cmd pane one at a time as Claude goes idle.
  (`renderer/renderer.js` — reply polling around lines 7639-7652;
  `slackTryDispatch` around lines 8218-8246.)
- **Certain phrases are answered by the app as COMMANDS** instead of being
  forwarded to Claude. A reply that matches a built-in command (e.g. "show me the
  tasks") is answered in-thread by the app and never reaches Claude.

The pure decision logic lives in Electron-free modules so it is unit-testable:
[`lib/slack-commands.js`](../lib/slack-commands.js) (the command core) and
[`lib/slack-proxy.js`](../lib/slack-proxy.js) (flush decision + scrubbing). The
renderer cannot `require()` these (it runs with `nodeIntegration:false`), so it
keeps a **verbatim mirror** of each function and a comment on every mirror saying
"keep in sync". This page cites the `lib/` source as the source of truth.

## Thread commands

Incoming replies are intercepted in `handleIncomingSlackMessage`
(`renderer/renderer.js:8151`): the reply text is matched against the command
registry with `matchCommand`, and if it matches, `handleSlackCommand` runs the
handler and posts its reply into the anchor thread — the message never enters the
inbox and no keystroke is ever written to the cmd pane
(`renderer/renderer.js:8162-8166`).

**Matching is whole-phrase, not substring/fuzzy.** `normalizeCommandInput`
lowercases, collapses internal whitespace, trims, and strips trailing `.!?…`;
`matchCommand` then requires the normalized reply to **equal** a normalized
trigger phrase (`lib/slack-commands.js:57-92`). So "show me the tasks" matches but
"please fix the tasks page" and "show me the tasks now" do not.

The registry is `DEFAULT_COMMANDS` (`lib/slack-commands.js:35-51`), mirrored as
`SLACK_DEFAULT_COMMANDS` in the renderer (`renderer/renderer.js:7903-7919`). It
ships three built-in commands:

### `tasks`

- **What it does:** replies with the live tasks board. The handler
  (`renderer/renderer.js:8089-8101`) requires an open folder, checks that a
  `tasks/` directory exists, force-refreshes the board (`pollTasksOnce(tab, true)`
  — the `true` bypasses the "tasks tab visible" gate so it works even when the
  Tasks tab is not open), then formats the ticket map with `formatTasksSummary`.
- **Trigger phrases:** `"show me the tasks"`, `"show tasks"`, `"list tasks"`,
  `"tasks"`, `"what are you working on"`.
- **Reply format** (`formatTasksSummary`, `lib/slack-commands.js:121-161`): a
  "Currently working on" section listing tickets whose status is active
  (`defining` / `in-progress` / `testing`), an optional "Failed testing" section,
  then a one-line lane count. Lane order is
  `todo · defining · in-progress · testing · post-processing · done`
  (`failed-testing` folds into `testing`; any out-of-enum status is counted under
  a trailing `unknown N`).

  Example reply:

  ```
  *Currently working on:*
  TASK-058 — Slack tasks command (in-progress)

  todo 2 · defining 0 · in-progress 1 · testing 0 · post-processing 0 · done 5
  ```

  Edge replies: no folder open → `"No project folder is open."`; no `tasks/`
  directory → `"No tasks board found in this project."`; an empty ticket map →
  `"The tasks board is empty."` (the last from `formatTasksSummary` itself).

### `help`

- **What it does:** lists every registered command from the **same** registry the
  matcher uses, so help can never drift from what actually works. Pure formatting
  with no I/O (`renderer/renderer.js:8105`), so it works even while Claude is busy.
- **Trigger phrases:** `"help"`, `"commands"`, `"show commands"`, `"what can you
  do"`.
- **Reply format** (`formatHelp`, `lib/slack-commands.js:171-191`): one line per
  command — `*<name>* — <description> (say: "<pattern>", …)`.

  Example reply:

  ```
  *tasks* — Show the tasks board and what is being worked on (say: "show me the tasks", "show tasks", "list tasks", "tasks", "what are you working on")
  *help* — List the commands this thread understands (say: "help", "commands", "show commands", "what can you do")
  *status* — Show session status: folder, Claude activity, queue and active tickets (say: "status", "show status", "what's your status", "are you busy")
  ```

### `status`

- **What it does:** a one-shot session snapshot — open folder, Claude activity,
  the live transport, queued Slack messages, and how many tickets are actively
  worked. Reads live state only and posts in-thread, so it works (and correctly
  reports `busy`) while Claude is busy. The board read is force-refreshed and
  wrapped in try/catch: no folder or any failure yields `Active tickets: unknown`
  rather than a crash (`renderer/renderer.js:8113-8134`).
- **Trigger phrases:** `"status"`, `"show status"`, `"what's your status"`,
  `"are you busy"`.
- **Reply format** (`formatStatusReply`, `lib/slack-commands.js:205-220`):

  ```
  *Session status*
  Folder: C:\projects\myapp
  Claude: busy
  Transport: Socket Mode
  Queued: 0
  Active tickets: 3
  ```

  Field mapping: `Folder` is the open folder or `(no folder open)`; `Claude` is
  `busy` when exactly busy else `idle`; `Transport` is `Socket Mode` / `polling` /
  `none`; `Queued` is the inbox length; `Active tickets` is the count or `unknown`.

### Extending the command system

The system is intentionally extensible and **data-only**: a command is a registry
entry `{ name, description, patterns }` with no handler in the pure core. To add a
command you (1) add an entry to `DEFAULT_COMMANDS` (and its renderer mirror
`SLACK_DEFAULT_COMMANDS`), and (2) wire a handler in `SLACK_COMMAND_HANDLERS`
keyed by the entry `name` (`renderer/renderer.js:8083-8135`). A handler returns a
reply string; if a registry entry has no matching handler in the current build,
`handleSlackCommand` replies `"That command isn't available in this session."`
(`renderer/renderer.js:8180-8184`). A throwing/rejecting handler posts a short
`"Command failed: …"` reply instead of crashing the renderer
(`renderer/renderer.js:8194-8199`).

### Multi-step prompts: `create-ticket` (TASK-072)

Most commands are single-shot (one reply, no state). `create-ticket` (patterns
`create ticket` / `create a ticket` / `new ticket` / `add ticket`) is the first
**two-step** command and introduces a minimal pending-prompt mechanism on
`tab.slack.pendingCommand`:

1. The handler refuses with `"No project folder is open."` (setting **no**
   pending state) when no folder is open. Otherwise it sets
   `s.pendingCommand = { name: 'create-ticket' }` and replies asking for
   `title: <your title>, description: <your description>` (or `cancel`).
2. `handleIncomingSlackMessage` checks `s.pendingCommand` **before**
   `matchCommand`. While a prompt is pending the next accepted anchor-thread
   reply is consumed by the pending flow (`handleCreateTicketReply`) — it is
   still shown in the pane, but is never matched against the registry (so other
   commands do **not** run), never pushed to `s.inbox` and never forwarded to
   Claude. A normalized `cancel` clears the pending state.
3. The reply is parsed by the pure helper `parseCreateTicketReply(text)`
   (`lib/slack-commands.js`, mirrored in the renderer): case-insensitive
   `title:`/`description:` labels in **either order**; a label only starts a
   field at the start of the reply or immediately after a comma and/or newline
   (**first-label-wins**, so a `title:` value may itself contain the word
   `description:`); the description may contain commas and newlines; `title` is
   required (non-empty), a missing/empty description falls back to the default
   `What needs doing and why.`. An unparseable reply (no non-empty title)
   re-prompts and **stays pending**; only `cancel` exits.
4. On a successful parse the renderer creates the ticket exactly like the
   New-ticket modal path (`onCreateNormal`): force-poll the board, `nextTaskId`,
   the identical frontmatter + body template (Description via `neutralizeBugText`,
   `## Acceptance Criteria`, user-owned `## Additional Context`), written to
   `tasks/todo/<id>-<slug>.md`, then a re-poll and a confirmation
   `Created <id> — <title> (todo).`.

`pendingCommand` is part of the session state: it initialises to `null` and is
cleared in `disconnectSlack` and `resetSlackForFolder` alongside
`inbox`/`threadTs`, so a disconnect or folder switch drops any half-finished
prompt. Every reply this flow posts (prompt, re-prompt, confirmation, errors)
passes through `defangSlackControlSequences`, and the title/description are
newline-neutralized (`serializeTicket`) / heading-escaped (`neutralizeBugText`)
so a crafted title can neither inject frontmatter nor forge a section nor ping
the channel. It is file-I/O only, so it works while Claude is busy.

## Output posting: periodic flush + finish flush

Two paths post Claude's captured output, and together they post every byte
**once and only once**:

- **Periodic flush (every 30 s).** `startSlackFlushTimer` runs `slackFlushTick`
  on a `setInterval` of `SLACK_FLUSH_INTERVAL_MS = 30000`
  (`renderer/renderer.js:20`, `8313-8317`). `slackFlushTick` first consults the
  pure gate `shouldFlushCapture` (`lib/slack-proxy.js:71-79`), which returns true
  only when **all** of these hold: the proxy is enabled (connected + anchor
  thread), `postReplies` is on, `captureBuffer` is a non-empty string, and the run
  is currently `busy`. It then **clears the buffer before the await**, so any
  output arriving during the network post lands in the next window — never lost,
  never double-sent (`renderer/renderer.js:8283-8308`).
- **Finish flush.** `slackOnFinished` runs when the tab flips to `finished`
  (`setTabStatus` → `slackOnFinished`, `renderer/renderer.js:1123-1128`). It posts
  the remaining buffer, clears it, and clears the in-flight flag so a finished run
  can never leave dispatch permanently stuck (`renderer/renderer.js:8251-8276`).

Both paths run the same three-stage pipeline
`redactSecrets(humanizeSlackOutput(cleanTerminalOutput(buffer)))`:
`cleanTerminalOutput` strips ANSI/box chrome, keeps final line state, and trims
to 12 000 chars; `humanizeSlackOutput` (TASK-071) is a mechanical readability
pass that collapses consecutive duplicate lines from TUI redraws, drops whole
Claude-TUI status/hint noise lines (spinner "…ing…" progress lines,
"(esc to interrupt)" hints, standalone elapsed/token counters, `⏵⏵` mode hints)
and collapses blank runs; `redactSecrets` then runs **last**, immediately before
posting, so it remains the final transform on both auto-post paths. Long
messages are chunked to ~3 800 chars by `postToSlack` (Slack's ~4 000-char
limit). When the pipeline reduces a buffer of pure TUI redraw/spinner noise to an
empty string, the flush **posts nothing** and still consumes the buffer.

## AI summarization (TASK-073)

On top of the mechanical TASK-071 cleanup, the two auto-post paths can
**summarize** each output window into a short human-readable message using a fast
Claude model (Haiku) before posting. This is a follow-up to TASK-071 and is
**off by default** — it is opt-in because it requires an API key and sends
(already-redacted) output to an external service.

**Pipeline.** With summarization enabled, both `slackFlushTick` and
`slackOnFinished` build the reply as:

```
postToSlack( redactSecrets( summarize( redactSecrets( humanizeSlackOutput( cleanTerminalOutput(buffer) ) ) ) ) )
```

`redactSecrets` stays the **last** transform before posting, exactly as in
TASK-063/071. Note there are **two** redactions: the inner one runs
**before** the text is handed to the summarizer (redact-before-send, below), and
the outer one runs on the model's returned summary as defense in depth.

**Where it runs.** The model call runs in the **main process**, never the
renderer — there is no `@anthropic-ai/sdk` dependency; a minimal `https` client
mirrors the outbound-HTTP pattern in `lib/slack.js`. The transform lives in the
Electron-free [`lib/slack-summarize.js`](../lib/slack-summarize.js) so it is
unit-testable with a mocked client and no real API traffic. The renderer calls it
over a new IPC channel `slack:summarize` (`preload.js` `window.api.slack.summarize`
→ `main.js` handler), which reads the key, injects `redactSecrets` as the
outbound redactor, and calls `summarizeForSlack`.

- **Model:** `claude-haiku-4-5`, kept in one constant (`SUMMARY_MODEL` in
  `lib/slack-summarize.js`). Endpoint `POST https://api.anthropic.com/v1/messages`,
  header `anthropic-version: 2023-06-01`.
- **Prompt:** the system prompt instructs the model to summarize the terminal
  output concisely for a human reading Slack, preserve concrete results
  (pass/fail, file names, commands, errors), and never invent facts.
- **Redact-before-send (security-critical):** the text handed to the Anthropic
  client is already redacted by the renderer, and `summarizeForSlack` redacts it
  **again** at the lib boundary (the injected `redact` fn) before it leaves the
  process. The external summarizer can never receive an un-redacted secret. The
  returned summary is redacted a final time before `postToSlack`.
- **Fallback (never throws, never loses/duplicates a post):** if summarization is
  disabled, no key is configured, the cleaned window is short (< 200 chars),
  or the call returns a non-200, times out, errors, or is malformed, the path
  falls back to posting **exactly** TASK-071's cleaned+redacted output. The buffer
  is still cleared **before** the await (once-and-only-once from TASK-061 is
  preserved), and any failure degrades silently rather than throwing into the
  flush path.
- **Time-bound:** the API call has an ~8 s timeout (`req.setTimeout` +
  `req.destroy`) so a slow response can never stall the 30 s periodic flush.
- **Main-process length clamp (TASK-077):** the `slack:summarize` handler clamps
  its input to the last **12 000 chars** (`SLACK_SUMMARIZE_MAX_INPUT_CHARS` in
  `main.js`) before calling the summarizer — defense-in-depth that mirrors the
  renderer's `cleanTerminalOutput` bound so this IPC channel can never forward an
  unbounded payload to the external API. The tail is kept (matching the renderer)
  and the clamp runs before redaction, a no-op for the common ≤cap window.
- **Scope:** summarization applies only to the two **auto-post** paths, never to
  command replies or the composer — the same scope as TASK-071.

**Toggle & default.** A per-folder checkbox *"Summarize output with AI"* (next to
*"Post Claude's replies back to Slack"*) controls it; it is **unchecked by
default** and persisted in the per-folder Slack config. With it off the auto-post
paths behave exactly as TASK-071.

## Security

Everything the app auto-posts or replies with is scrubbed. Two independent
scrubbers, both defined in [`lib/slack-proxy.js`](../lib/slack-proxy.js) and
mirrored in the renderer:

### Secret redaction — `redactSecrets`

Applied on **both auto-post paths** (`slackFlushTick` and `slackOnFinished`) as
the **last** transform before posting — after `cleanTerminalOutput` **and** the
`humanizeSlackOutput` readability pass — so no auto-post path ever emits
un-redacted output. Because `humanizeSlackOutput` only dedupes/strips/collapses
whole lines and runs **before** redaction, it can never un-redact or reassemble a
split secret: redaction still sees (and masks) the final posted text. It is
deliberately
conservative — it anchors on known token prefixes and high-entropy length
thresholds rather than broad matches — and replaces each match with the fixed
placeholder `***REDACTED***`. Masked shapes
(`lib/slack-proxy.js:107-147`):

| Shape | Notes |
|-------|-------|
| `KEY=VALUE` / `KEY: VALUE` | only when the key name matches `secret\|token\|key\|password\|passwd\|pwd\|apikey` (value masked, key kept) |
| `Bearer <token>` | keeps the `Bearer ` scheme word, masks the credential |
| connection-string password | `scheme://user:password@host` — masks only the password, keeps scheme/user/`@` |
| `sk-…` | OpenAI-style keys (≥16 token chars) |
| `xoxb-/xoxa-/xoxp-/xoxr-/xoxs-/xoxe-/xoxd-` and `xapp-` | Slack tokens (≥8 chars) |
| `ghp_/gho_/ghu_/ghs_/ghr_…` | GitHub tokens (≥20) |
| `github_pat_…` | GitHub fine-grained PAT (≥20) |
| `glpat-…` | GitLab PAT (≥16) |
| `npm_…` | npm token (≥30) |
| `dop_v1_…` | DigitalOcean token (≥40) |
| `AIza…` | Google API key (≥20) |
| `SG.<id>.<secret>` | SendGrid API key |
| bare JWTs | `eyJ<b64url>.<b64url>.<b64url>` |
| `AKIA…` / `ASIA…` | AWS access key ids (16 upper-alnum) |
| hex ≥ 32 / base64 ≥ 40 | high-entropy blobs, masked unconditionally |

**Git-SHA exemption declined.** A blanket 40-hex readability exemption was tried
(TASK-069) and reverted for security: real secrets are also exactly 40 hex
(legacy GitHub OAuth tokens, hex-encoded 160-bit keys) and would have leaked
unlabeled. A bare 40-hex git SHA is therefore masked — over-redaction is the safe
direction for a boundary that posts to an external destination
(`lib/slack-proxy.js:139-145`).

### Mention/broadcast defang — `defangSlackControlSequences`

Applied on the **command/failure reply path only** (`handleSlackCommand`), because
those replies echo semi-trusted content (thread text, ticket titles, error
strings). It breaks Slack's leading `<` trigger for `<!…>` / `<@…>` / `<#…>`
control tokens by replacing that `<` with `&lt;`, so a crafted `<!channel>`,
`<!here>`, `<@U…>` or `<#C…>` renders inertly as literal text instead of firing a
channel-wide ping, user-group ping, or mention. A lone `<` in ordinary
prose/code (`a < b`, `List<int>`) is left untouched
(`lib/slack-proxy.js:165-168`; applied at `renderer/renderer.js:8189`, `8198`).

Note the two scrubbers are applied to disjoint paths: auto-posted Claude output
gets **redaction** (not defang); app command/failure replies get **defang** (not
redaction). The user-composed and Claude-output post paths are deliberately not
defanged (`renderer/renderer.js:7883-7885`).

## Configuration

Values are read from `.env` (see [`.env.example`](../.env.example)); the Slack
variables are the same as the base [Slack bridge](slack-bridge.md) /
[configuration](configuration.md). AI summarization (TASK-073) adds one optional
variable:

| Variable | Purpose |
|----------|---------|
| `SLACK_TOKEN` | Bot token (`xoxb-…`) or user token (`xoxp-…` written by OAuth). Read by `aws.getSlackToken` (`lib/aws.js:358-378`); an `xapp-…` value here is treated as the app token. Required to connect. |
| `SLACK_APP_TOKEN` | App-level token (`xapp-…`, scope `connections:write`) enabling Socket Mode; optional — without it the tab polls. |
| `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` | OAuth app credentials, required only for "Sign in with Slack" (`slack:startOAuth` refuses with `needsCredentials: true` when either is missing — `main.js:1682-1691`). |
| `ANTHROPIC_API_KEY` | Optional. Enables AI summarization of auto-posted output (TASK-073) when the per-folder *"Summarize output with AI"* toggle is on. Read only in the main process by the `slack:summarize` handler and sent to Anthropic solely as the `x-api-key` header — it is **never logged, never posted to Slack, and never written to a ticket file**. With no key set, summarization silently falls back to TASK-071's cleaned+redacted output. |

The Slack IPC surface these features build on (`preload.js` `window.api.slack.*`,
handled in `main.js`): `getToken`, `connect`, `fetch`, `fetchReplies`, `post`,
`summarize` (TASK-073), `openSocket`, `startOAuth`.

## Edge cases, limitations & troubleshooting

- **Commands work while Claude is busy.** Command replies are matched and answered
  before the message ever reaches the idle-gated dispatch queue, so `tasks`,
  `help` and `status` all respond even mid-run
  (`renderer/renderer.js:8162-8166`).
- **`tasks` / `status` with no folder or no board.** `tasks` replies
  `"No project folder is open."` or `"No tasks board found in this project."`;
  `status` reports `Active tickets: unknown` rather than failing.
- **Redaction is conservative and can over-redact.** By design it favors masking
  ambiguous high-entropy strings (including bare 40-hex git SHAs) over risking a
  leak. If a legitimate value shows as `***REDACTED***` in the thread, that is the
  intended safe behavior.
- **TUI-only output windows post nothing.** If a busy window produces only TUI
  redraw noise, `cleanTerminalOutput` yields an empty string and the flush skips
  the post while still consuming the buffer — no empty Slack message
  (`renderer/renderer.js:8300-8303`).
- **Output posting requires "post replies" enabled.** `shouldFlushCapture` and
  `slackOnFinished` only post when `postReplies` is on; with it off, Claude output
  is not mirrored to the thread.
- **Only anchor-thread replies are proxied.** Replies outside the session anchor
  thread, the bot's own posts, already-seen timestamps, and non-user subtypes are
  filtered (`shouldDispatchIncoming`, `lib/slack-proxy.js:47-63`), so Claude's own
  output never loops back in as a prompt.
- **Reconnect starts fresh.** Disconnect clears `threadTs` and in-flight state so a
  later reconnect creates a new single anchor rather than reusing a stale thread
  (`renderer/renderer.js:7443-7459`).
