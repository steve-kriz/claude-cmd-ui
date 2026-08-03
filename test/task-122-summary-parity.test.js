'use strict';

// Unit tests for TASK-122: the renderer's new lane-order MIRROR HELPERS added to
// align formatTasksSummary with the lib's re-injecting lane-order behavior.
//
//   renderer tasksUserSlugSetFor   ⇔ lib/ticket-lanes.js userStatusSetFor
//   renderer tasksLaneStatusesFor  ⇔ lib/ticket-lanes.js laneStatusesFor
//   renderer tasksLaneForStatusFor ⇔ lib/ticket-lanes.js laneForStatusFor
//
// The renderer helpers are loaded headless from the ACTUAL renderer/renderer.js
// source (test/helpers/task-122-summary-harness.js — pure functions, no DOM/IPC/
// FS/DB/network). lib userStatusSetFor is not exported, so its result is
// reconstructed via the exported isUserStatus (a slug is in the set iff
// isUserStatus(slug, columns)). laneStatusesFor / laneForStatusFor are exported
// and compared directly. Every helper must agree with its lib counterpart over
// representative AND partial / reordered / reserved / junk inputs.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  laneStatusesFor,
  laneForStatusFor,
  isUserStatus,
} = require('../lib/ticket-lanes');
const { loadRendererSummary } = require('./helpers/task-122-summary-harness');

const {
  tasksUserSlugSetFor,
  tasksLaneStatusesFor,
  tasksLaneForStatusFor,
} = loadRendererSummary();

// A spread of columns arrays: default-ish, partial, reordered, user-interleaved,
// user-before-todo, reserved/invalid slugs, and junk / non-array degenerate input.
const COLUMN_CASES = {
  'null': null,
  'undefined': undefined,
  'empty': [],
  'junk-nonarray': 'not-an-array',
  'junk-entries': [null, 42, 'x', [], { status: 123 }, { nope: true }],
  'default-system': [
    { status: 'todo', system: true },
    { status: 'defining', system: true },
    { status: 'in-progress', system: true },
    { status: 'testing', system: true },
    { status: 'done', system: true },
  ],
  // A legacy system column carrying the removed post-processing slug (TASK-206):
  // system:true excludes it from userStatusSetFor, and it is not one of the five
  // LANE_STATUSES, so both sides must silently drop it rather than resurrect a lane.
  'legacy-post-processing-system': [
    { status: 'todo', system: true },
    { status: 'defining', system: true },
    { status: 'in-progress', system: true },
    { status: 'testing', system: true },
    { status: 'post-processing', system: true },
    { status: 'done', system: true },
  ],
  'partial-system': [
    { status: 'todo', system: true },
    { status: 'in-progress', system: true },
    { status: 'testing', system: true },
    { status: 'done', system: true },
  ],
  'reordered-partial': [
    { status: 'done', system: true },
    { status: 'todo', system: true },
    { status: 'testing', system: true },
  ],
  'partial+user': [
    { status: 'todo', system: true },
    { status: 'in-progress', system: true },
    { status: 'review', label: 'Review', system: false },
    { status: 'done', system: true },
  ],
  'user-before-todo': [
    { status: 'review', label: 'Review', system: false },
    { status: 'todo', system: true },
  ],
  'reserved-invalid': [
    { status: 'unknown', system: false },
    { status: '__wont-do__', system: false },
    { status: 'failed-testing', system: false },
    { status: '../evil', system: false },
    { status: 'UPPER', system: false },
    { status: 'toolongtoolongtoolongtoolongtoolong', system: false },
    { status: 'review', label: 'Review', system: false },
  ],
  'duplicate-user': [
    { status: 'a', system: false },
    { status: 'todo', system: true },
    { status: 'b', system: false },
    { status: 'in-progress', system: true },
    { status: 'a', system: false },
  ],
};

// Candidate statuses to probe set membership / lane routing against.
const STATUS_PROBES = [
  'todo', 'defining', 'in-progress', 'testing', 'post-processing', 'done',
  'failed-testing', 'unknown', '__wont-do__', '../evil', 'UPPER',
  'review', 'a', 'b', 'weird-xyz', 'toolongtoolongtoolongtoolongtoolong', '',
];

// ---------------------------------------------------------------------------
// tasksUserSlugSetFor ⇔ userStatusSetFor (via isUserStatus)
// ---------------------------------------------------------------------------

