'use strict';

// ===========================================================================
// TASK-147 — e2e "cucumber" scenarios (Given/When/Then) for
// telemetry:usageForWindow IPC handler hardening.
//
// Feature: The ipcMain.handle('telemetry:usageForWindow', ...) handler
// wraps its receiver call in try/catch so it never throws, always
// returning { ok: true, usage: <value> } (null on error).
//
// The pure decision logic (lib/telemetry-receiver.usageForWindow,
// which delegates to lib/telemetry.usageForWindow) is unit-tested in
// lib tests. Here we test the MAIN PROCESS HANDLER resilience:
// - receiver throws → handler returns { ok: true, usage: null }
// - receiver returns data → handler returns { ok: true, usage: <data> }
// - no receiver present → handler returns { ok: true, usage: null }
//
// Plain `node --test` cases — NO `cucumber` npm package. Exercises the REAL
// main.js handler factory (source-extracted, TASK-158) with a MOCK
// telemetryReceiver. NO real Electron / network / disk.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Helper: create a mock telemetryReceiver for testing.
function createMockReceiver(opts = {}) {
  const shouldThrow = opts.shouldThrow || false;
  const returnValue = opts.returnValue !== undefined ? opts.returnValue : { requests: 0 };

  return {
    usageForWindow(window) {
      if (shouldThrow) {
        throw new Error('Mock receiver error: usageForWindow failed');
      }
      return returnValue;
    },
  };
}

// main.js requires('electron') at the top, so it can never be require()'d
// directly under plain `node --test` (see task-107-mac-unix.test.js's
// augmentDarwinPath precedent). Instead, pull the REAL
// `createUsageForWindowHandler` factory text out of main.js by brace-matching
// and evaluate it headless (TASK-158) — no hand-rolled mirror.
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
// Scenario 1: Receiver's usageForWindow throws
// Given a telemetry receiver whose usageForWindow throws
// When the handler is invoked with a window argument
// Then it returns { ok: true, usage: null }
// And no error propagates to the caller
// ===========================================================================
test('Scenario: Receiver call throws → handler returns { ok: true, usage: null }', async () => {
  // Given a receiver that throws when usageForWindow is called
  const throwingReceiver = createMockReceiver({ shouldThrow: true });
  const handler = createUsageForWindowHandler(throwingReceiver);

  // When the handler is invoked with a window object
  const window = {
    startedAt: '2026-07-26T04:00:00Z',
    finishedAt: '2026-07-26T05:00:00Z',
  };

  // Then it returns the defensive response without propagating the error
  const result = await handler(null, window);
  assert.deepEqual(result, { ok: true, usage: null }, 'throws receiver → defensive null response');

  // Verify the result structure
  assert.equal(result.ok, true, 'result.ok is true');
  assert.equal(result.usage, null, 'result.usage is null on error');
});

// ===========================================================================
// Scenario 2: Happy path — receiver returns usage totals unchanged
// Given a receiver whose usageForWindow returns a totals object
// When the handler is invoked
// Then it returns { ok: true, usage: <totals> }
// And the totals object is passed through unchanged
// ===========================================================================
test('Scenario: Happy path — receiver returns totals → handler returns { ok: true, usage: <totals> }', async () => {
  // Given a receiver that returns a typical usage totals object
  const expectedUsage = {
    requests: 2,
    inputTokens: 30,
    outputTokens: 15,
    cacheReadTokens: 300,
    cacheCreationTokens: 5,
    totalTokens: 350,
    costUsd: 0.03,
    byModel: { 'claude-haiku-4-5': { requests: 2 } },
  };
  const goodReceiver = createMockReceiver({ returnValue: expectedUsage });
  const handler = createUsageForWindowHandler(goodReceiver);

  // When the handler is invoked with a window object
  const window = {
    startedAt: '2026-07-26T04:14:00Z',
    finishedAt: '2026-07-26T04:20:00Z',
  };

  // Then it returns the usage data wrapped in the handler envelope
  const result = await handler(null, window);
  assert.deepEqual(result, { ok: true, usage: expectedUsage }, 'receiver returns totals → passed through');

  // Verify each field is preserved
  assert.equal(result.usage.requests, 2);
  assert.equal(result.usage.inputTokens, 30);
  assert.equal(result.usage.totalTokens, 350);
  assert.ok(Math.abs(result.usage.costUsd - 0.03) < 1e-9);
});

// ===========================================================================
// Scenario 3: Edge case — no receiver present (telemetry off)
// Given telemetryReceiver is null (telemetry not started)
// When the handler is invoked
// Then it returns { ok: true, usage: null }
// And never attempts to call the receiver
// ===========================================================================
test('Scenario: No receiver present → returns { ok: true, usage: null }', async () => {
  // Given no telemetryReceiver (null — telemetry is off)
  const handler = createUsageForWindowHandler(null);

  // When the handler is invoked with any window argument
  const window = {
    startedAt: '2026-07-26T04:14:00Z',
    finishedAt: '2026-07-26T04:20:00Z',
  };

  // Then it returns the null response without attempting to call a receiver
  const result = await handler(null, window);
  assert.deepEqual(result, { ok: true, usage: null }, 'no receiver → null response');
  assert.equal(result.ok, true);
  assert.equal(result.usage, null);
});

