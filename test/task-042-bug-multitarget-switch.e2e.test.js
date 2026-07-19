'use strict';

// ===========================================================================
// TASK-042 — E2E (cucumber-style Given/When/Then) scenarios for the
// "multi-target switch double-fold / dangling fold" fix in onCreateBug
// (renderer/renderer.js, inside openNewTaskModal).
//
// These are scenario-style `node --test` cases (NO cucumber npm package). Each
// mirrors a Gherkin scenario from
//   tasks/testing/TASK-042-bug-multitarget-switch-dangling-fold.md
// and drives an in-memory replica of the real session state machine — a `Set`
// of committed fold keys `foldKey(originalId, id)` — with the STEP-1 fold
// performed by the REAL helper lib/ticket-bug-reports.js `appendBugReport`, so
// entry counts are grounded in production behaviour.
//
// PLUS: SOURCE-SCAN drift guards that read the REAL renderer/renderer.js and
// renderer/index.html and assert the fix's load-bearing shape is present, so the
// fix cannot silently regress. renderer.js is NOT requireable (Electron/DOM
// globals), which is why the behavioural scenarios use a faithful replica and
// the wiring is verified by scanning the source.
//
// NO DATABASE. NO DISK writes. NO NETWORK. Determinism: fixed timestamps.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  appendBugReport,
  BUG_REPORTS_HEADING,
} = require('../lib/ticket-bug-reports');

const TS = '2026-07-19T10:00:00.000Z';

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
].join('\n');

const foldKey = (origId, bugId) => origId + ' ' + bugId;

// Warning predicate mirroring updateBugSwitchWarning's core (renderer.js ~6518).
function shouldWarn(selectedOriginal, id, committedSet) {
  const currentKey = foldKey(selectedOriginal, id);
  for (const key of committedSet) if (key !== currentKey) return true;
  return false;
}

// Faithful replica of the onCreateBug session state machine (see the unit test
// file for the detailed control-flow mapping). Folds via the REAL helper.
function makeWorld() {
  const bugFoldedTargets = new Set();
  const bodies = new Map();
  const pending = new Map();
  const counts = { fold: 0, writeOriginal: 0, writeBug: 0 };
  const readQ = new Map();     // originalId -> queue of read results
  const writeOrigQ = [];       // shared queue of STEP-1 (original) write results in submit order
  const writeBugQ = [];        // shared queue of STEP-2 results in submit order
  let warningVisible = false;
  let warningText = '';

  function nextFrom(map, originalId) {
    const q = map.get(originalId);
    return q && q.length ? q.shift() : { ok: true };
  }

  const world = {
    counts,
    givenOriginalOnBoard(originalId, body) { bodies.set(originalId, body); return world; },
    givenReadFails(originalId, err) {
      const q = readQ.get(originalId) || []; q.push({ ok: false, error: err }); readQ.set(originalId, q); return world;
    },
    // Arm the NEXT STEP-1 (original) write to fail, in submit order. Mirrors the
    // real onCreateBug: the failed original write aborts BEFORE STEP 2 and never
    // records a fold key, so a retry re-runs STEP 1 from scratch.
    givenOriginalWriteFails(err) { writeOrigQ.push({ ok: false, error: err }); return world; },
    givenNextBugWriteFails(err) { writeBugQ.push({ ok: false, error: err }); return world; },
    givenNextBugWriteOk() { writeBugQ.push({ ok: true }); return world; },

    // The user selects a different original in the `.newtask-bug-of` select —
    // the persistent `change` listener recomputes the switch warning.
    whenUserSelectsOriginal(originalId, id) {
      warningVisible = shouldWarn(originalId, id, bugFoldedTargets);
      warningText = warningVisible
        ? 'Heads up: already has a recorded bug report (Reported as ' + id + ') from this session.'
        : '';
      return world;
    },
    warningVisible() { return warningVisible; },
    warningText() { return warningText; },
    committedFolds() { return new Set(bugFoldedTargets); },
    bugReportEntryCount(originalId) { return bugEntryCount(bodies.get(originalId)); },

    // leaveBugMode(): open / cancel / toggle-off clears the whole set + warning.
    whenSessionResets() { bugFoldedTargets.clear(); warningVisible = false; warningText = ''; return world; },

    // One Create click in bug mode.
    whenCreateClicked({ originalId, id, valid = true, bugDesc = 'boom' }) {
      if (!valid) return { ok: false, phase: 'validation' };
      const key = foldKey(originalId, id);
      const step1AlreadyDone = bugFoldedTargets.has(key);
      let step1Ran = false;
      if (!step1AlreadyDone) {
        step1Ran = true;
        const read = nextFrom(readQ, originalId);
        if (!read.ok) return { ok: false, phase: 'step1-read', step1Ran };
        counts.fold += 1;
        const before = bodies.has(originalId) ? bodies.get(originalId) : ORIGINAL_BODY;
        pending.set(originalId, appendBugReport(before, { bug: 'Reported as ' + id + '\n' + bugDesc, timestamp: TS }));
        counts.writeOriginal += 1;
        const owr = writeOrigQ.length ? writeOrigQ.shift() : { ok: true };
        // STEP-1 (original) write failed: abort BEFORE STEP 2, commit no fold key
        // and write no bug ticket, so a retry re-runs STEP 1 cleanly.
        if (!owr.ok) { pending.delete(originalId); return { ok: false, phase: 'step1-write', step1Ran }; }
        bodies.set(originalId, pending.get(originalId)); pending.delete(originalId);
        bugFoldedTargets.add(key);
        // refresh switch warning after committing a fold (renderer.js ~6733)
        warningVisible = shouldWarn(originalId, id, bugFoldedTargets);
      }
      counts.writeBug += 1;
      const bwr = writeBugQ.length ? writeBugQ.shift() : { ok: true };
      if (!bwr.ok) return { ok: false, phase: 'step2', step1Skipped: step1AlreadyDone, step1Ran, bugOf: null };
      // success -> leaveBugMode() clears the set + warning
      bugFoldedTargets.clear(); warningVisible = false; warningText = '';
      return { ok: true, phase: 'done', step1Skipped: step1AlreadyDone, step1Ran, bugOf: originalId };
    },
  };
  return world;
}

