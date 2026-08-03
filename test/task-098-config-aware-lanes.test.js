'use strict';

// Unit tests for TASK-098: config-aware lane resolution in lib/ticket-lanes.js.
//
// These cover the four new additive exports that layer the dynamic-status engine
// (a `columns` array from lib/team-config.js) on top of the FIXED board:
//   - laneStatusesFor(columns)
//   - isKnownStatusFor(status, columns)
//   - laneForStatusFor(status, columns)
//   - isUserStatus(status, columns)
// plus a guard that every PRE-EXISTING export still exists and behaves, since the
// whole point of the ticket is that the additions are byte-compatible with the
// original module (dozens of tests + the SKILL.md contract depend on them).
//
// The module is pure and Electron-free: it touches NO database, filesystem, or
// network. There is nothing to mock away — no DB call is made by construction.
// Column arrays are hand-built plain objects; where a real default config is
// needed we use lib/team-config.js's pure defaultConfig().

const { test } = require('node:test');
const assert = require('node:assert/strict');

const lanes = require('../lib/ticket-lanes');
const {
  LANE_STATUSES,
  VALID_STATUSES,
  ACTIVE_STATUSES,
  FAILED_STATUS,
  UNKNOWN_STATUS,
  isKnownStatus,
  isActiveStatus,
  isFailedStatus,
  laneForStatus,
  laneStatusesFor,
  isKnownStatusFor,
  laneForStatusFor,
  isUserStatus,
} = lanes;

const { defaultConfig } = require('../lib/team-config.js');

// A minimal column object of the shape lib/team-config.js normalises to.
function col(status, system) {
  return { status, label: status, description: '', agent: null, system };
}

// System columns in canonical board order, followed by a user column after
// testing (the ux-review anchoring case the ticket calls out).
function columnsWithUxReviewAfterTesting() {
  return [
    col('todo', true),
    col('defining', true),
    col('in-progress', true),
    col('testing', true),
    col('ux-review', false),
    col('done', true),
  ];
}

// ---------------------------------------------------------------------------
// Guard: every PRE-EXISTING export is still present and behaves unchanged.
// (The additive change must not touch the fixed board contract.)
// ---------------------------------------------------------------------------

test('all pre-existing exports still exist with unchanged names/types', () => {
  assert.deepEqual(LANE_STATUSES, ['todo', 'defining', 'in-progress', 'testing', 'done']);
  assert.deepEqual(VALID_STATUSES, [...LANE_STATUSES, 'failed-testing']);
  assert.deepEqual([...ACTIVE_STATUSES].sort(), ['defining', 'in-progress', 'testing']);
  assert.equal(FAILED_STATUS, 'failed-testing');
  assert.equal(UNKNOWN_STATUS, 'unknown');
  for (const fn of [isKnownStatus, isActiveStatus, isFailedStatus, laneForStatus]) {
    assert.equal(typeof fn, 'function');
  }
  // TASK-206: post-processing was removed from the module and its exports entirely.
  assert.ok(!('POST_PROCESSING_STATUS' in lanes), 'POST_PROCESSING_STATUS is gone');
  assert.ok(!('POST_PROCESSING_KIND' in lanes), 'POST_PROCESSING_KIND is gone');
  assert.ok(!('isPostProcessingTicket' in lanes), 'isPostProcessingTicket is gone');
});

test('pre-existing predicates/behaviour unchanged (spot-check)', () => {
  for (const s of LANE_STATUSES) assert.equal(isKnownStatus(s), true);
  assert.equal(isKnownStatus('failed-testing'), true);
  assert.equal(isKnownStatus('bogus'), false);
  assert.equal(isActiveStatus('testing'), true);
  assert.equal(isActiveStatus('todo'), false);
  assert.equal(isFailedStatus('failed-testing'), true);
  assert.equal(laneForStatus('failed-testing'), 'testing');
  assert.equal(laneForStatus('bogus'), UNKNOWN_STATUS);
  assert.notEqual(laneForStatus('bogus'), 'todo');
});

// ---------------------------------------------------------------------------
// laneStatusesFor(columns)
// ---------------------------------------------------------------------------

test('laneStatusesFor(defaultConfig().columns) equals LANE_STATUSES', () => {
  assert.deepEqual(laneStatusesFor(defaultConfig().columns), LANE_STATUSES);
  // A fresh reference (not a mutated alias of the constant).
  assert.notEqual(laneStatusesFor(defaultConfig().columns), LANE_STATUSES);
});

test('laneStatusesFor inserts a user column at its anchored position (after testing)', () => {
  assert.deepEqual(laneStatusesFor(columnsWithUxReviewAfterTesting()), [
    'todo', 'defining', 'in-progress', 'testing', 'ux-review', 'done',
  ]);
});

test('laneStatusesFor anchors a user column before the first system column ahead of todo', () => {
  const cols = [col('triage', false), ...defaultConfig().columns];
  assert.deepEqual(laneStatusesFor(cols), [
    'triage', 'todo', 'defining', 'in-progress', 'testing', 'done',
  ]);
});

test('laneStatusesFor never lists failed-testing as a lane', () => {
  const cols = [...defaultConfig().columns, col('failed-testing', false)];
  assert.ok(!laneStatusesFor(cols).includes('failed-testing'));
  assert.deepEqual(laneStatusesFor(cols), LANE_STATUSES);
});

test('laneStatusesFor degrades to LANE_STATUSES for null/[]/junk columns, never throws', () => {
  for (const bad of [null, undefined, [], 'nope', 42, {}, [null, 7, 'x', []]]) {
    assert.deepEqual(laneStatusesFor(bad), LANE_STATUSES, `${JSON.stringify(bad)} => LANE_STATUSES`);
  }
});

