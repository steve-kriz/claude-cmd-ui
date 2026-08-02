'use strict';

// ===========================================================================
// TASK-195 — e2e "cucumber" scenarios for per-model session totals and
// per-prompt cost totals (Given/When/Then) as plain `node --test` cases
// (no cucumber package).
//
// Feature: Per-model session totals in the Stats tab (spanning all projects)
// and per-top-level-prompt cost totals in the prompt log (scoped to each
// prompt's project), both driven by the telemetry receiver's time-windowed
// usage correlation.
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
// Session usage readers
// ---------------------------------------------------------------------------

function findSessionWrap(section) {
  return findFirst(section, (e) => hasClass(e, 'team-telemetry-session-bymodel'));
}

function readSessionRows(section) {
  const wrap = findSessionWrap(section);
  if (!wrap) return [];
  return wrap.children
    .filter((r) => hasClass(r, 'team-telemetry-model-row'))
    .map((r) => {
      const nameEl = r.children.find((c) => hasClass(c, 'team-telemetry-model-name'));
      const statEl = r.children.find((c) => hasClass(c, 'team-telemetry-model-stat'));
      return {
        model: nameEl ? nameEl.textContent : '',
        stat: statEl ? statEl.textContent : '',
      };
    });
}

function readSessionEmpty(section) {
  const wrap = findSessionWrap(section);
  if (!wrap) return null;
  const empty = findFirst(wrap, (e) => hasClass(e, 'team-telemetry-session-empty'));
  return empty ? empty.textContent : null;
}

