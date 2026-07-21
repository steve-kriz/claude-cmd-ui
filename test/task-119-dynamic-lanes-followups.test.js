'use strict';

// ===========================================================================
// TASK-119 — UNIT tests for the TASK-101 review follow-ups.
//
// F1  LOCKSTEP CROSS-CHECK: the renderer's normalizeTasksColumns ordering must
//     agree, slug-for-slug, with the lib engine that files tickets into folders
//     (lib/team-config.js normalizeConfig + lib/ticket-lanes.js laneStatusesFor).
//     If these two ever drift, the board could order/route user lanes differently
//     from the engine — this test fails loudly when they do.
//
// F2  BADGE TRI-STATE predicate: buildTasksLaneEl marks a configured agent badge
//     `.missing` ONLY when tab.tasks.agentNames is a CONFIRMED Set that lacks the
//     agent (empty Set = confirmed "no agents" → missing). When agentNames is null
//     (dir absent / unreadable / not-yet-loaded) the badge is NEUTRAL — never a
//     spurious warning.
//
// Subjects under test are the REAL renderer/renderer.js functions loaded headless
// via test/helpers/task-101-lane-harness.js (renderer.js is a browser script and
// cannot be require()d; the harness brace-extracts the declarations and evaluates
// them with an injected window/document). PURE / DOM-only: no fs, no Electron, NO
// DB / network — every collaborator is a call-recording stub.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers/task-101-lane-harness');

const { normalizeConfig } = require('../lib/team-config.js');
const { laneStatusesFor } = require('../lib/ticket-lanes.js');

// One shared module instance: normalizeTasksColumns is pure; buildTasksLaneEl is
// driven with a fresh tab per assertion so agentNames never leaks between cases.
const mod = H.loadLaneModule(H.makeWindow().window, H.makeDocument(), console);
const { normalizeTasksColumns, buildTasksLaneEl } = mod;

const SYSTEM_ORDER = ['todo', 'defining', 'in-progress', 'testing', 'post-processing', 'done'];

// ---------------------------------------------------------------------------
// F1 — lockstep cross-check: renderer ordering === lib engine ordering.
//
// The renderer's normalizeTasksColumns(rawConfig).map(c => c.status) must equal
// the lib engine's laneStatusesFor(normalizeConfig(rawConfig).columns) for every
// representative config. Two independent code paths (the browser board and the
// Node folder-filing engine) computing the SAME ordered slug sequence is the whole
// point — this asserts they cannot drift.
// ---------------------------------------------------------------------------
function rendererOrder(rawConfig) {
  return normalizeTasksColumns(rawConfig).map((c) => c.status);
}
function libOrder(rawConfig) {
  return laneStatusesFor(normalizeConfig(rawConfig).columns);
}
function assertLockstep(rawConfig, label, expected) {
  const rend = rendererOrder(rawConfig);
  const lib = libOrder(rawConfig);
  assert.deepEqual(rend, lib,
    `${label}: renderer ordering must equal lib engine ordering\n  renderer=${JSON.stringify(rend)}\n  lib     =${JSON.stringify(lib)}`);
  if (expected) assert.deepEqual(rend, expected, `${label}: expected ordered slugs`);
}

test('F1 unit: default (null) config — renderer normalizeTasksColumns agrees with lib normalizeConfig+laneStatusesFor', () => {
  assertLockstep(null, 'default/null config', SYSTEM_ORDER);
});

test('F1 unit: a user column (ux-review after testing) orders identically in renderer and lib', () => {
  const cfg = {
    columns: [
      { status: 'todo' }, { status: 'defining' }, { status: 'in-progress' },
      { status: 'testing' }, { status: 'ux-review', label: 'UX Review' },
      { status: 'post-processing' }, { status: 'done' },
    ],
  };
  assertLockstep(cfg, 'user column after testing',
    ['todo', 'defining', 'in-progress', 'testing', 'ux-review', 'post-processing', 'done']);
});

test('F1 unit: a user column before any system column anchors to the front in BOTH', () => {
  assertLockstep({ columns: [{ status: 'triage' }, { status: 'todo' }] },
    'user column before todo',
    ['triage', 'todo', 'defining', 'in-progress', 'testing', 'post-processing', 'done']);
});

