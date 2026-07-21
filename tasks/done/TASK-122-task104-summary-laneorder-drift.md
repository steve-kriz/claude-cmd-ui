---
id: TASK-122
title: TASK-104 review: unify lib/renderer lane-order derivation in formatTasksSummary
status: done
created: 2026-07-21T02:07:59.621Z
updated: 2026-07-21T04:39:29.114Z
review-of: TASK-104
activities: [{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-21T03:20:00Z","finishedAt":"2026-07-21T04:26:02Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-21T03:22:00Z","finishedAt":"2026-07-21T04:35:48Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-21T03:24:00Z","finishedAt":"2026-07-21T04:39:28Z"}]
---

## Description
Review follow-up for TASK-104 (config-aware summaries): the lib formatTasksSummary derives lane order via `laneStatusesFor(columns)` (re-injects the six system lanes) while the renderer mirror uses `cols.map(c=>c.status)` verbatim. For a PARTIAL columns array the two diverge. Unreachable today (both are fed normalized columns), but it is the exact renderer/lib skew the mirror contract guards against — align the derivation.

Severity from review: **minor**. This is a review follow-up of TASK-104.

## Impact If Not Fixed
If a future caller ever passes a hand-built/partial columns array to either copy, the two implementations would silently produce different summaries for the same board.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
