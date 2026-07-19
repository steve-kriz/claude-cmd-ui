'use strict';

// Unit + cucumber-style tests for lib/ticket-queue.js — the Electron-free helpers
// that let the orchestrator run bounded-concurrency, claim-safe, per-ticket-
// isolated builds (TASK-004). The module is pure (no disk/git/network/Electron),
// so every function is exercised directly with plain `node --test`. No files are
// written and no DB/filesystem/Electron call is made by these tests.
//
// The Gherkin scenarios from tasks/TASK-004-multi-agent.md are implemented here
// wherever they map to the pure claim/queue/isolation logic (concurrency bound,
// single-claim, per-ticket writes, oldest-first). The board's rendering /
// last-good-parse behaviour is a renderer concern verified in-app and by
// test/tasks-working-indicator.test.js; those scenarios are covered here only to
// the extent the pure helpers back them (e.g. multiple active statuses allowed).
//
// The round-trip block reuses the REAL serializer/parser copied VERBATIM from
// renderer/renderer.js (~5034 / ~5058) — that file is a browser script and is
// NOT requireable — to prove the new `agent` claim field survives a whole-file
// write/read, and that orderFm agrees with the serializer's leading-key order.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  ACTIVE_STATUSES,
  CLAIMABLE_STATUSES,
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
  isActive,
  isClaimable,
  isClaimed,
  isClaimedBy,
  resolveConcurrency,
  orderFm,
  activeCount,
  claimTicket,
  releaseTicket,
  selectNextBatch,
  canRunInParallel,
  idSlug,
  ticketBranchName,
  ticketWorktreeDir,
} = require('../lib/ticket-queue');

// ---------------------------------------------------------------------------
// Real serializer/parser, copied verbatim from renderer/renderer.js (~5034 /
// ~5058). renderer.js is a browser script and cannot be required, so the
// round-trip contract is exercised against these faithful copies. If the real
// functions change, these must be updated in lockstep.
// ---------------------------------------------------------------------------
function parseTicketFrontmatter(content) {
  if (typeof content !== 'string') return null;
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  if (lines[0].trim() !== '---') return null;
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { closeIdx = i; break; }
  }
  if (closeIdx === -1) return null;
  const fm = {};
  for (let i = 1; i < closeIdx; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (key) fm[key] = line.slice(idx + 1).trim();
  }
  const body = lines.slice(closeIdx + 1).join('\n');
  return { fm, body };
}

function serializeTicket(fm, body) {
  const order = ['id', 'title', 'status', 'created', 'updated'];
  const keys = order.filter((k) => fm[k] != null);
  for (const k of Object.keys(fm)) if (!keys.includes(k)) keys.push(k);
  const fmLines = keys.map((k) => `${k}: ${fm[k]}`);
  return ['---', ...fmLines, '---', body || ''].join('\n');
}

// ---------------------------------------------------------------------------
// Exports & constants
// ---------------------------------------------------------------------------

test('exports the documented surface', () => {
  assert.equal(typeof isActive, 'function');
  assert.equal(typeof isClaimable, 'function');
  assert.equal(typeof isClaimed, 'function');
  assert.equal(typeof isClaimedBy, 'function');
  assert.equal(typeof resolveConcurrency, 'function');
  assert.equal(typeof orderFm, 'function');
  assert.equal(typeof activeCount, 'function');
  assert.equal(typeof claimTicket, 'function');
  assert.equal(typeof releaseTicket, 'function');
  assert.equal(typeof selectNextBatch, 'function');
  assert.equal(typeof canRunInParallel, 'function');
  assert.equal(typeof idSlug, 'function');
  assert.equal(typeof ticketBranchName, 'function');
  assert.equal(typeof ticketWorktreeDir, 'function');
});

test('constants match the documented concurrency + status contract', () => {
  assert.equal(DEFAULT_CONCURRENCY, 3);
  assert.equal(MAX_CONCURRENCY, 8);
  assert.deepEqual([...ACTIVE_STATUSES].sort(), ['in-progress', 'testing']);
  assert.deepEqual([...CLAIMABLE_STATUSES].sort(), ['failed-testing', 'todo']);
});

// ---------------------------------------------------------------------------
// isActive / isClaimable / isClaimed / isClaimedBy — the status predicates
// ---------------------------------------------------------------------------

test('isActive is true only for in-progress/testing', () => {
  assert.equal(isActive('in-progress'), true);
  assert.equal(isActive('testing'), true);
  for (const s of ['todo', 'done', 'failed-testing', 'other', undefined, '']) {
    assert.equal(isActive(s), false, `expected not active: ${JSON.stringify(s)}`);
  }
});

test('isClaimable is true only for todo/failed-testing', () => {
  assert.equal(isClaimable('todo'), true);
  assert.equal(isClaimable('failed-testing'), true);
  for (const s of ['in-progress', 'testing', 'done', 'other', undefined, '']) {
    assert.equal(isClaimable(s), false, `expected not claimable: ${JSON.stringify(s)}`);
  }
});

test('isClaimed detects any non-empty agent field, ignoring whitespace', () => {
  assert.equal(isClaimed({ agent: 'a1' }), true);
  assert.equal(isClaimed({ agent: '  a1  ' }), true);
  assert.equal(isClaimed({ agent: '' }), false);
  assert.equal(isClaimed({ agent: '   ' }), false);
  assert.equal(isClaimed({ agent: null }), false);
  assert.equal(isClaimed({}), false);
  assert.equal(isClaimed(null), false);
});

