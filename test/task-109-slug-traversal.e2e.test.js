'use strict';

// E2e cucumber-style scenarios for TASK-109: filesystem-safe slug enforcement in
// the lib folder/lane helpers (path-traversal hardening).
//
// These implement EVERY Gherkin scenario from the ticket in Given/When/Then form
// under plain `node --test` (no `cucumber` package is installed or added):
//   Scenario: A path-traversal slug never owns a folder (failure)
//   Scenario Outline: Unsafe slugs are excluded from the user-status set
//   Scenario: A valid user slug keeps working (regression)
//   Scenario: System statuses unaffected under any columns input
//   Scenario: Hostile input never throws (failure)
//
// Columns arrays are hand-built (and lib/team-config.js's pure defaultConfig()
// where the default board is needed). Everything under test is pure and
// Electron-free: NO database, filesystem, or network is touched, so ALL database
// access is mocked away by construction (there is none to make).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  VALID_STATUSES,
  LANE_STATUSES,
  UNKNOWN_STATUS,
  isFsSafeSlug,
  isUserStatus,
  isKnownStatus,
  isKnownStatusFor,
  laneForStatus,
  laneForStatusFor,
  laneStatusesFor,
} = require('../lib/ticket-lanes.js');

const {
  folderForStatus,
  folderForStatusWith,
  folderMatchesStatusWith,
  reconcileFolder,
  reconcileFolderWith,
  dedupeByFolder,
} = require('../lib/ticket-folders.js');

const { defaultConfig } = require('../lib/team-config.js');

// A column of the shape lib/team-config.js normalises to.
function col(status, system) {
  return { status, label: String(status), description: '', agent: null, system };
}

// The exclusion matrix from the ticket's Scenario Outline. `evil\child` uses a
// literal backslash; the 31-char example is rejected purely on length.
const TOO_LONG_31 = 'this-slug-is-way-too-long-to-be-allowed-here-x'; // > 30 chars
const UNSAFE_SLUGS = [
  '..',
  '../../evil',
  'evil/child',
  'evil\\child',
  'UX-Review',
  'ux review',
  TOO_LONG_31,
];

// A 30-char slug of the allowed class (boundary: exactly MAX_SLUG_LENGTH).
const VALID_30 = 'a'.repeat(30);

// -------------------------------------------------------------------------
// Scenario: A path-traversal slug never owns a folder (failure)
// -------------------------------------------------------------------------
test('Scenario: A path-traversal slug never owns a folder (failure)', () => {
  // Given a columns array containing { status: "../../evil", system: false }
  const columns = [...defaultConfig().columns, col('../../evil', false)];

  // When folderForStatusWith("../../evil", columns) is called
  // Then it returns null (the traversal string never becomes a tasks/<slug>/ target)
  assert.equal(folderForStatusWith('../../evil', columns), null);

  // And folderMatchesStatusWith is false (the slug owns no folder to match)
  assert.equal(folderMatchesStatusWith('../../evil', '../../evil', columns), false);
  assert.equal(folderMatchesStatusWith('', '../../evil', columns), false);

  // And reconcileFolderWith("todo","../../evil",columns) returns
  // { needsMove:false, targetFolder:null } (the file is left in place)
  assert.deepEqual(reconcileFolderWith('todo', '../../evil', columns),
    { needsMove: false, targetFolder: null });
  // From any starting folder the traversal status is never relocated.
  for (const folder of ['', 'todo', '../../evil']) {
    assert.deepEqual(reconcileFolderWith(folder, '../../evil', columns),
      { needsMove: false, targetFolder: null },
      `traversal slug left in place from folder=${JSON.stringify(folder)}`);
  }

  // And it never becomes a known status or a lane (never routed to todo).
  assert.equal(isKnownStatusFor('../../evil', columns), false);
  assert.equal(isUserStatus('../../evil', columns), false);
  assert.equal(laneForStatusFor('../../evil', columns), UNKNOWN_STATUS);
  assert.notEqual(laneForStatusFor('../../evil', columns), 'todo');
});

