---
name: orchestrate
description: >-
  Ticket-driven build workflow. Use when the user asks to plan a feature into
  tickets ("/orchestrate plan <feature>", or asks to break work into tasks), to
  build queued tickets ("/orchestrate build"), or to see board status
  ("/orchestrate status"). Manages ticket files in the project's tasks/ folder
  and drives plan -> build -> test -> review -> done via subagents. The user watches
  progress live on the Tasks kanban board.
---

# Orchestrate: ticket-driven development

You coordinate four roles — **business analyst**, **coder**, **tester**, and a
**tech lead / reviewer** — over ticket files stored in the project's `tasks/`
folder. The user watches
progress on a kanban board (the "Tasks" tab) that re-reads these files every few
seconds. Because of that live board, two rules are absolute:

1. **Every status change is written to disk immediately.**
2. **Every ticket file is rewritten in full with a single write — never partial
   appends or in-place edits of one field.** A half-written file can be read
   mid-poll; a whole-file write is atomic enough that the board's
   keep-last-good-parse logic absorbs it.

## Ticket file contract

Tickets live at `tasks/TASK-<nnn>-<slug>.md`. Each file is markdown with flat
frontmatter (simple `key: value` lines — no nested YAML). The structure is:

~~~markdown
---
id: TASK-001
title: Add login form validation
status: todo
created: 2026-07-18T10:00:00Z
updated: 2026-07-18T10:00:00Z
---

## Description
What needs doing and why.

## Acceptance Criteria
- [ ] First testable criterion
- [ ] Second testable criterion

## Cucumber Tests
```gherkin
Feature: Login validation
  Scenario: Empty email is rejected
    Given the login form is open
    When the user submits with an empty email
    Then an "email required" error is shown
```

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
~~~

Rules for the frontmatter:

- `id` is authoritative (the filename slug is cosmetic). Scan `tasks/*.md`
  non-recursively; ignore subfolders.
- `status` is one of the valid enum values: `todo`, `defining`, `in-progress`,
  `testing`, `post-processing`, `done`, plus `failed-testing`. Statuses live
  **only** in frontmatter — never track them anywhere else. The board renders
  **six lanes** in this exact left-to-right order, matching how work moves:
  `todo → defining → in-progress → testing → post-processing → done`.
  - `todo` — where new tickets are first created, awaiting work.
  - `defining` — the **business-analyst** agent is defining the task (writing
    acceptance criteria and Gherkin) before any coding.
  - `in-progress` — the **coder** agent is implementing the ticket.
  - `testing` — the **tester** agent is creating/checking tests.
  - `post-processing` — holds **post-processing tickets** (see below), the "final
    events" run against every normal task after its tests pass but before it is
    marked `done`. These tickets are **never built/tested/claimed by the swarm**.
  - `done` — complete.
  - `failed-testing` — the ticket's tests failed; its board marker turns **red**
    and the fix loop runs before returning it to `testing`. It **remains the
    fix-loop failure status** and stays claimable, but it **no longer has a
    dedicated lane**: its cards fold into the **Testing** lane (keeping the red
    marker). It still owns its `tasks/failed-testing/` folder.
- **Post-processing tickets** are a distinct **kind** of ticket, identified by a
  `kind: post-processing` frontmatter key (an extra key the serializer keeps after
  the leading keys, round-tripped untouched by the board). They live in the
  `post-processing` lane/status and describe final events the user wants applied to
  every normal task after review passes and before `done`. They are **excluded
  from the build swarm entirely** — never planned, built, tested, or claimed like a
  normal ticket (`isPostProcessingTicket` in `lib/ticket-lanes.js` marks them
  un-claimable even if their status were tampered to `todo`/`failed-testing`).
- `created` and `updated` are ISO-8601 timestamps. Bump `updated` on **every**
  write. Preserve `created`.
- `agent` (optional) is the **claim** field: the id of the single agent currently
  building this ticket. It is set atomically when a ticket is claimed and cleared
  when the build reaches a terminal state. It is an extra frontmatter key, kept
  after the leading keys by the serializer, and round-trips untouched by the
  board. See "Concurrency, claims, and isolation" below. (`lib/ticket-queue.js`
  owns the claim/queue/isolation logic as pure, requireable helpers.)
- The `## Additional Context` section belongs to the user. Read it; never edit or
  delete it. Everything else in the body you may edit while that ticket is in
  your phase.
