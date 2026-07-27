---
id: TASK-170
title: Redundant source-text-regex tests in task-162-telemetry-scope-consistency
status: done
created: 2026-07-27T00:45:38.000Z
updated: 2026-07-27T02:31:10.822Z
review-of: TASK-162
resolution: wont-do
---

## Description
Tech-lead review of TASK-162 found that the first two tests in
`test/task-162-telemetry-scope-consistency.e2e.test.js` ("Re-verification:
refresh() always calls telemetry.getUsage(folder)..." and "Re-verification:
the onUpdate handler filters by payload.project === folder") are brittle
source-text-regex assertions matching the literal formatting of
`buildTelemetryControl`'s source, rather than behavioral tests. The SAME
guarantees are already covered meaningfully by the third test in the same
file (a real-invocation test using a real `createTelemetryReceiver` instance),
making tests 1-2 redundant.

## Impact If Not Fixed
Low — discretionary cleanup, not a functional gap (the real behavioral
coverage exists in test 3 of the same file). Any harmless reformatting of
`buildTelemetryControl` (whitespace, reordering boolean conditions, renaming a
local) would break tests 1-2 even when behavior is unchanged, causing
false-failure churn and eroding trust in the suite over time.

## Acceptance Criteria
- [ ] Remove (or replace with a genuinely distinct behavioral assertion) the
      two source-text-regex "Re-verification" tests in
      `test/task-162-telemetry-scope-consistency.e2e.test.js`, since their
      guarantees are already covered by the file's real-invocation test.
- [ ] Confirm no unique coverage is lost by removing them (the real-invocation
      test must still catch a regression where `onUpdate` stops filtering by
      project, or `refresh()` starts calling a no-arg `getUsage()`).
- [ ] All tests green under `node --test` beyond the known pre-existing
      baseline failures.

## Cucumber Tests
```gherkin
Feature: Scope-consistency tests are behavioral, not source-text matches

  Scenario: Removing the redundant regex tests loses no real coverage
    Given the real-invocation test in the same file
    When a regression is simulated (e.g. onUpdate stops filtering by project)
    Then the real-invocation test still fails, proving it alone is sufficient
```

## Relevant Files
- `C:\projects\claude-cmd-ui2\test\task-162-telemetry-scope-consistency.e2e.test.js`
  — the two regex tests to remove/replace (near the top of the file), and the
  real-invocation test (test 3) that already covers the same ground.

## Additional Context
_(user-owned — leave blank)_