// ===========================================================================
// Edge: Empty window object
// When the handler is invoked with an incomplete/empty window
// Then it still returns a response and never throws
// ===========================================================================
test('Scenario (edge): Empty window object → handler delegates to receiver, never throws', async () => {
  // Given a receiver that returns empty totals for an invalid window
  const emptyTotals = {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };
  const receiver = createMockReceiver({ returnValue: emptyTotals });
  const handler = createUsageForWindowHandler(receiver);

  // When the handler is invoked with an empty window object
  const emptyWindow = {};

  // Then it returns the response without throwing (receiver handles validation)
  const result = await handler(null, emptyWindow);
  assert.equal(result.ok, true, 'result.ok is true');
  assert.deepEqual(result.usage, emptyTotals, 'empty window delegated to receiver');
});

// ===========================================================================
// Edge: Receiver throws a non-standard error
// Given a receiver that throws something other than Error
// When the handler is invoked
// Then it still catches and returns { ok: true, usage: null }
// ===========================================================================
test('Scenario (edge): Receiver throws non-standard error → caught and returns null', async () => {
  // Given a receiver that throws something odd (not an Error instance)
  const weirdReceiver = {
    usageForWindow() {
      throw 'string error';  // eslint-disable-line no-throw-literal
    },
  };
  const handler = createUsageForWindowHandler(weirdReceiver);

  // When the handler is invoked
  const window = { startedAt: '2026-07-26T04:00:00Z', finishedAt: '2026-07-26T05:00:00Z' };

  // Then it still catches and returns the defensive response
  const result = await handler(null, window);
  assert.deepEqual(result, { ok: true, usage: null }, 'non-Error throws also caught');
});

// ===========================================================================
// Scenario: The handler is async and resolves properly
// (matching the real ipcMain.handle contract)
// ===========================================================================
test('Scenario: Handler is async and resolves with the response', async () => {
  // Given an async handler (mirroring real ipcMain.handle contract)
  const receiver = createMockReceiver({ returnValue: { requests: 1 } });
  const handler = createUsageForWindowHandler(receiver);

  // When the handler is awaited
  const promise = handler(null, { startedAt: '2026-07-26T04:00:00Z', finishedAt: '2026-07-26T05:00:00Z' });
  assert.ok(promise instanceof Promise, 'handler returns a Promise');

  // Then it resolves to the response (never rejects)
  const result = await promise;
  assert.deepEqual(result, { ok: true, usage: { requests: 1 } });
});

// ===========================================================================
// Scenario: Receiver returning null/undefined usage is also handled
// (receiver's usageForWindow may defensively return null in some paths)
// ===========================================================================
test('Scenario: Receiver returns null/undefined → handler returns it as-is', async () => {
  // Given a receiver that defensively returns null
  const nullReceiver = createMockReceiver({ returnValue: null });
  const handler = createUsageForWindowHandler(nullReceiver);

  // When the handler is invoked
  const result = await handler(null, { startedAt: '2026-07-26T04:00:00Z', finishedAt: '2026-07-26T05:00:00Z' });

  // Then the null is passed through (receiver's defensive return)
  assert.deepEqual(result, { ok: true, usage: null });
});

// ===========================================================================
// Scenario: Multiple consecutive calls (repeated invocation)
// Given the handler is called multiple times
// Then each call independently handles success/failure
// ===========================================================================
test('Scenario: Repeated calls each independently handle their outcome', async () => {
  const receiver = createMockReceiver({ returnValue: { requests: 5 } });
  const handler = createUsageForWindowHandler(receiver);

  // Call 1: happy path
  let result = await handler(null, { startedAt: '2026-07-26T04:00:00Z', finishedAt: '2026-07-26T05:00:00Z' });
  assert.equal(result.ok, true);
  assert.equal(result.usage.requests, 5);

  // Call 2: same handler, same success
  result = await handler(null, { startedAt: '2026-07-26T05:00:00Z', finishedAt: '2026-07-26T06:00:00Z' });
  assert.equal(result.ok, true);
  assert.equal(result.usage.requests, 5);

  // Call 3: switched to throwing receiver
  const throwingHandler = createUsageForWindowHandler(createMockReceiver({ shouldThrow: true }));
  result = await throwingHandler(null, { startedAt: '2026-07-26T06:00:00Z', finishedAt: '2026-07-26T07:00:00Z' });
  assert.equal(result.ok, true);
  assert.equal(result.usage, null, 'independent error handling');
});
