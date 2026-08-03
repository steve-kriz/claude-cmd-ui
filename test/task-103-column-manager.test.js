'use strict';

// ===========================================================================
// TASK-103 — UNIT tests for the Team tab Board panel column-manager pure
// helpers, driven against the REAL renderer/renderer.js source.
//
// renderer/renderer.js is a browser script (no module.exports; references
// `document`/`window`), so — matching test/task-094-agents-panel.e2e.test.js and
// test/helpers/task-101-lane-harness.js — the pure functions under test are
// EXTRACTED by brace-matching / regex from the shipped source and evaluated in a
// sandbox. This proves the ACTUAL shipped code, not a replica.
//
// Covered:
//   tasksSlugForLabel        — label → derived slug (clamp / strip / empties)
//   tasksValidateNewColumn   — blank / dup / reserved / accept
//   canSwapTeamColumns       — system-order protection
//   countTeamTicketsForStatus— live-board ticket counting
//   tasksSerializeTeamConfig — normalizes, drops invalid, round-trips via
//                              lib/team-config.js normalizeConfig (the authority)
//
// The two guard branches the renderer mirror keeps for parity but that its own
// slug-deriver makes structurally unreachable (over-long / non-slug derived
// slugs) are covered against lib/team-config.js validateNewColumn — the
// authoritative validator this renderer function mirrors "KEEP IN SYNC".
//
// NO DATABASE, DISK, ELECTRON, OR NETWORK: every function here is pure.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const teamConfig = require('../lib/team-config.js');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');

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
function extractConst(src, name) {
  const m = src.match(new RegExp('const\\s+' + name + '\\s*=[\\s\\S]*?;'));
  assert.ok(m, `const ${name} found in renderer.js`);
  return m[0];
}

