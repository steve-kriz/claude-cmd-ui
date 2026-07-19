'use strict';

// ===========================================================================
// TASK-045 — UNIT drift guard for the dead-ternary cleanup.
//
// The build simplified a dead ternary in
//   test/task-042-bug-multitarget-switch.e2e.test.js  (~line 127)
// from   shouldWarn(bugFoldedTargets.size ? originalId : originalId, id, ...)
// to     shouldWarn(originalId, id, bugFoldedTargets)
// Both branches of the ternary were the identical `originalId`, so the guard
// selector had no effect. This unit guard reads the REAL source of that file
// and asserts the dead, identical-branch ternary can never silently return.
//
// Pure source scan. NO DATABASE. NO NETWORK. NO DISK writes (read-only).
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TARGET = path.join(__dirname, 'task-042-bug-multitarget-switch.e2e.test.js');
const readTarget = () => fs.readFileSync(TARGET, 'utf8');

// Matches any `<anything> ? originalId : originalId` identical-branch ternary,
// tolerant of whitespace around the ? and :.
const DEAD_TERNARY = /\?\s*originalId\s*:\s*originalId/;

test('unit: target e2e test file exists and is readable', () => {
  assert.ok(fs.existsSync(TARGET), 'task-042 e2e test file must exist');
  const src = readTarget();
  assert.ok(src.length > 0, 'target file must not be empty');
});

test('unit: the dead identical-branch ternary is absent from the target source', () => {
  const src = readTarget();
  assert.ok(!DEAD_TERNARY.test(src),
    'a `x ? originalId : originalId` dead ternary must NOT be present in task-042 e2e test');
});

// The target has TWO byte-identical simplified call sites:
//   ~L92  warningVisible = shouldWarn(originalId, id, bugFoldedTargets)  (change listener)
//   ~L127 warningVisible = shouldWarn(originalId, id, bugFoldedTargets)  (post-fold refresh)
// A whole-file "is the call present?" scan is under-covered: if ONLY the L127
// site were removed/altered, the identical L92 occurrence would keep the guard
// green. Both the `warningVisible =` prefix AND the bare call are non-unique, so
// we combine (a) a MINIMUM occurrence COUNT (>= 2) and (b) a context anchor
// unique to L127 (its preceding "refresh switch warning" comment). The count is
// relaxed from an exact `=== 2` to `>= 2` so a LEGITIMATE future third call site
// does not false-fail, WITHOUT losing teeth: removing ONLY L127 leaves just the
// identical L92 call, dropping the count to 1 (< 2) AND vanishing the anchor, so
// both assertions still FAIL — catching the regression L92 would otherwise hide.
const SIMPLIFIED_CALL = /shouldWarn\(\s*originalId\s*,\s*id\s*,\s*bugFoldedTargets\s*\)/g;

test('unit: BOTH simplified shouldWarn(originalId, id, bugFoldedTargets) call sites are present', () => {
  const src = readTarget();
  const occurrences = (src.match(SIMPLIFIED_CALL) || []).length;
  assert.ok(occurrences >= 2,
    'both simplified shouldWarn(originalId, id, bugFoldedTargets) call sites (L92 change-listener + L127 post-fold refresh) must be present (>= 2; a benign extra call is allowed)');
});

test('unit: the L127 post-fold shouldWarn refresh call site is present (context-anchored)', () => {
  const src = readTarget();
  // Anchored to the STABLE, unique "refresh switch warning" comment fragment that
  // precedes L127 (verified to occur exactly once in the target), plus the call
  // line, so removing/altering ONLY L127 (leaving the identical L92 call, which
  // has NO such comment) is DETECTED. `[^\n]*` after the fragment tolerates a
  // harmless reword of the rest of the comment sentence.
  assert.match(src,
    /refresh switch warning[^\n]*\r?\n\s*warningVisible = shouldWarn\(\s*originalId\s*,\s*id\s*,\s*bugFoldedTargets\s*\)/,
    'the L127 post-fold refresh (with its "refresh switch warning" comment) must remain');
});

