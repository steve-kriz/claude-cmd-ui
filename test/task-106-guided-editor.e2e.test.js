'use strict';

// ===========================================================================
// TASK-106 — e2e "cucumber" scenarios (Given/When/Then), implemented as plain
// `node --test` cases. NO `cucumber` npm package is installed or required; these
// are scenario-style node:test cases in Given/When/Then form.
//
// Feature: the build-CONCURRENCY-default control that writes
// skill.concurrencyDefault into tasks/team-config.json and seeds the Tasks
// toolbar dropdown / the `/orchestrate build --concurrency N` command.
//
// TASK-203: the per-phase AGENT MODEL editor this file originally also covered
// (buildWorkflowModelEditor, mounted per-phase on the now-removed Workflow
// panel's phase cards) was removed as dead code once its only caller
// (buildWorkflowPhase) was deleted. Agent model/description/tools editing now
// lives exclusively in the Agents panel's full editor (see
// test/task-094-agents-panel.e2e.test.js, test/task-130-agent-regenerate.test.js,
// test/task-130-agent-setup.e2e.test.js), so that coverage is not lost — it is
// just no longer duplicated here. buildWorkflowConcurrencyControl is UNCHANGED
// in behaviour (TASK-202 only relocated its mount point to the Board panel), so
// its scenarios below are kept as-is.
//
// The subject under test is the REAL shipped renderer code (renderer/renderer.js,
// a browser script with no module.exports): buildWorkflowConcurrencyControl,
// buildWorkingConfigFromRaw, tasksSerializeTeamConfig, resolveTasksConcurrency,
// currentTasksConcurrency, syncTasksConcurrencyOption, initTasksConcurrency,
// buildCommandFor — extracted headless by brace-matching (the task-094/task-105
// convention) and driven with an injected window/document/console/localStorage +
// a minimal in-memory mock DOM.
//
// ALL filesystem access goes through a STUBBED window.api.fs that operates on a
// per-test TEMP DIR (real node:fs, but only ever inside os.tmpdir()) so byte-
// preservation can be asserted against actual files. A real SKILL.md is used
// READ-ONLY as a fixture (copied into the temp dir; the original is NEVER
// modified). localStorage is an in-memory stub. NO real DB / Electron / network.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');

// --- Extract a (possibly async) named function declaration by brace-matching. ---
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

// Load the REAL concurrency-control render + save path headless. Injects
// window / document / console / localStorage so nothing accidentally reaches a
// real global.
function loadEditor(window, document, console, localStorage) {
  const body = [
    // --- constants (ordered so cross-references resolve) ---
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
    // TASK-180's `phase` link (TASKS_PHASE_KEYS/tasksNormalizeColumnPhase) was
    // fully removed by TASK-201/203 — tasksBuildColumn no longer has one.
    // --- path helpers ---
    extractFn(rendererSrc, 'inferSep'),
    extractFn(rendererSrc, 'appendPath'),
    extractFn(rendererSrc, 'tasksJoin'),
    extractFn(rendererSrc, 'tasksBasename'),
    // --- concurrency: resolve chain + config serialize + control ---
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
    // TASK-200 — tasksSerializeTeamConfig now normalises skill.contextOptimization
    // via tasksNormalizeContextOptimization, so these must be in scope too.
    extractConst(rendererSrc, 'TASKS_CONTEXT_OPT_LEVELS'),
    extractConst(rendererSrc, 'TASKS_CONTEXT_OPT_DEFAULT'),
    extractFn(rendererSrc, 'tasksNormalizeContextOptimization'),
    extractFn(rendererSrc, 'tasksSerializeTeamConfig'),
    // TASK-128: buildWorkingConfigFromRaw / tasksSerializeTeamConfig now skip
    // prototype-poisoning keys via tasksIsUnsafeKey, so the headless harness must
    // extract that symbol (+ the TASKS_UNSAFE_KEYS set it reads).
    extractConst(rendererSrc, 'TASKS_UNSAFE_KEYS'),
    extractFn(rendererSrc, 'tasksIsUnsafeKey'),
    extractFn(rendererSrc, 'buildWorkingConfigFromRaw'),
    extractFn(rendererSrc, 'buildWorkflowConcurrencyControl'),
    // TASK-202: buildWorkflowConcurrencyControl's Save handler now calls
    // refreshTeamBoard(tab) (the panel it is mounted in), not the removed
    // refreshTeamWorkflow. Stub it so a save does not re-drive the whole
    // (unmounted) panel in these targeted tests.
    'function refreshTeamBoard(){}',
    'return { buildWorkflowConcurrencyControl,',
    '  resolveTasksConcurrency, currentTasksConcurrency, syncTasksConcurrencyOption,',
    '  initTasksConcurrency, buildCommandFor, tasksSerializeTeamConfig,',
    '  buildWorkingConfigFromRaw, tasksJoin };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function('window', 'document', 'console', 'localStorage', body)(
    window, document, console, localStorage);
}

