---
id: TASK-203
title: Remove the Workflow panel and the phase-link machinery from the Team tab
status: done
created: 2026-08-03T09:30:00.000Z
updated: 2026-08-03T14:20:00.000Z
---

## Description
With the phase system retired (TASK-201) and its two surviving controls relocated
into the Board panel (TASK-202), the Team tab's **Workflow** panel and all
phase-link machinery are dead weight. Remove them so the Board panel is the single
board-config panel.

Delete: the `teamWorkflowSection` markup, the panel's refresh/render pipeline
(`refreshTeamWorkflow`, `buildWorkflowView`, `buildWorkflowInstallHint`,
`buildWorkflowPhase` and the phase-card `WF_*` helpers), and the column↔phase
auto-enable helpers (`tasksApplyPhaseAutoEnable`, `tasksPhaseLinkCounts`,
`tasksNormalizeColumnPhase`, `TASKS_PHASE_KEYS`, `TASKS_PHASE_ENABLED_DEFAULTS`,
the `baselinePhaseLinks` snapshot, and the auto-enable call in
`saveTeamBoardConfig`). Remove every els binding / event wiring for
`teamWorkflowBody` / `teamWorkflowRefresh` / its section toggle, and any call to
`refreshTeamWorkflow` on tab activation.

**Keep** `buildWorkflowConcurrencyControl` / `buildWorkflowContextOptimizationControl`
— they are now invoked from the Board panel (TASK-202). Only the phase-specific
render code and the panel shell are deleted.

**Out of scope / follow-up:** `lib/skill-workflow.js` and `lib/skill-section.js`
(the SKILL.md phase parser + guided-editor splicer) become orphaned once the
Workflow panel is gone; leave them in place for a later cleanup so this ticket
stays a bounded renderer/HTML removal. Note them but do not delete them here.

## Acceptance Criteria
- [ ] The `teamWorkflowSection` block is removed from `renderer/index.html` (the Team tab has Agents + Board sections only).
- [ ] `refreshTeamWorkflow`, `buildWorkflowView`, `buildWorkflowInstallHint`, `buildWorkflowPhase`, and all `WF_PHASE_*` / `wfNormalizePhaseConfig` / `wfSortedPhaseKeys` / `wfPhaseOrderWarnings` helpers are removed from `renderer/renderer.js`.
- [ ] The phase-link helpers `tasksApplyPhaseAutoEnable`, `tasksPhaseLinkCounts`, `tasksNormalizeColumnPhase`, `TASKS_PHASE_KEYS`, `TASKS_PHASE_ENABLED_DEFAULTS` are removed; `refreshTeamBoard` no longer computes `baselinePhaseLinks`; `saveTeamBoardConfig` no longer calls `tasksApplyPhaseAutoEnable` (line 6496).
- [ ] All els bindings and event listeners for `teamWorkflowBody`, `teamWorkflowRefresh`, and the Workflow section toggle are removed; nothing calls `refreshTeamWorkflow` anywhere.
- [ ] `buildWorkflowConcurrencyControl` and `buildWorkflowContextOptimizationControl` remain and are still invoked (from the Board panel, TASK-202).
- [ ] Opening the Team tab on a project folder renders Agents + Board with **no console errors** and no reference to a missing Workflow element.
- [ ] SKILL.md presence/absence no longer changes the Team tab (the Workflow install banner is gone); installing the skill is still available elsewhere in the app.
- [ ] No remaining code path reads a column `phase` field or `skill.phases`.

## Cucumber Tests
```gherkin
Feature: Workflow panel removal

  Scenario: the Team tab has no Workflow panel
    Given a project folder is open
    When the user opens the Team tab
    Then only the Agents and Board sections are shown
    And no element with the Workflow panel body exists

  Scenario: board-config settings live only in the Board panel
    Given the Team tab is open
    Then the Build concurrency default and Context optimisation controls appear in the Board panel
    And they do not appear in any Workflow panel

  Scenario: no phase auto-enable runs on Board save
    Given the user edits a column and clicks Save on the Board panel
    When the config is written
    Then no phase link count is computed
    And the written config has no skill.phases

  Scenario: opening the Team tab produces no errors (edge)
    Given a project folder with no SKILL.md installed
    When the user opens the Team tab
    Then the Board and Agents panels render without console errors
    And no Workflow install banner is shown

  Scenario: refreshTeamWorkflow is fully unreferenced (failure guard)
    Given the renderer bundle after this change
    When the source is searched for refreshTeamWorkflow / teamWorkflowBody
    Then there are no remaining references
```

## Edge & failure cases the coder must handle
- A dangling els reference (e.g. `tab.els.teamWorkflowBody`) left after removing the markup would throw on tab activation — every binding must be removed together with the DOM.
- Removing `baselinePhaseLinks` must not break `refreshTeamBoard`'s state shape used by `renderTeamBoard`/`saveTeamBoardConfig`.
- The section-toggle wiring is generic (`team-section-toggle`); ensure removing the Workflow section does not break the Agents/Board toggles.
- Do not delete `buildWorkflowConcurrencyControl` / `buildWorkflowContextOptimizationControl` — they are load-bearing for the Board panel now.
- `lib/skill-workflow.js` / `lib/skill-section.js` must NOT be deleted here (out of scope); if a test imports them it should still pass.

## Relevant files & context
- `C:\projects\claude-cmd-ui2\renderer\index.html` — `teamWorkflowSection` (lines 736–743) to delete; `teamBoardSection` (744–752) stays.
- `C:\projects\claude-cmd-ui2\renderer\renderer.js`:
  - `refreshTeamWorkflow` (8492–8597); `buildWorkflowInstallHint` (8602–8648); `buildWorkflowView` (8656–8783); `buildWorkflowPhase` (9026+).
  - `WF_PHASE_SPECS` (8100), `WF_PHASE_DEFAULTS` (8271), `wfNormalizePhaseConfig` (8284), `wfSortedPhaseKeys`/`wfPhaseOrderWarnings` (~8302–8347), `WF_PHASE_KEYS` (8347).
  - Phase-link mirror: `TASKS_PHASE_KEYS` (5651), `TASKS_PHASE_ENABLED_DEFAULTS` (5657), `tasksNormalizeColumnPhase` (5664), `tasksPhaseLinkCounts` (5694), `tasksApplyPhaseAutoEnable` (5708–5725).
  - `refreshTeamBoard` `baselinePhaseLinks` (6097, 6099); `saveTeamBoardConfig` auto-enable call (6496).
  - els wiring: search `teamWorkflow` for `tab.els.teamWorkflowBody` / `teamWorkflowRefresh` bindings and any `refreshTeamWorkflow(` call sites (e.g. Team-tab activation).
- `C:\projects\claude-cmd-ui2\lib\skill-workflow.js`, `C:\projects\claude-cmd-ui2\lib\skill-section.js` — orphaned after this change; left in place (follow-up cleanup).
- Tests under `C:\projects\claude-cmd-ui2\test\` referencing the Workflow panel / phase UI will need removal or adjustment.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
