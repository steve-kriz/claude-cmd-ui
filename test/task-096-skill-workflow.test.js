'use strict';

// ===========================================================================
// TASK-096 — UNIT tests for the REAL lib/skill-workflow.js pure read-model.
//
// parseWorkflow(skillMd) -> { phases:[{key,title,agent,model?,headingLine}],
// warnings:[] }. Electron-free, no I/O, TOTALLY tolerant of junk: any
// null/undefined/non-string/binary/garbage input yields { phases:[],
// warnings:[...] } and NEVER throws. These tests exercise the exported API and
// its edge cases directly via require() against BOTH the real bundled SKILL.md
// and in-memory fixture strings.
//
// NO DATABASE, NO REAL FILESYSTEM WRITE, NO NETWORK, NO IPC. The only read is
// the bundled SKILL.md source file (read-only). Any DB calls, were there any,
// would be mocked — this module touches none.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  parseWorkflow,
  PHASE_SPECS,
  PLAN_MODEL_PRIMARY,
  PLAN_MODEL_FALLBACK,
} = require('../lib/skill-workflow');
const { AGENT_TYPES } = require('../lib/orchestrate-agents');

const ROOT = path.join(__dirname, '..');
const PROJECT_SKILL = path.join(ROOT, '.claude', 'skills', 'orchestrate', 'SKILL.md');
const SKILL_SRC = fs.readFileSync(PROJECT_SKILL, 'utf8');

const PRIMARY = 'claude-opus-4-8';   // the premium planning tier (BA primary)
const FALLBACK = 'claude-sonnet-5';  // the swarm default the BA degrades to

// ---------------------------------------------------------------------------
// Exported constants
// ---------------------------------------------------------------------------

test('unit: PLAN_MODEL_PRIMARY / PLAN_MODEL_FALLBACK are the exact model ids', () => {
  assert.equal(PLAN_MODEL_PRIMARY, PRIMARY);
  assert.equal(PLAN_MODEL_FALLBACK, FALLBACK);
});

test('unit: PHASE_SPECS is a frozen array of four canonical phases in order', () => {
  assert.ok(Array.isArray(PHASE_SPECS));
  assert.ok(Object.isFrozen(PHASE_SPECS));
  assert.equal(PHASE_SPECS.length, 4);
  assert.deepEqual(PHASE_SPECS.map((s) => s.key), ['plan', 'build', 'test', 'review']);
  assert.deepEqual(PHASE_SPECS.map((s) => s.number), [1, 2, 3, 4]);
});

test('unit: PHASE_SPECS agents are sourced from AGENT_TYPES', () => {
  const byKey = Object.fromEntries(PHASE_SPECS.map((s) => [s.key, s.agent]));
  assert.equal(byKey.plan, AGENT_TYPES.ba);
  assert.equal(byKey.build, AGENT_TYPES.coder);
  assert.equal(byKey.test, AGENT_TYPES.tester);
  assert.equal(byKey.review, AGENT_TYPES.techLead);
});

// ---------------------------------------------------------------------------
// parseWorkflow against the REAL bundled SKILL.md
// ---------------------------------------------------------------------------

test('unit: real SKILL.md -> four phases, canonical order, no warnings', () => {
  const { phases, warnings } = parseWorkflow(SKILL_SRC);
  assert.deepEqual(phases.map((p) => p.key), ['plan', 'build', 'test', 'review']);
  assert.deepEqual(warnings, []);
});

test('unit: real SKILL.md -> agents match AGENT_TYPES / AGENT_NAMES', () => {
  const { phases } = parseWorkflow(SKILL_SRC);
  const byKey = Object.fromEntries(phases.map((p) => [p.key, p.agent]));
  assert.equal(byKey.plan, 'orchestrate-ba');
  assert.equal(byKey.build, 'orchestrate-coder');
  assert.equal(byKey.test, 'orchestrate-tester');
  assert.equal(byKey.review, 'orchestrate-tech-lead');
});

