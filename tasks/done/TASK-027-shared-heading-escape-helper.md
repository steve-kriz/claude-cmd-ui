---
id: TASK-027
title: Extract shared markdown heading-escape helper
status: done
created: 2026-07-19T01:25:00.000Z
updated: 2026-07-19T02:30:00.000Z
---

## Description
Follow-up from the TASK-025 tech-lead review (severity: LOW, maintainability — OPTIONAL refactor, not a
defect; behavior is correct today). The per-line heading-escape transform lives in
`lib/ticket-bug-reports.js` as `neutralizeBugText` (`/^(\s*)(#+)(\s)/` → `$1\$2$3`), with a byte-for-byte
mirror in `renderer/renderer.js` and a doc comment pinning the two "in step." TASK-025 made
`lib/ticket-history.js` `require` and reuse that SAME `neutralizeBugText` for history prompt/response
text (correctly avoiding a divergent second implementation). The smell: history now transitively inherits
a helper NAMED for bug reports and pinned to the renderer bug-text mirror. If that neutralizer is ever
specialized for bug-specific reasons, history escaping would change silently with no signal at the history
call site; the name also obscures intent when reading `ticket-history.js`.

This ticket decouples the concern WITHOUT introducing a second implementation: extract the pure per-line
heading-escape into a neutrally-named shared helper and have all three consumers import/mirror it.

## Acceptance Criteria
- [ ] The per-line heading-escape transform is defined ONCE in a neutrally-named pure, Electron-free module (e.g. `lib/markdown-escape.js` exporting `escapeLeadingHeadingRun(text)` or similar), unit-tested via `node --test`.
- [ ] `lib/ticket-bug-reports.js` uses the shared helper. `neutralizeBugText` MUST remain exported from `lib/ticket-bug-reports.js` (as a thin re-export/wrapper) because existing TASK-022/025 tests import it from there — do not break them.
- [ ] `lib/ticket-history.js` uses the shared helper (directly or via the retained `neutralizeBugText` export) — no behavior change.
- [ ] The `renderer/renderer.js` browser mirror is updated to mirror the shared helper's semantics, with the lockstep comment pointing at the new canonical module.
- [ ] Behavior is byte-for-byte identical to today for all inputs (this is a pure rename/extract); the full existing suite stays green with no assertion changes required beyond import paths.
- [ ] No new circular requires are introduced (verify the new module requires nothing from the ticket modules).

## Cucumber Tests
```gherkin
Feature: A single shared markdown heading-escape helper

  Scenario: Bug-report and history text are escaped by the same shared helper
    Given the shared heading-escape helper escapes a line beginning with "## "
    When bug-report text and history text each contain a "## Foo" line
    Then both are escaped identically to "\## Foo" by the one shared implementation

  Scenario: Existing neutralizeBugText import still works (regression)
    Given code importing neutralizeBugText from lib/ticket-bug-reports.js
    When it is called with a "## Foo" line
    Then it still returns "\## Foo" (the export is preserved as a re-export)

  Scenario: No behavior change for well-formed text (regression)
    Given ordinary prose with no leading "#"
    When passed through the shared helper
    Then it is returned byte-for-byte unchanged
```

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
