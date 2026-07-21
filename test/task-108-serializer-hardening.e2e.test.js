'use strict';

// E2e cucumber-style scenarios for TASK-108 — serializeAgentFile scalar
// frontmatter injection hardening (lib/agent-files.js). Written in
// Given/When/Then form as plain `node --test` cases; no `cucumber` package is
// installed or required. Each scenario mirrors the Gherkin in
// tasks/testing/TASK-108-agent-files-scalar-injection-hardening.md.
//
// NO DATABASE / REAL DB CONNECTION / NETWORK CALL IS MADE. The only real I/O is
// reading the app's own bundled `.claude/agents/*.md` files as read-only
// round-trip fixtures; CRLF vs LF variants are produced in-memory by EOL
// conversion. Injection payloads (line separators / control chars) are built
// from char codes so this source stays ASCII-only, matching lib/agent-files.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseAgentFile, serializeAgentFile } = require('../lib/agent-files');

// --- Injection payload characters, built from char codes (ASCII-safe source) --
const LF = String.fromCharCode(0x0a);
const CR = String.fromCharCode(0x0d);
const NUL = String.fromCharCode(0x00);
const C1F = String.fromCharCode(0x1f);
const DEL = String.fromCharCode(0x7f);
const U2028 = String.fromCharCode(0x2028); // LINE SEPARATOR
const U2029 = String.fromCharCode(0x2029); // PARAGRAPH SEPARATOR

// A minimal well-formed bundled-shape agent file (LF endings, has a body).
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
].join(LF);

// Read a bundled agent file as raw bytes -> string, preserving its on-disk EOLs.
const AGENTS_DIR = path.join(__dirname, '..', '.claude', 'agents');
const AGENT_FILES = ['ba.md', 'coder.md', 'tester.md', 'tech-lead.md'];
function readAgent(name) {
  return fs.readFileSync(path.join(AGENTS_DIR, name), 'utf8');
}
function withEol(content, eol) {
  const lf = content.replace(/\r\n/g, '\n');
  return eol === '\r\n' ? lf.replace(/\n/g, '\r\n') : lf;
}

// Parse SIMPLE, mutate one fm key, and serialize — the "caller edited a value"
// fresh-format path this ticket hardens.
function editAndSerialize(key, value) {
  const parsed = parseAgentFile(SIMPLE);
  parsed.fm[key] = value;
  return serializeAgentFile(parsed.fm, parsed.body);
}

test('Scenario: Newline in an edited tools value is rejected', () => {
  // Given a parsed bundled-shape agent file
  // When fm.tools is set to a value containing a newline + a fake key line
  let out;
  assert.doesNotThrow(() => {
    out = editAndSerialize('tools', 'Read' + LF + 'tools: Bash');
  });
  // Then it returns null and does not throw
  assert.equal(out, null);
});

test('Scenario: Premature fence via model is rejected (failure)', () => {
  // Given a fresh fm (no RAW metadata) whose model smuggles a closing fence
  const fm = {
    name: 'orchestrate-fresh',
    description: 'A freshly built agent.',
    tools: 'Read',
    model: 'claude-opus' + LF + '---' + LF + 'injected: true'
  };
  // When serializeAgentFile(fm, body) is called
  let out;
  assert.doesNotThrow(() => {
    out = serializeAgentFile(fm, 'Body of the fresh agent.' + LF);
  });
  // Then it returns null and does not throw
  assert.equal(out, null);
});

test('Scenario: Lone carriage return is rejected', () => {
  // Given a parsed LF agent file whose fm.model is edited to end with a lone CR
  // When serializeAgentFile is called
  let out;
  assert.doesNotThrow(() => {
    out = editAndSerialize('model', 'claude-opus' + CR);
  });
  // Then it returns null
  assert.equal(out, null);
});

test('Scenario: Unicode line separators and control chars are rejected', () => {
  // Given fresh fm values containing U+2028, U+2029, and C0/DEL control chars
  const payloads = [
    'a' + U2028 + 'b',
    'a' + U2029 + 'b',
    'a' + NUL + 'b',
    'a' + C1F + 'b',
    'a' + DEL + 'b'
  ];
  // When serializeAgentFile is called for each (via an edited model value)
  // Then it returns null for each
  for (const payload of payloads) {
    let out;
    assert.doesNotThrow(() => {
      out = editAndSerialize('model', payload);
    });
    assert.equal(out, null, `payload with code ${payload.charCodeAt(1)} should reject`);
  }
});

