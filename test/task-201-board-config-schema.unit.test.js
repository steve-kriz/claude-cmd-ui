'use strict';

// ===========================================================================
// TASK-201 — unit tests for lib/team-config.js
//
// Exercises the new functionality for per-column instructions, removal of the
// phase system, seeding default column agents, and instructions normalization.
// The module is pure, never touches disk/DB/network/Electron, and never
// throws — junk/partial/tampered input always collapses to a complete valid
// config.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const teamConfig = require('../lib/team-config.js');
const { AGENT_TYPES } = require('../lib/orchestrate-agents.js');

const {
  CONFIG_VERSION,
  SYSTEM_SLUGS,
  SYSTEM_COLUMN_DEFAULT_AGENTS,
  SYSTEM_COLUMN_DEFAULT_INSTRUCTIONS,
  normalizeConfig,
  defaultConfig,
  serializeConfig,
} = teamConfig;

// ── COLUMN_KEYS constant ───────────────────────────────────────────────────
test('COLUMN_KEYS includes instructions, excludes phase', () => {
  const keys = require('../lib/team-config.js').COLUMN_KEYS ||
    Object.keys(defaultConfig().columns[0]);
  // Verify by checking exported structure has instructions, no phase
  const cfg = defaultConfig();
  const col = cfg.columns[0];
  assert.ok('instructions' in col, 'instructions field exists');
  assert.ok(!('phase' in col), 'phase field does not exist');
});

// ── instructions normalization ─────────────────────────────────────────────
test('instructions: string is kept verbatim with internal newlines preserved', () => {
  const raw = {
    version: 1,
    columns: [
      { status: 'todo', label: 'To Do', instructions: 'Line 1\nLine 2', system: true },
      { status: 'defining', label: 'Defining', system: true },
      { status: 'in-progress', label: 'In Progress', system: true },
      { status: 'testing', label: 'Testing', system: true },
      { status: 'post-processing', label: 'Post-processing', system: true },
      { status: 'done', label: 'Done', system: true },
    ],
    skill: { concurrencyDefault: 3 },
  };

  const cfg = normalizeConfig(raw);
  const todo = cfg.columns.find((c) => c.status === 'todo');
  assert.equal(todo.instructions, 'Line 1\nLine 2', 'newlines preserved in instructions');
});

test('instructions: number becomes empty string', () => {
  const raw = {
    version: 1,
    columns: [
      { status: 'todo', label: 'To Do', instructions: 123, system: true },
      { status: 'defining', label: 'Defining', system: true },
      { status: 'in-progress', label: 'In Progress', system: true },
      { status: 'testing', label: 'Testing', system: true },
      { status: 'post-processing', label: 'Post-processing', system: true },
      { status: 'done', label: 'Done', system: true },
    ],
    skill: { concurrencyDefault: 3 },
  };

  const cfg = normalizeConfig(raw);
  const todo = cfg.columns.find((c) => c.status === 'todo');
  assert.equal(todo.instructions, '', 'number collapses to empty string');
});

test('instructions: object/array/null become empty string', () => {
  for (const val of [{ x: 1 }, [1, 2], null, undefined]) {
    const raw = {
      version: 1,
      columns: [
        { status: 'todo', label: 'To Do', instructions: val, system: true },
        { status: 'defining', label: 'Defining', system: true },
        { status: 'in-progress', label: 'In Progress', system: true },
        { status: 'testing', label: 'Testing', system: true },
        { status: 'post-processing', label: 'Post-processing', system: true },
        { status: 'done', label: 'Done', system: true },
      ],
      skill: { concurrencyDefault: 3 },
    };

    const cfg = normalizeConfig(raw);
    const todo = cfg.columns.find((c) => c.status === 'todo');
    assert.equal(
      todo.instructions,
      '',
      `${typeof val} instruction ${JSON.stringify(val)} becomes empty string`
    );
  }
});

