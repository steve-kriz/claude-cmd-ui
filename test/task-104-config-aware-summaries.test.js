'use strict';

// Unit tests for TASK-104: config-aware `formatTasksSummary(tickets, columns)`
// in lib/slack-commands.js. These exercise the pure formatter directly (no DB,
// no FS, no network — the function performs no I/O). Columns are built with the
// REAL lib/team-config.js `normalizeConfig` and, for the raw-shape guards, hand-
// built column arrays, matching test/slack-tasks-command.test.js patterns.
//
// Coverage: lane order, system-slug vs user-label rendering, failed-testing fold,
// the "unknown" piece appearing ONLY when present, and — the key semantic — the
// system active/"Currently working on" section staying pegged to
// defining/in-progress/testing regardless of any user columns.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { formatTasksSummary } = require('../lib/slack-commands');
const { normalizeConfig } = require('../lib/team-config');

const wrap = (fm) => ({ fm });
function countsLine(summary) {
  const lines = summary.split('\n').filter((l) => l.trim() !== '');
  return lines[lines.length - 1];
}

// ---------------------------------------------------------------------------
// Lane order + labels
// ---------------------------------------------------------------------------

test('user column is counted under its configured LABEL and system lanes keep raw slugs', () => {
  const cfg = normalizeConfig({
    version: 1,
    columns: [{ status: 'testing' }, { status: 'ux-review', label: 'UX Review', system: false }],
  });
  const board = [
    wrap({ id: 'T1', title: 'a', status: 'ux-review' }),
    wrap({ id: 'T2', title: 'b', status: 'ux-review' }),
    wrap({ id: 'T3', title: 'c', status: 'todo' }),
  ];
  const counts = countsLine(formatTasksSummary(board, cfg.columns));
  // System lanes render as raw slugs; the user column renders its label.
  assert.equal(
    counts,
    'todo 1 · defining 0 · in-progress 0 · testing 0 · UX Review 2 · post-processing 0 · done 0',
  );
});

test('lane pieces follow configured board order (user column between its anchor and the next system lane)', () => {
  const cfg = normalizeConfig({
    version: 1,
    columns: [{ status: 'todo' }, { status: 'triage', label: 'Triage', system: false }],
  });
  const counts = countsLine(formatTasksSummary([wrap({ id: 'T', title: 't', status: 'triage' })], cfg.columns));
  const pieces = counts.split(' · ').map((p) => p.replace(/ \d+$/, ''));
  assert.deepEqual(pieces, ['todo', 'Triage', 'defining', 'in-progress', 'testing', 'post-processing', 'done']);
});

// ---------------------------------------------------------------------------
// failed-testing fold
// ---------------------------------------------------------------------------

test('failed-testing folds into the testing lane count (never its own piece)', () => {
  const board = [
    wrap({ id: 'T1', title: 'a', status: 'failed-testing' }),
    wrap({ id: 'T2', title: 'b', status: 'testing' }),
  ];
  const counts = countsLine(formatTasksSummary(board, normalizeConfig(null).columns));
  assert.ok(counts.includes('testing 2'), `failed-testing folded into testing, got:\n${counts}`);
  assert.ok(!counts.includes('failed-testing'), 'no failed-testing count piece');
});

test('failed-testing folds into testing even with user columns present', () => {
  const cfg = normalizeConfig({ columns: [{ status: 'ux-review', label: 'UX Review', system: false }] });
  const board = [wrap({ id: 'T1', title: 'a', status: 'failed-testing' })];
  const counts = countsLine(formatTasksSummary(board, cfg.columns));
  assert.ok(counts.includes('testing 1'));
  assert.ok(counts.includes('UX Review 0'));
});

// ---------------------------------------------------------------------------
// unknown ONLY when present
// ---------------------------------------------------------------------------

test('an out-of-enum status produces a trailing "unknown N" piece', () => {
  const cfg = normalizeConfig({ columns: [{ status: 'ux-review', label: 'UX Review', system: false }] });
  const board = [
    wrap({ id: 'T1', title: 'a', status: 'nonsense' }),
    wrap({ id: 'T2', title: 'b', status: 'also-bogus' }),
  ];
  const counts = countsLine(formatTasksSummary(board, cfg.columns));
  assert.ok(counts.trim().endsWith('unknown 2'), `unknown 2 appended last, got:\n${counts}`);
});

