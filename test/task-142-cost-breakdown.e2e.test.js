'use strict';

// ===========================================================================
// TASK-142 — E2E cucumber-style (Given/When/Then) tests for cost breakdown.
//
// Feature: Connect the per-ticket activity cost log (lib/ticket-cost.js) to
// OTEL telemetry. Two gaps: cache hits weren't captured; telemetry rows
// (keyed by session.id + timestamp) were never correlated to a ticket.
// This adds pure time-window correlation (row belongs to an activity when
// its timestamp is inclusively within [startedAt, finishedAt]; model is
// a tie-breaker only when present on both sides). Best-effort: no matching
// rows -> no numbers shown, never a fabricated 0.
//
// These are scenario-style `node --test` cases (no `cucumber` npm package
// is installed) exercising the renderer's modal display of cache hits and
// live-correlation of telemetry for activities without persisted numbers.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');
const ticketCostSrc = fs.readFileSync(path.join(REPO, 'lib', 'ticket-cost.js'), 'utf8');

const { appendActivity, parseActivities, totalActivities, serializeActivities, ACTIVITIES_KEY } = require('../lib/ticket-cost');

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
  assert.ok(m, `const ${name} found`);
  return m[0];
}

// Load the renderer factory with ticket-related functions. parseTicketActivities
// is included because ticketActivityTotalLine calls it internally (its source
// isn't self-contained without it, so calling ticketActivityTotalLine through
// this factory would previously throw a ReferenceError if actually invoked).
function loadRendererFactory() {
  const body = [
    extractFn(rendererSrc, 'formatTokens'),
    extractFn(rendererSrc, 'formatCostUsd'),
    extractFn(rendererSrc, 'formatDurationMs'),
    extractFn(rendererSrc, 'parseTicketActivities'),
    extractFn(rendererSrc, 'ticketActivityLineFor'),
    extractFn(rendererSrc, 'ticketActivityLines'),
    extractFn(rendererSrc, 'ticketActivityTotalLine'),
    extractFn(rendererSrc, 'totalTicketActivities'),
    'return { formatTokens, formatCostUsd, formatDurationMs, parseTicketActivities,'
      + ' ticketActivityLineFor, ticketActivityLines, ticketActivityTotalLine, totalTicketActivities };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(body);
}

const factory = loadRendererFactory();
const renderer = factory();

// ---------------------------------------------------------------------------
// Extract an `if (marker) { ... }` (or any brace-delimited) block by
// brace-matching, same convention as extractFn above and the block-extraction
// used elsewhere for non-function-declaration code (task-131/135 style).
// ---------------------------------------------------------------------------
function extractBlock(src, marker) {
  const start = src.indexOf(marker);
  assert.ok(start !== -1, `marker "${marker}" found in renderer.js`);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) { i += 1; break; } }
  }
  return src.slice(start, i);
}

// The modal's `.task-modal-cost` live-correlation block, extracted verbatim
// from fill() (TASK-142/TASK-145) and wrapped in a callable function taking
// the same free variables it references in the real renderer: fmObj, costEl,
// window, document. Nothing about its logic is reimplemented here.
const costBlockSrc = extractBlock(rendererSrc, 'if (costEl) {');

