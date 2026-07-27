'use strict';

// Unit tests for lib/telemetry.js — the pure OTLP/JSON usage model behind the
// app's Claude Code token/cost telemetry feature. Fixtures mirror the EXACT shapes
// `claude` 2.1.212 emits over OTLP/JSON (verified empirically): a
// claude_code.api_request log record and cumulative claude_code.token.usage /
// claude_code.cost.usage metric sums. No Electron / network / disk.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const t = require('../lib/telemetry');

// --- Real-shape fixtures ----------------------------------------------------

function apiRequestLogs(overrides = {}) {
  const a = Object.assign({
    request_id: 'req_011CdQ2C72qTDbHEP312VUmA',
    session_id: '3a1196c2-b0d8-4ae9-be1b-5e49e48f9a30',
    model: 'claude-haiku-4-5-20251001',
    input_tokens: 10,
    output_tokens: 74,
    cache_read_tokens: 28905,
    cache_creation_tokens: 0,
    cost_usd: 0.0032705,
    duration_ms: 1543,
    query_source: 'sdk',
    timestamp: '2026-07-26T04:15:48.794Z',
  }, overrides);
  return {
    resourceLogs: [{
      resource: { attributes: [] },
      scopeLogs: [{
        scope: { name: 'com.anthropic.claude_code.events' },
        logRecords: [{
          body: { stringValue: 'claude_code.api_request' },
          attributes: [
            { key: 'session.id', value: { stringValue: a.session_id } },
            { key: 'event.name', value: { stringValue: 'api_request' } },
            { key: 'event.timestamp', value: { stringValue: a.timestamp } },
            { key: 'model', value: { stringValue: a.model } },
            // OTLP/JSON encodes int64 as a STRING sometimes and a number others —
            // exercise both to prove the coercion.
            { key: 'input_tokens', value: { intValue: a.input_tokens } },
            { key: 'output_tokens', value: { intValue: String(a.output_tokens) } },
            { key: 'cache_read_tokens', value: { intValue: a.cache_read_tokens } },
            { key: 'cache_creation_tokens', value: { intValue: a.cache_creation_tokens } },
            { key: 'cost_usd', value: { doubleValue: a.cost_usd } },
            { key: 'duration_ms', value: { intValue: a.duration_ms } },
            { key: 'request_id', value: { stringValue: a.request_id } },
            { key: 'query_source', value: { stringValue: a.query_source } },
          ],
        }, {
          // A non-api_request record that MUST be ignored.
          body: { stringValue: 'claude_code.user_prompt' },
          attributes: [{ key: 'event.name', value: { stringValue: 'user_prompt' } }],
        }],
      }],
    }],
  };
}

function usageMetrics() {
  const dp = (extra, value) => ({
    attributes: [
      { key: 'session.id', value: { stringValue: 's1' } },
      { key: 'model', value: { stringValue: 'claude-haiku-4-5-20251001' } },
      ...extra,
    ],
    asDouble: value,
  });
  return {
    resourceMetrics: [{
      resource: { attributes: [] },
      scopeMetrics: [{
        metrics: [
          { name: 'claude_code.cost.usage', unit: 'USD', sum: { isMonotonic: true, aggregationTemporality: 1, dataPoints: [dp([], 0.0032705)] } },
          { name: 'claude_code.token.usage', unit: 'tokens', sum: { isMonotonic: true, aggregationTemporality: 1, dataPoints: [
            dp([{ key: 'type', value: { stringValue: 'input' } }], 10),
            dp([{ key: 'type', value: { stringValue: 'output' } }], 74),
            dp([{ key: 'type', value: { stringValue: 'cacheRead' } }], 28905),
            dp([{ key: 'type', value: { stringValue: 'cacheCreation' } }], 0),
          ] } },
          { name: 'claude_code.session.count', sum: { dataPoints: [dp([], 1)] } },
        ],
      }],
    }],
  };
}

// --- isHttpUrl --------------------------------------------------------------

test('isHttpUrl accepts http/https and rejects everything else', () => {
  assert.ok(t.isHttpUrl('http://127.0.0.1:4318'));
  assert.ok(t.isHttpUrl('https://collector.example.com/ingest'));
  assert.ok(!t.isHttpUrl('ftp://x'));
  assert.ok(!t.isHttpUrl('file:///etc/passwd'));
  assert.ok(!t.isHttpUrl('not a url'));
  assert.ok(!t.isHttpUrl(''));
  assert.ok(!t.isHttpUrl(null));
});

// --- normalizeTelemetryConfig ----------------------------------------------