test('unit: real SKILL.md -> each phase carries the correct 1-based headingLine', () => {
  const { phases } = parseWorkflow(SKILL_SRC);
  const lines = SKILL_SRC.split(/\r?\n/);
  const canonicalNumber = Object.fromEntries(PHASE_SPECS.map((s) => [s.key, s.number]));
  // Structural (not exact-line-number) check: benign edits above the headings
  // must not break this. For each phase: headingLine is a positive integer, the
  // line it points at is a `## Phase <n>` heading whose <n> equals that phase's
  // canonical PHASE_SPECS number. (No literal 134/194/337/379 assertions.)
  for (const p of phases) {
    assert.ok(
      Number.isInteger(p.headingLine) && p.headingLine >= 1,
      `${p.key} headingLine is a positive integer`,
    );
    const n = canonicalNumber[p.key];
    assert.match(lines[p.headingLine - 1], new RegExp(`^##\\s+Phase\\s+${n}\\b`));
  }
  // The four headingLine values are distinct.
  const headingLines = phases.map((p) => p.headingLine);
  assert.equal(new Set(headingLines).size, headingLines.length, 'headingLines are distinct');
});

test('unit: a benign line inserted above Phase 1 shifts headingLines but still parses structurally', () => {
  // Prove the structural headingLine assertions are resilient to benign edits
  // above the headings (the point of dropping the literal line numbers in F1).
  const shifted = 'An extra intro line.\n' + SKILL_SRC;
  const lines = shifted.split(/\r?\n/);
  const canonicalNumber = Object.fromEntries(PHASE_SPECS.map((s) => [s.key, s.number]));
  const { phases, warnings } = parseWorkflow(shifted);
  assert.deepEqual(phases.map((p) => p.key), ['plan', 'build', 'test', 'review']);
  assert.deepEqual(warnings, []);
  for (const p of phases) {
    assert.ok(Number.isInteger(p.headingLine) && p.headingLine >= 1);
    const n = canonicalNumber[p.key];
    assert.match(lines[p.headingLine - 1], new RegExp(`^##\\s+Phase\\s+${n}\\b`));
  }
});

test('unit: real SKILL.md -> only the plan phase carries a model directive', () => {
  const { phases } = parseWorkflow(SKILL_SRC);
  const plan = phases.find((p) => p.key === 'plan');
  assert.deepEqual(plan.model, { primary: PRIMARY, fallback: FALLBACK });
  for (const p of phases.filter((x) => x.key !== 'plan')) {
    assert.equal(p.model, undefined, `${p.key} phase has no model key`);
  }
});

test('unit: real SKILL.md -> the fence-embedded sample ticket never opens a phantom section', () => {
  // The `~~~markdown` sample-ticket block contains `## Description`, and line
  // ~224 contains an inline ```gherkin mention inside prose; neither may derail
  // the parse. Proof: exactly four phases, headingLines strictly increasing.
  const { phases } = parseWorkflow(SKILL_SRC);
  assert.equal(phases.length, 4);
  const linesInOrder = phases.map((p) => p.headingLine);
  const sorted = [...linesInOrder].sort((a, b) => a - b);
  assert.deepEqual(linesInOrder, sorted);
});

// ---------------------------------------------------------------------------
// Junk / non-string input — never throws
// ---------------------------------------------------------------------------

test('unit: non-string inputs -> empty phases + a "not a string" warning, never throws', () => {
  for (const junk of [null, undefined, 12345, {}, [], true, Symbol('x'), () => {}]) {
    let result;
    assert.doesNotThrow(() => { result = parseWorkflow(junk); });
    assert.deepEqual(result.phases, []);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /not a string/i);
  }
});

test('unit: empty string -> empty phases + four missing-phase warnings', () => {
  const { phases, warnings } = parseWorkflow('');
  assert.deepEqual(phases, []);
  assert.equal(warnings.length, 4);
  for (const label of ['plan', 'build', 'test', 'review']) {
    assert.ok(
      warnings.some((w) => w.includes(label)),
      `a warning names the ${label} phase`,
    );
  }
});

test('unit: binary-garbage string -> four missing-phase warnings, never throws', () => {
  const bin = Buffer.from([0, 255, 10, 65, 0, 66, 13, 10, 200]).toString('binary');
  let result;
  assert.doesNotThrow(() => { result = parseWorkflow(bin); });
  assert.deepEqual(result.phases, []);
  assert.equal(result.warnings.length, 4);
});

// ---------------------------------------------------------------------------
// Missing-phase edge — modified fixture strings
// ---------------------------------------------------------------------------

