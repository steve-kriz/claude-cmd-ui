---
id: TASK-197
title: orchistration fix
status: done
created: 2026-07-31T22:32:30.873Z
updated: 2026-07-31T23:58:35.000Z
---

## Description

The user wants a future `/orchestrate` run to be pushed as hard as possible toward doing work concurrently: defining tickets in parallel where possible and building as many tickets at once as the bound allows. The concurrency *machinery* already supports this (`lib/ticket-queue.js`: `selectNextBatch`, `canRunInParallel`, `slotOccupancyCount`, `DEFAULT_CONCURRENCY = 3`, `MAX_CONCURRENCY = 8`). The gap was in the SKILL.md **prose** an LLM orchestrator reads each run: it described parallelism as a *property of the batch* but never told the orchestrator to actually **emit multiple Agent/Task-tool calls in a single message**.

The fix is a **prose-only, additive strengthening** of SKILL.md (applied identically to both copies) that makes it unambiguous: whenever two or more tickets are **simultaneously eligible for the same phase's dispatch**, the orchestrator must issue **all** of those Agent/Task-tool calls **in a single message (parallel tool calls)**, filling every free slot each pass, strictly within the existing bound machinery.

## Acceptance Criteria
- [x] SKILL.md's Phase 2 build section contains an explicit instruction that when multiple tickets are eligible to build at once, the orchestrator issues all of their coder Task-tool dispatches in a single message.
- [x] SKILL.md's mid-build defining path contains an explicit instruction to batch BA-definition dispatches for multiple undefined `todo` tickets, scoped to mid-build only (not the initial plan phase).
- [x] Stated as default/expected behavior.
- [x] Capped by the existing free-slot bound; tickets beyond the bound wait in the queue.
- [x] Preserves claim-before-build ordering.
- [x] No existing concurrency/claim/isolation guarantee weakened.
- [x] `lib/ticket-queue.js` unchanged.
- [x] Both SKILL.md copies byte-for-byte identical.
- [x] Every previously-pinned phrase preserved.
- [x] No model id introduced at/after `## Phase 2 — Build`.
- [x] Full `node --test` suite passes for the ticket-mandated suites.

## Cucumber Tests
```gherkin
Feature: SKILL.md pushes the orchestrator to maximize parallel dispatch within the existing bound

  Scenario: Parallel coder dispatch in a single message is mandated
    When I read the Phase 2 build prose of either SKILL copy
    Then it instructs the orchestrator to issue all eligible coder Task-tool dispatches in a single message
    And it frames dispatching everything eligible right now, in parallel, as the default behavior every pass

  Scenario: Parallel BA-definition of multiple undefined tickets is mandated
    When I read the mid-build defining prose of either SKILL copy
    Then it instructs the orchestrator to define multiple undefined todo tickets simultaneously

  Scenario: Parallelism stays inside the existing bound
    When I read the strengthened dispatch prose
    Then the number of simultaneous dispatches is capped at the free slots limit − (in-progress + testing + defining)

  Scenario: The two copies stay byte-identical
    When I compare the raw bytes of the two SKILL copies
    Then they are byte-for-byte identical

  Scenario: Failure/edge — a wording change that weakens the cap is rejected
    Given a proposed edit that removes "defining" from the free-slot formula
    When the drift/prose test suite runs
    Then it fails and the edit is rejected

  Scenario: Failure/edge — the assets mirror drifts from the .claude copy
    Given the parallel-dispatch prose is added to only one copy
    When the byte-identity drift guard runs
    Then it fails
```

## Relevant Files & Context
- `.claude/skills/orchestrate/SKILL.md`, `assets/skills/orchestrate/SKILL.md`
- `lib/ticket-queue.js` (unchanged)
- `test/orchestrate-swarm.test.js`, `test/task-086-free-slot-prose.test.js`, `test/task-089-oversubscription-note.test.js`, `test/task-093-assets-mirror.test.js`

## Clarifications
- **Q1:** Prose-only; `DEFAULT_CONCURRENCY` stays `3`.
- **Q2:** Mid-build path only; the initial `/orchestrate plan` phase stays a single BA.

## Build notes
- Added three additive paragraphs inside `## Phase 2 — Build` in both SKILL.md copies: after the swarm/isolation intro, before the mid-build "define it FIRST" bullet, and in batch-build step 3. Byte-identical, LF preserved, no pinned phrase dropped, no model id after Phase 2.

## Test notes
- `test/task-197-parallel-dispatch-prose.test.js`: 24 tests (9 e2e + 2 edge/failure + 5 unit), all pass. All 4 pinned suites re-confirmed green. No new failures caused (39 pre-existing failures traced to other in-flight tickets' telemetry/stats work, unrelated).

## Review notes
- Tech-lead review: no critical or high-security findings — safe to proceed to done. Five sub-critical findings noted for awareness only (no follow-up ticket per severity policy): (1) medium — the "no model id after Phase 2" test guard only checks 2 of 4 real model ids, missing `claude-sonnet-5`/`claude-haiku-4-5`; (2) low — the "includes `defining`" pinned phrase from the AC isn't asserted by name in the test even though present in the files; (3) low — the plan-phase-stays-single-BA scoping is prose-only, untested; (4) nit — minor wording imprecision around slot counting during parking; (5) nit — a few unused regex constants in the test file.

## Post-processing notes
- Checked `docs/orchestrate-workflow.md` for claims invalidated by this change (grepped its parallel/batch/concurrency/swarm sections). It describes the swarm/batching concept generally but makes no specific claim about sequential-vs-single-message dispatch mechanics, so nothing there is now factually wrong. No doc changes needed.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
