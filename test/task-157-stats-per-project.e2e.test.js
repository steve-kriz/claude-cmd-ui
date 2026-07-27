'use strict';

// ===========================================================================
// TASK-157 — e2e "cucumber" scenarios for per-project stats & telemetry config
// (Given/When/Then) as plain `node --test` cases (no cucumber package).
//
// TASK-168 (review-of TASK-157) REWRITE: the previous version of this file
// only ever did extractFnBody(...) + assert.match(...) against SOURCE TEXT —
// no test ever called the real buildTelemetryControl or initStatsTab, and the
// mock window.api / mock DOM it defined were dead scaffolding, never wired
// into a real invocation. This version LOADS AND INVOKES the REAL
// buildTelemetryControl(tab) (extracted out of renderer.js into an isolated
// Function scope with window/document injected — the loadRendererFns pattern
// from test/task-153-otel-resource-tags.e2e.test.js and
// test/task-162-telemetry-scope-consistency.e2e.test.js, the strongest
// existing template for this problem) behind the mock window.api / mock DOM,
// and asserts on BEHAVIOR: rendered tile values, checkbox state, and the
// exact fs.writeFile / telemetry.setProjectConfig calls made — not on the
// presence of certain lines of source text.
//
// Feature: Per-project Stats tab shows usage scoped to the current project,
// includes a per-project "store online" checkbox that reads/writes
// <project>/tasks/telemetry-config.json, and filters live updates by project.
//
// NO Electron, NO disk I/O, NO real HTTP — window.api/document are fully
// mocked/injected; only renderer.js's own source is read from disk (as text,
// to extract the real functions under test).
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');

// ---------------------------------------------------------------------------
// Brace-matching function extractor (repo convention — see
// test/task-162-telemetry-scope-consistency.e2e.test.js).
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

// Loads the REAL buildTelemetryControl function (and its real collaborators,
// extracted the same way) into an isolated Function scope, with `window` and
// `document` injected.
function loadBuildTelemetryControl(window, document) {
  const body = [
    'let telemetryUnsub = null;',
    extractFn(rendererSrc, 'inferSep'),
    extractFn(rendererSrc, 'appendPath'),
    extractFn(rendererSrc, 'tasksJoin'),
    extractConstLine(rendererSrc, 'TASKS_UNSAFE_KEYS'),
    extractFn(rendererSrc, 'tasksIsUnsafeKey'),
    extractFn(rendererSrc, 'tasksDefaultProjectTelemetryConfig'),
    extractFn(rendererSrc, 'tasksNormalizeProjectTelemetryConfig'),
    extractFn(rendererSrc, 'tasksSerializeProjectTelemetryConfig'),
    extractFn(rendererSrc, 'telFmtInt'),
    extractFn(rendererSrc, 'telFmtUsd'),
    extractFn(rendererSrc, 'buildTelemetryControl'),
    'return { buildTelemetryControl };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function('window', 'document', body)(window, document);
}

// ---------------------------------------------------------------------------
// Mock DOM element with event listeners (extended from the mock DOM already
// written for this file: adds `_trigger` so a test can dispatch a real
// 'change' event to the checkbox's real registered handler, and fixes
// classList.toggle to match the real DOM's force-arg contract).
// ---------------------------------------------------------------------------
function createMockElement(tag) {
  const children = [];
  const listeners = {};
  let text = '';
  let html = '';
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    className: '',
    type: '',
    value: '',
    checked: false,
    disabled: false,
    placeholder: '',
    children,
    classList: {
      add(cls) { el.className = (el.className + ' ' + cls).trim(); },
      remove(cls) { el.className = el.className.split(' ').filter((c) => c !== cls).join(' '); },
      toggle(cls, force) {
        const has = el.className.split(' ').includes(cls);
        const want = force === undefined ? !has : !!force;
        if (want && !has) el.classList.add(cls);
        if (!want && has) el.classList.remove(cls);
      },
      contains(cls) { return el.className.split(' ').includes(cls); },
    },
    appendChild(c) { children.push(c); return c; },
    addEventListener(evt, handler) { (listeners[evt] = listeners[evt] || []).push(handler); },
    removeEventListener(evt, handler) {
      if (listeners[evt]) listeners[evt] = listeners[evt].filter((h) => h !== handler);
    },
    // Dispatches to every currently-registered handler for `evt` — used to
    // simulate the user checking/unchecking the store-online box.
    _trigger(evt, detail) {
      const hs = (listeners[evt] || []).slice();
      for (const h of hs) h(detail || {});
    },
  };
  Object.defineProperty(el, 'textContent', {
    get() { return text; },
    set(v) { text = String(v); children.length = 0; },
  });
  Object.defineProperty(el, 'innerHTML', {
    get() { return html; },
    set(v) { html = String(v); },
  });
  return el;
}

