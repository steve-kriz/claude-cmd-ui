'use strict';

// Unit tests for TASK-092 lib/agent-files.js — the Electron-free agent-definition
// file model: parseAgentFile / serializeAgentFile / validateAgentName. Covers the
// API surface plus the ticket's edge/failure paths (unknown keys, missing tools,
// description containing `:`/`#`, non-string input, bad serialize input, Symbol
// invisibility, spread/reconstruct behaviour).
//
// NO DATABASE / REAL DB CONNECTION / NETWORK CALL IS MADE. This module touches no
// disk, Electron, or DOM; inputs are in-memory strings and objects.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseAgentFile,
  serializeAgentFile,
  validateAgentName
} = require('../lib/agent-files');

const { FALLBACK_AGENT } = require('../lib/orchestrate-agents');

// A minimal well-formed agent file with LF endings and a body.
const SIMPLE = [
  '---',
  'name: orchestrate-demo',
  'description: >-',
  '  A short demo agent used only in tests. It has a couple of',
  '  folded lines so we exercise the block-scalar path.',
  'tools: Read, Grep',
  'model: claude-opus',
  '---',
  '',
  'You are the demo agent.',
  ''
].join('\n');

test('parseAgentFile returns fm + body for a well-formed file', () => {
  const result = parseAgentFile(SIMPLE);
  assert.ok(result);
  assert.equal(result.fm.name, 'orchestrate-demo');
  assert.equal(result.fm.tools, 'Read, Grep');
  assert.equal(result.fm.model, 'claude-opus');
  assert.match(result.fm.description, /demo agent/);
  assert.match(result.body, /You are the demo agent\./);
});

test('parseAgentFile then serializeAgentFile is byte-identical for the returned object', () => {
  const result = parseAgentFile(SIMPLE);
  assert.equal(serializeAgentFile(result.fm, result.body), SIMPLE);
});

test('serializeAgentFile accepts the whole parse result as one argument', () => {
  const result = parseAgentFile(SIMPLE);
  assert.equal(serializeAgentFile(result), SIMPLE);
});

test('Object.keys(fm) exposes only real frontmatter keys (Symbol hidden)', () => {
  const { fm } = parseAgentFile(SIMPLE);
  assert.deepEqual(Object.keys(fm), ['name', 'description', 'tools', 'model']);
  // The RAW carrier is a single own Symbol and is NON-enumerable, so it never
  // leaks via spread/JSON (TASK-113 F3 — replaces the prior always-true check).
  const syms = Object.getOwnPropertySymbols(fm);
  assert.equal(syms.length, 1);
  assert.equal(Object.getOwnPropertyDescriptor(fm, syms[0]).enumerable, false);
  // JSON/spread see only plain keys and copy zero own Symbols.
  const spread = { ...fm };
  assert.deepEqual(Object.keys(spread), ['name', 'description', 'tools', 'model']);
  assert.equal(Object.getOwnPropertySymbols(spread).length, 0);
});

test('unknown frontmatter keys round-trip untouched', () => {
  const content = [
    '---',
    'name: orchestrate-extra',
    'color: purple',
    'description: >-',
    '  Has an unknown key.',
    'tools: Read',
    'priority: 7',
    '---',
    '',
    'Body.',
    ''
  ].join('\n');
  const result = parseAgentFile(content);
  assert.ok(result);
  assert.equal(result.fm.color, 'purple');
  assert.equal(result.fm.priority, '7');
  assert.equal(serializeAgentFile(result.fm, result.body), content);
});

test('missing tools: still parses and round-trips', () => {
  const content = [
    '---',
    'name: orchestrate-notools',
    'description: >-',
    '  No tools line at all.',
    'model: claude-opus',
    '---',
    '',
    'Body without tools.',
    ''
  ].join('\n');
  const result = parseAgentFile(content);
  assert.ok(result);
  assert.equal(result.fm.tools, undefined);
  assert.equal(serializeAgentFile(result.fm, result.body), content);
});

