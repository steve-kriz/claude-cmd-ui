---
id: TASK-058
title: Slack command "show me the tasks" — reply in-thread with the live tasks board
status: done
created: 2026-07-19T00:00:00Z
updated: 2026-07-19T19:55:00Z
---

## Description
First real command on the TASK-056/057 framework: when a user types
"show me the tasks" (or an alias) in the session anchor thread, the app replies
in the same thread with what the agents are currently working on, read from the
tasks/ board (frontmatter is authoritative — same data the Tasks tab renders).
Two parts:
1. PURE (lib/slack-commands.js): register the command and add a
   `formatTasksSummary(tickets)` formatter that turns an array of ticket
   frontmatter objects into Slack mrkdwn text.
2. RENDERER: a `tasks` entry in `SLACK_COMMAND_HANDLERS` that refreshes the
   board via the existing `pollTasksOnce(tab, true)` (force bypasses the
   "tasks tab visible" gating) and formats `tab.tasks.tickets`.

Summary content: a "Currently working on" section listing every ticket whose
status is an ACTIVE status (`defining`, `in-progress`, `testing` — see
ACTIVE_STATUSES in lib/ticket-lanes.js) as "TASK-0NN — <title> (<status>)",
`failed-testing` tickets listed separately as failed, then one per-lane count
line in LANE_STATUSES order (todo → defining → in-progress → testing →
post-processing → done), with unknown statuses counted under "unknown".

## Acceptance Criteria
- [ ] `lib/slack-commands.js`: `DEFAULT_COMMANDS` gains entry
      `{ name: 'tasks', description: 'Show the tasks board and what is being worked on', patterns: ['show me the tasks', 'show tasks', 'list tasks', 'tasks', 'what are you working on'] }`.
- [ ] `lib/slack-commands.js`: new export `formatTasksSummary(tickets)` — input
      is an array of `{ fm }` wrappers OR bare fm objects (tolerate both, same
      unwrap idiom as lib/ticket-queue.js `ticketOrderValue`). Uses
      `LANE_STATUSES`, `ACTIVE_STATUSES`, `FAILED_STATUS`, `laneForStatus` from
      `require('./ticket-lanes')` (still Electron-free). Output is a single
      mrkdwn string: `*Currently working on:*` lines for active tickets (or
      "Nothing is being worked on right now."), a `*Failed testing:*` line list
      when any `failed-testing` tickets exist, and a lane-counts line like
      `todo 3 · defining 1 · in-progress 2 · testing 1 · post-processing 2 · done 40`.
      Tickets missing id/title render with placeholders ("(no id)" / "(untitled)")
      rather than throwing; an empty/null array returns
      "The tasks board is empty.".
- [ ] Renderer: mirror the new command entry + `formatTasksSummary` verbatim
      (with the "Mirrors lib/slack-commands.js" comment) reusing the EXISTING
      renderer mirrors `TASKS_VALID_STATUSES` / lane helpers where they already
      exist (~5100–5290) instead of duplicating constants a third time.
- [ ] Renderer: `SLACK_COMMAND_HANDLERS.tasks = async (tab) => …` which:
      returns "No project folder is open." when `!tab.folder`; else checks
      `window.api.fs.exists(tasksJoin(tab.folder, 'tasks'))` and returns
      "No tasks board found in this project." when absent; else awaits
      `pollTasksOnce(tab, true)` and returns
      `formatTasksSummary(Array.from(tab.tasks.tickets.values()))`.
- [ ] The reply is posted into the session anchor thread by the TASK-057
      plumbing (no direct posting from the handler) and the command message is
      never forwarded to Claude.
- [ ] Replies longer than one Slack message are handled by the existing
      `chunkText`/`postToSlack` chunking — no new truncation logic.
- [ ] New tests in `test/slack-commands.test.js` (formatter + registry entry,
      unit) and `test/slack-command-wiring.test.js` or a new
      `test/slack-tasks-command.test.js`: source-scan for the handler wiring
      (exists-guard, force poll, formatter call) + Gherkin harness over an
      in-memory board (array of fm objects) and fake post capture. No real
      FS/network — the harness injects tickets; `node --test` passes.

## Cucumber Tests
```gherkin
Feature: "show me the tasks" Slack command

  Scenario: Active work is reported from the live board
    Given a connected proxy and a board with TASK-101 "API" in-progress,
      TASK-102 "UI" testing, and TASK-103 "Docs" todo
    When a user replies "Show me the tasks?" in the anchor thread
    Then a reply is posted into the thread containing "TASK-101 — API (in-progress)"
      and "TASK-102 — UI (testing)"
    And the counts line reports todo 1, in-progress 1, testing 1
    And nothing is written to the Claude pty

  Scenario: Alias phrases trigger the same command
    When a user replies "what are you working on" in the anchor thread
    Then the same tasks summary reply is posted

  Scenario: Nothing active
    Given a board whose tickets are all todo or done
    When the tasks command runs
    Then the reply contains "Nothing is being worked on right now."

  Scenario: failed-testing is surfaced, not hidden (edge)
    Given a board with TASK-104 in failed-testing
    When the tasks command runs
    Then the reply lists TASK-104 under "Failed testing:"

  Scenario: Empty board (edge)
    Given a tasks/ folder with no parseable tickets
    When the tasks command runs
    Then the reply is "The tasks board is empty."

  Scenario: No folder / no board (failure)
    Given no project folder is open
    When the tasks command runs
    Then the reply is "No project folder is open."
    Given a folder without a tasks/ directory
    When the tasks command runs
    Then the reply is "No tasks board found in this project."

  Scenario: Malformed ticket never crashes the formatter (failure)
    Given a board containing a ticket with no id and no title
    When formatTasksSummary runs
    Then it returns text containing "(no id)" and "(untitled)" and does not throw
```

## Edge Cases & Failure Paths
- `pollTasksOnce` internal failure (fs:findByExt not ok) leaves an empty map →
  reply degrades to "The tasks board is empty." — never silence, never a throw.
- Ticket with out-of-enum status → counted under "unknown" (laneForStatus →
  UNKNOWN_STATUS), never dropped or miscounted into todo.
- Duplicate ids mid-move are already deduped by `dedupeTicketsByFolder` before
  they reach `tab.tasks.tickets` — the handler must read the map AFTER the
  awaited force poll, not a stale snapshot.
- Very large boards → mrkdwn stays one line per active ticket + one counts
  line; chunking covers overflow.
- Command issued while Claude is busy → still answered (TASK-057 guarantees).

## Relevant Files & Context
- EDIT `lib/slack-commands.js` (registry entry + `formatTasksSummary`;
  require `./ticket-lanes` for LANE_STATUSES / ACTIVE_STATUSES / FAILED_STATUS /
  laneForStatus — do NOT redefine them).
- EDIT `renderer/renderer.js`: `SLACK_COMMAND_HANDLERS` (TASK-057),
  `pollTasksOnce` (~5501, note the `force` parameter and `t.fetching` guard),
  `tasksJoin`, `tab.tasks.tickets` Map values `{ file, path, folder, fm, body, raw }`
  (~5537), existing lane/status mirrors (~5100–5290).
- READ `lib/ticket-lanes.js` (lane semantics), `lib/ticket-queue.js`
  (fm-unwrap idiom), `renderer/renderer.js` `parseTicketFrontmatter` (~5164).
- Tests: extend `test/slack-commands.test.js`; harness patterns from
  `test/slack-thread-replies.test.js` PART 3. Runner: `node --test`. No real
  disk board — inject fm arrays.
- Depends on: TASK-056, TASK-057.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
