'use strict';

// ===========================================================================
// TASK-124 — e2e "cucumber" scenarios (Given/When/Then), implemented as plain
// `node --test` cases. NO `cucumber` npm package is installed or required.
//
// Review follow-ups for TASK-106's build-concurrency Save handler
// (renderer/renderer.js buildWorkflowConcurrencyControl, ~L7199):
//
//   F1 (keep-last-good on a bad Save-time re-read): the Save re-reads
//   tasks/team-config.json for the freshest columns/unknown fields. If that
//   re-read is missing / unreadable / empty / corrupt, it now falls back to the
//   RENDER-TIME rawConfig (keep-last-good) instead of null, so a momentary
//   read/parse failure at Save time can no longer wipe the user's columns /
//   version / skill.planningModel / unknown top-level fields to defaults. A
//   genuinely-valid re-read is still used.
//
//   F2 (immediate toolbar reflection): after a successful write, tab.tasks.config
//   is updated in-memory to exactly what was persisted, so the Tasks toolbar
//   dropdown (syncTasksConcurrencyOption) and buildCommandFor / currentTasksConcurrency
//   reflect the new concurrencyDefault immediately, WITHOUT waiting for the next poll.
//
// The subject under test is the REAL shipped renderer code, extracted headless by
// brace-matching (the task-106 convention) and driven with an injected
// window/document/console/localStorage + a minimal in-memory mock DOM.
//
// This file's window.api.fs stub adds a READ hook (readFailOn / readCorruptOn /
// readEmptyOn / readBinaryOn) on top of the task-106 write `failOn`, so a Save-time
// re-read can be forced to fail/return corrupt WITHOUT ever touching a real file
// beyond a per-test temp dir. NO real DB / Electron / network.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');

function extractFn(src, name) {
  let start = src.indexOf('function ' + name + '(');
  assert.ok(start !== -1, `function ${name} found in renderer.js`);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) { i += 1; break; } }
  }
  return src.slice(start, i);
}
function extractConst(src, name) {
  const m = src.match(new RegExp('const\\s+' + name + '\\s*=[\\s\\S]*?;'));
  assert.ok(m, `const ${name} found in renderer.js`);
  return m[0];
}

// Load the REAL concurrency render + Save path headless.
function loadEditor(window, document, console, localStorage) {
  const body = [
    extractConst(rendererSrc, 'BUILD_COMMAND'),
    extractConst(rendererSrc, 'TASKS_MAX_CONCURRENCY'),
    extractConst(rendererSrc, 'TASKS_DEFAULT_CONCURRENCY'),
    extractConst(rendererSrc, 'TASKS_LANE_STATUSES'),
    extractConst(rendererSrc, 'TASKS_VALID_STATUSES'),
    extractConst(rendererSrc, 'TASKS_UNKNOWN_STATUS'),
    extractConst(rendererSrc, 'TASKS_SYSTEM_LABELS'),
    extractConst(rendererSrc, 'TASKS_RESERVED_SLUGS'),
    extractConst(rendererSrc, 'TASKS_MAX_SLUG_LENGTH'),
    extractConst(rendererSrc, 'TASKS_SLUG_RE'),
    // path helpers
    extractFn(rendererSrc, 'inferSep'),
    extractFn(rendererSrc, 'appendPath'),
    extractFn(rendererSrc, 'tasksJoin'),
    // concurrency resolve chain + config serialize + control
    extractFn(rendererSrc, 'resolveTasksConcurrency'),
    extractFn(rendererSrc, 'readStoredTasksConcurrency'),
    extractFn(rendererSrc, 'tasksConcurrencyStorageKey'),
    extractFn(rendererSrc, 'tasksConfigConcurrencyDefault'),
    extractFn(rendererSrc, 'currentTasksConcurrency'),
    extractFn(rendererSrc, 'populateTasksConcurrencyOptions'),
    extractFn(rendererSrc, 'syncTasksConcurrencyOption'),
    extractFn(rendererSrc, 'initTasksConcurrency'),
    extractFn(rendererSrc, 'buildCommandFor'),
    extractFn(rendererSrc, 'tasksPrettifyLabel'),
    extractFn(rendererSrc, 'tasksBuildColumn'),
    extractFn(rendererSrc, 'normalizeTasksColumns'),
    extractFn(rendererSrc, 'tasksSerializeTeamConfig'),
    // TASK-128: buildWorkingConfigFromRaw / tasksSerializeTeamConfig now skip
    // prototype-poisoning keys via tasksIsUnsafeKey, so the headless harness must
    // extract that symbol (+ the TASKS_UNSAFE_KEYS set it reads).
    extractConst(rendererSrc, 'TASKS_UNSAFE_KEYS'),
    extractFn(rendererSrc, 'tasksIsUnsafeKey'),
    extractFn(rendererSrc, 'buildWorkingConfigFromRaw'),
    extractFn(rendererSrc, 'buildWorkflowConcurrencyControl'),
    // refreshTeamWorkflow is fire-and-forget from the Save handler; stub it so a
    // Save does not re-drive the whole (unmounted) panel. Crucially it does NOT
    // re-read the config into tab.tasks.config — so any config reflection observed
    // right after a Save is the F2 in-memory update, NOT a poll.
    'function refreshTeamWorkflow(){}',
    'return { buildWorkflowConcurrencyControl, buildWorkingConfigFromRaw,',
    '  resolveTasksConcurrency, currentTasksConcurrency, buildCommandFor,',
    '  syncTasksConcurrencyOption, initTasksConcurrency, tasksSerializeTeamConfig,',
    '  tasksJoin };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function('window', 'document', 'console', 'localStorage', body)(
    window, document, console, localStorage);
}

