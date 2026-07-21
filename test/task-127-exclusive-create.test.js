'use strict';

// ===========================================================================
// TASK-127 — UNIT tests for the atomic exclusive-create ("wx") fix on the
// add-agent create path (review follow-up of TASK-035 / TASK-095).
//
// The fix threads an optional `exclusive` flag through three surfaces:
//   * main.js  fs:writeFile handler — when `exclusive` is truthy it writes with
//              flag:'wx' (OS-atomic no-overwrite); EEXIST is caught and returned
//              as the channel's {ok:false,error} shape (never a throw). The
//              TASK-126 fsRoots.isPathAllowed confinement guard STILL runs first.
//   * preload.js fs bridge — maps `opts.exclusive` to the invoke payload,
//              defaulting off (`!!(opts && opts.exclusive)`).
//   * renderer.js writeWithMirror / add-agent onCreate — opts forwarded to the
//              PRIMARY write only; mirror stays default-overwrite.
//
// The main.js fs:writeFile handler is Electron-coupled and NOT requireable in
// isolation (top-level electron require + app.whenReady side effects), so —
// following the repo convention (test/task-126-fs-roots.test.js) — the SHIPPED
// handler arrow-function is EXTRACTED from main.js source by paren/brace match
// and evaluated with INJECTED `fsp` (in-memory fake honouring wx semantics) and
// `fsRoots` (injectable guard). This exercises the real handler body — not a
// re-implementation — so it cannot silently diverge from shipped wiring. Source-
// scan DRIFT GUARDs additionally pin the branch/guard ordering.
//
// NO DATABASE / REAL DB CONNECTION / DISK / NETWORK / ELECTRON. Every fs op is
// an in-memory Map no-op; fsRoots is a stub. No real disk writes, no DB.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const mainSrc = fs.readFileSync(path.join(REPO, 'main.js'), 'utf8');
const preloadSrc = fs.readFileSync(path.join(REPO, 'preload.js'), 'utf8').replace(/\r\n/g, '\n');

// --------------------------------------------------------------------------
// Extract the SHIPPED `ipcMain.handle('<channel>', <arrow fn>)` callback text
// from main.js by brace-matching the arrow body, so we run the real handler.
// --------------------------------------------------------------------------
function extractHandlerFn(src, channel) {
  const marker = `ipcMain.handle('${channel}',`;
  const at = src.indexOf(marker);
  assert.notEqual(at, -1, `handler ${channel} found in main.js`);
  const asyncAt = src.indexOf('async', at);
  assert.notEqual(asyncAt, -1, `async callback for ${channel}`);
  let i = src.indexOf('{', src.indexOf('=>', asyncAt));
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) { i += 1; break; } }
  }
  return src.slice(asyncAt, i); // "async (_evt, {path, content, exclusive}) => { ... }"
}

const OUTSIDE = 'Path is outside the approved project root';

// Build a live copy of the REAL fs:writeFile handler with injected deps.
function loadWriteFileHandler(fsp, fsRoots) {
  const text = extractHandlerFn(mainSrc, 'fs:writeFile');
  // eslint-disable-next-line no-new-func
  const factory = new Function('fsp', 'fsRoots', 'OUTSIDE_ROOT_ERROR', 'return (' + text + ');');
  return factory(fsp, fsRoots, OUTSIDE);
}

// --------------------------------------------------------------------------
// In-memory fake fsp honouring the wx flag exactly like the OS: writeFile with
// flag:'wx' throws EEXIST if the path already exists; otherwise it overwrites.
// Records every call so tests can assert the flag actually threaded through and
// that "no write happened" on rejection.
// --------------------------------------------------------------------------
function makeFakeFsp(initial) {
  const disk = new Map(Object.entries(initial || {}));
  const calls = [];
  return {
    disk,
    calls,
    async writeFile(p, content, opts) {
      const flag = opts && typeof opts === 'object' ? opts.flag : undefined;
      calls.push({ p, content, opts });
      if (flag === 'wx' && disk.has(p)) {
        const err = new Error(`EEXIST: file already exists, open '${p}'`);
        err.code = 'EEXIST';
        throw err;
      }
      disk.set(p, content);
    },
    async stat(p) {
      if (!disk.has(p)) { const e = new Error(`ENOENT: no such file, stat '${p}'`); e.code = 'ENOENT'; throw e; }
      return { size: Buffer.byteLength(disk.get(p), 'utf8'), isFile: () => true };
    },
  };
}

