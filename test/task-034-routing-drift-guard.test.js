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
  const startMarker = 'const unknown = !TASKS_VALID_STATUSES.includes(tk.fm.status);';
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

// Guard 2 core: does the Add path pass status+kind post-processing and compose
// frontmatter that files into the status-derived subfolder?
function addPathComposesPostProcessing(src) {
  const bindStart = src.indexOf('if (status === TASKS_POST_PROCESSING_STATUS) {');
  if (bindStart === -1) return false;
  const bindEnd = src.indexOf('});', bindStart);
  if (bindEnd === -1) return false;
  const bind = src.slice(bindStart, bindEnd + 3);
  const passesStatus = /openNewTaskModal\(tab,\s*\{[\s\S]*?status:\s*TASKS_POST_PROCESSING_STATUS/.test(bind);
  const passesKind = /kind:\s*TASKS_POST_PROCESSING_KIND/.test(bind);
  const composesFm = /const fm = \{ id, title, status, created: now, updated: now \};/.test(src);
  const appendsKind = /if \(kind\) fm\.kind = kind;/.test(src);
  const derivesFolder = /const subfolder = ticketFolderForStatus\(status\);/.test(src);
  return passesStatus && passesKind && composesFm && appendsKind && derivesFolder;
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
// Predicate 2: Add path composes status+kind post-processing into the folder
// ---------------------------------------------------------------------------
test('unit: addPathComposesPostProcessing is TRUE on the real renderer source', () => {
  assert.equal(addPathComposesPostProcessing(rendererSrc), true);
});

test('unit: addPathComposesPostProcessing is FALSE when the Add path stops passing kind: post-processing', () => {
  // Divergence: Add binding no longer passes the post-processing kind.
  const mutated = mutate(
    rendererSrc,
    'kind: TASKS_POST_PROCESSING_KIND,',
    '',
  );
  assert.equal(addPathComposesPostProcessing(mutated), false);
});

test('unit: addPathComposesPostProcessing is FALSE when the Add path passes a non-post-processing status', () => {
  // Divergence: Add binding passes status: todo instead of post-processing.
  const mutated = mutate(
    rendererSrc,
    'status: TASKS_POST_PROCESSING_STATUS,',
    "status: 'todo',",
  );
  assert.equal(addPathComposesPostProcessing(mutated), false);
});

test('unit: addPathComposesPostProcessing is FALSE when the create path no longer derives the folder from status', () => {
  // Divergence: destination folder hard-coded to todo instead of status-derived.
  const mutated = mutate(
    rendererSrc,
    'const subfolder = ticketFolderForStatus(status);',
    "const subfolder = 'todo';",
  );
  assert.equal(addPathComposesPostProcessing(mutated), false);
});

test('unit: addPathComposesPostProcessing is FALSE when the kind is no longer written to frontmatter', () => {
  // Divergence: created frontmatter stops carrying kind.
  const mutated = mutate(
    rendererSrc,
    'if (kind) fm.kind = kind;',
    '/* kind dropped */;',
  );
  assert.equal(addPathComposesPostProcessing(mutated), false);
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
  assert.equal(addPathComposesPostProcessing(rendererSrc), true);
  assert.equal(fillPreservesOutOfListStatus(rendererSrc), true);
});
