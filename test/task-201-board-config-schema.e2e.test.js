'use strict';

// ===========================================================================
// TASK-201 — e2e cucumber-style (Given/When/Then) scenarios
//
// Feature: team-config schema with per-column instructions and no phase system
//
// These are scenario-style `node --test` cases (no `cucumber` npm package is
// installed or used) that implement EVERY Gherkin scenario in the ticket. The
// module under test is a PURE lib: it never touches disk/DB/network/Electron,
// so there is nothing to mock beyond simply never doing real FS/DB I/O (this
// file does none). Every scenario drives the real exports via require().
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const teamConfig = require('../lib/team-config.js');
const { AGENT_TYPES } = require('../lib/orchestrate-agents.js');

const {
  defaultConfig,
  normalizeConfig,
  serializeConfig,
  SYSTEM_COLUMN_DEFAULT_AGENTS,
  SYSTEM_COLUMN_DEFAULT_INSTRUCTIONS,
  SYSTEM_SLUGS,
} = teamConfig;

// ---------------------------------------------------------------------------
// Scenario: instructions round-trips on a system column
//   Given a raw config whose "testing" column has instructions "Run node --test"
//   When normalizeConfig runs
//   Then the "testing" column has instructions "Run node --test"
//   And the column key order is status,label,description,agent,instructions,system
// ---------------------------------------------------------------------------
test('Scenario: instructions round-trips on a system column', () => {
  // Given a raw config whose "testing" column has instructions "Run node --test"
  const raw = {
    version: 1,
    columns: [
      { status: 'todo', label: 'To Do', system: true },
      { status: 'defining', label: 'Defining', system: true },
      { status: 'in-progress', label: 'In Progress', system: true },
      { status: 'testing', label: 'Testing', instructions: 'Run node --test', system: true },
      { status: 'post-processing', label: 'Post-processing', system: true },
      { status: 'done', label: 'Done', system: true },
    ],
    skill: { concurrencyDefault: 3 },
  };

  // When normalizeConfig runs
  const cfg = normalizeConfig(raw);

  // Then the "testing" column has instructions "Run node --test"
  const testing = cfg.columns.find((c) => c.status === 'testing');
  assert.equal(testing.instructions, 'Run node --test', 'instructions round-trip');

  // And the column key order is status,label,description,agent,instructions,system
  const keys = Object.keys(testing);
  const expectedKeys = ['status', 'label', 'description', 'agent', 'instructions', 'system'];
  const actualOrder = keys.slice(0, expectedKeys.length);
  assert.deepEqual(actualOrder, expectedKeys, 'column key order is correct');
});

// ---------------------------------------------------------------------------
// Scenario: non-string instructions collapse to empty
//   Given a raw config whose "todo" column has instructions set to the number 5
//   When normalizeConfig runs
//   Then the "todo" column has instructions ""
// ---------------------------------------------------------------------------
test('Scenario: non-string instructions collapse to empty', () => {
  // Given a raw config whose "todo" column has instructions set to the number 5
  const raw = {
    version: 1,
    columns: [
      { status: 'todo', label: 'To Do', instructions: 5, system: true },
      { status: 'defining', label: 'Defining', system: true },
      { status: 'in-progress', label: 'In Progress', system: true },
      { status: 'testing', label: 'Testing', system: true },
      { status: 'post-processing', label: 'Post-processing', system: true },
      { status: 'done', label: 'Done', system: true },
    ],
    skill: { concurrencyDefault: 3 },
  };

  // When normalizeConfig runs
  const cfg = normalizeConfig(raw);

  // Then the "todo" column has instructions ""
  const todo = cfg.columns.find((c) => c.status === 'todo');
  assert.equal(todo.instructions, '', 'non-string instructions collapse to empty string');
});

// ---------------------------------------------------------------------------
// Scenario: a legacy column phase link is dropped with a warning
//   Given a raw config whose "defining" column has phase "plan"
//   When normalizeConfig runs
//   Then the "defining" column has no phase key
//   And warnings include a message naming the "defining" column's dropped phase
// ---------------------------------------------------------------------------
test('Scenario: a legacy column phase link is dropped with a warning', () => {
  // Given a raw config whose "defining" column has phase "plan"
  const raw = {
    version: 1,
    columns: [
      { status: 'todo', label: 'To Do', system: true },
      { status: 'defining', label: 'Defining', phase: 'plan', system: true },
      { status: 'in-progress', label: 'In Progress', system: true },
      { status: 'testing', label: 'Testing', system: true },
      { status: 'post-processing', label: 'Post-processing', system: true },
      { status: 'done', label: 'Done', system: true },
    ],
    skill: { concurrencyDefault: 3 },
  };

  // When normalizeConfig runs
  const cfg = normalizeConfig(raw);

  // Then the "defining" column has no phase key
  const defining = cfg.columns.find((c) => c.status === 'defining');
  assert.ok(!('phase' in defining), 'phase key is dropped');

  // And warnings include a message naming the "defining" column's dropped phase
  assert.ok(
    cfg.warnings.some((w) => /defining/.test(w) && /phase/.test(w)),
    'warning mentions defining and phase'
  );
});