// An fsRoots stub whose isPathAllowed verdict is fully controllable, recording
// whether it was consulted (to prove the guard runs before the write).
function makeFsRoots(allow) {
  const seen = [];
  return {
    seen,
    async isPathAllowed(p) { seen.push(p); return allow; },
  };
}

// ===========================================================================
// (1) fs:writeFile exclusive branch — wx refuses a pre-existing file, and does
//     NOT clobber its bytes.
// ===========================================================================
test('fs:writeFile exclusive:true against a PRE-EXISTING file returns {ok:false} EEXIST and does NOT clobber bytes', async () => {
  const target = 'C:\\proj\\.claude\\agents\\ba.md';
  const fsp = makeFakeFsp({ [target]: 'ORIGINAL BYTES\n' });
  const handler = loadWriteFileHandler(fsp, makeFsRoots(true));

  const res = await handler({}, { path: target, content: 'NEW CONTENT', exclusive: true });

  assert.equal(res.ok, false, 'exclusive create must refuse an existing file');
  assert.match(res.error, /EEXIST|already exists/i, 'error is EEXIST-derived');
  assert.equal(fsp.disk.get(target), 'ORIGINAL BYTES\n', 'existing bytes are NOT overwritten');
  // The write WAS attempted with wx (the OS made it atomic) — not silently skipped.
  assert.equal(fsp.calls.length, 1);
  assert.equal(fsp.calls[0].opts.flag, 'wx', 'exclusive path uses flag:wx');
});

// ===========================================================================
// (1b) fs:writeFile exclusive:true against a NON-EXISTENT path succeeds and
//      creates the file using flag:'wx'.
// ===========================================================================
test('fs:writeFile exclusive:true against a non-existent path succeeds and creates the file with flag:wx', async () => {
  const target = 'C:\\proj\\.claude\\agents\\orchestrate-docs.md';
  const fsp = makeFakeFsp({});
  const handler = loadWriteFileHandler(fsp, makeFsRoots(true));

  const res = await handler({}, { path: target, content: 'BODY', exclusive: true });

  assert.equal(res.ok, true, 'creating a fresh file succeeds');
  assert.equal(res.size, Buffer.byteLength('BODY', 'utf8'), 'size reported');
  assert.equal(fsp.disk.get(target), 'BODY', 'file created');
  assert.equal(fsp.calls[0].opts.flag, 'wx', 'wx flag used for exclusive create');
  assert.equal(fsp.calls[0].opts.encoding, 'utf8', 'utf8 encoding preserved');
});

// ===========================================================================
// (2) Default (non-exclusive) regression guard — WITHOUT the flag the write
//     still OVERWRITES an existing file, byte-for-byte the original behaviour
//     (protects editor save / ticket save / team-config / mirror / skill install).
// ===========================================================================
test('fs:writeFile WITHOUT exclusive still OVERWRITES an existing file (default-overwrite regression guard)', async () => {
  const target = 'C:\\proj\\tasks\\todo\\T.md';
  const fsp = makeFakeFsp({ [target]: 'OLD' });
  const handler = loadWriteFileHandler(fsp, makeFsRoots(true));

  const res = await handler({}, { path: target, content: 'REPLACED' });

  assert.equal(res.ok, true);
  assert.equal(fsp.disk.get(target), 'REPLACED', 'default write overwrites as before');
  // Default path must NOT pass flag:wx (it passes the legacy 'utf8' string).
  assert.notEqual(fsp.calls[0].opts && fsp.calls[0].opts.flag, 'wx', 'default write does not use wx');
  assert.equal(fsp.calls[0].opts, 'utf8', 'default write passes the legacy utf8 encoding string');
});