test('Scenario: Leading --- and array-element injection are rejected', () => {
  // Given fm.tools "--- Read", "  ---" (leading whitespace), and an array whose
  // element smuggles a fence
  const cases = [
    '--- Read',
    '  ---',
    ['Read', 'x' + LF + '---' + LF]
  ];
  // When serializeAgentFile is called for each
  // Then it returns null for each
  for (const value of cases) {
    let out;
    assert.doesNotThrow(() => {
      out = editAndSerialize('tools', value);
    });
    assert.equal(out, null, `tools=${JSON.stringify(value)} should reject`);
  }
});

test('Scenario: Malformed key name is rejected', () => {
  // Given a parsed agent file where the caller adds a key whose name has a newline
  const parsed = parseAgentFile(SIMPLE);
  parsed.fm['evil' + LF + 'name'] = 'x';
  // When serializeAgentFile is called
  let out;
  assert.doesNotThrow(() => {
    out = serializeAgentFile(parsed.fm, parsed.body);
  });
  // Then it returns null and does not throw
  assert.equal(out, null);
});

test('Scenario: Folded description path unchanged', () => {
  // Given a parsed agent file whose description is edited to two paragraphs
  const parsed = parseAgentFile(SIMPLE);
  const para1 = 'First paragraph with several words that should wrap because it '
    + 'clearly exceeds seventy four characters in total length here.';
  const para2 = 'Second distinct paragraph that must survive the round-trip.';
  parsed.fm.description = para1 + LF + LF + para2;

  // When serializeAgentFile is called
  let out;
  assert.doesNotThrow(() => {
    out = serializeAgentFile(parsed.fm, parsed.body);
  });

  // Then the output contains "description: >-" with 2-space-indented lines...
  assert.ok(typeof out === 'string');
  assert.match(out, /description: >-/);
  assert.match(out, /\n {2}First paragraph/);
  assert.match(out, /\n {2}Second distinct paragraph/);

  // ...and re-parses preserving the text of both paragraphs
  const reparsed = parseAgentFile(out);
  assert.ok(reparsed, 'edited folded description must re-parse');
  assert.match(reparsed.fm.description, /First paragraph with several words/);
  assert.match(reparsed.fm.description, /Second distinct paragraph/);
  // The paragraph break is preserved faithfully: the fixture's double newline
  // (a blank line between two paragraphs) round-trips as a double newline. Prior
  // to the TASK-113 F5 fix formatKey emitted no blank separator and this
  // collapsed to a single `\n`; the F5 fix now round-trips paragraph breaks
  // 1:1, so the meaningful assertion is the blank line survives.
  assert.match(reparsed.fm.description, /length here\.\n\nSecond distinct/);
});

test('Scenario: Byte-identical round-trip for bundled agents still holds (regression)', () => {
  for (const file of AGENT_FILES) {
    const original = readAgent(file);
    for (const eol of ['\n', '\r\n']) {
      const label = eol === '\n' ? 'LF' : 'CRLF';
      // Given a bundled agent file normalized to a specific line ending
      const input = withEol(original, eol);
      // When parsed then serialized unmodified
      const parsed = parseAgentFile(input);
      assert.ok(parsed, `${file} (${label}) should parse`);
      const output = serializeAgentFile(parsed.fm, parsed.body);
      // Then output equals input byte-for-byte
      assert.equal(output, input, `${file} (${label}) must round-trip byte-identically`);
    }
  }
});

test('Scenario: Legitimate single-line edit still serializes (regression)', () => {
  // Given a parsed agent file whose fm.model is edited to a legitimate value
  // When serializeAgentFile is called
  let out;
  assert.doesNotThrow(() => {
    out = editAndSerialize('model', 'claude-fable-5');
  });
  // Then it returns re-parseable text whose fm.model is "claude-fable-5"
  assert.ok(typeof out === 'string' && out.length > 0);
  const reparsed = parseAgentFile(out);
  assert.ok(reparsed);
  assert.equal(reparsed.fm.model, 'claude-fable-5');
});

test('Scenario: Existing bad-input contract preserved (edge)', () => {
  // Given a range of bad inputs
  // When serializeAgentFile is called with each
  // Then it returns null and never throws
  for (const bad of [null, undefined, 42, 'string', [], true]) {
    let out;
    assert.doesNotThrow(() => { out = serializeAgentFile(bad); });
    assert.equal(out, null, `${String(bad)} should serialize to null`);
  }
});
