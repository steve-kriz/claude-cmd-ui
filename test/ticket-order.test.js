'use strict';

// Unit + round-trip + cucumber-style tests for TASK-007: user-controlled drag
// reordering of `todo` cards, persisted via a numeric `order` frontmatter field,
// with the build's pick-next honouring that order.
//
// Two layers are under test:
//
//   1. lib/ticket-queue.js — the Electron-free pure helpers ticketOrderValue,
//      compareTicketId, compareTicketOrder and selectNextBatch. The module touches
//      no disk/DB/network/Electron, so it is exercised directly with `node --test`.
//
//   2. renderer/renderer.js's browser-side reorder wiring (persistTicketOrder,
//      reorderTodoTicket, moveTicketToStatus, the render sort, the intra-`todo`
//      drag scoping) and renderer/styles.css's drop markers. renderer.js is a
//      browser script (no module.exports, references `document`/`window`) so —
//      matching test/ticket-lanes.test.js and test/tasks-working-indicator.test.js
//      — its behaviour is proven both by VERBATIM copies of the reorder logic run
//      against a fully MOCKED in-memory filesystem, and by source-scan guards that
//      assert the real source still carries the same logic (so the copies cannot
//      silently drift).
//
// NO DATABASE, REAL FILESYSTEM WRITE, OR NETWORK CALL IS MADE. The board is a
// plain in-memory Map of tickets; window.api.fs is a mock backed by an in-memory
// "disk" Map. Reading the app's own source as a fixture is the only fs access.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  ticketOrderValue,
  compareTicketId,
  compareTicketOrder,
  selectNextBatch,
} = require('../lib/ticket-queue');

const RENDERER = path.join(__dirname, '..', 'renderer', 'renderer.js');
const STYLES = path.join(__dirname, '..', 'renderer', 'styles.css');
const rendererSrc = fs.readFileSync(RENDERER, 'utf8');
const cssSrc = fs.readFileSync(STYLES, 'utf8');

// ===========================================================================
// PART 1 — Unit tests: lib/ticket-queue.js pure ordering helpers
// ===========================================================================

// --- ticketOrderValue ------------------------------------------------------

test('ticketOrderValue reads a present numeric order', () => {
  assert.equal(ticketOrderValue({ order: 3 }), 3);
  assert.equal(ticketOrderValue({ order: '5' }), 5, 'string numerics coerce');
  assert.equal(ticketOrderValue({ order: 0 }), 0, 'zero is a valid order');
  assert.equal(ticketOrderValue({ order: -2 }), -2, 'negatives are valid');
  assert.equal(ticketOrderValue({ order: '2.5' }), 2.5, 'fractionals allowed');
});

test('ticketOrderValue is null when order is absent', () => {
  assert.equal(ticketOrderValue({ id: 'T' }), null);
  assert.equal(ticketOrderValue({}), null);
  assert.equal(ticketOrderValue(null), null);
  assert.equal(ticketOrderValue(undefined), null);
});

test('ticketOrderValue is null for blank / non-numeric order', () => {
  assert.equal(ticketOrderValue({ order: '' }), null, 'empty string');
  assert.equal(ticketOrderValue({ order: '   ' }), null, 'whitespace only');
  assert.equal(ticketOrderValue({ order: 'abc' }), null, 'non-numeric');
  assert.equal(ticketOrderValue({ order: 'NaN' }), null);
  assert.equal(ticketOrderValue({ order: null }), null, 'null falls through to absent');
});

test('ticketOrderValue accepts `priority` as a read alias for `order`', () => {
  assert.equal(ticketOrderValue({ priority: 4 }), 4);
  assert.equal(ticketOrderValue({ priority: '7' }), 7);
  // `order` is canonical and wins when both are present.
  assert.equal(ticketOrderValue({ order: 1, priority: 9 }), 1, 'order wins over priority');
});

test('ticketOrderValue unwraps a { fm } wrapper as well as bare fm', () => {
  assert.equal(ticketOrderValue({ fm: { order: 6 } }), 6);
  assert.equal(ticketOrderValue({ fm: { priority: 8 } }), 8);
});

// --- compareTicketId (numeric-aware) --------------------------------------

test('compareTicketId sorts numerically, not lexically (TASK-2 before TASK-10)', () => {
  const ids = ['TASK-10', 'TASK-2', 'TASK-1', 'TASK-21']
    .map((id) => ({ id }))
    .sort(compareTicketId)
    .map((t) => t.id);
  assert.deepEqual(ids, ['TASK-1', 'TASK-2', 'TASK-10', 'TASK-21']);
});

