'use strict';

// ===========================================================================
// TASK-185 — e2e "cucumber" scenarios (Given/When/Then), implemented as plain
// `node --test` cases. NO `cucumber` npm package is installed or required.
//
// Feature: Workflow panel AI phase-prose regeneration
// Tests the REAL renderer code (renderer/renderer.js): buildWorkflowPhaseRegenerator,
// which mounts a regenerate control on each phase card. The control allows:
//   - Entering an instruction
//   - Calling window.api.skill.regeneratePhase (IPC stub)
//   - Validating the proposal via validateRegeneratedPhaseSection
//   - Previewing (never auto-written)
//   - Saving via writeWithMirror (mirror-only failure = drift warning)
//   - Canceling (discards without writing)
//   - Error handling for empty instruction, missing key, timeout, malformed response
//
// ALL filesystem access via STUBBED window.api.fs (operates on temp files only).
// window.api.skill.regeneratePhase is a MOCK returning controlled responses.
// NO real Electron / DB / network.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');
const SKILL_SRC = fs.readFileSync(
  path.join(REPO, '.claude', 'skills', 'orchestrate', 'SKILL.md'), 'utf8');

// The four bundled agent files, used READ-ONLY as fixtures.
const AGENT_FILES = ['ba.md', 'coder.md', 'tester.md', 'tech-lead.md'];
const AGENT_CONTENT = Object.fromEntries(AGENT_FILES.map((f) =>
  [f, fs.readFileSync(path.join(REPO, 'assets', 'agents', f), 'utf8')]));

// --- Extract helpers ---
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

// Load the REAL phase regenerator render path headless.
function loadPhaseRegenerator(window, document, console, localStorage) {
  const body = [
    // Constants
    extractConst(rendererSrc, 'WF_FALLBACK_AGENT'),
    extractConst(rendererSrc, 'WF_AGENT_TYPES'),
    extractConst(rendererSrc, 'WF_AGENT_NAMES'),
    extractConst(rendererSrc, 'WF_PHASE_SPECS'),
    extractConst(rendererSrc, 'WF_PHASE_KEYS'),
    extractConst(rendererSrc, 'AGENT_KEY_RE'),
    extractConst(rendererSrc, 'AGENT_BLOCK_RE'),
    extractConst(rendererSrc, 'AGENT_FENCE_RE'),
    extractConst(rendererSrc, 'ASSETS_MIRRORED_SUBTREES'),
    extractConst(rendererSrc, 'WF_MODEL_SUGGESTIONS'),
    // Path and mirror helpers
    extractFn(rendererSrc, 'inferSep'),
    extractFn(rendererSrc, 'appendPath'),
    extractFn(rendererSrc, 'tasksJoin'),
    extractFn(rendererSrc, 'tasksBasename'),
    extractFn(rendererSrc, 'relFromFolder'),
    extractFn(rendererSrc, 'mirrorRelPath'),
    extractFn(rendererSrc, 'writeWithMirror'),
    // WF helpers (phase section parsing and manipulation)
    extractFn(rendererSrc, 'wfSpecForKey'),
    extractFn(rendererSrc, 'wfDetectEol'),
    extractFn(rendererSrc, 'wfHeadingName'),
    extractFn(rendererSrc, 'wfPhaseNumberOf'),
    extractFn(rendererSrc, 'wfSectionsOf'),
    extractFn(rendererSrc, 'wfFindPhaseSection'),
    extractFn(rendererSrc, 'wfExtractPhaseBody'),
    extractFn(rendererSrc, 'stripOneCodeFence'),
    extractFn(rendererSrc, 'wfReplacePhaseBody'),
    extractFn(rendererSrc, 'validateRegeneratedPhaseSection'),
    // Agent file parsing (used by phase regenerator)
    extractFn(rendererSrc, 'resolveAgentBlockScalar'),
    extractFn(rendererSrc, 'parseAgentFileRenderer'),
    // The main regenerator builder
    extractFn(rendererSrc, 'buildWorkflowPhaseRegenerator'),
    // refreshTeamWorkflow stub (called on successful save)
    'function refreshTeamWorkflow(tab){ if(tab.refreshed) tab.refreshed(); }',
    'return { buildWorkflowPhaseRegenerator, wfExtractPhaseBody, wfReplacePhaseBody,',
    '  validateRegeneratedPhaseSection };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function('window', 'document', 'console', 'localStorage', body)(
    window, document, console, localStorage);
}

