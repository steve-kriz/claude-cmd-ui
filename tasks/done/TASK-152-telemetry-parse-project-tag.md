---
id: TASK-152
title: Carry a per-project tag on each parsed telemetry row (lib/telemetry.js)
status: done
created: 2026-07-27T00:00:00Z
updated: 2026-07-26T22:13:26.000Z
agent: swarm-orch1
---

## Description
This is the FOUNDATION ticket for real per-project telemetry attribution. Today
`lib/telemetry.js` parses Claude Code's OTLP/JSON exports into per-call usage
rows, but it drops the OTLP `resource` block entirely — `extractApiRequests`
iterates `resourceLogs[].scopeLogs[].logRecords[]` and never reads
`resourceLogs[].resource.attributes`. As a result every row is app-global with no
project identity.

Change the pure parser so each parsed `api_request` row carries a `project`
string taken from the OTLP resource attributes. The agreed resource attribute key
is `project` and its value is the spawning tab's ABSOLUTE folder path (this is the
canonical project id used across TASK-153/154/155/156/157). TASK-153 injects that
attribute at spawn time via `OTEL_RESOURCE_ATTRIBUTES`; this ticket makes the
parser read it back out. Because `OTEL_RESOURCE_ATTRIBUTES` values are transported
as W3C-Baggage-style `key=value` pairs, the value MAY arrive percent-encoded
depending on Claude Code's OTEL SDK — so parsing must accept the raw value and,
best-effort, percent-decode it (try/catch, never throw) so the decoded project id
matches the folder path TASK-155/157 key their config file on.

Attribution decision to record here (so TASK-154 does not re-litigate): the new
`project` field on each row is the REAL attribution source. The receiver's
existing app-global `activeProject`/`setActiveProject` mechanism is NO LONGER used
to attribute rows — it survives only as the "which project's bucket does the Stats
tab default to" selector (see TASK-154/156).

## Acceptance Criteria
- [x] `extractApiRequests` reads `resourceLogs[].resource.attributes` (via the
      existing `attrsToObject`) and adds a `project` string field to every row it
      returns, in addition to all existing fields.
- [x] The `project` value is read from the resource attribute named `project`;
      when that attribute is absent/empty/non-string the row's `project` is `''`.
- [x] The `project` value is best-effort percent-decoded (`decodeURIComponent`
      inside try/catch); if decoding throws, the raw string value is used instead.
      Decoding never throws out of `extractApiRequests`.
- [x] Rows under different `resourceLogs` entries with different resource
      `project` attributes are tagged with their OWN project.
- [x] A record whose resource block is missing / not an object / has no
      attributes array yields `project: ''` and still parses all other fields.
- [x] `requestKey(row)` is UNCHANGED; `project` does not participate in the
      de-dup key.
- [x] `buildForwardPayload` continues to emit the top-level `project` field it
      already emits (no schema bump; `telemetry.usage.v1` unchanged).
- [x] The module still requires nothing from Electron/DOM/disk/network and no
      function throws on null/partial/hostile input.

## Cucumber Tests
```gherkin
Feature: Per-project tag on parsed telemetry rows

  Scenario: A row inherits the project from its OTLP resource attribute
    Given an OTLP logs payload whose resourceLogs[0].resource.attributes
      contains { key: "project", value: { stringValue: "C:\\projects\\alpha" } }
      and one claude_code.api_request logRecord
    When extractApiRequests parses the payload
    Then the returned row has project === "C:\\projects\\alpha"
    And all existing fields (requestId, model, costUsd, ...) are still populated

  Scenario: A percent-encoded project value is decoded
    Given a resource "project" attribute value of "C%3A%5Cprojects%5Calpha"
    When extractApiRequests parses the payload
    Then the returned row has project === "C:\\projects\\alpha"

  Scenario: Two resource blocks tag their own rows
    Given a payload with two resourceLogs entries whose resource "project"
      attributes are "proj-a" and "proj-b", each with one api_request record
    When extractApiRequests parses the payload
    Then one row has project "proj-a" and the other has project "proj-b"

  Scenario (edge): Missing resource block yields an empty project, not a throw
    Given an api_request record whose resourceLogs entry has no resource key
    When extractApiRequests parses the payload
    Then the row has project === ""
    And no exception is thrown

  Scenario (edge): A malformed percent-encoded value falls back to the raw string
    Given a resource "project" attribute value of "100%bad%"
    When extractApiRequests parses the payload
    Then the row's project equals the raw "100%bad%" string
    And no exception is thrown
```

## Relevant Files
- `C:\projects\claude-cmd-ui2\lib\telemetry.js` — `extractApiRequests` now
  computes `project` per `resourceLogs` entry via new helpers `resourceProject(rl)`
  and `decodeAttrValue(v)` (both exported). `requestKey`/`buildForwardPayload`
  left untouched.
- `C:\projects\claude-cmd-ui2\test\telemetry.test.js`,
  `C:\projects\claude-cmd-ui2\test\task-152-project-tag.e2e.test.js`.
- `C:\projects\claude-cmd-ui2\docs\telemetry.md` — "What is captured" section
  updated to mention the new `project` field.

## Clarifications
- Q: The OTEL_RESOURCE_ATTRIBUTES-based attribution mechanism hasn't been
  empirically verified against the real `claude` CLI's OTEL SDK — what if it
  ignores/strips custom resource attributes?
  A: Proceed with this design; TASK-153 verifies the round-trip empirically
  during its own implementation.

## Build/Test/Review Notes
- Coder: added `decodeAttrValue`/`resourceProject` helpers; verified via ad-hoc
  script and existing 35 telemetry tests all still passing.
- Tester: 72 new tests (16 e2e in task-152-project-tag.e2e.test.js, 56 unit
  extending telemetry.test.js), all green. Full suite 3143 tests, 3139 pass, 3
  fail (confirmed pre-existing baseline noise).
- Tech-lead review: CLEAN, no findings. Confirmed decodeURIComponent never
  crashes the receiver (wrapped, and handleRequest has its own try/catch besides);
  no prototype-pollution/injection surface. One informational (non-blocking) note
  passed to TASK-157: when rendering a project label in the Stats tab UI, use
  textContent, not innerHTML, since the project string originates from an OTLP
  payload.
- Post-processing: independent security sanity pass found no issues;
  docs/telemetry.md's "What is captured" section updated to mention the new
  `project` field (distinguished from the pre-existing forward-payload `project`
  field).

## Additional Context
_(user-owned — leave blank)_
