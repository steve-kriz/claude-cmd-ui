'use strict';

// ===========================================================================
// TASK-124 — UNIT tests for the concurrency-save follow-ups in
// renderer/renderer.js (review of TASK-106):
//
//   F1: buildWorkingConfigFromRaw is the keep-last-good primitive the Save handler
//   now feeds with the render-time rawConfig (instead of null) when the Save-time
//   re-read fails. Contrast: given a rich rawConfig it PRESERVES columns / version /
//   skill (incl. planningModel) / unknown top-level fields; given null it collapses
//   to DEFAULTS (version 1, empty skill/extra, no columns) — i.e. exactly the
//   data-loss the fix avoids by never passing null.
//
//   F2: the immediate-reflection contract — a config object shaped like the one the
//   Save handler stores in-memory (JSON.parse of tasksSerializeTeamConfig(working))
//   is read by currentTasksConcurrency / tasksConfigConcurrencyDefault WITHOUT a
//   poll, so the new concurrencyDefault takes effect at once.
//
// renderer.js is a browser script (no module.exports); the pure declarations are
// EXTRACTED headless by brace-matching / regex and evaluated with an injected
// window/document/console/localStorage. The subject is the REAL shipped code. NO
// DB / disk write / Electron / network.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');

const FABLE = 'claude-fable-5';

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

function load(localStorage) {
  const body = [
    extractConst(rendererSrc, 'BUILD_COMMAND'),
    extractConst(rendererSrc, 'TASKS_MAX_CONCURRENCY'),
    extractConst(rendererSrc, 'TASKS_DEFAULT_CONCURRENCY'),
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
    extractFn(rendererSrc, 'resolveTasksConcurrency'),
    extractFn(rendererSrc, 'readStoredTasksConcurrency'),
    extractFn(rendererSrc, 'tasksConcurrencyStorageKey'),
    extractFn(rendererSrc, 'tasksConfigConcurrencyDefault'),
    extractFn(rendererSrc, 'currentTasksConcurrency'),
    extractFn(rendererSrc, 'buildCommandFor'),
    extractFn(rendererSrc, 'tasksPrettifyLabel'),
    extractFn(rendererSrc, 'tasksNormalizeColumnPhase'),
    extractFn(rendererSrc, 'tasksBuildColumn'),
    extractFn(rendererSrc, 'normalizeTasksColumns'),
    // TASK-200 — tasksSerializeTeamConfig now normalises skill.contextOptimization
    // via tasksNormalizeContextOptimization, so these must be in scope too.
    extractConst(rendererSrc, 'TASKS_CONTEXT_OPT_LEVELS'),
    extractConst(rendererSrc, 'TASKS_CONTEXT_OPT_DEFAULT'),
    extractFn(rendererSrc, 'tasksNormalizeContextOptimization'),
    extractFn(rendererSrc, 'tasksSerializeTeamConfig'),
    // TASK-128: buildWorkingConfigFromRaw / tasksSerializeTeamConfig now skip
    // prototype-poisoning keys via tasksIsUnsafeKey, so the headless harness must
    // extract that symbol (+ the TASKS_UNSAFE_KEYS set it reads).
    extractConst(rendererSrc, 'TASKS_UNSAFE_KEYS'),
    extractFn(rendererSrc, 'tasksIsUnsafeKey'),
    extractFn(rendererSrc, 'buildWorkingConfigFromRaw'),
    'return { resolveTasksConcurrency, currentTasksConcurrency, buildCommandFor,',
    '  tasksConfigConcurrencyDefault, tasksSerializeTeamConfig, buildWorkingConfigFromRaw,',
    '  TASKS_DEFAULT_CONCURRENCY, TASKS_MAX_CONCURRENCY };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function('window', 'document', 'console', 'localStorage', body)(
    {}, {}, console, localStorage);
}

function makeLocalStorage(seed) {
  const map = new Map(Object.entries(seed || {}));
  return {
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
  };
}

const mod = load(makeLocalStorage());
const DEFAULT = mod.TASKS_DEFAULT_CONCURRENCY;
const MAX = mod.TASKS_MAX_CONCURRENCY;

// ---------------------------------------------------------------------------
// F1 — keep-last-good: rawConfig PRESERVED vs null -> DEFAULTS.
// This is the exact contrast the Save handler now leans on: fall back to
// rawConfig (this test's "rich" case), never null (the data-loss case).
// ---------------------------------------------------------------------------

test('F1 unit: buildWorkingConfigFromRaw(rawConfig) preserves columns/version/skill.planningModel/unknown fields (keep-last-good)', () => {
  const raw = {
    version: 2,
    columns: [{ status: 'ux-review', label: 'UX Review', description: 'design pass' }],
    skill: { concurrencyDefault: 99, planningModel: FABLE },
    someUnknownField: { keep: true },
    anotherUnknown: [1, 2, 3],
  };
  const w = mod.buildWorkingConfigFromRaw(raw);
  assert.equal(w.version, 2, 'version preserved');
  assert.deepEqual(w.columns, raw.columns, 'user columns preserved');
  assert.equal(w.skill.planningModel, FABLE, 'skill.planningModel preserved');
  assert.equal(w.skill.concurrencyDefault, 99, 'skill.concurrencyDefault carried through (clamped later by serialize)');
  assert.notEqual(w.skill, raw.skill, 'skill is a COPY, not the same reference');
  assert.deepEqual(w.extra, { someUnknownField: { keep: true }, anotherUnknown: [1, 2, 3] },
    'unknown top-level fields captured in extra');
});

