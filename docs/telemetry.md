# Usage & telemetry (tokens & cost)

## What it does and why

Claude Code has **built-in OpenTelemetry**. When it is enabled, every `claude`
run exports how many tokens it used and what that cost — per API call and per
model. This feature turns that on from inside the app, receives the data locally,
and shows a **live running total of tokens and cost** on its own **Stats** sub-tab
(alongside Git Bash / Files / … / Team). The Stats tab holds both the live usage
display **and** the telemetry settings (the enable toggle and the optional forward
store). Optionally, it **forwards a compact JSON summary to a URL you choose** so
the numbers can be stored/aggregated online.

It exists so you can answer, without leaving the app, *"how many tokens am I
using and what is this costing?"* — including the token cost of the multi-agent
[orchestrate](orchestrate-workflow.md) swarm, because every sub-agent the swarm
spawns is a `claude` API call that is captured too.

## How it works

### The honest constraint (important)

Claude Code only speaks **OTLP** (the OpenTelemetry wire protocol) — it will
**not** POST plain JSON to an arbitrary REST URL. So there are two distinct hops:

1. **`claude` → the app.** Claude Code exports **OTLP/JSON** over HTTP to a local
   endpoint. The app runs a tiny **loopback receiver** (127.0.0.1) that it points
   `claude` at. No external OpenTelemetry collector is required, and — because the
   app pins `OTEL_EXPORTER_OTLP_PROTOCOL=http/json` — **no protobuf decoding** is
   needed; the receiver parses plain JSON.
2. **The app → your URL (optional).** If you set a "store online" URL, the **app**
   POSTs its **own** compact JSON summary there (schema `telemetry.usage.v1`). This
   works with *any* endpoint because it is the app's JSON, not raw OTLP. The raw
   OTLP never leaves your machine.

### Enabling it

On the **Stats** sub-tab, the **Usage & telemetry** section has a
**"Capture token & cost telemetry"** checkbox. Turning it on:

- starts the loopback receiver (if not already running), and
- injects the OTEL environment variables into the app's environment so every
  **newly-spawned** terminal — and therefore every `claude` launched in it —
  exports to the receiver.

Because the variables are read by `claude` at launch, **restart your AI (Claude)
terminal** (or reopen the folder) after toggling so it picks them up. Terminals
already running keep their old environment.

The env vars the app sets (verified against `claude` 2.1.212) are, in
[`lib/telemetry.js`](../lib/telemetry.js)'s `buildOtelEnv`:

```
CLAUDE_CODE_ENABLE_TELEMETRY=1
OTEL_METRICS_EXPORTER=otlp
OTEL_LOGS_EXPORTER=otlp
OTEL_EXPORTER_OTLP_PROTOCOL=http/json
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:<dynamic-port>
OTEL_METRIC_EXPORT_INTERVAL=10000
OTEL_LOGS_EXPORT_INTERVAL=5000
OTEL_SERVICE_NAME=claude-cmd-ui
```

### What is captured

The receiver reads two OTLP signals:

- **`claude_code.api_request` log records** — the richest source: one row per API
  call carrying `model`, `input_tokens`, `output_tokens`, `cache_read_tokens`,
  `cache_creation_tokens`, `cost_usd`, `duration_ms`, `request_id` and
  `session.id`. The app de-duplicates by `request_id` and drives the live totals
  and per-model breakdown from these rows. Each row is also stamped with a
  `project` field (`lib/telemetry.js`'s `resourceProject`), read from its own
  `resourceLogs[].resource.attributes` entry and best-effort percent-decoded
  (`decodeAttrValue`) — this is distinct from the app-global `project` on the
  forwarded payload below, and is not part of `requestKey`'s de-dup identity.
  That `resource.attributes` entry is populated at **spawn time**, not by
  `claude` itself: `main.js`'s `pty:spawn` handler builds
  `OTEL_RESOURCE_ATTRIBUTES=project=<encodeURIComponent(tab folder)>` from the
  pane's own folder and passes it as a per-spawn env overlay into
  `lib/pty.js#spawnShell` (merged in last, after the shell's base env), so every
  pane's exports carry the project it was opened for — independent of the
  app-global "focused" project tracked by `telemetry:setActiveProject` below.
  `decodeAttrValue` deliberately does **not** trim the decoded value (TASK-167):
  the CLI's OTEL SDK already fully percent-decodes the resource attribute
  before the receiver ever sees it, and `setProjectForwarding`'s own key
  (sourced from the same tab folder string) is never trimmed either, so a
  trim here would silently desync the ingest-side bucket key from the toggle
  key for any project path with incidental leading/trailing whitespace.
- **`claude_code.token.usage` / `claude_code.cost.usage` metrics** — cumulative
  monotonic sums, kept only as a cross-check next to the log-derived totals.

### The prompt log (what did *that* prompt cost?)

Under the totals tiles and the per-model breakdown, the **Prompt log** lists one
row per captured API call — newest first — so the panel answers both questions:
the tiles say *how much in total*, the log says *what each prompt cost, and on
which model*.

```
Prompt log                                    3 calls
 10:07:08  haiku-4-5     ↑ 110      ↓ 5     $0.0001
 10:06:07  haiku-4-5     ↑ 1200     ↓ 40    $0.0012
 10:05:06  sonnet-5      ↑ 29959    ↓ 222   $0.0098
                     Logged: ↑ 31269 up · ↓ 267 down · $0.0111
```

- **↑ Up** is everything sent **to** the model on that call: `input_tokens` +
  `cache_creation_tokens` + `cache_read_tokens`. Cache reads are counted as
  up-traffic because they *are* the prompt's context (they are simply billed
  cheaper) — excluding them would report a 29k-token cached prompt as "30
  tokens up".
- **↓ Down** is `output_tokens` — what came back.
- **Model** is the short label (`claude-haiku-4-5-20251001` → `haiku-4-5`); the
  row's tooltip carries the full id plus the untruncated breakdown (input, cache
  write, cache read, output, up, down, cost).
- **Cost** is that single call's own `cost_usd`, not a running total. The footer
  sums up-tokens, down-tokens and cost across the logged calls.

The log is **scoped to the tab's project**, like the tiles: it renders the
project bucket's `recent` rows (last 100). It updates live — the receiver's
pushed snapshot carries `projectRecent` alongside `projectUsage`, so a new call
appears at the top of the log without a second `telemetry:getUsage` round-trip.
A pushed payload that carries no `projectRecent` leaves the existing log alone
rather than blanking it, and a payload tagged for a different project is ignored.

Rows degrade rather than break: a missing timestamp renders as `—`, an empty
model as `(unknown)`, and a non-numeric token field as `0`.

### Storing it online (optional)

Under **Store online**, set a URL and (optionally) a Bearer token, tick **"Forward
usage to this URL"**, and **Save** — this is the app-global **master switch**;
when it is off nothing is ever forwarded. Forwarding itself is **per project**
(TASK-156): after each new API call the app debounces and then fans out one
`telemetry.usage.v1` payload **per project bucket that has usage**, but only for
a project whose own "store online" toggle has also been enabled (via
`telemetry:setProjectConfig` — opt-in, off by default). A project is skipped
whenever either gate is off, even if the other one is on. Today's example
payload for one project:

```json
{
  "source": "claude-cmd-ui",
  "schema": "telemetry.usage.v1",
  "generatedAt": "2026-07-26T04:15:48.794Z",
  "host": "YOUR-PC",
  "sessionId": "b0f1…",
  "username": "steve",
  "project": "claude-cmd-ui2",
  "totals": { "requests": 3, "inputTokens": 30, "outputTokens": 222,
              "cacheReadTokens": 28905, "cacheCreationTokens": 0,
              "totalTokens": 29157, "costUsd": 0.0098, "durationMs": 4600 },
  "byModel": { "claude-haiku-4-5-...": { "...": 0 } },
  "recent": [ { "requestId": "req_…", "model": "…", "costUsd": 0.0032 } ]
}
```

