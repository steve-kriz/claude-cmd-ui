---
id: TASK-086
title: Fix SKILL free-slot prose to match the defining-counts-against-the-bound rule
status: done
created: 2026-07-20T00:08:05Z
updated: 2026-07-20T00:21:21Z
review-of: TASK-079
activities: [{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-20T00:10:14Z","finishedAt":"2026-07-20T00:12:42Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-20T00:12:42Z","finishedAt":"2026-07-20T00:17:48Z"},{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-20T00:17:48Z","finishedAt":"2026-07-20T00:18:30Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-20T00:18:30Z","finishedAt":"2026-07-20T00:18:57Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-20T00:18:57Z","finishedAt":"2026-07-20T00:21:21Z"},{"activity":"post-processing","model":"claude-opus-4-8","startedAt":"2026-07-20T00:21:21Z","finishedAt":"2026-07-20T00:21:21Z"}]
---

## Description
Follow-up from the tech-lead review of TASK-079 (Finding 1, Medium). TASK-079 Part C made
a `defining` ticket count against the concurrency bound (free slots =
`limit − (in-progress + testing + defining)`, via `slotOccupancyCount` in
`lib/ticket-queue.js`). But three places in the orchestrate instruction contract still
describe the free-slot math as `limit − active count` (which excludes `defining`),
contradicting Part C and the shipped code. Because the orchestrator is an LLM that follows
this prose, the contradiction can make it reason about capacity with the stale formula.

Fix the prose in BOTH SKILL copies (byte-identical) so the free-slot math is described as
`limit − (in-progress + testing + defining)` (or equivalently "slot-occupancy count,
which now includes `defining`"), consistent with `lib/ticket-queue.js` and the Part C
intake wording.

## Acceptance Criteria
- [ ] `.claude/skills/orchestrate/SKILL.md` no longer describes the `selectNextBatch` /
  `canRunInParallel` free-slot math as `limit − active count` where that wording implies
  `defining` is excluded; it states free slots = `limit − (in-progress + testing +
  defining)` (or references the slot-occupancy count that includes `defining`), at all
  three occurrences (~lines 278, 434, 440).
- [ ] The description is consistent with `lib/ticket-queue.js` (`slotOccupancyCount` /
  `SLOT_OCCUPYING_STATUSES`) and with the Part B intake note that `defining` counts
  against the slot.
- [ ] `assets/skills/orchestrate/SKILL.md` is byte-identical to the `.claude/` copy
  (drift guard `test/orchestrate-agents.test.js` stays green, including its dispatch-regex
  assertions).
- [ ] No model id (`claude-fable-5`/`claude-opus-4-8`) is introduced at/after the
  `## Phase 2 — Build` heading (TASK-051 invariant preserved).
- [ ] `node --test` green aside from the two known pre-existing unrelated failures
  (`test/task-030-plan-button.e2e.test.js`, `test/task-034-routing-drift-guard.test.js`).

## Cucumber Tests
```gherkin
Feature: The SKILL free-slot prose matches the slot-occupancy code

  Scenario: Free-slot math names defining
    Given both copies of the orchestrate SKILL
    Then the free-slot description includes defining in the occupancy count
    And it no longer says "limit − active count" in a way that excludes defining
    And the two copies are byte-identical

  Scenario: Phase-1-only model invariant preserved (edge)
    Given the orchestrate SKILL
    Then no model id appears at or after the "## Phase 2 — Build" heading
```

## Impact If Not Fixed
The orchestrator may reason about capacity using the stale "active count" formula (ignoring
`defining`), over-dispatching BA definitions/builds beyond the intended concurrency bound or
otherwise diverging from the helper functions; and the self-contradiction erodes trust in
the instruction contract for future edits.

## Edge Cases & Failure Paths
- Both copies must stay byte-identical or the drift guard fails.
- Do not alter the Phase-1 model directive or the `orchestrate-ba`/`general-purpose`
  dispatch phrasing when editing nearby prose.
- Keep the existing `activeCount`-based wording where it legitimately refers to
  "actively worked" (in-progress/testing) rather than slot occupancy.

## Relevant Files & Context
- `.claude/skills/orchestrate/SKILL.md` ~278, ~434, ~440 (the free-slot prose); Part B
  intake note (~214-215) that defining counts against the slot.
- `assets/skills/orchestrate/SKILL.md` — byte-identical mirror.
- `lib/ticket-queue.js` — `slotOccupancyCount`, `SLOT_OCCUPYING_STATUSES`,
  `selectNextBatch`, `canRunInParallel` (the authoritative behavior).
- `test/orchestrate-agents.test.js` — byte-identity + dispatch-regex drift guard; add a
  source-scan assertion for the corrected free-slot wording.
- Origin: tech-lead review of TASK-079, Finding 1 (Medium).

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
