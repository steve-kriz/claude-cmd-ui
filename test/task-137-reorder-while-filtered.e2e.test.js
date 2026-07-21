'use strict';

// ===========================================================================
// TASK-137 — e2e "cucumber" scenarios (Given/When/Then), implemented as plain
// `node --test` cases. NO `cucumber` npm package is installed or required.
//
// Feature: intra-`todo` reorder while the Tasks board search filter is active.
// The filter hides non-matching cards from the DOM, but reordering two VISIBLE
// todo cards must re-index the FULL todo list from `tab.tasks.tickets` (never
// the DOM), so filter-hidden cards' persisted `order` is never corrupted.
//
// This ticket is the review follow-up to TASK-132 (a filtered CROSS-lane drag is
// already covered by test/task-132-board-search.e2e.test.js; the intra-todo
// reorder path under a filter was not). It is TEST-ONLY: no production code
// changes — it adds the missing regression test, covering both halves.
//
//   1. Wiring half — through the REAL render/drag path via
//      test/helpers/task-101-lane-harness.js `loadLaneModule`, where
//      `reorderTodoTicket` is a recorded stub. With the filter hiding some todo
//      cards, dragstart on one visible todo card + drop on the other must record
//      exactly one reorderTodoTicket call with { dragged, target, before }.
//
//   2. Persistence half — the REAL `reorderTodoTicket` + `persistTicketOrder`
//      (and their pure helpers) brace-EXTRACTED from renderer/renderer.js at run
//      time (never copied/stubbed/re-implemented, so they cannot drift), driven
//      over a MOCKED in-memory window.api.fs + a tab.tasks.tickets map holding
//      BOTH visible and filter-hidden todo tickets.
//
// EVERY database / filesystem / Electron call is MOCKED — the DOM is a plain
// object tree, window.api.fs is an in-memory Map; NO real DB / disk / network is
// touched (reading renderer.js's own source as a fixture is the only fs access).
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers/task-101-lane-harness');

const {
  loadLaneModule, makeWindow, makeDocument, makeTab, ticketsMap,
  laneEls, findByClass, findAllByClass, fire, rendererSrc,
} = H;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
function lane(tab, status) {
  return laneEls(tab).find((el) => el.dataset.status === status);
}
function cardsIn(tab, status) {
  return findAllByClass(lane(tab, status), 'task-card');
}
function cardIdsIn(tab, status) {
  return cardsIn(tab, status)
    .map((c) => findByClass(c, 'task-card-id').textContent).sort();
}
function cardByFile(tab, status, file) {
  return cardsIn(tab, status).find((c) => c.dataset.file === file);
}
// Type into the search box and fire the real input handler (snapshots the value
// into tab.tasks.searchQuery and re-renders synchronously).
function type(mod, tab, text) {
  tab.els.tasksSearch.value = text;
  mod.onTasksSearchInput(tab);
}

// The Gherkin Background board: 4 todo tickets in persisted order 1..4, only two
// of which match the query "login".
function backgroundTickets() {
  return ticketsMap([
    { fm: { id: 'TASK-701', title: 'login alpha', status: 'todo', order: '1' }, body: '' },
    { fm: { id: 'TASK-702', title: 'misc beta', status: 'todo', order: '2' }, body: '' },
    { fm: { id: 'TASK-703', title: 'login gamma', status: 'todo', order: '3' }, body: '' },
    { fm: { id: 'TASK-704', title: 'misc delta', status: 'todo', order: '4' }, body: '' },
  ]);
}

// ===========================================================================
// WIRING HALF — real render/drag path, reorderTodoTicket is the recorded stub
// ===========================================================================

// Fresh module + tab per scenario (module-level draggingTaskFile/Status leaks).
function freshWiring() {
  const { window } = makeWindow();
  const mod = loadLaneModule(window, makeDocument(), console);
  return { mod, window, tab: makeTab({ tickets: backgroundTickets() }) };
}

