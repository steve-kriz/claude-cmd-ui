'use strict';

// ===========================================================================
// TASK-129 — UNIT tests. Review follow-up of TASK-126.
//
// TASK-126 confined the four mutating/probing fs:* handlers (writeFile / rename
// / mkdir / exists). TASK-129 extends the SAME lib/fs-roots.js isPathAllowed
// gate to the read-side + directory-walk handlers (fs:readFile, fs:readDir,
// fs:findByExt, fs:grep) and the residual write paths (tasks:installSkill's
// projectPath, prompts:append/write/clear/syncFromCloud's cwd history).
//
// Two halves, exactly like TASK-126:
//  1. Exercise the SHIPPED pure guard fsRoots.isPathAllowed for each gated
//     handler's scenarios (out-of-root reject / in-root allow / empty registry /
//     never-throws). NO disk / DB / network / Electron — resolve+realpath are
//     injected, so this is the real shipped guard over an in-memory registry.
//  2. SOURCE-SCAN DRIFT GUARD: never require('./main.js') (it boots Electron).
//     Read main.js text and pin that each TASK-129 handler invokes
//     fsRoots.isPathAllowed on the right argument BEFORE its first fs op, and
//     returns the shared OUTSIDE_ROOT_ERROR shape — so the e2e harness (which
//     replays the handler bodies) cannot silently diverge from shipped wiring.
//
// NO DATABASE / DISK / NETWORK / ELECTRON.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fsRoots = require('../lib/fs-roots.js');

// Deterministic win32-style resolver + identity realpath, usable on any host.
const win32resolve = (...segs) => path.win32.resolve(...segs);
const idRealpath = async (p) => p;

// The exact constant main.js returns on rejection (pinned by drift guard below).
const OUTSIDE = 'Path is outside the approved project root';

function optsFor(roots, realpath = idRealpath) {
  return { roots, platform: 'win32', resolve: win32resolve, realpath };
}

// --------------------------------------------------------------------------
// Part 1 — SHIPPED guard behaviour for every gated TASK-129 argument.
// (readFile filePath / readDir dir / findByExt root / grep root /
//  installSkill projectPath / prompts:* cwd all flow through this one guard.)
// --------------------------------------------------------------------------
const ROOT = 'C:\\work\\proj';

test('guard rejects an out-of-root read path (fs:readFile filePath — ~/.ssh)', async () => {
  const allowed = await fsRoots.isPathAllowed('C:\\Users\\victim\\.ssh\\id_rsa', optsFor(new Set([ROOT])));
  assert.equal(allowed, false);
});

test('guard rejects an out-of-root listing path (fs:readDir dir)', async () => {
  const allowed = await fsRoots.isPathAllowed('C:\\Windows\\System32', optsFor(new Set([ROOT])));
  assert.equal(allowed, false);
});

test('guard rejects an out-of-root walk base (fs:findByExt / fs:grep root)', async () => {
  const roots = new Set([ROOT]);
  assert.equal(await fsRoots.isPathAllowed('C:\\Users\\victim', optsFor(roots)), false);
  assert.equal(await fsRoots.isPathAllowed('D:\\secrets', optsFor(roots)), false);
});

test('guard rejects an out-of-root install target (tasks:installSkill projectPath)', async () => {
  const allowed = await fsRoots.isPathAllowed('C:\\Users\\victim\\Desktop', optsFor(new Set([ROOT])));
  assert.equal(allowed, false);
});

test('guard rejects an out-of-root prompts cwd (prompts:append/write/clear/syncFromCloud)', async () => {
  const allowed = await fsRoots.isPathAllowed('C:\\Users\\victim', optsFor(new Set([ROOT])));
  assert.equal(allowed, false);
});

