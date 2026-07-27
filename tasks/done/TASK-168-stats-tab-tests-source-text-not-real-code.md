---
id: TASK-168
title: Stats-tab per-project tests are source-text regex, not real-code execution
status: done
created: 2026-07-26T23:37:06.000Z
updated: 2026-07-27T02:28:30.000Z
agent: swarm-orch1
review-of: TASK-157
---

## Description
Rewrote both Stats-tab test files to genuinely exercise real renderer.js
code, modelled on TASK-162's successful real-invocation precedent. This
resolves the HIGH-severity finding from TASK-157's review — the capstone
test-quality fix for the whole 6-ticket per-project telemetry feature.

## Acceptance Criteria
- [x] Unit tests invoke the REAL config functions, no hand-rolled copies.
- [x] E2E scenarios actually invoke the real `buildTelemetryControl(tab)` for
      all 6 behavioral scenarios — VERIFIED thoroughly and skeptically by
      tech-lead (traced the extraction harness, confirmed no unresolved
      references, confirmed assertions are non-vacuous).
- [x] `folder`/`tab.folder` passed VERBATIM through the tested call chain —
      VERIFIED would genuinely catch a TASK-167-style trim regression (traced
      through what a `.trim()` would break).
- [x] All tests green beyond the known pre-existing baseline failures.

## Cucumber Tests
```gherkin
Feature: Stats-tab per-project behavior is covered against real code

  Scenario: Different projects render different real totals
    Given a mocked window.api.telemetry.getUsage that returns different data
      for folder "alpha" vs folder "beta"
    When the real buildTelemetryControl(tab) is invoked for each tab
    Then the rendered grid values differ between alpha and beta

  Scenario: Checkbox reflects the real config file state on mount
    Given a mocked window.api.fs.readFile returning { storeOnline: true } for
      the project's telemetry-config.json
    When the real buildTelemetryControl(tab) mounts
    Then the "Store online for this project" checkbox is checked

  Scenario: Toggling the checkbox drives both the real write and the real IPC call
    Given the real control is mounted for folder "alpha"
    When the checkbox's real change handler fires with checked = true
    Then window.api.fs.writeFile is called with the correctly serialized config
    And window.api.telemetry.setProjectConfig is called with ("alpha", { storeOnline: true })

  Scenario: Live update filtering is behaviorally real
    Given the real control is mounted for folder "alpha"
    When the real onUpdate handler receives a payload with project "beta"
    Then the displayed totals do not change
    When it then receives a payload with project "alpha"
    Then the displayed totals DO update

  Scenario (edge): Corrupt config defaults to unchecked without throwing
    Given a mocked window.api.fs.readFile returning invalid JSON
    When the real buildTelemetryControl(tab) mounts
    Then the checkbox is unchecked and no exception propagates

  Scenario (edge): No folder open degrades without throwing
    Given a tab with an empty/absent folder
    When the real buildTelemetryControl(tab) / initStatsTab(tab) run
    Then the per-project controls render in a disabled/hidden state
    And no exception is thrown
```

## Relevant Files
- `C:\projects\claude-cmd-ui2\test\task-157-stats-per-project.test.js` —
  rewritten (real config functions).
- `C:\projects\claude-cmd-ui2\test\task-157-stats-per-project.e2e.test.js` —
  rewritten (real buildTelemetryControl mount, extended mock DOM/window.api).
- `C:\projects\claude-cmd-ui2\README.md` — added a nuanced testing-convention
  note (extract-and-invoke when no real export exists, e.g. renderer.js; prefer
  require()-ing real exports when they do, e.g. preload.js).

## Build/Test/Review Notes
- Coder: full rewrite, modelled on TASK-162's real-invocation precedent;
  extended `createMockElement` with event dispatch; wired the previously-dead
  mock scaffolding into a real `buildTelemetryControl` mount.
- Tester: confirmed 44/44 tests genuinely exercise real code with 110+
  meaningful assertions (not just "no throw"). Full suite: 3443 pass, 3 fail
  (confirmed pre-existing baseline).
- Tech-lead review: thorough, skeptical verification — traced the extraction
  harness line by line, confirmed the verbatim-folder test would genuinely
  catch a trim regression, confirmed the live-update filter test is not
  confounded (unlike TASK-165's finding for a different ticket). ONE LOW
  finding: a prototype-poisoning unit-test assertion is vacuous (always true
  regardless of whether the filter works) — filed as TASK-179.
- Post-processing: no security issues (test-only, same established extraction
  pattern as sibling tickets). Added a nuanced testing-convention note to
  README.md distinguishing "extract-and-invoke" (when no real export exists)
  from "require() the real export" (when one does), careful not to contradict
  TASK-175's still-open finding about the extraction technique's fragility.

## Additional Context
_(user-owned — leave blank)_
