'use strict';

// ===========================================================================
// TASK-120 — UNIT tests for the pure-function logic that underpins the
// config-aware relocate destination-collision behaviour reviewed in TASK-120.
//
// TASK-120 is a TEST-ONLY review follow-up whose primary deliverable is e2e
// coverage of the rename-refusal branch of relocateTicketFile (see
// test/task-102-status-change.e2e.test.js). The fs plumbing (mkdir/rename
// refusal, no-data-loss) is inherently integration-shaped and is proven there.
//
// The genuinely UNIT-level pieces that DECIDE the collision outcome are two pure
// functions — extracted from the REAL renderer/renderer.js via the shared
// headless harness, never paraphrased:
//   - ticketFolderMatchesStatusWith  the config-aware folder-vs-status match
//   - dedupeTicketsByFolder          "the folder-matching copy wins" preference
//
// These are what make the ux-review occupant win over the stale todo copy when
// one id briefly exists in two folders (a collided move). Pinning them as units
// guards the decision independently of the fs harness.
//
// renderer/renderer.js is a browser script (no module.exports; touches
// document/window), so the functions are loaded headless against a mock DOM.
// NO DATABASE, REAL FILESYSTEM WRITE, OR NETWORK CALL IS MADE — all such calls
// are mocked by construction; the only disk read is the app's own source inside
// the harness.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const laneHarness = require('./helpers/task-101-lane-harness');

// One headless instance is enough: every function under test is pure.
const document = laneHarness.makeDocument();
const mod = laneHarness.loadLaneModule(laneHarness.makeWindow().window, document, console);

// A config that inserts a `ux-review` user column right after `testing`.
const CONFIG_UX = {
  columns: [
    { status: 'todo' }, { status: 'defining' }, { status: 'in-progress' },
    { status: 'testing' }, { status: 'ux-review', label: 'UX Review' },
    { status: 'post-processing' }, { status: 'done' },
  ],
};
// The same board WITHOUT the ux-review column.
const CONFIG_NO_UX = {
  columns: [
    { status: 'todo' }, { status: 'defining' }, { status: 'in-progress' },
    { status: 'testing' }, { status: 'post-processing' }, { status: 'done' },
  ],
};

function userSet(config) {
  return mod.tasksUserStatusSet(mod.normalizeTasksColumns(config));
}

// ===========================================================================
// ticketFolderMatchesStatusWith — the config-aware folder-vs-status predicate
// that dedupe uses to pick the winning copy on a collision.
// ===========================================================================

test('ticketFolderMatchesStatusWith: a user-status file sitting in its own tasks/<slug>/ matches', () => {
  const us = userSet(CONFIG_UX);
  // The ux-review occupant: folder ux-review, status ux-review → matches.
  assert.equal(mod.ticketFolderMatchesStatusWith('ux-review', 'ux-review', us), true);
});

test('ticketFolderMatchesStatusWith: the stale todo copy of a ux-review ticket does NOT match', () => {
  const us = userSet(CONFIG_UX);
  // The mover: folder todo, status ux-review → does NOT match (this copy loses).
  assert.equal(mod.ticketFolderMatchesStatusWith('todo', 'ux-review', us), false);
});

test('ticketFolderMatchesStatusWith: a removed-column status owns no folder, so neither copy matches', () => {
  // With ux-review removed from the config, its target folder is null → no match
  // regardless of where the file sits (routed to unknown, never relocated).
  const us = userSet(CONFIG_NO_UX);
  assert.equal(mod.ticketFolderMatchesStatusWith('ux-review', 'ux-review', us), false);
  assert.equal(mod.ticketFolderMatchesStatusWith('todo', 'ux-review', us), false);
});

test('ticketFolderMatchesStatusWith: a system status still matches with no userStatuses (backward compat)', () => {
  assert.equal(mod.ticketFolderMatchesStatusWith('done', 'done', undefined), true);
  assert.equal(mod.ticketFolderMatchesStatusWith('todo', 'done', undefined), false);
});

// ===========================================================================
// dedupeTicketsByFolder — "the folder-matching copy wins" on a collision. Two
// on-disk copies of one id must surface exactly ONCE on the board, and it must
// be the copy whose folder matches its status — independent of iteration order.
// ===========================================================================

const moverTodo = { file: 'TASK-15.md', path: 'C:\\proj\\tasks\\todo\\TASK-15.md',
  folder: 'todo', fm: { id: 'TASK-15', status: 'ux-review' }, body: '' };
const occUx = { file: 'TASK-15.md', path: 'C:\\proj\\tasks\\ux-review\\TASK-15.md',
  folder: 'ux-review', fm: { id: 'TASK-15', status: 'ux-review' }, body: '' };

test('dedupeTicketsByFolder: the ux-review folder-matching copy wins when the stale todo copy is seen first', () => {
  const us = userSet(CONFIG_UX);
  const out = mod.dedupeTicketsByFolder([moverTodo, occUx], us);
  assert.equal(out.length, 1, 'the id surfaces exactly once');
  assert.equal(out[0].folder, 'ux-review', 'the folder-matching copy wins over the first-seen stale copy');
  assert.equal(out[0].path, occUx.path);
});

test('dedupeTicketsByFolder: the ux-review copy still wins when it is seen first (order-independent)', () => {
  const us = userSet(CONFIG_UX);
  const out = mod.dedupeTicketsByFolder([occUx, moverTodo], us);
  assert.equal(out.length, 1);
  assert.equal(out[0].folder, 'ux-review', 'the matching copy is retained, not overwritten by the later stale copy');
  assert.equal(out[0].path, occUx.path);
});

test('dedupeTicketsByFolder (edge): with ux-review removed neither copy matches, so first-seen is kept', () => {
  // A user-status set WITHOUT ux-review: no copy folder-matches, so the config-
  // aware preference cannot fire and the first-seen copy is kept (dedupe still
  // collapses the id to one entry — no double render — with no data loss).
  const us = userSet(CONFIG_NO_UX);
  const out = mod.dedupeTicketsByFolder([moverTodo, occUx], us);
  assert.equal(out.length, 1, 'still exactly one entry for the id');
  assert.equal(out[0].path, moverTodo.path, 'first-seen kept when nothing folder-matches');
});

test('dedupeTicketsByFolder: distinct ids are all preserved (dedupe is per-id, not global)', () => {
  const us = userSet(CONFIG_UX);
  const other = { file: 'TASK-16.md', path: 'C:\\proj\\tasks\\todo\\TASK-16.md',
    folder: 'todo', fm: { id: 'TASK-16', status: 'todo' }, body: '' };
  const out = mod.dedupeTicketsByFolder([moverTodo, occUx, other], us);
  assert.equal(out.length, 2, 'two distinct ids survive');
  const ids = out.map((e) => e.fm.id).sort();
  assert.deepEqual(ids, ['TASK-15', 'TASK-16']);
});
