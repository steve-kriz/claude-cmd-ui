---
id: TASK-079
title: Auto-define newly added tickets in parallel, then auto-build them
status: done
created: 2026-07-19T21:13:28.361Z
updated: 2026-07-20T00:10:14Z
activities: [{"activity":"ba","model":"claude-fable-5","startedAt":"2026-07-19T22:20:46Z","finishedAt":"2026-07-19T22:34:12Z"},{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-19T23:44:49Z","finishedAt":"2026-07-19T23:53:20Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-19T23:53:20Z","finishedAt":"2026-07-20T00:00:02Z"},{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-20T00:00:02Z","finishedAt":"2026-07-20T00:01:43Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-20T00:01:43Z","finishedAt":"2026-07-20T00:05:00Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-20T00:05:00Z","finishedAt":"2026-07-20T00:08:05Z"},{"activity":"post-processing","model":"claude-opus-4-8","startedAt":"2026-07-20T00:08:05Z","finishedAt":"2026-07-20T00:10:14Z"}]
---

## Description
Tickets added while the app is running (board New-ticket modal, Slack `create ticket`,
Phase-4 review follow-ups) are skeletons: a Description, the literal placeholder
criterion `- [ ] First testable criterion`, and no `## Cucumber Tests` section
(`renderer/renderer.js` ~7013-7058, ~8656-8703). Today only `/orchestrate plan` tickets
get real BA definition, and SKILL Phase 2 step 1 dispatches a mid-build ticket straight
to a coder with no defining step — so undefined work can get built.

Make newly-added tickets **auto-defined right away (in parallel), then auto-built in
parallel when a slot frees**, per the user's decisions below. There are THREE coordinated
changes:

**Part A — auto-start a run on ticket creation (renderer code change, per Q5).**
When a ticket is created from the app (New-ticket modal; and the Slack `create ticket`
path), the app auto-queues an `/orchestrate build` run **even if the auto-build toggle is
off**, so a newly-added ticket is defined/built "right away" without waiting for the user
to manually trigger a run. Reuse the existing run-trigger plumbing
(`maybeContinueBuild`/`queueBuild`/`buildCommandFor`, `renderer/renderer.js` ~6528-6556,
~6393) rather than inventing a new mechanism; guard against launching duplicate/overlapping
runs (if a build run is already active, do not start a second — the active run's mid-build
intake, Part B, will pick the ticket up).

**Part B — define-before-build intake (instruction change, SKILL.md, both copies
byte-identical).**
Extend Phase 2 step 1 ("mid-build ticket intake"): when a fresh scan or a mid-build
creation surfaces a `todo` ticket that is NOT defined (per `isTicketDefined` in the new
`lib/ticket-definition.js`, Part C):
- set `status: defining` (whole-file write, bump `updated`) — parks it for the BA;
- dispatch `orchestrate-ba` (fall back to `general-purpose` and report if missing) on
  `claude-fable-5` when available, else `claude-opus-4-8` (the existing Phase-1 model
  directive), with the full ticket text, to produce the standard defined-ticket body
  (Description, complete AC, Gherkin incl. ≥1 failure/edge scenario, edge cases, relevant
  files/context) — never touching `## Additional Context`;
- clarifying questions the BA raises go onto the ticket's `question` frontmatter (TASK-005
  mechanism, yellow dot); **that ticket alone** stays in `defining` until `answer` is
  non-empty — the rest of the swarm keeps building (per Q7). Such parked tickets are
  listed in the end-of-run report;
- when defined, whole-file write back to `status: todo`, then immediately evaluate
  `canRunInParallel(board, ticket, { limit, agentId })`; on `ok: true` claim
  (`claimTicket`) and **build it without pausing for review** (per Q6 — adding a ticket
  during a run is implicit consent, so the Phase-1 "stop for review" gate does not apply
  to mid-build tickets); on `ok: false` leave it queued for a normal `selectNextBatch`
  top-up;
- an already-defined new ticket (real AC + Gherkin) skips the BA and goes straight to the
  existing `canRunInParallel` dispatch;
- `kind: post-processing` tickets are never defined or dispatched (existing guards).

