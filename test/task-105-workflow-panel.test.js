'use strict';

// ===========================================================================
// TASK-105 — UNIT tests for the renderer mirror of lib/skill-workflow.js
// (TASK-096) that powers the Team tab Workflow panel.
//
// renderer/renderer.js is a browser script (no module.exports, references
// `document`/`window`), so — matching test/task-094-agents-panel.e2e.test.js —
// the pure wf* declarations are EXTRACTED headless by brace-matching / regex and
// evaluated with injected window/document/console. The extracted subject is the
// REAL shipped code, so this drift-catches any divergence of the renderer mirror
// from lib/skill-workflow.js.
//
// These tests mirror the coverage of test/task-096-skill-workflow.test.js but
// against the renderer mirror: wfParseWorkflow (4 phases, canonical order,
// agents, plan model directive), missing-phase fixture → warning, junk/null →
// empty phases no throw; wfIsFallback (present vs missing agent).
//
// NO DATABASE, DISK WRITE, ELECTRON RUNTIME, OR NETWORK. The only read is the
// bundled SKILL.md source (read-only) used as a fixture; any DB calls, were
// there any, would be mocked — this code touches none.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');
const SKILL_SRC = fs.readFileSync(
  path.join(REPO, '.claude', 'skills', 'orchestrate', 'SKILL.md'), 'utf8');

const FABLE = 'claude-fable-5';
const OPUS = 'claude-opus-4-8';

// --- Extract a named function declaration by brace-matching (task-094 style). --
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

