'use strict';

// ===========================================================================
// TASK-125 — UNIT tests (F1).
//
// Review follow-up of TASK-107. augmentDarwinPath must PREPEND the two GUI-
// missing dirs (/usr/local/bin, /opt/homebrew/bin) to PATH on darwin so the
// app resolves the same Homebrew-first binary the user's terminal does (was an
// APPEND — the regression these tests guard). It must be idempotent (repeat
// calls never grow PATH, no duplicates, existing entries never moved) and a
// strict no-op off darwin.
//
// The REAL augmentDarwinPath is EXTRACTED from main.js by brace-matching and
// evaluated headless via `new Function` — main.js's Electron entry code is
// NEVER executed (requiring main.js would boot Electron). This follows the
// TASK-107 test convention.
//
// No real Electron, filesystem, PATH, or database is touched.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');

// --- Extract a named `function foo(...) { ... }` by brace-matching so the REAL
// source (not a replica) is evaluated headless. Matches the repo convention. ---
function extractFn(src, name) {
  let start = src.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, `function ${name} found in source`);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) { i += 1; break; } }
  }
  return src.slice(start, i);
}

const mainSrc = fs.readFileSync(path.join(REPO, 'main.js'), 'utf8');

// The REAL augmentDarwinPath pulled out of main.js (Electron entry code inert).
const augmentDarwinPath = new Function(
  extractFn(mainSrc, 'augmentDarwinPath') + '\nreturn augmentDarwinPath;'
)();

// ---------------------------------------------------------------------------
// F1a — darwin prepend order (guards the append regression)
// ---------------------------------------------------------------------------
test('UNIT F1: darwin injects both GUI dirs at the FRONT, ahead of /usr/bin', () => {
  const env = { PATH: '/usr/bin:/bin' };
  augmentDarwinPath('darwin', env);
  // Injected dirs must lead the PATH so Homebrew wins over Xcode-CLT /usr/bin.
  assert.equal(env.PATH, '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin');
  const parts = env.PATH.split(':');
  assert.ok(parts.indexOf('/usr/local/bin') < parts.indexOf('/usr/bin'),
    '/usr/local/bin precedes /usr/bin (prepend, not append)');
  assert.ok(parts.indexOf('/opt/homebrew/bin') < parts.indexOf('/usr/bin'),
    '/opt/homebrew/bin precedes /usr/bin (prepend, not append)');
});

// ---------------------------------------------------------------------------
// F1b — idempotence (no growth, no duplicates on repeat calls)
// ---------------------------------------------------------------------------
test('UNIT F1: second call on the same env yields an identical PATH string', () => {
  const env = { PATH: '/usr/bin:/bin' };
  augmentDarwinPath('darwin', env);
  const after1 = env.PATH;
  augmentDarwinPath('darwin', env);
  assert.equal(env.PATH, after1, 'PATH byte-identical after the second call');
  assert.equal(env.PATH, '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin');
  // No duplicate of either injected dir.
  const parts = env.PATH.split(':');
  assert.equal(parts.filter((p) => p === '/usr/local/bin').length, 1);
  assert.equal(parts.filter((p) => p === '/opt/homebrew/bin').length, 1);
});

test('UNIT F1: a third call still does not grow PATH', () => {
  const env = { PATH: '/usr/bin' };
  augmentDarwinPath('darwin', env);
  augmentDarwinPath('darwin', env);
  augmentDarwinPath('darwin', env);
  assert.equal(env.PATH, '/usr/local/bin:/opt/homebrew/bin:/usr/bin');
});

// ---------------------------------------------------------------------------
// F1c — pre-existing dir not moved / not duplicated; only the missing one added
// ---------------------------------------------------------------------------
test('UNIT F1: pre-existing /opt/homebrew/bin is not moved or duplicated', () => {
  const env = { PATH: '/opt/homebrew/bin:/usr/bin' };
  augmentDarwinPath('darwin', env);
  // Only the missing /usr/local/bin is prepended; the already-present
  // /opt/homebrew/bin keeps its original relative position (not re-fronted).
  assert.equal(env.PATH, '/usr/local/bin:/opt/homebrew/bin:/usr/bin');
  assert.equal(env.PATH.split(':').filter((p) => p === '/opt/homebrew/bin').length, 1,
    '/opt/homebrew/bin appears exactly once');
});

test('UNIT F1: when both injected dirs already present (in any order) PATH is unchanged', () => {
  const env = { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' };
  augmentDarwinPath('darwin', env);
  assert.equal(env.PATH, '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
    'nothing added or reordered when both dirs are already present');
});

// ---------------------------------------------------------------------------
// F1d — no-op off darwin, incl. undefined/empty PATH edge cases
// ---------------------------------------------------------------------------
test('UNIT F1: win32 leaves PATH exactly as-is', () => {
  const env = { PATH: 'C:\\Windows\\System32;C:\\Windows' };
  augmentDarwinPath('win32', env);
  assert.equal(env.PATH, 'C:\\Windows\\System32;C:\\Windows');
});

test('UNIT F1: linux leaves PATH exactly as-is', () => {
  const env = { PATH: '/usr/bin:/bin' };
  augmentDarwinPath('linux', env);
  assert.equal(env.PATH, '/usr/bin:/bin');
});

test('UNIT F1: off darwin with undefined PATH stays undefined (no key created)', () => {
  const env = {};
  augmentDarwinPath('win32', env);
  assert.equal(env.PATH, undefined, 'win32 does not synthesize a PATH');
  const env2 = {};
  augmentDarwinPath('linux', env2);
  assert.equal(env2.PATH, undefined, 'linux does not synthesize a PATH');
});

test('UNIT F1: off darwin with empty PATH stays empty', () => {
  const env = { PATH: '' };
  augmentDarwinPath('win32', env);
  assert.equal(env.PATH, '', 'win32 empty PATH untouched');
  const env2 = { PATH: '' };
  augmentDarwinPath('linux', env2);
  assert.equal(env2.PATH, '', 'linux empty PATH untouched');
});

test('UNIT F1: darwin with empty/undefined PATH seeds ONLY the two injected dirs', () => {
  const env = { PATH: '' };
  augmentDarwinPath('darwin', env);
  assert.equal(env.PATH, '/usr/local/bin:/opt/homebrew/bin',
    'empty PATH on darwin yields exactly the two injected dirs, no empty segments');

  const env2 = {};
  augmentDarwinPath('darwin', env2);
  assert.equal(env2.PATH, '/usr/local/bin:/opt/homebrew/bin',
    'undefined PATH on darwin yields exactly the two injected dirs');
});
