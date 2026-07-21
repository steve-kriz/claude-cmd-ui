'use strict';

// ===========================================================================
// TASK-121 — UNIT tests for the TASK-103 review follow-ups, driven against the
// REAL renderer/renderer.js source (no replica).
//
//   F1  refreshTeamBoard's corrupt-config classification predicate: after a
//       successful JSON.parse, the non-blocking "not a valid board config"
//       notice fires when the parsed value is NOT a plain object (number /
//       string / boolean / array / null) OR is an object whose `columns` key is
//       present but not an array. It must NOT fire for a missing / unreadable /
//       empty file, an object with `columns` absent, or a valid `columns` array
//       (the ordinary six-default fallback). The JSON.parse-throw notice
//       (/not valid JSON/) is preserved.
//
//   F2  tasksSerializeTeamConfig now clamps skill.concurrencyDefault through
//       resolveTasksConcurrency to [1, TASKS_MAX_CONCURRENCY=8], matching lib
//       serializeConfig; an absent default is left absent.
//
// renderer.js is a browser script (no module.exports, references document/
// window), so — matching test/task-103-column-manager.test.js — the functions
// under test are EXTRACTED by brace-matching and evaluated in a sandbox with an
// injected window/document/console. window.api.fs is fully mocked in-memory and
// the DOM is the shared mock. NO DATABASE / DISK / ELECTRON / NETWORK.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  rendererSrc, makeEl, makeDocument,
} = require('./helpers/task-101-lane-harness');

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

// Load the REAL Board-panel column manager headless (refreshTeamBoard + its
// render chain, tasksSerializeTeamConfig + the F2 clamp helpers).
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
    'return { refreshTeamBoard, tasksSerializeTeamConfig, normalizeTasksColumns,',
    '  resolveTasksConcurrency, TASKS_MAX_CONCURRENCY, TASKS_DEFAULT_CONCURRENCY };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function('window', 'document', 'console', body)(window, document, console);
}

const SIX_DEFAULTS = ['todo', 'defining', 'in-progress', 'testing', 'post-processing', 'done'];

// A fully in-memory window.api.fs mock. `content` (a string) is what readFile
// returns for the team-config.json path; `readOk` false models an unreadable
// file. findByExt returns no agents. NO real disk touched.
function makeWindow(opts) {
  const o = opts || {};
  return {
    confirm() { return true; },
    api: {
      fs: {
        async findByExt() { return { ok: true, files: [] }; },
        async readFile() {
          if (o.readOk === false) return { ok: false, error: 'ENOENT' };
          return { ok: true, content: o.content };
        },
        async writeFile() { return { ok: true }; },
        async mkdir() { return { ok: true }; },
      },
    },
  };
}

function makeTab() {
  return {
    folder: 'C:\\proj',
    els: { teamBoardBody: makeEl('div'), teamBoardSaveBtn: makeEl('button') },
    tasks: { tickets: new Map() },
  };
}

// Drive the REAL refreshTeamBoard with a given on-disk file content and return
// the resulting { notice, statuses }.
async function loadWith(content, extra) {
  const window = makeWindow(Object.assign({ content }, extra));
  const document = makeDocument();
  const console = { error() {}, warn() {}, log() {} };
  const B = loadBoard(window, document, console);
  const tab = makeTab();
  await B.refreshTeamBoard(tab);
  return {
    notice: tab.teamBoard && tab.teamBoard.notice,
    statuses: (tab.teamBoard ? tab.teamBoard.columns : []).map((c) => c.status),
  };
}

// A fresh serializer bound to a throwaway sandbox (only tasksSerializeTeamConfig
// + its F2 clamp deps are exercised).
function makeSerializer() {
  const window = makeWindow({ content: undefined });
  return loadBoard(window, makeDocument(), { error() {}, warn() {}, log() {} });
}

// ── F1: the corrupt-config classification predicate ─────────────────────────

test('unit F1: a valid-JSON non-object (number/string/boolean/array/null) sets the "not a valid board config" notice and loads the six defaults', async () => {
  for (const raw of ['42', '"hello"', 'true', '[1,2,3]', 'null']) {
    const { notice, statuses } = await loadWith(raw);
    assert.match(notice || '', /not a valid board config/i, `notice for ${raw}`);
    assert.deepEqual(statuses, SIX_DEFAULTS, `defaults loaded for ${raw}`);
  }
});

test('unit F1: an object whose `columns` key is present but not an array sets the notice and loads defaults', async () => {
  for (const raw of ['{"columns":"not-array"}', '{"columns":42}', '{"columns":{"a":1}}']) {
    const { notice, statuses } = await loadWith(raw);
    assert.match(notice || '', /not a valid board config/i, `notice for ${raw}`);
    assert.deepEqual(statuses, SIX_DEFAULTS, `defaults for ${raw}`);
  }
});

