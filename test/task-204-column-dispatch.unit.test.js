'use strict';

// ===========================================================================
// TASK-204 — UNIT tests for SKILL.md's column-driven dispatch loop and
// forward movement model.
//
// Unit-level coverage of the pure lib functions the rewritten SKILL.md's
// dispatch loop is built on (lib/team-config.js, lib/orchestrate-agents.js,
// lib/ticket-queue.js, lib/ticket-lanes.js), plus narrow, single-fact
// assertions pinning specific required phrases/structure in the document
// itself (mirroring the established pattern in
// test/orchestrate-agents.test.js and test/orchestrate-swarm.test.js — a
// per-fact test fails narrowly on a single regression rather than one giant
// test failing for any reason).
//
// NO DATABASE, NO REAL DB CONNECTION, NO NETWORK. Every input here is either
// a real pure lib function call (no disk I/O) or an in-memory fixture; the
// only real disk reads are the two shipped SKILL.md files themselves
// (read-only).
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  normalizeConfig,
  defaultConfig,
  SYSTEM_COLUMN_DEFAULT_AGENTS,
  SYSTEM_COLUMN_DEFAULT_INSTRUCTIONS,
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
  CLAIMABLE_STATUSES,
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
} = require('../lib/ticket-queue');
const { LANE_STATUSES, VALID_STATUSES, isUserStatus, laneStatusesFor } = require('../lib/ticket-lanes');

const ROOT = path.join(__dirname, '..');
const PROJECT_SKILL = path.join(ROOT, '.claude', 'skills', 'orchestrate', 'SKILL.md');
const ASSETS_SKILL = path.join(ROOT, 'assets', 'skills', 'orchestrate', 'SKILL.md');

function readFileLF(p) {
  return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
}
const skillProjectSrc = readFileLF(PROJECT_SKILL);
const skillAssetsSrc = readFileLF(ASSETS_SKILL);
const SKILL_COPIES = [['.claude', skillProjectSrc], ['assets', skillAssetsSrc]];

// ===========================================================================
// lib/team-config.js — SYSTEM_COLUMN_DEFAULT_AGENTS / normalizeConfig
// ===========================================================================

test('unit: SYSTEM_COLUMN_DEFAULT_AGENTS is frozen and sources every non-null value from AGENT_TYPES', () => {
  assert.ok(Object.isFrozen(SYSTEM_COLUMN_DEFAULT_AGENTS));
  assert.equal(SYSTEM_COLUMN_DEFAULT_AGENTS.todo, null);
  assert.equal(SYSTEM_COLUMN_DEFAULT_AGENTS.defining, AGENT_TYPES.ba);
  assert.equal(SYSTEM_COLUMN_DEFAULT_AGENTS['in-progress'], AGENT_TYPES.coder);
  assert.equal(SYSTEM_COLUMN_DEFAULT_AGENTS.testing, AGENT_TYPES.tester);
  assert.equal(SYSTEM_COLUMN_DEFAULT_AGENTS.done, null);
});

test('unit: SYSTEM_COLUMN_DEFAULT_INSTRUCTIONS names a non-empty string for every dispatching column', () => {
  for (const slug of ['defining', 'in-progress', 'testing']) {
    assert.ok(typeof SYSTEM_COLUMN_DEFAULT_INSTRUCTIONS[slug] === 'string'
      && SYSTEM_COLUMN_DEFAULT_INSTRUCTIONS[slug].length > 0, `${slug} has default instructions`);
  }
});

test('unit: normalizeConfig(missing/corrupt) falls back to the canonical five system columns, never fewer/reordered', () => {
  for (const raw of [undefined, null, '', 'not json {{{', 42, [], { columns: 'not-an-array' }]) {
    const cfg = normalizeConfig(raw);
    assert.deepEqual(cfg.columns.map((c) => c.status), LANE_STATUSES,
      `normalizeConfig(${JSON.stringify(raw)}) yields the canonical five in order`);
    for (const col of cfg.columns) {
      assert.equal(col.system, true);
      assert.equal(col.agent, SYSTEM_COLUMN_DEFAULT_AGENTS[col.status] ?? null);
    }
  }
});

test('unit: normalizeConfig(corrupt) matches defaultConfig()\'s own canonical shape', () => {
  const corrupt = normalizeConfig('{ this is not valid json');
  const fresh = defaultConfig();
  assert.deepEqual(
    corrupt.columns.map((c) => ({ status: c.status, agent: c.agent, system: c.system })),
    fresh.columns.map((c) => ({ status: c.status, agent: c.agent, system: c.system })),
  );
});

