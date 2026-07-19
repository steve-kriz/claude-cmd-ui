---
id: TASK-026
title: Make appendBugReport return-type consistent for non-string markdown
status: done
created: 2026-07-19T00:20:00.000Z
updated: 2026-07-19T02:00:00.000Z
---

## Description
Follow-up from the TASK-023 tech-lead review (severity: LOW, robustness/contract). The empty-input
no-op guard added to `appendBugReport` in `lib/ticket-bug-reports.js` (~lines 113-116) returns the raw
`markdown` argument BEFORE the `body = typeof markdown === 'string' ? markdown : ''` normalization that
the non-empty path applies. The two paths therefore disagree on a non-string `markdown`:

- `appendBugReport(undefined, {})` → returns `undefined`
- `appendBugReport(123, { bug: '' })` → returns `123`
- but `appendBugReport(undefined, { bug: 'boom' })` (non-empty path) → returns a `string`.

The helper is exported as a reusable pure API, and the whole rationale of TASK-023 was robustness for
callers other than the renderer. A caller passing a non-string body gets a non-string back on the empty
path but a normalized string on the non-empty path — an inconsistent return-type contract. Severity is
LOW because every real caller (the renderer `onSubmit`) always passes a string body, so there is no
practical impact today; this is a correctness/consistency hardening of the exported contract.

## Acceptance Criteria
- [ ] `appendBugReport` returns a string on BOTH the empty/no-op path and the non-empty path, for every input — never `undefined`/a number/other non-string — matching the non-empty path's `typeof markdown === 'string' ? markdown : ''` normalization.
- [ ] For a string `markdown`, the empty/no-op path still returns it BYTE-FOR-BYTE identical (no re-serialization) — the existing TASK-023 no-op guarantee is preserved.
- [ ] The non-empty append path behavior is unchanged (TASK-022 neutralization, placement before `## Additional Context`, accumulation, chronological order).
- [ ] A unit test pins the no-op non-string cases: `appendBugReport(undefined, {})` and `appendBugReport(123, { bug: '' })` each return `''` (currently untested — this is the coverage gap the review noted).
- [ ] Existing TASK-020/022/023 tests remain green.

## Cucumber Tests
```gherkin
Feature: appendBugReport has a consistent string return contract

  Scenario: No-op path normalizes a non-string markdown to a string
    Given appendBugReport is called with a non-string markdown and empty bug text
    When the empty-input guard short-circuits
    Then the returned value is an empty string, not the raw non-string argument

  Scenario: No-op path preserves a real string byte-for-byte (regression)
    Given a real markdown string and whitespace-only bug text
    When appendBugReport is called
    Then the returned string equals the input byte-for-byte

  Scenario: Non-empty path still returns a string for non-string markdown (regression)
    Given appendBugReport is called with a non-string markdown and non-empty bug text
    Then a valid markdown string containing a "## Bug Reports" entry is returned
```

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
