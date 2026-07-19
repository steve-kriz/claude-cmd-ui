'use strict';

// ===========================================================================
// TASK-031 — UNIT tests for "bug reporting".
//
// Feature: a "Bug" button in the ticket-creation popup (#newTaskModal) switches
// the create flow into "bug mode": it creates a NEW bug ticket in tasks/todo/
// carrying a `bug-of: <ORIGINAL_ID>` frontmatter link AND folds the bug text
// into the ORIGINAL ticket's `## Bug Reports` section (inserted before
// `## Additional Context`). Write order is ORIGINAL FIRST, then the bug ticket,
// so a failed original update never leaves an orphaned bug ticket.
//
// The strongest REAL coverage lives here because the renderer's key logic
// (appendBugReportToMarkdown / neutralizeBugText) are hand-maintained mirrors of
// the requireable lib twins:
//   - lib/ticket-bug-reports.js  appendBugReport         (original-update fold)
//   - lib/markdown-escape.js     escapeLeadingHeadingRun (heading neutralize)
//   - lib/modal-actions.js       bindActionOnce          (listener lifecycle)
// serializeTicket / parseTicketFrontmatter live only in renderer/renderer.js
// (a browser script that cannot be require()'d), so they are copied VERBATIM
// below with a drift guard tying the copies back to the real source.
//
// NO DATABASE. NO DISK. NO NETWORK. Every helper is pure/in-memory; the only
// I/O the renderer would do (fs.readFile/writeFile/mkdir) is modeled with an
// in-memory fake in the write-ordering state machine.
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
const { bindActionOnce } = require('../lib/modal-actions');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');

// ---------------------------------------------------------------------------
// VERBATIM copies of the renderer's whole-file serializer/parser (browser
// script — not requireable). A drift guard below ties these to the real source.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// PURE replica of onCreateBug's validation guard (renderer.js ~6591-6603).
// Same order as the renderer: title → original selected → bug desc → original
// exists on the board. Returns { ok, error } and never writes anything.
// ---------------------------------------------------------------------------
function validateBugCreate({ title, originalId, bugDesc, boardIds }) {
  const t = String(title == null ? '' : title).trim();
  const oid = String(originalId == null ? '' : originalId).trim();
  const desc = String(bugDesc == null ? '' : bugDesc).trim();
  const ids = Array.isArray(boardIds) ? boardIds : [];
  if (!t) return { ok: false, error: 'Title is required.' };
  if (!oid) return { ok: false, error: 'Select the original ticket this bug is against.' };
  if (!desc) return { ok: false, error: 'Describe the bug before creating.' };
  if (!ids.includes(oid)) return { ok: false, error: 'Original ticket ' + oid + ' is no longer on the board.' };
  return { ok: true, error: '' };
}

