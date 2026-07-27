---
id: TASK-180
title: team-config.json schema — per-phase enabled/order + per-column phase linkage
status: done
created: 2026-07-27T12:00:00Z
updated: 2026-07-27T14:15:00Z
agent: orchestrator-main
activities: [{"activity":"ba","model":"claude-opus-4-8","startedAt":"2026-07-27T12:00:00Z","finishedAt":"2026-07-27T12:30:00Z"},{"activity":"code","model":"claude-sonnet-5","startedAt":"2026-07-27T13:15:00Z","finishedAt":"2026-07-27T13:30:00Z"},{"activity":"test","model":"claude-haiku-4-5","startedAt":"2026-07-27T13:30:00Z","finishedAt":"2026-07-27T13:45:00Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-27T13:45:00Z","finishedAt":"2026-07-27T14:00:00Z"},{"activity":"post-processing","model":"claude-opus-4-8","startedAt":"2026-07-27T14:00:00Z","finishedAt":"2026-07-27T14:10:00Z"},{"activity":"post-processing","model":"claude-sonnet-5","startedAt":"2026-07-27T14:00:00Z","finishedAt":"2026-07-27T14:10:00Z"}]
---

## Description
Add two schema extensions to `tasks/team-config.json`, modelled purely in
`lib/team-config.js` (and its renderer mirrors), so later UI/behaviour tickets have a
persisted, normalised store to read/write:

1. **`skill.phases`** — a map keyed by the four canonical phase keys
   (`plan`/`build`/`test`/`review`, sourced from `PHASE_SPECS` in
   `lib/skill-workflow.js`), each `{ enabled: boolean, order: integer }`. This backs the
   Workflow panel's enable/disable toggle + reorder (TASK-182) and the live
   phase-skipping behaviour (TASK-181).
2. **Per-column `phase`** — an optional field on a board column linking it to one of the
   four phases (or `null`). This backs the Board panel's column→phase link (TASK-183).

This is a **pure, lib-level** change plus the renderer mirrors — no visible UI yet. It is
the foundation ticket: **TASK-181, TASK-182 and TASK-183 all depend on this schema
existing**, so it should build first.

The module must keep its existing invariants: `lib/team-config.js` is Electron-free, never
throws, and any junk/partial/tampered input collapses to a complete valid config with a
`warnings` entry per repair. The renderer mirror is a browser script that cannot `require`
Node — it must be kept byte-for-byte in lockstep (KEEP-IN-SYNC comments), and today
`tasksSerializeTeamConfig` rebuilds columns to a fixed key set that would silently drop the
new `phase` field, so the mirror MUST be updated too or column links never persist.

## Acceptance Criteria
- [x] `defaultConfig()` includes `skill.phases` with all four keys: `plan`/`build`/`test` default `{ enabled: true, order: n }` (canonical order 1/2/3, matching their existing implicit system-column correspondence); `review` defaults `{ enabled: false, order: 4 }` — review is **opt-in by default** (see Clarifications) since, unlike the other three, it has no system board column today.
- [x] `normalizeConfig(raw)` produces `skill.phases` with exactly the four canonical keys: any missing phase is filled from defaults (with a warning), any unknown/extra phase key is dropped (with a warning), and the four keys are always present.
- [x] For each phase, `enabled` is coerced to a strict boolean (missing/non-boolean → `true`, with a warning when a non-boolean was present) and `order` is coerced to a positive integer (missing/non-integer/≤0 → the canonical default for that phase, with a warning).
- [x] A column's `phase` field is normalised: a string exactly equal to one of `plan`/`build`/`test`/`review` is kept; anything else (empty, unknown, non-string) becomes `null` (with a warning only when a non-null non-valid value was present). `phase` is added to `COLUMN_KEYS` so it serialises in canonical position and round-trips.
- [x] `serializeConfig(config)` round-trips both new pieces: an already-valid config with `skill.phases` and column `phase` values serialises byte-stable (idempotent), and the transient `warnings` list is stripped.
- [x] `validateNewColumn` is unchanged in signature/behaviour (a new column still starts with `phase: null` unless set later); no existing field is removed or reordered ahead of the current `COLUMN_KEYS`.
- [x] Renderer mirrors updated in lockstep: `tasksSerializeTeamConfig` (renderer/renderer.js ~5619) preserves each column's `phase` (it currently maps columns to a fixed `{status,label,description,agent,system}` set and would drop it), `normalizeTasksColumns` (~5437) preserves/normalises `phase`, and `buildWorkingConfigFromRaw` (~7357) preserves `skill.phases`.
- [x] `CONFIG_VERSION` handling is unchanged — a newer `version` still round-trips and is never downgraded; a config with no `skill.phases`/no column `phase` (the historic shape) still normalises without error and gains the defaults.
- [x] Prototype-pollution guards (`isUnsafeKey`/`UNSAFE_KEYS`) still apply to the new nested `skill.phases` object and to per-column keys.

