'use strict';

// ===========================================================================
// TASK-164 — Unit tests for the REAL telemetry:getUsage and
// telemetry:setProjectConfig main.js IPC handlers (TASK-156 follow-up: these
// had zero real-code test coverage before this ticket).
//
// main.js requires('electron') at the top, which is not the real Electron API
// under plain `node --test` — so it can never be require()'d directly here
// (see task-107-mac-unix.test.js's augmentDarwinPath precedent, and
// task-147-telemetry-usage-for-window.test.js's createUsageForWindowHandler
// precedent). Instead, pull the REAL `createGetUsageHandler` /
// `createSetProjectConfigHandler` factory text out of main.js by
// brace-matching and evaluate it headless — no hand-rolled mirror.
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

// The REAL factories from main.js, evaluated headless (main.js's Electron
// entry code is never executed here).
const { createGetUsageHandler, createSetProjectConfigHandler } = new Function(
  extractFn(mainSrc, 'createGetUsageHandler') + '\n' +
  extractFn(mainSrc, 'createSetProjectConfigHandler') + '\n' +
  'return { createGetUsageHandler, createSetProjectConfigHandler };'
)();

// ===========================================================================
// telemetry:getUsage — arg routing
// ===========================================================================

test('getUsage: no arg → calls receiver.getUsage() (app-wide default)', async () => {
  let calledGetUsage = false;
  let calledGetUsageForProject = null;
  const receiver = {
    getUsage: () => { calledGetUsage = true; return { requests: 7 }; },
    getUsageForProject: (p) => { calledGetUsageForProject = p; return { requests: 99 }; },
  };
  const handler = createGetUsageHandler(receiver);

  const result = await handler(null, undefined);

  assert.equal(calledGetUsage, true, 'getUsage() invoked');
  assert.equal(calledGetUsageForProject, null, 'getUsageForProject NOT invoked');
  assert.deepEqual(result, { ok: true, usage: { requests: 7 } });
});

test('getUsage: bare project string arg → calls receiver.getUsageForProject(project)', async () => {
  let calledGetUsage = false;
  let capturedProject = null;
  const receiver = {
    getUsage: () => { calledGetUsage = true; return { requests: 7 }; },
    getUsageForProject: (p) => { capturedProject = p; return { requests: 3 }; },
  };
  const handler = createGetUsageHandler(receiver);

  const result = await handler(null, 'my-project');

  assert.equal(calledGetUsage, false, 'getUsage() NOT invoked');
  assert.equal(capturedProject, 'my-project', 'project string forwarded');
  assert.deepEqual(result, { ok: true, usage: { requests: 3 } });
});

test('getUsage: { project } object arg → calls receiver.getUsageForProject(project)', async () => {
  let calledGetUsage = false;
  let capturedProject = null;
  const receiver = {
    getUsage: () => { calledGetUsage = true; return { requests: 7 }; },
    getUsageForProject: (p) => { capturedProject = p; return { requests: 5 }; },
  };
  const handler = createGetUsageHandler(receiver);

  const result = await handler(null, { project: 'other-project' });

  assert.equal(calledGetUsage, false, 'getUsage() NOT invoked');
  assert.equal(capturedProject, 'other-project', 'project extracted from object');
  assert.deepEqual(result, { ok: true, usage: { requests: 5 } });
});

test('getUsage: {} object with no project field → falls back to getUsage()', async () => {
  let calledGetUsage = false;
  const receiver = {
    getUsage: () => { calledGetUsage = true; return { requests: 1 }; },
    getUsageForProject: () => { throw new Error('should not be called'); },
  };
  const handler = createGetUsageHandler(receiver);

  const result = await handler(null, {});

  assert.equal(calledGetUsage, true);
  assert.deepEqual(result, { ok: true, usage: { requests: 1 } });
});

test('getUsage: empty string project → falls back to getUsage() (falsy project)', async () => {
  let calledGetUsage = false;
  const receiver = {
    getUsage: () => { calledGetUsage = true; return { requests: 2 }; },
    getUsageForProject: () => { throw new Error('should not be called'); },
  };
  const handler = createGetUsageHandler(receiver);

  const result = await handler(null, '');

  assert.equal(calledGetUsage, true);
  assert.deepEqual(result, { ok: true, usage: { requests: 2 } });
});

