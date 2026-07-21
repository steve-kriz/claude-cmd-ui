'use strict';

// ===========================================================================
// TASK-095 — e2e "cucumber" scenarios (Given/When/Then), implemented as plain
// `node --test` cases. NO cucumber npm package is installed or required; these
// are scenario-style node:test cases in Given/When/Then form.
//
// Feature: the Team tab Agents panel "Add agent" form — create a real,
// dispatchable `<folder>/.claude/agents/<name>.md` subagent definition
// (validate the slug, require a description, sanitize optional tools/model,
// mkdir -p .claude/agents/, refuse to overwrite an existing target, ONE
// writeWithMirror, then refresh so the new agent appears in the panel).
//
// The subject under test is the REAL renderer code (renderer/renderer.js, a
// browser script with no module.exports). openAddAgentModal, readExistingAgentNames,
// refreshTeamAgents, buildAgentCard, writeWithMirror, bindActionOnce and the
// pure helpers are EXTRACTED headless by brace-matching the source (the
// convention of test/task-093/094) and evaluated with an INJECTED `window` +
// a minimal in-memory mock `document` that supports getElementById +
// querySelector so the REAL modal wiring drives the flow.
//
// ALL filesystem/Electron access goes through a STUBBED `window.api.fs`
// (mkdir / exists / writeFile / findByExt / readFile) backed by real TEMP
// directories so file creation is asserted on disk. NO real DB / Electron /
// network. The generated agent file is parsed back through the REAL
// lib/agent-files.js parseAgentFile. The bundled ba.md is a read-only fixture.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { parseAgentFile } = require('../lib/agent-files.js');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');
const REAL_BA = fs.readFileSync(path.join(REPO, '.claude', 'agents', 'ba.md'), 'utf8');

// --- Extract a named function declaration by brace-matching (from task-093). --
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

// Load the REAL renderer surface headless, injecting window/document/console.
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
    'return { openAddAgentModal, refreshTeamAgents };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function('window', 'document', 'console', body);
}
const makeRenderer = loadRenderer();

// ---------------------------------------------------------------------------
// Minimal in-memory mock DOM with getElementById + querySelector('.class') and
// once-listener semantics (needed by bindActionOnce).
// ---------------------------------------------------------------------------
function makeEl(tag) {
  const classes = new Set();
  const children = [];
  let text = '';
  const el = {
    tagName: String(tag || '').toUpperCase(),
    dataset: {}, style: {}, children,
    _listeners: {},
    disabled: false, value: '', rows: 0, id: '',
    classList: {
      add(...cs) { cs.forEach((c) => classes.add(c)); },
      remove(...cs) { cs.forEach((c) => classes.delete(c)); },
      toggle(c, on) {
        const want = on === undefined ? !classes.has(c) : !!on;
        if (want) classes.add(c); else classes.delete(c);
        return want;
      },
      contains(c) { return classes.has(c); },
    },
    appendChild(c) { children.push(c); c.parentNode = el; return c; },
    addEventListener(t, fn, opts) {
      (el._listeners[t] = el._listeners[t] || []).push({ fn, once: !!(opts && opts.once) });
    },
    removeEventListener(t, fn) {
      if (el._listeners[t]) el._listeners[t] = el._listeners[t].filter((e) => e.fn !== fn);
    },
    querySelector(sel) {
      if (sel[0] !== '.') throw new Error('mock querySelector only supports .class: ' + sel);
      return findByClass(el, sel.slice(1));
    },
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
  const kids = root.children || [];
  for (const c of kids) {
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
// Fire click listeners honoring once semantics (once handlers auto-detach
// BEFORE dispatch, like the real DOM) and await any returned promises.
async function click(el) {
  const entries = (el._listeners.click || []).slice();
  el._listeners.click = (el._listeners.click || []).filter((e) => !e.once);
  for (const e of entries) await e.fn({});
}
async function flush(n) {
  for (let i = 0; i < (n || 20); i++) await new Promise((r) => setImmediate(r));
}

// Build the #addAgentModal element tree the way renderer/index.html ships it.
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

// ---------------------------------------------------------------------------
// Stubbed window.api.fs backed by a real temp dir. `forceEmptyFindByExt` makes
// findByExt report an empty directory even when files exist on disk (to drive
// the write-time existence race guard). `failWrites` fails specific paths.
// ---------------------------------------------------------------------------
function makeWindow(opts) {
  const o = opts || {};
  const failWrites = o.failWrites || new Set();
  const calls = { findByExt: [], readFile: [], writeFile: [], exists: [], mkdir: [] };
  const window = {
    api: {
      fs: {
        async findByExt(root, ext) {
          calls.findByExt.push({ root, ext });
          if (o.forceEmptyFindByExt) return { ok: true, files: [] };
          try {
            const out = [];
            for (const name of fs.readdirSync(root)) {
              if (name.toLowerCase().endsWith(String(ext).toLowerCase())) out.push(path.join(root, name));
            }
            return { ok: true, files: out };
          } catch (err) {
            return { ok: false, error: err.message };
          }
        },
        async readFile(filePath) {
          calls.readFile.push({ filePath });
          try {
            return { ok: true, content: fs.readFileSync(filePath, 'utf8') };
          } catch (err) {
            return { ok: false, error: err.message };
          }
        },
        async writeFile(absPath, content) {
          calls.writeFile.push({ absPath, content });
          if (failWrites.has(absPath)) return { ok: false, error: 'EACCES: permission denied' };
          fs.mkdirSync(path.dirname(absPath), { recursive: true });
          fs.writeFileSync(absPath, content);
          return { ok: true, size: Buffer.byteLength(content) };
        },
        async exists(absPath) {
          calls.exists.push({ absPath });
          return { ok: true, exists: fs.existsSync(absPath) };
        },
        async mkdir(absPath) {
          calls.mkdir.push({ absPath });
          fs.mkdirSync(absPath, { recursive: true });
          return { ok: true };
        },
      },
      tasks: { async installSkill() { return { ok: true }; } },
    },
  };
  const noopConsole = { error() {}, warn() {}, log() {} };
  return { window, calls, noopConsole };
}

function makeProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'task095-'));
}
function seed(root, relParts, content) {
  const abs = path.join(root, ...relParts);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}
