'use strict';

// TASK-059: the Slack "help" command replies in-thread with a list of every
// registered command, generated from the SAME registry the matcher uses
// (formatHelp iterates it) so help can never drift from what actually works.
//
// Two layers (mirroring test/slack-tasks-command.test.js):
//
//   1. Pure unit tests for lib formatHelp — order, aliases shown, missing
//      description placeholder, empty/null registry, and the whole-phrase
//      matching of all four trigger phrases (plus the "I need help with the
//      build" regression proving `help` does not match inside a sentence).
//
//   2. renderer/renderer.js source-scans — the browser-side handler is not
//      require()-able, so we assert against its source: the SLACK_DEFAULT_COMMANDS
//      `help` entry, the verbatim formatHelp mirror + its "Mirrors … in
//      lib/slack-commands.js" sync note, and the SLACK_COMMAND_HANDLERS.help wire.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  DEFAULT_COMMANDS,
  matchCommand,
  formatHelp,
} = require('../lib/slack-commands');

// ===========================================================================
// PART 1 — formatHelp (pure)
// ===========================================================================

test('formatHelp: one line per command in registry order with name, description, aliases', () => {
  const registry = [
    { name: 'tasks', description: 'Show the tasks', patterns: ['show tasks', 'tasks'] },
    { name: 'help', description: 'List commands', patterns: ['help', 'commands'] },
  ];
  assert.equal(
    formatHelp(registry),
    '*tasks* — Show the tasks (say: "show tasks", "tasks")\n'
    + '*help* — List commands (say: "help", "commands")',
  );
});

test('formatHelp: entry missing a description renders "(no description)"', () => {
  const registry = [{ name: 'orphan', patterns: ['do it'] }];
  assert.equal(formatHelp(registry), '*orphan* — (no description) (say: "do it")');
});

test('formatHelp: entry with no usable patterns omits the "(say: …)" suffix', () => {
  const registry = [{ name: 'bare', description: 'A bare command', patterns: [] }];
  assert.equal(formatHelp(registry), '*bare* — A bare command');
});

test('formatHelp: empty/null/non-array registry → "No commands are available." (never throws)', () => {
  assert.equal(formatHelp([]), 'No commands are available.');
  assert.equal(formatHelp(null), 'No commands are available.');
  assert.equal(formatHelp('nope'), 'No commands are available.');
  // A registry of only malformed (skipped) entries also degrades, no throw.
  assert.equal(formatHelp([null, false]), 'No commands are available.');
});

test('formatHelp: defaults to DEFAULT_COMMANDS and lists every built-in command (no drift)', () => {
  const out = formatHelp();
  for (const cmd of DEFAULT_COMMANDS) {
    assert.ok(out.includes(`*${cmd.name}*`), `help lists "${cmd.name}"`);
    assert.ok(out.includes(cmd.description), `help shows "${cmd.name}" description`);
  }
  // The help command lists itself, and tasks, straight from the registry.
  assert.ok(out.includes('*tasks*'));
  assert.ok(out.includes('*help*'));
});

// ===========================================================================
// PART 2 — DEFAULT_COMMANDS help entry + matching
// ===========================================================================

test('DEFAULT_COMMANDS: exported and contains the built-in help command (TASK-059)', () => {
  const help = DEFAULT_COMMANDS.find((c) => c.name === 'help');
  assert.ok(help, 'a "help" entry exists');
  assert.equal(help.description, 'List the commands this thread understands');
  assert.deepEqual(help.patterns, ['help', 'commands', 'show commands', 'what can you do']);
});

test('matchCommand: all four help trigger phrases resolve to the help command', () => {
  for (const phrase of ['help', 'commands', 'show commands', 'what can you do']) {
    assert.equal(matchCommand(phrase).name, 'help', `"${phrase}" matches help`);
  }
  // Case/punctuation-insensitive via normalization.
  assert.equal(matchCommand('HELP!').name, 'help');
  assert.equal(matchCommand('  What can you do?  ').name, 'help');
});

test('matchCommand (regression): "help" inside a sentence goes to Claude (no match)', () => {
  assert.equal(matchCommand('I need help with the build'), null);
  assert.equal(matchCommand('can you help me here'), null);
});

// ===========================================================================
// PART 3 — renderer source-scan (mirror + handler)
// ===========================================================================

const RENDERER = path.join(__dirname, '..', 'renderer', 'renderer.js');
const rendererSrc = fs.readFileSync(RENDERER, 'utf8').replace(/\r\n/g, '\n');

test('renderer SLACK_DEFAULT_COMMANDS carries the help command with all four aliases', () => {
  const idx = rendererSrc.indexOf('const SLACK_DEFAULT_COMMANDS = [');
  assert.ok(idx !== -1, 'SLACK_DEFAULT_COMMANDS present');
  const block = rendererSrc.slice(idx, idx + 900);
  assert.match(block, /name:\s*'help'/);
  assert.match(block, /List the commands this thread understands/);
  for (const alias of ['help', 'commands', 'show commands', 'what can you do']) {
    assert.ok(block.includes(`'${alias}'`), `alias "${alias}" present`);
  }
});

test('renderer mirrors formatHelp verbatim with the "Mirrors … in lib/slack-commands.js" sync note', () => {
  const idx = rendererSrc.indexOf('function formatHelp(registry');
  assert.ok(idx !== -1, 'formatHelp mirror present');
  const preamble = rendererSrc.slice(idx - 700, idx);
  assert.match(preamble, /Mirrors formatHelp in lib\/slack-commands\.js; keep in sync/);
  const block = rendererSrc.slice(idx, idx + 1100);
  assert.match(block, /return 'No commands are available\.'/);
  assert.match(block, /\(no description\)/);
  assert.match(block, /\(say: \$\{patterns\.map/);
  assert.match(block, /\*\$\{name\}\* — \$\{description\}/);
});

test('renderer SLACK_COMMAND_HANDLERS.help calls formatHelp on the live registry', () => {
  assert.match(rendererSrc, /help:\s*async \(\)\s*=>\s*formatHelp\(SLACK_DEFAULT_COMMANDS\)/);
});
