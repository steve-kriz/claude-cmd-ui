'use strict';

// ===========================================================================
// TASK-042 — UNIT tests for the "multi-target switch double-fold / dangling
// fold" fix in onCreateBug (renderer/renderer.js, inside openNewTaskModal).
//
// Bug: TASK-038 added a SINGLE-SLOT session memo `bugStep1Done = { originalId,
// id }` so a same-target STEP-2 retry did not re-fold `## Bug Reports`. But the
// single slot only remembers the MOST-RECENT target. Across STEP-2 failures a
// user can switch the original-select A -> B -> A; on returning to A the memo
// holds B, so `step1AlreadyDone` is false and STEP 1 folds a SECOND entry into
// A (the exact duplicate-fold class TASK-038 exists to prevent, reached via a
// switch instead of a straight retry).
//
// Fix (TASK-042): replace the single slot with a session `Set` of committed
// fold keys `foldKey(originalId, id)`. STEP 1 runs only when the key is NOT in
// the set; on success it ADDS the key. So a switch-back A->B->A recognises A's
// key still present and SKIPS STEP 1 (no second fold). Same-target retry still
// skips (TASK-038 preserved). Forward-switch A->B with STEP-2 success against B
// leaves A's committed fold in place BY DESIGN (option b: warn, do not
// auto-reconcile) — a `shouldWarn` predicate surfaces the A-vs-B mismatch.
// STEP-2 success runs leaveBugMode() which `.clear()`s the whole set.
//
// These unit tests model the session as a PURE state machine faithfully
// mirroring the real control flow, and count actual append/write operations via
// mock counters to PROVE no duplicate. The STEP-1 fold uses the REAL requireable
// helper lib/ticket-bug-reports.js `appendBugReport`, so "exactly one entry"
// assertions are grounded in the production transform, not a stub.
//
// NO DATABASE. NO DISK. NO NETWORK. Every helper is pure/in-memory; the only
// I/O the renderer would do (fs.readFile/writeFile) is modeled with in-memory
// fakes. Determinism: fixed timestamps, no Date.now.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  appendBugReport,
  BUG_REPORTS_HEADING,
  ADDITIONAL_CONTEXT_HEADING,
} = require('../lib/ticket-bug-reports');

const TS = '2026-07-19T10:00:00.000Z';

// A canonical original ticket body carrying a user-owned `## Additional Context`.
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
// PURE, deterministic replica of onCreateBug's SESSION STATE MACHINE
// (renderer.js ~6653-6779) plus leaveBugMode()'s reset (~6544-6557).
//
// Faithful to the real control flow:
//   - validations first (title / originalId / bugDesc / original-on-board);
//   - key = foldKey(originalId, id);  step1AlreadyDone = set.has(key)
//   - STEP 1 executed ONLY if !step1AlreadyDone; on success it ADDS key to the
//     Set; on failure the key is NOT added (retry redoes STEP 1);
//   - STEP 2 success runs cleanup() -> leaveBugMode() -> set.clear(); on failure
//     the set is KEPT and the handler re-arms (retry writes only STEP 2);
//   - reset() models leaveBugMode() (open / cancel / toggle-off) clearing the set.
//
// The `bug-of` of the created ticket is recorded so the forward-switch scenario
// can assert the new ticket carries `bug-of: <selected original>`.
// ---------------------------------------------------------------------------
const foldKey = (origId, bugId) => origId + ' ' + bugId;

// Warning predicate mirroring updateBugSwitchWarning's core (renderer.js ~6518):
// true when the committed-fold Set contains a fold for an original DIFFERENT
// from the currently-selected one — i.e. a forward switch left a stale fold.
function shouldWarn(selectedOriginal, id, committedSet) {
  const currentKey = foldKey(selectedOriginal, id);
  for (const key of committedSet) {
    if (key !== currentKey) return true;
  }
  return false;
}

