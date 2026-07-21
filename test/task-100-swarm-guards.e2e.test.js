'use strict';

// E2e cucumber-style scenarios for the TASK-100 swarm/user-status boundary in
// lib/ticket-queue.js — the pure, Electron-free helpers that decide batch
// selection, claiming, and concurrency-slot occupancy. These implement the
// ticket's Gherkin Feature ("Swarm ignores user statuses") as Given/When/Then
// `node --test` cases.
//
// There is NO `cucumber` npm package (none installed, none added) — the
// Given/When/Then steps are expressed as plain closures per the repo convention
// for `*.e2e.test.js` files (see test/ticket-queue.e2e.test.js).
//
// No DB / disk / git / network is touched: lib/ticket-queue.js is a pure module,
// so the board snapshots are plain in-memory objects and every assertion is made
// against the helper's return value directly. Any DB access would be mocked, but
// this module makes none.
//
//   Feature: Swarm ignores user statuses

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  selectNextBatch,
  canRunInParallel,
  claimTicket,
  slotOccupancyCount,
} = require('../lib/ticket-queue');

const { POST_PROCESSING_KIND } = require('../lib/ticket-lanes');

// Tiny Given/When/Then scaffolding so the scenario bodies read as Gherkin steps
// without any external cucumber runtime.
function scenario(name, steps) {
  test(`Scenario: ${name}`, steps);
}
const Given = (_desc, fn) => (fn ? fn() : undefined);
const When = (_desc, fn) => fn();
const Then = (_desc, fn) => fn();
const And = Then;

// Ticket frontmatter factory returning a { fm } wrapper as the board stores them.
function T(id, status, extra) {
  return { fm: Object.assign({ id, status }, extra) };
}

