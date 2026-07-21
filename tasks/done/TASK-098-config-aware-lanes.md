---
id: TASK-098
title: Config-aware lane resolution (lib/ticket-lanes.js extensions)
status: done
created: 2026-07-20T13:15:00Z
updated: 2026-07-20T21:27:08.819Z
order: 9
activities: [{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-20T21:20:00Z","finishedAt":"2026-07-20T21:20:26Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-20T21:24:00Z","finishedAt":"2026-07-20T21:24:04Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-20T21:28:00Z","finishedAt":"2026-07-20T21:27:08Z"}]
---

## Description
Extend `lib/ticket-lanes.js` with config-aware variants that accept a columns array (from
TASK-097) while leaving every existing export byte-compatible (dozens of tests and the skill
contract depend on them): `laneStatusesFor(columns)` (ordered lane slugs incl. user columns),
`isKnownStatusFor(status, columns)` (system `VALID_STATUSES` + user slugs),
`laneForStatusFor(status, columns)` (`failed-testing` → `testing`; own lane when in columns;
else `UNKNOWN_STATUS`), `isUserStatus(status, columns)`.

## Clarifications
- Q1: dynamic statuses; Q3: SKILL.md read-only — hence additive extensions, existing constants untouched so the skill prose stays truthful.

## Acceptance Criteria
- [ ] All existing exports (`LANE_STATUSES`, `VALID_STATUSES`, `ACTIVE_STATUSES`, `FAILED_STATUS`, `POST_PROCESSING_*`, `UNKNOWN_STATUS`, `isKnownStatus`, `isActiveStatus`, `isFailedStatus`, `isPostProcessingTicket`, `laneForStatus`) are unchanged in name and behavior (existing test file `test/ticket-lanes.test.js` passes unmodified).
- [ ] `laneStatusesFor(defaultConfig().columns)` equals `LANE_STATUSES`.
- [ ] With a user column `ux-review`, `laneForStatusFor('ux-review', columns)` is `'ux-review'`; `isKnownStatusFor` true; `isUserStatus` true.
- [ ] `laneForStatusFor('failed-testing', anyColumns)` is `'testing'`; an out-of-config status maps to `UNKNOWN_STATUS`, never `todo`.
- [ ] `isActiveStatus('ux-review')` remains false — user statuses are never active (slot math untouched).
- [ ] Null/junk columns input degrades to system-only behavior, never throws.

## Cucumber Tests
```gherkin
Feature: Config-aware lanes
  Scenario: Default config equals the fixed board
    Then laneStatusesFor(defaults) equals LANE_STATUSES

  Scenario: User column gets its own lane
    Given columns including ux-review
    Then laneForStatusFor("ux-review") is "ux-review"

  Scenario: failed-testing still folds into testing (edge)
    Then laneForStatusFor("failed-testing", columns) is "testing" for any columns

  Scenario: Removed-column status routes to unknown (failure)
    Given columns no longer containing "ux-review"
    When a ticket still carries status "ux-review"
    Then laneForStatusFor returns the unknown lane, never todo
```

## Edge Cases & Failure Paths
- columns = null/[]/malformed entries; user column colliding with a system slug (impossible post-normalize, but resolver prefers the system meaning).

## Relevant Files & Context
- `lib/ticket-lanes.js` (all 107 lines); `lib/team-config.js` (TASK-097); `test/ticket-lanes.test.js` (must pass unmodified).

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
