'use strict';

// ===========================================================================
// TASK-079 — e2e "cucumber" scenarios (Given/When/Then), implemented as plain
// `node --test` cases. NO `cucumber` npm package is installed or added.
//
// Feature: newly added tickets are defined in parallel, then built when a slot
// frees. Three coordinated changes are exercised end-to-end:
//   Part A (renderer): creating a ticket auto-queues an "/orchestrate build" run
//           even with auto-build off, guarded so no second overlapping run starts.
//   Part B (SKILL.md): Phase 2 intake defines an undefined new todo ticket via
//           orchestrate-ba BEFORE any claim/build; both copies byte-identical.
//   Part C (lib): `defining` counts against the concurrency bound, without
//           changing isActive/ACTIVE_STATUSES, and stays not claimable.
//
// renderer/renderer.js is a BROWSER script (references `document`, no
// module.exports), so — matching the repo convention (task-075-type-bar.e2e,
// window-attention.e2e) — Part A is driven by a FAITHFUL source-scanned mirror of
// autoQueueBuildOnCreate + its single-run guard, PLUS tight source-scan drift
// guards tying that mirror to the real function and its three call sites. The
// behavioural Part B/C scenarios drive the REAL lib/ticket-queue.js +
// lib/ticket-definition.js helpers. Both SKILL copies are read as fixtures.
//
// NO DATABASE, NO REAL FILESYSTEM WRITE, NO NETWORK, NO IPC. The "board" is an
// in-memory array of frontmatter objects; the only real I/O is reading the app's
// OWN source (renderer.js, SKILL.md) as text fixtures.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  isTicketDefined,
  PLACEHOLDER_CRITERION,
} = require('../lib/ticket-definition');
const {
  selectNextBatch,
  canRunInParallel,
  claimTicket,
  slotOccupancyCount,
  isActive,
} = require('../lib/ticket-queue');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');
const PROJECT_SKILL = path.join(REPO, '.claude', 'skills', 'orchestrate', 'SKILL.md');
const ASSETS_SKILL = path.join(REPO, 'assets', 'skills', 'orchestrate', 'SKILL.md');

// ---------------------------------------------------------------------------
// Part A: faithful mirror of the renderer's Part A wiring.
//
// Mirrors autoQueueBuildOnCreate (renderer.js ~6603) and the single-run guard it
// shares with maybeContinueBuild. Only the state it reads/writes is modelled: a
// fake `tab` with { folder, status, queueFiring, promptQueue, tasks }. queueBuild
// is mocked to push the build command onto promptQueue (no real dispatch). Drift
// guards below tie this mirror to the real source.
// ---------------------------------------------------------------------------
const BUILD_COMMAND = '/orchestrate build';
function isBuildCommand(p) {
  return typeof p === 'string' && (p === BUILD_COMMAND || p.startsWith(BUILD_COMMAND + ' '));
}
function mockQueueBuild(tab) {
  // Mirrors queueBuild: push the argumented build command onto the prompt queue.
  tab.promptQueue.push(BUILD_COMMAND + ' --concurrency 3');
}
function autoQueueBuildOnCreate(tab) {
  if (!tab || !tab.folder) return;
  const t = tab.tasks;
  if (!t || !t.skillInstalled) return;              // no skill installed -> no build run
  if (t.autoBuild) return;                          // the continuous loop already drives it
  if (tab.status !== 'finished') return;            // a run is in flight / Claude not idle-ready
  if (tab.queueFiring) return;                      // mid-dispatch, don't stack
  if (tab.promptQueue.some(isBuildCommand)) return; // a build run is already queued
  mockQueueBuild(tab);
}
function makeTab(overrides) {
  return Object.assign({
    folder: '/proj',
    status: 'finished',
    queueFiring: false,
    promptQueue: [],
    tasks: { skillInstalled: true, autoBuild: false },
  }, overrides || {});
}
const buildRunsQueued = (tab) => tab.promptQueue.filter(isBuildCommand).length;

