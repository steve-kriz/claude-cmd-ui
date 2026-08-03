'use strict';

// ===========================================================================
// TASK-091 — e2e "cucumber" scenarios (Given/When/Then), implemented as plain
// `node --test` cases. NO cucumber npm package is installed or required; these
// are scenario-style node:test cases in Given/When/Then form.
//
// Feature: A new "Team" sub-tab scaffold. It adds a tab button (data-tab="team")
// after Tasks, a hidden tab-view panel (data-view="team") with a .view-toolbar
// ("Team") and section containers, els-map entries, a switchSubTab branch
// routing "team" -> initTeamTab, and styles. initTeamTab shows
// "(open a folder)" with no folder and blanks the sections with a folder.
//
// TASK-203: the Team tab's Workflow section/panel was removed (phase system
// retired); the scaffold now hosts only the Agents and Board sections. Every
// Workflow-specific assertion below has been removed accordingly.
//
// NO DATABASE, DISK WRITE, ELECTRON RUNTIME, OR NETWORK CALL IS MADE. The
// browser files (renderer/renderer.js, index.html, styles.css) cannot be
// require()'d, so — matching the repo convention in
// test/task-030-plan-button.e2e.test.js — their wiring is proven by
// SOURCE-SCANNING those files as text. The activation + initTeamTab behaviour is
// ALSO exercised through pure replicas driven by the Gherkin scenarios, with
// drift-guards tying the replicas to the real source so they cannot silently
// diverge. All DOM/els are plain in-memory mock objects.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(REPO, 'renderer', 'index.html'), 'utf8');
const cssSrc = fs.readFileSync(path.join(REPO, 'renderer', 'styles.css'), 'utf8');

// Extract initTeamTab's OWN body from a renderer source. The end is anchored on
// the function's own column-0 closing brace (`\n}` — the 2-space-indented body
// never produces a column-0 `}` until the function ends), so a following rename
// or a new `const WF_*` / `async function` decl cannot widen the slice. BOTH the
// header index AND the end-boundary index are asserted found before slicing — we
// never `slice(start, -1)`, which on a not-found boundary would expand to nearly
// the whole file and silently turn the positive assertions into no-ops.
function extractInitTeamTabBody(src) {
  const fnStart = src.indexOf('function initTeamTab(tab)');
  assert.notEqual(fnStart, -1, 'initTeamTab header found in source');
  const braceEnd = src.indexOf('\n}', fnStart);
  assert.notEqual(braceEnd, -1, 'initTeamTab column-0 closing brace found in source');
  return src.slice(fnStart, braceEnd + 2);
}

// ---------------------------------------------------------------------------
// PURE REPLICAS (browser scripts are not requireable).
//
// Replica of switchSubTab's activation loops (renderer.js ~1222-1227): toggle
// `.active` on each button/view by comparing dataset against the target name.
// This drives the "only the team view is active" scenario with a mock DOM.
// ---------------------------------------------------------------------------
function makeEl(dataKey, dataVal) {
  const classes = new Set();
  return {
    dataset: { [dataKey]: dataVal },
    classList: {
      _s: classes,
      toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); }
    },
    get active() { return classes.has('active'); }
  };
}

function activateSubTab(btns, views, name) {
  for (const btn of btns) btn.classList.toggle('active', btn.dataset.tab === name);
  for (const view of views) view.classList.toggle('active', view.dataset.view === name);
}

// Replica of initTeamTab (renderer.js ~7208): with no folder, set the status +
// both section bodies to "(open a folder)" and return early; with a folder,
// blank ONLY the status and delegate the two section bodies to their refresh
// functions (they are NOT blanked). Uses a mock `tab.els` recording textContent.
const EMPTY = '(open a folder)';
function makeTeamEls() {
  return {
    teamStatus: { textContent: 'INIT' },
    teamAgentsBody: { textContent: 'INIT' },
    teamBoardBody: { textContent: 'INIT' }
  };
}
function initTeamTabReplica(tab) {
  if (!tab.folder) {
    tab.els.teamStatus.textContent = EMPTY;
    tab.els.teamAgentsBody.textContent = EMPTY;
    tab.els.teamBoardBody.textContent = EMPTY;
    return;
  }
  tab.els.teamStatus.textContent = '';
  // With a folder the two section bodies are DELEGATED to their refresh
  // functions (refreshTeamAgents/refreshTeamBoard) and are NOT blanked by
  // initTeamTab itself. Delegation is recorded on tab.delegated.
  tab.delegated = ['refreshTeamAgents', 'refreshTeamBoard'];
}

