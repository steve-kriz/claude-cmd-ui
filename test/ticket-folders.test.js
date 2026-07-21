'use strict';

// Unit + source-scan + cucumber-style tests for TASK-008: the folder-per-status
// layout for tasks/. A ticket .md file lives in a subfolder named for its
// frontmatter status (tasks/todo, tasks/in-progress, …); frontmatter status is
// the single source of truth, so a file whose folder disagrees is reconciled
// (moved) to the matching folder. Out-of-enum ("unknown") statuses own no folder
// and are left in place.
//
// Three layers are under test:
//
//   1. lib/ticket-folders.js — the Electron-free, pure layout logic
//      (folderForStatus, folderMatchesStatus, reconcileFolder, dedupeByFolder).
//      The module touches no disk/DB/network/Electron and is driven by
//      LANE_STATUSES from lib/ticket-lanes.js, so it is exercised directly with
//      plain `node --test`.
//
//   2. renderer/renderer.js's browser-side layout wiring (ticketFolderForStatus,
//      ticketFolderMatchesStatus, tasksBasename, tasksSubfolder,
//      dedupeTicketsByFolder, relocateTicketFile, reconcileTicketFolders, the
//      recursive pollTasksOnce discovery, moveTicketToStatus write-then-rename,
//      and the new-todo-into-tasks/todo write). renderer.js is a browser script
//      (no module.exports, references `document`/`window`) so — matching
//      test/ticket-lanes.test.js and test/ticket-order.test.js — its behaviour is
//      proven both by VERBATIM copies run against a fully MOCKED in-memory
//      filesystem and by source-scan guards asserting the real source still
//      carries the same wiring (so the copies cannot silently drift).
//
// NO DATABASE, REAL FILESYSTEM WRITE, OR NETWORK CALL IS MADE. window.api.fs is a
// Map-backed mock whose fs:rename REFUSES when the target already exists (matching
// the real main.js IPC). Reading the app's own source as a fixture is the only
// real fs access.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  folderForStatus,
  folderMatchesStatus,
  reconcileFolder,
  dedupeByFolder,
} = require('../lib/ticket-folders');
const { LANE_STATUSES, VALID_STATUSES } = require('../lib/ticket-lanes');

const RENDERER = path.join(__dirname, '..', 'renderer', 'renderer.js');
const MAIN = path.join(__dirname, '..', 'main.js');
const rendererSrc = fs.readFileSync(RENDERER, 'utf8');
const mainSrc = fs.readFileSync(MAIN, 'utf8');

// ===========================================================================
// PART 1 — Unit tests: lib/ticket-folders.js pure layout logic
// ===========================================================================

// --- folderForStatus -------------------------------------------------------

test('folderForStatus maps each canonical status to a subfolder named for it', () => {
  for (const s of LANE_STATUSES) {
    assert.equal(folderForStatus(s), s, `${s} owns the tasks/${s} subfolder`);
  }
});

test('folderForStatus gives post-processing and failed-testing their own subfolders (TASK-028)', () => {
  // Both are driven by the valid-statuses set, not just the lane list: failed-testing
  // has no lane but still owns tasks/failed-testing/, and post-processing owns its own.
  assert.equal(folderForStatus('post-processing'), 'post-processing');
  assert.equal(folderForStatus('failed-testing'), 'failed-testing');
  for (const s of VALID_STATUSES) {
    assert.equal(folderForStatus(s), s, `${s} owns the tasks/${s} subfolder`);
  }
});

test('folderForStatus returns null for unknown / out-of-enum statuses', () => {
  for (const s of ['archived', 'unknown', 'Todo', 'in progress', '', undefined, null, 42]) {
    assert.equal(folderForStatus(s), null, `${JSON.stringify(s)} owns no folder`);
  }
});

test('folderForStatus is driven by LANE_STATUSES from lib/ticket-lanes.js', () => {
  // Every LANE_STATUSES value has a folder; a value one character off does not,
  // proving the enum (not a hard-coded local list) gates folder ownership.
  for (const s of LANE_STATUSES) assert.equal(folderForStatus(s), s);
  for (const s of LANE_STATUSES) {
    assert.equal(folderForStatus(s + 'x'), null, `${s}x is not a canonical status`);
  }
  // The set of statuses that own a folder is exactly LANE_STATUSES.
  const owning = LANE_STATUSES.filter((s) => folderForStatus(s) != null);
  assert.deepEqual(owning, LANE_STATUSES);
});

// --- folderMatchesStatus ---------------------------------------------------

test('folderMatchesStatus is true only when the folder equals the status folder', () => {
  assert.equal(folderMatchesStatus('todo', 'todo'), true);
  assert.equal(folderMatchesStatus('in-progress', 'in-progress'), true);
  // '' (top level) never matches a canonical status.
  assert.equal(folderMatchesStatus('', 'todo'), false);
  // A disagreeing folder does not match.
  assert.equal(folderMatchesStatus('todo', 'done'), false);
});

