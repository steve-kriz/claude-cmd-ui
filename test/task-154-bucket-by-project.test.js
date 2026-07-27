'use strict';

// Unit tests for TASK-154: per-project bucketing in the telemetry receiver.
// Tests the bucket management, deduplication per-project, usage aggregation,
// and state snapshot logic without requiring a real HTTP server.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTelemetryReceiver } = require('../lib/telemetry-receiver');

// Helper to create an api_request logs payload with optional project
function logsPayload(requestId, inputTokens = 10, project = '') {
  const rl = {
    scopeLogs: [{
      logRecords: [{
        body: { stringValue: 'claude_code.api_request' },
        attributes: [
          { key: 'session.id', value: { stringValue: 's1' } },
          { key: 'event.name', value: { stringValue: 'api_request' } },
          { key: 'model', value: { stringValue: 'claude-haiku' } },
          { key: 'input_tokens', value: { intValue: inputTokens } },
          { key: 'output_tokens', value: { intValue: 20 } },
          { key: 'cache_read_tokens', value: { intValue: 100 } },
          { key: 'cache_creation_tokens', value: { intValue: 5 } },
          { key: 'cost_usd', value: { doubleValue: 0.01 } },
          { key: 'duration_ms', value: { intValue: 1000 } },
          { key: 'request_id', value: { stringValue: requestId } },
        ],
      }],
    }],
  };
  if (project !== '') {
    rl.resource = {
      attributes: [
        { key: 'project', value: { stringValue: project } },
      ],
    };
  }
  return { resourceLogs: [rl] };
}

test('Unit: ingestLogs routes rows to correct project buckets', () => {
  const rec = createTelemetryReceiver({ config: { enabled: true } });

  // Ingest rows for multiple projects
  rec.ingestLogs(logsPayload('req_a1', 10, 'alpha'));
  rec.ingestLogs(logsPayload('req_b1', 20, 'beta'));
  rec.ingestLogs(logsPayload('req_untagged', 30, ''));

  // Verify each bucket has only its own rows
  const alphaUsage = rec.usageForProject('alpha');
  assert.equal(alphaUsage.totals.requests, 1);
  assert.equal(alphaUsage.totals.inputTokens, 10);

  const betaUsage = rec.usageForProject('beta');
  assert.equal(betaUsage.totals.requests, 1);
  assert.equal(betaUsage.totals.inputTokens, 20);

  const untaggedUsage = rec.usageForProject('');
  assert.equal(untaggedUsage.totals.requests, 1);
  assert.equal(untaggedUsage.totals.inputTokens, 30);

  // App-wide total includes all
  const snapshot = rec.snapshotState();
  assert.equal(snapshot.usage.totals.requests, 3);
  assert.equal(snapshot.usage.totals.inputTokens, 60);
});

test('Unit: Per-project deduplication by requestKey', () => {
  const rec = createTelemetryReceiver({ config: { enabled: true } });

  // Ingest a request twice with same requestId
  rec.ingestLogs(logsPayload('req_dup', 10, 'alpha'));
  const count1 = rec.ingestLogs(logsPayload('req_dup', 10, 'alpha'));
  assert.equal(count1, 0, 'duplicate request not added');

  const alphaUsage = rec.usageForProject('alpha');
  assert.equal(alphaUsage.totals.requests, 1, 'alpha still has 1 request');

  // Same request ID in a DIFFERENT project IS still a duplicate: requestKey
  // (lib/telemetry.js) does not fold `project` into its identity, so de-dup
  // must be GLOBAL across every bucket (first write wins), not per-bucket.
  const count2 = rec.ingestLogs(logsPayload('req_dup', 10, 'beta'));
  assert.equal(count2, 0, 'same request ID under a different project is still a duplicate, globally');

  const betaUsage = rec.usageForProject('beta');
  assert.equal(betaUsage.totals.requests, 0, 'beta never received the duplicate');

  // App-wide sees it only once
  const snapshot = rec.snapshotState();
  assert.equal(snapshot.usage.totals.requests, 1, 'app-wide counts the duplicate only once');
});

test('Unit: usageForProject returns empty totals for unknown project', () => {
  const rec = createTelemetryReceiver({ config: { enabled: true } });

  // No rows ingested yet
  const usage = rec.usageForProject('nonexistent');
  assert.equal(usage.totals.requests, 0);
  assert.equal(usage.totals.inputTokens, 0);
  assert.equal(usage.totals.costUsd, 0);
  assert.ok(typeof usage.byModel === 'object');
  assert.equal(Object.keys(usage.byModel).length, 0);
});

