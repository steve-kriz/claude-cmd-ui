'use strict';

// Canonical, Electron-free listener-lifecycle helper for the Tasks board's
// modal action buttons (TASK-024). renderer/renderer.js's modal wiring
// (openBugReportModal / openNewTaskModal) attaches submit/cancel `click`
// handlers every time the modal opens; before this helper, re-opening a modal
// before dismissing it left the PRIOR invocation's handler — bound to the
// earlier `file` — still attached, so a submit could fire against a stale
// ticket. This module hosts the canonical add/remove bookkeeping and the
// renderer mirrors it inline browser-side, because renderer.js is a browser
// script and cannot be `require`d under `node --test`. This is the same
// lib/-canonical + renderer-mirror convention used by lib/ticket-queue.js
// (activeCount) and lib/ticket-progress.js (countRunning). Keep the renderer's
// inline `bindActionOnce` byte-for-byte behaviour-identical to this one:
// changing one without the other is a bug.
//
// Purity: this touches nothing but the injected element's addEventListener /
// removeEventListener. No DOM, no disk, no Electron. The "element" is any
// object exposing addEventListener(event, handler, opts) and
// removeEventListener(event, handler) — a fake with those two methods over a
// plain array is enough to unit-test the whole lifecycle.

// Module-local bookkeeping: for each element we have bound to, remember the
// handler currently attached per event name. Keyed by the element object
// (WeakMap so it never pins elements in memory), then by event string.
const boundHandlers = new WeakMap();

// Attach `handler` for `event` on `el`, guaranteeing at most one live handler
// per (el, event) that this helper manages, and that it fires at most once.
//
// The key property (stale-listener fix): we FIRST detach whatever this helper
// previously bound for this (el, event) — so a modal re-open can never leave
// the prior invocation's closure (bound to the earlier `file`) attached — then
// add the fresh `handler` with `{ once: true }` so it also self-detaches after
// firing. Returns a disposer that removes `handler` (and clears the bookkeeping
// if it is still the current one), for callers that dismiss without firing.
function bindActionOnce(el, event, handler) {
  if (!el || typeof el.addEventListener !== 'function') {
    throw new TypeError('bindActionOnce: el must expose addEventListener');
  }
  let perEvent = boundHandlers.get(el);
  if (!perEvent) { perEvent = new Map(); boundHandlers.set(el, perEvent); }

  // Detach the previously-bound handler for this (el, event) FIRST.
  const prev = perEvent.get(event);
  if (prev && typeof el.removeEventListener === 'function') {
    el.removeEventListener(event, prev);
  }

  el.addEventListener(event, handler, { once: true });
  perEvent.set(event, handler);

  return function dispose() {
    const cur = boundHandlers.get(el);
    if (cur && cur.get(event) === handler) {
      if (typeof el.removeEventListener === 'function') {
        el.removeEventListener(event, handler);
      }
      cur.delete(event);
    }
  };
}

// Detach every handler this helper currently manages for `el` (all events, or
// just the given `events` list). Useful to fully reset a modal's action nodes.
function resetActions(el, events) {
  const perEvent = boundHandlers.get(el);
  if (!perEvent) return;
  const names = Array.isArray(events) ? events : Array.from(perEvent.keys());
  for (const event of names) {
    const h = perEvent.get(event);
    if (h && typeof el.removeEventListener === 'function') {
      el.removeEventListener(event, h);
    }
    perEvent.delete(event);
  }
}

module.exports = {
  bindActionOnce,
  resetActions,
};
