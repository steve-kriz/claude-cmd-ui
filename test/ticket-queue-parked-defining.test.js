'use strict';

// ===========================================================================
// TASK-087 — UNIT tests for the REAL lib/ticket-queue.js slot-occupancy
// REFINEMENT: a question-parked `defining` ticket (status `defining` with a
// non-empty `question` and empty/absent `answer`, per lib/ticket-questions.js
// `isWaitingForAnswer`) no longer holds a concurrency slot, so any number of
// such parked definitions can never starve ready `todo`/`failed-testing` work
// into a full-swarm stall. An ACTIVELY-defining ticket (status `defining`, no
// open question, or one whose question is answered) still counts against the
// bound exactly like `in-progress`/`testing` (TASK-079 Part C is preserved).
//
// Regression coverage keeps ACTIVE_STATUSES / isActive / activeCount and the
// CLAIMABLE_STATUSES gate unchanged: `defining` (parked or not) is never
// claimable and never returned by selectNextBatch.
//
// NO DATABASE, NO REAL FILESYSTEM WRITE, NO NETWORK, NO IPC. Both modules are
// pure and exercised directly via require().
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  ACTIVE_STATUSES,
  SLOT_OCCUPYING_STATUSES,
  CLAIMABLE_STATUSES,
  isActive,
  isSlotOccupying,
  isSlotOccupyingTicket,
  isClaimable,
  activeCount,
  slotOccupancyCount,
  selectNextBatch,
  canRunInParallel,
  claimTicket,
} = require('../lib/ticket-queue');

const { isWaitingForAnswer } = require('../lib/ticket-questions');

// Convenience frontmatter builders ------------------------------------------
const parkedDefining = (id) => ({ id, status: 'defining', question: 'Which auth flow?' });
const parkedDefiningBlankAnswer = (id) => ({ id, status: 'defining', question: 'Which auth flow?', answer: '   ' });
const activeDefining = (id) => ({ id, status: 'defining' });
const answeredDefining = (id) => ({ id, status: 'defining', question: 'Which auth flow?', answer: 'OAuth' });

// ---------------------------------------------------------------------------
// isSlotOccupyingTicket — the new refined predicate
// ---------------------------------------------------------------------------
test('isSlotOccupyingTicket: true for in-progress and testing', () => {
  assert.equal(isSlotOccupyingTicket({ id: 'A', status: 'in-progress' }), true);
  assert.equal(isSlotOccupyingTicket({ id: 'B', status: 'testing' }), true);
});

test('isSlotOccupyingTicket: true for an actively-defining ticket (no question)', () => {
  assert.equal(isSlotOccupyingTicket(activeDefining('C')), true,
    'defining with no open question still occupies a slot (TASK-079 Part C)');
});

test('isSlotOccupyingTicket: true for a defining ticket whose question is ANSWERED', () => {
  // Answered question => not parked => still counts.
  assert.equal(isWaitingForAnswer(answeredDefining('C2')), false, 'answered => not waiting');
  assert.equal(isSlotOccupyingTicket(answeredDefining('C2')), true,
    'an answered defining ticket is actively-defining and holds a slot');
});

test('isSlotOccupyingTicket: FALSE for a question-parked defining ticket (question set, no answer)', () => {
  assert.equal(isWaitingForAnswer(parkedDefining('D')), true, 'parked => waiting for answer');
  assert.equal(isSlotOccupyingTicket(parkedDefining('D')), false,
    'a question-parked defining ticket frees its slot (TASK-087)');
});

test('isSlotOccupyingTicket: FALSE for a defining ticket parked with a blank/whitespace answer', () => {
  assert.equal(isWaitingForAnswer(parkedDefiningBlankAnswer('D2')), true, 'blank answer is still waiting');
  assert.equal(isSlotOccupyingTicket(parkedDefiningBlankAnswer('D2')), false,
    'a blank answer does not un-park the ticket');
});

test('isSlotOccupyingTicket: false for non-slot statuses (todo/done/failed-testing/post-processing)', () => {
  for (const s of ['todo', 'done', 'failed-testing', 'post-processing', 'unknown']) {
    assert.equal(isSlotOccupyingTicket({ id: 'X', status: s }), false, `${s} does not occupy a slot`);
  }
});

