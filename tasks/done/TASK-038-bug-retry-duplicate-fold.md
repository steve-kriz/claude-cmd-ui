---
id: TASK-038
title: bug create retry after bug-ticket write failure folds a duplicate report into the original
status: done
created: 2026-07-18T23:25:24Z
updated: 2026-07-19T00:13:00Z
---

## Description
Follow-up from the TASK-031 tech-lead review (minor — data correctness). In `onCreateBug` (renderer/renderer.js ~6671-6676), when STEP 1 (update the original ticket) succeeds but STEP 2 (write the new bug ticket) fails, the handler shows an inline error, re-enables the button, and `armCreate()`s WITHOUT calling `cleanup()`. `bugMode` stays true and the original already carries the new `## Bug Reports` entry. On user retry, `onCreateBug` re-runs unconditionally from STEP 1 — re-reading the (already-updated) original and appending the SAME bug description a second time. Each retry accretes a duplicate `## Bug Reports` entry in the original.

## Acceptance Criteria
- [x] After STEP 1 (original update) succeeds within a single modal session, a retry that failed only at STEP 2 (bug-ticket write) must NOT re-append the bug to the original a second time.
- [x] Implement one of: (a) remember that the original was already updated for this session and, on retry, skip STEP 1 and re-attempt only STEP 2; OR (b) make the append idempotent for an identical (timestamp, text) entry so a repeat is a no-op.
- [x] A successful retry results in exactly ONE `## Bug Reports` entry in the original and exactly one new bug ticket.
- [x] The fix does not break the happy path (single successful create still updates original once + creates the bug ticket once) nor the pre-STEP-1 validation failures (which write nothing).
- [x] Modal reset on close/cancel/re-open clears any "original already updated" session state so a genuinely new bug against the same original still folds a fresh entry.
- [x] Full suite passes under `node --test`, with a test exercising the STEP-2-fails-then-retry path.

## Cucumber Tests
```gherkin
Feature: Retrying a failed bug create does not duplicate the original's bug report

  Scenario: STEP 2 fails, user retries, original updated once
    Given the Bug button targets original "TASK-010" with a bug description
    And updating TASK-010 (STEP 1) succeeds but writing the new bug ticket (STEP 2) fails
    When the user clicks create again and STEP 2 now succeeds
    Then TASK-010 has exactly one matching "## Bug Reports" entry
    And exactly one new bug ticket exists

  Scenario: A new bug against the same original after close still folds a fresh entry (edge)
    Given a bug was successfully filed against "TASK-010" and the modal was closed
    When a second, different bug is filed against "TASK-010"
    Then TASK-010 has two distinct "## Bug Reports" entries
```

## Relevant Files and Context
- `renderer/renderer.js` — `onCreateBug` (~6620-6680), especially the STEP-2 failure branch (~6671-6676) and the STEP-1 append/write (~6632). The session-scoped flag (option a) should live in the modal closure and be reset by `leaveBugMode()`/`cleanup()`.
- `renderer/renderer.js` `appendBugReportToMarkdown` (~6508) / `lib/ticket-bug-reports.js` `appendBugReport` — for option (b) idempotency, if chosen (keep renderer mirror in step, TASK-027).
- Tests: `test/task-031-bug-reporting.*` — extend the write-order state machine (`planBugWrites`) and e2e to cover STEP-2-fail-then-retry.

## Edge and Failure Cases
- STEP 1 fails → no original change, no bug ticket, retry re-runs STEP 1 cleanly (unchanged).
- STEP 1 ok, STEP 2 fails, retry STEP 2 ok → original updated exactly once (the fix).
- STEP 1 ok, STEP 2 fails, user cancels instead of retrying → original retains one entry but no bug ticket exists; surface this partial state clearly (message), and ensure a later fresh attempt is not treated as a duplicate.
- Re-open modal / target a different original → session flag reset.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