test('Unit: getUsageForProject returns { usage, recent } for a project', () => {
  const rec = createTelemetryReceiver({ config: { enabled: true } });

  // Ingest several rows
  rec.ingestLogs(logsPayload('req_1', 10, 'proj'));
  rec.ingestLogs(logsPayload('req_2', 20, 'proj'));
  rec.ingestLogs(logsPayload('req_3', 5, 'proj'));

  const result = rec.getUsageForProject('proj');

  assert.ok(result.usage);
  assert.equal(result.usage.totals.requests, 3);
  assert.ok(Array.isArray(result.recent));
  assert.equal(result.recent.length, 3, 'recent includes all 3 rows');

  // Verify recent rows belong to this project
  for (const row of result.recent) {
    assert.equal(row.project, 'proj');
  }
});

test('Unit: getUsage() defaults to activeProject when set', () => {
  const rec = createTelemetryReceiver({ config: { enabled: true } });

  rec.ingestLogs(logsPayload('req_active', 10, 'active-proj'));
  rec.ingestLogs(logsPayload('req_other', 20, 'other-proj'));

  // Without activeProject, returns app-wide
  let result = rec.getUsage();
  assert.equal(result.usage.totals.requests, 2);

  // Set activeProject
  rec.setActiveProject('active-proj');
  result = rec.getUsage();
  assert.equal(result.usage.totals.requests, 1, 'getUsage returns activeProject bucket');

  // Explicit project overrides activeProject
  result = rec.getUsage('other-proj');
  assert.equal(result.usage.totals.requests, 1);
});

test('Unit: getUsage("") with empty activeProject returns app-wide', () => {
  const rec = createTelemetryReceiver({ config: { enabled: true } });

  rec.ingestLogs(logsPayload('req_1', 10, 'proj1'));
  rec.ingestLogs(logsPayload('req_2', 20, 'proj2'));

  // activeProject is empty by default
  const result = rec.getUsage('');
  // Empty activeProject falls back to app-wide
  assert.equal(result.usage.totals.requests, 2, 'empty project arg with empty activeProject returns app-wide');
});

test('Unit: snapshotState includes project and projectUsage', () => {
  const rec = createTelemetryReceiver({ config: { enabled: true } });

  rec.ingestLogs(logsPayload('req_a', 10, 'projA'));
  rec.ingestLogs(logsPayload('req_b', 20, 'projB'));

  // Snapshot for projA
  const snapshotA = rec.snapshotState('projA');
  assert.equal(snapshotA.project, 'projA');
  assert.equal(snapshotA.projectUsage.totals.requests, 1, 'projectUsage for projA');
  assert.ok(snapshotA.usage, 'app-wide usage still present');
  assert.equal(snapshotA.usage.totals.requests, 2, 'usage is app-wide');

  // Snapshot for projB
  const snapshotB = rec.snapshotState('projB');
  assert.equal(snapshotB.project, 'projB');
  assert.equal(snapshotB.projectUsage.totals.requests, 1, 'projectUsage for projB');

  // Snapshot with no project arg uses activeProject
  rec.setActiveProject('projA');
  const snapshotDefault = rec.snapshotState();
  assert.equal(snapshotDefault.project, 'projA');
  assert.equal(snapshotDefault.projectUsage.totals.requests, 1);
});

test('Unit: onUpdate receives snapshotState with project and projectUsage', () => {
  const updates = [];
  const rec = createTelemetryReceiver({
    config: { enabled: true },
    onUpdate: (state) => updates.push(state),
  });

  rec.ingestLogs(logsPayload('req_x', 10, 'projX'));

  assert.ok(updates.length > 0, 'onUpdate was called');
  const lastUpdate = updates[updates.length - 1];
  assert.equal(lastUpdate.project, 'projX');
  assert.equal(lastUpdate.projectUsage.totals.requests, 1);
  assert.ok(lastUpdate.usage);
  assert.ok(lastUpdate.metricTotals);
});

test('Unit: clear() clears all buckets and globalRecent', () => {
  const rec = createTelemetryReceiver({ config: { enabled: true } });

  rec.ingestLogs(logsPayload('req_1', 10, 'proj1'));
  rec.ingestLogs(logsPayload('req_2', 20, 'proj2'));
  rec.ingestLogs(logsPayload('req_3', 30, ''));

  // Verify all populated
  assert.equal(rec.usageForProject('proj1').totals.requests, 1);
  assert.equal(rec.usageForProject('proj2').totals.requests, 1);
  assert.equal(rec.usageForProject('').totals.requests, 1);

  rec.clear();

  // All should be empty
  assert.equal(rec.usageForProject('proj1').totals.requests, 0);
  assert.equal(rec.usageForProject('proj2').totals.requests, 0);
  assert.equal(rec.usageForProject('').totals.requests, 0);

  // App-wide should be empty
  const snapshot = rec.snapshotState();
  assert.equal(snapshot.usage.totals.requests, 0);
  assert.equal(snapshot.metricTotals.costUsd, 0);
});

