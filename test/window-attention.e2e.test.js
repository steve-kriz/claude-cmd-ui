'use strict';

// ===========================================================================
// TASK-078 — e2e "cucumber" scenarios (Given/When/Then) for window & tab
// attention when Claude is waiting for input. Plain `node --test` cases — NO
// `cucumber` npm package is installed or added.
//
// Feature (two levels):
//   1. Tab pulse (in-app): a `waiting` tab's dot pulses (CSS); busy/idle/finished
//      dots do not. Verified via source/CSS scan.
//   2. OS taskbar flash: while an attention condition holds AND the window is
//      unfocused, main requests OS attention via BrowserWindow.flashFrame(true);
//      it clears (flashFrame(false)) on focus or when no condition remains.
//
// The pure decision (lib/window-attention.js) is unit-tested directly in
// test/window-attention.test.js. main.js (Electron main) and renderer.js
// (browser script) are NOT require()-able, so — matching the repo convention
// (test/slack-summarize.e2e.test.js, test/task-075-type-bar.e2e.test.js) — the
// scenarios drive FAITHFUL in-memory MIRRORS of:
//   • main.js  setWindowAttention() + the 'window:attention' ipcMain handler,
//     wired to the REAL shouldRequestAttention and a MOCKED window
//     (flashFrame / isFocused / isDestroyed recorded, never a real BrowserWindow),
//   • renderer.js reportWindowAttention() aggregator, wired to the REAL
//     isTicketWaitingForAnswer / ticketFieldNonEmpty EXTRACTED from renderer.js
//     and a MOCKED window.api.attention.report that forwards over a fake IPC into
//     the main mirror.
// SOURCE-SCAN drift guards tie every mirror back to the real source so drift
// fails here. NO real Electron window, NO DB, NO IPC, NO network.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The REAL pure decision — the e2e mirrors flash through this, never a re-impl.
const { shouldRequestAttention } = require('../lib/window-attention.js');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(REPO, 'main.js'), 'utf8').replace(/\r\n/g, '\n');
const preloadSrc = fs.readFileSync(path.join(REPO, 'preload.js'), 'utf8').replace(/\r\n/g, '\n');
const cssSrc = fs.readFileSync(path.join(REPO, 'renderer', 'styles.css'), 'utf8').replace(/\r\n/g, '\n');

// --- Extract a named function declaration from source by brace-matching. -----
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start !== -1, `function ${name} found in source`);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) { i += 1; break; } }
  }
  return src.slice(start, i);
}

// Extract the REAL `window.api.pty.onExit(...)` handler region from renderer.js
// by paren-matching from the call's opening `(` to its matching `)`. This anchors
// the pty-exit drift guard to the actual onExit handler body (TASK-084) instead
// of matching any `reportWindowAttention();` followed by `});` anywhere in the
// file. Tolerant of benign whitespace/formatting; the region contains only the
// handler's own statements, so a deletion of its re-report call is detectable.
function extractPtyExitHandler(src) {
  const start = src.indexOf('window.api.pty.onExit(');
  assert.ok(start !== -1, 'the pty onExit handler is wired in renderer.js');
  let i = src.indexOf('(', start);
  let depth = 0;
  let end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '(') depth += 1;
    else if (src[i] === ')') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
  }
  assert.ok(end !== -1, 'the pty onExit handler region is delimited');
  return src.slice(start, end);
}

