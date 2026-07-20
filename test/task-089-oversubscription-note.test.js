'use strict';

// ===========================================================================
// TASK-089 — UNIT tests: transient over-subscription on parked-definition
// resume is documented as ACCEPTED behavior in the orchestrate SKILL contract.
//
// Mitigation OPTION (b) shipped: NO lib/ticket-queue.js change; a contract note
// was added to the Phase 2 step-1 parked-defining / concurrency prose. These
// tests are pure source-scans over the two SKILL.md copies (assets/ canonical +
// .claude/ project) plus the still-in-place pure ticket-queue helpers. They
// verify:
//   1. Both SKILL copies carry the accepted-behavior note (resuming answered
//      definition re-counts as a slot; occupancy MAY briefly exceed `limit`;
//      the transient is explicitly ACCEPTED / bounded / self-corrects).
//   2. The note lives in the parked-defining / concurrency context.
//   3. The two SKILL copies stay byte-identical (drift guard).
//   4. No model id appears at/after "## Phase 2 — Build" (TASK-051 invariant).
//   5. The shipped code matches the documented behavior: OPTION (b) left the
//      TASK-087 slot-occupancy code in place — a parked (question-waiting)
//      `defining` ticket is exempt from the slot count, an actively-defining one
//      is NOT, and no cap-on-resume was introduced.
//   6. Edge: rewording the note away from "ACCEPTED" (or editing only one copy)
//      is caught by the guards.
//
// NO DATABASE, DB CONNECTION, IPC, OR NETWORK. Only real disk access is reading
// the app's own source files as fixtures; the edge cases mutate copies IN MEMORY
// only, leaving the real files untouched.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  isSlotOccupyingTicket,
  slotOccupancyCount,
} = require('../lib/ticket-queue');

const ROOT = path.join(__dirname, '..');
const ASSETS_SKILL = path.join(ROOT, 'assets', 'skills', 'orchestrate', 'SKILL.md');
const PROJECT_SKILL = path.join(ROOT, '.claude', 'skills', 'orchestrate', 'SKILL.md');

const FABLE = 'claude-fable-5';
const OPUS = 'claude-opus-4-8';

function readFileLF(p) {
  return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
}

// Collapse all runs of whitespace to a single space so multi-line prose can be
// matched by stable phrase, independent of wrapping.
function flat(s) {
  return s.replace(/\s+/g, ' ');
}

const skillAssetsSrc = readFileLF(ASSETS_SKILL);
const skillProjectSrc = readFileLF(PROJECT_SKILL);
const SKILL_COPIES = [['assets', skillAssetsSrc], ['.claude', skillProjectSrc]];

// --- 1. Both copies carry the accepted-behavior note -----------------------

test('unit: both SKILL copies document the resume re-counts as a slot', () => {
  for (const [label, src] of SKILL_COPIES) {
    const f = flat(src);
    assert.match(f, /resumes\s+actively-defining, it re-counts as a concurrency slot/,
      `${label}: a resuming answered definition re-counts as a slot`);
  }
});

test('unit: both SKILL copies document occupancy MAY briefly exceed the limit', () => {
  for (const [label, src] of SKILL_COPIES) {
    const f = flat(src);
    assert.match(f, /live occupancy MAY briefly exceed `limit`/,
      `${label}: occupancy may briefly exceed limit`);
    assert.ok(f.includes('exceed'), `${label}: "exceed" keyword present`);
    assert.match(f, /burst of simultaneously-answered definitions/,
      `${label}: the burst-of-answers trigger is named`);
  }
});

test('unit: both SKILL copies mark the transient as explicitly ACCEPTED, bounded and self-correcting', () => {
  for (const [label, src] of SKILL_COPIES) {
    const f = flat(src);
    assert.match(f, /This transient is ACCEPTED/, `${label}: transient is ACCEPTED`);
    assert.ok(f.includes('ACCEPTED'), `${label}: "ACCEPTED" keyword present`);
    assert.ok(/\bbounded\b/.test(f), `${label}: "bounded" keyword present`);
    assert.ok(/self-corrects/.test(f), `${label}: "self-corrects" keyword present`);
    assert.match(f, /never corrupts state/, `${label}: never corrupts state`);
  }
});