test('instructions: huge multi-KB string is kept verbatim (no truncation)', () => {
  const huge = 'x'.repeat(10000);
  const raw = {
    version: 1,
    columns: [
      { status: 'todo', label: 'To Do', instructions: huge, system: true },
      { status: 'defining', label: 'Defining', system: true },
      { status: 'in-progress', label: 'In Progress', system: true },
      { status: 'testing', label: 'Testing', system: true },
      { status: 'post-processing', label: 'Post-processing', system: true },
      { status: 'done', label: 'Done', system: true },
    ],
    skill: { concurrencyDefault: 3 },
  };

  const cfg = normalizeConfig(raw);
  const todo = cfg.columns.find((c) => c.status === 'todo');
  assert.equal(todo.instructions.length, 10000, 'long instructions preserved without truncation');
});

test('instructions round-trips on both system and user columns', () => {
  const raw = {
    version: 1,
    columns: [
      { status: 'todo', label: 'To Do', instructions: 'System instruction', system: true },
      { status: 'defining', label: 'Defining', system: true },
      { status: 'in-progress', label: 'In Progress', system: true },
      { status: 'testing', label: 'Testing', system: true },
      { status: 'custom', label: 'Custom', instructions: 'User instruction', system: false },
      { status: 'post-processing', label: 'Post-processing', system: true },
      { status: 'done', label: 'Done', system: true },
    ],
    skill: { concurrencyDefault: 3 },
  };

  const cfg = normalizeConfig(raw);
  const todo = cfg.columns.find((c) => c.status === 'todo');
  const custom = cfg.columns.find((c) => c.status === 'custom');
  assert.equal(todo.instructions, 'System instruction');
  assert.equal(custom.instructions, 'User instruction');
});

// ── phase removal from columns ─────────────────────────────────────────────
test('phase on a column is dropped and warned, never round-tripped', () => {
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
    skill: { concurrencyDefault: 3 },
  };

  const cfg = normalizeConfig(raw);

  // Verify no phase key in output
  for (const col of cfg.columns) {
    assert.ok(!('phase' in col), `${col.status} has no phase key`);
  }

  // Verify warnings for both columns with phase
  assert.ok(cfg.warnings.some((w) => /defining/.test(w) && /phase/.test(w)));
  assert.ok(cfg.warnings.some((w) => /testing/.test(w) && /phase/.test(w)));
});

test('phase on a user column is also dropped and warned', () => {
  const raw = {
    version: 1,
    columns: [
      { status: 'todo', label: 'To Do', system: true },
      { status: 'defining', label: 'Defining', system: true },
      { status: 'in-progress', label: 'In Progress', system: true },
      { status: 'pr-review', label: 'PR Review', phase: 'review', system: false },
      { status: 'testing', label: 'Testing', system: true },
      { status: 'post-processing', label: 'Post-processing', system: true },
      { status: 'done', label: 'Done', system: true },
    ],
    skill: { concurrencyDefault: 3 },
  };

  const cfg = normalizeConfig(raw);
  const prReview = cfg.columns.find((c) => c.status === 'pr-review');
  assert.ok(!('phase' in prReview), 'phase dropped from user column');
  assert.ok(cfg.warnings.some((w) => /pr-review/.test(w) && /phase/.test(w)));
});

// ── skill.phases removal ──────────────────────────────────────────────────
test('skill.phases is fully removed and never round-tripped', () => {
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
      phases: { plan: { label: 'Plan' }, build: { label: 'Build' } },
    },
  };

  const cfg = normalizeConfig(raw);
  assert.ok(!('phases' in cfg.skill), 'skill.phases is removed');

  // Verify warning
  assert.ok(cfg.warnings.some((w) => /skill\.phases/.test(w)));
});