function bugEntryCount(md) {
  if (!md) return 0;
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l.trim() === BUG_REPORTS_HEADING);
  if (start === -1) return 0;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^## /.test(lines[i])) { end = i; break; }
  return (lines.slice(start, end).join('\n').match(/^### /gm) || []).length;
}

// ===========================================================================
// SCENARIO 1: Switch-back does not double-fold (edge)
// ===========================================================================
test('E2E Scenario: switch-back A->B->A does not double-fold A', () => {
  const id = 'TASK-050';
  // Given a bug-create session with new id "TASK-050" and A, B on the board
  const w = makeWorld().givenOriginalOnBoard('A', ORIGINAL_BODY).givenOriginalOnBoard('B', ORIGINAL_BODY);
  // And STEP 1 committed a fold into A (then STEP 2 failed)
  w.givenNextBugWriteFails('E-A');
  const a = w.whenCreateClicked({ originalId: 'A', id });
  assert.equal(a.phase, 'step2', 'STEP 1 folded A then STEP 2 failed');
  assert.ok(w.committedFolds().has(foldKey('A', id)), 'A fold committed for the session');

  // And the user switched the original select to B (STEP 2 failed)
  w.whenUserSelectsOriginal('B', id);
  w.givenNextBugWriteFails('E-B');
  const b = w.whenCreateClicked({ originalId: 'B', id });
  assert.equal(b.phase, 'step2', 'B folded then STEP 2 failed');

  // And then switched back to A
  w.whenUserSelectsOriginal('A', id);
  // When STEP 2 is retried and the original is A again
  w.givenNextBugWriteOk();
  const back = w.whenCreateClicked({ originalId: 'A', id });

  // Then original A has exactly ONE "## Bug Reports" entry naming TASK-050
  assert.equal(back.ok, true);
  assert.equal(back.step1Skipped, true, 'switch-back recognised A as already-folded -> STEP 1 skipped');
  assert.equal(w.bugReportEntryCount('A'), 1, 'A has EXACTLY ONE ## Bug Reports entry (no double-fold)');
  assert.equal(w.bugReportEntryCount('B'), 1, 'B has its single entry');
  assert.equal(w.counts.fold, 2, 'exactly two folds across the whole A->B->A cycle');
});

// ===========================================================================
// SCENARIO 2: Forward switch does not leave a silent dangling fold (edge)
// ===========================================================================
test('E2E Scenario: forward switch A->B warns and the new ticket carries bug-of B', () => {
  const id = 'TASK-050';
  // Given STEP 1 committed a fold into original A for new id TASK-050
  const w = makeWorld().givenOriginalOnBoard('A', ORIGINAL_BODY).givenOriginalOnBoard('B', ORIGINAL_BODY);
  w.givenNextBugWriteFails('E-A');
  w.whenCreateClicked({ originalId: 'A', id });
  assert.ok(w.committedFolds().has(foldKey('A', id)), 'A fold committed');

  // When the user switches the original to B
  w.whenUserSelectsOriginal('B', id);
  // Then the user is warned that A retains a stale fold (option b: warn, no auto-remove)
  assert.equal(w.warningVisible(), true, 'switching to B surfaces the non-blocking stale-fold warning');
  assert.match(w.warningText(), /Reported as TASK-050/, 'warning names the recorded bug id');

  // And STEP 2 succeeds against B
  w.givenNextBugWriteOk();
  const done = w.whenCreateClicked({ originalId: 'B', id });
  assert.equal(done.ok, true);

  // Then the new ticket TASK-050 carries bug-of: B
  assert.equal(done.bugOf, 'B', 'the created bug ticket is bug-of: B (the selected original)');
  // And A retains its one fold (dangling BY DESIGN — surfaced, not silent)
  assert.equal(w.bugReportEntryCount('A'), 1, 'A still advertises its one Reported-as entry (dangling by design, but the user was warned)');
  assert.equal(w.bugReportEntryCount('B'), 1, 'B folded exactly once');
  assert.equal(w.committedFolds().size, 0, 'success cleared the committed-fold set');
});

// ===========================================================================
// SCENARIO 3: Single-target retry still folds exactly once (regression)
// ===========================================================================
test('E2E Scenario: single-target retry still folds exactly once', () => {
  const id = 'TASK-050';
  // Given STEP 1 committed a fold into A and STEP 2 failed
  const w = makeWorld().givenOriginalOnBoard('A', ORIGINAL_BODY);
  w.givenNextBugWriteFails('EACCES');
  const first = w.whenCreateClicked({ originalId: 'A', id });
  assert.equal(first.phase, 'step2');

  // When STEP 2 is retried against A and succeeds
  w.givenNextBugWriteOk();
  const retry = w.whenCreateClicked({ originalId: 'A', id });

  // Then A has exactly one "## Bug Reports" entry
  assert.equal(retry.ok, true);
  assert.equal(retry.step1Skipped, true, 'same-target retry skips STEP 1 (TASK-038 behaviour preserved)');
  assert.equal(w.bugReportEntryCount('A'), 1, 'exactly one entry after the retry');
  assert.equal(w.counts.fold, 1, 'A folded once total');
});

// ===========================================================================
// SCENARIO 4 (edge): session reset clears all committed-fold tracking
// ===========================================================================
test('E2E Scenario: closing/re-opening the modal clears committed-fold tracking', () => {
  const id1 = 'TASK-050';
  const id2 = 'TASK-051';
  // Given a session where A was folded and STEP 2 failed
  const w = makeWorld().givenOriginalOnBoard('A', ORIGINAL_BODY);
  w.givenNextBugWriteFails('E1');
  w.whenCreateClicked({ originalId: 'A', id: id1 });
  assert.equal(w.committedFolds().size, 1, 'A fold held after STEP 2 failure');

  // When the user closes/cancels the modal (leaveBugMode) and re-opens fresh
  w.whenSessionResets();
  assert.equal(w.committedFolds().size, 0, 'reset cleared all committed-fold tracking');
  assert.equal(w.warningVisible(), false, 'reset cleared the switch warning');

  // And files a fresh bug against the SAME original A with a new id
  w.givenNextBugWriteOk();
  const second = w.whenCreateClicked({ originalId: 'A', id: id2 });

  // Then STEP 1 runs fresh and A gets a second, distinct fold
  assert.equal(second.ok, true);
  assert.equal(second.step1Ran, true, 'the new session re-runs STEP 1 (not treated as already-folded)');
  assert.equal(w.bugReportEntryCount('A'), 2, 'A carries two distinct entries across the two sessions');
});

// ===========================================================================
// SCENARIO 5 (failure path): STEP-1 write failure does not commit a fold key
// ===========================================================================
test('E2E Scenario (failure path): a STEP-1 write failure leaves nothing committed and the retry folds exactly once', () => {
  const id = 'TASK-050';
  const w = makeWorld().givenOriginalOnBoard('A', ORIGINAL_BODY);
  // Given the original write fails on the first attempt
  w.givenOriginalWriteFails('EACCES');
  const first = w.whenCreateClicked({ originalId: 'A', id });
  // Then no fold key is committed and no bug ticket is written
  assert.equal(first.phase, 'step1-write');
  assert.equal(w.committedFolds().size, 0, 'STEP-1 write failure did not commit a fold key');
  assert.equal(w.counts.writeBug, 0, 'no bug ticket written after a STEP-1 failure');
  // When the user retries and the write now succeeds
  w.givenNextBugWriteOk();
  const retry = w.whenCreateClicked({ originalId: 'A', id });
  assert.equal(retry.ok, true);
  assert.equal(retry.step1Ran, true, 'the retry re-runs STEP 1 (never committed)');
  assert.equal(w.bugReportEntryCount('A'), 1, 'exactly one entry — no accretion from the aborted fold');
});

// ===========================================================================
// SOURCE-SCAN drift guards — the fix cannot silently regress.
// ===========================================================================
const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');

test('SOURCE-SCAN: bugFoldedTargets is a session Set replacing the single-slot memo', () => {
  assert.match(RENDERER, /const\s+bugFoldedTargets\s*=\s*new Set\(\)/,
    'a `const bugFoldedTargets = new Set()` session collection must exist');
  assert.match(RENDERER, /const\s+foldKey\s*=\s*\(\s*origId\s*,\s*bugId\s*\)\s*=>/,
    'foldKey(origId, bugId) composite-key builder must exist');
});

test('SOURCE-SCAN: onCreateBug computes step1AlreadyDone via bugFoldedTargets.has(foldKey(originalId, id))', () => {
  assert.match(RENDERER, /const\s+key\s*=\s*foldKey\(\s*originalId\s*,\s*id\s*\)/,
    'onCreateBug must key on foldKey(originalId, id)');
  assert.match(RENDERER, /step1AlreadyDone\s*=\s*bugFoldedTargets\.has\(\s*key\s*\)/,
    'step1AlreadyDone must be derived from bugFoldedTargets.has(key)');
});

test('SOURCE-SCAN: STEP-1 success ADDS the key to bugFoldedTargets', () => {
  assert.match(RENDERER, /bugFoldedTargets\.add\(\s*key\s*\)/,
    'a committed STEP-1 fold must record its key via bugFoldedTargets.add(key)');
  // guarded by the !step1AlreadyDone block
  assert.match(RENDERER, /if\s*\(\s*!step1AlreadyDone\s*\)\s*\{/,
    'the STEP-1 body must be guarded by `if (!step1AlreadyDone)`');
});

test('SOURCE-SCAN: leaveBugMode clears the whole Set (session reset)', () => {
  assert.match(RENDERER, /bugFoldedTargets\.clear\(\)/,
    'leaveBugMode must clear all committed-fold tracking via bugFoldedTargets.clear()');
});

test('SOURCE-SCAN: STEP-2 failure branch does NOT clear the Set (retry skips STEP 1)', () => {
  // Isolate the STEP-2 failure branch text (the wr fail block) and assert it
  // does not contain a .clear() call — the set must survive for the retry.
  const idx = RENDERER.indexOf('Bug ticket create failed');
  assert.ok(idx !== -1, 'the STEP-2 failure error message must be present');
  const branch = RENDERER.slice(idx, idx + 400);
  assert.ok(!/bugFoldedTargets\.clear\(\)/.test(branch),
    'the STEP-2 failure branch must NOT clear bugFoldedTargets');
  assert.match(branch, /armCreate\(\)/, 'the STEP-2 failure branch re-arms Create for the retry');
});

test('SOURCE-SCAN: updateBugSwitchWarning exists and is wired to a change listener on .newtask-bug-of', () => {
  assert.match(RENDERER, /const\s+updateBugSwitchWarning\s*=\s*\(\)\s*=>/,
    'updateBugSwitchWarning function must exist');
  // TASK-044 extracted the persistent-listener wiring into the mirrored
  // attachBugSwitchWarning helper (lib/bug-switch-warning.js); the renderer now
  // wires the warning through it instead of an inline addEventListener call. The
  // helper is what binds the `change` listener and owns the stale-listener guard.
  assert.match(RENDERER, /attachBugSwitchWarning\(\s*bugOfSelect\s*,\s*updateBugSwitchWarning\s*\)/,
    'updateBugSwitchWarning must be wired via attachBugSwitchWarning (persistent change listener)');
  assert.match(RENDERER, /el\.addEventListener\(\s*'change'\s*,\s*handler\s*\)/,
    'the attach helper must bind a `change` listener');
  assert.match(RENDERER, /\.newtask-bug-of'/,
    'the warning must be wired against the .newtask-bug-of select');
  // persistent listener (NOT bindActionOnce which is once:true) with a stale guard
  assert.match(RENDERER, /_bugSwitchWarnHandler/,
    'a stale-listener guard (_bugSwitchWarnHandler) must be present for the persistent change listener');
});

test('SOURCE-SCAN: index.html has the .newtask-bug-warn element and it is queried in renderer', () => {
  assert.match(INDEX_HTML, /class="newtask-bug-warn[^"]*"/,
    'index.html must contain the .newtask-bug-warn warning element');
  assert.match(RENDERER, /querySelector\('\.newtask-bug-warn'\)/,
    'renderer must query the .newtask-bug-warn element');
});

test('SOURCE-SCAN: the old single-slot bugStep1Done memo is gone (superseded by the Set)', () => {
  assert.ok(!/bugStep1Done/.test(RENDERER),
    'the TASK-038 single-slot `bugStep1Done` memo must be fully replaced by the Set');
});