test('isSlotOccupyingTicket: false and NEVER throws for null/junk/non-object frontmatter', () => {
  for (const bad of [null, undefined, 42, 'nope', true, NaN, [], {}, { status: '' }, { status: null }]) {
    let out;
    assert.doesNotThrow(() => { out = isSlotOccupyingTicket(bad); }, `no throw on ${JSON.stringify(bad)}`);
    assert.equal(out, false, `${JSON.stringify(bad)} does not occupy a slot`);
  }
});

test('isSlotOccupyingTicket: a non-defining ticket with a parked question STILL counts (in-progress/testing)', () => {
  // The parked exemption is specific to `defining`; an in-progress ticket that
  // happens to carry a question/answer pair still holds its slot.
  assert.equal(isSlotOccupyingTicket({ id: 'E', status: 'in-progress', question: 'q?' }), true);
  assert.equal(isSlotOccupyingTicket({ id: 'F', status: 'testing', question: 'q?' }), true);
});

// ---------------------------------------------------------------------------
// slotOccupancyCount — parked defining does NOT count, active defining does
// ---------------------------------------------------------------------------
test('slotOccupancyCount: two parked-defining + one in-progress under limit 3 => occupancy 1', () => {
  const board = [
    { fm: parkedDefining('TASK-1') },
    { fm: parkedDefining('TASK-2') },
    { fm: { id: 'TASK-3', status: 'in-progress', agent: 'coder-1' } },
    { fm: { id: 'TASK-4', status: 'todo' } },
  ];
  assert.equal(slotOccupancyCount(board), 1,
    'only the in-progress ticket occupies a slot; both parked definitions are exempt');
});

test('slotOccupancyCount: an actively-defining + an in-progress => occupancy 2', () => {
  const board = [
    { fm: activeDefining('TASK-1') },
    { fm: { id: 'TASK-2', status: 'in-progress', agent: 'coder-1' } },
  ];
  assert.equal(slotOccupancyCount(board), 2,
    'active defining still counts against the bound alongside in-progress (TASK-079 Part C)');
});

test('slotOccupancyCount: bare-fm and { fm } shapes both handled; answered defining counts', () => {
  const board = [
    parkedDefining('TASK-1'),                                  // bare fm, exempt
    { fm: answeredDefining('TASK-2') },                        // answered => counts
    { fm: { id: 'TASK-3', status: 'testing', agent: 'c' } },   // counts
    { fm: { id: 'TASK-4', status: 'todo' } },                  // no slot
  ];
  assert.equal(slotOccupancyCount(board), 2, 'answered-defining + testing occupy slots; parked + todo do not');
});

// ---------------------------------------------------------------------------
// REGRESSION: ACTIVE_STATUSES / isActive / activeCount unchanged by TASK-087
// ---------------------------------------------------------------------------
test('REGRESSION: ACTIVE_STATUSES stays exactly [in-progress, testing]', () => {
  assert.deepEqual(ACTIVE_STATUSES, ['in-progress', 'testing']);
  assert.ok(!ACTIVE_STATUSES.includes('defining'), 'defining is NOT active');
});

test('REGRESSION: isActive("defining") === false whether parked or active', () => {
  assert.equal(isActive('defining'), false);
  // isActive is status-only; parked/active distinction never makes defining active.
  assert.equal(isActive(parkedDefining('X').status), false);
  assert.equal(isActive(activeDefining('X').status), false);
});

test('REGRESSION: activeCount excludes ALL defining (parked and active)', () => {
  const board = [
    { fm: parkedDefining('TASK-1') },
    { fm: activeDefining('TASK-2') },
    { fm: { id: 'TASK-3', status: 'in-progress', agent: 'c' } },
    { fm: { id: 'TASK-4', status: 'testing', agent: 'c' } },
  ];
  assert.equal(activeCount(board), 2, 'only in-progress + testing are active; neither defining flavour is');
});

