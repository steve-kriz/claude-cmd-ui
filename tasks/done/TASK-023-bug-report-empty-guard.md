---
id: TASK-023
title: Guard empty bug text in appendBugReport helper
status: done
created: 2026-07-18T22:12:30.000Z
updated: 2026-07-19T00:25:00.000Z
---

## Description
Follow-up from the TASK-020 tech-lead review (severity: LOW, robustness/contract).
The exported pure helper `appendBugReport(markdown, { bug, timestamp })` in
`lib/ticket-bug-reports.js` does NOT guard empty/whitespace-only bug text: `formatBugReportEntry`
still emits a `### <ts>` heading with an empty text line and `appendBugReport` still creates/extends
the `## Bug Reports` section. The only empty-input rejection lives in the renderer modal submit
handler (`openBugReportModal`, ~renderer.js:6409-6410). Consequently the "no write on empty input"
acceptance criterion is only ever validated against a re-implemented COPY of the guard in the e2e
test (`simulateDropDoneToTodo`), never against the real reusable API or the real renderer handler.
A future non-renderer caller (e.g. the orchestrator) would silently write empty bug entries.

## Acceptance Criteria
- [ ] `appendBugReport(markdown, { bug })` returns the input markdown UNCHANGED (no `## Bug Reports` section created, no entry added) when `bug` is null, undefined, empty, or whitespace-only.
- [ ] Non-empty bug text continues to append exactly as today (creation, placement before `## Additional Context`, accumulation under one heading, chronological order).
- [ ] The renderer's UX-level guard (validation message on empty submit) is retained — this change is defense-in-depth at the reusable helper layer, not a replacement for the modal UX.
- [ ] A unit test asserts that empty/whitespace input produces no `## Bug Reports` section and does not alter the markdown.

## Cucumber Tests
```gherkin
Feature: The reusable bug-report helper rejects empty input

  Scenario: Whitespace-only bug text is a no-op
    Given a done ticket markdown with an "## Additional Context" section
    When appendBugReport is called with bug text that is only spaces and newlines
    Then the returned markdown is byte-for-byte identical to the input
    And no "## Bug Reports" section exists

  Scenario: Non-empty text still appends (regression guard)
    Given the same ticket markdown
    When appendBugReport is called with a real bug description
    Then a "## Bug Reports" entry is added before "## Additional Context"
```

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
