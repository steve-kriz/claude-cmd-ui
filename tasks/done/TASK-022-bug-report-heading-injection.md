---
id: TASK-022
title: Neutralize heading-forging in bug report text
status: done
created: 2026-07-18T22:12:00.000Z
updated: 2026-07-18T23:55:00.000Z
---

## Description
Follow-up from the TASK-020 tech-lead review (severity: MEDIUM, security/correctness).
User-entered bug text captured by the done→todo bug modal is inserted verbatim (only
`.trim()` applied) as the body of a `### <timestamp>` entry under `## Bug Reports`. Nothing
neutralizes lines that begin with `## `. Because `splitSections` (in `lib/ticket-bug-reports.js`
and its renderer mirror `appendBugReportToMarkdown`) treats ANY `## ` line as a level-2 section
boundary, a bug report whose body contains a line like `## Additional Context`, `## Bug Reports`,
or `## History` forges a section on every subsequent parse/append. This is durable ticket-file
corruption, not a display glitch: a later "insert before Additional Context" (e.g. a second
`appendBugReport` or `appendHistoryEntry`) will target the FORGED heading and splice content into
the middle of the earlier bug text, breaking the "Additional Context stays verbatim at the tail"
invariant and producing duplicate headings. Plausible trigger: a user pastes a formatted bug
report or stack trace containing markdown `## ` headings.

Scope note (keep the fix narrow): a `---` line in the body does NOT break frontmatter (the body
always follows the closed frontmatter block, and `parseTicketFrontmatter` only reads the first
`---…---` block). `### ` lines are harmless — only `## ` delimits sections. So the fix only needs
to neutralize body lines beginning with `## ` (defensively, any leading `#`).

## Acceptance Criteria
- [ ] Bug text containing a line beginning with `## ` (e.g. `## Additional Context`, `## Bug Reports`, `## History`) is neutralized before insertion so it cannot introduce a level-2 section boundary when the ticket is re-parsed.
- [ ] The neutralization is applied identically in BOTH the pure helper `lib/ticket-bug-reports.js` and the renderer mirror `appendBugReportToMarkdown` in `renderer/renderer.js` (no drift between the two copies).
- [ ] After appending heading-like bug text, `## Additional Context` remains verbatim at the tail and a subsequent `appendBugReport`/`appendHistoryEntry` still lands correctly (before Additional Context, no duplicate/forged headings).
- [ ] Existing well-formed bug-report behavior (single entry, accumulation under one heading, chronological order, other sections byte-for-byte) is unchanged.
- [ ] Chosen neutralization preserves readability of the reported text (e.g. fenced code block, per-line blockquote `> `, or escaping a leading `#`), not silent deletion.

## Cucumber Tests
```gherkin
Feature: Bug report text cannot forge a markdown section boundary

  Scenario: Heading-like bug text does not create a new section
    Given a done ticket whose body ends with a "## Additional Context" section
    When the user submits bug text that contains a line "## Additional Context"
    Then the stored bug text is neutralized so re-parsing finds exactly one "## Additional Context" section
    And the real "## Additional Context" section is still the last section, verbatim

  Scenario: A later append still targets the real Additional Context
    Given a ticket that already has a bug report whose text contains a "## History" line
    When another bug report is appended
    Then the new entry is placed under the single real "## Bug Reports" heading before "## Additional Context"
    And no content is spliced into the middle of the earlier bug text

  Scenario: Well-formed bug text is unaffected (regression guard)
    Given a done ticket with an "## Additional Context" section
    When the user submits an ordinary one-line bug description
    Then the bug appears under "## Bug Reports" before "## Additional Context" exactly as before
```

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
