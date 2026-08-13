# Tasks board & the Orchestrate workflow

## What it does and why

The **Tasks** tab is a live kanban board for ticket-driven development. You plan
a feature into small tickets, review them, and let a set of AI subagents build,
test, and review them while you watch progress move across the lanes. The board
re-reads the ticket files every few seconds, so status changes appear on their
own.

The workflow is driven by the `orchestrate` skill
([`.claude/skills/orchestrate/SKILL.md`](../.claude/skills/orchestrate/SKILL.md)),
coordinated by an orchestrator (an LLM following the skill) that dispatches to
dedicated subagents. The board and its rules are backed by pure, Electron-free
`lib/ticket-*.js` helpers so the decision logic is unit-tested.

## How it works

**Tickets are files.** Each ticket is a Markdown file under `tasks/` with flat
`key: value` frontmatter (`id`, `title`, `status`, `created`, `updated`, plus
optional extras) followed by `## Description`, `## Acceptance Criteria`,
`## Cucumber Tests`, and a user-owned `## Additional Context` section the agents
read but never overwrite. Two absolute rules: every status change is written to
disk immediately, and every ticket file is rewritten in full in a single write
(never a partial field edit), so a mid-poll read never sees a half-written file.

**Six lanes**, rendered left-to-right in this exact order
([`lib/ticket-lanes.js`](../lib/ticket-lanes.js), `LANE_STATUSES`):

`todo → defining → in-progress → testing → post-processing → done`

- **todo** — freshly created tickets awaiting work (and where you drop new ones).
- **defining** — the business-analyst agent is writing acceptance criteria and
  Gherkin.
- **in-progress** — a coder agent is implementing the ticket.
- **testing** — a tester agent is writing/running tests.
- **post-processing** — holds post-processing tickets (`kind: post-processing`),
  the "final events" run against every normal task after review passes and before
  it is marked done. These are excluded from the build swarm. `failed-testing`
  cards fold into the **testing** lane here (keeping their red marker).
- **done** — complete.

`failed-testing` is still a valid, claimable status (the fix loop hands a ticket
back to it) — it just has no dedicated lane; its cards render inside **testing**
with a red marker, and it keeps its own `tasks/failed-testing/` folder.
Out-of-enum statuses route to a dedicated **unknown** lane
(`laneForStatus`) rather than being hidden in `todo`.

**Folder-per-status layout** ([`lib/ticket-folders.js`](../lib/ticket-folders.js)).
A ticket lives in `tasks/<status>/` matching its frontmatter status. Frontmatter
status is the single source of truth: when folder and status disagree the file is
reconciled (moved). Unknown statuses own no folder and are left in place.

**Four agent roles** (dispatched to dedicated subagents; names in
[`lib/orchestrate-agents.js`](../lib/orchestrate-agents.js)):

- **business-analyst** (`orchestrate-ba`, read/search only) — turns a feature
  request into small, independently testable tickets with acceptance criteria and
  Gherkin. Runs on the premium **Opus 4.8** (`claude-opus-4-8`) tier, falling back
  to the default **Sonnet 5** (`claude-sonnet-5`) if it is unavailable; the model
  is pinned on the `orchestrate-ba` agent frontmatter (`model:`) and the routing
  is described in the skill's "Model routing" section.
- **coder** (`orchestrate-coder`) — implements one ticket to its acceptance
  criteria inside that ticket's isolated branch/worktree; does not write tests.
  Runs on the default **Sonnet 5** (`claude-sonnet-5`).
- **tester** (`orchestrate-tester`) — writes e2e cucumber + unit tests, mocks all
  DB calls, runs the suite, reports pass/fail. Runs on the default **Sonnet 5**
  (`claude-sonnet-5`).
