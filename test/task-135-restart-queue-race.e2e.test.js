'use strict';

// ===========================================================================
// TASK-135 — e2e "cucumber" scenarios (Given/When/Then), implemented as plain
// `node --test` cases. NO cucumber npm package is installed or required; these
// are scenario-style node:test cases in Given/When/Then form.
//
// Feature: a `/orchestrate build` command queued around a skill-registration
// Restart (TASK-131's promptSkillRegistration) must be typed EXACTLY ONCE, into
// the NEW Claude session — never the dying/old one — and only once the new
// session reaches `finished`.
//
// The subject under test is the REAL renderer code (renderer/renderer.js, a
// browser script with no module.exports). The dispatch-ordering mechanism is
// exercised for real: setTabStatus (the finished-transition trigger),
// tryDispatchNextPrompt (the idle gate, its 300ms re-check, and the two-write
// submit), isAwaitingTuiSelection (headless-safe: returns false with no term),
// queueBuild (the guarded enqueue) and promptSkillRegistration (the Restart
// button) are all EXTRACTED headless by brace-matching the source (the
// convention of test/task-131-skill-registration.e2e.test.js) and driven with an
// INJECTED window + a minimal in-memory mock document.
//
// The dispatch gate itself is NOT stubbed or re-implemented. Only the
// side-effecting collaborators are stubbed: window.api.pty.write (a RECORDING
// stub keyed by session id — no real PTY), launchCmdAgent (the kill-and-respawn:
// clears tab.cmd.id then swaps in a new session id), and the finished-transition
// bookkeeping (finalizePendingPromptEntry / slackOnFinished / maybeContinueBuild
// / reportWindowAttention / renderQueue / logPromptEntry / buildCommandFor).
// NO real DB / Electron / network / PTY spawn ever happens.
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

// Timing constants are extracted from source (not hard-coded) so a change to the
// real delays flows into the test rather than silently diverging.
function extractConst(src, name) {
  const m = new RegExp('const ' + name + ' = (\\d+);').exec(src);
  assert.ok(m, `const ${name} found in renderer.js`);
  return Number(m[1]);
}
const QUEUE_SEND_DELAY_MS = extractConst(rendererSrc, 'QUEUE_SEND_DELAY_MS');
const QUEUE_ENTER_DELAY_MS = extractConst(rendererSrc, 'QUEUE_ENTER_DELAY_MS');

