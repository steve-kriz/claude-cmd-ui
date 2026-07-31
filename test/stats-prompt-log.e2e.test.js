'use strict';

// ===========================================================================
// E2e "cucumber" scenarios (Given/When/Then as plain `node --test`
// cases) for the Stats tab's per-prompt log.
//
// Feature: the Stats tab logs every captured API call — when it happened, the
// model that served it, tokens UP (input + cache write + cache read), tokens
// DOWN (output), and that prompt's own cost — newest first, live-updating from
// the receiver's pushed payload, and scoped to the tab's project.
//
// These tests LOAD AND INVOKE the REAL buildTelemetryControl(tab) out of
// renderer.js into an isolated Function scope with window/document injected
// (the loadRendererFns pattern from
// test/task-157-stats-per-project.e2e.test.js) and assert on the RENDERED
// output — not on the presence of lines of source text.
//
// NO Electron, NO disk writes, NO real HTTP: window.api/document are mocked;
// only renderer.js's own source is read (as text, to extract the real
// functions under test).
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');

// ---------------------------------------------------------------------------
// Brace-matching function extractor (repo convention).
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
    extractFn(rendererSrc, 'telNum'),
    extractFn(rendererSrc, 'telUpTokens'),
    extractFn(rendererSrc, 'telDownTokens'),
    extractFn(rendererSrc, 'telShortModel'),
    extractFn(rendererSrc, 'telFmtTime'),
    extractFn(rendererSrc, 'telRowTitle'),
    extractFn(rendererSrc, 'buildTelemetryControl'),
    'return { buildTelemetryControl };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function('window', 'document', body)(window, document);
}

// ---------------------------------------------------------------------------
// Mock DOM (same shape as test/task-157-stats-per-project.e2e.test.js).
// ---------------------------------------------------------------------------
function createMockElement(tag) {
  const children = [];
  const listeners = {};
  let text = '';
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    className: '',
    type: '',
    value: '',
    title: '',
    checked: false,
    disabled: false,
    placeholder: '',
    children,
    classList: {
      add(cls) { el.className = (el.className + ' ' + cls).trim(); },
      remove(cls) { el.className = el.className.split(' ').filter((c) => c !== cls).join(' '); },
      contains(cls) { return el.className.split(' ').includes(cls); },
    },
    appendChild(c) { children.push(c); return c; },
    addEventListener(evt, handler) { (listeners[evt] = listeners[evt] || []).push(handler); },
    removeEventListener(evt, handler) {
      if (listeners[evt]) listeners[evt] = listeners[evt].filter((h) => h !== handler);
    },
    _trigger(evt, detail) { for (const h of (listeners[evt] || []).slice()) h(detail || {}); },
  };
  Object.defineProperty(el, 'textContent', {
    get() { return text; },
    set(v) { text = String(v); children.length = 0; },
  });
  return el;
}

