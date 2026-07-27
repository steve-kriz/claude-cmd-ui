---
id: TASK-183
title: Board panel — column→phase link field with a "PR Review" → Phase 4 example
status: done
created: 2026-07-27T12:00:00Z
updated: 2026-07-27T16:45:00Z
agent: orchestrator-main
activities: [{"activity":"code","model":"claude-sonnet-5","startedAt":"2026-07-27T16:05:00Z","finishedAt":"2026-07-27T16:20:00Z"},{"activity":"test","model":"claude-haiku-4-5","startedAt":"2026-07-27T16:20:00Z","finishedAt":"2026-07-27T16:35:00Z"},{"activity":"post-processing","model":"claude-opus-4-8","startedAt":"2026-07-27T16:35:00Z","finishedAt":"2026-07-27T16:42:00Z"},{"activity":"post-processing","model":"claude-sonnet-5","startedAt":"2026-07-27T16:35:00Z","finishedAt":"2026-07-27T16:42:00Z"}]
---

## Description
Extend the Team tab's **Board** panel column editor so a column can carry an explicit link to
one of the four workflow phases (`plan`/`build`/`test`/`review`) — a first-class field, not an
implicit naming convention. This makes the correspondence the board already has implicitly
(todo/defining → plan, in-progress → build, testing → test) explicit and lets the user add a
new column (e.g. **"PR Review"**) linked to **Phase 4 (review)**.

**Depends on TASK-180** for the per-column `phase` schema (and its renderer-mirror
round-trip fix, since `tasksSerializeTeamConfig` currently drops extra column fields).

The field is authored per column in `buildTeamColumnRow` (a `<select>` of `(none)` + the four
phase keys), persisted through the existing whole-file `saveTeamBoardConfig` /
`tasksSerializeTeamConfig` path. Like the existing per-column `agent`, the `phase` link is
config metadata; the phase-skip behaviour itself is defined by TASK-181's prose reading
`skill.phases.<phase>.enabled` (the single source of truth) — **resolved**: since `review`
defaults `enabled: false` (TASK-180), this ticket's Save flow must include the specific,
one-time convenience rule that makes "linking a column turns review on" concretely true: when
saving a column whose `phase` is set to a value that currently has **zero** other columns
linked to it and `skill.phases.<phase>.enabled` is `false`, flip that phase's `enabled` to
`true` as part of the same whole-file config write. This is a one-time default-flip, not a
continuously recomputed value — the user can still manually re-disable that phase afterwards
via the Workflow panel toggle (TASK-182), and that manual choice sticks even while the column
link remains.

