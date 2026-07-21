'use strict';

// ===========================================================================
// TASK-114 F2 — e2e cucumber-style (Given/When/Then) scenarios.
//
// Feature: mirror path canonicalization + containment (security hardening) for
// the renderer's writeWithMirror. Before any mirror-side fs call the computed
// mirror path is LEXICALLY canonicalized (normalize `\`->`/`, resolve `.`/`..`
// via a segment stack; `..` underflow => escaped) and the mirror step runs ONLY
// when the canonical path is strictly inside `tab.folder` AND under its
// `assets/` subtree. Otherwise the mirror is skipped entirely — zero mirror-side
// exists/write calls — and the result is `{...primary, mirrored:false}`.
//
// The subject under test is the REAL renderer helper writeWithMirror, a browser
// script function (renderer/renderer.js, no module.exports). It is EXTRACTED
// headless (same convention as test/task-093-assets-mirror.e2e.test.js) with
// its helpers and the ASSETS_MIRRORED_SUBTREES const, evaluated with an INJECTED
// `window`. ALL filesystem access goes through a STUBBED window.api.fs
// {writeFile, exists}, backed by real TEMP directories so on-disk effects can be
// asserted. No real DB, no real Electron / app runtime.
//
// NOTE on the traversal scenarios: for an equal-depth prefix swap
// (`.claude/agents/` <-> `assets/agents/`) the caller's PRIMARY absPath and the
// (would-be) mirror path resolve to the SAME on-disk location once the OS
// resolves `..`. The caller legitimately performs the primary write there; the
// security guarantee under test is that the MIRROR step adds NOTHING. The
// load-bearing proof is therefore ZERO mirror-side fs calls (exists === 0 and
// exactly one writeFile — the primary), plus that no `assets/` mirror file/dir
// is ever created at the escape target. Both are asserted below.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');
const lib = require('../lib/assets-mirror.js');

// --- Extract a named function declaration by brace-matching. ----------------
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

function extractSubtreesConst(src) {
  const m = src.match(/const\s+ASSETS_MIRRORED_SUBTREES\s*=\s*\[[\s\S]*?\];/);
  assert.ok(m, 'ASSETS_MIRRORED_SUBTREES const found in renderer.js');
  return m[0];
}

// Load the REAL renderer helpers headless, with `window` injected as a param.
function loadRenderer() {
  const body = [
    extractSubtreesConst(rendererSrc),
    extractFn(rendererSrc, 'inferSep'),
    extractFn(rendererSrc, 'appendPath'),
    extractFn(rendererSrc, 'tasksJoin'),
    extractFn(rendererSrc, 'mirrorRelPath'),
    extractFn(rendererSrc, 'relFromFolder'),
    extractFn(rendererSrc, 'writeWithMirror'),
    'return { tasksJoin, mirrorRelPath, relFromFolder, writeWithMirror };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function('window', body);
}
const makeRenderer = loadRenderer();

// --- Stubbed window.api.fs backed by a real temp dir. ----------------------
function makeWindow(failWrites) {
  const calls = { writeFile: [], exists: [] };
  const window = {
    api: {
      fs: {
        async writeFile(absPath, content) {
          calls.writeFile.push({ absPath, content });
          if (failWrites && failWrites.has(absPath)) {
            return { ok: false, error: 'EACCES: permission denied' };
          }
          fs.mkdirSync(path.dirname(absPath), { recursive: true });
          fs.writeFileSync(absPath, content);
          return { ok: true, size: Buffer.byteLength(content) };
        },
        async exists(absPath) {
          calls.exists.push({ absPath });
          return { ok: true, exists: fs.existsSync(absPath) };
        },
      },
    },
  };
  return { window, calls };
}

// --- Given: a fresh temp project folder INSIDE a private parent. ------------
// The parent isolates the "escape target" (parent/evil.md) from other tests.
function makeProject() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'task114-'));
  const root = path.join(parent, 'proj');
  fs.mkdirSync(root, { recursive: true });
  return { parent, root };
}
function writeSeed(root, relParts, content) {
  const abs = path.join(root, ...relParts);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}
