'use strict';

// E2e cucumber-style scenarios for TASK-098: config-aware lane resolution.
//
// These implement EVERY Gherkin scenario from the ticket in Given/When/Then
// form under plain `node --test` (no `cucumber` package is installed or added):
//   Scenario: Default config equals the fixed board
//   Scenario: User column gets its own lane
//   Scenario: failed-testing still folds into testing (edge)
//   Scenario: Removed-column status routes to unknown (failure)
//
// The default-config assertions use lib/team-config.js's pure defaultConfig();
// user-column cases use hand-built column arrays. Everything under test is pure
// and Electron-free — NO database, filesystem, or network is touched, so all DB
// access is mocked away by construction (there is none to make).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  LANE_STATUSES,
  UNKNOWN_STATUS,
  laneStatusesFor,
  isKnownStatusFor,
  laneForStatusFor,
  isUserStatus,
  isActiveStatus,
} = require('../lib/ticket-lanes');

const { defaultConfig } = require('../lib/team-config.js');

// A column of the shape lib/team-config.js normalises to.
function col(status, system) {
  return { status, label: status, description: '', agent: null, system };
}

// A board config that adds a user column `ux-review` anchored after `testing`.
function columnsWithUxReview() {
  return [
    col('todo', true),
    col('defining', true),
    col('in-progress', true),
    col('testing', true),
    col('ux-review', false),
    col('post-processing', true),
    col('done', true),
  ];
}

test('Scenario: Default config equals the fixed board', () => {
  // Given the default team config (only the six system columns)
  const columns = defaultConfig().columns;
  // When we resolve the ordered lane statuses
  const resolved = laneStatusesFor(columns);
  // Then laneStatusesFor(defaults) equals LANE_STATUSES
  assert.deepEqual(resolved, LANE_STATUSES);
});

test('Scenario: User column gets its own lane', () => {
  // Given columns including ux-review (anchored after testing)
  const columns = columnsWithUxReview();
  // When a ticket carries status "ux-review"
  const status = 'ux-review';
  // Then it is a known, user-defined status
  assert.equal(isKnownStatusFor(status, columns), true);
  assert.equal(isUserStatus(status, columns), true);
  // And laneForStatusFor("ux-review") is "ux-review" (its own lane)
  assert.equal(laneForStatusFor(status, columns), 'ux-review');
  // And that lane appears in the ordered board between testing and post-processing
  assert.deepEqual(laneStatusesFor(columns), [
    'todo', 'defining', 'in-progress', 'testing', 'ux-review', 'post-processing', 'done',
  ]);
  // And a user status is never "active" (slot math untouched)
  assert.equal(isActiveStatus('ux-review'), false);
});

test('Scenario: failed-testing still folds into testing (edge)', () => {
  // Then laneForStatusFor("failed-testing", columns) is "testing" for ANY columns,
  // including the default config, a config with a user column, and null/junk.
  const cases = [
    defaultConfig().columns,
    columnsWithUxReview(),
    null,
    undefined,
    [],
    'not-an-array',
    [null, 'junk', 7],
  ];
  for (const columns of cases) {
    assert.equal(laneForStatusFor('failed-testing', columns), 'testing',
      `failed-testing folds into testing for columns=${JSON.stringify(columns)}`);
  }
});

test('Scenario: Removed-column status routes to unknown (failure)', () => {
  // Given columns no longer containing "ux-review" (back to the default board)
  const columns = defaultConfig().columns;
  // When a ticket still carries status "ux-review"
  const orphan = 'ux-review';
  // Then laneForStatusFor returns the unknown lane, never todo
  assert.equal(laneForStatusFor(orphan, columns), UNKNOWN_STATUS);
  assert.notEqual(laneForStatusFor(orphan, columns), 'todo');
  // And it is no longer a known status for this config
  assert.equal(isKnownStatusFor(orphan, columns), false);
  assert.equal(isUserStatus(orphan, columns), false);
});

test('Scenario (edge): a slug colliding with a system status resolves as the system meaning', () => {
  // Given a (malformed) config where a user column reuses a reserved slug
  const columns = [col('todo', false), col('failed-testing', false)];
  // When we resolve those statuses
  // Then the system meaning always wins — they are never user statuses
  assert.equal(isUserStatus('todo', columns), false);
  assert.equal(isUserStatus('failed-testing', columns), false);
  assert.equal(laneForStatusFor('todo', columns), 'todo');
  assert.equal(laneForStatusFor('failed-testing', columns), 'testing');
});
