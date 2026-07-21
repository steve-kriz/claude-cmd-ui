'use strict';

// Unit tests for TASK-074 — "Won't do" resolution + PR-review impact/marker
// convention.
//
// Two layers are covered here:
//
//   1. The pure renderer predicate `isWontDoTicket` (and its helper
//      `ticketFieldNonEmpty`) and the whole-file writer `serializeTicket` /
//      `parseTicketFrontmatter`. `renderer/renderer.js` is a BROWSER script (no
//      module.exports, references `document`), so — following the
//      test/tasks-working-indicator.test.js convention of reading the single
//      source of truth out of the renderer — we EXTRACT the exact, DOM-free
//      function bodies from renderer.js source and evaluate them in a sandbox.
//      This exercises the real product code, not a paraphrase.
//
//   2. Source-scan guards over the DOM-bound wiring that cannot be evaluated
//      headless (fill()'s pseudo-option select, doWrite()'s mapping/clear,
//      renderTasksBoard's struck-through class, moveTicketToStatus's plain-done
//      write), plus the index.html option, the CSS rule, the untouched status
//      enum in lib/ticket-lanes.js, and the instruction-file + assets drift
//      guards for the reviewer impact statement / review-of marker.
//
// NO DATABASE, REAL DB CONNECTION, FILESYSTEM WRITE, OR NETWORK CALL IS MADE.
// The only disk access is reading the app's own source files as fixtures.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'renderer', 'renderer.js');
const INDEX_HTML = path.join(ROOT, 'renderer', 'index.html');
const STYLES = path.join(ROOT, 'renderer', 'styles.css');
const rendererSrc = fs.readFileSync(RENDERER, 'utf8');
const indexHtml = fs.readFileSync(INDEX_HTML, 'utf8');
const stylesSrc = fs.readFileSync(STYLES, 'utf8');

const ticketLanes = require('../lib/ticket-lanes');
// TASK-102: the modal status <select> options are now built in JS by
// populateTaskStatusOptions (renderer.js), NOT hardcoded in index.html, so the
// "Won't do" pseudo-option is asserted via the real JS builder run headless.
const laneHarness = require('./helpers/task-101-lane-harness');