function createMockDocument() {
  return { createElement: (tag) => createMockElement(tag), activeElement: null };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function hasClass(el, cls) {
  return typeof el.className === 'string' && el.className.split(' ').includes(cls);
}

function findFirst(root, predicate) {
  let found = null;
  (function walk(el) {
    if (found || !el) return;
    if (predicate(el)) { found = el; return; }
    if (el.children) for (const c of el.children) { if (found) return; walk(c); }
  })(root);
  return found;
}

// ---------------------------------------------------------------------------
// Log readers — everything is located by CLASS, never by index, so reordering
// the panel's sections cannot silently make these vacuous.
// ---------------------------------------------------------------------------
function findLogRowsWrap(section) {
  const el = findFirst(section, (e) => hasClass(e, 'team-telemetry-log-rows'));
  assert.ok(el, 'the prompt-log rows container (.team-telemetry-log-rows) is mounted');
  return el;
}

function cellText(row, cls) {
  const cell = (row.children || []).find((c) => hasClass(c, cls));
  return cell ? cell.textContent : null;
}

// Reads the rendered log as an array of plain objects, in RENDERED order.
function readLog(section) {
  return findLogRowsWrap(section).children
    .filter((r) => hasClass(r, 'team-telemetry-log-row'))
    .map((r) => ({
      time: cellText(r, 'team-telemetry-log-time'),
      model: cellText(r, 'team-telemetry-log-model'),
      up: cellText(r, 'team-telemetry-log-up'),
      down: cellText(r, 'team-telemetry-log-down'),
      cost: cellText(r, 'team-telemetry-log-cost'),
      title: r.title,
    }));
}

function readLogEmpty(section) {
  const el = findFirst(findLogRowsWrap(section), (e) => hasClass(e, 'team-telemetry-log-empty'));
  return el ? el.textContent : null;
}

function readLogFoot(section) {
  const el = findFirst(section, (e) => hasClass(e, 'team-telemetry-log-foot'));
  assert.ok(el, 'the prompt-log footer is mounted');
  return el.textContent;
}

function readLogCount(section) {
  const el = findFirst(section, (e) => hasClass(e, 'team-telemetry-log-count'));
  assert.ok(el, 'the prompt-log call-count is mounted');
  return el.textContent;
}

// ---------------------------------------------------------------------------
// Mock window.api. `opts.recentForFolder(folder)` supplies the project-scoped
// `recent` rows that getUsage returns alongside `usage` (TASK-166 shape).
// ---------------------------------------------------------------------------
function createMockWindowApi(opts) {
  opts = opts || {};
  const calls = { getUsage: [] };
  const api = {
    telemetry: {
      getState: async () => ({ ok: true, state: { enabled: true, running: true } }),
      getUsage: async (project) => {
        calls.getUsage.push(project);
        const usage = typeof opts.usageForFolder === 'function'
          ? opts.usageForFolder(project) : { totals: {}, byModel: {} };
        const res = { usage: usage || { totals: {}, byModel: {} } };
        if (typeof opts.recentForFolder === 'function') res.recent = opts.recentForFolder(project);
        return { ok: true, usage: res };
      },
      onUpdate: (cb) => { api._onUpdateCb = cb; return () => { api._onUpdateCb = null; }; },
      setConfig: async () => ({ ok: true, state: {} }),
      setProjectConfig: async () => ({ ok: true }),
      clear: async () => {},
    },
    fs: {
      readFile: async () => ({ ok: false }),
      writeFile: async () => ({ ok: true }),
      mkdir: async () => ({ ok: true }),
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

// Three calls on two models: a cache-heavy one, a fresh-context one, and a
// cheap one — enough to prove up/down/model/cost are read PER ROW.
function sampleRows() {
  return [
    {
      requestId: 'req_1', model: 'claude-sonnet-5', timestamp: '2026-07-26T04:05:06.000Z',
      inputTokens: 30, outputTokens: 222, cacheReadTokens: 28905, cacheCreationTokens: 1024, costUsd: 0.0098,
    },
    {
      requestId: 'req_2', model: 'claude-haiku-4-5-20251001', timestamp: '2026-07-26T04:06:07.000Z',
      inputTokens: 1200, outputTokens: 40, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.0012,
    },
    {
      requestId: 'req_3', model: 'claude-haiku-4-5-20251001', timestamp: '2026-07-26T04:07:08.000Z',
      inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheCreationTokens: 0, costUsd: 0.0001,
    },
  ];
}

function localHMS(iso) {
  const d = new Date(iso);
  const p = (n) => (n < 10 ? '0' + n : String(n));
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

// ===========================================================================
// Scenario: the log renders one row per captured call, newest first, with the
// model, tokens up, tokens down and that prompt's cost.
//
//   Given telemetry has captured three API calls for the open project
//   When the Stats tab mounts
//   Then the log shows three rows, newest first, each with time, model,
//        tokens up, tokens down and cost
// ===========================================================================
test('Scenario: the prompt log shows one row per call — newest first — with model, up, down and cost', async () => {
  const rows = sampleRows();
  const api = createMockWindowApi({ recentForFolder: () => rows });
  const section = mount(api, { folder: 'proj1' });
  await tick();

  const log = readLog(section);
  assert.equal(log.length, 3, 'one row per captured API call');

  // Newest first: req_3 (04:07:08) then req_2 then req_1.
  assert.equal(log[0].time, localHMS('2026-07-26T04:07:08.000Z'), 'newest call is at the TOP');
  assert.equal(log[2].time, localHMS('2026-07-26T04:05:06.000Z'), 'oldest call is at the BOTTOM');

  // Row 0 (req_3): up = 10 + 0 + 100, down = 5.
  assert.equal(log[0].model, 'haiku-4-5', 'model column shows the short model label');
  assert.equal(log[0].up, '↑ 110', 'tokens up = input + cache write + cache read');
  assert.equal(log[0].down, '↓ 5', 'tokens down = output');
  assert.equal(log[0].cost, '$0.0001', "the row shows THAT prompt's cost");

  // Row 1 (req_2): a no-cache call — up is just its input.
  assert.equal(log[1].model, 'haiku-4-5');
  assert.equal(log[1].up, '↑ 1200');
  assert.equal(log[1].down, '↓ 40');
  assert.equal(log[1].cost, '$0.0012');

  // Row 2 (req_1): the cache-heavy call on the OTHER model.
  assert.equal(log[2].model, 'sonnet-5', 'each row reports its own model, not a panel-wide one');
  assert.equal(log[2].up, '↑ 29959', 'cached context counts as up-traffic (30 + 1024 + 28905)');
  assert.equal(log[2].down, '↓ 222');
  assert.equal(log[2].cost, '$0.0098');

  assert.equal(readLogCount(section), '3 calls', 'the header reports how many calls are logged');
});

// ===========================================================================
// Scenario: the full per-call breakdown is available on hover.
// ===========================================================================
test('Scenario: each log row carries the full token/cost breakdown as its tooltip', async () => {
  const api = createMockWindowApi({ recentForFolder: () => sampleRows() });
  const section = mount(api, { folder: 'proj1' });
  await tick();

  const oldest = readLog(section)[2]; // req_1, the cache-heavy sonnet call
  assert.match(oldest.title, /model claude-sonnet-5/, 'the tooltip keeps the FULL model id');
  assert.match(oldest.title, /input 30/);
  assert.match(oldest.title, /cache write 1024/);
  assert.match(oldest.title, /cache read 28905/);
  assert.match(oldest.title, /output 222/);
  assert.match(oldest.title, /up 29959/);
  assert.match(oldest.title, /down 222/);
  assert.match(oldest.title, /cost \$0\.0098/);
});

// ===========================================================================
// Scenario: the footer totals the logged traffic in both directions.
// ===========================================================================
test('Scenario: the prompt log footer sums up-tokens, down-tokens and cost across the logged calls', async () => {
  const api = createMockWindowApi({ recentForFolder: () => sampleRows() });
  const section = mount(api, { folder: 'proj1' });
  await tick();

  // up: 29959 + 1200 + 110 = 31269 · down: 222 + 40 + 5 = 267 · cost: 0.0111
  const foot = readLogFoot(section);
  assert.match(foot, /↑ 31269 up/, 'all up-tokens used');
  assert.match(foot, /↓ 267 down/, 'all down-tokens used');
  assert.match(foot, /\$0\.0111/, 'total cost of the logged prompts');
});

// ===========================================================================
// Scenario: nothing captured yet / no folder open.
// ===========================================================================
test('Scenario: the prompt log shows an empty state when no calls have been captured', async () => {
  const api = createMockWindowApi({ recentForFolder: () => [] });
  const section = mount(api, { folder: 'proj1' });
  await tick();

  assert.equal(readLog(section).length, 0, 'no rows');
  assert.equal(readLogEmpty(section), 'No API calls captured yet.');
  assert.equal(readLogCount(section), '', 'no call count when there are no calls');
  assert.equal(readLogFoot(section), '', 'no totals footer when there are no calls');
});

test('Scenario: the prompt log prompts the user to open a folder when none is open', async () => {
  const api = createMockWindowApi({ recentForFolder: () => sampleRows() });
  const section = mount(api, { folder: '' });
  await tick();

  assert.equal(readLog(section).length, 0, 'a folderless panel logs nothing');
  assert.equal(readLogEmpty(section), '(open a folder to see the prompt log)');
  assert.deepEqual(api._calls.getUsage, [], 'and never asks for usage without a project');
});

test('Scenario: a getUsage result with no recent rows renders the empty state instead of throwing', async () => {
  // An older IPC shape: { usage: { usage } } with no `recent` at all.
  const api = createMockWindowApi({});
  const section = mount(api, { folder: 'proj1' });
  await tick();
  assert.equal(readLog(section).length, 0);
  assert.equal(readLogEmpty(section), 'No API calls captured yet.');
});

// ===========================================================================
// Scenario: live updates. The receiver pushes { project, projectUsage,
// projectRecent }; the log re-renders for THIS project only.
// ===========================================================================
test('Scenario: a live update for this project appends the new call to the top of the log', async () => {
  const rows = sampleRows();
  const api = createMockWindowApi({ recentForFolder: () => rows.slice(0, 1) });
  const section = mount(api, { folder: 'projA' });
  await tick();
  assert.equal(readLog(section).length, 1, 'starts with the one call getUsage returned');

  const newer = {
    requestId: 'req_live', model: 'claude-opus-5', timestamp: '2026-07-26T05:00:00.000Z',
    inputTokens: 500, outputTokens: 900, cacheReadTokens: 1500, cacheCreationTokens: 0, costUsd: 0.25,
  };
  api._onUpdateCb({
    project: 'projA',
    projectUsage: { totals: { requests: 2 }, byModel: {} },
    projectRecent: rows.slice(0, 1).concat([newer]),
  });

  const log = readLog(section);
  assert.equal(log.length, 2, 'the pushed payload alone re-rendered the log — no extra getUsage needed');
  assert.deepEqual(api._calls.getUsage, ['projA'], 'getUsage was NOT called again for the live update');
  assert.equal(log[0].model, 'opus-5', 'the new call is at the top');
  assert.equal(log[0].up, '↑ 2000', 'live row up = 500 + 0 + 1500');
  assert.equal(log[0].down, '↓ 900');
  assert.equal(log[0].cost, '$0.2500');
});

test('Scenario: a live update for a DIFFERENT project leaves this project\'s log untouched', async () => {
  const api = createMockWindowApi({ recentForFolder: () => sampleRows() });
  const section = mount(api, { folder: 'projA' });
  await tick();
  const before = readLog(section);

  api._onUpdateCb({
    project: 'projB',
    projectUsage: { totals: { requests: 999 }, byModel: {} },
    projectRecent: [{
      requestId: 'req_other', model: 'claude-opus-5', timestamp: '2026-07-26T05:00:00.000Z',
      inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 9.99,
    }],
  });

  assert.deepEqual(readLog(section), before, "another project's calls never leak into this log");
});

test('Scenario: a live update without projectRecent leaves the existing log intact', async () => {
  const api = createMockWindowApi({ recentForFolder: () => sampleRows() });
  const section = mount(api, { folder: 'projA' });
  await tick();
  const before = readLog(section);
  assert.equal(before.length, 3);

  // A payload that carries usage but no rows must not blank a good log.
  api._onUpdateCb({ project: 'projA', projectUsage: { totals: { requests: 3 }, byModel: {} } });
  assert.deepEqual(readLog(section), before, 'the log survives a rows-less payload');
});

// ===========================================================================
// Scenario: two projects mounted separately log their own calls only.
// ===========================================================================
test('Scenario: the prompt log is scoped to the tab\'s project', async () => {
  const byFolder = {
    projA: [{
      requestId: 'a1', model: 'claude-sonnet-5', timestamp: '2026-07-26T04:05:06.000Z',
      inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.01,
    }],
    projB: [
      {
        requestId: 'b1', model: 'claude-haiku-4-5-20251001', timestamp: '2026-07-26T04:05:06.000Z',
        inputTokens: 7, outputTokens: 8, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.02,
      },
      {
        requestId: 'b2', model: 'claude-haiku-4-5-20251001', timestamp: '2026-07-26T04:06:06.000Z',
        inputTokens: 9, outputTokens: 9, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.03,
      },
    ],
  };

  const apiA = createMockWindowApi({ recentForFolder: (f) => byFolder[f] });
  const sectionA = mount(apiA, { folder: 'projA' });
  await tick();
  const apiB = createMockWindowApi({ recentForFolder: (f) => byFolder[f] });
  const sectionB = mount(apiB, { folder: 'projB' });
  await tick();

  const logA = readLog(sectionA);
  const logB = readLog(sectionB);
  assert.equal(logA.length, 1, 'projA logs its single call');
  assert.equal(logB.length, 2, 'projB logs its two calls');
  assert.equal(logA[0].model, 'sonnet-5');
  assert.equal(logB[0].cost, '$0.0300', "projB's newest call cost");
  assert.deepEqual(apiA._calls.getUsage, ['projA']);
  assert.deepEqual(apiB._calls.getUsage, ['projB']);
});

// ===========================================================================
// Scenario: a junk/partial row degrades gracefully rather than breaking the log.
// ===========================================================================
test('Scenario: a partial or junk row still renders (zeroes and an unknown model) without throwing', async () => {
  const api = createMockWindowApi({
    recentForFolder: () => [null, {}, { model: 'claude-haiku-4-5-20251001', inputTokens: 'nope', outputTokens: 3 }],
  });
  const section = mount(api, { folder: 'proj1' });
  await tick();

  const log = readLog(section);
  assert.equal(log.length, 3, 'every row is rendered');
  assert.equal(log[0].up, '↑ 0', 'a non-numeric token field reads as 0');
  assert.equal(log[0].down, '↓ 3', 'the valid sibling field is still shown');
  assert.equal(log[1].model, '(unknown)', 'an empty row gets an explicit unknown model');
  assert.equal(log[1].cost, '$0.00');
  assert.equal(log[2].time, '—', 'a missing timestamp renders as an em dash');
});
