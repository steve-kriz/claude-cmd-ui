---
id: TASK-105
title: Team tab Workflow panel - read-only pipeline view of the orchestrate skill
status: done
created: 2026-07-20T13:15:00Z
updated: 2026-07-21T01:03:22.066Z
order: 16
activities: [{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-20T22:16:00Z","finishedAt":"2026-07-21T00:37:55Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-20T22:18:00Z","finishedAt":"2026-07-21T00:55:32Z"},{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-20T22:20:00Z","finishedAt":"2026-07-21T00:58:45Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-20T22:20:00Z","finishedAt":"2026-07-21T00:59:09Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-20T22:22:00Z","finishedAt":"2026-07-21T01:03:21Z"}]
---

## Description
Fill `.teamWorkflowSection` with the read-only workflow visualization: the four phases from
`parseWorkflow` (TASK-096) over the project's `.claude/skills/orchestrate/SKILL.md`, each
showing title, dispatched agent (cross-checked against `.claude/agents/` with a
fallback-to-`general-purpose` warning when missing, mirroring `resolveAgentType`/`isFallback`),
and model directives. Skill not installed → the same install banner/action as the Tasks tab.
This is the foundation the guided editor (TASK-106) mounts onto; no write path here.

## Clarifications
- Q3: GUIDED SUBSET — the phase prose/contract renders read-only; editing (models/concurrency) arrives in TASK-106.

## Acceptance Criteria
- [ ] With the skill installed, four phases render in order with agent, model, and the fallback rule.
- [ ] Missing agent definition renders a visible fallback warning on that phase.
- [ ] Skill missing → install banner (reuse `checkOrchestrateSkill` / `tasksInstallSkillBtn` pattern); install then renders the pipeline.
- [ ] Parse warnings (missing phase) render as warnings, never a blank panel.
- [ ] Refresh control re-reads SKILL.md; no background polling.
- [ ] No code path writes SKILL.md.
- [ ] Unit + e2e tests (`task-105-*` pair) incl. a modified-SKILL fixture.

## Cucumber Tests
```gherkin
Feature: Workflow panel (read-only)
  Scenario: Rendering the pipeline
    Given the orchestrate skill is installed
    Then plan, build, test and review render in order with their agents and models

  Scenario: Missing agent definition (edge)
    Given .claude/agents/tester.md is deleted
    Then the test phase shows a falls-back-to-general-purpose warning

  Scenario: Skill not installed (failure)
    Given no SKILL.md
    Then the install banner is shown and nothing crashes
```

## Edge Cases & Failure Paths
- Customized/partially parseable SKILL.md (warnings); `fs:readFile` `binary:true`/`ok:false`; agents present but skill missing.

## Relevant Files & Context
- `lib/skill-workflow.js` (TASK-096, mirrored).
- `renderer/renderer.js` `checkOrchestrateSkill` 5676–5691; `main.js` `tasks:installSkill` 680; `lib/orchestrate-agents.js`.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
