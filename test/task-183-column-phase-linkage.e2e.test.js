'use strict';

// ===========================================================================
// TASK-183 — e2e "cucumber" scenarios (Given/When/Then), implemented as plain
// `node --test` cases. NO cucumber npm package is installed or required; these
// are scenario-style node:test cases in Given/When/Then form.
//
// Feature: Board column phase linkage — each column row gains a Phase select
// ((none) + plan/build/test/review), wired to update col.phase and mark dirty
// on change. Changing the select persists phase and it survives round-trip/re-read.
// System columns can also carry a phase link. Adding "PR Review" linked to review
// persists phase "review" AND flips skill.phases.review.enabled to true in the
// same save. Auto-enable flip only fires on zero-to-one transition; a second link,
// or an already-enabled phase, does not re-flip. All dynamic text uses textContent;
// phase value validated before persistence.
//
// NO DATABASE, DISK WRITE, ELECTRON RUNTIME, OR NETWORK CALL IS MADE. The
// browser files (renderer/renderer.js, index.html, styles.css) cannot be
// require()'d, so — matching the repo convention in
// test/task-030-plan-button.e2e.test.js — their wiring is proven by
// SOURCE-SCANNING those files as text. The board panel behaviour is exercised
// through pure replicas driven by the Gherkin scenarios, with drift-guards tying
// the replicas to the real source so they cannot silently diverge. All DOM/els
// are plain in-memory mock objects.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(REPO, 'renderer', 'index.html'), 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// PURE REPLICAS (browser scripts are not requireable).
// ─────────────────────────────────────────────────────────────────────────────

const TASKS_PHASE_KEYS = ['plan', 'build', 'test', 'review'];
const TASKS_PHASE_ENABLED_DEFAULTS = Object.fromEntries(
  TASKS_PHASE_KEYS.map((key) => [key, key !== 'review'])
);

// Normalise a column's `phase` link: a string in TASKS_PHASE_KEYS is kept;
// anything else becomes null.
function tasksNormalizeColumnPhase(rawPhase) {
  return (typeof rawPhase === 'string' && TASKS_PHASE_KEYS.includes(rawPhase)) ? rawPhase : null;
}

// Count how many columns are linked to each phase.
function tasksPhaseLinkCounts(columns) {
  const counts = {};
  for (const key of TASKS_PHASE_KEYS) counts[key] = 0;
  for (const c of (Array.isArray(columns) ? columns : [])) {
    if (c && TASKS_PHASE_KEYS.includes(c.phase)) counts[c.phase] += 1;
  }
  return counts;
}

// One-time zero-to-one transition flip: flips skill.phases[phase].enabled to
// true when that phase had ZERO linked columns at baseline and now has >=1.
function tasksApplyPhaseAutoEnable(columns, baselineCounts, skill) {
  const s = (skill && typeof skill === 'object' && !Array.isArray(skill)) ? skill : {};
  const phases = (s.phases && typeof s.phases === 'object' && !Array.isArray(s.phases)) ? s.phases : {};
  const counts = tasksPhaseLinkCounts(columns);
  const baseline = (baselineCounts && typeof baselineCounts === 'object') ? baselineCounts : {};
  TASKS_PHASE_KEYS.forEach((key, idx) => {
    const before = Number(baseline[key]) || 0;
    const after = counts[key] || 0;
    if (before !== 0 || after === 0) return;
    const cur = (phases[key] && typeof phases[key] === 'object' && !Array.isArray(phases[key])) ? phases[key] : null;
    const enabled = (cur && typeof cur.enabled === 'boolean') ? cur.enabled : TASKS_PHASE_ENABLED_DEFAULTS[key];
    if (enabled !== false) return;
    const order = (cur && cur.order != null) ? cur.order : idx + 1;
    phases[key] = { ...(cur || {}), enabled: true, order };
  });
  s.phases = phases;
  return s;
}