function createMockDocument() {
  return { createElement: (tag) => createMockElement(tag), activeElement: null };
}

// Flushes the microtask queue (Node drains ALL pending/chained microtasks
// before running a setImmediate callback), so awaiting this once after
// buildTelemetryControl mounts is enough for its fire-and-forget refresh()
// (which chains getState -> getUsage -> loadProjectConfig's readFile) to settle.
function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

// Walk the mock DOM tree for a `.team-telemetry-tile` whose label div's
// textContent matches `label`, and return its value div's textContent. Reads
// by LABEL TEXT rather than by tile index/position so this does not silently
// break if the tiles are reordered.
function findTileValue(root, label) {
  let found = null;
  (function walk(el) {
    if (found !== null || !el || !el.children) return;
    for (const c of el.children) {
      if (found !== null) return;
      if (typeof c.className === 'string' && c.className.split(' ').includes('team-telemetry-tile')) {
        const val = c.children[0];
        const lab = c.children[1];
        if (lab && lab.textContent === label) { found = val ? val.textContent : null; return; }
      }
      walk(c);
    }
  })(root);
  return found;
}

// Generic mock-DOM tree walker: returns the first element (depth-first, incl.
// the root) for which `predicate` is true, or null.
function findFirst(root, predicate) {
  let found = null;
  (function walk(el) {
    if (found || !el) return;
    if (predicate(el)) { found = el; return; }
    if (el.children) for (const c of el.children) { if (found) return; walk(c); }
  })(root);
  return found;
}

function hasClass(el, cls) {
  return typeof el.className === 'string' && el.className.split(' ').includes(cls);
}

// The per-project "store online" checkbox lives inside the
// `.team-telemetry-project` wrap — distinct from the app-wide enable/forward
// checkboxes, which live elsewhere in the tree.
function findProjCheckbox(section) {
  const wrap = findFirst(section, (el) => hasClass(el, 'team-telemetry-project'));
  assert.ok(wrap, 'the per-project wrap (.team-telemetry-project) exists in the mounted section');
  const cb = findFirst(wrap, (el) => el.tagName === 'INPUT' && el.type === 'checkbox');
  assert.ok(cb, 'the per-project checkbox exists inside the wrap');
  return cb;
}

function findScopeLine(section) {
  const el = findFirst(section, (el2) => hasClass(el2, 'team-telemetry-scope'));
  assert.ok(el, 'the project-scope line exists in the mounted section');
  return el;
}

// ---------------------------------------------------------------------------
// Mock window.api factory. Every call is recorded in `._calls` so tests can
// assert on EXACT arguments (not just "was called"), which is what lets the
// verbatim-folder scenario below actually catch a normalization regression.
// `opts.usageForFolder(folder)` supplies per-folder usage totals;
// `opts.readFile(path)` supplies the mocked telemetry-config.json read result
// (defaults to "file does not exist").
// ---------------------------------------------------------------------------
function createMockWindowApi(opts) {
  opts = opts || {};
  const calls = { getUsage: [], readFile: [], writeFile: [], mkdir: [], setProjectConfig: [] };
  const api = {
    telemetry: {
      getState: async () => ({ ok: true, state: { enabled: true, running: true } }),
      getUsage: async (project) => {
        calls.getUsage.push(project);
        const usage = typeof opts.usageForFolder === 'function' ? opts.usageForFolder(project) : null;
        return { ok: true, usage: { usage: usage || { totals: {}, byModel: {} } } };
      },
      onUpdate: (cb) => { api._onUpdateCb = cb; return () => { api._onUpdateCb = null; }; },
      setConfig: async () => ({ ok: true, state: {} }),
      clear: async () => {},
      setProjectConfig: async (folder, cfg) => {
        calls.setProjectConfig.push({ folder, cfg });
        return { ok: true };
      },
    },
    fs: {
      readFile: async (p) => {
        calls.readFile.push(p);
        if (typeof opts.readFile === 'function') return opts.readFile(p);
        return { ok: false };
      },
      writeFile: async (p, content) => {
        calls.writeFile.push({ path: p, content });
        return { ok: true };
      },
      mkdir: async (p) => { calls.mkdir.push(p); return { ok: true }; },
    },
  };
  api._calls = calls;
  api._onUpdateCb = null;
  return api;
}