// Load the REAL dispatch gate + finished-transition trigger + guarded enqueue +
// restart button headless. tryDispatchNextPrompt and setTabStatus reference each
// other; extracting both into the same Function scope wires the REAL call chain
// (setTabStatus('finished') -> tryDispatchNextPrompt) without stubbing it.
function loadReal(window, document, console, deps) {
  const body = [
    'const QUEUE_SEND_DELAY_MS = ' + QUEUE_SEND_DELAY_MS + ';',
    'const QUEUE_ENTER_DELAY_MS = ' + QUEUE_ENTER_DELAY_MS + ';',
    // Side-effecting collaborators — injected as stubs. tryDispatchNextPrompt and
    // setTabStatus are NOT here: they are the real extracted subjects below.
    'const launchCmdAgent = deps.launchCmdAgent;',
    'const finalizePendingPromptEntry = deps.finalizePendingPromptEntry;',
    'const slackOnFinished = deps.slackOnFinished;',
    'const maybeContinueBuild = deps.maybeContinueBuild;',
    'const reportWindowAttention = deps.reportWindowAttention;',
    // The weekly usage bar refreshes when a run finishes (it is the moment quota
    // has just moved), so setTabStatus now collaborates with it too.
    'const refreshUsageBar = deps.refreshUsageBar;',
    'const renderQueue = deps.renderQueue;',
    'const logPromptEntry = deps.logPromptEntry;',
    'const buildCommandFor = deps.buildCommandFor;',
    // REAL subjects — the dispatch gate must not be stubbed.
    extractFn(rendererSrc, 'setTabStatus'),
    extractFn(rendererSrc, 'tryDispatchNextPrompt'),
    extractFn(rendererSrc, 'isAwaitingTuiSelection'),
    extractFn(rendererSrc, 'queueBuild'),
    extractFn(rendererSrc, 'promptSkillRegistration'),
    'return { setTabStatus, tryDispatchNextPrompt, isAwaitingTuiSelection,'
      + ' queueBuild, promptSkillRegistration };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function('window', 'document', 'console', 'deps', body)(window, document, console, deps);
}

// ---------------------------------------------------------------------------
// Minimal in-memory mock DOM (querySelector('.class'), createElement,
// createTextNode, appendChild, insertBefore, remove, classList, textContent).
// ---------------------------------------------------------------------------
function findByClass(root, cls) {
  for (const c of (root.children || [])) {
    if (c.classList && c.classList.contains(cls)) return c;
    const deep = findByClass(c, cls);
    if (deep) return deep;
  }
  return null;
}
function makeEl(tag) {
  const classes = new Set();
  const children = [];
  let text = '';
  const el = {
    tagName: String(tag || '').toUpperCase(),
    dataset: {}, style: {}, children,
    _listeners: {},
    disabled: false, value: '', title: '', type: '', id: '', parentNode: null,
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
    createTextNode: (t) => { let v = String(t); return { _isText: true, get textContent() { return v; }, set textContent(x) { v = String(x); } }; },
  };
}
async function fire(el, type) {
  const fns = (el._listeners && el._listeners[type]) || [];
  for (const fn of fns) await fn({ preventDefault() {}, stopPropagation() {} });
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
// Long enough to let the 300ms re-check + 180ms enter-write timers both fire.
const DISPATCH_SETTLE_MS = QUEUE_SEND_DELAY_MS + QUEUE_ENTER_DELAY_MS + 150;

const BUILD_PAYLOAD = '/orchestrate build';
const OLD_SESSION = 'session-old';
const NEW_SESSION = 'session-new';

// ---------------------------------------------------------------------------
// Harness. window.api.pty.write is a RECORDING stub keyed by session id, so the
// test can assert which session id each write targeted (never tab identity).
// launchCmdAgent mirrors the real kill-and-respawn: it records the old id, sets
// tab.cmd.id = null (the mid-kill window), then swaps in the NEW session id.
// ---------------------------------------------------------------------------
function makeHarness() {
  const writes = [];              // { id, data } in order
  const calls = { launchCmdAgent: [], consoleError: 0 };
  const document = makeDocument();
  const console = { error() { calls.consoleError += 1; }, warn() {}, log() {} };
  const window = {
    api: { pty: { write(id, data) { writes.push({ id, data }); } } },
  };
  const deps = {
    async launchCmdAgent(tab) {
      calls.launchCmdAgent.push(tab.cmd ? tab.cmd.id : null);
      // kill-and-respawn: null between kill and respawn, then a brand-new id.
      if (tab.cmd) { tab.cmd.id = null; tab.cmd.id = NEW_SESSION; }
    },
    finalizePendingPromptEntry() {},
    slackOnFinished() {},
    maybeContinueBuild() {},
    reportWindowAttention() {},
    refreshUsageBar() {},
    renderQueue() {},
    logPromptEntry() {},
    buildCommandFor() { return BUILD_PAYLOAD; },
  };
  return { window, document, console, deps, writes, calls };
}

// A claude tab with a live cmd PTY + the els the dispatch gate touches.
function makeTab(document, sessionId, status) {
  return {
    folder: 'C:\\proj',
    agent: 'claude',
    cmd: { id: sessionId, term: null },   // term:null -> isAwaitingTuiSelection is false (headless-safe)
    status: status || 'finished',
    promptQueue: [],
    queueFiring: false,
    idleTimer: null,
    tasks: { skillInstalled: true },
    els: {
      tabBtn: makeEl('button'),
      queueToggleBtn: makeEl('button'),
    },
  };
}

// Build a Tasks-style surface (notice sits above the board) for the real
// promptSkillRegistration, and return the live Restart button.
function showRestartNotice(api, document, tab) {
  const surface = makeEl('div');
  const board = makeEl('div');
  board.className = 'tasksBoard';
  surface.appendChild(board);
  api.promptSkillRegistration(tab, surface);
  const notice = findByClass(surface, 'skill-restart-notice');
  assert.ok(notice, 'the restart notice is shown');
  const btn = findByClass(notice, 'skillRestartBtn');
  assert.ok(btn, 'the notice carries a Restart button');
  return { surface, notice, btn };
}

const buildWritesTo = (writes, id) => writes.filter((w) => w.id === id && w.data === BUILD_PAYLOAD);
const enterWritesTo = (writes, id) => writes.filter((w) => w.id === id && w.data === '\r');

// ===========================================================================
// Scenario: Build queued after restart waits for the new session to be prompt-ready
// ===========================================================================
test('Scenario: a build queued after restart is NOT written while busy, then dispatches once to the NEW session on finished', async () => {
  // Given a claude tab with a live cmd PTY whose session id is "session-old",
  // and the orchestrate skill was just installed (restart notice showing).
  const { window, document, console, deps, writes, calls } = makeHarness();
  const api = loadReal(window, document, console, deps);
  const tab = makeTab(document, OLD_SESSION, 'finished');
  const { notice, btn } = showRestartNotice(api, document, tab);

  // When the user clicks Restart, launchCmdAgent respawns the session as "session-new".
  await fire(btn, 'click');
  assert.equal(calls.launchCmdAgent.length, 1, 'Restart relaunched exactly once');
  assert.equal(calls.launchCmdAgent[0], OLD_SESSION, 'the old session id was seen at kill time');
  assert.equal(tab.cmd.id, NEW_SESSION, 'tab.cmd.id now reads the new session id');
  assert.equal(findByClass(notice.parentNode || {}, 'skill-restart-notice'), null, 'the notice is removed on success');

  // And the new session's first output sets the tab status to "busy".
  api.setTabStatus(tab, 'busy');
  assert.equal(tab.status, 'busy');

  // When "/orchestrate build" is enqueued through the guarded enqueue path (queueBuild).
  api.queueBuild(tab);

  // Then no PTY write occurs while the tab status is not "finished".
  await delay(DISPATCH_SETTLE_MS);
  assert.equal(writes.length, 0, 'nothing is written to any PTY while busy');
  assert.deepEqual(tab.promptQueue, [BUILD_PAYLOAD], 'the build stays queued while busy');

  // When the new session goes idle and setTabStatus transitions the tab to "finished".
  api.setTabStatus(tab, 'finished');
  await delay(DISPATCH_SETTLE_MS);

  // Then "/orchestrate build" is written to "session-new" exactly once,
  assert.equal(buildWritesTo(writes, NEW_SESSION).length, 1, 'build written exactly once to the new session');
  // And a separate "\r" submit write follows to "session-new".
  assert.equal(enterWritesTo(writes, NEW_SESSION).length, 1, 'a separate \\r submit follows to the new session');
  const buildIdx = writes.findIndex((w) => w.data === BUILD_PAYLOAD);
  const enterIdx = writes.findIndex((w) => w.data === '\r');
  assert.ok(buildIdx >= 0 && enterIdx > buildIdx, 'the \\r submit is a separate write AFTER the command');
  // And the prompt queue is empty; the firing lock is released.
  assert.equal(tab.promptQueue.length, 0, 'the prompt queue is empty afterwards');
  assert.equal(tab.queueFiring, false, 'queueFiring released after dispatch');
  // And nothing ever targeted the pre-restart session.
  assert.equal(writes.filter((w) => w.id === OLD_SESSION).length, 0, 'zero writes to the pre-restart session');
});

// ===========================================================================
// Scenario: Restart races the prompt queue — stale-finished enqueue aborts and re-fires once
// ===========================================================================
test('Scenario: a stale-finished enqueue during the restart race ABORTS on the 300ms re-check, then dispatches once on the new finished', async () => {
  // Given the user clicked Restart and tab.cmd.id now reads "session-new",
  // BUT the tab status is still stale "finished" (launchCmdAgent never touched it).
  const { window, document, console, deps, writes, calls } = makeHarness();
  const api = loadReal(window, document, console, deps);
  const tab = makeTab(document, OLD_SESSION, 'finished');
  const { btn } = showRestartNotice(api, document, tab);
  await fire(btn, 'click');
  assert.equal(tab.cmd.id, NEW_SESSION, 'respawned to the new session');
  assert.equal(tab.status, 'finished', 'status is still stale-finished (no new output yet)');

  // When "/orchestrate build" is enqueued and the dispatcher starts firing.
  api.queueBuild(tab);
  assert.equal(tab.queueFiring, true, 'the guarded enqueue started the dispatcher (stale-finished)');
  assert.deepEqual(tab.promptQueue, [BUILD_PAYLOAD], 'build is queued and the 300ms re-check is pending');

  // And the new session's first output flips the tab status to "busy" before the 300ms re-check.
  api.setTabStatus(tab, 'busy');

  // Then the dispatch aborts without writing to any session.
  await delay(DISPATCH_SETTLE_MS);
  assert.equal(writes.length, 0, 'the re-check aborted: nothing was written to any session');
  // And tab.queueFiring is released and "/orchestrate build" remains in the queue.
  assert.equal(tab.queueFiring, false, 'queueFiring released on abort (no lockout)');
  assert.deepEqual(tab.promptQueue, [BUILD_PAYLOAD], 'the build remains queued after the abort');

  // When the new session later transitions to "finished".
  api.setTabStatus(tab, 'finished');
  await delay(DISPATCH_SETTLE_MS);

  // Then "/orchestrate build" is dispatched exactly once, to "session-new".
  assert.equal(buildWritesTo(writes, NEW_SESSION).length, 1, 'dispatched exactly once to the new session');
  assert.equal(writes.filter((w) => w.id === OLD_SESSION).length, 0, 'never dispatched to the old session');
  assert.equal(tab.promptQueue.length, 0, 'queue drained after the re-fire');
  assert.equal(calls.launchCmdAgent.length, 1, 'no extra relaunch happened');
});

// ===========================================================================
// Scenario (failure): the command is never delivered to the pre-restart session
// ===========================================================================
test('Scenario (failure): across the full restart-then-queue-then-dispatch flow, ZERO writes target the old session and exactly ONE build write total', async () => {
  // Given the full restart-then-queue-then-dispatch flow.
  const { window, document, console, deps, writes } = makeHarness();
  const api = loadReal(window, document, console, deps);
  const tab = makeTab(document, OLD_SESSION, 'finished');
  const { btn } = showRestartNotice(api, document, tab);
  await fire(btn, 'click');
  // Enqueue during the stale-finished window (worst case for wrong-session delivery).
  api.queueBuild(tab);
  // New session output arrives (busy) mid-race, then goes idle (finished).
  api.setTabStatus(tab, 'busy');
  await delay(DISPATCH_SETTLE_MS);        // the stale-finished dispatch aborts here
  api.setTabStatus(tab, 'finished');
  await delay(DISPATCH_SETTLE_MS);        // real dispatch fires here
  // Re-entrancy pressure: a repeated finished call must NOT double-dispatch.
  api.setTabStatus(tab, 'finished');
  await delay(DISPATCH_SETTLE_MS);

  // Then the recording stub shows zero writes addressed to "session-old".
  assert.equal(writes.filter((w) => w.id === OLD_SESSION).length, 0, 'zero writes to the pre-restart session id');
  // And exactly one "/orchestrate build" write in total across the scenario.
  assert.equal(writes.filter((w) => w.data === BUILD_PAYLOAD).length, 1, 'exactly one build write in total (no duplicate dispatch)');
  assert.equal(buildWritesTo(writes, NEW_SESSION).length, 1, 'that one build write targeted the new session');
  assert.equal(tab.promptQueue.length, 0, 'queue empty');
});

// ===========================================================================
// Scenario (edge): dispatch during the kill window is a safe no-op
// ===========================================================================
test('Scenario (edge): with tab.cmd.id null (mid-kill), tryDispatchNextPrompt writes nothing and leaves queueFiring unset', async () => {
  // Given the old session was killed and tab.cmd.id is null (respawn not finished),
  // and "/orchestrate build" is in the prompt queue.
  const { window, document, console, deps, writes } = makeHarness();
  const api = loadReal(window, document, console, deps);
  const tab = makeTab(document, null, 'finished');
  tab.promptQueue.push(BUILD_PAYLOAD);

  // When tryDispatchNextPrompt runs.
  api.tryDispatchNextPrompt(tab);
  await delay(DISPATCH_SETTLE_MS);

  // Then it returns without writing to any PTY.
  assert.equal(writes.length, 0, 'mid-kill dispatch writes nothing');
  // And tab.queueFiring is not set (no lockout left behind).
  assert.equal(tab.queueFiring, false, 'queueFiring not set during the kill window');
  assert.deepEqual(tab.promptQueue, [BUILD_PAYLOAD], 'the build is still queued');

  // And a later "finished" transition (once respawned) can still dispatch it.
  tab.cmd.id = NEW_SESSION;
  api.setTabStatus(tab, 'busy');
  api.setTabStatus(tab, 'finished');
  await delay(DISPATCH_SETTLE_MS);
  assert.equal(buildWritesTo(writes, NEW_SESSION).length, 1, 'the queued build dispatches once respawned');
  assert.equal(tab.promptQueue.length, 0, 'queue drained after respawn dispatch');
});

// ===========================================================================
// SOURCE DRIFT GUARD (mirror of test/task-030-plan-button.e2e.test.js): pin the
// ordering contract in the shipped source so it cannot silently drift.
// ===========================================================================
test('DRIFT GUARD: every enqueue site keeps the "if (tab.status === finished) tryDispatchNextPrompt(tab)" idle gate', () => {
  const gate = /if \(tab\.status === 'finished'\) tryDispatchNextPrompt\(tab\);/g;
  const hits = [...rendererSrc.matchAll(gate)].length;
  assert.ok(hits >= 3, `guarded-enqueue idle gate present at >= 3 sites (found ${hits})`);
  // queueBuild pushes the build command then applies the guard.
  const qb = extractFn(rendererSrc, 'queueBuild');
  assert.match(qb, /tab\.promptQueue\.push\(buildCommandFor\(tab\)\)/, 'queueBuild pushes the build command');
  assert.match(qb, /if \(tab\.status === 'finished'\) tryDispatchNextPrompt\(tab\);/, 'queueBuild guards dispatch on finished');
});

test('DRIFT GUARD: setTabStatus fires tryDispatchNextPrompt only on a transition INTO finished', () => {
  const s = extractFn(rendererSrc, 'setTabStatus');
  assert.match(s, /const prev = tab\.status;/, 'setTabStatus captures the previous status');
  assert.match(s, /if \(status === 'finished' && prev !== 'finished'\)/, 'dispatch fires only on the finished transition');
  assert.match(s, /tryDispatchNextPrompt\(tab\);/, 'the finished transition calls the dispatcher');
});

test('DRIFT GUARD: tryDispatchNextPrompt keeps the null-id guard, the 300ms re-check, and the separate \\r submit', () => {
  const d = extractFn(rendererSrc, 'tryDispatchNextPrompt');
  // Mid-kill null id returns before queueFiring is set.
  assert.ok(d.indexOf('if (!tab.cmd.id) return;') < d.indexOf('tab.queueFiring = true;'),
    'null-id guard returns before queueFiring is set (no lockout)');
  // The 300ms re-check aborts a stale-finished fire.
  assert.match(d, /if \(tab\.status !== 'finished'\) \{[\s\S]*?tab\.queueFiring = false;[\s\S]*?return;/,
    'the 300ms re-check aborts and releases queueFiring when no longer finished');
  // Exactly one shift + a separate \r submit guarded by tab.cmd && tab.cmd.id.
  assert.match(d, /const next = tab\.promptQueue\.shift\(\);/, 'a single shift() dispatches exactly one prompt');
  assert.match(d, /window\.api\.pty\.write\(tab\.cmd\.id, next\)/, 'the command is written to the CURRENT session id');
  assert.match(d, /if \(tab\.cmd && tab\.cmd\.id\) \{[\s\S]*?window\.api\.pty\.write\(tab\.cmd\.id, '\\r'\)/,
    'the \\r submit is a separate guarded write to the current session id');
  assert.match(d, /}, QUEUE_SEND_DELAY_MS\);/, 'the send delay wraps the re-check + dispatch');
  assert.match(d, /}, QUEUE_ENTER_DELAY_MS\);/, 'the enter delay wraps the \\r submit');
});
