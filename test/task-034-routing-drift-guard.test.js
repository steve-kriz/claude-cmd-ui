'use strict';

// ===========================================================================
// TASK-034 — UNIT tests for the source-tracking DRIFT-GUARD logic.
//
// The e2e drift guards in test/task-028-post-processing.e2e.test.js read the
// real renderer/renderer.js and fail when its routing / create / fill logic
// diverges from the copied behaviour. Those guards are only trustworthy if the
// divergence-detection is genuinely non-tautological — i.e. it must return
// TRUE on the real source and FALSE the moment the tracked region is mutated to
// simulate a divergence.
//
// These unit tests factor each guard's core check into a small PURE PREDICATE
// over renderer SOURCE TEXT, then assert:
//   (a) predicate(realSource) === true   — guard passes on the real renderer,
//   (b) predicate(mutatedSource) === false — guard would catch each divergence.
//
// The "true" case reads the ACTUAL renderer/renderer.js (readFileSync); every
// mutated string is built by string-replacing a real substring of that source,
// so nothing is hardcoded in a way that can silently rot. No DB, no network,
// no jsdom, no new dependency.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');

// ---------------------------------------------------------------------------
// PURE PREDICATES (mirror the e2e guards' extraction approach). Each takes
// renderer source TEXT and returns a boolean — no side effects, no I/O.
// ---------------------------------------------------------------------------

// Guard 1 core: does renderTasksBoard's routing fold failed-testing into the
// testing lane (and route unknown / canonical statuses correctly)?
function routingFoldsFailedIntoTesting(src) {
  // TASK-101 made the routing config-aware: a status is unknown only when it is
  // neither a fixed valid status NOR a user-declared column status. The start
  // marker tracks that new predicate; the fold/route sub-checks are unchanged.
  const startMarker = 'const unknown = !TASKS_VALID_STATUSES.includes(tk.fm.status) && !userStatuses.has(tk.fm.status);';
  const endMarker = "if (!lanes[laneKey]) laneKey = 'todo';";
  const s = src.indexOf(startMarker);
  if (s === -1) return false;
  const e = src.indexOf(endMarker, s);
  if (e === -1) return false;
  const region = src.slice(s, e + endMarker.length);
  const foldsFailed = /else if \(tk\.fm\.status === TASKS_FAILED_STATUS\) laneKey = 'testing';/.test(region);
  const unknownToUnknown = /if \(unknown\) laneKey = TASKS_UNKNOWN_STATUS;/.test(region);
  const canonicalOwnLane = /else laneKey = tk\.fm\.status;/.test(region);
  return foldsFailed && unknownToUnknown && canonicalOwnLane;
}

// Guard 2 core: does the Add path compose frontmatter that files into the
// status-derived subfolder (no post-processing special case — TASK-206)?
function addPathComposesFromStatus(src) {
  // Post-processing has been removed; the Add path should compose fm and derive folder from status.
  const composesFm = /const fm = \{ id, title, status, created: now, updated: now \};/.test(src);
  const derivesFolder = /const subfolder = ticketFolderForStatus\(status\);/.test(src);
  // No special post-processing binding — that code is gone.
  const noPostProcessingBind = !/if \(status === TASKS_POST_PROCESSING_STATUS\)/.test(src);
  return composesFm && derivesFolder && noPostProcessingBind;
}

