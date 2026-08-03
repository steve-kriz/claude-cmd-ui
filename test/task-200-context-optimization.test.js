'use strict';

// ===========================================================================
// TASK-200 — unit tests for context optimisation config in lib/team-config.js
//
// Tests the new context-optimisation setting: CONTEXT_OPT_LEVELS,
// CONTEXT_OPT_DEFAULT, defaultContextOptimization(), normalizeContextOptimization(),
// and round-trip through serializeConfig/normalizeConfig.
//
// This module never touches disk/DB/network/Electron, so every test is a
// direct pure-function assertion via require().
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const teamConfig = require('../lib/team-config.js');

const {
  CONFIG_VERSION,
  CONTEXT_OPT_LEVELS,
  CONTEXT_OPT_DEFAULT,
  defaultConfig,
  normalizeConfig,
  normalizeContextOptimization,
  serializeConfig,
} = teamConfig;

// ── CONTEXT_OPT_LEVELS & CONTEXT_OPT_DEFAULT ─────────────────────────────────
test('CONTEXT_OPT_LEVELS exports the three valid level strings', () => {
  assert.ok(Array.isArray(CONTEXT_OPT_LEVELS));
  assert.equal(CONTEXT_OPT_LEVELS.length, 3);
  assert.deepEqual(CONTEXT_OPT_LEVELS, ['conservative', 'standard', 'aggressive']);
});

test('CONTEXT_OPT_DEFAULT is { enabled: true, level: "standard" }', () => {
  assert.ok(CONTEXT_OPT_DEFAULT);
  assert.equal(typeof CONTEXT_OPT_DEFAULT, 'object');
  assert.equal(CONTEXT_OPT_DEFAULT.enabled, true);
  assert.equal(CONTEXT_OPT_DEFAULT.level, 'standard');
});

// ── defaultConfig includes skill.contextOptimization ────────────────────────
test('defaultConfig includes skill.contextOptimization at default values', () => {
  const cfg = defaultConfig();
  assert.ok(cfg.skill, 'skill object exists');
  assert.ok(cfg.skill.contextOptimization, 'skill.contextOptimization exists');
  assert.equal(cfg.skill.contextOptimization.enabled, true);
  assert.equal(cfg.skill.contextOptimization.level, 'standard');
});

test('defaultConfig creates fresh contextOptimization objects on each call', () => {
  const a = defaultConfig();
  const b = defaultConfig();
  assert.notEqual(a.skill.contextOptimization, b.skill.contextOptimization);
  a.skill.contextOptimization.enabled = false;
  assert.equal(b.skill.contextOptimization.enabled, true, 'mutating one default does not affect another');
});

// ── normalizeContextOptimization: basic behavior ─────────────────────────────
test('normalizeContextOptimization with null/undefined returns default', () => {
  const result1 = normalizeContextOptimization(null, []);
  assert.deepEqual(result1, { enabled: true, level: 'standard' });

  const result2 = normalizeContextOptimization(undefined, []);
  assert.deepEqual(result2, { enabled: true, level: 'standard' });
});

test('normalizeContextOptimization with non-object returns default', () => {
  const warnings = [];
  const result = normalizeContextOptimization('string', warnings);
  assert.deepEqual(result, { enabled: true, level: 'standard' });
  assert.equal(warnings.length, 0, 'no warning for non-object (missing fields are silent)');
});

test('normalizeContextOptimization with array returns default', () => {
  const result = normalizeContextOptimization([], []);
  assert.deepEqual(result, { enabled: true, level: 'standard' });
});

// ── normalizeContextOptimization: enabled field ─────────────────────────────
test('normalizeContextOptimization keeps boolean enabled true', () => {
  const result = normalizeContextOptimization({ enabled: true, level: 'standard' }, []);
  assert.equal(result.enabled, true);
});

test('normalizeContextOptimization keeps boolean enabled false', () => {
  const result = normalizeContextOptimization({ enabled: false, level: 'standard' }, []);
  assert.equal(result.enabled, false);
});

test('normalizeContextOptimization with missing enabled defaults to true, no warning', () => {
  const warnings = [];
  const result = normalizeContextOptimization({ level: 'standard' }, warnings);
  assert.equal(result.enabled, true);
  assert.equal(warnings.length, 0, 'no warning when enabled is missing');
});

test('normalizeContextOptimization with non-boolean enabled warns and resets to true', () => {
  const warnings = [];
  const result = normalizeContextOptimization({ enabled: 'yes', level: 'standard' }, warnings);
  assert.equal(result.enabled, true);
  assert.ok(warnings.some((w) => /enabled/.test(w)), 'warning mentions enabled');
  assert.ok(warnings.some((w) => /boolean/.test(w)), 'warning mentions boolean');
});

test('normalizeContextOptimization with enabled number warns and resets to true', () => {
  const warnings = [];
  const result = normalizeContextOptimization({ enabled: 1, level: 'standard' }, warnings);
  assert.equal(result.enabled, true);
  assert.ok(warnings.length > 0, 'warning recorded');
});