// Load the REAL renderer predicates headless (proves the mirror uses production
// logic for the board-ticket attention condition, not a re-implementation).
const R = (function loadRendererPredicates() {
  const body = [
    extractFn(rendererSrc, 'ticketFieldNonEmpty'),
    extractFn(rendererSrc, 'isTicketWaitingForAnswer'),
    'return { ticketFieldNonEmpty, isTicketWaitingForAnswer };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(body)();
})();

// ===========================================================================
// Faithful in-memory app mirror: MOCK window + main.js apply/handler + renderer
// aggregator, all wired to the REAL shouldRequestAttention / isTicketWaiting...
// ===========================================================================
function makeApp(opts = {}) {
  // --- MOCK window (never a real Electron BrowserWindow) ---
  const flashCalls = [];        // every boolean handed to flashFrame, in order
  const win = {
    _focused: opts.focused === true,
    _destroyed: false,
    _throwOnFlash: false,
    isFocused() { return this._focused; },
    isDestroyed() { return this._destroyed; },
    flashFrame(v) {
      if (this._throwOnFlash) throw new Error('flashFrame unavailable on this platform');
      flashCalls.push(v);
    },
  };
  let mainWindow = win;

  // --- main.js mirror: dedup state + setWindowAttention (guard + try/catch) ---
  let windowAttentionOn = false;
  function setWindowAttention(on) {
    const next = !!on;
    if (next === windowAttentionOn) return;               // deduped
    if (!mainWindow || mainWindow.isDestroyed()) {         // window-destroyed guard
      if (!next) windowAttentionOn = false;
      return;
    }
    try {
      mainWindow.flashFrame(next);
      windowAttentionOn = next;
    } catch (e) {
      // swallow — a platform flashFrame throw must never crash the process
    }
  }

  // --- main.js mirror: the 'window:attention' ipcMain handler ---
  function ipcOnAttention(payload) {
    const attentionCount = typeof payload === 'number'
      ? payload
      : (payload && typeof payload === 'object' ? payload.count : NaN);
    let windowFocused = true;
    try {
      windowFocused = !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused());
    } catch (_) {
      windowFocused = true;
    }
    const verdict = shouldRequestAttention({ attentionCount, windowFocused });
    setWindowAttention(verdict);
  }

  // --- main.js mirror: window 'focus' event + crash/hang handlers ---
  function mainFocusEvent() { setWindowAttention(false); }        // mainWindow.on('focus')
  function mainRenderProcessGone() { setWindowAttention(false); } // wc.on('render-process-gone')
  function mainUnresponsive() { setWindowAttention(false); }      // wc.on('unresponsive')

  // --- renderer.js mirror: TABS map + reportWindowAttention aggregator ---
  const TABS = new Map();
  // The fire-and-forget preload bridge → forwards the bare count over fake IPC.
  const windowApi = { attention: { report: (count) => ipcOnAttention(count) } };

  function reportWindowAttention() {
    if (!windowApi.attention || !windowApi.attention.report) return;
    let attentionCount = 0;
    for (const tb of TABS.values()) {
      if (tb && tb.status === 'waiting') attentionCount++;
      const tickets = tb && tb.tasks && tb.tasks.tickets;
      if (!tickets || typeof tickets.values !== 'function') continue;
      for (const tk of tickets.values()) {
        if (tk && R.isTicketWaitingForAnswer(tk.fm)) attentionCount++;
      }
    }
    try { windowApi.attention.report(attentionCount); } catch (_) { /* ignore */ }
  }

  // --- renderer.js mirror: setTabStatus choke point (reports only on transition) ---
  function setTabStatus(tab, status) {
    const prev = tab.status;
    tab.status = status;
    if (status !== prev) reportWindowAttention();
  }

  // Test helpers to drive the renderer state.
  function addTab(id, status) {
    const tab = { id, status: status || 'idle', tasks: { tickets: new Map() } };
    TABS.set(id, tab);
    return tab;
  }
  function closeTab(id) { TABS.delete(id); reportWindowAttention(); }  // closeTab re-reports
  function ptyExit(id) { reportWindowAttention(); }                    // pty:exit re-reports

  // DOM focus/blur listeners both call reportWindowAttention (re-evaluate now).
  function windowFocus() { win._focused = true; reportWindowAttention(); }
  function windowBlur() { win._focused = false; reportWindowAttention(); }

  return {
    win, flashCalls,
    get windowAttentionOn() { return windowAttentionOn; },
    setDestroyed(v) { win._destroyed = !!v; },
    setThrowOnFlash(v) { win._throwOnFlash = !!v; },
    // main mirrors
    ipcOnAttention, setWindowAttention, mainFocusEvent, mainRenderProcessGone, mainUnresponsive,
    // renderer mirrors
    TABS, reportWindowAttention, setTabStatus, addTab, closeTab, ptyExit,
    windowFocus, windowBlur,
  };
}

// Convenience: booleans that reached flashFrame(true).
const flashedTrue = (app) => app.flashCalls.filter((v) => v === true).length;

