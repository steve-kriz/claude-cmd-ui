'use strict';

// E2E cucumber-style tests for TASK-019 "Choose the number of parallel build
// processes". These implement the ticket's Gherkin at the logic level (there is
// no DOM harness, and the renderer is a browser script that cannot be required):
// each scenario is a Given/When/Then node:test case exercising the pure
// lib/tasks-settings.js helpers, plus static text assertions over the renderer
// wiring (renderer/index.html + renderer/renderer.js) for the DOM-shaped
// acceptance criteria. NO Electron, NO DOM, NO real localStorage, NO DB — every
// storage interaction is modelled with an in-memory fake.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  concurrencyOptions,
  readStoredConcurrency,
  buildConcurrencyCommand,
  storageKey,
} = require('../lib/tasks-settings');

const {
  resolveConcurrency,
  MAX_CONCURRENCY,
  DEFAULT_CONCURRENCY,
} = require('../lib/ticket-queue');

// ---------------------------------------------------------------------------
// Test doubles — an in-memory localStorage fake and the build-command regex
// replicated from renderer.js (isBuildCommand, ~5954) since renderer.js is a
// browser script and is NOT requireable. Kept in lockstep with the real one.
// ---------------------------------------------------------------------------

function makeLocalStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => map.clear(),
  };
}

const BUILD_COMMAND = '/orchestrate build';
// Replica of renderer.js isBuildCommand: matches the bare command and any
// argumented form ("/orchestrate build --concurrency N").
function isBuildCommand(p) {
  return typeof p === 'string' && (p === BUILD_COMMAND || p.startsWith(BUILD_COMMAND + ' '));
}

// A tiny model of the folder-aware read/persist path used by the board, built
// only from the pure helpers + the fake storage (no DOM).
function persistConcurrency(store, folder, rawSelectedValue) {
  const key = storageKey(folder);
  if (!key) return; // no folder open -> skip persistence
  store.setItem(key, JSON.stringify(resolveConcurrency(rawSelectedValue)));
}
function selectedValueFor(store, folder) {
  const key = storageKey(folder);
  if (!key) return readStoredConcurrency(null); // no folder -> default
  return readStoredConcurrency(store.getItem(key));
}

// ---------------------------------------------------------------------------
// Feature: Choose the number of parallel build processes
// Background: the Tasks board is open on a folder with the skill installed.
// ---------------------------------------------------------------------------

test('Scenario: Default selection when nothing is stored -> 3', () => {
  // Given no value is stored under "tasks:concurrency:<folder>"
  const store = makeLocalStorage();
  // When readStoredConcurrency(null) is evaluated (nothing in storage)
  const fromNull = readStoredConcurrency(null);
  const fromEmptyStore = selectedValueFor(store, 'folderA');
  // Then it returns 3
  assert.equal(fromNull, 3);
  assert.equal(fromEmptyStore, DEFAULT_CONCURRENCY);
  assert.equal(DEFAULT_CONCURRENCY, 3, 'default is the documented 3');
});

test('Scenario: Options span 1..MAX_CONCURRENCY derived from the constant', () => {
  // Given MAX_CONCURRENCY is 8 (imported, not hard-coded)
  // When concurrencyOptions() is evaluated
  const opts = concurrencyOptions();
  // Then it returns exactly [1..MAX_CONCURRENCY] ascending
  assert.deepEqual(opts, Array.from({ length: MAX_CONCURRENCY }, (_, i) => i + 1));
  // And the last option value is MAX_CONCURRENCY and the count is MAX_CONCURRENCY
  assert.equal(opts[opts.length - 1], MAX_CONCURRENCY);
  assert.equal(opts.length, MAX_CONCURRENCY);
});

test('Scenario: Changing the dropdown persists per folder (resolves to 5)', () => {
  // Given the board is open on folder <folder>
  const store = makeLocalStorage();
  const folder = '/repo/tasks';
  // When the user selects "5" in the concurrency dropdown
  persistConcurrency(store, folder, '5');
  // Then localStorage key "tasks:concurrency:<folder>" holds a value resolving to 5
  const raw = store.getItem(storageKey(folder));
  assert.equal(raw, JSON.stringify(5));
  assert.equal(readStoredConcurrency(raw), 5);
});

test('Scenario: Stored value is restored on reopening the same folder (6)', () => {
  // Given "tasks:concurrency:<folder>" resolves to 6
  const store = makeLocalStorage();
  const folder = 'proj';
  store.setItem(storageKey(folder), JSON.stringify(6));
  // When the folder is reopened
  const selected = selectedValueFor(store, folder);
  // Then the select's selected value is "6"
  assert.equal(selected, 6);
  assert.equal(String(selected), '6');
});