- **tech-lead** (`orchestrate-tech-lead`, read/search only) — reviews a passed
  ticket before done; turns issues into new follow-up fix tickets. Runs on the
  premium **Opus 4.8** (`claude-opus-4-8`) tier (the thorough final review, like
  planning, justifies the premium tier). For every
  finding the reviewer also reports a short **"impact if not fixed"** statement
  (the concrete consequence of leaving it unbuilt). Each follow-up fix ticket the
  orchestrator creates carries a `review-of: <reviewed ticket id>` frontmatter key
  (naming the ticket whose review produced it, e.g. `review-of: TASK-019`) and an
  `## Impact If Not Fixed` section holding that statement, so the user can weigh
  whether to build it. See the skill's Phase 4 and
  [`.claude/agents/tech-lead.md`](../.claude/agents/tech-lead.md).

If a named agent definition is missing at dispatch, `resolveAgentType` falls back
to `general-purpose` and reports it rather than aborting.

**Cost routing, distilled returns & prompt caching.** The swarm is tuned for cost.
Token spend in a swarm is dominated by *context, not output*, so the three levers
are: (1) **model tiering** — the default is `claude-sonnet-5` and only the
hard-reasoning phases (BA planning, tech-lead review) use the premium
`claude-opus-4-8`; (2) **distilled returns** — every sub-agent returns a compact
summary (changed files + one-paragraph summary, pass/fail + failing output, or
findings), and the orchestrator works only from that summary and never inherits a
sub-agent's raw context; and (3) **prompt caching** — cached input tokens cost
~1/10 of fresh ones, so stable content goes first and volatile content last: the
byte-stable agent system prompts stay cache-warm across every dispatch, each
dispatch prompt is a fixed preamble with the volatile ticket text appended last,
and agents read only the specific files the ticket names rather than re-exploring.
The detailed state lives in the ticket files and the code, which the next agent
reads directly. See the skill's "Model routing", "Distilled returns", and "Prompt
caching" subsections.

**Concurrency, claims & isolation** ([`lib/ticket-queue.js`](../lib/ticket-queue.js)).
The build loop runs several tickets at once up to a bounded limit
(`DEFAULT_CONCURRENCY = 3`, hard ceiling `MAX_CONCURRENCY = 8`). Each ticket is
claimed atomically by writing the agent's id into an `agent` frontmatter field
together with `status: in-progress` in one whole-file write (first writer wins).
Each build runs on its own per-ticket branch/worktree derived from the id
(`ticketBranchName` → `orchestrate/task-004`; `ticketWorktreeDir`), so parallel
builds never clobber each other; git-shared steps are serialized.
`selectNextBatch` picks the oldest claimable tickets that fit the free slots;
`canRunInParallel` decides whether a newly created ticket fits a slot right now.
Free slots are `limit − slotOccupancyCount`, and `slotOccupancyCount` counts every
`SLOT_OCCUPYING_STATUSES` ticket (`defining` / `in-progress` / `testing`) — so a
`defining` ticket (a BA definition in flight for it) consumes a build slot too,
keeping BA definitions and builds together under the bound. `defining` occupies a
slot without being "active" (it stays unclaimable and lights no "being worked on"
dot). One nuance (TASK-087): `slotOccupancyCount` uses `isSlotOccupyingTicket`,
which exempts a `defining` ticket PARKED on an unanswered BA question
(`isWaitingForAnswer` — non-empty `question`, empty `answer`), so it frees its slot
and parked definitions never stall ready `todo`/`failed-testing` work; an
actively-defining ticket (no open question) still counts, and a parked `defining`
ticket stays unclaimable regardless.

**Build accounting & run log.** The single latest build stamps `startedAt` /
`finishedAt` (and optional `costUsd` / `tokens`) onto the frontmatter
([`lib/ticket-accounting.js`](../lib/ticket-accounting.js)); every run also
appends an entry to a durable `runs` log so re-runs accumulate rather than
overwrite ([`lib/ticket-runs.js`](../lib/ticket-runs.js)). The board shows each
ticket's build time (in minutes), cost, and token figures.

