'use strict';

// ===========================================================================
// TASK-203 — UNIT tests for the Workflow panel removal + phase-link machinery
// deletion, driven against the REAL renderer/renderer.js source.
//
// Covers the ticket's acceptance criteria at the function level:
//   - refreshTeamWorkflow, buildWorkflowView, buildWorkflowInstallHint,
//     buildWorkflowPhase and every WF_PHASE_*/wf* phase helper are gone.
//   - The phase-link helpers (tasksApplyPhaseAutoEnable, tasksPhaseLinkCounts,
//     tasksNormalizeColumnPhase, TASKS_PHASE_KEYS, TASKS_PHASE_ENABLED_DEFAULTS)
//     are gone; refreshTeamBoard no longer computes baselinePhaseLinks;
//     saveTeamBoardConfig no longer calls any phase auto-enable helper.
//   - tasksBuildColumn / normalizeTasksColumns / tasksSerializeTeamConfig never
//     produce or read a `phase` field on a column, even when fed one.
//   - buildWorkflowConcurrencyControl / buildWorkflowContextOptimizationControl
//     are KEPT (not collateral damage) and are the Board panel's only mount
//     point (renderTeamBoard is their sole call site).
//   - No els binding / event wiring for teamWorkflowBody / teamWorkflowRefresh /
//     a Workflow section toggle remains.
//
// renderer.js is a browser script (no module.exports), so the pure functions
// under test are EXTRACTED by brace-matching / regex from the shipped source
// and evaluated in a sandbox — this proves the ACTUAL shipped code, not a
// hand-written replica (the test-103/test-091 convention).
//
// NO DATABASE, DISK, ELECTRON, OR NETWORK: every function exercised here is
// pure; nothing touches window.api.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(REPO, 'renderer', 'index.html'), 'utf8');

function extractFn(src, name) {
  let start = src.indexOf('function ' + name + '(');
  assert.ok(start !== -1, `function ${name} found in renderer.js`);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) { i += 1; break; } }
  }
  return src.slice(start, i);
}
function extractConst(src, name) {
  const m = src.match(new RegExp('const\\s+' + name + '\\s*=[\\s\\S]*?;'));
  assert.ok(m, `const ${name} found in renderer.js`);
  return m[0];
}

// ---------------------------------------------------------------------------
// AC: the phase-render pipeline and its helpers are removed entirely.
// ---------------------------------------------------------------------------
test('AC: refreshTeamWorkflow, buildWorkflowView, buildWorkflowInstallHint, buildWorkflowPhase are removed', () => {
  for (const fn of ['refreshTeamWorkflow', 'buildWorkflowView', 'buildWorkflowInstallHint', 'buildWorkflowPhase']) {
    assert.equal(rendererSrc.indexOf('function ' + fn + '('), -1, `function ${fn} does not exist in renderer.js`);
  }
});

test('AC: every WF_PHASE_*/wfNormalizePhaseConfig/wfSortedPhaseKeys/wfPhaseOrderWarnings helper is removed', () => {
  for (const sym of [
    'WF_PHASE_SPECS', 'WF_PHASE_DEFAULTS', 'WF_PHASE_KEYS',
    'wfNormalizePhaseConfig', 'wfSortedPhaseKeys', 'wfPhaseOrderWarnings',
  ]) {
    assert.equal(rendererSrc.includes(sym), false, `renderer.js has no reference to ${sym}`);
  }
});

// ---------------------------------------------------------------------------
// AC: the column<->phase link machinery is removed entirely.
// ---------------------------------------------------------------------------
test('AC: tasksApplyPhaseAutoEnable, tasksPhaseLinkCounts, tasksNormalizeColumnPhase, TASKS_PHASE_KEYS, TASKS_PHASE_ENABLED_DEFAULTS are removed', () => {
  for (const sym of [
    'tasksApplyPhaseAutoEnable', 'tasksPhaseLinkCounts', 'tasksNormalizeColumnPhase',
    'TASKS_PHASE_KEYS', 'TASKS_PHASE_ENABLED_DEFAULTS',
  ]) {
    assert.equal(rendererSrc.includes(sym), false, `renderer.js has no reference to ${sym}`);
  }
});

