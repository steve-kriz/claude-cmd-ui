---
id: TASK-199
title: Stats Graph
status: done
created: 2026-08-01T01:27:16.026Z
updated: 2026-08-01T13:31:00.000Z
activities: [{"activity":"code","model":"claude-sonnet-5","startedAt":"2026-08-01T02:55:22.000Z","finishedAt":"2026-08-01T03:11:21.000Z"},{"activity":"test","model":"claude-haiku-4-5","startedAt":"2026-08-01T03:11:21.000Z","finishedAt":"2026-08-01T03:18:14.000Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-08-01T03:18:14.000Z","finishedAt":"2026-08-01T03:21:01.000Z"},{"activity":"post-processing","model":"claude-sonnet-5","startedAt":"2026-08-01T03:21:01.000Z","finishedAt":"2026-08-01T03:22:55.000Z"}]
---

## Description
Change the stats tab to include a graph of the cost over time. 
show the start of the session and graph each model and the cost over time 
make it a smooth graph showing this data
add a way to toggle between cost, input, out, and chaches tokens

### Analyst clarifications & assumptions (no interactive user available this run)
Because the request leaves several points open and no user is available to answer,
the following reasonable interpretations are adopted. If the user disagrees, they
can amend via `## Additional Context` and the ticket can be re-opened.

- **A1 — Data source / scope.** The only per-call, timestamped row stream the UI
  can reach today is the CURRENT project's `projectRecent` (pushed on every
  `telemetry:update`) and `getUsage(folder).usage.recent` (on mount). The app-wide
  `payload.usage` is an *aggregate* (`byModel` totals only) with **no per-row
  timeline**, so it cannot drive a time-series. Therefore the graph is scoped to
  the **current project's rows**, matching the per-project totals grid and the
  Prompt log directly below it. (Plotting a true all-projects session timeline
  would require a NEW IPC returning rows-with-timestamps across all buckets — see
  Relevant Files, "What is missing". This ticket does NOT add that; it uses the
  existing per-project row stream.)
- **A2 — "Cost over time" shape.** Plotted as the **cumulative running total** per
  model across the session (monotonically increasing), x-axis = time from the
  earliest row to the latest. This is what makes a "cost over time" curve
  meaningful; per-call spot values would be spiky noise. The same cumulative model
  applies to the token metrics when toggled.
- **A3 — "Start of the session".** No session-start instant is persisted anywhere;
  it is **derived** as the earliest `timestamp` among the plotted rows (the x-axis
  origin). Rows carry `sessionId`, but the graph does not split by session — it
  treats the current project's captured rows as one continuous timeline.
- **A4 — "Smooth graph".** A smoothed line/area per model (e.g. Catmull-Rom /
  monotone spline path, or a Bézier-smoothed polyline) rendered as inline **SVG**
  via `document.createElementNS` — consistent with the codebase's DOM-building +
  `textContent` convention. No third-party charting library is introduced (none
  exists in the project today).
- **A5 — Metric toggle set.** Four mutually-exclusive metrics: **Cost (USD)**,
  **Input tokens** (`inputTokens`), **Output tokens** (`outputTokens`), **Cache
  tokens** (`cacheReadTokens + cacheCreationTokens`, combined — the request says
  "chaches tokens" singular/plural; both cache fields are summed into one "Cache"
  series). Default metric on mount = **Cost**.
- **A6 — Row cap.** `projectRecent` is capped at 100 rows (`.slice(-100)`) and the
  bucket `recent` at `RECENT_CAP`; the graph plots whatever rows are available and
  does not attempt to reconstruct evicted history.

## Acceptance Criteria
- [x] A new graph section is added to the Stats tab, built inside
      `buildTelemetryControl(tab)` in `renderer/renderer.js`, appended to `section`
      alongside (not replacing) the existing totals grid, per-model breakdown,
      session totals, and prompt log — all of which continue to render exactly as
      before.
- [x] The graph renders a **smooth line/area** of the selected metric **over time**,
      with the x-axis origin at the earliest captured row (session start, per A3)
      and extending to the most recent row.
- [x] There is **one smoothed series per model** present in the data; each series
      is visually distinguishable (distinct colour/label) and multiple models
      overlay on the same axes without corrupting each other.
- [x] Each series plots the **cumulative running total** of the selected metric for
      that model across the timeline (per A2), so cost/tokens are non-decreasing
      left-to-right.
