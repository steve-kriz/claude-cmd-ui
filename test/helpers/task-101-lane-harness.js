'use strict';

// ===========================================================================
// TASK-101 test harness — loads the REAL renderer/renderer.js lane logic
// (normalizeTasksColumns, tasksUserStatusSet, tasksConfigSig, rebuildTasksLanes,
// buildTasksLaneEl, attachTasksLaneDrop, renderTasksBoard, pollTasksOnce) headless
// so tests can drive the ACTUAL shipped functions against a minimal in-memory
// mock DOM + a stubbed window.api.fs — never the browser, never a real DB/FS.
//
// renderer.js is a browser script (no module.exports, references `document`), so
// — matching test/task-094-agents-panel.e2e.test.js — the needed declarations are
// extracted by brace-matching / regex and evaluated with injected window/document/
// console. The heavy UI/IPC collaborators the render path only touches inside event
// handlers (openNewTaskModal, moveTicketToStatus, openBugReportModal, …) are
// replaced by call-recording stubs on window.__calls so nothing real is invoked.
//
// This file is intentionally NOT named *.test.js so `node --test test/**/*.test.js`
// does not execute it as a test file — it is a shared require()-able harness.
// ===========================================================================

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const RENDERER = path.join(__dirname, '..', '..', 'renderer', 'renderer.js');
const rendererSrc = fs.readFileSync(RENDERER, 'utf8');

// Extract a (possibly async) named function declaration by brace-matching.
function extractFn(src, name) {
  let start = src.indexOf('function ' + name + '(');
  assert.ok(start !== -1, `function ${name} found in renderer.js`);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) { i += 1; break; } }
  }
  return src.slice(start, i);
}
// Extract a `const NAME = …;` declaration up to its terminating semicolon.
function extractConst(src, name) {
  const m = src.match(new RegExp('const\\s+' + name + '\\s*=[\\s\\S]*?;'));
  assert.ok(m, `const ${name} found in renderer.js`);
  return m[0];
}

// ---------------------------------------------------------------------------
// Minimal in-memory mock DOM. className is backed by the class set that
// classList mutates; textContent clears children when set; querySelector does a
// depth-first descendant search for a single ".class" selector; innerHTML='' wipes
// children (as rebuildTasksLanes relies on).
// ---------------------------------------------------------------------------
function makeEl(tag) {
  const classes = new Set();
  const children = [];
  const attrs = {};
  let text = '';
  const el = {
    tagName: String(tag || '').toUpperCase(),
    dataset: {}, style: {}, children, attrs,
    _listeners: {},
    disabled: false, value: '', rows: 0, draggable: false, title: '', type: '',
    parentNode: null,
    classList: {
      add(...cs) { cs.forEach((c) => classes.add(c)); },
      remove(...cs) { cs.forEach((c) => classes.delete(c)); },
      toggle(c, on) {
        const want = on === undefined ? !classes.has(c) : !!on;
        if (want) classes.add(c); else classes.delete(c);
        return want;
      },
      contains(c) { return classes.has(c); },
    },
    appendChild(c) { children.push(c); c.parentNode = el; return c; },
    addEventListener(t, fn) { (el._listeners[t] = el._listeners[t] || []).push(fn); },
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) { return k in attrs ? attrs[k] : null; },
    getBoundingClientRect() { return { top: 0, left: 0, height: 10, width: 10 }; },
    focus() {},
    querySelector(sel) { return findByClass(el, String(sel).replace(/^\./, '')); },
    querySelectorAll(sel) { return findAllByClass(el, String(sel).replace(/^\./, '')); },
  };
  Object.defineProperty(el, 'className', {
    get() { return [...classes].join(' '); },
    set(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
  });
  Object.defineProperty(el, 'textContent', {
    get() { return children.length ? children.map((c) => c.textContent).join('') : text; },
    set(v) { text = String(v); children.length = 0; },
  });
  Object.defineProperty(el, 'innerHTML', {
    get() { return ''; },
    set(v) { if (String(v) === '') children.length = 0; },
  });
  return el;
}
function makeDocument() {
  return {
    hidden: false,
    createElement: (tag) => makeEl(tag),
    createTextNode: (t) => ({ _isText: true, textContent: String(t) }),
  };
}
// Depth-first: first descendant (not the root) whose classList contains `cls`.
function findByClass(root, cls) {
  for (const c of (root.children || [])) {
    if (c.classList && c.classList.contains(cls)) return c;
    const deep = findByClass(c, cls);
    if (deep) return deep;
  }
  return null;
}
function findAllByClass(root, cls, out) {
  out = out || [];
  for (const c of (root.children || [])) {
    if (c.classList && c.classList.contains(cls)) out.push(c);
    findAllByClass(c, cls, out);
  }
  return out;
}
// Fire every listener of `type`, awaiting any returned promise.
async function fire(el, type, evt) {
  const e = Object.assign({
    preventDefault() {}, stopPropagation() {},
    dataTransfer: { setData() {}, getData() { return ''; } },
  }, evt || {});
  const fns = (el._listeners && el._listeners[type]) || [];
  for (const fn of fns) await fn(e);
}

