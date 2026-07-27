'use strict';

// End-to-end tests for lib/telemetry-receiver.js exercised over a REAL loopback
// socket (no Electron, no external network). We start the receiver, POST the exact
// OTLP/JSON shapes `claude` emits to /v1/logs and /v1/metrics with a real http
// client, and assert: usage accumulates + de-duplicates, the live onUpdate fires,
// the OTEL env points at the bound port, enable/disable toggles the server, and a
// configured forward destination receives the app's compact JSON summary.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createTelemetryReceiver } = require('../lib/telemetry-receiver');

function post(endpoint, pathname, json) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(json), 'utf8');
    const u = new URL(endpoint + pathname);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': body.length } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

function apiRequestLogs(requestId) {
  return { resourceLogs: [{ scopeLogs: [{ logRecords: [{
    body: { stringValue: 'claude_code.api_request' },
    attributes: [
      { key: 'session.id', value: { stringValue: 's1' } },
      { key: 'event.name', value: { stringValue: 'api_request' } },
      { key: 'model', value: { stringValue: 'claude-haiku-4-5-20251001' } },
      { key: 'input_tokens', value: { intValue: 10 } },
      { key: 'output_tokens', value: { intValue: 74 } },
      { key: 'cache_read_tokens', value: { intValue: 28905 } },
      { key: 'cache_creation_tokens', value: { intValue: 0 } },
      { key: 'cost_usd', value: { doubleValue: 0.0032705 } },
      { key: 'duration_ms', value: { intValue: 1543 } },
      { key: 'request_id', value: { stringValue: requestId } },
    ],
  }] }] }] };
}

const metricsPayload = { resourceMetrics: [{ scopeMetrics: [{ metrics: [
  { name: 'claude_code.cost.usage', sum: { dataPoints: [
    { attributes: [{ key: 'session.id', value: { stringValue: 's1' } }, { key: 'model', value: { stringValue: 'm' } }], asDouble: 0.0032705 } ] } },
  { name: 'claude_code.token.usage', sum: { dataPoints: [
    { attributes: [{ key: 'session.id', value: { stringValue: 's1' } }, { key: 'type', value: { stringValue: 'input' } }], asDouble: 10 },
    { attributes: [{ key: 'session.id', value: { stringValue: 's1' } }, { key: 'type', value: { stringValue: 'output' } }], asDouble: 74 } ] } },
] }] }] };

test('Scenario: claude posts api_request logs over the socket → usage accumulates, de-dups, and pushes live updates', async () => {
  const updates = [];
  const rec = createTelemetryReceiver({
    config: { enabled: true },
    onUpdate: (s) => updates.push(s),
    now: () => '2026-07-26T00:00:00Z',
    host: () => 'TESTPC',
  });
  const endpoint = await rec.start();
  try {
    assert.match(endpoint, /^http:\/\/127\.0\.0\.1:\d+$/, 'bound to loopback with a real port');

    // Given a first api_request export, When posted, Then it 200s and is counted.
    const r1 = await post(endpoint, '/v1/logs', apiRequestLogs('req_A'));
    assert.equal(r1.status, 200);

    // And a metrics export is accepted too.
    await post(endpoint, '/v1/metrics', metricsPayload);

    // And a DUPLICATE of the first request (same request_id) does not double-count.
    await post(endpoint, '/v1/logs', apiRequestLogs('req_A'));

    // And a genuinely new request is added.
    await post(endpoint, '/v1/logs', apiRequestLogs('req_B'));

    const usage = rec.getUsage();
    assert.equal(usage.usage.totals.requests, 2, 'two distinct requests (duplicate ignored)');
    assert.equal(usage.usage.totals.inputTokens, 20);
    assert.equal(usage.usage.totals.outputTokens, 148);
    assert.ok(Math.abs(usage.usage.totals.costUsd - 0.006541) < 1e-9);
    assert.ok(usage.usage.byModel['claude-haiku-4-5-20251001'], 'per-model breakdown present');
    // Metrics cross-check totals populated.
    assert.ok(Math.abs(usage.metricTotals.costUsd - 0.0032705) < 1e-9);
    assert.equal(usage.metricTotals.byType.output, 74);
    // Live updates fired (one per new-data ingest).
    assert.ok(updates.length >= 3, 'onUpdate fired for each new ingest');
  } finally {
    await rec.stop();
  }
});

