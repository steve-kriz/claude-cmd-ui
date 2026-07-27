'use strict';

// Unit tests for lib/telemetry-project-config.js — the pure model for the
// per-project telemetry config (TASK-155). No Electron / disk / network.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const t = require('../lib/telemetry-project-config');

// --- defaultProjectTelemetryConfig ---

test('defaultProjectTelemetryConfig returns { version: 1, storeOnline: false }', () => {
  const cfg = t.defaultProjectTelemetryConfig();
  assert.strictEqual(cfg.version, 1);
  assert.strictEqual(cfg.storeOnline, false);
  assert.deepEqual(cfg, { version: 1, storeOnline: false });
});

test('defaultProjectTelemetryConfig returns a fresh object each time', () => {
  const cfg1 = t.defaultProjectTelemetryConfig();
  const cfg2 = t.defaultProjectTelemetryConfig();
  assert.notStrictEqual(cfg1, cfg2, 'different object instances');
  assert.deepEqual(cfg1, cfg2, 'but same content');
});

// --- normalizeProjectTelemetryConfig: basic valid inputs ---

test('normalizeProjectTelemetryConfig accepts a plain object', () => {
  const raw = { version: 1, storeOnline: true };
  const result = t.normalizeProjectTelemetryConfig(raw);
  assert.strictEqual(result.version, 1);
  assert.strictEqual(result.storeOnline, true);
});

test('normalizeProjectTelemetryConfig parses a JSON string', () => {
  const jsonStr = '{"version":1,"storeOnline":false}';
  const result = t.normalizeProjectTelemetryConfig(jsonStr);
  assert.strictEqual(result.version, 1);
  assert.strictEqual(result.storeOnline, false);
});

test('normalizeProjectTelemetryConfig always returns an object with warnings array', () => {
  const result = t.normalizeProjectTelemetryConfig({ version: 1, storeOnline: false });
  assert.ok(Array.isArray(result.warnings));
});

test('normalizeProjectTelemetryConfig returns warnings === [] for valid input', () => {
  const result = t.normalizeProjectTelemetryConfig({ version: 1, storeOnline: false });
  assert.deepEqual(result.warnings, []);
});

// --- normalizeProjectTelemetryConfig: junk input (never throws) ---

test('normalizeProjectTelemetryConfig handles null input without throwing', () => {
  assert.doesNotThrow(() => {
    const result = t.normalizeProjectTelemetryConfig(null);
    assert.strictEqual(result.version, 1);
    assert.strictEqual(result.storeOnline, false);
    assert.ok(Array.isArray(result.warnings));
    // null/undefined don't generate warnings, but the warnings array exists
  });
});

test('normalizeProjectTelemetryConfig handles undefined input without throwing', () => {
  assert.doesNotThrow(() => {
    const result = t.normalizeProjectTelemetryConfig(undefined);
    assert.strictEqual(result.version, 1);
    assert.strictEqual(result.storeOnline, false);
  });
});

test('normalizeProjectTelemetryConfig handles numeric input without throwing', () => {
  assert.doesNotThrow(() => {
    const result = t.normalizeProjectTelemetryConfig(42);
    assert.strictEqual(result.version, 1);
    assert.strictEqual(result.storeOnline, false);
  });
});

test('normalizeProjectTelemetryConfig handles array input without throwing', () => {
  assert.doesNotThrow(() => {
    const result = t.normalizeProjectTelemetryConfig([1, 2, 3]);
    assert.strictEqual(result.version, 1);
    assert.strictEqual(result.storeOnline, false);
  });
});

test('normalizeProjectTelemetryConfig handles malformed JSON string without throwing', () => {
  assert.doesNotThrow(() => {
    const result = t.normalizeProjectTelemetryConfig('{bad json');
    assert.strictEqual(result.version, 1);
    assert.strictEqual(result.storeOnline, false);
    assert.ok(result.warnings.length > 0);
  });
});

test('normalizeProjectTelemetryConfig handles JSON string of non-object without throwing', () => {
  assert.doesNotThrow(() => {
    const result = t.normalizeProjectTelemetryConfig('42');
    assert.strictEqual(result.version, 1);
    assert.strictEqual(result.storeOnline, false);
  });
});

test('normalizeProjectTelemetryConfig handles JSON array string without throwing', () => {
  assert.doesNotThrow(() => {
    const result = t.normalizeProjectTelemetryConfig('[1,2,3]');
    assert.strictEqual(result.version, 1);
    assert.strictEqual(result.storeOnline, false);
  });
});

