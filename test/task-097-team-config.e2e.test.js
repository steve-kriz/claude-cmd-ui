'use strict';

// ===========================================================================
// TASK-097 — e2e cucumber-style (Given/When/Then) scenarios
//
// Feature: Team config model (lib/team-config.js) — the pure, Electron-free
// model for tasks/team-config.json.
//
// These are scenario-style `node --test` cases (no `cucumber` npm package is
// installed or used) that implement EVERY Gherkin scenario in the ticket. The
// module under test is a PURE lib: it never touches disk/DB/network/Electron,
// so there is nothing to mock beyond simply never doing real FS/DB I/O (this
// file does none). Every scenario drives the real exports via require().
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const teamConfig = require('../lib/team-config.js');
const { LANE_STATUSES } = require('../lib/ticket-lanes.js');
const { DEFAULT_CONCURRENCY, MAX_CONCURRENCY } = require('../lib/ticket-queue.js');

const {
  defaultConfig,
  normalizeConfig,
  validateNewColumn,
  SYSTEM_SLUGS,
} = teamConfig;

const TODAYS_LABELS = ['To Do', 'Defining', 'In Progress', 'Testing', 'Done'];

// ---------------------------------------------------------------------------
// Scenario: Defaults mirror the fixed board
//   Then defaultConfig returns five system columns in LANE_STATUSES order with
//   today's labels
// ---------------------------------------------------------------------------
test('Scenario: Defaults mirror the fixed board', () => {
  // When the default config is built
  const cfg = defaultConfig();

  // Then it has exactly five columns in LANE_STATUSES order
  assert.equal(cfg.columns.length, 5, 'five system columns');
  assert.deepEqual(cfg.columns.map((c) => c.status), LANE_STATUSES.slice(),
    'columns follow LANE_STATUSES order');

  // And every column carries today's board-header label and system:true
  assert.deepEqual(cfg.columns.map((c) => c.label), TODAYS_LABELS,
    'columns use today\'s board-header labels');
  for (const c of cfg.columns) {
    assert.equal(c.system, true, `column ${c.status} is system:true`);
  }

  // And skill.concurrencyDefault === DEFAULT_CONCURRENCY (from lib/ticket-queue.js)
  assert.equal(cfg.skill.concurrencyDefault, DEFAULT_CONCURRENCY,
    'concurrencyDefault mirrors ticket-queue DEFAULT_CONCURRENCY');
  assert.equal(cfg.version, teamConfig.CONFIG_VERSION, 'version is CONFIG_VERSION');
});

// ---------------------------------------------------------------------------
// Scenario: User column between system columns survives normalize
//   Given a config with "ux-review" between testing and done
//   Then normalizeConfig keeps it in place with system:false
// ---------------------------------------------------------------------------
test('Scenario: User column between system columns survives normalize', () => {
  // Given a config with a user column "ux-review" between testing and done
  const raw = {
    version: 1,
    columns: [
      { status: 'todo', label: 'To Do', system: true },
      { status: 'defining', label: 'Defining', system: true },
      { status: 'in-progress', label: 'In Progress', system: true },
      { status: 'testing', label: 'Testing', system: true },
      { status: 'ux-review', label: 'UX Review', description: 'peer review', agent: 'orchestrate-tech-lead', system: false },
      { status: 'done', label: 'Done', system: true },
    ],
    skill: { concurrencyDefault: DEFAULT_CONCURRENCY },
  };

  // When the config is normalized
  const cfg = normalizeConfig(raw);

  // Then ux-review is preserved in place (between testing and done)
  const slugs = cfg.columns.map((c) => c.status);
  const tIdx = slugs.indexOf('testing');
  const uIdx = slugs.indexOf('ux-review');
  const dIdx = slugs.indexOf('done');
  assert.ok(uIdx !== -1, 'ux-review is present');
  assert.equal(uIdx, tIdx + 1, 'ux-review sits immediately after testing');
  assert.equal(dIdx, uIdx + 1, 'done sits immediately after ux-review');

  // And it is system:false with its metadata preserved
  const ux = cfg.columns[uIdx];
  assert.equal(ux.system, false, 'ux-review is system:false');
  assert.equal(ux.label, 'UX Review');
  assert.equal(ux.description, 'peer review');
  assert.equal(ux.agent, 'orchestrate-tech-lead');

  // And all five system columns are still present, with no post-processing (TASK-206)
  for (const s of SYSTEM_SLUGS) {
    assert.ok(slugs.includes(s), `system column ${s} present`);
  }
  assert.ok(!slugs.includes('post-processing'), 'post-processing is never resurrected');
});