// Load the REAL renderer pure helpers headless.
function loadRenderer() {
  const body = [
    extractConst(rendererSrc, 'TASKS_LANE_STATUSES'),
    extractConst(rendererSrc, 'TASKS_VALID_STATUSES'),
    extractConst(rendererSrc, 'TASKS_UNKNOWN_STATUS'),
    extractConst(rendererSrc, 'TASKS_SYSTEM_LABELS'),
    extractConst(rendererSrc, 'TASKS_RESERVED_SLUGS'),
    extractConst(rendererSrc, 'TASKS_MAX_SLUG_LENGTH'),
    extractConst(rendererSrc, 'TASKS_SLUG_RE'),
    // TASK-180's `phase` link (and TASKS_PHASE_KEYS/tasksNormalizeColumnPhase)
    // was fully removed by TASK-201/203 — tasksBuildColumn no longer has a
    // phase field, so neither symbol is extracted here any more.
    // TASK-121 (F2): tasksSerializeTeamConfig now clamps skill.concurrencyDefault
    // through resolveTasksConcurrency, so the serializer needs these three symbols
    // in scope or it throws ReferenceError. Function declarations hoist, so the
    // clamp helper's position is immaterial; the two consts must precede any call.
    extractConst(rendererSrc, 'TASKS_MAX_CONCURRENCY'),
    extractConst(rendererSrc, 'TASKS_DEFAULT_CONCURRENCY'),
    extractFn(rendererSrc, 'resolveTasksConcurrency'),
    extractFn(rendererSrc, 'tasksPrettifyLabel'),
    extractFn(rendererSrc, 'tasksBuildColumn'),
    extractFn(rendererSrc, 'normalizeTasksColumns'),
    extractFn(rendererSrc, 'tasksSlugForLabel'),
    extractFn(rendererSrc, 'tasksValidateNewColumn'),
    // TASK-200 — tasksSerializeTeamConfig now normalises skill.contextOptimization
    // via tasksNormalizeContextOptimization, so these must be in scope too.
    extractConst(rendererSrc, 'TASKS_CONTEXT_OPT_LEVELS'),
    extractConst(rendererSrc, 'TASKS_CONTEXT_OPT_DEFAULT'),
    extractFn(rendererSrc, 'tasksNormalizeContextOptimization'),
    extractFn(rendererSrc, 'tasksSerializeTeamConfig'),
    extractFn(rendererSrc, 'canSwapTeamColumns'),
    extractFn(rendererSrc, 'countTeamTicketsForStatus'),
    'return { TASKS_RESERVED_SLUGS, TASKS_MAX_SLUG_LENGTH, tasksSlugForLabel,',
    '  tasksValidateNewColumn, tasksSerializeTeamConfig, canSwapTeamColumns,',
    '  countTeamTicketsForStatus, normalizeTasksColumns };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(body)();
}
const R = loadRenderer();

// ── tasksSlugForLabel ───────────────────────────────────────────────────────

test('tasksSlugForLabel: "UX Review" derives "ux-review"', () => {
  assert.equal(R.tasksSlugForLabel('UX Review'), 'ux-review');
});

test('tasksSlugForLabel: strips leading/trailing symbols and collapses runs', () => {
  assert.equal(R.tasksSlugForLabel('  Ready!!  For   QA  '), 'ready-for-qa');
});

test('tasksSlugForLabel: a symbols-only label yields the empty slug', () => {
  assert.equal(R.tasksSlugForLabel('!!!'), '');
  assert.equal(R.tasksSlugForLabel('   '), '');
});

test('tasksSlugForLabel: null / undefined are tolerated (→ "")', () => {
  assert.equal(R.tasksSlugForLabel(null), '');
  assert.equal(R.tasksSlugForLabel(undefined), '');
});

test('tasksSlugForLabel: clamps to MAX_SLUG_LENGTH with no trailing dash', () => {
  const long = 'a'.repeat(40);
  const slug = R.tasksSlugForLabel(long);
  assert.equal(slug.length, R.TASKS_MAX_SLUG_LENGTH);
  assert.equal(slug, 'a'.repeat(R.TASKS_MAX_SLUG_LENGTH));
  // A label that would clamp mid-dash must not end on a dash.
  const clamped = R.tasksSlugForLabel('x'.repeat(29) + ' y z');
  assert.ok(!clamped.endsWith('-'), 'no trailing dash after clamp');
});

// ── tasksValidateNewColumn ──────────────────────────────────────────────────

test('tasksValidateNewColumn: accepts a fresh valid label', () => {
  const res = R.tasksValidateNewColumn('UX Review', new Set(['todo', 'testing', 'done']));
  assert.deepEqual(res, { ok: true, slug: 'ux-review', error: null });
});

test('tasksValidateNewColumn: rejects a blank label', () => {
  const res = R.tasksValidateNewColumn('   ', new Set());
  assert.equal(res.ok, false);
  assert.match(res.error, /Label is required/);
});

test('tasksValidateNewColumn: rejects a label that derives to an empty slug', () => {
  const res = R.tasksValidateNewColumn('!!!', new Set());
  assert.equal(res.ok, false);
  assert.match(res.error, /Slug is required/);
});

test('tasksValidateNewColumn: rejects reserved slugs (testing / todo / failed-testing / unknown)', () => {
  for (const [label, slug] of [
    ['Testing', 'testing'],
    ['Todo', 'todo'],
    ['Failed Testing', 'failed-testing'],
    ['Unknown', 'unknown'],
  ]) {
    const res = R.tasksValidateNewColumn(label, new Set());
    assert.equal(res.ok, false, `${label} rejected`);
    assert.equal(res.slug, slug);
    assert.match(res.error, /reserved/i);
  }
});

test('tasksValidateNewColumn: the reserved set carries every protected slug incl. __wont-do__', () => {
  // TASK-206: post-processing was removed from the valid-statuses enum entirely,
  // so it is no longer a reserved slug (a user column named "post-processing" is
  // no longer structurally blocked purely by reservation — see the ticket's
  // legacy-migration guard in lib/team-config.js for the drop-on-normalize path).
  for (const slug of ['todo', 'defining', 'in-progress', 'testing',
    'done', 'failed-testing', 'unknown', '__wont-do__']) {
    assert.ok(R.TASKS_RESERVED_SLUGS.has(slug), `reserved set has ${slug}`);
  }
  assert.ok(!R.TASKS_RESERVED_SLUGS.has('post-processing'), 'post-processing is no longer reserved');
});

test('tasksValidateNewColumn: rejects a slug that duplicates an existing column', () => {
  const res = R.tasksValidateNewColumn('UX Review', new Set(['todo', 'ux-review', 'done']));
  assert.equal(res.ok, false);
  assert.equal(res.slug, 'ux-review');
  assert.match(res.error, /already exists/);
});

test('tasksValidateNewColumn: accepts an array of existing slugs (not only a Set)', () => {
  const res = R.tasksValidateNewColumn('UX Review', ['todo', 'done']);
  assert.equal(res.ok, true);
});

// The over-long / non-slug branches the renderer mirror keeps for parity are
// structurally unreachable from label-derivation (tasksSlugForLabel clamps to 30
// and strips to [a-z0-9-]); they are covered here against the authoritative
// validator this function mirrors — lib/team-config.js validateNewColumn.
test('lib validateNewColumn (mirrored authority): rejects an over-long slug', () => {
  const res = teamConfig.validateNewColumn('X', 'a'.repeat(teamConfig.MAX_SLUG_LENGTH + 1), null);
  assert.equal(res.ok, false);
  assert.match(res.error, /characters or fewer/);
});

test('lib validateNewColumn (mirrored authority): rejects a non-slug slug', () => {
  const res = teamConfig.validateNewColumn('X', 'Not A Slug', null);
  assert.equal(res.ok, false);
  assert.match(res.error, /lowercase letters, numbers, and dashes/);
});

// ── canSwapTeamColumns ──────────────────────────────────────────────────────

function stateOf(flags) {
  return { columns: flags.map((system, i) => ({ status: 's' + i, system })) };
}

test('canSwapTeamColumns: a user column may swap with an adjacent system column', () => {
  const s = stateOf([true, false, true]); // system, user, system
  assert.equal(R.canSwapTeamColumns(s, 0, 1), true, 'system↔user allowed');
  assert.equal(R.canSwapTeamColumns(s, 1, 2), true, 'user↔system allowed');
});

test('canSwapTeamColumns: two system columns may NEVER swap (relative order fixed)', () => {
  const s = stateOf([true, false, true]);
  assert.equal(R.canSwapTeamColumns(s, 0, 2), false, 'system↔system forbidden');
  const allSystem = stateOf([true, true, true, true, true, true]);
  for (let i = 0; i < 5; i++) {
    assert.equal(R.canSwapTeamColumns(allSystem, i, i + 1), false,
      'adjacent system↔system forbidden — todo can never move past done');
  }
});

test('canSwapTeamColumns: two user columns may swap freely', () => {
  const s = stateOf([false, false]);
  assert.equal(R.canSwapTeamColumns(s, 0, 1), true);
});

test('canSwapTeamColumns: out-of-range and self indices are rejected', () => {
  const s = stateOf([true, false, true]);
  assert.equal(R.canSwapTeamColumns(s, 0, -1), false);
  assert.equal(R.canSwapTeamColumns(s, 2, 3), false);
  assert.equal(R.canSwapTeamColumns(s, 1, 1), false);
});

// ── countTeamTicketsForStatus ───────────────────────────────────────────────

function tabWithTickets(statuses) {
  const tickets = new Map();
  statuses.forEach((st, i) => tickets.set('T-' + i + '.md', { fm: { status: st } }));
  return { tasks: { tickets } };
}

test('countTeamTicketsForStatus: counts only tickets holding the given status', () => {
  const tab = tabWithTickets(['ux-review', 'ux-review', 'todo', 'done', 'ux-review']);
  assert.equal(R.countTeamTicketsForStatus(tab, 'ux-review'), 3);
  assert.equal(R.countTeamTicketsForStatus(tab, 'todo'), 1);
  assert.equal(R.countTeamTicketsForStatus(tab, 'nope'), 0);
});

test('countTeamTicketsForStatus: tolerates a missing tickets map (→ 0)', () => {
  assert.equal(R.countTeamTicketsForStatus({}, 'ux-review'), 0);
  assert.equal(R.countTeamTicketsForStatus({ tasks: {} }, 'ux-review'), 0);
  assert.equal(R.countTeamTicketsForStatus(null, 'ux-review'), 0);
});

// ── tasksSerializeTeamConfig ────────────────────────────────────────────────

function workingModel() {
  return {
    version: 1,
    skill: { concurrencyDefault: 3 },
    columns: [
      { status: 'todo', label: 'To Do', description: '', agent: null, system: true },
      { status: 'defining', label: 'Defining', description: '', agent: null, system: true },
      { status: 'in-progress', label: 'In Progress', description: '', agent: null, system: true },
      { status: 'testing', label: 'Testing', description: '', agent: null, system: true },
      { status: 'ux-review', label: 'UX Review', description: 'human check', agent: 'ba', system: false },
      { status: 'post-processing', label: 'Post-processing', description: '', agent: null, system: true },
      { status: 'done', label: 'Done', description: '', agent: null, system: true },
      // Invalid user entries that MUST be dropped by the normalize gate:
      { status: 'TESTING', label: 'upper-case bad', description: '', agent: null, system: false },
      { status: 'testing', label: 'reserved dup', description: '', agent: null, system: false },
      { status: 'has space', label: 'non-slug', description: '', agent: null, system: false },
    ],
  };
}

test('tasksSerializeTeamConfig: emits valid JSON ending in a trailing newline', () => {
  const out = R.tasksSerializeTeamConfig(workingModel());
  assert.ok(out.endsWith('\n'), 'trailing newline');
  const parsed = JSON.parse(out); // must not throw
  assert.equal(typeof parsed, 'object');
});

test('tasksSerializeTeamConfig: drops invalid/reserved/duplicate user columns and keeps canonical order', () => {
  const parsed = JSON.parse(R.tasksSerializeTeamConfig(workingModel()));
  const statuses = parsed.columns.map((c) => c.status);
  assert.deepEqual(statuses, [
    'todo', 'defining', 'in-progress', 'testing', 'ux-review', 'done',
  ], 'the one valid user column survives after Testing; every invalid one is dropped, ' +
    'including the legacy post-processing lane');
  const ux = parsed.columns.find((c) => c.status === 'ux-review');
  assert.equal(ux.system, false);
  assert.equal(ux.label, 'UX Review');
  assert.equal(ux.agent, 'ba');
});

test('tasksSerializeTeamConfig: re-injects missing system columns (never fewer than the five)', () => {
  const sparse = { version: 1, skill: {}, columns: [
    { status: 'todo', system: true },
    { status: 'ux-review', label: 'UX Review', system: false },
  ] };
  const parsed = JSON.parse(R.tasksSerializeTeamConfig(sparse));
  const systemSlugs = parsed.columns.filter((c) => c.system).map((c) => c.status);
  assert.deepEqual(systemSlugs, ['todo', 'defining', 'in-progress', 'testing', 'done']);
});

// FIXED (TASK-206): workingModel() includes a legacy `post-processing` column
// with `system: true` (representing an old in-memory/on-disk model from before
// this ticket). lib/team-config.js's normalizeConfig DROPS a legacy
// post-processing column per the ticket's "Legacy-config migration" decision,
// and renderer/renderer.js's normalizeTasksColumns (which tasksSerializeTeamConfig
// calls) now carries the matching legacy-drop, so it is dropped there too instead
// of being resurrected as a demoted user column. This assertion stays strict —
// lib and renderer must agree that no "Post-processing" user lane reappears.
test('tasksSerializeTeamConfig: round-trips through lib/team-config.js normalizeConfig (the authority)', () => {
  const out = R.tasksSerializeTeamConfig(workingModel());
  const parsed = JSON.parse(out);
  const libNorm = teamConfig.normalizeConfig(parsed);
  const libStatuses = libNorm.columns.map((c) => c.status);
  const rendererStatuses = parsed.columns.map((c) => c.status);
  assert.deepEqual(rendererStatuses, libStatuses,
    'renderer serialization and lib normalization agree on column identity + order');
  // The lib authority must accept the renderer output without further repair to
  // the column set (no dropped/re-injected columns → no such warnings).
  const structuralWarnings = (libNorm.warnings || []).filter((w) => /column/i.test(w));
  assert.deepEqual(structuralWarnings, [], 'no column repairs needed: ' + JSON.stringify(structuralWarnings));
});

test('tasksSerializeTeamConfig: tolerates junk input and still yields the five system columns', () => {
  for (const junk of [null, undefined, 42, 'nope', { columns: 'not-array' }]) {
    const parsed = JSON.parse(R.tasksSerializeTeamConfig(junk));
    assert.equal(parsed.columns.length, 5);
    assert.deepEqual(parsed.columns.map((c) => c.status),
      ['todo', 'defining', 'in-progress', 'testing', 'done']);
  }
});
