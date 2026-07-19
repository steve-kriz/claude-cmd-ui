---
id: TASK-028
title: kanban post done task
status: done
created: 2026-07-18T21:18:59.826Z
updated: 2026-07-18T21:57:07.000Z
---

## Description
Repurpose the Tasks kanban board's fifth lane. Today the six board lanes are `todo → defining → in-progress → testing → failed-testing → done`. This ticket removes the **`failed-testing` board lane** and replaces it, in the same position (between **Testing** and **Done**), with a new **Post-processing** lane.

The Post-processing lane holds a new kind of ticket — a **post-processing ticket** — that describes "final events" the user wants run on every normal task after its tests pass but before it is marked `done`. The lane header exposes an **Add** affordance; clicking it creates a new post-processing ticket directly in that lane. This lets the user customise the closing steps of the build/test workflow (e.g. changelog entry, formatting, doc regeneration) without editing the orchestration skill.

Two concerns must be handled carefully because they are the reason this is not a pure UI change:

1. **`failed-testing` is not merely a lane — it is a live status in the orchestrate fix loop** (`.claude/skills/orchestrate/SKILL.md`, `.claude/agents/tester.md`) and a claimable status in `lib/ticket-queue.js`. It must **remain a valid, claimable status** so the fix loop keeps working. Only its *dedicated board lane* is removed. Failed-testing cards must remain visible: they render **folded into the Testing lane** with their existing red "failed" dot, and their on-disk folder `tasks/failed-testing/` is preserved. No existing `failed-testing` ticket is migrated or lost.

2. **`post-processing` becomes a new valid status/lane and a new ticket `kind`**, mirrored across every place the status enum is currently duplicated (lib + renderer + HTML + CSS + skill docs + tests), and post-processing tickets must be **excluded from the build swarm** (they are reusable recipes, not work to be coded/tested/marked done).

The skill contract is updated so the completion ordering becomes `testing → tech-lead review → post-processing → done`: after a normal ticket passes testing and review, the orchestrator runs the defined post-processing tickets against it, then marks it `done`.

## Acceptance Criteria

Board UI (renderer/index.html, renderer/styles.css)
- [ ] The board no longer renders a lane with `data-status="failed-testing"`.
- [ ] A new lane with `data-status="post-processing"` exists in the exact position the `failed-testing` lane occupied (5th, between `testing` and `done`), with header text "Post-processing" and a `.tasks-lane-count` span initialised to `0`.
- [ ] The DOM lane order (excluding the trailing `unknown` lane) is exactly `todo, defining, in-progress, testing, post-processing, done`.
- [ ] The `post-processing` lane header has a distinct border-top color CSS rule (`.tasks-lane[data-status="post-processing"] .tasks-lane-header`), consistent with the existing per-lane color rules.
- [ ] The post-processing lane header contains an **Add** button (e.g. `.tasks-lane-add`) visible only on that lane; no other lane gains an Add button.
- [ ] The existing red failed-dot CSS rule (`.task-card-dot.failed`, `#f14c4c`) is retained unchanged.

Status enum / lane logic (lib/ticket-lanes.js + renderer mirror)
- [ ] `LANE_STATUSES` (lib) and `TASKS_LANE_STATUSES` (renderer) both equal `['todo','defining','in-progress','testing','post-processing','done']` and stay byte-mirrored.
- [ ] A new set of *valid persistable statuses* (e.g. `VALID_STATUSES` in lib and `TASKS_VALID_STATUSES` in renderer) includes all lane statuses **plus** `failed-testing` (i.e. `todo, defining, in-progress, testing, failed-testing, post-processing, done`).
- [ ] `isKnownStatus(status)` returns true for every value in the valid-statuses set (so both `failed-testing` and `post-processing` are "known", never routed to the `unknown` lane).
- [ ] `laneForStatus('post-processing') === 'post-processing'`; `laneForStatus('failed-testing') === 'testing'` (folded); every other known status maps to its own lane; any out-of-enum status maps to `UNKNOWN_STATUS`.
- [ ] `FAILED_STATUS` remains `'failed-testing'` and `isFailedStatus` continues to recognise only it; a `failed-testing` card still renders the red `task-card-dot failed` marker, now inside the Testing lane.
- [ ] `ACTIVE_STATUSES` / `TASKS_ACTIVE_STATUSES` are unchanged; `post-processing` is NOT an active status (no blue "being worked on" dot).
- [ ] New exports exist for the post-processing concept, e.g. `POST_PROCESSING_STATUS = 'post-processing'` and a `POST_PROCESSING_KIND = 'post-processing'` plus an `isPostProcessingTicket(fm)` predicate (true when `fm.kind === 'post-processing'`).