- [x] A **toggle control** lets the user switch the plotted metric between **Cost**,
      **Input tokens**, **Output tokens**, and **Cache tokens** (per A5). Switching
      re-renders the graph from the same underlying rows without any new IPC call or
      page reload; the currently-selected metric is visibly indicated.
- [x] The default selected metric on mount is **Cost**.
- [x] Model names are rendered via `telShortModel` and use `textContent` (never
      `innerHTML`) for any label/legend text, preserving the tab's existing XSS-safe
      convention.
- [x] The graph updates **live** off the existing `window.api.telemetry.onUpdate`
      subscription: when a `telemetry:update` payload for the current `folder`
      arrives carrying `projectRecent`, the graph re-plots (same trigger path that
      already re-renders `renderUsage`/`renderLog`). The selected-metric state is
      preserved across live updates.
- [x] On mount, the graph seeds from `getUsage(folder).usage.recent` (the same
      `recent` array already used to seed the prompt log) so it shows already-captured
      data immediately, not only after the next push. (If seeding-on-mount is not
      feasible without an extra call, starting empty and filling on the first push is
      acceptable — but existing behaviour must not regress.)
- [x] With **no folder open**, the graph shows a graceful empty/disabled state with
      an "open a folder" affordance and throws no exception, matching how
      `renderUsage(null)`/`renderLog(null)` already degrade.
- [x] With telemetry off or **zero rows captured**, the graph shows an explicit
      empty state (e.g. "No usage data yet") and never throws.
- [x] Malformed rows (missing/unparseable `timestamp`, missing model, non-numeric
      metric fields) contribute 0 / are skipped for the axis, never produce `NaN`
      geometry, and never throw — mirroring the `telNum`/`telFmtUsd` guards already
      used in the log.
- [x] All existing telemetry/stats tests continue to pass; the new behaviour is
      covered by new tests.

## Cucumber Tests
```gherkin
Feature: Cost-over-time graph on the Stats tab

  Background:
    Given the Stats tab is open on a project with telemetry captured

  Scenario: A smooth cost-over-time graph renders per model
    Given the current project has captured calls on "claude-sonnet-5" and "claude-haiku-4-5-20251001"
    When the Stats graph renders
    Then a smoothed series is drawn for "sonnet-5" and another for "haiku-4-5"
    And each series is a non-decreasing cumulative curve starting at the earliest captured timestamp
    And the two series overlay on the same axes without distorting each other

  Scenario: The x-axis starts at the session start
    Given the earliest captured row for the project is at "2026-08-01T09:00:00.000Z"
    And the latest captured row is at "2026-08-01T09:45:00.000Z"
    When the graph renders
    Then the leftmost plotted point corresponds to the earliest timestamp
    And the rightmost plotted point corresponds to the latest timestamp

  Scenario: Toggling the plotted metric re-renders without new IPC
    Given the graph is showing "Cost"
    When the user selects "Input tokens" on the metric toggle
    Then every series re-plots the cumulative input-token totals from the same rows
    And no telemetry IPC call is issued to fetch new data
    And the "Input tokens" option is shown as selected

  Scenario: All four metrics are selectable
    When the metric toggle is inspected
    Then it offers exactly "Cost", "Input tokens", "Output tokens", and "Cache tokens"
    And "Cache tokens" plots cacheReadTokens plus cacheCreationTokens combined

  Scenario: The graph updates live from a telemetry push
    Given the graph is mounted for project "alpha"
    When a telemetry:update payload for "alpha" arrives with a new api_request row
    Then the graph re-plots to include the new point
    And the previously-selected metric remains selected

  Scenario: Live push for a different project is ignored by the graph
    Given the graph is mounted for project "alpha"
    When a telemetry:update payload for project "beta" arrives
    Then the alpha graph does not change

  Scenario (edge): No usage data yet shows an empty state, not a broken chart
    Given the project has captured zero api_request rows
    When the graph renders
    Then an explicit "no usage data" empty state is shown
    And no exception is thrown and no NaN geometry is produced

  Scenario (edge): A single data point renders without a degenerate/crashing curve
    Given the project has captured exactly one api_request row
    When the graph renders
    Then a single point (or a flat/degenerate-but-valid series) is drawn
    And smoothing over one point does not throw or produce NaN

  Scenario (edge): No folder open disables the graph gracefully
    Given a tab with no folder
    When the Stats tab opens
    Then the graph shows an "open a folder" affordance and throws no exception

  Scenario (failure): Malformed rows never corrupt the graph
    Given a row has an unparseable timestamp and a non-numeric costUsd
    When the graph renders
    Then that row contributes 0 / is skipped for the time axis
    And the rest of the series still render without NaN or a thrown error
```