test('unit F1: an object with `columns` ABSENT loads defaults with NO notice (ordinary first-run fallback)', async () => {
  const { notice, statuses } = await loadWith('{"version":1,"skill":{}}');
  assert.equal(notice, null, 'no notice when columns is simply absent');
  assert.deepEqual(statuses, SIX_DEFAULTS);
});

test('unit F1: an object with a valid `columns` array loads with NO notice', async () => {
  const cfg = JSON.stringify({
    version: 1,
    columns: [{ status: 'todo', label: 'To Do', system: true }],
  });
  const { notice } = await loadWith(cfg);
  assert.equal(notice, null, 'a present, array-valued columns is notice-free');
});

test('unit F1: `columns: null` is treated as absent (== null) — NO notice', async () => {
  const { notice, statuses } = await loadWith('{"columns":null}');
  assert.equal(notice, null, 'columns:null is the absent case (raw.columns != null is false)');
  assert.deepEqual(statuses, SIX_DEFAULTS);
});

test('unit F1: unparseable JSON preserves the /not valid JSON/ notice (not the config-shape one)', async () => {
  const { notice, statuses } = await loadWith('{ not : valid json ]]');
  assert.match(notice || '', /not valid JSON/i);
  assert.doesNotMatch(notice || '', /not a valid board config/i);
  assert.deepEqual(statuses, SIX_DEFAULTS);
});

test('unit F1: a missing/unreadable file loads defaults with NO notice', async () => {
  const { notice, statuses } = await loadWith(undefined, { readOk: false });
  assert.equal(notice, null, 'no notice for a missing/unreadable file');
  assert.deepEqual(statuses, SIX_DEFAULTS);
});

test('unit F1: an empty / whitespace-only file loads defaults with NO notice', async () => {
  for (const raw of ['', '   ', '\n\t ']) {
    const { notice, statuses } = await loadWith(raw);
    assert.equal(notice, null, `no notice for empty content ${JSON.stringify(raw)}`);
    assert.deepEqual(statuses, SIX_DEFAULTS);
  }
});

// ── F2: the concurrencyDefault clamp (via the real serializer) ───────────────

function serializeWithConcurrency(S, value) {
  const model = { version: 1, skill: value === undefined ? {} : { concurrencyDefault: value }, columns: [] };
  return JSON.parse(S.tasksSerializeTeamConfig(model));
}

test('unit F2: skill.concurrencyDefault is clamped to [1,8] on serialize', () => {
  const S = makeSerializer();
  const cases = [
    [99, 8], [8, 8], [9, 8],
    [0, 1], [-5, 1], [1, 1],
    [2.9, 2], [3.2, 3], [5, 5],
  ];
  for (const [input, expected] of cases) {
    assert.equal(serializeWithConcurrency(S, input).skill.concurrencyDefault, expected,
      `${input} → ${expected}`);
  }
});

test('unit F2: junk (non-numeric string) falls back to TASKS_DEFAULT_CONCURRENCY (3)', () => {
  const S = makeSerializer();
  assert.equal(serializeWithConcurrency(S, 'junk').skill.concurrencyDefault, 3);
  assert.equal(S.TASKS_DEFAULT_CONCURRENCY, 3, 'sanity: default is 3');
  assert.equal(S.TASKS_MAX_CONCURRENCY, 8, 'sanity: max is 8');
});

test('unit F2: an ABSENT concurrencyDefault is left absent (a valid config round-trips unchanged)', () => {
  const S = makeSerializer();
  const out = serializeWithConcurrency(S, undefined);
  assert.ok(!('concurrencyDefault' in out.skill), 'no concurrencyDefault key is injected');
});

test('unit F2: an in-range concurrencyDefault round-trips unchanged', () => {
  const S = makeSerializer();
  assert.equal(serializeWithConcurrency(S, 4).skill.concurrencyDefault, 4);
});

test('unit F2 (direct): resolveTasksConcurrency implements the [1,8] clamp used by the serializer', () => {
  const S = makeSerializer();
  assert.equal(S.resolveTasksConcurrency(99), 8);
  assert.equal(S.resolveTasksConcurrency(0), 1);
  assert.equal(S.resolveTasksConcurrency(-5), 1);
  assert.equal(S.resolveTasksConcurrency(2.9), 2);
  assert.equal(S.resolveTasksConcurrency('junk'), 3);
  assert.equal(S.resolveTasksConcurrency(null), 3);
});
