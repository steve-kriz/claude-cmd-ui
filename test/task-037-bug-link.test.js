'use strict';

// ===========================================================================
// TASK-037 — UNIT tests for "the original ticket records which bug ticket was
// filed against it" (bidirectional original <-> bug link).
//
// WHAT CHANGED: the renderer's onCreateBug (renderer/renderer.js STEP 1) now
// folds the bug into the ORIGINAL with the NEW bug ticket id prefixed onto the
// text, i.e. it calls
//   appendBugReportToMarkdown(origBody, { bug: 'Reported as ' + id + '\n' + bugDesc, timestamp: now })
// instead of the old { bug: bugDesc, ... }. The id-naming is purely a
// CALLER-SIDE composition of the `bug` string — the shared append helper
// (lib/ticket-bug-reports.js appendBugReport, the requireable twin of the
// renderer's appendBugReportToMarkdown) is UNCHANGED and still routes the whole
// `bug` string through neutralizeBugText (lib/markdown-escape.js
// escapeLeadingHeadingRun).
//
// These unit tests drive the REQUIREABLE twins for REAL behavioral coverage.
// NO DATABASE, NO NETWORK, NO DISK — the helpers are pure string transforms.
// Timestamps are ALWAYS passed explicitly (never Date.now) for determinism.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  appendBugReport,
  BUG_REPORTS_HEADING,
  ADDITIONAL_CONTEXT_HEADING,
} = require('../lib/ticket-bug-reports');
const { escapeLeadingHeadingRun } = require('../lib/markdown-escape');

const TS = '2026-07-19T12:00:00.000Z';

// The original ticket body the renderer would re-read + fold into. Carries a
// user-owned `## Additional Context` at the tail (must never move).
const ORIGINAL_BODY = [
  '',
  '## Description',
  'A toggle persists a user preference across reloads.',
  '',
  '## Acceptance Criteria',
  '- [x] toggle persists',
  '',
  '## Additional Context',
  '(User-owned. Read it before building. Never overwrite it.)',
  'Deploy note with **markdown**.',
].join('\n');

