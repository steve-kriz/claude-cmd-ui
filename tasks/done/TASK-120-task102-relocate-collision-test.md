---
id: TASK-120
title: TASK-102 review: test config-aware relocate collision branch
status: done
created: 2026-07-21T02:07:59.621Z
updated: 2026-07-21T03:30:59.997Z
review-of: TASK-102
activities: [{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-21T02:58:00Z","finishedAt":"2026-07-21T03:17:32Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-21T03:00:00Z","finishedAt":"2026-07-21T03:21:07Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-21T03:04:00Z","finishedAt":"2026-07-21T03:30:59Z"}]
---

## Description
Review follow-up for TASK-102, severity **minor**, TEST-ONLY — no product code change. `relocateTicketFile` documents a no-overwrite/no-data-loss contract: on a destination-name collision `fs:rename` refuses, nothing is overwritten, the source is left untouched, and it returns `{ok:false, moved:false, path:srcPath, error}`. No test exercises this branch through the config-aware USER-slug path added by TASK-102 — the only existing collision test (`test/ticket-folders.test.js` "destination name collision does not lose the ticket") uses a SYSTEM slug (`done`) and a verbatim pre-TASK-102 copy of the function, not the real extracted code. Add one e2e scenario to `test/task-102-status-change.e2e.test.js` (existing `loadFsModule` harness; its `makeFsMock().rename` already refuses when the target exists) that seeds two copies of one id — the mover in `tasks/todo/` with a user status (`ux-review` from `CONFIG_UX`) and a pre-existing occupant already at `tasks/ux-review/<same file>.md` — then relocates to the user status and asserts the refusal contract. Also drive `reconcileTicketFolders` over the collision (no re-poll since nothing moved) and `dedupeTicketsByFolder` (id surfaces once, folder-matching occupant wins).

Severity from review: **minor**. This is a review follow-up of TASK-102.

## Acceptance Criteria
- [ ] A new `test(...)` in `test/task-102-status-change.e2e.test.js` uses the existing `loadFsModule()` harness (real extracted renderer fns over `makeFsMock()`); no change to loadFsModule/makeFsMock/seedTicket helpers is REQUIRED (adding the already-extracted `dedupeTicketsByFolder` to the returned object literal is an allowed test-harness tweak within TEST-ONLY scope, if needed).
- [ ] Uses `CONFIG_UX`/`ux-review`; seeds the mover via `seedTicket(..., status:'ux-review', folder:'todo')` PLUS a pre-existing occupant at `tasksJoin(ROOT,'tasks','ux-review','<same file>.md')` via `fs.files.set(...)` with distinguishable content.
- [ ] Calls REAL `mod.relocateTicketFile(tab, srcPath, fileName, 'ux-review')` and asserts `ok===false`, `moved===false`, `path===srcPath`, `error` matching `/Target already exists/` — `ok===false` asserted explicitly so it can't pass via the `{ok:true, moved:false}` null-target/unsafe-slug early returns.
- [ ] No clobber / no data loss: the source file's content is byte-identical to before, the occupant's content unchanged, both paths still exist.
- [ ] Failure-branch fs shape: exactly one `rename` attempted (recorded in `fs.calls.rename`) and zero `writeFile` calls (relocate never rewrites content). NOTE: `mkdir(destDir)` IS expected (mkdir-on-demand) — do NOT assert zero mkdir.
- [ ] Drives `mod.reconcileTicketFolders(tab, [moverEntry])` against the collision (same or sibling test): both copies remain on disk, `pollTasksOnce` never invoked (nothing moved), `tab.tasks.reconciling` back to false.
- [ ] `mod.dedupeTicketsByFolder([both entries], mod.tasksUserStatusSet(mod.normalizeTasksColumns(CONFIG_UX)))` returns one entry for the id — the `ux-review` folder-matching copy wins.
- [ ] Written in the file's existing Given/When/Then + node --test style; mock fs only (no real fs/DB). NO product code change (only `test/task-102-status-change.e2e.test.js` modified).
- [ ] All existing tests in `test/task-102-status-change.e2e.test.js`, `test/task-111-drop-race.e2e.test.js`, `test/ticket-folders.test.js` still pass.

## Cucumber Tests
```gherkin
Feature: Config-aware relocate refuses to clobber a user-column destination collision
  Scenario: A user-status relocate hits a destination collision and refuses without data loss
    Given a ticket "TASK-15.md" status "ux-review" in "tasks/todo/"
    And a different copy of "TASK-15.md" already occupying "tasks/ux-review/"
    When relocateTicketFile moves the todo copy to status "ux-review"
    Then it returns ok:false, moved:false, path:srcPath, error matching "Target already exists"
    And exactly one rename was attempted and no content write occurred
    And the source and the occupant are both byte-identical to before
  Scenario: Reconciliation over the colliding entry stays quiet and loses nothing
    Given the same two on-disk copies
    When reconcileTicketFolders runs over the stale todo entry
    Then both copies remain on disk, no re-poll is triggered, and reconciling is released
  Scenario: The board shows the ticket once despite two copies
    Given entries for both copies
    When dedupeTicketsByFolder runs with the config-derived user-status set
    Then exactly one entry survives — the copy whose folder "ux-review" matches its status
  Scenario (edge): The refusal is a real error, not the safe no-op return
    Given the same collision setup
    Then ok is strictly false (distinguishing the rename-refusal branch from the {ok:true, moved:false} early returns)
```

## Edge Cases & Failure Paths
- Wrong-branch false positive: relocate has three `moved:false` exits returning `ok:true` (null target, unsafe slug, dest===src) — MUST assert `ok===false` + the error text so a config typo (e.g. CONFIG_NO_UX) can't make it pass without hitting the collision branch. Config matters: tab must carry `config:CONFIG_UX` (with no UX column, ticketFolderForStatusWith returns null and no rename is attempted). `mkdir` expected before rename. `console.warn` noise from the failure branch is fine (real console passed in). Reconcile must NOT re-poll (assert pollTasksOnce unset). Guard release: `t.reconciling` false in finally. Mock fs has no real dirs — "folder exists" = the occupant FILE existing at the dest path. Do NOT touch the frozen pre-TASK-102 copy in ticket-folders.test.js.

## Relevant Files & Context
- `test/task-102-status-change.e2e.test.js` — ONLY file to modify: `loadFsModule()` (~100-152, extract-headless of the real relocateTicketFile/reconcileTicketFolders/ticketFolderForStatusWith/tasksUserStatusSet/normalizeTasksColumns/dedupeTicketsByFolder/tasksJoin/parseTicketFrontmatter/serializeTicket; check `dedupeTicketsByFolder` is in the returned object — add if missing); `makeFsMock()` (~76-98, rename refuses at ~line 91, calls recorded); `CONFIG_UX` (~35-41); `seedTicket()` (~157-170); `relPaths()` (~172-175); `ROOT='C:\\proj'`.
- `renderer/renderer.js` — READ ONLY: `relocateTicketFile` (~8161-8181, failure branch ~8178-8180), `reconcileTicketFolders` (~8187-8211), `ticketFolderForStatusWith` (~6171-6177), `dedupeTicketsByFolder` (~6215-6228).
- `test/ticket-folders.test.js` (frozen SYSTEM-slug collision test ~734 + the pre-102 copy ~392-452) — leave untouched. `test/task-111-drop-race.e2e.test.js` — other consumer of the extraction pattern, keep green. Run `node --test test/task-102-status-change.e2e.test.js`.
- 2 known-baseline failures unrelated.

## Impact If Not Fixed
A future refactor of relocateTicketFile could silently break collision safety for user-column folders (clobbering or losing a ticket copy) while all TASK-102 tests stay green.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
