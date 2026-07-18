'use strict';

// Unit tests for lib/ticket-accounting.js — the Electron-free helpers the
// orchestrator uses to stamp per-ticket build accounting (TASK-003): when a
// build started/finished plus optional tokens/costUsd. The module is pure (no
// disk/network/Electron), so it is exercised directly with plain `node --test`.
// No files are written by these tests.
//
// The round-trip / ordering contract lives in renderer/renderer.js's
// serializeTicket (~5058) + parseTicketFrontmatter (~5034). That file is a
// browser script and is NOT requireable, so the round-trip block below reuses
// the REAL ordering rule two ways:
//   1. copies serializeTicket/parseTicketFrontmatter VERBATIM from renderer.js
//      (kept byte-faithful; the source line refs above let a reader diff them),
//      and
//   2. cross-checks that lib/ticket-accounting.js's orderFm produces the SAME
//      leading-key order, so the pure helper the orchestrator actually calls is
//      proven to agree with the serializer.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  recordBuildStart,
  recordBuildEnd,
  formatDuration,
  isValidAmount,
  orderFm,
  toIso,
  LEADING_KEYS,
} = require('../lib/ticket-accounting');

// ---------------------------------------------------------------------------
// Real serializer/parser, copied verbatim from renderer/renderer.js (~5034 /
// ~5058). renderer.js is a browser script and cannot be required, so the
// round-trip contract is exercised against these faithful copies. If the real
// functions change, these must be updated in lockstep.
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
  assert.equal(typeof recordBuildStart, 'function');
  assert.equal(typeof recordBuildEnd, 'function');
  assert.equal(typeof formatDuration, 'function');
  assert.equal(typeof isValidAmount, 'function');
  assert.equal(typeof orderFm, 'function');
  assert.equal(typeof toIso, 'function');
  assert.deepEqual(LEADING_KEYS, ['id', 'title', 'status', 'created', 'updated']);
});

// ---------------------------------------------------------------------------
// isValidAmount — the valid/invalid matrix guarding tokens/costUsd
// ---------------------------------------------------------------------------

test('isValidAmount accepts finite numbers >= 0 (including numeric strings and zero)', () => {
  for (const v of [0, 1, 42, 0.5, 1234567, '0', '12', '3.14', '  7 ']) {
    assert.equal(isValidAmount(v), true, `expected valid: ${JSON.stringify(v)}`);
  }
});

test('isValidAmount rejects NaN/Infinity/negative/null/undefined/empty/non-numeric', () => {
  for (const v of [
    NaN, Infinity, -Infinity, -1, -0.01, -100,
    null, undefined, '',
    'abc', '1abc', 'NaN', {},
  ]) {
    assert.equal(isValidAmount(v), false, `expected invalid: ${JSON.stringify(v)}`);
  }
});

// EDGE CASE (documenting actual behavior, not a hard spec requirement): a
// whitespace-only string coerces to 0 via Number('   ') and is therefore treated
// as a VALID amount, so recordBuildEnd would stamp tokens/costUsd = 0 from it.
// The implementation guards the literal '' but not all-whitespace; the ticket's
// explicit invalid matrix lists '' but not whitespace, and the contract is
// "finite number >= 0" which 0 satisfies — so this is within the written spec.
// Flagged for the orchestrator as a minor gap vs. the "never fabricate from
// junk data" spirit; pinned here so any future change is visible.
test('EDGE: whitespace-only string coerces to 0 and is treated as valid (Number quirk)', () => {
  assert.equal(isValidAmount('   '), true, 'whitespace coerces to 0 → currently valid');
  const out = recordBuildEnd({ id: 'T' }, { at: Date.now(), tokens: '   ' });
  assert.strictEqual(out.tokens, 0, 'stamps 0 from a whitespace input (documented behavior)');
});

// Same JS coercion family: [] -> Number([]) === 0, [n] -> n, true -> 1,
// false -> 0. All are currently treated as VALID amounts. The orchestrator only
// ever supplies real numbers/numeric strings, so this is a documented edge, not
// a live risk. Pinned so a stricter guard (e.g. rejecting non-number/non-string
// inputs) would surface here.
test('EDGE: booleans and empty/single-element arrays coerce to numbers (currently valid)', () => {
  assert.equal(isValidAmount([]), true, 'Number([]) === 0');
  assert.equal(isValidAmount([7]), true, 'Number([7]) === 7');
  assert.equal(isValidAmount(true), true, 'Number(true) === 1');
  assert.equal(isValidAmount(false), true, 'Number(false) === 0');
  assert.equal(isValidAmount([1, 2]), false, 'Number([1,2]) === NaN → invalid');
});

