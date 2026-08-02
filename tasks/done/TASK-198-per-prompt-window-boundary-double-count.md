---
id: TASK-198
title: TASK-195 review — per-prompt window boundary double-counts a call at the exact next-ts
status: done
created: 2026-08-01T00:12:56.000Z
updated: 2026-08-01T00:49:47.000Z
review-of: TASK-195
---

## Description

The TASK-195 tech-lead review found that `usageForWindowInProject` (`lib/telemetry-receiver.js`) delegated to the shared `usageForWindow` (`lib/telemetry.js`), whose boundary test is inclusive at both ends. TASK-195's acceptance criteria require the per-prompt correlation window to be `[entry.ts, nextEntry.ts)` — exclusive at the end. An `api_request` row whose timestamp exactly equalled a prompt's `ts` was counted in both adjacent windows, and the earlier (bounded) window's inflated total was persisted to `.claude-logs/logs/prompt_history.json`.

## Acceptance Criteria
- [x] A call whose timestamp equals `finishedAt` is excluded from the earlier prompt's total.
- [x] That same call is included in the next prompt's total instead.
- [x] The shared `usageForWindow` helper's inclusive-at-both-ends contract is unchanged for other callers (e.g. TASK-142 per-ticket cost).
- [x] The newest prompt's still-open window (extends to "now") is unaffected.
- [x] The previously-buggy boundary test now asserts exclusive-end behavior.
- [x] A regression test proves the exact-boundary row is counted exactly once (later window), never twice.
- [x] All other TASK-195 acceptance criteria/tests still pass.

## Cucumber Tests
```gherkin
Feature: Per-prompt correlation window is exclusive at its end boundary

  Scenario: A call at the exact boundary timestamp is attributed to the later prompt only
    Given a prompt "A" at "2026-08-01T10:00:00.000Z" in project "alpha"
    And the next prompt "B" at "2026-08-01T10:05:00.000Z"
    And an api_request call was captured at exactly "2026-08-01T10:05:00.000Z" in project "alpha"
    When both prompts' totals are computed
    Then prompt "A"'s total does NOT include that call
    And prompt "B"'s total DOES include that call

  Scenario: A call strictly inside a window is still counted normally
  Scenario: The newest (open-ended) prompt's window is unaffected by the boundary fix
  Scenario (regression, failure/edge): reintroducing the inclusive-end bug is caught
```

## Relevant Files & Context
- `lib/telemetry-receiver.js` — `usageForWindowInProject(project, window)` (fix, lines ~466-478).
- `lib/telemetry.js` — `usageForWindow(records, window)`, unchanged (lines ~394-415).
- `renderer/renderer.js` — sole caller `correlatePromptEntryUsage` (lines ~3576-3594), unchanged.
- `test/task-195-stats-per-model-session.unit.test.js` — rewritten boundary test + new regression test (lines ~136-216).

## Impact If Not Fixed
Whenever a captured API call's timestamp coincided exactly with a logged prompt's timestamp, that call's tokens/cost would be attributed to two prompts at once, inflating both per-prompt totals and the Logs panel's `Σ cost` footer, permanently persisted to `prompt_history.json`.

## Build notes
- Fix scoped entirely to `usageForWindowInProject`: pre-filters rows whose timestamp numerically equals `window.finishedAt` before delegating to the unchanged shared `usageForWindow`. This is the per-prompt-only entry point (distinct from the receiver's separate `usageForWindow` method used by TASK-142's per-ticket cost path, which keeps inclusive behavior).
- Rewrote the buggy boundary test in `test/task-195-stats-per-model-session.unit.test.js`; added the new regression test.
- Orchestrator discovered and fixed an unrelated CRLF line-ending corruption (from a coder's `git stash` usage) that was causing 2 phantom, unrelated test failures during this ticket's verification — full suite confirmed back to the known 34-failure baseline after normalizing back to LF.

## Test notes
- All 4 Gherkin scenarios confirmed covered by existing/new tests (18 unit + 5 e2e = 23 tests, all pass). Full suite: 34 pre-existing/unrelated failures, none caused by this ticket.

## Review notes
- Tech-lead review: clean, no critical/high-security findings. Explicitly confirmed the shared `usageForWindow` helper's inclusive-at-both-ends contract is genuinely preserved for the TASK-142 per-ticket cost path (unmodified code, unmodified existing tests). One nit (inconsistent but functionally-equivalent timestamp-parsing style between the new filter and the shared helper) — no follow-up ticket warranted.

## Post-processing notes
- Checked `docs/telemetry.md`'s per-prompt correlation section (TASK-195) — it already documented the intended `[entry.ts, nextEntry.ts)` exclusive-end semantics (the doc was correct in intent; the code just didn't match it yet). No doc changes needed now that the code matches.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
