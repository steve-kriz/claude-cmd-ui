'use strict';

// Cucumber-style e2e scenarios for TASK-025 — "Neutralize heading-forging in
// history entry text".
//
// FEATURE: When the orchestrator folds a coder/tester prompt+response into a
// ticket's `## History` section, an agent-supplied body may itself contain a
// line beginning `## …`. Because the history helper delimits sections on
// `/^## /`, such a line would forge a phantom level-2 section on every later
// re-parse and corrupt the ticket (the same class TASK-022 fixed for bug text).
// appendHistoryEntry/formatHistoryEntry now neutralize the agent bodies (reusing
// neutralizeBugText from lib/ticket-bug-reports.js) so the line survives as
// literal `## …` text but is no longer a boundary. The `### <ts> — <role>`
// entry heading and the `**Prompt:**` / `**Response:**` labels are NOT escaped.
//
// These scenarios are written in Given/When/Then form as plain `node --test`
// cases (NO `cucumber` npm package is installed or added). The orchestrator's
// fold-into-history flow is a pure markdown transform (lib/ticket-history.js),
// so the scenarios drive that helper directly.
//
// NO NETWORK, NO DATABASE, NO DISK. This helper touches no disk/DB; ALL database
// calls are mocked out by construction — there simply are none. Ticket
// persistence is not invoked; the scenarios exercise the pure transform only.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  appendHistoryEntry,
  HISTORY_HEADING,
  ADDITIONAL_CONTEXT_HEADING,
} = require('../lib/ticket-history');
const { appendBugReport, BUG_REPORTS_HEADING } = require('../lib/ticket-bug-reports');

// A ticket body ending in a user-owned `## Additional Context` at the tail.
const TICKET_BODY = [
  '---',
  'id: TASK-025',
  'title: History neutralization',
  'status: in-progress',
  '---',
  '',
  '## Description',
  'Fold each agent prompt+response into a durable History section.',
  '',
  '## Acceptance Criteria',
  '- [ ] agent bodies cannot forge `## ` sections',
  '- [ ] the entry heading and labels are not escaped',
  '',
  '## Additional Context',
  '(User-owned. Never overwrite. Preserve exactly.)',
  'Notes with **markdown** and a trailing space.   ',
].join('\n');

// Pull a named `## ` section (heading up to the next `## ` or EOF) so we can
// assert it is byte-for-byte unchanged.
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