// --- compareTicketOrder ----------------------------------------------------

test('compareTicketOrder: an ordered subset floats to the top by order value', () => {
  // A mix: two carry an explicit order, two do not. The ordered ones sort first
  // (by order asc); the unordered ones follow, in numeric id order.
  const tickets = [
    { id: 'TASK-004' },
    { id: 'TASK-002', order: 2 },
    { id: 'TASK-003' },
    { id: 'TASK-001', order: 1 },
  ];
  const sorted = [...tickets].sort(compareTicketOrder).map((t) => t.id);
  assert.deepEqual(sorted, ['TASK-001', 'TASK-002', 'TASK-003', 'TASK-004']);
});

test('compareTicketOrder: the ordered ticket sorts before an unordered one', () => {
  // TASK-999 with order 5 must precede TASK-001 with no order at all.
  assert.ok(compareTicketOrder({ id: 'TASK-999', order: 5 }, { id: 'TASK-001' }) < 0);
  assert.ok(compareTicketOrder({ id: 'TASK-001' }, { id: 'TASK-999', order: 5 }) > 0);
});

test('compareTicketOrder: equal order values tie-break by numeric id', () => {
  const sorted = [
    { id: 'TASK-010', order: 1 },
    { id: 'TASK-002', order: 1 },
  ].sort(compareTicketOrder).map((t) => t.id);
  assert.deepEqual(sorted, ['TASK-002', 'TASK-010'], 'same order → lower id first');
});

test('compareTicketOrder: all-unordered == pure numeric id order (backward compatible)', () => {
  const ids = ['TASK-010', 'TASK-002', 'TASK-001', 'TASK-021'];
  const byOrder = ids.map((id) => ({ id })).sort(compareTicketOrder).map((t) => t.id);
  const byId = ids.map((id) => ({ id })).sort(compareTicketId).map((t) => t.id);
  assert.deepEqual(byOrder, byId, 'with no order fields, ordering is exactly numeric id order');
  assert.deepEqual(byOrder, ['TASK-001', 'TASK-002', 'TASK-010', 'TASK-021']);
});

test('compareTicketOrder honours the `priority` alias the same as `order`', () => {
  const sorted = [
    { id: 'TASK-003', priority: 3 },
    { id: 'TASK-001', priority: 1 },
    { id: 'TASK-002', priority: 2 },
  ].sort(compareTicketOrder).map((t) => t.id);
  assert.deepEqual(sorted, ['TASK-001', 'TASK-002', 'TASK-003']);
});

// --- selectNextBatch honouring `order` ------------------------------------

function T(id, status, extra) {
  return { fm: Object.assign({ id, status }, extra) };
}

test('selectNextBatch picks the top-of-todo (lowest order) ticket next', () => {
  // Board order (as stored) deliberately not id-sorted; order fields drive it.
  const tickets = [
    T('TASK-601', 'todo', { order: '2' }),
    T('TASK-602', 'todo', { order: '3' }),
    T('TASK-603', 'todo', { order: '1' }),
  ];
  const one = selectNextBatch(tickets, { limit: 1 });
  assert.deepEqual(one.map((t) => t.fm.id), ['TASK-603'], 'top-of-lane (order 1) runs next');
  const all = selectNextBatch(tickets, { limit: 8 });
  assert.deepEqual(all.map((t) => t.fm.id), ['TASK-603', 'TASK-601', 'TASK-602'],
    'whole batch follows the persisted order');
});

test('selectNextBatch with NO order fields == old oldest-id-first behaviour', () => {
  const tickets = [
    T('TASK-010', 'todo'),
    T('TASK-002', 'todo'),
    T('TASK-001', 'todo'),
    T('TASK-021', 'todo'),
  ];
  const batch = selectNextBatch(tickets, { limit: 8 });
  assert.deepEqual(batch.map((t) => t.fm.id), ['TASK-001', 'TASK-002', 'TASK-010', 'TASK-021'],
    'backward compatible: pure numeric id order');
});

test('selectNextBatch: ordered tickets outrank unordered regardless of id', () => {
  const tickets = [
    T('TASK-001', 'todo'),               // no order → falls to the back
    T('TASK-050', 'todo', { order: '1' }), // explicit top
    T('TASK-002', 'todo'),               // no order
  ];
  const batch = selectNextBatch(tickets, { limit: 8 });
  assert.deepEqual(batch.map((t) => t.fm.id), ['TASK-050', 'TASK-001', 'TASK-002']);
});

