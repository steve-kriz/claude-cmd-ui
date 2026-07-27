'use strict';

// Unit tests for lib/ticket-cost.js (TASK-070) — the Electron-free helper the
// orchestrator uses to keep a per-ACTIVITY cost/accounting LOG on a ticket:
// every time a phase's subagent (ba/code/test/review/post-processing) completes,
// one { activity, model, startedAt, finishedAt, durationMs, tokensIn, tokensOut,
// costUsd } entry is APPENDED to the flat frontmatter field `activities` (a
// one-line JSON array). The module is pure (no disk/network/Electron and NO DB
// calls), so it is exercised directly with plain `node --test`. No files are
// written and no DB/network calls are made by these tests.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  appendActivity,
  parseActivities,
  serializeActivities,
  totalActivities,
  computeDurationMs,
  ACTIVITIES_KEY,
  KNOWN_ACTIVITIES,
} = require('../lib/ticket-cost');

const { isValidAmount } = require('../lib/ticket-accounting');

// ---------------------------------------------------------------------------
// Exports & constants
// ---------------------------------------------------------------------------

test('exports the documented surface', () => {
  assert.equal(typeof appendActivity, 'function');
  assert.equal(typeof parseActivities, 'function');
  assert.equal(typeof serializeActivities, 'function');
  assert.equal(typeof totalActivities, 'function');
  assert.equal(typeof computeDurationMs, 'function');
  assert.equal(ACTIVITIES_KEY, 'activities');
  assert.deepEqual(KNOWN_ACTIVITIES, ['ba', 'code', 'test', 'review', 'post-processing']);
});

// ---------------------------------------------------------------------------
// computeDurationMs — wall-clock ms; null on bad/reversed pair
// ---------------------------------------------------------------------------

test('computeDurationMs: milliseconds between two valid ISO stamps', () => {
  assert.equal(
    computeDurationMs('2026-07-19T10:00:00.000Z', '2026-07-19T10:04:30.000Z'),
    270000,
  );
  assert.equal(
    computeDurationMs('2026-07-19T10:00:00.000Z', '2026-07-19T10:00:00.000Z'),
    0,
    'zero-length span is a valid 0 ms, not null',
  );
});

test('computeDurationMs: null when missing/invalid or end precedes start (reversed pair)', () => {
  assert.equal(computeDurationMs(null, '2026-07-19T10:00:00.000Z'), null, 'missing start');
  assert.equal(computeDurationMs('2026-07-19T10:00:00.000Z', null), null, 'missing end');
  assert.equal(computeDurationMs('', '2026-07-19T10:00:00.000Z'), null, 'empty start');
  assert.equal(computeDurationMs('not-a-date', '2026-07-19T10:00:00.000Z'), null, 'invalid start');
  assert.equal(computeDurationMs('2026-07-19T10:00:00.000Z', 'not-a-date'), null, 'invalid end');
  assert.equal(
    computeDurationMs('2026-07-19T10:04:30.000Z', '2026-07-19T10:00:00.000Z'),
    null,
    'reversed: end before start',
  );
});

// ---------------------------------------------------------------------------
// isValidAmount(0) — distinguishes "recorded 0" from "absent"
// ---------------------------------------------------------------------------

test('isValidAmount(0) is true — 0 is a KEPT amount distinct from absent', () => {
  assert.equal(isValidAmount(0), true);
  const out = appendActivity({ id: 'T' }, {
    activity: 'code',
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
  });
  const e = parseActivities(out)[0];
  assert.strictEqual(e.tokensIn, 0, 'recorded 0 kept');
  assert.strictEqual(e.tokensOut, 0);
  assert.strictEqual(e.costUsd, 0);
  assert.ok('tokensIn' in e && 'tokensOut' in e && 'costUsd' in e, '0 present, not absent');
});

// ---------------------------------------------------------------------------
// appendActivity — required activity, model, timings, durationMs
// ---------------------------------------------------------------------------

