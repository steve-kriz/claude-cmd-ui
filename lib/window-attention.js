'use strict';

// Window-attention decision (TASK-078). When Claude pauses on a confirmation /
// selection menu (a tab in `waiting`), finishes and sits idle (`finished`), or a
// board ticket is waiting for an answer, the app should get the user's attention.
// While the window is backgrounded that means an OS taskbar flash / dock bounce
// (main.js drives Electron's BrowserWindow.flashFrame). This module is the PURE,
// Electron-free decision half — like lib/keep-awake.js it requires nothing from
// Electron so it can be unit-tested with plain `node --test`. It never touches the
// OS or the window; it only answers "given the current attention count and focus
// state, should the OS flash be requested?".
//
// The rule (a locked user decision): the OS flash fires only while the window is
// NOT focused. Any positive attention count with an unfocused window → request
// attention; a focused window, a zero/absent count, or junk input → false. The
// in-app tab pulse (CSS) shows regardless of focus; that is out of this module.

// The pure decision: should the OS request-attention flash be held right now?
// True iff there is at least one live attention condition AND the window is not
// focused. Tolerant of missing/junk inputs (null, undefined, negative, NaN,
// strings, objects) — anything that is not a finite positive number, or a window
// that is not explicitly unfocused, yields false. Never throws.
function shouldRequestAttention(input) {
  if (!input || typeof input !== 'object') return false;
  const { attentionCount, windowFocused } = input;
  if (typeof attentionCount !== 'number' || !Number.isFinite(attentionCount)) return false;
  if (attentionCount <= 0) return false;
  // Only flash when the window is explicitly unfocused. `windowFocused` must be a
  // real boolean false; an absent/unknown focus state is treated as "don't flash".
  if (windowFocused !== false) return false;
  return true;
}

module.exports = {
  shouldRequestAttention,
};