// Ordered list of REAL level-2 headings, using the SAME detector the helper uses.
function realSections(md) {
  return md.split('\n').filter((l) => /^## /.test(l)).map((l) => l.trim());
}

// Index of a `## ` heading line, or -1.
function headingIndex(md, heading) {
  return md.split('\n').findIndex((l) => l.trim() === heading);
}

// ===========================================================================
// SCENARIO 1: an agent response containing a heading does NOT forge a section
// ===========================================================================
test('SCENARIO (TASK-025): a response containing `## Summary` does not forge a section; Additional Context stays last, verbatim', () => {
  // GIVEN a ticket body ending in `## Additional Context`
  const acBefore = sectionSlice(TICKET_BODY, ADDITIONAL_CONTEXT_HEADING);

  // WHEN appendHistoryEntry folds a response containing a `## Summary` line
  const out = appendHistoryEntry(TICKET_BODY, {
    role: 'coder',
    prompt: 'implement the feature',
    response: 'Work log:\n## Summary\nall done, tests pass',
    timestamp: '2026-07-18T10:00:00.000Z',
  });

  // THEN re-parsing on `/^## /` finds NO `## Summary` section...
  assert.equal((out.match(/^## Summary$/gm) || []).length, 0, 'no forged `## Summary` section');
  assert.ok(!realSections(out).includes('## Summary'), 'Summary is not a real boundary');
  assert.deepEqual(
    realSections(out),
    ['## Description', '## Acceptance Criteria', '## History', '## Additional Context'],
    'only genuine sections exist; Additional Context is last',
  );

  // ...AND `## Additional Context` is still last, byte-for-byte
  assert.equal(sectionSlice(out, ADDITIONAL_CONTEXT_HEADING), acBefore, 'Additional Context verbatim');
  const acIdx = headingIndex(out, ADDITIONAL_CONTEXT_HEADING);
  const tail = out.split('\n').slice(acIdx + 1);
  assert.ok(!tail.some((l) => /^## /.test(l)), 'Additional Context is genuinely last');

  // ...AND the response body survives escaped inside the History entry
  const sec = sectionSlice(out, HISTORY_HEADING);
  assert.match(sec, /\\## Summary/, 'the forging line is escaped, preserved as text');
  assert.match(sec, /all done, tests pass/);
  // ...AND the entry heading + labels the helper emits are NOT escaped
  assert.match(sec, /^### 2026-07-18T10:00:00\.000Z — coder$/m, 'entry heading emitted literally');
  assert.match(sec, /^\*\*Prompt:\*\*$/m, 'Prompt label unescaped');
  assert.match(sec, /^\*\*Response:\*\*$/m, 'Response label unescaped');
});

// ===========================================================================
// SCENARIO 2: a later append still targets the REAL Additional Context
// ===========================================================================
test('SCENARIO (TASK-025): a later append lands before the REAL Additional Context; the earlier entry is not spliced', () => {
  // GIVEN a ticket carrying a history entry whose response contained a `## History` line (now neutralized)
  const first = appendHistoryEntry(TICKET_BODY, {
    role: 'coder',
    prompt: 'first pass',
    response: 'notes\n## History\nthis tried to forge History',
    timestamp: '2026-07-18T10:00:00.000Z',
  });
  // The forging attempt created NO extra History heading (only the real one).
  assert.equal((first.match(/^## History$/gm) || []).length, 1, 'exactly one real History section after the first fold');

  // WHEN another appendHistoryEntry AND an appendBugReport run
  const second = appendHistoryEntry(first, {
    role: 'tester',
    prompt: 'second pass',
    response: 'all green',
    timestamp: '2026-07-18T11:00:00.000Z',
  });
  const withBug = appendBugReport(second, {
    bug: 'found a regression on empty input',
    timestamp: '2026-07-18T12:00:00.000Z',
  });

  // THEN the new content lands BEFORE the real `## Additional Context`
  const acIdx = headingIndex(withBug, ADDITIONAL_CONTEXT_HEADING);
  const histIdx = headingIndex(withBug, HISTORY_HEADING);
  const brIdx = headingIndex(withBug, BUG_REPORTS_HEADING);
  assert.ok(histIdx !== -1 && brIdx !== -1 && acIdx !== -1, 'all three sections present');
  assert.ok(histIdx < acIdx, 'History (the real one) is before Additional Context');
  assert.ok(brIdx < acIdx, 'Bug Reports is before Additional Context');

  // ...AND there is still exactly one real History and one real Additional Context
  assert.equal((withBug.match(/^## History$/gm) || []).length, 1, 'the sole History section is the real one');
  assert.equal((withBug.match(/^## Additional Context$/gm) || []).length, 1, 'exactly one real Additional Context');

  // ...AND nothing was spliced into the earlier entry: the escaped literal remains intact
  const hist = sectionSlice(withBug, HISTORY_HEADING);
  assert.match(hist, /\\## History/, 'earlier neutralized response text is untouched');
  assert.match(hist, /this tried to forge History/);
  // ...AND both real entries are present, in order, under the single History heading
  const firstAt = hist.indexOf('### 2026-07-18T10:00:00.000Z — coder');
  const secondAt = hist.indexOf('### 2026-07-18T11:00:00.000Z — tester');
  assert.ok(firstAt !== -1 && secondAt !== -1, 'both real entries present');
  assert.ok(firstAt < secondAt, 'chronological order preserved');

  // ...AND Additional Context is still the last section, verbatim
  assert.equal(
    sectionSlice(withBug, ADDITIONAL_CONTEXT_HEADING),
    sectionSlice(TICKET_BODY, ADDITIONAL_CONTEXT_HEADING),
  );
  const tail = withBug.split('\n').slice(acIdx + 1);
  assert.ok(!tail.some((l) => /^## /.test(l)), 'Additional Context is genuinely last');
});

// ===========================================================================
// SCENARIO 3 (regression): ordinary history text is unaffected
// ===========================================================================
test('SCENARIO (TASK-025 regression): a plain prompt/response entry appears under `## History` with no escaping', () => {
  // GIVEN a ticket
  const acBefore = sectionSlice(TICKET_BODY, ADDITIONAL_CONTEXT_HEADING);

  // WHEN a plain prompt/response entry is appended
  const out = appendHistoryEntry(TICKET_BODY, {
    role: 'coder',
    prompt: 'Add the widget and a test.',
    response: 'Done: widget.js + widget.test.js, all green.',
    timestamp: '2026-07-18T09:00:00.000Z',
  });

  // THEN it appears under `## History` exactly as before, with NO escaping
  const hist = sectionSlice(out, HISTORY_HEADING);
  assert.equal(hist, [
    '## History',
    '',
    '### 2026-07-18T09:00:00.000Z — coder',
    '',
    '**Prompt:**',
    '',
    'Add the widget and a test.',
    '',
    '**Response:**',
    '',
    'Done: widget.js + widget.test.js, all green.',
  ].join('\n'), 'byte-for-byte the pre-neutralizer entry shape');
  assert.ok(!/\\/.test(hist), 'no backslash introduced for ordinary text');

  // ...AND Additional Context is preserved verbatim at the tail
  assert.equal(sectionSlice(out, ADDITIONAL_CONTEXT_HEADING), acBefore, 'Additional Context byte-for-byte');
  assert.ok(
    headingIndex(out, HISTORY_HEADING) < headingIndex(out, ADDITIONAL_CONTEXT_HEADING),
    'History sits before Additional Context',
  );
});
