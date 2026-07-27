'use strict';

// E2E cucumber-style tests for TASK-181: phase-skipping instruction in SKILL.md.
//
// The coder added documentation to SKILL.md describing how to consult
// skill.phases.<phase>.enabled to skip disabled phases, especially review (Phase 4).
// This is a DOCUMENTATION ticket — no product code changes — so tests focus on:
//
//   1. SKILL.md prose contains the required phase-enabled config semantics
//   2. SKILL.md states review defaults disabled (intentional asymmetry)
//   3. SKILL.md documents ascending order dispatch with literal follow + deviation reporting
//   4. SKILL.md reaffirms no new status/enum value and whole-file atomic writes
//   5. SKILL.md states review is the ONLY meaningfully skippable phase
//   6. The two SKILL.md copies stay byte-identical
//   7. Other phase prose is untouched (spot check key phrases)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const SKILL_PATH = path.join(REPO_ROOT, '.claude', 'skills', 'orchestrate', 'SKILL.md');
const ASSETS_SKILL_PATH = path.join(REPO_ROOT, 'assets', 'skills', 'orchestrate', 'SKILL.md');

// Read once, lowercased, for robust assertion across punctuation/casing
const readLower = (p) => fs.readFileSync(p, 'utf8').toLowerCase();
// Raw reads for byte-identical guard
const readBytes = (p) => fs.readFileSync(p);
const readRaw = (p) => fs.readFileSync(p, 'utf8');

// Helper: extract a section heading name from markdown
function extractSection(md, heading) {
  const re = new RegExp(`^## ${heading}\\b`, 'im');
  return re.test(md);
}

// Helper: extract prose under a heading of any level (e.g. "### Foo"), up to
// (but not including) the next heading of the same or shallower level.
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

// Helper: extract prose after a section heading up to the next ## heading
function extractSectionContent(md, heading) {
  const lines = md.split(/\r?\n/);
  let inSection = false;
  let content = [];
  const headingRe = new RegExp(`^## ${heading}\\b`, 'i');
  const nextHeadingRe = /^##\s+/;

  for (const line of lines) {
    if (!inSection && headingRe.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection) {
      if (nextHeadingRe.test(line)) break;
      content.push(line);
    }
  }
  return content.join('\n');
}

// ---------------------------------------------------------------------------
// E2E CUCUMBER-STYLE SCENARIOS
// Each scenario reads and asserts on SKILL.md prose structure
// ---------------------------------------------------------------------------

test('E2E cucumber: phase-enabled config section exists and documents the enabled check', async (t) => {
  await t.test(
    'Given SKILL.md defines phase-enabled config, ' +
      'When we read the Phase-enabled config section, ' +
      'Then it documents consulting skill.phases.<phase>.enabled before dispatch',
    () => {
      const md = readLower(SKILL_PATH);
      assert(
        md.includes('phase-enabled config') ||
        md.includes('skill.phases.<phase>.enabled') ||
        (md.includes('skill.phases') && md.includes('.enabled')),
        'SKILL.md should document the phase-enabled config pattern'
      );
      assert(
        md.includes('before dispatching') ||
        md.includes('before running') ||
        md.includes('before launching'),
        'SKILL.md should state the enabled check happens BEFORE dispatch'
      );
    },
  );
});

test('E2E cucumber: review defaults disabled when config absent', async (t) => {
  await t.test(
    'Given a project with no skill.phases in team-config, ' +
      'When SKILL.md documents the defaults, ' +
      'Then it states plan/build/test default enabled but review defaults disabled',
    () => {
      const md = readLower(SKILL_PATH);
      // Must document the asymmetry: plan/build/test enabled, review disabled
      assert(
        (md.includes('plan') && md.includes('build') && md.includes('test') &&
         md.includes('enabled')) &&
        md.includes('review') &&
        md.includes('disabled'),
        'SKILL.md should document review defaults disabled while plan/build/test default enabled'
      );
      // Must call out this as intentional
      assert(
        md.includes('intentional') ||
        md.includes('accepted default') ||
        md.includes('accepted,') ||
        md.includes('intentional, accepted'),
        'SKILL.md should flag this asymmetry as intentional'
      );
    },
  );
});

test('E2E cucumber: review disabled skips the tech-lead dispatch', async (t) => {
  await t.test(
    'Given team-config skill.phases.review.enabled is false, ' +
      'When SKILL.md Phase 4 prose is read, ' +
      'Then it states the flow becomes testing -> post-processing -> done with no review dispatch',
    () => {
      const md = readRaw(SKILL_PATH);
      const phase4Content = extractSectionContent(md, 'Phase 4');
      const lowerContent = phase4Content.toLowerCase();

      // The prose must state that review is skipped when disabled
      assert(
        lowerContent.includes('skip the review') ||
        lowerContent.includes('skip step 1') ||
        lowerContent.includes('skip step 1 and step 2'),
        'Phase 4 should describe skipping the review when disabled'
      );

      // Must state the collapsed flow: testing -> post-processing -> done
      assert(
        lowerContent.includes('testing') && lowerContent.includes('post-processing') &&
        lowerContent.includes('done'),
        'Phase 4 should document the collapsed flow: testing -> post-processing -> done'
      );

      // Must state no reviewer subagent is launched
      assert(
        lowerContent.includes('no reviewer') ||
        lowerContent.includes('no review') ||
        lowerContent.includes('never launched') ||
        lowerContent.includes('skip step 1 and step 2 entirely'),
        'Phase 4 should state no reviewer subagent is launched when review is disabled'
      );
    },
  );
});