test('appendActivity records activity, model, ISO timings and computes durationMs', () => {
  const out = appendActivity({ id: 'T', title: 't', status: 'in-progress' }, {
    activity: 'ba',
    model: 'claude-fable-5',
    startedAt: '2026-07-19T10:00:00Z',
    finishedAt: '2026-07-19T10:04:30Z',
    tokensIn: 12000,
    tokensOut: 3500,
  });
  const e = parseActivities(out)[0];
  assert.equal(e.activity, 'ba');
  assert.equal(e.model, 'claude-fable-5');
  assert.match(e.startedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'startedAt normalised to ISO');
  assert.match(e.finishedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'finishedAt normalised to ISO');
  assert.equal(e.durationMs, 270000, 'durationMs computed from the pair');
  assert.equal(e.tokensIn, 12000);
  assert.equal(e.tokensOut, 3500);
});

test('appendActivity: durationMs is absent on a reversed/invalid startedAt/finishedAt pair', () => {
  // reversed
  let e = parseActivities(appendActivity({ id: 'T' }, {
    activity: 'code',
    startedAt: '2026-07-19T10:04:30Z',
    finishedAt: '2026-07-19T10:00:00Z',
  }))[0];
  assert.ok(!('durationMs' in e), 'no durationMs when end precedes start');
  // only start
  e = parseActivities(appendActivity({ id: 'T' }, { activity: 'code', startedAt: '2026-07-19T10:00:00Z' }))[0];
  assert.ok(!('durationMs' in e), 'no durationMs without an end');
  // invalid end
  e = parseActivities(appendActivity({ id: 'T' }, {
    activity: 'code',
    startedAt: '2026-07-19T10:00:00Z',
    finishedAt: 'not-a-date',
  }))[0];
  assert.ok(!('durationMs' in e), 'no durationMs with an invalid end');
});

test('appendActivity: explicit durationMs is honored over the computed pair', () => {
  const out = appendActivity({ id: 'T' }, {
    activity: 'test',
    startedAt: '2026-07-19T10:00:00Z',
    finishedAt: '2026-07-19T10:10:00Z', // would compute 600000
    durationMs: 42,
  });
  assert.equal(parseActivities(out)[0].durationMs, 42, 'explicit durationMs wins');
});

test('appendActivity: model omitted when blank/absent', () => {
  let e = parseActivities(appendActivity({ id: 'T' }, { activity: 'code', model: '   ' }))[0];
  assert.ok(!('model' in e), 'blank model dropped');
  e = parseActivities(appendActivity({ id: 'T' }, { activity: 'code' }))[0];
  assert.ok(!('model' in e), 'absent model dropped');
});

// ---------------------------------------------------------------------------
// appendActivity — token/cost validity gate (never fabricated)
// ---------------------------------------------------------------------------

test('appendActivity: tokensIn/tokensOut/costUsd written only when isValidAmount', () => {
  const out = appendActivity({ id: 'T' }, {
    activity: 'code', tokensIn: 900, tokensOut: '250', costUsd: '1.25',
  });
  const e = parseActivities(out)[0];
  assert.strictEqual(e.tokensIn, 900);
  assert.strictEqual(e.tokensOut, 250, 'numeric string coerced');
  assert.strictEqual(e.costUsd, 1.25);
});

test('appendActivity: NaN/negative/empty token & cost values leave the field absent (never fabricated)', () => {
  const junk = [NaN, Infinity, -Infinity, -1, -0.01, null, undefined, '', 'abc', '1x', {}];
  for (const v of junk) {
    const e = parseActivities(appendActivity({ id: 'T' }, {
      activity: 'code', tokensIn: v, tokensOut: v, costUsd: v,
    }))[0];
    assert.ok(!('tokensIn' in e), `tokensIn absent for ${JSON.stringify(v)}`);
    assert.ok(!('tokensOut' in e), `tokensOut absent for ${JSON.stringify(v)}`);
    assert.ok(!('costUsd' in e), `costUsd absent for ${JSON.stringify(v)}`);
    assert.equal(e.activity, 'code', 'entry still recorded despite invalid amounts');
  }
});

