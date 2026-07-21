'use strict';

// ===========================================================================
// TASK-102 — e2e "cucumber" scenarios (Given / When / Then), written as plain
// `node --test` cases (NO cucumber npm package is installed or required).
//
// Feature: User-column status changes — the ticket modal dropdown is
// config-driven, dropping a card onto a user lane rewrites its status via the
// whole-file write path (bumping `updated`) and files it into tasks/<slug>/,
// removed-column statuses are left in place and route to `unknown`, an active
// claimed ticket cannot be yanked into a user lane, and NO untrusted status
// string can ever be turned into a filesystem path.
//
// Two headless harnesses drive the REAL renderer/renderer.js code (a browser
// script that is not require()-able):
//   - the shared task-101 lane harness (mock DOM) for the modal-dropdown builder
//     and the drag/drop refusal path;
//   - a small filesystem harness in THIS file that loads the REAL
//     moveTicketToStatus / relocateTicketFile / reconcileTicketFolders over a
//     Map-backed mock window.api.fs whose fs:rename REFUSES when the target
//     already exists (matching main.js).
//
// NO DATABASE, REAL FILESYSTEM WRITE, OR NETWORK CALL IS MADE — every DB/fs call
// is mocked by construction; the only disk read is the app's own source.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const laneHarness = require('./helpers/task-101-lane-harness');
const { rendererSrc, makeDocument, makeWindow, makeTab, ticketsMap, fire, findAllByClass } = laneHarness;

// A config that inserts a `ux-review` user column right after `testing` — seven
// declared columns (six system + one user).
const CONFIG_UX = {
  columns: [
    { status: 'todo' }, { status: 'defining' }, { status: 'in-progress' },
    { status: 'testing' }, { status: 'ux-review', label: 'UX Review' },
    { status: 'post-processing' }, { status: 'done' },
  ],
};
// The same board WITHOUT the ux-review column (i.e. after that column was removed).
const CONFIG_NO_UX = {
  columns: [
    { status: 'todo' }, { status: 'defining' }, { status: 'in-progress' },
    { status: 'testing' }, { status: 'post-processing' }, { status: 'done' },
  ],
};

// ---------------------------------------------------------------------------
// A dedicated filesystem harness. The shared lane harness deliberately STUBS
// moveTicketToStatus / relocateTicketFile / reconcileTicketFolders (it drives
// the render/drag DOM path), so here we load the REAL versions of those to prove
// the write-then-rename plumbing end to end against a mock disk.
// ---------------------------------------------------------------------------
function extractFn(src, name) {
  let start = src.indexOf('function ' + name + '(');
  assert.ok(start !== -1, `function ${name} in renderer.js`);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) { i += 1; break; } }
  }
  return src.slice(start, i);
}
function extractConst(src, name) {
  const m = src.match(new RegExp('const\\s+' + name + '\\s*=[\\s\\S]*?;'));
  assert.ok(m, `const ${name} in renderer.js`);
  return m[0];
}

// Map-backed mock fs; fs:rename refuses when the destination already exists,
// exactly like main.js's IPC handler. Every call is recorded for assertions.
function makeFsMock() {
  const files = new Map();
  const dirs = new Set();
  const calls = { write: [], mkdir: [], rename: [], read: [] };
  return {
    files, dirs, calls,
    async readFile(p) {
      calls.read.push(p);
      return files.has(p) ? { ok: true, binary: false, content: files.get(p) } : { ok: false, error: 'ENOENT' };
    },
    async writeFile(p, content) { calls.write.push(p); files.set(p, content); return { ok: true }; },
    async mkdir(d) { calls.mkdir.push(d); dirs.add(d); return { ok: true }; },
    async rename(o, n) {
      calls.rename.push({ from: o, to: n });
      if (!o || !n) return { ok: false, error: 'oldPath and newPath required' };
      if (files.has(n)) return { ok: false, error: 'Target already exists' };
      if (!files.has(o)) return { ok: false, error: 'ENOENT' };
      files.set(n, files.get(o));
      files.delete(o);
      return { ok: true };
    },
  };
}