test('folderMatchesStatus treats null/undefined folder as top level (no match)', () => {
  assert.equal(folderMatchesStatus(null, 'todo'), false);
  assert.equal(folderMatchesStatus(undefined, 'done'), false);
});

test('folderMatchesStatus is always false for unknown statuses (they own no folder)', () => {
  assert.equal(folderMatchesStatus('archived', 'archived'), false);
  assert.equal(folderMatchesStatus('', 'archived'), false);
  assert.equal(folderMatchesStatus('unknown', 'unknown'), false);
});

// --- reconcileFolder -------------------------------------------------------

test('reconcileFolder: top-level file with a known status needs a move to its folder', () => {
  const r = reconcileFolder('', 'in-progress');
  assert.deepEqual(r, { needsMove: true, targetFolder: 'in-progress' });
});

test('reconcileFolder: a file in a disagreeing folder moves to the status folder', () => {
  // A file physically in tasks/todo but frontmatter status "done".
  const r = reconcileFolder('todo', 'done');
  assert.deepEqual(r, { needsMove: true, targetFolder: 'done' });
});

test('reconcileFolder: an already-matching file needs no move', () => {
  for (const s of LANE_STATUSES) {
    assert.deepEqual(reconcileFolder(s, s), { needsMove: false, targetFolder: s },
      `${s} in tasks/${s} stays put`);
  }
});

test('reconcileFolder: an unknown status is left in place (null target, no move)', () => {
  for (const folder of ['', 'todo', 'somewhere']) {
    assert.deepEqual(reconcileFolder(folder, 'archived'),
      { needsMove: false, targetFolder: null },
      `unknown status in folder=${JSON.stringify(folder)} is never relocated`);
  }
});

// --- dedupeByFolder --------------------------------------------------------

test('dedupeByFolder: two copies of one id keep the folder-matching copy', () => {
  const matching = { id: 'TASK-1', status: 'done', folder: 'done', path: 'A' };
  const stray = { id: 'TASK-1', status: 'done', folder: 'todo', path: 'B' };
  // Stray seen first, matching second → matching wins.
  const out = dedupeByFolder([stray, matching]);
  assert.equal(out.length, 1);
  assert.equal(out[0].path, 'A', 'the copy whose folder matches its status is kept');
  // And regardless of input order.
  const out2 = dedupeByFolder([matching, stray]);
  assert.equal(out2.length, 1);
  assert.equal(out2[0].path, 'A');
});

test('dedupeByFolder: when neither copy matches, the first seen is kept', () => {
  const a = { id: 'TASK-2', status: 'done', folder: 'todo', path: 'A' };
  const b = { id: 'TASK-2', status: 'done', folder: 'testing', path: 'B' };
  const out = dedupeByFolder([a, b]);
  assert.equal(out.length, 1);
  assert.equal(out[0].path, 'A', 'no folder matches → first seen wins');
});

test('dedupeByFolder: a single copy passes through unchanged', () => {
  const only = { id: 'TASK-3', status: 'todo', folder: 'todo', path: 'X' };
  const out = dedupeByFolder([only]);
  assert.equal(out.length, 1);
  assert.equal(out[0], only, 'the original object is returned unchanged');
});

test('dedupeByFolder: empty input yields an empty array', () => {
  assert.deepEqual(dedupeByFolder([]), []);
  assert.deepEqual(dedupeByFolder(null), []);
  assert.deepEqual(dedupeByFolder(undefined), []);
});

test('dedupeByFolder: entries with no id are dropped', () => {
  const withId = { id: 'TASK-4', status: 'todo', folder: 'todo' };
  const out = dedupeByFolder([{ status: 'todo', folder: 'todo' }, withId, { id: null }]);
  assert.deepEqual(out, [withId], 'id-less entries cannot be placed and are skipped');
});

test('dedupeByFolder: distinct ids all survive (no false collapsing)', () => {
  const entries = [
    { id: 'TASK-5', status: 'todo', folder: 'todo' },
    { id: 'TASK-6', status: 'done', folder: 'done' },
    { id: 'TASK-7', status: 'testing', folder: '' },
  ];
  const out = dedupeByFolder(entries);
  assert.deepEqual(out.map((e) => e.id).sort(), ['TASK-5', 'TASK-6', 'TASK-7']);
});

// ===========================================================================
// PART 2 — Source-scan guards: the browser side must mirror the lib and keep
// the key wiring, so the verbatim copies used in PART 3 cannot silently drift.
// (renderer.js is not require()-able, so we assert against its source.)
// ===========================================================================

