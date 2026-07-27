---
id: TASK-160
title: main.js pty:spawn OTEL env-overlay wiring lacks real-code test coverage
status: done
created: 2026-07-26T22:24:33.000Z
updated: 2026-07-27T00:23:07.000Z
agent: swarm-orch1
review-of: TASK-153
---

## Description
Extracted the `pty:spawn` handler's env-overlay-building logic into
`buildOtelProjectEnv(project)` in main.js, following the
`createUsageForWindowHandler`/`augmentDarwinPath` extraction precedent. The
real `ipcMain.handle('pty:spawn', ...)` now calls this function. Both TASK-153
test files updated to source-extract and invoke the real function instead of a
source-text regex + hand-rolled mirror.

## Acceptance Criteria
- [x] Env-overlay logic extracted into one requireable function used by BOTH
      the real handler wiring and the tests.
- [x] Existing TASK-153 test scenarios rewritten to invoke the extracted
      function directly.
- [x] Mutation-style check verified (removing `encodeURIComponent` fails the
      "encodes special characters correctly" test).
- [x] No behavioral change to the handler's contract or `spawnShell`'s
      signature.
- [x] All tests green beyond the known pre-existing baseline failures
      (independently re-confirmed stable at 3364/3360/3 after an initial
      transient flake).

## Cucumber Tests
```gherkin
Feature: pty:spawn env-overlay logic is covered against real code

  Scenario: The real extracted function builds the OTEL env overlay
    Given the extracted env-overlay-building function
    When it is invoked directly with project "C:\\projects\\alpha"
    Then it returns { OTEL_RESOURCE_ATTRIBUTES: "project=C%3A%5Cprojects%5Calpha" }

  Scenario: main.js's ipcMain.handle wiring calls the same function
    Given the main.js pty:spawn registration
    When inspected
    Then it calls the same extracted function the tests import

  Scenario (edge): Empty/absent project yields no overlay from the real function
    Given the extracted function invoked with an empty/absent project
    When its result is inspected
    Then it is undefined / contains no OTEL_RESOURCE_ATTRIBUTES key
```

## Relevant Files
- `C:\projects\claude-cmd-ui2\main.js` — `buildOtelProjectEnv` (line 376),
  called at line 387, exported line 2161.
- `C:\projects\claude-cmd-ui2\test\task-153-otel-resource-tags.e2e.test.js`
- `C:\projects\claude-cmd-ui2\test\task-153-otel-resource-tags.test.js`

## Build/Test/Review Notes
- Coder: extracted `buildOtelProjectEnv`; updated both test files to invoke
  the real function; manually verified the mutation guard.
  **INCIDENT**: coder reported a stray `git checkout -- main.js` mid-task that
  briefly discarded uncommitted work, restored from a backup. The orchestrator
  independently re-verified main.js's integrity (all prior-session functions
  present, node -c clean, full suite stable) — nothing was actually lost.
- Tester: re-verified main.js integrity independently once more (all functions
  confirmed present); full suite 3361/3357/3 at that point, later reconfirmed
  stable at 3364/3360/3 by the orchestrator (one transient flake in between
  showing "fail 4" resolved on re-run — not a real regression).
- Tech-lead review: implementation correct and secure; independently
  re-verified main.js integrity post-incident with a higher-than-usual bar
  given the incident — CLEAN, nothing lost or reverted from TASK-152-158's
  work. One low-severity follow-up: TASK-169 — the handler's actual CALL to
  `buildOtelProjectEnv` (as opposed to the function itself) is unasserted; a
  dead `extractHandlerBlock` test helper exists but is never used.
- Post-processing: independent security pass found no issues (byte-identical
  logic, no new capability from exporting a pure function). No doc changes
  needed for this refactor-only ticket (docs/telemetry.md's behavioral
  description stays accurate regardless of inline-vs-extracted implementation;
  a pre-existing, out-of-scope gap in docs/ipc-bridge.md and docs/terminals.md
  not documenting the `project` pty:spawn param predates this ticket, from
  TASK-153, not newly introduced here).

## Additional Context
_(user-owned — leave blank)_