// ---------------------------------------------------------------------------
// Minimal in-memory mock DOM (task-106 style).
// ---------------------------------------------------------------------------
function makeEl(tag) {
  const classes = new Set();
  const children = [];
  const attrs = {};
  let text = '';
  const el = {
    tagName: String(tag || '').toUpperCase(),
    dataset: {}, style: {}, children, attrs,
    _listeners: {},
    disabled: false, value: '', title: '', type: '', id: '', spellcheck: false,
    parentNode: null,
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) { return k in attrs ? attrs[k] : null; },
    classList: {
      add(...cs) { cs.forEach((c) => classes.add(c)); },
      remove(...cs) { cs.forEach((c) => classes.delete(c)); },
      toggle(c, on) { const w = on === undefined ? !classes.has(c) : !!on; if (w) classes.add(c); else classes.delete(c); return w; },
      contains(c) { return classes.has(c); },
    },
    appendChild(c) { children.push(c); c.parentNode = el; return c; },
    addEventListener(t, fn) { (el._listeners[t] = el._listeners[t] || []).push(fn); },
    focus() {},
  };
  Object.defineProperty(el, 'className', {
    get() { return [...classes].join(' '); },
    set(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
  });
  Object.defineProperty(el, 'textContent', {
    get() { return children.length ? children.map((c) => c.textContent).join('') : text; },
    set(v) { text = String(v); children.length = 0; },
  });
  Object.defineProperty(el, 'innerHTML', {
    get() { return ''; },
    set(v) { if (String(v) === '') children.length = 0; },
  });
  Object.defineProperty(el, 'options', { get() { return children; } });
  return el;
}
function makeDocument() {
  return {
    createElement: (tag) => makeEl(tag),
    createTextNode: (t) => ({ _isText: true, textContent: String(t) }),
  };
}
function findByClass(root, cls) {
  for (const c of (root.children || [])) {
    if (c.classList && c.classList.contains(cls)) return c;
    const deep = findByClass(c, cls);
    if (deep) return deep;
  }
  return null;
}
function findButton(root, label) {
  for (const c of (root.children || [])) {
    if (c.tagName === 'BUTTON' && c.textContent === label) return c;
    const deep = findButton(c, label);
    if (deep) return deep;
  }
  return null;
}
async function click(el) {
  const fns = (el && el._listeners && el._listeners.click) || [];
  for (const fn of fns) await fn({ preventDefault() {}, stopPropagation() {} });
}

// ---------------------------------------------------------------------------
// window.api.fs stub backed by REAL node:fs, scoped to a temp dir. Extends the
// task-106 write `failOn` with a READ hook so a Save-time re-read can be forced to
// FAIL / return CORRUPT / EMPTY / BINARY for the config path (the F1 scenario).
// ---------------------------------------------------------------------------
function norm(p) { return String(p).replace(/\\/g, '/').toLowerCase(); }

