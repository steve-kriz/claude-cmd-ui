'use strict';

// ===========================================================================
// TASK-134 — e2e "cucumber" scenarios (Given/When/Then), implemented as plain
// `node --test` cases. NO cucumber npm package is installed or required.
//
// Feature: the Tasks-banner install-error message is rendered as TEXT, never
// HTML. installOrchestrateSkill's !res.ok branch (renderer/renderer.js ~:9769)
// must clear the static .install-banner-text element (textContent = '') and
// append a <strong> ("Install failed.", set via textContent) plus a text node
// carrying ' ' + ((res && res.error) || 'unknown error') — mirroring
// buildWorkflowInstallHint / buildAgentsInstallHint. An error string containing
// HTML-like markup must render LITERALLY and parse into NO element nodes, and
// the element's innerHTML setter must never be invoked.
//
// The subject under test is the REAL renderer code (renderer/renderer.js) —
// installOrchestrateSkill (plus the promptSkillRegistration helper it calls on
// success) are EXTRACTED headless by brace-matching the source and driven with
// an INJECTED window + a minimal in-memory mock document.
//
// ALL side-effecting collaborators are STUBBED: window.api.tasks.installSkill
// (the install IPC), and launchCmdAgent / refreshTeamAgents / pollTasksOnce are
// injected recording stubs. NO real DB / Electron / network / PTY spawn ever
// happens.
//
// TASK-203 note: buildWorkflowInstallHint (mirrored by this scenario's header
// comment) was removed along with the Workflow panel; this file never extracted
// it directly, so no functional change was needed here beyond dropping the
// now-unused refreshTeamWorkflow/teamWorkflowBody stubs below.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');

// --- Extract a named function declaration by brace-matching (task-131 style). --
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

