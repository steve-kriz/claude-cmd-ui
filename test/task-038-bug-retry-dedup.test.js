'use strict';

// ===========================================================================
// TASK-038 — UNIT tests for "bug create retry duplicate-fold" fix.
//
// Bug: in onCreateBug (renderer/renderer.js, inside openNewTaskModal), when
// STEP 1 (fold the report into the ORIGINAL) succeeds but STEP 2 (write the new
// bug ticket) fails, the handler shows an inline error and re-arms WITHOUT
// clearing session state. On retry the old code re-ran STEP 1 unconditionally,
// folding a SECOND identical `## Bug Reports` entry into the original.
//
// Fix (approach a — session-scoped memo): a closure var `bugStep1Done` holds
// `{ originalId, id }` once STEP 1 commits. On retry onCreateBug computes
// `step1AlreadyDone` (keyed on BOTH originalId AND id) and SKIPS STEP 1 when it
// matches, re-attempting only STEP 2. STEP 1 failure leaves the memo unset (so a
// retry redoes STEP 1). STEP 2 success runs cleanup() which calls leaveBugMode()
// which resets the memo. leaveBugMode() also runs on open/cancel/toggle-off, so
// a fresh session against the same original folds a fresh entry.
//
// These unit tests model the session state machine as a PURE class that mirrors
// the real control flow, and count actual append/write operations via mock
// counters to PROVE no duplicate. They ALSO ground the "exactly one entry"
// assertion in the REAL requireable helper lib/ticket-bug-reports.js so the
// dedup is shown to come from the SESSION GUARD, not from the helper.
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
// (renderer.js ~6603-6721) plus leaveBugMode()'s memo reset (~6498-6509).
//
// This faithfully reproduces the real control flow:
//   - validations first (title / originalId / bugDesc / original-on-board);
//   - step1AlreadyDone = memo && memo.originalId === originalId && memo.id === id
//   - STEP 1 executed ONLY if !step1AlreadyDone; on success it sets the memo to
//     { originalId, id }; on failure the memo is left untouched (retry redoes it);
//   - STEP 2 on success runs cleanup() -> leaveBugMode() -> memo = null; on
//     failure the memo is KEPT and the handler re-arms (retry writes only STEP 2);
//   - reset() models leaveBugMode() (open / cancel / toggle-off) clearing memo.
//
// The `io` fake supplies STEP-1 and STEP-2 outcomes AND records every real
// side-effect so tests can COUNT appends/writes and prove no duplicate. STEP 1's
// original-fold is performed with the REAL appendBugReport helper against an
// in-memory copy of the original body, so "exactly one entry" is grounded in the
// production transform, not a stub.
// ---------------------------------------------------------------------------
function makeBugCreateSession(io) {
  // `bugStep1Done` mirrors the renderer closure var.
  let bugStep1Done = null;

  const session = {
    // leaveBugMode(): open / cancel / cleanup / toggle-off all reset the memo.
    reset() {
      bugStep1Done = null;
    },

    // Inspect the memo for assertions (not part of the real API).
    memo() {
      return bugStep1Done;
    },

    // One click of "Create" in bug mode. Returns a result object describing
    // exactly what happened, including whether STEP 1 was skipped.
    submit({ originalId, id, validations, step1Result, step2Result }) {
      // ── validations FIRST (title / original / desc / on-board). If invalid,
      // nothing is written and the memo is untouched.
      if (validations && !validations.ok) {
        return { ok: false, phase: 'validation', error: validations.error, step1Skipped: false, step1Ran: false, step2Ran: false };
      }

      // step1AlreadyDone keyed on BOTH originalId AND id (renderer.js ~6632).
      const step1AlreadyDone = !!bugStep1Done
        && bugStep1Done.originalId === originalId
        && bugStep1Done.id === id;

      let step1Ran = false;
      if (!step1AlreadyDone) {
        step1Ran = true;
        // STEP 1: re-read + append + write the original.
        const read = io.readOriginal(originalId);
        if (!read || !read.ok) {
          // STEP 1 read failure — memo NOT set, retry redoes STEP 1.
          return { ok: false, phase: 'step1-read', error: read && read.error, step1Skipped: false, step1Ran, step2Ran: false };
        }
        // The real fold (production helper) — records ONE append per call.
        io.foldOriginal(originalId, id, { bug: 'Reported as ' + id + '\n' + (step1Result && step1Result.bugDesc || 'boom'), timestamp: TS });
        const owr = io.writeOriginal(originalId);
        if (!owr || !owr.ok) {
          // STEP 1 write failure — memo NOT set, retry redoes STEP 1.
          return { ok: false, phase: 'step1-write', error: owr && owr.error, step1Skipped: false, step1Ran, step2Ran: false };
        }
        // STEP 1 committed — memo it (renderer.js ~6675).
        bugStep1Done = { originalId, id };
      }

      // ── STEP 2: create the NEW bug ticket.
      const bwr = io.writeBug(originalId, id);
      if (!bwr || !bwr.ok) {
        // STEP 2 failure — KEEP the memo, re-arm, retry writes only STEP 2.
        return { ok: false, phase: 'step2', error: bwr && bwr.error, step1Skipped: step1AlreadyDone, step1Ran, step2Ran: true };
      }
      // STEP 2 success — cleanup() -> leaveBugMode() resets the memo.
      bugStep1Done = null;
      return { ok: true, phase: 'done', error: null, step1Skipped: step1AlreadyDone, step1Ran, step2Ran: true };
    },
  };
  return session;
}

