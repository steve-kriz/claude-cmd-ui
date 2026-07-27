'use strict';

// ===========================================================================
// TASK-180 — unit tests for phase schema in lib/team-config.js
//
// Tests the new phase-related functionality: PHASE_KEYS, PHASE_DEFAULTS,
// defaultPhases(), normalizePhases(), and normalizeColumnPhase() functions.
// Also tests that skill.phases round-trips through serializeConfig and that
// the `phase` field on columns is properly handled.
//
// Like task-097, this module never touches disk/DB/network/Electron, so every
// test is a direct pure-function assertion via require().
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const teamConfig = require('../lib/team-config.js');
const { PHASE_SPECS } = require('../lib/skill-workflow.js');

const {
  CONFIG_VERSION,
  PHASE_KEYS,
  PHASE_DEFAULTS,
  defaultConfig,
  normalizeConfig,
  serializeConfig,
  validateNewColumn,
} = teamConfig;

// ── PHASE_KEYS & PHASE_DEFAULTS ─────────────────────────────────────────────
test('PHASE_KEYS exports the four canonical phase keys from PHASE_SPECS', () => {
  assert.ok(Array.isArray(PHASE_KEYS));
  assert.equal(PHASE_KEYS.length, 4);
  assert.deepEqual(PHASE_KEYS, ['plan', 'build', 'test', 'review']);
  // Must match PHASE_SPECS order
  for (let i = 0; i < PHASE_SPECS.length; i++) {
    assert.equal(PHASE_KEYS[i], PHASE_SPECS[i].key);
  }
});

test('PHASE_DEFAULTS has exactly the four keys with correct defaults', () => {
  assert.equal(typeof PHASE_DEFAULTS, 'object');
  for (const key of PHASE_KEYS) {
    assert.ok(Object.prototype.hasOwnProperty.call(PHASE_DEFAULTS, key), `${key} in PHASE_DEFAULTS`);
    const def = PHASE_DEFAULTS[key];
    assert.equal(typeof def.enabled, 'boolean', `${key}.enabled is boolean`);
    assert.equal(typeof def.order, 'number', `${key}.order is number`);
  }
  // Plan/build/test enabled true, order 1/2/3; review enabled false, order 4
  assert.equal(PHASE_DEFAULTS.plan.enabled, true);
  assert.equal(PHASE_DEFAULTS.plan.order, 1);
  assert.equal(PHASE_DEFAULTS.build.enabled, true);
  assert.equal(PHASE_DEFAULTS.build.order, 2);
  assert.equal(PHASE_DEFAULTS.test.enabled, true);
  assert.equal(PHASE_DEFAULTS.test.order, 3);
  assert.equal(PHASE_DEFAULTS.review.enabled, false);
  assert.equal(PHASE_DEFAULTS.review.order, 4);
});

// ── defaultConfig includes skill.phases ──────────────────────────────────────
test('defaultConfig includes skill.phases with all four canonical keys', () => {
  const cfg = defaultConfig();
  assert.ok(cfg.skill, 'skill object exists');
  assert.ok(cfg.skill.phases, 'skill.phases exists');
  assert.deepEqual(Object.keys(cfg.skill.phases).sort(), ['build', 'plan', 'review', 'test']);
  for (const key of PHASE_KEYS) {
    assert.ok(Object.prototype.hasOwnProperty.call(cfg.skill.phases, key), `${key} in phases`);
  }
});

test('defaultConfig phases match PHASE_DEFAULTS (plan/build/test enabled, review disabled)', () => {
  const cfg = defaultConfig();
  assert.equal(cfg.skill.phases.plan.enabled, true);
  assert.equal(cfg.skill.phases.plan.order, 1);
  assert.equal(cfg.skill.phases.build.enabled, true);
  assert.equal(cfg.skill.phases.build.order, 2);
  assert.equal(cfg.skill.phases.test.enabled, true);
  assert.equal(cfg.skill.phases.test.order, 3);
  assert.equal(cfg.skill.phases.review.enabled, false);
  assert.equal(cfg.skill.phases.review.order, 4);
});

