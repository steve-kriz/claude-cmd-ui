'use strict';

// E2E cucumber-style scenarios for TASK-122: unify the lib/renderer lane-order
// derivation in formatTasksSummary.
//
// TASK-104 made the tasks-board summary config-aware. The lib formatTasksSummary
// (lib/slack-commands.js) derives its lane order via laneStatusesFor(columns),
// which RE-INJECTS the six system lanes and interleaves user columns; the renderer
// mirror previously used `cols.map(c => c.status)` verbatim, so for a PARTIAL /
// hand-built / reordered columns array the two silently diverged. TASK-122 aligned
// the renderer to the lib by adding the mirror helpers tasksUserSlugSetFor /
// tasksLaneStatusesFor / tasksLaneForStatusFor and routing the formatter through
// them.
//
// The KEY new coverage below is a lib-vs-renderer PARITY test: the ACTUAL shipped
// renderer formatTasksSummary (+ its new mirror helpers) is loaded headless (via
// test/helpers/task-122-summary-harness.js — no browser, no DOM, no IPC, no FS, no
// DB, no network; the functions are pure) and its output is compared byte-for-byte
// against require('../lib/slack-commands').formatTasksSummary for the SAME
// (tickets, columns) across every columns shape the ticket enumerates.
//
// These are the ticket's acceptance criteria expressed as Given/When/Then
// `node --test` cases (no `cucumber` npm package — same scenario layout as the
// other *.e2e.test.js files).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { formatTasksSummary: libFormat } = require('../lib/slack-commands');
const { loadRendererSummary } = require('./helpers/task-122-summary-harness');

const renderer = loadRendererSummary();
const rendererFormat = renderer.formatTasksSummary;

// A representative board touching every routing branch: active (in-progress,
// testing), failed-testing (folds into testing + listed), idle system lanes, a
// user-column status ("review"), and an out-of-enum status ("weird-xyz" → unknown).
const BOARD = [
  { fm: { id: 'TASK-201', title: 'Alpha', status: 'todo' } },
  { fm: { id: 'TASK-202', title: 'Bravo', status: 'in-progress' } },
  { fm: { id: 'TASK-203', title: 'Charlie', status: 'testing' } },
  { fm: { id: 'TASK-204', title: 'Delta', status: 'failed-testing' } },
  { fm: { id: 'TASK-205', title: 'Echo', status: 'done' } },
  { fm: { id: 'TASK-206', title: 'Foxtrot', status: 'review' } },
  { fm: { id: 'TASK-207', title: 'Golf', status: 'weird-xyz' } },
];

// Given the SAME (tickets, columns), When both formatters run, Then their output is
// byte-identical. Returns the (shared) output so a scenario can also assert content.
function assertParity(tickets, columns, message) {
  const r = rendererFormat(tickets, columns);
  const l = libFormat(tickets, columns);
  assert.equal(
    r,
    l,
    `${message}\n--- renderer ---\n${r}\n--- lib ---\n${l}`,
  );
  return r;
}

// ===========================================================================
// Feature: lib/renderer parity for the config-aware tasks-board summary
// ===========================================================================

test('Scenario: null and undefined columns → identical no-config output on both sides', () => {
  // Given a board and no configured columns (null / undefined)
  // When both formatters run
  // Then the two produce byte-identical output for each
  const outNull = assertParity(BOARD, null, 'null columns must match');
  const outUndef = assertParity(BOARD, undefined, 'undefined columns must match');
  // And both degrade to the six fixed system lanes in canonical order
  assert.ok(
    outNull.includes('todo 1 · defining 0 · in-progress 1 · testing 2 · post-processing 0 · done 1'),
    `null → six system lanes, got:\n${outNull}`,
  );
  assert.equal(outNull, outUndef, 'null and undefined columns are equivalent');
});

test('Scenario: an empty columns array degrades to the six system lanes, identically', () => {
  // Given a board and an empty columns array
  // When both formatters run
  const out = assertParity(BOARD, [], 'empty [] columns must match');
  // Then the counts line is the six fixed system lanes
  assert.ok(out.includes('todo 1 · defining 0 · in-progress 1 · testing 2 · post-processing 0 · done 1'));
});

test('Scenario: a PARTIAL system-columns array re-injects the missing lanes (identical)', () => {
  // Given a hand-built columns array MISSING `defining` and `post-processing`
  const partial = [
    { status: 'todo', system: true },
    { status: 'in-progress', system: true },
    { status: 'testing', system: true },
    { status: 'done', system: true },
  ];
  // When both formatters run (this is the exact renderer/lib skew TASK-122 fixes:
  // the old renderer would emit only the four supplied lanes, the lib all six)
  const out = assertParity(BOARD, partial, 'partial system columns must re-inject identically');
  // Then BOTH re-inject the missing lanes in canonical order
  assert.ok(
    out.includes('todo 1 · defining 0 · in-progress 1 · testing 2 · post-processing 0 · done 1'),
    `partial re-injects all six lanes, got:\n${out}`,
  );
});

