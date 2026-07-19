'use strict';

// ===========================================================================
// TASK-031 — e2e "cucumber" scenarios (Given/When/Then) for "bug reporting",
// implemented as plain `node --test` cases. NO `cucumber` npm package is
// installed or added.
//
// Feature: a "Bug" button in the ticket-creation popup (#newTaskModal) switches
// the create flow into "bug mode". Confirming creates a NEW bug ticket in
// tasks/todo/ linked to an ORIGINAL ticket via a `bug-of: <ORIGINAL_ID>`
// frontmatter key, AND folds the bug text into the ORIGINAL ticket's
// `## Bug Reports` section (inserted before `## Additional Context`). Write
// order is ORIGINAL FIRST, then the bug ticket, so a failed original update
// never leaves an orphaned bug ticket.
//
// The renderer (renderer/renderer.js, index.html, styles.css) is a browser
// script that cannot be require()'d, so — matching the repo convention in
// test/task-028-post-processing.e2e.test.js — its DOM/wiring is proven by
// SOURCE-SCANNING those files as text. The create/append LOGIC is proven
// behaviorally against the requireable lib twins the renderer mirrors:
//   lib/ticket-bug-reports.js (appendBugReport), lib/markdown-escape.js
//   (escapeLeadingHeadingRun). serializeTicket/parseTicketFrontmatter are
//   copied verbatim (drift-guarded). Drift guards tie every replica back to the
//   real renderer source so a divergence in production fails a test here.
//
// NO DATABASE, NO REAL FILESYSTEM WRITE, NO NETWORK. The "board" is an in-memory
// Map; all fs.readFile/writeFile/mkdir the renderer would call are modeled with
// in-memory fakes by construction.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  appendBugReport,
  BUG_REPORTS_HEADING,
  ADDITIONAL_CONTEXT_HEADING,
} = require('../lib/ticket-bug-reports');
const { escapeLeadingHeadingRun } = require('../lib/markdown-escape');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(REPO, 'renderer', 'index.html'), 'utf8');
const cssSrc = fs.readFileSync(path.join(REPO, 'renderer', 'styles.css'), 'utf8');

// VERBATIM copies of the renderer's whole-file serializer/parser (drift-guarded).
function serializeTicket(fm, body) {
  const order = ['id', 'title', 'status', 'created', 'updated'];
  const keys = order.filter((k) => fm[k] != null);
  for (const k of Object.keys(fm)) if (!keys.includes(k)) keys.push(k);
  const fmLines = keys.map((k) => `${k}: ${fm[k]}`);
  return ['---', ...fmLines, '---', body || ''].join('\n');
}
function parseTicketFrontmatter(content) {
  if (typeof content !== 'string') return null;
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  if (lines[0].trim() !== '---') return null;
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) if (lines[i].trim() === '---') { closeIdx = i; break; }
  if (closeIdx === -1) return null;
  const fm = {};
  for (let i = 1; i < closeIdx; i++) {
    const idx = lines[i].indexOf(':');
    if (idx === -1) continue;
    const key = lines[i].slice(0, idx).trim();
    if (key) fm[key] = lines[i].slice(idx + 1).trim();
  }
  return { fm, body: lines.slice(closeIdx + 1).join('\n') };
}

// Production inline error for a STEP-2 partial-state failure (renderer.js ~6708:
// STEP 1 committed the original, but writing the NEW bug ticket failed). Mirrored
// here; a DRIFT GUARD below ties the message to the real source.
function bugStep2FailMessage(wrError) {
  return 'Bug ticket create failed (original was updated, retry writes only the bug ticket): ' + (wrError || 'unknown');
}

