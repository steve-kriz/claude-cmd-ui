'use strict';

// ===========================================================================
// TASK-106 — e2e "cucumber" scenarios (Given/When/Then), implemented as plain
// `node --test` cases. NO `cucumber` npm package is installed or required; these
// are scenario-style node:test cases in Given/When/Then form.
//
// Feature: the Q3 GUIDED skill-settings editor mounted on the Team tab Workflow
// panel — (a) a per-phase AGENT MODEL editor that rewrites ONLY the `model:` line
// of that phase's agent file via a whole-file round-trip + writeWithMirror so
// assets/agents/ stays byte-synced, and (b) a build-CONCURRENCY-default control
// that writes skill.concurrencyDefault into tasks/team-config.json and seeds the
// Tasks toolbar dropdown / the `/orchestrate build --concurrency N` command.
//
// The subject under test is the REAL shipped renderer code (renderer/renderer.js,
// a browser script with no module.exports): buildWorkflowModelEditor,
// serializeAgentModel, sanitizeAgentModelField, writeWithMirror,
// buildWorkflowConcurrencyControl, buildWorkingConfigFromRaw,
// tasksSerializeTeamConfig, resolveTasksConcurrency, currentTasksConcurrency,
// syncTasksConcurrencyOption, initTasksConcurrency, buildCommandFor — extracted
// headless by brace-matching (the task-094/task-105 convention) and driven with
// an injected window/document/console/localStorage + a minimal in-memory mock DOM.
//
// ALL filesystem access goes through a STUBBED window.api.fs that operates on a
// per-test TEMP DIR (real node:fs, but only ever inside os.tmpdir()) so byte-
// preservation and mirror byte-identity can be asserted against actual files.
// The four bundled .claude/agents/*.md + assets/agents/*.md and SKILL.md are used
// READ-ONLY as fixtures (copied into the temp dir; the originals are NEVER
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

