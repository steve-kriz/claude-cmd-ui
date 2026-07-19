'use strict';

// Unit tests for lib/modal-actions.js — the Electron-free listener-lifecycle
// helper for the Tasks board's modal action buttons (TASK-024). The module is
// pure (no disk/network/Electron/DB): it only calls addEventListener /
// removeEventListener on the injected element, so it is exercised directly with
// a minimal in-memory fake element under `node --test`. renderer/renderer.js
// mirrors this logic inline browser-side and cannot be required, so these tests
// prove the canonical helper the renderer duplicates.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { bindActionOnce, resetActions } = require('../lib/modal-actions');

// ---------------------------------------------------------------------------
// Minimal, deterministic fake element that records listeners over a plain
// array. `fire(event)` invokes the currently-registered handlers for `event`
// and, faithful to the browser, removes any registered with { once: true }
// after they fire.
// ---------------------------------------------------------------------------
function makeFakeEl() {
  return {
    listeners: [],
    addEventListener(event, handler, opts) {
      this.listeners.push({ event, handler, opts });
    },
    removeEventListener(event, handler) {
      const i = this.listeners.findIndex(
        (l) => l.event === event && l.handler === handler,
      );
      if (i !== -1) this.listeners.splice(i, 1);
    },
    fire(event) {
      // Snapshot: handlers may re-bind during firing; the browser only runs
      // the set present at dispatch time.
      const matched = this.listeners.filter((l) => l.event === event);
      for (const l of matched) {
        // once semantics: remove before invoking so a re-bind inside the
        // handler survives.
        if (l.opts && l.opts.once) {
          const i = this.listeners.indexOf(l);
          if (i !== -1) this.listeners.splice(i, 1);
        }
        l.handler.call(this, { type: event });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// bindActionOnce — attaches with { once: true }
// ---------------------------------------------------------------------------

test('bindActionOnce: adds a listener with { once: true }', () => {
  const el = makeFakeEl();
  bindActionOnce(el, 'click', () => {});
  assert.equal(el.listeners.length, 1);
  assert.equal(el.listeners[0].event, 'click');
  assert.deepEqual(el.listeners[0].opts, { once: true });
});

// ---------------------------------------------------------------------------
// bindActionOnce twice on same (el, event) -> only the SECOND handler live
// ---------------------------------------------------------------------------

test('bindActionOnce: re-binding same (el,event) leaves exactly one live listener, the second handler', () => {
  const el = makeFakeEl();
  const first = () => {};
  const second = () => {};
  bindActionOnce(el, 'click', first);
  bindActionOnce(el, 'click', second);
  assert.equal(el.listeners.length, 1, 'the first handler was detached');
  assert.equal(el.listeners[0].handler, second, 'the live handler is the second');
});

// ---------------------------------------------------------------------------
// once semantics — fires exactly once
// ---------------------------------------------------------------------------

test('bindActionOnce: firing once invokes the handler once; firing again does not', () => {
  const el = makeFakeEl();
  let count = 0;
  bindActionOnce(el, 'click', () => { count += 1; });
  el.fire('click');
  el.fire('click');
  assert.equal(count, 1);
  assert.equal(el.listeners.length, 0, 'self-detached after firing (once)');
});

// ---------------------------------------------------------------------------
// dispose() removes the handler
// ---------------------------------------------------------------------------

test('bindActionOnce: dispose() removes the handler and firing is a no-op', () => {
  const el = makeFakeEl();
  let count = 0;
  const dispose = bindActionOnce(el, 'click', () => { count += 1; });
  dispose();
  assert.equal(el.listeners.length, 0);
  el.fire('click');
  assert.equal(count, 0);
});

test('bindActionOnce: dispose() only clears when handler is still current (idempotent / superseded)', () => {
  const el = makeFakeEl();
  const first = () => {};
  const second = () => {};
  const disposeFirst = bindActionOnce(el, 'click', first);
  bindActionOnce(el, 'click', second);
  // The first handler was already detached by the re-bind; disposing its stale
  // disposer must not remove the second, still-current handler.
  disposeFirst();
  assert.equal(el.listeners.length, 1);
  assert.equal(el.listeners[0].handler, second);
});

// ---------------------------------------------------------------------------
// independence across elements / events
// ---------------------------------------------------------------------------

test('bindActionOnce: different elements are tracked independently', () => {
  const elA = makeFakeEl();
  const elB = makeFakeEl();
  const hA = () => {};
  const hB = () => {};
  bindActionOnce(elA, 'click', hA);
  bindActionOnce(elB, 'click', hB);
  // Re-binding elA must not touch elB.
  bindActionOnce(elA, 'click', () => {});
  assert.equal(elB.listeners.length, 1);
  assert.equal(elB.listeners[0].handler, hB);
});

test('bindActionOnce: different events on one element are tracked independently', () => {
  const el = makeFakeEl();
  const onClick = () => {};
  const onSubmit = () => {};
  bindActionOnce(el, 'click', onClick);
  bindActionOnce(el, 'submit', onSubmit);
  assert.equal(el.listeners.length, 2);
  // Re-binding click leaves submit alone.
  bindActionOnce(el, 'click', () => {});
  assert.equal(el.listeners.filter((l) => l.event === 'submit').length, 1);
  assert.equal(el.listeners.filter((l) => l.event === 'click').length, 1);
});

// ---------------------------------------------------------------------------
// resetActions
// ---------------------------------------------------------------------------

test('resetActions: detaches all handlers this helper bound for el', () => {
  const el = makeFakeEl();
  bindActionOnce(el, 'click', () => {});
  bindActionOnce(el, 'submit', () => {});
  resetActions(el);
  assert.equal(el.listeners.length, 0);
});

test('resetActions: honours an explicit events list, leaving others attached', () => {
  const el = makeFakeEl();
  bindActionOnce(el, 'click', () => {});
  const onSubmit = () => {};
  bindActionOnce(el, 'submit', onSubmit);
  resetActions(el, ['click']);
  assert.equal(el.listeners.length, 1);
  assert.equal(el.listeners[0].event, 'submit');
  assert.equal(el.listeners[0].handler, onSubmit);
});

test('resetActions: on an element never bound is a no-op (does not throw)', () => {
  const el = makeFakeEl();
  assert.doesNotThrow(() => resetActions(el));
  assert.equal(el.listeners.length, 0);
});

// ---------------------------------------------------------------------------
// EDGE: missing removeEventListener must not throw
// ---------------------------------------------------------------------------

test('bindActionOnce: element without removeEventListener does not throw on re-bind', () => {
  const added = [];
  const el = {
    addEventListener(event, handler, opts) { added.push({ event, handler, opts }); },
    // no removeEventListener
  };
  assert.doesNotThrow(() => {
    bindActionOnce(el, 'click', () => {});
    bindActionOnce(el, 'click', () => {}); // re-bind: cannot remove prev, must guard
  });
  assert.equal(added.length, 2);
});

test('bindActionOnce: dispose does not throw when removeEventListener is absent', () => {
  const el = { addEventListener() {} };
  const dispose = bindActionOnce(el, 'click', () => {});
  assert.doesNotThrow(() => dispose());
});

// ---------------------------------------------------------------------------
// bindActionOnce: invalid element rejected
// ---------------------------------------------------------------------------

test('bindActionOnce: throws when el lacks addEventListener', () => {
  assert.throws(() => bindActionOnce(null, 'click', () => {}), TypeError);
  assert.throws(() => bindActionOnce({}, 'click', () => {}), TypeError);
});