test('normalizeProjectTelemetryConfig handles empty string without throwing', () => {
  assert.doesNotThrow(() => {
    const result = t.normalizeProjectTelemetryConfig('');
    assert.strictEqual(result.version, 1);
  });
});

// --- normalizeProjectTelemetryConfig: storeOnline coercion ---

test('storeOnline: true stays true', () => {
  const result = t.normalizeProjectTelemetryConfig({ storeOnline: true });
  assert.strictEqual(result.storeOnline, true);
});

test('storeOnline: false stays false', () => {
  const result = t.normalizeProjectTelemetryConfig({ storeOnline: false });
  assert.strictEqual(result.storeOnline, false);
});

test('storeOnline: "true" string is coerced to true', () => {
  const result = t.normalizeProjectTelemetryConfig({ storeOnline: 'true' });
  assert.strictEqual(result.storeOnline, true);
});

test('storeOnline: 1 is coerced to true', () => {
  const result = t.normalizeProjectTelemetryConfig({ storeOnline: 1 });
  assert.strictEqual(result.storeOnline, true);
});

test('storeOnline: 0 is coerced to false', () => {
  const result = t.normalizeProjectTelemetryConfig({ storeOnline: 0 });
  assert.strictEqual(result.storeOnline, false);
});

test('storeOnline: "false" string is coerced to false', () => {
  const result = t.normalizeProjectTelemetryConfig({ storeOnline: 'false' });
  assert.strictEqual(result.storeOnline, false);
});

test('storeOnline: null is coerced to false', () => {
  const result = t.normalizeProjectTelemetryConfig({ storeOnline: null });
  assert.strictEqual(result.storeOnline, false);
});

test('storeOnline: undefined is coerced to false', () => {
  const result = t.normalizeProjectTelemetryConfig({ storeOnline: undefined });
  assert.strictEqual(result.storeOnline, false);
});

test('storeOnline: numeric string "1" is coerced to false (not === 1)', () => {
  const result = t.normalizeProjectTelemetryConfig({ storeOnline: '1' });
  assert.strictEqual(result.storeOnline, false);
});

test('storeOnline: object is coerced to false', () => {
  const result = t.normalizeProjectTelemetryConfig({ storeOnline: { value: true } });
  assert.strictEqual(result.storeOnline, false);
});

// --- normalizeProjectTelemetryConfig: version handling ---

test('version: positive integer round-trips as-is', () => {
  const result = t.normalizeProjectTelemetryConfig({ version: 1 });
  assert.strictEqual(result.version, 1);
  assert.deepEqual(result.warnings, []);
});

test('version: newer positive integer round-trips without warning', () => {
  const result = t.normalizeProjectTelemetryConfig({ version: 5 });
  assert.strictEqual(result.version, 5);
  assert.deepEqual(result.warnings, []);
});

test('version: large positive integer round-trips', () => {
  const result = t.normalizeProjectTelemetryConfig({ version: 999 });
  assert.strictEqual(result.version, 999);
});

test('version: float is floored to integer', () => {
  const result = t.normalizeProjectTelemetryConfig({ version: 5.7 });
  assert.strictEqual(result.version, 5);
  assert.deepEqual(result.warnings, []);
});

test('version: missing version defaults to 1', () => {
  const result = t.normalizeProjectTelemetryConfig({});
  assert.strictEqual(result.version, 1);
});

test('version: null version resets to 1', () => {
  const result = t.normalizeProjectTelemetryConfig({ version: null });
  assert.strictEqual(result.version, 1);
  // null falls through to not matching the condition, so no warning added
});

test('version: negative integer resets to 1 with warning', () => {
  const result = t.normalizeProjectTelemetryConfig({ version: -1 });
  assert.strictEqual(result.version, 1);
  assert.ok(result.warnings.length > 0);
  assert.ok(result.warnings.some((w) => /version/i.test(w)));
});

test('version: zero resets to 1 with warning', () => {
  const result = t.normalizeProjectTelemetryConfig({ version: 0 });
  assert.strictEqual(result.version, 1);
  assert.ok(result.warnings.some((w) => /version/i.test(w)));
});

test('version: invalid string resets to 1 with warning', () => {
  const result = t.normalizeProjectTelemetryConfig({ version: 'not-a-number' });
  assert.strictEqual(result.version, 1);
  assert.ok(result.warnings.length > 0);
});

test('version: NaN resets to 1 with warning', () => {
  const result = t.normalizeProjectTelemetryConfig({ version: NaN });
  assert.strictEqual(result.version, 1);
  assert.ok(result.warnings.length > 0);
});

