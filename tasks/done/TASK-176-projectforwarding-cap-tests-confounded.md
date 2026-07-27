---
id: TASK-176
title: projectForwarding cap tests are confounded by the buckets cap, don't actually verify the fix
status: done
created: 2026-07-27T01:28:56.000Z
updated: 2026-07-27T03:09:34.951Z
review-of: TASK-165
resolution: wont-do
---

## Description
Tech-lead review of TASK-165 found that no test genuinely exercises the
`projectForwarding` bound TASK-165 added. Since `projectForwarding` isn't
directly exported, the tester attempted to verify it indirectly through
forwarding behavior, but the key e2e test
("Oldest project-forwarding entry is evicted",
`test/task-165-projectforwarding-cap.e2e.test.js` lines ~191-237) is
CONFOUNDED: it sets `MAX_PROJECT_FORWARDING + 1` (101) toggles AND ingests 101
distinct projects, so the `buckets` Map (independently capped at
`MAX_PROJECT_BUCKETS`, same value) ALSO evicts the oldest project's bucket —
meaning `scheduleForward` never even considers that project regardless of
whether the `projectForwarding` cap exists at all. The assertion
`!forwardedProjects.has('lru-proj-0')` would pass identically whether or not
`touchLruMap`/`MAX_PROJECT_FORWARDING` were removed from `setProjectForwarding`
entirely.

Additionally, several unit tests in `test/task-165-projectforwarding-cap.test.js`
(e.g. "respects the cap boundary...", "Rapid same-project toggling...") end
in a bare `assert.ok(true)` and assert nothing meaningful about the cap.

## Impact If Not Fixed
The DoS guard TASK-165 added (bounding `projectForwarding` against a
renderer-IPC-driven memory-growth attack) has no real regression test. A
later refactor could silently strip the `projectForwarding` cap — reopening
the exact vulnerability TASK-165 fixed — and it would ship completely
undetected with a fully green suite.

## Acceptance Criteria
- [ ] Rewrite the confounded eviction test so it genuinely isolates the
      `projectForwarding` cap from the `buckets` cap — e.g. set
      `MAX_PROJECT_FORWARDING + 1` toggles, but then ingest a log for ONLY the
      supposedly-evicted project (so its BUCKET exists with 1 entry, not
      bucket-evicted) and assert it does NOT forward because its toggle was
      LRU-evicted — proving the `projectForwarding` cap specifically, not a
      side effect of the bucket cap.
- [ ] Alternative/complementary approach: add a test-only way to introspect
      `projectForwarding`'s size (e.g. an internal/test-only accessor, or
      structure the test to use a smaller custom cap if the receiver factory
      supports an override) so the cap can be asserted directly rather than
      only through confounded forwarding behavior.
- [ ] Replace the bare `assert.ok(true)` placeholder assertions in
      `test/task-165-projectforwarding-cap.test.js` with real assertions about
      cap/eviction behavior.
- [ ] All tests green under `node --test` beyond the known pre-existing
      baseline failures.

## Cucumber Tests
```gherkin
Feature: projectForwarding cap is verified independently of the buckets cap

  Scenario: An evicted project-forwarding toggle stops forwarding even with an intact bucket
    Given MAX_PROJECT_FORWARDING + 1 distinct projects have had their toggle set
    And ONLY the oldest project's bucket is populated (not itself evicted)
    When the forward tick fires
    Then the oldest project's toggle was LRU-evicted and it does NOT forward
    And this proves the projectForwarding cap specifically, not the buckets cap
```

## Relevant Files
- `C:\projects\claude-cmd-ui2\test\task-165-projectforwarding-cap.e2e.test.js`
  — the confounded eviction test (~lines 191-237).
- `C:\projects\claude-cmd-ui2\test\task-165-projectforwarding-cap.test.js` —
  the bare `assert.ok(true)` placeholder tests.
- `C:\projects\claude-cmd-ui2\lib\telemetry-receiver.js` — `touchLruMap`,
  `projectForwarding`, `buckets`, `setProjectForwarding`, `ensureBucket`.

## Additional Context
_(user-owned — leave blank)_
