'use strict';

// ===========================================================================
// TASK-097 — unit tests for lib/team-config.js
//
// Exercises the full public API of the pure, Electron-free team-config model
// directly via require(): defaultConfig, normalizeConfig, validateNewColumn,
// slugForLabel, serializeConfig, and the exported constants. The module never
// touches disk/DB/network/Electron, so these tests do no real I/O — every case
// is a direct pure-function assertion. Filename follows the repo's dominant
// unit-test convention (test/<name>.test.js; e2e lives in <name>.e2e.test.js).
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const teamConfig = require('../lib/team-config.js');
const { LANE_STATUSES, VALID_STATUSES } = require('../lib/ticket-lanes.js');
const {
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
  resolveConcurrency,
} = require('../lib/ticket-queue.js');

const {
  CONFIG_VERSION,
  SYSTEM_SLUGS,
  SYSTEM_LABELS,
  RESERVED_SLUGS,
  MAX_SLUG_LENGTH,
  defaultConfig,
  normalizeConfig,
  validateNewColumn,
  slugForLabel,
  serializeConfig,
} = teamConfig;

// ── Constants ───────────────────────────────────────────────────────────────
test('exports the documented constants with expected values', () => {
  assert.equal(CONFIG_VERSION, 1);
  assert.deepEqual(SYSTEM_SLUGS, LANE_STATUSES.slice(), 'SYSTEM_SLUGS mirror LANE_STATUSES');
  assert.equal(MAX_SLUG_LENGTH, 30);
  // Re-exported from ticket-queue for the renderer mirror.
  assert.equal(teamConfig.DEFAULT_CONCURRENCY, DEFAULT_CONCURRENCY);
  assert.equal(teamConfig.MAX_CONCURRENCY, MAX_CONCURRENCY);
  // SYSTEM_LABELS covers all six slugs.
  for (const s of SYSTEM_SLUGS) {
    assert.equal(typeof SYSTEM_LABELS[s], 'string');
    assert.ok(SYSTEM_LABELS[s].length > 0);
  }
});

test('RESERVED_SLUGS is a Set containing every VALID_STATUS plus unknown and __wont-do__', () => {
  assert.ok(RESERVED_SLUGS instanceof Set);
  for (const s of VALID_STATUSES) assert.ok(RESERVED_SLUGS.has(s), `${s} reserved`);
  assert.ok(RESERVED_SLUGS.has('unknown'));
  assert.ok(RESERVED_SLUGS.has('__wont-do__'));
  assert.ok(RESERVED_SLUGS.has('failed-testing'), 'failed-testing reserved (lane-less status)');
});

// ── defaultConfig ─────────────────────────────────────────────────────────
test('defaultConfig returns six canonical system columns with concurrency default', () => {
  const cfg = defaultConfig();
  assert.equal(cfg.version, CONFIG_VERSION);
  assert.equal(cfg.columns.length, 6);
  assert.deepEqual(cfg.columns.map((c) => c.status), LANE_STATUSES.slice());
  assert.deepEqual(cfg.columns.map((c) => c.label),
    ['To Do', 'Defining', 'In Progress', 'Testing', 'Post-processing', 'Done']);
  for (const c of cfg.columns) {
    assert.equal(c.system, true);
    assert.equal(c.description, '');
    assert.equal(c.agent, null);
  }
  assert.equal(cfg.skill.concurrencyDefault, DEFAULT_CONCURRENCY);
});

test('defaultConfig returns a fresh object each call (no shared mutable state)', () => {
  const a = defaultConfig();
  const b = defaultConfig();
  assert.notEqual(a, b);
  assert.notEqual(a.columns, b.columns);
  a.columns[0].label = 'MUTATED';
  assert.equal(b.columns[0].label, 'To Do', 'mutating one default does not affect another');
});

test('defaultConfig has NO failed-testing column (it stays lane-less)', () => {
  const cfg = defaultConfig();
  assert.ok(!cfg.columns.some((c) => c.status === 'failed-testing'));
});