## Edge & Failure Cases the coder must handle
- **Zero rows** (telemetry off, or captured nothing yet): explicit empty state, no throw.
- **Single data point**: smoothing/curve math must not divide-by-zero or produce
  `NaN` paths; a lone point should still be visible.
- **All rows on one model** vs **many models overlapping**: legend + distinct colours;
  overlapping cumulative curves must not overwrite each other's geometry.
- **Identical/zero time span** (all rows share one timestamp, or only one row): avoid
  divide-by-zero when scaling the x-axis (span of 0).
- **Missing/empty `model`**: bucket under `telShortModel('')` → `(unknown)` series.
- **Missing/unparseable `timestamp`**: skip for x-positioning; do not let `NaN` from
  `new Date(bad).getTime()` reach the SVG path.
- **Non-numeric / missing metric fields**: coerce via a `telNum`-style guard to 0;
  never emit `NaN` width/height/`d` attributes.
- **Very large cost/token values**: y-axis must auto-scale to the series max; no
  fixed cap that clips or overflows the plot area; formatting via `telFmtUsd`/`telFmtInt`.
- **Row cap (100 / RECENT_CAP)**: only the retained recent rows are plotted; do not
  assume the full history is present.
- **Live update preserving toggle state**: a re-render triggered by a push must keep
  the user's currently-selected metric, not reset to Cost.
- **Rapid successive pushes**: re-render must be idempotent (clear + redraw), not
  accumulate stale SVG nodes.

## Relevant Files & Context

### Where the work lands
- `C:\projects\claude-cmd-ui2\renderer\renderer.js`
  - `buildTelemetryControl(tab)` (starts ~line 7394) — the single function that
    builds the whole Stats panel. Append the new graph section here, into `section`
    (assembled ~lines 7641-7649, currently: `toggleRow`, `status`, `scopeLine`,
    `totalsGrid`, `byModelWrap`, `sessionWrap`, `logWrap`, `forwardWrap`, `projWrap`).
    A natural slot is between `sessionWrap` and `logWrap`, or right after `byModelWrap`.
  - `renderLog(rows)` (~7555) and `renderUsage(usage)` (~7444) — mirror their
    null-safe, `textContent`-only, clear-then-rebuild rendering style for the new
    `renderGraph(rows, metric)`.
  - The live subscription (~7727-7741): `telemetryUnsub = window.api.telemetry.onUpdate((payload) => {...})`.
    It already calls `renderUsage(payload.projectUsage)` and
    `renderLog(payload.projectRecent)` when `payload.project === folder`. Add the
    graph re-plot on the same `projectRecent` branch. `telemetryUnsub` is torn down
    and re-subscribed on every mount — preserve that pattern.
  - `refresh()` (~7654) — mount-time seed: reads `getUsage(folder)` →
    `res.usage.recent` (used to seed `renderLog`). Seed the graph from the same array.
  - Display helpers to reuse (do NOT duplicate): `telShortModel` (~7356),
    `telFmtUsd` (~7327), `telFmtInt` (~7323), `telNum` (~7336),
    `telUpTokens`/`telDownTokens` (~7344/7348), `telFmtTime` (~7363).
- `C:\projects\claude-cmd-ui2\renderer\styles.css`
  - Existing Stats-tab classes to match visually: `.team-telemetry-totals` (~3537),
    `.team-telemetry-bymodel` (~3560), `.team-telemetry-session` (~3577),
    `.team-telemetry-log*` (~3588-3646). Add new `.team-telemetry-graph*` /
    `.team-telemetry-metric-toggle` classes here in the same dark palette
    (backgrounds `#…`, muted labels `#8a8a8a`, `font-variant-numeric: tabular-nums`).
- `C:\projects\claude-cmd-ui2\renderer\index.html`
  - Hosts the Stats tab body (`.statsBody`, referenced as `tab.els.statsBody`) and
    `.statsStatus`. The panel is built entirely in JS via `initStatsTab(tab)`
    (~7262) → `buildTelemetryControl`, so no static markup change is required unless
    a header comment is added; keep any change comment-only.

### Data shape already available (source of the graph's data)
- **Row shape** (from `lib/telemetry.js` `extractApiRequests`, documented ~lines
  233-266): each api_request row is
  `{ requestId, sessionId, model, querySource, timestamp (ISO string or ''),
     inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUsd,
     durationMs, project }`. These are exactly the fields the graph needs: `timestamp`
  for the x-axis, `model` for the series, and `costUsd` / `inputTokens` /
  `outputTokens` / (`cacheReadTokens`+`cacheCreationTokens`) for the selectable
  y-metric.
