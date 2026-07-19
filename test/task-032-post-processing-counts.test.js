'use strict';

// ===========================================================================
// TASK-032 — UNIT tests for taskStatusCounts' kind:post-processing exclusion.
//
// renderer/renderer.js is a browser script that CANNOT be require()'d, so the
// repo convention (see test/ticket-lanes.test.js, test/task-028-post-
// processing.e2e.test.js) is to (a) replicate the *pure* logic verbatim in the
// test and unit-test its behaviour, and (b) SOURCE-SCAN the real renderer to
// prove the copy has not drifted from source. Both are done here.
//
// NO DATABASE, DISK WRITE, OR NETWORK CALL IS MADE. The "board" is a plain
// in-memory array; there is no DB in this repo, so all data access is mocked
// away by construction.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');

// ---------------------------------------------------------------------------
// Pure replicas of the production logic (renderer.js ~5135 and ~6069). Kept
// byte-faithful to the source; the source-scan tests below guard against drift.
// ---------------------------------------------------------------------------
const POST_PROCESSING_KIND = 'post-processing';

function isTasksPostProcessingTicket(fm) {
  return !!fm && fm.kind === POST_PROCESSING_KIND;
}

// Replica of taskStatusCounts' bucketing loop. Takes an iterable of {fm}.
function taskStatusCounts(tickets) {
  const counts = { todo: 0, defining: 0, 'in-progress': 0, testing: 0, 'failed-testing': 0, 'post-processing': 0, done: 0, other: 0 };
  for (const tk of tickets) {
    if (isTasksPostProcessingTicket(tk.fm)) { counts['post-processing']++; continue; }
    const s = tk.fm.status;
    if (counts[s] === undefined) counts.other++; else counts[s]++;
  }
  return counts;
}

// Replica of updateBuildBtn's pending formula (renderer.js ~6102).
function buildPending(counts) {
  return counts.todo + counts['failed-testing'];
}

// ---------------------------------------------------------------------------
// isTasksPostProcessingTicket predicate
// ---------------------------------------------------------------------------
test('isTasksPostProcessingTicket is true purely by kind, regardless of status', () => {
  assert.equal(isTasksPostProcessingTicket({ kind: 'post-processing', status: 'post-processing' }), true);
  assert.equal(isTasksPostProcessingTicket({ kind: 'post-processing', status: 'todo' }), true);
  assert.equal(isTasksPostProcessingTicket({ kind: 'post-processing', status: 'failed-testing' }), true);
  assert.equal(isTasksPostProcessingTicket({ status: 'todo' }), false);
  assert.equal(isTasksPostProcessingTicket({ kind: 'other', status: 'todo' }), false);
  assert.equal(isTasksPostProcessingTicket(null), false);
  assert.equal(isTasksPostProcessingTicket(undefined), false);
});

// ---------------------------------------------------------------------------
// taskStatusCounts bucketing — the core TASK-032 behaviour
// ---------------------------------------------------------------------------
test('a normal todo ticket (no kind) counts in the todo bucket', () => {
  const counts = taskStatusCounts([{ fm: { id: 'T1', status: 'todo' } }]);
  assert.equal(counts.todo, 1);
  assert.equal(counts['post-processing'], 0);
  assert.equal(buildPending(counts), 1);
});

test('a status:post-processing kind:post-processing ticket counts in post-processing, not todo', () => {
  const counts = taskStatusCounts([{ fm: { id: 'PP1', status: 'post-processing', kind: 'post-processing' } }]);
  assert.equal(counts['post-processing'], 1);
  assert.equal(counts.todo, 0);
  assert.equal(counts['failed-testing'], 0);
  assert.equal(buildPending(counts), 0);
});

test('a tampered kind:post-processing ticket with status todo is NOT counted as todo', () => {
  const counts = taskStatusCounts([{ fm: { id: 'PP2', status: 'todo', kind: 'post-processing' } }]);
  assert.equal(counts.todo, 0, 'tampered todo status must not count in todo');
  assert.equal(counts['post-processing'], 1, 'counted in post-processing by kind');
  assert.equal(buildPending(counts), 0);
});

test('a tampered kind:post-processing ticket with status failed-testing is NOT counted as failed-testing', () => {
  const counts = taskStatusCounts([{ fm: { id: 'PP3', status: 'failed-testing', kind: 'post-processing' } }]);
  assert.equal(counts['failed-testing'], 0, 'tampered failed-testing status must not count in failed-testing');
  assert.equal(counts['post-processing'], 1);
  assert.equal(buildPending(counts), 0);
});