// ---------------------------------------------------------------------------
// Minimal in-memory mock DOM (task-105 style)
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
    placeholder: '', rows: 0,
    parentNode: null, isConnected: true,
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
async function fire(el, type, opts = {}) {
  const fns = (el._listeners && el._listeners[type]) || [];
  for (const fn of fns) await fn({ preventDefault() {}, stopPropagation() {}, ...opts });
}
// Drain the event loop so async handlers settle.
async function flush() {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
}

// ---------------------------------------------------------------------------
// Stubbed window.api with temp-dir file backing for assertions.
// ---------------------------------------------------------------------------
function makeWindow(opts) {
  const o = opts || {};
  const folder = o.folder || 'C:\\proj';
  const sep = '\\';
  const skillPath = [folder, '.claude', 'skills', 'orchestrate', 'SKILL.md'].join(sep);
  const assetPath = path.join(REPO, 'assets', 'skills', 'orchestrate', 'SKILL.md');
  // The mirror path writeWithMirror actually computes (renderer/renderer.js
  // mirrorRelPath + tasksJoin(tab.folder, ...)): folder-relative, NOT the real
  // repo's assets/ path (that's `assetPath` above, only used as a readFile
  // fixture). Both `skillPath` and `mirrorPath` share the same `sep`-joined
  // convention `tasksJoin`/`appendPath` use, so this is byte-identical to what
  // `writeWithMirror` builds for this project's `.claude/skills/orchestrate/`.
  const mirrorPath = [folder, 'assets', 'skills', 'orchestrate', 'SKILL.md'].join(sep);

  const state = {
    skillContent: o.skillContent || SKILL_SRC,
    // Map of real file path -> what to return on readFile/writeFile
    tempFiles: new Map(),
    regeneratePhaseResponse: o.regeneratePhaseResponse || null,
    writeFailure: o.writeFailure || null, // null | 'primary' | 'mirror'
  };

  const calls = {
    regeneratePhase: [],
    readFile: [],
    writeFile: [],
    writeWithMirror: [],
    exists: [],
  };

  const window = {
    api: {
      fs: {
        async readFile(p) {
          calls.readFile.push(p);
          // If temp file exists (from a previous write), return it
          if (state.tempFiles.has(p)) {
            return { ok: true, content: state.tempFiles.get(p) };
          }
          // For SKILL.md, return the state's skillContent
          if (p === skillPath) {
            return { ok: true, content: state.skillContent };
          }
          // For asset mirrored copy
          if (p === assetPath) {
            return { ok: true, content: state.skillContent };
          }
          return { ok: false, error: 'ENOENT: ' + p };
        },
        async writeFile(absPath, content) {
          calls.writeFile.push({ absPath, content });
          if (state.writeFailure === 'primary') {
            return { ok: false, error: 'Write failed' };
          }
          // Store in temp files map
          state.tempFiles.set(absPath, content);
          return { ok: true };
        },
        // writeWithMirror (renderer/renderer.js) only ever syncs a mirror that
        // ALREADY exists ("never create a mirror that does not already
        // exist"), so this must answer `true` for the mirror path — otherwise
        // writeWithMirror short-circuits before attempting the mirror write
        // at all and no scenario in this file can exercise mirror failure.
        async exists(p) {
          calls.exists.push(p);
          return { ok: true, exists: p === mirrorPath };
        },
      },
      skill: {
        async regeneratePhase(body, instruction) {
          calls.regeneratePhase.push({ body, instruction });
          if (state.regeneratePhaseResponse) {
            if (state.regeneratePhaseResponse instanceof Error) {
              throw state.regeneratePhaseResponse;
            }
            return state.regeneratePhaseResponse;
          }
          // Default mock: empty response
          return { ok: false, reason: 'error' };
        },
      },
    },
  };

  return { window, calls, state, document: makeDocument(), console: console, folder, skillPath, assetPath,
    mirrorPath };
}

function makeTab(folder) {
  return {
    folder,
    els: { teamWorkflowBody: makeEl('div') },
  };
}

function makePhase(key, number = 1) {
  return {
    key,
    number,
    title: `Phase ${number}`,
    agent: 'orchestrate-agent',
  };
}

// Find elements by class in the rendered tree
function findAll(root, cls, out) {
  out = out || [];
  for (const c of (root.children || [])) {
    if (c.classList && c.classList.contains(cls)) out.push(c);
    findAll(c, cls, out);
  }
  return out;
}

