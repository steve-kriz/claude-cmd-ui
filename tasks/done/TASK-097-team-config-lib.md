---
id: TASK-097
title: Pure lib - team config model with reserved + user statuses (lib/team-config.js)
status: done
created: 2026-07-20T13:15:00Z
updated: 2026-07-20T21:17:15.376Z
order: 8
activities: [{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-20T21:02:32Z","finishedAt":"2026-07-20T21:08:24Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-20T21:10:00Z","finishedAt":"2026-07-20T21:13:16Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-20T21:18:00Z","finishedAt":"2026-07-20T21:17:15Z"}]
---

## Description
The core of the dynamic-status engine: a pure model for `tasks/team-config.json`. Shape:

```json
{ "version": 1,
  "columns": [ { "status": "todo", "label": "To Do", "description": "", "agent": null, "system": true },
               { "status": "ux-review", "label": "UX Review", "description": "...", "agent": "orchestrate-tech-lead", "system": false } ],
  "skill": { "concurrencyDefault": 3 } }
```

Exports: `defaultConfig()` (six system columns in `LANE_STATUSES` order, labels matching
today's board headers; `failed-testing` is deliberately NOT a column — it stays lane-less,
folding into Testing); `normalizeConfig(raw)` (tolerates junk/partial input, always returns
a complete valid config: all six system columns present with canonical relative order
enforced, user columns preserved between them, unknown fields round-tripped);
`validateNewColumn(label, slug, config)`; `serializeConfig(config)`. Guards: system slugs and
the `system` flag are immutable — normalize re-injects/repairs any tampered system column;
user slugs must be `[a-z0-9-]`, <= 30 chars, and must not collide with `VALID_STATUSES`,
`unknown`, `__wont-do__`, or existing columns.

## Clarifications
- Q1: FULL DYNAMIC-STATUS ENGINE — user-defined statuses are real; this config is their single source of truth.
- Q4: persisted as `tasks/team-config.json`, readable by lib/renderer/swarm; `skill.concurrencyDefault` lives here too (Q3).
- Q2: `agent` per column is display-only metadata.
- Reasoned defaults: user slugs immutable after creation (rename = label edit only — no ticket/folder migration ever needed); system lane relative order fixed; removal is config-only.

## Acceptance Criteria
- [ ] `defaultConfig()` returns exactly the six system columns in `LANE_STATUSES` order with today's labels ("To Do", "Defining", "In Progress", "Testing", "Post-processing", "Done") and `skill.concurrencyDefault === DEFAULT_CONCURRENCY` (imported from `lib/ticket-queue.js`).
- [ ] `normalizeConfig` on null/junk/partial input returns a complete config; missing system columns are re-inserted in canonical relative order; user columns and their positions between system columns are preserved; a `warnings` list reports every repair.
- [ ] A tampered config (system column deleted, system slug renamed, `system:false` flipped) is repaired by normalize — the six system columns always survive with their exact slugs.
- [ ] `validateNewColumn` rejects: blank label; slug collisions with `VALID_STATUSES`/`unknown`/`__wont-do__`/existing columns; non-slug characters; > 30 chars. Provides `slugForLabel(label)` derivation.
- [ ] `skill.concurrencyDefault` is normalized through `resolveConcurrency` (clamped [1, `MAX_CONCURRENCY`]).
- [ ] Nothing in `lib/ticket-lanes.js` / `lib/ticket-queue.js` exports is modified by this ticket (guard test).
- [ ] Pure, Electron-free, never throws; documents the renderer-duplication convention.

## Cucumber Tests
```gherkin
Feature: Team config model
  Scenario: Defaults mirror the fixed board
    Then defaultConfig returns six system columns in LANE_STATUSES order with today's labels

  Scenario: User column between system columns survives normalize
    Given a config with "ux-review" between testing and post-processing
    Then normalizeConfig keeps it in place with system:false

  Scenario: Tampered system column repaired (failure)
    Given a config where "in-progress" was deleted and "done" renamed to "finished"
    When normalizeConfig runs
    Then both system columns are restored with canonical slugs and warnings report the repairs

  Scenario: Reserved slug collision rejected (failure)
    When validateNewColumn is called with slug "failed-testing" and with "todo"
    Then both are rejected

  Scenario: Junk input (edge)
    When normalizeConfig gets "not json parsed", 42, and []
    Then a complete default config returns each time without throwing
```

## Edge Cases & Failure Paths
- Duplicate slugs in raw input (first wins + warning); unknown top-level fields round-trip; config from a newer version (unknown column fields preserved); `agent` naming a nonexistent agent (kept; render-time warning).

## Relevant Files & Context
- `lib/ticket-lanes.js` (`LANE_STATUSES`, `VALID_STATUSES`); `lib/ticket-queue.js` (`DEFAULT_CONCURRENCY`, `MAX_CONCURRENCY`, `resolveConcurrency`).
- Default labels source `renderer/index.html` 657–684; pattern `lib/tasks-settings.js`.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