// ---------------------------------------------------------------------------
// Minimal in-memory mock DOM (task-105 style) with setAttribute + a select-ish
// `options` view over children + innerHTML clearing.
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
// A window.api.fs stub backed by REAL node:fs, but scoped to a temp dir. Every
// call is recorded so a test can assert exactly what was (and was NOT) written.
// NO real project file is ever touched.
// ---------------------------------------------------------------------------
function norm(p) { return String(p).replace(/\\/g, '/').toLowerCase(); }

function makeWindow(opts) {
  const o = opts || {};
  const calls = { writeFile: [], readFile: [], exists: [], mkdir: [] };
  const window = {
    api: {
      fs: {
        async readFile(p) {
          calls.readFile.push(p);
          try { return { ok: true, content: fs.readFileSync(p, 'utf8') }; }
          catch (e) { return { ok: false, error: e.code || String(e) }; }
        },
        async writeFile(p, content) {
          calls.writeFile.push({ p, content });
          try {
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, content);
            return { ok: true, size: Buffer.byteLength(content) };
          } catch (e) { return { ok: false, error: e.code || String(e) }; }
        },
        async exists(p) {
          calls.exists.push(p);
          return { ok: true, exists: fs.existsSync(p) };
        },
        async mkdir(p) {
          calls.mkdir.push(p);
          try { fs.mkdirSync(p, { recursive: true }); } catch (_) {}
          return { ok: true };
        },
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

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
}

// Build a temp project dir, optionally seeding a real SKILL.md so a "SKILL.md
// untouched" assertion can Buffer-compare a genuine file before/after a save.
function seedProject(opts) {
  const o = opts || {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't106-'));
  const paths = {};
  if (o.skill) {
    const skillDir = path.join(root, '.claude', 'skills', 'orchestrate');
    fs.mkdirSync(skillDir, { recursive: true });
    const skillPath = path.join(skillDir, 'SKILL.md');
    fs.copyFileSync(path.join(REPO, '.claude', 'skills', 'orchestrate', 'SKILL.md'), skillPath);
    paths.__skill = skillPath;
  }
  return { root, paths };
}

// ===========================================================================
// Scenario: Concurrency default seeds the Tasks dropdown
//   Given skill.concurrencyDefault 5 in team-config.json and no localStorage value
//   When the Tasks tab initializes
//   Then the Parallel dropdown shows 5 and Build queues
//        "/orchestrate build --concurrency 5"
// ===========================================================================
test('Scenario: skill.concurrencyDefault 5 with no localStorage seeds the Tasks dropdown to 5 and the build command to --concurrency 5', async () => {
  // Given a folder whose in-memory config carries skill.concurrencyDefault 5 and
  // NO per-folder localStorage override.
  const { window } = makeWindow();
  const localStorage = makeLocalStorage(); // empty → no override
  const mod = loadEditor(window, makeDocument(), console, localStorage);
  const tab = {
    folder: 'C:\\proj',
    els: { tasksConcurrency: makeEl('select') },
    tasks: { config: { skill: { concurrencyDefault: 5 } } },
  };

  // When the Tasks toolbar dropdown initializes for the folder.
  mod.initTasksConcurrency(tab);

  // Then the dropdown resolves to the config default 5 ...
  assert.equal(tab.els.tasksConcurrency.value, '5', 'dropdown seeded from config default');
  assert.equal(mod.currentTasksConcurrency(tab), 5, 'resolved concurrency is the config default');
  // ... and the queued build command carries it.
  assert.equal(mod.buildCommandFor(tab), '/orchestrate build --concurrency 5',
    'build command reflects the config default');

  // And a per-folder localStorage choice OVERRIDES the config default (documented
  // precedence): set 2, re-init, dropdown + resolved value + command follow it.
  localStorage.setItem('tasks:concurrency:C:\\proj', JSON.stringify(2));
  mod.initTasksConcurrency(tab);
  assert.equal(tab.els.tasksConcurrency.value, '2', 'localStorage override wins over config on init');
  assert.equal(mod.currentTasksConcurrency(tab), 2, 'resolved concurrency honors the override');
  assert.equal(mod.buildCommandFor(tab), '/orchestrate build --concurrency 2',
    'build command follows the localStorage override');

  // And syncTasksConcurrencyOption (config-change reflector) deliberately does NOT
  // clobber that explicit user choice — with an override present it is a no-op.
  mod.syncTasksConcurrencyOption(tab);
  assert.equal(tab.els.tasksConcurrency.value, '2',
    'sync leaves the explicit user choice intact when an override exists');
});

// ===========================================================================
// Scenario: SKILL.md stays read-only (edge)
//   When a concurrency default is saved
//   Then SKILL.md bytes on disk are unchanged (no write ever targets SKILL.md)
// ===========================================================================
test('Scenario (edge): saving a concurrency default never writes SKILL.md; its bytes stay identical', async () => {
  // Given a project with a real SKILL.md on disk.
  const { root, paths } = seedProject({ skill: true });
  try {
    const { window, calls } = makeWindow();
    const mod = loadEditor(window, makeDocument(), console, makeLocalStorage());
    const tab = { folder: root, els: {} };
    const skillBefore = fs.readFileSync(paths.__skill);

    // When a concurrency-default save happens.
    const control = mod.buildWorkflowConcurrencyControl(tab, { skill: { concurrencyDefault: 4 } });
    await click(findButton(control, 'Save'));

    // Then NO write ever targeted SKILL.md ...
    const written = calls.writeFile.map((w) => norm(w.p));
    assert.ok(written.length >= 1, 'the save did write (config)');
    assert.ok(!written.some((p) => p.endsWith('skill.md')), 'no write ever targeted SKILL.md');
    // ... and the SKILL.md bytes on disk are unchanged.
    assert.ok(fs.readFileSync(paths.__skill).equals(skillBefore), 'SKILL.md bytes unchanged after the save');
  } finally { cleanup(root); }
});

// ===========================================================================
// Scenario: Out-of-range concurrency (failure)
//   When a stored concurrencyDefault of 99 is loaded
//   Then it resolves to the MAX_CONCURRENCY clamp and saving rewrites the
//        normalized value (columns / version / unknown fields preserved).
// ===========================================================================
test('Scenario (failure): an out-of-range concurrencyDefault 99 clamps to MAX and Save persists the normalized value, preserving columns', async () => {
  // Given a team-config.json whose skill.concurrencyDefault is an out-of-range 99,
  // with a user column, an explicit version and an unknown top-level field.
  const { root } = seedProject();
  const tasksDir = path.join(root, 'tasks');
  const cfgPath = path.join(tasksDir, 'team-config.json');
  fs.mkdirSync(tasksDir, { recursive: true });
  const rawConfig = {
    version: 2,
    columns: [{ status: 'ux-review', label: 'UX Review', description: 'design pass' }],
    skill: { concurrencyDefault: 99, planningModel: 'claude-fable-5' },
    someUnknownField: { keep: true },
  };
  fs.writeFileSync(cfgPath, JSON.stringify(rawConfig, null, 2) + '\n');
  try {
    const { window } = makeWindow();
    const mod = loadEditor(window, makeDocument(), console, makeLocalStorage());
    const tab = { folder: root, els: {} };

    // When the concurrency control renders from that raw config.
    const control = mod.buildWorkflowConcurrencyControl(tab, rawConfig);
    const select = findByClass(control, 'team-workflow-concurrency-select');

    // Then the out-of-range 99 clamps to the MAX_CONCURRENCY option (8).
    assert.equal(select.value, '8', 'stored 99 clamps to the MAX_CONCURRENCY option');
    assert.equal(mod.resolveTasksConcurrency(99), 8, 'resolveTasksConcurrency clamps 99 -> 8');

    // When Save is clicked, the whole normalized config is rewritten.
    await click(findButton(control, 'Save'));

    // Then the persisted concurrencyDefault is the NORMALIZED 8 (not 99) ...
    const persisted = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    assert.equal(persisted.skill.concurrencyDefault, 8, 'Save rewrote the normalized clamped value');
    // ... and the ux-review column, version, other skill keys and the unknown
    // top-level field all survive (a concurrency-only save never drops them).
    // TASK-201/203: the phase system is fully retired, so the normalized column
    // shape carries no `phase` key at all (TASK-202 added `instructions`).
    assert.deepEqual(persisted.columns.find((c) => c.status === 'ux-review'),
      { status: 'ux-review', label: 'UX Review', description: 'design pass', agent: null, instructions: '', system: false },
      'the user column is preserved (normalized shape)');
    assert.equal(persisted.version, 2, 'version preserved');
    assert.equal(persisted.skill.planningModel, 'claude-fable-5', 'other skill keys preserved');
    assert.deepEqual(persisted.someUnknownField, { keep: true }, 'unknown top-level field preserved');
    // And the five system lanes are all present in the normalized columns
    // (post-processing was removed in TASK-206, so there are five, not six).
    for (const s of ['todo', 'defining', 'in-progress', 'testing', 'done']) {
      assert.ok(persisted.columns.some((c) => c.status === s), `system column ${s} present`);
    }
  } finally { cleanup(root); }
});
