---
id: TASK-099
title: Config-aware folder-per-status (lib/ticket-folders.js extensions)
status: done
created: 2026-07-20T13:15:00Z
updated: 2026-07-20T21:29:02.530Z
order: 10
activities: [{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-20T21:20:00Z","finishedAt":"2026-07-20T21:23:08Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-20T21:26:00Z","finishedAt":"2026-07-20T21:26:14Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-20T21:29:00Z","finishedAt":"2026-07-20T21:29:02Z"}]
---

## Description
User statuses own `tasks/<slug>/` folders like system statuses do. Add config-aware variants,
leaving existing exports untouched: `folderForStatusWith(status, columns)` (slug for system +
user statuses, null otherwise), `folderMatchesStatusWith`, `reconcileFolderWith`. Migration
policy per the design: add = folder created on demand by the existing relocate/mkdir path;
rename = label-only (slug immutable, no move); remove = config-only, files stay put and route
to `unknown` (never relocated, never hidden).

## Clarifications
- Q1: dynamic statuses with folder-per-status. Reasoned default: no bulk file migration ever — slugs are immutable and removal leaves files in place.

## Acceptance Criteria
- [ ] Existing exports/behavior unchanged (`test/ticket-folders.test.js` passes unmodified).
- [ ] `folderForStatusWith('ux-review', columns)` is `'ux-review'` when configured; null when not configured (leave file in place).
- [ ] `reconcileFolderWith` moves a configured user-status ticket sitting in the wrong folder to `tasks/<slug>/`, and returns `needsMove:false, targetFolder:null` for unconfigured statuses.
- [ ] `dedupeByFolder` continues to work with user-status entries (prefer folder-matching copy).
- [ ] Null/junk columns degrade to current system-only behavior; never throws.

## Cucumber Tests
```gherkin
Feature: Config-aware ticket folders
  Scenario: User status owns a folder
    Given columns include ux-review
    Then folderForStatusWith("ux-review") is "ux-review"

  Scenario: Reconciling into a user folder
    Given a ticket with status ux-review sitting at tasks/ top level
    Then reconcileFolderWith reports needsMove with target "ux-review"

  Scenario: Removed column leaves files alone (edge)
    Given columns no longer include ux-review
    When reconcileFolderWith runs on a ticket still in tasks/ux-review/
    Then needsMove is false and targetFolder is null

  Scenario: System statuses unaffected (failure guard)
    Then folderForStatusWith behaves identically to folderForStatus for every VALID_STATUSES entry
```

## Edge Cases & Failure Paths
- Rename collision impossible (slugs immutable); folder exists but column deleted (files stay, board shows unknown); Windows path separators handled by callers (renderer `tasksJoin`).

## Relevant Files & Context
- `lib/ticket-folders.js` (all 71 lines); `lib/ticket-lanes.js` extensions (TASK-098).
- Renderer reconcile path `renderer/renderer.js` 5784–5821 (consumed later by TASK-102).

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
