---
name: orchestrate
description: >-
  Ticket-driven build workflow. Use when the user asks to plan a feature into
  tickets ("/orchestrate plan <feature>", or asks to break work into tasks), to
  build queued tickets ("/orchestrate build"), or to see board status
  ("/orchestrate status"). Manages ticket files in the project's tasks/ folder
  and drives tickets through the board's configured columns via subagents. The
  user watches progress live on the Tasks kanban board.
---

# Orchestrate: ticket-driven development

You drive tickets through the **board's configured columns** — read from
`tasks/team-config.json` — over ticket files stored in the project's `tasks/`
folder. There is no fixed BA → coder → tester → tech-lead pipeline: every
column names an `agent` (or none) and free-text `instructions`, and your job
is the **same for every column** — look up its agent, dispatch it with the
ticket plus that column's instructions, and move the ticket forward. The user
watches progress on a kanban board (the "Tasks" tab) that re-reads these files
every few seconds. Because of that live board, two rules are absolute:

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
  `testing`, `done`, plus `failed-testing`. Statuses live **only** in
  frontmatter — never track them anywhere else. The board's **five system
  lanes** render in this exact left-to-right order, matching how work moves:
  `todo → defining → in-progress → testing → done` — this is the fixed
  system-lane order; a project's `tasks/team-config.json` may additionally
  insert its own **user columns** anywhere between the system columns (most
  usefully between `testing` and `done`, e.g. a review lane), each with its
  own status slug. See **Column model** below for how a column's status maps
  to a dispatch.
  - `todo` — where new tickets are first created, awaiting work; also the
    landing lane a ticket returns to once the BA has defined it, so the build
    column's **claim** can pick it up.
  - `defining` — the **business-analyst** agent is defining the task (writing
    acceptance criteria and Gherkin) before any coding.
  - `in-progress` — the **coder** agent is implementing the ticket.
  - `testing` — the **tester** agent is creating/checking tests.
  - `done` — complete.
  - `failed-testing` — the ticket's tests failed; its board marker turns **red**
    and the fix loop runs before returning it to `testing`. It **remains the
    fix-loop failure status** and stays claimable, but it **no longer has a
    dedicated lane**: its cards fold into the **Testing** lane (keeping the red
    marker). It still owns its `tasks/failed-testing/` folder.

  There is no `post-processing` status, lane, or `kind: post-processing`
  ticket concept anywhere in this document — that concept has been removed
  from the app entirely; never describe, dispatch, or route to one.
- `created` and `updated` are ISO-8601 timestamps. Bump `updated` on **every**
  write. Preserve `created`.
- `agent` (optional) is the **claim** field: the id of the single agent currently
  building this ticket. It is set atomically when a ticket is claimed and cleared
  when the build reaches a terminal state. It is an extra frontmatter key, kept
  after the leading keys by the serializer, and round-trips untouched by the
  board. See "Concurrency, claims, and isolation" below. (`lib/ticket-queue.js`
  owns the claim/queue/isolation logic as pure, requireable helpers.)
- The `## Additional Context` section belongs to the user. Read it; never edit or
  delete it. Everything else in the body you may edit while a ticket is in your
  care.
- If a ticket file fails to parse (missing frontmatter, no closing `---`), skip
  it and tell the user rather than guessing.

## Routing

- `/orchestrate plan <feature description>` — or any feature request when no
  `todo` tickets exist yet → decompose the request into fresh tickets (the BA
  dispatch described under **Forward movement model**'s `defining` walk-through
  below).
- `/orchestrate build` → run **the generic column dispatch loop** (below) over
  every ticket on the board, repeatedly — batching, claiming, and dispatching
  as slots allow — until the board is clear (nothing left that a column's
  agent can act on right now).
- `/orchestrate status` → summarize the board (count per lane, list ticket
  ids/titles/statuses) and stop.

## Column model (`tasks/team-config.json`)

There is no fixed BA → coder → tester → tech-lead pipeline. Every board
**column** — read from `tasks/team-config.json`'s ordered `columns` array,
normalised by `lib/team-config.js` — names the single **agent** dispatched for
tickets sitting in it, plus free-text **instructions** telling that agent how
to handle a ticket passing through it. Which agent runs is **never**
hardcoded in this document; it is always a lookup against the current column.

- **Column order is board order.** `columns` is left-to-right the same order
  the board renders lanes in. Forward advancement (see **Forward movement
  model** below) follows this configured order, not a hardcoded sequence.
