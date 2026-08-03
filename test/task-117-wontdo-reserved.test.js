'use strict';

// Unit tests for TASK-117: explicit __wont-do__ reserved-slug parity in
// lib/ticket-lanes.js userStatusSetFor.
//
// TASK-098 added the config-aware lane helpers; TASK-109 gated them on
// isFsSafeSlug. This ticket makes the __wont-do__ exclusion EXPLICIT (a local
// WONT_DO_SLUG constant + a dedicated `if (slug === WONT_DO_SLUG) continue;` in
// userStatusSetFor) to restore 1:1 parity with team-config RESERVED_SLUGS and
// renderer TASKS_RESERVED_SLUGS.
//
// NOTE: no observable behavior change today — `__wont-do__` already fails
// isFsSafeSlug (underscores fail FS_SLUG_RE) so it was already excluded
// incidentally. These are LOCKING tests that assert the exclusion holds across
// every downstream helper (isUserStatus / isKnownStatusFor / laneForStatusFor /
// laneStatusesFor + ticket-folders *With), plus the wont-do / ux-review
// regressions, and that the source guard is present (explicit, not incidental)
// while the module stays require-cycle-free.
//
// The module is pure and Electron-free: it touches NO database, filesystem, or
// network. There is NO DB call to make, so all database access is mocked away by
// construction. Column arrays are hand-built plain objects. The one disk read is
// of the app's own source file (a source-scan guard for the explicit constant).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const lanes = require('../lib/ticket-lanes.js');
const {
  LANE_STATUSES,
  VALID_STATUSES,
  UNKNOWN_STATUS,
  isUserStatus,
  isKnownStatusFor,
  laneForStatusFor,
  laneStatusesFor,
} = lanes;

const {
  folderForStatusWith,
  folderMatchesStatusWith,
  reconcileFolderWith,
} = require('../lib/ticket-folders.js');

const WONT_DO = '__wont-do__';

// A minimal column object of the shape lib/team-config.js normalises to.
function col(status, system) {
  return { status, label: String(status), description: '', agent: null, system };
}

function systemColumns() {
  return LANE_STATUSES.map((s) => col(s, true));
}

// ---------------------------------------------------------------------------
// The __wont-do__ exclusion across every helper.
// ---------------------------------------------------------------------------

test('isUserStatus("__wont-do__", cols) is false for a non-system __wont-do__ column', () => {
  const cols = [...systemColumns(), col(WONT_DO, false)];
  assert.equal(isUserStatus(WONT_DO, cols), false);
});

test('isKnownStatusFor("__wont-do__", cols) is false (not a user status, not a system status)', () => {
  const cols = [...systemColumns(), col(WONT_DO, false)];
  assert.equal(isKnownStatusFor(WONT_DO, cols), false);
});

test('laneForStatusFor("__wont-do__", cols) is "unknown", never "todo"', () => {
  const cols = [...systemColumns(), col(WONT_DO, false)];
  assert.equal(laneForStatusFor(WONT_DO, cols), UNKNOWN_STATUS);
  assert.notEqual(laneForStatusFor(WONT_DO, cols), 'todo');
});

test('laneStatusesFor(cols) deep-equals LANE_STATUSES (omits __wont-do__)', () => {
  const cols = [...systemColumns(), col(WONT_DO, false)];
  assert.deepEqual(laneStatusesFor(cols), LANE_STATUSES);
  // A fresh reference, not a mutated alias of the constant.
  assert.notEqual(laneStatusesFor(cols), LANE_STATUSES);
  assert.equal(laneStatusesFor(cols).includes(WONT_DO), false);
});

test('folderForStatusWith("__wont-do__", cols) is null', () => {
  const cols = [...systemColumns(), col(WONT_DO, false)];
  assert.equal(folderForStatusWith(WONT_DO, cols), null);
  assert.equal(folderMatchesStatusWith('', WONT_DO, cols), false);
  assert.equal(folderMatchesStatusWith(WONT_DO, WONT_DO, cols), false);
});

test('reconcileFolderWith(..., "__wont-do__", cols) yields { needsMove:false, targetFolder:null }', () => {
  const cols = [...systemColumns(), col(WONT_DO, false)];
  for (const folder of ['', 'todo', 'done', WONT_DO]) {
    assert.deepEqual(reconcileFolderWith(folder, WONT_DO, cols),
      { needsMove: false, targetFolder: null });
  }
});

test('__wont-do__ exclusion holds across duplicate columns (dedupe never resurrects it)', () => {
  const cols = [...systemColumns(), col(WONT_DO, false), col(WONT_DO, false)];
  assert.equal(isUserStatus(WONT_DO, cols), false);
  assert.deepEqual(laneStatusesFor(cols), LANE_STATUSES);
});

test('whitespace-padded " __wont-do__ " is trimmed then excluded', () => {
  const cols = [...systemColumns(), col(`  ${WONT_DO}  `, false)];
  assert.equal(isUserStatus(WONT_DO, cols), false);
  assert.equal(laneForStatusFor(WONT_DO, cols), UNKNOWN_STATUS);
  assert.deepEqual(laneStatusesFor(cols), LANE_STATUSES);
});

test('a system:true __wont-do__ column is skipped by the system continue (still excluded)', () => {
  const cols = [...systemColumns(), col(WONT_DO, true)];
  assert.equal(isUserStatus(WONT_DO, cols), false);
  assert.deepEqual(laneStatusesFor(cols), LANE_STATUSES);
});

// ---------------------------------------------------------------------------
// Regression: plain "wont-do" (no underscores) is NOT reserved and stays legal.
// ---------------------------------------------------------------------------