// Load the REAL renderer wf* mirror headless. These helpers are pure (no DOM),
// but the loader injects window/document/console for parity with the shipped
// scope so nothing accidentally references a global.
function loadWf() {
  const body = [
    extractConst(rendererSrc, 'WF_FALLBACK_AGENT'),
    extractConst(rendererSrc, 'WF_AGENT_TYPES'),
    extractConst(rendererSrc, 'WF_AGENT_NAMES'),
    extractConst(rendererSrc, 'WF_PHASE_SPECS'),
    extractConst(rendererSrc, 'WF_PLAN_MODEL_PRIMARY'),
    extractConst(rendererSrc, 'WF_PLAN_MODEL_FALLBACK'),
    extractFn(rendererSrc, 'wfIsFallback'),
    extractFn(rendererSrc, 'wfHeadingName'),
    extractFn(rendererSrc, 'wfPhaseNumberOf'),
    extractFn(rendererSrc, 'wfAgentIn'),
    extractFn(rendererSrc, 'wfModelDirectiveIn'),
    extractFn(rendererSrc, 'wfSectionsOf'),
    extractFn(rendererSrc, 'wfAgentFromDispatch'),
    extractFn(rendererSrc, 'wfParseWorkflow'),
    'return { wfParseWorkflow, wfIsFallback, WF_PHASE_SPECS, WF_AGENT_NAMES,',
    '  WF_FALLBACK_AGENT, WF_PLAN_MODEL_PRIMARY, WF_PLAN_MODEL_FALLBACK };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function('window', 'document', 'console', body)({}, {}, console);
}
const wf = loadWf();

// ---------------------------------------------------------------------------
// Mirror constants match lib/orchestrate-agents.js / lib/skill-workflow.js
// ---------------------------------------------------------------------------

test('unit: renderer mirror constants match the lib source of truth', () => {
  assert.equal(wf.WF_FALLBACK_AGENT, 'general-purpose');
  assert.equal(wf.WF_PLAN_MODEL_PRIMARY, FABLE);
  assert.equal(wf.WF_PLAN_MODEL_FALLBACK, OPUS);
  assert.deepEqual(wf.WF_AGENT_NAMES,
    ['orchestrate-ba', 'orchestrate-coder', 'orchestrate-tester', 'orchestrate-tech-lead']);
  assert.deepEqual(wf.WF_PHASE_SPECS.map((s) => s.key), ['plan', 'build', 'test', 'review']);
  assert.deepEqual(wf.WF_PHASE_SPECS.map((s) => s.number), [1, 2, 3, 4]);
});

// ---------------------------------------------------------------------------
// wfParseWorkflow against the REAL bundled SKILL.md
// ---------------------------------------------------------------------------

test('unit: real SKILL.md -> four phases, canonical order, no warnings', () => {
  const { phases, warnings } = wf.wfParseWorkflow(SKILL_SRC);
  assert.deepEqual(phases.map((p) => p.key), ['plan', 'build', 'test', 'review']);
  assert.deepEqual(warnings, []);
});

test('unit: real SKILL.md -> agents match the dedicated orchestrate-* names', () => {
  const { phases } = wf.wfParseWorkflow(SKILL_SRC);
  const byKey = Object.fromEntries(phases.map((p) => [p.key, p.agent]));
  assert.equal(byKey.plan, 'orchestrate-ba');
  assert.equal(byKey.build, 'orchestrate-coder');
  assert.equal(byKey.test, 'orchestrate-tester');
  assert.equal(byKey.review, 'orchestrate-tech-lead');
});

test('unit: real SKILL.md -> each phase carries a 1-based headingLine at its `## Phase` heading', () => {
  const { phases } = wf.wfParseWorkflow(SKILL_SRC);
  const lines = SKILL_SRC.split(/\r?\n/);
  for (const p of phases) {
    assert.match(lines[p.headingLine - 1], /^##\s+Phase\s+\d/, `${p.key} headingLine points at its heading`);
  }
  // headingLines strictly increasing (the fence-embedded sample ticket's
  // `## Description` / inline ```gherkin never open a phantom section).
  const seq = phases.map((p) => p.headingLine);
  assert.deepEqual(seq, [...seq].sort((a, b) => a - b));
});

test('unit: real SKILL.md -> ONLY the plan phase carries the model directive fable-5 -> opus', () => {
  const { phases } = wf.wfParseWorkflow(SKILL_SRC);
  const plan = phases.find((p) => p.key === 'plan');
  assert.deepEqual(plan.model, { primary: FABLE, fallback: OPUS });
  for (const p of phases.filter((x) => x.key !== 'plan')) {
    assert.equal(p.model, undefined, `${p.key} phase has no model key`);
  }
});

test('unit: CRLF line endings parse identically to LF', () => {
  const lf = wf.wfParseWorkflow(SKILL_SRC);
  const crlf = wf.wfParseWorkflow(SKILL_SRC.replace(/\n/g, '\r\n'));
  assert.deepEqual(
    crlf.phases.map((p) => ({ key: p.key, agent: p.agent, headingLine: p.headingLine })),
    lf.phases.map((p) => ({ key: p.key, agent: p.agent, headingLine: p.headingLine })));
  assert.deepEqual(crlf.warnings, lf.warnings);
});

// ---------------------------------------------------------------------------
// Missing-phase fixture (modified SKILL) — warning, phases still returned
// ---------------------------------------------------------------------------

test('unit: dropping the Phase 3 heading omits test + warns naming phase 3, source untouched', () => {
  const modified = SKILL_SRC.replace(
    '## Phase 3 — Test (tester) and the fix loop',
    '## Test (tester) and the fix loop');
  assert.notEqual(modified, SKILL_SRC, 'fixture actually dropped the Phase 3 heading');
  const { phases, warnings } = wf.wfParseWorkflow(modified);
  assert.deepEqual(phases.map((p) => p.key), ['plan', 'build', 'review']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Missing Phase 3 \(test\) heading/);
  // Re-parsing the real source still yields all four (no shared mutation).
  assert.equal(wf.wfParseWorkflow(SKILL_SRC).phases.length, 4);
});

test('unit: dropping multiple phase headings warns for each missing one', () => {
  const modified = SKILL_SRC
    .replace('## Phase 2 — Build (coder)', '## Build (coder)')
    .replace('## Phase 4 — Tech-lead review (reviewer), post-processing, then done',
      '## Tech-lead review (reviewer), post-processing, then done');
  const { phases, warnings } = wf.wfParseWorkflow(modified);
  assert.deepEqual(phases.map((p) => p.key), ['plan', 'test']);
  assert.equal(warnings.length, 2);
  assert.ok(warnings.some((w) => /Missing Phase 2 \(build\)/.test(w)));
  assert.ok(warnings.some((w) => /Missing Phase 4 \(review\)/.test(w)));
});

// ---------------------------------------------------------------------------
// Junk / null input — empty phases, never throws
// ---------------------------------------------------------------------------

test('unit: non-string inputs -> empty phases + a "not a string" warning, never throws', () => {
  for (const junk of [null, undefined, 12345, {}, [], true, Symbol('x'), () => {}]) {
    let result;
    assert.doesNotThrow(() => { result = wf.wfParseWorkflow(junk); });
    assert.deepEqual(result.phases, []);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /not a string/i);
  }
});

test('unit: empty string -> empty phases + four missing-phase warnings', () => {
  const { phases, warnings } = wf.wfParseWorkflow('');
  assert.deepEqual(phases, []);
  assert.equal(warnings.length, 4);
  for (const label of ['plan', 'build', 'test', 'review']) {
    assert.ok(warnings.some((w) => w.includes(label)), `a warning names the ${label} phase`);
  }
});

test('unit: binary-garbage string -> four missing-phase warnings, never throws', () => {
  const bin = Buffer.from([0, 255, 10, 65, 0, 66, 13, 10, 200]).toString('binary');
  let result;
  assert.doesNotThrow(() => { result = wf.wfParseWorkflow(bin); });
  assert.deepEqual(result.phases, []);
  assert.equal(result.warnings.length, 4);
});

test('unit: reordered headings still return canonical plan/build/test/review order', () => {
  const md = [
    '## Phase 2 — Build (coder)',
    'dispatch to orchestrate-coder',
    '## Phase 4 — Review',
    'orchestrate-tech-lead reviews',
    '## Phase 1 — Plan / Define',
    'orchestrate-ba on `claude-fable-5` otherwise `claude-opus-4-8`',
    '## Phase 3 — Test',
    'orchestrate-tester runs tests',
  ].join('\n');
  const { phases, warnings } = wf.wfParseWorkflow(md);
  assert.deepEqual(phases.map((p) => p.key), ['plan', 'build', 'test', 'review']);
  assert.deepEqual(warnings, []);
  assert.deepEqual(phases.find((p) => p.key === 'plan').model, { primary: FABLE, fallback: OPUS });
});

// ---------------------------------------------------------------------------
// wfIsFallback — present vs missing agent (mirror of isFallback)
// ---------------------------------------------------------------------------

test('unit: wfIsFallback is false when the dedicated agent IS present', () => {
  const present = ['orchestrate-ba', 'orchestrate-coder', 'orchestrate-tester', 'orchestrate-tech-lead'];
  for (const a of present) {
    assert.equal(wf.wfIsFallback(a, present), false, `${a} present -> not a fallback`);
  }
});

test('unit: wfIsFallback is true when the dedicated agent is ABSENT', () => {
  const withoutTester = ['orchestrate-ba', 'orchestrate-coder', 'orchestrate-tech-lead'];
  assert.equal(wf.wfIsFallback('orchestrate-tester', withoutTester), true, 'missing tester -> falls back');
  assert.equal(wf.wfIsFallback('orchestrate-ba', withoutTester), false, 'present ba -> no fallback');
  assert.equal(wf.wfIsFallback('orchestrate-ba', []), true, 'empty available -> falls back');
});

test('unit: wfIsFallback never flags the general-purpose fallback itself, and tolerates junk', () => {
  assert.equal(wf.wfIsFallback('general-purpose', []), false, 'the fallback is not itself a fallback');
  // F1 (TASK-123): the renderer mirror is now byte-faithful to lib isFallback —
  // a non-string/empty name resolves to the fallback, so it IS a fallback.
  assert.equal(wf.wfIsFallback('', ['orchestrate-ba']), true, 'empty name resolves to the fallback -> IS a fallback (lib parity)');
  assert.equal(wf.wfIsFallback(null, ['orchestrate-ba']), true, 'null name resolves to the fallback -> IS a fallback (lib parity)');
  assert.equal(wf.wfIsFallback('orchestrate-ba', null), true, 'null available -> falls back');
  assert.equal(wf.wfIsFallback('orchestrate-ba', undefined), true, 'undefined available -> falls back');
});