test('AC: refreshTeamBoard no longer computes baselinePhaseLinks', () => {
  assert.equal(rendererSrc.includes('baselinePhaseLinks'), false, 'renderer.js has no reference to baselinePhaseLinks');
  const fn = extractFn(rendererSrc, 'refreshTeamBoard');
  assert.equal(fn.includes('baselinePhaseLinks'), false, 'refreshTeamBoard itself does not compute baselinePhaseLinks');
});

test('AC: saveTeamBoardConfig no longer calls tasksApplyPhaseAutoEnable (or anything phase-related)', () => {
  const fn = extractFn(rendererSrc, 'saveTeamBoardConfig');
  assert.equal(fn.includes('tasksApplyPhaseAutoEnable'), false, 'saveTeamBoardConfig does not call tasksApplyPhaseAutoEnable');
  assert.equal(/phase/i.test(fn), false, 'saveTeamBoardConfig has no phase-related code at all');
});

// ---------------------------------------------------------------------------
// AC: no remaining code path reads a column `phase` field or `skill.phases`.
// tasksBuildColumn / normalizeTasksColumns / tasksSerializeTeamConfig are
// exercised directly (pure functions) with a `phase` key deliberately present
// on the input, proving it is never read into, or re-emitted from, the model.
// ---------------------------------------------------------------------------
function loadColumnHelpers() {
  const body = [
    extractConst(rendererSrc, 'TASKS_LANE_STATUSES'),
    extractConst(rendererSrc, 'TASKS_VALID_STATUSES'),
    extractConst(rendererSrc, 'TASKS_UNKNOWN_STATUS'),
    extractConst(rendererSrc, 'TASKS_SYSTEM_LABELS'),
    extractConst(rendererSrc, 'TASKS_RESERVED_SLUGS'),
    extractConst(rendererSrc, 'TASKS_MAX_SLUG_LENGTH'),
    extractConst(rendererSrc, 'TASKS_SLUG_RE'),
    extractConst(rendererSrc, 'TASKS_MAX_CONCURRENCY'),
    extractConst(rendererSrc, 'TASKS_DEFAULT_CONCURRENCY'),
    extractFn(rendererSrc, 'resolveTasksConcurrency'),
    extractFn(rendererSrc, 'tasksPrettifyLabel'),
    extractFn(rendererSrc, 'tasksBuildColumn'),
    extractFn(rendererSrc, 'normalizeTasksColumns'),
    extractConst(rendererSrc, 'TASKS_CONTEXT_OPT_LEVELS'),
    extractConst(rendererSrc, 'TASKS_CONTEXT_OPT_DEFAULT'),
    extractFn(rendererSrc, 'tasksNormalizeContextOptimization'),
    extractConst(rendererSrc, 'TASKS_UNSAFE_KEYS'),
    extractFn(rendererSrc, 'tasksIsUnsafeKey'),
    extractFn(rendererSrc, 'tasksSerializeTeamConfig'),
    'return { tasksBuildColumn, normalizeTasksColumns, tasksSerializeTeamConfig };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(body)();
}
const R = loadColumnHelpers();

test('AC: tasksBuildColumn never carries a phase field, even when fed one', () => {
  const col = R.tasksBuildColumn('custom', { status: 'custom', label: 'Custom', phase: 'review' }, false);
  assert.equal('phase' in col, false, 'tasksBuildColumn output has no phase key');
  assert.deepEqual(Object.keys(col).sort(),
    ['agent', 'description', 'instructions', 'label', 'status', 'system'].sort(),
    'tasksBuildColumn output has exactly the surviving fields');
});

test('AC: normalizeTasksColumns drops a legacy phase field entirely', () => {
  const raw = { columns: [{ status: 'todo', label: 'To Do', phase: 'plan', system: true }] };
  const cols = R.normalizeTasksColumns(raw);
  const todo = cols.find((c) => c.status === 'todo');
  assert.ok(todo, 'the todo column normalizes');
  assert.equal('phase' in todo, false, 'the normalized column has no phase key');
});

test('AC: tasksSerializeTeamConfig never emits a phase field on any column', () => {
  const working = {
    version: 1,
    columns: [
      { status: 'todo', label: 'To Do', system: true, phase: 'plan' },
      { status: 'custom', label: 'Custom', system: false, phase: 'review' },
    ],
    skill: { concurrencyDefault: 3 },
  };
  const serialized = JSON.parse(R.tasksSerializeTeamConfig(working));
  for (const col of serialized.columns) {
    assert.equal('phase' in col, false, `${col.status} column has no phase key in the serialized output`);
  }
});

test('AC: tasksSerializeTeamConfig never re-adds skill.phases', () => {
  const working = {
    version: 1,
    columns: [{ status: 'todo', label: 'To Do', system: true }],
    skill: { concurrencyDefault: 3 },
  };
  const serialized = JSON.parse(R.tasksSerializeTeamConfig(working));
  assert.equal('phases' in serialized.skill, false, 'the serialized skill object has no phases key');
});

// ---------------------------------------------------------------------------
// AC: buildWorkflowConcurrencyControl / buildWorkflowContextOptimizationControl
// remain, and are invoked exactly once each — from renderTeamBoard (the Board
// panel), never from a Workflow panel (which no longer exists).
// ---------------------------------------------------------------------------
test('AC: buildWorkflowConcurrencyControl and buildWorkflowContextOptimizationControl are kept', () => {
  assert.match(rendererSrc, /function buildWorkflowConcurrencyControl\(tab, rawConfig\)/, 'buildWorkflowConcurrencyControl is defined');
  assert.match(rendererSrc, /function buildWorkflowContextOptimizationControl\(tab, rawConfig\)/, 'buildWorkflowContextOptimizationControl is defined');
});

test('AC: both relocated controls are called exactly once each, from renderTeamBoard', () => {
  const renderBody = extractFn(rendererSrc, 'renderTeamBoard');
  assert.match(renderBody, /buildWorkflowConcurrencyControl\(tab, state\.rawConfig\)/, 'renderTeamBoard mounts the concurrency control');
  assert.match(renderBody, /buildWorkflowContextOptimizationControl\(tab, state\.rawConfig\)/, 'renderTeamBoard mounts the context-optimisation control');

  // Exactly ONE call site for each across the whole renderer (the declaration
  // itself plus the single call inside renderTeamBoard — nothing else calls it,
  // in particular no now-removed buildWorkflowView).
  const concurrencyCallSites = rendererSrc.split('buildWorkflowConcurrencyControl(').length - 1;
  assert.equal(concurrencyCallSites, 2, 'buildWorkflowConcurrencyControl: declaration + exactly one call site');
  const contextOptCallSites = rendererSrc.split('buildWorkflowContextOptimizationControl(').length - 1;
  assert.equal(contextOptCallSites, 2, 'buildWorkflowContextOptimizationControl: declaration + exactly one call site');
});

// ---------------------------------------------------------------------------
// AC: no els binding / event wiring for teamWorkflowBody / teamWorkflowRefresh
// / the Workflow section toggle remains, anywhere in renderer.js or index.html.
// ---------------------------------------------------------------------------
test('AC: no els binding for teamWorkflowBody / teamWorkflowRefresh / teamWorkflowSection remains', () => {
  for (const sel of ['teamWorkflowBody', 'teamWorkflowRefresh', 'teamWorkflowSection']) {
    assert.ok(!new RegExp(sel + ':\\s*ws\\.querySelector').test(rendererSrc), `els.${sel} binding removed`);
    assert.equal(rendererSrc.includes(`tab.els.${sel}`), false, `no tab.els.${sel} reference remains`);
  }
});

test('AC: index.html ships no teamWorkflow* markup at all', () => {
  assert.equal(htmlSrc.includes('teamWorkflow'), false, 'index.html has no teamWorkflow* class or id anywhere');
});

test('AC: the generic team-section-toggle wiring convention is untouched by name (Agents/Board still use it)', () => {
  // Removing the Workflow section must not have broken the shared class hook
  // the Agents/Board section headers use for their own toggle buttons.
  const vStart = htmlSrc.indexOf('data-view="team"');
  const vClose = htmlSrc.indexOf('</template>', vStart);
  const panel = htmlSrc.slice(vStart, vClose);
  const toggles = panel.match(/class="team-section-toggle"/g) || [];
  assert.equal(toggles.length, 2, 'exactly two team-section-toggle buttons remain (Agents + Board)');
});
