# Per-activity ticket cost log

## What it does and why

The orchestrate workflow drives each ticket through several phases run by
different subagents on possibly-different models: business-analyst, coder, tester,
tech-lead reviewer, and a post-processing step. The existing single-field
accounting ([`lib/ticket-accounting.js`](../lib/ticket-accounting.js)) only records
the **latest** build's `startedAt` / `finishedAt` / `tokens` / `costUsd`, so it
cannot show *where* a ticket's time and cost went.

This feature keeps a finer-grained **log broken down by the activity that produced
the work**. Each time the orchestrator (never a subagent) dispatches a phase, it
appends one entry recording the activity, the model dispatched, the timing, and —
only when the run actually reported them — the tokens and cost. The ticket
accumulates a complete cost view over its lifetime, surfaced as a per-activity +
totals **"cost view"** in the ticket modal. This was added in TASK-070.

It is **additive**: the single-field accounting (`startedAt` / `finishedAt` /
`tokens` / `costUsd`) and the per-run log (`lib/ticket-runs.js`) are left intact
for backward compatibility.

## How it works

- **Pure helper** — [`lib/ticket-cost.js`](../lib/ticket-cost.js) parses,
  serializes, appends to, and totals the activity log. It is Electron-free and
  requires nothing from Electron, so it is unit-testable with plain `node --test`.
  It reuses `orderFm` / `toIso` / `isValidAmount` from
  [`lib/ticket-accounting.js`](../lib/ticket-accounting.js) so key ordering and
  value-validity rules stay identical across the accounting helpers.
- **Renderer mirror + cost view** — the renderer cannot `require()` Node modules,
  so it keeps read-only mirrors (`parseTicketActivities`, `totalTicketActivities`,
  `ticketActivityLines`, `ticketActivityTotalLine`) in
  [`renderer/renderer.js`](../renderer/renderer.js) around lines 5426-5528, and
  renders the `.task-modal-cost` block in the ticket modal
  (`renderer/renderer.js:6090-6118`).
- **Orchestrator wiring** — the orchestrate skill instructs the orchestrator to
  append one entry per phase (see
  [`.claude/skills/orchestrate/SKILL.md`](../.claude/skills/orchestrate/SKILL.md),
  the "Per-activity cost log" bullet in *State-consistency rules*).

### Storage

The log lives in a **single flat frontmatter field, `activities`**, holding a
JSON-encoded array on **one line** — the exact pattern proven by the `runs` log.
The board's `parseTicketFrontmatter` takes everything after the first `:` on a line
as an opaque string value and `serializeTicket` writes it back verbatim, so a
one-line JSON array round-trips untouched through whole-file writes and board polls
without any nested YAML the flat parser could not read. `JSON.stringify` emits no
newlines, keeping the value on a single line.

### An activity entry

Each entry is a plain object. Only fields with valid data are present:

```json
{
  "activity": "code",
  "model": "claude-opus-4-8",
  "startedAt": "2026-07-19T04:00:00.000Z",
  "finishedAt": "2026-07-19T04:04:30.000Z",
  "durationMs": 270000,
  "tokensIn": 20000,
  "tokensOut": 5000,
  "costUsd": 0.42
}
```

Stored on the ticket as one flat frontmatter line:

```
activities: [{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-19T04:00:00.000Z","finishedAt":"2026-07-19T04:04:30.000Z","durationMs":270000,"tokensIn":20000,"tokensOut":5000,"costUsd":0.42}]
```

## Inputs / outputs (API reference)

`lib/ticket-cost.js` exports:

| Export | Signature / value | Description |
|--------|-------------------|-------------|
| `ACTIVITIES_KEY` | `'activities'` | The flat frontmatter field the log is stored under. |
| `KNOWN_ACTIVITIES` | `['ba','code','test','review','post-processing']` | The activity types the orchestrator's phases map onto. **Open-ended** — unknown activity strings are stored and displayed as-is; these values only aid display ordering/labels. |
| `appendActivity(fm, opts)` | `→ fm'` | Append one entry; returns a new frontmatter object (input not mutated). |
| `parseActivities(fm)` | `→ Array<entry>` | Parse the log off a frontmatter object; tolerant of bad input. |
| `serializeActivities(activities)` | `→ string` | Serialize an entry array to the one-line JSON string. |
| `totalActivities(activities)` | `→ { durationMs, tokensIn, tokensOut, costUsd }` | Sum each field across the log; a field is `null` when no entry carried it. |
| `computeDurationMs(startedAt, finishedAt)` | `→ number \| null` | Wall-clock ms between two stamps, or `null` when missing/invalid/reversed. |