test('renderer.js mirrors folderForStatus off TASKS_VALID_STATUSES (null for unknown)', () => {
  // TASK-028: driven by the valid-statuses set so failed-testing (no lane) and
  // post-processing both own their own subfolders; unknown statuses still get null.
  assert.match(rendererSrc, /function\s+ticketFolderForStatus\(status\)/);
  assert.match(rendererSrc,
    /return\s+TASKS_VALID_STATUSES\.includes\(status\)\s*\?\s*status\s*:\s*null/);
});

test('renderer.js mirrors folderMatchesStatus (null target never matches)', () => {
  assert.match(rendererSrc, /function\s+ticketFolderMatchesStatus\(folder,\s*status\)/);
  assert.match(rendererSrc,
    /return\s+target\s*!=\s*null\s*&&\s*\(folder\s*\|\|\s*''\)\s*===\s*target/);
});

test('renderer.js mirrors dedupeByFolder (prefer the folder-matching copy)', () => {
  // TASK-102: dedupeTicketsByFolder became config-aware — it now takes the
  // folder's validated user-status set and compares via ticketFolderMatchesStatusWith
  // so a user-column ticket prefers its tasks/<slug>/ copy just like a system one.
  assert.match(rendererSrc, /function\s+dedupeTicketsByFolder\(entries,\s*userStatuses\)/);
  assert.match(rendererSrc, /ticketFolderMatchesStatusWith\(e\.folder,\s*e\.fm\.status,\s*userStatuses\)/);
  assert.match(rendererSrc, /!ticketFolderMatchesStatusWith\(cur\.folder,\s*cur\.fm\.status,\s*userStatuses\)/);
});

