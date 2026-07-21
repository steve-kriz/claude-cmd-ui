'use strict';

// E2E cucumber-style scenarios for TASK-104: config-aware board summaries for
// the Slack `tasks` command. These are the ticket's Gherkin scenarios expressed
// as Given/When/Then `node --test` cases (no `cucumber` npm package — same
// scenario layout as the other slack-*.e2e.test.js files).
//
// Unlike test/slack-tasks-command.e2e.test.js (which drives the full renderer
// dispatch pipeline for TASK-058), this file targets the TASK-104 change itself:
// the REAL lib/slack-commands.js `formatTasksSummary(tickets, columns)` fed with
// REAL normalized columns from lib/team-config.js `normalizeConfig`. It is a pure
// function — no DB, no FS, no Slack/network. The board is an in-memory array of
// the same `{ fm }` wrapper shape the poll produces; team-config normalization is
// the only "config source", exercised in memory (no team-config.json read).
//
//   Feature: Config-aware summaries
//     Scenario: Summary includes a user column        (user column in board order)
//     Scenario: No config regression (edge)           (identical to fixed format)
//     Scenario: Unknown statuses reported, not hidden (failure)

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { formatTasksSummary } = require('../lib/slack-commands');
const { normalizeConfig } = require('../lib/team-config');

// The board-poll wrapper shape: Map/array of { fm } objects (frontmatter is
// authoritative). Bare fm objects are also tolerated by the formatter.
const wrap = (fm) => ({ fm });

// The trailing lane-counts line is the last non-empty line of the summary.
function countsLine(summary) {
  const lines = summary.split('\n').filter((l) => l.trim() !== '');
  return lines[lines.length - 1];
}

// ===========================================================================
// Feature: Config-aware summaries
// ===========================================================================

test('Scenario: Summary includes a user column — "UX Review 2" appears in board order', () => {
  // Given a team config that inserts a `ux-review` user column after Testing and
  // a board holding 2 tickets in that column (plus a couple of system-lane ones).
  const cfg = normalizeConfig({
    version: 1,
    columns: [
      { status: 'testing' }, // anchor: ux-review sits immediately after Testing
      { status: 'ux-review', label: 'UX Review', system: false },
    ],
  });
  // Sanity: normalization produced the ux-review user column in board order.
  const order = cfg.columns.map((c) => c.status);
  assert.deepEqual(
    order,
    ['todo', 'defining', 'in-progress', 'testing', 'ux-review', 'post-processing', 'done'],
    'ux-review is anchored after testing in board order',
  );

  const board = [
    wrap({ id: 'TASK-201', title: 'Design pass A', status: 'ux-review' }),
    wrap({ id: 'TASK-202', title: 'Design pass B', status: 'ux-review' }),
    wrap({ id: 'TASK-203', title: 'API', status: 'in-progress' }),
    wrap({ id: 'TASK-204', title: 'Backlog', status: 'todo' }),
  ];

  // When the Slack tasks summary is built with the config columns.
  const summary = formatTasksSummary(board, cfg.columns);
  const counts = countsLine(summary);

  // Then a "UX Review 2" entry appears in the counts line...
  assert.ok(counts.includes('UX Review 2'), `expected "UX Review 2" in:\n${counts}`);
  // ...and it sits in board order: after `testing`, before `post-processing`.
  const iTesting = counts.indexOf('testing ');
  const iUx = counts.indexOf('UX Review 2');
  const iPost = counts.indexOf('post-processing ');
  assert.ok(iTesting !== -1 && iUx !== -1 && iPost !== -1, 'all three lane pieces present');
  assert.ok(iTesting < iUx && iUx < iPost, `board order testing < ux-review < post-processing, got:\n${counts}`);

  // And the ux-review tickets did NOT inflate the system active section (working
  // stays defining/in-progress/testing only).
  assert.ok(summary.includes('TASK-203 — API (in-progress)'), 'the in-progress ticket is active');
  assert.ok(!summary.includes('TASK-201 — Design pass A'), 'ux-review is not reported as active work');
});

