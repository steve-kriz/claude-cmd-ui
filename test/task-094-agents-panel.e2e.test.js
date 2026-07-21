'use strict';

// ===========================================================================
// TASK-094 — e2e "cucumber" scenarios (Given/When/Then), implemented as plain
// `node --test` cases. NO cucumber npm package is installed or required; these
// are scenario-style node:test cases in Given/When/Then form.
//
// Feature: the Team tab Agents panel — list `<folder>/.claude/agents/*.md`
// (name/model/tools/description), edit a description in place, and save it
// through writeWithMirror so a bundled agent's assets/ mirror stays byte-synced.
//
// The subject under test is the REAL renderer code (renderer/renderer.js, a
// browser script with no module.exports). refreshTeamAgents, buildAgentCard,
// buildAgentsInstallHint and the pure helpers are EXTRACTED headless by
// brace-matching the source (the convention of
// test/task-093-assets-mirror.e2e.test.js) and evaluated with an INJECTED
// `window` + a minimal in-memory mock `document`.
//
// ALL filesystem/Electron access goes through a STUBBED `window.api.fs`
// (findByExt / readFile / writeFile / exists) and `window.api.tasks.installSkill`.
// NO real DB / Electron / network. The stub is backed by real TEMP directories
// so byte-identity of the written primary + mirror copies is asserted on disk,
// and it can be told to fail specific write paths to drive the failure scenarios.
// The four REAL bundled agent files are used read-only as fixtures.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

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

// Load the REAL renderer helpers headless, injecting window/document/console.
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
    extractFn(rendererSrc, 'sanitizeAgentScalarField'),
    extractFn(rendererSrc, 'sanitizeAgentToolsField'),
    extractFn(rendererSrc, 'sanitizeAgentModelField'),
    extractFn(rendererSrc, 'agentDescriptionValid'),
    extractFn(rendererSrc, 'buildAgentsInstallHint'),
    extractFn(rendererSrc, 'buildAgentCard'),
    extractFn(rendererSrc, 'refreshTeamAgents'),
    'return { refreshTeamAgents, parseAgentFileRenderer, serializeAgentDescription };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function('window', 'document', 'console', body);
}
const makeRenderer = loadRenderer();

