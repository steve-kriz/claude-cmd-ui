---
id: TASK-102
title: Status-change plumbing for user columns - drag/drop, modal dropdown, folder reconciliation
status: done
created: 2026-07-20T13:15:00Z
updated: 2026-07-20T23:48:07.735Z
order: 13
activities: [{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-20T21:58:00Z","finishedAt":"2026-07-20T23:30:16Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-20T22:00:00Z","finishedAt":"2026-07-20T23:43:24Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-20T22:02:00Z","finishedAt":"2026-07-20T23:48:07Z"}]
---

## Description
Make user statuses fully usable: (a) the ticket modal's hardcoded status `<select>`
(`index.html` 47–55) is built dynamically from the config (system labels + user columns + the
existing "Won't do" `__wont-do__` special entry); (b) drag-and-drop onto any configured lane
(incl. user lanes) writes the ticket's `status` via the existing whole-file `serializeTicket`
+ `fs.writeFile` path, bumping `updated`; (c) folder reconciliation
(`relocateTicketFile`/`reconcileTicketFolders`, renderer 5784–5821) becomes config-aware per
TASK-099 so `tasks/<user-slug>/` folders are created on demand and files move to match
frontmatter; removed-column statuses are left in place (target null).

## Clarifications
- Q1: user statuses are real ticket statuses, set manually via board/modal only (the swarm never sets them — TASK-100). Reasoned default: dropping a claimed/active ticket into a user lane is blocked with a notice (prevents yanking a ticket out from under a live agent); otherwise a status write is a user override as today for system lanes.

## Acceptance Criteria
- [ ] Ticket modal status dropdown lists all configured columns in board order using their labels (values = slugs), plus `failed-testing` folding rules unchanged and the `__wont-do__` entry preserved; selecting a user status saves it to frontmatter via whole-file write.
- [ ] Dragging a card onto a user lane sets its status to that slug (single whole-file write, `updated` bumped); the card renders in that lane on next poll.
- [ ] Reconciliation moves a user-status ticket into `tasks/<slug>/` (mkdir on demand, atomic `fs:rename`, collision-safe exactly like today, 5776–5796).
- [ ] A ticket whose status's column was removed is not moved and renders in `unknown` (no data loss, no writes).
- [ ] Tickets in user statuses never show the active dot, never trigger keep-awake, and never count in the working indicator (system sets unchanged).
- [ ] Dragging an actively-worked (`defining`/`in-progress`/`testing` with claim) ticket into a user lane is refused with a visible notice and no write.
- [ ] Unit + e2e tests (`task-102-*` pair).

## Cucumber Tests
```gherkin
Feature: User-column status changes
  Scenario: Drag a ticket into a user lane
    Given a todo ticket and a configured ux-review lane
    When the user drops the card on ux-review
    Then the ticket file is rewritten once with status "ux-review" and updated bumped
    And reconciliation files it under tasks/ux-review/

  Scenario: Modal dropdown is config-driven
    Given config with seven columns
    Then the status select lists them in board order plus "Won't do"

  Scenario: Removed column ticket (edge)
    Given a ticket with status "ux-review" after that column was removed
    Then it renders in the unknown lane and its file is never moved or rewritten

  Scenario: Cannot yank an active ticket (failure)
    Given an in-progress ticket claimed by an agent
    When the user drops it on a user lane
    Then the drop is refused with a notice and no write occurs
```

## Edge Cases & Failure Paths
- `fs:rename` collision (existing no-overwrite behavior + dedupe); drop during a poll re-render (re-query lanes at drop time); slug/folder name collisions prevented by TASK-097 validation; `__wont-do__` flow untouched (see `test/wont-do.test.js`).

## Relevant Files & Context
- `renderer/index.html` 42–73 (task modal).
- `renderer/renderer.js` — modal save path near `serializeTicket` 5365, DnD handlers (`.tasks-lane.drag-over` styles 2772–2773), relocate/reconcile 5776–5821, active-dot logic 5965–5966, keep-awake 6083.
- `lib/ticket-folders.js` extensions (TASK-099, mirrored).

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
