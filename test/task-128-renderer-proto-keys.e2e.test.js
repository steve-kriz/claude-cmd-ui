'use strict';

// ===========================================================================
// TASK-128 — e2e cucumber-style (Given/When/Then) scenarios.
//
// Feature: the renderer team-config round-trip is safe against prototype/
// reserved key names in a tampered tasks/team-config.json (renderer mirror of
// the lib fix TASK-116). The three unknown-top-level-key copy loops
// (tasksSerializeTeamConfig, refreshTeamBoard, buildWorkingConfigFromRaw) must
// drop __proto__/constructor/prototype rather than fire the __proto__ setter.
//
// These are scenario-style `node --test` cases (no `cucumber` npm package is
// installed or used) that implement EVERY acceptance criterion in the ticket,
// including a failure/edge path. renderer/renderer.js is a browser script, so
// the REAL functions are EXTRACTED from the shipped source by brace-matching
// and evaluated headless with a MOCKED window.api.fs (no real disk/DB) — this
// exercises the ACTUAL shipped code, not a re-implementation.
//
// CRITICAL: every malicious input is built via JSON.parse('...') (or fed as a
// JSON string that refreshTeamBoard itself JSON.parses), NEVER an object
// literal — a `{__proto__: x}` literal sets the prototype and defines no OWN
// key, testing nothing. JSON.parse defines "__proto__" as an OWN key, the real
// on-disk hazard.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');
const libSrc = fs.readFileSync(path.join(REPO, 'lib', 'team-config.js'), 'utf8');

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

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
  assert.ok(m, `const ${name} found`);
  return m[0];
}

function loadRendererFactory() {
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
    // TASK-183 - refreshTeamBoard's baseline phase-link snapshot uses
    // tasksPhaseLinkCounts (which reads TASKS_PHASE_KEYS above).
    extractConst(rendererSrc, 'TASKS_PHASE_ENABLED_DEFAULTS'),
    extractFn(rendererSrc, 'tasksPhaseLinkCounts'),
    extractConst(rendererSrc, 'TASKS_UNSAFE_KEYS'),
    extractConst(rendererSrc, 'TASKS_MAX_CONCURRENCY'),
    extractConst(rendererSrc, 'TASKS_DEFAULT_CONCURRENCY'),
    extractFn(rendererSrc, 'tasksIsUnsafeKey'),
    extractFn(rendererSrc, 'resolveTasksConcurrency'),
    extractFn(rendererSrc, 'tasksPrettifyLabel'),
    extractFn(rendererSrc, 'tasksNormalizeColumnPhase'),
    extractFn(rendererSrc, 'tasksBuildColumn'),
    extractFn(rendererSrc, 'normalizeTasksColumns'),
    extractFn(rendererSrc, 'tasksSerializeTeamConfig'),
    extractFn(rendererSrc, 'buildWorkingConfigFromRaw'),
    extractFn(rendererSrc, 'readTeamAgentNames'),
    extractFn(rendererSrc, 'refreshTeamBoard'),
    'return { TASKS_UNSAFE_KEYS, tasksSerializeTeamConfig, buildWorkingConfigFromRaw, refreshTeamBoard };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function('window', 'renderTeamBoard', 'tasksJoin', 'tasksBasename', body);
}
const factory = loadRendererFactory();

// Build a renderer instance whose MOCKED window.api.fs.readFile returns
// `readFileContent` (the tampered on-disk JSON). No real disk/DB is touched.
function makeRenderer(readFileContent) {
  const win = {
    api: {
      fs: {
        readFile: async () => ({ ok: true, binary: false, content: readFileContent }),
        findByExt: async () => ({ ok: true, files: [] }),
      },
    },
  };
  return factory(win, () => {}, (...p) => p.join('/'), (p) => String(p || ''));
}

// GIVEN a Team tab whose on-disk tasks/team-config.json is `jsonString`,
// WHEN refreshTeamBoard reads and rebuilds the working model, THEN return it.
async function refreshWith(jsonString) {
  const inst = makeRenderer(jsonString);
  const tab = { folder: '/fake/project', els: { teamBoardBody: { textContent: '' } } };
  await inst.refreshTeamBoard(tab);
  return tab.teamBoard;
}

function assertGlobalPrototypeClean() {
  assert.equal(({}).polluted, undefined, 'global Object.prototype gained no "polluted"');
  assert.ok(!hasOwn(Object.prototype, 'polluted'), 'Object.prototype owns no "polluted" key');
}

