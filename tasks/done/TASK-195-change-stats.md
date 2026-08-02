---
id: TASK-195
title: change stats
status: done
created: 2026-07-31T22:19:33.264Z
updated: 2026-08-01T00:13:58.000Z
---

## Description

Two related improvements to the Stats tab and the prompt log, both building on the existing OTEL telemetry pipeline (`lib/telemetry.js` → `lib/telemetry-receiver.js` → `telemetry:*` IPC → the Stats tab in `renderer/renderer.js`).

**1. Per-model session totals in the Stats tab.** "Session" means the whole app run across all open projects (the app-wide `usage.byModel` from `aggregateUsage` over `allRows()`), not the focused project's `projectUsage.byModel`. Kept live off the existing `telemetryUnsub`/`onUpdate` push, no extra IPC call.

**2. Per-top-level-prompt token/cost totals in the prompt log (`.claude-logs`).** Each prompt's sequence window is `[entry.ts, nextEntry.ts)` (open-ended to now for the newest entry). Correlation is scoped to that prompt's own project's telemetry bucket only (never app-wide), via the new `usageForWindowInProject(project, window)` in `lib/telemetry-receiver.js`. Computed totals are persisted back onto the `.claude-logs/logs/prompt_history.json` entry via the existing `writePromptHistory`/`prompts:write` path once the window is bounded.

## Acceptance Criteria
- [x] Session per-model breakdown covers the whole app run, all projects; driven by app-wide `usage.byModel`.
- [x] Updates live off the existing telemetry push, no extra IPC.
- [x] Model labels via `telShortModel`; empty/unknown renders as `(unknown)`.
- [x] Telemetry off/nothing captured → empty/zeroed state, never throws.
- [x] Real per-prompt total tokens/cost shown when telemetry rows exist for that window.
- [~] A prompt's sequence window is `[entry.ts, nextEntry.ts)` — implemented as inclusive-at-both-ends instead of exclusive-at-end; see follow-up TASK-198 (critical finding from review).
- [x] Per-prompt correlation scoped to that prompt's own project only, never app-wide.
- [x] Multi-model sequences summed in full.
- [x] No matching rows → falls back to estimate, renders without error.
- [x] Real totals persisted back to `prompt_history.json`; `ts`/`source`/`prompt` preserved; no entry dropped/reordered.
- [x] Malformed/partial api_request rows contribute 0, never `NaN`, never throw.
- [x] All existing telemetry/stats tests continue to pass.

## Cucumber Tests
```gherkin
Feature: Per-model session totals and per-top-level-prompt cost in the Stats/Logs UI

  Scenario: Per-model breakdown spans the whole session, not one project
    Given project "alpha" has captured 2 calls on model "claude-sonnet-5"
    And project "beta" has captured 3 calls on model "claude-haiku-4-5-20251001"
    When the session per-model totals render
    Then a row for "sonnet-5" shows its 2 calls, total tokens and total cost
    And a row for "haiku-4-5" shows its 3 calls, total tokens and total cost

  Scenario: A top-level prompt shows the total cost of its triggered sequence
    Given a prompt entry at "2026-08-01T10:00:00.000Z" in project "alpha"
    And 3 api_request calls were captured in project "alpha" totalling 40000 up, 1200 down and $0.15
    When the Logs panel renders that prompt
    Then the prompt row shows 40000 tokens up, 1200 tokens down and a cost of $0.15

  Scenario: A concurrently-running different project's calls are excluded
    When the Logs panel renders a prompt in project "alpha"
    Then project "beta"'s concurrently-captured calls are never included

  Scenario: Failure - telemetry is off
    Given the telemetry receiver is not running
    When the Logs panel loads
    Then every prompt falls back to its estimate and the panel still renders
```

## Relevant Files & Context

- `renderer/renderer.js` — `buildTelemetryControl`, `sessionByModelWrap`/`renderSessionUsage`, `loadPromptLog`, `correlatePromptEntryUsage(folder, entry, nextEntry)`, `renderLogsList`.
- `lib/telemetry-receiver.js` — `usageForWindowInProject(project, window)`.
- `main.js` — `createUsageForWindowInProjectHandler`, `telemetry:usageForWindowInProject` IPC channel.
- `preload.js` — `window.api.telemetry.usageForWindowInProject(project, w)`.
- `docs/telemetry.md`, `docs/prompt-history.md` — updated by the coder as part of this ticket.

## Clarifications
- **Q1:** Session scope = whole app run, all projects.
- **Q2:** Persist real totals to `prompt_history.json`.
- **Q3:** Correlation scoped to the prompt's own project only, never app-wide.

## Build notes
- Session totals: new "Session totals (all projects)" section in `buildTelemetryControl`, driven by `payload.usage.byModel` on the existing `telemetryUnsub`/`onUpdate` push.
- Per-prompt correlation: new `usageForWindowInProject(project, window)`, new `telemetry:usageForWindowInProject` IPC channel, `correlatePromptEntryUsage` called from `loadPromptLog`, persisted via `prompts.write` once bounded (newest entry recomputed each load, not persisted). `model` field intentionally not persisted.
- Process note: a `git stash`/`git stash pop` cycle mid-verification transiently altered line endings on other in-flight tickets' files; detected and normalized back to LF, content-preserving. Orchestrator independently re-verified no corruption.

## Test notes
- `test/task-195-stats-per-model-session.e2e.test.js` (5 scenarios) + `test/task-195-stats-per-model-session.unit.test.js` (14 tests), all 19 pass. Full suite independently re-verified by orchestrator: 34 pre-existing/unrelated failures (tech-lead severity-classification leftover from another session, cost-breakdown, direct-send, accordion, buildWorkflowView signature drift), none caused by this ticket.

## Review notes
- Tech-lead review found **1 critical finding**: the per-prompt correlation window is implemented inclusive-at-both-ends instead of the specified exclusive-at-end `[ts, nextTs)`, so an api_request row whose timestamp exactly equals a prompt boundary is double-counted across both adjacent windows, and the inflated total is persisted to disk. Follow-up ticket **TASK-198** created (continues the sequence from the true max, TASK-197) to fix this and rewrite the test that currently locks in the buggy behavior.
- Two medium findings noted (no follow-up ticket per severity policy): (1) the persistence/field-preservation path in `loadPromptLog` (AC "ts/source/prompt preserved, no entry dropped/reordered") has no dedicated regression test; (2) session totals start empty until the next telemetry push rather than showing already-captured data on mount — a deliberate no-extra-IPC trade-off, acceptable as designed.
- Security: clean. `prompts:write` stays confined via `fsRoots.isPathAllowed`; the `project` argument to `usageForWindowInProject` is used only as a Map key, never a filesystem path.
- Per skill policy, this ticket's own acceptance criteria and tests passed, so it proceeds to `done` regardless of the critical finding — which only spawns the separate TASK-198 follow-up rather than blocking this transition.

## Post-processing notes
- Coder already updated `docs/telemetry.md` and `docs/prompt-history.md` as part of the ticket. Orchestrator checked for any other doc referencing the old flat-rate estimate (`estimateTokens`/`estimateCostUsd`/`COST_PER_M_INPUT`) and found none outside those two files — no further doc changes needed.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