function makeWindow(opts) {
  const o = opts || {};
  const failOn = o.failOn ? norm(o.failOn) : null;
  const readFailOn = o.readFailOn ? norm(o.readFailOn) : null;
  const readCorruptOn = o.readCorruptOn ? norm(o.readCorruptOn) : null;
  const readEmptyOn = o.readEmptyOn ? norm(o.readEmptyOn) : null;
  const readBinaryOn = o.readBinaryOn ? norm(o.readBinaryOn) : null;
  const calls = { writeFile: [], readFile: [], exists: [], mkdir: [] };
  const window = {
    api: {
      fs: {
        async readFile(p) {
          calls.readFile.push(p);
          const n = norm(p);
          if (readFailOn && n === readFailOn) return { ok: false, error: 'EACCES' };
          if (readCorruptOn && n === readCorruptOn) return { ok: true, content: '{ this is : not valid json,,,' };
          if (readEmptyOn && n === readEmptyOn) return { ok: true, content: '   ' };
          if (readBinaryOn && n === readBinaryOn) return { ok: true, binary: true, content: ' ' };
          try { return { ok: true, content: fs.readFileSync(p, 'utf8') }; }
          catch (e) { return { ok: false, error: e.code || String(e) }; }
        },
        async writeFile(p, content) {
          calls.writeFile.push({ p, content });
          if (failOn && norm(p) === failOn) return { ok: false, error: 'EACCES' };
          try {
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, content);
            return { ok: true, size: Buffer.byteLength(content) };
          } catch (e) { return { ok: false, error: e.code || String(e) }; }
        },
        async exists(p) { calls.exists.push(p); return { ok: true, exists: fs.existsSync(p) }; },
        async mkdir(p) { calls.mkdir.push(p); try { fs.mkdirSync(p, { recursive: true }); } catch (_) {} return { ok: true }; },
      },
    },
  };
  return { window, calls };
}

function makeLocalStorage(seed) {
  const map = new Map(Object.entries(seed || {}));
  return {
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
    _map: map,
  };
}

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't124-'));
  const tasksDir = path.join(root, 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  return { root, tasksDir, cfgPath: path.join(tasksDir, 'team-config.json') };
}
function cleanup(root) { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} }

// A rawConfig carrying user columns + skill.planningModel + unknown top-level
// fields — exactly the state F1 must NOT wipe on a bad Save-time re-read.
function richRawConfig(concurrency) {
  return {
    version: 2,
    columns: [{ status: 'ux-review', label: 'UX Review', description: 'design pass' }],
    skill: { concurrencyDefault: concurrency, planningModel: 'claude-fable-5' },
    someUnknownField: { keep: true },
    anotherUnknown: [1, 2, 3],
  };
}

