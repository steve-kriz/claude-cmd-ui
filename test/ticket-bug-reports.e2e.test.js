'use strict';

// Cucumber-style e2e scenarios for TASK-020 — "reporting bug".
//
// FEATURE: On the Tasks kanban board, dragging a `done` ticket card onto the
// `todo` lane opens a bug-capture modal (textarea). On submit with non-empty
// text, the bug is appended durably into the ticket markdown (preserving all
// sections, especially the user-owned `## Additional Context`), then the ticket
// moves to `todo`. Cancel aborts (no write, stays done). Empty/whitespace-only
// input is rejected (no write, no move).
//
// These scenarios are written in Given/When/Then form as `node --test` cases (NO
// `cucumber` npm package is installed or added). The renderer's DOM/modal wiring
// (openBugReportModal / bindTaskLaneDrop in renderer/renderer.js) is a browser
// script and cannot be `require`d, so the scenarios model the real user flow
// against the pure helper the renderer delegates to (lib/ticket-bug-reports.js)
// plus a faithful copy of the renderer's submit GUARD (trim -> if empty, abort).
//
// NO NETWORK, NO DATABASE. This helper touches no disk/DB; the board persistence
// is not invoked here — the scenarios drive the pure markdown transform only, so
// by construction no DB connection is ever opened. The "would move to todo" side
// of the flow is modeled as a plain in-memory status transition.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  appendBugReport,
  BUG_REPORTS_HEADING,
  ADDITIONAL_CONTEXT_HEADING,
} = require('../lib/ticket-bug-reports');
const { appendHistoryEntry } = require('../lib/ticket-history');

// ---------------------------------------------------------------------------
// Faithful model of the renderer's done->todo drop + modal-submit flow.
//
// Mirrors the guard the renderer applies in its bug-report modal submit handler:
//   const bug = String(textarea.value).trim();
//   if (!bug) return;            // empty/whitespace -> abort: no write, no move
//   md = appendBugReportToMarkdown(md, bug);  // durable append
//   ticket.status = 'todo';      // then move the card back
//
// Cancel is modeled by never invoking submit. We return enough to assert on:
//   { wrote, moved, markdown, status }
// ---------------------------------------------------------------------------
function simulateDropDoneToTodo(ticket, action) {
  // action: { type: 'submit', text } | { type: 'cancel' }
  const start = { markdown: ticket.markdown, status: ticket.status };

  if (!action || action.type === 'cancel') {
    // Given the modal is dismissed: nothing is written and the card stays put.
    return { wrote: false, moved: false, markdown: start.markdown, status: start.status };
  }

  // Renderer's submit guard: trim, and reject empty/whitespace-only input.
  const bug = String(action.text == null ? '' : action.text).trim();
  if (!bug) {
    return { wrote: false, moved: false, markdown: start.markdown, status: start.status };
  }

  // Non-empty: append durably, THEN move the card to todo.
  const markdown = appendBugReport(start.markdown, {
    bug,
    timestamp: action.timestamp, // optional; helper defaults to now
  });
  return { wrote: true, moved: true, markdown, status: 'todo' };
}

// A done ticket body carrying a user-owned `## Additional Context` at the tail.
const DONE_TICKET_BODY = [
  '',
  '## Description',
  'Users can report a bug by dragging a done card back to todo.',
  '',
  '## Acceptance Criteria',
  '- [x] drag done -> todo opens a capture modal',
  '- [x] non-empty submit appends a bug + moves the card',
  '',
  '## Additional Context',
  '(User-owned. Never overwrite. Preserve exactly.)',
  'Deploy notes with **markdown** and a trailing space.   ',
].join('\n');

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

