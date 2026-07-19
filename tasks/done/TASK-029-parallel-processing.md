---
id: TASK-029
title: parallel processing
status: done
created: 2026-07-18T21:19:43.525Z
updated: 2026-07-18T22:08:42.000Z
---

## Description
Today the orchestrate build swarm only reacts to new work at the **top of each build-loop iteration**: Phase 2 re-scans `tasks/*.md`, then calls `selectNextBatch` (in `lib/ticket-queue.js`) to fill free slots (`limit − activeCount`). There is no explicit, unit-testable decision for the specific case the user describes: **when a single new ticket is created** (dragged/created from the Tasks board, or created as an orchestrate follow-up during a review), decide **right now** whether that one ticket can be started in parallel — i.e. whether a free concurrency slot exists **and** the ticket itself is eligible to be claimed — so the orchestrator can trigger/dispatch it immediately instead of leaving it to sit.

This ticket adds a **pure, Electron-free helper** to `lib/ticket-queue.js` — `canRunInParallel(tickets, newTicket, opts)` — that answers exactly that question for one candidate ticket, and wires the orchestrate skill (`SKILL.md`) to consume it. The helper must be grounded in the **existing** queue semantics: it reuses `resolveConcurrency`, `activeCount`, `isActive`, `isClaimable`, `isClaimed`, and `isClaimedBy` (the same predicates `selectNextBatch` uses) rather than reimplementing slot/claim math, so its verdict composes with the swarm instead of diverging from it. It is a **decision-only** function: it never claims, writes, mutates its inputs, or touches disk/git — the caller still performs `claimTicket` + the whole-file write to actually dispatch, exactly as it does for `selectNextBatch` results.

Concretely, `canRunInParallel` returns `{ ok, reason, freeSlots }` where:
- `freeSlots = max(0, resolveConcurrency(opts.limit) − activeCount(tickets))` — the free slots in the current board snapshot.
- `ok` is `true` only when a free slot exists **and** the new ticket is eligible (in a claimable status, not active, not claimed by a different agent).
- `reason` is a stable string explaining the verdict so the orchestrator can log/skip precisely.

The scope of this ticket is the pure helper, its export, its unit + e2e tests, and the `SKILL.md` wording (Phase 2 build loop + the "Concurrency, claims, and isolation" section) that instructs the orchestrator to call it on ticket creation and dispatch when `ok`. Because `SKILL.md` is edited, the `assets/` mirror must be updated byte-for-byte in the same change (drift guard).