test('plain "wont-do" (no underscores) is still admitted as a user status', () => {
  const cols = [...systemColumns(), col('wont-do', false)];
  assert.equal(isUserStatus('wont-do', cols), true);
  assert.equal(isKnownStatusFor('wont-do', cols), true);
  assert.equal(laneForStatusFor('wont-do', cols), 'wont-do');
  assert.equal(laneStatusesFor(cols).includes('wont-do'), true);
  assert.equal(folderForStatusWith('wont-do', cols), 'wont-do');
  assert.deepEqual(reconcileFolderWith('', 'wont-do', cols),
    { needsMove: true, targetFolder: 'wont-do' });
});

// ---------------------------------------------------------------------------
// Regression: ux-review unaffected.
// ---------------------------------------------------------------------------

test('ux-review is still a user status with its own lane and folder', () => {
  const cols = [
    col('todo', true), col('defining', true), col('in-progress', true),
    col('testing', true), col('ux-review', false),
    col('done', true),
  ];
  assert.equal(isUserStatus('ux-review', cols), true);
  assert.equal(isKnownStatusFor('ux-review', cols), true);
  assert.equal(laneForStatusFor('ux-review', cols), 'ux-review');
  assert.deepEqual(laneStatusesFor(cols), [
    'todo', 'defining', 'in-progress', 'testing', 'ux-review', 'done',
  ]);
  assert.equal(folderForStatusWith('ux-review', cols), 'ux-review');
});

// ---------------------------------------------------------------------------
// Regression: the pre-existing reserved exclusions (VALID_STATUSES + unknown).
// ---------------------------------------------------------------------------

test('every VALID_STATUSES member + unknown as a non-system slug is still excluded', () => {
  const cols = [
    ...systemColumns(),
    ...VALID_STATUSES.map((s) => col(s, false)),
    col(UNKNOWN_STATUS, false),
  ];
  for (const s of [...VALID_STATUSES, UNKNOWN_STATUS]) {
    assert.equal(isUserStatus(s, cols), false, `${s} excluded from user set`);
  }
  // System routing preserved.
  assert.equal(laneForStatusFor('failed-testing', cols), 'testing');
  assert.equal(laneForStatusFor('unknown', cols), UNKNOWN_STATUS);
  assert.deepEqual(laneStatusesFor(cols), LANE_STATUSES);
});

// ---------------------------------------------------------------------------
// Junk / hostile columns never throw.
// ---------------------------------------------------------------------------

test('null/[]/junk columns never throw and __wont-do__ stays excluded', () => {
  for (const cols of [null, undefined, [], 'junk', 42, {}, [null, 7, 'x']]) {
    assert.doesNotThrow(() => {
      isUserStatus(WONT_DO, cols);
      isKnownStatusFor(WONT_DO, cols);
      laneForStatusFor(WONT_DO, cols);
      laneStatusesFor(cols);
      folderForStatusWith(WONT_DO, cols);
      reconcileFolderWith('', WONT_DO, cols);
    });
    assert.equal(isUserStatus(WONT_DO, cols), false);
    assert.equal(laneForStatusFor(WONT_DO, cols), UNKNOWN_STATUS);
    assert.equal(folderForStatusWith(WONT_DO, cols), null);
    assert.deepEqual(laneStatusesFor(cols), LANE_STATUSES);
  }
});

// ---------------------------------------------------------------------------
// Structural guards: the exclusion is EXPLICIT, and the module has no require
// cycle back into team-config. (Acceptance-criteria items #2 and #3.)
// ---------------------------------------------------------------------------

const LANES_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'lib', 'ticket-lanes.js'), 'utf8');

test('userStatusSetFor excludes __wont-do__ EXPLICITLY via a local constant (not just isFsSafeSlug)', () => {
  // A dedicated local constant naming the reserved slug.
  assert.match(LANES_SRC, /const\s+WONT_DO_SLUG\s*=\s*'__wont-do__'\s*;/);
  // And an explicit skip in userStatusSetFor referencing that constant.
  assert.match(LANES_SRC, /if\s*\(\s*slug\s*===\s*WONT_DO_SLUG\s*\)\s*continue\s*;/);
  // The isFsSafeSlug gate remains present and unchanged (additive check).
  assert.match(LANES_SRC, /if\s*\(\s*!isFsSafeSlug\(slug\)\s*\)\s*continue\s*;/);
});

test('lib/ticket-lanes.js does not require lib/team-config.js (no cycle)', () => {
  assert.ok(!/require\(\s*['"]\.\/team-config['"]\s*\)/.test(LANES_SRC),
    'ticket-lanes.js must not require team-config (would be a cycle)');
});

test('export surface is unchanged (TASK-098 export guard still holds)', () => {
  const expected = [
    'LANE_STATUSES', 'VALID_STATUSES', 'ACTIVE_STATUSES', 'FAILED_STATUS',
    'UNKNOWN_STATUS',
    'isKnownStatus', 'isActiveStatus', 'isFailedStatus',
    'laneForStatus', 'laneStatusesFor', 'isKnownStatusFor', 'laneForStatusFor',
    'isUserStatus', 'isFsSafeSlug',
  ];
  for (const name of expected) {
    assert.ok(name in lanes, `export ${name} present`);
  }
  // WONT_DO_SLUG stays module-local (not exported).
  assert.ok(!('WONT_DO_SLUG' in lanes), 'WONT_DO_SLUG is module-local, not exported');
  // TASK-206: post-processing was removed from the module and its exports entirely.
  assert.ok(!('POST_PROCESSING_STATUS' in lanes), 'POST_PROCESSING_STATUS is gone');
  assert.ok(!('POST_PROCESSING_KIND' in lanes), 'POST_PROCESSING_KIND is gone');
  assert.ok(!('isPostProcessingTicket' in lanes), 'isPostProcessingTicket is gone');
});
