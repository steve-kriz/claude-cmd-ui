---
id: TASK-039
title: add test coverage for the bug-create STEP-2 (bug-ticket write) failure partial state
status: done
created: 2026-07-18T23:25:24Z
updated: 2026-07-19T00:24:00Z
---

## Description
Follow-up from the TASK-031 tech-lead review (minor — test coverage). The TASK-031 tests (`test/task-031-bug-reporting.test.js`, `test/task-031-bug-reporting.e2e.test.js`) model original READ-fail and original WRITE-fail, but neither exercises the one genuinely inconsistent state the ticket calls out: the ORIGINAL is written successfully but the NEW bug-ticket write fails. The unit `planBugWrites` helper even has a `writeBug` branch returning `{ originalUpdated: true, bugTicketWritten: false }`, but no test drives it with a failing `writeBug`; the e2e `simulateCreateBug` has no bug-write-fail parameter. So the production error path (renderer/renderer.js ~6671-6676, message "Bug ticket create failed (original was updated)") and the resulting partial state (and the duplicate-on-retry behavior — see TASK-038) are untested.

## Acceptance Criteria
- [x] A unit test drives `planBugWrites` (or the equivalent write-ordering model) with STEP 1 succeeding and STEP 2 (bug-ticket write) failing, asserting: original updated exactly once, bug ticket NOT written, and the partial-state error surfaced.
- [x] An e2e scenario exercises the STEP-2-fails path (original written, bug-ticket write fails) and asserts the inline error message and that the original was updated exactly once.
- [x] The tests are behavioral (drive the modelled logic / requireable helpers), not mere source scans, and would fail if the STEP-2 failure handling regressed.
- [x] If TASK-038 (retry de-duplication) is implemented first, this coverage also asserts the retry does not double-fold; otherwise it documents the current duplicate behavior as a known gap referencing TASK-038.
- [x] Full suite passes under `node --test`.

## Cucumber Tests
```gherkin
Feature: The bug-create STEP-2 failure state is tested

  Scenario: Original written, bug-ticket write fails
    Given a bug is filed against "TASK-010"
    And the original update (STEP 1) succeeds
    And the new bug-ticket write (STEP 2) fails
    Then an inline error indicating the original was already updated is shown
    And the original was updated exactly once
    And no new bug ticket file exists

  Scenario: Failure/edge — regression is caught
    Given the STEP-2 failure handling is changed to silently swallow the error
    Then the new test fails
```

## Relevant Files and Context
- `test/task-031-bug-reporting.test.js` — the `planBugWrites` write-order state machine; add a failing-`writeBug` case.
- `test/task-031-bug-reporting.e2e.test.js` — `simulateCreateBug`; add a `bugWriteFails` parameter/scenario.
- `renderer/renderer.js` — `onCreateBug` STEP-2 failure branch (~6671-6676) is the real code path under test.
- Repo conventions: `node --test`; mock all IO in-memory; behavioral coverage + drift guards (see the existing TASK-031 tests).

## Edge and Failure Cases
- STEP 2 fails after STEP 1 success → asserted (the target gap).
- Ensure the added scenario does not depend on real disk/DB (mock IO).
- Coordinate with TASK-038 so the retry/duplicate assertion matches whichever behavior is current.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