// ---------------------------------------------------------------------------
// Scenario: A tampered on-disk config with an object-valued __proto__ cannot
// reassign the Board working model's prototype (attack, via refreshTeamBoard).
//   Given tasks/team-config.json carries an own top-level "__proto__" = object
//   When the Team board refreshes (reads + rebuilds the working model)
//   Then the model.extra prototype is Object.prototype, no reserved key leaks,
//     a legit unknown key survives, and global Object.prototype is untouched
// ---------------------------------------------------------------------------
test('Scenario: refreshTeamBoard neutralizes an object-valued __proto__ from a tampered config (attack)', async () => {
  // Given a tampered on-disk config (JSON string; refreshTeamBoard JSON.parses it).
  const onDisk = '{"__proto__":{"polluted":true},"version":1,'
    + '"columns":[{"status":"ux-review","label":"UX Review","system":false}],'
    + '"skill":{"concurrencyDefault":3},"customField":"keep"}';

  // When the board refreshes
  let tb;
  await assert.doesNotReject(async () => { tb = await refreshWith(onDisk); },
    'refreshTeamBoard must never reject on a malicious __proto__ config');

  // Then the working model + its extra bag keep Object.prototype
  assert.ok(tb, 'a working model is built');
  assert.equal(Object.getPrototypeOf(tb), Object.prototype, 'working model prototype unchanged');
  assert.equal(Object.getPrototypeOf(tb.extra), Object.prototype, 'extra prototype unchanged');

  // And no reserved key leaked and no attacker property is inherited
  assert.ok(!hasOwn(tb.extra, '__proto__'), 'extra has no own __proto__ key');
  assert.equal(tb.extra.polluted, undefined, 'no inherited "polluted"');

  // And the legit unknown top-level key still round-trips
  assert.equal(tb.extra.customField, 'keep', 'non-reserved unknown key preserved');

  // And the columns still normalized (system defaults + the user column)
  assert.ok(tb.columns.some((c) => c.status === 'ux-review'), 'user column survives');

  // And the GLOBAL Object.prototype was never touched
  assertGlobalPrototypeClean();
});

// ---------------------------------------------------------------------------
// Scenario: A primitive __proto__ value is dropped, not silently swallowed
// (edge, via refreshTeamBoard).
// ---------------------------------------------------------------------------
test('Scenario: refreshTeamBoard drops a primitive __proto__ value (edge)', async () => {
  // Given a tampered config whose __proto__ is a primitive string
  const onDisk = '{"__proto__":"evil","version":1,"columns":[],"skill":{},"customField":"x"}';

  // When the board refreshes
  const tb = await refreshWith(onDisk);

  // Then extra keeps Object.prototype and carries no __proto__ key
  assert.equal(Object.getPrototypeOf(tb.extra), Object.prototype);
  assert.ok(!hasOwn(tb.extra, '__proto__'));
  // And the legit key still survives
  assert.equal(tb.extra.customField, 'x');
  assertGlobalPrototypeClean();
});

// ---------------------------------------------------------------------------
// Scenario: constructor/prototype own keys are dropped and never crash the
// board rebuild (failure path, via refreshTeamBoard).
// ---------------------------------------------------------------------------
test('Scenario: refreshTeamBoard drops own constructor/prototype keys without crashing (failure)', async () => {
  // Given a tampered config with own constructor/prototype top-level keys
  const onDisk = '{"version":1,"constructor":{"polluted":true},"prototype":{"polluted":true},'
    + '"columns":[],"skill":{},"customField":"y"}';

  // When the board refreshes (must not throw/reject)
  let tb;
  await assert.doesNotReject(async () => { tb = await refreshWith(onDisk); });

  // Then neither reserved key leaks and constructor is still Object
  assert.ok(!hasOwn(tb.extra, 'constructor'), 'no own constructor key');
  assert.ok(!hasOwn(tb.extra, 'prototype'), 'no own prototype key');
  assert.equal(tb.extra.constructor, Object, 'constructor still Object');
  assert.equal(tb.extra.customField, 'y', 'legit key survives');
  assertGlobalPrototypeClean();
});

// ---------------------------------------------------------------------------
// Scenario: The serialize path (Save) never re-persists a reserved key
// (attack, via tasksSerializeTeamConfig on working.extra).
//   Given a working model whose extra carries own __proto__/constructor/prototype
//   When tasksSerializeTeamConfig serializes it
//   Then the emitted JSON has none of the three reserved keys and parses to a
//     clean object, but keeps a legit unknown key
// ---------------------------------------------------------------------------
test('Scenario: tasksSerializeTeamConfig never persists a reserved key (attack)', () => {
  // Given a working model whose extra was parsed from a tampered on-disk config
  const extra = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"p":1},'
    + '"prototype":{"q":2},"customField":"keep"}');
  const working = { version: 1, columns: [], skill: { concurrencyDefault: 3 }, extra };

  // When it is serialized for persistence
  let out;
  assert.doesNotThrow(() => { out = R_serialize(working); });

  // Then the output is valid JSON ending in a newline
  assert.ok(out.endsWith('\n'), 'serialized output ends with a newline');
  const parsed = JSON.parse(out);

  // And none of the three reserved keys appear (own key or raw text)
  assert.ok(!hasOwn(parsed, '__proto__'));
  assert.ok(!hasOwn(parsed, 'constructor'));
  assert.ok(!hasOwn(parsed, 'prototype'));
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype, 'parsed config prototype clean');
  assert.equal(parsed.polluted, undefined, 'no inherited pollution');
  assert.ok(!/"__proto__"|"constructor"|"prototype"/.test(out), 'no reserved key names in JSON text');

  // And the legit unknown key round-trips
  assert.equal(parsed.customField, 'keep');
  assertGlobalPrototypeClean();
});