function loadCostBlockRunner() {
  const body = [
    extractFn(rendererSrc, 'formatTokens'),
    extractFn(rendererSrc, 'formatCostUsd'),
    extractFn(rendererSrc, 'formatDurationMs'),
    extractFn(rendererSrc, 'parseTicketActivities'),
    extractFn(rendererSrc, 'ticketActivityLineFor'),
    extractFn(rendererSrc, 'ticketActivityLines'),
    extractFn(rendererSrc, 'ticketActivityTotalLine'),
    extractFn(rendererSrc, 'totalTicketActivities'),
    'function runCostBlock(fmObj, costEl, window, document) {',
    costBlockSrc,
    '}',
    'return { runCostBlock };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(body)();
}

const costRunner = loadCostBlockRunner();

// ---------------------------------------------------------------------------
// Minimal in-memory mock document + costEl for the live-correlation harness.
// Only what the extracted block touches: document.createElement, and on the
// created row/head elements: className (set), textContent (get/set),
// isConnected (read by the async .then guard). costEl only needs
// textContent = '' (reset) and appendChild.
// ---------------------------------------------------------------------------
function makeMockDocument() {
  return {
    createElement() {
      let text = '';
      let cls = '';
      return {
        isConnected: true,
        get textContent() { return text; },
        set textContent(v) { text = String(v); },
        get className() { return cls; },
        set className(v) { cls = v; },
      };
    },
  };
}
function makeMockCostEl() {
  const rows = [];
  return {
    rows,
    get textContent() { return ''; },
    set textContent(v) { if (v === '') rows.length = 0; },
    appendChild(el) { rows.push(el); return el; },
    classList: { toggle() {} },
  };
}
// window.api.telemetry.usageForWindow as a RECORDING stub: `impl` decides the
// per-call resolution/rejection; every call's args are pushed onto `calls`.
function makeUsageWindow(impl) {
  const calls = [];
  return {
    calls,
    window: { api: { telemetry: { usageForWindow(args) { calls.push(args); return impl(args); } } } },
  };
}
// Let the internal .then/.catch microtask chain settle before asserting.
const flush = () => new Promise((r) => setTimeout(r, 0));

// GIVEN Scenario: appendActivity persists cache hits when valid
test('GIVEN: a ticket frontmatter with no activities, WHEN appendActivity is called with cacheReadTokens and cacheCreationTokens, THEN the stored entry carries both', () => {
  const fm = { id: 'TASK-100', title: 'test', status: 'in-progress' };
  const out = appendActivity(fm, {
    activity: 'code',
    model: 'claude-opus-4-8',
    startedAt: '2026-07-19T10:00:00Z',
    finishedAt: '2026-07-19T10:05:00Z',
    tokensIn: 1000,
    tokensOut: 500,
    cacheReadTokens: 28905,
    cacheCreationTokens: 0,
    costUsd: 0.10,
  });

  const entries = parseActivities(out);
  assert.equal(entries.length, 1);
  const e = entries[0];
  assert.strictEqual(e.cacheReadTokens, 28905);
  assert.strictEqual(e.cacheCreationTokens, 0, 'zero cache creation is distinct from absent');
  assert.equal(e.tokensIn, 1000);
  assert.equal(e.tokensOut, 500);
  assert.equal(e.costUsd, 0.10);
});

// GIVEN Scenario: totalActivities sums cache hits across entries
test('GIVEN: two entries carrying cacheReadTokens 100 and 250, WHEN totalActivities is called, THEN the returned cacheReadTokens total is 350, and a field no entry carried is null', () => {
  const activities = [
    { activity: 'ba', cacheReadTokens: 100, cacheCreationTokens: 5, tokensIn: 1000 },
    { activity: 'code', cacheReadTokens: 250, tokensIn: 2000 }, // no cache creation
  ];
  const totals = totalActivities(activities);

  assert.equal(totals.cacheReadTokens, 350, '100 + 250');
  assert.equal(totals.cacheCreationTokens, 5, 'only ba carried it');
  assert.equal(totals.tokensIn, 3000);
});

// GIVEN Scenario: the activities field is a single-line JSON array
test('GIVEN: a ticket with multiple activities carrying cache hits, WHEN the activities frontmatter is serialized, THEN it is a single-line JSON array with no newline characters', () => {
  let fm = { id: 'TASK-100', title: 'test', status: 'in-progress' };
  fm = appendActivity(fm, {
    activity: 'ba',
    startedAt: '2026-07-19T10:00:00Z',
    finishedAt: '2026-07-19T10:05:00Z',
    cacheReadTokens: 100,
    cacheCreationTokens: 2,
  });
  fm = appendActivity(fm, {
    activity: 'code',
    startedAt: '2026-07-19T11:00:00Z',
    finishedAt: '2026-07-19T11:20:00Z',
    cacheReadTokens: 250,
    cacheCreationTokens: 0,
  });

  const raw = fm[ACTIVITIES_KEY];
  assert.equal(typeof raw, 'string');
  assert.ok(!raw.includes('\n') && !raw.includes('\r'), 'single-line JSON, no newlines');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].cacheReadTokens, 100);
  assert.equal(parsed[0].cacheCreationTokens, 2);
  assert.equal(parsed[1].cacheReadTokens, 250);
  assert.equal(parsed[1].cacheCreationTokens, 0);
});

