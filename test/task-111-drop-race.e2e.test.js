'use strict';

// ===========================================================================
// TASK-111 — e2e "cucumber" scenarios (Given / When / Then), written as plain
// `node --test` cases (NO cucumber npm package is installed or required).
//
// Feature: moveTicketToStatus re-checks the active/claim refusal against FRESH
// on-disk frontmatter (not just the last-polled in-memory snapshot). The drop
// guard in attachTasksLaneDrop reads the snapshot; if an agent claims a ticket on
// disk in the window between the last poll and the drop, that stale guard passes
// and — before TASK-111 — moveTicketToStatus would clobber the live claim. The
// fix re-applies the SAME refusal against the frontmatter it re-reads from disk,
// and on a truthy result shows one notice, forces a re-poll, and returns with NO
// write/rename/mkdir.
//
// Harness: the REAL renderer/renderer.js moveTicketToStatus (a browser script,
// not require()-able) is brace-extracted and evaluated over a Map-backed mock
// window.api.fs (matching TASK-102's fs harness). Crucially, seedRace() seeds the
// on-disk content and the in-memory snapshot INDEPENDENTLY so the poll/drop race
// can be simulated. NO DATABASE, REAL FILESYSTEM WRITE, OR NETWORK CALL IS MADE.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const laneHarness = require('./helpers/task-101-lane-harness');
const { rendererSrc, makeDocument } = laneHarness;