// ===========================================================================
// F1 — Scenario (failure/edge): a Save-time re-read that FAILS keeps last-good
//   Given a render-time rawConfig with a user column, skill.planningModel and
//         unknown top-level fields, and concurrencyDefault 99 (out of range)
//   When the user clicks Save but the Save-time re-read of team-config.json FAILS
//   Then the written config preserves the columns / version / planningModel /
//        unknown fields FROM rawConfig, with concurrencyDefault clamped to MAX —
//        it is NOT reset to defaults.
// ===========================================================================
test('F1 Scenario (failure): a Save whose re-read FAILS falls back to rawConfig — columns/planningModel/unknown fields preserved, concurrency clamped (not reset to defaults)', async () => {
  const { root, cfgPath } = makeProject();
  try {
    // Given: NO valid file will be produced by the re-read (it is forced to fail).
    // Seed a decoy on disk to prove the failed read result — not the disk bytes —
    // is what drives the fallback.
    fs.writeFileSync(cfgPath, JSON.stringify({ version: 1, columns: [], skill: {} }, null, 2) + '\n');
    const { window, calls } = makeWindow({ readFailOn: cfgPath });
    const mod = loadEditor(window, makeDocument(), console, makeLocalStorage());
    const tab = { folder: root, els: {}, tasks: { config: null } };
    const rawConfig = richRawConfig(99);

    // When the control renders from that rich rawConfig and Save is clicked.
    const control = mod.buildWorkflowConcurrencyControl(tab, rawConfig);
    const select = findByClass(control, 'team-workflow-concurrency-select');
    assert.equal(select.value, '8', 'stored 99 clamps to MAX_CONCURRENCY option on render');
    await click(findButton(control, 'Save'));

    // Then the re-read was attempted (and failed) ...
    assert.ok(calls.readFile.map(norm).includes(norm(cfgPath)), 'Save re-read the config');
    const errEl = findByClass(control, 'team-agent-desc-error');
    assert.ok(errEl.classList.contains('hidden'), 'no error surfaced — the write succeeded');

    // ... and the persisted config preserved everything from rawConfig, with the
    // NEW clamped concurrencyDefault — NOT reset to defaults.
    const persisted = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    assert.equal(persisted.skill.concurrencyDefault, 8, 'concurrency clamped 99 -> 8 and persisted');
    assert.equal(persisted.skill.planningModel, 'claude-fable-5',
      'skill.planningModel preserved from rawConfig (NOT wiped)');
    assert.equal(persisted.version, 2, 'version preserved from rawConfig');
    assert.deepEqual(persisted.someUnknownField, { keep: true }, 'unknown top-level field preserved');
    assert.deepEqual(persisted.anotherUnknown, [1, 2, 3], 'second unknown field preserved');
    assert.deepEqual(persisted.columns.find((c) => c.status === 'ux-review'),
      { status: 'ux-review', label: 'UX Review', description: 'design pass', agent: null, system: false },
      'the user column survived the bad re-read');
    for (const s of ['todo', 'defining', 'in-progress', 'testing', 'post-processing', 'done']) {
      assert.ok(persisted.columns.some((c) => c.status === s), `system column ${s} present`);
    }
  } finally { cleanup(root); }
});

// ===========================================================================
// F1 — Scenario (edge): a Save-time re-read that returns CORRUPT / EMPTY / BINARY
//   likewise keeps the render-time rawConfig (parametrised across the three
//   bad-shape hooks) — never a defaults reset.
// ===========================================================================
test('F1 Scenario (edge): a Save-time re-read returning corrupt/empty/binary content also falls back to rawConfig, preserving user data', async () => {
  const shapes = [
    { label: 'corrupt JSON', opt: 'readCorruptOn' },
    { label: 'empty/whitespace', opt: 'readEmptyOn' },
    { label: 'binary', opt: 'readBinaryOn' },
  ];
  for (const shape of shapes) {
    const { root, cfgPath } = makeProject();
    try {
      const opts = {}; opts[shape.opt] = cfgPath;
      const { window } = makeWindow(opts);
      const mod = loadEditor(window, makeDocument(), console, makeLocalStorage());
      const tab = { folder: root, els: {}, tasks: { config: null } };
      const rawConfig = richRawConfig(5);

      const control = mod.buildWorkflowConcurrencyControl(tab, rawConfig);
      // Change the selection to a new valid value so we can see it land.
      const select = findByClass(control, 'team-workflow-concurrency-select');
      select.value = '6';
      await click(findButton(control, 'Save'));

      const errEl = findByClass(control, 'team-agent-desc-error');
      assert.ok(errEl.classList.contains('hidden'), `${shape.label}: write succeeded, no error`);
      const persisted = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      assert.equal(persisted.skill.concurrencyDefault, 6, `${shape.label}: new value persisted`);
      assert.equal(persisted.skill.planningModel, 'claude-fable-5', `${shape.label}: planningModel preserved`);
      assert.equal(persisted.version, 2, `${shape.label}: version preserved`);
      assert.deepEqual(persisted.someUnknownField, { keep: true }, `${shape.label}: unknown field preserved`);
      assert.ok(persisted.columns.some((c) => c.status === 'ux-review'), `${shape.label}: user column preserved`);
    } finally { cleanup(root); }
  }
});