Folder-per-status (lib/ticket-folders.js + renderer mirror)
- [ ] `folderForStatus('post-processing') === 'post-processing'` and `folderForStatus('failed-testing') === 'failed-testing'` (both still own subfolders under `tasks/`), driven by the valid-statuses set, not just lane statuses.
- [ ] A post-processing ticket reconciles into `tasks/post-processing/`; an existing `failed-testing` ticket still reconciles into `tasks/failed-testing/`.

Create-from-board (renderer/renderer.js, renderer/index.html)
- [ ] Clicking the post-processing lane's **Add** button opens the new-ticket modal in a post-processing mode.
- [ ] Creating from that modal writes a ticket whose frontmatter has `status: post-processing` **and** `kind: post-processing`, into `tasks/post-processing/`, following the existing whole-file `serializeTicket` contract (leading key order preserved, `## Additional Context` section present with its placeholder line).
- [ ] The toolbar "New ticket" button is unchanged: it still creates a `todo` ticket with **no** `kind` field.
- [ ] The `kind` frontmatter key round-trips through board polls and edits (preserved as an unknown key by `serializeTicket`/`orderFm`), and the created post-processing card renders in the post-processing lane.

Build swarm exclusion (lib/ticket-queue.js + skill contract)
- [ ] `CLAIMABLE_STATUSES` continues to be `['todo','failed-testing']`; `post-processing` is NOT claimable, so `selectNextBatch`/`claimTicket` never pick up a post-processing ticket for coding/testing.
- [ ] Post-processing tickets do not inflate the Build button's pending count (which counts `todo` + `failed-testing`) and are not counted as "running".

Ticket detail modal (renderer/index.html + renderer/renderer.js)
- [ ] The task detail modal status `<select>` offers the six lane statuses (the `failed-testing` option is replaced by a `post-processing` option: `<option value="post-processing">Post-processing</option>`).
- [ ] Opening a ticket whose stored status is valid but not in the select's option list (i.e. `failed-testing`) preserves that status: the modal must NOT silently rewrite it to `todo` on save. (Either inject the current status as a selected option, or only rewrite `status` when the user actually changes the select.)

Orchestrate skill contract (.claude/ + assets/ — drift guard)
- [ ] `.claude/skills/orchestrate/SKILL.md` describes the board lanes as `todo → defining → in-progress → testing → post-processing → done`, documents that `failed-testing` remains the fix-loop failure status (no longer a dedicated lane, folded into Testing), and documents post-processing tickets: identified by `kind: post-processing`, never built/tested/claimed by the swarm.
- [ ] The skill documents the completion ordering `testing → tech-lead review → post-processing → done`: after review passes, the orchestrator runs each defined post-processing ticket's instructions against the reviewed task before setting it `done`.
- [ ] The skill's "never invent a status outside the enum" text lists the updated valid set including `post-processing` (and still `failed-testing`).
- [ ] `assets/skills/orchestrate/SKILL.md` is byte-for-byte identical to the `.claude/` copy after the edit (drift guard). The same byte-identical rule applies to `.claude/agents/*.md` ↔ `assets/agents/*.md` for any agent file touched.