// -------------------------------------------------------------------------
// Scenario Outline: Unsafe slugs are excluded from the user-status set
// -------------------------------------------------------------------------
for (const slug of UNSAFE_SLUGS) {
  test(`Scenario Outline: unsafe slug ${JSON.stringify(slug)} is excluded from the user-status set`, () => {
    // Given a columns array containing { status: "<slug>", system: false }
    const columns = [...defaultConfig().columns, col(slug, false)];

    // Then isUserStatus("<slug>", columns) is false
    assert.equal(isUserStatus(slug, columns), false, `${slug}: not a user status`);

    // And isFsSafeSlug rejects it at the boundary predicate
    assert.equal(isFsSafeSlug(slug), false, `${slug}: not filesystem-safe`);

    // And laneForStatusFor("<slug>", columns) is "unknown" (never todo)
    assert.equal(laneForStatusFor(slug, columns), UNKNOWN_STATUS, `${slug}: routes to unknown`);
    assert.notEqual(laneForStatusFor(slug, columns), 'todo', `${slug}: never routed to todo`);

    // And laneStatusesFor(columns) does not include "<slug>"
    assert.equal(laneStatusesFor(columns).includes(slug), false, `${slug}: omitted from lane order`);
    // The board still degrades to exactly the fixed lanes (no extra/dropped lane).
    assert.deepEqual(laneStatusesFor(columns), LANE_STATUSES,
      `${slug}: unsafe slug leaves the fixed board intact`);

    // And it owns no folder / is never relocated.
    assert.equal(folderForStatusWith(slug, columns), null, `${slug}: owns no folder`);
    assert.deepEqual(reconcileFolderWith('', slug, columns),
      { needsMove: false, targetFolder: null }, `${slug}: never relocated`);
  });
}

// -------------------------------------------------------------------------
// Scenario: A valid user slug keeps working (regression)
// -------------------------------------------------------------------------
test('Scenario: A valid user slug keeps working (regression)', () => {
  // Given the default config columns plus { status: "ux-review", system: false }
  const columns = [...defaultConfig().columns, col('ux-review', false)];

  // Then folderForStatusWith("ux-review", columns) is "ux-review"
  assert.equal(folderForStatusWith('ux-review', columns), 'ux-review');
  assert.equal(isFsSafeSlug('ux-review'), true);
  assert.equal(isUserStatus('ux-review', columns), true);
  assert.equal(isKnownStatusFor('ux-review', columns), true);

  // And laneForStatusFor("ux-review", columns) is "ux-review"
  assert.equal(laneForStatusFor('ux-review', columns), 'ux-review');
  // And its lane appears in the ordered board (anchored after the default columns).
  assert.equal(laneStatusesFor(columns).includes('ux-review'), true);

  // And reconciling behaves exactly as before (top level → its folder).
  assert.deepEqual(reconcileFolderWith('', 'ux-review', columns),
    { needsMove: true, targetFolder: 'ux-review' });
  assert.deepEqual(reconcileFolderWith('ux-review', 'ux-review', columns),
    { needsMove: false, targetFolder: 'ux-review' });
  assert.equal(folderMatchesStatusWith('ux-review', 'ux-review', columns), true);

  // And a slug of exactly 30 [a-z0-9-] characters is likewise accepted.
  const columns30 = [...defaultConfig().columns, col(VALID_30, false)];
  assert.equal(VALID_30.length, 30);
  assert.equal(isFsSafeSlug(VALID_30), true);
  assert.equal(isUserStatus(VALID_30, columns30), true);
  assert.equal(folderForStatusWith(VALID_30, columns30), VALID_30);
  assert.equal(laneForStatusFor(VALID_30, columns30), VALID_30);
  assert.equal(laneStatusesFor(columns30).includes(VALID_30), true);
  assert.deepEqual(reconcileFolderWith('', VALID_30, columns30),
    { needsMove: true, targetFolder: VALID_30 });
});

