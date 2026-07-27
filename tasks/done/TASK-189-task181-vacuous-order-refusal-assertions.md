---
id: TASK-189
title: TASK-181 review — "does not refuse out-of-order configs" assertions are vacuous
status: done
created: 2026-07-27T15:00:00Z
updated: 2026-07-27T19:55:00Z
agent: orchestrator-main
review-of: TASK-181
activities: [{"activity":"code","model":"claude-sonnet-5","startedAt":"2026-07-27T19:40:00Z","finishedAt":"2026-07-27T19:48:00Z"},{"activity":"post-processing","model":"claude-opus-4-8","startedAt":"2026-07-27T19:48:00Z","finishedAt":"2026-07-27T19:53:00Z"},{"activity":"post-processing","model":"claude-sonnet-5","startedAt":"2026-07-27T19:48:00Z","finishedAt":"2026-07-27T19:53:00Z"}]
---

## Description
The TASK-181 tech-lead review found that the tests meant to cover "the orchestrator follows a
configured phase order literally, it does not refuse a dependency-violating order" are not
real assertions:

- `test/task-181-phase-enabled.e2e.test.js` (~lines 204-208): the check is
  `assert(!md.includes('do not refuse') || md.includes('do not refuse'))` — a tautology
  (`!X || X`) that is always true regardless of file content, per the review's own inline
  comment admission.
- `test/task-181-phase-enabled.test.js` (~lines 112-119): the check slices context around
  `md.indexOf('order')`, but the first match of the word "order" in SKILL.md is the unrelated
  "left-to-right **order**" phrase in the lane description near the top of the file, not the
  dispatch-order section TASK-181 added — so it inspects the wrong text and passes regardless
  of what the actual order-dispatch prose says.

The deviation-*reporting* half of the requirement is covered elsewhere in both files; only the
"do **not** refuse" half is uncovered.

## Acceptance Criteria
- [x] Replace the tautological assertion in `test/task-181-phase-enabled.e2e.test.js` with a
      real check that the order-dispatch section explicitly states the orchestrator follows a
      configured order literally rather than refusing/rejecting a dependency-violating one
      (e.g. assert the section contains language equivalent to "follows... literally" AND does
      NOT contain a refusal directive like "refuse" or "reject" in that section's scope).
- [x] Fix the unit test's locator so it inspects the actual `### Phase-enabled config and
      dispatch order` section (search for that heading, or a more specific anchor than the bare
      word "order") rather than the first unrelated "order" occurrence near the top of the file.
- [x] A regression check: if the order-dispatch prose were changed to say the orchestrator
      *should* refuse a bad order, the corrected test(s) must fail (verify locally, don't leave
      the change in place).

## Cucumber Tests
```gherkin
Feature: order-dispatch "no refusal" claim has real test coverage
  Scenario: the no-refusal claim is genuinely asserted
    Given the "### Phase-enabled config and dispatch order" section of SKILL.md
    When the e2e test inspects it
    Then it asserts literal-follow language is present and no refusal directive is present

  Scenario: the unit test locates the correct section
    When the unit test searches for the order-dispatch prose
    Then it anchors on the dispatch-order heading, not the first unrelated "order" occurrence

  Scenario: regression is caught (failure/edge)
    Given the order-dispatch prose were changed to say the orchestrator should refuse bad orders
    When the corrected tests run
    Then they fail (proving they actually check this claim)
```

## Edge & Failure Cases
- Don't remove the existing (valid) deviation-reporting assertions — this ticket only fixes the
  no-refusal half and the mislocated context slice.
- Keep the fix scoped to these two test files; no SKILL.md prose change is needed here (TASK-181
  already states this correctly — only the tests are wrong).

## Relevant Files & Context
- `test/task-181-phase-enabled.e2e.test.js` (~lines 204-208), `test/task-181-phase-enabled.test.js`
  (~lines 112-119).
- `.claude/skills/orchestrate/SKILL.md` — the `### Phase-enabled config and dispatch order`
  section TASK-181 added, to anchor the corrected locator on.

## Impact If Not Fixed
A future regression that flips the not-refusal directive (e.g. someone "fixes" the prose to
reject nonsensical orders, contradicting the user's explicit choice that order should drive
execution literally) would go undetected by these tests, silently eroding the guarantee that a
user-configured order is followed rather than rejected — the tests give a false sense of
protection for that specific requirement.

## Build notes
- Coder: added `extractSectionByHeading` helper to both test files, replaced the tautology and mislocated slice with real assertions anchored on the actual order-dispatch section. Performed a genuine regression check (temporarily flipped SKILL.md's prose to "should refuse", confirmed 6 tests went red including the 2 corrected ones, reverted and confirmed 34/34 green — verified byte-identical to pre-task state via `cmp`).
- Test-only ticket — no separate tester dispatch needed; orchestrator independently re-verified: 3724 pass, 3 pre-existing baseline failures, 0 regressions, and confirmed SKILL.md copies remain byte-identical.
- Tech-lead review skipped (review defaults disabled).
- Post-processing: security review confirmed no production file left modified and the new test helper is safe (no eval, escaped regex interpolation, no backtracking risk); documentation pass found no stale doc references.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