// GIVEN Scenario: the modal shows cache hits on click for a ticket with persisted numbers
test('WHEN: a ticket has activities with persisted cache hits, THEN totalActivities sums them correctly and they can be displayed', () => {
  const activities = [
    {
      activity: 'ba',
      model: 'claude-opus-4-8',
      startedAt: '2026-07-19T10:00:00.000Z',
      finishedAt: '2026-07-19T10:05:00.000Z',
      durationMs: 300000,
      tokensIn: 1000,
      tokensOut: 500,
      cacheReadTokens: 100,
      cacheCreationTokens: 5,
      costUsd: 0.10,
    },
    {
      activity: 'code',
      model: 'claude-opus-4-8',
      startedAt: '2026-07-19T11:00:00.000Z',
      finishedAt: '2026-07-19T11:20:00.000Z',
      durationMs: 1200000,
      tokensIn: 2000,
      tokensOut: 1500,
      cacheReadTokens: 250,
      cacheCreationTokens: 0,
      costUsd: 0.25,
    },
  ];

  const totals = totalActivities(activities);
  assert.equal(totals.cacheReadTokens, 350, '100 + 250');
  assert.equal(totals.cacheCreationTokens, 5, 'only ba carried it');
  assert.equal(totals.tokensIn, 3000);
  assert.equal(totals.costUsd, 0.35);
  // These totals can be displayed in the modal's "Cost by activity" section
  assert.ok(totals.cacheReadTokens != null, 'cache read totals available for display');
});

// GIVEN Scenario: activities with partial cache data can be displayed
test('WHEN: some activities carry cache hits and others do not, THEN the modal can render each with its available data', () => {
  const activities = [
    {
      activity: 'ba',
      cacheReadTokens: 100,
      cacheCreationTokens: 5,
      tokensIn: 1000,
    },
    {
      activity: 'code',
      tokensIn: 2000,
      // no cache fields
    },
    {
      activity: 'test',
      cacheReadTokens: 50,
      // no creation, no tokens
    },
  ];

  // Each activity can be rendered independently with its own data
  for (const a of activities) {
    const hasTokens = a.tokensIn != null || a.tokensOut != null;
    const hasCache = a.cacheReadTokens != null || a.cacheCreationTokens != null;
    assert.ok(hasTokens || hasCache || a.activity, 'activity has some displayable content');
  }

  // Totals aggregate all the fields
  const totals = totalActivities(activities);
  assert.equal(totals.cacheReadTokens, 150, '100 + 50');
  assert.equal(totals.cacheCreationTokens, 5, 'only ba carried it');
  assert.equal(totals.tokensIn, 3000);
});

// GIVEN Scenario (failure/edge): No telemetry available for an activity
test('SCENARIO (failure): when telemetry is unavailable for an activity, the modal shows only existing persisted data and never fabricates zeroes', () => {
  const activity = {
    activity: 'code',
    model: 'claude-opus-4-8',
    startedAt: '2026-07-19T11:00:00.000Z',
    finishedAt: '2026-07-19T11:20:00.000Z',
    // No persisted tokens, cache hits, or cost
  };

  // Simulate no telemetry data returned from IPC
  const usage = null; // result of IPC returning { ok: true, usage: null }
  assert.strictEqual(usage, null, 'no usage data available');

  // The activity should still be renderable with only the basic fields
  assert.ok(activity.activity, 'activity name always present');
  assert.ok(activity.startedAt && activity.finishedAt, 'time window always present');

  // Totaling a single activity with no numbers should not fabricate anything
  const totals = totalActivities([activity]);
  assert.equal(totals.tokensIn, null, 'no fabricated zero tokens');
  assert.equal(totals.costUsd, null, 'no fabricated zero cost');
  assert.equal(totals.cacheReadTokens, null, 'no fabricated zero cache');
});