test('normalizeTelemetryConfig returns a complete config from junk and never throws', () => {
  for (const junk of [null, undefined, 42, 'x', [], NaN]) {
    const c = t.normalizeTelemetryConfig(junk);
    assert.equal(c.enabled, false);
    assert.equal(c.forwardUrl, '');
    assert.equal(c.forwardEnabled, false);
    assert.ok(c.metricIntervalMs >= 1000 && c.logsIntervalMs >= 1000);
    assert.ok(Array.isArray(c.warnings));
  }
});

test('normalizeTelemetryConfig keeps a valid forward URL and drops an invalid one', () => {
  const ok = t.normalizeTelemetryConfig({ enabled: true, forwardUrl: 'https://x.example/telemetry', forwardEnabled: true, forwardToken: 'abc' });
  assert.equal(ok.enabled, true);
  assert.equal(ok.forwardUrl, 'https://x.example/telemetry');
  assert.equal(ok.forwardEnabled, true);
  assert.equal(ok.forwardToken, 'abc');

  const bad = t.normalizeTelemetryConfig({ enabled: true, forwardUrl: 'notaurl', forwardEnabled: true });
  assert.equal(bad.forwardUrl, '');
  assert.equal(bad.forwardEnabled, false, 'forwarding cannot be on without a valid URL');
  assert.ok(bad.warnings.some((w) => /forwardUrl/.test(w)));
});

test('normalizeTelemetryConfig clamps sub-second intervals and bad ports', () => {
  const c = t.normalizeTelemetryConfig({ metricIntervalMs: 5, logsIntervalMs: 0, port: 99999 });
  assert.equal(c.metricIntervalMs, t.DEFAULT_METRIC_INTERVAL_MS);
  assert.equal(c.logsIntervalMs, t.DEFAULT_LOGS_INTERVAL_MS);
  assert.equal(c.port, t.DEFAULT_PORT);
  assert.ok(c.warnings.some((w) => /port/.test(w)));
});

// --- buildOtelEnv -----------------------------------------------------------

test('buildOtelEnv returns {} when disabled', () => {
  assert.deepEqual(t.buildOtelEnv({ enabled: false }, 'http://127.0.0.1:4318'), {});
});

test('buildOtelEnv returns {} for a non-http endpoint even when enabled', () => {
  assert.deepEqual(t.buildOtelEnv({ enabled: true }, 'ftp://x'), {});
  assert.deepEqual(t.buildOtelEnv({ enabled: true }, ''), {});
});

test('buildOtelEnv sets the verified OTLP/JSON env vars pointing at the receiver', () => {
  const env = t.buildOtelEnv({ enabled: true, metricIntervalMs: 8000, logsIntervalMs: 3000, serviceName: 'svc' }, 'http://127.0.0.1:41999');
  assert.equal(env.CLAUDE_CODE_ENABLE_TELEMETRY, '1');
  assert.equal(env.OTEL_METRICS_EXPORTER, 'otlp');
  assert.equal(env.OTEL_LOGS_EXPORTER, 'otlp');
  assert.equal(env.OTEL_EXPORTER_OTLP_PROTOCOL, 'http/json');
  assert.equal(env.OTEL_EXPORTER_OTLP_ENDPOINT, 'http://127.0.0.1:41999');
  assert.equal(env.OTEL_METRIC_EXPORT_INTERVAL, '8000');
  assert.equal(env.OTEL_LOGS_EXPORT_INTERVAL, '3000');
  assert.equal(env.OTEL_SERVICE_NAME, 'svc');
});

// --- extractApiRequests -----------------------------------------------------

test('extractApiRequests pulls the per-call row and ignores non-api_request records', () => {
  const rows = t.extractApiRequests(apiRequestLogs());
  assert.equal(rows.length, 1, 'only the api_request record is returned');
  const r = rows[0];
  assert.equal(r.requestId, 'req_011CdQ2C72qTDbHEP312VUmA');
  assert.equal(r.model, 'claude-haiku-4-5-20251001');
  assert.equal(r.inputTokens, 10);
  assert.equal(r.outputTokens, 74, 'string intValue coerced to number');
  assert.equal(r.cacheReadTokens, 28905);
  assert.equal(r.cacheCreationTokens, 0);
  assert.equal(r.costUsd, 0.0032705);
  assert.equal(r.durationMs, 1543);
  assert.equal(r.sessionId, '3a1196c2-b0d8-4ae9-be1b-5e49e48f9a30');
});

test('extractApiRequests tolerates junk and returns []', () => {
  for (const junk of [null, {}, { resourceLogs: 'x' }, { resourceLogs: [null] }, 5, []]) {
    assert.deepEqual(t.extractApiRequests(junk), []);
  }
});