for (const [name, columns] of Object.entries(COLUMN_CASES)) {
  test(`tasksUserSlugSetFor matches lib userStatusSetFor membership — ${name}`, () => {
    const set = tasksUserSlugSetFor(columns);
    for (const probe of STATUS_PROBES) {
      assert.equal(
        set.has(probe),
        isUserStatus(probe, columns),
        `slug "${probe}" membership must agree with lib for case "${name}"`,
      );
    }
  });
}

test('tasksUserSlugSetFor keeps ONLY valid user slugs (reserved/unsafe dropped)', () => {
  const set = tasksUserSlugSetFor(COLUMN_CASES['reserved-invalid']);
  assert.deepEqual([...set].sort(), ['review']);
});

test('tasksUserSlugSetFor de-dupes repeated user slugs', () => {
  const set = tasksUserSlugSetFor(COLUMN_CASES['duplicate-user']);
  assert.deepEqual([...set].sort(), ['a', 'b']);
});

// ---------------------------------------------------------------------------
// tasksLaneStatusesFor ⇔ laneStatusesFor
// ---------------------------------------------------------------------------

for (const [name, columns] of Object.entries(COLUMN_CASES)) {
  test(`tasksLaneStatusesFor matches lib laneStatusesFor — ${name}`, () => {
    assert.deepEqual(
      tasksLaneStatusesFor(columns),
      laneStatusesFor(columns),
      `lane order must match lib for case "${name}"`,
    );
  });
}

test('tasksLaneStatusesFor re-injects all five system lanes for a PARTIAL array', () => {
  // The core TASK-122 fix: a partial system-columns array must yield all five lanes
  // in canonical order, not just the supplied ones.
  assert.deepEqual(
    tasksLaneStatusesFor(COLUMN_CASES['partial-system']),
    ['todo', 'defining', 'in-progress', 'testing', 'done'],
  );
});

test('tasksLaneStatusesFor null/junk degrade to the five system lanes', () => {
  const FIVE = ['todo', 'defining', 'in-progress', 'testing', 'done'];
  assert.deepEqual(tasksLaneStatusesFor(null), FIVE);
  assert.deepEqual(tasksLaneStatusesFor('nope'), FIVE);
  assert.deepEqual(tasksLaneStatusesFor(COLUMN_CASES['junk-entries']), FIVE);
});

test('tasksLaneStatusesFor interleaves a user column at its anchored position', () => {
  assert.deepEqual(
    tasksLaneStatusesFor(COLUMN_CASES['partial+user']),
    ['todo', 'defining', 'in-progress', 'review', 'testing', 'done'],
  );
});

test('tasksLaneStatusesFor sorts a pre-todo user column ahead of todo', () => {
  assert.deepEqual(
    tasksLaneStatusesFor(COLUMN_CASES['user-before-todo']),
    ['review', 'todo', 'defining', 'in-progress', 'testing', 'done'],
  );
});

test('tasksLaneStatusesFor silently drops a legacy system:true post-processing column (TASK-206)', () => {
  // Neither re-injected as a system lane (it is not in LANE_STATUSES) nor treated
  // as a user column (system:true excludes it from userStatusSetFor) — it simply
  // does not appear, and no "post-processing" lane is resurrected.
  const lanes = tasksLaneStatusesFor(COLUMN_CASES['legacy-post-processing-system']);
  assert.deepEqual(lanes, ['todo', 'defining', 'in-progress', 'testing', 'done']);
  assert.ok(!lanes.includes('post-processing'), 'post-processing is never resurrected as a lane');
});

// ---------------------------------------------------------------------------
// tasksLaneForStatusFor ⇔ laneForStatusFor
// ---------------------------------------------------------------------------

for (const [name, columns] of Object.entries(COLUMN_CASES)) {
  test(`tasksLaneForStatusFor matches lib laneForStatusFor — ${name}`, () => {
    for (const probe of STATUS_PROBES) {
      assert.equal(
        tasksLaneForStatusFor(probe, columns),
        laneForStatusFor(probe, columns),
        `routing of "${probe}" must match lib for case "${name}"`,
      );
    }
  });
}

test('tasksLaneForStatusFor: failed-testing folds into testing; system → self; junk → unknown', () => {
  const cols = COLUMN_CASES['partial+user'];
  assert.equal(tasksLaneForStatusFor('failed-testing', cols), 'testing');
  assert.equal(tasksLaneForStatusFor('in-progress', cols), 'in-progress');
  assert.equal(tasksLaneForStatusFor('review', cols), 'review'); // valid user status → own lane
  assert.equal(tasksLaneForStatusFor('weird-xyz', cols), 'unknown'); // out-of-enum → unknown
  assert.equal(tasksLaneForStatusFor('unknown', cols), 'unknown'); // reserved user slug never wins
});
