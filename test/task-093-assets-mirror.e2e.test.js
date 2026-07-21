'use strict';

// ===========================================================================
// TASK-093 — e2e cucumber-style (Given/When/Then) scenarios.
//
// Feature: Assets mirror auto-sync (Q6). Whenever the app writes a file under a
// project's `.claude/` that has a matching `assets/` mirror, it writes both
// copies byte-identically; projects without a mirror are untouched; a failed
// mirror write surfaces `mirrorError` while the primary write stands.
//
// The subject under test is the renderer helper `writeWithMirror`, a BROWSER
// script function (renderer/renderer.js, no module.exports). It is EXTRACTED
// headless (same convention as test/task-075-type-bar.e2e.test.js) together
// with its helpers (tasksJoin, relFromFolder, mirrorRelPath) and the
// ASSETS_MIRRORED_SUBTREES const, then evaluated with an INJECTED `window`.
//
// ALL filesystem access goes through a STUBBED `window.api.fs.{writeFile,
// exists}`. No real Electron / app runtime. The stub is backed by real TEMP
// directories so byte-identity of the written copies can be asserted on disk,
// and it can be told to fail specific paths to drive the failure scenario.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');

// --- Extract a named function declaration by brace-matching. ---------------
function extractFn(src, name) {
  let start = src.indexOf('function ' + name + '(');
  assert.ok(start !== -1, `function ${name} found in renderer.js`);
  // Preserve a leading `async ` modifier if present.
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
// `failWrites` is a Set of absolute paths whose writeFile returns {ok:false}.
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

// --- Given: a fresh temp project folder. -----------------------------------
function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task093-'));
  return root;
}
function writeSeed(root, relParts, content) {
  const abs = path.join(root, ...relParts);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}
function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ===========================================================================
// Scenario: Editing a mirrored agent file
//   Given a project with .claude/agents/ba.md and assets/agents/ba.md
//   When writeWithMirror writes new content to .claude/agents/ba.md
//   Then assets/agents/ba.md holds the identical bytes
// ===========================================================================
test('Scenario: editing a mirrored agent file writes identical bytes to the assets copy', async () => {
  // Given a project with both copies present.
  const root = makeProject();
  try {
    const primaryPath = writeSeed(root, ['.claude', 'agents', 'ba.md'], 'old primary');
    const mirrorPath = writeSeed(root, ['assets', 'agents', 'ba.md'], 'old mirror');
    const { window, calls } = makeWindow();
    const { writeWithMirror } = makeRenderer(window);

    // When writeWithMirror writes new content to .claude/agents/ba.md.
    const NEW = 'new agent body\nline two\n';
    const res = await writeWithMirror({ folder: root }, primaryPath, NEW);

    // Then the result reports a successful mirrored write.
    assert.equal(res.ok, true, 'primary write ok');
    assert.equal(res.mirrored, true, 'mirror was written');
    assert.equal(res.mirrorPath, path.join(root, 'assets', 'agents', 'ba.md'));
    // And both files hold the identical bytes.
    assert.equal(fs.readFileSync(primaryPath, 'utf8'), NEW, 'primary has new content');
    assert.equal(fs.readFileSync(mirrorPath, 'utf8'), NEW, 'mirror has new content');
    assert.ok(
      fs.readFileSync(primaryPath).equals(fs.readFileSync(mirrorPath)),
      'primary and mirror are byte-for-byte identical',
    );
    // And exactly two writes happened (primary + mirror).
    assert.equal(calls.writeFile.length, 2, 'primary + mirror written');
  } finally {
    cleanup(root);
  }
});

test('Scenario: editing a mirrored orchestrate SKILL file mirrors into assets/skills/orchestrate', async () => {
  const root = makeProject();
  try {
    const primaryPath = writeSeed(root, ['.claude', 'skills', 'orchestrate', 'SKILL.md'], 'old');
    const mirrorPath = writeSeed(root, ['assets', 'skills', 'orchestrate', 'SKILL.md'], 'old');
    const { window } = makeWindow();
    const { writeWithMirror } = makeRenderer(window);

    const NEW = '# SKILL\nupdated\n';
    const res = await writeWithMirror({ folder: root }, primaryPath, NEW);

    assert.equal(res.mirrored, true);
    assert.equal(res.mirrorPath, path.join(root, 'assets', 'skills', 'orchestrate', 'SKILL.md'));
    assert.ok(fs.readFileSync(primaryPath).equals(fs.readFileSync(mirrorPath)));
  } finally {
    cleanup(root);
  }
});