// The seven pre-existing sub-tab names + team, mirroring the tab bar order.
const TAB_NAMES = ['bash', 'files', 'slack', 'git', 'diff', 'tests', 'tasks', 'team'];

// ===========================================================================
// Scenario: The Team tab exists
//   Given the workspace template in renderer/index.html
//   Then a tab-btn with data-tab="team" appears after Tasks
//   And a tab-view with data-view="team" exists
// ===========================================================================
test('Scenario: the Team tab-btn appears after Tasks and a data-view="team" panel exists', () => {
  // Given the tab bar markup
  const tasksBtn = htmlSrc.indexOf('data-tab="tasks"');
  const teamBtn = htmlSrc.indexOf('data-tab="team"');
  // Then a tab-btn with data-tab="team" exists...
  assert.ok(teamBtn !== -1, 'a tab-btn with data-tab="team" exists');
  assert.match(
    htmlSrc.slice(htmlSrc.lastIndexOf('<button', teamBtn), teamBtn + 40),
    /class="tab-btn"\s+data-tab="team"/,
    'the Team button uses the shared tab-btn class'
  );
  // ...and it carries the visible label "Team"
  assert.match(
    htmlSrc.slice(teamBtn, htmlSrc.indexOf('</button>', teamBtn) + 9),
    />Team<\/button>/,
    'the Team button is labelled "Team"'
  );
  // And it appears AFTER the Tasks button
  assert.ok(tasksBtn !== -1 && teamBtn > tasksBtn, 'Team button comes after the Tasks button');
  // And a tab-view with data-view="team" exists
  assert.ok(htmlSrc.includes('data-view="team"'), 'a tab-view with data-view="team" exists');
  assert.match(
    htmlSrc.slice(htmlSrc.indexOf('data-view="team"') - 40, htmlSrc.indexOf('data-view="team"')),
    /class="tab-view"/,
    'the Team panel uses the shared tab-view class'
  );
});

// ===========================================================================
// Scenario: The Team panel hosts a toolbar + the Agents and Board sections
//   AC (TASK-203): only the Agents and Board sections remain (Workflow gone).
// ===========================================================================
test('Scenario: the Team panel has a "Team" .view-toolbar and only the Agents + Board sections, with headings', () => {
  // Given the Team tab-view region only (bounded so we assert against IT).
  // The Team panel is the LAST tab-view in the workspace <template>, so bound the
  // slice at that template's close instead of a fixed +1800 window; this covers
  // the whole panel (incl. the Board Save/Refresh header buttons TASK-103 added)
  // and stops before the separate #workspaceTabTpl (whose ws-tab-close button
  // would otherwise inflate the header-button count). Assert the anchor is found.
  const vStart = htmlSrc.indexOf('data-view="team"');
  const vClose = htmlSrc.indexOf('</template>', vStart);
  assert.notEqual(vClose, -1, 'the workspace <template> close bounds the Team panel');
  const panel = htmlSrc.slice(vStart, vClose);
  // Then it has a .view-toolbar whose title reads "Team"
  assert.match(panel, /class="view-toolbar"/, 'the Team panel has a .view-toolbar');
  assert.match(panel, /Team<\/span>/, 'the toolbar shows the "Team" title');
  // And the two surviving section containers exist with stable class hooks
  assert.match(panel, /class="teamAgentsSection[^"]*"/, '.teamAgentsSection exists');
  assert.match(panel, /class="teamBoardSection[^"]*"/, '.teamBoardSection exists');
  // And the Workflow section is gone entirely (TASK-203)
  assert.ok(!/teamWorkflowSection/.test(panel), '.teamWorkflowSection no longer exists');
  assert.ok(!/teamWorkflowBody/.test(panel), '.teamWorkflowBody no longer exists');
  // And each surviving section has a visible heading
  assert.match(panel, />Agents<\/span>/, 'Agents section heading is visible');
  assert.match(panel, />Board<\/span>/, 'Board section heading is visible');
  // And each surviving section ships an "(open a folder)" empty-state body
  assert.match(panel, /class="teamAgentsBody[^"]*">\(open a folder\)/, 'Agents body empty state');
  assert.match(panel, /class="teamBoardBody[^"]*">\(open a folder\)/, 'Board body empty state');
});

