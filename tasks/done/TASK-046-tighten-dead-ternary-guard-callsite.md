---
id: TASK-046
title: pin the TASK-045 dead-ternary guard to the specific line-127 call site
status: done
created: 2026-07-19T02:12:00Z
updated: 2026-07-19T02:31:00Z
---

## Description
Follow-up from the TASK-045 tech-lead review (LOW — test robustness). The TASK-045
"simplified call present" guards scanned the whole target file, so an identical
`shouldWarn(originalId, id, bugFoldedTargets)` call at line 92 could mask removal of the
line-127 call site. This ticket tightens the guard to detect an L127-only regression.

## Acceptance Criteria
- [x] The guard is tightened so removing/altering ONLY the line-127 call site is detected despite the identical line-92 call (occurrence-count === 2 + comment-anchored L127 match).
- [x] The existing `DEAD_TERNARY` guard (no `? originalId : originalId`) is preserved.
- [x] The tightened guard passes on current source and would FAIL if the line-127 site were removed/behavior-changed (proven by an in-memory mutation test).
- [x] Only `test/task-045-dead-ternary.test.js` and/or `.e2e.test.js` changed; no production source, no other test files.
- [x] Full suite passes under `node --test`.

## Cucumber Tests
```gherkin
Feature: The dead-ternary guard is pinned to the line-127 call site

  Scenario: Removing the line-127 call is detected
    Given the guard for the TASK-042 e2e replica
    When the warningVisible = shouldWarn(originalId, id, bugFoldedTargets) call at line 127 is removed
    Then the guard test fails
    And the still-present identical call at line 92 does not mask the failure

  Scenario: Correct source still passes (edge)
    Given the current correct source with both call sites present
    Then the tightened guard passes
```

## Relevant Files and Context
- `test/task-045-dead-ternary.test.js` — unit guard: occurrence-count + L127 comment-anchor + mutation test.
- `test/task-045-dead-ternary.e2e.test.js` — cucumber form of the same.
- `test/task-042-bug-multitarget-switch.e2e.test.js` — target (identical call at L92 and L127; anchor comment at L126).

## Edge and Failure Cases
- Both call sites present (current) → passes.
- Line-127 site removed while line-92 remains → fails (proven by mutation test).
- Dead ternary reintroduced → still fails via existing DEAD_TERNARY guard.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)

## Orchestration Notes
- Build corrected the ticket premise: L92 and L127 are byte-identical call lines, so the anchor is L127's unique preceding comment `// refresh switch warning after committing a fold`, backed by an occurrence-count===2 assertion.
- Test: both kinds green (11/11) incl. an executable in-memory mutation test (remove-L127-only → count 2→1, anchor vanishes → guard fails) proving the L92 occurrence no longer masks an L127 regression. Full suite 1063/1063 (quiescent gate).
- Tech-lead review: clean, teeth proven, read-only/secure. One optional LOW note — exact `count === 2` and the comment-anchor are brittle to legitimately-added call sites / comment rewording → filed as TASK-047 (todo). Review does not reopen this ticket.
- Post-processing (TASK-035 security review): satisfied — read-only source-scan test files, no traversal/injection.
