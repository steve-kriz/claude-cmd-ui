---
id: TASK-156
title: Per-project-aware forwarding + IPC wiring for the store-online toggle
status: done
created: 2026-07-27T00:00:00Z
updated: 2026-07-26T23:28:30.000Z
agent: swarm-orch1
---

## Description
Make "store online" forwarding honour each project's OWN store-online toggle
instead of only the app-global `TELEMETRY_FORWARD_ENABLED`, and add the IPC/
preload surface that wires the per-project buckets and per-project config to
the Stats tab (TASK-157).

`scheduleForward` now fans out PER PROJECT bucket on the debounced tick: for
each project bucket with rows, POST a payload built from THAT bucket's
usage/recent — but ONLY when both (a) the app-global master switch is on, and
(b) that project's store-online toggle is enabled. A project whose toggle is
off is skipped even when the app-global switch is on.

## Acceptance Criteria
- [x] `receiver.setProjectForwarding(project, enabled)` records a per-project
      boolean; junk project → `''` key; junk enabled → `false`; never throws.
- [x] The forward tick iterates every project bucket and forwards a per-project
      payload only when the app master switch is on AND that project's toggle
      is enabled.
- [x] A project whose toggle is OFF is not forwarded even when
      `TELEMETRY_FORWARD_ENABLED` is on and a URL is set. VERIFIED by tech-lead
      reading the actual code, not the description.
- [x] When the app master switch is off or `forwardUrl` is empty, NO project is
      forwarded (unchanged master gate).
- [x] Buckets with no rows are not forwarded.
- [x] `telemetry:getUsage` accepts `{ project }` (or a bare project arg) and
      returns `getUsageForProject(project)`; no-arg preserves current return.
- [x] New `telemetry:setProjectConfig` IPC forwards `{ project, storeOnline }`
      to `receiver.setProjectForwarding`; safe/no-op when no receiver exists;
      returns `{ ok: true }`.
- [x] `preload.js` exposes `getUsage(project?)` and
      `setProjectConfig(project, cfg)` on `window.api.telemetry`.
- [x] Forward client stays injectable; forward failures still swallowed.
- [x] Debounce/coalesce behaviour preserved.

## Cucumber Tests
```gherkin
Feature: Per-project-aware telemetry forwarding

  Scenario: Only projects with their toggle on are forwarded
    Given app-global forwarding is enabled with a valid URL
    And project "alpha" store-online is ON and project "beta" is OFF
    And both buckets have rows
    When the forward tick fires
    Then exactly one POST is made, its payload.project is "alpha"
    And no POST is made for "beta"

  Scenario: Master switch off suppresses all projects
    Given app-global forwarding is disabled
    And project "alpha" store-online is ON
    When ingest occurs
    Then no forward POST is made

  Scenario: getUsage returns a single project's bucket
    Given rows in buckets "alpha" and "beta"
    When telemetry:getUsage is invoked with project "alpha"
    Then it returns only alpha's usage and recent

  Scenario: setProjectConfig toggles a project's forwarding
    Given a running receiver
    When telemetry:setProjectConfig { project: "alpha", storeOnline: true } is invoked
    Then the receiver forwards alpha on the next tick (master switch permitting)

  Scenario (edge): Unknown project defaults to not forwarding
    Given app-global forwarding is enabled with a valid URL
    And a bucket "ghost" that never had setProjectForwarding called
    When the forward tick fires
    Then "ghost" is not forwarded (default off)
```

## Relevant Files
- `C:\projects\claude-cmd-ui2\lib\telemetry-receiver.js` — `projectForwarding`
  Map + `setProjectForwarding`; `scheduleForward` fans out per bucket.
- `C:\projects\claude-cmd-ui2\main.js` — `telemetry:getUsage` (project-aware),
  `telemetry:setProjectConfig`.
- `C:\projects\claude-cmd-ui2\preload.js` — `getUsage(project?)`,
  `setProjectConfig(project, cfg)`.
- `C:\projects\claude-cmd-ui2\docs\telemetry.md` — updated to describe
  per-project gating (master switch AND project toggle both required) and the
  now-partially-wired per-project config module.

## Clarifications
- Q: Should a project's forwarding default to OFF until explicitly opted in?
  A: Yes — default off, opt-in per project (user-confirmed during planning).

## Build/Test/Review Notes
- Coder: added `projectForwarding` Map + setter; reworked `scheduleForward` to
  fan out per bucket with the master-AND-toggle gate; added the two IPC
  handlers and preload bridge functions; correctly left one pre-existing test
  for the tester to update (it predated the new opt-in default).
- Tester: fixed the one pre-existing test (added the opt-in call), added 6 new
  e2e scenarios + 13 unit tests, all real-code (no mirrors). Full suite: 3319
  tests, 3315 pass, 3 fail (confirmed pre-existing baseline).
- Tech-lead review: core business rule (toggle-off suppresses even with master
  on) VERIFIED by reading actual code. Project-scoping in `getUsage` confirmed
  not to leak cross-project data. Four follow-ups created:
  - TASK-164 — the new IPC handlers/preload bridge functions have zero direct
    test coverage (only the underlying receiver library is tested).
  - TASK-165 — `projectForwarding` Map is a SECOND unbounded-growth vector
    (via the renderer-facing IPC), distinct from TASK-163's bucket-count issue.
  - TASK-166 — `telemetry:getUsage`'s project-scoped response shape
    (`{usage,recent}`) differs from its no-arg shape
    (`{usage,metricTotals,running,recent}`) — a future consumer (TASK-157)
    could crash reading `metricTotals` on a project-scoped response.
  - TASK-167 — `setProjectForwarding`'s key has no trim while `setActiveProject`
    trims; a future mismatch between the toggle key and the ingest bucket key
    could silently defeat the toggle (relevant to TASK-157's upcoming renderer
    wiring).
- Post-processing: independent security pass found no additional issues
  (storeOnline strictly allowlisted, project type-checked, Map keys immune to
  prototype pollution, handler always try/catch-wrapped). docs/telemetry.md
  updated: "Storing it online" section now describes per-project gating; the
  `lib/telemetry-project-config.js` code-map entry updated to note the
  receiver-side IPC gate is now wired (disk I/O + UI toggle remain for
  TASK-157).

## Additional Context
_(user-owned — leave blank)_
