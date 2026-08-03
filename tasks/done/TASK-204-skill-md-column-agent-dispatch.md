---
id: TASK-204
title: SKILL.md — generic column-agent dispatch loop and movement model
status: done
created: 2026-08-03T09:30:00.000Z
updated: 2026-08-03T16:35:00.000Z
---

## Description
Rewrite `.claude/skills/orchestrate/SKILL.md` so the orchestrator's dispatch
engine is **column-driven and uniform**, replacing the hardcoded Phase 1→2→3→4
role pipeline. There is no fixed BA → coder → tester → tech-lead sequence anymore:
**every board column** (from `tasks/team-config.json`'s `columns`) has an assigned
`agent` and free-text `instructions`, and the orchestrator's job is the same for
every column — read the column's `agent` + `instructions`, dispatch that agent
with the ticket's full text plus that column's instructions, and advance the
ticket forward.

This ticket covers the **core loop and the forward movement model**; the
rework/fix-loop, the review reject-and-rework backward move, and the terminal
`done` transition are TASK-205 (same file, built after this). TASK-205 depends on
the loop and column-lookup mechanics this ticket establishes. Note also TASK-206
(build before or alongside this ticket): it removes the `post-processing` system
column and the whole `kind: post-processing` concept from the app entirely — this
rewrite must not describe or reference a post-processing step anywhere.

**The generic dispatch loop.** For a ticket, the orchestrator:
1. Reads the ordered `columns` (left-to-right = the board lane order) from
   `tasks/team-config.json` (normalised by `lib/team-config.js`; missing/corrupt →
   the canonical six system columns with `SYSTEM_COLUMN_DEFAULT_AGENTS` /
   `SYSTEM_COLUMN_DEFAULT_INSTRUCTIONS`).
2. Finds the ticket's **current column** = the column whose `status` slug equals
   the ticket's `status`.
3. If that column has an **agent** (its own, or the system default when `null`,
   or `general-purpose` when the named agent is missing — reported): dispatch it
   with the **fixed preamble + the ticket text + that column's `instructions`
   LAST** (volatile tail). On success, advance the ticket to the **next column's
   status** (whole-file atomic write, `updated` bumped).
4. If the column has **no agent** (a passive column — `todo`, `done`, or any
   user parking column): do not dispatch; the ticket waits there (e.g. `todo` is
   the entry queue) or is advanced without a dispatch when the loop reaches it.

**Forward movement model (linear, left-to-right).** Advancement follows the
column order. The existing status lifecycle is preserved exactly, reframed as
column dispatch:
- `todo` (no agent) → `defining`.
- `defining` (BA agent): its **instructions** carry the definition-skip gate — an
  already-defined ticket passes through unchanged. A defined ticket returns to
  `todo` (so the build column's **claim** picks it up), exactly as today's
  mid-build define path.
- Building into `in-progress` is performed by the **claim** (`claimTicket`:
  `todo`/`failed-testing` → `in-progress` + `agent`), unchanged.
- `in-progress` (coder agent) → `testing`.
- Any **user columns** positioned between `testing` and `done` are dispatched
  **serially** (like today's optional review step) in column order.
- Then `done` (TASK-205 owns that transition). There is no post-processing step:
  TASK-206 removes the `post-processing` system column and the whole
  `kind: post-processing` concept entirely — do not reference it here.

**Backward movement exists too (owned by TASK-205, noted here so the loop design
accounts for it):** movement is not *strictly* linear — the testing column's fix
loop and a review-type column's reject-and-rework verdict can both send a ticket
backward to an earlier column. This ticket's dispatch loop must be written so
"advance to the next column" is one outcome among several the dispatch step can
produce (forward / backward / park-and-ask), not a hardcoded one-way step — but
the concrete backward rules themselves are specified in TASK-205.

**Preserved mechanics (carry over unchanged — these are about concurrency, not
about which agent runs):** whole-file atomic ticket writes; claim-before-build;
per-ticket concurrency slot math and batching (`selectNextBatch` /
`canRunInParallel` in `lib/ticket-queue.js`); per-ticket git isolation
(`ticketBranchName` / `ticketWorktreeDir`); serialize-only-shared-git; distilled
returns; prompt caching (stable agent system-prompt prefix + the volatile
`instructions`/ticket tail); the context-optimisation directive (still reads
`skill.contextOptimization`); model routing pinned per agent file (`model:`).

**Explicit design decision to document in SKILL.md:** `lib/ticket-queue.js` and
`lib/ticket-lanes.js` are **unchanged**. The swarm's claim/slot/isolation stays
bound to the existing swarm statuses (`todo/defining/in-progress/testing/failed-testing`);
**user-column statuses stay non-claimed and non-slot-counted** (`isUserStatus`) and
are dispatched serially. A user-column agent that writes to the shared tree must be
serialized like the shared-git merge step.

The `assets/skills/orchestrate/SKILL.md` mirror must be written **byte-identical**
(drift-guard tests).

## Acceptance Criteria
- [ ] SKILL.md no longer contains hardcoded role-to-phase dispatch (`Phase 1 → orchestrate-ba`, `Phase 2 → orchestrate-coder`, etc.); the "which agent runs" decision is described as a per-column `agent` lookup from `tasks/team-config.json`.
- [ ] SKILL.md documents the generic loop: read ordered `columns` → find the ticket's current column by matching `status` → dispatch `column.agent` (with the fallback chain: column agent → `SYSTEM_COLUMN_DEFAULT_AGENTS[slug]` when null → `general-purpose` when the named agent is missing, and report a missing named agent) → append `column.instructions` as the volatile tail → advance left-to-right on success.
- [ ] SKILL.md defines the forward movement model precisely: `todo → defining → todo (defined) → in-progress (via claim) → testing → [user columns] → done`, and states that forward advancement is the configured column order.
- [ ] SKILL.md states that a passive column (no agent) is not dispatched, and that `todo` is the entry queue.
- [ ] SKILL.md's dispatch-outcome description explicitly allows non-forward outcomes (backward move, park-and-ask) as well as forward advancement, deferring their concrete rules to the rework/review section (TASK-205) rather than presenting "always advance forward" as the only case.
- [ ] SKILL.md preserves and cross-references (unchanged): whole-file atomic writes, claim-before-build, batching + slot math (`selectNextBatch`/`canRunInParallel`, default 3 / max 8), per-ticket git isolation, shared-git serialization, distilled returns, prompt caching, context-optimisation directive (reads `skill.contextOptimization`), and per-agent `model:` routing.
- [ ] SKILL.md explicitly records that `lib/ticket-queue.js`/`lib/ticket-lanes.js` are unchanged, that user-column statuses stay non-claimed/non-slot/serial, and that a tree-writing user-column agent must be serialized.
- [ ] SKILL.md states no new status is introduced (enum stays `todo/defining/in-progress/testing/done/failed-testing` — five lanes plus the claimable fix-loop status, per TASK-206) and contains no reference to a post-processing column, status, or `kind: post-processing` ticket concept anywhere.
- [ ] The `## Routing` section still maps `/orchestrate plan`, `/orchestrate build`, `/orchestrate status`, but "build" is described as running the generic column loop until the board is clear.
- [ ] `.claude/skills/orchestrate/SKILL.md` and `assets/skills/orchestrate/SKILL.md` are byte-identical after the change (drift guard passes).
- [ ] The prompt-caching guidance is updated so the **stable prefix** is the agent system prompt + fixed preamble and the **volatile tail** is the ticket text + the column's `instructions` (not a per-phase model id spliced into the preamble).

## Cucumber Tests
```gherkin
Feature: column-driven dispatch in SKILL.md

  Scenario: dispatch reads the ticket's current column
    Given a ticket in status "in-progress"
    And the "in-progress" column names agent "orchestrate-coder" with instructions X
    When the orchestrator processes the ticket
    Then it dispatches orchestrate-coder with the ticket text plus instructions X

  Scenario: a null system-column agent falls back to the canonical default
    Given the "testing" column has agent null
    When a ticket reaches "testing"
    Then the orchestrator dispatches SYSTEM_COLUMN_DEFAULT_AGENTS["testing"] (orchestrate-tester)

  Scenario: a missing named agent falls back to general-purpose and is reported
    Given the "in-progress" column names agent "orchestrate-coder"
    And no orchestrate-coder definition exists in .claude/agents/
    When a ticket reaches "in-progress"
    Then the orchestrator dispatches general-purpose
    And it reports the missing agent

  Scenario: linear advancement follows column order
    Given a defined ticket in "in-progress" that builds successfully
    When the coder returns
    Then the ticket advances to "testing"

  Scenario: a passive column is not dispatched
    Given a ticket in "todo" and the "todo" column has no agent
    Then no agent is dispatched for it until /orchestrate build advances it

  Scenario: user columns between testing and done dispatch serially
    Given a user column "pr-review" with agent "orchestrate-tech-lead" sits between testing and done
    And a ticket has passed testing
    Then the orchestrator dispatches orchestrate-tech-lead once, serially, before done

  Scenario: concurrency and claim mechanics are unchanged (edge)
    Given three eligible todo tickets and a concurrency limit of 3
    When /orchestrate build runs
    Then it claims and builds them in parallel via selectNextBatch exactly as before

  Scenario: the assets mirror stays byte-identical (drift guard)
    When SKILL.md is edited
    Then assets/skills/orchestrate/SKILL.md is written with identical bytes

  Scenario: corrupt team-config falls back to canonical columns (failure path)
    Given tasks/team-config.json is missing or unparseable
    When the orchestrator builds
    Then it uses the six system columns with their default agents and instructions
```

## Edge & failure cases the coder must handle
- Column names a non-existent agent → fall back to `general-purpose`, continue, report (parity with today's dispatch fallback).
- System column with `agent:null` → use `SYSTEM_COLUMN_DEFAULT_AGENTS`; a user column with no agent → passive (no dispatch).
- A ticket whose `status` matches **no** column (out-of-enum / `unknown`) → do not dispatch; report it (never silently route to `todo`).
- `tasks/team-config.json` missing/corrupt → canonical six columns + default agents/instructions.
- A user-column agent that writes to the shared tree → must be serialized (no parallel claim/isolation for user statuses).
- The assets mirror must not drift — write both copies (see `lib/assets-mirror.js` mapping).
- Do not restate a per-phase model id in the preamble (busts the prompt cache); model tiers live in each agent file's `model:`.

## Relevant files & context
- `C:\projects\claude-cmd-ui2\.claude\skills\orchestrate\SKILL.md` — the whole file is redesigned. Current structure to replace: "Routing — which phase am I in?" (105–112), "Agent dispatch and fallback" (114–130), "Model routing" (132–162), "Distilled returns"/"Prompt caching" (164–208), "Context optimisation" (210–255), "Phase-enabled config and dispatch order" (257–301, delete — phase system gone), "Phase 1–4" sections (303–671, reframe into the generic loop; Phases 3/4 rework + terminal go to TASK-205), "Concurrency, claims, and isolation" (672–717, keep essentially as-is), "State-consistency rules" (719–748, keep, drop phase-skip bullet).
- `C:\projects\claude-cmd-ui2\assets\skills\orchestrate\SKILL.md` — byte-identical mirror target.
- `C:\projects\claude-cmd-ui2\lib\assets-mirror.js` — `MIRRORED_SUBTREES` / `mirrorRelPath` (25–52): confirms `.claude/skills/orchestrate/` ↔ `assets/skills/orchestrate/`.
- `C:\projects\claude-cmd-ui2\lib\team-config.js` (post-TASK-201) — `SYSTEM_COLUMN_DEFAULT_AGENTS`, `SYSTEM_COLUMN_DEFAULT_INSTRUCTIONS`, `columns` shape (`status/label/description/agent/instructions/system`).
- `C:\projects\claude-cmd-ui2\lib\ticket-queue.js` — UNCHANGED; `selectNextBatch` (343–376), `canRunInParallel` (403–448), `claimTicket` (268–317), `ticketBranchName`/`ticketWorktreeDir` (468–477), `CLAIMABLE_STATUSES` (77), slot math (246–254).
- `C:\projects\claude-cmd-ui2\lib\ticket-lanes.js` — UNCHANGED; `LANE_STATUSES`/`VALID_STATUSES` (33–38), `laneStatusesFor` (215–246), `isPostProcessingTicket` (77–80).
- `C:\projects\claude-cmd-ui2\lib\ticket-definition.js` — `isTicketDefined` (the definition-skip gate the defining column's instructions rely on).
- Drift-guard tests: `C:\projects\claude-cmd-ui2\test\orchestrate-agents.test.js`, `C:\projects\claude-cmd-ui2\test\orchestrate-swarm.test.js`. Tests asserting `## Phase <n>` structure (via `lib/skill-workflow.js`) will need updating since the phase headings are gone.
- Depends on TASK-201 (reads `agent`/`instructions` + `SYSTEM_COLUMN_DEFAULT_AGENTS`) and TASK-206 (removes the post-processing column/concept this rewrite must not reference). Independent of TASK-202/203. TASK-205 depends on this ticket (same file, backward-movement rules build on this loop).

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