// ── normalizeConfig: junk / partial ─────────────────────────────────────────
test('normalizeConfig never throws on junk and always returns a complete config', () => {
  const junk = [null, undefined, 42, 'not json', '{bad json', [], true, NaN, () => {}, { columns: 'nope' }];
  const defaultSlugs = LANE_STATUSES.slice();
  for (const j of junk) {
    let cfg;
    assert.doesNotThrow(() => { cfg = normalizeConfig(j); });
    assert.deepEqual(cfg.columns.map((c) => c.status), defaultSlugs,
      `junk ${String(j)} → six system columns`);
    assert.equal(cfg.skill.concurrencyDefault, DEFAULT_CONCURRENCY);
    assert.ok(Array.isArray(cfg.warnings));
  }
});

test('normalizeConfig on a valid string round-trips through JSON.parse', () => {
  const raw = JSON.stringify(defaultConfig());
  const cfg = normalizeConfig(raw);
  assert.deepEqual(cfg.columns.map((c) => c.status), LANE_STATUSES.slice());
});

test('normalizeConfig re-inserts a missing system column in canonical order with a warning', () => {
  const raw = defaultConfig();
  raw.columns = raw.columns.filter((c) => c.status !== 'testing'); // drop testing
  const cfg = normalizeConfig(raw);
  const slugs = cfg.columns.map((c) => c.status);
  assert.deepEqual(slugs, LANE_STATUSES.slice(), 'testing re-inserted in canonical position');
  assert.ok(cfg.warnings.some((w) => /testing/.test(w)), 'warning mentions the re-inserted column');
});

// ── normalizeConfig: user columns & positions ────────────────────────────────
test('normalizeConfig preserves a user column before the first system column', () => {
  const raw = defaultConfig();
  raw.columns.unshift({ status: 'triage', label: 'Triage', system: false });
  const cfg = normalizeConfig(raw);
  assert.equal(cfg.columns[0].status, 'triage', 'user column before todo stays first');
  assert.equal(cfg.columns[0].system, false);
  assert.equal(cfg.columns[1].status, 'todo');
});

test('normalizeConfig demotes a system-flagged non-system slug to a user column', () => {
  const raw = defaultConfig();
  raw.columns.push({ status: 'archive', label: 'Archive', system: true }); // bogus system flag
  const cfg = normalizeConfig(raw);
  const arch = cfg.columns.find((c) => c.status === 'archive');
  assert.ok(arch, 'archive kept');
  assert.equal(arch.system, false, 'archive demoted to system:false');
  assert.ok(cfg.warnings.some((w) => /archive/.test(w) && /demoted/.test(w)));
});

test('normalizeConfig re-injects done and demotes a renamed done→finished column', () => {
  const raw = defaultConfig();
  raw.columns = raw.columns.map((c) => (c.status === 'done'
    ? { status: 'finished', label: 'Finished', system: true }
    : c));
  const cfg = normalizeConfig(raw);
  const bySlug = new Map(cfg.columns.map((c) => [c.status, c]));
  assert.ok(bySlug.has('done') && bySlug.get('done').system === true, 'fresh done restored');
  assert.ok(bySlug.has('finished') && bySlug.get('finished').system === false, 'finished demoted');
  for (const s of SYSTEM_SLUGS) assert.ok(bySlug.has(s), `${s} survives`);
});

// ── normalizeConfig: dedup, reserved, invalid, round-trip ─────────────────────
test('normalizeConfig drops a duplicate user slug (first wins) with a warning', () => {
  const raw = defaultConfig();
  raw.columns.push({ status: 'ux-review', label: 'UX One', system: false });
  raw.columns.push({ status: 'ux-review', label: 'UX Two', system: false });
  const cfg = normalizeConfig(raw);
  const uxs = cfg.columns.filter((c) => c.status === 'ux-review');
  assert.equal(uxs.length, 1, 'only one ux-review survives');
  assert.equal(uxs[0].label, 'UX One', 'first occurrence wins');
  assert.ok(cfg.warnings.some((w) => /duplicate/.test(w)));
});

test('normalizeConfig drops a user column that claims a reserved slug', () => {
  const raw = defaultConfig();
  raw.columns.push({ status: 'failed-testing', label: 'Nope', system: false });
  const cfg = normalizeConfig(raw);
  const count = cfg.columns.filter((c) => c.status === 'failed-testing').length;
  assert.equal(count, 0, 'failed-testing is never added as a user column');
  assert.ok(cfg.warnings.some((w) => /reserved/.test(w)));
});

