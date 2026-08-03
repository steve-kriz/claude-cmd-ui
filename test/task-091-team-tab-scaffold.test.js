'use strict';

// ===========================================================================
// TASK-091 — UNIT tests for the Team sub-tab scaffold's behaviour + structural
// guarantees.
//
// initTeamTab and switchSubTab are browser scripts and cannot be require()'d,
// so their PURE cores are unit-tested here via faithful replicas, each
// DRIFT-GUARDED against the shipped renderer.js source so the replica cannot
// diverge. Structural guarantees of the scaffold (els selectors, section hooks)
// are asserted by source-scanning the renderer files as text.
//
// TASK-203: the Team tab's Workflow section/panel was removed (phase system
// retired). The scaffold now hosts only the Agents and Board sections; every
// Workflow-specific assertion below has been removed accordingly.
//
// NO DATABASE, DISK WRITE, ELECTRON RUNTIME, OR NETWORK. Every `tab`/`els`/DOM
// object is a plain in-memory mock; every dependency is a pure function.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');

// ── Unit under test: initTeamTab core (renderer.js ~7208) ───────────────────
const EMPTY = '(open a folder)';

function makeTeamEls() {
  return {
    teamStatus: { textContent: null },
    teamAgentsBody: { textContent: null },
    teamBoardBody: { textContent: null }
  };
}

// Faithful replica of initTeamTab: no folder -> set "(open a folder)" on status +
// both bodies and return; folder -> blank ONLY the status and DELEGATE the two
// section bodies to their refresh functions (Agents->refreshTeamAgents TASK-094,
// Board->refreshTeamBoard TASK-103). initTeamTab does NOT blank the two bodies
// with a folder — each refresh owns and renders its own body. Delegation is
// recorded on tab.delegated.
function initTeamTab(tab) {
  if (!tab.folder) {
    tab.els.teamStatus.textContent = EMPTY;
    tab.els.teamAgentsBody.textContent = EMPTY;
    tab.els.teamBoardBody.textContent = EMPTY;
    return;
  }
  tab.els.teamStatus.textContent = '';
  tab.delegated = ['refreshTeamAgents', 'refreshTeamBoard'];
}

// Replica of switchSubTab's routing dispatch (renderer.js ~1220): returns the
// name of the handler that would run for a given sub-tab name.
function routeSubTab(name) {
  if (name === 'bash') return 'fit';
  if (name === 'files') return 'renderFiles';
  if (name === 'slack') return 'initSlackTab';
  if (name === 'git') return 'checkGitAuthAndGate';
  if (name === 'diff') return 'refreshDiff';
  if (name === 'tests') return 'refreshTests';
  if (name === 'tasks') return 'initTasksTab';
  if (name === 'team') return 'initTeamTab';
  return null;
}

// ── initTeamTab: no folder ──────────────────────────────────────────────────

test('initTeamTab: with no folder sets "(open a folder)" on status + both bodies', () => {
  const tab = { folder: null, els: makeTeamEls() };
  initTeamTab(tab);
  assert.equal(tab.els.teamStatus.textContent, EMPTY);
  assert.equal(tab.els.teamAgentsBody.textContent, EMPTY);
  assert.equal(tab.els.teamBoardBody.textContent, EMPTY);
});

test('initTeamTab: undefined folder is treated as no folder (empty state)', () => {
  const tab = { folder: undefined, els: makeTeamEls() };
  initTeamTab(tab);
  assert.equal(tab.els.teamAgentsBody.textContent, EMPTY);
});

test('initTeamTab: empty-string folder is treated as no folder (empty state)', () => {
  const tab = { folder: '', els: makeTeamEls() };
  initTeamTab(tab);
  assert.equal(tab.els.teamBoardBody.textContent, EMPTY);
});

// ── initTeamTab: with a folder ──────────────────────────────────────────────