test('REGRESSION: SLOT_OCCUPYING_STATUSES / isSlotOccupying (status-only) unchanged', () => {
  assert.deepEqual(SLOT_OCCUPYING_STATUSES, ['defining', 'in-progress', 'testing']);
  // The status-only helper still says defining occupies a slot; the whole-ticket
  // refinement lives in isSlotOccupyingTicket, not isSlotOccupying.
  assert.equal(isSlotOccupying('defining'), true);
});

// ---------------------------------------------------------------------------
// REGRESSION: `defining` (parked or not) is NOT claimable / never dispatched
// ---------------------------------------------------------------------------
test('REGRESSION: CLAIMABLE_STATUSES unchanged; defining not claimable', () => {
  assert.deepEqual(CLAIMABLE_STATUSES, ['todo', 'failed-testing']);
  assert.equal(isClaimable('defining'), false);
});

test('REGRESSION: claimTicket refuses a parked defining ticket (not-claimable)', () => {
  const r = claimTicket(parkedDefining('TASK-1'), 'coder-1');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-claimable');
});

test('REGRESSION: selectNextBatch never returns a parked or active defining ticket', () => {
  const board = [
    { fm: parkedDefining('TASK-1') },
    { fm: activeDefining('TASK-2') },
    { fm: { id: 'TASK-3', status: 'todo' } },
  ];
  const batch = selectNextBatch(board, { limit: 3 });
  assert.ok(!batch.some((t) => t.fm.status === 'defining'), 'no defining ticket dispatched');
  assert.ok(!batch.some((t) => ['TASK-1', 'TASK-2'].includes(t.fm.id)), 'both defining tickets excluded');
  assert.deepEqual(batch.map((t) => t.fm.id), ['TASK-3'], 'only the todo is dispatched');
});

// ---------------------------------------------------------------------------
// isWaitingForAnswer semantics match lib/ticket-questions.js exactly
// ---------------------------------------------------------------------------
test('isWaitingForAnswer semantics used by the slot math match ticket-questions.js', () => {
  // parked = non-empty question + empty/absent answer.
  assert.equal(isWaitingForAnswer({ question: 'q?' }), true, 'question, no answer => waiting');
  assert.equal(isWaitingForAnswer({ question: 'q?', answer: '' }), true, 'empty answer => waiting');
  assert.equal(isWaitingForAnswer({ question: 'q?', answer: '  ' }), true, 'whitespace answer => waiting');
  // answered => NOT parked => the ticket still counts as a slot.
  assert.equal(isWaitingForAnswer({ question: 'q?', answer: 'yes' }), false, 'answered => not waiting');
  // no question => not parked (an actively-defining ticket).
  assert.equal(isWaitingForAnswer({}), false, 'no question => not waiting');
  assert.equal(isWaitingForAnswer({ answer: 'yes' }), false, 'answer without question => not waiting');

  // And these flow through the slot predicate identically.
  assert.equal(isSlotOccupyingTicket({ id: 'A', status: 'defining', question: 'q?', answer: 'yes' }), true);
  assert.equal(isSlotOccupyingTicket({ id: 'B', status: 'defining', question: 'q?', answer: '  ' }), false);
});

// ===========================================================================
// TASK-090 — the `failed-testing` half of TASK-087 AC-1, made explicit.
//
// TASK-087's AC-1 covers ready `todo` AND `failed-testing` dispatch past
// parked definitions, but the existing cases above only exercise ready `todo`
// in the parked-at-limit scenario. These add the `failed-testing` variant: a
// handed-back ticket (fix attempts remaining) must still dispatch past parked
// definitions that sit at the limit, because the parked defs are exempt from
// the slot count and `failed-testing` is in CLAIMABLE_STATUSES.
//
// CAP NOTE: the Phase-3 "3-attempt cap" is an ORCHESTRATOR-level rule
// (assets/.claude SKILL.md Phase 3, "Cap the fix loop at 3 attempts"). The pure
// lib/ticket-queue.js does NOT track attempts and does NOT enforce the cap:
// selectNextBatch / isClaimable / claimTicket select a `failed-testing` ticket
// purely on its status, regardless of any attempt/runs field. The edge test
// below therefore asserts what the LIB ACTUALLY does (still selects it), and
// documents that cap enforcement lives in the orchestrator, not the queue lib.
// ===========================================================================