// ---------------------------------------------------------------------------
// Build a fresh module instance. `draggingTaskFile`/`draggingTaskStatus` are
// module-level in the renderer, so a fresh instance per test avoids leakage.
// Collaborators only reached from event handlers are recorded on window.__calls.
// ---------------------------------------------------------------------------
function loadLaneModule(window, document, console) {
  const body = [
    // --- constants (ordered so cross-references resolve) ---
    extractConst(rendererSrc, 'TASKS_LANE_STATUSES'),
    extractConst(rendererSrc, 'TASKS_VALID_STATUSES'),
    extractConst(rendererSrc, 'TASKS_ACTIVE_STATUSES'),
    extractConst(rendererSrc, 'TASKS_FAILED_STATUS'),
    extractConst(rendererSrc, 'TASKS_UNKNOWN_STATUS'),
    extractConst(rendererSrc, 'TASKS_SYSTEM_LABELS'),
    extractConst(rendererSrc, 'TASKS_RESERVED_SLUGS'),
    extractConst(rendererSrc, 'TASKS_MAX_SLUG_LENGTH'),
    extractConst(rendererSrc, 'TASKS_SLUG_RE'),
    extractConst(rendererSrc, 'TASKS_ARCHIVE_AFTER_DAYS'),
    extractConst(rendererSrc, 'TASKS_ARCHIVE_AFTER_MS'),
    // TASK-180's column `phase` link (TASKS_PHASE_KEYS/tasksNormalizeColumnPhase)
    // was fully removed by TASK-201/203 — tasksBuildColumn no longer has a phase
    // field, so neither symbol is extracted here any more.
    // --- real functions under test + their pure helpers ---
    extractFn(rendererSrc, 'tasksPrettifyLabel'),
    extractFn(rendererSrc, 'tasksBuildColumn'),
    extractFn(rendererSrc, 'normalizeTasksColumns'),
    extractFn(rendererSrc, 'tasksUserStatusSet'),
    extractFn(rendererSrc, 'tasksConfigSig'),
    extractFn(rendererSrc, 'inferSep'),
    extractFn(rendererSrc, 'appendPath'),
    extractFn(rendererSrc, 'tasksJoin'),
    extractFn(rendererSrc, 'tasksBasename'),
    extractFn(rendererSrc, 'tasksSubfolder'),
    extractFn(rendererSrc, 'ticketFolderForStatus'),
    extractFn(rendererSrc, 'ticketFolderMatchesStatus'),
    // TASK-102 — filesystem-safety gate + config-aware folder helpers. Needed
    // both directly and because the real dedupeTicketsByFolder / drop-refusal
    // path reference ticketFolderMatchesStatusWith / ticketFolderForStatusWith,
    // which in turn call isSafeTasksSlug.
    extractFn(rendererSrc, 'isSafeTasksSlug'),
    extractFn(rendererSrc, 'ticketFolderForStatusWith'),
    extractFn(rendererSrc, 'ticketFolderMatchesStatusWith'),
    extractFn(rendererSrc, 'dedupeTicketsByFolder'),
    extractFn(rendererSrc, 'parseTicketFrontmatter'),
    extractFn(rendererSrc, 'ticketFieldNonEmpty'),
    extractFn(rendererSrc, 'isTicketWaitingForAnswer'),
    extractFn(rendererSrc, 'isWontDoTicket'),
    // TASK-132 — renderTasksBoard now calls the pure board-search matcher for
    // every ticket; extract it (and the tiny input-side helpers) or the render
    // path throws ReferenceError. Purely additive; test-only.
    extractFn(rendererSrc, 'taskMatchesSearch'),
    extractFn(rendererSrc, 'updateTasksSearchClear'),
    extractFn(rendererSrc, 'onTasksSearchInput'),
    extractFn(rendererSrc, 'clearTasksSearch'),
    extractFn(rendererSrc, 'isBugTicket'),
    extractFn(rendererSrc, 'isReviewTicket'),
    extractFn(rendererSrc, 'ticketOrderValue'),
    extractFn(rendererSrc, 'compareTicketOrder'),
    extractFn(rendererSrc, 'ticketArchiveTimestamp'),
    extractFn(rendererSrc, 'ticketIsArchived'),
    extractFn(rendererSrc, 'rebuildTasksLanes'),
    extractFn(rendererSrc, 'buildTasksLaneEl'),
    // TASK-111 — attachTasksLaneDrop's stale-snapshot guard now delegates to the
    // shared tasksActiveClaimRefusal predicate (centralised so the drop guard and
    // moveTicketToStatus's fresh re-check can't drift). Extract it or the drop
    // handler throws ReferenceError. Its collaborators (TASKS_ACTIVE_STATUSES,
    // ticketFieldNonEmpty) are already extracted above.
    extractFn(rendererSrc, 'tasksActiveClaimRefusal'),
    extractFn(rendererSrc, 'attachTasksLaneDrop'),
    extractFn(rendererSrc, 'renderTasksBoard'),
    extractFn(rendererSrc, 'pollTasksOnce'),
    // TASK-106 — pollTasksOnce now calls syncTasksConcurrencyOption(tab) to reflect
    // the config's skill.concurrencyDefault on the Tasks toolbar dropdown. The mock
    // tab has no `tasksConcurrency` <select>, so the function early-returns (its
    // localStorage / currentTasksConcurrency references are never reached), but it
    // MUST be defined or the poll throws a ReferenceError inside its try/catch and
    // the board never renders. Extract it (a no-op here) so the poll completes.
    extractFn(rendererSrc, 'syncTasksConcurrencyOption'),
    // TASK-102 — the modal status <select> builder (config-driven options +
    // "Won't do"). Uses the injected `document` to createElement its options.
    extractFn(rendererSrc, 'populateTaskStatusOptions'),
    // --- module-level mutable state used by the render/drag path ---
    'let draggingTaskFile = null;',
    'let draggingTaskStatus = null;',
    // --- call-recording / no-op stubs for out-of-scope collaborators ---
    'window.__calls = window.__calls || {};',
    'function rec(name, payload){ (window.__calls[name] = window.__calls[name] || []).push(payload); }',
    'function openNewTaskModal(tab, mode){ rec("openNewTaskModal", mode || null); }',
    'function openTaskModal(tab, tk){ rec("openTaskModal", tk); }',
    'function moveTicketToStatus(tab, file, status){ rec("moveTicketToStatus", { file, status }); }',
    'function openBugReportModal(tab, file){ rec("openBugReportModal", { file }); }',
    'function reorderTodoTicket(tab, dragged, target, before){ rec("reorderTodoTicket", { dragged, target, before }); }',
    'function clearTaskDropMarkers(tab){}',
    'function ticketAccountingParts(fm){ return []; }',
    'function updateBuildBtn(tab){}',
    'function updatePlanBtn(tab){}',
    'function maybeContinueBuild(tab){}',
    'function reportTasksActivity(){}',
    'function reportWindowAttention(){}',
    'async function reconcileTicketFolders(tab, entries){ rec("reconcileTicketFolders", entries); }',
    // TASK-102 — transient board notice (the drop-refusal path calls it). Recorded
    // so a test can assert a refused drop surfaced a notice and wrote nothing.
    'function showTasksNotice(tab, message){ rec("showTasksNotice", String(message)); }',
    // --- exports ---
    'return { normalizeTasksColumns, tasksUserStatusSet, tasksConfigSig,',
    '  tasksActiveClaimRefusal,',
    '  taskMatchesSearch, updateTasksSearchClear, onTasksSearchInput, clearTasksSearch,',
    '  rebuildTasksLanes, buildTasksLaneEl, attachTasksLaneDrop, renderTasksBoard,',
    '  pollTasksOnce, populateTaskStatusOptions, isSafeTasksSlug,',
    '  ticketFolderForStatusWith, ticketFolderMatchesStatusWith, dedupeTicketsByFolder,',
    '  TASKS_LANE_STATUSES, TASKS_VALID_STATUSES, TASKS_UNKNOWN_STATUS,',
    '  TASKS_ACTIVE_STATUSES, TASKS_FAILED_STATUS, TASKS_SYSTEM_LABELS,',
    '  TASKS_MAX_SLUG_LENGTH, TASKS_SLUG_RE };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function('window', 'document', 'console', body)(window, document, console);
}

// A stubbed window.api.fs backed by an in-memory file map. `files` maps absolute
// path → string content (or a special value). `dirs` maps absolute dir → array of
// absolute .md file paths returned by findByExt. Both findByExt and readFile can be
// made to fail by omitting the entry. NO real disk / DB / network is touched.
//
// TASK-119: pollTasksOnce now probes `window.api.fs.exists` to distinguish an
// intentional delete of team-config.json / an absent .claude/agents/ dir (a
// CONFIRMED not-found → revert config to defaults / leave agent set null) from a
// transient present-but-unreadable read error (keep last-good). The stub derives a
// sensible default from the same in-memory maps — a path present in `dirs` is a
// confirmed directory, a path present in `files` is a confirmed file, anything else
// is a confirmed not-found — and an explicit per-path `exists` option map overrides
// that default so a test can model a present-but-unreadable file (readFile fails
// while exists reports `{ ok:true, exists:true }`) or an out-of-root probe
// (`{ ok:false }`). Still no real disk / DB / network is touched.
function makeWindow(opts) {
  const o = opts || {};
  const files = new Map(Object.entries(o.files || {}));
  const dirs = new Map(Object.entries(o.dirs || {}));
  const existsMap = new Map(Object.entries(o.exists || {}));
  const calls = { findByExt: [], readFile: [], exists: [] };
  const missDirs = new Set(o.missingDirs || []);
  const window = {
    __calls: {},
    api: {
      fs: {
        async findByExt(root, ext) {
          calls.findByExt.push({ root, ext });
          if (missDirs.has(root)) return { ok: false, error: 'ENOENT' };
          if (dirs.has(root)) return { ok: true, files: dirs.get(root).slice() };
          return { ok: false, error: 'ENOENT: ' + root };
        },
        async readFile(filePath) {
          calls.readFile.push({ filePath });
          if (!files.has(filePath)) return { ok: false, error: 'ENOENT: ' + filePath };
          const v = files.get(filePath);
          if (v && v.__binary) return { ok: true, content: '(binary)', binary: true };
          return { ok: true, content: String(v) };
        },
        async exists(p) {
          calls.exists.push({ p });
          if (existsMap.has(p)) return existsMap.get(p);
          if (dirs.has(p)) return { ok: true, exists: true, isDir: true, isFile: false };
          if (files.has(p)) return { ok: true, exists: true, isDir: false, isFile: true };
          return { ok: true, exists: false, isDir: false, isFile: false };
        },
      },
      tasks: { reportActivity() {} },
    },
  };
  return { window, calls, files, dirs, existsMap, missDirs };
}

// Build a tab whose els are mock elements (only the ones the render path touches).
function makeTab(overrides) {
  const o = overrides || {};
  return {
    folder: o.folder || 'C:\\proj',
    activeSubTab: 'tasks',
    els: {
      tasksBoard: makeEl('div'),
      tasksEmpty: makeEl('div'),
      tasksStatus: makeEl('span'),
      // TASK-132 — board search els. Additive; the render path tolerates their
      // absence (guards on tab.els.tasksNoMatch), but supplying them lets search
      // scenarios drive the real input handlers headlessly.
      tasksSearch: makeEl('input'),
      tasksSearchClear: makeEl('button'),
      tasksNoMatch: makeEl('div'),
      ws: { classList: { contains() { return true; } } },
    },
    tasks: {
      tickets: o.tickets || new Map(),
      config: o.config != null ? o.config : null,
      agentNames: o.agentNames || null,
      archiveExpanded: false,
      searchQuery: o.searchQuery || '',
      pollTimer: o.pollTimer || null,
      skillInstalled: o.skillInstalled != null ? o.skillInstalled : true,
      fetching: false,
      reconciling: false,
      lastSig: o.lastSig != null ? o.lastSig : '',
    },
  };
}

// Convenience: build a tickets Map keyed by file name from an array of frontmatters.
function ticketsMap(entries) {
  const m = new Map();
  for (const e of entries) {
    const file = e.file || `${e.fm.id}.md`;
    m.set(file, { file, path: file, folder: e.folder || '', fm: e.fm, body: e.body || '', raw: e.raw || '' });
  }
  return m;
}

// Read the generated lane elements (ordered) from a rendered board.
function laneEls(tab) {
  return findAllByClass(tab.els.tasksBoard, 'tasks-lane');
}
function laneStatuses(tab) {
  return laneEls(tab).map((el) => el.dataset.status);
}

module.exports = {
  rendererSrc,
  loadLaneModule,
  makeEl, makeDocument, findByClass, findAllByClass, fire,
  makeWindow, makeTab, ticketsMap, laneEls, laneStatuses,
};