// Scenario: A filtered drop on a visible card reaches reorderTodoTicket with
// full-list semantics.
test('Scenario: a filtered drop on a visible todo card records exactly one reorderTodoTicket call', async () => {
  const { mod, tab, window } = freshWiring();
  // Given the board is rendered and I have typed "login" into the search box
  mod.renderTasksBoard(tab);
  type(mod, tab, 'login');
  // And only the cards TASK-701 and TASK-703 are present in the todo lane DOM
  assert.deepEqual(cardIdsIn(tab, 'todo'), ['TASK-701', 'TASK-703'],
    'the filter hides the non-matching todo cards (702, 704)');
  const dragged = cardByFile(tab, 'todo', 'TASK-703.md');
  const target = cardByFile(tab, 'todo', 'TASK-701.md');
  assert.ok(dragged && target, 'both visible cards are in the DOM');
  // When I drag TASK-703 and drop it on the UPPER half of TASK-701 (mock card
  // height is 10; clientY 1 < 5 → before = true).
  await fire(dragged, 'dragstart');
  await fire(target, 'drop', { clientY: 1 });
  // Then exactly one reorderTodoTicket call is recorded...
  const calls = window.__calls.reorderTodoTicket || [];
  assert.equal(calls.length, 1, 'exactly one reorder was requested');
  // ...carrying dragged "TASK-703.md", target "TASK-701.md", before = true.
  assert.deepEqual(calls[0], { dragged: 'TASK-703.md', target: 'TASK-701.md', before: true });
});

// Edge (wiring): dropping on the LOWER half of the target flips `before` to false
// — the same full-list handler runs regardless of which visible card is the
// target, proving the drop coordinate (not the filtered DOM) picks before/after.
test('Scenario (edge): a filtered drop on the lower half records before = false', async () => {
  const { mod, tab, window } = freshWiring();
  mod.renderTasksBoard(tab);
  type(mod, tab, 'login');
  const dragged = cardByFile(tab, 'todo', 'TASK-701.md');
  const target = cardByFile(tab, 'todo', 'TASK-703.md');
  // Drop on the lower half (clientY 9 >= height/2 = 5 → before = false).
  await fire(dragged, 'dragstart');
  await fire(target, 'drop', { clientY: 9 });
  const calls = window.__calls.reorderTodoTicket || [];
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { dragged: 'TASK-701.md', target: 'TASK-703.md', before: false });
});

// ===========================================================================
// PERSISTENCE HALF — the REAL reorderTodoTicket / persistTicketOrder extracted
// from renderer.js source, driven over a mocked in-memory window.api.fs.
// ===========================================================================

// Brace-match a (possibly `async`) named function declaration out of the source
// so the real shipped logic is under test and cannot drift (mirrors the inline
// extraction pattern task-132's "switching folders" test uses).
function extractFn(src, name) {
  let start = src.indexOf('function ' + name + '(');
  assert.ok(start !== -1, `function ${name} found in renderer.js`);
  if (src.slice(start - 6, start) === 'async ') start -= 6; // pick up the async prefix
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) { i += 1; break; } }
  }
  return src.slice(start, i);
}