**Part C — `defining` counts against the concurrency bound (lib change, per Q8).**
Currently `ACTIVE_STATUSES = ['in-progress','testing']` and a `defining` ticket consumes
no slot. Per the user's decision, change `lib/ticket-queue.js` so a `defining` ticket
**does** count against the `--concurrency` bound: the number of slots occupied =
`in-progress` + `testing` + `defining`, so BA dispatches and builds together never exceed
`limit`. Introduce this as a dedicated slot-occupancy set/among the queue helpers (e.g. a
`SLOT_OCCUPYING_STATUSES = ['defining','in-progress','testing']` used by
`selectNextBatch`/`canRunInParallel`'s free-slot math) WITHOUT changing `isActive` /
`ACTIVE_STATUSES` semantics that other code relies on (the board's "being worked on" dot
must not start lighting up for `defining`). A `defining` ticket remains **not claimable**
(`CLAIMABLE_STATUSES` unchanged) so the BA gate still holds. Update the queue unit tests
accordingly.

No new statuses; the only new frontmatter usage is the existing `question`/`answer` gate.

## Acceptance Criteria
- [ ] `lib/ticket-definition.js` exists, is Electron-free, and exports
  `isTicketDefined(body)` plus a `PLACEHOLDER_CRITERION` constant.
- [ ] `isTicketDefined` returns false for: null/undefined/non-string; a body with no
  `## Acceptance Criteria`; an AC section whose only checkbox is the exact placeholder
  `- [ ] First testable criterion`; a body with no `## Cucumber Tests`; a Cucumber
  section with no non-empty ```gherkin fence.
- [ ] `isTicketDefined` returns true for a body with ≥1 real AC checkbox AND a non-empty
  ```gherkin block (including the New-ticket template once properly filled in).
- [ ] **Part A:** creating a ticket from the New-ticket modal (and the Slack `create
  ticket` path) auto-queues an `/orchestrate build` run even when the auto-build toggle
  is off, reusing the existing run-trigger plumbing; if a run is already active, no second
  overlapping run is launched.
- [ ] **Part B:** `.claude/skills/orchestrate/SKILL.md` Phase 2 step 1 instructs that an
  undefined newly-seen `todo` ticket goes to `status: defining` and an `orchestrate-ba`
  dispatch (with the general-purpose fallback wording and the fable-5/opus-4-8 model
  directive) BEFORE any claim/build of it; that the defined ticket returns to `todo` and
  is then evaluated with `canRunInParallel` and built (without a review pause) on
  `ok: true`, queued otherwise; that a `defining` ticket with a BA question blocks only
  itself (question/answer gate) while the swarm continues; that already-defined new
  tickets skip the BA; and that `kind: post-processing` tickets are excluded.
- [ ] **Part C:** `lib/ticket-queue.js` counts `defining` tickets against the concurrency
  bound (free slots = `limit − (in-progress + testing + defining)`), via a dedicated
  slot-occupancy set, WITHOUT changing `isActive`/`ACTIVE_STATUSES` (the board's
  worked-on dot must not light for `defining`), and `defining` stays not claimable.
- [ ] `assets/skills/orchestrate/SKILL.md` is byte-identical to the `.claude/` copy
  (drift guard `test/orchestrate-agents.test.js` stays green, including its dispatch-regex
  assertions). `.claude/agents/*` and `assets/agents/*` remain byte-identical pairs (or
  untouched).
- [ ] All existing `node --test` suites still pass (modulo the two known pre-existing
  failures `test/task-030-plan-button.e2e.test.js`, `test/task-034-routing-drift-guard.test.js`).

## Cucumber Tests
```gherkin
Feature: Newly added tickets are defined in parallel, then built when a slot frees

  Scenario: A skeleton board-created ticket is not "defined"
    Given a ticket body exactly matching the New-ticket modal template
    When isTicketDefined evaluates it
    Then the verdict is false

  Scenario: A BA-completed ticket is "defined"
    Given a ticket body with two real acceptance-criteria checkboxes
    And a "## Cucumber Tests" section containing a non-empty gherkin fence
    When isTicketDefined evaluates it
    Then the verdict is true

  Scenario: Creating a ticket auto-queues a build run (Part A)
    Given the auto-build toggle is off and no build run is active
    When the user creates a ticket from the New-ticket modal
    Then an "/orchestrate build" run is queued/triggered
    And creating a second ticket while that run is active does not launch a second run

  Scenario: Defining counts against the concurrency bound (Part C)
    Given a limit of 3 with 1 ticket in-progress and 1 ticket in "defining"
    When selectNextBatch computes free slots
    Then free slots = 1 (3 minus in-progress minus defining)
    And a defining ticket is never returned as claimable

  Scenario: A defined ticket dispatches into a free slot
    Given a board with 2 slot-occupying tickets under a limit of 3
    And a ticket that just returned from defining to "todo"
    When canRunInParallel is evaluated for it
    Then the verdict is ok with 1 free slot
    And claimTicket grants the claim setting status in-progress

  Scenario: A defined ticket waits when the bound is full
    Given a board whose slot-occupying count equals the limit
    And a ticket that just returned from defining to "todo"
    When canRunInParallel is evaluated for it
    Then the verdict is not ok with reason "no-slots"
    And the ticket remains in "todo" unclaimed

  Scenario: The SKILL routes undefined new tickets through the BA first
    Given both copies of the orchestrate SKILL
    Then Phase 2's intake instructs setting status defining and dispatching
         orchestrate-ba for a ticket that is not defined
    And it references isTicketDefined in lib/ticket-definition.js
    And the two copies are byte-identical

  Scenario: Edge - a BA question parks only that ticket
    Given a mid-build ticket in "defining" whose BA raised a question
    When the question has no answer yet
    Then that ticket stays in "defining"
    And other todo tickets are still selected and built

  Scenario: Edge - post-processing ticket is never defined or dispatched
    Given a newly created ticket with kind post-processing
    When the intake rules are applied
    Then no BA dispatch occurs and canRunInParallel reports post-processing

  Scenario: Edge - junk input never throws
    Given isTicketDefined receives null, 42, "" and an object
    Then each call returns false and nothing throws
```

## Edge Cases & Failure Paths
- Unanswered BA question: ticket stays in `defining` (yellow dot) indefinitely, blocking
  ONLY itself; the swarm keeps topping up other tickets; the final build report lists
  tickets still parked in `defining`.
- Build run ends while a ticket is still `defining`: it is left in `defining` on disk; the
  next `/orchestrate build` run must treat a `defining` ticket with no live BA as stale
  intake and resume/finish its definition (re-dispatch the BA) rather than skipping it.
- Part A duplicate-run guard: creating several tickets in quick succession, or creating one
  while a run is active, must NOT spawn overlapping `/orchestrate build` runs — reuse the
  existing single-run guard (`maybeContinueBuild` semantics).
- Ticket created already fully defined: BA step skipped (no wasted dispatch, no double
  `defining` transition).
- `kind: post-processing`: excluded at every step (existing guards in
  claimTicket/canRunInParallel, `lib/ticket-queue.js` ~180-182, ~293-295).
- Bug tickets (`bug-of`) and review follow-ups (`review-of`): plain `todo` tickets — they
  DO go through defining like any other skeleton.
- Part C must not regress the board: `isActive`/`ACTIVE_STATUSES` stay `['in-progress',
  'testing']` so the "being worked on" dot does not light for `defining`; only the
  free-slot math gains `defining`. Existing queue tests that assert `activeCount` must
  stay green; new tests cover the slot-occupancy count.
- Placeholder-only AC plus a real gherkin block (or vice versa): still undefined — both
  halves required.
- Unparseable ticket file: skip and report (existing SKILL rule).
- Drift guard: any SKILL edit must land in BOTH copies byte-for-byte or
  `test/orchestrate-agents.test.js` fails; the edit must not break its dispatch-regex
  assertions (keep the exact "Task tool, `orchestrate-ba`; fall back to …
  `general-purpose`" phrasing).
- `## Additional Context` is user-owned — never written into during the mid-build define.

## Relevant Files & Context
- `.claude/skills/orchestrate/SKILL.md` — Phase 2 step 1 (mid-build intake, the section
  to extend); Phase 1 BA contract (defining rules, question gate, model directive);
  concurrency section.
- `assets/skills/orchestrate/SKILL.md` — byte-identical mirror (MUST be synced; see memory
  "Assets drift guard").
- `test/orchestrate-agents.test.js` — the byte-identical drift guard + dispatch-regex
  assertions; the Gherkin/e2e style to follow for new tests.
- `lib/ticket-queue.js` — `canRunInParallel` ~278-319, `selectNextBatch` ~227-253,
  `claimTicket` ~169-203, `activeCount` ~147-155, `ACTIVE_STATUSES` ~41 (do NOT change
  its members — add a separate slot-occupancy set), `CLAIMABLE_STATUSES` ~45.
- `lib/ticket-lanes.js` — status enum and `defining` lane semantics.
- `lib/ticket-questions.js` — the question/answer waiting mechanism the define gate reuses.
- `lib/ticket-definition.js` — NEW pure module (`isTicketDefined`, `PLACEHOLDER_CRITERION`).
- `renderer/renderer.js` — New-ticket template body ~7013-7058 (the exact placeholder
  string `- [ ] First testable criterion`); Slack create-ticket path ~8656-8703;
  `maybeContinueBuild` ~6528-6552, `queueBuild`/`buildCommandFor` ~6556/~6393 (Part A
  reuses these to auto-queue a run on creation; add the create→auto-run wiring + the
  duplicate-run guard here).
- Test patterns: `test/ticket-queue.test.js` (queue helpers), `test/orchestrate-agents.test.js`
  (SKILL/drift), plus a new `test/ticket-definition.test.js` unit + an e2e Given/When/Then
  file; mock everything, no DB.

## Clarifications
- Q (079 scope): what triggers auto-define/auto-build of a newly added ticket?
  A: Auto-start a run on creation — the app auto-queues `/orchestrate build` the moment a
  ticket is created, even when auto-build is off (Part A, a renderer code change), in
  addition to the active-run mid-build intake (Part B).
- Q (079 review gate): is skipping the Phase-1 "stop for review" gate acceptable for
  mid-build tickets?
  A: Yes — auto-build mid-build without a review pause; adding a ticket during a run is
  implicit consent.
- Q (079 BA questions): what happens when the BA raises a question on a mid-build ticket?
  A: Park only that ticket in `defining` (yellow dot) while the swarm continues; report it
  at end of run. Do not pause the whole run.
- Q (079 slots): should `defining` consume a concurrency slot?
  A: Yes — cap by concurrency: free slots = `limit − (in-progress + testing + defining)`
  (Part C, a `lib/ticket-queue.js` change), without altering `isActive`/`ACTIVE_STATUSES`.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
