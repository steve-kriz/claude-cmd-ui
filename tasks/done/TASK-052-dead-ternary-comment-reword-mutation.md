---
id: TASK-052
title: add a comment-reword mutation case to the task-045 dead-ternary guard
status: done
created: 2026-07-19T03:35:00Z
updated: 2026-07-19T04:20:00Z
---

## Description
Follow-up from the TASK-047 tech-lead review (LOW — test-coverage gap; not blocking).
TASK-047 relaxed the L127 comment-anchor in `test/task-045-dead-ternary.test.js` and
`test/task-045-dead-ternary.e2e.test.js` to load-bearing tokens (`refresh switch warning`
+ the `warningVisible = shouldWarn(originalId, id, bugFoldedTargets)` call), using
`[^\n]*` so a harmless reword of the comment tail is tolerated. AC4 of TASK-047 required
proving the relaxed guard "does NOT false-fail on a benign extra call **/ comment reword**
(simulated in-memory)". The benign-extra-call half is exercised by `mutateAddBenignCall`,
but the **comment-reword** half is asserted only by inspection / a code comment — there is
no `mutateRewordComment` mutation case that actually rewords the anchor comment tail and
asserts the guard still passes. The tolerance is genuinely present (the `[^\n]*` provides
it); this ticket closes the simulation gap so the property is machine-checked, not just
reasoned about.

## Acceptance Criteria
- [ ] Add a `mutateRewordComment` (or equivalently named) in-memory mutation to BOTH
      `test/task-045-dead-ternary.test.js` and `test/task-045-dead-ternary.e2e.test.js`
      that rewords the comment tail AFTER the load-bearing `refresh switch warning` token
      (leaving that token and the `warningVisible = shouldWarn(originalId, id, bugFoldedTargets)`
      call intact) and asserts the relaxed guard STILL PASSES (`relaxedGuardPasses === true`).
- [ ] Add an assertion that rewording/removing the load-bearing `refresh switch warning`
      token itself DOES make the guard fail (`relaxedGuardPasses === false`), pinning that
      the tolerance is scoped to the tail only, not the anchoring token.
- [ ] The existing mutation cases are preserved and still pass: remove-L127-only ->
      guard fails (teeth), benign-extra-call -> guard passes, plus the DEAD_TERNARY and
      residual `bugFoldedTargets.size ?` guards.
- [ ] Only `test/task-045-dead-ternary.test.js` and/or `test/task-045-dead-ternary.e2e.test.js`
      change; no production source, no other test files, and the real target
      `test/task-042-bug-multitarget-switch.e2e.test.js` is NOT edited (mutations are
      in-memory only). Full suite passes under `node --test`.

## Cucumber Tests
```gherkin
Feature: The dead-ternary guard tolerates a comment reword but is anchored to the token

  Scenario: Rewording the comment tail after the load-bearing token does not false-fail
    Given the target with the anchor comment tail reworded in-memory (token + call intact)
    Then the relaxed guard still passes

  Scenario: Removing the load-bearing token itself is caught (edge)
    Given the target with the "refresh switch warning" token removed/reworded in-memory
    Then the relaxed guard fails
```

## Relevant Files and Context
- `test/task-045-dead-ternary.test.js` — unit guard; has `mutateRemoveL127Only`,
  `mutateAddBenignCall`, `L127_ANCHOR`, `relaxedGuardPasses`. Add `mutateRewordComment` here.
- `test/task-045-dead-ternary.e2e.test.js` — e2e cucumber form of the same guards; mirror
  the new mutation case here.
- `test/task-042-bug-multitarget-switch.e2e.test.js` — the protected target (comment at
  L126 `refresh switch warning`, identical `shouldWarn(originalId, id, bugFoldedTargets)`
  call at L92 and L127). READ ONLY — never edited; mutations are in-memory string transforms.

## Edge and Failure Cases
- Comment tail reworded (token + call intact) -> guard PASSES (no false fail).
- Load-bearing `refresh switch warning` token itself removed/reworded -> guard FAILS.
- L127 call removed (L92 remains) -> guard STILL FAILS (existing teeth, unchanged).

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