**Other board features.**

- **Ordering** — the `todo` lane honours a per-ticket numeric `order` field
  (`compareTicketOrder` in `lib/ticket-queue.js`) so a chosen order sticks across
  polls and restarts.
- **Clarifying questions** — a ticket can carry a `question` / `answer` pair;
  while it has a question and no answer the card shows a yellow "waiting" dot
  ([`lib/ticket-questions.js`](../lib/ticket-questions.js), `isWaitingForAnswer`).
- **Durable history** — each coder/tester prompt+response is folded into a
  `## History` section, kept before `## Additional Context`
  ([`lib/ticket-history.js`](../lib/ticket-history.js)).
- **Working indicator** — cards in `defining` / `in-progress` / `testing` show a
  blue "being worked on" dot (`ACTIVE_STATUSES`).
- **Type bar** (TASK-075) — a thin colored strip between the ticket-id header and
  the title encodes the ticket type, derived purely from frontmatter: red for a
  bug ticket (non-empty `bug-of`), yellow for a PR-review ticket (non-empty
  `review-of`), and green for every other ticket (the default, including
  post-processing and unknown-status cards). Bug wins when both markers are
  present (`isBugTicket` / `isReviewTicket` → `.task-card-type` in
  [`renderer/renderer.js`](../renderer/renderer.js) /
  [`renderer/styles.css`](../renderer/styles.css)). It renders on every card in
  every lane, including inside the Done lane's "Archived (N)" expander.
- **"Won't do" resolution** (TASK-074) — the ticket modal's status select carries
  a fixed **"Won't do"** option. Choosing it persists the ticket as `status: done`
  **plus** a `resolution: wont-do` frontmatter marker in a single whole-file write,
  moving the card into the **done** lane while recording that it was declined
  rather than completed. Such a card renders its title struck-through and muted
  (`isWontDoTicket` → `.task-card-title.wont-do` in
  [`renderer/styles.css`](../renderer/styles.css)), including inside the Done
  lane's "Archived (N)" expander, and re-opening the modal shows "Won't do"
  selected. This resolution is reachable **only** through the modal status select —
  a plain drag onto the Done lane stays an ordinary `done` with no marker. Only an
  exact `wont-do` value triggers the treatment; any other `resolution` round-trips
  untouched.
- **Parallel-build dropdown** — the toolbar lets you pick the concurrency; the
  choice is persisted per-folder and passed as `--concurrency <N>`
  ([`lib/tasks-settings.js`](../lib/tasks-settings.js)).
- **Auto-define undefined tickets** (TASK-079) — a `todo` ticket added mid-build
  that is not yet defined (no real, non-placeholder `## Acceptance Criteria` plus a
  non-empty ```gherkin ``` block — `isTicketDefined` in
  [`lib/ticket-definition.js`](../lib/ticket-definition.js)) is defined before any
  build: the orchestrator parks it in `defining`, runs it through the
  `orchestrate-ba` agent, then writes it back to `todo` and dispatches it **without
  a review pause** (adding a ticket mid-run is implicit consent). An
  already-defined ticket skips the BA and goes straight to dispatch. See the
  skill's Phase 2 step 1.
- **Auto-queue build on ticket creation** (TASK-079) — creating a ticket from the
  app (New-ticket modal, bug-create, or the Slack `create ticket` command)
  auto-starts an `/orchestrate build` run even when the auto-build toggle is off
  (`autoQueueBuildOnCreate` in [`renderer/renderer.js`](../renderer/renderer.js)).
  It reuses the same single-run guard as the continuous loop, so it is a no-op when
  a run is already active/queued or Claude is not idle — that already-active run's
  mid-build intake picks the new ticket up instead, and no overlapping run starts.
