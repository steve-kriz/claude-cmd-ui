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

test('UNIT: SKILL.md mentions both e2e cucumber tests and unit tests', () => {
  const md = readLower(SKILL_PATH);
  assert.match(md, /both/, 'SKILL.md should say BOTH kinds are required');
  assert.match(md, /e2e cucumber/, 'SKILL.md should mention e2e cucumber tests');
  assert.match(md, /unit test/, 'SKILL.md should mention unit tests');
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

test('UNIT: SKILL.md clarifies e2e are node --test Given/When/Then scenarios', () => {
  const md = readLower(SKILL_PATH);
  assert.match(md, /node --test/, 'SKILL.md should reference the node --test runner');
  assert.match(
    md,
    /given\/when\/then|given.*when.*then/i,
    'SKILL.md should describe Given/When/Then scenario style',
  );
});

test('UNIT: SKILL.md states no cucumber npm package is required/added', () => {
  const md = readLower(SKILL_PATH);
  assert.match(md, /cucumber/, 'SKILL.md should mention cucumber');
  assert.match(
    md,
    /cucumber[\s\S]{0,80}(npm|package)[\s\S]{0,80}(not|none|no)|(not|none|no)[\s\S]{0,80}cucumber[\s\S]{0,40}(npm|package)/,
    'SKILL.md should state no cucumber npm package is required/added',
  );
});

test('UNIT: SKILL.md requires e2e to cover every acceptance criterion + a failure/edge path', () => {
  const md = readLower(SKILL_PATH);
  assert.match(md, /every/, 'SKILL.md should require covering EVERY criterion');
  assert.match(
    md,
    /acceptance criteri|gherkin scenario/,
    'SKILL.md should require covering acceptance criteria / Gherkin scenarios',
  );
  assert.match(
    md,
    /failure\/edge|failure or edge|edge path|failure path/,
    'SKILL.md should require at least one failure/edge path',
  );
});

test('UNIT: SKILL.md preserves the DB-mock rule', () => {
  const md = readLower(SKILL_PATH);
  assert.match(md, /mock all database/i, 'SKILL.md should keep the "Mock ALL database calls" rule');
  assert.match(md, /no real db/, 'SKILL.md should keep "no real DB connections"');
});

test('UNIT: SKILL.md sends a missing-either-kind ticket back to failed-testing', () => {
  const md = readLower(SKILL_PATH);
  assert.match(md, /failed-testing/, 'SKILL.md should reference failed-testing');
  assert.match(
    md,
    /(missing|either)[\s\S]{0,160}failed-testing|failed-testing[\s\S]{0,160}(missing|either)/,
    'SKILL.md should return a ticket missing either kind to failed-testing',
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

test('E2E cucumber: Phase 3 mandates BOTH e2e and unit tests before done', async (t) => {
  await t.test(
    'Given the orchestrate SKILL.md Phase 3, ' +
      'When we read the test-phase rules, ' +
      'Then it mandates both e2e cucumber-style AND unit tests, gated on done/pass',
    () => {
      const md = readLower(SKILL_PATH);
      // Given: there is a Phase 3 (Test) section.
      assert.match(md, /phase 3\b.*test/, 'expected a "Phase 3 — Test" section');
      // Then: both kinds are named.
      assert.match(md, /both/);
      assert.match(md, /e2e cucumber/);
      assert.match(md, /unit test/);
      // And: gated on done + passing.
      assert.match(md, /done/);
      assert.match(
        md,
        /both[\s\S]{0,160}(pass|green|exist)/,
        'both kinds must be tied to passing/existing before done',
      );
    },
  );
});

test('E2E cucumber: e2e scenarios are node --test Given/When/Then, no cucumber dep', async (t) => {
  await t.test(
    'Given a ticket in the testing phase, ' +
      'When the tester writes e2e cucumber tests, ' +
      'Then SKILL.md says they are node --test Given/When/Then cases needing no cucumber package',
    () => {
      const md = readLower(SKILL_PATH);
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

test('E2E cucumber: e2e scenarios must cover every criterion plus a failure/edge path', async (t) => {
  await t.test(
    'Given the acceptance criteria of a ticket, ' +
      'When the tester writes e2e scenarios, ' +
      'Then SKILL.md requires covering every criterion and at least one failure/edge path',
    () => {
      const md = readLower(SKILL_PATH);
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

test('E2E cucumber: both files preserve the DB-mock rule', async (t) => {
  await t.test(
    'Given both edited instruction files, ' +
      'When we read their DB guidance, ' +
      'Then each still mandates mocking ALL database calls with no real DB connections',
    () => {
      for (const [label, p] of [
        ['SKILL.md', SKILL_PATH],
        ['tester.md', TESTER_PATH],
      ]) {
        const md = readLower(p);
        assert.match(md, /mock all database/i, `${label} lost the DB-mock rule`);
        assert.match(md, /no real db/, `${label} lost "no real DB connections"`);
      }
    },
  );
});

test('E2E cucumber: edge — missing either kind returns the ticket to failed-testing', async (t) => {
  await t.test(
    'Given a ticket where only one kind of test was produced, ' +
      'When the tester evaluates "all green", ' +
      'Then both instruction files require returning it to failed-testing',
    () => {
      const skill = readLower(SKILL_PATH);
      const tester = readLower(TESTER_PATH);

      // SKILL.md: missing either kind -> failed-testing / treated as failure.
      assert.match(skill, /failed-testing/);
      assert.match(
        skill,
        /(missing|either)[\s\S]{0,200}(failure|failed-testing)/,
        'SKILL.md should treat a missing kind as a failure -> failed-testing',
      );

      // tester.md: all green requires both, else failed-testing.
      assert.match(tester, /all green[\s\S]{0,200}both/);
      assert.match(tester, /failed-testing/);
    },
  );
});
