'use strict';

// Unit tests for TASK-056: lib/slack-commands.js — the Electron-free decision
// core of the Slack command system. When Slack is connected the proxy normally
// forwards every thread reply to Claude; certain phrases should instead be
// answered by the app. This module normalizes message text, matches it against a
// data-only command registry, and lists commands. It has no DOM / Electron /
// network access so it is exercised directly with plain `node --test` (same
// layout as test/slack-proxy.test.js PART 1).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_COMMANDS,
  normalizeCommandInput,
  matchCommand,
  listCommands,
  formatTasksSummary,
} = require('../lib/slack-commands');

// A representative injected registry mirroring the { name, description, patterns }
// shape the real commands (TASK-058/059/060) will use.
const REGISTRY = [
  {
    name: 'show-tasks',
    description: 'List the current tasks',
    patterns: ['show me the tasks', 'show tasks'],
  },
  {
    name: 'help',
    description: 'List available commands',
    patterns: ['help', 'what can you do'],
  },
];

// ===========================================================================
// normalizeCommandInput
// ===========================================================================

test('normalizeCommandInput: lowercases, trims, collapses whitespace, strips trailing punctuation', () => {
  assert.equal(normalizeCommandInput('Show me   the tasks?'), 'show me the tasks');
  assert.equal(normalizeCommandInput('  HELP!!  '), 'help');
  assert.equal(normalizeCommandInput('what can you do…'), 'what can you do');
  assert.equal(normalizeCommandInput('a\tb\nc'), 'a b c');
});

test('normalizeCommandInput: null/undefined/non-string → "" (never throws)', () => {
  assert.equal(normalizeCommandInput(null), '');
  assert.equal(normalizeCommandInput(undefined), '');
  assert.equal(normalizeCommandInput(42), '');
  assert.equal(normalizeCommandInput({}), '');
  assert.equal(normalizeCommandInput([]), '');
});

test('normalizeCommandInput: whitespace-only → ""', () => {
  assert.equal(normalizeCommandInput('   '), '');
  assert.equal(normalizeCommandInput('\t\n '), '');
});

// ===========================================================================
// matchCommand
// ===========================================================================

test('matchCommand: matches a normalized whole-phrase pattern → { name, command }', () => {
  const r = matchCommand('Show me   the tasks?', REGISTRY);
  assert.equal(r.name, 'show-tasks');
  assert.equal(r.command, REGISTRY[0]);
});

test('matchCommand: returns FIRST matching entry in registry order', () => {
  const dup = [
    { name: 'first', patterns: ['hello'] },
    { name: 'second', patterns: ['hello'] },
  ];
  assert.equal(matchCommand('hello', dup).name, 'first');
});

test('matchCommand: exact-phrase only — no substring/fuzzy match', () => {
  assert.equal(matchCommand('please fix the tasks page', REGISTRY), null);
  assert.equal(matchCommand('show me the tasks now', REGISTRY), null);
});

test('matchCommand: null/empty/junk text → null (never throws)', () => {
  assert.equal(matchCommand(null, REGISTRY), null);
  assert.equal(matchCommand(undefined, REGISTRY), null);
  assert.equal(matchCommand('   ', REGISTRY), null);
  assert.equal(matchCommand(123, REGISTRY), null);
  assert.equal(matchCommand('nonsense', REGISTRY), null);
});

test('matchCommand: malformed registry entries are skipped (never throws)', () => {
  const bad = [
    null,
    {},
    { name: 'no-patterns' },
    { name: 'bad-patterns', patterns: [1, 2, {}] },
    { name: 'ok', patterns: [null, 'go'] },
  ];
  assert.equal(matchCommand('go', bad).name, 'ok');
  assert.equal(matchCommand('anything', bad), null);
  assert.equal(matchCommand('go', 'not-an-array'), null);
});

test('matchCommand: defaults to DEFAULT_COMMANDS — built-in tasks command matches, unrelated text does not', () => {
  assert.equal(matchCommand('show me the tasks').name, 'tasks');
  assert.equal(matchCommand('please fix the tasks page'), null);
});

// Regression (TASK-062): BOTH sides of the comparison are normalized — the input
// AND the registry pattern. A registry author may therefore write trigger
// phrases in any case/whitespace/punctuation and still get matched. These tests
// use a MIXED-CASE, whitespace-heavy, punctuated pattern so they FAIL if the
// pattern-side normalizeCommandInput(pattern) call is dropped in favour of a raw
// `pattern === normalized` comparison (which would compare a normalized input
// against an un-normalized pattern and never match).
test('matchCommand: normalizes the registry PATTERN too — mixed-case/punctuated pattern matches normalized input', () => {
  const messyRegistry = [
    {
      name: 'show-tasks',
      description: 'List the current tasks',
      patterns: ['  SHOW Me The Tasks?! '],
    },
  ];
  const r = matchCommand('show me the tasks', messyRegistry);
  assert.equal(r.name, 'show-tasks');
  assert.equal(r.command, messyRegistry[0]);
});

test('matchCommand: pattern normalization holds across input whitespace/case variants', () => {
  const messyRegistry = [
    {
      name: 'show-tasks',
      description: 'List the current tasks',
      patterns: ['  SHOW Me The Tasks?! '],
    },
  ];
  const r = matchCommand('Show Me   The Tasks', messyRegistry);
  assert.equal(r.name, 'show-tasks');
  assert.equal(r.command, messyRegistry[0]);
});

// ===========================================================================
// listCommands
// ===========================================================================

