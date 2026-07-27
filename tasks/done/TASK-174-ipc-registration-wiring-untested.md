---
id: TASK-174
title: telemetry:getUsage/setProjectConfig ipcMain.handle registrations themselves are untested
status: done
created: 2026-07-27T01:15:38.000Z
updated: 2026-07-27T03:09:28.410Z
review-of: TASK-164
resolution: wont-do
---

## Description
Tech-lead review of TASK-164 found that while the extracted handler factory
BODIES (`createGetUsageHandler`, `createSetProjectConfigHandler`) are now well
tested, no test covers the actual `ipcMain.handle('telemetry:getUsage', ...)`
/ `('telemetry:setProjectConfig', ...)` registrations in main.js — specifically
that they call the correct factory, bind the correct channel name, and
correctly re-bind to the current module-level `telemetryReceiver` on each
invocation (not a stale reference captured at registration time).

This is the same class of gap already tracked for pty:spawn wiring as
TASK-169 — the extracted logic is tested, but the actual wiring connecting it
to the real IPC channel is not.

## Impact If Not Fixed
A regression that renamed a channel, swapped the two handler registrations
(e.g. `telemetry:getUsage` accidentally wired to the setProjectConfig
factory), or bound a stale/wrong `telemetryReceiver` reference would leave
every existing test green. The Stats-tab per-project usage read or the
store-online toggle could silently break at runtime despite a fully green
suite.

## Acceptance Criteria
- [ ] A test verifies `ipcMain.handle('telemetry:getUsage', ...)` is
      registered with a handler that delegates to `createGetUsageHandler`
      (not a different/swapped factory).
- [ ] A test verifies `ipcMain.handle('telemetry:setProjectConfig', ...)` is
      registered with a handler that delegates to `createSetProjectConfigHandler`.
- [ ] A test verifies the registration re-reads the current module-level
      `telemetryReceiver` on each invocation (i.e. reassigning
      `telemetryReceiver` between two calls changes which receiver instance
      the handler operates on) rather than capturing a stale reference at
      registration time.
- [ ] All tests green under `node --test` beyond the known pre-existing
      baseline failures.

## Cucumber Tests
```gherkin
Feature: telemetry IPC channel registrations are correctly wired

  Scenario: telemetry:getUsage channel delegates to the correct factory
    Given main.js's ipcMain.handle registrations
    When telemetry:getUsage is invoked via a mocked ipcMain
    Then it produces the same result as calling createGetUsageHandler directly

  Scenario: telemetry:setProjectConfig channel delegates to the correct factory
    Given main.js's ipcMain.handle registrations
    When telemetry:setProjectConfig is invoked via a mocked ipcMain
    Then it produces the same result as calling createSetProjectConfigHandler directly

  Scenario: Handler re-reads the current telemetryReceiver, not a stale one
    Given a fresh telemetryReceiver assigned after registration
    When telemetry:getUsage is invoked
    Then it operates on the NEW receiver, not one captured at registration time
```

## Relevant Files
- `C:\projects\claude-cmd-ui2\main.js` — `ipcMain.handle('telemetry:getUsage', ...)`
  and `('telemetry:setProjectConfig', ...)` registrations, `createGetUsageHandler`,
  `createSetProjectConfigHandler`, `telemetryReceiver` module-level variable,
  `initTelemetry()` (reassigns it).
- `C:\projects\claude-cmd-ui2\test\task-164-telemetry-getusage-setprojectconfig.test.js` /
  `.e2e.test.js` — existing factory-body test conventions to extend or a
  new file testing the registration layer itself.

## Additional Context
_(user-owned — leave blank)_
