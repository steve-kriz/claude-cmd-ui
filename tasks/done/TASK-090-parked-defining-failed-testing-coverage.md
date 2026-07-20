---
id: TASK-090
title: Cover the failed-testing dispatch path past parked defining tickets
status: done
created: 2026-07-20T00:47:12Z
updated: 2026-07-20T01:08:08Z
review-of: TASK-087
activities: [{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-20T01:03:18Z","finishedAt":"2026-07-20T01:06:00Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-20T01:06:00Z","finishedAt":"2026-07-20T01:08:08Z"},{"activity":"post-processing","model":"claude-opus-4-8","startedAt":"2026-07-20T01:08:08Z","finishedAt":"2026-07-20T01:08:08Z"}]
---

## Description
Follow-up from the tech-lead review of TASK-087 (Finding 3, Low, test-only). TASK-087's
AC-1 covers ready `todo` **and** `failed-testing` dispatch past parked-defining tickets, but
the unit and e2e suites only exercise ready `todo` tickets in the parked-at-limit scenario.
No test drives a `failed-testing` ticket through `selectNextBatch`/`canRunInParallel` while
parked definitions sit at the limit. The behavior is guaranteed by the shared `isClaimable`
path (which includes `failed-testing`), so it works — it is simply unverified.

Add coverage so the `failed-testing` half of AC-1 is explicit.

## Acceptance Criteria
- [ ] A unit and/or e2e test drives a ready `failed-testing` ticket (with fix attempts
  remaining) through `selectNextBatch`/`canRunInParallel` while enough parked-defining
  tickets sit at the limit that they would block if counted — and asserts the
  `failed-testing` ticket IS dispatched (parked defining frees the slot).
- [ ] The test uses the REAL `lib/ticket-queue.js` helpers; no product code changes
  (test-only).
- [ ] `node --test` green aside from the two known pre-existing unrelated failures.

## Cucumber Tests
```gherkin
Feature: Parked defining does not block failed-testing retries

  Scenario: A failed-testing ticket dispatches past parked definitions at the limit
    Given the concurrency limit is filled only by question-parked defining tickets
    And one failed-testing ticket with fix attempts remaining is ready
    When selectNextBatch/canRunInParallel are evaluated
    Then the failed-testing ticket is selected/dispatchable (parked defining frees the slot)
```

## Impact If Not Fixed
Half of TASK-087's acceptance criterion (the `failed-testing` retry path) is asserted only
implicitly; a future refactor that diverges `failed-testing` handling from `todo` in
`selectNextBatch` could ship undetected, leaving handed-back tickets unable to dispatch past
parked definitions.

## Edge Cases & Failure Paths
- Respect the Phase-3 3-attempt cap: a `failed-testing` ticket past its attempt cap should
  not be selected (keep consistency with existing selectNextBatch behavior).
- Do not duplicate the existing `todo` parked-at-limit coverage — add the `failed-testing`
  variant specifically.

## Relevant Files & Context
- `test/ticket-queue-parked-defining.test.js`, `test/task-087-parked-defining.e2e.test.js`
  (extend with the failed-testing case).
- `lib/ticket-queue.js` — `selectNextBatch`/`canRunInParallel`/`CLAIMABLE_STATUSES`
  (`failed-testing` is claimable).
- Origin: tech-lead review of TASK-087, Finding 3 (Low).

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
