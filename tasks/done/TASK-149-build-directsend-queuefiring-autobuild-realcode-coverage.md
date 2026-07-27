---
id: TASK-149
title: Real-code coverage for queueFiring gate and auto-build queue routing
status: done
created: 2026-07-26T06:58:46.761Z
updated: 2026-07-26T21:53:12.489Z
review-of: TASK-143
resolution: wont-do
---

## Description

Two TASK-143 acceptance criteria are currently asserted only against stubs / inline
copies rather than real code paths:
1. The `!tab.queueFiring` short-circuit in `startBuildOrQueue` — no test drives the real
   `startBuildOrQueue` with `tab.queueFiring === true`.
2. "The auto-build continuation loop (`maybeContinueBuild`) and auto-build-on-create
   (`autoQueueBuildOnCreate`) still go through `queueBuild`" — the regression case in
   `test/task-143-build-direct-send.e2e.test.js` (~lines 405-421) calls `deps.queueBuild`
   directly instead of exercising the real `maybeContinueBuild` / `autoQueueBuildOnCreate`.

Add real-code coverage for both.

## Impact If Not Fixed
An accidental change routing `maybeContinueBuild` / `autoQueueBuildOnCreate` through the
new direct-send, or dropping `!tab.queueFiring` from the gate, would not be caught by any
real-code test — reintroducing the overlapping-run / duplicate-build behavior the queue
path exists to prevent (a mid-dispatch double-fire or an auto-build loop that direct-writes
instead of queuing).

## Acceptance Criteria
- [ ] A test drives the REAL `startBuildOrQueue` with `tab.queueFiring === true` (other
      conditions satisfying the direct-send gate) and asserts it enqueues via `queueBuild`
      and performs NO direct `window.api.pty.write`.
- [ ] A real-code assertion verifies `maybeContinueBuild` and `autoQueueBuildOnCreate`
      reference `queueBuild` and NOT `startBuildOrQueue` (source-extraction / substring
      check on the real function bodies, as `test/task-135-restart-queue-race.e2e.test.js`
      does for its drift guards).
- [ ] The tests use the real extracted functions and a recording `pty.write` stub; no
      hand-recomputed logic; no real PTY/Electron/DB/network.
- [ ] Full suite green under `node --test` beyond the known baseline failures; no new
      failures introduced.

## Cucumber Tests
```gherkin
Feature: queueFiring and auto-build routing are covered against real code

  Scenario: queueFiring forces the queue path
    Given the real startBuildOrQueue is invoked with tab.queueFiring true and otherwise idle
    When it runs
    Then it delegates to queueBuild
    And no direct pty.write occurs

  Scenario: Auto-build loop routes through the queue
    Given the real maybeContinueBuild and autoQueueBuildOnCreate bodies
    When their source is inspected
    Then they reference queueBuild and not startBuildOrQueue

  Scenario (edge): No real I/O
    Given the tests run
    Then pty.write is a recording stub and no real PTY/Electron/network is used
```

## Relevant Files & Context
- `test/task-143-build-direct-send.e2e.test.js` — add the `queueFiring===true` real-code
  case and replace the stub-based auto-build regression case (~405-421) with a real-code
  source-extraction assertion.
- `renderer/renderer.js` — `startBuildOrQueue` (~10422-10448), `maybeContinueBuild`
  (~10304 region), `autoQueueBuildOnCreate` (~10347 region), `queueBuild` (~10452-10456).
  Do not change behaviour; test-only ticket.
- Follow the `extractFn` + drift-guard patterns in `test/task-135-restart-queue-race.e2e.test.js`.
- Runner `node --test`; `cucumber` not installed; mock all I/O.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