function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

// Open the modal, fill the form, click Create, wait for the async flow.
async function submitAgent(open, modal, fields) {
  open();
  await flush(); // let readExistingAgentNames snapshot resolve
  modal.querySelector('.addagent-name').value = fields.name != null ? fields.name : '';
  modal.querySelector('.addagent-description').value = fields.description != null ? fields.description : '';
  modal.querySelector('.addagent-tools').value = fields.tools != null ? fields.tools : '';
  modal.querySelector('.addagent-model').value = fields.model != null ? fields.model : '';
  if (fields.body != null) modal.querySelector('.addagent-body').value = fields.body;
  await click(modal.querySelector('.addagent-create'));
  await flush();
}

function agentsDir(root) { return path.join(root, '.claude', 'agents'); }
function agentFile(root, name) { return path.join(agentsDir(root), name + '.md'); }
function agentCardNames(body) {
  return (body.children || [])
    .filter((c) => c.classList && c.classList.contains('team-agent'))
    .map((c) => { const n = findByClass(c, 'team-agent-name'); return n ? n.textContent : null; });
}

// ===========================================================================
// Scenario: Creating orchestrate-docs
//   When the user submits name "orchestrate-docs" with a description
//   Then .claude/agents/orchestrate-docs.md is created with valid frontmatter
//   And it appears in the Agents panel
// ===========================================================================
test('Scenario: creating orchestrate-docs writes a valid .claude/agents/orchestrate-docs.md and it appears after refresh', async () => {
  // Given an open project (empty .claude/agents so the duplicate snapshot is clean).
  const root = makeProject();
  try {
    fs.mkdirSync(agentsDir(root), { recursive: true });
    const { window, calls, noopConsole } = makeWindow();
    const modal = makeAddAgentModal();
    const document = makeDocument({ addAgentModal: modal });
    const { openAddAgentModal } = makeRenderer(window, document, noopConsole);
    const tab = { folder: root, els: { teamAgentsBody: makeEl('div') } };

    // When the user submits a valid new agent with a description.
    const DESC = 'Documentation agent for the orchestrate workflow.';
    await submitAgent(() => openAddAgentModal(tab), modal, {
      name: 'orchestrate-docs',
      description: DESC,
      tools: 'Read, Grep, Glob',
      model: 'claude-fable-5',
    });

    // Then the file exists on disk and parses with valid frontmatter (via lib).
    const target = agentFile(root, 'orchestrate-docs');
    assert.ok(fs.existsSync(target), '.claude/agents/orchestrate-docs.md created');
    const parsed = parseAgentFile(fs.readFileSync(target, 'utf8'));
    assert.ok(parsed, 'the generated file parses through lib/agent-files.js');
    assert.equal(parsed.fm.name, 'orchestrate-docs', 'name frontmatter is correct');
    assert.equal(parsed.fm.description, DESC, 'description frontmatter is correct');
    assert.equal(parsed.fm.tools, 'Read, Grep, Glob', 'tools frontmatter is correct');
    assert.equal(parsed.fm.model, 'claude-fable-5', 'model frontmatter is correct');

    // And exactly ONE writeWithMirror primary write happened (no mirror — brand new).
    assert.equal(calls.writeFile.length, 1, 'exactly one write (mirror is a natural no-op for a new agent)');
    assert.equal(calls.mkdir.length, 1, '.claude/agents mkdir -p happened');

    // And the modal closed and the panel refreshed to show the new agent.
    assert.ok(modal.classList.contains('hidden'), 'the modal closed on success');
    assert.ok(agentCardNames(tab.els.teamAgentsBody).includes('orchestrate-docs'),
      'the new agent appears in the Agents panel after refresh');
  } finally {
    cleanup(root);
  }
});

