'use strict';

// ===========================================================================
// TASK-089 — E2E (Gherkin, Given/When/Then) scenarios: answering a parked
// definition does not silently violate the concurrency contract; the bounded
// transient over-subscription is documented as ACCEPTED (mitigation OPTION b).
//
// These are scenario-style `node --test` cases (no `cucumber` package). They
// drive the REAL orchestrate SKILL.md source (both copies) as the contract
// under test and the REAL pure `lib/ticket-queue.js` slot math as the runtime
// behavior — proving the shipped code exhibits exactly the transient the
// contract documents as accepted.
//
// Feature (from TASK-089):
//   Answering a parked definition does not over-subscribe the concurrency bound
//
// NO DATABASE, DB CONNECTION, IPC, OR NETWORK. Only real disk access is reading
// the app's own SKILL.md files as fixtures. All "board" state is in-memory.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  slotOccupancyCount,
  isSlotOccupyingTicket,
  selectNextBatch,
} = require('../lib/ticket-queue');

const ROOT = path.join(__dirname, '..');
const ASSETS_SKILL = path.join(ROOT, 'assets', 'skills', 'orchestrate', 'SKILL.md');
const PROJECT_SKILL = path.join(ROOT, '.claude', 'skills', 'orchestrate', 'SKILL.md');

function readFileLF(p) {
  return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
}

function flat(s) {
  return s.replace(/\s+/g, ' ');
}

const skillAssetsSrc = readFileLF(ASSETS_SKILL);
const skillProjectSrc = readFileLF(PROJECT_SKILL);

// ---------------------------------------------------------------------------
// Scenario: Resuming an answered definition — the contract documents the
// bounded transient (accepted-behavior option chosen).
// ---------------------------------------------------------------------------

test('Scenario: the contract documents the bounded transient over-subscription as ACCEPTED', () => {
  // Given the orchestrate contract (both SKILL copies)
  for (const [label, src] of [['assets', skillAssetsSrc], ['.claude', skillProjectSrc]]) {
    const f = flat(src);
    // When a parked definition's question is answered and it resumes actively-defining
    assert.match(f, /When a parked definition's question is answered and it resumes actively-defining, it re-counts as a concurrency slot/,
      `${label}: Given/When the resume path is described`);
    // Then the contract states live occupancy MAY briefly exceed the limit ...
    assert.match(f, /live occupancy MAY briefly exceed `limit`/, `${label}: Then occupancy may exceed limit`);
    // And that this transient is explicitly ACCEPTED, bounded and self-correcting.
    assert.match(f, /This transient is ACCEPTED: it is bounded/, `${label}: And it is ACCEPTED + bounded`);
    assert.ok(f.includes('self-corrects'), `${label}: And it self-corrects`);
  }
});

// ---------------------------------------------------------------------------
// Scenario: The concurrency limit is reached (a build filled the slot a parked
// definition freed) — the runtime slot math matches the documented behavior.
// ---------------------------------------------------------------------------

test('Scenario: at the limit, answering a parked definition transiently exceeds the bound (as documented)', () => {
  const limit = 3;
  // Given the concurrency limit is reached — a build filled the slot a parked
  // definition had freed: 3 active builds + 1 parked (exempt) definition.
  const board = [
    { id: 'DEF', status: 'defining', question: 'Which store?', answer: '' }, // parked -> exempt
    { id: 'B1', status: 'in-progress' },
    { id: 'B2', status: 'in-progress' },
    { id: 'B3', status: 'in-progress' },
  ];
  assert.equal(isSlotOccupyingTicket(board[0]), false, 'the parked definition frees its slot');
  assert.equal(slotOccupancyCount(board), limit, 'occupancy sits exactly at the limit');

  // When the parked definition's question is answered (it resumes actively-defining)
  const resumed = board.map((t) => (t.id === 'DEF' ? { ...t, answer: 'Postgres' } : t));
  assert.equal(isSlotOccupyingTicket(resumed[0]), true, 'the resumed definition re-counts as a slot');

  // Then (accepted-behavior option) live slot occupancy briefly exceeds the limit,
  assert.equal(slotOccupancyCount(resumed), limit + 1, 'occupancy transiently exceeds the limit by one');
  assert.ok(slotOccupancyCount(resumed) > limit, 'the runtime reproduces the documented transient');
});