// Build a fresh persistence module: the REAL reorder/persist logic + its pure
// helpers, closing over an injected window (in-memory fs) and a recording
// pollTasksOnce stub. draggingTaskFile/Status are reset by building anew.
function loadPersistModule(window) {
  const body = [
    extractFn(rendererSrc, 'ticketOrderValue'),
    extractFn(rendererSrc, 'compareTicketOrder'),
    extractFn(rendererSrc, 'parseTicketFrontmatter'),
    extractFn(rendererSrc, 'frontmatterValueLine'),
    extractFn(rendererSrc, 'serializeTicket'),
    extractFn(rendererSrc, 'persistTicketOrder'),
    extractFn(rendererSrc, 'reorderTodoTicket'),
    'window.__pollCalls = 0;',
    'function pollTasksOnce(tab, force){ window.__pollCalls += 1; }',
    'return { reorderTodoTicket, persistTicketOrder, parseTicketFrontmatter, serializeTicket };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function('window', 'console', body)(window, console);
}

// A minimal in-memory window.api.fs (readFile / writeFile) backed by a Map. NO
// real disk / DB / network is touched.
function makeFsWindow() {
  const disk = new Map(); // absolute path -> string content
  const writes = [];      // recorded writeFile paths
  const window = {
    __calls: {},
    api: {
      fs: {
        async readFile(p) {
          if (!disk.has(p)) return { ok: false, error: 'ENOENT: ' + p };
          return { ok: true, binary: false, content: disk.get(p) };
        },
        async writeFile(p, content) {
          writes.push(p);
          disk.set(p, content);
          return { ok: true };
        },
      },
    },
  };
  return { window, disk, writes };
}

const TASKS_DIR = 'C:\\proj\\tasks\\todo';

// Seed both the in-memory disk and the tab.tasks.tickets map from specs. Each
// spec: { id, order, status?, title? }. Returns { tab, disk, writes, window, mod }.
function seedPersist(specs) {
  const { window, disk, writes } = makeFsWindow();
  const tickets = new Map();
  for (const s of specs) {
    const file = `${s.id}.md`;
    const p = `${TASKS_DIR}\\${file}`;
    const fm = {
      id: s.id,
      title: s.title || s.id,
      status: s.status || 'todo',
      created: '2026-07-20T00:00:00.000Z',
      updated: '2026-07-20T00:00:00.000Z',
      order: String(s.order),
    };
    const bodyLines = [
      '',
      '## Description',
      `seed for ${s.id}`,
      '',
    ];
    const fmLines = Object.keys(fm).map((k) => `${k}: ${fm[k]}`);
    const content = ['---', ...fmLines, '---', bodyLines.join('\n')].join('\n');
    disk.set(p, content);
    tickets.set(file, { file, path: p, folder: 'todo', fm: Object.assign({}, fm), body: bodyLines.join('\n') });
  }
  const tab = makeTab({ folder: 'C:\\proj', tickets });
  const mod = loadPersistModule(window);
  return { tab, disk, writes, window, mod };
}

// Read the persisted `order` values (string-normalized) back off the mock disk.
function ordersOnDisk(mod, disk) {
  const out = {};
  for (const [p, content] of disk) {
    const parsed = mod.parseTicketFrontmatter(content);
    if (!parsed) continue;
    out[parsed.fm.id] = String(parsed.fm.order == null ? '' : parsed.fm.order);
  }
  return out;
}

// The Background seed: A=1 visible, B=2 hidden, C=3 visible, D=4 hidden (todo).
function filteredSeed() {
  return seedPersist([
    { id: 'TASK-701', order: 1, title: 'login alpha' },  // visible
    { id: 'TASK-702', order: 2, title: 'misc beta' },    // hidden
    { id: 'TASK-703', order: 3, title: 'login gamma' },  // visible
    { id: 'TASK-704', order: 4, title: 'misc delta' },   // hidden
  ]);
}

// Scenario: Reordering two visible cards re-indexes the FULL todo list on disk.
test('Scenario: reordering two visible cards re-indexes the FULL todo list (1..N, no duplicates)', async () => {
  const { tab, disk, mod } = filteredSeed();
  // Given the real reorderTodoTicket/persistTicketOrder extracted from renderer.js
  // When reorderTodoTicket moves the visible "TASK-703" before the visible "TASK-701"
  await mod.reorderTodoTicket(tab, 'TASK-703.md', 'TASK-701.md', /* before */ true);
  // Then the persisted `order` read back from disk is the full-list re-index.
  const orders = ordersOnDisk(mod, disk);
  assert.deepEqual(orders, {
    'TASK-703': '1',
    'TASK-701': '2',
    'TASK-702': '3',
    'TASK-704': '4',
  }, 'the FULL todo list (incl. hidden 702/704) is re-indexed, not just the visible subset');
  // And the orders form a contiguous 1..N sequence with no duplicates.
  const vals = Object.values(orders).map(Number).sort((a, b) => a - b);
  assert.deepEqual(vals, [1, 2, 3, 4], 'contiguous 1..N');
  assert.equal(new Set(vals).size, vals.length, 'no duplicate order values');
});

// Scenario (edge): hidden cards keep a consistent full-list order; the unchanged
// hidden file is not rewritten (skip-write), the shifted hidden file is.
test('Scenario (edge): hidden cards keep relative order; unchanged hidden file is byte-identical, shifted one is rewritten', async () => {
  const { tab, disk, writes, mod } = filteredSeed();
  const beforeD = disk.get(`${TASKS_DIR}\\TASK-704.md`);
  const beforeB = disk.get(`${TASKS_DIR}\\TASK-702.md`);

  // Given the same filtered reorder of "TASK-703" before "TASK-701"
  await mod.reorderTodoTicket(tab, 'TASK-703.md', 'TASK-701.md', true);

  const orders = ordersOnDisk(mod, disk);
  // Then the hidden ticket TASK-702 still sorts before the hidden ticket TASK-704.
  assert.ok(Number(orders['TASK-702']) < Number(orders['TASK-704']),
    'hidden 702 (→3) still precedes hidden 704 (→4)');

  // And TASK-704, whose index is unchanged (4→4), has byte-identical file content
  // on disk — persistTicketOrder skip-writes an unchanged order (updated untouched).
  const afterD = disk.get(`${TASKS_DIR}\\TASK-704.md`);
  assert.equal(afterD, beforeD, 'unchanged hidden card is NOT rewritten (byte-identical)');
  assert.ok(!writes.includes(`${TASKS_DIR}\\TASK-704.md`), 'no write was issued for TASK-704');

  // And TASK-702, whose index changed 2→3, WAS rewritten with order 3, status todo.
  const afterB = disk.get(`${TASKS_DIR}\\TASK-702.md`);
  assert.notEqual(afterB, beforeB, 'shifted hidden card was rewritten');
  const parsedB = mod.parseTicketFrontmatter(afterB);
  assert.equal(String(parsedB.fm.order), '3', 'TASK-702 rewritten with order 3');
  assert.equal(parsedB.fm.status, 'todo', 'TASK-702 status still todo');
  assert.ok(writes.includes(`${TASKS_DIR}\\TASK-702.md`), 'a write was issued for TASK-702');
});

// ===========================================================================
// TASK-140 — drop-AFTER (before = false) persistence coverage. TASK-137's
// persistence half above only drives the REAL reorderTodoTicket with
// before = true (the `targetIdx` splice branch). The `before = false` branch —
// `list.splice(before ? targetIdx : targetIdx + 1, 0, dragged)` at
// renderer.js:~10212 (the `targetIdx + 1` side) — was exercised only in the
// wiring half against the recorded stub. These scenarios drive the REAL
// extracted function for a drop-after, proving the full-list on-disk re-index
// (never a visible-subset re-index) while the search filter hides 702/704.
//
// Trace of the real splice for "drag TASK-701 AFTER TASK-703" (before = false):
//   sorted [701,702,703,704] → remove 701 → [702,703,704]
//   → 703 is at index 1 → splice(targetIdx+1 = 2, 0, 701) → [702,703,701,704]
//   → reindex 1..N: 702=1, 703=2, 701=3, 704=4.
// ===========================================================================

// Scenario: Dropping a visible card AFTER another visible card re-indexes the
// FULL todo list on disk (drop-after / before = false).
test('Scenario: dropping a visible card AFTER another (before=false) re-indexes the FULL todo list (1..N, no duplicates)', async () => {
  const { tab, disk, mod } = filteredSeed();
  // Given the real reorderTodoTicket/persistTicketOrder extracted from renderer.js
  // When reorderTodoTicket moves visible "TASK-701" to AFTER visible "TASK-703"
  await mod.reorderTodoTicket(tab, 'TASK-701.md', 'TASK-703.md', /* before */ false);
  // Then the persisted `order` read back from disk matches the traced splice map.
  const orders = ordersOnDisk(mod, disk);
  assert.deepEqual(orders, {
    'TASK-702': '1',
    'TASK-703': '2',
    'TASK-701': '3',
    'TASK-704': '4',
  }, 'drop-after re-indexes the FULL todo list (incl. hidden 702/704), not just the visible subset');
  // And the orders form a contiguous 1..N sequence with no duplicates
  // (a visible-subset re-index would leave two cards colliding at the same order).
  const vals = Object.values(orders).map(Number).sort((a, b) => a - b);
  assert.deepEqual(vals, [1, 2, 3, 4], 'contiguous 1..N');
  assert.equal(new Set(vals).size, vals.length, 'no duplicate order values');
  // And the hidden ticket TASK-702 still sorts before the hidden ticket TASK-704.
  assert.ok(Number(orders['TASK-702']) < Number(orders['TASK-704']),
    'hidden 702 (→1) still precedes hidden 704 (→4)');
});

// Scenario (edge): on the same drop-after, the hidden card whose index is
// unchanged (TASK-704, 4→4) is NOT gratuitously rewritten (skip-write /
// byte-identical), while the shifted cards ARE rewritten with status still todo.
test('Scenario (edge): drop-after leaves the unchanged hidden card byte-identical; shifted cards rewritten (status todo)', async () => {
  const { tab, disk, writes, mod } = filteredSeed();
  const beforeD = disk.get(`${TASKS_DIR}\\TASK-704.md`); // hidden, index 4→4 (unchanged)
  const beforeB = disk.get(`${TASKS_DIR}\\TASK-702.md`); // hidden, index 2→1 (shifted)

  // Given the same drop-after reorder of "TASK-701" AFTER "TASK-703"
  await mod.reorderTodoTicket(tab, 'TASK-701.md', 'TASK-703.md', false);

  // Then TASK-704, whose computed index equals its stored order (4→4), has
  // byte-identical file content — persistTicketOrder skip-writes (a rewrite
  // would refresh `updated` and thus change the bytes).
  const afterD = disk.get(`${TASKS_DIR}\\TASK-704.md`);
  assert.equal(afterD, beforeD, 'unchanged hidden card (704) is NOT rewritten (byte-identical)');
  assert.ok(!writes.includes(`${TASKS_DIR}\\TASK-704.md`), 'no write was issued for TASK-704');

  // And TASK-702, whose index changed 2→1, WAS rewritten with order 1, status todo.
  const afterB = disk.get(`${TASKS_DIR}\\TASK-702.md`);
  assert.notEqual(afterB, beforeB, 'shifted hidden card (702) was rewritten');
  const parsedB = mod.parseTicketFrontmatter(afterB);
  assert.equal(String(parsedB.fm.order), '1', 'TASK-702 rewritten with order 1');
  assert.equal(parsedB.fm.status, 'todo', 'TASK-702 status still todo');
  assert.ok(writes.includes(`${TASKS_DIR}\\TASK-702.md`), 'a write was issued for TASK-702');

  // And the dragged card TASK-701 (index 1→3) was rewritten, status still todo.
  const parsed701 = mod.parseTicketFrontmatter(disk.get(`${TASKS_DIR}\\TASK-701.md`));
  assert.equal(String(parsed701.fm.order), '3', 'dragged TASK-701 rewritten with order 3');
  assert.equal(parsed701.fm.status, 'todo', 'TASK-701 status still todo');
  assert.ok(writes.includes(`${TASKS_DIR}\\TASK-701.md`), 'a write was issued for TASK-701');
});

// Scenario (failure): a non-todo participant or a self-drop writes nothing.
test('Scenario (failure): a non-todo dragged/target or a self-drop performs zero writes', async () => {
  const { tab, disk, writes, mod } = seedPersist([
    { id: 'TASK-701', order: 1, title: 'login alpha' },
    { id: 'TASK-702', order: 2, title: 'misc beta' },
    { id: 'TASK-703', order: 3, title: 'login gamma' },
    { id: 'TASK-704', order: 4, title: 'misc delta' },
    { id: 'TASK-705', order: 1, title: 'in flight', status: 'in-progress' },
  ]);
  const snapshot = new Map(disk); // byte-for-byte snapshot of every seeded file

  // When reorderTodoTicket is called with a non-todo dragged ("TASK-705")...
  await mod.reorderTodoTicket(tab, 'TASK-705.md', 'TASK-701.md', true);
  // Then no file on the in-memory disk is modified.
  assert.equal(writes.length, 0, 'non-todo dragged → zero writes');
  for (const [p, c] of snapshot) assert.equal(disk.get(p), c, `${p} unchanged after non-todo drag`);

  // When reorderTodoTicket is called with dragged === target (self-drop)...
  await mod.reorderTodoTicket(tab, 'TASK-701.md', 'TASK-701.md', true);
  // Then still no file on the in-memory disk is modified.
  assert.equal(writes.length, 0, 'self-drop → zero writes');
  for (const [p, c] of snapshot) assert.equal(disk.get(p), c, `${p} unchanged after self-drop`);

  // And a non-todo TARGET is likewise refused (dragged todo, target in-progress).
  await mod.reorderTodoTicket(tab, 'TASK-701.md', 'TASK-705.md', true);
  assert.equal(writes.length, 0, 'non-todo target → zero writes');
  for (const [p, c] of snapshot) assert.equal(disk.get(p), c, `${p} unchanged after non-todo target`);
});

// Guard: the extracted functions are the REAL async source (not a stub / copy).
test('the persistence half exercises the REAL async reorderTodoTicket/persistTicketOrder source', () => {
  assert.match(rendererSrc, /async\s+function\s+reorderTodoTicket\(tab,\s*draggedFile,\s*targetFile,\s*before\)/);
  assert.match(rendererSrc, /async\s+function\s+persistTicketOrder\(tab,\s*file,\s*order\)/);
  // The full-list re-index (never the DOM) is what the persistence half proves.
  assert.match(rendererSrc, /persistTicketOrder\(tab,\s*list\[i\]\.file,\s*i\s*\+\s*1\)/);
});
