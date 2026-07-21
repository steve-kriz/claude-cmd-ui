---
id: TASK-106
title: Guided skill-settings editor - per-phase model and concurrency default
status: done
created: 2026-07-20T13:15:00Z
updated: 2026-07-21T01:37:43.670Z
order: 17
activities: [{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-20T22:24:00Z","finishedAt":"2026-07-21T01:15:49Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-20T22:26:00Z","finishedAt":"2026-07-21T01:33:10Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-20T22:28:00Z","finishedAt":"2026-07-21T01:37:43Z"}]
---

## Description
Mount the Q3 guided editor on the Workflow panel: (a) **per-phase model** — an editor per
phase that rewrites the `model:` frontmatter of that phase's agent file
(`.claude/agents/{ba,coder,tester,tech-lead}.md`) via `lib/agent-files.js` round-trip +
`writeWithMirror` (TASK-093) so `assets/agents/` stays byte-synced; the Phase-1 SKILL.md model
directive is displayed read-only with a note that it takes precedence for planning dispatch
(SKILL.md is never edited). (b) **Concurrency default** — a control (options
`[1..MAX_CONCURRENCY]` via the `concurrencyOptions()` pattern) writing `skill.concurrencyDefault`
into `tasks/team-config.json`; the Tasks toolbar dropdown's initial value resolves localStorage
→ config value → `DEFAULT_CONCURRENCY`, and the queued `/orchestrate build --concurrency N`
command reflects it. Agent descriptions are edited in the Agents panel (TASK-094) — this panel
links there rather than duplicating.

## Clarifications
- Q3: editable subset = per-phase model, concurrency default, agent descriptions (the latter in TASK-094). SKILL.md prose read-only.
- Q6: model edits to mirrored agent files auto-sync `assets/agents/`.
- Reasoned defaults: model edits live in agent frontmatter (the real dispatch lever for subagents); `DEFAULT_CONCURRENCY`/`MAX_CONCURRENCY` constants in `lib/ticket-queue.js` are unchanged — the config value only seeds the UI/command.

## Acceptance Criteria
- [ ] Each phase row offers a model editor (free text or curated list incl. current values `claude-fable-5` etc.); Save rewrites only the `model:` value in that agent's file via whole-file round-trip; when a mirror exists both copies end byte-identical.
- [ ] An agent file without a `model:` key gains one in canonical position; all other bytes preserved (round-trip guarantee from TASK-092).
- [ ] Phase 1 shows the SKILL.md directive (`claude-fable-5` → `claude-opus-4-8`) read-only with the precedence note; no SKILL.md write path exists.
- [ ] Concurrency control shows `[1..MAX_CONCURRENCY]`; Save normalizes via `resolveConcurrency` and writes `skill.concurrencyDefault` in `tasks/team-config.json` (whole-file, normalized config).
- [ ] Tasks toolbar dropdown initial value = localStorage (`tasks:concurrency:<folder>`) if set, else config `skill.concurrencyDefault`, else `TASKS_DEFAULT_CONCURRENCY`; the build command carries it (`buildConcurrencyCommand` behavior unchanged).
- [ ] Write failures surface inline; mirror-only failure shows the drift warning (TASK-093 contract).
- [ ] Unit + e2e tests (`task-106-*` pair), extending patterns from `test/task-019-tasks-settings.unit.test.js` and `test/task-051-planning-model.test.js`.

## Cucumber Tests
```gherkin
Feature: Guided skill settings
  Scenario: Editing the coder phase model
    When the user sets the build phase model to "claude-opus-4-8" and saves
    Then .claude/agents/coder.md has model: claude-opus-4-8 with all other bytes preserved
    And assets/agents/coder.md is byte-identical

  Scenario: Concurrency default seeds the Tasks dropdown
    Given skill.concurrencyDefault 5 in team-config.json and no localStorage value
    When the Tasks tab initializes
    Then the Parallel dropdown shows 5 and Build queues "/orchestrate build --concurrency 5"

  Scenario: SKILL.md stays read-only (edge)
    When any workflow setting is saved
    Then SKILL.md bytes on disk are unchanged

  Scenario: Out-of-range concurrency (failure)
    When a stored concurrencyDefault of 99 is loaded
    Then it resolves to the MAX_CONCURRENCY clamp and saving rewrites the normalized value

  Scenario: Mirror write fails (failure)
    Given assets/agents/coder.md is unwritable
    When the model is saved
    Then the .claude copy is written and a drift warning names both paths
```

## Edge Cases & Failure Paths
- localStorage value present overrides config (documented precedence); agent file missing for a phase (editor disabled with the fallback warning from TASK-105); concurrent edit of the same agent file from the Agents panel (last write wins; both go through the same round-trip).

## Relevant Files & Context
- `lib/agent-files.js` (TASK-092); `lib/assets-mirror.js`/`writeWithMirror` (TASK-093); `lib/team-config.js` (TASK-097).
- `lib/tasks-settings.js` (`concurrencyOptions`, `readStoredConcurrency`, `storageKey`, `buildConcurrencyCommand`).
- `renderer/renderer.js` concurrency wiring 6376–6445 and `BUILD_COMMAND` 6365; `lib/ticket-queue.js` (constants unchanged); SKILL.md lines 119–122 (Phase-1 directive, display only).

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
