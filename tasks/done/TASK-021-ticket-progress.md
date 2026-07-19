---
id: TASK-021
title: ticket progress
status: done
created: 2026-07-18T11:35:13.570Z
updated: 2026-07-18T23:20:00.000Z
---

## Description

While the orchestrate swarm builds multiple tickets in parallel (bounded concurrency, default 3 — `lib/ticket-queue.js` `DEFAULT_CONCURRENCY`), the Tasks board **already** reflects each ticket's status correctly: every card derives its lane and its blue "being worked on" dot independently from that ticket's own persisted `status` frontmatter (`renderer/renderer.js:5601-5604`, `:5672-5680`), the board re-polls every 2.5s (`:5458-5527`), and the orchestrator is contractually required to write each ticket's status to disk on every transition as a whole-file write (`.claude/skills/orchestrate/SKILL.md`). So multiple concurrently-active tickets already appear, each in its correct lane, each pulsing, live.

The genuine gap is **visibility of the parallelism itself**. Two pieces of information the swarm persists or knows are never surfaced on the board:

1. The claiming `agent` id is written into each in-flight ticket's frontmatter by `claimTicket` (`lib/ticket-queue.js:186-187`) but is **never rendered** on the card — the user cannot see which agent owns which ticket.
2. There is no live count of how many tickets are actively being worked right now; the board status line only shows the total ticket count.

This ticket surfaces both, without changing the status/claim pipeline: (a) show the claiming `agent` id on each actively-worked card, and (b) show a live "N running" concurrent-count indicator in the board status line. Both are derived purely from persisted frontmatter and update on the normal poll cycle, matching the existing dot/accounting rendering conventions (TASK-003/005/006/007).

## Acceptance Criteria

- [ ] When a ticket's frontmatter carries a non-empty `agent` field, its card renders the agent id as a small, unobtrusive label (styled like `.task-card-meta`, distinct from the accounting line), so the user can see which agent owns the ticket.
- [ ] When a ticket has no `agent` field (or it is empty/whitespace), no agent label is rendered on that card (nothing fabricated).
- [ ] The agent label appears/updates/clears within one poll cycle (≤ ~2.5s) as the ticket file changes on disk, with no board flicker for tickets being mid-rewritten (respects the existing keep-last-good-parse path).
- [ ] The board status line shows a live count of currently actively-worked tickets (those whose status is in `TASKS_ACTIVE_STATUSES`), e.g. `"7 tickets · 3 running · polling"`, using correct singular/plural and the existing `· polling` suffix behavior.
- [ ] When zero tickets are actively worked, the "N running" fragment is omitted (not `"0 running"`), leaving the existing status text unchanged.
- [ ] Multiple concurrently-active tickets each simultaneously show their own agent label and their existing blue dot; the running count equals the number of active cards across all active lanes.
- [ ] The agent label and running count are derived **only** from persisted frontmatter (no new IPC, no new persisted state) and require no change to the claim/status pipeline in `lib/ticket-queue.js` or the orchestrator contract.
- [ ] The dot precedence and existing indicators (waiting yellow, failed red, active blue, accounting line) are unchanged and still render exactly as before.
- [ ] Cards with an out-of-enum/unknown status still render safely; an `agent` value on such a card is handled without error (label shown if the value is non-empty, otherwise omitted).

## Cucumber Tests

```gherkin
Feature: Surface parallel-task ownership and concurrency on the Tasks board

  Background:
    Given the Tasks board is open and polling
    And the orchestrate swarm builds tickets in parallel

  Scenario: An in-progress ticket shows its claiming agent
    Given a ticket "TASK-100" has status "in-progress" and agent "build-a1" in its frontmatter
    When the board polls and renders
    Then the "TASK-100" card shows an agent label reading "build-a1"
    And the "TASK-100" card still shows the blue "being worked on" dot

  Scenario: A ticket with no claim shows no agent label
    Given a ticket "TASK-101" has status "todo" and no agent field
    When the board polls and renders
    Then the "TASK-101" card shows no agent label

  Scenario: The agent label clears when the claim is released
    Given a ticket "TASK-102" has status "in-progress" and agent "build-a1"
    And its card shows an agent label "build-a1"
    When the ticket transitions to status "done" and its agent field is removed on disk
    And the board polls again
    Then the "TASK-102" card shows no agent label

  Scenario: Live concurrent-count reflects parallel builds
    Given three tickets have status "in-progress" and one has status "testing"
    And the remaining tickets are "todo" or "done"
    When the board renders
    Then the status line includes "4 running"

  Scenario: Concurrent count updates as slots free
    Given the status line shows "3 running"
    When one in-progress ticket transitions to "done" on disk
    And the board polls again
    Then the status line shows "2 running"

  Scenario Outline: Running fragment pluralization and omission
    Given <n> tickets are in an actively-worked status
    When the board renders
    Then the status line running fragment is "<fragment>"

    Examples:
      | n | fragment  |
      | 0 |           |
      | 1 | 1 running |
      | 5 | 5 running |

  Scenario: Failure/edge - agent value present on an unknown-status ticket
    Given a ticket "TASK-103" has an out-of-enum status "reviewing" and agent "build-z9"
    When the board renders
    Then the "TASK-103" card renders in the unknown lane without error
    And it shows the agent label "build-z9"

  Scenario: Failure/edge - malformed frontmatter mid-write does not flicker
    Given a ticket "TASK-104" is actively worked with agent "build-a1"
    When a poll reads the file mid-rewrite and cannot parse its frontmatter
    Then the board keeps the last good render for "TASK-104"
    And the agent label and running count do not flicker to empty for that tick

  Scenario: Failure/edge - whitespace-only agent field is treated as no claim
    Given a ticket "TASK-105" has status "in-progress" and agent "   "
    When the board renders
    Then the "TASK-105" card shows no agent label
```