// --- Extract a top-level `function NAME(...) { ... }` by balanced braces -----
function extractFunction(src, name) {
  const decl = `function ${name}(`;
  const start = src.indexOf(decl);
  assert.notEqual(start, -1, `function ${name} present in renderer.js`);
  const braceStart = src.indexOf('{', start);
  let depth = 0;
  let i = braceStart;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

// Build a sandbox exposing the real DOM-free helpers from renderer.js.
const PURE_FNS = ['ticketFieldNonEmpty', 'isWontDoTicket', 'frontmatterValueLine',
  'serializeTicket', 'parseTicketFrontmatter'];
const sandboxSrc = PURE_FNS.map((n) => extractFunction(rendererSrc, n)).join('\n\n') +
  '\nreturn { ' + PURE_FNS.join(', ') + ' };';
// eslint-disable-next-line no-new-func
const R = new Function(sandboxSrc)();

// ===========================================================================
// PART 1 — isWontDoTicket: the single source of truth for the marker
// ===========================================================================

test('isWontDoTicket: done + resolution "wont-do" is true', () => {
  assert.equal(R.isWontDoTicket({ status: 'done', resolution: 'wont-do' }), true);
});

test('isWontDoTicket: trims the resolution value before comparing', () => {
  assert.equal(R.isWontDoTicket({ status: 'done', resolution: '  wont-do  ' }), true);
});

test('isWontDoTicket: requires status EXACTLY done (todo/testing/other are false)', () => {
  for (const status of ['todo', 'in-progress', 'testing', 'failed-testing', 'wont-do', '']) {
    assert.equal(R.isWontDoTicket({ status, resolution: 'wont-do' }), false,
      `status=${JSON.stringify(status)} + resolution wont-do is NOT a won't-do card`);
  }
});

test('isWontDoTicket: a different resolution value (e.g. fixed) is a plain done, not won\'t-do', () => {
  assert.equal(R.isWontDoTicket({ status: 'done', resolution: 'fixed' }), false);
  assert.equal(R.isWontDoTicket({ status: 'done', resolution: 'duplicate' }), false);
});

test('isWontDoTicket: done with no / empty resolution is false', () => {
  assert.equal(R.isWontDoTicket({ status: 'done' }), false);
  assert.equal(R.isWontDoTicket({ status: 'done', resolution: '' }), false);
  assert.equal(R.isWontDoTicket({ status: 'done', resolution: '   ' }), false);
  assert.equal(R.isWontDoTicket({ status: 'done', resolution: null }), false);
});

test('isWontDoTicket: null / undefined / junk fm never throws, returns false', () => {
  for (const bad of [null, undefined, 0, '', false]) {
    assert.equal(R.isWontDoTicket(bad), false, `${JSON.stringify(bad)} -> false`);
  }
});

// ===========================================================================
// PART 2 — serializeTicket / parseTicketFrontmatter round-trip of the marker
// ===========================================================================

test('serializeTicket keeps resolution as an extra key AFTER the five leading keys', () => {
  const fm = { id: 'TASK-080', title: 'Do a thing', status: 'done',
    created: '2026-07-19T00:00:00.000Z', updated: '2026-07-20T00:00:00.000Z',
    resolution: 'wont-do' };
  const out = R.serializeTicket(fm, '## Body\ntext');
  const lines = out.split('\n');
  // Leading order id,title,status,created,updated then the extra key.
  assert.deepEqual(lines.slice(1, 6).map((l) => l.split(':')[0]),
    ['id', 'title', 'status', 'created', 'updated']);
  assert.equal(lines[6], 'resolution: wont-do');
});

test('serializeTicket -> parseTicketFrontmatter round-trips the wont-do marker', () => {
  const fm = { id: 'TASK-080', title: 'T', status: 'done',
    created: '2026-07-19T00:00:00.000Z', updated: '2026-07-20T00:00:00.000Z',
    resolution: 'wont-do' };
  const parsed = R.parseTicketFrontmatter(R.serializeTicket(fm, 'body'));
  assert.equal(parsed.fm.status, 'done');
  assert.equal(parsed.fm.resolution, 'wont-do');
  assert.equal(R.isWontDoTicket(parsed.fm), true);
});

// ===========================================================================
// PART 3 — Source-scan guards over the DOM-bound wiring
// ===========================================================================

test('renderTasksBoard adds the .wont-do title class only for isWontDoTicket cards', () => {
  assert.match(rendererSrc, /if \(isWontDoTicket\(tk\.fm\)\) titleEl\.classList\.add\('wont-do'\);/);
  // The class is applied to the card title element.
  assert.match(rendererSrc, /titleEl\.className = 'task-card-title';/);
});

test('fill() selects the __wont-do__ pseudo-option when re-opening a won\'t-do ticket', () => {
  assert.match(rendererSrc, /if \(isWontDoTicket\(fmObj\)\) statusSel\.value = '__wont-do__';/);
});

test('doWrite maps __wont-do__ -> status done + resolution wont-do', () => {
  // Isolate the doWrite branch and assert the mapping.
  const start = rendererSrc.indexOf("if (statusSel.value === '__wont-do__') {");
  assert.notEqual(start, -1, 'doWrite __wont-do__ branch present');
  const branch = rendererSrc.slice(start, start + 400);
  assert.match(branch, /newFm\.status = 'done';/);
  assert.match(branch, /newFm\.resolution = 'wont-do';/);
});

test('doWrite clears resolution ONLY when it is exactly wont-do (else round-trips untouched)', () => {
  const start = rendererSrc.indexOf("if (statusSel.value === '__wont-do__') {");
  const branch = rendererSrc.slice(start, start + 500);
  // The else branch sets the picked status and deletes only an exact wont-do marker.
  assert.match(branch, /newFm\.status = statusSel\.value;/);
  assert.match(branch, /String\(newFm\.resolution\)\.trim\(\) === 'wont-do'\)\s*\{\s*delete newFm\.resolution;/);
});

test('doWrite writes the whole file via serializeTicket, bumps updated, preserves created', () => {
  const start = rendererSrc.indexOf('const doWrite = async () =>');
  const body = rendererSrc.slice(start, rendererSrc.indexOf('const onSave', start));
  assert.match(body, /newFm\.updated = new Date\(\)\.toISOString\(\);/);
  assert.match(body, /if \(!newFm\.created\) newFm\.created = newFm\.updated;/);
  assert.match(body, /window\.api\.fs\.writeFile\(ticketPath, serializeTicket\(newFm, bodyArea\.value\)\)/);
  // Failure path: a failed write surfaces the error and does NOT cleanup/poll.
  assert.match(body, /errEl\.textContent = 'Save failed: '/);
});

test('moveTicketToStatus (plain drag) sets status and clears a lingering wont-do marker', () => {
  // TASK-080: a plain drag must never (re)produce a `resolution: wont-do`.
  // moveTicketToStatus now clears the exact trimmed `wont-do` value with the
  // SAME predicate doWrite's revert path uses. It must NOT set the marker.
  const start = rendererSrc.indexOf('async function moveTicketToStatus(');
  const body = rendererSrc.slice(start, rendererSrc.indexOf('\n}', start) + 2);
  assert.match(body, /newFm\.status = newStatus;/);
  // Clears only an exact wont-do marker (mirrors doWrite's revert predicate).
  assert.match(body, /newFm\.resolution != null && String\(newFm\.resolution\)\.trim\(\) === 'wont-do'\)\s*\{\s*delete newFm\.resolution;/);
  // It never ASSIGNS a wont-do resolution (that is modal-only, in doWrite).
  assert.ok(!/newFm\.resolution\s*=\s*'wont-do'/.test(body),
    'moveTicketToStatus must not assign resolution: wont-do');
});

// ===========================================================================
// TASK-080 — plain drag must not resurrect a lingering wont-do marker
// ===========================================================================

// Extract moveTicketToStatus's clear predicate and doWrite's revert predicate
// so we can assert they are the SAME exact-match rule (drift guard).
function clearPredicateIn(src, anchor) {
  const start = src.indexOf(anchor);
  assert.notEqual(start, -1, `anchor present: ${anchor}`);
  const region = src.slice(start, start + 3000);
  const m = region.match(/newFm\.resolution != null && String\(newFm\.resolution\)\.trim\(\) === 'wont-do'\)\s*\{\s*delete newFm\.resolution;/);
  assert.ok(m, `exact wont-do clear predicate present near ${anchor}`);
  return m[0];
}

test('TASK-080: moveTicketToStatus clears wont-do with the SAME predicate as doWrite (drift guard)', () => {
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const moveClear = norm(clearPredicateIn(rendererSrc, 'async function moveTicketToStatus('));
  const doWriteClear = norm(clearPredicateIn(rendererSrc, 'const doWrite = async () =>'));
  assert.equal(moveClear, doWriteClear,
    'the drag-path clear predicate must match doWrite\'s revert predicate (modulo indentation)');
});

test('TASK-080: moveTicketToStatus still writes the whole file via serializeTicket, bumps updated, preserves created', () => {
  const start = rendererSrc.indexOf('async function moveTicketToStatus(');
  const body = rendererSrc.slice(start, rendererSrc.indexOf('\n}', start) + 2);
  assert.match(body, /newFm\.updated = new Date\(\)\.toISOString\(\);/);
  assert.match(body, /if \(!newFm\.created\) newFm\.created = newFm\.updated;/);
  assert.match(body, /window\.api\.fs\.writeFile\(filePath, serializeTicket\(newFm, body\)\)/);
});

// Pure simulation of moveTicketToStatus's frontmatter build (the exact clear
// predicate, source-scanned above). No DOM, no disk — a paraphrase-free mirror
// verified against renderer.js by the drift guard.
function buildMovedFm(fm, newStatus, now) {
  const newFm = Object.assign({}, fm);
  newFm.status = newStatus;
  if (newFm.resolution != null && String(newFm.resolution).trim() === 'wont-do') {
    delete newFm.resolution;
  }
  newFm.updated = now;
  if (!newFm.created) newFm.created = newFm.updated;
  return newFm;
}

test('TASK-080: dragging a wont-do ticket out of Done drops the marker', () => {
  const fm = { id: 'TASK-080', title: 'T', status: 'done',
    created: '2026-07-18T00:00:00.000Z', updated: '2026-07-19T00:00:00.000Z',
    resolution: 'wont-do' };
  const moved = buildMovedFm(fm, 'in-progress', '2026-07-20T00:00:00.000Z');
  assert.equal(moved.status, 'in-progress');
  assert.equal(moved.resolution, undefined);
  assert.equal(R.isWontDoTicket(moved), false);
  // Round-trips through the whole-file writer with no resolution line.
  const disk = R.serializeTicket(moved, 'body');
  assert.ok(!/resolution/.test(disk), 'no resolution line persisted');
});

test('TASK-080: dragging that ticket back onto Done yields a NORMAL done (no marker)', () => {
  const fm = { id: 'TASK-080', title: 'T', status: 'in-progress',
    created: '2026-07-18T00:00:00.000Z', updated: '2026-07-19T00:00:00.000Z' };
  const moved = buildMovedFm(fm, 'done', '2026-07-20T01:00:00.000Z');
  assert.equal(moved.status, 'done');
  assert.equal(moved.resolution, undefined);
  assert.equal(R.isWontDoTicket(moved), false, 'plain drag-to-Done is not struck-through');
});

test('TASK-080: a lingering wont-do marker on a done card is cleared even on a no-op-ish move', () => {
  const fm = { id: 'TASK-080', title: 'T', status: 'done',
    created: '2026-07-18T00:00:00.000Z', updated: '2026-07-19T00:00:00.000Z',
    resolution: '  wont-do  ' }; // trimmed match is still cleared
  const moved = buildMovedFm(fm, 'testing', '2026-07-20T00:00:00.000Z');
  assert.equal(moved.resolution, undefined, 'trimmed wont-do is cleared');
});

test('TASK-080: a DIFFERENT resolution value (fixed) is NOT cleared by a drag (exact-match guard)', () => {
  const fm = { id: 'TASK-080', title: 'T', status: 'done',
    created: '2026-07-18T00:00:00.000Z', updated: '2026-07-19T00:00:00.000Z',
    resolution: 'fixed' };
  const moved = buildMovedFm(fm, 'in-progress', '2026-07-20T00:00:00.000Z');
  assert.equal(moved.resolution, 'fixed', 'unrelated resolution round-trips untouched');
});

test('TASK-080: a ticket with NO resolution key is unaffected (no spurious key added)', () => {
  const fm = { id: 'TASK-080', title: 'T', status: 'in-progress',
    created: '2026-07-18T00:00:00.000Z', updated: '2026-07-19T00:00:00.000Z' };
  const moved = buildMovedFm(fm, 'done', '2026-07-20T00:00:00.000Z');
  assert.ok(!('resolution' in moved), 'no resolution key introduced');
});

test('populateTaskStatusOptions builds the fixed "Won\'t do" pseudo-option (TASK-102: JS, not index.html)', () => {
  // TASK-102 moved the modal <select> options out of index.html and into the
  // config-driven JS builder, so index.html ships an EMPTY select. The "Won't
  // do" resolution pseudo-entry (value __wont-do__) is now appended by
  // populateTaskStatusOptions — assert it there via the real builder.
  const document = laneHarness.makeDocument();
  const mod = laneHarness.loadLaneModule(laneHarness.makeWindow().window, document, console);
  const sel = document.createElement('select');
  mod.populateTaskStatusOptions(sel, mod.normalizeTasksColumns(null));
  const opts = sel.children.map((o) => ({ value: o.value, label: o.textContent }));
  const wontDo = opts.find((o) => o.value === '__wont-do__');
  assert.ok(wontDo, '__wont-do__ pseudo-option present in the built select');
  assert.equal(wontDo.label, "Won't do", 'labelled "Won\'t do"');
  // It is always last (a resolution pseudo-entry, never a real status).
  assert.equal(opts[opts.length - 1].value, '__wont-do__', '"Won\'t do" is the final option');
  // And index.html no longer hardcodes the option (the builder owns it now).
  assert.ok(!/__wont-do__/.test(indexHtml), 'index.html no longer hardcodes the __wont-do__ option');
});

test('styles.css strikes through / mutes the won\'t-do card title', () => {
  const m = stylesSrc.match(/\.task-card-title\.wont-do\s*\{([^}]*)\}/);
  assert.ok(m, '.task-card-title.wont-do rule present');
  assert.match(m[1], /text-decoration:\s*line-through/);
});