// ===========================================================================
// Scenario: Duplicate name refused (failure)
//   Given orchestrate-ba exists
//   When the user submits "orchestrate-ba"
//   Then an inline error is shown and no file is written
// ===========================================================================
test('Scenario (failure): submitting an existing name shows an inline error and writes NO file', async () => {
  // Given orchestrate-ba already exists in .claude/agents/.
  const root = makeProject();
  try {
    seed(root, ['.claude', 'agents', 'ba.md'], REAL_BA); // frontmatter name: orchestrate-ba
    const { window, calls, noopConsole } = makeWindow();
    const modal = makeAddAgentModal();
    const document = makeDocument({ addAgentModal: modal });
    const { openAddAgentModal } = makeRenderer(window, document, noopConsole);
    const tab = { folder: root, els: { teamAgentsBody: makeEl('div') } };

    // When the user submits the duplicate name.
    await submitAgent(() => openAddAgentModal(tab), modal, {
      name: 'orchestrate-ba',
      description: 'A second BA — should be refused.',
    });

    // Then an inline error is shown and NO file was written.
    assert.match(modal.querySelector('.addagent-error').textContent, /already exists/i,
      'inline duplicate error shown');
    assert.equal(calls.writeFile.length, 0, 'no write attempted for a duplicate name');
    assert.equal(calls.mkdir.length, 0, 'no mkdir either (validation short-circuits before any I/O)');
    // And the modal stays open for a retry.
    assert.equal(modal.classList.contains('hidden'), false, 'the modal stays open after the error');
    // And the pre-existing file is byte-for-byte unchanged.
    assert.equal(fs.readFileSync(agentFile(root, 'ba'), 'utf8'), REAL_BA, 'existing agent file untouched');
  } finally {
    cleanup(root);
  }
});

