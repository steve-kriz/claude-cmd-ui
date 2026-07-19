'use strict';

// Unit tests for lib/markdown-escape.js — the neutrally-named leaf module that
// hosts the canonical per-line markdown heading-escape transform extracted in
// TASK-027 from lib/ticket-bug-reports.js's `neutralizeBugText`. The module is a
// pure LEAF (requires nothing, no disk/network/Electron/DB), so it is exercised
// directly with plain `node --test`, mirroring the style of
// test/ticket-progress.test.js.
//
// NO DATABASE, NO NETWORK, NO DISK — this is a pure string transform.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { escapeLeadingHeadingRun } = require('../lib/markdown-escape');
const bugReports = require('../lib/ticket-bug-reports');

// ---------------------------------------------------------------------------
// escapeLeadingHeadingRun — leading heading runs are escaped
// ---------------------------------------------------------------------------

test('escapeLeadingHeadingRun: escapes a single leading heading run of each level', () => {
  assert.equal(escapeLeadingHeadingRun('## Foo'), '\\## Foo');
  assert.equal(escapeLeadingHeadingRun('# Foo'), '\\# Foo');
  assert.equal(escapeLeadingHeadingRun('### Foo'), '\\### Foo');
});

test('escapeLeadingHeadingRun: preserves leading whitespace before the hashes', () => {
  assert.equal(escapeLeadingHeadingRun('  ## x'), '  \\## x');
  assert.equal(escapeLeadingHeadingRun('\t# y'), '\t\\# y');
});

// ---------------------------------------------------------------------------
// escapeLeadingHeadingRun — non-qualifying lines are untouched
// ---------------------------------------------------------------------------

test('escapeLeadingHeadingRun: a ## NOT at line start is unchanged', () => {
  assert.equal(escapeLeadingHeadingRun('see ## note'), 'see ## note');
});

test('escapeLeadingHeadingRun: a #-run with NO trailing whitespace is unchanged (regex requires \\s)', () => {
  assert.equal(escapeLeadingHeadingRun('#nospace'), '#nospace');
  assert.equal(escapeLeadingHeadingRun('##also'), '##also');
  assert.equal(escapeLeadingHeadingRun('###tag'), '###tag');
});

test('escapeLeadingHeadingRun: ordinary prose with no leading hashes is byte-for-byte identical', () => {
  const prose = 'Just a normal sentence with a # in the middle.';
  assert.equal(escapeLeadingHeadingRun(prose), prose);
});

// ---------------------------------------------------------------------------
// escapeLeadingHeadingRun — multi-line handling
// ---------------------------------------------------------------------------

test('escapeLeadingHeadingRun: only qualifying lines are escaped; others intact; count/order preserved', () => {
  const input = [
    '## Summary',
    'ordinary line',
    'see ## inline note',
    '  ### Indented Heading',
    '#nospace',
    'last line',
  ].join('\n');
  const expected = [
    '\\## Summary',
    'ordinary line',
    'see ## inline note',
    '  \\### Indented Heading',
    '#nospace',
    'last line',
  ].join('\n');
  const out = escapeLeadingHeadingRun(input);
  assert.equal(out, expected);
  // line count and order preserved
  assert.equal(out.split('\n').length, input.split('\n').length);
});

test('escapeLeadingHeadingRun: empty string stays empty; a lone newline is preserved', () => {
  assert.equal(escapeLeadingHeadingRun(''), '');
  assert.equal(escapeLeadingHeadingRun('\n'), '\n');
});

// ---------------------------------------------------------------------------
// escapeLeadingHeadingRun — nullish / non-string coercion
// ---------------------------------------------------------------------------

test('escapeLeadingHeadingRun: null and undefined collapse to the empty string', () => {
  assert.equal(escapeLeadingHeadingRun(null), '');
  assert.equal(escapeLeadingHeadingRun(undefined), '');
});

test('escapeLeadingHeadingRun: non-string values are coerced via String(...)', () => {
  assert.equal(escapeLeadingHeadingRun(123), '123');
  assert.equal(escapeLeadingHeadingRun(0), '0');
  // Object stringifies to "[object Object]" — no leading hash, so unchanged.
  assert.equal(escapeLeadingHeadingRun({}), String({}));
  // An array stringifies by joining with commas: String(['# a','b']) === '# a,b',
  // which DOES start with a leading `# ` run, so it is coerced THEN escaped.
  assert.equal(escapeLeadingHeadingRun(['# a', 'b']), '\\# a,b');
});

// ---------------------------------------------------------------------------
// escapeLeadingHeadingRun — idempotency / stability under double application
// ---------------------------------------------------------------------------

test('escapeLeadingHeadingRun: applying twice is stable — an already-escaped line starts with \\, not #', () => {
  const once = escapeLeadingHeadingRun('## x');
  assert.equal(once, '\\## x');
  // Second pass: the line now starts with `\`, so the regex (`^(\s*)(#+)(\s)`)
  // does not match and nothing is re-escaped.
  assert.equal(escapeLeadingHeadingRun(once), once);
  assert.equal(escapeLeadingHeadingRun(escapeLeadingHeadingRun('## x')), escapeLeadingHeadingRun('## x'));
});

test('escapeLeadingHeadingRun: double application is stable across a multi-line body', () => {
  const input = ['## a', 'plain', '  # b', 'see ## c'].join('\n');
  const once = escapeLeadingHeadingRun(input);
  assert.equal(escapeLeadingHeadingRun(once), once, 'second pass is a no-op on already-escaped body');
});

// ---------------------------------------------------------------------------
// Re-export contract — lib/ticket-bug-reports.js `neutralizeBugText`
// ---------------------------------------------------------------------------

test('re-export: ticket-bug-reports.neutralizeBugText is a function and equals the leaf export', () => {
  assert.equal(typeof bugReports.neutralizeBugText, 'function');
  // TASK-027 wires `const neutralizeBugText = escapeLeadingHeadingRun;` so the
  // re-export is literally the same function reference as the leaf's export.
  assert.strictEqual(bugReports.neutralizeBugText, escapeLeadingHeadingRun);
});

test('re-export: neutralizeBugText produces IDENTICAL output to the leaf for representative inputs', () => {
  const cases = [
    '## Foo',
    '# Foo',
    '### Foo',
    '  ## indented',
    'see ## note',
    '#nospace',
    'plain prose with no heading',
    ['## Summary', 'body line', 'see ## inline', '  ### deep'].join('\n'),
    '',
    null,
    undefined,
    123,
  ];
  for (const input of cases) {
    assert.equal(
      bugReports.neutralizeBugText(input),
      escapeLeadingHeadingRun(input),
      `re-export delegates to the shared impl for ${JSON.stringify(input)}`,
    );
  }
});
