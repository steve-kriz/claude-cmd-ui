---
id: TASK-073
title: slack output LLM summary
status: done
created: 2026-07-20T00:40:00Z
updated: 2026-07-19T12:29:09.260Z
activities: [{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-19T12:02:30Z","finishedAt":"2026-07-19T12:10:46Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-19T12:10:46Z","finishedAt":"2026-07-19T12:15:10Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-19T12:15:10Z","finishedAt":"2026-07-19T12:18:00Z"},{"activity":"post-processing","model":"claude-opus-4-8","startedAt":"2026-07-19T12:18:00Z","finishedAt":"2026-07-19T12:19:13Z"}]
---

## Description
Follow-up to TASK-071. The user wants auto-posted Slack output to be **summarized**
into a short, human-readable message (not just mechanically cleaned). TASK-071
delivers the deterministic mechanical cleanup; THIS ticket adds an **LLM
summarization** step on top of it, using a fast Claude model (Haiku).

**Important architecture note (verified during planning):** the app currently has
**no** LLM/API client — there is no `@anthropic-ai` SDK in `package.json` and no
Anthropic API usage anywhere in the codebase (the only outbound HTTP is the Slack
API in `lib/slack.js` and cloud-logs). So this ticket is NOT a small helper; it
requires new infrastructure:
1. An Anthropic API client (add `@anthropic-ai/sdk`, or a minimal `https` client
   in `main.js` following the `lib/slack.js` pattern) that runs in the **main**
   process, not the renderer.
2. **API-key management**: read `ANTHROPIC_API_KEY` from the environment and/or a
   user-configured setting; never hard-code, never log, never post the key.
   Gracefully no-op the summarization (fall back to TASK-071's cleaned output) when
   no key is configured.
3. **Renderer→main IPC**: a new IPC channel (e.g. `slack:summarize`) so the
   renderer's auto-post path can request a summary from main; keep the pattern
   consistent with existing `window.api.*` bridges in `preload`.
4. **Redact-before-send (security-critical)**: terminal output must be passed
   through `redactSecrets` (and TASK-071's `humanizeSlackOutput`) **before** it is
   sent to the Anthropic API — the external summarizer must never receive
   un-redacted secrets. The summary returned by the model is then redacted **again**
   before posting (defense in depth, in case the model echoes sensitive text).

Pipeline on the auto-post paths becomes:
`postToSlack( redactSecrets( summarize( redactSecrets( humanizeSlackOutput( cleanTerminalOutput(buffer) ) ) ) ) )`
— summarization sits on already-cleaned, already-redacted text; a final redaction
stays last. When summarization is disabled/unavailable/errors, the path falls back
to exactly TASK-071's behavior (post the cleaned+redacted text).

Model: a fast, cheap model — `claude-haiku-4-5` (the current Haiku). Keep the model
id in one config constant so it is easy to change.

## Acceptance Criteria
- [ ] A main-process summarizer that calls the Anthropic Messages API with
  `claude-haiku-4-5`, given already-cleaned+redacted text, returning a short
  human-readable summary string. Prompt instructs: summarize this terminal output
  for a human reading Slack; be concise; preserve concrete results
  (pass/fail, file names, errors); do not invent facts.
- [ ] API key is read from `ANTHROPIC_API_KEY` (env and/or a settings field), never
  hard-coded/logged/posted. With no key configured, summarization is disabled and
  the auto-post path falls back to TASK-071's cleaned+redacted output (feature-flag
  safe).
- [ ] Renderer→main IPC channel added (e.g. `slack:summarize`) with a matching
  `preload` bridge; the renderer auto-post paths (`slackOnFinished`,
  `slackFlushTick`) call it and post the summary.
- [ ] Redact-before-send is enforced and covered by a test: the text handed to the
  Anthropic client is already redacted (no raw secret ever leaves the process); the
  returned summary is redacted again before `postToSlack`.
- [ ] Any summarizer failure (no key, network error, timeout, non-200, malformed
  response) never throws into the flush path and never blocks/loses a post — it
  falls back to posting TASK-071's cleaned+redacted output. A timeout bound is
  applied so a slow API call cannot stall the periodic flush.
- [ ] Summarization applies only to the two auto-post paths (not command replies /
  composer), consistent with TASK-071's scope.
- [ ] A user-facing toggle (setting) to enable/disable Slack summarization, default
  chosen during review; when off, behaves exactly as TASK-071.
- [ ] `docs/slack-integration.md` documents the summarization step, the key
  requirement, the redact-before-send guarantee, and the fallback behavior.
- [ ] Tests: unit tests for the summarizer wrapper with a **mocked** Anthropic
  client (success, no-key fallback, error/timeout fallback, redact-before-send
  assertion) — NO real API calls; an e2e/source-scan proving the auto-post pipeline
  order and the redact-before-send + redact-after invariants. `node --test` green
  aside from the two known pre-existing unrelated failures.

## Cucumber Tests
```gherkin
Feature: Summarize auto-posted Slack output with a fast LLM

  Scenario: Cleaned output is summarized before posting
    Given a configured API key and a busy window with long, cleaned terminal output
    When the finish flush runs
    Then the Anthropic client is called with the already-redacted cleaned text
    And a concise summary is posted to the anchor thread

  Scenario: Secrets are redacted before the text leaves the process (security)
    Given cleaned output that still contained "sk-abc123DEF456ghi789" before redaction
    When the flush requests a summary
    Then the text passed to the Anthropic client contains "***REDACTED***" and never the raw key

  Scenario: No API key falls back to the cleaned output (edge)
    Given no ANTHROPIC_API_KEY is configured
    When the flush runs
    Then no API call is made and the TASK-071 cleaned+redacted output is posted

  Scenario: Summarizer error never loses the post (failure)
    Given a configured key but the Anthropic call errors or times out
    When the flush runs
    Then the cleaned+redacted output is posted instead and the renderer does not throw

  Scenario: Summarization disabled behaves like TASK-071 (edge)
    Given the Slack-summarization setting is off
    When the flush runs
    Then the output is posted exactly as TASK-071 would post it
```

## Edge Cases & Failure Paths
- No API key / summarization disabled → silent fallback to TASK-071 output.
- Network error / non-200 / timeout / malformed response → fallback, never throw,
  never lose or duplicate a post (respect TASK-061 once-and-only-once + buffer
  clearing).
- The API call must be time-bounded so the 30s periodic flush is never stalled.
- Redact-before-send is mandatory; a regression here is a secret-leak — assert it
  in tests.
- Cost/rate: summarize only non-trivial windows (e.g. skip when the cleaned output
  is short/empty); consider a size threshold (align with TASK-071's "Hybrid" idea).
- Key never logged, never posted to Slack, never written to a ticket file.
- Model id (`claude-haiku-4-5`) kept in one constant for easy change.

## Relevant Files & Context
- `package.json` — add `@anthropic-ai/sdk` (or implement a minimal `https` client
  in main following `lib/slack.js`).
- `main.js` / `preload` — new IPC channel `slack:summarize`, key handling, the
  Anthropic call; mirror the existing `window.api.*` bridge conventions.
- `renderer/renderer.js` — `slackOnFinished` (~8471) and `slackFlushTick` (~8503)
  call the summarizer and post its (re-redacted) result; reuse TASK-071's
  `humanizeSlackOutput` + existing `redactSecrets`.
- `lib/slack-proxy.js` — `redactSecrets` (the redact-before-send + redact-after
  transform) and TASK-071's `humanizeSlackOutput`.
- `docs/slack-integration.md` — document the new step and guarantees.
- Consult `claude-api` skill / current model ids for the exact Haiku id and
  Messages API shape before implementing.
- Depends on: TASK-071 (consumes its cleaned output). Builds new infra used by
  potential future LLM features.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
