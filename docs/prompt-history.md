# Prompt history & cloud sync

## What it does and why

Every prompt sent to the agent — typed manually, dispatched from the queue, or
received from Slack — is recorded per project with a timestamp and a source tag,
so you have a durable log of what you asked and roughly what it cost. An optional
cloud sync can repopulate that log from an AWS Lambda-backed store.

## How it works

- **Storage** — history is a JSON array at
  `<project>/.claude-logs/logs/prompt_history.json`. The main process
  ([`main.js`](../main.js)) owns read/write via `readPromptHistory` /
  `writePromptHistory` (atomic `.tmp`-then-rename). Each entry is normalized to
  `{ ts, source, prompt }`, where `source` is `user` / `queue` / `slack` and `ts`
  defaults to `new Date().toISOString()`.
- **Cost/token: real when captured, estimate otherwise (renderer, TASK-195)** —
  the **Logs** panel in [`renderer/renderer.js`](../renderer/renderer.js)
  correlates each stored prompt against the app's OTEL telemetry (see
  [`telemetry.md`](telemetry.md)): a prompt's sequence window is
  `[entry.ts, nextEntry.ts)` (the newest entry's window extends to "now"),
  scoped to that prompt's OWN project bucket only (a different,
  concurrently-running project's calls are never folded in), and summed
  across every model that sequence used
  (`window.api.telemetry.usageForWindowInProject`, backed by
  `lib/telemetry-receiver.js#usageForWindowInProject` →
  `lib/telemetry.js#usageForWindow`). When telemetry rows exist for that
  window, the row shows the REAL total tokens up/down and cost of the whole
  `claude_code.api_request` sequence the prompt triggered; the computed totals
  (`inputTokens`, `outputTokens`, `costUsd`) are written back onto that entry
  in `prompt_history.json` via `writePromptHistory`/`prompts:write` (only once
  the window is bounded by a following entry, so an in-flight prompt is not
  frozen prematurely), so a reload re-displays them without re-correlating.
  When no telemetry rows fall in the window (telemetry was off, or the prompt
  is from an earlier app run), the entry falls back to the old estimate:
  tokens as `ceil(length / 4)` (`estimateTokens`), cost as
  `input * $3/M + output * $15/M` (`estimateCostUsd`, constants
  `COST_PER_M_INPUT = 3.00`, `COST_PER_M_OUTPUT = 15.00` — Claude Sonnet rates).
  Entries awaiting a reply show "awaiting response."
- **Cloud sync** — [`lib/cloud-logs.js`](../lib/cloud-logs.js) is a thin HTTP
  client for the prompt-logs Lambda. `syncFromCloud` performs a `GET` and
  overwrites the local file with the returned entries. Config is read fresh on
  every call (so you can flip env vars without restarting). The Lambda source is
  in [`lambda/prompt-logs/index.mjs`](../lambda/prompt-logs/index.mjs).

## Usage

From the UI: open the **Logs** panel to view history; **Refresh** re-reads the
file, **Clear** wipes it (with confirmation). Bridge calls
(see [`ipc-bridge.md`](ipc-bridge.md)):

```js
// read the current project's history
const { entries } = await window.api.prompts.read(cwd);

// append a manually-typed prompt
await window.api.prompts.append(cwd, { source: 'user', prompt: 'refactor the parser' });

// pull history down from the cloud store (overwrites local file)
const res = await window.api.prompts.syncFromCloud(cwd);   // { ok, count } | { ok:false, error }

// wipe history
await window.api.prompts.clear(cwd);
```

Deploy/operate the optional Lambda (see [`configuration.md`](configuration.md)
for the client env vars):

- `GET  {endpoint}?username=…&project=…` → `{ ok: true, entries: [...] }`
- `POST {endpoint}` with `{ username, project, entry }` → appends one event

## Configuration

Client side ([`lib/cloud-logs.js`](../lib/cloud-logs.js)):

| Variable | Default | Purpose |
|----------|---------|---------|
| `CLOUD_LOG_ENDPOINT` | (unset → cloud sync disabled) | Full Lambda URL (Function URL or API Gateway) |
| `CLOUD_LOG_API_KEY` | (none) | Optional shared secret, sent as `X-Api-Key` |
| `CLOUD_LOG_USERNAME` | OS username | Username tag for log events |

Cloud sync is **disabled** unless `CLOUD_LOG_ENDPOINT` is set (`isEnabled()`).
The project name is derived from the folder basename (`projectFromCwd`).

Lambda side ([`lambda/prompt-logs/index.mjs`](../lambda/prompt-logs/index.mjs)):

| Variable | Default | Purpose |
|----------|---------|---------|
| `LOG_GROUP` | `/claude-cmd-ui/prompts` | Prompt-log CloudWatch log group |
| `TELEMETRY_LOG_GROUP` | `/claude-cmd-ui/telemetry` | OTEL usage/cost CloudWatch log group |
| `AWS_REGION` | (set by Lambda) | Region |
| `API_KEY` | (none) | Optional shared secret; prompt-log clients send `X-Api-Key`, the telemetry forwarder sends `Authorization: Bearer` |

The same endpoint also accepts the app's **OTEL usage/cost telemetry** — see
[`telemetry.md`](telemetry.md#storing-it-online-optional). The POST route
auto-detects a `telemetry.usage.v1` payload (by its `schema` tag) and stores it
in `TELEMETRY_LOG_GROUP`, one stream per host; a prompt-log POST (`{ username,
project, entry }`) is unchanged.

## Inputs / outputs

- **Entry shape:** `{ ts: ISO8601, source: 'user'|'queue'|'slack', prompt: string }`.
- **On disk:** `<project>/.claude-logs/logs/prompt_history.json` (a JSON array).
- **Lambda stream:** one CloudWatch log stream per `username__project`.

## Edge cases, limitations & troubleshooting

- **Missing file** — `prompts:read` on a project with no history returns
  `{ ok: true, entries: [] }`; a missing file is not an error.
- **`cwd` required** — `append`/`write`/`clear`/`syncFromCloud` throw without a
  `cwd`; `read` with no `cwd` returns empty.
- **`syncFromCloud` overwrites** the local file with the cloud copy — it is a
  pull, not a merge.
- **Cloud disabled** — with `CLOUD_LOG_ENDPOINT` unset, `syncFromCloud` returns
  `{ ok: false, error: 'cloud logs disabled' }`.
- **Cost is an estimate ONLY as a fallback** — when no telemetry rows fall
  inside a prompt's window (telemetry off, or the prompt predates the current
  app run), the `length/4` token heuristic and Sonnet pricing are used and are
  approximate, for at-a-glance budgeting only; otherwise the row shows the
  real captured tokens/cost (see above).
- **Malformed/partial telemetry rows** — a row with a missing/NaN `cost_usd`
  or token field contributes 0 to a prompt's real total rather than producing
  `NaN` (the underlying `usageForWindow` is tolerant by design); the panel
  never throws.
