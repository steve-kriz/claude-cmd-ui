---
id: TASK-110
title: claimTicket same-agent re-entry re-claims a user-status ticket
status: done
created: 2026-07-21T02:07:59.621Z
updated: 2026-07-21T02:34:20.955Z
review-of: TASK-100
activities: [{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-21T02:20:00Z","finishedAt":"2026-07-21T02:27:51Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-21T02:22:00Z","finishedAt":"2026-07-21T02:32:15Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-21T02:23:00Z","finishedAt":"2026-07-21T02:34:20Z"}]
---

## Description

`lib/ticket-queue.js` `claimTicket` gates its user-status/not-claimable guard behind `!isClaimedBy(src, id)`. When a ticket is already claimed by the SAME agent, that guard is skipped entirely and execution falls through to the grant block — re-stamping `status: in-progress`, bumping `updated`, and pulling the ticket OUT of a user-defined column (e.g. `ux-review`) back into in-progress. This diverges from the two sibling decision functions, which both refuse the identical same-agent + user-status input: `canRunInParallel` returns `ok:false, reason:'not-claimable'`, and `selectNextBatch` never selects it (same-agent path requires `isClaimable || isActive`).

**Fix:** evaluate the `isUserStatus(status)` guard unconditionally on the pickup path — NOT gated behind `!isClaimedBy(src, id)` — so a user-status ticket is refused with `reason: 'not-claimable'` regardless of same-agent ownership. Keep the guard BELOW the foreign-claim check so a user-status ticket claimed by a DIFFERENT agent still reports `reason: 'claimed'`, and keep the `!isClaimable(status)` half gated behind `!isClaimedBy` so same-agent re-entry from swarm statuses (`in-progress`, `testing`, `todo`, `failed-testing`) keeps returning `ok:true`. `claimTicket` stays pure. Add a regression test.

Severity from review: **major**. This is a review follow-up of TASK-100.

## Acceptance Criteria

- [ ] `claimTicket({ status: 'ux-review', agent: 'agent-1' }, 'agent-1')` returns `ok: false` with `reason: 'not-claimable'` — a user-status ticket is refused even when claimed by the SAME agent (the reported bug).
- [ ] On that refusal the returned `fm` is unchanged in substance: `status` remains the user status, `agent` remains stamped, `updated` is NOT bumped, and the input frontmatter object is not mutated (purity preserved).
- [ ] An UNCLAIMED user-status ticket still returns `ok: false, reason: 'not-claimable'`.
- [ ] Reason precedence is preserved exactly: `no-agent-id` → `post-processing` → `claimed` (foreign agent) → `not-claimable`. A user-status ticket claimed by a DIFFERENT agent still reports `reason: 'claimed'`; a `kind: post-processing` ticket still reports `'post-processing'` regardless of status.
- [ ] `claimTicket` and `canRunInParallel` compose: for a same-agent user-status ticket both return `ok: false` with `reason: 'not-claimable'`; a regression test asserts both verdicts side by side.
- [ ] Same-agent re-entry on a swarm status is UNCHANGED: `claimTicket({ status: 'in-progress', agent: 'a1' }, 'a1')` still returns `ok: true` keeping owner/status and bumping `updated`; same-agent re-entry from `todo`/`failed-testing`/`testing` still grants.
- [ ] Normal system-status claiming is UNCHANGED: fresh `todo`/`failed-testing` grant; foreign-claimed refuse `'claimed'`; unowned `in-progress`/`testing`/`done` refuse `'not-claimable'`; blank agent id refuses `'no-agent-id'`.
- [ ] A regression test for the same-agent user-status refusal is added (plain `node --test`, no Electron imports).
- [ ] All existing tests in `test/ticket-queue.test.js`, `test/ticket-queue-slots.test.js`, `test/ticket-queue-parked-defining.test.js`, `test/ticket-queue.e2e.test.js`, `test/task-100-swarm-guards.test.js`, `test/task-100-swarm-guards.e2e.test.js` pass UNMODIFIED.

## Cucumber Tests

```gherkin
Feature: claimTicket refuses user-status tickets even on same-agent re-entry

  Scenario: same-agent re-entry on a user-status ticket is refused (the bug)
    Given a ticket with status "ux-review" and agent "agent-1"
    When claimTicket runs for agent "agent-1"
    Then the result is ok:false with reason "not-claimable"
    And the returned frontmatter still has status "ux-review" and agent "agent-1"
    And the "updated" timestamp is not bumped
    And the input frontmatter object is not mutated

  Scenario: claimTicket and canRunInParallel agree on the same-agent user-status input
    Given a ticket with status "ux-review" and agent "agent-1"
    When claimTicket runs for agent "agent-1"
    And canRunInParallel runs on an empty board for the same ticket with agentId "agent-1"
    Then both results are ok:false with reason "not-claimable"

  Scenario: unclaimed user-status ticket is still refused
    Given a ticket with status "ux-review" and no agent field
    When claimTicket runs for agent "agent-A"
    Then the result is ok:false with reason "not-claimable"

  Scenario: user-status ticket owned by a DIFFERENT agent still reports claimed
    Given a ticket with status "ux-review" and agent "other"
    When claimTicket runs for agent "agent-A"
    Then the result is ok:false with reason "claimed"

  Scenario: same-agent re-entry on a swarm ACTIVE status still grants (unchanged)
    Given a ticket with status "in-progress" and agent "agent-1"
    When claimTicket runs for agent "agent-1"
    Then the result is ok:true
    And the frontmatter keeps agent "agent-1" and status "in-progress"
    And "updated" is bumped and "created" is preserved

  Scenario Outline: fresh claimable tickets still grant (unchanged)
    Given an unclaimed ticket with status "<status>"
    When claimTicket runs for agent "agent-1"
    Then the result is ok:true with status "in-progress" and agent "agent-1"

    Examples:
      | status         |
      | todo           |
      | failed-testing |

  Scenario: post-processing precedence still wins over the user-status guard
    Given a ticket with kind "post-processing", status "ux-review", and agent "agent-1"
    When claimTicket runs for agent "agent-1"
    Then the result is ok:false with reason "post-processing"
```

## Edge Cases & Failure Paths

- Same-agent + user status (the bug): must refuse `'not-claimable'`, never grant.
- Foreign agent + user status: must still report `'claimed'` (new guard sits BELOW the foreign-claim check).
- `kind: post-processing` + user status (+ same agent): must still report `'post-processing'`.
- Blank/missing agent id: still `'no-agent-id'` first, regardless of status.
- Empty/whitespace/absent status: `isUserStatus` returns false for these — do NOT widen it.
- Same-agent re-entry from non-claimable, non-active swarm statuses (`done`, `defining`): out of scope — only the `isUserStatus` term becomes unconditional; do not change that path.
- Purity/immutability on the new refusal path: return `orderFm(src)`; never mutate input, never bump `updated` on refusal.
- Do NOT touch `canRunInParallel`, `selectNextBatch`, `isUserStatus`, `SWARM_STATUSES`, or `CLAIMABLE_STATUSES`.

## Relevant Files & Context

- `lib/ticket-queue.js` — the only source file to change. `claimTicket`: foreign-claim check (`reason:'claimed'`); the buggy guard `if (!isClaimedBy(src, id) && (isUserStatus(status) || !isClaimable(status)))`. Fix shape: check `isUserStatus(status)` unconditionally (below the foreign-claim check) via an early `if (isUserStatus(status)) return { ok:false, fm: orderFm(src), reason:'not-claimable' };`, leaving `!isClaimedBy(src,id) && !isClaimable(status)` with its gate. Update the adjacent comment (the term is now load-bearing on the same-agent path). `isUserStatus`, `isClaimedBy`, `isClaimed`, `isClaimable`, `SWARM_STATUSES`, `canRunInParallel`, `selectNextBatch` — leave as is.
- `test/task-100-swarm-guards.test.js` — natural home for the new same-agent regression test; follow its plain-assert style. Existing verdicts (user-status refusal, todo grants, foreign-claim precedence, canRunInParallel, selectNextBatch) must keep passing.
- `test/ticket-queue.test.js` — the same-agent re-entry idempotency test (status `in-progress`) MUST keep passing; grant/reject/purity/precedence cases unchanged.
- `test/ticket-queue-slots.test.js`, `test/ticket-queue-parked-defining.test.js`, `test/ticket-queue.e2e.test.js`, `test/task-100-swarm-guards.e2e.test.js` — must pass unmodified.
- Tests run with plain `node --test`. 2 pre-existing unrelated baseline failures exist; every ticket-queue/task-100 test must pass.

## Impact If Not Fixed
A ticket an agent parked into a user column mid-build (moved to a user status while `agent` is still stamped) can be silently yanked back to in-progress on the next same-agent re-entry, overriding the user's manual board move and violating the swarm/user-status boundary this ticket established.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
