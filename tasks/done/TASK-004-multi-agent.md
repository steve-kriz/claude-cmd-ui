---
id: TASK-004
title: multi agent
status: done
created: 2026-07-18T03:54:22.555Z
updated: 2026-07-18T05:08:03Z
startedAt: 2026-07-18T04:52:26Z
finishedAt: 2026-07-18T05:08:03Z
---

## Description
Allow more than one agent to run at the same time so multiple tickets can be
built concurrently, instead of one at a time.

This directly changes the orchestration contract in
`.claude/skills/orchestrate/SKILL.md`, which today mandates that **exactly one
ticket is in flight at a time** ("Never build two tickets in parallel — file
writes and git state must stay consistent"). Lifting that rule means the system
must instead guarantee that concurrent builds do not corrupt ticket files or the
board: each build must only ever write its own ticket, whole-file writes stay
atomic per ticket, and no two agents may claim the same ticket. The board itself
already tolerates concurrent updates (it re-reads every poll and keeps the last
good parse), but the orchestrator's "one in flight" assumption and its
sequential build loop must be replaced with a bounded-concurrency scheme, and
the SKILL contract updated to match. Git state consistency (the original reason
for the single-flight rule) must be addressed — e.g. per-ticket isolation — so
parallel builds don't clobber each other's working tree.

## Acceptance Criteria
- [ ] More than one ticket can be in an actively-worked state (`in-progress`/`testing`) at the same time, with each shown on the board concurrently.
- [ ] A ticket is claimed by at most one agent at a time; no two agents pick up the same ticket.
- [ ] Each concurrent build only ever writes its own ticket file; one build never overwrites another ticket's file or the board's shared state.
- [ ] Ticket writes remain whole-file and atomic per ticket, so a concurrent poll never reads a half-written file (last-good-parse behaviour is preserved).
- [ ] Concurrent builds do not corrupt shared git/working-tree state (e.g. builds are isolated per ticket, or serialized only at the points that touch shared state).
- [ ] There is a bound on how many agents run at once, and additional queued tickets wait rather than exceeding that bound.
- [ ] The orchestration SKILL contract is updated to reflect concurrent builds, replacing the "exactly one ticket in flight" rule with the new concurrency and isolation rules.

## Cucumber Tests
```gherkin
Feature: Multiple agents building tickets concurrently

  Background:
    Given the Tasks board has several tickets in "todo"

  Scenario: Two tickets are built at the same time
    When the build runs with concurrency enabled
    Then two different tickets can be in "in-progress" simultaneously
    And each appears in an actively-worked lane on the board

  Scenario: A ticket is only claimed by one agent
    Given two agents are available to pick up work
    When they both look for the next "todo" ticket
    Then the same ticket is not claimed by both agents
    And each agent works a distinct ticket

  Scenario: Concurrent writes do not cross tickets
    Given TASK-300 and TASK-301 are being built at the same time
    When both agents write their ticket files
    Then TASK-300's write only changes TASK-300's file
    And TASK-301's write only changes TASK-301's file

  Scenario: Board never renders a half-written ticket during concurrency
    Given multiple tickets are being written concurrently
    When the board polls mid-write
    Then any ticket that momentarily fails to parse keeps its last good card
    And no card renders garbage

  Scenario: Concurrency is bounded
    Given the concurrency limit is 2
    And there are 5 tickets in "todo"
    When the build runs
    Then at most 2 tickets are actively worked at any moment
    And the remaining tickets wait in "todo"

  Scenario: Shared git state is not corrupted by parallel builds
    Given TASK-300 and TASK-301 build in parallel and both change files
    When both builds complete
    Then neither build's changes are lost or intermixed with the other's
```

## History
### 2026-07-18T05:00:16Z — coder
**Prompt:** Implement TASK-004: allow bounded-concurrency multi-agent builds.
Replace the "exactly one ticket in flight" rule with a claim-safe,
per-ticket-isolated concurrency scheme; update the SKILL contract; provide a
pure, requireable `lib/` helper for the claim/queue/isolation logic mirroring
`lib/ticket-history.js` / `lib/ticket-accounting.js`. Don't touch ticket files.

**Response:** Created `lib/ticket-queue.js` (pure, Electron-free):
`DEFAULT_CONCURRENCY = 3`, `MAX_CONCURRENCY = 8`, `resolveConcurrency()`
(clamps to `[1,8]`); `claimTicket(fm, agentId)` — pure compare-and-set that
grants only when the freshly-read ticket is claimable (`todo`/`failed-testing`)
and unowned, sets `status: in-progress` + `agent`, bumps `updated`, preserves
`created`; same-agent re-entry is a safe `ok`; first whole-file writer wins,
loser gets `ok:false, reason:'claimed'`. `releaseTicket(fm)` clears the claim on
terminal state. `selectNextBatch(tickets,{limit})` returns oldest-first
claimable tickets fitting `limit − activeCount`; extras wait. Git isolation via
`ticketBranchName(id)` (`orchestrate/task-004`) + `ticketWorktreeDir(base,id)`
so parallel builds don't clobber the shared tree. **No renderer/main change
needed** — the board already tolerates concurrent active tickets
(`TASKS_ACTIVE_STATUSES` is a list, per-card dot derived from status,
last-good-parse poller, `serializeTicket` preserves the new `agent` key);
confirmed rather than adding redundant code. Rewrote SKILL Phase 2 into a
bounded-concurrency top-up loop and added a "Concurrency, claims, and isolation"
section; documented the optional `agent` claim field. All 90 existing tests
green. Suggested tester file: `test/ticket-queue.test.js`.

### 2026-07-18T05:08:03Z — tester
**Prompt:** Write automated tests for `lib/ticket-queue.js` covering the claim
compare-and-set (first-writer-wins), bounded concurrency (`selectNextBatch` /
`resolveConcurrency`), release, git-isolation name builders, and the `agent`
claim field round-trip through serialize/parse; implement the ticket's Gherkin
scenarios; mock all external calls; run the full suite; report.

**Response:** `test/ticket-queue.test.js` present and green — 50 tests covering
`resolveConcurrency` clamping, `claimTicket` grant/reject/re-entry/purity,
`releaseTicket`, `selectNextBatch` slot math + oldest-first ordering + bound,
`idSlug`/`ticketBranchName`/`ticketWorktreeDir`, and the `agent`-key
serialize/parse round-trip with `## Additional Context` preserved. Includes
CUCUMBER-tagged scenarios for every ticket criterion: same ticket not
double-claimed (first writer wins), concurrency bounded (limit 2, 5 todos → 2
dispatched / 3 wait), two tickets in-progress simultaneously, each write
contains only its own id/claim, distinct isolation names. Full suite via
`node --test "test/**/*.test.js"` → tests 140, pass 140, fail 0 (~4.3s). No
production code modified. Runtime git-worktree isolation and the live board's
concurrent-poll rendering remain app-exercisable only.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
