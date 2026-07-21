'use strict';

// ===========================================================================
// TASK-096 — E2E cucumber-style tests for the orchestrate workflow read-model.
//
// These are scenario-style `node --test` cases written in Given/When/Then form
// (NO `cucumber` npm package — none is installed or added). They implement
// EVERY Gherkin scenario from the ticket:
//
//   Feature: Workflow model
//     Scenario: Parsing the bundled skill
//     Scenario: Model directive captured
//     Scenario: Missing phase heading (edge)
//     Scenario: Junk input (failure)
//
// The "Parsing the bundled skill" and "Model directive captured" scenarios run
// against the REAL bundled `.claude/skills/orchestrate/SKILL.md`. The missing-
// phase edge runs against a modified-SKILL fixture string. The junk/failure
// scenario feeds null and binary garbage.
//
// NO DATABASE, NO NETWORK, NO IPC, NO REAL DB CONNECTIONS. The only I/O is a
// read-only load of the bundled SKILL.md source. (Were any DB access involved
// it would be mocked; this read-model touches none.)
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseWorkflow } = require('../lib/skill-workflow');

const ROOT = path.join(__dirname, '..');
const PROJECT_SKILL = path.join(ROOT, '.claude', 'skills', 'orchestrate', 'SKILL.md');

const FABLE = 'claude-fable-5';
const OPUS = 'claude-opus-4-8';

// --- tiny Given/When/Then harness (labels for readable scenario output) ----
function Given(_desc, fn) { return fn ? fn() : undefined; }
function When(_desc, fn) { return fn ? fn() : undefined; }
function Then(_desc, fn) { return fn ? fn() : undefined; }

function readBundledSkill() {
  // Given: the bundled orchestrate skill on disk (read-only).
  return fs.readFileSync(PROJECT_SKILL, 'utf8');
}

// ===========================================================================
// Feature: Workflow model
// ===========================================================================

test('Scenario: Parsing the bundled skill', () => {
  const skillMd = Given('the bundled orchestrate SKILL.md', readBundledSkill);

  const result = When('parseWorkflow parses it', () => parseWorkflow(skillMd));

  Then('four phases return in order plan, build, test, review', () => {
    assert.deepEqual(result.phases.map((p) => p.key), ['plan', 'build', 'test', 'review']);
    assert.equal(result.phases.length, 4);
    assert.deepEqual(result.warnings, []);
  });

  Then('each phase names its orchestrate-* agent', () => {
    const byKey = Object.fromEntries(result.phases.map((p) => [p.key, p.agent]));
    assert.equal(byKey.plan, 'orchestrate-ba');
    assert.equal(byKey.build, 'orchestrate-coder');
    assert.equal(byKey.test, 'orchestrate-tester');
    assert.equal(byKey.review, 'orchestrate-tech-lead');
  });

  Then('each phase points at its real `## Phase <n>` heading line', () => {
    const lines = skillMd.split(/\r?\n/);
    for (const p of result.phases) {
      assert.ok(Number.isInteger(p.headingLine) && p.headingLine >= 1);
      assert.match(lines[p.headingLine - 1], /^##\s+Phase\s+\d/);
    }
  });
});

test('Scenario: Model directive captured', () => {
  const skillMd = Given('the bundled orchestrate SKILL.md', readBundledSkill);

  const result = When('parseWorkflow parses it', () => parseWorkflow(skillMd));

  Then('the plan phase records claude-fable-5 with fallback claude-opus-4-8', () => {
    const plan = result.phases.find((p) => p.key === 'plan');
    assert.ok(plan, 'plan phase present');
    assert.deepEqual(plan.model, { primary: FABLE, fallback: OPUS });
  });

  Then('no other phase carries a model directive', () => {
    for (const p of result.phases.filter((x) => x.key !== 'plan')) {
      assert.equal(p.model, undefined, `${p.key} phase has no model`);
    }
  });
});

test('Scenario: Missing phase heading (edge)', () => {
  const original = Given('the bundled orchestrate SKILL.md', readBundledSkill);
  const skillMd = Given('SKILL.md without the Phase 3 heading', () => {
    const modified = original.replace(
      '## Phase 3 — Test (tester) and the fix loop',
      '## Test (tester) and the fix loop',
    );
    // Guard against a silent no-op if the heading wording drifts.
    assert.notEqual(modified, original, 'fixture .replace must actually remove the Phase 3 heading');
    return modified;
  });

  const result = When('parseWorkflow parses the modified skill', () => parseWorkflow(skillMd));

  Then('the remaining phases return', () => {
    assert.deepEqual(result.phases.map((p) => p.key), ['plan', 'build', 'review']);
  });

  Then('a warning names phase 3', () => {
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /Phase 3/);
    assert.match(result.warnings[0], /test/i);
  });

  Then('the real SKILL.md is untouched (still four phases)', () => {
    assert.equal(parseWorkflow(readBundledSkill()).phases.length, 4);
  });
});

