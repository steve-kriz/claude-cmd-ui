'use strict';

// ===========================================================================
// TASK-087 — E2E cucumber-style (Given/When/Then) scenarios for the ticket's
// Gherkin: "Question-parked defining tickets do not stall the swarm".
//
// These are scenario-style node --test cases (no `cucumber` npm package). They
// drive the REAL pure lib/ticket-queue.js + lib/ticket-questions.js helpers and
// source-scan both SKILL.md copies as fixtures. NO DATABASE, NO REAL FS WRITE,
// NO NETWORK, NO IPC — every side effect is avoided; slot decisions are pure.
//
// Scenarios covered:
//   1. Parked defining at the limit still lets ready work run (the stall fix).
//   2. Active defining still counts against the bound (TASK-079 Part C edge).
//   3. FAILURE/EDGE: all slots consumed by ACTIVE defining => ready work
//      correctly waits (no-slots) — proving the exemption is specific to
//      PARKED, not all, defining.
//   4. SKILL contract note present + byte-identical across both copies, and no
//      model id appears at/after "## Phase 2 — Build".
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  selectNextBatch,
  canRunInParallel,
  slotOccupancyCount,
  claimTicket,
} = require('../lib/ticket-queue');
const { askQuestion, isWaitingForAnswer } = require('../lib/ticket-questions');

const ROOT = path.join(__dirname, '..');
const ASSETS_SKILL = path.join(ROOT, 'assets', 'skills', 'orchestrate', 'SKILL.md');
const PROJECT_SKILL = path.join(ROOT, '.claude', 'skills', 'orchestrate', 'SKILL.md');

function readLF(p) {
  return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
}

// ---------------------------------------------------------------------------
// Scenario: Parked defining at the limit still lets ready work run
//   Given a limit of 2 and two defining tickets both parked on unanswered
//         questions
//   And one ready todo ticket that is defined
//   When selectNextBatch/canRunInParallel are evaluated
//   Then the ready todo ticket can still be dispatched
// ---------------------------------------------------------------------------
test('Scenario: parked defining at the limit still lets ready work run', () => {
  // Given a limit of 2 and two defining tickets both parked on unanswered
  // questions (built via the real askQuestion so the parked state is genuine).
  const parkedA = askQuestion({ id: 'TASK-1', status: 'defining' }, 'Which DB engine?');
  const parkedB = askQuestion({ id: 'TASK-2', status: 'defining' }, 'What retention window?');
  assert.equal(isWaitingForAnswer(parkedA), true, 'TASK-1 is genuinely parked');
  assert.equal(isWaitingForAnswer(parkedB), true, 'TASK-2 is genuinely parked');

  // And one ready todo ticket that is defined.
  const readyTodo = { id: 'TASK-3', status: 'todo' };

  const board = [{ fm: parkedA }, { fm: parkedB }, { fm: readyTodo }];
  const limit = 2;

  // When selectNextBatch/canRunInParallel are evaluated.
  // Then occupancy is 0 (both parked defs are exempt) despite two definitions.
  assert.equal(slotOccupancyCount(board), 0, 'two parked definitions occupy zero slots at the limit');

  const batch = selectNextBatch(board, { limit });
  const can = canRunInParallel(board, { fm: readyTodo }, { limit });

  // Then the ready todo ticket can still be dispatched (the swarm does not stall).
  assert.deepEqual(batch.map((t) => t.fm.id), ['TASK-3'], 'the ready todo is dispatched despite parked defs at the limit');
  assert.equal(can.ok, true, 'canRunInParallel says ok');
  assert.equal(can.reason, 'ok');
  assert.ok(can.freeSlots > 0, `freeSlots > 0 (got ${can.freeSlots})`);

  // And the dispatched ticket really claims into a slot (one-agent-per-ticket).
  const claimed = claimTicket(readyTodo, 'coder-1');
  assert.equal(claimed.ok, true);
  assert.equal(claimed.fm.status, 'in-progress');
  assert.equal(claimed.fm.agent, 'coder-1');
});