function mount(api, tab) {
  const document = createMockDocument();
  const window = { api };
  const { buildTelemetryControl } = loadBuildTelemetryControl(window, document);
  return buildTelemetryControl(tab);
}

// ===========================================================================
// Scenario: initStatsTab sets the status text with the focused project
// (kept as a source-check: initStatsTab is a thin one-liner wrapper already
// covered behaviourally by test/task-147-stats-tab.e2e.test.js's
// initStatsTabReplica + drift-guard; the real behavioural surface for THIS
// ticket is buildTelemetryControl, exercised for real below).
// ===========================================================================
function extractFnBody(src, header) {
  const fnStart = src.indexOf(header);
  assert.notEqual(fnStart, -1, `${header} found in source`);
  const braceEnd = src.indexOf('\n}', fnStart);
  assert.notEqual(braceEnd, -1, `${header} column-0 closing brace found in source`);
  return src.slice(fnStart, braceEnd + 2);
}

test('Scenario: initStatsTab sets .statsStatus to show the project folder', () => {
  const initStatsTabCode = extractFnBody(rendererSrc, 'function initStatsTab(tab)');
  assert.match(initStatsTabCode, /statsStatus\.textContent = tab\.folder/, 'statsStatus gets folder path');
  assert.match(initStatsTabCode, /\? \('usage & cost — ' \+ tab\.folder\)/, 'shows folder when present');
  assert.match(initStatsTabCode, /: 'usage & cost \(open a folder\)'/, 'shows "open a folder" fallback');
});

// ===========================================================================
// Acceptance: two different tab.folder values produce different rendered
// totals, drawn from a mocked getUsage returning different data per folder.
// ===========================================================================
test('Scenario: two different tab.folder values produce different rendered totals', async () => {
  const usageByFolder = {
    alpha: { totals: { requests: 3, inputTokens: 30, outputTokens: 3, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 33, costUsd: 0.03 }, byModel: {} },
    beta: { totals: { requests: 9, inputTokens: 90, outputTokens: 9, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 99, costUsd: 0.09 }, byModel: {} },
  };
  const apiAlpha = createMockWindowApi({ usageForFolder: (f) => usageByFolder[f] });
  const sectionAlpha = mount(apiAlpha, { folder: 'alpha' });
  await tick();
  assert.equal(findTileValue(sectionAlpha, 'API calls'), '3', "alpha's request count is rendered");
  assert.equal(findTileValue(sectionAlpha, 'Input'), '30', "alpha's input tokens are rendered");

  const apiBeta = createMockWindowApi({ usageForFolder: (f) => usageByFolder[f] });
  const sectionBeta = mount(apiBeta, { folder: 'beta' });
  await tick();
  assert.equal(findTileValue(sectionBeta, 'API calls'), '9', "beta's DIFFERENT request count is rendered");
  assert.equal(findTileValue(sectionBeta, 'Input'), '90', "beta's DIFFERENT input tokens are rendered");

  assert.notEqual(findTileValue(sectionAlpha, 'API calls'), findTileValue(sectionBeta, 'API calls'),
    'two different tab.folder values genuinely produce two different rendered totals');
  assert.deepEqual(apiAlpha._calls.getUsage, ['alpha'], "alpha's panel called getUsage with its own folder");
  assert.deepEqual(apiBeta._calls.getUsage, ['beta'], "beta's panel called getUsage with its own folder");
});

