'use strict';

// Tests for TASK-017: the orchestrate SKILL.md must document the build phase as a
// coordinated, bounded, claim-safe, git-isolated PARALLEL SWARM processed in
// sets/batches — replacing the old "exactly one ticket in flight" rule.
//
// This is a DOCUMENTATION ticket: the coder edited ONLY the two byte-identical
// skill docs and NO product code:
//   .claude/skills/orchestrate/SKILL.md
//   assets/skills/orchestrate/SKILL.md
// So the testable contract has two halves:
//   1. the SKILL.md prose contains the required swarm/batch/identifier phrasing,
//      and the two copies are byte-identical; and
//   2. lib/ticket-queue.js — which the docs reference and which MUST be unchanged
//      — still exposes the documented DEFAULT_CONCURRENCY/MAX_CONCURRENCY bounds
//      and selectNextBatch/claim/release behaviour that back the documented swarm.
//
// NO NETWORK, NO DATABASE. There are no DB calls here; nothing opens a real
// connection. The only I/O is reading the two markdown files from disk, and
// requiring the pure (Electron-free) lib/ticket-queue.js helper.
//
// This file contains BOTH mandated kinds of tests:
//   * E2E CUCUMBER SCENARIOS -> the `test('E2E cucumber: ...')` suites: each is a
//     Given/When/Then structured case mirroring the ticket's Gherkin, reading the
//     SKILL.md doc under test and asserting the required phrases, plus asserting
//     the two copies are byte-identical.
//   * UNIT TESTS -> the `test('UNIT: ...')` cases: focused requireable-helper
//     assertions that lib/ticket-queue.js still honours the documented bounds and
//     that selectNextBatch never exceeds the resolved limit (edge), plus the
//     claim/release/selection behaviour backing the documented swarm.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const SKILL_PATH = path.join(REPO_ROOT, '.claude', 'skills', 'orchestrate', 'SKILL.md');
const ASSETS_SKILL_PATH = path.join(REPO_ROOT, 'assets', 'skills', 'orchestrate', 'SKILL.md');

// Read once, lowercased, so assertions are robust to punctuation/casing while a
// genuinely absent concept still fails.
const readLower = (p) => fs.readFileSync(p, 'utf8').toLowerCase();
// Raw reads (as Buffers) for the byte-identical guard.
const readBytes = (p) => fs.readFileSync(p);

const {
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
  activeCount,
  claimTicket,
  releaseTicket,
  selectNextBatch,
  ticketBranchName,
  ticketWorktreeDir,
} = require('../lib/ticket-queue');

// Small helper mirroring the shape selectNextBatch consumes: { fm }.
function T(id, status, extra) {
  return { fm: Object.assign({ id, status }, extra) };
}

// ---------------------------------------------------------------------------
// E2E CUCUMBER-STYLE SCENARIOS
// Given/When/Then cases that read the edited SKILL.md doc and mirror the ticket's
// Gherkin acceptance scenarios. Each also (where relevant) asserts the two copies
// stay byte-identical, the ticket's cross-cutting rule.
// ---------------------------------------------------------------------------

test('E2E cucumber: SKILL.md describes a parallel swarm processed in sets/batches', async (t) => {
  await t.test(
    'Given the orchestrate SKILL.md build phase, ' +
      'When we read how the queue is processed, ' +
      'Then it describes a coordinated parallel swarm run in sets/batches (not one at a time)',
    () => {
      const md = readLower(SKILL_PATH);
      assert.match(md, /swarm/, 'SKILL.md should describe the build as a swarm');
      assert.match(md, /parallel/, 'SKILL.md should say builds run in parallel');
      assert.match(md, /batch/, 'SKILL.md should describe batches');
      assert.match(md, /\bsets?\b/, 'SKILL.md should describe processing the queue in sets');
    },
  );
});

test('E2E cucumber: batch size honors DEFAULT_CONCURRENCY (3) and MAX_CONCURRENCY (8) bounds', async (t) => {
  await t.test(
    'Given the swarm build phase, ' +
      'When we read the concurrency bound, ' +
      'Then the batch size is DEFAULT_CONCURRENCY (default 3), clamped to MAX_CONCURRENCY (ceiling 8)',
    () => {
      const md = readLower(SKILL_PATH);
      assert.match(md, /default_concurrency/, 'SKILL.md should name DEFAULT_CONCURRENCY');
      assert.match(md, /max_concurrency/, 'SKILL.md should name MAX_CONCURRENCY');
      // The concrete numbers must appear near their named constants.
      assert.match(
        md,
        /default_concurrency[\s\S]{0,40}\b3\b|\b3\b[\s\S]{0,40}default_concurrency|default[\s\S]{0,20}\b3\b/,
        'SKILL.md should state the default is 3',
      );
      assert.match(
        md,
        /max_concurrency[\s\S]{0,60}\b8\b|\b8\b[\s\S]{0,60}max_concurrency|ceiling[\s\S]{0,20}\b8\b/,
        'SKILL.md should state the hard ceiling is 8',
      );
    },
  );
});

