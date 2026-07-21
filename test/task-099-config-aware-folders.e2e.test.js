'use strict';

// E2e cucumber-style scenarios for TASK-099: config-aware folder-per-status.
//
// These implement EVERY Gherkin scenario from the ticket in Given/When/Then
// form under plain `node --test` (no `cucumber` package is installed or added):
//   Scenario: User status owns a folder
//   Scenario: Reconciling into a user folder
//   Scenario: Removed column leaves files alone (edge)
//   Scenario: System statuses unaffected (failure guard)
//
// Columns arrays are built via lib/team-config.js's pure defaultConfig() plus a
// hand-built user column, matching the ticket's guidance. Everything under test
// is pure and Electron-free: NO database, filesystem, or network is touched, so
// ALL database access is mocked away by construction (there is none to make).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  folderForStatus,
  folderForStatusWith,
  folderMatchesStatusWith,
  reconcileFolderWith,
} = require('../lib/ticket-folders');
const { VALID_STATUSES } = require('../lib/ticket-lanes');
const { defaultConfig } = require('../lib/team-config.js');

// A column of the shape lib/team-config.js normalises to.
function col(status, system) {
  return { status, label: status, description: '', agent: null, system };
}

// Given: columns that include a user status ux-review (default board + user col).
function columnsIncludingUxReview() {
  const cols = defaultConfig().columns.slice();
  cols.push(col('ux-review', false));
  return cols;
}

// Given: columns that NO LONGER include ux-review (the plain default board).
function columnsWithoutUxReview() {
  return defaultConfig().columns;
}

test('Scenario: User status owns a folder', () => {
  // Given columns include ux-review
  const columns = columnsIncludingUxReview();
  // Then folderForStatusWith("ux-review") is "ux-review"
  assert.equal(folderForStatusWith('ux-review', columns), 'ux-review');
  // And the folder-match predicate agrees for a file already in tasks/ux-review/
  assert.equal(folderMatchesStatusWith('ux-review', 'ux-review', columns), true);
});

test('Scenario: Reconciling into a user folder', () => {
  // Given a ticket with status ux-review sitting at tasks/ top level
  const columns = columnsIncludingUxReview();
  const currentFolder = ''; // top level
  // When reconcileFolderWith runs
  const result = reconcileFolderWith(currentFolder, 'ux-review', columns);
  // Then it reports needsMove with target "ux-review"
  assert.deepEqual(result, { needsMove: true, targetFolder: 'ux-review' });
});

test('Scenario: Removed column leaves files alone (edge)', () => {
  // Given columns no longer include ux-review
  const columns = columnsWithoutUxReview();
  // When reconcileFolderWith runs on a ticket still in tasks/ux-review/
  const result = reconcileFolderWith('ux-review', 'ux-review', columns);
  // Then needsMove is false and targetFolder is null (files are never relocated)
  assert.deepEqual(result, { needsMove: false, targetFolder: null });
  // And the removed status owns no folder at all
  assert.equal(folderForStatusWith('ux-review', columns), null);
});

test('Scenario: System statuses unaffected (failure guard)', () => {
  // Then folderForStatusWith behaves identically to folderForStatus for every
  // VALID_STATUSES entry, under the default config AND a config carrying a user
  // column — the fixed system layout must never drift.
  for (const columns of [columnsWithoutUxReview(), columnsIncludingUxReview()]) {
    for (const status of VALID_STATUSES) {
      assert.equal(folderForStatusWith(status, columns), folderForStatus(status),
        `${status}: config-aware variant matches the fixed folderForStatus`);
      // And each system status still needs a move from top level into its folder.
      assert.deepEqual(reconcileFolderWith('', status, columns),
        { needsMove: true, targetFolder: status },
        `${status}: reconciles from top level into tasks/${status}/`);
    }
  }
});

test('Scenario (edge/failure): junk columns degrade to system-only and never throw', () => {
  // Given hostile/malformed columns input
  const junkCases = [null, undefined, [], 'not-an-array', 42, {}, [null, 7, 'x']];
  for (const columns of junkCases) {
    // Then a user status owns no folder (system-only behaviour) ...
    assert.equal(folderForStatusWith('ux-review', columns), null,
      `junk columns=${JSON.stringify(columns)} → ux-review owns no folder`);
    // ... system statuses are unaffected ...
    assert.equal(folderForStatusWith('done', columns), 'done');
    // ... and reconciling a user status is a no-op that never throws.
    let r;
    assert.doesNotThrow(() => { r = reconcileFolderWith('', 'ux-review', columns); });
    assert.deepEqual(r, { needsMove: false, targetFolder: null });
  }
});
