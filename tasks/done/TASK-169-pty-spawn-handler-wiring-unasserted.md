---
id: TASK-169
title: pty:spawn handler-wiring to buildOtelProjectEnv is unasserted; dead extractHandlerBlock helper
status: done
created: 2026-07-27T00:12:18.000Z
updated: 2026-07-27T03:10:43.690Z
agent: swarm-orch1
review-of: TASK-160
resolution: wont-do
---

## Description
Tech-lead review of TASK-160 found that while `buildOtelProjectEnv` itself is
now well tested against real code, TASK-160's own second cucumber scenario
("main.js's ipcMain.handle wiring calls the same function") is unasserted.
Both test files verify `buildOtelProjectEnv` in isolation only. The e2e file
defines a helper `extractHandlerBlock(src, channel)` clearly intended to
inspect the `pty:spawn` handler block, but it is never called anywhere — dead
code.

No test asserts that `ipcMain.handle('pty:spawn', ...)` (main.js) actually
calls `buildOtelProjectEnv` and passes its result as `env` into `spawnShell`.

## Impact If Not Fixed
All TASK-160 tests would still pass even if someone deleted
`const env = buildOtelProjectEnv(project)` from the `pty:spawn` handler or
stopped passing `env` to `spawnShell` — silently disabling per-project OTEL
tagging with a fully green suite. A future refactor could orphan
`buildOtelProjectEnv` (exported and tested but never wired into `pty:spawn`),
and the per-project telemetry attribution feature (the core purpose of this
whole 6-ticket feature) would regress to the old single-bucket behavior
undetected.

## Acceptance Criteria
- [ ] A test asserts that the real `pty:spawn` `ipcMain.handle` registration in
      main.js calls `buildOtelProjectEnv(project)` and forwards its result as
      `env` into the `spawnShell(...)` call — either by using the existing
      (currently dead) `extractHandlerBlock` helper to extract and inspect the
      handler's real source/behavior, or by an equivalent real-invocation
      approach (e.g. extracting the handler body and invoking it with a mocked
      `spawnShell`, asserting the `env` argument it received).
- [ ] The `extractHandlerBlock` helper in
      `test/task-153-otel-resource-tags.e2e.test.js` is either used by this new
      test or removed if a different approach is taken (no dead code left
      behind).
- [ ] A mutation-style sanity check: if the handler's call to
      `buildOtelProjectEnv` (or forwarding its result to `spawnShell`) were
      removed/broken, this new test fails.
- [ ] All tests green under `node --test` beyond the known pre-existing
      baseline failures.

## Additional Findings Folded In (from TASK-161's review, same test file)
While in this test file, also address two LOW-severity test-maintenance items
the TASK-161 review found (both in `test/task-153-otel-resource-tags.e2e.test.js`):
- [ ] `extractRealFn` (lines ~39-50) and `extractFn` (lines ~79-90) are
      byte-identical brace-matching implementations — consolidate into one
      shared helper so a future extraction-logic fix (e.g. handling arrow
      functions or brace-in-comments) can't be applied to only one copy.
- [ ] The dead `extractHandlerBlock` helper (lines ~93-104) is either put to
      use by this ticket's new pty:spawn-wiring test, or removed if a
      different test approach is taken (already an acceptance criterion above
      — just noting the two reviews independently flagged the same dead code).

## Cucumber Tests
```gherkin
Feature: pty:spawn handler wiring to buildOtelProjectEnv is covered

  Scenario: The real pty:spawn handler calls buildOtelProjectEnv and forwards env
    Given a pty:spawn request with project "C:\\projects\\alpha"
    And spawnShell is mocked to record its call arguments
    When the real pty:spawn ipcMain.handle registration processes the request
    Then spawnShell was called with env.OTEL_RESOURCE_ATTRIBUTES === "project=C%3A%5Cprojects%5Calpha"

  Scenario (mutation guard): Handler not calling buildOtelProjectEnv would be caught
    Given the same setup as above
    When the handler's call to buildOtelProjectEnv is (hypothetically) removed
    Then this test would fail (documented reasoning, not necessarily an actual
      applied mutation in CI)
```

## Relevant Files
- `C:\projects\claude-cmd-ui2\main.js` — `pty:spawn` `ipcMain.handle`
  registration, `buildOtelProjectEnv`.
- `C:\projects\claude-cmd-ui2\test\task-153-otel-resource-tags.e2e.test.js` —
  the dead `extractHandlerBlock(src, channel)` helper to use or remove; also
  contains `loadRendererFns` (from TASK-161) — read fresh, several sibling
  tickets have touched this file since it was scoped.
- `C:\projects\claude-cmd-ui2\test\task-153-otel-resource-tags.test.js`.

## Additional Context
_(user-owned — leave blank)_
