'use strict';

// ===========================================================================
// TASK-180 — e2e cucumber-style (Given/When/Then) scenarios
//
// Feature: team-config phase + column-phase schema
//
// These are scenario-style `node --test` cases (no `cucumber` npm package)
// implementing the Gherkin scenarios in the ticket. Most scenarios are a
// Given/When/Then test of the pure lib/team-config.js functions.
//
// TASK-186: a couple of scenarios below are explicitly scoped to the SEPARATE,
// hand-maintained renderer/renderer.js mirror of that schema (tasksBuildColumn /
// tasksNormalizeColumnPhase / normalizeTasksColumns / tasksSerializeTeamConfig).
// Those extract and call the REAL renderer functions (matching the extraction-
// harness pattern in test/task-103-column-manager.test.js /
// test/helpers/task-101-lane-harness.js) — never the lib/team-config.js copies
// they mirror — because a review of TASK-180 found scenarios here that claimed
// renderer coverage but actually only exercised the lib.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const teamConfig = require('../lib/team-config.js');
const { PHASE_SPECS } = require('../lib/skill-workflow.js');

const {
  PHASE_KEYS,
  PHASE_DEFAULTS,
  defaultConfig,
  normalizeConfig,
  serializeConfig,
} = teamConfig;

// ---------------------------------------------------------------------------
// TASK-186 — extraction harness for the renderer's own phase mirror. Mirrors
// the extractFn/extractConst helpers in test/task-103-column-manager.test.js:
// renderer/renderer.js is a browser script (no module.exports), so the pure
// functions under test are extracted by brace-matching / regex from the
// SHIPPED source and evaluated in a sandbox — this proves the actual shipped
// code, not a hand-written replica. Both helpers assert.ok() (fail loudly,
// never silently stub) if the named symbol is missing from renderer.js.
// ---------------------------------------------------------------------------
const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');

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