test('Scenario: the receiver reports the OTEL env that points claude at the bound port', async () => {
  const rec = createTelemetryReceiver({ config: { enabled: true } });
  const endpoint = await rec.start();
  try {
    const env = rec.otelEnv();
    assert.equal(env.CLAUDE_CODE_ENABLE_TELEMETRY, '1');
    assert.equal(env.OTEL_EXPORTER_OTLP_PROTOCOL, 'http/json');
    assert.equal(env.OTEL_EXPORTER_OTLP_ENDPOINT, endpoint, 'endpoint carries the real bound port');
  } finally {
    await rec.stop();
  }
});

test('Scenario: setConfig starts the server on enable and stops it on disable; env clears when off', async () => {
  const rec = createTelemetryReceiver({ config: { enabled: false } });
  let state = await rec.setConfig({ enabled: true });
  try {
    assert.equal(state.enabled, true);
    assert.equal(state.running, true);
    assert.match(state.endpoint, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.notDeepEqual(rec.otelEnv(), {}, 'env populated while enabled');

    state = await rec.setConfig({ enabled: false });
    assert.equal(state.running, false);
    assert.deepEqual(rec.otelEnv(), {}, 'env empty while disabled');
  } finally {
    await rec.stop();
  }
});

test('Scenario: a configured forward URL receives the app JSON summary (not raw OTLP)', async () => {
  const forwarded = [];
  const rec = createTelemetryReceiver({
    config: { enabled: true, forwardUrl: 'https://sink.example/ingest', forwardEnabled: true, forwardToken: 'secret' },
    forwardRequest: (args) => { forwarded.push(args); return Promise.resolve({ ok: true, status: 200 }); },
    forwardDebounceMs: 5,
    now: () => '2026-07-26T00:00:00Z',
    host: () => 'TESTPC',
    username: () => 'steve',
    sessionId: 'sess-abc',
  });
  // The renderer reports the focused folder; the payload should carry it.
  rec.setActiveProject('claude-cmd-ui2');
  // TASK-156: enable forwarding for the project — logs must have project resource
  // attribute. Default is opt-in disabled.
  rec.setProjectForwarding('claude-cmd-ui2', true);
  const endpoint = await rec.start();
  try {
    // Create logs with the project resource attribute set
    const logsWithProject = {
      resourceLogs: [{
        resource: {
          attributes: [{ key: 'project', value: { stringValue: 'claude-cmd-ui2' } }],
        },
        scopeLogs: [{
          logRecords: [{
            body: { stringValue: 'claude_code.api_request' },
            attributes: [
              { key: 'session.id', value: { stringValue: 's1' } },
              { key: 'event.name', value: { stringValue: 'api_request' } },
              { key: 'model', value: { stringValue: 'claude-haiku-4-5-20251001' } },
              { key: 'input_tokens', value: { intValue: 10 } },
              { key: 'output_tokens', value: { intValue: 74 } },
              { key: 'cache_read_tokens', value: { intValue: 28905 } },
              { key: 'cache_creation_tokens', value: { intValue: 0 } },
              { key: 'cost_usd', value: { doubleValue: 0.0032705 } },
              { key: 'duration_ms', value: { intValue: 1543 } },
              { key: 'request_id', value: { stringValue: 'req_fwd' } },
            ],
          }],
        }],
      }],
    };
    await post(endpoint, '/v1/logs', logsWithProject);
    // Wait out the short debounce.
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(forwarded.length, 1, 'exactly one debounced forward');
    const f = forwarded[0];
    assert.equal(f.url, 'https://sink.example/ingest');
    assert.equal(f.token, 'secret');
    assert.equal(f.payload.schema, 'telemetry.usage.v1', 'app schema, not raw OTLP');
    assert.equal(f.payload.host, 'TESTPC');
    assert.equal(f.payload.sessionId, 'sess-abc', 'per-run session id');
    assert.equal(f.payload.username, 'steve', 'OS username');
    assert.equal(f.payload.project, 'claude-cmd-ui2', 'payload project matches the bucket');
    assert.equal(f.payload.totals.requests, 1);
    assert.equal(f.payload.recent.length, 1);
  } finally {
    await rec.stop();
  }
});

test('Scenario: sessionId is stable per receiver and exposed on state; setActiveProject updates the tag', async () => {
  const rec = createTelemetryReceiver({ config: { enabled: false }, username: () => 'steve' });
  // A minted sessionId is a non-empty string, stable across reads.
  assert.match(rec.sessionId, /\S/, 'sessionId is a non-empty string');
  assert.equal(rec.getState().sessionId, rec.sessionId, 'state carries the same id');
  assert.equal(rec.getState().username, 'steve');
  assert.equal(rec.getState().project, '', 'no active project until reported');
  rec.setActiveProject('  my-app  ');
  assert.equal(rec.getState().project, 'my-app', 'trimmed active project');
  rec.setActiveProject(42); // junk → cleared, never throws
  assert.equal(rec.getState().project, '');
});

test('Scenario: forwarding stays OFF without a valid destination even if flagged on', async () => {
  const forwarded = [];
  const rec = createTelemetryReceiver({
    config: { enabled: true, forwardUrl: 'not-a-url', forwardEnabled: true },
    forwardRequest: (args) => { forwarded.push(args); return Promise.resolve({ ok: true }); },
    forwardDebounceMs: 5,
  });
  const endpoint = await rec.start();
  try {
    await post(endpoint, '/v1/logs', apiRequestLogs('req_x'));
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(forwarded.length, 0, 'no forward without a valid URL');
    assert.equal(rec.getState().forwardEnabled, false);
  } finally {
    await rec.stop();
  }
});

test('Scenario (failure): a non-POST request and malformed JSON never crash the receiver', async () => {
  const rec = createTelemetryReceiver({ config: { enabled: true } });
  const endpoint = await rec.start();
  try {
    // GET → 405, no throw.
    const getRes = await new Promise((resolve, reject) => {
      http.get(endpoint + '/v1/logs', (res) => { res.on('data', () => {}); res.on('end', () => resolve(res.statusCode)); }).on('error', reject);
    });
    assert.equal(getRes, 405);

    // Malformed JSON body → still 200, ignored, usage unchanged.
    const bad = await new Promise((resolve, reject) => {
      const u = new URL(endpoint + '/v1/logs');
      const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST' }, (res) => { res.on('data', () => {}); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject); req.write('{not json'); req.end();
    });
    assert.equal(bad, 200);
    assert.equal(rec.getUsage().usage.totals.requests, 0, 'garbage ingested nothing');
  } finally {
    await rec.stop();
  }
});

// TASK-142: Per-ticket cost correlation via usageForWindow
test('Scenario: receiver.usageForWindow correlates rows from the FULL de-duplicated store within a time window', async () => {
  const rec = createTelemetryReceiver({ config: { enabled: true } });
  const endpoint = await rec.start();
  try {
    // Ingest three api_requests at 04:15, 04:16, and 05:00
    const logs1 = {
      resourceLogs: [{
        scopeLogs: [{
          logRecords: [{
            body: { stringValue: 'claude_code.api_request' },
            attributes: [
              { key: 'session.id', value: { stringValue: 's1' } },
              { key: 'event.timestamp', value: { stringValue: '2026-07-26T04:15:00Z' } },
              { key: 'model', value: { stringValue: 'claude-haiku-4-5-20251001' } },
              { key: 'input_tokens', value: { intValue: 10 } },
              { key: 'output_tokens', value: { intValue: 20 } },
              { key: 'cache_read_tokens', value: { intValue: 100 } },
              { key: 'cache_creation_tokens', value: { intValue: 5 } },
              { key: 'cost_usd', value: { doubleValue: 0.01 } },
              { key: 'request_id', value: { stringValue: 'req_1' } },
            ],
          }],
        }],
      }],
    };

    const logs2 = {
      resourceLogs: [{
        scopeLogs: [{
          logRecords: [{
            body: { stringValue: 'claude_code.api_request' },
            attributes: [
              { key: 'session.id', value: { stringValue: 's1' } },
              { key: 'event.timestamp', value: { stringValue: '2026-07-26T04:16:00Z' } },
              { key: 'model', value: { stringValue: 'claude-haiku-4-5-20251001' } },
              { key: 'input_tokens', value: { intValue: 5 } },
              { key: 'output_tokens', value: { intValue: 10 } },
              { key: 'cache_read_tokens', value: { intValue: 200 } },
              { key: 'cache_creation_tokens', value: { intValue: 0 } },
              { key: 'cost_usd', value: { doubleValue: 0.02 } },
              { key: 'request_id', value: { stringValue: 'req_2' } },
            ],
          }],
        }],
      }],
    };

    const logs3 = {
      resourceLogs: [{
        scopeLogs: [{
          logRecords: [{
            body: { stringValue: 'claude_code.api_request' },
            attributes: [
              { key: 'session.id', value: { stringValue: 's1' } },
              { key: 'event.timestamp', value: { stringValue: '2026-07-26T05:00:00Z' } },
              { key: 'model', value: { stringValue: 'claude-haiku-4-5-20251001' } },
              { key: 'input_tokens', value: { intValue: 100 } },
              { key: 'output_tokens', value: { intValue: 200 } },
              { key: 'cache_read_tokens', value: { intValue: 1000 } },
              { key: 'cache_creation_tokens', value: { intValue: 50 } },
              { key: 'cost_usd', value: { doubleValue: 0.10 } },
              { key: 'request_id', value: { stringValue: 'req_3' } },
            ],
          }],
        }],
      }],
    };

    await post(endpoint, '/v1/logs', logs1);
    await post(endpoint, '/v1/logs', logs2);
    await post(endpoint, '/v1/logs', logs3);

    // Query for an activity window 04:14 to 04:20 (includes only req_1 and req_2)
    const usage = rec.usageForWindow({
      startedAt: '2026-07-26T04:14:00Z',
      finishedAt: '2026-07-26T04:20:00Z',
    });

    assert.equal(usage.requests, 2, 'only the two rows within the window');
    assert.equal(usage.inputTokens, 15, '10 + 5');
    assert.equal(usage.outputTokens, 30, '20 + 10');
    assert.equal(usage.cacheReadTokens, 300, '100 + 200');
    assert.equal(usage.cacheCreationTokens, 5, '5 + 0');
    assert.equal(usage.totalTokens, 350, '15 + 30 + 300 + 5');
    assert.ok(Math.abs(usage.costUsd - 0.03) < 1e-9, '0.01 + 0.02');
  } finally {
    await rec.stop();
  }
});

test('Scenario: receiver.usageForWindow respects model filtering when present on both sides', async () => {
  const rec = createTelemetryReceiver({ config: { enabled: true } });
  const endpoint = await rec.start();
  try {
    // Ingest rows with two different models
    const logsSonnet = {
      resourceLogs: [{
        scopeLogs: [{
          logRecords: [{
            body: { stringValue: 'claude_code.api_request' },
            attributes: [
              { key: 'session.id', value: { stringValue: 's1' } },
              { key: 'event.timestamp', value: { stringValue: '2026-07-26T04:15:00Z' } },
              { key: 'model', value: { stringValue: 'claude-sonnet' } },
              { key: 'input_tokens', value: { intValue: 100 } },
              { key: 'output_tokens', value: { intValue: 50 } },
              { key: 'cache_read_tokens', value: { intValue: 500 } },
              { key: 'cache_creation_tokens', value: { intValue: 10 } },
              { key: 'request_id', value: { stringValue: 'req_sonnet' } },
            ],
          }],
        }],
      }],
    };

    const logsHaiku = {
      resourceLogs: [{
        scopeLogs: [{
          logRecords: [{
            body: { stringValue: 'claude_code.api_request' },
            attributes: [
              { key: 'session.id', value: { stringValue: 's1' } },
              { key: 'event.timestamp', value: { stringValue: '2026-07-26T04:16:00Z' } },
              { key: 'model', value: { stringValue: 'claude-haiku' } },
              { key: 'input_tokens', value: { intValue: 10 } },
              { key: 'output_tokens', value: { intValue: 5 } },
              { key: 'cache_read_tokens', value: { intValue: 50 } },
              { key: 'cache_creation_tokens', value: { intValue: 1 } },
              { key: 'request_id', value: { stringValue: 'req_haiku' } },
            ],
          }],
        }],
      }],
    };

    await post(endpoint, '/v1/logs', logsSonnet);
    await post(endpoint, '/v1/logs', logsHaiku);

    // Query for haiku model only
    const usageHaiku = rec.usageForWindow({
      startedAt: '2026-07-26T04:00:00Z',
      finishedAt: '2026-07-26T05:00:00Z',
      model: 'claude-haiku',
    });

    assert.equal(usageHaiku.requests, 1, 'only haiku row');
    assert.equal(usageHaiku.inputTokens, 10);
    assert.equal(usageHaiku.cacheReadTokens, 50);

    // Query without model filter includes both
    const usageAll = rec.usageForWindow({
      startedAt: '2026-07-26T04:00:00Z',
      finishedAt: '2026-07-26T05:00:00Z',
    });

    assert.equal(usageAll.requests, 2, 'both rows when no model filter');
    assert.equal(usageAll.inputTokens, 110, '100 + 10');
  } finally {
    await rec.stop();
  }
});

test('Scenario (failure): receiver.usageForWindow returns empty totals for junk input and never throws', async () => {
  const rec = createTelemetryReceiver({ config: { enabled: true } });
  const endpoint = await rec.start();
  try {
    await post(endpoint, '/v1/logs', apiRequestLogs('req_test'));

    // Null/junk window inputs
    for (const badWindow of [null, undefined, {}, { startedAt: 'invalid', finishedAt: 'invalid' }]) {
      const usage = rec.usageForWindow(badWindow);
      assert.equal(usage.requests, 0, `junk window → zero requests for ${JSON.stringify(badWindow)}`);
      assert.equal(usage.inputTokens, 0);
      assert.equal(usage.costUsd, 0);
    }

    // Reversed window (finishedAt before startedAt)
    const reversed = rec.usageForWindow({
      startedAt: '2026-07-26T05:00:00Z',
      finishedAt: '2026-07-26T04:00:00Z',
    });
    assert.equal(reversed.requests, 0, 'reversed window → zero usage, no throw');
  } finally {
    await rec.stop();
  }
});

// ── TASK-156: Per-project-aware forwarding ──────────────────────────────────

test('Scenario: Only projects with their toggle on are forwarded', async () => {
  const forwarded = [];
  const rec = createTelemetryReceiver({
    config: { enabled: true, forwardUrl: 'https://sink.example/ingest', forwardEnabled: true },
    forwardRequest: (args) => { forwarded.push(args); return Promise.resolve({ ok: true }); },
    forwardDebounceMs: 5,
    now: () => '2026-07-26T00:00:00Z',
    host: () => 'TESTPC',
    sessionId: 'sess-abc',
  });
  const endpoint = await rec.start();
  try {
    // Given: app-global forwarding is enabled with a valid URL
    // And project "alpha" store-online is ON and project "beta" is OFF
    rec.setProjectForwarding('alpha', true);
    rec.setProjectForwarding('beta', false);

    // Create logs with project attribute set via ingest (simulating real OTLP data)
    // We'll manually bucket rows by project
    const alphaLogs = {
      resourceLogs: [{
        resource: {
          attributes: [{ key: 'project', value: { stringValue: 'alpha' } }],
        },
        scopeLogs: [{
          logRecords: [{
            body: { stringValue: 'claude_code.api_request' },
            attributes: [
              { key: 'session.id', value: { stringValue: 'sess' } },
              { key: 'event.name', value: { stringValue: 'api_request' } },
              { key: 'model', value: { stringValue: 'claude-haiku' } },
              { key: 'input_tokens', value: { intValue: 10 } },
              { key: 'output_tokens', value: { intValue: 20 } },
              { key: 'cache_read_tokens', value: { intValue: 100 } },
              { key: 'cache_creation_tokens', value: { intValue: 0 } },
              { key: 'cost_usd', value: { doubleValue: 0.01 } },
              { key: 'request_id', value: { stringValue: 'req_alpha' } },
            ],
          }],
        }],
      }],
    };

    const betaLogs = {
      resourceLogs: [{
        resource: {
          attributes: [{ key: 'project', value: { stringValue: 'beta' } }],
        },
        scopeLogs: [{
          logRecords: [{
            body: { stringValue: 'claude_code.api_request' },
            attributes: [
              { key: 'session.id', value: { stringValue: 'sess' } },
              { key: 'event.name', value: { stringValue: 'api_request' } },
              { key: 'model', value: { stringValue: 'claude-haiku' } },
              { key: 'input_tokens', value: { intValue: 5 } },
              { key: 'output_tokens', value: { intValue: 10 } },
              { key: 'cache_read_tokens', value: { intValue: 50 } },
              { key: 'cache_creation_tokens', value: { intValue: 0 } },
              { key: 'cost_usd', value: { doubleValue: 0.005 } },
              { key: 'request_id', value: { stringValue: 'req_beta' } },
            ],
          }],
        }],
      }],
    };

    // And both buckets have rows
    await post(endpoint, '/v1/logs', alphaLogs);
    await post(endpoint, '/v1/logs', betaLogs);

    // Wait for the forward debounce
    await new Promise((r) => setTimeout(r, 40));

    // Then exactly one POST is made, its payload.project is "alpha"
    assert.equal(forwarded.length, 1, 'exactly one forward (only alpha)');
    const fwd = forwarded[0];
    assert.equal(fwd.payload.project, 'alpha', 'payload.project is "alpha"');
    assert.equal(fwd.payload.totals.requests, 1, 'alpha has 1 request');
    // And no POST is made for "beta"
    assert.ok(!forwarded.some((f) => f.payload.project === 'beta'), 'no forward for beta');
  } finally {
    await rec.stop();
  }
});

test('Scenario: Master switch off suppresses all projects', async () => {
  const forwarded = [];
  const rec = createTelemetryReceiver({
    config: { enabled: true, forwardUrl: 'https://sink.example/ingest', forwardEnabled: false }, // master switch OFF
    forwardRequest: (args) => { forwarded.push(args); return Promise.resolve({ ok: true }); },
    forwardDebounceMs: 5,
    now: () => '2026-07-26T00:00:00Z',
  });
  const endpoint = await rec.start();
  try {
    // Given app-global forwarding is disabled
    // And project "alpha" store-online is ON
    rec.setProjectForwarding('alpha', true);

    // When ingest occurs
    await post(endpoint, '/v1/logs', apiRequestLogs('req_alpha'));
    await new Promise((r) => setTimeout(r, 40));

    // Then no forward POST is made
    assert.equal(forwarded.length, 0, 'no forward when master switch is off');
  } finally {
    await rec.stop();
  }
});

test('Scenario: getUsage returns a single project\'s bucket', async () => {
  const rec = createTelemetryReceiver({
    config: { enabled: true },
    now: () => '2026-07-26T00:00:00Z',
  });
  const endpoint = await rec.start();
  try {
    // Given rows in buckets "alpha" and "beta"
    const alphaLogs = {
      resourceLogs: [{
        resource: { attributes: [{ key: 'project', value: { stringValue: 'alpha' } }] },
        scopeLogs: [{
          logRecords: [{
            body: { stringValue: 'claude_code.api_request' },
            attributes: [
              { key: 'session.id', value: { stringValue: 's' } },
              { key: 'event.name', value: { stringValue: 'api_request' } },
              { key: 'model', value: { stringValue: 'claude-haiku' } },
              { key: 'input_tokens', value: { intValue: 10 } },
              { key: 'output_tokens', value: { intValue: 20 } },
              { key: 'cache_read_tokens', value: { intValue: 0 } },
              { key: 'cache_creation_tokens', value: { intValue: 0 } },
              { key: 'cost_usd', value: { doubleValue: 0.01 } },
              { key: 'request_id', value: { stringValue: 'req_a' } },
            ],
          }],
        }],
      }],
    };

    const betaLogs = {
      resourceLogs: [{
        resource: { attributes: [{ key: 'project', value: { stringValue: 'beta' } }] },
        scopeLogs: [{
          logRecords: [{
            body: { stringValue: 'claude_code.api_request' },
            attributes: [
              { key: 'session.id', value: { stringValue: 's' } },
              { key: 'event.name', value: { stringValue: 'api_request' } },
              { key: 'model', value: { stringValue: 'claude-sonnet' } },
              { key: 'input_tokens', value: { intValue: 100 } },
              { key: 'output_tokens', value: { intValue: 200 } },
              { key: 'cache_read_tokens', value: { intValue: 0 } },
              { key: 'cache_creation_tokens', value: { intValue: 0 } },
              { key: 'cost_usd', value: { doubleValue: 0.10 } },
              { key: 'request_id', value: { stringValue: 'req_b' } },
            ],
          }],
        }],
      }],
    };

    await post(endpoint, '/v1/logs', alphaLogs);
    await post(endpoint, '/v1/logs', betaLogs);

    // When telemetry:getUsage is invoked with project "alpha"
    const usageAlpha = rec.getUsageForProject('alpha');

    // Then it returns only alpha's usage and recent
    assert.equal(usageAlpha.usage.totals.requests, 1, 'alpha has 1 request');
    assert.equal(usageAlpha.usage.totals.inputTokens, 10, 'alpha inputs = 10');
    assert.equal(usageAlpha.usage.totals.outputTokens, 20, 'alpha outputs = 20');
    assert.equal(usageAlpha.recent.length, 1, 'alpha has 1 recent');
    assert.equal(usageAlpha.recent[0].requestId, 'req_a', 'recent contains alpha\'s request');

    // Also check beta separately
    const usageBeta = rec.getUsageForProject('beta');
    assert.equal(usageBeta.usage.totals.requests, 1, 'beta has 1 request');
    assert.equal(usageBeta.usage.totals.inputTokens, 100, 'beta inputs = 100');
  } finally {
    await rec.stop();
  }
});

test('Scenario: setProjectConfig toggles a project\'s forwarding', async () => {
  const forwarded = [];
  const rec = createTelemetryReceiver({
    config: { enabled: true, forwardUrl: 'https://sink.example/ingest', forwardEnabled: true },
    forwardRequest: (args) => { forwarded.push(args); return Promise.resolve({ ok: true }); },
    forwardDebounceMs: 5,
    now: () => '2026-07-26T00:00:00Z',
  });
  const endpoint = await rec.start();
  try {
    // Given a running receiver
    const testLogs = apiRequestLogs('req_test');

    // Initially, default bucket ('') is not enabled, so no forward happens
    await post(endpoint, '/v1/logs', testLogs);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(forwarded.length, 0, 'initially no forward (default bucket not enabled)');

    // Clear the log
    rec.clear();
    forwarded.length = 0;

    // When setProjectForwarding is invoked for the default bucket
    rec.setProjectForwarding('', true);

    // Then the receiver forwards on the next tick (master switch permitting)
    await post(endpoint, '/v1/logs', testLogs);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(forwarded.length, 1, 'after enabling default bucket, it forwards');
  } finally {
    await rec.stop();
  }
});

test('Scenario (edge): Unknown project defaults to not forwarding', async () => {
  const forwarded = [];
  const rec = createTelemetryReceiver({
    config: { enabled: true, forwardUrl: 'https://sink.example/ingest', forwardEnabled: true },
    forwardRequest: (args) => { forwarded.push(args); return Promise.resolve({ ok: true }); },
    forwardDebounceMs: 5,
    now: () => '2026-07-26T00:00:00Z',
  });
  const endpoint = await rec.start();
  try {
    // Given app-global forwarding is enabled with a valid URL
    // And a bucket "ghost" that never had setProjectForwarding called
    const ghostLogs = {
      resourceLogs: [{
        resource: { attributes: [{ key: 'project', value: { stringValue: 'ghost' } }] },
        scopeLogs: [{
          logRecords: [{
            body: { stringValue: 'claude_code.api_request' },
            attributes: [
              { key: 'session.id', value: { stringValue: 's' } },
              { key: 'event.name', value: { stringValue: 'api_request' } },
              { key: 'model', value: { stringValue: 'claude-haiku' } },
              { key: 'input_tokens', value: { intValue: 1 } },
              { key: 'output_tokens', value: { intValue: 1 } },
              { key: 'cache_read_tokens', value: { intValue: 0 } },
              { key: 'cache_creation_tokens', value: { intValue: 0 } },
              { key: 'cost_usd', value: { doubleValue: 0.001 } },
              { key: 'request_id', value: { stringValue: 'req_ghost' } },
            ],
          }],
        }],
      }],
    };

    // When the forward tick fires
    await post(endpoint, '/v1/logs', ghostLogs);
    await new Promise((r) => setTimeout(r, 40));

    // Then "ghost" is not forwarded (default off)
    assert.equal(forwarded.length, 0, 'unknown project "ghost" defaults to not forwarding');
  } finally {
    await rec.stop();
  }
});

test('Scenario: Empty buckets are not forwarded', async () => {
  const forwarded = [];
  const rec = createTelemetryReceiver({
    config: { enabled: true, forwardUrl: 'https://sink.example/ingest', forwardEnabled: true },
    forwardRequest: (args) => { forwarded.push(args); return Promise.resolve({ ok: true }); },
    forwardDebounceMs: 5,
    now: () => '2026-07-26T00:00:00Z',
  });
  const endpoint = await rec.start();
  try {
    // Enable forwarding for a project that never receives data
    rec.setProjectForwarding('empty', true);

    // Trigger the forward timer without sending data
    await new Promise((r) => setTimeout(r, 40));

    // No forward should happen (bucket is empty)
    assert.equal(forwarded.length, 0, 'empty bucket not forwarded even when toggle is on');
  } finally {
    await rec.stop();
  }
});

// TASK-167: a project string with incidental leading/trailing whitespace must
// key the SAME bucket on the ingest side (resourceProject/decodeAttrValue,
// which no longer trims) as it does on the setProjectForwarding side (which
// has never trimmed). Both are ultimately sourced from the same untrimmed
// `tab.folder` string, so they must match exactly, whitespace included.
test('Scenario: a project key with incidental whitespace matches between ingest and setProjectForwarding', async () => {
  const forwarded = [];
  const project = '  C:\\projects\\alpha  '; // incidental leading/trailing whitespace
  const rec = createTelemetryReceiver({
    config: { enabled: true, forwardUrl: 'https://sink.example/ingest', forwardEnabled: true },
    forwardRequest: (args) => { forwarded.push(args); return Promise.resolve({ ok: true }); },
    forwardDebounceMs: 5,
    now: () => '2026-07-26T00:00:00Z',
  });
  const endpoint = await rec.start();
  try {
    // Toggle store-online for the EXACT (untrimmed) project string, as
    // setProjectForwarding would receive it from the renderer's tab.folder.
    rec.setProjectForwarding(project, true);

    const logs = {
      resourceLogs: [{
        // Simulates the value as it arrives in the OTLP JSON payload: the
        // CLI's own OTEL SDK already fully percent-decoded it (TASK-153), so
        // the whitespace here is literal, not percent-encoded.
        resource: { attributes: [{ key: 'project', value: { stringValue: project } }] },
        scopeLogs: [{
          logRecords: [{
            body: { stringValue: 'claude_code.api_request' },
            attributes: [
              { key: 'session.id', value: { stringValue: 'sess' } },
              { key: 'event.name', value: { stringValue: 'api_request' } },
              { key: 'model', value: { stringValue: 'claude-haiku' } },
              { key: 'input_tokens', value: { intValue: 1 } },
              { key: 'output_tokens', value: { intValue: 1 } },
              { key: 'cache_read_tokens', value: { intValue: 0 } },
              { key: 'cache_creation_tokens', value: { intValue: 0 } },
              { key: 'cost_usd', value: { doubleValue: 0.001 } },
              { key: 'request_id', value: { stringValue: 'req_ws' } },
            ],
          }],
        }],
      }],
    };
    await post(endpoint, '/v1/logs', logs);
    await new Promise((r) => setTimeout(r, 40));

    // Then the toggle actually gates THIS bucket: a forward fires. This is
    // the load-bearing assertion — it only fires when the ingest-bucket key
    // (from resourceProject/decodeAttrValue, untrimmed) equals the
    // setProjectForwarding key (from `project`, also untrimmed) EXACTLY,
    // whitespace included; scheduleForward's `projectForwarding.get(project)
    // !== true` gate would otherwise skip it.
    // (buildForwardPayload's outgoing `project` LABEL is separately run
    // through the general-purpose `str()` helper and so is cosmetically
    // trimmed for the external payload — that's an unrelated, pre-existing
    // normalization of a display value, not the bucket/toggle KEY this ticket
    // is about, so it is intentionally not asserted byte-for-byte here.)
    assert.equal(forwarded.length, 1, 'ingest bucket key matches the setProjectForwarding key exactly');
    assert.equal(forwarded[0].payload.project, project.trim(), 'forwarded LABEL is cosmetically trimmed (unrelated to the key match above)');

    // Negative control: the TRIMMED variant of the same string is a
    // DIFFERENT bucket key and was never opted in, so it must not forward
    // even though it "looks like" the same project to a human.
    rec.setProjectForwarding(project.trim(), false);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(forwarded.length, 1, 'the trimmed variant is a distinct, still-off bucket key');
  } finally {
    await rec.stop();
  }
});