## Acceptance Criteria
- [x] Each column row (`buildTeamColumnRow`) gains a **Phase** `<select>` with options `(none)` + `plan`/`build`/`test`/`review`, seeded from the column's persisted `phase` (or `(none)` when null).
- [x] Changing the select updates the in-memory working model and marks the board dirty; Save persists the column's `phase` into `tasks/team-config.json` (and it survives a round-trip / re-read).
- [x] The four system columns can also carry a `phase` link (so the implicit todo→plan / in-progress→build / testing→test correspondences can be made explicit); setting/clearing a system column's `phase` does not otherwise alter its immutable slug/system flag.
- [x] Adding a new user column named "PR Review" (slug `pr-review`) and linking it to `review` persists a column with `phase: "review"` **and** flips `skill.phases.review.enabled` to `true` in the same save (review's TASK-180 default is `false`, and this is the concrete first-link-enables convenience path); this is covered by a concrete test.
- [x] The auto-enable flip only fires when the target phase currently has zero linked columns; linking a second column to an already-linked (or already-enabled) phase does not re-flip or otherwise change `enabled`. If the user had manually disabled the phase after a previous link, linking another column does not re-enable it (manual toggle state always wins over the one-time convenience flip).
- [x] All new dynamic text uses `textContent`; the `phase` value is validated to one of the four keys (or null) before persistence (defence-in-depth alongside TASK-180's normalisation) so a tampered value can never reach disk.
- [x] The Tasks board render is unaffected by the new field (it is metadata; no lane/routing change in this ticket) — existing board behaviour and tests still pass.
- [x] Renderer mirror + lib normalisation agree: a saved `phase` round-trips through `tasksSerializeTeamConfig` and `normalizeConfig` identically.

## Cucumber Tests
```gherkin
Feature: Board column phase linkage
  Scenario: link a user column to a phase
    When the user adds column "PR Review" and sets its Phase select to "review" and saves
    Then tasks/team-config.json has a column pr-review with phase "review"
    And skill.phases.review.enabled is true (flipped from its default false)

  Scenario: second link to an already-linked phase does not re-flip (edge)
    Given a column already linked to review and skill.phases.review.enabled manually set false again
    When the user adds another column also linked to review and saves
    Then skill.phases.review.enabled remains false (manual choice is not overridden)

  Scenario: system column can be linked explicitly
    When the user sets the "testing" system column Phase to "test" and saves
    Then the testing column persists phase "test" with system true and slug "testing" unchanged

  Scenario: clearing a link
    Given a column with phase "review"
    When the user sets its Phase select to "(none)" and saves
    Then the column persists phase null

  Scenario: phase link round-trips (edge)
    Given a saved config with pr-review linked to review
    When the Board panel re-reads the file
    Then the Phase select shows "review" for that column

  Scenario: tampered phase value rejected (failure/edge)
    Given an in-memory column whose phase was set to "deploy"
    When the config is serialised
    Then the persisted column has phase null (never "deploy")
```

## Edge & Failure Cases
- A column with no `phase` (historic config) → select shows `(none)`, persists `null`.
- Invalid/tampered `phase` → nulled by the serializer (and TASK-180's normaliser).
- Removing a user column that had a `phase` link is unaffected (config-only removal, as today).
- Two columns linked to the same phase is permitted at this layer; only the *first* link (zero-to-one transition) triggers the auto-enable flip.
- No folder open / corrupt config → existing Board-panel defaults + notice behaviour, unchanged.

## Clarifications
- Q: What does "no column linked" mean for a phase's default state, specifically Review? A: **Review is off by default until a column is linked** — resolved by the one-time auto-enable-on-first-link rule above, since `skill.phases.review.enabled` (TASK-180) is the actual source of truth the orchestrator reads (TASK-181), not column-presence itself.
- Q: Is per-phase agent reassignment in scope? A: **Out of scope** — not touched by this ticket.

## Relevant Files & Context
- `renderer/renderer.js` — `buildTeamColumnRow` (~5837, add the Phase select next to Display agent), `buildTeamAddColumnForm` (~6001, new columns start with `phase: null`), `saveTeamBoardConfig` (~6139), `tasksSerializeTeamConfig` (~5619, must carry `phase` — see TASK-180), `normalizeTasksColumns` (~5437).
- `lib/team-config.js` — `COLUMN_KEYS` / column normalisation with `phase` (TASK-180).
- `docs/dynamic-statuses.md` — Board panel column-manager contract and the `agent` display-only precedent to mirror for `phase`.
- Tests to model on: `test/task-091-team-tab-scaffold.e2e.test.js` and existing board-config tests; add a `task-183-*` pair.
- Depends on: TASK-180.

## Build notes
- Coder: added `TASKS_PHASE_ENABLED_DEFAULTS`, `tasksPhaseLinkCounts`, `tasksApplyPhaseAutoEnable` (one-time zero-to-one enable flip); Phase select in `buildTeamColumnRow`; `saveTeamBoardConfig` applies the flip before persisting. Updated `docs/dynamic-statuses.md`.
- Tester: added `test/task-183-column-phase-linkage.test.js` (24 tests) + `.e2e.test.js` (17 tests). Full suite verified independently by the orchestrator: 3595 pass, 3 pre-existing baseline failures, 0 regressions (the tester's initial report of a 4th "telemetry" failure did not reproduce on a clean re-run — full suite is genuinely green).
- Tech-lead review skipped (review defaults disabled, no team-config.json on disk yet — same default-behavior as TASK-182).
- Post-processing: security review found no new issues (textContent-only rendering, four-key allowlist enforced before disk, no prototype-pollution vector in the auto-enable flip, flip cannot be gamed by duplicate/invalid columns); documentation pass confirmed `docs/dynamic-statuses.md` accurate and added a one-line mention to `docs/team-tab.md`'s feature table.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
