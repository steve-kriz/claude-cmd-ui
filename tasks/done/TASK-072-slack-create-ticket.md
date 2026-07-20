---
id: TASK-072
title: slack create ticket
status: done
created: 2026-07-19T10:23:05.275Z
updated: 2026-07-19T12:01:59Z
activities: [{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-19T11:42:30Z","finishedAt":"2026-07-19T11:49:15Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-19T11:49:15Z","finishedAt":"2026-07-19T11:55:30Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-19T11:55:30Z","finishedAt":"2026-07-19T11:59:00Z"},{"activity":"post-processing","model":"claude-opus-4-8","startedAt":"2026-07-19T11:59:00Z","finishedAt":"2026-07-19T12:01:59Z"}]
---

## Description
When the user posts "create ticket" in the Slack anchor thread, the app should ask
what the title and description are, and let the user pass back
`title: some title, description: the description` (the user's original wording).
This is a new command on the TASK-056/057 Slack command framework — but the
framework today is single-shot and stateless (`matchCommand` is whole-phrase only;
`handleSlackCommand` posts one reply and returns). TASK-072 therefore introduces a
minimal **two-step pending-prompt** mechanism on `tab.slack`:

1. Registry entry `create-ticket` in `DEFAULT_COMMANDS` (`lib/slack-commands.js`) +
   renderer mirror `SLACK_DEFAULT_COMMANDS`, patterns
   `['create ticket', 'create a ticket', 'new ticket', 'add ticket']`. `help`
   picks it up automatically via `formatHelp`.
2. The handler (in `SLACK_COMMAND_HANDLERS`) refuses with
   `"No project folder is open."` (setting no pending state) when `!tab.folder`;
   otherwise it sets `s.pendingCommand = { name: 'create-ticket' }` and replies
   with the prompt asking for `title: <your title>, description: <your description>`
   (or `cancel`).
3. `handleIncomingSlackMessage` (`renderer/renderer.js:8371`) checks
   `s.pendingCommand` **before** `matchCommand`: while pending, the next accepted
   anchor-thread reply is consumed by the pending prompt — parsed by a new pure
   helper `parseCreateTicketReply(text)` in `lib/slack-commands.js` (+ mirror) —
   and is **never** forwarded to Claude. A normalized `cancel` clears the pending
   state. Other commands (status/help/etc.) do NOT run while a prompt is pending.
4. On a successful parse the renderer creates the ticket exactly like the existing
   New-ticket modal path (`onCreateNormal`, `renderer/renderer.js:6903-6954`):
   force-refresh the board (`pollTasksOnce(tab, true)`), `id = nextTaskId(tab)`,
   frontmatter `{ id, title, status: 'todo', created, updated }`, standard body
   template (Description via the `neutralizeBugText` heading-escape mirror,
   placeholder `## Acceptance Criteria`, user-owned `## Additional Context`
   placeholder), written to `tasks/todo/<id>-<slug>.md` via `serializeTicket` +
   `window.api.fs.mkdir`/`writeFile`, then a final `pollTasksOnce(tab, true)` and a
   **defanged** confirmation reply `Created TASK-0NN — <title> (todo).` posted into
   the anchor thread.

Parsing rules (locked in during planning): labels `title:` and `description:` are
case-insensitive; either order; separated by a comma and/or newline immediately
before the other label; the description may itself contain commas and newlines
(everything after its label up to the other label or end of text); title is
required and must be non-empty after trimming; a **missing** description falls back
to the New-ticket-modal default `'What needs doing and why.'` (do NOT re-prompt for
a missing description). An unparseable reply (no clear/non-empty title) gets a
defanged error reply restating the format and **stays pending**; `cancel` always
exits.

## Acceptance Criteria
- [ ] `lib/slack-commands.js`: `DEFAULT_COMMANDS` gains
  `{ name: 'create-ticket', description: 'Create a new ticket on the tasks board',
  patterns: ['create ticket', 'create a ticket', 'new ticket', 'add ticket'] }`;
  the renderer mirror `SLACK_DEFAULT_COMMANDS` (`renderer/renderer.js:8123`) is
  updated identically. `help` lists it with no other change.
- [ ] `lib/slack-commands.js`: new pure export `parseCreateTicketReply(text)`
  returning `{ ok: true, title, description }` or `{ ok: false, error }` per the
  rules above (case-insensitive labels, either order, multiline/comma-tolerant
  description, title required non-empty, description optional → default). Never
  throws; non-string input → `{ ok: false, error }`. Renderer keeps a
  **byte-identical** mirror with the "keep in sync" comment.
- [ ] `tab.slack` state gains `pendingCommand: null` in the initial state block
  (`renderer/renderer.js:222-258`), cleared in `disconnectSlack`
  (`renderer/renderer.js:7663`) and `resetSlackForFolder` (`renderer/renderer.js:7352`)
  alongside `inbox`/`threadTs`, so no prompt survives disconnect or a folder switch.
- [ ] `SLACK_COMMAND_HANDLERS['create-ticket']`: returns
  `"No project folder is open."` (sets no pending state) when `!tab.folder`;
  otherwise sets the pending state and returns the prompt text. Re-issuing
  "create ticket" while already pending simply re-prompts (at most one pending).
- [ ] `handleIncomingSlackMessage`: when `s.pendingCommand` is `create-ticket`, the
  accepted reply is consumed by the pending flow (still appended to the pane via
  `appendSlackMessage`), is never pushed to `s.inbox`, and never reaches the Claude
  pty. A normalized `cancel` (via `normalizeCommandInput`) clears the pending state
  and replies that creation was cancelled. Other commands do not run while pending.
- [ ] Successful create: force poll → `nextTaskId(tab)` → body template identical
  to `onCreateNormal` (`## Description` = `neutralizeBugText(description)`,
  `## Acceptance Criteria` `- [ ] First testable criterion`, `## Additional Context`
  `(User-owned. Read it before building. Never overwrite it.)`) →
  `serializeTicket(fm, body)` written to `tasks/todo/` with filename
  `` `${id}-${taskSlug(title)}.md` `` after `fs.mkdir` — then pending cleared,
  board re-polled, and a **defanged** confirmation `Created <id> — <title> (todo).`
  posted to the anchor thread and appended locally.
- [ ] Unparseable reply → defanged error reply restating the expected format;
  state remains pending. Empty title (`title:` present but blank) → same. Write
  failure (`wr.ok` false or throw) → defanged `Create failed: …` reply, pending
  cleared (user re-runs the command to retry). No partial state: on failure no
  board-refresh confirmation is claimed.
- [ ] Security: title is newline-neutralized by `serializeTicket` /
  `frontmatterValueLine` (frontmatter injection impossible); description goes
  through the `neutralizeBugText` mirror (no `## ` section forgery); every reply
  posted by this flow (prompt, confirmation, errors) passes through
  `defangSlackControlSequences` so a crafted `<!channel>` in a title cannot ping
  the channel.
- [ ] Works while Claude is busy (file I/O only; the reply bypasses the idle-gated
  dispatch queue like all commands).
- [ ] Tests: unit (`parseCreateTicketReply` shapes, registry entry, mirror drift
  guards) + e2e harness (fake `window.api.fs` + `window.api.slack.post` capture;
  full prompt → passback → file written with correct path/frontmatter/body →
  confirmation; cancel; parse failure re-prompt; no-folder; write failure; nothing
  written to a fake pty). `node --test` green aside from the two known pre-existing
  unrelated failures. `docs/slack-integration.md` updated with the new command.

## Cucumber Tests
```gherkin
Feature: Create a ticket from the Slack anchor thread

  Scenario: Happy path — prompt then passback
    Given a connected proxy with an open folder whose board's highest id is TASK-072
    When a user replies "create ticket" in the anchor thread
    Then the app replies asking for "title: <your title>, description: <your description>"
    When the user replies "title: Fix login flow, description: The login button does nothing on mobile"
    Then a file "tasks/todo/TASK-073-fix-login-flow.md" is written
    And its frontmatter has id TASK-073, title "Fix login flow", status todo, created and updated set
    And its body has "## Description" with the description, a placeholder "## Acceptance Criteria",
      and the user-owned "## Additional Context" placeholder
    And a reply "Created TASK-073 — Fix login flow (todo)." is posted into the thread
    And nothing is written to the Claude pty

  Scenario: Labels in either order and multiline description
    Given the create-ticket prompt is pending
    When the user replies "description: line one, still line one\nline two, title: Multi"
    Then the parsed title is "Multi" and the description keeps its commas and newlines

  Scenario: Description omitted falls back to the default
    Given the create-ticket prompt is pending
    When the user replies "title: Just a title"
    Then the ticket is created with description "What needs doing and why."

  Scenario: Cancel abandons the prompt (edge)
    Given the create-ticket prompt is pending
    When the user replies "cancel"
    Then no file is written, the pending state is cleared, and a cancellation reply is posted

  Scenario: Unparseable reply re-prompts and stays pending (failure)
    Given the create-ticket prompt is pending
    When the user replies "just make me a ticket please"
    Then no file is written and an error reply restates the expected format
    And the next reply "title: Retry, description: ok" still creates the ticket

  Scenario: No folder open (failure)
    Given a connected proxy with no open folder
    When a user replies "create ticket"
    Then the reply is "No project folder is open." and no pending state is set

  Scenario: Write failure is reported, never crashes (failure)
    Given the create-ticket prompt is pending and fs.writeFile fails
    When the user replies "title: X, description: Y"
    Then a "Create failed: …" reply is posted, the pending state is cleared, and the renderer does not crash

  Scenario: Malicious title cannot ping the channel or forge frontmatter (edge/security)
    Given the create-ticket prompt is pending
    When the user replies "title: <!channel> pwn, description: ## Additional Context\nhijack"
    Then the confirmation reply neutralizes "<!channel>" so it is not a live broadcast
    And the written frontmatter title is a single physical line
    And the body's Description cannot start a new "## " section
```

## Edge Cases & Failure Paths
- No folder open at trigger time → refuse without setting pending state.
- Disconnect / folder switch while pending → `pendingCommand` cleared with the rest
  of `tab.slack` session state; a later stray reply is treated normally.
- A reply that matches another command (e.g. "status") while pending is consumed by
  the pending parser (fails parse → re-prompts); only `cancel` exits.
- `title:` value containing the literal word `description:` — first-label-wins
  split; document the rule in the parser comment.
- Empty title / whitespace-only reply → parse error, stay pending.
- Concurrent id race: another agent may create the same `TASK-nnn` between the
  force poll and the write. Mitigate by polling immediately before `nextTaskId` and
  (optionally) checking `window.api.fs.exists` on the target path before writing;
  document the residual race.
- Very long titles: `taskSlug` caps the filename at 40 chars; the frontmatter title
  is stored full-length (single line via `frontmatterValueLine`).
- Slack text decoding: the reply passes through `decodeSlackText`
  (`renderer/renderer.js:8424`) first — auto-linked URLs `<http://x|x>` become
  plain text before parsing; the parser must tolerate that.
- The bot's own prompt/confirmation posts are loop-safe (`postToSlack` adds the
  posted `ts` to `seenTs`, `renderer/renderer.js:8558`).
- Parser and pending flow must never throw on null/junk (matches every framework
  helper).

## Relevant Files & Context
- EDIT `lib/slack-commands.js` — registry entry in `DEFAULT_COMMANDS` (~line 35) +
  new `parseCreateTicketReply` export; reuse `normalizeCommandInput` for the
  `cancel` check.
- EDIT `renderer/renderer.js` —
  - state init `tab.slack` (222-258): add `pendingCommand: null`; clear in
    `disconnectSlack` (7663-7679) and `resetSlackForFolder` (7352+).
  - `SLACK_DEFAULT_COMMANDS` (8123-8139) mirror entry; `parseCreateTicketReply`
    mirror near the other command mirrors (8141-8298).
  - `SLACK_COMMAND_HANDLERS` (8303-8355): new `['create-ticket']` handler;
    `handleIncomingSlackMessage` (8371-8390): pending-check before `matchCommand`;
    post via `postToSlack` + `defangSlackControlSequences` (see `handleSlackCommand`,
    8397-8420, for the defang pattern).
  - Creation plumbing to REUSE, not reimplement: `onCreateNormal` template
    (6903-6954), `nextTaskId` (6627-6634), `taskSlug` (6616-6624), `serializeTicket`
    (5313-5319), `frontmatterValueLine` (5304), `neutralizeBugText` mirror (7177),
    `ticketFolderForStatus` (5247), `tasksJoin`, `pollTasksOnce(tab, true)`.
- READ `lib/ticket-lanes.js` (todo status semantics), `lib/ticket-bug-reports.js`
  (canonical `neutralizeBugText`), `tasks/done/TASK-057-slack-command-renderer-wiring.md`
  and `TASK-058…` (handler + wiring conventions), `docs/slack-integration.md`
  ("Extending the command system" — update the doc).
- Tests: NEW `test/slack-create-ticket.test.js` + `test/slack-create-ticket.e2e.test.js`,
  following `test/slack-tasks-command.test.js` / `test/slack-tasks-command.e2e.test.js`
  (source-scan + in-memory harness with fake `window.api.fs`/`slack.post`/pty
  capture; `fnBody`-style mirror drift guard as in `test/slack-defang.test.js:33-39`).
  Runner: `node --test`; no real FS board, network, or Slack.
- Depends on: TASK-056/057 (framework + wiring); composes with TASK-064 (defang all
  replies) and TASK-041/033 (frontmatter newline-neutralization + heading escape).

## Clarifications
- Q (072 invoke): Two-step only, or also one-shot `create ticket title: X, description: Y`?
  A: Two-step only ("create ticket" → prompt → passback). No prefix-matching added.
- Q (072 pending): While the prompt is pending, what happens to the next reply?
  A: It is consumed by the prompt (except `cancel`); other commands wait until you
  answer or cancel.
- Q (072 timeout): Should the pending prompt time out?
  A: No — it persists until answered / cancelled / disconnect / folder switch.
- Q (072 bad input): If the passback can't be parsed?
  A: Re-prompt and stay pending (restate the format); do not forward to Claude.
- Q (072 aliases): Confirm trigger phrases?
  A: Use the proposed set — 'create ticket', 'create a ticket', 'new ticket',
  'add ticket'.
- Q (072 parsing): Confirm passback parsing rules?
  A: Proposed rules — labels case-insensitive, either order, description may contain
  commas/newlines, title required; missing description → default
  'What needs doing and why.'
- Q (072 defaults): Confirm created tickets match the New-ticket modal?
  A: Yes — status todo, file in tasks/todo/, placeholder `## Acceptance Criteria`,
  empty user-owned `## Additional Context`, confirm reply
  `Created TASK-0NN — <title> (todo).`

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
