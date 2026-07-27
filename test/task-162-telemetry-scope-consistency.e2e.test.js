'use strict';

// ===========================================================================
// TASK-162 (review-of TASK-154) — verification + regression-guard tests.
//
// ORIGINAL FINDING (TASK-154 review): getUsage() no-arg scoped to
// activeProject, allegedly inconsistent with the live-update path's app-wide
// totals.
//
// RE-VERIFIED HERE (before writing any test) by reading the CURRENT source:
// TASK-157 completely rewrote buildTelemetryControl(tab) in renderer.js since
// this ticket was filed. As of TASK-157:
//   - refresh() ALWAYS calls window.api.telemetry.getUsage(folder) — an
//     explicit project arg, never a no-arg call — and renders zeroed tiles
//     when folder is empty (renderer/renderer.js, buildTelemetryControl).
//   - The onUpdate handler filters `payload.project === folder` and renders
//     `payload.projectUsage` — also always project-scoped, matching refresh().
//   - The renderer's ONLY call site for telemetry.getUsage is this one, always
//     passing folder.
// So the ORIGINAL inconsistency between refresh() and the live path is
// ALREADY RESOLVED — no functional renderer change was needed. This file adds
// the regression-guard tests the ticket asks for:
//   1. A real-invocation test (buildTelemetryControl loaded via a Function
//      wrapper, mirroring test/task-153-otel-resource-tags.e2e.test.js's
//      loadRendererFns pattern) exercising BOTH the refresh() path and a live
//      onUpdate push for the SAME project, backed by a REAL
//      lib/telemetry-receiver.js instance ingesting rows for two different
//      projects — proving refresh() and onUpdate report the same kind of
//      total for the same data, and that a push for a DIFFERENT project never
//      leaks into the panel's displayed totals.
//   2. An isolated test of lib/telemetry-receiver.js's getUsage() no-arg
//      contract: still activeProject-scoped, falling back to app-wide only
//      when activeProject is itself empty. This function is still callable by
//      other/future code (main.js's telemetry:getUsage IPC handler falls back
//      to it when no project arg is given), so its contract is worth guarding
//      even though the renderer itself never calls it bare anymore.
//
// NO Electron, NO real HTTP socket (rows are ingested directly via the
// receiver's exposed `ingestLogs`), NO disk I/O — window.api/document are
// fully mocked/injected.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTelemetryReceiver } = require('../lib/telemetry-receiver');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');

// ---------------------------------------------------------------------------
// Brace-matching function extractor (repo convention — see
// test/task-153-otel-resource-tags.e2e.test.js's extractFn / extractRealFn).
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
// `document` injected — the loadRendererFns pattern from task-153/task-161,
// applied to buildTelemetryControl instead of source-text regex assertions
// (as used by the older test/task-157-stats-per-project.e2e.test.js).
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
// Minimal mock DOM (mirrors test/task-157-stats-per-project.e2e.test.js's
// createMockElement, trimmed to what buildTelemetryControl actually touches).
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
  };
  Object.defineProperty(el, 'textContent', {
    get() { return text; },
    set(v) { text = String(v); children.length = 0; },
  });
  Object.defineProperty(el, 'innerHTML', { get() { return ''; }, set() {} });
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
// by LABEL TEXT rather than by tile index/position so this test does not
// silently break if the tiles are reordered.
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

// A minimal OTLP/JSON logs payload for one claude_code.api_request row,
// tagged with a `project` resource attribute (mirrors the fixture shape used
// by test/telemetry-receiver.e2e.test.js's "getUsage returns a single
// project's bucket" scenario).
function apiRequestLogsForProject(project, requestId, tokens) {
  return {
    resourceLogs: [{
      resource: { attributes: [{ key: 'project', value: { stringValue: project } }] },
      scopeLogs: [{
        logRecords: [{
          body: { stringValue: 'claude_code.api_request' },
          attributes: [
            { key: 'session.id', value: { stringValue: 's1' } },
            { key: 'event.name', value: { stringValue: 'api_request' } },
            { key: 'model', value: { stringValue: 'claude-haiku' } },
            { key: 'input_tokens', value: { intValue: tokens.input } },
            { key: 'output_tokens', value: { intValue: tokens.output } },
            { key: 'cache_read_tokens', value: { intValue: 0 } },
            { key: 'cache_creation_tokens', value: { intValue: 0 } },
            { key: 'cost_usd', value: { doubleValue: tokens.cost } },
            { key: 'request_id', value: { stringValue: requestId } },
          ],
        }],
      }],
    }],
  };
}

