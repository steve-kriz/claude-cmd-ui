'use strict';

// ===========================================================================
// TASK-101 — UNIT tests for the renderer's team-config lane logic.
//
// Subject under test: the REAL renderer/renderer.js functions
//   normalizeTasksColumns(config)  — ordered system+user columns, junk-tolerant
//   tasksConfigSig(config, agents)  — render-signature change detection
// loaded headless via test/helpers/task-101-lane-harness.js (renderer.js is a
// browser script and cannot be require()d; the harness brace-extracts the real
// declarations and evaluates them with an injected window/document — the same
// convention as test/task-094-agents-panel.e2e.test.js).
//
// These are PURE functions: no DOM, no fs, no Electron, NO DB/network. The window
// passed to the harness only carries call-recording stubs that are never reached
// here.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers/task-101-lane-harness');

const { LANE_STATUSES } = require('../lib/ticket-lanes');

// One shared module instance is fine — normalizeTasksColumns / tasksConfigSig are
// pure and hold no state between calls.
const mod = H.loadLaneModule(H.makeWindow().window, H.makeDocument(), console);
const { normalizeTasksColumns, tasksConfigSig } = mod;

const SYSTEM_ORDER = ['todo', 'defining', 'in-progress', 'testing', 'done'];
const SYSTEM_LABELS = {
  todo: 'To Do', defining: 'Defining', 'in-progress': 'In Progress',
  testing: 'Testing', done: 'Done',
};

// ---------------------------------------------------------------------------
// normalizeTasksColumns — null / missing → the five canonical system columns
// ---------------------------------------------------------------------------
test('unit: normalizeTasksColumns(null) is the five system columns in canonical order', () => {
  const cols = normalizeTasksColumns(null);
  assert.deepEqual(cols.map((c) => c.status), SYSTEM_ORDER);
  // The renderer order matches the lib LANE_STATUSES enum (kept in lockstep).
  assert.deepEqual(cols.map((c) => c.status), LANE_STATUSES);
  // Every default column is a system column with its canonical label and no agent.
  for (const c of cols) {
    assert.equal(c.system, true, `${c.status} is a system column`);
    assert.equal(c.label, SYSTEM_LABELS[c.status], `${c.status} keeps its canonical label`);
    assert.equal(c.agent, null, `${c.status} has no agent`);
  }
});

test('unit: undefined / non-object / array / no-columns config all fall back to the five system defaults', () => {
  for (const junk of [undefined, 42, 'nope', true, [], {}, { columns: null }, { columns: 'x' }, { columns: 42 }]) {
    const cols = normalizeTasksColumns(junk);
    assert.deepEqual(cols.map((c) => c.status), SYSTEM_ORDER, `junk ${JSON.stringify(junk)} → defaults`);
    assert.ok(cols.every((c) => c.system === true));
  }
});

test('unit: junk ENTRIES inside columns are skipped, defaults still render', () => {
  const cols = normalizeTasksColumns({ columns: [null, 42, 'x', [], { nostatus: 1 }, { status: 123 }] });
  // None of the junk entries produced a column; the five system defaults remain.
  assert.deepEqual(cols.map((c) => c.status), SYSTEM_ORDER);
});

test('unit: normalizeTasksColumns never throws on hostile input', () => {
  const nasty = { columns: [{ status: { toString() { throw new Error('boom'); } } }, undefined, NaN] };
  assert.doesNotThrow(() => normalizeTasksColumns(nasty));
  assert.deepEqual(normalizeTasksColumns(nasty).map((c) => c.status), SYSTEM_ORDER);
});

// ---------------------------------------------------------------------------
// normalizeTasksColumns — user-column anchoring / ordering
// ---------------------------------------------------------------------------
test('unit: a user column anchors after the last system column preceding it in config', () => {
  const cols = normalizeTasksColumns({
    columns: [
      { status: 'todo' }, { status: 'defining' }, { status: 'in-progress' },
      { status: 'testing' }, { status: 'ux-review', label: 'UX Review' },
      { status: 'done' },
    ],
  });
  assert.deepEqual(cols.map((c) => c.status),
    ['todo', 'defining', 'in-progress', 'testing', 'ux-review', 'done']);
  const ux = cols.find((c) => c.status === 'ux-review');
  assert.equal(ux.system, false, 'ux-review is a user column');
  assert.equal(ux.label, 'UX Review');
});

test('unit: a user column before any system column anchors to the very front', () => {
  const cols = normalizeTasksColumns({ columns: [{ status: 'triage' }, { status: 'todo' }] });
  assert.equal(cols[0].status, 'triage', 'anchor=null user column leads the board');
  assert.equal(cols[0].system, false);
  // The five system columns still follow in canonical order.
  assert.deepEqual(cols.slice(1).map((c) => c.status), SYSTEM_ORDER);
});

test('unit: system columns are always emitted in canonical order regardless of config order', () => {
  // Config lists system columns shuffled; normalize re-imposes canonical order.
  const cols = normalizeTasksColumns({
    columns: [{ status: 'done' }, { status: 'todo' }, { status: 'testing' }],
  });
  assert.deepEqual(cols.map((c) => c.status), SYSTEM_ORDER);
});

test('unit: a system column may be relabeled but keeps its slot and system flag', () => {
  const cols = normalizeTasksColumns({ columns: [{ status: 'todo', label: 'Backlog' }] });
  const todo = cols.find((c) => c.status === 'todo');
  assert.equal(todo.label, 'Backlog');
  assert.equal(todo.system, true);
  assert.equal(cols[0].status, 'todo', 'still the first lane');
});

