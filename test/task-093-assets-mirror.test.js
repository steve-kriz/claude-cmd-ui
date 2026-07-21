'use strict';

// ===========================================================================
// TASK-093 — UNIT tests for lib/assets-mirror.js `mirrorRelPath`.
//
// Pure mapping module: no filesystem, no Electron, nothing to mock. Verifies
// both mirrored subtrees, every null case, `\`/mixed separators, leading `./`
// and `/`, and non-string junk input (must never throw).
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { mirrorRelPath, MIRRORED_SUBTREES } = require('../lib/assets-mirror.js');

// --- MIRRORED_SUBTREES shape ----------------------------------------------
test('MIRRORED_SUBTREES declares exactly the two mirrored subtrees', () => {
  assert.deepEqual(MIRRORED_SUBTREES, [
    { from: '.claude/agents/', to: 'assets/agents/' },
    { from: '.claude/skills/orchestrate/', to: 'assets/skills/orchestrate/' },
  ]);
});

// --- Subtree 1: .claude/agents/ -> assets/agents/ -------------------------
test('maps .claude/agents/<f> to assets/agents/<f>', () => {
  assert.equal(mirrorRelPath('.claude/agents/ba.md'), 'assets/agents/ba.md');
  assert.equal(mirrorRelPath('.claude/agents/coder.md'), 'assets/agents/coder.md');
  // Nested remainder is preserved verbatim.
  assert.equal(mirrorRelPath('.claude/agents/sub/deep.md'), 'assets/agents/sub/deep.md');
});

// --- Subtree 2: .claude/skills/orchestrate/ -> assets/skills/orchestrate/ --
test('maps .claude/skills/orchestrate/<f> to assets/skills/orchestrate/<f>', () => {
  assert.equal(
    mirrorRelPath('.claude/skills/orchestrate/SKILL.md'),
    'assets/skills/orchestrate/SKILL.md',
  );
  assert.equal(
    mirrorRelPath('.claude/skills/orchestrate/refs/notes.md'),
    'assets/skills/orchestrate/refs/notes.md',
  );
});

// --- Separator handling: `\`, mixed, leading `./` and `/` -----------------
test('normalises backslash separators', () => {
  assert.equal(
    mirrorRelPath('.claude\\agents\\ba.md'),
    'assets/agents/ba.md',
  );
  assert.equal(
    mirrorRelPath('.claude\\skills\\orchestrate\\SKILL.md'),
    'assets/skills/orchestrate/SKILL.md',
  );
});

test('normalises mixed separators', () => {
  assert.equal(
    mirrorRelPath('.claude/skills\\orchestrate/SKILL.md'),
    'assets/skills/orchestrate/SKILL.md',
  );
});

test('tolerates a leading ./ and leading slashes', () => {
  assert.equal(mirrorRelPath('./.claude/agents/ba.md'), 'assets/agents/ba.md');
  assert.equal(mirrorRelPath('/.claude/agents/ba.md'), 'assets/agents/ba.md');
  assert.equal(mirrorRelPath('.\\.claude\\agents\\ba.md'), 'assets/agents/ba.md');
  assert.equal(mirrorRelPath('///.claude/agents/ba.md'), 'assets/agents/ba.md');
});

// --- Null cases: anything outside the two mirrored subtrees ----------------
test('returns null for .claude paths outside the mirrored subtrees', () => {
  assert.equal(mirrorRelPath('.claude/settings.json'), null);
  assert.equal(mirrorRelPath('.claude/skills/other/x.md'), null);
  assert.equal(mirrorRelPath('.claude/commands/foo.md'), null);
});

test('returns null for non-.claude paths', () => {
  assert.equal(mirrorRelPath('tasks/x.md'), null);
  assert.equal(mirrorRelPath('assets/agents/ba.md'), null);
  assert.equal(mirrorRelPath('README.md'), null);
  assert.equal(mirrorRelPath('src/index.js'), null);
});

test('returns null for the bare subtree directory (no file remainder)', () => {
  assert.equal(mirrorRelPath('.claude/agents/'), null);
  assert.equal(mirrorRelPath('.claude/agents'), null);
  assert.equal(mirrorRelPath('.claude/skills/orchestrate/'), null);
  assert.equal(mirrorRelPath('.claude/skills/orchestrate'), null);
});

test('does not match a subtree prefix that is only a substring of another segment', () => {
  // ".claude/agentsX/..." must not be treated as ".claude/agents/...".
  assert.equal(mirrorRelPath('.claude/agentsX/ba.md'), null);
  assert.equal(mirrorRelPath('.claude/skills/orchestrateX/y.md'), null);
});

// --- Non-string / junk input: must return null, never throw ---------------
test('returns null for non-string input without throwing', () => {
  assert.equal(mirrorRelPath(undefined), null);
  assert.equal(mirrorRelPath(null), null);
  assert.equal(mirrorRelPath(123), null);
  assert.equal(mirrorRelPath({}), null);
  assert.equal(mirrorRelPath([]), null);
  assert.equal(mirrorRelPath(true), null);
  assert.equal(mirrorRelPath(() => {}), null);
});

test('returns null for the empty string', () => {
  assert.equal(mirrorRelPath(''), null);
});

// --- Purity: repeated calls never throw and are stable --------------------
test('is pure and stable across repeated calls', () => {
  for (let i = 0; i < 3; i++) {
    assert.equal(mirrorRelPath('.claude/agents/ba.md'), 'assets/agents/ba.md');
    assert.equal(mirrorRelPath('.claude/settings.json'), null);
  }
});
