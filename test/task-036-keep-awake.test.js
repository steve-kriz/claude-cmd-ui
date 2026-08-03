'use strict';

// ===========================================================================
// TASK-036 — UNIT tests for lib/keep-awake.js (the PURE, Electron-free decision
// half of "keep the laptop awake while orchestrate tasks run").
//
// This file exercises the REAL lib helper directly (require()'d below). No
// Electron, no powerSaveBlocker, no DB, no disk, no network — the module is pure.
// The wake-lock manager (main.js, Electron-coupled) is covered by the companion
// e2e file test/task-036-keep-awake.e2e.test.js.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Execute the REAL library (yes — no mock of the decision logic).
const keepAwake = require('../lib/keep-awake');
const {
  KEEP_AWAKE_STATUSES,
  isKeepAwakeStatus,
  keepAwakeCount,
  shouldKeepAwake,
} = keepAwake;

// The canonical status enum this module derives from — used to prove the
// keep-awake set stays in lockstep rather than hardcoding strings.
const { ACTIVE_STATUSES } = require('../lib/ticket-lanes');

// ---------------------------------------------------------------------------
// KEEP_AWAKE_STATUSES — derived set: active statuses (post-processing removed).
// ---------------------------------------------------------------------------
test('KEEP_AWAKE_STATUSES is ACTIVE_STATUSES exactly (derived, not hardcoded)', () => {
  assert.deepEqual(KEEP_AWAKE_STATUSES, [...ACTIVE_STATUSES]);
  // The documented literal value.
  assert.deepEqual(KEEP_AWAKE_STATUSES, ['defining', 'in-progress', 'testing']);
});

test('KEEP_AWAKE_STATUSES includes every active status', () => {
  for (const s of ['defining', 'in-progress', 'testing']) {
    assert.ok(KEEP_AWAKE_STATUSES.includes(s), `${s} keeps the machine awake`);
  }
});

test('KEEP_AWAKE_STATUSES excludes idle statuses (done / todo / failed-testing)', () => {
  for (const s of ['done', 'todo', 'failed-testing']) {
    assert.ok(!KEEP_AWAKE_STATUSES.includes(s), `${s} does NOT keep the machine awake`);
  }
});

// ---------------------------------------------------------------------------
// isKeepAwakeStatus(status)
// ---------------------------------------------------------------------------
test('isKeepAwakeStatus is true for keep-awake statuses', () => {
  assert.equal(isKeepAwakeStatus('defining'), true);
  assert.equal(isKeepAwakeStatus('in-progress'), true);
  assert.equal(isKeepAwakeStatus('testing'), true);
});

test('isKeepAwakeStatus is false for idle / unknown / post-processing / junk statuses', () => {
  assert.equal(isKeepAwakeStatus('todo'), false);
  assert.equal(isKeepAwakeStatus('done'), false);
  assert.equal(isKeepAwakeStatus('failed-testing'), false);
  assert.equal(isKeepAwakeStatus('post-processing'), false, 'post-processing no longer kept awake');
  assert.equal(isKeepAwakeStatus('unknown'), false);
  assert.equal(isKeepAwakeStatus(''), false);
  assert.equal(isKeepAwakeStatus(undefined), false);
  assert.equal(isKeepAwakeStatus(null), false);
  assert.equal(isKeepAwakeStatus(42), false);
});

// ---------------------------------------------------------------------------
// keepAwakeCount(tickets) — counts keep-awake tickets, unwraps {fm}, junk -> 0.
// ---------------------------------------------------------------------------
test('keepAwakeCount counts bare-fm tickets in keep-awake statuses', () => {
  const tickets = [
    { status: 'defining' },
    { status: 'in-progress' },
    { status: 'testing' },
    { status: 'post-processing' },  // no longer kept awake
    { status: 'todo' },
    { status: 'done' },
    { status: 'failed-testing' },
  ];
  assert.equal(keepAwakeCount(tickets), 3);
});

test('keepAwakeCount unwraps the board\'s { fm } wrapper idiom', () => {
  const tickets = [
    { fm: { status: 'in-progress' } },     // active, kept awake
    { fm: { status: 'done' } },            // idle, not kept awake
    { fm: { status: 'post-processing' } }, // not kept awake
  ];
  assert.equal(keepAwakeCount(tickets), 1);
});

