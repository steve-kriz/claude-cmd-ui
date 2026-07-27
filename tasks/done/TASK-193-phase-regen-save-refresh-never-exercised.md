---
id: TASK-193
title: TASK-185 review — successful full Save (primary+mirror+refresh) is never exercised end-to-end
status: done
created: 2026-07-27T18:00:00Z
updated: 2026-07-27T21:25:00Z
agent: orchestrator-main
review-of: TASK-185
activities: [{"activity":"code","model":"claude-sonnet-5","startedAt":"2026-07-27T21:10:00Z","finishedAt":"2026-07-27T21:20:00Z"},{"activity":"post-processing","model":"claude-opus-4-8","startedAt":"2026-07-27T21:20:00Z","finishedAt":"2026-07-27T21:24:00Z"},{"activity":"post-processing","model":"claude-sonnet-5","startedAt":"2026-07-27T21:20:00Z","finishedAt":"2026-07-27T21:24:00Z"}]
---

## Description
The TASK-185 tech-lead review found that "Successful Save re-reads via refreshTeamWorkflow"
(`test/task-185-workflow-phase-regen.e2e.test.js` ~lines 606-629) only fires the regenerate
button and asserts `calls.regeneratePhase.length > 0` — it never clicks Save and never verifies
`refreshTeamWorkflow` runs (the harness stub sets `tab.refreshed()`, which the test never
checks). Combined with TASK-191's missing `exists` stub, no test in the current suite drives a
fully successful Save (primary write OK + mirror write OK) end-to-end. The headline "preview
then save rewrites only that phase" test (~lines 268-314) only asserts on the primary write
recorded *before* `writeWithMirror` throws in the current stub setup, so its apparent
success-path coverage is illusory.

## Acceptance Criteria
- [x] A real end-to-end scenario: regenerate → valid preview loads → click Save → both the
      primary `.claude/...` write AND the mirror `assets/...` write succeed (a correctly
      working `window.api.fs` stub, not the current incomplete one) → assert `refreshTeamWorkflow`
      (or the harness's `tab.refreshed()` marker) was actually invoked after the successful save.
- [x] The same scenario asserts the live SKILL.md content reflects the new phase-section body
      and every other section is byte-identical to before the save (tie this together with the
      existing byte-diff assertions rather than duplicating them, if convenient).
- [x] A regression check: temporarily skip the `refreshTeamWorkflow` call in the real Save
      handler and confirm the corrected test fails (verify locally, then revert).

## Cucumber Tests
```gherkin
Feature: successful Save actually completes and refreshes
  Scenario: full successful save re-reads the panel
    Given a valid AI proposal preview for the Review phase
    When the user clicks Save and both the primary and mirror writes succeed
    Then refreshTeamWorkflow is invoked
    And the live SKILL.md reflects the new Phase 4 body with every other section unchanged

  Scenario: regression is caught (failure/edge)
    Given the refreshTeamWorkflow call were removed from the Save handler
    When the corrected test runs
    Then it fails
```

## Edge & Failure Cases
- This ticket's fix likely shares root cause with TASK-191 (the incomplete `window.api.fs`
  stub) — coordinate/dedupe the stub fix if both are picked up together, but each ticket's
  acceptance criteria must independently hold.

## Relevant Files & Context
- `test/task-185-workflow-phase-regen.e2e.test.js` (~lines 606-629, ~268-314).
- `renderer/renderer.js` — the Save handler in `buildWorkflowPhaseRegenerator` (~8778-8979),
  specifically the `refreshTeamWorkflow` call on success (~8975).

## Impact If Not Fixed
A regression where Save silently skips the refresh (or where the mirror-sync half breaks) would
leave the panel showing stale prose after a write, or leave the mirror unsynced, without any
test failing.

## Build notes
- Coder: rewrote the scenario to drive a real happy path (default working fs stub, both writes succeed), asserting exactly 2 writes with byte-identical content, no drift warning, `refreshTeamWorkflow` invoked, and correct re-read content. Performed a genuine regression check (temporarily disabled the refresh call, confirmed the test went red, reverted, confirmed 14/14 green).
- Test-only ticket. Orchestrator independently re-verified: no leftover debug markers, 14/14 on target file, full suite 3726 pass / 3 pre-existing baseline failures / 0 regressions.
- Tech-lead review skipped (review defaults disabled).
- Post-processing: security review confirmed the Save handler's refresh call intact and the rewritten scenario genuinely exercises the full successful path (not mocked away); documentation pass found no stale doc references.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
