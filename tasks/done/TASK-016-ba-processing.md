---
id: TASK-016
title: BA processing
status: done
created: 2026-07-18T10:09:57.766Z
updated: 2026-07-18T11:02:43.000Z
---

## Description
Strengthen the business-analyst step so the BA does a **thorough** analysis of each ticket and captures **all** the information needed to build it **inside the ticket** before any build begins. Update `.claude/agents/ba.md` and/or the Phase 1 (Plan / Define) section of `.claude/skills/orchestrate/SKILL.md` so the BA is required to: read/search the relevant codebase, enumerate full acceptance criteria, write Gherkin covering every criterion (including edge/failure paths), call out edge cases, and record the relevant files/context the coder will need — all within the ticket body — before the ticket leaves the defining stage. This must not weaken the existing hard rule that the BA never writes implementation code and never edits source files; it only reads/searches to inform the ticket. It also must preserve the rule that the user-owned `## Additional Context` section is left empty for the user and never overwritten. This ticket edits instruction files only. make sure the BA agent runs on all files while the coder does the coding task and tester is testing a ticket

## Acceptance Criteria
- [x] `.claude/agents/ba.md` requires the BA to perform a thorough analysis of each ticket (reading/searching the relevant codebase) before it is considered defined.
- [x] `.claude/agents/ba.md` requires each ticket to capture all information a coder needs to build it: a precise `## Description`, complete `## Acceptance Criteria`, Gherkin covering every criterion, explicitly listed edge/failure cases, and the relevant files/context.
- [x] The `## Cucumber Tests` requirement continues to mandate at least one failure/edge scenario per ticket.
- [x] `.claude/agents/ba.md` and/or SKILL.md Phase 1 state that this full analysis must be captured in the ticket **before** any build (Phase 2) starts.
- [x] The existing hard rule that the BA never writes implementation code and never edits/creates source files is preserved.
- [x] The rule that the `## Additional Context` section stays empty/user-owned and is never overwritten is preserved.
- [x] No source/product files are changed by this ticket (instruction files only).

## Cucumber Tests
```gherkin
Feature: BA thoroughly analyzes and fully captures each ticket before build

  Scenario: BA agent requires thorough codebase analysis
    Given the file ".claude/agents/ba.md"
    When I read it
    Then it requires the BA to read and search the relevant codebase before a ticket is defined

  Scenario: Ticket captures all information a coder needs
    Given the file ".claude/agents/ba.md"
    When I read it
    Then it requires each ticket to contain a precise description, complete acceptance criteria, Gherkin for every criterion, explicit edge and failure cases, and the relevant files and context

  Scenario: Gherkin still requires an edge or failure scenario
    Given the file ".claude/agents/ba.md"
    When I read the Cucumber Tests requirement
    Then it still requires at least one failure or edge scenario per ticket

  Scenario: Analysis must be captured before the build phase
    Given the files ".claude/agents/ba.md" and ".claude/skills/orchestrate/SKILL.md"
    When I read the defining-phase instructions
    Then they state the full analysis must be captured in the ticket before any build begins

  Scenario: BA still may not write code (edge)
    Given the file ".claude/agents/ba.md"
    When I read its hard rules
    Then it still forbids the BA from writing implementation code or editing or creating source files

  Scenario: Additional Context stays user-owned (edge)
    Given the files ".claude/agents/ba.md" and ".claude/skills/orchestrate/SKILL.md"
    When I read the ticket-contract instructions
    Then they still require the "Additional Context" section to stay empty and user-owned and never be overwritten

  Scenario: No product code changes (edge)
    Given the diff for this ticket
    When I inspect which files changed
    Then only ".claude/agents/ba.md" and/or ".claude/skills/orchestrate/SKILL.md" are modified
```

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
