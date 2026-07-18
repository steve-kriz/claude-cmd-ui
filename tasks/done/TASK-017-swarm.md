---
id: TASK-017
title: swarm
status: done
created: 2026-07-18T10:14:27.379Z
updated: 2026-07-18T11:19:07.843Z
startedAt: 2026-07-18T11:03:30.000Z
finishedAt: 2026-07-18T11:19:07.843Z
---

## Description
Extend the orchestrate skill so multiple tickets build **in parallel as a coordinated swarm**, processing tickets in **sets/batches** with self-coordination, and update `.claude/skills/orchestrate/SKILL.md` accordingly. This builds directly on the existing bounded-concurrency primitives in `lib/ticket-queue.js` (`DEFAULT_CONCURRENCY` = 3, `MAX_CONCURRENCY` = 8, `selectNextBatch`, `claimTicket`/`releaseTicket`, and per-ticket isolation via `ticketBranchName`/`ticketWorktreeDir`). The swarm coordinates with itself through the existing guarantees: atomic per-ticket **claims** prevent two agents from picking the same ticket, per-ticket **git isolation** prevents parallel builds clobbering each other's tree, and only **shared-git steps** (e.g. merging a finished branch back to base) are serialized. The skill must describe processing the queue in sets/batches: select a batch up to the concurrency bound, run it in parallel, and top up free slots as builds finish until the board is clear. No product code changes are required — the primitives already exist; this ticket makes the skill drive them as a swarm.

Assumption: the user's "in [a]sets" is read as "in sets" (process tickets in batches/sets), consistent with `selectNextBatch` in `lib/ticket-queue.js`. This ticket documents/extends the skill only; it does not change `lib/ticket-queue.js` behavior.

## Acceptance Criteria
- [ ] `.claude/skills/orchestrate/SKILL.md` describes running tickets in parallel as a coordinated **swarm**, processing the queue in **sets/batches** rather than one ticket at a time.
- [ ] The skill states the batch size is bounded by `DEFAULT_CONCURRENCY` (default 3) and clamped to `MAX_CONCURRENCY` (hard ceiling 8), matching `lib/ticket-queue.js`.
- [ ] The skill references selecting each batch via `selectNextBatch` (fill only the free slots = limit − active) and topping up free slots as builds finish until the board is clear.
- [ ] The skill states each ticket is atomically **claimed** (`claimTicket`, writing `status: in-progress` + `agent`) before its build, so no two swarm agents work the same ticket, and released (`releaseTicket`) on a terminal state.
- [ ] The skill states each swarm build runs in its own **git isolation** derived from the ticket id (`ticketBranchName` / `ticketWorktreeDir`) so parallel builds never clobber each other's working tree.
- [ ] The skill states that only shared-git steps (e.g. merging a finished build's branch back into the base branch) are serialized, done one at a time.
- [ ] The skill preserves the existing whole-file atomic-write and keep-last-good-parse board rules for concurrent ticket writes.
- [ ] No changes are made to `lib/ticket-queue.js` behavior or to product code; only `.claude/skills/orchestrate/SKILL.md` (and, if needed, related instruction text) is edited.

## Cucumber Tests
```gherkin
Feature: Orchestration runs tickets as a coordinated batched swarm

  Scenario: Skill describes parallel swarm processed in sets
    Given the file ".claude/skills/orchestrate/SKILL.md"
    When I read its build/concurrency instructions
    Then it describes running tickets in parallel as a coordinated swarm
    And it describes processing the queue in sets or batches

  Scenario: Batch size honors the concurrency bounds
    Given the file ".claude/skills/orchestrate/SKILL.md"
    When I read its concurrency instructions
    Then it states the default batch size is 3 (DEFAULT_CONCURRENCY)
    And it states the hard ceiling is 8 (MAX_CONCURRENCY)

  Scenario: Batch selection uses selectNextBatch and tops up free slots
    Given the file ".claude/skills/orchestrate/SKILL.md"
    When I read its build loop
    Then it references selecting a batch via selectNextBatch filling only free slots
    And it tops up free slots as builds finish until the board is clear

  Scenario: Claims prevent collisions in the swarm
    Given the file ".claude/skills/orchestrate/SKILL.md"
    When I read its coordination rules
    Then it states each ticket is atomically claimed via claimTicket before its build
    And it states the claim is released via releaseTicket on a terminal state

  Scenario: Git isolation prevents tree clobbering
    Given the file ".claude/skills/orchestrate/SKILL.md"
    When I read its isolation rules
    Then it states each build runs in its own branch or worktree from ticketBranchName or ticketWorktreeDir

  Scenario: Only shared-git steps are serialized
    Given the file ".claude/skills/orchestrate/SKILL.md"
    When I read its coordination rules
    Then it states only shared-git steps such as merging back to base are serialized one at a time

  Scenario: Board write safety preserved (edge)
    Given the file ".claude/skills/orchestrate/SKILL.md"
    When I read its write rules
    Then it preserves whole-file atomic writes and keep-last-good-parse for concurrent polls

  Scenario: Batch never exceeds the bound (edge)
    Given more claimable tickets than the concurrency limit
    When a batch is selected under the swarm rules
    Then the number dispatched never exceeds the resolved concurrency limit
    And the remaining tickets wait in the queue

  Scenario: No product code changes (edge)
    Given the diff for this ticket
    When I inspect which files changed
    Then "lib/ticket-queue.js" behavior and product code are unchanged
    And only ".claude/skills/orchestrate/SKILL.md" (and related instruction text) is modified
```

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
