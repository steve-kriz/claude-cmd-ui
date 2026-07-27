---
id: TASK-166
title: telemetry:getUsage project-scoped response shape differs from no-arg shape
status: done
created: 2026-07-26T23:16:54.000Z
updated: 2026-07-27T01:50:13.000Z
agent: swarm-orch1
review-of: TASK-156
---

## Description
Confirmed renderer.js's `refresh()` (TASK-157) already handles this shape
difference correctly — independently re-verified by the tech-lead reading
the actual code, not just trusting the report. Added a documenting comment on
`createGetUsageHandler` in main.js explaining the intentional shape
difference at the source, plus a test file asserting the actual shapes with
the real handler and real receiver.

## Acceptance Criteria
- [x] Doc comment on the `telemetry:getUsage` handler in main.js.
- [x] Test asserts the actual shape returned for project-scoped vs no-arg
      calls — VERIFIED real-code (brace-extracted real function, real
      receiver, meaningful negative-key assertions).
- [x] Confirmed no live bug in TASK-157's Stats-tab consumer code.
- [x] All tests green beyond the known pre-existing baseline failures.

## Cucumber Tests
```gherkin
Feature: Consistent telemetry:getUsage response shape

  Scenario: Documented/consistent shape for project-scoped reads
    Given the real telemetry:getUsage handler
    When invoked with a project
    Then the response shape is documented and consumers can rely on it
      without throwing when reading metricTotals/running

  Scenario: No-arg shape is unchanged
    Given the real telemetry:getUsage handler
    When invoked with no argument
    Then it still returns { usage, metricTotals, running, recent }
```

## Relevant Files
- `C:\projects\claude-cmd-ui2\main.js` — doc comment added on
  `createGetUsageHandler`.
- `C:\projects\claude-cmd-ui2\test\task-166-getusage-shape-difference.test.js`
  (new, 3 tests).
- `C:\projects\claude-cmd-ui2\docs\telemetry.md` — Code map's main.js bullet
  updated to describe the shape difference.

## Build/Test/Review Notes
- Coder: verified renderer.js already safe by reading the actual code; added
  the doc comment and 3 tests.
- Tester: confirmed real-code exercise; full suite 3441/3445/3 (baseline).
- Tech-lead review: CLEAN, no findings. Independently re-verified renderer.js
  never reads `metricTotals`/`running` off the project-scoped response
  (traced every consumer of `refresh()`'s result). Confirmed the doc comment
  is accurate and the test assertions are meaningful (negative-key checks
  would catch a regression).
- Post-processing: no security issues (pure doc + test change).
  docs/telemetry.md's main.js Code map bullet updated to describe the shape
  difference.

## Additional Context
_(user-owned — leave blank)_