test('Unit: usageForWindow scans all buckets regardless of project', () => {
  const rec = createTelemetryReceiver({ config: { enabled: true } });

  // Build logs with timestamps
  const alphaLog = {
    resourceLogs: [{
      resource: { attributes: [{ key: 'project', value: { stringValue: 'alpha' } }] },
      scopeLogs: [{
        logRecords: [{
          body: { stringValue: 'claude_code.api_request' },
          attributes: [
            { key: 'session.id', value: { stringValue: 's1' } },
            { key: 'event.timestamp', value: { stringValue: '2026-07-26T10:00:00Z' } },
            { key: 'model', value: { stringValue: 'claude-haiku' } },
            { key: 'input_tokens', value: { intValue: 10 } },
            { key: 'output_tokens', value: { intValue: 20 } },
            { key: 'cache_read_tokens', value: { intValue: 100 } },
            { key: 'cache_creation_tokens', value: { intValue: 5 } },
            { key: 'cost_usd', value: { doubleValue: 0.01 } },
            { key: 'request_id', value: { stringValue: 'req_alpha' } },
          ],
        }],
      }],
    }],
  };

  const betaLog = {
    resourceLogs: [{
      resource: { attributes: [{ key: 'project', value: { stringValue: 'beta' } }] },
      scopeLogs: [{
        logRecords: [{
          body: { stringValue: 'claude_code.api_request' },
          attributes: [
            { key: 'session.id', value: { stringValue: 's1' } },
            { key: 'event.timestamp', value: { stringValue: '2026-07-26T10:05:00Z' } },
            { key: 'model', value: { stringValue: 'claude-haiku' } },
            { key: 'input_tokens', value: { intValue: 5 } },
            { key: 'output_tokens', value: { intValue: 10 } },
            { key: 'cache_read_tokens', value: { intValue: 200 } },
            { key: 'cache_creation_tokens', value: { intValue: 0 } },
            { key: 'cost_usd', value: { doubleValue: 0.02 } },
            { key: 'request_id', value: { stringValue: 'req_beta' } },
          ],
        }],
      }],
    }],
  };

  rec.ingestLogs(alphaLog);
  rec.ingestLogs(betaLog);

  // Query a window that includes both
  const usage = rec.usageForWindow({
    startedAt: '2026-07-26T09:00:00Z',
    finishedAt: '2026-07-26T11:00:00Z',
  });

  assert.equal(usage.requests, 2, 'window includes both buckets');
  assert.equal(usage.inputTokens, 15);
  assert.equal(usage.outputTokens, 30);
});

test('Unit: usageForWindow returns emptyTotals for junk window', () => {
  const rec = createTelemetryReceiver({ config: { enabled: true } });

  rec.ingestLogs(logsPayload('req_test', 10, 'proj'));

  // Test various junk windows
  const cases = [null, undefined, {}, { startedAt: 'invalid' }];
  for (const win of cases) {
    const usage = rec.usageForWindow(win);
    assert.equal(usage.requests, 0, `junk window → empty totals`);
    assert.equal(usage.costUsd, 0);
  }
});

test('Unit: ingestMetrics still works app-wide (unchanged)', () => {
  const rec = createTelemetryReceiver({ config: { enabled: true } });

  const metricsPayload = {
    resourceMetrics: [{
      scopeMetrics: [{
        metrics: [
          {
            name: 'claude_code.cost.usage',
            sum: {
              dataPoints: [{
                attributes: [
                  { key: 'session.id', value: { stringValue: 's1' } },
                  { key: 'model', value: { stringValue: 'claude-haiku' } },
                ],
                asDouble: 0.05,
              }],
            },
          },
        ],
      }],
    }],
  };

  rec.ingestMetrics(metricsPayload);

  const snapshot = rec.snapshotState();
  assert.ok(Math.abs(snapshot.metricTotals.costUsd - 0.05) < 1e-9, 'metrics snapshot updated');
});

test('Unit: setActiveProject trims and coerces junk to empty', () => {
  const rec = createTelemetryReceiver({ config: { enabled: true } });

  // Valid names
  assert.equal(rec.setActiveProject('my-proj'), 'my-proj');
  assert.equal(rec.setActiveProject('  spaces  '), 'spaces');

  // Junk → empty
  assert.equal(rec.setActiveProject(null), '');
  assert.equal(rec.setActiveProject(undefined), '');
  assert.equal(rec.setActiveProject(123), '');
  assert.equal(rec.setActiveProject({}), '');
  assert.equal(rec.setActiveProject([]), '');
});