// ---------------------------------------------------------------------------
// appendActivity — rejects entries without an activity name
// ---------------------------------------------------------------------------

test('appendActivity: entry without a non-empty activity is rejected (log unchanged)', () => {
  for (const bad of [undefined, null, '', '   ', {}]) {
    const opts = bad && typeof bad === 'object' ? bad : { activity: bad };
    const fm = { id: 'T', title: 't', status: 'in-progress' };
    const out = appendActivity(fm, opts);
    assert.deepEqual(parseActivities(out), [], `nothing appended for ${JSON.stringify(bad)}`);
  }
});

test('appendActivity: rejecting a nameless entry preserves an existing log verbatim', () => {
  const seeded = appendActivity({ id: 'T', title: 't', status: 's' }, { activity: 'ba' });
  const before = seeded[ACTIVITIES_KEY];
  const after = appendActivity(seeded, { activity: '   ' });
  assert.equal(after[ACTIVITIES_KEY], before, 'activities log unchanged when entry rejected');
  assert.equal(parseActivities(after).length, 1);
});

// ---------------------------------------------------------------------------
// appendActivity — order preservation, no mutation, key ordering
// ---------------------------------------------------------------------------

test('appendActivity: preserves existing entries in order and appends last', () => {
  let fm = { id: 'TASK-070', title: 'ticket cost', status: 'in-progress' };
  fm = appendActivity(fm, { activity: 'ba' });
  fm = appendActivity(fm, { activity: 'code' });
  fm = appendActivity(fm, { activity: 'test' });
  fm = appendActivity(fm, { activity: 'review' });
  assert.deepEqual(parseActivities(fm).map((e) => e.activity), ['ba', 'code', 'test', 'review']);
});

test('appendActivity: does not mutate its input and returns a new object', () => {
  const fm = { id: 'T', title: 't', status: 'in-progress' };
  const snapshot = JSON.stringify(fm);
  const out = appendActivity(fm, { activity: 'ba', model: 'm' });
  assert.notEqual(out, fm, 'a new object is returned');
  assert.equal(JSON.stringify(fm), snapshot, 'input untouched');
  assert.ok(!(ACTIVITIES_KEY in fm), 'input never gains an activities field');
});

test('appendActivity: leading keys ordered id,title,status,created,updated then activities after', () => {
  const fm = {
    updated: '2026-07-19', id: 'TASK-070', status: 'in-progress',
    created: '2026-07-10', title: 'ticket cost',
  };
  const out = appendActivity(fm, { activity: 'ba' });
  const keys = Object.keys(out);
  assert.deepEqual(keys.slice(0, 5), ['id', 'title', 'status', 'created', 'updated']);
  assert.ok(keys.includes(ACTIVITIES_KEY), 'activities present');
  assert.ok(keys.indexOf(ACTIVITIES_KEY) >= 5, 'activities comes after the leading keys');
});

test('appendActivity: duplicate activity types are legitimate (log, not a map)', () => {
  let fm = { id: 'T' };
  fm = appendActivity(fm, { activity: 'code', tokensIn: 100 });
  fm = appendActivity(fm, { activity: 'code', tokensIn: 200 }); // fix-loop re-run
  const entries = parseActivities(fm);
  assert.equal(entries.length, 2, 'both code entries kept');
  assert.equal(entries[0].tokensIn, 100);
  assert.equal(entries[1].tokensIn, 200);
});

test('appendActivity: unknown activity strings are stored as-is (open-ended list)', () => {
  const e = parseActivities(appendActivity({ id: 'T' }, { activity: 'benchmarking' }))[0];
  assert.equal(e.activity, 'benchmarking');
});

test('appendActivity: legacy tokens/costUsd/runs keys are left untouched (additive)', () => {
  const fm = {
    id: 'T', title: 't', status: 'done',
    tokens: 12345, costUsd: 0.42, runs: '[{"minutes":3}]',
  };
  const out = appendActivity(fm, { activity: 'post-processing' });
  assert.equal(out.tokens, 12345);
  assert.equal(out.costUsd, 0.42);
  assert.equal(out.runs, '[{"minutes":3}]');
  assert.equal(parseActivities(out).length, 1);
});

