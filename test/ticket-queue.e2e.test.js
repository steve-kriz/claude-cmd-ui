'use strict';

// E2e cucumber-style scenarios for canRunInParallel (TASK-029), the pure,
// Electron-free helper in lib/ticket-queue.js that decides whether a single
// newly-created ticket can be dispatched into a free concurrency slot RIGHT NOW.
//
// These implement the ticket's Gherkin Feature as Given/When/Then `node --test`
// cases. There is NO `cucumber` npm package (none installed, none added) — the
// Given/When/Then steps are expressed as plain closures per the repo convention
// for `*.e2e.test.js` files (see test/ticket-history.e2e.test.js,
// test/ticket-progress.e2e.test.js).
//
// No DB / disk / git / network is touched: lib/ticket-queue.js is a pure module,
// so the board snapshots are plain in-memory objects and every assertion is made
// against the helper's return value directly.
//
//   Feature: Decide whether a newly created ticket can be dispatched in parallel now
//   Background: the concurrency limit is 3 (DEFAULT_CONCURRENCY)

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  canRunInParallel,
  selectNextBatch,
  DEFAULT_CONCURRENCY,
} = require('../lib/ticket-queue');

// Tiny Given/When/Then scaffolding so the scenario bodies read as Gherkin steps
// without any external cucumber runtime.
function scenario(name, steps) {
  test(`Scenario: ${name}`, steps);
}
const Given = (_desc, fn) => (fn ? fn() : undefined);
const When = (_desc, fn) => fn();
const Then = (_desc, fn) => fn();
const And = Then;

// Ticket frontmatter factory (mirrors the T(id, status, extra) factory in the
// unit-test file, returning a { fm } wrapper as the board stores them).
function T(id, status, extra) {
  return { fm: Object.assign({ id, status }, extra) };
}

// Background: DEFAULT_CONCURRENCY is the limit used unless a scenario passes one.
const LIMIT = DEFAULT_CONCURRENCY; // 3

scenario('A new todo ticket runs in parallel when a slot is free', () => {
  let board; let newTicket; let res;
  Given('a board with 1 ticket in-progress and 1 ticket testing', () => {
    board = [
      T('TASK-001', 'in-progress', { agent: 'a1' }),
      T('TASK-002', 'testing', { agent: 'a2' }),
    ];
  });
  And('a newly created ticket "TASK-100" with status "todo"', () => {
    newTicket = T('TASK-100', 'todo');
  });
  When('I call canRunInParallel(board, newTicket, { limit: 3 })', () => {
    res = canRunInParallel(board, newTicket, { limit: LIMIT });
  });
  Then('ok is true', () => assert.equal(res.ok, true));
  And('reason is "ok"', () => assert.equal(res.reason, 'ok'));
  And('freeSlots is 1', () => assert.equal(res.freeSlots, 1));
});

scenario('A new failed-testing ticket is also eligible', () => {
  let board; let newTicket; let res;
  Given('a board with no active tickets', () => { board = []; });
  And('a newly created ticket "TASK-101" with status "failed-testing"', () => {
    newTicket = T('TASK-101', 'failed-testing');
  });
  When('I call canRunInParallel(board, newTicket, { limit: 3 })', () => {
    res = canRunInParallel(board, newTicket, { limit: LIMIT });
  });
  Then('ok is true', () => assert.equal(res.ok, true));
  And('reason is "ok"', () => assert.equal(res.reason, 'ok'));
});

scenario('No free slots — the bound is already full', () => {
  let board; let newTicket; let res;
  Given('a board with 3 tickets in-progress', () => {
    board = [
      T('TASK-001', 'in-progress', { agent: 'a1' }),
      T('TASK-002', 'in-progress', { agent: 'a2' }),
      T('TASK-003', 'in-progress', { agent: 'a3' }),
    ];
  });
  And('a newly created ticket "TASK-102" with status "todo"', () => {
    newTicket = T('TASK-102', 'todo');
  });
  When('I call canRunInParallel(board, newTicket, { limit: 3 })', () => {
    res = canRunInParallel(board, newTicket, { limit: LIMIT });
  });
  Then('ok is false', () => assert.equal(res.ok, false));
  And('reason is "no-slots"', () => assert.equal(res.reason, 'no-slots'));
  And('freeSlots is 0', () => assert.equal(res.freeSlots, 0));
});