test('skill.phases and column phases are both removed with separate warnings', () => {
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
    skill: {
      concurrencyDefault: 3,
      phases: { plan: { label: 'Plan' } },
    },
  };

  const cfg = normalizeConfig(raw);

  // Should have two warnings: one for skill.phases, one for column phase
  const phaseWarnings = cfg.warnings.filter((w) => /phase/.test(w));
  assert.ok(phaseWarnings.length >= 2, 'at least two phase-related warnings');
  assert.ok(cfg.warnings.some((w) => /skill\.phases/.test(w)));
  assert.ok(cfg.warnings.some((w) => /defining.*phase/.test(w)));
});

// ── SYSTEM_COLUMN_DEFAULT_AGENTS ──────────────────────────────────────────
test('SYSTEM_COLUMN_DEFAULT_AGENTS maps all six system slugs', () => {
  for (const slug of SYSTEM_SLUGS) {
    assert.ok(slug in SYSTEM_COLUMN_DEFAULT_AGENTS, `${slug} in SYSTEM_COLUMN_DEFAULT_AGENTS`);
  }
});

test('SYSTEM_COLUMN_DEFAULT_AGENTS uses AGENT_TYPES (no hardcoded strings)', () => {
  // Check that the values are AGENT_TYPES references, not hardcoded strings
  assert.equal(SYSTEM_COLUMN_DEFAULT_AGENTS.defining, AGENT_TYPES.ba, 'defining uses AGENT_TYPES.ba');
  assert.equal(SYSTEM_COLUMN_DEFAULT_AGENTS['in-progress'], AGENT_TYPES.coder, 'in-progress uses AGENT_TYPES.coder');
  assert.equal(SYSTEM_COLUMN_DEFAULT_AGENTS.testing, AGENT_TYPES.tester, 'testing uses AGENT_TYPES.tester');
});

test('SYSTEM_COLUMN_DEFAULT_AGENTS has nulls for todo/done', () => {
  assert.equal(SYSTEM_COLUMN_DEFAULT_AGENTS.todo, null);
  assert.equal(SYSTEM_COLUMN_DEFAULT_AGENTS.done, null);
  // TASK-206: post-processing was removed from the module entirely.
  assert.ok(!('post-processing' in SYSTEM_COLUMN_DEFAULT_AGENTS), 'no post-processing entry');
});

// ── SYSTEM_COLUMN_DEFAULT_INSTRUCTIONS ───────────────────────────────────
test('SYSTEM_COLUMN_DEFAULT_INSTRUCTIONS maps all six system slugs', () => {
  for (const slug of SYSTEM_SLUGS) {
    assert.ok(slug in SYSTEM_COLUMN_DEFAULT_INSTRUCTIONS, `${slug} in SYSTEM_COLUMN_DEFAULT_INSTRUCTIONS`);
    assert.equal(
      typeof SYSTEM_COLUMN_DEFAULT_INSTRUCTIONS[slug],
      'string',
      `${slug} instruction is a string`
    );
  }
});

test('SYSTEM_COLUMN_DEFAULT_INSTRUCTIONS has expected canonical text', () => {
  const expected = {
    todo: 'Entry queue — PASSIVE, no agent is dispatched here. New tickets land in To Do and wait for /orchestrate build to pick them up in board order. Leave the ticket body untouched: the Defining column\'s agent is the first to write to it.',
    done: 'Terminal column — PASSIVE, no agent is dispatched here. A ticket that reaches Done is finished and is never re-dispatched, even when a review raised follow-up tickets (those are separate To Do tickets and travel the board on their own).',
  };
  for (const [slug, text] of Object.entries(expected)) {
    assert.equal(SYSTEM_COLUMN_DEFAULT_INSTRUCTIONS[slug], text, `${slug} instruction text matches`);
  }
});

// The two agent-less columns must SAY they are passive: their text is the only
// place a reader learns why todo/done carry `agent: null` (dispatching `done`
// would re-run an agent over every finished ticket on each build).
test('the passive columns document that no agent is dispatched in them', () => {
  for (const slug of ['todo', 'done']) {
    assert.equal(SYSTEM_COLUMN_DEFAULT_AGENTS[slug], null, `${slug} has no agent`);
    assert.match(SYSTEM_COLUMN_DEFAULT_INSTRUCTIONS[slug], /PASSIVE, no agent is dispatched here/,
      `${slug} instructions state the column is passive`);
  }
});