## Cucumber Tests
```gherkin
Feature: team-config phase + column-phase schema
  Scenario: defaultConfig carries the four phases
    When defaultConfig() is produced
    Then skill.phases has keys plan, build, test, review
    And each is enabled true with order 1,2,3,4 respectively

  Scenario: normalizeConfig fills a missing phase
    Given a config whose skill.phases omits "review"
    When it is normalized
    Then skill.phases.review is present, enabled true, order 4
    And a warning names the re-inserted phase

  Scenario: unknown phase key is dropped
    Given a config with skill.phases.deploy = { enabled: true, order: 9 }
    When it is normalized
    Then skill.phases has exactly plan/build/test/review
    And a warning names the dropped "deploy" phase

  Scenario: column phase link normalises to a valid phase
    Given a user column with phase "review"
    When it is normalized
    Then the column keeps phase "review"

  Scenario: column phase round-trips through the renderer serializer
    Given a working config whose column has phase "review"
    When tasksSerializeTeamConfig serialises it
    Then the persisted JSON still carries phase "review" on that column

  Scenario: invalid column phase is nulled (failure/edge)
    Given a column with phase "deploy" and another with phase 42
    When it is normalized
    Then both columns have phase null
    And a warning is recorded for the non-null invalid value

  Scenario: enabled coercion (failure/edge)
    Given skill.phases.review.enabled = "no" and skill.phases.test.order = -3
    When it is normalized
    Then review.enabled is true (coerced) with a warning
    And test.order is 3 (canonical default) with a warning
```

## Edge & Failure Cases
- `raw` is null / a string / not an object / junk → `defaultConfig()` with `skill.phases` present, never throws.
- `skill` present but `skill.phases` missing entirely → all four defaults injected.
- `skill.phases` is an array or non-object → replaced with defaults + warning.
- A phase value that is not an object (e.g. `plan: true`) → replaced with that phase's defaults + warning.
- `order` collisions (two phases with the same order) are permitted at the schema level (the panel/behaviour tickets decide tie-breaks); just coerce each to a positive integer. Do NOT re-sequence here.
- `__proto__`/`constructor`/`prototype` as a phase key or column key → dropped as unsafe.
- Renderer mirror must NOT drop unknown top-level or per-column fields it does not understand (existing round-trip guarantee) while adding `phase`.

## Relevant Files & Context
- `lib/team-config.js` — `COLUMN_KEYS` (line 87), `orderColumn` (111), `normalizeConfig` skill block (342-356), `defaultConfig` (211), `serializeConfig` (417), `buildUserColumn`/`repairSystemColumn`.
- `lib/skill-workflow.js` — `PHASE_SPECS` (lines 34-39) is the authoritative source of the four phase keys and canonical order; import/mirror it rather than hardcoding.
- `renderer/renderer.js` — `normalizeTasksColumns` (~5437), `tasksSerializeTeamConfig` (~5619, currently drops extra column fields), `buildWorkingConfigFromRaw` (~7357), the `TASKS_*` slug/reserved constants.
- Tests to model on: `test/task-097-*`/config tests and any existing `lib/team-config` test; add a `task-180-*` unit pair.
- Invariant: pure/never-throws; renderer mirror kept in lockstep (KEEP-IN-SYNC comments).

## Clarifications
- Q: Should `order` be authoring-only or actually drive execution sequence? A: **Order actually drives execution sequence** (see TASK-181/TASK-182). This schema ticket only stores the integers; it does not interpret them.
- Q: What does "no board column linked to a phase" mean for that phase's default state, specifically Review? A: **Review is off by default until a column is linked to it** — this is an intentional, accepted default-behavior change for every existing project adopting this schema (plan/build/test keep their historic always-on default; only review's default flips to off).
- Q: Is per-phase agent reassignment in scope? A: **Out of scope** — not part of this schema.

## Build notes
- Coder: implemented `PHASE_KEYS`/`PHASE_DEFAULTS`/`defaultPhases`/`normalizePhases`/`normalizeColumnPhase` in `lib/team-config.js`, mirrored in `renderer/renderer.js` (`TASKS_PHASE_KEYS`, `tasksNormalizeColumnPhase`, `tasksBuildColumn`, `normalizeTasksColumns`, `tasksSerializeTeamConfig`); fixed several test harnesses' extraction lists broken by the new column shape.
- Tester: added `test/task-180-team-config-phases.test.js` (unit) and `test/task-180-team-config-phases.e2e.test.js` (e2e). Full suite: 3490 pass, 3 pre-existing baseline failures (unrelated), 0 regressions.
- Reviewer: implementation and security posture correct; found two test-fidelity gaps, filed as **TASK-186** (renderer-mirror scenarios actually exercise the lib, not renderer.js) and **TASK-187** (`__proto__` prototype-pollution test uses an inert object literal instead of a JSON-sourced hazard) — both are review follow-ups, not blockers for this ticket reaching `done`.
- Post-processing: security review pass found no new issues; documentation pass added factual, code-verified notes to `docs/workflow-settings.md` and `docs/dynamic-statuses.md` about the new schema fields, explicitly flagging that no UI consumes them yet.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