test('isClaimedBy matches only the owning agent (trimmed)', () => {
  assert.equal(isClaimedBy({ agent: 'a1' }, 'a1'), true);
  assert.equal(isClaimedBy({ agent: ' a1 ' }, 'a1'), true, 'trims both sides');
  assert.equal(isClaimedBy({ agent: 'a1' }, 'a2'), false);
  assert.equal(isClaimedBy({ agent: '' }, ''), false, 'empty owner is not "claimed by empty"');
  assert.equal(isClaimedBy({}, 'a1'), false);
});

// ---------------------------------------------------------------------------
// resolveConcurrency — clamp to [1, MAX_CONCURRENCY], never 0, sane fallback
// ---------------------------------------------------------------------------

test('resolveConcurrency clamps 0 and negatives up to 1 (never stalls the queue)', () => {
  assert.equal(resolveConcurrency(0), 1);
  assert.equal(resolveConcurrency(-1), 1);
  assert.equal(resolveConcurrency(-100), 1);
  assert.equal(resolveConcurrency('0'), 1);
  assert.equal(resolveConcurrency('-5'), 1);
});

test('resolveConcurrency clamps huge values down to MAX_CONCURRENCY', () => {
  assert.equal(resolveConcurrency(9), MAX_CONCURRENCY);
  assert.equal(resolveConcurrency(1000), MAX_CONCURRENCY);
  assert.equal(resolveConcurrency(Number.MAX_SAFE_INTEGER), MAX_CONCURRENCY);
  assert.equal(resolveConcurrency('42'), MAX_CONCURRENCY);
  assert.equal(resolveConcurrency(Infinity), DEFAULT_CONCURRENCY, 'Infinity is not finite → default');
});

test('resolveConcurrency passes through valid in-range integers and floors fractionals', () => {
  for (let n = 1; n <= MAX_CONCURRENCY; n++) {
    assert.equal(resolveConcurrency(n), n);
  }
  assert.equal(resolveConcurrency(2.9), 2, 'floored, not rounded');
  assert.equal(resolveConcurrency(1.1), 1);
  assert.equal(resolveConcurrency('3.7'), 3);
});

test('resolveConcurrency falls back to DEFAULT_CONCURRENCY for missing/junk input', () => {
  assert.equal(resolveConcurrency(undefined), DEFAULT_CONCURRENCY);
  assert.equal(resolveConcurrency(null), DEFAULT_CONCURRENCY);
  assert.equal(resolveConcurrency(''), DEFAULT_CONCURRENCY);
  assert.equal(resolveConcurrency('abc'), DEFAULT_CONCURRENCY);
  assert.equal(resolveConcurrency(NaN), DEFAULT_CONCURRENCY);
  assert.equal(resolveConcurrency({}), DEFAULT_CONCURRENCY);
});

test('resolveConcurrency never returns 0 or a value outside [1, MAX] for any input', () => {
  const inputs = [0, -0, -1, -999, 0.4, 1, 5, 8, 9, 1e9, '0', '9', '', null, undefined, NaN, Infinity, -Infinity, 'x', {}, [], [3]];
  for (const v of inputs) {
    const r = resolveConcurrency(v);
    assert.ok(Number.isInteger(r), `integer for ${JSON.stringify(v)}: got ${r}`);
    assert.ok(r >= 1 && r <= MAX_CONCURRENCY, `in [1,${MAX_CONCURRENCY}] for ${JSON.stringify(v)}: got ${r}`);
  }
});

// ---------------------------------------------------------------------------
// activeCount — number of tickets currently being worked (accepts fm or {fm})
// ---------------------------------------------------------------------------

test('activeCount counts only in-progress/testing tickets', () => {
  const tickets = [
    { fm: { id: 'A', status: 'in-progress' } },
    { fm: { id: 'B', status: 'testing' } },
    { fm: { id: 'C', status: 'todo' } },
    { fm: { id: 'D', status: 'done' } },
    { fm: { id: 'E', status: 'failed-testing' } },
  ];
  assert.equal(activeCount(tickets), 2);
});

test('activeCount accepts bare fm objects as well as { fm } wrappers', () => {
  assert.equal(activeCount([{ status: 'in-progress' }, { status: 'testing' }, { status: 'todo' }]), 2);
});

test('activeCount is 0 for empty/non-array/garbage input', () => {
  assert.equal(activeCount([]), 0);
  assert.equal(activeCount(null), 0);
  assert.equal(activeCount(undefined), 0);
  assert.equal(activeCount('nope'), 0);
  assert.equal(activeCount([null, {}, { fm: null }]), 0);
});

// ---------------------------------------------------------------------------
// claimTicket — pure compare-and-set: grant / reject / re-entry / stamping
// ---------------------------------------------------------------------------

test('claimTicket grants a claim on a fresh todo ticket', () => {
  const fm = { id: 'T-1', title: 'x', status: 'todo', created: '2026-07-10T00:00:00.000Z' };
  const res = claimTicket(fm, 'agent-1', { at: '2026-07-18T01:00:00.000Z' });
  assert.equal(res.ok, true);
  assert.equal(res.fm.status, 'in-progress', 'status flipped to in-progress');
  assert.equal(res.fm.agent, 'agent-1', 'agent stamped');
  assert.equal(res.fm.updated, '2026-07-18T01:00:00.000Z', 'updated bumped');
  assert.equal(res.fm.created, '2026-07-10T00:00:00.000Z', 'created preserved');
});

test('claimTicket grants on a failed-testing ticket (re-fix pickup)', () => {
  const res = claimTicket({ id: 'T', status: 'failed-testing' }, 'a1', { at: '2026-07-18T01:00:00.000Z' });
  assert.equal(res.ok, true);
  assert.equal(res.fm.status, 'in-progress');
  assert.equal(res.fm.agent, 'a1');
});