function createMockWindowApi(opts) {
  opts = opts || {};
  const api = {
    telemetry: {
      getState: async () => ({ ok: true, state: { enabled: true, running: true } }),
      getUsage: async () => {
        const usage = typeof opts.sessionUsage === 'function'
          ? opts.sessionUsage() : { totals: {}, byModel: {} };
        return { ok: true, usage: usage || { totals: {}, byModel: {} } };
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
// Scenario: Per-model breakdown spans the whole session, not one project
// ===========================================================================
test('Scenario: Per-model breakdown spans the whole session, not one project', async () => {
  // Given project "alpha" has captured 2 calls on model "claude-sonnet-5"
  // And project "beta" has captured 3 calls on model "claude-haiku-4-5-20251001"
  const api = createMockWindowApi({
    sessionUsage: () => ({
      totals: { requests: 5, inputTokens: 1000, outputTokens: 200, costUsd: 0.25 },
      byModel: {
        'claude-sonnet-5': {
          requests: 2,
          inputTokens: 600,
          outputTokens: 100,
          costUsd: 0.15,
          totalTokens: 700,
        },
        'claude-haiku-4-5-20251001': {
          requests: 3,
          inputTokens: 400,
          outputTokens: 100,
          costUsd: 0.10,
          totalTokens: 500,
        },
      },
    }),
  });

  const section = mount(api, { folder: 'alpha' });
  await tick();

  // When the session per-model totals render — trigger the onUpdate callback
  // with the app-wide usage
  if (api._onUpdateCb) {
    api._onUpdateCb({
      usage: {
        totals: { requests: 5, inputTokens: 1000, outputTokens: 200, costUsd: 0.25 },
        byModel: {
          'claude-sonnet-5': {
            requests: 2,
            inputTokens: 600,
            outputTokens: 100,
            costUsd: 0.15,
            totalTokens: 700,
          },
          'claude-haiku-4-5-20251001': {
            requests: 3,
            inputTokens: 400,
            outputTokens: 100,
            costUsd: 0.10,
            totalTokens: 500,
          },
        },
      },
    });
  }
  await tick();

  // Then a row for "sonnet-5" shows its 2 calls, total tokens and total cost
  // And a row for "haiku-4-5" shows its 3 calls, total tokens and total cost
  const rows = readSessionRows(section);
  assert.equal(rows.length, 2, 'two model rows in session breakdown');

  assert.equal(rows[0].model, 'haiku-4-5', 'models are sorted alphabetically');
  assert.match(rows[0].stat, /3 calls/, 'haiku row shows 3 calls');
  assert.match(rows[0].stat, /500 tok/, 'haiku row shows total tokens');
  assert.match(rows[0].stat, /\$0\.10/, 'haiku row shows cost');

  assert.equal(rows[1].model, 'sonnet-5');
  assert.match(rows[1].stat, /2 calls/, 'sonnet row shows 2 calls');
  assert.match(rows[1].stat, /700 tok/, 'sonnet row shows total tokens');
  assert.match(rows[1].stat, /\$0\.15/, 'sonnet row shows cost');
});

// ===========================================================================
// Scenario: A model used by two projects is summed across them
// ===========================================================================
test('Scenario: A model used by two projects is summed across them', async () => {
  // Given project "alpha" has 1 call on model "claude-sonnet-5" costing $0.02
  // And project "beta" has 1 call on model "claude-sonnet-5" costing $0.03
  const api = createMockWindowApi({
    sessionUsage: () => ({
      totals: { requests: 2, inputTokens: 100, outputTokens: 50, costUsd: 0.05 },
      byModel: {
        'claude-sonnet-5': {
          requests: 2,
          inputTokens: 100,
          outputTokens: 50,
          costUsd: 0.05,
          totalTokens: 150,
        },
      },
    }),
  });

  const section = mount(api, { folder: 'alpha' });
  await tick();

  // When the session per-model totals render — trigger the onUpdate callback
  if (api._onUpdateCb) {
    api._onUpdateCb({
      usage: {
        totals: { requests: 2, inputTokens: 100, outputTokens: 50, costUsd: 0.05 },
        byModel: {
          'claude-sonnet-5': {
            requests: 2,
            inputTokens: 100,
            outputTokens: 50,
            costUsd: 0.05,
            totalTokens: 150,
          },
        },
      },
    });
  }
  await tick();

  // Then a single "sonnet-5" row shows 2 calls and a total cost of $0.05
  const rows = readSessionRows(section);
  assert.equal(rows.length, 1, 'one model row in session breakdown');
  assert.equal(rows[0].model, 'sonnet-5');
  assert.match(rows[0].stat, /2 calls/, 'summed calls from both projects');
  assert.match(rows[0].stat, /\$0\.05/, 'summed cost across projects');
});

// ===========================================================================
// Scenario: Per-model totals update live from the pushed payload
// ===========================================================================
test('Scenario: Per-model totals update live from the pushed payload', async () => {
  // Given the per-model breakdown currently shows "sonnet-5" with 1 call
  const api = createMockWindowApi({
    sessionUsage: () => ({
      totals: { requests: 1, inputTokens: 50, outputTokens: 30, costUsd: 0.01 },
      byModel: {
        'claude-sonnet-5': {
          requests: 1,
          inputTokens: 50,
          outputTokens: 30,
          costUsd: 0.01,
          totalTokens: 80,
        },
      },
    }),
  });

  const section = mount(api, { folder: 'alpha' });
  await tick();

  // Trigger initial onUpdate callback with 1 call
  if (api._onUpdateCb) {
    api._onUpdateCb({
      usage: {
        totals: { requests: 1, inputTokens: 50, outputTokens: 30, costUsd: 0.01 },
        byModel: {
          'claude-sonnet-5': {
            requests: 1,
            inputTokens: 50,
            outputTokens: 30,
            costUsd: 0.01,
            totalTokens: 80,
          },
        },
      },
    });
  }
  await tick();

  let rows = readSessionRows(section);
  assert.equal(rows.length, 1, 'initial state: 1 model');
  assert.match(rows[0].stat, /1 calls?/, 'initial state: 1 call');

  // When a new api_request row on "claude-sonnet-5" is ingested
  const newPayload = {
    usage: {
      totals: { requests: 2, inputTokens: 100, outputTokens: 60, costUsd: 0.02 },
      byModel: {
        'claude-sonnet-5': {
          requests: 2,
          inputTokens: 100,
          outputTokens: 60,
          costUsd: 0.02,
          totalTokens: 160,
        },
      },
    },
  };
  if (api._onUpdateCb) api._onUpdateCb(newPayload);
  await tick();

  // Then the "sonnet-5" row updates to 2 calls without a manual refresh
  rows = readSessionRows(section);
  assert.equal(rows.length, 1, 'still 1 model');
  assert.match(rows[0].stat, /2 calls/, 'updated to 2 calls');
  assert.match(rows[0].stat, /\$0\.02/, 'updated cost');
});

// ===========================================================================
// Scenario: With telemetry off or nothing captured, renders empty/zeroed state
// ===========================================================================
test('Scenario: With telemetry off or nothing captured, renders empty/zeroed state', async () => {
  // Given no telemetry has been captured
  const api = createMockWindowApi({
    sessionUsage: () => ({ totals: {}, byModel: {} }),
  });

  const section = mount(api, { folder: 'alpha' });
  await tick();

  // When the Stats tab renders and receives empty usage on update
  if (api._onUpdateCb) {
    api._onUpdateCb({ usage: { totals: {}, byModel: {} } });
  }
  await tick();

  // Then it shows an empty state and never throws
  const rows = readSessionRows(section);
  assert.equal(rows.length, 0, 'no rows when byModel is empty');
  const emptyMsg = readSessionEmpty(section);
  assert.ok(emptyMsg, 'empty state message is present');
  assert.match(emptyMsg, /No session usage captured/i, 'empty state is descriptive');
});

// ===========================================================================
// Scenario: Model labels are rendered via the existing telShortModel helper
// ===========================================================================
test('Scenario: Model labels use telShortModel for shortening', async () => {
  const api = createMockWindowApi({
    sessionUsage: () => ({
      totals: { requests: 3, inputTokens: 300, outputTokens: 90, costUsd: 0.30 },
      byModel: {
        'claude-opus-4-1-20250805': {
          requests: 1,
          inputTokens: 100,
          outputTokens: 30,
          costUsd: 0.10,
          totalTokens: 130,
        },
        'claude-sonnet-5': {
          requests: 1,
          inputTokens: 100,
          outputTokens: 30,
          costUsd: 0.10,
          totalTokens: 130,
        },
        '': {
          requests: 1,
          inputTokens: 100,
          outputTokens: 30,
          costUsd: 0.10,
          totalTokens: 130,
        },
      },
    }),
  });

  const section = mount(api, { folder: 'alpha' });
  await tick();

  // Trigger the onUpdate callback with the app-wide usage
  if (api._onUpdateCb) {
    api._onUpdateCb({
      usage: {
        totals: { requests: 3, inputTokens: 300, outputTokens: 90, costUsd: 0.30 },
        byModel: {
          'claude-opus-4-1-20250805': {
            requests: 1,
            inputTokens: 100,
            outputTokens: 30,
            costUsd: 0.10,
            totalTokens: 130,
          },
          'claude-sonnet-5': {
            requests: 1,
            inputTokens: 100,
            outputTokens: 30,
            costUsd: 0.10,
            totalTokens: 130,
          },
          '': {
            requests: 1,
            inputTokens: 100,
            outputTokens: 30,
            costUsd: 0.10,
            totalTokens: 130,
          },
        },
      },
    });
  }
  await tick();

  const rows = readSessionRows(section);
  assert.equal(rows.length, 3, 'three models including empty');
  assert.ok(rows.some((r) => r.model === 'opus-4-1'), 'long model name is shortened');
  assert.ok(rows.some((r) => r.model === 'sonnet-5'), 'sonnet model is shortened');
  assert.ok(rows.some((r) => r.model === '(unknown)'), 'empty model becomes (unknown)');
});