test('unit: a system column\'s explicit agent:null is preserved (never silently re-defaulted by normalizeConfig itself)', () => {
  // TASK-204's fallback-to-default-agent-on-null is the ORCHESTRATOR's dispatch
  // decision (SKILL.md step 3), not something team-config.js's normalizeConfig
  // does on load — it deliberately preserves an explicit null so a user can
  // configure "no agent" on a system column too.
  const cfg = normalizeConfig({
    version: 1,
    columns: defaultConfig().columns.map((c) => (c.status === 'testing' ? { ...c, agent: null } : c)),
    skill: { concurrencyDefault: 3 },
  });
  const testingCol = cfg.columns.find((c) => c.status === 'testing');
  assert.equal(testingCol.agent, null);
});

test('unit: a user column between testing and done round-trips with its own agent/instructions', () => {
  const cfg = normalizeConfig({
    version: 1,
    columns: [
      ...defaultConfig().columns.filter((c) => c.status !== 'done'),
      { status: 'pr-review', label: 'PR Review', description: '', agent: 'orchestrate-tech-lead', instructions: 'review it', system: false },
      defaultConfig().columns.find((c) => c.status === 'done'),
    ],
    skill: { concurrencyDefault: 3 },
  });
  const statuses = cfg.columns.map((c) => c.status);
  assert.deepEqual(statuses, ['todo', 'defining', 'in-progress', 'testing', 'pr-review', 'done']);
  const review = cfg.columns.find((c) => c.status === 'pr-review');
  assert.equal(review.system, false);
  assert.equal(review.agent, 'orchestrate-tech-lead');
});

// ===========================================================================
// lib/orchestrate-agents.js — the fallback chain's second/third links
// ===========================================================================

test('unit: resolveAgentType/isFallback implement the "missing named agent -> general-purpose, reported" link', () => {
  const available = AGENT_NAMES.filter((n) => n !== AGENT_TYPES.coder);
  assert.equal(resolveAgentType(AGENT_TYPES.coder, available), FALLBACK_AGENT);
  assert.equal(isFallback(AGENT_TYPES.coder, available), true);
  // A present agent is never reported as a fallback.
  assert.equal(resolveAgentType(AGENT_TYPES.tester, available), AGENT_TYPES.tester);
  assert.equal(isFallback(AGENT_TYPES.tester, available), false);
});

test('unit: a user column\'s own custom agent name follows the same fallback rule as a system column', () => {
  // The fallback chain is documented as uniform across every column — a user
  // column naming an agent with no definition file degrades exactly like a
  // system column would.
  const available = [AGENT_TYPES.tester];
  assert.equal(resolveAgentType('orchestrate-tech-lead', available), FALLBACK_AGENT);
  assert.equal(isFallback('orchestrate-tech-lead', available), true);
});

// ===========================================================================
// lib/ticket-lanes.js / lib/ticket-queue.js — user-column serial dispatch,
// concurrency/claim mechanics (explicitly unchanged by the column model)
// ===========================================================================

test('unit: isUserStatus (ticket-lanes) is true ONLY for a real, declared, non-system slug', () => {
  const columns = [...defaultConfig().columns, { status: 'pr-review', system: false }];
  assert.equal(isUserStatus('pr-review', columns), true);
  for (const s of LANE_STATUSES) assert.equal(isUserStatus(s, columns), false, `${s} is a system status, not a user status`);
  assert.equal(isUserStatus('failed-testing', columns), false);
  assert.equal(isUserStatus('unknown-slug-not-declared', columns), false);
});

test('unit: laneStatusesFor anchors a user column between testing and done at its configured position', () => {
  const columns = [
    ...defaultConfig().columns.filter((c) => c.status !== 'done'),
    { status: 'pr-review', system: false },
    defaultConfig().columns.find((c) => c.status === 'done'),
  ];
  const lanes = laneStatusesFor(columns);
  assert.deepEqual(lanes, ['todo', 'defining', 'in-progress', 'testing', 'pr-review', 'done']);
});

test('unit: isUserStatus (ticket-queue, mirrored) agrees with ticket-lanes for a user-column slug', () => {
  assert.equal(queueIsUserStatus('pr-review'), true);
  for (const s of LANE_STATUSES) assert.equal(queueIsUserStatus(s), false);
  assert.equal(queueIsUserStatus('failed-testing'), false);
});

