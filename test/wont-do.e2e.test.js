'use strict';

// e2e cucumber-style (Given/When/Then) scenarios for TASK-074, implementing the
// ticket's Gherkin. These are node --test scenario cases — NO `cucumber` package.
//
// The task modal save path (openTaskModal's doWrite / fill / onSave) and the
// drag move (moveTicketToStatus) are DOM-bound and talk to disk only through
// `window.api.fs.{readFile,writeFile}`. We drive the REAL, DOM-free helpers
// extracted from renderer.js (serializeTicket, parseTicketFrontmatter,
// isWontDoTicket) against a fully MOCKED in-memory filesystem — no real DB, no
// real disk write, no network, no Electron. Each scenario reproduces the exact
// renderer branch under test (asserted to exist in wont-do.test.js's source
// scan) and verifies the persisted frontmatter + rendered class outcome.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
const ticketLanes = require('../lib/ticket-lanes');

// --- Extract DOM-free helpers from renderer.js (single source of truth) ------
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} present`);
  let depth = 0;
  let i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) { i++; break; }
  }
  return src.slice(start, i);
}
const PURE = ['ticketFieldNonEmpty', 'isWontDoTicket', 'frontmatterValueLine',
  'serializeTicket', 'parseTicketFrontmatter'];
// eslint-disable-next-line no-new-func
const R = new Function(PURE.map((n) => extractFunction(rendererSrc, n)).join('\n') +
  '\nreturn { ' + PURE.join(', ') + ' };')();

// --- Mock in-memory filesystem standing in for window.api.fs -----------------
function makeMockFs(seed = {}) {
  const files = new Map(Object.entries(seed));
  let failWrite = null; // set to an error string to simulate a write failure
  return {
    files,
    setWriteFailure(err) { failWrite = err; },
    async readFile(p) {
      if (!files.has(p)) return { ok: false, error: 'ENOENT' };
      return { ok: true, binary: false, content: files.get(p) };
    },
    async writeFile(p, content) {
      if (failWrite) return { ok: false, error: failWrite };
      files.set(p, content);
      return { ok: true };
    },
  };
}

// --- Faithful mirror of openTaskModal.doWrite's frontmatter mapping ----------
// (Source-scanned to match renderer.js in test/wont-do.test.js.) Given the
// current fm, the body, and the status-select value the user is saving, produce
// the new frontmatter exactly as doWrite would, then persist via the mock fs.
async function saveViaModal(mockFs, ticketPath, fm, body, selectValue, now) {
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
  if (!wr || !wr.ok) {
    return { ok: false, error: 'Save failed: ' + ((wr && wr.error) || 'unknown') };
  }
  return { ok: true };
}

// Mirror of fill()'s status-select choice: won't-do tickets show __wont-do__.
function selectValueForFill(fm) {
  return R.isWontDoTicket(fm) ? '__wont-do__'
    : (fm.status != null && String(fm.status).trim() !== '' ? String(fm.status) : 'todo');
}

// Faithful mirror of moveTicketToStatus's write (plain drag). TASK-080: it sets
// the new status and CLEARS a lingering exact `wont-do` marker using the SAME
// predicate doWrite's revert path uses (source-scanned in wont-do.test.js). It
// never assigns a wont-do marker — that is modal-only.
async function dragMove(mockFs, ticketPath, fm, body, newStatus, now) {
  const newFm = Object.assign({}, fm);
  newFm.status = newStatus;
  if (newFm.resolution != null && String(newFm.resolution).trim() === 'wont-do') {
    delete newFm.resolution;
  }
  newFm.updated = now;
  if (!newFm.created) newFm.created = newFm.updated;
  await mockFs.writeFile(ticketPath, R.serializeTicket(newFm, body));
}

const P = '/proj/tasks/todo/TASK-080.md';

// ===========================================================================
// Scenario: User marks a ticket as won't do
// ===========================================================================
test('Scenario: user selects "Won\'t do" and saves -> done + resolution wont-do', async () => {
  // Given a ticket TASK-080 with status "todo" open in the task modal
  const created = '2026-07-19T10:00:00.000Z';
  const fm = { id: 'TASK-080', title: 'Maybe skip me', status: 'todo', created,
    updated: '2026-07-19T10:00:00.000Z' };
  const body = '## Description\nstuff\n\n## Additional Context\nUSER OWNED — keep me';
  const mockFs = makeMockFs({ [P]: R.serializeTicket(fm, body) });

  // When the user selects "Won't do" in the status dropdown and saves
  const now = '2026-07-20T09:00:00.000Z';
  const res = await saveViaModal(mockFs, P, fm, body, '__wont-do__', now);
  assert.equal(res.ok, true);

  // Then the ticket file is rewritten whole with status done + resolution wont-do
  const parsed = R.parseTicketFrontmatter(mockFs.files.get(P));
  assert.equal(parsed.fm.status, 'done');
  assert.equal(parsed.fm.resolution, 'wont-do');
  // And "updated" is bumped and "created" preserved
  assert.equal(parsed.fm.updated, now);
  assert.equal(parsed.fm.created, created);
  // And the user-owned Additional Context is untouched
  assert.match(parsed.body, /## Additional Context\nUSER OWNED — keep me/);
  // And the card renders in the Done lane with a struck-through title
  assert.equal(ticketLanes.laneForStatus(parsed.fm.status), 'done');
  assert.equal(R.isWontDoTicket(parsed.fm), true, 'render adds the .wont-do class');
});

// ===========================================================================
// Scenario: Won't-do round-trips through the modal
// ===========================================================================
test('Scenario: won\'t-do round-trips — reopen shows "Won\'t do", re-save preserves it', async () => {
  // Given a ticket with status done + resolution wont-do
  const created = '2026-07-18T00:00:00.000Z';
  const fm = { id: 'TASK-081', title: 'Declined', status: 'done', created,
    updated: '2026-07-19T00:00:00.000Z', resolution: 'wont-do' };
  const body = 'body';
  const mockFs = makeMockFs({ [P]: R.serializeTicket(fm, body) });

  // When the user opens it in the task modal
  const disk = R.parseTicketFrontmatter(mockFs.files.get(P));
  // Then the status select shows "Won't do" selected
  assert.equal(selectValueForFill(disk.fm), '__wont-do__');

  // When the user saves without changing the select
  const now = '2026-07-20T00:00:00.000Z';
  await saveViaModal(mockFs, P, disk.fm, disk.body, '__wont-do__', now);
  // Then status remains done and resolution remains wont-do
  const after = R.parseTicketFrontmatter(mockFs.files.get(P));
  assert.equal(after.fm.status, 'done');
  assert.equal(after.fm.resolution, 'wont-do');
  assert.equal(after.fm.created, created, 'created preserved across the re-save');
});

// ===========================================================================
// Scenario: Reverting won't-do clears the marker
// ===========================================================================
test('Scenario: selecting "Done" on a won\'t-do ticket clears the resolution key', async () => {
  // Given a ticket with status done + resolution wont-do
  const fm = { id: 'TASK-082', title: 'Un-decline me', status: 'done',
    created: '2026-07-18T00:00:00.000Z', updated: '2026-07-19T00:00:00.000Z',
    resolution: 'wont-do' };
  const mockFs = makeMockFs({ [P]: R.serializeTicket(fm, 'body') });

  // When the user selects "Done" and saves
  await saveViaModal(mockFs, P, fm, 'body', 'done', '2026-07-20T00:00:00.000Z');

  // Then the resolution key is absent from the rewritten frontmatter
  const after = R.parseTicketFrontmatter(mockFs.files.get(P));
  assert.equal(after.fm.status, 'done');
  assert.equal(after.fm.resolution, undefined, 'resolution key removed');
  assert.ok(!/resolution/.test(mockFs.files.get(P)), 'no resolution line on disk');
  assert.equal(R.isWontDoTicket(after.fm), false);
});

test('Scenario (edge): reverting does NOT clear an unrelated resolution value', async () => {
  // A resolution that is not exactly "wont-do" round-trips untouched as an
  // unknown key when the user picks a real status.
  const fm = { id: 'TASK-083', title: 'Fixed one', status: 'done',
    created: '2026-07-18T00:00:00.000Z', updated: '2026-07-19T00:00:00.000Z',
    resolution: 'fixed' };
  const mockFs = makeMockFs({ [P]: R.serializeTicket(fm, 'body') });
  await saveViaModal(mockFs, P, fm, 'body', 'done', '2026-07-20T00:00:00.000Z');
  const after = R.parseTicketFrontmatter(mockFs.files.get(P));
  assert.equal(after.fm.resolution, 'fixed', 'unrelated resolution preserved');
});

// ===========================================================================
// Scenario: Drag to Done does not mark won't-do (edge)
// ===========================================================================
test('Scenario (edge): plain drag-to-Done sets status done and NO resolution', async () => {
  // Given a ticket dragged onto the Done lane
  const fm = { id: 'TASK-084', title: 'Just done', status: 'in-progress',
    created: '2026-07-18T00:00:00.000Z', updated: '2026-07-19T00:00:00.000Z' };
  const mockFs = makeMockFs({ [P]: R.serializeTicket(fm, 'body') });

  // When the move is written
  await dragMove(mockFs, P, fm, 'body', 'done', '2026-07-20T00:00:00.000Z');

  // Then status is done and no resolution key is set
  const after = R.parseTicketFrontmatter(mockFs.files.get(P));
  assert.equal(after.fm.status, 'done');
  assert.equal(after.fm.resolution, undefined);
  assert.equal(R.isWontDoTicket(after.fm), false, 'a plain-drag done is NOT struck through');
});

// ===========================================================================
// TASK-080 Feature: Plain drag-to-Done never resurrects a wont-do marker
// ===========================================================================

// Drift guard: the e2e dragMove mirror above must faithfully reflect the REAL
// moveTicketToStatus clear predicate in renderer.js. If product source drifts,
// this fails so the mirror can't quietly diverge.
test('TASK-080 drift guard: dragMove mirror matches moveTicketToStatus clear predicate in renderer.js', () => {
  const start = rendererSrc.indexOf('async function moveTicketToStatus(');
  assert.notEqual(start, -1, 'moveTicketToStatus present in renderer.js');
  const body = rendererSrc.slice(start, rendererSrc.indexOf('\n}', start) + 2);
  assert.match(body, /newFm\.status = newStatus;/);
  assert.match(body, /newFm\.resolution != null && String\(newFm\.resolution\)\.trim\(\) === 'wont-do'\)\s*\{\s*delete newFm\.resolution;/);
  assert.ok(!/newFm\.resolution\s*=\s*'wont-do'/.test(body),
    'the drag path must never assign resolution: wont-do');
});

test('TASK-080 Scenario: dragging a wont-do ticket out then back to Done clears the marker', async () => {
  // Given a ticket with status "done" and resolution "wont-do"
  const created = '2026-07-18T00:00:00.000Z';
  const fm = { id: 'TASK-080', title: 'Reconsidered', status: 'done', created,
    updated: '2026-07-19T00:00:00.000Z', resolution: 'wont-do' };
  const body = '## Description\nwork\n\n## Additional Context\nUSER OWNED — keep me';
  const mockFs = makeMockFs({ [P]: R.serializeTicket(fm, body) });
  // Sanity: it starts life as a struck-through won't-do card.
  const seed = R.parseTicketFrontmatter(mockFs.files.get(P));
  assert.equal(R.isWontDoTicket(seed.fm), true);

  // When the user drags it to the "in-progress" lane
  await dragMove(mockFs, P, seed.fm, seed.body, 'in-progress', '2026-07-20T09:00:00.000Z');

  // Then the written frontmatter has status "in-progress" and no "resolution: wont-do"
  const out1 = R.parseTicketFrontmatter(mockFs.files.get(P));
  assert.equal(out1.fm.status, 'in-progress');
  assert.equal(out1.fm.resolution, undefined);
  assert.ok(!/resolution/.test(mockFs.files.get(P)), 'no resolution line lingering on disk');
  // And the user-owned Additional Context is untouched, created preserved.
  assert.match(out1.body, /## Additional Context\nUSER OWNED — keep me/);
  assert.equal(out1.fm.created, created);

  // When the user later drags it back onto the Done lane (plain drag)
  await dragMove(mockFs, P, out1.fm, out1.body, 'done', '2026-07-20T10:00:00.000Z');

  // Then the written frontmatter has status "done" and no "resolution: wont-do"
  const out2 = R.parseTicketFrontmatter(mockFs.files.get(P));
  assert.equal(out2.fm.status, 'done');
  assert.equal(out2.fm.resolution, undefined);
  assert.ok(!/resolution/.test(mockFs.files.get(P)), 'no resurrected wont-do marker');
  // And the card renders with a normal (not struck-through) title.
  assert.equal(ticketLanes.laneForStatus(out2.fm.status), 'done');
  assert.equal(R.isWontDoTicket(out2.fm), false, 'render must NOT add the .wont-do class');
});

test('TASK-080 Scenario (edge): the modal "Won\'t do" path still SETS the marker (unchanged)', async () => {
  // Given a ticket open in the task modal
  const fm = { id: 'TASK-080', title: 'Decline me', status: 'in-progress',
    created: '2026-07-18T00:00:00.000Z', updated: '2026-07-19T00:00:00.000Z' };
  const mockFs = makeMockFs({ [P]: R.serializeTicket(fm, 'body') });
  // When the user selects "Won't do" and saves
  await saveViaModal(mockFs, P, fm, 'body', '__wont-do__', '2026-07-20T00:00:00.000Z');
  // Then the frontmatter has status "done" and resolution "wont-do"
  const after = R.parseTicketFrontmatter(mockFs.files.get(P));
  assert.equal(after.fm.status, 'done');
  assert.equal(after.fm.resolution, 'wont-do');
  assert.equal(R.isWontDoTicket(after.fm), true);
});

test('TASK-080 Scenario (edge): plain drag-to-Done on a normal ticket writes NO resolution key', async () => {
  // Given a normal ticket with no resolution
  const fm = { id: 'TASK-080', title: 'Plain', status: 'testing',
    created: '2026-07-18T00:00:00.000Z', updated: '2026-07-19T00:00:00.000Z' };
  const mockFs = makeMockFs({ [P]: R.serializeTicket(fm, 'body') });
  // When it is dragged onto the Done lane
  await dragMove(mockFs, P, fm, 'body', 'done', '2026-07-20T00:00:00.000Z');
  // Then status is "done" and no resolution key is written
  const after = R.parseTicketFrontmatter(mockFs.files.get(P));
  assert.equal(after.fm.status, 'done');
  assert.equal(after.fm.resolution, undefined);
  assert.ok(!/resolution/.test(mockFs.files.get(P)), 'no spurious resolution key added');
});

test('TASK-080 Scenario (edge): a ticket with a DIFFERENT resolution (fixed) is NOT cleared by a drag', async () => {
  // Given a done ticket whose resolution is "fixed" (not exactly wont-do)
  const fm = { id: 'TASK-080', title: 'Fixed one', status: 'done',
    created: '2026-07-18T00:00:00.000Z', updated: '2026-07-19T00:00:00.000Z',
    resolution: 'fixed' };
  const mockFs = makeMockFs({ [P]: R.serializeTicket(fm, 'body') });
  // When it is dragged to another lane and back
  await dragMove(mockFs, P, fm, 'body', 'in-progress', '2026-07-20T00:00:00.000Z');
  const mid = R.parseTicketFrontmatter(mockFs.files.get(P));
  assert.equal(mid.fm.resolution, 'fixed', 'unrelated resolution round-trips untouched on move out');
  await dragMove(mockFs, P, mid.fm, mid.body, 'done', '2026-07-20T01:00:00.000Z');
  // Then the "fixed" resolution survives untouched (exact-match guard)
  const after = R.parseTicketFrontmatter(mockFs.files.get(P));
  assert.equal(after.fm.status, 'done');
  assert.equal(after.fm.resolution, 'fixed');
  assert.equal(R.isWontDoTicket(after.fm), false, 'fixed is a normal done, not struck-through');
});

// ===========================================================================
// Scenario: The status enum is not expanded (edge)
// ===========================================================================
test('Scenario (edge): VALID_STATUSES lacks wont-do; literal status wont-do -> unknown lane', () => {
  // Given lib/ticket-lanes.js
  assert.ok(!ticketLanes.VALID_STATUSES.includes('wont-do'));
  // And a ticket whose frontmatter status is literally wont-do routes to unknown
  assert.equal(ticketLanes.laneForStatus('wont-do'), 'unknown');
  assert.notEqual(ticketLanes.laneForStatus('wont-do'), 'done');
});

// ===========================================================================
// Scenario: Won't-do write failure surfaces an error (failure path)
// ===========================================================================
test('Scenario (failure): a failed write surfaces an error and leaves the file unchanged', async () => {
  // Given the ticket file write fails
  const created = '2026-07-19T10:00:00.000Z';
  const fm = { id: 'TASK-085', title: 'Save will fail', status: 'todo', created,
    updated: created };
  const original = R.serializeTicket(fm, 'body');
  const mockFs = makeMockFs({ [P]: original });
  mockFs.setWriteFailure('EACCES: permission denied');

  // When the user saves "Won't do"
  const res = await saveViaModal(mockFs, P, fm, 'body', '__wont-do__', '2026-07-20T00:00:00.000Z');

  // Then the modal shows the save error ...
  assert.equal(res.ok, false);
  assert.match(res.error, /Save failed: EACCES/);
  // ... and the ticket file on disk is unchanged
  assert.equal(mockFs.files.get(P), original, 'disk content unchanged after failed write');
  const still = R.parseTicketFrontmatter(mockFs.files.get(P));
  assert.equal(still.fm.status, 'todo');
  assert.equal(still.fm.resolution, undefined);
});

// ===========================================================================
// TASK-081 Feature: Won't-do save respects the changed-on-disk overwrite guard
// ===========================================================================
//
// The real overwrite guard lives in openTaskModal's `onSave` (renderer.js
// ~6269-6285): it is a DOM-bound closure over `openRaw` / `errEl.dataset.mode`
// and `saveBtn` click events, so it cannot be evaluated headless. Following the
// repo's browser-only convention we drive a FAITHFUL MIRROR of that exact
// two-click state machine (openRaw snapshot -> read disk -> if changed, warn +
// arm overwrite mode + return; second click writes) wired to the mocked
// in-memory fs, and pin the mirror to renderer.js with a source-scan drift guard
// (below) so it cannot silently diverge. The mirror's doWrite half reuses the
// SAME won't-do mapping as saveViaModal, proving the guard is SHARED — the
// won't-do save flows through it exactly as a normal save does.
function makeModalGuard(mockFs, ticketPath, fm, body, openRaw) {
  const state = { openRaw, errMode: '', errText: '', writes: 0 };
  // Mirror of doWrite (mapping identical to saveViaModal / source-scanned).
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
    if (!wr || !wr.ok) {
      state.errText = 'Save failed: ' + ((wr && wr.error) || 'unknown');
      return { ok: false };
    }
    state.writes++;
    return { ok: true };
  }
  // Mirror of onSave: the shared changed-on-disk two-click guard.
  async function onSave(selectValue, now) {
    if (state.errMode === 'overwrite') { return await doWrite(selectValue, now); }
    let diskRaw = state.openRaw;
    try {
      const fr = await mockFs.readFile(ticketPath);
      if (fr && fr.ok) diskRaw = fr.content;
    } catch (_) { /* keep openRaw snapshot */ }
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

// Drift guard: the mirror above must faithfully reflect the REAL onSave guard in
// renderer.js. If the product guard is refactored, this fails so the mirror can't
// quietly diverge (the ticket's fallback requirement when a behavioral test on
// the real DOM-bound onSave is impractical).
test('TASK-081 drift guard: makeModalGuard mirror matches onSave changed-on-disk guard in renderer.js', () => {
  const start = rendererSrc.indexOf('const onSave = async () =>');
  assert.notEqual(start, -1, 'onSave present in renderer.js');
  const body = rendererSrc.slice(start, rendererSrc.indexOf('saveBtn.addEventListener', start));
  // Second click short-circuits straight to doWrite when overwrite is armed.
  assert.match(body, /if \(errEl\.dataset\.mode === 'overwrite'\) \{ await doWrite\(\); return; \}/);
  // First click snapshots openRaw, reads disk, and compares.
  assert.match(body, /let diskRaw = openRaw;/);
  assert.match(body, /const fr = await window\.api\.fs\.readFile\(ticketPath\);/);
  assert.match(body, /if \(fr && fr\.ok\) diskRaw = fr\.content;/);
  // Changed-on-disk -> warn, arm overwrite mode, advance openRaw, and RETURN
  // (blocked) — no write on the first click.
  assert.match(body, /if \(diskRaw !== openRaw\) \{/);
  assert.match(body, /errEl\.textContent = 'This ticket changed on disk[^']*Click Save again to overwrite\.';/);
  assert.match(body, /errEl\.dataset\.mode = 'overwrite';/);
  assert.match(body, /openRaw = diskRaw;/);
  // Unchanged -> straight through to the shared doWrite (same path as a normal save).
  assert.match(body, /await doWrite\(\);/);
});

test('TASK-081 Scenario: a won\'t-do save on a changed-on-disk ticket needs two clicks', async () => {
  // Given a ticket TASK-081 opened in the modal with status "todo"
  const created = '2026-07-19T10:00:00.000Z';
  const fm = { id: 'TASK-081', title: 'Maybe skip', status: 'todo', created,
    updated: created };
  const body = '## Description\nwork\n\n## Additional Context\nUSER OWNED — keep me';
  const openRaw = R.serializeTicket(fm, body);
  const mockFs = makeMockFs({ [P]: openRaw });
  const { state, onSave } = makeModalGuard(mockFs, P, fm, body, openRaw);

  // And an agent rewrites the file on disk AFTER it was opened (a status bump)
  const agentFm = Object.assign({}, fm, { status: 'in-progress',
    updated: '2026-07-20T08:00:00.000Z' });
  mockFs.files.set(P, R.serializeTicket(agentFm, body));
  const diskBeforeSave = mockFs.files.get(P);

  // When the user selects "Won't do" and saves ONCE
  const first = await onSave('__wont-do__', '2026-07-20T09:00:00.000Z');
  // Then the save is blocked and the modal warns the file changed on disk
  assert.equal(first.ok, false);
  assert.equal(first.blocked, true);
  assert.match(state.errText, /changed on disk/);
  assert.match(state.errText, /Click Save again to overwrite/);
  assert.equal(state.writes, 0, 'first click writes nothing');
  // And the agent's disk content is untouched by the blocked save
  assert.equal(mockFs.files.get(P), diskBeforeSave, 'blocked save must not clobber the disk');

  // When the user saves a SECOND time to confirm
  const second = await onSave('__wont-do__', '2026-07-20T09:00:00.000Z');
  // Then the file is overwritten with status "done" and resolution "wont-do"
  assert.equal(second.ok, true);
  assert.equal(state.writes, 1, 'the confirm click performs exactly one write');
  const after = R.parseTicketFrontmatter(mockFs.files.get(P));
  assert.equal(after.fm.status, 'done');
  assert.equal(after.fm.resolution, 'wont-do');
  assert.equal(R.isWontDoTicket(after.fm), true, 'the overwrite persists the won\'t-do marker');
  // And the user-owned Additional Context is preserved, created preserved.
  assert.match(after.body, /## Additional Context\nUSER OWNED — keep me/);
  assert.equal(after.fm.created, created);
});

test('TASK-081 Scenario (edge): the guard is SHARED — an unchanged-on-disk won\'t-do save writes on the FIRST click', async () => {
  // Given a ticket whose disk content still matches what was opened (no race)
  const fm = { id: 'TASK-081', title: 'No race', status: 'todo',
    created: '2026-07-19T10:00:00.000Z', updated: '2026-07-19T10:00:00.000Z' };
  const body = 'body';
  const openRaw = R.serializeTicket(fm, body);
  const mockFs = makeMockFs({ [P]: openRaw });
  const { state, onSave } = makeModalGuard(mockFs, P, fm, body, openRaw);

  // When the user selects "Won't do" and saves once
  const res = await onSave('__wont-do__', '2026-07-20T09:00:00.000Z');
  // Then it flows straight through the shared guard to the write — no second
  // click needed, exactly as a normal save behaves when nothing changed on disk.
  assert.equal(res.ok, true);
  assert.equal(state.errMode, '', 'overwrite mode was never armed');
  assert.equal(state.writes, 1);
  const after = R.parseTicketFrontmatter(mockFs.files.get(P));
  assert.equal(after.fm.status, 'done');
  assert.equal(after.fm.resolution, 'wont-do');
});

test('TASK-081 Scenario (edge): the two-click semantics are identical for a NORMAL save (guard not won\'t-do-specific)', async () => {
  // The same mirror, driven with a plain status, must block-then-overwrite the
  // same way — proving the won't-do mapping does not bypass or special-case the guard.
  const fm = { id: 'TASK-081', title: 'Plain', status: 'todo',
    created: '2026-07-19T10:00:00.000Z', updated: '2026-07-19T10:00:00.000Z' };
  const body = 'body';
  const openRaw = R.serializeTicket(fm, body);
  const mockFs = makeMockFs({ [P]: openRaw });
  const { state, onSave } = makeModalGuard(mockFs, P, fm, body, openRaw);
  // Agent changes the file on disk after open.
  mockFs.files.set(P, R.serializeTicket(Object.assign({}, fm, { title: 'Renamed by agent' }), body));

  const first = await onSave('in-progress', '2026-07-20T09:00:00.000Z');
  assert.equal(first.blocked, true, 'a normal save is blocked on the first click too');
  assert.equal(state.writes, 0);
  const second = await onSave('in-progress', '2026-07-20T09:00:00.000Z');
  assert.equal(second.ok, true);
  const after = R.parseTicketFrontmatter(mockFs.files.get(P));
  assert.equal(after.fm.status, 'in-progress');
  assert.equal(after.fm.resolution, undefined, 'a normal save writes no wont-do marker');
});

// ===========================================================================
// Scenario: Reviewer instructions require an impact statement (Part 1)
// ===========================================================================
test('Scenario: tech-lead.md requires an impact statement; assets copy byte-identical', () => {
  // Given the tech-lead agent definition
  const proj = path.join(ROOT, '.claude', 'agents', 'tech-lead.md');
  const assets = path.join(ROOT, 'assets', 'agents', 'tech-lead.md');
  const src = fs.readFileSync(proj, 'utf8');
  // Then it instructs the reviewer to report the impact if a finding is not fixed
  assert.match(src, /impact if not fixed/i);
  // And the assets copy is byte-identical
  assert.ok(fs.readFileSync(assets).equals(fs.readFileSync(proj)));
});

// ===========================================================================
// Scenario: Orchestrator instructions require the Impact section + review-of
// ===========================================================================
test('Scenario: SKILL.md Phase 4 requires "## Impact If Not Fixed" + review-of; assets byte-identical', () => {
  // Given the orchestrate SKILL.md Phase 4 instructions
  const proj = path.join(ROOT, '.claude', 'skills', 'orchestrate', 'SKILL.md');
  const assets = path.join(ROOT, 'assets', 'skills', 'orchestrate', 'SKILL.md');
  const src = fs.readFileSync(proj, 'utf8');
  // Then follow-up fix tickets must contain a "## Impact If Not Fixed" section
  assert.match(src, /## Impact If Not Fixed/);
  // And must carry a review-of frontmatter key naming the reviewed ticket
  assert.match(src, /review-of:\s*<reviewed ticket id>/);
  // And the assets SKILL.md copy is byte-identical
  assert.ok(fs.readFileSync(assets).equals(fs.readFileSync(proj)));
});
