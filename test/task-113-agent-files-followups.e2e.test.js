'use strict';

// E2e cucumber-style scenarios for TASK-113 — TASK-092 review follow-ups in
// lib/agent-files.js (degenerate-slug rejection + serializer coverage + the F5
// multi-paragraph fresh-fold fix). Written in Given/When/Then form as plain
// `node --test` cases; no `cucumber` package is installed or required. Each
// scenario mirrors the Gherkin in
// tasks/testing/TASK-113-task092-slug-and-test-coverage.md.
//
// NO DATABASE / REAL DB CONNECTION / NETWORK CALL IS MADE. The only real I/O is
// reading the app's own bundled `.claude/agents/*.md` files read-only as
// round-trip fixtures; CRLF vs LF variants are produced in-memory by EOL
// conversion.

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

// --- Read-only bundled fixtures + EOL helpers (the task-092 e2e pattern) ------
const AGENTS_DIR = path.join(__dirname, '..', '.claude', 'agents');
const AGENT_FILES = ['ba.md', 'coder.md', 'tester.md', 'tech-lead.md'];
function readAgent(name) {
  return fs.readFileSync(path.join(AGENTS_DIR, name), 'utf8');
}
function withEol(content, eol) {
  const lf = content.replace(/\r\n/g, '\n');
  return eol === '\r\n' ? lf.replace(/\n/g, '\r\n') : lf;
}

// An in-memory multi-paragraph fixture: a folded `>-` description with a blank
// line between two paragraphs (so fm.description parses to a value with `\n`).
const MULTI = [
  '---',
  'name: orchestrate-multi',
  'description: >-',
  '  First paragraph of the multi block that has enough words to read like a',
  '  realistic bundled agent definition file here.',
  '',
  '  Second paragraph after a blank line separating the two.',
  'tools: Read',
  'model: claude-opus',
  '---',
  '',
  'Multi body.',
  ''
].join('\n');

test('Scenario: Degenerate slugs are rejected (failure)', () => {
  // Given existing agent names are empty
  const existing = [];

  // When validateAgentName is called with "-", "--", "---", "-foo", "foo-"
  const cases = ['-', '--', '---', '-foo', 'foo-'];
  for (const name of cases) {
    let r;
    // Then each returns valid=false with a clear hyphen error and no throw
    assert.doesNotThrow(() => { r = validateAgentName(name, existing); });
    assert.equal(r.valid, false, `${JSON.stringify(name)} must be rejected`);
    assert.equal(r.error, 'name may not start or end with a hyphen');
    assert.ok(!/\.$/.test(r.error), 'clear message, no trailing period');
  }
});

test('Scenario: Well-formed hyphenated names still accepted', () => {
  // When validateAgentName gets "orchestrate-docs" with existing ["orchestrate-ba"]
  const r = validateAgentName('orchestrate-docs', ['orchestrate-ba']);
  // Then valid=true, error null
  assert.equal(r.valid, true);
  assert.equal(r.error, null);
  // And interior-hyphen / single-char names are unaffected.
  for (const good of ['a-b-c', 'a', '7']) {
    assert.equal(validateAgentName(good, []).valid, true, `${good} valid`);
  }
});

test('Scenario: Existing rejections unchanged', () => {
  // When validateAgentName gets "", null, "Bad Name!", the reserved name and a dup
  const calls = [
    validateAgentName('', []),
    validateAgentName(null, []),
    validateAgentName('Bad Name!', []),
    validateAgentName(FALLBACK_AGENT, []),
    validateAgentName('orchestrate-ba', ['orchestrate-ba'])
  ];
  // Then every call is valid=false with a non-empty error
  for (const r of calls) {
    assert.equal(r.valid, false);
    assert.equal(typeof r.error, 'string');
    assert.ok(r.error.length > 0);
  }
});

test('Scenario: RAW Symbol present but hidden', () => {
  // Given a parsed agent file fm
  const { fm } = parseAgentFile(readAgent('ba.md'));

  // Then fm has exactly one own Symbol, it is non-enumerable, and a spread copy
  // has zero own symbols.
  const syms = Object.getOwnPropertySymbols(fm);
  assert.equal(syms.length, 1, 'exactly one own Symbol (the RAW carrier)');
  assert.equal(Object.getOwnPropertyDescriptor(fm, syms[0]).enumerable, false);
  assert.equal(Object.getOwnPropertySymbols({ ...fm }).length, 0);
});

