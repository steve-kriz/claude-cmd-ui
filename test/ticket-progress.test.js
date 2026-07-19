'use strict';

// Unit tests for lib/ticket-progress.js — the Electron-free pure helpers that
// host the Tasks board's inline running-count / agent-label logic (TASK-021).
// The module is pure (no disk/network/Electron/DB), so it is exercised directly
// with plain `node --test`. renderer/renderer.js mirrors this logic inline and
// is a browser script that cannot be required, so these tests prove the
// canonical helper the renderer duplicates.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  TASKS_ACTIVE_STATUSES,
  countRunning,
  agentLabel,
  runningFragment,
} = require('../lib/ticket-progress');

// ---------------------------------------------------------------------------
// countRunning
// ---------------------------------------------------------------------------

test('countRunning: counts only tickets whose status is in the board active set', () => {
  const tickets = [
    { fm: { id: 'T-1', status: 'defining' } },
    { fm: { id: 'T-2', status: 'in-progress' } },
    { fm: { id: 'T-3', status: 'testing' } },
    { fm: { id: 'T-4', status: 'todo' } },
    { fm: { id: 'T-5', status: 'done' } },
    { fm: { id: 'T-6', status: 'failed-testing' } },
    { fm: { id: 'T-7', status: 'unknown' } },
  ];
  assert.equal(countRunning(tickets), 3);
});

test('countRunning: the board active set includes defining (divergent from lib ACTIVE_STATUSES)', () => {
  assert.deepEqual(TASKS_ACTIVE_STATUSES, ['defining', 'in-progress', 'testing']);
  assert.equal(countRunning([{ fm: { status: 'defining' } }]), 1);
});

test('countRunning: a ticket with an agent field but a non-active status does NOT count', () => {
  const tickets = [
    { fm: { id: 'T-1', status: 'todo', agent: 'build-a1' } },
    { fm: { id: 'T-2', status: 'done', agent: 'build-a2' } },
    { fm: { id: 'T-3', status: 'failed-testing', agent: 'build-a3' } },
  ];
  assert.equal(countRunning(tickets), 0);
});

test('countRunning: accepts both { fm } wrappers and bare frontmatter objects', () => {
  const mixed = [
    { fm: { status: 'in-progress' } }, // wrapped
    { status: 'testing' },             // bare
    { status: 'todo' },                // bare, not active
  ];
  assert.equal(countRunning(mixed), 2);
});

test('countRunning: empty list -> 0, non-array -> 0', () => {
  assert.equal(countRunning([]), 0);
  assert.equal(countRunning(null), 0);
  assert.equal(countRunning(undefined), 0);
  assert.equal(countRunning('nope'), 0);
});

test('countRunning: honours a caller-supplied active-status set', () => {
  const tickets = [
    { fm: { status: 'in-progress' } },
    { fm: { status: 'testing' } },
    { fm: { status: 'defining' } },
  ];
  // Restrict to the claim set (no defining) -> only 2 count.
  assert.equal(countRunning(tickets, ['in-progress', 'testing']), 2);
});

// ---------------------------------------------------------------------------
// agentLabel
// ---------------------------------------------------------------------------

test('agentLabel: returns the trimmed id for a non-empty agent', () => {
  assert.equal(agentLabel({ agent: 'build-a1' }), 'build-a1');
  assert.equal(agentLabel({ agent: '  build-a1  ' }), 'build-a1');
});

test('agentLabel: returns "" for missing / null / empty / whitespace-only agent', () => {
  assert.equal(agentLabel({}), '');
  assert.equal(agentLabel({ agent: null }), '');
  assert.equal(agentLabel({ agent: '' }), '');
  assert.equal(agentLabel({ agent: '   ' }), '');
  assert.equal(agentLabel(null), '');
  assert.equal(agentLabel(undefined), '');
});

test('agentLabel: accepts a { fm } wrapper too', () => {
  assert.equal(agentLabel({ fm: { agent: 'build-x' } }), 'build-x');
});

// ---------------------------------------------------------------------------
// runningFragment
// ---------------------------------------------------------------------------

test('runningFragment: "" for 0, " · N running" for N > 0', () => {
  assert.equal(runningFragment(0), '');
  assert.equal(runningFragment(1), ' · 1 running');
  assert.equal(runningFragment(5), ' · 5 running');
});

// ---------------------------------------------------------------------------
// Composition — full status strings (caller owns singular/plural + polling)
// ---------------------------------------------------------------------------

function statusLine(tickets, polling) {
  const total = tickets.length;
  const frag = runningFragment(countRunning(tickets));
  const poll = polling ? ' · polling' : '';
  return total ? `${total} ticket${total === 1 ? '' : 's'}${frag}${poll}` : '';
}

test('composition: "7 tickets · 3 running · polling"', () => {
  const tickets = [
    { fm: { status: 'defining' } },
    { fm: { status: 'in-progress' } },
    { fm: { status: 'testing' } },
    { fm: { status: 'todo' } },
    { fm: { status: 'todo' } },
    { fm: { status: 'done' } },
    { fm: { status: 'failed-testing' } },
  ];
  assert.equal(statusLine(tickets, true), '7 tickets · 3 running · polling');
});

test('composition: zero-active case omits the running fragment', () => {
  const tickets = [
    { fm: { status: 'todo' } },
    { fm: { status: 'done' } },
  ];
  assert.equal(statusLine(tickets, true), '2 tickets · polling');
  assert.equal(statusLine(tickets, false), '2 tickets');
});

test('composition: empty board -> empty status line', () => {
  assert.equal(statusLine([], true), '');
});
