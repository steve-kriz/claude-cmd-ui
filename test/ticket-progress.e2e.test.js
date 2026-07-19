'use strict';

// E2E cucumber-style tests for TASK-021 "ticket progress" — surfacing
// parallel-build visibility on the Tasks board. There is no cucumber package
// (by design) and no DOM harness: renderer/renderer.js is a browser script that
// cannot be required. So each scenario is a Given/When/Then node:test case
// exercising the pure lib/ticket-progress.js helpers (the canonical form of the
// renderer's inline logic), plus a tiny in-test board-status assembler that
// reproduces the renderer's status-line formula
// (`${total} ticket(s)${runningFragment}${polling}`, renderer.js ~5731).
// Everything is derived purely from persisted frontmatter — NO DB, NO network,
// NO real IO; ticket "state" is plain in-memory frontmatter objects.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  countRunning,
  agentLabel,
  runningFragment,
} = require('../lib/ticket-progress');

// In-test board-status assembler — reproduces renderer.js renderTasksBoard's
// status-line formula verbatim (~5731). Kept in lockstep with the renderer.
function boardStatusLine(tickets, { polling } = {}) {
  const total = tickets.length;
  const frag = runningFragment(countRunning(tickets));
  const poll = polling ? ' · polling' : '';
  return total ? `${total} ticket${total === 1 ? '' : 's'}${frag}${poll}` : '';
}

// Whether a card would render an agent label (the renderer only appends the
// <div class="task-card-agent"> when agentLabel is non-empty).
function cardShowsAgentLabel(fm) {
  return agentLabel(fm) !== '';
}

// ---------------------------------------------------------------------------
// Scenario: an in-progress ticket with agent "build-a1" shows its label and
// counts as running.
// ---------------------------------------------------------------------------
test('Scenario: in-progress ticket with an agent shows its label and counts as running', () => {
  // Given an in-progress ticket claimed by agent "build-a1"
  const ticket = { fm: { id: 'TASK-100', status: 'in-progress', agent: 'build-a1' } };
  // When the board derives the card label and running count
  const label = agentLabel(ticket.fm);
  const running = countRunning([ticket]);
  // Then the card shows the agent id "build-a1" and it counts as 1 running
  assert.equal(label, 'build-a1');
  assert.equal(cardShowsAgentLabel(ticket.fm), true);
  assert.equal(running, 1);
});

// ---------------------------------------------------------------------------
// Scenario: a todo ticket with no agent shows no label and is not counted.
// ---------------------------------------------------------------------------
test('Scenario: a todo ticket with no agent shows no label and is not counted', () => {
  // Given a todo ticket with no agent claim
  const ticket = { fm: { id: 'TASK-101', status: 'todo' } };
  // When the board derives the card label and running count
  // Then no label is shown and it does not count as running
  assert.equal(agentLabel(ticket.fm), '');
  assert.equal(cardShowsAgentLabel(ticket.fm), false);
  assert.equal(countRunning([ticket]), 0);
});

// ---------------------------------------------------------------------------
// Scenario: claim released (agent removed, status done) -> no label, not
// counted.
// ---------------------------------------------------------------------------
test('Scenario: a released claim (agent removed, status done) shows no label and is not counted', () => {
  // Given a ticket that finished — status done and the agent field cleared
  const ticket = { fm: { id: 'TASK-102', status: 'done' } };
  // When the board derives its label and running count
  // Then there is no agent label and it does not count as running
  assert.equal(agentLabel(ticket.fm), '');
  assert.equal(cardShowsAgentLabel(ticket.fm), false);
  assert.equal(countRunning([ticket]), 0);
});

// ---------------------------------------------------------------------------
// Scenario: three in-progress + one testing -> status line includes "4
// running".
// ---------------------------------------------------------------------------
test('Scenario: three in-progress + one testing yields "4 running" in the status line', () => {
  // Given three in-progress tickets and one testing ticket among a larger board
  const tickets = [
    { fm: { id: 'TASK-1', status: 'in-progress', agent: 'a1' } },
    { fm: { id: 'TASK-2', status: 'in-progress', agent: 'a2' } },
    { fm: { id: 'TASK-3', status: 'in-progress', agent: 'a3' } },
    { fm: { id: 'TASK-4', status: 'testing', agent: 'a4' } },
    { fm: { id: 'TASK-5', status: 'todo' } },
    { fm: { id: 'TASK-6', status: 'done' } },
  ];
  // When the board builds its status line while polling
  const line = boardStatusLine(tickets, { polling: true });
  // Then it reports 6 tickets, 4 running
  assert.equal(countRunning(tickets), 4);
  assert.match(line, /4 running/);
  assert.equal(line, '6 tickets · 4 running · polling');
});

