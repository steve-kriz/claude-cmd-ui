---
id: TASK-117
title: TASK-098 review: add __wont-do__ to userStatusSetFor reserved guard
status: done
created: 2026-07-21T02:07:59.621Z
updated: 2026-07-21T03:23:28.370Z
review-of: TASK-098
activities: [{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-21T02:58:00Z","finishedAt":"2026-07-21T03:15:44Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-21T02:58:00Z","finishedAt":"2026-07-21T03:21:38Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-21T03:02:00Z","finishedAt":"2026-07-21T03:23:28Z"}]
---

## Description
Review follow-up for TASK-098 (config-aware lanes), severity **minor**. `userStatusSetFor` in `lib/ticket-lanes.js` excludes `VALID_STATUSES` and `unknown` from the user-slug collision guard but omits `__wont-do__`, diverging from team-config `RESERVED_SLUGS` (`new Set([...VALID_STATUSES, 'unknown', '__wont-do__'])`) and the renderer `TASKS_RESERVED_SLUGS`. `__wont-do__` is the task-modal's archive-marker pseudo-status (→ `status:done` + `resolution:wont-do`), so a user column with that slug could collide with the modal pseudo-option.

POST-TASK-109 STATE: TASK-109 added `isFsSafeSlug` + gated `userStatusSetFor` on it; `__wont-do__`'s underscores already fail `FS_SLUG_RE` (`/^[a-z0-9-]+$/`), so it is ALREADY excluded — but only INCIDENTALLY. This ticket makes the exclusion EXPLICIT (parity with RESERVED_SLUGS): add a dedicated `__wont-do__` skip in `userStatusSetFor` (a local constant `WONT_DO_SLUG='__wont-do__'` + lockstep comment naming team-config RESERVED_SLUGS and renderer TASKS_RESERVED_SLUGS), so the exclusion documents intent, survives any future relaxation of the slug regex, and restores 1:1 parity. Do NOT require team-config (cycle) — local constant. Do NOT remove/weaken the isFsSafeSlug gate (additive). No renderer change. Everything downstream (isUserStatus/isKnownStatusFor/laneForStatusFor/laneStatusesFor + ticket-folders `*With`) inherits it with no other edits. No observable behavior change today; the deliverable is the explicit guard + locking tests.

Severity from review: **minor**. This is a review follow-up of TASK-098.

## Acceptance Criteria
- [ ] With a non-system column `{status:'__wont-do__', system:false}`: `isUserStatus('__wont-do__', cols)` false; `isKnownStatusFor` false; `laneForStatusFor` → `'unknown'` (never `'todo'`); `laneStatusesFor(cols)` deep-equals `LANE_STATUSES` (omits it); `folderForStatusWith('__wont-do__', cols)` null and `reconcileFolderWith` → `{needsMove:false, targetFolder:null}`.
- [ ] The exclusion is EXPLICIT in `userStatusSetFor` (dedicated `__wont-do__` check via a local constant + lockstep comment referencing team-config RESERVED_SLUGS + renderer TASKS_RESERVED_SLUGS), NOT reliance on isFsSafeSlug rejecting underscores; the isFsSafeSlug gate remains unchanged.
- [ ] `lib/ticket-lanes.js` still does not require `lib/team-config.js` (no cycle).
- [ ] Pre-existing collisions unchanged: every VALID_STATUSES member + `unknown` as a non-system slug still excluded (`laneForStatusFor('failed-testing', cols) === 'testing'`, etc.).
- [ ] Valid user slug `ux-review` unaffected (isUserStatus true, own lane, anchored placement, own folder). Plain `wont-do` (no underscores, NOT reserved in team-config) still admitted as a user status.
- [ ] All helpers tolerate null/[]/junk columns, never throw. Export surface unchanged (task-098 export guard passes).
- [ ] `test/ticket-lanes.test.js`, `test/task-098-config-aware-lanes.{test,e2e.test}.js`, `test/wont-do.{test,e2e.test}.js`, `test/task-109-slug-traversal.e2e.test.js` pass UNMODIFIED.
- [ ] New unit tests (`test/task-117-wontdo-reserved-parity.test.js`) cover the `__wont-do__` exclusion across the helpers + the `wont-do`/`ux-review` regressions.

## Cucumber Tests
```gherkin
Feature: __wont-do__ reserved-slug parity in the config-aware lane guard
  Scenario: A user column with slug __wont-do__ is never a user status
    Given a non-system column with status "__wont-do__"
    Then isUserStatus("__wont-do__", columns) is false and isKnownStatusFor is false
  Scenario: __wont-do__ routes to unknown, never todo
    Given a non-system column with status "__wont-do__"
    Then laneForStatusFor("__wont-do__", columns) is "unknown" (not "todo")
  Scenario: __wont-do__ never appears as a board lane
    Given the system columns plus a non-system "__wont-do__" column
    Then laneStatusesFor(columns) equals exactly the six fixed LANE_STATUSES
  Scenario: __wont-do__ owns no tasks/ folder
    Given a non-system "__wont-do__" column
    Then folderForStatusWith("__wont-do__", columns) is null and reconcileFolderWith yields needsMove:false/targetFolder:null
  Scenario: Regression — ux-review unaffected
    Given a non-system "ux-review" column after "testing"
    Then isUserStatus true, laneForStatusFor "ux-review", listed between testing and post-processing, folderForStatusWith "ux-review"
  Scenario: Regression — plain "wont-do" still admitted
    Given a non-system "wont-do" column
    Then isUserStatus("wont-do", columns) is true
  Scenario: Existing reserved exclusions still hold
    Given non-system "todo"/"failed-testing"/"unknown" columns
    Then none is a user status; laneForStatusFor("failed-testing") is "testing"; laneForStatusFor("unknown") is "unknown"
  Scenario: Junk columns never throw
    Given null/[]/string/number/junk-array columns
    Then no helper throws and each degrades to system-only behavior
```

## Edge Cases & Failure Paths
- Whitespace-padded ` __wont-do__ ` trimmed by columnSlug before the check. `system:true` column carrying it still skipped by the system continue. Exact-match only (`__WONT-DO__` already dropped by isFsSafeSlug; underscore-free `wont-do` stays legal). Do NOT weaken TASK-109 (additive check). No require cycle (local constant). Null/junk never throws. Duplicate `__wont-do__` columns still excluded; laneStatusesFor first-occurrence dedupe must not resurrect it. Export names/behavior unchanged.

## Relevant Files & Context
- `lib/ticket-lanes.js` — ONLY source change: `userStatusSetFor` (~157-168, post-109 shape: system-skip → columnSlug trim → skip '' → skip !isFsSafeSlug (~163) → skip VALID_STATUSES/unknown (~164) → add). Add the `__wont-do__` skip on/next to the reserved check; LOCKSTEP comment pattern at ~111-119/136-137; downstream consumers (isUserStatus ~172, isKnownStatusFor ~178, laneForStatusFor ~186, laneStatusesFor ~200) unchanged; module.exports (~233-251) unchanged.
- `lib/team-config.js` — READ ONLY parity source: RESERVED_SLUGS (~79). `renderer/renderer.js` — READ ONLY: TASKS_RESERVED_SLUGS (~5280), normalization drop (~5330), tasksUserStatusSet (~5352), the `__wont-do__` pseudo-option (~8706/8772/8886). `lib/ticket-folders.js` — folderForStatusWith gates on isKnownStatusFor (inherits, no edit).
- Tests to pass unmodified: ticket-lanes.test.js, task-098-*, wont-do.{test,e2e}, task-109-slug-traversal.e2e. New: `test/task-117-wontdo-reserved-parity.test.js` (pure node --test, hand-built columns via a col(status,system) helper).
- 2 known-baseline failures unrelated.

## Impact If Not Fixed
Defense-in-depth parity gap: if a future caller feeds un-normalized columns, an archive-marker `__wont-do__` slug could surface as a spurious board lane and collide with the won't-do status-select value, corrupting that UI flow.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
