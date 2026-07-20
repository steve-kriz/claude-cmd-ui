---
id: TASK-063
title: Redact secrets/tokens from Claude terminal output before auto-posting to Slack
status: done
created: 2026-07-19T18:40:00Z
updated: 2026-07-19T21:00:00Z
---

## Description
Follow-up from the TASK-061 tech-lead review (this is the actionable item from
the TASK-035 post-processing security review). The app auto-posts Claude
terminal output to the Slack thread. `cleanTerminalOutput` in
`renderer/renderer.js` (~8013-8035) strips ANSI/TUI chrome but performs NO
secret/token redaction. Terminal output routinely contains echoed environment
variables, API keys, and command output. TASK-061 broadened this exposure: output
is now posted continuously mid-run (not only at idle), and because `onCmdData`
tail-trims to the last 200k, a long run that previously only ever posted its final
200k window now posts ALL windows across the run — so more complete terminal
content reaches Slack, more often.

Add a redaction pass that masks common secret shapes on the post path shared by
BOTH the interval flush (`slackFlushTick`) and `slackOnFinished`, so no code path
posts un-redacted output.

## Acceptance Criteria
- [ ] A pure, Electron-free redaction helper (e.g. `redactSecrets(text)` in a lib
      module such as `lib/slack-proxy.js` or a new `lib/secret-redaction.js`)
      that masks common secret patterns while leaving ordinary text intact.
      Cover at least: `sk-`/`xoxb-`/`xoxp-`/`ghp_`/`AKIA…` style tokens, long
      hex/base64 blobs above a length threshold, `KEY=VALUE` / `TOKEN: value`
      pairs where the key name looks secret (matches /secret|token|key|password|
      passwd|pwd|apikey/i), and Bearer tokens. Masked output replaces the secret
      with a fixed placeholder (e.g. `***REDACTED***`) and never throws.
- [ ] The renderer keeps a verbatim mirror of the helper (with the standard
      "Mirrors … in lib/…; keep in sync" comment) since it cannot require lib
      modules — matching the existing mirror convention.
- [ ] The redaction is applied on the SHARED post path so BOTH `slackFlushTick`
      and `slackOnFinished` post redacted text (and ideally `sendSlackComposer`
      too if it forwards terminal content) — no auto-post path bypasses it.
- [ ] Redaction runs AFTER `cleanTerminalOutput` and does not break existing
      chunking (`chunkText`/`postToSlack`) or the once-and-only-once delivery
      guarantee from TASK-061.
- [ ] Ordinary, non-secret terminal output is posted unchanged (no false-positive
      mangling of normal prose/code beyond the documented secret shapes).
- [ ] Unit tests for the redaction helper (each secret shape masked; ordinary
      text untouched; empty/null → safe) AND an e2e/source-scan proving both the
      flush path and the finish path post redacted text. Full suite green under
      `node --test` (aside from the two known pre-existing unrelated failures).

## Cucumber Tests
```gherkin
Feature: Secrets are redacted before reaching Slack

  Scenario: An API key in terminal output is masked on the mid-run flush
    Given a busy run whose captured output contains "export OPENAI_API_KEY=sk-abc123DEF456ghi789"
    When a flush tick posts to the thread
    Then the posted text contains "***REDACTED***" and does not contain "sk-abc123DEF456ghi789"

  Scenario: A Slack bot token is masked on the finish flush
    Given a run that finishes with "token=xoxb-1234-5678-abcdef" in the buffer
    When slackOnFinished posts the remainder
    Then the posted text does not contain the raw xoxb- token

  Scenario: Ordinary output is posted unchanged (edge)
    Given captured output "Build succeeded in 12s, 40 files compiled"
    When it is posted
    Then the text is unchanged (no false-positive redaction)

  Scenario: Empty/null input is safe (failure/edge)
    When redactSecrets is called with "", null, and undefined
    Then it returns a string and does not throw
```

## Edge Cases & Failure Paths
- Both auto-post paths (flush + finish) must redact — a regression that adds a
  third post path must also route through redaction (guard with a source-scan).
- Redaction must not corrupt multi-byte/normal text or break chunk boundaries.
- Helper must never throw on null/undefined/non-string.
- Keep the lib helper pure (unit-testable with `node --test`) and the renderer
  mirror byte-identical.

## Relevant Files & Context
- EDIT `lib/slack-proxy.js` (or CREATE `lib/secret-redaction.js`) — pure helper.
- EDIT `renderer/renderer.js`: `cleanTerminalOutput` (~8013), `slackFlushTick`
  (~7942, TASK-061), `slackOnFinished` (~7905), `postToSlack` (~7891) — apply
  redaction on the shared post path; add the verbatim mirror.
- READ `test/slack-flush.test.js`, `test/slack-proxy.test.js` for the
  source-scan/mirror test patterns to follow.
- Runner: `node --test`. Mock all Slack calls — no real network.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