- **Build button direct-send** (TASK-143) — clicking **Build** when nothing is
  running (a live, idle session with an empty [prompt queue](prompt-queue.md) and
  no TUI menu open) types `/orchestrate build --concurrency <N>` straight into the
  terminal instead of routing it through the queue; if a run is in flight,
  mid-dispatch, already queued, or Claude is paused on a menu it falls back to the
  queue exactly as before (`startBuildOrQueue` in
  [`renderer/renderer.js`](../renderer/renderer.js)).

**Skill install.** Installing the orchestration skill from the UI (the Tasks
banner, Workflow panel, or Agents panel — all three drive the same
`tasks:installSkill` IPC) is a **two-step** process:

1. **File copy** — `tasks:installSkill` copies the bundled skill and the subagent
   definitions from `assets/` into the opened project's `.claude/skills/` and
   `.claude/agents/`, and ensures `tasks/` exists (asar-safe file copies). It also
   **seeds the starter board** into `tasks/team-config.json` — `starterConfig()`
   from [`lib/team-config.js`](../lib/team-config.js): the five system columns plus
   a `pr-review` lane between Testing and Done, so every dispatching column already
   names one of the four agents just copied (`orchestrate-ba` → `orchestrate-coder`
   → `orchestrate-tester` → `orchestrate-tech-lead`) and carries the instructions it
   is dispatched with. `todo` and `done` stay deliberately agent-less — the skill
   never dispatches a passive column, and giving `done` an agent would re-run it
   over every finished ticket on each build. The seed is written **only when
   `tasks/team-config.json` does not already exist**, so re-installing to pick up
   new agent definitions never overwrites a user's board; the handler reports which
   happened as `{ ok, seededBoard }`.
2. **Session registration** — Claude Code discovers project skills only at
   **session startup**, so the long-lived `claude` pane that was already running
   when you clicked Install will not see the freshly-copied skill. After a
   successful install the surface shows an inline **"Restart the Claude session to
   register the skill"** notice with a **Restart** button. The app never
   auto-relaunches (that would discard the running conversation and could kill an
   in-flight response); the restart is always user-initiated. Clicking Restart
   kills and respawns the session via `launchCmdAgent`, so the new session picks up
   the skill at startup and a subsequently queued `/orchestrate build|plan` runs it.
   The notice is a no-op when the tab's agent is `opencode` or no session is
   running, and only the installing tab is affected (other tabs on the same folder
   stay stale until they are restarted). If the relaunch itself fails, a manual-
   restart notice is shown and the skill stays marked installed (the files are on
   disk — only registration is pending).

## Usage

Drive the workflow from the `claude` pane (the skill is invoked by name):

```text
/orchestrate plan <feature description>   # Phase 1: BA breaks the feature into tickets (stops for review)
/orchestrate build                        # Phase 2-4: swarm builds, tests, reviews to done
/orchestrate status                       # summarize the board (count per lane)
```

Install the skill into the open project from the Tasks tab (bridge call):

```js
await window.api.tasks.installSkill('C:/projects/my-app');  // { ok }
```

Exercise the pure queue helpers directly:

```bash
node -e "const q=require('./lib/ticket-queue'); console.log(q.ticketBranchName('TASK-004'))"
# -> orchestrate/task-004
node --test test/ticket-queue.test.js test/ticket-lanes.test.js
```

![The Tasks kanban board showing tickets moving across the todo, defining, in-progress, testing, post-processing and done lanes.](../images/workflow_task_view.png)

## Configuration

- **Concurrency** — default 3, max 8 (`lib/ticket-queue.js`); persisted
  per-folder in renderer localStorage and passed as `--concurrency <N>`
  (`lib/tasks-settings.js`).
