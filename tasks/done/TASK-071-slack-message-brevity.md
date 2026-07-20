---
id: TASK-071
title: slack message brevity
status: done
created: 2026-07-19T10:22:18.624Z
updated: 2026-07-19T11:42:19Z
activities: [{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-19T11:25:56Z","finishedAt":"2026-07-19T11:32:10Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-19T11:32:10Z","finishedAt":"2026-07-19T11:38:00Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-19T11:38:00Z","finishedAt":"2026-07-19T11:41:00Z"},{"activity":"post-processing","model":"claude-opus-4-8","startedAt":"2026-07-19T11:41:00Z","finishedAt":"2026-07-19T11:42:19Z"}]
---

## Description
When posting to Slack, clean up auto-posted Claude terminal output so it is human
readable (the user's original intent: "clean up the message so that it's human
readable"). Today both auto-post paths — the periodic flush (`slackFlushTick`,
`renderer/renderer.js:8503`) and the finish flush (`slackOnFinished`,
`renderer/renderer.js:8471`) — post `redactSecrets(cleanTerminalOutput(s.captureBuffer))`.
`cleanTerminalOutput` (`renderer/renderer.js:8591-8613`) strips ANSI, keeps the
final `\r`-redraw state of each line, drops some chrome, collapses 3+ blank lines
to 2, and tail-trims to 12,000 chars. What still reaches Slack is noisy:
consecutive duplicate lines from progressive TUI redraws, spinner/status lines
("✻ Thinking… (esc to interrupt)", elapsed/token counters), and residual
hint/footer lines.

**Scope of THIS ticket = deterministic mechanical cleanup only.** Add a pure,
Electron-free readability pass — `humanizeSlackOutput(text)` in `lib/slack-proxy.js`
with a **byte-identical renderer mirror** (the established lib-canonical + mirror
convention used by `redactSecrets` / `defangSlackControlSequences`) — inserted
**between** `cleanTerminalOutput` and `redactSecrets` on **both** auto-post paths,
so `redactSecrets` stays the final transform before posting and the TASK-063
"no auto-post path ever posts un-redacted output" guarantee is untouched. Cleanup
is mechanical only (dedupe / strip / collapse) — it never rewrites, reorders, or
summarizes content, so it can never reassemble a masked secret.

**Out of scope (moved to TASK-073):** LLM-based summarization of the output. The
user wants a summarized, shorter human-readable post, but that requires new
infrastructure the app does not have (an Anthropic API client, API-key management,
renderer→main IPC, redact-before-send). That is scoped as a separate follow-up
ticket, TASK-073, which builds on this ticket's cleaned output.

Decisions locked in during planning (see `## Clarifications`): mechanical cleanup
only in this ticket; keep the current 12,000-char tail + multi-message chunking
(no harder length cap); post as plain text (no code-block wrapping); apply only to
the two auto-post paths (command replies and the composer are NOT changed).

Concrete behaviors for `humanizeSlackOutput`:
- Collapse consecutive identical lines to one (TUI redraw dedupe).
- Drop known Claude-TUI status/hint noise lines: spinner-prefixed progress lines
  (a leading `✻ ✽ ✶ ✢ ·`-style glyph followed by a "…ing…" phrase), "(esc to
  interrupt)" hint lines, standalone elapsed/token counter lines, and `⏵⏵`-style
  hint lines. Only WHOLE noise lines are dropped — never a real content line that
  merely contains such a glyph mid-line.
- Collapse remaining runs of 2+ blank lines to a single blank line; trim outer
  whitespace.
- Never throws; non-string / null / undefined / numeric input returns `''`.

## Acceptance Criteria
- [ ] New pure export `humanizeSlackOutput(text)` in `lib/slack-proxy.js`
  (Electron-free, no DOM/network, module doc-comment updated) implementing:
  consecutive-duplicate-line collapse, TUI status/hint noise-line removal
  (spinner progress lines, "(esc to interrupt)" hints, standalone elapsed/token
  counter lines, `⏵⏵` hint lines), blank-run collapse to a single blank line, and
  outer trim. Non-string / null / undefined input returns `''`; never throws.
- [ ] Ordinary meaningful output (prose, code, file listings, test results) passes
  through unchanged apart from the documented dedupe / blank-line collapse — no
  false-positive deletion of real content lines.
- [ ] `renderer/renderer.js` gains a **byte-identical** mirror of
  `humanizeSlackOutput` with the standard "Mirrors … in lib/slack-proxy.js; keep
  in sync" comment (same convention as the `redactSecrets` /
  `defangSlackControlSequences` mirrors at `renderer/renderer.js:8044-8109`).
- [ ] Both auto-post paths apply it in the order
  `redactSecrets(humanizeSlackOutput(cleanTerminalOutput(buffer)))`:
  `slackOnFinished` (~`renderer/renderer.js:8481`) and `slackFlushTick`
  (~`renderer/renderer.js:8520`). `redactSecrets` remains the LAST transform
  before `postToSlack`.
- [ ] The command-reply path (`handleSlackCommand`) and the composer path
  (`sendSlackComposer`) are NOT changed — cleanup applies only to auto-posted
  Claude terminal output.
- [ ] Existing guarantees preserved: the capture buffer is still cleared before
  the await (once-and-only-once delivery, TASK-061); a window that cleans to `''`
  posts nothing while still consuming the buffer; `chunkText` / `postToSlack`
  chunking and the 12,000-char tail behavior are unchanged (no harder length cap).
- [ ] A buffer that is pure TUI noise (spinners / redraw duplicates only) now
  cleans to `''` and posts nothing.
- [ ] `docs/slack-integration.md` "Output posting" / "Security" sections updated
  to describe the new pass and its position before redaction.
