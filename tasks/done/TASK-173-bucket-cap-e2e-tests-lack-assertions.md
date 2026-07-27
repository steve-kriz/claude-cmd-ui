---
id: TASK-173
title: Bucket-cap e2e tests do not assert the primary acceptance criterion
status: done
created: 2026-07-27T00:56:46.000Z
updated: 2026-07-27T03:09:25.167Z
review-of: TASK-163
resolution: wont-do
---

## Description
Tech-lead review of TASK-163 found that the flagship e2e scenario "Bucket
count never exceeds the cap" in `test/task-163-bucket-cap.e2e.test.js` never
actually asserts a bounded bucket count or that old projects were evicted —
its eviction-verification loop contains only comments, zero assertions, and
the test ends by asserting only that `finalUsage.usage` is truthy. The
"Eviction/overflow never throws" edge test likewise asserts only
`requests > 0`, not that the count is capped at 100.

The real eviction assertions live only in the unit test file
(`test/task-163-bucket-cap.test.js`), which DOES cover the behavior well —
but the E2E coverage claimed for this security-relevant acceptance criterion
is illusory (tests exist and pass, but wouldn't catch a real regression in
the cap/eviction behavior as exercised over the actual loopback ingest path).

## Impact If Not Fixed
A future change that breaks the bucket cap specifically in the HTTP-ingest
path (e.g. an ingest route that bypasses `ensureBucket`, or a difference
between the unit-tested code path and the real loopback-socket path) would
NOT be caught by these e2e tests, giving false confidence that the memory-DoS
bound holds end-to-end over the actual attack surface (a local process POSTing
to the loopback receiver) rather than just in isolated unit calls.

## Acceptance Criteria
- [ ] The "Bucket count never exceeds the cap" e2e scenario in
      `test/task-163-bucket-cap.e2e.test.js` actually asserts a bounded
      bucket/project count (e.g. via `usageForProject` returning zero for
      evicted projects, or an exposed bucket-count read) after ingesting more
      distinct projects than the cap over the REAL loopback HTTP socket (not
      just a direct function call).
- [ ] The "Eviction/overflow never throws" edge test asserts the count is
      actually capped at `MAX_PROJECT_BUCKETS`, not just that some requests
      were counted.
- [ ] All tests green under `node --test` beyond the known pre-existing
      baseline failures.

## Cucumber Tests
```gherkin
Feature: Bucket-cap e2e coverage actually asserts the cap over the real HTTP path

  Scenario: Bucket count is verifiably capped over the real loopback socket
    Given more than MAX_PROJECT_BUCKETS distinct projects POSTed to the real
      loopback receiver
    When ingestion completes
    Then the oldest project's usageForProject returns zero (evicted)
    And the most recent MAX_PROJECT_BUCKETS projects all have non-zero usage

  Scenario (edge): A large burst over HTTP stays capped
    Given a burst of many more distinct projects than the cap, posted over
      the real loopback socket
    When ingestion completes
    Then the retained project count is capped at MAX_PROJECT_BUCKETS
    And no exception is thrown
```

## Relevant Files
- `C:\projects\claude-cmd-ui2\test\task-163-bucket-cap.e2e.test.js` — the two
  scenarios lacking real assertions (the no-op eviction-verification loop,
  and the throws-check-only edge test).
- `C:\projects\claude-cmd-ui2\test\task-163-bucket-cap.test.js` — the unit
  test file that already covers this behavior correctly; use it as the
  reference for what a REAL assertion looks like, then apply the equivalent
  check over the real HTTP ingest path in the e2e file.

## Additional Context
_(user-owned — leave blank)_
