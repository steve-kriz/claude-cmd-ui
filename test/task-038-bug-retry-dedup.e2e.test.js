'use strict';

// ===========================================================================
// TASK-038 — E2E (cucumber-style Given/When/Then) scenarios for the
// "bug create retry duplicate-fold" fix.
//
// FEATURE: Retrying a failed bug create does not duplicate the original's bug
// report. In the #newTaskModal bug-create flow, STEP 1 folds the bug into the
// ORIGINAL ticket's `## Bug Reports` section and STEP 2 writes the new bug
// ticket. When STEP 2 fails, the handler re-arms for a retry. The fix ensures a
// retry that only failed at STEP 2 does NOT re-fold the original a second time,
// via a session-scoped memo `bugStep1Done = { originalId, id }` that is cleared
// by leaveBugMode() (open / cancel / cleanup / toggle-off).
//
// These scenarios are Given/When/Then `node --test` cases (NO `cucumber` npm
// package is installed or added). The renderer's DOM/modal wiring is a browser
// script and cannot be require()'d, so the scenarios drive a FAITHFUL in-memory
// model of onCreateBug's session state machine (same control flow as the
// renderer) using the REAL requireable fold helper lib/ticket-bug-reports.js.
// A SOURCE-SCAN drift guard at the end asserts the real renderer.js still wires
// the memo correctly, so the fix cannot silently regress.
//
// NO NETWORK, NO DATABASE, NO DISK. Every fs.readFile/writeFile the renderer
// would perform is modeled with in-memory fakes. Determinism: fixed timestamps.
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

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');

const TS1 = '2026-07-19T10:00:00.000Z';
const TS2 = '2026-07-19T11:30:00.000Z';

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

// ---------------------------------------------------------------------------
// A faithful, deterministic model of the modal's bug-create SESSION. It holds
// the same `bugStep1Done` memo the renderer closure holds, exposes reset()
// (leaveBugMode) and submit() (an onCreateBug click). STEP 1 folds the ORIGINAL
// with the REAL helper into an in-memory "disk"; STEP 2 writes the bug ticket
// into the same store. Outcomes for the STEP-2 write are supplied per-scenario.
// ---------------------------------------------------------------------------
function makeBoard(originals) {
  // disk: originalId -> committed markdown; bugTickets: id -> record
  const disk = new Map(Object.entries(originals));
  const bugTickets = new Map();
  let bugStep1Done = null;

  return {
    disk,
    bugTickets,
    memo() { return bugStep1Done; },
    // leaveBugMode(): open / cancel / cleanup / toggle-off.
    reset() { bugStep1Done = null; },

    // One "Create" click in bug mode. `step2` gives the STEP-2 write outcome
    // for THIS click ({ ok } | { ok:false, error }); default ok.
    create({ originalId, id, bugDesc, timestamp, step2 }) {
      // Validations (title/original/desc) are assumed satisfied here; the pure
      // validation guard is unit-tested separately. Original must be on the board.
      if (!disk.has(originalId)) {
        return { ok: false, phase: 'validation', error: 'original not on board' };
      }
      const step1AlreadyDone = !!bugStep1Done
        && bugStep1Done.originalId === originalId
        && bugStep1Done.id === id;

      let step1Ran = false;
      if (!step1AlreadyDone) {
        step1Ran = true;
        // STEP 1: re-read fresh, fold via the REAL helper, commit (write ok).
        const fresh = disk.get(originalId);
        const folded = appendBugReport(fresh, {
          bug: 'Reported as ' + id + '\n' + bugDesc,
          timestamp: timestamp || TS1,
        });
        disk.set(originalId, folded); // write ok (STEP 1 write failure has its own unit test)
        bugStep1Done = { originalId, id };
      }

      // STEP 2: write the new bug ticket.
      const res = step2 || { ok: true };
      if (!res.ok) {
        // KEEP the memo, re-arm for retry (do NOT cleanup).
        return { ok: false, phase: 'step2', error: res.error, step1Ran, step1Skipped: step1AlreadyDone };
      }
      bugTickets.set(id, { id, 'bug-of': originalId, bugDesc });
      // cleanup() -> leaveBugMode() -> memo cleared.
      bugStep1Done = null;
      return { ok: true, phase: 'done', step1Ran, step1Skipped: step1AlreadyDone };
    },
  };
}

