'use strict';

// ===========================================================================
// TASK-128 — UNIT tests for the renderer team-config proto-key hardening
// (renderer mirror of the lib fix TASK-116).
//
// renderer/renderer.js is a browser script (no module.exports; references
// `document`/`window`), so — matching test/task-103-column-manager.test.js and
// test/task-114-mirror-sync-guard.test.js — the functions under test are
// EXTRACTED from the shipped source by brace-matching / regex and evaluated in
// a sandbox. This proves the ACTUAL shipped code, not a re-implementation.
//
// Under test (the three unknown-top-level-key copy loops that now skip
// __proto__/constructor/prototype via tasksIsUnsafeKey):
//   tasksSerializeTeamConfig  — the `out[k] = w.extra[k]` loop
//   refreshTeamBoard          — the `extra[k] = raw[k]` loop (parsed on-disk cfg)
//   buildWorkingConfigFromRaw — the `extra[k] = obj[k]` loop
// plus the renderer↔lib lockstep of TASKS_UNSAFE_KEYS vs lib UNSAFE_KEYS.
//
// CRITICAL test-construction rule (mirrors TASK-116): every malicious input is
// built via JSON.parse('...'), NEVER an object literal — a `{__proto__: x}`
// literal SETS the object's prototype and defines no OWN key, so it would test
// nothing. JSON.parse defines "__proto__" as an OWN enumerable key, which is the
// real on-disk hazard.
//
// NO DATABASE, DISK, ELECTRON, OR NETWORK: window.api.fs is fully mocked; the
// pure functions do no I/O.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');
const libSrc = fs.readFileSync(path.join(REPO, 'lib', 'team-config.js'), 'utf8');

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// --- Extract a named function declaration by brace-matching. ----------------
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
  assert.ok(m, `const ${name} found in ${name}`);
  return m[0];
}

// Load the REAL renderer functions headless. window / renderTeamBoard /
// tasksJoin / tasksBasename are INJECTED (they are DOM/IPC/path glue, not the
// code under test) so the extracted proto-key loops run against real logic.
function loadRenderer() {
  const body = [
    extractConst(rendererSrc, 'TASKS_LANE_STATUSES'),
    extractConst(rendererSrc, 'TASKS_VALID_STATUSES'),
    extractConst(rendererSrc, 'TASKS_UNKNOWN_STATUS'),
    extractConst(rendererSrc, 'TASKS_SYSTEM_LABELS'),
    extractConst(rendererSrc, 'TASKS_RESERVED_SLUGS'),
    extractConst(rendererSrc, 'TASKS_MAX_SLUG_LENGTH'),
    extractConst(rendererSrc, 'TASKS_SLUG_RE'),
    // TASK-180's `phase` link and TASK-183's phase-link machinery
    // (TASKS_PHASE_KEYS/TASKS_PHASE_ENABLED_DEFAULTS/tasksPhaseLinkCounts/
    // tasksNormalizeColumnPhase) were fully removed by TASK-201/203.
    extractConst(rendererSrc, 'TASKS_UNSAFE_KEYS'),
    extractConst(rendererSrc, 'TASKS_MAX_CONCURRENCY'),
    extractConst(rendererSrc, 'TASKS_DEFAULT_CONCURRENCY'),
    extractFn(rendererSrc, 'tasksIsUnsafeKey'),
    extractFn(rendererSrc, 'resolveTasksConcurrency'),
    extractFn(rendererSrc, 'tasksPrettifyLabel'),
    extractFn(rendererSrc, 'tasksBuildColumn'),
    extractFn(rendererSrc, 'normalizeTasksColumns'),
    // TASK-200 — tasksSerializeTeamConfig now normalises skill.contextOptimization
    // via tasksNormalizeContextOptimization, so these must be in scope too.
    extractConst(rendererSrc, 'TASKS_CONTEXT_OPT_LEVELS'),
    extractConst(rendererSrc, 'TASKS_CONTEXT_OPT_DEFAULT'),
    extractFn(rendererSrc, 'tasksNormalizeContextOptimization'),
    extractFn(rendererSrc, 'tasksSerializeTeamConfig'),
    extractFn(rendererSrc, 'buildWorkingConfigFromRaw'),
    extractFn(rendererSrc, 'readTeamAgentNames'),
    extractFn(rendererSrc, 'refreshTeamBoard'),
    'return { TASKS_UNSAFE_KEYS, tasksIsUnsafeKey, normalizeTasksColumns,',
    '  tasksSerializeTeamConfig, buildWorkingConfigFromRaw, refreshTeamBoard };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function('window', 'renderTeamBoard', 'tasksJoin', 'tasksBasename', body);
}
const factory = loadRenderer();

// Build a fresh renderer instance with a window.api.fs mock that returns
// `content` from readFile (no real disk). renderTeamBoard is a no-op recorder.
function makeRenderer(readFileContent) {
  const win = {
    api: {
      fs: {
        readFile: async () => ({ ok: true, binary: false, content: readFileContent }),
        findByExt: async () => ({ ok: true, files: [] }),
      },
    },
  };
  const rendered = [];
  const renderTeamBoard = (tab) => { rendered.push(tab); };
  const tasksJoin = (...parts) => parts.join('/');
  const tasksBasename = (p) => String(p || '');
  const R = factory(win, renderTeamBoard, tasksJoin, tasksBasename);
  R._rendered = rendered;
  return R;
}
const R = makeRenderer('{}');

// Extract the renderer TASKS_UNSAFE_KEYS and the lib UNSAFE_KEYS from SOURCE and
// evaluate each in isolation, for the lockstep-parity guard.
function evalSet(literal) {
  // eslint-disable-next-line no-new-func
  return new Function(literal + '\nreturn ' + literal.match(/const\s+(\w+)/)[1] + ';')();
}
const RENDERER_UNSAFE = evalSet(extractConst(rendererSrc, 'TASKS_UNSAFE_KEYS'));
const LIB_UNSAFE = evalSet(extractConst(libSrc, 'UNSAFE_KEYS'));

// ── Lockstep parity: renderer TASKS_UNSAFE_KEYS === lib UNSAFE_KEYS ──────────
test('TASKS_UNSAFE_KEYS mirrors lib/team-config.js UNSAFE_KEYS exactly (drift guard)', () => {
  assert.ok(RENDERER_UNSAFE instanceof Set);
  assert.ok(LIB_UNSAFE instanceof Set);
  assert.deepEqual(
    [...RENDERER_UNSAFE].sort(),
    [...LIB_UNSAFE].sort(),
    'renderer TASKS_UNSAFE_KEYS must equal lib UNSAFE_KEYS (kept in lockstep)',
  );
  // And the exact expected contents (guards a same-edit-to-both drift).
  assert.deepEqual([...RENDERER_UNSAFE].sort(), ['__proto__', 'constructor', 'prototype'].sort());
});

test('tasksIsUnsafeKey predicate agrees with the set membership', () => {
  for (const k of ['__proto__', 'constructor', 'prototype']) {
    assert.equal(R.tasksIsUnsafeKey(k), true, `${k} is unsafe`);
  }
  for (const k of ['version', 'columns', 'skill', 'customField', 'toString']) {
    assert.equal(R.tasksIsUnsafeKey(k), false, `${k} is safe`);
  }
});

// ── Loop 1: tasksSerializeTeamConfig (out[k] = w.extra[k]) ───────────────────
test('tasksSerializeTeamConfig: object-valued __proto__ in extra does not reach the serialized JSON', () => {
  const extra = JSON.parse('{"__proto__":{"polluted":1},"customField":"keep"}');
  const working = { version: 1, columns: [], skill: {}, extra };
  const out = R.tasksSerializeTeamConfig(working);
  const parsed = JSON.parse(out);

  assert.ok(!hasOwn(parsed, '__proto__'), 'no own __proto__ key in serialized config');
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype, 'parsed config prototype unchanged');
  assert.equal(parsed.polluted, undefined, 'no inherited pollution');
  assert.ok(!/"__proto__"/.test(out), 'serialized text carries no "__proto__" key');
  assert.equal(parsed.customField, 'keep', 'legit unknown key round-trips');
  assert.equal(({}).polluted, undefined, 'global Object.prototype untouched');
});

