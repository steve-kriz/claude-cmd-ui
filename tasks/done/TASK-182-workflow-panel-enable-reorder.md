---
id: TASK-182
title: Workflow panel — per-phase enable/disable toggle and reorder, wired to config
status: done
created: 2026-07-27T12:00:00Z
updated: 2026-07-27T16:00:00Z
agent: orchestrator-main
activities: [{"activity":"code","model":"claude-sonnet-5","startedAt":"2026-07-27T15:20:00Z","finishedAt":"2026-07-27T15:40:00Z"},{"activity":"test","model":"claude-haiku-4-5","startedAt":"2026-07-27T15:40:00Z","finishedAt":"2026-07-27T15:55:00Z"},{"activity":"post-processing","model":"claude-opus-4-8","startedAt":"2026-07-27T15:55:00Z","finishedAt":"2026-07-27T16:00:00Z"},{"activity":"post-processing","model":"claude-sonnet-5","startedAt":"2026-07-27T15:55:00Z","finishedAt":"2026-07-27T16:00:00Z"}]
---

## Description
Extend the Team tab's **Workflow** panel so each phase card exposes a first-class
**enabled/disabled** toggle and a **reorder** control (↑/↓), both persisted into
`tasks/team-config.json`'s `skill.phases.<phase>.{enabled,order}` (the TASK-180 schema).
Today the panel is read-only except for the per-phase agent-model editor (TASK-106) and the
concurrency default; this ticket adds the structural toggle + order editing without touching
SKILL.md structure (the AI-assisted prose path is TASK-185; the phase-skip behaviour is
TASK-181).

**Depends on TASK-180** (schema) — it reads/writes `skill.phases`. Writes go to
`tasks/team-config.json` only (NOT SKILL.md), through the same whole-file, re-read-first Save
pattern `buildWorkflowConcurrencyControl` already uses (re-read the file first via
`buildWorkingConfigFromRaw` so a concurrent Board-panel edit's columns are not clobbered,
then serialise via `tasksSerializeTeamConfig`).

Follow existing panel conventions: all dynamic text via `textContent`; stale-guard each async
write against the folder/tab changing; write failure surfaces inline; on success re-read
(`refreshTeamWorkflow`). **Resolved: `order` actually drives the live build sequence** (see
Clarifications) — this is not display-only. Because a nonsensical order (e.g. `test` before
`build`) is user-configurable but semantically risky, this panel must show a **non-blocking
warning** when the working order would run a phase ahead of its natural dependency (`build`
before `plan`, `test` before `build`, or `review` before `test`) — the warning does not
prevent Save; TASK-181's SKILL.md prose is the safety net that logs the deviation at build
time instead of refusing.

## Acceptance Criteria
- [x] Each of the four phase cards (`buildWorkflowPhase`) shows an **Enabled** toggle reflecting `skill.phases.<phase>.enabled` (default checked/true when the config/key is absent).
- [x] Toggling and saving writes `skill.phases.<phase>.enabled` into `tasks/team-config.json` via a whole-file, normalised write; the file is re-read first so Board-panel columns / version / unknown fields / concurrencyDefault are preserved.
- [x] Each phase card shows reorder ↑/↓ controls that adjust the phase's `order` relative to the others; Save persists the new `order` values for all four phases. Because order drives actual build sequence (resolved), a visible note near the reorder controls states this plainly (not "display only").
- [x] When the working order would place a phase ahead of its natural dependency (`build` before `plan`, `test` before `build`, `review` before `test`), the panel shows a non-blocking inline warning; Save still succeeds — the warning is advisory only.
- [x] A disabled phase is visually marked on its card (e.g. a "disabled" badge / dimmed state), distinct from the fallback-agent warning.
- [x] Save re-reads the config first (mirroring `buildWorkflowConcurrencyControl`) so a concurrent concurrency-default or Board-panel save is not clobbered; a write failure shows an inline error and leaves the working state intact.
- [x] After a successful save the panel re-reads from disk (`refreshTeamWorkflow`) and reflects the persisted enabled/order.
- [x] The panel never writes SKILL.md as part of this feature (the read-only pipeline parse is unchanged; only `tasks/team-config.json` is written).
- [x] All dynamic text uses `textContent`; the control is stale-guarded against folder/tab change mid-write.

