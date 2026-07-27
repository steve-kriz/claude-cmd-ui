---
id: TASK-157
title: Stats tab shows per-project usage and a per-project store-online toggle
status: done
created: 2026-07-27T00:00:00Z
updated: 2026-07-26T23:51:53.000Z
agent: swarm-orch1
---

## Description
Rescoped the Stats tab from app-global figures (identical on every tab) to the
CURRENT project's telemetry, and added a per-project "store online" toggle
control inline on that tab. `buildTelemetryControl(tab)` (was arg-less) now
scopes all reads to `tab.folder`. This is the FINAL ticket of the 6-ticket
per-project telemetry feature (TASK-152 through TASK-157).

## Acceptance Criteria
- [x] `initStatsTab(tab)` passes the project into the telemetry control
      builder; the builder scopes all reads to that project.
- [x] Opening Stats on project A and project B shows DIFFERENT totals.
- [x] The live `onUpdate` handler updates the grid only for matching `project`.
- [x] "Store online for this project" checkbox reflects persisted
      `storeOnline` from `<tab.folder>/tasks/telemetry-config.json` on mount.
- [x] Toggling the checkbox writes the config AND calls
      `setProjectConfig(tab.folder, { storeOnline })`.
- [x] App-global capture/forward/token/master-enable controls remain, with
      clarified copy.
- [x] Stats toolbar status text no longer claims "app-wide" for per-project
      figures.
- [x] No folder open degrades gracefully.
- [x] `telemetryUnsub` detach-before-resubscribe pattern preserved.
- [x] All project labels use `textContent`, never `innerHTML` — VERIFIED by
      tech-lead.
- [x] `tab.folder` passed VERBATIM (no trim/normalization) to both
      `getUsage`/`setProjectConfig` — VERIFIED by tech-lead, avoiding the
      TASK-167 risk.

## Cucumber Tests
```gherkin
Feature: Per-project Stats tab

  Scenario: Stats shows the focused project's usage
    Given project "alpha" has usage and project "beta" has different usage
    When the Stats tab is opened on alpha then on beta
    Then alpha's totals differ from beta's totals

  Scenario: The store-online checkbox reflects the project's config file
    Given tasks/telemetry-config.json for the project has storeOnline true
    When the Stats tab mounts
    Then the "Store online for this project" checkbox is checked

  Scenario: Toggling the checkbox persists and pushes to the receiver
    Given the Stats tab is mounted for a project
    When the user checks "Store online for this project"
    Then telemetry-config.json is written with storeOnline true
    And telemetry.setProjectConfig is called with that project and { storeOnline: true }

  Scenario: Live updates are filtered by project
    Given the Stats tab is mounted for project "alpha"
    When an onUpdate payload arrives with project "beta"
    Then the alpha grid does not change

  Scenario (edge): No folder open disables the per-project controls
    Given a tab with no folder
    When the Stats tab is opened
    Then the per-project controls are disabled/hidden with an "open a folder" note
    And no exception is thrown

  Scenario (edge): A corrupt telemetry-config.json defaults to unchecked
    Given tasks/telemetry-config.json contains invalid JSON
    When the Stats tab mounts
    Then the checkbox is unchecked and no error is shown to the user
```

## Relevant Files
- `C:\projects\claude-cmd-ui2\renderer\renderer.js` — `initStatsTab`,
  `buildTelemetryControl(tab)`, `tasksDefaultProjectTelemetryConfig`,
  `tasksNormalizeProjectTelemetryConfig`, `tasksSerializeProjectTelemetryConfig`.
- `C:\projects\claude-cmd-ui2\renderer\index.html` — `.statsStatus` default
  text.
- `C:\projects\claude-cmd-ui2\renderer\styles.css` — `.team-telemetry-scope`,
  `.team-telemetry-project`.
- `C:\projects\claude-cmd-ui2\docs\telemetry.md` — corrected 4 now-stale
  "app-global/same-figures-everywhere" claims across the file now that the
  whole feature has landed.

## Clarifications
- Q: Should the app-global forward URL/token/master-enable controls stay on
  the Stats tab?
  A: Keep them on the Stats tab, relabelled (user-confirmed during planning).
- Q: Should the cumulative metric-snapshot cross-check also be shown per
  project?
  A: No — stays app-wide (see TASK-154's clarification).

## Build/Test/Review Notes
- Coder: rescoped `buildTelemetryControl` to `tab.folder`; added renderer-side
  config mirror functions (renderer can't require() Node libs); wired the
  checkbox to both fs.writeFile and setProjectConfig; filtered onUpdate by
  project; used textContent throughout; correctly flagged the pre-existing
  test-147 assertions needing an update (direct consequence of the signature
  change).
- Tester: fixed the 2 pre-existing test-147 assertions, added 52 new tests
  across 2 new files. Full suite: 3362 tests, 3358 pass, 3 fail (confirmed
  pre-existing baseline).
- Tech-lead review: implementation verified correct and secure — textContent
  used everywhere for project data (no XSS sink), `tab.folder` passed
  verbatim through the entire chain with no normalization mismatch (avoiding
  the TASK-167 risk this ticket was explicitly warned about), renderer-side
  config mirror has a working prototype-pollution guard matching the real lib
  module. ONE HIGH finding: both new test files are source-text regex /
  hand-rolled copies, never actually invoking the real renderer functions —
  filed as TASK-168 (the same recurring pattern as TASK-158/160/161, but here
  covering the highest-risk surface since it's the user-facing capstone of the
  whole 6-ticket feature). A minor (deferred, no ticket) divergence: the
  renderer's config mirror doesn't strip a `warnings` key on round-trip like
  the real lib does — unreachable in the current flow since nothing persists
  that key.
- Post-processing: independent security pass confirmed no path-traversal risk
  (all fs IPC calls go through `lib/fs-roots.js`'s root-confinement check
  regardless of what `tab.folder` contains) and no traversal surface in
  `setProjectConfig` (in-memory Map only, no disk I/O). docs/telemetry.md
  updated in 4 places to remove now-false "one app-global figure shown
  everywhere" claims, reflecting the complete per-project feature.

## Additional Context
_(user-owned — leave blank)_
