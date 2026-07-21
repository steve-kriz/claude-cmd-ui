'use strict';

// Unit tests for TASK-099: config-aware folder-per-status helpers in
// lib/ticket-folders.js.
//
// Covers the three new exports built on isKnownStatusFor (lib/ticket-lanes.js):
//   folderForStatusWith(status, columns)
//   folderMatchesStatusWith(folder, status, columns)
//   reconcileFolderWith(currentFolder, status, columns)
// plus the config-aware dedupeByFolder path (entries carrying an optional
// per-entry `columns` field) and the null/[]/junk-columns degrade-to-system
// edge cases.
//
// Everything under test is pure and Electron-free: NO database, filesystem, or
// network access happens (there is none to make), so all DB access is mocked
// away by construction. The existing test/ticket-folders.test.js is NOT touched
// and continues to guard the fixed system-only exports.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  folderForStatus,
  folderMatchesStatus,
  reconcileFolder,
  dedupeByFolder,
  folderForStatusWith,
  folderMatchesStatusWith,
  reconcileFolderWith,
} = require('../lib/ticket-folders');
const { LANE_STATUSES, VALID_STATUSES } = require('../lib/ticket-lanes');
const { defaultConfig } = require('../lib/team-config.js');

// A column of the shape lib/team-config.js normalises to.
function col(status, system) {
  return { status, label: status, description: '', agent: null, system };
}

// A board config with a user column `ux-review` anchored after `testing`.
function columnsWithUxReview() {
  const cols = defaultConfig().columns.slice();
  cols.push(col('ux-review', false));
  return cols;
}

// --- folderForStatusWith ---------------------------------------------------

test('folderForStatusWith: a configured user status owns a folder named for it', () => {
  const columns = columnsWithUxReview();
  assert.equal(folderForStatusWith('ux-review', columns), 'ux-review');
});

test('folderForStatusWith: an unconfigured user status owns no folder (null)', () => {
  // Default config has no ux-review column.
  assert.equal(folderForStatusWith('ux-review', defaultConfig().columns), null);
});

test('folderForStatusWith: every system/valid status owns its own folder for any config', () => {
  const columns = columnsWithUxReview();
  for (const s of VALID_STATUSES) {
    assert.equal(folderForStatusWith(s, columns), s, `${s} owns tasks/${s}`);
  }
});

test('folderForStatusWith: null/[]/junk columns degrade to folderForStatus exactly', () => {
  const cases = [null, undefined, [], 'nope', 42, {}, [null, 7, 'x'], [{ nope: true }]];
  const statuses = [...VALID_STATUSES, 'ux-review', 'archived', 'unknown', '', null, undefined, 'Todo'];
  for (const columns of cases) {
    for (const s of statuses) {
      assert.equal(folderForStatusWith(s, columns), folderForStatus(s),
        `folderForStatusWith(${JSON.stringify(s)}, ${JSON.stringify(columns)}) === folderForStatus`);
    }
  }
});

test('folderForStatusWith: a user column colliding with a system slug resolves as system', () => {
  // A malformed column claiming a reserved slug never becomes a user folder;
  // the system meaning wins and the slug still owns its own folder.
  const columns = [col('todo', false), col('failed-testing', false)];
  assert.equal(folderForStatusWith('todo', columns), 'todo');
  assert.equal(folderForStatusWith('failed-testing', columns), 'failed-testing');
});

test('folderForStatusWith: never throws on hostile input', () => {
  assert.doesNotThrow(() => folderForStatusWith('ux-review', { columns: 'lol' }));
  assert.doesNotThrow(() => folderForStatusWith(Symbol('x'), [Symbol('y')]));
});

// --- folderMatchesStatusWith -----------------------------------------------

test('folderMatchesStatusWith: true only when the folder equals the configured user folder', () => {
  const columns = columnsWithUxReview();
  assert.equal(folderMatchesStatusWith('ux-review', 'ux-review', columns), true);
  // Top level never matches a folder-owning status.
  assert.equal(folderMatchesStatusWith('', 'ux-review', columns), false);
  // A disagreeing folder does not match.
  assert.equal(folderMatchesStatusWith('todo', 'ux-review', columns), false);
});

test('folderMatchesStatusWith: an unconfigured user status never matches (owns no folder)', () => {
  const columns = defaultConfig().columns; // no ux-review
  assert.equal(folderMatchesStatusWith('ux-review', 'ux-review', columns), false);
  assert.equal(folderMatchesStatusWith('', 'ux-review', columns), false);
});

test('folderMatchesStatusWith: null/[]/junk columns degrade to folderMatchesStatus exactly', () => {
  const cases = [null, undefined, [], 'nope', {}, [null]];
  const rows = [
    ['todo', 'todo'], ['', 'todo'], ['todo', 'done'],
    ['ux-review', 'ux-review'], ['done', 'done'], ['archived', 'archived'],
  ];
  for (const columns of cases) {
    for (const [folder, status] of rows) {
      assert.equal(folderMatchesStatusWith(folder, status, columns),
        folderMatchesStatus(folder, status),
        `degrades for folder=${folder} status=${status} columns=${JSON.stringify(columns)}`);
    }
  }
});

// --- reconcileFolderWith ---------------------------------------------------

