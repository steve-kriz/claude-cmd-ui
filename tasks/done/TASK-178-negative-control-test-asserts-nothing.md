---
id: TASK-178
title: TASK-167's negative-control test asserts nothing meaningful
status: done
created: 2026-07-27T01:59:49.000Z
updated: 2026-07-27T03:09:42.499Z
review-of: TASK-167
resolution: wont-do
---

## Description
Tech-lead review of TASK-167 found that the new e2e test's "negative control"
in `test/telemetry-receiver.e2e.test.js` (after the positive forward
assertion, ~lines 782-786) calls `setProjectForwarding(project.trim(), false)`,
waits, and asserts `forwarded.length` is still `1` — presented as proof that
the trimmed variant is a distinct, still-off bucket key.

This assertion is not load-bearing: `scheduleForward` only ever runs when
`ingestLogs` observes `added > 0` rows. No POST/ingest happens in that
control's window, so the forward timer is never re-armed at all — the
assertion would pass identically whether or not trimming were still in place
(i.e. even if the exact bug TASK-167 fixed were reintroduced, this specific
control would still show `forwarded.length === 1` because nothing triggers a
NEW forward attempt in that window).

## Impact If Not Fixed
Reviewers/maintainers may trust this "negative control" as protection against
a regression in the trimmed/untrimmed key distinction, when it actually
provides none. A real key-normalization regression on the distinct-bucket
path could ship unnoticed, believing this test would have caught it.

## Acceptance Criteria
- [ ] Rewrite the negative control so it is actually load-bearing: after
      disabling forwarding for the trimmed variant, INGEST a row tagged with
      the TRIMMED project string (creating/touching that distinct bucket),
      and assert NO additional forward fires for it (while the original
      untrimmed project's forward count stays at its expected value).
- [ ] Confirm this rewritten control WOULD fail if trimming were
      reintroduced (i.e. verify by reasoning through the logic, or by
      temporarily reintroducing the trim locally during development and
      confirming the test catches it — do not leave the trim reintroduced in
      the final code).
- [ ] All tests green under `node --test` beyond the known pre-existing
      baseline failures.

## Cucumber Tests
```gherkin
Feature: The negative control genuinely distinguishes trimmed vs untrimmed keys

  Scenario: A row ingested under the trimmed variant does not trigger a forward
      for a project whose toggle was only enabled for the untrimmed key
    Given setProjectForwarding("  C:\\projects\\alpha  ", true) was called
      (untrimmed key enabled)
    And setProjectForwarding("C:\\projects\\alpha", false) was called (trimmed
      key explicitly disabled)
    When a row is ingested tagged with the TRIMMED project string
      "C:\\projects\\alpha"
    Then no NEW forward fires for the trimmed-key bucket
    And this proves the two keys are genuinely treated as distinct buckets
```

## Relevant Files
- `C:\projects\claude-cmd-ui2\test\telemetry-receiver.e2e.test.js` — the
  negative-control test to rewrite (~lines 725-790, specifically the control
  at ~782-786).

## Additional Context
_(user-owned — leave blank)_