// ===========================================================================
// Acceptance criterion 1 (re-verification): refresh() and onUpdate both
// consistently scope to `folder`.
// ===========================================================================
test('Re-verification: refresh() always calls telemetry.getUsage(folder) — never a no-arg call', () => {
  const src = extractFn(rendererSrc, 'buildTelemetryControl');
  assert.match(src, /await window\.api\.telemetry\.getUsage\(folder\)/,
    'refresh() calls getUsage WITH folder');
  assert.doesNotMatch(src, /telemetry\.getUsage\(\s*\)/,
    'refresh() never calls getUsage() with no arguments');
  assert.match(src, /if \(!folder\) \{[^}]*renderUsage\(null\);/,
    'an empty folder renders zeroed tiles instead of falling back to some other scope');
});

test('Re-verification: the onUpdate handler filters by payload.project === folder', () => {
  const src = extractFn(rendererSrc, 'buildTelemetryControl');
  assert.match(src, /if \(folder && payload\.project === folder && payload\.projectUsage\)/,
    'onUpdate only renders a push whose project matches this panel\'s folder');
  assert.match(src, /renderUsage\(payload\.projectUsage\)/,
    'the matched push renders payload.projectUsage (project-scoped), not payload.usage (app-wide)');
});

// ===========================================================================
// Acceptance criterion 2: refresh() and a live onUpdate push report
// CONSISTENT totals for the same project; a push for a different project
// never leaks into the displayed totals.
// ===========================================================================
test('Scenario: refresh() and a live onUpdate push for the SAME project report consistent totals, and a push for a DIFFERENT project does not affect the display', async () => {
  const rec = createTelemetryReceiver({ config: { enabled: false } });

  const alpha = 'C:\\projects\\alpha';
  const beta = 'C:\\projects\\beta';

  // Given rows ingested for two different projects.
  rec.ingestLogs(apiRequestLogsForProject(alpha, 'reqA1', { input: 10, output: 20, cost: 0.01 }));
  rec.ingestLogs(apiRequestLogsForProject(beta, 'reqB1', { input: 100, output: 200, cost: 0.10 }));

  let onUpdateCb = null;
  const window = {
    api: {
      telemetry: {
        getState: async () => ({ ok: true, state: { enabled: true, running: true } }),
        // Mirrors main.js's real telemetry:getUsage IPC handler for a non-empty
        // project arg: `{ ok: true, usage: telemetryReceiver.getUsageForProject(project) }`.
        getUsage: async (project) => ({ ok: true, usage: rec.getUsageForProject(project) }),
        onUpdate: (cb) => { onUpdateCb = cb; return () => { onUpdateCb = null; }; },
        setConfig: async () => ({ ok: true, state: {} }),
        clear: async () => {},
      },
      fs: {
        readFile: async () => ({ ok: false }),
        writeFile: async () => ({ ok: true }),
        mkdir: async () => ({ ok: true }),
      },
    },
  };
  const document = createMockDocument();
  const { buildTelemetryControl } = loadBuildTelemetryControl(window, document);

  // When the panel mounts for the "alpha" tab
  const tab = { folder: alpha };
  const section = buildTelemetryControl(tab);
  await tick();

  // Then refresh()'s telemetry.getUsage(alpha) populated alpha's real totals.
  assert.equal(findTileValue(section, 'API calls'), '1', 'refresh() shows alpha\'s request count');
  assert.equal(findTileValue(section, 'Input'), '10', 'refresh() shows alpha\'s input tokens');

  // When a NEW row lands for alpha and the live feed pushes alpha's updated
  // snapshot (built via the REAL receiver's snapshotState — the exact payload
  // shape production code emits from ingestLogs' `emit(project)` call).
  rec.ingestLogs(apiRequestLogsForProject(alpha, 'reqA2', { input: 5, output: 5, cost: 0.001 }));
  const alphaPush = rec.snapshotState(alpha);
  assert.equal(alphaPush.project, alpha, 'sanity: the push is tagged for alpha');
  onUpdateCb(alphaPush);

  // Then the SAME tiles refresh() populated now show alpha's new total...
  assert.equal(findTileValue(section, 'API calls'), '2',
    'a live onUpdate push for alpha updates the panel to alpha\'s new request count');
  // ...and that new total agrees with a fresh getUsageForProject(alpha) read —
  // proving refresh() and onUpdate report the SAME kind of total for the same
  // underlying data (this is the actual regression this ticket was filed against).
  assert.equal(rec.getUsageForProject(alpha).usage.totals.requests, 2,
    'a fresh scoped read agrees with what the live push rendered');

  // When a live push tagged for a DIFFERENT project (beta) arrives...
  const betaPush = rec.snapshotState(beta);
  assert.equal(betaPush.project, beta, 'sanity: the push is tagged for beta');
  assert.equal(betaPush.projectUsage.totals.requests, 1, 'sanity: beta has its own distinct total');
  onUpdateCb(betaPush);

  // Then alpha's displayed totals are UNCHANGED — beta's push never leaks in.
  assert.equal(findTileValue(section, 'API calls'), '2',
    'a live push tagged for a different project does not affect this panel\'s displayed totals');
  assert.equal(findTileValue(section, 'Input'), '15',
    'input tokens tile is likewise unaffected by the other project\'s push (10 + 5 from alpha only)');
});