// ---------------------------------------------------------------------------
// Scenario: skill.phases is removed entirely
//   Given a raw config whose skill has a phases object
//   When normalizeConfig runs
//   Then the normalized skill has no phases key
//   And warnings include a message that skill.phases was dropped
//   And the normalized skill still has concurrencyDefault and contextOptimization
// ---------------------------------------------------------------------------
test('Scenario: skill.phases is removed entirely', () => {
  // Given a raw config whose skill has a phases object
  const raw = {
    version: 1,
    columns: [
      { status: 'todo', label: 'To Do', system: true },
      { status: 'defining', label: 'Defining', system: true },
      { status: 'in-progress', label: 'In Progress', system: true },
      { status: 'testing', label: 'Testing', system: true },
      { status: 'post-processing', label: 'Post-processing', system: true },
      { status: 'done', label: 'Done', system: true },
    ],
    skill: {
      concurrencyDefault: 3,
      phases: { plan: { label: 'Plan' } },
      contextOptimization: { enabled: true, level: 'standard' },
    },
  };

  // When normalizeConfig runs
  const cfg = normalizeConfig(raw);

  // Then the normalized skill has no phases key
  assert.ok(!('phases' in cfg.skill), 'skill.phases is removed');

  // And warnings include a message that skill.phases was dropped
  assert.ok(
    cfg.warnings.some((w) => /skill\.phases/.test(w) && /dropped/.test(w)),
    'warning mentions skill.phases was dropped'
  );

  // And the normalized skill still has concurrencyDefault and contextOptimization
  assert.ok('concurrencyDefault' in cfg.skill, 'concurrencyDefault is present');
  assert.ok('contextOptimization' in cfg.skill, 'contextOptimization is present');
});

// ---------------------------------------------------------------------------
// Scenario: fresh config seeds default agents and instructions
//   Given no input config
//   When defaultConfig runs
//   Then the "defining" column agent equals AGENT_TYPES.ba
//   And the "in-progress" column agent equals AGENT_TYPES.coder
//   And the "testing" column agent equals AGENT_TYPES.tester
//   And the "todo","done" columns have agent null
//   And each system column's instructions equals its SYSTEM_COLUMN_DEFAULT_INSTRUCTIONS entry
// ---------------------------------------------------------------------------
test('Scenario: fresh config seeds default agents and instructions', () => {
  // When defaultConfig runs
  const cfg = defaultConfig();

  // Then the "defining" column agent equals AGENT_TYPES.ba
  const defining = cfg.columns.find((c) => c.status === 'defining');
  assert.equal(defining.agent, AGENT_TYPES.ba, 'defining agent is orchestrate-ba');

  // And the "in-progress" column agent equals AGENT_TYPES.coder
  const inProgress = cfg.columns.find((c) => c.status === 'in-progress');
  assert.equal(inProgress.agent, AGENT_TYPES.coder, 'in-progress agent is orchestrate-coder');

  // And the "testing" column agent equals AGENT_TYPES.tester
  const testing = cfg.columns.find((c) => c.status === 'testing');
  assert.equal(testing.agent, AGENT_TYPES.tester, 'testing agent is orchestrate-tester');

  // And the "todo","done" columns have agent null (TASK-206 removed post-processing)
  for (const slug of ['todo', 'done']) {
    const col = cfg.columns.find((c) => c.status === slug);
    assert.equal(col.agent, null, `${slug} agent is null`);
  }

  // And each system column's instructions equals its SYSTEM_COLUMN_DEFAULT_INSTRUCTIONS entry
  for (const slug of SYSTEM_SLUGS) {
    const col = cfg.columns.find((c) => c.status === slug);
    const expected = SYSTEM_COLUMN_DEFAULT_INSTRUCTIONS[slug];
    assert.equal(col.instructions, expected, `${slug} instructions match default`);
  }
});

// ---------------------------------------------------------------------------
// Scenario: a user-set null agent on a system column is preserved
//   Given a raw config whose "in-progress" column has agent null explicitly
//   When normalizeConfig runs
//   Then the "in-progress" column agent is null
// ---------------------------------------------------------------------------
test('Scenario: a user-set null agent on a system column is preserved', () => {
  // Given a raw config whose "in-progress" column has agent null explicitly
  const raw = {
    version: 1,
    columns: [
      { status: 'todo', label: 'To Do', system: true },
      { status: 'defining', label: 'Defining', system: true },
      { status: 'in-progress', label: 'In Progress', agent: null, system: true },
      { status: 'testing', label: 'Testing', system: true },
      { status: 'post-processing', label: 'Post-processing', system: true },
      { status: 'done', label: 'Done', system: true },
    ],
    skill: { concurrencyDefault: 3 },
  };

  // When normalizeConfig runs
  const cfg = normalizeConfig(raw);

  // Then the "in-progress" column agent is null
  const inProgress = cfg.columns.find((c) => c.status === 'in-progress');
  assert.equal(inProgress.agent, null, 'user-set null agent is preserved');
});