// ---------------------------------------------------------------------------
// Scenario: buildWorkingConfigFromRaw (concurrency-save split) neutralizes a
// tampered config (attack).
// ---------------------------------------------------------------------------
test('Scenario: buildWorkingConfigFromRaw neutralizes a tampered config (attack)', () => {
  // Given a raw parsed on-disk config with an own object-valued __proto__
  const raw = JSON.parse('{"__proto__":{"polluted":true},"version":1,"columns":[],'
    + '"skill":{"concurrencyDefault":3},"customField":"keep"}');

  // When the working config is built from it
  let wc;
  assert.doesNotThrow(() => { wc = R_build(raw); });

  // Then the working model + extra keep Object.prototype and drop the reserved key
  assert.equal(Object.getPrototypeOf(wc), Object.prototype);
  assert.equal(Object.getPrototypeOf(wc.extra), Object.prototype);
  assert.ok(!hasOwn(wc.extra, '__proto__'));
  assert.equal(wc.extra.polluted, undefined);

  // And the legit unknown key survives; global prototype untouched
  assert.equal(wc.extra.customField, 'keep');
  assertGlobalPrototypeClean();
});

// ---------------------------------------------------------------------------
// Scenario: A well-formed config round-trips identically (no behavior change).
//   Given a clean config with a user column and an unknown top-level field
//   When it flows buildWorkingConfigFromRaw → tasksSerializeTeamConfig, and
//     separately through refreshTeamBoard
//   Then the reserved-key guard changes nothing: the unknown field and column
//     survive and re-serializing is idempotent
// ---------------------------------------------------------------------------
test('Scenario: a well-formed config round-trips identically through the guarded loops (no regression)', async () => {
  const clean = '{"version":1,'
    + '"columns":[{"status":"ux-review","label":"UX Review","description":"peer","agent":"bot","system":false}],'
    + '"skill":{"concurrencyDefault":3},"customField":"x"}';

  // buildWorkingConfigFromRaw → tasksSerializeTeamConfig
  const wc = R_build(JSON.parse(clean));
  assert.equal(wc.extra.customField, 'x');
  const serialized = R_serialize(wc);
  const reparsed = JSON.parse(serialized);
  assert.equal(reparsed.customField, 'x', 'unknown top-level field preserved');
  assert.equal(reparsed.version, 1);
  assert.equal(reparsed.skill.concurrencyDefault, 3);
  assert.ok(reparsed.columns.some((c) => c.status === 'ux-review'));
  assert.equal(R_serialize(R_build(reparsed)), serialized, 'serialize is idempotent');

  // refreshTeamBoard
  const tb = await refreshWith(clean);
  assert.equal(tb.extra.customField, 'x');
  assert.equal(tb.version, 1);
  assert.deepEqual(tb.skill, { concurrencyDefault: 3 });
  assert.ok(tb.columns.some((c) => c.status === 'ux-review'));
});

// ---------------------------------------------------------------------------
// Scenario (lockstep guard): the renderer's TASKS_UNSAFE_KEYS stays identical
// to lib/team-config.js UNSAFE_KEYS, so the two hardening copies cannot drift.
// ---------------------------------------------------------------------------
test('Scenario: renderer TASKS_UNSAFE_KEYS is in lockstep with lib UNSAFE_KEYS', () => {
  const evalSet = (literal) => {
    // eslint-disable-next-line no-new-func
    return new Function(literal + '\nreturn ' + literal.match(/const\s+(\w+)/)[1] + ';')();
  };
  const rendererKeys = evalSet(extractConst(rendererSrc, 'TASKS_UNSAFE_KEYS'));
  const libKeys = evalSet(extractConst(libSrc, 'UNSAFE_KEYS'));

  assert.ok(rendererKeys instanceof Set && libKeys instanceof Set);
  assert.deepEqual([...rendererKeys].sort(), [...libKeys].sort(),
    'renderer TASKS_UNSAFE_KEYS must equal lib UNSAFE_KEYS (kept in lockstep)');
  assert.deepEqual([...rendererKeys].sort(), ['__proto__', 'constructor', 'prototype'].sort());
});

// Bind the extracted pure functions once for the non-refresh scenarios above.
const _inst = makeRenderer('{}');
function R_serialize(w) { return _inst.tasksSerializeTeamConfig(w); }
function R_build(r) { return _inst.buildWorkingConfigFromRaw(r); }
