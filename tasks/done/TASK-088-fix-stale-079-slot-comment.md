---
id: TASK-088
title: Fix stale slot-math comment/assertion in the TASK-079 parallel e2e test
status: done
created: 2026-07-20T00:47:12Z
updated: 2026-07-20T00:54:10Z
review-of: TASK-087
activities: [{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-20T00:50:04Z","finishedAt":"2026-07-20T00:52:30Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-20T00:52:30Z","finishedAt":"2026-07-20T00:54:10Z"},{"activity":"post-processing","model":"claude-opus-4-8","startedAt":"2026-07-20T00:54:10Z","finishedAt":"2026-07-20T00:54:10Z"}]
---

## Description
Follow-up from the tech-lead review of TASK-087 (Finding 1, Low, test-only). After
TASK-087, a question-parked `defining` ticket occupies **0** concurrency slots. But
`test/task-079-parallel.e2e.test.js` (~lines 333-345) builds a PARKED defining ticket
(`status: 'defining'`, `question: 'Which API?'`, `answer: ''`) and comments "free slots =
3 − 1 defining = 2". That rationale is now wrong (a parked defining ticket contributes 0),
and the `deepEqual(batch, ['TASK-6','TASK-7'])` assertion still passes only because there
happen to be exactly two `todo` tickets — so the test no longer validates what its comment
claims.

Fix the test so its rationale and assertion reflect the post-TASK-087 slot math: either
make the defining ticket actively-defining (no unanswered question, so it legitimately
counts as 1 slot and "3 − 1 = 2" holds), or keep it parked and update the comment +
expected free-slot count to reflect 0 occupancy. The test must genuinely validate the slot
math, not pass by coincidence.

## Acceptance Criteria
- [ ] `test/task-079-parallel.e2e.test.js`'s parked/defining slot-math scenario has a
  comment and assertion consistent with the actual `slotOccupancyCount` behavior after
  TASK-087 (parked defining = 0 slots; active defining = 1 slot).
- [ ] The scenario genuinely exercises the slot math (e.g. distinguishes the parked vs
  active case) rather than passing only because the todo count happens to match.
- [ ] No product/implementation code is changed — test-only.
- [ ] `node --test` green aside from the two known pre-existing unrelated failures.

## Cucumber Tests
```gherkin
Feature: The TASK-079 parallel e2e slot-math assertion is accurate post-TASK-087

  Scenario: Parked-defining rationale matches 0-slot occupancy
    Given the TASK-079 parallel e2e slot scenario
    Then its comment and expected free-slot count reflect that a parked defining ticket occupies 0 slots
    And the assertion fails if the slot math regresses (not only when the todo count coincides)
```

## Impact If Not Fixed
The test carries an incorrect rationale and silently under-tests the slot math; a future
reader could trust the "3 − 1 = 2" comment and mis-model the concurrency rule, and a real
slot-math regression could slip through because the assertion passes coincidentally.

## Edge Cases & Failure Paths
- Do not weaken the scenario's other assertions when correcting the slot rationale.
- Keep consistency with `test/ticket-queue-parked-defining.test.js` (the authoritative
  parked-vs-active unit coverage).

## Relevant Files & Context
- `test/task-079-parallel.e2e.test.js` ~333-345 (the stale scenario).
- `lib/ticket-queue.js` — `slotOccupancyCount` / `isSlotOccupyingTicket` (authoritative
  behavior).
- `test/ticket-queue-parked-defining.test.js` — the TASK-087 parked/active coverage.
- Origin: tech-lead review of TASK-087, Finding 1 (Low).

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