// ===========================================================================
// Acceptance criterion 3: lib/telemetry-receiver.js's getUsage() no-arg
// contract in isolation.
// ===========================================================================
test('Scenario: lib/telemetry-receiver getUsage() no-arg is activeProject-scoped, falling back to app-wide only when activeProject is empty', () => {
  const rec = createTelemetryReceiver({ config: { enabled: false } });

  rec.ingestLogs(apiRequestLogsForProject('projA', 'reqA1', { input: 10, output: 20, cost: 0.01 }));
  rec.ingestLogs(apiRequestLogsForProject('projB', 'reqB1', { input: 100, output: 200, cost: 0.10 }));

  // Given no activeProject has been set (the default before any tab reports
  // itself), getUsage() with no arg falls back to the APP-WIDE roll-up.
  const appWide = rec.getUsage();
  assert.equal(appWide.usage.totals.requests, 2, 'no activeProject set -> getUsage() sums every project');
  assert.equal(appWide.usage.totals.inputTokens, 110);

  // When activeProject is set to "projA"...
  rec.setActiveProject('projA');
  const scopedA = rec.getUsage();
  // Then getUsage() with no arg now reads ONLY projA's bucket, not the app-wide total.
  assert.equal(scopedA.usage.totals.requests, 1, 'getUsage() no-arg scoped to activeProject "projA"');
  assert.equal(scopedA.usage.totals.inputTokens, 10, 'projA-only totals');
  assert.notEqual(scopedA.usage.totals.requests, appWide.usage.totals.requests,
    'the activeProject-scoped total genuinely differs from the app-wide total');

  // And an EXPLICIT project argument still overrides activeProject, regardless
  // of what is currently active.
  const explicitB = rec.getUsage('projB');
  assert.equal(explicitB.usage.totals.requests, 1);
  assert.equal(explicitB.usage.totals.inputTokens, 100,
    'an explicit project arg reads projB even though activeProject is "projA"');

  // And clearing activeProject falls back to app-wide again.
  rec.setActiveProject('');
  const backToAppWide = rec.getUsage();
  assert.equal(backToAppWide.usage.totals.requests, 2, 'clearing activeProject falls back to app-wide again');
});

test('Scenario (edge): getUsage() no-arg for an activeProject with no rows yet yields zero totals, not app-wide fallback', () => {
  const rec = createTelemetryReceiver({ config: { enabled: false } });
  rec.ingestLogs(apiRequestLogsForProject('projA', 'reqA1', { input: 10, output: 20, cost: 0.01 }));

  // Given activeProject is set to a project that has NO rows yet.
  rec.setActiveProject('brand-new-project');
  const scoped = rec.getUsage();

  // Then getUsage() yields zero totals for that (empty) bucket — it does NOT
  // silently fall back to the app-wide total just because the bucket is empty.
  assert.equal(scoped.usage.totals.requests, 0,
    'an activeProject with no rows yields zero, not a fallback to app-wide (which has 1 request)');
});
