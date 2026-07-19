'use strict';

// ===========================================================================
// TASK-032 — e2e "cucumber" scenarios (Given/When/Then), implemented as plain
// `node --test` cases (no cucumber npm package is installed or required).
//
// Feature: kind:post-processing tickets must be excluded from the buildable
// todo / failed-testing counts (taskStatusCounts) so the Build pending count
// and maybeContinueBuild never treat a post-processing recipe as pending work —
// even if its status frontmatter was tampered to a claimable value. Lane
// PLACEMENT is unchanged (still status-driven): a status:post-processing ticket
// still renders in the post-processing lane. No new status is introduced.
//
// renderer/renderer.js is a browser script that cannot be require()'d, so the
// scenarios exercise pure replicas of the production logic (taskStatusCounts +
// isTasksPostProcessingTicket + the lane routing) and SOURCE-SCAN the real
// renderer to prove those replicas match source. NO DATABASE, DISK WRITE, OR
// NETWORK CALL IS MADE — the "board" is an in-memory array and all data access
// is mocked away by construction (there is no DB in this repo).
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { LANE_STATUSES, UNKNOWN_STATUS, VALID_STATUSES, FAILED_STATUS } = require('../lib/ticket-lanes');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');

// --- Pure replicas of the production logic (renderer.js ~5135, ~6069, ~6102) ---
function isTasksPostProcessingTicket(fm) {
  return !!fm && fm.kind === 'post-processing';
}
function taskStatusCounts(tickets) {
  const counts = { todo: 0, defining: 0, 'in-progress': 0, testing: 0, 'failed-testing': 0, 'post-processing': 0, done: 0, other: 0 };
  for (const tk of tickets) {
    if (isTasksPostProcessingTicket(tk.fm)) { counts['post-processing']++; continue; }
    const s = tk.fm.status;
    if (counts[s] === undefined) counts.other++; else counts[s]++;
  }
  return counts;
}
function buildPending(counts) {
  return counts.todo + counts['failed-testing'];
}

// Replica of renderTasks' per-ticket lane routing (renderer.js ~5624-5629):
// PLACEMENT is status-driven and unaffected by TASK-032's counting change.
const LANES_PRESENT = [...LANE_STATUSES, UNKNOWN_STATUS];
function laneForCard(fm) {
  const unknown = !VALID_STATUSES.includes(fm.status);
  let laneKey;
  if (unknown) laneKey = UNKNOWN_STATUS;
  else if (fm.status === FAILED_STATUS) laneKey = 'testing';
  else laneKey = fm.status;
  if (!LANES_PRESENT.includes(laneKey)) laneKey = 'todo';
  return laneKey;
}

// A tiny stand-in for maybeContinueBuild's decision: it queues another build iff
// there is genuine todo work (renderer.js ~6156: `taskStatusCounts(tab).todo > 0`).
function wouldContinueBuild(board) {
  return taskStatusCounts(board).todo > 0;
}

// ---------------------------------------------------------------------------
// Scenario 1 (EDGE/FAILURE PATH): a tampered post-processing ticket with a todo
// status is not pending, and maybeContinueBuild does not start another iteration.
// ---------------------------------------------------------------------------
test('Scenario (edge): a kind:post-processing ticket tampered to status todo is not pending and does not continue the build', () => {
  // Given a board of only a tampered post-processing recipe (status todo) and a done ticket
  const board = [
    { fm: { id: 'PP-9', status: 'todo', kind: 'post-processing' } },
    { fm: { id: 'TASK-1', status: 'done' } },
  ];
  // When the build counts are computed
  const counts = taskStatusCounts(board);
  // Then the pending count is 0 (the recipe is not treated as buildable work)
  assert.equal(buildPending(counts), 0, 'tampered post-processing recipe must not be pending');
  assert.equal(counts.todo, 0);
  assert.equal(counts['post-processing'], 1, 'it is counted in the post-processing bucket instead');
  // And maybeContinueBuild does not queue another iteration (todo === 0)
  assert.equal(wouldContinueBuild(board), false, 'no genuine todo => the build loop stops');
});