test('keepAwakeCount tolerates mixed wrapped/bare entries and null/holey members', () => {
  const tickets = [
    { fm: { status: 'testing' } }, // wrapped, active
    { status: 'defining' },        // bare, active
    null,                          // junk member
    { fm: null },                  // holey wrapper
    {},                            // no status
    { status: 'todo' },            // idle
  ];
  assert.equal(keepAwakeCount(tickets), 2);
});

test('keepAwakeCount returns 0 for an empty array and for non-array / junk input', () => {
  assert.equal(keepAwakeCount([]), 0);
  assert.equal(keepAwakeCount(null), 0);
  assert.equal(keepAwakeCount(undefined), 0);
  assert.equal(keepAwakeCount('nope'), 0);
  assert.equal(keepAwakeCount(7), 0);
  assert.equal(keepAwakeCount({ status: 'defining' }), 0); // a bare object is not an array
});

// ---------------------------------------------------------------------------
// shouldKeepAwake(input) — accepts a NUMBER (active count) OR a ticket ARRAY.
// Never throws.
// ---------------------------------------------------------------------------
test('shouldKeepAwake(number): >0 is true, 0 is false', () => {
  assert.equal(shouldKeepAwake(1), true);
  assert.equal(shouldKeepAwake(5), true);
  assert.equal(shouldKeepAwake(0), false);
});

test('shouldKeepAwake(number): NaN / negative numbers are false', () => {
  assert.equal(shouldKeepAwake(NaN), false);
  assert.equal(shouldKeepAwake(-1), false);
  assert.equal(shouldKeepAwake(-99), false);
});

test('shouldKeepAwake(Infinity) is false (requires a finite positive count)', () => {
  assert.equal(shouldKeepAwake(Infinity), false);
  assert.equal(shouldKeepAwake(-Infinity), false);
});

test('shouldKeepAwake(non-number junk) never throws and is false', () => {
  assert.equal(shouldKeepAwake(null), false);
  assert.equal(shouldKeepAwake(undefined), false);
  assert.equal(shouldKeepAwake('3'), false);       // a string, not a number, treated as ticket list -> not array -> 0
  assert.equal(shouldKeepAwake('junk'), false);
  assert.equal(shouldKeepAwake({}), false);
  assert.equal(shouldKeepAwake(true), false);
});

test('shouldKeepAwake(ticket array): any keep-awake status -> true', () => {
  assert.equal(shouldKeepAwake([{ status: 'todo' }, { status: 'testing' }]), true);
});

test('shouldKeepAwake(ticket array): all idle or empty -> false', () => {
  assert.equal(shouldKeepAwake([{ status: 'todo' }, { status: 'done' }, { status: 'failed-testing' }]), false);
  assert.equal(shouldKeepAwake([]), false);
});

test('shouldKeepAwake(ticket array): post-processing (TASK-206, removed as a status) never holds the wake-lock', () => {
  assert.equal(shouldKeepAwake([{ fm: { status: 'post-processing' } }]), false,
    'a post-processing ticket no longer keeps the machine awake');
});

test('shouldKeepAwake never throws on hostile input', () => {
  assert.doesNotThrow(() => shouldKeepAwake([null, undefined, {}, { fm: null }]));
  assert.doesNotThrow(() => shouldKeepAwake(Symbol ? undefined : 0));
  assert.equal(shouldKeepAwake([null, undefined, {}, { fm: null }]), false);
});

// ---------------------------------------------------------------------------
// TASK-049 — the renderer-gone/unresponsive reset. main.js's handlers call
// updateKeepAwake(0), and updateKeepAwake delegates the yes/no to the REAL
// shouldKeepAwake here. These unit tests pin the DECISION half of that reset:
// the count-0 reset always decides "release", repeated resets stay released
// (rapid reload never re-engages on its own), and a later positive re-report
// decides "hold again" (recovery). The manager wiring is exercised e2e.
// ---------------------------------------------------------------------------
test('TASK-049: the renderer-gone reset (updateKeepAwake(0)) decides release — shouldKeepAwake(0) is false', () => {
  // This is exactly what the render-process-gone / unresponsive handlers evaluate.
  assert.equal(shouldKeepAwake(0), false, 'a reset count of 0 releases the wake-lock');
});