function bugReportEntryCount(md) {
  const sec = sectionSlice(md, BUG_REPORTS_HEADING);
  if (!sec) return 0;
  return (sec.match(/^### /gm) || []).length;
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
// SCENARIO 1 (Gherkin): STEP 2 fails, user retries, original updated ONCE
// ===========================================================================
test('SCENARIO: STEP 2 fails then retry succeeds — TASK-010 has exactly ONE Bug Reports entry and ONE new bug ticket', () => {
  // GIVEN the Bug button targets original "TASK-010" with a bug description
  const board = makeBoard({ 'TASK-010': ORIGINAL_BODY });
  const args = { originalId: 'TASK-010', id: 'TASK-050', bugDesc: 'Reload flips the toggle back on', timestamp: TS1 };

  // AND updating TASK-010 (STEP 1) succeeds but writing the new bug ticket (STEP 2) fails
  const first = board.create({ ...args, step2: { ok: false, error: 'EACCES' } });
  assert.equal(first.ok, false);
  assert.equal(first.phase, 'step2', 'STEP 1 committed; STEP 2 failed');
  assert.equal(board.bugTickets.size, 0, 'no bug ticket written yet');
  assert.deepEqual(board.memo(), { originalId: 'TASK-010', id: 'TASK-050' }, 'session memo retained for the retry');

  // WHEN the user clicks create again and STEP 2 now succeeds
  const retry = board.create({ ...args, step2: { ok: true } });

  // THEN TASK-010 has exactly one matching "## Bug Reports" entry
  assert.equal(retry.ok, true);
  assert.equal(retry.step1Skipped, true, 'STEP 1 was skipped on retry (no re-fold)');
  assert.equal(bugReportEntryCount(board.disk.get('TASK-010')), 1, 'exactly one ## Bug Reports entry');
  const sec = sectionSlice(board.disk.get('TASK-010'), BUG_REPORTS_HEADING);
  assert.equal((sec.match(/Reported as TASK-050/g) || []).length, 1, 'the folded entry appears exactly once');
  // AND exactly one new bug ticket exists
  assert.equal(board.bugTickets.size, 1, 'exactly one new bug ticket');
  assert.equal(board.bugTickets.get('TASK-050')['bug-of'], 'TASK-010', 'bug ticket links back to the original');
  // AND the memo is cleared once the create finally completes.
  assert.equal(board.memo(), null);
});

// ===========================================================================
// SCENARIO 2 (Gherkin edge): a new bug against the same original after close
// still folds a FRESH entry
// ===========================================================================
test('SCENARIO (edge): a second, different bug against TASK-010 after close folds a SECOND distinct entry', () => {
  // GIVEN a bug was successfully filed against "TASK-010" and the modal was closed
  const board = makeBoard({ 'TASK-010': ORIGINAL_BODY });
  const first = board.create({ originalId: 'TASK-010', id: 'TASK-050', bugDesc: 'first bug', timestamp: TS1, step2: { ok: true } });
  assert.equal(first.ok, true);
  assert.equal(bugReportEntryCount(board.disk.get('TASK-010')), 1);
  board.reset(); // modal closed -> leaveBugMode() clears the memo

  // WHEN a second, different bug is filed against "TASK-010"
  const second = board.create({ originalId: 'TASK-010', id: 'TASK-051', bugDesc: 'second, different bug', timestamp: TS2, step2: { ok: true } });

  // THEN TASK-010 has two distinct "## Bug Reports" entries
  assert.equal(second.ok, true);
  assert.equal(second.step1Ran, true, 'STEP 1 ran fresh for the new session');
  assert.equal(bugReportEntryCount(board.disk.get('TASK-010')), 2, 'two distinct entries');
  const sec = sectionSlice(board.disk.get('TASK-010'), BUG_REPORTS_HEADING);
  assert.match(sec, /first bug/);
  assert.match(sec, /second, different bug/);
  assert.equal((board.disk.get('TASK-010').match(/^## Bug Reports$/gm) || []).length, 1, 'both entries live under a single Bug Reports heading');
  assert.equal(board.bugTickets.size, 2, 'two bug tickets, one per filing');
});

// ===========================================================================
// SCENARIO 3 (edge): repeated STEP-2 failures never accrete duplicates
// ===========================================================================
test('SCENARIO (edge): three consecutive STEP-2 failures keep the original at ONE entry', () => {
  // GIVEN a bug targeting TASK-010
  const board = makeBoard({ 'TASK-010': ORIGINAL_BODY });
  const args = { originalId: 'TASK-010', id: 'TASK-050', bugDesc: 'boom', timestamp: TS1 };

  // WHEN STEP 2 fails three times in a row
  board.create({ ...args, step2: { ok: false, error: 'E1' } });
  board.create({ ...args, step2: { ok: false, error: 'E2' } });
  board.create({ ...args, step2: { ok: false, error: 'E3' } });

  // THEN the original still carries exactly one folded entry and no bug ticket exists
  assert.equal(bugReportEntryCount(board.disk.get('TASK-010')), 1, 'no duplicate accretion across retries');
  assert.equal(board.bugTickets.size, 0, 'still no bug ticket while STEP 2 keeps failing');

  // AND WHEN a fourth retry finally succeeds
  const ok = board.create({ ...args, step2: { ok: true } });
  assert.equal(ok.ok, true);
  assert.equal(ok.step1Skipped, true);
  assert.equal(bugReportEntryCount(board.disk.get('TASK-010')), 1, 'still exactly one entry after success');
  assert.equal(board.bugTickets.size, 1, 'one bug ticket after the successful retry');
});

// ===========================================================================
// SCENARIO 4 (edge): switching the selected original between retries reruns STEP 1
// ===========================================================================
test('SCENARIO (edge): switching the target original between retries folds a FRESH entry into the new target', () => {
  // GIVEN a bug first targets TASK-010, whose STEP 2 fails
  const board = makeBoard({ 'TASK-010': ORIGINAL_BODY, 'TASK-011': ORIGINAL_BODY });
  board.create({ originalId: 'TASK-010', id: 'TASK-050', bugDesc: 'boom', timestamp: TS1, step2: { ok: false, error: 'E1' } });
  assert.equal(bugReportEntryCount(board.disk.get('TASK-010')), 1, 'TASK-010 folded once already');

  // WHEN the user switches the selected original to TASK-011 and retries (STEP 2 ok)
  const retry = board.create({ originalId: 'TASK-011', id: 'TASK-050', bugDesc: 'boom', timestamp: TS2, step2: { ok: true } });

  // THEN STEP 1 ran fresh for TASK-011 and each original carries exactly one entry
  assert.equal(retry.ok, true);
  assert.equal(retry.step1Skipped, false, 'memo did not match the new target — STEP 1 ran fresh');
  assert.equal(retry.step1Ran, true);
  assert.equal(bugReportEntryCount(board.disk.get('TASK-010')), 1, 'the abandoned target keeps its single entry');
  assert.equal(bugReportEntryCount(board.disk.get('TASK-011')), 1, 'the new target gets a fresh single entry');
});

// ===========================================================================
// SCENARIO 5 (happy path regression): a single successful create folds once
// ===========================================================================
test('SCENARIO (happy path): one successful bug create folds ONE entry and writes ONE bug ticket', () => {
  // GIVEN a bug targeting TASK-010
  const board = makeBoard({ 'TASK-010': ORIGINAL_BODY });

  // WHEN the user creates it and both steps succeed
  const r = board.create({ originalId: 'TASK-010', id: 'TASK-050', bugDesc: 'reload flips the toggle', timestamp: TS1, step2: { ok: true } });

  // THEN exactly one entry, one bug ticket, memo cleared, Additional Context preserved
  assert.equal(r.ok, true);
  assert.equal(bugReportEntryCount(board.disk.get('TASK-010')), 1);
  assert.equal(board.bugTickets.size, 1);
  assert.equal(board.memo(), null);
  const body = board.disk.get('TASK-010');
  assert.ok(body.indexOf(BUG_REPORTS_HEADING) < body.indexOf(ADDITIONAL_CONTEXT_HEADING),
    'Bug Reports folded before the user-owned Additional Context');
  assert.equal(
    sectionSlice(body, ADDITIONAL_CONTEXT_HEADING),
    sectionSlice(ORIGINAL_BODY, ADDITIONAL_CONTEXT_HEADING),
    'Additional Context preserved byte-for-byte',
  );
});

// ===========================================================================
// DRIFT GUARD (source scan): the real renderer.js must keep the memo wiring, so
// the fix cannot silently regress into the duplicate-fold bug again.
// ===========================================================================
// NOTE (TASK-042): the TASK-038 single-slot `bugStep1Done = { originalId, id }`
// memo was superseded by a session `Set` of committed fold keys
// (`bugFoldedTargets` + `foldKey(origId, bugId)`), which also fixes the
// multi-target switch double-fold. These guards track the NEW mechanism but keep
// their original load-bearing intent: they must still FAIL if the fold-tracking
// memo/guard that prevents a retry from re-folding the original ever regresses.
test('DRIFT GUARD: renderer declares the bugFoldedTargets Set and clears it in leaveBugMode', () => {
  assert.match(rendererSrc, /const bugFoldedTargets = new Set\(\);/, 'the session fold-tracking Set is declared in the modal closure');
  // leaveBugMode clears the whole set. Scan the leaveBugMode body for the clear.
  const lbm = rendererSrc.slice(rendererSrc.indexOf('const leaveBugMode = () => {'));
  const lbmBody = lbm.slice(0, lbm.indexOf('};') + 2);
  assert.match(lbmBody, /bugFoldedTargets\.clear\(\);/, 'leaveBugMode clears the fold-tracking Set (open/cancel/cleanup/toggle-off)');
});

test('DRIFT GUARD: onCreateBug computes step1AlreadyDone via bugFoldedTargets.has(foldKey(originalId, id))', () => {
  assert.match(
    rendererSrc,
    /const key = foldKey\(originalId, id\);/,
    'the fold key must be the composite foldKey(originalId, id) so a target/id switch reruns STEP 1',
  );
  assert.match(
    rendererSrc,
    /const step1AlreadyDone = bugFoldedTargets\.has\(key\);/,
    'step1AlreadyDone must be derived from bugFoldedTargets.has(key)',
  );
});

test('DRIFT GUARD: the STEP 1 block is guarded by if (!step1AlreadyDone) and records the fold on success', () => {
  assert.match(rendererSrc, /if \(!step1AlreadyDone\) \{/, 'STEP 1 (re-read/append/write) is guarded so a retry skips it');
  assert.match(rendererSrc, /bugFoldedTargets\.add\(key\);/, 'STEP 1 success records the committed fold via bugFoldedTargets.add(key)');
});

test('DRIFT GUARD: the STEP 2 failure branch does NOT clear the fold Set (retry writes only the bug ticket)', () => {
  // Isolate the STEP-2 write-failure branch: from the STEP-2 write guard down to
  // its `return;`. It must NOT clear/replace `bugFoldedTargets` (that would restore
  // the bug: a retry would re-fold). Only cleanup()/leaveBugMode() clear it.
  const anchor = rendererSrc.indexOf("errEl.textContent = 'Bug ticket create failed");
  assert.ok(anchor !== -1, 'the STEP-2 failure branch exists');
  const branch = rendererSrc.slice(anchor, rendererSrc.indexOf('return;', anchor) + 'return;'.length);
  assert.ok(!/bugFoldedTargets\s*\.\s*clear\s*\(\)/.test(branch),
    'the STEP-2 failure branch must NOT clear the fold Set (else the retry re-folds a duplicate)');
  assert.ok(!/bugFoldedTargets\s*=\s*new Set\(\)/.test(branch),
    'the STEP-2 failure branch must NOT reassign a fresh fold Set (else the retry re-folds a duplicate)');
  // And it re-arms for the retry rather than cleaning up.
  assert.match(branch, /armCreate\(\);/, 'the STEP-2 failure branch re-arms Create for the retry');
});
