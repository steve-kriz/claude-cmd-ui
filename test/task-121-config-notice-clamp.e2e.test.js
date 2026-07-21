'use strict';

// ===========================================================================
// TASK-121 — e2e "cucumber" scenarios (Given/When/Then), implemented as plain
// `node --test` cases. NO cucumber npm package is installed or required; these
// are scenario-style node:test cases in Given/When/Then form.
//
// Feature: TASK-103 review follow-ups on the Team tab Board panel column
// manager over <folder>/tasks/team-config.json.
//   F1  A valid-JSON-but-non-config file (a bare number / string / array /
//       null, or an object whose `columns` is present but not an array) loads
//       the six default lanes AND now raises the non-blocking "not a valid
//       board config" notice, so the user is warned before a Save overwrites
//       their file. An object with `columns` absent, or a valid `columns`
//       array, stays notice-free. The JSON.parse-throw /not valid JSON/ notice
//       is preserved. A valid config loads and Saves unchanged.
//   F2  A column-manager Save clamps skill.concurrencyDefault to [1,8].
//
// The subject under test is the REAL renderer code (renderer/renderer.js — a
// browser script with no module.exports): refreshTeamBoard / renderTeamBoard /
// saveTeamBoardConfig / tasksSerializeTeamConfig and their pure helpers are
// EXTRACTED headless by brace-matching the source and evaluated with an
// INJECTED window / document / console.
//
// ALL filesystem access is a FULLY IN-MEMORY window.api.fs mock (a path→content
// map); the written config is asserted by parsing the recorded write. The DOM is
// the shared mock from test/helpers/task-101-lane-harness.js. NO real DATABASE /
// DISK / ELECTRON / NETWORK.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  rendererSrc, makeEl, makeDocument, findByClass, findAllByClass,
} = require('./helpers/task-101-lane-harness');

const teamConfig = require('../lib/team-config.js');

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
    'return { refreshTeamBoard, renderTeamBoard, saveTeamBoardConfig,',
    '  tasksSerializeTeamConfig, normalizeTasksColumns };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function('window', 'document', 'console', body)(window, document, console);
}

const SIX_DEFAULTS = ['todo', 'defining', 'in-progress', 'testing', 'post-processing', 'done'];
const CFG_PATH = 'C:\\proj\\tasks\\team-config.json';

// A fully in-memory window.api.fs mock: `content` is the team-config.json body
// (undefined ⇒ readFile fails, modelling a missing file). Every writeFile is
// recorded so a scenario can assert exactly what was persisted. NO real disk.
function makeEnv(opts) {
  const o = opts || {};
  const writes = [];
  const store = { content: o.content };
  const window = {
    confirm() { return o.confirm !== false; },
    api: {
      fs: {
        async findByExt() { return { ok: true, files: [] }; },
        async readFile(fp) {
          if (fp !== CFG_PATH || store.content === undefined) return { ok: false, error: 'ENOENT' };
          return { ok: true, content: store.content };
        },
        async writeFile(fp, content) {
          writes.push({ path: fp, content });
          if (fp === CFG_PATH) store.content = content; // persist for a re-read
          return { ok: true };
        },
        async mkdir() { return { ok: true }; },
      },
    },
  };
  const console = { error() {}, warn() {}, log() {} };
  return { window, console, document: makeDocument(), writes, store };
}

function makeTab() {
  return {
    folder: 'C:\\proj',
    els: { teamBoardBody: makeEl('div'), teamBoardSaveBtn: makeEl('button') },
    tasks: { tickets: new Map() },
  };
}

// Flush the un-awaited trailing refreshTeamBoard() that saveTeamBoardConfig kicks
// off, so no async work escapes the test.
const flush = () => new Promise((r) => setImmediate(r));

function rowSlugs(body) {
  return findAllByClass(body, 'team-column').map((row) => findByClass(row, 'team-column-slug').textContent);
}

