---
id: TASK-045
title: simplify dead ternary in the TASK-042 e2e replica
status: done
created: 2026-07-19T01:46:37Z
updated: 2026-07-19T02:13:00Z
---

## Description
Follow-up from the TASK-042 tech-lead review (nit — test code). In `test/task-042-bug-multitarget-switch.e2e.test.js` (~line 127) the e2e replica calls `shouldWarn(bugFoldedTargets.size ? originalId : originalId, id, bugFoldedTargets)` — both branches of the ternary are `originalId`, so the condition is dead. Harmless but confusing; it obscures intent and should be simplified.

## Acceptance Criteria
- [x] The dead ternary at `test/task-042-bug-multitarget-switch.e2e.test.js` ~127 is simplified to `shouldWarn(originalId, id, bugFoldedTargets)` (or otherwise removed) with no behavior change.
- [x] The e2e scenarios in that file continue to pass unchanged.
- [x] No production source or other test files changed.
- [x] Full suite passes under `node --test`.

## Cucumber Tests
```gherkin
Feature: The TASK-042 e2e replica has no dead ternary

  Scenario: The shouldWarn call is simplified
    Given the TASK-042 e2e test file
    Then the shouldWarn call passes originalId directly (no `x ? originalId : originalId` ternary)
    And all TASK-042 e2e scenarios still pass

  Scenario: No behavior change (edge)
    Given the simplification is applied
    Then the warning-firing scenarios assert exactly as before
```

## Relevant Files and Context
- `test/task-042-bug-multitarget-switch.e2e.test.js` (~127) — the dead ternary in the `shouldWarn` call within the replica.
- This is a pure test-code cleanup; no production code involved.

## Edge and Failure Cases
- Ensure the simplification does not change which arguments `shouldWarn` receives (it must still be `(originalId, id, bugFoldedTargets)`).
- All existing TASK-042 e2e scenarios remain green.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)

## Orchestration Notes
- Build: line 127 simplified to `shouldWarn(originalId, id, bugFoldedTargets)`; both ternary branches were identical `originalId` (behavior-preserving).
- Test: full suite green (1005 pass, 0 fail). New guards `test/task-045-dead-ternary.test.js` (unit) + `test/task-045-dead-ternary.e2e.test.js` (e2e cucumber) — read the real target source; would fail if the dead ternary were reintroduced.
- Tech-lead review: clean. One LOW-severity robustness gap (whole-file guard could miss removal of only the line-127 call because an identical call exists at line 92) → follow-up TASK-046 (todo). Review does not reopen this ticket.
- Post-processing (TASK-035 security review): satisfied — read-only source-scan test files, no untrusted input / path traversal / injection (confirmed in the tech-lead security dimension).