// ---------------------------------------------------------------------------
// serializeActivities — single-line JSON
// ---------------------------------------------------------------------------

test('serializeActivities: single-line JSON array; empty/non-array => "[]"', () => {
  assert.equal(serializeActivities([]), '[]');
  assert.equal(serializeActivities(null), '[]');
  assert.equal(serializeActivities(undefined), '[]');
  assert.equal(serializeActivities('nonsense'), '[]');
  const s = serializeActivities([{ activity: 'ba', durationMs: 1 }]);
  assert.ok(!s.includes('\n'), 'no newline');
  assert.ok(!s.includes('\r'), 'no carriage return');
  assert.deepEqual(JSON.parse(s), [{ activity: 'ba', durationMs: 1 }]);
});

test('appendActivity: the activities value is a SINGLE-LINE JSON array (no newlines)', () => {
  let fm = { id: 'T', title: 't', status: 'in-progress' };
  fm = appendActivity(fm, { activity: 'ba', startedAt: '2026-07-19T10:00:00Z', finishedAt: '2026-07-19T10:05:00Z' });
  fm = appendActivity(fm, { activity: 'code', startedAt: '2026-07-19T11:00:00Z', finishedAt: '2026-07-19T11:20:00Z' });
  const raw = fm[ACTIVITIES_KEY];
  assert.equal(typeof raw, 'string');
  assert.ok(!raw.includes('\n') && !raw.includes('\r'), 'stays on one line');
  assert.equal(JSON.parse(raw).length, 2);
});

// ---------------------------------------------------------------------------
// parseActivities — tolerance
// ---------------------------------------------------------------------------

test('parseActivities: absent / non-string / invalid-JSON / non-array => []', () => {
  assert.deepEqual(parseActivities({ id: 'T' }), [], 'absent field');
  assert.deepEqual(parseActivities({}), [], 'empty fm');
  assert.deepEqual(parseActivities(null), [], 'null fm');
  assert.deepEqual(parseActivities(undefined), [], 'undefined fm');
  assert.deepEqual(parseActivities({ [ACTIVITIES_KEY]: 12345 }), [], 'non-string number field (opaque parse)');
  assert.deepEqual(parseActivities({ [ACTIVITIES_KEY]: '   ' }), [], 'blank string');
  assert.deepEqual(parseActivities({ [ACTIVITIES_KEY]: 'not-json{{{' }), [], 'invalid JSON');
  assert.deepEqual(parseActivities({ [ACTIVITIES_KEY]: '{"a":1}' }), [], 'valid JSON but not an array');
  assert.deepEqual(parseActivities({ [ACTIVITIES_KEY]: '"just a string"' }), [], 'JSON string, not array');
  assert.deepEqual(parseActivities({ [ACTIVITIES_KEY]: '42' }), [], 'JSON number, not array');
});

test('parseActivities: filters out non-object elements inside the array', () => {
  const raw = JSON.stringify([{ activity: 'ba' }, null, 5, 'str', { activity: 'code' }]);
  assert.deepEqual(parseActivities({ [ACTIVITIES_KEY]: raw }), [{ activity: 'ba' }, { activity: 'code' }]);
});

test('parseActivities: does not throw on corrupt "not-json{{{" and returns []', () => {
  assert.doesNotThrow(() => parseActivities({ [ACTIVITIES_KEY]: 'not-json{{{' }));
  assert.deepEqual(parseActivities({ [ACTIVITIES_KEY]: 'not-json{{{' }), []);
});

// ---------------------------------------------------------------------------
// totalActivities — sums only present valid values; null when none carried
// ---------------------------------------------------------------------------

test('totalActivities: sums durationMs/tokensIn/tokensOut/costUsd across entries', () => {
  const activities = [
    { activity: 'ba', durationMs: 270000, tokensIn: 12000, tokensOut: 3500, costUsd: 0.10 },
    { activity: 'code', durationMs: 600000, tokensIn: 20000, tokensOut: 8000, costUsd: 0.20 },
  ];
  const t = totalActivities(activities);
  assert.equal(t.durationMs, 870000);
  assert.equal(t.tokensIn, 32000);
  assert.equal(t.tokensOut, 11500);
  assert.ok(Math.abs(t.costUsd - 0.30) < 1e-9);
});