Alongside `host`, the payload carries three identity fields so the online store
can attribute a summary to one app run, one user, and one project folder:

- **`sessionId`** — a random id minted once per app launch (the receiver's
  in-memory store also resets each launch), so every summary from the same run
  shares it.
- **`username`** — the OS username (`os.userInfo().username`), mirroring the
  [prompt-logs](prompt-history.md) `username` tag.
- **`project`** — the absolute folder path of the project bucket this particular
  payload was built from (the same tag a spawned pane's OTEL resource attributes
  carry, set at `pty:spawn` time — see "What is captured" above). Each debounced
  tick fans out one payload per project bucket that has usage and is opted in
  (TASK-156), so this is the bucket's own project, not necessarily whichever tab
  is currently focused. Each field is best-effort and is an empty string when
  unknown; adding them is backward-compatible (the schema tag is unchanged).

The token is sent as `Authorization: Bearer <token>` and is stored only in `.env`
(git-ignored), like the Slack token — the app never returns it to the UI.

**Ready-made destination — the prompt-logs Lambda.** The project's
[`lambda/prompt-logs/index.mjs`](../lambda/prompt-logs/index.mjs) accepts this
`telemetry.usage.v1` payload directly: point **Store online** at the Lambda URL
(the same one used for [prompt-history](prompt-history.md) cloud sync) and, if the
Lambda has `API_KEY` set, put that value in the forward **token** field — the app
sends it as `Authorization: Bearer <token>`, which the Lambda accepts alongside
the `X-Api-Key` header its prompt-log clients use. The Lambda auto-detects the
telemetry shape (by the `schema` tag) and writes each summary to its
`TELEMETRY_LOG_GROUP` CloudWatch log group (default `/claude-cmd-ui/telemetry`),
one stream per `host`. Retrieve them with `GET ?schema=telemetry.usage.v1&host=<host>`.

## Per-ticket cost correlation (TASK-142)

Separately from the live running total above, the ticket-driven [orchestrate
workflow](orchestrate-workflow.md) already keeps a per-ticket, per-activity cost
log (`activities` frontmatter field, one entry per `ba`/`code`/`test`/`review`/
`post-processing` phase — see [`lib/ticket-cost.js`](../lib/ticket-cost.js)).
This feature connects that log to the captured telemetry above so a ticket's
cost breakdown can include cache hits and, when the orchestrator itself did not
report token/cost numbers for an activity, a live-correlated figure read
straight from the receiver.

