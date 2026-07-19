'use strict';

// Unit tests for TASK-040 — heading-escape the original id interpolated into the
// new bug ticket body.
//
// WHAT CHANGED: renderer/renderer.js `onCreateBug` composes the new bug ticket
// body with `'Bug against ' + neutralizeBugText(originalId)` (was the raw
// `originalId`). `neutralizeBugText` in the renderer is a byte-identical,
// hand-maintained mirror of lib/markdown-escape.js's `escapeLeadingHeadingRun`
// (both: `line.replace(/^(\s*)(#+)(\s)/, '$1\\$2$3')` per line). renderer.js
// cannot be `require`d (browser script), so these unit tests drive the
// REQUIREABLE twin `escapeLeadingHeadingRun` — the single source of truth the
// mirror is kept in step with — to prove the escape behavior the fix relies on.
//
// NO DATABASE, NO NETWORK, NO DISK — pure string transform.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { escapeLeadingHeadingRun } = require('../lib/markdown-escape');
const bugReports = require('../lib/ticket-bug-reports');

// The `/^## /` section-boundary detector the ticket body is split on downstream.
// Returns the ordered list of REAL level-2 section heading lines.
function realSections(md) {
  return md.split('\n').filter((l) => /^## /.test(l)).map((l) => l.trim());
}

// ---------------------------------------------------------------------------
// AC: a heading-like id is neutralised before composition
// ---------------------------------------------------------------------------

test('TASK-040 unit: a heading-like id "## Additional Context" is escaped', () => {
  const escaped = escapeLeadingHeadingRun('## Additional Context');
  assert.equal(escaped, '\\## Additional Context', 'leading ## run is backslash-escaped');
  // The escaped line no longer starts with `## `, so it cannot be a boundary.
  assert.ok(!/^## /.test(escaped), 'escaped id no longer begins with a `## ` run');
});

test('TASK-040 unit: composing "Bug against " + escaped id forges NO section boundary after round-trip', () => {
  const escaped = escapeLeadingHeadingRun('## Additional Context');
  const bodyLine = 'Bug against ' + escaped;
  // The `Bug against ` prefix already means the line does not start with `## `,
  // but assert on the escaped fragment directly too: even standing alone it is inert.
  assert.ok(!/^## /.test(bodyLine), 'the composed body line is not a section boundary');
  assert.ok(!/^## /.test(escaped), 'the escaped id fragment alone is not a section boundary');
  assert.match(bodyLine, /Bug against \\## Additional Context/, 'literal escaped id preserved as text');
});

test('TASK-040 unit: #/##/### prefixed ids are each escaped; only LEADING runs matter', () => {
  assert.equal(escapeLeadingHeadingRun('# One'), '\\# One');
  assert.equal(escapeLeadingHeadingRun('## Two'), '\\## Two');
  assert.equal(escapeLeadingHeadingRun('### Three'), '\\### Three');
  // A mid-line `#` is irrelevant — only a leading `#`-run followed by whitespace escapes.
  assert.equal(escapeLeadingHeadingRun('TASK-010 # note'), 'TASK-010 # note');
  // A `#`-run with no trailing whitespace does not qualify (regex requires \s).
  assert.equal(escapeLeadingHeadingRun('##nospace'), '##nospace');
});

// ---------------------------------------------------------------------------
// AC: a normal id is written unchanged (no escaping artifacts)
// ---------------------------------------------------------------------------

test('TASK-040 unit: a normal id "TASK-010" passes through byte-for-byte unchanged', () => {
  assert.equal(escapeLeadingHeadingRun('TASK-010'), 'TASK-010', 'no escaping applied to a normal id');
  const bodyLine = 'Bug against ' + escapeLeadingHeadingRun('TASK-010');
  assert.equal(bodyLine, 'Bug against TASK-010', 'no escaping artifacts (no backslash)');
  assert.ok(!/\\/.test(bodyLine), 'no backslash introduced for a normal id');
});

test('TASK-040 unit: representative normal ids round-trip unchanged', () => {
  for (const id of ['TASK-1', 'TASK-010', 'TASK-999', 'BUG-42']) {
    assert.equal(escapeLeadingHeadingRun(id), id, `${id} unchanged`);
    assert.equal('Bug against ' + escapeLeadingHeadingRun(id), 'Bug against ' + id);
  }
});

// ---------------------------------------------------------------------------
// AC: the fix reuses the shared helper — no bespoke logic that could drift.
// The renderer's `neutralizeBugText` is a mirror of the leaf; ticket-bug-reports
// re-exports the leaf as `neutralizeBugText`, so we assert equivalence against
// the single source of truth for the id-shaped inputs on this path.
// ---------------------------------------------------------------------------

test('TASK-040 unit: shared helper is the single source of truth (neutralizeBugText === leaf)', () => {
  assert.equal(typeof bugReports.neutralizeBugText, 'function');
  assert.strictEqual(
    bugReports.neutralizeBugText,
    escapeLeadingHeadingRun,
    'the shared neutralizeBugText re-export IS the leaf escapeLeadingHeadingRun',
  );
  for (const id of ['## Additional Context', '# x', '### y', 'TASK-010', '##nospace', 'TASK-010 # note']) {
    assert.equal(
      bugReports.neutralizeBugText(id),
      escapeLeadingHeadingRun(id),
      `shared helper matches the leaf for ${JSON.stringify(id)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Integration-shaped unit check: the escaped id inside a composed body cannot
// forge a NEW top-level section when the body is split on `/^## /`.
// ---------------------------------------------------------------------------

test('TASK-040 unit: heading-like id inside a composed Description block forges no extra section', () => {
  const originalId = '## Additional Context';
  const body = [
    '',
    '## Description',
    'Bug against ' + escapeLeadingHeadingRun(originalId),
    '',
    'the reported bug description',
    '',
    '## Acceptance Criteria',
    '- [ ] First testable criterion',
    '',
    '## Additional Context',
    '(User-owned. Read it before building. Never overwrite it.)',
    '',
  ].join('\n');
  assert.deepEqual(
    realSections(body),
    ['## Description', '## Acceptance Criteria', '## Additional Context'],
    'only the genuine sections exist; the id forged none',
  );
  assert.equal(
    (body.match(/^## Additional Context$/gm) || []).length,
    1,
    'exactly one real Additional Context — the id did not forge a second',
  );
});
