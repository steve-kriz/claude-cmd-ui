'use strict';

// ===========================================================================
// TASK-129 — e2e "cucumber" scenarios (Given/When/Then) as plain `node --test`
// cases. NO cucumber npm package is installed or required.
//
// Feature: the read-side + residual-write fs IPC handlers are confined to
// approved project roots (mirrors TASK-126, which did the four mutating ones).
//
// main.js's handlers are Electron-coupled and NOT requireable in isolation
// (top-level electron require + app.whenReady side effects), so — following the
// repo convention established by TASK-126 (test/task-126-fs-roots.e2e.test.js) —
// each handler is exercised through a small HARNESS that replays the SHIPPED
// handler body: it runs the SHIPPED pure guard fsRoots.isPathAllowed over a
// seeded in-memory registry, in the SAME order the real handler does, and
// records every would-be fs op into an in-memory `ops` so scenarios can assert
// "nothing was read/written". The companion DRIFT-GUARD tests in
// task-129-readside-confinement.test.js pin that the real main.js handlers
// invoke isPathAllowed on the right argument BEFORE their first fs op, so this
// harness cannot silently diverge from shipped wiring.
//
// NO DATABASE / DISK / NETWORK / ELECTRON. resolve/realpath are injected and
// every fs op is a recorded no-op — no real DB connections, no disk access.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const fsRoots = require('../lib/fs-roots.js');

// Mirrors main.js's OUTSIDE_ROOT_ERROR / channel {ok:false,error} shape.
const OUTSIDE = 'Path is outside the approved project root';

const win32resolve = (...segs) => path.win32.resolve(...segs);
const idRealpath = async (p) => p;

// path.join under win32 semantics so the replayed history/skill targets look
// exactly like main.js's (which uses the host path.join; this host is win32).
const wjoin = path.win32.join;