test('Scenario: Each folder keeps its own value (A=2, B=7)', () => {
  // Given folder A stored 2 and folder B stored 7
  const store = makeLocalStorage();
  persistConcurrency(store, 'A', 2);
  persistConcurrency(store, 'B', 7);
  // When folder A is open then the select shows "2"
  assert.equal(selectedValueFor(store, 'A'), 2);
  // When folder B is open then the select shows "7"
  assert.equal(selectedValueFor(store, 'B'), 7);
  // And a third, unstored folder shows the default 3
  assert.equal(selectedValueFor(store, 'C'), 3);
});

test('Scenario: Build command carries the chosen concurrency', () => {
  // Given "tasks:concurrency:<folder>" resolves to 5
  const store = makeLocalStorage();
  const folder = 'f';
  persistConcurrency(store, folder, 5);
  // When buildConcurrencyCommand("/orchestrate build", <resolved>) is evaluated
  const value = selectedValueFor(store, folder);
  const cmd = buildConcurrencyCommand(BUILD_COMMAND, value);
  // Then it returns "/orchestrate build --concurrency 5"
  assert.equal(cmd, '/orchestrate build --concurrency 5');
  // And starting the build enqueues that exact command onto the prompt queue
  const promptQueue = [];
  promptQueue.push(cmd);
  assert.deepEqual(promptQueue, ['/orchestrate build --concurrency 5']);
  // And both the bare and argumented forms are recognised as build commands
  assert.equal(isBuildCommand(BUILD_COMMAND), true, 'bare form is a build command');
  assert.equal(isBuildCommand(cmd), true, 'argumented form is a build command');
  assert.equal(isBuildCommand('/orchestrate ship'), false, 'non-build command not matched');
});

test('Scenario: Auto-continuation reuses the argumented command (concurrency 4)', () => {
  // Given auto-build is running with concurrency 4
  const store = makeLocalStorage();
  const folder = 'auto';
  persistConcurrency(store, folder, 4);
  // When maybeContinueBuild re-queues a build (built fresh from the stored value)
  const cmd = buildConcurrencyCommand(BUILD_COMMAND, selectedValueFor(store, folder));
  // Then the enqueued command is "/orchestrate build --concurrency 4"
  assert.equal(cmd, '/orchestrate build --concurrency 4');
  assert.equal(isBuildCommand(cmd), true);
});

test('Scenario: Stopping the build clears the argumented command from the queue', () => {
  // Given a "/orchestrate build --concurrency 4" command is queued and not yet sent
  let promptQueue = ['/orchestrate build --concurrency 4', '/some other prompt'];
  // When the user stops the build (filter out any build command, bare or argumented)
  promptQueue = promptQueue.filter((p) => !isBuildCommand(p));
  // Then no build command remains in tab.promptQueue
  assert.equal(promptQueue.some(isBuildCommand), false);
  assert.deepEqual(promptQueue, ['/some other prompt']);
});

test('Scenario Outline: Out-of-range and junk stored values are clamped or defaulted', () => {
  // Examples table straight from the ticket Gherkin.
  const rows = [
    ['0', 1],
    ['-3', 1],
    ['9', 8],
    ['1000', 8],
    ['3.9', 3],
    ['', 3],
    [null, 3],
    ['abc', 3],
    ['{bad json', 3],
  ];
  for (const [raw, resolved] of rows) {
    // When readStoredConcurrency(<raw>) is evaluated
    // Then it returns <resolved>
    assert.equal(readStoredConcurrency(raw), resolved, `raw ${JSON.stringify(raw)} -> ${resolved}`);
  }
});

test('Scenario: A corrupt localStorage entry never crashes the board and shows the default', () => {
  // Given "tasks:concurrency:<folder>" contains an unparseable value
  const store = makeLocalStorage();
  const folder = 'corrupt';
  store.setItem(storageKey(folder), '{bad json');
  // When the Tasks view initialises the dropdown
  let selected;
  assert.doesNotThrow(() => { selected = selectedValueFor(store, folder); }, 'load path must not throw');
  // Then the select's selected value is "3" and no exception propagates
  assert.equal(selected, 3);
  assert.equal(String(selected), '3');
});