test('unit: no residual bugFoldedTargets.size selector feeding the shouldWarn original arg', () => {
  const src = readTarget();
  assert.ok(!/shouldWarn\(\s*bugFoldedTargets\.size\s*\?/.test(src),
    'no bugFoldedTargets.size ? ... selector may feed shouldWarn\'s original argument');
});

// ---------------------------------------------------------------------------
// MUTATION TESTS (prove the RELAXED guard keeps its teeth AND its tolerance).
//
// The relaxed guard is the conjunction of:
//   (a) SIMPLIFIED_CALL occurrence count >= 2, AND
//   (b) the comment-anchored L127 match (stable "refresh switch warning" frag).
// We SIMULATE two mutations in-memory (never touching the file on disk):
//   (1) removing ONLY the L127 comment+call region — the guard must still FAIL
//       (count drops 2 -> 1 which is < 2, AND the anchor vanishes). Because L92
//       is byte-identical to L127, a naive whole-file "present?" scan would stay
//       green here — this proves count(>=2)+anchor still catches it.
//   (2) adding a BENIGN extra shouldWarn(originalId, id, bugFoldedTargets) call
//       elsewhere (count -> 3) — the guard must still PASS (>= 2 tolerates it and
//       the L127 anchor is untouched). This proves the relaxation from `=== 2`
//       does not false-fail on a legitimate future third call site.
// ---------------------------------------------------------------------------

// The relaxed guard predicate under test (mirrors assertions above).
const L127_ANCHOR = /refresh switch warning[^\n]*\r?\n\s*warningVisible = shouldWarn\(\s*originalId\s*,\s*id\s*,\s*bugFoldedTargets\s*\)/;
function relaxedGuardPasses(source) {
  const count = (source.match(SIMPLIFIED_CALL) || []).length;
  return count >= 2 && L127_ANCHOR.test(source);
}
// Delete ONLY the L127 comment+call region (leaving the identical L92 call).
function mutateRemoveL127Only(source) {
  return source.replace(
    /[ \t]*\/\/[^\n]*refresh switch warning[^\n]*\r?\n[ \t]*warningVisible = shouldWarn\(\s*originalId\s*,\s*id\s*,\s*bugFoldedTargets\s*\);\r?\n/,
    '');
}
// Add a BENIGN third simplified call (no "refresh switch warning" comment, so it
// cannot forge the L127 anchor) to simulate a legitimate future call site.
function mutateAddBenignCall(source) {
  return source + '\n// benign extra usage\nconst _benign = shouldWarn(originalId, id, bugFoldedTargets);\n';
}
// Reword ONLY the comment TAIL that follows the load-bearing "refresh switch
// warning" token, leaving both that token AND the next-line call intact. This
// simulates a maintainer harmlessly editing the rest of the comment sentence
// (e.g. updating the `renderer.js ~6733` reference). The `[^\n]*` tolerance in
// the anchor means this must NOT break the guard.
function mutateRewordComment(source) {
  return source.replace(
    /(refresh switch warning)[^\n]*(\r?\n[ \t]*warningVisible = shouldWarn\(\s*originalId\s*,\s*id\s*,\s*bugFoldedTargets\s*\))/,
    '$1 once the fold has been persisted (see the renderer flow)$2');
}
// Reword the load-bearing "refresh switch warning" TOKEN itself (leaving the
// call intact) — the tolerance is scoped to the tail only, so removing the
// anchoring token MUST break the guard.
function mutateRewordToken(source) {
  return source.replace('refresh switch warning', 'recompute banner state');
}

test('unit (mutation): relaxed guard PASSES on real source but FAILS when only L127 is removed', () => {
  const src = readTarget();

  // The real, unmutated source satisfies BOTH parts of the guard.
  assert.ok((src.match(SIMPLIFIED_CALL) || []).length >= 2,
    'real source has at least 2 simplified call sites');
  assert.equal(relaxedGuardPasses(src), true,
    'the relaxed guard must PASS on the real current source');

  // Simulate deleting ONLY the L127 site, in-memory.
  const mutant = mutateRemoveL127Only(src);
  assert.notEqual(mutant, src, 'the mutation must actually alter the in-memory source');
  assert.equal((mutant.match(SIMPLIFIED_CALL) || []).length, 1,
    'removing ONLY L127 drops the count to 1 (the identical L92 call survives)');
  assert.equal(L127_ANCHOR.test(mutant), false,
    'the comment-anchored L127 match must vanish in the mutant');

  // The conjunction (count>=2 AND anchor) must FAIL on the mutant: count 1 < 2
  // AND anchor gone — proving the L92 occurrence no longer masks an L127 removal.
  assert.equal(relaxedGuardPasses(mutant), false,
    'the relaxed guard must FAIL on the L127-removed mutant');
});

test('unit (mutation): relaxed guard still PASSES when a benign third call site is added', () => {
  const src = readTarget();

  // Add a legitimate extra call (count 2 -> 3), leaving the L127 anchor intact.
  const mutant = mutateAddBenignCall(src);
  assert.notEqual(mutant, src, 'the benign mutation must actually alter the in-memory source');
  assert.equal((mutant.match(SIMPLIFIED_CALL) || []).length, 3,
    'the benign extra call brings the count to 3');
  assert.equal(L127_ANCHOR.test(mutant), true,
    'the L127 anchor is untouched by the benign extra call');

  // count 3 satisfies >= 2 AND the anchor still matches -> guard PASSES. This is
  // the relaxation the old `=== 2` would have wrongly rejected.
  assert.equal(relaxedGuardPasses(mutant), true,
    'the relaxed guard must PASS when a benign third call site is present (no false-fail)');
});

test('unit (mutation): relaxed guard still PASSES when the comment TAIL is reworded but the token+call stay', () => {
  const src = readTarget();

  // Reword only the comment tail after the "refresh switch warning" token.
  const mutant = mutateRewordComment(src);
  assert.notEqual(mutant, src, 'the reword mutation must actually alter the in-memory source');
  // The load-bearing token and the L127 call itself are untouched.
  assert.ok(/refresh switch warning/.test(mutant),
    'the load-bearing "refresh switch warning" token is preserved by the reword');
  assert.equal((mutant.match(SIMPLIFIED_CALL) || []).length, 2,
    'the reword leaves both simplified call sites intact (count stays 2)');

  // The `[^\n]*` tolerance means the anchor still matches -> guard PASSES. This
  // proves the guard does NOT false-fail on a benign comment-tail reword.
  assert.equal(L127_ANCHOR.test(mutant), true,
    'the L127 anchor still matches after a benign comment-tail reword');
  assert.equal(relaxedGuardPasses(mutant), true,
    'the relaxed guard must PASS when only the comment tail is reworded (token + call intact)');
});

test('unit (mutation): relaxed guard FAILS when the load-bearing "refresh switch warning" token itself is reworded', () => {
  const src = readTarget();

  // Reword the anchoring token itself (the call is left intact).
  const mutant = mutateRewordToken(src);
  assert.notEqual(mutant, src, 'the token reword must actually alter the in-memory source');
  assert.ok(!/refresh switch warning/.test(mutant),
    'the "refresh switch warning" token is gone in the mutant');
  assert.equal((mutant.match(SIMPLIFIED_CALL) || []).length, 2,
    'the call sites survive — only the anchoring token was reworded (count stays 2)');

  // Tolerance is scoped to the TAIL only: removing the token drops the anchor, so
  // the guard must FAIL even though the count is still >= 2.
  assert.equal(L127_ANCHOR.test(mutant), false,
    'the L127 anchor no longer matches once its token is reworded');
  assert.equal(relaxedGuardPasses(mutant), false,
    'the relaxed guard must FAIL when the load-bearing token itself is reworded/removed');
});
