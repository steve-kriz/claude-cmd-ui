'use strict';

// ===========================================================================
// TASK-203 — e2e "cucumber" scenarios (Given/When/Then), implemented as plain
// `node --test` cases. NO cucumber npm package is installed or required; these
// are scenario-style node:test cases in Given/When/Then form, implementing the
// ticket's own Gherkin feature: "Workflow panel removal".
//
// Feature: with the phase system retired (TASK-201) and its two surviving
// controls relocated into the Board panel (TASK-202), the Team tab's Workflow
// panel and all phase-link machinery are dead weight and have been removed —
// the Board panel is now the single board-config panel.
//
// The subject under test is the REAL renderer code (renderer/renderer.js — a
// browser script with no module.exports) plus renderer/index.html, exercised
// two ways:
//   - Scenario 1 and the failure-guard scenario 5 SOURCE-SCAN renderer.js /
//     index.html as text (the repo convention for browser files that cannot be
//     require()'d — see test/task-091-team-tab-scaffold.e2e.test.js).
//   - Scenarios 2-4 EXTRACT the real refreshTeamBoard / renderTeamBoard /
//     saveTeamBoardConfig / buildWorkflowConcurrencyControl /
//     buildWorkflowContextOptimizationControl / refreshTeamAgents headless by
//     brace-matching the source (the test-103/test-094 convention) and drive
//     them with an INJECTED window/document/console + a stubbed window.api.fs
//     backed by a real TEMP directory (so the written config can be asserted
//     by parsing it off disk).
//
// NO DATABASE, DISK WRITE outside a per-test os.tmpdir() TEMP DIR, ELECTRON
// RUNTIME, OR NETWORK CALL IS MADE. Every DOM object is a plain in-memory mock
// (reused from test/helpers/task-101-lane-harness.js without modification).
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  rendererSrc, makeEl, makeDocument, findByClass,
} = require('./helpers/task-101-lane-harness');

const REPO = path.join(__dirname, '..');
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

// Load the REAL Board-panel column manager + relocated controls headless,
// mirroring the test-103/test-202 harness. Function declarations hoist, so
// only the const declarations need ordering.
function loadBoard(window, document, console) {
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
    extractFn(rendererSrc, 'tasksSlugForLabel'),
    extractFn(rendererSrc, 'tasksValidateNewColumn'),
    extractConst(rendererSrc, 'TASKS_CONTEXT_OPT_LEVELS'),
    extractConst(rendererSrc, 'TASKS_CONTEXT_OPT_DEFAULT'),
    extractFn(rendererSrc, 'tasksNormalizeContextOptimization'),
    extractFn(rendererSrc, 'tasksSerializeTeamConfig'),
    extractConst(rendererSrc, 'TASKS_UNSAFE_KEYS'),
    extractFn(rendererSrc, 'tasksIsUnsafeKey'),
    extractFn(rendererSrc, 'inferSep'),
    extractFn(rendererSrc, 'appendPath'),
    extractFn(rendererSrc, 'tasksJoin'),
    extractFn(rendererSrc, 'tasksBasename'),
    extractFn(rendererSrc, 'readTeamAgentNames'),
    extractFn(rendererSrc, 'countTeamTicketsForStatus'),
    extractFn(rendererSrc, 'refreshTeamBoard'),
    extractFn(rendererSrc, 'buildWorkflowConcurrencyControl'),
    extractFn(rendererSrc, 'buildWorkflowContextOptimizationControl'),
    extractFn(rendererSrc, 'renderTeamBoard'),
    extractFn(rendererSrc, 'canSwapTeamColumns'),
    extractFn(rendererSrc, 'buildTeamColumnRow'),
    extractFn(rendererSrc, 'markTeamBoardDirty'),
    extractFn(rendererSrc, 'buildTeamAddColumnForm'),
    extractFn(rendererSrc, 'saveTeamBoardConfig'),
    extractFn(rendererSrc, 'refreshTeamAgents'),
    extractFn(rendererSrc, 'buildAgentsInstallHint'),
    'return { refreshTeamBoard, renderTeamBoard, buildTeamColumnRow,',
    '  buildTeamAddColumnForm, saveTeamBoardConfig, refreshTeamAgents,',
    '  normalizeTasksColumns };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function('window', 'document', 'console', body)(window, document, console);
}

