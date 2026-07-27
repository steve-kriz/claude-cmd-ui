'use strict';

// E2E cucumber-style tests for lib/telemetry-project-config.js.
// These tests implement the Gherkin scenarios from TASK-155 in Given/When/Then form.
// Mock ALL database calls; these are pure normalizer tests.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const config = require('../lib/telemetry-project-config');

// --- Scenario: Defaults for a brand-new project ---
test('Scenario: Defaults for a brand-new project', () => {
  // When defaultProjectTelemetryConfig() is called
  const result = config.defaultProjectTelemetryConfig();

  // Then it returns { version: 1, storeOnline: false }
  assert.equal(result.version, 1, 'version is 1');
  assert.equal(result.storeOnline, false, 'storeOnline is false');
  assert.deepEqual(result, { version: 1, storeOnline: false }, 'shape is exact');
});

// --- Scenario: A stored storeOnline true round-trips ---
test('Scenario: A stored storeOnline true round-trips', () => {
  // Given the raw object { version: 1, storeOnline: true }
  const raw = { version: 1, storeOnline: true };

  // When normalizeProjectTelemetryConfig parses it
  const result = config.normalizeProjectTelemetryConfig(raw);

  // Then storeOnline is true and warnings is empty
  assert.equal(result.storeOnline, true, 'storeOnline is true');
  assert.equal(result.version, 1, 'version is 1');
  assert.deepEqual(result.warnings, [], 'warnings is empty');
});

// --- Scenario: A JSON string is parsed ---
test('Scenario: A JSON string is parsed', () => {
  // Given the string '{"storeOnline":"true"}'
  const jsonString = '{"storeOnline":"true"}';

  // When normalizeProjectTelemetryConfig parses it
  const result = config.normalizeProjectTelemetryConfig(jsonString);

  // Then storeOnline is true (string "true" is coerced to boolean true)
  assert.equal(result.storeOnline, true, 'storeOnline is true (string "true" coerced)');
  assert.equal(result.version, 1, 'version defaults to 1');
  assert.ok(Array.isArray(result.warnings), 'warnings exists');
});

// --- Scenario: Serialize is valid, warning-free, newline-terminated ---
test('Scenario: Serialize is valid, warning-free, newline-terminated', () => {
  // Given any config
  const cfg = { version: 1, storeOnline: true, someUnknownKey: 'value' };

  // When serializeProjectTelemetryConfig is called
  const serialized = config.serializeProjectTelemetryConfig(cfg);

  // Then the output is valid JSON with no "warnings" key and ends with "\n"
  assert.ok(serialized.endsWith('\n'), 'output ends with newline');

  const parsed = JSON.parse(serialized);
  assert.ok(!('warnings' in parsed), 'no "warnings" key in serialized output');
  assert.equal(parsed.version, 1, 'version is serialized');
  assert.equal(parsed.storeOnline, true, 'storeOnline is serialized');
  assert.equal(parsed.someUnknownKey, 'value', 'unknown keys round-trip');
});

// --- Scenario (edge): Hostile input never throws ---
test('Scenario (edge): Hostile input never throws - null', () => {
  // Given the input null
  // When normalizeProjectTelemetryConfig parses each
  const result = config.normalizeProjectTelemetryConfig(null);

  // Then each returns a complete default config with warnings array and never throws
  // (null/undefined do not generate warnings, but other junk does)
  assert.equal(result.version, 1);
  assert.equal(result.storeOnline, false);
  assert.ok(Array.isArray(result.warnings));
});

test('Scenario (edge): Hostile input never throws - number 42', () => {
  // Given the input 42
  const result = config.normalizeProjectTelemetryConfig(42);

  // Then returns a complete default config with warnings and never throws
  assert.equal(result.version, 1);
  assert.equal(result.storeOnline, false);
  assert.ok(Array.isArray(result.warnings));
});

test('Scenario (edge): Hostile input never throws - array [1,2]', () => {
  // Given the input [1,2]
  const result = config.normalizeProjectTelemetryConfig([1, 2]);

  // Then returns a complete default config with warnings and never throws
  assert.equal(result.version, 1);
  assert.equal(result.storeOnline, false);
  assert.ok(Array.isArray(result.warnings));
});

test('Scenario (edge): Hostile input never throws - malformed JSON string', () => {
  // Given the input '{bad json'
  const result = config.normalizeProjectTelemetryConfig('{bad json');

  // Then returns a complete default config with warnings and never throws
  assert.equal(result.version, 1);
  assert.equal(result.storeOnline, false);
  assert.ok(Array.isArray(result.warnings));
  assert.ok(result.warnings.some((w) => /JSON/i.test(w)), 'warning mentions JSON');
});

// --- Scenario (edge): A __proto__ key is dropped, not round-tripped ---
test('Scenario (edge): A __proto__ key is dropped, not round-tripped', () => {
  // Given the JSON string '{"storeOnline":true,"__proto__":{"x":1}}'
  const jsonString = '{"storeOnline":true,"__proto__":{"x":1}}';

  // When normalizeProjectTelemetryConfig parses it
  const result = config.normalizeProjectTelemetryConfig(jsonString);

  // Then the result has no polluted prototype and storeOnline is true
  assert.equal(result.storeOnline, true, 'storeOnline is true');
  assert.ok(!Object.prototype.hasOwnProperty.call(result, '__proto__'), '__proto__ is not an own property of result');

  // Verify the normalized result doesn't have x (from __proto__.x)
  assert.equal(result.x, undefined, 'prototype pollution prevented');
  assert.ok(result.warnings.some((w) => /proto/.test(w)), 'warning mentions unsafe key');
});