scenario('The new ticket is claimed by a different agent', () => {
  let board; let newTicket; let res;
  Given('a board with 1 ticket in-progress', () => {
    board = [T('TASK-001', 'in-progress', { agent: 'a1' })];
  });
  And('a newly created ticket "TASK-103" with status "todo" and agent "other-agent"', () => {
    newTicket = T('TASK-103', 'todo', { agent: 'other-agent' });
  });
  When('I call canRunInParallel(board, newTicket, { limit: 3, agentId: "me" })', () => {
    res = canRunInParallel(board, newTicket, { limit: LIMIT, agentId: 'me' });
  });
  Then('ok is false', () => assert.equal(res.ok, false));
  And('reason is "claimed"', () => assert.equal(res.reason, 'claimed'));
});

scenario('The new ticket is a safe re-entry for the same agent', () => {
  let board; let newTicket; let res;
  Given('a board with 1 ticket testing', () => {
    board = [T('TASK-001', 'testing', { agent: 'a2' })];
  });
  And('a newly created ticket "TASK-104" with status "failed-testing" and agent "me"', () => {
    newTicket = T('TASK-104', 'failed-testing', { agent: 'me' });
  });
  When('I call canRunInParallel(board, newTicket, { limit: 3, agentId: "me" })', () => {
    res = canRunInParallel(board, newTicket, { limit: LIMIT, agentId: 'me' });
  });
  Then('ok is true', () => assert.equal(res.ok, true));
  And('reason is "ok"', () => assert.equal(res.reason, 'ok'));
});

scenario('The new ticket is already active', () => {
  let board; let newTicket; let res;
  Given('a board with no other active tickets', () => { board = []; });
  And('a newly created ticket "TASK-105" with status "in-progress"', () => {
    newTicket = T('TASK-105', 'in-progress');
  });
  When('I call canRunInParallel(board, newTicket, { limit: 3 })', () => {
    res = canRunInParallel(board, newTicket, { limit: LIMIT });
  });
  Then('ok is false', () => assert.equal(res.ok, false));
  And('reason is "already-active"', () => assert.equal(res.reason, 'already-active'));
});

scenario('A non-claimable status is rejected', () => {
  let board; let newTicket; let res;
  Given('a board with no active tickets', () => { board = []; });
  And('a newly created ticket "TASK-106" with status "done"', () => {
    newTicket = T('TASK-106', 'done');
  });
  When('I call canRunInParallel(board, newTicket, { limit: 3 })', () => {
    res = canRunInParallel(board, newTicket, { limit: LIMIT });
  });
  Then('ok is false', () => assert.equal(res.ok, false));
  And('reason is "not-claimable"', () => assert.equal(res.reason, 'not-claimable'));
});

scenario('A junk limit falls back through resolveConcurrency (Scenario Outline)', () => {
  // Examples: | limit | slots | ok |
  const examples = [
    { limit: 'nonsense', slots: 3, ok: true },
    { limit: 0, slots: 1, ok: true },
    { limit: 1000, slots: 8, ok: true },
  ];
  for (const ex of examples) {
    let board; let newTicket; let res;
    Given('a board with no active tickets', () => { board = []; });
    And('a newly created ticket "TASK-107" with status "todo"', () => {
      newTicket = T('TASK-107', 'todo');
    });
    When(`I call canRunInParallel(board, newTicket, { limit: ${JSON.stringify(ex.limit)} })`, () => {
      res = canRunInParallel(board, newTicket, { limit: ex.limit });
    });
    Then(`freeSlots is ${ex.slots}`, () => assert.equal(res.freeSlots, ex.slots, `limit ${JSON.stringify(ex.limit)}`));
    And(`ok is ${ex.ok}`, () => assert.equal(res.ok, ex.ok, `limit ${JSON.stringify(ex.limit)}`));
  }
});

scenario('Failure/edge — a missing or invalid new ticket never crashes', () => {
  let board; let res;
  Given('a board with 1 ticket in-progress', () => {
    board = [T('TASK-001', 'in-progress', { agent: 'a1' })];
  });
  When('I call canRunInParallel(board, null, { limit: 3 })', () => {
    assert.doesNotThrow(() => { res = canRunInParallel(board, null, { limit: LIMIT }); });
  });
  Then('ok is false', () => assert.equal(res.ok, false));
  And('reason is "no-ticket"', () => assert.equal(res.reason, 'no-ticket'));
  And('freeSlots is 2', () => assert.equal(res.freeSlots, 2));
});

scenario('Empty board with a valid new ticket', () => {
  let newTicket; let res;
  Given('an empty board', () => { /* [] passed directly below */ });
  And('a newly created ticket "TASK-108" with status "todo"', () => {
    newTicket = T('TASK-108', 'todo');
  });
  When('I call canRunInParallel([], newTicket, { limit: 3 })', () => {
    res = canRunInParallel([], newTicket, { limit: LIMIT });
  });
  Then('ok is true', () => assert.equal(res.ok, true));
  And('freeSlots is 3', () => assert.equal(res.freeSlots, 3));
});

