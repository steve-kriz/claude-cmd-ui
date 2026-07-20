'use strict';

// ===========================================================================
// TASK-079 Part C — UNIT tests for the REAL lib/ticket-queue.js slot-occupancy
// helpers: a `defining` ticket now counts against the --concurrency bound
// (free slots = limit - (in-progress + testing + defining)) WITHOUT changing
// isActive/ACTIVE_STATUSES semantics (the board's "being worked on" dot must NOT
// light for `defining`) and WITHOUT making `defining` claimable.
//
// NO DATABASE, NO REAL FILESYSTEM WRITE, NO NETWORK, NO IPC. The module is pure
// and exercised directly via require().
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  ACTIVE_STATUSES,
  SLOT_OCCUPYING_STATUSES,
  CLAIMABLE_STATUSES,
  isActive,
  isSlotOccupying,
  isClaimable,
  activeCount,
  slotOccupancyCount,
  selectNextBatch,
  canRunInParallel,
  claimTicket,
} = require('../lib/ticket-queue');

// ---------------------------------------------------------------------------
// The slot-occupancy set / predicate
// ---------------------------------------------------------------------------
test('SLOT_OCCUPYING_STATUSES is exactly [defining, in-progress, testing]', () => {
  assert.deepEqual(SLOT_OCCUPYING_STATUSES, ['defining', 'in-progress', 'testing']);
});

test('isSlotOccupying: true for defining/in-progress/testing, false otherwise', () => {
  for (const s of ['defining', 'in-progress', 'testing']) {
    assert.equal(isSlotOccupying(s), true, `${s} occupies a slot`);
  }
  for (const s of ['todo', 'failed-testing', 'done', 'post-processing', 'unknown', undefined, null]) {
    assert.equal(isSlotOccupying(s), false, `${String(s)} does not occupy a slot`);
  }
});

test('slotOccupancyCount counts defining + in-progress + testing (both fm shapes)', () => {
  const board = [
    { fm: { id: 'A', status: 'defining' } },
    { fm: { id: 'B', status: 'in-progress' } },
    { fm: { id: 'C', status: 'testing' } },
    { fm: { id: 'D', status: 'todo' } },
    { fm: { id: 'E', status: 'failed-testing' } },
    { fm: { id: 'F', status: 'done' } },
    { id: 'G', status: 'defining' }, // bare fm shape
  ];
  assert.equal(slotOccupancyCount(board), 4, 'A,B,C + bare-G occupy slots; D,E,F do not');
  assert.equal(slotOccupancyCount([]), 0);
  assert.equal(slotOccupancyCount(null), 0);
  assert.equal(slotOccupancyCount('nope'), 0);
});

// ---------------------------------------------------------------------------
// REGRESSION: isActive / ACTIVE_STATUSES / activeCount EXCLUDE `defining`
// ---------------------------------------------------------------------------
test('REGRESSION: ACTIVE_STATUSES stays exactly [in-progress, testing] (no defining)', () => {
  assert.deepEqual(ACTIVE_STATUSES, ['in-progress', 'testing']);
  assert.ok(!ACTIVE_STATUSES.includes('defining'), 'defining is NOT active');
});

test('REGRESSION: isActive("defining") === false (board dot must not light for defining)', () => {
  assert.equal(isActive('defining'), false);
  assert.equal(isActive('in-progress'), true);
  assert.equal(isActive('testing'), true);
});

test('REGRESSION: activeCount excludes defining but slotOccupancyCount includes it', () => {
  const board = [
    { fm: { status: 'defining' } },
    { fm: { status: 'in-progress' } },
    { fm: { status: 'testing' } },
  ];
  assert.equal(activeCount(board), 2, 'only in-progress + testing are active');
  assert.equal(slotOccupancyCount(board), 3, 'defining also occupies a slot');
});

// ---------------------------------------------------------------------------
// REGRESSION: `defining` is NOT claimable
// ---------------------------------------------------------------------------
test('REGRESSION: CLAIMABLE_STATUSES unchanged and defining is not claimable', () => {
  assert.deepEqual(CLAIMABLE_STATUSES, ['todo', 'failed-testing']);
  assert.equal(isClaimable('defining'), false);
  assert.equal(isClaimable('todo'), true);
  assert.equal(isClaimable('failed-testing'), true);
});

test('claimTicket refuses a defining ticket (not-claimable)', () => {
  const r = claimTicket({ id: 'TASK-1', status: 'defining' }, 'coder-1');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-claimable');
});

// ---------------------------------------------------------------------------
// selectNextBatch free-slot math counts defining
// ---------------------------------------------------------------------------
test('selectNextBatch: 1 in-progress + 1 defining under limit 3 leaves 1 free slot', () => {
  const board = [
    { fm: { id: 'TASK-1', status: 'in-progress', agent: 'coder-1' } },
    { fm: { id: 'TASK-2', status: 'defining' } },
    { fm: { id: 'TASK-3', status: 'todo' } },
    { fm: { id: 'TASK-4', status: 'todo' } },
  ];
  const batch = selectNextBatch(board, { limit: 3 });
  assert.equal(batch.length, 1, 'free slots = 3 - (in-progress + defining) = 1');
  assert.deepEqual(batch.map((t) => t.fm.id), ['TASK-3'], 'oldest todo fills the one free slot');
});

test('selectNextBatch never returns a defining ticket (not claimable)', () => {
  const board = [
    { fm: { id: 'TASK-1', status: 'defining' } },
    { fm: { id: 'TASK-2', status: 'todo' } },
  ];
  const batch = selectNextBatch(board, { limit: 3 });
  assert.ok(!batch.some((t) => t.fm.status === 'defining'), 'no defining ticket is dispatched');
  assert.ok(!batch.some((t) => t.fm.id === 'TASK-1'), 'the defining ticket TASK-1 is excluded');
});

test('selectNextBatch: slot-occupancy equal to the limit returns nothing', () => {
  const board = [
    { fm: { id: 'TASK-1', status: 'defining' } },
    { fm: { id: 'TASK-2', status: 'in-progress', agent: 'c' } },
    { fm: { id: 'TASK-3', status: 'testing', agent: 'c' } },
    { fm: { id: 'TASK-4', status: 'todo' } },
  ];
  assert.deepEqual(selectNextBatch(board, { limit: 3 }), [], 'defining+in-progress+testing == limit -> no free slot');
});

// ---------------------------------------------------------------------------
// canRunInParallel free-slot math + no-slots reason counts defining
// ---------------------------------------------------------------------------
test('canRunInParallel: reports no-slots when slot-occupancy (incl. defining) equals the limit', () => {
  const board = [
    { fm: { id: 'TASK-1', status: 'defining' } },
    { fm: { id: 'TASK-2', status: 'in-progress', agent: 'c' } },
    { fm: { id: 'TASK-3', status: 'testing', agent: 'c' } },
  ];
  const newTicket = { fm: { id: 'TASK-9', status: 'todo' } };
  const r = canRunInParallel(board, newTicket, { limit: 3 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-slots');
  assert.equal(r.freeSlots, 0);
});

test('canRunInParallel: ok with the right freeSlots when a slot is free (defining counted)', () => {
  const board = [
    { fm: { id: 'TASK-1', status: 'defining' } },
    { fm: { id: 'TASK-2', status: 'in-progress', agent: 'c' } },
  ];
  const newTicket = { fm: { id: 'TASK-9', status: 'todo' } };
  const r = canRunInParallel(board, newTicket, { limit: 3 });
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'ok');
  assert.equal(r.freeSlots, 1, 'freeSlots = 3 - (defining + in-progress) = 1');
});
