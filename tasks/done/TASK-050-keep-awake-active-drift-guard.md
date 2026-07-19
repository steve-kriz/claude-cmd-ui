---
id: TASK-050
title: add a drift guard pinning the real keepAwakeActive() body in main.js
status: done
created: 2026-07-19T02:29:00Z
updated: 2026-07-19T04:20:00Z
---

## Description
Follow-up from the TASK-036 tech-lead review (LOW — test-coverage gap). The "no double-start"
and "already-held" correctness in real `main.js` depends on `keepAwakeActive()` returning
`true` when a blocker is held, and on its internal try/catch swallowing an `isStarted` throw.
The current keep-awake drift guard only asserts that `startKeepAwake` CALLS
`if (keepAwakeActive()) return;` — it never pins what `keepAwakeActive` returns or that it
wraps `powerSaveBlocker.isStarted(...)` in try/catch. That behavior is validated only against
the test replica's own `active()`. If real `keepAwakeActive` regressed (e.g. always returned
`false`, or lost its try/catch), the replica tests would still pass. The `keepAwakeBlockerId !== null`
guard only partially covers this.

## Acceptance Criteria
- [ ] Add a drift guard that slices the real `function keepAwakeActive` region from `main.js`
      and asserts: it checks `keepAwakeBlockerId !== null` AND calls `powerSaveBlocker.isStarted(keepAwakeBlockerId)`,
      AND wraps the `isStarted` call in try/catch (so an `isStarted` throw is swallowed and does
      not crash / mislead the no-double-start guard).
- [ ] The guard would FAIL if `keepAwakeActive` were changed to always return a constant, or if
      its try/catch were removed (demonstrate the fail-mode reasoning).
- [ ] Existing TASK-036 keep-awake tests remain green; no production source changed by this ticket.
- [ ] Only `test/task-036-keep-awake.*.test.js` changed. Full suite passes under `node --test`.

## Cucumber Tests
```gherkin
Feature: The real keepAwakeActive body is pinned by a drift guard

  Scenario: keepAwakeActive wiring is asserted against real main.js
    Given the real main.js source
    Then a drift guard asserts keepAwakeActive checks blockerId !== null and calls isStarted within try/catch

  Scenario: Regression is caught (edge)
    Given keepAwakeActive is mutated to always return false (or loses its try/catch)
    Then the drift guard fails
```

## Relevant Files and Context
- `main.js` — `function keepAwakeActive()` (checks `keepAwakeBlockerId !== null` then `powerSaveBlocker.isStarted(keepAwakeBlockerId)` inside try/catch).
- `test/task-036-keep-awake.e2e.test.js` — existing drift guards (slice main.js regions); add the `keepAwakeActive` slice guard here.

## Edge and Failure Cases
- Mutated `keepAwakeActive` returning a constant -> guard fails.
- Removed try/catch around `isStarted` -> guard fails.
- Benign reformatting/whitespace -> guard should stay tolerant (match load-bearing tokens, not exact whitespace).

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
