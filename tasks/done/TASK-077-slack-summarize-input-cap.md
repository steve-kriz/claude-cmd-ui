---
id: TASK-077
title: bound slack:summarize input size in main (defense-in-depth)
status: done
created: 2026-07-19T12:19:13Z
updated: 2026-07-19T21:36:56Z
activities: [{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-19T21:11:03Z","finishedAt":"2026-07-19T21:15:53Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-19T21:15:53Z","finishedAt":"2026-07-19T21:24:31Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-19T21:24:31Z","finishedAt":"2026-07-19T21:33:22Z"},{"activity":"post-processing","model":"claude-opus-4-8","startedAt":"2026-07-19T21:33:22Z","finishedAt":"2026-07-19T21:36:56Z"}]
---

## Description
Follow-up from the tech-lead review of TASK-073 (slack output LLM summary). The
feature shipped and is secure as built; this is a **Low-severity defense-in-depth**
hardening the reviewer identified — not a live defect.

The main-process `slack:summarize` IPC handler (`main.js`, ~line 1669-1684) trusts
the incoming `text` verbatim and forwards it to the Anthropic Messages API. In
normal operation the renderer already bounds output to 12,000 chars via
`cleanTerminalOutput` before it ever reaches the bridge, so the risk today is low
(trusted first-party renderer, `contextIsolation` on). But if the renderer pipeline
ever regressed — or the channel were driven directly — main would forward an
unbounded payload to an external, billed API. A length clamp in main bounds cost
and DoS exposure independent of the renderer.

Secondary (optional, Low, pre-existing): the TASK-073 e2e harness
(`test/slack-summarize.e2e.test.js`, ~lines 34-53 / 141-177) re-implements
`cleanTerminalOutput` and the flush functions as hand-copies because
`renderer/renderer.js` is a browser script, not `require()`-able. The source-scan
tests already pin the real renderer's pipeline order, but the copied cleanup logic
itself could silently drift. This matches the established `slack-*.e2e` pattern
(TASK-061/063/071) — address only if convenient.

## Acceptance Criteria
- [ ] The main-process `slack:summarize` handler clamps/truncates the incoming
  `text` to a bounded maximum (mirror the renderer's 12,000-char tail, or a single
  shared constant) BEFORE passing it to `summarizeForSlack`, so an oversized IPC
  payload cannot be forwarded wholesale to the Anthropic API.
- [ ] The clamp is applied to the redacted/summarizer input path only; it does not
  change behavior for normal (already-bounded) windows and does not weaken the
  existing redact-before-send guarantee (redaction still applies to whatever is
  sent).
- [ ] Behavior is unchanged for the common case: a normal ≤12,000-char window is
  summarized exactly as today; the toggle-off / no-key fallbacks are untouched.
- [ ] (Optional, secondary) Add a source-scan or shared-logic guard tying the e2e
  harness's copied cleanup logic to the renderer, OR document explicitly why the
  copy is acceptable. Skip if not straightforward.
- [ ] Tests: a unit/e2e test proving an oversized `text` into the summarizer path
  is truncated to the cap before it reaches the (mocked) `httpRequest` boundary,
  and that a normal-size window is unaffected. `node --test` green aside from the
  two known pre-existing unrelated failures (`test/task-030-plan-button.e2e.test.js`,
  `test/task-034-routing-drift-guard.test.js`).

## Cucumber Tests
```gherkin
Feature: The slack:summarize handler bounds its input size

  Scenario: Oversized input is truncated before it reaches the API
    Given the slack:summarize handler receives text far larger than the cap
    When it forwards the text to the summarizer
    Then the text handed to the (mocked) Anthropic http request is no larger than the cap
    And it is still redacted (redact-before-send preserved)

  Scenario: Normal-size window is unaffected (edge)
    Given a cleaned window at or below the cap
    When it is summarized
    Then the text is forwarded unchanged apart from the existing redaction
```

## Edge Cases & Failure Paths
- Non-string / empty input → handled exactly as today (the handler already coerces
  non-strings to `''`); the clamp must not throw on those.
- The clamp must not split in a way that could reassemble or expose a masked secret
  — redaction still runs on the (possibly truncated) text before send.

## Relevant Files & Context
- EDIT `main.js` — the `slack:summarize` IPC handler (~1669-1684); add the length
  clamp before `summarizeForSlack`. Consider a shared constant with the renderer's
  12,000-char bound.
- READ `lib/slack-summarize.js` (`summarizeForSlack`, `SUMMARY_MODEL`,
  `defaultHttpRequest`), `renderer/renderer.js` (`cleanTerminalOutput` 12,000-char
  tail, `slackSummarizeOutput`, the two auto-post paths).
- Tests: extend `test/slack-summarize.test.js` / `test/slack-summarize.e2e.test.js`.
- Origin: tech-lead review of TASK-073 (Low finding 1; Low finding 2 is the optional
  secondary criterion).

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
