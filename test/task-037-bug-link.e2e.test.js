'use strict';

// ===========================================================================
// TASK-037 — e2e "cucumber" scenarios (Given/When/Then) for
//   Feature: The original ticket records which bug ticket was filed against it
// implemented as plain `node --test` cases. NO `cucumber` npm package is
// installed or added.
//
// The change: the Bug-button flow makes the original <-> bug link BIDIRECTIONAL.
// The new bug ticket already carries `bug-of: <ORIG_ID>` + a `Bug against
// <ORIG_ID>` body line (unchanged). NEW: the ORIGINAL's folded `## Bug Reports`
// entry now names the new bug ticket id via a `Reported as <NEW_ID>` line
// (renderer onCreateBug STEP 1 composes `bug: 'Reported as ' + id + '\n' +
// bugDesc`). The whole composed string is routed through neutralizeBugText so
// neither the id nor the description can forge a `## ` section boundary.
//
// The renderer (renderer/renderer.js) is a browser script that cannot be
// require()'d, so — matching test/task-031-bug-reporting.e2e.test.js — the
// LOGIC is proven behaviorally against the requireable lib twins the renderer
// mirrors (lib/ticket-bug-reports.js appendBugReport, lib/markdown-escape.js
// escapeLeadingHeadingRun), with serializeTicket/parseTicketFrontmatter copied
// verbatim, and SOURCE-SCAN drift guards tie the new id-composition back to the
// REAL renderer source so a silent regression fails a test here.
//
// NO DATABASE, NO REAL FILESYSTEM WRITE, NO NETWORK. The "board" is an in-memory
// Map; every fs.readFile/writeFile the renderer would call is modeled in memory.
// Timestamps are ALWAYS passed explicitly (never Date.now) for determinism.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  appendBugReport,
  BUG_REPORTS_HEADING,
  ADDITIONAL_CONTEXT_HEADING,
} = require('../lib/ticket-bug-reports');
const { escapeLeadingHeadingRun } = require('../lib/markdown-escape');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');

// VERBATIM copies of the renderer's whole-file serializer/parser (drift-guarded
// below by round-trip, and shared with the TASK-031 e2e model).
function serializeTicket(fm, body) {
  const order = ['id', 'title', 'status', 'created', 'updated'];
  const keys = order.filter((k) => fm[k] != null);
  for (const k of Object.keys(fm)) if (!keys.includes(k)) keys.push(k);
  const fmLines = keys.map((k) => `${k}: ${fm[k]}`);
  return ['---', ...fmLines, '---', body || ''].join('\n');
}
function parseTicketFrontmatter(content) {
  if (typeof content !== 'string') return null;
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  if (lines[0].trim() !== '---') return null;
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) if (lines[i].trim() === '---') { closeIdx = i; break; }
  if (closeIdx === -1) return null;
  const fm = {};
  for (let i = 1; i < closeIdx; i++) {
    const idx = lines[i].indexOf(':');
    if (idx === -1) continue;
    const key = lines[i].slice(0, idx).trim();
    if (key) fm[key] = lines[i].slice(idx + 1).trim();
  }
  return { fm, body: lines.slice(closeIdx + 1).join('\n') };
}

