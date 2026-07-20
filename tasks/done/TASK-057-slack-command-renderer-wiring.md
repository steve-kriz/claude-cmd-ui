---
id: TASK-057
title: Renderer wiring — intercept Slack thread commands and reply in-thread instead of forwarding to Claude
status: done
created: 2026-07-19T00:00:00Z
updated: 2026-07-19T19:22:00Z
---

## Description
Wire the TASK-056 command core into the Slack proxy's inbound pipeline. Today
`handleIncomingSlackMessage(tab, msg)` (renderer/renderer.js ~7807) decodes the
reply text, appends it to the Slack pane, pushes it into `s.inbox`, and
`slackTryDispatch` later types it into the Claude pty when idle. After this
ticket, a reply whose text matches a registered command is answered by the APP:
it is NEVER pushed into `s.inbox` (so it never reaches Claude, even queued), its
handler runs immediately (commands must work while Claude is busy — they bypass
the idle gate entirely), and the handler's reply text is posted back into the
SAME session anchor thread via the existing `postToSlack(tab, text, s.threadTs)`
(which already chunks >3800 chars, marks its own `ts` seen, and surfaces send
failures). The renderer cannot `require()` lib modules, so it gets a VERBATIM
mirror of the TASK-056 pure functions with the standard "Mirrors … in
lib/slack-commands.js" comment (same convention as `slackProxyEnabled` /
`slackShouldDispatchIncoming` at ~7773).

Handler model: a renderer-side map `SLACK_COMMAND_HANDLERS` from command `name`
to `async (tab, msg) => string` (the reply text). This ticket ships the map
EMPTY plus the dispatch plumbing; TASK-058/059/060 add entries. Because
`DEFAULT_COMMANDS` is still empty after TASK-056, behavior is unchanged for
users until those tickets land — but all plumbing is testable now with injected
registries/handlers.

## Acceptance Criteria
- [ ] `renderer/renderer.js` gains a verbatim mirror of `normalizeCommandInput`,
      `matchCommand`, `listCommands` and a `SLACK_DEFAULT_COMMANDS` array,
      each annotated "Mirrors … in lib/slack-commands.js; keep in sync".