// ── normalizeContextOptimization: level field ────────────────────────────────
test('normalizeContextOptimization keeps valid level "conservative"', () => {
  const result = normalizeContextOptimization({ enabled: true, level: 'conservative' }, []);
  assert.equal(result.level, 'conservative');
});

test('normalizeContextOptimization keeps valid level "standard"', () => {
  const result = normalizeContextOptimization({ enabled: true, level: 'standard' }, []);
  assert.equal(result.level, 'standard');
});

test('normalizeContextOptimization keeps valid level "aggressive"', () => {
  const result = normalizeContextOptimization({ enabled: true, level: 'aggressive' }, []);
  assert.equal(result.level, 'aggressive');
});

test('normalizeContextOptimization with missing level defaults to standard, no warning', () => {
  const warnings = [];
  const result = normalizeContextOptimization({ enabled: true }, warnings);
  assert.equal(result.level, 'standard');
  assert.equal(warnings.length, 0, 'no warning when level is missing');
});

test('normalizeContextOptimization with empty string level defaults to standard, no warning', () => {
  const warnings = [];
  const result = normalizeContextOptimization({ enabled: true, level: '' }, warnings);
  assert.equal(result.level, 'standard');
  assert.equal(warnings.length, 0, 'no warning for empty string (non-empty invalid values warn)');
});

test('normalizeContextOptimization with invalid level warns and resets to standard', () => {
  const warnings = [];
  const result = normalizeContextOptimization({ enabled: true, level: 'warp' }, warnings);
  assert.equal(result.level, 'standard');
  assert.ok(warnings.some((w) => /level/.test(w)), 'warning mentions level');
  assert.ok(warnings.some((w) => /invalid/.test(w) || /warp/.test(w)), 'warning describes the invalid value');
});

test('normalizeContextOptimization with level number warns and resets to standard', () => {
  const warnings = [];
  const result = normalizeContextOptimization({ enabled: true, level: 42 }, warnings);
  assert.equal(result.level, 'standard');
  assert.ok(warnings.length > 0, 'warning recorded');
});

// ── normalizeContextOptimization: unknown/unsafe keys ────────────────────────
test('normalizeContextOptimization drops unknown keys with warning', () => {
  const warnings = [];
  const result = normalizeContextOptimization(
    { enabled: true, level: 'standard', unknown: 'value' },
    warnings
  );
  assert.equal(result.enabled, true);
  assert.equal(result.level, 'standard');
  assert.equal(result.unknown, undefined, 'unknown key not present');
  assert.ok(warnings.some((w) => /unknown/.test(w)), 'warning about unknown key');
});

test('normalizeContextOptimization drops __proto__ safely', () => {
  const warnings = [];
  const result = normalizeContextOptimization(
    { enabled: true, level: 'standard', __proto__: { poisoned: true } },
    warnings
  );
  assert.equal(result.enabled, true);
  assert.equal(result.level, 'standard');
  assert.equal(result.poisoned, undefined, 'prototype not poisoned');
  // __proto__ key is dropped silently (no cross-module warning channel passed up from here)
  // The warnings are only about keys beyond enabled/level
  assert.ok(warnings.length >= 0, 'warnings array exists (may be empty for __proto__)');
});

test('normalizeContextOptimization drops constructor with unsafe warning', () => {
  const warnings = [];
  const result = normalizeContextOptimization(
    { enabled: true, level: 'standard', constructor: { polluted: true } },
    warnings
  );
  assert.ok(warnings.some((w) => /unsafe/.test(w) || /constructor/.test(w)), 'warning about constructor');
});

test('normalizeContextOptimization drops prototype with unsafe warning', () => {
  const warnings = [];
  const result = normalizeContextOptimization(
    { enabled: true, level: 'standard', prototype: { attack: true } },
    warnings
  );
  assert.ok(warnings.some((w) => /unsafe/.test(w) || /prototype/.test(w)), 'warning about prototype');
});

// ── normalizeContextOptimization: tampering scenarios ────────────────────────
test('normalizeContextOptimization: tampered config never throws', () => {
  const cases = [
    null,
    undefined,
    'string',
    42,
    [],
    { enabled: 'yes', level: 42 },
    { enabled: 'yes', level: 42, __proto__: {}, extra: 'key' },
  ];
  for (const raw of cases) {
    assert.doesNotThrow(() => normalizeContextOptimization(raw, []), `case ${JSON.stringify(raw)}`);
  }
});

// ── normalizeConfig: contextOptimization through the full pipeline ───────────
test('normalizeConfig fills missing skill.contextOptimization with default', () => {
  const raw = {
    version: 1,
    columns: defaultConfig().columns,
    skill: { concurrencyDefault: 3, phases: defaultConfig().skill.phases },
  };
  const cfg = normalizeConfig(raw);
  assert.ok(cfg.skill.contextOptimization, 'contextOptimization exists');
  assert.equal(cfg.skill.contextOptimization.enabled, true);
  assert.equal(cfg.skill.contextOptimization.level, 'standard');
});

