---
id: TASK-055
title: harden the keepAwakeActive drift guard against a missing end-marker
status: done
created: 2026-07-19T04:22:00Z
updated: 2026-07-19T04:22:00Z
---

## Description
Follow-up from the TASK-050 tech-lead review (LOW — test robustness; contrived but real teeth
gap). The keepAwakeActive drift guard in `test/task-036-keep-awake.e2e.test.js` (~L464-465)
and `test/task-036-keep-awake.test.js` (~L228-230) slices the real `keepAwakeActive` region
as `mainSrc.slice(indexOf('function keepAwakeActive'), indexOf('function startKeepAwake'))`.
`String.indexOf` returns `-1` when the end marker `function startKeepAwake` is missing/renamed,
so `slice(start, -1)` yields nearly the whole rest of `main.js`. Because `stopKeepAwake` (and
`startKeepAwake`) contain the SAME three load-bearing tokens the guard asserts
(`keepAwakeBlockerId !== null` / `=== null`, `powerSaveBlocker.isStarted(keepAwakeBlockerId)`,
`try {`/`catch`), a gutted `keepAwakeActive` combined with a removed/renamed end marker could
FALSELY PASS. The only current bound is `region.length > 0`, which does not catch this.

## Acceptance Criteria
- [ ] The slice logic asserts the end marker `function startKeepAwake` is actually present
      (e.g. `indexOf(...) !== -1`) BEFORE slicing, OR otherwise bounds the region so a missing
      end marker cannot expand it into the rest of `main.js` — in BOTH
      `test/task-036-keep-awake.e2e.test.js` and `test/task-036-keep-awake.test.js`.
- [ ] Demonstrate the fail-mode: with the `function startKeepAwake` marker removed/renamed
      in an in-memory copy of the source, the guard FAILS (does not silently balloon and pass).
      Add an in-memory mutation case proving this.
- [ ] The guard still passes against the real `main.js`, and the existing TASK-050
      keepAwakeActive assertions and mutation cases (constant-return, dropped try/catch,
      dropped isStarted) remain green with real teeth.
- [ ] Only `test/task-036-keep-awake.*.test.js` change; no production source. Full suite
      passes under `node --test`.

## Cucumber Tests
```gherkin
Feature: The keepAwakeActive drift guard cannot balloon past its region

  Scenario: A missing end marker is caught, not silently absorbed
    Given main.js with the `function startKeepAwake` marker removed/renamed (in-memory)
    Then the keepAwakeActive drift guard fails rather than slicing the rest of the file

  Scenario: The real region still passes (edge)
    Given the real main.js
    Then the keepAwakeActive drift guard passes and its region is bounded to keepAwakeActive
```

## Relevant Files and Context
- `test/task-036-keep-awake.e2e.test.js` (~L437-507) — the keepAwakeActive slice + `assertKeepAwakeActiveWiring`.
- `test/task-036-keep-awake.test.js` (~L202-266) — the unit mirror of the same guard/slice.
- `main.js` — `function keepAwakeActive` (~L196-204) immediately followed by `function startKeepAwake`; `stopKeepAwake`/`startKeepAwake` share the same tokens (why an unbounded slice would false-pass). READ ONLY.

## Edge and Failure Cases
- End marker `function startKeepAwake` removed/renamed -> guard FAILS (currently could false-pass via `slice(start, -1)`).
- Benign reformatting/whitespace -> guard stays tolerant (token/marker based, not offsets).
- keepAwakeActive gutted AND end marker present -> existing mutation cases still catch it.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
