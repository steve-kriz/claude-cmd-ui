---
id: TASK-040
title: heading-escape the original id interpolated into the new bug ticket body
status: done
created: 2026-07-18T23:25:24Z
updated: 2026-07-19T00:29:00Z
---

## Description
Follow-up from the TASK-031 tech-lead review (nit — defense-in-depth). In `onCreateBug` (renderer/renderer.js ~6654), the original ticket id is written into the new bug ticket body as `'Bug against ' + originalId` WITHOUT heading-escape. `originalId` is board-sourced (a `<select>` populated from `tab.tasks.tickets` `fm.id`) and validated to exist, so it is reasonably trusted — but `parseTicketFrontmatter` accepts any string after `id:`, so a crafted/odd ticket whose id begins with `## ` (or another heading run) placed on its own body line could forge a section boundary. Every other user-supplied text on this path already routes through `neutralizeBugText`; this single interpolation does not. Low risk (local, single-user; ids are normally `TASK-nnn`), but the create path should not rely on ids always being well-formed.

Note: `bug-of: <originalId>` in the frontmatter is single-line and safe — this ticket is only about the body interpolation.

## Acceptance Criteria
- [x] The `originalId` interpolated into the new bug ticket body is neutralised before composition, via EITHER: (a) routing it through the shared `neutralizeBugText`/`escapeLeadingHeadingRun` helper, OR (b) validating the selected original id matches `^TASK-\d+$` at selection/confirm time and rejecting otherwise.
- [x] A board id that begins with a heading run (e.g. `## x`) can no longer forge a section boundary in the new bug ticket body after a serialize→parse round-trip.
- [x] Normal ids (`TASK-010`) are written unchanged (no visible escaping artifacts).
- [x] The fix reuses the existing shared helper (option a) or a single explicit validation (option b) — no new bespoke escaping logic that could drift from `lib/markdown-escape.js`.
- [x] Coordinate with TASK-037 (which also references the new id in the original) so any id reference is likewise safe.
- [x] Full suite passes under `node --test`.

## Cucumber Tests
```gherkin
Feature: The original id cannot forge a section in the new bug ticket body

  Scenario: A heading-like id is neutralised (edge)
    Given the selected original id is "## Additional Context"
    When the new bug ticket body is composed and parsed back
    Then the id does not forge a new section boundary

  Scenario: A normal id is written unchanged
    Given the selected original id is "TASK-010"
    When the new bug ticket body is composed
    Then the body contains "Bug against TASK-010" with no escaping artifacts
```

## Relevant Files and Context
- `renderer/renderer.js` — `onCreateBug` body composition (~6654), the `'Bug against ' + originalId` line; and the selector-validation point (where `originalId` is read from `.newtask-bug-of`).
- `renderer/renderer.js` `neutralizeBugText` (~6500) / `lib/markdown-escape.js` `escapeLeadingHeadingRun` — the shared escape helper (option a).
- Tests: `test/task-031-bug-reporting.*` — add an edge case for a heading-like id.

## Edge and Failure Cases
- Id beginning with `#`/`##`/`###` → neutralised (option a) or rejected (option b).
- Ordinary `TASK-nnn` id → byte-unchanged.
- Empty/missing id already rejected upstream by the no-original validation (unchanged).

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