test('TASK-049: repeated resets stay released (rapid reload never self-re-engages)', () => {
  // Each rapid render-process-gone fires updateKeepAwake(0) again; the decision
  // must remain "release" every time so no lock is ever re-held without a report.
  for (let i = 0; i < 5; i++) {
    assert.equal(shouldKeepAwake(0), false, `reset #${i + 1} stays released`);
  }
});

test('TASK-049: recovery — a positive re-report after a reset decides hold-again', () => {
  // Given the lock was released by a reset (count 0 -> false)
  assert.equal(shouldKeepAwake(0), false);
  // When the reloaded renderer re-reports a positive active count
  // Then the decision flips back to "hold" so the lock re-engages.
  assert.equal(shouldKeepAwake(1), true, 'a positive re-report re-engages the wake-lock');
  assert.equal(shouldKeepAwake(5), true);
});

test('TASK-049: a junk/NaN report during the gone->recovery window still decides release', () => {
  // A garbled report arriving before a clean positive count must NOT re-engage.
  for (const junk of [NaN, -1, Infinity, null, undefined, 'nope', {}]) {
    assert.equal(shouldKeepAwake(junk), false, `junk report ${String(junk)} stays released`);
  }
});

// ===========================================================================
// TASK-050 — UNIT tests for the keepAwakeActive() drift-guard LOGIC.
//
// The companion e2e file pins the real main.js keepAwakeActive body via a
// reusable assertion helper. These unit tests exercise that guard LOGIC in
// isolation: the three load-bearing tokens (blockerId !== null check,
// isStarted(keepAwakeBlockerId) call, try/catch wrapping) accept the real
// region and reject constant-return / no-try/catch mutants. No Electron, no
// powerSaveBlocker, no DB, no network — main.js is read as text only.
// ===========================================================================

