'use strict';

// ===========================================================================
// TASK-206 — unit tests for removal of post-processing column
//
// Tests the removal of:
// - POST_PROCESSING_STATUS and POST_PROCESSING_KIND from ticket-lanes.js
// - isPostProcessingTicket guards from ticket-queue.js
// - post-processing from KEEP_AWAKE_STATUSES in keep-awake.js
// - post-processing from SYSTEM_LABELS and related structures in team-config.js
// - post-processing from KNOWN_ACTIVITIES in ticket-cost.js
//
// The module is pure, never touches disk/DB/network/Electron, and never throws
// — junk/partial/tampered input always collapses to a complete valid config.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ticketLanes = require('../lib/ticket-lanes');
const ticketQueue = require('../lib/ticket-queue');
const keepAwake = require('../lib/keep-awake');
const teamConfig = require('../lib/team-config');
const ticketCost = require('../lib/ticket-cost');

// ──────────────────────────────────────────────────────────────────────────
// lib/ticket-lanes.js: POST_PROCESSING_STATUS and POST_PROCESSING_KIND removed
// ──────────────────────────────────────────────────────────────────────────

test('ticket-lanes exports do not include POST_PROCESSING_STATUS', () => {
  assert.ok(!('POST_PROCESSING_STATUS' in ticketLanes), 'POST_PROCESSING_STATUS not exported');
});

test('ticket-lanes exports do not include POST_PROCESSING_KIND', () => {
  assert.ok(!('POST_PROCESSING_KIND' in ticketLanes), 'POST_PROCESSING_KIND not exported');
});

test('ticket-lanes exports do not include isPostProcessingTicket', () => {
  assert.ok(!('isPostProcessingTicket' in ticketLanes), 'isPostProcessingTicket not exported');
});

test('LANE_STATUSES is exactly [todo, defining, in-progress, testing, done]', () => {
  const { LANE_STATUSES } = ticketLanes;
  assert.deepEqual(LANE_STATUSES, ['todo', 'defining', 'in-progress', 'testing', 'done']);
});

test('VALID_STATUSES includes failed-testing but not post-processing', () => {
  const { VALID_STATUSES } = ticketLanes;
  assert.ok(!VALID_STATUSES.includes('post-processing'), 'post-processing not in VALID_STATUSES');
  assert.ok(VALID_STATUSES.includes('failed-testing'), 'failed-testing still in VALID_STATUSES');
});

test('ACTIVE_STATUSES is [defining, in-progress, testing] and never changes', () => {
  const { ACTIVE_STATUSES } = ticketLanes;
  assert.deepEqual(ACTIVE_STATUSES, ['defining', 'in-progress', 'testing']);
});

// ──────────────────────────────────────────────────────────────────────────
// lib/ticket-queue.js: isPostProcessingTicket guards removed
// ──────────────────────────────────────────────────────────────────────────

test('ticket-queue exports do not include isPostProcessingTicket', () => {
  assert.ok(!('isPostProcessingTicket' in ticketQueue), 'isPostProcessingTicket not exported');
});

test('claimTicket reason precedence is deterministic after removing post-processing guard', () => {
  const { claimTicket } = ticketQueue;

  // Ticket with no agent ID - should claim successfully
  const todoTicket = {
    id: 'TEST-001',
    status: 'todo',
  };
  const result1 = claimTicket(todoTicket, 'orchestrate-ba');
  assert.ok(result1.ok, 'claimable ticket claimed');

  // Already claimed ticket (claimed by a different agent) - should fail with 'claimed'
  const claimedTicket = {
    id: 'TEST-002',
    status: 'todo',
    agent: 'other-agent',
  };
  const result2 = claimTicket(claimedTicket, 'orchestrate-ba');
  assert.ok(!result2.ok, 'already claimed ticket not reclaimed');
  assert.equal(result2.reason, 'claimed', 'reason is claimed');

  // Non-claimable status - should fail gracefully
  const doneTicket = {
    id: 'TEST-003',
    status: 'done',
  };
  const result3 = claimTicket(doneTicket, 'orchestrate-ba');
  // done is not claimable
  assert.ok(!result3.ok, 'done ticket not claimable');
  assert.ok(result3.reason !== 'post-processing', 'no post-processing reason (TASK-206)');
});