test('claimTicket preserves an existing created and fabricates one only when absent', () => {
  const kept = claimTicket({ id: 'T', status: 'todo', created: '2026-01-01T00:00:00.000Z' }, 'a1', { at: '2026-07-18T01:00:00.000Z' });
  assert.equal(kept.fm.created, '2026-01-01T00:00:00.000Z', 'existing created untouched');

  const made = claimTicket({ id: 'T', status: 'todo' }, 'a1', { at: '2026-07-18T01:00:00.000Z' });
  assert.equal(made.fm.created, '2026-07-18T01:00:00.000Z', 'created defaulted to now when missing');

  const blank = claimTicket({ id: 'T', status: 'todo', created: '   ' }, 'a1', { at: '2026-07-18T01:00:00.000Z' });
  assert.equal(blank.fm.created, '2026-07-18T01:00:00.000Z', 'blank created treated as absent');
});

test('claimTicket rejects when the ticket is already claimed by a DIFFERENT agent', () => {
  const fm = { id: 'T', status: 'in-progress', agent: 'agent-1' };
  const res = claimTicket(fm, 'agent-2', { at: '2026-07-18T01:00:00.000Z' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'claimed');
  assert.equal(res.fm.agent, 'agent-1', 'the other agent still owns it (unchanged)');
  assert.equal(res.fm.status, 'in-progress', 'status unchanged on reject');
});

test('claimTicket same-agent re-entry returns ok and keeps the same owner (idempotent)', () => {
  const fm = { id: 'T', status: 'in-progress', agent: 'agent-1', created: '2026-07-10T00:00:00.000Z' };
  const res = claimTicket(fm, 'agent-1', { at: '2026-07-18T02:00:00.000Z' });
  assert.equal(res.ok, true, 'own claim is a safe re-entry');
  assert.equal(res.fm.agent, 'agent-1');
  assert.equal(res.fm.status, 'in-progress');
  assert.equal(res.fm.updated, '2026-07-18T02:00:00.000Z');
  assert.equal(res.fm.created, '2026-07-10T00:00:00.000Z');
});

test('claimTicket rejects an unowned ticket that is not in a claimable lane', () => {
  for (const status of ['in-progress', 'testing', 'done']) {
    const res = claimTicket({ id: 'T', status }, 'a1', { at: '2026-07-18T01:00:00.000Z' });
    assert.equal(res.ok, false, `must not claim unowned ${status}`);
    assert.equal(res.reason, 'not-claimable');
  }
});

test('claimTicket refuses to claim without a usable agent id', () => {
  for (const bad of [null, undefined, '', '   ']) {
    const res = claimTicket({ id: 'T', status: 'todo' }, bad, { at: '2026-07-18T01:00:00.000Z' });
    assert.equal(res.ok, false, `no claim for agent id ${JSON.stringify(bad)}`);
    assert.equal(res.reason, 'no-agent-id');
  }
});

test('claimTicket does not mutate its input frontmatter (pure)', () => {
  const fm = { id: 'T', status: 'todo', created: '2026-07-10T00:00:00.000Z' };
  const snap = JSON.stringify(fm);
  const res = claimTicket(fm, 'a1', { at: '2026-07-18T01:00:00.000Z' });
  assert.equal(JSON.stringify(fm), snap, 'input untouched');
  assert.notEqual(res.fm, fm, 'a new fm object is returned');
});

test('claimTicket output carries all keys with id leading; on-disk order is fixed by the serializer', () => {
  // claimTicket runs orderFm BEFORE stamping created/updated, so when those were
  // absent they are appended (not re-slotted) — the canonical leading-key order
  // is (re)established by serializeTicket at write time, proven by the round-trip
  // tests below. Here we only assert the claim is complete and id leads.
  const fm = { title: 'x', id: 'T', status: 'todo', extra: 'e' };
  const res = claimTicket(fm, 'a1', { at: '2026-07-18T01:00:00.000Z' });
  const keys = Object.keys(res.fm);
  assert.equal(keys[0], 'id', 'id stays first');
  for (const k of ['id', 'title', 'status', 'created', 'updated', 'agent', 'extra']) {
    assert.ok(keys.includes(k), `key present: ${k}`);
  }
  // The real write path normalises order to the leading-key contract.
  const round = parseTicketFrontmatter(serializeTicket(res.fm, ''));
  assert.deepEqual(Object.keys(round.fm).slice(0, 5), ['id', 'title', 'status', 'created', 'updated']);
});

// GHERKIN: "A ticket is only claimed by one agent" — two agents both read the
// same freshly-parsed todo ticket; whoever writes first stamps `agent`; the
// loser re-reads the now-claimed file and is rejected.
test('CUCUMBER: the same todo ticket cannot be claimed by two agents (first writer wins)', () => {
  const fresh = { id: 'TASK-300', status: 'todo', created: '2026-07-18T00:00:00.000Z' };

  // Both agents compute a grant off the identical fresh read.
  const a1 = claimTicket(fresh, 'agent-1', { at: '2026-07-18T01:00:00.000Z' });
  const a2SameRead = claimTicket(fresh, 'agent-2', { at: '2026-07-18T01:00:00.000Z' });
  assert.equal(a1.ok, true);
  assert.equal(a2SameRead.ok, true, 'off a stale read both would grant — that is why re-read is required');

  // agent-1 writes first. agent-2 now re-reads the freshly written file and retries.
  const afterWrite = a1.fm;
  const a2Retry = claimTicket(afterWrite, 'agent-2', { at: '2026-07-18T01:00:01.000Z' });
  assert.equal(a2Retry.ok, false, 'loser is rejected on the fresh read');
  assert.equal(a2Retry.reason, 'claimed');
  assert.equal(a2Retry.fm.agent, 'agent-1', 'ticket stays owned by the winner');
});

// ---------------------------------------------------------------------------
// releaseTicket — clears the claim, bumps updated
// ---------------------------------------------------------------------------

test('releaseTicket removes the agent field and bumps updated', () => {
  const fm = { id: 'T', title: 'x', status: 'failed-testing', agent: 'agent-1', created: '2026-07-10T00:00:00.000Z', updated: '2026-07-18T01:00:00.000Z' };
  const out = releaseTicket(fm, { at: '2026-07-18T03:00:00.000Z' });
  assert.ok(!('agent' in out), 'agent claim cleared');
  assert.equal(out.updated, '2026-07-18T03:00:00.000Z', 'updated bumped');
  assert.equal(out.status, 'failed-testing', 'status left to the caller (terminal state)');
  assert.equal(out.created, '2026-07-10T00:00:00.000Z', 'created preserved');
});

test('releaseTicket does not mutate its input and keeps leading-key order', () => {
  const fm = { id: 'T', status: 'done', agent: 'a1', title: 't' };
  const snap = JSON.stringify(fm);
  const out = releaseTicket(fm, { at: '2026-07-18T03:00:00.000Z' });
  assert.equal(JSON.stringify(fm), snap, 'input untouched');
  assert.deepEqual(Object.keys(out).slice(0, 3), ['id', 'title', 'status']);
});

test('releaseTicket on an already-unclaimed ticket is a harmless no-op for the claim', () => {
  const out = releaseTicket({ id: 'T', status: 'todo' }, { at: '2026-07-18T03:00:00.000Z' });
  assert.ok(!('agent' in out));
  assert.equal(out.updated, '2026-07-18T03:00:00.000Z');
});

// A claim/release cycle round-trips: claim then release yields an unclaimed fm.
test('claim then release round-trips back to an unclaimed ticket', () => {
  const claimed = claimTicket({ id: 'T', status: 'todo' }, 'a1', { at: '2026-07-18T01:00:00.000Z' });
  assert.equal(claimed.fm.agent, 'a1');
  const released = releaseTicket(claimed.fm, { at: '2026-07-18T02:00:00.000Z' });
  assert.ok(!('agent' in released));
});

// ---------------------------------------------------------------------------
// selectNextBatch — bound math, oldest-first, skip-claimed
// ---------------------------------------------------------------------------

function T(id, status, extra) {
  return { fm: Object.assign({ id, status }, extra) };
}

test('selectNextBatch returns up to (limit - activeCount) claimable tickets', () => {
  const tickets = [
    T('TASK-001', 'in-progress', { agent: 'a1' }), // active, occupies a slot
    T('TASK-002', 'todo'),
    T('TASK-003', 'todo'),
    T('TASK-004', 'todo'),
  ];
  // limit 3, one active → 2 free slots.
  const batch = selectNextBatch(tickets, { limit: 3 });
  assert.equal(batch.length, 2);
  assert.deepEqual(batch.map((t) => t.fm.id), ['TASK-002', 'TASK-003']);
});

test('selectNextBatch returns [] when all slots are already occupied', () => {
  const tickets = [
    T('TASK-001', 'in-progress', { agent: 'a1' }),
    T('TASK-002', 'testing', { agent: 'a2' }),
    T('TASK-003', 'todo'),
  ];
  assert.deepEqual(selectNextBatch(tickets, { limit: 2 }), []);
});

test('selectNextBatch orders claimable tickets oldest-id first (numeric-aware)', () => {
  const tickets = [
    T('TASK-010', 'todo'),
    T('TASK-002', 'todo'),
    T('TASK-001', 'todo'),
    T('TASK-021', 'todo'),
  ];
  const batch = selectNextBatch(tickets, { limit: 8 });
  assert.deepEqual(batch.map((t) => t.fm.id), ['TASK-001', 'TASK-002', 'TASK-010', 'TASK-021']);
});

test('selectNextBatch skips tickets claimed by another agent and non-claimable lanes', () => {
  const tickets = [
    T('TASK-001', 'in-progress', { agent: 'a1' }), // active/owned → skip
    T('TASK-002', 'todo', { agent: 'other' }),     // owned by someone else, unusual status → skip
    T('TASK-003', 'done'),                          // terminal → skip
    T('TASK-004', 'todo'),                          // free → eligible
    T('TASK-005', 'failed-testing'),                // free → eligible
  ];
  const batch = selectNextBatch(tickets, { limit: 8 });
  assert.deepEqual(batch.map((t) => t.fm.id), ['TASK-004', 'TASK-005']);
});

// --- TASK-028: post-processing tickets are excluded from the build swarm ----

test('claimTicket refuses a kind:post-processing ticket even when status is claimable', () => {
  // A recipe ticket must never be built, even if its status were tampered to a
  // claimable value.
  for (const status of ['todo', 'failed-testing', 'post-processing']) {
    const res = claimTicket({ id: 'PP-1', status, kind: 'post-processing' }, 'a1', { at: '2026-07-18T01:00:00.000Z' });
    assert.equal(res.ok, false, `post-processing kind not claimable at status ${status}`);
    assert.equal(res.reason, 'post-processing');
  }
});

test('selectNextBatch never selects a post-processing ticket (kind guard)', () => {
  const tickets = [
    T('TASK-001', 'todo'),                                   // normal work
    T('PP-1', 'post-processing', { kind: 'post-processing' }), // recipe — excluded
    T('PP-2', 'todo', { kind: 'post-processing' }),          // tampered status — still excluded
  ];
  const batch = selectNextBatch(tickets, { limit: 8 });
  assert.deepEqual(batch.map((t) => t.fm.id), ['TASK-001'],
    'only the plain todo ticket is dispatched; post-processing tickets excluded');
});

test('CLAIMABLE_STATUSES is unchanged by TASK-028 (todo + failed-testing)', () => {
  assert.deepEqual([...CLAIMABLE_STATUSES].sort(), ['failed-testing', 'todo']);
});

// GHERKIN: "Concurrency is bounded" — limit 2, five todo tickets → at most 2
// worked at once, the rest wait.
test('CUCUMBER: concurrency is bounded (limit 2, 5 todos → 2 dispatched, 3 wait)', () => {
  const tickets = [
    T('TASK-001', 'todo'),
    T('TASK-002', 'todo'),
    T('TASK-003', 'todo'),
    T('TASK-004', 'todo'),
    T('TASK-005', 'todo'),
  ];
  const batch = selectNextBatch(tickets, { limit: 2 });
  assert.equal(batch.length, 2, 'only 2 dispatched');
  assert.deepEqual(batch.map((t) => t.fm.id), ['TASK-001', 'TASK-002'], 'oldest two first');
  // The other three remain untouched in todo (this helper never mutates them).
  assert.equal(tickets.filter((t) => t.fm.status === 'todo').length, 5);
});

// Once the first batch is "started" (statuses flip to in-progress), the next
// poll tops up to the bound but never exceeds it — models the top-up loop.
test('CUCUMBER: the top-up loop never exceeds the bound as work progresses', () => {
  const tickets = [
    T('TASK-001', 'in-progress', { agent: 'a1' }),
    T('TASK-002', 'in-progress', { agent: 'a2' }),
    T('TASK-003', 'todo'),
    T('TASK-004', 'todo'),
  ];
  // Two already active, limit 2 → no new dispatch.
  assert.deepEqual(selectNextBatch(tickets, { limit: 2 }), []);
  // One finishes (done) → a single free slot opens, exactly one is dispatched.
  tickets[0] = T('TASK-001', 'done');
  const batch = selectNextBatch(tickets, { limit: 2 });
  assert.deepEqual(batch.map((t) => t.fm.id), ['TASK-003']);
});

test('selectNextBatch counts a re-entrant own-claim without double-booking its slot', () => {
  // A ticket owned by this agent that is still active counts toward activeCount
  // AND is returned as claimable re-entry — but it must not consume an extra slot
  // beyond what activeCount already subtracted.
  const tickets = [
    T('TASK-001', 'in-progress', { agent: 'me' }),
    T('TASK-002', 'todo'),
    T('TASK-003', 'todo'),
  ];
  const batch = selectNextBatch(tickets, { limit: 2, agentId: 'me' });
  // limit 2 − 1 active = 1 slot. The re-entrant own ticket sorts first by id.
  assert.equal(batch.length, 1);
  assert.equal(batch[0].fm.id, 'TASK-001', 'own active ticket offered for re-entry');
});

test('selectNextBatch resolves a junk limit through resolveConcurrency (default bound)', () => {
  const tickets = Array.from({ length: 6 }, (_, i) => T(`TASK-00${i + 1}`, 'todo'));
  const batch = selectNextBatch(tickets, { limit: 'nonsense' });
  assert.equal(batch.length, DEFAULT_CONCURRENCY, 'falls back to the default concurrency bound');
});

test('selectNextBatch handles empty / non-array input safely', () => {
  assert.deepEqual(selectNextBatch([], { limit: 3 }), []);
  assert.deepEqual(selectNextBatch(null, { limit: 3 }), []);
  assert.deepEqual(selectNextBatch(undefined, {}), []);
});

// ---------------------------------------------------------------------------
// canRunInParallel — single-new-ticket dispatch decision (TASK-029)
// { ok, reason, freeSlots }; never throws / never returns undefined; pure;
// reuses resolveConcurrency/activeCount and the same predicates as
// selectNextBatch so verdicts compose.
// ---------------------------------------------------------------------------

test('canRunInParallel returns the { ok, reason, freeSlots } shape and never throws for any input', () => {
  const inputs = [
    [undefined, undefined, undefined],
    [null, null, null],
    ['garbage', 42, 'x'],
    [[], {}, {}],
    [[T('A', 'in-progress', { agent: 'a1' })], T('B', 'todo').fm, { limit: 3 }],
    [{}, { fm: null }, { limit: 'x' }],
    [[{ fm: null }, null], { status: '' }, {}],
  ];
  for (const [tickets, newTicket, opts] of inputs) {
    let res;
    assert.doesNotThrow(() => { res = canRunInParallel(tickets, newTicket, opts); },
      `no throw for ${JSON.stringify([tickets, newTicket, opts])}`);
    assert.notEqual(res, undefined, 'never returns undefined');
    assert.equal(typeof res.ok, 'boolean', 'ok is boolean');
    assert.equal(typeof res.reason, 'string', 'reason is string');
    assert.equal(typeof res.freeSlots, 'number', 'freeSlots is number');
    assert.ok(Number.isInteger(res.freeSlots) && res.freeSlots >= 0, 'freeSlots is a non-negative integer');
  }
});

test('canRunInParallel: ok:true only for a free slot + claimable, not-active, not-other-claimed ticket', () => {
  const board = [T('TASK-001', 'in-progress', { agent: 'a1' })]; // 1 active
  const res = canRunInParallel(board, T('TASK-100', 'todo').fm, { limit: 3 });
  assert.deepEqual(res, { ok: true, reason: 'ok', freeSlots: 2 });
});

test('canRunInParallel: freeSlots = max(0, resolveConcurrency(limit) - activeCount(tickets))', () => {
  const board = [
    T('A', 'in-progress', { agent: 'a1' }),
    T('B', 'testing', { agent: 'a2' }),
    T('C', 'todo'),
    T('D', 'done'),
  ]; // activeCount 2
  assert.equal(canRunInParallel(board, T('N', 'todo').fm, { limit: 3 }).freeSlots, 1);
  assert.equal(canRunInParallel(board, T('N', 'todo').fm, { limit: 8 }).freeSlots, 6);
  // junk limit → DEFAULT_CONCURRENCY (3); 3 - 2 = 1
  assert.equal(canRunInParallel(board, T('N', 'todo').fm, { limit: 'abc' }).freeSlots, 1);
  // > MAX clamps to 8; 8 - 2 = 6
  assert.equal(canRunInParallel(board, T('N', 'todo').fm, { limit: 1000 }).freeSlots, 6);
  // non-array tickets → 0 active → freeSlots = limit
  assert.equal(canRunInParallel('nope', T('N', 'todo').fm, { limit: 3 }).freeSlots, 3);
  assert.equal(canRunInParallel(null, T('N', 'todo').fm, {}).freeSlots, DEFAULT_CONCURRENCY);
});

test('canRunInParallel: failed-testing is an eligible (claimable) status', () => {
  const res = canRunInParallel([], T('T', 'failed-testing').fm, { limit: 3 });
  assert.equal(res.ok, true);
  assert.equal(res.reason, 'ok');
});

test('canRunInParallel: missing/invalid newTicket → no-ticket, freeSlots still computed', () => {
  const board = [T('A', 'in-progress', { agent: 'a1' })]; // freeSlots 2 @ limit 3
  for (const bad of [null, undefined, 42, 'x', {}, { status: '' }, { status: '   ' }, { fm: null }]) {
    const res = canRunInParallel(board, bad, { limit: 3 });
    assert.equal(res.ok, false, `no-ticket for ${JSON.stringify(bad)}`);
    assert.equal(res.reason, 'no-ticket', `reason for ${JSON.stringify(bad)}`);
    assert.equal(res.freeSlots, 2, 'freeSlots still computed from the board');
  }
});

test('canRunInParallel: claimed by a different agent → claimed', () => {
  const res = canRunInParallel(
    [T('A', 'in-progress', { agent: 'a1' })],
    T('N', 'todo', { agent: 'other-agent' }).fm,
    { limit: 3, agentId: 'me' },
  );
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'claimed');
});