// ===========================================================================
// SCENARIO: Preview then save rewrites only that phase
// ===========================================================================
test('Scenario: preview then save rewrites only that phase', async () => {
  const { window, calls, state, document, console, folder, skillPath } = makeWindow();
  const { buildWorkflowPhaseRegenerator } = loadPhaseRegenerator(window, document, console, {});
  const tab = makeTab(folder);
  const phase = makePhase('review', 4);

  // When the regenerate button is clicked with a new proposal
  state.regeneratePhaseResponse = {
    ok: true,
    content: 'New review phase instructions.\nWith AI enhancements.',
  };

  const card = buildWorkflowPhaseRegenerator(tab, phase, SKILL_SRC, skillPath);
  const instrInput = findByClass(card, 'team-workflow-regen-input');
  const regenBtn = findByClass(card, 'team-workflow-regen-actions').children[0];

  instrInput.value = 'Make this phase clearer';
  await fire(regenBtn, 'click');
  await flush();

  // Then the proposal is shown as a preview
  const previewWrap = findByClass(card, 'team-workflow-regen-preview');
  assert.ok(!previewWrap.classList.contains('hidden'),
    'preview is shown');
  const previewBody = findByClass(previewWrap, 'team-workflow-regen-preview-body');
  assert.equal(previewBody.textContent,
    'New review phase instructions.\nWith AI enhancements.',
    'proposal is displayed');

  // When Save is clicked
  const saveBtn = findByClass(previewWrap, 'team-workflow-regen-actions').children[0];
  await fire(saveBtn, 'click');
  await flush();

  // Then SKILL.md is written with only the review phase changed
  assert.equal(calls.writeFile.length > 0, true, 'file is written');
  const written = calls.writeFile[calls.writeFile.length - 1];
  const newContent = written.content;

  // Verify review phase was updated
  assert.ok(newContent.includes('New review phase instructions'),
    'review phase is updated');

  // Verify the file has correct phase structure
  assert.ok(newContent.includes('## Phase 2'), 'phase 2 heading exists');
  assert.ok(newContent.includes('## Phase 3'), 'phase 3 heading exists');
});

// ===========================================================================
// SCENARIO: Proposal is preview-only until Save
// ===========================================================================
test('Scenario: proposal is preview-only until Save', async () => {
  const { window, calls, state, document, console, folder, skillPath } = makeWindow();
  const { buildWorkflowPhaseRegenerator } = loadPhaseRegenerator(window, document, console, {});
  const tab = makeTab(folder);
  const phase = makePhase('test', 3);

  state.regeneratePhaseResponse = {
    ok: true,
    content: 'New test phase instructions.',
  };

  const card = buildWorkflowPhaseRegenerator(tab, phase, SKILL_SRC, skillPath);
  const instrInput = findByClass(card, 'team-workflow-regen-input');
  const regenBtn = findByClass(card, 'team-workflow-regen-actions').children[0];

  instrInput.value = 'Enhance test instructions';
  await fire(regenBtn, 'click');
  await flush();

  // Before Save, SKILL.md should not be written
  assert.equal(calls.writeFile.length, 0, 'no write happens on preview');

  // SKILL.md on disk should still be the original
  const readResult = await window.api.fs.readFile(skillPath);
  assert.equal(readResult.content, SKILL_SRC, 'SKILL.md unchanged on disk');
});

// ===========================================================================
// SCENARIO: Cancel discards the proposal
// ===========================================================================
test('Scenario: cancel discards the proposal', async () => {
  const { window, calls, state, document, console, folder, skillPath } = makeWindow();
  const { buildWorkflowPhaseRegenerator } = loadPhaseRegenerator(window, document, console, {});
  const tab = makeTab(folder);
  const phase = makePhase('build', 2);

  state.regeneratePhaseResponse = {
    ok: true,
    content: 'New build phase text.',
  };

  const card = buildWorkflowPhaseRegenerator(tab, phase, SKILL_SRC, skillPath);
  const instrInput = findByClass(card, 'team-workflow-regen-input');
  const regenBtn = findByClass(card, 'team-workflow-regen-actions').children[0];

  instrInput.value = 'Update build phase';
  await fire(regenBtn, 'click');
  await flush();

  // Now click Cancel
  const previewWrap = findByClass(card, 'team-workflow-regen-preview');
  const cancelBtn = findByClass(previewWrap, 'team-workflow-regen-actions').children[1];
  await fire(cancelBtn, 'click');
  await flush();

  // Then preview should be hidden
  assert.ok(previewWrap.classList.contains('hidden'),
    'preview is hidden after cancel');

  // And nothing should be written
  assert.equal(calls.writeFile.length, 0, 'no write on cancel');
});

