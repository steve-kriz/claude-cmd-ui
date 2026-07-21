'use strict';

// ===========================================================================
// TASK-136 — e2e "cucumber" scenarios (Given/When/Then), implemented as plain
// `node --test` cases. NO `cucumber` npm package is installed or required;
// these are scenario-style node:test cases in Given/When/Then form.
//
// Feature: the Tasks toolbar search clear (×) button must expose a meaningful
// accessible name (aria-label="Clear search") and be reachable by keyboard
// (no tabindex="-1"), WITHOUT changing its existing click / Escape / visibility
// behaviour. The change is markup-only (renderer/index.html:667); the JS wiring
// (clearTasksSearch / onTasksSearchInput / updateTasksSearchClear, and the click
// handler that clears + refocuses the input) is unchanged.
//
// Two kinds of proof are combined, matching the repo conventions:
//   * The shipped markup is proven by SOURCE-SCANNING renderer/index.html as
//     text (browser scripts are not require()-able), following
//     test/task-091-team-tab-scaffold.e2e.test.js.
//   * The behavioural scenarios (clear on Escape / click, focus-return,
//     hide/show) drive the REAL shipped renderer functions headlessly via
//     test/helpers/task-101-lane-harness.js — exactly like
//     test/task-132-board-search.e2e.test.js.
//
// EVERY database / filesystem / Electron / network call is MOCKED — the DOM is a
// plain in-memory object tree and window.api.fs is an in-memory stub. NO real
// DB / disk / network is touched.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./helpers/task-101-lane-harness');

const {
  loadLaneModule, makeWindow, makeDocument, makeTab,
  ticketsMap, findByClass, findAllByClass, rendererSrc,
} = H;

const REPO = path.join(__dirname, '..');
const htmlSrc = fs.readFileSync(path.join(REPO, 'renderer', 'index.html'), 'utf8');
const cssSrc = fs.readFileSync(path.join(REPO, 'renderer', 'styles.css'), 'utf8');

// Extract the single <button ...> opening tag that carries the `tasksSearchClear`
// class from renderer/index.html. Both the class anchor and the tag boundaries
// are asserted found so a not-found match can never silently pass.
function clearButtonTag() {
  const cls = htmlSrc.indexOf('tasksSearchClear');
  assert.notEqual(cls, -1, 'the tasksSearchClear button exists in index.html');
  const open = htmlSrc.lastIndexOf('<button', cls);
  const close = htmlSrc.indexOf('>', cls);
  assert.ok(open !== -1 && close !== -1 && close > open, 'the clear button tag is well-formed');
  return htmlSrc.slice(open, close + 1);
}

// Fresh module + tab per scenario (module-level drag state must not leak).
function fresh(opts) {
  const { window } = makeWindow();
  const mod = loadLaneModule(window, makeDocument(), console);
  return { mod, window, tab: makeTab(opts) };
}
function visibleIds(tab) {
  return findAllByClass(tab.els.tasksBoard, 'task-card')
    .map((c) => findByClass(c, 'task-card-id').textContent)
    .sort();
}
function type(mod, tab, text) {
  tab.els.tasksSearch.value = text;
  mod.onTasksSearchInput(tab);
}
function backgroundTickets() {
  return ticketsMap([
    { fm: { id: 'TASK-001', title: 'Add login form', status: 'todo' }, body: 'validate credentials' },
    { fm: { id: 'TASK-002', title: 'Fix logout crash', status: 'in-progress' }, body: 'null pointer' },
    { fm: { id: 'TASK-003', title: 'Polish dashboard styles', status: 'done' }, body: 'CSS cleanup' },
  ]);
}

// ===========================================================================
// Scenario: Screen reader announces "Clear search", not the × glyph
//   When the accessibility name of the clear button is computed
//   Then the button has the attribute aria-label "Clear search"
//   And it is not announced as "times" or the bare "×" character
// ===========================================================================
test('Scenario: the clear button exposes aria-label="Clear search" (not the bare × glyph)', () => {
  // Given the shipped Tasks toolbar markup
  const tag = clearButtonTag();
  // Then the button carries aria-label="Clear search" as its accessible name
  assert.match(tag, /aria-label="Clear search"/, 'clear button has aria-label="Clear search"');
  // And it keeps the × text content and the "Clear search (Esc)" tooltip
  assert.match(htmlSrc.slice(htmlSrc.indexOf('tasksSearchClear'),
    htmlSrc.indexOf('</button>', htmlSrc.indexOf('tasksSearchClear')) + 9),
    /×<\/button>/, 'the × glyph text content is kept');
  assert.match(tag, /title="Clear search \(Esc\)"/, 'the "Clear search (Esc)" tooltip is kept');
});