// ---------------------------------------------------------------------------
// Scenario: Tampered system column repaired (failure)
//   Given a config where "in-progress" was deleted and "done" renamed to "finished"
//   When normalizeConfig runs
//   Then both system columns are restored with canonical slugs and warnings
//   report the repairs
// ---------------------------------------------------------------------------
test('Scenario: Tampered system column repaired (failure/edge)', () => {
  // Given a tampered config: in-progress deleted, done renamed to finished
  const raw = {
    version: 1,
    columns: [
      { status: 'todo', label: 'To Do', system: true },
      { status: 'defining', label: 'Defining', system: true },
      // in-progress deleted
      { status: 'testing', label: 'Testing', system: true },
      { status: 'finished', label: 'Finished', system: true }, // renamed from done, still flagged system
    ],
    skill: { concurrencyDefault: DEFAULT_CONCURRENCY },
  };

  // When normalizeConfig runs
  const cfg = normalizeConfig(raw);
  const bySlug = new Map(cfg.columns.map((c) => [c.status, c]));

  // Then all five canonical system slugs survive as system:true
  for (const s of SYSTEM_SLUGS) {
    assert.ok(bySlug.has(s), `canonical system slug ${s} survives`);
    assert.equal(bySlug.get(s).system, true, `${s} is repaired to system:true`);
  }

  // And the deleted in-progress is re-injected in canonical order
  const slugs = cfg.columns.map((c) => c.status);
  const dIdx = slugs.indexOf('defining');
  const ipIdx = slugs.indexOf('in-progress');
  const tIdx = slugs.indexOf('testing');
  assert.equal(ipIdx, dIdx + 1, 'in-progress re-injected between defining and testing');
  assert.equal(tIdx, ipIdx + 1, 'testing follows the re-injected in-progress');

  // And the renamed "finished" is kept as a DEMOTED user column (system:false)
  assert.ok(bySlug.has('finished'), 'finished kept as a user column');
  assert.equal(bySlug.get('finished').system, false, 'finished is demoted to system:false');

  // And a fresh canonical "done" system column exists alongside it
  assert.ok(bySlug.has('done'), 'a fresh done system column is restored');
  assert.equal(bySlug.get('done').system, true, 'restored done is system:true');
  assert.equal(bySlug.get('done').label, 'Done', 'restored done uses the canonical label');

  // And warnings report the repairs
  assert.ok(Array.isArray(cfg.warnings), 'warnings is an array');
  assert.ok(cfg.warnings.length > 0, 'at least one repair warning is reported');
  const warnText = cfg.warnings.join('\n');
  assert.ok(/in-progress/.test(warnText), 'a warning references the re-inserted in-progress');
  assert.ok(/finished/.test(warnText), 'a warning references the demoted finished column');
});

// ---------------------------------------------------------------------------
// Scenario: Reserved slug collision rejected (failure)
//   When validateNewColumn is called with slug "failed-testing" and with "todo"
//   Then both are rejected
// ---------------------------------------------------------------------------
test('Scenario: Reserved slug collision rejected (failure)', () => {
  const config = defaultConfig();

  // When validateNewColumn is called with the reserved lane-less slug failed-testing
  const failed = validateNewColumn('Failed Testing', 'failed-testing', config);
  // Then it is rejected
  assert.equal(failed.ok, false, 'failed-testing is rejected');
  assert.ok(failed.error, 'a reason is provided for failed-testing');

  // When validateNewColumn is called with the reserved system slug todo
  const todo = validateNewColumn('To Do again', 'todo', config);
  // Then it is rejected too
  assert.equal(todo.ok, false, 'todo is rejected');
  assert.ok(todo.error, 'a reason is provided for todo');
});

// ---------------------------------------------------------------------------
// Scenario: Junk input (edge)
//   When normalizeConfig gets "not json parsed", 42, and []
//   Then a complete default config returns each time without throwing
// ---------------------------------------------------------------------------
test('Scenario: Junk input returns a complete default config without throwing (edge)', () => {
  const defaultSlugs = defaultConfig().columns.map((c) => c.status);

  for (const junk of ['not json parsed', 42, [], null, undefined]) {
    // When normalizeConfig gets junk (never throws)
    let cfg;
    assert.doesNotThrow(() => { cfg = normalizeConfig(junk); },
      `normalizeConfig(${JSON.stringify(junk)}) does not throw`);

    // Then a complete default config is returned
    assert.equal(cfg.version, teamConfig.CONFIG_VERSION);
    assert.deepEqual(cfg.columns.map((c) => c.status), defaultSlugs,
      `junk ${JSON.stringify(junk)} yields the five default system columns`);
    for (const c of cfg.columns) assert.equal(c.system, true);
    assert.equal(cfg.skill.concurrencyDefault, DEFAULT_CONCURRENCY);
    assert.ok(Array.isArray(cfg.warnings), 'warnings list present');
  }
});

// ---------------------------------------------------------------------------
// Guard scenario: neighbouring lib exports are untouched by this ticket.
// ---------------------------------------------------------------------------
test('Scenario (guard): lib/ticket-lanes.js and lib/ticket-queue.js exports still behave', () => {
  const lanes = require('../lib/ticket-lanes.js');
  const queue = require('../lib/ticket-queue.js');

  assert.deepEqual(lanes.LANE_STATUSES,
    ['todo', 'defining', 'in-progress', 'testing', 'done'],
    'LANE_STATUSES unchanged');
  assert.deepEqual(lanes.VALID_STATUSES,
    [...lanes.LANE_STATUSES, 'failed-testing'],
    'VALID_STATUSES unchanged');
  assert.equal(typeof lanes.laneForStatus, 'function');
  assert.equal(lanes.laneForStatus('failed-testing'), 'testing', 'failed-testing folds into testing');

  assert.equal(queue.DEFAULT_CONCURRENCY, 3, 'DEFAULT_CONCURRENCY unchanged');
  assert.equal(queue.MAX_CONCURRENCY, 8, 'MAX_CONCURRENCY unchanged');
  assert.equal(typeof queue.resolveConcurrency, 'function');
  assert.equal(queue.resolveConcurrency(999), MAX_CONCURRENCY, 'resolveConcurrency clamps high');
  assert.equal(queue.resolveConcurrency(0), 1, 'resolveConcurrency clamps low');
});