// A defined body (real AC + non-empty gherkin) and the New-ticket skeleton.
const DEFINED_BODY = [
  '## Acceptance Criteria',
  '- [ ] Real criterion one',
  '- [ ] Real criterion two',
  '',
  '## Cucumber Tests',
  '```gherkin',
  'Feature: F',
  '  Scenario: S',
  '    Given a',
  '    Then b',
  '```',
].join('\n');
const SKELETON_BODY = [
  '',
  '## Description',
  'What needs doing and why.',
  '',
  '## Acceptance Criteria',
  PLACEHOLDER_CRITERION,
  '',
  '## Additional Context',
  '(User-owned. Read it before building. Never overwrite it.)',
  '',
].join('\n');

// ===========================================================================
// Scenario: A skeleton board-created ticket is not "defined"
// ===========================================================================
test('Scenario: a skeleton board-created ticket is not "defined"', () => {
  // Given a ticket body exactly matching the New-ticket modal template
  // When isTicketDefined evaluates it
  // Then the verdict is false
  assert.equal(isTicketDefined(SKELETON_BODY), false);
});

// ===========================================================================
// Scenario: A BA-completed ticket is "defined"
// ===========================================================================
test('Scenario: a BA-completed ticket (two real AC + gherkin fence) is "defined"', () => {
  // Given a ticket body with two real acceptance-criteria checkboxes
  // And a "## Cucumber Tests" section containing a non-empty gherkin fence
  // When isTicketDefined evaluates it
  // Then the verdict is true
  assert.equal(isTicketDefined(DEFINED_BODY), true);
});

// ===========================================================================
// Scenario: Creating a ticket auto-queues a build run (Part A)
// ===========================================================================
test('Scenario: creating a ticket auto-queues a build run; a second create while it is active does NOT', () => {
  // Given the auto-build toggle is off and no build run is active
  const tab = makeTab();
  assert.equal(tab.tasks.autoBuild, false, 'auto-build toggle is off');
  assert.equal(buildRunsQueued(tab), 0, 'no build run queued yet');
  // When the user creates a ticket from the New-ticket modal
  autoQueueBuildOnCreate(tab);
  // Then an "/orchestrate build" run is queued/triggered
  assert.equal(buildRunsQueued(tab), 1, 'a build run is queued on create even with auto-build off');
  // And creating a second ticket while that run is active does not launch a second run
  autoQueueBuildOnCreate(tab);
  assert.equal(buildRunsQueued(tab), 1, 'a build command is already queued -> no second overlapping run');
});

test('Scenario (Part A guard): no second run when the continuous auto-build loop is already on', () => {
  const tab = makeTab({ tasks: { skillInstalled: true, autoBuild: true } });
  autoQueueBuildOnCreate(tab);
  assert.equal(buildRunsQueued(tab), 0, 'autoBuild loop already drives it -> auto-create is a no-op');
});

test('Scenario (Part A guard): no run when the skill is not installed / Claude is mid-run / mid-dispatch / no folder', () => {
  // Skill not installed
  let tab = makeTab({ tasks: { skillInstalled: false, autoBuild: false } });
  autoQueueBuildOnCreate(tab);
  assert.equal(buildRunsQueued(tab), 0, 'no skill -> no run');
  // Claude not idle-ready (a run is in flight)
  tab = makeTab({ status: 'running' });
  autoQueueBuildOnCreate(tab);
  assert.equal(buildRunsQueued(tab), 0, 'status !== finished -> no run');
  // Mid-dispatch
  tab = makeTab({ queueFiring: true });
  autoQueueBuildOnCreate(tab);
  assert.equal(buildRunsQueued(tab), 0, 'queueFiring -> no run');
  // No folder open
  tab = makeTab({ folder: null });
  autoQueueBuildOnCreate(tab);
  assert.equal(buildRunsQueued(tab), 0, 'no folder -> no run');
});