// ---------------------------------------------------------------------------
// recordBuildStart — start recorded (ISO-8601), idempotent, no mutation
// ---------------------------------------------------------------------------

test('recordBuildStart sets startedAt as an ISO-8601 string when absent', () => {
  const fm = { id: 'T-1', title: 'x', status: 'in-progress' };
  const out = recordBuildStart(fm, { at: '2026-07-18T01:00:00.000Z' });
  assert.equal(out.startedAt, '2026-07-18T01:00:00.000Z');
  // Parseable ISO-8601.
  assert.ok(!Number.isNaN(Date.parse(out.startedAt)));
  assert.match(out.startedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('recordBuildStart normalises Date / epoch-ms inputs to ISO-8601', () => {
  const d = new Date('2026-01-02T03:04:05.000Z');
  assert.equal(recordBuildStart({}, { at: d }).startedAt, '2026-01-02T03:04:05.000Z');
  assert.equal(
    recordBuildStart({}, { at: d.getTime() }).startedAt,
    '2026-01-02T03:04:05.000Z',
  );
});

test('recordBuildStart defaults to "now" (valid ISO) when no `at` given', () => {
  const before = Date.now();
  const out = recordBuildStart({ id: 'T' }, {});
  const t = Date.parse(out.startedAt);
  assert.ok(!Number.isNaN(t));
  assert.ok(t >= before - 1000 && t <= Date.now() + 1000);
});

test('recordBuildStart is idempotent: does NOT reset an existing startedAt', () => {
  const fm = { id: 'T-1', startedAt: '2026-07-18T01:00:00.000Z' };
  const out = recordBuildStart(fm, { at: '2026-07-18T09:99:99Z' /* later */ });
  assert.equal(out.startedAt, '2026-07-18T01:00:00.000Z', 'first start wins');
});

test('recordBuildStart treats an empty/blank existing startedAt as absent', () => {
  const out = recordBuildStart({ id: 'T', startedAt: '   ' }, { at: '2026-07-18T01:00:00.000Z' });
  assert.equal(out.startedAt, '2026-07-18T01:00:00.000Z');
});

test('recordBuildStart does not mutate its input and returns a new object', () => {
  const fm = { id: 'T-1', title: 'x' };
  const snapshot = JSON.stringify(fm);
  const out = recordBuildStart(fm, { at: '2026-07-18T01:00:00.000Z' });
  assert.notEqual(out, fm, 'a new object is returned');
  assert.equal(JSON.stringify(fm), snapshot, 'input untouched');
  assert.equal(fm.startedAt, undefined);
});

// ---------------------------------------------------------------------------
// recordBuildEnd — end ALWAYS set; tokens/costUsd only when valid; no mutation
// ---------------------------------------------------------------------------

test('recordBuildEnd always sets finishedAt (ISO-8601), even with no cost data', () => {
  const out = recordBuildEnd({ id: 'T', startedAt: '2026-07-18T01:00:00.000Z' }, {
    at: '2026-07-18T02:00:00.000Z',
  });
  assert.equal(out.finishedAt, '2026-07-18T02:00:00.000Z');
  // startedAt preserved; no fabricated tokens/costUsd.
  assert.equal(out.startedAt, '2026-07-18T01:00:00.000Z');
  assert.ok(!('tokens' in out), 'no tokens fabricated');
  assert.ok(!('costUsd' in out), 'no costUsd fabricated');
});

test('recordBuildEnd records tokens and costUsd when valid finite non-negatives supplied', () => {
  const out = recordBuildEnd({ id: 'T' }, {
    at: '2026-07-18T02:00:00.000Z',
    tokens: 12345,
    costUsd: 0.42,
  });
  assert.equal(out.tokens, 12345);
  assert.equal(out.costUsd, 0.42);
  assert.equal(typeof out.tokens, 'number');
  assert.equal(typeof out.costUsd, 'number');
});

test('recordBuildEnd coerces valid numeric strings to numbers', () => {
  const out = recordBuildEnd({ id: 'T' }, { at: Date.now(), tokens: '900', costUsd: '1.25' });
  assert.strictEqual(out.tokens, 900);
  assert.strictEqual(out.costUsd, 1.25);
});

test('recordBuildEnd accepts zero as a valid amount', () => {
  const out = recordBuildEnd({ id: 'T' }, { at: Date.now(), tokens: 0, costUsd: 0 });
  assert.strictEqual(out.tokens, 0);
  assert.strictEqual(out.costUsd, 0);
});

test('recordBuildEnd NEVER writes NaN/Infinity/negative/null/empty/non-numeric amounts', () => {
  const bad = [NaN, Infinity, -Infinity, -1, -0.5, null, undefined, '', 'abc', '1x', {}];
  for (const v of bad) {
    const out = recordBuildEnd({ id: 'T' }, { at: Date.now(), tokens: v, costUsd: v });
    assert.ok(!('tokens' in out), `tokens must be absent for ${JSON.stringify(v)}`);
    assert.ok(!('costUsd' in out), `costUsd must be absent for ${JSON.stringify(v)}`);
    // finishedAt still present — missing cost data must not corrupt the ticket.
    assert.ok(out.finishedAt && !Number.isNaN(Date.parse(out.finishedAt)));
  }
});

test('recordBuildEnd sets one field when only one is valid (independent guards)', () => {
  const out = recordBuildEnd({ id: 'T' }, { at: Date.now(), tokens: 500, costUsd: NaN });
  assert.equal(out.tokens, 500);
  assert.ok(!('costUsd' in out));
});

test('recordBuildEnd does not mutate its input and returns a new object', () => {
  const fm = { id: 'T-1', startedAt: '2026-07-18T01:00:00.000Z' };
  const snapshot = JSON.stringify(fm);
  const out = recordBuildEnd(fm, { at: '2026-07-18T02:00:00.000Z', tokens: 10, costUsd: 1 });
  assert.notEqual(out, fm);
  assert.equal(JSON.stringify(fm), snapshot, 'input untouched');
  assert.equal(fm.finishedAt, undefined);
});

test('end >= start: finishedAt is not before a preserved startedAt in a start->end flow', () => {
  const started = recordBuildStart({ id: 'T' }, { at: '2026-07-18T01:00:00.000Z' });
  const ended = recordBuildEnd(started, { at: '2026-07-18T01:05:30.000Z' });
  assert.ok(Date.parse(ended.finishedAt) >= Date.parse(ended.startedAt), 'end >= start');
  assert.equal(formatDuration(ended.startedAt, ended.finishedAt), '5m 30s');
});

// ---------------------------------------------------------------------------
// formatDuration — boundaries & compact formatting
// ---------------------------------------------------------------------------

test('formatDuration renders hours as "Hh MMm" with zero-padded minutes', () => {
  assert.equal(
    formatDuration('2026-07-18T00:00:00.000Z', '2026-07-18T01:05:00.000Z'),
    '1h 05m',
  );
  assert.equal(
    formatDuration('2026-07-18T00:00:00.000Z', '2026-07-18T02:00:00.000Z'),
    '2h 00m',
  );
});

test('formatDuration renders minutes as "Mm SSs" with zero-padded seconds', () => {
  assert.equal(
    formatDuration('2026-07-18T00:00:00.000Z', '2026-07-18T00:05:30.000Z'),
    '5m 30s',
  );
  assert.equal(
    formatDuration('2026-07-18T00:00:00.000Z', '2026-07-18T00:01:05.000Z'),
    '1m 05s',
  );
});

test('formatDuration renders sub-minute gaps as "Ss"', () => {
  assert.equal(formatDuration('2026-07-18T00:00:00.000Z', '2026-07-18T00:00:09.000Z'), '9s');
  assert.equal(formatDuration('2026-07-18T00:00:00.000Z', '2026-07-18T00:00:00.000Z'), '0s');
});

test('formatDuration uses `now` when finishedAt omitted (still-running build)', () => {
  const start = '2026-07-18T00:00:00.000Z';
  const now = new Date('2026-07-18T00:02:34.000Z');
  assert.equal(formatDuration(start, null, now), '2m 34s');
  assert.equal(formatDuration(start, undefined, now.getTime()), '2m 34s');
});

test('formatDuration returns null on missing/invalid/reversed inputs', () => {
  assert.equal(formatDuration(null, '2026-07-18T00:00:00.000Z'), null, 'missing start');
  assert.equal(formatDuration('', '2026-07-18T00:00:00.000Z'), null, 'empty start');
  assert.equal(formatDuration('not-a-date', '2026-07-18T00:00:00.000Z'), null, 'invalid start');
  assert.equal(
    formatDuration('2026-07-18T00:00:00.000Z', 'not-a-date'),
    null,
    'invalid finish',
  );
  assert.equal(
    formatDuration('2026-07-18T01:00:00.000Z', '2026-07-18T00:00:00.000Z'),
    null,
    'reversed: end before start',
  );
});

// ---------------------------------------------------------------------------
// orderFm — leading-key ordering matches the real serializer rule
// ---------------------------------------------------------------------------

test('orderFm puts present LEADING_KEYS first in fixed order, then rest in insertion order', () => {
  const fm = {
    tokens: 10,
    updated: 'u',
    id: 'T-1',
    costUsd: 1,
    status: 's',
    startedAt: 'a',
    title: 't',
    created: 'c',
  };
  assert.deepEqual(Object.keys(orderFm(fm)), [
    'id', 'title', 'status', 'created', 'updated', // leading, fixed order
    'tokens', 'costUsd', 'startedAt',              // rest, insertion order
  ]);
});

test('orderFm omits leading keys that are null/undefined but keeps present ones ordered', () => {
  const fm = { status: 's', id: 'T', extra: 'e' }; // no title/created/updated
  assert.deepEqual(Object.keys(orderFm(fm)), ['id', 'status', 'extra']);
});

test('orderFm does not mutate input', () => {
  const fm = { updated: 'u', id: 'T' };
  const snap = JSON.stringify(fm);
  orderFm(fm);
  assert.equal(JSON.stringify(fm), snap);
});

// ---------------------------------------------------------------------------
// Round-trip / preservation contract (real serializer copied above)
// ---------------------------------------------------------------------------

const BODY = [
  '',
  '## Description',
  'Build the accounting.',
  '',
  '## Additional Context',
  '(User-owned. Never overwrite.)',
  'A note with **markdown** and a trailing space.   ',
].join('\n');

test('accounting keys survive parse(serialize(fm, body)) round-trip', () => {
  const fm = {
    id: 'TASK-003',
    title: 'tokens used',
    status: 'done',
    created: '2026-07-10',
    updated: '2026-07-18',
    startedAt: '2026-07-18T01:00:00.000Z',
    finishedAt: '2026-07-18T02:05:00.000Z',
    costUsd: 0.42,
    tokens: 12345,
  };
  const round = parseTicketFrontmatter(serializeTicket(fm, BODY));
  assert.ok(round, 'parses back');
  // All accounting values survive (as strings after re-parse — frontmatter is textual).
  assert.equal(round.fm.startedAt, '2026-07-18T01:00:00.000Z');
  assert.equal(round.fm.finishedAt, '2026-07-18T02:05:00.000Z');
  assert.equal(round.fm.costUsd, '0.42');
  assert.equal(round.fm.tokens, '12345');
});

test('id/title/status/created/updated remain the leading keys in order after round-trip', () => {
  const fm = orderFm({
    tokens: 12345,
    finishedAt: '2026-07-18T02:05:00.000Z',
    id: 'TASK-003',
    status: 'done',
    startedAt: '2026-07-18T01:00:00.000Z',
    title: 'tokens used',
    updated: '2026-07-18',
    costUsd: 0.42,
    created: '2026-07-10',
  });
  const round = parseTicketFrontmatter(serializeTicket(fm, BODY));
  const keys = Object.keys(round.fm);
  assert.deepEqual(keys.slice(0, 5), ['id', 'title', 'status', 'created', 'updated']);
  // Accounting keys follow, still present.
  assert.deepEqual(keys.slice(5).sort(), ['costUsd', 'finishedAt', 'startedAt', 'tokens']);
});

test('## Additional Context and the rest of the body are preserved verbatim', () => {
  const fm = { id: 'TASK-003', title: 't', status: 'done', tokens: 5 };
  const round = parseTicketFrontmatter(serializeTicket(fm, BODY));
  assert.equal(round.body, BODY, 'body byte-for-byte identical');
  assert.match(round.body, /A note with \*\*markdown\*\* and a trailing space\.   /);
  assert.match(round.body, /## Additional Context/);
});

test('serializer leading-key order agrees with orderFm (pure helper == serializer rule)', () => {
  const fm = {
    tokens: 1, id: 'T', updated: 'u', costUsd: 2, title: 't', status: 's', created: 'c',
  };
  const serialized = serializeTicket(fm, '');
  const orderedKeys = Object.keys(orderFm(fm));
  const serializedKeys = serialized
    .split('\n')
    .slice(1) // drop opening ---
    .filter((l) => l !== '---' ? l.includes(':') : false)
    .map((l) => l.slice(0, l.indexOf(':')));
  assert.deepEqual(serializedKeys, orderedKeys, 'orderFm mirrors the real serializer ordering');
});
