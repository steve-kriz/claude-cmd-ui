---
id: TASK-140
title: Cover the drop-after (before=false) branch in the filtered-reorder persistence test
status: done
created: 2026-07-21T10:54:15.000Z
updated: 2026-07-21T11:15:59.000Z
review-of: TASK-137
activities: [{"activity":"ba","model":"claude-fable-5","startedAt":"2026-07-21T10:54:15.000Z","finishedAt":"2026-07-21T10:54:15.000Z"},{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-21T11:11:00.000Z","finishedAt":"2026-07-21T11:11:00.000Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-21T11:11:00.000Z","finishedAt":"2026-07-21T11:13:54.000Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-21T11:13:54.000Z","finishedAt":"2026-07-21T11:15:45.000Z"},{"activity":"post-processing","model":"claude-opus-4-8","startedAt":"2026-07-21T11:15:45.000Z","finishedAt":"2026-07-21T11:15:59.000Z"}]
---

## Description

Tech-lead review of TASK-137 found the persistence half of
`test/task-137-reorder-while-filtered.e2e.test.js` only drives the real
`reorderTodoTicket` with `before = true` (drop-before). The `before = false`
(drop-after) branch — `list.splice(before ? targetIdx : targetIdx + 1, 0, dragged)`
at `renderer/renderer.js:~10208` — is exercised only in the wiring half against the
recorded stub, never against the REAL extracted function with on-disk persistence
assertions. TASK-137 is the only suite that extracts the real `reorderTodoTicket`
(TASK-007's `test/ticket-order.test.js` uses verbatim copies and never runs under a
filter), so no test verifies the full-list on-disk re-index for a drop-after while a
filter hides cards. This is TEST-ONLY (no production change expected) — add one
persistence-half scenario for the drop-after branch.

## Impact If Not Fixed

Low. A future off-by-one regression in the drop-after branch (dragged card landing
one slot off, or corrupting the full-list `order` on an after-drop while a filter
hides cards) would pass the TASK-137 suite green — leaving the exact latent-regression
class TASK-137 exists to guard against half-covered for the `before = false`
direction.

## Acceptance Criteria
- [ ] `test/task-137-reorder-while-filtered.e2e.test.js` (or a sibling
  `test/task-140-*.e2e.test.js`) adds a persistence-half scenario that calls the REAL
  extracted `reorderTodoTicket(tab, dragged, target, /* before */ false)` (e.g. with
  the same visible/hidden seed, drag TASK-701 to drop AFTER TASK-703) — using the
  same brace-extraction of the real function, not a copy/stub.
- [ ] The scenario asserts the resulting on-disk `order` values are a contiguous
  full-list 1..N with no duplicates, that hidden non-matching todo cards keep a
  consistent relative order (not a visible-subset re-index), and that a hidden card
  whose index is unchanged is not gratuitously rewritten.
- [ ] The computed expected order matches tracing the real splice branch
  `targetIdx + 1` for the chosen drag (state the expected map explicitly in the
  assertion).
- [ ] No production files change (test-only); the shared harness
  `test/helpers/task-101-lane-harness.js` and its recorded-stub `reorderTodoTicket`
  are not modified.
- [ ] All existing tests stay green; only the 2 known baseline failures remain.

## Cucumber Tests

```gherkin
Feature: Drop-after reorder while filtered re-indexes the full todo list

  Background:
    Given the todo lane seed (persisted order):
      | id       | order | matches "login" |
      | TASK-701 | 1     | yes             |
      | TASK-702 | 2     | no              |
      | TASK-703 | 3     | yes             |
      | TASK-704 | 4     | no              |
    And each ticket exists in the in-memory filesystem stub

  Scenario: Dropping a visible card AFTER another visible card re-indexes the full list
    Given the real reorderTodoTicket/persistTicketOrder extracted from renderer.js
    When reorderTodoTicket moves "TASK-701.md" to AFTER "TASK-703.md" (before = false)
    Then the persisted order read back from disk is:
      | id       | order |
      | TASK-702 | 1     |
      | TASK-703 | 2     |
      | TASK-701 | 3     |
      | TASK-704 | 4     |
    And the orders form a contiguous 1..N sequence with no duplicates
    And the hidden ticket "TASK-702" still sorts before the hidden ticket "TASK-704"

  Scenario (edge): a hidden card whose index is unchanged is not rewritten
    Given the same drop-after reorder
    Then any hidden ticket whose computed index equals its stored order has
      byte-identical file content on disk (persistTicketOrder skip-write)
```

## Edge Cases and Failure Modes
- **Trace the real splice**: with the seed above and drag 701 after 703, sorted
  `[701,702,703,704]` → remove 701 → `[702,703,704]` → splice at `targetIdx+1`
  (703 is at index 1 → insert at 2) → `[702,703,701,704]` → orders 702=1,703=2,
  701=3,704=4. Assert this explicit map (adjust if the chosen drag differs, but state
  it).
- **No duplicate orders**: the corruption signature is a visible-subset re-index
  leaving two cards at the same order — assert `new Set(orders).size === orders.length`.
- **Skip-write**: a card whose index is unchanged must not be rewritten (byte-identical,
  fresh `updated` would otherwise change it).
- **Test-only**: do not modify renderer.js or the shared harness.
- **Baseline noise**: only the 2 known baseline failures may remain.

## Relevant Files and Context
- `test/task-137-reorder-while-filtered.e2e.test.js` — the persistence half (`before=true`
  scenario ~:254) to mirror for `before=false`; `loadPersistModule` (~:153-168)
  brace-extracts the real functions.
- `renderer/renderer.js:~10195` `reorderTodoTicket` — the splice branch at ~:10208
  (`before ? targetIdx : targetIdx + 1`); `persistTicketOrder` ~:10162 (skip-write +
  fresh `updated`).
- `test/helpers/task-101-lane-harness.js` — recorded-stub `reorderTodoTicket` (~:222);
  do NOT modify.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
