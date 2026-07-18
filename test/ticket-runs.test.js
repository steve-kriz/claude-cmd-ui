'use strict';

// Unit + scenario tests for lib/ticket-runs.js (TASK-012) — the Electron-free
// helper the orchestrator uses to keep a durable per-ticket RUN LOG: every time a
// ticket is built/processed one { at, startedAt, finishedAt, minutes, costUsd }
// entry is APPENDED to the flat frontmatter field `runs` (a one-line JSON array).
// Re-running a ticket accumulates a new entry rather than overwriting. The module
// is pure (no disk/network/Electron), so it is exercised directly with plain
// `node --test`. No files are written and no DB/network calls are made by these
// tests.
//
// The round-trip / ordering contract lives in renderer/renderer.js's
// serializeTicket + parseTicketFrontmatter. That file is a browser script and is
// NOT requireable, so the round-trip block below reuses the REAL ordering rule two
// ways, mirroring test/ticket-accounting.test.js:
//   1. copies serializeTicket/parseTicketFrontmatter VERBATIM from renderer.js,
//      and
//   2. cross-checks that lib/ticket-runs.js (via ticket-accounting.orderFm)
//      produces the SAME leading-key order, so the pure helper the orchestrator
//      actually calls is proven to agree with the serializer.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  appendRun,
  parseRuns,
  serializeRuns,
  computeMinutes,
  RUNS_KEY,
} = require('../lib/ticket-runs');

// ---------------------------------------------------------------------------
// Real serializer/parser, copied verbatim from renderer/renderer.js (~5034 /
// ~5058). renderer.js is a browser script and cannot be required, so the
// round-trip contract is exercised against these faithful copies. If the real
// functions change, these must be updated in lockstep. (Kept identical to the
// copies in test/ticket-accounting.test.js.)
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Exports & constants
// ---------------------------------------------------------------------------

test('exports the documented surface', () => {
  assert.equal(typeof appendRun, 'function');
  assert.equal(typeof parseRuns, 'function');
  assert.equal(typeof serializeRuns, 'function');
  assert.equal(typeof computeMinutes, 'function');
  assert.equal(RUNS_KEY, 'runs');
});

// ---------------------------------------------------------------------------
// appendRun — APPENDS and accumulates (the core "run log" requirement)
// ---------------------------------------------------------------------------

test('appendRun accumulates: two calls yield two entries in chronological order', () => {
  // Given a fresh ticket with no run log
  const fm0 = { id: 'TASK-012', title: 'ticket processing', status: 'in-progress' };
  // When a first run is recorded
  const fm1 = appendRun(fm0, {
    startedAt: '2026-07-18T01:00:00.000Z',
    finishedAt: '2026-07-18T01:10:00.000Z',
    costUsd: 0.5,
  });
  // And later a second (re-run) is recorded on the returned fm
  const fm2 = appendRun(fm1, {
    startedAt: '2026-07-18T02:00:00.000Z',
    finishedAt: '2026-07-18T02:05:00.000Z',
    costUsd: 0.25,
  });
  // Then both entries are present, in order, and the first was not overwritten
  const runs = parseRuns(fm2);
  assert.equal(runs.length, 2, 're-run appends a second entry');
  assert.equal(runs[0].startedAt, '2026-07-18T01:00:00.000Z');
  assert.equal(runs[0].minutes, 10);
  assert.equal(runs[0].costUsd, 0.5);
  assert.equal(runs[1].startedAt, '2026-07-18T02:00:00.000Z');
  assert.equal(runs[1].minutes, 5);
  assert.equal(runs[1].costUsd, 0.25);
});

test('appendRun preserves pre-existing runs entries (does not overwrite the log)', () => {
  const existing = [{ at: '2026-01-01T00:00:00.000Z', minutes: 3, costUsd: 0.1 }];
  const fm = {
    id: 'T', title: 't', status: 'done',
    [RUNS_KEY]: JSON.stringify(existing),
  };
  const out = appendRun(fm, {
    startedAt: '2026-07-18T01:00:00.000Z',
    finishedAt: '2026-07-18T01:02:00.000Z',
  });
  const runs = parseRuns(out);
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[0], existing[0], 'existing entry preserved verbatim');
  assert.equal(runs[1].minutes, 2, 'new entry appended last');
});