test('reconcileFolderWith: configured user status at top level needs a move to its folder', () => {
  const columns = columnsWithUxReview();
  assert.deepEqual(reconcileFolderWith('', 'ux-review', columns),
    { needsMove: true, targetFolder: 'ux-review' });
});

test('reconcileFolderWith: configured user status in a disagreeing folder moves to its folder', () => {
  const columns = columnsWithUxReview();
  assert.deepEqual(reconcileFolderWith('todo', 'ux-review', columns),
    { needsMove: true, targetFolder: 'ux-review' });
});

test('reconcileFolderWith: an already-matching configured user status needs no move', () => {
  const columns = columnsWithUxReview();
  assert.deepEqual(reconcileFolderWith('ux-review', 'ux-review', columns),
    { needsMove: false, targetFolder: 'ux-review' });
});

test('reconcileFolderWith: an unconfigured (removed) user status is left in place', () => {
  const columns = defaultConfig().columns; // ux-review removed
  for (const folder of ['', 'ux-review', 'todo']) {
    assert.deepEqual(reconcileFolderWith(folder, 'ux-review', columns),
      { needsMove: false, targetFolder: null },
      `removed status in folder=${JSON.stringify(folder)} never relocated`);
  }
});

test('reconcileFolderWith: null/[]/junk columns degrade to reconcileFolder exactly', () => {
  const cases = [null, undefined, [], 'nope', {}, [null, 3]];
  const rows = [['', 'in-progress'], ['todo', 'done'], ['done', 'done'], ['', 'ux-review'], ['x', 'archived']];
  for (const columns of cases) {
    for (const [folder, status] of rows) {
      assert.deepEqual(reconcileFolderWith(folder, status, columns),
        reconcileFolder(folder, status),
        `degrades for folder=${folder} status=${status} columns=${JSON.stringify(columns)}`);
    }
  }
});

test('reconcileFolderWith: system/valid statuses behave identically to reconcileFolder under any config', () => {
  const columns = columnsWithUxReview();
  for (const s of VALID_STATUSES) {
    for (const folder of ['', s, 'todo']) {
      assert.deepEqual(reconcileFolderWith(folder, s, columns),
        reconcileFolder(folder, s),
        `${s} from folder=${JSON.stringify(folder)} matches reconcileFolder`);
    }
  }
});

// --- dedupeByFolder (config-aware user-status path) ------------------------

test('dedupeByFolder: user-status copies keep the folder-matching copy when columns are attached', () => {
  const columns = columnsWithUxReview();
  const matching = { id: 'TASK-1', status: 'ux-review', folder: 'ux-review', columns, path: 'A' };
  const stray = { id: 'TASK-1', status: 'ux-review', folder: 'todo', columns, path: 'B' };
  // Stray first, matching second → matching wins.
  const out = dedupeByFolder([stray, matching]);
  assert.equal(out.length, 1);
  assert.equal(out[0].path, 'A', 'folder-matching user-status copy is kept');
  // Regardless of input order.
  const out2 = dedupeByFolder([matching, stray]);
  assert.equal(out2.length, 1);
  assert.equal(out2[0].path, 'A');
});

test('dedupeByFolder: without a columns field a user status cannot match, so first seen wins', () => {
  // No `columns` on the entries → ux-review owns no folder → neither copy
  // matches → first seen is kept (byte-identical to the pre-TASK-099 behaviour).
  const a = { id: 'TASK-2', status: 'ux-review', folder: 'ux-review', path: 'A' };
  const b = { id: 'TASK-2', status: 'ux-review', folder: 'todo', path: 'B' };
  const out = dedupeByFolder([a, b]);
  assert.equal(out.length, 1);
  assert.equal(out[0].path, 'A', 'no columns → no user folder ownership → first seen wins');
});

test('dedupeByFolder: system-status entries with NO columns behave exactly as before', () => {
  const matching = { id: 'TASK-3', status: 'done', folder: 'done', path: 'A' };
  const stray = { id: 'TASK-3', status: 'done', folder: 'todo', path: 'B' };
  const out = dedupeByFolder([stray, matching]);
  assert.equal(out.length, 1);
  assert.equal(out[0].path, 'A', 'system-status folder-match still preferred without columns');
});

test('dedupeByFolder: a removed user column falls back to first-seen (no copy owns a folder)', () => {
  const columns = defaultConfig().columns; // ux-review removed
  const a = { id: 'TASK-4', status: 'ux-review', folder: 'ux-review', columns, path: 'A' };
  const b = { id: 'TASK-4', status: 'ux-review', folder: 'todo', columns, path: 'B' };
  const out = dedupeByFolder([a, b]);
  assert.equal(out.length, 1);
  assert.equal(out[0].path, 'A', 'removed column → neither matches → first seen kept');
});

test('dedupeByFolder: junk columns on an entry never throw and degrade to system-only', () => {
  const matching = { id: 'TASK-5', status: 'done', folder: 'done', columns: 'garbage', path: 'A' };
  const stray = { id: 'TASK-5', status: 'done', folder: 'todo', columns: 42, path: 'B' };
  let out;
  assert.doesNotThrow(() => { out = dedupeByFolder([stray, matching]); });
  assert.equal(out.length, 1);
  assert.equal(out[0].path, 'A');
});