test('NO "unknown" piece when every ticket routes to a known lane', () => {
  const cfg = normalizeConfig({ columns: [{ status: 'ux-review', label: 'UX Review', system: false }] });
  const board = [
    wrap({ id: 'T1', title: 'a', status: 'todo' }),
    wrap({ id: 'T2', title: 'b', status: 'ux-review' }),
    wrap({ id: 'T3', title: 'c', status: 'done' }),
  ];
  const counts = countsLine(formatTasksSummary(board, cfg.columns));
  assert.ok(!counts.includes('unknown'), `no unknown piece when all routed, got:\n${counts}`);
});

// ---------------------------------------------------------------------------
// system active count unaffected by user columns
// ---------------------------------------------------------------------------

test('the "Currently working on" section counts only defining/in-progress/testing — user columns never inflate it', () => {
  const cfg = normalizeConfig({
    version: 1,
    columns: [{ status: 'in-progress' }, { status: 'ux-review', label: 'UX Review', system: false }],
  });
  const board = [
    wrap({ id: 'T1', title: 'Active coder', status: 'in-progress' }),
    wrap({ id: 'T2', title: 'In user column', status: 'ux-review' }),
    wrap({ id: 'T3', title: 'Also user column', status: 'ux-review' }),
  ];
  const summary = formatTasksSummary(board, cfg.columns);

  // Only the in-progress ticket is under "Currently working on".
  assert.ok(summary.includes('*Currently working on:*'));
  assert.ok(summary.includes('T1 — Active coder (in-progress)'), 'system-active ticket is listed');
  assert.ok(!summary.includes('T2 — In user column'), 'ux-review ticket is NOT active work');
  assert.ok(!summary.includes('T3 — Also user column'), 'ux-review ticket is NOT active work');

  // But the counts line still reports both ux-review tickets under the column.
  assert.ok(countsLine(summary).includes('UX Review 2'));
});

test('a board with ONLY user-column tickets reports the idle sentinel (no system active work)', () => {
  const cfg = normalizeConfig({ columns: [{ status: 'ux-review', label: 'UX Review', system: false }] });
  const board = [wrap({ id: 'T1', title: 'a', status: 'ux-review' })];
  const summary = formatTasksSummary(board, cfg.columns);
  assert.ok(summary.includes('Nothing is being worked on right now.'), 'user columns do not count as active');
});

// ---------------------------------------------------------------------------
// tolerance / never-throws
// ---------------------------------------------------------------------------

test('junk columns degrade to the six fixed system lanes (never throws)', () => {
  const board = [wrap({ id: 'T1', title: 'a', status: 'todo' })];
  for (const junk of [null, undefined, 42, 'nope', [null, 7, {}]]) {
    let out;
    assert.doesNotThrow(() => {
      out = formatTasksSummary(board, junk);
    });
    assert.equal(
      countsLine(out),
      'todo 1 · defining 0 · in-progress 0 · testing 0 · post-processing 0 · done 0',
      `junk columns (${JSON.stringify(junk)}) → fixed system lanes`,
    );
  }
});

test('a hand-built raw column with system:true renders its raw slug, not its label', () => {
  // Guards the label rule directly (system lanes keep the raw slug even when a
  // label is present), independent of normalizeConfig.
  const cols = [
    { status: 'todo', label: 'To Do', system: true },
    { status: 'defining', label: 'Defining', system: true },
    { status: 'in-progress', label: 'In Progress', system: true },
    { status: 'testing', label: 'Testing', system: true },
    { status: 'post-processing', label: 'Post-processing', system: true },
    { status: 'done', label: 'Done', system: true },
  ];
  const counts = countsLine(formatTasksSummary([wrap({ id: 'T', title: 't', status: 'todo' })], cols));
  assert.equal(counts, 'todo 1 · defining 0 · in-progress 0 · testing 0 · post-processing 0 · done 0');
});