test('totalActivities: a total is null when NO entry carried that field (never NaN, never fabricated 0)', () => {
  const activities = [
    { activity: 'ba', tokensIn: 10, tokensOut: 5 },
    { activity: 'code', tokensIn: 20, tokensOut: 8 },
    { activity: 'test' }, // carries nothing
  ];
  const t = totalActivities(activities);
  assert.equal(t.tokensIn, 30);
  assert.equal(t.tokensOut, 13);
  assert.equal(t.durationMs, null, 'no entry had durationMs → null, not 0/NaN');
  assert.equal(t.costUsd, null, 'no entry had costUsd → null, not 0/NaN');
  for (const v of Object.values(t)) assert.ok(!Number.isNaN(v), 'no NaN totals');
});

test('totalActivities: counts only the entries that actually carried the field', () => {
  // Only 2 of 3 carry tokens; only 1 carries costUsd.
  const activities = [
    { activity: 'ba', tokensIn: 12000, tokensOut: 3500, costUsd: 0.42 },
    { activity: 'code', tokensIn: 20000, tokensOut: 8000 },
    { activity: 'test' },
  ];
  const t = totalActivities(activities);
  assert.equal(t.tokensIn, 32000, 'covers exactly the two carrying entries');
  assert.equal(t.tokensOut, 11500);
  assert.equal(t.costUsd, 0.42, 'equals the single recorded cost');
  for (const v of Object.values(t)) assert.ok(!Number.isNaN(v), 'no NaN totals');
});

test('totalActivities: non-array / junk input yields all-null totals (no throw)', () => {
  for (const bad of [null, undefined, 'x', 42, {}]) {
    const t = totalActivities(bad);
    assert.deepEqual(t, {
      durationMs: null, tokensIn: null, tokensOut: null,
      cacheReadTokens: null, cacheCreationTokens: null, costUsd: null,
    });
  }
});

test('totalActivities: a recorded 0 counts (distinct from absent)', () => {
  const t = totalActivities([{ activity: 'ba', costUsd: 0 }, { activity: 'code', costUsd: 0 }]);
  assert.strictEqual(t.costUsd, 0, 'summing recorded zeros yields 0, not null');
});

// ---------------------------------------------------------------------------
// TASK-142: cache hits (cacheReadTokens / cacheCreationTokens) persistence
// ---------------------------------------------------------------------------

test('appendActivity persists cacheReadTokens/cacheCreationTokens when isValidAmount', () => {
  const out = appendActivity({ id: 'T' }, {
    activity: 'code',
    cacheReadTokens: 28905,
    cacheCreationTokens: 0,
  });
  const e = parseActivities(out)[0];
  assert.strictEqual(e.cacheReadTokens, 28905, 'cache read tokens persisted');
  assert.strictEqual(e.cacheCreationTokens, 0, 'cache creation tokens (0) persisted as distinct from absent');
  assert.ok('cacheReadTokens' in e && 'cacheCreationTokens' in e);
});

test('appendActivity: cacheReadTokens/cacheCreationTokens follow the same validity gate as tokensIn/tokensOut', () => {
  const junk = [NaN, Infinity, -Infinity, -1, -0.01, null, undefined, '', 'abc', '1x', {}];
  for (const v of junk) {
    const e = parseActivities(appendActivity({ id: 'T' }, {
      activity: 'code', cacheReadTokens: v, cacheCreationTokens: v,
    }))[0];
    assert.ok(!('cacheReadTokens' in e), `cacheReadTokens absent for ${JSON.stringify(v)}`);
    assert.ok(!('cacheCreationTokens' in e), `cacheCreationTokens absent for ${JSON.stringify(v)}`);
  }
});

