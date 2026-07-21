'use strict';

// Unit tests for TASK-108 — serializeAgentFile scalar frontmatter injection
// hardening (lib/agent-files.js). Exercises each rejection class on the
// fresh-format (caller-edited / new-fm) path, the unchanged folded-description
// path, the byte-identical round-trip regression, and the "never throws /
// null-on-bad-input" contract.
//
// NO DATABASE / REAL DB CONNECTION / NETWORK CALL IS MADE. This module touches
// no disk except reading the app's own bundled `.claude/agents/*.md` fixtures
// read-only for the round-trip regression. Injection payload characters are
// built from char codes so the source stays ASCII-only, matching the lib.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseAgentFile, serializeAgentFile } = require('../lib/agent-files');

const LF = String.fromCharCode(0x0a);
const CR = String.fromCharCode(0x0d);
const U2028 = String.fromCharCode(0x2028);
const U2029 = String.fromCharCode(0x2029);

const SIMPLE = [
  '---',
  'name: orchestrate-demo',
  'description: >-',
  '  A short demo agent used only in tests.',
  'tools: Read, Grep',
  'model: claude-opus',
  '---',
  '',
  'You are the demo agent.',
  ''
].join(LF);

function editAndSerialize(key, value) {
  const parsed = parseAgentFile(SIMPLE);
  parsed.fm[key] = value;
  return serializeAgentFile(parsed.fm, parsed.body);
}

// --- Rejection class: line breaks (CR, LF, U+2028, U+2029) -------------------
test('rejects LF, CR, U+2028 and U+2029 in an edited scalar value (returns null)', () => {
  for (const brk of [LF, CR, U2028, U2029]) {
    let out;
    assert.doesNotThrow(() => { out = editAndSerialize('model', 'x' + brk + 'y'); });
    assert.equal(out, null, `line separator code ${brk.charCodeAt(0)} should reject`);
  }
});

// --- Rejection class: C0 controls and DEL (0x00-0x1f, 0x7f) ------------------
test('rejects every C0 control char and DEL in an edited scalar value', () => {
  const codes = [];
  for (let c = 0x00; c <= 0x1f; c++) codes.push(c);
  codes.push(0x7f);
  for (const c of codes) {
    const out = editAndSerialize('model', 'x' + String.fromCharCode(c) + 'y');
    assert.equal(out, null, `control char 0x${c.toString(16)} should reject`);
  }
});

// --- Rejection class: value beginning (after optional whitespace) with --- ----
test('rejects a value beginning with --- (with and without leading whitespace)', () => {
  assert.equal(editAndSerialize('tools', '--- Read'), null);
  assert.equal(editAndSerialize('tools', '  ---'), null);
  assert.equal(editAndSerialize('tools', '\t---x'), null);
});

// --- Rejection class: array element injection --------------------------------
test('rejects array-element injection: tools = [Read, "x\\n---\\n"] -> null', () => {
  assert.equal(editAndSerialize('tools', ['Read', 'x' + LF + '---' + LF]), null);
});

// --- Rejection class: malformed key name -------------------------------------
test('rejects a freshly formatted key name that cannot re-parse as a top-level key', () => {
  const badKeys = ['evil' + LF + 'name', 'has space', 'colon:key', ' leadingspace'];
  for (const badKey of badKeys) {
    const parsed = parseAgentFile(SIMPLE);
    parsed.fm[badKey] = 'value';
    let out;
    assert.doesNotThrow(() => { out = serializeAgentFile(parsed.fm, parsed.body); });
    assert.equal(out, null, `key ${JSON.stringify(badKey)} should reject`);
  }
});

// --- Behavior change: newline value now rejected (was silently folded) -------
test('a non-description string value containing a newline is REJECTED (behavior change)', () => {
  assert.equal(editAndSerialize('tools', 'Read' + LF + 'tools: Bash'), null);
});