// ===========================================================================
// Scenario: The data-view="team" panel defaults to hidden (edge)
//   Edge: the panel must NOT ship with the `active` class.
// ===========================================================================
test('Scenario (edge): the Team panel ships hidden — its tab-view has no "active" class', () => {
  // Given the Team panel's opening tag
  const idx = htmlSrc.indexOf('data-view="team"');
  const openTag = htmlSrc.slice(htmlSrc.lastIndexOf('<div', idx), idx + 20);
  // Then it is class="tab-view" WITHOUT active (only data-view="bash" is active by default)
  assert.match(openTag, /class="tab-view"/, 'Team panel is a tab-view');
  assert.ok(!/tab-view active/.test(openTag), 'Team panel does not ship with the active class');
  // And the Team tab BUTTON is likewise not active by default
  const btnIdx = htmlSrc.indexOf('data-tab="team"');
  const btnTag = htmlSrc.slice(htmlSrc.lastIndexOf('<button', btnIdx), btnIdx + 20);
  assert.ok(!/tab-btn active/.test(btnTag), 'Team button does not ship active');
});

// ===========================================================================
// Scenario: els + switchSubTab routing
//   AC: els map gains Team selectors; switchSubTab routes "team" to initTeamTab;
//   existing branches + stopTasksPolling guard untouched.
// ===========================================================================
test('Scenario: renderer registers Team els and switchSubTab routes "team" -> initTeamTab', () => {
  // Then the per-tab els map registers the Team panel elements
  assert.match(rendererSrc, /teamView:\s*ws\.querySelector\('\.tab-view\[data-view="team"\]'\)/, 'els.teamView registered');
  assert.match(rendererSrc, /teamStatus:\s*ws\.querySelector\('\.teamStatus'\)/, 'els.teamStatus registered');
  assert.match(rendererSrc, /teamAgentsSection:\s*ws\.querySelector\('\.teamAgentsSection'\)/, 'els.teamAgentsSection registered');
  assert.match(rendererSrc, /teamBoardSection:\s*ws\.querySelector\('\.teamBoardSection'\)/, 'els.teamBoardSection registered');
  assert.match(rendererSrc, /teamAgentsBody:\s*ws\.querySelector\('\.teamAgentsBody'\)/, 'els.teamAgentsBody registered');
  assert.match(rendererSrc, /teamBoardBody:\s*ws\.querySelector\('\.teamBoardBody'\)/, 'els.teamBoardBody registered');
  // And the Workflow els bindings are gone (TASK-203)
  assert.ok(!/teamWorkflowSection:\s*ws\.querySelector/.test(rendererSrc), 'els.teamWorkflowSection removed');
  assert.ok(!/teamWorkflowBody:\s*ws\.querySelector/.test(rendererSrc), 'els.teamWorkflowBody removed');
  // And switchSubTab gains the team branch calling initTeamTab
  const sw = rendererSrc.slice(rendererSrc.indexOf('function switchSubTab(tab, name)'),
    rendererSrc.indexOf('// ─────', rendererSrc.indexOf('function switchSubTab(tab, name)') + 1));
  assert.match(sw, /else if \(name === 'team'\) \{\s*initTeamTab\(tab\);/, 'team branch routes to initTeamTab');
  // And the existing branches are untouched (all seven still routed)
  assert.match(sw, /if \(name === 'bash'\)/);
  assert.match(sw, /else if \(name === 'files'\)/);
  assert.match(sw, /else if \(name === 'slack'\) \{\s*initSlackTab\(tab\);/);
  assert.match(sw, /else if \(name === 'git'\)/);
  assert.match(sw, /else if \(name === 'diff'\)/);
  assert.match(sw, /else if \(name === 'tests'\)/);
  assert.match(sw, /else if \(name === 'tasks'\) \{\s*initTasksTab\(tab\);/);
  // And the stopTasksPolling guard is untouched (stops polling for any non-tasks tab, incl. team)
  assert.match(sw, /if \(name !== 'tasks'\) stopTasksPolling\(tab\);/, 'stopTasksPolling guard preserved');
});

// ===========================================================================
// Scenario: Activating the Team tab
//   Given a workspace with an open folder
//   When the user clicks the Team tab
//   Then switchSubTab routes "team" to initTeamTab and ONLY the team view is active
// ===========================================================================
test('Scenario: activating the Team tab makes only the team button/view active (via the shared loops)', () => {
  // Given a mock tab bar of all eight sub-tabs, starting with bash active
  const btns = TAB_NAMES.map((n) => makeEl('tab', n));
  const views = TAB_NAMES.map((n) => makeEl('view', n));
  activateSubTab(btns, views, 'bash');
  assert.ok(btns[0].active && views[0].active, 'precondition: bash active');
  // When the user clicks the Team tab (dispatches switchSubTab -> activation loops)
  activateSubTab(btns, views, 'team');
  // Then exactly one button and one view are active, and they are the team ones
  const activeBtns = btns.filter((b) => b.active);
  const activeViews = views.filter((v) => v.active);
  assert.equal(activeBtns.length, 1, 'exactly one active button');
  assert.equal(activeViews.length, 1, 'exactly one active view');
  assert.equal(activeBtns[0].dataset.tab, 'team', 'the Team button is the active one');
  assert.equal(activeViews[0].dataset.view, 'team', 'the Team view is the active one');
  // And the previously-active bash tab is no longer active
  assert.ok(!btns[0].active && !views[0].active, 'bash deactivated by the shared loop');
});

// ===========================================================================
// Scenario: Team tab with an open folder shows the two (blank) sections
//   AC: with a folder, initTeamTab blanks the status + delegates the two
//   section bodies.
// ===========================================================================
test('Scenario: activating Team with an open folder blanks status and delegates the two sections to their refresh functions', () => {
  // Given a workspace with an open folder
  const tab = { folder: '/proj', els: makeTeamEls() };
  // When the Team tab is activated
  initTeamTabReplica(tab);
  // Then the status is blanked, and the two section bodies are NOT blanked —
  // each is delegated to its refresh function (refreshTeamAgents/
  // refreshTeamBoard), which owns and renders its own body.
  assert.equal(tab.els.teamStatus.textContent, '', 'status cleared when a folder is open');
  assert.deepEqual(tab.delegated,
    ['refreshTeamAgents', 'refreshTeamBoard'], 'bodies delegated to their refresh fns');
  // makeTeamEls seeds 'INIT'; delegation leaves the bodies untouched by initTeamTab.
  assert.equal(tab.els.teamAgentsBody.textContent, 'INIT', 'Agents body NOT blanked by initTeamTab');
  assert.equal(tab.els.teamBoardBody.textContent, 'INIT', 'Board body NOT blanked by initTeamTab');
});

// ===========================================================================
// Scenario: No folder open (edge)
//   Given a workspace with no folder open
//   When the Team tab is activated
//   Then "(open a folder)" is shown and no Team controls are enabled
// ===========================================================================
test('Scenario (edge): activating Team with NO folder shows "(open a folder)" everywhere', () => {
  // Given a workspace with no folder open
  const tab = { folder: null, els: makeTeamEls() };
  // When the Team tab is activated
  initTeamTabReplica(tab);
  // Then "(open a folder)" is shown in the status and every section body
  assert.equal(tab.els.teamStatus.textContent, EMPTY, 'status shows the empty state');
  assert.equal(tab.els.teamAgentsBody.textContent, EMPTY, 'Agents shows the empty state');
  assert.equal(tab.els.teamBoardBody.textContent, EMPTY, 'Board shows the empty state');
  // And with no folder no per-agent controls render — the interactive controls the
  // static scaffold ships are the Agents "Add agent" (TASK-095) and "Refresh"
  // (TASK-094) buttons in the section header. The agent cards / install hint are
  // rendered by refreshTeamAgents ONLY with a folder, so with no folder the Agents
  // body still shows the "(open a folder)" empty state.
  const vStart = htmlSrc.indexOf('data-view="team"');
  const vClose = htmlSrc.indexOf('</template>', vStart);
  assert.notEqual(vClose, -1, 'the workspace <template> close bounds the Team panel');
  const panel = htmlSrc.slice(vStart, vClose);
  assert.match(panel, /class="teamAgentsBody[^"]*">\(open a folder\)/, 'Agents body ships the empty state (no cards without a folder)');
  const buttons = panel.match(/<button[^>]*>/g) || [];
  // TASK-095 added the Agents "Add agent" button; TASK-103 added the Board panel's
  // "Save" and "Refresh" header controls; TASK-144 added a per-section accordion
  // toggle button (".team-section-toggle") to EACH "team-section-header" block.
  // TASK-203 removed the Workflow section entirely (and its "Refresh" control with
  // it), so the scaffold now ships exactly SIX header buttons: Agents Add +
  // Refresh, Board Save + Refresh, and the two remaining accordion toggles.
  assert.equal(buttons.length, 6, 'the scaffold ships exactly six header buttons (Agents Add/Refresh + Board Save/Refresh + 2 accordion toggles)');
  assert.ok(buttons.some((b) => /class="teamAgentsAddBtn/.test(b)), 'ships the Agents "Add agent" control (TASK-095)');
  assert.ok(buttons.some((b) => /class="teamAgentsRefresh/.test(b)), 'ships the Agents "Refresh" control (TASK-094)');
  assert.ok(buttons.some((b) => /class="teamBoardSaveBtn/.test(b)), 'ships the Board "Save" control (TASK-103)');
  assert.ok(buttons.some((b) => /class="teamBoardRefresh/.test(b)), 'ships the Board "Refresh" control (TASK-103)');
  assert.ok(!buttons.some((b) => /class="teamWorkflowRefresh/.test(b)), 'the Workflow "Refresh" control no longer exists (TASK-203)');
  // TASK-144: exactly 2 accordion toggle buttons ship now (one per surviving
  // section), each expanded by default (aria-expanded="true") and typed to
  // avoid form-submit side effects (type="button").
  const toggleButtons = buttons.filter((b) => /class="team-section-toggle"/.test(b));
  assert.equal(toggleButtons.length, 2, 'ships exactly 2 accordion toggle buttons, one per surviving section (TASK-144/203)');
  assert.ok(toggleButtons.every((b) => /type="button"/.test(b)), 'each accordion toggle is type="button" (TASK-144)');
  assert.ok(toggleButtons.every((b) => /aria-expanded="true"/.test(b)), 'each accordion toggle starts expanded (TASK-144)');
  // The Add-agent FORM lives in a separate #addAgentModal (not this panel), so the
  // Team panel itself still ships no inline inputs/selects.
  assert.ok(!/<input/.test(panel) && !/<select/.test(panel), 'the Team panel ships no inline inputs/selects');
});

// ===========================================================================
// Scenario (edge): Re-activating the Team tab must not double-bind listeners
//   Edge: initTeamTab follows initTasksTab pattern — idempotent, binds nothing
//   per-activation. Re-running it just resets text; no addEventListener inside.
// ===========================================================================
test('Scenario (edge): re-activating the Team tab is idempotent and binds no per-activation listeners', () => {
  // Given the Team tab was already activated once with no folder
  const tab = { folder: null, els: makeTeamEls() };
  initTeamTabReplica(tab);
  const first = { ...tab.els.teamAgentsBody };
  // When it is activated a second time
  initTeamTabReplica(tab);
  // Then the result is identical (no accumulation / double state)
  assert.equal(tab.els.teamAgentsBody.textContent, first.textContent, 're-activation is idempotent');
  // And the real initTeamTab body binds NO event listeners ITSELF — re-activation
  // is idempotent (mirrors initTasksTab). Per-agent listeners live in the
  // buildAgentCard/buildAgentsInstallHint helpers that refreshTeamAgents calls
  // (TASK-094), NOT in initTeamTab, so scope the guard to initTeamTab's own body
  // (bounded by the function's own closing brace via the shared helper).
  const fn = extractInitTeamTabBody(rendererSrc);
  assert.ok(!/addEventListener/.test(fn), 'initTeamTab itself binds no listeners (no double-bind on re-activation)');
});

// ===========================================================================
// Scenario: Styles added following the existing conventions
//   AC: Team styles appended to styles.css; no existing selectors modified.
// ===========================================================================
test('Scenario: Team styles are appended following the .view-toolbar/.git-section conventions', () => {
  // Then a Team style block exists with the section hooks styled
  assert.match(cssSrc, /\.team-section \{/, '.team-section rule exists');
  assert.match(cssSrc, /\.team-section-header \{/, '.team-section-header rule exists');
  assert.match(cssSrc, /\.team-section-body \{/, '.team-section-body rule exists');
  assert.match(cssSrc, /\.team-status \{/, '.team-status rule exists');
  assert.match(cssSrc, /\.team-body \{/, '.team-body rule exists');
});

// ===========================================================================
// DRIFT GUARD: tie the initTeamTab replica to the real source so the behavioural
// scenarios above cannot silently diverge from shipped code.
// ===========================================================================
test('DRIFT GUARD: the real initTeamTab guards on tab.folder, uses the "(open a folder)" literal, and blanks with a folder', () => {
  const fn = extractInitTeamTabBody(rendererSrc);
  // TASK-203: no Workflow reference remains anywhere in initTeamTab.
  assert.ok(!/teamWorkflow/.test(fn), 'no teamWorkflow* reference remains in initTeamTab');
  // Guards on an open folder and returns early for the empty state.
  assert.match(fn, /if \(!tab\.folder\) \{/, 'guards on tab.folder');
  assert.match(fn, /return;/, 'returns early in the no-folder branch');
  // No-folder branch sets the "(open a folder)" literal on status + both bodies.
  const noFolder = fn.slice(fn.indexOf('if (!tab.folder) {'), fn.indexOf('return;'));
  assert.match(noFolder, /tab\.els\.teamStatus\.textContent = '\(open a folder\)'/, 'status -> (open a folder)');
  assert.match(noFolder, /tab\.els\.teamAgentsBody\.textContent = '\(open a folder\)'/, 'agents -> (open a folder)');
  assert.match(noFolder, /tab\.els\.teamBoardBody\.textContent = '\(open a folder\)'/, 'board -> (open a folder)');
  // With-folder branch blanks ONLY the status; it DELEGATES the Agents body to
  // refreshTeamAgents(tab) (TASK-094) and the Board body to refreshTeamBoard(tab)
  // (TASK-103) instead of blanking either.
  const withFolder = fn.slice(fn.indexOf('return;'));
  assert.match(withFolder, /tab\.els\.teamStatus\.textContent = ''/, 'status blanked with a folder');
  assert.match(withFolder, /refreshTeamAgents\(tab\)/, 'agents body delegated to refreshTeamAgents with a folder (TASK-094)');
  assert.match(withFolder, /refreshTeamBoard\(tab\)/, 'board body delegated to refreshTeamBoard with a folder (TASK-103)');
  assert.ok(!/tab\.els\.teamAgentsBody\.textContent = ''/.test(withFolder), 'agents body NOT blanked — refreshTeamAgents owns it');
  assert.ok(!/tab\.els\.teamBoardBody\.textContent = ''/.test(withFolder), 'board body NOT blanked — refreshTeamBoard owns it (TASK-103)');
  // And the replica's literal matches the shipped one.
  assert.equal(EMPTY, '(open a folder)');
});