- **Each column has:** `status` (the slug tickets in this column carry),
  `label`, `description`, `agent` (a named subagent type, or `null` for a
  passive column), `instructions` (free text appended to that agent's
  dispatch), and `system` (`true` for one of the five fixed system columns —
  `todo` / `defining` / `in-progress` / `testing` / `done` — `false` for a
  user-added column).
- **Missing/corrupt `tasks/team-config.json`.** When the file is missing or
  fails to parse, `lib/team-config.js`'s `normalizeConfig` falls back to the
  canonical **five system columns** (`todo`, `defining`, `in-progress`,
  `testing`, `done`) with their default agents and instructions
  (`SYSTEM_COLUMN_DEFAULT_AGENTS` / `SYSTEM_COLUMN_DEFAULT_INSTRUCTIONS`) —
  never fewer, never a different order. Treat a corrupt config exactly like a
  fresh project with no user columns: proceed with the canonical five.
- **A system column's default agent**, used when its `agent` is explicitly
  `null`, is `SYSTEM_COLUMN_DEFAULT_AGENTS[<slug>]`: `todo` → none,
  `defining` → `orchestrate-ba`, `in-progress` → `orchestrate-coder`,
  `testing` → `orchestrate-tester`, `done` → none. These defaults are sourced
  from `lib/orchestrate-agents.js`'s `AGENT_TYPES`, not hardcoded twice.
- There is no `post-processing` column anywhere — `tasks/team-config.json`
  drops a legacy one on normalize rather than resurrecting it.

## The generic dispatch loop

For **every** ticket, on every pass of `/orchestrate build`, the orchestrator
runs the same decision — there is no per-role special-casing:

1. **Read the ordered `columns`** from `tasks/team-config.json` (see **Column
   model** above).
2. **Find the ticket's current column** — the column whose `status` slug
   equals the ticket's `status`. A ticket whose `status` matches **no**
   column at all (out-of-enum / `unknown`) is never silently routed anywhere,
   least of all back to `todo`: do not dispatch it, and report it to the user
   as needing manual attention.
3. **Resolve the agent to dispatch, with a fallback chain:**
   - the column's own `agent`, when it names one; else
   - `SYSTEM_COLUMN_DEFAULT_AGENTS[<slug>]`, when the column is one of the
     five system columns and its `agent` is `null`; else
   - **no agent** — the column is **passive** (see step 4).

   Once an agent name is chosen, if it names a specific subagent type that has
   **no definition file** in `.claude/agents/`, fall back to
   `general-purpose` and continue rather than aborting — and **report** which
   named agent was missing (the same fallback-and-report rule every dispatch
   in this skill has always followed).
4. **Dispatch, or wait.**
   - **Passive column** (no agent resolved at all) — `todo`, `done`, or any
     user "parking" column with no agent configured — is **never dispatched**.
     A ticket sitting there waits: `todo` is the **entry queue** (it waits for
     `/orchestrate build` to pick it up), and `done` is terminal.
   - **Column with a resolved agent** — dispatch it (Task tool) with the
     **fixed preamble + the full ticket text + that column's `instructions`
     LAST** (see **Prompt caching** below for why the instructions go last).
     The dispatched agent returns a **distilled** result (see **Distilled
     returns**), never its raw transcript.
5. **Act on the outcome.** A dispatch's outcome is **one of several**, not
   always "advance forward":
   - **Forward** — the common case: on success, advance the ticket to the
     **next column's status** in configured order (whole-file atomic write,
     `updated` bumped) and continue.
   - **Backward** — a ticket can be sent to an **earlier** column (the
     testing column's fix loop, or a reject-and-rework verdict from a
     review-type column). The concrete rules for when and where a ticket
     moves backward are specified in **Rework, review verdicts, and reaching
     done** below — this loop only guarantees that "advance forward" is never
     the sole hardcoded branch a dispatch can produce.
   - **Park-and-ask** — a dispatch can leave a ticket in place awaiting a
     human answer (e.g. a BA clarifying question) rather than advancing it
     either way; see the `defining` walk-through below.

This is a **loop**, not a one-shot pass: `/orchestrate build` keeps
re-scanning, batching everything eligible in parallel, and — whenever a
dispatch finishes and frees a slot — returns to step 1 to **top up** the free
slots with the next `selectNextBatch` set (see **Concurrency, claims, and
isolation**), until the board is clear.

## Forward movement model

Advancement follows the **configured column order** — left-to-right in
`columns` — which for a fresh/default board is exactly:

    todo → defining → todo (defined) → in-progress (via claim) → testing → [user columns] → done

This is the existing status lifecycle, reframed as column dispatch rather than
a hardcoded phase pipeline:

- **`todo`** — passive (no agent). New tickets are created here. It is the
  **entry queue**: `/orchestrate build` scans it every pass, oldest first.
- **`defining`** (agent: `orchestrate-ba`, unless overridden) — a ticket
  parked here while the BA is actively working it. The column's
  **instructions** carry the **definition-skip gate**: when a ticket is
  **already defined** (`isTicketDefined` in `lib/ticket-definition.js` — a
  real, non-placeholder `## Acceptance Criteria` checkbox **and** a
  non-empty ```gherkin block in `## Cucumber Tests`), the instructions tell
  the agent to pass it through unchanged rather than redefining it. Either
  way, a **defined** ticket returns to **`todo`** — never straight into
  `in-progress` — so the build column's **claim** (below) is what actually
  picks it up next.
  - **A defined ticket's `## Acceptance Criteria` are frozen.** Once a ticket
    leaves `defining`, no agent widens, narrows, or re-words them — only the
    user does, via an answered `question` or `## Additional Context`. They are
    the **only** basis on which a later column may fail the work, so a reviewer
    wanting to add a criterion after the code is written is out of scope by
    construction (see **Review-type columns: two verdicts**).
  - **Multiple undefined `todo` tickets discovered at once** (a fresh
    re-scan, or several created mid-build) are parked into `defining` and
    dispatched together, in **one message** — never one-at-a-time — subject
    to the same free-slot bound as any other batch (see **Concurrency,
    claims, and isolation**).
  - **A BA clarifying question parks only that ticket.** Write it onto the
    ticket's `question` frontmatter field (`lib/ticket-questions.js`, which
    turns its board dot yellow); the rest of the swarm keeps defining/building
    other tickets. A question-parked `defining` ticket does not hold a
    concurrency slot, so it can never starve other ready work.
    - When a parked definition's question is answered and it resumes
      actively-defining, it re-counts as a concurrency slot — so if a build
      meanwhile filled the slot it had freed, live occupancy MAY briefly
      exceed `limit` under a burst of simultaneously-answered definitions.
      This transient is ACCEPTED: it is bounded (by how many answers land at
      once), self-corrects as in-flight builds finish, and never corrupts
      state — so it is preferred over a strict cap-on-resume that could
      deadlock a resuming definition against an always-full bound.
  - **Stale `defining` on a fresh run** (left over from a prior, interrupted
    run with no live BA) is treated as stale intake: re-dispatch the BA to
    finish the definition rather than skipping it.
  - Once defined (and any question answered), the ticket returns to `todo`
    and is evaluated immediately against the free-slot math
    (`canRunInParallel`) — claimed and built right away if a slot is free,
    rather than waiting for a review pause: adding/defining a ticket mid-build
    is implicit consent to proceed.
- **Entry into `in-progress` is a claim, not a plain dispatch.** Unlike every
  other column transition, moving a `todo` (or `failed-testing`) ticket into
  `in-progress` is performed by **`claimTicket`** (`lib/ticket-queue.js`) — a
  compare-and-set, whole-file write that sets `status: in-progress` **and**
  `agent: <build id>` together, and only succeeds when the freshly re-read
  ticket is still claimable and unclaimed. This is unchanged mechanics (see
  **Concurrency, claims, and isolation**); the column model just describes
  *which* agent the claimed build then dispatches (`in-progress`'s `agent`,
  default `orchestrate-coder`).
- **`in-progress`** (agent: `orchestrate-coder`, unless overridden) — the
  claimed build, running in its own git isolation (branch/worktree — see
  **Concurrency, claims, and isolation**). On success, advance to
  **`testing`**.
- **`testing`** (agent: `orchestrate-tester`, unless overridden) — the tester
  writes/extends both e2e and unit tests and runs the suite. A **green**
  result advances forward, following configured column order. A **red**
  result's fix loop is backward movement, specified in **Rework, review
  verdicts, and reaching done** below (this loop only guarantees a red result
  is never silently treated as green).
- **User columns positioned between `testing` and `done`** (e.g. a review
  lane) are dispatched **serially**, one at a time, in configured column
  order — never in parallel with each other or with the shared-git-writing
  steps of other tickets (see **Concurrency, claims, and isolation**'s
  serialize-only-shared-git rule).
- **`done`** — terminal; passive (no agent). The concrete rules for exactly
  when a ticket is allowed to reach `done`, and what a reject-and-rework
  verdict does instead, are specified in **Rework, review verdicts, and
  reaching done** below.

