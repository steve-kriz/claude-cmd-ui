'use strict';

// ===========================================================================
// TASK-126 — e2e "cucumber" scenarios (Given/When/Then), implemented as plain
// `node --test` cases. NO cucumber npm package is installed or required.
//
// Feature: fs IPC handlers are confined to approved project roots.
//
// main.js's four fs:* handlers (fs:writeFile / fs:rename / fs:mkdir / fs:exists)
// are Electron-coupled and NOT requireable in isolation (top-level electron
// require + app.whenReady side effects), so — following the repo convention (see
// test/task-036-keep-awake.e2e.test.js) — the handler guard is exercised through
// a small HARNESS that runs the SHIPPED pure guard fsRoots.isPathAllowed over a
// seeded in-memory registry, exactly as each real handler does before its fsp
// op. The companion drift-guard tests in task-126-fs-roots.test.js pin that the
// real main.js handlers invoke isPathAllowed before their fsp call, so this
// harness cannot silently diverge from shipped wiring.
//
// NO DATABASE / DISK / NETWORK / ELECTRON. All realpath/resolve are injected and
// every fs op is a recorded no-op — no real DB connections, no disk writes.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const fsRoots = require('../lib/fs-roots.js');

// Mirrors main.js's OUTSIDE_ROOT_ERROR / channel {ok:false,error} shape.
const OUTSIDE = 'Path is outside the approved project root';

// A win32-style resolver usable on any host (deterministic path collapsing).
const win32resolve = (...segs) => path.win32.resolve(...segs);

// A realpath that treats every path as already-existing/identity (no symlinks).
// The e2e never touches disk — this stands in for fsp.realpath.
const idRealpath = async (p) => p;

// -------------------------------------------------------------------------
// Handler harness: replays each real fs:* handler's guard + {ok:false,error}
// shape, recording every fs op into an in-memory `disk` so scenarios can assert
// "nothing was created". The guard is the SHIPPED fsRoots.isPathAllowed.
// -------------------------------------------------------------------------
function makeHandlers({ roots, realpath = idRealpath, platform = 'win32' }) {
  const disk = { writes: [], renames: [], mkdirs: [] };
  const opts = { roots, platform, resolve: win32resolve, realpath };
  const allowed = (p) => fsRoots.isPathAllowed(p, opts);
  return {
    disk,
    // fs:writeFile
    async writeFile(filePath, content) {
      if (typeof filePath !== 'string' || !filePath) return { ok: false, error: 'path required' };
      if (typeof content !== 'string') return { ok: false, error: 'content must be a string' };
      if (!(await allowed(filePath))) return { ok: false, error: OUTSIDE };
      disk.writes.push(filePath);
      return { ok: true, size: content.length };
    },
    // fs:rename — BOTH endpoints must be in-root; existing "Target already
    // exists" refusal still applies for in-root paths (existsFn injected).
    async rename(oldPath, newPath, existsFn = async () => false) {
      if (!oldPath || !newPath) return { ok: false, error: 'oldPath and newPath required' };
      if (!(await allowed(oldPath)) || !(await allowed(newPath))) return { ok: false, error: OUTSIDE };
      if (await existsFn(newPath)) return { ok: false, error: 'Target already exists' };
      disk.renames.push([oldPath, newPath]);
      return { ok: true };
    },
    // fs:mkdir
    async mkdir(dir) {
      if (typeof dir !== 'string' || !dir) return { ok: false, error: 'path required' };
      if (!(await allowed(dir))) return { ok: false, error: OUTSIDE };
      disk.mkdirs.push(dir);
      return { ok: true };
    },
    // fs:exists — out-of-root => {ok:false}; in-root => {ok:true, exists:...}.
    async exists(p, existsFn = async () => false) {
      if (!(await allowed(p))) return { ok: false, error: OUTSIDE };
      return { ok: true, exists: await existsFn(p) };
    },
  };
}

// A freshly seeded single-root registry for the Background, plus a helper to
// "open another folder via the picker" (extends the registry Set).
function backgroundRoots() {
  // Given the user opened "C:\work\proj" via the native folder picker
  // And the root registry contains "C:\work\proj"
  return new Set(['C:\\work\\proj']);
}

