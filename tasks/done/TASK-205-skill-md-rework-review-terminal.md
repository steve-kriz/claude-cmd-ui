---
id: TASK-205
title: SKILL.md — rework/fix-loop, review reject-and-rework, follow-ups, and done under the column model
status: done
created: 2026-08-03T09:30:00.000Z
updated: 2026-08-03T18:00:00.000Z
---

## Description
Complete the SKILL.md rewrite started in TASK-204 by re-homing the
**rework/fix-loop**, the **review-type column's two verdicts** (reject-and-rework
vs. follow-up), and the **terminal transition to `done`** under the column-driven
model. None of these are hardcoded to "the tester phase" or "the tech-lead phase"
anymore — they are described in terms of the column a ticket sits in and that
column's `agent`/`instructions`.

**No post-processing step.** TASK-206 removes the `post-processing` system
column and the whole `kind: post-processing` "final events" concept from the app
entirely (lib, renderer, and the on-disk config/tickets) — it is not being
redesigned under the column model, it is gone. This ticket's terminal path is
therefore simply: last agent-bearing column clears with no pending rejection →
`done`. There is nothing run "against every ticket" before `done`.

**Where the 3-attempt fix cap now lives.** When the agent on a **testing-type
column** (the `testing` system column, or any user column whose instructions
declare it a testing step) reports failure, the orchestrator:
1. Sets the ticket to `failed-testing` (whole-file write) — still a claimable
   status that folds into the Testing lane and owns `tasks/failed-testing/`.
