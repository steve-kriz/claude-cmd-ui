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

const { VALID_STATUSES } = require('../lib/ticket-lanes');

// TASK-206 removed the kind:post-processing concept entirely — there is no
// longer a POST_PROCESSING_KIND export. A leftover `kind: post-processing`
// frontmatter key is just an arbitrary, ignored string now (see the guard
// section at the bottom of this file).
const LEGACY_POST_PROCESSING_KIND = 'post-processing';

// Ticket frontmatter factory returning a { fm } wrapper as the board stores them.
function T(id, status, extra) {
  return { fm: Object.assign({ id, status }, extra) };
}

// ── SWARM_STATUSES ───────────────────────────────────────────────────────────

test('SWARM_STATUSES names exactly the system-owned lifecycle + failed-testing set', () => {
  const expected = [
    'todo', 'defining', 'in-progress', 'testing', 'done', 'failed-testing',
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

// ── Legacy kind:post-processing is now IGNORED — treated purely by status
// (TASK-206) ───────────────────────────────────────────────────────────────
//
// TASK-118 originally added a KIND-based guard that force-excluded a
// kind:post-processing ticket regardless of its status. TASK-206 removed the
// whole post-processing concept: a leftover `kind: post-processing` frontmatter
// key on disk (from before the removal) now round-trips as an ordinary, ignored
// unknown field — it must NOT be force-excluded from claiming/parallel-running/
// selection, and no guard may ever report a 'post-processing' reason again. Each
// kind-carrying ticket is paired with a kind-less control at the SAME status to
// prove the two behave identically (the field truly does nothing).

test('claimTicket treats a leftover kind:post-processing ticket purely by its status (claimable, no post-processing reason)', () => {
  const res = claimTicket({ id: 'PP-1', status: 'todo', kind: LEGACY_POST_PROCESSING_KIND }, 'agent-A');
  assert.equal(res.ok, true, 'a todo ticket is claimable regardless of a leftover kind key');
  assert.equal(res.fm.status, 'in-progress');
  assert.equal(res.fm.agent, 'agent-A');
  assert.notEqual(res.reason, 'post-processing', 'no post-processing reason is ever returned');

  // Kind-less control at the SAME status behaves identically.
  const ctrl = claimTicket({ id: 'OK-1', status: 'todo' }, 'agent-A');
  assert.equal(ctrl.ok, true);
  assert.equal(ctrl.fm.status, 'in-progress');
  assert.equal(ctrl.fm.agent, 'agent-A');
});

test('canRunInParallel treats a leftover kind:post-processing ticket purely by its status (ok, no post-processing reason)', () => {
  const res = canRunInParallel([], T('PP-1', 'todo', { kind: LEGACY_POST_PROCESSING_KIND }), { limit: 3 });
  assert.equal(res.ok, true, 'a todo ticket with a leftover kind key is eligible');
  assert.equal(res.reason, 'ok');
  assert.equal(res.freeSlots, 3);

  // Kind-less control at the SAME status behaves identically.
  const ctrl = canRunInParallel([], T('OK-1', 'todo'), { limit: 3 });
  assert.equal(ctrl.ok, true);
  assert.equal(ctrl.reason, 'ok');
  assert.equal(ctrl.freeSlots, 3);
});

test('selectNextBatch returns a leftover kind:post-processing ticket in a claimable status just like its kind-less control', () => {
  const board = [
    T('PP-1', 'todo', { kind: LEGACY_POST_PROCESSING_KIND }), // claimable status, kind no longer excludes it
    T('TASK-3', 'todo'),                                       // kind-less control
  ];
  const picked = selectNextBatch(board, { limit: 3 }).map((t) => t.fm.id);
  assert.deepEqual(picked.sort(), ['PP-1', 'TASK-3'], 'both dispatch — the leftover kind key is inert');
});

test('a leftover kind:post-processing ticket claimed by a foreign agent still reports claimed (kind is inert; status precedence unchanged)', () => {
  // claimTicket: the (now-removed) kind guard no longer sits above isClaimed().
  const res = claimTicket({ id: 'PP-1', status: 'todo', kind: LEGACY_POST_PROCESSING_KIND, agent: 'other' }, 'agent-A');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'claimed');
  assert.notEqual(res.reason, 'post-processing');

  // canRunInParallel: same precedence.
  const par = canRunInParallel([], T('PP-1', 'todo', { kind: LEGACY_POST_PROCESSING_KIND, agent: 'other' }), { limit: 3 });
  assert.equal(par.ok, false);
  assert.equal(par.reason, 'claimed');
  assert.notEqual(par.reason, 'post-processing');
});