**How the correlation works:** each activity entry carries a
`startedAt`/`finishedAt` window (and, usually, a `model`). `lib/telemetry.js`'s
`usageForWindow(records, { startedAt, finishedAt, model })` sums every captured
`claude_code.api_request` row whose `timestamp` falls **inside that window,
inclusive of both bounds**; when a `model` is present on *both* the row and the
window their model **families** must also match — the model string with any
trailing dated build suffix (e.g. `-20251001` / `-2025-10-01`) stripped, so a
short dispatched label like `claude-haiku-4-5` correlates with the full dated
telemetry model string `claude-haiku-4-5-20251001` (the family is a tie-breaker,
never required when either side lacks one). `lib/telemetry-receiver.js#usageForWindow` runs this over
the receiver's **full** de-duplicated store (not just the capped "recent" feed),
and `main.js` exposes it as the `telemetry:usageForWindow` IPC channel
(`preload.js`'s `window.api.telemetry.usageForWindow`).

- `lib/ticket-cost.js#appendActivity` now also persists `cacheReadTokens` /
  `cacheCreationTokens` on an activity entry (same "write only when valid,
  otherwise leave absent" rule as `tokensIn`/`tokensOut`/`costUsd`), and
  `totalActivities` sums them the same way.
- The task modal's **Cost by activity** section shows a cache-hits fragment
  (`<cacheRead>/<cacheCreation> cache`) per row and in the totals row whenever
  cache data is present.
- When an activity entry has **no** persisted token/cost numbers of its own but
  the receiver holds rows inside its window, the modal calls
  `window.api.telemetry.usageForWindow` at click-time and appends the live-
  correlated usage (suffixed "(live)") to that row. Persisted values always take
  precedence over a live lookup.

**Best-effort, by design:**

- Telemetry is **off by default** and **resets on restart** (the receiver's store
  is in-memory only), so correlation for an older ticket, or with telemetry
  disabled, simply finds nothing — the row shows no cost/cache numbers rather
  than a fabricated zero or placeholder.
- Overlapping activity windows can double-count a row across activities; this is
  an accepted limitation (no de-duplication is done across activities).
- A row with a missing/unparseable `timestamp`, or a window with a missing/
  reversed `startedAt`/`finishedAt`, never matches.

## Configuration

Persisted in `.env` (see [`.env.example`](../.env.example)):

| Key | Meaning |
| --- | --- |
| `TELEMETRY_ENABLED` | `1` to capture telemetry on launch |
| `TELEMETRY_FORWARD_URL` | Destination for the JSON summary (any http(s) URL) |
| `TELEMETRY_FORWARD_ENABLED` | `1` to forward (only effective with a valid URL) |
| `TELEMETRY_FORWARD_TOKEN` | Optional Bearer token for the forward POST |
| `TELEMETRY_PORT` | Optional fixed receiver port (default: ephemeral) |

## Code map

- [`lib/telemetry.js`](../lib/telemetry.js) — pure, unit-tested model: config
  normalization, `buildOtelEnv`, OTLP/JSON extraction (`extractApiRequests`,
  `extractMetricSnapshot`), `aggregateUsage`, `usageForWindow` (per-ticket
  correlation), `buildForwardPayload`. No Electron, no I/O, never throws.
- [`lib/telemetry-receiver.js`](../lib/telemetry-receiver.js) — the loopback HTTP
  receiver. Log-derived rows are kept in `buckets`, a `Map<project, { store, recent }>`
  keyed by each row's own `project` field (empty/unknown → the `''` bucket) —
  `usageForProject`/`getUsageForProject` read one bucket, and `usage()` rolls up
  every bucket for the app-wide totals (TASK-154). `getUsage(project)` is
  legacy/no-arg-friendly: an explicit non-empty `project` reads just that
  bucket (equivalent to `getUsageForProject`); with no/empty `project` it
  instead reads the `activeProject` bucket, falling back to the app-wide
  roll-up only when `activeProject` is itself unset — it is **not** always an
  app-wide read (re-verified accurate, TASK-162). A parallel `globalRecent`
  array and the cumulative metric snapshot stay app-global. `snapshotState`
  (the payload pushed to the live-update callback) carries that project's
  `projectUsage` **and** its `projectRecent` — the same capped per-call rows
  `getUsage`/`getUsageForProject` return as `recent` — so the Stats tab's
  prompt log renders live off one payload. Also home to the
  live-update callback, the debounced forwarder, and `usageForWindow` (runs
  `lib/telemetry.js`'s helper over every bucket's full de-duplicated store).
  Loopback-only, POST-only, body-capped.
- [`lib/ticket-cost.js`](../lib/ticket-cost.js) — the per-ticket, per-activity
  cost log (`appendActivity`/`totalActivities`), extended with
  `cacheReadTokens`/`cacheCreationTokens`.
- [`lib/telemetry-project-config.js`](../lib/telemetry-project-config.js) — pure
  model for a per-project `storeOnline` switch, persisted at
  `<projectFolder>/tasks/telemetry-config.json`. The receiver-side gate is wired
  via the `telemetry:setProjectConfig` IPC channel (TASK-156); reading/writing the
  on-disk file and the Stats-tab UI toggle are wired by `buildTelemetryControl`'s
  "This project" checkbox (TASK-157).
- `main.js` — boots the receiver from `.env` (injecting `host`/`username`),
  injects/clears the OTEL env, and exposes the `telemetry:*` IPC channels,
  including `telemetry:usageForWindow` and `telemetry:setActiveProject`. The
  `telemetry:getUsage` channel's response `usage` payload SHAPE intentionally
  differs by argument (TASK-166): a no-arg/falsy call returns
  `{ usage, metricTotals, running, recent }` (`receiver.getUsage()`), while a
  non-empty `project` arg returns `{ usage, recent }` only — no
  `metricTotals`/`running` (`receiver.getUsageForProject(project)`), since
  both are app-wide concepts that don't apply to a single project. Consumers
  must not read `metricTotals`/`running` off a project-scoped result.
- `renderer/renderer.js` — the **Stats** sub-tab (`initStatsTab`), rescoped per
  project (TASK-157): it mounts the **Usage & telemetry** section
  (`buildTelemetryControl`), whose capture toggle and forward URL/token/master
  switch stay app-global but whose totals grid, per-model breakdown, prompt log
  (`renderLog` + the `telUpTokens`/`telDownTokens`/`telShortModel`/`telFmtTime`/
  `telRowTitle` display helpers), and "store online for this project" checkbox
  are scoped to the tab's `folder`;
  plus the task modal's **Cost by activity** section
  (`ticketActivityLines`/`ticketActivityTotalLine`, live-correlated via
  `window.api.telemetry.usageForWindow`), and `activateTab` which reports the
  focused folder to the receiver via `window.api.telemetry.setActiveProject`.

## Security & privacy notes

- The receiver binds **127.0.0.1 only**, accepts **POST only**, caps the request
  body, and never echoes request contents. It is a sink for the local `claude`
  process, not a public endpoint.
- **Per-project bucket count AND per-project forwarding-toggle count are
  capped** (`MAX_PROJECT_BUCKETS`/`MAX_PROJECT_FORWARDING`, 100 each,
  LRU-evicted via the shared `touchLruMap` helper used by
  `lib/telemetry-receiver.js`'s `ensureBucket` and `setProjectForwarding`) —
  this closes TWO growth vectors: a buggy/hostile local process posting many
  distinct fake `project` tags on OTLP rows (`buckets`, TASK-163), and many
  distinct `telemetry:setProjectConfig` calls from the renderer IPC surface
  (`projectForwarding`, TASK-165). This is still a **partial** mitigation: the
  global de-dup `seenKeys` set and each surviving bucket's own row `store` are
  not yet capped, so a client driving many distinct `request_id` values
  (rather than many distinct projects) can still grow the receiver's memory
  unboundedly. Bounding those is tracked as separate follow-up work (TASK-171),
  not yet done.
- Telemetry is **off by default**. No usage data is captured or forwarded until
  you enable it.
- Content redaction: this feature captures **counts and cost only** — it does not
  enable Claude Code's prompt/tool-content logging env vars (`OTEL_LOG_*`), so
  prompt and tool contents are not exported.

## Edge cases and limitations

- **New terminals only.** Toggling telemetry affects terminals started *after* the
  change; restart the AI terminal to begin/stop capturing.
- **Arbitrary URLs are for the forward hop only.** `claude` itself cannot post to a
  non-OTLP URL; if you want `claude` to export directly to your own observability
  backend, point it at an OTLP-compatible endpoint instead (not covered by this
  UI).
- **App-global receiver, per-project figures.** There is one capture receiver and
  one master forward destination (URL/token/switch) for the whole app, but the
  figures shown on the Stats sub-tab are scoped to the focused project: each
  workspace tab sees its own totals, per-model breakdown, and live feed, not a
  shared app-wide number (TASK-157). Forwarding likewise fans out one payload per
  project bucket, each still gated by that project's own opt-in (TASK-156).