// Serialize a team config to JSON. Mirrors tasksSerializeTeamConfig for
// validation and testing.
function serializeTeamConfig(state) {
  const normalized = normalizeTasksColumns({ columns: state.columns });
  const cols = normalized.map((c) => ({
    status: c.status,
    label: c.label,
    description: c.description,
    agent: c.agent,
    system: c.system ? true : undefined,
    phase: tasksNormalizeColumnPhase(c.phase) || undefined
  }));
  const out = { version: state.version || 1, columns: cols };
  // Filter out undefined values for clean output
  for (let i = 0; i < cols.length; i++) {
    cols[i] = Object.fromEntries(Object.entries(cols[i]).filter(([_, v]) => v !== undefined));
  }
  if (state.skill && typeof state.skill === 'object') out.skill = state.skill;
  return out;
}

// Normalize columns (system lanes + user columns).
const TASKS_LANE_STATUSES = ['todo', 'in-progress', 'testing', 'in-review', 'approved', 'done'];
const TASKS_RESERVED_SLUGS = new Set(['failed-testing', ...TASKS_LANE_STATUSES, 'unknown', '__wont-do__']);
const TASKS_MAX_SLUG_LENGTH = 30;
const TASKS_SLUG_RE = /^[a-z0-9-]+$/;

function tasksBuildColumn(slug, rawCol, system) {
  const src = rawCol && typeof rawCol === 'object' ? rawCol : {};
  const label = typeof src.label === 'string' && src.label.trim() !== ''
    ? src.label
    : slug;
  const description = typeof src.description === 'string' ? src.description : '';
  const agent = typeof src.agent === 'string' && src.agent.trim() !== '' ? src.agent.trim() : null;
  const phase = tasksNormalizeColumnPhase(src.phase);
  return { status: slug, label, description, agent, system: !!system, phase };
}

function normalizeTasksColumns(raw) {
  const rawCols = raw && Array.isArray(raw.columns) ? raw.columns : [];
  const seenSystem = new Set();
  const seenUser = new Set();
  const systemRaw = Object.create(null);
  const userCols = [];
  let lastSystem = null;
  for (const rc of rawCols) {
    if (!rc || typeof rc !== 'object' || Array.isArray(rc)) continue;
    const status = typeof rc.status === 'string' ? rc.status.trim() : '';
    if (TASKS_LANE_STATUSES.includes(status)) {
      if (seenSystem.has(status)) continue;
      seenSystem.add(status);
      systemRaw[status] = rc;
      lastSystem = status;
      continue;
    }
    if (status === '' || TASKS_RESERVED_SLUGS.has(status)) continue;
    if (status.length > TASKS_MAX_SLUG_LENGTH || !TASKS_SLUG_RE.test(status)) continue;
    if (seenUser.has(status)) continue;
    seenUser.add(status);
    userCols.push({ anchor: lastSystem, col: rc });
  }
  const out = [];
  const appendAnchored = (anchor) => {
    for (const u of userCols) {
      if (u.anchor === anchor) out.push(tasksBuildColumn(u.col.status.trim(), u.col, false));
    }
  };
  appendAnchored(null);
  for (const slug of TASKS_LANE_STATUSES) {
    out.push(tasksBuildColumn(slug, seenSystem.has(slug) ? systemRaw[slug] : null, true));
    appendAnchored(slug);
  }
  return out;
}

// Mock column object.
function makeColumn(slug, label = slug, phase = null, system = false) {
  return { status: slug, label, description: '', agent: null, system, phase };
}

