'use strict';

// Docs-integrity tests for TASK-014: "the orchestrate test phase must mandate
// BOTH e2e cucumber-style tests AND unit tests before a ticket can reach done".
//
// This is an INSTRUCTION/DOCUMENTATION ticket: the coder edited two instruction
// files rather than product code, so the testable contract is that those files
// now contain the required statements. There is no runtime behaviour to
// exercise; the only I/O is reading files from disk.
//
//   Edited files under test:
//     .claude/skills/orchestrate/SKILL.md   (Phase 3)
//     .claude/agents/tester.md
//
// NO NETWORK, NO DATABASE. Reading these markdown files from disk is the whole
// point of the contract.
//
// This file itself intentionally satisfies the ticket's own rule by containing
// BOTH kinds of tests:
//   * UNIT TESTS   -> the `test('UNIT: ...')` cases below: small, focused
//                     substring/regex assertions that each required phrase or
//                     rule is present in a given file's text.
//   * E2E CUCUMBER SCENARIOS -> the `test('E2E cucumber: ...')` suites below:
//                     Given/When/Then structured cases that read the files and
//                     mirror the ticket's Gherkin acceptance scenarios.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const SKILL_PATH = path.join(
  REPO_ROOT,
  '.claude',
  'skills',
  'orchestrate',
  'SKILL.md',
);
const TESTER_PATH = path.join(REPO_ROOT, '.claude', 'agents', 'tester.md');
const PACKAGE_PATH = path.join(REPO_ROOT, 'package.json');

// Read once, lowercased, so assertions are robust to punctuation/casing.
const readLower = (p) => fs.readFileSync(p, 'utf8').toLowerCase();

// ---------------------------------------------------------------------------
// UNIT TESTS
// Each case is a minimal assertion that one required concept is present in the
// relevant instruction file. Matching is on stable lowercased substrings /
// regexes so trivial wording differences don't cause false failures, while a
// genuinely absent concept still fails.
// ---------------------------------------------------------------------------

test('UNIT: SKILL.md exists and is non-empty', () => {
  assert.ok(fs.existsSync(SKILL_PATH), `expected ${SKILL_PATH} to exist`);
  assert.ok(readLower(SKILL_PATH).length > 0, 'SKILL.md is empty');
});

test('UNIT: tester.md exists and is non-empty', () => {
  assert.ok(fs.existsSync(TESTER_PATH), `expected ${TESTER_PATH} to exist`);
  assert.ok(readLower(TESTER_PATH).length > 0, 'tester.md is empty');
});

// TASK-204: SKILL.md's `testing` column bullet now states the requirement in
// one short sentence, deferring the detailed e2e/unit/DB-mock/no-cucumber
// contract to .claude/agents/tester.md exclusively (see the tester.md-focused
// tests below, all still passing) — consistent with the ticket's own design
// (agent files carry role detail; SKILL.md carries the generic column loop).
test('UNIT: SKILL.md mentions both e2e and unit tests for the testing column', () => {
  const md = readLower(SKILL_PATH);
  assert.match(md, /both/, 'SKILL.md should say BOTH kinds are required');
  assert.match(md, /both e2e and unit tests/, 'SKILL.md should mention both e2e and unit tests');
});

test('UNIT: SKILL.md ties both test kinds to the done/pass gate', () => {
  const md = readLower(SKILL_PATH);
  // A ticket only reaches "done" when both exist and pass.
  assert.match(md, /done/, 'SKILL.md should reference the done gate');
  assert.match(
    md,
    /both[\s\S]{0,120}(exist|pass|green)/,
    'SKILL.md should tie BOTH kinds to existing/passing before done',
  );
});

// TASK-204: node --test/Given-When-Then/no-cucumber-package/DB-mock/every-
// criterion-plus-failure-path detail now lives exclusively in tester.md (see
// the tester.md-focused tests below) — SKILL.md just names the two
// deliverables and defers to the tester agent for the rest.
test('UNIT: SKILL.md defers the e2e/unit test-writing detail to the tester agent', () => {
  const md = readLower(SKILL_PATH);
  assert.match(md, /the tester\s+writes\/extends both e2e and unit tests and runs the suite/,
    'SKILL.md should state the tester writes/extends both kinds and runs the suite');
});

test('UNIT: SKILL.md ties a red result to the backward fix-loop, never silently green', () => {
  const md = readLower(SKILL_PATH);
  assert.match(md, /a\s*\*{0,2}red\*{0,2}\s+result.{0,80}fix loop is backward movement/i,
    'SKILL.md should route a red result to the backward fix loop');
  assert.match(md, /a red result\s+is never silently treated as green/i,
    'SKILL.md should guarantee a red result is never silently treated as green');
});

