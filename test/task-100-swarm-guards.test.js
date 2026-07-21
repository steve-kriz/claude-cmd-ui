'use strict';

// Unit tests for the TASK-100 swarm/user-status boundary guards in
// lib/ticket-queue.js. The module is pure (no disk/git/network/Electron/DB), so
// every function is exercised directly with plain `node --test`. No files are
// written and no DB/filesystem/Electron call is made by these tests.
//
// Coverage:
//   - SWARM_STATUSES: the exported, documented swarm-owned status set.
//   - isSwarmStatus / isUserStatus predicates (including the '' edge).
//   - the guard verdicts across claimTicket / canRunInParallel /
//     selectNextBatch / slotOccupancyCount for a user-defined status.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  SWARM_STATUSES,
  isSwarmStatus,
  isUserStatus,
  isClaimable,
  claimTicket,
  canRunInParallel,
  selectNextBatch,
  slotOccupancyCount,
} = require('../lib/ticket-queue');

const { VALID_STATUSES, POST_PROCESSING_KIND } = require('../lib/ticket-lanes');

// Ticket frontmatter factory returning a { fm } wrapper as the board stores them.
function T(id, status, extra) {
  return { fm: Object.assign({ id, status }, extra) };
}

// ── SWARM_STATUSES ───────────────────────────────────────────────────────────

test('SWARM_STATUSES names exactly the system-owned lifecycle + failed-testing set', () => {
  const expected = [
    'todo', 'defining', 'in-progress', 'testing', 'post-processing', 'done', 'failed-testing',
  ];
  // Same membership regardless of order.
  assert.deepEqual([...SWARM_STATUSES].sort(), [...expected].sort());
});

test('SWARM_STATUSES mirrors ticket-lanes VALID_STATUSES so the enums cannot drift', () => {
  assert.deepEqual([...SWARM_STATUSES].sort(), [...VALID_STATUSES].sort());
});

test('the claimable set is a strict subset of SWARM_STATUSES (never a user status)', () => {
  for (const s of ['todo', 'failed-testing']) {
    assert.ok(isClaimable(s), `${s} should be claimable`);
    assert.ok(SWARM_STATUSES.includes(s), `${s} should be swarm-owned`);
  }
});

// ── isSwarmStatus / isUserStatus ──────────────────────────────────────────────

test('isSwarmStatus is true for every swarm status and false for user statuses', () => {
  for (const s of SWARM_STATUSES) assert.equal(isSwarmStatus(s), true, s);
  assert.equal(isSwarmStatus('ux-review'), false);
  assert.equal(isSwarmStatus('blocked'), false);
  assert.equal(isSwarmStatus(''), false);
});

test('isUserStatus is true only for concrete out-of-enum slugs', () => {
  assert.equal(isUserStatus('ux-review'), true);
  assert.equal(isUserStatus('blocked'), true);
  assert.equal(isUserStatus('anything-else'), true);
});

test('isUserStatus is false for every swarm-owned status', () => {
  for (const s of SWARM_STATUSES) assert.equal(isUserStatus(s), false, s);
});

test("isUserStatus('') is false — empty/absent statuses are not user statuses", () => {
  assert.equal(isUserStatus(''), false);
  assert.equal(isUserStatus('   '), false);
  assert.equal(isUserStatus(null), false);
  assert.equal(isUserStatus(undefined), false);
});

// ── Guard verdicts: claimTicket ───────────────────────────────────────────────

test('claimTicket refuses a user-status ticket with reason not-claimable', () => {
  const res = claimTicket({ id: 'TASK-1', status: 'ux-review' }, 'agent-A');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'not-claimable');
});

test('claimTicket still grants a todo ticket (claimable set unchanged)', () => {
  const res = claimTicket({ id: 'TASK-1', status: 'todo' }, 'agent-A');
  assert.equal(res.ok, true);
  assert.equal(res.fm.status, 'in-progress');
  assert.equal(res.fm.agent, 'agent-A');
});

test('a user-status ticket ALSO claimed by a foreign agent reports claimed (precedence)', () => {
  const res = claimTicket({ id: 'TASK-1', status: 'ux-review', agent: 'other' }, 'agent-A');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'claimed');
});

// ── Guard verdicts: canRunInParallel ──────────────────────────────────────────

test('canRunInParallel on a user-status ticket returns ok:false reason not-claimable', () => {
  const res = canRunInParallel([], T('TASK-1', 'ux-review'), { limit: 3 });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'not-claimable');
});

