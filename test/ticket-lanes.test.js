'use strict';

// Unit + cucumber-style tests for TASK-006/028: the `defining` lane between
// `todo` and `in-progress`, the six-lane board enum
//   todo → defining → in-progress → testing → post-processing → done
// the red per-ticket "failed" marker (failed-testing folds into Testing), and
// graceful handling of unknown statuses.
//
// Two things are under test:
//
//   1. lib/ticket-lanes.js — the Electron-free, pure lane/status logic
//      (LANE_STATUSES, ACTIVE_STATUSES, FAILED_STATUS, UNKNOWN_STATUS,
//      laneForStatus + predicates). The module touches no disk/DB/network/
//      Electron, so it is exercised directly with plain `node --test`.
//
//   2. renderer/renderer.js's browser-side board wiring and renderer/index.html /
//      renderer/styles.css. renderer.js is a browser script (no module.exports,
//      references `document`) so — matching test/tasks-working-indicator.test.js,
//      test/ticket-queue.test.js and test/ticket-questions.test.js — the routing
//      + red-marker decision is proven both by a VERBATIM copy of the routing/dot
//      logic (behavioural contract) and by asserting the real source mirrors the
//      lib constants, the DOM carries the lanes in order, and the CSS carries the
//      red failed rule.
//
// NO DATABASE, FILESYSTEM (beyond reading the app's own source as a fixture), OR
// NETWORK CALL IS MADE. The "board" the scenarios render against is a plain
// in-memory array of tickets — all DB/disk access is mocked away by construction.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  LANE_STATUSES,
  VALID_STATUSES,
  ACTIVE_STATUSES,
  FAILED_STATUS,
  POST_PROCESSING_STATUS,
  POST_PROCESSING_KIND,
  UNKNOWN_STATUS,
  isKnownStatus,
  isActiveStatus,
  isFailedStatus,
  isPostProcessingTicket,
  laneForStatus,
} = require('../lib/ticket-lanes');

const RENDERER = path.join(__dirname, '..', 'renderer', 'renderer.js');
const INDEX_HTML = path.join(__dirname, '..', 'renderer', 'index.html');
const STYLES = path.join(__dirname, '..', 'renderer', 'styles.css');
const rendererSrc = fs.readFileSync(RENDERER, 'utf8');
const htmlSrc = fs.readFileSync(INDEX_HTML, 'utf8');
const cssSrc = fs.readFileSync(STYLES, 'utf8');

// ---------------------------------------------------------------------------
// Unit tests: lib/ticket-lanes.js pure logic
// ---------------------------------------------------------------------------

test('LANE_STATUSES is the six-value enum in canonical left-to-right order', () => {
  assert.deepEqual(LANE_STATUSES, [
    'todo', 'defining', 'in-progress', 'testing', 'post-processing', 'done',
  ]);
});

test('the defining lane sits between todo and in-progress', () => {
  const todo = LANE_STATUSES.indexOf('todo');
  const defining = LANE_STATUSES.indexOf('defining');
  const inProgress = LANE_STATUSES.indexOf('in-progress');
  assert.ok(defining > todo && defining < inProgress,
    'defining is ordered strictly after todo and before in-progress');
});

test('ACTIVE_STATUSES covers defining/in-progress/testing (BA now works defining)', () => {
  assert.deepEqual([...ACTIVE_STATUSES].sort(), ['defining', 'in-progress', 'testing']);
  // Idle states are never "active".
  for (const s of ['todo', 'done', 'failed-testing']) {
    assert.equal(isActiveStatus(s), false, `${s} is not active`);
  }
});

test('FAILED_STATUS is failed-testing and isFailedStatus recognizes only it', () => {
  assert.equal(FAILED_STATUS, 'failed-testing');
  assert.equal(isFailedStatus('failed-testing'), true);
  for (const s of ['todo', 'defining', 'in-progress', 'testing', 'done', 'bogus', undefined]) {
    assert.equal(isFailedStatus(s), false, `${s} is not the failed status`);
  }
});

test('UNKNOWN_STATUS is a dedicated lane key, distinct from every enum value', () => {
  assert.equal(UNKNOWN_STATUS, 'unknown');
  assert.ok(!LANE_STATUSES.includes(UNKNOWN_STATUS),
    'unknown is not one of the six canonical statuses');
});

test('isKnownStatus is true for each enum value and false otherwise', () => {
  for (const s of LANE_STATUSES) assert.equal(isKnownStatus(s), true, `${s} known`);
  for (const s of ['bogus', 'Todo', 'in progress', '', undefined, null]) {
    assert.equal(isKnownStatus(s), false, `${JSON.stringify(s)} not known`);
  }
});

