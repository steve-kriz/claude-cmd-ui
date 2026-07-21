---
id: TASK-118
title: TASK-100 review: assert post-processing kind guard where it acts
status: done
created: 2026-07-21T02:07:59.621Z
updated: 2026-07-21T03:23:46.181Z
review-of: TASK-100
activities: [{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-21T02:58:00Z","finishedAt":"2026-07-21T03:18:27Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-21T02:58:00Z","finishedAt":"2026-07-21T03:21:38Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-21T03:02:00Z","finishedAt":"2026-07-21T03:23:46Z"}]
---

## Description
Review follow-up for TASK-100 (swarm guards), severity **minor**, TEST-ONLY — no change to `lib/ticket-queue.js` or `lib/ticket-lanes.js`.

The e2e "mixed board" scenario in `test/task-100-swarm-guards.e2e.test.js` (~95-130) includes a card `T('TASK-20', 'post-processing', { kind: POST_PROCESSING_KIND })` and comments that it "must not count toward slots either" — but that proves nothing about the KIND guard: status `post-processing` is already excluded from slot occupancy AND non-claimable by STATUS alone (`SLOT_OCCUPYING_STATUSES`=`['defining','in-progress','testing']`, `CLAIMABLE_STATUSES`=`['todo','failed-testing']`, and `isSlotOccupyingTicket` never inspects `kind`). Deleting `kind` changes no verdict. The KIND guard actually acts via `isPostProcessingTicket(fm)` in `claimTicket` (reason `'post-processing'`, before the `claimed` check), `canRunInParallel` (same, before `claimed`), and the `selectNextBatch` filter. Add tests where a `kind:post-processing` ticket whose STATUS is claimable (`todo`) is refused by all three with the kind-specific verdict — the KIND drives it, not the status — with a kind-less control at the same status proving the field flips the verdict. Correct the misleading mixed-board card/comment (must NOT claim kind-driven slot exclusion, which the status-only lib doesn't implement).

## Acceptance Criteria
- [ ] A new/strengthened TASK-100 test where a ticket `kind:'post-processing'` + status `'todo'` is: refused by `claimTicket(fm,'agent-A')` with `ok:false, reason:'post-processing'` (exactly, NOT `'not-claimable'`), fm not stamped in-progress/agent; refused by `canRunInParallel([], ticket, {limit:3})` with `ok:false, reason:'post-processing'` while `freeSlots>0`; never returned by `selectNextBatch` with free slots.
- [ ] A KIND-LESS control ticket at the same status `'todo'` IS granted by `claimTicket` (in-progress + agent) and selected by `selectNextBatch` in the same test(s) — proving the `kind` field alone flips every verdict.
- [ ] Precedence assertion: a `kind:post-processing` ticket ALSO claimed by a foreign agent (`agent:'other'`) still reports `reason:'post-processing'` (not `'claimed'`) from claimTicket/canRunInParallel.
- [ ] The e2e mixed-board scenario no longer relies on the vacuous status-`post-processing` card as evidence of the kind guard (card/comment corrected or scenario extended); no new assertion claims slotOccupancy excludes BY KIND (status-only lib; test-only ticket).
- [ ] Kind expressed via `POST_PROCESSING_KIND` from `../lib/ticket-lanes` (or the matching literal) — no new constants.
- [ ] `lib/ticket-queue.js` and `lib/ticket-lanes.js` byte-unchanged (only files under `test/` touched).
- [ ] All existing TASK-100 tests + the existing kind-guard tests in `test/ticket-queue.test.js` still pass, and the new tests pass, under `node --test`.

## Cucumber Tests
```gherkin
Feature: Post-processing KIND guard asserted where it acts (TASK-100 follow-up)
  Scenario: claimTicket refuses a kind:post-processing ticket in a claimable status
    Given a ticket id "PP-1" status "todo" kind "post-processing"
    When claimTicket runs for agent "agent-A"
    Then it is refused ok:false with reason exactly "post-processing" and no agent stamp
  Scenario: same status without the kind IS claimable (kind drives the verdict)
    Given a control ticket "OK-1" status "todo" with no kind
    When claimTicket runs for agent "agent-A"
    Then it is granted, status "in-progress", agent "agent-A"
  Scenario: canRunInParallel refuses by kind even with free slots
    Given an empty board, limit 3, and a new ticket status "todo" kind "post-processing"
    When canRunInParallel is asked
    Then ok:false reason "post-processing" and freeSlots 3 (not "no-slots"/"not-claimable")
  Scenario: selectNextBatch never returns a kind:post-processing ticket with claimable status
    Given a board with "todo" ticket "PP-1" kind "post-processing" and plain "todo" ticket "TASK-3", limit 3
    When selectNextBatch runs
    Then only "TASK-3" is returned
  Scenario: kind guard outranks the claimed verdict (precedence)
    Given a ticket status "todo" kind "post-processing" agent "other"
    When claimTicket runs for agent "agent-A"
    Then the reason is "post-processing", not "claimed"
```

## Edge Cases & Failure Paths
- Reason string exact `'post-processing'` (not `'not-claimable'`). canRunInParallel run with freeSlots>0 so `'no-slots'` can't mask it. kind + foreign agent → `'post-processing'` (guard before isClaimed). Slot occupancy is STATUS-only — do NOT assert kind-driven slot exclusion (would fail or force an out-of-scope lib change). `isPostProcessingTicket` unwraps `{fm}` — keep the per-function calling conventions (bare fm into claimTicket, wrappers into selectNextBatch). Control ticket required so a future all-todo-unclaimable regression can't pass silently. Don't weaken the mixed-board scenario's other assertions. No cucumber package (plain closures).

## Relevant Files & Context
- `test/task-100-swarm-guards.e2e.test.js` — the vacuous card (~95-130, card ~line 107); imports POST_PROCESSING_KIND from ../lib/ticket-lanes + the queue fns; `scenario/Given/When/Then/And` closures + `T(id,status,extra)` factory.
- `test/task-100-swarm-guards.test.js` — companion unit file (same T() factory), home for new unit-level kind assertions.
- `lib/ticket-queue.js` — READ ONLY: kind guard in claimTicket (~279), selectNextBatch filter (~356), canRunInParallel (~418); SLOT_OCCUPYING_STATUSES (~73) + isSlotOccupyingTicket (~113) status-only.
- `lib/ticket-lanes.js` — READ ONLY: POST_PROCESSING_KIND (~52), isPostProcessingTicket (~77, {fm}-tolerant).
- `test/ticket-queue.test.js` — existing kind-guard patterns to mirror (~423, ~433, ~645). Run `node --test test/task-100-swarm-guards.test.js test/task-100-swarm-guards.e2e.test.js test/ticket-queue.test.js`.

## Impact If Not Fixed
The suite gives false confidence that the post-processing-kind exclusion is verified within slot/claim math; a regression making a kind:post-processing ticket claimable could ship without a failing test.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