- [ ] Tests: unit tests for `humanizeSlackOutput` (each behavior + null-safety +
  no false positives), a byte-identical mirror drift guard, and a source-scan/e2e
  proving both post paths apply the pipeline in the required order with
  `redactSecrets` last. `node --test` green aside from the two known pre-existing
  unrelated failures (`test/task-030-plan-button.e2e.test.js`,
  `test/task-034-routing-drift-guard.test.js`).

## Cucumber Tests
```gherkin
Feature: Auto-posted Claude output is cleaned up to be human readable

  Scenario: Consecutive duplicate redraw lines are collapsed
    Given captured output containing the same line "Running tests..." 5 times in a row
    When the finish flush posts to the anchor thread
    Then the posted text contains "Running tests..." exactly once

  Scenario: TUI spinner/status noise lines are removed
    Given captured output containing "✻ Thinking… (esc to interrupt)" between two real content lines
    When a periodic flush tick posts
    Then the posted text contains both content lines and no spinner/status line

  Scenario: Blank-line runs are collapsed
    Given cleaned output containing 2 or more consecutive blank lines
    When it is humanized
    Then at most one blank line separates the paragraphs

  Scenario: Ordinary output is untouched (edge)
    Given captured output "Build succeeded in 12s\n40 files compiled"
    When it is humanized
    Then the text is unchanged

  Scenario: Redaction still runs last and is never weakened (edge/security)
    Given captured output containing "export API_KEY=sk-abc123DEF456ghi789" repeated twice
    When the flush posts
    Then the posted text contains "***REDACTED***" and never the raw key

  Scenario: Pure-noise window posts nothing (edge)
    Given a busy window whose output is only spinner redraw noise
    When the flush tick runs
    Then no Slack post is made and the capture buffer is consumed

  Scenario: A mid-line glyph is not mistaken for a noise line (edge)
    Given a real content line that contains a "✻" character in the middle of the text
    When it is humanized
    Then that content line is preserved

  Scenario: Null/junk input is safe (failure)
    When humanizeSlackOutput is called with "", null, undefined and a number
    Then it returns a string and does not throw
```

## Edge Cases & Failure Paths
- Null / undefined / non-string input → `''`, never throws (matches every helper
  in `lib/slack-proxy.js`).
- Must not un-redact or bypass redaction: cleanup runs BEFORE `redactSecrets`; a
  source-scan must prove the order on both paths (pattern:
  `test/slack-redaction.test.js`). Never join/reorder text in a way that could
  reassemble a split secret.
- Deliberately repeated real content (e.g. a loop printing identical log lines) is
  collapsed by design — document as intended behavior.
- Must not strip lines that merely *contain* a spinner glyph mid-line; only whole
  noise lines.
- Windows line endings / mixed `\r\n` (input has already been `\r`-resolved by
  `cleanTerminalOutput`, but the helper should still tolerate raw `\r\n`).
- The empty-after-clean skip (`renderer/renderer.js:8522-8523`, `8485`) must keep
  consuming the buffer so no window is re-posted later.
- Mirror drift: lib and renderer copies must stay byte-identical (drift-guard test).

## Relevant Files & Context
- EDIT `lib/slack-proxy.js` — add `humanizeSlackOutput` next to `redactSecrets`
  (~line 107) / `defangSlackControlSequences` (~line 165); export it (~line 170).
- EDIT `renderer/renderer.js` — add the byte-identical mirror near the other proxy
  mirrors (~8044-8109); apply at `slackOnFinished` (~8481) and `slackFlushTick`
  (~8520). READ `cleanTerminalOutput` (8591-8613), `chunkText` (8575),
  `postToSlack` (8545), `ANSI_RE` (2880).
- READ / EDIT `docs/slack-integration.md` — "Output posting" and "Security"
  sections (the doc claims full traceability, so update it).
- Tests: NEW `test/slack-humanize.test.js` + `test/slack-humanize.e2e.test.js`,
  following the layer pattern of `test/slack-redaction.test.js` /
  `test/slack-redaction.e2e.test.js` (unit on the lib export, byte-identical
  mirror extraction via `fnBody`, source-scan of the two post paths, harness with
  a fake `window.api.slack.post` capture). Runner: `node --test`; no real
  Slack/network.
- Composes with: TASK-061 (flush), TASK-063 (redaction order — redact stays last),
  TASK-064 (defang is command-reply-path only, unchanged here).
- Follow-up: TASK-073 (LLM summary) consumes this ticket's cleaned output.

## Clarifications
- Q (071 depth): How aggressive should the cleanup be?
  A: Summarize, not just mechanical cleanup — BUT the LLM-summary work is split
  into a separate ticket (TASK-073). THIS ticket delivers the deterministic
  mechanical cleanup only.
- Q (071 length): How should post length be handled?
  A: Keep current — 12,000-char tail trim + multi-message chunking (no harder cap).
- Q (071 format): Wrap auto-posted output in a Slack code block?
  A: No — keep posting as plain text.
- Q (071 scope): Which Slack outputs get the cleanup?
  A: Auto-posts only (periodic + finish flush). Command replies and the composer
  are not changed.
- Q (071 LLM infrastructure): The app has no LLM/API client today; LLM
  summarization needs new infra (Anthropic client + API-key management + IPC +
  redact-before-send). How to proceed?
  A: Split into two tickets — ship mechanical cleanup now as TASK-071, and scope
  the LLM-summary path separately as TASK-073.
- Q (071 samples): Do you have concrete examples of noisy lines to anchor the
  strip patterns?
  A: None provided during planning; the coder should anchor patterns to the known
  Claude-TUI noise (spinner glyph + "…ing…", "(esc to interrupt)", standalone
  elapsed/token counters, `⏵⏵` hints) and keep the strip list easy to extend.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
