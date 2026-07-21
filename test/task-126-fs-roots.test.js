'use strict';

// ===========================================================================
// TASK-126 — UNIT tests for the Electron-free guard lib/fs-roots.js.
//
// Confine the main-process fs:* IPC handlers (fs:writeFile / fs:rename /
// fs:mkdir / fs:exists) to approved project roots. lib/fs-roots.js is the pure,
// injectable half: containment (isInsideRoot / isInsideRoots) is a platform-
// parameterised string test, and canonicalize takes injectable resolve/realpath
// so NO disk, network, DB or Electron is touched here. main.js only wires it in.
//
// NO DATABASE / DISK / NETWORK / ELECTRON. All realpath/resolve are injected.
// (One optional real-symlink case guards itself and skips on Windows EPERM.)
//
// Also contains the SOURCE-SCAN DRIFT GUARD pinning that main.js invokes
// fsRoots.isPathAllowed in each of the four handlers before its fsp op, and that
// the registry is seeded in whenReady() + extended in dialog:pickFolder.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fsRoots = require('../lib/fs-roots.js');

// A deterministic win32-style resolver usable on any host, so canonicalize's
// resolve step behaves identically regardless of where the test runs. The tail-
// rejoin inside canonicalize uses the host path.join; on this win32 host that is
// path.win32.join, keeping backslash paths consistent.
const win32resolve = (...segs) => path.win32.resolve(...segs);

// --------------------------------------------------------------------------
// isInsideRoot — pure containment (forced platform)
// --------------------------------------------------------------------------
test('isInsideRoot: exact match and nested child are inside (win32)', () => {
  const root = 'C:\\work\\proj';
  assert.equal(fsRoots.isInsideRoot(root, 'C:\\work\\proj', 'win32'), true);
  assert.equal(fsRoots.isInsideRoot(root, 'C:\\work\\proj\\tasks\\todo\\T.md', 'win32'), true);
});

test('isInsideRoot: win32 case-folding of drive letter and folder names', () => {
  const root = 'C:\\work\\Proj';
  assert.equal(fsRoots.isInsideRoot(root, 'c:\\WORK\\proj\\tasks\\team-config.json', 'win32'), true);
  // On a case-sensitive platform the same mismatch must NOT be inside.
  assert.equal(fsRoots.isInsideRoot(root, 'c:\\WORK\\proj\\tasks\\team-config.json', 'linux'), false);
});

test('isInsideRoot: prefix-collision root is NOT inside (proj2 vs proj)', () => {
  const root = 'C:\\work\\proj';
  assert.equal(fsRoots.isInsideRoot(root, 'C:\\work\\proj2', 'win32'), false);
  assert.equal(fsRoots.isInsideRoot(root, 'C:\\work\\proj2\\evil.txt', 'win32'), false);
});

test('isInsideRoot: posix separators and nesting (linux)', () => {
  const root = '/home/user/proj';
  assert.equal(fsRoots.isInsideRoot(root, '/home/user/proj', 'linux'), true);
  assert.equal(fsRoots.isInsideRoot(root, '/home/user/proj/sub/f.txt', 'linux'), true);
  assert.equal(fsRoots.isInsideRoot(root, '/home/user/project', 'linux'), false);
});

test('isInsideRoot: trailing-separator drive root handled unambiguously (win32)', () => {
  assert.equal(fsRoots.isInsideRoot('C:\\', 'C:\\anything\\x.txt', 'win32'), true);
  assert.equal(fsRoots.isInsideRoot('C:\\', 'D:\\anything', 'win32'), false);
});

// --------------------------------------------------------------------------
// isInsideRoots — multi-root, empty, junk
// --------------------------------------------------------------------------
test('isInsideRoots: multiple roots — inside either succeeds, inside neither fails', () => {
  const roots = new Set(['C:\\work\\proj', 'D:\\repos\\other']);
  assert.equal(fsRoots.isInsideRoots(roots, 'C:\\work\\proj\\a.md', 'win32'), true);
  assert.equal(fsRoots.isInsideRoots(roots, 'D:\\repos\\other\\b.md', 'win32'), true);
  assert.equal(fsRoots.isInsideRoots(roots, 'C:\\elsewhere\\c.md', 'win32'), false);
});

test('isInsideRoots: array form is accepted as well as Set', () => {
  const roots = ['C:\\work\\proj'];
  assert.equal(fsRoots.isInsideRoots(roots, 'C:\\work\\proj\\x', 'win32'), true);
});