test('Scenario: No config regression (edge) — output identical to the current fixed format', () => {
  // Given a board and NO team config supplied.
  const board = [
    wrap({ id: 'TASK-101', title: 'API', status: 'in-progress' }),
    wrap({ id: 'TASK-102', title: 'UI', status: 'testing' }),
    wrap({ id: 'TASK-103', title: 'Docs', status: 'todo' }),
    wrap({ id: 'TASK-104', title: 'Flaky', status: 'failed-testing' }),
  ];

  // When the summary is built one-arg (historic call) vs with the DEFAULT config
  // columns (normalizeConfig(null) → the six system columns).
  const oneArg = formatTasksSummary(board);
  const defaultCols = normalizeConfig(null).columns;
  const withDefault = formatTasksSummary(board, defaultCols);

  // Then the output is byte-identical (regression: default config == fixed lanes).
  assert.equal(withDefault, oneArg, 'default-config summary is byte-identical to the one-arg summary');

  // And it is exactly the historic fixed-lane counts line (raw system slugs,
  // failed-testing folded into testing, no unknown piece).
  assert.equal(
    countsLine(oneArg),
    'todo 1 · defining 0 · in-progress 1 · testing 2 · post-processing 0 · done 0',
    'fixed-lane counts, failed-testing folded into testing',
  );
});

test('Scenario: Unknown statuses reported, not hidden (failure) — a ticket in no column becomes an unknown count', () => {
  // Given a config with a ux-review column and a ticket whose status matches NO
  // column (neither a system lane nor the declared user column).
  const cfg = normalizeConfig({
    version: 1,
    columns: [{ status: 'in-progress' }, { status: 'ux-review', label: 'UX Review', system: false }],
  });
  const board = [
    wrap({ id: 'TASK-301', title: 'Normal', status: 'todo' }),
    wrap({ id: 'TASK-302', title: 'Orphaned', status: 'legacy-blocked' }),
  ];

  // When the summary is built.
  const summary = formatTasksSummary(board, cfg.columns);
  const counts = countsLine(summary);

  // Then an "unknown 1" count appears (the orphaned ticket is REPORTED, not
  // silently dropped) and it is appended last.
  assert.ok(counts.includes('unknown 1'), `expected "unknown 1" in:\n${counts}`);
  assert.ok(counts.trim().endsWith('unknown 1'), `unknown piece is appended last, got:\n${counts}`);
  // And a status that is not out-of-enum never produces a spurious unknown piece:
  // the todo ticket is counted under its own lane.
  assert.ok(counts.includes('todo 1'), 'the in-enum ticket is counted under its lane');
});

// ---------------------------------------------------------------------------
// Additional edge / failure paths called out in the ticket.
// ---------------------------------------------------------------------------

test('Scenario (edge): empty board with config still returns the empty sentinel — never throws', () => {
  // Given a valid config but an empty board.
  const cfg = normalizeConfig({ columns: [{ status: 'ux-review', label: 'UX Review', system: false }] });

  // When the summary is built for zero tickets.
  let out;
  assert.doesNotThrow(() => {
    out = formatTasksSummary([], cfg.columns);
  });

  // Then it is exactly the empty-board sentinel (config makes no difference here).
  assert.equal(out, 'The tasks board is empty.');
});

test('Scenario (edge): a user label with Slack-meaningful characters is passed through verbatim (escaping is not this layer)', () => {
  // Given a user column whose label contains Slack-mrkdwn-meaningful characters.
  const cfg = normalizeConfig({
    version: 1,
    columns: [{ status: 'defining' }, { status: 'qa', label: 'Q&A <review>', system: false }],
  });
  const board = [wrap({ id: 'TASK-401', title: 'Check', status: 'qa' })];

  // When the summary is built.
  const counts = countsLine(formatTasksSummary(board, cfg.columns));

  // Then the configured label is emitted verbatim (the formatter does NOT escape;
  // the existing lib/slack-* escaping path owns that and is not bypassed here).
  assert.ok(counts.includes('Q&A <review> 1'), `label passed through verbatim, got:\n${counts}`);
});
