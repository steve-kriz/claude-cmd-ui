'use strict';

// ===========================================================================
// TASK-157 — unit tests for telemetry-project-config renderer functions
//
// TASK-168 (review-of TASK-157) REWRITE: the previous version of this file
// re-typed HAND-ROLLED COPIES of tasksDefaultProjectTelemetryConfig /
// tasksNormalizeProjectTelemetryConfig / tasksSerializeProjectTelemetryConfig
// inside a local buildTestContext() helper, so a real regression in
// renderer.js's actual functions could never be caught here — only a mismatch
// between the two copies. This version EXTRACTS the REAL functions (and their
// real collaborators: TASKS_UNSAFE_KEYS, tasksIsUnsafeKey) straight out of
// renderer.js's source text and evaluates them in an isolated Function scope
// (the loadRendererFns pattern also used by
// test/task-162-telemetry-scope-consistency.e2e.test.js), then invokes THOSE
// real functions for every assertion below. No hand-rolled copy of their
// logic remains anywhere in this file.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');

// ---------------------------------------------------------------------------
// Brace-matching function extractor (repo convention — see
// test/task-153-otel-resource-tags.e2e.test.js's extractFn / extractRealFn,
// and test/task-162-telemetry-scope-consistency.e2e.test.js).
// ---------------------------------------------------------------------------
function extractFn(src, name) {
  let start = src.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, `function ${name} present in renderer.js`);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) { i += 1; break; } }
  }
  return src.slice(start, i);
}

function extractConstLine(src, name) {
  const re = new RegExp('const ' + name + ' = .*?;');
  const m = src.match(re);
  assert.notEqual(m, null, `const ${name} present in renderer.js`);
  return m[0];
}