// A ticket handed back for another fix attempt. `attempts` is illustrative
// metadata only — the lib does not read it (see CAP NOTE above).
const readyFailedTesting = (id, attempts) => ({ id, status: 'failed-testing', attempts });

test('TASK-090 unit: limit filled only by parked-defining => a ready failed-testing ticket IS selectable', () => {
  // Given the concurrency limit (2) is filled only by two question-parked
  // defining tickets, plus one ready failed-testing ticket with attempts left.
  const parkedA = parkedDefining('TASK-1');
  const parkedB = parkedDefining('TASK-2');
  const retry = readyFailedTesting('TASK-3', 1); // 1 of 3 attempts used, remaining
  const board = [{ fm: parkedA }, { fm: parkedB }, { fm: retry }];
  const limit = 2;

  assert.equal(isWaitingForAnswer(parkedA), true, 'TASK-1 is genuinely parked');
  assert.equal(isWaitingForAnswer(parkedB), true, 'TASK-2 is genuinely parked');

  // Then the parked defs count as 0 slots even though they sit at the limit.
  assert.equal(slotOccupancyCount(board), 0,
    'two parked definitions occupy zero slots, so the failed-testing retry is not blocked');

  // And selectNextBatch returns the failed-testing ticket (the retry dispatches).
  const batch = selectNextBatch(board, { limit });
  assert.deepEqual(batch.map((t) => t.fm.id), ['TASK-3'],
    'the ready failed-testing ticket dispatches past parked definitions at the limit');
  assert.equal(batch[0].fm.status, 'failed-testing', 'the dispatched ticket is the failed-testing retry');

  // And canRunInParallel reports ok with a free slot for it.
  const can = canRunInParallel(board, { fm: retry }, { limit });
  assert.equal(can.ok, true, 'canRunInParallel says ok for the failed-testing retry');
  assert.equal(can.reason, 'ok');
  assert.ok(can.freeSlots > 0, `freeSlots > 0 (got ${can.freeSlots})`);
});

test('TASK-090 unit: the dispatched failed-testing retry claims into a slot (in-progress + agent)', () => {
  // A ready failed-testing ticket is claimable exactly like a todo (both are in
  // CLAIMABLE_STATUSES); claiming stamps in-progress + agent, bumps updated.
  const retry = readyFailedTesting('TASK-9', 2);
  assert.equal(isClaimable('failed-testing'), true, 'failed-testing is a claimable status');
  const claimed = claimTicket(retry, 'coder-7');
  assert.equal(claimed.ok, true, 'the failed-testing retry is claimable');
  assert.equal(claimed.fm.status, 'in-progress');
  assert.equal(claimed.fm.agent, 'coder-7');
});

test('TASK-090 unit (edge/CAP NOTE): the lib does NOT enforce the 3-attempt cap — an exhausted failed-testing ticket is STILL selected', () => {
  // Given a failed-testing ticket whose attempts are EXHAUSTED (attempts: 3, the
  // Phase-3 cap) plus parked definitions at the limit.
  const exhausted = readyFailedTesting('TASK-3', 3); // cap reached per SKILL Phase 3
  const board = [
    { fm: parkedDefining('TASK-1') },
    { fm: parkedDefining('TASK-2') },
    { fm: exhausted },
  ];
  const limit = 2;

  // Then — because the pure queue lib does not read `attempts` and the cap is an
  // ORCHESTRATOR-level rule — selectNextBatch STILL returns it. We assert the
  // lib's ACTUAL behaviour (not a cap it does not own). The orchestrator is what
  // must leave a cap-exhausted ticket in `failed-testing` and stop re-dispatching.
  const batch = selectNextBatch(board, { limit });
  assert.deepEqual(batch.map((t) => t.fm.id), ['TASK-3'],
    'lib selects on status alone; the 3-attempt cap is enforced by the orchestrator, not the queue');
  const can = canRunInParallel(board, { fm: exhausted }, { limit });
  assert.equal(can.ok, true, 'lib reports ok regardless of the attempt count (cap is orchestrator-level)');
});
