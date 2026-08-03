---
id: TASK-201
title: Board-config schema — per-column instructions, remove the phase system, seed default column agents
status: done
created: 2026-08-02T21:59:32.232Z
updated: 2026-08-03T10:35:00.000Z
---

## Description
Re-shape the `tasks/team-config.json` schema in `lib/team-config.js` (the pure,
Electron-free source of truth) so a board **column** carries everything the
orchestrate skill needs to dispatch an agent for the tickets passing through it,
and so the retired **phase system** is fully removed.

Three concerns:

1. **Add a per-column `instructions` field** — free text telling the agent
   assigned to that column how to handle tickets in that step. It is normalised
   (non-string → `''`), round-trips, and is preserved for both system and user
   columns.
2. **Remove the phase system** — delete the column `phase` link, the whole
   `skill.phases` sub-object, and the `require('./skill-workflow')` coupling.
   Legacy configs that still carry `phase`/`skill.phases` load cleanly (those
   fields are dropped, with a warning), so this is a safe forward migration.
3. **Seed default column agents + instructions.** Export a canonical
   `SYSTEM_COLUMN_DEFAULT_AGENTS` map and `SYSTEM_COLUMN_DEFAULT_INSTRUCTIONS`
   text, sourced from `lib/orchestrate-agents.js` `AGENT_TYPES` (so agent ids stay
   in lockstep). Fresh/re-injected system columns seed these, giving an
   out-of-the-box config that reproduces today's BA → coder → tester behaviour
   without any hardcoded role names in the skill.

`skill.concurrencyDefault` and `skill.contextOptimization` are **kept unchanged**
(they move panels in TASK-202/203 but the schema is identical). This module must
keep its existing guarantees: pure, never throws, junk/partial/tampered input
always collapses to a complete valid config.

Also migrate the repo's own `tasks/team-config.json` to the new shape (drop
`phase`/`skill.phases`, add `agent`/`instructions` for the system columns) so the
sample matches the schema.

**Out of scope:** the renderer mirror (TASK-202), the Workflow panel removal
(TASK-203), and SKILL.md (TASK-204/205). `lib/skill-workflow.js` and
`lib/skill-section.js` are left in place as now-unused parsers (a later cleanup);
this ticket only removes team-config's dependency on them.

## Acceptance Criteria
- [ ] `COLUMN_KEYS` is `['status','label','description','agent','instructions','system']` — `phase` removed, `instructions` added after `agent`.
- [ ] A column's `instructions` is normalised to a trimmed-preserving string: a non-string value (number/object/array/null/undefined) becomes `''`; a string is kept verbatim (internal newlines preserved). It round-trips for both system and user columns and is emitted in canonical `COLUMN_KEYS` order.
- [ ] `normalizeColumnPhase` and every `phase` reference are removed from `orderColumn`, `defaultSystemColumn`, `repairSystemColumn`, and `buildUserColumn`; a `phase` key present on any input column is dropped on normalize (not round-tripped) and a warning is recorded naming the column.
- [ ] `skill.phases` is fully removed: `normalizePhases`, `defaultPhases`, `PHASE_KEYS`, `PHASE_DEFAULTS`, and `PHASE_SPECS`/`require('./skill-workflow')` are gone from this module. A normalized config's `skill` has **no** `phases` key. An input `skill.phases` is dropped (not round-tripped as an unknown skill key) with one warning.
- [ ] `skill.concurrencyDefault` (clamped via `resolveConcurrency`) and `skill.contextOptimization` (via `normalizeContextOptimization`) behave exactly as before; all other unknown `skill` keys still round-trip; unsafe keys (`__proto__`/`constructor`/`prototype`) are still dropped.
- [ ] A new exported `SYSTEM_COLUMN_DEFAULT_AGENTS` maps `{ todo:null, defining:AGENT_TYPES.ba, 'in-progress':AGENT_TYPES.coder, testing:AGENT_TYPES.tester, 'post-processing':null, done:null }` (agent ids sourced from `lib/orchestrate-agents.js`, never hardcoded string literals).
- [ ] A new exported `SYSTEM_COLUMN_DEFAULT_INSTRUCTIONS` maps each system slug to its canonical instruction text (see "Default instructions text" below).
- [ ] `defaultSystemColumn(slug)` seeds `agent` from `SYSTEM_COLUMN_DEFAULT_AGENTS[slug]` and `instructions` from `SYSTEM_COLUMN_DEFAULT_INSTRUCTIONS[slug]`. `repairSystemColumn` preserves a user-set `agent`/`instructions` and only defaults them when absent/invalid (a user-set `agent:null` on a system column is preserved as null).
- [ ] `buildUserColumn` seeds `instructions:''` when absent and preserves a user-supplied `agent`/`instructions`.
- [ ] `validateNewColumn` and `serializeConfig` are unaffected except that serialized columns no longer contain `phase` and now contain `instructions`; `serializeConfig` output round-trips through `normalizeConfig` unchanged (idempotent).
- [ ] `module.exports` drops `PHASE_KEYS`/`PHASE_DEFAULTS` and adds `SYSTEM_COLUMN_DEFAULT_AGENTS`/`SYSTEM_COLUMN_DEFAULT_INSTRUCTIONS`.
- [ ] The module never throws for any input (null/string/number/array/tampered) and always returns a complete valid config.
- [ ] The repo's `tasks/team-config.json` is migrated: no `phase` keys, no `skill.phases`, system columns carry their default `agent`+`instructions`, `concurrencyDefault` + `contextOptimization` preserved. The stray `pr-review` user column (currently `phase: "review"`) either drops its `phase` or is left as a plain user column with `instructions:''`.

