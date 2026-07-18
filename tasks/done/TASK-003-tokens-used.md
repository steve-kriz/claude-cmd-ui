---
id: TASK-003
title: tokens used
status: done
created: 2026-07-18T03:53:52.014Z
updated: 2026-07-18T04:51:50Z
startedAt: 2026-07-18T04:42:27Z
finishedAt: 2026-07-18T04:51:50Z
tokens: 116807
---

## Description
Each ticket should record the wall-clock time it took to build and how much that
build cost. Specifically: capture the time work started and the time work ended
on the ticket, and record the build cost (token usage and/or dollar cost) on the
ticket file itself so the ticket carries its own accounting.

These values live on the ticket, so they belong in the flat frontmatter (or a
clearly labelled body section) that the board parser already reads. The board
serializer (`serializeTicket`) preserves unknown frontmatter keys, so new keys
like `startedAt` / `finishedAt` / `costUsd` / `tokens` survive round-trips
without breaking the existing `id/title/status/created/updated` ordering. As with
all ticket writes, the orchestrator records these with whole-file writes and
bumps `updated`; `created` is preserved.

## Acceptance Criteria
- [ ] When a ticket first transitions into active work, a build start time is recorded on the ticket.
- [ ] When a ticket reaches a terminal state for that build (`done`, or left in `failed-testing`), a build end time is recorded on the ticket.
- [ ] Start and end times are stored in a machine-readable form (ISO-8601 timestamps) that the flat-frontmatter parser can read.
- [ ] The build cost — token usage and/or its dollar equivalent — is recorded on the ticket file itself.
- [ ] Recording start/end/cost is done with a whole-file write that preserves all existing sections and the user-owned `## Additional Context`, and bumps `updated` while preserving `created`.
- [ ] New accounting fields do not break parsing or the existing frontmatter key order (`id`, `title`, `status`, `created`, `updated` remain first).
- [ ] If cost/token data is unavailable for a build, the ticket still records start and end times and does not write a fabricated or malformed cost value.

## Cucumber Tests
```gherkin
Feature: Record build time and cost on the ticket

  Background:
    Given a ticket TASK-200 exists with status "todo"

  Scenario: Start time is recorded when work begins
    When the ticket transitions into active work
    Then the ticket records a build start timestamp in ISO-8601 form

  Scenario: End time is recorded when the build finishes
    Given the ticket is being worked and has a start timestamp
    When the ticket reaches status "done"
    Then the ticket records a build end timestamp in ISO-8601 form
    And the end timestamp is not earlier than the start timestamp

  Scenario: Build cost is recorded on the ticket
    When the build completes and cost/token usage is reported
    Then the ticket records the token usage and/or dollar cost for the build

  Scenario: Accounting fields survive a round-trip and keep frontmatter order
    Given the ticket has start, end, and cost fields recorded
    When the file is parsed and re-serialized
    Then the frontmatter still parses successfully
    And "id", "title", "status", "created", "updated" remain the leading keys
    And the accounting fields are preserved

  Scenario: End time is recorded even when the build fails
    Given the ticket is being worked and has a start timestamp
    When the ticket ends up in status "failed-testing"
    Then the ticket records a build end timestamp

  Scenario: Missing cost data does not corrupt the ticket
    Given the build completes but no cost/token data is available
    When the ticket is written
    Then start and end timestamps are still present
    And no fabricated or malformed cost value is written
    And the ticket still parses
```

## History
### 2026-07-18T04:47:18Z — coder
**Prompt:** Implement TASK-003: make the app support/surface per-ticket build
accounting (startedAt/finishedAt/costUsd/tokens). Verify `serializeTicket`
preserves unknown frontmatter keys with leading-key order; add an Electron-free
`lib/ticket-accounting.js` with `recordBuildStart`/`recordBuildEnd`/
`formatDuration`; surface duration/cost/tokens read-only on the card + modal
without disturbing the working dot. Don't touch ticket files or the SKILL.

**Response:** Created `lib/ticket-accounting.js` (pure, requireable) with
`recordBuildStart(fm,{at})`, `recordBuildEnd(fm,{at,tokens,costUsd})` (writes
tokens/costUsd only when finite ≥ 0), `formatDuration`, plus `isValidAmount`/
`orderFm`/`toIso`/`LEADING_KEYS`. Verified `serializeTicket` already emits
id/title/status/created/updated first then appends unknown keys (round-trip
confirmed). Added read-only `.task-card-meta` on cards and
`.task-modal-accounting` in the detail modal (index.html + styles.css), showing
duration · cost · tokens when present, nothing when absent; running builds show
elapsed with `…`. Renderer duplicates the format logic (browser can't require
Node). Full suite (59) green with `node --test "test/**/*.test.js"`.

### 2026-07-18T04:51:50Z — tester
**Prompt:** Write automated tests for `lib/ticket-accounting.js` and the
serialize/parse round-trip contract (unknown-key preservation + leading-key
order + `## Additional Context` preserved). Mock external calls; run full suite;
report. Don't modify production code.

**Response:** Added `test/ticket-accounting.test.js` (28 tests): valid/invalid
amount matrix (NaN/Infinity/negative/null/''/non-numeric all omitted),
start-idempotence, end-always-sets-finishedAt, `formatDuration` boundaries,
no-mutation, and a round-trip test using verbatim copies of the real
`serializeTicket`/`parseTicketFrontmatter` (renderer.js isn't requireable),
cross-checked against `orderFm`. `npm test` → tests 90, pass 90, fail 0.
Two low-severity spec edge cases pinned (whitespace-only string and array/bool
coerce via `Number()`); within the "finite ≥ 0" contract — noted as a possible
future hardening, not a blocker.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