// ===========================================================================
// F1 — Scenario (happy path, unchanged): a GENUINELY-VALID Save-time re-read is
//   still used — a Board-panel edit that added a column concurrently is picked up,
//   proving the fallback does NOT shadow a good re-read. Mirrors the task-106
//   "99 clamps preserving columns" scenario, which stays green.
// ===========================================================================
test('F1 Scenario (happy path): a valid Save-time re-read is still used — a concurrently-added column on disk is preserved, and 99 clamps to MAX', async () => {
  const { root, cfgPath } = makeProject();
  try {
    // Given a render-time rawConfig (stale — as if a Board-panel edit happened
    // AFTER the workflow panel rendered) with concurrencyDefault 99.
    const rawConfig = richRawConfig(99);
    // And the CURRENT on-disk file (the fresh truth) carries an EXTRA column that
    // rawConfig does not have.
    const diskConfig = {
      version: 2,
      columns: [
        { status: 'ux-review', label: 'UX Review', description: 'design pass' },
        { status: 'qa-signoff', label: 'QA Signoff', description: 'added on the Board panel' },
      ],
      skill: { concurrencyDefault: 3, planningModel: 'claude-fable-5' },
      someUnknownField: { keep: true },
    };
    fs.writeFileSync(cfgPath, JSON.stringify(diskConfig, null, 2) + '\n');

    const { window, calls } = makeWindow(); // no read hook -> real disk read succeeds
    const mod = loadEditor(window, makeDocument(), console, makeLocalStorage());
    const tab = { folder: root, els: {}, tasks: { config: null } };

    const control = mod.buildWorkflowConcurrencyControl(tab, rawConfig);
    const select = findByClass(control, 'team-workflow-concurrency-select');
    assert.equal(select.value, '8', 'stored 99 clamps to MAX on render');
    await click(findButton(control, 'Save'));

    assert.ok(calls.readFile.map(norm).includes(norm(cfgPath)), 'Save re-read the fresh disk config');
    const persisted = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    // Then the freshly-read disk column IS present (valid re-read used) ...
    assert.ok(persisted.columns.some((c) => c.status === 'qa-signoff'),
      'the concurrently-added disk column was preserved (valid re-read used, not rawConfig)');
    assert.ok(persisted.columns.some((c) => c.status === 'ux-review'), 'the shared column is present');
    // ... and 99 (from the render-time control) still clamps to MAX on persist.
    assert.equal(persisted.skill.concurrencyDefault, 8, 'Save persisted the normalized clamped 8');
    assert.equal(persisted.skill.planningModel, 'claude-fable-5', 'planningModel preserved');
  } finally { cleanup(root); }
});

// ===========================================================================
// F2 — Scenario: after a successful Save the toolbar reflects the new default
//   IMMEDIATELY (no poll)
//   Given a Tasks tab with an in-memory config default 3, its toolbar <select>,
//         and no per-folder localStorage override
//   When the user saves a new concurrency default of 6 on the workflow panel
//   Then tab.tasks.config.skill.concurrencyDefault is 6 immediately, and
//        buildCommandFor / currentTasksConcurrency / syncTasksConcurrencyOption all
//        reflect 6 with NO poll having run.
// ===========================================================================
test('F2 Scenario: a successful Save updates tab.tasks.config in-memory so buildCommandFor / currentTasksConcurrency / the toolbar reflect the new default immediately (no poll)', async () => {
  const { root, cfgPath } = makeProject();
  try {
    fs.writeFileSync(cfgPath, JSON.stringify({ version: 1, columns: [], skill: { concurrencyDefault: 3 } }, null, 2) + '\n');
    const { window } = makeWindow();
    const localStorage = makeLocalStorage(); // empty -> no per-folder override
    const mod = loadEditor(window, makeDocument(), console, localStorage);
    const tab = {
      folder: root,
      els: { tasksConcurrency: makeEl('select') },
      tasks: { config: { version: 1, columns: [], skill: { concurrencyDefault: 3 } } },
    };
    // Seed the toolbar to the old default so a lag would be visible.
    mod.initTasksConcurrency(tab);
    assert.equal(tab.els.tasksConcurrency.value, '3', 'toolbar starts at the old config default 3');
    assert.equal(mod.buildCommandFor(tab), '/orchestrate build --concurrency 3', 'command starts at 3');

    // When a new default 6 is saved on the workflow panel.
    const control = mod.buildWorkflowConcurrencyControl(tab, { skill: { concurrencyDefault: 3 } });
    const select = findByClass(control, 'team-workflow-concurrency-select');
    select.value = '6';
    await click(findButton(control, 'Save'));

    // Then tab.tasks.config was updated in-memory IMMEDIATELY (no poll ran —
    // refreshTeamWorkflow is a no-op stub that never re-reads the config).
    assert.equal(tab.tasks.config.skill.concurrencyDefault, 6,
      'tab.tasks.config reflects the new default immediately (F2)');
    // ... and every consumer picks it up without a poll.
    assert.equal(mod.currentTasksConcurrency(tab), 6, 'currentTasksConcurrency reflects 6 immediately');
    assert.equal(mod.buildCommandFor(tab), '/orchestrate build --concurrency 6',
      'buildCommandFor reflects 6 immediately');
    assert.equal(tab.els.tasksConcurrency.value, '6',
      'the toolbar dropdown reflects 6 immediately (syncTasksConcurrencyOption)');
  } finally { cleanup(root); }
});