// ===========================================================================
// Scenario: Project without an assets mirror (edge)
//   Given a project with .claude/agents/ba.md and no assets directory
//   When writeWithMirror runs
//   Then only the .claude file is written and no assets file is created
// ===========================================================================
test('Scenario (edge): project without an assets mirror writes only the .claude file, never creates one', async () => {
  // Given a project with .claude/agents/ba.md and NO assets directory.
  const root = makeProject();
  try {
    const primaryPath = writeSeed(root, ['.claude', 'agents', 'ba.md'], 'old');
    const { window, calls } = makeWindow();
    const { writeWithMirror } = makeRenderer(window);

    // When writeWithMirror runs.
    const NEW = 'new content';
    const res = await writeWithMirror({ folder: root }, primaryPath, NEW);

    // Then the primary is written and no mirror was created.
    assert.equal(res.ok, true, 'primary write ok');
    assert.equal(res.mirrored, false, 'no mirror written');
    assert.equal(fs.readFileSync(primaryPath, 'utf8'), NEW, 'primary has new content');
    // And no assets file exists on disk.
    assert.equal(
      fs.existsSync(path.join(root, 'assets', 'agents', 'ba.md')),
      false,
      'assets mirror was NOT created',
    );
    assert.equal(fs.existsSync(path.join(root, 'assets')), false, 'no assets dir created');
    // And only ONE writeFile happened (the primary).
    assert.equal(calls.writeFile.length, 1, 'only the primary was written');
    // And the mirror path was checked but not written.
    assert.equal(calls.exists.length, 1, 'mirror existence was checked exactly once');
  } finally {
    cleanup(root);
  }
});

test('Scenario (edge): a file outside the mirrored subtrees is never mirrored', async () => {
  // Given a project with .claude/settings.json and an assets dir present.
  const root = makeProject();
  try {
    const primaryPath = writeSeed(root, ['.claude', 'settings.json'], '{}');
    writeSeed(root, ['assets', 'agents', 'ba.md'], 'mirror'); // assets dir exists
    const { window, calls } = makeWindow();
    const { writeWithMirror } = makeRenderer(window);

    // When writeWithMirror runs on the non-mirrored path.
    const res = await writeWithMirror({ folder: root }, primaryPath, '{"a":1}');

    // Then there is no mirror mapping, so no exists check and no mirror write.
    assert.equal(res.ok, true);
    assert.equal(res.mirrored, false, 'settings.json is not mirrored');
    assert.equal(calls.writeFile.length, 1, 'only the primary written');
    assert.equal(calls.exists.length, 0, 'no existence check for a non-mirrored path');
  } finally {
    cleanup(root);
  }
});

// ===========================================================================
// Scenario: Mirror write fails (failure)
//   Given the mirror path is unwritable
//   When writeWithMirror runs
//   Then the primary write succeeds and the result carries mirrorError
// ===========================================================================
test('Scenario (failure): mirror write fails -> primary stands and result carries mirrorError', async () => {
  // Given a project with both copies, but the mirror path is unwritable.
  const root = makeProject();
  try {
    const primaryPath = writeSeed(root, ['.claude', 'agents', 'ba.md'], 'old primary');
    const mirrorPath = writeSeed(root, ['assets', 'agents', 'ba.md'], 'old mirror');
    const failWrites = new Set([mirrorPath]);
    const { window, calls } = makeWindow(failWrites);
    const { writeWithMirror } = makeRenderer(window);

    // When writeWithMirror runs.
    const NEW = 'primary new content';
    const res = await writeWithMirror({ folder: root }, primaryPath, NEW);

    // Then the primary write stands and the result carries mirrorError.
    assert.equal(res.ok, false, 'overall result flags a problem');
    assert.equal(res.primaryOk, true, 'primary write succeeded');
    assert.equal(res.mirrorPath, mirrorPath, 'mirror path surfaced for the warning');
    assert.ok(res.mirrorError, 'mirrorError present for the UI drift warning');
    assert.match(String(res.mirrorError), /permission denied|EACCES/);
    // And the primary file on disk holds the new content (primary stands).
    assert.equal(fs.readFileSync(primaryPath, 'utf8'), NEW, 'primary was written');
    // And the mirror on disk was NOT overwritten (write failed).
    assert.equal(fs.readFileSync(mirrorPath, 'utf8'), 'old mirror', 'mirror unchanged');
    // And both writes were attempted (primary ok, mirror failed).
    assert.equal(calls.writeFile.length, 2, 'primary + attempted mirror write');
  } finally {
    cleanup(root);
  }
});

// ===========================================================================
// Scenario (failure/edge): primary write fails -> NO mirror write attempted.
// ===========================================================================
test('Scenario (failure): primary write fails -> returns primary error and no mirror write is attempted', async () => {
  // Given a project where BOTH copies exist but the primary path is unwritable.
  const root = makeProject();
  try {
    const primaryPath = writeSeed(root, ['.claude', 'agents', 'ba.md'], 'old primary');
    const mirrorPath = writeSeed(root, ['assets', 'agents', 'ba.md'], 'old mirror');
    const failWrites = new Set([primaryPath]);
    const { window, calls } = makeWindow(failWrites);
    const { writeWithMirror } = makeRenderer(window);

    // When writeWithMirror runs.
    const res = await writeWithMirror({ folder: root }, primaryPath, 'new content');

    // Then it returns the primary failure and never touches the mirror.
    assert.equal(res.ok, false, 'primary failure surfaced');
    assert.equal(res.error, 'EACCES: permission denied', 'primary error preserved');
    assert.equal(res.mirrored, undefined, 'no mirrored field on a primary failure');
    // And ONLY the primary write was attempted; no exists check, no mirror write.
    assert.equal(calls.writeFile.length, 1, 'only the primary write attempted');
    assert.equal(calls.exists.length, 0, 'mirror was not even checked');
    // And the mirror on disk is untouched.
    assert.equal(fs.readFileSync(mirrorPath, 'utf8'), 'old mirror', 'mirror untouched');
  } finally {
    cleanup(root);
  }
});
