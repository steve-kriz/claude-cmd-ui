'use strict';

// E2e cucumber-style scenarios for TASK-117: explicit __wont-do__ reserved-slug
// parity in the config-aware lane guard (lib/ticket-lanes.js userStatusSetFor).
//
// These implement EVERY Gherkin scenario from the ticket in Given/When/Then form
// under plain `node --test` (no `cucumber` package is installed or added):
//   Scenario: A user column with slug __wont-do__ is never a user status
//   Scenario: __wont-do__ routes to unknown, never todo
//   Scenario: __wont-do__ never appears as a board lane
//   Scenario: __wont-do__ owns no tasks/ folder
//   Scenario: Regression — ux-review unaffected
//   Scenario: Regression — plain "wont-do" still admitted
//   Scenario: Existing reserved exclusions still hold
//   Scenario: Junk columns never throw (failure/edge path)
//
// NOTE (per the ticket): there is NO observable behavior change today —
// `__wont-do__` already fails isFsSafeSlug (underscores fail FS_SLUG_RE), so it
// was already excluded incidentally. These are LOCKING tests that pin the
// explicit reserved-slug exclusion so it survives any future relaxation of the
// slug regex, in parity with team-config RESERVED_SLUGS / renderer
// TASKS_RESERVED_SLUGS.
//
// Columns arrays are hand-built via a col(status, system) helper. Everything
// under test is pure and Electron-free: NO database, filesystem, or network is
// touched, so ALL database access is mocked away by construction (there is none
// to make).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  LANE_STATUSES,
  VALID_STATUSES,
  UNKNOWN_STATUS,
  isUserStatus,
  isKnownStatusFor,
  laneForStatusFor,
  laneStatusesFor,
} = require('../lib/ticket-lanes.js');

const {
  folderForStatusWith,
  folderMatchesStatusWith,
  reconcileFolderWith,
} = require('../lib/ticket-folders.js');

const WONT_DO = '__wont-do__';

// A column of the shape lib/team-config.js normalises to.
function col(status, system) {
  return { status, label: String(status), description: '', agent: null, system };
}

// The default six system columns in canonical board order (built by hand so the
// e2e path never touches team-config's normaliser or any I/O).
function systemColumns() {
  return LANE_STATUSES.map((s) => col(s, true));
}

// -------------------------------------------------------------------------
// Scenario: A user column with slug __wont-do__ is never a user status
// -------------------------------------------------------------------------
test('Scenario: A user column with slug __wont-do__ is never a user status', () => {
  // Given a non-system column with status "__wont-do__"
  const columns = [...systemColumns(), col(WONT_DO, false)];

  // Then isUserStatus("__wont-do__", columns) is false
  assert.equal(isUserStatus(WONT_DO, columns), false);

  // And isKnownStatusFor("__wont-do__", columns) is false
  assert.equal(isKnownStatusFor(WONT_DO, columns), false);

  // And even a DUPLICATE __wont-do__ column stays excluded.
  const dupCols = [...systemColumns(), col(WONT_DO, false), col(WONT_DO, false)];
  assert.equal(isUserStatus(WONT_DO, dupCols), false);
  assert.equal(isKnownStatusFor(WONT_DO, dupCols), false);
});

// -------------------------------------------------------------------------
// Scenario: __wont-do__ routes to unknown, never todo
// -------------------------------------------------------------------------
test('Scenario: __wont-do__ routes to unknown, never todo', () => {
  // Given a non-system column with status "__wont-do__"
  const columns = [...systemColumns(), col(WONT_DO, false)];

  // Then laneForStatusFor("__wont-do__", columns) is "unknown" (not "todo")
  assert.equal(laneForStatusFor(WONT_DO, columns), UNKNOWN_STATUS);
  assert.notEqual(laneForStatusFor(WONT_DO, columns), 'todo');

  // And whitespace-padded " __wont-do__ " is trimmed by columnSlug before the
  // check, so a padded column is likewise excluded (routes to unknown).
  const paddedCols = [...systemColumns(), col(`  ${WONT_DO}  `, false)];
  assert.equal(laneForStatusFor(WONT_DO, paddedCols), UNKNOWN_STATUS);
  assert.equal(isUserStatus(WONT_DO, paddedCols), false);
});

