---
id: TASK-094
title: Team tab Agents panel - list agents and edit descriptions (with mirror sync)
status: done
created: 2026-07-20T13:15:00Z
updated: 2026-07-20T22:11:04.113Z
order: 5
activities: [{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-20T21:40:00Z","finishedAt":"2026-07-20T21:51:59Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-20T21:42:00Z","finishedAt":"2026-07-20T22:07:47Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-20T21:44:00Z","finishedAt":"2026-07-20T22:11:04Z"}]
---

## Description
Fill `.teamAgentsSection` with a list of the opened project's `.claude/agents/*.md` (via
`fs.findByExt`/`readFile`), showing `name`, `model`, `tools`, `description`; description
editable in place. Save rewrites the whole file with only `description` changed (whole-file
write convention) through `writeWithMirror` (TASK-093), so the four bundled agents' `assets/`
copies stay byte-synced.

## Clarifications
- Q6: AUTO-SYNC — saves go through `writeWithMirror`; a failed mirror write shows a drift warning naming both paths.

## Acceptance Criteria
- [ ] Team tab with a folder open lists every `.md` in `<folder>/.claude/agents/` with frontmatter fields shown.
- [ ] Missing/empty `.claude/agents/` shows an install-skill hint (reuse `tasksSkillBanner` pattern / `tasks:installSkill`), not an error.
- [ ] Description edit (textarea + Save/Cancel per `git-form` conventions); Save performs a single whole-file write where only `description` differs, via `writeWithMirror`; when a mirror exists both copies end identical.
- [ ] Empty description rejected inline (breaks Claude Code agent discovery); no write.
- [ ] Unparseable files listed by filename with editing disabled; never rewritten.
- [ ] Write failure (`ok:false`) keeps the editor open with the user's text and an inline error; mirror-only failure shows the drift warning.
- [ ] Refresh control re-reads the directory.
- [ ] Unit + e2e tests (`task-094-*` pair).

## Cucumber Tests
```gherkin
Feature: Agents panel
  Scenario: Listing and editing
    Given .claude/agents/ba.md exists with an assets mirror
    When the user saves a new description for orchestrate-ba
    Then the file is rewritten with only the description changed
    And assets/agents/ba.md is byte-identical to it

  Scenario: Missing agents folder (edge)
    Given no .claude/agents directory
    Then an install-skill hint is shown and nothing throws

  Scenario: Unparseable agent file (failure)
    Given .claude/agents/broken.md with no closing fence
    Then it is listed as unparseable, editing disabled, file never modified

  Scenario: Empty description rejected (failure)
    When the user clears the description and saves
    Then an inline error is shown and no file is written
```

## Edge Cases & Failure Paths
- `binary:true` readFile responses; external edit between load and save (last write wins; re-read on failure); editing while the swarm runs (whole-file write is the accepted atomicity).

## Relevant Files & Context
- `renderer/renderer.js` — `initTeamTab` (TASK-091), `tasksJoin`, fs patterns in `pollTasksOnce` (5705–5774); modal/save conventions around `serializeTicket` (5365).
- `lib/agent-files.js` (TASK-092, mirrored); `writeWithMirror` (TASK-093).
- `main.js` `tasks:installSkill` (680).

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