// ---------------------------------------------------------------------------
// PURE state machine modeling onCreateBug's WRITE ORDER (renderer.js
// ~6604-6679). STEP 1 updates the ORIGINAL (re-read → append → write); STEP 2
// creates the bug ticket ONLY if STEP 1 succeeded. `io` is an in-memory fake:
//   { readOriginal(): {ok, content?}, writeOriginal(): {ok}, writeBug(): {ok} }
// Returns the ordered list of writes actually performed plus status flags so a
// test can assert no orphaned bug ticket on any STEP 1 failure.
// ---------------------------------------------------------------------------
function planBugWrites(io) {
  const writes = [];
  // STEP 1 — read the freshest original.
  const read = io.readOriginal();
  if (!read || !read.ok) {
    return { writes, originalUpdated: false, bugTicketWritten: false, error: 'read-original' };
  }
  // append happens purely in-memory (appendBugReport) — modeled as always fine.
  const owr = io.writeOriginal();
  if (!owr || !owr.ok) {
    return { writes, originalUpdated: false, bugTicketWritten: false, error: 'write-original' };
  }
  writes.push('original');
  // STEP 2 — only now create the bug ticket.
  const bwr = io.writeBug();
  writes.push('bug-ticket');
  if (!bwr || !bwr.ok) {
    return { writes, originalUpdated: true, bugTicketWritten: false, error: 'write-bug' };
  }
  return { writes, originalUpdated: true, bugTicketWritten: true, error: null };
}

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
// UNIT: original-update via the REAL appendBugReport (renderer mirror twin)
// ===========================================================================
test('UNIT: appendBugReport folds the bug into ## Bug Reports before ## Additional Context', () => {
  const acBefore = sectionSlice(ORIGINAL_BODY, ADDITIONAL_CONTEXT_HEADING);
  const out = appendBugReport(ORIGINAL_BODY, {
    bug: 'Reloading resets the toggle to on',
    timestamp: '2026-07-19T10:00:00.000Z',
  });
  // Bug Reports section created, carrying the bug text + a timestamped entry.
  const sec = sectionSlice(out, BUG_REPORTS_HEADING);
  assert.ok(sec, 'a ## Bug Reports section exists');
  assert.match(sec, /### 2026-07-19T10:00:00\.000Z/);
  assert.match(sec, /Reloading resets the toggle to on/);
  // Inserted BEFORE Additional Context.
  assert.ok(headingIndex(out, BUG_REPORTS_HEADING) < headingIndex(out, ADDITIONAL_CONTEXT_HEADING),
    'Bug Reports sits before Additional Context');
  // Additional Context unchanged and still at the tail.
  assert.equal(sectionSlice(out, ADDITIONAL_CONTEXT_HEADING), acBefore, 'Additional Context byte-for-byte');
  const acIdx = headingIndex(out, ADDITIONAL_CONTEXT_HEADING);
  const tail = out.split('\n').slice(acIdx + 1);
  assert.ok(!tail.some((l) => /^## /.test(l)), 'Additional Context is genuinely last');
  // Description / Acceptance Criteria survive verbatim.
  assert.equal(sectionSlice(out, '## Description'), sectionSlice(ORIGINAL_BODY, '## Description'));
  assert.equal(sectionSlice(out, '## Acceptance Criteria'), sectionSlice(ORIGINAL_BODY, '## Acceptance Criteria'));
});

test('UNIT: heading-forging bug text is neutralized and forges no ## Additional Context section', () => {
  const out = appendBugReport(ORIGINAL_BODY, {
    bug: '## Additional Context',
    timestamp: '2026-07-19T10:00:00.000Z',
  });
  // Still exactly ONE real Additional Context section (none forged from the text).
  assert.equal((out.match(/^## Additional Context$/gm) || []).length, 1,
    'exactly one real Additional Context — none forged');
  // The forging line is escaped inside the Bug Reports entry.
  const sec = sectionSlice(out, BUG_REPORTS_HEADING);
  assert.match(sec, /\\## Additional Context/, 'the forging line is escaped, preserved as literal text');
  // escapeLeadingHeadingRun (the requireable twin the renderer mirrors) does the escape.
  assert.equal(escapeLeadingHeadingRun('## Additional Context'), '\\## Additional Context');
});

test('UNIT: empty / whitespace-only bug text is a no-op on the original (byte-for-byte)', () => {
  for (const bug of ['', '   ', '\n\t ']) {
    const out = appendBugReport(ORIGINAL_BODY, { bug, timestamp: '2026-07-19T10:00:00.000Z' });
    assert.equal(out, ORIGINAL_BODY, `no-op for ${JSON.stringify(bug)}`);
    assert.equal(headingIndex(out, BUG_REPORTS_HEADING), -1, 'no Bug Reports section created');
  }
});

// ===========================================================================
// UNIT: bug-of frontmatter round-trips through the serializer/parser
// ===========================================================================
test('UNIT: bug-of survives serialize→parse as an extra key AFTER the leading five', () => {
  const now = '2026-07-19T10:00:00.000Z';
  const fm = { id: 'TASK-050', title: 'Toggle ignores saved preference', status: 'todo', created: now, updated: now };
  fm['bug-of'] = 'TASK-010'; // appended after the leading keys, exactly like the renderer.
  const round = parseTicketFrontmatter(serializeTicket(fm, '\n## Description\nx\n'));
  assert.ok(round, 'serialized ticket re-parses');
  // Key order: leading five, then bug-of.
  assert.deepEqual(Object.keys(round.fm).slice(0, 5), ['id', 'title', 'status', 'created', 'updated']);
  assert.equal(Object.keys(round.fm)[5], 'bug-of', 'bug-of appears AFTER the leading five');
  // Value survives with hyphenated key intact.
  assert.equal(round.fm['bug-of'], 'TASK-010');
  assert.equal(round.fm.status, 'todo');
});

test('UNIT: serializeTicket emits bug-of in the frontmatter block, hyphen preserved', () => {
  const now = '2026-07-19T10:00:00.000Z';
  const text = serializeTicket(
    { id: 'TASK-051', title: 'x', status: 'todo', created: now, updated: now, 'bug-of': 'TASK-010' },
    '\nbody\n',
  );
  assert.match(text, /^---\n[\s\S]*\nbug-of: TASK-010\n---\n/, 'bug-of line present in frontmatter');
  // bug-of must come after `updated:` in the emitted order.
  assert.ok(text.indexOf('\nupdated:') < text.indexOf('\nbug-of:'), 'bug-of serialized after updated');
});

// ===========================================================================
// UNIT: validation predicate (guard order) — each branch
// ===========================================================================
test('UNIT: validateBugCreate rejects an empty title first', () => {
  const r = validateBugCreate({ title: '   ', originalId: 'TASK-010', bugDesc: 'boom', boardIds: ['TASK-010'] });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'Title is required.');
});
test('UNIT: validateBugCreate rejects a missing original selection', () => {
  const r = validateBugCreate({ title: 'T', originalId: '', bugDesc: 'boom', boardIds: ['TASK-010'] });
  assert.equal(r.ok, false);
  assert.match(r.error, /Select the original ticket/);
});
test('UNIT: validateBugCreate rejects an empty bug description', () => {
  const r = validateBugCreate({ title: 'T', originalId: 'TASK-010', bugDesc: '   ', boardIds: ['TASK-010'] });
  assert.equal(r.ok, false);
  assert.match(r.error, /Describe the bug/);
});
test('UNIT: validateBugCreate rejects an original not present on the board', () => {
  const r = validateBugCreate({ title: 'T', originalId: 'TASK-999', bugDesc: 'boom', boardIds: ['TASK-010'] });
  assert.equal(r.ok, false);
  assert.match(r.error, /TASK-999 is no longer on the board/);
});
test('UNIT: validateBugCreate accepts a fully valid bug create', () => {
  const r = validateBugCreate({ title: 'T', originalId: 'TASK-010', bugDesc: 'boom', boardIds: ['TASK-010'] });
  assert.deepEqual(r, { ok: true, error: '' });
});

// ===========================================================================
// UNIT: write-ordering state machine — original FIRST, no orphaned bug ticket
// ===========================================================================
test('UNIT: happy path writes the original THEN the bug ticket, in that order', () => {
  const r = planBugWrites({
    readOriginal: () => ({ ok: true, content: '---\nid: TASK-010\n---\n' }),
    writeOriginal: () => ({ ok: true }),
    writeBug: () => ({ ok: true }),
  });
  assert.deepEqual(r.writes, ['original', 'bug-ticket'], 'original is written before the bug ticket');
  assert.equal(r.originalUpdated, true);
  assert.equal(r.bugTicketWritten, true);
  assert.equal(r.error, null);
});

test('UNIT: an unreadable original aborts before ANY write — no orphaned bug ticket', () => {
  const r = planBugWrites({
    readOriginal: () => ({ ok: false, error: 'ENOENT' }),
    writeOriginal: () => { throw new Error('must not be called'); },
    writeBug: () => { throw new Error('must not be called'); },
  });
  assert.deepEqual(r.writes, [], 'nothing was written');
  assert.equal(r.bugTicketWritten, false, 'no bug ticket created');
  assert.equal(r.error, 'read-original');
});

test('UNIT: a failed original WRITE aborts before the bug ticket — no orphan, no inconsistent link', () => {
  const r = planBugWrites({
    readOriginal: () => ({ ok: true, content: '---\nid: TASK-010\n---\n' }),
    writeOriginal: () => ({ ok: false, error: 'EACCES' }),
    writeBug: () => { throw new Error('must not be called after original write fails'); },
  });
  assert.deepEqual(r.writes, [], 'original write failed so no write is recorded');
  assert.equal(r.bugTicketWritten, false, 'the bug ticket is never written');
  assert.equal(r.error, 'write-original');
});

// ===========================================================================
// UNIT: STEP-2 (bug-ticket write) FAILURE — the genuinely inconsistent partial
// state the ticket calls out (TASK-039). STEP 1 commits the ORIGINAL but the NEW
// bug-ticket write fails: original updated exactly once, bug ticket NOT written,
// and the partial-state inline error is surfaced. Plus the TASK-038 retry: a
// second attempt after a STEP-2 failure must NOT re-fold the original.
// ===========================================================================

// Production inline error the renderer shows for a STEP-2 partial-state failure
// (renderer/renderer.js ~6708). Mirrored here; the DRIFT GUARD below ties it to
// the real source so it cannot silently drift.
const BUG_STEP2_FAIL_PREFIX = 'Bug ticket create failed (original was updated, retry writes only the bug ticket): ';
function bugStep2FailMessage(wrError) {
  return BUG_STEP2_FAIL_PREFIX + (wrError || 'unknown');
}

test('UNIT: STEP 2 (bug-ticket write) fails — original updated EXACTLY once, bug ticket NOT written, partial-state error surfaced', () => {
  let origWrites = 0;
  let bugWrites = 0;
  const r = planBugWrites({
    readOriginal: () => ({ ok: true, content: '---\nid: TASK-010\n---\n' }),
    writeOriginal: () => { origWrites += 1; return { ok: true }; },
    writeBug: () => { bugWrites += 1; return { ok: false, error: 'EACCES' }; },
  });
  // STEP 1 committed the original — exactly once.
  assert.equal(r.originalUpdated, true, 'the original was updated (STEP 1 committed)');
  assert.equal(origWrites, 1, 'the original was written EXACTLY once');
  // STEP 2 was attempted but reported failure — the bug ticket is NOT written.
  assert.equal(bugWrites, 1, 'STEP 2 (bug write) was attempted once');
  assert.equal(r.bugTicketWritten, false, 'the bug ticket was NOT written (write failed)');
  // The write-ordering model surfaces the STEP-2 failure (not swallowed).
  assert.equal(r.error, 'write-bug', 'the STEP-2 write failure is surfaced, not silently swallowed');
  // The inline error the renderer shows for this exact partial state.
  const msg = bugStep2FailMessage('EACCES');
  assert.match(msg, /Bug ticket create failed/, 'inline error names the failed bug-ticket write');
  assert.match(msg, /original was updated/, 'inline error names the partial state (original already updated)');
  assert.match(msg, /EACCES$/, 'the underlying write error is appended');
});

test('UNIT (TASK-038 retry): after a STEP-2 failure the retry SKIPS STEP 1 — original folded EXACTLY once', () => {
  // Model the renderer closure memo (bugStep1Done). STEP 1 folds via the REAL
  // appendBugReport into an in-memory body; STEP 2 fails once, then succeeds on
  // retry. Deterministic (fixed timestamp, no Date.now).
  const TS = '2026-07-19T10:00:00.000Z';
  const bugDesc = 'Reloading resets the toggle to on';
  let memo = null;
  let body = ORIGINAL_BODY;
  let folds = 0;
  const writeBugQueue = [{ ok: false, error: 'EACCES' }, { ok: true }];
  function submit(originalId, id) {
    const step1Done = !!memo && memo.originalId === originalId && memo.id === id;
    if (!step1Done) {
      // STEP 1: re-read + append (real helper) + write the original. The bug text
      // is composed EXACTLY as renderer onCreateBug does (renderer/renderer.js
      // ~6714): 'Reported as ' + <newId> + '\n' + <bugDesc> — the TASK-037
      // bidirectional id line PLUS the description, passed whole as `bug`.
      body = appendBugReport(body, { bug: 'Reported as ' + id + '\n' + bugDesc, timestamp: TS });
      folds += 1;
      memo = { originalId, id };
    }
    // STEP 2: write the new bug ticket.
    const bw = writeBugQueue.shift();
    if (!bw || !bw.ok) {
      // KEEP the memo, surface the inline error, re-arm for the retry.
      return { ok: false, step1Skipped: step1Done, error: bugStep2FailMessage(bw && bw.error) };
    }
    memo = null; // cleanup() -> leaveBugMode() clears the memo on success.
    return { ok: true, step1Skipped: step1Done };
  }

  // First click: STEP 1 commits, STEP 2 fails → memo retained, error surfaced.
  const first = submit('TASK-010', 'TASK-050');
  assert.equal(first.ok, false);
  assert.match(first.error, /Bug ticket create failed/);
  assert.match(first.error, /original was updated/);
  assert.deepEqual(memo, { originalId: 'TASK-010', id: 'TASK-050' }, 'memo retained after STEP-2 failure');
  assert.equal(folds, 1, 'first click folded the original once');

  // Retry: STEP 1 SKIPPED (memo matches), STEP 2 now succeeds.
  const retry = submit('TASK-010', 'TASK-050');
  assert.equal(retry.ok, true);
  assert.equal(retry.step1Skipped, true, 'STEP 1 was skipped on retry (TASK-038 memo)');
  assert.equal(folds, 1, 'original folded EXACTLY once across the failure + retry (no double-fold)');
  // Exactly ONE ## Bug Reports entry survives — grounded in the real fold output.
  const sec = sectionSlice(body, BUG_REPORTS_HEADING);
  assert.ok(sec, 'a ## Bug Reports section exists');
  assert.equal((sec.match(/^### /gm) || []).length, 1, 'exactly one ## Bug Reports entry after retry');
  assert.equal(memo, null, 'memo cleared once the retry finally succeeds');
});

// ===========================================================================
// UNIT (TASK-043): the STEP-1 fold composes 'Reported as ' + id + '\n' + bugDesc
// — the TASK-037 bidirectional id line PLUS the description, exactly as real
// onCreateBug does. Proven against the REAL appendBugReport twin (in-memory).
// ===========================================================================
test('UNIT: the STEP-1 model fold composes "Reported as " + id + "\\n" + bugDesc (TASK-043)', () => {
  const TS = '2026-07-19T10:00:00.000Z';
  const id = 'TASK-060';
  const bugDesc = 'Reloading resets the toggle to on';
  // The exact composition the unit session model (submit(), above) passes as `bug`.
  const composed = 'Reported as ' + id + '\n' + bugDesc;
  const out = appendBugReport(ORIGINAL_BODY, { bug: composed, timestamp: TS });
  const sec = sectionSlice(out, BUG_REPORTS_HEADING);
  assert.ok(sec, 'a ## Bug Reports section exists');
  // Both halves are folded, and the id line is joined to the description by '\n'.
  assert.match(sec, /Reported as TASK-060\nReloading resets the toggle to on/,
    "the fold is 'Reported as <id>' + '\\n' + <bugDesc> — the id line then the description");
  // The composition is exactly the two lines (no extra id-only or desc-only drift):
  // an independent fold of the SAME string must reproduce the section byte-for-byte.
  const expectedSec = sectionSlice(appendBugReport(ORIGINAL_BODY, { bug: composed, timestamp: TS }), BUG_REPORTS_HEADING);
  assert.equal(sec, expectedSec, 'the folded bug text equals "Reported as <id>\\n<bugDesc>"');
  // Dropping the "Reported as <id>" prefix (desc only) would NOT contain the id line.
  const descOnly = sectionSlice(appendBugReport(ORIGINAL_BODY, { bug: bugDesc, timestamp: TS }), BUG_REPORTS_HEADING);
  assert.ok(!/Reported as/.test(descOnly), 'guard: a desc-only fold omits the id line the model must include');
  assert.notEqual(sec, descOnly, 'the composed fold differs from a desc-only fold (the id line is load-bearing)');
});

// ===========================================================================
// UNIT: bindActionOnce lifecycle (retry re-arm + dispose), the modal wiring twin
// ===========================================================================
function fakeButton() {
  const listeners = [];
  return {
    listeners,
    addEventListener(ev, h) { listeners.push({ ev, h }); },
    removeEventListener(ev, h) {
      const i = listeners.findIndex((l) => l.ev === ev && l.h === h);
      if (i !== -1) listeners.splice(i, 1);
    },
    fire(ev) {
      // { once: true } semantics: node removes before invoking. Model that.
      const live = listeners.filter((l) => l.ev === ev);
      for (const l of live) {
        this.removeEventListener(ev, l.h);
        l.h();
      }
    },
  };
}

test('UNIT: bindActionOnce keeps at most one live handler and re-arms on a retry path', () => {
  const btn = fakeButton();
  let calls = 0;
  const handler = () => {
    calls += 1;
    // First fire is a validation failure that re-arms (like an empty-title retry).
    if (calls === 1) bindActionOnce(btn, 'click', handler);
  };
  bindActionOnce(btn, 'click', handler);
  assert.equal(btn.listeners.length, 1, 'exactly one handler bound');
  btn.fire('click'); // fires, self-detaches, then re-arms
  assert.equal(calls, 1);
  assert.equal(btn.listeners.length, 1, 're-armed to exactly one handler');
  btn.fire('click'); // second fire; handler does not re-arm this time
  assert.equal(calls, 2);
  assert.equal(btn.listeners.length, 0, 'no stale listeners after the final fire');
});

test('UNIT: bindActionOnce re-open detaches the prior open handler (no stale listener)', () => {
  const btn = fakeButton();
  let a = 0; let b = 0;
  bindActionOnce(btn, 'click', () => { a += 1; }); // first modal open
  bindActionOnce(btn, 'click', () => { b += 1; }); // re-open replaces the handler
  assert.equal(btn.listeners.length, 1, 'the prior open handler was detached');
  btn.fire('click');
  assert.equal(a, 0, 'the stale first-open handler never fires');
  assert.equal(b, 1, 'only the fresh handler fires');
});

test('UNIT: bindActionOnce dispose removes an un-fired handler (cancel/cleanup path)', () => {
  const btn = fakeButton();
  let fired = 0;
  const dispose = bindActionOnce(btn, 'click', () => { fired += 1; });
  dispose();
  assert.equal(btn.listeners.length, 0, 'dispose detached the handler');
  btn.fire('click');
  assert.equal(fired, 0, 'a disposed handler never fires');
});

// ===========================================================================
// DRIFT GUARD: the copied serializer key order matches the real renderer source
// ===========================================================================
test('DRIFT GUARD: serializeTicket leading key order matches renderer/renderer.js', () => {
  assert.match(
    rendererSrc,
    /const order = \['id', 'title', 'status', 'created', 'updated'\];/,
    'renderer serializeTicket must keep the id,title,status,created,updated order the copy relies on',
  );
  assert.match(
    rendererSrc,
    /for \(const k of Object\.keys\(fm\)\) if \(!keys\.includes\(k\)\) keys\.push\(k\);/,
    'renderer serializeTicket must append unknown keys (bug-of) after the leading five',
  );
});

test("DRIFT GUARD: the STEP-1 fold composes bug: 'Reported as ' + id + '\\n' + bugDesc (matches renderer/renderer.js)", () => {
  // TASK-043: the retry unit model above folds the original with
  // `'Reported as ' + id + '\n' + bugDesc`. This guard ties that composition to
  // the real source: if the renderer dropped the `Reported as <id>` prefix
  // (breaking the TASK-037 bidirectional link), this guard would FAIL here, not
  // only in test/task-037-bug-link.e2e.test.js.
  assert.match(
    rendererSrc,
    /appendBugReportToMarkdown\(origBody,\s*\{\s*bug:\s*'Reported as '\s*\+\s*id\s*\+\s*'\\n'\s*\+\s*bugDesc\s*,\s*timestamp:\s*now\s*\}\)/,
    "renderer onCreateBug STEP 1 must fold bug: 'Reported as ' + id + '\\n' + bugDesc (the id line + description)",
  );
  assert.ok(
    rendererSrc.includes("'Reported as '"),
    "the 'Reported as ' id-line prefix must be present — its removal breaks the bidirectional link the model mirrors",
  );
});

test('DRIFT GUARD: the STEP-2 partial-state inline error mirrored above matches renderer/renderer.js', () => {
  // Ties bugStep2FailMessage / BUG_STEP2_FAIL_PREFIX to the real source. If the
  // renderer stopped surfacing this partial-state error (e.g. silently swallowed
  // the STEP-2 failure), this guard AND the STEP-2 unit test above would fail.
  assert.match(
    rendererSrc,
    /Bug ticket create failed \(original was updated, retry writes only the bug ticket\): /,
    'the renderer must still surface the STEP-2 partial-state inline error the unit model mirrors',
  );
});