test('DRIFT GUARD (Part A): the real autoQueueBuildOnCreate exists, reuses the single-run guard, and calls queueBuild', () => {
  const start = rendererSrc.indexOf('function autoQueueBuildOnCreate(tab) {');
  assert.ok(start !== -1, 'autoQueueBuildOnCreate is defined in renderer.js');
  const end = rendererSrc.indexOf('\n}', start);
  const body = rendererSrc.slice(start, end);
  // The same guard sequence maybeContinueBuild relies on.
  assert.match(body, /if \(!tab \|\| !tab\.folder\) return;/, 'guards a missing folder');
  assert.match(body, /if \(!t \|\| !t\.skillInstalled\) return;/, 'guards skill-not-installed');
  assert.match(body, /if \(t\.autoBuild\) return;/, 'no-op when the auto-build loop is already on');
  assert.match(body, /if \(tab\.status !== 'finished'\) return;/, 'no-op when Claude is not idle-ready');
  assert.match(body, /if \(tab\.queueFiring\) return;/, 'no-op mid-dispatch');
  assert.match(body, /if \(tab\.promptQueue\.some\(isBuildCommand\)\) return;/, 'no second run when one is already queued');
  assert.match(body, /queueBuild\(tab\);/, 'reuses queueBuild rather than a new mechanism');
});

test('DRIFT GUARD (Part A): autoQueueBuildOnCreate is wired into the three creation paths (New-ticket todo-only, bug, Slack)', () => {
  // New-ticket create is todo-only (post-processing tickets are never built).
  assert.match(rendererSrc, /if \(status === 'todo'\) autoQueueBuildOnCreate\(tab\);/,
    'onCreateNormal calls it only for a todo ticket');
  // Bug create (a plain todo) and Slack create both call it unconditionally.
  const bugIdx = rendererSrc.indexOf('const onCreateBug');
  const slackIdx = rendererSrc.indexOf('async function handleCreateTicketReply');
  assert.ok(bugIdx !== -1 && slackIdx !== -1, 'both bug-create and Slack-create paths present');
  assert.match(rendererSrc.slice(bugIdx, slackIdx), /autoQueueBuildOnCreate\(tab\);/,
    'onCreateBug calls autoQueueBuildOnCreate');
  assert.match(rendererSrc.slice(slackIdx, slackIdx + 4000), /autoQueueBuildOnCreate\(tab\);/,
    'handleCreateTicketReply (Slack) calls autoQueueBuildOnCreate');
});

test('DRIFT GUARD (Part A): buildCommandFor emits the argumented "/orchestrate build --concurrency" the mirror assumes', () => {
  assert.match(rendererSrc, /const BUILD_COMMAND = '\/orchestrate build';/);
  assert.match(rendererSrc, /return BUILD_COMMAND \+ ' --concurrency ' \+ currentTasksConcurrency\(tab\);/,
    'the queued command is the argumented build form isBuildCommand recognises');
});

// ===========================================================================
// Scenario: Defining counts against the concurrency bound (Part C)
// ===========================================================================
test('Scenario: defining counts against the bound; a defining ticket is never returned as claimable', () => {
  // Given a limit of 3 with 1 ticket in-progress and 1 ticket in "defining"
  const board = [
    { fm: { id: 'TASK-1', status: 'in-progress', agent: 'coder-1' } },
    { fm: { id: 'TASK-2', status: 'defining' } },
    { fm: { id: 'TASK-3', status: 'todo' } },
    { fm: { id: 'TASK-4', status: 'todo' } },
  ];
  // When selectNextBatch computes free slots
  const batch = selectNextBatch(board, { limit: 3 });
  // Then free slots = 1 (3 minus in-progress minus defining)
  assert.equal(batch.length, 1, 'exactly one free slot');
  assert.equal(slotOccupancyCount(board), 2, 'in-progress + defining occupy 2 slots');
  // And a defining ticket is never returned as claimable
  assert.ok(!batch.some((t) => t.fm.status === 'defining'), 'defining ticket never dispatched');
  assert.deepEqual(batch.map((t) => t.fm.id), ['TASK-3']);
});

