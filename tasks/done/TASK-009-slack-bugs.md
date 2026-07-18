---
id: TASK-009
title: slack bugs
status: done
created: 2026-07-18T04:33:57.166Z
updated: 2026-07-18T06:22:41Z
---

## Description
When Slack is connected, the app should use one Slack thread as a two-way proxy
between the Claude window (the cmd pane / terminal) and Slack, so people can hold
a back-and-forth conversation with Claude from Slack. On connect the app must
create a single anchor message in the channel and reuse its `thread_ts` for the
whole session. Output from the Claude window is posted into that anchor thread;
replies people write in that thread are received (Socket Mode via
`startSlackSocket`, or polling via `pollSlackOnce`), shown in the app's Slack chat
view, and written into the Claude window (`window.api.pty.write` to `tab.cmd.id`,
then Enter) when Claude is idle.

Current behaviour has bugs to fix: `connectSlack` never creates an anchor
message, and outbound posting only happens as a reply threaded on each inbound
message's `ts` (`s.replyThreadTs = item.ts` in `slackTryDispatch`, posted in
`slackOnFinished` via `postToSlack`). That means there is no single reusable
thread — each inbound message spawns its own thread — and Claude output is only
sent back in response to a Slack-originated prompt. The bot's own posts must
never loop back into the Claude window (existing `bot_id` / `botUserId` /
`seenTs` filtering in `handleIncomingSlackMessage`). When Slack is not connected,
proxying must be a no-op.

## Acceptance Criteria
- [x] On a successful `connect`, exactly one anchor message is posted to the channel (`chat.postMessage` / `window.api.slack.post`) and its returned `ts` is stored as the session thread (e.g. `s.threadTs`); on a failed connect no anchor message is created.
- [x] The anchor thread is created once per connect and reused: all subsequent outbound posts and inbound-reply threading use the stored session `thread_ts`, never a new top-level message per line or per reply.
- [x] Outbound: output from the Claude window (cmd pane) is posted into the Slack anchor thread using `thread_ts` = the stored session thread.
- [x] Inbound: a reply written in the Slack anchor thread is received (Socket Mode or polling), appended to the app's Slack chat view (`appendSlackMessage`), and written into the Claude window (`window.api.pty.write` to `tab.cmd.id` followed by Enter), gated on Claude being idle (`finished`/`idle`, not awaiting a TUI selection) as `slackTryDispatch` already requires.
- [x] The bot's own posts are never fed back into the Claude window (filtered by `bot_id` / `botUserId` / `seenTs`), so outbound messages do not loop back as new prompts.
- [x] When Slack is not connected, both directions are a no-op: no `chat.postMessage` is attempted and no Slack-originated `pty.write` occurs, and the Claude window behaves exactly as it does without Slack.
- [x] On disconnect, folder switch, or tab close, the stored session thread and Slack state are cleared (`stopSlackListening`) so a later reconnect creates a fresh single anchor rather than reusing a stale thread or creating duplicates.
- [x] Error/edge path: if a Slack send fails (`post` returns `ok:false`/error) or the connection drops mid-session, the failure is surfaced to the user (Slack status/message) and neither the app nor the Claude window crashes; the send failure does not leave `awaitingResponse` stuck.

## Cucumber Tests
```gherkin
Feature: Slack thread proxy for the Claude window

  Background:
    Given the app has a valid Slack bot token and a resolvable channel

  Scenario: Connecting creates a single anchor thread
    When Slack connects successfully to the channel
    Then exactly one anchor message is posted to the channel
    And its ts is stored as the session thread

  Scenario: Failed connect creates no anchor message
    Given the channel cannot be resolved
    When a Slack connect is attempted
    Then no anchor message is posted to the channel
    And the session thread remains unset

  Scenario: Outbound Claude output goes to the anchor thread
    Given Slack is connected with a session thread
    When the Claude window produces output to proxy
    Then the output is posted with thread_ts equal to the session thread
    And no new top-level channel message is created

  Scenario: The same thread is reused across multiple messages
    Given Slack is connected with a session thread
    When three separate messages are proxied to Slack
    Then all three are posted into the same session thread
    And no additional top-level anchor messages are created

  Scenario: Inbound thread reply reaches the Claude window
    Given Slack is connected and the Claude window is idle
    When a person replies "run the tests" in the anchor thread
    Then the reply is shown in the app's Slack chat view
    And "run the tests" is written into the Claude window followed by Enter

  Scenario: Inbound reply waits while Claude is busy
    Given Slack is connected and the Claude window is busy
    When a person replies in the anchor thread
    Then the reply is queued and not written until Claude becomes idle

  Scenario: The bot's own posts do not loop back
    Given Slack is connected
    When the app posts Claude's output into the thread
    Then that posted message is not fed back into the Claude window as a new prompt

  Scenario: No-op when Slack is not connected
    Given Slack is not connected
    When the Claude window produces output
    Then no chat.postMessage is attempted
    And no Slack-originated input is written to the Claude window

  Scenario: Disconnect clears the session thread
    Given Slack is connected with a session thread
    When the user disconnects Slack
    And later reconnects
    Then a fresh single anchor message is created
    And the old thread is not reused

  Scenario: Edge — a failed Slack send is surfaced and non-fatal
    Given Slack is connected with a session thread
    When posting Claude's output to Slack returns an error
    Then the error is surfaced in the Slack status
    And the app and Claude window keep running
    And the proxy is not left permanently awaiting a response
```

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
