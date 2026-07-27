---
id: TASK-171
title: seenKeys and per-bucket store remain unbounded — memory-DoS only partially mitigated
status: done
created: 2026-07-27T00:56:46.000Z
updated: 2026-07-27T03:09:12.660Z
review-of: TASK-163
resolution: wont-do
---

## Description
Tech-lead review of TASK-163 found that while `buckets` is now capped
(MAX_PROJECT_BUCKETS = 100 with LRU eviction), the actual threat model the
ticket describes — a buggy/hostile local client posting logs with many
DISTINCT values — still has an unbounded vector through TWO other structures
in `lib/telemetry-receiver.js`:

1. `seenKeys` (the global de-dup Set added when TASK-154 was fixed
   post-review) gains one string per distinct `request_id` ingested and is
   NEVER pruned. To create 100+ buckets and actually trigger TASK-163's
   eviction, each row must carry a unique `request_id` (a duplicate is
   skipped BEFORE any bucket is touched) — so posting N distinct
   `request_id`s grows `seenKeys` to N entries regardless of the bucket cap.
2. Each surviving bucket's `store` Map keeps every de-duplicated row forever
   — only `recent` (capped at `RECENT_CAP`, 500) is bounded. A single busy
   project posting many distinct `request_id`s grows that bucket's `store`
   without bound.

So the bucket-count cap closes ONE growth dimension but the PRIMARY one
(distinct request ids driving `seenKeys` and per-bucket `store` growth) is
still wide open over the same untrusted loopback input.

## Impact If Not Fixed
A buggy or hostile local process (or even a very long-running legitimate
session accumulating real telemetry over time) can still exhaust the app's
memory by driving `seenKeys`/`store` growth via many distinct `request_id`
values — the exact threat TASK-163 set out to close remains open through a
different door. Users/reviewers may believe the memory-DoS concern is fully
resolved when it is only partially addressed.

## Acceptance Criteria
- [ ] `seenKeys` has a bound (e.g. cap its size and evict oldest entries via
      the same natural-Map-order LRU technique used for `buckets`, or replace
      it with a bounded structure appropriate for a "have we seen this
      request_id" check — such as capping the set and accepting that a very
      old duplicate might occasionally re-count after eviction, which is an
      acceptable tradeoff for bounded memory).
- [ ] Each bucket's `store` Map has a bound (or the `store` is replaced with a
      structure whose bound is consistent with `recent`'s existing
      `RECENT_CAP`, so per-bucket memory stays proportional to `RECENT_CAP`
      rather than growing with total distinct requests ever seen for that
      project).
- [ ] Document the chosen tradeoffs clearly in code comments (e.g. "a request
      evicted from the dedup set may be double-counted if re-sent after N
      other distinct requests — acceptable because X").
- [ ] Existing legitimate usage (normal telemetry volume over a typical
      session) is unaffected by the new bounds.
- [ ] A test simulates ingesting many more distinct `request_id`s than any
      new bound and asserts `seenKeys`'s size (or equivalent) and each
      bucket's `store` size stay bounded, with no throw/hang.
- [ ] All tests green under `node --test` beyond the known pre-existing
      baseline failures.

## Cucumber Tests
```gherkin
Feature: seenKeys and per-bucket store are bounded

  Scenario: seenKeys never grows unbounded
    Given ingest of many more distinct request_ids than any configured bound
    When all rows have been ingested
    Then seenKeys' size (or equivalent tracking structure) never exceeds the bound

  Scenario: A single busy project's store stays bounded
    Given ingest of many distinct request_ids all tagged the same project
    When all rows have been ingested
    Then that project's bucket store size never exceeds its bound

  Scenario (edge): Bounded growth never throws or hangs
    Given a rapid burst of tens of thousands of distinct request_ids
    When ingestion completes
    Then no exception is thrown and memory stays bounded
```

## Relevant Files
- `C:\projects\claude-cmd-ui2\lib\telemetry-receiver.js` — `seenKeys` Set,
  `ingestLogs`'s de-dup check (before bucket routing), each bucket's `store`
  Map, `RECENT_CAP` (existing bound to reference/reuse).

## Additional Context
_(user-owned — leave blank)_