// -------------------------------------------------------------------------
// Handler harness: replays each TASK-129 handler's guard + {ok,error} shape,
// recording every would-be fs op. The guard is the SHIPPED fsRoots.isPathAllowed.
// -------------------------------------------------------------------------
function makeHandlers({ roots, realpath = idRealpath, platform = 'win32', disk = {} }) {
  // Recorded operations — any push here means "touched the filesystem".
  const ops = { stats: [], readdirs: [], readFiles: [], mkdirs: [], writeFiles: [] };
  const opts = { roots, platform, resolve: win32resolve, realpath };
  const allowed = (p) => fsRoots.isPathAllowed(p, opts);

  return {
    ops,

    // fs:readFile — gate filePath BEFORE fsp.stat.
    async readFile(filePath) {
      if (!(await allowed(filePath))) return { ok: false, error: OUTSIDE };
      ops.stats.push(filePath);            // fsp.stat
      ops.readFiles.push(filePath);        // fsp.readFile
      const content = (disk[filePath] != null) ? disk[filePath] : 'file contents';
      return { ok: true, content, size: content.length };
    },

    // fs:readDir — gate dir BEFORE fsp.readdir.
    async readDir(dir) {
      if (!(await allowed(dir))) return { ok: false, error: OUTSIDE };
      ops.readdirs.push(dir);
      return { ok: true, entries: [{ name: 'a.md', isDir: false }] };
    },

    // fs:findByExt — validate args, then gate root BEFORE the walk (fsp.readdir).
    async findByExt(root, ext) {
      if (!root) return { ok: false, error: 'root required' };
      const lowerExt = ('' + (ext || '')).toLowerCase();
      if (!lowerExt) return { ok: false, error: 'ext required' };
      if (!(await allowed(root))) return { ok: false, error: OUTSIDE };
      ops.readdirs.push(root);             // walk(root) -> fsp.readdir
      return { ok: true, files: [wjoin(root, 'x' + lowerExt)], dirs: [root.toLowerCase()] };
    },

    // fs:grep — validate root, then gate BEFORE the walk (fsp.readdir/readFile).
    async grep(root, query) {
      if (!root) return { ok: false, error: 'root required' };
      if (!(await allowed(root))) return { ok: false, error: OUTSIDE };
      const q = ('' + (query || '')).trim();
      if (!q) return { ok: true, results: [], truncated: false };
      ops.readdirs.push(root);
      ops.readFiles.push(wjoin(root, 'a.md'));
      return { ok: true, results: [], truncated: false };
    },

    // tasks:installSkill — gate projectPath BEFORE the first mkdir/writeFile.
    async installSkill(projectPath) {
      if (!projectPath || typeof projectPath !== 'string') return { ok: false, error: 'projectPath required' };
      if (!(await allowed(projectPath))) return { ok: false, error: OUTSIDE };
      const destDir = wjoin(projectPath, '.claude', 'skills', 'orchestrate');
      ops.mkdirs.push(destDir);
      ops.writeFiles.push(wjoin(destDir, 'SKILL.md'));
      ops.mkdirs.push(wjoin(projectPath, '.claude', 'agents'));
      ops.mkdirs.push(wjoin(projectPath, 'tasks'));
      return { ok: true };
    },

    // prompts:append — gate cwd BEFORE read/write of the cwd-relative history.
    async promptsAppend(cwd, entry) {
      if (!cwd) return { ok: false, error: 'cwd required' };
      if (!entry || typeof entry.prompt !== 'string') return { ok: false, error: 'entry.prompt required' };
      if (!(await allowed(cwd))) return { ok: false, error: OUTSIDE };
      ops.readFiles.push(wjoin(cwd, '.claude-logs', 'logs', 'prompt_history.json'));
      ops.writeFiles.push(wjoin(cwd, '.claude-logs', 'logs', 'prompt_history.json'));
      return { ok: true, count: 1 };
    },

    // prompts:write — gate cwd BEFORE writePromptHistory.
    async promptsWrite(cwd, entries) {
      if (!cwd) return { ok: false, error: 'cwd required' };
      if (!Array.isArray(entries)) return { ok: false, error: 'entries must be an array' };
      if (!(await allowed(cwd))) return { ok: false, error: OUTSIDE };
      ops.writeFiles.push(wjoin(cwd, '.claude-logs', 'logs', 'prompt_history.json'));
      return { ok: true, count: entries.length };
    },

    // prompts:clear — gate cwd BEFORE writePromptHistory([]).
    async promptsClear(cwd) {
      if (!cwd) return { ok: false, error: 'cwd required' };
      if (!(await allowed(cwd))) return { ok: false, error: OUTSIDE };
      ops.writeFiles.push(wjoin(cwd, '.claude-logs', 'logs', 'prompt_history.json'));
      return { ok: true };
    },

    // prompts:syncFromCloud — gate cwd BEFORE cloud fetch + write.
    async promptsSyncFromCloud(cwd, cloud = { isEnabled: () => true, fetchLogs: async () => ({ ok: true, entries: [] }) }) {
      if (!cwd) return { ok: false, error: 'cwd required' };
      if (!(await allowed(cwd))) return { ok: false, error: OUTSIDE };
      if (!cloud.isEnabled()) return { ok: false, error: 'cloud logs disabled' };
      const res = await cloud.fetchLogs(cwd);
      if (!res.ok) return res;
      ops.writeFiles.push(wjoin(cwd, '.claude-logs', 'logs', 'prompt_history.json'));
      return { ok: true, count: res.entries.length };
    },
  };
}

// Background: the user opened "C:\work\proj" via the native folder picker, so the
// root registry contains it.
function backgroundRoots() {
  return new Set(['C:\\work\\proj']);
}

// Assert the harness recorded ZERO filesystem operations.
function assertNoFsOps(h) {
  assert.deepEqual(h.ops.stats, [], 'no fsp.stat should have run');
  assert.deepEqual(h.ops.readdirs, [], 'no fsp.readdir should have run');
  assert.deepEqual(h.ops.readFiles, [], 'no fsp.readFile should have run');
  assert.deepEqual(h.ops.mkdirs, [], 'no fsp.mkdir should have run');
  assert.deepEqual(h.ops.writeFiles, [], 'no fsp.writeFile should have run');
}

