---
id: TASK-042
title: multi-target switch in a single bug-create session leaves duplicate/dangling bug folds
status: done
created: 2026-07-19T00:11:22Z
updated: 2026-07-19T01:48:00Z
---

## Description
Follow-up from the TASK-038 tech-lead review (minor — data correctness edge). TASK-038 added a single-slot session memo `bugStep1Done = { originalId, id }` (renderer/renderer.js ~6489) so a STEP-2 retry against the SAME original does not re-fold the `## Bug Reports` entry. But the memo holds only the most-recent `{ originalId, id }`, and `id` is fixed per modal session, so it effectively tracks only the CURRENT `originalId`. Two multi-target sequences within one bug-create session are still wrong:

1. **Switch-back double-fold**: user files a bug (new id e.g. `TASK-050`) and, across STEP-2 failures, switches the original-ticket select `A → B → A`. On returning to `A`, `step1AlreadyDone` is false (the memo now holds `B`), so STEP 1 runs again and folds a SECOND `## Bug Reports` entry into `A` — the exact duplicate-fold class TASK-038 exists to prevent, reached via a target switch instead of a straight retry.
2. **Dangling fold on forward switch** (`A → B`, then STEP 2 succeeds against `B`): `A` is left carrying a committed `Reported as TASK-050` entry, but `TASK-050` is ultimately `bug-of: B`. `A` now advertises a bug report for a ticket that was filed against a different original.

Root cause: a committed STEP-1 fold against an abandoned target is never reconciled, and the single-slot memo doesn't recognise a returned-to target as already-folded. Note this partly PRE-EXISTED TASK-038 (the pre-memo code also re-folded on switch), so it is not a regression introduced by TASK-038. It is distinct from TASK-039 (single-target STEP-2-fail-then-cancel partial state, where no bug ticket is created).

## Acceptance Criteria
- [x] Within a single bug-create modal session, switching the selected original ticket away from and back to a target that already had a STEP-1 fold committed does NOT fold a second `## Bug Reports` entry into that original (switch-back is recognised as already-folded and skipped).
- [x] Track committed STEP-1 folds for the session by `(originalId, id)` — e.g. a Set/Map keyed on the pair — instead of a single-slot memo, so every already-folded target is remembered for the session.
- [x] The forward-switch dangling-fold case is addressed OR clearly surfaced: if the user commits a STEP-1 fold against original A and then successfully files the bug against a DIFFERENT original B, either (a) reconcile/remove the stale `Reported as <id>` entry from A, or (b) at minimum warn the user that switching the target after a STEP-1 commit leaves a stale fold in the prior original. Document which behaviour is chosen.
- [x] Single-target flows remain exactly correct (happy path folds once; same-target STEP-2 retry does not re-fold — TASK-038 behaviour preserved).
- [x] Session state resets on modal close/cancel/re-open (all committed-fold tracking cleared) so a fresh session starts clean.
- [x] Full suite passes under `node --test`, with tests covering the switch-back and forward-switch sequences.

## Cucumber Tests
```gherkin
Feature: Switching the target original within one bug-create session does not duplicate or dangle folds

  Scenario: Switch-back does not double-fold (edge)
    Given a bug-create session with new id "TASK-050"
    And STEP 1 committed a fold into original "A" (then STEP 2 failed)
    And the user switched the original select to "B" (STEP 2 failed) then back to "A"
    When STEP 2 is retried and the original is "A" again
    Then original "A" has exactly ONE "## Bug Reports" entry naming "TASK-050"

  Scenario: Forward switch does not leave a silent dangling fold (edge)
    Given STEP 1 committed a fold into original "A" for new id "TASK-050"
    When the user switches the original to "B" and STEP 2 succeeds against "B"
    Then either "A" no longer advertises "TASK-050", or the user was warned that "A" retains a stale fold
    And the new ticket "TASK-050" carries "bug-of: B"

  Scenario: Single-target retry still folds exactly once (regression)
    Given STEP 1 committed a fold into "A" and STEP 2 failed
    When STEP 2 is retried against "A" and succeeds
    Then "A" has exactly one "## Bug Reports" entry
```

## Relevant Files and Context
- `renderer/renderer.js` — `onCreateBug` (~6603-6721), the memo decl `bugStep1Done` (~6489), `step1AlreadyDone` computation (~6632), STEP 1 guarded block, `leaveBugMode()` reset (~6498-6509). Replace the single slot with a session Set/Map keyed on `(originalId, id)`; reset the whole collection in `leaveBugMode()`.
- Prior art: TASK-038 memo logic and its tests (`test/task-038-bug-retry-dedup.*`) — extend the session state machine model to multiple targets.
- Consider whether the forward-switch reconciliation (removing a stale fold from a prior original) is worth the extra write, or whether a warning suffices — the original write must remain whole-file atomic and preserve `## Additional Context`.

## Edge and Failure Cases
- A → B → A switch-back → no second fold into A.
- A → B forward with STEP-2 success against B → A's stale fold reconciled or user warned; no silent inconsistency.
- Single-target retry → exactly one fold (TASK-038 preserved).
- Session reset (close/cancel/re-open) clears all committed-fold tracking.
- Removing a stale fold from A (if option a chosen) must re-read A fresh and preserve its other sections + Additional Context.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