// ===========================================================================
// Acceptance: the checkbox's checked state reflects a mocked config file's
// storeOnline value on mount.
// ===========================================================================
test('Scenario: the store-online checkbox reflects the mocked config file storeOnline:true on mount', async () => {
  const api = createMockWindowApi({
    usageForFolder: () => ({ totals: {}, byModel: {} }),
    readFile: async () => ({ ok: true, content: JSON.stringify({ version: 1, storeOnline: true }) }),
  });
  const section = mount(api, { folder: 'proj1' });
  await tick();
  const cb = findProjCheckbox(section);
  assert.equal(cb.checked, true, 'checkbox reflects storeOnline:true read from the mocked config file');
  assert.equal(cb.disabled, false, 'checkbox is enabled when a folder is open');
});

test('Scenario: the store-online checkbox reflects the mocked config file storeOnline:false on mount', async () => {
  const api = createMockWindowApi({
    usageForFolder: () => ({ totals: {}, byModel: {} }),
    readFile: async () => ({ ok: true, content: JSON.stringify({ version: 1, storeOnline: false }) }),
  });
  const section = mount(api, { folder: 'proj1' });
  await tick();
  const cb = findProjCheckbox(section);
  assert.equal(cb.checked, false, 'checkbox reflects storeOnline:false read from the mocked config file');
});

// ===========================================================================
// Acceptance: checking the box results in BOTH a fs.writeFile call with the
// correct serialized content AND a telemetry.setProjectConfig call with the
// correct (folder, {storeOnline}) args.
// ===========================================================================
test('Scenario: checking the store-online box writes telemetry-config.json AND calls telemetry.setProjectConfig(folder, {storeOnline:true})', async () => {
  const folder = 'C:\\projects\\demo';
  const api = createMockWindowApi({
    usageForFolder: () => ({ totals: {}, byModel: {} }),
    readFile: async () => ({ ok: false }), // no existing config file yet -> defaults unchecked
  });
  const section = mount(api, { folder });
  await tick();
  const projCb = findProjCheckbox(section);
  assert.equal(projCb.checked, false, 'sanity: starts unchecked (no config file yet)');

  // When the user checks the box...
  projCb.checked = true;
  projCb._trigger('change');
  await tick();

  // Then fs.writeFile was called with the correct serialized content...
  assert.equal(api._calls.writeFile.length, 1, 'writeFile was called exactly once');
  const written = api._calls.writeFile[0];
  assert.equal(written.path, folder + '\\tasks\\telemetry-config.json', 'writes to the per-project telemetry-config.json path');
  const parsed = JSON.parse(written.content);
  assert.equal(parsed.storeOnline, true, 'the written config has storeOnline: true');
  assert.ok(written.content.endsWith('\n'), 'serialized content ends with a newline');

  // ...AND telemetry.setProjectConfig was called with the correct (folder, {storeOnline}) args.
  assert.equal(api._calls.setProjectConfig.length, 1, 'setProjectConfig was called exactly once');
  assert.equal(api._calls.setProjectConfig[0].folder, folder, 'setProjectConfig called with the exact folder');
  assert.deepEqual(api._calls.setProjectConfig[0].cfg, { storeOnline: true }, 'setProjectConfig called with { storeOnline: true }');
});

test('Scenario: unchecking the store-online box writes storeOnline:false and calls setProjectConfig(folder, {storeOnline:false})', async () => {
  const folder = 'C:\\projects\\demo';
  const api = createMockWindowApi({
    usageForFolder: () => ({ totals: {}, byModel: {} }),
    readFile: async () => ({ ok: true, content: JSON.stringify({ version: 1, storeOnline: true }) }),
  });
  const section = mount(api, { folder });
  await tick();
  const projCb = findProjCheckbox(section);
  assert.equal(projCb.checked, true, 'sanity: starts checked (config file says storeOnline:true)');

  projCb.checked = false;
  projCb._trigger('change');
  await tick();

  const written = api._calls.writeFile[api._calls.writeFile.length - 1];
  assert.equal(JSON.parse(written.content).storeOnline, false, 'the written config has storeOnline: false');
  const call = api._calls.setProjectConfig[api._calls.setProjectConfig.length - 1];
  assert.deepEqual(call, { folder, cfg: { storeOnline: false } }, 'setProjectConfig called with { storeOnline: false }');
});

