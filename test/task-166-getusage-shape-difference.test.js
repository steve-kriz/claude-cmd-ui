'use strict';

// TASK-166 — review-of TASK-156: `telemetry:getUsage` intentionally returns a
// DIFFERENT shape depending on whether a project is passed:
//   - no-arg (app-wide)   → { usage, metricTotals, running, recent }
//   - project-scoped      → { usage, recent } ONLY (no metricTotals/running)
//
// This is documented at the source in main.js's createGetUsageHandler and at
// the one renderer consumer (buildTelemetryControl's refresh(), which never
// reads metricTotals/running off a project-scoped result — see
// test/task-162-telemetry-scope-consistency.e2e.test.js).
//
// This test asserts the ACTUAL shape difference end-to-end through the real
// createGetUsageHandler + createTelemetryReceiver — not a mocked receiver —
// so a regression that accidentally adds/removes fields on either branch is
// caught.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTelemetryReceiver } = require('../lib/telemetry-receiver');

// main.js requires('electron') at the top, which is not the real Electron API
// under plain `node --test` — so it can never be require()'d directly here
// (see test/task-164-telemetry-getusage-setprojectconfig.test.js's precedent).
// Instead, pull the REAL `createGetUsageHandler` factory text out of main.js
// by brace-matching and evaluate it headless — no hand-rolled mirror.
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
const { createGetUsageHandler } = new Function(
  extractFn(mainSrc, 'createGetUsageHandler') + '\n' +
  'return { createGetUsageHandler };'
)();

test('telemetry:getUsage no-arg shape: { usage, metricTotals, running, recent }', async () => {
  const rec = createTelemetryReceiver({ config: { enabled: true } });
  await rec.start();
  try {
    const handler = createGetUsageHandler(rec);
    const res = await handler(null, undefined);
    assert.equal(res.ok, true);
    assert.ok(res.usage, 'usage payload present');
    const keys = Object.keys(res.usage).sort();
    assert.deepEqual(keys, ['metricTotals', 'recent', 'running', 'usage'],
      'no-arg getUsage() includes metricTotals/running alongside usage/recent');
  } finally {
    await rec.stop();
  }
});

test('telemetry:getUsage project-scoped shape: { usage, recent } only — no metricTotals/running', async () => {
  const rec = createTelemetryReceiver({ config: { enabled: true } });
  await rec.start();
  try {
    const handler = createGetUsageHandler(rec);
    const res = await handler(null, 'my-project');
    assert.equal(res.ok, true);
    assert.ok(res.usage, 'usage payload present');
    const keys = Object.keys(res.usage).sort();
    assert.deepEqual(keys, ['recent', 'usage'],
      'project-scoped getUsageForProject() omits metricTotals/running by design');
    assert.equal('metricTotals' in res.usage, false);
    assert.equal('running' in res.usage, false);
  } finally {
    await rec.stop();
  }
});

test('telemetry:getUsage { project } object-arg shape matches the bare-string project-scoped shape', async () => {
  const rec = createTelemetryReceiver({ config: { enabled: true } });
  await rec.start();
  try {
    const handler = createGetUsageHandler(rec);
    const res = await handler(null, { project: 'my-project' });
    const keys = Object.keys(res.usage).sort();
    assert.deepEqual(keys, ['recent', 'usage']);
  } finally {
    await rec.stop();
  }
});