## Acceptance Criteria
- [ ] `canRunInParallel` is exported from `lib/ticket-queue.js` and is a function; it is added to the `module.exports` object alongside the existing helpers.
- [ ] `canRunInParallel(tickets, newTicket, opts)` returns an object of shape `{ ok: boolean, reason: string, freeSlots: number }` and **never** returns `undefined`/throws for any input.
- [ ] `freeSlots` equals `max(0, resolveConcurrency(opts.limit) − activeCount(tickets))`, using the existing `resolveConcurrency` and `activeCount` (so a missing/junk `opts.limit` falls back to `DEFAULT_CONCURRENCY = 3` and any value is clamped to `[1, MAX_CONCURRENCY = 8]`, and a non-array `tickets` counts as 0 active).
- [ ] When a free slot exists **and** the new ticket is in a claimable status (`todo` / `failed-testing`) and is not claimed by a different agent and is not active, the result is `{ ok: true, reason: 'ok', freeSlots: >= 1 }`.
- [ ] When `newTicket` is missing/`null`/not an object or has no usable `status`, the result is `{ ok: false, reason: 'no-ticket', freeSlots }` (freeSlots still computed from the board).
- [ ] When the new ticket is claimed by a **different** agent (`isClaimed(fm) && !isClaimedBy(fm, opts.agentId)`), the result is `{ ok: false, reason: 'claimed', ... }`.
- [ ] When the new ticket is already active (`isActive(status)` — `in-progress`/`testing`) and not a same-agent re-entry, the result is `{ ok: false, reason: 'already-active', ... }`.
- [ ] When the new ticket is not claimed and its status is not claimable (e.g. `done`, `defining`, or an out-of-enum status), the result is `{ ok: false, reason: 'not-claimable', ... }`.
- [ ] When the new ticket is eligible but `freeSlots <= 0` (bound already full), the result is `{ ok: false, reason: 'no-slots', freeSlots: 0 }`.
- [ ] Reason precedence is deterministic and documented: `no-ticket` → `claimed` → `already-active` → `not-claimable` → `no-slots` → `ok` (eligibility of the ticket is decided before capacity, but `freeSlots` is always populated).
- [ ] The helper accepts both bare frontmatter objects and `{ fm }` wrappers for **both** `tickets[]` entries and `newTicket` (mirroring `activeCount`/`selectNextBatch`).
- [ ] `opts.agentId` is honored: a new ticket claimed by that same agent is treated as a safe re-entry (not `claimed`), matching `selectNextBatch`/`claimTicket` re-entry semantics.
- [ ] The helper is pure: it does not mutate `tickets`, `newTicket`, or `opts`, and performs no disk/git/network/Electron access.
- [ ] The verdict is consistent with `selectNextBatch`: if `canRunInParallel(board, newTicket, opts).ok` is `true`, then the same `newTicket` is among the claimable candidates `selectNextBatch` would consider for that board (same predicates, same free-slot math).
- [ ] `.claude/skills/orchestrate/SKILL.md` is updated so the orchestrator, on ticket creation during a build, calls `canRunInParallel` and dispatches (`claimTicket` + build) immediately when `ok`, otherwise leaves the ticket queued — without introducing any new status outside the six-value enum.
- [ ] `assets/skills/orchestrate/SKILL.md` is updated **byte-for-byte identical** to the `.claude/` copy in the same change, keeping `test/orchestrate-agents.test.js`'s drift guard green.
- [ ] The full suite (`node --test`) passes, including the existing `test/ticket-queue.test.js` and the drift-guard tests.

## Cucumber Tests

```gherkin
Feature: Decide whether a newly created ticket can be dispatched in parallel now
  As the orchestrate build swarm
  I want a pure decision for a single new ticket
  So that a ticket created mid-run is started immediately when a slot is free
  and left queued otherwise, reusing the existing bounded-concurrency math.

  Background:
    Given the concurrency limit is 3 (DEFAULT_CONCURRENCY)

  Scenario: A new todo ticket runs in parallel when a slot is free
    Given a board with 1 ticket in-progress and 1 ticket testing
    And a newly created ticket "TASK-100" with status "todo"
    When I call canRunInParallel(board, newTicket, { limit: 3 })
    Then ok is true
    And reason is "ok"
    And freeSlots is 1

  Scenario: A new failed-testing ticket is also eligible
    Given a board with no active tickets
    And a newly created ticket "TASK-101" with status "failed-testing"
    When I call canRunInParallel(board, newTicket, { limit: 3 })
    Then ok is true
    And reason is "ok"

  Scenario: No free slots — the bound is already full
    Given a board with 3 tickets in-progress
    And a newly created ticket "TASK-102" with status "todo"
    When I call canRunInParallel(board, newTicket, { limit: 3 })
    Then ok is false
    And reason is "no-slots"
    And freeSlots is 0

  Scenario: The new ticket is claimed by a different agent
    Given a board with 1 ticket in-progress
    And a newly created ticket "TASK-103" with status "todo" and agent "other-agent"
    When I call canRunInParallel(board, newTicket, { limit: 3, agentId: "me" })
    Then ok is false
    And reason is "claimed"

  Scenario: The new ticket is a safe re-entry for the same agent
    Given a board with 1 ticket testing
    And a newly created ticket "TASK-104" with status "failed-testing" and agent "me"
    When I call canRunInParallel(board, newTicket, { limit: 3, agentId: "me" })
    Then ok is true
    And reason is "ok"

  Scenario: The new ticket is already active
    Given a board with no other active tickets
    And a newly created ticket "TASK-105" with status "in-progress"
    When I call canRunInParallel(board, newTicket, { limit: 3 })
    Then ok is false
    And reason is "already-active"

  Scenario: A non-claimable status is rejected
    Given a board with no active tickets
    And a newly created ticket "TASK-106" with status "done"
    When I call canRunInParallel(board, newTicket, { limit: 3 })
    Then ok is false
    And reason is "not-claimable"

  Scenario Outline: A junk limit falls back through resolveConcurrency
    Given a board with no active tickets
    And a newly created ticket "TASK-107" with status "todo"
    When I call canRunInParallel(board, newTicket, { limit: <limit> })
    Then freeSlots is <slots>
    And ok is <ok>

    Examples:
      | limit      | slots | ok    |
      | "nonsense" | 3     | true  |
      | 0          | 1     | true  |
      | 1000       | 8     | true  |

  Scenario: Failure/edge — a missing or invalid new ticket never crashes
    Given a board with 1 ticket in-progress
    When I call canRunInParallel(board, null, { limit: 3 })
    Then ok is false
    And reason is "no-ticket"
    And freeSlots is 2

  Scenario: Empty board with a valid new ticket
    Given an empty board
    And a newly created ticket "TASK-108" with status "todo"
    When I call canRunInParallel([], newTicket, { limit: 3 })
    Then ok is true
    And freeSlots is 3

  Scenario: The helper does not mutate its inputs
    Given a board and a newly created ticket "TASK-109" with status "todo"
    When I call canRunInParallel(board, newTicket, { limit: 3 })
    Then a deep snapshot of board and newTicket taken before the call is unchanged

  Scenario: The verdict composes with selectNextBatch
    Given a board where "TASK-110" (status todo) is present and one slot is free
    When canRunInParallel(board, TASK-110, { limit: 3 }) returns ok true
    Then TASK-110 appears among the claimable candidates selectNextBatch(board, { limit: 3 }) considers
```