// --- extractMetricSnapshot --------------------------------------------------

test('extractMetricSnapshot keys cost by session|model and tokens by session|model|type', () => {
  const snap = t.extractMetricSnapshot(usageMetrics());
  assert.equal(snap.cost['s1|claude-haiku-4-5-20251001'], 0.0032705);
  assert.equal(snap.tokens['s1|claude-haiku-4-5-20251001|input'], 10);
  assert.equal(snap.tokens['s1|claude-haiku-4-5-20251001|output'], 74);
  assert.equal(snap.tokens['s1|claude-haiku-4-5-20251001|cacheRead'], 28905);
  assert.equal(snap.tokens['s1|claude-haiku-4-5-20251001|cacheCreation'], 0);
});

test('extractMetricSnapshot tolerates junk', () => {
  const snap = t.extractMetricSnapshot(null);
  assert.deepEqual(snap.cost, {});
  assert.deepEqual(snap.tokens, {});
});

// --- aggregateUsage ---------------------------------------------------------

test('aggregateUsage totals rows and breaks down by model, never NaN', () => {
  const rows = [
    { model: 'a', inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheCreationTokens: 0, costUsd: 0.01, durationMs: 500 },
    { model: 'a', inputTokens: 2, outputTokens: 3, cacheReadTokens: 0, cacheCreationTokens: 7, costUsd: 0.02, durationMs: 250 },
    { model: 'b', inputTokens: 1, outputTokens: 1, costUsd: 0.03 },
    'junk', null, {},
  ];
  const agg = t.aggregateUsage(rows);
  assert.equal(agg.totals.requests, 4); // 3 valid rows + the empty {} row
  assert.equal(agg.totals.inputTokens, 13);
  assert.equal(agg.totals.outputTokens, 9);
  assert.equal(agg.totals.cacheReadTokens, 100);
  assert.equal(agg.totals.cacheCreationTokens, 7);
  assert.equal(agg.totals.totalTokens, 129);
  assert.ok(Math.abs(agg.totals.costUsd - 0.06) < 1e-9);
  assert.equal(agg.totals.durationMs, 750);
  assert.equal(agg.byModel.a.requests, 2);
  assert.equal(agg.byModel.b.requests, 1);
  assert.deepEqual(agg.models, ['(unknown)', 'a', 'b']);
});

test('aggregateUsage of [] is a clean zero snapshot', () => {
  const agg = t.aggregateUsage([]);
  assert.equal(agg.totals.requests, 0);
  assert.equal(agg.totals.totalTokens, 0);
  assert.equal(agg.totals.costUsd, 0);
  assert.deepEqual(agg.models, []);
});

// --- requestKey (dedup) -----------------------------------------------------

test('requestKey uses request_id when present, composite otherwise', () => {
  assert.equal(t.requestKey({ requestId: 'req_1' }), 'req_1');
  const a = t.requestKey({ sessionId: 's', timestamp: 'ts', inputTokens: 1, outputTokens: 2, costUsd: 0.5 });
  const b = t.requestKey({ sessionId: 's', timestamp: 'ts', inputTokens: 1, outputTokens: 2, costUsd: 0.5 });
  assert.equal(a, b, 'same call → same composite key');
  assert.notEqual(a, t.requestKey({ sessionId: 's', timestamp: 'ts2', inputTokens: 1, outputTokens: 2, costUsd: 0.5 }));
  assert.equal(t.requestKey(null), '');
});

// --- buildForwardPayload ----------------------------------------------------

test('buildForwardPayload wraps aggregated usage in the app schema', () => {
  const rows = t.extractApiRequests(apiRequestLogs());
  const usage = t.aggregateUsage(rows);
  const payload = t.buildForwardPayload({
    usage, recent: rows, generatedAt: '2026-07-26T00:00:00Z', host: 'PC',
    sessionId: 'sess-123', username: 'steve', project: 'claude-cmd-ui2',
  });
  assert.equal(payload.source, 'claude-cmd-ui');
  assert.equal(payload.schema, 'telemetry.usage.v1');
  assert.equal(payload.generatedAt, '2026-07-26T00:00:00Z');
  assert.equal(payload.host, 'PC');
  assert.equal(payload.sessionId, 'sess-123');
  assert.equal(payload.username, 'steve');
  assert.equal(payload.project, 'claude-cmd-ui2');
  assert.equal(payload.totals.requests, 1);
  assert.equal(payload.totals.costUsd, 0.0032705);
  assert.ok(payload.byModel['claude-haiku-4-5-20251001']);
  assert.equal(payload.recent.length, 1);
});