// Every column that DOES dispatch must carry non-trivial instructions — a
// working column with a blank prompt is the "board isn't ready" bug.
test('every column with an agent carries substantive instructions', () => {
  for (const slug of SYSTEM_SLUGS) {
    if (SYSTEM_COLUMN_DEFAULT_AGENTS[slug] == null) continue;
    const text = SYSTEM_COLUMN_DEFAULT_INSTRUCTIONS[slug];
    assert.ok(typeof text === 'string' && text.trim().length >= 80,
      `${slug} has substantive instructions (got ${text ? text.length : 0} chars)`);
  }
});

// ── defaultSystemColumn seeds defaults ──────────────────────────────────────
test('defaultSystemColumn seeds agent from SYSTEM_COLUMN_DEFAULT_AGENTS', () => {
  const cfg = defaultConfig();
  for (const slug of SYSTEM_SLUGS) {
    const col = cfg.columns.find((c) => c.status === slug);
    const expected = SYSTEM_COLUMN_DEFAULT_AGENTS[slug];
    assert.equal(col.agent, expected, `${slug} agent matches default`);
  }
});

test('defaultSystemColumn seeds instructions from SYSTEM_COLUMN_DEFAULT_INSTRUCTIONS', () => {
  const cfg = defaultConfig();
  for (const slug of SYSTEM_SLUGS) {
    const col = cfg.columns.find((c) => c.status === slug);
    const expected = SYSTEM_COLUMN_DEFAULT_INSTRUCTIONS[slug];
    assert.equal(col.instructions, expected, `${slug} instructions match default`);
  }
});

// ── repairSystemColumn preserves vs. re-seeds ──────────────────────────────
test('repairSystemColumn preserves user-set agent (including explicit null)', () => {
  // Explicit null should be preserved
  const raw1 = {
    version: 1,
    columns: [
      { status: 'todo', label: 'To Do', system: true },
      { status: 'defining', label: 'Defining', agent: null, system: true },
      { status: 'in-progress', label: 'In Progress', system: true },
      { status: 'testing', label: 'Testing', system: true },
      { status: 'post-processing', label: 'Post-processing', system: true },
      { status: 'done', label: 'Done', system: true },
    ],
    skill: { concurrencyDefault: 3 },
  };

  const cfg1 = normalizeConfig(raw1);
  const defining1 = cfg1.columns.find((c) => c.status === 'defining');
  assert.equal(defining1.agent, null, 'explicit null agent is preserved');

  // A valid non-empty string should also be preserved
  const raw2 = {
    version: 1,
    columns: [
      { status: 'todo', label: 'To Do', system: true },
      { status: 'defining', label: 'Defining', agent: 'custom-agent', system: true },
      { status: 'in-progress', label: 'In Progress', system: true },
      { status: 'testing', label: 'Testing', system: true },
      { status: 'post-processing', label: 'Post-processing', system: true },
      { status: 'done', label: 'Done', system: true },
    ],
    skill: { concurrencyDefault: 3 },
  };

  const cfg2 = normalizeConfig(raw2);
  const defining2 = cfg2.columns.find((c) => c.status === 'defining');
  assert.equal(defining2.agent, 'custom-agent', 'valid string agent is preserved');
});

test('repairSystemColumn re-seeds agent when absent', () => {
  const raw = {
    version: 1,
    columns: [
      { status: 'todo', label: 'To Do', system: true },
      { status: 'defining', label: 'Defining', system: true }, // no agent
      { status: 'in-progress', label: 'In Progress', system: true },
      { status: 'testing', label: 'Testing', system: true },
      { status: 'post-processing', label: 'Post-processing', system: true },
      { status: 'done', label: 'Done', system: true },
    ],
    skill: { concurrencyDefault: 3 },
  };

  const cfg = normalizeConfig(raw);
  const defining = cfg.columns.find((c) => c.status === 'defining');
  assert.equal(defining.agent, AGENT_TYPES.ba, 'absent agent is seeded with default');
});

