'use strict';

// ===========================================================================
// TASK-204 — E2E cucumber-style scenarios (Given/When/Then) for SKILL.md's
// column-driven dispatch loop and forward movement model.
//
// SKILL.md is a markdown INSTRUCTION document read by an LLM orchestrator —
// there is no executable "dispatch loop" function in this codebase to call.
// So, mirroring the established pattern in test/orchestrate-agents.test.js
// and test/orchestrate-swarm.test.js, these scenarios drive the REAL pure
// helpers the document points to (lib/team-config.js, lib/orchestrate-
// agents.js, lib/ticket-queue.js, lib/ticket-lanes.js) wherever a scenario is
// about concrete data/logic, and assert on the DOCUMENT's own prose wherever
// a scenario is about what the orchestrator is instructed to do (there being
// no other executable surface for that instruction).
//
// This file implements EVERY Gherkin scenario in tasks/testing/TASK-204's
// "## Cucumber Tests" block, one scenario per `test()`, including the
// corrupt-team-config failure path.
//
// NO DATABASE, NO REAL DB CONNECTION, NO NETWORK. All "team-config" input is
// either the real lib/team-config.js pure functions (no disk) or plain
// in-memory fixture objects — never a real file, never Electron, never IPC.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  normalizeConfig,
  defaultConfig,
  SYSTEM_COLUMN_DEFAULT_AGENTS,
} = require('../lib/team-config');
const {
  AGENT_TYPES,
  AGENT_NAMES,
  FALLBACK_AGENT,
  resolveAgentType,
  isFallback,
} = require('../lib/orchestrate-agents');
const {
  selectNextBatch,
  canRunInParallel,
  claimTicket,
  isUserStatus: queueIsUserStatus,
  DEFAULT_CONCURRENCY,
} = require('../lib/ticket-queue');
const { LANE_STATUSES, isUserStatus, laneStatusesFor } = require('../lib/ticket-lanes');

const ROOT = path.join(__dirname, '..');
const PROJECT_SKILL = path.join(ROOT, '.claude', 'skills', 'orchestrate', 'SKILL.md');
const ASSETS_SKILL = path.join(ROOT, 'assets', 'skills', 'orchestrate', 'SKILL.md');

function readFileLF(p) {
  return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
}
const skillProjectSrc = readFileLF(PROJECT_SKILL);
const skillAssetsSrc = readFileLF(ASSETS_SKILL);
const SKILL_COPIES = [['.claude', skillProjectSrc], ['assets', skillAssetsSrc]];

// Tiny Given/When/Then labels (no `cucumber` npm package — none is installed
// or added), matching the convention used elsewhere in this test suite
// (e.g. test/task-096-skill-workflow.e2e.test.js's precedent, before its
// removal, and test/task-051-planning-model.e2e.test.js's style).
function Given(_desc, fn) { return fn ? fn() : undefined; }
function When(_desc, fn) { return fn ? fn() : undefined; }
function Then(_desc, fn) { return fn ? fn() : undefined; }

// A minimal fake board column, shaped like lib/team-config.js's normalised
// column objects (status/label/description/agent/instructions/system).
function makeColumn(status, agent, { system = true, instructions = 'do the work' } = {}) {
  return { status, label: status, description: '', agent, instructions, system };
}

// The real fallback chain described by "The generic dispatch loop" step 3:
// column's own agent -> SYSTEM_COLUMN_DEFAULT_AGENTS[slug] when null (system
// column only) -> general-purpose when the named agent has no definition
// file. This is the pure decision function the scenarios below exercise;
// it is not spliced into SKILL.md (which only ever describes it in prose).
function resolveColumnAgent(column, availableAgents) {
  let named = column.agent;
  if (named == null && column.system) {
    named = SYSTEM_COLUMN_DEFAULT_AGENTS[column.status] || null;
  }
  if (named == null) return { agent: null, passive: true, fallback: false };
  const resolved = resolveAgentType(named, availableAgents);
  return { agent: resolved, passive: false, fallback: isFallback(named, availableAgents) };
}