test('normalizeConfig drops a user column with an invalid slug', () => {
  const raw = defaultConfig();
  raw.columns.push({ status: 'Bad Slug!', label: 'Bad', system: false });
  const cfg = normalizeConfig(raw);
  assert.ok(!cfg.columns.some((c) => c.status === 'Bad Slug!'));
  assert.ok(cfg.warnings.some((w) => /invalid slug/.test(w)));
});

test('normalizeConfig round-trips unknown top-level and unknown column fields', () => {
  const raw = defaultConfig();
  raw.experimentalFlag = { nested: true };
  raw.columns[0].futureField = 'keep me';
  const cfg = normalizeConfig(raw);
  assert.deepEqual(cfg.experimentalFlag, { nested: true }, 'unknown top-level field preserved');
  assert.equal(cfg.columns[0].futureField, 'keep me', 'unknown column field preserved');
});

test('normalizeConfig preserves a newer version integer untouched', () => {
  const cfg = normalizeConfig({ version: 99, columns: [], skill: {} });
  assert.equal(cfg.version, 99, 'a newer schema version round-trips');
});

test('normalizeConfig strips a stray warnings field on the input', () => {
  const raw = defaultConfig();
  raw.warnings = ['stale'];
  const cfg = normalizeConfig(raw);
  assert.ok(!cfg.warnings.includes('stale'), 'input warnings are not carried through');
});

// ── skill.concurrencyDefault clamp ────────────────────────────────────────────
test('normalizeConfig clamps skill.concurrencyDefault via resolveConcurrency', () => {
  for (const [input, expected] of [
    [999, MAX_CONCURRENCY],
    [0, 1],
    [-5, 1],
    ['abc', DEFAULT_CONCURRENCY],
    [null, DEFAULT_CONCURRENCY],
    [4, 4],
  ]) {
    const cfg = normalizeConfig({ version: 1, columns: [], skill: { concurrencyDefault: input } });
    assert.equal(cfg.skill.concurrencyDefault, resolveConcurrency(input),
      `input ${JSON.stringify(input)} matches resolveConcurrency`);
    assert.equal(cfg.skill.concurrencyDefault, expected);
  }
});

test('normalizeConfig warns when concurrencyDefault is normalized to a different value', () => {
  const cfg = normalizeConfig({ version: 1, columns: [], skill: { concurrencyDefault: 999 } });
  assert.ok(cfg.warnings.some((w) => /concurrencyDefault/.test(w)));
});

test('normalizeConfig round-trips unknown skill fields', () => {
  const cfg = normalizeConfig({ version: 1, columns: [], skill: { concurrencyDefault: 3, extra: 'x' } });
  assert.equal(cfg.skill.extra, 'x');
});

// ── slugForLabel ──────────────────────────────────────────────────────────
test('slugForLabel derives a clean slug from free text', () => {
  assert.equal(slugForLabel('UX Review'), 'ux-review');
  assert.equal(slugForLabel('  Needs   QA!! '), 'needs-qa');
  assert.equal(slugForLabel('Design & Copy'), 'design-copy');
  assert.equal(slugForLabel('---leading and trailing---'), 'leading-and-trailing');
  assert.equal(slugForLabel(''), '');
  assert.equal(slugForLabel(null), '');
  assert.equal(slugForLabel(undefined), '');
});

test('slugForLabel clamps to MAX_SLUG_LENGTH with no trailing dash', () => {
  const long = 'a'.repeat(40);
  const slug = slugForLabel(long);
  assert.ok(slug.length <= MAX_SLUG_LENGTH);
  assert.ok(!slug.endsWith('-'));
});

// ── validateNewColumn ─────────────────────────────────────────────────────
test('validateNewColumn accepts a fresh valid user column and derives the slug from the label', () => {
  const cfg = defaultConfig();
  const res = validateNewColumn('UX Review', '', cfg);
  assert.equal(res.ok, true);
  assert.equal(res.slug, 'ux-review');
  assert.equal(res.error, null);
});

test('validateNewColumn honours an explicit valid slug', () => {
  const cfg = defaultConfig();
  const res = validateNewColumn('Anything', 'my-lane', cfg);
  assert.equal(res.ok, true);
  assert.equal(res.slug, 'my-lane');
});