// ---------------------------------------------------------------------------
// In-memory model of the renderer's onCreateBug flow (renderer.js ~6584-6716).
// Mirrors the guard order + WRITE ORDER (original first, then bug ticket) and
// the fm/body composition. `disk` is a plain Map<path,content>; `readFail` /
// `writeFail` inject the unreadable/unwritable-ORIGINAL failure paths (STEP 1);
// `bugWriteFails` injects the STEP-2 bug-ticket-write failure (partial state:
// original updated, bug ticket NOT written). `session` (optional, mutable) holds
// the TASK-038 memo `bugStep1Done` so a retry after a STEP-2 failure SKIPS STEP 1
// (no double-fold). Returns enough to assert on: { ok, error, disk, origPath, bugPath }.
// ---------------------------------------------------------------------------
function simulateCreateBug({ board, title, originalId, bugDesc, newId, now, disk, readFail, writeFail, bugWriteFails, session }) {
  const store = disk || new Map();
  const memo = session || {}; // shared across calls when a session is threaded in
  const t = String(title == null ? '' : title).trim();
  const oid = String(originalId == null ? '' : originalId).trim();
  const desc = String(bugDesc == null ? '' : bugDesc).trim();

  // Guard order matches the renderer: title → original selected → desc → exists.
  if (!t) return { ok: false, error: 'Title is required.', disk: store };
  if (!oid) return { ok: false, error: 'Select the original ticket this bug is against.', disk: store };
  if (!desc) return { ok: false, error: 'Describe the bug before creating.', disk: store };
  let original = null;
  for (const tk of board.values()) if (tk && tk.fm && tk.fm.id === oid) { original = tk; break; }
  if (!original) return { ok: false, error: 'Original ticket ' + oid + ' is no longer on the board.', disk: store };

  // TASK-038 memo: on a retry that only failed at STEP 2, SKIP STEP 1 entirely.
  const step1AlreadyDone = !!memo.bugStep1Done
    && memo.bugStep1Done.originalId === oid
    && memo.bugStep1Done.id === newId;

  // ── STEP 1: update the ORIGINAL first (re-read → append → whole-file write).
  if (!step1AlreadyDone) {
    if (readFail) return { ok: false, error: 'Cannot read original ticket ' + oid + '.', disk: store };
    const readContent = store.has(original.path)
      ? store.get(original.path)
      : serializeTicket(original.fm, original.body);
    const parsed = parseTicketFrontmatter(readContent);
    if (!parsed) return { ok: false, error: 'Original ticket ' + oid + ' is not a valid ticket file.', disk: store };
    // TASK-037 bidirectional link: the ORIGINAL's folded entry names the NEW bug
    // ticket id via a `Reported as <NEW_ID>` line PLUS the description. The WHOLE
    // composed string is passed as `bug`, matching renderer onCreateBug STEP 1
    // (renderer/renderer.js ~6714: bug: 'Reported as ' + id + '\n' + bugDesc).
    const newOrigBody = appendBugReport(parsed.body, { bug: 'Reported as ' + newId + '\n' + desc, timestamp: now });
    const newOrigFm = Object.assign({}, parsed.fm, { updated: now });
    if (!newOrigFm.created) newOrigFm.created = now;
    if (writeFail) {
      // Original write fails → abort BEFORE creating the bug ticket. No orphan.
      return { ok: false, error: 'Failed to update original ticket.', disk: store, origPath: original.path };
    }
    store.set(original.path, serializeTicket(newOrigFm, newOrigBody));
    memo.bugStep1Done = { originalId: oid, id: newId }; // STEP 1 committed — memo it.
  }

  // ── STEP 2: only now create the NEW bug ticket in tasks/todo/, linked.
  const fm = { id: newId, title: t, status: 'todo', created: now, updated: now };
  fm['bug-of'] = oid;
  const body = [
    '',
    '## Description',
    'Bug against ' + oid,
    '',
    escapeLeadingHeadingRun(desc),
    '',
    '## Acceptance Criteria',
    '- [ ] First testable criterion',
    '',
    '## Additional Context',
    '(User-owned. Read it before building. Never overwrite it.)',
    '',
  ].join('\n');
  const bugPath = 'tasks/todo/' + newId + '-bug.md';
  if (bugWriteFails) {
    // STEP 2 write fails though STEP 1 already committed the original. Partial
    // state: original updated, bug ticket NOT written. KEEP the memo (retry writes
    // only the bug ticket) and surface the production inline error.
    return { ok: false, error: bugStep2FailMessage('EACCES'), disk: store, origPath: original.path, bugPath };
  }
  store.set(bugPath, serializeTicket(fm, body));
  memo.bugStep1Done = null; // cleanup() -> leaveBugMode() clears the memo on success.

  return { ok: true, error: '', disk: store, origPath: original.path, bugPath };
}

function makeBoard() {
  const board = new Map();
  board.set('tasks/todo/TASK-010-toggle.md', {
    path: 'tasks/todo/TASK-010-toggle.md',
    fm: { id: 'TASK-010', title: 'Persist toggle', status: 'todo', created: '2026-07-01T00:00:00.000Z', updated: '2026-07-01T00:00:00.000Z' },
    body: [
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
    ].join('\n'),
  });
  return board;
}

function headingIndex(md, heading) {
  return md.split('\n').findIndex((l) => l.trim() === heading);
}
function sectionSlice(md, heading) {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^## /.test(lines[i])) { end = i; break; }
  return lines.slice(start, end).join('\n');
}