test('tasksSerializeTeamConfig: primitive __proto__ in extra is dropped, not round-tripped', () => {
  const extra = JSON.parse('{"__proto__":"evil","customField":"x"}');
  const out = R.tasksSerializeTeamConfig({ version: 1, columns: [], skill: {}, extra });
  const parsed = JSON.parse(out);
  assert.ok(!hasOwn(parsed, '__proto__'));
  assert.equal(parsed.customField, 'x');
});

test('tasksSerializeTeamConfig: constructor/prototype keys in extra are dropped', () => {
  const extra = JSON.parse('{"constructor":{"polluted":1},"prototype":{"polluted":2},"customField":"y"}');
  const out = R.tasksSerializeTeamConfig({ version: 1, columns: [], skill: {}, extra });
  const parsed = JSON.parse(out);
  assert.ok(!hasOwn(parsed, 'constructor'), 'no own constructor key');
  assert.ok(!hasOwn(parsed, 'prototype'), 'no own prototype key');
  assert.equal(parsed.constructor, Object, 'constructor still Object');
  assert.equal(parsed.customField, 'y');
  assert.ok(!/"constructor"|"prototype"/.test(out), 'serialized text carries no constructor/prototype keys');
});

// ── Loop 3: buildWorkingConfigFromRaw (extra[k] = obj[k]) ────────────────────
test('buildWorkingConfigFromRaw: object-valued __proto__ does not reassign extra prototype', () => {
  const raw = JSON.parse('{"__proto__":{"polluted":1},"version":1,"columns":[],"skill":{},"customField":"keep"}');
  const wc = R.buildWorkingConfigFromRaw(raw);

  assert.equal(Object.getPrototypeOf(wc.extra), Object.prototype, 'extra prototype stays Object.prototype');
  assert.equal(Object.getPrototypeOf(wc), Object.prototype, 'working model prototype stays Object.prototype');
  assert.ok(!hasOwn(wc.extra, '__proto__'), 'extra has no own __proto__ key');
  assert.equal(wc.extra.polluted, undefined, 'no inherited pollution on extra');
  assert.equal(wc.extra.customField, 'keep', 'legit unknown key round-trips');
  assert.equal(({}).polluted, undefined, 'global Object.prototype untouched');
});

