'use strict';

// ===========================================================================
// Unit tests for the Stats tab's per-prompt log.
//
// Two halves, both pure (no Electron, no HTTP, no disk writes):
//
//   1. renderer/renderer.js's display helpers (telUpTokens / telDownTokens /
//      telShortModel / telFmtTime / telRowTitle / telNum), loaded out of the
//      renderer source into an isolated Function scope — the repo's standard
//      way to unit-test browser-script functions (see
//      test/task-157-stats-per-project.e2e.test.js).
//   2. lib/telemetry-receiver.js's snapshotState, which now carries
//      `projectRecent` so the log can render live off ONE pushed payload.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTelemetryReceiver } = require('../lib/telemetry-receiver');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');

// Brace-matching function extractor (repo convention).
function extractFn(src, name) {
  let start = src.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, `function ${name} present in renderer.js`);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) { i += 1; break; } }
  }
  return src.slice(start, i);
}

function loadLogHelpers() {
  const body = [
    extractFn(rendererSrc, 'telFmtInt'),
    extractFn(rendererSrc, 'telFmtUsd'),
    extractFn(rendererSrc, 'telNum'),
    extractFn(rendererSrc, 'telUpTokens'),
    extractFn(rendererSrc, 'telDownTokens'),
    extractFn(rendererSrc, 'telShortModel'),
    extractFn(rendererSrc, 'telFmtTime'),
    extractFn(rendererSrc, 'telRowTitle'),
    'return { telFmtInt, telFmtUsd, telNum, telUpTokens, telDownTokens, telShortModel, telFmtTime, telRowTitle };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(body)();
}

const H = loadLogHelpers();

// ---------------------------------------------------------------------------
// Up / down token derivation
// ---------------------------------------------------------------------------

test('Unit: telUpTokens sums input + cache write + cache read', () => {
  assert.equal(H.telUpTokens({
    inputTokens: 30, cacheCreationTokens: 1024, cacheReadTokens: 28905, outputTokens: 222,
  }), 30 + 1024 + 28905, 'up-traffic is everything sent to the model, cached context included');
});

test('Unit: telUpTokens counts a cache-only prompt as its full context, not just fresh input', () => {
  // The regression this guards: dropping cacheReadTokens would report a 29k
  // cached prompt as "30 tokens up".
  const row = { inputTokens: 30, cacheCreationTokens: 0, cacheReadTokens: 28905, outputTokens: 222 };
  assert.equal(H.telUpTokens(row), 28935);
  assert.notEqual(H.telUpTokens(row), 30, 'cache reads are NOT excluded from up-traffic');
});

test('Unit: telDownTokens is the output tokens only', () => {
  assert.equal(H.telDownTokens({
    inputTokens: 30, cacheCreationTokens: 9, cacheReadTokens: 99, outputTokens: 222,
  }), 222, 'down-traffic is what came back, nothing else');
});

test('Unit: up/down helpers never throw and coerce junk to 0', () => {
  for (const junk of [null, undefined, {}, { inputTokens: 'x', outputTokens: null }, 0, 'nope']) {
    assert.equal(H.telUpTokens(junk), 0, 'telUpTokens(' + JSON.stringify(junk) + ') === 0');
    assert.equal(H.telDownTokens(junk), 0, 'telDownTokens(' + JSON.stringify(junk) + ') === 0');
  }
  assert.equal(H.telUpTokens({ inputTokens: NaN, cacheReadTokens: 5 }), 5, 'a NaN field contributes 0, siblings still count');
});

// ---------------------------------------------------------------------------
// Model label
// ---------------------------------------------------------------------------

test('Unit: telShortModel drops the claude- prefix and the trailing date', () => {
  assert.equal(H.telShortModel('claude-haiku-4-5-20251001'), 'haiku-4-5');
  assert.equal(H.telShortModel('claude-sonnet-5'), 'sonnet-5');
  assert.equal(H.telShortModel('claude-opus-4-1-20250805'), 'opus-4-1');
});

test('Unit: telShortModel leaves unrecognized ids alone and labels an empty model', () => {
  assert.equal(H.telShortModel('some-other-model'), 'some-other-model');
  assert.equal(H.telShortModel('  claude-haiku-4-5  '), 'haiku-4-5', 'trims before stripping');
  assert.equal(H.telShortModel(''), '(unknown)');
  assert.equal(H.telShortModel(null), '(unknown)');
  assert.equal(H.telShortModel(undefined), '(unknown)');
});

// ---------------------------------------------------------------------------
// Timestamp
// ---------------------------------------------------------------------------

test('Unit: telFmtTime renders zero-padded local HH:MM:SS', () => {
  const iso = '2026-07-26T04:05:06.000Z';
  const d = new Date(iso);
  const p = (n) => (n < 10 ? '0' + n : String(n));
  const expected = p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  assert.equal(H.telFmtTime(iso), expected, 'matches the local-time rendering of the same instant');
  assert.match(H.telFmtTime(iso), /^\d{2}:\d{2}:\d{2}$/, 'always two-digit fields');
});

test('Unit: telFmtTime renders an em dash for a missing/unparseable timestamp', () => {
  assert.equal(H.telFmtTime(''), '—');
  assert.equal(H.telFmtTime(null), '—');
  assert.equal(H.telFmtTime(undefined), '—');
  assert.equal(H.telFmtTime('not a date'), '—');
});

// ---------------------------------------------------------------------------
// Row tooltip
// ---------------------------------------------------------------------------

test('Unit: telRowTitle spells out the full per-call breakdown', () => {
  const title = H.telRowTitle({
    model: 'claude-haiku-4-5-20251001',
    inputTokens: 30,
    cacheCreationTokens: 1024,
    cacheReadTokens: 28905,
    outputTokens: 222,
    costUsd: 0.0098,
  });
  assert.match(title, /model claude-haiku-4-5-20251001/, 'keeps the FULL model id (the row shows the short one)');
  assert.match(title, /input 30/);
  assert.match(title, /cache write 1024/);
  assert.match(title, /cache read 28905/);
  assert.match(title, /output 222/);
  assert.match(title, /up 29959/, 'up total is in the tooltip');
  assert.match(title, /down 222/, 'down total is in the tooltip');
  assert.match(title, /cost \$0\.0098/);
});

test('Unit: telRowTitle never throws on an empty row', () => {
  const title = H.telRowTitle({});
  assert.match(title, /model \(unknown\)/);
  assert.match(title, /up 0/);
  assert.match(title, /cost \$0\.00/);
  assert.equal(typeof H.telRowTitle(null), 'string', 'a null row still yields a string');
});

// ---------------------------------------------------------------------------
// Receiver: snapshotState carries the project's per-call rows
// ---------------------------------------------------------------------------

function logsPayload(requestId, project, over) {
  const o = over || {};
  const rl = {
    scopeLogs: [{
      logRecords: [{
        body: { stringValue: 'claude_code.api_request' },
        attributes: [
          { key: 'session.id', value: { stringValue: 's1' } },
          { key: 'event.name', value: { stringValue: 'api_request' } },
          { key: 'model', value: { stringValue: o.model || 'claude-haiku-4-5-20251001' } },
          { key: 'input_tokens', value: { intValue: o.inputTokens == null ? 10 : o.inputTokens } },
          { key: 'output_tokens', value: { intValue: o.outputTokens == null ? 20 : o.outputTokens } },
          { key: 'cache_read_tokens', value: { intValue: o.cacheReadTokens == null ? 100 : o.cacheReadTokens } },
          { key: 'cache_creation_tokens', value: { intValue: o.cacheCreationTokens == null ? 5 : o.cacheCreationTokens } },
          { key: 'cost_usd', value: { doubleValue: o.costUsd == null ? 0.01 : o.costUsd } },
          { key: 'duration_ms', value: { intValue: 1000 } },
          { key: 'request_id', value: { stringValue: requestId } },
        ],
      }],
    }],
  };
  if (project) {
    rl.resource = { attributes: [{ key: 'project', value: { stringValue: project } }] };
  }
  return { resourceLogs: [rl] };
}

test('Unit: snapshotState includes projectRecent for the named project only', () => {
  const rec = createTelemetryReceiver({ config: { enabled: true } });
  rec.ingestLogs(logsPayload('req_a1', 'alpha', { model: 'claude-sonnet-5', outputTokens: 7 }));
  rec.ingestLogs(logsPayload('req_a2', 'alpha'));
  rec.ingestLogs(logsPayload('req_b1', 'beta'));

  const snapA = rec.snapshotState('alpha');
  assert.ok(Array.isArray(snapA.projectRecent), 'projectRecent is an array');
  assert.equal(snapA.projectRecent.length, 2, "alpha's two calls only");
  assert.equal(snapA.projectRecent[0].model, 'claude-sonnet-5', 'rows are append-ordered (oldest first)');
  assert.equal(snapA.projectRecent[0].outputTokens, 7, 'rows carry the per-call token counts the log renders');
  assert.equal(snapA.projectRecent[1].requestId, 'req_a2');

  const snapB = rec.snapshotState('beta');
  assert.equal(snapB.projectRecent.length, 1, "beta sees only its own call");
  assert.equal(snapB.projectRecent[0].requestId, 'req_b1');
});

test('Unit: snapshotState projectRecent rows carry every field the prompt log needs', () => {
  const rec = createTelemetryReceiver({ config: { enabled: true } });
  rec.ingestLogs(logsPayload('req_full', 'alpha', {
    inputTokens: 30, outputTokens: 222, cacheReadTokens: 28905, cacheCreationTokens: 1024, costUsd: 0.0098,
  }));
  const row = rec.snapshotState('alpha').projectRecent[0];
  for (const k of ['model', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'costUsd', 'timestamp']) {
    assert.ok(k in row, `row carries ${k}`);
  }
  assert.equal(row.inputTokens, 30);
  assert.equal(row.outputTokens, 222);
  assert.equal(row.cacheReadTokens, 28905);
  assert.equal(row.cacheCreationTokens, 1024);
  assert.equal(row.costUsd, 0.0098);
});

test('Unit: snapshotState projectRecent is an empty array for an unknown project', () => {
  const rec = createTelemetryReceiver({ config: { enabled: true } });
  rec.ingestLogs(logsPayload('req_a1', 'alpha'));
  const snap = rec.snapshotState('never-seen');
  assert.deepEqual(snap.projectRecent, [], 'no bucket → [] rather than undefined or a throw');
});

test('Unit: snapshotState projectRecent is capped at the last 100 rows', () => {
  const rec = createTelemetryReceiver({ config: { enabled: true } });
  for (let i = 0; i < 130; i++) rec.ingestLogs(logsPayload('req_' + i, 'alpha'));
  const rows = rec.snapshotState('alpha').projectRecent;
  assert.equal(rows.length, 100, 'capped like getUsage()/getUsageForProject()');
  assert.equal(rows[99].requestId, 'req_129', 'keeps the NEWEST rows');
  assert.equal(rows[0].requestId, 'req_30', 'drops the oldest');
});

test('Unit: the pushed onUpdate payload carries projectRecent for the ingested project', () => {
  let last = null;
  const rec = createTelemetryReceiver({ config: { enabled: true }, onUpdate: (s) => { last = s; } });
  rec.ingestLogs(logsPayload('req_a1', 'alpha', { costUsd: 0.05 }));
  assert.ok(last, 'onUpdate fired');
  assert.equal(last.project, 'alpha');
  assert.equal(last.projectRecent.length, 1, 'the live payload alone is enough to render the log');
  assert.equal(last.projectRecent[0].costUsd, 0.05);
});

test('Unit: snapshotState still carries its pre-existing fields (the projectRecent addition is additive)', () => {
  const rec = createTelemetryReceiver({ config: { enabled: true } });
  rec.ingestLogs(logsPayload('req_a1', 'alpha'));
  const snap = rec.snapshotState('alpha');
  for (const k of ['usage', 'metricTotals', 'running', 'project', 'projectUsage']) {
    assert.ok(k in snap, `snapshotState still exposes ${k}`);
  }
  assert.equal(snap.projectUsage.totals.requests, 1);
});
