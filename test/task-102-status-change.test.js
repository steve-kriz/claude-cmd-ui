'use strict';

// ===========================================================================
// TASK-102 — UNIT tests for the status-change plumbing that makes user columns
// fully usable on the Tasks board.
//
// Under test (all extracted from the REAL renderer/renderer.js via the shared
// headless harness — never a paraphrase):
//   - isSafeTasksSlug           filesystem-safety gate for status → folder slug
//   - ticketFolderForStatusWith config-aware tasks/<slug>/ folder ownership
//   - populateTaskStatusOptions the config-driven modal <select> builder
//   - dedupeTicketsByFolder     backward-compat when userStatuses is omitted
//
// renderer/renderer.js is a browser script (no module.exports, touches
// document/window), so — matching test/task-101-*.test.js — the functions are
// loaded headless against a mock DOM + a stubbed window.api.fs. NO DATABASE,
// REAL FILESYSTEM WRITE, OR NETWORK CALL IS MADE (all DB/fs mocked by
// construction; the only disk read is the app's own source, inside the harness).
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const laneHarness = require('./helpers/task-101-lane-harness');

// One headless module instance is enough: every function under test here is
// pure (populateTaskStatusOptions only mutates the select it is handed).
const document = laneHarness.makeDocument();
const mod = laneHarness.loadLaneModule(laneHarness.makeWindow().window, document, console);

// Build the validated user-status Set the config-aware helpers consume, exactly
// as the renderer does (tasksUserStatusSet(normalizeTasksColumns(config))).
function userSet(config) {
  return mod.tasksUserStatusSet(mod.normalizeTasksColumns(config));
}
// A config that inserts a `ux-review` user column right after `testing`.
const CONFIG_UX = {
  columns: [
    { status: 'todo' }, { status: 'defining' }, { status: 'in-progress' },
    { status: 'testing' }, { status: 'ux-review', label: 'UX Review' },
    { status: 'done' },
  ],
};

// ===========================================================================
// isSafeTasksSlug — the fs-safety allowlist gate
// ===========================================================================

test('isSafeTasksSlug: accepts a well-formed user slug', () => {
  assert.equal(mod.isSafeTasksSlug('ux-review'), true);
  assert.equal(mod.isSafeTasksSlug('a'), true);
  assert.equal(mod.isSafeTasksSlug('abc123'), true);
  // Exactly at the length bound (30) is allowed.
  assert.equal(mod.isSafeTasksSlug('a'.repeat(30)), true);
});

test('isSafeTasksSlug: every system status is also fs-safe', () => {
  for (const s of ['todo', 'defining', 'in-progress', 'testing', 'done', 'failed-testing']) {
    assert.equal(mod.isSafeTasksSlug(s), true, `${s} is fs-safe`);
  }
});

test('isSafeTasksSlug: rejects empty, dot and dot-dot (traversal)', () => {
  assert.equal(mod.isSafeTasksSlug(''), false);
  assert.equal(mod.isSafeTasksSlug('.'), false);
  assert.equal(mod.isSafeTasksSlug('..'), false);
});

test('isSafeTasksSlug: rejects any path separator', () => {
  assert.equal(mod.isSafeTasksSlug('a/b'), false);
  assert.equal(mod.isSafeTasksSlug('a\\b'), false);
  assert.equal(mod.isSafeTasksSlug('../../evil'), false);
  assert.equal(mod.isSafeTasksSlug('..\\..\\evil'), false);
});

test('isSafeTasksSlug: rejects uppercase, over-length and underscore/proto junk', () => {
  assert.equal(mod.isSafeTasksSlug('UPPER'), false);
  assert.equal(mod.isSafeTasksSlug('Ux-Review'), false);
  assert.equal(mod.isSafeTasksSlug('a'.repeat(31)), false, 'over the 30-char bound');
  assert.equal(mod.isSafeTasksSlug('__proto__'), false, 'underscores fail the [a-z0-9-] rule');
  assert.equal(mod.isSafeTasksSlug('has space'), false);
});

test('isSafeTasksSlug: non-strings never throw and are unsafe', () => {
  for (const bad of [null, undefined, 42, {}, [], true]) {
    assert.equal(mod.isSafeTasksSlug(bad), false, `${JSON.stringify(bad)} -> false`);
  }
});

// ===========================================================================
// ticketFolderForStatusWith — config-aware folder ownership
// ===========================================================================

test('ticketFolderForStatusWith: a system status owns tasks/<status>/ regardless of userStatuses', () => {
  const us = userSet(CONFIG_UX);
  for (const s of ['todo', 'in-progress', 'testing', 'done', 'failed-testing']) {
    assert.equal(mod.ticketFolderForStatusWith(s, us), s, `${s} owns tasks/${s}/`);
  }
});

test('ticketFolderForStatusWith: a CONFIGURED user column owns its own tasks/<slug>/', () => {
  const us = userSet(CONFIG_UX);
  assert.equal(mod.ticketFolderForStatusWith('ux-review', us), 'ux-review');
});

test('ticketFolderForStatusWith: an UNCONFIGURED / removed user status owns no folder (null)', () => {
  // Same slug, but NOT present in userStatuses (its column was removed / never added).
  assert.equal(mod.ticketFolderForStatusWith('ux-review', userSet(null)), null);
  assert.equal(mod.ticketFolderForStatusWith('ux-review', new Set()), null);
  // Genuine out-of-enum junk is likewise left in place.
  assert.equal(mod.ticketFolderForStatusWith('archived', userSet(CONFIG_UX)), null);
});