test('defaultConfig creates fresh phase objects on each call (no shared state)', () => {
  const a = defaultConfig();
  const b = defaultConfig();
  assert.notEqual(a.skill.phases, b.skill.phases);
  a.skill.phases.plan.enabled = false;
  assert.equal(b.skill.phases.plan.enabled, true, 'mutating one default does not affect another');
});

// ── normalizeConfig: phases behavior (via public API) ────────────────────────
test('normalizeConfig fills a missing phase key with defaults and warns', () => {
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
  const cfg = normalizeConfig(raw);

  // All four keys present
  const keys = Object.keys(cfg.skill.phases).sort();
  assert.deepEqual(keys, ['build', 'plan', 'review', 'test']);
  assert.ok(cfg.skill.phases.review, 'review was added');
  assert.equal(cfg.skill.phases.review.enabled, PHASE_DEFAULTS.review.enabled);
  assert.equal(cfg.skill.phases.review.order, PHASE_DEFAULTS.review.order);

  // Warning recorded
  assert.ok(cfg.warnings.length > 0, 'warnings recorded');
  assert.ok(cfg.warnings.some((w) => /review/.test(w)), 'warning names review');
  assert.ok(cfg.warnings.some((w) => /missing/.test(w)), 'warning mentions missing');
});

test('normalizeConfig drops unknown phase key and warns', () => {
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
        deploy: { enabled: true, order: 5 }, // unknown
      },
    },
  };
  const cfg = normalizeConfig(raw);

  // Only four keys
  const keys = Object.keys(cfg.skill.phases).sort();
  assert.deepEqual(keys, ['build', 'plan', 'review', 'test']);
  assert.equal(cfg.skill.phases.deploy, undefined, 'deploy not present');

  // Warning
  assert.ok(cfg.warnings.some((w) => /deploy/.test(w)), 'warning names deploy');
  assert.ok(cfg.warnings.some((w) => /unknown/.test(w) || /dropped/.test(w)), 'warning says dropped/unknown');
});

test('normalizeConfig safely drops unsafe phase keys (__proto__/constructor)', () => {
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
        constructor: 'hijack',
      },
    },
  };
  const cfg = normalizeConfig(raw);

  const keys = Object.keys(cfg.skill.phases).sort();
  assert.deepEqual(keys, ['build', 'plan', 'review', 'test']);
  // Verify the four canonical keys are the only own properties
  assert.ok(!Object.prototype.hasOwnProperty.call(cfg.skill.phases, 'constructor'));
  // Unsafe keys generate "unsafe" warnings
  assert.ok(cfg.warnings.some((w) => /unsafe/.test(w)), 'unsafe key warning recorded');
});

test('normalizeConfig safely drops a genuine own-key "__proto__" produced by JSON.parse', () => {
  // A JS object literal's `__proto__: {...}` syntax sets the prototype and is
  // NOT an own enumerable key, so it never reaches normalizePhases's
  // Object.keys(src) loop. Real tampered config on disk arrives via
  // JSON.parse, where a literal `"__proto__"` string key from the source text
  // DOES become a genuine own enumerable data property. Build the hazard that
  // way so this test exercises the same code path a tampered config file would.
  const phases = JSON.parse(
    '{"plan":{"enabled":true,"order":1},'
    + '"build":{"enabled":true,"order":2},'
    + '"test":{"enabled":true,"order":3},'
    + '"review":{"enabled":false,"order":4},'
    + '"__proto__":{"malicious":true},'
    + '"constructor":"hijack"}'
  );

  // Sanity-check the hazard itself: unlike an object literal, JSON.parse
  // really does produce __proto__ as an own enumerable property here.
  assert.ok(Object.prototype.hasOwnProperty.call(phases, '__proto__'),
    'JSON.parse produced __proto__ as an own key (test construction sanity check)');
  assert.deepEqual(Object.getPrototypeOf(phases), Object.prototype,
    'JSON.parse never altered the parsed object\'s own prototype');

  const raw = {
    version: 1,
    columns: defaultConfig().columns,
    skill: { concurrencyDefault: 3, phases },
  };
  const cfg = normalizeConfig(raw);

  // Only the four canonical keys are present.
  const keys = Object.keys(cfg.skill.phases).sort();
  assert.deepEqual(keys, ['build', 'plan', 'review', 'test']);
  assert.ok(!Object.prototype.hasOwnProperty.call(cfg.skill.phases, 'constructor'));
  assert.ok(!Object.prototype.hasOwnProperty.call(cfg.skill.phases, '__proto__'));

  // The result's own prototype is untouched.
  assert.deepEqual(Object.getPrototypeOf(cfg.skill.phases), Object.prototype,
    'cfg.skill.phases prototype is still Object.prototype');

  // No pollution leaked onto Object.prototype globally: a brand-new object
  // must not carry the injected `malicious` property.
  assert.equal(({}).malicious, undefined, 'no global pollution onto Object.prototype');

  // The __proto__ key specifically is reported via the "unsafe" warning path
  // (not merely the generic "unknown phase" path).
  assert.ok(cfg.warnings.some((w) => /unsafe/.test(w) && /__proto__/.test(w)),
    '__proto__ own key produces an "unsafe" warning naming it');
});

