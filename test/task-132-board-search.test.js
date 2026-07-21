'use strict';

// ===========================================================================
// TASK-132 — UNIT tests for the pure board-search matcher.
//
// `taskMatchesSearch(tk, query)` is a pure, top-level function in
// renderer/renderer.js. renderer.js is a browser script (no module.exports,
// references `document`), so — following the extraction pattern in
// test/helpers/task-101-lane-harness.js — we brace-match the single function
// declaration out of the source and eval JUST it, with no DOM, no window, no
// IPC. Nothing real (DB / disk / network) is touched: the function is a string
// scan over the ticket's own in-memory fields.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RENDERER = path.join(__dirname, '..', 'renderer', 'renderer.js');
const rendererSrc = fs.readFileSync(RENDERER, 'utf8');

// Brace-match a named function declaration out of the source (the same approach
// task-101-lane-harness.js uses for renderTasksBoard et al).
function extractFn(src, name) {
  let start = src.indexOf('function ' + name + '(');
  assert.ok(start !== -1, `function ${name} found in renderer.js`);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) { i += 1; break; } }
  }
  return src.slice(start, i);
}

// eslint-disable-next-line no-new-func
const taskMatchesSearch = new Function(
  extractFn(rendererSrc, 'taskMatchesSearch') + '\nreturn taskMatchesSearch;',
)();

// A ticket entry mirrors the in-memory shape { file, path, folder, fm, body, raw }.
function tk(fm, body) {
  return { file: (fm && fm.id ? fm.id + '.md' : 'x.md'), fm: fm || {}, body: body || '' };
}

// ---------------------------------------------------------------------------

test('matches on the ticket TITLE, case-insensitively', () => {
  const t = tk({ id: 'TASK-001', title: 'Add login form' }, 'unrelated body');
  assert.equal(taskMatchesSearch(t, 'login'), true, 'lowercase query hits the title');
  assert.equal(taskMatchesSearch(t, 'LOGIN'), true, 'uppercase query hits the title');
  assert.equal(taskMatchesSearch(t, 'LoGiN'), true, 'mixed-case query hits the title');
  assert.equal(taskMatchesSearch(t, 'logout'), false, 'a non-substring does not match');
});

test('matches on the ticket ID, case-insensitively', () => {
  const t = tk({ id: 'TASK-002', title: 'Fix logout crash' }, '');
  assert.equal(taskMatchesSearch(t, 'task-002'), true, 'lowercased id matches');
  assert.equal(taskMatchesSearch(t, 'TASK-002'), true, 'exact id matches');
  assert.equal(taskMatchesSearch(t, '002'), true, 'a substring of the id matches');
  assert.equal(taskMatchesSearch(t, 'task-999'), false, 'a different id does not match');
});

test('matches on the ticket BODY text', () => {
  const t = tk({ id: 'TASK-002', title: 'Fix logout crash' }, 'caused by a null pointer deref');
  assert.equal(taskMatchesSearch(t, 'null pointer'), true, 'a body phrase matches');
  assert.equal(taskMatchesSearch(t, 'NULL POINTER'), true, 'body match is case-insensitive');
  assert.equal(taskMatchesSearch(t, 'segfault'), false, 'absent body text does not match');
});

test('empty / whitespace-only / null query matches EVERYTHING (no filter)', () => {
  const t = tk({ id: 'TASK-003', title: 'Polish dashboard styles' }, 'CSS cleanup');
  assert.equal(taskMatchesSearch(t, ''), true, 'empty string matches all');
  assert.equal(taskMatchesSearch(t, '   '), true, 'whitespace-only matches all (trimmed to empty)');
  assert.equal(taskMatchesSearch(t, '\t\n  '), true, 'tabs/newlines are trimmed away');
  assert.equal(taskMatchesSearch(t, null), true, 'null query matches all');
  assert.equal(taskMatchesSearch(t, undefined), true, 'undefined query matches all');
});