// =========================================================================
// Scenario: Out-of-root READ is rejected before any disk touch
// =========================================================================
test('Scenario: fs:readFile of a secret outside the root is rejected, nothing read', async () => {
  // Given the root registry contains "C:\work\proj"
  const h = makeHandlers({ roots: backgroundRoots() });
  // When fs:readFile is invoked for C:\Users\victim\.ssh\id_rsa
  const res = await h.readFile('C:\\Users\\victim\\.ssh\\id_rsa');
  // Then it returns {ok:false, error:OUTSIDE} and no fs op ran (guard before stat)
  assert.deepEqual(res, { ok: false, error: OUTSIDE });
  assertNoFsOps(h);
});

test('Scenario: fs:readDir of a directory outside the root is rejected, nothing listed', async () => {
  const h = makeHandlers({ roots: backgroundRoots() });
  // When fs:readDir is invoked for C:\Windows\System32
  const res = await h.readDir('C:\\Windows\\System32');
  assert.deepEqual(res, { ok: false, error: OUTSIDE });
  assertNoFsOps(h);
});

test('Scenario: fs:findByExt with an out-of-root base is rejected, no walk', async () => {
  const h = makeHandlers({ roots: backgroundRoots() });
  // When fs:findByExt walks C:\Users\victim for .env files
  const res = await h.findByExt('C:\\Users\\victim', '.env');
  assert.deepEqual(res, { ok: false, error: OUTSIDE });
  assertNoFsOps(h);
});

test('Scenario: fs:grep with an out-of-root base is rejected, no walk/read', async () => {
  const h = makeHandlers({ roots: backgroundRoots() });
  // When fs:grep searches C:\Users\victim for "password"
  const res = await h.grep('C:\\Users\\victim', 'password');
  assert.deepEqual(res, { ok: false, error: OUTSIDE });
  assertNoFsOps(h);
});

// =========================================================================
// Scenario: Out-of-root installSkill is rejected AND performs no mutation
// =========================================================================
test('Scenario: tasks:installSkill with an out-of-root projectPath is rejected, zero fs mutation', async () => {
  const h = makeHandlers({ roots: backgroundRoots() });
  // When installSkill targets C:\Users\victim\Desktop (outside the root)
  const res = await h.installSkill('C:\\Users\\victim\\Desktop');
  // Then it returns {ok:false,error:OUTSIDE} and NO mkdir/writeFile happened
  assert.deepEqual(res, { ok: false, error: OUTSIDE });
  assert.deepEqual(h.ops.mkdirs, []);
  assert.deepEqual(h.ops.writeFiles, []);
  assertNoFsOps(h);
});

// =========================================================================
// Scenario: Out-of-root prompts:* are rejected AND write nothing
// =========================================================================
test('Scenario: prompts:append with an out-of-root cwd is rejected, writes nothing', async () => {
  const h = makeHandlers({ roots: backgroundRoots() });
  const res = await h.promptsAppend('C:\\Users\\victim', { prompt: 'hi' });
  assert.deepEqual(res, { ok: false, error: OUTSIDE });
  assertNoFsOps(h);
});

test('Scenario: prompts:write with an out-of-root cwd is rejected, writes nothing', async () => {
  const h = makeHandlers({ roots: backgroundRoots() });
  const res = await h.promptsWrite('C:\\Users\\victim', [{ prompt: 'x' }]);
  assert.deepEqual(res, { ok: false, error: OUTSIDE });
  assertNoFsOps(h);
});

test('Scenario: prompts:clear with an out-of-root cwd is rejected, writes nothing', async () => {
  const h = makeHandlers({ roots: backgroundRoots() });
  const res = await h.promptsClear('C:\\Users\\victim');
  assert.deepEqual(res, { ok: false, error: OUTSIDE });
  assertNoFsOps(h);
});

