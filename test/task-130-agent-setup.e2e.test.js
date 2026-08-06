'use strict';

// ===========================================================================
// TASK-130 — e2e "cucumber" scenarios (Given/When/Then), implemented as plain
// `node --test` cases. NO cucumber npm package is installed or required; these
// are scenario-style node:test cases in Given/When/Then form covering EVERY
// Gherkin scenario in the ticket (both Features).
//
// Feature 1: the Agents editor exposes the full editable agent file (Description
//   / Tools / Model / Body, name read-only) and saves ONE whole-file write via
//   the mirror-aware writer, preserving every unchanged byte.
// Feature 2: AI regeneration of an agent file from a natural-language
//   instruction — preview-then-Save, with validation + failure handling.
//
// The subject under test is the REAL renderer code (renderer/renderer.js), whose
// buildAgentCard / refreshTeamAgents / writeWithMirror and pure helpers are
// EXTRACTED headless by brace-matching the source (the task-094 convention) and
// run against an INJECTED window + minimal in-memory mock document.
//
// ALL filesystem access goes through a STUBBED window.api.fs backed by a real
// TEMP dir (so on-disk byte-identity of the primary + mirror copies is asserted).
// ALL AI/"network" access goes through window.api.agents.regenerate, which is
// wired to the REAL lib/agent-regenerate.js with a MOCKED httpRequest — so the
// full renderer→(main-shaped bridge)→lib path is exercised with ONLY the network
// mocked. NO real DB, NO real Electron, NO real network, NO real API key.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { regenerateAgentFile } = require('../lib/agent-regenerate');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');
const REAL_BA = fs.readFileSync(path.join(REPO, '.claude', 'agents', 'ba.md'), 'utf8');
const BA_NAME = 'orchestrate-ba';
const BA_MODEL = 'claude-fable-5';

// --- Extract a named function declaration / const by brace-matching. ---------
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