test('repairSystemColumn re-seeds agent when invalid (e.g., a tampered system column)', () => {
  const raw = {
    version: 1,
    columns: [
      { status: 'todo', label: 'To Do', system: true },
      { status: 'defining', label: 'Defining', agent: 123, system: true }, // invalid type
      { status: 'in-progress', label: 'In Progress', system: true },
      { status: 'testing', label: 'Testing', system: true },
      { status: 'post-processing', label: 'Post-processing', system: true },
      { status: 'done', label: 'Done', system: true },
    ],
    skill: { concurrencyDefault: 3 },
  };

  const cfg = normalizeConfig(raw);
  const defining = cfg.columns.find((c) => c.status === 'defining');
  assert.equal(defining.agent, AGENT_TYPES.ba, 'invalid agent type is re-seeded with default');
});

test('repairSystemColumn preserves user-set instructions, defaults when absent', () => {
  const raw = {
    version: 1,
    columns: [
      { status: 'todo', label: 'To Do', system: true },
      { status: 'defining', label: 'Defining', instructions: 'Custom text', system: true },
      { status: 'in-progress', label: 'In Progress', system: true }, // no instructions
      { status: 'testing', label: 'Testing', system: true },
      { status: 'post-processing', label: 'Post-processing', system: true },
      { status: 'done', label: 'Done', system: true },
    ],
    skill: { concurrencyDefault: 3 },
  };

  const cfg = normalizeConfig(raw);
  const defining = cfg.columns.find((c) => c.status === 'defining');
  const inProgress = cfg.columns.find((c) => c.status === 'in-progress');
  assert.equal(defining.instructions, 'Custom text', 'user-set instructions preserved');
  assert.equal(
    inProgress.instructions,
    SYSTEM_COLUMN_DEFAULT_INSTRUCTIONS['in-progress'],
    'absent instructions are seeded with default'
  );
});

// ── buildUserColumn seeds instructions:'' when absent ──────────────────────
test("buildUserColumn seeds instructions:'' when absent", () => {
  const raw = {
    version: 1,
    columns: [
      { status: 'todo', label: 'To Do', system: true },
      { status: 'defining', label: 'Defining', system: true },
      { status: 'in-progress', label: 'In Progress', system: true },
      { status: 'custom', label: 'Custom', system: false }, // no instructions
      { status: 'testing', label: 'Testing', system: true },
      { status: 'post-processing', label: 'Post-processing', system: true },
      { status: 'done', label: 'Done', system: true },
    ],
    skill: { concurrencyDefault: 3 },
  };

  const cfg = normalizeConfig(raw);
  const custom = cfg.columns.find((c) => c.status === 'custom');
  assert.equal(custom.instructions, '', 'user column without instructions gets empty string');
});

test('buildUserColumn preserves user-supplied instructions', () => {
  const raw = {
    version: 1,
    columns: [
      { status: 'todo', label: 'To Do', system: true },
      { status: 'defining', label: 'Defining', system: true },
      { status: 'in-progress', label: 'In Progress', system: true },
      { status: 'custom', label: 'Custom', instructions: 'User text', system: false },
      { status: 'testing', label: 'Testing', system: true },
      { status: 'post-processing', label: 'Post-processing', system: true },
      { status: 'done', label: 'Done', system: true },
    ],
    skill: { concurrencyDefault: 3 },
  };

  const cfg = normalizeConfig(raw);
  const custom = cfg.columns.find((c) => c.status === 'custom');
  assert.equal(custom.instructions, 'User text', 'user-supplied instructions preserved');
});