test('Scenario: prompts:syncFromCloud with an out-of-root cwd is rejected before fetch, writes nothing', async () => {
  let fetched = false;
  const cloud = { isEnabled: () => true, fetchLogs: async () => { fetched = true; return { ok: true, entries: [] }; } };
  const h = makeHandlers({ roots: backgroundRoots() });
  const res = await h.promptsSyncFromCloud('C:\\Users\\victim', cloud);
  assert.deepEqual(res, { ok: false, error: OUTSIDE });
  assert.equal(fetched, false, 'guard must run before the cloud fetch');
  assertNoFsOps(h);
});

// =========================================================================
// Scenario: In-root SUCCESS — critical no-regression guard (each handler works)
// =========================================================================
test('Scenario: in-root fs:readFile still reads the file (no regression)', async () => {
  const h = makeHandlers({ roots: backgroundRoots(), disk: { 'C:\\work\\proj\\README.md': '# hi' } });
  const res = await h.readFile('C:\\work\\proj\\README.md');
  assert.equal(res.ok, true);
  assert.equal(res.content, '# hi');
  assert.deepEqual(h.ops.readFiles, ['C:\\work\\proj\\README.md']);
});

test('Scenario: in-root fs:readDir still lists entries (no regression)', async () => {
  const h = makeHandlers({ roots: backgroundRoots() });
  const res = await h.readDir('C:\\work\\proj\\tasks');
  assert.equal(res.ok, true);
  assert.ok(Array.isArray(res.entries));
  assert.deepEqual(h.ops.readdirs, ['C:\\work\\proj\\tasks']);
});

test('Scenario: in-root fs:findByExt still walks and returns matches (no regression)', async () => {
  const h = makeHandlers({ roots: backgroundRoots() });
  const res = await h.findByExt('C:\\work\\proj', '.md');
  assert.equal(res.ok, true);
  assert.ok(res.files.length >= 1);
  assert.deepEqual(h.ops.readdirs, ['C:\\work\\proj']);
});

test('Scenario: in-root fs:grep still walks and searches (no regression)', async () => {
  const h = makeHandlers({ roots: backgroundRoots() });
  const res = await h.grep('C:\\work\\proj', 'TODO');
  assert.equal(res.ok, true);
  assert.deepEqual(h.ops.readdirs, ['C:\\work\\proj']);
});

test('Scenario: in-root tasks:installSkill still installs (no regression)', async () => {
  const h = makeHandlers({ roots: backgroundRoots() });
  // installSkill projectPath == the opened folder (a registered root).
  const res = await h.installSkill('C:\\work\\proj');
  assert.equal(res.ok, true);
  assert.ok(h.ops.mkdirs.length >= 1, 'skill install must mkdir under the project');
  assert.ok(h.ops.writeFiles.length >= 1, 'skill install must write files under the project');
  // Every mutation stayed under the project root.
  for (const p of [...h.ops.mkdirs, ...h.ops.writeFiles]) {
    assert.ok(p.toLowerCase().startsWith('c:\\work\\proj\\'), `mutation escaped root: ${p}`);
  }
});

test('Scenario: in-root prompts:append/write/clear/syncFromCloud still write the history (no regression)', async () => {
  const historyFile = wjoin('C:\\work\\proj', '.claude-logs', 'logs', 'prompt_history.json');

  const a = makeHandlers({ roots: backgroundRoots() });
  assert.deepEqual(await a.promptsAppend('C:\\work\\proj', { prompt: 'hi' }), { ok: true, count: 1 });
  assert.ok(a.ops.writeFiles.includes(historyFile));

  const w = makeHandlers({ roots: backgroundRoots() });
  assert.deepEqual(await w.promptsWrite('C:\\work\\proj', [{ prompt: 'x' }, { prompt: 'y' }]), { ok: true, count: 2 });
  assert.ok(w.ops.writeFiles.includes(historyFile));

  const c = makeHandlers({ roots: backgroundRoots() });
  assert.deepEqual(await c.promptsClear('C:\\work\\proj'), { ok: true });
  assert.ok(c.ops.writeFiles.includes(historyFile));

  const s = makeHandlers({ roots: backgroundRoots() });
  const cloud = { isEnabled: () => true, fetchLogs: async () => ({ ok: true, entries: [{ prompt: 'z' }] }) };
  assert.deepEqual(await s.promptsSyncFromCloud('C:\\work\\proj', cloud), { ok: true, count: 1 });
  assert.ok(s.ops.writeFiles.includes(historyFile));
});