function loadRenderer() {
  const body = [
    extractConst(rendererSrc, 'ASSETS_MIRRORED_SUBTREES'),
    extractConst(rendererSrc, 'AGENT_KEY_RE'),
    extractConst(rendererSrc, 'AGENT_BLOCK_RE'),
    extractConst(rendererSrc, 'AGENT_FENCE_RE'),
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
    extractFn(rendererSrc, 'serializeAgentModel'),
    extractFn(rendererSrc, 'serializeAgentEdits'),
    extractFn(rendererSrc, 'stripOneCodeFence'),
    extractFn(rendererSrc, 'validateRegeneratedAgent'),
    extractFn(rendererSrc, 'agentDescriptionValid'),
    extractFn(rendererSrc, 'sanitizeAgentScalarField'),
    extractFn(rendererSrc, 'sanitizeAgentToolsField'),
    extractFn(rendererSrc, 'sanitizeAgentModelField'),
    extractFn(rendererSrc, 'buildAgentsInstallHint'),
    extractFn(rendererSrc, 'buildAgentCard'),
    extractFn(rendererSrc, 'refreshTeamAgents'),
    'return { refreshTeamAgents, buildAgentCard, parseAgentFileRenderer, serializeAgentEdits };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function('window', 'document', 'console', body);
}
const makeRenderer = loadRenderer();

// --- Minimal in-memory mock DOM. `isConnected` defaults true (the stale-guard
//     in the regenerate handler checks editor.isConnected). -------------------
function makeEl(tag) {
  const classes = new Set();
  const children = [];
  let text = '';
  const el = {
    tagName: String(tag || '').toUpperCase(),
    dataset: {}, style: {}, children,
    _listeners: {},
    disabled: false, value: '', rows: 0, isConnected: true,
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
  return el;
}
function makeDocument() {
  return {
    createElement: (tag) => makeEl(tag),
    createTextNode: (t) => ({ _isText: true, textContent: String(t) }),
  };
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
async function fire(el, type) {
  const fns = (el._listeners && el._listeners[type]) || [];
  for (const fn of fns) await fn({});
}

// --- window.api backed by a real temp dir + an AI bridge wired to the REAL lib
//     with a MOCKED httpRequest (no network). ---------------------------------
function makeWindow(opts) {
  const o = opts || {};
  const failWrites = o.failWrites || new Set();
  const calls = { findByExt: [], readFile: [], writeFile: [], exists: [], regenerate: [], http: [] };

  // The AI bridge mirrors main.js's agents:regenerate handler: it takes
  // (content, instruction), supplies the configured apiKey, and delegates to the
  // REAL lib with a mocked httpRequest. `o.httpResponse` (or o.httpThrow) controls
  // the mocked network. This means: empty instruction / missing key genuinely
  // short-circuit BEFORE any http call, and we can assert calls.http.length.
  async function agentRegenerateBridge(content, instruction) {
    calls.regenerate.push({ content, instruction });
    const httpRequest = async (args) => {
      calls.http.push(args);
      if (o.httpThrow) throw new Error(o.httpThrow);
      return o.httpResponse;
    };
    const res = await regenerateAgentFile({
      apiKey: o.apiKey || '',
      content,
      instruction,
      httpRequest
    });
    return { ok: res.ok, content: res.content, reason: res.reason };
  }

  const window = {
    api: {
      fs: {
        async findByExt(root, ext) {
          calls.findByExt.push({ root, ext });
          try {
            const out = [];
            for (const name of fs.readdirSync(root)) {
              if (name.toLowerCase().endsWith(String(ext).toLowerCase())) out.push(path.join(root, name));
            }
            return { ok: true, files: out };
          } catch (err) { return { ok: false, error: err.message }; }
        },
        async readFile(filePath) {
          calls.readFile.push({ filePath });
          try {
            const buf = fs.readFileSync(filePath);
            const probe = buf.subarray(0, Math.min(8192, buf.length));
            for (let i = 0; i < probe.length; i++) {
              if (probe[i] === 0) return { ok: true, content: '(binary file)', binary: true, size: buf.length };
            }
            return { ok: true, content: buf.toString('utf8'), size: buf.length };
          } catch (err) { return { ok: false, error: err.message }; }
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
      },
      tasks: { async installSkill() { return { ok: true }; } },
      agents: { regenerate: agentRegenerateBridge },
      env: { async get(k) { return { ok: true, value: k === 'LOG_REDACTING_ANTHROPIC_KEY' ? (o.apiKey || '') : '' }; } },
    },
  };
  const noopConsole = { error() {}, warn() {}, log() {} };
  return { window, calls, document: makeDocument(), console: noopConsole };
}

function makeTab(folder) {
  return { folder, els: { teamAgentsBody: makeEl('div') } };
}
function makeProject() { return fs.mkdtempSync(path.join(os.tmpdir(), 'task130-')); }
function seed(root, relParts, content) {
  const abs = path.join(root, ...relParts);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}
function cleanup(root) { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } }

// Anthropic success body carrying `text` as the (raw) model output.
function okBody(text) {
  return JSON.stringify({ content: [{ type: 'text', text }] });
}

// Render the panel and return { body, card, editor, fields... } after clicking Edit.
async function openEditor(tab, window, document, console) {
  const { refreshTeamAgents } = makeRenderer(window, document, console);
  await refreshTeamAgents(tab);
  const body = tab.els.teamAgentsBody;
  const card = findByClass(body, 'team-agent');
  assert.ok(card, 'an agent card was rendered');
  await fire(findByClass(card, 'team-agent-edit'), 'click');
  const editor = findByClass(card, 'team-agent-desc-editor');
  return {
    body, card, editor,
    descInput: findByClass(card, 'team-agent-desc-input'),
    toolsInput: findByClass(card, 'team-agent-field-input'), // first field-input is Tools
    modelInput: (function () {
      // second .team-agent-field-input is Model.
      const found = [];
      (function walk(n) { (n.children || []).forEach((c) => { if (c.classList && c.classList.contains('team-agent-field-input')) found.push(c); walk(c); }); })(card);
      return found[1];
    })(),
    bodyInput: findByClass(card, 'team-agent-body-input'),
    aiInput: findByClass(card, 'team-agent-ai-input'),
  };
}

// Helper to locate the Regenerate button (the small-btn inside .team-agent-ai-actions).
function regenButton(card) {
  const actions = findByClass(card, 'team-agent-ai-actions');
  return actions.children[0];
}
function saveButton(card) { return findByClass(card, 'primary-btn'); }
function cancelButton(card) {
  // Cancel is the plain small-btn in .team-agent-desc-actions (not the primary).
  const actions = findByClass(card, 'team-agent-desc-actions');
  return actions.children.find((c) => !c.classList.contains('primary-btn'));
}

// ===========================================================================
// FEATURE 1 — Agent editor exposes the full editable agent file
// ===========================================================================

test('Scenario: Edit opens a structured editor for all editable parts (name read-only)', async () => {
  // Given a project folder open on the Team tab with a parseable agent card.
  const root = makeProject();
  try {
    seed(root, ['.claude', 'agents', 'ba.md'], REAL_BA);
    const { window, document, console } = makeWindow();
    const tab = makeTab(root);
    const ed = await openEditor(tab, window, document, console);

    // Then the editor shows fields pre-filled with description, tools, model, body.
    const { parseAgentFileRenderer } = makeRenderer(window, document, console);
    const parsed = parseAgentFileRenderer(REAL_BA);
    assert.equal(ed.editor.classList.contains('hidden'), false, 'editor visible after Edit');
    assert.equal(ed.descInput.value, parsed.fm.description, 'Description pre-filled');
    assert.equal(ed.toolsInput.value, String(parsed.fm.tools).trim(), 'Tools pre-filled');
    assert.equal(ed.modelInput.value, String(parsed.fm.model).trim(), 'Model pre-filled');
    assert.equal(ed.bodyInput.value, parsed.body, 'Body pre-filled');
    // And the agent name is shown but not editable (a read-only div, not an input).
    const nameRO = findByClass(ed.card, 'team-agent-field-readonly');
    assert.ok(nameRO, 'a read-only name field is shown');
    assert.equal(nameRO.textContent, BA_NAME, 'name shown');
    assert.equal(nameRO.tagName, 'DIV', 'name is a div, not an <input>');
  } finally { cleanup(root); }
});

test('Scenario: Saving a body-only edit preserves the frontmatter byte-for-byte and refreshes', async () => {
  const root = makeProject();
  try {
    const primaryPath = seed(root, ['.claude', 'agents', 'ba.md'], REAL_BA);
    const mirrorPath = seed(root, ['assets', 'agents', 'ba.md'], REAL_BA);
    const { window, calls, document, console } = makeWindow();
    const tab = makeTab(root);
    const ed = await openEditor(tab, window, document, console);
    const { parseAgentFileRenderer } = makeRenderer(window, document, console);
    const original = parseAgentFileRenderer(REAL_BA);

    // When I change ONLY the Body and click Save.
    ed.bodyInput.value = 'You are the business analyst.\n\nRewritten body only.\n';
    await fire(saveButton(ed.card), 'click');

    // Then the file is written once via the mirror-aware writer (primary + mirror).
    assert.equal(calls.writeFile.length, 2, 'one primary + one mirror write');
    const after = fs.readFileSync(primaryPath, 'utf8');
    const pAfter = parseAgentFileRenderer(after);
    // Frontmatter byte-identical to original.
    assert.deepEqual(pAfter.meta.keyOrder, original.meta.keyOrder, 'no keys changed');
    for (const key of original.meta.keyOrder) {
      assert.deepEqual(pAfter.meta.rawByKey[key], original.meta.rawByKey[key], `${key} raw lines byte-identical`);
    }
    assert.match(pAfter.body, /Rewritten body only/, 'body updated');
    // And the mirror is byte-identical to the primary.
    assert.ok(fs.readFileSync(primaryPath).equals(fs.readFileSync(mirrorPath)), 'mirror synced byte-for-byte');
    // And the panel re-read the directory (refreshTeamAgents → findByExt twice: open + after-save).
    assert.ok(calls.findByExt.length >= 2, 'the panel re-read .claude/agents after saving');
  } finally { cleanup(root); }
});

test('Scenario: Saving with no changes reproduces the file byte-identically', async () => {
  const root = makeProject();
  try {
    const primaryPath = seed(root, ['.claude', 'agents', 'ba.md'], REAL_BA);
    const { window, calls, document, console } = makeWindow();
    const tab = makeTab(root);
    const ed = await openEditor(tab, window, document, console);

    // When I click Save without changing any field.
    await fire(saveButton(ed.card), 'click');

    // Then the written content is byte-identical to the original.
    assert.equal(calls.writeFile[0].content, REAL_BA, 'written bytes == original file');
    assert.equal(fs.readFileSync(primaryPath, 'utf8'), REAL_BA, 'on disk == original');
  } finally { cleanup(root); }
});

test('Scenario: Invalid scalar field (Model with a line break) is rejected inline with NO write', async () => {
  const root = makeProject();
  try {
    seed(root, ['.claude', 'agents', 'ba.md'], REAL_BA);
    const { window, calls, document, console } = makeWindow();
    const tab = makeTab(root);
    const ed = await openEditor(tab, window, document, console);

    // When I set Model to a value containing a line break and Save.
    ed.modelInput.value = 'claude-sonnet-5\ninjected: true';
    await fire(saveButton(ed.card), 'click');

    // Then an inline error says the model must be a single line, and NO write occurs.
    const err = findByClass(ed.card, 'team-agent-desc-error');
    assert.equal(err.classList.contains('hidden'), false, 'inline error shown');
    assert.match(err.textContent, /single line/i, 'the model single-line rule is reported');
    assert.equal(calls.writeFile.length, 0, 'no file write occurred');
  } finally { cleanup(root); }
});

test('Scenario: Empty description is rejected inline with NO write', async () => {
  const root = makeProject();
  try {
    seed(root, ['.claude', 'agents', 'ba.md'], REAL_BA);
    const { window, calls, document, console } = makeWindow();
    const tab = makeTab(root);
    const ed = await openEditor(tab, window, document, console);

    // When I clear Description and click Save.
    ed.descInput.value = '   ';
    await fire(saveButton(ed.card), 'click');

    const err = findByClass(ed.card, 'team-agent-desc-error');
    assert.equal(err.classList.contains('hidden'), false, 'inline error shown');
    assert.match(err.textContent, /description cannot be empty/i, 'empty-description error reported');
    assert.equal(calls.writeFile.length, 0, 'no file write occurred');
  } finally { cleanup(root); }
});

test('Scenario: Cancel discards all edits, restores the read view, no write', async () => {
  const root = makeProject();
  try {
    seed(root, ['.claude', 'agents', 'ba.md'], REAL_BA);
    const { window, calls, document, console } = makeWindow();
    const tab = makeTab(root);
    const ed = await openEditor(tab, window, document, console);

    // When I change Tools and Body then click Cancel.
    ed.toolsInput.value = 'Read';
    ed.bodyInput.value = 'scratch edits';
    await fire(cancelButton(ed.card), 'click');

    // Then the read view is restored and no write occurred.
    assert.equal(ed.editor.classList.contains('hidden'), true, 'editor hidden after Cancel');
    const view = findByClass(ed.card, 'team-agent-desc-view');
    assert.equal(view.classList.contains('hidden'), false, 'read view restored');
    assert.equal(calls.writeFile.length, 0, 'no write on Cancel');
    // Re-opening shows the ORIGINAL values (edits were discarded).
    await fire(findByClass(ed.card, 'team-agent-edit'), 'click');
    const { parseAgentFileRenderer } = makeRenderer(window, document, console);
    assert.equal(ed.toolsInput.value, String(parseAgentFileRenderer(REAL_BA).fm.tools).trim(), 'Tools reset to original');
  } finally { cleanup(root); }
});

test('Scenario: Mirror-only write failure surfaces a drift warning naming BOTH paths', async () => {
  const root = makeProject();
  try {
    const primaryPath = seed(root, ['.claude', 'agents', 'ba.md'], REAL_BA);
    const mirrorPath = seed(root, ['assets', 'agents', 'ba.md'], REAL_BA);
    // The mirror write is configured to fail.
    const { window, calls, document, console } = makeWindow({ failWrites: new Set([mirrorPath]) });
    const tab = makeTab(root);
    const ed = await openEditor(tab, window, document, console);

    // When I save a valid edit.
    ed.descInput.value = 'A valid new description for the drift scenario, single line.';
    await fire(saveButton(ed.card), 'click');

    // Then the primary is written but an inline message names BOTH paths.
    assert.notEqual(fs.readFileSync(primaryPath, 'utf8'), REAL_BA, 'primary was written');
    const err = findByClass(ed.card, 'team-agent-desc-error');
    assert.equal(err.classList.contains('hidden'), false, 'drift warning shown');
    assert.ok(err.textContent.includes(primaryPath), 'names the primary path');
    assert.ok(err.textContent.includes(mirrorPath), 'names the mirror path');
    assert.match(err.textContent, /drift/i, 'calls it a drift');
    // Primary + attempted mirror = 2 write calls; the editor stays open.
    assert.equal(calls.writeFile.length, 2, 'primary + attempted mirror');
    assert.equal(ed.editor.classList.contains('hidden'), false, 'editor stays open on drift');
  } finally { cleanup(root); }
});

test('Scenario: A primary-write failure keeps the editor open with the text and shows the error', async () => {
  const root = makeProject();
  try {
    const primaryPath = seed(root, ['.claude', 'agents', 'ba.md'], REAL_BA);
    const { window, document, console } = makeWindow({ failWrites: new Set([primaryPath]) });
    const tab = makeTab(root);
    const ed = await openEditor(tab, window, document, console);

    ed.descInput.value = 'A valid new description; the primary write will fail.';
    await fire(saveButton(ed.card), 'click');

    const err = findByClass(ed.card, 'team-agent-desc-error');
    assert.equal(err.classList.contains('hidden'), false, 'error shown');
    assert.match(err.textContent, /Save failed/i, 'reports the primary failure');
    assert.equal(ed.editor.classList.contains('hidden'), false, 'editor stays open');
    assert.equal(ed.descInput.value, 'A valid new description; the primary write will fail.', 'user text kept');
    assert.equal(fs.readFileSync(primaryPath, 'utf8'), REAL_BA, 'file unchanged on disk');
  } finally { cleanup(root); }
});

test('Scenario: Unparseable agent file has no editor and no AI controls', async () => {
  const root = makeProject();
  try {
    const BROKEN = '---\nname: broken\ndescription: >-\n  never closes its frontmatter\nno closing fence here\n';
    const brokenPath = seed(root, ['.claude', 'agents', 'broken.md'], BROKEN);
    const { window, calls, document, console } = makeWindow();
    const { refreshTeamAgents } = makeRenderer(window, document, console);
    const tab = makeTab(root);
    await refreshTeamAgents(tab);

    const badge = findByClass(tab.els.teamAgentsBody, 'team-agent-unparseable');
    assert.ok(badge, 'an "unparseable" badge is shown');
    const brokenCard = badge.parentNode.parentNode; // badge -> head -> card
    assert.equal(findByClass(brokenCard, 'team-agent-edit'), null, 'no Edit button');
    assert.equal(findByClass(brokenCard, 'team-agent-ai-input'), null, 'no AI instruction box');
    assert.equal(findByClass(brokenCard, 'team-agent-ai-actions'), null, 'no Regenerate control');
    assert.equal(calls.writeFile.length, 0, 'never rewritten');
    assert.equal(fs.readFileSync(brokenPath, 'utf8'), BROKEN, 'byte-for-byte unchanged');
  } finally { cleanup(root); }
});

// ===========================================================================
// FEATURE 2 — AI regeneration from a natural-language instruction
// ===========================================================================

// A valid regenerated file the "API" returns for orchestrate-ba.
const REGEN_OK = [
  '---',
  'name: ' + BA_NAME,
  'description: >-',
  '  Business analyst that now also mentions linting in its remit.',
  'tools: Read, Grep, Glob, Bash',
  'model: ' + BA_MODEL,
  '---',
  '',
  'You are the business analyst. Also run the linter.',
  ''
].join('\n');

test('Scenario: Successful regeneration previews the result without writing, then Save persists', async () => {
  const root = makeProject();
  try {
    const primaryPath = seed(root, ['.claude', 'agents', 'ba.md'], REAL_BA);
    seed(root, ['assets', 'agents', 'ba.md'], REAL_BA);
    // Given LOG_REDACTING_ANTHROPIC_KEY is configured and the API returns a valid file.
    const { window, calls, document, console } = makeWindow({
      apiKey: 'sk-key', httpResponse: { status: 200, body: okBody(REGEN_OK) }
    });
    const tab = makeTab(root);
    const ed = await openEditor(tab, window, document, console);

    // When I type an instruction and click Regenerate.
    ed.aiInput.value = 'also allow the Bash tool and mention linting in the description';
    await fire(regenButton(ed.card), 'click');

    // Then the fields are replaced with the AI proposal.
    assert.match(ed.descInput.value, /mentions linting/, 'Description replaced by proposal');
    assert.equal(ed.toolsInput.value, 'Read, Grep, Glob, Bash', 'Tools replaced');
    assert.equal(ed.modelInput.value, BA_MODEL, 'Model replaced');
    assert.match(ed.bodyInput.value, /run the linter/, 'Body replaced');
    // And a note indicates it is an AI proposal pending Save.
    const note = findByClass(ed.card, 'team-agent-ai-note');
    assert.equal(note.classList.contains('hidden'), false, 'AI-proposal note visible');
    // And no file has been written yet.
    assert.equal(calls.writeFile.length, 0, 'nothing written on regenerate');
    assert.equal(calls.http.length, 1, 'exactly one API round-trip');
    assert.equal(fs.readFileSync(primaryPath, 'utf8'), REAL_BA, 'file still unchanged');

    // When I click Save → the proposal is written via the mirror-aware writer.
    await fire(saveButton(ed.card), 'click');
    assert.equal(calls.writeFile.length, 2, 'Save writes primary + mirror');
    const after = fs.readFileSync(primaryPath, 'utf8');
    assert.match(after, /mentions linting/, 'the proposal was persisted');
  } finally { cleanup(root); }
});

test('Scenario: Empty instruction makes NO API call', async () => {
  const root = makeProject();
  try {
    seed(root, ['.claude', 'agents', 'ba.md'], REAL_BA);
    const { window, calls, document, console } = makeWindow({ apiKey: 'sk-key', httpResponse: { status: 200, body: okBody(REGEN_OK) } });
    const tab = makeTab(root);
    const ed = await openEditor(tab, window, document, console);

    // When I click Regenerate with an empty instruction box.
    ed.aiInput.value = '   ';
    await fire(regenButton(ed.card), 'click');

    // Then an inline error asks for an instruction and NO request is sent.
    const msg = findByClass(ed.card, 'team-agent-ai-msg');
    assert.equal(msg.classList.contains('hidden'), false, 'inline AI message shown');
    assert.match(msg.textContent, /instruction/i, 'asks for an instruction');
    assert.equal(calls.regenerate.length, 0, 'the AI bridge was never called');
    assert.equal(calls.http.length, 0, 'no API request sent');
  } finally { cleanup(root); }
});

test('Scenario: Missing API key is reported without hitting the API', async () => {
  const root = makeProject();
  try {
    seed(root, ['.claude', 'agents', 'ba.md'], REAL_BA);
    // Given LOG_REDACTING_ANTHROPIC_KEY is NOT set (apiKey '').
    const { window, calls, document, console } = makeWindow({ apiKey: '', httpResponse: { status: 200, body: okBody(REGEN_OK) } });
    const tab = makeTab(root);
    const ed = await openEditor(tab, window, document, console);

    ed.aiInput.value = 'add the Bash tool';
    await fire(regenButton(ed.card), 'click');

    // Then a message says the key must be configured and NO API request is sent.
    const msg = findByClass(ed.card, 'team-agent-ai-msg');
    assert.equal(msg.classList.contains('hidden'), false, 'inline AI message shown');
    assert.match(msg.textContent, /LOG_REDACTING_ANTHROPIC_KEY/i, 'names the key requirement');
    assert.equal(calls.http.length, 0, 'no API request reached the network boundary (lib short-circuits on no-key)');
    assert.equal(calls.writeFile.length, 0, 'nothing written');
  } finally { cleanup(root); }
});

test('Scenario: AI returns malformed frontmatter and is rejected, keeping current values', async () => {
  const root = makeProject();
  try {
    seed(root, ['.claude', 'agents', 'ba.md'], REAL_BA);
    const { window, calls, document, console } = makeWindow({
      apiKey: 'sk-key', httpResponse: { status: 200, body: okBody('Sure, here is your agent! (prose, not a file)') }
    });
    const tab = makeTab(root);
    const ed = await openEditor(tab, window, document, console);
    // Capture the user's in-progress edits.
    ed.descInput.value = 'My own edited description, kept on failure.';
    const beforeDesc = ed.descInput.value;

    ed.aiInput.value = 'do something';
    await fire(regenButton(ed.card), 'click');

    const msg = findByClass(ed.card, 'team-agent-ai-msg');
    assert.equal(msg.classList.contains('hidden'), false, 'inline error shown');
    assert.match(msg.textContent, /invalid agent file/i, 'reports an invalid agent file');
    assert.equal(ed.descInput.value, beforeDesc, 'the user edits are preserved');
    assert.equal(calls.writeFile.length, 0, 'no write occurs');
  } finally { cleanup(root); }
});

test('Scenario: AI attempts to rename the agent and is rejected', async () => {
  const root = makeProject();
  try {
    seed(root, ['.claude', 'agents', 'ba.md'], REAL_BA);
    const renamed = REGEN_OK.replace('name: ' + BA_NAME, 'name: orchestrate-evil');
    const { window, calls, document, console } = makeWindow({ apiKey: 'sk-key', httpResponse: { status: 200, body: okBody(renamed) } });
    const tab = makeTab(root);
    const ed = await openEditor(tab, window, document, console);

    ed.aiInput.value = 'rename yourself';
    await fire(regenButton(ed.card), 'click');

    const msg = findByClass(ed.card, 'team-agent-ai-msg');
    assert.equal(msg.classList.contains('hidden'), false, 'inline error shown');
    assert.match(msg.textContent, /invalid agent file/i, 'the rename is rejected');
    assert.equal(calls.writeFile.length, 0, 'no write occurs');
  } finally { cleanup(root); }
});

test('Scenario: AI output smuggles a frontmatter injection (model begins with ---) and is rejected', async () => {
  const root = makeProject();
  try {
    seed(root, ['.claude', 'agents', 'ba.md'], REAL_BA);
    const injected = REGEN_OK.replace('model: ' + BA_MODEL, 'model: ---injected');
    const { window, calls, document, console } = makeWindow({ apiKey: 'sk-key', httpResponse: { status: 200, body: okBody(injected) } });
    const tab = makeTab(root);
    const ed = await openEditor(tab, window, document, console);

    ed.aiInput.value = 'inject a scalar';
    await fire(regenButton(ed.card), 'click');

    const msg = findByClass(ed.card, 'team-agent-ai-msg');
    assert.equal(msg.classList.contains('hidden'), false, 'inline error shown');
    assert.match(msg.textContent, /invalid agent file/i, 'the injected scalar is rejected');
    assert.equal(calls.writeFile.length, 0, 'no write occurs');
  } finally { cleanup(root); }
});

test('Scenario: AI output wrapped in a ```markdown code fence is tolerated and previewed', async () => {
  const root = makeProject();
  try {
    seed(root, ['.claude', 'agents', 'ba.md'], REAL_BA);
    const fenced = '```markdown\n' + REGEN_OK + '\n```';
    const { window, calls, document, console } = makeWindow({ apiKey: 'sk-key', httpResponse: { status: 200, body: okBody(fenced) } });
    const tab = makeTab(root);
    const ed = await openEditor(tab, window, document, console);

    ed.aiInput.value = 'wrap it in a fence please';
    await fire(regenButton(ed.card), 'click');

    // Then the fence is stripped and the proposal previews normally.
    const note = findByClass(ed.card, 'team-agent-ai-note');
    assert.equal(note.classList.contains('hidden'), false, 'proposal note shown (fence tolerated)');
    assert.match(ed.descInput.value, /mentions linting/, 'the fenced file was parsed and previewed');
    assert.equal(calls.writeFile.length, 0, 'nothing written on preview');
  } finally { cleanup(root); }
});

test('Scenario: API failure (non-200) reports an error, re-enables Regenerate, leaves fields unchanged', async () => {
  const root = makeProject();
  try {
    seed(root, ['.claude', 'agents', 'ba.md'], REAL_BA);
    const { window, calls, document, console } = makeWindow({ apiKey: 'sk-key', httpResponse: { status: 500, body: 'boom' } });
    const tab = makeTab(root);
    const ed = await openEditor(tab, window, document, console);
    ed.descInput.value = 'Edited description that must survive an API failure.';
    ed.aiInput.value = 'do a thing';
    const before = ed.descInput.value;

    await fire(regenButton(ed.card), 'click');

    const msg = findByClass(ed.card, 'team-agent-ai-msg');
    assert.equal(msg.classList.contains('hidden'), false, 'inline failure message shown');
    assert.match(msg.textContent, /failed/i, 'reports the failure');
    const rb = regenButton(ed.card);
    assert.equal(rb.disabled, false, 'Regenerate is re-enabled');
    assert.equal(ed.descInput.value, before, 'field values unchanged');
    assert.equal(ed.aiInput.value, 'do a thing', 'instruction unchanged');
    assert.equal(calls.writeFile.length, 0, 'no write occurs');
  } finally { cleanup(root); }
});

test('Scenario: API timeout (network error) reports an error and leaves the editor untouched', async () => {
  const root = makeProject();
  try {
    seed(root, ['.claude', 'agents', 'ba.md'], REAL_BA);
    const { window, calls, document, console } = makeWindow({ apiKey: 'sk-key', httpThrow: 'anthropic request timed out' });
    const tab = makeTab(root);
    const ed = await openEditor(tab, window, document, console);
    ed.aiInput.value = 'do a thing';

    await fire(regenButton(ed.card), 'click');

    const msg = findByClass(ed.card, 'team-agent-ai-msg');
    assert.equal(msg.classList.contains('hidden'), false, 'inline failure message shown on timeout');
    assert.match(msg.textContent, /failed/i, 'reports the failure');
    assert.equal(regenButton(ed.card).disabled, false, 'Regenerate re-enabled');
    assert.equal(calls.writeFile.length, 0, 'no write occurs');
  } finally { cleanup(root); }
});

test('Scenario: a response arriving after the folder changed is discarded (no DOM update, no write)', async () => {
  const root = makeProject();
  try {
    seed(root, ['.claude', 'agents', 'ba.md'], REAL_BA);
    // The AI bridge swaps the tab's teamAgentsBody (a folder change) WHILE the
    // request is in flight, so the stale-guard must discard the response.
    let bridgeCalls = 0;
    const httpCalls = [];
    const { window, calls, document, console } = makeWindow({ apiKey: 'sk-key', httpResponse: { status: 200, body: okBody(REGEN_OK) } });
    // Wrap the bridge so it mutates tab.els.teamAgentsBody before resolving.
    const realBridge = window.api.agents.regenerate;
    const tab = makeTab(root);
    window.api.agents.regenerate = async (content, instruction) => {
      bridgeCalls += 1;
      const res = await realBridge(content, instruction);
      // Simulate a folder/tab change: the panel body element is replaced.
      tab.els.teamAgentsBody = makeEl('div');
      return res;
    };
    const ed = await openEditor(tab, window, document, console);
    ed.aiInput.value = 'change something';
    const descBefore = ed.descInput.value;

    await fire(regenButton(ed.card), 'click');

    // Then the response is discarded: the preview note is NOT shown and fields
    // are unchanged, and nothing was written.
    assert.equal(bridgeCalls, 1, 'the request was actually issued');
    const note = findByClass(ed.card, 'team-agent-ai-note');
    assert.equal(note.classList.contains('hidden'), true, 'stale response did NOT show the proposal note');
    assert.equal(ed.descInput.value, descBefore, 'fields untouched by the stale response');
    assert.equal(calls.writeFile.length, 0, 'no write from a stale response');
  } finally { cleanup(root); }
});