// The guard-assertion logic under unit test — mirrors the e2e helper. Given a
// slice of source, it asserts keepAwakeActive is wired to check the stored id,
// call isStarted, and swallow throws via try/catch. Throws on any missing token.
function assertKeepAwakeActiveWiring(region) {
  assert.match(region, /keepAwakeBlockerId !== null/,
    'keepAwakeActive checks the stored blocker id is not null');
  assert.match(region, /powerSaveBlocker\.isStarted\(keepAwakeBlockerId\)/,
    'keepAwakeActive calls powerSaveBlocker.isStarted(keepAwakeBlockerId)');
  assert.match(region, /try \{/, 'keepAwakeActive wraps the isStarted call in try');
  assert.match(region, /catch[^]*return false;/,
    'keepAwakeActive swallows a throw and returns false');
}

// Slice the keepAwakeActive() region head -> next-function marker, BOUNDED
// (TASK-054). String.indexOf returns -1 when the end marker `function
// startKeepAwake` is missing/renamed; slice(start, -1) would then balloon into
// nearly the rest of main.js, where startKeepAwake/stopKeepAwake repeat the very
// tokens this guard asserts (blockerId !== null, isStarted(keepAwakeBlockerId),
// try/catch) and could false-pass a gutted keepAwakeActive. So we assert the end
// marker is present and follows the head BEFORE slicing — a missing marker throws
// instead of expanding the region.
function sliceKeepAwakeActiveRegion(src) {
  const start = src.indexOf('function keepAwakeActive');
  assert.notEqual(start, -1, 'main.js has a keepAwakeActive function');
  const end = src.indexOf('function startKeepAwake');
  assert.notEqual(end, -1,
    'the keepAwakeActive region end marker (function startKeepAwake) is present ' +
    '— without it the slice would balloon into the rest of main.js');
  assert.ok(end > start, 'the end marker follows the keepAwakeActive head');
  return src.slice(start, end);
}

// Slice the real keepAwakeActive() region once (head -> bounded end marker).
const MAIN_SRC = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const KEEP_AWAKE_ACTIVE_REGION = sliceKeepAwakeActiveRegion(MAIN_SRC);

test('TASK-050 unit: the guard accepts the real keepAwakeActive region', () => {
  assert.ok(KEEP_AWAKE_ACTIVE_REGION.length > 0, 'a keepAwakeActive region was sliced');
  assert.doesNotThrow(() => assertKeepAwakeActiveWiring(KEEP_AWAKE_ACTIVE_REGION),
    'the real region has all three load-bearing tokens');
});

test('TASK-050 unit: the guard rejects a constant-return mutant', () => {
  const constantReturn = 'function keepAwakeActive() {\n  return false;\n}\n';
  assert.throws(() => assertKeepAwakeActiveWiring(constantReturn),
    'a constant-return keepAwakeActive is rejected');
});

test('TASK-050 unit: the guard rejects a mutant that drops its try/catch', () => {
  const noTryCatch =
    'function keepAwakeActive() {\n' +
    '  return keepAwakeBlockerId !== null\n' +
    '    && !!powerSaveBlocker\n' +
    '    && powerSaveBlocker.isStarted(keepAwakeBlockerId);\n' +
    '}\n';
  assert.throws(() => assertKeepAwakeActiveWiring(noTryCatch),
    'a keepAwakeActive without try/catch is rejected');
});

test('TASK-050 unit: the guard rejects a mutant that drops the isStarted call', () => {
  const noIsStarted =
    'function keepAwakeActive() {\n' +
    '  try {\n' +
    '    return keepAwakeBlockerId !== null;\n' +
    '  } catch (_) {\n' +
    '    return false;\n' +
    '  }\n' +
    '}\n';
  assert.throws(() => assertKeepAwakeActiveWiring(noIsStarted),
    'a keepAwakeActive that never asks the OS isStarted is rejected');
});

test('TASK-054 unit: a missing end marker fails the slice instead of ballooning the region', () => {
  // Given an in-memory copy of main.js with the end marker `function
  // startKeepAwake` renamed away (as a rename/removal would leave it).
  const mutant = MAIN_SRC.replace('function startKeepAwake', 'function startKeepDrowsy');
  assert.ok(mutant.indexOf('function startKeepAwake') === -1,
    'the mutation actually removed the end marker');

  // When/Then the bounded slice FAILS rather than silently absorbing the rest of
  // main.js (where startKeepAwake/stopKeepAwake repeat the guarded tokens and
  // could false-pass a gutted keepAwakeActive).
  assert.throws(() => sliceKeepAwakeActiveRegion(mutant),
    'a missing end marker is caught, not silently sliced to end-of-file');

  // And (not vacuous): the real source still slices to a bounded region that the
  // wiring guard accepts.
  assert.doesNotThrow(() => sliceKeepAwakeActiveRegion(MAIN_SRC),
    'the real main.js still yields a bounded keepAwakeActive region');
  assert.ok(KEEP_AWAKE_ACTIVE_REGION.indexOf('function startKeepAwake') === -1,
    'the bounded region stops before startKeepAwake');
  assert.doesNotThrow(() => assertKeepAwakeActiveWiring(KEEP_AWAKE_ACTIVE_REGION),
    'the real bounded region satisfies the wiring guard');
});

// ===========================================================================
// TASK-053 — UNIT tests for the bounded webContents-handler slice LOGIC.
//
// The companion e2e file uses sliceWcHandler(src, event) to bound the
// render-process-gone drift-guard slice to its OWN handler (ending at the NEXT
// wc.on( registration) instead of a fixed +N-char window, so the gone guard
// cannot be satisfied by the unresponsive handler's updateKeepAwake(0). These
// unit tests exercise that slicing/boundary logic in isolation on synthetic
// source, plus the gone-only-removal fail-mode, without touching Electron/OS/DB.
// ===========================================================================

// The slice logic under unit test — mirrors the e2e helper. Slices one wc.on
// handler bounded by the START of the next wc.on( (or end-of-source).
function sliceWcHandler(src, event) {
  const start = src.indexOf(`wc.on('${event}'`);
  if (start === -1) return null;
  const nextBoundary = src.indexOf('wc.on(', start + 1);
  const end = nextBoundary === -1 ? src.length : nextBoundary;
  return src.slice(start, end);
}

// A synthetic two-handler source: gone handler has NO reset of its own; the
// following unresponsive handler DOES. A fixed +N window would bleed into it.
const SYNTHETIC_NO_GONE_RESET =
  "  wc.on('render-process-gone', (_e, details) => {\n" +
  "    console.error('[renderer crashed]', details);\n" +
  "  });\n" +
  "  wc.on('unresponsive', () => {\n" +
  "    updateKeepAwake(0);\n" +
  "  });\n";

// A synthetic source where BOTH handlers reset (the correct shape).
const SYNTHETIC_BOTH_RESET =
  "  wc.on('render-process-gone', (_e, details) => {\n" +
  "    updateKeepAwake(0);\n" +
  "  });\n" +
  "  wc.on('unresponsive', () => {\n" +
  "    updateKeepAwake(0);\n" +
  "  });\n";

test('TASK-053 unit: sliceWcHandler bounds a handler at the NEXT wc.on( registration', () => {
  const gone = sliceWcHandler(SYNTHETIC_BOTH_RESET, 'render-process-gone');
  assert.ok(gone !== null, 'the gone handler is found');
  // The slice must not reach into the sibling handler.
  assert.doesNotMatch(gone, /wc\.on\('unresponsive'/,
    'the gone slice ends before the unresponsive registration');
  // The unresponsive slice is its own tail region.
  const unresp = sliceWcHandler(SYNTHETIC_BOTH_RESET, 'unresponsive');
  assert.match(unresp, /wc\.on\('unresponsive'/, 'the unresponsive slice starts at its own handler');
});

test('TASK-053 unit: sliceWcHandler returns null for a missing event', () => {
  assert.equal(sliceWcHandler(SYNTHETIC_BOTH_RESET, 'no-such-event'), null);
});

test('TASK-053 unit: sliceWcHandler runs to end-of-source when no next wc.on( follows', () => {
  const src = "  wc.on('render-process-gone', () => { updateKeepAwake(0); });\n";
  const gone = sliceWcHandler(src, 'render-process-gone');
  assert.match(gone, /updateKeepAwake\(0\);/, 'the sole handler is sliced to EOF');
});

test('TASK-053 unit (fail-mode): removing the reset from ONLY the gone handler makes the gone slice miss updateKeepAwake(0)', () => {
  // Given the gone handler has no reset but the unresponsive one does...
  const gone = sliceWcHandler(SYNTHETIC_NO_GONE_RESET, 'render-process-gone');
  const unresp = sliceWcHandler(SYNTHETIC_NO_GONE_RESET, 'unresponsive');
  // ...the bounded gone slice must NOT match (the guard FAILS as intended —
  // a fixed +N window would have falsely passed by borrowing unresponsive's).
  assert.doesNotMatch(gone, /updateKeepAwake\(0\);/,
    'the gone guard fails when its own reset is gone (no bleed into unresponsive)');
  // ...while the unresponsive handler still resets (mutation was gone-scoped).
  assert.match(unresp, /updateKeepAwake\(0\);/,
    'the unresponsive handler still resets');
});

test('TASK-053 unit: the bounded slice logic accepts the real main.js gone/unresponsive handlers', () => {
  // Not vacuous: the real (unmutated) main.js has both handlers each with their
  // own updateKeepAwake(0), and the gone slice stops before unresponsive.
  const gone = sliceWcHandler(MAIN_SRC, 'render-process-gone');
  const unresp = sliceWcHandler(MAIN_SRC, 'unresponsive');
  assert.ok(gone !== null && unresp !== null, 'both handlers exist in real main.js');
  assert.match(gone, /updateKeepAwake\(0\);/, 'real gone handler resets keep-awake to 0');
  assert.match(unresp, /updateKeepAwake\(0\);/, 'real unresponsive handler resets keep-awake to 0');
  assert.doesNotMatch(gone, /wc\.on\('unresponsive'/,
    'the real gone slice is bounded before the unresponsive handler');
});