test('normalizeConfig coerces enabled: non-boolean becomes true with warning', () => {
  const raw = {
    version: 1,
    columns: defaultConfig().columns,
    skill: {
      concurrencyDefault: 3,
      phases: {
        plan: { enabled: 'yes', order: 1 }, // string → true with warning
        build: { enabled: true, order: 2 },
        test: { enabled: true, order: 3 },
        review: { enabled: 0, order: 4 }, // 0 → true with warning
      },
    },
  };
  const cfg = normalizeConfig(raw);

  assert.equal(cfg.skill.phases.plan.enabled, true);
  assert.equal(cfg.skill.phases.review.enabled, true);

  // Warnings for non-boolean enabled values
  const enabledWarns = cfg.warnings.filter((w) => /enabled/.test(w) && (/boolean|reset/.test(w)));
  assert.ok(enabledWarns.length >= 2, `at least 2 enabled warnings`);
});

test('normalizeConfig coerces order: invalid value becomes canonical default with warning', () => {
  const raw = {
    version: 1,
    columns: defaultConfig().columns,
    skill: {
      concurrencyDefault: 3,
      phases: {
        plan: { enabled: true, order: -3 }, // negative → default 1 with warning
        build: { enabled: true, order: 'two' }, // string → default 2 with warning
        test: { enabled: true, order: 0 }, // zero → default 3 with warning
        review: { enabled: false, order: 4 },
      },
    },
  };
  const cfg = normalizeConfig(raw);

  assert.equal(cfg.skill.phases.plan.order, 1);
  assert.equal(cfg.skill.phases.build.order, 2);
  assert.equal(cfg.skill.phases.test.order, 3);

  // Warnings for invalid order
  const orderWarns = cfg.warnings.filter((w) => /order/.test(w) && (/invalid|reset/.test(w)));
  assert.ok(orderWarns.length >= 3, `at least 3 order warnings`);
});

test('normalizeConfig handles order collisions (both phases with order 2)', () => {
  const raw = {
    version: 1,
    columns: defaultConfig().columns,
    skill: {
      concurrencyDefault: 3,
      phases: {
        plan: { enabled: true, order: 2 },
        build: { enabled: true, order: 2 }, // collision allowed
        test: { enabled: true, order: 3 },
        review: { enabled: false, order: 4 },
      },
    },
  };
  const cfg = normalizeConfig(raw);

  // Both survive with their order (collision is allowed)
  assert.equal(cfg.skill.phases.plan.order, 2);
  assert.equal(cfg.skill.phases.build.order, 2);
  // No warning about collision
  assert.ok(!cfg.warnings.some((w) => /collision/.test(w)), 'no collision warning');
});

test('normalizeConfig handles a phase value that is not an object', () => {
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
  const cfg = normalizeConfig(raw);

  // plan reset to defaults
  assert.equal(cfg.skill.phases.plan.enabled, PHASE_DEFAULTS.plan.enabled);
  assert.equal(cfg.skill.phases.plan.order, PHASE_DEFAULTS.plan.order);

  // Warning
  assert.ok(cfg.warnings.some((w) => /plan.*not an object/.test(w)), 'warning about plan not being object');
});

// ── normalizeConfig: phases field ───────────────────────────────────────────
test('normalizeConfig includes skill.phases in output', () => {
  const raw = defaultConfig();
  const cfg = normalizeConfig(raw);

  assert.ok(cfg.skill.phases);
  assert.deepEqual(Object.keys(cfg.skill.phases).sort(), ['build', 'plan', 'review', 'test']);
});