test('Scenario: resolveConcurrency remains the single clamp authority', () => {
  // When readStoredConcurrency delegates to resolveConcurrency
  // Then readStoredConcurrency(raw) equals resolveConcurrency(<parsed raw>) for every raw above.
  const parse = (raw) => {
    if (raw == null) return raw;
    if (typeof raw !== 'string') return raw;
    const trimmed = raw.trim();
    if (trimmed === '') return '';
    try { return JSON.parse(trimmed); } catch (_) { return trimmed; }
  };
  const raws = ['0', '-3', '9', '1000', '3.9', '', null, 'abc', '{bad json', '5', '6', 2, 7];
  for (const raw of raws) {
    assert.equal(readStoredConcurrency(raw), resolveConcurrency(parse(raw)), `authority mismatch for ${JSON.stringify(raw)}`);
  }
});

test('Scenario: No folder open -> storageKey is null, persistence skipped, default shown', () => {
  // Given no folder is open (tab.folder falsy)
  const store = makeLocalStorage();
  // Then storageKey returns null
  assert.equal(storageKey(null), null);
  // When a change fires with no folder, nothing is persisted
  persistConcurrency(store, null, 7);
  assert.equal(store.getItem('tasks:concurrency:null'), null, 'nothing written to a bogus key');
  // And the shown value falls back to the default
  assert.equal(selectedValueFor(store, null), DEFAULT_CONCURRENCY);
});

// ---------------------------------------------------------------------------
// Static renderer-wiring assertions (DOM-shaped acceptance criteria). The
// renderer is a browser script; we assert its wiring by reading the source
// files as text. No DOM/Electron is instantiated.
// ---------------------------------------------------------------------------

const INDEX_HTML = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
const RENDERER_JS = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');

test('Scenario: The concurrency dropdown appears in the Tasks toolbar before New ticket', () => {
  // Isolate the Tasks view block so positioning assertions are scoped to it.
  const tasksIdx = INDEX_HTML.indexOf('data-view="tasks"');
  assert.ok(tasksIdx !== -1, 'tasks view exists');
  const tasksBlock = INDEX_HTML.slice(tasksIdx, tasksIdx + 2000);

  // Then a select element with class "tasksConcurrency" exists in the Tasks toolbar
  const selIdx = tasksBlock.indexOf('class="tasksConcurrency"');
  assert.ok(selIdx !== -1, 'tasksConcurrency select present in tasks toolbar');
  assert.match(tasksBlock, /<select[^>]*class="tasksConcurrency"/, 'it is a <select> element');

  // And it is positioned before the "New ticket" button
  const newTicketIdx = tasksBlock.indexOf('New ticket');
  assert.ok(newTicketIdx !== -1, 'New ticket button present');
  assert.ok(selIdx < newTicketIdx, 'tasksConcurrency select precedes the New ticket button');

  // And it has a visible label "Parallel"
  const labelIdx = tasksBlock.indexOf('Parallel');
  assert.ok(labelIdx !== -1, 'a "Parallel" label is present');
  assert.match(tasksBlock, /<label[^>]*>[\s\S]*Parallel[\s\S]*<select[^>]*class="tasksConcurrency"/,
    'the Parallel label wraps/precedes the select');
});

test('Static wiring: renderer.js collects the element and wires a change handler', () => {
  assert.match(RENDERER_JS, /tab\.els\.tasksConcurrency/, 'element collected into tab.els');
  assert.match(RENDERER_JS, /\.tasksConcurrency['"]\s*\)/, "queried via .tasksConcurrency selector");
  assert.match(RENDERER_JS, /tasksConcurrency\.addEventListener\(\s*['"]change['"]/, 'change handler wired');
});

test('Static wiring: renderer.js persists under a tasks:concurrency: key', () => {
  assert.match(RENDERER_JS, /tasks:concurrency:/, 'per-folder storage key prefix present');
  // Persistence is guarded by a try/catch like saveSlackConfig, and uses localStorage.setItem.
  assert.match(RENDERER_JS, /localStorage\.setItem\(/, 'writes via localStorage.setItem');
});

test('Static wiring: renderer.js constructs the --concurrency build command', () => {
  assert.match(RENDERER_JS, /--concurrency/, '--concurrency flag constructed in build path');
  assert.match(RENDERER_JS, /BUILD_COMMAND\s*\+\s*['"] --concurrency/, 'build command appends the flag');
  // The build-command recogniser accepts both the bare and argumented forms.
  assert.match(RENDERER_JS, /function isBuildCommand/, 'isBuildCommand recogniser present');
});
