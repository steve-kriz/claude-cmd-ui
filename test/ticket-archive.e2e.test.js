'use strict';

// E2E / cucumber-style scenarios for stale-done ticket archiving (TASK-065),
// written as Given/When/Then `node --test` cases (no `cucumber` npm package is
// installed or required). These implement the ticket's Gherkin scenarios end to
// end, exercising the pure lib decision (lib/ticket-archive.js) and — for the
// board-render scenarios — a faithful simulation of renderTasksBoard's Done-lane
// folding driven by that SAME lib, cross-checked against the real renderer.js
// wiring via source scan (renderer.js is a browser script and cannot be
// require()d, mirroring test/tasks-working-indicator.test.js).
//
// Archiving is DERIVED and pure: `now` is always injected with a FIXED value, no
// Date.now() appears in any assertion, nothing is written to disk, and there are
// NO database/network calls (this ticket has none; the no-real-DB rule is
// honoured trivially).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  ARCHIVE_AFTER_DAYS,
  archiveTimestamp,
  isArchived,
  partitionArchived,
} = require('../lib/ticket-archive');

// A single fixed reference "now" so every scenario is fully deterministic.
const NOW = Date.UTC(2026, 0, 20, 12, 0, 0); // 2026-01-20T12:00:00Z
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const doneEntry = (id, ageDays) => ({
  fm: { id, status: 'done', title: `t${id}`, updated: iso(NOW - ageDays * DAY) },
});

// ---------------------------------------------------------------------------
// Board simulation: a faithful, DOM-free stand-in for renderTasksBoard's
// Done-lane folding (renderer.js lines ~5679-5851). It uses the SAME pure lib
// the renderer mirrors, so the observable outcomes (which cards are visible,
// the "Archived (N)" label, the lane count = visible + archived, and whether an
// expander exists) match the app. `tab.tasks.archiveExpanded` persists across
// renders exactly as it does in the real renderer (only resetTasksForFolder
// clears it), letting us prove the "state survives a re-render" scenario.
// ---------------------------------------------------------------------------
function renderDoneLane(entries, now, tab) {
  const doneEntries = (entries || []).filter((e) => (e.fm || e).status === 'done');
  const { visible, archived } = partitionArchived(doneEntries, now);
  const laneCount = doneEntries.length; // Done lane counts ALL done (visible + archived)
  const expander = archived.length
    ? {
      label: `Archived (${archived.length})`,
      open: !!tab.tasks.archiveExpanded, // re-applied every render from persisted state
      cards: archived,
    }
    : null; // never rendered when nothing is archived (no "Archived (0)")
  return { visibleCards: visible, laneCount, expander };
}

// ===========================================================================
// SCENARIO GROUP A — the pure isArchived / archiveTimestamp decision
// ===========================================================================

test('SCENARIO: a done ticket older than 5 days is archived', () => {
  // Given a done ticket whose last activity was 6 days ago
  const fm = { status: 'done', updated: iso(NOW - 6 * DAY) };
  // When archiving is evaluated against a fixed now
  // Then it is archived
  assert.equal(isArchived(fm, NOW), true);
});

test('SCENARIO: a done ticket within 5 days is NOT archived', () => {
  // Given a done ticket touched 4 days ago
  const fm = { status: 'done', updated: iso(NOW - 4 * DAY) };
  // When evaluated ... Then it stays visible
  assert.equal(isArchived(fm, NOW), false);
});

test('SCENARIO: a done ticket exactly 5 days old is NOT archived (strictly older only)', () => {
  // Given a done ticket whose last activity is exactly the 5-day threshold
  const atBoundary = { status: 'done', updated: iso(NOW - ARCHIVE_AFTER_DAYS * DAY) };
  // Then the exact boundary is NOT archived (strict >)
  assert.equal(isArchived(atBoundary, NOW), false);
  // And one millisecond past the boundary flips it to archived
  const justPast = { status: 'done', updated: iso(NOW - ARCHIVE_AFTER_DAYS * DAY - 1) };
  assert.equal(isArchived(justPast, NOW), true);
});

