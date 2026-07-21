---
id: TASK-132
title: ticket search
status: done
created: 2026-07-21T08:20:16.515Z
updated: 2026-07-21T09:29:26.000Z
activities: [{"activity":"ba","model":"claude-fable-5","startedAt":"2026-07-21T08:22:58.000Z","finishedAt":"2026-07-21T08:29:03.000Z"},{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-21T09:01:45.000Z","finishedAt":"2026-07-21T09:08:57.000Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-21T09:08:57.000Z","finishedAt":"2026-07-21T09:20:47.000Z"},{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-21T09:20:47.000Z","finishedAt":"2026-07-21T09:22:22.000Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-21T09:22:22.000Z","finishedAt":"2026-07-21T09:23:30.000Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-21T09:23:30.000Z","finishedAt":"2026-07-21T09:28:00.000Z"},{"activity":"post-processing","model":"claude-opus-4-8","startedAt":"2026-07-21T09:28:00.000Z","finishedAt":"2026-07-21T09:29:26.000Z"}]
---

## Description

Add a search box to the Tasks tab toolbar (`renderer/index.html` ~661–673, the
`.view-toolbar` inside `<div class="tab-view" data-view="tasks">`) that
live-filters the kanban board cards by a query.

Today the board renders every ticket in `tab.tasks.tickets` (a `Map` keyed by
filename, populated by `pollTasksOnce` in `renderer/renderer.js` ~8580) via
`renderTasksBoard` (~8962), which rebuilds all lanes and cards wholesale on every
render. The board re-renders whenever the poll signature changes (`t.lastSig`,
~8695–8706) — every `TASKS_POLL_MS` tick at most — so any filter must live in
per-tab state (`tab.tasks`, initialised ~295–317) that `renderTasksBoard` reads at
render time, exactly like the existing `tab.tasks.archiveExpanded` pattern
(~9153–9184). That way the filter survives poll re-renders automatically, with no
signature changes needed.

Filtering is purely client-side over the already-loaded in-memory tickets (each
entry holds `{ file, path, folder, fm, body, raw }` — see ~8677): a
case-insensitive, literal substring match against the ticket id, title, and body.
Typing re-renders the board immediately (call `renderTasksBoard(tab)` from the
`input` listener — synchronous, like the archived-expander toggle); an empty or
whitespace-only query shows the full board. The matcher must be a pure, top-level
function (e.g. `taskMatchesSearch(tk, query)`) so it can be extracted and
unit-tested headlessly under `node --test` the way
`test/helpers/task-101-lane-harness.js` extracts `renderTasksBoard`.

Why: boards accumulate 100+ tickets (see `tasks/done/`), and finding a specific
ticket currently means scanning every lane, including the Done lane's Archived
expander, by eye.

## Clarifications

Resolved with the user before build (recorded here, not in Additional Context):

1. **Searched fields** → match ticket **id + title + full body text**
   (Description/Acceptance Criteria/etc.).
2. **Empty lanes while filtered** → lanes with zero matches **stay visible (empty,
   count 0)** to keep the board layout stable (the `unknown` lane keeps its existing
   hide-at-0 behavior).
3. **Create/Plan while a filter is active** → **automatically clear the active
   search** when a ticket is created (New ticket) or Plan is run, so the new ticket
   is always visible. (Do not leave it hidden behind the filter.)
4. **Persistence** → **session-only**; the query is cleared on folder switch and NOT
   persisted across app restarts.

## Acceptance Criteria

- [ ] A search `<input>` (with a clear affordance — an `×` button or equivalent) is
  added to the Tasks tab `.view-toolbar` in `renderer/index.html`, wired into
  `tab.els` (the `ws.querySelector` block, `renderer/renderer.js` ~515–525) with its
  listener registered alongside the other toolbar listeners (~558–577). Each tab
  (workspace) has its own independent search state.
- [ ] Typing filters the board immediately (on `input`), without waiting for the
  next poll tick or pressing Enter.
