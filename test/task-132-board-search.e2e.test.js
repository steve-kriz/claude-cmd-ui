'use strict';

// ===========================================================================
// TASK-132 — e2e "cucumber" scenarios (Given/When/Then), implemented as plain
// `node --test` cases. NO `cucumber` npm package is installed or required.
//
// Feature: the Tasks tab toolbar has a search input that live-filters ticket
// cards by a case-insensitive, literal substring of their id, title, or body.
// Each scenario drives the REAL shipped renderer functions
//   renderTasksBoard(tab)       — builds lanes + routes cards, filter-aware
//   onTasksSearchInput(tab)     — the `input` handler (snapshot value → render)
//   clearTasksSearch(tab)       — the clear affordance / Escape / create+plan path
//   pollTasksOnce(tab, force)   — the live poll re-render
// via test/helpers/task-101-lane-harness.js, which brace-extracts the real
// renderer/renderer.js declarations and runs them against a minimal in-memory
// mock DOM + a stubbed window.api.fs.
//
// EVERY database / filesystem / Electron call is MOCKED — window.api.fs is an
// in-memory stub, the DOM is a plain object tree; NO real DB / disk / network is
// touched. The board is driven end to end exactly as the app would drive it.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers/task-101-lane-harness');

const {
  loadLaneModule, makeWindow, makeDocument, makeTab, ticketsMap,
  laneEls, laneStatuses, findByClass, findAllByClass, fire, rendererSrc,
} = H;

// Fresh module + tab per scenario (module-level drag state must not leak).
function fresh(opts) {
  const { window } = makeWindow();
  const mod = loadLaneModule(window, makeDocument(), console);
  return { mod, window, tab: makeTab(opts) };
}
function lane(tab, status) {
  return laneEls(tab).find((el) => el.dataset.status === status);
}
function laneCount(tab, status) {
  const el = findByClass(lane(tab, status), 'tasks-lane-count');
  return el ? el.textContent : null;
}
function laneHidden(tab, status) {
  return lane(tab, status).classList.contains('hidden');
}
// The ids of the ticket cards actually appended to lane DOM (i.e. visible).
function visibleIds(tab) {
  return findAllByClass(tab.els.tasksBoard, 'task-card')
    .map((c) => findByClass(c, 'task-card-id').textContent)
    .sort();
}
// Simulate the user typing into the search box: set the input value and fire the
// real `input` handler, which snapshots the value into tab.tasks.searchQuery and
// re-renders synchronously.
function type(mod, tab, text) {
  tab.els.tasksSearch.value = text;
  mod.onTasksSearchInput(tab);
}

// The 3-ticket background board (Gherkin Background), built in memory.
function backgroundTickets() {
  return ticketsMap([
    { fm: { id: 'TASK-001', title: 'Add login form', status: 'todo' }, body: 'validate credentials' },
    { fm: { id: 'TASK-002', title: 'Fix logout crash', status: 'in-progress' }, body: 'null pointer' },
    { fm: { id: 'TASK-003', title: 'Polish dashboard styles', status: 'done' }, body: 'CSS cleanup' },
  ]);
}

// A ticket .md file body for the poll-driven scenarios.
function md(id, title, status, body, updated) {
  return `---\nid: ${id}\ntitle: ${title}\nstatus: ${status}\nupdated: ${updated || '2026-01-01T00:00:00.000Z'}\n---\n${body || ''}\n`;
}
// A poll-driven board: tickets live "on disk" (the in-memory fs stub) and reach
// the board only through pollTasksOnce, exactly like the running app.
function pollFresh(ticketFiles) {
  const folder = 'C:\\proj';
  const tasksDir = folder + '\\tasks';
  const files = {};
  const paths = [];
  for (const tf of ticketFiles) {
    const p = tasksDir + '\\' + tf.name;
    files[p] = tf.content;
    paths.push(p);
  }
  const mw = makeWindow({ files, dirs: { [tasksDir]: paths } });
  const mod = loadLaneModule(mw.window, makeDocument(), console);
  const tab = makeTab({ folder });
  return { mod, tab, window: mw.window, files: mw.files, dirs: mw.dirs, tasksDir };
}