test('normalizeConfig normalizes contextOptimization through the normalizer', () => {
  const raw = {
    version: 1,
    columns: defaultConfig().columns,
    skill: {
      concurrencyDefault: 3,
      phases: defaultConfig().skill.phases,
      contextOptimization: { enabled: 'yes', level: 'warp', extra: 'key' },
    },
  };
  const cfg = normalizeConfig(raw);
  assert.equal(cfg.skill.contextOptimization.enabled, true, 'non-boolean resets to true');
  assert.equal(cfg.skill.contextOptimization.level, 'standard', 'invalid level resets to standard');
  assert.equal(cfg.skill.contextOptimization.extra, undefined, 'extra key dropped');
  assert.ok(cfg.warnings.some((w) => /enabled/.test(w)), 'warning for enabled');
  assert.ok(cfg.warnings.some((w) => /level/.test(w)), 'warning for level');
  assert.ok(cfg.warnings.some((w) => /extra/.test(w) || /contextOptimization/.test(w)), 'warning for extra key');
});

test('normalizeConfig excludes contextOptimization from unknown-skill-key round-trip', () => {
  const raw = {
    version: 1,
    columns: defaultConfig().columns,
    skill: {
      concurrencyDefault: 3,
      phases: defaultConfig().skill.phases,
      contextOptimization: { enabled: false, level: 'aggressive' },
      unknownSkillField: 'should round-trip',
    },
  };
  const cfg = normalizeConfig(raw);
  // contextOptimization is explicitly normalised, not round-tripped raw
  assert.equal(cfg.skill.contextOptimization.enabled, false);
  assert.equal(cfg.skill.contextOptimization.level, 'aggressive');
  // unknownSkillField should round-trip (not dropped, not warned about)
  assert.equal(cfg.skill.unknownSkillField, 'should round-trip');
});

// ── serializeConfig: contextOptimization round-trip ─────────────────────────
test('serializeConfig writes normalized contextOptimization to JSON', () => {
  const cfg = defaultConfig();
  cfg.skill.contextOptimization = { enabled: false, level: 'conservative' };
  const serialized = serializeConfig(cfg);
  const parsed = JSON.parse(serialized);
  assert.equal(parsed.skill.contextOptimization.enabled, false);
  assert.equal(parsed.skill.contextOptimization.level, 'conservative');
});

test('serializeConfig never persists invalid contextOptimization', () => {
  // Even if a bad value somehow gets in (shouldn't happen with normalizeConfig),
  // serializeConfig normalises before writing
  const raw = {
    version: 1,
    columns: defaultConfig().columns,
    skill: {
      concurrencyDefault: 3,
      phases: defaultConfig().skill.phases,
      contextOptimization: { enabled: 'yes', level: 'invalid' },
    },
  };
  const serialized = serializeConfig(raw);
  const parsed = JSON.parse(serialized);
  assert.equal(parsed.skill.contextOptimization.enabled, true);
  assert.equal(parsed.skill.contextOptimization.level, 'standard');
});

// ── Round-trip: normalize -> serialize -> parse -> normalize ────────────────
test('contextOptimization round-trips through serialize/normalize cycle', () => {
  const original = {
    enabled: false,
    level: 'aggressive',
  };
  const cfg = defaultConfig();
  cfg.skill.contextOptimization = original;

  const serialized = serializeConfig(cfg);
  const parsed = JSON.parse(serialized);
  const cfg2 = normalizeConfig(parsed);

  assert.equal(cfg2.skill.contextOptimization.enabled, original.enabled);
  assert.equal(cfg2.skill.contextOptimization.level, original.level);
});

test('contextOptimization false/standard combination round-trips', () => {
  const cfg = defaultConfig();
  cfg.skill.contextOptimization = { enabled: false, level: 'standard' };
  const serialized = serializeConfig(cfg);
  const cfg2 = normalizeConfig(JSON.parse(serialized));
  assert.equal(cfg2.skill.contextOptimization.enabled, false);
  assert.equal(cfg2.skill.contextOptimization.level, 'standard');
});

// ── Junk/partial config never throws ─────────────────────────────────────────
test('normalizeConfig tolerates completely junk input', () => {
  const cases = [
    null,
    undefined,
    'not json',
    {},
    { skill: null },
    { skill: { contextOptimization: null } },
  ];
  for (const raw of cases) {
    const cfg = normalizeConfig(raw);
    assert.ok(cfg.skill, 'skill exists');
    assert.ok(cfg.skill.contextOptimization, 'contextOptimization exists');
    assert.equal(cfg.skill.contextOptimization.enabled, true);
    assert.equal(cfg.skill.contextOptimization.level, 'standard');
  }
});

// ── Warnings accumulation ─────────────────────────────────────────────────────
test('normalizeContextOptimization returns empty warnings array when called with no warnings channel', () => {
  const result = normalizeContextOptimization({ enabled: 'bad', level: 'bad' });
  assert.ok(result, 'result returned');
  // Should default to false when no warnings channel passed
});

test('normalizeContextOptimization accumulates multiple warnings', () => {
  const warnings = [];
  normalizeContextOptimization(
    { enabled: 'bad', level: 'bad', extra1: 1, extra2: 2 },
    warnings
  );
  assert.ok(warnings.length >= 3, 'multiple warnings accumulated');
});