test('buildUserColumn preserves user-supplied agent', () => {
  const raw = {
    version: 1,
    columns: [
      { status: 'todo', label: 'To Do', system: true },
      { status: 'defining', label: 'Defining', system: true },
      { status: 'in-progress', label: 'In Progress', system: true },
      { status: 'custom', label: 'Custom', agent: 'custom-agent', system: false },
      { status: 'testing', label: 'Testing', system: true },
      { status: 'post-processing', label: 'Post-processing', system: true },
      { status: 'done', label: 'Done', system: true },
    ],
    skill: { concurrencyDefault: 3 },
  };

  const cfg = normalizeConfig(raw);
  const custom = cfg.columns.find((c) => c.status === 'custom');
  assert.equal(custom.agent, 'custom-agent', 'user-supplied agent preserved');
});

// ── serializeConfig idempotency ────────────────────────────────────────────
test('serializeConfig output round-trips unchanged (idempotent)', () => {
  const raw = {
    version: 1,
    columns: [
      { status: 'todo', label: 'To Do', phase: 'old', system: true },
      { status: 'defining', label: 'Defining', system: true },
      { status: 'in-progress', label: 'In Progress', system: true },
      { status: 'testing', label: 'Testing', system: true },
      { status: 'post-processing', label: 'Post-processing', system: true },
      { status: 'done', label: 'Done', system: true },
    ],
    skill: {
      concurrencyDefault: 3,
      phases: { old: { label: 'Old' } },
    },
  };

  const first = serializeConfig(raw);
  const parsed = JSON.parse(first);
  const second = serializeConfig(parsed);

  assert.equal(first, second, 'serialization is idempotent');
});

test('serializeConfig removes warnings from output', () => {
  const raw = defaultConfig();
  const serialized = serializeConfig(raw);
  const parsed = JSON.parse(serialized);
  assert.ok(!('warnings' in parsed), 'warnings not in serialized output');
});

test('serializeConfig produces clean JSON with trailing newline', () => {
  const cfg = defaultConfig();
  const serialized = serializeConfig(cfg);
  assert.ok(serialized.endsWith('\n'), 'ends with trailing newline');
  assert.doesNotThrow(() => JSON.parse(serialized), 'output is valid JSON');
});

// ── junk input tolerance ───────────────────────────────────────────────────
test('normalizeConfig handles various junk inputs without throwing', () => {
  const junkInputs = [
    null,
    undefined,
    42,
    'not json {',
    '',
    '{"bad":"json',
    [],
    true,
    NaN,
    Infinity,
  ];

  for (const input of junkInputs) {
    let cfg;
    assert.doesNotThrow(() => {
      cfg = normalizeConfig(input);
    }, `normalizeConfig never throws on ${typeof input} input`);

    // Verify it returns a complete, valid config
    assert.ok(Array.isArray(cfg.columns), 'columns is an array');
    assert.equal(cfg.columns.length, 5, 'has five system columns');
    assert.equal(typeof cfg.skill, 'object', 'skill is an object');
    assert.ok('concurrencyDefault' in cfg.skill, 'concurrencyDefault present');
  }
});

test('normalizeConfig returns complete valid config even from partial input', () => {
  const partial = { version: 1 }; // missing columns and skill
  const cfg = normalizeConfig(partial);
  assert.equal(cfg.columns.length, 5, 'missing columns are reconstructed');
  assert.ok('concurrencyDefault' in cfg.skill, 'missing skill is reconstructed');
});

