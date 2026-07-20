---
id: TASK-085
title: Decouple the board-poll window-attention drift guard from a prose comment
status: done
created: 2026-07-19T23:42:21Z
updated: 2026-07-20T00:35:15Z
review-of: TASK-078
activities: [{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-20T00:28:40Z","finishedAt":"2026-07-20T00:32:30Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-20T00:32:30Z","finishedAt":"2026-07-20T00:35:15Z"},{"activity":"post-processing","model":"claude-opus-4-8","startedAt":"2026-07-20T00:35:15Z","finishedAt":"2026-07-20T00:35:15Z"}]
---

## Description
Follow-up from the tech-lead review of TASK-078 (Finding 2, Low, test-only). The drift
guard pinning the board-poll invocation of `reportWindowAttention()` matches
`/question\/answer state is fresh[\s\S]{0,200}?reportWindowAttention\(\)/`, keying off the
COMMENT text "question/answer state is fresh" (`renderer/renderer.js` ~6070-6071) rather
than the call-site's code structure. This repeats the comment-coupling brittleness already
remediated in TASK-047/TASK-052 for the dead-ternary guards: a legitimate comment reword
breaks the test (false failure), and the assertion validates prose rather than the actual
board-poll invocation semantics.

Re-anchor the guard to the code structure — assert `reportWindowAttention()` is invoked
within `renderTasksBoard` (the board-poll function), independent of any comment wording.

## Acceptance Criteria
- [ ] The board-poll drift guard asserts `reportWindowAttention()` is called within the
  `renderTasksBoard` function body (code-structure anchored), NOT keyed to the comment text
  "question/answer state is fresh".
- [ ] Rewording or removing that comment (with no functional change) does NOT break the
  guard.
- [ ] Removing the real board-poll `reportWindowAttention()` call DOES break the guard.
- [ ] No product/implementation code is changed — this is a test-only ticket.
- [ ] `node --test` green aside from the two known pre-existing unrelated failures
  (`test/task-030-plan-button.e2e.test.js`, `test/task-034-routing-drift-guard.test.js`).

## Cucumber Tests
```gherkin
Feature: The board-poll attention drift guard is code-anchored, not comment-anchored

  Scenario: Rewording the comment does not break the guard
    Given the board-poll drift guard
    When the "question/answer state is fresh" comment is reworded
    Then the guard still passes

  Scenario: Removing the board-poll call fails the guard (failure)
    Given the real renderTasksBoard reportWindowAttention() call is removed
    When the drift-guard test runs
    Then it fails
```

## Impact If Not Fixed
Routine comment maintenance will produce spurious red builds, eroding trust in the suite;
conversely the guard gives false confidence because it checks prose, not behavior.

## Edge Cases & Failure Paths
- Anchoring to `renderTasksBoard` must still fail if the call is moved entirely out of the
  board-poll path.
- Keep the change consistent with how TASK-047/TASK-052 re-anchored comment-coupled guards.

## Relevant Files & Context
- `test/window-attention.e2e.test.js` ~582-586 (the board-poll drift guard).
- `renderer/renderer.js` ~6070-6072 (the board-poll `reportWindowAttention()` call and its
  comment); `renderTasksBoard`.
- Precedent: TASK-047 / TASK-052 (comment-coupling remediation for dead-ternary guards).
- Origin: tech-lead review of TASK-078, Finding 2 (Low).

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
