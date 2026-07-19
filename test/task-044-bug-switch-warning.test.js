'use strict';

// ===========================================================================
// TASK-044 — EXECUTABLE unit tests for the bug-create "forward switch" warning,
// run against the REAL requireable helper lib/bug-switch-warning.js (option b:
// pure logic extracted from renderer.js and exercised directly, replacing the
// pure regex source-scan guards that were TASK-042's only coverage of these
// behaviours).
//
// Covered here (the three riskiest behaviours):
//  1. LISTENER LIFECYCLE — across simulated modal re-opens, AT MOST ONE live
//     `change` listener exists on the persistent select at any time, and it is
//     removed on cleanup (no accumulation, no dangling handler).
//  2. SAFE TEXT WRITE — a warning built from `<script>alert(1)</script>` is set
//     via textContent (a plain string assignment), NEVER innerHTML: the fake
//     element records a textContent string and NO parsed markup / child nodes.
//  3. DECISION — warn ONLY on a cross-target mismatch (committed fold for A,
//     selected B -> warn); never on same-original or empty set; never blocks
//     Create (the helper returns a boolean/array, it cannot gate submission).
//
// NO DOM, NO Electron, NO jsdom, NO new dependency. The "element" is a minimal
// in-memory fake exposing addEventListener / removeEventListener over an array,
// with browser-faithful `change`-dispatch and a textContent accessor that would
// EXPOSE any innerHTML/markup parsing were it ever attempted.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  staleBugSwitchTargets,
  shouldWarnBugSwitch,
  attachBugSwitchWarning,
  writeBugWarnText,
} = require('../lib/bug-switch-warning');

// ---------------------------------------------------------------------------
// Minimal fake <select>. Records every add/removeEventListener call, dispatches
// `change` to live listeners, and models textContent as a plain string. It has
// NO innerHTML setter and NO child-node model, so the only way a test can put
// text on it is via textContent — proving the production write cannot inject
// markup. `liveCount(event)` counts currently-attached listeners for an event.
// ---------------------------------------------------------------------------
function makeSelect() {
  return {
    listeners: [],
    _text: '',
    // Bookkeeping property the helper uses; declared so the fake is faithful.
    _bugSwitchWarnHandler: null,
    get textContent() { return this._text; },
    set textContent(v) {
      // Faithful DOM textContent: coerces to string, stores as literal text.
      // No markup parsing, no child nodes — assigning here can never create
      // element nodes. (If the helper ever used innerHTML, it would touch a
      // DIFFERENT, absent property and throw / no-op, which the tests detect.)
      this._text = String(v);
    },
    addEventListener(event, handler) {
      this.listeners.push({ event, handler });
    },
    removeEventListener(event, handler) {
      const i = this.listeners.findIndex(
        (l) => l.event === event && l.handler === handler,
      );
      if (i !== -1) this.listeners.splice(i, 1);
    },
    liveCount(event) {
      return this.listeners.filter((l) => l.event === event).length;
    },
    dispatchChange() {
      for (const l of this.listeners.filter((l) => l.event === 'change')) {
        l.handler.call(this, { type: 'change' });
      }
    },
  };
}

// ===========================================================================
// 1. LISTENER LIFECYCLE — no accumulation across re-opens, removed on cleanup
// ===========================================================================
test('lifecycle: repeated modal opens keep AT MOST ONE live change listener on the select', () => {
  const sel = makeSelect();
  let disposer = null;

  // Simulate 5 modal opens. Each open attaches a FRESH handler (a new closure,
  // as the renderer does per open) via the helper. Between opens the modal is
  // NOT dismissed — the classic accumulation trap.
  for (let i = 0; i < 5; i++) {
    const handler = () => {};
    disposer = attachBugSwitchWarning(sel, handler);
    assert.equal(sel.liveCount('change'), 1,
      `after open #${i + 1} exactly one change listener is live (no accumulation)`);
    // The element's bookkeeping points at the just-attached handler.
    assert.equal(sel._bugSwitchWarnHandler, handler);
  }

  // Cleanup removes the last handler and clears the bookkeeping — no dangling.
  disposer();
  assert.equal(sel.liveCount('change'), 0, 'cleanup removed the only live listener');
  assert.equal(sel._bugSwitchWarnHandler, null, 'bookkeeping cleared on dispose');
});

test('lifecycle: the surviving listener is the LATEST handler; stale ones are detached and never fire', () => {
  const sel = makeSelect();
  const fired = [];
  attachBugSwitchWarning(sel, () => fired.push('first'));
  attachBugSwitchWarning(sel, () => fired.push('second'));
  const dispose = attachBugSwitchWarning(sel, () => fired.push('third'));

  assert.equal(sel.liveCount('change'), 1, 'still exactly one listener after three opens');
  sel.dispatchChange();
  assert.deepEqual(fired, ['third'], 'only the newest handler fired — stale ones were detached');

  dispose();
  fired.length = 0;
  sel.dispatchChange();
  assert.deepEqual(fired, [], 'after cleanup a change event fires nothing (no dangling handler)');
});