test('UNIT: tester.md still states no cucumber npm package is required/added', () => {
  const md = readLower(TESTER_PATH);
  assert.match(md, /cucumber/, 'tester.md should mention cucumber');
  assert.match(
    md,
    /cucumber[\s\S]{0,80}(npm|package)[\s\S]{0,80}(not|none|no)|(not|none|no)[\s\S]{0,80}cucumber[\s\S]{0,40}(npm|package)/,
    'tester.md should state no cucumber npm package is required/added',
  );
});

test('UNIT: tester.md requires e2e to cover every acceptance criterion + a failure/edge path', () => {
  const md = readLower(TESTER_PATH);
  assert.match(md, /every/, 'tester.md should require covering EVERY criterion');
  assert.match(
    md,
    /acceptance criteri|gherkin scenario/,
    'tester.md should require covering acceptance criteria / Gherkin scenarios',
  );
  assert.match(
    md,
    /failure\/edge|failure or edge|edge path|failure path/,
    'tester.md should require at least one failure/edge path',
  );
});

test('UNIT: SKILL.md\'s ticket-file contract still describes the failed-testing fix loop', () => {
  const md = readLower(SKILL_PATH);
  assert.match(md, /failed-testing/, 'SKILL.md should reference failed-testing');
  assert.match(
    md,
    /failed-testing[\s\S]{0,200}the fix loop runs before returning it to `?testing`?/,
    'SKILL.md should describe the failed-testing fix loop returning to testing',
  );
});

test('UNIT: tester.md lists both kinds as mandatory deliverables', () => {
  const md = readLower(TESTER_PATH);
  assert.match(md, /both/, 'tester.md should say BOTH kinds required');
  assert.match(md, /mandatory deliverable/, 'tester.md should call them mandatory deliverables');
  assert.match(md, /e2e cucumber/, 'tester.md should mention e2e cucumber tests');
  assert.match(md, /unit test/, 'tester.md should mention unit tests');
});

test('UNIT: tester.md requires reporting which files hold e2e vs unit tests', () => {
  const md = readLower(TESTER_PATH);
  assert.match(
    md,
    /which files[\s\S]{0,60}e2e|e2e[\s\S]{0,40}files/,
    'tester.md should require naming which files hold the e2e tests',
  );
  assert.match(
    md,
    /which files[\s\S]{0,60}unit|unit[\s\S]{0,40}files/,
    'tester.md should require naming which files hold the unit tests',
  );
});

test('UNIT: tester.md preserves the DB-mock rule', () => {
  const md = readLower(TESTER_PATH);
  assert.match(md, /mock all database/i, 'tester.md should keep the "Mock ALL database calls" rule');
  assert.match(md, /no real db/, 'tester.md should keep "no real DB connections"');
});

test('UNIT: tester.md "all green" requires both kinds run+passed, else failed-testing', () => {
  const md = readLower(TESTER_PATH);
  assert.match(md, /all green/, 'tester.md should define "all green"');
  assert.match(
    md,
    /all green[\s\S]{0,160}both/,
    'tester.md "all green" should require BOTH kinds',
  );
  assert.match(md, /failed-testing/, 'tester.md should route a shortfall to failed-testing');
});

test('UNIT: package.json has NO cucumber dependency', () => {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'));
  const allDeps = {
    ...(pkg.dependencies || {}),
    ...(pkg.devDependencies || {}),
    ...(pkg.optionalDependencies || {}),
    ...(pkg.peerDependencies || {}),
  };
  const cucumberDeps = Object.keys(allDeps).filter((name) =>
    name.toLowerCase().includes('cucumber'),
  );
  assert.deepEqual(
    cucumberDeps,
    [],
    `package.json must not add a cucumber dependency, found: ${cucumberDeps.join(', ')}`,
  );
});

// ---------------------------------------------------------------------------
// E2E CUCUMBER-STYLE SCENARIOS
// Given/When/Then structured cases that read the edited files and mirror the
// ticket's Gherkin acceptance scenarios end-to-end.
// ---------------------------------------------------------------------------

// TASK-204: there is no more "Phase 3 — Test" heading; the `testing` column
// bullet (Forward movement model) is the equivalent anchor, and it defers
// node --test/Given-When-Then/no-cucumber-package/every-criterion-plus-
// failure-path detail to tester.md exclusively (checked by the tester.md
// tests elsewhere in this file — all still passing).
test('E2E cucumber: the testing column mandates BOTH e2e and unit tests, gated on a green/red result', async (t) => {
  await t.test(
    'Given the orchestrate SKILL.md `testing` column bullet, ' +
      'When we read the test-column rules, ' +
      'Then it mandates both e2e AND unit tests, and a red result is never silently treated as green',
    () => {
      const md = readLower(SKILL_PATH);
      // Given: there is a `testing` column bullet (Forward movement model).
      assert.match(md, /`testing`.*orchestrate-tester/is, 'expected a `testing` column bullet naming orchestrate-tester');
      // Then: both kinds are named.
      assert.match(md, /both e2e and unit tests/);
      // And: gated on a green/red result, never silently treated as green.
      assert.match(md, /a\s*\*{0,2}green\*{0,2}\s+result advances forward/i);
      assert.match(md, /a red result\s+is never silently treated as green/i);
    },
  );
});

