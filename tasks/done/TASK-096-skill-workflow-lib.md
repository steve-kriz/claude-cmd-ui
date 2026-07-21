---
id: TASK-096
title: Pure lib - orchestrate workflow read model (lib/skill-workflow.js)
status: done
created: 2026-07-20T13:15:00Z
updated: 2026-07-20T21:16:48.198Z
order: 7
activities: [{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-20T21:02:32Z","finishedAt":"2026-07-20T21:06:54Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-20T21:16:00Z","finishedAt":"2026-07-20T21:16:47Z"}]
---

## Description
Parse SKILL.md content into a read-only workflow model: ordered phases
(Plan/Build/Test/Review) with heading, dispatched agent type, and stated model directives
(Phase 1: `claude-fable-5` → `claude-opus-4-8`), plus the dispatch/fallback summary
(SKILL.md lines 114–132). Heading/pattern-based, prose-tolerant, no I/O. Feeds the Workflow
panel (TASK-105) and guided editor (TASK-106). SKILL.md itself is never written (Q3).

## Clarifications
- Q3: GUIDED SUBSET — SKILL.md prose/contract read-only; this lib is read-model only.

## Acceptance Criteria
- [ ] Exports `parseWorkflow(skillMd)` → `{ phases: [{ key, title, agent, model?, headingLine }], warnings: [] }`; junk input → `{ phases: [], warnings: [...] }`, never throws.
- [ ] Parsing the real `.claude/skills/orchestrate/SKILL.md` yields four phases in order with agents matching `AGENT_TYPES` (`orchestrate-ba/-coder/-tester/-tech-lead`).
- [ ] The Phase-1 model directive and fallback are captured.
- [ ] A missing phase heading yields that phase absent plus a warning naming it.
- [ ] Electron-free, no I/O; documents the renderer-duplication convention.

## Cucumber Tests
```gherkin
Feature: Workflow model
  Scenario: Parsing the bundled skill
    Then four phases return in order plan, build, test, review with their orchestrate-* agents

  Scenario: Model directive captured
    Then the plan phase records claude-fable-5 with fallback claude-opus-4-8

  Scenario: Missing phase heading (edge)
    Given SKILL.md without the Phase 3 heading
    Then the remaining phases return and a warning names phase 3

  Scenario: Junk input (failure)
    When parseWorkflow gets null and binary garbage
    Then it returns empty phases without throwing
```

## Edge Cases & Failure Paths
- Not-installed skill (caller passes empty string); reordered headings; CRLF.

## Relevant Files & Context
- `.claude/skills/orchestrate/SKILL.md` (headings at lines 134/194/337/379, dispatch 114–132).
- `lib/orchestrate-agents.js` (`AGENT_TYPES`); parsing pattern `lib/ticket-definition.js`.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