test('Scenario: Editing only the description re-folds it while siblings stay raw', () => {
  // Given a parsed agent file with name/description/tools/model
  const original = readAgent('ba.md');
  const { fm, body } = parseAgentFile(original);
  const rawName = fm.name;
  const rawTools = fm.tools;
  const rawModel = fm.model;

  // When only fm.description changes and the file is serialized
  fm.description = 'A replacement single-line description for the BA agent.';
  const out = serializeAgentFile(fm, body);
  assert.ok(typeof out === 'string');

  // Then the output re-parses with the new description ...
  const rp = parseAgentFile(out);
  assert.equal(rp.fm.description, 'A replacement single-line description for the BA agent.');
  // ... and the name/tools/model lines are byte-identical (RAW re-emit) — use
  // the file's own EOL so CRLF fixtures match too ...
  const eol = /\r\n/.test(out) ? '\r\n' : '\n';
  assert.ok(out.includes(eol + 'name: ' + rawName + eol), 'name line verbatim');
  assert.ok(out.includes(eol + 'tools: ' + rawTools + eol), 'tools line verbatim');
  assert.ok(out.includes(eol + 'model: ' + rawModel + eol), 'model line verbatim');
  // ... and the body is byte-identical to the original file's body.
  assert.equal(rp.body, body, 'body byte-identical');
});

test('Scenario: Editing only the model replaces one line', () => {
  // Given a parsed agent file with a multi-line folded description
  const original = MULTI;
  const { fm, body } = parseAgentFile(original);

  // When only fm.model changes and the file is serialized
  fm.model = 'claude-fable-5';
  const out = serializeAgentFile(fm, body);

  // Then the output equals the original with only the model line replaced.
  const expected = original.replace('model: claude-opus', 'model: claude-fable-5');
  assert.equal(out, expected);
});

test('Scenario: Multi-paragraph folded description round-trips (RAW)', () => {
  // Given an agent file whose description block has a blank line between two
  // paragraphs — both an in-memory fixture and every bundled agent (LF + CRLF).
  const parsedMulti = parseAgentFile(MULTI);
  // When it is parsed then serialized unchanged
  // Then fm.description contains a newline at the break ...
  assert.match(parsedMulti.fm.description, /\n/);
  // ... and the output is byte-identical to the input.
  assert.equal(serializeAgentFile(parsedMulti.fm, parsedMulti.body), MULTI);

  // And the bundled agents (which use folded `>-`) round-trip byte-identically
  // in both LF and CRLF (the unchanged/RAW path is untouched by the F5 fix).
  for (const file of AGENT_FILES) {
    const orig = readAgent(file);
    for (const eol of ['\n', '\r\n']) {
      const input = withEol(orig, eol);
      const parsed = parseAgentFile(input);
      assert.ok(parsed, `${file} should parse`);
      assert.equal(serializeAgentFile(parsed.fm, parsed.body), input,
        `${file} (${eol === '\n' ? 'LF' : 'CRLF'}) byte-identical`);
    }
  }
});

test('Scenario: Fresh re-wrap preserves paragraph breaks', () => {
  // Given a parsed agent file
  const { fm, body } = parseAgentFile(readAgent('ba.md'));

  // When fm.description is set to a two-paragraph value containing a newline —
  // including a paragraph long enough to force 74-char wrapping — and serialized
  // then re-parsed.
  const longPara = 'This is a deliberately long first paragraph that clearly '
    + 'exceeds seventy four characters in length so it must wrap across several '
    + 'physical lines when folded.';
  const value = longPara + '\nShort trailing second paragraph here.';
  fm.description = value;
  const out = serializeAgentFile(fm, body);
  assert.ok(typeof out === 'string');

  // Then the fresh block wraps at 74 chars with 2-space indent. Inspect ONLY the
  // description block (from `description: >-` to the next top-level key), using
  // the file's own EOL so CRLF fixtures don't inflate the measured length.
  const eol = /\r\n/.test(out) ? '\r\n' : '\n';
  const lines = out.split(eol);
  const start = lines.indexOf('description: >-');
  assert.ok(start !== -1, 'fresh description block emitted');
  const blockLines = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^[^ ]/.test(lines[i])) break; // next top-level key or fence
    blockLines.push(lines[i]);
  }
  const contentLines = blockLines.filter((l) => l.startsWith('  '));
  assert.ok(contentLines.length >= 2, 'long paragraph wrapped to multiple lines');
  for (const l of contentLines) {
    // content payload = line minus the 2-space indent; must be <= 74 chars.
    assert.ok(l.length - 2 <= 74, `wrapped line within 74: ${JSON.stringify(l)}`);
  }

  // ... and the re-parsed description equals the two-paragraph value exactly
  // (paragraphs not collapsed).
  const rp = parseAgentFile(out);
  assert.equal(rp.fm.description, value);
});

test('Scenario: Fresh re-wrap round-trips a double-newline value too (edge)', () => {
  // Given a parsed agent file, When the description is a double-\n two-paragraph
  // value and serialized then re-parsed, Then it round-trips exactly.
  const { fm, body } = parseAgentFile(readAgent('coder.md'));
  const value = 'Alpha paragraph.\n\nBeta paragraph after a blank line.';
  fm.description = value;
  const out = serializeAgentFile(fm, body);
  const rp = parseAgentFile(out);
  assert.equal(rp.fm.description, value);
});