**Batching is unchanged.** Whenever more than one ticket is eligible for the
same kind of dispatch at once — several undefined `todo` tickets awaiting the
BA, or a freshly-claimed batch awaiting their coder dispatch — issue **all**
of those Task-tool calls **in a single message**, never one-at-a-time, capped
only by the free-slot bound (`selectNextBatch` / `canRunInParallel` in
`lib/ticket-queue.js`, default concurrency **3**, clamped to a hard ceiling of
**8**). Claim-before-build ordering is unaffected by batching: each ticket in
a batch is still claimed individually and atomically (`claimTicket`, a
whole-file write, re-read fresh, first writer wins) **before** its dispatch
starts — only the Task-tool calls themselves are issued together, once every
claim in the batch has landed. See **Concurrency, claims, and isolation** for
the full mechanics — they apply identically no matter which column a batch is
dispatching into.

## Model routing (optimise for cost)

The swarm is tuned for cost. In a swarm the token bill is dominated by
**context, not output**: every sub-agent re-reads files, re-loads
instructions, and re-explains state, so most savings come from tiering models
by task difficulty and keeping each sub-agent narrow — not from any single
model choice.

Each agent's model is pinned in its own `.claude/agents/*.md` frontmatter
(`model:` key) — **not** in this document, and never spliced per-ticket, or
per-column, into a dispatch preamble (that would bust the prompt cache; see
**Prompt caching** below). The out-of-the-box tiering for the five system
columns' default agents:

- **Default tier `claude-sonnet-5`** — `orchestrate-coder` (`in-progress`).
  Implementation needs real capability but not the premium tier. This is also
  the fallback every other role degrades to when its own tier is unavailable.
- **Premium tier `claude-opus-4-8`** — `orchestrate-ba` (`defining`) and
  `orchestrate-tech-lead` (a review-type column, when configured). The hard
  reasoning steps — decomposing a feature into tickets, and a thorough review
  — justify the premium tier. Falls back to `claude-sonnet-5` when
  `claude-opus-4-8` is unavailable.
- **Cheap tier `claude-haiku-4-5`** — `orchestrate-tester` (`testing`).
  Writing and running tests from a fully-specified ticket is mechanical,
  high-volume work — the biggest per-ticket saving in the swarm. Falls back to
  `claude-sonnet-5` when `claude-haiku-4-5` is unavailable.

**These tiers are settings, not constants**, owned by each agent's `model:`
line — change a column's effective model by editing the `model:` frontmatter
of the agent it dispatches (or by pointing the column at a different agent),
and the Team tab's **Agents** panel edits it for you, keeping the `assets/`
mirror byte-synced. A user column that names its own agent (or reuses one of
the four above) inherits whatever tier that agent's own file pins — this
document states the policy once, here; no per-column section restates a model
id anywhere.

## Distilled returns (never inherit a sub-agent's raw context)

Every sub-agent returns a **compact, distilled summary** of its work — never
its full working transcript — and the orchestrator works **only** from that
summary, never inheriting a sub-agent's raw context. Concretely: the BA
(`defining`) returns the ticket ids/titles it defined plus any clarifying
questions; the coder (`in-progress`) returns the changed files, a
one-paragraph summary, and (where useful) the diff; the tester (`testing`)
returns pass/fail plus the failing output and the test file names; a
review-type column's agent returns its findings. The detailed state lives in
the **ticket files and the code**, which the next agent reads directly, so
nothing is lost by keeping each hand-off small. This is the single biggest
cost lever in the swarm: small hand-offs keep every downstream agent's
context — and therefore the token bill — small.

## Prompt caching (stable prefix, volatile suffix)

Cached input tokens cost roughly a **tenth** of fresh ones, so the swarm is
structured to maximise cache hits. The rule is **stable content first,
volatile content last**, so the unchanging prefix stays cache-warm across
every dispatch and every agent — regardless of which column is dispatching:

- **The agent definition files are the stable, always-cached prefix.** Each
  `orchestrate-*` agent's system prompt (`.claude/agents/*.md`) is identical
  on every dispatch of that agent, so it is reused from cache across the
  whole swarm. **Never regenerate an agent definition or splice per-ticket
  data — or a per-column model id — into it**: keep it byte-stable so its
  cache is reused (this is also why the `assets/` mirror is kept
  byte-identical). Where the queue allows, group repeated dispatches of the
  **same agent** together so its cached system prompt stays warm rather than
  alternating agents and cold-starting each one.