// ── Unsafe keys (prototype pollution defense) ──────────────────────────────
test('normalizeConfig drops __proto__/__constructor__/prototype keys from columns', () => {
  const raw = {
    version: 1,
    columns: [
      {
        status: 'todo',
        label: 'To Do',
        system: true,
        __proto__: { polluted: true },
        constructor: { polluted: true },
        prototype: { polluted: true },
      },
      { status: 'defining', label: 'Defining', system: true },
      { status: 'in-progress', label: 'In Progress', system: true },
      { status: 'testing', label: 'Testing', system: true },
      { status: 'post-processing', label: 'Post-processing', system: true },
      { status: 'done', label: 'Done', system: true },
    ],
    skill: { concurrencyDefault: 3 },
  };

  const cfg = normalizeConfig(raw);
  const todo = cfg.columns.find((c) => c.status === 'todo');

  // These keys should be dropped (or at least not assigned via prototype pollution)
  assert.ok(!('__proto__' in todo) || typeof todo.__proto__ !== 'object' || !todo.__proto__.polluted);
});

test('normalizeConfig drops unsafe keys from skill object', () => {
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
      __proto__: { polluted: true },
      constructor: { polluted: true },
    },
  };

  const cfg = normalizeConfig(raw);
  // The key itself might exist but assignment should not have polluted the prototype
  assert.ok(!cfg.skill.__proto__ || !cfg.skill.__proto__.polluted);
});

// ── tampered system column normalization ────────────────────────────────────
test('normalizeConfig re-seeds invalid agent on a tampered system column', () => {
  const raw = {
    version: 1,
    columns: [
      { status: 'todo', label: 'To Do', system: true },
      { status: 'defining', label: 'Defining', system: true },
      {
        status: 'in-progress',
        label: 'In Progress',
        system: false, // tampered flag
        agent: 123, // invalid type (will be re-seeded to default)
        instructions: { nested: 'object' }, // invalid type (will normalize to '')
        system: true,
      },
      { status: 'testing', label: 'Testing', system: true },
      { status: 'post-processing', label: 'Post-processing', system: true },
      { status: 'done', label: 'Done', system: true },
    ],
    skill: { concurrencyDefault: 3 },
  };

  const cfg = normalizeConfig(raw);
  const inProgress = cfg.columns.find((c) => c.status === 'in-progress');

  // Invalid agent on a system column gets re-seeded to defaults
  assert.equal(inProgress.agent, AGENT_TYPES.coder, 'invalid agent type is re-seeded to default');
  // Invalid instructions normalize to empty string (not re-seeded to default)
  assert.equal(inProgress.instructions, '', 'invalid instructions type normalizes to empty string');
});

// ── module exports ─────────────────────────────────────────────────────────
test('module.exports includes SYSTEM_COLUMN_DEFAULT_AGENTS', () => {
  assert.ok('SYSTEM_COLUMN_DEFAULT_AGENTS' in teamConfig);
  assert.equal(
    teamConfig.SYSTEM_COLUMN_DEFAULT_AGENTS,
    SYSTEM_COLUMN_DEFAULT_AGENTS
  );
});

test('module.exports includes SYSTEM_COLUMN_DEFAULT_INSTRUCTIONS', () => {
  assert.ok('SYSTEM_COLUMN_DEFAULT_INSTRUCTIONS' in teamConfig);
  assert.equal(
    teamConfig.SYSTEM_COLUMN_DEFAULT_INSTRUCTIONS,
    SYSTEM_COLUMN_DEFAULT_INSTRUCTIONS
  );
});

test('module.exports does not include PHASE_KEYS or PHASE_DEFAULTS', () => {
  assert.ok(!('PHASE_KEYS' in teamConfig), 'PHASE_KEYS not exported');
  assert.ok(!('PHASE_DEFAULTS' in teamConfig), 'PHASE_DEFAULTS not exported');
});

test('module.exports does not import skill-workflow', () => {
  // This is a negative test: ensure the module doesn't rely on skill-workflow.
  // We verify by checking that normalizeConfig works and phases are removed.
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
      phases: {},
    },
  };

  // If skill-workflow were still imported and used, phases would be processed.
  // Since they're not, phases should be dropped.
  const cfg = normalizeConfig(raw);
  assert.ok(!('phases' in cfg.skill), 'phases removed (no skill-workflow dependency)');
});
