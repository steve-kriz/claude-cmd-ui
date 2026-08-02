# Team tab

## What it does and why

The **Team** tab is a per-project control surface for the orchestrate workflow.
Where the [Tasks board](orchestrate-workflow.md) shows work *moving*, the Team
tab lets you shape the machine that moves it: the agent roster, the read-only
build pipeline, per-phase model choices, the default build concurrency, and the
board's own columns (statuses/lanes).

It sits alongside the other workspace tabs and, like them, is scoped to the
folder open in that tab. With no folder open every panel shows an
`(open a folder)` empty state.

The tab is defined in [`renderer/index.html`](../renderer/index.html) (the
`data-tab="team"` button and the `data-view="team"` view) and driven by
`initTeamTab` in [`renderer/renderer.js`](../renderer/renderer.js).

## How it works

The Team view is a single scroll area with three stacked, **collapsible**
sections, each with its own header controls. Every section header carries a
focusable toggle button (chevron) that collapses/expands that section's body
independently of the other two — mirroring the Git panel's collapsible
sub-sections. All three sections start expanded; collapsing one leaves the
other two untouched, and collapsed state persists across tab re-activation and
Refresh (it resets only on app restart).

| Section | What it edits | Backing store | Detailed docs |
|---------|---------------|---------------|---------------|
| **Agents** | Subagent definitions — list, edit the full file (description/tools/model/body), **Regenerate with AI**, and **Add agent** | `.claude/agents/*.md` (+ mirrored `assets/agents/*.md`) | [agent-management.md](agent-management.md) |
| **Workflow** | Read-only phase pipeline + per-phase agent **model** editor + per-phase **enable/reorder** + build-**concurrency** default + **context optimisation** control + guided **"Regenerate this phase's instructions"** AI action | `.claude/skills/orchestrate/SKILL.md` (read only, except the one guided AI-regenerate Save), agent files, `tasks/team-config.json` | [workflow-settings.md](workflow-settings.md) |
| **Board** | The board columns/statuses — add, edit label/description/agent/**phase link**, reorder, remove | `tasks/team-config.json` | [dynamic-statuses.md](dynamic-statuses.md) |

`initTeamTab(tab)` (renderer, ~line 6567) is called on tab activation and on
folder change. When a folder is open it calls three independent refreshers —
`refreshTeamAgents`, `refreshTeamWorkflow`, and `refreshTeamBoard` — each of
which re-reads its backing files from disk. It binds no listeners itself (those
are wired once when the tab element is built, ~lines 555-568), so it is safe to
call repeatedly.

Every panel reads from disk on activation and on an explicit **Refresh**; there
is **no background polling** inside the Team tab. (The Tasks board *does* poll,
so a config change saved here is reflected on the board within one poll tick —
see [dynamic-statuses.md](dynamic-statuses.md).)

## Usage

1. Open a project folder in a tab.
2. Click the **Team** tab.
3. Use the section you need:
   - **Agents** → **Add agent** to create a new subagent, or **Edit** on a card
     to change its description, tools, model or body (name is read-only). In the
     editor, **Regenerate with AI** proposes a rewritten file from a plain-English
     instruction (requires `ANTHROPIC_API_KEY`); the result is a preview you must
     **Save** to apply.
   - **Workflow** → review the pipeline, **Edit** a phase's agent model, toggle a
     phase **Enabled**/reorder it, set the **Build concurrency default**, adjust
     **Context optimisation** (Enabled + level), or use **Regenerate this
     phase's instructions** to propose (and, after review, **Save**) a
     rewritten phase section.
   - **Board** → add/reorder/remove columns, then **Save** to write
     `tasks/team-config.json`.

If the orchestration skill is not installed, the Agents and Workflow panels show
an **Install orchestration skill** banner that drives the same
`tasks:installSkill` flow the Tasks board uses; on success the panel re-reads.
Install is a file copy **plus** a session-registration step: because Claude Code
only discovers project skills at session startup, a successful install on a
`claude` tab shows an inline **"Restart the Claude session to register the skill"**
notice with a **Restart** button. The restart is always user-triggered (the app
never auto-relaunches and never kills an in-flight response on its own); clicking
Restart respawns the session so it picks up the newly copied skill. The notice is
a no-op for `opencode` tabs or when no session is running, and only the installing
tab is affected.

## Inputs and outputs

- **Reads:** `.claude/agents/*.md`, `.claude/skills/orchestrate/SKILL.md`,
  `tasks/team-config.json`.
- **Writes:** agent files (via the mirror-aware writer — see
  [assets-mirror.md](assets-mirror.md)) and `tasks/team-config.json`. The
  Workflow panel otherwise never writes `SKILL.md`, except through its one
  guided "Regenerate this phase's instructions" Save, which writes only the
  target phase's `## Phase <n>` section body (mirror-synced) — see
  [workflow-settings.md](workflow-settings.md).

## Edge cases and limitations

- **No folder open** → every panel shows `(open a folder)`.
- **Skill not installed** → Agents/Workflow show an install banner rather than an
  error; the Board panel still works (it only needs `tasks/`).
- **Stale-guarded:** each async refresh re-checks that its target DOM node is
  still the current one before rendering, so switching folder/tab mid-read never
  paints stale content.
- Panels do not auto-refresh each other. Adding an agent updates the Agents panel
  immediately; the Board panel's agent dropdowns pick up the new agent on their
  next **Refresh** (or re-activation).