// ===========================================================================
// SCENARIO: Empty instruction makes no call (failure)
// ===========================================================================
test('Scenario: empty instruction makes no call (failure)', async () => {
  const { window, calls, state, document, console, folder, skillPath } = makeWindow();
  const { buildWorkflowPhaseRegenerator } = loadPhaseRegenerator(window, document, console, {});
  const tab = makeTab(folder);
  const phase = makePhase('plan', 1);

  const card = buildWorkflowPhaseRegenerator(tab, phase, SKILL_SRC, skillPath);
  const instrInput = findByClass(card, 'team-workflow-regen-input');
  const regenBtn = findByClass(card, 'team-workflow-regen-actions').children[0];

  // Leave instruction empty
  instrInput.value = '';
  await fire(regenBtn, 'click');
  await flush();

  // Then no API call should be made
  assert.equal(calls.regeneratePhase.length, 0, 'no API call is made');

  // And an inline message is shown
  const msg = findByClass(card, 'team-agent-ai-msg');
  assert.ok(!msg.classList.contains('hidden'), 'error message is shown');
  assert.ok(msg.textContent.includes('Enter an instruction'),
    'message prompts for instruction');
});

// ===========================================================================
// SCENARIO: Missing API key (failure)
// ===========================================================================
test('Scenario: missing API key (failure)', async () => {
  const { window, calls, state, document, console, folder, skillPath } = makeWindow();
  const { buildWorkflowPhaseRegenerator } = loadPhaseRegenerator(window, document, console, {});
  const tab = makeTab(folder);
  const phase = makePhase('build', 2);

  state.regeneratePhaseResponse = {
    ok: false,
    reason: 'no-key',
  };

  const card = buildWorkflowPhaseRegenerator(tab, phase, SKILL_SRC, skillPath);
  const instrInput = findByClass(card, 'team-workflow-regen-input');
  const regenBtn = findByClass(card, 'team-workflow-regen-actions').children[0];

  instrInput.value = 'Regenerate this phase';
  await fire(regenBtn, 'click');
  await flush();

  // Then a clear inline message is shown
  const msg = findByClass(card, 'team-agent-ai-msg');
  assert.ok(!msg.classList.contains('hidden'), 'error message is shown');
  assert.ok(msg.textContent.includes('ANTHROPIC_API_KEY'),
    'message mentions API key');

  // And nothing is written
  assert.equal(calls.writeFile.length, 0, 'no write on no-key error');
});

// ===========================================================================
// SCENARIO: Proposal touching other sections is rejected (failure/edge)
// ===========================================================================
test('Scenario: proposal touching other sections is rejected (failure/edge)', async () => {
  const { window, calls, state, document, console, folder, skillPath } = makeWindow();
  const { buildWorkflowPhaseRegenerator } = loadPhaseRegenerator(window, document, console, {});
  const tab = makeTab(folder);
  const phase = makePhase('review', 4);

  // Return a proposal that includes another phase heading
  state.regeneratePhaseResponse = {
    ok: true,
    content: 'Review instructions here.\n\n## Phase 1 (plan)\nShould not be here.',
  };

  const card = buildWorkflowPhaseRegenerator(tab, phase, SKILL_SRC, skillPath);
  const instrInput = findByClass(card, 'team-workflow-regen-input');
  const regenBtn = findByClass(card, 'team-workflow-regen-actions').children[0];

  instrInput.value = 'Update review';
  await fire(regenBtn, 'click');
  await flush();

  // Then the proposal is rejected with an inline error
  const msg = findByClass(card, 'team-agent-ai-msg');
  assert.ok(!msg.classList.contains('hidden'), 'error message is shown');
  assert.ok(msg.textContent.includes('invalid') || msg.textContent.includes('extra'),
    'message indicates the proposal is invalid');

  // Preview should not be shown
  const previewWrap = findByClass(card, 'team-workflow-regen-preview');
  assert.ok(previewWrap.classList.contains('hidden'),
    'preview is not shown for invalid proposal');

  // And nothing is written
  assert.equal(calls.writeFile.length, 0, 'no write on invalid proposal');
});