## Relevant Files and Context
- `lib/ticket-queue.js` — the only source file to change. Add `canRunInParallel` here as a pure helper and add it to `module.exports` (currently ends ~271–292). Reuse the existing helpers already in this file:
  - `resolveConcurrency(input)` (~105–113) — clamp `opts.limit` to `[1, MAX_CONCURRENCY]`, default `DEFAULT_CONCURRENCY`.
  - `activeCount(tickets)` (~145–153) — counts `in-progress`/`testing`; already handles `{ fm }` wrappers, bare fm, and non-array input.
  - `isActive` (~54–56), `isClaimable` (~97–99), `isClaimed` (~138–140), `isClaimedBy` (~132–135) — the exact predicates `selectNextBatch` uses (its filter ~225–231). Match those semantics precisely so verdicts agree.
  - Constants: `DEFAULT_CONCURRENCY = 3`, `MAX_CONCURRENCY = 8` (~49–50), `ACTIVE_STATUSES` (39), `CLAIMABLE_STATUSES` (43).
  - Follow the fm-unwrap idiom used throughout: `const fm = t && t.fm ? t.fm : t;`. Support the same for `newTicket`.
  - Follow the `{ ok, ..., reason }` return shape and reason-string style established by `claimTicket` (~167–193). Introduce the new reasons `'no-ticket'`, `'already-active'`, `'no-slots'`, `'ok'` consistently.
  - Purity is a hard rule for this module (file header ~15–21, and the `claimTicket does not mutate its input` test). Do not mutate inputs.
