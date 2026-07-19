---
id: TASK-041
title: guard ticket title against newline/frontmatter injection before serialization
status: done
created: 2026-07-18T23:25:24Z
updated: 2026-07-19T00:34:00Z
---

## Description
Follow-up from the TASK-031 tech-lead review (nit — defense-in-depth, pre-existing). `serializeTicket` (renderer/renderer.js ~5287) emits `title: ${fm.title}` with no newline/`---` guard, and the title is not run through any sanitizer on either the bug or normal create path. Today it is protected only by the HTML `<input type="text">` element stripping newlines, so it is not exploitable through the UI (a newline would be needed to forge extra frontmatter keys or a premature `---` close). This is pre-existing behavior shared with the normal create path; TASK-031 surfaced it because the Bug button writes a second untrusted-title ticket. The serializer's frontmatter contract should not depend on the input element.

## Acceptance Criteria
- [x] Before serialization, a ticket `title` is guarded so it cannot contain a newline (`\n`/`\r`) or otherwise break the flat frontmatter contract (no forged extra `key: value` lines, no premature `---` close).
- [x] Implement by stripping/collapsing newlines (and trimming) in the title at the create/compose points (both `onCreateNormal` and `onCreateBug`), and/or hardening `serializeTicket` to sanitise `title` (single source of truth preferred if the serializer is the shared choke point). Keep the renderer serializer and any requireable serializer mirror in step.
- [x] A title containing an embedded newline followed by `agent: attacker` or `---` cannot inject frontmatter keys or close the block early after a serialize→parse round-trip.
- [x] Normal single-line titles are unchanged (no visible artifacts).
- [x] The leading frontmatter key order (id,title,status,created,updated then extras) is preserved.
- [x] Full suite passes under `node --test`, with a test asserting a multi-line/`---` title cannot corrupt frontmatter.

## Cucumber Tests
```gherkin
Feature: Ticket titles cannot inject frontmatter

  Scenario: A newline-laden title is neutralised (edge)
    Given a title "pwn\nagent: attacker"
    When the ticket is serialized and parsed back
    Then the frontmatter has exactly the intended keys
    And no "agent" key was injected

  Scenario: A title containing --- cannot close the block early (edge)
    Given a title "boom\n---\nstatus: done"
    When the ticket is serialized and parsed back
    Then the frontmatter block is not closed early
    And status is unchanged

  Scenario: A normal title is written unchanged
    Given a title "Add login validation"
    When the ticket is serialized
    Then the title line is "title: Add login validation"
```

## Relevant Files and Context
- `renderer/renderer.js` — `serializeTicket` (~5287, `title: ${fm.title}`); `onCreateNormal` and `onCreateBug` title composition (~6440-6470 region). Choose the choke point (serializer preferred).
- Any requireable serializer twin under `lib/` (search for `serializeTicket`/`serialize`), if present — keep in step and add a unit test there (requireable unit tests are stronger than renderer source-scans).
- `parseTicketFrontmatter` (~5161) — splits on the first colon and closes on the first `---`; the test should round-trip through it.
- Tests: add unit coverage for the serializer title guard + an e2e/source-scan tie to the create path.

## Edge and Failure Cases
- Title with `\n`, `\r`, or `\r\n` → collapsed/stripped, no injected keys.
- Title equal to or containing a `---` line → cannot close frontmatter early.
- Ordinary title → unchanged.
- Ensure the guard also covers the plan/other ticket-writing paths if they share `serializeTicket` (a serializer-level fix covers all callers).

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