// ===========================================================================
// SCENARIO: Mirror-only write failure surfaces drift (failure/edge)
// ===========================================================================
test('Scenario: mirror-only write failure surfaces drift (failure/edge)', async () => {
  const { window, calls, state, document, console, folder, skillPath, mirrorPath } = makeWindow();
  const { buildWorkflowPhaseRegenerator } = loadPhaseRegenerator(window, document, console, {});
  const tab = makeTab(folder);
  const phase = makePhase('test', 3);

  // Mock: mirror write will fail
  state.regeneratePhaseResponse = {
    ok: true,
    content: 'New test instructions.',
  };

  // For writeWithMirror to surface a mirror-only failure, the PRIMARY write
  // (skillPath) must succeed and ONLY the mirror write (mirrorPath) must
  // fail. `exists()` on the shared stub already answers `true` for
  // `mirrorPath` (so writeWithMirror doesn't skip the mirror sync entirely);
  // here we make writeFile fail for that exact path and succeed otherwise.
  const originalWriteFile = window.api.fs.writeFile;
  let mirrorWriteAttempted = false;
  window.api.fs.writeFile = async (p, content) => {
    if (p === mirrorPath) {
      mirrorWriteAttempted = true;
      return { ok: false, error: 'Mirror unwritable' };
    }
    return originalWriteFile(p, content);
  };

  const card = buildWorkflowPhaseRegenerator(tab, phase, SKILL_SRC, skillPath);
  const instrInput = findByClass(card, 'team-workflow-regen-input');
  const regenBtn = findByClass(card, 'team-workflow-regen-actions').children[0];

  instrInput.value = 'Update test phase';
  await fire(regenBtn, 'click');
  await flush();

  // Now click Save
  const previewWrap = findByClass(card, 'team-workflow-regen-preview');
  const saveBtn = findByClass(previewWrap, 'team-workflow-regen-actions').children[0];
  await fire(saveBtn, 'click');
  await flush();

  // The mirror write really was attempted (and failed) — this scenario is
  // only meaningful if it exercised the intended code path.
  assert.ok(mirrorWriteAttempted, 'the mirror write was actually attempted');

  // Then a drift warning is shown, and it names BOTH the live path and the
  // mirror path (renderer.js's showSaveErr message in the Save handler).
  const saveErr = findByClass(previewWrap, 'team-agent-desc-error');
  assert.ok(!saveErr.classList.contains('hidden'), 'drift warning is shown');
  assert.ok(saveErr.textContent.includes(skillPath),
    'drift warning names the live .claude/... path');
  assert.ok(saveErr.textContent.includes(mirrorPath),
    'drift warning names the assets/... mirror path');

  // And the primary write DID succeed despite the mirror failure: the live
  // SKILL.md content reflects the new proposal.
  const reread = await window.api.fs.readFile(skillPath);
  assert.ok(reread.ok, 'primary SKILL.md is readable after save');
  assert.ok(reread.content.includes('New test instructions'),
    'primary write succeeded — live SKILL.md reflects the new proposal');
});

// ===========================================================================
// SCENARIO: Button disabled "Regenerating…" in flight
// ===========================================================================
test('Scenario: button disabled "Regenerating…" in flight', async () => {
  const { window, calls, state, document, console, folder, skillPath } = makeWindow();
  const { buildWorkflowPhaseRegenerator } = loadPhaseRegenerator(window, document, console, {});
  const tab = makeTab(folder);
  const phase = makePhase('build', 2);

  // Create a promise we can control
  let resolveRegenerate;
  const regeneratePromise = new Promise((resolve) => {
    resolveRegenerate = resolve;
  });

  state.regeneratePhaseResponse = null; // Will block
  window.api.skill.regeneratePhase = async () => {
    await regeneratePromise;
    return { ok: true, content: 'New build phase.' };
  };

  const card = buildWorkflowPhaseRegenerator(tab, phase, SKILL_SRC, skillPath);
  const instrInput = findByClass(card, 'team-workflow-regen-input');
  const regenBtn = findByClass(card, 'team-workflow-regen-actions').children[0];

  instrInput.value = 'Regenerate';
  const clickPromise = fire(regenBtn, 'click');

  // While the request is in flight, button should be disabled and label changed
  // (we can't directly check mid-promise, but after a tick we should see the change)
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(regenBtn.disabled, true, 'button is disabled during request');
  assert.equal(regenBtn.textContent, 'Regenerating…', 'button shows "Regenerating…"');

  // Resolve the promise
  resolveRegenerate();
  await clickPromise;
  await flush();

  // After response, button should be re-enabled
  assert.equal(regenBtn.disabled, false, 'button is re-enabled after response');
  assert.equal(regenBtn.textContent, 'Regenerate instructions with AI',
    'button label is restored');
});

