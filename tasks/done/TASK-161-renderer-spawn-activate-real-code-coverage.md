---
id: TASK-161
title: spawnTerm/activateTab project-tagging changes verified only by source-text regex
status: done
created: 2026-07-26T22:24:33.000Z
updated: 2026-07-27T00:36:25.000Z
agent: swarm-orch1
review-of: TASK-153
---

## Description
Added a `loadRendererFns(window, document, deps)` helper to
`test/task-153-otel-resource-tags.e2e.test.js` that extracts and evaluates the
REAL `spawnTerm`/`activateTab` functions from renderer.js with injected
collaborators, replacing the prior source-text regex assertions with
real-invocation behavioral tests.

## Acceptance Criteria
- [x] A test invokes the real `spawnTerm` and asserts `window.api.pty.spawn`
      receives `project: <folder>`.
- [x] A test invokes the real `activateTab` with a multi-segment folder path
      and asserts `window.api.telemetry.setActiveProject` receives the FULL
      path, not the leaf — VERIFIED by tech-lead reading the actual extracted
      code and confirming the assertion would catch a leaf-vs-full-path
      regression.
- [x] Existing source-text regex assertions replaced.
- [x] All tests green beyond the known pre-existing baseline failures
      (independently re-confirmed by the orchestrator: 3364/3360/3 stable,
      telemetry-receiver tests re-run twice with 16/16 pass — one reported
      "4th failure" was a transient flake, not a regression).

## Cucumber Tests
```gherkin
Feature: spawnTerm and activateTab project-tagging behavior is covered against real code

  Scenario: spawnTerm passes the real project to the pty spawn call
    Given a mock tab with folder "C:\\projects\\alpha\\sub"
    When the real spawnTerm function is invoked
    Then window.api.pty.spawn is called with spawnOpts.project === "C:\\projects\\alpha\\sub"

  Scenario: activateTab reports the full folder path, not the leaf
    Given a mock tab with folder "C:\\projects\\alpha\\sub"
    When the real activateTab function is invoked
    Then window.api.telemetry.setActiveProject is called with "C:\\projects\\alpha\\sub"
    And NOT with "sub"

  Scenario (edge): A single-segment folder path still reports correctly
    Given a mock tab with folder "C:\\alpha" (leaf and full path nearly identical)
    When the real activateTab function is invoked
    Then window.api.telemetry.setActiveProject is called with "C:\\alpha"
```

## Relevant Files
- `C:\projects\claude-cmd-ui2\renderer\renderer.js` — `spawnTerm`, `activateTab`
  (unchanged; test-only ticket).
- `C:\projects\claude-cmd-ui2\test\task-153-otel-resource-tags.e2e.test.js` —
  new `loadRendererFns` helper + real-invocation tests.

## Build/Test/Review Notes
- Coder: added `loadRendererFns` using the `test/task-135-restart-queue-race.e2e.test.js`
  extraction convention (async-aware `extractFn`); heeded the safety note
  against `git checkout --` given the earlier TASK-160 incident. No dangerous
  git operations this time.
- Tester: verified real-code invocation, added the missing single-segment
  edge-case scenario. Reported a possible 4th "telemetry-receiver" failure,
  which the orchestrator independently investigated and confirmed was a
  transient flake (re-ran full suite: 3364/3360/3 stable; re-ran
  telemetry-receiver.e2e.test.js twice standalone: 16/16 pass both times).
- Tech-lead review: confirmed the extraction genuinely pulls real source (not
  a mirror) and the assertions genuinely distinguish full-path vs. leaf (test
  folder has multiple segments). No security issue. Two LOW findings (duplicate
  `extractRealFn`/`extractFn` implementations; dead `extractHandlerBlock`
  helper) — both folded into the existing TASK-169 follow-up ticket (same test
  file, already being edited there) rather than filing new duplicate tickets.
- Post-processing: independent security pass confirmed clean (test-only eval
  of trusted in-repo source). No doc changes needed.

## Additional Context
_(user-owned — leave blank)_
