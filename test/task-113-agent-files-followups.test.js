'use strict';

// Unit tests for TASK-113 — TASK-092 review follow-ups in lib/agent-files.js:
//   F2  validateAgentName rejects degenerate (leading/trailing/all-hyphen) slugs.
//   F3  the parsed fm carries exactly one own Symbol (the RAW carrier), which is
//       non-enumerable and does not survive an object spread.
//   F4  editing ONLY one key (description or model) re-emits siblings byte-for-byte
//       from RAW while the edited key is fresh-formatted.
//   F5  fresh-fold of a multi-paragraph description round-trips paragraph breaks.
//
// NO DATABASE / REAL DB CONNECTION / NETWORK CALL IS MADE. This module touches no
// disk, Electron or DOM; inputs are in-memory strings and objects.

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

// A fixture whose description is a genuine two-paragraph folded block (a blank
// line between the paragraphs), used for the model-only-edit sibling check (F4).
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

// ---------------------------------------------------------------------------
// F2 — validateAgentName degenerate-slug matrix
// ---------------------------------------------------------------------------

test('F2: validateAgentName rejects leading/trailing/all-hyphen slugs', () => {
  for (const bad of ['-', '--', '---', '-foo', 'foo-', '-foo-', '----']) {
    const r = validateAgentName(bad, []);
    assert.equal(r.valid, false, `${JSON.stringify(bad)} should be invalid`);
    assert.equal(typeof r.error, 'string');
    assert.ok(r.error.length > 0, `${JSON.stringify(bad)} needs a message`);
    // Clear, lowercase, no trailing period per the ticket.
    assert.equal(r.error, 'name may not start or end with a hyphen');
    assert.ok(!/\.$/.test(r.error), 'error must not end with a period');
  }
});

test('F2: validateAgentName never throws on degenerate slugs', () => {
  for (const bad of ['-', '--', '---', '-foo', 'foo-']) {
    assert.doesNotThrow(() => validateAgentName(bad, []));
  }
});

test('F2: interior-hyphen and single-char names stay valid', () => {
  for (const good of ['orchestrate-docs', 'a-b-c', 'a', '7', 'orchestrate-ba']) {
    const r = validateAgentName(good, []);
    assert.equal(r.valid, true, `${good} should be valid`);
    assert.equal(r.error, null);
  }
});

test('F2: hyphen guard runs AFTER the char-class check', () => {
  // A name with both an illegal char AND a leading hyphen must report the
  // char-class error (NAME_RE runs first), not the hyphen error.
  const r = validateAgentName('-Bad!', []);
  assert.equal(r.valid, false);
  assert.match(r.error, /lowercase letters, digits and hyphens/);
});

test('F2: hyphen guard runs BEFORE reserved/duplicate checks', () => {
  // The reserved name and a duplicate are both well-formed slugs, so they are
  // unaffected; but a degenerate slug that also happens to be "in use" must
  // still fail on the hyphen rule (renderer ordering), never reach dup logic.
  const r = validateAgentName('-foo', ['-foo']);
  assert.equal(r.valid, false);
  assert.equal(r.error, 'name may not start or end with a hyphen');
});

test('F2: pre-existing rejections still hold', () => {
  // non-string
  assert.equal(validateAgentName(null, []).valid, false);
  assert.equal(validateAgentName(42, []).valid, false);
  // empty
  assert.equal(validateAgentName('', []).valid, false);
  // illegal chars
  assert.equal(validateAgentName('Bad Name!', []).valid, false);
  assert.equal(validateAgentName('UPPER', []).valid, false);
  assert.equal(validateAgentName('under_score', []).valid, false);
  // reserved
  assert.equal(validateAgentName(FALLBACK_AGENT, []).valid, false);
  // duplicate from array and from Set
  assert.equal(validateAgentName('orchestrate-ba', ['orchestrate-ba']).valid, false);
  assert.equal(validateAgentName('orchestrate-ba', new Set(['orchestrate-ba'])).valid, false);
});

test('F2: validateAgentName always returns a {valid,error} shape', () => {
  for (const input of ['-', 'orchestrate-docs', '', null, 42, 'Bad!']) {
    const r = validateAgentName(input, []);
    assert.ok(r && typeof r === 'object');
    assert.equal(typeof r.valid, 'boolean');
    assert.ok('error' in r);
    if (r.valid) assert.equal(r.error, null);
    else assert.equal(typeof r.error, 'string');
  }
});