test('buildWorkingConfigFromRaw: primitive __proto__ dropped; constructor/prototype dropped', () => {
  const raw = JSON.parse('{"__proto__":"evil","constructor":{"p":1},"prototype":{"q":2},"version":1,"columns":[],"customField":"z"}');
  const wc = R.buildWorkingConfigFromRaw(raw);
  assert.equal(Object.getPrototypeOf(wc.extra), Object.prototype);
  assert.ok(!hasOwn(wc.extra, '__proto__'));
  assert.ok(!hasOwn(wc.extra, 'constructor'));
  assert.ok(!hasOwn(wc.extra, 'prototype'));
  assert.equal(wc.extra.customField, 'z', 'legit unknown key survives');
});

// ── Loop 2: refreshTeamBoard (extra[k] = raw[k], parsed on-disk config) ──────
async function runRefresh(jsonString) {
  const inst = makeRenderer(jsonString);
  const boardBody = { textContent: '' };
  const tab = { folder: '/fake/project', els: { teamBoardBody: boardBody } };
  await inst.refreshTeamBoard(tab);
  return tab.teamBoard;
}

test('refreshTeamBoard: object-valued __proto__ in on-disk JSON does not reassign extra prototype', async () => {
  const tb = await runRefresh('{"__proto__":{"polluted":1},"version":1,"columns":[],"skill":{},"customField":"keep"}');
  assert.ok(tb, 'a working model is built');
  assert.equal(Object.getPrototypeOf(tb.extra), Object.prototype, 'extra prototype stays Object.prototype');
  assert.ok(!hasOwn(tb.extra, '__proto__'), 'extra has no own __proto__ key');
  assert.equal(tb.extra.polluted, undefined, 'no inherited pollution on extra');
  assert.equal(tb.extra.customField, 'keep', 'legit unknown key round-trips');
  assert.equal(({}).polluted, undefined, 'global Object.prototype untouched');
});

test('refreshTeamBoard: primitive __proto__ dropped; constructor/prototype dropped', async () => {
  const tb = await runRefresh('{"__proto__":"evil","constructor":{"p":1},"prototype":{"q":2},"version":1,"columns":[],"customField":"z"}');
  assert.equal(Object.getPrototypeOf(tb.extra), Object.prototype);
  assert.ok(!hasOwn(tb.extra, '__proto__'));
  assert.ok(!hasOwn(tb.extra, 'constructor'));
  assert.ok(!hasOwn(tb.extra, 'prototype'));
  assert.equal(tb.extra.customField, 'z', 'legit unknown key survives');
});

// ── Well-formed config: no behavior change through all three loops ───────────
test('well-formed config round-trips identically through all three loops', async () => {
  const clean = '{"version":1,"columns":[{"status":"ux-review","label":"UX Review","description":"peer","agent":"bot","system":false}],'
    + '"skill":{"concurrencyDefault":3},"customField":"x"}';

  // buildWorkingConfigFromRaw → tasksSerializeTeamConfig
  const wc = R.buildWorkingConfigFromRaw(JSON.parse(clean));
  assert.equal(wc.extra.customField, 'x');
  const serialized = R.tasksSerializeTeamConfig(wc);
  const reparsed = JSON.parse(serialized);
  assert.equal(reparsed.customField, 'x', 'unknown top-level field preserved');
  assert.equal(reparsed.version, 1);
  assert.equal(reparsed.skill.concurrencyDefault, 3);
  assert.ok(reparsed.columns.some((c) => c.status === 'ux-review'), 'user column preserved');
  // idempotent through the serializer
  const wc2 = R.buildWorkingConfigFromRaw(reparsed);
  assert.equal(R.tasksSerializeTeamConfig(wc2), serialized, 'serialize is idempotent on clean config');

  // refreshTeamBoard
  const tb = await runRefresh(clean);
  assert.equal(tb.extra.customField, 'x');
  assert.equal(tb.version, 1);
  assert.deepEqual(tb.skill, { concurrencyDefault: 3 });
  assert.ok(tb.columns.some((c) => c.status === 'ux-review'), 'user column present after refresh');
});

// ── Global Object.prototype never mutated by any of the three loops ──────────
test('global Object.prototype is never mutated by any of the three renderer loops', async () => {
  const attack = '{"__proto__":{"polluted":true},"version":1,"columns":[],"skill":{}}';
  R.tasksSerializeTeamConfig({ columns: [], extra: JSON.parse(attack) });
  R.buildWorkingConfigFromRaw(JSON.parse(attack));
  await runRefresh(attack);
  assert.equal(({}).polluted, undefined, 'no {} pollution');
  assert.ok(!hasOwn(Object.prototype, 'polluted'), 'Object.prototype owns no polluted key');
});