test('canRunInParallel: already-active (not same-agent) → already-active', () => {
  for (const status of ['in-progress', 'testing']) {
    const res = canRunInParallel([], T('N', status).fm, { limit: 3 });
    assert.equal(res.ok, false, `already-active for ${status}`);
    assert.equal(res.reason, 'already-active');
  }
});

test('canRunInParallel: unclaimed non-claimable status → not-claimable', () => {
  for (const status of ['done', 'defining', 'weird-out-of-enum']) {
    const res = canRunInParallel([], T('N', status).fm, { limit: 3 });
    assert.equal(res.ok, false, `not-claimable for ${status}`);
    assert.equal(res.reason, 'not-claimable');
  }
});

test('canRunInParallel: eligible ticket but no free slots → no-slots, freeSlots 0', () => {
  const board = [
    T('A', 'in-progress', { agent: 'a1' }),
    T('B', 'in-progress', { agent: 'a2' }),
    T('C', 'testing', { agent: 'a3' }),
  ]; // 3 active, limit 3 → 0 free
  const res = canRunInParallel(board, T('N', 'todo').fm, { limit: 3 });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no-slots');
  assert.equal(res.freeSlots, 0);
});

test('canRunInParallel: same-agent re-entry is not "claimed"/"already-active" and stays eligible', () => {
  // Own active ticket handed back for re-fix; a same-agent claim is a safe re-entry.
  const board = [T('OTHER', 'testing', { agent: 'a2' })]; // 1 active, limit 3 → 2 free
  const reentry = canRunInParallel(board, T('N', 'failed-testing', { agent: 'me' }).fm, { limit: 3, agentId: 'me' });
  assert.equal(reentry.ok, true, 'same-agent claimable re-entry is ok');
  assert.equal(reentry.reason, 'ok');

  // Same-agent re-entry from an active status is eligible too (mirrors selectNextBatch).
  const activeReentry = canRunInParallel(board, T('N', 'in-progress', { agent: 'me' }).fm, { limit: 3, agentId: 'me' });
  assert.equal(activeReentry.ok, true, 'own active ticket offered for re-entry');
  assert.equal(activeReentry.reason, 'ok');
});

