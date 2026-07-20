---
id: TASK-065
title: ticket archiving
status: done
created: 2026-07-19T08:58:31.304Z
updated: 2026-07-20T00:30:00Z
---

## Description
archive tickets older than 5 days, keep them in done column, but add a archived expander that will show everything that is archived

The Done lane grows without bound (70+ tickets already live in `tasks/done/`). Add an "archived" presentation state for stale done tickets: a done ticket whose last activity is more than 5 days old is hidden from the normal Done card list and folded into a collapsible **"Archived (N)"** expander rendered inside the Done lane. Expanding it lists every archived card (still clickable/draggable like any other card).

Archiving is **derived, not stored**: it introduces **no new status** (the enum in `lib/ticket-lanes.js` is fixed: `todo, defining, in-progress, testing, post-processing, done` + `failed-testing`) and **no file moves** (archived tickets stay in `tasks/done/`; `lib/ticket-folders.js` reconciliation must be untouched). It is a pure function of the ticket's frontmatter timestamps and the current time.

**Which timestamp drives "older than 5 days": `fm.updated`, falling back to `fm.created` when `updated` is missing/invalid.** Justification: the skill contract bumps `updated` on every write, so for a done ticket `updated` approximates when it reached `done` (its last write is the `status: done` transition). Using `created` would instantly archive any ticket that took more than 5 days from creation to completion the moment it lands in Done — wrong. No field records the exact done-transition instant, so `updated` is the best available proxy.

