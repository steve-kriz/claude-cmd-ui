---
id: TASK-062
title: Add test proving matchCommand normalizes registry patterns (case-insensitive triggers)
status: done
created: 2026-07-19T18:40:00Z
updated: 2026-07-19T19:22:00Z
---

## Description
Follow-up from the TASK-056 tech-lead review. `matchCommand` in
`lib/slack-commands.js` (~line 63) normalizes BOTH sides of the comparison —
`normalizeCommandInput(pattern) === normalized` — so a registry author may write
trigger phrases in any case/punctuation. That behavior is documented in the
TASK-056 acceptance criteria but is NOT asserted by any test: every pattern in
`test/slack-commands.test.js` and `test/slack-commands.e2e.test.js` is already
lowercase and normalized, so the pattern-side `normalizeCommandInput(pattern)`
call is executed but its effect is never observed. A future refactor to a raw
`pattern === normalized` comparison would drop pattern normalization and leave
the whole suite green while silently breaking the contract TASK-058/059/060
authors rely on.

Add a regression test that pins pattern-side normalization.

## Acceptance Criteria
- [ ] A new test (in `test/slack-commands.test.js` or the e2e file) constructs a
      registry whose command has a MIXED-CASE, whitespace-heavy, punctuated
      pattern (e.g. `patterns: ['  SHOW Me The Tasks?! ']`) and asserts
      `matchCommand('show me the tasks', registry)` returns that command entry.
- [ ] A companion assertion confirms a normalized-input variant with different
      surrounding whitespace/case (e.g. `'Show Me   The Tasks'`) also matches the
      same mixed-case pattern.
- [ ] The test fails if pattern-side normalization is removed (i.e. it would go
      red under a raw `pattern === normalized` comparison) — verify by reasoning
      about the assertion, not by editing source.
- [ ] The full suite still passes under `node --test` (aside from the two known
      pre-existing unrelated failures: the Plan-button scenario and the task-034
      routing-drift-guard unit).

## Cucumber Tests
```gherkin
Feature: Registry patterns are matched case-insensitively

  Scenario: A mixed-case, punctuated pattern matches normalized input
    Given a registry command whose patterns include "  SHOW Me The Tasks?! "
    When matchCommand is called with "show me the tasks"
    Then it returns that command entry

  Scenario: Normalization applies to both input and pattern (edge)
    Given the same registry
    When matchCommand is called with "Show Me   The Tasks"
    Then it returns the same command entry

  Scenario: Dropping pattern normalization would break the contract (regression guard)
    Given a raw `pattern === normalized` comparison hypothetically replaced the code
    Then the mixed-case pattern would no longer match and this test would fail
```

## Edge Cases & Failure Paths
- Pattern with leading/trailing whitespace and trailing punctuation must still
  match normalized input.
- Do not weaken or delete the existing TASK-056 tests; only add coverage.

## Relevant Files & Context
- EDIT `test/slack-commands.test.js` (and/or `test/slack-commands.e2e.test.js`)
  — pins the branch at `lib/slack-commands.js` ~line 63
  (`normalizeCommandInput(pattern) === normalized`).
- READ `lib/slack-commands.js` to confirm the exact matching logic.
- Runner: `node --test`. No source changes — test-only ticket.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