// ===========================================================================
// Scenario: Bug button reveals bug mode
// ===========================================================================
test('Scenario: the Bug button reveals bug mode (required original selector + bug-labelled description)', () => {
  // Given the creation popup markup (#newTaskModal)
  const modal = htmlSrc.slice(htmlSrc.indexOf('id="newTaskModal"'), htmlSrc.indexOf('id="bugReportModal"'));
  // Then the action row has a Bug button alongside Cancel / Create
  assert.match(modal, /class="newtask-bug[^"]*"[^>]*>Bug</, 'a Bug button exists in the action row');
  assert.match(modal, /class="newtask-cancel/);
  assert.match(modal, /class="newtask-create/);
  // And a (hidden-by-default) required original-ticket selector row is present
  assert.match(modal, /class="newtask-bug-of-row hidden"/, 'the original-selector row is hidden by default');
  assert.match(modal, /<select class="newtask-bug-of">/, 'the original-ticket selector exists');
  assert.match(modal, /class="newtask-bug-of-label"[^>]*>Bug against:/, 'the selector is labelled');

  // When the Bug button is clicked, enterBugMode reveals the row, relabels the
  // textarea as the bug description, and switches the primary action label.
  const opener = rendererSrc.slice(rendererSrc.indexOf('function openNewTaskModal'), rendererSrc.indexOf('function openPlanModal'));
  assert.match(opener, /const enterBugMode = \(\) => \{[\s\S]*?bugOfRow\.classList\.remove\('hidden'\)/, 'enterBugMode reveals the selector row');
  assert.match(opener, /bodyArea\.placeholder = BUG_BODY_PLACEHOLDER/, 'the description placeholder becomes the bug description');
  assert.match(opener, /createBtn\.textContent = BUG_CREATE_LABEL/, 'the primary action relabels to create a bug ticket');
  assert.match(opener, /const BUG_BODY_PLACEHOLDER = 'Describe the bug/, 'the bug placeholder describes a bug');
  // And the toggle is wired to the Bug button.
  assert.match(opener, /const onBug = \(\) => \{[\s\S]*?if \(bugMode\) leaveBugMode\(\); else enterBugMode\(\);/, 'the Bug button toggles bug mode');
  // And the CSS gives the Bug button an active state + hides the row/button.
  assert.match(cssSrc, /\.newtask-bug\.active/);
  assert.match(cssSrc, /\.newtask-bug-of-row\.hidden \{ display: none; \}/);
});

// ===========================================================================
// Scenario: Creating a linked bug ticket
// ===========================================================================
test('Scenario: creating a linked bug ticket writes a new todo ticket with bug-of and body reference', () => {
  // Given the popup is in bug mode with a title, a chosen original, and a bug desc
  const board = makeBoard();
  const disk = new Map();
  const now = '2026-07-19T12:00:00.000Z';
  // When I confirm
  const r = simulateCreateBug({
    board, disk, now,
    title: 'Toggle ignores saved preference',
    originalId: 'TASK-010',
    bugDesc: 'Reloading resets the toggle to on',
    newId: 'TASK-050',
  });
  assert.equal(r.ok, true, r.error);
  // Then a new ticket is written into tasks/todo/ with status todo
  const bug = parseTicketFrontmatter(disk.get(r.bugPath));
  assert.match(r.bugPath, /^tasks\/todo\//, 'the bug ticket is filed under tasks/todo/');
  assert.equal(bug.fm.status, 'todo');
  // And the frontmatter contains bug-of: TASK-010
  assert.equal(bug.fm['bug-of'], 'TASK-010');
  // And the body references TASK-010
  assert.match(bug.body, /Bug against TASK-010/, 'the body names the original ticket');
  // And the frontmatter key order is id, title, status, created, updated, then bug-of
  assert.deepEqual(Object.keys(bug.fm), ['id', 'title', 'status', 'created', 'updated', 'bug-of']);
  // And the standard template sections are present (with the user-owned placeholder).
  assert.match(bug.body, /## Description/);
  assert.match(bug.body, /## Acceptance Criteria/);
  assert.match(bug.body, /## Additional Context/);
  assert.match(bug.body, /\(User-owned\./);
});

// ===========================================================================
// Scenario: The original ticket is updated with the bug
// ===========================================================================
test('Scenario: the original ticket gains a ## Bug Reports section before ## Additional Context, updated bumped, created preserved', () => {
  const board = makeBoard();
  const original = board.get('tasks/todo/TASK-010-toggle.md');
  const createdBefore = original.fm.created;
  const acBefore = sectionSlice(original.body, ADDITIONAL_CONTEXT_HEADING);
  const disk = new Map();
  const now = '2026-07-19T12:00:00.000Z';
  // When I confirm a bug against TASK-010
  const r = simulateCreateBug({
    board, disk, now,
    title: 'Toggle ignores saved preference',
    originalId: 'TASK-010',
    bugDesc: 'Reloading resets the toggle to on',
    newId: 'TASK-050',
  });
  assert.equal(r.ok, true, r.error);
  // Then TASK-010's file gains a ## Bug Reports section containing the bug text
  const orig = parseTicketFrontmatter(disk.get(r.origPath));
  const sec = sectionSlice(orig.body, BUG_REPORTS_HEADING);
  assert.ok(sec, 'a Bug Reports section exists on the original');
  assert.match(sec, /Reloading resets the toggle to on/);
  // And that section is inserted before ## Additional Context
  assert.ok(headingIndex(orig.body, BUG_REPORTS_HEADING) < headingIndex(orig.body, ADDITIONAL_CONTEXT_HEADING),
    'Bug Reports precedes Additional Context');
  // And Additional Context is unchanged and still at the tail
  assert.equal(sectionSlice(orig.body, ADDITIONAL_CONTEXT_HEADING), acBefore, 'Additional Context byte-for-byte');
  const acIdx = headingIndex(orig.body, ADDITIONAL_CONTEXT_HEADING);
  assert.ok(!orig.body.split('\n').slice(acIdx + 1).some((l) => /^## /.test(l)), 'Additional Context is last');
  // And updated is bumped while created is preserved
  assert.equal(orig.fm.updated, now, 'updated bumped to now');
  assert.equal(orig.fm.created, createdBefore, 'created preserved');
});

// ===========================================================================
// Scenario: Heading-forging bug text cannot hijack a section (edge)
// ===========================================================================
test('Scenario (edge): heading-forging bug text is escaped and forges no new section boundary', () => {
  const board = makeBoard();
  const disk = new Map();
  const now = '2026-07-19T12:00:00.000Z';
  // When the bug description is literally "## Additional Context"
  const r = simulateCreateBug({
    board, disk, now,
    title: 'Forge attempt',
    originalId: 'TASK-010',
    bugDesc: '## Additional Context',
    newId: 'TASK-051',
  });
  assert.equal(r.ok, true, r.error);
  const orig = parseTicketFrontmatter(disk.get(r.origPath));
  // Then the appended text is escaped to "\#\# Additional Context" (leading run escaped)
  const sec = sectionSlice(orig.body, BUG_REPORTS_HEADING);
  assert.match(sec, /\\## Additional Context/, 'the forging line is escaped');
  // And no NEW real ## Additional Context boundary is created (still exactly one)
  assert.equal((orig.body.match(/^## Additional Context$/gm) || []).length, 1,
    'exactly one real Additional Context — none forged');
  // And the new bug ticket body also escapes the forging text.
  const bug = parseTicketFrontmatter(disk.get(r.bugPath));
  assert.match(bug.body, /\\## Additional Context/, 'the bug ticket body escapes the forging text too');
  assert.equal((bug.body.match(/^## Additional Context$/gm) || []).length, 1,
    'the bug ticket has exactly its own one Additional Context');
});

// ===========================================================================
// Scenario: Empty title is rejected (failure)
// ===========================================================================
test('Scenario (failure): an empty title shows an inline error, writes nothing, leaves TASK-010 unmodified', () => {
  const board = makeBoard();
  const origBefore = serializeTicket(board.get('tasks/todo/TASK-010-toggle.md').fm, board.get('tasks/todo/TASK-010-toggle.md').body);
  const disk = new Map();
  const r = simulateCreateBug({
    board, disk, now: '2026-07-19T12:00:00.000Z',
    title: '   ',
    originalId: 'TASK-010',
    bugDesc: 'Reloading resets the toggle to on',
    newId: 'TASK-052',
  });
  // Then an inline error is shown and nothing is written
  assert.equal(r.ok, false);
  assert.equal(r.error, 'Title is required.');
  assert.equal(disk.size, 0, 'no ticket was written');
  // And TASK-010 is not modified (never touched on disk).
  assert.ok(!disk.has('tasks/todo/TASK-010-toggle.md'), 'the original was not rewritten');
  // (original still serializes identically to before)
  assert.equal(serializeTicket(board.get('tasks/todo/TASK-010-toggle.md').fm, board.get('tasks/todo/TASK-010-toggle.md').body), origBefore);
});

// ===========================================================================
// Scenario: Missing original ticket is rejected (failure)
// ===========================================================================
test('Scenario (failure): no original selected shows an inline error and writes/modifies nothing', () => {
  const board = makeBoard();
  const disk = new Map();
  const r = simulateCreateBug({
    board, disk, now: '2026-07-19T12:00:00.000Z',
    title: 'A bug',
    originalId: '',
    bugDesc: 'something broke',
    newId: 'TASK-053',
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /Select the original ticket/);
  assert.equal(disk.size, 0, 'nothing written');
});

test('Scenario (failure): an original id not on the board is rejected before any write', () => {
  const board = makeBoard();
  const disk = new Map();
  const r = simulateCreateBug({
    board, disk, now: '2026-07-19T12:00:00.000Z',
    title: 'A bug',
    originalId: 'TASK-999',
    bugDesc: 'something broke',
    newId: 'TASK-054',
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /TASK-999 is no longer on the board/);
  assert.equal(disk.size, 0, 'no dangling bug ticket created for a nonexistent original');
});

test('Scenario (failure): an empty bug description is rejected (append helper would be a no-op)', () => {
  const board = makeBoard();
  const disk = new Map();
  const r = simulateCreateBug({
    board, disk, now: '2026-07-19T12:00:00.000Z',
    title: 'A bug',
    originalId: 'TASK-010',
    bugDesc: '   ',
    newId: 'TASK-055',
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /Describe the bug/);
  assert.equal(disk.size, 0, 'nothing written for an empty bug description');
});

// ===========================================================================
// Scenario: Original ticket unwritable fails safely (failure)
// ===========================================================================
test('Scenario (failure): an unwritable original fails safely — no bug ticket orphan, no inconsistent link', () => {
  const board = makeBoard();
  const disk = new Map();
  // Given writing TASK-010 will fail
  const r = simulateCreateBug({
    board, disk, now: '2026-07-19T12:00:00.000Z',
    title: 'Toggle ignores saved preference',
    originalId: 'TASK-010',
    bugDesc: 'Reloading resets the toggle to on',
    newId: 'TASK-056',
    writeFail: true,
  });
  // Then an inline error is shown
  assert.equal(r.ok, false);
  assert.match(r.error, /Failed to update original ticket/);
  // And the board is not left in an inconsistent linked state:
  //  - no bug ticket exists (original-first ordering aborts before STEP 2)
  assert.ok(![...disk.keys()].some((k) => k !== 'tasks/todo/TASK-010-toggle.md'),
    'no orphaned bug ticket was written');
  assert.ok(!disk.has('tasks/todo/TASK-056-bug.md'), 'the bug ticket is not created');
});

test('Scenario (failure): an unreadable original aborts before any write (no orphan)', () => {
  const board = makeBoard();
  const disk = new Map();
  const r = simulateCreateBug({
    board, disk, now: '2026-07-19T12:00:00.000Z',
    title: 'Toggle ignores saved preference',
    originalId: 'TASK-010',
    bugDesc: 'Reloading resets the toggle to on',
    newId: 'TASK-057',
    readFail: true,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /Cannot read original ticket/);
  assert.equal(disk.size, 0, 'nothing written when the original is unreadable');
});

// ===========================================================================
// Scenario: STEP 2 (bug-ticket write) fails — the partial state (failure)
// TASK-039: original committed, but the NEW bug-ticket write fails. Original
// updated exactly once, no bug ticket, inline partial-state error surfaced.
// ===========================================================================
test('Scenario (failure): the bug-ticket write (STEP 2) fails — original updated exactly once, no bug ticket, partial-state error', () => {
  const board = makeBoard();
  const disk = new Map();
  const now = '2026-07-19T12:00:00.000Z';
  // Given STEP 1 (updating TASK-010) succeeds but STEP 2 (writing the bug ticket) fails
  const r = simulateCreateBug({
    board, disk, now,
    title: 'Toggle ignores saved preference',
    originalId: 'TASK-010',
    bugDesc: 'Reloading resets the toggle to on',
    newId: 'TASK-058',
    bugWriteFails: true,
  });
  // Then an inline error names the partial state (original already updated).
  assert.equal(r.ok, false);
  assert.match(r.error, /Bug ticket create failed/, 'inline error names the failed bug-ticket write');
  assert.match(r.error, /original was updated/, 'inline error names the partial state');
  // And the ORIGINAL was updated EXACTLY once (one folded entry).
  const orig = parseTicketFrontmatter(disk.get(r.origPath));
  const sec = sectionSlice(orig.body, BUG_REPORTS_HEADING);
  assert.ok(sec, 'the original gained a ## Bug Reports section (STEP 1 committed)');
  assert.match(sec, /Reloading resets the toggle to on/);
  assert.equal((sec.match(/^### /gm) || []).length, 1, 'the original was folded EXACTLY once');
  // And NO bug ticket was written (partial state, not an orphan pair).
  assert.ok(!disk.has(r.bugPath), 'the bug ticket file was NOT written');
  assert.ok(![...disk.keys()].some((k) => k !== r.origPath),
    'only the original is on disk — no bug ticket was created');
});

// ===========================================================================
// Scenario: STEP-2 fails, user retries, STEP 2 succeeds — no double-fold (TASK-038)
// ===========================================================================
test('Scenario: STEP-2 fails then retry succeeds — TASK-010 folded EXACTLY once, one bug ticket, memo cleared', () => {
  const board = makeBoard();
  const disk = new Map();
  const session = {}; // threads the TASK-038 memo across the two clicks
  const args = {
    board, disk, session,
    title: 'Toggle ignores saved preference',
    originalId: 'TASK-010',
    bugDesc: 'Reloading resets the toggle to on',
    newId: 'TASK-059',
  };

  // First click: STEP 1 commits, STEP 2 fails → memo retained, error surfaced.
  const first = simulateCreateBug({ ...args, now: '2026-07-19T12:00:00.000Z', bugWriteFails: true });
  assert.equal(first.ok, false);
  assert.match(first.error, /original was updated/);
  assert.deepEqual(session.bugStep1Done, { originalId: 'TASK-010', id: 'TASK-059' }, 'memo retained after STEP-2 failure');
  assert.ok(!disk.has(first.bugPath), 'no bug ticket yet');
  assert.equal((sectionSlice(parseTicketFrontmatter(disk.get(first.origPath)).body, BUG_REPORTS_HEADING).match(/^### /gm) || []).length, 1,
    'the original was folded once on the first (failed) attempt');

  // Retry: STEP 1 SKIPPED (memo matches), STEP 2 now succeeds.
  const retry = simulateCreateBug({ ...args, now: '2026-07-19T13:00:00.000Z' });
  assert.equal(retry.ok, true, retry.error);
  // Then TASK-010 still carries EXACTLY ONE ## Bug Reports entry (no double-fold).
  const orig = parseTicketFrontmatter(disk.get(retry.origPath));
  const sec = sectionSlice(orig.body, BUG_REPORTS_HEADING);
  assert.equal((sec.match(/^### /gm) || []).length, 1, 'exactly one ## Bug Reports entry after retry (TASK-038 dedup)');
  assert.equal((orig.body.match(/^## Bug Reports$/gm) || []).length, 1, 'a single Bug Reports heading');
  assert.equal((sec.match(/Reloading resets the toggle to on/g) || []).length, 1, 'the folded bug text appears once');
  // And exactly one bug ticket was written, linked back to the original.
  assert.ok(disk.has(retry.bugPath), 'the bug ticket is written on the successful retry');
  assert.equal(parseTicketFrontmatter(disk.get(retry.bugPath)).fm['bug-of'], 'TASK-010');
  // And the memo is cleared once the create finally completes.
  assert.equal(session.bugStep1Done, null, 'memo cleared after the retry succeeds');
});

// ===========================================================================
// Scenario (TASK-043): The model folds the "Reported as <id>" prefix PLUS the
// description — the exact composition real onCreateBug uses.
//   Given the bug-create test model performs STEP 1
//   Then the folded bug text equals "Reported as <newId>\n<bugDesc>"
// ===========================================================================
test('Scenario: simulateCreateBug STEP 1 folds "Reported as " + newId + "\\n" + bugDesc (TASK-043 composition)', () => {
  // Given the bug-create test model performs STEP 1 against TASK-010.
  const board = makeBoard();
  const disk = new Map();
  const now = '2026-07-19T12:00:00.000Z';
  const newId = 'TASK-060';
  const bugDesc = 'Reloading resets the toggle to on';
  const r = simulateCreateBug({
    board, disk, now,
    title: 'Toggle ignores saved preference',
    originalId: 'TASK-010',
    bugDesc,
    newId,
  });
  assert.equal(r.ok, true, r.error);

  // Then the folded bug text equals "Reported as <newId>\n<bugDesc>". Prove it by
  // independently folding THAT exact composition into a pristine copy of the
  // original body and asserting the model produced a byte-for-byte identical
  // ## Bug Reports section — the id line PLUS the description, in that order.
  const expectedBug = 'Reported as ' + newId + '\n' + bugDesc;
  const pristine = makeBoard().get('tasks/todo/TASK-010-toggle.md').body;
  const expectedSec = sectionSlice(appendBugReport(pristine, { bug: expectedBug, timestamp: now }), BUG_REPORTS_HEADING);
  const actualSec = sectionSlice(parseTicketFrontmatter(disk.get(r.origPath)).body, BUG_REPORTS_HEADING);
  assert.ok(actualSec, 'a ## Bug Reports section exists on the folded original');
  assert.equal(actualSec, expectedSec, "the model folds exactly 'Reported as ' + newId + '\\n' + bugDesc");
  // And the id line is immediately followed by the description line (the '\n' join).
  assert.match(actualSec, /Reported as TASK-060\nReloading resets the toggle to on/,
    'the "Reported as <newId>" line is joined to the description by a single newline');
  // And dropping either half would change the section — guard both are present.
  assert.match(actualSec, /Reported as TASK-060/, 'the id-line prefix is present');
  assert.match(actualSec, /Reloading resets the toggle to on/, 'the description is present');
});

// ===========================================================================
// DRIFT GUARDS — tie the in-memory model above to the REAL renderer source so a
// divergence in production (renderer/renderer.js) fails a test here.
// ===========================================================================
function opener() {
  return rendererSrc.slice(rendererSrc.indexOf('function openNewTaskModal'), rendererSrc.indexOf('function openPlanModal'));
}

test("DRIFT GUARD: onCreateBug STEP-1 fold composes bug: 'Reported as ' + id + '\\n' + bugDesc (ties this file's model to source)", () => {
  // TASK-043: simulateCreateBug (above) folds the ORIGINAL with
  // `'Reported as ' + newId + '\n' + desc`. This guard ties THAT composition to
  // the real renderer so dropping the `Reported as <id>` line (breaking the
  // TASK-037 bidirectional link) FAILS a test in THIS file, not only in
  // test/task-037-bug-link.e2e.test.js.
  const src = opener();
  const body = src.slice(src.indexOf('const onCreateBug ='), src.indexOf('const onCreate ='));
  assert.match(
    body,
    /appendBugReportToMarkdown\(origBody,\s*\{\s*bug:\s*'Reported as '\s*\+\s*id\s*\+\s*'\\n'\s*\+\s*bugDesc\s*,\s*timestamp:\s*now\s*\}\)/,
    "renderer onCreateBug STEP 1 must fold bug: 'Reported as ' + id + '\\n' + bugDesc",
  );
  // Explicitly assert the `Reported as ` prefix is present — this is the exact
  // token whose removal would break the bidirectional link the model mirrors.
  assert.ok(body.includes("'Reported as '"), "the 'Reported as ' id-line prefix must be present in the fold");
});

test('DRIFT GUARD: onCreateBug writes the ORIGINAL before creating the bug ticket', () => {
  const src = opener();
  const idxCreateBug = src.indexOf('const onCreateBug =');
  assert.ok(idxCreateBug !== -1, 'onCreateBug exists');
  const body = src.slice(idxCreateBug, src.indexOf('const onCreate =', idxCreateBug));
  // STEP 1: original re-read + append + write.
  const appendAt = body.indexOf('appendBugReportToMarkdown(origBody');
  const writeOrigAt = body.indexOf('window.api.fs.writeFile(origPath');
  // STEP 2: new bug ticket fm with bug-of + its write.
  const bugOfAt = body.indexOf("fm['bug-of'] = originalId");
  assert.ok(appendAt !== -1, 'reuses appendBugReportToMarkdown to fold the bug into the original');
  assert.ok(writeOrigAt !== -1, 'writes the original ticket');
  assert.ok(bugOfAt !== -1, "sets fm['bug-of'] on the new bug ticket");
  // ORDERING: the original append AND write must precede the bug-of ticket build.
  assert.ok(appendAt < bugOfAt, 'the original is folded BEFORE the bug ticket is composed');
  assert.ok(writeOrigAt < bugOfAt, 'the original is WRITTEN before the bug ticket is composed');
});

test('DRIFT GUARD: onCreateBug STEP-2 failure surfaces the partial-state inline error, keeps the memo, and re-arms', () => {
  // Anchor on the STEP-2 write-failure branch and read down to its `return;`.
  const anchor = rendererSrc.indexOf("errEl.textContent = 'Bug ticket create failed");
  assert.ok(anchor !== -1, 'the STEP-2 partial-state error branch exists');
  const branch = rendererSrc.slice(anchor, rendererSrc.indexOf('return;', anchor) + 'return;'.length);
  // The exact partial-state message the e2e model mirrors.
  assert.match(branch, /Bug ticket create failed \(original was updated, retry writes only the bug ticket\): /,
    'the STEP-2 failure surfaces the partial-state inline error (not silently swallowed)');
  // It re-arms Create for the retry rather than cleaning up.
  assert.match(branch, /armCreate\(\);/, 'the STEP-2 failure branch re-arms Create for the retry');
  // And it does NOT clear the TASK-038 memo (else the retry would re-fold a duplicate).
  assert.ok(!/bugStep1Done\s*=\s*null/.test(branch),
    'the STEP-2 failure branch keeps the memo so the retry writes only the bug ticket');
});

test('DRIFT GUARD: onCreateBug validates title, original-selected, desc, and original-exists in order', () => {
  const src = opener();
  const body = src.slice(src.indexOf('const onCreateBug ='), src.indexOf('const onCreate ='));
  const titleAt = body.indexOf("errEl.textContent = 'Title is required.'");
  const selAt = body.indexOf('Select the original ticket');
  const descAt = body.indexOf('Describe the bug before creating');
  const existsAt = body.indexOf('is no longer on the board');
  assert.ok(titleAt !== -1 && selAt !== -1 && descAt !== -1 && existsAt !== -1, 'all four guards present');
  assert.ok(titleAt < selAt && selAt < descAt && descAt < existsAt, 'guards run in the documented order');
  // The original must be validated against the board BEFORE any write.
  assert.ok(existsAt < body.indexOf('window.api.fs.writeFile(origPath'), 'existence checked before writing');
});

test('DRIFT GUARD: onCreateBug re-reads the freshest original and preserves created / bumps updated', () => {
  const body = opener().slice(opener().indexOf('const onCreateBug ='), opener().indexOf('const onCreate ='));
  assert.match(body, /window\.api\.fs\.readFile\(origPath\)/, 're-reads the original from disk');
  assert.match(body, /parseTicketFrontmatter\(read\.content\)/, 'parses the freshest content');
  assert.match(body, /newOrigFm\.updated = now/, 'bumps updated');
  assert.match(body, /if \(!newOrigFm\.created\) newOrigFm\.created = now/, 'preserves an existing created');
  assert.match(body, /serializeTicket\(newOrigFm, newOrigBody\)/, 'whole-file serialize of the original');
});

test('DRIFT GUARD: the new bug ticket is status todo, filed via ticketFolderForStatus, body references the original', () => {
  const body = opener().slice(opener().indexOf('const onCreateBug ='), opener().indexOf('const onCreate ='));
  assert.match(body, /const fm = \{ id, title, status: 'todo', created: now, updated: now \};/, 'status todo, fresh timestamps');
  assert.match(body, /fm\['bug-of'\] = originalId;/, 'bug-of linkage');
  // TASK-040: the original id is heading-escaped before interpolation (via the
  // shared neutralizeBugText mirror) so a heading-like id cannot forge a section.
  assert.match(body, /'Bug against ' \+ neutralizeBugText\(originalId\)/, 'body references the original id (heading-escaped, TASK-040)');
  assert.match(body, /neutralizeBugText\(bugDesc\)/, 'the description is heading-escaped');
  assert.match(body, /ticketFolderForStatus\('todo'\)/, 'filed into the todo folder');
  assert.match(body, /window\.api\.fs\.mkdir\(destDir\)/, 'ensures the destination folder');
  assert.match(body, /window\.api\.fs\.writeFile\(filePath, serializeTicket\(fm, body\)\)/, 'whole-file write of the bug ticket');
});

test('DRIFT GUARD: bug mode is gated to a plain todo create (hidden for the post-processing Add path)', () => {
  const src = opener();
  assert.match(src, /const allowBug = !!bugBtn && !kind && status === 'todo';/, 'Bug offered only for a plain todo create');
  assert.match(src, /bugBtn\.classList\.toggle\('hidden', !allowBug\)/, 'the Bug button is hidden when not allowed');
  // The selector is populated from the live board (tab.tasks.tickets → fm.id).
  assert.match(src, /for \(const tk of tab\.tasks\.tickets\.values\(\)\)/, 'selector populated from the live board');
  assert.match(src, /const tid = tk && tk\.fm && tk\.fm\.id;/, 'reads each ticket fm.id');
  // onCreate dispatches to onCreateBug when in bug mode.
  assert.match(src, /if \(bugMode\) \{ await onCreateBug\(\); return; \}/, 'onCreate dispatches to the bug path in bug mode');
  // leaveBugMode resets on open and on cleanup (no stale selection/listeners).
  assert.match(src, /leaveBugMode\(\);\s*\n\s*errEl\.textContent = '';/, 'leaveBugMode resets the modal on open');
  assert.match(src, /const cleanup = \(\) => \{[\s\S]*?leaveBugMode\(\);/, 'cleanup leaves bug mode');
  assert.match(src, /if \(disposeCreate\) disposeCreate\(\);[\s\S]*?if \(disposeBug\) disposeBug\(\);/, 'cleanup disposes listeners');
});

test('DRIFT GUARD: onCreateBug uses bindActionOnce re-arm on retry paths', () => {
  const body = opener().slice(opener().indexOf('const onCreateBug ='), opener().indexOf('const onCreate ='));
  // Every early-return validation path re-arms the create button.
  assert.ok((body.match(/armCreate\(\); return;/g) || []).length >= 4,
    'each guard re-arms the create listener before returning');
  assert.match(opener(), /const armCreate = \(\) => \{ disposeCreate = bindActionOnce\(createBtn, 'click', onCreate\); \};/,
    'armCreate binds via bindActionOnce');
});
