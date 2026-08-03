---
id: TASK-206
title: Remove the post-processing column, its kind:post-processing concept, and dispose of TASK-054
status: done
created: 2026-08-03T09:45:00.000Z
updated: 2026-08-03T12:10:00.000Z
---

## Description
Remove the **post-processing** system column/lane and the whole
**`kind: post-processing` ticket concept** from the app entirely. The user has
decided to delete this pre-configured functionality (their words: "remove post
processing column and the pre-configured functionality") — this is a REMOVAL, not
a redesign. There is **no replacement "final events" mechanism**: after this
ticket the board has **five** system lanes (`todo, defining, in-progress, testing,
done`) and there is no swarm-excluded "run against every ticket before done"
step.

This applies **on top of TASK-201's** reshaped `lib/team-config.js` (per-column
`agent`/`instructions`, `SYSTEM_COLUMN_DEFAULT_AGENTS`,
`SYSTEM_COLUMN_DEFAULT_INSTRUCTIONS`, phase system removed). TASK-201 keeps six
system columns **including** `post-processing`; this ticket removes
`post-processing` as the SEVENTH change on top of that base. It must land **after
or alongside TASK-201** and must be reconciled against TASK-201's final
`team-config.js` shape (do not reintroduce the phase code TASK-201 deleted).

The change spans three layers that must move **together in one atomic ticket**,
because the renderer duplicates the lib enums/labels and in-repo parity/drift-guard
tests (`test/task-034-routing-drift-guard.test.js`,
`test/task-122-summary-parity.*`) fail if lib and renderer disagree — so a
lib-only or renderer-only change cannot be green in isolation:

1. **Lib layer** — drop `post-processing` from the status enum, the system
   columns, the keep-awake set, and remove the `isPostProcessingTicket` swarm
   guards.
2. **Renderer layer** — drop the mirrored constants/labels, the post-processing
   lane's Add button, the new-ticket modal's post-processing mode, and the
   post-processing status count/keep-awake mirror.
3. **On-disk artefacts** — migrate `tasks/team-config.json` (drop the
   post-processing column) and **dispose of the one existing post-processing
   ticket** `tasks/post-processing/TASK-054-documentation.md` without losing the
   user's authored content.

**SKILL.md is out of scope here.** The `post-processing → done` terminal step in
`SKILL.md` is owned by the TASK-204/205 rewrite; TASK-205 is amended to drop the
post-processing step now that this ticket defines the removal. Do not edit
`SKILL.md` / `assets/skills/orchestrate/SKILL.md` in this ticket.

### Disposition of TASK-054 (decided)
`tasks/post-processing/TASK-054-documentation.md` (`kind: post-processing`, a
full README/docs regeneration prompt) is the only post-processing ticket on disk.
`lib/ticket-archive.js` is **display-only** (it derives a stale-Done "Archived"
expander from timestamps; it does NOT move/rewrite files), so there is no
"archive a ticket to disk" mechanism to reuse. Instead reuse the existing
**"Won't do" resolution** (TASK-074: `status: done` + `resolution: wont-do`,
rendered muted/struck-through in the Done lane — see `isWontDoTicket` in
`renderer/renderer.js`):
- Move the file from `tasks/post-processing/` to `tasks/done/`.
- Rewrite its frontmatter to `status: done`, add `resolution: wont-do`, and
  **remove the `kind: post-processing` key**.