// In-memory IO fake with mock counters. `original` holds the live markdown for
// each originalId; foldOriginal uses the REAL appendBugReport so appends are
// genuine. Outcomes for read/write are supplied per-call via a queue so a
// scenario can make STEP 2 fail once then succeed.
function makeIO(opts) {
  const o = opts || {};
  const bodies = new Map(); // originalId -> COMMITTED markdown (only mutated on a successful write)
  for (const [k, v] of Object.entries(o.bodies || {})) bodies.set(k, v);
  const pending = new Map(); // originalId -> folded-but-not-yet-committed markdown
  const counts = { foldOriginal: 0, writeOriginal: 0, writeBug: 0, readOriginal: 0 };
  const readQueue = (o.readResults || []).slice();
  const writeOrigQueue = (o.writeOriginalResults || []).slice();
  const writeBugQueue = (o.writeBugResults || []).slice();

  return {
    counts,
    bodies,
    // Re-read the FRESHEST committed original (mirrors the renderer re-read).
    readOriginal(originalId) {
      counts.readOriginal += 1;
      return readQueue.length ? readQueue.shift() : { ok: true };
    },
    // Fold a COPY of the freshest committed body; stash as pending. Uses the REAL
    // appendBugReport so the entry is genuine. Does NOT commit until writeOriginal.
    foldOriginal(originalId, id, entry) {
      counts.foldOriginal += 1;
      const before = bodies.has(originalId) ? bodies.get(originalId) : ORIGINAL_BODY;
      pending.set(originalId, appendBugReport(before, entry));
    },
    // Commit the pending fold ONLY on a successful write (matches the renderer:
    // originalTicket.body is updated after fs.writeFile returns ok).
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
// UNIT: happy path — STEP 1 ok + STEP 2 ok → one append, one bug write, memo cleared
// ===========================================================================
test('UNIT (happy path): one create folds ONE entry, writes ONE bug ticket, clears the memo', () => {
  const io = makeIO({ bodies: { 'TASK-010': ORIGINAL_BODY } });
  const s = makeBugCreateSession(io);

  const r = s.submit({ originalId: 'TASK-010', id: 'TASK-050', validations: { ok: true }, step1Result: { bugDesc: 'crash on save' } });

  assert.equal(r.ok, true);
  assert.equal(io.counts.foldOriginal, 1, 'original folded exactly once');
  assert.equal(io.counts.writeOriginal, 1, 'original written exactly once');
  assert.equal(io.counts.writeBug, 1, 'bug ticket written exactly once');
  assert.equal(bugReportEntryCount(io.bodies.get('TASK-010')), 1, 'exactly one ## Bug Reports entry');
  assert.equal(s.memo(), null, 'memo cleared after a successful create');
});

// ===========================================================================
// UNIT: STEP 1 ok, STEP 2 fail, retry STEP 2 ok → ONE append, ONE bug write (the fix)
// ===========================================================================
test('UNIT (retry): STEP 2 fails then retry succeeds — original folded EXACTLY once', () => {
  const io = makeIO({
    bodies: { 'TASK-010': ORIGINAL_BODY },
    writeBugResults: [{ ok: false, error: 'EACCES' }, { ok: true }], // fail then succeed
  });
  const s = makeBugCreateSession(io);
  const args = { originalId: 'TASK-010', id: 'TASK-050', validations: { ok: true }, step1Result: { bugDesc: 'crash on save' } };

  // First click: STEP 1 commits, STEP 2 fails → memo kept.
  const first = s.submit(args);
  assert.equal(first.ok, false);
  assert.equal(first.phase, 'step2');
  assert.deepEqual(s.memo(), { originalId: 'TASK-010', id: 'TASK-050' }, 'memo retained after STEP 2 failure');
  assert.equal(io.counts.foldOriginal, 1, 'first click folded once');

  // Retry: STEP 1 SKIPPED, STEP 2 now succeeds.
  const retry = s.submit(args);
  assert.equal(retry.ok, true);
  assert.equal(retry.step1Skipped, true, 'STEP 1 was skipped on retry');
  assert.equal(retry.step1Ran, false, 'STEP 1 code path did not run on retry');

  // PROOF: original folded/written only ONCE across both clicks; bug written twice (fail+ok).
  assert.equal(io.counts.foldOriginal, 1, 'original folded EXACTLY once despite the retry');
  assert.equal(io.counts.writeOriginal, 1, 'original written EXACTLY once');
  assert.equal(io.counts.writeBug, 2, 'bug write attempted twice (fail then ok)');
  assert.equal(bugReportEntryCount(io.bodies.get('TASK-010')), 1, 'exactly one ## Bug Reports entry after retry');
  assert.equal(s.memo(), null, 'memo cleared once the retry finally succeeds');
});

// ===========================================================================
// UNIT: STEP 2 fail, retry with SAME target → STEP 1 skipped (no second append)
// ===========================================================================
test('UNIT (retry same target): repeated STEP-2 failures never re-fold the original', () => {
  const io = makeIO({
    bodies: { 'TASK-010': ORIGINAL_BODY },
    writeBugResults: [{ ok: false, error: 'E1' }, { ok: false, error: 'E2' }, { ok: false, error: 'E3' }],
  });
  const s = makeBugCreateSession(io);
  const args = { originalId: 'TASK-010', id: 'TASK-050', validations: { ok: true } };

  s.submit(args); // STEP 1 commits, STEP 2 fails
  s.submit(args); // STEP 1 skipped, STEP 2 fails again
  s.submit(args); // STEP 1 skipped, STEP 2 fails again

  assert.equal(io.counts.foldOriginal, 1, 'folded ONCE across three STEP-2 failures');
  assert.equal(io.counts.writeOriginal, 1, 'original written ONCE');
  assert.equal(io.counts.writeBug, 3, 'bug write attempted on each retry');
  assert.equal(bugReportEntryCount(io.bodies.get('TASK-010')), 1, 'still exactly one entry');
});

// ===========================================================================
// UNIT: STEP 2 fail, user SWITCHES originalId before retry → STEP 1 runs fresh
// ===========================================================================
test('UNIT (switch target): switching the original between retries reruns STEP 1 for the new target', () => {
  const io = makeIO({
    bodies: { 'TASK-010': ORIGINAL_BODY, 'TASK-011': ORIGINAL_BODY },
    writeBugResults: [{ ok: false, error: 'E1' }, { ok: true }],
  });
  const s = makeBugCreateSession(io);

  // First click targets TASK-010: STEP 1 commits for TASK-010, STEP 2 fails.
  s.submit({ originalId: 'TASK-010', id: 'TASK-050', validations: { ok: true } });
  assert.deepEqual(s.memo(), { originalId: 'TASK-010', id: 'TASK-050' });

  // User switches the selected original to TASK-011 then clicks again.
  const retry = s.submit({ originalId: 'TASK-011', id: 'TASK-050', validations: { ok: true } });
  assert.equal(retry.ok, true);
  assert.equal(retry.step1Skipped, false, 'memo does NOT match the new target — STEP 1 runs fresh');
  assert.equal(retry.step1Ran, true, 'STEP 1 executed for the new target');

  assert.equal(io.counts.foldOriginal, 2, 'each distinct original folded once');
  assert.equal(bugReportEntryCount(io.bodies.get('TASK-010')), 1, 'TASK-010 has its one entry');
  assert.equal(bugReportEntryCount(io.bodies.get('TASK-011')), 1, 'TASK-011 gets a fresh entry');
});

// Also key on `id` — same original, different new bug id should re-run STEP 1.
test('UNIT (switch id): a different new bug id against the same original reruns STEP 1', () => {
  const io = makeIO({
    bodies: { 'TASK-010': ORIGINAL_BODY },
    writeBugResults: [{ ok: false, error: 'E1' }, { ok: true }],
  });
  const s = makeBugCreateSession(io);

  s.submit({ originalId: 'TASK-010', id: 'TASK-050', validations: { ok: true } }); // STEP 2 fails
  const retry = s.submit({ originalId: 'TASK-010', id: 'TASK-051', validations: { ok: true } }); // different id
  assert.equal(retry.step1Skipped, false, 'memo keyed on id too — mismatched id reruns STEP 1');
  assert.equal(io.counts.foldOriginal, 2, 'STEP 1 ran for each distinct new-bug id');
});

// ===========================================================================
// UNIT: STEP 1 fails → memo unset, retry redoes STEP 1 cleanly
// ===========================================================================
test('UNIT (STEP 1 fails): a failed original write leaves the memo unset and retry redoes STEP 1', () => {
  const io = makeIO({
    bodies: { 'TASK-010': ORIGINAL_BODY },
    writeOriginalResults: [{ ok: false, error: 'EACCES' }, { ok: true }],
  });
  const s = makeBugCreateSession(io);
  const args = { originalId: 'TASK-010', id: 'TASK-050', validations: { ok: true } };

  const first = s.submit(args);
  assert.equal(first.ok, false);
  assert.equal(first.phase, 'step1-write');
  assert.equal(s.memo(), null, 'STEP 1 failure leaves the memo unset');
  assert.equal(io.counts.writeBug, 0, 'no bug ticket written when STEP 1 fails');

  const retry = s.submit(args);
  assert.equal(retry.ok, true);
  assert.equal(retry.step1Ran, true, 'retry redoes STEP 1 (it was never committed)');
  assert.equal(io.counts.writeOriginal, 2, 'original write attempted twice (fail then ok)');
  // The first fold was never committed (write failed); the retry re-reads the
  // still-pristine original and folds fresh, committing on the successful write.
  // So the committed body carries EXACTLY ONE entry — no accretion from the abort.
  assert.equal(bugReportEntryCount(io.bodies.get('TASK-010')), 1,
    'the aborted STEP 1 left nothing committed; the retry produces exactly one entry');
});

// STEP 1 read failure keeps the memo unset too.
test('UNIT (STEP 1 read fails): an unreadable original leaves the memo unset, writes nothing', () => {
  const io = makeIO({
    bodies: { 'TASK-010': ORIGINAL_BODY },
    readResults: [{ ok: false, error: 'ENOENT' }, { ok: true }],
  });
  const s = makeBugCreateSession(io);
  const args = { originalId: 'TASK-010', id: 'TASK-050', validations: { ok: true } };

  const first = s.submit(args);
  assert.equal(first.ok, false);
  assert.equal(first.phase, 'step1-read');
  assert.equal(s.memo(), null, 'read failure leaves the memo unset');
  assert.equal(io.counts.foldOriginal, 0, 'no fold happened');
  assert.equal(io.counts.writeOriginal, 0, 'no original write');
  assert.equal(io.counts.writeBug, 0, 'no bug ticket write');

  const retry = s.submit(args);
  assert.equal(retry.ok, true, 'retry now reads cleanly and completes');
  assert.equal(retry.step1Ran, true, 'STEP 1 redone on retry');
});

// ===========================================================================
// UNIT: reset()/cleanup between two SUCCESSFUL creates → both fold a fresh entry
// ===========================================================================
test('UNIT (reset between creates): a fresh session against the same original folds a second, fresh entry', () => {
  const io = makeIO({ bodies: { 'TASK-010': ORIGINAL_BODY } });
  const s = makeBugCreateSession(io);

  // First bug filed successfully (cleanup clears the memo internally on success).
  const first = s.submit({ originalId: 'TASK-010', id: 'TASK-050', validations: { ok: true } });
  assert.equal(first.ok, true);
  assert.equal(s.memo(), null, 'memo cleared after success');

  // Modal re-open / new session -> reset() (leaveBugMode). Second, different bug.
  s.reset();
  const second = s.submit({ originalId: 'TASK-010', id: 'TASK-051', validations: { ok: true } });
  assert.equal(second.ok, true);
  assert.equal(second.step1Ran, true, 'STEP 1 runs fresh for the new session');

  assert.equal(io.counts.foldOriginal, 2, 'two folds total — one per genuine bug');
  assert.equal(bugReportEntryCount(io.bodies.get('TASK-010')), 2, 'TASK-010 carries TWO distinct entries');
});

// Cancel (reset) after a STEP-2 failure clears the memo so a later fresh attempt
// is NOT treated as a duplicate.
test('UNIT (cancel after STEP-2 fail): reset() clears the memo so a later attempt is not a duplicate-skip', () => {
  const io = makeIO({
    bodies: { 'TASK-010': ORIGINAL_BODY },
    writeBugResults: [{ ok: false, error: 'E1' }, { ok: true }],
  });
  const s = makeBugCreateSession(io);

  s.submit({ originalId: 'TASK-010', id: 'TASK-050', validations: { ok: true } }); // STEP 2 fails, memo kept
  assert.ok(s.memo(), 'memo held after STEP 2 failure');
  s.reset(); // user cancels / closes the modal
  assert.equal(s.memo(), null, 'cancel/close cleared the memo');

  // A later fresh attempt (new session) must NOT skip STEP 1.
  const later = s.submit({ originalId: 'TASK-010', id: 'TASK-050', validations: { ok: true } });
  assert.equal(later.step1Ran, true, 'STEP 1 runs — the prior session state was cleared');
});

// ===========================================================================
// UNIT: validation failure → nothing written, memo unset
// ===========================================================================
test('UNIT (validation): a validation failure writes nothing and never touches the memo', () => {
  const io = makeIO({ bodies: { 'TASK-010': ORIGINAL_BODY } });
  const s = makeBugCreateSession(io);

  const r = s.submit({ originalId: 'TASK-010', id: 'TASK-050', validations: { ok: false, error: 'Title is required.' } });
  assert.equal(r.ok, false);
  assert.equal(r.phase, 'validation');
  assert.equal(io.counts.foldOriginal, 0, 'no fold on validation failure');
  assert.equal(io.counts.writeOriginal, 0, 'no original write');
  assert.equal(io.counts.writeBug, 0, 'no bug write');
  assert.equal(s.memo(), null, 'memo untouched by a validation failure');
});

// A validation failure AFTER STEP 1 committed (edge) must not skip cleanup of memo
// on a later successful session — modeled: memo held, then reset, then success.
test('UNIT (validation after commit): a bad retry input does not corrupt the memo or the fold count', () => {
  const io = makeIO({
    bodies: { 'TASK-010': ORIGINAL_BODY },
    writeBugResults: [{ ok: false, error: 'E1' }],
  });
  const s = makeBugCreateSession(io);

  s.submit({ originalId: 'TASK-010', id: 'TASK-050', validations: { ok: true } }); // STEP 2 fails, memo kept
  // User clears the title then clicks: validation fails, nothing changes.
  const bad = s.submit({ originalId: 'TASK-010', id: 'TASK-050', validations: { ok: false, error: 'Title is required.' } });
  assert.equal(bad.phase, 'validation');
  assert.deepEqual(s.memo(), { originalId: 'TASK-010', id: 'TASK-050' }, 'memo unchanged by a validation-failed retry');
  assert.equal(io.counts.foldOriginal, 1, 'no extra fold from the failed-validation click');
});

// ===========================================================================
// GROUNDING: the REAL helper proves the dedup must come from the SESSION GUARD.
// A single appendBugReport yields ONE entry; TWO calls yield TWO entries. So if
// the session guard did NOT skip STEP 1, the original WOULD carry a duplicate.
// ===========================================================================
test('UNIT (helper grounding): one appendBugReport = ONE entry; two calls = TWO entries', () => {
  const once = appendBugReport(ORIGINAL_BODY, { bug: 'Reported as TASK-050\ncrash on save', timestamp: TS });
  assert.equal(bugReportEntryCount(once), 1, 'a single fold yields exactly one ## Bug Reports entry');
  assert.ok(once.indexOf(BUG_REPORTS_HEADING) < once.indexOf(ADDITIONAL_CONTEXT_HEADING),
    'Bug Reports sits before the user-owned Additional Context');

  // Folding the SAME entry twice (what the OLD buggy retry did) yields TWO entries —
  // the helper is NOT idempotent, so the fix MUST be the session guard.
  const twice = appendBugReport(once, { bug: 'Reported as TASK-050\ncrash on save', timestamp: TS });
  assert.equal(bugReportEntryCount(twice), 2,
    'the helper is not idempotent: a repeat fold WOULD duplicate — proving the guard is load-bearing');
});
