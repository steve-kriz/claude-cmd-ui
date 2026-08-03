'use strict';

// Unit tests for TASK-109: the exported `isFsSafeSlug(slug)` predicate in
// lib/ticket-lanes.js and the userStatusSetFor gate it feeds.
//
// isFsSafeSlug is true iff `slug` is a string of 1..30 chars matching
// /^[a-z0-9-]+$/, byte-equivalent to lib/team-config.js isValidUserSlug
// (SLUG_RE /^[a-z0-9-]+$/, MAX_SLUG_LENGTH 30) and renderer isSafeTasksSlug. The
// typeof guard runs BEFORE any regex test so hostile non-strings never throw.
//
// Everything under test is pure and Electron-free: NO database, filesystem, or
// network access happens (there is none to make), so all DB access is mocked away
// by construction.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  isFsSafeSlug,
  isUserStatus,
  isKnownStatusFor,
  laneForStatusFor,
  laneStatusesFor,
  UNKNOWN_STATUS,
} = require('../lib/ticket-lanes.js');

// Independent re-implementation of team-config's rule to assert byte-equivalence
// (the two must stay in lockstep; isFsSafeSlug may NOT require team-config).
const REF_MAX = 30;
const REF_RE = /^[a-z0-9-]+$/;
function refIsValidUserSlug(slug) {
  return typeof slug === 'string' && slug.length > 0 && slug.length <= REF_MAX && REF_RE.test(slug);
}

function col(status, system) {
  return { status, label: String(status), description: '', agent: null, system };
}

// --- isFsSafeSlug: accepted values ----------------------------------------

test('isFsSafeSlug: accepts lowercase/digit/hyphen slugs', () => {
  for (const slug of ['a', 'ux-review', 'todo', 'done', 'failed-testing', 'x1', '123', 'a-b-c', '0', 'z9-z9']) {
    assert.equal(isFsSafeSlug(slug), true, `${slug} is filesystem-safe`);
  }
});

test('isFsSafeSlug: length boundary — 1 and 30 accepted, 0 and 31 rejected', () => {
  assert.equal(isFsSafeSlug('a'), true, '1 char accepted');
  assert.equal(isFsSafeSlug(''), false, 'empty string rejected');
  assert.equal(isFsSafeSlug('a'.repeat(30)), true, 'exactly 30 chars accepted');
  assert.equal(isFsSafeSlug('a'.repeat(31)), false, '31 chars rejected');
  assert.equal(isFsSafeSlug('a'.repeat(100)), false, '100 chars rejected');
});

// --- isFsSafeSlug: rejected string values ---------------------------------

test('isFsSafeSlug: rejects path-traversal / separator / drive strings', () => {
  for (const slug of [
    '..', '.', '../../evil', 'evil/child', 'evil\\child', 'a/b', 'a\\b',
    'C:\\x', '/etc/passwd', './x', 'a/../b', '%2e%2e%2f', '..%2f',
  ]) {
    assert.equal(isFsSafeSlug(slug), false, `${JSON.stringify(slug)} is not filesystem-safe`);
  }
});

test('isFsSafeSlug: rejects uppercase, spaces, underscores, unicode, and other punctuation', () => {
  for (const slug of [
    'UX-Review', 'Todo', 'ux review', 'ux_review', 'ux.review', 'a b',
    'café', 'naïve', 'a!', 'a@b', 'a#', 'a+b', 'a,b', ' a', 'a ', '-leading-ok?',
  ]) {
    // Note: '-leading-ok?' contains '?' so it is rejected; a bare leading hyphen
    // like '-a' is class-valid and separately asserted below.
    assert.equal(isFsSafeSlug(slug), false, `${JSON.stringify(slug)} is not filesystem-safe`);
  }
  // The char class itself allows leading/trailing hyphens (team-config trims them
  // when deriving, but the predicate is class-only): these ARE safe.
  assert.equal(isFsSafeSlug('-a'), true);
  assert.equal(isFsSafeSlug('a-'), true);
});

// --- isFsSafeSlug: non-string hostile input (typeof guard, never throws) --

test('isFsSafeSlug: rejects non-strings without throwing (null/undefined/number/boolean)', () => {
  for (const v of [null, undefined, 0, 1, 42, NaN, Infinity, true, false]) {
    let result;
    assert.doesNotThrow(() => { result = isFsSafeSlug(v); }, `${String(v)} does not throw`);
    assert.equal(result, false, `${String(v)} is not a safe slug`);
  }
});