// Load the REAL renderer phase-mirror helpers headless: tasksBuildColumn,
// tasksNormalizeColumnPhase, normalizeTasksColumns, tasksSerializeTeamConfig.
function loadRendererPhaseMirror() {
  const body = [
    extractConst(rendererSrc, 'TASKS_LANE_STATUSES'),
    extractConst(rendererSrc, 'TASKS_VALID_STATUSES'),
    extractConst(rendererSrc, 'TASKS_UNKNOWN_STATUS'),
    extractConst(rendererSrc, 'TASKS_SYSTEM_LABELS'),
    extractConst(rendererSrc, 'TASKS_RESERVED_SLUGS'),
    extractConst(rendererSrc, 'TASKS_MAX_SLUG_LENGTH'),
    extractConst(rendererSrc, 'TASKS_SLUG_RE'),
    // tasksBuildColumn normalises a column's optional `phase` link via
    // tasksNormalizeColumnPhase, which reads TASKS_PHASE_KEYS.
    extractConst(rendererSrc, 'TASKS_PHASE_KEYS'),
    // tasksSerializeTeamConfig clamps skill.concurrencyDefault through
    // resolveTasksConcurrency, so these three symbols must be in scope too.
    extractConst(rendererSrc, 'TASKS_MAX_CONCURRENCY'),
    extractConst(rendererSrc, 'TASKS_DEFAULT_CONCURRENCY'),
    extractFn(rendererSrc, 'resolveTasksConcurrency'),
    extractFn(rendererSrc, 'tasksPrettifyLabel'),
    extractFn(rendererSrc, 'tasksNormalizeColumnPhase'),
    extractFn(rendererSrc, 'tasksBuildColumn'),
    extractFn(rendererSrc, 'normalizeTasksColumns'),
    extractFn(rendererSrc, 'tasksSerializeTeamConfig'),
    'return { tasksBuildColumn, tasksNormalizeColumnPhase, normalizeTasksColumns,',
    '  tasksSerializeTeamConfig };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(body)();
}
const R = loadRendererPhaseMirror();

// ---------------------------------------------------------------------------
// Scenario: defaultConfig carries the four phases
//   When defaultConfig() is produced
//   Then skill.phases has keys plan, build, test, review
//   And plan/build/test are enabled true with order 1,2,3 and review is
//   enabled false with order 4
// ---------------------------------------------------------------------------
test('Scenario: defaultConfig carries the four phases', () => {
  // When defaultConfig() is produced
  const cfg = defaultConfig();

  // Then skill.phases exists and has the four canonical keys
  assert.ok(cfg.skill.phases, 'skill.phases exists');
  const keys = Object.keys(cfg.skill.phases).sort();
  assert.deepEqual(keys, ['build', 'plan', 'review', 'test'],
    'skill.phases has exactly plan, build, test, review');

  // And plan/build/test are enabled true with order 1,2,3
  assert.equal(cfg.skill.phases.plan.enabled, true, 'plan enabled');
  assert.equal(cfg.skill.phases.plan.order, 1, 'plan order is 1');
  assert.equal(cfg.skill.phases.build.enabled, true, 'build enabled');
  assert.equal(cfg.skill.phases.build.order, 2, 'build order is 2');
  assert.equal(cfg.skill.phases.test.enabled, true, 'test enabled');
  assert.equal(cfg.skill.phases.test.order, 3, 'test order is 3');

  // And review is enabled false with order 4 (opt-in by default)
  assert.equal(cfg.skill.phases.review.enabled, false, 'review disabled by default');
  assert.equal(cfg.skill.phases.review.order, 4, 'review order is 4');
});

// ---------------------------------------------------------------------------
// Scenario: normalizeConfig fills a missing phase
//   Given a config whose skill.phases omits "review"
//   When it is normalized
//   Then skill.phases.review is present with its canonical default
//   And a warning names the re-inserted phase
// ---------------------------------------------------------------------------
test('Scenario: normalizeConfig fills a missing phase', () => {
  // Given a config whose skill.phases omits "review"
  const raw = {
    version: 1,
    columns: defaultConfig().columns,
    skill: {
      concurrencyDefault: 3,
      phases: {
        plan: { enabled: true, order: 1 },
        build: { enabled: true, order: 2 },
        test: { enabled: true, order: 3 },
        // review missing
      },
    },
  };

  // When it is normalized
  const cfg = normalizeConfig(raw);

  // Then skill.phases.review is present with its canonical default
  assert.ok(cfg.skill.phases.review, 'review phase inserted');
  assert.equal(cfg.skill.phases.review.enabled, PHASE_DEFAULTS.review.enabled,
    'review.enabled matches canonical default');
  assert.equal(cfg.skill.phases.review.order, PHASE_DEFAULTS.review.order,
    'review.order matches canonical default');

  // And a warning names the re-inserted phase
  assert.ok(Array.isArray(cfg.warnings), 'warnings is an array');
  assert.ok(cfg.warnings.some((w) => /review/.test(w) && /missing/.test(w)),
    'warning names review and mentions missing');
});

// ---------------------------------------------------------------------------
// Scenario: unknown phase key is dropped
//   Given a config with skill.phases.deploy = { enabled: true, order: 9 }
//   When it is normalized
//   Then skill.phases has exactly plan/build/test/review
//   And a warning names the dropped "deploy" phase
// ---------------------------------------------------------------------------
test('Scenario: unknown phase key is dropped', () => {
  // Given a config with skill.phases.deploy = { enabled: true, order: 9 }
  const raw = {
    version: 1,
    columns: defaultConfig().columns,
    skill: {
      concurrencyDefault: 3,
      phases: {
        plan: { enabled: true, order: 1 },
        build: { enabled: true, order: 2 },
        test: { enabled: true, order: 3 },
        review: { enabled: false, order: 4 },
        deploy: { enabled: true, order: 9 }, // unknown
      },
    },
  };

  // When it is normalized
  const cfg = normalizeConfig(raw);

  // Then skill.phases has exactly plan/build/test/review (deploy dropped)
  const keys = Object.keys(cfg.skill.phases).sort();
  assert.deepEqual(keys, ['build', 'plan', 'review', 'test'],
    'skill.phases has exactly the four canonical keys, deploy removed');

  // And a warning names the dropped "deploy" phase
  assert.ok(cfg.warnings.some((w) => /deploy/.test(w)),
    'warning names deploy');
  assert.ok(cfg.warnings.some((w) => /unknown|dropped/.test(w)),
    'warning mentions dropped or unknown');
});

// ---------------------------------------------------------------------------
// Scenario: column phase link normalises to a valid phase
//   Given a user column with phase "review"
//   When it is normalized
//   Then the column keeps phase "review"
// ---------------------------------------------------------------------------
test('Scenario: column phase link normalises to a valid phase', () => {
  // Given a user column with phase "review"
  const raw = {
    version: 1,
    columns: [
      { status: 'todo', label: 'To Do', system: true },
      { status: 'defining', label: 'Defining', system: true },
      { status: 'in-progress', label: 'In Progress', system: true },
      { status: 'testing', label: 'Testing', system: true },
      { status: 'ux-review', label: 'UX Review', description: 'peer review', system: false, phase: 'review' },
      { status: 'post-processing', label: 'Post-processing', system: true },
      { status: 'done', label: 'Done', system: true },
    ],
    skill: { concurrencyDefault: 3 },
  };

  // When it is normalized
  const cfg = normalizeConfig(raw);

  // Then the column keeps phase "review"
  const uxReview = cfg.columns.find((c) => c.status === 'ux-review');
  assert.ok(uxReview, 'ux-review column exists');
  assert.equal(uxReview.phase, 'review', 'ux-review.phase is "review"');
});

// ---------------------------------------------------------------------------
// Scenario: column phase round-trips through the LIB serializer
//   Given a working config whose column has phase "review"
//   When lib/team-config.js serializeConfig serialises it
//   Then the persisted JSON still carries phase "review" on that column
//
// TASK-186: this scenario is lib/team-config.js coverage ONLY — it calls
// serializeConfig, not the renderer's own tasksSerializeTeamConfig. See the
// "renderer functions" scenario immediately below for the renderer-scoped
// equivalent of this round-trip.
// ---------------------------------------------------------------------------
test('Scenario: column phase round-trips through serializeConfig (lib/team-config.js)', () => {
  // Given a working config whose column has phase "review"
  const cfg = defaultConfig();
  cfg.columns[1].phase = 'review'; // defining column

  // When serializeConfig serialises it
  const serialized = serializeConfig(cfg);

  // Then the persisted JSON still carries phase "review" on that column
  const parsed = JSON.parse(serialized);
  const defining = parsed.columns.find((c) => c.status === 'defining');
  assert.ok(defining, 'defining column in serialized output');
  assert.equal(defining.phase, 'review', 'defining.phase is "review" in serialized output');
});

// ---------------------------------------------------------------------------
// Scenario: column phase round-trips through the RENDERER's own functions
//   Given a raw column built via the renderer's own tasksBuildColumn with
//   phase "review"
//   When it flows through normalizeTasksColumns (the renderer's own
//   normalizer) and the resulting working config is serialised via the
//   renderer's own tasksSerializeTeamConfig (NOT lib/team-config.js
//   serializeConfig)
//   Then the persisted JSON still carries phase "review" on that column
//
// TASK-186: the scenario above only proves the LIB serializer round-trips
// `phase`; it exercises none of renderer/renderer.js's own tasksBuildColumn /
// normalizeTasksColumns / tasksSerializeTeamConfig mirror — a separate,
// hand-maintained "KEEP IN SYNC" copy that TASK-180 itself called the
// highest-risk part of that change. This scenario extracts and calls those
// REAL renderer functions instead. If tasksSerializeTeamConfig's column map
// were ever reverted to drop `phase` from its fixed key set, `persisted.phase`
// below would be `undefined` and this scenario would fail.
// ---------------------------------------------------------------------------
test('Scenario: column phase round-trips through tasksBuildColumn -> normalizeTasksColumns -> tasksSerializeTeamConfig (renderer functions)', () => {
  // Given a raw column built via the renderer's own tasksBuildColumn with phase "review"
  const rawCol = R.tasksBuildColumn('ux-review', { label: 'UX Review', phase: 'review' }, false);
  assert.equal(rawCol.phase, 'review', 'tasksBuildColumn keeps a valid phase link');

  // When it flows through normalizeTasksColumns (the renderer's own normalizer)
  const normalized = R.normalizeTasksColumns({ columns: [rawCol] });
  const uxReview = normalized.find((c) => c.status === 'ux-review');
  assert.ok(uxReview, 'ux-review column present after normalizeTasksColumns');
  assert.equal(uxReview.phase, 'review', 'phase survives normalizeTasksColumns');

  // And the working config is serialised via the renderer's own
  // tasksSerializeTeamConfig (NOT lib/team-config.js serializeConfig)
  const working = { version: 1, skill: {}, columns: normalized };
  const serialized = R.tasksSerializeTeamConfig(working);
  const parsed = JSON.parse(serialized);
  const persisted = parsed.columns.find((c) => c.status === 'ux-review');

  // Then the persisted JSON still carries phase "review" on that column
  assert.ok(persisted, 'ux-review column present in tasksSerializeTeamConfig output');
  assert.equal(persisted.phase, 'review',
    "phase survives the renderer's own build -> normalize -> serialize round-trip");
});

// ---------------------------------------------------------------------------
// Scenario: invalid column phase is nulled (failure/edge)
//   Given a column with phase "deploy" and another with phase 42
//   When it is normalized
//   Then both columns have phase null
//   And a warning is recorded for the non-null invalid value
// ---------------------------------------------------------------------------
test('Scenario: invalid column phase is nulled (failure/edge)', () => {
  // Given columns with invalid phase values
  const raw = {
    version: 1,
    columns: [
      { status: 'todo', label: 'To Do', system: true },
      { status: 'defining', label: 'Defining', system: true, phase: 'deploy' }, // invalid string
      { status: 'in-progress', label: 'In Progress', system: true, phase: 42 }, // non-string
      { status: 'testing', label: 'Testing', system: true },
      { status: 'post-processing', label: 'Post-processing', system: true },
      { status: 'done', label: 'Done', system: true },
    ],
    skill: { concurrencyDefault: 3 },
  };

  // When it is normalized
  const cfg = normalizeConfig(raw);

  // Then both columns have phase null
  const defining = cfg.columns.find((c) => c.status === 'defining');
  const inProgress = cfg.columns.find((c) => c.status === 'in-progress');
  assert.equal(defining.phase, null, 'defining.phase is null (was "deploy")');
  assert.equal(inProgress.phase, null, 'in-progress.phase is null (was 42)');

  // And warnings are recorded for the non-null invalid values
  assert.ok(cfg.warnings.some((w) => /phase/.test(w) && /defining|in-progress/.test(w)),
    'warning mentions invalid phase on one of the columns');
});

// ---------------------------------------------------------------------------
// Scenario: enabled coercion (failure/edge)
//   Given skill.phases.review.enabled = "no" and skill.phases.test.order = -3
//   When it is normalized
//   Then review.enabled is true (coerced) with a warning
//   And test.order is 3 (canonical default) with a warning
// ---------------------------------------------------------------------------
test('Scenario: enabled coercion (failure/edge)', () => {
  // Given skill.phases.review.enabled = "no" and skill.phases.test.order = -3
  const raw = {
    version: 1,
    columns: defaultConfig().columns,
    skill: {
      concurrencyDefault: 3,
      phases: {
        plan: { enabled: true, order: 1 },
        build: { enabled: true, order: 2 },
        test: { enabled: true, order: -3 }, // invalid: negative
        review: { enabled: 'no', order: 4 }, // invalid: non-boolean
      },
    },
  };

  // When it is normalized
  const cfg = normalizeConfig(raw);

  // Then review.enabled is true (coerced) with a warning
  assert.equal(cfg.skill.phases.review.enabled, true,
    'review.enabled coerced to true');
  assert.ok(cfg.warnings.some((w) => /review/.test(w) && /enabled/.test(w)),
    'warning mentions review.enabled');

  // And test.order is 3 (canonical default) with a warning
  assert.equal(cfg.skill.phases.test.order, 3,
    'test.order reset to canonical default 3');
  assert.ok(cfg.warnings.some((w) => /test/.test(w) && /order/.test(w)),
    'warning mentions test.order');
});

// ---------------------------------------------------------------------------
// Scenario: null/junk raw input always produces a valid config (edge)
//   When normalizeConfig receives null, a string, an array, or junk
//   Then a complete valid config with skill.phases is always returned
//   And no exception is ever thrown
// ---------------------------------------------------------------------------
test('Scenario: null/junk raw input always produces a valid config (edge)', () => {
  const junk = [
    null,
    undefined,
    'not json',
    42,
    [],
    { columns: 'nope' }, // columns not array
  ];

  for (const input of junk) {
    // When normalizeConfig receives junk (never throws)
    let cfg;
    assert.doesNotThrow(() => { cfg = normalizeConfig(input); },
      `normalizeConfig(${JSON.stringify(input)}) does not throw`);

    // Then a complete valid config is returned with skill.phases
    assert.ok(cfg.skill, 'skill object exists');
    assert.ok(cfg.skill.phases, 'skill.phases exists');
    const keys = Object.keys(cfg.skill.phases).sort();
    assert.deepEqual(keys, ['build', 'plan', 'review', 'test'],
      `junk input ${JSON.stringify(input)} yields valid phases`);
    // And all four phases have enabled/order
    for (const key of PHASE_KEYS) {
      assert.equal(typeof cfg.skill.phases[key].enabled, 'boolean');
      assert.equal(typeof cfg.skill.phases[key].order, 'number');
    }
  }
});

// ---------------------------------------------------------------------------
// Scenario: skill.phases as array or non-object → replaced with defaults (edge)
//   Given skill.phases as [] or a string
//   When it is normalized
//   Then all four phases are present at defaults
//   And a warning is recorded
// ---------------------------------------------------------------------------
test('Scenario: skill.phases as non-object → replaced with defaults (edge)', () => {
  const testCases = [
    { phases: [] }, // array
    { phases: 'string' }, // string
    { phases: 42 }, // number
  ];

  for (const skillObj of testCases) {
    const raw = {
      version: 1,
      columns: defaultConfig().columns,
      skill: skillObj,
    };

    const cfg = normalizeConfig(raw);

    // Then all four phases are present at defaults
    const keys = Object.keys(cfg.skill.phases).sort();
    assert.deepEqual(keys, ['build', 'plan', 'review', 'test']);

    // And a warning is recorded
    assert.ok(cfg.warnings.some((w) => /phases/.test(w)),
      `warning for non-object phases: ${JSON.stringify(skillObj)}`);
  }
});

// ---------------------------------------------------------------------------
// Scenario: phase value not an object → replaced with that phase's defaults (edge)
//   Given skill.phases.plan = true (not an object)
//   When it is normalized
//   Then plan is replaced with its canonical default
// ---------------------------------------------------------------------------
test('Scenario: phase value not an object → replaced with defaults (edge)', () => {
  // Given skill.phases.plan = true (not an object)
  const raw = {
    version: 1,
    columns: defaultConfig().columns,
    skill: {
      concurrencyDefault: 3,
      phases: {
        plan: true, // not an object
        build: { enabled: true, order: 2 },
        test: { enabled: true, order: 3 },
        review: { enabled: false, order: 4 },
      },
    },
  };

  // When it is normalized
  const cfg = normalizeConfig(raw);

  // Then plan is replaced with its canonical default
  assert.equal(cfg.skill.phases.plan.enabled, PHASE_DEFAULTS.plan.enabled);
  assert.equal(cfg.skill.phases.plan.order, PHASE_DEFAULTS.plan.order);

  // And a warning is recorded
  assert.ok(cfg.warnings.some((w) => /plan/.test(w) && /object/.test(w)),
    'warning mentions plan and object');
});

// ---------------------------------------------------------------------------
// Scenario: __proto__/constructor/prototype as phase key → dropped safely (edge)
//   Given skill.phases with __proto__, constructor, or prototype as a key
//   When it is normalized
//   Then those keys are silently dropped
//   And prototype pollution is prevented
// ---------------------------------------------------------------------------
test('Scenario: unsafe phase keys are dropped (edge)', () => {
  // Given skill.phases with __proto__, constructor, prototype as keys
  const raw = {
    version: 1,
    columns: defaultConfig().columns,
    skill: {
      concurrencyDefault: 3,
      phases: {
        plan: { enabled: true, order: 1 },
        build: { enabled: true, order: 2 },
        test: { enabled: true, order: 3 },
        review: { enabled: false, order: 4 },
        __proto__: { malicious: true },
        constructor: { hijack: true },
        prototype: { poison: true },
      },
    },
  };

  // When it is normalized
  const cfg = normalizeConfig(raw);

  // Then only the four canonical keys are present
  const keys = Object.keys(cfg.skill.phases).sort();
  assert.deepEqual(keys, ['build', 'plan', 'review', 'test'],
    'only canonical keys present');

  // And unsafe keys are not present as own properties
  assert.ok(!Object.prototype.hasOwnProperty.call(cfg.skill.phases, '__proto__'));
  assert.ok(!Object.prototype.hasOwnProperty.call(cfg.skill.phases, 'constructor'));
  assert.ok(!Object.prototype.hasOwnProperty.call(cfg.skill.phases, 'prototype'));
});

// ---------------------------------------------------------------------------
// Scenario: __proto__ as a GENUINE own key (via JSON.parse) → dropped safely (edge)
//   Given a phases object whose "__proto__" own enumerable key was produced by
//   JSON.parse (not the object-literal `__proto__: {...}` syntax, which sets a
//   prototype instead of an own key and never reaches this code path)
//   When it is normalized
//   Then the key is silently/safely dropped via the "unsafe key" path
//   And neither the result's own prototype nor Object.prototype globally is
//   polluted
// ---------------------------------------------------------------------------
test('Scenario: __proto__ as a genuine own key from JSON.parse is dropped safely (edge)', () => {
  // Given a phases object built via JSON.parse so "__proto__" is a real own
  // enumerable property (this is how a tampered config file on disk would
  // arrive, unlike a `{ __proto__: {...} }` object literal in test code).
  const phases = JSON.parse(
    '{"plan":{"enabled":true,"order":1},'
    + '"build":{"enabled":true,"order":2},'
    + '"test":{"enabled":true,"order":3},'
    + '"review":{"enabled":false,"order":4},'
    + '"__proto__":{"malicious":true},'
    + '"constructor":{"hijack":true}}'
  );
  assert.ok(Object.prototype.hasOwnProperty.call(phases, '__proto__'),
    'sanity check: JSON.parse produced __proto__ as an own key');

  const raw = {
    version: 1,
    columns: defaultConfig().columns,
    skill: { concurrencyDefault: 3, phases },
  };

  // When it is normalized
  const cfg = normalizeConfig(raw);

  // Then only the four canonical keys are present
  const keys = Object.keys(cfg.skill.phases).sort();
  assert.deepEqual(keys, ['build', 'plan', 'review', 'test'],
    'only canonical keys present');
  assert.ok(!Object.prototype.hasOwnProperty.call(cfg.skill.phases, '__proto__'));
  assert.ok(!Object.prototype.hasOwnProperty.call(cfg.skill.phases, 'constructor'));

  // And the result's own prototype is unaffected
  assert.deepEqual(Object.getPrototypeOf(cfg.skill.phases), Object.prototype,
    'result prototype is still Object.prototype');

  // And no pollution leaked onto Object.prototype globally
  assert.equal(({}).malicious, undefined, 'no global pollution onto Object.prototype');

  // And the __proto__ own key is reported via the "unsafe" warning path
  assert.ok(cfg.warnings.some((w) => /unsafe/.test(w) && /__proto__/.test(w)),
    '__proto__ own key produces an "unsafe" warning naming it');
});

// ---------------------------------------------------------------------------
// Scenario: order collisions are allowed (no re-sequencing)
//   Given two phases with the same order value
//   When it is normalized
//   Then both keep their order unchanged
//   And no warning about collision is recorded
// ---------------------------------------------------------------------------
test('Scenario: order collisions are permitted (no re-sequencing)', () => {
  // Given two phases with the same order value
  const raw = {
    version: 1,
    columns: defaultConfig().columns,
    skill: {
      concurrencyDefault: 3,
      phases: {
        plan: { enabled: true, order: 2 }, // both 2
        build: { enabled: true, order: 2 }, // order collision
        test: { enabled: true, order: 3 },
        review: { enabled: false, order: 4 },
      },
    },
  };

  // When it is normalized
  const cfg = normalizeConfig(raw);

  // Then both keep their order unchanged
  assert.equal(cfg.skill.phases.plan.order, 2);
  assert.equal(cfg.skill.phases.build.order, 2);

  // And no warning about collision is recorded (collisions are allowed)
  assert.ok(!cfg.warnings.some((w) => /collision/.test(w)),
    'no collision warning');
});

// ---------------------------------------------------------------------------
// Scenario: CONFIG_VERSION handling unchanged (newer version round-trips)
//   Given a config with version: 99
//   When it is normalized and serialized
//   Then the version is preserved as 99 (never downgraded)
// ---------------------------------------------------------------------------
test('Scenario: CONFIG_VERSION handling unchanged (newer version round-trips)', () => {
  // Given a config with version: 99
  const raw = {
    version: 99,
    columns: defaultConfig().columns,
    skill: { concurrencyDefault: 3, phases: defaultConfig().skill.phases },
  };

  // When it is normalized
  const cfg = normalizeConfig(raw);

  // Then the version is preserved as 99 (never downgraded)
  assert.equal(cfg.version, 99, 'newer version round-trips untouched');

  // And serialization preserves it
  const serialized = serializeConfig(cfg);
  const parsed = JSON.parse(serialized);
  assert.equal(parsed.version, 99, 'version preserved in serialized output');
});

// ---------------------------------------------------------------------------
// Scenario: historic config without skill.phases or column phase normalizes
// without error and gains the defaults
//   Given a historic config with no skill.phases and no column phase fields
//   When it is normalized
//   Then skill.phases is added with all four canonical defaults
//   And all columns gain phase: null
//   And no warnings are recorded (silent upgrade)
// ---------------------------------------------------------------------------
test('Scenario: historic config without phases gains defaults silently', () => {
  // Given a historic config (no skill.phases, no column phase)
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
    skill: { concurrencyDefault: 3 },
  };

  // When it is normalized
  const cfg = normalizeConfig(raw);

  // Then skill.phases is added with all four canonical defaults
  assert.ok(cfg.skill.phases, 'skill.phases added');
  const keys = Object.keys(cfg.skill.phases).sort();
  assert.deepEqual(keys, ['build', 'plan', 'review', 'test']);
  for (const key of PHASE_KEYS) {
    assert.deepEqual(cfg.skill.phases[key], PHASE_DEFAULTS[key]);
  }

  // And all columns gain phase: null
  for (const col of cfg.columns) {
    assert.equal(col.phase, null, `${col.status} has phase: null`);
  }
});