// ===========================================================================
// Scenario: dispatch reads the ticket's current column
// ===========================================================================
test('Scenario: dispatch reads the ticket\'s current column', () => {
  const ticket = Given('a ticket in status "in-progress"', () => ({ id: 'TASK-1', status: 'in-progress' }));
  const columns = Given(
    'the "in-progress" column names agent "orchestrate-coder" with instructions X',
    () => [
      makeColumn('todo', null),
      makeColumn('defining', 'orchestrate-ba'),
      makeColumn('in-progress', 'orchestrate-coder', { instructions: 'instructions X' }),
      makeColumn('testing', 'orchestrate-tester'),
      makeColumn('done', null),
    ],
  );

  const currentColumn = When('the orchestrator processes the ticket (finds its current column)', () =>
    columns.find((c) => c.status === ticket.status));

  Then('it dispatches orchestrate-coder with the ticket text plus instructions X', () => {
    assert.ok(currentColumn, 'a column matches the ticket\'s status');
    assert.equal(currentColumn.agent, 'orchestrate-coder');
    assert.equal(currentColumn.instructions, 'instructions X');
  });

  // And SKILL.md documents this lookup-by-status rule generically.
  Then('SKILL.md documents finding the current column by matching status', () => {
    for (const [, src] of SKILL_COPIES) {
      assert.match(src, /find the ticket's current column[\s\S]{0,80}the column whose `?status`? slug\s+equals the ticket's `?status`?/i);
    }
  });
});

// ===========================================================================
// Scenario: a null system-column agent falls back to the canonical default
// ===========================================================================
test('Scenario: a null system-column agent falls back to the canonical default', () => {
  const column = Given('the "testing" column has agent null', () => makeColumn('testing', null));

  const resolved = When('a ticket reaches "testing"', () =>
    resolveColumnAgent(column, AGENT_NAMES));

  Then('the orchestrator dispatches SYSTEM_COLUMN_DEFAULT_AGENTS["testing"] (orchestrate-tester)', () => {
    assert.equal(SYSTEM_COLUMN_DEFAULT_AGENTS.testing, 'orchestrate-tester');
    assert.equal(resolved.agent, 'orchestrate-tester');
    assert.equal(resolved.passive, false);
  });

  // The other system defaults are exactly as documented, sourced from
  // lib/orchestrate-agents.js's AGENT_TYPES (never hardcoded twice).
  Then('SYSTEM_COLUMN_DEFAULT_AGENTS matches AGENT_TYPES for every system column', () => {
    assert.equal(SYSTEM_COLUMN_DEFAULT_AGENTS.todo, null);
    assert.equal(SYSTEM_COLUMN_DEFAULT_AGENTS.defining, AGENT_TYPES.ba);
    assert.equal(SYSTEM_COLUMN_DEFAULT_AGENTS['in-progress'], AGENT_TYPES.coder);
    assert.equal(SYSTEM_COLUMN_DEFAULT_AGENTS.testing, AGENT_TYPES.tester);
    assert.equal(SYSTEM_COLUMN_DEFAULT_AGENTS.done, null);
  });
});

// ===========================================================================
// Scenario: a missing named agent falls back to general-purpose and is reported
// ===========================================================================
test('Scenario: a missing named agent falls back to general-purpose and is reported', () => {
  const column = Given('the "in-progress" column names agent "orchestrate-coder"', () =>
    makeColumn('in-progress', 'orchestrate-coder'));
  const availableAgents = Given('no orchestrate-coder definition exists in .claude/agents/', () =>
    AGENT_NAMES.filter((n) => n !== 'orchestrate-coder'));

  const resolved = When('a ticket reaches "in-progress"', () => resolveColumnAgent(column, availableAgents));

  Then('the orchestrator dispatches general-purpose', () => {
    assert.equal(resolved.agent, FALLBACK_AGENT);
  });
  Then('it reports the missing agent', () => {
    assert.equal(resolved.fallback, true);
  });

  // And SKILL.md documents the fallback-and-report rule generically (for
  // every column's agent, not per-role special-casing).
  Then('SKILL.md documents falling back to general-purpose and reporting the missing agent', () => {
    for (const [, src] of SKILL_COPIES) {
      assert.match(src, /fall back to\s*`general-purpose`\s*and continue[\s\S]{0,200}report[\s\S]{0,80}named agent was missing/i);
    }
  });
});