// ===========================================================================
// Scenario: Matching by title, case-insensitively
// ===========================================================================
test('Scenario: matching by title, case-insensitively', () => {
  // Given the 3-ticket board is active
  const { mod, tab } = fresh({ tickets: backgroundTickets() });
  mod.renderTasksBoard(tab);
  // When I type "LOGIN" into the Tasks search box
  type(mod, tab, 'LOGIN');
  // Then only the card "TASK-001" is visible on the board
  assert.deepEqual(visibleIds(tab), ['TASK-001']);
  // And the "todo" lane count shows 1
  assert.equal(laneCount(tab, 'todo'), '1');
  // And the "in-progress" and "done" lane counts show 0
  assert.equal(laneCount(tab, 'in-progress'), '0');
  assert.equal(laneCount(tab, 'done'), '0');
  // And the lanes with zero matches remain visible but empty
  assert.equal(laneHidden(tab, 'in-progress'), false, 'zero-match lane stays visible');
  assert.equal(laneHidden(tab, 'done'), false, 'zero-match lane stays visible');
  assert.equal(findAllByClass(lane(tab, 'in-progress'), 'task-card').length, 0, 'but empty');
  // And the unknown lane keeps its historic hide-at-0 behaviour.
  assert.equal(laneHidden(tab, 'unknown'), true, 'unknown lane stays hidden at count 0');
});

// ===========================================================================
// Scenario: Matching by ticket id
// ===========================================================================
test('Scenario: matching by ticket id (shows "1 of 3 tickets")', () => {
  const { mod, tab } = fresh({ tickets: backgroundTickets() });
  mod.renderTasksBoard(tab);
  // When I type "task-002" into the Tasks search box
  type(mod, tab, 'task-002');
  // Then only the card "TASK-002" is visible
  assert.deepEqual(visibleIds(tab), ['TASK-002']);
  // And the toolbar status line shows "1 of 3 tickets" (the "· 1 running" fragment
  // comes from the in-progress TASK-002 in the FULL set, even though it is filtered
  // out of view — running is computed from all tickets, never the filtered subset).
  assert.equal(tab.els.tasksStatus.textContent, '1 of 3 tickets · 1 running');
});

// ===========================================================================
// Scenario: Matching by body text
// ===========================================================================
test('Scenario: matching by body text', () => {
  const { mod, tab } = fresh({ tickets: backgroundTickets() });
  mod.renderTasksBoard(tab);
  // When I type "null pointer" into the Tasks search box
  type(mod, tab, 'null pointer');
  // Then only the card "TASK-002" is visible
  assert.deepEqual(visibleIds(tab), ['TASK-002']);
});

// ===========================================================================
// Scenario: Empty query shows the full board
// ===========================================================================
test('Scenario: clearing the query shows the full board again', () => {
  const { mod, tab } = fresh({ tickets: backgroundTickets() });
  mod.renderTasksBoard(tab);
  // Given I have typed "login" into the Tasks search box
  type(mod, tab, 'login');
  assert.deepEqual(visibleIds(tab), ['TASK-001']);
  // When I clear the search box (deleting the text)
  type(mod, tab, '');
  // Then all 3 cards are visible in their lanes
  assert.deepEqual(visibleIds(tab), ['TASK-001', 'TASK-002', 'TASK-003']);
  // And every lane count shows its true total
  assert.equal(laneCount(tab, 'todo'), '1');
  assert.equal(laneCount(tab, 'in-progress'), '1');
  assert.equal(laneCount(tab, 'done'), '1');
  // And the toolbar status line shows the unfiltered "3 tickets" form (+ the
  // running fragment from the in-progress TASK-002).
  assert.equal(tab.els.tasksStatus.textContent, '3 tickets · 1 running');
});