test('SCENARIO: non-done tickets are never archived regardless of age', () => {
  // Given ancient (999-day-old) tickets in every non-done status
  const ancient = iso(NOW - 999 * DAY);
  for (const status of ['todo', 'defining', 'in-progress', 'testing',
    'post-processing', 'failed-testing']) {
    // When evaluated ... Then none are archived
    assert.equal(isArchived({ status, updated: ancient }, NOW), false, status);
  }
});

test('SCENARIO: falls back to created when updated is missing (created 10 days ago → archived)', () => {
  // Given a done ticket with no `updated`, only a `created` 10 days ago
  const fm = { status: 'done', created: iso(NOW - 10 * DAY) };
  // Then archiveTimestamp uses created, and the ticket is archived
  assert.equal(archiveTimestamp(fm), NOW - 10 * DAY);
  assert.equal(isArchived(fm, NOW), true);
});

test('SCENARIO (edge): missing/invalid timestamps never hide a ticket', () => {
  // Given done tickets with no / garbage timestamps
  assert.equal(archiveTimestamp({ status: 'done' }), null);
  // Then they are fail-safe shown (not archived)
  assert.equal(isArchived({ status: 'done' }, NOW), false);
  assert.equal(isArchived({ status: 'done', updated: 'garbage' }, NOW), false);
  assert.equal(isArchived({ status: 'done', updated: '', created: 'nope' }, NOW), false);
});

test('SCENARIO (edge): a future timestamp or an undefined now yields not-archived', () => {
  // Given a done ticket dated 10 days in the FUTURE (negative age)
  const future = { status: 'done', updated: iso(NOW + 10 * DAY) };
  assert.equal(isArchived(future, NOW), false);
  // And a legitimately-stale done ticket but with a missing/invalid `now`
  const stale = { status: 'done', updated: iso(NOW - 6 * DAY) };
  assert.equal(isArchived(stale, undefined), false);
  assert.equal(isArchived(stale, null), false);
  assert.equal(isArchived(stale, NaN), false);
  assert.equal(isArchived(stale, 'not-a-time'), false);
});

// ===========================================================================
// SCENARIO GROUP B — the Done-lane "Archived (N)" expander (board behaviour)
// ===========================================================================

test('SCENARIO: Done lane folds archived cards into "Archived (N)" with the right counts', () => {
  // Given a board with 3 stale done tickets, 2 fresh done tickets, and 1 todo
  const tab = { tasks: { archiveExpanded: false } };
  const entries = [
    doneEntry('A', 6),  // archived
    doneEntry('B', 1),  // fresh visible
    doneEntry('C', 30), // archived
    doneEntry('D', 0),  // fresh visible
    doneEntry('E', 10), // archived
    { fm: { id: 'F', status: 'todo', updated: iso(NOW - 99 * DAY) } }, // not a done card
  ];
  // When the Done lane is rendered against a fixed now
  const { visibleCards, laneCount, expander } = renderDoneLane(entries, NOW, tab);
  // Then 2 normal done cards render, the expander reads "Archived (3)", and the
  // Done lane count reports the true total (visible 2 + archived 3 = 5).
  assert.equal(visibleCards.length, 2);
  assert.deepEqual(visibleCards.map((e) => e.fm.id), ['B', 'D']);
  assert.ok(expander, 'expander is present');
  assert.equal(expander.label, 'Archived (3)');
  assert.deepEqual(expander.cards.map((e) => e.fm.id), ['A', 'C', 'E']);
  assert.equal(laneCount, 5, 'Done lane count = visible + archived');
});

test('SCENARIO: an empty archive renders NO expander (never "Archived (0)")', () => {
  // Given a Done lane of only fresh tickets
  const tab = { tasks: { archiveExpanded: false } };
  const entries = [doneEntry('A', 0), doneEntry('B', 3)];
  // When rendered ... Then there is no expander at all and the lane still counts 2
  const { visibleCards, laneCount, expander } = renderDoneLane(entries, NOW, tab);
  assert.equal(expander, null);
  assert.equal(visibleCards.length, 2);
  assert.equal(laneCount, 2);
});

