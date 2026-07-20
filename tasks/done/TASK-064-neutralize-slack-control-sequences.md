---
id: TASK-064
title: Neutralize Slack control sequences in app-posted command/failure replies
status: done
created: 2026-07-19T19:20:00Z
updated: 2026-07-19T21:30:00Z
---

## Description
Follow-up from the TASK-057 tech-lead review (low severity, latent). App-posted
command replies and the `"Command failed: <msg>"` failure reply in
`handleSlackCommand` (renderer/renderer.js) flow through `postToSlack` →
`slack.postMessage` (lib/slack.js ~179), which sends the text straight to Slack
`chat.postMessage` with no `parse`/`link_names` handling and no sanitization.
Slack honors already-encoded control sequences such as `<!channel>`, `<!here>`,
and `<@U…>` inside message text. Today the command handler map is empty so this
is unreachable, but TASK-058/059/060 add handlers that echo thread/ticket/error
-derived content into replies — at which point a crafted Slack message could
induce a channel-wide `<!channel>` ping via the failure reply or a handler
reply. Neutralize Slack control sequences on the app-posted command/error reply
path before a live handler lands.

This is DISTINCT from TASK-063 (secret redaction) — that masks secrets in
auto-posted terminal output; this defangs Slack mention/broadcast markup in
command/error replies.

## Acceptance Criteria
- [ ] A pure, Electron-free helper (e.g. `defangSlackControlSequences(text)` in
      `lib/slack-proxy.js` or a small lib module) that neutralizes Slack broadcast
      /mention control sequences so they render as inert text — at minimum
      `<!channel>`, `<!here>`, `<!everyone>`, `<!subteam^…>`, and `<@U…>` /
      `<#C…>` link forms (e.g. by breaking the leading `<` so Slack does not
      interpret them). Ordinary text (including legitimate `<` in code/prose) is
      left readable; the helper never throws on null/undefined/non-string.
- [ ] The renderer keeps a verbatim mirror of the helper with the standard
      "Mirrors … in lib/…; keep in sync" comment.
- [ ] `handleSlackCommand` applies the defang to BOTH the handler reply text and
      the `"Command failed: <msg>"` string before calling `postToSlack`, so no
      app-posted command/error reply can inject a channel-wide mention. (Scope
      to command/error replies — do NOT change the behavior of user-composed
      messages or Claude output posting, which are separate paths.)
- [ ] Existing TASK-057 wiring behavior is otherwise unchanged (still posts to
      `s.threadTs`, still appends success replies to the pane, still catches
      throws/rejections).
- [ ] Unit tests for the helper (each control sequence defanged; ordinary text
      unchanged; empty/null safe) AND a source-scan/e2e proving `handleSlackCommand`
      defangs both the reply and the failure text before posting. Full suite green
      under `node --test` (aside from the two known pre-existing unrelated
      failures).

## Cucumber Tests
```gherkin
Feature: App-posted command replies cannot trigger Slack broadcasts

  Scenario: A command reply containing <!channel> is defanged
    Given a handler that returns "done <!channel>"
    When handleSlackCommand posts the reply
    Then the posted text does not contain a live "<!channel>" broadcast sequence

  Scenario: A failure message echoing untrusted text is defanged
    Given a handler that throws an error whose message contains "<!here>"
    When handleSlackCommand posts "Command failed: …"
    Then the posted text does not contain a live "<!here>" broadcast sequence

  Scenario: Ordinary reply text is unchanged (edge)
    Given a handler that returns "Build passed in 12s"
    When the reply is posted
    Then the text is unchanged

  Scenario: Null/empty input is safe (failure/edge)
    When the defang helper is called with "", null, and undefined
    Then it returns a string and does not throw
```

## Edge Cases & Failure Paths
- Must defang the broadcast forms (`<!channel>`, `<!here>`, `<!everyone>`,
  `<!subteam^ID>`) and user/channel links (`<@U…>`, `<#C…>`), without mangling
  ordinary prose or breaking chunking.
- Helper never throws on non-string input.
- Keep the lib helper pure (unit-testable) and the renderer mirror byte-identical.

## Relevant Files & Context
- EDIT `lib/slack-proxy.js` (or a small lib helper) — pure defang function.
- EDIT `renderer/renderer.js`: `handleSlackCommand` (~7932-7951), reusing
  `postToSlack` (~8072). Add the verbatim mirror near the other slack mirrors.
- READ `lib/slack.js` (~179, `chat.postMessage`) to confirm no parse/link_names
  is set. READ `test/slack-command-wiring.test.js` for the source-scan pattern.
- Runner: `node --test`. Mock all Slack calls.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