test('E2E cucumber: batch selection uses selectNextBatch filling only free slots and topping up', async (t) => {
  await t.test(
    'Given the swarm processing loop, ' +
      'When we read how each batch is selected, ' +
      'Then selectNextBatch fills only free slots (limit − (in-progress + testing + defining)) and tops up until the board is clear',
    () => {
      const md = readLower(SKILL_PATH);
      assert.match(md, /selectnextbatch/, 'SKILL.md should reference selectNextBatch');
      assert.match(md, /free slot/, 'SKILL.md should describe filling free slots');
      assert.match(
        md,
        /limit\s*[−-]\s*\(\s*in-progress\s*\+\s*testing\s*\+\s*defining\s*\)/,
        'SKILL.md should define free slots = limit − (in-progress + testing + defining)',
      );
      assert.match(md, /top(?:ping|s|-| )?up|top up/, 'SKILL.md should describe topping up free slots');
      assert.match(md, /board is clear|until the board is clear/, 'SKILL.md should drive until the board is clear');
    },
  );
});

test('E2E cucumber: claims prevent collisions — claimTicket before build, releaseTicket on terminal state', async (t) => {
  await t.test(
    'Given two swarm agents that might grab the same ticket, ' +
      'When we read the claim rules, ' +
      'Then each ticket is atomically claimed (claimTicket -> status in-progress + agent) before its build and released (releaseTicket) on a terminal state',
    () => {
      const md = readLower(SKILL_PATH);
      assert.match(md, /claimticket/, 'SKILL.md should reference claimTicket');
      assert.match(md, /releaseticket/, 'SKILL.md should reference releaseTicket');
      assert.match(md, /in-progress/, 'SKILL.md should state the claim writes status: in-progress');
      assert.match(md, /\bagent\b/, 'SKILL.md should state the claim writes the agent field');
      assert.match(md, /atomic/, 'SKILL.md should describe the claim as atomic');
      assert.match(md, /terminal state/, 'SKILL.md should release on a terminal state');
    },
  );
});

test('E2E cucumber: git isolation via ticketBranchName / ticketWorktreeDir', async (t) => {
  await t.test(
    'Given parallel builds sharing one repo, ' +
      'When we read how each build is isolated, ' +
      'Then each runs in its own git isolation derived from the ticket id (ticketBranchName / ticketWorktreeDir)',
    () => {
      const md = readLower(SKILL_PATH);
      assert.match(md, /ticketbranchname/, 'SKILL.md should reference ticketBranchName');
      assert.match(md, /ticketworktreedir/, 'SKILL.md should reference ticketWorktreeDir');
      assert.match(md, /isolat/, 'SKILL.md should describe per-ticket isolation');
      assert.match(md, /branch|worktree/, 'SKILL.md should mention branch/worktree isolation');
    },
  );
});

test('E2E cucumber: only shared-git steps are serialized one at a time', async (t) => {
  await t.test(
    'Given per-ticket isolation, ' +
      'When we read what must still be serialized, ' +
      'Then only shared-git steps (e.g. merging back into base) run one at a time',
    () => {
      const md = readLower(SKILL_PATH);
      assert.match(md, /serialize/, 'SKILL.md should say shared-git steps are serialized');
      assert.match(md, /shared git|shared-git|shared git state/, 'SKILL.md should scope serialization to shared git state');
      assert.match(md, /one at a time/, 'SKILL.md should serialize shared-git steps one at a time');
      assert.match(md, /merg/, 'SKILL.md should give merging back to base as the shared-git example');
    },
  );
});

test('E2E cucumber: board write safety preserved — whole-file atomic writes + keep-last-good-parse', async (t) => {
  await t.test(
    'Given concurrent swarm writes, ' +
      'When we read the board write rules, ' +
      'Then whole-file atomic writes and keep-last-good-parse are preserved unchanged',
    () => {
      const md = readLower(SKILL_PATH);
      assert.match(md, /whole-file|whole file|full-file|single write|full/, 'SKILL.md should keep whole-file writes');
      assert.match(md, /atomic/, 'SKILL.md should keep atomic writes');
      assert.match(md, /keep-last-good-parse/, 'SKILL.md should keep keep-last-good-parse');
    },
  );
});