// A config with a `ux-review` user column (the only USER lane); everything else
// is a system lane. Mirrors TASK-102's CONFIG_UX.
const CONFIG_UX = {
  columns: [
    { status: 'todo' }, { status: 'defining' }, { status: 'in-progress' },
    { status: 'testing' }, { status: 'ux-review', label: 'UX Review' },
    { status: 'post-processing' }, { status: 'done' },
  ],
};

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
// exactly like main.js's IPC handler. Every call is recorded. `failReads` forces
// readFile to report { ok: false } for a given path even though the byte content
// still exists in the map (to simulate a transient fresh-read failure while the
// file itself is untouched).
function makeFsMock() {
  const files = new Map();
  const dirs = new Set();
  const failReads = new Set();
  const calls = { write: [], mkdir: [], rename: [], read: [] };
  return {
    files, dirs, failReads, calls,
    async readFile(p) {
      calls.read.push(p);
      if (failReads.has(p)) return { ok: false, error: 'EAGAIN' };
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
    extractFn(rendererSrc, 'tasksActiveClaimRefusal'),
    extractFn(rendererSrc, 'relocateTicketFile'),
    extractFn(rendererSrc, 'reconcileTicketFolders'),
    extractFn(rendererSrc, 'moveTicketToStatus'),
    // Record forced re-polls (no DOM/IPC touched).
    'function pollTasksOnce(tab, force){ (window.__calls.pollTasksOnce = window.__calls.pollTasksOnce || []).push(!!force); }',
    // Record refusal notices (the fs harness has no notice DOM element).
    'function showTasksNotice(tab, message){ (window.__calls.showTasksNotice = window.__calls.showTasksNotice || []).push(String(message)); }',
    'return { moveTicketToStatus, relocateTicketFile, reconcileTicketFolders,',
    '  ticketFolderForStatusWith, tasksUserStatusSet, normalizeTasksColumns,',
    '  tasksActiveClaimRefusal, isSafeTasksSlug, tasksJoin, parseTicketFrontmatter, serializeTicket };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  const mod = new Function('window', 'document', 'console', body)(window, document, console);
  return { mod, window, fs: window.api.fs };
}

const ROOT = 'C:\\proj';

function serialize(mod, fm, body) {
  return mod.serializeTicket(fm, body || '\n## Description\nseed\n\n## Additional Context\nuser-owned\n');
}

// Seed disk and the in-memory snapshot INDEPENDENTLY so the poll/drop race can be
// simulated. `snapshot` populates tab.tasks.tickets (what the drop guard saw at
// last poll); `disk` is the actual on-disk frontmatter moveTicketToStatus will
// re-read. The ticket's path (in the snapshot folder) is where the file lives.
function seedRace(fs, mod, tab, opts) {
  const id = opts.id || 'TASK-9';
  const folder = opts.snapshotFolder || 'todo';
  const p = mod.tasksJoin(ROOT, 'tasks', folder, `${id}.md`);

  const snapFm = Object.assign(
    { id, title: id, status: opts.snapshot.status,
      created: '2020-01-01T00:00:00.000Z', updated: '2020-01-01T00:00:00.000Z' },
    opts.snapshot.agent != null ? { agent: opts.snapshot.agent } : {});
  const snapBody = '\n## Description\nseed\n\n## Additional Context\nuser-owned\n';
  const ticket = { file: `${id}.md`, path: p, folder, fm: snapFm, body: snapBody };
  tab.tasks.tickets.set(ticket.file, ticket);

  // On-disk content (possibly divergent from the snapshot).
  const diskFm = Object.assign(
    { id, title: id, status: opts.disk.status,
      created: '2020-01-01T00:00:00.000Z', updated: '2020-01-01T00:00:00.000Z' },
    opts.disk.agent != null ? { agent: opts.disk.agent } : {});
  fs.files.set(p, serialize(mod, diskFm, snapBody));
  return { path: p, ticket };
}

function relPaths(fs) {
  const base = 'C:\\proj\\tasks\\';
  return Array.from(fs.files.keys()).map((p) => p.slice(base.length).replace(/\\/g, '/')).sort();
}

function makeTab(config) {
  return { folder: ROOT, tasks: { tickets: new Map(), config, reconciling: false } };
}

// ===========================================================================
// Scenario: Race refusal — a claim landed on disk after the last poll (failure)
//   Given the in-memory snapshot of TASK-9 says status "todo" with no agent
//   And the on-disk frontmatter of TASK-9 says status "in-progress" agent "orch-42"
//   When moveTicketToStatus is called with target status "ux-review"
//   Then a single notice is shown naming "TASK-9" and "orch-42"
//   And no file write, rename, or mkdir occurs
//   And tasks/todo/TASK-9.md is byte-identical to before
//   And a forced board re-poll is requested
// ===========================================================================
test('Scenario (failure): a claim that landed on disk after the last poll is caught by the fresh re-check', async () => {
  const { mod, window, fs } = loadFsModule();
  const tab = makeTab(CONFIG_UX);
  // Given a STALE snapshot (todo / no agent) but a claimed in-progress ticket on disk.
  const { path: diskPath } = seedRace(fs, mod, tab, {
    snapshot: { status: 'todo', agent: null },
    disk: { status: 'in-progress', agent: 'orch-42' },
  });
  const before = fs.files.get(diskPath);

  // When the (stale-guard-passing) drop calls the move to the ux-review USER lane.
  await mod.moveTicketToStatus(tab, 'TASK-9.md', 'ux-review');

  // Then exactly one refusal notice, naming the fresh id + claiming agent.
  const notices = window.__calls.showTasksNotice || [];
  assert.equal(notices.length, 1, 'exactly one refusal notice was shown');
  assert.match(notices[0], /TASK-9/, 'notice names the ticket id from the FRESH frontmatter');
  assert.match(notices[0], /orch-42/, 'notice names the claiming agent from the FRESH frontmatter');
  // And NO write / rename / mkdir happened (the fresh read is allowed).
  assert.equal(fs.calls.write.length, 0, 'no whole-file write');
  assert.equal(fs.calls.rename.length, 0, 'no rename');
  assert.equal(fs.calls.mkdir.length, 0, 'no mkdir');
  assert.ok(fs.calls.read.length >= 1, 'the fresh on-disk re-read did happen');
  // And the file is byte-identical and still in tasks/todo/.
  assert.equal(fs.files.get(diskPath), before, 'tasks/todo/TASK-9.md is byte-identical');
  assert.deepEqual(relPaths(fs), ['todo/TASK-9.md'], 'file never left tasks/todo');
  // And a forced re-poll was requested (so the board catches up to disk).
  assert.deepEqual(window.__calls.pollTasksOnce || [], [true], 'exactly one forced re-poll');
});

// ===========================================================================
// Scenario: Happy path unchanged — unclaimed ticket moves to a user lane
// ===========================================================================
test('Scenario: an unclaimed ticket still moves to a user lane with one write + one atomic relocate', async () => {
  const { mod, window, fs } = loadFsModule();
  const tab = makeTab(CONFIG_UX);
  // Given on-disk AND in-memory both say todo / no agent.
  const { path: oldPath } = seedRace(fs, mod, tab, {
    snapshot: { status: 'todo', agent: null },
    disk: { status: 'todo', agent: null },
  });

  // When the move targets the ux-review USER lane.
  await mod.moveTicketToStatus(tab, 'TASK-9.md', 'ux-review');

  // Then exactly one whole-file write (write-then-rename targets the old path).
  assert.equal(fs.calls.write.length, 1, 'exactly one whole-file write');
  assert.equal(fs.calls.write[0], oldPath, 'the write targets the current path');
  // And a single atomic relocate into tasks/ux-review/.
  const newPath = mod.tasksJoin(ROOT, 'tasks', 'ux-review', 'TASK-9.md');
  assert.equal(fs.calls.rename.length, 1, 'a single atomic relocate');
  assert.deepEqual(relPaths(fs), ['ux-review/TASK-9.md'], 'no copy left behind in tasks/todo');
  // And status ux-review with `updated` bumped, created + body (incl. Additional Context) preserved.
  const after = mod.parseTicketFrontmatter(fs.files.get(newPath));
  assert.equal(after.fm.status, 'ux-review');
  assert.notEqual(after.fm.updated, '2020-01-01T00:00:00.000Z', 'updated was bumped');
  assert.equal(after.fm.created, '2020-01-01T00:00:00.000Z', 'created preserved');
  assert.match(after.body, /## Additional Context/, 'user-owned Additional Context preserved');
  // And no refusal notice was shown.
  assert.deepEqual(window.__calls.showTasksNotice || [], [], 'no refusal notice on the happy path');
});

// ===========================================================================
// Scenario: System-lane target overrides a live claim (unchanged)
//   Given the on-disk frontmatter of TASK-9 says in-progress agent "orch-42"
//   When moveTicketToStatus targets "done"
//   Then the move proceeds (status done, relocated tasks/done/) with no notice
// ===========================================================================
test('Scenario: a system-lane target (done) overrides a live on-disk claim with no refusal', async () => {
  const { mod, window, fs } = loadFsModule();
  const tab = makeTab(CONFIG_UX);
  // Given a freshly-claimed in-progress ticket on disk (snapshot irrelevant here).
  seedRace(fs, mod, tab, {
    snapshot: { status: 'in-progress', agent: 'orch-42' },
    disk: { status: 'in-progress', agent: 'orch-42' },
  });

  // When the move targets the system status "done" (an intentional manual override).
  await mod.moveTicketToStatus(tab, 'TASK-9.md', 'done');

  // Then the move proceeds: one write, one relocate into tasks/done/, no notice.
  assert.equal(fs.calls.write.length, 1, 'the move wrote the file');
  const newPath = mod.tasksJoin(ROOT, 'tasks', 'done', 'TASK-9.md');
  assert.deepEqual(relPaths(fs), ['done/TASK-9.md'], 'relocated into tasks/done/');
  assert.equal(mod.parseTicketFrontmatter(fs.files.get(newPath)).fm.status, 'done');
  assert.deepEqual(window.__calls.showTasksNotice || [], [], 'no refusal notice for a system-lane target');
});

// ===========================================================================
// Scenario: Fresh frontmatter active but UNCLAIMED — move proceeds (edge)
//   Given the on-disk frontmatter says in-progress agent "   " (whitespace)
//   When moveTicketToStatus targets "ux-review"
//   Then the move proceeds and no refusal notice is shown
// ===========================================================================
test('Scenario (edge): an active but unclaimed (whitespace agent) ticket still moves to a user lane', async () => {
  const { mod, window, fs } = loadFsModule();
  const tab = makeTab(CONFIG_UX);
  // Given the fresh frontmatter is active (in-progress) but the agent is whitespace-only.
  seedRace(fs, mod, tab, {
    snapshot: { status: 'todo', agent: null },
    disk: { status: 'in-progress', agent: '   ' },
  });

  // When the move targets the ux-review USER lane.
  await mod.moveTicketToStatus(tab, 'TASK-9.md', 'ux-review');

  // Then the move proceeds (a whitespace agent is not a live claim) with no notice.
  assert.equal(fs.calls.write.length, 1, 'the move wrote the file');
  assert.deepEqual(relPaths(fs), ['ux-review/TASK-9.md'], 'relocated into tasks/ux-review/');
  assert.deepEqual(window.__calls.showTasksNotice || [], [], 'whitespace agent is not refused');
});

// ===========================================================================
// Scenario: Fresh read fails — degrade to snapshot guard (edge)
//   Given the in-memory snapshot says todo / no agent
//   And window.api.fs.readFile returns { ok: false } for the ticket path
//   When moveTicketToStatus targets "ux-review"
//   Then the move proceeds from the snapshot copy exactly as today
// ===========================================================================
test('Scenario (edge): a failed fresh read degrades to the snapshot guard and the move proceeds', async () => {
  const { mod, window, fs } = loadFsModule();
  const tab = makeTab(CONFIG_UX);
  // Given a clean todo/no-agent snapshot, but disk carries a claim we will NOT be
  // able to read (readFile forced to fail for this path).
  const { path: diskPath } = seedRace(fs, mod, tab, {
    snapshot: { status: 'todo', agent: null },
    disk: { status: 'in-progress', agent: 'orch-42' },
  });
  fs.failReads.add(diskPath);

  // When the move targets the ux-review USER lane.
  await mod.moveTicketToStatus(tab, 'TASK-9.md', 'ux-review');

  // Then it degrades to the snapshot (todo / no agent): the move proceeds exactly
  // as today — one write, one relocate, no refusal notice.
  assert.equal(fs.calls.write.length, 1, 'the move wrote from the snapshot copy');
  assert.deepEqual(relPaths(fs), ['ux-review/TASK-9.md'], 'relocated into tasks/ux-review/');
  assert.deepEqual(window.__calls.showTasksNotice || [], [], 'no refusal — degraded to snapshot, no new failure mode');
});
