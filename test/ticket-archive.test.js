'use strict';

// Unit tests for lib/ticket-archive.js — the Electron-free stale-done archiving
// helpers (TASK-065). The module is pure (no disk/network/Electron and it never
// reads the clock), so it is exercised directly with plain `node --test` and a
// FIXED injected `now`. No files are written by these tests.
//
// A source-scan block at the end verifies the renderer mirror
// (ticketIsArchived + the 5-day constant in renderer/renderer.js) stays in
// lockstep with this lib, mirroring test/tasks-working-indicator.test.js. The
// renderer is a browser script that cannot be required, so the mirror is checked
// against its source text.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  ARCHIVE_AFTER_DAYS,
  ARCHIVE_AFTER_MS,
  archiveTimestamp,
  isArchived,
  partitionArchived,
} = require('../lib/ticket-archive');

// A fixed reference "now" so every assertion is deterministic.
const NOW = Date.UTC(2026, 0, 20, 12, 0, 0); // 2026-01-20T12:00:00Z
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

test('constants are the documented 5-day threshold', () => {
  assert.equal(ARCHIVE_AFTER_DAYS, 5);
  assert.equal(ARCHIVE_AFTER_MS, 5 * 24 * 60 * 60 * 1000);
});

test('archiveTimestamp prefers updated, falls back to created, else null', () => {
  assert.equal(
    archiveTimestamp({ updated: iso(NOW), created: iso(NOW - 99 * DAY) }),
    NOW);
  assert.equal(archiveTimestamp({ created: iso(NOW) }), NOW);
  assert.equal(archiveTimestamp({}), null);
  assert.equal(archiveTimestamp(null), null);
});

test('archiveTimestamp is null (never NaN) for invalid stamps', () => {
  assert.equal(archiveTimestamp({ updated: 'not-a-date' }), null);
  assert.equal(archiveTimestamp({ updated: '', created: 'garbage' }), null);
  // invalid updated falls back to a valid created
  assert.equal(archiveTimestamp({ updated: 'nope', created: iso(NOW) }), NOW);
});

test('archiveTimestamp tolerates a { fm } wrapper', () => {
  assert.equal(archiveTimestamp({ fm: { updated: iso(NOW) } }), NOW);
});

test('isArchived: done ticket older than 5 days is archived', () => {
  assert.equal(isArchived({ status: 'done', updated: iso(NOW - 6 * DAY) }, NOW), true);
});

test('isArchived: exactly 5 days is NOT archived (strict >)', () => {
  assert.equal(isArchived({ status: 'done', updated: iso(NOW - 5 * DAY) }, NOW), false);
  // one ms past 5 days flips it archived
  assert.equal(isArchived({ status: 'done', updated: iso(NOW - 5 * DAY - 1) }, NOW), true);
});

test('isArchived: 5 days or less is NOT archived', () => {
  assert.equal(isArchived({ status: 'done', updated: iso(NOW - 4 * DAY) }, NOW), false);
  assert.equal(isArchived({ status: 'done', updated: iso(NOW) }, NOW), false);
});

test('isArchived: non-done statuses are never archived at any age', () => {
  const ancient = iso(NOW - 999 * DAY);
  for (const status of ['todo', 'defining', 'in-progress', 'testing',
    'post-processing', 'failed-testing', 'unknown']) {
    assert.equal(isArchived({ status, updated: ancient }, NOW), false, status);
  }
});

test('isArchived: falls back to created when updated missing', () => {
  assert.equal(isArchived({ status: 'done', created: iso(NOW - 6 * DAY) }, NOW), true);
});

test('isArchived: missing/invalid timestamps → false (fail-safe show)', () => {
  assert.equal(isArchived({ status: 'done' }, NOW), false);
  assert.equal(isArchived({ status: 'done', updated: 'garbage' }, NOW), false);
});

test('isArchived: future timestamp (negative age) → false', () => {
  assert.equal(isArchived({ status: 'done', updated: iso(NOW + 10 * DAY) }, NOW), false);
});

test('isArchived: missing/invalid now → false, never throws', () => {
  const fm = { status: 'done', updated: iso(NOW - 6 * DAY) };
  assert.equal(isArchived(fm, undefined), false);
  assert.equal(isArchived(fm, null), false);
  assert.equal(isArchived(fm, NaN), false);
  assert.equal(isArchived(fm, 'not-a-time'), false);
});

test('isArchived: accepts a Date now as well as epoch ms', () => {
  const fm = { status: 'done', updated: iso(NOW - 6 * DAY) };
  assert.equal(isArchived(fm, new Date(NOW)), true);
  assert.equal(isArchived({ ...fm }, new Date('invalid')), false);
});

test('partitionArchived splits by isArchived, preserving order, no mutation', () => {
  const entries = [
    { fm: { id: 1, status: 'done', updated: iso(NOW - 6 * DAY) } }, // archived
    { fm: { id: 2, status: 'done', updated: iso(NOW) } },           // visible
    { fm: { id: 3, status: 'todo', updated: iso(NOW - 99 * DAY) } },// visible
    { fm: { id: 4, status: 'done', updated: iso(NOW - 10 * DAY) } },// archived
  ];
  const snapshot = JSON.parse(JSON.stringify(entries));
  const { visible, archived } = partitionArchived(entries, NOW);
  assert.deepEqual(visible.map((e) => e.fm.id), [2, 3]);
  assert.deepEqual(archived.map((e) => e.fm.id), [1, 4]);
  // inputs untouched
  assert.deepEqual(entries, snapshot);
});

test('partitionArchived tolerates bare fm entries and empty input', () => {
  const { visible, archived } = partitionArchived(
    [{ status: 'done', updated: iso(NOW - 6 * DAY) }, { status: 'todo' }], NOW);
  assert.equal(archived.length, 1);
  assert.equal(visible.length, 1);
  assert.deepEqual(partitionArchived(undefined, NOW), { visible: [], archived: [] });
});

// ---------------------------------------------------------------------------
// Renderer mirror check (source scan). renderer/renderer.js cannot be required
// (browser script), so verify its duplicated predicate/constant matches the lib,
// like test/tasks-working-indicator.test.js. Keeps the two from drifting.
// ---------------------------------------------------------------------------
const RENDERER = path.join(__dirname, '..', 'renderer', 'renderer.js');
const rsrc = fs.readFileSync(RENDERER, 'utf8');

test('renderer mirrors the 5-day constant from lib/ticket-archive.js', () => {
  const m = rsrc.match(/const\s+TASKS_ARCHIVE_AFTER_DAYS\s*=\s*(\d+)/);
  assert.ok(m, 'TASKS_ARCHIVE_AFTER_DAYS declared in renderer.js');
  assert.equal(Number(m[1]), ARCHIVE_AFTER_DAYS);
  assert.match(rsrc, /TASKS_ARCHIVE_AFTER_MS\s*=\s*TASKS_ARCHIVE_AFTER_DAYS\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
});

test('renderer carries the mirrored ticketIsArchived predicate and sync note', () => {
  assert.match(rsrc, /function\s+ticketIsArchived\s*\(\s*fm\s*,\s*now\s*\)/);
  assert.match(rsrc, /function\s+ticketArchiveTimestamp\s*\(/);
  assert.match(rsrc, /lib\/ticket-archive\.js/);
  assert.match(rsrc, /keep in sync/i);
});

test('renderer gates the expander on ticketIsArchived and the done lane', () => {
  assert.match(rsrc, /laneKey === 'done' && ticketIsArchived\(tk\.fm, now\)/);
  assert.match(rsrc, /Archived \(\$\{archivedDoneCards\.length\}\)/);
});