test('normalizeConfig preserves valid skill.phases', () => {
  const raw = defaultConfig();
  raw.skill.phases.plan.order = 5; // tweak
  const cfg = normalizeConfig(raw);

  assert.equal(cfg.skill.phases.plan.order, 5, 'valid phase order preserved');
});

// ── normalizeColumnPhase (through normalizeConfig) ──────────────────────────
test('normalizeConfig keeps a valid column phase string', () => {
  const raw = defaultConfig();
  for (const key of PHASE_KEYS) {
    raw.columns[1].phase = key; // set defining column to each phase
    const cfg = normalizeConfig(raw);
    const defining = cfg.columns.find((c) => c.status === 'defining');
    assert.equal(defining.phase, key, `${key} phase is kept`);
  }
});

test('normalizeConfig nulls an invalid column phase and warns', () => {
  const raw = defaultConfig();
  raw.columns[1].phase = 'deploy'; // invalid

  const cfg = normalizeConfig(raw);
  const defining = cfg.columns.find((c) => c.status === 'defining');

  assert.equal(defining.phase, null, 'invalid phase becomes null');
  assert.ok(cfg.warnings.some((w) => /defining/.test(w) && /phase/.test(w)),
    'warning names defining and mentions phase');
});

test('normalizeConfig nulls non-string column phase values', () => {
  const raw = defaultConfig();
  // Column 1: phase = 42, Column 2: phase = true
  raw.columns[1].phase = 42;
  raw.columns[2].phase = true;

  const cfg = normalizeConfig(raw);
  const col1 = cfg.columns[1];
  const col2 = cfg.columns[2];

  assert.equal(col1.phase, null, 'numeric phase is nulled');
  assert.equal(col2.phase, null, 'boolean phase is nulled');
  assert.ok(cfg.warnings.some((w) => /phase/.test(w)), 'warnings for invalid phases');
});

test('normalizeConfig nulls a missing/null column phase without warning', () => {
  const raw = defaultConfig();
  // Columns with missing phase (undefined) and explicit null
  raw.columns[1].phase = null;
  delete raw.columns[2].phase;

  const cfg = normalizeConfig(raw);
  const col1 = cfg.columns[1];
  const col2 = cfg.columns[2];

  assert.equal(col1.phase, null);
  assert.equal(col2.phase, null);
  // No warnings about missing or null phase values
  const phaseWarns = cfg.warnings.filter((w) => /phase/.test(w) && /null|missing/.test(w));
  assert.equal(phaseWarns.length, 0, 'no warnings for missing/null phase');
});

// ── Columns with phase field ────────────────────────────────────────────────
test('normalizeConfig on a column with a valid phase keeps it', () => {
  const raw = defaultConfig();
  raw.columns[1].phase = 'review'; // defining column → review phase
  const cfg = normalizeConfig(raw);

  const defining = cfg.columns.find((c) => c.status === 'defining');
  assert.equal(defining.phase, 'review', 'phase preserved on column');
});

test('normalizeConfig normalizes invalid column phase to null with warning', () => {
  const raw = defaultConfig();
  raw.columns[1].phase = 'deploy'; // invalid
  const cfg = normalizeConfig(raw);

  const defining = cfg.columns.find((c) => c.status === 'defining');
  assert.equal(defining.phase, null, 'invalid phase reset to null');
  assert.ok(cfg.warnings.some((w) => /phase/.test(w)), 'warning about phase');
});

test('defaultConfig system columns start with phase: null', () => {
  const cfg = defaultConfig();
  for (const col of cfg.columns) {
    assert.equal(col.phase, null, `${col.status} starts with phase null`);
  }
});

test('normalizeConfig adds phase field to columns if missing', () => {
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
    skill: {},
  };
  const cfg = normalizeConfig(raw);

  for (const col of cfg.columns) {
    assert.ok(Object.prototype.hasOwnProperty.call(col, 'phase'), `${col.status} has phase field`);
    assert.equal(col.phase, null, `${col.status} phase is null`);
  }
});