test('F1 unit: reserved + invalid slugs are dropped identically (only a valid user slug survives)', () => {
  // failed-testing / unknown / __wont-do__ are reserved; "UX Review" is invalid
  // (space + uppercase). Both the renderer and lib must drop all four and keep only
  // ux-review (anchored to the front, since no system column precedes it).
  const cfg = {
    columns: [
      { status: 'failed-testing' }, { status: 'unknown' }, { status: '__wont-do__' },
      { status: 'UX Review' }, { status: 'ux-review' },
    ],
  };
  assertLockstep(cfg, 'reserved/invalid dropped',
    ['ux-review', 'todo', 'defining', 'in-progress', 'testing', 'post-processing', 'done']);
});

test('F1 unit: shuffled system columns re-impose canonical order in BOTH', () => {
  assertLockstep({ columns: [{ status: 'done' }, { status: 'todo' }, { status: 'testing' }] },
    'shuffled system columns', SYSTEM_ORDER);
});

test('F1 unit: a duplicate user slug de-dupes to one lane in BOTH (first wins)', () => {
  assertLockstep({ columns: [{ status: 'ux-review' }, { status: 'ux-review' }] },
    'duplicate user slug',
    ['ux-review', 'todo', 'defining', 'in-progress', 'testing', 'post-processing', 'done']);
});

// ---------------------------------------------------------------------------
// F2 — badge tri-state predicate, driven through the REAL buildTasksLaneEl.
//
// Build one user lane naming an agent, vary tab.tasks.agentNames across the three
// states, and read whether the rendered `.tasks-lane-agent` badge carries the
// `.missing` warning class:
//   - null (unknown: dir absent / unreadable / not-yet-loaded)  → NEUTRAL
//   - Set() (confirmed: dir enumerated, no agents at all)        → MISSING
//   - Set(['x']) not containing the agent (confirmed absent)     → MISSING
//   - Set(['agent']) containing the agent (confirmed present)    → NEUTRAL
// ---------------------------------------------------------------------------
function badgeMissingFor(agentNames, agent) {
  const tab = H.makeTab({ agentNames });
  const laneEl = buildTasksLaneEl(tab, {
    status: 'ux-review', label: 'UX', description: '', agent, system: false,
  });
  const badge = H.findByClass(laneEl, 'tasks-lane-agent');
  assert.ok(badge, 'a configured agent always renders a badge');
  assert.equal(badge.textContent, agent, 'the badge shows the configured agent name');
  return badge.classList.contains('missing');
}

test('F2 unit: agentNames null (unknown) → configured badge is NEUTRAL (no spurious .missing)', () => {
  assert.equal(badgeMissingFor(null, 'reviewer'), false,
    'null agent set is UNKNOWN, not confirmed-absent — badge must not warn');
});

test('F2 unit: agentNames = empty Set (confirmed no agents) → configured badge is .missing', () => {
  assert.equal(badgeMissingFor(new Set(), 'reviewer'), true,
    'an empty Set is a CONFIRMED enumeration with zero agents → the agent is genuinely missing');
});

test('F2 unit: agentNames = confirmed Set lacking the agent → .missing', () => {
  assert.equal(badgeMissingFor(new Set(['ba', 'coder']), 'ghost'), true,
    'a confirmed Set that lacks the agent → missing');
});

test('F2 unit: agentNames = confirmed Set containing the agent → NEUTRAL', () => {
  assert.equal(badgeMissingFor(new Set(['ba', 'coder']), 'ba'), false,
    'a confirmed Set that contains the agent → not missing');
});

test('F2 unit: only a genuine Set is treated as confirmed (a plain array is UNKNOWN → neutral)', () => {
  // Defensive: the predicate is `agentNames instanceof Set`. A stray non-Set value
  // (e.g. a bare array from some future refactor) must be treated as UNKNOWN, never
  // as a confirmed enumeration — so it must render neutral, not falsely missing.
  assert.equal(badgeMissingFor(['ba'], 'ghost'), false,
    'a non-Set agentNames is not a confirmed enumeration → neutral');
});
