---
id: TASK-144
title: Team UI change
status: done
created: 2026-07-26T06:18:28.678Z
updated: 2026-07-26T07:35:05.905Z
activities: [{"activity":"ba","model":"claude-opus-4-8","startedAt":"2026-07-26T06:20:52.772Z","finishedAt":"2026-07-26T06:23:57.962Z","durationMs":185190},{"activity":"code","model":"claude-sonnet-5","startedAt":"2026-07-26T07:02:34.319Z","finishedAt":"2026-07-26T07:05:34.407Z","durationMs":180088},{"activity":"test","model":"claude-haiku-4-5","startedAt":"2026-07-26T07:06:31.660Z","finishedAt":"2026-07-26T07:23:25.760Z","durationMs":1014100},{"activity":"code","model":"claude-sonnet-5","startedAt":"2026-07-26T07:24:43.865Z","finishedAt":"2026-07-26T07:25:36.738Z","durationMs":52873},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-07-26T07:28:22.485Z","finishedAt":"2026-07-26T07:31:30.000Z","durationMs":187515},{"activity":"post-processing","model":"claude-opus-4-8","startedAt":"2026-07-26T07:32:50.000Z","finishedAt":"2026-07-26T07:33:41.821Z","durationMs":51821}]
---

## Description

The **Team** tab (`data-view="team"`) currently renders three always-open, stacked
sections inside a single scroll area: **Agents** (`.teamAgentsSection`), **Workflow**
(`.teamWorkflowSection`), and **Board** (`.teamBoardSection`). Each section is a static
`.team-section` block in `renderer/index.html` with a `.team-section-header` (title +
action buttons) and a `.team-section-body`. All three bodies are visible at all times,
so a user must scroll past every section even when they only care about one.

This ticket makes the Team tab **accordion-style**: each of the three sections becomes
independently collapsible/expandable. Clicking a section header (anywhere except its
existing action buttons) toggles that section's body between shown and hidden, with a
rotating chevron indicator and correct `aria-expanded` state on a keyboard-focusable
toggle control.

The app already has an established collapsible-section pattern in the **Git panel**
(`.git-section` / `.git-section-header` / `.git-section-toggle` / `.git-section.collapsed`,
driven by an event-delegated click handler and pure CSS), and an established accessible
toggle pattern in the **Archived (N)** expander (a real `<button>` carrying
`aria-expanded`). This ticket applies those two established patterns to the Team tab
rather than inventing a new mechanism.

Scope is **UI-only** and touches only browser assets and docs: `renderer/index.html`,
`renderer/styles.css`, `renderer/renderer.js`, and `docs/team-tab.md`. No `.claude/` or
`assets/` instruction files are touched (no assets-mirror drift). No backing-store, IPC,
or refresher logic changes — the three async refreshers (`refreshTeamAgents` /
`refreshTeamWorkflow` / `refreshTeamBoard`) must keep working unchanged even while a
section body is collapsed (collapsing hides the body with `display:none`; it does not
remove or re-identify the node, so each refresher's stale-guard, which compares node
identity, is unaffected).

**Confirmed behaviour and assumptions:**
- All three sections become accordion items.
- Sections toggle **independently** — any number may be open at once (mirrors
  `.git-section`), rather than a strict one-open-at-a-time accordion. **(Confirmed with
  the user — see Clarifications.)**
- All three sections start **expanded** on first render (preserving today's fully-visible
  layout; nothing is hidden by surprise).
- Collapsed/expanded state lives on the static `.team-section` DOM element (a CSS class),
  so it **persists across tab switches and Team-tab re-activations** within a session
  (because `initTeamTab` and the refreshers never rebuild the section elements — they
  only replace body content). State is **not** persisted across app restart (no
  `localStorage`; consistent with the in-memory `tab.tasks.archiveExpanded` precedent).

## Acceptance Criteria

- [ ] Each of the three Team sections (Agents, Workflow, Board) renders a
      keyboard-focusable toggle control in its `.team-section-header` (a real
      `<button type="button" class="team-section-toggle">` with a chevron glyph),
      consistent with the `.git-section-toggle` visual pattern.
- [ ] Clicking a section header (on the toggle, the title text, the chevron, or empty
      header space) toggles that section between expanded and collapsed.
- [ ] When a section is collapsed, its `.team-section-body` is not visible
      (`display:none` via a `.collapsed` class on the parent `.team-section`); when
      expanded, the body is visible again.
- [ ] The chevron rotates to indicate collapsed vs expanded state (via CSS on
      `.team-section.collapsed`, matching `.git-section.collapsed .git-section-toggle`).
- [ ] Clicking a section's existing action buttons — **Add agent**
      (`.teamAgentsAddBtn`), **Refresh** (`.teamAgentsRefresh` / `.teamWorkflowRefresh` /
      `.teamBoardRefresh`), and **Save** (`.teamBoardSaveBtn`) — performs its existing
      action and does **not** toggle the section.
- [ ] The toggle button's `aria-expanded` attribute reflects the section's state
      (`"true"` when expanded, `"false"` when collapsed) and updates on every toggle,
      consistent with the Archived-expander a11y pattern.
- [ ] All three sections start expanded on first render (no section ships the
      `.collapsed` class in `index.html`).
- [ ] Each section toggles independently: collapsing or expanding one section leaves the
      other two unchanged (multi-open; opening one never closes the others).
- [ ] Collapsed/expanded state survives Team-tab re-activation and folder change:
      because `initTeamTab` and the refreshers do not rebuild `.team-section` elements, a
      collapsed section stays collapsed after switching tabs and back, and after a Refresh.
- [ ] A collapsed section still receives its refreshed content: the three async
      refreshers run and populate the (hidden) body without error, so expanding a
      previously-collapsed section shows current content.
- [ ] Toggling works both by mouse click and by keyboard (focus the toggle button and
      press Enter/Space — native `<button>` behavior dispatches the same click path).
- [ ] No `.claude/` or `assets/` file is modified; change is confined to
      `renderer/index.html`, `renderer/styles.css`, `renderer/renderer.js`, and
      `docs/team-tab.md`.
- [ ] `docs/team-tab.md` is updated so its "three stacked sections" description reflects
      that the sections are now collapsible.

## Cucumber Tests

```gherkin
Feature: Team tab accordion sections

  Background:
    Given a workspace tab with a folder open
    And the Team sub-tab is active
    And the Agents, Workflow, and Board sections are rendered

  Scenario: All sections start expanded
    When the Team tab first renders
    Then none of the three .team-section elements has the "collapsed" class
    And each section's toggle button has aria-expanded "true"
    And each .team-section-body is visible

  Scenario: Collapsing a section hides only that body
    Given all three sections are expanded
    When I click the Agents section header toggle
    Then the Agents .team-section gains the "collapsed" class
    And the Agents .team-section-body is hidden
    And the Agents toggle button has aria-expanded "false"
    And the Workflow and Board sections remain expanded and visible

  Scenario: Expanding a collapsed section shows its body again
    Given the Board section is collapsed
    When I click the Board section header toggle
    Then the Board .team-section loses the "collapsed" class
    And the Board .team-section-body is visible
    And the Board toggle button has aria-expanded "true"

  Scenario: Chevron rotates with state
    Given the Workflow section is expanded
    When I collapse the Workflow section
    Then the CSS selector ".team-section.collapsed .team-section-toggle" applies a rotation
    And when I expand it again the rotation is removed

  Scenario: Keyboard toggle works
    Given the Agents section is expanded and its toggle button has focus
    When I activate the toggle button via keyboard (Enter/Space)
    Then the Agents section collapses
    And its toggle button has aria-expanded "false"

  Scenario: Independent state across sections
    When I collapse the Agents section
    And I collapse the Board section
    Then the Agents and Board sections are collapsed
    And the Workflow section is still expanded

  Scenario: State persists across tab re-activation
    Given the Workflow section is collapsed
    When I switch to another sub-tab and back to Team
    And initTeamTab runs again
    Then the Workflow section is still collapsed
    And its toggle button still has aria-expanded "false"

  Scenario: A collapsed section still refreshes its content
    Given the Agents section is collapsed
    When refreshTeamAgents runs and repopulates the Agents body
    Then no error is thrown
    And when I expand the Agents section the current agent content is shown

  # Failure / edge scenario
  Scenario: Action buttons in a header do not toggle the section
    Given the Agents section is expanded
    When I click the "Add agent" button inside the Agents header
    Then the Agents section does NOT collapse
    And the add-agent action is invoked instead

  # Failure / edge scenario
  Scenario: Clicking inside a section body never toggles a section
    Given the Board section is expanded and shows a column row with an "Up" button
    When I click a control inside the Board body
    Then no .team-section "collapsed" class is toggled
    And the body control performs its own action
```

## Edge & Failure Cases

- **Header action buttons must not toggle.** The delegated toggle handler must ignore
  clicks that land on the existing action buttons. All three action buttons carry the
  `small-btn` class (`teamAgentsAddBtn`, `teamAgentsRefresh`, `teamWorkflowRefresh`,
  `teamBoardSaveBtn`, `teamBoardRefresh`), so the handler should bail on
  `ev.target.closest('.small-btn')` — mirroring how `.git-section` delegation bails on
  `button, input, select, textarea, a`. (Do **not** blanket-ignore every `<button>`, or
  the toggle button itself would be ignored.)
- **Body-internal controls must not toggle.** Buttons/inputs inside `.team-section-body`
  (agent Edit/Save, board column Up/Down/Remove/Add-column form, workflow model editor,
  install banner) must be unaffected. Using `ev.target.closest('.team-section-header')`
  guarantees this: body clicks have no header ancestor and are ignored.
- **Refresh while collapsed.** A collapsed body is hidden with `display:none`, not
  detached; refreshers key off node identity (`tab.els.teamXBody !== body`), which
  `display:none` does not change — so refresh must still populate the hidden body without
  error and without visual flicker.
- **No-folder state.** With no folder open, `initTeamTab` sets each body to
  `(open a folder)`. Collapsing/expanding must still work (or at minimum not error).
  Collapsed state should persist across the folder→no-folder→folder transition since the
  `.team-section` elements are never rebuilt.
- **Idempotent re-activation.** `initTeamTab` is called repeatedly; it must not reset
  accordion state, add duplicate toggle listeners, or rebuild sections. Wire the
  delegated toggle listener **once** in the tab-build wiring block (alongside the
  existing team button listeners), not inside `initTeamTab`.
- **aria-expanded drift.** `aria-expanded` must be updated in the same code path as the
  class toggle so it never disagrees with the visible state.
- **Keyboard access.** The toggle must be a real focusable `<button type="button">` (not
  a bare `<span>`/`<div>`), so keyboard users can reach and operate it; the
  click-delegation path handles the resulting click.

## Relevant Files & Context

- `renderer/index.html` (Team view, lines ~706-736) — the `data-view="team"` panel and
  the three `.team-section` blocks. **Pattern to follow:** the Git panel's collapsible
  header markup at lines ~435-437 (`<div class="git-section-header"><span
  class="git-section-toggle" aria-hidden="true">▾</span><span
  class="git-section-title">…</span></div>`). Add a toggle control to each
  `.team-section-header` here (Agents ~713-717, Workflow ~721-724, Board ~728-732).
  Prefer a real `<button type="button" class="team-section-toggle"
  aria-expanded="true">▾</button>` (focusable + `aria-expanded`, combining the
  git-section chevron with the Archived-expander a11y). Keep the existing action buttons
  and the `margin-left:auto` layout intact. Do not ship the `collapsed` class (start
  expanded).
- `renderer/styles.css` — Team styles at lines ~3160-3192 (`.team-body`, `.team-section`,
  `.team-section-header`, `.team-section-title`, `.team-section-body`, and the
  `margin-left:auto` rules for the Refresh buttons at 3191-3192, plus `.teamBoardRefresh`
  at 3506). **Pattern to follow:** the Git collapsible CSS at lines ~1271-1299 — add
  `cursor:pointer`/`user-select:none`/hover to `.team-section-header`, a
  `.team-section-toggle` rule (mirror `.git-section-toggle`: inline-block, chevron color,
  `transition: transform 0.12s ease`), `.team-section.collapsed .team-section-toggle {
  transform: rotate(-90deg); }`, and `.team-section.collapsed .team-section-body {
  display: none; }`. Give `.team-section-toggle` unstyled-button resets
  (background/border/padding) so the `<button>` matches the existing chevron look.
- `renderer/renderer.js`:
  - els map, lines ~540-550 — where `.teamAgentsSection` / `.teamWorkflowSection` /
    `.teamBoardSection` / `*Body` are queried. Add
    `teamBody: ws.querySelector('.teamBody')` here to hang the delegated listener on.
  - Team listener wiring, lines ~589-602 — where the Add/Refresh/Save click listeners are
    bound once at tab-build time. **Pattern to follow:** the Git delegation at lines
    ~712-722 (`gitAuthedContent.addEventListener('click', …)` →
    `ev.target.closest('.git-section-header')`, bail on control clicks,
    `section.classList.toggle('collapsed')`). Add an analogous delegated `click` on
    `teamBody`: find `closest('.team-section-header')`, bail on
    `ev.target.closest('.small-btn')`, toggle `.collapsed` on the parent `.team-section`,
    and set the section's `.team-section-toggle` `aria-expanded` to the new state. **a11y
    pattern to mirror:** the Archived expander at lines ~9619-9629
    (`toggle.setAttribute('aria-expanded', String(open))`).
  - `initTeamTab`, lines ~6904-6924 — must **not** be modified to bind listeners or reset
    accordion state; it only sets body text / calls refreshers. Confirm it does not
    rebuild `.team-section` elements (it does not), which is what makes collapsed state
    persist.
  - Refreshers to leave functionally unchanged but verify against: `refreshTeamAgents`
    (~8279), `refreshTeamWorkflow` (~7127), `refreshTeamBoard` (~5676) — each has a
    node-identity stale-guard (`tab.els.teamXBody !== body`) that `display:none` does not
    disturb.
- `docs/team-tab.md` (lines ~19-23, "single scroll area with three stacked sections") —
  update wording to note the three sections are collapsible/accordion-style. This is the
  only doc that describes the Team layout.
- Test files — follow `test/task-091-team-tab-scaffold.e2e.test.js` and
  `test/task-091-team-tab-scaffold.test.js`. **Test convention (must follow):** runner is
  `node --test`; the `cucumber` npm package is NOT installed and must NOT be added; "e2e
  cucumber" scenarios are Given/When/Then-style `node:test` cases. `renderer/renderer.js`
  has no `module.exports`, so tests either (a) source-scan the browser files as text
  (`fs.readFileSync` of `renderer/renderer.js`, `index.html`, `styles.css`) with
  drift-guards, and/or (b) extract a function/handler body by brace-matching and run it
  against an in-memory mock DOM (`makeEl`-style classList mocks). Mock all I/O; no disk
  writes, Electron runtime, or network. Suggested new files:
  `test/task-144-team-accordion.e2e.test.js` and `test/task-144-team-accordion.test.js`.
- **Drift guard:** this change touches no `.claude/` or `assets/` instruction files, so
  the assets-mirror byte-identical requirement does not apply here — but the coder must
  not accidentally edit any file under `.claude/` or `assets/`.

## Clarifications

- **Q (accordion mode): opening a section closes the others (strict accordion), or each section toggles independently (multi-open)?**
  A: Independent (multi-open) — each section opens/closes on its own; any number may be open at once, mirroring the app's existing Git-panel collapsible sections. Opening one section never closes the others.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
