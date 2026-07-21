---
id: TASK-104
title: Config-aware board summaries (status line + Slack tasks command)
status: done
created: 2026-07-20T13:15:00Z
updated: 2026-07-21T00:32:32.516Z
order: 15
activities: [{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-20T22:10:00Z","finishedAt":"2026-07-21T00:23:38Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-20T22:12:00Z","finishedAt":"2026-07-21T00:28:48Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-20T22:14:00Z","finishedAt":"2026-07-21T00:32:32Z"}]
---

## Description
The board summary builders currently iterate `TASKS_LANE_STATUSES` (renderer.js 8421–8462 for
the Slack `tasks` command; the `tasksStatus` toolbar line nearby): make them iterate the
configured column order/labels so user columns appear with correct counts, while
`failed-testing` continues folding into Testing and `unknown` is reported when non-empty.
Working-indicator and keep-awake counting stay pegged to system active statuses (unchanged).

## Clarifications
- Q1: summaries must reflect the dynamic lanes; swarm-activity semantics remain system-only.

## Acceptance Criteria
- [ ] The Slack `tasks` summary lists counts per configured column in board order using configured labels, folding `failed-testing` into Testing exactly as today.
- [ ] With no config, summary output is identical to current behavior (regression).
- [ ] Tickets in unknown statuses are reported in an "unknown" line only when present.
- [ ] `tasksStatus` toolbar text uses the same config-aware counts.
- [ ] Active/working counts (8439, 8593, 6055–6061) still count only `defining`/`in-progress`/`testing`.
- [ ] Unit + e2e tests (`task-104-*` pair), following `test/slack-tasks-command.test.js` patterns.

## Cucumber Tests
```gherkin
Feature: Config-aware summaries
  Scenario: Summary includes a user column
    Given config with ux-review holding 2 tickets
    When the Slack tasks summary is built
    Then a "UX Review 2" entry appears in board order

  Scenario: No config regression (edge)
    Given no team-config.json
    Then the summary output is identical to the current format

  Scenario: Unknown statuses reported, not hidden (failure)
    Given a ticket with a status in no column
    Then the summary includes an unknown count rather than dropping the ticket
```

## Edge Cases & Failure Paths
- Config read failure (last-good/defaults, same source as TASK-101 — share the loaded config, do not re-read); empty board; label with Slack-meaningful characters (existing escaping path in `lib/slack-*` respected).

## Relevant Files & Context
- `renderer/renderer.js` 8421–8462, 8593, 6043–6061.
- `lib/slack-commands.js` (verify whether summary formatting lives there — check both).
- Tests `test/slack-tasks-command.test.js` / `.e2e.test.js`.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