Backward-compat / migration
- [ ] An existing ticket already in `tasks/failed-testing/` with `status: failed-testing` still loads, renders (red dot in the Testing lane), remains claimable/re-buildable, and is never auto-moved out of its folder or auto-relabelled.
- [ ] Pre-existing tests that hard-code the old six-value lane list including `failed-testing` are updated to the new lane list, and tests that assert `failed-testing` remains a valid/claimable fix-loop status still pass.

## Cucumber Tests

```gherkin
Feature: Post-processing lane replaces the failed-testing lane on the Tasks board

  Background:
    Given the Tasks board is rendered for an open folder with the orchestrate skill installed

  Scenario: The failed-testing lane is gone and post-processing takes its place
    When the board renders its lanes
    Then there is no lane with data-status "failed-testing"
    And there is a lane with data-status "post-processing"
    And the lane order left-to-right is "todo, defining, in-progress, testing, post-processing, done"

  Scenario: LANE_STATUSES and its renderer mirror agree on the new six-value order
    Given lib/ticket-lanes.js LANE_STATUSES
    And renderer.js TASKS_LANE_STATUSES
    Then both equal ["todo","defining","in-progress","testing","post-processing","done"]

  Scenario: failed-testing is still a known, valid status without its own lane
    Given a ticket with status "failed-testing"
    Then isKnownStatus("failed-testing") is true
    And laneForStatus("failed-testing") is "testing"
    And its card renders in the testing lane with the red "task-card-dot failed" marker

  Scenario: A post-processing ticket lands in the post-processing lane
    Given a ticket with status "post-processing" and kind "post-processing"
    Then laneForStatus("post-processing") is "post-processing"
    And its card appears in the post-processing lane
    And it is not marked unknown

  Scenario: Adding a post-processing ticket from the lane Add button
    When the user clicks the Add button in the post-processing lane header
    And enters a title and description and confirms
    Then a ticket file is written under tasks/post-processing/
    And its frontmatter has status "post-processing" and kind "post-processing"
    And it appears as a card in the post-processing lane

  Scenario: The toolbar New ticket button still creates a plain todo ticket
    When the user creates a ticket via the toolbar "New ticket" button
    Then the frontmatter has status "todo"
    And the frontmatter has no "kind" field
    And the card appears in the todo lane

  Scenario: Post-processing tickets are excluded from the build swarm
    Given a board containing a todo ticket and a post-processing ticket
    When selectNextBatch chooses the next batch
    Then only the todo ticket is selected
    And the post-processing ticket is never claimed
    And the Build button pending count does not include the post-processing ticket

  Scenario: Completion ordering runs post-processing before done
    Given the orchestrate SKILL.md contract
    Then it documents the ordering "testing -> tech-lead review -> post-processing -> done"
    And it states post-processing tickets are identified by kind "post-processing" and are never built/tested by the swarm

  Scenario: The assets copy stays byte-identical (drift guard)
    Given .claude/skills/orchestrate/SKILL.md has been edited
    Then assets/skills/orchestrate/SKILL.md is byte-for-byte identical to it

  # Failure / edge scenarios
  Scenario: Editing a failed-testing ticket in the detail modal does not silently relabel it
    Given a ticket with status "failed-testing" (a status not offered in the modal select)
    When the user opens it in the detail modal and saves without changing the status
    Then the saved status is still "failed-testing"
    And it is NOT rewritten to "todo"

  Scenario: An existing failed-testing ticket on disk keeps working after the change
    Given a pre-existing file tasks/failed-testing/TASK-015-x.md with status "failed-testing"
    When the board polls and renders
    Then the ticket still loads and shows its red failed dot in the testing lane
    And it remains claimable by claimTicket (CLAIMABLE_STATUSES still includes failed-testing)
    And it is not auto-moved out of tasks/failed-testing/

  Scenario: A genuinely out-of-enum status is still routed to the unknown lane, not post-processing
    Given a ticket with status "bogus"
    Then laneForStatus("bogus") is the unknown lane
    And it is not placed in the post-processing lane or the todo lane
```