test('parser recognizes `defining` as a first-class known status', () => {
  assert.equal(isKnownStatus('defining'), true);
  assert.equal(laneForStatus('defining'), 'defining');
});

test('laneForStatus maps every known status to its own lane', () => {
  for (const s of LANE_STATUSES) {
    assert.equal(laneForStatus(s), s, `${s} routes to its own lane`);
  }
});

test('laneForStatus routes an unknown status to the unknown lane, NOT todo', () => {
  for (const s of ['bogus', 'in progress', 'TODO', '', undefined, null, 42]) {
    assert.equal(laneForStatus(s), UNKNOWN_STATUS,
      `${JSON.stringify(s)} routes to unknown`);
    assert.notEqual(laneForStatus(s), 'todo',
      `${JSON.stringify(s)} must not be silently dumped into todo`);
  }
});

// --- TASK-028: post-processing lane/status + failed-testing folding ---------

test('POST_PROCESSING_STATUS and POST_PROCESSING_KIND are both "post-processing"', () => {
  assert.equal(POST_PROCESSING_STATUS, 'post-processing');
  assert.equal(POST_PROCESSING_KIND, 'post-processing');
});

test('post-processing is a lane status; failed-testing is valid but NOT a lane', () => {
  assert.ok(LANE_STATUSES.includes('post-processing'), 'post-processing owns a lane');
  assert.ok(!LANE_STATUSES.includes('failed-testing'), 'failed-testing has no dedicated lane');
  assert.ok(VALID_STATUSES.includes('failed-testing'), 'failed-testing is still a valid status');
});

test('VALID_STATUSES is the seven-value superset (lanes + failed-testing)', () => {
  assert.deepEqual([...VALID_STATUSES].sort(), [
    'defining', 'done', 'failed-testing', 'in-progress', 'post-processing', 'testing', 'todo',
  ]);
  // Exactly LANE_STATUSES plus the single extra failed-testing status.
  assert.deepEqual(VALID_STATUSES, [...LANE_STATUSES, 'failed-testing']);
});

test('isKnownStatus is true for failed-testing AND post-processing (never routed to unknown)', () => {
  assert.equal(isKnownStatus('failed-testing'), true);
  assert.equal(isKnownStatus('post-processing'), true);
  for (const s of VALID_STATUSES) assert.equal(isKnownStatus(s), true, `${s} known`);
});

test('laneForStatus folds failed-testing into testing and keeps post-processing distinct', () => {
  assert.equal(laneForStatus('failed-testing'), 'testing', 'failed-testing folds into testing');
  assert.equal(laneForStatus('post-processing'), 'post-processing');
  assert.notEqual(laneForStatus('failed-testing'), 'todo', 'failed cards never dumped into todo');
  assert.notEqual(laneForStatus('failed-testing'), UNKNOWN_STATUS);
});

test('post-processing is NOT an active status (no blue "being worked on" dot)', () => {
  assert.equal(isActiveStatus('post-processing'), false);
  assert.ok(!ACTIVE_STATUSES.includes('post-processing'));
});

test('isPostProcessingTicket is true only when kind === "post-processing"', () => {
  assert.equal(isPostProcessingTicket({ kind: 'post-processing' }), true);
  assert.equal(isPostProcessingTicket({ fm: { kind: 'post-processing' } }), true, 'accepts { fm } wrapper');
  // Status is irrelevant — only the kind decides.
  assert.equal(isPostProcessingTicket({ status: 'todo', kind: 'post-processing' }), true);
  assert.equal(isPostProcessingTicket({ status: 'post-processing' }), false, 'status alone does not make it a recipe');
  for (const bad of [{}, { kind: '' }, { kind: 'other' }, null, undefined]) {
    assert.equal(isPostProcessingTicket(bad), false, `not a post-processing ticket: ${JSON.stringify(bad)}`);
  }
});

// ---------------------------------------------------------------------------
// Source-scanning guards: the browser side must mirror the lib constants,
// carry the lanes in order in the DOM, and carry the red failed CSS rule.
// (renderer.js is not require()-able, so we assert against its source.)
// ---------------------------------------------------------------------------