// ===========================================================================
// F2 — Scenario (edge): an explicit per-folder localStorage override is NOT
//   clobbered by the post-Save toolbar reflection, but tab.tasks.config still
//   updates so a later override-clear surfaces the new default.
// ===========================================================================
test('F2 Scenario (edge): with a per-folder override present, Save updates tab.tasks.config but the toolbar keeps the explicit user choice', async () => {
  const { root, cfgPath } = makeProject();
  try {
    fs.writeFileSync(cfgPath, JSON.stringify({ version: 1, columns: [], skill: { concurrencyDefault: 3 } }, null, 2) + '\n');
    const { window } = makeWindow();
    const localStorage = makeLocalStorage({ ['tasks:concurrency:' + root]: JSON.stringify(2) });
    const mod = loadEditor(window, makeDocument(), console, localStorage);
    const tab = {
      folder: root,
      els: { tasksConcurrency: makeEl('select') },
      tasks: { config: { version: 1, columns: [], skill: { concurrencyDefault: 3 } } },
    };
    mod.initTasksConcurrency(tab);
    assert.equal(tab.els.tasksConcurrency.value, '2', 'toolbar honors the explicit override 2');

    const control = mod.buildWorkflowConcurrencyControl(tab, { skill: { concurrencyDefault: 3 } });
    findByClass(control, 'team-workflow-concurrency-select').value = '6';
    await click(findButton(control, 'Save'));

    // tab.tasks.config updated to the new default (F2 in-memory update) ...
    assert.equal(tab.tasks.config.skill.concurrencyDefault, 6, 'config default updated in-memory');
    // ... but the explicit user override still wins on the toolbar and the command.
    assert.equal(tab.els.tasksConcurrency.value, '2', 'the explicit override is NOT clobbered');
    assert.equal(mod.currentTasksConcurrency(tab), 2, 'override still wins for resolution');
    assert.equal(mod.buildCommandFor(tab), '/orchestrate build --concurrency 2', 'command keeps the override');
  } finally { cleanup(root); }
});

// ===========================================================================
// F2 — Scenario (failure): a FAILED write does NOT update tab.tasks.config
//   (no phantom reflection of a value that never reached disk).
// ===========================================================================
test('F2 Scenario (failure): when the config write FAILS, tab.tasks.config is left unchanged and an error surfaces', async () => {
  const { root, cfgPath } = makeProject();
  try {
    const { window } = makeWindow({ failOn: cfgPath });
    const mod = loadEditor(window, makeDocument(), console, makeLocalStorage());
    const tab = {
      folder: root,
      els: { tasksConcurrency: makeEl('select') },
      tasks: { config: { version: 1, columns: [], skill: { concurrencyDefault: 3 } } },
    };
    const control = mod.buildWorkflowConcurrencyControl(tab, { skill: { concurrencyDefault: 3 } });
    findByClass(control, 'team-workflow-concurrency-select').value = '6';
    await click(findButton(control, 'Save'));

    const errEl = findByClass(control, 'team-agent-desc-error');
    assert.ok(!errEl.classList.contains('hidden'), 'a Save failure surfaces inline');
    assert.match(errEl.textContent, /Save failed/i, 'the inline error explains the failure');
    // tab.tasks.config must NOT be mutated to a value that never persisted.
    assert.equal(tab.tasks.config.skill.concurrencyDefault, 3,
      'a failed write leaves tab.tasks.config unchanged (no phantom reflection)');
    assert.equal(mod.currentTasksConcurrency(tab), 3, 'resolution still reflects the old, persisted value');
  } finally { cleanup(root); }
});