test('initTeamTab: with a folder blanks status and delegates both section bodies to their refresh functions', () => {
  const tab = { folder: '/home/proj', els: makeTeamEls() };
  // Seed sentinels so we can prove the bodies are NOT blanked by initTeamTab.
  tab.els.teamAgentsBody.textContent = 'SENTINEL';
  tab.els.teamBoardBody.textContent = 'SENTINEL';
  initTeamTab(tab);
  assert.equal(tab.els.teamStatus.textContent, '', 'status blanked with a folder');
  // The two bodies are delegated (refreshTeamAgents/refreshTeamBoard own them)
  // and left untouched by initTeamTab itself.
  assert.deepEqual(tab.delegated,
    ['refreshTeamAgents', 'refreshTeamBoard'], 'bodies delegated to their refresh fns');
  assert.equal(tab.els.teamAgentsBody.textContent, 'SENTINEL', 'Agents body NOT blanked by initTeamTab');
  assert.equal(tab.els.teamBoardBody.textContent, 'SENTINEL', 'Board body NOT blanked by initTeamTab');
});

// ── initTeamTab: idempotent (no double-bind on re-activation) ────────────────

test('initTeamTab: re-running with no folder is idempotent', () => {
  const tab = { folder: null, els: makeTeamEls() };
  initTeamTab(tab);
  initTeamTab(tab);
  initTeamTab(tab);
  assert.equal(tab.els.teamStatus.textContent, EMPTY);
  assert.equal(tab.els.teamAgentsBody.textContent, EMPTY);
});

test('initTeamTab: switching folder->no-folder->folder produces the correct final state', () => {
  const tab = { folder: '/proj', els: makeTeamEls() };
  initTeamTab(tab);
  assert.deepEqual(tab.delegated,
    ['refreshTeamAgents', 'refreshTeamBoard'], 'folder: bodies delegated');
  tab.folder = null;
  initTeamTab(tab);
  assert.equal(tab.els.teamAgentsBody.textContent, EMPTY, 'no folder: empty state');
  tab.folder = '/proj';
  initTeamTab(tab);
  assert.deepEqual(tab.delegated,
    ['refreshTeamAgents', 'refreshTeamBoard'], 'folder again: bodies delegated');
});

// ── switchSubTab routing ────────────────────────────────────────────────────

test('routeSubTab: "team" routes to initTeamTab', () => {
  assert.equal(routeSubTab('team'), 'initTeamTab');
});

test('routeSubTab: the seven existing branches are unchanged', () => {
  assert.equal(routeSubTab('bash'), 'fit');
  assert.equal(routeSubTab('files'), 'renderFiles');
  assert.equal(routeSubTab('slack'), 'initSlackTab');
  assert.equal(routeSubTab('git'), 'checkGitAuthAndGate');
  assert.equal(routeSubTab('diff'), 'refreshDiff');
  assert.equal(routeSubTab('tests'), 'refreshTests');
  assert.equal(routeSubTab('tasks'), 'initTasksTab');
});

// ── Structural guarantees (source-scan) ─────────────────────────────────────

test('scaffold: els map registers the six surviving Team selectors', () => {
  for (const sel of [
    'teamView', 'teamStatus', 'teamBody',
    'teamAgentsSection', 'teamAgentsBody',
    'teamBoardSection', 'teamBoardBody'
  ]) {
    assert.ok(new RegExp(sel + ':\\s*ws\\.querySelector').test(rendererSrc), `els.${sel} registered`);
  }
});

test('scaffold: no teamWorkflow* els binding remains (TASK-203)', () => {
  assert.ok(!/teamWorkflowSection:\s*ws\.querySelector/.test(rendererSrc), 'els.teamWorkflowSection removed');
  assert.ok(!/teamWorkflowBody:\s*ws\.querySelector/.test(rendererSrc), 'els.teamWorkflowBody removed');
});