test('canRunInParallel: reason precedence — eligibility decided before capacity (full board, ineligible ticket)', () => {
  const full = [
    T('A', 'in-progress', { agent: 'a1' }),
    T('B', 'in-progress', { agent: 'a2' }),
    T('C', 'testing', { agent: 'a3' }),
  ]; // 0 free
  // A "done" (not-claimable) ticket on a full board reports the ineligibility, not no-slots.
  assert.equal(canRunInParallel(full, T('N', 'done').fm, { limit: 3 }).reason, 'not-claimable');
  // A ticket claimed by another agent reports claimed, not no-slots.
  assert.equal(canRunInParallel(full, T('N', 'todo', { agent: 'x' }).fm, { limit: 3, agentId: 'me' }).reason, 'claimed');
  // A missing ticket reports no-ticket, not no-slots.
  assert.equal(canRunInParallel(full, null, { limit: 3 }).reason, 'no-ticket');
  // A post-processing ticket reports post-processing, not no-slots.
  assert.equal(canRunInParallel(full, T('N', 'todo', { kind: 'post-processing' }).fm, { limit: 3 }).reason, 'post-processing');
});

test('canRunInParallel: kind:post-processing ticket is NEVER eligible (reason post-processing)', () => {
  for (const status of ['todo', 'failed-testing', 'post-processing']) {
    const res = canRunInParallel([], T('PP', status, { kind: 'post-processing' }).fm, { limit: 3 });
    assert.equal(res.ok, false, `post-processing not eligible at status ${status}`);
    assert.equal(res.reason, 'post-processing');
  }
});