// ===========================================================================
// SCENARIO: Stale-guard discards late regenerate responses (tab/folder switch)
// ===========================================================================
test('Scenario: stale-guard discards late regenerate response after tab switch', async () => {
  const { window, calls, state, document, console, folder, skillPath } = makeWindow();
  const { buildWorkflowPhaseRegenerator } = loadPhaseRegenerator(window, document, console, {});
  const tab = makeTab(folder);
  const phase = makePhase('review', 4);

  // A controllable, delayed regenerate response — simulates a slow AI call.
  let resolveRegenerate;
  const regeneratePromise = new Promise((resolve) => { resolveRegenerate = resolve; });
  window.api.skill.regeneratePhase = async () => {
    await regeneratePromise;
    return { ok: true, content: 'New review phase.' };
  };

  const card = buildWorkflowPhaseRegenerator(tab, phase, SKILL_SRC, skillPath);
  const instrInput = findByClass(card, 'team-workflow-regen-input');
  const regenBtn = findByClass(card, 'team-workflow-regen-actions').children[0];
  const previewWrap = findByClass(card, 'team-workflow-regen-preview');
  const msg = findByClass(card, 'team-agent-ai-msg');

  instrInput.value = 'Regenerate';
  const clickPromise = fire(regenBtn, 'click');

  // While the request is still in flight, the user switches tabs/folders:
  // renderer.js re-renders the workflow panel and replaces
  // tab.els.teamWorkflowBody with a brand-new node (this card's `wrap` is no
  // longer reachable from the live tab — exactly the stale-guard check at
  // renderer.js's regenerate-response handler: `tab.els.teamWorkflowBody !==
  // bodyAtRequest`).
  await new Promise((r) => setTimeout(r, 0));
  tab.els.teamWorkflowBody = makeEl('div');

  // Now the delayed response resolves, arriving AFTER the switch.
  resolveRegenerate();
  await clickPromise;
  await flush();

  // Then the stale response is discarded entirely: no preview, no message,
  // no write — and this (now-orphaned) card's button state is left as it was
  // when the guard fired (never re-enabled/relabeled for a stale card).
  assert.ok(previewWrap.classList.contains('hidden'),
    'no preview rendered into the stale card');
  assert.ok(msg.classList.contains('hidden'),
    'no error/success message in the stale card');
  assert.equal(calls.writeFile.length, 0, 'no write occurs for a stale response');
});

// ===========================================================================
// SCENARIO: Stale-guard discards late regenerate responses (card torn down)
// ===========================================================================
test('Scenario: stale-guard discards late regenerate response after card is torn down', async () => {
  const { window, calls, state, document, console, folder, skillPath } = makeWindow();
  const { buildWorkflowPhaseRegenerator } = loadPhaseRegenerator(window, document, console, {});
  const tab = makeTab(folder);
  const phase = makePhase('review', 4);

  let resolveRegenerate;
  const regeneratePromise = new Promise((resolve) => { resolveRegenerate = resolve; });
  window.api.skill.regeneratePhase = async () => {
    await regeneratePromise;
    return { ok: true, content: 'New review phase.' };
  };

  const card = buildWorkflowPhaseRegenerator(tab, phase, SKILL_SRC, skillPath);
  const instrInput = findByClass(card, 'team-workflow-regen-input');
  const regenBtn = findByClass(card, 'team-workflow-regen-actions').children[0];
  const previewWrap = findByClass(card, 'team-workflow-regen-preview');
  const msg = findByClass(card, 'team-agent-ai-msg');

  instrInput.value = 'Regenerate';
  const clickPromise = fire(regenBtn, 'click');

  // While in flight, this card is removed from the DOM by a re-render
  // (Refresh, another phase's Save, or navigating away) — `wrap.isConnected`
  // goes false, matching the second half of the stale-guard check.
  await new Promise((r) => setTimeout(r, 0));
  card.isConnected = false;

  resolveRegenerate();
  await clickPromise;
  await flush();

  assert.ok(previewWrap.classList.contains('hidden'),
    'no preview rendered into the torn-down card');
  assert.ok(msg.classList.contains('hidden'),
    'no error/success message in the torn-down card');
  assert.equal(calls.writeFile.length, 0, 'no write occurs for a stale response');
});

