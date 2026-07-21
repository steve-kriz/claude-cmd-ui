---
id: TASK-091
title: Team tab scaffold - new sub-tab with Agents / Workflow / Board sections
status: done
created: 2026-07-20T13:15:00Z
updated: 2026-07-20T21:15:58.070Z
order: 2
activities: [{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-20T21:02:32Z","finishedAt":"2026-07-20T21:05:29Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-20T21:04:00Z","finishedAt":"2026-07-20T21:11:29Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-20T21:14:00Z","finishedAt":"2026-07-20T21:15:57Z"}]
---

## Description
Add a new "Team" sub-tab to the workspace tab bar, following the exact pattern of the
seven existing tabs: button, `data-view="team"` panel, `switchSubTab` routing to a new
`initTeamTab(tab)`, and styles. The panel hosts three placeholder sections
(`.teamAgentsSection`, `.teamWorkflowSection`, `.teamBoardSection`) that later tickets
fill. Scaffolding only; no data loading beyond an "(open a folder)" empty state.

## Clarifications
- Q1–Q6 recorded; none change this ticket. The Board section will later host the dynamic-status column manager (TASK-103).

## Acceptance Criteria
- [ ] `renderer/index.html` tab bar (lines 201–209) gains `<button class="tab-btn" data-tab="team">Team</button>` after the Tasks button.
- [ ] A `<div class="tab-view" data-view="team">` panel exists in `.tab-views` with a `.view-toolbar` ("Team") and the three section containers with stable class hooks and visible headings.
- [ ] `renderer/renderer.js` `els` map (lines 327–489) gains selectors for the Team panel elements.
- [ ] `switchSubTab` (line 1211) gains `else if (name === 'team') initTeamTab(tab)`; existing branches and `stopTasksPolling` guard untouched.
- [ ] `initTeamTab(tab)` with no folder shows "(open a folder)" and disables controls; with a folder shows the three sections.
- [ ] Activation toggles `.active` on button/view via the existing loops only.
- [ ] Styles added to `renderer/styles.css` following `.view-toolbar`/`.git-section` conventions; no existing selectors modified.
- [ ] `node --test "test/**/*.test.js"` passes (modulo the known-failing baseline tests).

## Cucumber Tests
```gherkin
Feature: Team sub-tab scaffold
  Scenario: The Team tab exists
    Given the workspace template in renderer/index.html
    Then a tab-btn with data-tab="team" appears after Tasks
    And a tab-view with data-view="team" exists

  Scenario: Activating the Team tab
    Given a workspace with an open folder
    When the user clicks the Team tab
    Then switchSubTab routes "team" to initTeamTab and only the team view is active

  Scenario: No folder open (edge)
    Given a workspace with no folder open
    When the Team tab is activated
    Then "(open a folder)" is shown and no Team controls are enabled
```

## Edge Cases & Failure Paths
- No folder open.
- Re-activation must not double-bind listeners (follow the `initTasksTab` pattern).
- The `data-view="team"` panel must default to hidden (no `active` class).

## Relevant Files & Context
- `renderer/index.html` — tab bar 201–209; tab-views 211–688.
- `renderer/renderer.js` — `els` map 327–489, click wiring 496–498, `switchSubTab` 1211–1238, `initTasksTab` 5661 as the pattern to copy.
- `renderer/styles.css` — `.tab-btn` 240–254, `.view-toolbar` conventions.
- Test pattern: `test/task-030-plan-button.e2e.test.js` (source-scan style).

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