// --- Additional edge case: constructor poisoning attempt ---
test('Scenario (edge): constructor key is dropped (prototype pollution protection)', () => {
  // Given a config with a constructor key
  const jsonString = '{"storeOnline":false,"constructor":{"x":1}}';

  // When normalized
  const result = config.normalizeProjectTelemetryConfig(jsonString);

  // Then constructor is dropped (as own property) and a warning is issued
  assert.ok(!Object.prototype.hasOwnProperty.call(result, 'constructor'), 'constructor is not an own property');
  assert.ok(result.warnings.some((w) => /constructor/i.test(w)), 'warning mentions constructor');
});

// --- Additional edge case: prototype key poisoning attempt ---
test('Scenario (edge): prototype key is dropped (prototype pollution protection)', () => {
  // Given a config with a prototype key
  const jsonString = '{"storeOnline":false,"prototype":{"x":1}}';

  // When normalized
  const result = config.normalizeProjectTelemetryConfig(jsonString);

  // Then prototype is dropped and a warning is issued
  assert.ok(!('prototype' in result), 'prototype key is dropped');
  assert.ok(result.warnings.some((w) => /prototype/i.test(w)), 'warning mentions prototype');
});

// --- Additional edge case: storeOnline coercion tests ---
test('Scenario (edge): storeOnline coercion - true stays true', () => {
  const result = config.normalizeProjectTelemetryConfig({ storeOnline: true });
  assert.equal(result.storeOnline, true);
});

test('Scenario (edge): storeOnline coercion - "true" string becomes true', () => {
  const result = config.normalizeProjectTelemetryConfig({ storeOnline: 'true' });
  assert.equal(result.storeOnline, true);
});

test('Scenario (edge): storeOnline coercion - 1 becomes true', () => {
  const result = config.normalizeProjectTelemetryConfig({ storeOnline: 1 });
  assert.equal(result.storeOnline, true);
});

test('Scenario (edge): storeOnline coercion - false stays false', () => {
  const result = config.normalizeProjectTelemetryConfig({ storeOnline: false });
  assert.equal(result.storeOnline, false);
});

test('Scenario (edge): storeOnline coercion - 0 becomes false', () => {
  const result = config.normalizeProjectTelemetryConfig({ storeOnline: 0 });
  assert.equal(result.storeOnline, false);
});

test('Scenario (edge): storeOnline coercion - "false" string becomes false', () => {
  const result = config.normalizeProjectTelemetryConfig({ storeOnline: 'false' });
  assert.equal(result.storeOnline, false);
});

test('Scenario (edge): storeOnline coercion - undefined becomes false', () => {
  const result = config.normalizeProjectTelemetryConfig({ storeOnline: undefined });
  assert.equal(result.storeOnline, false);
});

// --- Additional edge case: version coercion tests ---
test('Scenario (edge): version - positive integer round-trips', () => {
  const result = config.normalizeProjectTelemetryConfig({ version: 1 });
  assert.equal(result.version, 1);
  assert.deepEqual(result.warnings, []);
});

test('Scenario (edge): version - newer positive integer round-trips', () => {
  const result = config.normalizeProjectTelemetryConfig({ version: 99 });
  assert.equal(result.version, 99);
  assert.deepEqual(result.warnings, [], 'newer version round-trips without warning');
});

test('Scenario (edge): version - invalid version resets to 1 with warning', () => {
  const result = config.normalizeProjectTelemetryConfig({ version: -1 });
  assert.equal(result.version, 1);
  assert.ok(result.warnings.some((w) => /version/.test(w)), 'warning about invalid version');
});

test('Scenario (edge): version - zero resets to 1 with warning', () => {
  const result = config.normalizeProjectTelemetryConfig({ version: 0 });
  assert.equal(result.version, 1);
  assert.ok(result.warnings.some((w) => /version/.test(w)));
});

test('Scenario (edge): version - float is floored', () => {
  const result = config.normalizeProjectTelemetryConfig({ version: 5.9 });
  assert.equal(result.version, 5);
  assert.deepEqual(result.warnings, []);
});

test('Scenario (edge): version - invalid string resets to 1', () => {
  const result = config.normalizeProjectTelemetryConfig({ version: 'invalid' });
  assert.equal(result.version, 1);
  assert.ok(result.warnings.length > 0);
});

// --- Integration: full serialize/normalize round-trip ---
test('Integration: serialize/normalize round-trip produces stable output', () => {
  const original = { version: 1, storeOnline: true, extraField: 'test' };
  const serialized1 = config.serializeProjectTelemetryConfig(original);
  const normalized = config.normalizeProjectTelemetryConfig(serialized1);
  const serialized2 = config.serializeProjectTelemetryConfig(normalized);

  // Two serializations of the same config should be identical
  assert.equal(serialized1, serialized2, 'idempotent serialization');
});

// --- Integration: CONFIG_VERSION is exported and correct ---
test('CONFIG_VERSION is exported and equals 1', () => {
  assert.equal(config.CONFIG_VERSION, 1);
});