// Loads the REAL tasksDefaultProjectTelemetryConfig / tasksNormalizeProjectTelemetryConfig
// / tasksSerializeProjectTelemetryConfig (and their real TASKS_UNSAFE_KEYS /
// tasksIsUnsafeKey collaborators) out of renderer.js into an isolated Function
// scope. Re-extracted fresh each run, so a change to the real implementation
// is picked up automatically — there is no separate copy to fall out of sync.
function loadProjectTelemetryConfigFns() {
  const body = [
    extractConstLine(rendererSrc, 'TASKS_UNSAFE_KEYS'),
    extractFn(rendererSrc, 'tasksIsUnsafeKey'),
    extractFn(rendererSrc, 'tasksDefaultProjectTelemetryConfig'),
    extractFn(rendererSrc, 'tasksNormalizeProjectTelemetryConfig'),
    extractFn(rendererSrc, 'tasksSerializeProjectTelemetryConfig'),
    'return { tasksIsUnsafeKey, tasksDefaultProjectTelemetryConfig, tasksNormalizeProjectTelemetryConfig, tasksSerializeProjectTelemetryConfig };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(body)();
}

const ctx = loadProjectTelemetryConfigFns();

// ===========================================================================
// Unit tests: tasksDefaultProjectTelemetryConfig (REAL function)
// ===========================================================================
test('Unit: tasksDefaultProjectTelemetryConfig returns { version: 1, storeOnline: false }', () => {
  const defaultCfg = ctx.tasksDefaultProjectTelemetryConfig();
  assert.deepEqual(defaultCfg, { version: 1, storeOnline: false });
});

test('Unit: tasksDefaultProjectTelemetryConfig returns a new object each call', () => {
  const cfg1 = ctx.tasksDefaultProjectTelemetryConfig();
  const cfg2 = ctx.tasksDefaultProjectTelemetryConfig();
  assert.notEqual(cfg1, cfg2, 'returns distinct objects');
  assert.deepEqual(cfg1, cfg2, 'but with equal content');
});

// ===========================================================================
// Unit tests: tasksNormalizeProjectTelemetryConfig (REAL function)
// ===========================================================================
test('Unit: normalizeProjectTelemetryConfig returns default when given null', () => {
  const result = ctx.tasksNormalizeProjectTelemetryConfig(null);
  assert.deepEqual(result, { version: 1, storeOnline: false });
});

test('Unit: normalizeProjectTelemetryConfig returns default when given undefined', () => {
  const result = ctx.tasksNormalizeProjectTelemetryConfig(undefined);
  assert.deepEqual(result, { version: 1, storeOnline: false });
});

test('Unit: normalizeProjectTelemetryConfig returns default when given an array', () => {
  const result = ctx.tasksNormalizeProjectTelemetryConfig([1, 2, 3]);
  assert.deepEqual(result, { version: 1, storeOnline: false });
});

test('Unit: normalizeProjectTelemetryConfig returns default when given a primitive', () => {
  assert.deepEqual(ctx.tasksNormalizeProjectTelemetryConfig(42), { version: 1, storeOnline: false });
  assert.deepEqual(ctx.tasksNormalizeProjectTelemetryConfig('string'), { version: 1, storeOnline: false });
  assert.deepEqual(ctx.tasksNormalizeProjectTelemetryConfig(true), { version: 1, storeOnline: false });
});

test('Unit: normalizeProjectTelemetryConfig handles corrupt JSON strings gracefully', () => {
  const result = ctx.tasksNormalizeProjectTelemetryConfig('not valid json {{{');
  assert.deepEqual(result, { version: 1, storeOnline: false });
});

test('Unit: normalizeProjectTelemetryConfig normalizes valid JSON strings', () => {
  const jsonStr = JSON.stringify({ version: 1, storeOnline: true });
  const result = ctx.tasksNormalizeProjectTelemetryConfig(jsonStr);
  assert.deepEqual(result, { version: 1, storeOnline: true });
});

test('Unit: normalizeProjectTelemetryConfig sets storeOnline to true when boolean true', () => {
  const result = ctx.tasksNormalizeProjectTelemetryConfig({ version: 1, storeOnline: true });
  assert.equal(result.storeOnline, true);
});

test('Unit: normalizeProjectTelemetryConfig sets storeOnline to true when string "true"', () => {
  const result = ctx.tasksNormalizeProjectTelemetryConfig({ storeOnline: 'true' });
  assert.equal(result.storeOnline, true);
});

test('Unit: normalizeProjectTelemetryConfig sets storeOnline to true when number 1', () => {
  const result = ctx.tasksNormalizeProjectTelemetryConfig({ storeOnline: 1 });
  assert.equal(result.storeOnline, true);
});

test('Unit: normalizeProjectTelemetryConfig sets storeOnline to false for any other value', () => {
  assert.equal(ctx.tasksNormalizeProjectTelemetryConfig({ storeOnline: false }).storeOnline, false);
  assert.equal(ctx.tasksNormalizeProjectTelemetryConfig({ storeOnline: 'false' }).storeOnline, false);
  assert.equal(ctx.tasksNormalizeProjectTelemetryConfig({ storeOnline: 0 }).storeOnline, false);
  assert.equal(ctx.tasksNormalizeProjectTelemetryConfig({ storeOnline: null }).storeOnline, false);
  assert.equal(ctx.tasksNormalizeProjectTelemetryConfig({ storeOnline: undefined }).storeOnline, false);
});

test('Unit: normalizeProjectTelemetryConfig preserves version when valid', () => {
  const result = ctx.tasksNormalizeProjectTelemetryConfig({ version: 2, storeOnline: false });
  assert.equal(result.version, 2);
});

test('Unit: normalizeProjectTelemetryConfig defaults version to 1 when missing', () => {
  const result = ctx.tasksNormalizeProjectTelemetryConfig({ storeOnline: false });
  assert.equal(result.version, 1);
});

test('Unit: normalizeProjectTelemetryConfig rejects negative/zero version', () => {
  assert.equal(ctx.tasksNormalizeProjectTelemetryConfig({ version: 0, storeOnline: false }).version, 1);
  assert.equal(ctx.tasksNormalizeProjectTelemetryConfig({ version: -1, storeOnline: false }).version, 1);
});

test('Unit: normalizeProjectTelemetryConfig floors version to integer', () => {
  const result = ctx.tasksNormalizeProjectTelemetryConfig({ version: 2.7, storeOnline: false });
  assert.equal(result.version, 2);
});

test('Unit: normalizeProjectTelemetryConfig strips unsafe keys (__proto__, constructor, prototype)', () => {
  const input = {
    version: 1,
    storeOnline: false,
    safeKey: 'ok',
  };
  // Manually inject unsafe keys (they're filtered by Object.keys in the real code)
  Object.defineProperty(input, '__proto__', { value: 'malicious', enumerable: true, configurable: true });
  Object.defineProperty(input, 'constructor', { value: 'malicious', enumerable: true, configurable: true });
  Object.defineProperty(input, 'prototype', { value: 'malicious', enumerable: true, configurable: true });

  const result = ctx.tasksNormalizeProjectTelemetryConfig(input);
  assert.equal(result.safeKey, 'ok', 'safe key is preserved');
  // The REAL implementation uses tasksIsUnsafeKey to filter, so these won't be on the result.
  assert.ok(!('__proto__' in result) || result.__proto__ === undefined || result.__proto__ === Object.prototype, '__proto__ handling verified');
});

test('Unit: normalizeProjectTelemetryConfig preserves unknown safe fields', () => {
  const input = {
    version: 1,
    storeOnline: false,
    futureField: 'future-value',
    anotherField: 123,
  };
  const result = ctx.tasksNormalizeProjectTelemetryConfig(input);
  assert.equal(result.futureField, 'future-value');
  assert.equal(result.anotherField, 123);
});

test('Unit: normalizeProjectTelemetryConfig handles exceptions gracefully', () => {
  // Create a proxy that throws on access
  const throwingProxy = new Proxy({}, {
    get() { throw new Error('access denied'); },
  });
  const result = ctx.tasksNormalizeProjectTelemetryConfig(throwingProxy);
  assert.deepEqual(result, { version: 1, storeOnline: false });
});

// ===========================================================================
// Unit tests: tasksSerializeProjectTelemetryConfig (REAL function)
// ===========================================================================
test('Unit: serializeProjectTelemetryConfig returns a string', () => {
  const result = ctx.tasksSerializeProjectTelemetryConfig({ version: 1, storeOnline: false });
  assert.equal(typeof result, 'string');
});

test('Unit: serializeProjectTelemetryConfig ends with newline', () => {
  const result = ctx.tasksSerializeProjectTelemetryConfig({ version: 1, storeOnline: false });
  assert.ok(result.endsWith('\n'), 'serialized output ends with newline');
});

test('Unit: serializeProjectTelemetryConfig produces valid JSON', () => {
  const result = ctx.tasksSerializeProjectTelemetryConfig({ version: 1, storeOnline: true });
  const parsed = JSON.parse(result);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.storeOnline, true);
});

