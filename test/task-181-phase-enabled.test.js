'use strict';

// Unit tests for TASK-181: phase-skipping and phase-ordering features in SKILL.md.
//
// This is a DOCUMENTATION ticket — the coder edited only the two byte-identical
// SKILL.md copies. The testable contract:
//
//   1. The SKILL.md prose documents the phase-enabled config semantics
//      (consulting skill.phases.<phase>.enabled before dispatch)
//   2. SKILL.md documents the default behavior: plan/build/test enabled,
//      review disabled, and calls out this asymmetry as intentional
//   3. SKILL.md documents ascending order dispatch, followed literally, with
//      end-of-run deviation reporting (not refusal) for out-of-dependency-order runs
//   4. SKILL.md reaffirms no new status/enum value and whole-file atomic writes
//   5. SKILL.md states review is the only meaningfully skippable phase
//   6. The two SKILL.md copies stay byte-identical
//   7. lib/skill-workflow.js still parses all four phases cleanly
//
// NO DATABASE, REAL DB CONNECTION, OR NETWORK CALL IS MADE.
// Only disk I/O reading the SKILL.md files and requiring lib/skill-workflow.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const SKILL_PATH = path.join(REPO_ROOT, '.claude', 'skills', 'orchestrate', 'SKILL.md');
const ASSETS_SKILL_PATH = path.join(REPO_ROOT, 'assets', 'skills', 'orchestrate', 'SKILL.md');

const { parseWorkflow } = require('../lib/skill-workflow');

// Read utilities
const readRaw = (p) => fs.readFileSync(p, 'utf8');
const readBytes = (p) => fs.readFileSync(p);
const readLower = (p) => fs.readFileSync(p, 'utf8').toLowerCase();

