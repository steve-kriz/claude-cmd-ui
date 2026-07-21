'use strict';

// ===========================================================================
// TASK-114 F1 — renderer/lib mirror-map DRIFT-SYNC guard (UNIT).
//
// renderer/renderer.js duplicates lib/assets-mirror.js's mapping
// (ASSETS_MIRRORED_SUBTREES + mirrorRelPath, marked "KEEP IN SYNC") because the
// renderer is a browser script that cannot require Node modules. Nothing else
// enforces that the two copies stay identical, so this test extracts the
// renderer copy HEADLESS (the brace-matching extractFn / extractSubtreesConst
// convention from test/task-093-assets-mirror.e2e.test.js) and asserts it
// AGREES with the authoritative lib module:
//   - deepEqual of the subtree arrays, and
//   - behavioural equality of mirrorRelPath over a representative path set.
// If either copy diverges (a subtree renamed, a prefix edited, a normalisation
// tweak applied to only one side), this test fails.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const lib = require('../lib/assets-mirror.js');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');

// --- Extract a named function declaration by brace-matching. ----------------
// (Same convention as test/task-093-assets-mirror.e2e.test.js.)
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

// --- Extract the ASSETS_MIRRORED_SUBTREES const literal. --------------------
function extractSubtreesConst(src) {
  const m = src.match(/const\s+ASSETS_MIRRORED_SUBTREES\s*=\s*\[[\s\S]*?\];/);
  assert.ok(m, 'ASSETS_MIRRORED_SUBTREES const found in renderer.js');
  return m[0];
}

// Load the REAL renderer copy of the mapping headless.
function loadRendererMap() {
  const body = [
    extractSubtreesConst(rendererSrc),
    extractFn(rendererSrc, 'mirrorRelPath'),
    'return { ASSETS_MIRRORED_SUBTREES, mirrorRelPath };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(body)();
}
const renderer = loadRendererMap();

// --- Representative path set (string inputs). -------------------------------
// Covers: both subtrees, nested remainder, backslash + mixed separators,
// leading `./` and `/`, non-mirrored paths, bare subtree dirs, the prefix-
// substring trap, empty string, and a traversal remainder (mirrorRelPath does
// NOT canonicalize — both copies must map it identically, verbatim).
const STRING_PATHS = [
  // both subtrees
  '.claude/agents/ba.md',
  '.claude/agents/coder.md',
  '.claude/skills/orchestrate/SKILL.md',
  // nested remainder
  '.claude/agents/sub/deep.md',
  '.claude/skills/orchestrate/refs/notes.md',
  // backslash + mixed separators
  '.claude\\agents\\ba.md',
  '.claude\\skills\\orchestrate\\SKILL.md',
  '.claude/skills\\orchestrate/SKILL.md',
  // leading ./ and /
  './.claude/agents/ba.md',
  '/.claude/agents/ba.md',
  '///.claude/agents/ba.md',
  '.\\.claude\\agents\\ba.md',
  // non-mirrored
  '.claude/settings.json',
  'tasks/x.md',
  'assets/agents/ba.md',
  'README.md',
  'src/index.js',
  '.claude/commands/foo.md',
  '.claude/skills/other/x.md',
  // bare subtree directory (no file remainder)
  '.claude/agents/',
  '.claude/agents',
  '.claude/skills/orchestrate/',
  '.claude/skills/orchestrate',
  // prefix-substring trap
  '.claude/agentsX/ba.md',
  '.claude/skills/orchestrateX/y.md',
  // empty string
  '',
  // traversal remainder (mapped verbatim, not canonicalized, by BOTH copies)
  '.claude/agents/../../../x.md',
  '.claude/agents/sub/../ba.md',
];

// --- Non-string junk: both copies must return null and never throw. ---------
const JUNK_INPUTS = [undefined, null, 123, {}, [], true, () => {}];

// ===========================================================================
// Scenario: Renderer and lib mirror maps agree
//   Given the renderer ASSETS_MIRRORED_SUBTREES/mirrorRelPath extracted headless
//     and the lib versions
//   When mirrorRelPath is applied to a representative path set
//   Then every path maps identically in both and the subtree arrays are deeply equal
// ===========================================================================

test('the subtree arrays are deeply equal across renderer and lib', () => {
  assert.deepEqual(
    renderer.ASSETS_MIRRORED_SUBTREES,
    lib.MIRRORED_SUBTREES,
    'renderer ASSETS_MIRRORED_SUBTREES must equal lib MIRRORED_SUBTREES byte-for-byte',
  );
  // And the shape is the expected two-subtree map (guards a same-edit-to-both drift).
  assert.deepEqual(renderer.ASSETS_MIRRORED_SUBTREES, [
    { from: '.claude/agents/', to: 'assets/agents/' },
    { from: '.claude/skills/orchestrate/', to: 'assets/skills/orchestrate/' },
  ]);
});

test('mirrorRelPath maps every representative string path identically', () => {
  for (const p of STRING_PATHS) {
    const r = renderer.mirrorRelPath(p);
    const l = lib.mirrorRelPath(p);
    assert.equal(
      r, l,
      `renderer and lib mirrorRelPath must agree for ${JSON.stringify(p)} `
        + `(renderer=${JSON.stringify(r)}, lib=${JSON.stringify(l)})`,
    );
  }
});

test('mirrorRelPath returns null for non-string junk in both copies, without throwing', () => {
  for (const junk of JUNK_INPUTS) {
    let r; let l;
    assert.doesNotThrow(() => { r = renderer.mirrorRelPath(junk); });
    assert.doesNotThrow(() => { l = lib.mirrorRelPath(junk); });
    assert.equal(r, null, `renderer mirrorRelPath(${String(junk)}) is null`);
    assert.equal(l, null, `lib mirrorRelPath(${String(junk)}) is null`);
    assert.equal(r, l, 'renderer and lib agree on junk input');
  }
});
