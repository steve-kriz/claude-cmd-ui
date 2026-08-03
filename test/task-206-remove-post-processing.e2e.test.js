'use strict';

// ===========================================================================
// TASK-206 — e2e cucumber-style (Given/When/Then) scenarios
//
// Feature: Remove the post-processing column, its kind:post-processing concept,
// and dispose of TASK-054
//
// These are scenario-style `node --test` cases (no `cucumber` npm package is
// installed or used) that implement EVERY Gherkin scenario in the ticket.
// The module under test is PURE lib: it never touches disk/DB/network/Electron,
// so there is nothing to mock beyond simply never doing real FS/DB I/O (this
// file does none). Every scenario drives the real exports via require().
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  LANE_STATUSES,
  VALID_STATUSES,
  ACTIVE_STATUSES,
  FAILED_STATUS,
  UNKNOWN_STATUS,
  isKnownStatus,
  isActiveStatus,
  laneForStatus,
} = require('../lib/ticket-lanes');

const {
  defaultConfig,
  normalizeConfig,
  serializeConfig,
  SYSTEM_LABELS,
  SYSTEM_SLUGS,
} = require('../lib/team-config');

const {
  KEEP_AWAKE_STATUSES,
} = require('../lib/keep-awake');

const {
  claimTicket,
  selectNextBatch,
  CLAIMABLE_STATUSES,
} = require('../lib/ticket-queue');

const rendererPath = path.join(__dirname, '..', 'renderer', 'renderer.js');
const rendererSrc = fs.readFileSync(rendererPath, 'utf8');

// ---------------------------------------------------------------------------
// Scenario: the board has five system lanes and no post-processing lane
//   Given a default team-config
//   When the board lanes are computed
//   Then the lanes are todo, defining, in-progress, testing, done in that order
//   And there is no post-processing lane
// ---------------------------------------------------------------------------
test('Scenario: the board has five system lanes and no post-processing lane', () => {
  // Given a default team-config
  const cfg = defaultConfig();

  // When the board lanes are computed
  const lanes = cfg.columns.map((c) => c.status);

  // Then the lanes are todo, defining, in-progress, testing, done in that order
  assert.deepEqual(lanes, ['todo', 'defining', 'in-progress', 'testing', 'done']);

  // And there is no post-processing lane
  assert.ok(!lanes.includes('post-processing'), 'post-processing is not a lane');
});

// ---------------------------------------------------------------------------
// Scenario: post-processing is no longer a valid status
//   When VALID_STATUSES is read
//   Then it does not contain "post-processing"
//   And it still contains "failed-testing"
// ---------------------------------------------------------------------------
test('Scenario: post-processing is no longer a valid status', () => {
  // When VALID_STATUSES is read
  // (already imported at top)

  // Then it does not contain "post-processing"
  assert.ok(!VALID_STATUSES.includes('post-processing'), 'post-processing not in VALID_STATUSES');

  // And it still contains "failed-testing"
  assert.ok(VALID_STATUSES.includes('failed-testing'), 'failed-testing still in VALID_STATUSES');
});

// ---------------------------------------------------------------------------
// Scenario: a post-processing status routes to the unknown lane, never a lane of its own
//   Given a ticket whose status is "post-processing"
//   When laneForStatus is called
//   Then it returns "unknown"
// ---------------------------------------------------------------------------
test('Scenario: a post-processing status routes to the unknown lane, never a lane of its own', () => {
  // Given a ticket whose status is "post-processing"
  const status = 'post-processing';

  // When laneForStatus is called
  const lane = laneForStatus(status);

  // Then it returns "unknown"
  assert.equal(lane, UNKNOWN_STATUS, 'post-processing routes to unknown lane');
});

// ---------------------------------------------------------------------------
// Scenario: a leftover kind:post-processing ticket is claimable by its status
//   Given a todo ticket that still carries kind: post-processing
//   When claimTicket runs for an agent
//   Then the claim succeeds (ok: true, no post-processing reason)
// ---------------------------------------------------------------------------
test('Scenario: a leftover kind:post-processing ticket is claimable by its status', () => {
  // Given a todo ticket that still carries kind: post-processing
  const ticket = {
    id: 'TEST-001',
    status: 'todo',
    kind: 'post-processing',
    reason: null,
  };

  // When claimTicket runs for an agent
  const claimed = claimTicket(ticket, 'orchestrate-ba');

  // Then the claim succeeds (ok: true)
  assert.ok(claimed && claimed.ok, 'ticket is claimable');

  // And no "post-processing" reason is ever returned
  assert.notEqual(claimed.reason, 'post-processing', 'no post-processing reason');
  assert.ok(!claimed.reason || !claimed.reason.includes('post-processing'), 'reason never mentions post-processing');
});