test('getUsage: no receiver → { ok: true, usage: null }, never throws', async () => {
  const handler = createGetUsageHandler(null);
  const result = await handler(null, 'some-project');
  assert.deepEqual(result, { ok: true, usage: null });
});

test('getUsage: getUsageForProject throws → caught, returns { ok: true, usage: null }', async () => {
  const receiver = {
    getUsage: () => ({ requests: 1 }),
    getUsageForProject: () => { throw new Error('boom'); },
  };
  const handler = createGetUsageHandler(receiver);

  const result = await handler(null, 'bad-project');
  assert.deepEqual(result, { ok: true, usage: null }, 'thrown error caught, defensive null');
});

test('getUsage: non-string project field on object arg → falls back to getUsage()', async () => {
  let calledGetUsage = false;
  const receiver = {
    getUsage: () => { calledGetUsage = true; return { requests: 9 }; },
    getUsageForProject: () => { throw new Error('should not be called'); },
  };
  const handler = createGetUsageHandler(receiver);

  const result = await handler(null, { project: 123 });

  assert.equal(calledGetUsage, true, 'non-string project field ignored');
  assert.deepEqual(result, { ok: true, usage: { requests: 9 } });
});

// ===========================================================================
// telemetry:setProjectConfig
// ===========================================================================

test('setProjectConfig: valid { project, storeOnline } → calls setProjectForwarding with matching args, returns { ok: true }', async () => {
  let capturedArgs = null;
  const receiver = {
    setProjectForwarding: (project, storeOnline) => { capturedArgs = [project, storeOnline]; },
  };
  const handler = createSetProjectConfigHandler(receiver);

  const result = await handler(null, { project: 'proj-a', storeOnline: true });

  assert.deepEqual(capturedArgs, ['proj-a', true], 'setProjectForwarding called with matching args');
  assert.deepEqual(result, { ok: true });
});

test('setProjectConfig: storeOnline: false is forwarded correctly (not coerced away)', async () => {
  let capturedArgs = null;
  const receiver = {
    setProjectForwarding: (project, storeOnline) => { capturedArgs = [project, storeOnline]; },
  };
  const handler = createSetProjectConfigHandler(receiver);

  const result = await handler(null, { project: 'proj-b', storeOnline: false });

  assert.deepEqual(capturedArgs, ['proj-b', false]);
  assert.deepEqual(result, { ok: true });
});

test('setProjectConfig: no receiver → no-ops safely, still returns { ok: true }, never throws', async () => {
  const handler = createSetProjectConfigHandler(null);

  let threw = false;
  let result;
  try { result = await handler(null, { project: 'proj-c', storeOnline: true }); }
  catch (_) { threw = true; }

  assert.equal(threw, false, 'handler never throws with no receiver');
  assert.deepEqual(result, { ok: true });
});

test('setProjectConfig: undefined receiver → no-ops safely, still returns { ok: true }', async () => {
  const handler = createSetProjectConfigHandler(undefined);
  const result = await handler(null, { project: 'proj-d', storeOnline: false });
  assert.deepEqual(result, { ok: true });
});

test('setProjectConfig: receiver.setProjectForwarding throws → caught, still returns { ok: true }', async () => {
  const receiver = {
    setProjectForwarding: () => { throw new Error('boom'); },
  };
  const handler = createSetProjectConfigHandler(receiver);

  let threw = false;
  let result;
  try { result = await handler(null, { project: 'proj-e', storeOnline: true }); }
  catch (_) { threw = true; }

  assert.equal(threw, false, 'thrown error is caught');
  assert.deepEqual(result, { ok: true });
});

test('setProjectConfig: non-object arg → treated as {}, still returns { ok: true }, never throws', async () => {
  let capturedArgs = null;
  const receiver = {
    setProjectForwarding: (project, storeOnline) => { capturedArgs = [project, storeOnline]; },
  };
  const handler = createSetProjectConfigHandler(receiver);

  const result = await handler(null, 'not-an-object');

  assert.deepEqual(capturedArgs, [undefined, undefined], 'junk arg coerced to {} before destructuring');
  assert.deepEqual(result, { ok: true });
});

test('setProjectConfig: null arg → treated as {}, still returns { ok: true }', async () => {
  const receiver = {
    setProjectForwarding: () => {},
  };
  const handler = createSetProjectConfigHandler(receiver);

  const result = await handler(null, null);
  assert.deepEqual(result, { ok: true });
});