scenario('The helper does not mutate its inputs', () => {
  let board; let newTicket; let opts; let boardSnap; let newSnap; let optsSnap;
  Given('a board and a newly created ticket "TASK-109" with status "todo"', () => {
    board = [T('TASK-001', 'in-progress', { agent: 'a1' }), T('TASK-002', 'todo')];
    newTicket = T('TASK-109', 'todo');
    opts = { limit: LIMIT, agentId: 'me' };
    boardSnap = JSON.stringify(board);
    newSnap = JSON.stringify(newTicket);
    optsSnap = JSON.stringify(opts);
  });
  When('I call canRunInParallel(board, newTicket, { limit: 3 })', () => {
    canRunInParallel(board, newTicket, opts);
  });
  Then('a deep snapshot of board and newTicket taken before the call is unchanged', () => {
    assert.equal(JSON.stringify(board), boardSnap, 'board unchanged');
    assert.equal(JSON.stringify(newTicket), newSnap, 'newTicket unchanged');
    assert.equal(JSON.stringify(opts), optsSnap, 'opts unchanged');
  });
});

scenario('The verdict composes with selectNextBatch', () => {
  let board; let verdict; let candidates;
  Given('a board where "TASK-110" (status todo) is present and one slot is free', () => {
    board = [
      T('TASK-001', 'in-progress', { agent: 'a1' }),
      T('TASK-002', 'testing', { agent: 'a2' }),
      T('TASK-110', 'todo'),
    ]; // 2 active, limit 3 → 1 free slot
  });
  When('canRunInParallel(board, TASK-110, { limit: 3 }) returns ok true', () => {
    verdict = canRunInParallel(board, T('TASK-110', 'todo').fm, { limit: LIMIT });
    assert.equal(verdict.ok, true, 'precondition: ok is true');
    assert.equal(verdict.freeSlots, 1);
    candidates = selectNextBatch(board, { limit: LIMIT }).map((t) => t.fm.id);
  });
  Then('TASK-110 appears among the claimable candidates selectNextBatch considers', () => {
    assert.ok(candidates.includes('TASK-110'),
      `expected TASK-110 in selectNextBatch candidates ${JSON.stringify(candidates)}`);
  });
});

scenario('A kind:post-processing ticket with claimable status IS now eligible (TASK-206)', () => {
  let board; let newTicket; let res; let candidates;
  Given('a board with free slots', () => {
    board = [T('TASK-001', 'in-progress', { agent: 'a1' })]; // 2 free @ limit 3
  });
  And('a newly created ticket with status "todo" and kind "post-processing"', () => {
    newTicket = T('PP-1', 'todo', { kind: 'post-processing' });
  });
  When('I call canRunInParallel(board, newTicket, { limit: 3 })', () => {
    res = canRunInParallel(board, newTicket, { limit: LIMIT });
    candidates = selectNextBatch([...board, newTicket], { limit: LIMIT }).map((t) => t.fm.id);
  });
  Then('ok is true and reason is "ok" (post-processing kind no longer special)', () => {
    assert.equal(res.ok, true, 'post-processing kind with claimable status is now eligible (TASK-206)');
    assert.equal(res.reason, 'ok');
  });
  And('it is included in selectNextBatch (no longer excluded)', () => {
    assert.ok(candidates.includes('PP-1'),
      `post-processing ticket must appear in selectNextBatch ${JSON.stringify(candidates)}`);
  });
});

scenario('{ fm } wrapper support — identical verdicts to bare fm for both args', () => {
  let bareRes; let wrappedRes;
  Given('a board and newTicket expressed both as bare fm and as { fm } wrappers', () => {
    const bareBoard = [{ id: 'TASK-001', status: 'in-progress', agent: 'a1' }];
    const wrappedBoard = [{ fm: { id: 'TASK-001', status: 'in-progress', agent: 'a1' } }];
    const bareNew = { id: 'TASK-120', status: 'todo' };
    const wrappedNew = { fm: { id: 'TASK-120', status: 'todo' } };
    bareRes = canRunInParallel(bareBoard, bareNew, { limit: LIMIT });
    wrappedRes = canRunInParallel(wrappedBoard, wrappedNew, { limit: LIMIT });
  });
  When('I compare the two verdicts', () => { /* computed above */ });
  Then('they are identical', () => {
    assert.deepEqual(bareRes, wrappedRes);
    assert.deepEqual(bareRes, { ok: true, reason: 'ok', freeSlots: 2 });
  });
});
