---
id: TASK-131
title: deploying the skill
status: done
created: 2026-07-21T08:03:03.487Z
updated: 2026-07-21T09:01:45.000Z
activities: [{"activity":"ba","model":"claude-fable-5","startedAt":"2026-07-21T08:14:05.000Z","finishedAt":"2026-07-21T08:21:49.000Z"},{"activity":"code","model":"claude-opus-4-8","startedAt":"2026-07-21T08:43:58.000Z","finishedAt":"2026-07-21T08:50:30.000Z"},{"activity":"test","model":"claude-opus-4-8","startedAt":"2026-07-21T08:50:30.000Z","finishedAt":"2026-07-21T08:57:30.000Z"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-21T08:57:30.000Z","finishedAt":"2026-07-21T09:01:00.000Z"},{"activity":"post-processing","model":"claude-opus-4-8","startedAt":"2026-07-21T09:01:00.000Z","finishedAt":"2026-07-21T09:01:45.000Z"}]
---

## Description

"Adding the skill from the UI" in this app means clicking one of the three
**Install orchestration skill** surfaces, which all drive the same
`tasks:installSkill` IPC:

- the Tasks-board banner (`installOrchestrateSkill`, `renderer/renderer.js`
  ~9194–9219, button wired at ~574),
- the Workflow-panel banner (`buildWorkflowInstallHint`, ~7083–7125),
- the Agents-panel hint (`buildAgentsInstallHint`, ~7751–7790).

The handler (`main.js` ~761–790) copies `assets/skills/orchestrate/*` to
`<project>/.claude/skills/orchestrate/`, copies `assets/agents/*` to
`<project>/.claude/agents/`, and creates `tasks/`. There is **no manifest or
settings.json registration step anywhere in this app** — for Claude Code, a
project skill is "registered" when (a) `.claude/skills/<name>/SKILL.md` with valid
`name`/`description` frontmatter exists on disk (the bundled file has it), **and**
(b) the Claude Code session has discovered it, which happens **at session startup
only**.

That (b) is the gap. The app auto-launches a long-lived `claude` session in the
cmd pane when a tab opens (`launchCmdAgent`, ~1056–1080, via `spawnTerm(..., {
cliCommand: 'claude' })`), and every `/orchestrate plan|build` command is typed
into that **already-running** session by the prompt queue (`tryDispatchNextPrompt`,
~5176–5222; `BUILD_COMMAND` at 9221; plan enqueue at ~10181). So the common flow —
open folder → claude launches → click Install → click Build/Plan — sends
`/orchestrate build` to a session that started **before** the skill files existed
and therefore never registered the skill. Worse, the install success path
immediately sets `tab.tasks.skillInstalled = true` and enables the Build button
(~9209–9211), so the UI actively invites queueing commands into a session where the
skill is not registered.

**Fix (per user decision — see Clarifications):** never auto-relaunch the session.
After a successful UI install, **always show an inline "Restart Claude to register
the skill" notice with a Restart action** on the surface where install was clicked
(when the tab's agent is `claude` and a cmd PTY is alive). Clicking Restart
relaunches the Claude session via the existing `launchCmdAgent(tab)` kill-and-respawn
path so the newly installed skill is discovered at the new session's startup. The
restart is always user-initiated; the app never kills an in-flight response on its
own. All three install surfaces share one helper. Only the installing tab is
affected (other tabs on the same folder are a documented limitation).

## Clarifications

Resolved with the user before build (recorded here, not in Additional Context):

1. **Scope** → the **existing "Install orchestration skill" buttons** (Tasks
   banner, Workflow panel, Agents hint). NOT a new UI for adding arbitrary/custom
   skills (that would be a separate, larger ticket).
2. **Registration on idle** → **always show a "Restart Claude to register the
   skill" notice/button and let the user trigger the restart.** Do NOT auto-relaunch
   the session (auto-relaunch would silently discard conversation context).
3. **Busy session** → same: show the restart notice and do nothing else. Never kill
   an in-flight Claude response automatically.
4. **Multiple tabs on the same folder** → only the **installing tab** shows the
   notice / is restarted. Other tabs on the same folder stay stale (documented
   limitation).

## Acceptance Criteria

- [ ] A single shared post-install helper exists in `renderer/renderer.js` (e.g.
  `promptSkillRegistration(tab, surfaceEl)`), and all three install surfaces (Tasks
  banner, Workflow banner, Agents hint) call it after a successful
  `tasks:installSkill` result — no divergent copies.
- [ ] After a successful install, when the tab's agent is `claude` and a cmd PTY is
  alive (`tab.cmd.id`), the surface shows an inline notice — "Restart the Claude
  session to register the skill" — with a **Restart** button/action. The app does
  **not** auto-relaunch.
- [ ] Clicking **Restart** relaunches the Claude session via the existing
  `launchCmdAgent(tab)` kill-and-respawn path, so the newly installed skill is
  discovered at the new session's startup and a subsequent queued `/orchestrate
  build` or `/orchestrate plan …` runs the skill.
- [ ] The app never kills an in-flight Claude response on its own: no automatic
  relaunch occurs on any path (idle or busy). The Restart action is always
  user-initiated. (If the user clicks Restart while a response is in flight, that is
  their explicit choice; the notice may warn that restarting ends the current
  session.)
- [ ] When the tab's agent is `opencode` or no cmd PTY exists, the helper is a safe
  no-op (no notice, no error, no relaunch); install success behavior is otherwise
  unchanged.
- [ ] Only the installing tab shows the notice / is restarted; other tabs pointed at
  the same folder are unaffected (documented limitation).
- [ ] Existing install success behavior is preserved: Tasks banner hides,
  `skillInstalled` flips true, Build/Plan buttons enable per existing gating
  (`updateBuildBtn`/`updatePlanBtn`), Workflow/Agents panels re-read, and
  `pollTasksOnce` still runs for the Tasks-banner path.
- [ ] Install failure (`{ ok: false }` from `tasks:installSkill`, including the
  `OUTSIDE_ROOT_ERROR` confinement rejection) keeps the current inline-error behavior
  on each surface and performs **no** registration notice and **no** state flip.
- [ ] A relaunch failure triggered by the Restart action (PTY kill/spawn throws) is
  caught: the error is logged, an inline notice tells the user to restart Claude
  manually, and `skillInstalled` remains true (the files are validly on disk —
  registration with the session is the only pending step).
- [ ] `main.js` `tasks:installSkill` behavior is unchanged (asar-safe copy loop,
  `fsRoots.isPathAllowed` guard, `{ ok }` shape) — this ticket adds no main-process
  write paths.
- [ ] Docs updated: `docs/orchestrate-workflow.md` ("Skill install" section, ~163)
  and `docs/team-tab.md` (~54–56) describe that install is file copy **plus** a
  user-triggered session restart to register the skill.
- [ ] Tests added following the `task-105-workflow-panel.e2e.test.js` /
  `task-095-add-agent.e2e.test.js` patterns: the notice appears after a successful
  install for a claude tab, clicking Restart calls the relaunch path, opencode/no-PTY
  is a no-op, install failure shows no notice and no state flip, and a relaunch
  failure surfaces the manual-restart notice while keeping `skillInstalled` true.

## Cucumber Tests

```gherkin
Feature: Skill registration when installed from the UI

  Scenario: Installing from the Tasks banner offers a restart to register the skill
    Given a project tab with the claude session running
    And the orchestration skill is not installed
    When the user clicks "Install orchestration skill" on the Tasks banner
    And the install IPC returns ok
    Then the skill files exist under .claude/skills/orchestrate/ and .claude/agents/
    And an inline notice offers to restart the Claude session to register the skill
    And the Build and Plan buttons become enabled
    And no relaunch happens until the user clicks Restart

  Scenario: Clicking Restart relaunches the session so the skill is registered
    Given the post-install restart notice is showing on a claude tab
    When the user clicks "Restart"
    Then the Claude session is relaunched via the kill-and-respawn path
    And a subsequently queued "/orchestrate build" is typed into the NEW session

  Scenario: Installing from the Workflow panel uses the same registration step
    Given the Workflow panel shows the install banner and the tab's agent is claude
    When the user installs the skill from the Workflow panel
    Then the same shared helper shows the restart notice
    And the Workflow panel re-reads and renders the pipeline

  Scenario: Installing from the Agents panel uses the same registration step
    Given the Agents panel shows the install hint and the tab's agent is claude
    When the user installs the skill from the Agents panel
    Then the same shared helper shows the restart notice
    And the Agents panel re-reads the agent roster

  Scenario: App never auto-kills an in-flight response (edge)
    Given the claude session is mid-response
    When the user installs the skill successfully
    Then no relaunch is performed automatically
    And the restart notice is shown for the user to trigger when ready
    And skillInstalled is true and the Build button gating is unchanged

  Scenario: OpenCode pane is a no-op (edge)
    Given the tab's agent is opencode
    When the user installs the skill successfully
    Then no restart notice is shown and no error is raised
    And the install success behavior is otherwise unchanged

  Scenario: Install IPC fails (failure)
    Given tasks:installSkill returns ok false with an error message
    When the user clicks install on any surface
    Then the surface shows the inline install-failed message with that error
    And no restart notice is shown and skillInstalled is not set true

  Scenario: Project path outside approved roots is refused (failure)
    Given the tab folder resolves outside every approved project root
    When install is invoked
    Then the IPC returns ok false with "Path is outside the approved project root"
    And no files are written and no restart notice appears

  Scenario: Relaunch triggered by Restart fails (failure)
    Given the restart notice is showing and killing or respawning the PTY throws
    When the user clicks "Restart"
    Then the error is logged and an inline notice tells the user to restart Claude manually
    And skillInstalled remains true because the files are on disk
```

## Edge Cases and Failure Modes

- **Never auto-kill an in-flight Claude response** — the restart is always
  user-initiated; the app performs no automatic relaunch on any path.
- **OpenCode agent or dead PTY** (`tab.agent === 'opencode'`, `tab.cmd.id` null) —
  skills are Claude-specific; helper must no-op (no notice).
- **Install IPC failure**, including `OUTSIDE_ROOT_ERROR` from the
  `fsRoots.isPathAllowed` guard — no notice, no state flip.
- **Partial copy failure** — the main-process copy loop can fail mid-way leaving
  some files on disk while returning `{ ok: false }`; UI must treat this as not
  installed (existing behavior; do not regress).
- **Relaunch failure** (PTY kill/spawn throws when Restart is clicked) — surface a
  manual-restart notice, keep `skillInstalled: true`.
- **Reinstall over an existing skill** — the registration notice should apply on
  that path too if the same buttons are used; it must not stack duplicate notices.
- **Multiple tabs open on the same folder** — only the installing tab's notice is
  shown; other tabs' sessions stay stale (documented limitation).
- **Restart races the prompt queue** — a `/orchestrate` command already queued must
  not be typed while the new session is still starting; the existing
  autolaunch/prompt-ready flow in `lib/pty.js` + `tryDispatchNextPrompt`'s
  `tab.status === 'finished'` gate handles ordering, and tests must confirm it.

## Relevant Files and Context

- `main.js` — `tasks:installSkill` handler (~761–790): asar-safe flat copy of
  `assets/skills/orchestrate/*` and `assets/agents/*`, `fsRoots.isPathAllowed` +
  `OUTSIDE_ROOT_ERROR` (~690). Unchanged by this ticket.
- `preload.js` — `tasks.installSkill` bridge (line 68).
- `renderer/renderer.js` —
  - `installOrchestrateSkill` (~9194–9219, Tasks banner; wired at ~574),
  - `buildWorkflowInstallHint` (~7083–7125), Agents install hint (~7751–7790) — the
    three surfaces to route through one shared helper;
  - `launchCmdAgent` (~1056–1080) — the existing kill-and-respawn path to reuse for
    the Restart action;
  - `tryDispatchNextPrompt` (~5176–5222) and `tab.status === 'finished'` idle gating
    — the delivery path `/orchestrate` commands take;
  - `checkOrchestrateSkill` (~8231–8243), `updateBuildBtn` (~9387–9406),
    `updatePlanBtn` (~9412–9420) — existing install-state gating to preserve;
  - `BUILD_COMMAND` (9221), plan enqueue (~10181).
- `lib/pty.js` — autolaunch of `cliCommand: 'claude'` once the shell prompt renders
  (~36, `spawnShell`).
- `assets/skills/orchestrate/SKILL.md` and `.claude/skills/orchestrate/SKILL.md` —
  the bundled skill; frontmatter `name: orchestrate` + `description` is what Claude
  Code discovers. No manifest exists; `lib/assets-mirror.js` mirroring is for
  edit-time sync and is not part of install.
- Docs to update: `docs/orchestrate-workflow.md` (~163–181), `docs/team-tab.md`
  (~54–56).
- Test patterns: `test/task-105-workflow-panel.e2e.test.js`,
  `test/task-095-add-agent.e2e.test.js`, `test/task-129-readside-confinement.e2e.test.js`.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
