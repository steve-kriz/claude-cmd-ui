'use strict';

// ===========================================================================
// TASK-078 — UNIT tests for the PURE window-attention decision module.
//
// lib/window-attention.js is Electron-free (like lib/keep-awake.js) so it is
// require()-able and unit-testable directly under plain `node --test`. It
// exports shouldRequestAttention({ attentionCount, windowFocused }) → boolean:
//   returns true IFF attentionCount is a finite number > 0 AND
//   windowFocused === false; returns false (never throws) for every other
//   input, including missing/junk (null, undefined, negative, NaN, strings,
//   objects, arrays, Infinity, booleans, focused windows, zero counts).
//
// NO Electron window, NO DB, NO IPC — the module touches none of those. This is
// the pure heart of the feature and is covered here exhaustively.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mod = require('../lib/window-attention.js');
const { shouldRequestAttention } = mod;

// ---------------------------------------------------------------------------
// TASK-084 — unit companion for the pty-exit attention drift guard. The e2e
// suite anchors the pty-exit re-report to the real onExit handler; this unit
// assertion independently confirms the anchoring holds so the guard cannot pass
// if the pty-exit reportWindowAttention() call is deleted. Pure source scan —
// NO Electron, NO DB, NO IPC, NO network.
// ---------------------------------------------------------------------------
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