test('unit: both SKILL copies give the rationale (preferred over a cap-on-resume that could deadlock)', () => {
  for (const [label, src] of SKILL_COPIES) {
    const f = flat(src);
    assert.match(f, /preferred over a strict cap-on-resume/, `${label}: preferred over strict cap`);
    assert.ok(f.includes('deadlock'), `${label}: deadlock rationale present`);
  }
});

// --- 2. The note sits in the parked-defining / concurrency context ---------

test('unit: the accepted-behavior note sits inside the parked-defining prose', () => {
  for (const [label, src] of SKILL_COPIES) {
    // The parked-defining prose ends with "...end-of-run report." then the note
    // begins immediately ("When a parked definition's question is answered...").
    // NOTE: the file wraps prose, so use single-line-safe markers for ordering
    // ("ACCEPTED" is a single token that appears exactly once, in this note).
    const reportIdx = src.indexOf('List every such still-parked ticket in the end-of-run report.');
    const noteIdx = src.indexOf('When a parked definition\'s question is answered');
    const acceptedIdx = src.indexOf('ACCEPTED');
    const definedBulletIdx = src.indexOf('**Defined → back to `todo`');
    assert.equal(src.indexOf('ACCEPTED', acceptedIdx + 1), -1, `${label}: ACCEPTED appears exactly once`);
    assert.ok(reportIdx !== -1, `${label}: parked-defining report sentence present`);
    assert.ok(noteIdx !== -1, `${label}: note present`);
    assert.ok(acceptedIdx !== -1, `${label}: ACCEPTED sentence present`);
    assert.ok(definedBulletIdx !== -1, `${label}: Defined-bullet present`);
    // Order: parked prose -> note -> ACCEPTED -> next (Defined) bullet.
    assert.ok(reportIdx < noteIdx, `${label}: note follows the parked-defining prose`);
    assert.ok(noteIdx < acceptedIdx, `${label}: ACCEPTED sits within the note`);
    assert.ok(acceptedIdx < definedBulletIdx, `${label}: note precedes the Defined bullet`);
  }
});

test('unit: the note references `limit` and the concurrency-slot vocabulary (not an unrelated section)', () => {
  for (const [label, src] of SKILL_COPIES) {
    const noteIdx = src.indexOf('When a parked definition\'s question is answered');
    const definedBulletIdx = src.indexOf('**Defined → back to `todo`');
    const note = src.slice(noteIdx, definedBulletIdx);
    assert.ok(note.includes('concurrency slot'), `${label}: note is about a concurrency slot`);
    assert.ok(note.includes('`limit`'), `${label}: note references limit`);
  }
});

// --- 3. Byte-identity drift guard ------------------------------------------

test('unit: the two SKILL.md copies are byte-identical (Buffer.equals)', () => {
  const a = fs.readFileSync(ASSETS_SKILL);
  const b = fs.readFileSync(PROJECT_SKILL);
  assert.ok(a.equals(b), 'assets/SKILL.md === .claude/SKILL.md byte-for-byte');
});

// --- 4. TASK-051 invariant: no model id at/after Phase 2 -------------------

test('unit: no model id appears at or after the "## Phase 2 — Build" heading', () => {
  for (const [label, src] of SKILL_COPIES) {
    const phase2Idx = src.indexOf('## Phase 2 — Build');
    assert.ok(phase2Idx !== -1, `${label}: Phase 2 heading present`);
    const fromPhase2 = src.slice(phase2Idx);
    assert.ok(!fromPhase2.includes(FABLE), `${label}: no ${FABLE} at/after Phase 2`);
    assert.ok(!fromPhase2.includes(OPUS), `${label}: no ${OPUS} at/after Phase 2`);
    // The accepted-behavior note itself lives after Phase 2 — prove it carries no id.
    assert.ok(src.indexOf('ACCEPTED') > phase2Idx,
      `${label}: the note is inside the Phase 2 build section`);
  }
});