// ===========================================================================
// SCENARIO 1: reporting a bug on a completed ticket
// ===========================================================================
test('SCENARIO: reporting a bug on a completed ticket appends it and preserves Additional Context', () => {
  // GIVEN a done ticket dragged from done onto the todo lane
  const ticket = { status: 'done', markdown: DONE_TICKET_BODY };
  const acBefore = sectionSlice(ticket.markdown, ADDITIONAL_CONTEXT_HEADING);

  // WHEN the user types a bug into the capture modal and submits it
  const result = simulateDropDoneToTodo(ticket, {
    type: 'submit',
    text: '  Save button throws a null reference on empty form  ',
    timestamp: '2026-07-18T10:00:00.000Z',
  });

  // THEN the bug is written durably into a `## Bug Reports` section...
  assert.equal(result.wrote, true, 'a durable write happened');
  assert.match(result.markdown, /## Bug Reports/);
  const sec = sectionSlice(result.markdown, BUG_REPORTS_HEADING);
  assert.match(sec, /### 2026-07-18T10:00:00\.000Z/, 'timestamped entry');
  assert.match(sec, /Save button throws a null reference on empty form/, 'the bug text is recorded (trimmed)');

  // ...AND the card would move back to todo
  assert.equal(result.moved, true, 'card moves back');
  assert.equal(result.status, 'todo', 'status is now todo');

  // ...AND the user-owned Additional Context is preserved verbatim, at the tail
  const acAfter = sectionSlice(result.markdown, ADDITIONAL_CONTEXT_HEADING);
  assert.equal(acAfter, acBefore, 'Additional Context byte-for-byte identical');
  assert.match(result.markdown, /Deploy notes with \*\*markdown\*\* and a trailing space\.   /);
  assert.ok(
    result.markdown.indexOf(BUG_REPORTS_HEADING) < result.markdown.indexOf(ADDITIONAL_CONTEXT_HEADING),
    'Bug Reports sits BEFORE Additional Context',
  );

  // ...AND every other section survives byte-for-byte
  assert.equal(sectionSlice(result.markdown, '## Description'), sectionSlice(DONE_TICKET_BODY, '## Description'));
  assert.equal(sectionSlice(result.markdown, '## Acceptance Criteria'), sectionSlice(DONE_TICKET_BODY, '## Acceptance Criteria'));
});

// ===========================================================================
// SCENARIO 2: a second bug report accumulates under one heading, in order
// ===========================================================================
test('SCENARIO: a second bug report accumulates under one heading in chronological order', () => {
  // GIVEN a ticket that already carries one bug report (from an earlier drop)
  const first = simulateDropDoneToTodo(
    { status: 'done', markdown: DONE_TICKET_BODY },
    { type: 'submit', text: 'first: crash on save', timestamp: '2026-07-18T10:00:00.000Z' },
  );
  // (the card went back to todo, was rebuilt, marked done again — model a fresh done ticket carrying that history)
  const carrying = { status: 'done', markdown: first.markdown };

  // WHEN another bug is captured via a second done->todo drop
  const second = simulateDropDoneToTodo(carrying, {
    type: 'submit',
    text: 'second: still crashes on very long input',
    timestamp: '2026-07-18T11:30:00.000Z',
  });

  // THEN both bug reports appear, in order, under a SINGLE `## Bug Reports` heading
  assert.equal(second.wrote, true);
  assert.equal((second.markdown.match(/^## Bug Reports$/gm) || []).length, 1, 'exactly one Bug Reports heading');
  const sec = sectionSlice(second.markdown, BUG_REPORTS_HEADING);
  const firstAt = sec.indexOf('first: crash on save');
  const secondAt = sec.indexOf('second: still crashes on very long input');
  assert.ok(firstAt !== -1 && secondAt !== -1, 'both entries present');
  assert.ok(firstAt < secondAt, 'chronological: first entry precedes the second');
  assert.equal((sec.match(/^### /gm) || []).length, 2, 'two timestamped entries accumulated');

  // ...AND Additional Context is STILL preserved verbatim after two appends
  assert.equal(
    sectionSlice(second.markdown, ADDITIONAL_CONTEXT_HEADING),
    sectionSlice(DONE_TICKET_BODY, ADDITIONAL_CONTEXT_HEADING),
  );
  assert.equal(second.status, 'todo');
});

// ===========================================================================
// SCENARIO 3 (FAILURE/EDGE): empty / whitespace-only bug text is NOT recorded
// ===========================================================================
test('SCENARIO (edge): empty or whitespace-only bug text is rejected — no write, no move', () => {
  for (const text of ['', '   ', '\t', '\n  \n', '   \t \n ']) {
    // GIVEN a done ticket dragged onto todo
    const ticket = { status: 'done', markdown: DONE_TICKET_BODY };

    // WHEN the user submits empty / whitespace-only text (renderer trims -> empty -> abort)
    const result = simulateDropDoneToTodo(ticket, { type: 'submit', text });

    // THEN nothing is appended and the card stays done
    assert.equal(result.wrote, false, `no write for input ${JSON.stringify(text)}`);
    assert.equal(result.moved, false, 'card did not move');
    assert.equal(result.status, 'done', 'ticket stays done');
    assert.equal(result.markdown, DONE_TICKET_BODY, 'markdown untouched (byte-for-byte)');
    assert.ok(!/## Bug Reports/.test(result.markdown), 'no Bug Reports section created');
  }
});

// ===========================================================================
// SCENARIO 4 (FAILURE/EDGE): cancelling the modal aborts — no write, stays done
// ===========================================================================
test('SCENARIO (edge): cancelling the bug-capture modal aborts — no write, stays done', () => {
  // GIVEN a done ticket dragged onto todo, opening the capture modal
  const ticket = { status: 'done', markdown: DONE_TICKET_BODY };

  // WHEN the user cancels/dismisses the modal instead of submitting
  const result = simulateDropDoneToTodo(ticket, { type: 'cancel' });

  // THEN no bug is written and the ticket remains done in place
  assert.equal(result.wrote, false);
  assert.equal(result.moved, false);
  assert.equal(result.status, 'done', 'ticket stays done on cancel');
  assert.equal(result.markdown, DONE_TICKET_BODY, 'markdown untouched on cancel');
  assert.ok(!/## Bug Reports/.test(result.markdown));
});

// ===========================================================================
// TASK-022 — Neutralize heading-forging in bug report text
// ===========================================================================
//
// A user's bug text may itself contain a line beginning `## …`. Because the
// helper delimits sections on `/^## /`, such a line would forge a phantom
// section on every later re-parse and corrupt the ticket. The neutralizer
// escapes the leading `#` run so the flow is safe. These scenarios drive the
// same pure-helper path the renderer delegates to (NO DB, NO network, NO disk).

// Re-parse a markdown body on the SAME boundary detector the helper uses
// (`/^## /`) to get the ordered list of real level-2 section headings.
function realSections(md) {
  return md.split('\n').filter((l) => /^## /.test(l)).map((l) => l.trim());
}

// ---------------------------------------------------------------------------
// SCENARIO 5: heading-like bug text does not forge a section
// ---------------------------------------------------------------------------
test('SCENARIO (TASK-022): heading-like bug text does NOT forge a section; escaped text survives in the entry', () => {
  // GIVEN a done ticket ending in `## Additional Context`
  const ticket = { status: 'done', markdown: DONE_TICKET_BODY };
  const acBefore = sectionSlice(ticket.markdown, ADDITIONAL_CONTEXT_HEADING);

  // WHEN the user submits bug text containing a line `## Additional Context`
  const result = simulateDropDoneToTodo(ticket, {
    type: 'submit',
    text: 'Repro steps:\n## Additional Context\nthe app then crashes',
    timestamp: '2026-07-18T12:00:00.000Z',
  });

  // THEN the write happened and the card moved
  assert.equal(result.wrote, true);
  assert.equal(result.status, 'todo');

  // THEN re-parsing finds exactly ONE real `## Additional Context` (still last, verbatim)
  assert.equal(
    (result.markdown.match(/^## Additional Context$/gm) || []).length,
    1,
    'exactly one real Additional Context section — none forged from the bug body',
  );
  assert.deepEqual(
    realSections(result.markdown),
    ['## Description', '## Acceptance Criteria', '## Bug Reports', '## Additional Context'],
    'the only sections are the genuine ones; Additional Context is last',
  );
  assert.equal(sectionSlice(result.markdown, ADDITIONAL_CONTEXT_HEADING), acBefore, 'Additional Context verbatim');

  // AND the bug text is escaped inside the Bug Reports entry (kept as a literal)
  const sec = sectionSlice(result.markdown, BUG_REPORTS_HEADING);
  assert.match(sec, /\\## Additional Context/, 'the forging line is escaped, preserved as text');
  assert.match(sec, /the app then crashes/);
});

// ---------------------------------------------------------------------------
// SCENARIO 6: a later append still targets the REAL Additional Context
// ---------------------------------------------------------------------------
test('SCENARIO (TASK-022): a later append lands before the REAL Additional Context; earlier bug text is not spliced', () => {
  // GIVEN a ticket whose earlier bug text contained a `## History` line (now neutralized)
  const first = simulateDropDoneToTodo(
    { status: 'done', markdown: DONE_TICKET_BODY },
    { type: 'submit', text: 'first bug\n## History\nthis tried to forge History', timestamp: '2026-07-18T10:00:00.000Z' },
  );
  assert.equal((first.markdown.match(/^## History$/gm) || []).length, 0, 'no forged History section from bug text');
  const carrying = { status: 'done', markdown: first.markdown };

  // WHEN another bug report AND a history entry are appended
  const second = simulateDropDoneToTodo(carrying, {
    type: 'submit',
    text: 'second bug, ordinary',
    timestamp: '2026-07-18T11:00:00.000Z',
  });
  const withHistory = appendHistoryEntry(second.markdown, {
    role: 'coder',
    prompt: 'rebuild it',
    response: 'done',
    timestamp: '2026-07-18T12:00:00.000Z',
  });

  // THEN the new content lands BEFORE the real `## Additional Context`
  const acIdx = headingIndexE2E(withHistory, ADDITIONAL_CONTEXT_HEADING);
  const brIdx = headingIndexE2E(withHistory, BUG_REPORTS_HEADING);
  const histIdx = headingIndexE2E(withHistory, '## History');
  assert.ok(brIdx !== -1 && histIdx !== -1 && acIdx !== -1, 'all three sections present');
  assert.ok(brIdx < acIdx, 'Bug Reports before Additional Context');
  assert.ok(histIdx < acIdx, 'History (the real one) before Additional Context');

  // AND there is still exactly one real Additional Context and one real Bug Reports,
  // and the History created now is the genuine one (the earlier forging attempt stayed text).
  assert.equal((withHistory.match(/^## Additional Context$/gm) || []).length, 1);
  assert.equal((withHistory.match(/^## Bug Reports$/gm) || []).length, 1);
  assert.equal((withHistory.match(/^## History$/gm) || []).length, 1, 'the sole History section is the real one');

  // AND nothing was spliced into the earlier bug text: the escaped literal remains intact.
  const sec = sectionSlice(withHistory, BUG_REPORTS_HEADING);
  assert.match(sec, /\\## History/, 'earlier neutralized bug text is untouched');
  assert.match(sec, /this tried to forge History/);
  assert.match(sec, /second bug, ordinary/);

  // AND Additional Context is still the last section, verbatim.
  assert.equal(
    sectionSlice(withHistory, ADDITIONAL_CONTEXT_HEADING),
    sectionSlice(DONE_TICKET_BODY, ADDITIONAL_CONTEXT_HEADING),
  );
  const tail = withHistory.split('\n').slice(acIdx + 1);
  assert.ok(!tail.some((l) => /^## /.test(l)), 'Additional Context is genuinely last');
});

// ---------------------------------------------------------------------------
// SCENARIO 7 (regression/edge): ordinary bug text is unaffected
// ---------------------------------------------------------------------------
test('SCENARIO (TASK-022 regression): ordinary one-line bug is recorded exactly as in TASK-020, no escaping applied', () => {
  // GIVEN a done ticket
  const ticket = { status: 'done', markdown: DONE_TICKET_BODY };

  // WHEN an ordinary one-line bug is submitted
  const result = simulateDropDoneToTodo(ticket, {
    type: 'submit',
    text: 'Save button throws a null reference on empty form',
    timestamp: '2026-07-18T10:00:00.000Z',
  });

  // THEN the entry appears under `## Bug Reports` exactly as TASK-020 behavior, with NO escaping
  const sec = sectionSlice(result.markdown, BUG_REPORTS_HEADING);
  assert.equal(sec, [
    '## Bug Reports',
    '',
    '### 2026-07-18T10:00:00.000Z',
    '',
    'Save button throws a null reference on empty form',
  ].join('\n'), 'byte-for-byte the TASK-020 entry shape');
  assert.ok(!/\\/.test(sec), 'no backslash introduced for ordinary text');
  assert.equal(result.status, 'todo');
});

// Index of a `## ` heading line, or -1 (e2e-local helper).
function headingIndexE2E(md, heading) {
  return md.split('\n').findIndex((l) => l.trim() === heading);
}

// ===========================================================================
// TASK-023 — Guard empty bug text in appendBugReport (helper-level no-op)
// ===========================================================================
//
// The renderer already refused to WRITE empty text (its submit guard trims and
// aborts). TASK-023 hardens the pure helper itself: even if appendBugReport is
// called directly with empty/whitespace-only bug text, it now returns the input
// markdown UNCHANGED (byte-for-byte) and creates NO `## Bug Reports` section.
// These scenarios drive appendBugReport directly (defense-in-depth), NOT through
// the renderer guard, so the assertion is squarely on the helper contract.
// NO DB, NO network, NO disk.

test('SCENARIO (TASK-023): whitespace-only bug is a no-op — markdown returned byte-for-byte, no Bug Reports section', () => {
  // GIVEN a done ticket markdown carrying a user-owned `## Additional Context`
  const inputMarkdown = DONE_TICKET_BODY;

  // WHEN appendBugReport is called directly with only spaces / newlines / tabs
  for (const onlyWhitespace of ['   ', '\n\n', '\t\t', '  \t \n  ', ' \r\n ']) {
    const out = appendBugReport(inputMarkdown, { bug: onlyWhitespace, timestamp: '2026-07-18T10:00:00.000Z' });

    // THEN the returned markdown is byte-for-byte identical to the input
    assert.equal(out, inputMarkdown, `byte-for-byte unchanged for ${JSON.stringify(onlyWhitespace)}`);
    // AND no `## Bug Reports` section exists
    assert.ok(!/## Bug Reports/.test(out), 'no Bug Reports section created');
    // AND the user-owned Additional Context is untouched at the tail
    assert.equal(
      sectionSlice(out, ADDITIONAL_CONTEXT_HEADING),
      sectionSlice(inputMarkdown, ADDITIONAL_CONTEXT_HEADING),
    );
  }
});

test('SCENARIO (TASK-023): empty / undefined / null bug is a no-op — markdown unchanged, no Bug Reports section', () => {
  // GIVEN the same done ticket markdown
  const inputMarkdown = DONE_TICKET_BODY;

  // WHEN appendBugReport is called with an empty / undefined / null bug (and a bare entry)
  for (const entry of [{ bug: '' }, { bug: undefined }, { bug: null }, {}, undefined]) {
    const out = appendBugReport(inputMarkdown, entry);

    // THEN nothing is appended and the markdown round-trips byte-for-byte
    assert.equal(out, inputMarkdown, `byte-for-byte unchanged for entry ${JSON.stringify(entry)}`);
    assert.equal(headingIndexE2E(out, BUG_REPORTS_HEADING), -1, 'no `## Bug Reports` section exists');
  }
});

test('SCENARIO (TASK-023 regression): a real non-empty bug still appends a `## Bug Reports` entry before Additional Context', () => {
  // GIVEN the same done ticket
  const ticket = { status: 'done', markdown: DONE_TICKET_BODY };
  const acBefore = sectionSlice(ticket.markdown, ADDITIONAL_CONTEXT_HEADING);

  // WHEN a real (non-empty) bug description is submitted
  const result = simulateDropDoneToTodo(ticket, {
    type: 'submit',
    text: 'Reproduction: clicking Save with an empty form throws.',
    timestamp: '2026-07-18T10:00:00.000Z',
  });

  // THEN a `## Bug Reports` entry is added BEFORE `## Additional Context`
  assert.equal(result.wrote, true, 'a durable write happened for non-empty text');
  const brIdx = headingIndexE2E(result.markdown, BUG_REPORTS_HEADING);
  const acIdx = headingIndexE2E(result.markdown, ADDITIONAL_CONTEXT_HEADING);
  assert.ok(brIdx !== -1, 'Bug Reports section created');
  assert.ok(brIdx < acIdx, 'Bug Reports sits before Additional Context');
  const sec = sectionSlice(result.markdown, BUG_REPORTS_HEADING);
  assert.match(sec, /### 2026-07-18T10:00:00\.000Z/);
  assert.match(sec, /clicking Save with an empty form throws/);
  // AND Additional Context stays verbatim at the tail
  assert.equal(sectionSlice(result.markdown, ADDITIONAL_CONTEXT_HEADING), acBefore, 'Additional Context byte-for-byte');
  assert.equal(result.status, 'todo');
});

// ===========================================================================
// TASK-026 — No-op path returns a STRING for non-string markdown
// ===========================================================================
//
// The no-op early return (empty/whitespace-only bug) used to leak a non-string
// markdown argument straight back to the caller, disagreeing with the non-empty
// path which always normalizes to a string. TASK-026 makes both paths return a
// STRING. These scenarios drive the pure helper directly (defense-in-depth,
// NOT through the renderer guard). NO DB, NO network, NO disk.

test('SCENARIO (TASK-026): no-op path normalizes a non-string markdown to a string', () => {
  // GIVEN appendBugReport is called with a non-string markdown and empty bug text
  const nonStringMarkdown = undefined;

  // WHEN the empty-bug guard short-circuits
  const out = appendBugReport(nonStringMarkdown, { bug: '' });

  // THEN the returned value is the empty STRING, not the raw non-string argument
  assert.strictEqual(out, '', 'returns an empty string');
  assert.strictEqual(typeof out, 'string', 'return type is a string, not undefined');
  assert.notStrictEqual(out, nonStringMarkdown, 'the raw non-string argument is NOT leaked back');
});

test('SCENARIO (TASK-026): no-op path also normalizes number/object markdown to a string', () => {
  // GIVEN various non-string markdown values with an empty/whitespace bug
  for (const [markdown, entry] of [
    [123, { bug: '' }],
    [{}, { bug: '   \t\n' }],
    [null, {}],
    [undefined, undefined],
  ]) {
    // WHEN the guard short-circuits
    const out = appendBugReport(markdown, entry);
    // THEN a string is always returned (the empty string)
    assert.strictEqual(typeof out, 'string', `string returned for markdown ${JSON.stringify(markdown)}`);
    assert.strictEqual(out, '', 'the normalized empty string');
  }
});

test('SCENARIO (TASK-026 regression): no-op path preserves a real string byte-for-byte', () => {
  // GIVEN a real markdown string and a whitespace-only bug
  const inputMarkdown = DONE_TICKET_BODY;

  // WHEN the guard short-circuits on the whitespace-only bug
  const out = appendBugReport(inputMarkdown, { bug: '   ' });

  // THEN the returned string equals the input byte-for-byte
  assert.strictEqual(out, inputMarkdown, 'real string markdown round-trips byte-for-byte');
});

test('SCENARIO (TASK-026 regression): non-empty path returns a string for non-string markdown, with a `## Bug Reports` entry', () => {
  // GIVEN appendBugReport called with non-string markdown and a NON-empty bug
  const out = appendBugReport(undefined, { bug: 'boom', timestamp: '2026-07-18T10:00:00.000Z' });

  // THEN a valid markdown string containing a `## Bug Reports` entry is returned
  assert.strictEqual(typeof out, 'string', 'a string is returned');
  assert.match(out, /## Bug Reports/, 'a Bug Reports section exists');
  assert.match(out, /### 2026-07-18T10:00:00\.000Z/, 'timestamped entry present');
  assert.match(out, /boom/, 'the bug text is recorded');
});