test('selectNextBatch does not special-case post-processing tickets', () => {
  const { selectNextBatch } = ticketQueue;

  // Create a mixed board with various statuses
  const tickets = [
    { id: 'T1', status: 'todo', reason: null },
    { id: 'T2', status: 'defining', reason: null },
    { id: 'T3', status: 'post-processing', reason: null }, // legacy status, should be treated like unknown
  ];

  // selectNextBatch should handle these without special post-processing logic
  assert.doesNotThrow(
    () => {
      selectNextBatch(tickets, { todo: 2, defining: 2 }, {});
    },
    'selectNextBatch handles post-processing status without throwing'
  );
});

test('canRunInParallel does not check for post-processing status', () => {
  const { canRunInParallel } = ticketQueue;

  // A ticket with post-processing status should be evaluated by status alone
  const ppTicket = {
    id: 'TEST-PP',
    status: 'post-processing',
    reason: null,
  };

  const result = canRunInParallel(ppTicket, {}, 1, 5);
  // Should not return 'post-processing' as a reason
  assert.ok(!result || !('post-processing' in result), 'no post-processing in canRunInParallel result');
});

// ──────────────────────────────────────────────────────────────────────────
// lib/keep-awake.js: post-processing removed from KEEP_AWAKE_STATUSES
// ──────────────────────────────────────────────────────────────────────────

test('KEEP_AWAKE_STATUSES does not include post-processing', () => {
  const { KEEP_AWAKE_STATUSES } = keepAwake;
  assert.ok(!KEEP_AWAKE_STATUSES.includes('post-processing'), 'post-processing not in KEEP_AWAKE_STATUSES');
});

test('KEEP_AWAKE_STATUSES equals ACTIVE_STATUSES', () => {
  const { KEEP_AWAKE_STATUSES } = keepAwake;
  const { ACTIVE_STATUSES } = ticketLanes;
  assert.deepEqual(KEEP_AWAKE_STATUSES, ACTIVE_STATUSES, 'KEEP_AWAKE_STATUSES === ACTIVE_STATUSES');
});

// ──────────────────────────────────────────────────────────────────────────
// lib/team-config.js: post-processing removed from config structures
// ──────────────────────────────────────────────────────────────────────────

test('SYSTEM_LABELS does not include post-processing', () => {
  const { SYSTEM_LABELS } = teamConfig;
  assert.ok(!('post-processing' in SYSTEM_LABELS), 'post-processing not in SYSTEM_LABELS');
});

test('SYSTEM_LABELS has exactly 5 entries (todo, defining, in-progress, testing, done)', () => {
  const { SYSTEM_LABELS } = teamConfig;
  const keys = Object.keys(SYSTEM_LABELS);
  assert.equal(keys.length, 5, 'SYSTEM_LABELS has 5 entries');
  assert.deepEqual(keys, ['todo', 'defining', 'in-progress', 'testing', 'done']);
});

test('SYSTEM_SLUGS is derived from LANE_STATUSES and has no post-processing', () => {
  const { SYSTEM_SLUGS } = teamConfig;
  const { LANE_STATUSES } = ticketLanes;
  assert.deepEqual(SYSTEM_SLUGS, LANE_STATUSES, 'SYSTEM_SLUGS equals LANE_STATUSES');
  assert.ok(!SYSTEM_SLUGS.includes('post-processing'), 'post-processing not in SYSTEM_SLUGS');
});