test('canRunInParallel not-claimable verdict holds even with free slots available', () => {
  const res = canRunInParallel([], T('TASK-1', 'ux-review'), { limit: 3 });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'not-claimable');
  assert.equal(res.freeSlots, 3); // slots are free, ineligibility still wins
});

// ── Guard verdicts: selectNextBatch / slotOccupancyCount ──────────────────────

test('selectNextBatch never returns a user-status ticket', () => {
  const board = [
    T('TASK-1', 'ux-review'),
    T('TASK-2', 'ux-review'),
    T('TASK-3', 'todo'),
  ];
  const picked = selectNextBatch(board, { limit: 3 }).map((t) => t.fm.id);
  assert.deepEqual(picked, ['TASK-3']);
});

test('slotOccupancyCount ignores user statuses entirely', () => {
  const board = [
    T('TASK-1', 'ux-review'),
    T('TASK-2', 'ux-review'),
    T('TASK-3', 'in-progress'),
    T('TASK-4', 'testing'),
    T('TASK-5', 'defining'),
  ];
  // Only defining + in-progress + testing count = 3; ux-review adds nothing.
  assert.equal(slotOccupancyCount(board), 3);
});

// ── Post-processing KIND guard asserted WHERE IT ACTS (TASK-118) ──────────────
//
// The user-status tests above prove the STATUS boundary. These prove the KIND
// boundary: they hold the STATUS at a CLAIMABLE value ('todo') so the only field
// that can flip the verdict is `kind: post-processing`. Each kind ticket is
// paired with a kind-LESS control at the SAME status that IS granted/selected,
// so the field alone is shown to drive every refusal (and a future all-todo-
// unclaimable regression can't pass silently). `POST_PROCESSING_KIND` is imported
// from ../lib/ticket-lanes — no local constant.

test('claimTicket refuses a kind:post-processing ticket in a CLAIMABLE status (kind drives it, reason exactly post-processing)', () => {
  // Bare fm into claimTicket, per its calling convention.
  const res = claimTicket({ id: 'PP-1', status: 'todo', kind: POST_PROCESSING_KIND }, 'agent-A');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'post-processing'); // NOT 'not-claimable' — the kind guard, not the status
  // Not stamped in-progress and no agent recorded.
  assert.equal(res.fm.status, 'todo');
  assert.equal(res.fm.agent, undefined);

  // Kind-less control at the SAME status IS granted — proving the field flips it.
  const ctrl = claimTicket({ id: 'OK-1', status: 'todo' }, 'agent-A');
  assert.equal(ctrl.ok, true);
  assert.equal(ctrl.fm.status, 'in-progress');
  assert.equal(ctrl.fm.agent, 'agent-A');
});

test('canRunInParallel refuses a kind:post-processing ticket by KIND even with free slots (reason post-processing, not no-slots/not-claimable)', () => {
  const res = canRunInParallel([], T('PP-1', 'todo', { kind: POST_PROCESSING_KIND }), { limit: 3 });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'post-processing');
  assert.equal(res.freeSlots, 3); // slots are free — the kind, not capacity, refuses it

  // Kind-less control at the SAME status + empty board IS eligible.
  const ctrl = canRunInParallel([], T('OK-1', 'todo'), { limit: 3 });
  assert.equal(ctrl.ok, true);
  assert.equal(ctrl.reason, 'ok');
  assert.equal(ctrl.freeSlots, 3);
});

test('selectNextBatch never returns a kind:post-processing ticket in a claimable status, but does return the kind-less control', () => {
  const board = [
    T('PP-1', 'todo', { kind: POST_PROCESSING_KIND }), // claimable status, excluded by KIND
    T('TASK-3', 'todo'),                                // kind-less control — selected
  ];
  const picked = selectNextBatch(board, { limit: 3 }).map((t) => t.fm.id);
  assert.deepEqual(picked, ['TASK-3']); // free slots, yet PP-1 is never dispatched
});

test('KIND guard outranks the claimed verdict: kind:post-processing + foreign agent reports post-processing, not claimed', () => {
  // claimTicket: the kind guard sits above the isClaimed() check.
  const res = claimTicket({ id: 'PP-1', status: 'todo', kind: POST_PROCESSING_KIND, agent: 'other' }, 'agent-A');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'post-processing'); // NOT 'claimed'

  // canRunInParallel: same precedence.
  const par = canRunInParallel([], T('PP-1', 'todo', { kind: POST_PROCESSING_KIND, agent: 'other' }), { limit: 3 });
  assert.equal(par.ok, false);
  assert.equal(par.reason, 'post-processing'); // NOT 'claimed'
});
