---
id: TASK-010
title: enable agents
status: done
created: 2026-07-18T05:26:19.135Z
updated: 2026-07-18T06:31:14Z
---

## Description
Create dedicated subagent definitions for the three orchestration roles —
business analyst (BA), coder, and tester — and update the orchestration so each
phase dispatches to its own agent type instead of the generic `general-purpose`
agent. Claude Code reads subagent definitions from `.claude/agents/*.md` (YAML
frontmatter with `name`, `description`, `tools`, optional `model`), and the
orchestrate skill lives at `.claude/skills/orchestrate/SKILL.md`. Today all three
phases in `SKILL.md` launch `general-purpose` subagents (Phase 1 Plan/Define,
Phase 2 Build, Phase 3 Test), and no `.claude/agents/` folder exists yet.

The change must apply in two places so a freshly started terminal works as
described. The in-project copy is `.claude/skills/orchestrate/SKILL.md` plus new
`.claude/agents/` files. The installed/bundled source is
`assets/skills/orchestrate/SKILL.md`, which `tasks:installSkill` (main.js) copies
into a project's `.claude/skills/orchestrate/` on open; that install step must
also propagate the agent definitions into the project's `.claude/agents/`.
Parallel multi-agent builds must keep obeying the concurrency rules in
`lib/ticket-queue.js` (`DEFAULT_CONCURRENCY = 3`, `MAX_CONCURRENCY = 8`,
`selectNextBatch`, `claimTicket`, per-ticket claim + git isolation).

## Acceptance Criteria
- [x] Three subagent definition files exist under the project's `.claude/agents/` — one BA, one coder, one tester (e.g. `ba.md`, `coder.md`, `tester.md`) — each with valid Claude Code agent frontmatter (`name`, `description`, `tools`, optionally `model`).
- [x] The agents' tools/scope match their roles: the BA agent does no implementation writing (planning/defining only — read/search tools, no code edits); the coder agent has edit/write/bash tools for implementation; the tester agent is scoped to writing and running tests.
- [x] `.claude/skills/orchestrate/SKILL.md` dispatches each phase to the matching agent type by name instead of `general-purpose`: Phase 1 (Plan/Define) → the BA agent, Phase 2 (Build) → the coder agent, Phase 3 (Test) → the tester agent.
- [x] The bundled/installed source carries the same change: `assets/skills/orchestrate/SKILL.md` references the three agent types, the agent definition files are bundled under `assets/`, and `tasks:installSkill` (main.js) copies the agent definitions into the opened project's `.claude/agents/` (in addition to `.claude/skills/orchestrate/`).
- [x] After `tasks:installSkill` runs against a fresh project, that project contains the updated `SKILL.md` and all three agent definition files, so a newly started terminal uses the dedicated agents.
- [x] The project `.claude/skills/orchestrate/SKILL.md` and the bundled `assets/skills/orchestrate/SKILL.md` reference the same three agent types with no drift.
- [x] Parallel multi-agent builds still honor the concurrency rules in `lib/ticket-queue.js`: bounded concurrency (default 3), one-agent-per-ticket claims (`claimTicket`), and per-ticket git isolation (`ticketBranchName` / `ticketWorktreeDir`) are unchanged by routing work to dedicated agent types.
- [x] Edge case: if a referenced agent definition is missing at dispatch time, the orchestrator falls back gracefully (e.g. to `general-purpose`) and continues the run rather than aborting, and reports which agent was missing.

## Cucumber Tests
```gherkin
Feature: Dedicated orchestration subagents

  Scenario: Three agent definitions exist in the project
    When the project's .claude/agents/ folder is inspected
    Then a BA agent definition file exists
    And a coder agent definition file exists
    And a tester agent definition file exists
    And each has valid agent frontmatter with name, description, and tools

  Scenario: Agent tools match their roles
    When the agent definitions are inspected
    Then the BA agent has no code-editing tools
    And the coder agent has edit, write, and bash tools
    And the tester agent is scoped to writing and running tests

  Scenario: The skill dispatches each phase to its agent
    When the orchestrate SKILL.md is inspected
    Then Phase 1 (Plan/Define) dispatches to the BA agent type
    And Phase 2 (Build) dispatches to the coder agent type
    And Phase 3 (Test) dispatches to the tester agent type
    And no phase still dispatches to a generic general-purpose agent

  Scenario: The change is present in the bundled source
    When assets/skills/orchestrate/SKILL.md is inspected
    Then it references the same three agent types as the project skill
    And the three agent definitions are bundled under assets/

  Scenario: Installing the skill propagates agents to a fresh project
    Given an empty project folder
    When tasks:installSkill runs against it
    Then the project has .claude/skills/orchestrate/SKILL.md with the three agent types
    And the project has BA, coder, and tester agent definition files under .claude/agents/

  Scenario: Project and bundled skills stay in sync
    When both SKILL.md copies are compared
    Then they reference the same three agent types with no drift

  Scenario: Parallel builds still obey the concurrency rules
    Given four claimable tickets and a concurrency limit of 3
    When the build loop dispatches work to the dedicated agents
    Then at most 3 tickets are in-progress or testing at once
    And no ticket is claimed by more than one agent
    And each build runs in its own per-ticket branch/worktree

  Scenario: Edge — a missing agent definition falls back gracefully
    Given the coder agent definition is absent
    When Phase 2 (Build) dispatches a ticket
    Then the orchestrator falls back to general-purpose
    And the build continues rather than aborting
    And the missing agent is reported
```

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