test('unit: removing the Phase 3 heading omits test + warns naming phase 3', () => {
  const modified = SKILL_SRC.replace(
    '## Phase 3 — Test (tester) and the fix loop',
    '## Test (tester) and the fix loop',
  );
  // Guard against a silent no-op if the heading wording drifts: the fixture MUST
  // differ from the source, else the "missing phase" below is meaningless.
  assert.notEqual(modified, SKILL_SRC, 'fixture .replace must actually remove the Phase 3 heading');
  const { phases, warnings } = parseWorkflow(modified);
  assert.deepEqual(phases.map((p) => p.key), ['plan', 'build', 'review']);
  assert.equal(warnings.length, 1);
  // Shape match (phase number + label), not exact prose, so benign rewording of
  // the warning survives but dropping the phase number/label still fails.
  assert.match(warnings[0], /Phase 3/);
  assert.match(warnings[0], /test/i);
  // Real source is untouched: re-parsing it still yields all four.
  assert.equal(parseWorkflow(SKILL_SRC).phases.length, 4);
});

test('unit: removing multiple phase headings warns for each missing one', () => {
  // Guard EACH replacement individually — a chained `.replace` would silently
  // no-op if one heading's wording drifted, hiding a fixture rot as a parser bug.
  const withoutPhase2 = SKILL_SRC.replace('## Phase 2 — Build (coder)', '## Build (coder)');
  assert.notEqual(withoutPhase2, SKILL_SRC, 'fixture .replace must remove the Phase 2 heading');
  const modified = withoutPhase2.replace(
    '## Phase 4 — Tech-lead review (reviewer), post-processing, then done',
    '## Tech-lead review (reviewer), post-processing, then done');
  assert.notEqual(modified, withoutPhase2, 'fixture .replace must remove the Phase 4 heading');
  const { phases, warnings } = parseWorkflow(modified);
  assert.deepEqual(phases.map((p) => p.key), ['plan', 'test']);
  assert.equal(warnings.length, 2);
  // Shape match (phase number + label), not exact prose.
  assert.ok(warnings.some((w) => /Phase 2/.test(w) && /build/i.test(w)));
  assert.ok(warnings.some((w) => /Phase 4/.test(w) && /review/i.test(w)));
});

// ---------------------------------------------------------------------------
// Fence suppression — a `## Phase <n>`-shaped line inside a ```fence``` must NOT
// be counted as a phase heading (SKILL.md embeds sample blocks in fences).
// ---------------------------------------------------------------------------

test('unit: a `## Phase <n>`-shaped heading inside a fence is not counted', () => {
  const src = [
    '## Phase 1 — Plan / Define',
    'orchestrate-ba on `claude-fable-5` otherwise `claude-opus-4-8`',
    '',
    'A fenced sample below must NOT be parsed as a phase heading:',
    '```markdown',
    '## Phase 2 — Example (inside a fence; must be ignored)',
    'fenced body text',
    '```',
    '',
    '## Phase 2 — Build (coder)',
    'orchestrate-coder',
    '## Phase 3 — Test',
    'orchestrate-tester',
    '## Phase 4 — Review',
    'orchestrate-tech-lead',
  ];
  const md = src.join('\n');
  // The fenced fake sits BEFORE the real Phase 2, so first-heading-wins would
  // pick it if fences were mishandled.
  const fencedLine = src.indexOf('## Phase 2 — Example (inside a fence; must be ignored)') + 1;
  const realBuildLine = src.indexOf('## Phase 2 — Build (coder)') + 1;

  const { phases, warnings } = parseWorkflow(md);
  assert.equal(phases.length, 4);
  assert.deepEqual(phases.map((p) => p.key), ['plan', 'build', 'test', 'review']);
  assert.deepEqual(warnings, []);
  const build = phases.find((p) => p.key === 'build');
  assert.equal(build.headingLine, realBuildLine, 'build points at the real unfenced Phase 2');
  for (const p of phases) {
    assert.notEqual(p.headingLine, fencedLine, `no phase points at the fenced line ${fencedLine}`);
  }
});

test('unit: a Phase 2 heading present ONLY inside a fence is treated as missing', () => {
  const src = [
    '## Phase 1 — Plan / Define',
    'orchestrate-ba on `claude-fable-5` otherwise `claude-opus-4-8`',
    '',
    '```markdown',
    '## Phase 2 — Build (coder) is fenced here, so it must not count as a heading',
    'fenced body text',
    '```',
    '## Phase 3 — Test',
    'orchestrate-tester',
    '## Phase 4 — Review',
    'orchestrate-tech-lead',
  ];
  const { phases, warnings } = parseWorkflow(src.join('\n'));
  // Build is omitted because its only Phase-2 heading is fenced.
  assert.deepEqual(phases.map((p) => p.key), ['plan', 'test', 'review']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Phase 2/);
  assert.match(warnings[0], /build/i);
});