// ---------------------------------------------------------------------------
// In-memory model of onCreateBug (renderer.js STEP 1 + STEP 2) as it is NOW,
// after TASK-037: STEP 1 folds the bug into the original with the NEW id
// prefixed onto the text; STEP 2 writes the linked bug ticket. Mirrors the
// write order (original first) and fm/body composition. Returns the disk Map
// plus origPath/bugPath so both sides of the link can be parsed back.
// ---------------------------------------------------------------------------
function simulateCreateBug({ board, title, originalId, bugDesc, newId, now, disk }) {
  const store = disk || new Map();
  const t = String(title == null ? '' : title).trim();
  const oid = String(originalId == null ? '' : originalId).trim();
  const desc = String(bugDesc == null ? '' : bugDesc).trim();
  if (!t) return { ok: false, error: 'Title is required.', disk: store };
  if (!oid) return { ok: false, error: 'Select the original ticket this bug is against.', disk: store };
  if (!desc) return { ok: false, error: 'Describe the bug before creating.', disk: store };
  let original = null;
  for (const tk of board.values()) if (tk && tk.fm && tk.fm.id === oid) { original = tk; break; }
  if (!original) return { ok: false, error: 'Original ticket ' + oid + ' is no longer on the board.', disk: store };

  // ── STEP 1: fold into the ORIGINAL, naming the new bug id (TASK-037).
  const readContent = store.has(original.path)
    ? store.get(original.path)
    : serializeTicket(original.fm, original.body);
  const parsed = parseTicketFrontmatter(readContent);
  if (!parsed) return { ok: false, error: 'Original ticket ' + oid + ' is not a valid ticket file.', disk: store };
  // The load-bearing TASK-037 composition: the WHOLE bug string is the id line
  // + the description; appendBugReport neutralizes the whole thing.
  const newOrigBody = appendBugReport(parsed.body, { bug: 'Reported as ' + newId + '\n' + desc, timestamp: now });
  const newOrigFm = Object.assign({}, parsed.fm, { updated: now });
  if (!newOrigFm.created) newOrigFm.created = now;
  store.set(original.path, serializeTicket(newOrigFm, newOrigBody));

  // ── STEP 2: create the NEW bug ticket, linked back via bug-of + body ref.
  const fm = { id: newId, title: t, status: 'todo', created: now, updated: now };
  fm['bug-of'] = oid;
  const body = [
    '',
    '## Description',
    'Bug against ' + oid,
    '',
    escapeLeadingHeadingRun(desc),
    '',
    '## Acceptance Criteria',
    '- [ ] First testable criterion',
    '',
    '## Additional Context',
    '(User-owned. Read it before building. Never overwrite it.)',
    '',
  ].join('\n');
  const bugPath = 'tasks/todo/' + newId + '-bug.md';
  store.set(bugPath, serializeTicket(fm, body));
  return { ok: true, error: '', disk: store, origPath: original.path, bugPath };
}

function makeBoard() {
  const board = new Map();
  board.set('tasks/todo/TASK-010-toggle.md', {
    path: 'tasks/todo/TASK-010-toggle.md',
    fm: { id: 'TASK-010', title: 'Persist toggle', status: 'todo', created: '2026-07-01T00:00:00.000Z', updated: '2026-07-01T00:00:00.000Z' },
    body: [
      '',
      '## Description',
      'A toggle persists a user preference across reloads.',
      '',
      '## Acceptance Criteria',
      '- [x] toggle persists',
      '',
      '## Additional Context',
      '(User-owned. Read it before building. Never overwrite it.)',
      'Deploy note with **markdown**.',
    ].join('\n'),
  });
  return board;
}

function headingIndex(md, heading) {
  return md.split('\n').findIndex((l) => l.trim() === heading);
}
function sectionSlice(md, heading) {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^## /.test(lines[i])) { end = i; break; }
  return lines.slice(start, end).join('\n');
}

