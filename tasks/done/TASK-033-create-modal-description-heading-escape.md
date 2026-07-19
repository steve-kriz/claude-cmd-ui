---
id: TASK-033
title: escape heading-like lines in create-from-board ticket descriptions
status: done
created: 2026-07-18T21:57:07.000Z
updated: 2026-07-18T22:37:01Z
---

## Description
Follow-up from the TASK-028 tech-lead review (minor / defense-in-depth). In `openNewTaskModal` (`renderer/renderer.js` ~6434-6446) the user's description text (`bodyArea.value`) is written verbatim under the `## Description` heading with no heading-escaping. This contrasts with the bug-report path, which routes untrusted text through the shared `neutralizeBugText` / `escapeLeadingHeadingRun` helpers (the TASK-022 / TASK-025 / TASK-027 hardening in `lib/markdown-escape.js`). A description line such as `## Additional Context` or `## Acceptance Criteria` forges a section boundary, so on the next parse the ticket gains a duplicated/hijacked user-owned section — which can, in turn, misplace a later `appendBugReportToMarkdown` insertion. Risk is low (the file is locally authored and owned by the same user), and the gap is shared with the pre-existing toolbar "New ticket" path, but post-processing "recipe" descriptions are the most likely to legitimately contain literal `## …` step headings, so this path should reuse the existing escape safeguard rather than relying only on the serialize step.

Note: frontmatter `title` injection is NOT in scope / not exploitable — the title is a single-line `<input>` and `parseTicketFrontmatter` splits on the first colon only. This ticket is about the multi-line description body.

## Acceptance Criteria
- [x] The create-from-board description body (both the toolbar "New ticket" path and the post-processing lane Add path via `openNewTaskModal`) is passed through the shared heading-escape helper (`escapeLeadingHeadingRun` / `neutralizeBugText` from `lib/markdown-escape.js`, or its established consumption pattern) before being composed into the ticket markdown.
- [x] A description line that begins with a markdown heading run (e.g. `## Additional Context`, `## Acceptance Criteria`, `## Cucumber Tests`) no longer forges a real section boundary — after a serialize→parse round-trip the ticket still has exactly its intended sections and the user's text is preserved as content, not promoted to a heading.
- [x] Normal descriptions (no leading `#` runs) are written unchanged (no visible escaping artifacts for ordinary text).
- [x] The existing serialize contract is preserved: leading key order, `## Additional Context` placeholder present, `created` preserved / `updated` bumped.
- [x] The fix reuses the existing shared helper — no new bespoke escaping logic that could drift from `lib/markdown-escape.js`.
- [x] Full suite passes under `node --test`.

## Cucumber Tests
```gherkin
Feature: Create-from-board descriptions cannot forge ticket section headings

  Scenario: A heading-like description line is neutralised
    Given the new-ticket modal with description "## Additional Context\nmalicious"
    When the ticket is created
    And the written file is parsed back
    Then the ticket still has exactly one user-owned "## Additional Context" section
    And the user's text appears as description content, not as a new section heading

  Scenario: A normal description is written unchanged
    Given the new-ticket modal with description "Implement the widget and add a test."
    When the ticket is created
    Then the description body equals the entered text (no escaping artifacts)

  Scenario: Post-processing recipe with step headings stays intact
    Given the post-processing Add modal with description "## Step 1\nrun lint\n## Step 2\nregenerate docs"
    When the ticket is created and parsed back
    Then no forged top-level ticket section is introduced
    And the recipe text is preserved
```

## Relevant Files and Context
- `renderer/renderer.js` — `openNewTaskModal` body composition (~6446). Browser script (not requireable) — mirror/consume the `lib/markdown-escape.js` logic the same way other renderer code does; verify with the source-scan test convention.
- `lib/markdown-escape.js` — `escapeLeadingHeadingRun` / `neutralizeBugText` (the shared helpers from TASK-027). This is the single source of truth for heading escaping; reuse it.
- Prior art: `lib/ticket-bug-reports.js` and the bug-report append path show the established untrusted-text handling.
- Tests: `test/markdown-escape.test.js`, `test/markdown-escape.e2e.test.js` for helper behavior; add a create-path test asserting a heading-like description does not forge a section.

## Edge and Failure Cases
- Description beginning with `#`, `##`, `###`, `>` blockquote or other section-forging markdown → neutralised.
- Empty description → still writes a valid body (no crash).
- Multi-line description with a heading-like line in the middle → that line neutralised, rest preserved.
- Ordinary description → byte-unchanged.

## Implementation Notes
- `renderer/renderer.js` `openNewTaskModal` → `onCreate` (~6446): `const description = neutralizeBugText(bodyArea.value.trim()) || 'What needs doing and why.';` (was `bodyArea.value.trim() || …`). `neutralizeBugText` (~6500) is the byte-identical browser mirror of `escapeLeadingHeadingRun` (`lib/markdown-escape.js`). Single change covers both create-from-board entry points (toolbar New-ticket and post-processing lane Add) since both call `openNewTaskModal`. Empty input still falls back to the placeholder; mid-description heading lines are escaped per-line.
- Tests: `test/task-033-create-description-escape.e2e.test.js` + `test/task-033-create-description-escape.test.js` — behavioral serialize→parse round-trips driving the requireable `escapeLeadingHeadingRun`, plus source-scan drift guards asserting the real `onCreate` composes via `neutralizeBugText(bodyArea.value.trim())` and that the renderer mirror is byte-identical to the shared helper. Full suite green: 827 pass / 0 fail.
- Tech-lead review: clean (only two informational nits — the ticket's mention of `>` blockquote is imprecise since the parser keys only on `/^## /`; and the pre-existing cosmetic backslash on indented headings inherited from the shared helper). Security review (post-processing TASK-035): no exploitable issues — the escape fully closes the `## `-section-forging vector for the create path; no frontmatter breakout, no path traversal, regex is linear (no ReDoS), no new XSS sink.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