// ---------------------------------------------------------------------------
// TASK-090 Scenario (Gherkin): A failed-testing ticket dispatches past parked
// definitions at the limit.
//   Given the concurrency limit is filled only by question-parked defining
//         tickets
//   And one failed-testing ticket with fix attempts remaining is ready
//   When selectNextBatch/canRunInParallel are evaluated
//   Then the failed-testing ticket is selected/dispatchable (parked defining
//        frees the slot) — and is claimable via claimTicket.
//
// This makes explicit the `failed-testing` half of TASK-087 AC-1 (the existing
// scenarios above only exercise ready `todo`). The Phase-3 3-attempt cap is an
// ORCHESTRATOR-level rule (SKILL.md Phase 3) — the pure queue lib does not track
// attempts, so `attempts` here is illustrative metadata the lib never reads.
// ---------------------------------------------------------------------------
test('Scenario: a failed-testing ticket dispatches past parked definitions at the limit', () => {
  // Given the concurrency limit (2) is filled only by two question-parked
  // defining tickets (built via the real askQuestion so the parked state is genuine).
  const parkedA = askQuestion({ id: 'TASK-1', status: 'defining' }, 'Which cache layer?');
  const parkedB = askQuestion({ id: 'TASK-2', status: 'defining' }, 'What TTL?');
  assert.equal(isWaitingForAnswer(parkedA), true, 'TASK-1 is genuinely parked');
  assert.equal(isWaitingForAnswer(parkedB), true, 'TASK-2 is genuinely parked');

  // And one failed-testing ticket with fix attempts remaining is ready.
  const readyRetry = { id: 'TASK-3', status: 'failed-testing', attempts: 1 };
  const board = [{ fm: parkedA }, { fm: parkedB }, { fm: readyRetry }];
  const limit = 2;

  // When selectNextBatch/canRunInParallel are evaluated.
  // Then occupancy is 0 (both parked defs are exempt) despite two definitions at the limit.
  assert.equal(slotOccupancyCount(board), 0,
    'two parked definitions occupy zero slots — the retry is not blocked at the limit');

  const batch = selectNextBatch(board, { limit });
  const can = canRunInParallel(board, { fm: readyRetry }, { limit });

  // Then the failed-testing ticket is selected/dispatchable (parked defining frees the slot).
  assert.deepEqual(batch.map((t) => t.fm.id), ['TASK-3'],
    'the ready failed-testing retry dispatches despite parked defs at the limit');
  assert.equal(batch[0].fm.status, 'failed-testing', 'it is the failed-testing retry that dispatched');
  assert.equal(can.ok, true, 'canRunInParallel says ok');
  assert.equal(can.reason, 'ok');
  assert.ok(can.freeSlots > 0, `freeSlots > 0 (got ${can.freeSlots})`);

  // And the dispatched retry really claims into a slot (one-agent-per-ticket).
  const claimed = claimTicket(readyRetry, 'coder-2');
  assert.equal(claimed.ok, true, 'the failed-testing retry is claimable');
  assert.equal(claimed.fm.status, 'in-progress');
  assert.equal(claimed.fm.agent, 'coder-2');
});

// ---------------------------------------------------------------------------
// Scenario: Active defining still counts against the bound (edge)
//   Given a defining ticket that is being actively defined (no unanswered
//         question)
//   Then it counts toward slot occupancy per TASK-079 Part C
// ---------------------------------------------------------------------------
test('Scenario: active defining still counts against the bound (edge)', () => {
  // Given a defining ticket actively being defined (no open question) plus a
  // running build, under a limit of 2.
  const activeDef = { id: 'TASK-1', status: 'defining' };
  const running = { id: 'TASK-2', status: 'in-progress', agent: 'coder-1' };
  const readyTodo = { id: 'TASK-3', status: 'todo' };
  const board = [{ fm: activeDef }, { fm: running }, { fm: readyTodo }];
  const limit = 2;

  assert.equal(isWaitingForAnswer(activeDef), false, 'no question => actively defining, not parked');

  // Then it counts toward slot occupancy per TASK-079 Part C: 2 slots filled at limit 2.
  assert.equal(slotOccupancyCount(board), 2, 'active defining + in-progress fill the bound');

  // And the swarm is correctly at capacity — no free slot for the ready todo.
  const batch = selectNextBatch(board, { limit });
  const can = canRunInParallel(board, { fm: readyTodo }, { limit });
  assert.deepEqual(batch, [], 'no free slot when active defining counts against the bound');
  assert.equal(can.ok, false);
  assert.equal(can.reason, 'no-slots');
  assert.equal(can.freeSlots, 0);
});

