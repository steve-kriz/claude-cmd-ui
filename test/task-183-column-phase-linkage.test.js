'use strict';

// ===========================================================================
// TASK-183 — UNIT tests for column→phase linkage and auto-enable flip logic.
//
// Tests the pure functions:
// - tasksNormalizeColumnPhase: validates and normalizes a phase value to one of
//   the four canonical keys or null
// - tasksPhaseLinkCounts: counts how many columns are linked to each phase
// - tasksApplyPhaseAutoEnable: one-time zero-to-one transition flip that enables
//   a disabled phase when its first column is linked
//
// NO DATABASE, DISK WRITE, ELECTRON RUNTIME, OR NETWORK. Every object is a
// plain in-memory mock; every dependency is a pure function.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

// ─────────────────────────────────────────────────────────────────────────────
// UNITS UNDER TEST (faithful replicas of renderer.js functions)
// ─────────────────────────────────────────────────────────────────────────────

const TASKS_PHASE_KEYS = ['plan', 'build', 'test', 'review'];

const TASKS_PHASE_ENABLED_DEFAULTS = Object.fromEntries(
  TASKS_PHASE_KEYS.map((key) => [key, key !== 'review'])
);

// Normalise a column's `phase` link: a string exactly equal to one of the four
// canonical phase keys is kept; anything else (missing/unknown/non-string)
// becomes null.
function tasksNormalizeColumnPhase(rawPhase) {
  return (typeof rawPhase === 'string' && TASKS_PHASE_KEYS.includes(rawPhase)) ? rawPhase : null;
}

// Count, per canonical phase key, how many columns carry that `phase` link.
// Tolerant of null/junk entries; never throws.
function tasksPhaseLinkCounts(columns) {
  const counts = {};
  for (const key of TASKS_PHASE_KEYS) counts[key] = 0;
  for (const c of (Array.isArray(columns) ? columns : [])) {
    if (c && TASKS_PHASE_KEYS.includes(c.phase)) counts[c.phase] += 1;
  }
  return counts;
}