test('F1 unit: buildWorkingConfigFromRaw(null) collapses to DEFAULTS — the data-loss the fix avoids by never passing null', () => {
  const w = mod.buildWorkingConfigFromRaw(null);
  assert.equal(w.version, 1, 'null -> version 1 (default)');
  assert.deepEqual(w.skill, {}, 'null -> empty skill (planningModel WOULD be lost)');
  assert.deepEqual(w.columns, [], 'null -> no columns (user columns WOULD be lost)');
  assert.deepEqual(w.extra, {}, 'null -> no extra (unknown fields WOULD be lost)');
});

test('F1 unit: the keep-last-good contrast — serializing rawConfig vs null shows planningModel/columns survive only via rawConfig', () => {
  const raw = {
    version: 2,
    columns: [{ status: 'ux-review', label: 'UX Review', description: 'design pass' }],
    skill: { concurrencyDefault: 99, planningModel: FABLE },
    someUnknownField: { keep: true },
  };
  const resolved = mod.resolveTasksConcurrency(99); // = 8

  // Fallback-to-rawConfig path (the FIX): everything survives, concurrency clamped.
  const good = mod.buildWorkingConfigFromRaw(raw);
  good.skill = { ...good.skill, concurrencyDefault: resolved };
  const keptCfg = JSON.parse(mod.tasksSerializeTeamConfig(good));
  assert.equal(keptCfg.skill.concurrencyDefault, 8, 'kept path: concurrency clamped and persisted');
  assert.equal(keptCfg.skill.planningModel, FABLE, 'kept path: planningModel survives');
  assert.equal(keptCfg.version, 2, 'kept path: version survives');
  assert.deepEqual(keptCfg.someUnknownField, { keep: true }, 'kept path: unknown field survives');
  assert.ok(keptCfg.columns.some((c) => c.status === 'ux-review'), 'kept path: user column survives');

  // Fallback-to-null path (the OLD BUG): only the new concurrency lands; user data lost.
  const bad = mod.buildWorkingConfigFromRaw(null);
  bad.skill = { ...bad.skill, concurrencyDefault: resolved };
  const lostCfg = JSON.parse(mod.tasksSerializeTeamConfig(bad));
  assert.equal(lostCfg.skill.concurrencyDefault, 8, 'null path: concurrency still lands');
  assert.equal(lostCfg.skill.planningModel, undefined, 'null path: planningModel WOULD be gone');
  assert.equal(lostCfg.version, 1, 'null path: version reset to 1');
  assert.equal(lostCfg.someUnknownField, undefined, 'null path: unknown field WOULD be gone');
  assert.ok(!lostCfg.columns.some((c) => c.status === 'ux-review'), 'null path: user column WOULD be gone');
});

// ---------------------------------------------------------------------------
// F2 — immediate reflection: the in-memory config the Save handler stores
// (JSON.parse(tasksSerializeTeamConfig(working))) is picked up at once.
// ---------------------------------------------------------------------------

test('F2 unit: a config object matching what Save stores in-memory is read by currentTasksConcurrency/buildCommandFor immediately (no poll)', () => {
  const localStorage = makeLocalStorage(); // no override
  const m = load(localStorage);
  const tab = { folder: 'C:\\proj', tasks: { config: { skill: { concurrencyDefault: 3 } } } };
  assert.equal(m.currentTasksConcurrency(tab), 3, 'starts at old default 3');

  // Simulate the F2 in-memory update: tab.tasks.config = JSON.parse(serialized).
  const working = m.buildWorkingConfigFromRaw({ version: 1, columns: [], skill: { concurrencyDefault: 3 } });
  working.skill = { ...working.skill, concurrencyDefault: m.resolveTasksConcurrency(6) };
  tab.tasks.config = JSON.parse(m.tasksSerializeTeamConfig(working));

  assert.equal(m.tasksConfigConcurrencyDefault(tab), 6, 'config default reads 6 from the new in-memory config');
  assert.equal(m.currentTasksConcurrency(tab), 6, 'resolution reflects 6 immediately');
  assert.equal(m.buildCommandFor(tab), '/orchestrate build --concurrency 6', 'build command reflects 6 immediately');
});

test('F2 unit: the stored in-memory config is a fresh-read shape — an out-of-range Save persists+reflects the CLAMPED value', () => {
  const m = load(makeLocalStorage());
  const tab = { folder: 'C:\\proj', tasks: { config: { skill: { concurrencyDefault: 3 } } } };
  const working = m.buildWorkingConfigFromRaw({ skill: { concurrencyDefault: 3 } });
  working.skill = { ...working.skill, concurrencyDefault: m.resolveTasksConcurrency(99) };
  const serialized = m.tasksSerializeTeamConfig(working);
  tab.tasks.config = JSON.parse(serialized);
  assert.equal(tab.tasks.config.skill.concurrencyDefault, 8, 'in-memory config carries the clamped 8');
  assert.equal(m.currentTasksConcurrency(tab), 8, 'resolution reflects the clamped 8 immediately');
});

test('F2 unit: with a per-folder localStorage override, the new in-memory config default does NOT override the explicit user choice', () => {
  const localStorage = makeLocalStorage({ 'tasks:concurrency:C:\\proj': JSON.stringify(2) });
  const m = load(localStorage);
  const tab = { folder: 'C:\\proj', tasks: { config: { skill: { concurrencyDefault: 6 } } } };
  assert.equal(m.currentTasksConcurrency(tab), 2, 'override wins over the in-memory config default');
  assert.equal(m.tasksConfigConcurrencyDefault(tab), 6, 'the config default is still readable underneath');
});