// Slice out a `## `-delimited section (heading line through the line before the
// next `## ` heading) using the SAME boundary detector the helper uses.
function sectionSlice(md, heading) {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}
function headingIndex(md, heading) {
  return md.split('\n').findIndex((l) => l.trim() === heading);
}
// Re-parse on the helper's real boundary detector: the ordered real `## `
// section headings (proves nothing was forged from folded text).
function realSections(md) {
  return md.split('\n').filter((l) => /^## /.test(l)).map((l) => l.trim());
}
// Compose the `bug` string exactly as onCreateBug does (caller-side).
function composeBug(newId, desc) {
  return 'Reported as ' + newId + '\n' + desc;
}

// ===========================================================================
// UNIT 1: the folded entry names the new bug ticket id AND the description,
// inserted before Additional Context, which stays byte-for-byte at the tail.
// ===========================================================================
test('UNIT: appendBugReport with a caller-composed "Reported as <id>" bug names the new id and the desc, before Additional Context', () => {
  const acBefore = sectionSlice(ORIGINAL_BODY, ADDITIONAL_CONTEXT_HEADING);

  const out = appendBugReport(ORIGINAL_BODY, {
    bug: composeBug('TASK-050', 'Reloading resets the toggle to on'),
    timestamp: TS,
  });

  // A Bug Reports section now exists...
  const sec = sectionSlice(out, BUG_REPORTS_HEADING);
  assert.ok(sec, 'a Bug Reports section exists');
  // ...naming the NEW bug ticket id...
  assert.match(sec, /Reported as TASK-050/, 'the entry names the new bug ticket id');
  // ...AND carrying the bug description text...
  assert.match(sec, /Reloading resets the toggle to on/, 'the entry carries the bug description');
  // ...under a single deterministic timestamped heading.
  assert.match(sec, /### 2026-07-19T12:00:00\.000Z/, 'deterministic timestamped entry');
  assert.equal((out.match(/^## Bug Reports$/gm) || []).length, 1, 'exactly one Bug Reports heading');

  // The section is inserted BEFORE Additional Context...
  assert.ok(
    headingIndex(out, BUG_REPORTS_HEADING) < headingIndex(out, ADDITIONAL_CONTEXT_HEADING),
    'Bug Reports precedes Additional Context',
  );
  // ...and Additional Context is unchanged and still the last section.
  assert.equal(sectionSlice(out, ADDITIONAL_CONTEXT_HEADING), acBefore, 'Additional Context byte-for-byte');
  const acIdx = headingIndex(out, ADDITIONAL_CONTEXT_HEADING);
  assert.ok(!out.split('\n').slice(acIdx + 1).some((l) => /^## /.test(l)), 'Additional Context stays last');

  // Every other real section survives verbatim.
  assert.equal(sectionSlice(out, '## Description'), sectionSlice(ORIGINAL_BODY, '## Description'));
  assert.equal(sectionSlice(out, '## Acceptance Criteria'), sectionSlice(ORIGINAL_BODY, '## Acceptance Criteria'));
});

// ===========================================================================
// UNIT 2: the composed "Reported as <id>" line renders as its own line above the
// description (exact entry shape), so the id is machine-findable in the original.
// ===========================================================================
test('UNIT: the "Reported as <id>" reference is its own line above the description (exact entry shape)', () => {
  const out = appendBugReport(ORIGINAL_BODY, {
    bug: composeBug('TASK-050', 'the toggle resets after reload'),
    timestamp: TS,
  });
  const sec = sectionSlice(out, BUG_REPORTS_HEADING);
  assert.equal(sec, [
    '## Bug Reports',
    '',
    '### 2026-07-19T12:00:00.000Z',
    '',
    'Reported as TASK-050',
    'the toggle resets after reload',
  ].join('\n'), 'byte-for-byte the id-prefixed entry shape');
});

// ===========================================================================
// UNIT 3 (edge): heading-escape preserved — a heading-like DESCRIPTION line
// cannot forge a `## ` section boundary once folded.
// ===========================================================================
test('UNIT (edge): a heading-like description line is escaped and forges no new section boundary', () => {
  const out = appendBugReport(ORIGINAL_BODY, {
    bug: composeBug('TASK-050', '## Additional Context\nthen it crashes'),
    timestamp: TS,
  });

  const sec = sectionSlice(out, BUG_REPORTS_HEADING);
  // The forging line is escaped (leading `#` run backslash-escaped), preserved as text.
  assert.match(sec, /\\## Additional Context/, 'the forging description line is escaped');
  assert.match(sec, /then it crashes/, 'the trailing text is preserved');
  assert.match(sec, /Reported as TASK-050/, 'the id reference is still present');

  // No NEW real `## Additional Context` boundary is forged — still exactly one.
  assert.equal((out.match(/^## Additional Context$/gm) || []).length, 1,
    'exactly one real Additional Context — none forged from folded text');
  // The only real sections are the genuine ones, in order, AC last.
  assert.deepEqual(realSections(out),
    ['## Description', '## Acceptance Criteria', '## Bug Reports', '## Additional Context'],
    'genuine sections only; Additional Context is last');
});

// ===========================================================================
// UNIT 4 (edge): even a heading-forging ID cannot forge a section — the id is
// escaped along with the rest of the composed string (whole `bug` string is
// routed through neutralizeBugText / escapeLeadingHeadingRun).
// ===========================================================================
test('UNIT (edge): the whole composed "Reported as <id>" string is heading-escaped so the id cannot forge a section', () => {
  // A pathological id that, if placed at line-start, would forge a section.
  // (In production the id is always prefixed by "Reported as ", but this proves
  // the escape covers the entire composed string, not just the description.)
  const composed = '## TASK-050 forged\nReported as TASK-050';
  const escaped = escapeLeadingHeadingRun(composed);
  assert.match(escaped, /^\\## TASK-050 forged$/m, 'escapeLeadingHeadingRun escapes a leading `##` id-ish line');

  const out = appendBugReport(ORIGINAL_BODY, { bug: composed, timestamp: TS });
  const sec = sectionSlice(out, BUG_REPORTS_HEADING);
  assert.match(sec, /\\## TASK-050 forged/, 'the forging id-line is escaped inside the entry');
  // No forged boundary: only the four genuine sections exist.
  assert.deepEqual(realSections(out),
    ['## Description', '## Acceptance Criteria', '## Bug Reports', '## Additional Context']);
});

// ===========================================================================
// UNIT 5: the shared helper is UNCHANGED — a plain `bug` (no id) behaves exactly
// as before. The id-naming is purely caller-side composition.
// ===========================================================================
test('UNIT: appendBugReport is unchanged for a plain bug (no id) — id-naming is caller-side only', () => {
  const out = appendBugReport(ORIGINAL_BODY, {
    bug: 'Save button throws a null reference on empty form',
    timestamp: TS,
  });
  const sec = sectionSlice(out, BUG_REPORTS_HEADING);
  // No id reference is invented by the helper.
  assert.ok(!/Reported as/.test(sec), 'the helper does not invent an id reference for a plain bug');
  // Same entry shape TASK-020 produced (no escaping for ordinary text).
  assert.equal(sec, [
    '## Bug Reports',
    '',
    '### 2026-07-19T12:00:00.000Z',
    '',
    'Save button throws a null reference on empty form',
  ].join('\n'), 'byte-for-byte the original plain-bug entry shape');
  assert.ok(!/\\/.test(sec), 'no backslash introduced for ordinary text');
});

// ===========================================================================
// UNIT 6 (regression): the empty-bug no-op guard is untouched — a composed bug
// still requires a non-empty description path via the real caller, but a bare
// empty `bug` remains a byte-for-byte no-op (helper contract unchanged).
// ===========================================================================
test('UNIT (regression): an empty bug is still a byte-for-byte no-op (helper guard unchanged)', () => {
  for (const empty of ['', '   ', '\n\t ']) {
    const out = appendBugReport(ORIGINAL_BODY, { bug: empty, timestamp: TS });
    assert.equal(out, ORIGINAL_BODY, `no-op for ${JSON.stringify(empty)}`);
    assert.equal(headingIndex(out, BUG_REPORTS_HEADING), -1, 'no Bug Reports section created');
  }
});