test('canRunInParallel: accepts both bare fm and { fm } wrappers for tickets[] and newTicket (identical verdicts)', () => {
  const bareBoard = [{ id: 'A', status: 'in-progress', agent: 'a1' }];
  const wrappedBoard = [{ fm: { id: 'A', status: 'in-progress', agent: 'a1' } }];
  const bareNew = { id: 'N', status: 'todo' };
  const wrappedNew = { fm: { id: 'N', status: 'todo' } };
  const a = canRunInParallel(bareBoard, bareNew, { limit: 3 });
  const b = canRunInParallel(wrappedBoard, wrappedNew, { limit: 3 });
  assert.deepEqual(a, b);
  assert.deepEqual(a, { ok: true, reason: 'ok', freeSlots: 2 });
});

test('canRunInParallel is pure: does not mutate tickets, newTicket, or opts', () => {
  const board = [T('A', 'in-progress', { agent: 'a1' }), T('B', 'todo')];
  const newTicket = { fm: { id: 'N', status: 'todo' } };
  const opts = { limit: 3, agentId: 'me' };
  const boardSnap = JSON.stringify(board);
  const newSnap = JSON.stringify(newTicket);
  const optsSnap = JSON.stringify(opts);
  canRunInParallel(board, newTicket, opts);
  assert.equal(JSON.stringify(board), boardSnap, 'tickets untouched');
  assert.equal(JSON.stringify(newTicket), newSnap, 'newTicket untouched');
  assert.equal(JSON.stringify(opts), optsSnap, 'opts untouched');
});

