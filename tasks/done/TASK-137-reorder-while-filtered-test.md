---
id: TASK-137
title: Test intra-todo reorder while the board search filter is active
status: done
created: 2026-07-21T09:01:45.000Z
updated: 2026-07-21T10:54:15.000Z
review-of: TASK-132
activities: [{"activity":"ba","model":"claude-fable-5","startedAt":"2026-07-21T09:49:30.000Z","finishedAt":"2026-07-21T09:52:30.000Z"},{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-21T10:45:04.000Z","finishedAt":"2026-07-21T10:45:04.000Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-21T10:45:04.000Z","finishedAt":"2026-07-21T10:50:53.000Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-21T10:50:53.000Z","finishedAt":"2026-07-21T10:54:00.000Z"},{"activity":"post-processing","model":"claude-opus-4-8","startedAt":"2026-07-21T10:54:00.000Z","finishedAt":"2026-07-21T10:54:15.000Z"}]
---

## Description

Tech-lead review of TASK-132 found a test-coverage gap: the e2e suite
(`test/task-132-board-search.e2e.test.js`) covers a filtered *cross-lane* drag
(todo→defining, via the recorded `moveTicketToStatus` stub) but not the intra-`todo`
reorder path (`reorderTodoTicket`, `renderer/renderer.js` ~:10184) while a filter
hides some todo cards — an edge case TASK-132 explicitly calls out ("a filtered drag
must not corrupt the order of hidden cards"). The implementation is correct: it
re-indexes the FULL todo list from `tab.tasks.tickets` (never the DOM), sorted by
`compareTicketOrder`, persisting `order` 1..N through `persistTicketOrder` (~:10151,
which skip-writes unchanged orders). But that invariant is asserted only by
pre-existing TASK-007 tests (`test/ticket-order.test.js`) which (a) run against
VERBATIM COPIES of the functions, not the shipped source, and (b) never run under a
filter. No production code change is expected — this ticket adds the missing
regression test in a new file `test/task-137-reorder-while-filtered.e2e.test.js`,
covering both halves:

1. **Wiring half** — through the real render/drag path (`loadLaneModule` from
   `test/helpers/task-101-lane-harness.js`, where `reorderTodoTicket` is a recorded
   stub): with the filter hiding some todo cards, dragstart on one visible todo card
   and drop on the other fires exactly one recorded `reorderTodoTicket` call with the
   correct `{ dragged, target, before }`.
2. **Persistence half** — the REAL `reorderTodoTicket` + `persistTicketOrder`,
   brace-extracted from `rendererSrc` (the harness exports it; mirror the inline
   extraction pattern task-132's "switching folders" test uses), evaluated via
   `new Function` against an in-memory `window.api.fs` stub and a `tab.tasks.tickets`
   map containing BOTH visible and filter-hidden todo tickets: after reordering the
   two "visible" files, every todo ticket's persisted `order` reflects the full-list
   1..N re-index, hidden tickets keep their relative positions, and a hidden ticket
   whose index did not change is not rewritten at all.

## Impact If Not Fixed

Low. A future change to `reorderTodoTicket` or the render/drag wiring could silently
start reordering only the visible subset (corrupting hidden cards' persisted `order`)
with no failing test to catch it. Risk is a latent regression, not a current defect.

## Acceptance Criteria

- [ ] A new test file `test/task-137-reorder-while-filtered.e2e.test.js` exists,
  runs under plain `node --test` (no cucumber package), and follows the mocked-e2e
  conventions of `test/task-132-board-search.e2e.test.js` (in-memory DOM +
  `window.api.fs` stub; NO real disk/DB/network beyond reading `renderer.js` source).
- [ ] Wiring scenario: with a board of ≥4 todo tickets where the active search query
  matches only 2, the todo lane DOM contains exactly the 2 matching cards; firing
  `dragstart` on one visible todo card and `drop` on the other records exactly one
  `reorderTodoTicket` call with the expected `{ dragged, target, before }`.
- [ ] Persistence scenario: the REAL `reorderTodoTicket`/`persistTicketOrder`
  (brace-extracted from `rendererSrc`, not copied/stubbed/re-implemented) is invoked
  for two "visible" todo files while `tab.tasks.tickets` also contains filter-hidden
  todo tickets; parsing the resulting on-disk frontmatter shows ALL todo tickets'
  `order` values are the contiguous full-list re-index 1..N with no duplicates.
- [ ] The same scenario asserts hidden tickets' relative order is preserved
  (e.g. seed A=1 visible, B=2 hidden, C=3 visible, D=4 hidden; drag C before A;
  expect C=1, A=2, B=3, D=4 — B still before D, interleaved correctly).
- [ ] Edge assertion: a hidden todo ticket whose index is unchanged by the reorder
  (D=4 above) is NOT rewritten — its on-disk file content (including `updated`) stays
  byte-identical, proving `persistTicketOrder`'s skip-write and that hidden cards are
  never gratuitously touched.
- [ ] A failure/no-op scenario: calling the real `reorderTodoTicket` with a dragged
  or target file that is not status `todo` (or dragged === target) performs zero
  writes — every seeded file stays byte-identical.
- [ ] The test exercises the REAL `reorderTodoTicket` source path — extracted from
  `renderer/renderer.js` at test run time so it cannot drift — not a stub or a
  verbatim copy.
- [ ] All existing tests stay green; only the 2 known baseline failures remain.
- [ ] No production files are modified (test-only change; `renderer/renderer.js` and
  `test/helpers/task-101-lane-harness.js` untouched — the harness's `reorderTodoTicket`
  recorder stub at line ~222 must keep working for other suites).

## Cucumber Tests

```gherkin
Feature: Intra-todo reorder while the board search filter is active
  The Tasks board search filter hides non-matching cards from the DOM, but
  reordering two visible todo cards must re-index the FULL todo list from
  tab.tasks.tickets, so hidden cards' persisted `order` is never corrupted.

  Background:
    Given the todo lane contains, in persisted order:
      | id       | title        | order | matches "login" |
      | TASK-701 | login alpha  | 1     | yes             |
      | TASK-702 | misc beta    | 2     | no              |
      | TASK-703 | login gamma  | 3     | yes             |
      | TASK-704 | misc delta   | 4     | no              |
    And each ticket exists as a .md file in the in-memory filesystem stub

  Scenario: A filtered drop on a visible card reaches reorderTodoTicket with full-list semantics
    Given the board is rendered and I have typed "login" into the Tasks search box
    And only the cards "TASK-701" and "TASK-703" are present in the todo lane DOM
    When I drag the card "TASK-703" and drop it on the upper half of "TASK-701"
    Then exactly one reorderTodoTicket call is recorded
    And it carries dragged "TASK-703.md", target "TASK-701.md" and before = true

  Scenario: Reordering two visible cards re-indexes the FULL todo list on disk
    Given the real reorderTodoTicket and persistTicketOrder extracted from renderer.js
    When reorderTodoTicket moves "TASK-703.md" before "TASK-701.md"
    Then the persisted `order` values read back from disk are:
      | id       | order |
      | TASK-703 | 1     |
      | TASK-701 | 2     |
      | TASK-702 | 3     |
      | TASK-704 | 4     |
    And the orders form a contiguous 1..N sequence with no duplicates

  Scenario (edge): Hidden non-matching cards keep a consistent full-list order and untouched files are not rewritten
    Given the same filtered reorder of "TASK-703" before "TASK-701"
    Then the hidden ticket "TASK-702" still sorts before the hidden ticket "TASK-704"
    And the hidden ticket "TASK-704", whose index is unchanged, has byte-identical
      file content on disk (no write, `updated` untouched)
    And the hidden ticket "TASK-702", whose index changed from 2 to 3, was rewritten
      with `order: 3` and its status still "todo"

  Scenario (failure): A non-todo participant or self-drop writes nothing
    Given "TASK-705" exists with status "in-progress"
    When reorderTodoTicket is called with dragged "TASK-705.md" and target "TASK-701.md"
    Then no file on the in-memory disk is modified
    When reorderTodoTicket is called with dragged "TASK-701.md" and target "TASK-701.md"
    Then no file on the in-memory disk is modified
```

## Edge Cases and Failure Modes

- **Hidden-card index unchanged → no write.** `persistTicketOrder` returns false
  when `String(fm.order) === String(order)` (~:10164); the test must assert
  byte-identical file content for that ticket, not merely the same order value, to
  prove hidden cards are not gratuitously rewritten.
- **Hidden-card index changed → rewritten correctly.** A hidden card between the two
  visible ones (TASK-702) legitimately shifts 2→3; the corruption signature the test
  guards against is a visible-subset re-index (which would leave two tickets at the
  same order — assert no duplicate orders).
- **Guard clauses write nothing.** Non-todo dragged/target, dragged === target, or a
  target missing from the list all return early (~:10186-10196); cover at least the
  non-todo and self-drop cases with a zero-writes assertion.
- **`order` is persisted as a string** (`newFm.order = String(order)`) — compare
  string-normalized values when reading frontmatter back.
- **Module-level drag state leaks between tests.** `draggingTaskFile` /
  `draggingTaskStatus` are module-level; build a fresh module per scenario (the
  `fresh()` pattern in task-132's test).
- **`fire()` awaits handlers, but the drop handler does not await `reorderTodoTicket`**
  (fire-and-forget at ~:10205). In the wiring half the stub records synchronously so
  this is safe; do not try to await real persistence through the DOM drop.
- **Do not modify the shared harness.** Swapping the harness's `reorderTodoTicket`
  stub for the real function would break `test/ticket-order.test.js` source-scan
  assumptions and other suites; keep the two halves in the new test file instead.
- **Brace-extraction must pick up the `async` prefix** (both functions are
  `async function`).
- **Baseline noise.** Two pre-existing `node --test` failures are known unrelated
  baseline noise; the "all green" criterion excludes exactly those two.

## Relevant Files and Context

- `renderer/renderer.js` — read-only reference:
  - `reorderTodoTicket(tab, draggedFile, targetFile, before)` ~:10184 — full-list
    re-index from `tab.tasks.tickets` filtered to status `todo`, sorted by
    `compareTicketOrder`, then `persistTicketOrder(tab, list[i].file, i + 1)`;
    `pollTasksOnce(tab, true)` only when something was written.
  - `persistTicketOrder(tab, file, order)` ~:10151 — fresh read → skip-write when
    unchanged → whole-file write of `order` (string) + `updated`.
  - Card drag wiring inside `renderTasksBoard` ~:9183-9207 — dragover/drop only on
    todo cards; drop calls `reorderTodoTicket(tab, dragged, tk.file, before)`;
    `before` = pointer in upper half (mock height 10).
  - Filter skip `if (!taskMatchesSearch(tk, searchQuery)) continue;` ~:9141.
  - Helpers referenced by the extracted functions: `compareTicketOrder`,
    `ticketOrderValue`, `parseTicketFrontmatter`, `serializeTicket`, `taskMatchesSearch`.
- `test/helpers/task-101-lane-harness.js` — shared harness: `loadLaneModule` (real
  render/drag path; `reorderTodoTicket` is a recorded stub at ~:222 →
  `window.__calls.reorderTodoTicket`), exported `rendererSrc`, `makeWindow`,
  `makeDocument`, `makeTab`, `ticketsMap`, `fire`, `findByClass`/`findAllByClass`,
  `laneEls`. Do NOT modify.
- `test/task-132-board-search.e2e.test.js` — the style template: `fresh()`, `type()`,
  `lane()`, `cardIdsIn()`, the "drag and drop still works while filtered" scenario
  (cross-lane) this complements, and the inline brace-extraction pattern for the
  persistence half.
- `test/ticket-order.test.js` — TASK-007 suite to mirror for disk assertions; note
  its functions are verbatim copies — the new test must extract instead.
- New file to create: `test/task-137-reorder-while-filtered.e2e.test.js`.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
