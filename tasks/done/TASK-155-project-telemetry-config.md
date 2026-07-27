---
id: TASK-155
title: Durable per-project telemetry config file for the store-online toggle
status: done
created: 2026-07-27T00:00:00Z
updated: 2026-07-26T22:53:42.000Z
agent: swarm-orch1
---

## Description
Add a durable, per-project on/off switch for online forwarding ("store online").
Global forwarding config (URL / token / port / master enable) STAYS app-level in
`.env` (unchanged); only the per-project on/off switch is new and per-project.

Uses a NEW file `tasks/telemetry-config.json` inside each project folder (NOT a
key inside `tasks/team-config.json`). Pure, Electron-free
`lib/telemetry-project-config.js` modelled on `lib/team-config.js` (junk-tolerant,
never throws, `warnings` list, unsafe-key guard, `serialize` ends with a trailing
newline). Config shape: `{ "version": 1, "storeOnline": false }`.

Default: `storeOnline` defaults to `false` (opt-in).

## Acceptance Criteria
- [x] New module `lib/telemetry-project-config.js` exports at least
      `defaultProjectTelemetryConfig()`, `normalizeProjectTelemetryConfig(raw)`,
      and `serializeProjectTelemetryConfig(cfg)`; requires nothing from Electron/
      DOM/disk/network.
- [x] `defaultProjectTelemetryConfig()` returns `{ version: 1, storeOnline: false }`.
- [x] `normalizeProjectTelemetryConfig` accepts an object OR a JSON string OR junk
      and always returns a complete, valid config with a `warnings` array; never
      throws.
- [x] `storeOnline` coerced to a strict boolean (`true`/`"true"`/`1` -> true).
- [x] `version` keeps a positive integer as-is, resets to 1 otherwise.
- [x] Unknown top-level keys round-trip except prototype-poisoning keys, which
      are dropped.
- [x] `serializeProjectTelemetryConfig` normalizes, strips `warnings`, 2-space
      JSON, trailing newline.
- [x] File path contract `<projectFolder>/tasks/telemetry-config.json`
      documented in the module header.

## Cucumber Tests
```gherkin
Feature: Per-project telemetry config normalization

  Scenario: Defaults for a brand-new project
    When defaultProjectTelemetryConfig() is called
    Then it returns { version: 1, storeOnline: false }

  Scenario: A stored storeOnline true round-trips
    Given the raw object { version: 1, storeOnline: true }
    When normalizeProjectTelemetryConfig parses it
    Then storeOnline is true and warnings is empty

  Scenario: A JSON string is parsed
    Given the string '{"storeOnline":"true"}'
    When normalizeProjectTelemetryConfig parses it
    Then storeOnline is true

  Scenario: Serialize is valid, warning-free, newline-terminated
    Given any config
    When serializeProjectTelemetryConfig is called
    Then the output is valid JSON with no "warnings" key and ends with "\n"

  Scenario (edge): Hostile input never throws
    Given the input null, then 42, then [1,2], then '{bad json'
    When normalizeProjectTelemetryConfig parses each
    Then each returns a complete default config with warnings and never throws

  Scenario (edge): A __proto__ key is dropped, not round-tripped
    Given the JSON string '{"storeOnline":true,"__proto__":{"x":1}}'
    When normalizeProjectTelemetryConfig parses it
    Then the result has no polluted prototype and storeOnline is true
```

## Relevant Files
- `C:\projects\claude-cmd-ui2\lib\telemetry-project-config.js` — new module.
- `C:\projects\claude-cmd-ui2\docs\telemetry.md` — Code map entry added, noting
  the module is not yet wired (no IPC/UI/disk I/O — lands in TASK-156/157).

## Clarifications
- Q: Should a project's forwarding default to OFF until explicitly opted in?
  A: Yes — default off, opt-in per project (user-confirmed during planning).

## Build/Test/Review Notes
- Coder: created lib/telemetry-project-config.js modelled on team-config.js;
  manually verified hostile inputs, prototype-pollution guard, round-trip
  behavior.
- Tester: 84 new tests (26 e2e, 58 unit), all import and call the real exports.
  Full suite: 3272 tests, 3268 pass, 3 fail (confirmed pre-existing baseline).
- Tech-lead review: CLEAN, no findings. Specifically stress-tested the
  prototype-pollution guard (shallow-copy only, all 3 unsafe keys covered,
  defense-in-depth on serialize too) and confirmed tests call real functions,
  not a mirror.
- Post-processing: independent security pass confirmed clean; docs/telemetry.md
  Code map updated with a forward-looking note (module exists but isn't wired
  into the app yet).

## Additional Context
_(user-owned — leave blank)_