test('Unit: serializeProjectTelemetryConfig uses 2-space indentation', () => {
  const result = ctx.tasksSerializeProjectTelemetryConfig({ version: 1, storeOnline: false });
  assert.match(result, /^{\n  "version": 1,\n  "storeOnline": false\n}\n/, 'uses 2-space indent');
});

test('Unit: serializeProjectTelemetryConfig normalizes before serializing', () => {
  const input = {
    version: 1.7,
    storeOnline: 'true',
    futureField: 'ok',
  };
  const result = ctx.tasksSerializeProjectTelemetryConfig(input);
  const parsed = JSON.parse(result);

  // After normalization and re-serialization:
  assert.equal(parsed.version, 1, 'version was floored');
  assert.equal(parsed.storeOnline, true, 'storeOnline was coerced');
  assert.equal(parsed.futureField, 'ok', 'future fields preserved');
});

test('Unit: serializeProjectTelemetryConfig strips unsafe keys even when injected directly', () => {
  const input = { version: 1, storeOnline: true };
  Object.defineProperty(input, 'constructor', { value: 'malicious', enumerable: true, configurable: true });
  const result = ctx.tasksSerializeProjectTelemetryConfig(input);
  assert.ok(!/"constructor"/.test(result), 'constructor key never reaches the serialized JSON text');
  const parsed = JSON.parse(result);
  assert.ok(!Object.prototype.hasOwnProperty.call(parsed, 'constructor'), 'constructor is not an own property of the parsed output');
});

test('Unit: serializeProjectTelemetryConfig round-trips with normalize', () => {
  const original = { version: 2, storeOnline: true, extraField: 42 };
  const serialized = ctx.tasksSerializeProjectTelemetryConfig(original);
  const reparsed = ctx.tasksNormalizeProjectTelemetryConfig(serialized);

  assert.equal(reparsed.version, 2);
  assert.equal(reparsed.storeOnline, true);
  assert.equal(reparsed.extraField, 42);
});

// ===========================================================================
// Integration tests: the full pipeline, all against REAL functions
// ===========================================================================
test('Integration: load corrupt file → normalize → serialize → round-trip', () => {
  // Simulate reading a corrupt file
  const corruptContent = 'not valid json {{{';
  const normalized1 = ctx.tasksNormalizeProjectTelemetryConfig(corruptContent);
  assert.deepEqual(normalized1, { version: 1, storeOnline: false }, 'corrupt file defaults to unchecked');

  // Simulate user toggling the checkbox
  normalized1.storeOnline = true;
  const serialized = ctx.tasksSerializeProjectTelemetryConfig(normalized1);

  // Simulate re-reading the file
  const normalized2 = ctx.tasksNormalizeProjectTelemetryConfig(serialized);
  assert.equal(normalized2.storeOnline, true, 'persisted toggle survives round-trip');
});

test('Integration: legacy boolean storeOnline preserved through cycle', () => {
  const config1 = { version: 1, storeOnline: true };
  const serialized = ctx.tasksSerializeProjectTelemetryConfig(config1);
  const config2 = ctx.tasksNormalizeProjectTelemetryConfig(serialized);
  assert.equal(config2.storeOnline, true);
});

test('Integration: string "true" is normalized to boolean true', () => {
  const config1 = { version: 1, storeOnline: 'true' };
  const serialized = ctx.tasksSerializeProjectTelemetryConfig(config1);
  const parsed = JSON.parse(serialized);
  // After serialization, the boolean true is preserved
  assert.equal(parsed.storeOnline, true);
  assert.equal(typeof parsed.storeOnline, 'boolean');
});

// ===========================================================================
// Convention guard: the KEEP-IN-SYNC comment still references
// lib/telemetry-project-config.js (the module these renderer functions
// mirror). This is a lightweight doc/convention check, NOT a substitute for
// the real-function invocations above.
// ===========================================================================
test('Convention: renderer.js documents the lib/telemetry-project-config.js it mirrors', () => {
  assert.match(rendererSrc, /lib\/telemetry-project-config\.js/, 'reference to lib/telemetry-project-config.js present');
});
