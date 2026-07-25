'use strict';

// E2e cucumber-style scenarios for TASK-092 (lib/agent-files.js), written in
// Given/When/Then form as plain `node --test` cases — no `cucumber` package is
// installed or required. Each scenario mirrors the Gherkin in
// tasks/testing/TASK-092-agent-files-lib.md.
//
// NO DATABASE / REAL DB CONNECTION / NETWORK CALL IS MADE. The only real I/O is
// reading the app's own bundled `.claude/agents/*.md` files as fixtures (never
// modified); CRLF vs LF variants are produced in-memory by EOL conversion.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  parseAgentFile,
  serializeAgentFile,
  validateAgentName
} = require('../lib/agent-files');

const { FALLBACK_AGENT } = require('../lib/orchestrate-agents');

const AGENTS_DIR = path.join(__dirname, '..', '.claude', 'agents');
const AGENT_FILES = ['ba.md', 'coder.md', 'tester.md', 'tech-lead.md'];

// Read a bundled agent file as raw bytes -> string, preserving its on-disk EOLs.
function readAgent(name) {
  return fs.readFileSync(path.join(AGENTS_DIR, name), 'utf8');
}

// Normalize to LF, then re-emit with the requested EOL. This gives a clean CRLF
// or LF variant regardless of what the file happens to use on disk.
function withEol(content, eol) {
  const lf = content.replace(/\r\n/g, '\n');
  return eol === '\r\n' ? lf.replace(/\n/g, '\r\n') : lf;
}

test('Scenario: Parsing ba.md', () => {
  // Given the bundled business-analyst agent definition
  const content = readAgent('ba.md');

  // When parseAgentFile runs on it
  const result = parseAgentFile(content);

  // Then it parses to a non-null result with the expected frontmatter
  assert.ok(result, 'parseAgentFile should return a result for ba.md');
  // And fm.name is "orchestrate-ba" and fm.model is "claude-opus-4-8"
  assert.equal(result.fm.name, 'orchestrate-ba');
  assert.equal(result.fm.model, 'claude-opus-4-8');
});

test('Scenario: Byte-identical round-trip (LF and CRLF) for every bundled agent file', () => {
  for (const file of AGENT_FILES) {
    const original = readAgent(file);

    for (const eol of ['\n', '\r\n']) {
      const label = eol === '\n' ? 'LF' : 'CRLF';

      // Given a bundled agent file normalized to a specific line ending
      const input = withEol(original, eol);

      // When it is parsed and the returned object serialized back
      const parsed = parseAgentFile(input);
      assert.ok(parsed, `${file} (${label}) should parse`);
      const output = serializeAgentFile(parsed.fm, parsed.body);

      // Then the bytes are reproduced exactly
      assert.equal(
        output,
        input,
        `${file} (${label}) should round-trip byte-identically`
      );
    }
  }
});

test('Scenario: Byte-identical round-trip via single-argument (parse result) form', () => {
  for (const file of AGENT_FILES) {
    const original = readAgent(file);
    for (const eol of ['\n', '\r\n']) {
      const input = withEol(original, eol);
      // When serialize is handed the whole parse result object
      const output = serializeAgentFile(parseAgentFile(input));
      // Then it still reproduces the original bytes
      assert.equal(output, input, `${file} single-arg round-trip`);
    }
  }
});

test('Scenario: Invalid names rejected (failure path)', () => {
  const existing = ['orchestrate-ba', 'orchestrate-coder'];

  // When validateAgentName gets an empty name
  // Then it reports an error
  const empty = validateAgentName('', existing);
  assert.equal(empty.valid, false);
  assert.ok(empty.error, 'empty name should carry an error message');

  // When validateAgentName gets a name with illegal characters/spaces
  const bad = validateAgentName('Bad Name!', existing);
  assert.equal(bad.valid, false);
  assert.ok(bad.error);

  // When validateAgentName gets an already-existing name
  const dup = validateAgentName('orchestrate-ba', existing);
  assert.equal(dup.valid, false);
  assert.ok(dup.error);

  // When validateAgentName gets the reserved fallback agent name
  const reserved = validateAgentName(FALLBACK_AGENT, existing);
  assert.equal(reserved.valid, false);
  assert.ok(reserved.error);
  assert.equal(FALLBACK_AGENT, 'general-purpose');
});

test('Scenario: Valid name accepted', () => {
  // When validateAgentName gets a well-formed, unused name
  const result = validateAgentName('orchestrate-docs', ['orchestrate-ba']);
  // Then it is valid with a null error
  assert.equal(result.valid, true);
  assert.equal(result.error, null);
});

test('Scenario: Unclosed frontmatter (edge) returns null without throwing', () => {
  // Given a file that opens a frontmatter fence but never closes it
  const content = '---\nname: orchestrate-x\ndescription: no closing fence\nbody text here';

  // When parseAgentFile is called
  let result;
  assert.doesNotThrow(() => {
    result = parseAgentFile(content);
  }, 'parseAgentFile must never throw on unclosed frontmatter');

  // Then it returns null
  assert.equal(result, null);
});