test('isFsSafeSlug: rejects Symbol without throwing (typeof guard precedes regex)', () => {
  let result;
  assert.doesNotThrow(() => { result = isFsSafeSlug(Symbol('ux-review')); });
  assert.equal(result, false);
});

test('isFsSafeSlug: rejects objects/arrays/functions without throwing', () => {
  const hostile = [
    {}, [], ['ux-review'], { toString() { return 'ux-review'; } },
    { get length() { throw new Error('trap'); } }, // length getter never reached (typeof guard fails first)
    () => 'ux-review', new String('ux-review'),
  ];
  for (const v of hostile) {
    let result;
    assert.doesNotThrow(() => { result = isFsSafeSlug(v); });
    assert.equal(result, false, 'non-string object/array/function is not a safe slug');
  }
});

// --- byte-equivalence with team-config's rule -----------------------------

test('isFsSafeSlug: byte-equivalent to team-config isValidUserSlug across a broad matrix', () => {
  const cases = [
    'a', 'ux-review', 'todo', 'done', 'failed-testing', '', '..', '.', '../../evil',
    'evil/child', 'evil\\child', 'UX-Review', 'ux review', 'ux_review', 'café',
    'a'.repeat(30), 'a'.repeat(31), '-a', 'a-', '0', '123', 'C:\\x', '/x',
    null, undefined, 42, true, {}, [], Symbol('x'),
  ];
  for (const v of cases) {
    assert.equal(isFsSafeSlug(v), refIsValidUserSlug(v),
      `isFsSafeSlug and team-config rule agree on ${String(typeof v === 'symbol' ? 'Symbol' : JSON.stringify(v))}`);
  }
});

// --- the gate's effect on userStatusSetFor consumers ----------------------

test('gate: an unsafe user column never becomes a user status / lane / folder', () => {
  const unsafe = ['../../evil', '..', 'evil/child', 'evil\\child', 'UX-Review', 'ux review', 'a'.repeat(31)];
  for (const slug of unsafe) {
    const columns = [col('todo', true), col('done', true), col(slug, false)];
    assert.equal(isUserStatus(slug, columns), false, `${slug}: excluded from user-status set`);
    assert.equal(isKnownStatusFor(slug, columns), false, `${slug}: not a known status`);
    assert.equal(laneForStatusFor(slug, columns), UNKNOWN_STATUS, `${slug}: routes to unknown`);
    assert.equal(laneStatusesFor(columns).includes(slug), false, `${slug}: omitted from lanes`);
  }
});

test('gate: a safe user column still enters the set and anchors its lane', () => {
  const columns = [
    col('todo', true), col('defining', true), col('in-progress', true),
    col('testing', true), col('ux-review', false), col('done', true),
  ];
  assert.equal(isUserStatus('ux-review', columns), true);
  assert.equal(isKnownStatusFor('ux-review', columns), true);
  assert.equal(laneForStatusFor('ux-review', columns), 'ux-review');
  assert.deepEqual(laneStatusesFor(columns), [
    'todo', 'defining', 'in-progress', 'testing', 'ux-review', 'done',
  ]);
});

test('gate: a safe user column alongside an unsafe one keeps the safe lane, drops the unsafe', () => {
  const columns = [
    col('todo', true), col('testing', true),
    col('../../evil', false), col('ux-review', false),
    col('done', true),
  ];
  assert.equal(isUserStatus('ux-review', columns), true, 'safe slug survives');
  assert.equal(isUserStatus('../../evil', columns), false, 'unsafe slug dropped');
  const lanes = laneStatusesFor(columns);
  assert.equal(lanes.includes('ux-review'), true);
  assert.equal(lanes.includes('../../evil'), false);
});

test('gate: never throws when a column carries a non-string / Symbol status', () => {
  const columns = [
    col('todo', true),
    { status: Symbol('s'), system: false },
    { status: 42, system: false },
    { status: null, system: false },
    col('ux-review', false),
  ];
  let ok;
  assert.doesNotThrow(() => {
    ok = isUserStatus('ux-review', columns) && !isUserStatus('42', columns);
  });
  assert.equal(ok, true);
});
