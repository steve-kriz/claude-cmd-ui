---
id: TASK-188
title: TASK-181 review — Phase 3 hand-off prose contradicts review-disabled-by-default
status: done
created: 2026-07-27T15:00:00Z
updated: 2026-07-27T19:35:00Z
agent: orchestrator-main
review-of: TASK-181
activities: [{"activity":"code","model":"claude-sonnet-5","startedAt":"2026-07-27T19:00:00Z","finishedAt":"2026-07-27T19:08:00Z"},{"activity":"test","model":"claude-haiku-4-5","startedAt":"2026-07-27T19:08:00Z","finishedAt":"2026-07-27T19:30:00Z"},{"activity":"post-processing","model":"claude-opus-4-8","startedAt":"2026-07-27T19:30:00Z","finishedAt":"2026-07-27T19:34:00Z"},{"activity":"post-processing","model":"claude-sonnet-5","startedAt":"2026-07-27T19:30:00Z","finishedAt":"2026-07-27T19:34:00Z"}]
---

## Description
The TASK-181 tech-lead review found that Phase 3's "All green" hand-off bullet in
`.claude/skills/orchestrate/SKILL.md` (and its byte-identical mirror
`assets/skills/orchestrate/SKILL.md`) still unconditionally instructs running the tech-lead
review: "first run the **tech-lead review** (Phase 4 below) ... **Only once the review has
completed** and every defined post-processing ticket's instructions have been run do you set
`status: done`" (~line 485-492 in both files).

TASK-181 made `review` default **disabled** (`skill.phases.review.enabled: false` by default,
per TASK-180's schema) and added a paragraph to Phase 4 describing the skip
(`testing → post-processing → done` when review is disabled). But Phase 3's own hand-off
prose was not updated to reference that skip — it still reads as if review always runs,
directly contradicting the new Phase 4 paragraph. This is a spec the orchestrator follows
literally, so the self-contradiction is a real defect, not just a nitpick.

## Acceptance Criteria
- [x] Phase 3's "All green" hand-off bullet in `.claude/skills/orchestrate/SKILL.md` is updated
      to say: run the tech-lead review **only when `skill.phases.review.enabled` is true**
      (referencing the Phase 4 skip paragraph / the general phase-enabled rule added in
      TASK-181), otherwise proceed straight to post-processing.
- [x] The updated prose does not contradict the Phase 4 skip paragraph or the general
      phase-enabled-check rule added by TASK-181 — read both together and confirm they agree.
- [x] `assets/skills/orchestrate/SKILL.md` is edited identically; the two files remain
      byte-identical (drift-guard tests pass).
- [x] No other Phase 3 semantics change (the fix loop, the 3-attempt cap, the "both e2e and
      unit tests must be green" requirement are untouched).

## Cucumber Tests
```gherkin
Feature: Phase 3 hand-off prose agrees with Phase 4's review-skip rule
  Scenario: Phase 3 conditions the review dispatch on skill.phases.review.enabled
    When Phase 3's "All green" hand-off prose is read
    Then it states the tech-lead review only runs when skill.phases.review.enabled is true
    And otherwise it proceeds straight to post-processing

  Scenario: Phase 3 and Phase 4 prose do not contradict each other (edge)
    When both sections are read together
    Then neither section claims review always runs while the other says it can be skipped

  Scenario: assets mirror stays byte-identical (failure/edge)
    When SKILL.md is edited
    Then assets/skills/orchestrate/SKILL.md is byte-identical to .claude/skills/orchestrate/SKILL.md
```

## Edge & Failure Cases
- Do not touch the fix-loop / 3-attempt-cap prose in Phase 3 — scope this to the "All green"
  hand-off bullet only.
- Drift between the two SKILL.md copies is a build failure — edit both identically.

## Relevant Files & Context
- `.claude/skills/orchestrate/SKILL.md` — Phase 3 "All green" bullet (~lines 485-492), Phase 4
  skip paragraph (~lines 512-520), the general phase-enabled rule (~lines 210-232), all added/
  referenced by TASK-181.
- `assets/skills/orchestrate/SKILL.md` — byte-identical mirror.
- `test/task-181-phase-enabled.test.js`, `test/task-181-phase-enabled.e2e.test.js` — extend or
  add an assertion that Phase 3's hand-off text is conditioned on `skill.phases.review.enabled`.

## Impact If Not Fixed
An orchestrator following Phase 3's hand-off literally may launch the tech-lead review even
when `skill.phases.review.enabled` is `false`, defeating the intended cost-saving default (the
whole point of TASK-181), or an operator reading the spec may be unable to tell which
instruction wins — undermining confidence that the documented default flow is coherent.

## Build notes
- Coder: reworded Phase 3's "All green" bullet in both SKILL.md copies to condition the review dispatch on `skill.phases.review.enabled`, cross-referencing Phase 4's skip rule. Diff-verified byte-identical.
- Tester: initial pass claimed new coverage but didn't actually add a specific assertion (caught by the orchestrator before shipping); a corrected pass added a real unit + e2e test targeting the exact reworded text, with a verified regression check (reverted locally → red, restored → green). Orchestrator independently re-ran the full suite: 3724 pass, 3 pre-existing baseline failures, 0 regressions.
- Tech-lead review skipped (review defaults disabled).
- Post-processing: security review confirmed byte-identity and that no other safety invariant (enum, atomic writes, concurrency) was weakened; documentation pass confirmed `docs/orchestrate-workflow.md` already reads consistently (updated during TASK-181), no changes needed.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
