---
id: TASK-080
title: Plain drag-to-Done must not resurrect a lingering wont-do resolution
status: done
created: 2026-07-19T21:33:22Z
updated: 2026-07-19T22:01:09Z
review-of: TASK-074
activities: [{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-19T21:53:54Z","finishedAt":"2026-07-19T21:54:57Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-19T21:54:57Z","finishedAt":"2026-07-19T21:58:00Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-19T21:58:00Z","finishedAt":"2026-07-19T22:01:09Z"},{"activity":"post-processing","model":"claude-opus-4-8","startedAt":"2026-07-19T22:01:09Z","finishedAt":"2026-07-19T22:01:09Z"}]
---

## Description
Follow-up from the tech-lead review of TASK-074 (Finding 1, Medium). TASK-074 added
the "Won't do" resolution (`status: done` + `resolution: wont-do`) reachable **only**
via the task-modal status select; plain drag-to-Done is supposed to mean "normal
done". But `moveTicketToStatus` (`renderer/renderer.js` ~6572-6601) builds the new
frontmatter with `newFm = Object.assign({}, fm)` and overwrites only `status`. It
never clears an existing `resolution: wont-do`.

Consequently this sequence silently re-flags a ticket won't-do without the modal:
1. User marks a ticket won't-do in the modal → file becomes `status: done` +
   `resolution: wont-do`.
2. User drags it to another lane (e.g. `in-progress`). `status` changes but
   `resolution: wont-do` lingers on disk.
3. User later drags it back onto Done via plain drag. The file becomes
   `status: done` + `resolution: wont-do` again, so `isWontDoTicket` re-fires and the
   card reappears struck-through — even though the user used a plain drag-to-Done.

This contradicts TASK-074's locked decision that "Won't do" is reachable only via the
modal and that plain drag-to-Done means normal done.

## Acceptance Criteria
- [ ] `moveTicketToStatus` clears any `resolution: wont-do` marker when it writes the
  moved ticket, so a plain drag never (re)produces a won't-do card. (Clearing only
  the exact `wont-do` value is sufficient and matches `doWrite`'s revert behavior;
  other `resolution` values, if any, round-trip untouched.)
- [ ] Dragging a won't-do ticket out of Done to another lane writes the new status
  with no `resolution: wont-do` marker remaining.
- [ ] Dragging that ticket back onto Done via plain drag yields a normal done card
  (no struck-through title, no `resolution: wont-do`).
- [ ] The modal "Won't do" path (`doWrite` mapping to `status: done` +
  `resolution: wont-do`) is unchanged and still works.
- [ ] The write remains a single whole-file `serializeTicket` write, `updated`
  bumped, `created` preserved, and the user-owned `## Additional Context` untouched.
- [ ] Tests: unit + e2e (`node --test`, Given/When/Then) cover the drag-out-then-back
  sequence and confirm no marker resurrection, plus the modal path still sets the
  marker. Green aside from the two known pre-existing unrelated failures
  (`test/task-030-plan-button.e2e.test.js`, `test/task-034-routing-drift-guard.test.js`).

## Cucumber Tests
```gherkin
Feature: Plain drag-to-Done never resurrects a wont-do marker

  Scenario: Dragging a wont-do ticket out then back to Done clears the marker
    Given a ticket with status "done" and resolution "wont-do"
    When the user drags it to the "in-progress" lane
    Then the written frontmatter has status "in-progress" and no "resolution: wont-do"
    When the user later drags it back onto the Done lane
    Then the written frontmatter has status "done" and no "resolution: wont-do"
    And the card renders with a normal (not struck-through) title

  Scenario: The modal Won't-do path still sets the marker (edge)
    Given a ticket open in the task modal
    When the user selects "Won't do" and saves
    Then the frontmatter has status "done" and resolution "wont-do"

  Scenario: A plain drag to Done on a normal ticket sets no resolution (edge)
    Given a normal ticket with no resolution
    When it is dragged onto the Done lane
    Then status is "done" and no resolution key is written
```

## Impact If Not Fixed
A user who declines a ticket, then reconsiders and drags it back into the workflow and
eventually back to Done, will see it silently re-flagged "won't do" (struck-through)
with no way to clear it except reopening the modal and re-picking Done. The board
misrepresents the ticket's true resolution, undermining the reliability of the
persistent won't-do marker introduced in TASK-074.

## Edge Cases & Failure Paths
- Only the exact trimmed value `wont-do` should be cleared by the drag path; any other
  `resolution` value round-trips untouched (consistent with `doWrite`).
- The change must not touch tickets that have no `resolution` key (no spurious key
  added or removed).
- Concurrent-edit / changed-on-disk behavior of the drag path is unchanged.

## Relevant Files & Context
- `renderer/renderer.js` — `moveTicketToStatus` ~6572-6601 (frontmatter build ~6586-6587);
  `doWrite` revert-clears-marker logic ~6211-6219 for the pattern to mirror;
  `isWontDoTicket` ~5233; `serializeTicket` ~5330.
- Test patterns: `test/wont-do.e2e.test.js` (the `dragMove` mirror), `test/wont-do.test.js`
  (source-scan style).
- Origin: tech-lead review of TASK-074, Finding 1 (Medium).

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