test('appendRun does not mutate its input fm', () => {
  const fm = { id: 'T', title: 't', status: 'in-progress' };
  const snapshot = JSON.stringify(fm);
  const out = appendRun(fm, {
    startedAt: '2026-07-18T01:00:00.000Z',
    finishedAt: '2026-07-18T01:05:00.000Z',
  });
  assert.notEqual(out, fm, 'a new object is returned');
  assert.equal(JSON.stringify(fm), snapshot, 'input untouched');
  assert.ok(!(RUNS_KEY in fm), 'input never gains a runs field');
});

test('appendRun accumulates across many re-runs (run log grows monotonically)', () => {
  let fm = { id: 'T', title: 't', status: 'in-progress' };
  for (let i = 0; i < 5; i++) {
    fm = appendRun(fm, {
      startedAt: `2026-07-18T0${i}:00:00.000Z`,
      finishedAt: `2026-07-18T0${i}:01:00.000Z`,
    });
  }
  assert.equal(parseRuns(fm).length, 5);
});

// ---------------------------------------------------------------------------
// computeMinutes / minutes field
// ---------------------------------------------------------------------------

test('computeMinutes: wall-clock minutes rounded to two decimals', () => {
  assert.equal(computeMinutes('2026-07-18T00:00:00.000Z', '2026-07-18T00:10:00.000Z'), 10);
  assert.equal(computeMinutes('2026-07-18T00:00:00.000Z', '2026-07-18T00:00:30.000Z'), 0.5);
  assert.equal(computeMinutes('2026-07-18T00:00:00.000Z', '2026-07-18T00:00:00.000Z'), 0);
  // 1m 20s = 1.333... -> 1.33
  assert.equal(computeMinutes('2026-07-18T00:00:00.000Z', '2026-07-18T00:01:20.000Z'), 1.33);
});

test('computeMinutes: null when a stamp is missing/invalid or end precedes start', () => {
  assert.equal(computeMinutes(null, '2026-07-18T00:10:00.000Z'), null, 'missing start');
  assert.equal(computeMinutes('2026-07-18T00:00:00.000Z', null), null, 'missing end');
  assert.equal(computeMinutes('', '2026-07-18T00:10:00.000Z'), null, 'empty start');
  assert.equal(computeMinutes('not-a-date', '2026-07-18T00:10:00.000Z'), null, 'invalid start');
  assert.equal(computeMinutes('2026-07-18T00:00:00.000Z', 'not-a-date'), null, 'invalid end');
  assert.equal(
    computeMinutes('2026-07-18T01:00:00.000Z', '2026-07-18T00:00:00.000Z'),
    null,
    'reversed: end before start',
  );
});

test('appendRun: minutes computed from startedAt/finishedAt when not supplied', () => {
  const out = appendRun({ id: 'T' }, {
    startedAt: '2026-07-18T00:00:00.000Z',
    finishedAt: '2026-07-18T00:07:30.000Z',
  });
  assert.equal(parseRuns(out)[0].minutes, 7.5);
});

test('appendRun: minutes omitted when start or end missing/invalid or reversed', () => {
  // only start
  let e = parseRuns(appendRun({ id: 'T' }, { startedAt: '2026-07-18T00:00:00.000Z' }))[0];
  assert.ok(!('minutes' in e), 'no minutes without an end');
  // only end
  e = parseRuns(appendRun({ id: 'T' }, { finishedAt: '2026-07-18T00:00:00.000Z' }))[0];
  assert.ok(!('minutes' in e), 'no minutes without a start');
  // reversed
  e = parseRuns(appendRun({ id: 'T' }, {
    startedAt: '2026-07-18T01:00:00.000Z',
    finishedAt: '2026-07-18T00:00:00.000Z',
  }))[0];
  assert.ok(!('minutes' in e), 'no minutes when end precedes start');
});

test('appendRun: explicit `minutes` is honored over the computed pair', () => {
  const out = appendRun({ id: 'T' }, {
    startedAt: '2026-07-18T00:00:00.000Z',
    finishedAt: '2026-07-18T00:10:00.000Z', // would compute 10
    minutes: 42,
  });
  assert.equal(parseRuns(out)[0].minutes, 42, 'explicit minutes wins');
});