## Relevant Files and Context

Status/lane logic (mirrored constants — must stay in lockstep):
- `lib/ticket-lanes.js` — canonical `LANE_STATUSES` (~line 24), `ACTIVE_STATUSES` (~30), `FAILED_STATUS` (~33), `UNKNOWN_STATUS` (~37), `isKnownStatus`/`isActiveStatus`/`isFailedStatus`/`laneForStatus`. Add the valid-statuses superset, `POST_PROCESSING_STATUS`, `POST_PROCESSING_KIND`, `isPostProcessingTicket`, and special-case `laneForStatus('failed-testing') -> 'testing'`.
- `renderer/renderer.js` — browser mirror (cannot `require`): `TASKS_LANE_STATUSES` (~5106), `TASKS_ACTIVE_STATUSES` (~5112), `TASKS_FAILED_STATUS` (~5115), `TASKS_UNKNOWN_STATUS` (~5119). Routing/dot decision in `renderTasksBoard` (~5595–5680); the lane-key routing (~5601–5604) currently falls back to `todo` for a missing lane — must instead fold `failed-testing` into `testing`; failed/active dot logic (~5672–5679). Folder mirror helpers `ticketFolderForStatus` (~5212) / `ticketFolderMatchesStatus` (~5218) must key off the valid-statuses set so `failed-testing` still files to `tasks/failed-testing/`.
- `lib/ticket-folders.js` — `folderForStatus` (~23) uses `isKnownStatus`; broadening `isKnownStatus` keeps both folders working. No signature change needed.
- `lib/ticket-queue.js` — `ACTIVE_STATUSES` (39) and `CLAIMABLE_STATUSES` (43) stay as-is (`todo`,`failed-testing` claimable). Confirm post-processing is excluded by `selectNextBatch` (217) / `claimTicket` (167). Add an explicit guard so a `kind: post-processing` ticket is never claimable even if its status were tampered to `todo`.

Board DOM / styles:
- `renderer/index.html` — lane divs (~632–659): replace the `data-status="failed-testing"` block (~648–651) with a `post-processing` lane containing an Add button; task detail modal status `<select>` (~47–54): replace the `failed-testing` option (~52) with `post-processing`. Toolbar "New ticket" button (~617).
- `renderer/styles.css` — per-lane header color rules (~2566–2572): replace the `failed-testing` rule (~2570) with a `post-processing` rule; keep `.task-card-dot.failed` (~2683) and `.task-card.unknown-status` (~2620). Add styling for the new `.tasks-lane-add` button.

Create-from-board wiring:
- `renderer/renderer.js` — `openNewTaskModal` (~6322–6400) hard-codes `status:'todo'` (~6360) and `ticketFolderForStatus('todo')` (~6378). Parameterise with a mode/kind so the Add button can create `status:'post-processing'`, `kind:'post-processing'` in `tasks/post-processing/`. Button binding pattern: `bindActionOnce` (~6352/6398) and toolbar binding of `tasksNewBtn -> openNewTaskModal` (~488); element cache (~460). `nextTaskId` (~6268) generates the next `TASK-nnn`.
- Frontmatter write goes through `serializeTicket` which keeps `id,title,status,created,updated` leading and preserves extra keys like `kind`/`order`/`agent` — mirror `orderFm`/`LEADING_KEYS` in `lib/ticket-queue.js` (52, 119).
- Board detail-modal save path `openTaskModal` (~5740) — `fill` sets `statusSel.value` (~5764) with a `todo` fallback, and `doWrite` writes `statusSel.value` (~5843); this is the silent-relabel edge case for `failed-testing`.