// ===========================================================================
// Scenario: a valid-JSON non-config value warns before it silently resets
//   Given tasks/team-config.json holds valid JSON that is NOT a board config
//   When the Board panel loads
//   Then the six default lanes load AND a "not a valid board config" notice shows
// ===========================================================================
test('Scenario (F1): a bare number / string / array / null each load the six defaults WITH the "not a valid board config" notice', async () => {
  for (const raw of ['42', '"a-string"', '[1,2,3]', 'null']) {
    // Given a valid-JSON but non-config file on (mocked) disk
    const env = makeEnv({ content: raw });
    const B = loadBoard(env.window, env.document, env.console);
    const tab = makeTab();

    // When the Board panel loads
    await B.refreshTeamBoard(tab);

    // Then the six default lanes load...
    assert.deepEqual(rowSlugs(tab.els.teamBoardBody), SIX_DEFAULTS, `defaults for ${raw}`);
    // ...and the config-shape notice is set on the model AND rendered in the panel
    assert.match(tab.teamBoard.notice || '', /not a valid board config/i, `notice set for ${raw}`);
    const noticeEl = findByClass(tab.els.teamBoardBody, 'team-board-notice');
    assert.ok(noticeEl && /not a valid board config/i.test(noticeEl.textContent),
      `notice rendered for ${raw}`);
  }
});

test('Scenario (F1): an object whose `columns` is present but NOT an array loads defaults WITH the notice', async () => {
  // Given { "columns": "not-array" }
  const env = makeEnv({ content: '{"version":1,"columns":"not-array"}' });
  const B = loadBoard(env.window, env.document, env.console);
  const tab = makeTab();

  // When the Board panel loads
  await B.refreshTeamBoard(tab);

  // Then defaults load and the notice fires
  assert.deepEqual(rowSlugs(tab.els.teamBoardBody), SIX_DEFAULTS);
  assert.match(tab.teamBoard.notice || '', /not a valid board config/i);
  const noticeEl = findByClass(tab.els.teamBoardBody, 'team-board-notice');
  assert.ok(noticeEl && /not a valid board config/i.test(noticeEl.textContent));
});

// ===========================================================================
// Scenario: the ordinary defaults fallbacks stay notice-free
// ===========================================================================
test('Scenario (F1): an object with `columns` ABSENT loads defaults with NO notice', async () => {
  // Given a config object with no columns key (an ordinary first-run object)
  const env = makeEnv({ content: '{"version":1,"skill":{}}' });
  const B = loadBoard(env.window, env.document, env.console);
  const tab = makeTab();

  // When it loads
  await B.refreshTeamBoard(tab);

  // Then defaults load and NO notice is shown
  assert.deepEqual(rowSlugs(tab.els.teamBoardBody), SIX_DEFAULTS);
  assert.equal(tab.teamBoard.notice, null, 'no notice when columns is absent');
  assert.equal(findByClass(tab.els.teamBoardBody, 'team-board-notice'), null, 'no notice element rendered');
});

test('Scenario (F1): a valid `columns` array loads with NO notice', async () => {
  // Given a config with a valid (array) columns
  const env = makeEnv({
    content: JSON.stringify({ version: 1, columns: [{ status: 'todo', label: 'To Do', system: true }] }),
  });
  const B = loadBoard(env.window, env.document, env.console);
  const tab = makeTab();

  // When it loads
  await B.refreshTeamBoard(tab);

  // Then the defaults render (normalize re-injects the six) with NO notice
  assert.deepEqual(rowSlugs(tab.els.teamBoardBody), SIX_DEFAULTS);
  assert.equal(tab.teamBoard.notice, null, 'a valid columns array is notice-free');
});

// ===========================================================================
// Scenario (failure): a corrupt (unparseable) file still notices /not valid JSON/
// ===========================================================================
test('Scenario (F1 failure): unparseable JSON preserves the /not valid JSON/ notice (not the config-shape one)', async () => {
  // Given invalid JSON on disk
  const env = makeEnv({ content: '{ this is : not valid json ]]' });
  const B = loadBoard(env.window, env.document, env.console);
  const tab = makeTab();

  // When it loads
  await B.refreshTeamBoard(tab);

  // Then defaults load with the JSON-parse notice — and NOT the config-shape one
  assert.deepEqual(rowSlugs(tab.els.teamBoardBody), SIX_DEFAULTS);
  assert.match(tab.teamBoard.notice || '', /not valid JSON/i);
  assert.doesNotMatch(tab.teamBoard.notice || '', /not a valid board config/i);
  const noticeEl = findByClass(tab.els.teamBoardBody, 'team-board-notice');
  assert.ok(noticeEl && /not valid JSON/i.test(noticeEl.textContent));
});