- If a ticket file fails to parse (missing frontmatter, no closing `---`), skip
  it and tell the user rather than guessing.

## Routing — which phase am I in?

- `/orchestrate plan <feature description>` — or any feature request when no
  `todo` tickets exist yet → **Plan phase**.
- `/orchestrate build` → **Build/Test loop** over every ticket in `todo` or
  `failed-testing`.
- `/orchestrate status` → summarize the board (count per lane, list ticket
  ids/titles/statuses) and stop.

## Agent dispatch and fallback

Each phase dispatches to its own dedicated subagent type (defined in the
project's `.claude/agents/`), not the generic `general-purpose` agent:

- **Phase 1 (Plan / Define)** → `orchestrate-ba` — read/search only; never writes
  implementation code. Dispatch this planning subagent on `claude-fable-5` when
  available, otherwise fall back to `claude-opus-4-8`. (This model directive
  applies to Phase 1 planning only.)
- **Phase 2 (Build)** → `orchestrate-coder` — edit/write/bash.
- **Phase 3 (Test)** → `orchestrate-tester` — scoped to writing/running tests.
- **Phase 4 (Review)** → `orchestrate-tech-lead` — read/search only; reviews a
  ticket after testing passes and before it is marked `done`.

If a named agent definition is missing at dispatch time, **fall back to
`general-purpose` and continue** rather than aborting — and report which agent
was missing (the orchestrate install step, `tasks:installSkill`, copies these
definitions into `.claude/agents/`, so a missing one usually means the skill
needs reinstalling).

## Phase 1 — Plan / Define (business analyst)

Do **not** write any implementation code in this phase. This is the **defining**
phase: the business-analyst agent turns a feature request into well-defined
tickets (acceptance criteria + Gherkin). A ticket actively being defined shows in
the board's `defining` lane; new tickets are first **created** in `todo`, and a
defined ticket lands back in `todo` for the user to review before building.

The BA must do a **thorough** analysis and capture **all** the information a
coder needs **inside the ticket** before the ticket leaves this phase. The full
analysis must be captured in the ticket **before any build (Phase 2) starts** and
before the tester tests it (Phase 3): the BA reads/searches **all** the relevant
files up front, in the defining phase, so the coder can build and the tester can
test without rediscovering the context. The BA only reads and searches — it never
writes implementation code or edits/creates source files.

1. Create the `tasks/` folder if it does not exist. Read the existing tickets to
   find the highest `TASK-<nnn>` so new ids continue the sequence.
2. Launch **one** subagent (Task tool, `orchestrate-ba`; fall back to
   `general-purpose` and report it if that definition is missing) with a
   business-analyst persona, dispatched on `claude-fable-5` when available,
   otherwise `claude-opus-4-8`. Its job: thoroughly analyze the relevant codebase
   (reading/searching **all** relevant files) and break the feature request into
   small, independently testable tickets. Each ticket must capture, in its body,
   **all** the information a coder needs to build it before any build begins. For
   **each** ticket it must write a file `tasks/TASK-<nnn>-<slug>.md` with:
   - `status: todo` (a freshly created ticket; use `defining` only while the BA
     is still actively analyzing and writing its acceptance criteria and
     Gherkin), correct `id`, a clear `title`, and `created`/`updated` timestamps.
   - A **precise** `## Description` explaining what and why.
   - A **complete** `## Acceptance Criteria` as a checkbox list — each criterion
     concrete and testable, covering the full scope of the work.
   - `## Cucumber Tests` — Gherkin scenarios covering **every** acceptance
     criterion, including **at least one failure/edge scenario per ticket**.
   - **Explicitly listed edge and failure cases** the coder must handle.
   - The **relevant files and context** the coder will need (paths, modules,
     patterns to follow), captured in the ticket body.
   - An empty `## Additional Context` section (a heading with a placeholder line
     for the user to fill in). This section is user-owned — the BA leaves it empty
     and **never overwrites** it.
3. When the subagent returns, list the tickets it created (id + title), then
   **STOP** with this message:

   > Tickets created. Review and enrich them in the **Tasks** tab — especially
   > the **Additional Context** of each ticket — then run `/orchestrate build`.

   Do not proceed to implementation. The user must review first.

## Phase 2 — Build (coder)

Process tickets in `todo` (and any picked up from `failed-testing`, see Phase 3),
oldest `id` first. Run the build as a coordinated **swarm**: instead of taking one
ticket at a time, work the queue in **sets** (batches) of tickets that build **in
parallel**, up to a bounded limit. The swarm needs no external coordinator — it
self-coordinates through the guarantees in "Concurrency, claims, and isolation"
below: atomic per-ticket **claims** stop two swarm agents from grabbing the same
ticket, per-ticket **git isolation** stops parallel builds clobbering each other's
tree, and only shared-git steps are serialized. Concurrency is safe **only** under
those rules; follow them exactly.

**Run until the board is clear.** `/orchestrate build` does not stop after one
ticket, or after one batch — it keeps topping up and driving batches until nothing
is left to drive:

1. Re-scan `tasks/*.md` (do this fresh at the top of every iteration — the user
   may drag new tickets into `todo` or create them from the board while you
   work). Note the current claims (`agent` fields) and how many tickets are
   already actively worked (`in-progress` / `testing`). When a ticket is created
   **mid-build** (a Phase 4 follow-up fix ticket, or one the user adds), do not
   wait for the next full iteration to consider it: call `canRunInParallel(board,
   newTicket, { limit, agentId })` in `lib/ticket-queue.js`. If it returns
   `ok: true` (a free slot exists **and** the new ticket is claimable, unclaimed
   or claimed by you, and not active), claim it (`claimTicket`) and start its
   build immediately in that free slot; otherwise (`ok: false` — no free slot, or
   the ticket is not eligible) **leave it queued** in `todo` for a later top-up.
   This introduces **no new status**: the created ticket stays `todo` until it is
   claimed like any other, and `canRunInParallel`'s verdict composes with
   `selectNextBatch` (an `ok: true` ticket is exactly one `selectNextBatch` would
   pick for that board).
2. **Select the next batch** with `selectNextBatch` in `lib/ticket-queue.js`. It
   fills only the **free slots** = `limit − active count`, where the batch size /
   limit is `DEFAULT_CONCURRENCY` (default **3**) and any caller-supplied override
   is clamped to `MAX_CONCURRENCY` (hard ceiling **8**). It returns the oldest
   **unclaimed** claimable tickets — from `todo` first, then `failed-testing`
   tickets that still have fix attempts left (see Phase 3's 3-attempt cap) — that
   fit the free slots. Any tickets beyond the free slots **wait in the queue** —
   never exceed the bound.
3. **Claim** each ticket in the batch atomically before starting its build (see
   below), then build the claimed batch **in parallel** and take each ticket
   through Phase 3 (test/fix) to a terminal state (`done`, or `failed-testing`
   after the cap). Whenever a build finishes and frees a slot, return to step 1 to
   **top up** the free slots with the next `selectNextBatch` set — keep the swarm
   full until the board is clear.
4. When there are no free-slot candidates left and no builds are still running,
   **stop** — report the final board: how many reached `done`, and list anything
   left in `failed-testing` with a one-line reason so the user can intervene.

Do not ask for confirmation between tickets or batches — the goal is to empty
`todo` and land every ticket in `done` in a single swarm run, as fast as the bound
allows.

For each ticket you build:

1. **Claim it** (`claimTicket`): re-read the ticket fresh, and only if it is still
   claimable (status `todo`/`failed-testing`) and **not already claimed by another
   agent**, set `status: in-progress` **and** `agent: <this build's id>` and write
   the file (bump `updated`) **before** doing any code work. This whole-file write
   is the atomic claim — if two swarm agents race for the same ticket, whoever
   writes first wins; the other re-reads, sees the ticket now claimed, and skips
   it. Never build a ticket already claimed by another agent.
2. **Isolate it**: give the build its own git working state so parallel builds
   cannot clobber each other's tree — a per-ticket branch/worktree derived from
   the ticket id (`ticketBranchName` / `ticketWorktreeDir` in
   `lib/ticket-queue.js`, e.g. `orchestrate/task-004`). Do all of that build's
   code work inside its own isolation.
3. Launch a coder subagent (Task tool, `orchestrate-coder`; fall back to
   `general-purpose` and report it if that definition is missing) with the
   **full ticket text**. Instruct it to:
   - Implement to the acceptance criteria.
   - Honor the `## Additional Context` section.
   - Follow existing codebase conventions.
   - Work only within this ticket's isolated worktree/branch.
   - Not write tests beyond what compilation/wiring needs (the tester owns
     tests).
4. When it returns, set `status: testing` and write **that ticket's** file only.

## Phase 3 — Test (tester) and the fix loop

For each ticket in `testing`, the tester must produce **BOTH** kinds of tests —
**e2e cucumber-style tests AND unit tests** — for every built ticket. Both are
mandatory deliverables: a ticket may only reach `done` when **both** kinds exist,
both implement the ticket's acceptance criteria / Gherkin, and **both were run
green**. If either kind is missing, the ticket has not passed — treat it as a
failure and return it to `failed-testing`.

"E2e cucumber tests" here do **not** require the `cucumber` npm package (none is
installed, and none is to be added). They are scenario-style `node --test` cases
written in **Given/When/Then** form that implement the ticket's Gherkin
scenarios. The project test runner is `node --test`.

1. Launch a tester subagent (Task tool, `orchestrate-tester`; fall back to
   `general-purpose` and report it if that definition is missing). It must:
   - Write/extend **e2e cucumber tests** — scenario-style `node --test` cases in
     Given/When/Then form — implementing the ticket's Gherkin scenarios. These
     scenarios must cover **every** acceptance criterion / Gherkin scenario in
     the ticket, including at least one failure/edge path. **Mock ALL database
     calls — no real DB connections.**
   - Write **unit tests** covering the new functionality.
   - Run the full test suite under `node --test` and report pass/fail with
     failure output, naming which files hold the e2e tests and which hold the
     unit tests.
2. Decide from the result:
   - **All green** → only when **both** the e2e and unit tests have actually run
     under `node --test` and passed. Do **not** mark the ticket `done` yet: first
     run the **tech-lead review** (Phase 4 below) and then the **post-processing**
     step — the ordering is `testing → tech-lead review → post-processing → done`.
     Only once the review has completed and every defined post-processing ticket's
     instructions have been run do you set `status: done`, write the file, and move
     to the next ticket. If either kind of test is missing or was not run green, it
     is **not** "all green": treat it as a failure (next bullet).
   - **Any failure** (including a missing e2e or unit test kind) → set
     `status: failed-testing`, write the file, then immediately launch a coder
     subagent with the ticket **plus the failure output** to fix the code. When
     it returns, set `status: testing` and go back to step 1.
3. Cap the fix loop at **3 attempts** per ticket. If it is still red after the
   third attempt, leave it in `failed-testing`, summarize what is failing, and
   ask the user how to proceed.

## Phase 4 — Tech-lead review (reviewer), post-processing, then done

A ticket that has **passed testing** is **not** marked `done` immediately. First
it goes through a **tech-lead review**, then a **post-processing** step, so the
ordering is `testing → tech-lead review → post-processing → done`. The review is a
**flow step, not a new board status** — it introduces no new value into the enum.
The post-processing step runs the instructions of every defined **post-processing
ticket** (the tickets in the `post-processing` lane, `kind: post-processing`)
against the reviewed task before it is marked `done`; those tickets are the
user's "final events" and are themselves never built/tested/claimed.

1. Launch a reviewer subagent (Task tool, `orchestrate-tech-lead`; fall back to
   `general-purpose` and report it if that definition is missing) with the **full
   ticket text**. It must do a **thorough** review of **both** the ticket **and**
   the implementation code, and specifically:
   - Verify the implementation actually satisfies the acceptance criteria and
     follows codebase conventions.
   - Verify the **tests actually cover the implemented code** — that the e2e and
     unit tests exercise the real code paths and edge/failure cases, not merely
     that tests exist and are green.
   - Verify **security concerns are addressed** (input validation, injection,
     path traversal, secrets, unsafe IPC/shell usage, missing authorization,
     unsafe handling of untrusted data).
   The reviewer is **read/search only**: it reports findings but **never edits the
   reviewed ticket's status/frontmatter** or any source file.
2. **When the review finds issues, create a new follow-up fix ticket per issue**
   with `status: todo`. You (the orchestrator) create these — the reviewer only
   reports them. Each new id **continues the `TASK-nnn` sequence from the true
   maximum** id found across all status subfolders (`tasks/*/TASK-*.md`), never
   reusing an existing id and never skipping ahead of the real maximum: if the
   current max is `TASK-019` and the review found two issues, the follow-ups are
   `TASK-020` and `TASK-021`. Creating these follow-ups **does not change the
   reviewed ticket's status or frontmatter**; the follow-up `todo` tickets are
   picked up by a later build swarm like any other ticket.
3. **Run post-processing, then mark the reviewed ticket `done`.** After the
   review passes, run each defined post-processing ticket's instructions (every
   ticket in the `post-processing` lane, `kind: post-processing`) against the
   reviewed task — these are the user's "final events" applied to every normal
   task. Post-processing tickets are **never built/tested/claimed** and are **not**
   themselves marked `done` by this flow; you only run their instructions. Then set
   `status: done` on the reviewed ticket. Its own acceptance criteria and tests
   passed, so it reaches `done` regardless of what the review turned up — the
   review never re-opens it. This `done` transition is the ticket's normal terminal
   state, written by you (the orchestrator); neither the review nor the
   post-processing step changes the reviewed ticket's status/frontmatter beyond
   letting it proceed to `done`.

## Concurrency, claims, and isolation

The swarm builds tickets in parallel, in batches, but self-coordinates **only**
under these guarantees (this section replaces the old "exactly one ticket in
flight" rule). The pure helpers in `lib/ticket-queue.js` implement the decisions
below and are unit-tested.

- **Bounded concurrency (batch size).** At most **N** agents build at once, so
  each set/batch is at most N tickets (default N = 3, `DEFAULT_CONCURRENCY`;
  clamped to a hard ceiling of 8, `MAX_CONCURRENCY`). `selectNextBatch` fills only
  the free slots (`limit − active count`), so it never starts a build when N
  tickets are already `in-progress`/`testing`. Tickets past the bound wait in the
  queue and are picked up as slots free.
- **Dispatch a newly-created ticket into a free slot.** When a single ticket is
  created during a build, decide whether it can run **right now** with
  `canRunInParallel(tickets, newTicket, { limit, agentId })`. It reuses the same
  eligibility and slot math as `selectNextBatch` (`freeSlots = limit − active
  count`) and returns `{ ok, reason, freeSlots }` — decision-only, it never claims
  or writes. On `ok: true`, claim (`claimTicket`) and build the ticket immediately
  in the free slot; on `ok: false` (`no-ticket` / `post-processing` / `claimed` /
  `already-active` / `not-claimable` / `no-slots`) leave it queued in `todo`. It
  never invents a status and never dispatches a `kind: post-processing` ticket.
- **At most one agent per ticket.** A ticket is claimed (`claimTicket`) by writing
  your build's id into its `agent` frontmatter field together with
  `status: in-progress`, in a single whole-file write, and only when the freshly
  re-read ticket is claimable and unclaimed. That write is the atomic claim; the
  first writer wins. No two swarm agents may work the same ticket.
- **Each build writes only its own ticket file.** A build never writes another
  ticket's file or any shared board state. Because status + claim live in each
  ticket's own frontmatter, concurrent builds never cross-write.
- **Whole-file, atomic writes preserved.** Every ticket write is a single
  full-file rewrite (never a partial append/in-place field edit), so a concurrent
  board poll never reads a half-written file — the board's keep-last-good-parse
  absorbs any mid-write read. This rule holds unchanged for concurrent swarm
  writes.
- **Per-ticket git isolation.** Each build runs on its own branch/worktree
  derived from the ticket id (`ticketBranchName` / `ticketWorktreeDir`), so
  parallel builds never clobber each other's working tree. Serialize **only** at
  the points that touch shared git state — e.g. merging a finished build's branch
  back into the base branch — doing those **one at a time**.
- **Release on terminal state.** When a build reaches `done` (or is left in
  `failed-testing` after the cap), clear its `agent` claim (`releaseTicket`) so
  the slot frees for the next batch and, for `failed-testing`, the ticket can be
  re-picked later.

## State-consistency rules (all phases)

- Only **you** (the orchestrator) edit ticket status/frontmatter. Subagents
  receive ticket content in their prompt and report results back — they do not
  touch status or claims.
- Claim before you build: write the `status: in-progress` + `agent` transition
  before starting the work it names, and never touch a ticket claimed by another
  agent.
- Never invent a status outside the valid enum (`todo`, `defining`,
  `in-progress`, `testing`, `post-processing`, `done`, and `failed-testing` — the
  latter is a valid, claimable status that folds into the Testing lane rather than
  having its own).
- Timestamps: preserve `created`, always bump `updated`.