test('Build pending count excludes post-processing tickets across a mixed board', () => {
  const board = [
    { fm: { id: 'T1', status: 'todo' } },
    { fm: { id: 'T2', status: 'failed-testing' } },
    { fm: { id: 'PP1', status: 'post-processing', kind: 'post-processing' } },
    { fm: { id: 'PP2', status: 'todo', kind: 'post-processing' } },        // tampered
    { fm: { id: 'PP3', status: 'failed-testing', kind: 'post-processing' } }, // tampered
    { fm: { id: 'D1', status: 'done' } },
  ];
  const counts = taskStatusCounts(board);
  assert.equal(counts.todo, 1, 'only the genuine todo ticket');
  assert.equal(counts['failed-testing'], 1, 'only the genuine failed-testing ticket');
  assert.equal(counts['post-processing'], 3, 'all three kind:post-processing tickets');
  assert.equal(counts.done, 1);
  assert.equal(buildPending(counts), 2, 'pending = 1 todo + 1 failed-testing, no post-processing');
});

test('an out-of-enum status still lands in other, and is not confused with post-processing', () => {
  const counts = taskStatusCounts([{ fm: { id: 'X', status: 'bogus' } }]);
  assert.equal(counts.other, 1);
  assert.equal(counts['post-processing'], 0);
  assert.equal(counts.todo, 0);
});

// ---------------------------------------------------------------------------
// maybeContinueBuild's continue predicate (todo > 0). A board of only
// post-processing + done tickets must yield a todo count of 0 (do not continue).
// ---------------------------------------------------------------------------
test('maybeContinueBuild continue predicate: post-processing + done board => todo 0 (stop)', () => {
  const board = [
    { fm: { id: 'PP1', status: 'post-processing', kind: 'post-processing' } },
    { fm: { id: 'PP2', status: 'todo', kind: 'post-processing' } }, // tampered, must not count
    { fm: { id: 'D1', status: 'done' } },
  ];
  const counts = taskStatusCounts(board);
  assert.equal(counts.todo, 0, 'no genuine todo work => maybeContinueBuild does not queue another build');
});

test('maybeContinueBuild continue predicate: a genuine todo alongside post-processing => todo > 0 (continue)', () => {
  const board = [
    { fm: { id: 'T1', status: 'todo' } },
    { fm: { id: 'PP1', status: 'post-processing', kind: 'post-processing' } },
  ];
  const counts = taskStatusCounts(board);
  assert.ok(counts.todo > 0, 'genuine todo keeps the build loop going');
  assert.equal(counts.todo, 1);
});

// ---------------------------------------------------------------------------
// SOURCE-SCAN drift guards: prove the real renderer.js implements exactly this.
// ---------------------------------------------------------------------------
test('renderer.js taskStatusCounts delegates the exclusion to isTasksPostProcessingTicket', () => {
  const fnIdx = rendererSrc.indexOf('function taskStatusCounts(tab)');
  assert.ok(fnIdx !== -1, 'taskStatusCounts exists in renderer.js');
  const fnBody = rendererSrc.slice(fnIdx, rendererSrc.indexOf('\n}', fnIdx));
  // The exclusion routes kind:post-processing into the post-processing bucket and skips it.
  assert.match(fnBody, /if\s*\(isTasksPostProcessingTicket\(tk\.fm\)\)\s*\{\s*counts\['post-processing'\]\+\+;\s*continue;\s*\}/);
  // The remainder is the plain status bucketing.
  assert.match(fnBody, /const\s+s\s*=\s*tk\.fm\.status;/);
  assert.match(fnBody, /if\s*\(counts\[s\]\s*===\s*undefined\)\s*counts\.other\+\+;\s*else\s*counts\[s\]\+\+;/);
});

test('renderer.js isTasksPostProcessingTicket keys purely on kind === post-processing', () => {
  assert.match(rendererSrc, /const\s+TASKS_POST_PROCESSING_KIND\s*=\s*'post-processing'/);
  assert.match(rendererSrc, /function\s+isTasksPostProcessingTicket\(fm\)\s*\{\s*return\s*!!fm\s*&&\s*fm\.kind\s*===\s*TASKS_POST_PROCESSING_KIND;\s*\}/);
});

test('renderer.js Build pending formula is todo + failed-testing (no post-processing term)', () => {
  assert.match(rendererSrc, /const\s+pending\s*=\s*counts\.todo\s*\+\s*counts\['failed-testing'\]/);
  // And maybeContinueBuild continues on todo > 0 only.
  assert.match(rendererSrc, /if\s*\(taskStatusCounts\(tab\)\.todo\s*>\s*0\)\s*\{/);
});
