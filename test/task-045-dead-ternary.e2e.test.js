'use strict';

// ===========================================================================
// TASK-045 — E2E (cucumber-style Given/When/Then) drift guard for the
// dead-ternary cleanup in task-042-bug-multitarget-switch.e2e.test.js (~L127).
//
// Scenario-style `node --test` cases (NO cucumber npm package). Each mirrors a
// Gherkin scenario asserting the intent of the cleanup so it cannot silently
// regress: the identical-branch `x ? originalId : originalId` ternary must be
// gone and the simplified `shouldWarn(originalId, id, bugFoldedTargets)` call
// must remain, still driving the warning behaviour it wraps.
//
// Pure source scan + a behavioural replica of shouldWarn. NO DATABASE.
// NO NETWORK. NO DISK writes (read-only). Deterministic.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TARGET = path.join(__dirname, 'task-042-bug-multitarget-switch.e2e.test.js');
const readTarget = () => fs.readFileSync(TARGET, 'utf8');

const DEAD_TERNARY = /\?\s*originalId\s*:\s*originalId/;

// Replica of the shouldWarn predicate the cleaned call site invokes. A dead
// selector like `size ? originalId : originalId` would pass the SAME originalId
// regardless of branch, so simplifying it must not change behaviour — this
// scenario pins that equivalence.
const foldKey = (origId, bugId) => origId + ' ' + bugId;
function shouldWarn(selectedOriginal, id, committedSet) {
  const currentKey = foldKey(selectedOriginal, id);
  for (const key of committedSet) if (key !== currentKey) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Scenario: the dead identical-branch ternary is gone
// ---------------------------------------------------------------------------
test('E2E Scenario: the identical-branch ternary is absent after cleanup', () => {
  // Given the task-042 e2e test source on disk
  const src = readTarget();
  // When we scan it for a `x ? originalId : originalId` dead ternary
  const hasDeadTernary = DEAD_TERNARY.test(src);
  // Then none is present
  assert.equal(hasDeadTernary, false,
    'the dead `x ? originalId : originalId` ternary must be gone');
});

// ---------------------------------------------------------------------------
// Scenario: the simplified call site is present
//
// The target holds TWO byte-identical simplified calls — the change-listener
// refresh (~L92) and the post-fold refresh (~L127, the cleaned-up line). A
// plain whole-file "present?" scan is under-covered: removing/altering ONLY
// L127 would leave the identical L92 occurrence, keeping the guard green. We
// therefore combine (a) a MINIMUM occurrence COUNT (>= 2) and (b) L127 pinned by
// the stable "refresh switch warning" comment fragment that uniquely precedes
// it. The count is relaxed from `=== 2` to `>= 2` so a legitimate future third
// call site does not false-fail, WITHOUT losing teeth: dropping/changing L127
// leaves only the identical L92 call -> count becomes 1 (< 2) AND the anchored
// match vanishes -> the scenario still FAILS as intended.
// ---------------------------------------------------------------------------
const SIMPLIFIED_CALL = /shouldWarn\(\s*originalId\s*,\s*id\s*,\s*bugFoldedTargets\s*\)/g;

test('E2E Scenario: the simplified shouldWarn call site remains', () => {
  // Given the task-042 e2e test source
  const src = readTarget();
  // When we count the cleaned call form
  const occurrences = (src.match(SIMPLIFIED_CALL) || []).length;
  // Then BOTH simplified call sites (L92 change-listener + L127 post-fold) exist
  // (>= 2; a benign extra call site is tolerated)
  assert.ok(occurrences >= 2,
    'both simplified shouldWarn(originalId, id, bugFoldedTargets) call sites must be present (>= 2)');
  // And the L127 post-fold refresh specifically remains, anchored to the stable,
  // unique "refresh switch warning" comment fragment so the identical L92 call
  // (which has no such comment) cannot mask its removal; `[^\n]*` after the
  // fragment tolerates a harmless reword of the rest of the comment sentence
  assert.match(src,
    /refresh switch warning[^\n]*\r?\n\s*warningVisible = shouldWarn\(\s*originalId\s*,\s*id\s*,\s*bugFoldedTargets\s*\)/,
    'the L127 post-fold shouldWarn refresh (with its "refresh switch warning" comment) must remain');
  // And no bugFoldedTargets.size selector feeds its original argument
  assert.ok(!/shouldWarn\(\s*bugFoldedTargets\.size\s*\?/.test(src),
    'no residual size-based selector may feed the original argument');
});

// ---------------------------------------------------------------------------
// Scenario (mutation / fail-mode proof): removing ONLY the L127 call site must
// break the relaxed guard, even though the byte-identical L92 call survives; AND
// a benign third call site must NOT false-fail it.
//
// This is the teeth AND the tolerance of the guard: we read the REAL source and
// SIMULATE two mutations in-memory (never writing the file):
//   (1) delete only the L127 comment+call region -> guard FAILS (count 1 < 2 AND
//       the anchor vanishes), proving L92 cannot mask an L127 removal;
//   (2) add a benign extra call -> guard PASSES (count 3 >= 2, anchor intact),
//       proving the relaxation from `=== 2` to `>= 2` does not false-fail.
// ---------------------------------------------------------------------------
const L127_ANCHOR = /refresh switch warning[^\n]*\r?\n\s*warningVisible = shouldWarn\(\s*originalId\s*,\s*id\s*,\s*bugFoldedTargets\s*\)/;
function relaxedGuardPasses(source) {
  const count = (source.match(SIMPLIFIED_CALL) || []).length;
  return count >= 2 && L127_ANCHOR.test(source);
}
function mutateRemoveL127Only(source) {
  // Remove ONLY the L127 comment+call region; leave the identical L92 call.
  return source.replace(
    /[ \t]*\/\/[^\n]*refresh switch warning[^\n]*\r?\n[ \t]*warningVisible = shouldWarn\(\s*originalId\s*,\s*id\s*,\s*bugFoldedTargets\s*\);\r?\n/,
    '');
}
function mutateAddBenignCall(source) {
  // Append a legitimate extra call (no "refresh switch warning" comment, so it
  // cannot forge the L127 anchor) to simulate a future third call site.
  return source + '\n// benign extra usage\nconst _benign = shouldWarn(originalId, id, bugFoldedTargets);\n';
}
function mutateRewordComment(source) {
  // Reword ONLY the comment tail AFTER the load-bearing "refresh switch warning"
  // token, leaving that token and the next-line call intact — a maintainer's
  // harmless edit of the rest of the sentence. The anchor's `[^\n]*` tail must
  // tolerate this, so the guard must NOT false-fail.
  return source.replace(
    /(refresh switch warning)[^\n]*(\r?\n[ \t]*warningVisible = shouldWarn\(\s*originalId\s*,\s*id\s*,\s*bugFoldedTargets\s*\))/,
    '$1 once the fold has been persisted (see the renderer flow)$2');
}
function mutateRewordToken(source) {
  // Reword the load-bearing "refresh switch warning" TOKEN itself (call intact).
  // Tolerance is scoped to the tail only, so dropping the token MUST break the
  // guard.
  return source.replace('refresh switch warning', 'recompute banner state');
}

test('E2E Scenario (mutation): the relaxed guard catches an L127-only removal that L92 would otherwise mask', () => {
  // Given the real task-042 e2e source and the relaxed guard (count>=2 + anchor)
  const src = readTarget();
  // Then the guard PASSES on the unmutated real source
  assert.ok((src.match(SIMPLIFIED_CALL) || []).length >= 2,
    'the real source has at least two simplified call sites (L92 + L127)');
  assert.equal(relaxedGuardPasses(src), true,
    'the relaxed guard passes on the real current source');

  // When we simulate removing ONLY the L127 comment+call region, in-memory
  const mutant = mutateRemoveL127Only(src);

  // Then exactly one occurrence is gone (the identical L92 call still remains)
  assert.notEqual(mutant, src, 'the in-memory mutation actually altered the source');
  assert.equal((mutant.match(SIMPLIFIED_CALL) || []).length, 1,
    'only L127 was removed — the byte-identical L92 call survives (count drops 2 -> 1)');
  // And the comment-anchored L127 match disappears
  assert.equal(L127_ANCHOR.test(mutant), false,
    'the L127-anchored match vanishes once L127 is removed');
  // And the relaxed guard FAILS on the mutant (count 1 < 2 AND anchor gone),
  // proving L92 no longer masks an L127 removal
  assert.equal(relaxedGuardPasses(mutant), false,
    'the relaxed guard FAILS on the L127-removed mutant (regression is caught)');
});

test('E2E Scenario (mutation): the relaxed guard tolerates a benign third call site (no false-fail)', () => {
  // Given the real task-042 e2e source
  const src = readTarget();
  // When we simulate a legitimate future third call site, in-memory
  const mutant = mutateAddBenignCall(src);
  // Then the count rises to 3 and the L127 anchor is untouched
  assert.notEqual(mutant, src, 'the benign mutation actually altered the source');
  assert.equal((mutant.match(SIMPLIFIED_CALL) || []).length, 3,
    'the benign extra call brings the count to 3');
  assert.equal(L127_ANCHOR.test(mutant), true,
    'the L127 anchor is untouched by the benign extra call');
  // And the relaxed guard STILL PASSES (>= 2 tolerates the third call), which the
  // old `=== 2` check would have wrongly rejected
  assert.equal(relaxedGuardPasses(mutant), true,
    'the relaxed guard PASSES with a benign third call site (the >= 2 relaxation)');
});

// ---------------------------------------------------------------------------
// Scenario (mutation / tolerance): rewording the comment TAIL after the
// load-bearing "refresh switch warning" token (token + call intact) must NOT
// false-fail the guard — the `[^\n]*` tolerance is exactly for that.
// ---------------------------------------------------------------------------
test('E2E Scenario (mutation): rewording the comment tail after the token does not false-fail', () => {
  // Given the target with the anchor comment tail reworded in-memory (token + call intact)
  const src = readTarget();
  const mutant = mutateRewordComment(src);
  assert.notEqual(mutant, src, 'the reword mutation actually altered the source');
  // And the load-bearing token and both call sites survive
  assert.ok(/refresh switch warning/.test(mutant),
    'the load-bearing "refresh switch warning" token is preserved by the tail reword');
  assert.equal((mutant.match(SIMPLIFIED_CALL) || []).length, 2,
    'both simplified call sites survive the comment-tail reword (count stays 2)');
  assert.equal(L127_ANCHOR.test(mutant), true,
    'the L127 anchor still matches after a benign comment-tail reword');
  // Then the relaxed guard still passes
  assert.equal(relaxedGuardPasses(mutant), true,
    'the relaxed guard STILL PASSES when only the comment tail is reworded');
});

// ---------------------------------------------------------------------------
// Scenario (mutation / edge): the tolerance is scoped to the TAIL only —
// rewording/removing the load-bearing "refresh switch warning" token itself is
// caught, even though the call site remains.
// ---------------------------------------------------------------------------
test('E2E Scenario (mutation edge): rewording the load-bearing token itself is caught', () => {
  // Given the target with the "refresh switch warning" token removed/reworded in-memory
  const src = readTarget();
  const mutant = mutateRewordToken(src);
  assert.notEqual(mutant, src, 'the token reword actually altered the source');
  assert.ok(!/refresh switch warning/.test(mutant),
    'the "refresh switch warning" token is gone in the mutant');
  // And the call site itself is untouched (count still >= 2)
  assert.equal((mutant.match(SIMPLIFIED_CALL) || []).length, 2,
    'the call sites survive — only the anchoring token was reworded (count stays 2)');
  assert.equal(L127_ANCHOR.test(mutant), false,
    'the L127 anchor no longer matches once its token is reworded');
  // Then the relaxed guard fails (tolerance is tail-only, not the token)
  assert.equal(relaxedGuardPasses(mutant), false,
    'the relaxed guard FAILS when the load-bearing token itself is reworded/removed');
});

// ---------------------------------------------------------------------------
// Scenario (behavioural equivalence): simplifying the dead selector cannot
// change what shouldWarn returns, since both branches were originalId.
// ---------------------------------------------------------------------------
test('E2E Scenario: dead selector and simplified form yield identical warnings', () => {
  const id = 'TASK-050';
  // Given a committed-fold set with a fold on a DIFFERENT original than selected
  const committed = new Set([foldKey('A', id)]);
  const selected = 'B';
  // When we compute the warning both via the (removed) dead ternary shape and
  // via the simplified argument — both pass the SAME originalId
  const deadSelectorArg = committed.size ? selected : selected; // both branches == selected
  const viaDead = shouldWarn(deadSelectorArg, id, committed);
  const viaSimplified = shouldWarn(selected, id, committed);
  // Then the two are identical (proving the ternary was inert)
  assert.equal(viaDead, viaSimplified,
    'the removed ternary was inert: identical branches yield the same result');
  assert.equal(viaSimplified, true, 'a cross-original fold still surfaces the warning');
});

// ---------------------------------------------------------------------------
// Scenario (edge / no-warn path): same-original selection warns for neither
// form — the cleanup preserves the no-warn behaviour too.
// ---------------------------------------------------------------------------
test('E2E Scenario (edge): same-original selection warns for neither form', () => {
  const id = 'TASK-050';
  // Given a fold committed on A and A still selected
  const committed = new Set([foldKey('A', id)]);
  const selected = 'A';
  // When both forms are evaluated
  const deadSelectorArg = committed.size ? selected : selected;
  const viaDead = shouldWarn(deadSelectorArg, id, committed);
  const viaSimplified = shouldWarn(selected, id, committed);
  // Then neither warns and they agree
  assert.equal(viaDead, false);
  assert.equal(viaSimplified, false);
  assert.equal(viaDead, viaSimplified, 'no-warn path preserved by the simplification');
});
