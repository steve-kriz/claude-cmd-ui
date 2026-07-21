---
id: TASK-101
title: Tasks board renders lanes dynamically from team config
status: done
created: 2026-07-20T13:15:00Z
updated: 2026-07-20T23:21:51.881Z
order: 12
activities: [{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-20T21:52:00Z","finishedAt":"2026-07-20T22:57:23Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-20T21:54:00Z","finishedAt":"2026-07-20T23:16:38Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-20T21:56:00Z","finishedAt":"2026-07-20T23:21:51Z"}]
---

## Description
Replace the six hardcoded `.tasks-lane` divs (`renderer/index.html` 656–685) with lanes
generated from `tasks/team-config.json`: `renderTasksBoard` builds/updates lane elements from
the normalized config (renderer mirror of TASK-097/098 logic), in config order, keeping
`data-status` attributes, the count spans, the post-processing `+` button, and the hidden
`unknown` lane. Lane headers show configured labels, a `title` tooltip with the column
description, and a small agent badge when the column names an agent (Q2 display-only). System
lanes keep their existing `data-status` colors (styles.css 2571–2577); user lanes get a
`.tasks-lane.user-lane` default accent. Config is read during `pollTasksOnce` with
keep-last-good semantics and participates in the render signature so config edits re-render
within a poll tick.

## Clarifications
- Q1: lanes are config-driven. Q2: the agent badge is metadata only — no dispatch effect. Q4: config read from `tasks/team-config.json`; missing/corrupt file → defaults (board identical to today).

## Acceptance Criteria
- [ ] With no config file, the rendered board is behaviorally identical to today: same six lanes, same order/labels/colors, no badges (regression scenario asserted).
- [ ] With a config adding `ux-review` between Testing and Post-processing, the board renders seven lanes in that order; `ux-review` tickets appear in their lane, not in `unknown`.
- [ ] `failed-testing` cards still fold into Testing with the red marker; `unknown` lane still catches out-of-config statuses.
- [ ] Configured labels/descriptions/agent badges render on lane headers; a badge naming a nonexistent agent renders in a warning style.
- [ ] `tab.els.tasksLanes` static NodeList usage (line 488) is replaced by render-time queries so generated lanes work everywhere (`renderTasksBoard` 5823–6060, counts at 6043, working-indicator at 6055–6061, keep-awake scan 6083–6091 — keep-awake stays system-statuses-only).
- [ ] Config read failure mid-poll keeps the last good config (mirroring keep-last-good-parse); first-ever read failure = defaults.
- [ ] Post-processing lane retains its `+` add button wiring (6625–6637).
- [ ] Unit + e2e tests (`task-101-*` pair) incl. the no-config regression.

## Cucumber Tests
```gherkin
Feature: Dynamic board lanes
  Scenario: No config renders today's board (edge/regression)
    Given tasks/team-config.json does not exist
    Then six lanes render with today's order, labels and no badges

  Scenario: User column renders as a lane
    Given config inserts ux-review after testing
    Then seven lanes render in config order and ux-review tickets show there

  Scenario: failed-testing still folds (edge)
    Given a failed-testing ticket
    Then its card renders in the Testing lane with the red marker

  Scenario: Corrupt config (failure)
    Given team-config.json holds invalid JSON
    Then the board renders defaults, keeps polling, and nothing throws

  Scenario: Missing badge agent (failure)
    Given a column assigned agent "ghost"
    Then the lane badge renders in warning style and rendering completes
```

## Edge Cases & Failure Paths
- Config changed while dragging (re-render preserves in-flight DnD gracefully — re-query lanes on drop); very long labels (CSS truncation); lane removed while tickets visible (cards fall to unknown next render); duplicate render listeners avoided by rebuilding lane DOM wholesale each render (current `cards.innerHTML = ''` pattern).

## Relevant Files & Context
- `renderer/index.html` 656–685 (lanes → template or JS generation).
- `renderer/renderer.js` — els 488, lane mirrors 5147–5176 (extend with config-aware mirrors of TASK-098), `pollTasksOnce` 5705–5774 (config read + signature), `renderTasksBoard` 5823–6060, keep-awake 6083–6091.
- `renderer/styles.css` 2538–2610 + new `.user-lane` rule; `lib/team-config.js` / `lib/ticket-lanes.js` (logic mirrored, lockstep comment).

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
