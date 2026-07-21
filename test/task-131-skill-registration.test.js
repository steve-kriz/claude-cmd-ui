'use strict';

// ===========================================================================
// TASK-131 — UNIT tests for the shared post-install registration helper
// promptSkillRegistration(tab, surfaceEl) in renderer/renderer.js.
//
// The helper is EXTRACTED headless by brace-matching the source and evaluated
// with an INJECTED window/document/console and a STUBBED launchCmdAgent (the PTY
// kill-and-respawn / session relaunch). These are focused unit tests over the
// helper's decision logic and construction — no real DB / Electron / network /
// PTY spawn / session relaunch. launchCmdAgent is asserted to fire ONLY on the
// Restart button click.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
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

function loadHelper(window, document, console, launchCmdAgent) {
  const body = [
    'const launchCmdAgent = _launch;',
    extractFn(rendererSrc, 'promptSkillRegistration'),
    'return { promptSkillRegistration };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function('window', 'document', 'console', '_launch', body)(window, document, console, launchCmdAgent);
}

// --- Minimal mock DOM (querySelector('.class') + remove + insertBefore) -----
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
function makeEl(tag) {
  const classes = new Set();
  const children = [];
  let text = '';
  const el = {
    tagName: String(tag || '').toUpperCase(),
    dataset: {}, style: {}, children, _listeners: {},
    disabled: false, value: '', title: '', type: '', id: '', parentNode: null,
    classList: {
      add(...cs) { cs.forEach((c) => classes.add(c)); },
      remove(...cs) { cs.forEach((c) => classes.delete(c)); },
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
      if (p && p.children) { const i = p.children.indexOf(el); if (i >= 0) p.children.splice(i, 1); }
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
  return el;
}
function makeDocument() {
  return {
    createElement: (tag) => makeEl(tag),
    createTextNode: (t) => {
      let v = String(t);
      return { _isText: true, get textContent() { return v; }, set textContent(x) { v = String(x); } };
    },
  };
}
async function fire(el, type) {
  const fns = (el._listeners && el._listeners[type]) || [];
  for (const fn of fns) await fn({});
}
async function flush() { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)); }

function makeCtx(opts) {
  const o = opts || {};
  const calls = { launchCmdAgent: [], consoleError: 0 };
  const document = makeDocument();
  const console = { error() { calls.consoleError += 1; }, warn() {}, log() {} };
  const launchCmdAgent = async (tab) => {
    calls.launchCmdAgent.push(tab);
    if (o.relaunchThrows) throw new Error('spawn boom');
    if (tab.cmd) tab.cmd.id = 'new-session';
  };
  const { promptSkillRegistration } = loadHelper({}, document, console, launchCmdAgent);
  return { promptSkillRegistration, document, calls };
}

function claudeTab() {
  return { agent: 'claude', cmd: { id: 'sess-1' }, tasks: { skillInstalled: true } };
}

// ---------------------------------------------------------------------------
// No-op decision logic.
// ---------------------------------------------------------------------------
test('unit: no-op when tab.agent === opencode', () => {
  const { promptSkillRegistration, document, calls } = makeCtx();
  const surface = document.createElement('div');
  promptSkillRegistration({ agent: 'opencode', cmd: { id: 'x' } }, surface);
  assert.equal(findByClass(surface, 'skill-restart-notice'), null, 'no notice for opencode');
  assert.equal(calls.launchCmdAgent.length, 0, 'no relaunch');
});

test('unit: no-op when no cmd object', () => {
  const { promptSkillRegistration, document } = makeCtx();
  const surface = document.createElement('div');
  promptSkillRegistration({ agent: 'claude', cmd: null }, surface);
  assert.equal(findByClass(surface, 'skill-restart-notice'), null, 'no notice when cmd is null');
});

test('unit: no-op when cmd.id is falsy (dead PTY)', () => {
  const { promptSkillRegistration, document } = makeCtx();
  const surface = document.createElement('div');
  promptSkillRegistration({ agent: 'claude', cmd: { id: null } }, surface);
  assert.equal(findByClass(surface, 'skill-restart-notice'), null, 'no notice when cmd.id is null');
});

test('unit: no-op (no throw) when tab or surfaceEl is missing', () => {
  const { promptSkillRegistration, document } = makeCtx();
  assert.doesNotThrow(() => promptSkillRegistration(null, document.createElement('div')), 'null tab no-op');
  assert.doesNotThrow(() => promptSkillRegistration(claudeTab(), null), 'null surface no-op');
});

// ---------------------------------------------------------------------------
// Notice construction.
// ---------------------------------------------------------------------------
test('unit: on a claude tab with a live PTY it builds the notice + Restart button with the expected text', () => {
  const { promptSkillRegistration, document } = makeCtx();
  const surface = document.createElement('div');
  promptSkillRegistration(claudeTab(), surface);

  const notice = findByClass(surface, 'skill-restart-notice');
  assert.ok(notice, 'a notice is created');
  assert.ok(notice.classList.contains('install-banner'), 'reuses the install-banner styling');
  assert.match(notice.textContent, /Restart the Claude session to register the skill/, 'notice copy present');
  assert.match(notice.textContent, /Restarting ends the current session/, 'warns restarting ends the session');

  const btn = findByClass(notice, 'skillRestartBtn');
  assert.ok(btn, 'a Restart button is present');
  assert.equal(btn.textContent, 'Restart', 'button label is Restart');
});

test('unit: with no .tasksBoard the notice is appended to the surface', () => {
  const { promptSkillRegistration, document } = makeCtx();
  const surface = document.createElement('div');
  const filler = document.createElement('p');
  surface.appendChild(filler);
  promptSkillRegistration(claudeTab(), surface);
  const notice = findByClass(surface, 'skill-restart-notice');
  assert.equal(surface.children[surface.children.length - 1], notice, 'notice appended at the end when no board');
});

test('unit: with a .tasksBoard child the notice is inserted ABOVE the board', () => {
  const { promptSkillRegistration, document } = makeCtx();
  const surface = document.createElement('div');
  const board = document.createElement('div');
  board.className = 'tasksBoard';
  surface.appendChild(board);
  promptSkillRegistration(claudeTab(), surface);
  const notice = findByClass(surface, 'skill-restart-notice');
  assert.ok(surface.children.indexOf(notice) < surface.children.indexOf(board), 'notice inserted before the board');
});

// ---------------------------------------------------------------------------
// Restart button behavior.
// ---------------------------------------------------------------------------
test('unit: launchCmdAgent is NOT called on construction — only when Restart is clicked', async () => {
  const { promptSkillRegistration, document, calls } = makeCtx();
  const surface = document.createElement('div');
  const tab = claudeTab();
  promptSkillRegistration(tab, surface);
  assert.equal(calls.launchCmdAgent.length, 0, 'no relaunch just from showing the notice');

  await fire(findByClass(surface, 'skillRestartBtn'), 'click');
  await flush();
  assert.equal(calls.launchCmdAgent.length, 1, 'relaunch happens exactly on the click');
  assert.equal(calls.launchCmdAgent[0], tab, 'the same tab is relaunched');
});

test('unit: a successful Restart removes the notice and keeps skillInstalled true', async () => {
  const { promptSkillRegistration, document } = makeCtx();
  const surface = document.createElement('div');
  const tab = claudeTab();
  promptSkillRegistration(tab, surface);
  await fire(findByClass(surface, 'skillRestartBtn'), 'click');
  await flush();
  assert.equal(findByClass(surface, 'skill-restart-notice'), null, 'notice removed on success');
  assert.equal(tab.tasks.skillInstalled, true, 'skillInstalled stays true');
});

test('unit: a throwing Restart logs the error, swaps to a manual-restart message, keeps the notice + skillInstalled, and re-enables the button', async () => {
  const { promptSkillRegistration, document, calls } = makeCtx({ relaunchThrows: true });
  const surface = document.createElement('div');
  const tab = claudeTab();
  promptSkillRegistration(tab, surface);
  const btn = findByClass(surface, 'skillRestartBtn');

  await fire(btn, 'click');
  await flush();

  assert.equal(calls.launchCmdAgent.length, 1, 'relaunch attempted once');
  assert.ok(calls.consoleError >= 1, 'the error was logged');
  const notice = findByClass(surface, 'skill-restart-notice');
  assert.ok(notice, 'the notice remains after a failed relaunch');
  assert.match(notice.textContent, /manually/i, 'message swaps to restart-manually guidance');
  assert.equal(tab.tasks.skillInstalled, true, 'skillInstalled remains true (files are on disk)');
  assert.equal(btn.disabled, false, 'the button is re-enabled after failure');
});

// ---------------------------------------------------------------------------
// Duplicate-notice guard.
// ---------------------------------------------------------------------------
test('unit: calling the helper twice on the same surface leaves exactly ONE notice (no stacking)', () => {
  const { promptSkillRegistration, document } = makeCtx();
  const surface = document.createElement('div');
  const tab = claudeTab();
  promptSkillRegistration(tab, surface);
  promptSkillRegistration(tab, surface);
  assert.equal(findAll(surface, 'skill-restart-notice').length, 1, 'exactly one notice after two calls');
});
