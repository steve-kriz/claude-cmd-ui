---
id: TASK-053
title: tighten the render-process-gone keep-awake drift-guard slice to its own handler
status: done
created: 2026-07-19T03:45:00Z
updated: 2026-07-19T06:12:45.545Z
order: 1
---

## Description
Follow-up from the TASK-049 tech-lead review (LOW — test robustness; not blocking).
The source-scan drift guard in `test/task-036-keep-awake.e2e.test.js` (~L473-486) asserts
that both the `render-process-gone` and `unresponsive` `webContents` handlers in `main.js`
reset the wake-lock via `updateKeepAwake(0)`. For the `render-process-gone` check it slices
a FIXED `goneStart + 200` character window from the source. Because the `render-process-gone`
handler sits immediately before the `unresponsive` handler in `main.js` (`createWindow`,
~L133-140), that 200-char window bleeds into the `unresponsive` handler's own
`updateKeepAwake(0)` call. Consequence: if someone deleted the `updateKeepAwake(0)` call from
the `render-process-gone` handler but left it in `unresponsive`, this specific slice could
still falsely match and pass. The regression is not fully masked (the separate `unresponsive`
guard is sliced AFTER the gone handler and would still fail), so this is LOW — a guard-teeth
tightening, not a correctness defect.

## Acceptance Criteria
- [ ] Bound the `render-process-gone` drift-guard slice to the `render-process-gone` handler
      ONLY — e.g. end the slice at the index of `wc.on('unresponsive'` (or the next handler
      boundary) instead of a fixed `+200` characters — so the assertion cannot be satisfied by
      the `unresponsive` handler's `updateKeepAwake(0)`.
- [ ] Demonstrate the fail-mode reasoning: removing `updateKeepAwake(0)` from ONLY the
      `render-process-gone` handler (leaving it in `unresponsive`) now makes the guard FAIL.
      Add/adjust an in-memory mutation case that proves this if practical.
- [ ] The `unresponsive` drift guard remains tight and still passes; both handlers are still
      independently pinned to `updateKeepAwake(0)`.
- [ ] Only `test/task-036-keep-awake.e2e.test.js` (and `test/task-036-keep-awake.test.js` if
      it shares the slice logic) changes; no production source. Full suite passes under
      `node --test`.

## Cucumber Tests
```gherkin
Feature: The render-process-gone drift guard is scoped to its own handler

  Scenario: The gone-handler slice does not bleed into the unresponsive handler
    Given main.js with updateKeepAwake(0) removed from ONLY the render-process-gone handler
    Then the render-process-gone drift guard fails

  Scenario: Both handlers independently pinned (edge)
    Given the real main.js with both handlers resetting via updateKeepAwake(0)
    Then both the render-process-gone and unresponsive drift guards pass
```

## Relevant Files and Context
- `test/task-036-keep-awake.e2e.test.js` — the drift guard (~L473-486). Replace the fixed
  `goneStart + 200` window with a boundary derived from the next-handler index
  (`wc.on('unresponsive'`).
- `main.js` — `createWindow` (~L120-146): the `render-process-gone` handler immediately
  precedes the `unresponsive` handler; both call `updateKeepAwake(0)`. READ ONLY — do not
  change production source.

## Edge and Failure Cases
- `updateKeepAwake(0)` removed from the gone handler only -> guard FAILS (currently could
  falsely pass).
- Benign reformatting/whitespace between the two handlers -> guard should stay tolerant
  (match on handler boundaries / load-bearing tokens, not exact offsets).
- Handler order swapped in future -> boundary-based slice should still isolate each handler.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