function cleanup(parent) {
  try { fs.rmSync(parent, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ===========================================================================
// Scenario: Renderer and lib mirror maps agree (drift guard, Gherkin #1).
//   The full cross-check lives in the unit file
//   (test/task-114-mirror-sync-guard.test.js); a compact agree-check is
//   repeated here so this Feature's first scenario is covered end-to-end too.
// ===========================================================================
test('Scenario: renderer and lib mirror maps agree over a representative set', () => {
  // Given the renderer mapping extracted headless and the lib mapping.
  const { window } = makeWindow();
  const { mirrorRelPath } = makeRenderer(window);
  // When mirrorRelPath is applied to a representative path set.
  const paths = [
    '.claude/agents/ba.md',
    '.claude/skills/orchestrate/SKILL.md',
    '.claude/agents/sub/deep.md',
    '.claude\\agents\\ba.md',
    '.claude/skills\\orchestrate/SKILL.md',
    './.claude/agents/ba.md',
    '/.claude/agents/ba.md',
    '.claude/settings.json',
    'tasks/x.md',
    'assets/agents/ba.md',
    '.claude/agents/',
    '.claude/agentsX/ba.md',
    '',
    '.claude/agents/../../../x.md',
  ];
  // Then every path maps identically in both.
  for (const p of paths) {
    assert.equal(mirrorRelPath(p), lib.mirrorRelPath(p), `agree for ${JSON.stringify(p)}`);
  }
  // And junk never throws and maps to null in both.
  for (const junk of [undefined, null, 123, {}, [], true]) {
    assert.equal(mirrorRelPath(junk), lib.mirrorRelPath(junk));
  }
});

// ===========================================================================
// Scenario: Mirror path traversing outside the project folder is never written.
//   Given a pre-seeded file at the traversal escape target outside the folder
//   And the primary path "<folder>/.claude/agents/../../../evil.md"
//   When writeWithMirror writes content to that primary path
//   Then the primary write happens and returns with mirrored=false
//   And no exists/write is issued for any mirror path; no assets mirror created.
// ===========================================================================
test('Scenario (failure): a mirror path escaping the folder is skipped with ZERO mirror-side fs calls', async () => {
  const { parent, root } = makeProject();
  try {
    // Given a pre-seeded sentinel at the traversal escape target outside the folder.
    const escapeTarget = path.resolve(root, '..', 'evil.md'); // == parent/evil.md
    fs.writeFileSync(escapeTarget, 'SEED-OUTSIDE');
    const { window, calls } = makeWindow();
    const { writeWithMirror } = makeRenderer(window);

    // And the crafted primary path (literal `..`, not pre-resolved by path.join).
    const primaryPath = root + '/.claude/agents/../../../evil.md';

    // When writeWithMirror writes content to that primary path.
    const NEW = 'attacker-controlled content';
    const res = await writeWithMirror({ folder: root }, primaryPath, NEW);

    // Then the primary write happened and the result reports mirrored=false.
    assert.equal(res.ok, true, 'primary write ok');
    assert.equal(res.mirrored, false, 'mirror skipped (canonical path escapes the folder)');

    // And ZERO mirror-side fs calls were issued (the security guarantee).
    assert.equal(calls.exists.length, 0, 'no exists check for any mirror path');
    assert.equal(calls.writeFile.length, 1, 'only the primary write was issued');
    assert.equal(calls.writeFile[0].absPath, primaryPath, 'the single write is the primary');

    // And no assets/ mirror file or dir was ever created (catches a clamp-style bug).
    assert.equal(fs.existsSync(path.join(root, 'assets')), false, 'no assets dir created');
  } finally {
    cleanup(parent);
  }
});

// ===========================================================================
// Scenario: Backslash-separator traversal is also caught (failure).
//   Given the primary path "<folder>\.claude\agents\..\..\..\evil.md"
//   When writeWithMirror runs
//   Then the mirror step is skipped with mirrored=false (zero mirror-side calls).
// ===========================================================================
test('Scenario (failure): backslash-separator traversal is caught and skipped', async () => {
  const { parent, root } = makeProject();
  try {
    const escapeTarget = path.resolve(root, '..', 'evil.md');
    fs.writeFileSync(escapeTarget, 'SEED-OUTSIDE');
    const { window, calls } = makeWindow();
    const { writeWithMirror } = makeRenderer(window);

    // Given a backslash-separated crafted primary path.
    const primaryPath = root + '\\.claude\\agents\\..\\..\\..\\evil.md';

    // When writeWithMirror runs.
    const res = await writeWithMirror({ folder: root }, primaryPath, 'evil');

    // Then the mirror step is skipped, mirrored=false, and no mirror fs call happens.
    assert.equal(res.ok, true, 'primary write ok');
    assert.equal(res.mirrored, false, 'backslash traversal caught -> mirror skipped');
    assert.equal(calls.exists.length, 0, 'no mirror exists check');
    assert.equal(calls.writeFile.length, 1, 'only the primary write');
    assert.equal(fs.existsSync(path.join(root, 'assets')), false, 'no assets dir created');
  } finally {
    cleanup(parent);
  }
});

// ===========================================================================
// Scenario: Mirror path inside folder but outside assets/ is skipped (failure).
//   Given the primary path "<folder>/.claude/agents/../../tasks/x.md"
//   When writeWithMirror runs
//   Then the result returns mirrored=false and <folder>/tasks/x.md is not
//   written by the mirror step.
// ===========================================================================
test('Scenario (failure): canonical path inside the folder but outside assets/ is skipped', async () => {
  const { parent, root } = makeProject();
  try {
    const { window, calls } = makeWindow();
    const { writeWithMirror } = makeRenderer(window);

    // Given a primary whose mirror mapping canonicalizes to <folder>/tasks/x.md.
    const primaryPath = root + '/.claude/agents/../../tasks/x.md';

    // When writeWithMirror runs.
    const res = await writeWithMirror({ folder: root }, primaryPath, 'body');

    // Then the mirror is skipped (canonical path is not under assets/).
    assert.equal(res.ok, true, 'primary write ok');
    assert.equal(res.mirrored, false, 'inside folder but outside assets/ -> skipped');
    // And the mirror step issued ZERO fs calls (it returns before exists()).
    assert.equal(calls.exists.length, 0, 'no mirror exists check');
    assert.equal(calls.writeFile.length, 1, 'only the primary write; mirror wrote nothing');
    // And no assets/ mirror was created.
    assert.equal(fs.existsSync(path.join(root, 'assets')), false, 'no assets dir created');
  } finally {
    cleanup(parent);
  }
});

// ===========================================================================
// Scenario: Benign dot segments canonicalize and still mirror.
//   Given .claude/agents/ba.md and an existing assets/agents/ba.md
//   When writeWithMirror writes to "<folder>/.claude/agents/sub/../ba.md"
//   Then the mirror write targets "<folder>/assets/agents/ba.md" and both
//   copies are byte-identical.
// ===========================================================================
test('Scenario: benign `..` canonicalizes to the mapped assets path and still mirrors', async () => {
  const { parent, root } = makeProject();
  try {
    // Given an existing mirror at assets/agents/ba.md (must pre-exist to be synced).
    const mirrorPath = writeSeed(root, ['assets', 'agents', 'ba.md'], 'old mirror');
    const { window, calls } = makeWindow();
    const { writeWithMirror } = makeRenderer(window);

    // And a benign primary path with a redundant `sub/..` segment.
    const primaryPath = root + '/.claude/agents/sub/../ba.md';
    const canonicalPrimary = path.join(root, '.claude', 'agents', 'ba.md');

    // When writeWithMirror writes new content.
    const NEW = 'new benign body\nline two\n';
    const res = await writeWithMirror({ folder: root }, primaryPath, NEW);

    // Then the mirror was written to the CANONICAL assets path (no `..`).
    assert.equal(res.mirrored, true, 'benign path still mirrors');
    assert.equal(res.mirrorPath, path.join(root, 'assets', 'agents', 'ba.md'), 'canonical mirror path');

    // And both copies are byte-identical.
    assert.equal(fs.readFileSync(mirrorPath, 'utf8'), NEW, 'mirror holds new content');
    assert.equal(fs.readFileSync(canonicalPrimary, 'utf8'), NEW, 'primary (canonicalized on disk) holds new content');
    assert.ok(
      fs.readFileSync(canonicalPrimary).equals(fs.readFileSync(mirrorPath)),
      'primary and mirror are byte-for-byte identical',
    );

    // And exactly one exists check + two writes (primary + mirror), all canonical.
    assert.equal(calls.exists.length, 1, 'mirror existence checked once');
    assert.equal(calls.exists[0].absPath, path.join(root, 'assets', 'agents', 'ba.md'), 'exists on canonical path');
    assert.equal(calls.writeFile.length, 2, 'primary + mirror written');
    assert.equal(
      calls.writeFile[1].absPath,
      path.join(root, 'assets', 'agents', 'ba.md'),
      'mirror write targets the single canonical path',
    );
  } finally {
    cleanup(parent);
  }
});

// ===========================================================================
// Scenario: Never-create-a-mirror contract still holds (regression).
//   Given .claude/agents/ba.md and no assets directory
//   When writeWithMirror runs
//   Then only the primary file is written, no assets file/dir created,
//   result mirrored=false.
// ===========================================================================
test('Scenario (regression): with a valid mapping but no existing mirror, none is created', async () => {
  const { parent, root } = makeProject();
  try {
    // Given a benign primary path and NO assets directory.
    const primaryPath = path.join(root, '.claude', 'agents', 'ba.md');
    const { window, calls } = makeWindow();
    const { writeWithMirror } = makeRenderer(window);

    // When writeWithMirror runs.
    const NEW = 'content';
    const res = await writeWithMirror({ folder: root }, primaryPath, NEW);

    // Then only the primary is written and no mirror was created.
    assert.equal(res.ok, true, 'primary write ok');
    assert.equal(res.mirrored, false, 'no mirror written (mirror did not pre-exist)');
    assert.equal(fs.readFileSync(primaryPath, 'utf8'), NEW, 'primary has new content');
    assert.equal(fs.existsSync(path.join(root, 'assets')), false, 'no assets dir created');
    // And the canonical mirror was checked once (exists) but never written.
    assert.equal(calls.exists.length, 1, 'canonical mirror existence checked once');
    assert.equal(calls.writeFile.length, 1, 'only the primary written');
  } finally {
    cleanup(parent);
  }
});

// ===========================================================================
// Scenario (regression): primary write fails -> NO mirror attempt at all.
// (TASK-093 contract preserved by the F2 change.)
// ===========================================================================
test('Scenario (failure/regression): primary write fails -> no mirror exists/write attempted', async () => {
  const { parent, root } = makeProject();
  try {
    const primaryPath = writeSeed(root, ['.claude', 'agents', 'ba.md'], 'old primary');
    writeSeed(root, ['assets', 'agents', 'ba.md'], 'old mirror');
    const failWrites = new Set([primaryPath]);
    const { window, calls } = makeWindow(failWrites);
    const { writeWithMirror } = makeRenderer(window);

    const res = await writeWithMirror({ folder: root }, primaryPath, 'new content');

    assert.equal(res.ok, false, 'primary failure surfaced');
    assert.equal(res.mirrored, undefined, 'no mirrored field on a primary failure');
    assert.equal(calls.writeFile.length, 1, 'only the primary write attempted');
    assert.equal(calls.exists.length, 0, 'mirror not even checked');
  } finally {
    cleanup(parent);
  }
});
