'use strict';

// ===========================================================================
// TASK-127 — e2e "cucumber" scenarios (Given/When/Then), implemented as plain
// `node --test` cases. NO cucumber npm package is installed or required; these
// are scenario-style node:test cases in Given/When/Then form.
//
// Feature: make the add-agent create path atomic (exclusive-create, flag:'wx')
// so a file that appears between the fs.exists pre-check and the write can NOT
// be silently overwritten — the "abort, no overwrite" guarantee becomes race-
// safe (TOCTOU fix, review follow-up of TASK-035 / TASK-095).
//
// Two subjects, both exercised via SHIPPED code:
//   * The main.js fs:writeFile handler arrow-fn is EXTRACTED from source and run
//     with injected fsp/fsRoots (its handler boots Electron so cannot be
//     require()'d directly) — used for the exclusive/default/confinement rules.
//   * The renderer add-agent onCreate + writeWithMirror flow is EXTRACTED headless
//     (the task-093/094/095 convention) and driven through a mock DOM + a mocked
//     window.api.fs whose writeFile honours the `exclusive` opt with wx semantics.
//
// Mock ALL fs/Electron/DOM. NO DATABASE / REAL DB CONNECTION / DISK / NETWORK /
// ELECTRON — the "filesystem" is an in-memory Map; no real disk writes.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const mainSrc = fs.readFileSync(path.join(REPO, 'main.js'), 'utf8');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');
const OUTSIDE = 'Path is outside the approved project root';