test('validateNewColumn rejects a blank label', () => {
  const cfg = defaultConfig();
  for (const label of ['', '   ', null, undefined]) {
    const res = validateNewColumn(label, 'ok-slug', cfg);
    assert.equal(res.ok, false, `blank label ${JSON.stringify(label)} rejected`);
    assert.ok(res.error);
  }
});

test('validateNewColumn rejects reserved slugs (VALID_STATUSES, unknown, __wont-do__)', () => {
  const cfg = defaultConfig();
  for (const slug of ['todo', 'failed-testing', 'in-progress', 'done', 'unknown', '__wont-do__']) {
    const res = validateNewColumn('Some Label', slug, cfg);
    assert.equal(res.ok, false, `reserved slug ${slug} rejected`);
    assert.ok(res.error);
  }
});

test('validateNewColumn rejects non-slug characters', () => {
  const cfg = defaultConfig();
  for (const slug of ['Bad Slug', 'has_underscore', 'UPPER', 'em!', 'space here']) {
    const res = validateNewColumn('Label', slug, cfg);
    assert.equal(res.ok, false, `invalid slug ${slug} rejected`);
    assert.ok(res.error);
  }
});

test('validateNewColumn rejects a slug longer than MAX_SLUG_LENGTH', () => {
  const cfg = defaultConfig();
  const res = validateNewColumn('Label', 'a'.repeat(MAX_SLUG_LENGTH + 1), cfg);
  assert.equal(res.ok, false);
  assert.ok(/30/.test(res.error) || /fewer/.test(res.error));
});

test('validateNewColumn rejects a slug that collides with an existing user column', () => {
  const cfg = defaultConfig();
  cfg.columns.push({ status: 'ux-review', label: 'UX Review', system: false });
  const res = validateNewColumn('UX Review Again', 'ux-review', cfg);
  assert.equal(res.ok, false);
  assert.ok(/exists/.test(res.error));
});

test('validateNewColumn rejects a label that produces an empty slug', () => {
  const cfg = defaultConfig();
  const res = validateNewColumn('!!!', '', cfg);
  assert.equal(res.ok, false);
  assert.ok(res.error);
});

test('validateNewColumn never throws on junk config', () => {
  for (const junk of [null, undefined, 42, 'x', []]) {
    assert.doesNotThrow(() => validateNewColumn('Fresh Label', 'fresh-lane', junk));
  }
});

// ── serializeConfig ─────────────────────────────────────────────────────────
test('serializeConfig produces normalized JSON with a trailing newline and no warnings', () => {
  const raw = defaultConfig();
  raw.columns = raw.columns.filter((c) => c.status !== 'done'); // will be repaired
  const out = serializeConfig(raw);
  assert.ok(out.endsWith('\n'), 'ends with a trailing newline');
  const parsed = JSON.parse(out);
  assert.ok(!('warnings' in parsed), 'transient warnings stripped');
  assert.deepEqual(parsed.columns.map((c) => c.status), LANE_STATUSES.slice(),
    'serialized config is normalized (done repaired)');
});

test('serializeConfig is stable (round-trips through itself)', () => {
  const once = serializeConfig(defaultConfig());
  const twice = serializeConfig(JSON.parse(once));
  assert.equal(once, twice, 'serialization is idempotent');
});

test('serializeConfig never throws on junk', () => {
  for (const junk of [null, 42, 'x', []]) {
    assert.doesNotThrow(() => serializeConfig(junk));
  }
});

// ── agent metadata normalization ─────────────────────────────────────────────
test('normalizeConfig trims a string agent and nulls a non-string agent', () => {
  const raw = defaultConfig();
  raw.columns.push({ status: 'lane-a', label: 'A', agent: '  bot  ', system: false });
  raw.columns.push({ status: 'lane-b', label: 'B', agent: 123, system: false });
  const cfg = normalizeConfig(raw);
  const a = cfg.columns.find((c) => c.status === 'lane-a');
  const b = cfg.columns.find((c) => c.status === 'lane-b');
  assert.equal(a.agent, 'bot', 'string agent trimmed');
  assert.equal(b.agent, null, 'non-string agent nulled');
});