// ===========================================================================
// TASK-081 — Won't-do save flows through onSave's shared changed-on-disk guard
// ===========================================================================
//
// `openTaskModal`'s `onSave` (renderer.js ~6269-6285) is a DOM-bound closure
// (over `openRaw`, `errEl.dataset.mode`, saveBtn click events) that references
// `document` and `window.api`, so — as with the rest of this file's DOM-bound
// wiring — it cannot be evaluated headless. Per the ticket's fallback we (a)
// source-scan the real guard to pin its exact two-click state machine, and (b)
// unit-test a faithful mirror of that state machine so the won't-do save's
// block-then-overwrite behavior is asserted directly. The mirror's write half
// reuses doWrite's exact won't-do mapping, so passing proves the guard is SHARED
// (not bypassed by the __wont-do__ mapping).

// (a) Source-scan drift guard over the REAL onSave guard.
test('TASK-081: onSave gates doWrite behind a two-click changed-on-disk guard (source scan)', () => {
  const start = rendererSrc.indexOf('const onSave = async () =>');
  assert.notEqual(start, -1, 'onSave present in renderer.js');
  const body = rendererSrc.slice(start, rendererSrc.indexOf('saveBtn.addEventListener', start));
  // Armed second click -> straight to the SAME doWrite the won't-do mapping lives in.
  assert.match(body, /if \(errEl\.dataset\.mode === 'overwrite'\) \{ await doWrite\(\); return; \}/);
  // First click: snapshot openRaw, read disk, compare.
  assert.match(body, /let diskRaw = openRaw;/);
  assert.match(body, /if \(fr && fr\.ok\) diskRaw = fr\.content;/);
  // Changed -> warn, arm, advance snapshot, RETURN (no write on first click).
  assert.match(body, /if \(diskRaw !== openRaw\) \{[\s\S]*?errEl\.dataset\.mode = 'overwrite';[\s\S]*?openRaw = diskRaw;[\s\S]*?return;/);
  assert.match(body, /This ticket changed on disk[^']*Click Save again to overwrite\./);
  // Unchanged -> the shared doWrite (same path a normal save takes).
  assert.match(body, /await doWrite\(\);/);
  // The won't-do mapping lives INSIDE doWrite, i.e. downstream of this guard —
  // the guard does not branch on the select value, so it is not won't-do-specific.
  const gStart = rendererSrc.indexOf('const doWrite = async () =>');
  assert.ok(gStart !== -1 && gStart < start, 'doWrite is defined before onSave and reused by it');
  assert.ok(!/__wont-do__/.test(body), 'onSave itself never inspects the won\'t-do value (guard is generic)');
});

// (b) Faithful mirror of the onSave two-click state machine + doWrite mapping.
function makeGuardMirror(mockFs, ticketPath, fm, body, openRaw) {
  const state = { openRaw, errMode: '', errText: '', writes: 0 };
  async function doWrite(selectValue, now) {
    const newFm = Object.assign({}, fm);
    if (selectValue === '__wont-do__') {
      newFm.status = 'done';
      newFm.resolution = 'wont-do';
    } else {
      newFm.status = selectValue;
      if (newFm.resolution != null && String(newFm.resolution).trim() === 'wont-do') {
        delete newFm.resolution;
      }
    }
    newFm.updated = now;
    if (!newFm.created) newFm.created = newFm.updated;
    const wr = await mockFs.writeFile(ticketPath, R.serializeTicket(newFm, body));
    if (!wr || !wr.ok) { state.errText = 'Save failed: ' + ((wr && wr.error) || 'unknown'); return { ok: false }; }
    state.writes++;
    return { ok: true };
  }
  async function onSave(selectValue, now) {
    if (state.errMode === 'overwrite') { return await doWrite(selectValue, now); }
    let diskRaw = state.openRaw;
    try {
      const fr = await mockFs.readFile(ticketPath);
      if (fr && fr.ok) diskRaw = fr.content;
    } catch (_) { /* keep snapshot */ }
    if (diskRaw !== state.openRaw) {
      state.errText = 'This ticket changed on disk (an agent may have updated it). Click Save again to overwrite.';
      state.errMode = 'overwrite';
      state.openRaw = diskRaw;
      return { ok: false, blocked: true };
    }
    return await doWrite(selectValue, now);
  }
  return { state, onSave };
}

// Minimal in-memory fs mock (no real disk/DB/network).
function mockFsFrom(initial) {
  const files = new Map([[initial.path, initial.content]]);
  return {
    files,
    async readFile(p) {
      return files.has(p) ? { ok: true, content: files.get(p) } : { ok: false, error: 'ENOENT' };
    },
    async writeFile(p, content) { files.set(p, content); return { ok: true }; },
  };
}

test('TASK-081: won\'t-do save on a changed-on-disk ticket is blocked on click 1, overwrites on click 2', async () => {
  const P = '/proj/tasks/todo/TASK-081.md';
  const created = '2026-07-19T10:00:00.000Z';
  const fm = { id: 'TASK-081', title: 'Maybe skip', status: 'todo', created, updated: created };
  const openRaw = R.serializeTicket(fm, 'body');
  const mockFs = mockFsFrom({ path: P, content: openRaw });
  const { state, onSave } = makeGuardMirror(mockFs, P, fm, 'body', openRaw);

  // An agent rewrites the file after it was opened.
  mockFs.files.set(P, R.serializeTicket(Object.assign({}, fm, { status: 'in-progress' }), 'body'));
  const disk = mockFs.files.get(P);

  // First click: blocked, warns, writes nothing, does not clobber disk.
  const first = await onSave('__wont-do__', '2026-07-20T09:00:00.000Z');
  assert.equal(first.blocked, true);
  assert.equal(state.writes, 0);
  assert.match(state.errText, /changed on disk.*Click Save again to overwrite/);
  assert.equal(mockFs.files.get(P), disk, 'blocked save leaves disk untouched');

  // Second click: overwrites with the won't-do marker.
  const second = await onSave('__wont-do__', '2026-07-20T09:00:00.000Z');
  assert.equal(second.ok, true);
  assert.equal(state.writes, 1);
  const after = R.parseTicketFrontmatter(mockFs.files.get(P));
  assert.equal(after.fm.status, 'done');
  assert.equal(after.fm.resolution, 'wont-do');
  assert.equal(R.isWontDoTicket(after.fm), true);
});

test('TASK-081: the guard is SHARED — a won\'t-do save with no disk change writes on the first click', async () => {
  const P = '/proj/tasks/todo/TASK-081.md';
  const fm = { id: 'TASK-081', title: 'No race', status: 'todo',
    created: '2026-07-19T10:00:00.000Z', updated: '2026-07-19T10:00:00.000Z' };
  const openRaw = R.serializeTicket(fm, 'body');
  const mockFs = mockFsFrom({ path: P, content: openRaw });
  const { state, onSave } = makeGuardMirror(mockFs, P, fm, 'body', openRaw);
  const res = await onSave('__wont-do__', '2026-07-20T09:00:00.000Z');
  assert.equal(res.ok, true);
  assert.equal(state.errMode, '', 'never armed overwrite mode');
  assert.equal(state.writes, 1);
  assert.equal(R.isWontDoTicket(R.parseTicketFrontmatter(mockFs.files.get(P)).fm), true);
});

test('TASK-081: two-click semantics are identical for a NORMAL save (won\'t-do mapping does not special-case the guard)', async () => {
  const P = '/proj/tasks/todo/TASK-081.md';
  const fm = { id: 'TASK-081', title: 'Plain', status: 'todo',
    created: '2026-07-19T10:00:00.000Z', updated: '2026-07-19T10:00:00.000Z' };
  const openRaw = R.serializeTicket(fm, 'body');
  const mockFs = mockFsFrom({ path: P, content: openRaw });
  const { state, onSave } = makeGuardMirror(mockFs, P, fm, 'body', openRaw);
  mockFs.files.set(P, R.serializeTicket(Object.assign({}, fm, { title: 'Agent renamed' }), 'body'));
  assert.equal((await onSave('in-progress', '2026-07-20T09:00:00.000Z')).blocked, true);
  assert.equal(state.writes, 0);
  assert.equal((await onSave('in-progress', '2026-07-20T09:00:00.000Z')).ok, true);
  const after = R.parseTicketFrontmatter(mockFs.files.get(P));
  assert.equal(after.fm.status, 'in-progress');
  assert.equal(after.fm.resolution, undefined);
});

// ===========================================================================
// PART 4 — Status enum unchanged (locked decision: no wont-do status)
// ===========================================================================

test('lib/ticket-lanes VALID_STATUSES does NOT contain wont-do', () => {
  assert.ok(!ticketLanes.VALID_STATUSES.includes('wont-do'), 'wont-do is not a status');
  assert.deepEqual(ticketLanes.VALID_STATUSES,
    ['todo', 'defining', 'in-progress', 'testing', 'post-processing', 'done', 'failed-testing']);
});

test('a literal status: wont-do routes to the unknown lane, never done', () => {
  assert.equal(ticketLanes.laneForStatus('wont-do'), 'unknown');
  assert.notEqual(ticketLanes.laneForStatus('wont-do'), 'done');
  assert.equal(ticketLanes.isKnownStatus('wont-do'), false);
});

// ===========================================================================
// PART 5 — PR-review instruction-file convention (Part 1 of the ticket)
// ===========================================================================

const TL_PROJECT = path.join(ROOT, '.claude', 'agents', 'tech-lead.md');
const TL_ASSETS = path.join(ROOT, 'assets', 'agents', 'tech-lead.md');
const SKILL_PROJECT = path.join(ROOT, '.claude', 'skills', 'orchestrate', 'SKILL.md');
const SKILL_ASSETS = path.join(ROOT, 'assets', 'skills', 'orchestrate', 'SKILL.md');

test('tech-lead.md instructs the reviewer to report an "impact if not fixed" statement', () => {
  const src = fs.readFileSync(TL_PROJECT, 'utf8');
  assert.match(src, /impact if not fixed/i);
  assert.match(src, /1[–-]3 sentences/);
});

test('SKILL.md Phase 4 requires a "## Impact If Not Fixed" section on follow-up tickets', () => {
  const src = fs.readFileSync(SKILL_PROJECT, 'utf8');
  assert.match(src, /## Impact If Not Fixed/);
});

test('SKILL.md Phase 4 requires a review-of: <reviewed ticket id> frontmatter key', () => {
  const src = fs.readFileSync(SKILL_PROJECT, 'utf8');
  assert.match(src, /review-of:\s*<reviewed ticket id>/);
});

test('assets/agents/tech-lead.md is byte-identical to the .claude copy', () => {
  assert.ok(fs.readFileSync(TL_ASSETS).equals(fs.readFileSync(TL_PROJECT)),
    'tech-lead.md assets === project (drift guard)');
});

test('assets SKILL.md is byte-identical to the .claude copy', () => {
  assert.ok(fs.readFileSync(SKILL_ASSETS).equals(fs.readFileSync(SKILL_PROJECT)),
    'SKILL.md assets === project (drift guard)');
});
