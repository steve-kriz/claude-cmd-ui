---
id: TASK-037
title: bug-report fold should name the new bug ticket id in the original
status: done
created: 2026-07-18T23:25:24Z
updated: 2026-07-18T23:37:00Z
---

## Description
Follow-up from the TASK-031 tech-lead review (minor). TASK-031's "Bug" button links a new bug ticket to an original ticket, but the link is currently one-directional. The new bug ticket references the original (`bug-of: <ID>` frontmatter + a "Bug against <ID>" body line), but the ORIGINAL ticket's folded `## Bug Reports` entry does NOT name the new bug ticket's id. `onCreateBug` (renderer/renderer.js ~6632, STEP 1) calls `appendBugReportToMarkdown(origBody, { bug: bugDesc, timestamp: now })`, which emits only `### <ts>` + the bug text — the new id (already known as `id = nextTaskId(tab)` at open time) is never written. So original → bug-ticket is not navigable, contradicting the TASK-031 Description ("a `## Bug Reports` entry naming the new bug id so the relationship is visible from both sides").

## Acceptance Criteria
- [x] When the Bug button creates a linked bug ticket, the original ticket's folded `## Bug Reports` entry names the new bug ticket's id (e.g. a `Reported as <NEW_ID>` reference line, or the id prefixed onto the entry).
- [x] The bidirectional link is verifiable: from the original you can find the new ticket id, and from the new ticket you can find the original (`bug-of` + body reference, already present).
- [x] The heading-escape safeguard is preserved — the bug text is still routed through `neutralizeBugText`/`escapeLeadingHeadingRun`; adding the id reference must not bypass it, and the id itself must not be able to forge a section (see TASK-040).
- [x] `## Additional Context` in the original remains untouched and at the tail; `created` preserved / `updated` bumped; whole-file atomic write.
- [x] Full suite passes under `node --test`, with a test asserting the original names the new id.

## Cucumber Tests
```gherkin
Feature: The original ticket records which bug ticket was filed against it

  Scenario: Original names the new bug ticket id
    Given the Bug button creates bug ticket "TASK-050" against original "TASK-010"
    When TASK-010's file is written and parsed back
    Then its "## Bug Reports" section references "TASK-050"
    And the new ticket "TASK-050" still carries "bug-of: TASK-010"

  Scenario: Additional Context is preserved (edge)
    Given original "TASK-010" has a "## Additional Context" section
    When a bug is filed against it naming the new id
    Then "## Additional Context" is unchanged and remains at the tail
```

## Relevant Files and Context
- `renderer/renderer.js` — `onCreateBug` STEP 1 (~6632): the `appendBugReportToMarkdown(origBody, {...})` call; the new id `id = nextTaskId(tab)` is in scope. Decide whether to fold the id into the `bug` text or extend the append helper with an optional id/reference field.
- `renderer/renderer.js` `appendBugReportToMarkdown` (~6508) and `lib/ticket-bug-reports.js` `appendBugReport` — if you extend the append signature, keep the renderer mirror byte-for-byte in step (TASK-027 rule) and update its unit tests.
- `lib/markdown-escape.js` `escapeLeadingHeadingRun` / renderer `neutralizeBugText` — keep the escape applied.
- Tests: `test/task-031-bug-reporting.test.js` / `.e2e.test.js` — extend to assert the original names the new id.

## Edge and Failure Cases
- New id must be escaped if it could contain heading-forging characters (coordinate with TASK-040).
- If the append helper signature changes, the existing `openBugReportModal` (same-ticket) path must keep working unchanged.
- Empty bug description path unchanged (still rejected/no-op as today).

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
