---
id: TASK-032
title: exclude post-processing tickets from board counts and auto-build loop
status: done
created: 2026-07-18T21:57:07.000Z
updated: 2026-07-18T22:23:30Z
---

## Description
Follow-up from the TASK-028 tech-lead review (minor). TASK-028 added a `TASKS_POST_PROCESSING_KIND` mirror and an `isTasksPostProcessingTicket(fm)` predicate to `renderer/renderer.js`, but never wired the predicate into the board's count/continue-build logic. `taskStatusCounts` (~renderer.js:6070-6074) and the Build pending count (~6095) bucket tickets purely by `status`, and `maybeContinueBuild` (~6149) loops while `counts.todo > 0`. A malformed/tampered ticket with `kind: post-processing` **and** `status: todo` (or `failed-testing`) would therefore inflate the pending count and spin the auto-build loop forever, because `lib/ticket-queue.js`'s `selectNextBatch`/`claimTicket` correctly refuse to ever dispatch a `kind: post-processing` ticket. The lib guard means such a ticket is never actually built (no correctness/security break), but the renderer contradicts the "even if status tampered" intent, and the mirror predicate added for exactly this purpose is dead code.

## Acceptance Criteria
- [x] `isTasksPostProcessingTicket(fm)` (the existing renderer mirror predicate) is used to exclude `kind: post-processing` tickets from the `todo` and `failed-testing` buckets in `taskStatusCounts`.
- [x] The Build button's pending count excludes `kind: post-processing` tickets regardless of their `status`.
- [x] `maybeContinueBuild`'s continue condition does not treat a `kind: post-processing` ticket as pending work (a board containing only post-processing tickets plus done tickets does not spin the auto-build loop).
- [x] A post-processing ticket with `status: post-processing` continues to render in the post-processing lane (this change only affects counting/looping, not lane placement).
- [x] No change to `lib/ticket-queue.js` behavior; the lib guard stays authoritative. No new status introduced.
- [x] If `isTasksPostProcessingTicket` were intentionally meant to be unused, instead remove it — but the preferred resolution is to wire it in.
- [x] Full suite passes under `node --test`.

## Cucumber Tests
```gherkin
Feature: Post-processing tickets never count as pending build work

  Scenario: A tampered post-processing ticket with a todo status is not pending
    Given a board with one ticket { status: "todo", kind: "post-processing" } and no other todo tickets
    When taskStatusCounts computes the buckets
    Then the pending build count is 0
    And maybeContinueBuild does not start another build iteration

  Scenario: A normal todo ticket is still counted
    Given a board with one ticket { status: "todo" } (no kind)
    When taskStatusCounts computes the buckets
    Then the pending build count is 1

  Scenario: A normal post-processing ticket still renders in its lane
    Given a ticket { status: "post-processing", kind: "post-processing" }
    Then it appears in the post-processing lane
    And it is not counted as pending build work
```

## Relevant Files and Context
- `renderer/renderer.js` — `isTasksPostProcessingTicket` (~5135, currently dead), `taskStatusCounts` (~6070-6074), Build pending count (~6095), `maybeContinueBuild` (~6149). Browser script — verify with the repo's source-scan test convention (see `test/ticket-lanes.test.js`) since it cannot be `require`d.
- `lib/ticket-queue.js` — reference only; `selectNextBatch`/`claimTicket` already guard on `isPostProcessingTicket`. Do NOT change.
- Add/extend tests in the natural place (e.g. a renderer source-scan test asserting the count path references `isTasksPostProcessingTicket`, plus a pure-logic unit test if the counting helper is factored out).

## Edge and Failure Cases
- Tampered `kind: post-processing` + `status: todo` / `failed-testing` → excluded from pending count and continue-loop.
- Normal todo/failed-testing tickets → still counted.
- `kind` absent or any other value → counted as normal.

## Implementation Notes
- `renderer/renderer.js` `taskStatusCounts(tab)`: added `if (isTasksPostProcessingTicket(tk.fm)) { counts['post-processing']++; continue; }` inside the per-ticket loop, wiring in the previously-dead predicate. All count/continue consumers (`updateBuildBtn`, `toggleAutoBuild`, `maybeContinueBuild`) funnel through `taskStatusCounts`, so the exclusion propagates. Lane placement (`renderTasksBoard`, status-driven) unchanged.
- Tests: `test/task-032-post-processing-counts.e2e.test.js` (Given/When/Then scenarios) + `test/task-032-post-processing-counts.test.js` (unit tests + source-scan drift guards tying the pure replicas to the real renderer source). Full suite green: 810 pass / 0 fail.
- Tech-lead review: clean. Security review (post-processing TASK-035): no exploitable issues (`counts[s]` over string-only frontmatter is prototype-pollution-safe; exclusion keys on `kind`, independent of `status`).

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