// A stubbed window.api.fs backed by a real temp dir (task-103 convention).
function makeEnv(opts) {
  const o = opts || {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task203-'));
  const writes = [];
  const window = {
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
        async exists(p) {
          return { ok: true, exists: fs.existsSync(p) };
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
      tasks: {
        async installSkill() { return { ok: true }; },
      },
    },
  };
  const errors = [];
  const console = { error: (...a) => errors.push(a), warn() {}, log() {} };
  return { root, window, console, errors, document: makeDocument(), writes };
}

const cfgPathFor = (root) => path.join(root, 'tasks', 'team-config.json');

function seedConfig(root, cfg) {
  const dir = path.join(root, 'tasks');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'team-config.json'), cfg);
}

function makeTab(root) {
  return {
    folder: root,
    els: {
      teamBoardBody: makeEl('div'),
      teamBoardSaveBtn: makeEl('button'),
      teamAgentsBody: makeEl('div'),
    },
    tasks: { tickets: new Map() },
  };
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
}

// ===========================================================================
// Scenario: the Team tab has no Workflow panel
//   Given a project folder is open
//   When the user opens the Team tab
//   Then only the Agents and Board sections are shown
//   And no element with the Workflow panel body exists
// ===========================================================================
test('Scenario: the Team tab has no Workflow panel — only Agents, Integrations and Board sections are shown', () => {
  // Given the Team tab markup in renderer/index.html
  const vStart = htmlSrc.indexOf('data-view="team"');
  assert.notEqual(vStart, -1, 'the Team tab-view exists');
  const vClose = htmlSrc.indexOf('</template>', vStart);
  assert.notEqual(vClose, -1, 'the workspace <template> close bounds the Team panel');
  const panel = htmlSrc.slice(vStart, vClose);

  // When the user opens the Team tab (its static markup is what renders)
  // Then only the Agents, Integrations and Board sections are shown ...
  assert.match(panel, /class="teamAgentsSection[^"]*"/, 'the Agents section exists');
  assert.match(panel, /class="teamIntegrationsSection[^"]*"/, 'the Integrations section exists');
  assert.match(panel, /class="teamBoardSection[^"]*"/, 'the Board section exists');
  const sectionCount = (panel.match(/team-section"/g) || []).length;
  assert.equal(sectionCount, 3, 'exactly three team-section blocks render (Agents + Integrations + Board)');

  // ... and no element with the Workflow panel body — or any Workflow element —
  // exists anywhere in the Team panel.
  assert.ok(!panel.includes('teamWorkflowSection'), 'no teamWorkflowSection element exists');
  assert.ok(!panel.includes('teamWorkflowBody'), 'no teamWorkflowBody element exists');
  assert.ok(!panel.includes('teamWorkflowRefresh'), 'no teamWorkflowRefresh element exists');
  assert.ok(!/Workflow/.test(panel), 'no "Workflow" text appears anywhere in the Team panel');
});

// ===========================================================================
// Scenario: board-config settings live only in the Board panel
//   Given the Team tab is open
//   Then the Build concurrency default and Context optimisation controls
//        appear in the Board panel
//   And they do not appear in any Workflow panel
// ===========================================================================
test('Scenario: board-config settings live only in the Board panel', async () => {
  // Given a project folder is open and the Team tab's Board panel loads.
  const env = makeEnv();
  try {
    seedConfig(env.root, JSON.stringify({ version: 1, columns: [], skill: { concurrencyDefault: 3 } }) + '\n');
    const Board = loadBoard(env.window, env.document, env.console);
    const tab = makeTab(env.root);

    // When the Board panel refreshes and renders (the Team tab's Board section).
    await Board.refreshTeamBoard(tab);

    // Then the Build concurrency default control appears IN the Board body ...
    const concurrency = findByClass(tab.els.teamBoardBody, 'team-workflow-concurrency');
    assert.ok(concurrency, 'the Build concurrency default control is mounted in the Board panel');
    // ... and the Context optimisation control appears IN the Board body too.
    const contextOpt = findByClass(tab.els.teamBoardBody, 'team-workflow-context-opt');
    assert.ok(contextOpt, 'the Context optimisation control is mounted in the Board panel');

    // And there is no Workflow panel anywhere for them to ALSO appear in — the
    // tab carries no teamWorkflowBody element at all, and the Board body is the
    // ONLY place these controls are rendered (source-scan: renderTeamBoard is
    // their sole call site in the whole renderer).
    assert.equal(tab.els.teamWorkflowBody, undefined, 'the tab has no teamWorkflowBody element');
    const callSites = rendererSrc.split('buildWorkflowConcurrencyControl(').length - 1;
    // Exactly two occurrences: the function's own `function buildWorkflowConcurrencyControl(`
    // declaration plus its single call site inside renderTeamBoard.
    assert.equal(callSites, 2, 'buildWorkflowConcurrencyControl has exactly one call site (in the Board panel)');
  } finally { cleanup(env.root); }
});

// ===========================================================================
// Scenario: no phase auto-enable runs on Board save
//   Given the user edits a column and clicks Save on the Board panel
//   When the config is written
//   Then no phase link count is computed
//   And the written config has no skill.phases
// ===========================================================================
test('Scenario: no phase auto-enable runs on Board save — no phase link count computed, no skill.phases written', async () => {
  // Given a project folder whose Board panel is loaded with one user column.
  const env = makeEnv();
  try {
    seedConfig(env.root, JSON.stringify({
      version: 1,
      columns: [{ status: 'ux-review', label: 'UX Review', description: '' }],
      skill: { concurrencyDefault: 3 },
    }) + '\n');
    const Board = loadBoard(env.window, env.document, env.console);
    const tab = makeTab(env.root);
    await Board.refreshTeamBoard(tab);

    // When the user edits a column (marks the board dirty) and clicks Save.
    const col = tab.teamBoard.columns.find((c) => c.status === 'ux-review');
    assert.ok(col, 'precondition: the ux-review column loaded');
    col.description = 'edited description';
    tab.teamBoard.dirty = true;
    await Board.saveTeamBoardConfig(tab);

    // Then the config is written ...
    const persisted = JSON.parse(fs.readFileSync(cfgPathFor(env.root), 'utf8'));
    const persistedCol = persisted.columns.find((c) => c.status === 'ux-review');
    assert.ok(persistedCol, 'the edited column was written');
    assert.equal(persistedCol.description, 'edited description', 'the edit was saved');

    // ... and no phase link count is computed — the phase-link machinery
    // (tasksApplyPhaseAutoEnable / tasksPhaseLinkCounts) no longer exists in the
    // renderer at all, so nothing could have computed one.
    assert.equal(rendererSrc.indexOf('tasksApplyPhaseAutoEnable'), -1,
      'tasksApplyPhaseAutoEnable does not exist in renderer.js');
    assert.equal(rendererSrc.indexOf('tasksPhaseLinkCounts'), -1,
      'tasksPhaseLinkCounts does not exist in renderer.js');

    // ... and the written config has no skill.phases anywhere.
    assert.equal('phases' in (persisted.skill || {}), false, 'the written config has no skill.phases');
    assert.equal(persistedCol.phase, undefined, 'the written column has no phase key');
  } finally { cleanup(env.root); }
});

// ===========================================================================
// Scenario (edge): opening the Team tab produces no errors
//   Given a project folder with no SKILL.md installed
//   When the user opens the Team tab
//   Then the Board and Agents panels render without console errors
//   And no Workflow install banner is shown
// ===========================================================================
test('Scenario (edge): opening the Team tab with no SKILL.md installed produces no console errors and no Workflow install banner', async () => {
  // Given a project folder with NO .claude/skills/orchestrate/SKILL.md and no
  // .claude/agents/ directory at all (skill never installed).
  const env = makeEnv();
  try {
    const Board = loadBoard(env.window, env.document, env.console);
    const tab = makeTab(env.root);

    // When the user opens the Team tab: both the Board and Agents panels load.
    await assert.doesNotReject(() => Board.refreshTeamBoard(tab), 'Board panel refresh does not throw with no SKILL.md');
    await assert.doesNotReject(() => Board.refreshTeamAgents(tab), 'Agents panel refresh does not throw with no SKILL.md');

    // Then the Board and Agents panels render without console errors ...
    assert.equal(env.errors.length, 0, 'no console.error calls during either refresh');
    assert.ok(tab.els.teamBoardBody.children.length > 0 || tab.els.teamBoardBody.textContent, 'the Board body rendered something');

    // ... and no Workflow install banner is shown — there is no Workflow panel
    // left to show one, and the class it used to carry does not appear anywhere
    // in the rendered Board or Agents bodies.
    assert.equal(findByClass(tab.els.teamBoardBody, 'teamWorkflowInstallBtn'), null, 'no Workflow install button in the Board body');
    assert.equal(findByClass(tab.els.teamAgentsBody, 'teamWorkflowInstallBtn'), null, 'no Workflow install button in the Agents body');
  } finally { cleanup(env.root); }
});

// ===========================================================================
// Scenario (failure guard): refreshTeamWorkflow is fully unreferenced
//   Given the renderer bundle after this change
//   When the source is searched for refreshTeamWorkflow / teamWorkflowBody
//   Then there are no remaining references
// ===========================================================================
test('Scenario (failure guard): refreshTeamWorkflow / teamWorkflowBody are fully unreferenced in the renderer bundle', () => {
  // Given the renderer bundle (renderer.js) and the static markup (index.html)
  // after this change.
  // When the source is searched for refreshTeamWorkflow / teamWorkflowBody ...
  for (const needle of ['refreshTeamWorkflow', 'teamWorkflowBody', 'teamWorkflowSection', 'teamWorkflowRefresh']) {
    // Then there are no remaining references in either file.
    assert.equal(rendererSrc.includes(needle), false, `renderer.js has no reference to ${needle}`);
    assert.equal(htmlSrc.includes(needle), false, `index.html has no reference to ${needle}`);
  }
  // And the phase-specific render pipeline and its helpers are gone too.
  for (const needle of [
    'buildWorkflowView', 'buildWorkflowInstallHint', 'buildWorkflowPhase',
    'WF_PHASE_SPECS', 'wfNormalizePhaseConfig', 'wfSortedPhaseKeys', 'wfPhaseOrderWarnings',
    'tasksApplyPhaseAutoEnable', 'tasksPhaseLinkCounts', 'tasksNormalizeColumnPhase',
    'TASKS_PHASE_KEYS', 'TASKS_PHASE_ENABLED_DEFAULTS', 'baselinePhaseLinks',
  ]) {
    assert.equal(rendererSrc.includes(needle), false, `renderer.js has no reference to ${needle}`);
  }
  // But the two relocated Board-panel controls are KEPT (not collateral damage).
  assert.match(rendererSrc, /function buildWorkflowConcurrencyControl\(/, 'buildWorkflowConcurrencyControl is kept');
  assert.match(rendererSrc, /function buildWorkflowContextOptimizationControl\(/, 'buildWorkflowContextOptimizationControl is kept');
});