// --- Allowed: space (0x20) and legitimate values -----------------------------
test('allows spaces and normal single-line values (space is not rejected)', () => {
  const out = editAndSerialize('model', 'claude opus 4');
  assert.ok(typeof out === 'string');
  assert.equal(parseAgentFile(out).fm.model, 'claude opus 4');
});

test('allows a legitimate array value (joined with ", ")', () => {
  const out = editAndSerialize('tools', ['Read', 'Bash', 'Glob']);
  assert.ok(typeof out === 'string');
  assert.equal(parseAgentFile(out).fm.tools, 'Read, Bash, Glob');
});

test('allows --- appearing mid-value (only a leading --- is rejected)', () => {
  const out = editAndSerialize('model', 'a---b');
  assert.ok(typeof out === 'string');
  assert.equal(parseAgentFile(out).fm.model, 'a---b');
});

test('allows a dotted/hyphenated fresh key name', () => {
  const parsed = parseAgentFile(SIMPLE);
  parsed.fm['some.key-name_1'] = 'ok';
  const out = serializeAgentFile(parsed.fm, parsed.body);
  assert.ok(typeof out === 'string');
  assert.equal(parseAgentFile(out).fm['some.key-name_1'], 'ok');
});

// --- Folded description path unchanged ---------------------------------------
test('folded description path unchanged: multi-paragraph serializes as >- and re-parses', () => {
  const parsed = parseAgentFile(SIMPLE);
  parsed.fm.description = 'Alpha paragraph.' + LF + LF + 'Beta paragraph.';
  const out = serializeAgentFile(parsed.fm, parsed.body);
  assert.match(out, /description: >-/);
  assert.match(out, /\n {2}Alpha paragraph\./);
  assert.match(out, /\n {2}Beta paragraph\./);
  const reparsed = parseAgentFile(out);
  assert.ok(reparsed);
  assert.match(reparsed.fm.description, /Alpha paragraph\./);
  assert.match(reparsed.fm.description, /Beta paragraph\./);
});

test('description is NOT subject to the scalar guard (folded, so newlines are legal there)', () => {
  const parsed = parseAgentFile(SIMPLE);
  parsed.fm.description = 'A description spanning' + LF + LF + 'two paragraphs.';
  let out;
  assert.doesNotThrow(() => { out = serializeAgentFile(parsed.fm, parsed.body); });
  assert.ok(typeof out === 'string', 'description with a paragraph break must still serialize');
});

// --- Round-trip regression (unchanged keys re-emit RAW verbatim) -------------
const AGENTS_DIR = path.join(__dirname, '..', '.claude', 'agents');
const AGENT_FILES = ['ba.md', 'coder.md', 'tester.md', 'tech-lead.md'];

test('byte-identical round-trip for all four bundled agents in LF and CRLF', () => {
  for (const file of AGENT_FILES) {
    const original = fs.readFileSync(path.join(AGENTS_DIR, file), 'utf8');
    const lf = original.replace(/\r\n/g, '\n');
    for (const [label, input] of [['LF', lf], ['CRLF', lf.replace(/\n/g, '\r\n')]]) {
      const parsed = parseAgentFile(input);
      assert.ok(parsed, `${file} (${label}) should parse`);
      assert.equal(
        serializeAgentFile(parsed.fm, parsed.body),
        input,
        `${file} (${label}) must round-trip byte-identically`
      );
    }
  }
});

test('unchanged scalar keys re-emit verbatim even when a sibling would be rejected only if edited', () => {
  // Parsing then serializing without edits must never invoke the guard.
  const parsed = parseAgentFile(SIMPLE);
  assert.equal(serializeAgentFile(parsed.fm, parsed.body), SIMPLE);
});

// --- Never-throws / null-on-bad-input contract -------------------------------
test('serializeAgentFile returns null and never throws on bad input', () => {
  for (const bad of [null, undefined, 42, 'string', [], true]) {
    let out;
    assert.doesNotThrow(() => { out = serializeAgentFile(bad); });
    assert.equal(out, null);
  }
});