// ===========================================================================
// Scenario: An attention condition while unfocused requests attention
//   Given one tab whose status is "waiting"
//   And the window is not focused
//   When the attention verdict is computed
//   Then shouldRequestAttention returns true
//   And main calls flashFrame(true) exactly once
// ===========================================================================
test('Scenario: an attention condition while unfocused requests attention (flashFrame(true) once)', () => {
  // Given a waiting tab and an unfocused window
  const app = makeApp({ focused: false });
  const tab = app.addTab('t1', 'idle');

  // When the tab enters "waiting" (choke point re-reports) — verdict computed
  app.setTabStatus(tab, 'waiting');

  // Then the pure verdict is true and main flashed exactly once
  assert.equal(shouldRequestAttention({ attentionCount: 1, windowFocused: false }), true);
  assert.deepEqual(app.flashCalls, [true], 'flashFrame(true) called exactly once');
  assert.equal(app.windowAttentionOn, true, 'the applied state is ON');

  // And repeated identical reports (e.g. pty data ticks) do NOT re-flash (dedup).
  app.reportWindowAttention();
  app.reportWindowAttention();
  assert.deepEqual(app.flashCalls, [true], 'dedup: no extra flashFrame calls per tick');
});

// ===========================================================================
// Scenario: A finished (idle) tab is NOT a call to action and must NOT flash.
//   Given a busy tab and an unfocused window
//   When the run completes and the tab becomes "finished"
//   Then no OS flash is requested (nothing is asking the user a question)
// A finished tab used to count, so the taskbar flashed after EVERY run. The flash
// is reserved for a genuine call to action: a `waiting` tab or an unanswered
// ticket question.
// ===========================================================================
test('Scenario: a finished (idle) tab is NOT a call to action and never flashes', () => {
  // Given a busy tab and an unfocused window
  const app = makeApp({ focused: false });
  const tab = app.addTab('t1', 'busy');

  // When the run completes → "finished"
  app.setTabStatus(tab, 'finished');

  // Then nothing flashes — the count is zero, so the verdict is false
  assert.equal(flashedTrue(app), 0, 'a finished tab never flashes the taskbar');
  assert.deepEqual(app.flashCalls, [], 'no flashFrame call at all (already off, deduped)');
  assert.equal(app.windowAttentionOn, false, 'applied state stays OFF after a run finishes');
});

// ===========================================================================
// Scenario: A waiting tab that finishes clears the flash.
//   Given an unfocused flashing window because a tab is waiting on a menu
//   When the tab leaves "waiting" and goes "finished"
//   Then the flash clears (the question is gone; idleness alone is not a CTA)
// ===========================================================================
test('Scenario: a waiting tab going finished clears the flash', () => {
  const app = makeApp({ focused: false });
  const tab = app.addTab('t1', 'waiting');
  app.reportWindowAttention();
  assert.deepEqual(app.flashCalls, [true], 'flashing while the question is live');

  app.setTabStatus(tab, 'finished');
  assert.deepEqual(app.flashCalls, [true, false], 'finishing clears the flash');
  assert.equal(app.windowAttentionOn, false);
});

// ===========================================================================
// Scenario: A board ticket waiting for an answer also counts
//   Given no tab is waiting or finished
//   And one board ticket has a question and no answer
//   And the window is not focused
//   Then attentionCount is at least 1 and shouldRequestAttention returns true
// ===========================================================================
test('Scenario: a board ticket waiting for an answer (question set, no answer) counts', () => {
  // Given an idle tab holding a board ticket with a question and no answer
  const app = makeApp({ focused: false });
  const tab = app.addTab('t1', 'idle');
  tab.tasks.tickets.set('TASK-001', { fm: { id: 'TASK-001', question: 'Which DB?', answer: '' } });

  // Sanity: the REAL predicate agrees this ticket is waiting for an answer.
  assert.equal(R.isTicketWaitingForAnswer({ question: 'Which DB?', answer: '' }), true);

  // When the board poll re-evaluates attention
  app.reportWindowAttention();

  // Then attentionCount >= 1 and main flashed
  assert.deepEqual(app.flashCalls, [true], 'a waiting-for-answer ticket flashes while unfocused');

  // Edge: once the ticket is answered, the condition drops and the flash clears.
  tab.tasks.tickets.set('TASK-001', { fm: { id: 'TASK-001', question: 'Which DB?', answer: 'Postgres' } });
  app.reportWindowAttention();
  assert.deepEqual(app.flashCalls, [true, false], 'answering the ticket clears the flash');
});