// ===========================================================================
// Scenario: Whitespace-only query is treated as empty (edge)
// ===========================================================================
test('Scenario (edge): a whitespace-only query is treated as empty', () => {
  const { mod, tab } = fresh({ tickets: backgroundTickets() });
  mod.renderTasksBoard(tab);
  // When I type "   " into the Tasks search box
  type(mod, tab, '   ');
  // Then all 3 cards are visible
  assert.deepEqual(visibleIds(tab), ['TASK-001', 'TASK-002', 'TASK-003']);
  // And the status line is the unfiltered "3 tickets" form (not "3 of 3")
  assert.equal(tab.els.tasksStatus.textContent, '3 tickets · 1 running');
  // And no "no matching tickets" message is shown
  assert.equal(tab.els.tasksNoMatch.classList.contains('hidden'), true);
});

// ===========================================================================
// Scenario: Filter persists across the live poll re-render
// ===========================================================================
test('Scenario: the filter survives a live poll re-render (input keeps text + focus)', async () => {
  // Given a poll-driven board with the 3 background tickets
  const { mod, tab } = pollFresh([
    { name: 'TASK-001.md', content: md('TASK-001', 'Add login form', 'todo', 'validate credentials') },
    { name: 'TASK-002.md', content: md('TASK-002', 'Fix logout crash', 'in-progress', 'null pointer') },
    { name: 'TASK-003.md', content: md('TASK-003', 'Polish dashboard styles', 'done', 'CSS cleanup') },
  ]);
  await mod.pollTasksOnce(tab, true);
  assert.deepEqual(visibleIds(tab), ['TASK-001', 'TASK-002', 'TASK-003'], 'board starts unfiltered');
  // And I have typed "login" so only "TASK-001" is visible
  type(mod, tab, 'login');
  assert.deepEqual(visibleIds(tab), ['TASK-001']);
  const inputRef = tab.els.tasksSearch;
  // When a poll tick re-reads the ticket files and re-renders the board
  await mod.pollTasksOnce(tab, true);
  // Then only "TASK-001" is still visible
  assert.deepEqual(visibleIds(tab), ['TASK-001'], 'the filter survived the wholesale lane rebuild');
  // And the search box still contains "login" and keeps focus (the input lives in
  // the toolbar, outside .tasksBoard, so it is never rebuilt — same element node,
  // same value; focus/caret are preserved).
  assert.equal(tab.els.tasksSearch.value, 'login', 'input retains its text');
  assert.equal(tab.els.tasksSearch, inputRef, 'the input element itself is never rebuilt');
  assert.equal(tab.tasks.searchQuery, 'login', 'the query state persists on tab.tasks');
});

// ===========================================================================
// Scenario: A ticket edited on disk mid-filter joins the results
// ===========================================================================
test('Scenario: a ticket edited on disk mid-filter joins the filtered results', async () => {
  const { mod, tab, files, tasksDir } = pollFresh([
    { name: 'TASK-001.md', content: md('TASK-001', 'Add login form', 'todo', 'validate credentials') },
    { name: 'TASK-002.md', content: md('TASK-002', 'Fix logout crash', 'in-progress', 'null pointer') },
    { name: 'TASK-003.md', content: md('TASK-003', 'Polish dashboard styles', 'done', 'CSS cleanup') },
  ]);
  await mod.pollTasksOnce(tab, true);
  // Given I have typed "login" (only TASK-001 matches)
  type(mod, tab, 'login');
  assert.deepEqual(visibleIds(tab), ['TASK-001']);
  // When the title of "TASK-003" is changed on disk to "Login page polish" (a real
  // edit also bumps `updated`, which is what changes the poll signature).
  files.set(tasksDir + '\\TASK-003.md',
    md('TASK-003', 'Login page polish', 'done', 'CSS cleanup', '2026-02-02T00:00:00.000Z'));
  // And the next poll tick re-renders the board
  await mod.pollTasksOnce(tab);
  // Then "TASK-001" and "TASK-003" are both visible
  assert.deepEqual(visibleIds(tab), ['TASK-001', 'TASK-003']);
});