// ===========================================================================
// Acceptance: an onUpdate payload with a non-matching project does NOT
// mutate the displayed totals; a matching one does.
// ===========================================================================
test('Scenario: a live onUpdate payload for a DIFFERENT project does not mutate displayed totals; one for the SAME project does', async () => {
  const usageA = { totals: { requests: 2, inputTokens: 20, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 22, costUsd: 0.02 }, byModel: {} };
  const api = createMockWindowApi({
    usageForFolder: (f) => (f === 'projA' ? usageA : { totals: {}, byModel: {} }),
  });
  const section = mount(api, { folder: 'projA' });
  await tick();
  assert.equal(findTileValue(section, 'API calls'), '2', 'refresh() populated projA totals');

  // When a push tagged for a DIFFERENT project arrives...
  api._onUpdateCb({ project: 'projB', projectUsage: { totals: { requests: 999, inputTokens: 9999 }, byModel: {} } });
  // Then the displayed totals are UNCHANGED.
  assert.equal(findTileValue(section, 'API calls'), '2', 'a push for a non-matching project does not mutate the displayed totals');

  // When a push tagged for the SAME project (projA) arrives...
  api._onUpdateCb({ project: 'projA', projectUsage: { totals: { requests: 5, inputTokens: 50 }, byModel: {} } });
  // Then the displayed totals DO update.
  assert.equal(findTileValue(section, 'API calls'), '5', 'a push for the matching project DOES mutate the displayed totals');
  assert.equal(findTileValue(section, 'Input'), '50', 'the matching push updates every tile, not just requests');
});

// ===========================================================================
// Acceptance: a corrupt/malformed config file result leaves the checkbox
// unchecked without throwing.
// ===========================================================================
test('Scenario (edge): a corrupt/malformed config file leaves the checkbox unchecked without throwing', async () => {
  const api = createMockWindowApi({
    usageForFolder: () => ({ totals: {}, byModel: {} }),
    readFile: async () => ({ ok: true, content: 'not valid json {{{' }),
  });
  let section;
  assert.doesNotThrow(() => { section = mount(api, { folder: 'projX' }); }, 'mounting never throws');
  await tick();
  const projCb = findProjCheckbox(section);
  assert.equal(projCb.checked, false, 'corrupt config content defaults the checkbox to unchecked');
});

test('Scenario (edge): a malformed-shape config file (array, not object) leaves the checkbox unchecked without throwing', async () => {
  const api = createMockWindowApi({
    usageForFolder: () => ({ totals: {}, byModel: {} }),
    readFile: async () => ({ ok: true, content: JSON.stringify([1, 2, 3]) }),
  });
  let section;
  assert.doesNotThrow(() => { section = mount(api, { folder: 'projX' }); });
  await tick();
  assert.equal(findProjCheckbox(section).checked, false, 'array-shaped config defaults the checkbox to unchecked');
});

// ===========================================================================
// Acceptance: no folder open renders the degraded/disabled state without
// throwing.
// ===========================================================================
test('Scenario (edge): no folder open renders the degraded/disabled state without throwing', async () => {
  const api = createMockWindowApi({});
  let section;
  assert.doesNotThrow(() => { section = mount(api, { folder: '' }); }, 'mounting with no folder never throws');
  await tick();

  assert.equal(findTileValue(section, 'API calls'), '0', 'zeroed tiles when no folder is open (never falls back to another scope)');
  const projCb = findProjCheckbox(section);
  assert.equal(projCb.checked, false, 'checkbox unchecked when no folder is open');
  assert.equal(projCb.disabled, true, 'checkbox disabled when no folder is open');
  const scopeLine = findScopeLine(section);
  assert.equal(scopeLine.textContent, '(open a folder to see per-project usage)', 'scope line explains there is nothing to scope to');
  assert.equal(api._calls.getUsage.length, 0, 'getUsage is never called when there is no folder to scope to');
});

