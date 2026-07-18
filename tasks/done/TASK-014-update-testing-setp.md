---
id: TASK-014
title: update testing setp
status: done
created: 2026-07-18T09:58:34.585Z
updated: 2026-07-18T10:33:20.000Z
startedAt: 2026-07-18T10:26:09.000Z
finishedAt: 2026-07-18T10:33:20.000Z
attempts: 1
runs: [{"at":"2026-07-18T10:33:20.000Z","startedAt":"2026-07-18T10:26:09.000Z","finishedAt":"2026-07-18T10:33:20.000Z","minutes":7.18}]
---

## Description
Update the orchestrate workflow's test phase so it **always** produces **both** e2e cucumber/gherkin-style tests **and** unit tests for every built ticket. Today `.claude/skills/orchestrate/SKILL.md` (Phase 3) and `.claude/agents/tester.md` mention both kinds, but neither makes producing both *mandatory and verified* before a ticket can pass. Because this repo has no `cucumber` npm package, "e2e cucumber tests" means scenario-style `node:test` cases written in Given/When/Then form that implement the ticket's Gherkin scenarios (the project test runner is `node --test`). Strengthen the tester instructions in the skill and agent so a ticket cannot reach `done` unless both test kinds exist, both implement the ticket's acceptance criteria/Gherkin, and both were run green. This ticket edits documentation/instruction files only — no product code.

## Acceptance Criteria
- [x] `.claude/skills/orchestrate/SKILL.md` Phase 3 states that the tester must produce **both** e2e cucumber-style tests **and** unit tests, and that a ticket may only reach `done` when both exist and pass.
- [x] `.claude/skills/orchestrate/SKILL.md` clarifies that "e2e cucumber tests" are scenario-style `node --test` cases written in Given/When/Then form (no `cucumber` npm dependency is required or added).
- [x] `.claude/skills/orchestrate/SKILL.md` requires the e2e scenarios to cover **every** acceptance criterion / Gherkin scenario in the ticket, including at least one failure/edge path.
- [x] `.claude/agents/tester.md` restates that both test kinds are mandatory deliverables and that the tester reports which files contain the e2e tests and which contain the unit tests.
- [x] `.claude/agents/tester.md` and the skill state that "All green" requires both the e2e and unit tests to have actually run under `node --test` and passed; missing either kind counts as a failure that returns the ticket to `failed-testing`.
- [x] The updated text keeps the existing rule that ALL database calls are mocked (no real DB connections) and does not remove any existing tester responsibility.
- [x] No source/product files and no `package.json` dependencies are changed by this ticket (instruction files only). (Bundled `assets/` copies synced to satisfy the drift-guard tests.)

## Cucumber Tests
```gherkin
Feature: Test phase mandates both e2e cucumber and unit tests

  Scenario: Skill Phase 3 requires both test kinds to pass before done
    Given the file ".claude/skills/orchestrate/SKILL.md"
    When I read its Phase 3 (Test) section
    Then it states the tester must produce both e2e cucumber-style tests and unit tests
    And it states a ticket may only reach "done" when both kinds exist and pass

  Scenario: Skill defines e2e cucumber tests as node:test Given/When/Then cases
    Given the file ".claude/skills/orchestrate/SKILL.md"
    When I read its Phase 3 (Test) section
    Then it clarifies e2e cucumber tests are scenario-style "node --test" cases in Given/When/Then form
    And it states no cucumber npm package is required or added

  Scenario: e2e scenarios must cover every criterion plus an edge path
    Given the file ".claude/skills/orchestrate/SKILL.md"
    When I read its Phase 3 (Test) section
    Then it requires the e2e scenarios to cover every acceptance criterion
    And it requires at least one failure or edge scenario

  Scenario: Tester agent lists both deliverables and reports their files
    Given the file ".claude/agents/tester.md"
    When I read it
    Then it lists both e2e cucumber tests and unit tests as mandatory deliverables
    And it requires the tester to report which files hold the e2e tests and which hold the unit tests

  Scenario: DB-mock rule is preserved
    Given the file ".claude/agents/tester.md"
    When I read it
    Then it still requires all database calls to be mocked with no real DB connections

  Scenario Outline: Missing a test kind fails the ticket (edge)
    Given a built ticket whose tester only produced "<present>" tests
    When the test phase evaluates completeness
    Then the ticket is treated as failed and returned to "failed-testing"
    And it is not marked "done"

    Examples:
      | present |
      | unit    |
      | e2e     |

  Scenario: No product code or dependencies are changed (edge)
    Given the diff for this ticket
    When I inspect which files changed
    Then only ".claude/skills/orchestrate/SKILL.md" and/or ".claude/agents/tester.md" are modified
    And no source files and no package.json dependencies are changed
```

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