test('buildForwardPayload carries sessionId/username/project as safe strings, defaulting to ""', () => {
  // Present but non-string identity fields collapse to a coerced/trimmed string.
  const coerced = t.buildForwardPayload({ sessionId: 42, username: '  steve  ', project: null });
  assert.equal(coerced.sessionId, '42');
  assert.equal(coerced.username, 'steve', 'trimmed');
  assert.equal(coerced.project, '', 'null → ""');
  // Absent entirely → '' (never undefined), so the online store always sees the keys.
  const absent = t.buildForwardPayload({});
  assert.equal(absent.sessionId, '');
  assert.equal(absent.username, '');
  assert.equal(absent.project, '');
});

test('buildForwardPayload caps recent and tolerates missing usage', () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ model: 'm', costUsd: i }));
  const payload = t.buildForwardPayload({ recent: many, recentLimit: 5 });
  assert.equal(payload.recent.length, 5);
  assert.equal(payload.totals.requests, 0, 'missing usage → zero totals, no throw');
});

// --- usageForWindow (TASK-142) — per-ticket cost correlation ---------------

test('usageForWindow: correlates rows by time window [startedAt, finishedAt] inclusive', () => {
  const rows = [
    { timestamp: '2026-07-26T04:15:00Z', model: 'm1', inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheCreationTokens: 0, costUsd: 0.01 },
    { timestamp: '2026-07-26T04:16:00Z', model: 'm1', inputTokens: 20, outputTokens: 10, cacheReadTokens: 200, cacheCreationTokens: 5, costUsd: 0.02 },
    { timestamp: '2026-07-26T05:00:00Z', model: 'm1', inputTokens: 1, outputTokens: 1, costUsd: 0.05 }, // outside window
  ];
  const usage = t.usageForWindow(rows, { startedAt: '2026-07-26T04:14:00Z', finishedAt: '2026-07-26T04:20:00Z' });
  assert.equal(usage.requests, 2, 'only rows within [14:00, 20:00]');
  assert.equal(usage.inputTokens, 30);
  assert.equal(usage.outputTokens, 15);
  assert.equal(usage.cacheReadTokens, 300);
  assert.equal(usage.cacheCreationTokens, 5);
  assert.equal(usage.totalTokens, 350);
  assert.ok(Math.abs(usage.costUsd - 0.03) < 1e-9);
});

test('usageForWindow: totalTokens = input + output + cacheRead + cacheCreation', () => {
  const rows = [
    { timestamp: '2026-07-26T04:15:00Z', inputTokens: 10, outputTokens: 20, cacheReadTokens: 5, cacheCreationTokens: 3 },
  ];
  const usage = t.usageForWindow(rows, { startedAt: '2026-07-26T04:00:00Z', finishedAt: '2026-07-26T05:00:00Z' });
  assert.equal(usage.totalTokens, 38, '10 + 20 + 5 + 3');
});

test('usageForWindow: model acts as a tie-breaker only when present on BOTH sides', () => {
  const rows = [
    { timestamp: '2026-07-26T04:15:00Z', model: 'claude-sonnet', inputTokens: 10, outputTokens: 5 },
    { timestamp: '2026-07-26T04:16:00Z', model: 'claude-haiku', inputTokens: 20, outputTokens: 10 },
    { timestamp: '2026-07-26T04:17:00Z', model: '', inputTokens: 5, outputTokens: 2 }, // empty model
  ];
  const usage = t.usageForWindow(rows, { startedAt: '2026-07-26T04:00:00Z', finishedAt: '2026-07-26T05:00:00Z', model: 'claude-haiku' });
  assert.equal(usage.requests, 2, 'claude-haiku row + empty-model row included');
  assert.equal(usage.inputTokens, 25, '20 + 5 from haiku + empty');
  assert.equal(usage.outputTokens, 12);
});

test('usageForWindow: empty window.model disables the model filter (time window only)', () => {
  const rows = [
    { timestamp: '2026-07-26T04:15:00Z', model: 'a', inputTokens: 10, outputTokens: 5 },
    { timestamp: '2026-07-26T04:16:00Z', model: 'b', inputTokens: 20, outputTokens: 10 },
  ];
  const usage = t.usageForWindow(rows, { startedAt: '2026-07-26T04:00:00Z', finishedAt: '2026-07-26T05:00:00Z', model: '' });
  assert.equal(usage.requests, 2, 'both rows included; empty model disables filter');
  assert.equal(usage.inputTokens, 30);
});

