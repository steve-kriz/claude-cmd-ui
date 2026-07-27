---
id: TASK-162
title: getUsage() no-arg now scopes to activeProject, inconsistent with live-update app-wide totals
status: done
created: 2026-07-26T22:58:04.000Z
updated: 2026-07-27T00:53:20.000Z
agent: swarm-orch1
review-of: TASK-154
---

## Description
Orchestrator pre-build investigation and coder/tester/tech-lead all
independently confirmed that the original inconsistency this ticket describes
was already fixed as a side effect of TASK-157's rewrite of
`buildTelemetryControl(tab)`: `refresh()` and the `onUpdate` handler both
consistently scope to `folder`. No functional code change was needed — this
was a verification + regression-test ticket, and 5 new tests now guard the
behavior against future regression.

## Acceptance Criteria
- [x] Confirmed `refresh()` and `onUpdate` both consistently scope to `folder`
      — independently re-verified by coder, tester, AND tech-lead reading the
      actual current code.
- [x] Test exercises BOTH the refresh path and an `onUpdate` push for the same
      panel/scope and asserts consistent totals; a push for a different
      project does not leak in.
- [x] Test guards `lib/telemetry-receiver.js`'s `getUsage()` no-arg contract in
      isolation.
- [x] All tests green beyond the known pre-existing baseline failures.

## Cucumber Tests
```gherkin
Feature: Telemetry panel shows a consistent total scope

  Scenario: Refresh and live update agree on scope
    Given rows ingested for project "alpha" and project "beta"
    When the panel (scoped to folder "alpha") calls refresh()
    And separately receives a live onUpdate push tagged project "alpha"
    Then both report the same kind of total (both scoped to alpha)

  Scenario: A live update for a different project does not affect this panel
    Given the panel is scoped to folder "alpha"
    When a live onUpdate push tagged project "beta" arrives
    Then the panel's displayed totals are unchanged

  Scenario (edge): The receiver's getUsage() no-arg still has a sensible contract
    Given activeProject has never been set ("")
    When the receiver's getUsage() (no args) is called directly
    Then it returns the app-wide roll-up
```

## Relevant Files
- `C:\projects\claude-cmd-ui2\test\task-162-telemetry-scope-consistency.e2e.test.js`
  (new, 5 tests).
- `C:\projects\claude-cmd-ui2\docs\telemetry.md` — Code map entry corrected
  (was conflating `usage()`'s always-app-wide behavior with `getUsage()`'s
  actual `activeProject`-scoped-with-fallback contract).

## Build/Test/Review Notes
- Coder: independently re-verified the fix already existed by reading current
  code (didn't just trust the ticket's pre-investigation note); added 5
  regression tests including a real-invocation test backed by a real
  `createTelemetryReceiver` instance.
- Tester: confirmed real-code execution (not source-text-only), all 3 Gherkin
  scenarios covered. Full suite: 3370 tests, 3366 pass, 3 fail (confirmed
  baseline).
- Tech-lead review: independently re-verified the central claim by reading
  `refresh()`/`onUpdate`/`getUsage()` directly (not on faith) — confirmed true.
  Confirmed the new test's real-invocation portion is genuine (mock shapes
  match production exactly). One low-severity discretionary finding: the
  file's first two tests are redundant source-text regexes duplicating
  coverage the real-invocation test already provides — filed as TASK-170.
- Post-processing: independent security pass found no issues (test-only
  change). Found and fixed a genuinely stale docs/telemetry.md line that
  conflated `usage()` (always app-wide) with `getUsage()` (actually
  `activeProject`-scoped) — the exact inconsistency this ticket investigated;
  now documented accurately.

## Additional Context
_(user-owned — leave blank)_