// ===========================================================================
// SCENARIO: Save-side stale-guard skips refreshTeamWorkflow after switch
// ===========================================================================
test('Scenario: Save stale-guard skips refreshTeamWorkflow after tab switch mid-save', async () => {
  const { window, calls, state, document, console, folder, skillPath } = makeWindow();
  const { buildWorkflowPhaseRegenerator } = loadPhaseRegenerator(window, document, console, {});
  const tab = makeTab(folder);
  const phase = makePhase('review', 4);

  state.regeneratePhaseResponse = {
    ok: true,
    content: 'New review phase.',
  };

  const card = buildWorkflowPhaseRegenerator(tab, phase, SKILL_SRC, skillPath);
  const instrInput = findByClass(card, 'team-workflow-regen-input');
  const regenBtn = findByClass(card, 'team-workflow-regen-actions').children[0];

  // Get to a normal, non-stale preview first.
  instrInput.value = 'Regenerate';
  await fire(regenBtn, 'click');
  await flush();

  const previewWrap = findByClass(card, 'team-workflow-regen-preview');
  const saveBtn = findByClass(previewWrap, 'team-workflow-regen-actions').children[0];
  assert.ok(!previewWrap.classList.contains('hidden'), 'preview is shown before Save');

  // Delay the fresh re-read of SKILL.md the Save handler performs, so we can
  // invalidate staleness while the async write is still pending.
  let resolveRead;
  const readGate = new Promise((resolve) => { resolveRead = resolve; });
  const originalReadFile = window.api.fs.readFile;
  window.api.fs.readFile = async (p) => {
    await readGate;
    return originalReadFile(p);
  };

  let refreshedCalled = false;
  tab.refreshed = () => { refreshedCalled = true; };

  const savePromise = fire(saveBtn, 'click');

  // While the write is in flight, the user switches tabs/folders — the
  // Save-side stale-guard check is `tab.els.teamWorkflowBody === bodyAtRequest`.
  await new Promise((r) => setTimeout(r, 0));
  tab.els.teamWorkflowBody = makeEl('div');

  resolveRead();
  await savePromise;
  await flush();

  // The write itself still completes (Save is not aborted mid-flight)...
  assert.equal(calls.writeFile.length > 0, true, 'the write still completes');
  // ...but refreshTeamWorkflow must NOT run against the now-switched panel.
  assert.equal(refreshedCalled, false,
    'refreshTeamWorkflow is not called for a stale/switched panel');
});