test('usageForWindow: returns emptyTotals() for null/junk window', () => {
  const rows = [
    { timestamp: '2026-07-26T04:15:00Z', inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
  ];
  for (const win of [null, undefined, 'not a window', 42, []]) {
    const usage = t.usageForWindow(rows, win);
    assert.deepEqual(usage, t.emptyTotals(), `null/junk window → emptyTotals() for ${JSON.stringify(win)}`);
  }
});

test('usageForWindow: returns emptyTotals() when startedAt/finishedAt are missing/invalid/reversed', () => {
  const rows = [
    { timestamp: '2026-07-26T04:15:00Z', inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
  ];
  // Missing startedAt
  let usage = t.usageForWindow(rows, { finishedAt: '2026-07-26T04:20:00Z' });
  assert.deepEqual(usage, t.emptyTotals());
  // Missing finishedAt
  usage = t.usageForWindow(rows, { startedAt: '2026-07-26T04:00:00Z' });
  assert.deepEqual(usage, t.emptyTotals());
  // Invalid startedAt
  usage = t.usageForWindow(rows, { startedAt: 'not-a-date', finishedAt: '2026-07-26T04:20:00Z' });
  assert.deepEqual(usage, t.emptyTotals());
  // Invalid finishedAt
  usage = t.usageForWindow(rows, { startedAt: '2026-07-26T04:00:00Z', finishedAt: 'not-a-date' });
  assert.deepEqual(usage, t.emptyTotals());
  // Reversed: finishedAt before startedAt
  usage = t.usageForWindow(rows, { startedAt: '2026-07-26T04:20:00Z', finishedAt: '2026-07-26T04:00:00Z' });
  assert.deepEqual(usage, t.emptyTotals());
});

test('usageForWindow: skips rows with missing/unparseable timestamp', () => {
  const rows = [
    { timestamp: '2026-07-26T04:15:00Z', inputTokens: 10, outputTokens: 5 },
    { timestamp: 'not-a-date', inputTokens: 20, outputTokens: 10 }, // skipped
    { inputTokens: 30, outputTokens: 15 }, // missing timestamp, skipped
  ];
  const usage = t.usageForWindow(rows, { startedAt: '2026-07-26T04:00:00Z', finishedAt: '2026-07-26T05:00:00Z' });
  assert.equal(usage.requests, 1, 'only the valid timestamp row');
  assert.equal(usage.inputTokens, 10);
  assert.equal(usage.outputTokens, 5);
});

test('usageForWindow: returns emptyTotals() for non-array records', () => {
  for (const bad of [null, undefined, 'x', 42, {}]) {
    const usage = t.usageForWindow(bad, { startedAt: '2026-07-26T04:00:00Z', finishedAt: '2026-07-26T05:00:00Z' });
    assert.deepEqual(usage, t.emptyTotals(), `non-array records → emptyTotals() for ${JSON.stringify(bad)}`);
  }
});

test('usageForWindow: returns emptyTotals() for empty records array', () => {
  const usage = t.usageForWindow([], { startedAt: '2026-07-26T04:00:00Z', finishedAt: '2026-07-26T05:00:00Z' });
  assert.deepEqual(usage, t.emptyTotals());
});

test('usageForWindow: never throws on junk input', () => {
  const badCombos = [
    [null, null],
    [undefined, { startedAt: '2026-07-26T04:00:00Z', finishedAt: '2026-07-26T05:00:00Z' }],
    [[], null],
    ['junk', 'not a window'],
    [{ foo: 'bar' }, { startedAt: 'invalid', finishedAt: 'invalid' }],
  ];
  for (const [records, window] of badCombos) {
    assert.doesNotThrow(() => t.usageForWindow(records, window), `never throws for ${JSON.stringify(records)}, ${JSON.stringify(window)}`);
  }
});

test('usageForWindow: filters junk rows (non-objects) and continues', () => {
  const rows = [
    { timestamp: '2026-07-26T04:15:00Z', inputTokens: 10, outputTokens: 5 },
    null, 'junk', 42,
    { timestamp: '2026-07-26T04:16:00Z', inputTokens: 20, outputTokens: 10 },
  ];
  const usage = t.usageForWindow(rows, { startedAt: '2026-07-26T04:00:00Z', finishedAt: '2026-07-26T05:00:00Z' });
  assert.equal(usage.requests, 2, 'junk rows skipped, valid ones summed');
  assert.equal(usage.inputTokens, 30);
});

test('usageForWindow: timestamp must be >= startedAt AND <= finishedAt (inclusive boundaries)', () => {
  const rows = [
    { timestamp: '2026-07-26T04:14:00Z', inputTokens: 1 }, // before window
    { timestamp: '2026-07-26T04:14:00.001Z', inputTokens: 2 }, // just inside
    { timestamp: '2026-07-26T04:15:00Z', inputTokens: 3 }, // in the middle
    { timestamp: '2026-07-26T04:20:00Z', inputTokens: 4 }, // at the end (inclusive)
    { timestamp: '2026-07-26T04:20:00.001Z', inputTokens: 5 }, // just after
  ];
  const usage = t.usageForWindow(rows, { startedAt: '2026-07-26T04:14:00.001Z', finishedAt: '2026-07-26T04:20:00Z' });
  assert.equal(usage.requests, 3, 'rows at [14:00:00.001Z, 20:00:00Z] inclusive');
  assert.equal(usage.inputTokens, 9, '2 + 3 + 4');
});

// --- usageForWindow: normalized model-family tie-breaker (TASK-146) --------
// The orchestrator persists a short dispatched label ("claude-haiku-4-5") but
// OTEL api_request rows carry the full dated API model string
// ("claude-haiku-4-5-20251001"). The tie-breaker must match on family (the
// dated suffix stripped) rather than requiring byte-for-byte equality.

test('usageForWindow: short label matches full dated telemetry model string (TASK-146)', () => {
  const rows = [
    { timestamp: '2026-07-26T04:15:00Z', model: 'claude-haiku-4-5-20251001', inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
  ];
  const usage = t.usageForWindow(rows, {
    startedAt: '2026-07-26T04:00:00Z',
    finishedAt: '2026-07-26T05:00:00Z',
    model: 'claude-haiku-4-5',
  });
  assert.equal(usage.requests, 1, 'dated model string matches the short label family');
  assert.equal(usage.inputTokens, 10);
  assert.ok(Math.abs(usage.costUsd - 0.01) < 1e-9);
});

test('usageForWindow: also matches when the SHORT label is on the row and the dated string is queried', () => {
  const rows = [
    { timestamp: '2026-07-26T04:15:00Z', model: 'claude-haiku-4-5', inputTokens: 7, outputTokens: 3 },
  ];
  const usage = t.usageForWindow(rows, {
    startedAt: '2026-07-26T04:00:00Z',
    finishedAt: '2026-07-26T05:00:00Z',
    model: 'claude-haiku-4-5-20251001',
  });
  assert.equal(usage.requests, 1);
  assert.equal(usage.inputTokens, 7);
});

test('usageForWindow: genuinely different model families are still excluded (TASK-146)', () => {
  const rows = [
    { timestamp: '2026-07-26T04:15:00Z', model: 'claude-sonnet-4-5-20251001', inputTokens: 10, outputTokens: 5 },
  ];
  const usage = t.usageForWindow(rows, {
    startedAt: '2026-07-26T04:00:00Z',
    finishedAt: '2026-07-26T05:00:00Z',
    model: 'claude-haiku-4-5',
  });
  assert.equal(usage.requests, 0, 'different family (sonnet vs haiku) is excluded despite the dated suffix');
  assert.deepEqual(usage, t.emptyTotals());
});

test('usageForWindow: family match still respects the time window bounds (TASK-146)', () => {
  const rows = [
    { timestamp: '2026-07-26T05:30:00Z', model: 'claude-haiku-4-5-20251001', inputTokens: 10, outputTokens: 5 }, // outside window
  ];
  const usage = t.usageForWindow(rows, {
    startedAt: '2026-07-26T04:00:00Z',
    finishedAt: '2026-07-26T05:00:00Z',
    model: 'claude-haiku-4-5',
  });
  assert.equal(usage.requests, 0, 'matching family but outside the window is still excluded');
});

test('usageForWindow: empty model on either side still disables the filter for dated strings (TASK-146)', () => {
  const rows = [
    { timestamp: '2026-07-26T04:15:00Z', model: 'claude-haiku-4-5-20251001', inputTokens: 10, outputTokens: 5 },
  ];
  // Empty window.model
  let usage = t.usageForWindow(rows, { startedAt: '2026-07-26T04:00:00Z', finishedAt: '2026-07-26T05:00:00Z', model: '' });
  assert.equal(usage.requests, 1, 'empty window.model disables the filter');
  // Empty row model
  const rows2 = [
    { timestamp: '2026-07-26T04:15:00Z', model: '', inputTokens: 10, outputTokens: 5 },
  ];
  usage = t.usageForWindow(rows2, { startedAt: '2026-07-26T04:00:00Z', finishedAt: '2026-07-26T05:00:00Z', model: 'claude-haiku-4-5' });
  assert.equal(usage.requests, 1, 'empty row model disables the filter');
});

test('modelFamily: strips a trailing dated build suffix and never throws on junk', () => {
  assert.equal(t.modelFamily('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
  assert.equal(t.modelFamily('claude-3-5-sonnet-2025-10-01'), 'claude-3-5-sonnet');
  assert.equal(t.modelFamily('claude-haiku-4-5'), 'claude-haiku-4-5', 'no dated suffix → unchanged');
  assert.equal(t.modelFamily(''), '');
  assert.equal(t.modelFamily(null), '');
  assert.equal(t.modelFamily(undefined), '');
  assert.equal(t.modelFamily(42), '42');
});

// --- decodeAttrValue (TASK-152) -----------------------------------------------

test('decodeAttrValue: percent-decodes a valid URL-encoded string', () => {
  assert.equal(t.decodeAttrValue('hello%20world'), 'hello world');
  assert.equal(t.decodeAttrValue('C%3A%5Cprojects%5Calpha'), 'C:\\projects\\alpha');
  assert.equal(t.decodeAttrValue('/home/user/my%20project'), '/home/user/my project');
});

test('decodeAttrValue: returns the string unchanged if decoding succeeds and it is unchanged', () => {
  assert.equal(t.decodeAttrValue('simple_string'), 'simple_string');
  assert.equal(t.decodeAttrValue('no-special-chars'), 'no-special-chars');
});

test('decodeAttrValue: falls back to the raw string on malformed percent-encoding', () => {
  assert.equal(t.decodeAttrValue('100%bad%'), '100%bad%');
  assert.equal(t.decodeAttrValue('%ZZ'), '%ZZ');
  assert.equal(t.decodeAttrValue('unclosed%2'), 'unclosed%2');
});

test('decodeAttrValue: never throws on any input', () => {
  const testCases = ['100%bad%', '%ZZ', 'unclosed%2', '', null, undefined, 42, true, [], {}];
  for (const val of testCases) {
    assert.doesNotThrow(() => {
      t.decodeAttrValue(val);
    }, `decodeAttrValue does not throw for ${JSON.stringify(val)}`);
  }
});

test('decodeAttrValue: coerces to string first (null/undefined → "")', () => {
  assert.equal(t.decodeAttrValue(null), '');
  assert.equal(t.decodeAttrValue(undefined), '');
  assert.equal(t.decodeAttrValue(''), '');
});

// TASK-167: decodeAttrValue must NOT trim — the CLI's OTEL SDK already fully
// decodes the value before we see it, so any leading/trailing whitespace here
// is genuine and must survive to match setProjectForwarding's untrimmed key.
test('decodeAttrValue: does NOT trim the input (whitespace survives decoding)', () => {
  assert.equal(t.decodeAttrValue('  hello%20world  '), '  hello world  ');
  assert.equal(t.decodeAttrValue('  %20  '), '     '); // 2 raw + 1 decoded + 2 raw = 5 spaces
  assert.equal(t.decodeAttrValue(' C:\\projects\\alpha '), ' C:\\projects\\alpha ');
});

// --- resourceProject (TASK-152) -----------------------------------------------

test('resourceProject: reads the project from resource attributes', () => {
  const rl = {
    resource: {
      attributes: [
        { key: 'project', value: { stringValue: 'C:\\projects\\alpha' } },
        { key: 'service.name', value: { stringValue: 'my-service' } },
      ],
    },
  };
  assert.equal(t.resourceProject(rl), 'C:\\projects\\alpha');
});

test('resourceProject: percent-decodes the project value', () => {
  const rl = {
    resource: {
      attributes: [
        { key: 'project', value: { stringValue: 'C%3A%5Cprojects%5Calpha' } },
      ],
    },
  };
  assert.equal(t.resourceProject(rl), 'C:\\projects\\alpha');
});

test('resourceProject: returns "" when project attribute is missing', () => {
  const rl = {
    resource: {
      attributes: [
        { key: 'other_attr', value: { stringValue: 'value' } },
      ],
    },
  };
  assert.equal(t.resourceProject(rl), '');
});

test('resourceProject: returns "" when project attribute is empty', () => {
  const rl = {
    resource: {
      attributes: [
        { key: 'project', value: { stringValue: '' } },
      ],
    },
  };
  assert.equal(t.resourceProject(rl), '');
});

test('resourceProject: returns "" when project attribute is not a string', () => {
  const rl = {
    resource: {
      attributes: [
        { key: 'project', value: { intValue: 123 } },
      ],
    },
  };
  assert.equal(t.resourceProject(rl), '');
});

test('resourceProject: returns "" when resource block is missing', () => {
  const rl = { resource: undefined };
  assert.equal(t.resourceProject(rl), '');
});

test('resourceProject: returns "" when resource is not an object', () => {
  const rl = { resource: 'not-an-object' };
  assert.equal(t.resourceProject(rl), '');
});

test('resourceProject: returns "" when attributes is not an array', () => {
  const rl = {
    resource: {
      attributes: 'not-an-array',
    },
  };
  assert.equal(t.resourceProject(rl), '');
});

test('resourceProject: returns "" when attributes is missing', () => {
  const rl = {
    resource: {
      // No attributes key
    },
  };
  assert.equal(t.resourceProject(rl), '');
});

test('resourceProject: never throws on null/junk input', () => {
  const testCases = [
    null,
    undefined,
    'not-a-rl',
    42,
    [],
    {},
    { resource: null },
    { resource: { attributes: null } },
  ];
  for (const val of testCases) {
    assert.doesNotThrow(() => {
      t.resourceProject(val);
    }, `resourceProject does not throw for ${JSON.stringify(val)}`);
  }
});

test('resourceProject: falls back to raw string on malformed percent-encoding', () => {
  const rl = {
    resource: {
      attributes: [
        { key: 'project', value: { stringValue: '100%bad%' } },
      ],
    },
  };
  assert.equal(t.resourceProject(rl), '100%bad%');
});

// --- extractApiRequests: new project field (TASK-152) -------------------------

test('extractApiRequests: adds project field to every row from resource attributes', () => {
  const logs = {
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: 'project', value: { stringValue: 'test-project' } },
          ],
        },
        scopeLogs: [
          {
            logRecords: [
              {
                body: { stringValue: 'claude_code.api_request' },
                attributes: [
                  { key: 'request_id', value: { stringValue: 'req_1' } },
                  { key: 'model', value: { stringValue: 'claude-haiku' } },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const rows = t.extractApiRequests(logs);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].project, 'test-project');
  assert.equal(rows[0].requestId, 'req_1');
  assert.equal(rows[0].model, 'claude-haiku');
});

test('extractApiRequests: each resourceLogs entry uses its own project', () => {
  const logs = {
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: 'project', value: { stringValue: 'proj-a' } },
          ],
        },
        scopeLogs: [
          {
            logRecords: [
              {
                body: { stringValue: 'claude_code.api_request' },
                attributes: [
                  { key: 'request_id', value: { stringValue: 'req_a' } },
                  { key: 'model', value: { stringValue: 'claude-haiku' } },
                ],
              },
            ],
          },
        ],
      },
      {
        resource: {
          attributes: [
            { key: 'project', value: { stringValue: 'proj-b' } },
          ],
        },
        scopeLogs: [
          {
            logRecords: [
              {
                body: { stringValue: 'claude_code.api_request' },
                attributes: [
                  { key: 'request_id', value: { stringValue: 'req_b' } },
                  { key: 'model', value: { stringValue: 'claude-haiku' } },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const rows = t.extractApiRequests(logs);
  assert.equal(rows.length, 2);
  const rowA = rows.find((r) => r.requestId === 'req_a');
  const rowB = rows.find((r) => r.requestId === 'req_b');
  assert.equal(rowA.project, 'proj-a');
  assert.equal(rowB.project, 'proj-b');
});

test('extractApiRequests: missing resource block yields project ""', () => {
  const logs = {
    resourceLogs: [
      {
        // No resource block
        scopeLogs: [
          {
            logRecords: [
              {
                body: { stringValue: 'claude_code.api_request' },
                attributes: [
                  { key: 'request_id', value: { stringValue: 'req_1' } },
                  { key: 'model', value: { stringValue: 'claude-haiku' } },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const rows = t.extractApiRequests(logs);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].project, '');
  assert.equal(rows[0].requestId, 'req_1');
});

test('extractApiRequests: project field does not affect requestKey dedup identity', () => {
  const rows = [
    {
      requestId: 'req_123',
      sessionId: 'sess',
      timestamp: '2026-07-26T00:00:00Z',
      inputTokens: 10,
      outputTokens: 20,
      costUsd: 0.05,
      project: 'proj-a',
    },
    {
      requestId: 'req_123',
      sessionId: 'sess',
      timestamp: '2026-07-26T00:00:00Z',
      inputTokens: 10,
      outputTokens: 20,
      costUsd: 0.05,
      project: 'proj-b',
    },
  ];
  // Both should have the same requestKey despite different projects
  const key1 = t.requestKey(rows[0]);
  const key2 = t.requestKey(rows[1]);
  assert.equal(key1, key2);
  assert.equal(key1, 'req_123');
});