test('isInsideRoots: empty roots rejects everything', () => {
  assert.equal(fsRoots.isInsideRoots(new Set(), 'C:\\work\\proj\\a', 'win32'), false);
  assert.equal(fsRoots.isInsideRoots([], 'C:\\work\\proj\\a', 'win32'), false);
});

test('isInsideRoots: junk / non-string candidate and junk roots reject cleanly', () => {
  const roots = new Set(['C:\\work\\proj']);
  assert.equal(fsRoots.isInsideRoots(roots, '', 'win32'), false);
  assert.equal(fsRoots.isInsideRoots(roots, null, 'win32'), false);
  assert.equal(fsRoots.isInsideRoots(roots, 42, 'win32'), false);
  assert.equal(fsRoots.isInsideRoots(null, 'C:\\work\\proj\\a', 'win32'), false);
  // Junk entries inside the root list are skipped, real ones still match.
  assert.equal(fsRoots.isInsideRoots(new Set([null, '', 'C:\\work\\proj']), 'C:\\work\\proj\\a', 'win32'), true);
});

// --------------------------------------------------------------------------
// canonicalize — injected resolve/realpath (no disk)
// --------------------------------------------------------------------------
test('canonicalize: `..` traversal is collapsed by resolve then compared out-of-root', async () => {
  // realpath identity => "everything exists"; resolve collapses the ..'s.
  const realpath = async (p) => p;
  const canon = await fsRoots.canonicalize(
    'C:\\work\\proj\\tasks\\..\\..\\..\\Users\\victim\\evil.txt',
    { resolve: win32resolve, realpath }
  );
  assert.equal(canon, 'C:\\Users\\victim\\evil.txt');
  assert.equal(fsRoots.isInsideRoots(new Set(['C:\\work\\proj']), canon, 'win32'), false);
});

test('canonicalize: in-root nonexistent tail (write/mkdir target) keeps the tail', async () => {
  // realpath resolves only the existing ancestor C:\work\proj (identity); the
  // not-yet-existing tail tasks\todo\NEW.md must be re-appended.
  const existing = 'C:\\work\\proj';
  const realpath = async (p) => {
    if (String(p).toLowerCase() === existing.toLowerCase()) return existing;
    const err = new Error('ENOENT'); err.code = 'ENOENT'; throw err;
  };
  const canon = await fsRoots.canonicalize(
    'C:\\work\\proj\\tasks\\todo\\NEW.md',
    { resolve: win32resolve, realpath }
  );
  assert.equal(canon, 'C:\\work\\proj\\tasks\\todo\\NEW.md');
  assert.equal(fsRoots.isInsideRoots(new Set([existing]), canon, 'win32'), true);
});

test('canonicalize: symlink-ancestor escape resolves outside the root', async () => {
  // C:\work\proj\link is a symlink to C:\outside; evil.txt underneath does not
  // exist yet. realpath of the link returns the escape target; the tail rejoins.
  const realpath = async (p) => {
    const low = String(p).toLowerCase();
    if (low === 'c:\\work\\proj\\link') return 'C:\\outside';
    const err = new Error('ENOENT'); err.code = 'ENOENT'; throw err;
  };
  const canon = await fsRoots.canonicalize(
    'C:\\work\\proj\\link\\evil.txt',
    { resolve: win32resolve, realpath }
  );
  assert.equal(canon, 'C:\\outside\\evil.txt');
  assert.equal(fsRoots.isInsideRoots(new Set(['C:\\work\\proj']), canon, 'win32'), false);
});

test('canonicalize: never throws even if realpath always fails', async () => {
  const realpath = async () => { throw new Error('boom'); };
  const canon = await fsRoots.canonicalize('C:\\work\\proj\\x.md', { resolve: win32resolve, realpath });
  // Falls back to the resolved string.
  assert.equal(canon, 'C:\\work\\proj\\x.md');
});

// --------------------------------------------------------------------------
// isPathAllowed — the guard main.js calls
// --------------------------------------------------------------------------
const idRealpath = async (p) => p; // identity: everything "exists" as-is

test('isPathAllowed: empty registry rejects', async () => {
  const allowed = await fsRoots.isPathAllowed('C:\\work\\proj\\a.md', {
    roots: new Set(), platform: 'win32', resolve: win32resolve, realpath: idRealpath,
  });
  assert.equal(allowed, false);
});