test('a non-empty query is TRIMMED before matching', () => {
  const t = tk({ id: 'TASK-001', title: 'Add login form' }, '');
  assert.equal(taskMatchesSearch(t, '  login  '), true, 'surrounding whitespace is trimmed off the query');
});

test('regex metacharacters are matched LITERALLY (never a RegExp, never throws)', () => {
  const t = tk({ id: 'TASK-050', title: 'Handle (edge) [case] *.md' }, 'path a\\b regex .*+? test');
  // Each metacharacter query is treated as plain text via String.includes.
  assert.equal(taskMatchesSearch(t, '(edge)'), true, 'parens are literal');
  assert.equal(taskMatchesSearch(t, '[case]'), true, 'brackets are literal');
  assert.equal(taskMatchesSearch(t, '(edge) [case]'), true, 'a metachar phrase is literal');
  assert.equal(taskMatchesSearch(t, '*.md'), true, 'star/dot are literal');
  assert.equal(taskMatchesSearch(t, 'a\\b'), true, 'a backslash is literal');
  assert.equal(taskMatchesSearch(t, '.*+?'), true, 'a run of metachars is a literal substring here');
  // A metacharacter that WOULD match as a regex but is absent as literal text
  // must NOT match — proving no RegExp is compiled.
  assert.equal(taskMatchesSearch(t, '.*zzz'), false, 'regex-y query that is not a literal substring fails');
  // And nothing throws for any of these (no RegExp construction / ReDoS surface).
  assert.doesNotThrow(() => taskMatchesSearch(t, '([{*+?\\'), 'unbalanced metachars never throw');
});

test('tolerates a null / undefined ticket without throwing', () => {
  // Empty query returns true before ever touching the ticket.
  assert.equal(taskMatchesSearch(null, ''), true, 'null ticket + empty query → matches (no throw)');
  assert.equal(taskMatchesSearch(undefined, '   '), true, 'undefined ticket + whitespace → matches');
  // Non-empty query on a missing ticket is a clean false (no throw).
  assert.doesNotThrow(() => taskMatchesSearch(null, 'login'));
  assert.equal(taskMatchesSearch(null, 'login'), false, 'null ticket + real query → no match');
  assert.equal(taskMatchesSearch(undefined, 'login'), false, 'undefined ticket + real query → no match');
});

test('tolerates a missing fm and missing fm.title / body without throwing', () => {
  assert.doesNotThrow(() => taskMatchesSearch({ file: 'a.md' }, 'x'), 'ticket with no fm at all');
  assert.equal(taskMatchesSearch({ file: 'a.md' }, 'x'), false, 'no fields → no match for a real query');
  // fm present but title/body absent: id still searchable, missing fields ignored.
  const t = { fm: { id: 'TASK-007' } };
  assert.equal(taskMatchesSearch(t, 'task-007'), true, 'id still matches with title/body absent');
  assert.equal(taskMatchesSearch(t, 'anything-else'), false, 'no throw when title/body are undefined');
  // Explicit nulls on the searchable fields.
  const t2 = { fm: { id: null, title: null }, body: null };
  assert.doesNotThrow(() => taskMatchesSearch(t2, 'x'));
  assert.equal(taskMatchesSearch(t2, 'x'), false, 'all-null fields → no match, no throw');
  // A ticket rendered "(untitled)" (empty title) with an empty body.
  const t3 = { fm: { id: 'TASK-008', title: '' }, body: '' };
  assert.equal(taskMatchesSearch(t3, 'task-008'), true, 'empty title/body still lets the id match');
});

test('numeric / non-string fm fields are coerced, not thrown on', () => {
  const t = { fm: { id: 123, title: 456 }, body: 789 };
  assert.doesNotThrow(() => taskMatchesSearch(t, '123'));
  assert.equal(taskMatchesSearch(t, '123'), true, 'a numeric id is stringified before matching');
  assert.equal(taskMatchesSearch(t, '456'), true, 'a numeric title is stringified');
  assert.equal(taskMatchesSearch(t, '789'), true, 'a numeric body is stringified');
});