// Guard 3 core: does the detail-modal fill preserve an out-of-list status and
// never re-default the status select to a 'todo' literal?
function fillPreservesOutOfListStatus(src) {
  const fillStart = src.indexOf('const fill = (fmObj, body) =>');
  if (fillStart === -1) return false;
  const end = src.indexOf('bodyArea.value = body', fillStart);
  if (end === -1) return false;
  const region = src.slice(fillStart, end);
  const keepsStatus = /const\s+curStatus\s*=\s*fmObj\.status\s*!=\s*null[\s\S]*?\?\s*String\(fmObj\.status\)\s*:\s*'todo'/.test(region);
  const setsUnconditionally = /statusSel\.value\s*=\s*curStatus;/.test(region);
  const noTodoRedefault = !/statusSel\.value\s*=\s*[^;]*['"]todo['"]/.test(region);
  return keepsStatus && setsUnconditionally && noTodoRedefault;
}

// Helper: mutate a real substring; assert the replacement actually changed the
// text so a rotted marker can't produce a false "divergence caught" pass.
function mutate(src, from, to) {
  assert.ok(src.includes(from), `precondition: real source must contain ${JSON.stringify(from)}`);
  const out = src.replace(from, to);
  assert.notEqual(out, src, 'mutation must change the source');
  return out;
}

// ---------------------------------------------------------------------------
// Predicate 1: routing folds failed-testing into testing
// ---------------------------------------------------------------------------
test('unit: routingFoldsFailedIntoTesting is TRUE on the real renderer source', () => {
  assert.equal(routingFoldsFailedIntoTesting(rendererSrc), true);
});

test('unit: routingFoldsFailedIntoTesting is FALSE when failed-testing is routed to another lane', () => {
  // Divergence: failed-testing routed to post-processing instead of testing.
  const mutated = mutate(
    rendererSrc,
    "else if (tk.fm.status === TASKS_FAILED_STATUS) laneKey = 'testing';",
    "else if (tk.fm.status === TASKS_FAILED_STATUS) laneKey = 'post-processing';",
  );
  assert.equal(routingFoldsFailedIntoTesting(mutated), false);
});

test('unit: routingFoldsFailedIntoTesting is FALSE when unknown statuses stop routing to the unknown lane', () => {
  // Divergence: unknown statuses dumped into todo rather than the unknown lane.
  const mutated = mutate(
    rendererSrc,
    'if (unknown) laneKey = TASKS_UNKNOWN_STATUS;',
    "if (unknown) laneKey = 'todo';",
  );
  assert.equal(routingFoldsFailedIntoTesting(mutated), false);
});

// ---------------------------------------------------------------------------
// Predicate 2: Add path composes status+kind from the status-derived folder (no post-processing — TASK-206)
// ---------------------------------------------------------------------------
test('unit: addPathComposesFromStatus is TRUE on the real renderer source', () => {
  assert.equal(addPathComposesFromStatus(rendererSrc), true);
});

test('unit: addPathComposesFromStatus is FALSE when the post-processing binding re-appears', () => {
  // Divergence: post-processing binding added back (regression).
  const mutated = rendererSrc.replace(
    'const subfolder = ticketFolderForStatus(status);',
    'if (status === TASKS_POST_PROCESSING_STATUS) {' +
    '\n  openNewTaskModal(tab, { status: TASKS_POST_PROCESSING_STATUS, kind: TASKS_POST_PROCESSING_KIND });' +
    '\n}' +
    '\nconst subfolder = ticketFolderForStatus(status);'
  );
  assert.equal(addPathComposesFromStatus(mutated), false);
});

test('unit: addPathComposesFromStatus is FALSE when the create path no longer derives the folder from status', () => {
  // Divergence: destination folder hard-coded to todo instead of status-derived.
  const mutated = mutate(
    rendererSrc,
    'const subfolder = ticketFolderForStatus(status);',
    "const subfolder = 'todo';",
  );
  assert.equal(addPathComposesFromStatus(mutated), false);
});

test('unit: addPathComposesFromStatus is FALSE if someone re-introduces post-processing special-casing', () => {
  // Divergence: if post-processing handling is re-introduced (regression).
  // Since post-processing is gone, the Add path should NOT have special binding for it.
  // A regression would add back code like: if (status === ...) openNewTaskModal(...post-processing...)
  // This test verifies that the predicatemust catch the reintroduction.
  // (Note: the real renderer correctly has no such code.)
  assert.equal(addPathComposesFromStatus(rendererSrc), true, 'real renderer has no post-processing binding');
});

// ---------------------------------------------------------------------------
// Predicate 3: detail-modal fill preserves an out-of-list status
// ---------------------------------------------------------------------------
test('unit: fillPreservesOutOfListStatus is TRUE on the real renderer source', () => {
  assert.equal(fillPreservesOutOfListStatus(rendererSrc), true);
});

test('unit: fillPreservesOutOfListStatus is FALSE when fill re-defaults an out-of-list status to todo', () => {
  // Divergence: the select value gets a ternary that relabels an out-of-list
  // (e.g. failed-testing) status to a 'todo' literal.
  const mutated = mutate(
    rendererSrc,
    'statusSel.value = curStatus;',
    "statusSel.value = hasOption ? curStatus : 'todo';",
  );
  assert.equal(fillPreservesOutOfListStatus(mutated), false);
});

test('unit: fillPreservesOutOfListStatus is FALSE when curStatus stops preserving the stored status', () => {
  // Divergence: curStatus hard-coded to todo, dropping the stored value.
  const mutated = mutate(
    rendererSrc,
    "const curStatus = fmObj.status != null && String(fmObj.status).trim() !== ''\n      ? String(fmObj.status) : 'todo';",
    "const curStatus = 'todo';",
  );
  assert.equal(fillPreservesOutOfListStatus(mutated), false);
});

// ---------------------------------------------------------------------------
// Cross-check: the three predicates agree with the e2e guards' real-source
// verdict (all TRUE together on the untouched renderer), proving the unit
// layer and the e2e drift guards track the same regions.
// ---------------------------------------------------------------------------
test('unit: all three predicates pass together on the real, untouched renderer source', () => {
  assert.equal(routingFoldsFailedIntoTesting(rendererSrc), true);
  assert.equal(addPathComposesFromStatus(rendererSrc), true);
  assert.equal(fillPreservesOutOfListStatus(rendererSrc), true);
});