// ===========================================================================
// Scenario: No matches shows a friendly message, not the empty-board banner (failure)
// ===========================================================================
test('Scenario (failure): zero matches shows the no-match message, NOT the empty-board banner', () => {
  const { mod, tab } = fresh({ tickets: backgroundTickets() });
  mod.renderTasksBoard(tab);
  // When I type "zzz-does-not-exist" into the Tasks search box
  type(mod, tab, 'zzz-does-not-exist');
  // Then no ticket cards are visible
  assert.deepEqual(visibleIds(tab), []);
  // And a "no matching tickets" message is shown (the dedicated element)
  assert.equal(tab.els.tasksNoMatch.classList.contains('hidden'), false, 'no-match message is shown');
  assert.match(tab.els.tasksNoMatch.textContent, /no tickets match/i);
  // But the "No tickets yet" banner is NOT shown (showEmpty stays total===0-based)
  assert.equal(tab.els.tasksEmpty.classList.contains('hidden'), true, 'empty-board banner stays hidden');
  // And the status line reflects the filter: "0 of 3 tickets" (+ running from all)
  assert.equal(tab.els.tasksStatus.textContent, '0 of 3 tickets · 1 running');
});

test('Scenario (edge): a genuinely empty board with a query shows ONLY the empty banner (no double message)', () => {
  // Given no tickets at all, and a query typed in.
  const { mod, tab } = fresh({ tickets: ticketsMap([]) });
  mod.renderTasksBoard(tab);
  type(mod, tab, 'anything');
  // The "No tickets yet" empty state wins (total === 0)...
  assert.equal(tab.els.tasksEmpty.classList.contains('hidden'), false, 'empty banner shows on a truly empty board');
  // ...and the no-match message does NOT also fire (never both).
  assert.equal(tab.els.tasksNoMatch.classList.contains('hidden'), true, 'no-match message suppressed on an empty board');
});

// ===========================================================================
// Scenario: Query with regex special characters is matched literally (edge)
// ===========================================================================
test('Scenario (edge): a regex-metacharacter query matches literally and never throws', () => {
  const { mod, tab } = fresh({
    tickets: ticketsMap([
      { fm: { id: 'TASK-050', title: 'Handle (edge) [case] *.md', status: 'todo' }, body: '' },
      { fm: { id: 'TASK-051', title: 'Unrelated', status: 'todo' }, body: '' },
    ]),
  });
  mod.renderTasksBoard(tab);
  // Given a ticket titled "Handle (edge) [case] *.md"
  // When I type "(edge) [case]" — and nothing throws (would-be-invalid regex)
  assert.doesNotThrow(() => type(mod, tab, '(edge) [case]'), 'no script error is thrown');
  // Then only the "Handle (edge) [case] *.md" ticket is visible
  assert.deepEqual(visibleIds(tab), ['TASK-050']);
});

// ===========================================================================
// Scenario: Archived done cards are filtered inside the expander
// ===========================================================================
test('Scenario: archived done cards are filtered inside the expander', () => {
  // Given the done lane contains 2 archived tickets (old `updated` → past the
  // 5-day archive threshold), one titled "old login fix".
  const old = '2020-01-01T00:00:00.000Z';
  const { mod, tab } = fresh({
    tickets: ticketsMap([
      { fm: { id: 'TASK-201', title: 'old login fix', status: 'done', updated: old }, body: '' },
      { fm: { id: 'TASK-202', title: 'old cache purge', status: 'done', updated: old }, body: '' },
    ]),
  });
  mod.renderTasksBoard(tab);
  // Both start archived → "Archived (2)".
  assert.equal(findByClass(lane(tab, 'done'), 'tasks-archived-toggle').textContent, 'Archived (2)');
  // When I type "login" into the Tasks search box
  type(mod, tab, 'login');
  // Then the Done lane's expander shows "Archived (1)" (matching archived cards only)
  assert.equal(findByClass(lane(tab, 'done'), 'tasks-archived-toggle').textContent, 'Archived (1)');
  // When I type "zzz" (matches nothing)
  type(mod, tab, 'zzz');
  // Then no Archived expander is rendered (never "Archived (0)")
  assert.equal(findByClass(lane(tab, 'done'), 'tasks-archived-toggle'), null, 'no expander when zero archived match');
});