test('Scenario: partial system columns PLUS a user column interleave identically', () => {
  // Given partial system columns with a `review` user column anchored after in-progress
  const cols = [
    { status: 'todo', system: true },
    { status: 'in-progress', system: true },
    { status: 'review', label: 'Review', system: false },
    { status: 'done', system: true },
  ];
  // When both formatters run
  const out = assertParity(BOARD, cols, 'partial + user column must match');
  // Then the user column is inserted after in-progress and the missing system lanes
  // are still re-injected, using the configured LABEL for the user column
  assert.ok(
    out.includes('todo 1 · defining 0 · in-progress 1 · Review 1 · testing 2 · post-processing 0 · done 1'),
    `user column interleaved with its label, got:\n${out}`,
  );
});

test('Scenario: reordered partial system columns still canonicalise identically', () => {
  // Given system columns supplied OUT of canonical order (done, todo, testing)
  const reordered = [
    { status: 'done', system: true },
    { status: 'todo', system: true },
    { status: 'testing', system: true },
  ];
  // When both formatters run
  const out = assertParity(BOARD, reordered, 'reordered partial columns must match');
  // Then both emit the six lanes in the canonical LANE_STATUSES order (system lanes
  // are re-injected in fixed order regardless of the supplied order)
  assert.ok(
    out.includes('todo 1 · defining 0 · in-progress 1 · testing 2 · post-processing 0 · done 1'),
    `reordered still canonicalises, got:\n${out}`,
  );
});

test('Scenario: a user column declared before todo sorts ahead of todo, identically', () => {
  // Given a `review` user column BEFORE any system column
  const cols = [
    { status: 'review', label: 'Review', system: false },
    { status: 'todo', system: true },
  ];
  // When both formatters run
  const out = assertParity(BOARD, cols, 'user-before-todo must match');
  // Then the user lane sorts ahead of todo (anchor = null)
  assert.ok(
    out.includes('Review 1 · todo 1 · defining 0 · in-progress 1 · testing 2 · post-processing 0 · done 1'),
    `user column sorts before todo, got:\n${out}`,
  );
});

test('Scenario: reserved / invalid user slugs are dropped, identically', () => {
  // Given user columns whose slugs are reserved (unknown, __wont-do__,
  // failed-testing) or filesystem-unsafe (../evil, UPPER) plus one valid (review)
  const cols = [
    { status: 'unknown', system: false },
    { status: '__wont-do__', system: false },
    { status: 'failed-testing', system: false },
    { status: '../evil', system: false },
    { status: 'UPPER', system: false },
    { status: 'review', label: 'Review', system: false },
  ];
  // When both formatters run
  const out = assertParity(BOARD, cols, 'reserved/invalid slugs must be dropped identically');
  // Then only the valid `review` user lane survives; the reserved/unsafe slugs
  // never become lanes, and the out-of-enum ticket still folds into `unknown 1`
  assert.ok(out.includes('Review 1'), `valid user lane kept, got:\n${out}`);
  assert.ok(!out.includes('__wont-do__'), 'reserved __wont-do__ dropped');
  assert.ok(!out.includes('../evil'), 'unsafe slug dropped');
  assert.ok(out.trim().endsWith('unknown 1'), `out-of-enum still routes to unknown, got:\n${out}`);
});

test('Scenario (edge): junk columns never throw and match the no-config output', () => {
  // Given a junk columns array (nulls, numbers, strings, nested arrays, bad shapes)
  const junk = [null, 42, 'x', [], { status: 123 }, { nope: true }];
  // When both formatters run they must not throw
  let out;
  assert.doesNotThrow(() => { out = assertParity(BOARD, junk, 'junk columns must match'); });
  // Then the output equals the no-config six-lane summary
  assert.equal(out, rendererFormat(BOARD, null), 'junk degrades to no-config output');
});