// ===========================================================================
// Scenario: An attention condition while focused does not flash
//   Given one tab whose status is "waiting"
//   And the window is focused
//   Then shouldRequestAttention returns false
//   And flashFrame(true) is never called
// ===========================================================================
test('Scenario: an attention condition while the window IS focused never flashes', () => {
  // Given a focused window and a waiting tab
  const app = makeApp({ focused: true });
  const tab = app.addTab('t1', 'idle');

  // When the tab enters "waiting"
  app.setTabStatus(tab, 'waiting');

  // Then no OS flash — the in-app pulse alone suffices while focused
  assert.equal(shouldRequestAttention({ attentionCount: 1, windowFocused: true }), false);
  assert.equal(flashedTrue(app), 0, 'flashFrame(true) is never called while focused');
  assert.equal(app.windowAttentionOn, false, 'applied state stays OFF while focused');
});

// ===========================================================================
// Scenario: Gaining focus clears the flash
//   Given the window is flashing because a tab is waiting
//   When the window gains focus
//   Then flashFrame(false) is called
//   And the tab keeps its waiting pulse until the menu is answered
// ===========================================================================
test('Scenario: gaining focus clears the flash (tab keeps its waiting status/pulse)', () => {
  // Given an unfocused flashing window with a waiting tab
  const app = makeApp({ focused: false });
  const tab = app.addTab('t1', 'waiting');
  app.reportWindowAttention();
  assert.deepEqual(app.flashCalls, [true], 'flashing before focus');

  // When the window gains focus (renderer focus listener re-reports → verdict false)
  app.windowFocus();

  // Then the flash is cleared
  assert.deepEqual(app.flashCalls, [true, false], 'focus clears the flash');
  assert.equal(app.windowAttentionOn, false);
  // And the tab still holds its waiting status (the CSS pulse persists until answered)
  assert.equal(tab.status, 'waiting', 'the tab keeps its waiting status/pulse after focus');
});

test('Scenario (variant): the main-process focus event also clears the flash directly', () => {
  // Given an unfocused flashing window
  const app = makeApp({ focused: false });
  app.addTab('t1', 'waiting');
  app.reportWindowAttention();
  assert.deepEqual(app.flashCalls, [true]);

  // When main's own mainWindow.on('focus') fires (belt-and-braces clear)
  app.mainFocusEvent();

  // Then the flash clears even without a renderer report
  assert.deepEqual(app.flashCalls, [true, false], 'main focus event clears the flash');
});

// ===========================================================================
// Scenario: Last attention condition resolving clears the flash
//   Given two tabs are waiting and the window is unfocused and flashing
//   When one tab's menu is answered and its status becomes "busy"
//   Then the flash remains (one tab still waiting)
//   When the second tab leaves "waiting" and no other condition holds
//   Then flashFrame(false) is called
// ===========================================================================
test('Scenario: multiple conditions = single state; flash clears only when the LAST resolves', () => {
  // Given two waiting tabs, unfocused and flashing
  const app = makeApp({ focused: false });
  const a = app.addTab('a', 'idle');
  const b = app.addTab('b', 'idle');
  app.setTabStatus(a, 'waiting');
  app.setTabStatus(b, 'waiting');
  // A single flash was requested despite TWO conditions (deduped, one app-wide state).
  assert.deepEqual(app.flashCalls, [true], 'two conditions produce a single flashFrame(true)');

  // When one tab's menu is answered → busy
  app.setTabStatus(a, 'busy');
  // Then the flash remains — one tab still waiting (count still > 0, dedup keeps it)
  assert.deepEqual(app.flashCalls, [true], 'flash remains while one condition persists');
  assert.equal(app.windowAttentionOn, true);

  // When the second tab leaves "waiting" and no other condition holds
  app.setTabStatus(b, 'busy');
  // Then flashFrame(false) is called
  assert.deepEqual(app.flashCalls, [true, false], 'flash clears only when the last condition resolves');
  assert.equal(app.windowAttentionOn, false);
});

// ===========================================================================
// Scenario: Closing a waiting tab (or its pty exiting) re-reports.
// ===========================================================================
test('Scenario: closing the last waiting tab re-reports and clears the flash', () => {
  const app = makeApp({ focused: false });
  const tab = app.addTab('t1', 'waiting');
  app.reportWindowAttention();
  assert.deepEqual(app.flashCalls, [true], 'flashing while the waiting tab exists');

  // When the waiting tab is closed (closeTab re-reports)
  app.closeTab('t1');
  assert.deepEqual(app.flashCalls, [true, false], 'closing the last waiting tab clears the flash');
});

