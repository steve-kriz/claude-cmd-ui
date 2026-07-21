---
id: TASK-121
title: TASK-103 review: corrupt-config notice for non-config JSON + clamp concurrencyDefault in renderer serializer
status: done
created: 2026-07-21T02:07:59.621Z
updated: 2026-07-21T04:19:05.255Z
review-of: TASK-103
activities: [{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-21T03:18:00Z","finishedAt":"2026-07-21T04:10:07Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-21T03:18:00Z","finishedAt":"2026-07-21T04:15:21Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-21T03:20:00Z","finishedAt":"2026-07-21T04:19:05Z"}]
---

## Description
Review follow-ups for TASK-103 (column manager): (F1) the corrupt-config notice fires only when JSON.parse throws; a valid-JSON-but-non-config file (number/string/array, or `columns` not an array) silently loads defaults and a subsequent Save overwrites the file with defaults — set the notice for these too (mirror lib normalizeConfig warnings). (F2) renderer tasksSerializeTeamConfig round-trips `skill.concurrencyDefault` UNCLAMPED, diverging from lib serializeConfig which clamps via resolveConcurrency — clamp it too.

Severity from review: **minor**. This is a review follow-up of TASK-103.

## Impact If Not Fixed
A user whose team-config.json has a structural mistake gets no signal their columns were reset and the next Save silently overwrites with defaults (config loss); and a column-manager Save can leave an out-of-range build concurrency on disk.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