test('E2E cucumber: tester.md says e2e scenarios are node --test Given/When/Then, no cucumber dep', async (t) => {
  await t.test(
    'Given a ticket dispatched to the tester agent, ' +
      'When the tester writes e2e cucumber tests, ' +
      'Then tester.md says they are node --test Given/When/Then cases needing no cucumber package',
    () => {
      const md = readLower(TESTER_PATH);
      assert.match(md, /node --test/);
      assert.match(md, /given\/when\/then|given.*when.*then/i);
      assert.match(md, /cucumber/);
      assert.match(
        md,
        /(not|none|no)[\s\S]{0,120}cucumber[\s\S]{0,40}(npm|package)|cucumber[\s\S]{0,80}(npm|package)[\s\S]{0,80}(not|none|no)/,
        'no cucumber npm package should be required/added',
      );
    },
  );

  await t.test(
    'Given the project dependency manifest, ' +
      'When we inspect package.json, ' +
      'Then no cucumber package is present',
    () => {
      const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'));
      const names = Object.keys({
        ...(pkg.dependencies || {}),
        ...(pkg.devDependencies || {}),
      });
      assert.ok(
        !names.some((n) => n.toLowerCase().includes('cucumber')),
        'package.json should not contain a cucumber dependency',
      );
    },
  );
});

test('E2E cucumber: tester.md must cover every criterion plus a failure/edge path', async (t) => {
  await t.test(
    'Given the acceptance criteria of a ticket, ' +
      'When the tester writes e2e scenarios, ' +
      'Then tester.md requires covering every criterion and at least one failure/edge path',
    () => {
      const md = readLower(TESTER_PATH);
      assert.match(md, /every/);
      assert.match(md, /acceptance criteri|gherkin scenario/);
      assert.match(md, /failure\/edge|failure or edge|edge path|failure path/);
    },
  );
});

test('E2E cucumber: tester agent lists both kinds and reports e2e-vs-unit files', async (t) => {
  await t.test(
    'Given the orchestrate-tester agent definition, ' +
      'When we read its mandatory deliverables, ' +
      'Then both test kinds are required and it must report which files hold e2e vs unit tests',
    () => {
      const md = readLower(TESTER_PATH);
      assert.match(md, /both/);
      assert.match(md, /mandatory deliverable/);
      assert.match(md, /e2e cucumber/);
      assert.match(md, /unit test/);
      assert.match(md, /which files[\s\S]{0,60}e2e|e2e[\s\S]{0,40}files/);
      assert.match(md, /which files[\s\S]{0,60}unit|unit[\s\S]{0,40}files/);
    },
  );
});

// TASK-204: SKILL.md's DB-mock rule and "all green"/missing-either-kind
// failure routing now live exclusively in tester.md (the agent that actually
// enforces them); SKILL.md's own generic contribution is just the ticket-file
// contract's failed-testing/fix-loop description (checked above).
test('E2E cucumber: tester.md preserves the DB-mock rule', async (t) => {
  await t.test(
    'Given the tester agent definition, ' +
      'When we read its DB guidance, ' +
      'Then it still mandates mocking ALL database calls with no real DB connections',
    () => {
      const md = readLower(TESTER_PATH);
      assert.match(md, /mock all database/i, 'tester.md lost the DB-mock rule');
      assert.match(md, /no real db/, 'tester.md lost "no real DB connections"');
    },
  );
});

test('E2E cucumber: edge — missing either kind returns the ticket to failed-testing', async (t) => {
  await t.test(
    'Given a ticket where only one kind of test was produced, ' +
      'When the tester evaluates "all green", ' +
      'Then tester.md requires returning it to failed-testing, ' +
      'and SKILL.md still describes the failed-testing fix loop',
    () => {
      const skill = readLower(SKILL_PATH);
      const tester = readLower(TESTER_PATH);

      // SKILL.md: still describes the failed-testing fix loop generically.
      assert.match(skill, /failed-testing/);
      assert.match(
        skill,
        /failed-testing[\s\S]{0,200}the fix loop runs before returning it to `?testing`?/,
        'SKILL.md should describe the failed-testing fix loop',
      );

      // tester.md: all green requires both, else failed-testing.
      assert.match(tester, /all green[\s\S]{0,200}both/);
      assert.match(tester, /failed-testing/);
    },
  );
});
