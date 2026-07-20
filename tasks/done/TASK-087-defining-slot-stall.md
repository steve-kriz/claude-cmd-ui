---
id: TASK-087
title: Prevent question-parked defining tickets from stalling the whole swarm
status: done
created: 2026-07-20T00:08:05Z
updated: 2026-07-20T00:48:50Z
review-of: TASK-079
activities: [{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-20T00:35:15Z","finishedAt":"2026-07-20T00:39:52Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-20T00:39:52Z","finishedAt":"2026-07-20T00:44:00Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-20T00:44:00Z","finishedAt":"2026-07-20T00:47:12Z"},{"activity":"post-processing","model":"claude-opus-4-8","startedAt":"2026-07-20T00:47:12Z","finishedAt":"2026-07-20T00:48:50Z"}]
---

## Description
Follow-up from the tech-lead review of TASK-079 (Finding 2, Low). TASK-079 combined two
decisions: (Q7) a `defining` ticket parked on an unanswered BA `question` blocks only
itself while the swarm continues; (Q8) a `defining` ticket counts against the concurrency
bound. Together these can contradict the "blocks only itself" guarantee: if the number of
simultaneously question-parked `defining` tickets reaches `limit`, then
`slotOccupancyCount == limit`, so `selectNextBatch` returns `[]` and `canRunInParallel`
reports `no-slots` for every other ready ticket — the entire swarm halts pending human
answers, even when defined `todo` work is ready.

Fix so that question-parked `defining` tickets cannot starve ready build work. Options for
the coder to choose (BA/tech-lead can refine): (a) do not count a **question-parked**
`defining` ticket (one with a `question` and no `answer`) toward the slot-occupancy bound —
only count "actively-being-defined" tickets; or (b) reserve at least one build slot for
`todo`/`failed-testing` tickets so parked defining work can never consume the last slot; or
(c) cap concurrent BA definitions below `limit`. Whichever is chosen, preserve TASK-079's
intent that in-progress defining work counts against the bound during normal operation.

## Acceptance Criteria
- [ ] When enough `defining` tickets are parked on unanswered BA questions to reach the
  concurrency limit, `selectNextBatch`/`canRunInParallel` still allow ready
  `todo`/`failed-testing` tickets to be dispatched (the swarm does not fully stall on
  human-gated definitions).
- [ ] Normal (non-parked) `defining` work still counts against the bound per TASK-079
  Part C during active definition.
- [ ] The chosen approach is implemented in `lib/ticket-queue.js` (pure helpers) with a
  clear predicate distinguishing question-parked defining tickets (via
  `lib/ticket-questions.js` `isTicketWaitingForAnswer`) from actively-defining ones, if
  option (a) is chosen; or the reserved-slot / BA-cap logic if (b)/(c).
- [ ] If the SKILL contract needs updating to describe the new rule, both
  `.claude/skills/orchestrate/SKILL.md` and `assets/skills/orchestrate/SKILL.md` are
  updated byte-identically (drift guard stays green; no model id in Phase 2/3/4).
- [ ] Tests: unit + e2e (`node --test`) cover the stall scenario (parked-defining at the
  limit still lets ready work dispatch) and the normal case (active defining still counts).
  Green aside from the two known pre-existing unrelated failures.

## Cucumber Tests
```gherkin
Feature: Question-parked defining tickets do not stall the swarm

  Scenario: Parked defining at the limit still lets ready work run
    Given a limit of 2 and two defining tickets both parked on unanswered questions
    And one ready todo ticket that is defined
    When selectNextBatch/canRunInParallel are evaluated
    Then the ready todo ticket can still be dispatched

  Scenario: Active defining still counts against the bound (edge)
    Given a defining ticket that is being actively defined (no unanswered question)
    Then it counts toward slot occupancy per TASK-079 Part C
```

## Impact If Not Fixed
A user who adds several under-specified tickets in one run can have all of them parked on BA
questions, silently stalling the whole build (an unbounded, human-gated wait) with no
progress on other ready tickets until they notice and answer. It self-heals once any
question is answered, so blast radius is limited, but the stall is surprising and
time-unbounded.

## Edge Cases & Failure Paths
- Distinguish "parked on a question" (`question` set, `answer` empty) from
  "actively defining" precisely, reusing `isTicketWaitingForAnswer`.
- Do not reintroduce the TASK-079 regression where defining is entirely free (that was the
  point of Part C) — only parked-defining should be exempt (if option a), or a single slot
  reserved (option b).
- Avoid a new deadlock: ensure at least one path always makes progress when any ready
  `todo`/`failed-testing` ticket exists.

## Relevant Files & Context
- `lib/ticket-queue.js` — `slotOccupancyCount`, `SLOT_OCCUPYING_STATUSES`,
  `selectNextBatch`, `canRunInParallel` (~227-319).
- `lib/ticket-questions.js` — `isTicketWaitingForAnswer` (parked-question predicate).
- `.claude/skills/orchestrate/SKILL.md` + `assets/` mirror — the intake/concurrency prose
  (only if the contract needs updating).
- Test patterns: `test/ticket-queue-slots.test.js`, `test/ticket-queue.test.js`.
- Origin: tech-lead review of TASK-079, Finding 2 (Low).

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