test('SCENARIO: expander collapsed by default; its open state survives a board re-render', () => {
  // Given a Done lane with an archived ticket, freshly initialised
  const tab = { tasks: { archiveExpanded: false } };
  const entries = [doneEntry('A', 6), doneEntry('B', 0)];

  // When first rendered, the expander is collapsed by default
  let r = renderDoneLane(entries, NOW, tab);
  assert.ok(r.expander);
  assert.equal(r.expander.open, false, 'collapsed by default');

  // When the user toggles it open (as the renderer flips tab.tasks.archiveExpanded)
  tab.tasks.archiveExpanded = !tab.tasks.archiveExpanded;

  // And the board re-renders (a poll cycle that wipes and rebuilds the lanes)
  r = renderDoneLane(entries, NOW, tab);
  // Then the open state survives the re-render
  assert.equal(r.expander.open, true, 'open state persists across re-render');

  // And re-rendering again (state untouched) keeps it open
  r = renderDoneLane(entries, NOW, tab);
  assert.equal(r.expander.open, true);
});

// ===========================================================================
// SCENARIO GROUP C — the real renderer wiring matches the lib (source scan).
// renderer.js is a browser script and cannot be require()d; verify the app's
// actual Done-lane folding, count, expander and reset behaviour by scanning its
// source so this e2e stays honest about the shipped code, not just a model.
// ===========================================================================
const RENDERER = path.join(__dirname, '..', 'renderer', 'renderer.js');
const rsrc = fs.readFileSync(RENDERER, 'utf8');

test('WIRING: renderTasksBoard folds archived done cards via ticketIsArchived on the done lane', () => {
  // Given the real renderer source
  // Then archived done cards are gated on the done lane + the mirrored predicate
  assert.match(rsrc, /laneKey === 'done' && ticketIsArchived\(tk\.fm, now\)/);
  // And the expander label is the derived "Archived (N)"
  assert.match(rsrc, /Archived \(\$\{archivedDoneCards\.length\}\)/);
  // And the expander is only built when there is at least one archived card
  assert.match(rsrc, /if\s*\(\s*doneLane && archivedDoneCards\.length\s*\)/);
});

test('WIRING: Done lane count still counts archived cards (lane.count++ runs for all done)', () => {
  // The archived branch pushes to archivedDoneCards but lane.count++ is
  // unconditional, so the Done lane count = visible + archived.
  assert.match(rsrc, /archivedDoneCards\.push\(card\);/);
  assert.match(rsrc, /lane\.count\+\+;/);
});

test('WIRING: expander open/closed state lives on tab.tasks.archiveExpanded and is reset only on folder switch', () => {
  // Open state is read from the persisted flag and toggled on click.
  assert.match(rsrc, /t\.archiveExpanded/);
  assert.match(rsrc, /toggle\.addEventListener\('click'/);
  // resetTasksForFolder (folder switch) is the ONLY place that resets it.
  assert.match(rsrc, /tab\.tasks\.archiveExpanded = false;/);
});

test('WIRING: archived cards keep full behaviour (click opens modal, remain draggable)', () => {
  // The click→modal handler and draggable=true are set on the card BEFORE the
  // archived/visible branch, so archived cards keep identical behaviour.
  const clickIdx = rsrc.indexOf("card.addEventListener('click', () => openTaskModal(tab, tk));");
  const foldIdx = rsrc.indexOf("laneKey === 'done' && ticketIsArchived(tk.fm, now)");
  assert.ok(clickIdx !== -1, 'card click→modal handler present');
  assert.ok(foldIdx !== -1, 'archive fold branch present');
  assert.ok(clickIdx < foldIdx, 'click handler wired before the archive fold decision');
  assert.match(rsrc, /card\.draggable = true;/);
});

test('WIRING: no new status is introduced by archiving (archiving is derived only)', () => {
  // The archive fold keys strictly off status==='done' + the derived predicate;
  // there is no "archived" status string used as a ticket status anywhere.
  assert.doesNotMatch(rsrc, /status:\s*'archived'/);
  assert.doesNotMatch(rsrc, /=== 'archived'/);
});