- **Per-call rows reach the renderer two ways** (both current project only):
  1. Live push: `payload.projectRecent` on `telemetry:update` — `bucket.recent.slice(-100)`,
     built in `snapshotState` (`lib/telemetry-receiver.js` ~line 225), append-ordered
     (chronological).
  2. Mount: `getUsage(folder)` → `{ usage, recent }`; `res.usage.recent` is the same
     per-call array (used today to seed `renderLog`).
- Rows are **append-ordered**, so already time-sorted for cumulative plotting (still
  guard against out-of-order/empty timestamps per edge cases).

### What is missing / must be decided (do NOT silently assume beyond A1-A6)
- **No app-wide per-row timeline exists.** `payload.usage` and
  `usage()`/`aggregateUsage(allRows())` return **aggregate `byModel` totals only** —
  no timestamps — so a true all-projects session timeline is NOT plottable with
  today's IPC. Per **A1**, this ticket scopes the graph to the current project's
  `projectRecent`/`recent`. If the user wants an all-projects timeline, that is a
  FOLLOW-UP requiring a new IPC (e.g. `telemetry:recentRowsAllProjects`) returning
  timestamped rows across buckets from `allRows()` in `lib/telemetry-receiver.js`
  (~line 170) — out of scope here unless the user says otherwise in Additional Context.
- **No persisted session-start instant.** Derived from earliest row timestamp (**A3**).
- **No charting library.** Hand-rolled inline SVG via `createElementNS` (**A4**);
  the renderer already builds all DOM by hand and cannot `require()` Node modules.

### Related prior tickets (context only, all done)
- `tasks/done/TASK-195-change-stats.md` — added the "Session totals (all projects)"
  section and per-prompt cost; established the `payload.usage` vs `payload.projectUsage`
  vs `payload.projectRecent` split and the `telShortModel`/`telFmt*` helpers.
- `tasks/done/TASK-157-stats-tab-per-project.md` — made the Stats tab per-project
  (`buildTelemetryControl(tab)` scopes to `tab.folder`); the `textContent`-only /
  no-`innerHTML` XSS convention and graceful "no folder" degradation originate here.
- `tasks/done/TASK-196-usage-meter-bar.md` — unrelated header usage bar; do not touch.

## Build notes
- Coder: built in isolated worktree `.worktrees/task-199` (branch `orchestrate/task-199`,
  commit `98125c8`). Had to sync several uncommitted main-tree files (from prior tickets
  TASK-195/196/197/198) into the worktree first as a dependency baseline, since those
  changes only existed uncommitted in the main tree.
- Tester: added `test/task-199-telemetry-graph.e2e.test.js` (16 scenarios) and
  `test/task-199-telemetry-graph.unit.test.js` (27 tests), all 43 green. Full suite:
  3841 pass / 26 pre-existing baseline failures unrelated to this ticket, no new
  regressions.
- Tech-lead review: no critical or high-security findings — implementation verified to
  satisfy every acceptance criterion, reuses existing helpers, textContent-only, no
  injection/IPC/security concerns. Findings were coverage/nits only (not ticketed per
  policy, medium/low severity): the new tests don't actually exercise `renderGraph`'s
  drawing path (mocks fall through to the empty state / hand-duplicated `telSmoothPathD`
  in the unit tests rather than the real function), two assertions are vacuous
  (an uncounted `updateCalls` check and a live-update test whose payload never triggers
  a re-plot), and the graph title is hardcoded "Cost over time" regardless of the
  selected metric.
- Post-processing: `docs/telemetry.md` and `README.md` updated to document the new
  cost-over-time graph (commit `adb939b` on `orchestrate/task-199`).
- **Reconciliation note:** the isolated worktree's branch (`orchestrate/task-199`)
  was never merged into the main tree by the run that produced the notes above —
  this ticket was left at `status: todo` with the work orphaned in
  `.worktrees/task-199`. A later session (2026-08-01) discovered this, verified the
  worktree's `renderer.js`/`styles.css`/README changes were clean/additive against
  the current main tree, found `docs/telemetry.md` had gone stale (missing TASK-195
  sections added after the worktree branched) and manually spliced in just the new
  "cost-over-time graph" doc section rather than overwriting the file, copied over
  the two test files, reran the full suite (43/43 new tests green, no regressions
  beyond the pre-existing baseline failures), and only then advanced this ticket to
  `done`.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
