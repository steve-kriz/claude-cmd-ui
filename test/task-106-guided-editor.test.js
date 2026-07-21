'use strict';

// ===========================================================================
// TASK-106 — UNIT tests for the guided skill-settings editor's pure renderer
// helpers (renderer/renderer.js): the per-phase agent-model round-trip
// (serializeAgentModel + its sanitiser guard), the Tasks concurrency precedence
// (currentTasksConcurrency: localStorage → config skill.concurrencyDefault →
// TASKS_DEFAULT_CONCURRENCY), and buildWorkingConfigFromRaw (columns / version /
// unknown-field preservation).
//
// renderer.js is a browser script (no module.exports, references document/window),
// so — matching test/task-019-tasks-settings.unit.test.js and
// test/task-051-planning-model.test.js — the pure declarations are EXTRACTED
// headless by brace-matching / regex and evaluated with an injected
// window/document/console/localStorage. The subject is the REAL shipped code, so
// this drift-catches divergence. The four bundled agent files are read READ-ONLY
// as fixtures (never modified). NO DB / disk write / Electron / network.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');
const ASSETS_AGENTS = path.join(REPO, 'assets', 'agents');

const FABLE = 'claude-fable-5';
const OPUS = 'claude-opus-4-8';
const AGENT_FILES = ['ba.md', 'coder.md', 'tester.md', 'tech-lead.md'];

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

