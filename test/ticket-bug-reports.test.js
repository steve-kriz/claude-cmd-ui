'use strict';

// Unit tests for lib/ticket-bug-reports.js (TASK-020) — the Electron-free helper
// that folds a user-described bug into a ticket's `## Bug Reports` section when a
// `done` card is dragged back to `todo`. The module is a pure function of a
// markdown string (plus an entry object) and touches no disk/network/Electron, so
// it is exercised directly with plain `node --test`. No files are written and no
// DB/network calls are made by these tests.
//
// Mirrors the style/contract of test/ticket-history.test.js — the sibling helper
// this one was patterned on (both insert a new section BEFORE the user-owned
// `## Additional Context`, preserving every other section verbatim).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  appendBugReport,
  formatBugReportEntry,
  neutralizeBugText,
  BUG_REPORTS_HEADING,
  ADDITIONAL_CONTEXT_HEADING,
} = require('../lib/ticket-bug-reports');

// A representative done-ticket body with several system sections plus a
// user-owned `## Additional Context` at the tail. Used to prove verbatim
// preservation of everything the helper is not supposed to touch.
const SAMPLE = [
  '',
  '## Description',
  'Ship the reporting feature. Keep it discrete.',
  '',
  '## Acceptance Criteria',
  '- [x] one',
  '- [x] two',
  '',
  '## Additional Context',
  '(User-owned. Read it before building. Never overwrite it.)',
  'A user note with **markdown** and a trailing space.   ',
].join('\n');

// A body WITHOUT an Additional Context section (Bug Reports must land at the end).
const SAMPLE_NO_AC = [
  '',
  '## Description',
  'Ship the reporting feature.',
  '',
  '## Acceptance Criteria',
  '- [x] one',
].join('\n');

// Pull the body of a named `## ` section out of a markdown string (everything
// from the heading up to but excluding the next `## ` heading or EOF). Lets us
// assert a section is byte-for-byte unchanged.
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

// Index of a `## ` heading line, or -1.
function headingIndex(md, heading) {
  return md.split('\n').findIndex((l) => l.trim() === heading);
}

// ---------------------------------------------------------------------------
// Constants / exported surface
// ---------------------------------------------------------------------------

test('exports the documented surface', () => {
  assert.equal(typeof appendBugReport, 'function');
  assert.equal(typeof formatBugReportEntry, 'function');
  assert.equal(BUG_REPORTS_HEADING, '## Bug Reports');
  assert.equal(ADDITIONAL_CONTEXT_HEADING, '## Additional Context');
});

// ---------------------------------------------------------------------------
// formatBugReportEntry — a single `### <ts>` heading + blank + trimmed text
// ---------------------------------------------------------------------------

test('formatBugReportEntry renders a `### <timestamp>` heading, blank line, then trimmed bug text', () => {
  const lines = formatBugReportEntry({ bug: '  it crashes on save  ', timestamp: '2026-07-18T10:00:00.000Z' });
  assert.deepEqual(lines, [
    '### 2026-07-18T10:00:00.000Z',
    '',
    'it crashes on save',
  ]);
});