// ===========================================================================
// Scenario: A defined ticket dispatches into a free slot
// ===========================================================================
test('Scenario: a defined ticket (just back from defining to todo) dispatches into a free slot', () => {
  // Given a board with 2 slot-occupying tickets under a limit of 3
  const board = [
    { fm: { id: 'TASK-1', status: 'in-progress', agent: 'coder-1' } },
    { fm: { id: 'TASK-2', status: 'testing', agent: 'coder-2' } },
  ];
  // And a ticket that just returned from defining to "todo"
  const newTicket = { fm: { id: 'TASK-9', status: 'todo' } };
  assert.equal(isTicketDefined(DEFINED_BODY), true, 'its body is now defined by the BA');
  // When canRunInParallel is evaluated for it
  const r = canRunInParallel(board, newTicket, { limit: 3, agentId: 'coder-9' });
  // Then the verdict is ok with 1 free slot
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'ok');
  assert.equal(r.freeSlots, 1);
  // And claimTicket grants the claim setting status in-progress
  const claim = claimTicket(newTicket.fm, 'coder-9');
  assert.equal(claim.ok, true);
  assert.equal(claim.fm.status, 'in-progress');
  assert.equal(claim.fm.agent, 'coder-9');
});

// ===========================================================================
// Scenario: A defined ticket waits when the bound is full
// ===========================================================================
test('Scenario: a defined ticket waits when the slot-occupancy count equals the limit', () => {
  // Given a board whose slot-occupying count equals the limit (incl. a defining)
  const board = [
    { fm: { id: 'TASK-1', status: 'in-progress', agent: 'coder-1' } },
    { fm: { id: 'TASK-2', status: 'testing', agent: 'coder-2' } },
    { fm: { id: 'TASK-3', status: 'defining' } },
  ];
  assert.equal(slotOccupancyCount(board), 3, 'board is full at the bound');
  // And a ticket that just returned from defining to "todo"
  const newTicket = { fm: { id: 'TASK-9', status: 'todo' } };
  // When canRunInParallel is evaluated for it
  const r = canRunInParallel(board, newTicket, { limit: 3 });
  // Then the verdict is not ok with reason "no-slots"
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-slots');
  assert.equal(r.freeSlots, 0);
  // And the ticket remains in "todo" unclaimed (canRunInParallel never mutates it)
  assert.equal(newTicket.fm.status, 'todo');
  assert.equal(newTicket.fm.agent, undefined);
});