## Cucumber Tests
```gherkin
Feature: team-config schema with per-column instructions and no phase system

  Scenario: instructions round-trips on a system column
    Given a raw config whose "testing" column has instructions "Run node --test"
    When normalizeConfig runs
    Then the "testing" column has instructions "Run node --test"
    And the column key order is status,label,description,agent,instructions,system

  Scenario: non-string instructions collapse to empty
    Given a raw config whose "todo" column has instructions set to the number 5
    When normalizeConfig runs
    Then the "todo" column has instructions ""

  Scenario: a legacy column phase link is dropped with a warning
    Given a raw config whose "defining" column has phase "plan"
    When normalizeConfig runs
    Then the "defining" column has no phase key
    And warnings include a message naming the "defining" column's dropped phase

  Scenario: skill.phases is removed entirely
    Given a raw config whose skill has a phases object
    When normalizeConfig runs
    Then the normalized skill has no phases key
    And warnings include a message that skill.phases was dropped
    And the normalized skill still has concurrencyDefault and contextOptimization

  Scenario: fresh config seeds default agents and instructions
    Given no input config
    When defaultConfig runs
    Then the "defining" column agent equals AGENT_TYPES.ba
    And the "in-progress" column agent equals AGENT_TYPES.coder
    And the "testing" column agent equals AGENT_TYPES.tester
    And the "todo","post-processing","done" columns have agent null
    And each system column's instructions equals its SYSTEM_COLUMN_DEFAULT_INSTRUCTIONS entry

  Scenario: a user-set null agent on a system column is preserved
    Given a raw config whose "in-progress" column has agent null explicitly
    When normalizeConfig runs
    Then the "in-progress" column agent is null

  Scenario: serialize is idempotent and phase-free
    Given any raw config containing phase and skill.phases
    When serializeConfig runs and its output is re-normalized
    Then the re-normalized config equals the first normalized config
    And the serialized JSON contains no "phase" key and no "phases" key

  Scenario: unknown skill keys still round-trip but phases never does (edge)
    Given a raw config whose skill has phases and an unknown key "foo":42
    When normalizeConfig runs
    Then the normalized skill has foo 42
    And the normalized skill has no phases key

  Scenario: junk input never throws (failure path)
    Given the input is the string "not json {"
    When normalizeConfig runs
    Then it returns a complete valid config with the six system columns
    And each system column carries its default agent and instructions
```