// ---------------------------------------------------------------------------
// Reordering + CRLF tolerance (edge cases named in the ticket)
// ---------------------------------------------------------------------------

test('unit: reordered headings still return phases in canonical plan/build/test/review order', () => {
  const md = [
    '## Phase 2 — Build (coder)',            // line 1
    'dispatch to orchestrate-coder',
    '## Phase 4 — Review',                    // line 3
    'orchestrate-tech-lead reviews',
    '## Phase 1 — Plan / Define',             // line 5
    'orchestrate-ba on `claude-opus-4-8` else the default `claude-sonnet-5`',
    '## Phase 3 — Test',                       // line 7
    'orchestrate-tester runs tests',
  ].join('\n');
  const { phases, warnings } = parseWorkflow(md);
  assert.deepEqual(phases.map((p) => p.key), ['plan', 'build', 'test', 'review']);
  assert.deepEqual(warnings, []);
  // headingLine reflects the ACTUAL document position, not canonical order.
  const byKey = Object.fromEntries(phases.map((p) => [p.key, p.headingLine]));
  assert.equal(byKey.build, 1);
  assert.equal(byKey.review, 3);
  assert.equal(byKey.plan, 5);
  assert.equal(byKey.test, 7);
  assert.deepEqual(byKey.plan && phases.find((p) => p.key === 'plan').model,
    { primary: PRIMARY, fallback: FALLBACK });
});

test('unit: CRLF line endings parse identically to LF', () => {
  const lf = parseWorkflow(SKILL_SRC);
  const crlf = parseWorkflow(SKILL_SRC.replace(/\n/g, '\r\n'));
  assert.deepEqual(
    crlf.phases.map((p) => ({ key: p.key, agent: p.agent, headingLine: p.headingLine })),
    lf.phases.map((p) => ({ key: p.key, agent: p.agent, headingLine: p.headingLine })),
  );
  assert.deepEqual(crlf.warnings, lf.warnings);
});

// ---------------------------------------------------------------------------
// Model-directive detection details
// ---------------------------------------------------------------------------

test('unit: plan phase with directive present but no explicit fallback token -> canonical fallback', () => {
  const md = [
    '## Phase 1 — Plan',
    'dispatch orchestrate-ba on `claude-opus-4-8` when available.',
    '## Phase 2 — Build',
    'orchestrate-coder',
    '## Phase 3 — Test',
    'orchestrate-tester',
    '## Phase 4 — Review',
    'orchestrate-tech-lead',
  ].join('\n');
  const { phases } = parseWorkflow(md);
  const plan = phases.find((p) => p.key === 'plan');
  assert.deepEqual(plan.model, { primary: PRIMARY, fallback: FALLBACK });
});

test('unit: plan phase with no model directive at all -> no model key', () => {
  const md = [
    '## Phase 1 — Plan',
    'dispatch orchestrate-ba (no model stated here).',
    '## Phase 2 — Build',
    'orchestrate-coder',
    '## Phase 3 — Test',
    'orchestrate-tester',
    '## Phase 4 — Review',
    'orchestrate-tech-lead',
  ].join('\n');
  const { phases } = parseWorkflow(md);
  const plan = phases.find((p) => p.key === 'plan');
  assert.equal(plan.model, undefined);
});

test('unit: unknown orchestrate-* token in a phase body falls back to the canonical agent', () => {
  const md = [
    '## Phase 1 — Plan',
    'dispatch orchestrate-nonsense (not a known agent)',
    '## Phase 2 — Build',
    'orchestrate-coder',
    '## Phase 3 — Test',
    'orchestrate-tester',
    '## Phase 4 — Review',
    'orchestrate-tech-lead',
  ].join('\n');
  const { phases } = parseWorkflow(md);
  const plan = phases.find((p) => p.key === 'plan');
  // orchestrate-nonsense is not in AGENT_NAMES -> canonical spec default used.
  assert.equal(plan.agent, AGENT_TYPES.ba);
});
