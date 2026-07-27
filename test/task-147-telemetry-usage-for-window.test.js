'use strict';

// ===========================================================================
// TASK-147 — Unit tests for telemetry:usageForWindow IPC handler hardening.
//
// These tests verify the handler's try/catch wrapper and error handling
// logic in isolation, without the full e2e scenario structure.
//
// Focus areas:
// - Try/catch correctly catches and converts errors to null-usage
// - No receiver case returns null safely
// - Happy path passes through receiver's return value
// - Edge cases (invalid receivers, junk arguments) are handled
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// main.js requires('electron') at the top, which is not the real Electron API
// under plain `node --test` — so it can never be require()'d directly here (see
// task-107-mac-unix.test.js's augmentDarwinPath precedent). Instead, pull the
// REAL `createUsageForWindowHandler` factory text out of main.js by brace-
// matching and evaluate it headless (TASK-158) — no hand-rolled mirror.
function extractFn(src, name) {
  let start = src.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, `function ${name} found in source`);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) { i += 1; break; } }
  }
  return src.slice(start, i);
}

const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

// The REAL createUsageForWindowHandler factory from main.js, evaluated headless
// (main.js's Electron entry code is never executed here).
const { createUsageForWindowHandler } = new Function(
  extractFn(mainSrc, 'createUsageForWindowHandler') + '\nreturn { createUsageForWindowHandler };'
)();

// ===========================================================================
// Happy path: receiver returns valid usage
// ===========================================================================

test('Unit: Handler with valid receiver returns wrapped usage', async () => {
  const usage = { requests: 10, costUsd: 0.05 };
  const receiver = { usageForWindow: () => usage };
  const handler = createUsageForWindowHandler(receiver);

  const result = await handler(null, {});
  assert.equal(result.ok, true);
  assert.strictEqual(result.usage, usage, 'receiver return value passed through');
});

test('Unit: Handler passes the windowArg to receiver.usageForWindow', async () => {
  let capturedArg = null;
  const receiver = {
    usageForWindow(window) {
      capturedArg = window;
      return { requests: 0 };
    },
  };
  const handler = createUsageForWindowHandler(receiver);

  const windowArg = {
    startedAt: '2026-07-26T04:00:00Z',
    finishedAt: '2026-07-26T05:00:00Z',
    model: 'claude-haiku-4-5',
  };
  await handler(null, windowArg);

  assert.deepEqual(capturedArg, windowArg, 'window argument forwarded to receiver');
});

// ===========================================================================
// Error handling: receiver throws
// ===========================================================================

test('Unit: Handler catches thrown errors and returns null usage', async () => {
  const receiver = {
    usageForWindow() {
      throw new Error('receiver failed');
    },
  };
  const handler = createUsageForWindowHandler(receiver);

  const result = await handler(null, {});
  assert.deepEqual(result, { ok: true, usage: null }, 'throws caught → null response');
});

test('Unit: Handler catches non-Error throws (strings, etc.)', async () => {
  const receiver = {
    usageForWindow() {
      throw 'arbitrary throw';  // eslint-disable-line no-throw-literal
    },
  };
  const handler = createUsageForWindowHandler(receiver);

  const result = await handler(null, {});
  assert.deepEqual(result, { ok: true, usage: null }, 'string throw caught');
});

test('Unit: Handler catches nullish throws', async () => {
  const receiver = {
    usageForWindow() {
      throw null;  // eslint-disable-line no-throw-literal
    },
  };
  const handler = createUsageForWindowHandler(receiver);

  const result = await handler(null, {});
  assert.deepEqual(result, { ok: true, usage: null }, 'null throw caught');
});

test('Unit: Handler catches undefined throws', async () => {
  const receiver = {
    usageForWindow() {
      throw undefined;  // eslint-disable-line no-throw-literal
    },
  };
  const handler = createUsageForWindowHandler(receiver);

  const result = await handler(null, {});
  assert.deepEqual(result, { ok: true, usage: null }, 'undefined throw caught');
});

// ===========================================================================
// No receiver case
// ===========================================================================

test('Unit: Handler with null receiver returns null usage', async () => {
  const handler = createUsageForWindowHandler(null);

  const result = await handler(null, {});
  assert.deepEqual(result, { ok: true, usage: null }, 'null receiver → null usage');
});