// ---------------------------------------------------------------------------
// Scenario: count updates as a slot frees (3 running -> one goes done -> 2
// running).
// ---------------------------------------------------------------------------
test('Scenario: running count updates as a slot frees (3 -> 2)', () => {
  // Given three in-progress tickets
  const tickets = [
    { fm: { id: 'TASK-1', status: 'in-progress', agent: 'a1' } },
    { fm: { id: 'TASK-2', status: 'in-progress', agent: 'a2' } },
    { fm: { id: 'TASK-3', status: 'in-progress', agent: 'a3' } },
  ];
  // When the board first derives the count, then one ticket completes (its
  // status flips to done and its agent claim is released) on the next poll
  assert.equal(countRunning(tickets), 3);
  tickets[0].fm = { id: 'TASK-1', status: 'done' };
  // Then the running count drops to 2 and the released card shows no label
  assert.equal(countRunning(tickets), 2);
  assert.equal(cardShowsAgentLabel(tickets[0].fm), false);
  assert.equal(boardStatusLine(tickets, { polling: true }), '3 tickets · 2 running · polling');
});

// ---------------------------------------------------------------------------
// Scenario Outline: 0 -> omitted, 1 -> "1 running", 5 -> "5 running".
// ---------------------------------------------------------------------------
for (const { count, expectedFragment } of [
  { count: 0, expectedFragment: '' },
  { count: 1, expectedFragment: ' · 1 running' },
  { count: 5, expectedFragment: ' · 5 running' },
]) {
  test(`Scenario Outline: <${count}> active -> fragment "<${expectedFragment}>"`, () => {
    // Given <count> active tickets on the board
    const tickets = Array.from({ length: count }, (_, i) => (
      { fm: { id: `TASK-${i}`, status: 'in-progress', agent: `a${i}` } }
    ));
    // When the board builds the running fragment from the derived count
    const frag = runningFragment(countRunning(tickets));
    // Then it matches the expected fragment (0 is omitted entirely)
    assert.equal(frag, expectedFragment);
    if (count === 0) {
      assert.equal(boardStatusLine(tickets, { polling: false }), '');
    }
  });
}

// ---------------------------------------------------------------------------
// Failure/edge: an agent on an unknown / out-of-enum status ticket still shows
// its label, but is NOT counted as running (unknown status is not in the active
// set).
// ---------------------------------------------------------------------------
test('Edge: agent on an out-of-enum status shows the label but is NOT counted as running', () => {
  // Given a ticket in an unknown/out-of-enum status that still carries an agent
  const ticket = { fm: { id: 'TASK-200', status: 'archived-weird', agent: 'build-z9' } };
  // When the board derives its label and running count
  // Then the label is shown (agent is non-empty) but it does not count
  assert.equal(agentLabel(ticket.fm), 'build-z9');
  assert.equal(cardShowsAgentLabel(ticket.fm), true);
  assert.equal(countRunning([ticket]), 0);
  assert.equal(boardStatusLine([ticket], { polling: true }), '1 ticket · polling');
});

// ---------------------------------------------------------------------------
// Failure/edge: a whitespace-only agent is treated as no claim (no label).
// ---------------------------------------------------------------------------
test('Edge: a whitespace-only agent is treated as no claim (no label)', () => {
  // Given an in-progress ticket whose agent field is whitespace only
  const ticket = { fm: { id: 'TASK-201', status: 'in-progress', agent: '   ' } };
  // When the board derives its label and running count
  // Then no label is shown; the ticket still counts as running by its status
  assert.equal(agentLabel(ticket.fm), '');
  assert.equal(cardShowsAgentLabel(ticket.fm), false);
  assert.equal(countRunning([ticket]), 1);
});