test('DRIFT GUARD (renderer.js): the pty onExit handler re-reports window attention', () => {
  const rendererSrc = fs.readFileSync(
    path.join(__dirname, '..', 'renderer', 'renderer.js'),
    'utf8',
  );
  const onExitRegion = extractPtyExitHandler(rendererSrc);
  // The call must live INSIDE the onExit handler body, not merely somewhere in
  // the file followed by `});` (TASK-084 anchoring).
  assert.match(
    onExitRegion,
    /reportWindowAttention\(\)/,
    'the pty onExit handler itself calls reportWindowAttention()',
  );
  // Negative control: a mutated source with the call removed from the handler
  // must fail the same anchored check — proving deletion is detectable.
  const mutated = rendererSrc.replace(
    /(window\.api\.pty\.onExit\([\s\S]*?)\n\s*reportWindowAttention\(\);/,
    '$1',
  );
  assert.notEqual(mutated, rendererSrc, 'the mutation removed the pty-exit re-report');
  const mutatedRegion = extractPtyExitHandler(mutated);
  assert.doesNotMatch(
    mutatedRegion,
    /reportWindowAttention\(\)/,
    'removing the pty-exit re-report is caught by the anchored guard',
  );
});

// ---------------------------------------------------------------------------
// TASK-085 — unit companion for the BOARD-POLL attention drift guard. The e2e
// suite anchors the board-poll re-report to the renderTasksBoard function body
// (not the "question/answer state is fresh" comment); this unit assertion
// independently confirms the anchoring: it survives a comment reword and fails
// if the board-poll call is deleted. Pure source scan — NO Electron, NO DB, NO
// IPC, NO network.
// ---------------------------------------------------------------------------
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

test('DRIFT GUARD (renderer.js): the board poll (renderTasksBoard) re-reports window attention — code-anchored (TASK-085)', () => {
  const rendererSrc = fs.readFileSync(
    path.join(__dirname, '..', 'renderer', 'renderer.js'),
    'utf8',
  );
  // The call must live INSIDE renderTasksBoard, independent of any comment.
  const boardBody = extractFn(rendererSrc, 'renderTasksBoard');
  assert.match(
    boardBody,
    /reportWindowAttention\(\)/,
    'renderTasksBoard re-reports window attention (against the real code)',
  );

  // Reword control: mutating the "question/answer state is fresh" comment does
  // NOT break the code-anchored guard (it never read the comment prose).
  const reworded = rendererSrc.replace(
    /question\/answer state is fresh/,
    'ticket q\/a state has been refreshed',
  );
  assert.notEqual(reworded, rendererSrc, 'the reword control changed the comment');
  const rewordedBody = extractFn(reworded, 'renderTasksBoard');
  assert.match(
    rewordedBody,
    /reportWindowAttention\(\)/,
    'rewording the comment does not break the code-anchored guard',
  );

  // Negative control: removing the board-poll call from renderTasksBoard must
  // fail the anchored guard — proving deletion is detectable.
  const mutatedBoardBody = boardBody.replace(/\n\s*reportWindowAttention\(\);/, '');
  assert.notEqual(mutatedBoardBody, boardBody, 'the mutation removed the board-poll call');
  const mutatedSrc = rendererSrc.replace(boardBody, mutatedBoardBody);
  const mutatedRegion = extractFn(mutatedSrc, 'renderTasksBoard');
  assert.doesNotMatch(
    mutatedRegion,
    /reportWindowAttention\(\)/,
    'removing the board-poll re-report is caught by the anchored guard',
  );
});

test('the module exports shouldRequestAttention as a function', () => {
  assert.equal(typeof shouldRequestAttention, 'function', 'exported function present');
});

// --- TRUE only for finite attentionCount > 0 AND windowFocused === false ----

test('TRUE: a positive count with an explicitly unfocused window', () => {
  assert.equal(shouldRequestAttention({ attentionCount: 1, windowFocused: false }), true);
  assert.equal(shouldRequestAttention({ attentionCount: 3, windowFocused: false }), true);
  assert.equal(shouldRequestAttention({ attentionCount: 999, windowFocused: false }), true);
  // Fractional-but-finite positive count still counts (> 0).
  assert.equal(shouldRequestAttention({ attentionCount: 0.5, windowFocused: false }), true);
  // Smallest positive double.
  assert.equal(shouldRequestAttention({ attentionCount: Number.MIN_VALUE, windowFocused: false }), true);
});

// --- FALSE when the window is focused (any positive count) ------------------

test('FALSE: window focused (windowFocused === true) never flashes, regardless of count', () => {
  assert.equal(shouldRequestAttention({ attentionCount: 1, windowFocused: true }), false);
  assert.equal(shouldRequestAttention({ attentionCount: 42, windowFocused: true }), false);
});

// --- FALSE when focus state is not an explicit boolean false ---------------

test('FALSE: an absent/unknown focus state is treated as "do not flash"', () => {
  // windowFocused must be a real boolean false; anything else → false.
  assert.equal(shouldRequestAttention({ attentionCount: 1 }), false, 'missing windowFocused');
  assert.equal(shouldRequestAttention({ attentionCount: 1, windowFocused: undefined }), false);
  assert.equal(shouldRequestAttention({ attentionCount: 1, windowFocused: null }), false);
  assert.equal(shouldRequestAttention({ attentionCount: 1, windowFocused: 0 }), false, 'falsy 0 is not boolean false');
  assert.equal(shouldRequestAttention({ attentionCount: 1, windowFocused: '' }), false, 'falsy "" is not boolean false');
  assert.equal(shouldRequestAttention({ attentionCount: 1, windowFocused: 'false' }), false, 'string is not boolean false');
});

// --- FALSE for zero / negative counts --------------------------------------

test('FALSE: zero or negative attentionCount never flashes', () => {
  assert.equal(shouldRequestAttention({ attentionCount: 0, windowFocused: false }), false);
  assert.equal(shouldRequestAttention({ attentionCount: -0, windowFocused: false }), false);
  assert.equal(shouldRequestAttention({ attentionCount: -1, windowFocused: false }), false);
  assert.equal(shouldRequestAttention({ attentionCount: -1000, windowFocused: false }), false);
  assert.equal(shouldRequestAttention({ attentionCount: Number.MIN_SAFE_INTEGER, windowFocused: false }), false);
});

// --- FALSE for non-finite / non-number counts ------------------------------

test('FALSE: NaN / Infinity / -Infinity counts never flash', () => {
  assert.equal(shouldRequestAttention({ attentionCount: NaN, windowFocused: false }), false);
  assert.equal(shouldRequestAttention({ attentionCount: Infinity, windowFocused: false }), false);
  assert.equal(shouldRequestAttention({ attentionCount: -Infinity, windowFocused: false }), false);
});

test('FALSE: non-number attentionCount (string, object, array, bool, null) never flashes', () => {
  const badCounts = ['1', '5', 'abc', {}, [], [3], true, false, null, undefined, () => 1, Symbol('x')];
  for (const c of badCounts) {
    assert.equal(
      shouldRequestAttention({ attentionCount: c, windowFocused: false }),
      false,
      `count ${String(c)} coerces to a non-flashing false`,
    );
  }
});

// --- FALSE for junk top-level inputs (never throws) ------------------------

test('FALSE + never throws: junk top-level inputs', () => {
  const junk = [null, undefined, 0, 1, -1, NaN, '', 'abc', true, false, () => {}, Symbol('s'), NaN];
  for (const input of junk) {
    let out;
    assert.doesNotThrow(() => { out = shouldRequestAttention(input); }, `input ${String(input)} must not throw`);
    assert.equal(out, false, `junk input ${String(input)} → false`);
  }
});

test('FALSE + never throws: empty object and arrays', () => {
  assert.equal(shouldRequestAttention({}), false, 'empty object → false');
  assert.equal(shouldRequestAttention([]), false, 'array → false (no numeric count)');
  assert.equal(shouldRequestAttention([1, 2]), false, 'array with elements → false');
});

test('never throws for a wide matrix of count × focus inputs', () => {
  const counts = [undefined, null, NaN, Infinity, -Infinity, -1, 0, 1, 2.5, '3', {}, [], true];
  const focuses = [undefined, null, true, false, 0, 1, '', 'false', {}];
  for (const attentionCount of counts) {
    for (const windowFocused of focuses) {
      assert.doesNotThrow(
        () => shouldRequestAttention({ attentionCount, windowFocused }),
        `count=${String(attentionCount)} focus=${String(windowFocused)} must not throw`,
      );
    }
  }
});

test('the ONLY input combination that returns true is finite count > 0 AND windowFocused === false', () => {
  // Exhaustive small truth-table sweep proving the AND of both conditions.
  const rows = [
    [{ attentionCount: 1, windowFocused: false }, true],
    [{ attentionCount: 1, windowFocused: true }, false],
    [{ attentionCount: 0, windowFocused: false }, false],
    [{ attentionCount: 0, windowFocused: true }, false],
    [{ attentionCount: -1, windowFocused: false }, false],
    [{ attentionCount: NaN, windowFocused: false }, false],
    [{ attentionCount: 5, windowFocused: false }, true],
    [{ attentionCount: 5, windowFocused: undefined }, false],
  ];
  for (const [input, expected] of rows) {
    assert.equal(shouldRequestAttention(input), expected, JSON.stringify(input) + ` → ${expected}`);
  }
});
