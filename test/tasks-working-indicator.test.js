'use strict';

// Tests for the Tasks-board "being worked on" indicator decision (TASK-002).
//
// `renderer/renderer.js` is a BROWSER script — it has no `module.exports` and
// references `document`, so it cannot be `require()`d and unit-tested directly
// without fabricating a whole DOM harness (explicitly discouraged for this
// ticket). What IS testable here is the pure decision that drives the dot:
// `TASKS_ACTIVE_STATUSES.includes(status)`. To avoid drifting from the app, we
// read the real constant out of renderer.js source (the single source of truth)
// and verify the show/hide decision for every status. The visual rendering of
// the `<span class="task-card-dot">` itself is verified in-app.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RENDERER = path.join(__dirname, '..', 'renderer', 'renderer.js');
const src = fs.readFileSync(RENDERER, 'utf8');

// Extract the actual `const TASKS_ACTIVE_STATUSES = [ ... ];` literal from the
// renderer source and parse it, so this test tracks the app's real value.
function extractActiveStatuses(source) {
  const m = source.match(/const\s+TASKS_ACTIVE_STATUSES\s*=\s*(\[[^\]]*\])/);
  assert.ok(m, 'TASKS_ACTIVE_STATUSES declaration found in renderer.js');
  // The literal is a simple array of single-quoted strings; JSON-parse after
  // normalising the quotes.
  return JSON.parse(m[1].replace(/'/g, '"'));
}

const ACTIVE = extractActiveStatuses(src);

// The dot decision, mirroring `renderTasksBoard`:
//   if (TASKS_ACTIVE_STATUSES.includes(tk.fm.status)) { ...append dot... }
const shouldShowDot = (status) => ACTIVE.includes(status);

test('TASKS_ACTIVE_STATUSES is exactly the actively-worked states', () => {
  // TASK-006: the BA actively works the `defining` lane, so the actively-worked
  // set is defining/in-progress/testing (previously just in-progress/testing).
  assert.deepEqual([...ACTIVE].sort(), ['defining', 'in-progress', 'testing']);
});

test('the dot is gated on TASKS_ACTIVE_STATUSES.includes(tk.fm.status) in renderTasksBoard', () => {
  // Guards against the dot being wired to something other than the status
  // predicate (e.g. a hardcoded flag), which would break "derived only from status".
  assert.match(src, /TASKS_ACTIVE_STATUSES\.includes\(tk\.fm\.status\)/);
  assert.match(src, /className\s*=\s*'task-card-dot'/);
});

test('working indicator shows for in-progress', () => {
  assert.equal(shouldShowDot('in-progress'), true);
});

test('working indicator shows for testing', () => {
  assert.equal(shouldShowDot('testing'), true);
});

test('working indicator is absent for idle statuses todo / done / failed-testing', () => {
  assert.equal(shouldShowDot('todo'), false);
  assert.equal(shouldShowDot('done'), false);
  assert.equal(shouldShowDot('failed-testing'), false);
});

test('working indicator is absent for an unknown status', () => {
  assert.equal(shouldShowDot('something-else'), false);
  assert.equal(shouldShowDot(undefined), false);
  assert.equal(shouldShowDot(''), false);
});

test('indicator derives purely from status: it clears when status flips in-progress -> done', () => {
  // Models the "indicator clears after work finishes" scenario: the decision is
  // a pure function of the current status, so re-evaluating after the status
  // changes on disk yields false with no other state involved.
  assert.equal(shouldShowDot('in-progress'), true);
  assert.equal(shouldShowDot('done'), false);
});

test('the CSS carries the .task-card-dot rule and its pulse keyframes', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
  assert.match(css, /\.task-card-dot\b/);
  assert.match(css, /@keyframes\s+task-card-dot-pulse/);
});