test('Scenario (edge): buildTelemetryControl(null) / buildTelemetryControl(undefined) never throw', async () => {
  const api = createMockWindowApi({});
  assert.doesNotThrow(() => mount(api, null));
  await tick();
  const api2 = createMockWindowApi({});
  assert.doesNotThrow(() => mount(api2, undefined));
  await tick();
});

// ===========================================================================
// Acceptance: folder/tab.folder is passed VERBATIM through the tested call
// chain — no incidental trim introduced by the test harness. Deliberately
// uses a folder string with leading/trailing whitespace so a hypothetical
// `.trim()` regression in buildTelemetryControl would be caught: the exact
// (untrimmed) `folder` constant below is asserted against every recorded call
// argument, so a trim anywhere in the real call chain would make one of these
// strict-equality/startsWith checks fail.
// ===========================================================================
test('Scenario: tab.folder is passed VERBATIM through getUsage / the config file path / setProjectConfig', async () => {
  const folder = '  C:\\projects\\weird folder  '; // deliberate leading/trailing whitespace
  const api = createMockWindowApi({
    usageForFolder: () => ({ totals: { requests: 1 }, byModel: {} }),
    readFile: async () => ({ ok: false }),
  });
  const section = mount(api, { folder });
  await tick();

  assert.equal(api._calls.getUsage[0], folder, 'getUsage receives the EXACT folder string, untrimmed');
  assert.ok(api._calls.readFile[0].startsWith(folder), 'the config-file read path is built from the folder VERBATIM (leading/trailing space intact)');

  const scopeLine = findScopeLine(section);
  assert.equal(scopeLine.textContent, 'Showing usage for: ' + folder, 'the scope line shows the folder verbatim, not a trimmed copy');

  const projCb = findProjCheckbox(section);
  projCb.checked = true;
  projCb._trigger('change');
  await tick();

  const lastWrite = api._calls.writeFile[api._calls.writeFile.length - 1];
  assert.ok(lastWrite.path.startsWith(folder), 'the config-file WRITE path is also built from the folder verbatim');
  assert.equal(api._calls.setProjectConfig[0].folder, folder, 'setProjectConfig receives the exact, untrimmed folder');
});

// ===========================================================================
// Scenario: Prior listener is detached before resubscribing (kept as a
// source-check — a behavioural equivalent would require asserting a private
// module-level variable, which the real onUpdate mock cannot observe from
// outside; the two-mount call above already proves re-mounting is safe).
// ===========================================================================
test('Scenario: prior telemetry listener is detached before re-subscribing', () => {
  const buildTelemetryCode = extractFnBody(rendererSrc, 'function buildTelemetryControl(tab)');
  assert.match(buildTelemetryCode, /if \(typeof telemetryUnsub === 'function'\)/, 'checks telemetryUnsub before calling');
  assert.match(buildTelemetryCode, /telemetryUnsub\(\)/, 'calls telemetryUnsub to detach');
  assert.match(buildTelemetryCode, /telemetryUnsub = window\.api\.telemetry\.onUpdate\(/, 'subscribes fresh');
});

// ===========================================================================
// Scenario: All user-visible text uses textContent, not innerHTML
// (kept as a source-check: an XSS-prevention convention, not a behavior the
// mock DOM above can meaningfully distinguish since it does not parse HTML).
// ===========================================================================
test('Scenario: All user-visible text uses textContent, not innerHTML, to prevent XSS', () => {
  const buildTelemetryCode = extractFnBody(rendererSrc, 'function buildTelemetryControl(tab)');
  assert.ok(!/\.innerHTML\s*=\s*[^;]*folder/.test(buildTelemetryCode), 'folder path never uses innerHTML');
  assert.ok(!/\.innerHTML\s*=\s*[^;]*project/.test(buildTelemetryCode), 'project labels never use innerHTML');
  assert.match(buildTelemetryCode, /scopeLine\.textContent\s*=\s*folder/, 'scope line uses textContent');
  assert.match(buildTelemetryCode, /status\.textContent\s*=/, 'status uses textContent');
});