test('appendRun: explicit `minutes` accepts zero and numeric strings', () => {
  assert.equal(parseRuns(appendRun({ id: 'T' }, { minutes: 0 }))[0].minutes, 0);
  assert.strictEqual(parseRuns(appendRun({ id: 'T' }, { minutes: '3.5' }))[0].minutes, 3.5);
});

// ---------------------------------------------------------------------------
// costUsd — written ONLY for finite >= 0 (junk matrix)
// ---------------------------------------------------------------------------

test('appendRun: records costUsd when a finite non-negative amount is supplied', () => {
  assert.equal(parseRuns(appendRun({ id: 'T' }, { costUsd: 1.23 }))[0].costUsd, 1.23);
  assert.strictEqual(parseRuns(appendRun({ id: 'T' }, { costUsd: 0 }))[0].costUsd, 0, 'zero is valid');
  assert.strictEqual(parseRuns(appendRun({ id: 'T' }, { costUsd: '2.5' }))[0].costUsd, 2.5, 'numeric string coerced');
});

test('appendRun: costUsd ABSENT for NaN/Infinity/negative/null/empty/non-numeric junk', () => {
  const junk = [NaN, Infinity, -Infinity, -1, -0.01, null, undefined, '', 'abc', '1x', {}];
  for (const v of junk) {
    const e = parseRuns(appendRun({ id: 'T' }, {
      startedAt: '2026-07-18T00:00:00.000Z',
      finishedAt: '2026-07-18T00:01:00.000Z',
      costUsd: v,
    }))[0];
    assert.ok(!('costUsd' in e), `costUsd must be absent for ${JSON.stringify(v)}`);
    // the rest of the entry is still recorded — bad cost must not drop the run
    assert.equal(e.minutes, 1, 'run still logged despite invalid cost');
  }
});

// ---------------------------------------------------------------------------
// `at` — defaults to finishedAt, then now; normalised to ISO-8601
// ---------------------------------------------------------------------------

test('appendRun: `at` defaults to finishedAt when not supplied', () => {
  const e = parseRuns(appendRun({ id: 'T' }, {
    startedAt: '2026-07-18T00:00:00.000Z',
    finishedAt: '2026-07-18T00:05:00.000Z',
  }))[0];
  assert.equal(e.at, '2026-07-18T00:05:00.000Z', 'at falls back to finishedAt');
});

