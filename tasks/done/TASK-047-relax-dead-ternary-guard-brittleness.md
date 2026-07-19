---
id: TASK-047
title: make the task-045 dead-ternary guard tolerant of legitimately-added call sites
status: done
created: 2026-07-19T02:26:00Z
updated: 2026-07-19T03:50:00Z
---

## Description
Follow-up from the TASK-046 tech-lead review (LOW — optional robustness; not blocking).
The tightened guards in `test/task-045-dead-ternary.test.js` and
`test/task-045-dead-ternary.e2e.test.js` assert an EXACT occurrence count
(`count === 2`) of `shouldWarn(originalId, id, bugFoldedTargets)` in
`test/task-042-bug-multitarget-switch.e2e.test.js`, and pin L127 with a comment-anchor
regex (`refresh switch warning after committing a fold` + `warningVisible = shouldWarn(...)`).
Both are exact/over-fit: a LEGITIMATE future third call to `shouldWarn(originalId, id, bugFoldedTargets)`
would push the count to 3 and false-fail, and a harmless reword of the anchor comment
would break `L127_ANCHOR` even though the call still exists. This is the inherent
tradeoff of a drift guard; the current form is correct and provably catches the
L127-masked-by-L92 regression, so this is a nice-to-have hardening, not a defect.

## Acceptance Criteria
- [ ] Relax the occurrence-count assertion from exact `=== 2` to `>= 2` (or count the L92
      change-listener call and the L127 refresh call independently) so a legitimately-added
      third call site does not false-fail, WITHOUT losing the property that removing the
      L127 site alone is still detected.
- [ ] Relax the comment-anchor regex to the load-bearing tokens (e.g. the `warningVisible = shouldWarn(...)`
      refresh line plus a minimal stable fragment) so a harmless comment reword does not
      false-fail, while still uniquely anchoring L127 vs the identical L92 call.
- [ ] The existing mutation test (remove-L127-only -> guard fails) still passes and still
      proves teeth; the DEAD_TERNARY and residual `bugFoldedTargets.size ?` guards are preserved.
- [ ] Add/adjust a mutation case proving the relaxed guard STILL fails when L127 is removed
      AND does NOT false-fail when a benign extra call site or comment reword is simulated in-memory.
- [ ] Only `test/task-045-dead-ternary.test.js` and/or `test/task-045-dead-ternary.e2e.test.js`
      change; no production source, no other test files. Full suite passes under `node --test`.

## Cucumber Tests
```gherkin
Feature: The dead-ternary guard tolerates benign changes but still catches L127 removal

  Scenario: A legitimately-added third shouldWarn call does not false-fail
    Given the target with a benign extra shouldWarn(originalId, id, bugFoldedTargets) call (simulated in-memory)
    Then the relaxed guard still passes

  Scenario: Removing only the L127 call still fails (teeth preserved, edge)
    Given the target with only the L127 comment+call removed in-memory
    Then the relaxed guard fails
```

## Relevant Files and Context
- `test/task-045-dead-ternary.test.js` — occurrence-count (`=== 2`) + `L127_ANCHOR` guards + mutation test.
- `test/task-045-dead-ternary.e2e.test.js` — same guards in cucumber form.
- `test/task-042-bug-multitarget-switch.e2e.test.js` — target (identical call at L92 and L127; anchor comment at L126).

## Edge and Failure Cases
- Benign third call site added -> relaxed guard passes (no false fail).
- Anchor comment reworded -> relaxed guard still passes if the call remains.
- L127 call removed (L92 remains) -> relaxed guard STILL fails.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