test('ticketFolderForStatusWith: an UNSAFE slug never resolves to a folder even if "configured"', () => {
  // A hand-forged Set claiming a traversal slug is "configured" must still be
  // gated out by isSafeTasksSlug — no tasks/<slug>/ path is ever produced.
  const evil = new Set(['../../evil', '..', 'a/b']);
  assert.equal(mod.ticketFolderForStatusWith('../../evil', evil), null);
  assert.equal(mod.ticketFolderForStatusWith('..', evil), null);
  assert.equal(mod.ticketFolderForStatusWith('a/b', evil), null);
});

test('ticketFolderForStatusWith: with no/empty userStatuses it is exactly the system-only helper', () => {
  assert.equal(mod.ticketFolderForStatusWith('todo', undefined), 'todo');
  assert.equal(mod.ticketFolderForStatusWith('ux-review', undefined), null);
  assert.equal(mod.ticketFolderForStatusWith('todo', new Set()), 'todo');
});

// ===========================================================================
// populateTaskStatusOptions — the config-driven modal <select> builder
// ===========================================================================

test('populateTaskStatusOptions: null config → the five system options in board order + "Won\'t do"', () => {
  const sel = document.createElement('select');
  mod.populateTaskStatusOptions(sel, mod.normalizeTasksColumns(null));
  assert.deepEqual(sel.children.map((o) => o.value),
    ['todo', 'defining', 'in-progress', 'testing', 'done', '__wont-do__']);
  // Labels are the fixed system headers (values remain the slugs).
  assert.deepEqual(sel.children.map((o) => o.textContent),
    ['To Do', 'Defining', 'In Progress', 'Testing', 'Done', "Won't do"]);
});

test('populateTaskStatusOptions: a user column is inserted at its board position (in order)', () => {
  const sel = document.createElement('select');
  mod.populateTaskStatusOptions(sel, mod.normalizeTasksColumns(CONFIG_UX));
  // ux-review is anchored to `testing`, so it sits between testing and done.
  assert.deepEqual(sel.children.map((o) => o.value),
    ['todo', 'defining', 'in-progress', 'testing', 'ux-review', 'done', '__wont-do__']);
  // The user column's configured label is used (value stays the slug).
  const ux = sel.children.find((o) => o.value === 'ux-review');
  assert.equal(ux.textContent, 'UX Review');
});

test('populateTaskStatusOptions: rebuilds from scratch (clears any prior options first)', () => {
  const sel = document.createElement('select');
  // A stale option lingering from a previous open.
  const stale = document.createElement('option');
  stale.value = 'stale';
  sel.appendChild(stale);
  mod.populateTaskStatusOptions(sel, mod.normalizeTasksColumns(null));
  assert.ok(!sel.children.some((o) => o.value === 'stale'), 'prior options wiped before rebuild');
  assert.equal(sel.children.length, 6, 'five system options + "Won\'t do"');
});

test('populateTaskStatusOptions: a label with markup is written as literal text (textContent, XSS-safe)', () => {
  const cfg = { columns: [{ status: 'ux-review', label: '<img src=x onerror=alert(1)>' }] };
  const sel = document.createElement('select');
  mod.populateTaskStatusOptions(sel, mod.normalizeTasksColumns(cfg));
  const ux = sel.children.find((o) => o.value === 'ux-review');
  assert.equal(ux.textContent, '<img src=x onerror=alert(1)>',
    'the untrusted label is stored as literal text, never parsed as markup');
});

// ===========================================================================
// dedupeTicketsByFolder — config-aware, backward-compatible when omitted
// ===========================================================================

function entry(id, status, folder) {
  return { file: `${id}.md`, path: folder ? `${folder}/${id}.md` : `${id}.md`, folder, fm: { id, status } };
}

test('dedupeTicketsByFolder: userStatuses OMITTED → system-only behaviour (prefers system folder-match)', () => {
  // Two copies of one SYSTEM-status ticket; the copy already in its status folder wins.
  const stray = entry('TASK-1', 'done', 'todo');
  const matching = entry('TASK-1', 'done', 'done');
  const out = mod.dedupeTicketsByFolder([stray, matching]);
  assert.equal(out.length, 1);
  assert.equal(out[0].folder, 'done', 'the folder-matching copy is kept');
  // Order-independent.
  assert.equal(mod.dedupeTicketsByFolder([matching, stray])[0].folder, 'done');
});

test('dedupeTicketsByFolder: userStatuses OMITTED → a USER-status copy is NOT treated as folder-matching', () => {
  // Without the user set, ux-review owns no folder, so neither copy "matches";
  // the first seen is kept (pure system-only degrade — backward compatible).
  const a = entry('TASK-2', 'ux-review', 'ux-review');
  const b = entry('TASK-2', 'ux-review', 'todo');
  const out = mod.dedupeTicketsByFolder([b, a]);
  assert.equal(out.length, 1);
  assert.equal(out[0].folder, 'todo', 'first seen kept when no folder can match (system-only)');
});

test('dedupeTicketsByFolder: WITH userStatuses → a user-column ticket prefers its tasks/<slug>/ copy', () => {
  const us = userSet(CONFIG_UX);
  const stray = entry('TASK-3', 'ux-review', 'todo');
  const matching = entry('TASK-3', 'ux-review', 'ux-review');
  const out = mod.dedupeTicketsByFolder([stray, matching], us);
  assert.equal(out.length, 1);
  assert.equal(out[0].folder, 'ux-review', 'config-aware: the ux-review folder copy wins');
});

test('dedupeTicketsByFolder: distinct ids all survive; id-less entries are dropped', () => {
  const out = mod.dedupeTicketsByFolder([
    entry('TASK-4', 'todo', 'todo'),
    { file: 'x.md', path: 'x.md', folder: '', fm: {} }, // no id
    entry('TASK-5', 'done', 'done'),
  ]);
  assert.deepEqual(out.map((e) => e.fm.id).sort(), ['TASK-4', 'TASK-5']);
});
