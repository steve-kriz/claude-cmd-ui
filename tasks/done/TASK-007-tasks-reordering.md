---
id: TASK-007
title: tasks reordering
status: done
created: 2026-07-18T04:12:25.743Z
updated: 2026-07-18T05:49:14Z
---

## Description
Let the user control the order in which queued tasks run by dragging and
dropping cards to reorder them **within the `todo` column**. The chosen order
must determine which ticket the build picks up next.

Today cards are rendered sorted by numeric `id` (`renderTasksBoard` in
`renderer.js`), and drag-and-drop only moves a card **between** lanes
(`moveTicketToStatus`) — there is no intra-lane ordering, and the build loop
picks the "oldest `id` first" (SKILL Phase 2). To make a user-defined order
stick across the 2.5s board polls and drive the build, the order must be
persisted per ticket (e.g. an `order`/`priority` frontmatter field, which
`serializeTicket` preserves as an unknown key) rather than held only in the DOM.
Reordering is scoped to `todo`; dropping a card into a different lane still
changes its status as it does now. The build's pick-next logic must honour the
persisted `todo` order instead of raw `id` order.

## Acceptance Criteria
- [x] Cards within the `todo` lane can be reordered by dragging one card above or below another within that lane.
- [x] The new order is persisted to the ticket files (whole-file writes) so it survives board polling and app restarts.
- [x] After reordering, the `todo` lane renders cards in the user-defined order rather than strictly by numeric `id`.
- [x] The build's "pick next ticket" logic follows the user-defined `todo` order (the top-of-lane ticket runs next).
- [x] Reordering only changes order, not status: a card reordered within `todo` keeps `status: todo`.
- [x] Dragging a card out of `todo` into another lane still changes its status (existing cross-lane behaviour is preserved).
- [x] Persisting order preserves every other section and the user-owned `## Additional Context`, and bumps `updated` while preserving `created`.
- [x] Tickets without an explicit order value still render deterministically (e.g. fall back to `id` order) rather than jumping around.

## Cucumber Tests
```gherkin
Feature: Reorder todo tickets by drag and drop

  Background:
    Given the Tasks board is open
    And the "todo" lane contains TASK-601, TASK-602, and TASK-603 in that order

  Scenario: Dragging a card changes the order within todo
    When the user drags TASK-603 above TASK-601 within the "todo" lane
    Then the "todo" lane order becomes TASK-603, TASK-601, TASK-602

  Scenario: The new order persists across polling
    Given the user has reordered "todo" to TASK-603, TASK-601, TASK-602
    When the board polls again
    Then the "todo" lane still shows TASK-603, TASK-601, TASK-602

  Scenario: The new order persists across restart
    Given the user has reordered "todo" to TASK-603, TASK-601, TASK-602
    When the app is restarted and the board reloads from disk
    Then the "todo" lane still shows TASK-603, TASK-601, TASK-602

  Scenario: The build picks the top-of-lane ticket next
    Given the "todo" lane order is TASK-603, TASK-601, TASK-602
    When the build picks the next ticket
    Then it picks TASK-603

  Scenario: Reordering does not change status
    When the user reorders TASK-603 within the "todo" lane
    Then TASK-603 still has status "todo"

  Scenario: Cross-lane drag still changes status
    When the user drags TASK-601 from "todo" into the "in-progress" lane
    Then TASK-601's status becomes "in-progress"

  Scenario: Tickets without an explicit order render deterministically
    Given TASK-604 exists in "todo" with no order value
    When the board renders repeatedly
    Then TASK-604 keeps a stable position rather than jumping between renders
```

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