// Mock tab.teamBoard state.
function makeBoardState(columns = []) {
  const normalized = normalizeTasksColumns({ columns });
  return {
    version: 1,
    skill: { phases: {} },
    columns: normalized,
    agentNames: [],
    notice: null,
    dirty: false,
    baselinePhaseLinks: tasksPhaseLinkCounts(normalized)
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Scenario 1: Link a user column to a phase
//   When the user adds column "PR Review" and sets its Phase select to "review"
//   Then tasks/team-config.json has a column pr-review with phase "review"
//   And skill.phases.review.enabled is true (flipped from its default false)
// ──────────────────────────────────────────────────────────────────────────────

test('Scenario: link a user column to a phase', () => {
  // Given a board state with just the system columns
  const state = makeBoardState();
  assert.equal(state.columns.filter((c) => !c.system).length, 0, 'precondition: no user columns');
  // When the user adds column "PR Review" and sets its Phase to "review"
  state.columns.push(makeColumn('pr-review', 'PR Review', 'review', false));
  state.dirty = true;
  // Apply auto-enable before serializing
  state.skill = tasksApplyPhaseAutoEnable(state.columns, state.baselinePhaseLinks, state.skill);
  // Then serialize and check the output
  const serialized = serializeTeamConfig(state);
  const prCol = serialized.columns.find((c) => c.status === 'pr-review');
  assert.ok(prCol, 'pr-review column exists in serialized config');
  assert.equal(prCol.phase, 'review', 'pr-review column has phase "review"');
  // And skill.phases.review.enabled is true (flipped from default false)
  assert.equal(state.skill.phases.review.enabled, true, 'review phase auto-enabled');
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario 2: Second link to an already-linked phase does not re-flip (edge)
//   Given a column already linked to review and skill.phases.review.enabled manually
//   set false again
//   When the user adds another column also linked to review and saves
//   Then skill.phases.review.enabled remains false (manual choice not overridden)
// ──────────────────────────────────────────────────────────────────────────────

test('Scenario (edge): second link to already-linked phase does not re-flip', () => {
  // Given a board with one column already linked to review
  const state = makeBoardState([makeColumn('pr-review', 'PR Review', 'review', false)]);
  // Baseline reflects that state (1 column linked to review)
  state.baselinePhaseLinks = { plan: 0, build: 0, test: 0, review: 1 };
  // User then manually disabled review after the first link
  state.skill = { phases: { review: { enabled: false } } };
  // When the user adds another column also linked to review
  state.columns.push(makeColumn('qa-review', 'QA Review', 'review', false));
  state.dirty = true;
  // Apply auto-enable (should NOT flip because baseline was not 0)
  state.skill = tasksApplyPhaseAutoEnable(state.columns, state.baselinePhaseLinks, state.skill);
  // Then review remains disabled
  assert.equal(state.skill.phases.review.enabled, false, 'review stays disabled (baseline was not 0)');
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario 3: System column can be linked explicitly
//   When the user sets the "testing" system column Phase to "test" and saves
//   Then the testing column persists phase "test" with system true and slug
//   "testing" unchanged
// ──────────────────────────────────────────────────────────────────────────────

test('Scenario: system column can be linked explicitly', () => {
  // Given a board state
  const state = makeBoardState();
  // When the user sets the testing system column's phase to "test"
  const testingCol = state.columns.find((c) => c.status === 'testing' && c.system);
  assert.ok(testingCol, 'precondition: testing system column exists');
  testingCol.phase = 'test';
  state.dirty = true;
  // Serialize and check
  const serialized = serializeTeamConfig(state);
  const persistedTesting = serialized.columns.find((c) => c.status === 'testing');
  assert.ok(persistedTesting, 'testing column exists in serialized config');
  assert.equal(persistedTesting.phase, 'test', 'testing column has phase "test"');
  assert.equal(persistedTesting.system, true, 'testing column is marked system');
  assert.equal(persistedTesting.status, 'testing', 'testing slug unchanged');
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario 4: Clearing a link
//   Given a column with phase "review"
//   When the user sets its Phase select to "(none)" and saves
//   Then the column persists phase null (or undefined in JSON)
// ──────────────────────────────────────────────────────────────────────────────

test('Scenario: clearing a link', () => {
  // Given a board with a column linked to review
  const state = makeBoardState([makeColumn('pr-review', 'PR Review', 'review', false)]);
  // When the user clears the phase (sets to null)
  const col = state.columns.find((c) => c.status === 'pr-review');
  col.phase = null;
  state.dirty = true;
  // Serialize and check
  const serialized = serializeTeamConfig(state);
  const prCol = serialized.columns.find((c) => c.status === 'pr-review');
  assert.ok(prCol, 'pr-review column exists');
  // phase should be undefined (or not present) in the serialized output
  assert.ok(prCol.phase === undefined || prCol.phase === null, 'phase is absent or null in serialized form');
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario 5: Phase link round-trips (edge)
//   Given a saved config with pr-review linked to review
//   When the Board panel re-reads the file (deserialized)
//   Then the Phase select shows "review" for that column
// ──────────────────────────────────────────────────────────────────────────────

test('Scenario (edge): phase link round-trips', () => {
  // Given a serialized config with pr-review linked to review
  const serialized = {
    version: 1,
    columns: [
      { status: 'todo', system: true },
      { status: 'in-progress', system: true },
      { status: 'testing', system: true },
      { status: 'in-review', system: true },
      { status: 'approved', system: true },
      { status: 'done', system: true },
      { status: 'pr-review', label: 'PR Review', phase: 'review' }
    ]
  };
  // When the panel re-reads (deserializes via normalizeTasksColumns)
  const deserialized = normalizeTasksColumns(serialized);
  // Then the pr-review column has phase "review"
  const prCol = deserialized.find((c) => c.status === 'pr-review');
  assert.ok(prCol, 'pr-review column exists after round-trip');
  assert.equal(prCol.phase, 'review', 'pr-review phase is "review" after round-trip');
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario 6: Tampered phase value rejected (failure/edge)
//   Given an in-memory column whose phase was set to "deploy" (an invalid value)
//   When the config is serialised
//   Then the persisted column has phase null (never "deploy")
// ──────────────────────────────────────────────────────────────────────────────

test('Scenario (failure/edge): tampered phase value rejected at serialization', () => {
  // Given a column with a tampered/invalid phase value
  const state = makeBoardState([
    { status: 'col1', label: 'Col 1', description: '', agent: null, system: false, phase: 'deploy' }
  ]);
  // When the config is serialized
  const serialized = serializeTeamConfig(state);
  // Then the phase is normalized to null/undefined
  const col = serialized.columns.find((c) => c.status === 'col1');
  assert.ok(col, 'col1 exists in serialized config');
  assert.ok(col.phase === undefined || col.phase === null, 'phase is null/undefined (never "deploy")');
});

// ──────────────────────────────────────────────────────────────────────────────
// DRIFT GUARD: tie the phase select HTML and phase-handling logic to the real
// source so the behavioural scenarios above cannot silently diverge.
// ──────────────────────────────────────────────────────────────────────────────

test('DRIFT GUARD: Phase select HTML exists in buildTeamColumnRow', () => {
  // The Phase select should be in the buildTeamColumnRow function
  assert.match(rendererSrc, /team-column-phase-select/, 'Phase select class exists');
  assert.match(rendererSrc, /const phaseSel = document\.createElement\('select'\)/, 'phaseSel created');
  assert.match(rendererSrc, /phaseSel\.className = 'team-column-phase-select'/, 'phaseSel className set');
});

test('DRIFT GUARD: Phase options include (none) and all four phase keys', () => {
  // The Phase select must have (none) as the first option and all four phase keys
  assert.match(rendererSrc, /noPhaseOpt\.textContent = '\(none\)'/, '(none) option exists');
  // All four phase keys should be looped in the select builder
  assert.match(rendererSrc, /for \(const key of TASKS_PHASE_KEYS\)/, 'TASKS_PHASE_KEYS loop exists');
  // Check that each canonical key is used as an option value
  for (const key of ['plan', 'build', 'test', 'review']) {
    assert.match(rendererSrc, new RegExp(`'${key}'`), `phase key "${key}" appears in source`);
  }
});

test('DRIFT GUARD: Phase normalization applied before persistence', () => {
  // tasksNormalizeColumnPhase function must exist (used in buildTeamColumnRow display seeding)
  assert.match(rendererSrc, /function tasksNormalizeColumnPhase/, 'tasksNormalizeColumnPhase function defined');
  // Normalization is applied via normalizeTasksColumns which is called in tasksSerializeTeamConfig
  const serializeStart = rendererSrc.indexOf('function tasksSerializeTeamConfig');
  const serializeEnd = rendererSrc.indexOf('return JSON.stringify', serializeStart);
  const serializeBody = rendererSrc.slice(serializeStart, serializeEnd);
  assert.match(serializeBody, /normalizeTasksColumns/, 'normalizeTasksColumns called (applies normalization)');
  // normalizeTasksColumns calls tasksBuildColumn which calls tasksNormalizeColumnPhase
  assert.match(rendererSrc, /function tasksBuildColumn/, 'tasksBuildColumn exists');
  const buildStart = rendererSrc.indexOf('function tasksBuildColumn');
  const buildEnd = rendererSrc.indexOf('\n}', buildStart + 500);
  const buildBody = rendererSrc.slice(buildStart, buildEnd);
  assert.match(buildBody, /tasksNormalizeColumnPhase/, 'tasksBuildColumn uses tasksNormalizeColumnPhase');
});

test('DRIFT GUARD: Auto-enable flip applied in saveTeamBoardConfig', () => {
  // tasksApplyPhaseAutoEnable must be called in saveTeamBoardConfig
  assert.match(rendererSrc, /tasksApplyPhaseAutoEnable\(/, 'tasksApplyPhaseAutoEnable exists');
  // It should be applied before serializing
  const saveStart = rendererSrc.indexOf('async function saveTeamBoardConfig');
  const saveEnd = rendererSrc.indexOf('\n}', saveStart);
  let saveBody = rendererSrc.slice(saveStart, saveEnd);
  // Scan ahead to find the whole function body (may span multiple closing braces)
  let braceCount = 1;
  let idx = rendererSrc.indexOf('{', saveStart) + 1;
  while (braceCount > 0 && idx < rendererSrc.length) {
    if (rendererSrc[idx] === '{') braceCount++;
    if (rendererSrc[idx] === '}') braceCount--;
    idx++;
  }
  saveBody = rendererSrc.slice(saveStart, idx);
  assert.match(saveBody, /tasksApplyPhaseAutoEnable\(/, 'tasksApplyPhaseAutoEnable called in saveTeamBoardConfig');
});

test('DRIFT GUARD: baselinePhaseLinks snapshotted in refreshTeamBoard', () => {
  // refreshTeamBoard must snapshot tasksPhaseLinkCounts at load time
  assert.match(rendererSrc, /tasksPhaseLinkCounts\(/, 'tasksPhaseLinkCounts function exists');
  assert.match(rendererSrc, /baselinePhaseLinks/, 'baselinePhaseLinks variable exists');
  const refreshStart = rendererSrc.indexOf('async function refreshTeamBoard');
  const refreshEnd = rendererSrc.indexOf('\n}', refreshStart);
  let refreshBody = rendererSrc.slice(refreshStart, refreshEnd);
  // Scan ahead to capture the full function (may have nested blocks)
  let braceCount = 1;
  let idx = rendererSrc.indexOf('{', refreshStart) + 1;
  while (braceCount > 0 && idx < rendererSrc.length) {
    if (rendererSrc[idx] === '{') braceCount++;
    if (rendererSrc[idx] === '}') braceCount--;
    idx++;
  }
  refreshBody = rendererSrc.slice(refreshStart, idx);
  assert.match(refreshBody, /baselinePhaseLinks\s*=\s*tasksPhaseLinkCounts/, 'baselinePhaseLinks snapshotted via tasksPhaseLinkCounts');
});

test('DRIFT GUARD: Phase select value seeded from col.phase via tasksNormalizeColumnPhase', () => {
  // In buildTeamColumnRow, the phase select must be seeded with normalization
  const columnStart = rendererSrc.indexOf('function buildTeamColumnRow');
  const columnEnd = rendererSrc.indexOf('\n}', columnStart);
  let columnBody = rendererSrc.slice(columnStart, columnEnd);
  // Scan for full function body
  let braceCount = 1;
  let idx = rendererSrc.indexOf('{', columnStart) + 1;
  while (braceCount > 0 && idx < rendererSrc.length) {
    if (rendererSrc[idx] === '{') braceCount++;
    if (rendererSrc[idx] === '}') braceCount--;
    idx++;
  }
  columnBody = rendererSrc.slice(columnStart, idx);
  assert.match(columnBody, /phaseSel\.value\s*=\s*tasksNormalizeColumnPhase/, 'phaseSel seeded with normalized phase');
});

test('DRIFT GUARD: Phase select change updates col.phase and marks dirty', () => {
  const columnStart = rendererSrc.indexOf('function buildTeamColumnRow');
  let braceCount = 1;
  let idx = rendererSrc.indexOf('{', columnStart) + 1;
  while (braceCount > 0 && idx < rendererSrc.length) {
    if (rendererSrc[idx] === '{') braceCount++;
    if (rendererSrc[idx] === '}') braceCount--;
    idx++;
  }
  const columnBody = rendererSrc.slice(columnStart, idx);
  // The listener should update col.phase and call markTeamBoardDirty
  assert.match(columnBody, /phaseSel\.addEventListener\('change'/, 'phase select has change listener');
  assert.match(columnBody, /col\.phase\s*=\s*phaseSel\.value/, 'listener updates col.phase');
  assert.match(columnBody, /markTeamBoardDirty\(tab\)/, 'listener marks dirty');
});

test('DRIFT GUARD: New columns start with phase null', () => {
  const addFormStart = rendererSrc.indexOf('function buildTeamAddColumnForm');
  let braceCount = 1;
  let idx = rendererSrc.indexOf('{', addFormStart) + 1;
  while (braceCount > 0 && idx < rendererSrc.length) {
    if (rendererSrc[idx] === '{') braceCount++;
    if (rendererSrc[idx] === '}') braceCount--;
    idx++;
  }
  const addFormBody = rendererSrc.slice(addFormStart, idx);
  // When a new column is added (in the submit handler)
  assert.match(addFormBody, /phase:\s*null/, 'new column starts with phase: null');
});

test('DRIFT GUARD: TASKS_PHASE_KEYS defined with all four phases', () => {
  const keysMatch = rendererSrc.match(/const\s+TASKS_PHASE_KEYS\s*=\s*\[([^\]]+)\]/);
  assert.ok(keysMatch, 'TASKS_PHASE_KEYS defined');
  const keysStr = keysMatch[1];
  for (const key of ['plan', 'build', 'test', 'review']) {
    assert.ok(keysStr.includes(`'${key}'`) || keysStr.includes(`"${key}"`), `TASKS_PHASE_KEYS includes "${key}"`);
  }
});

test('DRIFT GUARD: TASKS_PHASE_ENABLED_DEFAULTS review defaults to false', () => {
  // The defaults object should be defined and show review:false
  assert.match(rendererSrc, /const TASKS_PHASE_ENABLED_DEFAULTS/, 'TASKS_PHASE_ENABLED_DEFAULTS defined');
  // The default should set review to false via the != 'review' check
  assert.match(rendererSrc, /key !== ['"]review['"]/, 'defaults logic: review defaults to false');
});

test('DRIFT GUARD: Phase help text mentions the four phase keys', () => {
  // In renderTeamBoard, the help text should mention phases
  assert.match(rendererSrc, /linking.*column.*phase/, 'help mentions linking columns to phases');
  assert.match(rendererSrc, /plan\/build\/test\/review/, 'help lists all four phase keys');
});
