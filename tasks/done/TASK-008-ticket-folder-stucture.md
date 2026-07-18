---
id: TASK-008
title: ticket folder stucture
status: done
created: 2026-07-18T04:25:11.616Z
updated: 2026-07-18T06:08:53Z
---

## Description
Give the `tasks/` board a folder-per-status layout so the folder a ticket file
lives in reflects its status. When a ticket moves between statuses (via a
drag-drop on the board or an orchestrator write), the `.md` file is physically
moved into the subfolder named for its new status. This must keep the board
working end-to-end: today the board scans `tasks/` non-recursively via
`pollTasksOnce` (renderer.js) using `window.api.fs.readDir` and explicitly skips
subdirectories (`if (entry.isDir || !/\.md$/i.test(entry.name)) continue;`), and
`moveTicketToStatus` rewrites the `status` frontmatter with a whole-file
`serializeTicket` write. Frontmatter `status` stays the single source of truth:
if the folder a file sits in disagrees with its frontmatter `status`, the
frontmatter wins for rendering and the file is reconciled to the matching folder.
Existing status-change, todo reorder (`order` field), whole-file atomic writes,
and the ~2.5s poll (`TASKS_POLL_MS`) with keep-last-good-parse must all keep
working, and moves must avoid races/duplication with the poll.

## Acceptance Criteria
- [x] A per-status subfolder under `tasks/` exists for each canonical status in `LANE_STATUSES` (`todo`, `defining`, `in-progress`, `testing`, `failed-testing`, `done`), created on demand (via `fs.mkdir`) the first time a ticket needs it.
- [x] When a ticket's `status` changes (drag-drop through `moveTicketToStatus`, or an orchestrator status write), the ticket `.md` file is physically relocated into the subfolder matching the new status, and no copy of that file remains in the previous folder.
- [x] The board scanner (`pollTasksOnce`) discovers tickets recursively across `tasks/` and its per-status subfolders, so every ticket still appears exactly once on the board after the layout change (no ticket is dropped because it now lives in a subfolder).
- [x] Frontmatter `status` remains authoritative: when a file's folder location disagrees with its frontmatter `status`, the board renders the ticket in the lane derived from frontmatter (`laneForStatus`), and reconciliation moves the file to the folder that matches the frontmatter `status`.
- [x] Each ticket write stays a single whole-file `serializeTicket` write and each relocation is a single atomic move, so a concurrent poll never observes a half-written, missing, or duplicated ticket (the board's keep-last-good-parse still holds).
- [x] Existing behaviors are preserved unchanged: drag-drop status change, todo-lane reorder via the `order` field (`reorderTodoTicket` / `persistTicketOrder`), and the poll signature/dedupe (`t.lastSig`) continue to work.
- [x] Out-of-enum / unknown-status tickets still route to the `unknown` lane (`TASKS_UNKNOWN_STATUS`) and are not moved into a status subfolder nor lost.
- [x] Legacy tickets sitting at the top level of `tasks/` (old flat layout) are still discovered and are reconciled/migrated into the subfolder matching their frontmatter `status`.
- [x] A move that would collide with an existing file at the destination (name already taken) is detected and handled without data loss — the ticket is not silently dropped (note `fs:rename` refuses when the target already exists).

## Cucumber Tests
```gherkin
Feature: Folder-per-status ticket layout

  Background:
    Given a project with a tasks/ folder
    And the board polls tasks/ on its normal interval

  Scenario: Per-status subfolders are created on demand
    Given no status subfolders exist yet under tasks/
    When a ticket is assigned the status "in-progress"
    Then a "tasks/in-progress" subfolder exists
    And the ticket file lives inside "tasks/in-progress"

  Scenario: Moving a ticket relocates its file to the matching folder
    Given ticket TASK-101 has status "todo" in "tasks/todo"
    When the ticket status changes to "in-progress"
    Then the TASK-101 file is now under "tasks/in-progress"
    And no TASK-101 file remains under "tasks/todo"
    And the file's frontmatter status is "in-progress"

  Scenario: The scanner discovers tickets recursively
    Given tickets exist in "tasks/todo", "tasks/testing", and "tasks/done"
    When the board scan runs
    Then every one of those tickets appears exactly once on the board
    And each appears in the lane matching its frontmatter status

  Scenario: Frontmatter status wins when the folder disagrees
    Given a file physically located in "tasks/todo"
    But its frontmatter status is "done"
    When the board scan runs
    Then the ticket is rendered in the "done" lane
    And reconciliation moves the file into "tasks/done"

  Scenario: Legacy flat-layout tickets are still found and reconciled
    Given a ticket file sits directly in "tasks/" (no subfolder) with status "testing"
    When the board scan runs
    Then the ticket appears in the "testing" lane
    And the file is relocated into "tasks/testing"

  Scenario: Writes and moves stay atomic during a poll
    Given the board poll fires every ~2.5 seconds
    When a ticket's status is changed with a whole-file write followed by an atomic move
    Then no poll observes a duplicated ticket in two folders
    And no poll observes a missing or half-written ticket

  Scenario: Reorder within the todo lane still works
    Given three tickets in "tasks/todo" with orders 1, 2, 3
    When the last ticket is dragged above the first
    Then the todo tickets are reindexed 1..N in the new sequence
    And every reordered ticket file remains under "tasks/todo"

  Scenario: Unknown-status tickets are not moved into a status folder
    Given a ticket whose frontmatter status is "archived" (out of enum)
    When the board scan runs
    Then the ticket is shown in the "unknown" lane
    And its file is not moved into any status subfolder

  Scenario: Edge — a destination name collision does not lose the ticket
    Given a ticket file must move into "tasks/done"
    But a file with the same name already exists in "tasks/done"
    When the move is attempted
    Then the collision is detected and handled
    And the ticket file is not silently deleted or lost
```

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