// ===========================================================================
// Scenario: linear advancement follows column order
// ===========================================================================
test('Scenario: linear advancement follows column order', () => {
  const columns = Given('a defined ticket in "in-progress" that builds successfully', () => [
    makeColumn('todo', null),
    makeColumn('defining', 'orchestrate-ba'),
    makeColumn('in-progress', 'orchestrate-coder'),
    makeColumn('testing', 'orchestrate-tester'),
    makeColumn('done', null),
  ]);
  const ticket = { id: 'TASK-2', status: 'in-progress' };

  const nextStatus = When('the coder returns (dispatch outcome: forward)', () => {
    const idx = columns.findIndex((c) => c.status === ticket.status);
    return columns[idx + 1].status;
  });

  Then('the ticket advances to "testing"', () => {
    assert.equal(nextStatus, 'testing');
  });

  // And SKILL.md states forward advancement follows the configured column order.
  Then('SKILL.md states forward advancement follows the configured column order', () => {
    for (const [, src] of SKILL_COPIES) {
      assert.match(src, /advance the ticket to the\s+\*{0,2}next column's status\*{0,2} in configured order/i);
    }
  });
});

// ===========================================================================
// Scenario: a passive column is not dispatched
// ===========================================================================
test('Scenario: a passive column is not dispatched', () => {
  const column = Given('a ticket in "todo" and the "todo" column has no agent', () =>
    makeColumn('todo', null));

  const resolved = When('the orchestrator evaluates the column', () => resolveColumnAgent(column, AGENT_NAMES));

  Then('no agent is dispatched for it', () => {
    assert.equal(resolved.passive, true);
    assert.equal(resolved.agent, null);
  });

  Then('SKILL.md states a passive column is never dispatched and todo is the entry queue', () => {
    for (const [, src] of SKILL_COPIES) {
      assert.match(src, /is\s+\*{0,2}never dispatched\*{0,2}/i);
      assert.match(src, /`?todo`? is the\s+\*{0,2}entry queue\*{0,2}/i);
    }
  });
});

// ===========================================================================
// Scenario: user columns between testing and done dispatch serially
// ===========================================================================
test('Scenario: user columns between testing and done dispatch serially', () => {
  const columns = Given('a user column "pr-review" with agent "orchestrate-tech-lead" sits between testing and done', () => [
    makeColumn('todo', null),
    makeColumn('defining', 'orchestrate-ba'),
    makeColumn('in-progress', 'orchestrate-coder'),
    makeColumn('testing', 'orchestrate-tester'),
    makeColumn('pr-review', 'orchestrate-tech-lead', { system: false }),
    makeColumn('done', null),
  ]);

  const reviewColumn = Given('a ticket has passed testing', () => columns.find((c) => c.status === 'pr-review'));

  const isUser = When('the orchestrator classifies the pr-review column\'s status', () =>
    isUserStatus('pr-review', columns) && queueIsUserStatus('pr-review'));

  Then('the orchestrator dispatches orchestrate-tech-lead once, serially, before done', () => {
    assert.equal(reviewColumn.agent, 'orchestrate-tech-lead');
    assert.equal(isUser, true, 'pr-review is a user-column status (never claimed/slot-counted)');
    // And it sits between testing and done in the lane order.
    const lanes = laneStatusesFor(columns);
    assert.ok(lanes.indexOf('testing') < lanes.indexOf('pr-review'));
    assert.ok(lanes.indexOf('pr-review') < lanes.indexOf('done'));
  });

  Then('SKILL.md states user columns between testing and done are dispatched serially', () => {
    for (const [, src] of SKILL_COPIES) {
      assert.match(src, /user columns positioned between `?testing`? and `?done`?[\s\S]{0,120}dispatched\s+\*{0,2}serially\*{0,2}/i);
    }
  });
});

// ===========================================================================
// Scenario: concurrency and claim mechanics are unchanged (edge)
// ===========================================================================
test('Scenario: concurrency and claim mechanics are unchanged (edge)', () => {
  const board = Given('three eligible todo tickets and a concurrency limit of 3', () => [
    { file: 'TASK-1.md', fm: { id: 'TASK-1', status: 'todo', created: '2026-08-01T00:00:00.000Z' } },
    { file: 'TASK-2.md', fm: { id: 'TASK-2', status: 'todo', created: '2026-08-01T00:00:01.000Z' } },
    { file: 'TASK-3.md', fm: { id: 'TASK-3', status: 'todo', created: '2026-08-01T00:00:02.000Z' } },
  ]);

  const batch = When('/orchestrate build runs', () => selectNextBatch(board, { limit: 3 }));

  Then('it claims and builds them in parallel via selectNextBatch exactly as before', () => {
    assert.equal(batch.length, 3);
    for (const t of batch) {
      const r = claimTicket(t.fm, `coder-${t.fm.id}`);
      assert.equal(r.ok, true, `${t.fm.id} claimed atomically`);
      assert.equal(r.fm.status, 'in-progress');
    }
  });

  Then('canRunInParallel agrees no further slot is free', () => {
    const claimed = board.map((t, i) => ({ file: t.file, fm: { ...t.fm, status: 'in-progress', agent: `coder-${i}` } }));
    const r = canRunInParallel(claimed, { fm: { id: 'TASK-4', status: 'todo' } }, { limit: 3 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-slots');
  });

  Then('SKILL.md explicitly records that lib/ticket-queue.js/lib/ticket-lanes.js are unchanged', () => {
    for (const [, src] of SKILL_COPIES) {
      assert.match(src, /lib\/ticket-queue\.js[\s\S]{0,400}this module,\s+and\s+`?lib\/ticket-lanes\.js`?,\s+are unchanged/i);
    }
  });
});

// ===========================================================================
// Scenario: the assets mirror stays byte-identical (drift guard)
// ===========================================================================
test('Scenario: the assets mirror stays byte-identical (drift guard)', () => {
  Given('SKILL.md is edited', () => {});

  const identical = When('we compare the two SKILL.md copies as raw bytes', () =>
    fs.readFileSync(PROJECT_SKILL).equals(fs.readFileSync(ASSETS_SKILL)));

  Then('assets/skills/orchestrate/SKILL.md is written with identical bytes', () => {
    assert.equal(identical, true, '.claude and assets SKILL.md copies are byte-for-byte identical');
  });
});

// ===========================================================================
// Scenario: corrupt team-config falls back to canonical columns (failure path)
// ===========================================================================
test('Scenario: corrupt team-config falls back to canonical columns (failure path)', () => {
  const scenarios = Given('tasks/team-config.json is missing or unparseable', () => [
    { label: 'missing (null)', raw: null },
    { label: 'unparseable JSON string', raw: '{ not valid json' },
    { label: 'not an object at all', raw: 42 },
  ]);

  for (const { label, raw } of scenarios) {
    const cfg = When(`the orchestrator builds (config input: ${label})`, () => normalizeConfig(raw));

    Then(`it uses the six... rather, the canonical five system columns with their default agents and instructions (${label})`, () => {
      // Six lanes conceptually (five system + the claimable fix-loop status),
      // but exactly the canonical FIVE system COLUMNS are seeded — matching
      // defaultConfig()'s own shape, never fewer, never reordered.
      const expected = defaultConfig().columns.map((c) => c.status);
      assert.deepEqual(cfg.columns.map((c) => c.status), expected);
      assert.deepEqual(cfg.columns.map((c) => c.status), LANE_STATUSES);
      for (const col of cfg.columns) {
        assert.equal(col.agent, SYSTEM_COLUMN_DEFAULT_AGENTS[col.status] ?? null);
        assert.ok(typeof col.instructions === 'string' && col.instructions.length > 0 || col.status === 'todo' || col.status === 'done',
          `${col.status} has default instructions (or is a passive todo/done column)`);
      }
    });
  }

  Then('SKILL.md documents this exact fallback for a missing/corrupt config', () => {
    for (const [, src] of SKILL_COPIES) {
      assert.match(src, /missing or\s*\r?\n?\s*fails to parse[\s\S]{0,200}normalizeConfig[\s\S]{0,200}canonical\s+\*{0,2}five system columns\*{0,2}/i);
    }
  });
});