// ===========================================================================
// Scenario: a valid config loads and Saves unchanged (no spurious notice)
// ===========================================================================
test('Scenario (F1): a valid config loads with no notice and Saves unchanged', async () => {
  // Given a real, valid default config on disk
  const valid = teamConfig.serializeConfig(teamConfig.defaultConfig());
  const env = makeEnv({ content: valid });
  const B = loadBoard(env.window, env.document, env.console);
  const tab = makeTab();

  // When it loads
  await B.refreshTeamBoard(tab);
  assert.equal(tab.teamBoard.notice, null, 'valid config → no notice');
  assert.deepEqual(rowSlugs(tab.els.teamBoardBody), SIX_DEFAULTS);

  // When the user Saves
  await B.saveTeamBoardConfig(tab);
  await flush();

  // Then exactly one write to team-config.json holding the six columns
  assert.equal(env.writes.length, 1, 'exactly one file written');
  assert.equal(env.writes[0].path, CFG_PATH);
  const written = JSON.parse(env.writes[0].content);
  assert.deepEqual(written.columns.map((c) => c.status), SIX_DEFAULTS);
  // The lib authority accepts it without column repairs.
  const libNorm = teamConfig.normalizeConfig(written);
  assert.deepEqual((libNorm.warnings || []).filter((w) => /column/i.test(w)), []);
});

// ===========================================================================
// Scenario (F2): a Save clamps an out-of-range build concurrency
//   Given a config whose skill.concurrencyDefault is 99
//   When the user Saves the board config
//   Then the written file holds a clamped concurrencyDefault of 8
// ===========================================================================
test('Scenario (F2): skill.concurrencyDefault 99 is clamped to 8 on Save', async () => {
  // Given a config with an out-of-range concurrency default
  const cfg = teamConfig.defaultConfig();
  cfg.skill = { concurrencyDefault: 99 };
  const env = makeEnv({ content: JSON.stringify(cfg) });
  const B = loadBoard(env.window, env.document, env.console);
  const tab = makeTab();

  // When it loads and the user Saves
  await B.refreshTeamBoard(tab);
  await B.saveTeamBoardConfig(tab);
  await flush();

  // Then the persisted concurrencyDefault is clamped to the [1,8] max
  const written = JSON.parse(env.writes[env.writes.length - 1].content);
  assert.equal(written.skill.concurrencyDefault, 8, '99 → 8 on Save');
});

test('Scenario (F2): skill.concurrencyDefault 0 is clamped up to 1 on Save', async () => {
  const cfg = teamConfig.defaultConfig();
  cfg.skill = { concurrencyDefault: 0 };
  const env = makeEnv({ content: JSON.stringify(cfg) });
  const B = loadBoard(env.window, env.document, env.console);
  const tab = makeTab();

  await B.refreshTeamBoard(tab);
  await B.saveTeamBoardConfig(tab);
  await flush();

  const written = JSON.parse(env.writes[env.writes.length - 1].content);
  assert.equal(written.skill.concurrencyDefault, 1, '0 → 1 on Save');
});

test('Scenario (F2): a valid in-range concurrencyDefault round-trips unchanged through a Save', async () => {
  const cfg = teamConfig.defaultConfig();
  cfg.skill = { concurrencyDefault: 5 };
  const env = makeEnv({ content: JSON.stringify(cfg) });
  const B = loadBoard(env.window, env.document, env.console);
  const tab = makeTab();

  await B.refreshTeamBoard(tab);
  await B.saveTeamBoardConfig(tab);
  await flush();

  const written = JSON.parse(env.writes[env.writes.length - 1].content);
  assert.equal(written.skill.concurrencyDefault, 5, '5 round-trips unchanged');
});
