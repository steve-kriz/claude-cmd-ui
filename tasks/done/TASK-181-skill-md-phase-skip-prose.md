---
id: TASK-181
title: SKILL.md — orchestrator consults phase-enabled state and skips disabled phases
status: done
created: 2026-07-27T12:00:00Z
updated: 2026-07-27T15:15:00Z
agent: orchestrator-main
activities: [{"activity":"code","model":"claude-sonnet-5","startedAt":"2026-07-27T14:20:00Z","finishedAt":"2026-07-27T14:35:00Z"},{"activity":"test","model":"claude-haiku-4-5","startedAt":"2026-07-27T14:35:00Z","finishedAt":"2026-07-27T14:50:00Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-27T14:50:00Z","finishedAt":"2026-07-27T15:05:00Z"},{"activity":"post-processing","model":"claude-opus-4-8","startedAt":"2026-07-27T15:05:00Z","finishedAt":"2026-07-27T15:12:00Z"},{"activity":"post-processing","model":"claude-sonnet-5","startedAt":"2026-07-27T15:05:00Z","finishedAt":"2026-07-27T15:12:00Z"}]
---

## Build notes
- Coder: added a "Phase-enabled config and dispatch order" subsection, a Phase 4 skip paragraph, and a State-consistency bullet to both SKILL.md copies (byte-identical, verified via diff).
- Tester: added `test/task-181-phase-enabled.test.js` + `.e2e.test.js` (31 tests). Full suite: 3521 pass, 3 pre-existing baseline failures, 0 regressions.
- Reviewer: PASS with 2 follow-ups filed — **TASK-188** (Phase 3's hand-off prose still unconditionally required review, contradicting the new default-disabled behavior) and **TASK-189** (two test assertions covering "does not refuse out-of-order configs" were vacuous/mislocated).
- Post-processing: security review found no new issues (confirmed post-processing/security-review still runs even when the tech-lead review is skipped); documentation pass added a factual note to `docs/orchestrate-workflow.md`.

## Description
Change the orchestrate skill prose so a live `/orchestrate build` run actually consults the
new `skill.phases.<phase>.{enabled,order}` config (from TASK-180) and (a) skips a disabled
phase and (b) dispatches phases in the configured `order`, not a hardcoded sequence. Two
concrete, resolved behaviors this prose must encode:

1. **Phase 4 tech-lead review defaults OFF.** Per the resolved clarification, `review`
   defaults `enabled: false` (TASK-180) — with no `## Additional Context`/board setup, a
   ticket goes `testing → post-processing → done`, skipping the tech-lead dispatch, unless
   the user has explicitly enabled review (via the Workflow panel toggle, TASK-182) or linked
   a board column to it (TASK-183). **This is an intentional, accepted default-behavior
   change** for every project adopting this schema — SKILL.md's prose must say so plainly so
   the user isn't surprised that review silently stopped running after upgrading.
2. **`order` drives execution sequence.** The orchestrator dispatches the four phases in the
   order given by `skill.phases.<phase>.order` (ascending), not a fixed plan→build→test→review
   sequence. Because phase order is user-configurable and some orderings violate a phase's
   natural data dependency (test needs build's output; review needs test's output; plan must
   precede everything for a given ticket), the prose must say the orchestrator follows the
   configured order literally but should note in its end-of-run report if a ticket's phases
   ran out of their natural dependency order in case the output looks wrong. This is a
   user-accepted risk (see Clarifications) — do not silently refuse or "fix" a nonsensical
   order in SKILL.md itself; that safety net belongs in the Workflow panel UI (TASK-182), not
   the orchestrator prose.

The orchestrator is a prompt-driven flow, not code, so the enforcement is "the orchestrator
reads `tasks/team-config.json` and follows it" — there is no runtime guard. This ticket is a
**documentation/instruction change** to `.claude/skills/orchestrate/SKILL.md` **and its
byte-identical mirror `assets/skills/orchestrate/SKILL.md`** (drift-guarded; see
`docs/assets-mirror.md`). **Depends on TASK-180** — it references the schema shape TASK-180
introduces.

Hard invariants from SKILL.md's own "State-consistency rules": the phase-skip logic MUST NOT
invent a new status outside the valid enum (`todo`, `defining`, `in-progress`, `testing`,
`post-processing`, `done`, `failed-testing`) and MUST keep whole-file atomic ticket writes
intact. Skipping review simply omits the tech-lead dispatch step; the ticket's status
transitions are unchanged apart from not entering the review sub-step.

Scope note / dependency for the coder: the two files must end byte-identical. Because this is
prose (not the drift-guarded agent-frontmatter round-trip), the coder edits **both** files by
hand and the tester/reviewer must confirm equality (the `test/orchestrate-*` drift tests
compare them).

## Acceptance Criteria
- [ ] SKILL.md's Phase 4 section states that the tech-lead review is skipped when `tasks/team-config.json`'s `skill.phases.review.enabled` is `false` (its TASK-180 default), and that in that case the flow is `testing → post-processing → done` (post-processing still runs; the ticket still reaches `done`).
- [ ] SKILL.md documents the **general** rule once (near the Build/Phase-2 loop or a dedicated note): before running a phase's dispatch the orchestrator reads `skill.phases.<phase>.enabled` from `tasks/team-config.json` and skips the dispatch when it is `false`; for `plan`/`build`/`test` this defaults to enabled (backward compatible with existing projects), but for `review` the documented default is **disabled** — call this asymmetry out explicitly so it isn't mistaken for a bug.
- [ ] SKILL.md documents that the orchestrator dispatches phases in ascending `skill.phases.<phase>.order`, and that it follows a configured order literally even when it deviates from the natural plan→build→test→review dependency chain, noting any such deviation in its end-of-run report rather than refusing to proceed.
- [ ] The prose explicitly reaffirms that skipping a phase introduces **no new status** and does not change the valid enum, and that all ticket writes remain whole-file atomic.
- [ ] The prose states which phases are meaningfully skippable in this feature (review), and that disabling `build`/`test` is out of scope for behaviour here (a disabled build/test still runs) so the coder does not silently invent test-skipping.
- [ ] `.claude/skills/orchestrate/SKILL.md` and `assets/skills/orchestrate/SKILL.md` are byte-identical after the edit (drift-guard tests pass).
- [ ] No other phase's prose semantics are changed beyond the additive skip/order rules; the model-routing, concurrency, and claim/isolation sections are untouched.

## Cucumber Tests
```gherkin
Feature: phase-skipping instruction in SKILL.md
  Scenario: review disabled skips the tech-lead dispatch
    Given team-config skill.phases.review.enabled is false
    When SKILL.md's Phase 4 prose is read
    Then it instructs the flow testing -> post-processing -> done with no tech-lead dispatch

  Scenario: default is enabled when config absent
    Given a project with no skill.phases in team-config
    When SKILL.md's build-loop prose is read
    Then it instructs every phase to run as today (backward compatible)

  Scenario: enum is preserved
    When the phase-skip prose is read
    Then it states no new status is introduced and writes stay whole-file atomic

  Scenario: assets mirror stays byte-identical (edge)
    When SKILL.md is edited
    Then assets/skills/orchestrate/SKILL.md is byte-identical to .claude/skills/orchestrate/SKILL.md

  Scenario: post-processing still runs when review skipped (failure/edge)
    Given review is disabled
    When the prose describes the skip
    Then post-processing is still applied before done (skipping review must not skip post-processing)
```

## Edge & Failure Cases
- Config missing / unparseable / `skill.phases` absent → `plan`/`build`/`test` default enabled (no behaviour change vs today); `review` defaults disabled — this is the one intentional, documented behavior change.
- A configured `order` that puts `test` or `review` before their dependency (`build`/`test` respectively) is followed literally, not rejected; the orchestrator notes the deviation in its end-of-run report.
- `skill.phases.review.enabled` present but non-boolean → treat via TASK-180's normalisation (coerced true); prose should say "disabled only when explicitly false".
- Disabling review must NOT skip post-processing, and must NOT leave the ticket short of `done`.
- Must not introduce a `skipped`/`reviewed` or any status outside the enum.
- Drift between the two SKILL.md copies is a build failure — both must be edited identically.

## Relevant Files & Context
- `.claude/skills/orchestrate/SKILL.md` — Phase 4 section (`## Phase 4 — Tech-lead review …`, lines ~455-511), Phase 2 build loop (~270-386), State-consistency rules (~560-586).
- `assets/skills/orchestrate/SKILL.md` — the byte-identical mirror.
- `docs/assets-mirror.md` — mirror invariant; `test/orchestrate-agents.test.js` / `test/orchestrate-swarm.test.js` are the drift guards.
- `tasks/team-config.json` schema — `skill.phases.<phase>.enabled` from TASK-180.
- `lib/skill-workflow.js` `PHASE_SPECS` — the phase keys the prose must reference.
- Depends on: TASK-180 (schema).

## Clarifications
- Q: Should Review's "no column linked" state affect its default? A: **Review is off by default until a column is linked** — an accepted default-behavior change for existing projects; SKILL.md must state this plainly.
- Q: Should `order` be display-only or drive execution? A: **Order actually drives execution sequence.** The prose must instruct the orchestrator to follow configured order literally, flagging (not blocking on) natural-dependency violations in its report.
- Q: Is per-phase agent reassignment in scope? A: **Out of scope** — no prose change needed for dispatch-agent selection.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