### `appendActivity(fm, opts)`

```js
const cost = require('./lib/ticket-cost');

const fm2 = cost.appendActivity(fm, {
  activity: 'code',            // REQUIRED non-empty string
  model: 'claude-opus-4-8',    // recorded when a non-empty string
  startedAt: '2026-07-19T04:00:00Z',
  finishedAt: '2026-07-19T04:04:30Z',
  // durationMs omitted -> computed from the start/finish pair
  tokensIn: 20000,
  tokensOut: 5000,
  costUsd: 0.42,
});
```

Field rules:

- **`activity`** is a **required** non-empty string. A missing/blank activity
  **rejects** the entry — the frontmatter is returned unchanged apart from key
  ordering, never half-written.
- **`model`** is recorded when a non-empty string is supplied.
- **`startedAt` / `finishedAt`** accept a `Date`, ISO-8601 string, or epoch-ms and
  are normalised to ISO-8601 via `toIso` when present.
- **`durationMs`** is used as supplied when it is a valid amount; otherwise it is
  **computed** from the `startedAt`/`finishedAt` pair, and **omitted** (never
  fabricated) when that pair is missing, invalid, or reversed.
- **`tokensIn` / `tokensOut` / `costUsd`** are written **only** when they pass
  `isValidAmount` — a finite number `>= 0`. Missing / `NaN` / negative / `''`
  values leave the field absent. Note `isValidAmount(0)` is `true` — a recorded
  `0` is valid and distinct from "absent".
- Existing entries are preserved in order; the new entry is appended **last**
  (chronological). A malformed/absent `activities` field is treated as empty.
- Returns a **new** frontmatter object; keys are ordered `id, title, status,
  created, updated` first, then everything else.

### `totalActivities(activities)`

```js
const totals = cost.totalActivities(cost.parseActivities(fm));
// -> { durationMs, tokensIn, tokensOut, costUsd }
// Each field is null if NO entry carried it (never a fabricated 0, never NaN).
```

## The cost view (ticket modal)

The renderer renders a read-only breakdown in the `.task-modal-cost` block
(`renderer/renderer.js:6090-6118`), hidden entirely when the ticket carries no
activity data:

- A `Cost by activity (N)` label.
- One `.task-modal-cost-row` per activity — `activity · model · duration ·
  in↑/out↓ tok · cost` — with any absent fragment dropped.
- A `.task-modal-cost-total` row from `ticketActivityTotalLine`, e.g.
  `Total: 6m 12s · 20k↑/5k↓ tok · $0.42`, dropping absent fragments and shown only
  when the log carries summable data.

## Configuration / constants

There is **no** environment variable or user setting. The two constants are code:

```js
const ACTIVITIES_KEY   = 'activities';                              // lib/ticket-cost.js
const KNOWN_ACTIVITIES = ['ba', 'code', 'test', 'review', 'post-processing'];
```

`KNOWN_ACTIVITIES` is **not** a whitelist — an unrecognised activity string is
stored and displayed verbatim; the list only aids display ordering/labels.

## Edge cases & limitations

- **Never fabricates figures.** Tokens and cost are written only when actually
  reported and valid (`isValidAmount`); an unreported cost leaves the field absent
  rather than writing `0`.
- **`0` is a valid amount** and is distinct from "absent" (`isValidAmount(0)` is
  `true`).
- **Duration is computed only from a valid, non-reversed pair.** A missing,
  unparseable, or end-before-start `startedAt`/`finishedAt` yields no `durationMs`.
- **Corrupt / hand-edited logs are tolerated.** `parseActivities` returns a clean
  array — an absent field, a non-string field, invalid JSON, a non-array payload,
  or non-object array members all yield `[]` (bad members filtered), so a corrupt
  ticket never throws while rendering.
- **A blank `activity` rejects the whole entry** rather than writing a partial one.
- **Totals never over-report.** A category with no contributing entry is reported
  as `null` (rendered as absent), never as a fabricated `0`, and no total is ever
  `NaN`.
- **Additive, not a replacement.** The single-field `startedAt`/`finishedAt`/
  `tokens`/`costUsd` accounting and the `runs` log are untouched and continue to
  render alongside the cost view.
- **Orchestrator writes it, not subagents.** Only the orchestrator appends
  entries, as part of the normal whole-file write with `updated` bumped.

## Tests

```bash
node --test test/ticket-cost.test.js test/ticket-cost.e2e.test.js
```
