---
id: TASK-191
title: TASK-185 review — mirror-only-failure drift-warning path has zero real test coverage
status: done
created: 2026-07-27T18:00:00Z
updated: 2026-07-27T20:45:00Z
agent: orchestrator-main
review-of: TASK-185
activities: [{"activity":"code","model":"claude-sonnet-5","startedAt":"2026-07-27T20:25:00Z","finishedAt":"2026-07-27T20:37:00Z"},{"activity":"post-processing","model":"claude-opus-4-8","startedAt":"2026-07-27T20:37:00Z","finishedAt":"2026-07-27T20:43:00Z"},{"activity":"post-processing","model":"claude-sonnet-5","startedAt":"2026-07-27T20:37:00Z","finishedAt":"2026-07-27T20:43:00Z"}]
---

## Description
The TASK-185 tech-lead review found that `test/task-185-workflow-phase-regen.e2e.test.js`
(~lines 483-529) never actually exercises the mirror-only-write-failure branch. The stubbed
`window.api.fs` (~lines 191-234) defines only `readFile`/`writeFile` — no `exists`. But
`writeWithMirror` (`renderer/renderer.js:6435`) calls `window.api.fs.exists` before the mirror
write; that call throws, is swallowed by the save handler's try/catch into a generic failure
**before** the mirror `writeFile` runs, so `mirrorWriteFailed` stays `false`. The test's only
assertion is inside `if (mirrorWriteFailed && !saveErr.classList.contains('hidden'))` (~line
525) — a guard that is never true, so nothing is asserted and the test passes unconditionally.

## Acceptance Criteria
- [x] The `window.api.fs` stub in the mirror-failure scenario provides a working `exists` (so
      the primary write path can proceed) and a `writeFile` that succeeds for the primary
      `.claude/skills/orchestrate/SKILL.md` path but fails specifically for the
      `assets/skills/orchestrate/SKILL.md` mirror path.
- [x] The scenario asserts the drift-warning UI (`renderer.js` ~lines 8957-8965) actually
      renders and names **both** paths (the live `.claude/...` path and the `assets/...` mirror
      path) when this specific failure occurs.
- [x] The scenario asserts the primary write DID succeed (the live SKILL.md content reflects the
      new proposal) even though the mirror failed — matching the TASK-093 drift contract.
- [x] A regression check: temporarily breaking the drift-warning render (e.g. removing one of
      the two path names) must make the corrected test fail (verify locally, then revert).

## Cucumber Tests
```gherkin
Feature: mirror-only write failure surfaces a real drift warning
  Scenario: mirror write fails, primary succeeds, warning names both paths
    Given the primary .claude SKILL.md write succeeds but the assets mirror write fails
    When the user saves an accepted AI proposal
    Then the live SKILL.md is updated with the new phase-section body
    And a drift warning is shown naming both the .claude and assets paths

  Scenario: regression is caught (failure/edge)
    Given the drift-warning render were broken to omit one path name
    When the corrected test runs
    Then it fails
```

## Edge & Failure Cases
- Keep the stub minimal — only fix what's needed to make the primary write succeed and the
  mirror write fail deterministically, matching how other mirror-failure tests in this repo
  (e.g. `test/task-106-guided-editor.e2e.test.js`) simulate it.

## Relevant Files & Context
- `test/task-185-workflow-phase-regen.e2e.test.js` (~lines 483-529, and the `window.api.fs`
  stub ~lines 191-234).
- `renderer/renderer.js` — `writeWithMirror` (~6371-6443), the drift-warning render in
  `buildWorkflowPhaseRegenerator`'s Save handler (~8957-8965).
- Pattern to follow: `test/task-106-guided-editor.e2e.test.js`'s existing mirror-unwritable
  scenario for the Agents panel.

## Impact If Not Fixed
A regression in the drift-warning behavior on the one path allowed to write SKILL.md would ship
green, so a silent `.claude/`↔`assets/` SKILL.md divergence could go unreported and the two
copies drift without the user ever being warned.

## Build notes
- Coder: fixed `window.api.fs` stub (added real `exists()`, correct `mirrorPath` matching), replaced the no-op assertion guard with unconditional real assertions (mirror-write-attempted, both paths named, primary write verified by re-read). Genuine regression check: temporarily removed `skillPath` from the drift-warning message, confirmed the scenario went red, reverted, confirmed 12/12 green.
- Test-only ticket. Orchestrator independently re-verified: renderer.js's drift-warning render unchanged, 12/12 on the target file, full suite 3724 pass / 3 pre-existing baseline failures / 0 regressions.
- Tech-lead review skipped (review defaults disabled).
- Post-processing: security review confirmed renderer.js's render logic intact and the test genuinely exercises it; documentation pass found no stale references (docs describe behavior, not test names).

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