- **Build every dispatch prompt as: fixed preamble + ticket text + that
  column's `instructions`, LAST.** The **stable prefix** is the agent's
  system prompt plus a fixed preamble (the same role reminder and
  ticket-file contract, worded identically on every dispatch, never
  interleaving ids/timestamps/paths). The **volatile tail** — appended after
  the stable prefix — is the full ticket text, with that column's
  `instructions` appended **last of all** (and, for a fix-loop or rework
  dispatch, the failing output/verdict after that). Use the same wording and
  order for the preamble every time so its prefix matches the cache.
- **Front-loaded ticket context is shared, cache-friendly state.** Because the
  BA (`defining`) captures all the context a downstream agent needs **inside
  the ticket body** up front, later agents read that one stable artifact
  instead of re-exploring the repo. Agents read **only the specific files the
  ticket names**, not whole trees.
- **Keep the volatile tail small.** Combined with **Distilled returns** above,
  only the small, changing part of each prompt is fresh (uncached) input,
  while the large, stable part (system prompt + preamble + ticket contract)
  is served from cache. Small volatile tails plus stable prefixes are what
  make the swarm cheap.

## Context optimisation (trim between dispatch hand-offs)

`tasks/team-config.json`'s `skill.contextOptimization` (`{ enabled, level }`,
normalised by `lib/team-config.js`, editable from the Team → Board panel)
makes the swarm's existing context-minimisation habit a **configurable,
persisted setting** instead of unconditional behaviour. It does not replace
or contradict **Distilled returns** or **Prompt caching** above — it is the
directive that tells the orchestrator, at every **column-to-column
movement**, to actually apply them:

- **When to apply it.** At **every dispatch hand-off** — every point a
  sub-agent returns and the next column's dispatch is about to launch,
  forward or backward. This is not a hook on a user manually dragging a card
  between board lanes; it is every agent-dispatch hand-off described
  throughout this document.
- **Enabled check.** Read `skill.contextOptimization.enabled`. Treat it as
  disabled **only** when the value is the literal boolean `false`; a missing
  config file, a missing `contextOptimization` key, or any non-boolean value
  counts as enabled (the config layer normalises it to `true`).
- **What to do when enabled.** At each hand-off: **drop** context that is no
  longer needed (a completed dispatch's full working transcript, files read
  but not touched, exploratory scratch state), **summarise** what must be
  kept (the distilled per-agent return described in **Distilled returns**,
  plus any ticket-file state the next dispatch needs), and **carry forward
  only that minimum** into the next dispatch.
- **The `level` dial.** `skill.contextOptimization.level` is one of
  `conservative`, `standard`, or `aggressive`: `conservative` carries more
  surrounding state forward (useful when a user is debugging a run),
  `standard` is the everyday balance described above, and `aggressive` trims
  to the smallest viable hand-off — distilled summary and ticket-file
  pointers only, nothing extra. A missing or invalid `level` is treated as
  `standard`.
- **Defaults.** Missing/invalid/unparseable config is treated as
  `{ enabled: true, level: "standard" }` — the swarm already optimises
  context unconditionally today, so this default preserves that existing
  behaviour.

## Rework, review verdicts, and reaching done

This section is the concrete backward-movement and terminal-transition
specification that **The generic dispatch loop** and **Forward movement
model** above point to. Two separate loops share the same 3-attempt cap and
park-and-ask shape — the testing column's fix loop, and a review-type
column's reject-and-rework verdict — plus the terminal `done` transition.
Neither is hardcoded to "the tester phase" or "the tech-lead phase": both are
described purely in terms of the column a ticket sits in, that column's
`agent`, and (for the review verdict) that column's `instructions`.

### The testing fix loop (backward movement on a red result)

A **testing-type column** is the system `testing` column, or any user column
whose `instructions` declare it a testing step (free text the orchestrator
reads, not a new schema field). When that column's agent reports a **red**
result:

1. Set the ticket's `status` to **`failed-testing`** (whole-file write,
   `updated` bumped) — it stays claimable, folds into the **Testing** lane
   with a red marker (`laneForStatus`), keeps owning `tasks/failed-testing/`,
   and is re-picked by `selectNextBatch` while attempts remain
   (`CLAIMABLE_STATUSES` in `lib/ticket-queue.js` includes it).
