'use strict';

// Unit tests for the TASK-110 fix in lib/ticket-queue.js `claimTicket`: the
// isUserStatus(status) guard now runs UNCONDITIONALLY on the pickup path (below
// the foreign-`claimed` check), so a SAME-agent re-entry on a user-status ticket
// is refused with reason 'not-claimable' instead of silently re-granting and
// yanking the ticket back to in-progress. These tests exercise the guard verdicts
// plus the purity/immutability contract on the new refusal path.
//
// lib/ticket-queue.js is a pure, Electron-free module — no disk / git / network /
// DB is touched. Every ticket is a plain in-memory object and every assertion is
// made against the helper's return value. Any DB access would be mocked; this
// module makes none.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  claimTicket,
  canRunInParallel,
} = require('../lib/ticket-queue');

// TASK-206 removed the kind:post-processing concept and its POST_PROCESSING_KIND
// export entirely. A leftover `kind: post-processing` frontmatter key from before
// the removal is now just an arbitrary, ignored string.
const LEGACY_POST_PROCESSING_KIND = 'post-processing';

// ── The reported bug: same-agent re-entry on a user status is refused ─────────

test('claimTicket refuses a same-agent user-status ticket with reason not-claimable', () => {
  const res = claimTicket({ status: 'ux-review', agent: 'agent-1' }, 'agent-1');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'not-claimable');
});

test('same-agent user-status refusal does NOT stamp in-progress and keeps owner/status', () => {
  const res = claimTicket({ id: 'TASK-1', status: 'ux-review', agent: 'agent-1' }, 'agent-1');
  assert.equal(res.ok, false);
  assert.equal(res.fm.status, 'ux-review');
  assert.equal(res.fm.agent, 'agent-1');
});

// ── Purity / immutability on the refusal path ────────────────────────────────

test('same-agent user-status refusal does not bump updated', () => {
  const updated = '2020-01-01T00:00:00.000Z';
  const res = claimTicket(
    { id: 'TASK-1', status: 'ux-review', agent: 'agent-1', updated },
    'agent-1',
    { at: '2099-12-31T00:00:00.000Z' },
  );
  assert.equal(res.ok, false);
  assert.equal(res.fm.updated, updated);
});

test('same-agent user-status refusal does not mutate the input frontmatter object', () => {
  const input = { id: 'TASK-1', status: 'ux-review', agent: 'agent-1', updated: 'T0' };
  const snapshot = JSON.stringify(input);
  const res = claimTicket(input, 'agent-1');
  assert.equal(res.ok, false);
  assert.notEqual(res.fm, input); // a NEW object is returned
  assert.equal(JSON.stringify(input), snapshot); // input untouched
});

// ── Unclaimed user status still refused ──────────────────────────────────────

test('claimTicket refuses an UNCLAIMED user-status ticket with not-claimable', () => {
  const res = claimTicket({ id: 'TASK-1', status: 'ux-review' }, 'agent-A');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'not-claimable');
});

// ── Reason precedence preserved ──────────────────────────────────────────────

test('foreign-agent user-status ticket still reports claimed (precedence over not-claimable)', () => {
  const res = claimTicket({ id: 'TASK-1', status: 'ux-review', agent: 'other' }, 'agent-A');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'claimed');
});

test('a leftover kind:post-processing key does not change the user-status guard verdict (kind is inert, TASK-206)', () => {
  const res = claimTicket(
    { id: 'TASK-1', status: 'ux-review', agent: 'agent-1', kind: LEGACY_POST_PROCESSING_KIND },
    'agent-1',
  );
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'not-claimable', 'still refused purely by the user status, not the kind');
  assert.notEqual(res.reason, 'post-processing', 'no post-processing reason is ever returned');
});

test('blank agent id refuses no-agent-id first, regardless of user status', () => {
  const res = claimTicket({ id: 'TASK-1', status: 'ux-review', agent: 'agent-1' }, '   ');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no-agent-id');
});

// ── claimTicket and canRunInParallel compose on the same input ────────────────

test('claimTicket and canRunInParallel both refuse same-agent user status as not-claimable', () => {
  const fm = { id: 'TASK-1', status: 'ux-review', agent: 'agent-1' };
  const claim = claimTicket(fm, 'agent-1');
  const parallel = canRunInParallel([], { fm }, { limit: 3, agentId: 'agent-1' });
  assert.equal(claim.ok, false);
  assert.equal(claim.reason, 'not-claimable');
  assert.equal(parallel.ok, false);
  assert.equal(parallel.reason, 'not-claimable');
});

// ── Same-agent re-entry on swarm statuses is UNCHANGED (still grants) ─────────

test('same-agent re-entry on in-progress still grants and bumps updated', () => {
  const at = '2026-07-21T03:00:00.000Z';
  const res = claimTicket(
    { id: 'TASK-1', status: 'in-progress', agent: 'a1', created: 'C0', updated: 'U0' },
    'a1',
    { at },
  );
  assert.equal(res.ok, true);
  assert.equal(res.fm.status, 'in-progress');
  assert.equal(res.fm.agent, 'a1');
  assert.equal(res.fm.updated, at);
  assert.equal(res.fm.created, 'C0');
});

for (const status of ['todo', 'failed-testing', 'testing']) {
  test(`same-agent re-entry from ${status} still grants`, () => {
    const res = claimTicket({ id: 'TASK-1', status, agent: 'a1' }, 'a1');
    assert.equal(res.ok, true);
    assert.equal(res.fm.status, 'in-progress');
    assert.equal(res.fm.agent, 'a1');
  });
}

// ── Normal system-status claiming is UNCHANGED ───────────────────────────────

for (const status of ['todo', 'failed-testing']) {
  test(`fresh ${status} ticket still grants to the claiming agent`, () => {
    const res = claimTicket({ id: 'TASK-1', status }, 'agent-1');
    assert.equal(res.ok, true);
    assert.equal(res.fm.status, 'in-progress');
    assert.equal(res.fm.agent, 'agent-1');
  });
}

test('foreign-claimed swarm ticket still refuses with claimed', () => {
  const res = claimTicket({ id: 'TASK-1', status: 'todo', agent: 'other' }, 'agent-1');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'claimed');
});

for (const status of ['in-progress', 'testing', 'done']) {
  test(`unowned ${status} ticket refuses with not-claimable`, () => {
    const res = claimTicket({ id: 'TASK-1', status }, 'agent-1');
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'not-claimable');
  });
}

test('blank agent id refuses no-agent-id on a plain todo ticket', () => {
  const res = claimTicket({ id: 'TASK-1', status: 'todo' }, '');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no-agent-id');
});