test('Scenario: the transient self-corrects — occupancy returns to <= limit as an in-flight build finishes', () => {
  const limit = 3;
  // Given occupancy is transiently over the bound after a resume.
  let board = [
    { id: 'DEF', status: 'defining', question: 'q', answer: 'yes' }, // resumed, counts
    { id: 'B1', status: 'in-progress' },
    { id: 'B2', status: 'in-progress' },
    { id: 'B3', status: 'in-progress' },
  ];
  assert.equal(slotOccupancyCount(board), limit + 1, 'starts over the bound');

  // When an in-flight build finishes (reaches a terminal state, e.g. done).
  board = board.map((t) => (t.id === 'B3' ? { ...t, status: 'done' } : t));

  // Then occupancy self-corrects back to within the limit — no manual cap needed.
  assert.equal(slotOccupancyCount(board), limit, 'self-corrected back to the bound');
  assert.ok(slotOccupancyCount(board) <= limit, 'the transient resolved itself');
});

test('Scenario: the transient never dispatches beyond the bound — selectNextBatch stays capped while over-subscribed', () => {
  const limit = 3;
  // Given occupancy is transiently at limit+1 after a resume, and there is more
  // ready todo work waiting.
  const board = [
    { file: 'DEF.md', fm: { id: 'DEF', status: 'defining', question: 'q', answer: 'yes' } },
    { file: 'B1.md', fm: { id: 'B1', status: 'in-progress' } },
    { file: 'B2.md', fm: { id: 'B2', status: 'in-progress' } },
    { file: 'B3.md', fm: { id: 'B3', status: 'in-progress' } },
    { file: 'T1.md', fm: { id: 'T1', status: 'todo', created: '2026-07-19T00:00:00.000Z' } },
  ];
  // When the orchestrator tries to top up the free slots.
  const batch = selectNextBatch(board, { limit });
  // Then NO new ticket is dispatched — the over-subscription is not compounded;
  // it only ever self-corrects, never grows via new dispatch.
  assert.deepEqual(batch, [], 'no top-up while occupancy is at/over the bound');
});

// ---------------------------------------------------------------------------
// Scenario: The TASK-087 stall fix is preserved — a parked-but-UNanswered
// definition still frees its slot (must not regress).
// ---------------------------------------------------------------------------

test('Scenario: a parked-but-unanswered definition still frees its slot (TASK-087 preserved)', () => {
  const limit = 3;
  // Given two active builds and one parked (unanswered) definition.
  const board = [
    { file: 'DEF.md', fm: { id: 'DEF', status: 'defining', question: 'q', answer: '' } },
    { file: 'B1.md', fm: { id: 'B1', status: 'in-progress' } },
    { file: 'B2.md', fm: { id: 'B2', status: 'in-progress' } },
    { file: 'T1.md', fm: { id: 'T1', status: 'todo', created: '2026-07-19T00:00:00.000Z' } },
  ];
  // Then the parked definition does not hold a slot: occupancy is 2, not 3.
  assert.equal(slotOccupancyCount(board.map((t) => t.fm)), 2, 'parked definition frees its slot');
  // And a ready todo ticket is dispatched into the free slot (no stall).
  const batch = selectNextBatch(board, { limit });
  assert.deepEqual(batch.map((t) => t.fm.id), ['T1'], 'ready work fills the freed slot');
});

// ---------------------------------------------------------------------------
// Scenario (failure/edge path): the contract must NOT silently drop the
// ACCEPTED rationale, and both copies must agree.
// ---------------------------------------------------------------------------

test('Scenario (edge): a contract that omits the ACCEPTED rationale fails the guard', () => {
  // Given a hypothetical edit that removes the accepted-behavior sentence.
  const stripped = skillAssetsSrc
    .split('\n')
    .filter((l) => !l.includes('ACCEPTED') && !l.includes('exceed'))
    .join('\n');
  // Then the accepted-behavior guard rejects it.
  assert.ok(!flat(stripped).includes('This transient is ACCEPTED'),
    'stripped contract fails the ACCEPTED presence check');
  assert.ok(!/live occupancy MAY briefly exceed/.test(flat(stripped)),
    'stripped contract fails the "exceed" presence check');
  // But the real shipped contract passes both.
  assert.ok(flat(skillAssetsSrc).includes('This transient is ACCEPTED'), 'real contract carries the rationale');
});

test('Scenario (edge): the two contract copies are byte-identical (single-copy edit is drift)', () => {
  // Given both shipped copies of the contract.
  const a = fs.readFileSync(ASSETS_SKILL);
  const b = fs.readFileSync(PROJECT_SKILL);
  // Then they are byte-for-byte identical.
  assert.ok(a.equals(b), 'assets/ and .claude/ SKILL.md are byte-identical');
  // And an in-memory single-copy edit would be detected as drift.
  const mutated = Buffer.from(a.toString('utf8').replace('ACCEPTED', 'accepted', 1), 'utf8');
  assert.ok(!mutated.equals(b), 'a one-copy wording change is caught as drift');
});