test('fs:writeFile with exclusive:false (falsy) also takes the default overwrite branch', async () => {
  const target = 'C:\\proj\\tasks\\todo\\U.md';
  const fsp = makeFakeFsp({ [target]: 'OLD' });
  const handler = loadWriteFileHandler(fsp, makeFsRoots(true));

  const res = await handler({}, { path: target, content: 'NEW', exclusive: false });

  assert.equal(res.ok, true);
  assert.equal(fsp.disk.get(target), 'NEW', 'exclusive:false overwrites');
  assert.equal(fsp.calls[0].opts, 'utf8');
});

// ===========================================================================
// (3) fs-roots guard intact — an out-of-root path is rejected with
//     OUTSIDE_ROOT_ERROR REGARDLESS of the exclusive flag, and the guard runs
//     BEFORE any write (no file touched).
// ===========================================================================
test('fs-roots guard rejects an out-of-root path with OUTSIDE_ROOT_ERROR when exclusive:true — no write', async () => {
  const target = 'C:\\Users\\victim\\.ssh\\id_rsa';
  const fsp = makeFakeFsp({});
  const roots = makeFsRoots(false); // isPathAllowed => false
  const handler = loadWriteFileHandler(fsp, roots);

  const res = await handler({}, { path: target, content: 'x', exclusive: true });

  assert.equal(res.ok, false);
  assert.equal(res.error, OUTSIDE, 'confinement error surfaced');
  assert.equal(fsp.calls.length, 0, 'guard ran BEFORE any write — nothing touched');
  assert.deepEqual(roots.seen, [target], 'the confinement guard was consulted');
});

test('fs-roots guard rejects an out-of-root path with OUTSIDE_ROOT_ERROR when exclusive is absent — no write', async () => {
  const target = 'C:\\Windows\\system32\\evil.dll';
  const fsp = makeFakeFsp({});
  const handler = loadWriteFileHandler(fsp, makeFsRoots(false));

  const res = await handler({}, { path: target, content: 'x' });

  assert.equal(res.ok, false);
  assert.equal(res.error, OUTSIDE);
  assert.equal(fsp.calls.length, 0, 'no write for a default-overwrite out-of-root path either');
});

// ===========================================================================
// (1c) EEXIST is CAUGHT and returned as {ok:false} — never thrown across IPC.
// ===========================================================================
test('fs:writeFile never throws across IPC on EEXIST — it returns {ok:false,error}', async () => {
  const target = 'C:\\proj\\.claude\\agents\\dup.md';
  const fsp = makeFakeFsp({ [target]: 'HERE' });
  const handler = loadWriteFileHandler(fsp, makeFsRoots(true));

  let threw = false;
  let res;
  try {
    res = await handler({}, { path: target, content: 'x', exclusive: true });
  } catch (_) {
    threw = true;
  }
  assert.equal(threw, false, 'handler resolves — does not reject/throw');
  assert.equal(res.ok, false);
  assert.match(res.error, /EEXIST/i);
});