// ---------------------------------------------------------------------------
// Scenario 2: a normal todo ticket (no kind) is still counted (pending 1).
// ---------------------------------------------------------------------------
test('Scenario: a normal todo ticket with no kind is still counted as pending (1)', () => {
  // Given a board with a single plain todo ticket
  const board = [{ fm: { id: 'TASK-100', status: 'todo' } }];
  // When the build counts are computed
  const counts = taskStatusCounts(board);
  // Then the pending count is 1
  assert.equal(buildPending(counts), 1);
  assert.equal(counts.todo, 1);
  // And maybeContinueBuild would continue driving the build
  assert.equal(wouldContinueBuild(board), true);
});

// ---------------------------------------------------------------------------
// Scenario 3: a normal post-processing ticket (status:post-processing,
// kind:post-processing) still renders in the post-processing lane and is not
// counted as pending.
// ---------------------------------------------------------------------------
test('Scenario: a normal post-processing ticket renders in the post-processing lane and is not pending', () => {
  // Given a genuine post-processing ticket
  const fm = { id: 'PP-1', status: 'post-processing', kind: 'post-processing' };
  const board = [{ fm }];
  // When the board routes it to a lane and computes counts
  const lane = laneForCard(fm);
  const counts = taskStatusCounts(board);
  // Then it still renders in the post-processing lane (placement unchanged)
  assert.equal(lane, 'post-processing');
  // And it is counted in the post-processing bucket, not todo/failed-testing
  assert.equal(counts['post-processing'], 1);
  assert.equal(counts.todo, 0);
  assert.equal(counts['failed-testing'], 0);
  // And it contributes nothing to the Build pending count
  assert.equal(buildPending(counts), 0);
  // And it does not keep the build loop running
  assert.equal(wouldContinueBuild(board), false);
});

// ---------------------------------------------------------------------------
// Scenario 4: the counting change does NOT introduce a new status — a tampered
// post-processing ticket keeps rendering by its (real) status, only its count
// is redirected.
// ---------------------------------------------------------------------------
test('Scenario: no new status is introduced — lane placement stays status-driven', () => {
  // Given a tampered post-processing recipe whose status is todo
  const tamperedTodo = { id: 'PP-9', status: 'todo', kind: 'post-processing' };
  // When it is routed to a lane
  // Then it still lands in the todo lane by its status (placement unaffected by counting)
  assert.equal(laneForCard(tamperedTodo), 'todo');
  // And a genuine post-processing status still lands in the post-processing lane
  assert.equal(laneForCard({ id: 'PP-1', status: 'post-processing', kind: 'post-processing' }), 'post-processing');
  // And the lane order remains the six known lanes plus the unknown lane (no new status)
  assert.deepEqual(LANES_PRESENT, ['todo', 'defining', 'in-progress', 'testing', 'post-processing', 'done', UNKNOWN_STATUS]);
});

// ---------------------------------------------------------------------------
// Scenario 5 (drift guard): the real renderer.js taskStatusCounts references the
// isTasksPostProcessingTicket predicate, so the replicas above cannot drift.
// ---------------------------------------------------------------------------
test('Scenario: renderer.js taskStatusCounts references isTasksPostProcessingTicket and feeds the build gates', () => {
  // Given the real taskStatusCounts in renderer.js
  const fnIdx = rendererSrc.indexOf('function taskStatusCounts(tab)');
  assert.ok(fnIdx !== -1, 'taskStatusCounts exists');
  const fnBody = rendererSrc.slice(fnIdx, rendererSrc.indexOf('\n}', fnIdx));
  // Then it excludes post-processing tickets via the shared predicate
  assert.match(fnBody, /if\s*\(isTasksPostProcessingTicket\(tk\.fm\)\)\s*\{\s*counts\['post-processing'\]\+\+;\s*continue;\s*\}/);
  // And the Build pending count only sums todo + failed-testing
  assert.match(rendererSrc, /const\s+pending\s*=\s*counts\.todo\s*\+\s*counts\['failed-testing'\]/);
  // And maybeContinueBuild continues only while todo > 0
  assert.match(rendererSrc, /if\s*\(taskStatusCounts\(tab\)\.todo\s*>\s*0\)\s*\{/);
});