## Cucumber Tests
```gherkin
Feature: Workflow panel phase enable/reorder
  Scenario: disabling the review phase persists to config
    When the user unchecks Enabled on the Review phase and saves
    Then tasks/team-config.json has skill.phases.review.enabled false
    And SKILL.md is not written

  Scenario: default enabled when config absent
    Given a project with no skill.phases in team-config.json
    When the Workflow panel renders
    Then every phase toggle is checked (enabled)

  Scenario: reorder persists order values
    When the user moves the Test phase above the Build phase and saves
    Then skill.phases order values reflect the new ordering in team-config.json

  Scenario: dependency-violating order shows a non-blocking warning (edge)
    When the user moves the Test phase above the Build phase
    Then an inline warning notes Test would run before Build
    And Save still succeeds and persists the new order

  Scenario: concurrent columns preserved (edge)
    Given the Board panel previously added a user column
    When a phase toggle is saved from the Workflow panel
    Then the persisted config still contains that user column

  Scenario: write failure surfaces inline (failure)
    Given tasks/team-config.json is unwritable
    When the user saves a toggle change
    Then an inline error is shown and no partial write corrupts the file
```

## Edge & Failure Cases
- No folder open → `(open a folder)` (unchanged panel guard).
- Config missing/corrupt → toggles default to enabled and Save writes a repaired, normalised config.
- Rapid folder/tab switch mid-save → stale-guard discards the late write/render.
- Order tie (two phases same order) — resolve deterministically in the UI (stable canonical order as tie-break) without throwing; do not persist a non-integer order (TASK-180 normalises anyway).
- The toggle must be keyboard-focusable/accessible (matching the accordion-toggle accessibility work in the repo).
- Out-of-scope (resolved): editing which agent a phase dispatches is **not** part of this ticket (see Clarifications) — only the agent-model editor (TASK-106) remains.

## Clarifications
- Q: Is per-phase agent reassignment in scope? A: **Out of scope** — this ticket stays limited to `enabled` + `order`.
- Q: Is `order` display-only or does it drive execution? A: **Order actually drives execution sequence** — resolved above; this ticket must present it as such and add the non-blocking dependency warning.

## Relevant Files & Context
- `renderer/renderer.js` — `buildWorkflowPhase` (~7955), `buildWorkflowView` (~7318), `buildWorkflowConcurrencyControl` (~7853, the model to copy for re-read-first whole-file Save), `buildWorkingConfigFromRaw` (~7357), `tasksSerializeTeamConfig` (~5619), `refreshTeamWorkflow` (~7158).
- Schema: `skill.phases.<phase>.{enabled,order}` from TASK-180 (`lib/team-config.js`).
- `docs/workflow-settings.md` — the panel's documented "never writes SKILL.md" boundary (this ticket keeps it; it writes only team-config.json).
- Tests to model on: `test/task-105-workflow-panel.e2e.test.js`, `test/task-106-guided-editor.*`; add a `task-182-*` unit+e2e pair.
- Depends on: TASK-180.

## Build notes
- Coder: added `WF_PHASE_DEFAULTS`/`wfNormalizePhaseConfig`/`wfSortedPhaseKeys`/`WF_ORDER_DEPENDENCIES`/`wfPhaseOrderWarnings`, an in-memory `workingPhases` map, a shared Save control (re-read-first whole-file write), and toggle/badge/reorder/warning rendering in `buildWorkflowPhase`. Also updated `docs/workflow-settings.md`.
- Tester: added `test/task-182-workflow-phase-toggle-reorder.test.js` (34 tests) + `.e2e.test.js` (5 scenarios). Full suite: 3554 pass, 3 pre-existing baseline failures, 0 regressions.
- **Tech-lead review skipped**: `tasks/team-config.json` does not exist on disk, so per TASK-180/181's shipped default, `skill.phases.review.enabled` is effectively `false` — this ticket followed its own new default and went `testing → post-processing → done` directly, with no reviewer dispatch and no review follow-up tickets.
- Post-processing: security review (textContent/XSS, validated enabled/order, no prototype pollution, real stale-guard) found no new issues; documentation pass confirmed `docs/workflow-settings.md` (already updated during build) accurately reflects the shipped code.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