test('appendRun: explicit `at` wins over finishedAt and is normalised to ISO-8601', () => {
  const e = parseRuns(appendRun({ id: 'T' }, {
    at: new Date('2026-07-18T03:04:05.000Z'),
    finishedAt: '2026-07-18T00:05:00.000Z',
  }))[0];
  assert.equal(e.at, '2026-07-18T03:04:05.000Z');
  assert.match(e.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('appendRun: `at` defaults to now (valid ISO) when neither at nor finishedAt given', () => {
  const before = Date.now();
  const e = parseRuns(appendRun({ id: 'T' }, { startedAt: '2026-07-18T00:00:00.000Z' }))[0];
  const t = Date.parse(e.at);
  assert.ok(!Number.isNaN(t), 'at is a parseable ISO-8601 stamp');
  assert.ok(t >= before - 1000 && t <= Date.now() + 1000, 'at ~ now');
  assert.match(e.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('appendRun: epoch-ms `at` is normalised to ISO-8601', () => {
  const ms = Date.parse('2026-07-18T06:07:08.000Z');
  const e = parseRuns(appendRun({ id: 'T' }, { at: ms }))[0];
  assert.equal(e.at, '2026-07-18T06:07:08.000Z');
});

// ---------------------------------------------------------------------------
// Key ordering + single-line serialization
// ---------------------------------------------------------------------------

test('appendRun: leading keys ordered (id,title,status,created,updated) then runs after', () => {
  const fm = {
    updated: '2026-07-18',
    id: 'TASK-012',
    status: 'in-progress',
    created: '2026-07-10',
    title: 'ticket processing',
  };
  const out = appendRun(fm, {
    startedAt: '2026-07-18T00:00:00.000Z',
    finishedAt: '2026-07-18T00:01:00.000Z',
  });
  const keys = Object.keys(out);
  assert.deepEqual(keys.slice(0, 5), ['id', 'title', 'status', 'created', 'updated']);
  assert.ok(keys.includes(RUNS_KEY), 'runs present');
  assert.ok(keys.indexOf(RUNS_KEY) >= 5, 'runs comes after the leading keys');
});

test('appendRun: the runs value is a SINGLE-LINE JSON array (no newlines)', () => {
  let fm = { id: 'T', title: 't', status: 'in-progress' };
  fm = appendRun(fm, {
    startedAt: '2026-07-18T00:00:00.000Z',
    finishedAt: '2026-07-18T00:10:00.000Z',
    costUsd: 0.5,
  });
  fm = appendRun(fm, {
    startedAt: '2026-07-18T01:00:00.000Z',
    finishedAt: '2026-07-18T01:20:00.000Z',
    costUsd: 1,
  });
  const raw = fm[RUNS_KEY];
  assert.equal(typeof raw, 'string');
  assert.ok(!raw.includes('\n'), 'no newline in the runs value');
  assert.ok(!raw.includes('\r'), 'no carriage return in the runs value');
  // It is valid JSON describing an array of the two entries.
  const parsed = JSON.parse(raw);
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed.length, 2);
});

test('serializeRuns: emits a single-line JSON array; empty/non-array => "[]"', () => {
  assert.equal(serializeRuns([]), '[]');
  assert.equal(serializeRuns(null), '[]');
  assert.equal(serializeRuns(undefined), '[]');
  assert.equal(serializeRuns('nonsense'), '[]');
  const s = serializeRuns([{ at: '2026-07-18T00:00:00.000Z', minutes: 1 }]);
  assert.ok(!s.includes('\n'));
  assert.deepEqual(JSON.parse(s), [{ at: '2026-07-18T00:00:00.000Z', minutes: 1 }]);
});

// ---------------------------------------------------------------------------
// parseRuns tolerance
// ---------------------------------------------------------------------------

test('parseRuns: absent / non-string / invalid-JSON / non-array => []', () => {
  assert.deepEqual(parseRuns({ id: 'T' }), [], 'absent field');
  assert.deepEqual(parseRuns({}), [], 'empty fm');
  assert.deepEqual(parseRuns(null), [], 'null fm');
  assert.deepEqual(parseRuns(undefined), [], 'undefined fm');
  assert.deepEqual(parseRuns({ [RUNS_KEY]: 12345 }), [], 'non-string number field');
  assert.deepEqual(parseRuns({ [RUNS_KEY]: '   ' }), [], 'blank string');
  assert.deepEqual(parseRuns({ [RUNS_KEY]: '{not json' }), [], 'invalid JSON');
  assert.deepEqual(parseRuns({ [RUNS_KEY]: '{"a":1}' }), [], 'valid JSON but not an array');
  assert.deepEqual(parseRuns({ [RUNS_KEY]: '"just a string"' }), [], 'JSON string, not array');
  assert.deepEqual(parseRuns({ [RUNS_KEY]: '42' }), [], 'JSON number, not array');
});

test('parseRuns: parses a well-formed one-line JSON array back into entry objects', () => {
  const entries = [
    { at: '2026-07-18T00:00:00.000Z', minutes: 1, costUsd: 0.1 },
    { at: '2026-07-18T01:00:00.000Z', minutes: 2, costUsd: 0.2 },
  ];
  assert.deepEqual(parseRuns({ [RUNS_KEY]: JSON.stringify(entries) }), entries);
});

test('parseRuns: filters out non-object elements inside the array', () => {
  const raw = JSON.stringify([{ at: 'x', minutes: 1 }, null, 5, 'str', { minutes: 2 }]);
  assert.deepEqual(parseRuns({ [RUNS_KEY]: raw }), [{ at: 'x', minutes: 1 }, { minutes: 2 }]);
});

// ---------------------------------------------------------------------------
// ROUND-TRIP scenario (e2e) — survives the board's parse+serialize
// ---------------------------------------------------------------------------

const BODY = [
  '',
  '## Description',
  'tickets should hold the number of minutes processed and the cost.',
  '',
  '## Additional Context',
  '(User-owned. Never overwrite.)',
  'A note with **markdown** and a trailing space.   ',
].join('\n');

test('SCENARIO: a runs entry survives parse(serialize(fm, body)) as a single-line JSON array', () => {
  // Given a ticket whose run log already holds two accumulated runs
  let fm = {
    id: 'TASK-012',
    title: 'ticket processing',
    status: 'done',
    created: '2026-07-10',
    updated: '2026-07-18',
  };
  fm = appendRun(fm, {
    startedAt: '2026-07-18T01:00:00.000Z',
    finishedAt: '2026-07-18T01:10:00.000Z',
    costUsd: 0.5,
  });
  fm = appendRun(fm, {
    startedAt: '2026-07-18T02:00:00.000Z',
    finishedAt: '2026-07-18T02:05:00.000Z',
    costUsd: 0.25,
  });

  // When the ticket is serialized and re-parsed by the board's own logic
  const fileText = serializeTicket(fm, BODY);
  // The whole runs array lives on exactly one physical line of the file.
  const runsLines = fileText.split('\n').filter((l) => l.startsWith(`${RUNS_KEY}:`));
  assert.equal(runsLines.length, 1, 'runs occupies exactly one line in the file');

  const round = parseTicketFrontmatter(fileText);
  assert.ok(round, 'file parses back');

  // Then the runs field is still a single-line JSON array of the two runs
  const raw = round.fm[RUNS_KEY];
  assert.equal(typeof raw, 'string');
  assert.ok(!raw.includes('\n'), 'still single-line after round-trip');
  const runs = parseRuns(round.fm);
  assert.equal(runs.length, 2, 'both runs survive');
  assert.equal(runs[0].minutes, 10);
  assert.equal(runs[0].costUsd, 0.5);
  assert.equal(runs[1].minutes, 5);
  assert.equal(runs[1].costUsd, 0.25);

  // And the leading keys / body / Additional Context are intact
  assert.deepEqual(
    Object.keys(round.fm).slice(0, 5),
    ['id', 'title', 'status', 'created', 'updated'],
  );
  assert.equal(round.body, BODY, 'body byte-for-byte identical');
  assert.match(round.body, /## Additional Context/);
  assert.match(round.body, /A note with \*\*markdown\*\* and a trailing space\.   /);
});

test('SCENARIO: appendRun ordering agrees with the real serializer (pure helper == serializer rule)', () => {
  const fm = appendRun(
    { updated: 'u', id: 'T', status: 's', title: 't', created: 'c' },
    { startedAt: '2026-07-18T00:00:00.000Z', finishedAt: '2026-07-18T00:01:00.000Z' },
  );
  const serialized = serializeTicket(fm, '');
  const serializedKeys = serialized
    .split('\n')
    .slice(1) // drop opening ---
    .filter((l) => l !== '---' && l.includes(':'))
    .map((l) => l.slice(0, l.indexOf(':')));
  assert.deepEqual(serializedKeys, Object.keys(fm), 'appendRun ordering mirrors the serializer');
});

// ---------------------------------------------------------------------------
// FAILURE / EDGE scenario — a corrupt hand-edited run log must not throw and
// must not lose a newly recorded run.
// ---------------------------------------------------------------------------

test('EDGE: appendRun onto a ticket with a corrupt runs field starts a fresh log (no throw)', () => {
  // Given a ticket whose runs field was hand-corrupted to invalid JSON
  const fm = { id: 'T', title: 't', status: 'in-progress', [RUNS_KEY]: '[oops not json' };
  // When a run is recorded, the corrupt payload is treated as empty (never throws)
  const out = appendRun(fm, {
    startedAt: '2026-07-18T00:00:00.000Z',
    finishedAt: '2026-07-18T00:03:00.000Z',
    costUsd: 0.9,
  });
  // Then the new run is the only entry and the field is valid single-line JSON again
  const runs = parseRuns(out);
  assert.equal(runs.length, 1, 'corrupt prior log dropped, new run kept');
  assert.equal(runs[0].minutes, 3);
  assert.equal(runs[0].costUsd, 0.9);
  assert.ok(!out[RUNS_KEY].includes('\n'));
});