test('Unit: Multiple rows in same project accumulate per-model', () => {
  const rec = createTelemetryReceiver({ config: { enabled: true } });

  // Create logs with different models
  const haiku = {
    resourceLogs: [{
      resource: { attributes: [{ key: 'project', value: { stringValue: 'multi' } }] },
      scopeLogs: [{
        logRecords: [{
          body: { stringValue: 'claude_code.api_request' },
          attributes: [
            { key: 'session.id', value: { stringValue: 's1' } },
            { key: 'model', value: { stringValue: 'claude-haiku' } },
            { key: 'input_tokens', value: { intValue: 10 } },
            { key: 'output_tokens', value: { intValue: 20 } },
            { key: 'cache_read_tokens', value: { intValue: 100 } },
            { key: 'cache_creation_tokens', value: { intValue: 5 } },
            { key: 'cost_usd', value: { doubleValue: 0.01 } },
            { key: 'request_id', value: { stringValue: 'req_haiku' } },
          ],
        }],
      }],
    }],
  };

  const sonnet = {
    resourceLogs: [{
      resource: { attributes: [{ key: 'project', value: { stringValue: 'multi' } }] },
      scopeLogs: [{
        logRecords: [{
          body: { stringValue: 'claude_code.api_request' },
          attributes: [
            { key: 'session.id', value: { stringValue: 's1' } },
            { key: 'model', value: { stringValue: 'claude-sonnet' } },
            { key: 'input_tokens', value: { intValue: 100 } },
            { key: 'output_tokens', value: { intValue: 200 } },
            { key: 'cache_read_tokens', value: { intValue: 1000 } },
            { key: 'cache_creation_tokens', value: { intValue: 50 } },
            { key: 'cost_usd', value: { doubleValue: 0.10 } },
            { key: 'request_id', value: { stringValue: 'req_sonnet' } },
          ],
        }],
      }],
    }],
  };

  rec.ingestLogs(haiku);
  rec.ingestLogs(sonnet);

  const usage = rec.usageForProject('multi');
  assert.equal(usage.totals.requests, 2);
  assert.equal(usage.totals.inputTokens, 110);

  // Check per-model breakdown
  assert.ok(usage.byModel['claude-haiku']);
  assert.ok(usage.byModel['claude-sonnet']);
  assert.equal(usage.byModel['claude-haiku'].inputTokens, 10);
  assert.equal(usage.byModel['claude-sonnet'].inputTokens, 100);
});

test('Unit: Malformed logs never throw', () => {
  const rec = createTelemetryReceiver({ config: { enabled: true } });

  // Various junk payloads should not throw
  const junkPayloads = [null, undefined, {}, { resourceLogs: null }, 'string', 123];
  for (const payload of junkPayloads) {
    assert.doesNotThrow(() => rec.ingestLogs(payload), `junk payload did not throw`);
  }

  // Verify nothing was ingested
  const snapshot = rec.snapshotState();
  assert.equal(snapshot.usage.totals.requests, 0);
});

test('Unit: emit() with onUpdate that throws does not propagate', () => {
  const thrownErrors = [];
  const rec = createTelemetryReceiver({
    config: { enabled: true },
    onUpdate: () => { throw new Error('intentional'); },
    log: (msg, err) => { thrownErrors.push(err); },
  });

  // Should not throw even though onUpdate throws
  assert.doesNotThrow(() => rec.ingestLogs(logsPayload('req', 10, 'proj')));
});

test('Unit: Per-project recent capped at RECENT_CAP (500)', () => {
  const rec = createTelemetryReceiver({ config: { enabled: true } });

  // Ingest RECENT_CAP + 50 rows (550 total)
  for (let i = 0; i < 550; i++) {
    rec.ingestLogs(logsPayload(`req_${i}`, 10, 'proj'));
  }

  // Get the full project bucket info via getUsageForProject
  const result = rec.getUsageForProject('proj');

  // recent should be capped to last 100 (per getUsageForProject slice)
  assert.equal(result.recent.length, 100, 'recent capped to last 100 in getUsageForProject');

  // But usage should still include all 550
  assert.equal(result.usage.totals.requests, 550, 'usage includes all stored rows');
});

test('Unit: Global recent also capped at RECENT_CAP (500)', () => {
  const rec = createTelemetryReceiver({ config: { enabled: true } });

  // Ingest rows across multiple projects
  for (let i = 0; i < 600; i++) {
    const proj = i % 3 === 0 ? 'p1' : i % 3 === 1 ? 'p2' : 'p3';
    rec.ingestLogs(logsPayload(`req_${i}`, 10, proj));
  }

  // Global getUsage() returns global recent capped to 100
  const result = rec.getUsage();
  assert.equal(result.recent.length, 100, 'global recent capped to 100');
  assert.equal(result.usage.totals.requests, 600, 'but usage includes all rows from all buckets');
});
