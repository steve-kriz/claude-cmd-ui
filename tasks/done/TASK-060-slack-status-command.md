---
id: TASK-060
title: Slack command "status" — report session, Claude and board activity in-thread
status: done
created: 2026-07-19T00:00:00Z
updated: 2026-07-19T20:30:00Z
---

## Description
Add a `status` command: typing "status" in the anchor thread posts a one-shot
snapshot of the session — the open project folder, whether Claude is currently
busy or idle, how many Slack messages are queued for Claude (`s.inbox`), the
live transport (Socket Mode vs polling), and how many tickets are actively
being worked (ACTIVE_STATUSES on the board). Pure formatting lives in
`lib/slack-commands.js` as `formatStatusReply(info)`; the renderer handler
gathers `info` from existing state (`tab.folder`, `tab.status`,
`tab.slack.transport`, `tab.slack.inbox.length`, and a force
`pollTasksOnce(tab, true)` board read like TASK-058).

## Acceptance Criteria
- [ ] `lib/slack-commands.js`: `DEFAULT_COMMANDS` gains entry
      `{ name: 'status', description: 'Show session status: folder, Claude activity, queue and active tickets', patterns: ['status', 'show status', "what's your status", 'are you busy'] }`.
- [ ] `lib/slack-commands.js`: new export `formatStatusReply(info)` where
      `info = { folder, claudeState, transport, queued, activeTickets }`;
      returns mrkdwn lines: folder ("(no folder open)" when falsy), Claude
      state ("busy" for `busy`, otherwise "idle"), transport ("Socket Mode" for
      'socket', "polling" for 'poll', "none" otherwise), queued count, and
      "Active tickets: N" — or "Active tickets: unknown" when `activeTickets`
      is null/undefined (board unreadable). Never throws for a missing/partial
      `info` object.
- [ ] Renderer: mirror entry + `formatStatusReply` verbatim; add
      `SLACK_COMMAND_HANDLERS.status = async (tab) => …` that gathers the info:
      `activeTickets` = count of `tab.tasks.tickets` values whose `fm.status`
      is in the ACTIVE statuses mirror after `await pollTasksOnce(tab, true)`
      when a folder is open, else `null`; wraps the board read in try/catch and
      passes `null` on failure.
- [ ] Reply posted into the anchor thread via TASK-057 plumbing; never
      forwarded to Claude; works while Claude is busy and correctly reports
      "busy" in that case.
- [ ] Unit tests for `formatStatusReply` (all field variants incl. missing
      info) + phrase matching; source-scan for the renderer handler (force
      poll, try/catch, null on failure); Gherkin harness: status during busy
      run reports busy and queue length. `node --test` passes.

## Cucumber Tests
```gherkin
Feature: "status" Slack command

  Scenario: Status while Claude is busy
    Given a connected proxy with folder C:\proj, tab.status "busy",
      transport "poll", 2 queued inbox messages, and 1 in-progress ticket
    When a user replies "status" in the anchor thread
    Then a reply is posted containing "busy", "polling", "Queued: 2" and "Active tickets: 1"
    And nothing is written to the Claude pty

  Scenario: Status while idle over Socket Mode
    Given tab.status "idle" and transport "socket" with an empty inbox
    When the status command runs
    Then the reply contains "idle", "Socket Mode" and "Queued: 0"

  Scenario: No folder open (edge)
    Given no project folder is open
    When the status command runs
    Then the reply contains "(no folder open)" and "Active tickets: unknown"

  Scenario: Board read failure is degraded, not fatal (failure)
    Given the board read throws during the handler
    Then the handler still returns a reply with "Active tickets: unknown"
    And the renderer does not crash

  Scenario: Partial info never throws (failure)
    When formatStatusReply is called with {} and with null-ish fields
    Then it returns a well-formed string and does not throw
```

## Edge Cases & Failure Paths
- `info` missing entirely / partially → placeholders, no throw.
- Board read failure or no folder → `activeTickets: null` → "unknown", never a
  crash or a silent no-reply.
- "are you busy" must match; "are you busy with the build" must NOT (exact
  phrase matching).
- transport `null` (listening off) → "none".
- Apostrophe variant: pattern normalization must survive the literal
  "what's your status" (normalizeCommandInput strips only TRAILING punctuation,
  so the apostrophe is preserved — keep it in the pattern verbatim).

## Relevant Files & Context
- EDIT `lib/slack-commands.js` (entry + `formatStatusReply`).
- EDIT `renderer/renderer.js`: handler in `SLACK_COMMAND_HANDLERS`; state
  sources: `tab.folder`, `tab.status` (values 'busy'/'finished'/'idle', see
  slackTryDispatch ~7839), `tab.slack.transport` (~7462 'poll' / 'socket'),
  `tab.slack.inbox`, `pollTasksOnce` (~5501), tasks active-status mirror
  (TASKS_ACTIVE_STATUSES region ~5018 per lib/ticket-queue.js comment).
- READ `lib/ticket-lanes.js` ACTIVE_STATUSES (defining/in-progress/testing) —
  use the LANES set (includes 'defining') for "actively worked", matching the
  board's blue-dot semantics.
- EDIT `test/slack-commands.test.js` + wiring test file. Runner: `node --test`.
- Depends on: TASK-056, TASK-057 (TASK-058's force-poll pattern is the
  reference implementation for the board read).

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