function loadFsModule() {
  const window = { __calls: {}, api: { fs: makeFsMock() } };
  const document = makeDocument();
  const body = [
    extractConst(rendererSrc, 'TASKS_LANE_STATUSES'),
    extractConst(rendererSrc, 'TASKS_VALID_STATUSES'),
    extractConst(rendererSrc, 'TASKS_ACTIVE_STATUSES'),
    extractConst(rendererSrc, 'TASKS_UNKNOWN_STATUS'),
    extractConst(rendererSrc, 'TASKS_SYSTEM_LABELS'),
    extractConst(rendererSrc, 'TASKS_RESERVED_SLUGS'),
    extractConst(rendererSrc, 'TASKS_MAX_SLUG_LENGTH'),
    extractConst(rendererSrc, 'TASKS_SLUG_RE'),
    extractFn(rendererSrc, 'tasksPrettifyLabel'),
    extractFn(rendererSrc, 'tasksBuildColumn'),
    extractFn(rendererSrc, 'normalizeTasksColumns'),
    extractFn(rendererSrc, 'tasksUserStatusSet'),
    extractFn(rendererSrc, 'inferSep'),
    extractFn(rendererSrc, 'appendPath'),
    extractFn(rendererSrc, 'tasksJoin'),
    extractFn(rendererSrc, 'tasksBasename'),
    extractFn(rendererSrc, 'tasksSubfolder'),
    extractFn(rendererSrc, 'ticketFolderForStatus'),
    extractFn(rendererSrc, 'ticketFolderMatchesStatus'),
    extractFn(rendererSrc, 'isSafeTasksSlug'),
    extractFn(rendererSrc, 'ticketFolderForStatusWith'),
    extractFn(rendererSrc, 'ticketFolderMatchesStatusWith'),
    extractFn(rendererSrc, 'dedupeTicketsByFolder'),
    extractFn(rendererSrc, 'parseTicketFrontmatter'),
    extractFn(rendererSrc, 'frontmatterValueLine'),
    extractFn(rendererSrc, 'serializeTicket'),
    extractFn(rendererSrc, 'ticketFieldNonEmpty'),
    extractFn(rendererSrc, 'relocateTicketFile'),
    extractFn(rendererSrc, 'reconcileTicketFolders'),
    // TASK-111 — moveTicketToStatus now re-applies the shared active+claim refusal
    // predicate against the FRESH on-disk frontmatter before writing. Extract it or
    // the move throws ReferenceError. (TASKS_ACTIVE_STATUSES / ticketFieldNonEmpty /
    // tasksUserStatusSet / normalizeTasksColumns are already extracted above.)
    extractFn(rendererSrc, 'tasksActiveClaimRefusal'),
    extractFn(rendererSrc, 'moveTicketToStatus'),
    // The real move/reconcile re-poll on success; stub it to just record so no
    // DOM/IPC is touched.
    'function pollTasksOnce(tab, force){ (window.__calls.pollTasksOnce = window.__calls.pollTasksOnce || []).push(!!force); }',
    // TASK-111 — moveTicketToStatus's fresh re-check calls showTasksNotice on
    // refusal; the fs harness has no DOM notice element, so record the message.
    'function showTasksNotice(tab, message){ (window.__calls.showTasksNotice = window.__calls.showTasksNotice || []).push(String(message)); }',
    'return { moveTicketToStatus, relocateTicketFile, reconcileTicketFolders,',
    '  ticketFolderForStatusWith, tasksUserStatusSet, normalizeTasksColumns,',
    '  dedupeTicketsByFolder,',
    '  isSafeTasksSlug, tasksJoin, parseTicketFrontmatter, serializeTicket };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  const mod = new Function('window', 'document', 'console', body)(window, document, console);
  return { mod, window, fs: window.api.fs };
}

const ROOT = 'C:\\proj';

// Seed a single ticket on the mock disk + the in-memory board (tab.tasks.tickets).
function seedTicket(fs, mod, tab, spec) {
  const p = mod.tasksJoin(ROOT, 'tasks', spec.folder, `${spec.id}.md`);
  const fm = {
    id: spec.id, title: spec.title || spec.id, status: spec.status,
    created: spec.created || '2020-01-01T00:00:00.000Z',
    updated: spec.updated || '2020-01-01T00:00:00.000Z',
  };
  if (spec.agent) fm.agent = spec.agent;
  const content = mod.serializeTicket(fm, spec.body || '\n## Description\nseed\n');
  fs.files.set(p, content);
  const ticket = { file: `${spec.id}.md`, path: p, folder: spec.folder, fm, body: spec.body || '\n## Description\nseed\n' };
  tab.tasks.tickets.set(ticket.file, ticket);
  return { path: p, ticket };
}

function relPaths(fs) {
  const base = 'C:\\proj\\tasks\\';
  return Array.from(fs.files.keys()).map((p) => p.slice(base.length).replace(/\\/g, '/')).sort();
}

// ===========================================================================
// Scenario: Drag a ticket into a user lane
//   Given a todo ticket and a configured ux-review lane
//   When the user drops the card on ux-review
//   Then the ticket file is rewritten once with status "ux-review" & updated bumped
//   And reconciliation files it under tasks/ux-review/
// ===========================================================================
test('Scenario: dropping a todo card on the ux-review lane rewrites it ONCE and files it under tasks/ux-review/', async () => {
  const { mod, fs } = loadFsModule();
  const tab = { folder: ROOT, tasks: { tickets: new Map(), config: CONFIG_UX, reconciling: false } };
  // Given a todo ticket in tasks/todo/ and a configured ux-review lane.
  const { path: oldPath } = seedTicket(fs, mod, tab, { id: 'TASK-9', status: 'todo', folder: 'todo' });
  assert.deepEqual(relPaths(fs), ['todo/TASK-9.md']);

  // When the drop moves it to the ux-review status.
  await mod.moveTicketToStatus(tab, 'TASK-9.md', 'ux-review');

  // Then the file was rewritten EXACTLY once (single whole-file write).
  assert.equal(fs.calls.write.length, 1, 'exactly one whole-file write');
  assert.equal(fs.calls.write[0], oldPath, 'the write targets the ticket\'s current path (write-then-rename)');
  // And reconciliation files it under tasks/ux-review/ (mkdir on demand + rename).
  const newPath = mod.tasksJoin(ROOT, 'tasks', 'ux-review', 'TASK-9.md');
  assert.ok(fs.dirs.has(mod.tasksJoin(ROOT, 'tasks', 'ux-review')), 'tasks/ux-review mkdir-ed on demand');
  assert.equal(fs.calls.rename.length, 1, 'a single atomic rename into the new folder');
  assert.deepEqual(relPaths(fs), ['ux-review/TASK-9.md'], 'no copy left behind in tasks/todo');
  // And the persisted frontmatter carries status ux-review with `updated` bumped.
  const after = mod.parseTicketFrontmatter(fs.files.get(newPath));
  assert.equal(after.fm.status, 'ux-review');
  assert.notEqual(after.fm.updated, '2020-01-01T00:00:00.000Z', 'updated was bumped');
  assert.equal(after.fm.created, '2020-01-01T00:00:00.000Z', 'created preserved');
});

test('Scenario: reconciliation moves a user-status ticket sitting in the wrong folder into tasks/ux-review/', async () => {
  const { mod, fs } = loadFsModule();
  const tab = { folder: ROOT, tasks: { tickets: new Map(), config: CONFIG_UX, reconciling: false } };
  // Given a ticket whose frontmatter status is ux-review but the file sits in tasks/todo.
  const { ticket } = seedTicket(fs, mod, tab, { id: 'TASK-10', status: 'ux-review', folder: 'todo' });
  assert.deepEqual(relPaths(fs), ['todo/TASK-10.md']);
  // When reconciliation runs over the discovered entries.
  await mod.reconcileTicketFolders(tab, [ticket]);
  // Then the file is relocated into tasks/ux-review/ (mkdir + atomic rename), no write.
  assert.equal(fs.calls.write.length, 0, 'reconcile relocates only — it never rewrites content');
  assert.deepEqual(relPaths(fs), ['ux-review/TASK-10.md']);
});

// ===========================================================================
// Scenario: Modal dropdown is config-driven
//   Given config with seven columns
//   Then the status select lists them in board order plus "Won't do"
// ===========================================================================
test('Scenario: the modal status select lists the configured columns in board order plus "Won\'t do"', () => {
  const document = makeDocument();
  const mod = laneHarness.loadLaneModule(makeWindow().window, document, console);
  // Given the seven-column config (six system + ux-review after testing).
  const sel = document.createElement('select');
  mod.populateTaskStatusOptions(sel, mod.normalizeTasksColumns(CONFIG_UX));
  // Then the select lists every column in board order, then the "Won't do" entry.
  assert.deepEqual(sel.children.map((o) => o.value),
    ['todo', 'defining', 'in-progress', 'testing', 'ux-review', 'post-processing', 'done', '__wont-do__']);
  // And values are the slugs while labels come from the config (ux-review's label).
  const ux = sel.children.find((o) => o.value === 'ux-review');
  assert.equal(ux.textContent, 'UX Review');
  assert.equal(sel.children[sel.children.length - 1].textContent, "Won't do");
});

// ===========================================================================
// Scenario: Removed column ticket (edge)
//   Given a ticket with status "ux-review" after that column was removed
//   Then it renders in the unknown lane and its file is never moved or rewritten
// ===========================================================================
test('Scenario (edge): a ticket whose column was removed renders in unknown and its file is never moved or rewritten', async () => {
  // Part 1 — rendering: with the ux-review column gone, the ticket routes to `unknown`.
  const { window } = makeWindow();
  const renderMod = laneHarness.loadLaneModule(window, makeDocument(), console);
  const rtab = makeTab({
    config: CONFIG_NO_UX,
    tickets: ticketsMap([{ fm: { id: 'TASK-11', title: 'orphan', status: 'ux-review' } }]),
  });
  renderMod.renderTasksBoard(rtab);
  const lanes = findAllByClass(rtab.els.tasksBoard, 'tasks-lane');
  const unknownLane = lanes.find((l) => l.dataset.status === 'unknown');
  assert.ok(unknownLane, 'the hidden unknown lane exists');
  const unknownCards = findAllByClass(unknownLane, 'task-card').map((c) => c.dataset.status);
  assert.deepEqual(unknownCards, ['ux-review'], 'the removed-column ticket is routed to unknown');
  // It is NOT dropped into todo.
  const todoLane = lanes.find((l) => l.dataset.status === 'todo');
  assert.equal(findAllByClass(todoLane, 'task-card').length, 0, 'not dumped into todo');

  // Part 2 — filesystem: reconciliation leaves the file exactly where it is.
  const { mod, fs } = loadFsModule();
  const tab = { folder: ROOT, tasks: { tickets: new Map(), config: CONFIG_NO_UX, reconciling: false } };
  const { ticket } = seedTicket(fs, mod, tab, { id: 'TASK-11', status: 'ux-review', folder: 'todo' });
  await mod.reconcileTicketFolders(tab, [ticket]);
  assert.equal(fs.calls.rename.length, 0, 'no rename — a removed-column status owns no folder');
  assert.equal(fs.calls.write.length, 0, 'no rewrite');
  assert.equal(fs.dirs.size, 0, 'no tasks/<slug>/ folder created');
  assert.deepEqual(relPaths(fs), ['todo/TASK-11.md'], 'the file stays put, no data loss');
  // And its target folder resolves to null (no folder ownership).
  const us = mod.tasksUserStatusSet(mod.normalizeTasksColumns(CONFIG_NO_UX));
  assert.equal(mod.ticketFolderForStatusWith('ux-review', us), null);
});

// ===========================================================================
// Scenario: Cannot yank an active ticket (failure)
//   Given an in-progress ticket claimed by an agent
//   When the user drops it on a user lane
//   Then the drop is refused with a notice and no write occurs
// ===========================================================================
test('Scenario (failure): dropping an in-progress claimed ticket on a user lane is refused with a notice and no write', async () => {
  const { window } = makeWindow();
  const mod = laneHarness.loadLaneModule(window, makeDocument(), console);
  // Given an in-progress ticket claimed by an agent, and a board with a ux-review lane.
  const tab = makeTab({
    config: CONFIG_UX,
    tickets: ticketsMap([
      { fm: { id: 'TASK-12', title: 'live work', status: 'in-progress', agent: 'orch-12' } },
      { fm: { id: 'TASK-13', title: 'idle', status: 'todo' } },
    ]),
  });
  mod.renderTasksBoard(tab);
  const lanes = findAllByClass(tab.els.tasksBoard, 'tasks-lane');
  const uxLane = lanes.find((l) => l.dataset.status === 'ux-review');
  assert.ok(uxLane, 'the ux-review user lane rendered');

  // When the user drops the claimed in-progress card onto the ux-review lane.
  await fire(uxLane, 'drop', { dataTransfer: { getData: () => 'TASK-12.md', setData() {} } });

  // Then the drop is refused: a notice is shown and moveTicketToStatus is NEVER called.
  const notices = window.__calls.showTasksNotice || [];
  assert.equal(notices.length, 1, 'a single refusal notice was shown');
  assert.match(notices[0], /orch-12/, 'the notice names the claiming agent');
  assert.match(notices[0], /TASK-12/, 'the notice names the ticket');
  assert.deepEqual(window.__calls.moveTicketToStatus || [], [], 'no status write was attempted');

  // Positive control: an UNCLAIMED idle (todo) card DOES move to the user lane.
  await fire(uxLane, 'drop', { dataTransfer: { getData: () => 'TASK-13.md', setData() {} } });
  const moves = window.__calls.moveTicketToStatus || [];
  assert.deepEqual(moves, [{ file: 'TASK-13.md', status: 'ux-review' }],
    'a non-active ticket moves normally, proving the guard is specific to live work');
});

// ===========================================================================
// Scenario (SECURITY): a traversal status never yields a tasks/<slug>/ path
// ===========================================================================
test('Scenario (security): a status like "../../evil" or ".." never produces a tasks/<slug>/ path', async () => {
  const { mod, fs } = loadFsModule();
  const tab = { folder: ROOT, tasks: { tickets: new Map(), config: CONFIG_UX, reconciling: false } };
  // A validated user-status set can never contain an unsafe slug (normalizeTasksColumns
  // drops it), so the folder helper returns null for traversal-shaped statuses.
  const us = mod.tasksUserStatusSet(mod.normalizeTasksColumns(CONFIG_UX));
  for (const evil of ['../../evil', '..', '.', 'a/b', 'a\\b', '..\\..\\evil']) {
    assert.equal(mod.ticketFolderForStatusWith(evil, us), null, `${evil} owns no folder`);
    // Even a forged "configured" set is re-gated by isSafeTasksSlug.
    assert.equal(mod.ticketFolderForStatusWith(evil, new Set([evil])), null,
      `${evil} is gated out even if it forges its way into userStatuses`);
    assert.equal(mod.isSafeTasksSlug(evil), false);
  }

  // And a relocate attempt with a traversal status touches the filesystem for NO
  // path at all — no mkdir, no rename, file left where it is.
  const src = mod.tasksJoin(ROOT, 'tasks', 'todo', 'TASK-14.md');
  fs.files.set(src, mod.serializeTicket({ id: 'TASK-14', status: '../../evil' }, 'x'));
  const r = await mod.relocateTicketFile(tab, src, 'TASK-14.md', '../../evil');
  assert.deepEqual(r, { ok: true, moved: false, path: src }, 'relocate is a safe no-op');
  assert.equal(fs.calls.mkdir.length, 0, 'no directory was ever created');
  assert.equal(fs.calls.rename.length, 0, 'no rename was ever attempted');
  assert.deepEqual(relPaths(fs), ['todo/TASK-14.md'], 'the file never left tasks/todo');
});

// ===========================================================================
// Scenario (TASK-120): a config-aware USER-column relocate hits a destination
// collision and REFUSES without overwriting or losing either copy. This exercises
// the rename-refusal branch (~renderer.js relocateTicketFile:8178-8180) through the
// TASK-102 user-slug path (CONFIG_UX's `ux-review`), which no test covered — the
// only prior collision test uses a SYSTEM slug over a frozen pre-102 copy.
//
//   Given a "TASK-15.md" (status ux-review) sitting in tasks/todo/
//   And a DIFFERENT copy of "TASK-15.md" already occupying tasks/ux-review/
//   When relocateTicketFile moves the todo copy to status "ux-review"
//   Then it returns { ok:false, moved:false, path:srcPath, error:/Target already exists/ }
//   And exactly one rename was attempted, no content write occurred
//   And the source and the occupant are both byte-identical to before
// ===========================================================================

// Seed the collision: the mover in tasks/todo/ + a distinguishable occupant already
// parked in tasks/ux-review/. Returns the paths + their exact original bytes.
function seedCollision(fs, mod, tab) {
  // The mover: status already `ux-review` but still filed under tasks/todo/.
  const { path: srcPath } = seedTicket(fs, mod, tab, {
    id: 'TASK-15', title: 'the mover', status: 'ux-review', folder: 'todo',
    body: '\n## Description\nthe todo copy trying to move\n',
  });
  // The pre-existing occupant already at tasks/ux-review/<same file> with DIFFERENT
  // content (distinguishable bytes prove nothing was clobbered). In the mock fs there
  // are no real dirs — "the ux-review folder is occupied" IS this file existing.
  const occPath = mod.tasksJoin(ROOT, 'tasks', 'ux-review', 'TASK-15.md');
  const occContent = mod.serializeTicket(
    { id: 'TASK-15', title: 'the pre-existing occupant', status: 'ux-review',
      created: '2019-01-01T00:00:00.000Z', updated: '2019-01-01T00:00:00.000Z' },
    '\n## Description\nthe occupant already parked in ux-review\n');
  fs.files.set(occPath, occContent);
  const srcBefore = fs.files.get(srcPath);
  const occBefore = fs.files.get(occPath);
  assert.notEqual(srcBefore, occBefore, 'the two copies have distinguishable bytes');
  return {
    srcPath, occPath, srcBefore, occBefore, fileName: 'TASK-15.md',
    moverEntry: tab.tasks.tickets.get('TASK-15.md'),
    // The dedupe entry for the occupant: it sits in ux-review/ and its status is ux-review.
    occEntry: { file: 'TASK-15.md', path: occPath, folder: 'ux-review',
      fm: { id: 'TASK-15', status: 'ux-review' }, body: '' },
  };
}

test('Scenario (TASK-120): a user-status relocate onto an occupied ux-review destination refuses and loses nothing', async () => {
  const { mod, fs } = loadFsModule();
  const tab = { folder: ROOT, tasks: { tickets: new Map(), config: CONFIG_UX, reconciling: false } };
  // Given the todo mover AND a different copy already occupying tasks/ux-review/.
  const { srcPath, occPath, srcBefore, occBefore, fileName } = seedCollision(fs, mod, tab);
  assert.deepEqual(relPaths(fs), ['todo/TASK-15.md', 'ux-review/TASK-15.md'], 'both copies present');

  // When the REAL config-aware relocate tries to file the todo copy under ux-review.
  const r = await mod.relocateTicketFile(tab, srcPath, fileName, 'ux-review');

  // Then it hits the rename-refusal branch and returns the no-data-loss contract.
  // `ok===false` asserted EXPLICITLY so this can never pass via the {ok:true,moved:false}
  // early returns (null target / unsafe slug / dest===src).
  assert.equal(r.ok, false, 'ok is strictly false — the rename refusal, not a safe no-op return');
  assert.equal(r.moved, false, 'nothing was moved');
  assert.equal(r.path, srcPath, 'the file stays at its source path');
  assert.match(r.error, /Target already exists/, 'error surfaces the destination-collision cause');

  // And the failure-branch fs shape: exactly one rename attempted, zero content writes.
  // (mkdir-on-demand IS expected before the rename — do NOT assert zero mkdir.)
  assert.equal(fs.calls.rename.length, 1, 'exactly one rename was attempted');
  assert.deepEqual(fs.calls.rename[0], { from: srcPath, to: occPath }, 'the rename targeted the occupied dest');
  assert.equal(fs.calls.write.length, 0, 'relocate never rewrites content — zero writeFile calls');

  // And no clobber / no data loss: both copies still exist, byte-identical to before.
  assert.deepEqual(relPaths(fs), ['todo/TASK-15.md', 'ux-review/TASK-15.md'], 'both copies remain');
  assert.equal(fs.files.get(srcPath), srcBefore, 'the source copy is byte-identical');
  assert.equal(fs.files.get(occPath), occBefore, 'the occupant copy is untouched');
});

// ===========================================================================
// Scenario (TASK-120): reconciliation over the colliding entry stays quiet and
// loses nothing — the relocate refuses, so nothing "moved", so NO re-poll fires.
//   Given the same two on-disk copies
//   When reconcileTicketFolders runs over the stale todo entry
//   Then both copies remain, pollTasksOnce is never invoked, reconciling is released
// ===========================================================================
test('Scenario (TASK-120): reconciliation over the ux-review collision does not re-poll and releases the guard', async () => {
  const { mod, fs, window } = loadFsModule();
  const tab = { folder: ROOT, tasks: { tickets: new Map(), config: CONFIG_UX, reconciling: false } };
  const { moverEntry } = seedCollision(fs, mod, tab);

  // When reconcile runs over the stale todo entry (its ux-review target folder is occupied).
  await mod.reconcileTicketFolders(tab, [moverEntry]);

  // Then both copies remain on disk (the refused rename left everything in place).
  assert.deepEqual(relPaths(fs), ['todo/TASK-15.md', 'ux-review/TASK-15.md'], 'no data lost by reconcile');
  assert.equal(fs.calls.write.length, 0, 'reconcile wrote no content');
  // And nothing moved, so the success-only re-poll never fired.
  assert.equal(window.__calls.pollTasksOnce, undefined, 'pollTasksOnce never invoked (nothing moved)');
  // And the concurrency guard is released in `finally` even though the move failed.
  assert.equal(tab.tasks.reconciling, false, 'reconciling flag released');
});

// ===========================================================================
// Scenario (TASK-120): the board shows the ticket ONCE despite two copies — the
// config-derived user-status set makes the folder-matching (ux-review) copy win.
//   Given entries for both copies
//   When dedupeTicketsByFolder runs with the config-derived user-status set
//   Then exactly one entry survives — the copy whose folder "ux-review" matches its status
// ===========================================================================
test('Scenario (TASK-120): dedupeTicketsByFolder surfaces the id once, the ux-review folder-matching copy winning', () => {
  const { mod, fs } = loadFsModule();
  const tab = { folder: ROOT, tasks: { tickets: new Map(), config: CONFIG_UX, reconciling: false } };
  const { moverEntry, occEntry } = seedCollision(fs, mod, tab);
  const userStatuses = mod.tasksUserStatusSet(mod.normalizeTasksColumns(CONFIG_UX));

  // When dedupe runs over both copies (mover-in-todo first, then the ux-review occupant).
  const deduped = mod.dedupeTicketsByFolder([moverEntry, occEntry], userStatuses);

  // Then exactly one entry survives for the id, and it is the folder-matching copy.
  assert.equal(deduped.length, 1, 'the id surfaces exactly once');
  assert.equal(deduped[0].fm.id, 'TASK-15');
  assert.equal(deduped[0].folder, 'ux-review', 'the copy whose folder matches its ux-review status wins');
  assert.equal(deduped[0].path, occEntry.path, 'specifically the ux-review occupant, not the stale todo copy');
});