// ---------------------------------------------------------------------------
// Shared: extract the shipped fs:writeFile handler arrow-fn from main.js.
// ---------------------------------------------------------------------------
function extractHandlerFn(src, channel) {
  const at = src.indexOf(`ipcMain.handle('${channel}',`);
  assert.notEqual(at, -1, `handler ${channel} found`);
  const asyncAt = src.indexOf('async', at);
  let i = src.indexOf('{', src.indexOf('=>', asyncAt));
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) { i += 1; break; } }
  }
  return src.slice(asyncAt, i);
}
function loadWriteFileHandler(fsp, fsRoots) {
  // eslint-disable-next-line no-new-func
  return new Function('fsp', 'fsRoots', 'OUTSIDE_ROOT_ERROR',
    'return (' + extractHandlerFn(mainSrc, 'fs:writeFile') + ');')(fsp, fsRoots, OUTSIDE);
}
function makeFakeFsp(initial) {
  const disk = new Map(Object.entries(initial || {}));
  const calls = [];
  return {
    disk, calls,
    async writeFile(p, content, opts) {
      const flag = opts && typeof opts === 'object' ? opts.flag : undefined;
      calls.push({ p, opts });
      if (flag === 'wx' && disk.has(p)) {
        const e = new Error(`EEXIST: file already exists, open '${p}'`); e.code = 'EEXIST'; throw e;
      }
      disk.set(p, content);
    },
    async stat(p) {
      if (!disk.has(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return { size: Buffer.byteLength(disk.get(p), 'utf8') };
    },
  };
}
const fsRootsAllow = { async isPathAllowed() { return true; } };
const fsRootsDeny = { async isPathAllowed() { return false; } };

// ===========================================================================
// HANDLER-LEVEL SCENARIOS (fs:writeFile exclusive / default / confinement)
// ===========================================================================

// -------------------------------------------------------------------------
// Scenario: exclusive-create refuses a pre-existing file without clobbering it
// -------------------------------------------------------------------------
test('Scenario: exclusive-create against an existing agent file aborts and keeps the original bytes', async () => {
  // Given a bundled agent file already exists at the target path
  const target = 'C:\\proj\\.claude\\agents\\ba.md';
  const fsp = makeFakeFsp({ [target]: 'BUNDLED AGENT\n' });
  const handler = loadWriteFileHandler(fsp, fsRootsAllow);
  // When fs:writeFile is invoked with exclusive:true for that path
  const res = await handler({}, { path: target, content: 'ATTACKER', exclusive: true });
  // Then it returns ok:false with an EEXIST error and the original file is intact
  assert.equal(res.ok, false);
  assert.match(res.error, /EEXIST|already exists/i);
  assert.equal(fsp.disk.get(target), 'BUNDLED AGENT\n', 'no overwrite');
});

// -------------------------------------------------------------------------
// Scenario: exclusive-create writes a brand-new file (happy path)
// -------------------------------------------------------------------------
test('Scenario: exclusive-create writes a brand-new file with flag:wx and reports its size', async () => {
  // Given no file exists at the target path
  const target = 'C:\\proj\\.claude\\agents\\orchestrate-docs.md';
  const fsp = makeFakeFsp({});
  const handler = loadWriteFileHandler(fsp, fsRootsAllow);
  // When fs:writeFile is invoked with exclusive:true
  const res = await handler({}, { path: target, content: 'NEW AGENT', exclusive: true });
  // Then the file is created atomically via wx and ok:true is returned
  assert.equal(res.ok, true);
  assert.equal(fsp.disk.get(target), 'NEW AGENT');
  assert.equal(fsp.calls[0].opts.flag, 'wx');
});

// -------------------------------------------------------------------------
// Scenario: default (non-exclusive) write still overwrites (regression guard)
// -------------------------------------------------------------------------
test('Scenario: a default fs:writeFile still overwrites an existing file (editor/ticket save unaffected)', async () => {
  // Given an existing ticket file
  const target = 'C:\\proj\\tasks\\doing\\TASK-001.md';
  const fsp = makeFakeFsp({ [target]: 'v1' });
  const handler = loadWriteFileHandler(fsp, fsRootsAllow);
  // When fs:writeFile is invoked WITHOUT the exclusive flag
  const res = await handler({}, { path: target, content: 'v2' });
  // Then the file is overwritten exactly as before the fix
  assert.equal(res.ok, true);
  assert.equal(fsp.disk.get(target), 'v2');
  assert.equal(fsp.calls[0].opts, 'utf8', 'legacy utf8 overwrite path');
});

// -------------------------------------------------------------------------
// Scenario (failure): confinement guard rejects out-of-root regardless of flag
// -------------------------------------------------------------------------
test('Scenario (failure): an out-of-root path is rejected BEFORE any write, with or without exclusive', async () => {
  const evil = 'C:\\Users\\victim\\.ssh\\authorized_keys';
  for (const exclusive of [true, false, undefined]) {
    const fsp = makeFakeFsp({});
    const handler = loadWriteFileHandler(fsp, fsRootsDeny);
    // When fs:writeFile is invoked for an out-of-root path
    const res = await handler({}, { path: evil, content: 'x', exclusive });
    // Then it returns the confinement error and nothing is written
    assert.equal(res.ok, false, `exclusive=${exclusive}`);
    assert.equal(res.error, OUTSIDE);
    assert.equal(fsp.calls.length, 0, 'guard ran before any write');
  }
});

// ===========================================================================
// RENDERER add-agent onCreate SCENARIOS (headless real renderer + mock fs/DOM)
// ===========================================================================

function extractFn(src, name) {
  let start = src.indexOf('function ' + name + '(');
  assert.ok(start !== -1, `function ${name} found`);
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
  assert.ok(m, `const ${name} found`);
  return m[0];
}
function loadRenderer() {
  const body = [
    extractConst(rendererSrc, 'ASSETS_MIRRORED_SUBTREES'),
    extractConst(rendererSrc, 'AGENT_KEY_RE'),
    extractConst(rendererSrc, 'AGENT_BLOCK_RE'),
    extractConst(rendererSrc, 'AGENT_FENCE_RE'),
    extractConst(rendererSrc, 'AGENT_FALLBACK_NAME'),
    extractConst(rendererSrc, 'AGENT_NAME_SLUG_RE'),
    extractConst(rendererSrc, 'ADD_AGENT_BODY_STARTER'),
    'const _modalBoundHandlers = new WeakMap();',
    extractFn(rendererSrc, 'bindActionOnce'),
    extractFn(rendererSrc, 'inferSep'),
    extractFn(rendererSrc, 'appendPath'),
    extractFn(rendererSrc, 'tasksJoin'),
    extractFn(rendererSrc, 'tasksBasename'),
    extractFn(rendererSrc, 'mirrorRelPath'),
    extractFn(rendererSrc, 'relFromFolder'),
    extractFn(rendererSrc, 'writeWithMirror'),
    extractFn(rendererSrc, 'resolveAgentBlockScalar'),
    extractFn(rendererSrc, 'formatAgentDescription'),
    extractFn(rendererSrc, 'parseAgentFileRenderer'),
    extractFn(rendererSrc, 'serializeAgentDescription'),
    extractFn(rendererSrc, 'agentDescriptionValid'),
    extractFn(rendererSrc, 'buildAgentsInstallHint'),
    extractFn(rendererSrc, 'buildAgentCard'),
    extractFn(rendererSrc, 'refreshTeamAgents'),
    extractFn(rendererSrc, 'validateAgentNameRenderer'),
    extractFn(rendererSrc, 'sanitizeAgentScalarField'),
    extractFn(rendererSrc, 'sanitizeAgentToolsField'),
    extractFn(rendererSrc, 'sanitizeAgentModelField'),
    extractFn(rendererSrc, 'buildAgentFileContent'),
    extractFn(rendererSrc, 'readExistingAgentNames'),
    extractFn(rendererSrc, 'openAddAgentModal'),
    'return { openAddAgentModal, refreshTeamAgents, writeWithMirror };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function('window', 'document', 'console', body);
}
const makeRenderer = loadRenderer();

// --- Minimal in-memory mock DOM (from task-095) --------------------------
function makeEl(tag) {
  const classes = new Set();
  const children = [];
  let text = '';
  const el = {
    tagName: String(tag || '').toUpperCase(),
    dataset: {}, style: {}, children, _listeners: {},
    disabled: false, value: '', rows: 0, id: '',
    classList: {
      add(...cs) { cs.forEach((c) => classes.add(c)); },
      remove(...cs) { cs.forEach((c) => classes.delete(c)); },
      toggle(c, on) { const want = on === undefined ? !classes.has(c) : !!on; if (want) classes.add(c); else classes.delete(c); return want; },
      contains(c) { return classes.has(c); },
    },
    appendChild(c) { children.push(c); c.parentNode = el; return c; },
    addEventListener(t, fn, opts) { (el._listeners[t] = el._listeners[t] || []).push({ fn, once: !!(opts && opts.once) }); },
    removeEventListener(t, fn) { if (el._listeners[t]) el._listeners[t] = el._listeners[t].filter((e) => e.fn !== fn); },
    querySelector(sel) { if (sel[0] !== '.') throw new Error('mock querySelector only supports .class: ' + sel); return findByClass(el, sel.slice(1)); },
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
  return el;
}
function findByClass(root, cls) {
  for (const c of (root.children || [])) {
    if (c.classList && c.classList.contains(cls)) return c;
    const deep = findByClass(c, cls);
    if (deep) return deep;
  }
  return null;
}
function makeDocument(byId) {
  return {
    createElement: (tag) => makeEl(tag),
    createTextNode: (t) => ({ _isText: true, textContent: String(t) }),
    getElementById: (id) => byId[id] || null,
  };
}
async function click(el) {
  const entries = (el._listeners.click || []).slice();
  el._listeners.click = (el._listeners.click || []).filter((e) => !e.once);
  for (const e of entries) await e.fn({});
}
async function flush(n) { for (let i = 0; i < (n || 20); i++) await new Promise((r) => setImmediate(r)); }

function makeAddAgentModal() {
  const modal = makeEl('div');
  modal.id = 'addAgentModal';
  modal.classList.add('task-modal', 'hidden');
  const add = (cls, tag) => { const e = makeEl(tag || 'div'); e.classList.add(...cls.split(' ')); modal.appendChild(e); return e; };
  add('addagent-name', 'input');
  add('addagent-description', 'textarea');
  add('addagent-tools', 'input');
  add('addagent-model', 'input');
  add('addagent-body', 'textarea');
  add('addagent-error', 'div');
  add('addagent-cancel', 'button');
  add('addagent-create', 'button');
  return modal;
}

// --- Mocked window.api.fs backed by an in-memory Map (NO real disk). -------
// writeFile honours the `exclusive` opt exactly like the main handler + wx:
// exclusive && present => {ok:false, EEXIST}; else overwrite. `hiddenFromExists`
// lets the fs.exists pre-check report "absent" while the file is really present,
// which drives the TOCTOU race branch (pre-check passes, wx still refuses).
function makeWindow(opts) {
  const o = opts || {};
  const disk = new Map(Object.entries(o.disk || {}));
  const hidden = o.hiddenFromExists || new Set();
  const forceEmptyFindByExt = !!o.forceEmptyFindByExt;
  const calls = { writeFile: [], exists: [], mkdir: [], findByExt: [] };
  const window = {
    api: {
      fs: {
        async findByExt(root, ext) {
          calls.findByExt.push({ root, ext });
          if (forceEmptyFindByExt) return { ok: true, files: [] };
          const out = [];
          for (const k of disk.keys()) {
            const dir = k.slice(0, k.replace(/[\\/][^\\/]*$/, '').length);
            if ((dir + (k.includes('\\') ? '\\' : '/')) === '') { /* noop */ }
            if (k.toLowerCase().startsWith(String(root).toLowerCase()) && k.toLowerCase().endsWith(String(ext).toLowerCase())) out.push(k);
          }
          return { ok: true, files: out };
        },
        async readFile(p) {
          return disk.has(p) ? { ok: true, content: disk.get(p) } : { ok: false, error: 'ENOENT' };
        },
        async writeFile(p, content, wopts) {
          calls.writeFile.push({ p, content, opts: wopts });
          if (wopts && wopts.exclusive && disk.has(p)) {
            return { ok: false, error: `EEXIST: file already exists, open '${p}'` };
          }
          disk.set(p, content);
          return { ok: true, size: Buffer.byteLength(content, 'utf8') };
        },
        async exists(p) {
          calls.exists.push({ p });
          if (hidden.has(p)) return { ok: true, exists: false };
          return { ok: true, exists: disk.has(p) };
        },
        async mkdir(p) { calls.mkdir.push({ p }); return { ok: true }; },
      },
      tasks: { async installSkill() { return { ok: true }; } },
    },
  };
  return { window, calls, disk, noopConsole: { error() {}, warn() {}, log() {} } };
}

async function submitAgent(open, modal, fields) {
  open();
  await flush();
  modal.querySelector('.addagent-name').value = fields.name != null ? fields.name : '';
  modal.querySelector('.addagent-description').value = fields.description != null ? fields.description : '';
  modal.querySelector('.addagent-tools').value = fields.tools != null ? fields.tools : '';
  modal.querySelector('.addagent-model').value = fields.model != null ? fields.model : '';
  if (fields.body != null) modal.querySelector('.addagent-body').value = fields.body;
  await click(modal.querySelector('.addagent-create'));
  await flush();
}
const AG = (root, name) => root + '\\.claude\\agents\\' + name + '.md';

// -------------------------------------------------------------------------
// Scenario: creating a brand-new agent opts into exclusive-create and succeeds
// -------------------------------------------------------------------------
test('Scenario: add-agent create of a brand-new agent passes {exclusive:true} to the primary write and succeeds', async () => {
  // Given an open project with an empty .claude/agents
  const root = 'C:\\proj';
  const { window, calls, disk, noopConsole } = makeWindow({ disk: {} });
  const modal = makeAddAgentModal();
  const { openAddAgentModal } = makeRenderer(window, makeDocument({ addAgentModal: modal }), noopConsole);
  const tab = { folder: root, els: { teamAgentsBody: makeEl('div') } };

  // When the user submits a valid new agent
  await submitAgent(() => openAddAgentModal(tab), modal, {
    name: 'orchestrate-docs', description: 'Docs agent for the workflow.',
  });

  // Then the primary write happened with { exclusive: true } and the file exists
  const target = AG(root, 'orchestrate-docs');
  const primary = calls.writeFile.find((c) => c.p === target);
  assert.ok(primary, 'primary agent-file write happened');
  assert.equal(primary.opts && primary.opts.exclusive, true, 'onCreate opted into exclusive-create');
  assert.ok(disk.has(target), 'the agent file was created');
  // And it is the ONLY write (mirror is a natural no-op for a brand-new agent)
  assert.equal(calls.writeFile.length, 1, 'no mirror write for a brand-new agent');
  assert.ok(modal.classList.contains('hidden'), 'modal closed on success');
});

// -------------------------------------------------------------------------
// Scenario (failure, pre-check hit): existing agent refused, no overwrite
// -------------------------------------------------------------------------
test('Scenario (failure): add-agent refuses a name whose file already exists (pre-check hit) — no write, friendly message', async () => {
  // Given .claude/agents/orchestrate-ba.md already exists on disk AND is visible
  const root = 'C:\\proj';
  const target = AG(root, 'orchestrate-ba');
  const { window, calls, disk, noopConsole } = makeWindow({
    disk: { [target]: 'EXISTING AGENT\n' }, forceEmptyFindByExt: true,
  });
  const modal = makeAddAgentModal();
  const { openAddAgentModal } = makeRenderer(window, makeDocument({ addAgentModal: modal }), noopConsole);
  const tab = { folder: root, els: { teamAgentsBody: makeEl('div') } };

  // When the user submits that name
  await submitAgent(() => openAddAgentModal(tab), modal, {
    name: 'orchestrate-ba', description: 'A second BA — should be refused.',
  });

  // Then the pre-check aborts with the friendly message and NO write is attempted
  assert.match(modal.querySelector('.addagent-error').textContent, /already exists .*not overwriting/i,
    'friendly no-overwrite message shown');
  assert.equal(calls.writeFile.length, 0, 'pre-check short-circuits — no write');
  assert.equal(disk.get(target), 'EXISTING AGENT\n', 'existing file untouched');
  assert.equal(modal.classList.contains('hidden'), false, 'modal stays open for retry');
});

// -------------------------------------------------------------------------
// Scenario (failure/edge, TOCTOU race): pre-check passes but the file appears
// before the write → wx EEXIST → same friendly message, original bytes intact.
// -------------------------------------------------------------------------
test('Scenario (race): a file that appears after the pre-check triggers wx EEXIST and the SAME no-overwrite message', async () => {
  // Given the name snapshot AND the fs.exists pre-check both report "absent",
  // but the file is actually present (a concurrent skill install landed it).
  const root = 'C:\\proj';
  const target = AG(root, 'orchestrate-docs');
  const { window, calls, disk, noopConsole } = makeWindow({
    disk: { [target]: 'RACED-IN CONTENT\n' },
    hiddenFromExists: new Set([target]), // pre-check sees "absent"
    forceEmptyFindByExt: true,           // name snapshot misses it too
  });
  const modal = makeAddAgentModal();
  const { openAddAgentModal } = makeRenderer(window, makeDocument({ addAgentModal: modal }), noopConsole);
  const tab = { folder: root, els: { teamAgentsBody: makeEl('div') } };

  // When the user submits — the pre-check passes, so the exclusive write runs
  await submitAgent(() => openAddAgentModal(tab), modal, {
    name: 'orchestrate-docs', description: 'Should hit the wx EEXIST race branch.',
  });

  // Then the exclusive write WAS attempted (exclusive:true) and refused with EEXIST
  const primary = calls.writeFile.find((c) => c.p === target);
  assert.ok(primary, 'the exclusive write was attempted (pre-check passed)');
  assert.equal(primary.opts && primary.opts.exclusive, true, 'attempted with exclusive:true');
  // And the friendly no-overwrite message is surfaced (not a raw errno)
  assert.match(modal.querySelector('.addagent-error').textContent, /already exists .*not overwriting/i,
    'EEXIST remapped to the friendly message');
  // And the raced-in bytes are NOT clobbered; the modal stays open.
  assert.equal(disk.get(target), 'RACED-IN CONTENT\n', 'wx refused — original bytes intact');
  assert.equal(modal.classList.contains('hidden'), false, 'modal stays open after the abort');
});

// -------------------------------------------------------------------------
// Scenario (mirror not regressed): saving a file whose assets/ mirror already
// exists still OVERWRITES the mirror (mirror does NOT use exclusive-create).
// -------------------------------------------------------------------------
test('Scenario: saving a mirrored file still overwrites an existing assets/ mirror (mirror stays default-overwrite)', async () => {
  // Given a primary .claude/agents file AND its assets/ mirror both exist
  const root = 'C:\\proj';
  const primaryPath = root + '\\.claude\\agents\\ba.md';
  const mirrorPath = root + '\\assets\\agents\\ba.md';
  const { window, calls, disk, noopConsole } = makeWindow({
    disk: { [primaryPath]: 'OLD PRIMARY', [mirrorPath]: 'OLD MIRROR' },
  });
  const { writeWithMirror } = makeRenderer(window, makeDocument({}), noopConsole);
  const tab = { folder: root };

  // When we save the file with a DEFAULT (non-exclusive) write
  const res = await writeWithMirror(tab, primaryPath, 'NEW CONTENT');

  // Then BOTH the primary and the existing mirror are overwritten successfully
  assert.equal(res.ok, true);
  assert.equal(res.mirrored, true, 'existing mirror was synced');
  assert.equal(disk.get(primaryPath), 'NEW CONTENT', 'primary overwritten');
  assert.equal(disk.get(mirrorPath), 'NEW CONTENT', 'mirror overwritten (no wx refusal)');
  // The mirror write carried NO exclusive opt.
  const mirrorWrite = calls.writeFile.find((c) => c.p === mirrorPath);
  assert.ok(mirrorWrite && !(mirrorWrite.opts && mirrorWrite.opts.exclusive), 'mirror write is default-overwrite');
});

// -------------------------------------------------------------------------
// Scenario (mirror no-op): add-agent create of a brand-new agent never creates
// a mirror that did not already exist.
// -------------------------------------------------------------------------
test('Scenario: exclusive add-agent create of a brand-new agent is a mirror no-op (never creates a mirror)', async () => {
  // Given a brand-new agent path with NO pre-existing assets/ mirror
  const root = 'C:\\proj';
  const primaryPath = root + '\\.claude\\agents\\fresh.md';
  const mirrorPath = root + '\\assets\\agents\\fresh.md';
  const { window, calls, disk, noopConsole } = makeWindow({ disk: {} });
  const { writeWithMirror } = makeRenderer(window, makeDocument({}), noopConsole);
  const tab = { folder: root };

  // When we create it with exclusive:true (as add-agent onCreate does)
  const res = await writeWithMirror(tab, primaryPath, 'BODY', { exclusive: true });

  // Then the primary lands, the mirror is a no-op, and none is created
  assert.equal(res.ok, true);
  assert.equal(res.mirrored, false, 'no mirror created for a brand-new agent');
  assert.equal(disk.has(mirrorPath), false, 'assets/ mirror was NOT created');
  assert.equal(calls.writeFile.length, 1, 'exactly one write (primary only)');
  assert.equal(calls.writeFile[0].opts && calls.writeFile[0].opts.exclusive, true, 'primary used exclusive-create');
});