function makeBugCreateSession(io) {
  // `bugFoldedTargets` mirrors the renderer closure Set (renderer.js ~6507).
  const bugFoldedTargets = new Set();

  const session = {
    // leaveBugMode(): open / cancel / cleanup / toggle-off all clear the set.
    reset() {
      bugFoldedTargets.clear();
    },

    // Inspect the committed-fold set for assertions (not part of the real API).
    folds() {
      return new Set(bugFoldedTargets);
    },
    warnsFor(selectedOriginal, id) {
      return shouldWarn(selectedOriginal, id, bugFoldedTargets);
    },

    // One click of "Create" in bug mode. Returns a result object describing
    // exactly what happened, including whether STEP 1 was skipped and the
    // resulting bug ticket's `bug-of`.
    submit({ originalId, id, validations, step1Result, step2Result }) {
      // validations FIRST (title / original / desc / on-board). If invalid,
      // nothing is written and the set is untouched.
      if (validations && !validations.ok) {
        return { ok: false, phase: 'validation', error: validations.error, step1Skipped: false, step1Ran: false, step2Ran: false };
      }

      const key = foldKey(originalId, id);
      const step1AlreadyDone = bugFoldedTargets.has(key);

      let step1Ran = false;
      if (!step1AlreadyDone) {
        step1Ran = true;
        // STEP 1: re-read + append + write the original.
        const read = io.readOriginal(originalId);
        if (!read || !read.ok) {
          // STEP 1 read failure — key NOT added, retry redoes STEP 1.
          return { ok: false, phase: 'step1-read', error: read && read.error, step1Skipped: false, step1Ran, step2Ran: false };
        }
        // The real fold (production helper) — records ONE append per call.
        io.foldOriginal(originalId, id, { bug: 'Reported as ' + id + '\n' + (step1Result && step1Result.bugDesc || 'boom'), timestamp: TS });
        const owr = io.writeOriginal(originalId);
        if (!owr || !owr.ok) {
          // STEP 1 write failure — key NOT added, retry redoes STEP 1.
          return { ok: false, phase: 'step1-write', error: owr && owr.error, step1Skipped: false, step1Ran, step2Ran: false };
        }
        // STEP 1 committed — record this (originalId, id) fold (renderer.js ~6730).
        bugFoldedTargets.add(key);
      }

      // STEP 2: create the NEW bug ticket (carries bug-of: originalId).
      const bwr = io.writeBug(originalId, id);
      if (!bwr || !bwr.ok) {
        // STEP 2 failure — KEEP the set, re-arm, retry writes only STEP 2.
        return { ok: false, phase: 'step2', error: bwr && bwr.error, step1Skipped: step1AlreadyDone, step1Ran, step2Ran: true, bugOf: null };
      }
      // STEP 2 success — cleanup() -> leaveBugMode() clears the whole set.
      bugFoldedTargets.clear();
      return { ok: true, phase: 'done', error: null, step1Skipped: step1AlreadyDone, step1Ran, step2Ran: true, bugOf: originalId };
    },
  };
  return session;
}

// In-memory IO fake with mock counters. `bodies` holds the live COMMITTED
// markdown per originalId; foldOriginal uses the REAL appendBugReport so appends
// are genuine and countable. Outcomes for read/write are supplied per-call via
// queues so a scenario can make STEP 2 fail once then succeed.
function makeIO(opts) {
  const o = opts || {};
  const bodies = new Map();
  for (const [k, v] of Object.entries(o.bodies || {})) bodies.set(k, v);
  const pending = new Map();
  const counts = { foldOriginal: 0, writeOriginal: 0, writeBug: 0, readOriginal: 0 };
  const readQueue = (o.readResults || []).slice();
  const writeOrigQueue = (o.writeOriginalResults || []).slice();
  const writeBugQueue = (o.writeBugResults || []).slice();

  return {
    counts,
    bodies,
    readOriginal(originalId) {
      counts.readOriginal += 1;
      return readQueue.length ? readQueue.shift() : { ok: true };
    },
    foldOriginal(originalId, id, entry) {
      counts.foldOriginal += 1;
      const before = bodies.has(originalId) ? bodies.get(originalId) : ORIGINAL_BODY;
      pending.set(originalId, appendBugReport(before, entry));
    },
    writeOriginal(originalId) {
      counts.writeOriginal += 1;
      const res = writeOrigQueue.length ? writeOrigQueue.shift() : { ok: true };
      if (res && res.ok && pending.has(originalId)) bodies.set(originalId, pending.get(originalId));
      pending.delete(originalId);
      return res;
    },
    writeBug(originalId, id) {
      counts.writeBug += 1;
      return writeBugQueue.length ? writeBugQueue.shift() : { ok: true };
    },
  };
}