test('scaffold: initTeamTab exists and is wired into switchSubTab', () => {
  assert.match(rendererSrc, /function initTeamTab\(tab\)/, 'initTeamTab defined');
  assert.match(rendererSrc, /else if \(name === 'team'\) \{\s*initTeamTab\(tab\);/, 'team branch calls initTeamTab');
});

// ── DRIFT GUARD ─────────────────────────────────────────────────────────────
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

// The drift-guard assertions, factored out so the failure-path meta-check below
// can prove they STILL catch a real regression when run against a doctored body.
function assertInitTeamTabGuard(fn) {
  assert.match(fn, /if \(!tab\.folder\) \{/, 'guards on tab.folder');
  // No-folder branch sets the "(open a folder)" literal on all three fields.
  for (const field of ['teamStatus', 'teamAgentsBody', 'teamBoardBody']) {
    assert.ok(
      new RegExp(`tab\\.els\\.${field}\\.textContent = '\\(open a folder\\)'`).test(fn),
      `${field} set to "(open a folder)" in the no-folder branch`
    );
  }
  // With-folder branch blanks ONLY the status; it DELEGATES the Agents body to
  // refreshTeamAgents(tab) (TASK-094) and the Board body to refreshTeamBoard(tab)
  // (TASK-103) instead of blanking either.
  assert.ok(
    /tab\.els\.teamStatus\.textContent = ''/.test(fn),
    'teamStatus blanked in the with-folder branch'
  );
  assert.match(fn, /refreshTeamAgents\(tab\)/, 'with a folder, the Agents body is delegated to refreshTeamAgents (TASK-094)');
  assert.match(fn, /refreshTeamBoard\(tab\)/, 'with a folder, the Board body is delegated to refreshTeamBoard (TASK-103)');
  assert.ok(
    !/tab\.els\.teamAgentsBody\.textContent = ''/.test(fn),
    'the Agents body is NOT blanked with a folder — refreshTeamAgents owns it'
  );
  assert.ok(
    !/tab\.els\.teamBoardBody\.textContent = ''/.test(fn),
    'the Board body is NOT blanked with a folder — refreshTeamBoard owns it (TASK-103)'
  );
  // TASK-203: the Workflow panel/refresh no longer exists anywhere in initTeamTab.
  assert.ok(!/teamWorkflow/.test(fn), 'no teamWorkflow* reference remains in initTeamTab');
  assert.ok(!/refreshTeamWorkflow/.test(fn), 'refreshTeamWorkflow is not called from initTeamTab');
}

test('DRIFT GUARD: the real initTeamTab matches the replica (folder guard, literal, three fields)', () => {
  const fn = extractInitTeamTabBody(rendererSrc);
  // The tightly-bounded slice covers the whole body but stops at the function's
  // closing brace.
  assertInitTeamTabGuard(fn);
  assert.equal(EMPTY, '(open a folder)', 'replica literal matches the shipped literal');
});

test('DRIFT GUARD (meta): the hardened guard still catches a real regression in initTeamTab', () => {
  // Doctor ONLY within initTeamTab's own body (refreshTeamBoard is also called
  // elsewhere in the renderer, so anchor the edit at the function's header).
  const fnStart = rendererSrc.indexOf('function initTeamTab(tab)');
  const doctor = (from, to) =>
    rendererSrc.slice(0, fnStart) + rendererSrc.slice(fnStart).replace(from, to);
  // Removing initTeamTab's refreshTeamBoard(tab) delegation must be DETECTED.
  const noBoard = doctor('refreshTeamBoard(tab);', 'refreshTeamBoardXXX(tab);');
  assert.notEqual(noBoard, rendererSrc, 'precondition: doctoring removed the refreshTeamBoard delegation');
  assert.throws(
    () => assertInitTeamTabGuard(extractInitTeamTabBody(noBoard)),
    'the guard fires when refreshTeamBoard(tab) is missing from initTeamTab'
  );
  // Changing the no-folder empty-state literal must also be DETECTED.
  const badLiteral = doctor(
    "tab.els.teamBoardBody.textContent = '(open a folder)';",
    "tab.els.teamBoardBody.textContent = '(no folder)';"
  );
  assert.notEqual(badLiteral, rendererSrc, 'precondition: doctoring changed the no-folder literal');
  assert.throws(
    () => assertInitTeamTabGuard(extractInitTeamTabBody(badLiteral)),
    'the guard fires when the no-folder literal changes'
  );
});