2. Dispatches the agent of the **nearest preceding build column** (the coder /
   `in-progress` column's agent) with the ticket **plus the failure output** to
   fix the code, then returns it to `testing`.
3. Caps this fix loop at **3 attempts** per ticket; after the third red result it
   leaves the ticket in `failed-testing`, summarises what is failing, and asks the
   user how to proceed.

The cap is a property of the testing column's rework rule, and the testing
column's default `instructions` (TASK-201) name the "capped at 3 attempts"
behaviour so it is visible in config.

**Review-type user columns — TWO possible verdicts (decided by the user: review
columns get real reject-and-rework power, not just follow-up tickets).** A user
column with an agent positioned after `testing` (e.g. `pr-review` →
`orchestrate-tech-lead`) is a review step. Its agent reports findings with
severity, and its report resolves to exactly one of:

1. **Reject-and-rework (blocking).** When the reviewer's findings mean the ticket
   is not actually acceptable yet (e.g. it judges the issue must be fixed before
   this ticket can proceed — typically a `critical` finding, but the reviewer's
   explicit reject verdict is what triggers this, not severity alone), the
   orchestrator sends the ticket **backward**: whole-file write its `status` to
   the **nearest preceding build column** (`in-progress`, or a review-configured
   target column if the review column's `instructions` name one), dispatches that
   column's agent with the ticket **plus the reviewer's findings as failure-style
   context**, and on success the ticket re-enters the forward flow from that
   column (back through `testing`, then the review column again). This
   reject-and-rework cycle is **capped at 3 attempts per ticket**, mirroring the
   testing fix-loop cap exactly — after the third rejection the ticket parks in
   `failed-testing`, the orchestrator summarises the unresolved review findings,
   and asks the user how to proceed. This cap exists specifically to prevent an
   infinite review ⇄ rework cycle.
2. **Follow-up only (non-blocking).** When a finding is `critical`/`high-security`
   but the reviewer does not reject the ticket outright (or for any lower-severity
   finding), the orchestrator creates a follow-up `todo` ticket (carrying
   `review-of:` and a `## Impact If Not Fixed` section, id continuing from the
   true max) exactly as today, and the reviewed ticket's status is **not**
   changed by this path. Non-qualifying (medium/low/nit) findings are noted in the
   summary only — no ticket.

A review column's `instructions` are where the user configures which verdict mode
it uses and, optionally, which column a rejection sends the ticket back to; the
default (no override) is "reject sends it to the nearest preceding build column".

**Reaching done.** After the ticket passes its last agent-bearing column with no
pending rejection, the orchestrator sets the ticket `done` directly — there is no
intervening post-processing step (TASK-206 removed that column and concept).
`done` is terminal regardless of any follow-up tickets a review raised. Every
transition is a whole-file atomic write; `created` is preserved, `updated`
bumped, and the per-activity cost log (`activities`) is appended per dispatch,
unchanged.

The `assets/skills/orchestrate/SKILL.md` mirror stays **byte-identical**.

## Acceptance Criteria
- [ ] SKILL.md describes the fix loop generically: a testing-type column's failure → `failed-testing` → dispatch the nearest preceding build column's agent (coder) with the failure output → back to `testing`, capped at **3 attempts**, then park in `failed-testing` and ask the user.
- [ ] The 3-attempt cap is described as a property of the testing column's rework rule (not "Phase 3"), and matches the testing column's default `instructions`.
- [ ] `failed-testing` semantics are preserved: claimable, folds into the Testing lane with a red marker, owns `tasks/failed-testing/`, and re-picked by `selectNextBatch` while attempts remain.
- [ ] SKILL.md describes review-type user columns with **two distinct verdicts**: (a) reject-and-rework — a blocking rejection sends the ticket backward (whole-file status write) to the nearest preceding build column (or an instructions-configured target), dispatches that column's agent with the reviewer's findings as failure-style context, and re-enters the forward flow; capped at **3 rejection cycles per ticket**, then parks in `failed-testing` and asks the user; and (b) follow-up-only — a non-blocking `critical`/`high-security` finding spawns a separate `todo` ticket (`review-of:` + `## Impact If Not Fixed`, id continuing from the true max) without changing the reviewed ticket's status; lower findings are summary-only.
- [ ] SKILL.md states the reject-and-rework cap (3) is tracked and enforced the same way as the testing fix-loop cap (a per-ticket attempt count carried across the backward/forward cycle), and that exceeding it never silently drops the ticket — it always parks in `failed-testing` with a user-facing summary.
- [ ] SKILL.md documents that a review column's `instructions` may name a specific rework target column; absent that, the default target is the nearest preceding build column.
- [ ] SKILL.md describes the terminal path: once the ticket clears its last agent-bearing column with no pending rejection, set `done` directly (no intervening post-processing step — TASK-206 removes that column/concept entirely); `done` is terminal regardless of follow-up tickets raised (but NOT reachable while a reject-and-rework rejection is still pending — that must resolve, forward or via the cap, first).
- [ ] All transitions are whole-file atomic writes; `created` preserved, `updated` bumped; the `activities` cost-log append per dispatch is retained.
- [ ] No status outside the enum is introduced. The reject-and-rework backward move reuses existing statuses (`in-progress`/`failed-testing`/etc.) — it does not invent a new one. SKILL.md contains no reference to a `post-processing` column/status/kind (TASK-206 removed the concept).
- [ ] `.claude/skills/orchestrate/SKILL.md` and `assets/skills/orchestrate/SKILL.md` are byte-identical after the change.

## Cucumber Tests
```gherkin
Feature: rework, review reject-and-rework, follow-ups, and terminal transitions under the column model

  Scenario: a failing testing column sends the ticket back to the build column's agent
    Given a ticket in "testing" whose tests fail
    And the "in-progress" column names agent "orchestrate-coder"
    When the testing agent reports failure
    Then the ticket becomes "failed-testing"
    And orchestrate-coder is dispatched with the failure output
    And the ticket returns to "testing" for another run

  Scenario: the testing fix loop is capped at three attempts
    Given a ticket that fails testing three times
    When the third attempt is still red
    Then the ticket stays in "failed-testing"
    And the orchestrator asks the user how to proceed

  Scenario: a review column rejects a ticket and sends it back for rework
    Given a user column "pr-review" with agent "orchestrate-tech-lead" after testing
    And the reviewer issues a reject verdict with a critical finding
    When the orchestrator processes the review
    Then the ticket's status is written backward to "in-progress"
    And orchestrate-coder is dispatched with the reviewer's findings as context
    And the ticket re-enters testing then pr-review again on success

  Scenario: reject-and-rework is capped at three cycles
    Given a ticket rejected by pr-review three times in a row
    When the third rejection is issued
    Then the ticket parks in "failed-testing"
    And the orchestrator summarises the unresolved review findings and asks the user
    And no fourth rework cycle is attempted

  Scenario: a non-blocking critical finding creates a follow-up ticket instead of rejecting
    Given the reviewer reports a critical finding but does not issue a reject verdict
    When the orchestrator processes the review
    Then a new todo ticket is created with review-of set to the reviewed id
    And that ticket has an "## Impact If Not Fixed" section
    And the reviewed ticket's status is unchanged

  Scenario: a low-severity finding creates no ticket (edge)
    Given the reviewer reports only a nit
    Then no follow-up ticket is created
    And the nit is noted in the run summary

  Scenario: the ticket reaches done directly once its last column clears
    Given a ticket has passed all agent columns with no pending rejection
    When the orchestrator finishes the ticket
    Then it sets the ticket to done
    And no post-processing step runs (the column/concept does not exist)

  Scenario: a testing column with no preceding build column cannot fix (failure path)
    Given a testing-type column with no build column before it
    When its tests fail
    Then the orchestrator leaves the ticket in "failed-testing" and reports it cannot auto-fix

  Scenario: the assets mirror stays byte-identical (drift guard)
    When SKILL.md is edited for the rework/terminal sections
    Then assets/skills/orchestrate/SKILL.md is written with identical bytes
```

## Edge & failure cases the coder must handle
- Testing fix loop exceeds 3 attempts → parked in `failed-testing`, user asked (never silently dropped, never marked done).
- Reject-and-rework exceeds 3 cycles → parked in `failed-testing`, user asked, exactly like the testing cap (never an unbounded ping-pong between the review column and the build column).
- A testing-type column with no preceding build column → cannot auto-fix; report and leave in `failed-testing`.
- A review column that rejects but names a rework target column that does not exist in the current board config → fall back to the nearest preceding build column and report the misconfiguration.
- Follow-up ticket id must continue from the **true max** across all status subfolders (`tasks/*/TASK-*.md`), never reuse/skip.
- Creating review follow-ups (the non-blocking path) must not change the reviewed ticket's status/frontmatter.
- A reject-and-rework backward move (the blocking path) DOES change the reviewed ticket's status — by design — but must never invent a status outside the existing enum.
- `done` is terminal once reached, but is never reached while a rejection is still pending resolution.
- SKILL.md must not describe or reference a post-processing step, column, or `kind: post-processing` ticket anywhere (TASK-206 removed the concept from the app; leaving stale prose here would contradict the actual system).
- Assets mirror must be written byte-identical.

## Relevant files & context
- `C:\projects\claude-cmd-ui2\.claude\skills\orchestrate\SKILL.md` — sections to re-home: current "Phase 3 — Test and the fix loop" (546–591), "Phase 4 — Tech-lead review … done" (592–671), and the `activities` cost-log bullet in "State-consistency rules" (740–748). Depends on TASK-204 having already reframed the earlier sections and the generic loop.
- `C:\projects\claude-cmd-ui2\assets\skills\orchestrate\SKILL.md` — byte-identical mirror target.
- `C:\projects\claude-cmd-ui2\lib\ticket-lanes.js` — `FAILED_STATUS`, `laneForStatus` folding failed-testing into testing. Post-TASK-206 this module has FIVE lanes and no `isPostProcessingTicket` — do not write SKILL.md prose that assumes that helper or the post-processing lane still exist.
- `C:\projects\claude-cmd-ui2\lib\ticket-queue.js` — `CLAIMABLE_STATUSES` includes `failed-testing`; post-TASK-206 `claimTicket`/`canRunInParallel` no longer have a post-processing guard/reason.
- `C:\projects\claude-cmd-ui2\lib\team-config.js` (post-TASK-201 + post-TASK-206) — the testing column's default `instructions` naming the 3-attempt cap; `SYSTEM_COLUMN_DEFAULT_AGENTS` for the coder fallback (five system columns, no post-processing entry); a review column's `instructions` is where a rework-target override would be documented (free text, parsed by the orchestrator/agent, not a new schema field — do not add a new team-config field for this without confirming with the user first).
- Follow-up-ticket precedent: today's Phase-4 rules for `review-of:` + `## Impact If Not Fixed` (current SKILL.md 634–657) — carry the wording, generalised to "review-type column", and add the sibling reject-and-rework path alongside it.
- Drift-guard + swarm tests: `C:\projects\claude-cmd-ui2\test\orchestrate-swarm.test.js`.
- Depends on TASK-204 (same file, builds on the reframed loop and column-lookup mechanics) AND TASK-206 (removes the post-processing column/concept this ticket must not reference). Build TASK-206 before or alongside this ticket.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