test('canRunInParallel verdict composes with selectNextBatch (ok:true ⇒ among selectNextBatch candidates)', () => {
  const board = [
    T('TASK-001', 'in-progress', { agent: 'a1' }), // 1 active → 2 free @ limit 3
    T('TASK-110', 'todo'),
    T('TASK-111', 'todo'),
  ];
  const verdict = canRunInParallel(board, T('TASK-110', 'todo').fm, { limit: 3 });
  assert.equal(verdict.ok, true);
  const batch = selectNextBatch(board, { limit: 3 }).map((t) => t.fm.id);
  assert.ok(batch.includes('TASK-110'), 'ok:true ticket is among selectNextBatch candidates');
});

// ---------------------------------------------------------------------------
// idSlug / ticketBranchName / ticketWorktreeDir — per-ticket git isolation
// ---------------------------------------------------------------------------

test('idSlug lowercases and dashes to a git-ref-safe slug', () => {
  assert.equal(idSlug('TASK-004'), 'task-004');
  assert.equal(idSlug('  TASK 4 (multi agent)  '), 'task-4-multi-agent');
  assert.equal(idSlug('a__b//c'), 'a-b-c');
  assert.equal(idSlug('--x--'), 'x', 'trims leading/trailing dashes');
});

test('idSlug falls back to "ticket" for empty/garbage ids', () => {
  assert.equal(idSlug(''), 'ticket');
  assert.equal(idSlug('   '), 'ticket');
  assert.equal(idSlug('***'), 'ticket');
  assert.equal(idSlug(null), 'ticket');
  assert.equal(idSlug(undefined), 'ticket');
});

test('ticketBranchName derives orchestrate/<slug> (TASK-004 -> orchestrate/task-004)', () => {
  assert.equal(ticketBranchName('TASK-004'), 'orchestrate/task-004');
  assert.equal(ticketBranchName('TASK-300'), 'orchestrate/task-300');
});

test('ticketWorktreeDir joins base + slug with forward slashes, trimming trailing separators', () => {
  assert.equal(ticketWorktreeDir('.worktrees', 'TASK-004'), '.worktrees/task-004');
  assert.equal(ticketWorktreeDir('.worktrees/', 'TASK-004'), '.worktrees/task-004');
  assert.equal(ticketWorktreeDir('C:\\repo\\wt\\', 'TASK-004'), 'C:\\repo\\wt/task-004');
  assert.equal(ticketWorktreeDir(null, 'TASK-004'), '.worktrees/task-004', 'defaults the base dir');
});

// GHERKIN: "Concurrent writes do not cross tickets" / "Shared git state is not
// corrupted" — distinct ticket ids yield distinct, non-colliding branch and
// worktree names, so parallel builds never share a working tree.
test('CUCUMBER: two concurrent tickets get distinct, non-colliding isolation names', () => {
  const a = 'TASK-300';
  const b = 'TASK-301';
  assert.notEqual(ticketBranchName(a), ticketBranchName(b));
  assert.notEqual(ticketWorktreeDir('.worktrees', a), ticketWorktreeDir('.worktrees', b));
  assert.equal(ticketBranchName(a), 'orchestrate/task-300');
  assert.equal(ticketBranchName(b), 'orchestrate/task-301');
});