// ── serializeConfig: round-trip ─────────────────────────────────────────────
test('serializeConfig round-trips a valid config with skill.phases', () => {
  const cfg = defaultConfig();
  cfg.skill.phases.plan.order = 5;
  cfg.columns[1].phase = 'review';

  const serialized = serializeConfig(cfg);
  const parsed = JSON.parse(serialized);

  assert.equal(parsed.skill.phases.plan.order, 5);
  assert.equal(parsed.columns[1].phase, 'review');
});

test('serializeConfig produces byte-stable idempotent output', () => {
  const cfg = defaultConfig();
  const s1 = serializeConfig(cfg);
  const s2 = serializeConfig(cfg);

  assert.equal(s1, s2, 'serialized output is idempotent');
});

test('serializeConfig strips the transient warnings field', () => {
  const cfg = normalizeConfig({ version: 1, columns: [], skill: {} });
  assert.ok(Array.isArray(cfg.warnings), 'normalizeConfig adds warnings');

  const serialized = serializeConfig(cfg);
  const parsed = JSON.parse(serialized);

  assert.equal(parsed.warnings, undefined, 'warnings stripped from serialized output');
});

test('serializeConfig preserves unknown top-level and skill fields', () => {
  const cfg = defaultConfig();
  cfg.experimentalFlag = { nested: true };
  cfg.skill.unknownSkillField = 'kept';

  const serialized = serializeConfig(cfg);
  const parsed = JSON.parse(serialized);

  assert.deepEqual(parsed.experimentalFlag, { nested: true });
  assert.equal(parsed.skill.unknownSkillField, 'kept');
});

// ── validateNewColumn: unchanged behaviour ──────────────────────────────────
test('validateNewColumn returns ok:true for a valid new column', () => {
  const cfg = defaultConfig();
  const result = validateNewColumn('UX Review', 'ux-review', cfg);

  assert.equal(result.ok, true);
  assert.equal(result.slug, 'ux-review');
  assert.equal(result.error, null);
});

test('validateNewColumn does not require or default phase', () => {
  const cfg = defaultConfig();
  const result = validateNewColumn('Custom Column', 'custom', cfg);

  // The validation passes; phase is not part of the validation
  assert.equal(result.ok, true);
});

// ── Column phase serialization order ───────────────────────────────────────
test('Columns include phase field and it serializes in canonical order', () => {
  const cfg = defaultConfig();
  const col = cfg.columns[0];
  assert.ok(Object.prototype.hasOwnProperty.call(col, 'phase'), 'phase field present on column');

  // Verify order by serializing and checking key position
  const serialized = serializeConfig(cfg);
  const parsed = JSON.parse(serialized);
  const keys = Object.keys(parsed.columns[0]);
  const phaseIdx = keys.indexOf('phase');
  const systemIdx = keys.indexOf('system');
  assert.ok(phaseIdx >= 0, 'phase present in serialized column');
  assert.ok(phaseIdx > systemIdx, 'phase comes after system in serialized order');
});

// ── Edge cases: junk input ──────────────────────────────────────────────────
test('normalizeConfig with missing skill.phases defaults to all four phases', () => {
  const raw = {
    version: 1,
    columns: defaultConfig().columns,
    skill: { concurrencyDefault: 3 }, // no phases
  };
  const cfg = normalizeConfig(raw);

  assert.ok(cfg.skill.phases);
  assert.deepEqual(Object.keys(cfg.skill.phases).sort(), ['build', 'plan', 'review', 'test']);
});

test('normalizeConfig with skill.phases as non-object defaults and warns', () => {
  const raw = {
    version: 1,
    columns: defaultConfig().columns,
    skill: { phases: 'not an object' },
  };
  const cfg = normalizeConfig(raw);

  assert.deepEqual(Object.keys(cfg.skill.phases).sort(), ['build', 'plan', 'review', 'test']);
  assert.ok(cfg.warnings.some((w) => /phases.*not an object/.test(w)), 'warning about non-object phases');
});

test('normalizeConfig with no skill object creates defaults', () => {
  const raw = {
    version: 1,
    columns: defaultConfig().columns,
  };
  const cfg = normalizeConfig(raw);

  assert.ok(cfg.skill.phases);
  for (const key of PHASE_KEYS) {
    assert.ok(cfg.skill.phases[key]);
  }
});
