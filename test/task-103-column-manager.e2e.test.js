'use strict';

// ===========================================================================
// TASK-103 — e2e "cucumber" scenarios (Given/When/Then), implemented as plain
// `node --test` cases. NO cucumber npm package is installed or required; these
// are scenario-style node:test cases in Given/When/Then form.
//
// Feature: the Team tab Board panel — a column manager over
// <folder>/tasks/team-config.json. It lists the six system columns plus any user
// columns; adds a user column (label → derived read-only slug, validated,
// spliced at a chosen position); protects system columns (no remove, no re-slug,
// fixed relative order); removes user columns (warning stating the live ticket
// count + "Unknown", config-only); and Saves the WHOLE config in one
// fs.writeFile of the NORMALIZED config; a corrupt config loads defaults + a
// non-blocking notice.
//
// The subject under test is the REAL renderer code (renderer/renderer.js — a
// browser script with no module.exports). refreshTeamBoard, renderTeamBoard,
// buildTeamColumnRow, buildTeamAddColumnForm, removeTeamColumn,
// saveTeamBoardConfig, canSwapTeamColumns, countTeamTicketsForStatus,
// readTeamAgentNames and their pure helpers are EXTRACTED headless by
// brace-matching the source and evaluated with an INJECTED window/document/
// console (mock DOM + a stubbed window.api.fs).
//
// ALL filesystem access goes through the stubbed window.api.fs, which is backed
// by a real TEMP directory so the WRITTEN config is asserted by parsing it off
// disk. NO real DATABASE / Electron / network. window.confirm is stubbed so the
// removal-confirmation scenario is deterministic.
//
// The mock-DOM primitives (makeEl / makeDocument / findByClass / findAllByClass /
// fire) are reused from test/helpers/task-101-lane-harness.js — the shared
// require()-able harness — without modification.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  rendererSrc, makeEl, makeDocument, findByClass, findAllByClass, fire,
} = require('./helpers/task-101-lane-harness');

const teamConfig = require('../lib/team-config.js');

// --- Extraction helpers (same brace-matching convention as the harness). -----
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