test('E2E cucumber: the two SKILL.md copies are byte-identical (assets drift guard)', async (t) => {
  await t.test(
    'Given the .claude/ SKILL.md and its assets/ copy, ' +
      'When we compare their raw bytes, ' +
      'Then the two copies are byte-for-byte identical',
    () => {
      assert.ok(fs.existsSync(SKILL_PATH), `expected ${SKILL_PATH} to exist`);
      assert.ok(fs.existsSync(ASSETS_SKILL_PATH), `expected ${ASSETS_SKILL_PATH} to exist`);
      const a = readBytes(SKILL_PATH);
      const b = readBytes(ASSETS_SKILL_PATH);
      assert.equal(a.length, b.length, 'the two SKILL.md copies differ in byte length');
      assert.ok(a.equals(b), 'the .claude/ and assets/ SKILL.md copies are NOT byte-identical');
    },
  );
});

test('E2E cucumber: edge — the assets copy also carries the swarm/batch/identifier phrasing', async (t) => {
  await t.test(
    'Given the assets/ SKILL.md copy that ships with the installer, ' +
      'When we read it, ' +
      'Then it too documents the swarm, the bounds, and the named helpers (not just the .claude/ copy)',
    () => {
      const md = readLower(ASSETS_SKILL_PATH);
      for (const needle of [
        'swarm',
        'batch',
        'selectnextbatch',
        'claimticket',
        'releaseticket',
        'ticketbranchname',
        'ticketworktreedir',
        'default_concurrency',
        'max_concurrency',
        'keep-last-good-parse',
      ]) {
        assert.match(md, new RegExp(needle), `assets/ SKILL.md should mention ${needle}`);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// UNIT TESTS
// Behavioural guards on lib/ticket-queue.js — the module the docs reference and
// that the ticket says MUST be unchanged. These prove the documented swarm math
// (bounds + free-slot selection + claim/release + isolation names) actually holds.
// ---------------------------------------------------------------------------

test('UNIT: lib/ticket-queue.js still exports DEFAULT_CONCURRENCY===3 and MAX_CONCURRENCY===8', () => {
  assert.equal(DEFAULT_CONCURRENCY, 3, 'DEFAULT_CONCURRENCY must remain 3 (no product-code change)');
  assert.equal(MAX_CONCURRENCY, 8, 'MAX_CONCURRENCY must remain 8 (no product-code change)');
});

test('UNIT: selectNextBatch fills only free slots = limit − active', () => {
  const tickets = [
    T('TASK-001', 'in-progress', { agent: 'a1' }), // 1 active → occupies a slot
    T('TASK-002', 'todo'),
    T('TASK-003', 'todo'),
    T('TASK-004', 'todo'),
  ];
  const batch = selectNextBatch(tickets, { limit: 3 });
  assert.equal(activeCount(tickets), 1, 'one ticket is active');
  assert.equal(batch.length, 2, 'limit 3 − 1 active = 2 free slots');
  assert.deepEqual(batch.map((t) => t.fm.id), ['TASK-002', 'TASK-003'], 'oldest-first fills the free slots');
});

// EDGE: given more claimable tickets than the limit, the number selected never
// exceeds the resolved concurrency limit and the rest wait.
test('UNIT: edge — selectNextBatch never exceeds the resolved bound; the rest wait', () => {
  // More claimable tickets (12) than any possible bound.
  const many = Array.from({ length: 12 }, (_, i) =>
    T(`TASK-${String(i + 1).padStart(3, '0')}`, 'todo'),
  );

  // A limit within range: exactly `limit` selected, the rest wait.
  const b5 = selectNextBatch(many, { limit: 5 });
  assert.equal(b5.length, 5, 'selects exactly the in-range limit');

  // A limit above MAX_CONCURRENCY is clamped: never more than MAX_CONCURRENCY.
  const bHuge = selectNextBatch(many, { limit: 1000 });
  assert.equal(bHuge.length, MAX_CONCURRENCY, 'an over-large limit is clamped to MAX_CONCURRENCY');
  assert.ok(bHuge.length <= MAX_CONCURRENCY, 'batch never exceeds the hard ceiling');

  // Junk/absent limit falls back to DEFAULT_CONCURRENCY.
  const bDefault = selectNextBatch(many, { limit: 'nonsense' });
  assert.equal(bDefault.length, DEFAULT_CONCURRENCY, 'junk limit falls back to DEFAULT_CONCURRENCY');

  // Across a sweep of limits, the batch is always min(claimable, resolvedBound)
  // and the untouched remainder stays claimable (waiting).
  for (const limit of [1, 2, 3, 8, 20]) {
    const batch = selectNextBatch(many, { limit });
    const resolved = Math.min(Math.max(1, Math.min(limit, MAX_CONCURRENCY)), MAX_CONCURRENCY);
    assert.ok(batch.length <= resolved, `limit ${limit}: batch (${batch.length}) never exceeds bound (${resolved})`);
    assert.equal(batch.length, Math.min(many.length, resolved), `limit ${limit}: selects min(claimable, bound)`);
    assert.ok(many.length - batch.length > 0, `limit ${limit}: the rest wait in the queue`);
  }
});

test('UNIT: selectNextBatch returns [] when all slots are occupied (top-up never over-books)', () => {
  const full = [
    T('TASK-001', 'in-progress', { agent: 'a1' }),
    T('TASK-002', 'testing', { agent: 'a2' }),
    T('TASK-003', 'in-progress', { agent: 'a3' }),
    T('TASK-004', 'todo'),
    T('TASK-005', 'todo'),
  ];
  assert.deepEqual(selectNextBatch(full, { limit: 3 }), [], '3 active, limit 3 → no free slots → dispatch nothing');
});

test('UNIT: claimTicket atomically stamps status:in-progress + agent before the build', () => {
  const res = claimTicket(
    { id: 'TASK-017', title: 't', status: 'todo', created: '2026-07-10T00:00:00.000Z' },
    'agent-1',
    { at: '2026-07-18T01:00:00.000Z' },
  );
  assert.equal(res.ok, true, 'a fresh todo ticket is claimable');
  assert.equal(res.fm.status, 'in-progress', 'claim flips status to in-progress');
  assert.equal(res.fm.agent, 'agent-1', 'claim stamps the agent id');
  assert.equal(res.fm.created, '2026-07-10T00:00:00.000Z', 'created preserved');
});

test('UNIT: claimTicket prevents collisions — a ticket owned by another agent is rejected', () => {
  const owned = { id: 'TASK-017', status: 'in-progress', agent: 'agent-1' };
  const res = claimTicket(owned, 'agent-2', { at: '2026-07-18T01:00:00.000Z' });
  assert.equal(res.ok, false, 'second agent cannot claim a ticket owned by another');
  assert.equal(res.reason, 'claimed');
  assert.equal(res.fm.agent, 'agent-1', 'the winner keeps ownership');
});

test('UNIT: releaseTicket clears the agent claim on a terminal state so the slot frees', () => {
  const done = { id: 'TASK-017', status: 'done', agent: 'agent-1', created: '2026-07-10T00:00:00.000Z' };
  const out = releaseTicket(done, { at: '2026-07-18T03:00:00.000Z' });
  assert.ok(!('agent' in out), 'agent claim cleared on release');
  assert.equal(out.updated, '2026-07-18T03:00:00.000Z', 'updated bumped');
  assert.equal(out.status, 'done', 'terminal status left to the caller');
});

test('UNIT: per-ticket git isolation names are distinct and derived from the ticket id', () => {
  assert.equal(ticketBranchName('TASK-017'), 'orchestrate/task-017');
  assert.equal(ticketWorktreeDir('.worktrees', 'TASK-017'), '.worktrees/task-017');
  // Two concurrent tickets never collide.
  assert.notEqual(ticketBranchName('TASK-017'), ticketBranchName('TASK-018'));
  assert.notEqual(
    ticketWorktreeDir('.worktrees', 'TASK-017'),
    ticketWorktreeDir('.worktrees', 'TASK-018'),
  );
});

test('UNIT: top-up loop — as a build finishes, exactly one free slot is filled, never exceeding the bound', () => {
  const tickets = [
    T('TASK-001', 'in-progress', { agent: 'a1' }),
    T('TASK-002', 'in-progress', { agent: 'a2' }),
    T('TASK-003', 'todo'),
    T('TASK-004', 'todo'),
  ];
  // Two active, limit 2 → nothing new dispatched.
  assert.deepEqual(selectNextBatch(tickets, { limit: 2 }), []);
  // One build finishes → exactly one free slot → exactly one dispatched.
  tickets[0] = T('TASK-001', 'done');
  const batch = selectNextBatch(tickets, { limit: 2 });
  assert.equal(batch.length, 1, 'exactly one free slot topped up');
  assert.deepEqual(batch.map((t) => t.fm.id), ['TASK-003']);
});