// ---------------------------------------------------------------------------
// Scenario: LIB serialization is idempotent (round-trip)
//   Given a config with skill.phases and column phases
//   When it is serialized and re-parsed via lib/team-config.js
//   Then the persisted JSON round-trips perfectly (idempotent)
//
// TASK-186: this scenario (and its former "Renderer mirror (tandem
// integration)" heading) exercises ONLY lib/team-config.js serializeConfig /
// normalizeConfig — the heading previously claimed renderer coverage the test
// never provided. See the "renderer functions" scenario immediately below for
// the actual renderer-scoped equivalent.
// ---------------------------------------------------------------------------
test('Scenario: lib serializeConfig round-trip is idempotent (lib/team-config.js)', () => {
  // Given a config with skill.phases and column phases
  const cfg = defaultConfig();
  cfg.skill.phases.plan.order = 10;
  cfg.columns[1].phase = 'review';

  // When it is serialized and re-parsed
  const s1 = serializeConfig(cfg);
  const cfg2 = normalizeConfig(s1);
  const s2 = serializeConfig(cfg2);

  // Then serialization is byte-identical (idempotent)
  assert.equal(s1, s2, 'serialized output is idempotent on round-trip');

  // And the phases/phase fields survive intact
  assert.equal(cfg2.skill.phases.plan.order, 10);
  const defining = cfg2.columns.find((c) => c.status === 'defining');
  assert.equal(defining.phase, 'review');
});

