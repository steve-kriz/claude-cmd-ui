---
id: TASK-103
title: Team tab Board panel - column manager (add / edit / reorder / remove)
status: done
created: 2026-07-20T13:15:00Z
updated: 2026-07-21T00:12:41.960Z
order: 14
activities: [{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-20T22:04:00Z","finishedAt":"2026-07-20T23:56:30Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-20T22:06:00Z","finishedAt":"2026-07-21T00:08:43Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-20T22:08:00Z","finishedAt":"2026-07-21T00:12:41Z"}]
---

## Description
Fill `.teamBoardSection` with the column manager over `tasks/team-config.json`: ordered list
of columns; per-column editable label, description, and display-agent select (populated from
`.claude/agents/` + "(none)"); "Add column" (label → derived immutable slug shown read-only,
validated per TASK-097); reorder user columns (system columns' relative order fixed — user
columns move between them); remove user columns with a warning when tickets currently hold
that status (counted from the live board scan) — removal is config-only, files untouched.
System columns show a "system" marker and cannot be removed or re-slugged. Save writes the
whole config file in one `fs.writeFile`.

## Clarifications
- Q1: this is the authoring UI for the dynamic-status engine. Q2: agent select is display metadata only (helper text says so). Q4: persists to `tasks/team-config.json`. Reasoned defaults: slugs immutable; system order fixed; non-empty removal warns but is allowed (tickets fall to unknown, reversible by re-adding the same slug).

## Acceptance Criteria
- [ ] Panel lists all configured columns in order with label/description/agent editors; system columns marked, remove/re-slug disabled for them.
- [ ] Add column: label required; derived slug previewed read-only; validation errors (dup/reserved/blank/too long) shown inline with no write; on success the config file gains the column at the chosen position.
- [ ] Reorder: user columns can be moved anywhere; system columns' relative order (todo → … → done) cannot be violated (controls constrained).
- [ ] Remove: user column only; when tickets exist with that status a confirmation states the count and that those tickets will show in Unknown; config-only write, no ticket files touched.
- [ ] Save = single whole-file write of normalized config; reload/restart round-trips it; corrupt existing file → editor loads defaults with a non-blocking notice.
- [ ] Board (Tasks tab) reflects saved changes on its next poll without restart.
- [ ] Agent select includes every `.claude/agents/` name plus "(none)"; a saved agent no longer present renders selected-with-warning (no silent loss).
- [ ] Unit + e2e tests (`task-103-*` pair).

## Cucumber Tests
```gherkin
Feature: Column manager
  Scenario: Adding a user column
    When the user adds "UX Review" after Testing and saves
    Then team-config.json holds column ux-review at that position
    And the Tasks board shows the new lane on its next poll

  Scenario: System column protections (failure)
    Then the Done column has no remove control and its slug is not editable
    And attempting to reorder Todo after Done is not possible

  Scenario: Removing a non-empty column (edge)
    Given 2 tickets hold status ux-review
    When the user removes the column
    Then a confirmation states 2 tickets will show in Unknown
    And after confirming only the config changes

  Scenario: Duplicate slug rejected (failure)
    When the user adds a column whose derived slug is "testing"
    Then an inline error is shown and nothing is written

  Scenario: Corrupt config file (failure)
    Given invalid JSON in team-config.json
    Then the editor loads defaults with a notice and can save a repaired file
```

## Edge Cases & Failure Paths
- Two workspace tabs on the same folder editing concurrently (last write wins; Refresh re-reads); config file deleted while editing (Save recreates, parent `tasks/` mkdir); label containing only symbols → empty slug rejected.

## Relevant Files & Context
- `renderer/renderer.js` Team scaffold (TASK-091), agents list data (TASK-094), board tickets map for counts (`tab.tasks.tickets`).
- `lib/team-config.js` (TASK-097, mirrored); `preload.js` fs bridge (no new IPC).

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
