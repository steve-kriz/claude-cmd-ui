'use strict';

// Canonical, Electron-free logic for the Tasks board's bug-create "forward
// switch" warning (TASK-042, hardened by TASK-044). renderer/renderer.js's
// openNewTaskModal surfaces a NON-BLOCKING amber warning when STEP 1 of a
// bug-create has already folded a `## Bug Reports` entry into one original and
// the user then switches the original-select to a DIFFERENT original: the first
// fold is left in place by design, so we tell the user rather than silently
// dropping it. This module hosts the canonical decision + listener-lifecycle +
// safe-text-write logic; renderer.js mirrors it inline browser-side because
// renderer.js is a browser script and cannot be `require`d under `node --test`.
// This is the same lib-canonical + renderer-mirror convention used by
// lib/modal-actions.js (bindActionOnce). Keep the renderer's inline mirror
// byte-for-byte behaviour-identical to this module: a drift-guard test
// (test/task-044-bug-switch-warning.e2e.test.js) ties the two together, and the
// unit test (test/task-044-bug-switch-warning.test.js) exercises THIS module.
//
// Purity: nothing here touches the DOM, disk, or Electron. The listener helper
// only calls the injected element's addEventListener / removeEventListener and
// reads/writes one bookkeeping property (`_bugSwitchWarnHandler`) on it; the
// text helper only assigns a string to `textContent`. A fake object exposing
// those members is enough to unit-test the whole lifecycle.

// -------------------------------------------------------------------------
// DECISION. `committedFoldTargets` is an iterable of the ORIGINAL ids that
// this session has already committed a STEP-1 fold against. `staleBugSwitchTargets`
// returns, in iteration order, every committed original that is NOT the
// currently-selected one — i.e. the folds that would dangle if the user creates
// against the current selection. `shouldWarnBugSwitch` is simply "is that set
// non-empty". The warning is advisory only; it NEVER blocks Create.
//
// - empty committed set                         -> [] / false (nothing folded yet)
// - committed only for the selected original     -> [] / false (no mismatch)
// - committed for a DIFFERENT original than sel.  -> [that original] / true
// -------------------------------------------------------------------------
function staleBugSwitchTargets(selectedOriginalId, committedFoldTargets) {
  const out = [];
  if (!committedFoldTargets) return out;
  for (const originalId of committedFoldTargets) {
    if (originalId !== selectedOriginalId) out.push(originalId);
  }
  return out;
}

function shouldWarnBugSwitch(selectedOriginalId, committedFoldTargets) {
  return staleBugSwitchTargets(selectedOriginalId, committedFoldTargets).length > 0;
}

// -------------------------------------------------------------------------
// LISTENER LIFECYCLE. The original-select is a PERSISTENT DOM element that
// survives modal re-opens, so a `change` listener attached on every open would
// accumulate without this guard (the TASK-024 stale-listener class, reached via
// a persistent control instead of an action button — bindActionOnce's
// `{ once: true }` is wrong here because the user may switch the select
// repeatedly within one session). We stash the currently-attached handler on the
// element itself (`_bugSwitchWarnHandler`); attaching FIRST detaches whatever a
// prior open left there, guaranteeing AT MOST ONE live `change` listener from
// this helper at any time. The returned disposer removes the handler (only if it
// is still the current one) and clears the bookkeeping — run on modal cleanup.
// -------------------------------------------------------------------------
function attachBugSwitchWarning(el, handler) {
  if (!el || typeof el.addEventListener !== 'function') {
    throw new TypeError('attachBugSwitchWarning: el must expose addEventListener');
  }
  // Detach any handler a prior open left on this persistent element FIRST.
  const prev = el._bugSwitchWarnHandler;
  if (prev && typeof el.removeEventListener === 'function') {
    el.removeEventListener('change', prev);
  }
  el._bugSwitchWarnHandler = handler;
  el.addEventListener('change', handler);

  return function dispose() {
    if (el._bugSwitchWarnHandler === handler) {
      if (typeof el.removeEventListener === 'function') {
        el.removeEventListener('change', handler);
      }
      el._bugSwitchWarnHandler = null;
    }
  };
}

// -------------------------------------------------------------------------
// SAFE TEXT WRITE. The warning is written via `textContent` — NEVER innerHTML —
// so an original id such as `<script>alert(1)</script>` lands as literal text
// and cannot inject markup / child element nodes. Coerces to a string; null /
// undefined clears the node.
// -------------------------------------------------------------------------
function writeBugWarnText(el, text) {
  if (!el) return;
  el.textContent = text == null ? '' : String(text);
}

module.exports = {
  staleBugSwitchTargets,
  shouldWarnBugSwitch,
  attachBugSwitchWarning,
  writeBugWarnText,
};