- [ ] `handleIncomingSlackMessage` checks `matchCommand(text, …)` AFTER
      `decodeSlackText` + the empty-text guard and AFTER `appendSlackMessage`
      (the user's command still shows in the pane), and BEFORE `s.inbox.push` /
      `slackTryDispatch`. On a match it calls a new
      `handleSlackCommand(tab, matched, msg)` and RETURNS — the message never
      enters the inbox and no pty write ever occurs for it.
- [ ] `handleSlackCommand` is async and: looks up the handler in
      `SLACK_COMMAND_HANDLERS`; if none is registered for the matched name,
      posts "That command isn't available in this session." into the anchor
      thread; if the handler resolves text, posts it via
      `postToSlack(tab, replyText, tab.slack.threadTs)` and appends it to the
      Slack pane as `{ who: 'system' }`; if the handler THROWS or rejects,
      catches the error, posts a short failure reply ("Command failed: <msg>")
      into the thread, and never crashes the renderer.
- [ ] Commands execute even when `tab.status` is `busy` or `awaitingResponse`
      is true (no idle gating), and do NOT touch `s.awaitingResponse`,
      `s.captureBuffer`, or `tab.status` — the in-flight Claude run is
      unaffected.
- [ ] Loop safety: the command reply is posted via `postToSlack`, so its `ts`
      lands in `s.seenTs` and the bot filter drops the poller's echo — assert no
      redispatch (existing `shouldDispatchIncoming` covers this; the test proves
      the composed behavior).
- [ ] Non-command replies behave byte-for-byte as before: appended, pushed to
      inbox, dispatched idle-gated (regression-guarded by source scan + harness).
- [ ] When the proxy is not enabled (`!slackProxyEnabled(s)`) nothing changes:
      `handleIncomingSlackMessage` is only reachable through
      `ingestSlackMessage`/`shouldDispatchIncoming`, which already no-op — do
      not add a second path.
- [ ] New test file `test/slack-command-wiring.test.js` (`node --test`):
      source-scan guards on renderer/renderer.js (matcher called before
      inbox.push; command path returns before dispatch; postToSlack targeted at
      s.threadTs; error path present) PLUS a Gherkin harness (fake pty + fake
      in-memory `window.api.slack.post` capture, verbatim-mirrored pipeline)
      proving: command → 1 thread post, 0 pty writes; non-command → pty write;
      throwing handler → failure reply posted, 0 pty writes; unknown-name →
      "isn't available" reply. All existing tests still pass.

## Cucumber Tests
```gherkin
Feature: Slack thread commands answered by the app, not Claude

  Scenario: A registered command is answered in the thread and never reaches Claude
    Given a connected proxy with anchor thread T and a registered command "ping"
      whose handler returns "pong"
    When a user reply "ping" arrives in thread T
    Then "pong" is posted into thread T exactly once
    And nothing is written to the Claude pty
    And the inbox stays empty

  Scenario: Commands work while Claude is busy
    Given the same proxy with tab.status = "busy" and awaitingResponse = true
    When a user reply "ping" arrives in thread T
    Then "pong" is still posted into thread T
    And awaitingResponse and captureBuffer are unchanged

  Scenario: Non-command replies still go to Claude (regression)
    Given the same proxy, idle
    When a user reply "run the build" arrives in thread T
    Then it is written to the Claude pty followed by Enter
    And no command reply is posted

  Scenario: The bot's own command reply is not re-ingested (loop guard)
    Given "pong" was posted and its ts recorded in seenTs
    When the poller returns that same message
    Then it is rejected (bot/seen) and nothing further is posted or typed

  Scenario: A handler failure is reported, not fatal (failure)
    Given a registered command "boom" whose handler throws "kaput"
    When a user reply "boom" arrives in thread T
    Then a reply containing "Command failed" and "kaput" is posted into thread T
    And nothing is written to the Claude pty and the renderer does not crash

  Scenario: A matched command with no renderer handler (edge)
    Given the registry matches "ghost" but SLACK_COMMAND_HANDLERS has no entry
    When a user reply "ghost" arrives in thread T
    Then "That command isn't available in this session." is posted into thread T
```

## Edge Cases & Failure Paths
- Handler throws synchronously OR rejects → caught; failure reply posted; no
  crash; message never forwarded to Claude (even as a fallback).
- `postToSlack` failure while posting the command reply → existing error path
  (slackStatus 'send failed', system message) fires; no retry loop.
- Matched command while disconnected mid-flight (`threadTs` cleared between
  match and post) → `postToSlack` no-ops (`slackProxyEnabled` guard); no throw.
- Empty/whitespace handler return value → post nothing (skip `postToSlack`),
  still append nothing misleading to the pane.
- Command text arriving via Socket Mode takes the same path (both transports
  funnel through `ingestSlackMessage` → `handleIncomingSlackMessage`).

## Relevant Files & Context
- EDIT `renderer/renderer.js`: `handleIncomingSlackMessage` (~7807),
  `slackTryDispatch` (~7833), `postToSlack` (~7891), `appendSlackMessage`
  (~7974), mirror block region (~7765 "Slack proxy decision logic (mirrors
  lib/slack-proxy.js)") — add the new mirror + `SLACK_COMMAND_HANDLERS` +
  `handleSlackCommand` near there.
- READ `lib/slack-commands.js` (TASK-056) — source of truth being mirrored.
- READ `lib/slack-proxy.js` — dispatch decisions; do not change them.
- No main.js / preload.js changes: command replies reuse the existing
  `slack:post` IPC via `window.api.slack.post` inside `postToSlack`.
- CREATE `test/slack-command-wiring.test.js` — copy the structure of
  `test/slack-thread-replies.test.js` (source-scan `fnBody` helper + harness
  with fake pty/post; PART 2 + PART 3 style). No real network/Electron.
- Depends on: TASK-056.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