// ===========================================================================
// Scenario: Original names the new bug ticket id (primary Gherkin)
//   Given the Bug button creates bug ticket "TASK-050" against original "TASK-010"
//   When TASK-010's file is written and parsed back
//   Then its "## Bug Reports" section references "TASK-050"
//   And the new ticket "TASK-050" still carries "bug-of: TASK-010"
// ===========================================================================
test('Scenario: the original names the new bug ticket id and the link is bidirectional', () => {
  // Given the Bug button creates bug ticket "TASK-050" against original "TASK-010"
  const board = makeBoard();
  const disk = new Map();
  const now = '2026-07-19T12:00:00.000Z';
  const r = simulateCreateBug({
    board, disk, now,
    title: 'Toggle ignores saved preference',
    originalId: 'TASK-010',
    bugDesc: 'Reloading resets the toggle to on',
    newId: 'TASK-050',
  });
  assert.equal(r.ok, true, r.error);

  // When TASK-010's file is written and parsed back
  const orig = parseTicketFrontmatter(disk.get(r.origPath));
  const sec = sectionSlice(orig.body, BUG_REPORTS_HEADING);

  // Then its "## Bug Reports" section references "TASK-050" (names the new id)
  assert.ok(sec, 'a Bug Reports section exists on the original');
  assert.match(sec, /Reported as TASK-050/, 'the original names the new bug ticket id');
  assert.match(sec, /Reloading resets the toggle to on/, 'the bug description is recorded too');

  // And the new ticket "TASK-050" still carries "bug-of: TASK-010" + body ref
  const bug = parseTicketFrontmatter(disk.get(r.bugPath));
  assert.equal(bug.fm['bug-of'], 'TASK-010', 'new ticket carries bug-of frontmatter');
  assert.match(bug.body, /Bug against TASK-010/, 'new ticket body references the original');

  // And BOTH sides are navigable: original -> new id, new -> original id.
  assert.ok(orig.body.includes('TASK-050'), 'from the original you can find the new ticket id');
  assert.ok(bug.body.includes('TASK-010') && bug.fm['bug-of'] === 'TASK-010',
    'from the new ticket you can find the original');
});

