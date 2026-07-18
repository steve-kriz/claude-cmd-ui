---
id: TASK-005
title: claude questions
status: done
created: 2026-07-18T03:58:08.638Z
updated: 2026-07-18T05:16:32Z
startedAt: 2026-07-18T05:08:03Z
finishedAt: 2026-07-18T05:16:32Z
---

## Description
When an agent has a question it needs answered to continue a ticket, the board
must make that visible and let the user answer inside the ticket. Specifically:
turn the ticket's "being worked on" dot **yellow** to signal it is waiting on the
user, let the user provide an answer on the ticket, and store the chosen answer
with the ticket so anyone reading it later can see what was decided.

This builds on the "being worked on" indicator introduced in TASK-002. The
yellow "waiting" colour mirrors the existing tab convention, where a waiting tab
uses a distinct dot colour (`status-waiting` in `styles.css`) versus the busy
state — here the same idea applies per task card. The question and the chosen
answer are durable ticket content: because `serializeTicket` preserves unknown
frontmatter keys and body sections, the question/answer can be stored on the
ticket (frontmatter field or a labelled body section) and survive board polling.
All writes are whole-file and preserve the user-owned `## Additional Context`.

## Acceptance Criteria
- [ ] When an agent raises a question for a ticket, that ticket enters a "waiting for answer" state recorded on the ticket file.
- [ ] While a ticket is waiting for an answer, its "being worked on" dot turns yellow (distinct from the normal actively-worked colour and from idle).
- [ ] The user can supply an answer to the question from within the ticket (e.g. the ticket detail view / ticket file).
- [ ] The question text is stored on the ticket so a later reader can see what was asked.
- [ ] The chosen answer is stored with the ticket so a later reader can see what was decided.
- [ ] Once an answer is provided, the ticket leaves the yellow "waiting" state and can resume being worked.
- [ ] The dot colour is derived from the ticket's persisted question/waiting state, so it updates within one board poll after the state changes on disk.
- [ ] Storing the question/answer uses whole-file writes and never edits the user-owned `## Additional Context` section.

## Cucumber Tests
```gherkin
Feature: Claude questions — yellow dot and stored answers

  Background:
    Given the Tasks board is open on a folder with ticket files
    And ticket TASK-400 is being worked

  Scenario: A question turns the dot yellow
    When the agent raises a question for TASK-400
    Then TASK-400 is recorded as waiting for an answer
    And the card's "being worked on" dot is shown in yellow

  Scenario: The question is stored on the ticket
    When the agent raises the question "Which auth provider should we use?"
    Then TASK-400's file stores that question text

  Scenario: The user answers from within the ticket
    Given TASK-400 is waiting for an answer
    When the user enters the answer "Use OAuth v2" on the ticket
    Then the answer "Use OAuth v2" is stored with the ticket

  Scenario: A later reader can see the chosen answer
    Given TASK-400 was answered with "Use OAuth v2"
    When someone opens TASK-400 later
    Then both the question and the chosen answer are visible on the ticket

  Scenario: Answering clears the yellow waiting state
    Given TASK-400 is waiting for an answer with a yellow dot
    When the user provides an answer
    And the board polls again
    Then TASK-400 is no longer in the waiting state
    And the dot is no longer yellow

  Scenario: Writing the question/answer preserves user content
    Given TASK-400 has a user-owned "## Additional Context" section
    When the question and answer are stored
    Then the file is written whole
    And the "## Additional Context" section is unchanged
```

## History
### 2026-07-18T05:12:56Z — coder
**Prompt:** Implement TASK-005: yellow "waiting for answer" dot + durable
question/answer stored on the ticket. Build on TASK-002's `.task-card-dot`; add a
pure requireable `lib/` helper; persist via serializer-preserved keys; whole-file
writes; never touch `## Additional Context`, `tasks/`, or `.claude/skills/`.

**Response:** Storage = flat frontmatter keys `question` and `answer` (preserved
after the leading keys). Waiting is derived: `question` non-empty AND `answer`
empty/absent. Created `lib/ticket-questions.js` (pure, Electron-free):
`isWaitingForAnswer`/`hasQuestion`/`hasAnswer`/`askQuestion`/`answerQuestion`/
`clearQuestion` (+ `orderFm`/`toSingleLine`/`LEADING_KEYS`). In
`renderer/renderer.js` added a browser-side `isTicketWaitingForAnswer(fm)`
duplicate; `renderTasksBoard` shows the dot when active OR waiting and adds a
`waiting` modifier + tooltip; `openTaskModal` shows the question block, prefills
the stored answer, and folds a typed answer into `newFm.answer` on write (empty
answer stays waiting). Added `.task-modal-question` block in `index.html`;
`.task-card-dot.waiting` (yellow `#e5c100`, echoing `status-waiting`) + waiting
pulse keyframes and modal-question styling in `styles.css`. All writes whole-file
via `serializeTicket`; `## Additional Context` untouched. All 140 existing tests
still pass. No tests added (tester owns them). Note: on Node v24 run tests with
`node --test test/*.test.js` (the `test/` dir-arg form errors).

### 2026-07-18T05:16:32Z — tester
**Prompt:** Write cucumber e2e tests for the ticket's Gherkin plus unit tests for
`lib/ticket-questions.js` and the renderer waiting predicate/yellow-dot CSS. Mock
all external calls; run the full suite; report. Don't modify production code.

**Response:** Added `test/ticket-questions.test.js` (34 tests): unit coverage of
every `lib/ticket-questions.js` export (`askQuestion` sets `question`/clears prior
`answer`/bumps `updated`/preserves `created`/pure/leading-key order/multi-line
normalise; `answerQuestion`; `isWaitingForAnswer` true/false matrix;
`clearQuestion`); a serialize/parse round-trip using verbatim copies of the real
`parseTicketFrontmatter`/`serializeTicket`/`isTicketWaitingForAnswer` from
renderer.js, asserting `question`/`answer` survive and `## Additional Context` is
byte-for-byte unchanged; renderer-source contract tests for browser/lib predicate
parity, the `' waiting'` dot modifier wiring, and the
`.task-card-dot.waiting { background:#e5c100 }` yellow rule; and a `Feature:`
block implementing all 6 Gherkin scenarios e2e against an in-memory ticket store
(no real DB/FS/network). Full suite `node --test "test/*.test.js"` → tests 174,
pass 174, fail 0 (~4.3s). No production defects found; no production code
modified. Live DOM rendering/animation remains app-exercisable only.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