test('guard ALLOWS the in-root read/list/walk/install/prompts paths (no regression)', async () => {
  const roots = new Set([ROOT]);
  // readFile / readDir / findByExt-grep base under the opened folder.
  assert.equal(await fsRoots.isPathAllowed('C:\\work\\proj\\src\\index.js', optsFor(roots)), true);
  assert.equal(await fsRoots.isPathAllowed('C:\\work\\proj\\tasks', optsFor(roots)), true);
  assert.equal(await fsRoots.isPathAllowed('C:\\work\\proj', optsFor(roots)), true);
  // installSkill projectPath == the opened folder (a registered root).
  assert.equal(await fsRoots.isPathAllowed('C:\\work\\proj', optsFor(roots)), true);
  // prompts cwd == the opened folder; the history file lives under it.
  assert.equal(await fsRoots.isPathAllowed('C:\\work\\proj', optsFor(roots)), true);
  assert.equal(
    await fsRoots.isPathAllowed('C:\\work\\proj\\.claude-logs\\logs\\prompt_history.json', optsFor(roots)),
    true
  );
});

test('guard rejects EVERY gated path when the registry is empty (no folder open)', async () => {
  const empty = optsFor(new Set());
  for (const p of [
    'C:\\work\\proj\\src\\index.js', // readFile
    'C:\\work\\proj\\tasks',         // readDir / findByExt / grep
    'C:\\work\\proj',                // installSkill / prompts cwd
  ]) {
    assert.equal(await fsRoots.isPathAllowed(p, empty), false);
  }
});

test('guard never throws even when realpath explodes (returns a boolean)', async () => {
  const boom = async () => { throw new Error('boom'); };
  const allowed = await fsRoots.isPathAllowed('C:\\work\\proj\\x', optsFor(new Set([ROOT]), boom));
  assert.equal(typeof allowed, 'boolean');
});

test('guard rejects a ..-traversal escaping the walk base (findByExt/grep root)', async () => {
  const allowed = await fsRoots.isPathAllowed(
    'C:\\work\\proj\\..\\..\\Users\\victim',
    optsFor(new Set([ROOT]))
  );
  assert.equal(allowed, false);
});

// --------------------------------------------------------------------------
// Part 2 — SOURCE-SCAN DRIFT GUARD over main.js (never require it: Electron).
// --------------------------------------------------------------------------
const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function handlerBody(channel) {
  const start = mainSrc.indexOf(`ipcMain.handle('${channel}'`);
  assert.notEqual(start, -1, `handler ${channel} not found in main.js`);
  const rest = mainSrc.slice(start + 1);
  const nextIdx = rest.indexOf('ipcMain.handle(');
  return nextIdx === -1 ? rest : rest.slice(0, nextIdx);
}

// Assert `fsRoots.isPathAllowed(<arg>)` appears and runs before the first fs op.
function assertGuardBefore(channel, argExpr, opNeedle) {
  const body = handlerBody(channel);
  const callNeedle = `fsRoots.isPathAllowed(${argExpr})`;
  const guardAt = body.indexOf(callNeedle);
  const opAt = body.indexOf(opNeedle);
  assert.ok(guardAt !== -1, `${channel} must call ${callNeedle}`);
  assert.ok(opAt !== -1, `${channel} must call ${opNeedle}`);
  assert.ok(guardAt < opAt, `${channel}: guard must run BEFORE ${opNeedle}`);
  // Rejection returns the shared OUTSIDE_ROOT_ERROR shape (never throws).
  assert.ok(body.includes('OUTSIDE_ROOT_ERROR'),
    `${channel} must return OUTSIDE_ROOT_ERROR on rejection`);
}

test('DRIFT GUARD: OUTSIDE_ROOT_ERROR constant is the exact message', () => {
  assert.match(mainSrc, /OUTSIDE_ROOT_ERROR\s*=\s*'Path is outside the approved project root'/);
});

test('DRIFT GUARD: fs:readFile gates filePath before fsp.stat', () => {
  assertGuardBefore('fs:readFile', 'filePath', 'fsp.stat');
});

test('DRIFT GUARD: fs:readDir gates dir before fsp.readdir', () => {
  assertGuardBefore('fs:readDir', 'dir', 'fsp.readdir');
});

test('DRIFT GUARD: fs:findByExt gates root before the walk (fsp.readdir)', () => {
  assertGuardBefore('fs:findByExt', 'root', 'fsp.readdir');
});

test('DRIFT GUARD: fs:grep gates root before the walk (fsp.readdir)', () => {
  assertGuardBefore('fs:grep', 'root', 'fsp.readdir');
});