// ---------------------------------------------------------------------------
// Scenario: RENDERER's own tasksSerializeTeamConfig round-trip is idempotent
//   Given a working config built via the renderer's own tasksBuildColumn /
//   normalizeTasksColumns with a column phase link
//   When it is serialized twice via the renderer's own
//   tasksSerializeTeamConfig, re-normalizing between the two
//   Then the two serializations are byte-identical and the phase survives
// ---------------------------------------------------------------------------
test('Scenario: renderer tasksSerializeTeamConfig round-trip is idempotent (renderer functions)', () => {
  // Given a working config built via the renderer's own functions
  const rawCol = R.tasksBuildColumn('ux-review', { label: 'UX Review', phase: 'review' }, false);
  const normalized = R.normalizeTasksColumns({ columns: [rawCol] });
  const working1 = { version: 1, skill: {}, columns: normalized };

  // When it is serialized twice via tasksSerializeTeamConfig, re-normalizing
  // the parsed output between the two (as a real load -> edit -> save cycle would)
  const s1 = R.tasksSerializeTeamConfig(working1);
  const parsed1 = JSON.parse(s1);
  const normalized2 = R.normalizeTasksColumns({ columns: parsed1.columns });
  const working2 = { version: parsed1.version, skill: parsed1.skill, columns: normalized2 };
  const s2 = R.tasksSerializeTeamConfig(working2);

  // Then the two serializations are byte-identical (idempotent)
  assert.equal(s1, s2, 'renderer tasksSerializeTeamConfig output is idempotent on round-trip');

  // And the phase field survives the renderer's own round-trip
  const parsed2 = JSON.parse(s2);
  const uxReview = parsed2.columns.find((c) => c.status === 'ux-review');
  assert.ok(uxReview, 'ux-review column present after the renderer round-trip');
  assert.equal(uxReview.phase, 'review', 'phase field survives the renderer round-trip');
});