test('appendActivity: numeric strings for cache hits are coerced to numbers', () => {
  const out = appendActivity({ id: 'T' }, {
    activity: 'code',
    cacheReadTokens: '28905',
    cacheCreationTokens: '100',
  });
  const e = parseActivities(out)[0];
  assert.strictEqual(e.cacheReadTokens, 28905);
  assert.strictEqual(e.cacheCreationTokens, 100);
  assert.equal(typeof e.cacheReadTokens, 'number');
  assert.equal(typeof e.cacheCreationTokens, 'number');
});

test('totalActivities sums cacheReadTokens/cacheCreationTokens across entries', () => {
  const activities = [
    { activity: 'ba', cacheReadTokens: 100, cacheCreationTokens: 10 },
    { activity: 'code', cacheReadTokens: 250, cacheCreationTokens: 20 },
  ];
  const t = totalActivities(activities);
  assert.equal(t.cacheReadTokens, 350, '100 + 250');
  assert.equal(t.cacheCreationTokens, 30, '10 + 20');
});

test('totalActivities: cacheReadTokens/cacheCreationTokens are null when NO entry carried them', () => {
  const activities = [
    { activity: 'ba', tokensIn: 100, tokensOut: 50 },
    { activity: 'code', tokensIn: 200, tokensOut: 75 },
  ];
  const t = totalActivities(activities);
  assert.equal(t.cacheReadTokens, null, 'no entry had cacheReadTokens → null, not 0');
  assert.equal(t.cacheCreationTokens, null, 'no entry had cacheCreationTokens → null, not 0');
  assert.equal(t.tokensIn, 300);
  assert.equal(t.tokensOut, 125);
});

test('totalActivities: only counts entries that actually carried the cache fields', () => {
  const activities = [
    { activity: 'ba', cacheReadTokens: 100, cacheCreationTokens: 10, tokensIn: 1000 },
    { activity: 'code', tokensIn: 2000 }, // no cache fields
    { activity: 'test', cacheReadTokens: 50 }, // only read, no creation
  ];
  const t = totalActivities(activities);
  assert.equal(t.cacheReadTokens, 150, '100 + 50');
  assert.equal(t.cacheCreationTokens, 10, 'only ba carried it');
  assert.equal(t.tokensIn, 3000, 'all three carried tokens');
});

test('appendActivity: activites field round-trips as single-line JSON with no newlines', () => {
  let fm = { id: 'T' };
  fm = appendActivity(fm, { activity: 'ba', startedAt: '2026-07-19T10:00:00Z', finishedAt: '2026-07-19T10:05:00Z', cacheReadTokens: 28905, cacheCreationTokens: 0 });
  fm = appendActivity(fm, { activity: 'code', startedAt: '2026-07-19T11:00:00Z', finishedAt: '2026-07-19T11:20:00Z', cacheReadTokens: 100, cacheCreationTokens: 5 });
  const raw = fm[ACTIVITIES_KEY];
  assert.equal(typeof raw, 'string');
  assert.ok(!raw.includes('\n') && !raw.includes('\r'), 'single-line JSON, no newlines');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].cacheReadTokens, 28905);
  assert.equal(parsed[0].cacheCreationTokens, 0);
  assert.equal(parsed[1].cacheReadTokens, 100);
  assert.equal(parsed[1].cacheCreationTokens, 5);
});

test('appendActivity: single-field accounting (tokensIn/tokensOut/costUsd) and runs log untouched by cache-hits additions', () => {
  const fm = {
    id: 'T', title: 't', status: 'done',
    tokens: 12345, costUsd: 0.42, runs: '[{"minutes":3}]',
  };
  const out = appendActivity(fm, { activity: 'code', cacheReadTokens: 100, cacheCreationTokens: 10 });
  assert.equal(out.tokens, 12345, 'flat tokens untouched');
  assert.equal(out.costUsd, 0.42, 'flat costUsd untouched');
  assert.equal(out.runs, '[{"minutes":3}]', 'runs log untouched');
  const entries = parseActivities(out);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].cacheReadTokens, 100, 'cache hits in activities log');
});