// -------------------------------------------------------------------------
// Scenario: System statuses unaffected under any columns input
// -------------------------------------------------------------------------
test('Scenario: System statuses unaffected under any columns input', () => {
  // Given any columns value including null, [], junk, and arrays with unsafe slugs
  const columnsCases = [
    null,
    undefined,
    [],
    'not-an-array',
    42,
    {},
    [null, 7, 'x'],
    [col('../../evil', false)],
    [...defaultConfig().columns, col('../../evil', false), col('..', false), col('UX-Review', false)],
    [...defaultConfig().columns, col('ux-review', false)],
  ];

  for (const columns of columnsCases) {
    const label = JSON.stringify(columns);
    // Then every VALID_STATUSES entry still owns its own folder and degrades
    // exactly to folderForStatus / reconcileFolder / laneForStatus.
    for (const status of VALID_STATUSES) {
      assert.equal(folderForStatusWith(status, columns), folderForStatus(status),
        `${status}: folderForStatusWith matches folderForStatus for columns=${label}`);
      assert.equal(isKnownStatusFor(status, columns), isKnownStatus(status),
        `${status}: known-status unchanged for columns=${label}`);
      assert.equal(laneForStatusFor(status, columns), laneForStatus(status),
        `${status}: lane unchanged for columns=${label}`);
      for (const folder of ['', status, 'todo']) {
        assert.deepEqual(reconcileFolderWith(folder, status, columns),
          reconcileFolder(folder, status),
          `${status}: reconcile from ${JSON.stringify(folder)} unchanged for columns=${label}`);
      }
    }
  }
});

// -------------------------------------------------------------------------
// Scenario: Hostile input never throws (failure)
// -------------------------------------------------------------------------
test('Scenario: Hostile input never throws (failure)', () => {
  // Given columns containing Symbols, numbers, nested arrays, and getter-trap
  // objects (getters yielding hostile non-string slug values — the exact case the
  // typeof-guard in isFsSafeSlug defends). Configs are JSON, so this exceeds the
  // real threat model, yet the helpers must still degrade safely.
  const hostileColumns = [
    Symbol('sym'),
    42,
    ['nested', 'array'],
    { get status() { return Symbol('evil'); }, system: false },
    { get status() { return { toString() { return '../../evil'; } }; }, system: false },
    { get status() { return 123; }, system: false },
    { get status() { return () => '..'; }, system: false },
    { status: Symbol('s'), system: false },
    { status: 42, system: false },
    { status: null, system: false },
    null,
    undefined,
  ];

  // When the hardened helpers run
  // Then nothing throws and each returns its safe degraded result.
  assert.doesNotThrow(() => {
    for (const probe of ['../../evil', 'ux-review', 'todo', 'done', 'failed-testing', Symbol('q'), 123, null, undefined]) {
      isUserStatus(probe, hostileColumns);
      isKnownStatusFor(probe, hostileColumns);
      laneForStatusFor(probe, hostileColumns);
      folderForStatusWith(probe, hostileColumns);
      folderMatchesStatusWith('', probe, hostileColumns);
      reconcileFolderWith('', probe, hostileColumns);
    }
    laneStatusesFor(hostileColumns);
  });

  // And the degraded results are the safe system-only ones: no hostile slug
  // becomes a user status/folder/lane, while system statuses are untouched.
  assert.equal(folderForStatusWith('../../evil', hostileColumns), null);
  assert.equal(isUserStatus('../../evil', hostileColumns), false);
  assert.equal(folderForStatusWith('done', hostileColumns), 'done');
  assert.deepEqual(laneStatusesFor(hostileColumns), LANE_STATUSES);

  // And isFsSafeSlug itself never throws on hostile scalars.
  assert.doesNotThrow(() => {
    isFsSafeSlug(Symbol('x'));
    isFsSafeSlug(42);
    isFsSafeSlug(null);
    isFsSafeSlug(undefined);
    isFsSafeSlug({});
    isFsSafeSlug(() => {});
  });

  // And dedupeByFolder with per-entry columns declaring an unsafe slug degrades to
  // first-seen-wins and never throws (the unsafe status owns no folder to prefer).
  const columns = [...defaultConfig().columns, col('../../evil', false)];
  const a = { id: 'TASK-X', status: '../../evil', folder: '../../evil', columns, path: 'A' };
  const b = { id: 'TASK-X', status: '../../evil', folder: 'todo', columns, path: 'B' };
  let out;
  assert.doesNotThrow(() => { out = dedupeByFolder([a, b]); });
  assert.equal(out.length, 1);
  assert.equal(out[0].path, 'A', 'unsafe slug owns no folder → first-seen-wins');
});
