---
id: TASK-006
title: task flow
status: done
created: 2026-07-18T04:01:33.890Z
updated: 2026-07-18T05:39:08Z
startedAt: 2026-07-18T05:16:32Z
---

## Description
Refine the board's flow so the lanes match how work actually moves. `todo` is
where tickets are first created. Add a new column **before** `in-progress`
called **`defining`** — the lane where the business-analyst agent is defining the
task (writing acceptance criteria and Gherkin). `in-progress` then means the
ticket is being coded, and `testing` means tests are being created/checked. When
a ticket's tests fail, its marker turns **red** to signal a failed test, and the
flow then goes on to fix it.

This extends the status enum, which currently has five values
(`todo, in-progress, testing, failed-testing, done` in both
`.claude/skills/orchestrate/SKILL.md` and `TASKS_LANE_STATUSES` in
`renderer.js`). Adding `defining` means the board parser, the rendered lanes
(`index.html` `.tasks-lane[data-status=...]`), the per-lane header colours in
`styles.css`, and the SKILL's phase/enum documentation must all be updated
coherently and kept in the same left-to-right order:
`todo → defining → in-progress → testing → failed-testing → done`. The red
"failed" marker formalizes the existing `failed-testing` red styling
(`#f14c4c`) into a clear per-ticket failed indicator.

## Acceptance Criteria
- [x] The board shows a `defining` lane positioned between `todo` and `in-progress`, labelled for the BA/defining phase.
- [x] The status enum includes `defining` and the lanes render left-to-right in order: `todo`, `defining`, `in-progress`, `testing`, `failed-testing`, `done`.
- [x] `todo` remains where new tickets are first created (the new-ticket flow still produces `status: todo`).
- [x] A ticket being defined by the BA agent shows in the `defining` lane; being coded shows in `in-progress`; being tested shows in `testing`.
- [x] The board parser recognizes `defining` as a valid status (a `defining` ticket is not treated as unknown and is not dumped into the `todo` lane).
- [x] When a ticket's tests fail, its card shows a red "failed" marker.
- [x] The orchestration SKILL's status enum and phase descriptions are updated to include `defining` and its place in the flow, consistent with the board.
- [x] A ticket with a status outside the (now six-value) enum is still handled gracefully (rendered as unknown rather than crashing the board).

## Cucumber Tests
```gherkin
Feature: Task flow with a defining lane and red failed marker

  Background:
    Given the Tasks board is open

  Scenario: The defining lane sits between todo and in-progress
    When the board renders its lanes
    Then the lane order left-to-right is "todo", "defining", "in-progress", "testing", "failed-testing", "done"

  Scenario: New tickets are created in todo
    When the user creates a new ticket
    Then the ticket's status is "todo"
    And its card appears in the "todo" lane

  Scenario: A defining ticket lands in the defining lane
    Given ticket TASK-500 has status "defining"
    When the board renders
    Then TASK-500's card appears in the "defining" lane
    And TASK-500 is not treated as an unknown status
    And TASK-500 does not appear in the "todo" lane

  Scenario: Coding and testing map to their lanes
    Given ticket TASK-500 has status "in-progress"
    Then its card appears in the "in-progress" lane
    When its status becomes "testing"
    Then its card appears in the "testing" lane

  Scenario: Failed tests show a red marker
    Given ticket TASK-500's tests fail
    Then its card shows a red "failed" marker

  Scenario: The SKILL enum matches the board
    When the orchestration SKILL is read
    Then its status enum includes "defining" between "todo" and "in-progress"

  Scenario: An out-of-enum status does not crash the board
    Given a ticket has status "bogus"
    When the board renders
    Then the ticket is shown as an unknown status
    And the board keeps rendering the other tickets
```

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