// ---------------------------------------------------------------------------
// Scenario: serialize is idempotent and phase-free
//   Given any raw config containing phase and skill.phases
//   When serializeConfig runs and its output is re-normalized
//   Then the re-normalized config equals the first normalized config
//   And the serialized JSON contains no "phase" key and no "phases" key
// ---------------------------------------------------------------------------
test('Scenario: serialize is idempotent and phase-free', () => {
  // Given any raw config containing phase and skill.phases
  const raw = {
    version: 1,
    columns: [
      { status: 'todo', label: 'To Do', system: true },
      { status: 'defining', label: 'Defining', phase: 'plan', system: true },
      { status: 'in-progress', label: 'In Progress', system: true },
      { status: 'testing', label: 'Testing', phase: 'test', system: true },
      { status: 'post-processing', label: 'Post-processing', system: true },
      { status: 'done', label: 'Done', system: true },
    ],
    skill: {
      concurrencyDefault: 3,
      phases: { plan: { label: 'Plan' }, test: { label: 'Test' } },
    },
  };

  // First normalize
  const firstNorm = normalizeConfig(raw);

  // When serializeConfig runs and its output is re-normalized
  const serialized = serializeConfig(raw);
  const reparsed = JSON.parse(serialized);
  const secondNorm = normalizeConfig(reparsed);

  // Then the re-normalized config equals the first normalized config
  assert.deepEqual(
    secondNorm.columns.map((c) => c.status),
    firstNorm.columns.map((c) => c.status),
    'normalized columns match'
  );
  assert.deepEqual(secondNorm.skill, firstNorm.skill, 'normalized skill matches');

  // And the serialized JSON contains no "phase" key and no "phases" key
  assert.ok(!serialized.includes('"phase"'), 'serialized JSON has no "phase" key');
  assert.ok(!serialized.includes('"phases"'), 'serialized JSON has no "phases" key');
});

// ---------------------------------------------------------------------------
// Scenario: unknown skill keys still round-trip but phases never does (edge)
//   Given a raw config whose skill has phases and an unknown key "foo":42
//   When normalizeConfig runs
//   Then the normalized skill has foo 42
//   And the normalized skill has no phases key
// ---------------------------------------------------------------------------
test('Scenario: unknown skill keys still round-trip but phases never does (edge)', () => {
  // Given a raw config whose skill has phases and an unknown key "foo":42
  const raw = {
    version: 1,
    columns: [
      { status: 'todo', label: 'To Do', system: true },
      { status: 'defining', label: 'Defining', system: true },
      { status: 'in-progress', label: 'In Progress', system: true },
      { status: 'testing', label: 'Testing', system: true },
      { status: 'post-processing', label: 'Post-processing', system: true },
      { status: 'done', label: 'Done', system: true },
    ],
    skill: {
      concurrencyDefault: 3,
      phases: { plan: {} },
      foo: 42,
    },
  };

  // When normalizeConfig runs
  const cfg = normalizeConfig(raw);

  // Then the normalized skill has foo 42
  assert.equal(cfg.skill.foo, 42, 'unknown skill key foo round-trips');

  // And the normalized skill has no phases key
  assert.ok(!('phases' in cfg.skill), 'phases is dropped');
});

// ---------------------------------------------------------------------------
// Scenario: junk input never throws (failure path)
//   Given the input is the string "not json {"
//   When normalizeConfig runs
//   Then it returns a complete valid config with the five system columns
//   And each system column carries its default agent and instructions
// ---------------------------------------------------------------------------
test('Scenario: junk input never throws (failure path)', () => {
  // Given the input is the string "not json {"
  const junkInput = 'not json {';

  // When normalizeConfig runs (never throws)
  let cfg;
  assert.doesNotThrow(() => {
    cfg = normalizeConfig(junkInput);
  }, 'normalizeConfig never throws on invalid JSON');

  // Then it returns a complete valid config with the five system columns
  assert.ok(Array.isArray(cfg.columns), 'columns is an array');
  assert.equal(cfg.columns.length, 5, 'has five system columns');
  assert.deepEqual(
    cfg.columns.map((c) => c.status),
    SYSTEM_SLUGS,
    'system columns are in canonical order'
  );

  // And each system column carries its default agent and instructions
  for (const slug of SYSTEM_SLUGS) {
    const col = cfg.columns.find((c) => c.status === slug);
    assert.equal(col.agent, SYSTEM_COLUMN_DEFAULT_AGENTS[slug], `${slug} agent matches default`);
    assert.equal(
      col.instructions,
      SYSTEM_COLUMN_DEFAULT_INSTRUCTIONS[slug],
      `${slug} instructions match default`
    );
  }
});