// ===========================================================================
// SCENARIO: Successful Save re-reads via refreshTeamWorkflow
// ===========================================================================
// A REAL end-to-end drive of the happy path (TASK-193): regenerate -> valid
// preview -> click Save -> BOTH the primary `.claude/...` write and the
// mirror `assets/...` write succeed (the shared stub's default fs.writeFile
// has no failure injected) -> refreshTeamWorkflow (tab.refreshed()) actually
// runs. Distinct from TASK-191's mirror-FAILURE scenario above: here nothing
// fails, so this is the only place the fully-successful primary+mirror+
// refresh path is exercised.
test('Scenario: successful Save re-reads via refreshTeamWorkflow', async () => {
  const { window, calls, state, document, console, folder, skillPath, mirrorPath } = makeWindow();
  const { buildWorkflowPhaseRegenerator, wfReplacePhaseBody } =
    loadPhaseRegenerator(window, document, console, {});
  const tab = makeTab(folder);
  const phase = makePhase('plan', 1);

  const newBody = 'New plan phase instructions.\nFully regenerated end-to-end.';
  state.regeneratePhaseResponse = { ok: true, content: newBody };

  const card = buildWorkflowPhaseRegenerator(tab, phase, SKILL_SRC, skillPath);
  const instrInput = findByClass(card, 'team-workflow-regen-input');
  const regenBtn = findByClass(card, 'team-workflow-regen-actions').children[0];

  instrInput.value = 'Update plan';
  await fire(regenBtn, 'click');
  await flush();

  const previewWrap = findByClass(card, 'team-workflow-regen-preview');
  assert.ok(!previewWrap.classList.contains('hidden'), 'preview is shown before Save');

  let refreshedCalled = false;
  tab.refreshed = () => { refreshedCalled = true; };

  // When Save is clicked
  const saveBtn = findByClass(previewWrap, 'team-workflow-regen-actions').children[0];
  await fire(saveBtn, 'click');
  await flush();

  // Then BOTH the primary and mirror writes succeeded.
  assert.equal(calls.writeFile.length, 2, 'both primary and mirror writes happened');
  const primaryWrite = calls.writeFile.find((w) => w.absPath === skillPath);
  const mirrorWrite = calls.writeFile.find((w) => w.absPath === mirrorPath);
  assert.ok(primaryWrite, 'the primary .claude/... write happened');
  assert.ok(mirrorWrite, 'the mirror assets/... write happened');
  assert.equal(mirrorWrite.content, primaryWrite.content,
    'mirror content is byte-identical to the primary write');

  // No drift warning — a fully successful save shows no save error.
  const saveErr = findByClass(previewWrap, 'team-agent-desc-error');
  assert.ok(saveErr.classList.contains('hidden'), 'no drift warning on a full success');

  // And refreshTeamWorkflow actually ran (the harness's tab.refreshed marker).
  assert.ok(refreshedCalled, 'refreshTeamWorkflow ran after the successful save');

  // The live SKILL.md content reflects the new phase-section body, and every
  // other section is byte-identical to before the save (computed the same
  // way the real Save handler does: splice only this phase's body).
  const expected = wfReplacePhaseBody(SKILL_SRC, phase.key, newBody);
  assert.ok(expected.ok, 'sanity: the expected splice computes cleanly');
  const reread = await window.api.fs.readFile(skillPath);
  assert.ok(reread.ok, 'primary SKILL.md is readable after save');
  // EOL-tolerant: SKILL.md's own detected line ending (CRLF on this checkout,
  // possibly LF elsewhere) is applied to every line by wfReplacePhaseBody, so
  // compare after normalising both sides to '\n'.
  assert.ok(reread.content.replace(/\r\n/g, '\n').includes(newBody.replace(/\r\n/g, '\n')),
    'live SKILL.md reflects the new phase-section body');
  assert.equal(reread.content, expected.content,
    'live SKILL.md is byte-identical to the original except this one phase\'s section');
});

// ===========================================================================
// SCENARIO: Timeout/network/malformed responses (failure)
// ===========================================================================
test('Scenario: network error shows inline message', async () => {
  const { window, calls, state, document, console, folder, skillPath } = makeWindow();
  const { buildWorkflowPhaseRegenerator } = loadPhaseRegenerator(window, document, console, {});
  const tab = makeTab(folder);
  const phase = makePhase('build', 2);

  // Simulate network error by throwing
  window.api.skill.regeneratePhase = async () => {
    throw new Error('Network timeout');
  };

  const card = buildWorkflowPhaseRegenerator(tab, phase, SKILL_SRC, skillPath);
  const instrInput = findByClass(card, 'team-workflow-regen-input');
  const regenBtn = findByClass(card, 'team-workflow-regen-actions').children[0];

  instrInput.value = 'Regenerate';
  await fire(regenBtn, 'click');
  await flush();

  // Then an error message is shown
  const msg = findByClass(card, 'team-agent-ai-msg');
  assert.ok(!msg.classList.contains('hidden'), 'error message is shown');
  assert.ok(msg.textContent.includes('failed'), 'error indicates failure');

  // And nothing is written
  assert.equal(calls.writeFile.length, 0, 'no write on network error');
});

test('Scenario: malformed response (empty) shows inline message', async () => {
  const { window, calls, state, document, console, folder, skillPath } = makeWindow();
  const { buildWorkflowPhaseRegenerator } = loadPhaseRegenerator(window, document, console, {});
  const tab = makeTab(folder);
  const phase = makePhase('test', 3);

  state.regeneratePhaseResponse = {
    ok: true,
    content: '',  // Empty response
  };

  const card = buildWorkflowPhaseRegenerator(tab, phase, SKILL_SRC, skillPath);
  const instrInput = findByClass(card, 'team-workflow-regen-input');
  const regenBtn = findByClass(card, 'team-workflow-regen-actions').children[0];

  instrInput.value = 'Regenerate';
  await fire(regenBtn, 'click');
  await flush();

  // Empty proposals are rejected by validateRegeneratedPhaseSection
  const msg = findByClass(card, 'team-agent-ai-msg');
  assert.ok(!msg.classList.contains('hidden'), 'error message is shown');

  const previewWrap = findByClass(card, 'team-workflow-regen-preview');
  assert.ok(previewWrap.classList.contains('hidden'),
    'preview is not shown for empty response');
});
