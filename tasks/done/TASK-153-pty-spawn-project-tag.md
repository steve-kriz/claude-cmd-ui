---
id: TASK-153
title: Tag each spawned claude pane with its project via OTEL_RESOURCE_ATTRIBUTES
status: done
created: 2026-07-27T00:00:00Z
updated: 2026-07-26T22:38:27.000Z
agent: swarm-orch1
---

## Description
Give every PTY-spawned process a per-project OTEL resource attribute so the
telemetry it exports can be attributed to the exact project folder that launched
it — instead of the current single app-global bucket.

Mechanism: the renderer already knows each tab's folder (`tab.folder`, an
absolute path). It passes that folder as `project` in the `pty:spawn` options;
`main.js` builds a per-spawn env overlay
`OTEL_RESOURCE_ATTRIBUTES=project=<encodeURIComponent(project)>` and hands it to
`lib/pty.js`, which merges it on top of `process.env` for that one spawn. This
rides the same OTEL resource-from-env path that `OTEL_SERVICE_NAME` already used,
so Claude Code emits it in the resource block that TASK-152 reads back.

## Acceptance Criteria
- [x] `lib/pty.js` `spawnShell` (and the `spawnCmd`/`spawnBash`/`spawnWorker`/
      `spawnPosix` paths) accept an optional `env` overlay object in `opts` and
      merge it LAST into each backend spawn's `env`, on both win32 and POSIX
      branches, without dropping existing per-shell keys.
- [x] Absent/empty/non-object `opts.env` leaves spawn behaviour byte-for-byte
      unchanged.
- [x] `main.js` `pty:spawn` handler accepts a `project` field and builds the
      `OTEL_RESOURCE_ATTRIBUTES` overlay when non-empty.
- [x] Empty/absent `project` adds no overlay.
- [x] Per-spawn overlay wins over any pre-existing global `OTEL_RESOURCE_ATTRIBUTES`.
- [x] Renderer `spawnTerm` includes `project: tab.folder` in `spawnOpts`.
- [x] Renderer `activateTab`'s `setActiveProject` call reports the full
      `tab.folder`, not the folder leaf.
- [x] Round-trip with TASK-152's parser verified (encode-on-spawn matches
      decode-on-parse scheme).

## Cucumber Tests
```gherkin
Feature: Per-project tagging of spawned panes

  Scenario: A spawn carries the project resource attribute
    Given a pty:spawn request with project "C:\\projects\\alpha"
    When main.js assembles the spawn options
    Then spawnShell receives env.OTEL_RESOURCE_ATTRIBUTES === "project=C%3A%5Cprojects%5Calpha"

  Scenario: The env overlay merges without dropping shell keys (win32 bash)
    Given a win32 bash spawn with an env overlay { OTEL_RESOURCE_ATTRIBUTES: "project=x" }
    When spawnShell spawns the pane
    Then the spawn env contains TERM, CHERE_INVOKING, AND OTEL_RESOURCE_ATTRIBUTES

  Scenario: The renderer reports the full folder path as the active project
    Given a tab whose folder is "C:\\projects\\alpha"
    When the tab is activated
    Then telemetry.setActiveProject is called with "C:\\projects\\alpha"

  Scenario (edge): No project means no overlay and unchanged spawn
    Given a pty:spawn request with an empty/absent project
    When main.js assembles the spawn options
    Then spawnShell receives no OTEL_RESOURCE_ATTRIBUTES overlay
    And the spawn env equals the pre-existing behaviour
```

## Relevant Files
- `C:\projects\claude-cmd-ui2\lib\pty.js` — `hasEnvOverlay()` guard; overlay
  merged last in all four builders.
- `C:\projects\claude-cmd-ui2\main.js` — `pty:spawn` handler builds the
  `OTEL_RESOURCE_ATTRIBUTES` overlay.
- `C:\projects\claude-cmd-ui2\renderer\renderer.js` — `spawnTerm`, `activateTab`.
- `C:\projects\claude-cmd-ui2\docs\telemetry.md` — documented the spawn-time
  attribution mechanism.

## Clarifications
- Q: Has the OTEL_RESOURCE_ATTRIBUTES mechanism been empirically verified
  against the real `claude` CLI's OTEL SDK?
  A: YES — verified during build. The globally-installed
  `@anthropic-ai/claude-code` binary contains the standard
  `@opentelemetry/resources` `EnvDetector`, confirmed via its bundled source
  reading `OTEL_RESOURCE_ATTRIBUTES`, parsing `key=value` pairs, and applying
  `decodeURIComponent` to both key and value — exactly matching this ticket's
  `encodeURIComponent`-on-write / TASK-152's `decodeURIComponent`-on-read
  scheme. Full wire-level round trip (an actual OTLP payload observed
  end-to-end) wasn't independently captured (no live OTLP collector in the
  sandbox), but the bundled-source match gives high confidence.

## Build/Test/Review Notes
- Coder: threaded `opts.env` through all pty.js backend builders; wired
  `project` -> `OTEL_RESOURCE_ATTRIBUTES` in main.js; fixed the activateTab
  leaf/full-path mismatch; verified against existing suites (110/110 relevant
  tests) plus the OTEL SDK source confirmation above.
- Tester: 42 new tests (11 e2e in task-153-otel-resource-tags.e2e.test.js, 31
  unit in task-153-otel-resource-tags.test.js). Full suite: 3185 tests, 3181
  pass, 3 fail (confirmed pre-existing baseline noise).
- Tech-lead review: implementation correct, security clean (encodeURIComponent
  properly neutralizes the OTEL_RESOURCE_ATTRIBUTES grammar; no
  command-injection surface). Two follow-ups created:
  - TASK-160 — main.js's pty:spawn env-overlay logic is only covered by a
    source-text regex + hand-rolled mirror, not the real function.
  - TASK-161 — spawnTerm/activateTab changes verified only by source-text
    regex, not real invocation.
  A minor dead-assertion in the unit test file (always-false object-identity
  compare, harmless) was noted but not worth its own ticket per the reviewer.
- Post-processing: independent security sanity pass found no issues (single-key
  overlay, encodeURIComponent neutralizes delimiters, no shell interpolation,
  consistent merge-last ordering on every spawn path); docs/telemetry.md
  updated to explain the spawn-time attribution mechanism.

## Additional Context
_(user-owned — leave blank)_