test('DRIFT GUARD: tasks:installSkill gates projectPath before fsp.mkdir', () => {
  assertGuardBefore('tasks:installSkill', 'projectPath', 'fsp.mkdir');
});

test('DRIFT GUARD: prompts:append gates cwd before any history read/write', () => {
  // append reads history then writes; guard must precede readPromptHistory.
  assertGuardBefore('prompts:append', 'cwd', 'readPromptHistory');
});

test('DRIFT GUARD: prompts:write gates cwd before writePromptHistory', () => {
  assertGuardBefore('prompts:write', 'cwd', 'writePromptHistory');
});

test('DRIFT GUARD: prompts:clear gates cwd before writePromptHistory', () => {
  assertGuardBefore('prompts:clear', 'cwd', 'writePromptHistory');
});

test('DRIFT GUARD: prompts:syncFromCloud gates cwd before cloud fetch/write', () => {
  const body = handlerBody('prompts:syncFromCloud');
  const guardAt = body.indexOf('fsRoots.isPathAllowed(cwd)');
  const fetchAt = body.indexOf('cloudLogs.fetchLogs');
  const writeAt = body.indexOf('writePromptHistory');
  assert.ok(guardAt !== -1, 'prompts:syncFromCloud must call fsRoots.isPathAllowed(cwd)');
  assert.ok(fetchAt !== -1 && writeAt !== -1);
  assert.ok(guardAt < fetchAt, 'guard must run BEFORE cloudLogs.fetchLogs');
  assert.ok(guardAt < writeAt, 'guard must run BEFORE writePromptHistory');
  assert.ok(body.includes('OUTSIDE_ROOT_ERROR'));
});

test('DRIFT GUARD: call form matches TASK-126 fs:writeFile exactly (single-arg await)', () => {
  // TASK-126 baseline: `await fsRoots.isPathAllowed(filePath)` (single arg, no
  // options object). Every TASK-129 site must use the identical single-arg form.
  const wf = handlerBody('fs:writeFile');
  assert.ok(wf.includes('await fsRoots.isPathAllowed(filePath)'),
    'TASK-126 fs:writeFile baseline call form changed');
  for (const [channel, arg] of [
    ['fs:readFile', 'filePath'],
    ['fs:readDir', 'dir'],
    ['fs:findByExt', 'root'],
    ['fs:grep', 'root'],
    ['tasks:installSkill', 'projectPath'],
    ['prompts:append', 'cwd'],
    ['prompts:write', 'cwd'],
    ['prompts:clear', 'cwd'],
    ['prompts:syncFromCloud', 'cwd'],
  ]) {
    const body = handlerBody(channel);
    assert.ok(body.includes(`await fsRoots.isPathAllowed(${arg})`),
      `${channel} must call await fsRoots.isPathAllowed(${arg}) (single-arg form)`);
  }
});

test('DRIFT GUARD: TASK-126 handlers still gated (writeFile/rename/mkdir/exists unchanged)', () => {
  // Confirm no regression to the original four gates while adding the new ones.
  assert.ok(handlerBody('fs:writeFile').includes('fsRoots.isPathAllowed(filePath)'));
  assert.ok(handlerBody('fs:rename').includes('fsRoots.isPathAllowed(oldPath)'));
  assert.ok(handlerBody('fs:rename').includes('fsRoots.isPathAllowed(newPath)'));
  assert.ok(handlerBody('fs:mkdir').includes('fsRoots.isPathAllowed(dir)'));
  assert.ok(handlerBody('fs:exists').includes('fsRoots.isPathAllowed(p)'));
});

test('DOCUMENTED SCOPE BOUNDARY: prompts:read is intentionally left UN-gated (TASK-129 out-of-enumerated-scope)', () => {
  // The coder left prompts:read ungated (read-only, cwd-relative history) as
  // out-of-enumerated-scope. Pin the current documented state so any future
  // change is a deliberate decision, not silent drift. If a guard is later added
  // this flips — update the ticket scope then.
  const body = handlerBody('prompts:read');
  assert.ok(!body.includes('fsRoots.isPathAllowed'),
    'prompts:read is currently ungated by design; if this fails, scope changed');
});