test('unit: a user-column status is never claimable and never counts toward the concurrency bound', () => {
  assert.ok(!CLAIMABLE_STATUSES.includes('pr-review'));
  const board = [
    { file: 'A.md', fm: { id: 'A', status: 'pr-review' } },
    { file: 'B.md', fm: { id: 'B', status: 'todo', created: '2026-08-01T00:00:00.000Z' } },
  ];
  // selectNextBatch only ever considers claimable swarm statuses; the
  // pr-review ticket is never selected for a claim/build batch.
  const batch = selectNextBatch(board, { limit: DEFAULT_CONCURRENCY });
  assert.deepEqual(batch.map((t) => t.fm.id), ['B']);
});

test('unit: DEFAULT_CONCURRENCY/MAX_CONCURRENCY and the claim/slot machinery are the pre-TASK-204 values (unchanged)', () => {
  assert.equal(DEFAULT_CONCURRENCY, 3);
  assert.equal(MAX_CONCURRENCY, 8);
  assert.deepEqual([...CLAIMABLE_STATUSES].sort(), ['failed-testing', 'todo']);
});

test('unit: claimTicket still performs the atomic todo/failed-testing -> in-progress + agent transition', () => {
  for (const status of ['todo', 'failed-testing']) {
    const r = claimTicket({ id: 'TASK-9', status }, 'coder-1');
    assert.equal(r.ok, true);
    assert.equal(r.fm.status, 'in-progress');
    assert.equal(r.fm.agent, 'coder-1');
  }
  // Re-claiming an already-claimed ticket is refused (first writer wins).
  const first = claimTicket({ id: 'TASK-9', status: 'todo' }, 'coder-1');
  const second = claimTicket(first.fm, 'coder-2');
  assert.equal(second.ok, false);
});

test('unit: canRunInParallel excludes a user-column ticket from ever being claimed in parallel', () => {
  const board = [{ file: 'A.md', fm: { id: 'A', status: 'pr-review' } }];
  const r = canRunInParallel(board, { fm: { id: 'A', status: 'pr-review' } }, { limit: DEFAULT_CONCURRENCY });
  assert.equal(r.ok, false);
});

test('unit: VALID_STATUSES is exactly the five lanes plus failed-testing (no new status introduced by the column model)', () => {
  assert.deepEqual([...VALID_STATUSES].sort(), ['defining', 'done', 'failed-testing', 'in-progress', 'testing', 'todo'].sort());
});

// ===========================================================================
// SKILL.md — narrow, single-fact document-content assertions (no executable
// dispatch loop exists to call; this is the document's own testable surface,
// per the established pattern in test/orchestrate-agents.test.js)
// ===========================================================================