// ---------------------------------------------------------------------------
// Scenario (FAILURE/EDGE): all slots consumed by ACTIVE defining => ready work
// correctly waits, proving the exemption is specific to parked, not all,
// defining.
// ---------------------------------------------------------------------------
test('Scenario: all slots consumed by ACTIVE defining => ready work waits (exemption is parked-specific)', () => {
  // Given a limit of 2 and two ACTIVELY-defining tickets (no open questions).
  const activeA = { id: 'TASK-1', status: 'defining' };
  const activeB = { id: 'TASK-2', status: 'defining' };
  const readyTodo = { id: 'TASK-3', status: 'todo' };
  const board = [{ fm: activeA }, { fm: activeB }, { fm: readyTodo }];
  const limit = 2;

  // Then both active definitions occupy slots — the bound is full.
  assert.equal(slotOccupancyCount(board), 2, 'two active definitions fill the limit');
  assert.deepEqual(selectNextBatch(board, { limit }), [], 'ready todo waits — no free slot');
  const can = canRunInParallel(board, { fm: readyTodo }, { limit });
  assert.equal(can.ok, false);
  assert.equal(can.reason, 'no-slots');
  assert.equal(can.freeSlots, 0);

  // But the moment BOTH become parked on questions, the ready todo can run —
  // demonstrating the exemption is specific to parked, not all, defining.
  const parkedA = askQuestion(activeA, 'A?');
  const parkedB = askQuestion(activeB, 'B?');
  const parkedBoard = [{ fm: parkedA }, { fm: parkedB }, { fm: readyTodo }];
  assert.equal(slotOccupancyCount(parkedBoard), 0, 'parking both frees every slot');
  assert.deepEqual(selectNextBatch(parkedBoard, { limit }).map((t) => t.fm.id), ['TASK-3'],
    'the ready todo now dispatches');
  const canParked = canRunInParallel(parkedBoard, { fm: readyTodo }, { limit });
  assert.equal(canParked.ok, true);
  assert.ok(canParked.freeSlots > 0);
});

// ---------------------------------------------------------------------------
// Scenario (EDGE): a mixed board — one parked, one active defining, one running
// build — dispatches ready work into the slot the parked ticket freed.
// ---------------------------------------------------------------------------
test('Scenario: mixed parked + active defining + running build frees exactly the parked slot', () => {
  const parked = askQuestion({ id: 'TASK-1', status: 'defining' }, 'Which region?');
  const activeDef = { id: 'TASK-2', status: 'defining' };
  const running = { id: 'TASK-3', status: 'in-progress', agent: 'coder-1' };
  const readyTodo = { id: 'TASK-4', status: 'todo' };
  const board = [{ fm: parked }, { fm: activeDef }, { fm: running }, { fm: readyTodo }];
  const limit = 3;

  // Occupancy = active defining + running = 2 (parked exempt) => 1 free slot.
  assert.equal(slotOccupancyCount(board), 2);
  const can = canRunInParallel(board, { fm: readyTodo }, { limit });
  assert.equal(can.ok, true);
  assert.equal(can.freeSlots, 1, 'exactly the parked ticket freed its slot');
  assert.deepEqual(selectNextBatch(board, { limit }).map((t) => t.fm.id), ['TASK-4']);
});

// ---------------------------------------------------------------------------
// Scenario: the SKILL contract describes the TASK-087 rule, byte-identically in
// both copies, with no model id at/after Phase 2.
// ---------------------------------------------------------------------------
test('Scenario: both SKILL.md copies document the parked-defining exemption and stay byte-identical', () => {
  // Given both copies of the orchestrate SKILL.
  const assetsSrc = readLF(ASSETS_SKILL);
  const projectSrc = readLF(PROJECT_SKILL);

  // Then each documents that a question-parked defining ticket frees its slot.
  for (const [label, src] of [['assets', assetsSrc], ['.claude', projectSrc]]) {
    assert.match(src, /parked on an unanswered BA question, which frees its slot/,
      `${label}/SKILL.md documents the parked-defining slot exemption`);
    assert.match(src, /parked definitions never starve ready/,
      `${label}/SKILL.md documents that parked definitions never starve ready work`);
  }

  // And the two copies are byte-identical (drift guard).
  const assetsBuf = fs.readFileSync(ASSETS_SKILL);
  const projectBuf = fs.readFileSync(PROJECT_SKILL);
  assert.ok(assetsBuf.equals(projectBuf),
    'assets/skills/orchestrate/SKILL.md === .claude/skills/orchestrate/SKILL.md (byte-for-byte)');
});

test('Scenario: no model id appears at or after "## Phase 2 — Build" in either SKILL copy', () => {
  const modelIdRe = /claude-(?:opus|sonnet|haiku|fable)[\w.-]*|claude-\d/i;
  for (const [label, p] of [['assets', ASSETS_SKILL], ['.claude', PROJECT_SKILL]]) {
    const src = readLF(p);
    const idx = src.indexOf('## Phase 2 — Build');
    assert.ok(idx !== -1, `${label}/SKILL.md has a "## Phase 2 — Build" heading`);
    const fromPhase2 = src.slice(idx);
    assert.ok(!modelIdRe.test(fromPhase2),
      `${label}/SKILL.md must not name a model id at/after Phase 2 (found: ${(fromPhase2.match(modelIdRe) || [''])[0]})`);
  }
});