// ===========================================================================
// Scenario: Clear button joins the tab order while text is present
//   Given the user has typed "login" into the search input
//   Then the clear button is visible (the "hidden" class is absent)
//   And the clear button has no tabindex="-1" attribute
// ===========================================================================
test('Scenario: the clear button joins the tab order (no tabindex="-1") and un-hides while text is present', () => {
  // Then the shipped markup has NO tabindex="-1" on the clear button, mirroring
  // the naturally-focusable Files-find close button (index.html:298).
  const tag = clearButtonTag();
  assert.ok(!/tabindex="-1"/.test(tag), 'clear button has no tabindex="-1"');
  assert.ok(!/tabindex=/.test(tag), 'clear button carries no tabindex attribute at all (mirrors .filesFindClose)');
  const filesClose = htmlSrc.slice(htmlSrc.lastIndexOf('<button', htmlSrc.indexOf('filesFindClose')),
    htmlSrc.indexOf('>', htmlSrc.indexOf('filesFindClose')) + 1);
  assert.ok(!/tabindex/.test(filesClose), 'the mirrored .filesFindClose reference has no tabindex (unchanged)');

  // And behaviourally: typing "login" un-hides the button (hidden class absent),
  // so it becomes a real tab stop while there is text to clear.
  const { mod, tab } = fresh({ tickets: backgroundTickets() });
  mod.renderTasksBoard(tab);
  type(mod, tab, 'login');
  assert.deepEqual(visibleIds(tab), ['TASK-001'], 'board filtered to the login ticket');
  assert.equal(tab.els.tasksSearchClear.classList.contains('hidden'), false,
    'clear button is visible (hidden class absent) while text is present');
});