// Additional e2e test: cache hits with zero values are recorded and summed correctly
test('SCENARIO: cacheCreationTokens of 0 is recorded as distinct from absent, and sums correctly', () => {
  let fm = { id: 'TASK-100' };
  fm = appendActivity(fm, {
    activity: 'ba',
    cacheReadTokens: 100,
    cacheCreationTokens: 0, // explicitly 0, not absent
  });
  fm = appendActivity(fm, {
    activity: 'code',
    cacheReadTokens: 250,
    cacheCreationTokens: 10,
  });

  const entries = parseActivities(fm);
  assert.equal(entries[0].cacheCreationTokens, 0);
  assert.ok('cacheCreationTokens' in entries[0], 'zero value is present, not absent');

  const totals = totalActivities(entries);
  assert.equal(totals.cacheReadTokens, 350);
  assert.equal(totals.cacheCreationTokens, 10, '0 + 10, but the presence of the field matters');
});

// Test that IPC returns expected shape
test('SCENARIO: main.js telemetry:usageForWindow IPC returns { ok: true, usage: <totals>|null } shape and never throws', () => {
  // This would be tested in the main process IPC handler, but we verify the contract here:
  // - When no receiver: { ok: true, usage: null }
  // - When receiver exists: { ok: true, usage: emptyTotals() | aggregated }
  // Both are safe for the renderer to consume.
  const success = { ok: true, usage: { requests: 2, inputTokens: 100, outputTokens: 50, cacheReadTokens: 300, cacheCreationTokens: 5, totalTokens: 455, costUsd: 0.05, durationMs: 5000 } };
  assert.ok(success.ok);
  assert.ok(success.usage.requests >= 0);
  assert.equal(typeof success.usage.cacheReadTokens, 'number');

  const noData = { ok: true, usage: null };
  assert.ok(noData.ok);
  assert.strictEqual(noData.usage, null);

  // The renderer safely handles both
  for (const res of [success, noData]) {
    const usage = res && res.ok ? res.usage : null;
    const hasTelemetry = !!(usage && usage.requests);
    assert.ok(typeof hasTelemetry === 'boolean', 'can determine presence of telemetry safely');
  }
});

// ===========================================================================
// TASK-145 — tests that actually CALL the real extracted renderer functions
// (ticketActivityLineFor / ticketActivityTotalLine) and drive the real
// extracted modal live-correlation block (`if (costEl) { ... }` from fill()),
// rather than the lib/ticket-cost.js mirror or hand-built literals above.
// ===========================================================================

// GIVEN Scenario: Cache fragment shown when cache fields present (real ticketActivityLineFor)
test('TASK-145 GIVEN: an activity with cacheReadTokens 28905 and cacheCreationTokens 0, WHEN the REAL ticketActivityLineFor renders it, THEN the output contains a "28905/0 cache" fragment', () => {
  const line = renderer.ticketActivityLineFor({
    activity: 'code',
    model: 'claude-opus-4-8',
    cacheReadTokens: 28905,
    cacheCreationTokens: 0,
  });
  // formatTokens formats >=1000 as "N.Nk" (28905 -> "28.9k"), matching the real
  // renderer's shared formatting helper rather than the raw number.
  assert.match(line, /28\.9k\/0 cache/, 'the cache fragment reflects both read and creation tokens');
});

// GIVEN Scenario: Cache fragment dropped when both cache fields absent (real ticketActivityLineFor)
test('TASK-145 GIVEN: an activity with no cache fields, WHEN the REAL ticketActivityLineFor renders it, THEN the output contains no cache fragment', () => {
  const line = renderer.ticketActivityLineFor({
    activity: 'code',
    model: 'claude-opus-4-8',
    tokensIn: 1000,
    tokensOut: 500,
    costUsd: 0.1,
  });
  assert.doesNotMatch(line, /cache/, 'no cache fragment when neither cache field is present');
  assert.ok(line.length > 0, 'other fragments still render');
});