test('isPathAllowed: non-string / empty path rejects', async () => {
  const roots = new Set(['C:\\work\\proj']);
  assert.equal(await fsRoots.isPathAllowed('', { roots, platform: 'win32', resolve: win32resolve, realpath: idRealpath }), false);
  assert.equal(await fsRoots.isPathAllowed(null, { roots, platform: 'win32', resolve: win32resolve, realpath: idRealpath }), false);
  assert.equal(await fsRoots.isPathAllowed(undefined, { roots, platform: 'win32', resolve: win32resolve, realpath: idRealpath }), false);
  assert.equal(await fsRoots.isPathAllowed(123, { roots, platform: 'win32', resolve: win32resolve, realpath: idRealpath }), false);
});

test('isPathAllowed: in-root path allowed', async () => {
  const roots = new Set(['C:\\work\\proj']);
  const allowed = await fsRoots.isPathAllowed('C:\\work\\proj\\tasks\\todo\\T.md', {
    roots, platform: 'win32', resolve: win32resolve, realpath: idRealpath,
  });
  assert.equal(allowed, true);
});

test('isPathAllowed: out-of-root path rejected', async () => {
  const roots = new Set(['C:\\work\\proj']);
  const allowed = await fsRoots.isPathAllowed('C:\\Users\\victim\\.ssh\\id_rsa', {
    roots, platform: 'win32', resolve: win32resolve, realpath: idRealpath,
  });
  assert.equal(allowed, false);
});

test('isPathAllowed: never throws even when canonicalize/realpath explodes', async () => {
  const roots = new Set(['C:\\work\\proj']);
  const realpath = async () => { throw new Error('boom'); };
  // Should resolve (not reject) with a boolean.
  const allowed = await fsRoots.isPathAllowed('C:\\work\\proj\\x.md', {
    roots, platform: 'win32', resolve: win32resolve, realpath,
  });
  assert.equal(typeof allowed, 'boolean');
});

// --------------------------------------------------------------------------
// registry mutators — addRoot / seedRoots / clearRoots against the real Set
// --------------------------------------------------------------------------
test('addRoot / seedRoots / clearRoots manage the live projectRoots Set', async () => {
  fsRoots.clearRoots();
  assert.equal(fsRoots.projectRoots.size, 0);

  await fsRoots.addRoot('C:\\work\\proj', { resolve: win32resolve, realpath: idRealpath });
  assert.equal(fsRoots.projectRoots.size, 1);
  assert.ok(fsRoots.projectRoots.has('C:\\work\\proj'));

  // seedRoots tolerates {path,agent} objects AND legacy bare strings AND junk.
  await fsRoots.seedRoots(
    [{ path: 'D:\\repos\\other', agent: 'x' }, 'E:\\bare\\root', null, 42, {}],
    { resolve: win32resolve, realpath: idRealpath }
  );
  assert.ok(fsRoots.projectRoots.has('D:\\repos\\other'));
  assert.ok(fsRoots.projectRoots.has('E:\\bare\\root'));

  await fsRoots.addRoot('', { resolve: win32resolve, realpath: idRealpath });
  await fsRoots.addRoot(null, { resolve: win32resolve, realpath: idRealpath });

  fsRoots.clearRoots();
  assert.equal(fsRoots.projectRoots.size, 0);
});

test('seedRoots ignores non-array input', async () => {
  fsRoots.clearRoots();
  await fsRoots.seedRoots(undefined, { resolve: win32resolve, realpath: idRealpath });
  await fsRoots.seedRoots(null, { resolve: win32resolve, realpath: idRealpath });
  await fsRoots.seedRoots('nope', { resolve: win32resolve, realpath: idRealpath });
  assert.equal(fsRoots.projectRoots.size, 0);
});

// --------------------------------------------------------------------------
// OPTIONAL real-symlink case (skips on Windows EPERM / no symlink privilege)
// --------------------------------------------------------------------------
test('real symlink escape is rejected (skips if symlink unavailable)', async (t) => {
  let base;
  try {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'task126-'));
    const root = path.join(base, 'proj');
    const outside = path.join(base, 'outside');
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    const link = path.join(root, 'link');
    try {
      fs.symlinkSync(outside, link, 'dir');
    } catch (err) {
      t.skip('symlink not permitted on this host: ' + err.code);
      return;
    }
    const candidate = path.join(link, 'evil.txt'); // does not exist yet
    const canon = await fsRoots.canonicalize(candidate); // real fsp.realpath
    const realRoot = fs.realpathSync(root);
    assert.equal(fsRoots.isInsideRoots(new Set([realRoot]), canon, process.platform), false);
  } finally {
    if (base) { try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) {} }
  }
});