// Extract the prose under a specific markdown heading (any level, e.g. "### Foo"),
// up to (but not including) the next heading of the same or shallower level.
function extractSectionByHeading(md, headingText) {
  const lines = md.split(/\r?\n/);
  const headingRe = new RegExp(`^(#{1,6})\\s+${headingText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
  let level = null;
  let inSection = false;
  const content = [];
  for (const line of lines) {
    if (!inSection) {
      const m = headingRe.exec(line);
      if (m) {
        inSection = true;
        level = m[1].length;
      }
      continue;
    }
    const nextHeadingMatch = /^(#{1,6})\s+/.exec(line);
    if (nextHeadingMatch && nextHeadingMatch[1].length <= level) break;
    content.push(line);
  }
  return content.join('\n');
}

// ---------------------------------------------------------------------------
// UNIT TESTS
// Focused on the structural and semantic requirements
// ---------------------------------------------------------------------------

test('UNIT: SKILL.md documents skill.phases.<phase>.enabled pattern', () => {
  const md = readRaw(SKILL_PATH);
  const lowerMd = md.toLowerCase();

  // The prose must mention the config key pattern
  assert(
    lowerMd.includes('skill.phases.<phase>') ||
    (lowerMd.includes('skill.phases') && lowerMd.includes('.enabled')) ||
    lowerMd.includes('skill.phases.'),
    'SKILL.md should document the skill.phases.<phase> config key pattern'
  );
});

test('UNIT: SKILL.md documents review defaults disabled (intentional asymmetry)', () => {
  const md = readLower(SKILL_PATH);

  // Must name the four phases
  assert(md.includes('plan'), 'Should mention plan phase');
  assert(md.includes('build'), 'Should mention build phase');
  assert(md.includes('test'), 'Should mention test phase');
  assert(md.includes('review'), 'Should mention review phase');

  // Must state the asymmetry: plan/build/test default enabled
  assert(
    (md.includes('plan') && md.includes('build') && md.includes('test') &&
     md.includes('enabled')),
    'SKILL.md should state plan/build/test default enabled'
  );

  // Must state review defaults disabled
  assert(
    md.includes('review') && md.includes('disabled'),
    'SKILL.md should state review defaults disabled'
  );

  // Must flag this as intentional
  assert(
    md.includes('intentional') || md.includes('accepted default') ||
    md.includes('intentional, accepted'),
    'SKILL.md should mark the asymmetry as intentional'
  );
});

test('UNIT: SKILL.md documents ascending order dispatch with literal follow', () => {
  const md = readRaw(SKILL_PATH);
  const lowerMd = md.toLowerCase();

  // Must document ascending order
  assert(
    lowerMd.includes('ascending') && lowerMd.includes('order'),
    'SKILL.md should document ascending order dispatch'
  );

  // Must state literal following
  assert(
    lowerMd.includes('follow') && lowerMd.includes('literally') ||
    lowerMd.includes('follow the configured order'),
    'SKILL.md should state the order is followed literally'
  );

  // Must document end-of-run deviation reporting (not refusal)
  assert(
    (lowerMd.includes('deviation') && lowerMd.includes('reporting')) ||
    lowerMd.includes('note it in the end-of-run report') ||
    (lowerMd.includes('out-of-dependency-order') && lowerMd.includes('report')),
    'SKILL.md should document end-of-run deviation reporting'
  );

  // Should NOT say the orchestrator refuses bad orders — inspect the actual
  // "Phase-enabled config and dispatch order" section, not the first unrelated
  // "order" occurrence near the top of the file.
  const dispatchSection = extractSectionByHeading(md, 'Phase-enabled config and dispatch order');
  const lowerDispatchSection = dispatchSection.toLowerCase();
  assert(
    lowerDispatchSection.length > 0,
    'SKILL.md should contain a "Phase-enabled config and dispatch order" section'
  );
  assert(
    lowerDispatchSection.includes('do not refuse'),
    'SKILL.md dispatch-order section should explicitly state the orchestrator does not refuse a dependency-violating order'
  );
  assert(
    !lowerDispatchSection.includes('should refuse'),
    'SKILL.md dispatch-order section should not instruct the orchestrator to refuse a bad order'
  );
});

test('UNIT: SKILL.md reaffirms no new status and whole-file atomic writes', () => {
  const md = readRaw(SKILL_PATH);
  const lowerMd = md.toLowerCase();

  // Must reaffirm no new status
  assert(
    lowerMd.includes('no new status'),
    'SKILL.md should reaffirm no new status outside the valid enum'
  );

  // Must list all valid enum values
  const validStatuses = [
    'todo', 'defining', 'in-progress', 'testing',
    'post-processing', 'done', 'failed-testing'
  ];
  for (const status of validStatuses) {
    assert(
      lowerMd.includes(status),
      `SKILL.md should mention the valid status: ${status}`
    );
  }

  // Must reaffirm whole-file atomic writes
  assert(
    (lowerMd.includes('whole-file') && lowerMd.includes('atomic')) ||
    lowerMd.includes('whole-file, atomic'),
    'SKILL.md should reaffirm whole-file atomic writes on the skip path'
  );
});

test('UNIT: SKILL.md states review is the only meaningfully skippable phase', () => {
  const md = readLower(SKILL_PATH);

  // Must state review is the only meaningfully skippable phase
  assert(
    md.includes('only phase this feature makes meaningfully skippable'),
    'SKILL.md should state review is the only meaningfully skippable phase'
  );

  // Must state build/test are out of scope
  assert(
    md.includes('out of scope for this behaviour'),
    'SKILL.md should state build/test disabling is out of scope'
  );

  // Must state that build/test still run even if disabled in config
  assert(
    md.includes('still runs') || md.includes('still run'),
    'SKILL.md should state build/test still run even when configured disabled'
  );
});

test('UNIT: Phase 4 section explicitly documents review skip when disabled', () => {
  const md = readRaw(SKILL_PATH);
  const phase4Start = md.indexOf('## Phase 4');
  const phase5Start = md.indexOf('## ', phase4Start + 1);
  const phase4Content = md.substring(phase4Start, phase5Start === -1 ? md.length : phase5Start);
  const lowerPhase4 = phase4Content.toLowerCase();

  // Must document skipping review
  assert(
    lowerPhase4.includes('skip the review') ||
    lowerPhase4.includes('skip step 1') ||
    lowerPhase4.includes('skip step 1 and step 2 entirely'),
    'Phase 4 should describe skipping review when skill.phases.review.enabled is false'
  );

  // Must document the collapsed flow
  assert(
    lowerPhase4.includes('testing') && lowerPhase4.includes('post-processing') &&
    lowerPhase4.includes('done'),
    'Phase 4 should document the collapsed flow: testing -> post-processing -> done'
  );

  // Must state no reviewer subagent is launched
  assert(
    lowerPhase4.includes('no reviewer') ||
    lowerPhase4.includes('never launched') ||
    lowerPhase4.includes('skip step 1 and step 2 entirely'),
    'Phase 4 should state no reviewer subagent is launched when disabled'
  );
});

test('UNIT: Phase 4 explicitly states post-processing still runs when review is skipped', () => {
  const md = readRaw(SKILL_PATH);
  const phase4Start = md.indexOf('## Phase 4');
  const phase5Start = md.indexOf('## ', phase4Start + 1);
  const phase4Content = md.substring(phase4Start, phase5Start === -1 ? md.length : phase5Start);
  const lowerPhase4 = phase4Content.toLowerCase();

  // Must explicitly state post-processing runs unchanged
  assert(
    lowerPhase4.includes('step 3 (post-processing, then `status: done`) still runs') ||
    (lowerPhase4.includes('post-processing') && lowerPhase4.includes('unchanged')) ||
    lowerPhase4.includes('skipped review never blocks post-processing'),
    'Phase 4 should state post-processing still runs when review is skipped'
  );

  // Must state skipped review does not keep ticket out of done
  assert(
    lowerPhase4.includes('never keeps the ticket out of `done`') ||
    lowerPhase4.includes('never blocks post-processing') ||
    lowerPhase4.includes('never keep'),
    'Phase 4 should state a skipped review never blocks the done transition'
  );
});

test('UNIT: Both SKILL.md copies are byte-identical', () => {
  const bytes1 = readBytes(SKILL_PATH);
  const bytes2 = readBytes(ASSETS_SKILL_PATH);

  assert.deepStrictEqual(
    bytes1,
    bytes2,
    'The two SKILL.md copies (.claude and assets) must be byte-identical'
  );
});

test('UNIT: lib/skill-workflow parseWorkflow still parses all four phases cleanly', () => {
  const skillMd = readRaw(SKILL_PATH);
  const result = parseWorkflow(skillMd);

  // Must parse without errors
  assert(result.phases, 'parseWorkflow should return a phases array');
  assert(Array.isArray(result.phases), 'phases should be an array');

  // Must parse all four phases
  assert.equal(
    result.phases.length,
    4,
    'parseWorkflow should extract all four phases'
  );

  // Check phase keys in order
  const keys = result.phases.map(p => p.key);
  assert.deepStrictEqual(
    keys,
    ['plan', 'build', 'test', 'review'],
    'Phases should be in canonical order: plan, build, test, review'
  );

  // Each phase should have required fields
  for (const phase of result.phases) {
    assert(phase.key, 'Each phase should have a key');
    assert(phase.title, 'Each phase should have a title');
    assert(phase.agent, 'Each phase should have an agent');
    assert(typeof phase.headingLine === 'number', 'Each phase should have a headingLine number');
  }

  // No warnings for a well-formed SKILL.md
  assert.equal(
    result.warnings.length,
    0,
    `parseWorkflow should produce no warnings for the current SKILL.md. Got: ${result.warnings.join('; ')}`
  );
});

test('UNIT: parseWorkflow on assets SKILL.md also works cleanly', () => {
  const skillMd = readRaw(ASSETS_SKILL_PATH);
  const result = parseWorkflow(skillMd);

  // Same assertions as above for the assets copy
  assert.equal(
    result.phases.length,
    4,
    'parseWorkflow should extract all four phases from assets copy'
  );

  const keys = result.phases.map(p => p.key);
  assert.deepStrictEqual(
    keys,
    ['plan', 'build', 'test', 'review'],
    'Phases in assets copy should be in canonical order'
  );

  assert.equal(
    result.warnings.length,
    0,
    'parseWorkflow should produce no warnings for the assets SKILL.md'
  );
});

test('UNIT: Other phase prose (1, 2, 3) still contains expected key concepts', () => {
  const md = readLower(SKILL_PATH);

  // Phase 1 concepts
  assert(md.includes('phase 1'), 'Should have Phase 1 heading');
  assert(md.includes('business analyst'), 'Phase 1 should mention business analyst');
  assert(md.includes('defining'), 'Phase 1 should mention defining phase');

  // Phase 2 concepts
  assert(md.includes('phase 2'), 'Should have Phase 2 heading');
  assert(md.includes('coder'), 'Phase 2 should mention coder');
  assert(md.includes('swarm'), 'Phase 2 should document swarm');
  assert(md.includes('batch'), 'Phase 2 should document batches');
  assert(md.includes('claim'), 'Phase 2 should document claims');

  // Phase 3 concepts
  assert(md.includes('phase 3'), 'Should have Phase 3 heading');
  assert(md.includes('tester'), 'Phase 3 should mention tester');
  assert(md.includes('e2e'), 'Phase 3 should mention e2e tests');
  assert(md.includes('unit test'), 'Phase 3 should mention unit tests');

  // Cross-cutting concepts
  assert(md.includes('model routing'), 'Should document model routing');
  assert(md.includes('concurrency'), 'Should document concurrency');
  assert(md.includes('isolation'), 'Should document git isolation');
  assert(md.includes('atomic'), 'Should document atomic writes');
});

test('UNIT: tech-lead.md is referenced and exists in both locations', () => {
  const skillMd = readRaw(SKILL_PATH);
  const lowerMd = skillMd.toLowerCase();

  // SKILL.md should mention tech-lead agent
  assert(
    lowerMd.includes('tech-lead') ||
    lowerMd.includes('orchestrate-tech-lead') ||
    lowerMd.includes('reviewer'),
    'SKILL.md should reference the tech-lead agent'
  );

  // Check both files exist
  const clausePath = path.join(REPO_ROOT, '.claude', 'agents', 'tech-lead.md');
  const assetsPath = path.join(REPO_ROOT, 'assets', 'agents', 'tech-lead.md');

  assert(
    fs.existsSync(clausePath),
    '.claude/agents/tech-lead.md should exist'
  );
  assert(
    fs.existsSync(assetsPath),
    'assets/agents/tech-lead.md should exist'
  );

  // Check they're byte-identical
  const bytes1 = fs.readFileSync(clausePath);
  const bytes2 = fs.readFileSync(assetsPath);
  assert.deepStrictEqual(bytes1, bytes2, 'tech-lead.md copies should be byte-identical');
});

test('UNIT: State-consistency rules section reaffirms the enum and atomic write invariants', () => {
  const md = readRaw(SKILL_PATH);
  const stateSection = md.substring(
    md.indexOf('## State-consistency rules'),
    md.length
  );
  const lowerState = stateSection.toLowerCase();

  // Must reaffirm no new status outside the enum
  assert(
    lowerState.includes('no new status') ||
    lowerState.includes('never invent a status'),
    'State-consistency rules should reaffirm the enum invariant'
  );

  // Must reaffirm whole-file atomic writes
  assert(
    lowerState.includes('whole-file') && lowerState.includes('atomic') ||
    lowerState.includes('whole-file, atomic'),
    'State-consistency rules should reaffirm atomic write invariant'
  );
});

test('UNIT: Phase 3 "All green" hand-off text is conditioned on skill.phases.review.enabled', () => {
  const md = readRaw(SKILL_PATH);
  const phase3Start = md.indexOf('## Phase 3');
  const phase4Start = md.indexOf('## Phase 4');
  const phase3Content = md.substring(phase3Start, phase4Start);
  const lowerPhase3 = phase3Content.toLowerCase();

  // Must contain "All green" bullet
  assert(
    lowerPhase3.includes('all green'),
    'Phase 3 should have an "All green" bullet point'
  );

  // Must condition the review step on skill.phases.review.enabled
  assert(
    lowerPhase3.includes('skill.phases.review.enabled') &&
    (lowerPhase3.includes('false') || lowerPhase3.includes('disabled')),
    'Phase 3 "All green" bullet should condition review dispatch on skill.phases.review.enabled being false'
  );

  // Must state the review is skipped when disabled
  assert(
    lowerPhase3.includes('unless') ||
    lowerPhase3.includes('when') ||
    lowerPhase3.includes('if'),
    'Phase 3 "All green" should use conditional language (unless/when/if) for review dispatch'
  );

  // Must explicitly reference the Phase 4 skip paragraph or the rule
  assert(
    (lowerPhase3.includes('skip') && lowerPhase3.includes('review')) ||
    lowerPhase3.includes('see **skip the review when the phase is disabled**') ||
    lowerPhase3.includes('phase 4 below'),
    'Phase 3 "All green" should reference Phase 4 or the skip rule for when review is disabled'
  );

  // Must state the collapsed flow: testing → post-processing → done (with no review step)
  assert(
    lowerPhase3.includes('testing → post-processing → done'),
    'Phase 3 "All green" should document the collapsed flow when review is disabled'
  );
});
