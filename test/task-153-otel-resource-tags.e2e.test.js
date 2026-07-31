'use strict';

// ===========================================================================
// TASK-153 — e2e "cucumber" scenarios (Given/When/Then), implemented as plain
// `node --test` cases. NO cucumber npm package is installed or required.
//
// Feature: Per-project tagging of spawned panes via OTEL_RESOURCE_ATTRIBUTES
//
// Coverage (every Gherkin scenario in the ticket):
//   * A spawn carries the project resource attribute (main.js pty:spawn handler)
//   * The env overlay merges without dropping shell keys (lib/pty.js on win32/POSIX)
//   * The renderer reports the full folder path as the active project
//   * No project means no overlay and unchanged spawn (edge case)
//
// EVERYTHING is INJECTED or MOCKED: platform, pty backend, renderer harness,
// and telemetry receiver. NO real shell, PTY, Electron, DOM, or network.
// ===========================================================================

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const readRepo = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const mainSrc = readRepo('main.js');
const rendererSrc = readRepo(path.join('renderer', 'renderer.js'));
const { spawnShell, __testing: ptytesting } = require('../lib/pty');
const { hasEnvOverlay } = ptytesting;

// main.js requires('electron') at the top, which is not the real Electron API
// under plain `node --test` — so main.js can never be require()'d directly here
// (see task-107-mac-unix.test.js's augmentDarwinPath precedent, and
// task-147-telemetry-usage-for-window.test.js's createUsageForWindowHandler
// precedent). Instead, pull the REAL `buildOtelProjectEnv` function text out of
// main.js by brace-matching and evaluate it headless (TASK-160) — replacing the
// old source-text regex match and hand-rolled ternary mirror.
function extractRealFn(src, name) {
  let start = src.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, `function ${name} present`);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) { i += 1; break; } }
  }
  return src.slice(start, i);
}

// The REAL buildOtelProjectEnv function from main.js, evaluated headless
// (main.js's Electron entry code is never executed here).
const { buildOtelProjectEnv } = new Function(
  extractRealFn(mainSrc, 'buildOtelProjectEnv') + '\nreturn { buildOtelProjectEnv };'
)();

// ---------------------------------------------------------------------------
// Fake pty backend (mirrors task-107-mac-unix.e2e.test.js)
// ---------------------------------------------------------------------------
function makeFakePty() {
  const spawns = [];
  const backend = {
    spawn(file, args, opts) {
      const proc = {
        file, args, opts, writes: [], _dataCb: null,
        write(d) { this.writes.push(d); },
        onData(cb) { this._dataCb = cb; },
        emit(d) { if (this._dataCb) this._dataCb(d); },
      };
      spawns.push(proc);
      return proc;
    },
  };
  return { backend, spawns };
}

// Brace-matching extractor (repo convention) — pull a named function from source
function extractFn(src, name) {
  let start = src.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, `function ${name} present`);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) { i += 1; break; } }
  }
  return src.slice(start, i);
}

// Brace-matching for ipcMain.handle blocks to extract the handler
function extractHandlerBlock(src, channel) {
  const anchor = `ipcMain.handle('${channel}'`;
  let start = src.indexOf(anchor);
  assert.notEqual(start, -1, `ipcMain.handle('${channel}') present`);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) { i += 1; break; } }
  }
  return src.slice(start, i);
}

// ---------------------------------------------------------------------------
// Real-invocation harness for spawnTerm/activateTab (TASK-161). Both are
// extracted headless by brace-matching (task-135 convention) and driven
// against an INJECTED window/document + a minimal in-memory mock DOM, so the
// assertions below exercise the REAL functions' call arguments rather than
// matching source text.
// ---------------------------------------------------------------------------
function makeEl() {
  const classes = new Set();
  return {
    classList: {
      add(...cs) { cs.forEach((c) => classes.add(c)); },
      remove(...cs) { cs.forEach((c) => classes.delete(c)); },
      toggle(c, on) { const w = on === undefined ? !classes.has(c) : !!on; if (w) classes.add(c); else classes.delete(c); return w; },
      contains(c) { return classes.has(c); },
    },
  };
}