function sectionSlice(md, heading) {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^## /.test(lines[i])) { end = i; break; }
  return lines.slice(start, end).join('\n');
}
function bugReportEntryCount(md) {
  const sec = sectionSlice(md, BUG_REPORTS_HEADING);
  if (!sec) return 0;
  return (sec.match(/^### /gm) || []).length;
}

// ===========================================================================
// UNIT: SWITCH-BACK A -> B -> A does NOT double-fold A (the core TASK-042 fix)
// ===========================================================================
test('UNIT (switch-back): A->B->A folds A EXACTLY once (no second ## Bug Reports entry)', () => {
  const io = makeIO({
    bodies: { A: ORIGINAL_BODY, B: ORIGINAL_BODY },
    // Every STEP-2 write fails until the final A retry succeeds.
    writeBugResults: [
      { ok: false, error: 'E-A1' }, // submit A -> STEP2 fail
      { ok: false, error: 'E-B1' }, // submit B -> STEP2 fail
      { ok: true },                 // submit A again -> STEP2 ok
    ],
  });
  const s = makeBugCreateSession(io);
  const id = 'TASK-050';

  // File a bug targeting A: STEP 1 folds A, STEP 2 fails; A's key kept.
  const a1 = s.submit({ originalId: 'A', id, validations: { ok: true } });
  assert.equal(a1.phase, 'step2');
  assert.ok(s.folds().has(foldKey('A', id)), 'A key committed after its STEP-1 fold');

  // Switch to B: STEP 1 folds B, STEP 2 fails; both A and B keys held.
  const b1 = s.submit({ originalId: 'B', id, validations: { ok: true } });
  assert.equal(b1.phase, 'step2');
  assert.ok(s.folds().has(foldKey('B', id)), 'B key committed');
  assert.ok(s.folds().has(foldKey('A', id)), 'A key STILL present after switching to B (Set remembers every target)');

  // Switch BACK to A and retry: A's key is still in the Set -> STEP 1 SKIPPED.
  const a2 = s.submit({ originalId: 'A', id, validations: { ok: true } });
  assert.equal(a2.ok, true);
  assert.equal(a2.step1Skipped, true, 'switch-back recognised A as already-folded');
  assert.equal(a2.step1Ran, false, 'STEP 1 did NOT run on the switch-back');

  // PROOF: A folded exactly once despite A->B->A; B folded once.
  assert.equal(bugReportEntryCount(io.bodies.get('A')), 1, 'A has EXACTLY ONE ## Bug Reports entry (no double-fold)');
  assert.equal(bugReportEntryCount(io.bodies.get('B')), 1, 'B has its one entry');
  assert.equal(io.counts.foldOriginal, 2, 'exactly two folds total: one per distinct original');
});

// The pre-fix single-slot memo would have double-folded A here — assert that
// the Set-of-keys is what saves us, via the committed-fold-set membership.
test('UNIT (switch-back membership): A key survives the excursion to B so STEP 1 is skipped on return', () => {
  const io = makeIO({
    bodies: { A: ORIGINAL_BODY, B: ORIGINAL_BODY },
    writeBugResults: [{ ok: false, error: 'e' }, { ok: false, error: 'e' }, { ok: false, error: 'e' }],
  });
  const s = makeBugCreateSession(io);
  const id = 'TASK-050';
  s.submit({ originalId: 'A', id, validations: { ok: true } });
  s.submit({ originalId: 'B', id, validations: { ok: true } });
  const back = s.submit({ originalId: 'A', id, validations: { ok: true } }); // STEP2 fails again
  assert.equal(back.step1Skipped, true, 'A already folded — STEP 1 skipped even though STEP 2 fails again');
  assert.equal(io.counts.foldOriginal, 2, 'still only two folds after the full A->B->A cycle');
  assert.equal(bugReportEntryCount(io.bodies.get('A')), 1);
});

// ===========================================================================
// UNIT: FORWARD SWITCH A -> B with STEP-2 success against B (option b: warn)
// ===========================================================================
test('UNIT (forward switch): commit A, switch to B, STEP-2 ok against B -> new ticket bug-of B, A dangles by design, warning fires', () => {
  const io = makeIO({
    bodies: { A: ORIGINAL_BODY, B: ORIGINAL_BODY },
    writeBugResults: [{ ok: false, error: 'E-A' }, { ok: true }], // A STEP2 fail, B STEP2 ok
  });
  const s = makeBugCreateSession(io);
  const id = 'TASK-050';

  // STEP 1 commits a fold into A; STEP 2 fails.
  s.submit({ originalId: 'A', id, validations: { ok: true } });
  assert.ok(s.folds().has(foldKey('A', id)), 'A fold committed');

  // While selection is still A, no cross-target warning (only-same-original).
  assert.equal(s.warnsFor('A', id), false, 'no warning while the selection matches the only committed fold');
  // User switches the select to B: the committed A fold is now stale vs B.
  assert.equal(s.warnsFor('B', id), true, 'switching to B surfaces the stale-A-fold warning');

  // Create against B succeeds.
  const done = s.submit({ originalId: 'B', id, validations: { ok: true } });
  assert.equal(done.ok, true);
  assert.equal(done.bugOf, 'B', 'the new bug ticket carries bug-of: B (the selected original)');

  // A retains its one committed fold (dangling, BY DESIGN — option b warns, does
  // not auto-remove). B got folded once too.
  assert.equal(bugReportEntryCount(io.bodies.get('A')), 1, 'A still carries its one Reported-as entry (dangling by design)');
  assert.equal(bugReportEntryCount(io.bodies.get('B')), 1, 'B folded exactly once');
  // STEP-2 success cleared the whole session set.
  assert.equal(s.folds().size, 0, 'success (leaveBugMode) cleared the committed-fold set');
});

// ===========================================================================
// UNIT: SINGLE-TARGET RETRY still folds exactly once (TASK-038 regression)
// ===========================================================================
test('UNIT (single-target retry): STEP-2 fail then retry ok against A -> A folded EXACTLY once', () => {
  const io = makeIO({
    bodies: { A: ORIGINAL_BODY },
    writeBugResults: [{ ok: false, error: 'EACCES' }, { ok: true }],
  });
  const s = makeBugCreateSession(io);
  const id = 'TASK-050';
  const args = { originalId: 'A', id, validations: { ok: true } };

  const first = s.submit(args);
  assert.equal(first.phase, 'step2');
  assert.equal(io.counts.foldOriginal, 1, 'first click folded once');

  const retry = s.submit(args);
  assert.equal(retry.ok, true);
  assert.equal(retry.step1Skipped, true, 'same-target retry skips STEP 1 (TASK-038 preserved)');
  assert.equal(io.counts.foldOriginal, 1, 'A folded EXACTLY once across the retry');
  assert.equal(io.counts.writeBug, 2, 'bug write attempted twice (fail then ok)');
  assert.equal(bugReportEntryCount(io.bodies.get('A')), 1, 'exactly one ## Bug Reports entry after retry');
});

// ===========================================================================
// UNIT: HAPPY PATH single create — one fold, one bug write, set cleared
// ===========================================================================
test('UNIT (happy path): one create folds ONE entry, writes ONE bug ticket, clears the set', () => {
  const io = makeIO({ bodies: { A: ORIGINAL_BODY } });
  const s = makeBugCreateSession(io);
  const r = s.submit({ originalId: 'A', id: 'TASK-050', validations: { ok: true }, step1Result: { bugDesc: 'crash on save' } });
  assert.equal(r.ok, true);
  assert.equal(r.bugOf, 'A');
  assert.equal(io.counts.foldOriginal, 1);
  assert.equal(io.counts.writeBug, 1);
  assert.equal(bugReportEntryCount(io.bodies.get('A')), 1, 'exactly one ## Bug Reports entry');
  assert.equal(s.folds().size, 0, 'set cleared after a successful create');
});

// ===========================================================================
// UNIT: SESSION RESET between two creates against the SAME original -> two folds
// ===========================================================================
test('UNIT (reset between sessions): re-open clears tracking so a same-original second create folds a fresh entry', () => {
  const io = makeIO({ bodies: { A: ORIGINAL_BODY } });
  const s = makeBugCreateSession(io);

  const first = s.submit({ originalId: 'A', id: 'TASK-050', validations: { ok: true } });
  assert.equal(first.ok, true);
  assert.equal(s.folds().size, 0, 'set cleared after success');

  // Modal close/cancel/re-open -> reset() (leaveBugMode). New, different bug.
  s.reset();
  const second = s.submit({ originalId: 'A', id: 'TASK-051', validations: { ok: true } });
  assert.equal(second.ok, true);
  assert.equal(second.step1Ran, true, 'STEP 1 runs fresh for the new session');
  assert.equal(io.counts.foldOriginal, 2, 'two folds total — one per genuine session');
  assert.equal(bugReportEntryCount(io.bodies.get('A')), 2, 'A carries TWO distinct entries across two sessions');
});

// Cancel after a STEP-2 failure must clear the set so a later fresh attempt is
// NOT treated as an already-folded skip.
test('UNIT (reset after STEP-2 fail): cancel clears the set so a later attempt re-runs STEP 1', () => {
  const io = makeIO({
    bodies: { A: ORIGINAL_BODY },
    writeBugResults: [{ ok: false, error: 'E1' }, { ok: true }],
  });
  const s = makeBugCreateSession(io);
  s.submit({ originalId: 'A', id: 'TASK-050', validations: { ok: true } }); // STEP 2 fails, key kept
  assert.equal(s.folds().size, 1, 'key held after STEP 2 failure');
  s.reset(); // user cancels / closes the modal
  assert.equal(s.folds().size, 0, 'cancel/close cleared the committed-fold set');
  const later = s.submit({ originalId: 'A', id: 'TASK-050', validations: { ok: true } });
  assert.equal(later.step1Ran, true, 'STEP 1 runs again — prior session state was cleared');
});

// ===========================================================================
// UNIT: STEP-1 failure leaves the key UNSET so a retry redoes STEP 1
// ===========================================================================
test('UNIT (STEP-1 write fails): a failed original write does NOT add the key; retry redoes STEP 1 cleanly', () => {
  const io = makeIO({
    bodies: { A: ORIGINAL_BODY },
    writeOriginalResults: [{ ok: false, error: 'EACCES' }, { ok: true }],
  });
  const s = makeBugCreateSession(io);
  const id = 'TASK-050';
  const args = { originalId: 'A', id, validations: { ok: true } };

  const first = s.submit(args);
  assert.equal(first.phase, 'step1-write');
  assert.equal(s.folds().has(foldKey('A', id)), false, 'STEP-1 write failure did NOT add the key');
  assert.equal(io.counts.writeBug, 0, 'no bug ticket written when STEP 1 fails');

  const retry = s.submit(args);
  assert.equal(retry.ok, true);
  assert.equal(retry.step1Ran, true, 'retry redoes STEP 1 (never committed)');
  // Aborted STEP 1 left nothing committed; retry re-reads pristine A and folds once.
  assert.equal(bugReportEntryCount(io.bodies.get('A')), 1, 'exactly one entry — no accretion from the aborted fold');
});

test('UNIT (STEP-1 read fails): an unreadable original does NOT add the key and writes nothing', () => {
  const io = makeIO({
    bodies: { A: ORIGINAL_BODY },
    readResults: [{ ok: false, error: 'ENOENT' }, { ok: true }],
  });
  const s = makeBugCreateSession(io);
  const id = 'TASK-050';
  const args = { originalId: 'A', id, validations: { ok: true } };
  const first = s.submit(args);
  assert.equal(first.phase, 'step1-read');
  assert.equal(s.folds().has(foldKey('A', id)), false, 'read failure left the key unset');
  assert.equal(io.counts.foldOriginal, 0);
  assert.equal(io.counts.writeBug, 0);
  const retry = s.submit(args);
  assert.equal(retry.ok, true, 'retry reads cleanly and completes');
  assert.equal(retry.step1Ran, true);
});

// ===========================================================================
// UNIT: VALIDATION failure writes nothing and never touches the set
// ===========================================================================
test('UNIT (validation): a validation failure writes nothing and leaves the committed-fold set untouched', () => {
  const io = makeIO({ bodies: { A: ORIGINAL_BODY } });
  const s = makeBugCreateSession(io);
  const r = s.submit({ originalId: 'A', id: 'TASK-050', validations: { ok: false, error: 'Title is required.' } });
  assert.equal(r.phase, 'validation');
  assert.equal(io.counts.foldOriginal, 0);
  assert.equal(io.counts.writeBug, 0);
  assert.equal(s.folds().size, 0, 'set untouched by a validation failure');
});

// ===========================================================================
// UNIT: shouldWarn predicate — the forward-switch warning condition
// ===========================================================================
test('UNIT (shouldWarn): true only when a committed fold exists for a DIFFERENT original than selected', () => {
  const id = 'TASK-050';
  const empty = new Set();
  assert.equal(shouldWarn('A', id, empty), false, 'empty set -> no warning');

  const onlyA = new Set([foldKey('A', id)]);
  assert.equal(shouldWarn('A', id, onlyA), false, 'selection matches the only committed fold -> no warning');
  assert.equal(shouldWarn('B', id, onlyA), true, 'selected B but A is folded -> warn about the stale A fold');

  const aAndB = new Set([foldKey('A', id), foldKey('B', id)]);
  assert.equal(shouldWarn('B', id, aAndB), true, 'A is still a stale fold while B is selected -> warn');
  assert.equal(shouldWarn('C', id, aAndB), true, 'neither committed fold matches selected C -> warn');
});

// ===========================================================================
// GROUNDING: the REAL helper proves the dedup must come from the SESSION SET.
// One appendBugReport = ONE entry; TWO calls = TWO entries. So without the
// Set-guard the switch-back WOULD duplicate A's entry.
// ===========================================================================
test('UNIT (helper grounding): one appendBugReport = ONE entry; two calls = TWO entries', () => {
  const once = appendBugReport(ORIGINAL_BODY, { bug: 'Reported as TASK-050\ncrash', timestamp: TS });
  assert.equal(bugReportEntryCount(once), 1);
  assert.ok(once.indexOf(BUG_REPORTS_HEADING) < once.indexOf(ADDITIONAL_CONTEXT_HEADING),
    'Bug Reports sits before user-owned Additional Context');
  const twice = appendBugReport(once, { bug: 'Reported as TASK-050\ncrash', timestamp: TS });
  assert.equal(bugReportEntryCount(twice), 2,
    'the helper is NOT idempotent: a repeat fold WOULD duplicate — proving the Set-guard is load-bearing');
});