test('formatBugReportEntry defaults timestamp to a valid ISO-8601 stamp when omitted', () => {
  const lines = formatBugReportEntry({ bug: 'x' });
  assert.match(lines[0], /^### \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(lines[1], '');
  assert.equal(lines[2], 'x');
});

test('formatBugReportEntry: null/undefined/omitted bug becomes an empty text line (no throw)', () => {
  assert.equal(formatBugReportEntry({ bug: null, timestamp: 't' })[2], '');
  assert.equal(formatBugReportEntry({ timestamp: 't' })[2], '');
  assert.equal(formatBugReportEntry()[2], '', 'no-arg call does not throw');
});

// ---------------------------------------------------------------------------
// appendBugReport — creates the section with heading + timestamp + trimmed text
// ---------------------------------------------------------------------------

test('appends a bug entry under a `## Bug Reports` heading with the given timestamp and trimmed text', () => {
  const out = appendBugReport(SAMPLE, { bug: '   Save button throws   ', timestamp: '2026-07-18T10:00:00.000Z' });
  assert.ok(headingIndex(out, BUG_REPORTS_HEADING) !== -1, 'Bug Reports heading created');
  const sec = sectionSlice(out, BUG_REPORTS_HEADING);
  assert.match(sec, /### 2026-07-18T10:00:00\.000Z/, 'timestamped entry heading present');
  assert.match(sec, /Save button throws/, 'bug text present');
  assert.ok(!/   Save button throws   /.test(sec), 'bug text is trimmed, not verbatim with padding');
  // Exactly one `## Bug Reports` heading.
  assert.equal((out.match(/^## Bug Reports$/gm) || []).length, 1);
});

// ---------------------------------------------------------------------------
// Placement — BEFORE `## Additional Context`, which stays verbatim at the tail
// ---------------------------------------------------------------------------

test('creates the section BEFORE `## Additional Context`, leaving Additional Context verbatim at the tail', () => {
  const acBefore = sectionSlice(SAMPLE, ADDITIONAL_CONTEXT_HEADING);
  const out = appendBugReport(SAMPLE, { bug: 'boom', timestamp: '2026-07-18T10:00:00.000Z' });

  const brIdx = headingIndex(out, BUG_REPORTS_HEADING);
  const acIdx = headingIndex(out, ADDITIONAL_CONTEXT_HEADING);
  assert.ok(brIdx !== -1 && acIdx !== -1);
  assert.ok(brIdx < acIdx, 'Bug Reports sits before Additional Context');

  // Additional Context is the LAST section and byte-for-byte unchanged.
  const acAfter = sectionSlice(out, ADDITIONAL_CONTEXT_HEADING);
  assert.equal(acAfter, acBefore, 'Additional Context preserved verbatim');
  assert.match(out, /A user note with \*\*markdown\*\* and a trailing space\.   /);
  // It is genuinely at the tail: nothing after it starts a new `## ` section.
  const tail = out.split('\n').slice(acIdx + 1);
  assert.ok(!tail.some((l) => /^## /.test(l)), 'no section follows Additional Context');
});

// ---------------------------------------------------------------------------
// Accumulation — a SECOND entry under the SAME heading, chronological order
// ---------------------------------------------------------------------------

test('appends a SECOND entry under the SAME `## Bug Reports` heading (no duplicate heading), in chronological order', () => {
  const once = appendBugReport(SAMPLE, { bug: 'first bug', timestamp: '2026-07-18T10:00:00.000Z' });
  const twice = appendBugReport(once, { bug: 'second bug', timestamp: '2026-07-18T11:00:00.000Z' });

  // Still exactly ONE `## Bug Reports` heading.
  assert.equal((twice.match(/^## Bug Reports$/gm) || []).length, 1, 'no duplicate heading');

  const sec = sectionSlice(twice, BUG_REPORTS_HEADING);
  const firstAt = sec.indexOf('first bug');
  const secondAt = sec.indexOf('second bug');
  assert.ok(firstAt !== -1 && secondAt !== -1, 'both bugs present');
  assert.ok(firstAt < secondAt, 'chronological order: first before second');
  // Two `### <ts>` entry headings accumulated.
  assert.equal((sec.match(/^### /gm) || []).length, 2, 'two timestamped entries');

  // Additional Context still verbatim after two appends.
  assert.equal(
    sectionSlice(twice, ADDITIONAL_CONTEXT_HEADING),
    sectionSlice(SAMPLE, ADDITIONAL_CONTEXT_HEADING),
  );
});

// ---------------------------------------------------------------------------
// Preservation — every OTHER section survives byte-for-byte
// ---------------------------------------------------------------------------

test('preserves all other sections (Description, Acceptance Criteria) byte-for-byte', () => {
  const out = appendBugReport(SAMPLE, { bug: 'boom', timestamp: '2026-07-18T10:00:00.000Z' });
  assert.equal(sectionSlice(out, '## Description'), sectionSlice(SAMPLE, '## Description'));
  assert.equal(sectionSlice(out, '## Acceptance Criteria'), sectionSlice(SAMPLE, '## Acceptance Criteria'));
});

test('preserves a `## History` section verbatim when one is present', () => {
  const withHistory = [
    '',
    '## Description',
    'do it',
    '',
    '## History',
    '### 2026-07-01T00:00:00.000Z — coder',
    'built it',
    '',
    '## Additional Context',
    'user note',
  ].join('\n');
  const out = appendBugReport(withHistory, { bug: 'regressed', timestamp: '2026-07-18T10:00:00.000Z' });
  assert.equal(sectionSlice(out, '## History'), sectionSlice(withHistory, '## History'), 'History untouched');
  assert.equal(sectionSlice(out, '## Additional Context'), sectionSlice(withHistory, '## Additional Context'));
  // Bug Reports lands before Additional Context (History precedes both here).
  assert.ok(headingIndex(out, BUG_REPORTS_HEADING) < headingIndex(out, ADDITIONAL_CONTEXT_HEADING));
});

// ---------------------------------------------------------------------------
// No Additional Context — section appended at the END
// ---------------------------------------------------------------------------

test('when there is NO `## Additional Context`, the Bug Reports section is appended at the end', () => {
  const out = appendBugReport(SAMPLE_NO_AC, { bug: 'boom', timestamp: '2026-07-18T10:00:00.000Z' });
  assert.equal(headingIndex(out, ADDITIONAL_CONTEXT_HEADING), -1, 'no Additional Context existed or was created');
  const brIdx = headingIndex(out, BUG_REPORTS_HEADING);
  assert.ok(brIdx !== -1, 'Bug Reports created');
  // It is the LAST `## ` section in the document.
  const laterSections = out.split('\n').slice(brIdx + 1).filter((l) => /^## /.test(l));
  assert.deepEqual(laterSections, [], 'Bug Reports is the final section');
  // Prior sections still intact.
  assert.equal(sectionSlice(out, '## Description'), sectionSlice(SAMPLE_NO_AC, '## Description'));
  assert.equal(sectionSlice(out, '## Acceptance Criteria'), sectionSlice(SAMPLE_NO_AC, '## Acceptance Criteria'));
});

// ---------------------------------------------------------------------------
// Default timestamp path — omit timestamp, assert STRUCTURE not the exact time
// ---------------------------------------------------------------------------

test('default timestamp path: omitting timestamp still yields a valid `### <iso>` entry', () => {
  const out = appendBugReport(SAMPLE, { bug: 'no ts supplied' });
  const sec = sectionSlice(out, BUG_REPORTS_HEADING);
  assert.match(sec, /^### \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/m, 'ISO-8601 entry heading generated');
  assert.match(sec, /no ts supplied/, 'bug text present under generated heading');
});

// ---------------------------------------------------------------------------
// EDGE / FAILURE — empty / whitespace-only bug text.
//
// TASK-023: appendBugReport NOW guards empty/whitespace-only bug text at the very
// top and returns the input markdown UNCHANGED (no `## Bug Reports` section is
// created or extended). NOTE: formatBugReportEntry itself was deliberately NOT
// guarded — it still trims a whitespace-only bug down to an empty body — because
// only appendBugReport was changed. We assert BOTH facts below.
// ---------------------------------------------------------------------------

test('TASK-023 EDGE: whitespace-only bug is a no-op — appendBugReport returns input byte-for-byte, no Bug Reports section', () => {
  const out = appendBugReport(SAMPLE, { bug: '   \t  \n  ', timestamp: '2026-07-18T10:00:00.000Z' });
  // The NEW contract: input round-trips byte-for-byte and NO section is created.
  assert.equal(out, SAMPLE, 'whitespace-only bug returns the input markdown unchanged');
  assert.equal(headingIndex(out, BUG_REPORTS_HEADING), -1, 'no `## Bug Reports` section created');
  // formatBugReportEntry remains unguarded by design: it still trims to an empty body.
  const entry = formatBugReportEntry({ bug: '   \t  \n  ', timestamp: 't' });
  assert.equal(entry[2], '', 'formatBugReportEntry (unguarded) still trims whitespace-only bug to empty string');
});

// ---------------------------------------------------------------------------
// Purity / robustness
// ---------------------------------------------------------------------------

test('appendBugReport does not mutate the input markdown string', () => {
  const before = SAMPLE;
  const snapshot = String(SAMPLE);
  appendBugReport(before, { bug: 'boom', timestamp: '2026-07-18T10:00:00.000Z' });
  assert.equal(SAMPLE, snapshot, 'source string unchanged (strings are immutable, but assert intent)');
});

test('appendBugReport tolerates a non-string markdown argument (treated as empty body)', () => {
  const out = appendBugReport(undefined, { bug: 'boom', timestamp: '2026-07-18T10:00:00.000Z' });
  assert.match(out, /## Bug Reports/);
  assert.match(out, /### 2026-07-18T10:00:00\.000Z/);
  assert.match(out, /boom/);
});

// ===========================================================================
// TASK-022 — Neutralize heading-forging in bug report text
// ===========================================================================
//
// `splitSections` treats any line matching `/^## /` as a level-2 section
// boundary. User bug text that begins a line with `## ` (or any leading run of
// `#`s followed by a space) would forge a section on every later re-parse and
// corrupt the ticket. `neutralizeBugText` escapes the leading `#` run with a
// backslash so the line no longer starts a section yet still renders literally.

// The exported surface now includes the neutralizer.
test('TASK-022: exports neutralizeBugText', () => {
  assert.equal(typeof neutralizeBugText, 'function');
});

// ---------------------------------------------------------------------------
// neutralizeBugText — per-line escaping of a leading `#` run
// ---------------------------------------------------------------------------

test('TASK-022 neutralizeBugText: a `## Additional Context` line is escaped to `\\## Additional Context`', () => {
  assert.equal(neutralizeBugText('## Additional Context'), '\\## Additional Context');
});

test('TASK-022 neutralizeBugText: `## Bug Reports` and `## History` lines are likewise escaped', () => {
  assert.equal(neutralizeBugText('## Bug Reports'), '\\## Bug Reports');
  assert.equal(neutralizeBugText('## History'), '\\## History');
});

test('TASK-022 neutralizeBugText: a leading single `#` and a leading `###` are escaped', () => {
  assert.equal(neutralizeBugText('# Title'), '\\# Title');
  assert.equal(neutralizeBugText('### Heading'), '\\### Heading');
});

test('TASK-022 neutralizeBugText: leading whitespace before `##` is preserved, `#` run still escaped', () => {
  assert.equal(neutralizeBugText('  ## x'), '  \\## x');
  assert.equal(neutralizeBugText('\t### y'), '\t\\### y');
});

test('TASK-022 neutralizeBugText: `##` NOT at line start is left unchanged', () => {
  assert.equal(neutralizeBugText('see ## note'), 'see ## note');
  assert.equal(neutralizeBugText('code x ## y'), 'code x ## y');
});

test('TASK-022 neutralizeBugText: ordinary text with no leading `#` is returned unchanged', () => {
  assert.equal(neutralizeBugText('Save button throws on empty form'), 'Save button throws on empty form');
  assert.equal(neutralizeBugText('a plain sentence.'), 'a plain sentence.');
});

test('TASK-022 neutralizeBugText: a leading `#` NOT followed by whitespace is left unchanged (not a section threat)', () => {
  // `/^(\s*)(#+)(\s)/` requires whitespace after the `#` run; `#nospace` cannot
  // begin a `## ` section, so it is deliberately untouched.
  assert.equal(neutralizeBugText('#hashtag'), '#hashtag');
  assert.equal(neutralizeBugText('##nospace'), '##nospace');
});

test('TASK-022 neutralizeBugText: multi-line text escapes EACH qualifying line, others untouched', () => {
  const input = [
    'Steps to reproduce:',
    '## Additional Context',
    'plain middle line',
    '  ### note',
    'see ## inline is fine',
  ].join('\n');
  const expected = [
    'Steps to reproduce:',
    '\\## Additional Context',
    'plain middle line',
    '  \\### note',
    'see ## inline is fine',
  ].join('\n');
  assert.equal(neutralizeBugText(input), expected);
});

test('TASK-022 neutralizeBugText: empty / whitespace / null / undefined input handled without throw', () => {
  assert.equal(neutralizeBugText(''), '');
  assert.equal(neutralizeBugText('   '), '   ');
  assert.equal(neutralizeBugText(null), '');
  assert.equal(neutralizeBugText(undefined), '');
});

// ---------------------------------------------------------------------------
// appendBugReport with heading-like bug text — no forged section on re-parse
// ---------------------------------------------------------------------------

// Mirror the module's own `splitSections` boundary detector (`/^## /`) so we can
// prove a re-parse does NOT see a forged section from the bug body.
function splitLevel2(md) {
  return md.split('\n').filter((l) => /^## /.test(l)).map((l) => l.trim());
}

test('TASK-022 appendBugReport: heading-like bug text does NOT forge a `## Additional Context` section on re-parse', () => {
  const out = appendBugReport(SAMPLE, {
    bug: '## Additional Context\nplease read the note below',
    timestamp: '2026-07-18T10:00:00.000Z',
  });

  // Exactly ONE real `## Additional Context` (the original), not two.
  const acCount = (out.match(/^## Additional Context$/gm) || []).length;
  assert.equal(acCount, 1, 'only the real Additional Context heading exists');

  // Re-parsing on the real boundary detector yields only the genuine sections.
  const headings = splitLevel2(out);
  assert.deepEqual(
    headings,
    ['## Description', '## Acceptance Criteria', '## Bug Reports', '## Additional Context'],
    'no forged section from the bug body',
  );

  // The escaped `\## Additional Context` text survives inside the Bug Reports entry.
  const sec = sectionSlice(out, BUG_REPORTS_HEADING);
  assert.match(sec, /\\## Additional Context/, 'bug text preserved as escaped literal inside the entry');
  assert.match(sec, /please read the note below/);
});

test('TASK-022 appendBugReport: a `## Bug Reports` line inside the bug body does not forge a second Bug Reports heading', () => {
  const out = appendBugReport(SAMPLE, {
    bug: '## Bug Reports\nthis line tried to forge a section',
    timestamp: '2026-07-18T10:00:00.000Z',
  });
  assert.equal((out.match(/^## Bug Reports$/gm) || []).length, 1, 'exactly one real Bug Reports heading');
  const sec = sectionSlice(out, BUG_REPORTS_HEADING);
  assert.match(sec, /\\## Bug Reports/, 'the forging line is escaped, kept as literal text');
});

test('TASK-022 appendBugReport: Additional Context stays LAST and verbatim even when bug text forges a heading', () => {
  const acBefore = sectionSlice(SAMPLE, ADDITIONAL_CONTEXT_HEADING);
  const out = appendBugReport(SAMPLE, {
    bug: '## Additional Context\nnasty',
    timestamp: '2026-07-18T10:00:00.000Z',
  });
  assert.equal(sectionSlice(out, ADDITIONAL_CONTEXT_HEADING), acBefore, 'Additional Context byte-for-byte');
  const acIdx = headingIndex(out, ADDITIONAL_CONTEXT_HEADING);
  const tail = out.split('\n').slice(acIdx + 1);
  assert.ok(!tail.some((l) => /^## /.test(l)), 'nothing forged after Additional Context');
});

// ---------------------------------------------------------------------------
// REGRESSION — well-formed one-line bug text is byte-for-byte unchanged
// ---------------------------------------------------------------------------

test('TASK-022 REGRESSION: an ordinary one-line bug yields byte-for-byte the same output as before the change (no stray backslash)', () => {
  const out = appendBugReport(SAMPLE, { bug: 'Save button throws on empty form', timestamp: '2026-07-18T10:00:00.000Z' });
  const sec = sectionSlice(out, BUG_REPORTS_HEADING);
  assert.equal(sec, [
    '## Bug Reports',
    '',
    '### 2026-07-18T10:00:00.000Z',
    '',
    'Save button throws on empty form',
  ].join('\n'), 'entry is exactly the TASK-020 shape, no escaping introduced');
  assert.ok(!/\\/.test(sec), 'no backslash anywhere in an ordinary entry');
});

test('TASK-022 REGRESSION: formatBugReportEntry is unchanged for ordinary text (matches TASK-020 output)', () => {
  assert.deepEqual(
    formatBugReportEntry({ bug: '  it crashes on save  ', timestamp: '2026-07-18T10:00:00.000Z' }),
    ['### 2026-07-18T10:00:00.000Z', '', 'it crashes on save'],
  );
});

test('TASK-022 REGRESSION: accumulation under ONE heading and Additional-Context-stays-last still hold with escaped bug text', () => {
  const once = appendBugReport(SAMPLE, { bug: '## History\nforged once', timestamp: '2026-07-18T10:00:00.000Z' });
  const twice = appendBugReport(once, { bug: 'ordinary follow-up', timestamp: '2026-07-18T11:00:00.000Z' });
  assert.equal((twice.match(/^## Bug Reports$/gm) || []).length, 1, 'single Bug Reports heading');
  assert.equal((twice.match(/^## History$/gm) || []).length, 0, 'no forged History section');
  const sec = sectionSlice(twice, BUG_REPORTS_HEADING);
  assert.equal((sec.match(/^### /gm) || []).length, 2, 'two entries accumulated');
  assert.match(sec, /\\## History/, 'first entry keeps escaped literal');
  assert.match(sec, /ordinary follow-up/, 'second entry present');
  assert.equal(
    sectionSlice(twice, ADDITIONAL_CONTEXT_HEADING),
    sectionSlice(SAMPLE, ADDITIONAL_CONTEXT_HEADING),
    'Additional Context still verbatim at the tail',
  );
});

// ===========================================================================
// TASK-023 — Guard empty bug text in appendBugReport
// ===========================================================================
//
// appendBugReport now short-circuits at the very top: an empty/whitespace-only
// bug (normalized the same way formatBugReportEntry normalizes — String().trim())
// makes the call a no-op, returning the input markdown UNCHANGED with NO
// `## Bug Reports` section created or extended. This covers null / undefined /
// '' / whitespace-only bug, and a missing/empty `entry` object. The happy path
// (non-empty bug) is unaffected — asserted as a regression below.

// Every "empty" shape of the bug value must be a byte-for-byte no-op.
for (const { label, entry } of [
  { label: 'bug: undefined', entry: { bug: undefined, timestamp: '2026-07-18T10:00:00.000Z' } },
  { label: 'bug: null', entry: { bug: null, timestamp: '2026-07-18T10:00:00.000Z' } },
  { label: "bug: '' (empty string)", entry: { bug: '', timestamp: '2026-07-18T10:00:00.000Z' } },
  { label: "bug: '   \\t\\n  ' (whitespace-only)", entry: { bug: '   \t\n  ', timestamp: '2026-07-18T10:00:00.000Z' } },
  { label: 'entry: {} (empty object)', entry: {} },
  { label: 'entry: undefined (no entry arg)', entry: undefined },
]) {
  test(`TASK-023: appendBugReport is a no-op for ${label} — returns input === and creates no section`, () => {
    const out = appendBugReport(SAMPLE, entry);
    // STRICT byte-for-byte equality: the SAME string content is returned.
    assert.equal(out, SAMPLE, 'returned markdown is byte-for-byte identical to the input');
    assert.equal(headingIndex(out, BUG_REPORTS_HEADING), -1, 'no `## Bug Reports` section created');
    assert.ok(!/## Bug Reports/.test(out), 'no Bug Reports heading anywhere in the output');
  });
}

test('TASK-023: no-op guard also holds for a body that has NO Additional Context (nothing appended at end)', () => {
  const out = appendBugReport(SAMPLE_NO_AC, { bug: '   \n\t ', timestamp: '2026-07-18T10:00:00.000Z' });
  assert.equal(out, SAMPLE_NO_AC, 'input returned unchanged even without an Additional Context anchor');
  assert.equal(headingIndex(out, BUG_REPORTS_HEADING), -1, 'no Bug Reports section appended at the end');
});

test('TASK-023 REGRESSION: a NON-empty bug still appends before `## Additional Context` under a single heading', () => {
  const out = appendBugReport(SAMPLE, { bug: 'real bug: crashes on save', timestamp: '2026-07-18T10:00:00.000Z' });
  const brIdx = headingIndex(out, BUG_REPORTS_HEADING);
  const acIdx = headingIndex(out, ADDITIONAL_CONTEXT_HEADING);
  assert.ok(brIdx !== -1, 'Bug Reports section IS created for non-empty text');
  assert.ok(brIdx < acIdx, 'Bug Reports sits before Additional Context');
  assert.equal((out.match(/^## Bug Reports$/gm) || []).length, 1, 'exactly one Bug Reports heading');
  const sec = sectionSlice(out, BUG_REPORTS_HEADING);
  assert.match(sec, /### 2026-07-18T10:00:00\.000Z/);
  assert.match(sec, /real bug: crashes on save/);
});

test('TASK-023 REGRESSION: non-empty bugs still accumulate under ONE heading (guard did not break happy path)', () => {
  const once = appendBugReport(SAMPLE, { bug: 'first', timestamp: '2026-07-18T10:00:00.000Z' });
  const twice = appendBugReport(once, { bug: 'second', timestamp: '2026-07-18T11:00:00.000Z' });
  assert.equal((twice.match(/^## Bug Reports$/gm) || []).length, 1, 'single heading after two appends');
  const sec = sectionSlice(twice, BUG_REPORTS_HEADING);
  assert.equal((sec.match(/^### /gm) || []).length, 2, 'two entries accumulated');
  assert.ok(sec.indexOf('first') < sec.indexOf('second'), 'chronological order preserved');
});

test('TASK-023 REGRESSION: TASK-022 neutralization still applies on the non-empty path (a `## Foo` line is escaped)', () => {
  const out = appendBugReport(SAMPLE, {
    bug: '## Foo forged heading\nreal detail',
    timestamp: '2026-07-18T10:00:00.000Z',
  });
  const sec = sectionSlice(out, BUG_REPORTS_HEADING);
  assert.match(sec, /\\## Foo forged heading/, 'heading-like bug line is still neutralized (escaped)');
  assert.match(sec, /real detail/);
  // No forged `## Foo` section boundary on re-parse.
  assert.equal((out.match(/^## Foo forged heading$/gm) || []).length, 0, 'no forged section from bug body');
});

// ===========================================================================
// TASK-026 — Return-type consistency for non-string markdown on the no-op path
// ===========================================================================
//
// TASK-023 short-circuits empty/whitespace-only bug text at the top of
// appendBugReport. Previously that early return was `return markdown;`, which
// leaked a NON-STRING argument (undefined, a number, an object) straight back to
// the caller — while the non-empty path always normalizes markdown to a string
// (`typeof markdown === 'string' ? markdown : ''`). TASK-026 makes the no-op
// early return apply the SAME normalization, so BOTH paths always return a
// STRING. A string `markdown` is still returned byte-for-byte on the no-op path.

// A representative real-string markdown body used to prove byte-for-byte
// preservation of the no-op path when markdown IS a string.
const SAMPLE_STRING = SAMPLE;

test('TASK-026: no-op path with undefined markdown + empty entry returns strict `\'\'`', () => {
  const out = appendBugReport(undefined, {});
  assert.strictEqual(out, '', 'undefined markdown normalized to an empty STRING on the no-op path');
});

test('TASK-026: no-op path with undefined markdown + empty-string bug returns strict `\'\'`', () => {
  const out = appendBugReport(undefined, { bug: '' });
  assert.strictEqual(out, '');
});

test('TASK-026: no-op path with null markdown + whitespace-only bug returns strict `\'\'`', () => {
  const out = appendBugReport(null, { bug: '   \t\n' });
  assert.strictEqual(out, '');
});

test('TASK-026: no-op path with a NUMBER markdown is normalized to strict `\'\'` (not the raw number)', () => {
  const out = appendBugReport(123, { bug: '' });
  assert.strictEqual(out, '', 'number markdown collapses to an empty string, not 123');
  assert.strictEqual(typeof out, 'string', 'return type is a string');
});

test('TASK-026: no-op path with an OBJECT markdown is normalized to strict `\'\'` (not the raw object)', () => {
  const out = appendBugReport({}, { bug: '' });
  assert.strictEqual(out, '', 'object markdown collapses to an empty string, not the object');
  assert.strictEqual(typeof out, 'string', 'return type is a string');
});

test('TASK-026 REGRESSION: a STRING markdown is preserved byte-for-byte on the no-op path (whitespace-only bug)', () => {
  const out = appendBugReport(SAMPLE_STRING, { bug: '   ' });
  assert.strictEqual(out, SAMPLE_STRING, 'real string markdown round-trips byte-for-byte, unchanged');
});

test('TASK-026: non-empty path returns a STRING for a non-string markdown, with a `## Bug Reports` entry (both paths agree on return type)', () => {
  const out = appendBugReport(undefined, { bug: 'boom', timestamp: '2026-07-18T10:00:00.000Z' });
  assert.strictEqual(typeof out, 'string', 'non-empty path returns a string even for non-string markdown');
  assert.match(out, /## Bug Reports/, 'a Bug Reports section is created');
  assert.match(out, /boom/, 'the bug text is recorded');
});
