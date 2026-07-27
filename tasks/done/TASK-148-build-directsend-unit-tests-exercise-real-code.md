---
id: TASK-148
title: Build direct-send unit tests must exercise the real function
status: done
created: 2026-07-26T06:58:46.761Z
updated: 2026-07-26T21:52:59.213Z
review-of: TASK-143
resolution: wont-do
---

## Description

`test/task-143-build-direct-send.test.js` (all 23 cases) never extracts or calls the real
`startBuildOrQueue` / `toggleAutoBuild` from `renderer/renderer.js`. Each "unit test"
hand-recomputes the `noRunningTask` boolean and the two-write / `\r`-guard / log-source
logic inline and asserts on that copy, so the tests would still pass unchanged if
`startBuildOrQueue` were broken or deleted. Only the e2e file
(`test/task-143-build-direct-send.e2e.test.js`) actually drives the shipped code.

Rewrite the unit file to extract and invoke the REAL `startBuildOrQueue` via the same
`extractFn` brace-matching harness the e2e file (and `test/task-135-restart-queue-race.e2e.test.js`)
use — or delete it and fold any unique assertions into the e2e file — so every assertion
runs against shipped renderer code.

## Impact If Not Fixed
23 green tests give false confidence that `startBuildOrQueue` is unit-covered when it is
not: a future regression (dropping the awaiting-TUI check, the null-id `\r` guard, or the
empty-queue condition) can ship with a fully green suite, so the safety contract silently
erodes and the misleading tests become a maintenance trap.

## Acceptance Criteria
- [ ] `test/task-143-build-direct-send.test.js` extracts and invokes the real
      `startBuildOrQueue` (and where relevant `toggleAutoBuild`) from
      `renderer/renderer.js` via the `extractFn` brace-matching harness — no test asserts
      on a hand-recomputed copy of the branch logic.
- [ ] Every retained assertion fails if the corresponding real-code branch is broken
      (verify by a quick local mutation check described in the ticket, not committed):
      e.g. removing the `!isAwaitingTuiSelection` term, the empty-queue term, or the
      null-id `\r` guard makes at least one test fail.
- [ ] Uses a recording `window.api.pty.write` stub and mock DOM; no real PTY, Electron,
      DB, or network.
- [ ] If the file is instead deleted, its unique assertions are folded into
      `test/task-143-build-direct-send.e2e.test.js` so coverage is not lost.
- [ ] Full suite green under `node --test` beyond the known baseline failures; no new
      failures introduced.

## Cucumber Tests
```gherkin
Feature: TASK-143 unit tests exercise the real startBuildOrQueue

  Scenario: Tests drive shipped code, not a copy
    Given the unit test file for the build direct-send
    When it runs
    Then it has extracted and called the real startBuildOrQueue from renderer.js
    And no assertion is made against a re-implemented noRunningTask boolean

  Scenario (mutation guard): Breaking the gate fails a test
    Given the awaiting-TUI term is removed from the real startBuildOrQueue
    When the unit suite runs
    Then at least one test fails

  Scenario (edge): No real I/O
    Given the tests run
    Then window.api.pty.write is a recording stub and no real PTY/Electron/network is used
```

## Relevant Files & Context
- `test/task-143-build-direct-send.test.js` — rewrite (or remove + fold into the e2e file).
- `test/task-143-build-direct-send.e2e.test.js` and `test/task-135-restart-queue-race.e2e.test.js` — the `extractFn` harness pattern to follow.
- `renderer/renderer.js` — `startBuildOrQueue` (~10422-10448), `toggleAutoBuild` (~10355-10380). Do not change behaviour; this is a test-only ticket.
- Runner `node --test`; `cucumber` not installed; mock all I/O.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
