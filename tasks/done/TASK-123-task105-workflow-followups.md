---
id: TASK-123
title: TASK-105 review: wfIsFallback empty-name parity + stale harness + malformed-agent test
status: done
created: 2026-07-21T02:07:59.621Z
updated: 2026-07-21T04:49:16.265Z
review-of: TASK-105
activities: [{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-21T03:26:00Z","finishedAt":"2026-07-21T04:41:55Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-21T03:26:00Z","finishedAt":"2026-07-21T04:46:31Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-21T03:28:00Z","finishedAt":"2026-07-21T04:49:16Z"}]
---

## Description
Review follow-ups for TASK-105 (workflow panel): (F1) renderer wfIsFallback returns false for empty/null name while lib isFallback returns true — the mirror diverges and the unit test locks the wrong value; align to lib. (F2) the e2e harness still extracts the now-unused readTeamAgentNames and its comments describe the pre-fix flow. (F3) no test covers a present-but-malformed agent file (unreadable/binary/fence-less) in the inline name resolver skip path.

Severity from review: **minor**. This is a review follow-up of TASK-105.

## Impact If Not Fixed
The documented renderer/lib mirror contract is silently broken (a future re-sync hits conflicting behavior and a test asserting the non-faithful result); future cleanup of the board-only readTeamAgentNames would break the unrelated workflow e2e; the resolver's robustness claims rest on untested branches.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