test('lifecycle: dispose is idempotent and does not remove a newer handler bound after it', () => {
  const sel = makeSelect();
  const firstDispose = attachBugSwitchWarning(sel, () => {});
  // A later open rebinds; the OLD disposer must not clobber the NEW handler.
  const newHandler = () => {};
  attachBugSwitchWarning(sel, newHandler);
  firstDispose();
  assert.equal(sel.liveCount('change'), 1, 'stale disposer left the current listener intact');
  assert.equal(sel._bugSwitchWarnHandler, newHandler, 'current handler bookkeeping untouched');
});

test('lifecycle: helper rejects a non-element (matches renderer guard)', () => {
  assert.throws(() => attachBugSwitchWarning(null, () => {}), TypeError);
  assert.throws(() => attachBugSwitchWarning({}, () => {}), TypeError);
});

// ===========================================================================
// 2. SAFE TEXT WRITE — textContent, never innerHTML / markup injection
// ===========================================================================
test('safe write: a <script> original id is written as LITERAL text (no markup / no child nodes)', () => {
  const sel = makeSelect();
  const evil = '<script>alert(1)</script>';
  const message = 'Heads up: ' + evil + ' already has a recorded bug report.';

  writeBugWarnText(sel, message);

  // The exact string landed on textContent — including the angle brackets as
  // literal characters, not parsed tags.
  assert.equal(sel.textContent, message);
  assert.ok(sel.textContent.includes('<script>'), 'the markup survives as literal text, unparsed');
  // The fake has NO innerHTML property and NO children — proving nothing was
  // ever parsed into element nodes.
  assert.equal('innerHTML' in sel, false, 'write path never touched innerHTML');
  assert.equal(sel.childNodes, undefined, 'no child nodes were created from the string');
});

test('safe write: null / empty clears the node to an empty string', () => {
  const sel = makeSelect();
  writeBugWarnText(sel, 'something');
  writeBugWarnText(sel, '');
  assert.equal(sel.textContent, '');
  writeBugWarnText(sel, null);
  assert.equal(sel.textContent, '', 'null coerces to empty string, not the literal "null"... ');
});

test('safe write: no-ops safely when the element is absent', () => {
  assert.doesNotThrow(() => writeBugWarnText(null, 'x'));
  assert.doesNotThrow(() => writeBugWarnText(undefined, 'x'));
});

// ===========================================================================
// 3. DECISION — warn only on a cross-target mismatch; never block Create
// ===========================================================================
test('decision: warn ONLY when a committed fold exists for a DIFFERENT original than selected', () => {
  // Empty committed set -> never warn.
  assert.equal(shouldWarnBugSwitch('A', []), false, 'empty set -> no warning');
  assert.equal(shouldWarnBugSwitch('A', new Set()), false, 'empty Set -> no warning');

  // Only the same original committed -> no warning.
  assert.equal(shouldWarnBugSwitch('A', ['A']), false, 'selection matches the only committed fold -> no warning');

  // Cross-target mismatch -> warn (the core case: folded A, now selecting B).
  assert.equal(shouldWarnBugSwitch('B', ['A']), true, 'folded A, selected B -> warn');

  // Multiple committed, selection matches one but another is stale -> warn.
  assert.equal(shouldWarnBugSwitch('B', ['A', 'B']), true, 'a stale A fold while B selected -> warn');

  // Selection matches none of the committed -> warn.
  assert.equal(shouldWarnBugSwitch('C', ['A', 'B']), true, 'neither committed fold matches selected C -> warn');
});

test('decision: staleBugSwitchTargets lists exactly the cross-target originals, in order', () => {
  assert.deepEqual(staleBugSwitchTargets('B', ['A']), ['A']);
  assert.deepEqual(staleBugSwitchTargets('A', ['A']), []);
  assert.deepEqual(staleBugSwitchTargets('B', ['A', 'B']), ['A'], 'B (the selected) is excluded');
  assert.deepEqual(staleBugSwitchTargets('C', ['A', 'B']), ['A', 'B']);
  assert.deepEqual(staleBugSwitchTargets('A', []), [], 'empty in -> empty out');
  assert.deepEqual(staleBugSwitchTargets('A', null), [], 'no committed set -> empty, no throw');
});

test('decision: never blocks Create — it only reports a boolean/array, it cannot gate submission', () => {
  // Whether or not a warning is due, the decision returns a plain value; there is
  // no exception path, no promise, nothing that could halt a Create handler.
  const warnCase = shouldWarnBugSwitch('B', ['A']);
  const noWarnCase = shouldWarnBugSwitch('A', ['A']);
  assert.equal(typeof warnCase, 'boolean');
  assert.equal(typeof noWarnCase, 'boolean');
  // A "warn" verdict is advisory: the caller is free to proceed. We model a
  // Create that ignores the warning and assert it still runs to completion.
  let created = false;
  const create = () => { shouldWarnBugSwitch('B', ['A']); created = true; };
  assert.doesNotThrow(create);
  assert.equal(created, true, 'the warning did not (and cannot) block the create path');
});
