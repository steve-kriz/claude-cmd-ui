---
id: TASK-092
title: Pure lib - agent-definition file model (lib/agent-files.js)
status: done
created: 2026-07-20T13:15:00Z
updated: 2026-07-20T21:22:20.485Z
order: 3
activities: [{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-20T21:02:32Z","finishedAt":"2026-07-20T21:11:29Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-20T21:16:00Z","finishedAt":"2026-07-20T21:16:47Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-20T21:22:00Z","finishedAt":"2026-07-20T21:22:20Z"}]
---

## Description
Electron-free helpers to parse an agent markdown definition (frontmatter `name`, folded
`description: >-`, `tools`, `model`, plus body), serialize it back byte-identically
(preserving key order, unknown keys, line endings), and validate agent names. Single
authority for the Team tab (TASK-094/095/106) and tests, superseding the parser inlined in
`test/orchestrate-agents.test.js`.

## Clarifications
- Q5: "Add agent" creates a real `.claude/agents/<name>.md`; this lib provides its serializer/validator.
- Q6: assets auto-sync is a write-path concern (TASK-093), not this lib's.

## Acceptance Criteria
- [ ] `lib/agent-files.js` exports `parseAgentFile(content)` → `{ fm: { name, description, tools, model, ...extras }, body }` or null; `serializeAgentFile(fm, body)`; `validateAgentName(name, existingNames)`.
- [ ] Handles the folded `description: >-` form used by all four files in `.claude/agents/`; `serializeAgentFile(parseAgentFile(x))` is byte-identical for ba.md, coder.md, tester.md, tech-lead.md (both CRLF and LF inputs).
- [ ] Unknown frontmatter keys round-trip untouched.
- [ ] `validateAgentName` rejects empty, non-`[a-z0-9-]`, duplicates, and `general-purpose` (`FALLBACK_AGENT`); accepts e.g. `orchestrate-docs`.
- [ ] Malformed input returns null / structured error, never throws.
- [ ] No Electron/DOM requires; header comment documents the renderer-duplication convention.

## Cucumber Tests
```gherkin
Feature: Agent file model
  Scenario: Parsing ba.md
    When parseAgentFile runs on .claude/agents/ba.md
    Then fm.name is "orchestrate-ba" and fm.model is "claude-fable-5"

  Scenario: Byte-identical round-trip
    Given each bundled agent file
    Then parse followed by serialize reproduces the original bytes

  Scenario: Invalid names rejected (failure)
    When validateAgentName gets "", "Bad Name!", "orchestrate-ba" (existing) and "general-purpose"
    Then every call reports an error

  Scenario: Unclosed frontmatter (edge)
    When parseAgentFile gets a file without a closing --- fence
    Then it returns null without throwing
```

## Edge Cases & Failure Paths
- CRLF vs LF; missing `tools:`; description containing `:`/`#`; non-string input.

## Relevant Files & Context
- `lib/orchestrate-agents.js` (`FALLBACK_AGENT`, `AGENT_TYPES`, `AGENT_NAMES`).
- `.claude/agents/*.md` + `assets/agents/*.md` (fixtures, unmodified).
- `test/orchestrate-agents.test.js` (existing inline parser to supersede/reference).
- Patterns in `lib/ticket-definition.js`, `lib/ticket-lanes.js` header comments.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