test('Scenario: Junk input (failure)', () => {
  Given('no valid SKILL.md content');

  Then('parseWorkflow(null) returns empty phases without throwing', () => {
    let result;
    When('parseWorkflow gets null', () => {
      assert.doesNotThrow(() => { result = parseWorkflow(null); });
    });
    assert.deepEqual(result.phases, []);
    assert.ok(result.warnings.length >= 1);
    assert.match(result.warnings[0], /not a string/i);
  });

  Then('parseWorkflow(binary garbage) returns empty phases without throwing', () => {
    const garbage = Buffer.from([0, 255, 10, 66, 0, 200, 13, 10, 1]).toString('binary');
    let result;
    When('parseWorkflow gets binary garbage', () => {
      assert.doesNotThrow(() => { result = parseWorkflow(garbage); });
    });
    assert.deepEqual(result.phases, []);
    assert.ok(result.warnings.length >= 1);
  });

  Then('an empty string yields four missing-phase warnings without throwing', () => {
    let result;
    When('parseWorkflow gets an empty string', () => {
      assert.doesNotThrow(() => { result = parseWorkflow(''); });
    });
    assert.deepEqual(result.phases, []);
    assert.equal(result.warnings.length, 4);
  });
});

// --- Additional edge scenarios named in the ticket (CRLF, reordering) ------

test('Scenario: CRLF SKILL.md parses identically to LF', () => {
  const lf = Given('the bundled SKILL.md with LF endings', readBundledSkill);
  const crlf = Given('the same content with CRLF endings', () => lf.replace(/\n/g, '\r\n'));

  const lfResult = When('parseWorkflow parses the LF copy', () => parseWorkflow(lf));
  const crlfResult = When('parseWorkflow parses the CRLF copy', () => parseWorkflow(crlf));

  Then('phase keys, agents and heading lines match', () => {
    const shape = (r) => r.phases.map((p) => ({ key: p.key, agent: p.agent, headingLine: p.headingLine }));
    assert.deepEqual(shape(crlfResult), shape(lfResult));
    assert.deepEqual(crlfResult.warnings, lfResult.warnings);
  });
});

test('Scenario: reordered phase headings still return canonical order', () => {
  const skillMd = Given('a SKILL.md whose phase headings appear out of order', () => [
    '## Phase 3 — Test',
    'orchestrate-tester',
    '## Phase 1 — Plan / Define',
    'orchestrate-ba on `claude-fable-5` otherwise `claude-opus-4-8`',
    '## Phase 4 — Review',
    'orchestrate-tech-lead',
    '## Phase 2 — Build (coder)',
    'orchestrate-coder',
  ].join('\n'));

  const result = When('parseWorkflow parses it', () => parseWorkflow(skillMd));

  Then('phases still return plan, build, test, review in canonical order', () => {
    assert.deepEqual(result.phases.map((p) => p.key), ['plan', 'build', 'test', 'review']);
    assert.deepEqual(result.warnings, []);
  });

  Then('the plan phase still captures the model directive from its own body', () => {
    const plan = result.phases.find((p) => p.key === 'plan');
    assert.deepEqual(plan.model, { primary: FABLE, fallback: OPUS });
  });
});