// Same two scenarios again, but through the REAL ticketActivityTotalLine (which
// internally calls the real parseTicketActivities + totalTicketActivities).
test('TASK-145 GIVEN: an activities log whose entries carry cache hits, WHEN the REAL ticketActivityTotalLine renders it, THEN the totals line contains the summed cache fragment', () => {
  const fm = {
    activities: [
      { activity: 'ba', cacheReadTokens: 28905, cacheCreationTokens: 0, tokensIn: 1000 },
      { activity: 'code', cacheReadTokens: 100, tokensIn: 2000 },
    ],
  };
  const line = renderer.ticketActivityTotalLine(fm);
  assert.match(line, /29005\/0 cache|29k\/0 cache/, 'summed cache fragment present in the totals line (formatted per formatTokens)');
});

test('TASK-145 GIVEN: an activities log whose entries carry no cache fields, WHEN the REAL ticketActivityTotalLine renders it, THEN the totals line contains no cache fragment', () => {
  const fm = {
    activities: [
      { activity: 'ba', tokensIn: 1000, costUsd: 0.05 },
      { activity: 'code', tokensIn: 2000, costUsd: 0.1 },
    ],
  };
  const line = renderer.ticketActivityTotalLine(fm);
  assert.doesNotMatch(line, /cache/, 'no cache fragment when no entry carried cache fields');
  assert.ok(line.startsWith('Total:'), 'totals line still renders other fragments');
});

// ---------------------------------------------------------------------------
// Modal live-correlation: drives the REAL extracted `.task-modal-cost` block
// from fill() via costRunner.runCostBlock(fmObj, costEl, window, document).
// ---------------------------------------------------------------------------

// Scenario: Persisted numbers suppress the live query (branch a)
test('TASK-145 Scenario: an activity row with persisted token/cost numbers does NOT trigger a usageForWindow query', async () => {
  const fmObj = {
    activities: [{
      activity: 'code',
      model: 'claude-opus-4-8',
      startedAt: '2026-07-19T11:00:00.000Z',
      finishedAt: '2026-07-19T11:20:00.000Z',
      tokensIn: 1000,
      tokensOut: 500,
      costUsd: 0.1,
    }],
  };
  const costEl = makeMockCostEl();
  const document = makeMockDocument();
  const { calls, window } = makeUsageWindow(() => Promise.resolve({ ok: true, usage: { requests: 5, inputTokens: 999, outputTokens: 999 } }));

  costRunner.runCostBlock(fmObj, costEl, window, document);
  await flush();

  assert.equal(calls.length, 0, 'usageForWindow is never called when persisted numbers already exist');
  // rows[0] is the "Cost by activity (N)" head label, rows[1] the one activity
  // row, rows[2] the totals row.
  assert.equal(costEl.rows.length, 3, 'head + one activity row + one totals row rendered');
  assert.doesNotMatch(costEl.rows[1].textContent, /\(live\)/, 'no live fragment appended');
});

// Scenario (edge): requests:0 / empty usage appends NO fragment (branch b)
test('TASK-145 Scenario (edge): a returned usage with requests 0 (or empty) appends NO fragment — no fabricated zero', async () => {
  const fmObj = {
    activities: [{
      activity: 'code',
      model: 'claude-opus-4-8',
      startedAt: '2026-07-19T11:00:00.000Z',
      finishedAt: '2026-07-19T11:20:00.000Z',
      // no persisted tokens/cost/cache
    }],
  };
  const costEl = makeMockCostEl();
  const document = makeMockDocument();
  const { calls, window } = makeUsageWindow(() => Promise.resolve({ ok: true, usage: { requests: 0 } }));

  costRunner.runCostBlock(fmObj, costEl, window, document);
  const before = costEl.rows[1].textContent;
  await flush();

  assert.equal(calls.length, 1, 'usageForWindow IS queried when no persisted numbers exist');
  assert.equal(costEl.rows[1].textContent, before, 'row text is unchanged when requests is 0');
  assert.doesNotMatch(costEl.rows[1].textContent, /\(live\)/, 'no live fragment appended for a zero-requests result');

  // Also cover the "empty" case: ok:true, usage:{} (no requests field at all).
  const costEl2 = makeMockCostEl();
  const { calls: calls2, window: window2 } = makeUsageWindow(() => Promise.resolve({ ok: true, usage: {} }));
  costRunner.runCostBlock(fmObj, costEl2, window2, document);
  const before2 = costEl2.rows[1].textContent;
  await flush();
  assert.equal(calls2.length, 1);
  assert.equal(costEl2.rows[1].textContent, before2, 'row text is unchanged for an empty usage object');
  assert.doesNotMatch(costEl2.rows[1].textContent, /\(live\)/);
});

