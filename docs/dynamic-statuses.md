# Dynamic statuses (team-config engine, custom board columns)

## What it does and why

Historically the Tasks board had six fixed lanes hardcoded in the HTML. This
feature makes the board **configurable**: a project can add its own columns
(statuses) — e.g. a `ux-review` lane between testing and done — while the six
built-in system lanes stay fixed and the orchestrate build swarm is provably
never confused by user columns.

The single source of truth is `tasks/team-config.json`. The **Board** panel on
the [Team tab](team-tab.md) is the authoring UI; the Tasks board renders whatever
that file declares; and a set of config-aware helpers route tickets to lanes and
folders and produce config-aware Slack summaries. With **no** config file the
whole system behaves byte-identically to the historic six-lane board.

## How it works

### `tasks/team-config.json` — the config file

Modelled by [`lib/team-config.js`](../lib/team-config.js) (pure, Electron-free,
never throws — junk always collapses to a valid config). Shape:

```json
{
  "version": 1,
  "columns": [
    { "status": "todo", "label": "To Do", "description": "",
      "agent": null, "system": true },
    { "status": "ux-review", "label": "UX Review", "description": "Design pass",
      "agent": "orchestrate-tech-lead", "system": false }
  ],
  "skill": { "concurrencyDefault": 3 }
}
```

**System columns.** The six system columns mirror the fixed lanes in
[`lib/ticket-lanes.js`](../lib/ticket-lanes.js) `LANE_STATUSES` order
(`todo → defining → in-progress → testing → post-processing → done`) with today's
board-header labels. Their slugs and their `system: true` flag are **immutable**:
`normalizeConfig` re-injects any deleted system column and repairs any tampered
slug/flag, so all six always survive in canonical order.
`failed-testing` is deliberately **not** a column — it stays a lane-less status
that folds into Testing, so it is a **reserved** slug.

**User columns** (`system: false`) live between system columns. A slug is chosen
once and is **immutable** thereafter — a "rename" is a label edit only, so no
ticket or folder migration is ever needed. A user slug must match `[a-z0-9-]`, be
≤ 30 chars, and must not collide with `VALID_STATUSES`, `unknown`, `__wont-do__`,
or an existing column. `agent` per column is **display-only** metadata (it may
name a nonexistent agent; that is warned about at render time, never dispatched).

**`skill.concurrencyDefault`** is normalised through `resolveConcurrency` (from
`lib/ticket-queue.js`), so the file can never carry an out-of-range value.

Public API of `lib/team-config.js`: `defaultConfig()`, `normalizeConfig(raw)`
(returns a complete config with a `warnings` list of every repair),
`validateNewColumn(label, slug, config)`, `slugForLabel(label)`,
`serializeConfig(config)` (normalises, strips `warnings`, trailing newline).
Unknown top-level and per-column fields round-trip untouched, and a newer
`version` is never downgraded.

### Config-aware lane routing — `lib/ticket-lanes.js`

The original fixed helpers stay byte-compatible; the `*For` variants layer the
dynamic engine on top (they take the normalised `columns` array and never throw —
junk yields the fixed system-only behaviour):

- `laneStatusesFor(columns)` — the ordered lane slugs: the six system lanes with
  each user column inserted at its anchored position (the last system column
  before it; a column before `todo` sorts ahead of it). No-config → exactly
  `LANE_STATUSES`.
- `laneForStatusFor(status, columns)` — `failed-testing` folds into `testing`;
  each system status maps to its own lane; a user status gets its own lane;
  anything else routes to `UNKNOWN_STATUS` (never silently to `todo`).
- `isKnownStatusFor(status, columns)` / `isUserStatus(status, columns)` — a user
  slug that collides with a system status always resolves as the **system**
  meaning (guarded, though `normalizeConfig` already prevents it).

### Config-aware folders — `lib/ticket-folders.js`

The `*With` variants treat every user column as owning its own `tasks/<slug>/`
folder, exactly like a system status:

- `folderForStatusWith(status, columns)` / `folderMatchesStatusWith(...)` /
  `reconcileFolderWith(currentFolder, status, columns)` → `{ needsMove,
  targetFolder }`.
- **Migration policy:** slugs are immutable (rename never moves files); a
  **removed** column is config-only — once its slug is gone from `columns` the
  status is unknown, so `targetFolder` is `null` and the files stay put (routed to
  `unknown` on the board, never relocated, never hidden). With null/junk `columns`
  these are byte-identical to the fixed helpers.

### Swarm boundary — `lib/ticket-queue.js`

`SWARM_STATUSES` (derived from `VALID_STATUSES`) is the explicit set the build
swarm owns: `todo → … → done` plus `failed-testing`. Any concrete status **not**
in that set is a user status. `isUserStatus(status)` guards every claim/slot
decision (`claimTicket`, `selectNextBatch`, `canRunInParallel`), so a
user-status ticket (e.g. `ux-review`) is **never** claimed, dispatched, counted
active, or counted toward a concurrency slot. Because the claimable/active/slot
sets are strict subsets of `SWARM_STATUSES`, this is belt-and-braces — it makes
the boundary explicit rather than changing behaviour.

### The Board panel — column manager (renderer)

The authoring UI (renderer, ~line 5441 onward, TASK-103) edits an in-memory
working model and persists the **whole** file in one write:

- `refreshTeamBoard(tab)` reads `tasks/team-config.json` (a corrupt file loads the
  six defaults with a non-blocking notice), splits out `version`/`skill`/unknown
  fields, and normalises columns via `normalizeTasksColumns` (the renderer mirror
  of `normalizeConfig`).
- Each column row (`buildTeamColumnRow`) shows reorder ↑/↓, the slug, a `system`
  badge for system columns, editable **Label**/**Description**/**Display agent**
  (a `<select>` of `.claude/agents/` names; a saved-but-missing agent is kept as a
  `(missing)` option and warned), and — user columns only — a **Remove** button.
- **Add column** (`buildTeamAddColumnForm`): a label input with a live derived-slug
  preview (`tasksSlugForLabel`), a position select, and validation
  (`tasksValidateNewColumn`, mirror of `validateNewColumn`) before anything enters
  the model.
- Reordering is constrained: `canSwapTeamColumns` forbids swapping two system
  columns, so the fixed system order is preserved; a user column can move freely
  but never past the system sequence into an illegal order (the save-time
  normalise re-anchors it anyway).
- **Remove** a user column confirms first, stating how many live tickets hold that
  status and that they will fall to **Unknown** until the column is re-added — it
  edits the config only, never a ticket file.
- **Save** (`saveTeamBoardConfig`) serialises through `tasksSerializeTeamConfig`,
  which runs `normalizeTasksColumns` first — the **security gate**: an invalid,
  reserved, duplicate, or tampered slug can never be persisted. All labels /
  descriptions / slugs render via `textContent`, never `innerHTML`.

### The Tasks board — dynamic lanes (renderer)

`renderTasksBoard` resolves columns from the last-good config
(`normalizeTasksColumns(t.config)`), builds lanes wholesale via
`rebuildTasksLanes` (system + user columns in board order, plus a hidden
`unknown` catch-all lane), and routes each ticket by mirroring
`laneForStatusFor`/`isKnownStatusFor`. The board **poll** (`pollTasksOnce`, every
~2500 ms) reads `tasks/team-config.json` with keep-last-good semantics: a mid-poll
read failure or invalid JSON keeps the previous good config rather than flickering
to defaults. A config saved on the Team tab therefore appears on the board within
one poll tick — no restart. `tasksConfigSig` folds the config + agent set into the
render signature so a config-only change (new/renamed/reordered column, agent, or
description) re-renders even when no ticket file changed.

Lane headers are safe (`buildTasksLaneEl` uses `textContent`/`title`); a user lane
gets a `.user-lane` accent and its display-agent badge is flagged `missing` when
the agent has no `.claude/agents/` definition.

### Folder reconciliation & the status dropdown

`relocateTicketFile` / `reconcileTicketFolders` use `ticketFolderForStatusWith`
(mirror of `folderForStatusWith`) plus an `isSafeTasksSlug` allowlist gate before
any `mkdir`/`rename`, so no untrusted slug reaches the filesystem. A removed
column's tickets have no target folder and are left in place. Dragging an
actively-worked ticket (an active status carrying a claiming `agent`) onto a
**user** lane is refused with a visible notice and no write. The ticket-modal
status `<select>` is populated dynamically (`populateTaskStatusOptions` from the
config columns) plus the "Won't do" pseudo-entry, replacing the six hardcoded
`<option>`s that used to live in `index.html`.

### Config-aware Slack summary — `formatTasksSummary`

The Slack `tasks` command summary (mirrored in
[`lib/slack-commands.js`](../lib/slack-commands.js) and the renderer) takes the
board columns so its lane order and count labels follow the config: system lanes
keep their raw slug in the count line (regression-safe), user columns use their
label, and out-of-config statuses count under `unknown`. Called with no config it
produces the historic six-lane summary. It reuses the already-loaded
`tab.tasks.config`, so it never re-reads the file.

## Usage

1. **Team** tab → **Board** section.
2. **Add column** — type a label (e.g. `UX Review`), watch the slug preview
   (`ux-review`), pick a position, click **Add**.
3. Edit **Label**/**Description**/**Display agent**, reorder with ↑/↓, or
   **Remove** a user column.
4. Click **Save** to write `tasks/team-config.json`.
5. Switch to the **Tasks** tab — the new lane appears within one poll tick.

## Configuration

`tasks/team-config.json` — see the shape above. Also editable:
`skill.concurrencyDefault` from the [Workflow panel](workflow-settings.md).

Slug rules: `[a-z0-9-]`, ≤ 30 chars, not reserved
(`VALID_STATUSES` / `unknown` / `__wont-do__`), not a duplicate.

## Inputs and outputs

- **Input:** the Board panel working model.
- **Output:** a normalised `tasks/team-config.json` (whole-file write). The board,
  folder layout, status dropdown, and Slack summary all derive from it.

## Edge cases and limitations

- **Corrupt/missing config** → the six system lanes; the Board panel shows a
  notice and a Save writes a repaired file.
- **Removed user column** → its tickets are never moved or edited; they show under
  **Unknown** until the column is re-added.
- **Slugs are immutable** — you cannot rename a slug, only its label. To change a
  slug, remove and re-add the column (tickets on the old slug go to Unknown).
- **User columns never affect the swarm** — they are never claimed or counted.
- The renderer mirrors of `lib/team-config.js`, `lib/ticket-lanes.js`, and
  `lib/ticket-folders.js` must be kept in lockstep with the lib modules (all carry
  KEEP-IN-SYNC comments).
