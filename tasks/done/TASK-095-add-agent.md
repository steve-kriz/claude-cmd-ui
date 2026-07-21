---
id: TASK-095
title: Team tab Agents panel - add a new agent definition (real subagent file)
status: done
created: 2026-07-20T13:15:00Z
updated: 2026-07-20T22:41:45.090Z
order: 6
activities: [{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-20T21:46:00Z","finishedAt":"2026-07-20T22:24:23Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-20T21:48:00Z","finishedAt":"2026-07-20T22:37:18Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-20T21:50:00Z","finishedAt":"2026-07-20T22:41:44Z"}]
---

## Description
"Add agent" form (name slug, required description, optional tools/model, body prompt with
starter default) creating `<folder>/.claude/agents/<name>.md` — a real, dispatchable Claude
Code subagent definition (Q5). Validation mirrors `validateAgentName`. New agents have no
`assets/` mirror, so `writeWithMirror` is a natural no-op for them (and guards the future case).

## Clarifications
- Q5: REAL agent file — a genuine `.claude/agents/<name>.md` subagent definition.
- Q2: adding an agent does NOT change orchestrate dispatch — the skill's phase→agent mapping stays fixed; new agents are available for manual/board (display) use.

## Acceptance Criteria
- [ ] "Add agent" button in `.teamAgentsSection` opens the form; Create `mkdir`s `.claude/agents/` if absent and writes the file in one `writeWithMirror` call; the agent appears in the list immediately.
- [ ] Generated file parses with `parseAgentFile` and matches the bundled frontmatter shape (name, description, optional tools/model, body).
- [ ] Name validation rejects empty/non-slug/duplicate/`general-purpose` inline, with no write.
- [ ] Existing target file at write time → abort with error, no overwrite.
- [ ] Cancel discards without writing.
- [ ] Unit + e2e tests (`task-095-*` pair).

## Cucumber Tests
```gherkin
Feature: Add agent
  Scenario: Creating orchestrate-docs
    When the user submits name "orchestrate-docs" with a description
    Then .claude/agents/orchestrate-docs.md is created with valid frontmatter
    And it appears in the Agents panel

  Scenario: Duplicate name refused (failure)
    Given orchestrate-ba exists
    When the user submits "orchestrate-ba"
    Then an inline error is shown and no file is written

  Scenario: Fresh project (edge)
    Given no .claude directory
    When the user creates a valid agent
    Then the directories are created and the file written
```

## Edge Cases & Failure Paths
- Race with `tasks:installSkill` copying bundled agents (existing-file check at write time); Windows filename constraints (covered by slug rules); dispatch unchanged (Q2).

## Relevant Files & Context
- Same renderer surfaces as TASK-094; `window.api.fs.mkdir`/`writeFile`.
- `lib/agent-files.js` (TASK-092).
- `main.js` `tasks:installSkill` (680).

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
