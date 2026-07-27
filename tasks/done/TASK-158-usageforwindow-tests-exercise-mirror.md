---
id: TASK-158
title: usageForWindow tests exercise a hand-rolled mirror, not the real handler
status: done
created: 2026-07-26T21:50:48.000Z
updated: 2026-07-27T00:05:00.000Z
agent: swarm-orch1
review-of: TASK-147
---

## Description
Extracted the `telemetry:usageForWindow` handler body into a module-level
`createUsageForWindowHandler(telemetryReceiverArg)` factory in main.js, wired
the real `ipcMain.handle` registration to call it, and updated both TASK-147
test files to source-extract and invoke the REAL factory function (via this
repo's established `extractFn` brace-matching + `new Function` convention,
since `main.js` requires `electron` at module scope and can't be `require()`'d
directly under plain `node --test`) instead of their hand-typed mirror copies.

## Acceptance Criteria
- [x] Handler logic extracted into one requireable function, used by BOTH the
      real `ipcMain.handle` wiring and the test files — no duplicated logic.
- [x] Both TASK-147 test files updated to invoke the extracted function.
- [x] All existing TASK-147 scenarios still pass against the real function.
- [x] No behavioral change to the handler's contract.
- [x] All tests green beyond the 3 known pre-existing baseline failures.

## Cucumber Tests
```gherkin
Feature: usageForWindow tests exercise the real extracted handler

  Scenario: The real handler function is invoked directly by the test
    Given the extracted usageForWindow handler function
    When it is required directly from main.js (or its new lib module) in a test
    And the receiver's usageForWindow throws
    Then the function returns { ok: true, usage: null }

  Scenario: main.js still wires the same function to IPC
    Given main.js's ipcMain.handle('telemetry:usageForWindow', ...) registration
    When inspected
    Then it calls the same extracted function the tests import (no duplicated logic)

  Scenario (edge): No handler duplication remains
    Given the two TASK-147 test files
    When searched for "createUsageForWindowHandler" and "createHandlerMirror"
    Then neither hand-rolled copy exists anymore
```

## Relevant Files
- `C:\projects\claude-cmd-ui2\main.js` — `createUsageForWindowHandler` factory
  (lines 577-586), exported at line 2155; real IPC wiring delegates to it.
- `C:\projects\claude-cmd-ui2\test\task-147-telemetry-usage-for-window.test.js`
- `C:\projects\claude-cmd-ui2\test\task-147-telemetry-usage-for-window.e2e.test.js`

## Build/Test/Review Notes
- Coder: extracted the factory; both test files now source-extract and eval
  the real function text via `extractFn`/`new Function` (established
  `augmentDarwinPath` precedent, since main.js can't be require()'d under
  plain node --test).
- Tester: verified extraction genuinely eliminates the mirror; extended to 33
  tests (8 e2e + 25 unit). Full suite: 3355 pass, 3 fail (confirmed baseline).
- Tech-lead review: CLEAN, no findings. Confirmed the real ipcMain.handle
  wiring delegates to the same factory (re-invoked per-call so it correctly
  reads the reassigned `telemetryReceiver`), contract unchanged, no security
  concern (eval only ever operates on this repo's own trusted source file).
- Post-processing: independent security pass confirmed no issues; no doc
  changes needed (docs/telemetry.md describes only *what* is exposed via the
  IPC channel, not the internal implementation detail that changed).

## Additional Context
_(user-owned — leave blank)_
