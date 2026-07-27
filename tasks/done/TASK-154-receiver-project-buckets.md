---
id: TASK-154
title: Bucket the telemetry receiver's store/recent by project
status: done
created: 2026-07-27T00:00:00Z
updated: 2026-07-26T23:12:12.000Z
agent: swarm-orch1
---

## Description
Turn the receiver's single app-global accumulation into per-project buckets so
the Stats tab (TASK-157) can show usage scoped to one project and forwarding
(TASK-156) can act per project. Bucketed the log-derived rows by each row's
`project` field (added in TASK-152). Rows with an empty project fall into a
`''` (unknown) bucket. Per-project reads AND an app-wide roll-up both remain
available.

`activeProject` no longer drives attribution — it's the "default bucket"
selector only. The cumulative METRIC snapshot stays app-global. `usageForWindow`
keeps scanning ALL rows across buckets.

## Acceptance Criteria
- [x] The receiver stores rows in per-project buckets keyed by `row.project`
      (empty → `''` bucket), de-duplicated by `requestKey` GLOBALLY (fixed
      post-review — see Build Notes).
- [x] `ingestLogs` routes each parsed row into its project's bucket and appends
      to that project's `recent` list, capped at `RECENT_CAP` per project.
- [x] `usageForProject(project)` returns aggregate usage over just that
      project's rows; never throws.
- [x] `getUsageForProject(project)` returns `{ usage, recent }` for that project.
- [x] App-wide `usage()` (all buckets combined) still available.
- [x] `getUsage()` with no/empty project argument returns the `activeProject`
      bucket's usage (falling back to app-wide if empty).
- [x] `snapshotState()`/`emit()`/`onUpdate` payload includes `project` and
      `projectUsage` alongside existing app-wide fields.
- [x] `clear()` clears ALL buckets, recents, the global seen-keys set, and the
      metric snapshot.
- [x] `usageForWindow(window)` still scans every bucket's rows (confirmed by
      tech-lead reading the actual code — not regressed).
- [x] `setActiveProject(name)` still coerces junk to `''`, never throws.
- [x] Module still uses only Node core + `lib/telemetry.js`; no ingest path
      throws.

## Cucumber Tests
```gherkin
Feature: Per-project bucketing in the telemetry receiver

  Scenario: Rows land in their own project bucket
    Given ingested api_request rows tagged project "alpha" and project "beta"
    When usageForProject("alpha") and usageForProject("beta") are read
    Then each returns only that project's totals
    And usage() returns the combined app-wide totals

  Scenario: Untagged rows fall into the unknown bucket
    Given an ingested row whose project is ""
    When usageForProject("") is read
    Then it includes that row
    And no other project's bucket includes it

  Scenario: Live update carries the changed project
    Given an onUpdate subscriber
    When a row tagged project "alpha" is ingested
    Then the emitted payload has project "alpha" and a projectUsage for "alpha"
    And it still carries the app-wide usage field

  Scenario: usageForWindow still spans all buckets (TASK-142 not regressed)
    Given rows in buckets "alpha" and "beta" both inside a time window
    When usageForWindow(window) is called
    Then both rows are summed into the returned totals

  Scenario (edge): Reading an unknown project never throws
    Given no rows for project "ghost"
    When usageForProject("ghost") is read
    Then it returns zeroed emptyTotals-style aggregate and does not throw

  Scenario (regression, added post-review): Same request_id under two projects counts once
    Given a row with request_id "req_dupe_across_projects" tagged project "alpha"
    And the identical request_id posted again tagged project "beta"
    When usage() (app-wide) is read
    Then requests === 1, not 2 — the second post is a global duplicate, ignored
```

## Relevant Files
- `C:\projects\claude-cmd-ui2\lib\telemetry-receiver.js` — `buckets` (a
  `Map<project, {store, recent}>`), `getBucket`/`ensureBucket`/`allRows`
  helpers, a module-level `seenKeys` Set for GLOBAL de-dup (added post-review),
  `usageForProject`/`getUsageForProject`. `globalRecent` preserves
  backward-compatible app-wide recent-feed behavior. `metricSnapshot`/
  `ingestMetrics` untouched (app-global).
- `C:\projects\claude-cmd-ui2\test\task-154-bucket-by-project.e2e.test.js`,
  `C:\projects\claude-cmd-ui2\test\task-154-bucket-by-project.test.js`.
- `C:\projects\claude-cmd-ui2\docs\telemetry.md` — Code map entry updated to
  describe the bucket model.

## Clarifications
- Q: Should the cumulative OTEL metric snapshot also be bucketed per project?
  A: No — leave it app-global (user-confirmed during planning).

## Build/Test/Review Notes
- Coder: restructured internal state to `Map<project, {store, recent}>` with
  helpers; verified against existing test suites, no caller signature changes.
- Tester: 28 new tests (10 e2e, 18 unit), all green. Full suite (at that point):
  3296 pass, 3 fail (confirmed baseline).
- Tech-lead review: core refactor sound; `usageForWindow` confirmed still
  scans all buckets; tests confirmed to exercise real code. Two findings ->
  follow-up tickets:
  - TASK-162 — `getUsage()` no-arg now scopes to `activeProject`, creating an
    inconsistency between the existing global Telemetry panel's refresh path
    (now project-scoped) and its live-update path (still app-wide). Needs
    reconciling against TASK-157's Stats-tab work.
  - TASK-163 — unbounded per-project bucket count is a new memory-DoS
    amplification vector from loopback-input (previously the recent-feed was
    capped at 500 total; now it's 500 x unbounded-bucket-count). Needs an
    LRU/max-bucket cap.
- Post-processing: independent security pass found a THIRD, more urgent issue
  beyond the two already-filed follow-ups — per-project bucketing had silently
  scoped request de-dup PER BUCKET instead of globally, so the same
  `request_id` posted under two different `project` tags would be double
  counted in `usage()`/`usageForWindow`/forwarded payloads, contradicting
  `lib/telemetry.js#requestKey`'s explicit "project is not part of the de-dup
  identity" contract. Given this directly undermines cost/usage accuracy (the
  core purpose of this feature), it was FIXED IMMEDIATELY rather than deferred:
  added a global `seenKeys` Set consulted before per-bucket routing (first
  write wins, matching pre-refactor global de-dup semantics); `clear()` now
  also clears `seenKeys`. A pre-existing test that had asserted the buggy
  behavior was corrected, and a new regression test was added. Full suite
  re-run after the fix: 3301 tests, 3297 pass, 3 fail (confirmed baseline, no
  new regressions). docs/telemetry.md's `lib/telemetry-receiver.js` Code map
  entry updated to describe the new bucket model (was describing a single
  de-duplicated store, now inaccurate).

## Additional Context
_(user-owned — leave blank)_