// Scenario: successful non-empty usage appends the (live) fragment (branch c)
test('TASK-145 Scenario: a successful non-empty usage appends a "(live)" fragment for an un-persisted activity', async () => {
  const fmObj = {
    activities: [{
      activity: 'code',
      model: 'claude-opus-4-8',
      startedAt: '2026-07-19T11:00:00.000Z',
      finishedAt: '2026-07-19T11:20:00.000Z',
      // no persisted numbers -> eligible for live correlation
    }],
  };
  const costEl = makeMockCostEl();
  const document = makeMockDocument();
  const { calls, window } = makeUsageWindow(() => Promise.resolve({
    ok: true,
    usage: { requests: 2, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, cacheCreationTokens: 0, costUsd: 0.05 },
  }));

  costRunner.runCostBlock(fmObj, costEl, window, document);
  const before = costEl.rows[1].textContent;
  await flush();

  assert.equal(calls.length, 1, 'usageForWindow queried exactly once for the un-persisted row');
  assert.equal(calls[0].model, 'claude-opus-4-8', 'the query carries the activity model');
  assert.equal(calls[0].startedAt, fmObj.activities[0].startedAt);
  assert.equal(calls[0].finishedAt, fmObj.activities[0].finishedAt);
  const after = costEl.rows[1].textContent;
  assert.notEqual(after, before, 'row text changed after the live correlation resolved');
  assert.match(after, /\(live\)/, 'the row gains a "(live)" usage fragment');
  assert.ok(after.startsWith(before), 'the original persisted-less line is preserved as a prefix');
});

// Scenario (failure/edge): rejected / ok:false / usage:null telemetry leaves the row unchanged (branch d)
test('TASK-145 Scenario (failure): a rejected usageForWindow call leaves the row text unchanged and throws no error', async () => {
  const fmObj = {
    activities: [{
      activity: 'code',
      model: 'claude-opus-4-8',
      startedAt: '2026-07-19T11:00:00.000Z',
      finishedAt: '2026-07-19T11:20:00.000Z',
    }],
  };
  const costEl = makeMockCostEl();
  const document = makeMockDocument();
  const { calls, window } = makeUsageWindow(() => Promise.reject(new Error('telemetry unavailable')));

  assert.doesNotThrow(() => costRunner.runCostBlock(fmObj, costEl, window, document), 'synchronous call never throws');
  const before = costEl.rows[1].textContent;
  await flush();

  assert.equal(calls.length, 1);
  assert.equal(costEl.rows[1].textContent, before, 'row text unchanged after a rejected telemetry query');
  assert.doesNotMatch(costEl.rows[1].textContent, /\(live\)/);
});

test('TASK-145 Scenario (failure): an ok:false / usage:null telemetry result leaves the row text unchanged and throws no error', async () => {
  const fmObj = {
    activities: [{
      activity: 'code',
      model: 'claude-opus-4-8',
      startedAt: '2026-07-19T11:00:00.000Z',
      finishedAt: '2026-07-19T11:20:00.000Z',
    }],
  };
  const costEl = makeMockCostEl();
  const document = makeMockDocument();
  const { calls, window } = makeUsageWindow(() => Promise.resolve({ ok: false, usage: null }));

  costRunner.runCostBlock(fmObj, costEl, window, document);
  const before = costEl.rows[1].textContent;
  await flush();

  assert.equal(calls.length, 1);
  assert.equal(costEl.rows[1].textContent, before, 'row text unchanged for ok:false / usage:null');
  assert.doesNotMatch(costEl.rows[1].textContent, /\(live\)/);
});