- `test/ticket-queue.test.js` — existing unit-test home. Add unit tests for `canRunInParallel` following local patterns: the `T(id, status, extra)` factory (~370–372), the exports-surface test (~84–98), and the `selectNextBatch` section (~367–478). Extend the "exports the documented surface" test to assert `canRunInParallel` is a function.
- E2e (cucumber-style) tests: repo convention is a sibling `*.e2e.test.js` (see `test/ticket-history.e2e.test.js`, `test/ticket-progress.e2e.test.js`). Implement the Gherkin scenarios above as Given/When/Then `node --test` cases (no `cucumber` npm package — none installed, none to be added), e.g. in `test/ticket-queue.e2e.test.js`. Per orchestrate Phase 3, **both** unit and e2e tests are required.
- `.claude/skills/orchestrate/SKILL.md` — update the Phase 2 build loop (step 1, ~181–186, "the user may drag new tickets into `todo` or create them from the board while you work") and the "Concurrency, claims, and isolation" section (~309–343) to state that on ticket creation the orchestrator calls `canRunInParallel(tickets, newTicket, { limit, agentId })` and, when `ok`, immediately claims (`claimTicket`) + dispatches that ticket into the free slot; when not `ok`, leaves it queued. Do not add any status outside the six-value enum. Keep the existing agent-dispatch and fallback wording intact (drift-guard test asserts the three `orchestrate-*` agent names + general-purpose fallback are still present).
- `assets/skills/orchestrate/SKILL.md` — **ASSETS DRIFT GUARD**: canonical bundled mirror; must be **byte-for-byte identical** to the `.claude/` copy. After editing `.claude/`, copy it verbatim here in the same change. `test/orchestrate-agents.test.js` turns red on any drift.
- `renderer/renderer.js` — context only (browser script, **not** requireable, do not import). Creates/edits tickets via `serializeTicket` + `window.api.fs.writeFile` (`doWrite`, ~5840–5865); moves them between lanes (`moveTicketToStatus`, ~6157–6186). It maintains an **inlined** mirror of `resolveConcurrency` as `resolveTasksConcurrency` (~5930–5939) with `TASKS_DEFAULT_CONCURRENCY = 3` / `TASKS_MAX_CONCURRENCY = 8`, and `TASKS_ACTIVE_STATUSES = ['defining', 'in-progress', 'testing']` (~5112). Note: the renderer's active set additionally includes `'defining'`, whereas `lib/ticket-queue.js`'s `ACTIVE_STATUSES` is `['in-progress', 'testing']` — `canRunInParallel` must use the library's `isActive`/`activeCount` (the queue/claim contract), not the renderer's board-rendering set. This ticket does **not** require renderer changes; the consumer is the orchestrator following `SKILL.md`.

## Edge and Failure Cases
- **No free slots:** `activeCount(tickets) >= limit` → `{ ok: false, reason: 'no-slots', freeSlots: 0 }`, even when the new ticket is eligible.
- **Invalid / missing limit:** `opts.limit` of `null`/`undefined`/`''`/`'abc'`/`NaN`/`{}` → `DEFAULT_CONCURRENCY` (3); `0`/negatives → 1; `> 8` → `MAX_CONCURRENCY` (8); fractionals floored (`2.9 → 2`); `Infinity` → default. Delegate to `resolveConcurrency`; do not re-derive.
- **Missing / invalid `newTicket`:** `null`, `undefined`, non-object, `{ fm: null }`, or a ticket with no `status` → `{ ok: false, reason: 'no-ticket' }` (never throw); `freeSlots` still computed.
- **Already claimed by another agent:** `isClaimed(fm) && !isClaimedBy(fm, opts.agentId)` → `'claimed'`.
- **Already active:** status `in-progress`/`testing` and not a same-agent re-entry → `'already-active'`.
- **Non-claimable status:** unclaimed ticket in `done`/`defining` or any out-of-enum status → `'not-claimable'`.
- **Same-agent re-entry:** `opts.agentId` owns the new ticket → not `'claimed'`; eligible if claimable, mirroring `selectNextBatch`/`claimTicket`.
- **Empty / non-array board:** `tickets = []`, `null`, `undefined`, or garbage → `activeCount` yields 0 → `freeSlots = limit`; a valid eligible new ticket returns `ok: true`.
- **Duplicate ids:** the helper does **not** dedupe by id; document that the caller passes a fresh, non-double-counted snapshot.
- **Purity:** callers may reuse the same board array/ticket object across many calls; must not mutate them or `opts`.
- **Reason precedence:** ticket eligibility resolved before capacity; a full board with an ineligible new ticket reports the ineligibility reason, not `no-slots`; `freeSlots` always populated.
- **Drift-guard failure:** editing `.claude/...SKILL.md` without syncing `assets/...SKILL.md` byte-for-byte fails `test/orchestrate-agents.test.js` — treat the two edits as one atomic change.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