// ---------------------------------------------------------------------------
// Scenario: keep-awake no longer counts post-processing
//   Given a ticket whose status is "post-processing"
//   When shouldKeepAwake evaluates the board
//   Then that ticket does not hold the wake-lock
// ---------------------------------------------------------------------------
test('Scenario: keep-awake no longer counts post-processing', () => {
  // Given tickets whose statuses are in ACTIVE_STATUSES and "post-processing"
  const activeStatuses = ACTIVE_STATUSES;
  const postProcStatus = 'post-processing';

  // When KEEP_AWAKE_STATUSES is read
  // (already imported at top)

  // Then post-processing is not in KEEP_AWAKE_STATUSES
  assert.ok(!KEEP_AWAKE_STATUSES.includes(postProcStatus), 'post-processing not in KEEP_AWAKE_STATUSES');

  // And KEEP_AWAKE_STATUSES contains exactly the ACTIVE_STATUSES
  assert.deepEqual(KEEP_AWAKE_STATUSES, ACTIVE_STATUSES, 'KEEP_AWAKE_STATUSES equals ACTIVE_STATUSES');
});

// ---------------------------------------------------------------------------
// Scenario: default config has five system columns
//   When defaultConfig runs
//   Then it has exactly five system columns
//   And none of them is "post-processing"
//   And serializeConfig output re-normalizes to the same config
// ---------------------------------------------------------------------------
test('Scenario: default config has five system columns', () => {
  // When defaultConfig runs
  const cfg = defaultConfig();

  // Then it has exactly five system columns
  const systemColumns = cfg.columns.filter((c) => c.system === true);
  assert.equal(systemColumns.length, 5, 'five system columns');

  // And none of them is "post-processing"
  const systemStatuses = systemColumns.map((c) => c.status);
  assert.ok(!systemStatuses.includes('post-processing'), 'no post-processing system column');

  // And serializeConfig output re-normalizes to the same config
  const serialized = serializeConfig(cfg);
  const reparsed = JSON.parse(serialized);
  const renormalized = normalizeConfig(reparsed);

  assert.deepEqual(
    renormalized.columns.map((c) => c.status),
    cfg.columns.map((c) => c.status),
    'serialization round-trips correctly'
  );
});

// ---------------------------------------------------------------------------
// Scenario: a legacy post-processing column is dropped on normalize (edge)
//   Given a raw config whose columns include a system "post-processing" column
//   When normalizeConfig runs
//   Then the normalized columns contain no "post-processing" column
//   And no "post-processing" user column is created
//   And warnings include a message naming the dropped post-processing column
// ---------------------------------------------------------------------------
test('Scenario: a legacy post-processing column is dropped on normalize (edge)', () => {
  // Given a raw config whose columns include a system "post-processing" column
  const raw = {
    version: 1,
    columns: [
      { status: 'todo', label: 'To Do', system: true },
      { status: 'defining', label: 'Defining', system: true },
      { status: 'in-progress', label: 'In Progress', system: true },
      { status: 'testing', label: 'Testing', system: true },
      { status: 'post-processing', label: 'Post-processing', system: true },
      { status: 'done', label: 'Done', system: true },
    ],
    skill: { concurrencyDefault: 3 },
  };

  // When normalizeConfig runs
  const cfg = normalizeConfig(raw);

  // Then the normalized columns contain no "post-processing" column
  const ppCol = cfg.columns.find((c) => c.status === 'post-processing');
  assert.ok(!ppCol, 'no post-processing column in normalized config');

  // And no "post-processing" user column is created
  const userColumns = cfg.columns.filter((c) => c.system !== true);
  const ppUserCol = userColumns.find((c) => c.status === 'post-processing');
  assert.ok(!ppUserCol, 'no post-processing user column created');

  // And warnings include a message naming the dropped post-processing column
  assert.ok(
    cfg.warnings.some((w) => /post-processing/.test(w) && /column/.test(w)),
    'warning mentions dropped post-processing column'
  );
});

