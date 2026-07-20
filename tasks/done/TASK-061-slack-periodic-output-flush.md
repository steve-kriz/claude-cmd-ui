---
id: TASK-061
title: Post Claude output to the Slack thread periodically during long runs (not only at idle)
status: done
created: 2026-07-19T00:00:00Z
updated: 2026-07-19T18:45:00Z
---

## Description
The feature request says ALL Claude output must be posted into the session
thread. Today output is captured continuously (onCmdData appends to
`tab.slack.captureBuffer` whenever the proxy is enabled, renderer/renderer.js
~1155–1163) but is only POSTED when the run goes idle (`slackOnFinished`
~7866). A long orchestrate run can work for many minutes with the Slack thread
silent. Fix: while a run is busy, flush the accumulated capture to the anchor
thread on a fixed interval (default 30s), leaving `slackOnFinished` to post the
final remainder exactly as it does now. The flush consumes the buffer at each
tick, so nothing is ever double-posted.

Add the decision as a pure helper `shouldFlushCapture(state)` in
`lib/slack-proxy.js` (proxy enabled AND `postReplies` AND non-empty capture AND
busy) with the renderer keeping its usual verbatim mirror, so the rule is
unit-testable without Electron.

## Acceptance Criteria
- [ ] `lib/slack-proxy.js`: new export `shouldFlushCapture(state)` returning
      true only when `isProxyEnabled(state)` AND `state.postReplies` AND
      `state.captureBuffer` is a non-empty string AND `state.busy` is true;
      false (never throws) for null/partial state. Module stays pure.
- [ ] Renderer: a per-tab flush interval (`tab.slack.flushTimer`, default
      `SLACK_FLUSH_INTERVAL_MS = 30000`) started by `startSlackListening` and
      cleared by `stopSlackListening` (which disconnect, folder switches and
      tab close already funnel through) AND by `resetSlackForFolder` /
      `disconnectSlack` (timer nulled; no leak — mirror how `pollTimer` is
      handled at ~7586/7596).
- [ ] Each tick: build `state = { connected, threadTs, postReplies, captureBuffer, busy: tab.status === 'busy' }`,
      apply the mirrored `shouldFlushCapture`; when true, take
      `cleanTerminalOutput(s.captureBuffer)`, CLEAR `s.captureBuffer` BEFORE the
      await (so output arriving during the post lands in the next window), and
      when the cleaned text is non-empty post it with
      `postToSlack(tab, text, s.threadTs)` and `appendSlackMessage(tab, { who: 'claude', text })`.
      When the cleaned text is empty, post nothing (buffer stays consumed).
- [ ] `slackOnFinished` behavior is unchanged: at idle it flushes whatever
      remains in the buffer; combined with the interval flush, every byte of
      captured output is posted exactly once (no overlap, no duplicate posts).
- [ ] A flush-post failure is surfaced by the existing postToSlack error path
      (slackStatus + system message) and is NOT retried with the same text (no
      duplicate risk); the interval keeps running for later output.
- [ ] Flushing does not touch `s.awaitingResponse`, `s.inbox`, `tab.status`, or
      reply dispatching — inbound behavior is untouched.
- [ ] With `postReplies` unchecked, or when idle, or when disconnected, the
      timer ticks are no-ops (decision helper returns false).
- [ ] New tests in a `test/slack-flush.test.js` (or extend
      test/slack-proxy.test.js): unit tests for `shouldFlushCapture` truth
      table; source-scan that renderer starts/clears `flushTimer` in the four
      lifecycle sites, clears the buffer before posting, and reuses
      cleanTerminalOutput/postToSlack; Gherkin harness (fake post capture +
      manual tick function) proving once-and-only-once delivery across
      interval flush + finish flush. `node --test` passes, existing
      slack-proxy source-scans still pass (the lib/renderer mirrors stay in
      sync).

## Cucumber Tests
```gherkin
Feature: Claude output reaches the Slack thread during long runs

  Scenario: Output is posted mid-run on the flush interval
    Given a connected proxy with postReplies on and a busy run that has
      produced "step 1 done" into the capture buffer
    When a flush tick fires
    Then "step 1 done" (cleaned) is posted into the anchor thread
    And the capture buffer is empty afterwards

  Scenario: No double-posting at the end of the run
    Given "part A" was flushed mid-run and the run then produces "part B"
    When the run goes idle and slackOnFinished fires
    Then only "part B" is posted by the finish flush
    And "part A" appears in the thread exactly once overall

  Scenario: Idle ticks are no-ops (edge)
    Given the proxy is connected but tab.status is "idle" with a non-empty buffer
    When a flush tick fires
    Then nothing is posted and the buffer is left for slackOnFinished

  Scenario: postReplies off suppresses mid-run posting (edge)
    Given postReplies is unchecked and a busy run with buffered output
    When a flush tick fires
    Then nothing is posted

  Scenario: Only TUI chrome in the window (edge)
    Given the buffer contains only ANSI redraw/box-drawing chrome
    When a flush tick fires
    Then cleanTerminalOutput yields empty text, nothing is posted,
      and the buffer is still consumed

  Scenario: A flush post fails (failure)
    Given Slack chat.postMessage returns ok:false "ratelimited"
    When a flush tick posts
    Then the failure is surfaced in the Slack pane/status, the same text is not
      re-posted, and the next tick still runs

  Scenario: Disconnect clears the flush timer (failure/lifecycle)
    Given a running flush interval
    When the user disconnects Slack
    Then the timer is cleared and no further ticks post anything
```

## Edge Cases & Failure Paths
- Buffer cleared BEFORE the awaited post → output produced during the post is
  never lost or double-sent (it lands in the next window).
- Buffer >200k is already tail-trimmed by onCmdData; the flush inherits that.
- cleanTerminalOutput returning '' (pure TUI redraw noise) → skip post, buffer
  consumed, no empty Slack messages.
- Rapid connect/disconnect/reconnect → exactly one timer alive (clear before
  set, mirroring `startSlackPolling`'s `clearInterval` guard).
- Renderer mirror of `shouldFlushCapture` must carry the "Mirrors … in
  lib/slack-proxy.js; keep in sync" comment — test/slack-proxy.test.js
  source-scans the mirror region.

## Relevant Files & Context
- EDIT `lib/slack-proxy.js` (add `shouldFlushCapture`, export it; keep module
  pure — no timers in the lib, decision only).
- EDIT `renderer/renderer.js`: onCmdData capture (~1155–1163),
  `slackOnFinished` (~7866), `postToSlack` (~7891), `cleanTerminalOutput`
  (~7937), `startSlackListening` (~7452), `stopSlackListening` (~7468),
  `disconnectSlack` (~7432), `resetSlackForFolder` (~7124), slack state object
  (~218–251: add `flushTimer: null`), proxy mirror block (~7765).
- READ `test/slack-proxy.test.js` (mirror source-scan patterns that must keep
  passing) and `test/slack-thread-replies.test.js` (harness style).
- No main.js / preload.js changes (reuses `slack:post`).
- Independent of the command tickets; can be built in parallel with TASK-056+.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