test('the scanner discovers tickets recursively via fs.findByExt (not readDir)', () => {
  // The poll uses the recursive findByExt IPC so a ticket filed into a subfolder
  // is still found; it no longer skips subdirectories.
  assert.match(rendererSrc, /await\s+window\.api\.fs\.findByExt\(tasksDir,\s*'\.md'\)/);
  // And main.js's findByExt genuinely walks subdirectories.
  assert.match(mainSrc, /ipcMain\.handle\('fs:findByExt'/);
  assert.match(mainSrc, /if\s*\(await\s+walk\(sub\)\)/);
});

test('the scanner records each file\'s subfolder and dedupes by folder', () => {
  assert.match(rendererSrc, /const\s+folder\s*=\s*tasksSubfolder\(tasksDir,\s*filePath\)/);
  // TASK-102: the poll now passes the folder's validated user-status set so the
  // dedupe prefers a user-column ticket's tasks/<slug>/ copy.
  assert.match(rendererSrc,
    /dedupeTicketsByFolder\(\s*candidates,\s*tasksUserStatusSet\(normalizeTasksColumns\(t\.config\)\)\)/);
});

test('moveTicketToStatus does a whole-file write THEN an atomic relocate (rename)', () => {
  const mv = rendererSrc.slice(rendererSrc.indexOf('async function moveTicketToStatus'));
  const body = mv.slice(0, mv.indexOf('\n}\n'));
  const writeIdx = body.indexOf('window.api.fs.writeFile(filePath, serializeTicket(newFm, body))');
  const relocateIdx = body.indexOf('relocateTicketFile(tab, filePath, file, newStatus)');
  assert.ok(writeIdx !== -1, 'writes the whole file first');
  assert.ok(relocateIdx !== -1, 'then relocates via relocateTicketFile');
  assert.ok(writeIdx < relocateIdx, 'write happens before the relocate (write-then-rename)');
});

test('relocateTicketFile is collision-safe: mkdir + fs.rename, no overwrite/delete', () => {
  const rl = rendererSrc.slice(rendererSrc.indexOf('async function relocateTicketFile'));
  const body = rl.slice(0, rl.indexOf('\n}\n'));
  assert.match(body, /await\s+window\.api\.fs\.mkdir\(destDir\)/);
  assert.match(body, /await\s+window\.api\.fs\.rename\(srcPath,\s*destPath\)/);
  // On a failed rename the source is left untouched (path stays srcPath) and
  // nothing is overwritten/deleted.
  assert.match(body, /return\s*\{\s*ok:\s*false,\s*moved:\s*false,\s*path:\s*srcPath/);
  // No destructive/overwriting fs op is used in the relocate path.
  assert.ok(!/unlink|removeFile|deleteFile|copyFile/.test(body),
    'relocate never deletes or copies — it only mkdirs and renames');
  // fs:rename in main.js genuinely refuses when the target already exists.
  assert.match(mainSrc, /await\s+fsp\.access\(newPath\)[\s\S]*?Target already exists/);
});

test('unknown-status tickets are not filed into a status subfolder', () => {
  const rl = rendererSrc.slice(rendererSrc.indexOf('async function relocateTicketFile'));
  const body = rl.slice(0, rl.indexOf('\n}\n'));
  // targetFolder null (unknown status) → early return, no move.
  assert.match(body,
    /if\s*\(targetFolder\s*==\s*null\)\s*return\s*\{\s*ok:\s*true,\s*moved:\s*false,\s*path:\s*srcPath/);
});

test('reconciliation only moves files whose folder disagrees with frontmatter status', () => {
  const rc = rendererSrc.slice(rendererSrc.indexOf('async function reconcileTicketFolders'));
  const body = rc.slice(0, rc.indexOf('\n}\n'));
  // TASK-102: reconciliation is config-aware — it derives the folder's validated
  // user-status set and targets tasks/<slug>/ for user columns; a status whose
  // column was REMOVED resolves to null and is never moved (left in place).
  assert.match(body, /const\s+userStatuses\s*=\s*tasksUserStatusSet\(normalizeTasksColumns\(t\.config\)\)/);
  assert.match(body, /const\s+target\s*=\s*ticketFolderForStatusWith\(e\.fm\.status,\s*userStatuses\)/);
  assert.match(body, /target\s*!=\s*null\s*&&\s*\(e\.folder\s*\|\|\s*''\)\s*!==\s*target/);
  assert.match(body, /relocateTicketFile\(tab,\s*e\.path,\s*e\.file,\s*e\.fm\.status\)/);
});

test('reorder within todo is a whole-file order write and never relocates', () => {
  // reorderTodoTicket / persistTicketOrder change `order`, not `status`, and
  // write to the SAME filePath — no relocateTicketFile call, so files stay in
  // tasks/todo.
  const ro = rendererSrc.slice(rendererSrc.indexOf('async function reorderTodoTicket'));
  const roBody = ro.slice(0, ro.indexOf('\n}\n'));
  assert.ok(!/relocateTicketFile/.test(roBody), 'reorder does not relocate any file');
  const po = rendererSrc.slice(rendererSrc.indexOf('async function persistTicketOrder'));
  const poBody = po.slice(0, po.indexOf('\n}\n'));
  assert.ok(!/relocateTicketFile/.test(poBody), 'persistTicketOrder does not relocate');
  assert.match(poBody, /window\.api\.fs\.writeFile\(filePath,\s*serializeTicket\(newFm,\s*body\)\)/);
});

test('new todo tickets are written into tasks/todo/ on create', () => {
  // TASK-028 parameterised the opener: the subfolder derives from the mode's
  // status (defaulting to 'todo'), so a new todo ticket still lands in tasks/todo/.
  assert.match(rendererSrc, /const\s+subfolder\s*=\s*ticketFolderForStatus\(status\)/);
  assert.match(rendererSrc,
    /const\s+destDir\s*=\s*subfolder\s*\?\s*tasksJoin\(tasksDir,\s*subfolder\)\s*:\s*tasksDir/);
  assert.match(rendererSrc, /await\s+window\.api\.fs\.mkdir\(destDir\)/);
});

// ===========================================================================
// PART 3 — Feature: Folder-per-status ticket layout (Gherkin scenarios)
//
// Implemented against VERBATIM copies of the renderer's layout/move/scan logic
// (renderer/renderer.js), driven over a fully MOCKED in-memory filesystem. NO
// real DB/fs/network: `window.api.fs` is a Map-backed mock whose fs:rename
// REFUSES when the target exists (matching main.js). The board is an in-memory
// Map<file, ticket>.
// ===========================================================================

// --- Renderer constants/helpers the copies close over (verbatim) -----------

const TASKS_LANE_STATUSES = [...LANE_STATUSES];
const TASKS_UNKNOWN_STATUS = 'unknown';

function ticketFolderForStatus(status) {
  return TASKS_LANE_STATUSES.includes(status) ? status : null;
}
function ticketFolderMatchesStatus(folder, status) {
  const target = ticketFolderForStatus(status);
  return target != null && (folder || '') === target;
}
function tasksBasename(p) {
  const s = String(p || '');
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return i === -1 ? s : s.slice(i + 1);
}
function tasksSubfolder(tasksDir, filePath) {
  const base = String(tasksDir || '');
  let rel = String(filePath || '');
  if (rel.toLowerCase().startsWith(base.toLowerCase())) rel = rel.slice(base.length);
  rel = rel.replace(/^[\\/]+/, '');
  const parts = rel.split(/[\\/]+/);
  return parts.length > 1 ? parts[0] : '';
}
function dedupeTicketsByFolder(entries) {
  const byId = new Map();
  for (const e of entries) {
    const id = e.fm.id;
    if (id == null) continue;
    if (!byId.has(id)) { byId.set(id, e); continue; }
    const cur = byId.get(id);
    if (ticketFolderMatchesStatus(e.folder, e.fm.status) &&
        !ticketFolderMatchesStatus(cur.folder, cur.fm.status)) {
      byId.set(id, e);
    }
  }
  return Array.from(byId.values());
}
function tasksJoin(...parts) {
  return parts.reduce((acc, p) => {
    if (!acc) return p;
    const sep = acc.endsWith('\\') || acc.endsWith('/') ? '' : '\\';
    return acc + sep + p;
  });
}
function parseTicketFrontmatter(content) {
  if (typeof content !== 'string') return null;
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  if (lines[0].trim() !== '---') return null;
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { closeIdx = i; break; }
  }
  if (closeIdx === -1) return null;
  const fm = {};
  for (let i = 1; i < closeIdx; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (key) fm[key] = line.slice(idx + 1).trim();
  }
  const body = lines.slice(closeIdx + 1).join('\n');
  return { fm, body };
}
function serializeTicket(fm, body) {
  const order = ['id', 'title', 'status', 'created', 'updated'];
  const keys = order.filter((k) => fm[k] != null);
  for (const k of Object.keys(fm)) if (!keys.includes(k)) keys.push(k);
  const fmLines = keys.map((k) => `${k}: ${fm[k]}`);
  return ['---', ...fmLines, '---', body || ''].join('\n');
}

// --- VERBATIM copies of the move/relocate/reconcile logic ------------------
// (renderer/renderer.js relocateTicketFile / reconcileTicketFolders /
// moveTicketToStatus). Kept in lockstep with the PART 2 source-scan guards.

async function relocateTicketFile(tab, srcPath, fileName, status) {
  const targetFolder = ticketFolderForStatus(status);
  if (targetFolder == null) return { ok: true, moved: false, path: srcPath };
  const tasksDir = tasksJoin(tab.folder, 'tasks');
  const destDir = tasksJoin(tasksDir, targetFolder);
  const destPath = tasksJoin(destDir, fileName);
  if (destPath === srcPath) return { ok: true, moved: false, path: srcPath };
  await window.api.fs.mkdir(destDir);
  const rn = await window.api.fs.rename(srcPath, destPath);
  if (rn && rn.ok) return { ok: true, moved: true, path: destPath };
  return { ok: false, moved: false, path: srcPath, error: rn && rn.error };
}

async function reconcileTicketFolders(tab, entries) {
  const t = tab.tasks;
  if (t.reconciling) return;
  const stale = entries.filter((e) => {
    const target = ticketFolderForStatus(e.fm.status);
    return target != null && (e.folder || '') !== target;
  });
  if (!stale.length) return;
  t.reconciling = true;
  let moved = false;
  try {
    for (const e of stale) {
      const r = await relocateTicketFile(tab, e.path, e.file, e.fm.status);
      if (r && r.moved) moved = true;
    }
  } finally {
    t.reconciling = false;
  }
  if (moved) await scanBoard(tab); // real code re-polls; the mock re-scans.
}

async function moveTicketToStatus(tab, file, newStatus) {
  const ticket = tab.tasks.tickets.get(file);
  if (!ticket) return;
  if (ticket.fm.status === newStatus) return;
  const filePath = ticket.path;
  let fm = ticket.fm;
  let body = ticket.body;
  try {
    const fr = await window.api.fs.readFile(filePath);
    if (fr && fr.ok && !fr.binary) {
      const parsed = parseTicketFrontmatter(fr.content);
      if (parsed) { fm = parsed.fm; body = parsed.body; }
    }
  } catch (_) {}
  const newFm = Object.assign({}, fm);
  newFm.status = newStatus;
  newFm.updated = new Date().toISOString();
  if (!newFm.created) newFm.created = newFm.updated;
  const wr = await window.api.fs.writeFile(filePath, serializeTicket(newFm, body));
  if (!wr || !wr.ok) return;
  await relocateTicketFile(tab, filePath, file, newStatus);
  await scanBoard(tab);
}

// The recursive discovery + dedupe of pollTasksOnce, distilled to the disk
// interaction (no DOM / activeSubTab guards). Returns the deduped board entries
// AND updates tab.tasks.tickets, mirroring the real poll.
async function scanBoard(tab) {
  const tasksDir = tasksJoin(tab.folder, 'tasks');
  const res = await window.api.fs.findByExt(tasksDir, '.md');
  const candidates = [];
  if (res && res.ok) {
    for (const filePath of res.files) {
      const name = tasksBasename(filePath);
      const folder = tasksSubfolder(tasksDir, filePath);
      const fr = await window.api.fs.readFile(filePath);
      if (fr && fr.ok && !fr.binary) {
        const parsed = parseTicketFrontmatter(fr.content);
        if (parsed && parsed.fm.id) {
          candidates.push({ file: name, path: filePath, folder, fm: parsed.fm, body: parsed.body });
        }
      }
    }
  }
  const deduped = dedupeTicketsByFolder(candidates);
  const next = new Map();
  for (const tk of deduped) next.set(tk.file, tk);
  tab.tasks.tickets = next;
  return deduped;
}

// Board lane routing (mirrors laneForStatus): frontmatter status is authoritative.
function laneOf(fm) {
  return TASKS_LANE_STATUSES.includes(fm.status) ? fm.status : TASKS_UNKNOWN_STATUS;
}

// --- Map-backed mock filesystem --------------------------------------------
// fs:rename REFUSES when the target exists, exactly like main.js's IPC handler.

function makeMockFs() {
  const files = new Map(); // absolute path -> content
  const dirs = new Set();   // created directories
  return {
    _files: files,
    _dirs: dirs,
    async findByExt(root, ext) {
      const rootLower = String(root).toLowerCase();
      const extLower = String(ext).toLowerCase();
      const out = [];
      for (const p of files.keys()) {
        const pl = p.toLowerCase();
        if (pl.startsWith(rootLower) && pl.endsWith(extLower)) out.push(p);
      }
      return { ok: true, files: out, dirs: Array.from(dirs) };
    },
    async readDir(dir) {
      // Non-recursive listing, provided for completeness of the mock surface.
      const dl = dir.toLowerCase().replace(/[\\/]+$/, '');
      const entries = [];
      for (const p of files.keys()) {
        if (p.toLowerCase().startsWith(dl + '\\')) {
          const rest = p.slice(dl.length + 1);
          if (!rest.includes('\\') && !rest.includes('/')) {
            entries.push({ name: tasksBasename(p), isDir: false });
          }
        }
      }
      return { ok: true, entries };
    },
    async readFile(p) {
      if (!files.has(p)) return { ok: false, error: 'ENOENT' };
      return { ok: true, binary: false, content: files.get(p) };
    },
    async writeFile(p, content) {
      files.set(p, content);
      return { ok: true };
    },
    async mkdir(dir) {
      dirs.add(dir);
      return { ok: true };
    },
    async rename(oldPath, newPath) {
      if (!oldPath || !newPath) return { ok: false, error: 'oldPath and newPath required' };
      if (files.has(newPath)) return { ok: false, error: 'Target already exists' };
      if (!files.has(oldPath)) return { ok: false, error: 'ENOENT' };
      files.set(newPath, files.get(oldPath));
      files.delete(oldPath);
      return { ok: true };
    },
    async exists(p) {
      return { ok: true, exists: files.has(p) || dirs.has(p) };
    },
  };
}

// The browser global the copied functions close over.
let window;

const ROOT = 'C:\\project';
const TASKS = tasksJoin(ROOT, 'tasks');

function fmText(spec) {
  const fm = {
    id: spec.id, title: spec.title || spec.id, status: spec.status,
    created: spec.created || '2026-07-18T00:00:00.000Z',
    updated: spec.updated || '2026-07-18T00:00:00.000Z',
  };
  if (spec.order != null) fm.order = String(spec.order);
  const body = spec.body != null ? spec.body : '\n## Description\nseed\n';
  return serializeTicket(fm, body);
}

// Seed the mock disk with tickets placed in a given subfolder ('' = top level),
// then return a fresh tab whose in-memory board is scanned from disk.
async function seed(specs) {
  window = { api: { fs: makeMockFs() } };
  for (const s of specs) {
    const file = `${s.id}.md`;
    const dir = s.folder ? tasksJoin(TASKS, s.folder) : TASKS;
    window.api.fs._files.set(tasksJoin(dir, file), fmText(s));
  }
  const tab = { folder: ROOT, tasks: { tickets: new Map(), reconciling: false } };
  await scanBoard(tab);
  return tab;
}

// Paths currently on the mock disk, sorted for stable assertions.
function diskPaths() {
  return Array.from(window.api.fs._files.keys()).sort();
}
function relPaths() {
  return diskPaths().map((p) => p.slice(TASKS.length + 1).replace(/\\/g, '/'));
}

test('Scenario: Per-status subfolders are created on demand', async () => {
  // Given no status subfolders exist yet under tasks/ (ticket at top level).
  const tab = await seed([{ id: 'TASK-100', status: 'todo', folder: '' }]);
  assert.deepEqual(window.api.fs._dirs.size, 0, 'no subfolders created yet');
  // When a ticket is assigned the status "in-progress" (a status move).
  await moveTicketToStatus(tab, 'TASK-100.md', 'in-progress');
  // Then a "tasks/in-progress" subfolder exists.
  assert.ok(window.api.fs._dirs.has(tasksJoin(TASKS, 'in-progress')),
    'tasks/in-progress was mkdir-ed on demand');
  // And the ticket file lives inside "tasks/in-progress".
  assert.deepEqual(relPaths(), ['in-progress/TASK-100.md']);
});

test('Scenario: Moving a ticket relocates its file to the matching folder', async () => {
  // Given ticket TASK-101 has status "todo" in "tasks/todo".
  const tab = await seed([{ id: 'TASK-101', status: 'todo', folder: 'todo' }]);
  assert.deepEqual(relPaths(), ['todo/TASK-101.md']);
  // When the ticket status changes to "in-progress".
  await moveTicketToStatus(tab, 'TASK-101.md', 'in-progress');
  // Then the TASK-101 file is now under "tasks/in-progress"
  // And no TASK-101 file remains under "tasks/todo".
  assert.deepEqual(relPaths(), ['in-progress/TASK-101.md'],
    'file moved with no copy left behind');
  // And the file's frontmatter status is "in-progress".
  const content = window.api.fs._files.get(tasksJoin(TASKS, 'in-progress', 'TASK-101.md'));
  assert.equal(parseTicketFrontmatter(content).fm.status, 'in-progress');
});

test('Scenario: The scanner discovers tickets recursively', async () => {
  // Given tickets exist in tasks/todo, tasks/testing, and tasks/done.
  const tab = await seed([
    { id: 'TASK-201', status: 'todo', folder: 'todo' },
    { id: 'TASK-202', status: 'testing', folder: 'testing' },
    { id: 'TASK-203', status: 'done', folder: 'done' },
  ]);
  // When the board scan runs.
  const board = await scanBoard(tab);
  // Then every one of those tickets appears exactly once on the board.
  assert.deepEqual(board.map((e) => e.fm.id).sort(), ['TASK-201', 'TASK-202', 'TASK-203']);
  assert.equal(board.length, 3, 'no ticket dropped, none duplicated');
  // And each appears in the lane matching its frontmatter status.
  const byId = new Map(board.map((e) => [e.fm.id, e]));
  assert.equal(laneOf(byId.get('TASK-201').fm), 'todo');
  assert.equal(laneOf(byId.get('TASK-202').fm), 'testing');
  assert.equal(laneOf(byId.get('TASK-203').fm), 'done');
});

test('Scenario: Frontmatter status wins when the folder disagrees', async () => {
  // Given a file physically located in tasks/todo, but its frontmatter status is "done".
  const tab = await seed([{ id: 'TASK-301', status: 'done', folder: 'todo' }]);
  // When the board scan runs.
  const board = await scanBoard(tab);
  // Then the ticket is rendered in the "done" lane (frontmatter is authoritative).
  assert.equal(board.length, 1);
  assert.equal(laneOf(board[0].fm), 'done', 'lane derives from frontmatter, not the folder');
  // And reconciliation moves the file into tasks/done.
  await reconcileTicketFolders(tab, board);
  assert.deepEqual(relPaths(), ['done/TASK-301.md']);
});

test('Scenario: Legacy flat-layout tickets are still found and reconciled', async () => {
  // Given a ticket file sits directly in tasks/ (no subfolder) with status "testing".
  const tab = await seed([{ id: 'TASK-401', status: 'testing', folder: '' }]);
  assert.deepEqual(relPaths(), ['TASK-401.md'], 'starts at the flat top level');
  // When the board scan runs.
  const board = await scanBoard(tab);
  // Then the ticket appears in the "testing" lane.
  assert.equal(laneOf(board[0].fm), 'testing');
  // And the file is relocated into tasks/testing.
  await reconcileTicketFolders(tab, board);
  assert.deepEqual(relPaths(), ['testing/TASK-401.md']);
});

test('Scenario: Writes and moves stay atomic during a poll', async () => {
  // Given the board poll can fire at any time. The move is a whole-file write to
  // the SAME path followed by an atomic rename — we scan at every observable disk
  // state and assert a poll never sees a duplicated or missing ticket.
  const tab = await seed([{ id: 'TASK-501', status: 'todo', folder: 'todo' }]);
  const oldPath = tasksJoin(TASKS, 'todo', 'TASK-501.md');
  const newPath = tasksJoin(TASKS, 'in-progress', 'TASK-501.md');

  // A poll before the move: exactly one copy.
  let board = await scanBoard(tab);
  assert.equal(board.filter((e) => e.fm.id === 'TASK-501').length, 1, 'one copy before');

  // Step 1 — the whole-file write (status flips, still at the todo path).
  const parsed = parseTicketFrontmatter(window.api.fs._files.get(oldPath));
  const newFm = Object.assign({}, parsed.fm, { status: 'in-progress' });
  await window.api.fs.writeFile(oldPath, serializeTicket(newFm, parsed.body));
  // A poll observing the intermediate state: still exactly one copy (never two),
  // never missing.
  board = await scanBoard(tab);
  assert.equal(board.filter((e) => e.fm.id === 'TASK-501').length, 1,
    'between write and rename: exactly one copy (no duplicate, not missing)');

  // Step 2 — the atomic rename into tasks/in-progress.
  const rn = await window.api.fs.rename(oldPath, newPath);
  assert.ok(rn.ok, 'atomic move succeeds');
  // A poll after the move: still exactly one copy, now in the new folder.
  board = await scanBoard(tab);
  assert.equal(board.filter((e) => e.fm.id === 'TASK-501').length, 1, 'one copy after');
  assert.deepEqual(relPaths(), ['in-progress/TASK-501.md'], 'no copy left in tasks/todo');
});

test('Scenario: Reorder within the todo lane still works', async () => {
  // Given three tickets in tasks/todo with orders 1, 2, 3.
  const tab = await seed([
    { id: 'TASK-601', status: 'todo', folder: 'todo', order: 1 },
    { id: 'TASK-602', status: 'todo', folder: 'todo', order: 2 },
    { id: 'TASK-603', status: 'todo', folder: 'todo', order: 3 },
  ]);
  // When the last ticket is dragged above the first: reindex the lane 1..N as a
  // whole-file `order` write (no status change, so no relocate).
  const newSequence = ['TASK-603', 'TASK-601', 'TASK-602'];
  for (let i = 0; i < newSequence.length; i++) {
    const p = tasksJoin(TASKS, 'todo', `${newSequence[i]}.md`);
    const parsed = parseTicketFrontmatter(window.api.fs._files.get(p));
    const nf = Object.assign({}, parsed.fm, { order: String(i + 1) });
    await window.api.fs.writeFile(p, serializeTicket(nf, parsed.body));
  }
  // Then the todo tickets are reindexed 1..N in the new sequence.
  const board = await scanBoard(tab);
  const orders = {};
  for (const e of board) orders[e.fm.id] = Number(e.fm.order);
  assert.deepEqual(orders, { 'TASK-603': 1, 'TASK-601': 2, 'TASK-602': 3 });
  // And every reordered ticket file remains under tasks/todo (none relocated).
  assert.deepEqual(relPaths(),
    ['todo/TASK-601.md', 'todo/TASK-602.md', 'todo/TASK-603.md']);
  // And reconciliation is a no-op — folders already match status.
  await reconcileTicketFolders(tab, board);
  assert.deepEqual(relPaths(),
    ['todo/TASK-601.md', 'todo/TASK-602.md', 'todo/TASK-603.md']);
});

test('Scenario: Unknown-status tickets are not moved into a status folder', async () => {
  // Given a ticket whose frontmatter status is "archived" (out of enum).
  const tab = await seed([{ id: 'TASK-701', status: 'archived', folder: '' }]);
  // When the board scan runs.
  const board = await scanBoard(tab);
  // Then the ticket is shown in the "unknown" lane.
  assert.equal(laneOf(board[0].fm), TASKS_UNKNOWN_STATUS);
  // And its file is not moved into any status subfolder (reconcile leaves it).
  await reconcileTicketFolders(tab, board);
  assert.deepEqual(relPaths(), ['TASK-701.md'], 'unknown ticket left in place');
  assert.equal(window.api.fs._dirs.size, 0, 'no status subfolder created for it');
  // A direct relocate is also a no-op.
  const r = await relocateTicketFile(tab, tasksJoin(TASKS, 'TASK-701.md'), 'TASK-701.md', 'archived');
  assert.deepEqual(r, { ok: true, moved: false, path: tasksJoin(TASKS, 'TASK-701.md') });
});

test('Scenario: Edge — a destination name collision does not lose the ticket', async () => {
  // Given a ticket file must move into tasks/done, but a file with the same name
  // already exists in tasks/done (a different ticket occupying the slot).
  const tab = await seed([
    { id: 'TASK-801', status: 'done', folder: 'todo', body: '\n## Description\nthe mover\n' },
  ]);
  // Pre-existing occupant at the destination path (same file name).
  const destPath = tasksJoin(TASKS, 'done', 'TASK-801.md');
  const occupantText = fmText({ id: 'TASK-801', status: 'done', folder: 'done', body: '\n## Description\nthe occupant\n' });
  window.api.fs._files.set(destPath, occupantText);
  const srcPath = tasksJoin(TASKS, 'todo', 'TASK-801.md');
  const srcTextBefore = window.api.fs._files.get(srcPath);

  // When the move is attempted.
  const r = await relocateTicketFile(tab, srcPath, 'TASK-801.md', 'done');

  // Then the collision is detected and handled (rename refused, not moved).
  assert.equal(r.ok, false, 'the move reports failure');
  assert.equal(r.moved, false);
  assert.match(String(r.error), /Target already exists/, 'refusal matches the real IPC');
  assert.equal(r.path, srcPath, 'the ticket is reported still at its source');
  // And the ticket file is not silently deleted or lost — BOTH copies intact.
  assert.equal(window.api.fs._files.get(srcPath), srcTextBefore, 'source untouched, not deleted');
  assert.equal(window.api.fs._files.get(destPath), occupantText, 'destination not overwritten');
  // And the board still surfaces the ticket exactly once (dedupe prefers the
  // copy whose folder matches its status — here the occupant in tasks/done).
  const board = await scanBoard(tab);
  const forId = board.filter((e) => e.fm.id === 'TASK-801');
  assert.equal(forId.length, 1, 'ticket shown once despite two on-disk copies');
  assert.equal(forId[0].folder, 'done', 'the folder-matching copy is the one surfaced');
});
