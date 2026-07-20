---
id: TASK-089
title: Avoid transient over-subscription when parked defining tickets are answered
status: done
created: 2026-07-20T00:47:12Z
updated: 2026-07-20T01:03:18Z
review-of: TASK-087
activities: [{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-20T00:54:10Z","finishedAt":"2026-07-20T00:55:59Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-20T00:55:59Z","finishedAt":"2026-07-20T01:00:30Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-20T01:00:30Z","finishedAt":"2026-07-20T01:03:18Z"},{"activity":"post-processing","model":"claude-opus-4-8","startedAt":"2026-07-20T01:03:18Z","finishedAt":"2026-07-20T01:03:18Z"}]
---

## Description
Follow-up from the tech-lead review of TASK-087 (Finding 2, Low). TASK-087 exempts a
question-parked `defining` ticket from the concurrency slot count so it cannot stall the
swarm. But when such a ticket's freed slot is filled by a newly-dispatched build and the
human then answers the question, the ticket becomes actively-defining again and re-counts
as a slot — so instantaneous occupancy can momentarily EXCEED `limit` until an in-flight
build completes. Nothing re-checks the bound on the answer/resume path (resuming a
definition does not go through `selectNextBatch`).

The over-subscription is bounded (by how many answers land at once), self-corrects as
builds finish, and BA definition work is lighter than builds — so it is minor — but it is a
genuine deviation from a strict `limit` cap. Decide and implement a mitigation (BA/tech-lead
may refine): e.g. (a) when an answer arrives, only resume the BA definition if a slot is
free (`slotOccupancyCount < limit`), otherwise leave it parked-but-answered in `todo`/`defining`
until a slot frees; or (b) document the transient over-subscription as accepted behavior in
the SKILL/contract if the cost of strict capping outweighs the benefit. If (b), no code
change — just the contract note (both SKILL copies byte-identical).

## Acceptance Criteria
- [ ] Either: resuming an answered-question `defining` ticket respects the concurrency
  bound (does not push live slot occupancy above `limit`); OR the transient
  over-subscription is explicitly documented as accepted in the orchestrate contract with
  a rationale.
- [ ] If code changes: the mitigation is in `lib/ticket-queue.js` (pure) and/or the SKILL
  intake/resume prose, without reintroducing the stall TASK-087 fixed (parked-but-unanswered
  still frees its slot) and without making `defining` claimable.
- [ ] If the SKILL is edited, both copies stay byte-identical (drift guard green; no model
  id in Phase 2/3/4).
- [ ] Tests: unit/e2e cover the resume-at-limit behavior (either capped, or the documented
  accepted-behavior assertion). Green aside from the two known pre-existing unrelated
  failures.

## Cucumber Tests
```gherkin
Feature: Answering a parked definition does not over-subscribe the concurrency bound

  Scenario: Resuming an answered definition respects the limit
    Given the concurrency limit is reached (a build filled the slot a parked definition freed)
    When the parked definition's question is answered
    Then either the definition resume waits for a free slot
    And live slot occupancy never exceeds the limit
    # OR (if accepted-behavior option chosen) the contract documents the bounded transient
```

## Impact If Not Fixed
Under a burst of simultaneously-answered definitions the swarm may briefly run more agents
than `--concurrency`, slightly increasing git/resource contention; it resolves itself
without stalling and does not corrupt state, but it deviates from a strict concurrency cap.

## Edge Cases & Failure Paths
- Must not reintroduce the TASK-087 stall: a parked-but-unanswered `defining` ticket must
  still free its slot.
- Must not make `defining` claimable or dispatchable.
- The chosen approach must avoid a new deadlock (an answered definition that can never
  resume because the bound is always full — ensure definitions eventually make progress as
  builds finish).

## Relevant Files & Context
- `lib/ticket-queue.js` — `isSlotOccupyingTicket`, `slotOccupancyCount`, `selectNextBatch`,
  `canRunInParallel`.
- `lib/ticket-questions.js` — `isWaitingForAnswer` (parked predicate).
- `.claude/skills/orchestrate/SKILL.md` + `assets/` mirror — the intake/resume + concurrency
  prose (if a contract note is the chosen mitigation).
- Origin: tech-lead review of TASK-087, Finding 2 (Low).

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