test('unit: SKILL.md no longer contains a hardcoded "Phase <n> -> agent" pipeline heading', () => {
  for (const [label, src] of SKILL_COPIES) {
    assert.ok(!/^##\s+Phase\s+\d/m.test(src), `${label}/SKILL.md has no "## Phase <n>" heading`);
  }
});

test('unit: SKILL.md documents the fallback chain in the exact order: own agent -> SYSTEM_COLUMN_DEFAULT_AGENTS -> passive', () => {
  for (const [label, src] of SKILL_COPIES) {
    assert.match(src, /Resolve the agent to dispatch, with a fallback chain[\s\S]{0,400}the column's own `agent`[\s\S]{0,200}SYSTEM_COLUMN_DEFAULT_AGENTS/i,
      `${label}/SKILL.md states the fallback chain: own agent, then SYSTEM_COLUMN_DEFAULT_AGENTS`);
  }
});

test('unit: SKILL.md documents the forward movement model literally as todo -> defining -> todo -> in-progress -> testing -> [user columns] -> done', () => {
  for (const [label, src] of SKILL_COPIES) {
    assert.match(src,
      /todo\s*→\s*defining\s*→\s*todo\s*\(defined\)\s*→\s*in-progress\s*\(via claim\)\s*→\s*testing\s*→\s*\[user columns\]\s*→\s*done/,
      `${label}/SKILL.md states the exact forward movement sequence`);
  }
});

test('unit: SKILL.md allows non-forward dispatch outcomes (backward / park-and-ask), not "always advance forward"', () => {
  for (const [label, src] of SKILL_COPIES) {
    assert.match(src, /outcome is\s+\*{0,2}one of several\*{0,2}/i, `${label}/SKILL.md frames the outcome as one of several`);
    assert.match(src, /\*{0,2}Backward\*{0,2}\s*[—-]/i, `${label}/SKILL.md names a Backward outcome`);
    assert.match(src, /\*{0,2}Park-and-ask\*{0,2}/i, `${label}/SKILL.md names a Park-and-ask outcome`);
  }
});

test('unit: SKILL.md preserves and cross-references whole-file atomic writes, claim-before-build, batching/slot math, git isolation', () => {
  for (const [label, src] of SKILL_COPIES) {
    assert.match(src, /whole-file/i, `${label}: whole-file writes mentioned`);
    assert.match(src, /claim-before-build/i, `${label}: claim-before-build mentioned`);
    assert.match(src, /selectNextBatch/, `${label}: selectNextBatch named`);
    assert.match(src, /canRunInParallel/, `${label}: canRunInParallel named`);
    assert.match(src, /default N = 3/i, `${label}: default concurrency 3 named`);
    assert.match(src, /ceiling of 8/i, `${label}: max concurrency 8 named`);
    assert.match(src, /ticketBranchName/, `${label}: ticketBranchName named`);
    assert.match(src, /ticketWorktreeDir/, `${label}: ticketWorktreeDir named`);
  }
});

test('unit: SKILL.md states no new status is introduced and there is no post-processing concept anywhere', () => {
  for (const [label, src] of SKILL_COPIES) {
    assert.match(src, /No new status is introduced/i, `${label}: no-new-status invariant stated`);
    // The phrase "kind: post-processing" legitimately appears ONCE, negated
    // ("there is no ... `kind: post-processing` ... concept") — this asserts
    // the NEGATIVE framing, not that the phrase never appears at all.
    assert.match(src, /no\s+`?post-processing`?\s+status,\s*\r?\n?\s*lane,\s+or\s+`?kind:\s*post-processing`?/i,
      `${label}: post-processing is explicitly stated as removed/absent`);
    assert.ok(!/##\s*Post-processing/i.test(src), `${label}: no "## Post-processing" heading`);
  }
});

test('unit: the ## Routing section maps plan/build/status, and describes build as running the generic column loop until clear', () => {
  for (const [label, src] of SKILL_COPIES) {
    const routingIdx = src.indexOf('## Routing');
    assert.ok(routingIdx !== -1, `${label}: Routing section present`);
    const nextHeadingIdx = src.indexOf('\n## ', routingIdx + 1);
    const routing = src.slice(routingIdx, nextHeadingIdx);
    assert.match(routing, /\/orchestrate plan/);
    assert.match(routing, /\/orchestrate build/);
    assert.match(routing, /\/orchestrate status/);
    assert.match(routing, /generic column dispatch loop/i);
    assert.match(routing, /until the board is clear/i);
  }
});

test('unit: prompt-caching guidance frames the stable prefix as agent system prompt + preamble, volatile tail as ticket + column instructions', () => {
  for (const [label, src] of SKILL_COPIES) {
    assert.match(src, /stable prefix\*{0,2}\s+is the agent's\s*\r?\n?\s*system prompt plus a fixed preamble/i,
      `${label}: stable prefix defined as system prompt + preamble`);
    assert.match(src, /volatile tail\*{0,2}[\s\S]{0,120}ticket text, with that column's\s*\r?\n?\s*`?instructions`? appended\s+\*{0,2}last of all\*{0,2}/i,
      `${label}: volatile tail defined as ticket text + column instructions LAST`);
  }
});

test('unit: model routing is never spliced per-column into a dispatch preamble (busts the cache) — pinned in each agent file\'s model: key instead', () => {
  for (const [label, src] of SKILL_COPIES) {
    assert.match(src, /pinned in its own\s*\r?\n?\s*`?\.claude\/agents\/\*\.md`? frontmatter\s*\r?\n?\s*\(`?model:`? key\)/i,
      `${label}: model pinned per-agent file`);
    assert.match(src, /never spliced per-ticket[\s\S]{0,40}or\s*\r?\n?\s*per-column, into a dispatch preamble/i,
      `${label}: never spliced per-column into a preamble`);
  }
});

test('unit: both SKILL.md copies are byte-identical (drift guard)', () => {
  assert.ok(fs.readFileSync(PROJECT_SKILL).equals(fs.readFileSync(ASSETS_SKILL)));
});

test('unit (edge): a ticket whose status matches no column is never routed to todo, and is reported', () => {
  for (const [label, src] of SKILL_COPIES) {
    assert.match(src, /matches\s+\*{0,2}no\*{0,2}\s*\r?\n?\s*column at all[\s\S]{0,120}never silently routed anywhere,\s*\r?\n?\s*least of all back to `?todo`?/i,
      `${label}: an out-of-enum status is never silently routed to todo`);
  }
});