test('listCommands: returns [{ name, description }] in registry order', () => {
  assert.deepEqual(listCommands(REGISTRY), [
    { name: 'show-tasks', description: 'List the current tasks' },
    { name: 'help', description: 'List available commands' },
  ]);
});

test('listCommands: null/empty/non-array registry → [] (never throws)', () => {
  assert.deepEqual(listCommands([]), []);
  assert.deepEqual(listCommands(null), []);
  assert.deepEqual(listCommands('nope'), []);
});

test('listCommands: defaults to DEFAULT_COMMANDS → surfaces the built-in commands', () => {
  assert.deepEqual(listCommands(), [
    { name: 'tasks', description: 'Show the tasks board and what is being worked on' },
    { name: 'help', description: 'List the commands this thread understands' },
    { name: 'status', description: 'Show session status: folder, Claude activity, queue and active tickets' },
    { name: 'create-ticket', description: 'Create a new ticket on the tasks board' },
  ]);
});

// ===========================================================================
// DEFAULT_COMMANDS
// ===========================================================================

test('DEFAULT_COMMANDS: exported and contains the built-in tasks command (TASK-058)', () => {
  assert.ok(Array.isArray(DEFAULT_COMMANDS));
  const tasks = DEFAULT_COMMANDS.find((c) => c.name === 'tasks');
  assert.ok(tasks, 'a "tasks" entry exists');
  assert.equal(tasks.description, 'Show the tasks board and what is being worked on');
  assert.deepEqual(tasks.patterns, [
    'show me the tasks',
    'show tasks',
    'list tasks',
    'tasks',
    'what are you working on',
  ]);
  // Every alias resolves to the tasks command via the full pipeline.
  for (const p of tasks.patterns) {
    assert.equal(matchCommand(p).name, 'tasks', `alias "${p}" matches`);
  }
});

// ===========================================================================
// formatTasksSummary (TASK-058)
// ===========================================================================

test('formatTasksSummary: empty/null/non-array → "The tasks board is empty."', () => {
  assert.equal(formatTasksSummary([]), 'The tasks board is empty.');
  assert.equal(formatTasksSummary(null), 'The tasks board is empty.');
  assert.equal(formatTasksSummary(undefined), 'The tasks board is empty.');
  assert.equal(formatTasksSummary('nope'), 'The tasks board is empty.');
});

test('formatTasksSummary: active tickets listed under "Currently working on:" with lane counts', () => {
  const tickets = [
    { fm: { id: 'TASK-058', title: 'Slack tasks command', status: 'in-progress' } },
    { fm: { id: 'TASK-012', title: 'Board polish', status: 'testing' } },
    { fm: { id: 'TASK-001', title: 'Setup', status: 'done' } },
    { fm: { id: 'TASK-002', title: 'Idea', status: 'todo' } },
    { fm: { id: 'TASK-003', title: 'Spec it', status: 'defining' } },
  ];
  const out = formatTasksSummary(tickets);
  assert.match(out, /^\*Currently working on:\*/);
  assert.ok(out.includes('TASK-058 — Slack tasks command (in-progress)'));
  assert.ok(out.includes('TASK-012 — Board polish (testing)'));
  // Idle statuses are NOT listed as being worked on.
  assert.ok(!out.includes('TASK-001 — Setup'));
  // Lane-counts line in LANE_STATUSES order.
  assert.ok(out.includes('todo 1 · defining 1 · in-progress 1 · testing 1 · done 1'));
});

test('formatTasksSummary: no active tickets → "Nothing is being worked on right now."', () => {
  const out = formatTasksSummary([
    { fm: { id: 'TASK-001', title: 'Setup', status: 'done' } },
    { fm: { id: 'TASK-002', title: 'Idea', status: 'todo' } },
  ]);
  assert.ok(out.includes('Nothing is being worked on right now.'));
  assert.ok(!out.includes('*Failed testing:*'));
});

test('formatTasksSummary: failed-testing tickets get a "*Failed testing:*" list and fold into the testing count', () => {
  const out = formatTasksSummary([
    { fm: { id: 'TASK-034', title: 'Flaky feature', status: 'failed-testing' } },
    { fm: { id: 'TASK-012', title: 'Board polish', status: 'testing' } },
  ]);
  assert.ok(out.includes('*Failed testing:*'));
  assert.ok(out.includes('TASK-034 — Flaky feature (failed-testing)'));
  // failed-testing folds into the testing lane count (2), never its own column.
  assert.ok(out.includes('testing 2'));
});

test('formatTasksSummary: out-of-enum status counted under "unknown", never miscounted into todo', () => {
  const out = formatTasksSummary([
    { fm: { id: 'TASK-099', title: 'Weird', status: 'banana' } },
    { fm: { id: 'TASK-002', title: 'Idea', status: 'todo' } },
  ]);
  assert.ok(out.includes('unknown 1'));
  assert.ok(out.includes('todo 1'));
});

test('formatTasksSummary: tolerates bare fm objects (not just { fm } wrappers)', () => {
  const out = formatTasksSummary([
    { id: 'TASK-058', title: 'Bare fm', status: 'in-progress' },
  ]);
  assert.ok(out.includes('TASK-058 — Bare fm (in-progress)'));
});

test('formatTasksSummary: missing id/title render "(no id)"/"(untitled)" and never throw', () => {
  const out = formatTasksSummary([
    { fm: { status: 'in-progress' } },
  ]);
  assert.ok(out.includes('(no id) — (untitled) (in-progress)'));
});