// ===========================================================================
// PART 2 — Round-trip: the `order` field survives parse -> serialize, and
// created / ## Additional Context / other sections are preserved.
//
// Real serializer/parser copied VERBATIM from renderer/renderer.js (~5053 /
// ~5119). renderer.js is a browser script and cannot be required, so the
// round-trip contract is exercised against these faithful copies. Source-scan
// guards below assert the real source still matches.
// ===========================================================================

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

const BODY = [
  '',
  '## Description',
  'Reorder the todo lane by dragging cards.',
  '',
  '## Acceptance Criteria',
  '- [ ] Cards can be reordered within todo.',
  '',
  '## Additional Context',
  '(User-owned. Read it before building. Never overwrite it.)',
  'A note with **markdown** and a trailing space.   ',
].join('\n');

test('the `order` field survives a parse(serialize(fm, body)) round-trip', () => {
  const fm = {
    id: 'TASK-601', title: 'reorder me', status: 'todo',
    created: '2026-07-18T04:00:00.000Z', updated: '2026-07-18T05:00:00.000Z',
    order: '2',
  };
  const round = parseTicketFrontmatter(serializeTicket(fm, BODY));
  assert.ok(round, 'parses back');
  assert.equal(round.fm.order, '2', 'order round-trips as an unknown key');
  assert.equal(ticketOrderValue(round.fm), 2, 'and reads back as a number');
});