Skill / agent contract (DRIFT GUARD — edit both copies byte-for-byte):
- `.claude/skills/orchestrate/SKILL.md` — six-value enum + lane order, pickup set, fix loop, completion ordering Phase 4, "never invent a status". Update lane list to include `post-processing` (drop `failed-testing` from the *lane* list while keeping it as the failure status), document the `kind: post-processing` recipe tickets and the `testing → tech-lead review → post-processing → done` ordering.
- `assets/skills/orchestrate/SKILL.md` — MUST be byte-for-byte identical to the `.claude/` copy in the same change (enforced by `test/orchestrate-agents.test.js`).
- `.claude/agents/tester.md` (+ `assets/agents/tester.md`) — reference `failed-testing` as the failure status; these stay valid and generally need no change, but if edited, sync the assets copy byte-for-byte.

Tests to update (currently hard-code the old six-value lane list including `failed-testing`):
- `test/ticket-lanes.test.js` — `LANE_STATUSES` assertion, DOM lane-order assertion, renderer-mirror asserts, the "Failed tests show a red marker" scenario (currently expects `laneKey === 'failed-testing'`, now `'testing'`). Add coverage for `post-processing` and the valid-vs-lane split.
- `test/readme-docs.test.js` and `test/readme-docs-task013.test.js` — lane lists.
- `test/orchestrate-tech-lead.test.js` — `SIX_STATUSES` and `tasks/failed-testing/...` id-scan fixture.
- `test/orchestrate-testing-step.test.js` and `test/tasks-working-indicator.test.js` — assert `failed-testing` stays a valid fix-loop/idle status; keep passing.
- `test/ticket-queue.test.js` — `CLAIMABLE_STATUSES` stays `['failed-testing','todo']`; add a case proving a `kind: post-processing` ticket is never selected.
- `README.md` — board lane documentation.

Patterns: pure Electron-free lib modules unit-tested with `node --test`; renderer duplicates tiny constants/predicates with a "keep in lockstep" comment; whole-file `serializeTicket` writes with `created` preserved and `updated` bumped; folder-per-status reconciliation via `relocateTicketFile`; `bindActionOnce` for modal buttons.

## Edge and Failure Cases
- **Silent status relabel:** opening a `failed-testing` ticket in the detail modal whose select lacks that option must not rewrite it to `todo` on save. Preserve the stored status.
- **Existing on-disk `failed-testing` tickets:** must keep loading, keep the red dot (now in the Testing lane), stay in `tasks/failed-testing/`, and remain claimable/re-buildable. No forced migration.
- **`failed-testing` folding routing:** current routing falls back to `todo` when a lane key is missing — removing the `failed-testing` lane must not dump those cards into `todo`; route them explicitly to Testing.
- **Post-processing ticket must never be built:** guard against a `kind: post-processing` ticket ever being claimed/coded/tested/marked done by the swarm, even if its `status` is tampered to `todo`/`failed-testing`.
- **`kind` key round-trip:** the new `kind` frontmatter field must survive whole-file rewrites, board polls, drag-to-status moves, and app restarts.
- **Drag interactions:** dragging a normal card onto post-processing sets `status: post-processing` (removing it from the build queue) but does NOT add `kind: post-processing`; the done→todo bug-report drag flow must remain intact. Spec whether a card dragged out of post-processing keeps or clears `kind`.
- **Unknown vs post-processing:** a genuinely out-of-enum status (`bogus`) must still route to the `unknown` lane, never to `post-processing` or `todo`.
- **Empty title on Add:** the post-processing create modal must reject an empty title (reuse the existing "Title is required" guard) and re-arm the create handler.
- **Id collision:** `nextTaskId` must continue the global `TASK-nnn` max across all status subfolders (including `tasks/post-processing/` and `tasks/failed-testing/`).
- **Drift guard failure:** editing only `.claude/...` without syncing its `assets/` counterpart turns `test/orchestrate-agents.test.js` red.
- **Mirror drift:** `LANE_STATUSES` (lib) vs `TASKS_LANE_STATUSES` (renderer) vs index.html lane DOM vs CSS color rules must all agree.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