test('E2E cucumber: post-processing still runs when review skipped', async (t) => {
  await t.test(
    'Given review is disabled, ' +
      'When the prose describes the skip, ' +
      'Then post-processing is still applied before done (skipping review must not skip post-processing)',
    () => {
      const md = readRaw(SKILL_PATH);
      const phase4Content = extractSectionContent(md, 'Phase 4');
      const lowerContent = phase4Content.toLowerCase();

      // Must explicitly state that post-processing still runs
      assert(
        lowerContent.includes('step 3 (post-processing, then `status: done`) still runs') ||
        lowerContent.includes('post-processing') && lowerContent.includes('unchanged') ||
        (lowerContent.includes('skipped review') && lowerContent.includes('post-processing')) ||
        lowerContent.includes('a skipped review never blocks post-processing'),
        'Phase 4 should state post-processing still runs when review is skipped'
      );
    },
  );
});

test('E2E cucumber: order dispatch follows configured sequence literally', async (t) => {
  await t.test(
    'Given configured ascending order in skill.phases.<phase>.order, ' +
      'When we read how dispatch proceeds, ' +
      'Then it states phases dispatch in ascending order, followed literally, with end-of-run deviation reporting',
    () => {
      const md = readLower(SKILL_PATH);

      // Must state ascending order dispatch
      assert(
        md.includes('ascending') && md.includes('order'),
        'SKILL.md should document ascending order dispatch'
      );

      // Must state the order is followed literally
      assert(
        md.includes('follow the configured order') ||
        md.includes('literally') ||
        md.includes('follow it literally'),
        'SKILL.md should state the order is followed literally'
      );

      // Must document end-of-run deviation reporting (not refusal)
      assert(
        md.includes('deviation') && (md.includes('reporting') || md.includes('report')) ||
        md.includes('note it in the end-of-run report') ||
        (md.includes('out-of-dependency-order') && md.includes('report')),
        'SKILL.md should document end-of-run deviation reporting for out-of-order phases'
      );

      // Must NOT state refusal of invalid orders — inspect the actual
      // "Phase-enabled config and dispatch order" section text, not the whole file.
      const rawMd = readRaw(SKILL_PATH);
      const dispatchSection = extractSectionByHeading(rawMd, 'Phase-enabled config and dispatch order');
      const lowerDispatchSection = dispatchSection.toLowerCase();
      assert(
        lowerDispatchSection.length > 0,
        'SKILL.md should contain a "Phase-enabled config and dispatch order" section'
      );
      assert(
        lowerDispatchSection.includes('do not refuse'),
        'SKILL.md dispatch-order section should explicitly state the orchestrator follows a configured order literally and does not refuse a dependency-violating order'
      );
      assert(
        !lowerDispatchSection.includes('should refuse'),
        'SKILL.md dispatch-order section should not instruct the orchestrator to refuse a bad order'
      );
    },
  );
});

test('E2E cucumber: enum is preserved — no new status introduced', async (t) => {
  await t.test(
    'When the phase-skip prose is read, ' +
      'Then it states no new status is introduced and writes stay whole-file atomic',
    () => {
      const md = readRaw(SKILL_PATH);
      const lowerContent = md.toLowerCase();

      // Must reaffirm no new status outside the valid enum
      assert(
        lowerContent.includes('no new status') ||
        lowerContent.includes('introduces no new'),
        'SKILL.md should reaffirm no new status outside the valid enum'
      );

      // Must list the valid enum values
      assert(
        lowerContent.includes('todo') &&
        lowerContent.includes('defining') &&
        lowerContent.includes('in-progress') &&
        lowerContent.includes('testing') &&
        lowerContent.includes('post-processing') &&
        lowerContent.includes('done') &&
        lowerContent.includes('failed-testing'),
        'SKILL.md should list all valid enum values'
      );

      // Must reaffirm whole-file atomic writes
      assert(
        lowerContent.includes('whole-file') && lowerContent.includes('atomic') ||
        lowerContent.includes('whole-file, atomic write'),
        'SKILL.md should reaffirm whole-file atomic writes on the skip path'
      );
    },
  );
});

test('E2E cucumber: only review is meaningfully skippable', async (t) => {
  await t.test(
    'Given the phase-skip feature, ' +
      'When we read which phases can skip, ' +
      'Then it states review is the ONLY meaningfully skippable phase; build/test are out of scope',
    () => {
      const md = readLower(SKILL_PATH);

      // Must state review is the only meaningfully skippable phase
      assert(
        md.includes('review') &&
        md.includes('only phase this feature makes meaningfully skippable'),
        'SKILL.md should state review is the only meaningfully skippable phase'
      );

      // Must state build/test disabling is out of scope
      assert(
        md.includes('out of scope for this behaviour'),
        'SKILL.md should state build/test disabling is out of scope'
      );

      // Must state build/test still run even if config sets enabled:false
      assert(
        md.includes('still runs the build') ||
        md.includes('orchestrator still runs the build') ||
        md.includes('still run exactly as described'),
        'SKILL.md should state build/test still run even if configured disabled'
      );
    },
  );
});