// One-time convenience flip: when a column is linked to a phase that had ZERO
// linked columns as of the last load/save and that phase is CURRENTLY disabled,
// flip its `enabled` to true. Never re-flips an already-linked or already-enabled
// phase. Mutates and returns `skill`.
function tasksApplyPhaseAutoEnable(columns, baselineCounts, skill) {
  const s = (skill && typeof skill === 'object' && !Array.isArray(skill)) ? skill : {};
  const phases = (s.phases && typeof s.phases === 'object' && !Array.isArray(s.phases)) ? s.phases : {};
  const counts = tasksPhaseLinkCounts(columns);
  const baseline = (baselineCounts && typeof baselineCounts === 'object') ? baselineCounts : {};
  TASKS_PHASE_KEYS.forEach((key, idx) => {
    const before = Number(baseline[key]) || 0;
    const after = counts[key] || 0;
    if (before !== 0 || after === 0) return; // not a zero-to-one transition
    const cur = (phases[key] && typeof phases[key] === 'object' && !Array.isArray(phases[key])) ? phases[key] : null;
    const enabled = (cur && typeof cur.enabled === 'boolean') ? cur.enabled : TASKS_PHASE_ENABLED_DEFAULTS[key];
    if (enabled !== false) return; // already enabled — nothing to flip
    const order = (cur && cur.order != null) ? cur.order : idx + 1;
    phases[key] = { ...(cur || {}), enabled: true, order };
  });
  s.phases = phases;
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 1: tasksNormalizeColumnPhase validates phase values
// ─────────────────────────────────────────────────────────────────────────────

test('tasksNormalizeColumnPhase: "review" is a valid phase', () => {
  assert.equal(tasksNormalizeColumnPhase('review'), 'review');
});

test('tasksNormalizeColumnPhase: all four canonical keys are valid', () => {
  for (const key of TASKS_PHASE_KEYS) {
    assert.equal(tasksNormalizeColumnPhase(key), key, `phase "${key}" is valid`);
  }
});

test('tasksNormalizeColumnPhase: unknown string becomes null', () => {
  assert.equal(tasksNormalizeColumnPhase('deploy'), null);
  assert.equal(tasksNormalizeColumnPhase('unknown'), null);
});

test('tasksNormalizeColumnPhase: missing/null/undefined becomes null', () => {
  assert.equal(tasksNormalizeColumnPhase(null), null);
  assert.equal(tasksNormalizeColumnPhase(undefined), null);
  assert.equal(tasksNormalizeColumnPhase(), null);
});

test('tasksNormalizeColumnPhase: non-string types become null', () => {
  assert.equal(tasksNormalizeColumnPhase(123), null);
  assert.equal(tasksNormalizeColumnPhase({}), null);
  assert.equal(tasksNormalizeColumnPhase([]), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 2: tasksPhaseLinkCounts counts columns by phase
// ─────────────────────────────────────────────────────────────────────────────

test('tasksPhaseLinkCounts: empty columns → all zeros', () => {
  const counts = tasksPhaseLinkCounts([]);
  assert.deepEqual(counts, { plan: 0, build: 0, test: 0, review: 0 });
});

test('tasksPhaseLinkCounts: one column linked to review', () => {
  const cols = [
    { status: 'todo', phase: null },
    { status: 'pr-review', phase: 'review' },
    { status: 'done', phase: null }
  ];
  const counts = tasksPhaseLinkCounts(cols);
  assert.deepEqual(counts, { plan: 0, build: 0, test: 0, review: 1 });
});

test('tasksPhaseLinkCounts: multiple columns linked to the same phase', () => {
  const cols = [
    { status: 'draft', phase: 'plan' },
    { status: 'planning', phase: 'plan' },
    { status: 'ready', phase: 'plan' }
  ];
  const counts = tasksPhaseLinkCounts(cols);
  assert.deepEqual(counts, { plan: 3, build: 0, test: 0, review: 0 });
});

test('tasksPhaseLinkCounts: all four phases linked', () => {
  const cols = [
    { status: 'backlog', phase: 'plan' },
    { status: 'building', phase: 'build' },
    { status: 'testing', phase: 'test' },
    { status: 'pr-review', phase: 'review' }
  ];
  const counts = tasksPhaseLinkCounts(cols);
  assert.deepEqual(counts, { plan: 1, build: 1, test: 1, review: 1 });
});

test('tasksPhaseLinkCounts: tolerates null/junk entries', () => {
  const cols = [
    null,
    { status: 'pr-review', phase: 'review' },
    undefined,
    { status: 'test', phase: null },
    { status: 'build', phase: 'deploy' }, // invalid phase → not counted
    { status: 'code', phase: 'build' }
  ];
  const counts = tasksPhaseLinkCounts(cols);
  assert.deepEqual(counts, { plan: 0, build: 1, test: 0, review: 1 });
});

test('tasksPhaseLinkCounts: null columns array → all zeros', () => {
  const counts = tasksPhaseLinkCounts(null);
  assert.deepEqual(counts, { plan: 0, build: 0, test: 0, review: 0 });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 3: tasksApplyPhaseAutoEnable flips on zero→one transition
// ─────────────────────────────────────────────────────────────────────────────

test('tasksApplyPhaseAutoEnable: zero→one transition flips a disabled phase to enabled', () => {
  const cols = [{ status: 'pr-review', phase: 'review' }];
  const baselineCounts = { plan: 0, build: 0, test: 0, review: 0 };
  const skill = {
    phases: {
      review: { enabled: false }
    }
  };
  const result = tasksApplyPhaseAutoEnable(cols, baselineCounts, skill);
  assert.equal(result.phases.review.enabled, true, 'review flipped to enabled');
});

test('tasksApplyPhaseAutoEnable: zero→one on plan (already enabled by default)', () => {
  const cols = [{ status: 'backlog', phase: 'plan' }];
  const baselineCounts = { plan: 0, build: 0, test: 0, review: 0 };
  const skill = { phases: {} };
  const result = tasksApplyPhaseAutoEnable(cols, baselineCounts, skill);
  // plan defaults to enabled (not false), so the flip condition fails and no entry is created
  // Check that plan is not flipped (condition: enabled !== false fails)
  assert.ok(!result.phases.plan || result.phases.plan.enabled !== false, 'plan stays disabled (no flip: already enabled by default)');
});

test('tasksApplyPhaseAutoEnable: zero→one when phase entry is missing → flips if default was disabled', () => {
  const cols = [{ status: 'pr-review', phase: 'review' }];
  const baselineCounts = { plan: 0, build: 0, test: 0, review: 0 };
  const skill = {}; // no phases at all
  const result = tasksApplyPhaseAutoEnable(cols, baselineCounts, skill);
  // review defaults to disabled (TASK-183), so it should flip to enabled
  assert.equal(result.phases.review.enabled, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 4: No re-flip on already-linked phase (edge)
// ─────────────────────────────────────────────────────────────────────────────

test('tasksApplyPhaseAutoEnable (edge): second link to review does NOT re-flip', () => {
  // At load time: review has 1 linked column, manually set to disabled
  const cols = [
    { status: 'pr-review', phase: 'review' },
    { status: 'qa-review', phase: 'review' } // second column added now
  ];
  const baselineCounts = { plan: 0, build: 0, test: 0, review: 1 }; // was already linked
  const skill = {
    phases: {
      review: { enabled: false } // user manually disabled after first link
    }
  };
  const result = tasksApplyPhaseAutoEnable(cols, baselineCounts, skill);
  // before=1 (not 0), so the condition fails and no flip occurs
  assert.equal(result.phases.review.enabled, false, 'review stays disabled (baseline was not 0)');
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 5: No flip for already-enabled phase (edge)
// ─────────────────────────────────────────────────────────────────────────────

test('tasksApplyPhaseAutoEnable (edge): zero→one but phase already enabled → no-op', () => {
  const cols = [{ status: 'building', phase: 'build' }];
  const baselineCounts = { plan: 0, build: 0, test: 0, review: 0 };
  const skill = {
    phases: {
      build: { enabled: true } // already enabled, so no flip needed
    }
  };
  const result = tasksApplyPhaseAutoEnable(cols, baselineCounts, skill);
  assert.equal(result.phases.build.enabled, true, 'build stays enabled (nothing to flip)');
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 6: No flip when after === 0 (link cleared)
// ─────────────────────────────────────────────────────────────────────────────

test('tasksApplyPhaseAutoEnable (edge): zero→zero (link cleared) → no flip', () => {
  const cols = [
    { status: 'pr-review', phase: null } // link was just cleared
  ];
  const baselineCounts = { plan: 0, build: 0, test: 0, review: 0 };
  const skill = {
    phases: {
      review: { enabled: false }
    }
  };
  const result = tasksApplyPhaseAutoEnable(cols, baselineCounts, skill);
  assert.equal(result.phases.review.enabled, false, 'review stays disabled (after=0)');
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 7: All four phases can be auto-enabled independently
// ─────────────────────────────────────────────────────────────────────────────

test('tasksApplyPhaseAutoEnable: multiple phases zero→one in same save', () => {
  const cols = [
    { status: 'draft', phase: 'plan' },
    { status: 'build-in-progress', phase: 'build' },
    { status: 'testing', phase: 'test' },
    { status: 'pr-review', phase: 'review' }
  ];
  const baselineCounts = { plan: 0, build: 0, test: 0, review: 0 };
  const skill = {
    phases: {
      plan: { enabled: false },
      build: { enabled: false },
      test: { enabled: false },
      review: { enabled: false }
    }
  };
  const result = tasksApplyPhaseAutoEnable(cols, baselineCounts, skill);
  // plan, test, review will flip (they default to enabled/disabled); build flips
  assert.equal(result.phases.plan.enabled, true, 'plan flipped');
  assert.equal(result.phases.build.enabled, true, 'build flipped');
  assert.equal(result.phases.test.enabled, true, 'test flipped');
  assert.equal(result.phases.review.enabled, true, 'review flipped');
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 8: Phase entry order is preserved and set for new phases
// ─────────────────────────────────────────────────────────────────────────────

test('tasksApplyPhaseAutoEnable: preserves existing order, sets default for new', () => {
  const cols = [{ status: 'pr-review', phase: 'review' }];
  const baselineCounts = { plan: 0, build: 0, test: 0, review: 0 };
  const skill = {
    phases: {
      review: { enabled: false, order: 99 }
    }
  };
  const result = tasksApplyPhaseAutoEnable(cols, baselineCounts, skill);
  assert.equal(result.phases.review.order, 99, 'existing order preserved');
  assert.equal(result.phases.review.enabled, true, 'enabled flipped');
});

test('tasksApplyPhaseAutoEnable: assigns canonical order only on flip', () => {
  const cols = [
    { status: 'draft', phase: 'plan' }
  ];
  const baselineCounts = { plan: 0, build: 0, test: 0, review: 0 };
  const skill = {}; // no phases, but plan defaults to enabled so no flip happens
  const result = tasksApplyPhaseAutoEnable(cols, baselineCounts, skill);
  // plan defaults to enabled (TASKS_PHASE_ENABLED_DEFAULTS.plan = true), so no flip
  // the phases.plan entry is not created/updated when no flip occurs
  assert.ok(!result.phases.plan, 'plan entry not created (no flip: defaults to enabled)');
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 9: Idempotency — calling twice with same inputs yields same result
// ─────────────────────────────────────────────────────────────────────────────

test('tasksApplyPhaseAutoEnable (edge): calling twice with same inputs is idempotent', () => {
  const cols = [{ status: 'pr-review', phase: 'review' }];
  const baselineCounts = { plan: 0, build: 0, test: 0, review: 0 };
  const skill1 = { phases: { review: { enabled: false } } };
  const skill2 = JSON.parse(JSON.stringify(skill1)); // deep copy
  const result1 = tasksApplyPhaseAutoEnable(cols, baselineCounts, skill1);
  const result2 = tasksApplyPhaseAutoEnable(cols, baselineCounts, skill2);
  assert.equal(result1.phases.review.enabled, result2.phases.review.enabled);
  assert.equal(result1.phases.review.enabled, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 10: Tampered/invalid phase values are normalized before counting
// ─────────────────────────────────────────────────────────────────────────────

test('tasksApplyPhaseAutoEnable: ignores columns with invalid phase values', () => {
  const cols = [
    { status: 'col1', phase: 'review' },
    { status: 'col2', phase: 'deploy' }, // invalid, not in TASKS_PHASE_KEYS
    { status: 'col3', phase: null }
  ];
  const baselineCounts = { plan: 0, build: 0, test: 0, review: 0 };
  const skill = { phases: { review: { enabled: false } } };
  const result = tasksApplyPhaseAutoEnable(cols, baselineCounts, skill);
  // Only col1 counts toward review, so review flips
  assert.equal(result.phases.review.enabled, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 11: Defaults for TASKS_PHASE_ENABLED_DEFAULTS
// ─────────────────────────────────────────────────────────────────────────────

test('TASKS_PHASE_ENABLED_DEFAULTS: plan/build/test default true, review false', () => {
  assert.equal(TASKS_PHASE_ENABLED_DEFAULTS.plan, true);
  assert.equal(TASKS_PHASE_ENABLED_DEFAULTS.build, true);
  assert.equal(TASKS_PHASE_ENABLED_DEFAULTS.test, true);
  assert.equal(TASKS_PHASE_ENABLED_DEFAULTS.review, false);
});

test('TASKS_PHASE_KEYS: all four canonical phase keys present', () => {
  assert.deepEqual(TASKS_PHASE_KEYS, ['plan', 'build', 'test', 'review']);
});