// =========================================================================
// Scenario: No folder open (empty registry) — every gated handler rejects cleanly
// =========================================================================
test('Scenario: empty registry (no folder open) rejects every gated handler, never throws', async () => {
  const h = makeHandlers({ roots: new Set() });
  assert.deepEqual(await h.readFile('C:\\work\\proj\\README.md'), { ok: false, error: OUTSIDE });
  assert.deepEqual(await h.readDir('C:\\work\\proj\\tasks'), { ok: false, error: OUTSIDE });
  assert.deepEqual(await h.findByExt('C:\\work\\proj', '.md'), { ok: false, error: OUTSIDE });
  assert.deepEqual(await h.grep('C:\\work\\proj', 'x'), { ok: false, error: OUTSIDE });
  assert.deepEqual(await h.installSkill('C:\\work\\proj'), { ok: false, error: OUTSIDE });
  assert.deepEqual(await h.promptsAppend('C:\\work\\proj', { prompt: 'x' }), { ok: false, error: OUTSIDE });
  assert.deepEqual(await h.promptsWrite('C:\\work\\proj', []), { ok: false, error: OUTSIDE });
  assert.deepEqual(await h.promptsClear('C:\\work\\proj'), { ok: false, error: OUTSIDE });
  assert.deepEqual(await h.promptsSyncFromCloud('C:\\work\\proj'), { ok: false, error: OUTSIDE });
  assertNoFsOps(h);
});

// =========================================================================
// Scenario: Guard-before-fs ordering — a ..-traversal escape records zero ops
// =========================================================================
test('Scenario: ..-traversal escaping the walk base is rejected before any readdir', async () => {
  const h = makeHandlers({ roots: backgroundRoots() });
  const res = await h.findByExt('C:\\work\\proj\\..\\..\\Users\\victim', '.env');
  assert.deepEqual(res, { ok: false, error: OUTSIDE });
  assertNoFsOps(h);
});

test('Scenario: symlink-ancestor escape on a read path is rejected (injected realpath)', async () => {
  // Given "C:\work\proj\link" is a symlink to "C:\outside"
  const realpath = async (p) => {
    const low = String(p).toLowerCase();
    if (low === 'c:\\work\\proj\\link') return 'C:\\outside';
    const err = new Error('ENOENT'); err.code = 'ENOENT'; throw err;
  };
  const h = makeHandlers({ roots: backgroundRoots(), realpath });
  // When fs:readFile follows C:\work\proj\link\secret.txt (escapes to C:\outside)
  const res = await h.readFile('C:\\work\\proj\\link\\secret.txt');
  assert.deepEqual(res, { ok: false, error: OUTSIDE });
  assertNoFsOps(h);
});

// =========================================================================
// Scenario: Second opened folder is a valid root for reads too
// =========================================================================
test('Scenario: reads inside a second opened folder succeed; neither-root reads fail', async () => {
  const roots = backgroundRoots();
  roots.add('D:\\repos\\other');
  const h = makeHandlers({ roots });
  assert.equal((await h.readFile('D:\\repos\\other\\src\\a.js')).ok, true);
  assert.equal((await h.readDir('C:\\work\\proj')).ok, true);
  // A path inside NEITHER root still fails.
  assert.equal((await h.readFile('E:\\elsewhere\\z.md')).ok, false);
  // Prefix-collision sibling of a root is NOT inside it.
  assert.equal((await h.readFile('C:\\work\\proj2\\evil.md')).ok, false);
});
