---
id: TASK-119
title: TASK-101 review: mirror lockstep test, agent-badge false-warning, config-delete revert
status: done
created: 2026-07-21T02:07:59.621Z
updated: 2026-07-21T04:04:23.545Z
review-of: TASK-101
activities: [{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-21T03:14:00Z","finishedAt":"2026-07-21T03:52:07Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-21T03:14:00Z","finishedAt":"2026-07-21T04:00:11Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-21T03:16:00Z","finishedAt":"2026-07-21T04:04:23Z"}]
---

## Description
Review follow-ups for TASK-101 (dynamic board lanes): (F1) no lockstep test that the renderer normalizeTasksColumns ordering agrees with lib normalizeConfig/laneStatusesFor. (F2) when `.claude/agents/` is unreadable/absent, `agentNames` stays null so EVERY configured agent badge is falsely marked `.missing` warning (renderer.js:6825) — distinguish "not yet loaded" from "confirmed absent". (F3) deleting team-config.json mid-session does not revert to the six default lanes (ok:false treated as keep-last-good; cannot distinguish deletion from transient error).

Severity from review: **minor**. This is a review follow-up of TASK-101.

## Impact If Not Fixed
The board could order/route user lanes differently from the engine that files tickets into folders without a failing test; correctly-configured boards can flash spurious red "unknown agent" warnings; a user deleting the config to return to defaults keeps seeing removed custom lanes until a folder switch or restart.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
