---
id: TASK-142
title: Task cost breakdown
status: done
created: 2026-07-26T04:52:36.392Z
updated: 2026-07-26T06:36:27.841Z
activities: [{"activity":"ba","model":"claude-opus-4-8","startedAt":"2026-07-26T04:53:53.801Z","finishedAt":"2026-07-26T05:00:44.880Z","durationMs":411079},{"activity":"code","model":"claude-sonnet-5","startedAt":"2026-07-26T05:03:02.997Z","finishedAt":"2026-07-26T05:12:06.938Z","durationMs":543941},{"activity":"test","model":"claude-haiku-4-5","startedAt":"2026-07-26T06:17:40.100Z","finishedAt":"2026-07-26T06:24:53.460Z","durationMs":433360},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-26T06:27:33.551Z","finishedAt":"2026-07-26T06:30:33.655Z","durationMs":180104},{"activity":"post-processing","model":"claude-opus-4-8","startedAt":"2026-07-26T06:32:40.000Z","finishedAt":"2026-07-26T06:34:25.724Z","durationMs":105724}]
---

## Description

Today the ticket-driven workflow already records a per-activity cost log on each
ticket: the orchestrator appends entries to the flat `activities` frontmatter
field (a one-line JSON array) via `lib/ticket-cost.js`, and the task modal shows a
read-only "Cost by activity" breakdown when a ticket is clicked (TASK-070). In
parallel, the app now captures Claude Code's built-in OpenTelemetry — one
`claude_code.api_request` row per API call, carrying `model`, input/output tokens,
**cache-read / cache-creation tokens**, `cost_usd`, `duration_ms`, `request_id`
and `session.id` — into the in-memory receiver (`lib/telemetry-receiver.js`,
modelled by `lib/telemetry.js`).

This ticket connects those two things so the OTEL telemetry actually populates the
per-ticket cost breakdown, and closes the two gaps versus the request "store the
model used, cost, cache hits, everything you can, and let me see it on click":

1. **Cache hits are not captured today.** `appendActivity`, `totalActivities`,
   and the renderer display helpers only handle `tokensIn` / `tokensOut` /
   `costUsd` — the cache-read and cache-creation token counts (the "cache hits")
   are dropped. They must be persisted per activity and shown on click.
2. **Telemetry is never correlated to a ticket.** Telemetry rows are keyed by
   `session.id` + `timestamp`, never by ticket id, so there is currently no way to
   attribute captured usage to a ticket's work. We add a **pure, time-window
   correlation helper** that, given the captured api_request rows and one
   activity's `{ startedAt, finishedAt, model }` window, sums the usage
   (tokens, cache tokens, cost) belonging to that activity. This lets the
   orchestrator record real telemetry numbers into `activities`, and lets the
   modal live-correlate and display usage for any activity whose numbers were not
   persisted, straight from the receiver.

**Correlation approach (confirmed with the user — see Clarifications):** an
api_request row belongs to an activity when its `timestamp` falls inside the
activity's `[startedAt, finishedAt]` window (inclusive bounds); when a `model` is
present on both the row and the activity, it must also match (model is a
tie-breaker, never a requirement when absent). Time + model are the only signals
available without adding per-subagent `session.id` capture. Telemetry is
app-global, off by default, and resets on app restart, so correlation is
best-effort: when no rows match, the activity simply shows no telemetry-derived
numbers (never a fabricated `0`).

Scope is additive and backward-compatible: existing `activities`, `runs`,
single-field accounting (`startedAt`/`finishedAt`/`tokens`/`costUsd`), and the
one-line-JSON round-trip contract are all preserved. The app must **never** write
ticket files itself (only the orchestrator edits ticket frontmatter); the app's
job here is the pure correlation model, the IPC to query it, and the click-time
display.

## Acceptance Criteria

- [ ] A new pure function `usageForWindow(records, window)` is added to
      `lib/telemetry.js` and exported in `module.exports`. It takes an array of
      api_request rows (as produced by `extractApiRequests`) and a
      `{ startedAt, finishedAt, model }` window, and returns a totals object of the
      same shape as `emptyTotals()` (`requests`, `inputTokens`, `outputTokens`,
      `cacheReadTokens`, `cacheCreationTokens`, `totalTokens`, `costUsd`,
      `durationMs`).
- [ ] `usageForWindow` includes a row only when its `timestamp` parses to a time
      `>= startedAt` and `<= finishedAt`; rows outside the window, rows with a
      missing/unparseable `timestamp`, and (when both sides carry a non-empty
      `model`) rows whose model differs from the window's model are excluded.
- [ ] When `window.model` is empty/absent, `usageForWindow` applies no model
      filter (time window only); when a row has an empty/absent `model`, the model
      filter never excludes it.
- [ ] `usageForWindow` returns `emptyTotals()` (all zeroes, never NaN, never
      throwing) when `records` is not a non-empty array, when the window is
      null/junk, or when `startedAt`/`finishedAt` are missing or `finishedAt`
      precedes `startedAt` — matching the "tolerant of junk, never throws" contract
      of the rest of `lib/telemetry.js`.
- [ ] `lib/ticket-cost.js#appendActivity` persists `cacheReadTokens` and
      `cacheCreationTokens` on an activity entry, each written **only** when it
      passes `isValidAmount` (finite number `>= 0`; `0` is a valid recorded value),
      and left absent otherwise — identical to the existing `tokensIn` / `tokensOut`
      / `costUsd` gating.
- [ ] `lib/ticket-cost.js#totalActivities` sums `cacheReadTokens` and
      `cacheCreationTokens` across the activity array using the same null-when-no-
      entry-carried-it rule already used for the other fields (a total is `null`,
      never a fabricated `0`, when no entry supplied that field).
- [ ] The extended `activities` entries still round-trip byte-safe through the
      board serializer: the value remains a single-line `JSON.stringify` array with
      no newlines, and the single-field accounting and `runs` log are untouched.
- [ ] `main.js` exposes an IPC channel `telemetry:usageForWindow` that accepts a
      `{ startedAt, finishedAt, model }` argument and returns
      `{ ok: true, usage }` where `usage` is `usageForWindow` applied over the
      receiver's captured rows; when no receiver exists it returns
      `{ ok: true, usage: null }` (mirroring the existing `telemetry:getUsage`
      guard) and never throws.
- [ ] `lib/telemetry-receiver.js` exposes a method (e.g. `usageForWindow(window)`)
      that runs `tel.usageForWindow` over its full de-duplicated store (not just the
      capped `recent` feed), so the IPC sees all captured rows for the session.
- [ ] `preload.js` exposes `usageForWindow` on the `telemetry` bridge alongside the
      existing `getState`/`getUsage`/`setConfig`/`clear` methods.
- [ ] The task modal's "Cost by activity" section (`.task-modal-cost`) shows cache
      hits: each activity row and the totals row include a cache-tokens fragment
      (e.g. `<cacheRead>/<cacheCreation> cache`) whenever cache data is present,
      dropping the fragment when absent — via the browser mirrors
      `ticketActivityLines`, `ticketActivityTotalLine`, and `totalTicketActivities`
      in `renderer/renderer.js`, kept in sync with `lib/ticket-cost.js`.
- [ ] When an activity entry has no persisted token/cost numbers but the receiver
      holds rows in that activity's window, the modal displays the live-correlated
      usage (tokens, cache hits, cost) for that activity by calling
      `window.api.telemetry.usageForWindow`; persisted values always take
      precedence over live-correlated ones, and a failed/empty IPC result leaves the
      row showing only the fragments it already had (no error, no fabricated zeroes).
- [ ] When no telemetry data is available (telemetry off, receiver absent, or no
      rows in window), the ticket renders normally with **no** cost/cache numbers
      for that activity — never a fabricated `0` or placeholder.
- [ ] `.claude/skills/orchestrate/SKILL.md` and `assets/skills/orchestrate/SKILL.md`
      are updated **byte-for-byte identically** to instruct the orchestrator to
      record `cacheReadTokens` / `cacheCreationTokens` (cache hits) alongside the
      existing model/timestamps/tokens/cost in each `activities` entry, sourced from
      the ticket's build telemetry, and to never fabricate a figure when telemetry
      is off or no rows matched.
- [ ] `docs/telemetry.md` documents the per-ticket correlation: how activity
      windows map to captured api_request rows, that cache hits are now recorded,
      and that correlation is best-effort (off-by-default, resets on restart).
- [ ] All existing tests still pass and new `node --test` coverage is added; no new
      npm dependency is introduced and no lib module requires Electron.

## Cucumber Tests

```gherkin
Feature: Store and view the OTEL telemetry cost breakdown per ticket

  Background:
    Given the pure telemetry model in lib/telemetry.js
    And the pure per-activity cost log in lib/ticket-cost.js
    And all I/O, IPC and the telemetry receiver are mocked (no real network, disk or DB)

  Scenario: Correlate api_request rows to an activity by time window
    Given three api_request rows at 04:15:00Z, 04:16:00Z and 05:00:00Z
    And an activity window from 04:14:00Z to 04:20:00Z with no model
    When I call usageForWindow(rows, window)
    Then only the 04:15:00Z and 04:16:00Z rows are summed
    And the returned totals carry their combined input, output, cacheRead, cacheCreation, cost and duration
    And totalTokens equals input + output + cacheRead + cacheCreation

  Scenario: Model acts as a tie-breaker only when present on both sides
    Given two rows inside the window, one model "claude-sonnet" and one model "claude-haiku"
    And an activity window whose model is "claude-haiku"
    When I call usageForWindow(rows, window)
    Then only the "claude-haiku" row is summed
    And a row with an empty model inside the same window is still included

  Scenario: appendActivity persists cache hits when valid
    Given a ticket frontmatter object with no activities
    When appendActivity is called with cacheReadTokens 28905 and cacheCreationTokens 0
    Then the stored activities entry carries cacheReadTokens 28905 and cacheCreationTokens 0
    And the activities field is a single-line JSON array with no newline characters
    And the ticket's runs log and single-field accounting are unchanged

  Scenario: totalActivities sums cache hits across entries
    Given an activities array with two entries carrying cacheReadTokens 100 and 250
    When totalActivities is called
    Then the returned cacheReadTokens total is 350
    And a field that no entry carried is reported as null, not 0

  Scenario: The modal shows cache hits on click for a ticket with persisted numbers
    Given a ticket whose activities carry model, tokens, cache hits and cost
    When the task modal is opened for that ticket
    Then the "Cost by activity" section lists each activity with its cache-hits fragment
    And the totals row includes the summed cache hits

  Scenario: The modal live-correlates telemetry for activities without persisted numbers
    Given a ticket whose activities carry only model and start/finish timestamps
    And the mocked telemetry.usageForWindow returns usage for those windows
    When the task modal is opened
    Then each activity row shows the live-correlated tokens, cache hits and cost
    And a persisted value on any activity takes precedence over the live-correlated one

  Scenario: The two SKILL.md copies stay byte-identical after the cache-hit instruction is added
    Given .claude/skills/orchestrate/SKILL.md and assets/skills/orchestrate/SKILL.md
    When the drift-guard test compares them
    Then they are byte-for-byte identical

  Scenario: Junk input and telemetry-off never break the breakdown
    Given usageForWindow is called with null records, a reversed window, and rows with unparseable timestamps
    Then it returns all-zero totals and never throws
    And when telemetry.usageForWindow IPC returns { usage: null }
    Then the modal leaves each activity row showing only its already-present fragments with no error and no fabricated zeroes
```

## Edge & Failure Cases

- `usageForWindow` with `records` null / not-an-array / containing non-object or
  malformed rows → treat bad rows as contributing nothing; never throw.
- Window with missing `startedAt` or `finishedAt`, non-date strings, or
  `finishedAt` before `startedAt` → return `emptyTotals()` (no matches).
- Rows with a missing or unparseable `timestamp` are never matched to any window.
- Boundary rows exactly at `startedAt` or `finishedAt` are included (inclusive
  bounds) — test both boundaries.
- Model comparison must be exact-string after trim; empty model on either side
  disables the model filter (never excludes).
- `appendActivity` with `cacheReadTokens`/`cacheCreationTokens` = `0` records `0`
  (valid, distinct from absent); with `NaN`/negative/`''`/`null`/`undefined`
  leaves the field absent (via `isValidAmount`).
- Cache fields added to an entry must not break the existing one-line-JSON
  round-trip, key ordering (`orderFm`), or backward-compat parsing of older
  entries that lack them.
- Telemetry disabled or receiver absent → `telemetry:usageForWindow` returns
  `{ ok: true, usage: null }`; the renderer must render the ticket normally with no
  live numbers and no thrown error.
- Telemetry reset (`telemetry:clear`) mid-run or app restart → previously captured
  rows are gone; live correlation for old activities simply yields no numbers.
- Overlapping activity windows (e.g. concurrent swarm builds) may double-count a
  row across activities — note this limitation; do not attempt de-duplication
  across activities in this ticket.
- Corrupt/hand-edited `activities` JSON must still render (parse to `[]`), matching
  the existing tolerant parsers.

## Relevant Files & Context

- `lib/telemetry.js` — add the pure `usageForWindow` here and export it. Reuse
  `emptyTotals()` + `addRecordInto()` for the sum, `str()`/`num()`/`isPlainObject()`
  for coercion, and follow the "pure, never throws, junk collapses to a safe value"
  contract used by `aggregateUsage`. Rows already carry `timestamp`, `model`, and
  cache fields from `extractApiRequests`.
- `lib/ticket-cost.js` — extend `appendActivity` (persist
  `cacheReadTokens`/`cacheCreationTokens` via the same `isValidAmount` gate used for
  `tokensIn`/`tokensOut`/`costUsd`) and `totalActivities` (sum them with the
  null-when-absent rule). Preserve `orderFm`, the one-line `serializeActivities`, and
  the additive contract in the file header. Do **not** change `parseActivities`'
  tolerance behaviour.
- `lib/telemetry-receiver.js` — add a `usageForWindow` method that runs
  `tel.usageForWindow(Array.from(store.values()), window)` over the full
  de-duplicated `store` (not the capped `recent`); expose it on the returned object
  next to `getUsage`/`getState`. Keep it Electron-free.
- `main.js` — register `ipcMain.handle('telemetry:usageForWindow', …)` right beside
  the existing `telemetry:getUsage` handler (around lines 542–548), following the
  same `if (!telemetryReceiver) return { ok: true, usage: null }` guard and
  `{ ok: true, usage }` shape.
- `preload.js` — add
  `usageForWindow: (w) => ipcRenderer.invoke('telemetry:usageForWindow', w)` to the
  `telemetry` bridge object (around lines 172–186), matching the existing method
  style.
- `renderer/renderer.js` — update the browser mirrors of the cost helpers:
  `totalTicketActivities` (~line 6669), `ticketActivityLines` (~6703), and
  `ticketActivityTotalLine` (~6725) to include a cache-hits fragment; and the modal
  `fill()`'s `.task-modal-cost` block (~9827–9840) to render cache hits and to
  live-correlate via `window.api.telemetry.usageForWindow` for activities lacking
  persisted numbers. Reuse `formatTokens` (~6574) and `formatCostUsd` (~6565). Keep
  these mirrors byte-behaviour-in-sync with `lib/ticket-cost.js`.
- `.claude/skills/orchestrate/SKILL.md` and `assets/skills/orchestrate/SKILL.md` —
  update the "Per-activity cost log" bullet (SKILL.md ~lines 574–582) in **both**
  files byte-for-byte identically to add cache-hit recording. The drift guard is
  enforced by `test/orchestrate-agents.test.js` (~line 354) and
  `test/orchestrate-swarm.test.js` (~line 190).
- `docs/telemetry.md` — document the per-ticket correlation and best-effort nature.
- Tests to extend / add, all `node --test`, all I/O mocked, no `cucumber` package:
  `test/telemetry.test.js` (unit cases for `usageForWindow`; reuse the
  `apiRequestLogs` fixture builder at the top of the file),
  `test/ticket-cost.test.js` and `test/ticket-cost.e2e.test.js` (cache-hit
  persistence + totals + round-trip), and `test/telemetry-receiver.e2e.test.js` (the
  new receiver method over a real loopback ingest). Follow the existing
  Given/When/Then scenario-style `test(...)` naming already used in these files.

## Clarifications

- **Q (correlation signal): match telemetry to a ticket by activity time-window (+model tie-breaker), or capture each sub-agent's session.id for exact attribution?**
  A: Time-window + model. No new capture plumbing; correlation is best-effort. Accepted limitation: overlapping concurrent builds may double-count a row across activities.
- **Q (persist vs live): the app can't write ticket files — how are numbers stored/shown?**
  A: Orchestrator writes the numbers into `activities` during a run; the app additionally live-correlates and shows numbers on click for any activity not yet persisted. Persisted values take precedence.
- **Q (telemetry-off / historical tickets): what shows when no telemetry data is available?**
  A: Show nothing — never a fabricated `0` or placeholder. The section renders normally but with no numbers for that activity.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