test('Scenario: a pty exit on the last waiting tab re-reports and clears the flash', () => {
  const app = makeApp({ focused: false });
  const tab = app.addTab('t1', 'waiting');
  app.reportWindowAttention();
  assert.deepEqual(app.flashCalls, [true]);

  // pty:exit sets the tab away from waiting, then re-reports.
  tab.status = 'idle';
  app.ptyExit('t1');
  assert.deepEqual(app.flashCalls, [true, false], 'pty exit clears the flash if it was the last condition');
});

// ===========================================================================
// Scenario: Edge — junk report payloads never throw
//   Given the attention channel receives null, "abc", -1, NaN and {}
//   When main computes the verdict for each
//   Then no exception is raised
//   And flashFrame is called with false or not at all (never true)
// ===========================================================================
test('Scenario (edge): junk report payloads never throw and never flash true', () => {
  const app = makeApp({ focused: false });
  const junk = [null, undefined, 'abc', '5', -1, 0, NaN, Infinity, -Infinity, {}, [], true, false, () => {}];
  for (const payload of junk) {
    assert.doesNotThrow(() => app.ipcOnAttention(payload), `payload ${String(payload)} must not throw`);
  }
  // { count } objects are tolerated but junk counts still don't flash true.
  for (const payload of [{ count: 'x' }, { count: NaN }, { count: -3 }, { count: 0 }, { foo: 1 }]) {
    assert.doesNotThrow(() => app.ipcOnAttention(payload));
  }
  assert.equal(flashedTrue(app), 0, 'no junk payload ever produced flashFrame(true)');
});

test('Scenario (edge): an { count } object with a valid positive count DOES flash while unfocused', () => {
  // The handler tolerates an object payload shape too (main coerces payload.count).
  const app = makeApp({ focused: false });
  app.ipcOnAttention({ count: 2 });
  assert.deepEqual(app.flashCalls, [true], 'object payload with positive count flashes');
});

// ===========================================================================
// Scenario: Edge — destroyed window
//   Given the main window has been destroyed
//   When an attention report arrives
//   Then no flashFrame call is attempted and nothing throws
// ===========================================================================
test('Scenario (edge): a destroyed window is a no-op (no flashFrame attempted, no throw)', () => {
  const app = makeApp({ focused: false });
  app.addTab('t1', 'waiting');
  app.setDestroyed(true);

  assert.doesNotThrow(() => app.reportWindowAttention(), 'report on a destroyed window must not throw');
  assert.deepEqual(app.flashCalls, [], 'no flashFrame call attempted on a destroyed window');
  assert.equal(app.windowAttentionOn, false, 'applied state stays OFF (no stale on recorded)');
});

// ===========================================================================
// Scenario: Edge — renderer crash clears attention
//   Given the window is flashing
//   When the renderer process is gone
//   Then the flash is cleared
// ===========================================================================
test('Scenario (edge): renderer crash (render-process-gone) clears an active flash', () => {
  const app = makeApp({ focused: false });
  app.addTab('t1', 'waiting');
  app.reportWindowAttention();
  assert.deepEqual(app.flashCalls, [true], 'flashing before the crash');

  // When the renderer process is gone
  app.mainRenderProcessGone();
  assert.deepEqual(app.flashCalls, [true, false], 'the flash is cleared after render-process-gone');
});

test('Scenario (edge): renderer hang (unresponsive) also clears an active flash', () => {
  const app = makeApp({ focused: false });
  app.addTab('t1', 'waiting');
  app.reportWindowAttention();
  assert.deepEqual(app.flashCalls, [true]);
  app.mainUnresponsive();
  assert.deepEqual(app.flashCalls, [true, false], 'unresponsive clears the flash');
});

// ===========================================================================
// Scenario (edge/failure): flashFrame throwing on some platform never crashes.
// ===========================================================================
test('Scenario (edge): a platform where flashFrame throws does not crash the handler', () => {
  const app = makeApp({ focused: false });
  app.addTab('t1', 'waiting');
  app.setThrowOnFlash(true);
  assert.doesNotThrow(() => app.reportWindowAttention(), 'a flashFrame throw is swallowed');
  // The verdict was true but the throw prevented recording the state — no crash.
  assert.equal(app.windowAttentionOn, false, 'a failed flashFrame does not record the on-state');
});

