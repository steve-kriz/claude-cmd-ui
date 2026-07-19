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
  Gherkin. The planning phase is dispatched on **Fable 5** (`claude-fable-5`) when
  available, otherwise **Opus 4.8** (`claude-opus-4-8`); the preferred model is
  declared on the `orchestrate-ba` agent frontmatter (`model:`) and the fallback
  is described in the skill's Phase 1 dispatch text.
- **coder** (`orchestrate-coder`) — implements one ticket to its acceptance
  criteria inside that ticket's isolated branch/worktree; does not write tests.
- **tester** (`orchestrate-tester`) — writes e2e cucumber + unit tests, mocks all
  DB calls, runs the suite, reports pass/fail.
- **tech-lead** (`orchestrate-tech-lead`, read/search only) — reviews a passed
  ticket before done; turns issues into new follow-up fix tickets.

If a named agent definition is missing at dispatch, `resolveAgentType` falls back
to `general-purpose` and reports it rather than aborting.

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
- **Parallel-build dropdown** — the toolbar lets you pick the concurrency; the
  choice is persisted per-folder and passed as `--concurrency <N>`
  ([`lib/tasks-settings.js`](../lib/tasks-settings.js)).

**Skill install.** `tasks:installSkill` copies the bundled skill and the
subagent definitions from `assets/` into the opened project's `.claude/skills/`
and `.claude/agents/`, and ensures `tasks/` exists (asar-safe file copies).

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