- **Phase enabled/order** (TASK-181) — before dispatching each phase, the
  orchestrator reads `skill.phases.<phase>.enabled` / `.order` (`plan` / `build` /
  `test` / `review`) from `tasks/team-config.json`. A phase is skipped only when
  `enabled` is the literal boolean `false`; `plan`/`build`/`test` default enabled,
  but **`review` defaults disabled**, so with no config the flow collapses to
  `testing → post-processing → done` (no tech-lead review). Phases dispatch in
  ascending configured `order`, followed literally even if it puts a phase ahead
  of what it depends on — the orchestrator notes any such out-of-order run in its
  end-of-run report rather than refusing. See the skill's "Phase-enabled config
  and dispatch order" section for the full rules.
- **Context optimisation** (TASK-200) — `skill.contextOptimization` (`{ enabled,
  level }`) in `tasks/team-config.json`, normalised by `lib/team-config.js`
  (`normalizeContextOptimization`) and its `renderer/renderer.js` mirror
  (`tasksNormalizeContextOptimization`). `enabled` (default `true`) gates
  whether, at every phase movement (plan → build → test → review →
  post-processing), the orchestrator drops context it no longer needs,
  summarises what it must keep, and carries the minimum forward — a
  configurable switch over the behaviour described in the skill's "Distilled
  returns" / "Prompt caching" / "Context optimisation" sections. `level` is one
  of `conservative` / `standard` / `aggressive` (default `standard`), tuning how
  aggressively context is trimmed. Missing/invalid values normalise to the
  default; context optimisation is treated as disabled only when `enabled` is
  the literal boolean `false` (mirroring the same rule used for
  `skill.phases.<phase>.enabled` above). Edited from the Team tab's **Workflow**
  panel via a new Context optimisation control (Enabled checkbox + level select) that sits
  alongside the Build concurrency default control, and persists the whole
  `tasks/team-config.json` file on Save (re-reading fresh first, so a
  concurrent Board-panel or concurrency-default save is never clobbered).
- No env vars. Ticket status enum, active statuses, and post-processing kind are
  code (`lib/ticket-lanes.js`).

## Ticket frontmatter reference

| Key | Meaning |
|-----|---------|
| `id` | Authoritative ticket id, e.g. `TASK-004` (filename slug is cosmetic) |
| `title` | Human title |
| `status` | One of `todo`, `defining`, `in-progress`, `testing`, `post-processing`, `done`, `failed-testing` |
| `created` / `updated` | ISO-8601; `created` preserved, `updated` bumped on every write |
| `agent` | Claim field: id of the single agent currently building it |
| `kind` | `post-processing` marks a post-processing ticket (never built by the swarm) |
| `order` / `priority` | Numeric `todo` ordering |
| `question` / `answer` | Clarifying Q/A (drives the yellow waiting dot) |
| `resolution` | `wont-do` marks a done ticket the user declined via the modal (struck-through, muted title) |
| `bug-of` | On a bug ticket: the id of the original ticket it was raised against (paints the card's type bar red) |
| `review-of` | On a tech-lead follow-up fix ticket: the id of the reviewed ticket that produced it (paints the card's type bar yellow) |
| `startedAt` / `finishedAt` / `costUsd` / `tokens` | Latest-build accounting |
| `runs` | One-line JSON array: durable per-run accounting log |

## Edge cases, limitations & troubleshooting

- **Unparseable ticket** (missing frontmatter / no closing `---`) is skipped and
  reported, not guessed at.
- **Post-processing tickets are never claimable** even if their status is
  tampered to `todo`/`failed-testing` (`isPostProcessingTicket` guard in
  `claimTicket`/`selectNextBatch`/`canRunInParallel`).
- **Fix loop caps at 3 attempts** — a still-red ticket is left in
  `failed-testing` and the user is asked how to proceed.
- **Only the orchestrator edits status/frontmatter** — subagents receive ticket
  content and report back; they never touch status or claims.
- **Whole-file atomic writes** keep concurrent board polls from reading a
  half-written ticket (keep-last-good-parse).
- **Missing subagent definition** → falls back to `general-purpose`; reinstall
  the skill (`tasks:installSkill`) to restore the dedicated agents.