// Load the REAL guided-editor render + save path headless. Injects window /
// document / console / localStorage so nothing accidentally reaches a real global.
function loadEditor(window, document, console, localStorage) {
  const body = [
    // --- constants (ordered so cross-references resolve) ---
    extractConst(rendererSrc, 'AGENT_KEY_RE'),
    extractConst(rendererSrc, 'AGENT_BLOCK_RE'),
    extractConst(rendererSrc, 'AGENT_FENCE_RE'),
    extractConst(rendererSrc, 'WF_MODEL_SUGGESTIONS'),
    extractConst(rendererSrc, 'ASSETS_MIRRORED_SUBTREES'),
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
    // TASK-180 - tasksBuildColumn normalises a column's optional `phase` link
    // via tasksNormalizeColumnPhase, which reads TASKS_PHASE_KEYS.
    extractConst(rendererSrc, 'TASKS_PHASE_KEYS'),
    'let wfModelDatalistSeq = 0;',
    // --- path + mirror helpers ---
    extractFn(rendererSrc, 'inferSep'),
    extractFn(rendererSrc, 'appendPath'),
    extractFn(rendererSrc, 'tasksJoin'),
    extractFn(rendererSrc, 'tasksBasename'),
    extractFn(rendererSrc, 'relFromFolder'),
    extractFn(rendererSrc, 'mirrorRelPath'),
    extractFn(rendererSrc, 'writeWithMirror'),
    // --- agent-file round-trip + sanitiser (per-phase model editor) ---
    extractFn(rendererSrc, 'resolveAgentBlockScalar'),
    extractFn(rendererSrc, 'parseAgentFileRenderer'),
    extractFn(rendererSrc, 'serializeAgentModel'),
    extractFn(rendererSrc, 'sanitizeAgentScalarField'),
    extractFn(rendererSrc, 'sanitizeAgentModelField'),
    extractFn(rendererSrc, 'buildWorkflowModelEditor'),
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
    extractFn(rendererSrc, 'tasksNormalizeColumnPhase'),
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
    // refreshTeamWorkflow is fire-and-forget from the Save handlers; stub it so a
    // save does not re-drive the whole (unmounted) panel in these targeted tests.
    'function refreshTeamWorkflow(){}',
    'return { buildWorkflowModelEditor, buildWorkflowConcurrencyControl,',
    '  serializeAgentModel, parseAgentFileRenderer, sanitizeAgentModelField,',
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
// A window.api.fs stub backed by REAL node:fs, but scoped to a temp dir. `failOn`
// (a normalized absolute path) makes writeFile to that one path fail (the mirror-
// unwritable scenario). Every call is recorded so a test can assert exactly what
// was (and was NOT) written. NO real project file is ever touched.
// ---------------------------------------------------------------------------
function norm(p) { return String(p).replace(/\\/g, '/').toLowerCase(); }

function makeWindow(opts) {
  const o = opts || {};
  const failOn = o.failOn ? norm(o.failOn) : null;
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
          if (failOn && norm(p) === failOn) return { ok: false, error: 'EACCES' };
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

// Build a temp project dir; copy the requested bundled agent files into BOTH
// .claude/agents/ and assets/agents/ (byte-for-byte), returning their paths.
function seedProject(agentNames, opts) {
  const o = opts || {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't106-'));
  const claudeAgents = path.join(root, '.claude', 'agents');
  const assetsAgents = path.join(root, 'assets', 'agents');
  fs.mkdirSync(claudeAgents, { recursive: true });
  fs.mkdirSync(assetsAgents, { recursive: true });
  const paths = {};
  for (const name of (agentNames || [])) {
    const bytes = (o.contentByName && o.contentByName[name] != null)
      ? Buffer.from(o.contentByName[name], 'utf8')
      : fs.readFileSync(path.join(REPO, 'assets', 'agents', name));
    const claudePath = path.join(claudeAgents, name);
    const assetsPath = path.join(assetsAgents, name);
    fs.writeFileSync(claudePath, bytes);
    if (!o.noMirror) fs.writeFileSync(assetsPath, bytes);
    paths[name] = { claudePath, assetsPath, original: bytes };
  }
  // Optionally seed a real SKILL.md so the "SKILL.md untouched" assertion can
  // Buffer-compare a genuine file before/after a save.
  if (o.skill) {
    const skillDir = path.join(root, '.claude', 'skills', 'orchestrate');
    fs.mkdirSync(skillDir, { recursive: true });
    const skillPath = path.join(skillDir, 'SKILL.md');
    fs.copyFileSync(path.join(REPO, '.claude', 'skills', 'orchestrate', 'SKILL.md'), skillPath);
    paths.__skill = skillPath;
  }
  return { root, claudeAgents, assetsAgents, paths };
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
}

// Mount the per-phase model editor on a freshly-parsed agent file and enter its
// edit view, returning { wrap, input, saveBtn, cancelBtn, errEl }.
function mountModelEditor(mod, tab, claudePath, phase) {
  const content = fs.readFileSync(claudePath, 'utf8');
  const parsed = mod.parseAgentFileRenderer(content);
  assert.ok(parsed, 'the agent file parses');
  const agentFile = { filePath: claudePath, parsed };
  const wrap = mod.buildWorkflowModelEditor(tab, phase, agentFile);
  return { wrap, parsed };
}
async function enterEdit(wrap) {
  await click(findButton(wrap, 'Edit'));
  return {
    input: findByClass(wrap, 'team-workflow-model-input'),
    saveBtn: findButton(wrap, 'Save'),
    cancelBtn: findButton(wrap, 'Cancel'),
    errEl: findByClass(wrap, 'team-agent-desc-error'),
  };
}

const OPUS = 'claude-opus-4-8';    // ba.md + tech-lead.md pin the premium tier
const SONNET = 'claude-sonnet-5';  // coder.md pins the swarm default

// A synthetic read-only agent def with NO `model:` key, used to drive the
// serializer's "insert a model key in canonical position" path now that every
// bundled orchestrate agent pins a model in its frontmatter.
const NO_MODEL_AGENT = [
  '---',
  'name: orchestrate-sample',
  'description: >-',
  '  A sample read-only agent used as a fixture; it declares no model key.',
  'tools: Read, Grep, Glob',
  '---',
  '',
  'Sample agent body.',
  '',
].join('\n');

// ===========================================================================
// Scenario: Editing the coder phase model
//   When the user sets the build phase model to "claude-opus-4-8" and saves
//   Then .claude/agents/coder.md has model: claude-opus-4-8 with all other bytes
//        preserved  And assets/agents/coder.md is byte-identical
// ===========================================================================
test('Scenario: editing the build/coder phase model to claude-opus-4-8 rewrites ONLY the model line and byte-syncs the mirror', async () => {
  // Given a project with the bundled coder.md installed in .claude/agents/ AND
  // mirrored under assets/agents/ (coder.md ships with model: claude-sonnet-5).
  const { root, paths } = seedProject(['coder.md']);
  try {
    const { window, calls } = makeWindow();
    const mod = loadEditor(window, makeDocument(), console, makeLocalStorage());
    const tab = { folder: root, els: {} };
    const coder = paths['coder.md'];
    const orig = coder.original.toString('utf8');
    const eol = /\r\n/.test(orig) ? '\r\n' : '\n';

    // When the user opens the build phase's model editor, types claude-opus-4-8
    // and clicks Save.
    const { wrap } = mountModelEditor(mod, tab, coder.claudePath,
      { key: 'build', title: 'Phase 2', agent: 'orchestrate-coder' });
    const { input, saveBtn, errEl } = await enterEdit(wrap);
    input.value = OPUS;
    await click(saveBtn);

    // Then no inline error surfaced.
    assert.ok(errEl.classList.contains('hidden'), 'no error on a clean save');

    // And .claude/agents/coder.md now declares model: claude-opus-4-8 — the
    // existing model line (claude-sonnet-5) is rewritten in place with EVERY OTHER
    // byte preserved — verified by reconstructing the exact expected file.
    const after = fs.readFileSync(coder.claudePath, 'utf8');
    const expected = orig.replace('model: ' + SONNET + eol, 'model: ' + OPUS + eol);
    assert.notEqual(after, orig, 'the file actually changed');
    assert.equal(after, expected, 'ONLY the model VALUE was rewritten; all other bytes preserved');

    // And assets/agents/coder.md is byte-identical to the .claude copy (mirror sync).
    const claudeBytes = fs.readFileSync(coder.claudePath);
    const assetsBytes = fs.readFileSync(coder.assetsPath);
    assert.ok(claudeBytes.equals(assetsBytes), 'assets mirror is byte-identical after the save');

    // And exactly the two agent copies were written — never SKILL.md or anything else.
    const written = calls.writeFile.map((w) => norm(w.p));
    assert.deepEqual(written, [norm(coder.claudePath), norm(coder.assetsPath)],
      'wrote the .claude copy then its assets mirror, nothing else');
    assert.ok(!written.some((p) => p.endsWith('skill.md')), 'never wrote SKILL.md');
  } finally { cleanup(root); }
});

// ===========================================================================
// Scenario: An agent file WITHOUT a model key gains one in canonical position
//   (round-trip guarantee from TASK-092) — other bytes preserved.
// ===========================================================================
test('Scenario: a phase agent file with no model key gains one in canonical position, all other bytes preserved', async () => {
  // Given a synthetic agent file with name/description/tools and NO model key
  // (every bundled orchestrate agent now pins a model, so this path is exercised
  // with a fixture that still lacks one).
  const { root, paths } = seedProject(['sample.md'], { contentByName: { 'sample.md': NO_MODEL_AGENT } });
  try {
    const { window, calls } = makeWindow();
    const mod = loadEditor(window, makeDocument(), console, makeLocalStorage());
    const tab = { folder: root, els: {} };
    const sample = paths['sample.md'];
    const orig = sample.original.toString('utf8');
    const eol = /\r\n/.test(orig) ? '\r\n' : '\n';
    assert.ok(!/\nmodel:/.test(orig), 'fixture precondition: the sample agent has no model key');

    // When the phase model is set to claude-opus-4-8 and saved.
    const { wrap } = mountModelEditor(mod, tab, sample.claudePath,
      { key: 'test', title: 'Phase 3', agent: 'orchestrate-sample' });
    const { input, saveBtn } = await enterEdit(wrap);
    input.value = OPUS;
    await click(saveBtn);

    // Then the model line is inserted right after the `tools:` line (canonical
    // name→description→tools→model order) and nothing else changes.
    const after = fs.readFileSync(sample.claudePath, 'utf8');
    const toolsLine = 'tools: Read, Grep, Glob';
    const expected = orig.replace(toolsLine + eol, toolsLine + eol + 'model: ' + OPUS + eol);
    assert.equal(after, expected, 'model inserted after tools; every other byte preserved');

    // And removing exactly that one inserted line yields the original file back.
    const restored = after.replace('model: ' + OPUS + eol, '');
    assert.equal(restored, orig, 'the change is exactly one added model line');

    // And the assets mirror matches.
    assert.ok(fs.readFileSync(sample.claudePath).equals(fs.readFileSync(sample.assetsPath)),
      'assets mirror byte-identical');
    assert.equal(calls.writeFile.length, 2, 'primary + mirror only');
  } finally { cleanup(root); }
});

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
//   When any workflow setting is saved
//   Then SKILL.md bytes on disk are unchanged (no write ever targets SKILL.md)
// ===========================================================================
test('Scenario (edge): saving a model AND a concurrency default never writes SKILL.md; its bytes stay identical', async () => {
  // Given a project with coder.md installed + mirrored AND a real SKILL.md on disk.
  const { root, paths } = seedProject(['coder.md'], { skill: true });
  try {
    const { window, calls } = makeWindow();
    const mod = loadEditor(window, makeDocument(), console, makeLocalStorage());
    const tab = { folder: root, els: {} };
    const skillBefore = fs.readFileSync(paths.__skill);

    // When a model save happens ...
    const coder = paths['coder.md'];
    const me = mountModelEditor(mod, tab, coder.claudePath,
      { key: 'build', title: 'Phase 2', agent: 'orchestrate-coder' });
    const edit = await enterEdit(me.wrap);
    edit.input.value = OPUS;
    await click(edit.saveBtn);

    // ... and a concurrency-default save happens.
    const control = mod.buildWorkflowConcurrencyControl(tab, { skill: { concurrencyDefault: 4 } });
    await click(findButton(control, 'Save'));

    // Then NO write ever targeted SKILL.md ...
    const written = calls.writeFile.map((w) => norm(w.p));
    assert.ok(written.length >= 2, 'the saves did write (agent + config)');
    assert.ok(!written.some((p) => p.endsWith('skill.md')), 'no write ever targeted SKILL.md');
    // ... and the SKILL.md bytes on disk are unchanged.
    assert.ok(fs.readFileSync(paths.__skill).equals(skillBefore), 'SKILL.md bytes unchanged after both saves');
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
  const { root } = seedProject([]);
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
    assert.deepEqual(persisted.columns.find((c) => c.status === 'ux-review'),
      { status: 'ux-review', label: 'UX Review', description: 'design pass', agent: null, system: false, phase: null },
      'the user column is preserved (normalized shape)');
    assert.equal(persisted.version, 2, 'version preserved');
    assert.equal(persisted.skill.planningModel, 'claude-fable-5', 'other skill keys preserved');
    assert.deepEqual(persisted.someUnknownField, { keep: true }, 'unknown top-level field preserved');
    // And the six system lanes are all present in the normalized columns.
    for (const s of ['todo', 'defining', 'in-progress', 'testing', 'post-processing', 'done']) {
      assert.ok(persisted.columns.some((c) => c.status === s), `system column ${s} present`);
    }
  } finally { cleanup(root); }
});

// ===========================================================================
// Scenario: Mirror write fails (failure)
//   Given assets/agents/coder.md is unwritable
//   When the model is saved
//   Then the .claude copy is written and a drift warning names both paths
// ===========================================================================
test('Scenario (failure): when the assets mirror is unwritable, the .claude copy still lands and a drift warning names BOTH paths', async () => {
  // Given coder.md installed + mirrored, but the assets mirror is unwritable.
  const { root, paths } = seedProject(['coder.md']);
  try {
    const coder = paths['coder.md'];
    const { window, calls } = makeWindow({ failOn: coder.assetsPath });
    const mod = loadEditor(window, makeDocument(), console, makeLocalStorage());
    const tab = { folder: root, els: {} };
    const assetsBefore = fs.readFileSync(coder.assetsPath);

    // When the model is saved.
    const { wrap } = mountModelEditor(mod, tab, coder.claudePath,
      { key: 'build', title: 'Phase 2', agent: 'orchestrate-coder' });
    const { input, saveBtn, errEl } = await enterEdit(wrap);
    input.value = OPUS;
    await click(saveBtn);

    // Then the .claude copy WAS written (primary landed) ...
    const claudeAfter = fs.readFileSync(coder.claudePath, 'utf8');
    assert.match(claudeAfter, /\nmodel: claude-opus-4-8\n/, '.claude copy got the new model');
    // ... the assets mirror did NOT change (its write failed) ...
    assert.ok(fs.readFileSync(coder.assetsPath).equals(assetsBefore), 'assets mirror unchanged (drifted)');
    // ... a drift warning is shown inline naming BOTH the primary and mirror paths ...
    assert.ok(!errEl.classList.contains('hidden'), 'a drift warning is shown');
    assert.match(errEl.textContent, /drift/i, 'the warning explains the two copies drifted');
    assert.ok(errEl.textContent.includes(coder.claudePath), 'warning names the .claude path');
    assert.ok(errEl.textContent.includes(coder.assetsPath), 'warning names the assets mirror path');
    // ... and both writes were attempted (primary ok, mirror failed).
    assert.equal(calls.writeFile.length, 2, 'primary + mirror writes attempted');
  } finally { cleanup(root); }
});

// ===========================================================================
// Scenario: INJECTION (failure)
//   A model value with a newline / `---` / `key:` is rejected — no write.
// ===========================================================================
test('Scenario (failure): a model value with a newline, a leading ---, or an embedded key: is rejected with NO write', async () => {
  const injections = [
    { label: 'newline', value: 'claude-opus-4-8\nmalicious: true' },
    { label: 'CR', value: 'claude\r\nname: evil' },
    { label: 'leading ---', value: '---\nname: evil' },
    { label: 'embedded key:', value: 'foo: bar' },
    { label: 'YAML injection token', value: 'x\ntools: Bash' },
  ];
  for (const inj of injections) {
    const { root, paths } = seedProject(['coder.md']);
    try {
      const coder = paths['coder.md'];
      const { window, calls } = makeWindow();
      const mod = loadEditor(window, makeDocument(), console, makeLocalStorage());
      const tab = { folder: root, els: {} };

      // When the user tries to save a malicious model value.
      const { wrap } = mountModelEditor(mod, tab, coder.claudePath,
        { key: 'build', title: 'Phase 2', agent: 'orchestrate-coder' });
      const { input, saveBtn, errEl } = await enterEdit(wrap);
      input.value = inj.value;
      await click(saveBtn);

      // Then it is rejected inline and NOTHING is written to disk.
      assert.ok(!errEl.classList.contains('hidden'), `${inj.label}: an error is shown`);
      assert.equal(calls.writeFile.length, 0, `${inj.label}: no write happened`);
      assert.ok(fs.readFileSync(coder.claudePath).equals(coder.original), `${inj.label}: coder.md untouched`);
      assert.ok(fs.readFileSync(coder.assetsPath).equals(coder.original), `${inj.label}: assets mirror untouched`);
      // And the sanitiser itself rejects the value (defence in depth).
      assert.equal(mod.sanitizeAgentModelField(inj.value).ok, false, `${inj.label}: sanitizer rejects`);
    } finally { cleanup(root); }
  }
});