- [ ] A card matches when the query is a case-insensitive substring of the ticket's
  `fm.id`, `fm.title`, or `body` (e.g. `task-091`, `TASK-091`, and a phrase from the
  Description all match). Matching is literal — regex metacharacters in the query
  (`(`, `[`, `*`, `.`, `\`) are treated as plain text and never throw.
- [ ] The query is trimmed before matching; an empty or whitespace-only query
  renders the full board identically to today (no behavioral change when the box is
  unused).
- [ ] The active filter survives the live poll re-render: with a query entered, when
  `pollTasksOnce` detects a change and calls `renderTasksBoard`, the board stays
  filtered and the input retains its text and focus (the input lives in the toolbar,
  outside `.tasksBoard` which is wiped by `rebuildTasksLanes` ~8785–8787).
- [ ] While filtered, every lane's `.tasks-lane-count` shows the number of matching
  cards in that lane; lanes with zero matches remain visible (empty), except the
  `unknown` lane which stays hidden at count 0 exactly as today (~9189–9192).
- [ ] The filter applies inside the Done lane's Archived expander: the "Archived
  (N)" count reflects matching archived cards only, and no expander is rendered when
  zero archived cards match (never "Archived (0)").
- [ ] While filtered, the toolbar status line (`tab.els.tasksStatus`, ~9206) shows
  `X of N tickets` (matched of total); the `· M running` fragment and everything
  derived from the full ticket set — `updateBuildBtn`, `updatePlanBtn`,
  `maybeContinueBuild`, `reportTasksActivity`, `reportWindowAttention` — continue to
  be computed from ALL tickets, never the filtered subset.
- [ ] When a non-empty query matches zero tickets on a non-empty board, a friendly
  "no matching tickets" message is shown (a new element — NOT the existing
  `.tasksEmpty` "No tickets yet…" banner, whose `showEmpty` condition at ~9194 must
  remain `total === 0`-based so it never appears just because a filter matched
  nothing).
- [ ] Clearing the query (via the clear affordance, Escape while the input is
  focused, or deleting the text) immediately restores the full board, true lane
  counts, and the normal status line.
- [ ] **Creating a ticket (New ticket) or running Plan while a filter is active
  clears the active search** (query state and the input's value) so the newly
  created ticket is visible, then renders the board unfiltered.
- [ ] Switching the tab to a different folder resets the search: the query state and
  the input's value are cleared in `resetTasksForFolder` (~6696), mirroring the
  `archiveExpanded` reset.
- [ ] Filtering does not interfere with existing flows: visible cards remain
  draggable between lanes (per-lane drop targets from `attachTasksLaneDrop` are
  attached in `rebuildTasksLanes` regardless of filter), intra-todo reorder still
  persists order across the FULL todo list (`reorderTodoTicket` ~9934 reads
  `t.tickets`, not the DOM), card click still opens the modal, and Plan / New ticket
  / Build / Refresh are unaffected. Frontmatter-folder reconciliation
  (`reconcileTicketFolders`) still processes all tickets, filtered or not.
- [ ] The matcher is a pure top-level function in `renderer/renderer.js`, covered by
  a `node --test` test that extracts it from the renderer source (following the
  `test/helpers/task-101-lane-harness.js` extraction pattern), including
  case-insensitivity, whitespace-only, and regex-metacharacter cases.
- [ ] No query text is ever written via `innerHTML` — `textContent`/attributes only,
  per the board's existing injection-hardening convention (see `buildTasksLaneEl`
  SECURITY note ~8813).

## Cucumber Tests

```gherkin
Feature: Search box on the Tasks board
  The Tasks tab toolbar has a search input that live-filters ticket cards
  by a case-insensitive substring of their id, title, or body.

  Background:
    Given a project folder with tickets on the Tasks board:
      | id       | title                    | status      | body contains        |
      | TASK-001 | Add login form           | todo        | validate credentials |
      | TASK-002 | Fix logout crash         | in-progress | null pointer         |
      | TASK-003 | Polish dashboard styles  | done        | CSS cleanup          |
    And the Tasks tab is active and polling

  Scenario: Matching by title, case-insensitively
    When I type "LOGIN" into the Tasks search box
    Then only the card "TASK-001" is visible on the board
    And the "todo" lane count shows 1
    And the "in-progress" and "done" lane counts show 0
    And the lanes with zero matches remain visible but empty

  Scenario: Matching by ticket id
    When I type "task-002" into the Tasks search box
    Then only the card "TASK-002" is visible
    And the toolbar status line shows "1 of 3 tickets"

  Scenario: Matching by body text
    When I type "null pointer" into the Tasks search box
    Then only the card "TASK-002" is visible

  Scenario: Empty query shows the full board
    Given I have typed "login" into the Tasks search box
    When I clear the search box
    Then all 3 cards are visible in their lanes
    And every lane count shows its true total
    And the toolbar status line shows "3 tickets"

  Scenario: Whitespace-only query is treated as empty (edge)
    When I type "   " into the Tasks search box
    Then all 3 cards are visible
    And no "no matching tickets" message is shown

  Scenario: Filter persists across the live poll re-render
    Given I have typed "login" into the Tasks search box
    And only "TASK-001" is visible
    When a poll tick re-reads the ticket files and re-renders the board
    Then only "TASK-001" is still visible
    And the search box still contains "login" and keeps focus

  Scenario: A ticket edited on disk mid-filter joins the results
    Given I have typed "login" into the Tasks search box
    When the title of "TASK-003" is changed on disk to "Login page polish"
    And the next poll tick re-renders the board
    Then "TASK-001" and "TASK-003" are both visible

  Scenario: No matches shows a friendly message, not the empty-board banner (failure)
    When I type "zzz-does-not-exist" into the Tasks search box
    Then no ticket cards are visible
    And a "no matching tickets" message is shown
    But the "No tickets yet" banner is NOT shown

  Scenario: Query with regex special characters is matched literally (edge)
    Given a ticket titled "Handle (edge) [case] *.md"
    When I type "(edge) [case]" into the Tasks search box
    Then the ticket "Handle (edge) [case] *.md" is visible
    And no script error is thrown

  Scenario: Archived done cards are filtered inside the expander
    Given the done lane contains 2 archived tickets, one titled "old login fix"
    When I type "login" into the Tasks search box
    Then the Done lane's expander shows "Archived (1)"
    When I type "zzz" into the Tasks search box
    Then no Archived expander is rendered

  Scenario: Clearing via Escape restores the board
    Given I have typed "login" into the Tasks search box
    When I press Escape while the search box is focused
    Then the search box is empty and all cards are visible

  Scenario: Creating a ticket while filtered clears the search (edge)
    Given I have typed "zzz" into the Tasks search box and no cards are visible
    When I create a new ticket that does not contain "zzz"
    Then the search box is cleared
    And the board renders unfiltered showing the new ticket

  Scenario: Switching folders resets the search
    Given I have typed "login" into the Tasks search box
    When I open a different project folder in the same tab
    Then the search box is empty
    And the new folder's board renders unfiltered

  Scenario: Drag and drop still works while filtered
    Given I have typed "log" into the Tasks search box
    When I drag the visible card "TASK-001" from "todo" to the "defining" lane
    Then the ticket's status is updated to "defining"
    And the card remains visible if it still matches the filter

  Scenario: Build accounting ignores the filter
    Given "TASK-002" is in-progress and I have typed "dashboard" into the search box
    Then the status line running count still reflects "TASK-002"
    And auto-build continuation logic still considers all tickets
```

## Edge Cases and Failure Modes

- Whitespace-only or empty query → identical to no filter; never shows the "no
  matching tickets" message.
- Regex metacharacters (`( ) [ ] * . \ + ?`) in the query → literal substring match
  via lowercased `String.prototype.includes`; must never construct a `RegExp` from
  user input (no throw, no ReDoS).
- Query matching zero tickets on a non-empty board → new "no matching tickets"
  message; the existing `.tasksEmpty` ("No tickets yet…") banner must NOT fire — its
  `showEmpty` check (~9194) keys off `total === 0`, keep it that way.
- Genuinely empty board (no tickets at all) plus a query → the existing "No tickets
  yet" empty state wins; no contradictory double message.
- Poll re-render mid-typing → filter state lives on `tab.tasks`, so the wholesale
  lane rebuild re-applies it; the input itself sits in the toolbar outside
  `.tasksBoard` and is never rebuilt, so focus/caret are preserved.
- A ticket rewritten on disk so it starts/stops matching → joins/leaves the filtered
  board on the next signature-changing poll; no extra render plumbing needed since
  `renderTasksBoard` reads the query live.
- Ticket with missing/empty `fm.title` (renders "(untitled)") or empty body →
  matcher must tolerate null/undefined fields without throwing.
- Unknown-status tickets → still routed to the `unknown` lane when they match; the
  unknown lane stays hidden when its filtered count is 0.
- `failed-testing` cards fold into the Testing lane (~9002) — while filtered they
  must keep that routing and their red marker.
- Creating a new ticket while a filter is active → per the clarification, the search
  is cleared automatically so the new card is visible.
- Intra-todo reorder while filtered: `reorderTodoTicket` re-sorts the FULL todo list
  from `t.tickets`, so hidden non-matching todo cards keep consistent persisted
  `order`; a filtered drag must not corrupt the order of hidden cards.
- Wake-lock / window-attention / running-count reporting (`reportTasksActivity`,
  `reportWindowAttention`, the `running` reduce at ~9203) must be computed from ALL
  tickets, never the filtered array — filter only what is appended to lane DOM.
- Very fast typing on a large board → each keystroke triggers a wholesale board
  rebuild; acceptable at current board sizes (in-memory, ~100s of tickets), no
  debounce required, but the `input` handler must not await anything.

## Relevant Files and Context

- `renderer/renderer.js` — all board logic lives here (browser script, no modules):
  - `tab.tasks` state object (~295–317): add `searchQuery: ''` beside
    `archiveExpanded`.
  - `tab.els` wiring (~515–525) and toolbar listeners (~558–577): add the input ref
    + `input`/Escape/clear listeners; on change set `tab.tasks.searchQuery` and call
    `renderTasksBoard(tab)` synchronously.
  - `pollTasksOnce` (~8580–8717): the poll/signature loop; do NOT add the query to
    `t.lastSig` — the query triggers its own direct render and the render reads it
    live.
  - `renderTasksBoard` (~8962–9216): apply the matcher when building/routing cards
    (the sorted `tickets` array at ~8984 feeds both lanes and the archived-done
    expander at ~9146; filter what gets appended, keep the full set for `running`,
    `updateBuildBtn`, `maybeContinueBuild`); status-line text at ~9206; empty-state
    toggle at ~9194.
  - `rebuildTasksLanes` (~8785) / `buildTasksLaneEl` (~8817): lane DOM is rebuilt
    wholesale each render — no changes needed, but explains why filter state must not
    live in the DOM. Note the SECURITY comment (~8813): textContent only, never
    innerHTML.
  - `resetTasksForFolder` (~6696): clear `searchQuery` and the input value here.
  - New-ticket create path and Plan enqueue: clear `searchQuery` + input on create
    (per clarification #3).
  - `reorderTodoTicket` (~9934), `attachTasksLaneDrop` / `moveTicketToStatus`: flows
    that must keep working while filtered.
  - Ticket entry shape `{ file, path, folder, fm, body, raw }` built at ~8677 via
    `parseTicketFrontmatter` (~6215): `fm.id`, `fm.title`, and `body` are all
    available in memory — no extra IPC needed.
  - Existing search UI to mirror: the Files find bar (`applyTreeFilter` ~2008,
    Escape-to-close conventions ~1660–2110).
- `renderer/index.html` — Tasks toolbar (~661–673): insert the search input; Files
  find bar markup (~288–299) as the input-pattern reference.
- `renderer/styles.css` — `.view-toolbar` (~276), `.files-find-input` (~895–906) to
  reuse/mirror for the new input; `.tasks-status` (~2520), `.tasks-empty` (~2522) for
  the new no-match message styling; `.tasks-lane-count` styles nearby.
- `lib/ticket-lanes.js` — status/lane model (LANE_STATUSES, VALID_STATUSES,
  failed-testing folds into testing, unknown lane): read-only context for routing
  invariants; no changes expected.
- `test/helpers/task-101-lane-harness.js` — the established pattern for extracting
  and headlessly exercising renderer functions under `node --test`; a new
  `test/task-132-board-search.test.js` should extract the pure matcher (and
  optionally extend the harness to assert filtered lane counts/empty-message
  behavior).
- Convention: renderer helpers meant for testing are pure top-level functions (see
  `isWontDoTicket`, `ticketFieldNonEmpty` ~6243) — implement `taskMatchesSearch(tk,
  query)` the same way.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