test('E2E cucumber: both SKILL.md copies are byte-identical (drift guard)', async (t) => {
  await t.test(
    'Given .claude/skills/orchestrate/SKILL.md and assets/skills/orchestrate/SKILL.md, ' +
      'When we compare their raw bytes, ' +
      'Then they are byte-for-byte identical',
    () => {
      const bytes1 = readBytes(SKILL_PATH);
      const bytes2 = readBytes(ASSETS_SKILL_PATH);
      assert.deepStrictEqual(
        bytes1,
        bytes2,
        'The two SKILL.md copies must be byte-identical'
      );
    },
  );
});

test('E2E cucumber: other phase prose is untouched (spot check)', async (t) => {
  await t.test(
    'Given the phase-skip changes to Phase 4, ' +
      'When we check other phases, ' +
      'Then Phase 1, 2, 3 prose still contains their expected key concepts',
    () => {
      const md = readLower(SKILL_PATH);

      // Phase 1 should still mention business analyst, define, breaking into tickets
      assert(
        md.includes('phase 1') && md.includes('business analyst'),
        'Phase 1 should still mention the business analyst role'
      );

      // Phase 2 should still mention coder, build, swarm, batches
      assert(
        md.includes('phase 2') && md.includes('coder'),
        'Phase 2 should still mention the coder role'
      );
      assert(
        md.includes('swarm') && md.includes('batch'),
        'Phase 2 should still document swarm and batch behavior'
      );

      // Phase 3 should still mention tester, tests, e2e, unit
      assert(
        md.includes('phase 3') && md.includes('tester'),
        'Phase 3 should still mention the tester role'
      );
      assert(
        md.includes('e2e') && md.includes('unit'),
        'Phase 3 should still mention e2e and unit test requirement'
      );

      // Model routing should still mention cost tiers
      assert(
        md.includes('model routing') && (md.includes('cost') || md.includes('default model')),
        'Model routing should still be documented'
      );

      // Concurrency should still mention bounded, claims, isolation
      assert(
        md.includes('concurrency') &&
        (md.includes('bounded') || md.includes('bound')) &&
        md.includes('claim'),
        'Concurrency section should still document bounds and claims'
      );
    },
  );
});

test('E2E cucumber: Phase 3 "All green" hand-off is conditioned on review.enabled', async (t) => {
  await t.test(
    'Given the Phase 3 "All green" hand-off decision point, ' +
      'When we read the prose, ' +
      'Then it states that the review dispatch is conditioned on skill.phases.review.enabled, ' +
      'not an unconditional "always run review" instruction',
    () => {
      const md = readRaw(SKILL_PATH);
      const phase3Start = md.indexOf('## Phase 3');
      const phase4Start = md.indexOf('## Phase 4');
      const phase3Content = md.substring(phase3Start, phase4Start);
      const lowerPhase3 = phase3Content.toLowerCase();

      // Must contain "All green" decision point
      assert(
        lowerPhase3.includes('all green'),
        'Phase 3 should document the "All green" hand-off decision point'
      );

      // Must condition review dispatch on the enabled flag
      assert(
        lowerPhase3.includes('skill.phases.review.enabled'),
        'Phase 3 "All green" must reference skill.phases.review.enabled to condition review dispatch'
      );

      // Must state that review is skipped when the flag is false
      assert(
        lowerPhase3.includes('false') || lowerPhase3.includes('disabled'),
        'Phase 3 "All green" must state review can be disabled (false)'
      );

      // Must use conditional language, not unconditional "always"
      assert(
        (lowerPhase3.includes('unless') || lowerPhase3.includes('when') ||
         lowerPhase3.includes('if') || lowerPhase3.includes('conditioned')) &&
        !lowerPhase3.substring(
          lowerPhase3.indexOf('all green'),
          lowerPhase3.indexOf('all green') + 400
        ).includes('unconditional'),
        'Phase 3 "All green" should use conditional language, not "always" or "unconditional"'
      );

      // Must reference Phase 4 or the skip rule
      assert(
        lowerPhase3.includes('phase 4') ||
        lowerPhase3.includes('skip the review when the phase is disabled'),
        'Phase 3 "All green" should reference Phase 4 or explicitly cite the skip rule'
      );

      // Must document the collapsed flow (testing → post-processing → done) when review is disabled
      assert(
        lowerPhase3.includes('testing → post-processing → done') ||
        (lowerPhase3.includes('testing') && lowerPhase3.includes('post-processing') &&
         lowerPhase3.includes('done') && lowerPhase3.includes('collapsed')),
        'Phase 3 "All green" must document the collapsed flow when review is skipped'
      );
    },
  );
});