// Load the pure helpers headless; localStorage is injected so the precedence tests
// can control the per-folder stored value with no real browser storage.
function load(localStorage) {
  const body = [
    extractConst(rendererSrc, 'AGENT_KEY_RE'),
    extractConst(rendererSrc, 'AGENT_BLOCK_RE'),
    extractConst(rendererSrc, 'AGENT_FENCE_RE'),
    extractConst(rendererSrc, 'TASKS_MAX_CONCURRENCY'),
    extractConst(rendererSrc, 'TASKS_DEFAULT_CONCURRENCY'),
    extractFn(rendererSrc, 'resolveAgentBlockScalar'),
    extractFn(rendererSrc, 'parseAgentFileRenderer'),
    extractFn(rendererSrc, 'serializeAgentModel'),
    extractFn(rendererSrc, 'sanitizeAgentScalarField'),
    extractFn(rendererSrc, 'sanitizeAgentModelField'),
    extractFn(rendererSrc, 'resolveTasksConcurrency'),
    extractFn(rendererSrc, 'readStoredTasksConcurrency'),
    extractFn(rendererSrc, 'tasksConcurrencyStorageKey'),
    extractFn(rendererSrc, 'tasksConfigConcurrencyDefault'),
    extractFn(rendererSrc, 'currentTasksConcurrency'),
    // TASK-128: buildWorkingConfigFromRaw now skips prototype-poisoning keys via
    // tasksIsUnsafeKey, so the headless harness must extract that symbol (+ the
    // TASKS_UNSAFE_KEYS set it reads) or the function throws ReferenceError.
    extractConst(rendererSrc, 'TASKS_UNSAFE_KEYS'),
    extractFn(rendererSrc, 'tasksIsUnsafeKey'),
    extractFn(rendererSrc, 'buildWorkingConfigFromRaw'),
    'return { parseAgentFileRenderer, serializeAgentModel, sanitizeAgentModelField,',
    '  resolveTasksConcurrency, currentTasksConcurrency, buildWorkingConfigFromRaw,',
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

function readAgent(name) { return fs.readFileSync(path.join(ASSETS_AGENTS, name), 'utf8'); }
function eolOf(s) { return /\r\n/.test(s) ? '\r\n' : '\n'; }
function stripModelLine(content, model) {
  const eol = eolOf(content);
  return content.replace('model: ' + model + eol, '');
}

// ---------------------------------------------------------------------------
// serializeAgentModel — whole-file round-trip rewriting ONLY the `model:` line
// ---------------------------------------------------------------------------

test('unit: serializeAgentModel re-emits ba.md byte-identically when the model is unchanged', () => {
  // ba.md is the one bundled agent that declares a model (claude-fable-5).
  const orig = readAgent('ba.md');
  const parsed = mod.parseAgentFileRenderer(orig);
  assert.equal(parsed.fm.model, FABLE, 'fixture precondition: ba.md declares claude-fable-5');
  assert.equal(mod.serializeAgentModel(parsed, FABLE), orig,
    'passing the unchanged model re-emits the file byte-for-byte');
});

test('unit: serializeAgentModel changes ONLY the model line on all four bundled agents (round-trip fidelity)', () => {
  for (const name of AGENT_FILES) {
    const orig = readAgent(name);
    const parsed = mod.parseAgentFileRenderer(orig);
    assert.ok(parsed, `${name} parses`);
    // Serializing with a NEW model, then stripping that one model line, must yield
    // the original with any pre-existing model line removed — i.e. everything OTHER
    // than the model line is byte-preserved.
    const out = mod.serializeAgentModel(parsed, OPUS);
    const origWithoutModel = parsed.fm.model != null
      ? stripModelLine(orig, parsed.fm.model) : orig;
    assert.equal(stripModelLine(out, OPUS), origWithoutModel,
      `${name}: only the model line differs; all other bytes preserved`);
    // And the output declares exactly the new model, exactly once.
    const occurrences = out.split('model: ' + OPUS).length - 1;
    assert.equal(occurrences, 1, `${name}: exactly one model: ${OPUS} line`);
  }
});

test('unit: serializeAgentModel rewrites only the model VALUE for an agent that already has the key', () => {
  const orig = readAgent('ba.md');
  const parsed = mod.parseAgentFileRenderer(orig);
  const eol = eolOf(orig);
  const out = mod.serializeAgentModel(parsed, OPUS);
  const expected = orig.replace('model: ' + FABLE + eol, 'model: ' + OPUS + eol);
  assert.equal(out, expected, 'the model line is rewritten in place; nothing else moves');
});

test('unit: serializeAgentModel INSERTS a model key in canonical position (after tools) for agents lacking one', () => {
  // coder / tester / tech-lead ship with name→description→tools and NO model.
  for (const name of ['coder.md', 'tester.md', 'tech-lead.md']) {
    const orig = readAgent(name);
    const parsed = mod.parseAgentFileRenderer(orig);
    assert.equal(parsed.fm.model, undefined, `${name} precondition: no model key`);
    const out = mod.serializeAgentModel(parsed, OPUS);
    const lines = out.split(eolOf(out));
    const modelIdx = lines.indexOf('model: ' + OPUS);
    assert.ok(modelIdx !== -1, `${name}: a model line was inserted`);
    // Canonical position: immediately after the `tools:` line, before the closing
    // frontmatter fence (name → description → tools → model order).
    assert.match(lines[modelIdx - 1], /^tools:/, `${name}: model inserted right after tools`);
    assert.equal(lines[modelIdx + 1], '---', `${name}: model is the last frontmatter key`);
    // And stripping the inserted line restores the original file exactly.
    assert.equal(stripModelLine(out, OPUS), orig, `${name}: insertion is the only change`);
  }
});

test('unit: serializeAgentModel returns null for a non-parsed input (guard)', () => {
  assert.equal(mod.serializeAgentModel(null, OPUS), null);
  assert.equal(mod.serializeAgentModel({}, OPUS), null);
  assert.equal(mod.serializeAgentModel({ meta: null }, OPUS), null);
});

// ---------------------------------------------------------------------------
// sanitizeAgentModelField — the upstream guard the editor applies BEFORE
// serializeAgentModel ever runs. An injection value is rejected there, so a
// newline / `---` / `key:` can never reach the single-line model scalar.
// ---------------------------------------------------------------------------

test('unit: sanitizeAgentModelField accepts a bare single-token model id', () => {
  for (const ok of [FABLE, OPUS, 'gpt-4o', 'model_1.2-3', 'a']) {
    const r = mod.sanitizeAgentModelField(ok);
    assert.equal(r.ok, true, `${ok} accepted`);
    assert.equal(r.value, ok, `${ok} value preserved`);
  }
});

test('unit: sanitizeAgentModelField REJECTS injection values (newline / --- / embedded key: / bad chars)', () => {
  const bad = [
    'claude-opus-4-8\nmalicious: true',
    'claude\r\nname: evil',
    '---\nname: evil',
    'foo: bar',
    'has space',
    'tabs\tand\tthings',
    'x y',   // Unicode line separator
    'ctrlbell',
  ];
  for (const v of bad) {
    const r = mod.sanitizeAgentModelField(v);
    assert.equal(r.ok, false, `rejected: ${JSON.stringify(v)}`);
    assert.ok(typeof r.error === 'string' && r.error.length > 0, 'carries an error message');
  }
});

test('unit: a rejected model value is never serialized — the editor contract holds', () => {
  // The editor only calls serializeAgentModel with chk.value AFTER chk.ok. Prove
  // the guard is the gate: for every injection the sanitizer says no, so no
  // rewritten content is ever produced.
  const orig = readAgent('coder.md');
  const parsed = mod.parseAgentFileRenderer(orig);
  for (const v of ['a\nb', '---evil', 'k: v']) {
    const chk = mod.sanitizeAgentModelField(v);
    assert.equal(chk.ok, false);
    // If (hypothetically) the raw value were serialized it would corrupt the file;
    // the guard prevents that path from ever running.
    if (chk.ok) mod.serializeAgentModel(parsed, chk.value); // unreachable
  }
  // Sanity: a clean value would pass the gate and serialize fine.
  const good = mod.sanitizeAgentModelField(OPUS);
  assert.equal(good.ok, true);
  assert.ok(typeof mod.serializeAgentModel(parsed, good.value) === 'string');
});

// ---------------------------------------------------------------------------
// currentTasksConcurrency — precedence matrix
//   localStorage (tasks:concurrency:<folder>)  →  config skill.concurrencyDefault
//   →  TASKS_DEFAULT_CONCURRENCY
// ---------------------------------------------------------------------------

const DEFAULT = mod.TASKS_DEFAULT_CONCURRENCY; // 3
const MAX = mod.TASKS_MAX_CONCURRENCY;         // 8

function tabWith(folder, config, storageSeed) {
  const ls = makeLocalStorage(storageSeed);
  const m = load(ls); // fresh module bound to this localStorage
  return { m, tab: { folder, tasks: { config } } };
}

test('unit: precedence — a valid localStorage value WINS over the config default', () => {
  const cfg = { skill: { concurrencyDefault: 5 } };
  const { m, tab } = tabWith('C:\\proj', cfg, { 'tasks:concurrency:C:\\proj': JSON.stringify(2) });
  assert.equal(m.currentTasksConcurrency(tab), 2, 'localStorage 2 beats config 5');
});

test('unit: precedence — an out-of-range localStorage value is clamped, still winning over config', () => {
  const cfg = { skill: { concurrencyDefault: 5 } };
  const hi = tabWith('C:\\proj', cfg, { 'tasks:concurrency:C:\\proj': JSON.stringify(99) });
  assert.equal(hi.m.currentTasksConcurrency(hi.tab), MAX, 'localStorage 99 clamps to MAX');
  const lo = tabWith('C:\\proj', cfg, { 'tasks:concurrency:C:\\proj': JSON.stringify(0) });
  assert.equal(lo.m.currentTasksConcurrency(lo.tab), 1, 'localStorage 0 clamps to 1');
});

test('unit: precedence — with NO localStorage, the config skill.concurrencyDefault is used', () => {
  const { m, tab } = tabWith('C:\\proj', { skill: { concurrencyDefault: 6 } }, {});
  assert.equal(m.currentTasksConcurrency(tab), 6, 'config default used when no override');
});

test('unit: precedence — an out-of-range config default is clamped', () => {
  const hi = tabWith('C:\\proj', { skill: { concurrencyDefault: 99 } }, {});
  assert.equal(hi.m.currentTasksConcurrency(hi.tab), MAX, 'config 99 clamps to MAX');
  const frac = tabWith('C:\\proj', { skill: { concurrencyDefault: 4.9 } }, {});
  assert.equal(frac.m.currentTasksConcurrency(frac.tab), 4, 'config 4.9 floors to 4');
});

test('unit: precedence — neither localStorage nor config yields TASKS_DEFAULT_CONCURRENCY', () => {
  for (const cfg of [null, {}, { skill: {} }, { skill: null }, { skill: { concurrencyDefault: null } }, { skill: { concurrencyDefault: '' } }]) {
    const { m, tab } = tabWith('C:\\proj', cfg, {});
    assert.equal(m.currentTasksConcurrency(tab), DEFAULT, `no value -> default for ${JSON.stringify(cfg)}`);
  }
});

test('unit: precedence — a blank/whitespace localStorage value falls through to config', () => {
  const cfg = { skill: { concurrencyDefault: 7 } };
  for (const blank of ['', '   ']) {
    const { m, tab } = tabWith('C:\\proj', cfg, { 'tasks:concurrency:C:\\proj': blank });
    assert.equal(m.currentTasksConcurrency(tab), 7, `blank ${JSON.stringify(blank)} falls through to config`);
  }
});

test('unit: precedence — with no folder open the storage key is null; config (or default) is used', () => {
  const { m, tab } = tabWith('', { skill: { concurrencyDefault: 5 } }, {});
  assert.equal(m.currentTasksConcurrency(tab), 5, 'no folder -> skip storage, use config');
  const { m: m2, tab: t2 } = tabWith('', null, {});
  assert.equal(m2.currentTasksConcurrency(t2), DEFAULT, 'no folder + no config -> default');
});

test('unit: currentTasksConcurrency never throws and always returns an in-range integer', () => {
  const junkConfigs = [null, {}, [], 'x', 42, { skill: 'nope' }, { skill: { concurrencyDefault: 'abc' } }];
  const junkStores = [{}, { 'tasks:concurrency:C:\\proj': 'abc' }, { 'tasks:concurrency:C:\\proj': '{bad' }, { 'tasks:concurrency:C:\\proj': 'null' }];
  for (const cfg of junkConfigs) {
    for (const store of junkStores) {
      const { m, tab } = tabWith('C:\\proj', cfg, store);
      let out;
      assert.doesNotThrow(() => { out = m.currentTasksConcurrency(tab); });
      assert.ok(Number.isInteger(out) && out >= 1 && out <= MAX, `in-range int for cfg=${JSON.stringify(cfg)} store=${JSON.stringify(store)}: ${out}`);
    }
  }
});

// ---------------------------------------------------------------------------
// buildWorkingConfigFromRaw — columns / version / skill / unknown-field split
// ---------------------------------------------------------------------------

test('unit: buildWorkingConfigFromRaw preserves version, skill, columns and UNKNOWN top-level fields', () => {
  const raw = {
    version: 3,
    columns: [{ status: 'ux-review', label: 'UX Review' }],
    skill: { concurrencyDefault: 5, planningModel: FABLE },
    mysteryField: { a: 1 },
    anotherUnknown: [1, 2, 3],
  };
  const w = mod.buildWorkingConfigFromRaw(raw);
  assert.equal(w.version, 3, 'version preserved');
  assert.deepEqual(w.columns, [{ status: 'ux-review', label: 'UX Review' }], 'columns preserved');
  assert.deepEqual(w.skill, { concurrencyDefault: 5, planningModel: FABLE }, 'skill copied');
  assert.notEqual(w.skill, raw.skill, 'skill is a COPY, not the same reference');
  assert.deepEqual(w.extra, { mysteryField: { a: 1 }, anotherUnknown: [1, 2, 3] },
    'unknown top-level fields captured in extra');
});

test('unit: buildWorkingConfigFromRaw never puts version/columns/skill/warnings into extra', () => {
  const raw = { version: 1, columns: [], skill: {}, warnings: ['x'], keepMe: true };
  const w = mod.buildWorkingConfigFromRaw(raw);
  for (const k of ['version', 'columns', 'skill', 'warnings']) {
    assert.ok(!(k in w.extra), `${k} is not duplicated into extra`);
  }
  assert.deepEqual(w.extra, { keepMe: true }, 'only genuine unknowns land in extra');
});

test('unit: buildWorkingConfigFromRaw defaults null/junk to version 1, empty skill/extra, no columns', () => {
  for (const junk of [null, undefined, 'x', 42, [], true]) {
    const w = mod.buildWorkingConfigFromRaw(junk);
    assert.equal(w.version, 1, `version defaults to 1 for ${JSON.stringify(junk)}`);
    assert.deepEqual(w.skill, {}, 'skill defaults to {}');
    assert.deepEqual(w.extra, {}, 'extra defaults to {}');
    assert.deepEqual(w.columns, [], 'columns default to []');
  }
});

test('unit: buildWorkingConfigFromRaw tolerates a non-object/array skill and non-array columns', () => {
  const w = mod.buildWorkingConfigFromRaw({ skill: ['not', 'an', 'object'], columns: 'nope' });
  assert.deepEqual(w.skill, {}, 'array skill -> {}');
  assert.deepEqual(w.columns, [], 'non-array columns -> []');
});