// ---------------------------------------------------------------------------
// normalizeTasksColumns — dropping reserved / duplicate / invalid user slugs
// ---------------------------------------------------------------------------
test('unit: reserved slugs (valid statuses, unknown, __wont-do__) never become user columns', () => {
  const cols = normalizeTasksColumns({
    columns: [
      { status: 'failed-testing' }, // reserved valid status
      { status: 'unknown' },        // reserved routing lane
      { status: '__wont-do__' },    // reserved archive marker
    ],
  });
  // All reserved → dropped; only the five system defaults remain.
  assert.deepEqual(cols.map((c) => c.status), SYSTEM_ORDER);
  assert.ok(cols.every((c) => c.system === true));
});

test('unit: a duplicate user slug is kept once (first wins)', () => {
  const cols = normalizeTasksColumns({
    columns: [{ status: 'todo' }, { status: 'ux-review', label: 'First' }, { status: 'ux-review', label: 'Second' }],
  });
  const uxs = cols.filter((c) => c.status === 'ux-review');
  assert.equal(uxs.length, 1, 'de-duplicated to a single ux-review lane');
  assert.equal(uxs[0].label, 'First', 'first occurrence wins');
});

test('unit: invalid slugs (uppercase, spaces, too long, empty) are dropped', () => {
  const cols = normalizeTasksColumns({
    columns: [
      { status: 'UX Review' },           // uppercase + space
      { status: 'has space' },           // space
      { status: 'x'.repeat(31) },        // > 30 chars
      { status: '' },                    // empty
      { status: '   ' },                 // whitespace-only → trims to ''
      { status: 'weird_slug' },          // underscore not in [a-z0-9-]
    ],
  });
  assert.deepEqual(cols.map((c) => c.status), SYSTEM_ORDER, 'no invalid slug survived');
});

test('unit: a valid slug of maximum length is kept; one over the limit is dropped', () => {
  const ok = 'a'.repeat(30);
  const tooLong = 'a'.repeat(31);
  const cols = normalizeTasksColumns({ columns: [{ status: ok }, { status: tooLong }] });
  assert.ok(cols.some((c) => c.status === ok), '30-char slug kept');
  assert.ok(!cols.some((c) => c.status === tooLong), '31-char slug dropped');
});

test('unit: a user column with no label falls back to a prettified slug', () => {
  const cols = normalizeTasksColumns({ columns: [{ status: 'ux-review' }] });
  const ux = cols.find((c) => c.status === 'ux-review');
  assert.equal(ux.label, 'Ux Review', 'slug prettified when no label given');
});

// ---------------------------------------------------------------------------
// tasksConfigSig — change detection
// ---------------------------------------------------------------------------
test('unit: tasksConfigSig is stable for equal inputs and defaults', () => {
  assert.equal(tasksConfigSig(null, null), tasksConfigSig(null, null));
  const cfg = { columns: [{ status: 'ux-review', label: 'UX' }] };
  assert.equal(tasksConfigSig(cfg, new Set(['ba'])), tasksConfigSig(cfg, new Set(['ba'])));
});

test('unit: adding a user column changes the signature', () => {
  const before = tasksConfigSig(null, null);
  const after = tasksConfigSig({ columns: [{ status: 'ux-review' }] }, null);
  assert.notEqual(before, after);
});

test('unit: changing a label, description or agent each changes the signature', () => {
  const base = { columns: [{ status: 'ux-review', label: 'UX', description: 'd', agent: 'a' }] };
  const sig = tasksConfigSig(base, null);
  assert.notEqual(sig, tasksConfigSig({ columns: [{ status: 'ux-review', label: 'CHANGED', description: 'd', agent: 'a' }] }, null));
  assert.notEqual(sig, tasksConfigSig({ columns: [{ status: 'ux-review', label: 'UX', description: 'CHANGED', agent: 'a' }] }, null));
  assert.notEqual(sig, tasksConfigSig({ columns: [{ status: 'ux-review', label: 'UX', description: 'd', agent: 'CHANGED' }] }, null));
});

test('unit: reordering user columns changes the signature (order is significant)', () => {
  const a = tasksConfigSig({ columns: [{ status: 'aaa' }, { status: 'bbb' }] }, null);
  const b = tasksConfigSig({ columns: [{ status: 'bbb' }, { status: 'aaa' }] }, null);
  assert.notEqual(a, b);
});

test('unit: adding an agent name to the set changes the signature; reordering the set does not', () => {
  const cfg = { columns: [{ status: 'ux-review' }] };
  const one = tasksConfigSig(cfg, new Set(['ba']));
  const two = tasksConfigSig(cfg, new Set(['ba', 'coder']));
  assert.notEqual(one, two, 'a new agent file changes the signature');
  // The agent set is sorted into the signature, so insertion order is irrelevant.
  assert.equal(tasksConfigSig(cfg, new Set(['ba', 'coder'])), tasksConfigSig(cfg, new Set(['coder', 'ba'])));
});

test('unit: a config change the board ignores (an invalid slug) does NOT change the signature', () => {
  // An invalid user slug is dropped by normalize, so it never enters the signature —
  // the board correctly does not re-render for a config edit it would ignore.
  const before = tasksConfigSig(null, null);
  const after = tasksConfigSig({ columns: [{ status: 'Invalid Slug' }] }, null);
  assert.equal(before, after);
});
