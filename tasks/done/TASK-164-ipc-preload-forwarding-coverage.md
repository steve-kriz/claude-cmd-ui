---
id: TASK-164
title: telemetry:getUsage/setProjectConfig IPC and preload bridge lack real-code test coverage
status: done
created: 2026-07-26T23:16:54.000Z
updated: 2026-07-27T01:25:30.000Z
agent: swarm-orch1
review-of: TASK-156
---

## Description
Extracted `main.js`'s `telemetry:getUsage`/`telemetry:setProjectConfig` IPC
handlers into requireable factories (`createGetUsageHandler`,
`createSetProjectConfigHandler`), following the established
`createUsageForWindowHandler`/`buildOtelProjectEnv` precedent. `preload.js`
bridge functions tested via a novel `Module._load` interception technique
(mocking `electron`, requiring the real `preload.js`, capturing the actual
`api` object).

## Acceptance Criteria
- [x] Test invokes the REAL `telemetry:getUsage` handler with no arg, bare
      string, and `{project}`.
- [x] Test invokes the REAL `telemetry:setProjectConfig` handler with valid
      args, asserting `setProjectForwarding` called and `{ok:true}` returned.
- [x] Test invokes it with no receiver, asserting safe no-op.
- [x] Test invokes the REAL preload.js bridge functions with exact channel/
      payload assertions.
- [x] All tests green beyond the known pre-existing baseline failures
      (independently re-confirmed by orchestrator: 3419/3423/3).

## Cucumber Tests
```gherkin
Feature: telemetry IPC/preload wiring for per-project config is covered against real code

  Scenario: getUsage handler routes a bare project string correctly
    Given the real telemetry:getUsage handler
    When invoked with a bare project string "alpha"
    Then it calls receiver.getUsageForProject("alpha")

  Scenario: getUsage handler routes {project} object correctly
    Given the real telemetry:getUsage handler
    When invoked with { project: "alpha" }
    Then it calls receiver.getUsageForProject("alpha")

  Scenario: getUsage handler with no arg preserves legacy behavior
    Given the real telemetry:getUsage handler
    When invoked with no argument
    Then it calls receiver.getUsage() (the app-wide/default path)

  Scenario: setProjectConfig handler wires to setProjectForwarding
    Given the real telemetry:setProjectConfig handler and a receiver
    When invoked with { project: "alpha", storeOnline: true }
    Then receiver.setProjectForwarding("alpha", true) is called
    And the handler returns { ok: true }

  Scenario (edge): setProjectConfig handler with no receiver is a safe no-op
    Given the real telemetry:setProjectConfig handler and no receiver
    When invoked with any payload
    Then no exception is thrown and it returns { ok: true }

  Scenario: preload setProjectConfig sends the correct IPC payload
    Given the real preload.js telemetry.setProjectConfig bridge function
    When called with ("alpha", { storeOnline: true })
    Then ipcRenderer.invoke is called with "telemetry:setProjectConfig" and
      { project: "alpha", storeOnline: true }
```

## Relevant Files
- `C:\projects\claude-cmd-ui2\main.js` — new factories, exported.
- `C:\projects\claude-cmd-ui2\test\task-164-telemetry-getusage-setprojectconfig.test.js`,
  `.e2e.test.js`, `test\task-164-preload-telemetry-bridge.test.js` (all new).

## Build/Test/Review Notes
- Coder: extracted both factories; devised the `Module._load` interception
  technique for testing preload.js (couldn't require it directly since it
  calls `require('electron')` at module scope).
- Tester: 29 new tests across 3 files, all real-code (no mirrors). Full suite:
  3419 pass, 3 fail (confirmed baseline — independently re-confirmed by the
  orchestrator since the tech-lead could only read, not execute).
- Tech-lead review: scrutinized the novel `Module._load` technique carefully
  (restore-in-finally, cache cleanup before AND after, no cross-test leakage)
  — confirmed correct and safe. Input handling confirmed robust (type-checked,
  no prototype-pollution surface). Two low-severity follow-ups: TASK-174 (the
  actual `ipcMain.handle` REGISTRATIONS, as opposed to the factory bodies, are
  untested — same class of gap as TASK-169); TASK-175 (the brace-matching
  `extractFn` harness for main.js is fragile and bypasses `module.exports` —
  suggests investigating whether the `Module._load` technique that worked for
  preload.js could work for main.js too).
- Post-processing: independent security pass found no additional issues.
  Confirmed no dedicated test-conventions doc exists in this repo to record
  the new `Module._load` technique — flagged for whoever builds TASK-175 as a
  natural place to add a short doc section.

## Additional Context
_(user-owned — leave blank)_