// -------------------------------------------------------------------------
// Scenario: Legitimate ticket write inside the root succeeds
// -------------------------------------------------------------------------
test('Scenario: legitimate ticket write inside the root succeeds', async () => {
  // Given the root registry contains "C:\work\proj"
  const h = makeHandlers({ roots: backgroundRoots() });
  // When fs:writeFile is invoked with an in-root ticket path
  const res = await h.writeFile('C:\\work\\proj\\tasks\\todo\\TASK-001-x.md', '# ticket');
  // Then it returns ok:true and the file "exists" under the project folder
  assert.equal(res.ok, true);
  assert.deepEqual(h.disk.writes, ['C:\\work\\proj\\tasks\\todo\\TASK-001-x.md']);
});

// -------------------------------------------------------------------------
// Scenario: Traversal escaping the root is rejected (failure path)
// -------------------------------------------------------------------------
test('Scenario: traversal escaping the root is rejected, no file created', async () => {
  const h = makeHandlers({ roots: backgroundRoots() });
  // When fs:writeFile is invoked with a ..-traversal escaping the root
  const res = await h.writeFile('C:\\work\\proj\\tasks\\..\\..\\..\\Users\\victim\\evil.txt', 'x');
  // Then it returns ok:false with an error and no file is created outside the root
  assert.equal(res.ok, false);
  assert.equal(res.error, OUTSIDE);
  assert.equal(h.disk.writes.length, 0);
});

// -------------------------------------------------------------------------
// Scenario: Rename with an out-of-root destination is rejected (both-path check)
// -------------------------------------------------------------------------
test('Scenario: rename with an out-of-root destination is rejected, source untouched', async () => {
  const h = makeHandlers({ roots: backgroundRoots() });
  // Given "C:\work\proj\tasks\todo\TASK-001-x.md" exists (in-root source)
  const res = await h.rename('C:\\work\\proj\\tasks\\todo\\TASK-001-x.md', 'C:\\other\\stolen.md');
  // Then it returns ok:false and the source is untouched (no rename recorded)
  assert.equal(res.ok, false);
  assert.equal(res.error, OUTSIDE);
  assert.equal(h.disk.renames.length, 0);
});

test('Scenario: rename with an out-of-root SOURCE is also rejected (both-path check)', async () => {
  const h = makeHandlers({ roots: backgroundRoots() });
  const res = await h.rename('C:\\other\\foreign.md', 'C:\\work\\proj\\tasks\\todo\\T.md');
  assert.equal(res.ok, false);
  assert.equal(h.disk.renames.length, 0);
});

test('Scenario: in-root rename between lanes still succeeds and honours Target-exists', async () => {
  const h = makeHandlers({ roots: backgroundRoots() });
  // Legit move todo -> doing
  const ok = await h.rename('C:\\work\\proj\\tasks\\todo\\T.md', 'C:\\work\\proj\\tasks\\doing\\T.md');
  assert.equal(ok.ok, true);
  assert.deepEqual(h.disk.renames, [['C:\\work\\proj\\tasks\\todo\\T.md', 'C:\\work\\proj\\tasks\\doing\\T.md']]);
  // Existing "Target already exists" refusal still works for in-root dest.
  const dup = await h.rename(
    'C:\\work\\proj\\tasks\\todo\\A.md', 'C:\\work\\proj\\tasks\\doing\\A.md',
    async () => true
  );
  assert.equal(dup.ok, false);
  assert.equal(dup.error, 'Target already exists');
});

// -------------------------------------------------------------------------
// Scenario: mkdir outside every root is rejected
// -------------------------------------------------------------------------
test('Scenario: mkdir outside every root is rejected, nothing created', async () => {
  const h = makeHandlers({ roots: backgroundRoots() });
  const res = await h.mkdir('C:\\Windows\\evil');
  assert.equal(res.ok, false);
  assert.equal(res.error, OUTSIDE);
  assert.equal(h.disk.mkdirs.length, 0);
});

test('Scenario: in-root mkdir succeeds', async () => {
  const h = makeHandlers({ roots: backgroundRoots() });
  const res = await h.mkdir('C:\\work\\proj\\tasks\\doing');
  assert.equal(res.ok, true);
  assert.deepEqual(h.disk.mkdirs, ['C:\\work\\proj\\tasks\\doing']);
});