2. Dispatch the agent of the **nearest preceding build column** — walking
   backward through the configured column order from the testing column to
   the closest earlier column whose agent actually implements code (the
   `in-progress` column's agent, `orchestrate-coder`, unless overridden) —
   with the ticket **plus the failure output** appended after that column's
   `instructions` (see **Prompt caching**'s volatile-tail ordering).
3. On success, return the ticket to the **testing** column's status for
   another run — the same forward step as any other advance, just re-entered.
4. **Cap this fix loop at 3 attempts per ticket.** The orchestrator counts
   attempts from the ticket's own history (its `runs`/`activities` log
   entries for this fix cycle) — no separate counter field is invented. After
   the **third** red result, leave the ticket in `failed-testing`, summarise
   what is still failing, and ask the user how to proceed rather than
   dispatching a fourth fix attempt. This cap is a property of the testing
   column's rework rule, not a hardcoded "Phase 3" — and the testing column's
   default `instructions`
   (`SYSTEM_COLUMN_DEFAULT_INSTRUCTIONS.testing` in `lib/team-config.js`) name
   the "capped at 3 attempts" behaviour so it is visible in config, not just
   in this document.
5. **No preceding build column exists.** A testing-type column with no build
   column anywhere before it in configured order cannot auto-fix: report that
   to the user and leave the ticket in `failed-testing` rather than guessing
   at a target or silently discarding the failure.

### Review-type columns: two verdicts

A **review-type column** is a user column positioned **after** `testing`
whose agent reviews the ticket and the implementation rather than building it
(e.g. `pr-review` → `orchestrate-tech-lead`). Its agent reports findings with
severity, and every review dispatch resolves to **exactly one** of two
verdicts — never both, never neither:

Two structural rules bound **both** verdicts, and you enforce them on every
review dispatch:

- **A findings budget.** A review agent returns **at most 3 findings, force
  ranked by severity, highest first** — fewer when fewer survive, and
  **returning zero findings is a normal and expected outcome**, not a sign the
  review was shallow. If a report comes back longer than three, keep the three
  most severe and record the remainder as observations; never let an over-long
  report expand into extra work.
- **The Acceptance Criteria are the only failure basis.** A review may fail the
  work on exactly two grounds: the implementation does not satisfy a **stated**
  acceptance criterion of that ticket (frozen at `defining`), or it breaks
  something that previously worked. Style, naming, formatting, code
  organisation, and hypothetical future refactors are **out of scope** unless
  they cause a correctness or security problem the reviewer names concretely.
- **Everything outside those two grounds is an _observation_, not a defect.**
  Observations live in the run summary and **expire when the ticket reaches
  `done`** — they never become tickets and nothing downstream is obliged to act
  on them. Without that expiring bucket every remark becomes work by default.

**(a) Reject-and-rework (blocking).** The reviewer's report carries an
explicit reject verdict — typically triggered by a `critical` finding the
reviewer judges must be fixed before this ticket can proceed, but it is the
**explicit reject verdict**, not severity alone, that triggers this path.
When it does:

1. Send the ticket **backward**: whole-file write its `status` to the
   **nearest preceding build column** — the same walk-backward rule as the
   testing fix loop — **unless** the review column's `instructions` name a
   specific rework-target column, in which case send it there instead. If an
   instructions-named target does not exist in the current board config, fall
   back to the nearest preceding build column and report the
   misconfiguration rather than failing silently.
2. Dispatch that target column's agent with the ticket **plus the reviewer's
   findings as failure-style context**, appended after that column's
   `instructions`, exactly like the testing fix loop's failure output.
3. On success, the ticket **re-enters the forward flow** from that column —
   back through `testing`, then the review column again — rather than
   jumping straight back to the review column.
4. **Cap this reject-and-rework cycle at 3 attempts per ticket**, mirroring
   the testing fix-loop cap exactly and tracked the same way (a per-ticket
   attempt count read from the ticket's own `runs`/`activities` history,
   never a new frontmatter field). After the **third** rejection, park the
   ticket in `failed-testing`, summarise the unresolved review findings, and
   ask the user how to proceed — exactly like the testing cap's third red
   result, so a reject ⇄ rework cycle can never run unbounded and a ticket
   is never silently dropped.

A review column's `instructions` are where the user configures which verdict
mode it uses and, optionally, the rework-target column override — free text
the orchestrator/agent parses, not a new `team-config` schema field. Absent
an override, the default target is always the nearest preceding build
column.

**(b) Follow-up only (non-blocking).** When a finding is
`critical`/`high-security` but the reviewer does **not** issue a reject
verdict, or for any lower-severity finding, the reviewed ticket's status is
**not** touched by this path. Instead:

- **You are the single gate — no agent creates tickets.** Reviewers report;
  **you** decide what becomes work. Put the pooled findings through the **last
  review column's agent as a triage step** (`orchestrate-tech-lead` in the
  worked example): its output is a **strictly smaller**, force-ranked list, and
  it is obliged to discard anything not traceable to a stated acceptance
  criterion, a demonstrable regression, or a concrete security defect. Only
  what survives triage is eligible to become a ticket. On a board with no
  review column nothing is eligible — the findings stay observations.