// GHERKIN: "Two tickets built at the same time" — the board derives its active
// lane from a LIST of statuses, so two tickets can be active concurrently.
test('CUCUMBER: two different tickets can be in-progress simultaneously (both counted active)', () => {
  const tickets = [
    T('TASK-300', 'in-progress', { agent: 'agent-1' }),
    T('TASK-301', 'in-progress', { agent: 'agent-2' }),
    T('TASK-302', 'todo'),
  ];
  assert.equal(activeCount(tickets), 2, 'both actively-worked at once');
  assert.equal(isActive('in-progress'), true);
});

// ---------------------------------------------------------------------------
// orderFm — leading-key ordering matches the real serializer rule
// ---------------------------------------------------------------------------

test('orderFm puts present leading keys first, then rest in insertion order (agent preserved)', () => {
  const fm = { agent: 'a1', updated: 'u', id: 'T', status: 's', title: 't', created: 'c' };
  assert.deepEqual(Object.keys(orderFm(fm)), ['id', 'title', 'status', 'created', 'updated', 'agent']);
});

test('orderFm omits null/undefined leading keys and does not mutate input', () => {
  const fm = { status: 's', id: 'T', agent: 'a1' };
  const snap = JSON.stringify(fm);
  assert.deepEqual(Object.keys(orderFm(fm)), ['id', 'status', 'agent']);
  assert.equal(JSON.stringify(fm), snap);
});

// ---------------------------------------------------------------------------
// Round-trip: the `agent` claim field survives a whole-file serialize/parse
// (real serializer copied from renderer.js above). This backs the "concurrent
// writes are whole-file and preserve the claim" acceptance criterion.
// ---------------------------------------------------------------------------

const BODY = [
  '',
  '## Description',
  'Build the thing concurrently.',
  '',
  '## Additional Context',
  '(User-owned. Never overwrite.)',
  'A note with **markdown** and a trailing space.   ',
].join('\n');

test('the agent claim field survives parse(serialize(fm, body)) round-trip', () => {
  const claimed = claimTicket(
    { id: 'TASK-004', title: 'multi agent', status: 'todo', created: '2026-07-18T03:54:22.555Z' },
    'agent-7',
    { at: '2026-07-18T05:00:00.000Z' },
  );
  const round = parseTicketFrontmatter(serializeTicket(claimed.fm, BODY));
  assert.ok(round, 'parses back');
  assert.equal(round.fm.agent, 'agent-7', 'agent claim round-trips');
  assert.equal(round.fm.status, 'in-progress');
  assert.equal(round.fm.updated, '2026-07-18T05:00:00.000Z');
  assert.equal(round.fm.created, '2026-07-18T03:54:22.555Z', 'created preserved through the write');
});

test('claim leading-key order is stable after a round-trip; agent trails the known keys', () => {
  const claimed = claimTicket(
    { id: 'TASK-004', title: 'multi agent', status: 'todo', created: '2026-07-18T03:54:22.555Z' },
    'agent-7',
    { at: '2026-07-18T05:00:00.000Z' },
  );
  const round = parseTicketFrontmatter(serializeTicket(claimed.fm, BODY));
  const keys = Object.keys(round.fm);
  assert.deepEqual(keys.slice(0, 5), ['id', 'title', 'status', 'created', 'updated']);
  assert.ok(keys.includes('agent'), 'agent present after the leading keys');
});

test('releasing the claim removes agent from the serialized file', () => {
  const claimed = claimTicket({ id: 'TASK-004', title: 't', status: 'todo' }, 'agent-7', { at: '2026-07-18T05:00:00.000Z' });
  const released = releaseTicket(claimed.fm, { at: '2026-07-18T06:00:00.000Z' });
  const round = parseTicketFrontmatter(serializeTicket(released, BODY));
  assert.ok(!('agent' in round.fm), 'no agent key in the released, serialized ticket');
});

test('## Additional Context is preserved verbatim through a claim write', () => {
  const claimed = claimTicket({ id: 'TASK-004', title: 't', status: 'todo' }, 'agent-7', { at: '2026-07-18T05:00:00.000Z' });
  const round = parseTicketFrontmatter(serializeTicket(claimed.fm, BODY));
  assert.equal(round.body, BODY, 'body byte-for-byte identical');
  assert.match(round.body, /A note with \*\*markdown\*\* and a trailing space\.   /);
});

// GHERKIN: "Concurrent writes do not cross tickets" — each claim write is a
// whole-file serialize of ONE ticket's fm; serializing TASK-300 only ever
// produces TASK-300's bytes and cannot carry TASK-301's id/agent.
test('CUCUMBER: each ticket write only ever contains its own id/claim', () => {
  const c300 = claimTicket({ id: 'TASK-300', title: 'a', status: 'todo' }, 'agent-1', { at: '2026-07-18T05:00:00.000Z' });
  const c301 = claimTicket({ id: 'TASK-301', title: 'b', status: 'todo' }, 'agent-2', { at: '2026-07-18T05:00:00.000Z' });
  const f300 = serializeTicket(c300.fm, BODY);
  const f301 = serializeTicket(c301.fm, BODY);

  assert.match(f300, /id: TASK-300/);
  assert.match(f300, /agent: agent-1/);
  assert.ok(!f300.includes('TASK-301'), "TASK-300's file never mentions TASK-301");
  assert.ok(!f300.includes('agent-2'), "TASK-300's file never carries agent-2's claim");

  assert.match(f301, /id: TASK-301/);
  assert.match(f301, /agent: agent-2/);
  assert.ok(!f301.includes('TASK-300'));
  assert.ok(!f301.includes('agent-1'));
});