## Edge & failure cases the coder must handle
- Input carrying BOTH legacy `phase` (on columns) and `skill.phases` — both dropped, each warned once; never round-tripped.
- `instructions` given as an object/array/number/null → `''`; a huge multi-KB string is kept verbatim (no truncation).
- A tampered system column with `system:false` / wrong slug still repairs to the canonical system column WITH its default agent+instructions re-seeded.
- Unsafe keys (`__proto__`/`constructor`/`prototype`) on a column or on `skill` are still dropped — never assigned.
- `AGENT_TYPES` must be the source of the default-agent ids (no literal `'orchestrate-ba'` strings) so a rename in `lib/orchestrate-agents.js` propagates.
- The module must not import `lib/skill-workflow.js` after this change (removing the only consumer of `PHASE_SPECS` there).

## Relevant files & context
- `C:\projects\claude-cmd-ui2\lib\team-config.js` — the file to change. Key spots: `require('./skill-workflow')` (line 73); `COLUMN_KEYS` (line 106); `PHASE_KEYS`/`PHASE_DEFAULTS`/`defaultPhases` (lines 113–133); `normalizeColumnPhase` (204–211); `defaultSystemColumn` (246–255); `repairSystemColumn` (260–271); `buildUserColumn` (274–285); `defaultConfig` (289–299); `normalizePhases` (317–377); skill assembly + unknown-key loop (553–572); `serializeConfig` (633–644); exports (646–664).
- `C:\projects\claude-cmd-ui2\lib\orchestrate-agents.js` — `AGENT_TYPES` (`.ba`/`.coder`/`.tester`/`.techLead`) is the canonical agent-id source for the default map.
- `C:\projects\claude-cmd-ui2\lib\ticket-queue.js` — `resolveConcurrency` (188–196); `DEFAULT_CONCURRENCY`/`MAX_CONCURRENCY` (83–84) — re-exported unchanged.
- `C:\projects\claude-cmd-ui2\lib\ticket-lanes.js` — `LANE_STATUSES`/`VALID_STATUSES` (33–38) still drive `SYSTEM_SLUGS`; unchanged.
- `C:\projects\claude-cmd-ui2\tasks\team-config.json` — migrate to the new shape (currently has `phase` on columns + a `skill.phases` block, lines 5–81, plus a `pr-review` user column at 44–51).
- Tests live under `C:\projects\claude-cmd-ui2\test\` (look for `team-config*.test.js`); expect churn on any test asserting `phase`/`skill.phases`/`agent:null` defaults — those assertions change with this schema.
- Pattern to follow: existing `normalizeContextOptimization` (392–430) is the template for a small, warned, defaulting normaliser; `orderColumn` (172–190) is the template for canonical key ordering + unsafe-key skipping.

**Default instructions text (seed these verbatim into `SYSTEM_COLUMN_DEFAULT_INSTRUCTIONS`):**
- `todo`: `Entry queue. New tickets wait here for /orchestrate build. No agent runs in this column.`
- `defining`: `Define the ticket: a precise Description, complete Acceptance Criteria, Cucumber Tests (Gherkin, at least one failure/edge scenario), explicit edge/failure cases, and the relevant files/context — all inside the ticket body. Never touch the user-owned Additional Context. If the ticket is already defined (real Acceptance Criteria plus a non-empty gherkin block), pass it through unchanged without redefining. Raise any clarifying question on the ticket's question field.`
- `in-progress`: `Implement the ticket to its Acceptance Criteria inside this ticket's isolated worktree/branch. Honour the Additional Context. Follow existing codebase conventions. Do not write tests beyond what compilation/wiring needs.`
- `testing`: `Write BOTH e2e cucumber-style node --test scenarios AND unit tests covering every Acceptance Criterion including at least one failure/edge path. Mock all database calls. Run the full suite under node --test and report pass/fail with failure output. A red result returns the ticket for a fix, capped at 3 attempts.`
- `post-processing`: `Holds post-processing tickets (kind: post-processing) — final events run against every normal task before Done. These are never built, tested, or claimed by the swarm.`
- `done`: `Terminal column. Completed tickets rest here.`

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