- For a **surviving** non-blocking `critical`/`high-security` finding, create a
  **new follow-up `todo` ticket** — you (the orchestrator) create it, the
  reviewer only reports it — with an id continuing the `TASK-nnn` sequence
  from the **true maximum** id found across all status subfolders
  (`tasks/*/TASK-*.md`), never reusing an existing id and never skipping
  ahead of the real maximum. That follow-up ticket must:
  - **Carry a `review-of: <reviewed ticket id>` frontmatter key** (e.g.
    `review-of: TASK-019`) — an extra frontmatter key the serializer keeps
    after the leading keys and round-trips untouched, the machine-identifiable
    marker that it is a review follow-up.
  - **Contain a `## Impact If Not Fixed` section** in its body, carrying the
    reviewer's short (1–3 sentence) impact statement for that finding — the
    concrete consequence of leaving the issue unfixed, so the user can weigh
    whether to build it.
- Everything the triage step discarded, and everything over the 3-finding
  budget, creates **no** ticket. Medium/low/nit findings create **no** ticket —
  note them in the run summary only, as observations that expire when the
  reviewed ticket reaches `done`.
- Either way, creating (or not creating) a follow-up never changes the
  reviewed ticket's status or frontmatter — the reviewed ticket keeps
  advancing through the forward flow untouched by this path.

### Break the recursion (a review follow-up never re-enters the same cycle)

A follow-up ticket raised by a review is **deferred backlog work, not part of
the current cycle**. In the same `/orchestrate build` run that created it you
**never** select, claim, or dispatch a ticket carrying a `review-of:` key — no
matter how many concurrency slots are free. It waits in `todo` until the user
queues it deliberately on a later run.

This is what stops the pipeline diverging. Without it each generation of review
follow-ups is itself reviewed, raising the next generation, and three tickets
become fifteen without ever converging. Batch them instead: at the end of the
run report **how many follow-ups were raised and which tickets they came from**
as one list for the user's periodic backlog review, then stop.

Two consequences worth stating plainly:

- **A follow-up is never auto-built.** `selectNextBatch` still counts a `todo`
  ticket as claimable, so this rule is yours to enforce at selection time:
  filter `review-of:` tickets out of the batch before you claim anything.
- **A follow-up never re-opens its parent.** The ticket it was raised against
  keeps advancing to `done` regardless (see **Reaching done** below).

### Reaching done (terminal)

Once a ticket clears its **last agent-bearing column** in configured order
with **no pending rejection** — i.e. it is not mid-cycle in a
reject-and-rework backward move — the orchestrator sets its `status` to
**`done`** directly, whole-file write, `updated` bumped. There is no
intervening post-processing step: TASK-206 removed the `post-processing`
column and the whole `kind: post-processing` "final events" concept from the
app entirely (lib, renderer, and on-disk config/tickets), so nothing runs
"against every ticket" before `done` — the last column's success **is** the
terminal transition.

`done` is terminal regardless of any follow-up tickets a review raised along
the way (a follow-up ticket never blocks or reopens the ticket it was raised
against). It is, however, **never** reached while a reject-and-rework
rejection is still pending resolution for that ticket — that cycle must
resolve forward (an accepted rework) or via the 3-cycle cap (parked in
`failed-testing`) before `done` is possible.

Every transition in this section — the `failed-testing` write, the backward
rework write, the forward re-entry, and the terminal `done` write — is a
whole-file atomic write; `created` is preserved, `updated` is bumped, and the
per-activity cost log (`activities`) is appended per dispatch, exactly as
described in **State-consistency rules** below. No status outside the enum
(`todo` / `defining` / `in-progress` / `testing` / `failed-testing` / `done`,
plus any user column slug) is introduced anywhere in this section — the
backward rework move reuses existing statuses; it never invents a new one.

## Concurrency, claims, and isolation

The swarm builds tickets in parallel, in batches, but self-coordinates
**only** under these guarantees. The pure helpers in `lib/ticket-queue.js`
implement the decisions below and are unit-tested; **this module, and
`lib/ticket-lanes.js`, are unchanged by the column model** — the swarm's
claim/slot/isolation logic stays bound to the same swarm-owned statuses it
always has (`todo` / `defining` / `in-progress` / `testing` /
`failed-testing`), regardless of which agent a column's `agent` field
currently names.