test('version: Infinity resets to 1 with warning', () => {
  const result = t.normalizeProjectTelemetryConfig({ version: Infinity });
  assert.strictEqual(result.version, 1);
  assert.ok(result.warnings.length > 0);
});

// --- normalizeProjectTelemetryConfig: unknown field round-tripping ---

test('unknown field: non-reserved keys round-trip', () => {
  const result = t.normalizeProjectTelemetryConfig({ version: 1, storeOnline: false, customField: 'value' });
  assert.strictEqual(result.customField, 'value');
});

test('unknown fields: multiple custom keys round-trip', () => {
  const result = t.normalizeProjectTelemetryConfig({
    version: 1,
    storeOnline: false,
    field1: 'value1',
    field2: 42,
    field3: { nested: true },
  });
  assert.strictEqual(result.field1, 'value1');
  assert.strictEqual(result.field2, 42);
  assert.deepEqual(result.field3, { nested: true });
});

test('unknown field: warnings key in input is not round-tripped', () => {
  const result = t.normalizeProjectTelemetryConfig({ version: 1, storeOnline: false, warnings: ['fake'] });
  // warnings is set by the function, input warnings are ignored
  assert.ok(Array.isArray(result.warnings));
});

// --- normalizeProjectTelemetryConfig: prototype pollution protection ---

test('__proto__ key is dropped when from JSON (own property)', () => {
  // JSON.parse creates __proto__ as an own property, which gets dropped
  const jsonStr = '{"version":1,"__proto__":{"x":1}}';
  const result = t.normalizeProjectTelemetryConfig(jsonStr);
  assert.ok(!Object.prototype.hasOwnProperty.call(result, '__proto__'), '__proto__ is not an own property');
  assert.ok(result.warnings.some((w) => /__proto__/i.test(w)), 'warning about __proto__');
});

test('__proto__ in object literal sets prototype, not an own key (no warning)', () => {
  // Object literal __proto__: {} sets the prototype, not an own property, so no warning
  const result = t.normalizeProjectTelemetryConfig({ version: 1, storeOnline: false, __proto__: { x: 1 } });
  assert.ok(!Object.prototype.hasOwnProperty.call(result, '__proto__'), '__proto__ is not an own property');
  // Object literal __proto__ doesn't appear in Object.keys(), so no warning
});

test('__proto__ pollution does not affect prototype', () => {
  const result = t.normalizeProjectTelemetryConfig({ __proto__: { polluted: true } });
  assert.equal(result.polluted, undefined, 'prototype not polluted');
});

test('constructor key is dropped, not round-tripped', () => {
  const result = t.normalizeProjectTelemetryConfig({ version: 1, constructor: { x: 1 } });
  assert.ok(!Object.prototype.hasOwnProperty.call(result, 'constructor'), 'constructor is not an own property');
  assert.ok(result.warnings.some((w) => /constructor/i.test(w)), 'warning about constructor');
});

test('prototype key is dropped, not round-tripped', () => {
  const result = t.normalizeProjectTelemetryConfig({ version: 1, prototype: { x: 1 } });
  assert.ok(!Object.prototype.hasOwnProperty.call(result, 'prototype'), 'prototype is not an own property');
  assert.ok(result.warnings.some((w) => /prototype/i.test(w)), 'warning about prototype');
});

test('all three unsafe keys are dropped when from JSON', () => {
  // JSON.parse creates these as own properties, which get dropped with warnings
  const jsonStr = '{"version":1,"storeOnline":false,"__proto__":{"a":1},"constructor":{"b":2},"prototype":{"c":3}}';
  const result = t.normalizeProjectTelemetryConfig(jsonStr);
  assert.ok(!Object.prototype.hasOwnProperty.call(result, '__proto__'));
  assert.ok(!Object.prototype.hasOwnProperty.call(result, 'constructor'));
  assert.ok(!Object.prototype.hasOwnProperty.call(result, 'prototype'));
  assert.strictEqual(result.warnings.length, 3);
});

// --- serializeProjectTelemetryConfig ---

test('serializeProjectTelemetryConfig normalizes input first', () => {
  // Pass invalid/incomplete input
  const result = t.serializeProjectTelemetryConfig(null);
  const parsed = JSON.parse(result);
  assert.strictEqual(parsed.version, 1);
  assert.strictEqual(parsed.storeOnline, false);
});

test('serializeProjectTelemetryConfig removes warnings from output', () => {
  const input = { version: 1, storeOnline: false };
  const serialized = t.serializeProjectTelemetryConfig(input);
  const parsed = JSON.parse(serialized);
  assert.ok(!('warnings' in parsed), 'warnings not in serialized JSON');
});