// ---------------------------------------------------------------------------
// Minimal in-memory mock DOM. className is backed by the same class set that
// classList mutates (like the real DOM). textContent, when set, clears children.
// ---------------------------------------------------------------------------
function makeEl(tag) {
  const classes = new Set();
  const children = [];
  let text = '';
  const el = {
    tagName: String(tag || '').toUpperCase(),
    dataset: {}, style: {}, children,
    _listeners: {},
    disabled: false, value: '', rows: 0,
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
// Recursively find the first descendant whose classList contains `cls`.
function findByClass(root, cls) {
  const kids = root.children || [];
  for (const c of kids) {
    if (c.classList && c.classList.contains(cls)) return c;
    const deep = findByClass(c, cls);
    if (deep) return deep;
  }
  return null;
}
// Fire all listeners of a type and await any returned promises.
async function fire(el, type) {
  const fns = (el._listeners && el._listeners[type]) || [];
  for (const fn of fns) await fn({});
}

// ---------------------------------------------------------------------------
// Stubbed window.api backed by a real temp dir. `failWrites` is a Set of
// absolute paths whose writeFile returns { ok:false }. `installSkill` can be
// configured per test.
// ---------------------------------------------------------------------------
function makeWindow(opts) {
  const o = opts || {};
  const failWrites = o.failWrites || new Set();
  const calls = { findByExt: [], readFile: [], writeFile: [], exists: [], installSkill: [] };
  const window = {
    api: {
      fs: {
        async findByExt(root, ext) {
          calls.findByExt.push({ root, ext });
          const out = [];
          try {
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
            const buf = fs.readFileSync(filePath);
            // Binary heuristic: NUL byte in first 8KB (mirrors main.js).
            const probe = buf.subarray(0, Math.min(8192, buf.length));
            for (let i = 0; i < probe.length; i++) {
              if (probe[i] === 0) return { ok: true, content: `(binary file)`, binary: true, size: buf.length };
            }
            return { ok: true, content: buf.toString('utf8'), size: buf.length };
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
      },
      tasks: {
        async installSkill(projectPath) {
          calls.installSkill.push({ projectPath });
          return o.installSkill ? o.installSkill(projectPath) : { ok: true };
        },
      },
    },
  };
  const noopConsole = { error() {}, warn() {}, log() {} };
  return { window, calls, document: makeDocument(), console: noopConsole };
}

// Build a tab whose els.teamAgentsBody is a mock element.
function makeTab(folder) {
  return { folder, els: { teamAgentsBody: makeEl('div') } };
}

// --- Temp project helpers. -------------------------------------------------
function makeProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'task094-'));
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

// ===========================================================================
// Scenario: Listing and editing
//   Given .claude/agents/ba.md exists with an assets mirror
//   When the user saves a new description for orchestrate-ba
//   Then the file is rewritten with only the description changed
//   And assets/agents/ba.md is byte-identical to it
// ===========================================================================
test('Scenario: listing then saving a new description rewrites ONLY the description and keeps the assets mirror byte-identical', async () => {
  // Given a project with .claude/agents/ba.md and a matching assets mirror.
  const root = makeProject();
  try {
    const primaryPath = seed(root, ['.claude', 'agents', 'ba.md'], REAL_BA);
    const mirrorPath = seed(root, ['assets', 'agents', 'ba.md'], REAL_BA);
    const { window, calls, document, console } = makeWindow();
    const { refreshTeamAgents, parseAgentFileRenderer, serializeAgentDescription } = makeRenderer(window, document, console);
    const tab = makeTab(root);
    const body = tab.els.teamAgentsBody;

    // When the panel is refreshed it LISTS the agent with its frontmatter fields.
    await refreshTeamAgents(tab);
    const card = findByClass(body, 'team-agent');
    assert.ok(card, 'an agent card was rendered');
    assert.equal(findByClass(card, 'team-agent-name').textContent, 'orchestrate-ba', 'name shown');
    assert.equal(findByClass(card, 'team-agent-model').textContent, 'claude-fable-5', 'model shown');
    assert.equal(findByClass(card, 'team-agent-tools').textContent, 'Read, Grep, Glob', 'tools shown');
    assert.match(findByClass(card, 'team-agent-desc-text').textContent, /Business analyst/, 'description shown');

    // When the user clicks Edit, the editor opens seeded with the current text.
    await fire(findByClass(card, 'team-agent-edit'), 'click');
    const editor = findByClass(card, 'team-agent-desc-editor');
    assert.equal(editor.classList.contains('hidden'), false, 'editor is visible after Edit');
    const textarea = findByClass(card, 'team-agent-desc-input');
    const original = parseAgentFileRenderer(REAL_BA);
    assert.equal(textarea.value, original.fm.description, 'textarea seeded with current description');

    // When the user types a NEW description and clicks Save.
    const NEW = 'A brand new business-analyst description for orchestrate-ba, edited via the panel.';
    textarea.value = NEW;
    // Save is the primary-btn; Cancel is the plain small-btn.
    await fire(findByClass(card, 'primary-btn'), 'click');

    // Then the primary file is rewritten with ONLY the description changed.
    const after = fs.readFileSync(primaryPath, 'utf8');
    assert.notEqual(after, REAL_BA, 'the file changed');
    const pAfter = parseAgentFileRenderer(after);
    assert.deepEqual(pAfter.meta.keyOrder, original.meta.keyOrder, 'no keys added/removed');
    for (const key of original.meta.keyOrder) {
      if (key === 'description') continue;
      assert.deepEqual(pAfter.meta.rawByKey[key], original.meta.rawByKey[key], `${key} raw lines byte-identical`);
    }
    assert.equal(pAfter.body, original.body, 'body preserved');
    assert.equal(pAfter.fm.description, NEW, 'description updated to the new value');
    // And the exact bytes equal a description-only re-serialize (nothing else touched).
    assert.equal(after, serializeAgentDescription(original, NEW), 'on-disk bytes == description-only rewrite');

    // And assets/agents/ba.md is byte-identical to the primary (mirror synced).
    assert.ok(
      fs.readFileSync(primaryPath).equals(fs.readFileSync(mirrorPath)),
      'assets mirror is byte-for-byte identical to the primary',
    );
    // And exactly the primary + mirror writes happened for the save.
    assert.equal(calls.writeFile.length, 2, 'primary + mirror written once each');
  } finally {
    cleanup(root);
  }
});

// ===========================================================================
// Scenario: Missing agents folder (edge)
//   Given no .claude/agents directory
//   Then an install-skill hint is shown and nothing throws
// ===========================================================================
test('Scenario (edge): a missing .claude/agents directory shows the install-skill hint and never throws', async () => {
  // Given a project with NO .claude/agents directory at all.
  const root = makeProject();
  try {
    const { window, calls, document, console } = makeWindow();
    const { refreshTeamAgents } = makeRenderer(window, document, console);
    const tab = makeTab(root);
    const body = tab.els.teamAgentsBody;

    // When the panel refreshes — it must not throw.
    await assert.doesNotReject(() => refreshTeamAgents(tab), 'refresh does not throw on a missing folder');

    // Then the install-skill hint is shown (banner + install button), not an error.
    const hint = findByClass(body, 'teamAgentsHint');
    assert.ok(hint, 'an install-skill hint banner is rendered');
    assert.ok(hint.classList.contains('install-banner'), 'reuses the install-banner styling');
    const installBtn = findByClass(body, 'teamAgentsInstallBtn');
    assert.ok(installBtn, 'an install button is present');
    assert.match(installBtn.textContent, /Install orchestration skill/, 'button offers to install the skill');
    // And no cards / no writes happened.
    assert.equal(findByClass(body, 'team-agent'), null, 'no agent cards rendered');
    assert.equal(calls.writeFile.length, 0, 'nothing was written');

    // And clicking Install routes to tasks.installSkill and then re-reads the dir.
    await fire(installBtn, 'click');
    assert.equal(calls.installSkill.length, 1, 'install button drives tasks.installSkill');
    assert.equal(calls.installSkill[0].projectPath, root, 'installs into the open folder');
  } finally {
    cleanup(root);
  }
});

test('Scenario (edge): an EMPTY .claude/agents directory also shows the install-skill hint', async () => {
  const root = makeProject();
  try {
    fs.mkdirSync(path.join(root, '.claude', 'agents'), { recursive: true });
    const { window, calls, document, console } = makeWindow();
    const { refreshTeamAgents } = makeRenderer(window, document, console);
    const tab = makeTab(root);
    await refreshTeamAgents(tab);
    assert.ok(findByClass(tab.els.teamAgentsBody, 'teamAgentsInstallBtn'), 'install hint shown for an empty folder');
    assert.equal(calls.writeFile.length, 0, 'nothing written');
  } finally {
    cleanup(root);
  }
});

// ===========================================================================
// Scenario: Unparseable agent file (failure)
//   Given .claude/agents/broken.md with no closing fence
//   Then it is listed as unparseable, editing disabled, file never modified
// ===========================================================================
test('Scenario (failure): an unparseable agent file is listed unparseable with editing disabled and is never modified', async () => {
  // Given a broken agent file (opening fence but NO closing fence) beside a valid one.
  const root = makeProject();
  try {
    const BROKEN = '---\nname: broken\ndescription: >-\n  never closes its frontmatter\nbody with no closing fence\n';
    const brokenPath = seed(root, ['.claude', 'agents', 'broken.md'], BROKEN);
    seed(root, ['.claude', 'agents', 'ba.md'], REAL_BA);
    const { window, calls, document, console } = makeWindow();
    const { refreshTeamAgents } = makeRenderer(window, document, console);
    const tab = makeTab(root);
    const body = tab.els.teamAgentsBody;

    // When the panel refreshes.
    await refreshTeamAgents(tab);

    // Then broken.md is listed by filename with an "unparseable" badge.
    const badge = findByClass(body, 'team-agent-unparseable');
    assert.ok(badge, 'an "unparseable" badge is shown');
    assert.equal(badge.textContent, 'unparseable');
    // And its card has NO editing affordances (no textarea, no Edit button).
    const brokenCard = badge.parentNode.parentNode; // badge -> head -> card
    assert.match(findByClass(brokenCard, 'team-agent-name').textContent, /broken\.md/, 'listed by filename');
    assert.equal(findByClass(brokenCard, 'team-agent-desc-input'), null, 'no textarea — editing disabled');
    assert.equal(findByClass(brokenCard, 'team-agent-edit'), null, 'no Edit button — editing disabled');

    // And the file on disk was never modified (no write of any kind occurred).
    assert.equal(calls.writeFile.length, 0, 'no writes happened');
    assert.equal(fs.readFileSync(brokenPath, 'utf8'), BROKEN, 'the broken file is byte-for-byte unchanged');
  } finally {
    cleanup(root);
  }
});

// ===========================================================================
// Scenario: Empty description rejected (failure)
//   When the user clears the description and saves
//   Then an inline error is shown and no file is written
// ===========================================================================
test('Scenario (failure): clearing the description and saving shows an inline error and writes NO file', async () => {
  const root = makeProject();
  try {
    const primaryPath = seed(root, ['.claude', 'agents', 'ba.md'], REAL_BA);
    const { window, calls, document, console } = makeWindow();
    const { refreshTeamAgents } = makeRenderer(window, document, console);
    const tab = makeTab(root);
    const body = tab.els.teamAgentsBody;

    await refreshTeamAgents(tab);
    const card = findByClass(body, 'team-agent');
    await fire(findByClass(card, 'team-agent-edit'), 'click');
    const textarea = findByClass(card, 'team-agent-desc-input');

    // When the user clears the description (whitespace only) and clicks Save.
    textarea.value = '   \n\t ';
    await fire(findByClass(card, 'primary-btn'), 'click');

    // Then an inline error is shown and NO file was written.
    const err = findByClass(card, 'team-agent-desc-error');
    assert.equal(err.classList.contains('hidden'), false, 'the inline error is visible');
    assert.match(err.textContent, /empty/i, 'error explains the empty description');
    assert.equal(calls.writeFile.length, 0, 'no write attempted for an empty description');
    assert.equal(fs.readFileSync(primaryPath, 'utf8'), REAL_BA, 'file unchanged on disk');
    // And the editor stays open (still editing).
    assert.equal(findByClass(card, 'team-agent-desc-editor').classList.contains('hidden'), false, 'editor stays open');
  } finally {
    cleanup(root);
  }
});

// ===========================================================================
// Scenario (failure): the primary write fails
//   Then the editor stays open with the user's text and an inline error.
// ===========================================================================
test('Scenario (failure): a failed primary write keeps the editor open with the text and shows an inline error', async () => {
  const root = makeProject();
  try {
    const primaryPath = seed(root, ['.claude', 'agents', 'ba.md'], REAL_BA);
    const { window, calls, document, console } = makeWindow({ failWrites: new Set([primaryPath]) });
    const { refreshTeamAgents } = makeRenderer(window, document, console);
    const tab = makeTab(root);
    const body = tab.els.teamAgentsBody;

    await refreshTeamAgents(tab);
    const card = findByClass(body, 'team-agent');
    await fire(findByClass(card, 'team-agent-edit'), 'click');
    const textarea = findByClass(card, 'team-agent-desc-input');
    const TYPED = 'A valid new description that the write layer will reject.';
    textarea.value = TYPED;
    await fire(findByClass(card, 'primary-btn'), 'click');

    // Then the editor stays open, keeps the typed text, and shows an inline error.
    assert.equal(findByClass(card, 'team-agent-desc-editor').classList.contains('hidden'), false, 'editor stays open');
    assert.equal(textarea.value, TYPED, 'the user text is preserved');
    const err = findByClass(card, 'team-agent-desc-error');
    assert.equal(err.classList.contains('hidden'), false, 'inline error visible');
    assert.match(err.textContent, /Save failed/i, 'error names the failure');
    // The primary write was attempted (and failed); no mirror write followed.
    assert.equal(calls.writeFile.length, 1, 'only the primary write was attempted');
    assert.equal(fs.readFileSync(primaryPath, 'utf8'), REAL_BA, 'file unchanged after a failed write');
  } finally {
    cleanup(root);
  }
});

// ===========================================================================
// Scenario (failure): mirror-only write failure surfaces a drift warning naming
// BOTH the primary path and the mirror path (Q6 auto-sync).
// ===========================================================================
test('Scenario (failure): a mirror-only write failure shows a drift warning naming BOTH paths', async () => {
  const root = makeProject();
  try {
    const primaryPath = seed(root, ['.claude', 'agents', 'ba.md'], REAL_BA);
    const mirrorPath = seed(root, ['assets', 'agents', 'ba.md'], REAL_BA);
    const { window, calls, document, console } = makeWindow({ failWrites: new Set([mirrorPath]) });
    const { refreshTeamAgents } = makeRenderer(window, document, console);
    const tab = makeTab(root);
    const body = tab.els.teamAgentsBody;

    await refreshTeamAgents(tab);
    const card = findByClass(body, 'team-agent');
    await fire(findByClass(card, 'team-agent-edit'), 'click');
    const textarea = findByClass(card, 'team-agent-desc-input');
    textarea.value = 'A new description whose mirror sync will fail.';
    await fire(findByClass(card, 'primary-btn'), 'click');

    // Then the drift warning is shown, naming both paths, and both writes were attempted.
    const err = findByClass(card, 'team-agent-desc-error');
    assert.equal(err.classList.contains('hidden'), false, 'drift warning visible');
    assert.match(err.textContent, /drift/i, 'the warning mentions drift');
    assert.ok(err.textContent.includes(primaryPath), 'warning names the primary path');
    assert.ok(err.textContent.includes(mirrorPath), 'warning names the mirror path');
    assert.equal(calls.writeFile.length, 2, 'primary + attempted mirror write');
    // The primary landed; the mirror is stale (drifted) on disk.
    assert.notEqual(fs.readFileSync(primaryPath, 'utf8'), REAL_BA, 'primary write landed');
    assert.equal(fs.readFileSync(mirrorPath, 'utf8'), REAL_BA, 'mirror unchanged (drifted)');
  } finally {
    cleanup(root);
  }
});

// ===========================================================================
// Scenario (edge): a Refresh re-reads the directory (later state reflected).
// ===========================================================================
test('Scenario (edge): refreshing re-reads the directory so newly added agents appear', async () => {
  const root = makeProject();
  try {
    seed(root, ['.claude', 'agents', 'ba.md'], REAL_BA);
    const { window, document, console } = makeWindow();
    const { refreshTeamAgents } = makeRenderer(window, document, console);
    const tab = makeTab(root);
    const body = tab.els.teamAgentsBody;

    await refreshTeamAgents(tab);
    assert.equal((body.children || []).filter((c) => c.classList && c.classList.contains('team-agent')).length, 1, 'one agent listed initially');

    // Add a second agent file, then refresh again → both re-read from disk.
    seed(root, ['.claude', 'agents', 'coder.md'], REAL_BA.replace('name: orchestrate-ba', 'name: orchestrate-coder'));
    await refreshTeamAgents(tab);
    const cards = (body.children || []).filter((c) => c.classList && c.classList.contains('team-agent'));
    assert.equal(cards.length, 2, 'the refresh re-read the directory and shows both agents');
  } finally {
    cleanup(root);
  }
});