// ===========================================================================
// Scenario: Keyboard activation clears the search and restores focus
//   Given focus is on the clear button
//   When the user presses Enter (activating the button's click handler)
//   Then the search input value becomes empty, board re-renders unfiltered,
//   focus returns to the search input, and the button regains "hidden".
// ===========================================================================
test('Scenario: activating the clear button clears the search and returns focus to the input', () => {
  // The click handler (renderer.js ~583-588) clears then refocuses the input.
  // Enter/Space on a native <button> fires click, so assert that wiring...
  assert.match(rendererSrc,
    /tasksSearchClear\.addEventListener\('click',[\s\S]*?clearTasksSearch\(tab\);[\s\S]*?tasksSearch\.focus\(\)/,
    'the clear button click handler calls clearTasksSearch then refocuses the input');

  // ...then drive its exact effect against the real functions.
  const { mod, tab } = fresh({ tickets: backgroundTickets() });
  mod.renderTasksBoard(tab);
  type(mod, tab, 'login');
  assert.deepEqual(visibleIds(tab), ['TASK-001']);
  assert.equal(tab.els.tasksSearchClear.classList.contains('hidden'), false, 'button visible before clearing');

  // Instrument focus so we can prove it lands back on the input, not the button.
  let focused = 0;
  tab.els.tasksSearch.focus = () => { focused += 1; };
  // Replicate the click handler body exactly (Enter/Space -> click).
  mod.clearTasksSearch(tab);
  if (tab.els.tasksSearch) tab.els.tasksSearch.focus();

  // Then the input value is empty and the board re-renders unfiltered.
  assert.equal(tab.els.tasksSearch.value, '', 'input value cleared');
  assert.equal(tab.tasks.searchQuery, '', 'query state cleared');
  assert.deepEqual(visibleIds(tab), ['TASK-001', 'TASK-002', 'TASK-003'], 'board re-renders unfiltered');
  // And focus returns to the search input.
  assert.equal(focused, 1, 'focus returned to the search input (not dropped on the now-hidden button)');
  // And the clear button regains the "hidden" class.
  assert.equal(tab.els.tasksSearchClear.classList.contains('hidden'), true, 'clear button hidden again after clearing');
});

// ===========================================================================
// Scenario: Escape in the input still clears the search (regression guard)
// ===========================================================================
test('Scenario (regression): Escape in the input still clears the search and re-hides the button', () => {
  // The input keydown handler calls clearTasksSearch on Escape — assert wiring...
  assert.match(rendererSrc,
    /tasksSearch\.addEventListener\('keydown',[\s\S]*?e\.key === 'Escape'[\s\S]*?clearTasksSearch\(tab\)/,
    'the input Escape keydown handler calls clearTasksSearch');
  // ...then drive its effect.
  const { mod, tab } = fresh({ tickets: backgroundTickets() });
  mod.renderTasksBoard(tab);
  type(mod, tab, 'TASK-002');
  assert.deepEqual(visibleIds(tab), ['TASK-002']);
  mod.clearTasksSearch(tab);
  assert.equal(tab.els.tasksSearch.value, '', 'input cleared by Escape');
  assert.deepEqual(visibleIds(tab), ['TASK-001', 'TASK-002', 'TASK-003'], 'board re-renders unfiltered');
  assert.equal(tab.els.tasksSearchClear.classList.contains('hidden'), true, 'clear button hidden again');
});

// ===========================================================================
// Scenario: Mouse click still clears the search (regression guard)
// ===========================================================================
test('Scenario (regression): a mouse click on the clear button clears the query and shows all tickets', () => {
  const { mod, tab } = fresh({ tickets: backgroundTickets() });
  mod.renderTasksBoard(tab);
  type(mod, tab, 'crash');
  assert.deepEqual(visibleIds(tab), ['TASK-002'], 'filtered to the crash ticket');
  // A click drives clearTasksSearch (+ refocus); drive the same effect.
  mod.clearTasksSearch(tab);
  assert.equal(tab.els.tasksSearch.value, '', 'input value emptied');
  assert.equal(tab.tasks.searchQuery, '', 'query state emptied');
  assert.deepEqual(visibleIds(tab), ['TASK-001', 'TASK-002', 'TASK-003'], 'all tickets shown again');
});

// ===========================================================================
// Scenario: Edge — hidden clear button is not a tab stop on an empty search
//   Then the clear button has the "hidden" class
//   And ".tasks-search-clear.hidden" is display: none in styles.css
// ===========================================================================
test('Scenario (edge): an empty search hides the clear button via display:none (out of the tab order)', () => {
  // The hide mechanism must be display:none (removes the element from tabbing),
  // NOT visibility/opacity (which would leave an invisible tab stop).
  assert.match(cssSrc, /\.tasks-search-clear\.hidden\s*\{\s*display:\s*none;?\s*\}/,
    '.tasks-search-clear.hidden is display:none in styles.css');

  // Behaviourally: an empty query keeps the button hidden (updateTasksSearchClear).
  const { mod, tab } = fresh({ tickets: backgroundTickets() });
  mod.renderTasksBoard(tab);
  // Start filtered so the button is visible, then clear back to empty.
  type(mod, tab, 'login');
  assert.equal(tab.els.tasksSearchClear.classList.contains('hidden'), false);
  type(mod, tab, '');
  assert.equal(tab.els.tasksSearchClear.classList.contains('hidden'), true,
    'the clear button is hidden (display:none -> skipped by Tab) on an empty search');
});

// ===========================================================================
// Scenario: Edge — aria-label is a fixed literal, present even while hidden
//   Then the button still carries aria-label "Clear search" in the static markup
//   And the label never interpolates ticket or query text.
// ===========================================================================
test('Scenario (edge): the aria-label is a fixed literal present even while the button ships hidden', () => {
  const tag = clearButtonTag();
  // The shipped button ships with the `hidden` class AND aria-label together.
  assert.match(tag, /class="[^"]*\bhidden\b[^"]*"/, 'the clear button ships with the hidden class');
  assert.match(tag, /aria-label="Clear search"/, 'aria-label is present even while hidden');
  // The label is a constant string in markup — no template/interpolation syntax
  // (mirrors the TASK-082/083 fixed-literal convention; no injection surface).
  assert.ok(!/aria-label="[^"]*(\$\{|\{\{|" \+)/.test(tag), 'aria-label is a fixed literal, never interpolated');
  // And the renderer never rewrites the aria-label at runtime.
  assert.ok(!/tasksSearchClear[\s\S]{0,80}aria-label/i.test(rendererSrc) &&
    !/setAttribute\(\s*['"]aria-label['"]/.test(
      rendererSrc.slice(Math.max(0, rendererSrc.indexOf('function updateTasksSearchClear')),
        rendererSrc.indexOf('function updateTasksSearchClear') + 400)),
    'the clear button aria-label is never set/interpolated at runtime');
});
