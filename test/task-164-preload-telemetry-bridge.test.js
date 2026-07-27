'use strict';

// ===========================================================================
// TASK-164 — Unit tests for the REAL preload.js telemetry bridge functions
// `getUsage(project?)` and `setProjectConfig(project, cfg)` (TASK-156
// follow-up: these had zero real-code test coverage before this ticket).
//
// preload.js calls `require('electron')` and `contextBridge.exposeInMainWorld`
// at module scope, so it can't be require()'d directly under plain
// `node --test` (there's no real Electron contextBridge/ipcRenderer). Instead
// of a hand-rolled mirror of the bridge functions, we intercept Node's
// `Module._load` so `require('electron')` inside preload.js resolves to a
// mock we control, then require the REAL preload.js module and capture the
// exact `api` object it passes to `contextBridge.exposeInMainWorld`. This
// exercises the real bridge function bodies, not a copy.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const PRELOAD_PATH = require.resolve(path.join(__dirname, '..', 'preload.js'));

// Loads the REAL preload.js with a mocked 'electron' module and returns:
// - api: the object passed to contextBridge.exposeInMainWorld('api', ...)
// - invokeCalls: every { channel, payload } passed to ipcRenderer.invoke
function loadPreloadApi() {
  const invokeCalls = [];
  let capturedApi = null;

  const mockElectron = {
    contextBridge: {
      exposeInMainWorld: (name, api) => {
        if (name === 'api') capturedApi = api;
      },
    },
    ipcRenderer: {
      invoke: (channel, payload) => {
        invokeCalls.push({ channel, payload });
        return Promise.resolve({ ok: true });
      },
      on: () => {},
      removeListener: () => {},
    },
    clipboard: {
      readText: () => '',
      writeText: () => {},
    },
  };

  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return mockElectron;
    return originalLoad.apply(this, arguments);
  };

  // Ensure a fresh module evaluation every time (module-scope side effect).
  delete require.cache[PRELOAD_PATH];
  try {
    require(PRELOAD_PATH);
  } finally {
    Module._load = originalLoad;
    // Don't leave the mocked-electron-bound module cached for later requires.
    delete require.cache[PRELOAD_PATH];
  }

  assert.ok(capturedApi, 'contextBridge.exposeInMainWorld("api", ...) was called');
  return { api: capturedApi, invokeCalls };
}

// ===========================================================================
// getUsage(project?)
// ===========================================================================

test('preload getUsage(): no arg → ipcRenderer.invoke("telemetry:getUsage", undefined)', () => {
  const { api, invokeCalls } = loadPreloadApi();

  api.telemetry.getUsage();

  assert.equal(invokeCalls.length, 1);
  assert.equal(invokeCalls[0].channel, 'telemetry:getUsage');
  assert.equal(invokeCalls[0].payload, undefined);
});

test('preload getUsage(project): bare project string → ipcRenderer.invoke("telemetry:getUsage", project)', () => {
  const { api, invokeCalls } = loadPreloadApi();

  api.telemetry.getUsage('my-project');

  assert.equal(invokeCalls.length, 1);
  assert.equal(invokeCalls[0].channel, 'telemetry:getUsage');
  assert.equal(invokeCalls[0].payload, 'my-project', 'bare project string forwarded as-is (not wrapped)');
});

// ===========================================================================
// setProjectConfig(project, cfg)
// ===========================================================================

test('preload setProjectConfig: sends exact channel + { project, storeOnline: cfg.storeOnline } payload shape', () => {
  const { api, invokeCalls } = loadPreloadApi();

  api.telemetry.setProjectConfig('proj-a', { storeOnline: true });

  assert.equal(invokeCalls.length, 1);
  assert.equal(invokeCalls[0].channel, 'telemetry:setProjectConfig');
  assert.deepEqual(invokeCalls[0].payload, { project: 'proj-a', storeOnline: true });
});

test('preload setProjectConfig: storeOnline: false is forwarded (not coerced/dropped)', () => {
  const { api, invokeCalls } = loadPreloadApi();

  api.telemetry.setProjectConfig('proj-b', { storeOnline: false });

  assert.deepEqual(invokeCalls[0].payload, { project: 'proj-b', storeOnline: false });
});

test('preload setProjectConfig: cfg is undefined → storeOnline is undefined (cfg && cfg.storeOnline)', () => {
  const { api, invokeCalls } = loadPreloadApi();

  api.telemetry.setProjectConfig('proj-c', undefined);

  assert.equal(invokeCalls[0].channel, 'telemetry:setProjectConfig');
  assert.deepEqual(invokeCalls[0].payload, { project: 'proj-c', storeOnline: undefined });
});

test('preload setProjectConfig: cfg is null → storeOnline is null (short-circuits, does not throw)', () => {
  const { api, invokeCalls } = loadPreloadApi();

  api.telemetry.setProjectConfig('proj-d', null);

  assert.deepEqual(invokeCalls[0].payload, { project: 'proj-d', storeOnline: null });
});

test('preload setProjectConfig: cfg missing storeOnline key → storeOnline is undefined', () => {
  const { api, invokeCalls } = loadPreloadApi();

  api.telemetry.setProjectConfig('proj-e', {});

  assert.deepEqual(invokeCalls[0].payload, { project: 'proj-e', storeOnline: undefined });
});