// Load the REAL install surface + shared registration helper headless.
function loadSurfaces(window, document, console, deps) {
  const body = [
    'const launchCmdAgent = deps.launchCmdAgent;',
    'const refreshTeamAgents = deps.refreshTeamAgents;',
    'const pollTasksOnce = deps.pollTasksOnce;',
    extractFn(rendererSrc, 'promptSkillRegistration'),
    extractFn(rendererSrc, 'installOrchestrateSkill'),
    'return { promptSkillRegistration, installOrchestrateSkill };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function('window', 'document', 'console', 'deps', body)(window, document, console, deps);
}

// ---------------------------------------------------------------------------
// Minimal in-memory mock DOM. The element models textContent (clearing
// children on set), appendChild, and an innerHTML setter that is SPIED: any
// write bumps `_innerHTMLWrites` so a test can prove the setter was never used.
// createTextNode produces a text node (no tagName), createElement produces an
// element (tagName set) — so a test can distinguish parsed element nodes from
// literal text.
// ---------------------------------------------------------------------------
function findByClass(root, cls) {
  for (const c of (root.children || [])) {
    if (c.classList && c.classList.contains(cls)) return c;
    const deep = findByClass(c, cls);
    if (deep) return deep;
  }
  return null;
}
function findAll(root, cls, out) {
  out = out || [];
  for (const c of (root.children || [])) {
    if (c.classList && c.classList.contains(cls)) out.push(c);
    findAll(c, cls, out);
  }
  return out;
}
// Element children only (text nodes have no tagName).
function elementChildren(el) {
  return (el.children || []).filter((c) => c.tagName);
}
function makeEl(tag) {
  const classes = new Set();
  const children = [];
  let text = '';
  let html = '';
  const el = {
    tagName: String(tag || '').toUpperCase(),
    dataset: {}, style: {}, children,
    _listeners: {},
    _innerHTMLWrites: 0,
    disabled: false, value: '', title: '', type: '', id: '',
    parentNode: null, attrs: {},
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    classList: {
      add(...cs) { cs.forEach((c) => classes.add(c)); },
      remove(...cs) { cs.forEach((c) => classes.delete(c)); },
      toggle(c, on) { const w = on === undefined ? !classes.has(c) : !!on; if (w) classes.add(c); else classes.delete(c); return w; },
      contains(c) { return classes.has(c); },
    },
    appendChild(c) { children.push(c); c.parentNode = el; return c; },
    insertBefore(nw, ref) {
      const i = children.indexOf(ref);
      if (i < 0) children.push(nw); else children.splice(i, 0, nw);
      nw.parentNode = el;
      return nw;
    },
    remove() {
      const p = el.parentNode;
      if (p && p.children) {
        const i = p.children.indexOf(el);
        if (i >= 0) p.children.splice(i, 1);
      }
      el.parentNode = null;
    },
    addEventListener(t, fn) { (el._listeners[t] = el._listeners[t] || []).push(fn); },
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
  // SPY: any innerHTML write is recorded so a scenario can assert it never ran.
  Object.defineProperty(el, 'innerHTML', {
    get() { return html; },
    set(v) { el._innerHTMLWrites += 1; html = String(v); text = ''; children.length = 0; },
  });
  return el;
}
function makeDocument() {
  return {
    createElement: (tag) => makeEl(tag),
    createTextNode: (t) => {
      let v = String(t);
      // A text node: NO tagName (so elementChildren() ignores it).
      return { _isText: true, parentNode: null, get textContent() { return v; }, set textContent(x) { v = String(x); } };
    },
  };
}
async function flush() {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
}

// ---------------------------------------------------------------------------
// Harness: stubbed window.api.tasks.installSkill + injected deps.
// ---------------------------------------------------------------------------
function makeHarness(opts) {
  const o = opts || {};
  const calls = {
    installSkill: [], launchCmdAgent: [],
    refreshTeamAgents: [], pollTasksOnce: [],
  };
  const document = makeDocument();
  const console = { error() { calls.consoleError = (calls.consoleError || 0) + 1; }, warn() {}, log() {} };
  const window = {
    api: {
      tasks: {
        async installSkill(projectPath) {
          calls.installSkill.push(projectPath);
          if (o.installOk === false) {
            const res = { ok: false };
            if ('installError' in o) res.error = o.installError; // may be undefined/absent
            return res;
          }
          return { ok: true };
        },
      },
    },
  };
  let seq = 0;
  const deps = {
    async launchCmdAgent(tab) {
      calls.launchCmdAgent.push(tab);
      if (tab.cmd) tab.cmd.id = 'new-session-' + (++seq);
    },
    async refreshTeamAgents(tab) { calls.refreshTeamAgents.push(tab); },
    pollTasksOnce(tab, flag) { calls.pollTasksOnce.push({ tab, flag }); },
  };
  return { window, document, console, deps, calls };
}

// A claude tab whose .install-banner-text is a STATIC element pre-seeded with
// index.html's default content (<strong>Orchestration skill not installed.</strong>
// + description text) so the "clear before append" behavior is exercised.
function makeClaudeTab(document, opts) {
  const o = opts || {};
  const tasksView = document.createElement('div');
  const tasksSkillBanner = document.createElement('div');
  tasksSkillBanner.className = 'tasksSkillBanner install-banner';
  const tasksBoard = document.createElement('div');
  tasksBoard.className = 'tasksBoard';
  tasksView.appendChild(tasksSkillBanner);
  tasksView.appendChild(tasksBoard);

  let bannerText = null;
  if (!o.noBannerText) {
    bannerText = document.createElement('div');
    bannerText.className = 'install-banner-text';
    // Static pre-existing children from index.html.
    const staticStrong = document.createElement('strong');
    staticStrong.textContent = 'Orchestration skill not installed.';
    bannerText.appendChild(staticStrong);
    bannerText.appendChild(document.createTextNode(' Install it to enable the board.'));
    tasksSkillBanner.appendChild(bannerText);
  }

  return {
    _bannerText: bannerText,
    folder: o.folder || 'C:\\proj',
    agent: 'claude',
    cmd: { id: 'session-1', term: null },
    status: 'finished',
    tasks: { skillInstalled: false },
    els: {
      tasksSkillBanner,
      tasksInstallSkillBtn: (() => { const b = document.createElement('button'); b.textContent = 'Install orchestration skill'; return b; })(),
      tasksBuildBtn: (() => { const b = document.createElement('button'); b.disabled = true; return b; })(),
      teamAgentsBody: document.createElement('div'),
      _tasksView: tasksView,
      _tasksBoard: tasksBoard,
    },
  };
}

function notice(surfaceEl) { return findByClass(surfaceEl, 'skill-restart-notice'); }

// ===========================================================================
// Scenario: Failed install shows the plain-text failure message
// ===========================================================================
test('Scenario: a failed install shows "Install failed. <error>" built via textContent + a <strong> child (never innerHTML), and re-enables the button', async () => {
  // Given the tasks:installSkill IPC responds ok=false with error "disk full".
  const { window, document, console, deps, calls } = makeHarness({ installOk: false, installError: 'disk full' });
  const { installOrchestrateSkill } = loadSurfaces(window, document, console, deps);
  const tab = makeClaudeTab(document);
  const prevLabel = tab.els.tasksInstallSkillBtn.textContent;
  const textEl = tab._bannerText;

  // When the user clicks Install and the call completes.
  await installOrchestrateSkill(tab);
  await flush();

  // Then the install IPC ran for the open folder.
  assert.deepEqual(calls.installSkill, ['C:\\proj'], 'install IPC ran for the open folder');

  // And the banner text reads exactly "Install failed. disk full".
  assert.equal(textEl.textContent, 'Install failed. disk full', 'banner text is the plain-text failure message with a single space');

  // And the "Install failed." prefix is a <strong> element set via textContent.
  const strongs = elementChildren(textEl).filter((c) => c.tagName === 'STRONG');
  assert.equal(strongs.length, 1, 'exactly one <strong> prefix element');
  assert.equal(strongs[0].textContent, 'Install failed.', 'the <strong> carries "Install failed." via textContent');

  // And the error is appended as a text node, not via innerHTML.
  assert.equal(textEl._innerHTMLWrites, 0, 'innerHTML setter was never invoked on .install-banner-text');
  const textNodes = (textEl.children || []).filter((c) => c._isText);
  assert.equal(textNodes.length, 1, 'the error is a single appended text node');
  assert.equal(textNodes[0].textContent, ' disk full', 'the text node carries the leading space + error');

  // And the static default content was cleared (only strong + error text remain).
  assert.equal(elementChildren(textEl).length, 1, 'only the failure <strong> element remains; the static prompt was cleared');

  // And the Install button is re-enabled with its original label.
  assert.equal(tab.els.tasksInstallSkillBtn.disabled, false, 'the Install button is re-enabled');
  assert.equal(tab.els.tasksInstallSkillBtn.textContent, prevLabel, 'the Install button label is restored');

  // And success side effects did NOT run.
  assert.equal(tab.tasks.skillInstalled, false, 'skillInstalled is not flipped on failure');
  assert.equal(notice(tab.els._tasksView), null, 'no restart notice on failure');
  assert.ok(!tab.els.tasksSkillBanner.classList.contains('hidden'), 'the banner stays visible');
});

// ===========================================================================
// Scenario: Missing error falls back to "unknown error"
// ===========================================================================
test('Scenario: a failed install with no error field falls back to "Install failed. unknown error"', async () => {
  // Given tasks:installSkill responds ok=false with NO error field.
  const { window, document, console, deps } = makeHarness({ installOk: false }); // no installError key
  const { installOrchestrateSkill } = loadSurfaces(window, document, console, deps);
  const tab = makeClaudeTab(document);

  // When the user clicks Install and the call completes.
  await installOrchestrateSkill(tab);
  await flush();

  // Then the banner text reads "Install failed. unknown error".
  assert.equal(tab._bannerText.textContent, 'Install failed. unknown error', 'falsy res.error falls back to "unknown error"');
  assert.equal(tab._bannerText._innerHTMLWrites, 0, 'innerHTML never used for the fallback message');
});

// ===========================================================================
// Scenario: Edge/failure — error containing markup is rendered literally
// ===========================================================================
test('Scenario (edge/failure): an error string containing markup renders LITERALLY in textContent and parses into NO element nodes (innerHTML never set)', async () => {
  // Given the IPC error contains HTML-like markup (e.g. a folder path with an <img> payload).
  const MARKUP = 'C:\\proj\\<img src=x onerror=alert(1)>';
  const { window, document, console, deps } = makeHarness({ installOk: false, installError: MARKUP });
  const { installOrchestrateSkill } = loadSurfaces(window, document, console, deps);
  const tab = makeClaudeTab(document);
  const textEl = tab._bannerText;

  // When the user clicks Install and the call completes.
  await installOrchestrateSkill(tab);
  await flush();

  // Then the banner's textContent contains the literal markup string.
  assert.ok(textEl.textContent.includes('<img src=x onerror=alert(1)>'), 'the markup appears literally in textContent');
  assert.equal(textEl.textContent, 'Install failed. ' + MARKUP, 'the full message is prefix + literal error');

  // And no <img> element (or ANY element parsed from the error) exists inside .install-banner-text.
  const els = elementChildren(textEl);
  assert.equal(els.length, 1, 'only the deliberate <strong> element exists; the markup created no elements');
  assert.equal(els[0].tagName, 'STRONG', 'the sole element child is the intended <strong>');
  assert.ok(!els.some((c) => c.tagName === 'IMG'), 'no <img> element was parsed from the error string');

  // And the element's innerHTML setter was never invoked (the spy proves it).
  assert.equal(textEl._innerHTMLWrites, 0, 'innerHTML setter was never invoked — markup could not be parsed as HTML');
});

// ===========================================================================
// Scenario: Edge — repeated failures do not stack duplicate messages
// ===========================================================================
test('Scenario (edge): repeated failed installs do not stack duplicate messages — exactly one <strong> child and one "Install failed."', async () => {
  // Given tasks:installSkill keeps responding ok=false with error "boom".
  const { window, document, console, deps } = makeHarness({ installOk: false, installError: 'boom' });
  const { installOrchestrateSkill } = loadSurfaces(window, document, console, deps);
  const tab = makeClaudeTab(document);
  const textEl = tab._bannerText;

  // When the user clicks Install twice, letting each call complete.
  await installOrchestrateSkill(tab);
  await flush();
  await installOrchestrateSkill(tab);
  await flush();

  // Then the banner text reads "Install failed. boom" exactly once.
  assert.equal(textEl.textContent, 'Install failed. boom', 'the message is not duplicated after a second failure');

  // And there is exactly one <strong> child inside .install-banner-text.
  const strongs = elementChildren(textEl).filter((c) => c.tagName === 'STRONG');
  assert.equal(strongs.length, 1, 'exactly one <strong> child after repeated failures (no stacking)');
  assert.equal(elementChildren(textEl).length, 1, 'no accumulated element children');
});

// ===========================================================================
// Scenario: Edge — banner text element missing is a no-op
// ===========================================================================
test('Scenario (edge): a missing .install-banner-text descendant is a safe no-op that still re-enables the button', async () => {
  // Given the tasksSkillBanner contains NO .install-banner-text descendant.
  const { window, document, console, deps } = makeHarness({ installOk: false, installError: 'nope' });
  const { installOrchestrateSkill } = loadSurfaces(window, document, console, deps);
  const tab = makeClaudeTab(document, { noBannerText: true });
  const prevLabel = tab.els.tasksInstallSkillBtn.textContent;
  assert.equal(tab.els.tasksSkillBanner.querySelector('.install-banner-text'), null, 'precondition: no text element');

  // When the user clicks Install and the call completes — no throw.
  await assert.doesNotReject(() => installOrchestrateSkill(tab), 'missing text element does not throw');
  await flush();

  // Then the button is re-enabled with its original label (the restore path still runs).
  assert.equal(tab.els.tasksInstallSkillBtn.disabled, false, 'the Install button is re-enabled');
  assert.equal(tab.els.tasksInstallSkillBtn.textContent, prevLabel, 'the Install button label is restored');
  assert.equal(tab.tasks.skillInstalled, false, 'no state flip on failure');
});

// ===========================================================================
// Scenario: Successful install path is unchanged
// ===========================================================================
test('Scenario: the successful-install path is unchanged — banner hidden, banner text untouched, and promptSkillRegistration still runs', async () => {
  // Given tasks:installSkill responds ok=true.
  const { window, document, console, deps, calls } = makeHarness(); // installOk defaults to true
  const { installOrchestrateSkill } = loadSurfaces(window, document, console, deps);
  const tab = makeClaudeTab(document);
  const textEl = tab._bannerText;
  const originalText = textEl.textContent;

  // When the user clicks Install and the call completes.
  await installOrchestrateSkill(tab);
  await flush();

  // Then the banner gains the "hidden" class and its text is NOT modified.
  assert.ok(tab.els.tasksSkillBanner.classList.contains('hidden'), 'the banner is hidden on success');
  assert.equal(textEl.textContent, originalText, 'the banner text element is not modified on success');
  assert.equal(textEl._innerHTMLWrites, 0, 'innerHTML never touched on success');

  // And the success side effects ran.
  assert.equal(tab.tasks.skillInstalled, true, 'skillInstalled flips true');
  assert.equal(tab.els.tasksBuildBtn.disabled, false, 'the Build button is enabled');
  assert.equal(calls.pollTasksOnce.length, 1, 'pollTasksOnce ran once');

  // And the restart-registration flow (promptSkillRegistration) still runs.
  const n = notice(tab.els._tasksView);
  assert.ok(n, 'promptSkillRegistration placed the restart notice');
  assert.ok(findByClass(n, 'skillRestartBtn'), 'the restart notice carries the Restart button');
  assert.equal(calls.launchCmdAgent.length, 0, 'no auto-relaunch on install');
});
