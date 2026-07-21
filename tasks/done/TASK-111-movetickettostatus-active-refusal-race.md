---
id: TASK-111
title: Re-check active/claim against fresh frontmatter in moveTicketToStatus
status: done
created: 2026-07-21T02:07:59.621Z
updated: 2026-07-21T03:07:14.984Z
review-of: TASK-102
activities: [{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-21T02:20:00Z","finishedAt":"2026-07-21T02:28:53Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-21T02:35:00Z","finishedAt":"2026-07-21T03:03:40Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-21T02:54:00Z","finishedAt":"2026-07-21T03:07:14Z"}]
---

## Description
`renderer/renderer.js` `attachTasksLaneDrop` refuses dropping an actively-worked, claimed ticket into a user lane, but its guard reads the last-polled in-memory snapshot (`tab.tasks.tickets.get(file)`). `moveTicketToStatus` then re-reads fresh on-disk frontmatter (to avoid clobbering the body) but does NOT re-apply the active/claim refusal against that fresh data before writing. If an agent claims the ticket on disk in the window between the last poll and the drop, the drop passes the stale guard and `moveTicketToStatus` overwrites `status` anyway.

**Fix:** inside `moveTicketToStatus`, after the fresh read resolves `fm`, and only when `newStatus` is a configured USER status (`tasksUserStatusSet(normalizeTasksColumns(tab.tasks.config))`, mirroring the drop guard), refuse the move when the FRESH `fm.status` is in `TASKS_ACTIVE_STATUSES` AND `ticketFieldNonEmpty(fm.agent)`: show the same `showTasksNotice` message, force a re-poll (`pollTasksOnce(tab, true)`), and return with NO write/rename/relocate. Keep the existing stale-snapshot drop guard as the fast path. System-lane targets and the happy path are unchanged.

Severity from review: **major**. This is a review follow-up of TASK-102.

## Acceptance Criteria
- [ ] `moveTicketToStatus` evaluates the active/claim refusal against the FRESH frontmatter from its on-disk re-read, after the read and before any `writeFile`.
- [ ] The refusal fires only when ALL of: `newStatus` is in the live user-status set (`tasksUserStatusSet(normalizeTasksColumns(tab.tasks.config))`), fresh `fm.status` is in `TASKS_ACTIVE_STATUSES` (`defining`/`in-progress`/`testing`), and `ticketFieldNonEmpty(fm.agent)`.
- [ ] On refusal: `showTasksNotice` is called once naming the fresh `fm.id` (fallback `This ticket`) and the claiming agent, matching the drop-guard wording; NO write/rename/relocate; file content and location unchanged; `pollTasksOnce(tab, true)` is invoked.
- [ ] Happy path unchanged: moving an unclaimed ticket to a user lane still does exactly one whole-file write (updated bumped, created + body incl. `## Additional Context` preserved) then one atomic relocate.
- [ ] System-lane targets unchanged: a move to a system status (e.g. `done`, `todo`) proceeds even when fresh fm is active+claimed (manual override intended), including the bug-modal `moveTicketToStatus(tab, file, 'todo')` caller.
- [ ] Active-but-UNCLAIMED (empty/whitespace agent) or claimed-but-not-active (e.g. `done` with lingering agent) is NOT refused.
- [ ] Fresh read failure/unparseable degrades to today's behavior (guard evaluated against the fallback snapshot fm); no new failure mode.
- [ ] The existing `attachTasksLaneDrop` stale-snapshot guard is retained unmodified and its e2e refusal scenario still passes.
- [ ] New tests (TASK-102 renderer source-extraction / mock-fs style) cover the race refusal, system-lane override, and unclaimed-fresh pass-through; full `node --test` suite passes modulo the 2 known-baseline failures.

## Cucumber Tests
```gherkin
Feature: moveTicketToStatus re-checks active/claim refusal against fresh on-disk frontmatter

  Scenario: Race refusal — a claim landed on disk after the last poll (failure)
    Given the in-memory snapshot of TASK-9 says status "todo" with no agent
    And the on-disk frontmatter of TASK-9 says status "in-progress" with agent "orch-42"
    When moveTicketToStatus is called with target status "ux-review"
    Then a single notice is shown naming "TASK-9" and "orch-42"
    And no file write, rename, or mkdir occurs
    And tasks/todo/TASK-9.md is byte-identical to before
    And a forced board re-poll is requested

  Scenario: Happy path unchanged — unclaimed ticket moves to a user lane
    Given on-disk and in-memory frontmatter of TASK-9 both say status "todo" with no agent
    When moveTicketToStatus is called with target status "ux-review"
    Then the file is rewritten exactly once with status "ux-review" and a bumped "updated"
    And it is relocated into tasks/ux-review/ by a single atomic rename
    And no refusal notice is shown

  Scenario: System-lane target overrides a live claim (unchanged)
    Given the on-disk frontmatter of TASK-9 says status "in-progress" with agent "orch-42"
    When moveTicketToStatus is called with target status "done"
    Then the move proceeds (status "done", relocated into tasks/done/) with no refusal notice

  Scenario: Fresh frontmatter active but unclaimed — move proceeds (edge)
    Given the on-disk frontmatter of TASK-9 says status "in-progress" with agent "   "
    When moveTicketToStatus is called with target status "ux-review"
    Then the move proceeds and no refusal notice is shown

  Scenario: Fresh read fails — degrade to snapshot guard (edge)
    Given the in-memory snapshot of TASK-9 says status "todo" with no agent
    And window.api.fs.readFile returns { ok: false } for the ticket path
    When moveTicketToStatus is called with target status "ux-review"
    Then the move proceeds from the snapshot copy exactly as today
```

## Edge Cases & Failure Paths
- Fresh read failure/binary/unparseable: existing try/catch fallback leaves `fm` as snapshot; guard evaluates snapshot — same as today, no crash.
- Claimed-but-not-active (`done` + lingering agent): not refused. Active-but-unclaimed (missing/empty/whitespace agent): not refused (`ticketFieldNonEmpty` gates whitespace).
- System-lane target while freshly claimed: proceeds (intentional override), incl. bug-modal `'todo'` caller.
- Config changed mid-flight: compute the user-status set from live `tab.tasks.config` at move time.
- Missing fresh `fm.id`: notice falls back to `This ticket`.
- Early no-op `if (ticket.fm.status === newStatus) return;` unchanged.
- Test-harness gotcha: the e2e fs harness extracts `moveTicketToStatus` but does not stub `showTasksNotice` — add a recording stub or the extracted fn throws ReferenceError.

## Relevant Files & Context
- `renderer/renderer.js`: `moveTicketToStatus` (insert the fresh guard between the fresh-read block and the `Object.assign`/write; `tab` is in scope for config/notice/poll); `attachTasksLaneDrop` stale-snapshot guard (mirror its notice wording + id/who derivation; KEEP it); `TASKS_ACTIVE_STATUSES`; `ticketFieldNonEmpty`; `showTasksNotice`; `tasksUserStatusSet` + `normalizeTasksColumns`; the bug-modal caller `moveTicketToStatus(tab, file, 'todo')` (must remain unaffected). Optionally factor the shared active+claimed predicate/message into one helper so wording can't drift.
- `test/task-102-status-change.e2e.test.js`: the harness to follow — `loadFsModule` brace-extracts the REAL functions over a Map-backed mock fs; `seedTicket` can seed disk and snapshot INDEPENDENTLY (write divergent disk content to simulate the race); the drop-refusal scenario is the notice/no-write pattern. Add a `showTasksNotice` recording stub to the loader.
- `test/task-102-status-change.test.js`, `test/helpers/task-101-lane-harness.js`: unit counterpart + shared DOM harness (already stubs showTasksNotice / moveTicketToStatus).
- Tests: plain `node --test`; 2 known-baseline failures unrelated.

## Impact If Not Fixed
In the narrow window between an agent's on-disk claim and the next board poll, a manual drop can silently override a live agent's status, potentially corrupting an in-flight orchestrate run's state and losing the claim — the exact hazard the refusal guard was built to prevent.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
