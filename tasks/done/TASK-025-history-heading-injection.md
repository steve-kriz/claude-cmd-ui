---
id: TASK-025
title: Neutralize heading-forging in history entry text
status: done
created: 2026-07-18T23:50:00.000Z
updated: 2026-07-19T01:30:00.000Z
---

## Description
Follow-up from the TASK-022 tech-lead review (severity: MEDIUM, security/correctness).
`appendHistoryEntry` in `lib/ticket-history.js` folds agent `prompt`/`response` text RAW into the
`## History` section (`formatHistoryEntry`, lines ~72-88; raw insertion of `promptText`/`responseText`
at ~75-76, 81, 85) while sharing the exact same `splitSections` boundary detector (`/^## /`, ~line 40).
This is the identical corruption class TASK-022 just fixed for bug-report text, in immediately-adjacent
code — but with HIGHER likelihood: agent (coder/tester) responses are markdown-heavy and very commonly
contain lines beginning with `## ` (e.g. `## Summary`, `## Changes`, `## Report`). Any such line forges
a phantom level-2 section on every later re-parse. The next "insert before Additional Context" then
targets the forged heading and splices content into the middle of a prior history entry, corrupting the
ticket file and displacing the user-owned `## Additional Context`.

This directly undermines the invariant TASK-022's own acceptance criteria rely on ("a subsequent
`appendHistoryEntry` still lands correctly, before Additional Context, no forged headings"). Note:
TASK-022 already added a per-line heading-escape helper `neutralizeBugText(text)` (exported from
`lib/ticket-bug-reports.js`), which is exactly the transform needed here — reuse or port it.

## Acceptance Criteria
- [ ] Agent `prompt` and `response` text folded into `## History` by `formatHistoryEntry`/`appendHistoryEntry` is neutralized so no line can begin with a level-2 heading (`## `) that `splitSections` (`/^## /`) would treat as a section boundary.
- [ ] The neutralization reuses the existing per-line escape transform (`neutralizeBugText` from `lib/ticket-bug-reports.js`, or an equivalent shared/ported pure helper) so bug-report and history text are neutralized identically — no second, divergent implementation.
- [ ] After appending a history entry whose prompt/response contains `## Foo`/`## Additional Context`/`## History` lines, re-parsing finds only the real sections; the user-owned `## Additional Context` remains verbatim at the tail; and a later `appendHistoryEntry` or `appendBugReport` still lands before `## Additional Context` with no forged/duplicate headings and nothing spliced into an earlier entry.
- [ ] If a renderer/main-process mirror of the history-append logic exists, the same neutralization is applied there in lockstep (search for any `appendHistoryEntry`/history-formatting mirror; the bug-report fix required a renderer mirror in `renderer/renderer.js`).
- [ ] Well-formed history text (no leading `#`) is unchanged byte-for-byte; existing `ticket-history` tests stay green.
- [ ] The `### <timestamp> — <role>` entry heading and the `**Prompt:**`/`**Response:**` labels the helper itself emits are NOT altered (only the user/agent-supplied prompt/response bodies are neutralized).

## Cucumber Tests
```gherkin
Feature: History entry text cannot forge a markdown section boundary

  Scenario: An agent response containing a heading does not forge a section
    Given a ticket whose body ends with a "## Additional Context" section
    When a history entry is appended whose response text contains a line "## Summary"
    Then re-parsing the ticket finds no "## Summary" section from the response body
    And the real "## Additional Context" section is still the last section, verbatim

  Scenario: A later append still targets the real Additional Context
    Given a ticket carrying a history entry whose response contained a "## History" line
    When another history entry (or a bug report) is appended
    Then the new content lands before the real "## Additional Context"
    And nothing is spliced into the middle of the earlier history entry

  Scenario: Well-formed history text is unaffected (regression guard)
    Given a ticket with an "## Additional Context" section
    When a history entry with an ordinary prompt and response is appended
    Then the entry appears under "## History" exactly as before with no escaping applied
```

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