// -------------------------------------------------------------------------
// Scenario: exists cannot probe outside the roots
// -------------------------------------------------------------------------
test('Scenario: fs:exists cannot probe outside the roots (no existence oracle)', async () => {
  const h = makeHandlers({ roots: backgroundRoots() });
  // Even if the target "exists" on disk, the guard rejects before any stat.
  const res = await h.exists('C:\\Users\\victim\\.ssh\\id_rsa', async () => true);
  // Then it returns ok:false and reveals no existence info.
  assert.equal(res.ok, false);
  assert.equal(res.error, OUTSIDE);
  assert.equal(res.exists, undefined);
});

test('Scenario: in-root fs:exists behaviour unchanged (ok:true, exists reported)', async () => {
  const h = makeHandlers({ roots: backgroundRoots() });
  const present = await h.exists('C:\\work\\proj\\tasks', async () => true);
  assert.deepEqual(present, { ok: true, exists: true });
  const absent = await h.exists('C:\\work\\proj\\nope', async () => false);
  assert.deepEqual(absent, { ok: true, exists: false });
});

// -------------------------------------------------------------------------
// Scenario: Windows case/separator quirks don't break legitimate writes
// -------------------------------------------------------------------------
test('Scenario: win32 case/separator quirks still allow a legit in-root write', async () => {
  const h = makeHandlers({ roots: backgroundRoots() });
  // Forward slashes + lowercase drive + mixed casing — all normalized in-root.
  const res = await h.writeFile('c:/WORK/Proj/tasks/team-config.json', '{}');
  assert.equal(res.ok, true);
  assert.equal(h.disk.writes.length, 1);
});

// -------------------------------------------------------------------------
// Scenario: No folder open means no filesystem access (edge)
// -------------------------------------------------------------------------
test('Scenario: empty registry (no folder open) rejects cleanly, never throws', async () => {
  const h = makeHandlers({ roots: new Set() });
  const mk = await h.mkdir('C:\\anything');
  assert.equal(mk.ok, false);
  assert.equal(mk.error, OUTSIDE);
  assert.equal(h.disk.mkdirs.length, 0);
  // And every other confined channel rejects too.
  assert.equal((await h.writeFile('C:\\anything\\x.md', 'x')).ok, false);
  assert.equal((await h.rename('C:\\a\\x', 'C:\\a\\y')).ok, false);
  assert.equal((await h.exists('C:\\a')).ok, false);
});

// -------------------------------------------------------------------------
// Scenario: Second opened folder is a valid root
// -------------------------------------------------------------------------
test('Scenario: second opened folder is a valid root; writes inside either succeed', async () => {
  const roots = backgroundRoots();
  // Given the user also opened "D:\repos\other" via the picker (registry extends)
  roots.add('D:\\repos\\other');
  const h = makeHandlers({ roots });
  assert.equal((await h.writeFile('D:\\repos\\other\\tasks\\todo\\T.md', 'x')).ok, true);
  assert.equal((await h.writeFile('C:\\work\\proj\\tasks\\todo\\U.md', 'x')).ok, true);
  // A path inside NEITHER root still fails.
  assert.equal((await h.writeFile('E:\\elsewhere\\z.md', 'x')).ok, false);
  // Prefix-collision sibling of a root is NOT inside it.
  assert.equal((await h.writeFile('C:\\work\\proj2\\evil.md', 'x')).ok, false);
});

// -------------------------------------------------------------------------
// Scenario: Symlinked escape inside the root is rejected (as feasible)
// -------------------------------------------------------------------------
test('Scenario: symlink escape inside the root is rejected (injected realpath)', async () => {
  // Given "C:\work\proj\link" is a symlink to "C:\outside"
  const realpath = async (p) => {
    const low = String(p).toLowerCase();
    if (low === 'c:\\work\\proj\\link') return 'C:\\outside';
    const err = new Error('ENOENT'); err.code = 'ENOENT'; throw err;
  };
  const h = makeHandlers({ roots: backgroundRoots(), realpath });
  // When fs:writeFile is invoked with "C:\work\proj\link\evil.txt"
  const res = await h.writeFile('C:\\work\\proj\\link\\evil.txt', 'x');
  // Then it returns ok:false with an error, nothing written.
  assert.equal(res.ok, false);
  assert.equal(res.error, OUTSIDE);
  assert.equal(h.disk.writes.length, 0);
});
