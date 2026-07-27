'use strict';

// ===========================================================================
// TASK-164 — e2e "cucumber" scenarios (Given/When/Then) for the
// telemetry:getUsage and telemetry:setProjectConfig main.js IPC handlers.
//
// Plain `node --test` cases — NO `cucumber` npm package. Exercises the REAL
// main.js handler factories (source-extracted, TASK-164) with MOCK
// telemetryReceiver objects. NO real Electron / network / disk.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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

const { createGetUsageHandler, createSetProjectConfigHandler } = new Function(
  extractFn(mainSrc, 'createGetUsageHandler') + '\n' +
  extractFn(mainSrc, 'createSetProjectConfigHandler') + '\n' +
  'return { createGetUsageHandler, createSetProjectConfigHandler };'
)();

// ===========================================================================
// Feature: telemetry:getUsage routes by arg shape
// ===========================================================================

test('Scenario: No arg given → app-wide default usage is returned via getUsage()', async () => {
  // Given a receiver with distinct app-wide vs per-project totals
  const receiver = {
    getUsage: () => ({ requests: 100, scope: 'app-wide' }),
    getUsageForProject: () => ({ requests: 1, scope: 'per-project' }),
  };
  const handler = createGetUsageHandler(receiver);

  // When telemetry:getUsage is invoked with no argument
  const result = await handler(null, undefined);

  // Then the app-wide totals are returned
  assert.deepEqual(result, { ok: true, usage: { requests: 100, scope: 'app-wide' } });
});

test('Scenario: Bare project name string → per-project usage is returned via getUsageForProject', async () => {
  // Given a receiver that can distinguish which project was asked for
  const receiver = {
    getUsage: () => ({ scope: 'app-wide' }),
    getUsageForProject: (project) => ({ scope: 'per-project', project }),
  };
  const handler = createGetUsageHandler(receiver);

  // When telemetry:getUsage is invoked with a bare project string
  const result = await handler(null, 'checkout-service');

  // Then the per-project totals for that exact project are returned
  assert.deepEqual(result, { ok: true, usage: { scope: 'per-project', project: 'checkout-service' } });
});

test('Scenario: { project } object arg → per-project usage is returned via getUsageForProject', async () => {
  // Given a receiver that can distinguish which project was asked for
  const receiver = {
    getUsage: () => ({ scope: 'app-wide' }),
    getUsageForProject: (project) => ({ scope: 'per-project', project }),
  };
  const handler = createGetUsageHandler(receiver);

  // When telemetry:getUsage is invoked with { project }
  const result = await handler(null, { project: 'billing-service' });

  // Then the per-project totals for that exact project are returned
  assert.deepEqual(result, { ok: true, usage: { scope: 'per-project', project: 'billing-service' } });
});

test('Scenario: No receiver (telemetry off) → getUsage returns null usage, never throws', async () => {
  // Given telemetry is off (no receiver)
  const handler = createGetUsageHandler(null);

  // When getUsage is invoked with any arg shape
  const resultNoArg = await handler(null, undefined);
  const resultString = await handler(null, 'some-project');
  const resultObject = await handler(null, { project: 'some-project' });

  // Then every shape safely returns null usage
  assert.deepEqual(resultNoArg, { ok: true, usage: null });
  assert.deepEqual(resultString, { ok: true, usage: null });
  assert.deepEqual(resultObject, { ok: true, usage: null });
});

// ===========================================================================
// Feature: telemetry:setProjectConfig forwards the store-online toggle
// ===========================================================================

test('Scenario: Valid { project, storeOnline: true } → setProjectForwarding called, { ok: true } returned', async () => {
  // Given a live receiver
  const calls = [];
  const receiver = { setProjectForwarding: (...args) => calls.push(args) };
  const handler = createSetProjectConfigHandler(receiver);

  // When setProjectConfig is invoked for a project turning storage on
  const result = await handler(null, { project: 'inventory-service', storeOnline: true });

  // Then the receiver is told to forward that exact project with that exact flag
  assert.deepEqual(calls, [['inventory-service', true]]);
  assert.deepEqual(result, { ok: true });
});

test('Scenario: No receiver yet (telemetry not started) → safe no-op, still { ok: true }', async () => {
  // Given telemetry hasn't started (no receiver)
  const handler = createSetProjectConfigHandler(null);

  // When setProjectConfig is invoked
  const result = await handler(null, { project: 'inventory-service', storeOnline: true });

  // Then it doesn't throw and still reports success (best-effort contract)
  assert.deepEqual(result, { ok: true });
});

test('Scenario: Receiver throws while applying the toggle → still { ok: true }, error swallowed', async () => {
  // Given a receiver whose setProjectForwarding is broken
  const receiver = { setProjectForwarding: () => { throw new Error('disk full'); } };
  const handler = createSetProjectConfigHandler(receiver);

  // When setProjectConfig is invoked
  let threw = false;
  let result;
  try { result = await handler(null, { project: 'p', storeOnline: false }); }
  catch (_) { threw = true; }

  // Then the caller never sees the error
  assert.equal(threw, false);
  assert.deepEqual(result, { ok: true });
});
