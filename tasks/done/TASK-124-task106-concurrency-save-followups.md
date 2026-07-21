---
id: TASK-124
title: TASK-106 review: concurrency-save config-reset data-loss + toolbar reflection lag
status: done
created: 2026-07-21T02:07:59.621Z
updated: 2026-07-21T05:02:33.317Z
review-of: TASK-106
activities: [{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-21T03:30:00Z","finishedAt":"2026-07-21T04:52:55Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-21T03:30:00Z","finishedAt":"2026-07-21T04:59:25Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-21T03:32:00Z","finishedAt":"2026-07-21T05:02:33Z"}]
---

## Description
Review follow-ups for TASK-106 (guided editor): (F1) the concurrency Save re-reads team-config.json and, on any read/parse failure, falls back to null → buildWorkingConfigFromRaw(null) → wipes user columns/version/skill.planningModel/unknown fields to defaults (renderer.js:7008-7017); it had the render-time rawConfig in hand — fall back to that (keep-last-good) instead. (F2) after Save, the toolbar dropdown + buildCommandFor reflect the new concurrencyDefault only after the next poll (syncTasksConcurrencyOption reads the stale tab.tasks.config); update the in-memory config on Save and correct the overstated comment.

Severity from review: **minor**. This is a review follow-up of TASK-106.

## Impact If Not Fixed
A momentary unreadable/corrupt team-config.json at Save time silently destroys the user's custom kanban columns and skill.planningModel; and a build queued immediately after saving a new default carries the OLD concurrency value until the next poll.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