test('Unit: Handler with undefined receiver returns null usage', async () => {
  const handler = createUsageForWindowHandler(undefined);

  const result = await handler(null, {});
  assert.deepEqual(result, { ok: true, usage: null }, 'undefined receiver → null usage');
});

// ===========================================================================
// Response structure invariants
// ===========================================================================

test('Unit: Handler always returns an object with ok: true', async () => {
  const scenarios = [
    { receiver: null, desc: 'null receiver' },
    { receiver: { usageForWindow: () => ({ requests: 1 }) }, desc: 'good receiver' },
    { receiver: { usageForWindow: () => { throw new Error('oops'); } }, desc: 'throwing receiver' },
  ];

  for (const { receiver, desc } of scenarios) {
    const handler = createUsageForWindowHandler(receiver);
    const result = await handler(null, {});
    assert.equal(result.ok, true, `${desc}: ok is always true`);
    assert.ok('usage' in result, `${desc}: usage key always present`);
  }
});

test('Unit: Handler never rejects the Promise (always resolves)', async () => {
  const scenarios = [
    { receiver: null },
    { receiver: { usageForWindow: () => ({ requests: 5 }) } },
    { receiver: { usageForWindow: () => { throw new Error('error'); } } },
    { receiver: { usageForWindow: () => { throw 'weird'; } } },  // eslint-disable-line no-throw-literal
  ];

  for (const { receiver } of scenarios) {
    const handler = createUsageForWindowHandler(receiver);
    let rejected = false;
    try {
      await handler(null, {});
    } catch (e) {
      rejected = true;
    }
    assert.equal(rejected, false, 'handler never rejects');
  }
});

// ===========================================================================
// Edge cases: malformed receiver
// ===========================================================================

test('Unit: Handler with receiver missing usageForWindow method throws → caught', async () => {
  const malformedReceiver = { getUsage: () => ({}) }; // missing usageForWindow
  const handler = createUsageForWindowHandler(malformedReceiver);

  const result = await handler(null, {});
  // Should throw TypeError when calling undefined as function, which is caught
  assert.deepEqual(result, { ok: true, usage: null }, 'missing method throws → caught');
});

test('Unit: Handler with receiver.usageForWindow not a function throws → caught', async () => {
  const malformedReceiver = { usageForWindow: 'not a function' };
  const handler = createUsageForWindowHandler(malformedReceiver);

  const result = await handler(null, {});
  // Should throw TypeError when attempting to call a string, which is caught
  assert.deepEqual(result, { ok: true, usage: null }, 'non-function usageForWindow throws → caught');
});

// ===========================================================================
// Receiver returning various falsy/truthy values
// ===========================================================================

test('Unit: Handler passes through receiver returning null', async () => {
  const receiver = { usageForWindow: () => null };
  const handler = createUsageForWindowHandler(receiver);

  const result = await handler(null, {});
  assert.deepEqual(result, { ok: true, usage: null }, 'receiver returning null passed through');
});

test('Unit: Handler passes through receiver returning undefined', async () => {
  const receiver = { usageForWindow: () => undefined };
  const handler = createUsageForWindowHandler(receiver);

  const result = await handler(null, {});
  assert.deepEqual(result, { ok: true, usage: undefined }, 'receiver returning undefined passed through');
});

test('Unit: Handler passes through receiver returning empty object', async () => {
  const empty = {};
  const receiver = { usageForWindow: () => empty };
  const handler = createUsageForWindowHandler(receiver);

  const result = await handler(null, {});
  assert.strictEqual(result.usage, empty, 'empty object passed through');
});

test('Unit: Handler passes through receiver returning 0 (falsy number)', async () => {
  const receiver = { usageForWindow: () => 0 };
  const handler = createUsageForWindowHandler(receiver);

  const result = await handler(null, {});
  assert.equal(result.usage, 0, 'falsy number (0) passed through');
});

test('Unit: Handler passes through receiver returning false', async () => {
  const receiver = { usageForWindow: () => false };
  const handler = createUsageForWindowHandler(receiver);

  const result = await handler(null, {});
  assert.equal(result.usage, false, 'false passed through');
});

test('Unit: Handler passes through receiver returning empty string', async () => {
  const receiver = { usageForWindow: () => '' };
  const handler = createUsageForWindowHandler(receiver);

  const result = await handler(null, {});
  assert.equal(result.usage, '', 'empty string passed through');
});