Implementation shape (follow the established lib-plus-renderer-mirror pattern used by TASK-003/005/006/007/008):
1. New pure, Electron-free module `lib/ticket-archive.js` exporting:
   - `ARCHIVE_AFTER_DAYS = 5` and `ARCHIVE_AFTER_MS = 5 * 24 * 60 * 60 * 1000`.
   - `archiveTimestamp(fm)` → epoch ms from `fm.updated`, else `fm.created`, else `null` (invalid/missing → null, never NaN).
   - `isArchived(fm, now)` → `true` only when `fm.status === 'done'` AND `now − archiveTimestamp(fm) > ARCHIVE_AFTER_MS`. `now` is an **explicit required argument** (epoch ms or Date) — the helper never calls `Date.now()` itself, so tests inject a fixed clock. Missing/invalid `now`, missing/invalid timestamps, or a negative age (future timestamp) all return `false` (fail-safe: show rather than hide).
   - `partitionArchived(entries, now)` → `{ visible, archived }` preserving input order (entries are `{ fm }`-bearing objects or plain fm objects, matching `isPostProcessingTicket`'s tolerant unwrap in `lib/ticket-lanes.js`).
2. Renderer mirror (renderer.js cannot `require()`): duplicate the tiny predicate (`ticketIsArchived(fm, now)` + the 5-day constant) near the other mirrors (~line 5194-5300), and change `renderTasksBoard` so done-lane cards whose `ticketIsArchived(tk.fm, Date.now())` is true are appended into an expander container instead of the main card list. `Date.now()` is fine at the renderer call site (matching `formatBuildDuration` line 5339); only the lib helper takes injected time.
3. Expander UI: a header row `Archived (N)` + a hidden cards container appended at the bottom of the Done lane's `.tasks-lane-cards`. Collapsed by default; entirely absent when N = 0. Because `renderTasksBoard` wipes each lane's `innerHTML` every poll (renderer.js:5630-5634), the open/closed state must live on `tab.tasks` (e.g. `tab.tasks.archiveExpanded`) so it survives re-renders; reset it in `resetTasksForFolder` (renderer.js:5440).
4. Counts: the Done lane's `.tasks-lane-count` keeps counting **all** done tickets (visible + archived) so totals stay truthful; the expander header shows the archived subset count.

## Acceptance Criteria
- [ ] New pure module `lib/ticket-archive.js` exists, requires nothing from Electron, and exports `ARCHIVE_AFTER_DAYS` (5), `ARCHIVE_AFTER_MS`, `archiveTimestamp(fm)`, `isArchived(fm, now)`, and `partitionArchived(entries, now)`.
- [ ] `isArchived` returns `true` for a `status: done` ticket whose `updated` is strictly more than 5 days before the injected `now`.
- [ ] `isArchived` returns `false` for a `done` ticket whose age is ≤ 5 days (the exact 5-day boundary is NOT archived — strictly older only).
- [ ] `isArchived` returns `false` for every non-`done` status (`todo`, `defining`, `in-progress`, `testing`, `post-processing`, `failed-testing`, unknown), regardless of age — non-done tickets are never archived.
- [ ] `archiveTimestamp` prefers `updated` and falls back to `created`; when both are missing/invalid it returns `null` and `isArchived` returns `false` (a timestamp-less done ticket is never hidden).
- [ ] `isArchived` takes `now` as an explicit argument and never calls `Date.now()` internally; a missing/invalid `now` or a future timestamp (negative age) yields `false`.
- [ ] `partitionArchived` splits a list into `{ visible, archived }`, preserving relative order and never mutating inputs.
- [ ] `renderTasksBoard` in `renderer/renderer.js` renders archived done tickets inside a collapsible "Archived (N)" expander at the bottom of the Done lane, where N is the archived count; non-archived done cards render exactly as today.
- [ ] The expander is collapsed by default, toggles on click, and its open/closed state survives board re-renders (poll cycles) within a tab session.
- [ ] When no done ticket is archived, the expander is not rendered at all (no "Archived (0)" clutter).
- [ ] Archived cards keep full card behavior (click opens the ticket modal; drag out of Done still works and changes status via the existing lane drop handling).
- [ ] The Done lane's `.tasks-lane-count` still reports the total number of done tickets (visible + archived).
- [ ] No new status value is introduced, no ticket file is moved or rewritten by archiving, and the renderer mirror matches `lib/ticket-archive.js` (verified by a source-scan test in the style of `test/tasks-working-indicator.test.js`).
- [ ] Unit tests for `lib/ticket-archive.js` run under `node --test` with fixed injected timestamps (no `Date.now()` in assertions) and all pass.

## Cucumber Tests
```gherkin
Feature: Archive stale done tickets behind an expander in the Done lane

  Scenario: A done ticket older than 5 days is archived
    Given a ticket with status "done" and updated "2026-07-10T00:00:00Z"
    And the current time is "2026-07-19T00:00:00Z"
    When I ask isArchived(fm, now)
    Then it returns true

  Scenario: A done ticket within 5 days stays visible
    Given a ticket with status "done" and updated "2026-07-16T00:00:00Z"
    And the current time is "2026-07-19T00:00:00Z"
    When I ask isArchived(fm, now)
    Then it returns false

  Scenario: Exactly 5 days old is not archived (strictly older only)
    Given a ticket with status "done" and updated "2026-07-14T00:00:00Z"
    And the current time is "2026-07-19T00:00:00Z"
    When I ask isArchived(fm, now)
    Then it returns false

  Scenario Outline: Non-done tickets are never archived regardless of age
    Given a ticket with status "<status>" and updated 30 days before now
    When I ask isArchived(fm, now)
    Then it returns false
    Examples:
      | status          |
      | todo            |
      | defining        |
      | in-progress     |
      | testing         |
      | post-processing |
      | failed-testing  |

  Scenario: Fallback to created when updated is missing
    Given a done ticket with no updated field and created 10 days before now
    When I ask isArchived(fm, now)
    Then it returns true

  Scenario: Missing or invalid timestamps never hide a ticket (edge/failure)
    Given a done ticket whose updated and created are both absent or unparseable
    When I ask isArchived(fm, now)
    Then it returns false

  Scenario: Future timestamp or invalid now never archives (edge/failure)
    Given a done ticket whose updated is later than the injected now
    And separately an isArchived call with an undefined now
    Then both calls return false

  Scenario: Done lane shows an "Archived (N)" expander with the correct count
    Given 3 done tickets older than 5 days and 2 done tickets updated today
    When the board renders
    Then the Done lane shows 2 normal cards
    And an expander labelled "Archived (3)"
    And the Done lane count reads 5

  Scenario: Empty archive renders no expander
    Given only done tickets updated within the last 5 days
    When the board renders
    Then no "Archived" expander appears in the Done lane

  Scenario: Expander state survives a board re-render
    Given the archive expander is open
    When the next poll re-renders the board
    Then the expander is still open
```

## Edge Cases & Failure Paths
- Exactly-5-days boundary: NOT archived (strict `>` comparison, documented and tested).
- `updated` missing/empty → fall back to `created`; both missing/invalid → never archived (fail-safe visible).
- Unparseable timestamp strings (`new Date(x)` → NaN) → treated as missing.
- Future `updated` (clock skew, hand-edited file) → negative age → not archived.
- Missing/invalid `now` argument to the lib helper → `false`, never a throw.
- Non-done statuses (including `failed-testing` and out-of-enum/unknown) are never archived even at any age.
- Archived count of 0 → expander absent entirely.
- Expander open state must not reset every 3-second poll (lane `innerHTML` is wiped each render — state lives on `tab.tasks`, reset in `resetTasksForFolder`).
- Archived cards must keep click-to-open-modal and drag handlers (dragging an archived card to another lane un-archives it naturally, since status changes).
- Archiving must not affect the board change signature/poll logic, `dedupeTicketsByFolder`, or folder reconciliation — no writes, no moves, no new folder.

## Relevant Files & Context
- `lib/ticket-archive.js` — NEW pure module (pattern: `lib/ticket-lanes.js`, `lib/ticket-folders.js` — 'use strict', header comment, no Electron requires).
- `lib/ticket-lanes.js` — fixed status enum (`LANE_STATUSES`, `laneForStatus`); do not modify; done is a lane status.
- `renderer/renderer.js` — `renderTasksBoard` (line 5627: lane routing 5646-5660, card build 5661-5764, lane counts 5766-5769), `pollTasksOnce` (5509, change signature `id|status|updated` at 5560-5563), mirrors block (5194-5300: `isTicketWaitingForAnswer`, `ticketFolderForStatus`, `tasksSubfolder`, `dedupeTicketsByFolder`), `formatBuildDuration` (5330 — precedent for `Date.now()` at render time), `resetTasksForFolder` (5440 — reset the new expander state here).
- `renderer/index.html` — Done lane markup lines 674-677 (`.tasks-lane[data-status="done"]` > `.tasks-lane-header` + `.tasks-lane-cards`); expander can be built dynamically in JS, no static markup strictly required.
- `renderer/styles.css` — style the expander near the task-card styles (`.tasks-lane-count` at 2576, `.task-card-meta` at 2641 for the muted/monospace tone).
- Ticket timestamps: flat frontmatter ISO-8601 `created`/`updated` strings (parsed by `parseTicketFrontmatter`, renderer.js ~5170-5192; contract in `.claude/skills/orchestrate/SKILL.md` "Timestamps: preserve created, always bump updated").
- Test patterns: `test/ticket-runs.test.js` / `test/ticket-accounting.test.js` (pure-lib unit tests, fixed timestamps), `test/tasks-working-indicator.test.js` (source-scanning renderer.js to keep the mirror honest). Runner: `node --test`.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