// -------------------------------------------------------------------------
// Scenario: __wont-do__ never appears as a board lane
// -------------------------------------------------------------------------
test('Scenario: __wont-do__ never appears as a board lane', () => {
  // Given the system columns plus a non-system "__wont-do__" column
  const columns = [...systemColumns(), col(WONT_DO, false)];

  // Then laneStatusesFor(columns) equals exactly the five fixed LANE_STATUSES
  assert.deepEqual(laneStatusesFor(columns), LANE_STATUSES);
  assert.equal(laneStatusesFor(columns).includes(WONT_DO), false);

  // And placing __wont-do__ mid-board (between testing and done)
  // still omits it — the first-occurrence dedupe must not resurrect it.
  const midCols = [
    col('todo', true), col('defining', true), col('in-progress', true),
    col('testing', true), col(WONT_DO, false), col(WONT_DO, false),
    col('done', true),
  ];
  assert.deepEqual(laneStatusesFor(midCols), LANE_STATUSES);
});

// -------------------------------------------------------------------------
// Scenario: __wont-do__ owns no tasks/ folder
// -------------------------------------------------------------------------
test('Scenario: __wont-do__ owns no tasks/ folder', () => {
  // Given a non-system "__wont-do__" column
  const columns = [...systemColumns(), col(WONT_DO, false)];

  // Then folderForStatusWith("__wont-do__", columns) is null
  assert.equal(folderForStatusWith(WONT_DO, columns), null);

  // And it owns no folder to match, from any starting folder.
  assert.equal(folderMatchesStatusWith(WONT_DO, WONT_DO, columns), false);
  assert.equal(folderMatchesStatusWith('', WONT_DO, columns), false);
  assert.equal(folderMatchesStatusWith('done', WONT_DO, columns), false);

  // And reconcileFolderWith yields needsMove:false / targetFolder:null (file
  // left in place, never relocated) from any starting folder.
  for (const folder of ['', 'todo', 'done', WONT_DO]) {
    assert.deepEqual(reconcileFolderWith(folder, WONT_DO, columns),
      { needsMove: false, targetFolder: null },
      `__wont-do__ left in place from folder=${JSON.stringify(folder)}`);
  }
});

// -------------------------------------------------------------------------
// Scenario: Regression — ux-review unaffected
// -------------------------------------------------------------------------
test('Scenario: Regression — ux-review unaffected', () => {
  // Given a non-system "ux-review" column after "testing"
  const columns = [
    col('todo', true), col('defining', true), col('in-progress', true),
    col('testing', true), col('ux-review', false),
    col('done', true),
  ];

  // Then isUserStatus true, laneForStatusFor "ux-review"
  assert.equal(isUserStatus('ux-review', columns), true);
  assert.equal(isKnownStatusFor('ux-review', columns), true);
  assert.equal(laneForStatusFor('ux-review', columns), 'ux-review');

  // And it is listed between testing and done (anchored placement).
  assert.deepEqual(laneStatusesFor(columns), [
    'todo', 'defining', 'in-progress', 'testing', 'ux-review', 'done',
  ]);

  // And it owns its own folder / reconciles like a system status.
  assert.equal(folderForStatusWith('ux-review', columns), 'ux-review');
  assert.deepEqual(reconcileFolderWith('', 'ux-review', columns),
    { needsMove: true, targetFolder: 'ux-review' });
  assert.deepEqual(reconcileFolderWith('ux-review', 'ux-review', columns),
    { needsMove: false, targetFolder: 'ux-review' });
});

// -------------------------------------------------------------------------
// Scenario: Regression — plain "wont-do" still admitted
// -------------------------------------------------------------------------
test('Scenario: Regression — plain "wont-do" (no underscores) still admitted', () => {
  // Given a non-system "wont-do" column (NOT reserved in team-config, and
  // filesystem-safe: no underscores).
  const columns = [...systemColumns(), col('wont-do', false)];

  // Then isUserStatus("wont-do", columns) is true — the explicit __wont-do__
  // exclusion is EXACT-MATCH only and must not catch the underscore-free slug.
  assert.equal(isUserStatus('wont-do', columns), true);
  assert.equal(isKnownStatusFor('wont-do', columns), true);
  assert.equal(laneForStatusFor('wont-do', columns), 'wont-do');
  assert.equal(laneStatusesFor(columns).includes('wont-do'), true);
  assert.equal(folderForStatusWith('wont-do', columns), 'wont-do');

  // And the reserved __wont-do__ is still NOT a lane in the same board when only
  // plain wont-do is present.
  assert.equal(laneStatusesFor(columns).includes(WONT_DO), false);
});