test('laneStatusesFor drops malformed entries but keeps the valid user column', () => {
  const cols = [null, col('todo', true), 'junk', col('ux-review', false), 5, col('done', true)];
  const out = laneStatusesFor(cols);
  assert.ok(out.includes('ux-review'));
  // ux-review anchors to todo (last system slug before it), lands right after todo.
  assert.deepEqual(out, ['todo', 'ux-review', 'defining', 'in-progress', 'testing', 'done']);
});

// ---------------------------------------------------------------------------
// isUserStatus(status, columns)
// ---------------------------------------------------------------------------

test('isUserStatus is true for a declared user column slug', () => {
  assert.equal(isUserStatus('ux-review', columnsWithUxReviewAfterTesting()), true);
});

test('isUserStatus is false for system/valid statuses even when passed as columns', () => {
  const cols = columnsWithUxReviewAfterTesting();
  for (const s of [...VALID_STATUSES, UNKNOWN_STATUS]) {
    assert.equal(isUserStatus(s, cols), false, `${s} is never a user status`);
  }
});

test('isUserStatus is false for unknown slugs and junk columns', () => {
  assert.equal(isUserStatus('ux-review', null), false);
  assert.equal(isUserStatus('not-a-column', columnsWithUxReviewAfterTesting()), false);
  assert.equal(isUserStatus('ux-review', []), false);
  assert.equal(isUserStatus('ux-review', 'junk'), false);
});

// ---------------------------------------------------------------------------
// isKnownStatusFor(status, columns)
// ---------------------------------------------------------------------------

test('isKnownStatusFor is true for user columns AND all system/valid statuses', () => {
  const cols = columnsWithUxReviewAfterTesting();
  assert.equal(isKnownStatusFor('ux-review', cols), true);
  for (const s of VALID_STATUSES) assert.equal(isKnownStatusFor(s, cols), true, `${s} known`);
});

test('isKnownStatusFor is false for out-of-config statuses', () => {
  const cols = columnsWithUxReviewAfterTesting();
  for (const s of ['bogus', 'ux review', '', null, undefined]) {
    assert.equal(isKnownStatusFor(s, cols), false, `${JSON.stringify(s)} not known`);
  }
});

test('isKnownStatusFor with junk columns matches the system-only isKnownStatus', () => {
  for (const bad of [null, [], 'x']) {
    assert.equal(isKnownStatusFor('failed-testing', bad), true);
    assert.equal(isKnownStatusFor('ux-review', bad), false);
  }
});

// ---------------------------------------------------------------------------
// laneForStatusFor(status, columns)
// ---------------------------------------------------------------------------

test('laneForStatusFor routes a user column status to its OWN lane', () => {
  assert.equal(laneForStatusFor('ux-review', columnsWithUxReviewAfterTesting()), 'ux-review');
});

test('laneForStatusFor routes every system lane status to its own lane', () => {
  const cols = columnsWithUxReviewAfterTesting();
  for (const s of LANE_STATUSES) assert.equal(laneForStatusFor(s, cols), s, `${s} own lane`);
});

test('laneForStatusFor folds failed-testing into testing for ANY columns (incl null/junk)', () => {
  for (const cols of [null, undefined, [], 'x', columnsWithUxReviewAfterTesting()]) {
    assert.equal(laneForStatusFor('failed-testing', cols), 'testing', `failed-testing folds for ${JSON.stringify(cols)}`);
  }
});

test('laneForStatusFor routes an out-of-config status to UNKNOWN_STATUS, never todo', () => {
  const cols = columnsWithUxReviewAfterTesting();
  for (const s of ['bogus', 'ux review', '', null, undefined, 42]) {
    assert.equal(laneForStatusFor(s, cols), UNKNOWN_STATUS, `${JSON.stringify(s)} => unknown`);
    assert.notEqual(laneForStatusFor(s, cols), 'todo');
  }
});

test('laneForStatusFor: a removed user column status routes to unknown, never todo', () => {
  // columns no longer contain ux-review, but a ticket still carries the status.
  const cols = defaultConfig().columns;
  assert.equal(laneForStatusFor('ux-review', cols), UNKNOWN_STATUS);
  assert.notEqual(laneForStatusFor('ux-review', cols), 'todo');
});

// ---------------------------------------------------------------------------
// System precedence on slug collision + slot math untouched
// ---------------------------------------------------------------------------

test('a user column colliding with a system/valid slug resolves as the SYSTEM meaning', () => {
  // Impossible after team-config normalisation, but guarded here anyway.
  const cols = [
    col('todo', false),          // collides with a system lane
    col('failed-testing', false), // collides with the lane-less valid status
    col('unknown', false),        // collides with the routing key
  ];
  // None are treated as user statuses.
  assert.equal(isUserStatus('todo', cols), false);
  assert.equal(isUserStatus('failed-testing', cols), false);
  assert.equal(isUserStatus('unknown', cols), false);
  // They resolve with system meaning.
  assert.equal(laneForStatusFor('todo', cols), 'todo');
  assert.equal(laneForStatusFor('failed-testing', cols), 'testing');
  // 'unknown' is not a lane status and not a user status => routes to UNKNOWN_STATUS.
  assert.equal(laneForStatusFor('unknown', cols), UNKNOWN_STATUS);
});

test('isActiveStatus("ux-review") remains false — user statuses are never active', () => {
  assert.equal(isActiveStatus('ux-review'), false);
  // The active-status set is untouched by the config-aware additions.
  assert.deepEqual([...ACTIVE_STATUSES].sort(), ['defining', 'in-progress', 'testing']);
});