test('SYSTEM_COLUMN_DEFAULT_AGENTS does not include post-processing', () => {
  const { SYSTEM_COLUMN_DEFAULT_AGENTS } = teamConfig;
  assert.ok(!('post-processing' in SYSTEM_COLUMN_DEFAULT_AGENTS), 'post-processing not in SYSTEM_COLUMN_DEFAULT_AGENTS');
});

test('SYSTEM_COLUMN_DEFAULT_INSTRUCTIONS does not include post-processing', () => {
  const { SYSTEM_COLUMN_DEFAULT_INSTRUCTIONS } = teamConfig;
  assert.ok(!('post-processing' in SYSTEM_COLUMN_DEFAULT_INSTRUCTIONS), 'post-processing not in SYSTEM_COLUMN_DEFAULT_INSTRUCTIONS');
});

test('defaultConfig produces exactly five system columns', () => {
  const { defaultConfig } = teamConfig;
  const cfg = defaultConfig();

  const systemCols = cfg.columns.filter((c) => c.system === true);
  assert.equal(systemCols.length, 5, 'exactly five system columns');

  const statuses = systemCols.map((c) => c.status);
  assert.deepEqual(statuses, ['todo', 'defining', 'in-progress', 'testing', 'done']);
});

test('normalizeConfig drops a legacy post-processing system column with warning', () => {
  const { normalizeConfig } = teamConfig;

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

  const cfg = normalizeConfig(raw);

  // Should not contain post-processing
  assert.ok(!cfg.columns.find((c) => c.status === 'post-processing'), 'post-processing column dropped');

  // Should have warning mentioning it
  assert.ok(
    cfg.warnings.some((w) => /post-processing/.test(w)),
    'warning includes post-processing'
  );

  // Should have exactly five system columns
  const systemCols = cfg.columns.filter((c) => c.system === true);
  assert.equal(systemCols.length, 5, 'normalized to five system columns');
});

test('normalizeConfig is idempotent after dropping legacy post-processing', () => {
  const { normalizeConfig, serializeConfig } = teamConfig;

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

  const cfg1 = normalizeConfig(raw);
  const serialized = serializeConfig(cfg1);
  const reparsed = JSON.parse(serialized);
  const cfg2 = normalizeConfig(reparsed);

  // Both normalizations should have the same columns
  assert.deepEqual(
    cfg1.columns.map((c) => c.status),
    cfg2.columns.map((c) => c.status),
    'idempotent normalization'
  );

  // Neither should have post-processing
  assert.ok(!cfg1.columns.find((c) => c.status === 'post-processing'));
  assert.ok(!cfg2.columns.find((c) => c.status === 'post-processing'));
});

test('normalizeConfig never throws on junk input and returns five system columns', () => {
  const { normalizeConfig } = teamConfig;

  let cfg;
  assert.doesNotThrow(() => {
    cfg = normalizeConfig('not json {');
  }, 'normalizeConfig never throws');

  const systemCols = cfg.columns.filter((c) => c.system === true);
  assert.equal(systemCols.length, 5, 'fallback has five system columns');
  assert.ok(!cfg.columns.find((c) => c.status === 'post-processing'), 'no post-processing in fallback');
});

// ──────────────────────────────────────────────────────────────────────────
// lib/ticket-cost.js: post-processing removed from KNOWN_ACTIVITIES
// ──────────────────────────────────────────────────────────────────────────

test('KNOWN_ACTIVITIES does not include post-processing', () => {
  const { KNOWN_ACTIVITIES } = ticketCost;
  assert.ok(!KNOWN_ACTIVITIES.includes('post-processing'), 'post-processing not in KNOWN_ACTIVITIES');
});

test('KNOWN_ACTIVITIES is [ba, code, test, review] exactly', () => {
  const { KNOWN_ACTIVITIES } = ticketCost;
  assert.deepEqual(KNOWN_ACTIVITIES, ['ba', 'code', 'test', 'review']);
});
