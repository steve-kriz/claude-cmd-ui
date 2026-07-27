---
id: TASK-165
title: projectForwarding Map is unbounded and growable via renderer-facing IPC
status: done
created: 2026-07-26T23:16:54.000Z
updated: 2026-07-27T01:38:35.000Z
agent: swarm-orch1
review-of: TASK-156
---

## Description
Added a shared `touchLruMap(map, key, maxSize)` helper in
`lib/telemetry-receiver.js`, generalizing TASK-163's `ensureBucket` LRU logic.
Both `ensureBucket` (for `buckets`) and `setProjectForwarding` (for
`projectForwarding`) now call this ONE shared implementation, capped at
`MAX_PROJECT_BUCKETS`/`MAX_PROJECT_FORWARDING` (sibling constants, same
value, intentionally decoupled). This closes the SECOND unbounded-memory
vector — the `projectForwarding` Map reachable via the renderer-facing
`telemetry:setProjectConfig` IPC channel.

## Acceptance Criteria
- [x] `projectForwarding` has a maximum size via the shared helper.
- [x] Overflow evicts the least-recently-set entry (LRU) — VERIFIED correct
      by tech-lead tracing the eviction arithmetic for both callers.
- [x] Legitimate usage unaffected by the cap.
- [x] Test simulates calling `setProjectForwarding` with more distinct
      project values than the cap (though the tech-lead found this
      verification is confounded by the independently-capped `buckets` Map —
      see follow-up TASK-176; the FIX itself is correct, just the test proof
      is weak).
- [x] No behavioral change to `setProjectForwarding`'s junk-input coercion.

## Cucumber Tests
```gherkin
Feature: Bounded projectForwarding Map

  Scenario: Map size never exceeds the cap
    Given setProjectForwarding is called with more distinct project values
      than the configured cap
    When all calls complete
    Then the projectForwarding Map's size never exceeds the cap

  Scenario: Legitimate multi-project usage is unaffected
    Given setProjectForwarding is called for 5 distinct real project folders
    When each project's forwarding state is read back
    Then all 5 are correctly recorded (well under the cap)

  Scenario (edge): Rapid distinct calls never throw
    Given a burst of thousands of setProjectForwarding calls with distinct
      project strings
    When all calls complete
    Then no exception is thrown and the Map remains bounded
```

## Relevant Files
- `C:\projects\claude-cmd-ui2\lib\telemetry-receiver.js` — `touchLruMap`
  shared helper, `MAX_PROJECT_FORWARDING` (exported), `ensureBucket` and
  `setProjectForwarding` both using it.
- `C:\projects\claude-cmd-ui2\test\task-165-projectforwarding-cap.e2e.test.js`,
  `.test.js` (22 new tests).
- `C:\projects\claude-cmd-ui2\docs\telemetry.md` — Security & privacy notes
  updated to describe BOTH capped Maps (buckets + projectForwarding), still
  honestly noting TASK-171 (seenKeys/store) remains open.

## Build/Test/Review Notes
- Coder: extracted the shared `touchLruMap` helper (generalizing TASK-163's
  logic) and applied it to `projectForwarding`; verified via a 250-iteration
  smoke script.
- Tester: 22 new tests; full suite independently re-confirmed by orchestrator
  at 3441/3445/3 (matching baseline).
- Tech-lead review: implementation CORRECT for both callers (touch-existing
  vs new-at-cap arithmetic traced and verified for each), no new security
  issue from sharing the helper. ONE Medium finding: the test verifying the
  `projectForwarding` cap is confounded — it ingests enough distinct projects
  that the INDEPENDENTLY-capped `buckets` Map also evicts, so the test would
  pass even if the `projectForwarding` cap were removed entirely. Filed as
  TASK-176 (test-only issue; the fix itself is sound).
- Post-processing: independent security pass confirmed the fix (not just the
  tests) is sound by re-tracing the eviction arithmetic. docs/telemetry.md's
  Security & privacy notes updated to describe both now-capped Maps while
  keeping the TASK-171 (seenKeys/store) gap honestly documented as still open.

## Additional Context
_(user-owned — leave blank)_