test('renderer.js mirrors the six-value LANE_STATUSES enum in order', () => {
  const m = rendererSrc.match(/const\s+TASKS_LANE_STATUSES\s*=\s*(\[[^\]]*\])/);
  assert.ok(m, 'TASKS_LANE_STATUSES declared in renderer.js');
  assert.deepEqual(JSON.parse(m[1].replace(/'/g, '"')), LANE_STATUSES);
});

test('renderer.js mirrors ACTIVE_STATUSES, FAILED_STATUS and UNKNOWN_STATUS', () => {
  const active = rendererSrc.match(/const\s+TASKS_ACTIVE_STATUSES\s*=\s*(\[[^\]]*\])/);
  assert.ok(active, 'TASKS_ACTIVE_STATUSES declared');
  assert.deepEqual(
    JSON.parse(active[1].replace(/'/g, '"')).sort(),
    [...ACTIVE_STATUSES].sort());
  assert.match(rendererSrc, /const\s+TASKS_FAILED_STATUS\s*=\s*'failed-testing'/);
  assert.match(rendererSrc, /const\s+TASKS_UNKNOWN_STATUS\s*=\s*'unknown'/);
});

test('index.html declares every lane as a data-status column, defining after todo', () => {
  const order = [...htmlSrc.matchAll(/class="tasks-lane[^"]*"\s+data-status="([^"]+)"/g)]
    .map((mm) => mm[1]);
  // The six enum lanes appear in canonical order, followed by the unknown lane.
  assert.deepEqual(order, [...LANE_STATUSES, UNKNOWN_STATUS]);
});

test('the red failed marker rule (.task-card-dot.failed) exists and is red', () => {
  assert.match(cssSrc, /\.task-card-dot\.failed\s*\{[^}]*background:\s*#f14c4c/i);
});

test('renderer.js wires the red dot to the failed status and appends it as a card marker', () => {
  // The failed decision is derived from status, and the red marker is the
  // `failed` class on the card dot.
  assert.match(rendererSrc, /tk\.fm\.status\s*===\s*TASKS_FAILED_STATUS/);
  assert.match(rendererSrc, /failed\s*\?\s*' failed'/);
});

test('the new-ticket flow still creates tickets with status todo', () => {
  // Guards the "New tickets are created in todo" scenario at the source: the
  // new-task modal defaults the mode's status to 'todo' (TASK-028 parameterised
  // the opener; the toolbar button passes no mode, so it still creates a todo
  // ticket with no kind).
  assert.match(rendererSrc, /mode\.status\s*\|\|\s*'todo'/);
});

// ===========================================================================
// Feature: Task flow with a defining lane and red failed marker
//
// Cucumber-style e2e scenarios from tasks/TASK-006, implemented against the
// pure lib logic + a VERBATIM copy of renderer.js's board-routing / card-dot
// decision. No DB/filesystem/network is touched: the "board" is an in-memory
// array and every DB access is mocked away by construction.
// ===========================================================================

// The six board lanes plus the dedicated unknown lane, exactly mirroring the DOM
// columns (index.html). This stands in for the rendered board's lane set.
// `failed-testing` is deliberately NOT a board lane — it folds into Testing.
const BOARD_LANES = [...LANE_STATUSES, UNKNOWN_STATUS];

// VERBATIM copy of renderTasksBoard's per-ticket routing + dot decision
// (renderer/renderer.js). Returns the placement so scenarios can assert where a
// card lands and what marker it shows, without a DOM. failed-testing folds into
// the Testing lane (TASK-028); out-of-enum statuses route to the unknown lane.
const TASKS_LANE_STATUSES = [...LANE_STATUSES];
const TASKS_VALID_STATUSES = [...LANE_STATUSES, FAILED_STATUS];
const TASKS_ACTIVE_STATUSES = [...ACTIVE_STATUSES];
const TASKS_FAILED_STATUS = FAILED_STATUS;
const TASKS_UNKNOWN_STATUS = UNKNOWN_STATUS;

function placeCard(fm, lanesPresent) {
  const unknown = !TASKS_VALID_STATUSES.includes(fm.status);
  let laneKey;
  if (unknown) laneKey = TASKS_UNKNOWN_STATUS;
  else if (fm.status === TASKS_FAILED_STATUS) laneKey = 'testing';
  else laneKey = fm.status;
  if (!lanesPresent.includes(laneKey)) laneKey = 'todo';
  const failed = fm.status === TASKS_FAILED_STATUS;
  const active = TASKS_ACTIVE_STATUSES.includes(fm.status);
  let dot = null;
  if (failed || active) {
    dot = { className: 'task-card-dot' + (failed ? ' failed' : '') };
  }
  return {
    laneKey,
    unknown,
    cardClass: 'task-card' + (unknown ? ' unknown-status' : ''),
    dot,
  };
}

// Render an in-memory board: {laneKey: [ticketIds]}. Pure — mocks the DOM.
function renderBoard(tickets) {
  const board = {};
  for (const lane of BOARD_LANES) board[lane] = [];
  for (const tk of tickets) {
    const placed = placeCard(tk, BOARD_LANES);
    board[placed.laneKey].push(tk.id);
  }
  return board;
}

test('Scenario: The defining lane sits between todo and in-progress', () => {
  // Then the lane order left-to-right is the six-lane board enum
  assert.deepEqual(BOARD_LANES.slice(0, 6),
    ['todo', 'defining', 'in-progress', 'testing', 'post-processing', 'done']);
});

test('Scenario: New tickets are created in todo', () => {
  // When the user creates a new ticket (mirroring the new-task modal frontmatter)
  const now = '2026-07-18T00:00:00.000Z';
  const fm = { id: 'TASK-999', title: 'A fresh ticket', status: 'todo', created: now, updated: now };
  // Then the ticket's status is "todo"
  assert.equal(fm.status, 'todo');
  // And it lands in the todo lane, recognized (not unknown).
  const placed = placeCard(fm, BOARD_LANES);
  assert.equal(placed.laneKey, 'todo');
  assert.equal(placed.unknown, false);
  // And the source new-ticket flow defaults the mode's status to the same value
  // (TASK-028 parameterised the opener; the toolbar button passes no mode).
  assert.match(rendererSrc, /mode\.status\s*\|\|\s*'todo'/);
});

test('Scenario: A defining ticket lands in the defining lane', () => {
  // Given a ticket has status "defining"
  const fm = { id: 'TASK-1', status: 'defining' };
  const placed = placeCard(fm, BOARD_LANES);
  // Then its card appears in the "defining" lane
  assert.equal(placed.laneKey, 'defining');
  // and is not unknown
  assert.equal(placed.unknown, false);
  assert.equal(placed.cardClass, 'task-card');
  // and not in todo
  assert.notEqual(placed.laneKey, 'todo');
});

test('Scenario: Coding and testing map to their lanes', () => {
  // Given a ticket has status "in-progress" then "testing"
  const inProgress = placeCard({ id: 'TASK-2', status: 'in-progress' }, BOARD_LANES);
  const testing = placeCard({ id: 'TASK-2', status: 'testing' }, BOARD_LANES);
  // Then it appears in the matching lane
  assert.equal(inProgress.laneKey, 'in-progress');
  assert.equal(testing.laneKey, 'testing');
  // and both are actively-worked (blue dot, not the red failed marker)
  assert.equal(inProgress.dot.className, 'task-card-dot');
  assert.equal(testing.dot.className, 'task-card-dot');
});

test('Scenario: Failed tests show a red marker', () => {
  // Given a ticket's tests fail (status failed-testing)
  const fm = { id: 'TASK-3', status: 'failed-testing' };
  const placed = placeCard(fm, BOARD_LANES);
  // Then its card shows a red "failed" marker (the `failed` dot class)
  assert.ok(placed.dot, 'a marker dot is rendered');
  assert.equal(placed.dot.className, 'task-card-dot failed');
  // and the CSS paints that class red.
  assert.match(cssSrc, /\.task-card-dot\.failed\s*\{[^}]*background:\s*#f14c4c/i);
  // and the card folds into the testing lane (no dedicated lane), not unknown
  // and never dumped into todo (TASK-028).
  assert.equal(placed.laneKey, 'testing');
  assert.equal(placed.unknown, false);
});

test('Scenario: An out-of-enum status does not crash the board', () => {
  // Given a ticket has status "bogus", alongside several valid tickets
  const tickets = [
    { id: 'TASK-A', status: 'todo' },
    { id: 'TASK-B', status: 'bogus' },
    { id: 'TASK-C', status: 'in-progress' },
    { id: 'TASK-D', status: 'done' },
  ];
  // Then it is shown as unknown ...
  const bogus = placeCard(tickets[1], BOARD_LANES);
  assert.equal(bogus.laneKey, UNKNOWN_STATUS);
  assert.equal(bogus.unknown, true);
  assert.equal(bogus.cardClass, 'task-card unknown-status');
  assert.notEqual(bogus.laneKey, 'todo');
  // ... and the board keeps rendering the other tickets in their own lanes.
  const board = renderBoard(tickets);
  assert.deepEqual(board.todo, ['TASK-A']);
  assert.deepEqual(board['in-progress'], ['TASK-C']);
  assert.deepEqual(board.done, ['TASK-D']);
  assert.deepEqual(board.unknown, ['TASK-B']);
});