// ===========================================================================
// Scenario: The SKILL routes undefined new tickets through the BA first
// ===========================================================================
test('Scenario: both SKILL copies route undefined new tickets to defining + orchestrate-ba first, and are byte-identical', () => {
  // Given both copies of the orchestrate SKILL
  const projectSrc = fs.readFileSync(PROJECT_SKILL, 'utf8');
  const assetsSrc = fs.readFileSync(ASSETS_SKILL, 'utf8');
  for (const [label, src] of [['.claude', projectSrc], ['assets', assetsSrc]]) {
    // Then Phase 2's intake instructs setting status defining and dispatching orchestrate-ba
    assert.match(src, /Set `status: defining`/, `${label}: intake sets status defining`);
    assert.match(src, /Task tool,\s*`orchestrate-ba`;\s*fall back to[\s\S]*?`general-purpose`/,
      `${label}: dispatches orchestrate-ba with the general-purpose fallback wording`);
    // And it references isTicketDefined in lib/ticket-definition.js
    assert.match(src, /isTicketDefined\(body\)/, `${label}: references isTicketDefined(body)`);
    assert.match(src, /lib\/ticket-definition\.js/, `${label}: names lib/ticket-definition.js`);
    // And define happens BEFORE any claim/build of it.
    assert.match(src, /define it FIRST \(BA before any claim\/build\)/i, `${label}: BA before claim/build`);
    // And the mid-build BA dispatch references the routing directive INDIRECTLY —
    // it must NOT name a literal model id in Phase 2 (TASK-051 invariant: the
    // sonnet-5/opus-4-8 routing directive lives ONLY before Phase 2).
    assert.match(src, /dispatched on the BA's premium tier/i,
      `${label}: Phase 2 BA dispatch references the routed premium tier indirectly`);
    assert.match(src, /see \*\*Model\s+routing\*\*/i,
      `${label}: Phase 2 points back to the Model routing directive`);
    // And NO literal model id appears at/after the `## Phase 2 — Build` heading.
    const phase2Idx = src.indexOf('## Phase 2 — Build');
    assert.ok(phase2Idx !== -1, `${label}: the "## Phase 2 — Build" heading is present`);
    assert.doesNotMatch(src.slice(phase2Idx), /claude-sonnet-5|claude-opus-4-8/,
      `${label}: no literal model id (claude-sonnet-5/claude-opus-4-8) at/after the Phase 2 heading`);
    // And the literal sonnet-5/opus-4-8 routing directive still lives before Phase 2.
    assert.match(src.slice(0, phase2Idx), /claude-sonnet-5[\s\S]*?claude-opus-4-8/,
      `${label}: the literal sonnet-5/opus-4-8 model routing directive remains before Phase 2`);
    // And already-defined tickets skip the BA; post-processing is excluded.
    assert.match(src, /Already-defined `todo` ticket → skip the BA/, `${label}: already-defined skips BA`);
    assert.match(src, /kind: post-processing` ticket is \*\*never\*\* defined or\s*dispatched/, `${label}: post-processing excluded`);
    // And a BA question parks only that ticket while the swarm continues.
    assert.match(src, /That ticket alone\*\* stays in `defining`/, `${label}: question parks only that ticket`);
  }
  // And the two copies are byte-identical
  assert.ok(fs.readFileSync(PROJECT_SKILL).equals(fs.readFileSync(ASSETS_SKILL)),
    'the two SKILL.md copies are byte-identical (drift guard)');
});

// ===========================================================================
// Scenario: Edge - a BA question parks only that ticket
// ===========================================================================
test('Scenario (edge): a BA question parks only that ticket; other todo tickets are still selected and built', () => {
  // Given a mid-build ticket in "defining" whose BA raised a question (question set,
  // answer empty) alongside THREE other buildable todo tickets, under limit 3.
  const parked = { fm: { id: 'TASK-5', status: 'defining', question: 'Which API?', answer: '' } };
  const board = [
    parked,
    { fm: { id: 'TASK-6', status: 'todo' } },
    { fm: { id: 'TASK-7', status: 'todo' } },
    { fm: { id: 'TASK-8', status: 'todo' } },
  ];
  // When the question has no answer yet
  // Then that ticket stays in "defining" (it is not claimable and never dispatched)
  const batch = selectNextBatch(board, { limit: 3 });
  assert.ok(!batch.some((t) => t.fm.id === 'TASK-5'), 'the parked defining ticket is not dispatched');
  assert.equal(parked.fm.status, 'defining', 'it stays parked in defining');
  // And — post-TASK-087 — a question-parked `defining` ticket occupies ZERO concurrency
  // slots (isSlotOccupyingTicket exempts a ticket waiting on an unanswered BA question),
  // so it never starves ready work: free slots = 3 - 0 parked defining = 3, and ALL THREE
  // todos dispatch. Assert the occupancy directly so a regression that made parked
  // defining count again (occupancy 1 -> free 2) would drop TASK-8 and FAIL here, rather
  // than passing merely because the todo count coincided with the free-slot count.
  assert.equal(slotOccupancyCount(board), 0, 'a parked (question-blocked) defining ticket holds no slot');
  assert.deepEqual(batch.map((t) => t.fm.id), ['TASK-6', 'TASK-7', 'TASK-8'],
    'all three todos fit because the parked defining frees its slot (3 - 0 = 3)');
  for (const t of batch) {
    const claim = claimTicket(t.fm, `coder-${t.fm.id}`);
    assert.equal(claim.ok, true, `${t.fm.id} is claimable/buildable`);
  }

  // And CONTRAST: the same ticket ACTIVELY defining (no open question) DOES hold a slot,
  // exactly like in-progress/testing (TASK-079 Part C). With one active-defining slot
  // taken, free slots = 3 - 1 = 2, so only TWO of the three todos dispatch. This makes the
  // scenario distinguish parked (0 slots) from active (1 slot): if active-defining ever
  // stopped counting (occupancy 0 -> free 3 -> all three dispatch) this deepEqual FAILS.
  const activeBoard = [
    { fm: { id: 'TASK-5', status: 'defining' } }, // actively defining: no open question
    { fm: { id: 'TASK-6', status: 'todo' } },
    { fm: { id: 'TASK-7', status: 'todo' } },
    { fm: { id: 'TASK-8', status: 'todo' } },
  ];
  assert.equal(slotOccupancyCount(activeBoard), 1, 'an actively-defining ticket holds one slot');
  const activeBatch = selectNextBatch(activeBoard, { limit: 3 });
  assert.deepEqual(activeBatch.map((t) => t.fm.id), ['TASK-6', 'TASK-7'],
    'active defining consumes a slot, so only two of the three todos dispatch (3 - 1 = 2)');
});

// ===========================================================================
// Scenario: Edge - post-processing ticket is never defined or dispatched
// ===========================================================================
test('Scenario (edge): a post-processing ticket is never defined or dispatched', () => {
  // Given a newly created ticket with kind post-processing
  const pp = { fm: { id: 'TASK-8', status: 'todo', kind: 'post-processing' } };
  const board = [pp];
  // When the intake rules are applied
  // Then no BA dispatch occurs (it is excluded from selectNextBatch) ...
  const batch = selectNextBatch(board, { limit: 3 });
  assert.ok(!batch.some((t) => t.fm.id === 'TASK-8'), 'post-processing ticket never selected');
  // ... and canRunInParallel reports post-processing
  const r = canRunInParallel([], pp, { limit: 3 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'post-processing');
  // And claimTicket likewise refuses it as post-processing.
  const claim = claimTicket(pp.fm, 'coder-1');
  assert.equal(claim.ok, false);
  assert.equal(claim.reason, 'post-processing');
});

// ===========================================================================
// Scenario: Edge - junk input never throws
// ===========================================================================
test('Scenario (edge): isTicketDefined receives null, 42, "" and an object -> each false, nothing throws', () => {
  for (const junk of [null, 42, '', {}]) {
    let out;
    assert.doesNotThrow(() => { out = isTicketDefined(junk); }, `${String(junk)} does not throw`);
    assert.equal(out, false, `${JSON.stringify(junk)} -> false`);
  }
});

// ===========================================================================
// Scenario: Edge - post-processing / a still-defining ticket never lights the
// board's "being worked on" dot (Part C must not regress isActive)
// ===========================================================================
test('Scenario (edge): a defining ticket occupies a slot but is NOT "active" (board dot unaffected)', () => {
  // Given a ticket parked in defining
  const defining = { status: 'defining' };
  // Then it counts toward slot occupancy but not toward the active/"being worked on" set
  assert.equal(slotOccupancyCount([{ fm: defining }]), 1, 'defining occupies a slot');
  assert.equal(isActive('defining'), false, 'defining never lights the board dot');
});