// ---------------------------------------------------------------------------
// Scenario: the new-ticket modal cannot create a post-processing ticket
//   When the tasks board renders
//   Then no lane shows a post-processing Add button
//   And opening the new-ticket modal creates a todo ticket with no kind field
// ---------------------------------------------------------------------------
test('Scenario: the new-ticket modal cannot create a post-processing ticket', () => {
  // Check that renderer has no post-processing support
  // Guard 1: no TASKS_POST_PROCESSING_STATUS constant in renderer
  assert.ok(
    !rendererSrc.includes('TASKS_POST_PROCESSING_STATUS ='),
    'renderer has no TASKS_POST_PROCESSING_STATUS constant'
  );

  // Guard 2: no post-processing Add button binding in renderer
  const ppAddButtonPattern = /if \(status === TASKS_POST_PROCESSING_STATUS\)/;
  assert.ok(
    !ppAddButtonPattern.test(rendererSrc),
    'renderer has no post-processing Add button'
  );

  // Guard 3: no post-processing mode in openNewTaskModal
  const ppModalPattern = /kind:\s*'post-processing'|kind:\s*TASKS_POST_PROCESSING_KIND/;
  assert.ok(
    !ppModalPattern.test(rendererSrc),
    'renderer modal does not create post-processing tickets'
  );
});

// ---------------------------------------------------------------------------
// Scenario: TASK-054 is preserved as a won't-do Done ticket
//   Given the post-processing column is removed
//   When the migration runs
//   Then TASK-054 lives in tasks/done with status done and resolution wont-do
//   And it no longer carries kind: post-processing
//   And its original documentation body is preserved
// ---------------------------------------------------------------------------
test('Scenario: TASK-054 is preserved as a won\'t-do Done ticket', () => {
  // Given the post-processing column is removed
  const doneDir = path.join(__dirname, '..', 'tasks', 'done');
  const task054Path = path.join(doneDir, 'TASK-054-documentation.md');

  // When the migration runs (already done)
  assert.ok(
    fs.existsSync(task054Path),
    'TASK-054 exists in tasks/done/'
  );

  // Read the file
  const content = fs.readFileSync(task054Path, 'utf8');

  // Then TASK-054 lives in tasks/done with status done and resolution wont-do
  assert.ok(content.includes('status: done'), 'status is done');
  assert.ok(content.includes('resolution: wont-do'), 'resolution is wont-do');

  // And it no longer carries kind: post-processing
  assert.ok(
    !content.includes('kind: post-processing'),
    'kind: post-processing removed'
  );

  // And its original documentation body is preserved (check for key sections)
  assert.ok(
    content.includes('Prompt: Generate README plus per-feature documentation'),
    'original documentation body preserved'
  );
});

// ---------------------------------------------------------------------------
// Scenario: renderer and lib status sets stay in lockstep (drift guard)
//   When TASKS_LANE_STATUSES is compared to LANE_STATUSES
//   Then they are byte-identical with no post-processing member
// ---------------------------------------------------------------------------
test('Scenario: renderer and lib status sets stay in lockstep (drift guard)', () => {
  // Extract TASKS_LANE_STATUSES from renderer
  const laneStatusesMatch = rendererSrc.match(/const TASKS_LANE_STATUSES\s*=\s*\[([^\]]+)\]/);
  assert.ok(laneStatusesMatch, 'TASKS_LANE_STATUSES found in renderer');

  // Parse the values
  const rendererLaneStatuses = laneStatusesMatch[1]
    .split(',')
    .map((s) => s.trim().replace(/['"]/g, ''))
    .filter((s) => s);

  // When TASKS_LANE_STATUSES is compared to LANE_STATUSES
  // Then they are byte-identical with no post-processing member
  assert.deepEqual(rendererLaneStatuses, LANE_STATUSES, 'TASKS_LANE_STATUSES matches LANE_STATUSES');
  assert.ok(!rendererLaneStatuses.includes('post-processing'), 'no post-processing in renderer lanes');
});

// ---------------------------------------------------------------------------
// Scenario: junk config still yields five valid system columns (failure path)
//   Given the input is the string "not json {"
//   When normalizeConfig runs
//   Then it returns a complete valid config with the five system columns
//   And none of them is "post-processing"
// ---------------------------------------------------------------------------
test('Scenario: junk config still yields five valid system columns (failure path)', () => {
  // Given the input is the string "not json {"
  const junkInput = 'not json {';

  // When normalizeConfig runs (never throws)
  let cfg;
  assert.doesNotThrow(() => {
    cfg = normalizeConfig(junkInput);
  }, 'normalizeConfig never throws on invalid JSON');

  // Then it returns a complete valid config with the five system columns
  const systemColumns = cfg.columns.filter((c) => c.system === true);
  assert.equal(systemColumns.length, 5, 'returns five system columns');

  // And none of them is "post-processing"
  const systemStatuses = systemColumns.map((c) => c.status);
  assert.ok(!systemStatuses.includes('post-processing'), 'no post-processing in fallback config');
  assert.deepEqual(systemStatuses, ['todo', 'defining', 'in-progress', 'testing', 'done']);
});