// ===========================================================================
// Window argument variations
// ===========================================================================

test('Unit: Handler accepts null window argument', async () => {
  const receiver = { usageForWindow: (window) => {
    // The receiver validates the window, not the handler
    return window === null ? { requests: 0 } : { requests: 1 };
  } };
  const handler = createUsageForWindowHandler(receiver);

  const result = await handler(null, null);
  assert.equal(result.ok, true);
  assert.deepEqual(result.usage, { requests: 0 });
});

test('Unit: Handler accepts undefined window argument', async () => {
  const receiver = { usageForWindow: (window) => {
    return window === undefined ? { requests: 0 } : { requests: 1 };
  } };
  const handler = createUsageForWindowHandler(receiver);

  const result = await handler(null, undefined);
  assert.equal(result.ok, true);
  assert.deepEqual(result.usage, { requests: 0 });
});

test('Unit: Handler accepts arbitrary window argument shapes', async () => {
  const windows = [
    {},
    { startedAt: 'iso-string' },
    { startedAt: 'iso-string', finishedAt: 'iso-string' },
    { startedAt: 'iso-string', finishedAt: 'iso-string', model: 'claude-haiku' },
    'not an object',
    42,
    [],
    { startedAt: null, finishedAt: null },
  ];

  const receiver = { usageForWindow: () => ({ requests: 0 }) };
  const handler = createUsageForWindowHandler(receiver);

  for (const window of windows) {
    const result = await handler(null, window);
    assert.equal(result.ok, true, `accepts window: ${JSON.stringify(window)}`);
  }
});

// ===========================================================================
// Receiver mutating its behavior over calls (state preservation)
// ===========================================================================

test('Unit: Handler invokes receiver for each call (stateless)', async () => {
  let callCount = 0;
  const receiver = {
    usageForWindow() {
      callCount += 1;
      return { requests: callCount };
    },
  };
  const handler = createUsageForWindowHandler(receiver);

  const r1 = await handler(null, {});
  assert.equal(r1.usage.requests, 1, 'first call');

  const r2 = await handler(null, {});
  assert.equal(r2.usage.requests, 2, 'second call');

  const r3 = await handler(null, {});
  assert.equal(r3.usage.requests, 3, 'each call invokes receiver fresh');
});

test('Unit: Handler behavior unchanged when receiver changes its return value', async () => {
  const receiver = {
    nextValue: { requests: 10 },
    usageForWindow() {
      const v = this.nextValue;
      this.nextValue = { requests: 20 };
      return v;
    },
  };
  const handler = createUsageForWindowHandler(receiver);

  const r1 = await handler(null, {});
  assert.equal(r1.usage.requests, 10, 'first call returns first value');

  const r2 = await handler(null, {});
  assert.equal(r2.usage.requests, 20, 'second call returns updated value');
});

// ===========================================================================
// Error in receiver but not in usageForWindow call itself
// ===========================================================================

test('Unit: Handler catches errors thrown from within receiver.usageForWindow', async () => {
  const receiver = {
    usageForWindow() {
      const arr = [];
      return arr[0].toUpperCase(); // throws TypeError: cannot read property of undefined
    },
  };
  const handler = createUsageForWindowHandler(receiver);

  const result = await handler(null, {});
  assert.deepEqual(result, { ok: true, usage: null }, 'internal error caught');
});

test('Unit: Handler is designed for sync receiver.usageForWindow (production is sync)', async () => {
  // The real lib/telemetry-receiver.usageForWindow is synchronous (line 265-267):
  // function usageForWindow(window) {
  //   return tel.usageForWindow(Array.from(store.values()), window);
  // }
  // The handler's try/catch is synchronous and catches sync errors.
  // If someone mistakenly creates an async receiver (not our case), the handler
  // would not await it, but ipcMain.handle (in the real app) still resolves
  // the Promise correctly because the handler is itself async.
  // This documents that the handler works correctly with the sync real receiver.
  const receiver = {
    usageForWindow() {
      return { requests: 0 };
    },
  };
  const handler = createUsageForWindowHandler(receiver);
  const result = await handler(null, {});
  assert.equal(result.ok, true, 'sync handler works with sync receiver');
});