- Preserve the entire existing body verbatim, prepending a short note in the
  `## Description` that it was retired when the post-processing column was
  removed (the user's authored prompt is kept on disk, never silently lost).
- Remove the now-empty `tasks/post-processing/` folder.

### Legacy-config migration (decided)
After `post-processing` leaves `SYSTEM_SLUGS`/`VALID_STATUSES`/`RESERVED_SLUGS`, a
legacy `tasks/team-config.json` that still carries a `post-processing` column
would, under the current `normalizeConfig` walk, be **demoted to a user column**
named "post-processing" (its slug is a valid `[a-z0-9-]` user slug), resurrecting
a lane. That is not the intended outcome. `normalizeConfig` **drops any legacy
`post-processing` column with one warning** (a forward migration, mirroring how
TASK-201 drops legacy `phase`/`skill.phases`) so the removal is truly complete and
no "Post-processing" user lane reappears.

## Acceptance Criteria

### lib/ticket-lanes.js
- [ ] `LANE_STATUSES` is `['todo','defining','in-progress','testing','done']` — `post-processing` removed; order otherwise unchanged.
- [ ] `VALID_STATUSES` is derived as before (`[...LANE_STATUSES, 'failed-testing']`) and therefore no longer contains `post-processing`; `failed-testing` still present.
- [ ] `POST_PROCESSING_STATUS`, `POST_PROCESSING_KIND`, and `isPostProcessingTicket` are removed from the module and from `module.exports`.
- [ ] The module header/board-flow comment and the per-constant comments are updated to the five-lane flow (`todo → defining → in-progress → testing → done`) with no post-processing description.
- [ ] `ACTIVE_STATUSES`, `FAILED_STATUS`, `laneForStatus`, `laneStatusesFor`, and every config-aware helper behave exactly as before for the remaining statuses (a `post-processing` status now routes to `UNKNOWN_STATUS`, not a lane).

### lib/ticket-queue.js
- [ ] The `isPostProcessingTicket` import is removed; the guards in `claimTicket`, `selectNextBatch`, and `canRunInParallel` that special-cased post-processing tickets are removed.
- [ ] `claimTicket`'s reason precedence becomes `no-agent-id → claimed → not-claimable`; the `'post-processing'` reason string is gone.
- [ ] `canRunInParallel`'s documented reason precedence becomes `no-ticket → claimed → already-active → not-claimable → no-slots → ok`; the `'post-processing'` reason string is gone.
- [ ] `SWARM_STATUSES` is still `[...VALID_STATUSES]` and its comment no longer lists `post-processing` in the lifecycle; all other claim/slot behaviour is unchanged.
- [ ] A ticket carrying a leftover `kind: post-processing` frontmatter key is treated purely by its `status` (the `kind` key round-trips as an ignored unknown field); it is no longer force-excluded from claiming.

### lib/keep-awake.js
- [ ] `KEEP_AWAKE_STATUSES` is `[...ACTIVE_STATUSES]` (i.e. `['defining','in-progress','testing']`); the `POST_PROCESSING_STATUS` import and its inclusion are removed, and the header comment is updated.

### lib/team-config.js (on top of TASK-201)
- [ ] `SYSTEM_LABELS` no longer has a `post-processing` key; `SYSTEM_SLUGS` (derived from `LANE_STATUSES`) is the five system slugs.
- [ ] `SYSTEM_COLUMN_DEFAULT_AGENTS` and `SYSTEM_COLUMN_DEFAULT_INSTRUCTIONS` (added by TASK-201) no longer contain a `post-processing` entry.
- [ ] The module header's "six SYSTEM columns" wording becomes "five SYSTEM columns" and drops `post-processing` from the listed order.
- [ ] `normalizeConfig` drops a legacy `post-processing` column (whether flagged `system:true` or arriving as a plain column) with exactly one warning naming it, and never re-injects it — a normalized config's `columns` never contains a `post-processing` column.
- [ ] `defaultConfig` produces exactly five system columns in order `todo, defining, in-progress, testing, done`; `serializeConfig` output round-trips through `normalizeConfig` unchanged (idempotent) and contains no `post-processing` column.
- [ ] The module never throws for any input and always returns a complete valid config with the five system columns.

### lib/ticket-folders.js
- [ ] No code change is required (folder ownership is driven by `isKnownStatus`/`VALID_STATUSES`), but the module header comment example that references `tasks/post-processing` is updated so the documented example set no longer implies a post-processing folder. `folderForStatus('post-processing')` now returns `null`.

### lib/ticket-cost.js
- [ ] `KNOWN_ACTIVITIES` no longer lists `'post-processing'` (it becomes `['ba','code','test','review']`). Unknown activity strings still render as-is, so any legacy cost-log entry with a `post-processing` activity still displays — only the known-label ordering set changes.

### renderer/renderer.js (kept in lockstep with the lib changes above)
- [ ] `TASKS_LANE_STATUSES` is `['todo','defining','in-progress','testing','done']`; `TASKS_VALID_STATUSES` derives from it and no longer contains `post-processing`.
- [ ] `TASKS_POST_PROCESSING_STATUS`, `TASKS_POST_PROCESSING_KIND`, and `isTasksPostProcessingTicket` are removed.
- [ ] `TASKS_SYSTEM_LABELS` no longer has a `post-processing` key.
- [ ] `buildTasksLaneEl` no longer renders the post-processing lane's `+` Add button (that whole `if (status === TASKS_POST_PROCESSING_STATUS)` block is gone); no lane gains a special Add affordance.
- [ ] `TASKS_KEEP_AWAKE_STATUSES` is `['defining','in-progress','testing']`, matching `lib/keep-awake.js`.
- [ ] `taskStatusCounts` no longer has a `post-processing` bucket and no longer early-continues on `isTasksPostProcessingTicket`; counts are purely status-driven (with the existing `other` catch-all).
- [ ] `openNewTaskModal` no longer supports post-processing mode: the `kind: 'post-processing'` / `status: 'post-processing'` opts path and its documentation are removed; the modal creates a `todo` ticket (Bug mode unchanged). There is no UI path left to create a `kind: post-processing` ticket.
- [ ] The new-ticket create path writes into the status subfolder as before; with no post-processing status it only ever targets `tasks/todo/` (or the top level) via `ticketFolderForStatus`.

### On-disk artefacts
- [ ] `tasks/team-config.json` is migrated: the `post-processing` column is removed; the remaining five system columns keep their TASK-201 `agent`/`instructions`; `concurrencyDefault` + `contextOptimization` preserved; the file round-trips through `normalizeConfig` unchanged.
- [ ] `tasks/post-processing/TASK-054-documentation.md` is moved to `tasks/done/`, rewritten to `status: done` + `resolution: wont-do`, the `kind: post-processing` key removed, its body preserved verbatim with a one-line retirement note prepended to `## Description`, and its user-owned `## Additional Context` left untouched.
- [ ] The now-empty `tasks/post-processing/` folder is removed.

## Cucumber Tests
```gherkin
Feature: remove the post-processing column and the kind:post-processing concept

  Scenario: the board has five system lanes and no post-processing lane
    Given a default team-config
    When the board lanes are computed
    Then the lanes are todo, defining, in-progress, testing, done in that order
    And there is no post-processing lane

  Scenario: post-processing is no longer a valid status
    When VALID_STATUSES is read
    Then it does not contain "post-processing"
    And it still contains "failed-testing"

  Scenario: a post-processing status routes to the unknown lane, never a lane of its own
    Given a ticket whose status is "post-processing"
    When laneForStatus is called
    Then it returns "unknown"

  Scenario: a leftover kind:post-processing ticket is claimable by its status
    Given a todo ticket that still carries kind: post-processing
    When claimTicket runs for an agent
    Then the claim succeeds and the ticket becomes in-progress
    And no "post-processing" reason is ever returned

  Scenario: keep-awake no longer counts post-processing
    Given a ticket whose status is "post-processing"
    When shouldKeepAwake evaluates the board
    Then that ticket does not hold the wake-lock

  Scenario: default config has five system columns
    When defaultConfig runs
    Then it has exactly five system columns
    And none of them is "post-processing"
    And serializeConfig output re-normalizes to the same config

  Scenario: a legacy post-processing column is dropped on normalize (edge)
    Given a raw config whose columns include a system "post-processing" column
    When normalizeConfig runs
    Then the normalized columns contain no "post-processing" column
    And no "post-processing" user column is created
    And warnings include a message naming the dropped post-processing column

  Scenario: the new-ticket modal cannot create a post-processing ticket
    When the tasks board renders
    Then no lane shows a post-processing Add button
    And opening the new-ticket modal creates a todo ticket with no kind field

  Scenario: TASK-054 is preserved as a won't-do Done ticket
    Given the post-processing column is removed
    When the migration runs
    Then TASK-054 lives in tasks/done with status done and resolution wont-do
    And it no longer carries kind: post-processing
    And its original documentation body is preserved

  Scenario: renderer and lib status sets stay in lockstep (drift guard)
    When TASKS_LANE_STATUSES is compared to LANE_STATUSES
    Then they are byte-identical with no post-processing member

  Scenario: junk config still yields five valid system columns (failure path)
    Given the input is the string "not json {"
    When normalizeConfig runs
    Then it returns a complete valid config with the five system columns
    And none of them is "post-processing"
```

## Edge & failure cases the coder must handle
- A legacy `tasks/team-config.json` carrying a `post-processing` system column → dropped on normalize with one warning; must NOT degrade into a user column named "post-processing".
- A ticket found on disk with `status: post-processing` (out of enum now) → routes to the `unknown` lane, is left in place (owns no folder), and is never silently dumped into `todo`.
- A ticket still carrying `kind: post-processing` after the change → the `kind` key round-trips as an ignored unknown field; the ticket is claimed/counted purely by its `status`.
- Reason-string precedence in `claimTicket`/`canRunInParallel` must remain deterministic after removing the `post-processing` branch (no gap that lets an ineligible ticket report `ok`).
- `KEEP_AWAKE_STATUSES` (lib) and `TASKS_KEEP_AWAKE_STATUSES` (renderer) must stay byte-identical, or the parity/keep-awake tests fail.
- `TASKS_LANE_STATUSES`/`TASKS_SYSTEM_LABELS` (renderer) must stay in lockstep with `LANE_STATUSES`/`SYSTEM_LABELS` (lib), or the routing/summary drift-guard tests fail — both sides must land in this one ticket.
- TASK-054's `## Additional Context` is user-owned and must be preserved untouched during the move/rewrite.
- Moving TASK-054 must not collide with an existing `tasks/done/` filename (keep its `TASK-054-documentation.md` basename — id is unique).
- The removal must not renumber or disturb any other ticket id (TASK-054 stays TASK-054; the next new id is still driven by the true max across `tasks/*/`).

## Relevant files & context
- `C:\projects\claude-cmd-ui2\lib\ticket-lanes.js` — `LANE_STATUSES` (33), `VALID_STATUSES` (38), `ACTIVE_STATUSES` idle-state comment (43), `POST_PROCESSING_STATUS`/`POST_PROCESSING_KIND` (51-52), `isPostProcessingTicket` (75-80), header board-flow comment (10-28), exports (248-266).
- `C:\projects\claude-cmd-ui2\lib\ticket-queue.js` — import (35), `SWARM_STATUSES` comment (38-57), `claimTicket` post-processing guard (275-281), `selectNextBatch` guard (354-356), `canRunInParallel` precedence doc + guard (396-420).
- `C:\projects\claude-cmd-ui2\lib\keep-awake.js` — import (18), `KEEP_AWAKE_STATUSES` (21), header comment (11-16).
- `C:\projects\claude-cmd-ui2\lib\team-config.js` (post-TASK-201) — `SYSTEM_LABELS` (82-89, drop the `'post-processing'` line), `SYSTEM_SLUGS` (92, auto-derives), `RESERVED_SLUGS` (98, auto-derives), header "six SYSTEM columns" note (41-48), the normalizeConfig column walk (484-551, add the legacy-drop), and TASK-201's new `SYSTEM_COLUMN_DEFAULT_AGENTS`/`SYSTEM_COLUMN_DEFAULT_INSTRUCTIONS` maps (drop their post-processing entries — see TASK-201 AC and its "Default instructions text" post-processing bullet).
- `C:\projects\claude-cmd-ui2\lib\ticket-folders.js` — header comment example (10-17); `folderForStatus` (24-26) needs no logic change.
- `C:\projects\claude-cmd-ui2\lib\ticket-cost.js` — `KNOWN_ACTIVITIES` (59) drop `'post-processing'`.
- `C:\projects\claude-cmd-ui2\renderer\renderer.js` — `TASKS_LANE_STATUSES` (5571), `TASKS_POST_PROCESSING_STATUS`/`KIND` (5588-5589), `isTasksPostProcessingTicket` (5594-5598), `TASKS_SYSTEM_LABELS` (5610-5617), `buildTasksLaneEl` Add button (10860-10877), `TASKS_KEEP_AWAKE_STATUSES` (11269), `taskStatusCounts` (11828-11844), `openNewTaskModal` opts doc + kind handling (12216-12260, 12385-12439), `isWontDoTicket` (~6709-6719) for the TASK-054 disposition shape.
- `C:\projects\claude-cmd-ui2\tasks\team-config.json` — remove the post-processing column (currently around line 37).
- `C:\projects\claude-cmd-ui2\tasks\post-processing\TASK-054-documentation.md` — the file to move/rewrite; preserve its body and `## Additional Context`.
- Tests that WILL need updating or removal (the tester owns this): `test\task-028-post-processing.e2e.test.js`, `test\task-032-post-processing-counts.test.js` + `.e2e.test.js`, `test\task-036-keep-awake.test.js` + `.e2e.test.js`, `test\ticket-lanes.test.js`, `test\ticket-folders.test.js`, `test\ticket-queue.test.js` + `.e2e.test.js`, `test\ticket-cost.test.js`, `test\task-104-config-aware-summaries.*`, `test\task-122-summary-parity.*`, `test\task-034-routing-drift-guard.test.js`, and any `team-config*`/`wont-do` tests. Run the full suite under `node --test`; note the ~50 known pre-existing baseline failures (see repo memory) are unrelated to this change.
- Dependency: **apply on top of TASK-201's column shape** (same `team-config.js`; must not reintroduce TASK-201's removed phase code, and must delete TASK-201's post-processing default agent/instructions entries). Coordinates with TASK-205 (the post-processing → done step is dropped from SKILL.md now that this ticket defines the removal — SKILL.md is not edited here).

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