// -------------------------------------------------------------------------
// Scenario: Existing reserved exclusions still hold
// -------------------------------------------------------------------------
test('Scenario: Existing reserved exclusions still hold (todo/failed-testing/unknown)', () => {
  // Given non-system "todo"/"failed-testing"/"unknown" columns
  const columns = [
    ...systemColumns(),
    col('todo', false),
    col('failed-testing', false),
    col('unknown', false),
  ];

  // Then none is a user status (system/reserved meaning always wins).
  for (const s of ['todo', 'failed-testing', 'unknown']) {
    assert.equal(isUserStatus(s, columns), false, `${s} is never a user status`);
  }

  // And laneForStatusFor("failed-testing") is "testing".
  assert.equal(laneForStatusFor('failed-testing', columns), 'testing');
  // And laneForStatusFor("unknown") is "unknown" (not a lane, not a user status).
  assert.equal(laneForStatusFor('unknown', columns), UNKNOWN_STATUS);
  // And every VALID_STATUSES member routes to its system lane, not todo.
  assert.equal(laneForStatusFor('todo', columns), 'todo');

  // And none of the reserved slugs surface as a board lane; the board is exactly
  // the fixed six lanes.
  assert.deepEqual(laneStatusesFor(columns), LANE_STATUSES);
});

// -------------------------------------------------------------------------
// Scenario: Junk columns never throw (failure / edge path)
// -------------------------------------------------------------------------
test('Scenario: Junk columns never throw and degrade to system-only behavior', () => {
  // Given null/[]/string/number/junk-array columns (including a system:true
  // column carrying __wont-do__, which is skipped by the system continue).
  const junkColumns = [
    null,
    undefined,
    [],
    'not-an-array',
    42,
    {},
    [null, 7, 'x', []],
    [col(WONT_DO, true)], // system:true __wont-do__ — skipped by system continue
    [{ status: 42, system: false }, { status: null, system: false }],
  ];

  // Then no helper throws and each degrades to system-only behavior.
  for (const columns of junkColumns) {
    const label = JSON.stringify(columns);
    assert.doesNotThrow(() => {
      isUserStatus(WONT_DO, columns);
      isKnownStatusFor(WONT_DO, columns);
      laneForStatusFor(WONT_DO, columns);
      laneStatusesFor(columns);
      folderForStatusWith(WONT_DO, columns);
      folderMatchesStatusWith('', WONT_DO, columns);
      reconcileFolderWith('', WONT_DO, columns);
    }, `junk columns=${label} never throws`);

    // __wont-do__ is never a user status / lane / folder for any junk input.
    assert.equal(isUserStatus(WONT_DO, columns), false, `${label}: not a user status`);
    assert.equal(laneForStatusFor(WONT_DO, columns), UNKNOWN_STATUS, `${label}: routes to unknown`);
    assert.equal(folderForStatusWith(WONT_DO, columns), null, `${label}: owns no folder`);
    // The board degrades to exactly the fixed lanes.
    assert.deepEqual(laneStatusesFor(columns), LANE_STATUSES, `${label}: fixed board`);
  }

  // And a system:true column carrying __wont-do__ never adds it as a lane.
  const sysWontDo = [...systemColumns(), col(WONT_DO, true)];
  assert.deepEqual(laneStatusesFor(sysWontDo), LANE_STATUSES);
  assert.equal(isUserStatus(WONT_DO, sysWontDo), false);
});

// -------------------------------------------------------------------------
// Cross-check: every VALID_STATUSES member + unknown + __wont-do__ excluded,
// even when all are declared as non-system columns at once.
// -------------------------------------------------------------------------
test('Scenario cross-check: all reserved slugs excluded together, board stays fixed', () => {
  const columns = [
    ...systemColumns(),
    ...VALID_STATUSES.map((s) => col(s, false)),
    col(UNKNOWN_STATUS, false),
    col(WONT_DO, false),
  ];
  for (const s of [...VALID_STATUSES, UNKNOWN_STATUS, WONT_DO]) {
    assert.equal(isUserStatus(s, columns), false, `${s} excluded from user set`);
  }
  assert.deepEqual(laneStatusesFor(columns), LANE_STATUSES);
});