// ===========================================================================
// (4) preload arg threading — source-level assertions on the shipped bridge.
//   absent opts => exclusive:false; {exclusive:true} => exclusive:true.
// ===========================================================================
test('preload fs.writeFile threads opts.exclusive into the invoke payload (defaults off)', () => {
  // The bridge maps opts to a boolean `exclusive` on the fs:writeFile payload.
  assert.match(
    preloadSrc,
    /writeFile:\s*\(filePath,\s*content,\s*opts\)\s*=>\s*ipcRenderer\.invoke\(\s*['"]fs:writeFile['"],\s*\{\s*path:\s*filePath,\s*content,\s*exclusive:\s*!!\(opts\s*&&\s*opts\.exclusive\)\s*\}\s*\)/,
    'preload writeFile forwards exclusive:!!(opts && opts.exclusive) — absent opts => false, {exclusive:true} => true'
  );
});

test('preload fs.writeFile bridge shape: absent opts yields false, {exclusive:true} yields true', () => {
  // Reconstruct the bridge over a recording fake ipcRenderer to verify the
  // computed boolean without touching Electron.
  const invokes = [];
  const ipcRenderer = { invoke: (ch, payload) => { invokes.push({ ch, payload }); return Promise.resolve({ ok: true }); } };
  const writeFile = (filePath, content, opts) =>
    ipcRenderer.invoke('fs:writeFile', { path: filePath, content, exclusive: !!(opts && opts.exclusive) });

  writeFile('C:\\a\\x.md', 'c');                       // absent opts
  writeFile('C:\\a\\y.md', 'c', {});                   // opts without exclusive
  writeFile('C:\\a\\z.md', 'c', { exclusive: true });  // opt-in

  assert.equal(invokes[0].payload.exclusive, false, 'absent opts => exclusive:false (default overwrite)');
  assert.equal(invokes[1].payload.exclusive, false, 'opts w/o exclusive => false');
  assert.equal(invokes[2].payload.exclusive, true, '{exclusive:true} => true');
});

// ===========================================================================
// (6) writeWithMirror forwards opts to the PRIMARY write ONLY; the mirror stays
//     default-overwrite. Source-scan pin (renderer.js is a browser script).
// ===========================================================================
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');

test('renderer writeWithMirror forwards opts to the primary write, mirror stays default-overwrite', () => {
  const start = rendererSrc.indexOf('async function writeWithMirror(');
  assert.notEqual(start, -1, 'writeWithMirror found');
  const body = rendererSrc.slice(start, start + 6000);
  // Signature gained `opts`.
  assert.match(body, /async function writeWithMirror\(tab,\s*absPath,\s*content,\s*opts\)/,
    'writeWithMirror takes opts');
  // PRIMARY write forwards opts.
  assert.match(body, /window\.api\.fs\.writeFile\(absPath,\s*content,\s*opts\)/,
    'primary write forwards opts');
  // MIRROR write does NOT pass opts (default overwrite of a generated copy).
  assert.match(body, /window\.api\.fs\.writeFile\(mirrorPath,\s*content\)\s*;/,
    'mirror write stays default-overwrite (no opts)');
});

test('renderer add-agent onCreate is the exclusive:true opt-in caller and maps EEXIST to the friendly message', () => {
  // onCreate passes { exclusive: true } to the primary agent-file write.
  assert.match(rendererSrc, /writeWithMirror\(tab,\s*targetPath,\s*content,\s*\{\s*exclusive:\s*true\s*\}\)/,
    'add-agent create opts into exclusive-create');
  // EEXIST / "already exists" is remapped to the no-overwrite message.
  assert.match(rendererSrc, /EEXIST\|already exists/i,
    'onCreate detects EEXIST/already-exists');
  assert.match(rendererSrc, /A file already exists at .*— not overwriting\./,
    'friendly no-overwrite message present');
});

// ===========================================================================
// DRIFT GUARDs — pin the shipped main.js wiring (never require('./main.js'):
// it boots Electron). Guard runs before the write; both branches present.
// ===========================================================================
test('DRIFT GUARD: fs:writeFile confinement guard runs BEFORE the wx/default write', () => {
  const body = extractHandlerFn(mainSrc, 'fs:writeFile');
  const guardAt = body.indexOf('fsRoots.isPathAllowed');
  const wxAt = body.indexOf("flag: 'wx'");
  const writeAt = body.indexOf('fsp.writeFile');
  assert.ok(guardAt !== -1, 'guard present');
  assert.ok(wxAt !== -1, 'exclusive wx branch present');
  assert.ok(writeAt !== -1, 'write present');
  assert.ok(guardAt < writeAt, 'isPathAllowed runs before fsp.writeFile');
});

test('DRIFT GUARD: fs:writeFile has both an exclusive (wx) branch and a default-overwrite branch', () => {
  const body = extractHandlerFn(mainSrc, 'fs:writeFile');
  assert.match(body, /if\s*\(\s*exclusive\s*\)/, 'branches on exclusive');
  assert.match(body, /fsp\.writeFile\(filePath,\s*content,\s*\{\s*encoding:\s*'utf8',\s*flag:\s*'wx'\s*\}\)/,
    'exclusive branch uses flag:wx');
  assert.match(body, /fsp\.writeFile\(filePath,\s*content,\s*'utf8'\)/,
    'default branch is the original utf8 overwrite');
});