// ===========================================================================
// Scenario: Fresh project (edge)
//   Given no .claude directory
//   When the user creates a valid agent
//   Then the directories are created and the file written
// ===========================================================================
test('Scenario (edge): a fresh project with no .claude directory has the dirs created and the file written', async () => {
  // Given a brand-new project folder with NO .claude at all.
  const root = makeProject();
  try {
    assert.equal(fs.existsSync(path.join(root, '.claude')), false, 'no .claude to start');
    const { window, calls, noopConsole } = makeWindow();
    const modal = makeAddAgentModal();
    const document = makeDocument({ addAgentModal: modal });
    const { openAddAgentModal } = makeRenderer(window, document, noopConsole);
    const tab = { folder: root, els: { teamAgentsBody: makeEl('div') } };

    // When the user creates a valid agent.
    await submitAgent(() => openAddAgentModal(tab), modal, {
      name: 'orchestrate-notes',
      description: 'Notes agent for a fresh project.',
    });

    // Then the .claude/agents directory was created and the file written.
    assert.ok(fs.existsSync(agentsDir(root)), '.claude/agents/ directory created');
    const target = agentFile(root, 'orchestrate-notes');
    assert.ok(fs.existsSync(target), 'the agent file was written');
    const parsed = parseAgentFile(fs.readFileSync(target, 'utf8'));
    assert.ok(parsed, 'the file parses');
    assert.equal(parsed.fm.name, 'orchestrate-notes', 'correct name');
    assert.equal(parsed.fm.description, 'Notes agent for a fresh project.', 'correct description');
    // No optional keys were emitted (none supplied).
    assert.ok(!('tools' in parsed.fm) && !('model' in parsed.fm), 'no blank optional keys');
    assert.equal(calls.mkdir.length, 1, 'mkdir -p happened');
    assert.equal(calls.writeFile.length, 1, 'one write');
    assert.ok(modal.classList.contains('hidden'), 'modal closed on success');
  } finally {
    cleanup(root);
  }
});

// ===========================================================================
// Scenario (failure): tools frontmatter injection is rejected — no write.
// ===========================================================================
test('Scenario (failure): a tools value with a newline injection is rejected inline with NO write', async () => {
  const root = makeProject();
  try {
    fs.mkdirSync(agentsDir(root), { recursive: true });
    const { window, calls, noopConsole } = makeWindow();
    const modal = makeAddAgentModal();
    const document = makeDocument({ addAgentModal: modal });
    const { openAddAgentModal } = makeRenderer(window, document, noopConsole);
    const tab = { folder: root, els: { teamAgentsBody: makeEl('div') } };

    // When the user submits a valid name but an injection-laden tools field.
    await submitAgent(() => openAddAgentModal(tab), modal, {
      name: 'orchestrate-docs',
      description: 'Valid description.',
      tools: 'Read\nname: evil',
    });

    // Then an inline error is shown, NO file was written, and no target exists.
    assert.match(modal.querySelector('.addagent-error').textContent, /single line|line break/i,
      'inline injection error shown');
    assert.equal(calls.writeFile.length, 0, 'no write for a rejected tools value');
    assert.equal(fs.existsSync(agentFile(root, 'orchestrate-docs')), false, 'no file created');
    assert.equal(modal.classList.contains('hidden'), false, 'modal stays open for a retry');
  } finally {
    cleanup(root);
  }
});

// ===========================================================================
// Scenario (failure/edge): an existing target file at write time aborts with an
// error and never overwrites (races with tasks:installSkill copying a bundled
// agent). findByExt is forced empty so the name snapshot misses it and the
// write-time existence check is the guard that fires.
// ===========================================================================
test('Scenario (failure): an existing target file at write time aborts without overwriting', async () => {
  const root = makeProject();
  try {
    // A file already sits at the target path, but the directory listing hides it
    // (simulating a copy that lands after the modal opened).
    const target = seed(root, ['.claude', 'agents', 'orchestrate-docs.md'], 'PRE-EXISTING CONTENT\n');
    const { window, calls, noopConsole } = makeWindow({ forceEmptyFindByExt: true });
    const modal = makeAddAgentModal();
    const document = makeDocument({ addAgentModal: modal });
    const { openAddAgentModal } = makeRenderer(window, document, noopConsole);
    const tab = { folder: root, els: { teamAgentsBody: makeEl('div') } };

    await submitAgent(() => openAddAgentModal(tab), modal, {
      name: 'orchestrate-docs',
      description: 'Should not overwrite the pre-existing file.',
    });

    // Then the write was aborted: an inline error, NO writeFile, file unchanged.
    assert.match(modal.querySelector('.addagent-error').textContent, /already exists|not overwriting/i,
      'inline "already exists / not overwriting" error shown');
    assert.equal(calls.writeFile.length, 0, 'no write attempted — no overwrite');
    assert.equal(fs.readFileSync(target, 'utf8'), 'PRE-EXISTING CONTENT\n', 'the pre-existing file is untouched');
    assert.equal(modal.classList.contains('hidden'), false, 'modal stays open after the abort');
  } finally {
    cleanup(root);
  }
});
