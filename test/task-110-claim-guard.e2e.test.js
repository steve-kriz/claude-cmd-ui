'use strict';

// E2e cucumber-style scenarios for TASK-110 in lib/ticket-queue.js `claimTicket`:
// the isUserStatus(status) guard now runs UNCONDITIONALLY on the pickup path so a
// SAME-agent re-entry on a user-status ticket is refused (reason 'not-claimable')
// rather than silently re-granting and pulling the ticket back to in-progress.
// These implement the ticket's Gherkin Feature
//   ("claimTicket refuses user-status tickets even on same-agent re-entry")
// as Given/When/Then `node --test` cases.
//
// There is NO `cucumber` npm package (none installed, none added) — the
// Given/When/Then steps are plain closures per the repo convention for
// *.e2e.test.js files (see test/task-100-swarm-guards.e2e.test.js).
//
// lib/ticket-queue.js is pure: no DB / disk / git / network is touched. Board
// snapshots are plain in-memory objects and every assertion is against the
// helper's return value. Any DB access would be mocked; this module makes none.
//
//   Feature: claimTicket refuses user-status tickets even on same-agent re-entry

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

// Tiny Given/When/Then scaffolding so scenario bodies read as Gherkin steps
// without any external cucumber runtime.
function scenario(name, steps) {
  test(`Scenario: ${name}`, steps);
}
const Given = (_desc, fn) => (fn ? fn() : undefined);
const When = (_desc, fn) => fn();
const Then = (_desc, fn) => fn();
const And = Then;

// ─────────────────────────────────────────────────────────────────────────────
scenario('same-agent re-entry on a user-status ticket is refused (the bug)', () => {
  let input; let snapshot; let res;
  Given('a ticket with status "ux-review" and agent "agent-1"', () => {
    input = { id: 'TASK-1', status: 'ux-review', agent: 'agent-1', updated: 'U0', created: 'C0' };
    snapshot = JSON.stringify(input);
  });
  When('claimTicket runs for agent "agent-1"', () => {
    res = claimTicket(input, 'agent-1', { at: '2099-12-31T00:00:00.000Z' });
  });
  Then('the result is ok:false with reason "not-claimable"', () => {
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'not-claimable');
  });
  And('the returned frontmatter still has status "ux-review" and agent "agent-1"', () => {
    assert.equal(res.fm.status, 'ux-review');
    assert.equal(res.fm.agent, 'agent-1');
  });
  And('the "updated" timestamp is not bumped', () => {
    assert.equal(res.fm.updated, 'U0');
  });
  And('the input frontmatter object is not mutated', () => {
    assert.equal(JSON.stringify(input), snapshot);
    assert.notEqual(res.fm, input);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
scenario('claimTicket and canRunInParallel agree on the same-agent user-status input', () => {
  let fm; let claim; let parallel;
  Given('a ticket with status "ux-review" and agent "agent-1"', () => {
    fm = { id: 'TASK-1', status: 'ux-review', agent: 'agent-1' };
  });
  When('claimTicket runs for agent "agent-1"', () => {
    claim = claimTicket(fm, 'agent-1');
  });
  And('canRunInParallel runs on an empty board for the same ticket with agentId "agent-1"', () => {
    parallel = canRunInParallel([], { fm }, { limit: 3, agentId: 'agent-1' });
  });
  Then('both results are ok:false with reason "not-claimable"', () => {
    assert.equal(claim.ok, false);
    assert.equal(claim.reason, 'not-claimable');
    assert.equal(parallel.ok, false);
    assert.equal(parallel.reason, 'not-claimable');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
scenario('unclaimed user-status ticket is still refused', () => {
  let res;
  Given('a ticket with status "ux-review" and no agent field', () => {});
  When('claimTicket runs for agent "agent-A"', () => {
    res = claimTicket({ id: 'TASK-1', status: 'ux-review' }, 'agent-A');
  });
  Then('the result is ok:false with reason "not-claimable"', () => {
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'not-claimable');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
scenario('user-status ticket owned by a DIFFERENT agent still reports claimed', () => {
  let res;
  Given('a ticket with status "ux-review" and agent "other"', () => {});
  When('claimTicket runs for agent "agent-A"', () => {
    res = claimTicket({ id: 'TASK-1', status: 'ux-review', agent: 'other' }, 'agent-A');
  });
  Then('the result is ok:false with reason "claimed"', () => {
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'claimed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
scenario('same-agent re-entry on a swarm ACTIVE status still grants (unchanged)', () => {
  let res;
  const at = '2026-07-21T03:00:00.000Z';
  Given('a ticket with status "in-progress" and agent "agent-1"', () => {});
  When('claimTicket runs for agent "agent-1"', () => {
    res = claimTicket(
      { id: 'TASK-1', status: 'in-progress', agent: 'agent-1', created: 'C0', updated: 'U0' },
      'agent-1',
      { at },
    );
  });
  Then('the result is ok:true', () => {
    assert.equal(res.ok, true);
  });
  And('the frontmatter keeps agent "agent-1" and status "in-progress"', () => {
    assert.equal(res.fm.agent, 'agent-1');
    assert.equal(res.fm.status, 'in-progress');
  });
  And('"updated" is bumped and "created" is preserved', () => {
    assert.equal(res.fm.updated, at);
    assert.equal(res.fm.created, 'C0');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario Outline: fresh claimable tickets still grant (unchanged)
for (const status of ['todo', 'failed-testing']) {
  scenario(`fresh claimable ticket with status "${status}" still grants (unchanged)`, () => {
    let res;
    Given(`an unclaimed ticket with status "${status}"`, () => {});
    When('claimTicket runs for agent "agent-1"', () => {
      res = claimTicket({ id: 'TASK-1', status }, 'agent-1');
    });
    Then('the result is ok:true with status "in-progress" and agent "agent-1"', () => {
      assert.equal(res.ok, true);
      assert.equal(res.fm.status, 'in-progress');
      assert.equal(res.fm.agent, 'agent-1');
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
scenario('a leftover kind:post-processing key does not change the user-status guard verdict (TASK-206)', () => {
  let res;
  Given('a ticket with a leftover kind "post-processing", status "ux-review", and agent "agent-1"', () => {});
  When('claimTicket runs for agent "agent-1"', () => {
    res = claimTicket(
      { id: 'TASK-1', status: 'ux-review', agent: 'agent-1', kind: LEGACY_POST_PROCESSING_KIND },
      'agent-1',
    );
  });
  Then('the result is ok:false with reason "not-claimable", never "post-processing"', () => {
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'not-claimable');
    assert.notEqual(res.reason, 'post-processing');
  });
});
