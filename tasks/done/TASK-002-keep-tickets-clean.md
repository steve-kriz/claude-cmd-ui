---
id: TASK-002
title: Keep tickets clean
status: done
created: 2026-07-18T03:52:57.304Z
updated: 2026-07-18T04:41:52Z
---

## Description
Each ticket should represent one discrete, independently testable bit of
functionality, and the board should make it obvious when an agent is actively
working a ticket. While a ticket is in flight, its card must show a "being
worked on" indicator, and a durable history of what the agents did — the
prompts sent to the coder/tester subagents and the responses they returned —
must be kept inside the ticket file itself so anyone reading the ticket later
can see how it was built.

This interacts with the orchestration contract in
`.claude/skills/orchestrate/SKILL.md`, which states that only the orchestrator
edits a ticket's body/frontmatter and that subagents never touch ticket files.
So the history must be recorded **by the orchestrator** (writing the whole file
in one write, per the live-board rules) — the subagents still only return their
results in-band. The history lives in a new body section and must not disturb
the user-owned `## Additional Context` section. The per-card "working" indicator
is a new UI concept: today a status dot exists only for tabs
(`.ws-tab-dot`, `slackTabDot`), not for individual task cards on the Tasks board.

## Acceptance Criteria
- [ ] A task card on the Tasks board shows a visible "being worked on" indicator (a status dot) whenever the ticket's status is an actively-worked state (`in-progress` or `testing`).
- [ ] A task card in an idle state (`todo`, `done`, `failed-testing`) shows no "being worked on" indicator.
- [ ] The indicator state is derived only from the ticket's frontmatter `status`, so it updates within one board poll cycle after the status changes on disk.
- [ ] The orchestrator records each subagent interaction (the prompt sent and the response returned) into a dedicated history section of the ticket file (e.g. `## History` / work log), appended in chronological order.
- [ ] Each history entry is timestamped and labelled with the role/phase it came from (e.g. coder, tester) so the sequence of work is legible.
- [ ] History is written by the orchestrator with a single whole-file write; subagents do not write to the ticket file themselves (the SKILL contract is preserved).
- [ ] Appending history preserves every other section verbatim, and never edits or deletes the user-owned `## Additional Context` section.
- [ ] The ticket retains a single discrete scope: enriching/working one ticket never merges or writes into another ticket file.

## Cucumber Tests
```gherkin
Feature: Keep tickets clean — working indicator and in-ticket history

  Background:
    Given the Tasks board is open on a folder containing ticket files

  Scenario: An actively-worked ticket shows the working indicator
    Given ticket TASK-100 has status "in-progress"
    When the board renders
    Then the card for TASK-100 shows the "being worked on" indicator

  Scenario: A testing ticket also shows the working indicator
    Given ticket TASK-100 has status "testing"
    When the board renders
    Then the card for TASK-100 shows the "being worked on" indicator

  Scenario: An idle ticket shows no working indicator
    Given ticket TASK-100 has status "todo"
    When the board renders
    Then the card for TASK-100 shows no "being worked on" indicator

  Scenario: The indicator clears after work finishes
    Given ticket TASK-100 has status "in-progress" and shows the working indicator
    When its status changes to "done" on disk
    And the board polls again
    Then the card for TASK-100 shows no "being worked on" indicator

  Scenario: The orchestrator records prompt and response history in the ticket
    Given the orchestrator sends a coder subagent the full text of TASK-100
    When the subagent returns its result
    Then the ticket file gains a history entry containing the prompt and the response
    And the entry is timestamped and labelled with the coder role
    And the entry is appended after any earlier history entries

  Scenario: History is written whole-file and preserves user content
    Given TASK-100 has an "## Additional Context" section written by the user
    When the orchestrator appends a new history entry
    Then the file is rewritten in a single write
    And the "## Additional Context" section is byte-for-byte unchanged

  Scenario: Subagents never edit the ticket file directly
    Given a coder subagent is working TASK-100
    When the subagent completes
    Then the ticket file was only ever written by the orchestrator
    And the subagent made no write to the ticket file

  Scenario: Recording history for one ticket never writes another ticket
    Given tickets TASK-100 and TASK-101 both exist
    When the orchestrator appends history to TASK-100
    Then TASK-101's file is left unchanged
```

## History
### 2026-07-18T04:38:36Z — coder
**Prompt:** Implement TASK-002: per-card "being worked on" dot on the Tasks board
(derived purely from `status` ∈ {in-progress, testing}) plus a testable,
Electron-free helper for appending timestamped, role-labelled `## History`
entries without disturbing `## Additional Context`. Do not touch ticket files or
the SKILL.

**Response:** Added `TASKS_ACTIVE_STATUSES = ['in-progress','testing']` and a
`.task-card-dot` span (rendered only for active statuses) in
`renderer/renderer.js` `renderTasksBoard`; added `.task-card-dot` + pulse
keyframes in `renderer/styles.css` (blue `#3794ff`, styled after `.ws-tab-dot`).
Created `lib/ticket-history.js` (Electron-free) exporting
`appendHistoryEntry(markdown, { role, prompt, response, timestamp })` plus
`formatHistoryEntry` and `HISTORY_HEADING`/`ADDITIONAL_CONTEXT_HEADING`
constants. Helper splits on level-2 headings, appends chronologically under
`## History`, inserts it before `## Additional Context`, and preserves all other
sections verbatim. No tests written (tester owns them); suggested
`test/ticket-history.test.js`.

### 2026-07-18T04:41:52Z — tester
**Prompt:** Write automated tests for the working-indicator predicate and
`lib/ticket-history.js`, mock all external calls, run the full suite, report
pass/fail. Do not modify production code.

**Response:** Added `test/ticket-history.test.js` (18 tests) and
`test/tasks-working-indicator.test.js` (9 tests). The indicator test reads the
real `TASKS_ACTIVE_STATUSES` constant from `renderer.js` source and exercises
the exact `includes(status)` gate, plus asserts the CSS `.task-card-dot` rule +
keyframes exist. `npm test` → tests 59, pass 59, fail 0 (~4.2s). Pre-existing
suites still green; no production code modified. Live DOM rendering/animation
and orchestration-runtime write guarantees remain app-exercisable only.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