// --------------------------------------------------------------------------
// SOURCE-SCAN DRIFT GUARD — pin the main.js wiring (never require('./main.js'):
// it boots Electron). Read the source text and assert the guard is invoked.
// --------------------------------------------------------------------------
const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function handlerBody(channel) {
  // Grab from `ipcMain.handle('<channel>'` up to the next ipcMain.handle or EOF.
  const start = mainSrc.indexOf(`ipcMain.handle('${channel}'`);
  assert.notEqual(start, -1, `handler ${channel} not found in main.js`);
  const rest = mainSrc.slice(start + 1);
  const nextIdx = rest.indexOf('ipcMain.handle(');
  return nextIdx === -1 ? rest : rest.slice(0, nextIdx);
}

test('DRIFT GUARD: main.js requires lib/fs-roots', () => {
  assert.match(mainSrc, /require\(['"]\.\/lib\/fs-roots['"]\)/);
});

test('DRIFT GUARD: fs:writeFile invokes isPathAllowed before writeFile', () => {
  const body = handlerBody('fs:writeFile');
  const guardAt = body.indexOf('fsRoots.isPathAllowed');
  const opAt = body.indexOf('fsp.writeFile');
  assert.ok(guardAt !== -1, 'fs:writeFile must call fsRoots.isPathAllowed');
  assert.ok(opAt !== -1, 'fs:writeFile must call fsp.writeFile');
  assert.ok(guardAt < opAt, 'guard must run BEFORE fsp.writeFile');
});

test('DRIFT GUARD: fs:rename checks BOTH oldPath and newPath before rename/access', () => {
  const body = handlerBody('fs:rename');
  assert.ok(body.includes('fsRoots.isPathAllowed(oldPath)'), 'must guard oldPath');
  assert.ok(body.includes('fsRoots.isPathAllowed(newPath)'), 'must guard newPath');
  const guardAt = body.indexOf('fsRoots.isPathAllowed');
  const accessAt = body.indexOf('fsp.access');
  const renameAt = body.indexOf('fsp.rename');
  assert.ok(guardAt !== -1 && renameAt !== -1);
  // Guard runs before the "Target already exists" access check AND the rename.
  assert.ok(guardAt < accessAt, 'guard must precede the existing-target access check');
  assert.ok(guardAt < renameAt, 'guard must precede fsp.rename');
});

test('DRIFT GUARD: fs:mkdir invokes isPathAllowed before mkdir', () => {
  const body = handlerBody('fs:mkdir');
  const guardAt = body.indexOf('fsRoots.isPathAllowed');
  const opAt = body.indexOf('fsp.mkdir');
  assert.ok(guardAt !== -1 && opAt !== -1);
  assert.ok(guardAt < opAt, 'guard must run BEFORE fsp.mkdir');
});

test('DRIFT GUARD: fs:exists invokes isPathAllowed before stat', () => {
  const body = handlerBody('fs:exists');
  const guardAt = body.indexOf('fsRoots.isPathAllowed');
  const opAt = body.indexOf('fsp.stat');
  assert.ok(guardAt !== -1 && opAt !== -1);
  assert.ok(guardAt < opAt, 'guard must run BEFORE fsp.stat');
});

test('DRIFT GUARD: registry seeded in whenReady and extended in dialog:pickFolder', () => {
  // Seed: whenReady body reads session and seeds roots.
  const whenReadyAt = mainSrc.indexOf('app.whenReady()');
  assert.notEqual(whenReadyAt, -1);
  const seedAt = mainSrc.indexOf('fsRoots.seedRoots');
  assert.ok(seedAt !== -1, 'must seed roots at startup');
  assert.ok(seedAt > whenReadyAt, 'seedRoots must live inside the whenReady flow');

  // Extend: dialog:pickFolder body adds the picked folder as a root.
  const pickBody = handlerBody('dialog:pickFolder');
  assert.ok(pickBody.includes('fsRoots.addRoot'), 'dialog:pickFolder must extend the registry');

  // session:save must NOT mint roots (compromised renderer guard).
  const saveBody = handlerBody('session:save');
  assert.ok(!saveBody.includes('fsRoots.addRoot') && !saveBody.includes('fsRoots.seedRoots'),
    'session:save must NOT register roots live');
});