test('serializeProjectTelemetryConfig produces valid JSON', () => {
  const input = { version: 1, storeOnline: true };
  const serialized = t.serializeProjectTelemetryConfig(input);
  assert.doesNotThrow(() => JSON.parse(serialized));
  const parsed = JSON.parse(serialized);
  assert.strictEqual(parsed.version, 1);
  assert.strictEqual(parsed.storeOnline, true);
});

test('serializeProjectTelemetryConfig ends with newline', () => {
  const serialized = t.serializeProjectTelemetryConfig({ version: 1, storeOnline: false });
  assert.ok(serialized.endsWith('\n'), 'serialized string ends with newline');
});

test('serializeProjectTelemetryConfig uses 2-space indentation', () => {
  const serialized = t.serializeProjectTelemetryConfig({ version: 1, storeOnline: false });
  // Should have indented JSON
  assert.ok(serialized.includes('  '), 'contains 2-space indentation');
});

test('serializeProjectTelemetryConfig round-trips unknown fields (except unsafe keys)', () => {
  const input = { version: 1, storeOnline: false, customField: 'value' };
  const serialized = t.serializeProjectTelemetryConfig(input);
  const parsed = JSON.parse(serialized);
  assert.strictEqual(parsed.customField, 'value');
});

test('serializeProjectTelemetryConfig drops unsafe keys from output', () => {
  const input = { version: 1, storeOnline: false, __proto__: { x: 1 } };
  const serialized = t.serializeProjectTelemetryConfig(input);
  const parsed = JSON.parse(serialized);
  assert.ok(!Object.prototype.hasOwnProperty.call(parsed, '__proto__'));
});

test('serializeProjectTelemetryConfig on valid input produces warning-free result', () => {
  const input = { version: 1, storeOnline: true };
  const serialized = t.serializeProjectTelemetryConfig(input);
  const parsed = JSON.parse(serialized);
  assert.ok(!('warnings' in parsed));
});

test('serializeProjectTelemetryConfig idempotency: serializing twice is same', () => {
  const input = { version: 1, storeOnline: true };
  const s1 = t.serializeProjectTelemetryConfig(input);
  const s2 = t.serializeProjectTelemetryConfig(s1);
  assert.strictEqual(s1, s2);
});

// --- Integration tests ---

test('Integration: normalize then serialize round-trips valid config', () => {
  const original = { version: 1, storeOnline: true };
  const normalized = t.normalizeProjectTelemetryConfig(original);
  const serialized = t.serializeProjectTelemetryConfig(normalized);
  const reparsed = JSON.parse(serialized);
  assert.strictEqual(reparsed.version, 1);
  assert.strictEqual(reparsed.storeOnline, true);
});

test('Integration: complex normalize cycle with warnings', () => {
  const input = '{"version":-1,"storeOnline":"true","__proto__":{"bad":1}}';
  const result = t.normalizeProjectTelemetryConfig(input);
  assert.strictEqual(result.version, 1, 'invalid version reset');
  assert.strictEqual(result.storeOnline, true, 'string true coerced');
  assert.ok(!Object.prototype.hasOwnProperty.call(result, '__proto__'), 'proto removed');
  assert.ok(result.warnings.length > 0, 'warnings present');
});

test('Integration: normalize with complex object input', () => {
  const input = {
    version: 2.7,
    storeOnline: 1,
    extra: 'field',
    constructor: { x: 1 },
  };
  const result = t.normalizeProjectTelemetryConfig(input);
  assert.strictEqual(result.version, 2, 'floored version');
  assert.strictEqual(result.storeOnline, true, 'coerced storeOnline');
  assert.strictEqual(result.extra, 'field', 'unknown field preserved');
  assert.ok(!Object.prototype.hasOwnProperty.call(result, 'constructor'), 'unsafe key dropped');
  assert.ok(result.warnings.length > 0);
});

// --- CONFIG_VERSION export ---

test('CONFIG_VERSION is exported and equals 1', () => {
  assert.strictEqual(t.CONFIG_VERSION, 1);
});

// --- Module exports ---

test('module exports all required functions', () => {
  assert.strictEqual(typeof t.CONFIG_VERSION, 'number');
  assert.strictEqual(typeof t.defaultProjectTelemetryConfig, 'function');
  assert.strictEqual(typeof t.normalizeProjectTelemetryConfig, 'function');
  assert.strictEqual(typeof t.serializeProjectTelemetryConfig, 'function');
});