// ===========================================================================
// Scenario: Additional Context is preserved (edge)
//   Given original "TASK-010" has a "## Additional Context" section
//   When a bug is filed against it naming the new id
//   Then "## Additional Context" is unchanged and remains at the tail
// ===========================================================================
test('Scenario (edge): Additional Context is unchanged and remains at the tail after naming the new id', () => {
  // Given original "TASK-010" has a "## Additional Context" section
  const board = makeBoard();
  const original = board.get('tasks/todo/TASK-010-toggle.md');
  const acBefore = sectionSlice(original.body, ADDITIONAL_CONTEXT_HEADING);
  const createdBefore = original.fm.created;
  const disk = new Map();
  const now = '2026-07-19T12:00:00.000Z';

  // When a bug is filed against it naming the new id
  const r = simulateCreateBug({
    board, disk, now,
    title: 'Toggle ignores saved preference',
    originalId: 'TASK-010',
    bugDesc: 'Reloading resets the toggle to on',
    newId: 'TASK-050',
  });
  assert.equal(r.ok, true, r.error);
  const orig = parseTicketFrontmatter(disk.get(r.origPath));

  // Then the Bug Reports section (with the id) is inserted BEFORE Additional Context
  assert.ok(headingIndex(orig.body, BUG_REPORTS_HEADING) < headingIndex(orig.body, ADDITIONAL_CONTEXT_HEADING),
    'Bug Reports precedes Additional Context');
  // And "## Additional Context" is unchanged and remains at the tail
  assert.equal(sectionSlice(orig.body, ADDITIONAL_CONTEXT_HEADING), acBefore, 'Additional Context byte-for-byte');
  const acIdx = headingIndex(orig.body, ADDITIONAL_CONTEXT_HEADING);
  assert.ok(!orig.body.split('\n').slice(acIdx + 1).some((l) => /^## /.test(l)), 'Additional Context is last');
  // And created preserved / updated bumped.
  assert.equal(orig.fm.created, createdBefore, 'created preserved');
  assert.equal(orig.fm.updated, now, 'updated bumped');
});

// ===========================================================================
// Scenario: the id reference cannot forge a section (edge — heading-escape)
// ===========================================================================
test('Scenario (edge): a heading-like id or description cannot forge a section — the whole composed string is escaped', () => {
  const board = makeBoard();
  const disk = new Map();
  const now = '2026-07-19T12:00:00.000Z';

  // When the description itself tries to forge a `## Additional Context` boundary
  const r = simulateCreateBug({
    board, disk, now,
    title: 'Forge attempt',
    originalId: 'TASK-010',
    bugDesc: '## Additional Context\nthen it crashes',
    newId: 'TASK-050',
  });
  assert.equal(r.ok, true, r.error);
  const orig = parseTicketFrontmatter(disk.get(r.origPath));
  const sec = sectionSlice(orig.body, BUG_REPORTS_HEADING);

  // Then the id reference is still present AND the forging line is escaped
  assert.match(sec, /Reported as TASK-050/, 'the id reference survives');
  assert.match(sec, /\\## Additional Context/, 'the forging description line is escaped');
  // And no NEW real `## Additional Context` boundary is forged (still exactly one)
  assert.equal((orig.body.match(/^## Additional Context$/gm) || []).length, 1,
    'exactly one real Additional Context — none forged');
  // And the genuine section order is intact with Additional Context last.
  const real = orig.body.split('\n').filter((l) => /^## /.test(l)).map((l) => l.trim());
  assert.deepEqual(real, ['## Description', '## Acceptance Criteria', '## Bug Reports', '## Additional Context']);
});

// ===========================================================================
// SOURCE-SCAN DRIFT GUARDS — tie the model above to the REAL renderer source so
// the TASK-037 fix cannot silently regress in renderer/renderer.js.
// ===========================================================================
function opener() {
  return rendererSrc.slice(rendererSrc.indexOf('function openNewTaskModal'), rendererSrc.indexOf('function openPlanModal'));
}

test('DRIFT GUARD: onCreateBug STEP 1 composes the bug text with "Reported as " + id (names the new bug id in the original)', () => {
  const src = opener();
  const body = src.slice(src.indexOf('const onCreateBug ='), src.indexOf('const onCreate ='));
  // The exact TASK-037 composition: the original fold prefixes 'Reported as ' + id
  // onto the description and passes the WHOLE string as `bug` (so it is escaped).
  assert.match(
    body,
    /appendBugReportToMarkdown\(origBody,\s*\{\s*bug:\s*'Reported as '\s*\+\s*id\s*\+\s*'\\n'\s*\+\s*bugDesc\s*,\s*timestamp:\s*now\s*\}\)/,
    "STEP 1 folds the original with bug: 'Reported as ' + id + '\\n' + bugDesc",
  );
  // The append call precedes the bug-ticket build (original-first ordering kept).
  assert.ok(
    body.indexOf("'Reported as '") < body.indexOf("fm['bug-of'] = originalId"),
    'the original is named-and-folded BEFORE the linked bug ticket is composed',
  );
});

test('DRIFT GUARD: the id named in the original is the NEW bug ticket id = nextTaskId(tab)', () => {
  const src = opener();
  // `id` (the value folded as "Reported as <id>") is the freshly-allocated bug id.
  assert.match(src, /const id = nextTaskId\(tab\);/, 'the modal id is nextTaskId(tab), the new bug ticket id');
  // And nextTaskId derives the next TASK-nnn from the live board.
  assert.match(rendererSrc, /function nextTaskId\(tab\)\s*\{[\s\S]*?return 'TASK-' \+ String\(max \+ 1\)\.padStart\(3, '0'\);/,
    'nextTaskId allocates the next TASK-nnn id from the board');
});

test('DRIFT GUARD: the still-present other side of the link (bug-of + "Bug against <ID>") is intact', () => {
  const body = opener().slice(opener().indexOf('const onCreateBug ='), opener().indexOf('const onCreate ='));
  assert.match(body, /fm\['bug-of'\] = originalId;/, 'new ticket carries bug-of');
  // TASK-040: the original id is heading-escaped before interpolation.
  assert.match(body, /'Bug against ' \+ neutralizeBugText\(originalId\)/, 'new ticket body references the original (heading-escaped, TASK-040)');
});

// Sanity: the copied serializer/parser round-trips (guards the verbatim copies).
test('DRIFT GUARD: serialize/parse round-trip keeps the extra bug-of key after the leading five', () => {
  const fm = { id: 'TASK-050', title: 't', status: 'todo', created: 'c', updated: 'u', 'bug-of': 'TASK-010' };
  const round = parseTicketFrontmatter(serializeTicket(fm, 'body'));
  assert.deepEqual(Object.keys(round.fm), ['id', 'title', 'status', 'created', 'updated', 'bug-of']);
  assert.equal(round.fm['bug-of'], 'TASK-010');
});