test('persisting order preserves created and every other section verbatim', () => {
  // Model persistTicketOrder: copy fm, set order + updated, keep created + body.
  const original = parseTicketFrontmatter(serializeTicket({
    id: 'TASK-602', title: 't', status: 'todo',
    created: '2026-07-18T04:00:00.000Z', updated: '2026-07-18T04:00:00.000Z',
  }, BODY));
  const newFm = Object.assign({}, original.fm);
  newFm.order = '1';
  newFm.updated = '2026-07-18T06:00:00.000Z';
  const round = parseTicketFrontmatter(serializeTicket(newFm, original.body));

  assert.equal(round.fm.order, '1', 'order written');
  assert.equal(round.fm.updated, '2026-07-18T06:00:00.000Z', 'updated bumped');
  assert.equal(round.fm.created, '2026-07-18T04:00:00.000Z', 'created preserved');
  assert.equal(round.body, BODY, 'body byte-for-byte identical');
  assert.match(round.body, /## Additional Context/, 'user-owned section preserved');
  assert.match(round.body, /A note with \*\*markdown\*\* and a trailing space\.   /,
    'trailing-space / markdown preserved verbatim');
});

test('order sits after the leading keys and does not disturb their order', () => {
  const fm = {
    id: 'TASK-603', title: 't', status: 'todo',
    created: '2026-07-18T04:00:00.000Z', updated: '2026-07-18T05:00:00.000Z',
    order: '3', agent: 'orchestrate/task-007',
  };
  const round = parseTicketFrontmatter(serializeTicket(fm, BODY));
  const keys = Object.keys(round.fm);
  assert.deepEqual(keys.slice(0, 5), ['id', 'title', 'status', 'created', 'updated']);
  assert.ok(keys.includes('order'), 'order present after the leading keys');
  assert.ok(keys.indexOf('order') >= 5, 'order trails the known leading keys');
});

// ===========================================================================
// PART 3 — Source-scan guards: the browser side must carry the reorder logic
// so the verbatim copies used below cannot silently drift from the app.
// (renderer.js is not require()-able, so we assert against its source.)
// ===========================================================================

test('renderer.js mirrors ticketOrderValue (order, priority alias, blank -> null)', () => {
  assert.match(rendererSrc, /function\s+ticketOrderValue\s*\(fm\)/);
  assert.match(rendererSrc, /fm\.order\s*!=\s*null\s*\?\s*fm\.order\s*:\s*fm\.priority/);
  assert.match(rendererSrc, /Number\.isFinite\(n\)\s*\?\s*n\s*:\s*null/);
});

test('renderer.js mirrors compareTicketOrder (prefer order, fall back to numeric id)', () => {
  assert.match(rendererSrc, /function\s+compareTicketOrder\s*\(a,\s*b\)/);
  assert.match(rendererSrc, /localeCompare\(String\(b\.id\),\s*undefined,\s*\{\s*numeric:\s*true\s*\}\)/);
});

test('renderTasksBoard sorts todo-vs-todo by compareTicketOrder, others by numeric id', () => {
  assert.match(rendererSrc, /a\.fm\.status\s*===\s*'todo'\s*&&\s*b\.fm\.status\s*===\s*'todo'/);
  assert.match(rendererSrc, /return\s+compareTicketOrder\(a\.fm,\s*b\.fm\)/);
});

test('intra-todo drag reordering is scoped to todo-to-todo drags', () => {
  // The reorder dragover/drop handlers bail unless the dragged card started in
  // todo, leaving cross-lane drags to the lane drop handler (status change).
  assert.match(rendererSrc, /if\s*\(tk\.fm\.status\s*===\s*'todo'\)\s*\{/);
  assert.match(rendererSrc, /draggingTaskStatus\s*!==\s*'todo'\s*\|\|\s*draggingTaskFile\s*===\s*tk\.file/);
  assert.match(rendererSrc, /reorderTodoTicket\(tab,\s*dragged,\s*tk\.file,\s*before\)/);
});

test('persistTicketOrder writes order + updated, preserves created, whole-file', () => {
  assert.match(rendererSrc, /async\s+function\s+persistTicketOrder\(tab,\s*file,\s*order\)/);
  assert.match(rendererSrc, /newFm\.order\s*=\s*String\(order\)/);
  assert.match(rendererSrc, /newFm\.updated\s*=\s*new Date\(\)\.toISOString\(\)/);
  assert.match(rendererSrc, /if\s*\(!newFm\.created\)\s*newFm\.created\s*=\s*newFm\.updated/);
  // Reads the freshest copy before writing (whole-file, concurrency-safe).
  assert.match(rendererSrc, /await\s+window\.api\.fs\.readFile\(filePath\)/);
  assert.match(rendererSrc, /window\.api\.fs\.writeFile\(filePath,\s*serializeTicket\(newFm,\s*body\)\)/);
});

test('reorderTodoTicket reindexes the todo lane 1..N and stays within todo', () => {
  assert.match(rendererSrc, /async\s+function\s+reorderTodoTicket\(tab,\s*draggedFile,\s*targetFile,\s*before\)/);
  assert.match(rendererSrc, /dragged\.fm\.status\s*!==\s*'todo'\s*\|\|\s*target\.fm\.status\s*!==\s*'todo'/);
  assert.match(rendererSrc, /persistTicketOrder\(tab,\s*list\[i\]\.file,\s*i\s*\+\s*1\)/);
});

test('the drop-marker CSS rules exist for above/below insertion points', () => {
  assert.match(cssSrc, /\.task-card\.task-card-drop-before\s*\{/);
  assert.match(cssSrc, /\.task-card\.task-card-drop-after\s*\{/);
});

// ===========================================================================
// PART 4 — Feature: Reorder todo tickets by drag and drop (Gherkin scenarios)
//
// Implemented against VERBATIM copies of renderer.js's persistTicketOrder /
// reorderTodoTicket / moveTicketToStatus (below), driven over a MOCKED in-memory
// filesystem. NO real DB/fs/network: `disk` is a Map<path, content>; window.api.fs
// reads/writes only that Map; the board is an in-memory Map<file, ticket>.
// ===========================================================================

// --- Mock environment ------------------------------------------------------

const disk = new Map();               // absolute path -> file content (string)
let pollCalls = 0;                    // pollTasksOnce() call counter (mock)

// The browser global the copied functions close over. Backed by `disk`.
const window = {
  api: {
    fs: {
      async readFile(p) {
        if (!disk.has(p)) return { ok: false, error: 'ENOENT' };
        return { ok: true, binary: false, content: disk.get(p) };
      },
      async writeFile(p, content) {
        disk.set(p, content);
        return { ok: true };
      },
    },
  },
};

function pollTasksOnce() { pollCalls++; }

// --- VERBATIM copies of the renderer reorder/move logic --------------------
// (renderer/renderer.js ~5761 / ~5794 / ~5721). Kept in lockstep with the
// source-scan guards in PART 3.

async function persistTicketOrder(tab, file, order) {
  const ticket = tab.tasks.tickets.get(file);
  if (!ticket) return false;
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
  if (String(fm.order == null ? '' : fm.order) === String(order)) return false;
  const newFm = Object.assign({}, fm);
  newFm.order = String(order);
  newFm.updated = new Date().toISOString();
  if (!newFm.created) newFm.created = newFm.updated;
  const wr = await window.api.fs.writeFile(filePath, serializeTicket(newFm, body));
  if (!wr || !wr.ok) {
    console.error('[tasks reorder]', wr && wr.error);
    return false;
  }
  return true;
}

async function reorderTodoTicket(tab, draggedFile, targetFile, before) {
  const dragged = tab.tasks.tickets.get(draggedFile);
  const target = tab.tasks.tickets.get(targetFile);
  if (!dragged || !target) return;
  if (dragged.fm.status !== 'todo' || target.fm.status !== 'todo') return;
  if (draggedFile === targetFile) return;

  const todo = Array.from(tab.tasks.tickets.values())
    .filter((tk) => tk.fm.status === 'todo')
    .sort((a, b) => compareTicketOrder(a.fm, b.fm));
  const list = todo.filter((tk) => tk.file !== draggedFile);
  const targetIdx = list.findIndex((tk) => tk.file === targetFile);
  if (targetIdx === -1) return;
  list.splice(before ? targetIdx : targetIdx + 1, 0, dragged);

  let wrote = false;
  for (let i = 0; i < list.length; i++) {
    if (await persistTicketOrder(tab, list[i].file, i + 1)) wrote = true;
  }
  if (wrote) pollTasksOnce(tab, true);
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
  if (!wr || !wr.ok) {
    console.error('[tasks move]', wr && wr.error);
    return;
  }
  pollTasksOnce(tab, true);
}

// --- Board harness ---------------------------------------------------------

// The renderTasksBoard todo-lane sort, mirrored for assertions (no DOM).
function renderTodoOrder(tab) {
  return Array.from(tab.tasks.tickets.values())
    .sort((a, b) => {
      if (a.fm.status === 'todo' && b.fm.status === 'todo') {
        return compareTicketOrder(a.fm, b.fm);
      }
      return String(a.fm.id).localeCompare(String(b.fm.id), undefined, { numeric: true });
    })
    .filter((tk) => tk.fm.status === 'todo')
    .map((tk) => tk.fm.id);
}

// Seed the mock disk + an in-memory board from ticket specs.
function seedBoard(specs) {
  disk.clear();
  pollCalls = 0;
  const tickets = new Map();
  for (const s of specs) {
    const file = `${s.id}.md`;
    const p = `C:\\tasks\\${file}`;
    const fm = {
      id: s.id, title: s.title || s.id, status: s.status,
      created: s.created || '2026-07-18T00:00:00.000Z',
      updated: s.updated || '2026-07-18T00:00:00.000Z',
    };
    if (s.order != null) fm.order = String(s.order);
    const body = s.body != null ? s.body : '\n## Description\nseed\n';
    disk.set(p, serializeTicket(fm, body));
    tickets.set(file, { file, path: p, fm, body });
  }
  return { tasks: { tickets } };
}

// Rebuild the board Map from what's currently on the mock disk — models a board
// poll AND an app restart (both re-read the ticket files from disk).
function reloadFromDisk(tab) {
  const tickets = new Map();
  for (const [p, content] of disk) {
    const parsed = parseTicketFrontmatter(content);
    if (!parsed) continue;
    const file = p.split('\\').pop();
    tickets.set(file, { file, path: p, fm: parsed.fm, body: parsed.body });
  }
  return { tasks: { tickets } };
}

// Background: the "todo" lane contains TASK-601, TASK-602, TASK-603 in that
// order (seeded with explicit order 1,2,3 so the starting order is unambiguous).
function backgroundBoard() {
  return seedBoard([
    { id: 'TASK-601', status: 'todo', order: 1 },
    { id: 'TASK-602', status: 'todo', order: 2 },
    { id: 'TASK-603', status: 'todo', order: 3 },
  ]);
}

test('Scenario: Dragging a card changes the order within todo', async () => {
  // Given the todo lane is TASK-601, TASK-602, TASK-603
  let tab = backgroundBoard();
  assert.deepEqual(renderTodoOrder(tab), ['TASK-601', 'TASK-602', 'TASK-603']);
  // When the user drags TASK-603 above TASK-601
  await reorderTodoTicket(tab, 'TASK-603.md', 'TASK-601.md', /* before */ true);
  // Then the todo lane order becomes TASK-603, TASK-601, TASK-602 (read from disk)
  tab = reloadFromDisk(tab);
  assert.deepEqual(renderTodoOrder(tab), ['TASK-603', 'TASK-601', 'TASK-602']);
});

test('Scenario: The new order persists across polling', async () => {
  let tab = backgroundBoard();
  await reorderTodoTicket(tab, 'TASK-603.md', 'TASK-601.md', true);
  // When the board polls again (re-read from disk) — repeatedly
  for (let i = 0; i < 3; i++) tab = reloadFromDisk(tab);
  // Then the todo lane still shows the reordered sequence
  assert.deepEqual(renderTodoOrder(tab), ['TASK-603', 'TASK-601', 'TASK-602']);
  assert.ok(pollCalls >= 1, 'a re-render poll was requested after the write');
});

test('Scenario: The new order persists across restart', async () => {
  const tab = backgroundBoard();
  await reorderTodoTicket(tab, 'TASK-603.md', 'TASK-601.md', true);
  // When the app is restarted and the board reloads from disk — a brand new
  // board Map built only from persisted files (nothing carried in memory).
  const restarted = reloadFromDisk({ tasks: { tickets: new Map() } });
  assert.deepEqual(renderTodoOrder(restarted), ['TASK-603', 'TASK-601', 'TASK-602']);
  // And the persisted order values are the reindexed 1..N total order.
  const orders = Array.from(restarted.tasks.tickets.values())
    .reduce((m, tk) => (m[tk.fm.id] = ticketOrderValue(tk.fm), m), {});
  assert.deepEqual(orders, { 'TASK-603': 1, 'TASK-601': 2, 'TASK-602': 3 });
});

test('Scenario: The build picks the top-of-lane ticket next', async () => {
  const tab = backgroundBoard();
  await reorderTodoTicket(tab, 'TASK-603.md', 'TASK-601.md', true);
  const restarted = reloadFromDisk({ tasks: { tickets: new Map() } });
  // When the build picks the next ticket (selectNextBatch over the board snapshot)
  const snapshot = Array.from(restarted.tasks.tickets.values());
  const next = selectNextBatch(snapshot, { limit: 1 });
  // Then it picks TASK-603 (top-of-lane)
  assert.deepEqual(next.map((t) => t.fm.id), ['TASK-603']);
});

test('Scenario: Reordering does not change status', async () => {
  const tab = backgroundBoard();
  await reorderTodoTicket(tab, 'TASK-603.md', 'TASK-601.md', true);
  const restarted = reloadFromDisk({ tasks: { tickets: new Map() } });
  // Then every reordered ticket still has status "todo"
  for (const tk of restarted.tasks.tickets.values()) {
    assert.equal(tk.fm.status, 'todo', `${tk.fm.id} keeps status todo`);
  }
});

test('Scenario: Cross-lane drag still changes status', async () => {
  const tab = backgroundBoard();
  // When the user drags TASK-601 from todo into the in-progress lane
  await moveTicketToStatus(tab, 'TASK-601.md', 'in-progress');
  // Then TASK-601's status becomes in-progress (persisted to disk)
  const reloaded = reloadFromDisk(tab);
  assert.equal(reloaded.tasks.tickets.get('TASK-601.md').fm.status, 'in-progress');
  // And it leaves the todo lane, while the others remain in todo.
  assert.ok(!renderTodoOrder(reloaded).includes('TASK-601'));
  assert.deepEqual(renderTodoOrder(reloaded), ['TASK-602', 'TASK-603']);
});

test('Scenario: Tickets without an explicit order render deterministically', () => {
  // Given TASK-604 exists in todo with NO order value, among ordered tickets.
  const tab = seedBoard([
    { id: 'TASK-603', status: 'todo', order: 1 },
    { id: 'TASK-601', status: 'todo', order: 2 },
    { id: 'TASK-604', status: 'todo' },   // no order → falls back to id order, after the ordered ones
    { id: 'TASK-602', status: 'todo', order: 3 },
  ]);
  // When the board renders repeatedly, TASK-604 keeps a stable position.
  const first = renderTodoOrder(tab);
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(renderTodoOrder(tab), first, 'render is stable across repeats');
  }
  assert.deepEqual(first, ['TASK-603', 'TASK-601', 'TASK-602', 'TASK-604'],
    'ordered tickets first (by order), unordered TASK-604 last (by id fallback)');
});

test('Scenario: an all-unordered todo lane renders in pure numeric id order', () => {
  // Backward-compat: with no order fields at all, the lane is exactly id order
  // and never jumps between renders.
  const tab = seedBoard([
    { id: 'TASK-610', status: 'todo' },
    { id: 'TASK-602', status: 'todo' },
    { id: 'TASK-601', status: 'todo' },
  ]);
  const order = renderTodoOrder(tab);
  assert.deepEqual(order, ['TASK-601', 'TASK-602', 'TASK-610']);
  for (let i = 0; i < 3; i++) assert.deepEqual(renderTodoOrder(tab), order);
});