// ===========================================================================
// Scenario: Blur while a condition already holds starts the flash immediately.
// ===========================================================================
test('Scenario: blurring while a tab is already waiting starts the flash immediately', () => {
  // Given a focused window with a waiting tab (no flash while focused)
  const app = makeApp({ focused: true });
  app.addTab('t1', 'waiting');
  app.reportWindowAttention();
  assert.equal(flashedTrue(app), 0, 'no flash while focused');

  // When the window loses focus (DOM blur listener re-reports)
  app.windowBlur();
  assert.deepEqual(app.flashCalls, [true], 'blur with a live condition starts the flash');
});

// ===========================================================================
// Waiting tab pulses on the tab strip (CSS scan) + drift guards.
//   Given a tab enters the "waiting" status
//   Then the tab button carries the status-waiting class
//   And the stylesheet defines a pulse animation bound to status-waiting (the dot)
//   And no pulse animation is bound to status-busy / status-finished
// ===========================================================================
test('Scenario: the waiting tab dot pulses; busy/finished dots do not', () => {
  // The waiting tab dot binds the pulse keyframe.
  const waitingDot = cssSrc.slice(
    cssSrc.indexOf('.ws-tab.status-waiting .ws-tab-dot'),
    cssSrc.indexOf('.ws-tab.status-waiting {'),
  );
  assert.ok(waitingDot.length > 0, 'the .ws-tab.status-waiting .ws-tab-dot rule is present');
  assert.match(
    waitingDot,
    /animation:\s*task-card-dot-pulse-waiting\s/,
    'the waiting tab dot binds the task-card-dot-pulse-waiting keyframe',
  );

  // The keyframe itself exists.
  assert.match(cssSrc, /@keyframes\s+task-card-dot-pulse-waiting\s*\{/, 'the pulse keyframe is defined');

  // busy and finished dots do NOT animate/pulse.
  const busyDot = cssSrc.slice(
    cssSrc.indexOf('.ws-tab.status-busy .ws-tab-dot'),
    cssSrc.indexOf('.ws-tab.status-waiting .ws-tab-dot'),
  );
  assert.ok(busyDot.length > 0, 'the busy dot rule is present');
  assert.ok(!/animation:/.test(busyDot), 'the busy tab dot does not pulse');

  const finishedDot = cssSrc.slice(
    cssSrc.indexOf('.ws-tab.status-finished .ws-tab-dot'),
    cssSrc.indexOf('.ws-tab.status-finished {'),
  );
  assert.ok(finishedDot.length > 0, 'the finished dot rule is present');
  assert.ok(!/animation:/.test(finishedDot), 'the finished tab dot does not pulse');
});

test('DRIFT GUARD: setTabStatus applies the status-<name> class so CSS can pulse the waiting tab', () => {
  // The real choke point removes all status-* classes then adds status-<status>.
  assert.match(
    rendererSrc,
    /classList\.remove\('status-idle',\s*'status-busy',\s*'status-waiting',\s*'status-finished'\)/,
    'setTabStatus clears the status-* classes',
  );
  assert.match(rendererSrc, /classList\.add\('status-'\s*\+\s*status\)/, 'setTabStatus adds status-<status>');
});

// ===========================================================================
// SOURCE-SCAN drift guards — tie the mirrors above to the REAL source.
// ===========================================================================

test('DRIFT GUARD (preload.js): attention.report is a fire-and-forget send on window:attention', () => {
  assert.match(
    preloadSrc,
    /report:\s*\(attentionCount\)\s*=>\s*ipcRenderer\.send\('window:attention',\s*attentionCount\)/,
    'preload exposes attention.report → ipcRenderer.send("window:attention", count)',
  );
});

test('DRIFT GUARD (main.js): setWindowAttention dedupes, guards isDestroyed, and try/catches flashFrame', () => {
  const body = extractFn(mainSrc, 'setWindowAttention');
  // Dedup: identical verdict is a no-op.
  assert.match(body, /if\s*\(next === windowAttentionOn\)\s*return/, 'dedup on the last-applied verdict');
  // Destroyed-window guard.
  assert.match(body, /!mainWindow\s*\|\|\s*mainWindow\.isDestroyed\(\)/, 'guards a null/destroyed window');
  // try/catch around flashFrame.
  assert.match(body, /try\s*\{[\s\S]*mainWindow\.flashFrame\(next\)[\s\S]*\}\s*catch/, 'flashFrame wrapped in try/catch');
  // State recorded only on a successful flash.
  assert.match(body, /windowAttentionOn = next/, 'records the applied state after a successful flash');
});

test('DRIFT GUARD (main.js): the window:attention handler coerces payload, reads focus, uses the real verdict', () => {
  const iHandler = mainSrc.indexOf("ipcMain.on('window:attention'");
  assert.ok(iHandler !== -1, 'the window:attention ipcMain handler is present');
  const handler = mainSrc.slice(iHandler, iHandler + 700);
  assert.match(handler, /typeof payload === 'number'/, 'coerces a bare-number payload');
  assert.match(handler, /payload\.count/, 'tolerates an { count } object payload');
  assert.match(handler, /mainWindow\.isFocused\(\)/, 'reads live window focus');
  assert.match(handler, /shouldRequestAttention\(\{\s*attentionCount,\s*windowFocused\s*\}\)/, 'uses the pure verdict');
  assert.match(handler, /setWindowAttention\(verdict\)/, 'applies the verdict');
});

test('DRIFT GUARD (main.js): focus, render-process-gone and unresponsive all clear the flash', () => {
  // mainWindow.on('focus') → setWindowAttention(false)
  assert.match(
    mainSrc,
    /mainWindow\.on\('focus',\s*\(\)\s*=>\s*\{\s*setWindowAttention\(false\);\s*\}\)/,
    'focus event clears the flash',
  );
  // render-process-gone and unresponsive handlers both clear it.
  const gone = mainSrc.slice(mainSrc.indexOf("wc.on('render-process-gone'"), mainSrc.indexOf("wc.on('unresponsive'"));
  assert.match(gone, /setWindowAttention\(false\)/, 'render-process-gone clears the flash');
  const unresp = mainSrc.slice(mainSrc.indexOf("wc.on('unresponsive'"), mainSrc.indexOf("wc.on('preload-error'"));
  assert.match(unresp, /setWindowAttention\(false\)/, 'unresponsive clears the flash');
  // main.js pulls in the pure module.
  assert.match(mainSrc, /require\('\.\/lib\/window-attention'\)/, 'main.js requires the pure decision module');
});

test('DRIFT GUARD (renderer.js): reportWindowAttention counts ONLY waiting tabs + waiting-for-answer tickets', () => {
  const body = extractFn(rendererSrc, 'reportWindowAttention');
  assert.match(body, /tb\.status === 'waiting'/, 'counts waiting tabs (Claude paused on a menu)');
  assert.match(body, /isTicketWaitingForAnswer\(tk\.fm\)/, 'counts board tickets waiting for an answer');
  // `finished` must NOT be an attention condition — a run merely going idle is not
  // a call to action, and counting it flashed the taskbar after every run.
  const code = body.replace(/\/\/[^\n]*/g, '');   // strip comments; only real code counts
  assert.doesNotMatch(code, /status === 'finished'/, 'a finished tab is not an attention condition');
  assert.match(body, /window\.api\.attention\.report\(attentionCount\)/, 'reports the aggregate count over the bridge');
  assert.match(body, /try\s*\{[\s\S]*catch/, 'the report is wrapped so a bridge failure never throws');
});

test('DRIFT GUARD (renderer.js): reportWindowAttention is called from every required site', () => {
  // setTabStatus — only on an actual transition (no per-tick IPC spam).
  const setTab = extractFn(rendererSrc, 'setTabStatus');
  assert.match(setTab, /if\s*\(status !== prev\)\s*reportWindowAttention\(\)/, 'setTabStatus reports on transition only');
  // closeTab re-reports.
  const closeTab = extractFn(rendererSrc, 'closeTab');
  assert.match(closeTab, /reportWindowAttention\(\)/, 'closeTab re-reports');
  // The tasks board poll re-reports — anchored to the renderTasksBoard function
  // BODY (TASK-085), not the "question/answer state is fresh" comment. The old
  // guard matched the comment prose, so a benign comment reword false-failed and
  // it validated text rather than the board-poll invocation. We extract the real
  // renderTasksBoard region by brace-matching and assert the call lives INSIDE
  // it, so a comment reword can't break the guard and a deletion is still caught.
  const boardBody = extractFn(rendererSrc, 'renderTasksBoard');
  assert.match(
    boardBody,
    /reportWindowAttention\(\)/,
    'the tasks board poll (renderTasksBoard) re-reports window attention (code-anchored, not comment-anchored)',
  );
  // pty:exit re-reports and DOM focus/blur listeners re-evaluate.
  assert.match(rendererSrc, /window\.addEventListener\('focus',\s*reportWindowAttention\)/, 'focus listener re-reports');
  assert.match(rendererSrc, /window\.addEventListener\('blur',\s*reportWindowAttention\)/, 'blur listener re-reports');
  // pty:exit handler calls it — anchored to the REAL pty onExit handler region
  // (TASK-084). The old guard matched ANY `reportWindowAttention();\n});` shape,
  // so deleting the pty-exit re-report while any other such shape existed would
  // have passed. We instead extract the `window.api.pty.onExit(...)` handler by
  // paren-matching and assert the call lives INSIDE that specific handler body.
  const onExitRegion = extractPtyExitHandler(rendererSrc);
  assert.match(
    onExitRegion,
    /reportWindowAttention\(\)/,
    'the pty onExit handler itself re-reports on completion (anchored to the real call site)',
  );
});

// ===========================================================================
// TASK-085 — Feature: the board-poll attention drift guard is CODE-anchored,
// not comment-anchored. These scenarios prove the re-anchored guard survives a
// comment reword (no false failure) and still catches a real deletion. Pure
// source scan — NO Electron, NO DB, NO IPC, NO network.
// ===========================================================================
test('Scenario: rewording the "question/answer state is fresh" comment does NOT break the board-poll guard', () => {
  // Given the real board-poll drift guard is anchored to the renderTasksBoard body.
  const boardBody = extractFn(rendererSrc, 'renderTasksBoard');
  assert.match(boardBody, /reportWindowAttention\(\)/, 'baseline: the guard passes against real code');

  // When the "question/answer state is fresh" comment is reworded (no functional change).
  const reworded = rendererSrc.replace(
    /question\/answer state is fresh/,
    'ticket q\/a state has been refreshed',
  );
  assert.notEqual(reworded, rendererSrc, 'the reword control actually changed the comment');
  assert.doesNotMatch(reworded, /question\/answer state is fresh/, 'the old comment prose is gone');

  // Then the code-anchored guard still passes (it never read the comment).
  const rewordedBody = extractFn(reworded, 'renderTasksBoard');
  assert.match(
    rewordedBody,
    /reportWindowAttention\(\)/,
    'rewording the comment does not break the code-anchored board-poll guard',
  );
});

test('Scenario (failure): removing the real renderTasksBoard reportWindowAttention() call FAILS the board-poll guard', () => {
  // Given the real board-poll call inside renderTasksBoard.
  const boardBody = extractFn(rendererSrc, 'renderTasksBoard');
  assert.match(boardBody, /reportWindowAttention\(\)/, 'baseline: the board-poll call is present');

  // When the board-poll re-report is removed from renderTasksBoard (only that call).
  const mutatedBoardBody = boardBody.replace(/\n\s*reportWindowAttention\(\);/, '');
  assert.notEqual(mutatedBoardBody, boardBody, 'the mutation removed the board-poll call');
  const mutatedSrc = rendererSrc.replace(boardBody, mutatedBoardBody);
  assert.notEqual(mutatedSrc, rendererSrc, 'the mutated source differs from the real source');

  // Then the anchored guard fails (the call is no longer inside renderTasksBoard).
  const reExtracted = extractFn(mutatedSrc, 'renderTasksBoard');
  assert.doesNotMatch(
    reExtracted,
    /reportWindowAttention\(\)/,
    'removing the board-poll call is caught by the code-anchored guard',
  );
});

test('DRIFT GUARD (isTicketWaitingForAnswer): question set AND answer empty', () => {
  // The real predicate the aggregator relies on (extracted + evaluated above).
  assert.equal(R.isTicketWaitingForAnswer({ question: 'q', answer: '' }), true, 'question, no answer → waiting');
  assert.equal(R.isTicketWaitingForAnswer({ question: 'q', answer: 'a' }), false, 'answered → not waiting');
  assert.equal(R.isTicketWaitingForAnswer({ question: '', answer: '' }), false, 'no question → not waiting');
  assert.equal(R.isTicketWaitingForAnswer({ question: '   ', answer: '' }), false, 'whitespace question → not waiting');
  assert.equal(R.isTicketWaitingForAnswer(null), false, 'null fm → not waiting (never throws)');
  assert.equal(R.isTicketWaitingForAnswer(undefined), false, 'undefined fm → not waiting');
});
