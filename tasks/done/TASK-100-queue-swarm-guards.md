---
id: TASK-100
title: Swarm-safety guards - user statuses never claimable/active/slot-occupying (lib/ticket-queue.js)
status: done
created: 2026-07-20T13:15:00Z
updated: 2026-07-20T21:16:48.307Z
order: 11
activities: [{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-20T21:02:32Z","finishedAt":"2026-07-20T21:06:40Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-20T21:07:00Z","finishedAt":"2026-07-20T21:11:29Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-20T21:16:00Z","finishedAt":"2026-07-20T21:16:47Z"}]
---

## Description
Encode design rule 2 in code and tests: the swarm's contract is pegged to system statuses
only. Verify and harden `claimTicket`, `canRunInParallel`, `selectNextBatch`,
`resolveConcurrency` so a ticket in a user status (a) is never selected/claimed (claimable
set stays exactly `todo`/`failed-testing`), (b) never counts toward slot occupancy (occupancy
set stays exactly `defining`/`in-progress`/`testing`, with the parked-defining exemption
intact), and (c) produces a clear `not-claimable` reason from `canRunInParallel`. Export a
documented `SWARM_STATUSES` (or equivalently documented constant) naming the system-owned set,
so the boundary is explicit rather than incidental.

## Clarifications
- Q1 tension resolution (b): user-added statuses are ignored by all slot/claim math; the read-only SKILL.md's slot rules remain exactly true.

## Acceptance Criteria
- [ ] With a board containing tickets in user statuses (e.g. `ux-review`), `selectNextBatch` never returns them and its free-slot math is identical to the same board without them.
- [ ] `canRunInParallel` on a user-status ticket returns `ok:false` with reason `not-claimable`.
- [ ] `claimTicket` refuses a user-status ticket (only `todo`/`failed-testing` claimable — unchanged).
- [ ] Slot occupancy counts only `defining`/`in-progress`/`testing` (parked-defining exemption preserved — `test/ticket-queue-parked-defining.test.js` passes unmodified).
- [ ] An exported, documented constant names the swarm-owned status set; header comment states the user-status boundary.
- [ ] All existing queue tests pass unmodified (`test/ticket-queue.test.js`, `test/ticket-queue-slots.test.js`, `test/ticket-queue.e2e.test.js`).
- [ ] New unit + e2e tests (`task-100-*` pair) cover mixed boards (system + user statuses + post-processing kind).

## Cucumber Tests
```gherkin
Feature: Swarm ignores user statuses
  Scenario: Batch selection skips user columns
    Given a board with 2 todo tickets and 3 ux-review tickets and limit 3
    When selectNextBatch runs
    Then only the 2 todo tickets are returned and freeSlots math ignores ux-review

  Scenario: User-status ticket cannot be claimed (failure)
    When claimTicket runs on a ticket with status "ux-review"
    Then the claim is refused

  Scenario: Occupancy unchanged by user statuses (edge)
    Given 3 in-progress tickets and 5 ux-review tickets with limit 3
    Then canRunInParallel reports no-slots for a new todo ticket
    And removing the ux-review tickets does not change the verdict
```

## Edge Cases & Failure Paths
- Ticket whose status was hand-edited to a user slug mid-build (next scan simply stops considering it — claim already held is released on terminal state as today); `kind: post-processing` guard unchanged; unknown statuses equally non-claimable.

## Relevant Files & Context
- `lib/ticket-queue.js` (claims/slots/concurrency — single authority); `lib/ticket-lanes.js`.
- Existing queue tests listed above.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
