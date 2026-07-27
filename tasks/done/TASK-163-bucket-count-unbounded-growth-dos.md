---
id: TASK-163
title: Unbounded per-project bucket count amplifies memory DoS from loopback input
status: done
created: 2026-07-26T22:58:04.000Z
updated: 2026-07-27T01:09:23.000Z
agent: swarm-orch1
review-of: TASK-154
---

## Description
Added `MAX_PROJECT_BUCKETS = 100` cap to `lib/telemetry-receiver.js`'s
`buckets` Map, implementing LRU eviction via natural Map insertion-order:
`ensureBucket` re-inserts a touched bucket at the end (delete+set) to mark it
most-recently-used, and evicts the front-most (least-recently-touched) entry
when a new project's bucket would exceed the cap. This closes ONE growth
dimension of the memory-DoS concern (bucket count); the tech-lead review
found the fix is PARTIAL — the primary vector (distinct request_ids driving
`seenKeys`/per-bucket `store` growth) remains open, tracked as TASK-171.

## Acceptance Criteria
- [x] `buckets` Map has a maximum size (`MAX_PROJECT_BUCKETS`, 100).
- [x] New bucket beyond limit evicts the least-recently-touched bucket (LRU) —
      VERIFIED correct by tech-lead reading the actual eviction code.
- [x] Existing legitimate usage unaffected.
- [x] `usage()`/`usageForWindow` continue to reflect currently-retained rows.
- [x] Test simulates ingesting more distinct projects than the cap and
      asserts bounded bucket count (unit tests genuinely assert this; e2e
      tests were found to lack real assertions here — TASK-173 follow-up).
- [x] All tests green beyond the known pre-existing baseline failures.
- [x] No behavioral change to `usageForProject`/`getUsageForProject` for
      buckets that remain.

## Cucumber Tests
```gherkin
Feature: Bounded per-project bucket count

  Scenario: Bucket count never exceeds the cap
    Given ingest of rows tagged with more than MAX_PROJECT_BUCKETS distinct
      project values
    When all rows have been ingested
    Then the number of buckets never exceeds MAX_PROJECT_BUCKETS

  Scenario: Legitimate multi-project usage is unaffected
    Given ingest of rows for 5 distinct real project folders
    When usageForProject is read for each
    Then each returns its own correct totals (well under the cap)

  Scenario (edge): Eviction/overflow never throws
    Given a burst of 10,000 distinct fake project values ingested rapidly
    When ingestion completes
    Then no exception is thrown and memory-bounding behavior held (bucket count capped)
```

## Relevant Files
- `C:\projects\claude-cmd-ui2\lib\telemetry-receiver.js` — `MAX_PROJECT_BUCKETS`
  constant (exported), LRU logic in `ensureBucket`.
- `C:\projects\claude-cmd-ui2\test\task-163-bucket-cap.e2e.test.js`,
  `C:\projects\claude-cmd-ui2\test\task-163-bucket-cap.test.js`.
- `C:\projects\claude-cmd-ui2\docs\telemetry.md` — added an honest,
  partial-mitigation note in Security & privacy notes.

## Build/Test/Review Notes
- Coder: implemented LRU via Map insertion-order re-insertion; manually
  verified with a 250-distinct-project script (oldest evicted, most recent
  100 retained, app-wide totals capped at exactly 100, no throw).
- Tester: 24 new tests (6 e2e + 18 unit). Full suite: 3389 pass, 3 fail
  (confirmed pre-existing baseline).
- Tech-lead review: core LRU logic CORRECT (touch-on-every-ingest, correct
  eviction target, no off-by-one, no evict-while-iterating hazard). Confirmed
  this fix is correctly scoped to ONLY `buckets` (doesn't touch
  `projectForwarding`, avoiding conflict with TASK-165). THREE follow-ups
  filed:
  - TASK-171 (Medium) — the PRIMARY threat vector (distinct request_ids
    driving unbounded `seenKeys` growth and unbounded per-bucket `store`
    growth) remains open; the bucket-count cap alone doesn't close the
    memory-DoS concern the ticket set out to fix.
  - TASK-172 — bucket eviction orphans `seenKeys` entries, permanently
    blocking re-ingest for an evicted project (its de-dup keys stay "seen"
    forever), and leaves `globalRecent`/aggregate totals potentially
    inconsistent.
  - TASK-173 — the e2e tests for this ticket's flagship "bucket count never
    exceeds cap" scenario contain no real assertions (comments only), so
    e2e coverage of this security property is illusory even though unit
    tests do cover it correctly.
- Post-processing: independent security pass found no NEW issue beyond what
  the review already tracked, and confirmed no overstated claims exist in
  code comments or the ticket file. docs/telemetry.md previously had no
  mention of this fix at all (a gap, not an overstatement) — added one
  honest bullet explicitly naming the partial nature of the mitigation
  (bucket count capped; seenKeys/per-bucket store growth still open, tracked
  separately).

## Additional Context
_(user-owned — leave blank)_