- **Bounded concurrency (batch size).** At most **N** agents build at once, so
  each set/batch is at most N tickets (default N = 3, `DEFAULT_CONCURRENCY`;
  clamped to a hard ceiling of 8, `MAX_CONCURRENCY`). `selectNextBatch` fills
  only the free slots (`limit − (in-progress + testing + defining)`, the
  slot-occupancy count that includes `defining`), so it never starts a build
  when N tickets already occupy slots. Tickets past the bound wait in the
  queue and are picked up as slots free.
- **Dispatch a newly-created ticket into a free slot.** When a single ticket
  is created during a build, decide whether it can run **right now** with
  `canRunInParallel(tickets, newTicket, { limit, agentId })`. It reuses the
  same eligibility and slot math as `selectNextBatch` and returns `{ ok,
  reason, freeSlots }` — decision-only, it never claims or writes. On
  `ok: true`, claim (`claimTicket`) and build immediately; on `ok: false`
  (`no-ticket` / `claimed` / `already-active` / `not-claimable` / `no-slots`)
  leave it queued in `todo`.
- **At most one agent per ticket.** A ticket is claimed (`claimTicket`) by
  writing your build's id into its `agent` frontmatter field together with
  `status: in-progress`, in a single whole-file write, and only when the
  freshly re-read ticket is claimable and unclaimed. That write is the atomic
  claim; the first writer wins. No two swarm agents may work the same ticket.
- **Each build writes only its own ticket file.** A build never writes
  another ticket's file or any shared board state.
- **Whole-file, atomic writes preserved.** Every ticket write is a single
  full-file rewrite (never a partial append/in-place field edit), so a
  concurrent board poll never reads a half-written file — the board's
  keep-last-good-parse absorbs any mid-write read. This rule holds unchanged
  for every column's write, not just a build's.
- **Per-ticket git isolation.** Each build runs on its own branch/worktree
  derived from the ticket id (`ticketBranchName` / `ticketWorktreeDir`), so
  parallel builds never clobber each other's working tree. Serialize **only**
  at the points that touch shared git state — e.g. merging a finished build's
  branch back into the base branch, or a **user-column agent that writes to
  the shared tree** (it must be serialized exactly like a shared-git merge
  step, never run in parallel with another tree-writing dispatch) — doing
  those **one at a time**.
- **User-column statuses stay non-claimed, non-slot-counted, and serial.**
  `lib/ticket-queue.js`'s claim/slot bound is scoped to the swarm's own
  statuses only; a **user column's** status (`isUserStatus`, in
  `lib/ticket-lanes.js` and mirrored in `lib/ticket-queue.js`) is never
  claimed, never counted toward the concurrency bound, and its dispatch
  always runs **serially** — one ticket at a time — never batched in
  parallel like a `todo`/`failed-testing` claim.
- **Release on terminal state.** When a build reaches `done` (or is left in
  `failed-testing` after the cap), clear its `agent` claim (`releaseTicket`)
  so the slot frees for the next batch and, for `failed-testing`, the ticket
  can be re-picked later.

## State-consistency rules

- Only **you** (the orchestrator) edit ticket status/frontmatter. Subagents
  receive ticket content in their prompt and report results back **as a
  compact, distilled summary** — they do not touch status or claims, and you
  never inherit their raw working context (see **Distilled returns**).
- Claim before you build: write the `status: in-progress` + `agent`
  transition before starting the work it names, and never touch a ticket
  claimed by another agent.
- Never invent a status outside the valid enum: `todo`, `defining`,
  `in-progress`, `testing`, `done`, and `failed-testing` — five lanes plus the
  claimable fix-loop status. **No new status is introduced by the column
  model** — a user column's slug is a value `lib/team-config.js` validates and
  persists, but the swarm-owned lifecycle itself is unchanged. There is
  **no** `post-processing` status, lane, or ticket kind anywhere — it has
  been removed from the app entirely.
- Timestamps: preserve `created`, always bump `updated`.
- Per-activity cost log: after each column's agent dispatch completes, append
  one entry to that ticket's `activities` frontmatter field — a one-line JSON
  array, written with the standard whole-file write and `updated` bumped —
  recording the `activity` (`ba` / `code` / `test` / `review`, or any other
  activity string a user column's agent performs — the list is open-ended),
  the `model` dispatched, and its `startedAt`/`finishedAt`; include
  `tokensIn`/`tokensOut`/`costUsd` only when the run actually reported them,
  and `cacheReadTokens`/`cacheCreationTokens` only when telemetry correlated
  usage for that window — never fabricate a token or cost figure when data is
  unavailable (e.g. telemetry off, or no rows matched). This is additive: the
  existing `startedAt`/`finishedAt`/`tokens`/`costUsd` accounting and the
  `runs` log stay untouched.