// Load the REAL Board-panel column manager headless, injecting window/document/
// console. Function declarations are hoisted, so only the const declarations
// need ordering (later consts reference earlier ones at declaration time).
function loadBoard(window, document, console) {
  const body = [
    extractConst(rendererSrc, 'TASKS_LANE_STATUSES'),
    extractConst(rendererSrc, 'TASKS_VALID_STATUSES'),
    extractConst(rendererSrc, 'TASKS_UNKNOWN_STATUS'),
    extractConst(rendererSrc, 'TASKS_SYSTEM_LABELS'),
    extractConst(rendererSrc, 'TASKS_RESERVED_SLUGS'),
    extractConst(rendererSrc, 'TASKS_MAX_SLUG_LENGTH'),
    extractConst(rendererSrc, 'TASKS_SLUG_RE'),
    // TASK-180 - tasksBuildColumn normalises a column's optional `phase` link
    // via tasksNormalizeColumnPhase, which reads TASKS_PHASE_KEYS.
    extractConst(rendererSrc, 'TASKS_PHASE_KEYS'),
    // TASK-183 - tasksApplyPhaseAutoEnable's fallback when a phase's
    // skill.phases entry is missing/malformed, plus the column->phase link
    // counter it and refreshTeamBoard's baseline snapshot both use.
    extractConst(rendererSrc, 'TASKS_PHASE_ENABLED_DEFAULTS'),
    extractFn(rendererSrc, 'tasksPhaseLinkCounts'),
    extractFn(rendererSrc, 'tasksApplyPhaseAutoEnable'),
    // TASK-121 (F2): tasksSerializeTeamConfig now clamps skill.concurrencyDefault
    // through resolveTasksConcurrency, so the serializer needs these three symbols
    // in scope or saveTeamBoardConfig throws ReferenceError. Function declarations
    // hoist; the two consts must precede any call.
    extractConst(rendererSrc, 'TASKS_MAX_CONCURRENCY'),
    extractConst(rendererSrc, 'TASKS_DEFAULT_CONCURRENCY'),
    extractFn(rendererSrc, 'resolveTasksConcurrency'),
    extractFn(rendererSrc, 'tasksPrettifyLabel'),
    extractFn(rendererSrc, 'tasksNormalizeColumnPhase'),
    extractFn(rendererSrc, 'tasksBuildColumn'),
    extractFn(rendererSrc, 'normalizeTasksColumns'),
    extractFn(rendererSrc, 'tasksSlugForLabel'),
    extractFn(rendererSrc, 'tasksValidateNewColumn'),
    // TASK-200 — tasksSerializeTeamConfig now normalises skill.contextOptimization
    // via tasksNormalizeContextOptimization, so these must be in scope too.
    extractConst(rendererSrc, 'TASKS_CONTEXT_OPT_LEVELS'),
    extractConst(rendererSrc, 'TASKS_CONTEXT_OPT_DEFAULT'),
    extractFn(rendererSrc, 'tasksNormalizeContextOptimization'),
    extractFn(rendererSrc, 'tasksSerializeTeamConfig'),
    extractFn(rendererSrc, 'inferSep'),
    extractFn(rendererSrc, 'appendPath'),
    extractFn(rendererSrc, 'tasksJoin'),
    extractFn(rendererSrc, 'tasksBasename'),
    extractFn(rendererSrc, 'readTeamAgentNames'),
    extractFn(rendererSrc, 'countTeamTicketsForStatus'),
    extractFn(rendererSrc, 'refreshTeamBoard'),
    extractFn(rendererSrc, 'renderTeamBoard'),
    extractFn(rendererSrc, 'canSwapTeamColumns'),
    extractFn(rendererSrc, 'buildTeamColumnRow'),
    extractFn(rendererSrc, 'markTeamBoardDirty'),
    extractFn(rendererSrc, 'buildTeamAddColumnForm'),
    extractFn(rendererSrc, 'removeTeamColumn'),
    extractFn(rendererSrc, 'saveTeamBoardConfig'),
    'return { refreshTeamBoard, renderTeamBoard, buildTeamColumnRow,',
    '  buildTeamAddColumnForm, removeTeamColumn, saveTeamBoardConfig,',
    '  canSwapTeamColumns, countTeamTicketsForStatus, normalizeTasksColumns };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function('window', 'document', 'console', body)(window, document, console);
}

// A stubbed window.api.fs backed by a real temp dir. `writeFile` records every
// write so a scenario can assert exactly ONE file (team-config.json) was written
// and no ticket file was ever touched. `confirm` is stubbed per test.
function makeEnv(opts) {
  const o = opts || {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task103-'));
  const writes = [];
  const confirmCalls = [];
  const window = {
    confirm(msg) { confirmCalls.push(String(msg)); return o.confirm !== false; },
    api: {
      fs: {
        async findByExt(dir, ext) {
          try {
            const out = [];
            for (const name of fs.readdirSync(dir)) {
              if (name.toLowerCase().endsWith(String(ext).toLowerCase())) out.push(path.join(dir, name));
            }
            return { ok: true, files: out };
          } catch (err) {
            return { ok: false, error: err.message };
          }
        },
        async readFile(fp) {
          try {
            return { ok: true, content: fs.readFileSync(fp, 'utf8') };
          } catch (err) {
            return { ok: false, error: err.message };
          }
        },
        async writeFile(fp, content) {
          writes.push({ path: fp, content });
          fs.mkdirSync(path.dirname(fp), { recursive: true });
          fs.writeFileSync(fp, content);
          return { ok: true };
        },
        async mkdir(dir) {
          fs.mkdirSync(dir, { recursive: true });
          return { ok: true };
        },
      },
    },
  };
  const console = { error() {}, warn() {}, log() {} };
  return { root, window, console, document: makeDocument(), writes, confirmCalls };
}

const cfgPathFor = (root) => path.join(root, 'tasks', 'team-config.json');

// Write an initial config to disk (the default six system columns unless given).
function seedConfig(root, cfg) {
  const dir = path.join(root, 'tasks');
  fs.mkdirSync(dir, { recursive: true });
  const content = cfg === undefined
    ? teamConfig.serializeConfig(teamConfig.defaultConfig())
    : cfg;
  fs.writeFileSync(path.join(dir, 'team-config.json'), content);
}

// Build a Board tab whose teamBoardBody is a mock element.
function makeTab(root, tickets) {
  return {
    folder: root,
    els: { teamBoardBody: makeEl('div'), teamBoardSaveBtn: makeEl('button') },
    tasks: { tickets: tickets || new Map() },
  };
}

// Flush the un-awaited trailing refreshTeamBoard() that saveTeamBoardConfig kicks
// off, so no async work escapes the test.
const flush = () => new Promise((r) => setImmediate(r));

// Locate the Add-column form controls in a rendered board body.
function addForm(body) {
  const form = findByClass(body, 'team-add-column');
  return {
    form,
    label: findByClass(form, 'team-add-column-label'),
    slug: findByClass(form, 'team-add-column-slug'),
    pos: findByClass(form, 'team-add-column-position'),
    addBtn: findByClass(form, 'team-add-column-btn'),
    err: findByClass(form, 'team-add-column-error'),
  };
}
// The rendered column rows, in order, as { slug, system, row }.
function rows(body) {
  return findAllByClass(body, 'team-column').map((row) => ({
    row,
    slug: findByClass(row, 'team-column-slug').textContent,
    system: row.classList.contains('team-column-system'),
  }));
}

// ===========================================================================
// Scenario: Adding a user column
//   When the user adds "UX Review" after Testing and saves
//   Then team-config.json holds column ux-review at that position
//   And the Tasks board shows the new lane on its next poll
// ===========================================================================
test('Scenario: adding "UX Review" after Testing and saving writes ux-review at that position', async () => {
  // Given an open folder whose tasks/team-config.json holds the six defaults
  const env = makeEnv();
  seedConfig(env.root);
  const B = loadBoard(env.window, env.document, env.console);
  const tab = makeTab(env.root);

  // When the Board panel is loaded
  await B.refreshTeamBoard(tab);
  assert.deepEqual(rows(tab.els.teamBoardBody).map((r) => r.slug),
    ['todo', 'defining', 'in-progress', 'testing', 'post-processing', 'done'],
    'loads the six system columns in canonical order');

  // ...and the user types "UX Review" (the derived slug previews read-only)
  const af = addForm(tab.els.teamBoardBody);
  af.label.value = 'UX Review';
  await fire(af.label, 'input');
  assert.equal(af.slug.value, 'ux-review', 'derived slug previewed');
  assert.equal(af.slug.readOnly, true, 'slug preview is read-only');

  // ...and chooses "After Testing" (Testing is column index 3 → option value "4")
  af.pos.value = '4';
  await fire(af.addBtn, 'click');

  // Then the in-memory model inserts ux-review immediately after Testing
  assert.deepEqual(rows(tab.els.teamBoardBody).map((r) => r.slug),
    ['todo', 'defining', 'in-progress', 'testing', 'ux-review', 'post-processing', 'done']);

  // When the user saves
  await B.saveTeamBoardConfig(tab);
  await flush();

  // Then team-config.json on disk holds ux-review right after testing
  const written = JSON.parse(fs.readFileSync(cfgPathFor(env.root), 'utf8'));
  const statuses = written.columns.map((c) => c.status);
  assert.deepEqual(statuses,
    ['todo', 'defining', 'in-progress', 'testing', 'ux-review', 'post-processing', 'done']);
  const ux = written.columns.find((c) => c.status === 'ux-review');
  assert.equal(ux.system, false);
  assert.equal(ux.label, 'UX Review');

  // And the Tasks board shows the new lane on its next poll: the board reads the
  // SAME file through the same normalizer, which yields the ux-review lane after
  // Testing (no restart needed).
  const laneStatuses = B.normalizeTasksColumns(written).map((c) => c.status);
  assert.deepEqual(laneStatuses,
    ['todo', 'defining', 'in-progress', 'testing', 'ux-review', 'post-processing', 'done'],
    'the next board poll would render the ux-review lane after Testing');
});

// ===========================================================================
// Scenario: System column protections (failure)
//   Then the Done column has no remove control and its slug is not editable
//   And attempting to reorder Todo after Done is not possible
// ===========================================================================
test('Scenario (failure): system columns have no Remove / no editable slug and cannot be reordered past each other', async () => {
  const env = makeEnv();
  seedConfig(env.root);
  const B = loadBoard(env.window, env.document, env.console);
  const tab = makeTab(env.root);
  await B.refreshTeamBoard(tab);

  const all = rows(tab.els.teamBoardBody);
  const done = all.find((r) => r.slug === 'done');
  const todo = all.find((r) => r.slug === 'todo');

  // Then the Done column carries the "system" marker...
  assert.ok(done.system, 'Done is a system column');
  assert.equal(findByClass(done.row, 'team-column-badge').textContent, 'system');
  // ...has NO remove control...
  assert.equal(findByClass(done.row, 'team-column-remove'), null, 'Done has no Remove button');
  // ...and its slug is rendered as read-only text (a <span>), not an editable input
  const doneSlugEl = findByClass(done.row, 'team-column-slug');
  assert.equal(doneSlugEl.tagName, 'SPAN', 'slug is a non-editable <span>');
  assert.equal(findByClass(done.row, 'team-column-slug-input'), null, 'no slug input exists for a system column');

  // And attempting to reorder Todo after Done is not possible: Todo's move
  // controls are disabled (it can only swap with an adjacent SYSTEM column, which
  // is forbidden), and no system↔system swap is ever permitted.
  const moves = findByClass(todo.row, 'team-column-moves');
  const btns = findAllByClass(moves, 'team-column-move');
  assert.ok(btns.every((b) => b.disabled), 'both Todo move buttons are disabled');
  // The structural guard: no two system columns may swap, so Todo (index 0) can
  // never be swapped downward past Done (last index).
  const state = tab.teamBoard;
  const doneIdx = state.columns.findIndex((c) => c.status === 'done');
  assert.equal(B.canSwapTeamColumns(state, 0, 1), false, 'todo↔defining swap forbidden');
  assert.equal(B.canSwapTeamColumns(state, 0, doneIdx), false, 'todo↔done swap forbidden');
  for (let i = 0; i < state.columns.length - 1; i++) {
    assert.equal(B.canSwapTeamColumns(state, i, i + 1), false,
      'every adjacent system↔system swap is forbidden → order is frozen');
  }
});

// ===========================================================================
// Scenario: Removing a non-empty column (edge)
//   Given 2 tickets hold status ux-review
//   When the user removes the column
//   Then a confirmation states 2 tickets will show in Unknown
//   And after confirming only the config changes
// ===========================================================================
test('Scenario (edge): removing a non-empty user column confirms the count + Unknown and writes only the config', async () => {
  // Given a config with a ux-review user column and 2 live tickets holding it
  const env = makeEnv({ confirm: true });
  const withUx = teamConfig.defaultConfig();
  const testingIdx = withUx.columns.findIndex((c) => c.status === 'testing');
  withUx.columns.splice(testingIdx + 1, 0,
    { status: 'ux-review', label: 'UX Review', description: '', agent: null, system: false });
  seedConfig(env.root, teamConfig.serializeConfig(withUx));

  const tickets = new Map([
    ['A.md', { file: 'A.md', path: path.join(env.root, 'tasks', 'ux-review', 'A.md'), fm: { id: 'A', status: 'ux-review' } }],
    ['B.md', { file: 'B.md', path: path.join(env.root, 'tasks', 'ux-review', 'B.md'), fm: { id: 'B', status: 'ux-review' } }],
  ]);
  const B = loadBoard(env.window, env.document, env.console);
  const tab = makeTab(env.root, tickets);
  await B.refreshTeamBoard(tab);
  assert.ok(rows(tab.els.teamBoardBody).some((r) => r.slug === 'ux-review'), 'ux-review present');

  // When the user clicks Remove on the ux-review column
  const uxRow = rows(tab.els.teamBoardBody).find((r) => r.slug === 'ux-review').row;
  await fire(findByClass(uxRow, 'team-column-remove'), 'click');

  // Then a confirmation stated 2 tickets, and that they will show under Unknown
  assert.equal(env.confirmCalls.length, 1, 'confirmation was shown');
  assert.match(env.confirmCalls[0], /2 tickets/, 'states the count (2)');
  assert.match(env.confirmCalls[0], /Unknown/, 'states they will show under Unknown');
  // ...and the column is gone from the model after confirming
  assert.ok(!rows(tab.els.teamBoardBody).some((r) => r.slug === 'ux-review'), 'ux-review removed');

  // When the user saves
  await B.saveTeamBoardConfig(tab);
  await flush();

  // Then ONLY the config file changed — exactly one write, to team-config.json,
  // and NO ticket file was touched.
  assert.equal(env.writes.length, 1, 'exactly one file written');
  assert.equal(env.writes[0].path, cfgPathFor(env.root), 'the one write is team-config.json');
  const written = JSON.parse(fs.readFileSync(cfgPathFor(env.root), 'utf8'));
  assert.ok(!written.columns.some((c) => c.status === 'ux-review'), 'config no longer lists ux-review');
  // And the live tickets are untouched (still holding ux-review; files never written)
  assert.equal(tab.tasks.tickets.size, 2);
  for (const tk of tab.tasks.tickets.values()) assert.equal(tk.fm.status, 'ux-review');
});

test('Scenario (edge): cancelling the removal confirmation keeps the column and writes nothing', async () => {
  const env = makeEnv({ confirm: false }); // window.confirm → false
  const withUx = teamConfig.defaultConfig();
  withUx.columns.push({ status: 'ux-review', label: 'UX Review', description: '', agent: null, system: false });
  seedConfig(env.root, teamConfig.serializeConfig(withUx));
  const B = loadBoard(env.window, env.document, env.console);
  const tab = makeTab(env.root, new Map());
  await B.refreshTeamBoard(tab);

  const uxRow = rows(tab.els.teamBoardBody).find((r) => r.slug === 'ux-review').row;
  await fire(findByClass(uxRow, 'team-column-remove'), 'click');

  assert.equal(env.confirmCalls.length, 1, 'confirmation was shown');
  assert.ok(rows(tab.els.teamBoardBody).some((r) => r.slug === 'ux-review'), 'column kept on cancel');
  assert.equal(env.writes.length, 0, 'nothing written on cancel');
});

// ===========================================================================
// Scenario: Duplicate slug rejected (failure)
//   When the user adds a column whose derived slug is "testing"
//   Then an inline error is shown and nothing is written
// ===========================================================================
test('Scenario (failure): a column whose derived slug is "testing" is rejected inline with no write', async () => {
  const env = makeEnv();
  seedConfig(env.root);
  const B = loadBoard(env.window, env.document, env.console);
  const tab = makeTab(env.root);
  await B.refreshTeamBoard(tab);
  const before = rows(tab.els.teamBoardBody).map((r) => r.slug);

  // When the user types "Testing" (derives the reserved slug "testing") and Adds
  const af = addForm(tab.els.teamBoardBody);
  af.label.value = 'Testing';
  await fire(af.label, 'input');
  assert.equal(af.slug.value, 'testing', 'derived slug is "testing"');
  await fire(af.addBtn, 'click');

  // Then an inline error is shown...
  const af2 = addForm(tab.els.teamBoardBody);
  assert.ok(!af2.err.classList.contains('hidden'), 'the error line is visible');
  assert.match(af2.err.textContent, /reserved/i, 'error explains the reserved slug');
  // ...and NOTHING was added to the model
  assert.deepEqual(rows(tab.els.teamBoardBody).map((r) => r.slug), before, 'no column added');

  // And nothing is written (the user never got as far as Save, and Add mutated
  // nothing) — the model is not even dirty.
  assert.equal(env.writes.length, 0, 'no file written by a rejected Add');
  assert.notEqual(tab.teamBoard.dirty, true, 'rejected Add does not dirty the model');
});

// ===========================================================================
// Scenario: Corrupt config file (failure)
//   Given invalid JSON in team-config.json
//   Then the editor loads defaults with a notice and can save a repaired file
// ===========================================================================
test('Scenario (failure): a corrupt config loads the defaults with a notice and Save writes a repaired file', async () => {
  // Given invalid JSON on disk
  const env = makeEnv();
  seedConfig(env.root, '{ this is : not valid json ]]');
  const B = loadBoard(env.window, env.document, env.console);
  const tab = makeTab(env.root);

  // When the Board panel loads
  await B.refreshTeamBoard(tab);

  // Then the editor loads the six system defaults with a non-blocking notice
  assert.deepEqual(rows(tab.els.teamBoardBody).map((r) => r.slug),
    ['todo', 'defining', 'in-progress', 'testing', 'post-processing', 'done'],
    'defaults loaded');
  assert.ok(tab.teamBoard.notice, 'a notice is set');
  assert.match(tab.teamBoard.notice, /not valid JSON/i);
  const noticeEl = findByClass(tab.els.teamBoardBody, 'team-board-notice');
  assert.ok(noticeEl && /not valid JSON/i.test(noticeEl.textContent), 'notice rendered in the panel');

  // And the user can Save a repaired file: the corrupt JSON is overwritten with a
  // valid, normalized config.
  await B.saveTeamBoardConfig(tab);
  await flush();
  const repaired = JSON.parse(fs.readFileSync(cfgPathFor(env.root), 'utf8')); // must not throw
  assert.deepEqual(repaired.columns.map((c) => c.status),
    ['todo', 'defining', 'in-progress', 'testing', 'post-processing', 'done']);
  // The lib authority accepts the repaired file without column repairs.
  const libNorm = teamConfig.normalizeConfig(repaired);
  assert.deepEqual((libNorm.warnings || []).filter((w) => /column/i.test(w)), []);
});

// ===========================================================================
// Scenario: Agent select (AC — no silent loss of a removed agent)
//   Given a saved column whose display agent no longer exists in .claude/agents/
//   Then the select still offers "(none)" + the real agents AND keeps the missing
//   agent selected, flagged "(missing)" with a warning.
// ===========================================================================
test('Scenario (edge): a saved agent no longer present is kept selected as "(missing)" with a warning; select lists (none) + real agents', async () => {
  const env = makeEnv();
  // Given .claude/agents/ has ba.md and orchestrate.md on disk...
  const agentsDir = path.join(env.root, '.claude', 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, 'ba.md'), '---\nname: ba\n---\n');
  fs.writeFileSync(path.join(agentsDir, 'orchestrate.md'), '---\nname: orchestrate\n---\n');
  // ...and a config whose ux-review column names a now-deleted agent "ghost".
  const cfg = teamConfig.defaultConfig();
  cfg.columns.push({ status: 'ux-review', label: 'UX Review', description: '', agent: 'ghost', system: false });
  seedConfig(env.root, teamConfig.serializeConfig(cfg));

  const B = loadBoard(env.window, env.document, env.console);
  const tab = makeTab(env.root);
  await B.refreshTeamBoard(tab);

  const uxRow = rows(tab.els.teamBoardBody).find((r) => r.slug === 'ux-review').row;
  const select = findByClass(uxRow, 'team-column-agent-select');
  const optionTexts = select.children.map((o) => o.textContent);
  // Then the select offers "(none)" + every real agent...
  assert.ok(optionTexts.includes('(none)'), 'offers (none)');
  assert.ok(optionTexts.includes('ba') && optionTexts.includes('orchestrate'), 'lists real agents');
  // ...and retains the missing agent as a selected "(missing)" option (no silent loss)
  assert.ok(optionTexts.includes('ghost (missing)'), 'missing agent retained as (missing)');
  assert.equal(select.value, 'ghost', 'the missing agent stays selected');
  assert.ok(findByClass(uxRow, 'team-column-agent-warning'), 'a warning is shown for the missing agent');
});