// ─────────────────────────────────────────────────────────────────────────────
scenario('Batch selection skips user columns and free-slot math ignores them', () => {
  let board; let boardNoUser; let picked; let pickedNoUser;
  Given('a board with 2 todo tickets and 3 ux-review tickets and limit 3', () => {
    board = [
      T('TASK-1', 'todo'),
      T('TASK-2', 'todo'),
      T('TASK-10', 'ux-review'),
      T('TASK-11', 'ux-review'),
      T('TASK-12', 'ux-review'),
    ];
    boardNoUser = [T('TASK-1', 'todo'), T('TASK-2', 'todo')];
  });
  When('selectNextBatch runs', () => {
    picked = selectNextBatch(board, { limit: 3 });
    pickedNoUser = selectNextBatch(boardNoUser, { limit: 3 });
  });
  Then('only the 2 todo tickets are returned', () => {
    assert.deepEqual(picked.map((t) => t.fm.id), ['TASK-1', 'TASK-2']);
  });
  And('freeSlots math ignores ux-review (occupancy is 0, same as without them)', () => {
    assert.equal(slotOccupancyCount(board), 0);
    assert.equal(slotOccupancyCount(board), slotOccupancyCount(boardNoUser));
    // Selection is identical to the same board without the user-status cards.
    assert.deepEqual(
      picked.map((t) => t.fm.id),
      pickedNoUser.map((t) => t.fm.id),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
scenario('User-status ticket cannot be claimed (failure)', () => {
  let res;
  When('claimTicket runs on a ticket with status "ux-review"', () => {
    res = claimTicket({ id: 'TASK-1', status: 'ux-review' }, 'agent-A');
  });
  Then('the claim is refused', () => {
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'not-claimable');
  });
  And('the ticket is not stamped in-progress or given an agent', () => {
    assert.equal(res.fm.status, 'ux-review');
    assert.equal(res.fm.agent, undefined);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
scenario('Occupancy unchanged by user statuses (edge, mixed board incl. a post-processing-STATUS card)', () => {
  let board; let boardNoUser; let newTicket; let verdict; let verdictNoUser;
  Given('3 in-progress tickets and 5 ux-review tickets with limit 3, plus a post-processing card', () => {
    board = [
      T('TASK-1', 'in-progress', { agent: 'a1' }),
      T('TASK-2', 'in-progress', { agent: 'a2' }),
      T('TASK-3', 'in-progress', { agent: 'a3' }),
      T('TASK-10', 'ux-review'),
      T('TASK-11', 'ux-review'),
      T('TASK-12', 'ux-review'),
      T('TASK-13', 'ux-review'),
      T('TASK-14', 'ux-review'),
      // A card in the post-processing STATUS: excluded from slot occupancy by
      // STATUS alone (post-processing is not in SLOT_OCCUPYING_STATUSES —
      // defining/in-progress/testing). The `kind` field is NOT what excludes it
      // here: slot occupancy is status-only in the lib and never inspects kind,
      // so deleting `kind` would not change this count. The KIND guard is
      // asserted where it actually acts (claim/parallel/select) in the dedicated
      // scenario below and in task-100-swarm-guards.test.js.
      T('TASK-20', 'post-processing', { kind: POST_PROCESSING_KIND }),
    ];
    // Same board with the user-status cards removed.
    boardNoUser = board.filter((t) => t.fm.status !== 'ux-review');
    newTicket = T('TASK-99', 'todo');
  });
  When('canRunInParallel is asked about a new todo ticket', () => {
    verdict = canRunInParallel(board, newTicket, { limit: 3 });
  });
  Then('it reports no-slots (the 3 in-progress fill the bound)', () => {
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'no-slots');
    assert.equal(verdict.freeSlots, 0);
  });
  And('slot occupancy counts only the 3 in-progress (ux-review excluded by status; post-processing excluded by STATUS, not kind)', () => {
    assert.equal(slotOccupancyCount(board), 3);
  });
  And('removing the ux-review tickets does not change the verdict', () => {
    verdictNoUser = canRunInParallel(boardNoUser, newTicket, { limit: 3 });
    assert.deepEqual(verdictNoUser, verdict);
    assert.equal(slotOccupancyCount(boardNoUser), slotOccupancyCount(board));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The KIND guard asserted WHERE IT ACTS: a kind:post-processing ticket whose
// STATUS is CLAIMABLE ('todo') is refused by claimTicket / canRunInParallel /
// selectNextBatch by the KIND, while a kind-less control at the same status is
// granted/selected — proving the `kind` field alone flips every verdict (slot
// occupancy, which is status-only, is deliberately NOT the mechanism here).
scenario('Post-processing KIND (not status) is what excludes a claimable-status ticket', () => {
  let board; let picked; let claim; let ctrlClaim; let parallel; let ctrlParallel;
  Given('a todo ticket with kind:post-processing plus a kind-less todo control, limit 3', () => {
    board = [
      T('PP-1', 'todo', { kind: POST_PROCESSING_KIND }), // claimable status, kind excludes it
      T('TASK-3', 'todo'),                               // kind-less control
    ];
  });
  When('the guards run against these claimable-status tickets', () => {
    picked = selectNextBatch(board, { limit: 3 }).map((t) => t.fm.id);
    claim = claimTicket({ id: 'PP-1', status: 'todo', kind: POST_PROCESSING_KIND }, 'agent-A');
    ctrlClaim = claimTicket({ id: 'TASK-3', status: 'todo' }, 'agent-A');
    parallel = canRunInParallel([], T('PP-1', 'todo', { kind: POST_PROCESSING_KIND }), { limit: 3 });
    ctrlParallel = canRunInParallel([], T('TASK-3', 'todo'), { limit: 3 });
  });
  Then('selectNextBatch returns only the kind-less control despite free slots', () => {
    assert.deepEqual(picked, ['TASK-3']);
  });
  And('claimTicket refuses the kind ticket with reason exactly post-processing, no agent stamp', () => {
    assert.equal(claim.ok, false);
    assert.equal(claim.reason, 'post-processing'); // NOT 'not-claimable'
    assert.equal(claim.fm.status, 'todo');
    assert.equal(claim.fm.agent, undefined);
  });
  And('claimTicket grants the kind-less control at the same status (kind flips the verdict)', () => {
    assert.equal(ctrlClaim.ok, true);
    assert.equal(ctrlClaim.fm.status, 'in-progress');
    assert.equal(ctrlClaim.fm.agent, 'agent-A');
  });
  And('canRunInParallel refuses the kind ticket with post-processing while freeSlots stays 3', () => {
    assert.equal(parallel.ok, false);
    assert.equal(parallel.reason, 'post-processing'); // NOT 'no-slots'/'not-claimable'
    assert.equal(parallel.freeSlots, 3);
    // Control at the same status is eligible with the slots free.
    assert.equal(ctrlParallel.ok, true);
    assert.equal(ctrlParallel.reason, 'ok');
    assert.equal(ctrlParallel.freeSlots, 3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Precedence: the KIND guard outranks the claimed verdict. A kind:post-processing
// ticket owned by a foreign agent still reports 'post-processing' (the kind guard
// sits above the isClaimed() check in both claimTicket and canRunInParallel).
scenario('Post-processing KIND outranks the claimed verdict (precedence)', () => {
  let claim; let parallel;
  When('a kind:post-processing todo ticket also carries a foreign agent', () => {
    claim = claimTicket({ id: 'PP-1', status: 'todo', kind: POST_PROCESSING_KIND, agent: 'other' }, 'agent-A');
    parallel = canRunInParallel([], T('PP-1', 'todo', { kind: POST_PROCESSING_KIND, agent: 'other' }), { limit: 3 });
  });
  Then('claimTicket reports post-processing, not claimed', () => {
    assert.equal(claim.ok, false);
    assert.equal(claim.reason, 'post-processing');
  });
  And('canRunInParallel reports post-processing, not claimed', () => {
    assert.equal(parallel.ok, false);
    assert.equal(parallel.reason, 'post-processing');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Extra failure/edge path: a user-status ticket that is ALSO claimed by a
// foreign agent still reports 'claimed' — the reason precedence is unchanged.
scenario('User-status ticket carrying a foreign agent still reports claimed (precedence)', () => {
  let res;
  When('canRunInParallel sees a ux-review ticket owned by another agent', () => {
    res = canRunInParallel([], T('TASK-1', 'ux-review', { agent: 'other' }), { limit: 3 });
  });
  Then('the reason is claimed, not not-claimable', () => {
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'claimed');
  });
});