## Edge and Failure Cases

- `agent` field absent, empty string, or whitespace-only → no label (mirror the `ticketFieldNonEmpty` guard already used at `renderer/renderer.js:5169-5171`).
- `agent` value present on an unknown/out-of-enum status card → render without error; still show the label if non-empty.
- Mid-rewrite/unparseable ticket file during a poll → keep-last-good-parse must still hold; agent label and running count must not flicker to empty for that tick (the `prevByPath` fallback at `:5497-5500` already covers this — do not regress it).
- Running count must count **active cards** (status in `TASKS_ACTIVE_STATUSES`), not claimed cards, so the number matches the visible blue dots; a card with an `agent` field but a non-active status (e.g. a stale/dangling claim) must not inflate the count.
- Zero active tickets → omit the "N running" fragment entirely (no "0 running").
- Long/unusual agent ids → label must not break card layout (truncate/ellipsis via CSS, consistent with `.task-card-title`/`.task-card-meta`).
- Do not alter dot precedence (waiting > failed > active) or the accounting line rendering.
- No new IPC, no new persisted frontmatter keys, no change to `lib/ticket-queue.js` claim logic or the orchestrator contract.

## Relevant Files and Context

- `renderer/renderer.js`
  - `renderTasksBoard` `:5576-5710` — card construction; add the agent label near the accounting line block (`:5681-5690`) and compute the running count before setting the status line (`:5703-5707`).
  - `TASKS_ACTIVE_STATUSES` `:5112` — the active set to count and to gate the label's "actively worked" semantics.
  - `ticketFieldNonEmpty` `:5169-5171` — reuse for the non-empty `agent` guard.
  - `ticketAccountingParts` `:5379` and its render block `:5684-5690` — the styling/placement pattern to mirror for the new agent label (own element, own class, rendered only when data present).
  - Status line update `:5707` and the `polling` suffix logic `:5706` — extend to include the running fragment.
  - `pollTasksOnce` `:5458-5527` — the poll/keep-last-good path; no change needed but must not be regressed.
- `renderer/index.html:611` — `<span class="tasksStatus tasks-status">` status line element (target of the running-count text).
- `renderer/styles.css:2620-2679` — `.task-card-meta` and `.task-card-dot` block; add a small `.task-card-agent` rule here following `.task-card-meta` (monospace, muted, truncating).
- `lib/ticket-queue.js` — `claimTicket` `:167-193` (confirms `agent` is the persisted claim field; read-only reference), `isClaimed`/`isClaimedBy`/`isActive`/`activeCount` existing pure helpers. Note the intentional divergence: renderer's `TASKS_ACTIVE_STATUSES` includes `defining`, while lib `ACTIVE_STATUSES` is `['in-progress','testing']` — the board's "running" count should use the board's own active set for consistency with the dot.
- Browser-mirror-of-lib-helper convention: the renderer duplicates tiny pure predicates because it cannot `require` Node modules (`renderer/renderer.js:5103-5104`, `:5163-5175`, `:5205-5209`; `lib/ticket-queue.js:36-38`). Keep any new browser-side predicate small, pure, and in lockstep with its lib counterpart.

**Lib helper note:** A new `lib/ticket-*.js` module is not required — the counting logic already exists as the pure, unit-tested `activeCount` in `lib/ticket-queue.js`, and reading `agent` is a one-line non-empty guard. Only if non-trivial agent-id display normalization (truncation rules, id→friendly-label mapping) is introduced should that formatting be a pure, Electron-free function alongside `lib/ticket-*.js`, unit-tested with `node --test`, with its renderer mirror kept in lockstep.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
