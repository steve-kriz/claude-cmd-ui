---
id: TASK-172
title: Bucket eviction orphans seenKeys entries, permanently blocking re-ingest for evicted projects
status: done
created: 2026-07-27T00:56:46.000Z
updated: 2026-07-27T03:09:16.105Z
review-of: TASK-163
resolution: wont-do
---

## Description
Tech-lead review of TASK-163 found that when a bucket is evicted
(`buckets.delete(oldestKey)`), the evicted project's request keys are NOT
removed from the global `seenKeys` Set, and its rows are NOT removed from
`globalRecent`. Because de-dup is checked BEFORE bucket creation/lookup, any
re-posted row for an evicted project is silently dropped (its `request_id` is
already in `seenKeys`) and its bucket can never be rebuilt from re-ingest.

A normal LRU cache re-populates cleanly on the next miss; here, re-population
is permanently blocked for any project whose bucket was evicted, because the
de-dup guard treats its old rows as "already seen" forever.

Separately, the app-wide `recent` feed (sourced from `globalRecent`, which
still holds an evicted project's rows until they naturally age out past the
500-row cap) can visually disagree with `usage()`/aggregate totals (which no
longer count the evicted bucket at all) — an inconsistent view between the
recent-activity feed and the summary totals.

## Impact If Not Fixed
Users can see a project's Stats read zero even though telemetry for it is
still actively being received (re-sends of the same request_ids are silently
dropped by the de-dup guard) — the project's usage effectively goes dark and
never recovers until the app restarts (clearing `seenKeys`). Separately, the
`recent` feed can show rows for a project whose aggregate totals no longer
count them, a confusing inconsistency. This also compounds TASK-171's
unbounded-`seenKeys`-growth concern, since orphaned keys are never cleaned up.

## Acceptance Criteria
- [ ] When a bucket is evicted, its associated `seenKeys` entries are removed
      (or the ticket's TASK-171 fix for bounding `seenKeys` inherently
      resolves this by evicting seenKeys entries in lockstep with bucket
      eviction — coordinate with TASK-171 if it's built first, avoid
      duplicating divergent fixes).
- [ ] After a bucket is evicted, re-posting the SAME request_id for that
      project successfully re-creates a bucket and counts the row (rather
      than being silently dropped forever).
- [ ] Decide and document the relationship between bucket eviction and
      `globalRecent`: either prune the evicted project's rows from
      `globalRecent` too (keeping the recent feed and aggregate totals in
      sync), or explicitly document why `globalRecent` intentionally
      retains rows independent of bucket eviction (e.g. it's a
      time-bounded window, not a per-project view) — pick ONE and make the
      behavior consistent/understood, not accidental.
- [ ] A test evicts a project's bucket, re-posts a row with the same
      request_id for that project, and asserts it is now counted (not
      silently dropped).
- [ ] All tests green under `node --test` beyond the known pre-existing
      baseline failures.

## Cucumber Tests
```gherkin
Feature: Bucket eviction does not permanently block re-ingest

  Scenario: A re-posted request_id for an evicted project is counted again
    Given a project's bucket has been evicted via the LRU cap
    When a row with the SAME request_id for that project is re-ingested
    Then the project's bucket is recreated and the row is counted

  Scenario: recent feed and aggregate totals stay consistent after eviction
    Given a project's bucket has been evicted
    When the app-wide recent feed and usage() totals are both read
    Then their relationship is documented/consistent (not silently divergent)
```

## Relevant Files
- `C:\projects\claude-cmd-ui2\lib\telemetry-receiver.js` — eviction logic in
  `ensureBucket`, the de-dup guard in `ingestLogs` (checked before bucket
  routing), `globalRecent`, `seenKeys`.
- Related: `C:\projects\claude-cmd-ui2\tasks\todo\TASK-171-seenkeys-store-still-unbounded.md`
  — if built first, its fix for bounding `seenKeys` may already resolve part
  of this ticket; check its shipped state before duplicating work.

## Additional Context
_(user-owned — leave blank)_