// ===========================================================================
// Scenario: Clearing via Escape restores the board
// ===========================================================================
test('Scenario: clearing via Escape restores the board', () => {
  const { mod, tab } = fresh({ tickets: backgroundTickets() });
  mod.renderTasksBoard(tab);
  // Given I have typed "login" into the Tasks search box
  type(mod, tab, 'login');
  assert.deepEqual(visibleIds(tab), ['TASK-001']);
  // When I press Escape while the search box is focused — the keydown handler
  // (registered next to the input) calls clearTasksSearch. Assert that wiring...
  assert.match(rendererSrc,
    /addEventListener\('keydown',[\s\S]*?e\.key === 'Escape'[\s\S]*?clearTasksSearch\(tab\)/,
    'the Escape keydown handler calls clearTasksSearch');
  // ...then drive its effect.
  mod.clearTasksSearch(tab);
  // Then the search box is empty and all cards are visible
  assert.equal(tab.els.tasksSearch.value, '', 'input cleared');
  assert.equal(tab.tasks.searchQuery, '', 'query state cleared');
  assert.deepEqual(visibleIds(tab), ['TASK-001', 'TASK-002', 'TASK-003']);
  // And the clear (×) button is hidden again.
  assert.equal(tab.els.tasksSearchClear.classList.contains('hidden'), true);
});

// ===========================================================================
// Scenario: Creating a ticket while filtered clears the search (edge)
// ===========================================================================
test('Scenario (edge): creating a ticket while filtered clears the search', () => {
  const { mod, tab } = fresh({ tickets: backgroundTickets() });
  mod.renderTasksBoard(tab);
  // Given I have typed "zzz" and no cards are visible
  type(mod, tab, 'zzz');
  assert.deepEqual(visibleIds(tab), []);
  assert.equal(tab.els.tasksSearchClear.classList.contains('hidden'), false, 'clear button visible while filtering');
  // The create paths (normal + bug) call clearTasksSearch(tab) on success. Assert
  // that wiring exists in the source...
  assert.equal((rendererSrc.match(/clearTasksSearch\(tab\);/g) || []).length >= 3, true,
    'create + bug-create + plan paths all call clearTasksSearch');
  // ...then drive the clear the create path performs.
  mod.clearTasksSearch(tab);
  // Then the search box is cleared and the board renders unfiltered (so a newly
  // created ticket — which need not contain "zzz" — is visible).
  assert.equal(tab.els.tasksSearch.value, '');
  assert.equal(tab.tasks.searchQuery, '');
  assert.deepEqual(visibleIds(tab), ['TASK-001', 'TASK-002', 'TASK-003']);
});

// ===========================================================================
// Scenario: Switching folders resets the search
// ===========================================================================
test('Scenario: switching folders resets the search', () => {
  // resetTasksForFolder clears the query state AND the input value (mirroring the
  // archiveExpanded reset). Assert that source contract...
  const reset = (function extractReset() {
    let s = rendererSrc.indexOf('function resetTasksForFolder(');
    let i = rendererSrc.indexOf('{', s);
    let depth = 0;
    for (; i < rendererSrc.length; i++) {
      if (rendererSrc[i] === '{') depth += 1;
      else if (rendererSrc[i] === '}') { depth -= 1; if (depth === 0) { i += 1; break; } }
    }
    return rendererSrc.slice(s, i);
  })();
  assert.match(reset, /tab\.tasks\.searchQuery = '';/, 'resetTasksForFolder clears the query state');
  assert.match(reset, /tab\.els\.tasksSearch\.value = '';/, 'resetTasksForFolder clears the input value');
  // ...then verify the behaviour end-to-end: a filtered folder, cleared, then a
  // different folder's tickets render UNFILTERED.
  const { mod, tab } = fresh({ tickets: backgroundTickets() });
  mod.renderTasksBoard(tab);
  type(mod, tab, 'login');
  assert.deepEqual(visibleIds(tab), ['TASK-001']);
  // Simulate the folder switch's search reset (the lines asserted above).
  tab.tasks.searchQuery = '';
  tab.els.tasksSearch.value = '';
  // The new folder loads different tickets and renders.
  tab.tasks.tickets = ticketsMap([
    { fm: { id: 'TASK-500', title: 'brand new folder ticket', status: 'todo' }, body: '' },
  ]);
  mod.renderTasksBoard(tab);
  // Then the search box is empty and the new folder's board renders unfiltered.
  assert.equal(tab.els.tasksSearch.value, '');
  assert.deepEqual(visibleIds(tab), ['TASK-500']);
});

// ===========================================================================
// Scenario: Drag and drop still works while filtered
// ===========================================================================
test('Scenario: drag and drop still works while filtered', async () => {
  const { mod, tab, window } = fresh({
    tickets: ticketsMap([
      { fm: { id: 'TASK-001', title: 'Add login form', status: 'todo' }, body: '' },
      { fm: { id: 'TASK-002', title: 'Fix logout crash', status: 'in-progress' }, body: '' },
    ]),
  });
  mod.renderTasksBoard(tab);
  // Given I have typed "log" — TASK-001 (todo) is visible in the todo lane.
  type(mod, tab, 'log');
  assert.deepEqual(cardIdsIn(tab, 'todo'), ['TASK-001'], 'the visible todo card matches the filter');
  // When I drag the visible card "TASK-001" from "todo" to the "defining" lane.
  // The per-lane drop target (attachTasksLaneDrop) is attached in rebuildTasksLanes
  // regardless of the filter, so a filtered board is still fully droppable.
  await fire(lane(tab, 'defining'), 'drop',
    { dataTransfer: { getData: () => 'TASK-001.md', setData() {} } });
  // Then the ticket's status is updated to "defining" (moveTicketToStatus is the
  // recorded stub — the real write is out of the render scope).
  const moves = window.__calls.moveTicketToStatus || [];
  assert.equal(moves.length, 1, 'exactly one status write was requested');
  assert.deepEqual(moves[0], { file: 'TASK-001.md', status: 'defining' });
});

function cardIdsIn(tab, status) {
  return findAllByClass(lane(tab, status), 'task-card')
    .map((c) => findByClass(c, 'task-card-id').textContent).sort();
}

// ===========================================================================
// Scenario: Build accounting ignores the filter
// ===========================================================================
test('Scenario: build accounting (running count / continuation) ignores the filter', () => {
  const { mod, tab } = fresh({ tickets: backgroundTickets() });
  mod.renderTasksBoard(tab);
  // Given "TASK-002" is in-progress and I have typed "dashboard" (matches only the
  // done ticket TASK-003, so the in-progress TASK-002 is filtered OUT of view).
  type(mod, tab, 'dashboard');
  assert.deepEqual(visibleIds(tab), ['TASK-003'], 'only the dashboard card is visible');
  assert.equal(findAllByClass(lane(tab, 'in-progress'), 'task-card').length, 0,
    'the in-progress card is hidden by the filter');
  // Then the status line running count still reflects "TASK-002" — the running
  // fragment is computed from ALL tickets, never the filtered subset.
  assert.equal(tab.els.tasksStatus.textContent, '1 of 3 tickets · 1 running',
    'running count survives the filter (auto-build continuation likewise reads all tickets)');
});