// ---------------------------------------------------------------------------
// F3 — meaningful Symbol assertion
// ---------------------------------------------------------------------------

test('F3: parsed fm has exactly one own Symbol, non-enumerable, not spread', () => {
  const { fm } = parseAgentFile(SIMPLE);
  const syms = Object.getOwnPropertySymbols(fm);
  assert.equal(syms.length, 1, 'exactly one own Symbol (the RAW carrier)');
  const desc = Object.getOwnPropertyDescriptor(fm, syms[0]);
  assert.equal(desc.enumerable, false, 'RAW Symbol must be non-enumerable');
  // A spread copy carries zero own symbols (the carrier does not leak).
  assert.equal(Object.getOwnPropertySymbols({ ...fm }).length, 0);
  // And Object.keys still shows only the real frontmatter keys.
  assert.deepEqual(Object.keys(fm), ['name', 'description', 'tools', 'model']);
});

// ---------------------------------------------------------------------------
// F4 — single-field-edit byte-level sibling checks
// ---------------------------------------------------------------------------

test('F4: editing ONLY description keeps sibling name/tools/model RAW lines byte-equal', () => {
  const { fm, body } = parseAgentFile(SIMPLE);
  const original = serializeAgentFile(fm, body);
  fm.description = 'A brand new single-line description for the demo agent.';
  const out = serializeAgentFile(fm, body);
  assert.ok(typeof out === 'string');

  // The sibling RAW lines must appear byte-for-byte in the output.
  assert.ok(out.includes('\nname: orchestrate-demo\n'), 'name line verbatim');
  assert.ok(out.includes('\ntools: Read, Grep\n'), 'tools line verbatim');
  assert.ok(out.includes('\nmodel: claude-opus\n'), 'model line verbatim');

  // Body byte-identical: both files end with the same closing fence + body.
  assert.ok(original.endsWith('\n---\n\nYou are the demo agent.\n'));
  assert.ok(out.endsWith('\n---\n\nYou are the demo agent.\n'), 'body byte-identical');

  // Re-parses with the new description.
  const rp = parseAgentFile(out);
  assert.equal(rp.fm.description, 'A brand new single-line description for the demo agent.');
  assert.equal(rp.fm.name, 'orchestrate-demo');
  assert.equal(rp.fm.tools, 'Read, Grep');
  assert.equal(rp.fm.model, 'claude-opus');
});

test('F4: editing ONLY model replaces one line; folded description block emitted verbatim', () => {
  const original = MULTI;
  const { fm, body } = parseAgentFile(original);
  fm.model = 'claude-fable-5';
  const out = serializeAgentFile(fm, body);
  assert.ok(typeof out === 'string');

  // Expected output is the original with ONLY the model line replaced.
  const expected = original.replace('model: claude-opus', 'model: claude-fable-5');
  assert.equal(out, expected, 'only the model line changes; everything else byte-equal');

  // The multi-line folded description RAW block is emitted verbatim.
  assert.ok(out.includes('description: >-\n'
    + '  First paragraph of the multi block that has enough words to read like a\n'
    + '  realistic bundled agent definition file here.\n'
    + '\n'
    + '  Second paragraph after a blank line separating the two.\n'),
  'folded description block verbatim');

  const rp = parseAgentFile(out);
  assert.equal(rp.fm.model, 'claude-fable-5');
  assert.match(rp.fm.description, /First paragraph of the multi block/);
});

// ---------------------------------------------------------------------------
// F5 — fresh-fold paragraph-break round-trip
// ---------------------------------------------------------------------------

test('F5: fresh-fold of a two-paragraph description round-trips the break (single \\n)', () => {
  const { fm, body } = parseAgentFile(SIMPLE);
  const value = 'Alpha paragraph one.\nBeta paragraph two.';
  fm.description = value;
  const out = serializeAgentFile(fm, body);
  const rp = parseAgentFile(out);
  assert.equal(rp.fm.description, value, 'paragraph break preserved, not collapsed');
});

test('F5: fresh-fold of a double-\\n two-paragraph description round-trips', () => {
  const { fm, body } = parseAgentFile(SIMPLE);
  const value = 'Alpha paragraph one.\n\nBeta paragraph two.';
  fm.description = value;
  const out = serializeAgentFile(fm, body);
  const rp = parseAgentFile(out);
  assert.equal(rp.fm.description, value);
});