test('description containing ":" and "#" is preserved on round-trip', () => {
  const content = [
    '---',
    'name: orchestrate-punct',
    'description: >-',
    '  Note: this description has a colon and a #hash inside it,',
    '  which must survive: verbatim.',
    'tools: Read',
    '---',
    '',
    'Body.',
    ''
  ].join('\n');
  const result = parseAgentFile(content);
  assert.ok(result);
  assert.match(result.fm.description, /Note: this description/);
  assert.match(result.fm.description, /#hash/);
  assert.equal(serializeAgentFile(result.fm, result.body), content);
});

test('non-string input to parseAgentFile returns null (never throws)', () => {
  for (const bad of [null, undefined, 42, {}, [], true]) {
    let out;
    assert.doesNotThrow(() => { out = parseAgentFile(bad); });
    assert.equal(out, null);
  }
});

test('input without an opening fence returns null', () => {
  assert.equal(parseAgentFile('name: x\ndescription: y\n'), null);
});

test('serializeAgentFile returns null on bad input (never throws)', () => {
  for (const bad of [null, undefined, 42, 'string', [], true]) {
    let out;
    assert.doesNotThrow(() => { out = serializeAgentFile(bad); });
    assert.equal(out, null);
  }
});

test('serializeAgentFile on a fresh (non-parsed) fm object produces valid, re-parseable text', () => {
  const fm = {
    name: 'orchestrate-fresh',
    description: 'A freshly built agent with no RAW metadata.',
    tools: 'Read, Grep, Glob',
    model: 'claude-opus'
  };
  const text = serializeAgentFile(fm, 'Body of the fresh agent.\n');
  assert.ok(typeof text === 'string' && text.length > 0);
  const reparsed = parseAgentFile(text);
  assert.ok(reparsed);
  assert.equal(reparsed.fm.name, 'orchestrate-fresh');
  assert.equal(reparsed.fm.tools, 'Read, Grep, Glob');
  assert.equal(reparsed.fm.model, 'claude-opus');
});

test('validateAgentName rejects empty and non-string names', () => {
  assert.equal(validateAgentName('', []).valid, false);
  assert.equal(validateAgentName(null, []).valid, false);
  assert.equal(validateAgentName(undefined, []).valid, false);
  assert.equal(validateAgentName(42, []).valid, false);
});

test('validateAgentName rejects illegal characters', () => {
  for (const bad of ['Bad Name!', 'UPPER', 'has space', 'under_score', 'dot.name']) {
    const r = validateAgentName(bad, []);
    assert.equal(r.valid, false, `${bad} should be invalid`);
    assert.ok(r.error);
  }
});

test('validateAgentName rejects the reserved FALLBACK_AGENT', () => {
  const r = validateAgentName(FALLBACK_AGENT, []);
  assert.equal(r.valid, false);
  assert.ok(r.error);
});

test('validateAgentName rejects duplicates from array or Set', () => {
  const fromArray = validateAgentName('orchestrate-ba', ['orchestrate-ba']);
  assert.equal(fromArray.valid, false);
  const fromSet = validateAgentName('orchestrate-ba', new Set(['orchestrate-ba']));
  assert.equal(fromSet.valid, false);
});

test('validateAgentName accepts a well-formed unused name and returns null error', () => {
  const r = validateAgentName('orchestrate-docs', ['orchestrate-ba']);
  assert.equal(r.valid, true);
  assert.equal(r.error, null);
});

test('editing a parsed value re-serializes via the fresh formatter (still valid)', () => {
  const result = parseAgentFile(SIMPLE);
  result.fm.name = 'orchestrate-renamed';
  const text = serializeAgentFile(result.fm, result.body);
  const reparsed = parseAgentFile(text);
  assert.ok(reparsed);
  assert.equal(reparsed.fm.name, 'orchestrate-renamed');
});
