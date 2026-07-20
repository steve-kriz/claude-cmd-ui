'use strict';

// E2E cucumber-style scenarios for TASK-056: lib/slack-commands.js — the
// Electron-free DECISION CORE of the Slack command system. When Slack is
// connected the proxy forwards every thread reply to Claude verbatim; certain
// trigger phrases should instead be answered by the app itself. This module
// normalizes inbound message text, matches it against a data-only command
// registry, and lists the available commands.
//
// These are the ticket's Gherkin scenarios expressed as Given/When/Then
// `node --test` cases (no `cucumber` npm package — same scenario layout as
// test/slack-thread-replies.test.js PART 3). The module is PURE: no DB, no
// network, no DOM, no Electron. There are therefore no real connections to
// mock — every registry is an in-memory object injected into the API, exactly
// as the renderer (TASK-057) and real commands (TASK-058/059/060) will do.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_COMMANDS,
  normalizeCommandInput,
  matchCommand,
  listCommands,
} = require('../lib/slack-commands');

// ===========================================================================
// Feature: a Slack thread phrase is recognised as an app command
// ===========================================================================

test('Scenario: a trigger phrase matches its command regardless of case and punctuation', () => {
  // Given a registry with a "tasks" command triggered by "show me the tasks"
  const registry = [
    { name: 'tasks', description: 'Show the tasks', patterns: ['show me the tasks'] },
  ];
  // When a user types the phrase with odd casing, spacing and trailing punctuation
  const result = matchCommand('  Show me   the TASKS?! ', registry);
  // Then the "tasks" entry is returned (name + the full command object)
  assert.ok(result, 'a match is returned');
  assert.equal(result.name, 'tasks');
  assert.equal(result.command, registry[0]);
});

test('Scenario: ordinary conversation is never intercepted', () => {
  // Given a registry with a "tasks" command triggered by "show me the tasks"
  const registry = [
    { name: 'tasks', description: 'Show the tasks', patterns: ['show me the tasks'] },
  ];
  // When a user types a sentence that merely CONTAINS the trigger words
  const result = matchCommand('please fix the tasks page and show me the diff', registry);
  // Then nothing matches — matching is whole-phrase, never substring/fuzzy —
  // so the message flows through to Claude verbatim
  assert.equal(result, null);
});

test('Scenario: registry order decides ties', () => {
  // Given two commands "a" and "b" that share the trigger phrase "go",
  // with "a" listed first
  const registry = [
    { name: 'a', description: 'first', patterns: ['go'] },
    { name: 'b', description: 'second', patterns: ['go'] },
  ];
  // When the shared phrase is typed
  const result = matchCommand('go', registry);
  // Then the FIRST entry in registry order ("a") wins
  assert.ok(result, 'a match is returned');
  assert.equal(result.name, 'a');
  assert.equal(result.command, registry[0]);
});

test('Scenario: listCommands feeds a future help command', () => {
  // Given a registry carrying descriptions for "tasks" and "status"
  const registry = [
    { name: 'tasks', description: 'Show the current tasks', patterns: ['show me the tasks'] },
    { name: 'status', description: 'Show the session status', patterns: ['what is the status'] },
  ];
  // When the app lists the available commands (for a future /help)
  const listed = listCommands(registry);
  // Then it returns each name + description in registry order
  assert.deepEqual(listed, [
    { name: 'tasks', description: 'Show the current tasks' },
    { name: 'status', description: 'Show the session status' },
  ]);
});

test('Scenario (edge/failure): junk input never throws', () => {
  // Given a registry whose entry is MALFORMED (missing its patterns array)
  const badRegistry = [{ name: 'broken', description: 'no patterns here' }];

  // When normalizeCommandInput is fed non-string / empty / whitespace junk
  // Then it never throws and returns "" for every non-string, "" for blanks
  assert.doesNotThrow(() => {
    assert.equal(normalizeCommandInput(null), '');
    assert.equal(normalizeCommandInput(undefined), '');
    assert.equal(normalizeCommandInput(42), '');
    assert.equal(normalizeCommandInput(''), '');
    assert.equal(normalizeCommandInput('   '), '');
  });

  // And when matchCommand is fed the same junk against the malformed registry
  // Then it never throws and always returns null (nothing is intercepted)
  assert.doesNotThrow(() => {
    assert.equal(matchCommand(null, badRegistry), null);
    assert.equal(matchCommand(undefined, badRegistry), null);
    assert.equal(matchCommand(42, badRegistry), null);
    assert.equal(matchCommand('', badRegistry), null);
    assert.equal(matchCommand('   ', badRegistry), null);
    // even a real phrase can't match an entry with no patterns array
    assert.equal(matchCommand('broken', badRegistry), null);
  });
});

// ===========================================================================
// Feature (TASK-062): registry authors may write trigger patterns in any
// case/whitespace/punctuation — matchCommand normalizes the PATTERN as well as
// the input, so a messy pattern still matches a normalized message. These
// scenarios FAIL if the pattern side is compared raw (pattern === normalized).
// ===========================================================================

test('Scenario: a mixed-case, punctuated pattern matches normalized input', () => {
  // Given a registry command whose patterns include "  SHOW Me The Tasks?! "
  const registry = [
    {
      name: 'show-tasks',
      description: 'List the current tasks',
      patterns: ['  SHOW Me The Tasks?! '],
    },
  ];
  // When matchCommand is called with "show me the tasks"
  const result = matchCommand('show me the tasks', registry);
  // Then it returns that command entry (name + full command object)
  assert.ok(result, 'a match is returned despite the messy pattern');
  assert.equal(result.name, 'show-tasks');
  assert.equal(result.command, registry[0]);
});

test('Scenario: the same messy pattern matches a whitespace/case input variant', () => {
  // Given the same registry whose pattern is "  SHOW Me The Tasks?! "
  const registry = [
    {
      name: 'show-tasks',
      description: 'List the current tasks',
      patterns: ['  SHOW Me The Tasks?! '],
    },
  ];
  // When matchCommand is called with "Show Me   The Tasks"
  const result = matchCommand('Show Me   The Tasks', registry);
  // Then it returns the same command entry
  assert.ok(result, 'a match is returned for the input variant');
  assert.equal(result.name, 'show-tasks');
  assert.equal(result.command, registry[0]);
});

// ===========================================================================
// Scenario: the built-in registry ships the "tasks" command (TASK-058), so its
// trigger phrases are intercepted while ordinary conversation still flows to
// Claude.
// ===========================================================================

test('Scenario: the built-in "tasks" command is intercepted while other phrases pass through', () => {
  // Given the shipped built-in registry
  assert.ok(Array.isArray(DEFAULT_COMMANDS));
  const tasks = DEFAULT_COMMANDS.find((c) => c.name === 'tasks');
  assert.ok(tasks, 'the built-in registry carries a "tasks" command');
  // And listCommands over the default surfaces it (name + description) for /help
  assert.ok(listCommands().some((c) => c.name === 'tasks' && c.description === tasks.description));
  // Then each of its trigger phrases is intercepted
  assert.equal(matchCommand('show me the tasks').name, 'tasks');
  assert.equal(matchCommand('what are you working on').name, 'tasks');
  // But an unrelated phrase is not — that message forwards to Claude verbatim
  assert.equal(matchCommand('please fix the build'), null);
});
