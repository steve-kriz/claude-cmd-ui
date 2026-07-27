---
id: TASK-186
title: TASK-180 review — renderer phase-mirror scenarios actually exercise the lib, not renderer.js
status: done
created: 2026-07-27T14:00:00Z
updated: 2026-07-27T18:35:00Z
agent: orchestrator-main
review-of: TASK-180
activities: [{"activity":"code","model":"claude-sonnet-5","startedAt":"2026-07-27T18:20:00Z","finishedAt":"2026-07-27T18:30:00Z"},{"activity":"post-processing","model":"claude-opus-4-8","startedAt":"2026-07-27T18:30:00Z","finishedAt":"2026-07-27T18:34:00Z"},{"activity":"post-processing","model":"claude-sonnet-5","startedAt":"2026-07-27T18:30:00Z","finishedAt":"2026-07-27T18:34:00Z"}]
---

## Description
The TASK-180 tech-lead review found that the e2e tests claiming to cover the renderer's
`phase` mirror actually call the `lib/team-config.js` functions, not the renderer copies in
`renderer/renderer.js`. Specifically:
- `test/task-180-team-config-phases.e2e.test.js` lines ~166-185 ("column phase round-trips
  through serializeConfig") and lines ~507-531 ("Renderer mirror (tandem integration)") both
  call the lib `serializeConfig`/`normalizeConfig`, not `tasksBuildColumn` /
  `tasksNormalizeColumnPhase` / `tasksSerializeTeamConfig` from `renderer/renderer.js`.
- `test/task-103-column-manager.test.js` loads `TASKS_PHASE_KEYS` (so `tasksBuildColumn`
  doesn't crash) but asserts nothing about `phase`.

TASK-180's own description called the renderer mirror the highest-risk part of that change
("`tasksSerializeTeamConfig` rebuilds columns to a fixed key set that would silently drop the
new `phase` field ... the mirror MUST be updated too or column links never persist"). No test
currently exercises that mirror's `phase` behavior in isolation from the lib.

## Acceptance Criteria
- [x] Add (or fix) a test that extracts and calls the actual renderer functions —
      `tasksBuildColumn`, `tasksNormalizeColumnPhase`, `normalizeTasksColumns`,
      `tasksSerializeTeamConfig` — from `renderer/renderer.js` source (via the existing
      extraction-harness pattern, e.g. `test/helpers/task-101-lane-harness.js` or the
      `extractFn`/`extractConst` helpers used in `test/task-103-column-manager.test.js`), not
      the `lib/team-config.js` copies.
- [x] A test proves a column's `phase` survives `tasksBuildColumn` → `normalizeTasksColumns` →
      `tasksSerializeTeamConfig` round-trip using the renderer's own functions.
- [x] A regression test: if `tasksSerializeTeamConfig`'s column map were reverted to omit
      `phase` from its fixed key set, this test must fail (verify by temporarily reverting
      locally and confirming red, per standard test-fidelity practice — do not leave the
      revert in place).
- [x] The misleadingly-named existing scenarios in `test/task-180-team-config-phases.e2e.test.js`
      (lines ~166-185, ~507-531) are either corrected to call the renderer functions or
      relabeled so their names/comments don't claim renderer coverage they don't provide.

## Cucumber Tests
```gherkin
Feature: renderer phase-mirror test fidelity
  Scenario: renderer's own serializer round-trips column phase
    Given a column built via the renderer's tasksBuildColumn with phase "review"
    When it passes through normalizeTasksColumns and tasksSerializeTeamConfig
    Then the persisted JSON's column still carries phase "review"

  Scenario: renderer mirror regression is caught (failure/edge)
    Given tasksSerializeTeamConfig's column map omitted the phase field
    When the new renderer-scoped test runs
    Then it fails (proving it actually exercises renderer.js, not lib/team-config.js)
```

## Edge & Failure Cases
- Ensure the extraction harness used doesn't itself silently fall back to a stub if the named
  function/const is missing from `renderer.js` — it should fail loudly.
- Keep the existing lib-level `serializeConfig` round-trip tests as-is (they're valid coverage
  of the lib); this ticket only adds/fixes the renderer-scoped coverage, it doesn't remove
  lib-level tests.

## Relevant Files & Context
- `test/task-180-team-config-phases.e2e.test.js` (the misnamed scenarios), `renderer/renderer.js`
  (`tasksBuildColumn` ~5437, `tasksNormalizeColumnPhase` ~5426, `tasksSerializeTeamConfig`
  ~5638-5646), `test/helpers/task-101-lane-harness.js` and `test/task-103-column-manager.test.js`
  for the extraction-harness pattern to reuse.

## Impact If Not Fixed
A regression that drops `phase` from `tasksSerializeTeamConfig`'s fixed column key-set map, or
breaks `tasksNormalizeColumnPhase`, would ship with all tests green — silently breaking
column→phase persistence (the exact failure mode TASK-180 was written to prevent) and breaking
TASK-183's Board-panel feature downstream, with no test catching it.

## Build notes
- Coder: added a self-contained extraction harness in `test/task-180-team-config-phases.e2e.test.js` (mirroring `test/task-103-column-manager.test.js`'s pattern), added two renderer-scoped round-trip/idempotency tests, relabeled the two misnamed lib-only scenarios. Verified the regression check by temporarily reverting `tasksSerializeTeamConfig` locally (confirmed red), then restoring it (confirmed green, no net diff).
- Test-only ticket — no separate tester dispatch needed beyond the coder's own verification; orchestrator independently re-ran the full suite: 3719 pass, 3 pre-existing baseline failures, 0 regressions.
- Tech-lead review skipped (review defaults disabled).
- Post-processing: security review confirmed test-only change and harness safety (no new risk beyond the established `new Function` sandbox pattern already used elsewhere); documentation pass found no doc references this test file, no changes needed.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