test('Scenario: normalized columns output is BYTE-UNCHANGED vs the pre-change fixed-lane format', () => {
  // Given the fully-normalized six default system columns (today's only real input)
  const normalized = [
    { status: 'todo', label: 'To Do', system: true },
    { status: 'defining', label: 'Defining', system: true },
    { status: 'in-progress', label: 'In Progress', system: true },
    { status: 'testing', label: 'Testing', system: true },
    { status: 'post-processing', label: 'Post-processing', system: true },
    { status: 'done', label: 'Done', system: true },
  ];
  const tickets = [
    { fm: { id: 'TASK-201', title: 'Alpha', status: 'todo' } },
    { fm: { id: 'TASK-202', title: 'Bravo', status: 'in-progress' } },
    { fm: { id: 'TASK-203', title: 'Charlie', status: 'testing' } },
    { fm: { id: 'TASK-204', title: 'Delta', status: 'failed-testing' } },
    { fm: { id: 'TASK-205', title: 'Echo', status: 'done' } },
  ];
  // The historic (pre-TASK-122) fixed-lane summary — raw slugs for system lanes.
  const EXPECTED = [
    '*Currently working on:*',
    'TASK-202 — Bravo (in-progress)',
    'TASK-203 — Charlie (testing)',
    '',
    '*Failed testing:*',
    'TASK-204 — Delta (failed-testing)',
    '',
    'todo 1 · defining 0 · in-progress 1 · testing 2 · post-processing 0 · done 1',
  ].join('\n');
  // When both formatters run
  const out = assertParity(tickets, normalized, 'normalized columns must match lib');
  // Then the output is byte-identical to the historic format
  assert.equal(out, EXPECTED, `normalized output must be byte-unchanged, got:\n${out}`);
});

test('Scenario: the no-config summary (columns omitted) is identical to lib AND to null columns', () => {
  // Given a board and NO columns argument at all
  const rNoArg = rendererFormat(BOARD);
  const lNoArg = libFormat(BOARD);
  // When compared
  // Then renderer == lib, and both equal the explicit-null variant
  assert.equal(rNoArg, lNoArg, 'omitted-columns output identical across lib/renderer');
  assert.equal(rNoArg, rendererFormat(BOARD, null), 'omitted == null columns');
});

test('Scenario (fold): failed-testing folds into the testing lane count and is listed under Failed testing', () => {
  // Given a board with a failed-testing ticket alongside a real testing ticket
  const tickets = [
    { fm: { id: 'TASK-301', title: 'Flaky', status: 'failed-testing' } },
    { fm: { id: 'TASK-302', title: 'Real', status: 'testing' } },
    { fm: { id: 'TASK-303', title: 'Idle', status: 'todo' } },
  ];
  // When both formatters run (partial columns, to also exercise the fold under
  // re-injection)
  const out = assertParity(tickets, [{ status: 'todo', system: true }], 'failed-testing fold must match');
  // Then the failed ticket is listed under Failed testing
  assert.ok(out.includes('*Failed testing:*'), 'has a Failed testing section');
  assert.ok(out.includes('TASK-301 — Flaky (failed-testing)'), 'lists the failed ticket');
  // And it folds into the testing lane count (never its own lane)
  assert.ok(out.includes('testing 2'), `failed-testing counted in testing, got:\n${out}`);
  assert.ok(!out.includes('failed-testing 1'), 'failed-testing is never its own count piece');
});

test('Scenario (edge): "unknown" appears ONLY when an out-of-enum ticket is present', () => {
  // Given a board with NO out-of-enum statuses
  const clean = [
    { fm: { id: 'TASK-401', title: 'A', status: 'todo' } },
    { fm: { id: 'TASK-402', title: 'B', status: 'done' } },
  ];
  // When both formatters run with default columns
  const cleanOut = assertParity(clean, null, 'clean board parity');
  // Then no "unknown" piece is appended
  assert.ok(!/\bunknown \d/.test(cleanOut), `no unknown piece when none out-of-enum, got:\n${cleanOut}`);

  // Given a board WITH an out-of-enum status
  const dirty = clean.concat([{ fm: { id: 'TASK-403', title: 'C', status: 'not-a-real-status' } }]);
  // When both formatters run
  const dirtyOut = assertParity(dirty, null, 'dirty board parity');
  // Then a trailing "unknown 1" piece appears (both sides)
  assert.ok(dirtyOut.trim().endsWith('unknown 1'), `unknown appended when present, got:\n${dirtyOut}`);
});

test('Scenario (edge): empty / null tickets return the empty-board sentinel on both sides', () => {
  // Given no tickets, across several columns shapes
  for (const cols of [undefined, null, [], [{ status: 'todo', system: true }]]) {
    // When both formatters run with an empty board
    const out = assertParity([], cols, 'empty board sentinel must match');
    // Then both return exactly the empty-board sentinel
    assert.equal(out, 'The tasks board is empty.');
  }
  // And a non-array tickets input also degrades identically
  assert.equal(assertParity(null, null, 'null tickets'), 'The tasks board is empty.');
});