function makeFakeTerm(cols, rows) {
  return {
    cols, rows,
    onResize() { return { dispose() {} }; },
    onData() { return { dispose() {} }; },
  };
}

// Loads the REAL spawnTerm and activateTab functions from renderer.js into an
// isolated Function scope, with their side-effecting collaborators injected
// via `deps` (mirrors test/task-135-restart-queue-race.e2e.test.js's loadReal).
function loadRendererFns(window, document, deps) {
  const body = [
    'const ptyToTab = deps.ptyToTab;',
    'const onCmdUserInput = deps.onCmdUserInput;',
    'const captureCmdInput = deps.captureCmdInput;',
    'const crypto = deps.crypto;',
    'const TABS = deps.TABS;',
    'const setTabStatus = deps.setTabStatus;',
    'const fitTab = deps.fitTab;',
    'const requestAnimationFrame = deps.requestAnimationFrame;',
    // activateTab also paints the weekly usage bar and starts its shared poll.
    'const refreshUsageBar = deps.refreshUsageBar || function () {};',
    'const startUsagePolling = deps.startUsagePolling || function () {};',
    'let activeTabId = null;',
    extractFn(rendererSrc, 'spawnTerm'),
    extractFn(rendererSrc, 'activateTab'),
    'return { spawnTerm, activateTab };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function('window', 'document', 'deps', body)(window, document, deps);
}

// ===========================================================================
// Feature: Per-project tagging of spawned panes
// ===========================================================================

test('Scenario: A spawn carries the project resource attribute', () => {
  // Given a pty:spawn request with project "C:\\projects\\alpha"
  const project = 'C:\\projects\\alpha';

  // When the REAL buildOtelProjectEnv function (used by the pty:spawn handler)
  // assembles the env overlay
  const env = buildOtelProjectEnv(project);

  // Then spawnShell receives the correct encoded project attribute
  assert.strictEqual(
    env.OTEL_RESOURCE_ATTRIBUTES,
    'project=C%3A%5Cprojects%5Calpha',
    'project path is URL-encoded with %3A for : and %5C for backslash'
  );
});

test('Scenario: The env overlay merges without dropping shell keys (win32 bash)', () => {
  // Given a win32 bash spawn with an env overlay { OTEL_RESOURCE_ATTRIBUTES: "project=x" }
  const { backend, spawns } = makeFakePty();
  const overlayEnv = { OTEL_RESOURCE_ATTRIBUTES: 'project=x' };

  // When spawnShell spawns the pane with shell "bash" and env overlay on win32
  const proc = spawnShell(
    { shell: 'bash', cwd: 'C:\\proj', env: overlayEnv },
    { platform: 'win32', pty: backend }
  );

  // Then the spawn env contains TERM (from bash spawn)
  assert.ok('TERM' in proc.opts.env, 'spawn env contains TERM');
  assert.equal(proc.opts.env.TERM, 'xterm-256color', 'TERM is set to xterm-256color');

  // And CHERE_INVOKING (win32 bash only)
  assert.ok('CHERE_INVOKING' in proc.opts.env, 'spawn env contains CHERE_INVOKING');
  assert.equal(proc.opts.env.CHERE_INVOKING, '1', 'CHERE_INVOKING is set to 1');

  // And OTEL_RESOURCE_ATTRIBUTES (the overlay)
  assert.ok('OTEL_RESOURCE_ATTRIBUTES' in proc.opts.env, 'spawn env contains OTEL_RESOURCE_ATTRIBUTES');
  assert.equal(proc.opts.env.OTEL_RESOURCE_ATTRIBUTES, 'project=x',
    'OTEL_RESOURCE_ATTRIBUTES from the overlay is present');

  // And process.env entries are included
  assert.ok(Object.keys(process.env).length > 0, 'process.env has keys');
  // At least PATH should be inherited from process.env
  assert.ok('PATH' in proc.opts.env, 'spawn env inherits PATH from process.env');
});

test('Scenario: The renderer reports the full folder path as the active project', async () => {
  // Given a tab whose folder is a known absolute path with subdirectories
  // (so the leaf/basename "dir" differs from the full path).
  const tabFolder = 'C:\\projects\\alpha\\sub\\dir';
  const calls = { setActiveProject: [], setTitle: [] };
  const document = { title: '' };
  const window = {
    api: {
      setTitle: (t) => calls.setTitle.push(t),
      telemetry: { setActiveProject: async (p) => { calls.setActiveProject.push(p); } },
    },
  };
  const TABS = new Map();
  const tab = {
    id: 't1',
    folder: tabFolder,
    status: 'idle',
    els: { ws: makeEl(), tabBtn: makeEl() },
  };
  TABS.set(tab.id, tab);
  const deps = {
    TABS,
    setTabStatus() {},
    fitTab() {},
    requestAnimationFrame: (fn) => fn(),
  };
  const api = loadRendererFns(window, document, deps);

  // When the REAL activateTab function is invoked
  api.activateTab('t1');

  // Then window.api.telemetry.setActiveProject is called with the FULL path,
  // not the leaf/basename ("dir" would be the leaf here).
  assert.equal(calls.setActiveProject.length, 1, 'setActiveProject called exactly once');
  assert.equal(calls.setActiveProject[0], tabFolder,
    'setActiveProject receives the full folder path, not the leaf');
  // And the window title still uses the leaf (unchanged behavior).
  assert.equal(calls.setTitle[0], 'dir', 'window title uses the leaf, not the full path');
});

test('Scenario (edge): No project means no overlay and unchanged spawn', () => {
  // Given a pty:spawn request with an empty/absent project
  // When the REAL buildOtelProjectEnv function assembles the env overlay, it
  // only builds an overlay when project is truthy
  assert.equal(buildOtelProjectEnv(''), undefined, 'empty project → no env overlay');
  assert.equal(buildOtelProjectEnv(null), undefined, 'null project → no env overlay');
  assert.equal(buildOtelProjectEnv(undefined), undefined, 'undefined project → no env overlay');

  // Then the spawn behaves as before (byte-for-byte unchanged)
  const { backend: backend1, spawns: spawns1 } = makeFakePty();
  const proc1 = spawnShell(
    { shell: 'cmd', cwd: 'C:\\proj', env: undefined },
    { platform: 'win32', pty: backend1 }
  );
  assert.equal(proc1.opts.env, process.env,
    'when env overlay is absent, env equals process.env (unchanged behavior)');
});

test('Scenario: spawnTerm includes project: tab.folder in spawnOpts', async () => {
  // Given a tab whose folder is a known value
  const tabFolder = 'C:\\projects\\alpha';
  const calls = { spawn: [], write: [], resize: [] };
  const window = {
    api: {
      pty: {
        spawn: async (opts) => { calls.spawn.push(opts); },
        write: (id, data) => calls.write.push({ id, data }),
        resize: (id, cols, rows) => calls.resize.push({ id, cols, rows }),
      },
    },
  };
  const deps = {
    ptyToTab: new Map(),
    onCmdUserInput() {},
    captureCmdInput() {},
    crypto: { randomUUID: () => 'fixed-id' },
  };
  const api = loadRendererFns(window, /* document */ {}, deps);
  const tab = { folder: tabFolder, cmd: { id: null, term: makeFakeTerm(80, 24), fit: null } };

  // When the REAL spawnTerm function is invoked
  await api.spawnTerm(tab, 'cmd', 'bash', undefined);

  // Then the real call made to window.api.pty.spawn includes project: tab.folder
  assert.equal(calls.spawn.length, 1, 'window.api.pty.spawn called exactly once');
  assert.equal(calls.spawn[0].project, tabFolder, 'spawn opts include project: tab.folder');
  assert.equal(calls.spawn[0].cwd, tabFolder, 'spawn opts cwd is still tab.folder');
});

test('Scenario (edge): A single-segment folder path still reports correctly', async () => {
  // Given a tab whose folder is a single-segment path where leaf and full path are nearly identical
  const tabFolder = 'C:\\alpha';
  const calls = { setActiveProject: [], setTitle: [] };
  const document = { title: '' };
  const window = {
    api: {
      setTitle: (t) => calls.setTitle.push(t),
      telemetry: { setActiveProject: async (p) => { calls.setActiveProject.push(p); } },
    },
  };
  const TABS = new Map();
  const tab = {
    id: 't2',
    folder: tabFolder,
    status: 'idle',
    els: { ws: makeEl(), tabBtn: makeEl() },
  };
  TABS.set(tab.id, tab);
  const deps = {
    TABS,
    setTabStatus() {},
    fitTab() {},
    requestAnimationFrame: (fn) => fn(),
  };
  const api = loadRendererFns(window, document, deps);

  // When the REAL activateTab function is invoked
  api.activateTab('t2');

  // Then window.api.telemetry.setActiveProject is called with the full path "C:\\alpha"
  assert.equal(calls.setActiveProject.length, 1, 'setActiveProject called exactly once');
  assert.equal(calls.setActiveProject[0], tabFolder,
    'setActiveProject receives the single-segment folder path "C:\\alpha"');
  // And the window title still uses the leaf ("alpha" is the leaf here)
  assert.equal(calls.setTitle[0], 'alpha', 'window title uses the leaf "alpha"');
});

test('Scenario (edge): hasEnvOverlay helper guards absent/empty/non-object env', () => {
  // The hasEnvOverlay function should be exported and tested
  assert.equal(typeof hasEnvOverlay, 'function', 'hasEnvOverlay is exported from __testing');

  // Given absent/empty/non-object env values
  assert.equal(hasEnvOverlay(undefined), false, 'hasEnvOverlay(undefined) === false');
  assert.equal(hasEnvOverlay(null), false, 'hasEnvOverlay(null) === false');
  assert.equal(hasEnvOverlay({}), false, 'hasEnvOverlay({}) === false (empty object)');
  assert.equal(hasEnvOverlay(''), false, 'hasEnvOverlay("") === false (not an object)');
  assert.equal(hasEnvOverlay(0), false, 'hasEnvOverlay(0) === false (not an object)');
  assert.equal(hasEnvOverlay(false), false, 'hasEnvOverlay(false) === false');

  // When env has keys
  assert.equal(hasEnvOverlay({ OTEL_RESOURCE_ATTRIBUTES: 'project=x' }), true,
    'hasEnvOverlay({...keys...}) === true');
  assert.equal(hasEnvOverlay({ a: '', b: '' }), true,
    'hasEnvOverlay with even empty-string values === true (keys exist)');
});

test('Scenario: POSIX bash spawn also merges env overlay without dropping TERM', () => {
  // Given platform "darwin" and env overlay
  const overlayEnv = { OTEL_RESOURCE_ATTRIBUTES: 'project=/Users/steve/proj' };
  const { backend, spawns } = makeFakePty();

  // When spawnShell is called with shell "bash" on darwin
  const proc = spawnShell(
    { shell: 'bash', cwd: '/Users/steve/proj', env: overlayEnv },
    { platform: 'darwin', pty: backend }
  );

  // Then TERM is preserved
  assert.ok('TERM' in proc.opts.env, 'POSIX bash env contains TERM');
  assert.equal(proc.opts.env.TERM, 'xterm-256color', 'TERM is set');

  // And CHERE_INVOKING is NOT set (POSIX only)
  assert.ok(!('CHERE_INVOKING' in proc.opts.env), 'CHERE_INVOKING not set on darwin');

  // And the overlay is merged
  assert.ok('OTEL_RESOURCE_ATTRIBUTES' in proc.opts.env, 'overlay merged');
  assert.equal(proc.opts.env.OTEL_RESOURCE_ATTRIBUTES, 'project=/Users/steve/proj');
});

test('Scenario: POSIX cmd (login shell) also merges env overlay without dropping TERM', () => {
  // Given platform "linux" and env overlay
  const overlayEnv = { OTEL_RESOURCE_ATTRIBUTES: 'project=/home/steve/proj' };
  const { backend, spawns } = makeFakePty();

  // When spawnShell is called with shell "cmd" on linux
  const proc = spawnShell(
    { shell: 'cmd', cwd: '/home/steve/proj', env: overlayEnv },
    { platform: 'linux', pty: backend }
  );

  // Then TERM is preserved
  assert.ok('TERM' in proc.opts.env, 'POSIX cmd env contains TERM');
  assert.equal(proc.opts.env.TERM, 'xterm-256color', 'TERM is set');

  // And the overlay is merged
  assert.ok('OTEL_RESOURCE_ATTRIBUTES' in proc.opts.env, 'overlay merged');
  assert.equal(proc.opts.env.OTEL_RESOURCE_ATTRIBUTES, 'project=/home/steve/proj');

  // And process.env entries are included
  assert.ok('PATH' in proc.opts.env, 'process.env entries inherited');
});

test('Scenario: Global OTEL_RESOURCE_ATTRIBUTES is overridden by per-spawn overlay', () => {
  // Given process.env has a global OTEL_RESOURCE_ATTRIBUTES
  const oldOtel = process.env.OTEL_RESOURCE_ATTRIBUTES;
  try {
    process.env.OTEL_RESOURCE_ATTRIBUTES = 'service=global-service';

    // When spawnShell is called with a project-specific env overlay
    const overlayEnv = { OTEL_RESOURCE_ATTRIBUTES: 'project=C:\\projects\\alpha' };
    const { backend } = makeFakePty();
    const proc = spawnShell(
      { shell: 'cmd', cwd: 'C:\\proj', env: overlayEnv },
      { platform: 'win32', pty: backend }
    );

    // Then the per-spawn overlay wins for this pane
    assert.equal(proc.opts.env.OTEL_RESOURCE_ATTRIBUTES, 'project=C:\\projects\\alpha',
      'per-spawn overlay overrides global OTEL_RESOURCE_ATTRIBUTES');
  } finally {
    if (oldOtel === undefined) delete process.env.OTEL_RESOURCE_ATTRIBUTES;
    else process.env.OTEL_RESOURCE_ATTRIBUTES = oldOtel;
  }
});

test('Scenario: worker pane also merges env overlay (win32)', () => {
  // Given platform "win32" with worker shell and env overlay
  const overlayEnv = { OTEL_RESOURCE_ATTRIBUTES: 'project=C:\\proj' };
  const { backend } = makeFakePty();

  // When spawnShell is called with shell "worker"
  const proc = spawnShell(
    { shell: 'worker', worker: 'gemini', cwd: 'C:\\proj', env: overlayEnv },
    { platform: 'win32', pty: backend }
  );

  // Then the overlay is merged
  assert.ok('OTEL_RESOURCE_ATTRIBUTES' in proc.opts.env, 'worker env includes overlay');
  assert.equal(proc.opts.env.OTEL_RESOURCE_ATTRIBUTES, 'project=C:\\proj');
});

test('Scenario: cmd pane merges env overlay (win32)', () => {
  // Given platform "win32" with cmd shell and env overlay
  const overlayEnv = { OTEL_RESOURCE_ATTRIBUTES: 'project=C:\\proj' };
  const { backend } = makeFakePty();

  // When spawnShell is called with shell "cmd"
  const proc = spawnShell(
    { shell: 'cmd', cwd: 'C:\\proj', env: overlayEnv },
    { platform: 'win32', pty: backend }
  );

  // Then the overlay is merged and env === process.env (no extra wrapper)
  assert.ok('OTEL_RESOURCE_ATTRIBUTES' in proc.opts.env);
  // When env overlay is present on win32, it's { ...process.env, ...env }
  assert.equal(proc.opts.env.OTEL_RESOURCE_ATTRIBUTES, 'project=C:\\proj');
});