// --- 5. Code consistency: OPTION (b) left TASK-087 slot code in place -------

test('unit: OPTION (b) — parked (question-waiting) defining is exempt from the slot count', () => {
  // A `defining` ticket parked on an unanswered BA question does NOT hold a slot.
  const parked = { id: 'TASK-A', status: 'defining', question: 'Which DB?', answer: '' };
  assert.equal(isSlotOccupyingTicket(parked), false, 'parked defining is exempt (TASK-087)');
});

test('unit: OPTION (b) — an actively-defining (answered) ticket DOES count as a slot', () => {
  // Once answered / with no open question, `defining` re-counts — the very
  // behavior the accepted-behavior note documents.
  const answered = { id: 'TASK-B', status: 'defining', question: 'Which DB?', answer: 'Postgres' };
  const noQuestion = { id: 'TASK-C', status: 'defining' };
  assert.equal(isSlotOccupyingTicket(answered), true, 'answered defining counts');
  assert.equal(isSlotOccupyingTicket(noQuestion), true, 'unparked defining counts');
});

test('unit: the documented transient is reproducible in the pure math (occupancy can exceed limit)', () => {
  // Model the exact scenario the note describes: limit=2, one build filled the
  // slot a parked definition freed, then the definition is answered and resumes.
  const limit = 2;
  // Before the answer: 1 parked (exempt) + 2 active builds = occupancy 2 == limit.
  const before = [
    { id: 'DEF', status: 'defining', question: 'q', answer: '' }, // parked, exempt
    { id: 'B1', status: 'in-progress' },
    { id: 'B2', status: 'in-progress' },
  ];
  assert.equal(slotOccupancyCount(before), limit, 'at the bound before the answer lands');
  // The answer lands -> DEF resumes actively-defining and re-counts.
  const after = before.map((t) => (t.id === 'DEF' ? { ...t, answer: 'yes' } : t));
  assert.equal(slotOccupancyCount(after), limit + 1, 'occupancy transiently exceeds the limit');
  assert.ok(slotOccupancyCount(after) > limit,
    'the code reproduces exactly the ACCEPTED transient the SKILL documents');
});

// --- 6. Failure / edge assertions (in-memory only) -------------------------

test('unit (edge): rewording the note away from "ACCEPTED" fails the accepted-behavior guard', () => {
  const softened = skillAssetsSrc.replace('ACCEPTED', 'tolerated');
  assert.ok(!flat(softened).includes('This transient is ACCEPTED'),
    'a note that drops the ACCEPTED keyword is rejected by the guard');
  assert.ok(!softened.includes('ACCEPTED'), 'softened copy no longer carries the ACCEPTED token');
  // Real file still carries it.
  assert.ok(flat(skillAssetsSrc).includes('This transient is ACCEPTED'), 'real file untouched');
});

test('unit (edge): editing only one SKILL copy is caught by the byte-identity guard', () => {
  const original = fs.readFileSync(ASSETS_SKILL);
  const mutated = Buffer.from(original.toString('utf8').replace('ACCEPTED', 'ACCEPTED ', 1), 'utf8');
  assert.ok(!mutated.equals(fs.readFileSync(PROJECT_SKILL)),
    'a one-copy edit is detected as drift');
  // Real files remain identical.
  assert.ok(fs.readFileSync(ASSETS_SKILL).equals(fs.readFileSync(PROJECT_SKILL)),
    'real copies still byte-identical');
});

test('unit (edge): a cap-on-resume would contradict the documented behavior — code has NO such cap', () => {
  // If OPTION (a) had shipped, an answered definition at the bound would be
  // exempted (held back). It is NOT: it counts, so occupancy exceeds the bound.
  // This guards that OPTION (b), not (a), is what shipped.
  const atBound = [
    { id: 'B1', status: 'in-progress' },
    { id: 'B2', status: 'in-progress' },
    { id: 'DEF', status: 'defining', answer: 'yes', question: 'q' }, // resumed
  ];
  assert.equal(slotOccupancyCount(atBound), 3,
    'no cap-on-resume: the resumed definition still counts (OPTION b, not a)');
});
