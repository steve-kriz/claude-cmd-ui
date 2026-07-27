---
id: TASK-145
title: Renderer cost-display and live-correlation test coverage
status: done
created: 2026-07-26T06:32:29.644Z
updated: 2026-07-26T07:46:09.143Z
review-of: TASK-142
activities: [{"activity":"code","model":"claude-sonnet-5","startedAt":"2026-07-26T07:35:05.905Z","finishedAt":"2026-07-26T07:40:29.102Z","durationMs":323197},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-26T07:44:00.000Z","finishedAt":"2026-07-26T07:45:41.490Z","durationMs":101490},{"activity":"post-processing","startedAt":"2026-07-26T07:46:09.143Z","finishedAt":"2026-07-26T07:46:09.143Z","durationMs":0}]
---

## Description

TASK-142's e2e test (`test/task-142-cost-breakdown.e2e.test.js`) extracts the renderer
functions `ticketActivityLineFor`, `ticketActivityTotalLine`, and
`totalTicketActivities` from `renderer/renderer.js` into a `renderer` object (~lines
50-65) but **no test case ever calls them** — every assertion instead goes through the
`lib/ticket-cost.js` mirror or hand-built literals. As a result the new, most
user-visible renderer code paths run zero times under test: the cache-hit fragment in
`ticketActivityLineFor` / `ticketActivityTotalLine`, and the entire modal
live-correlation block in `fill()` (persisted-precedence gating, the
`window.api.telemetry.usageForWindow` call, the `isConnected` guard, the `(live)`
fragment, and the `!usage.requests` no-fabrication early return).

This ticket adds tests that actually execute those renderer branches.

## Impact If Not Fixed
A regression in the renderer's cache-fragment formatting or in the live-correlation
gating (e.g. appending a fabricated `0`, dropping the `isConnected` guard, or querying
telemetry when persisted values already exist) would ship undetected because no test
executes those branches. The feature's most logic-heavy, most user-visible code path is
effectively unverified.

## Acceptance Criteria
- [ ] New test cases invoke the loaded `ticketActivityLineFor` and
      `ticketActivityTotalLine` from `renderer/renderer.js` and assert the `"<read>/<creation> cache"`
      fragment appears when cache fields are present and is dropped when both cache
      fields are absent.
- [ ] A test exercises the modal live-correlation logic covering all four branches:
      (a) an activity WITH persisted token/cost numbers does NOT trigger a
      `usageForWindow` query (persisted precedence), (b) a returned usage with
      `requests: 0` / empty appends NO fragment (no fabricated zeroes), (c) a successful
      non-empty usage appends the `(live)` usage fragment, (d) a rejected or
      `ok: false` / `usage: null` IPC result leaves the row text unchanged and throws no
      error.
- [ ] The tests execute the REAL extracted renderer code (not a lib mirror or
      hand-built literal), using the existing brace-matching extraction + mock-DOM /
      recording-stub pattern already present in the test file (and in other renderer
      e2e tests).
- [ ] `window.api.telemetry.usageForWindow` is a recording stub — no real IPC, Electron,
      network, or DB.
- [ ] All tests run green under `node --test` with no new failures beyond the known
      pre-existing baseline.

## Cucumber Tests
```gherkin
Feature: Renderer cost-display and live-correlation are actually tested

  Background:
    Given ticketActivityLineFor and ticketActivityTotalLine are extracted from renderer.js
    And window.api.telemetry.usageForWindow is a recording stub
    And the DOM is mocked (no Electron, network, or DB)

  Scenario: Cache fragment shown when cache fields present
    Given an activity entry with cacheReadTokens 28905 and cacheCreationTokens 0
    When ticketActivityLineFor renders it
    Then the output contains a "28905/0 cache" fragment

  Scenario: Cache fragment dropped when both cache fields absent
    Given an activity entry with no cache fields
    When ticketActivityLineFor renders it
    Then the output contains no cache fragment

  Scenario: Persisted numbers suppress the live query
    Given an activity row whose entry already carries tokens and cost
    When the modal cost block runs
    Then window.api.telemetry.usageForWindow is not called for that row

  Scenario: Live correlation appends a (live) fragment for un-persisted activities
    Given an activity row with only model and start/finish timestamps
    And the stub returns usage with requests 2 and non-zero tokens
    When the modal cost block runs
    Then the row gains a "(live)" usage fragment

  Scenario (failure/edge): Empty or failed telemetry leaves the row unchanged
    Given an activity row with no persisted numbers
    When the stub returns { ok: true, usage: null } or rejects
    Then the row text is unchanged
    And no fabricated zero is appended
    And no error is thrown
```

## Relevant Files & Context
- `renderer/renderer.js` — `ticketActivityLineFor` (~6723-6731), `ticketActivityTotalLine`
  (~6757-6763), and the modal `.task-modal-cost` live-correlation block in `fill()`
  (~9875-9920). Do not change behaviour; this is a test-only ticket unless a bug is found.
- `test/task-142-cost-breakdown.e2e.test.js` — extend this file; it already loads the
  renderer functions (~50-65) but never calls them. Follow the brace-matching extraction
  + mock-DOM pattern used in other renderer e2e tests (e.g.
  `test/task-135-restart-queue-race.e2e.test.js`).
- Runner is `node --test`; `cucumber` is not installed and must not be added; mock all I/O.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
