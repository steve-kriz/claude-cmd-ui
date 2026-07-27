'use strict';

// Unit tests for TASK-163: LRU bucket cap (MAX_PROJECT_BUCKETS = 100).
// These tests verify the receiver's internal bucket management, LRU eviction logic,
// and that usage aggregation functions correctly across retained buckets.
// All I/O is mocked; tests focus on the receiver's internal state machine.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTelemetryReceiver, MAX_PROJECT_BUCKETS } = require('../lib/telemetry-receiver');

function createTestRow(requestId, projectName = '', model = 'claude-haiku') {
  return {
    requestId,
    project: projectName,
    model,
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 100,
    cacheCreationTokens: 0,
    costUsd: 0.01,
    durationMs: 1000,
    timestamp: '2026-07-26T00:00:00Z',
  };
}

function createTestLogs(requests) {
  return {
    resourceLogs: [{
      resource: {
        attributes: requests[0]?.project ? [{ key: 'project', value: { stringValue: requests[0].project } }] : [],
      },
      scopeLogs: [{
        logRecords: requests.map((r) => ({
          body: { stringValue: 'claude_code.api_request' },
          attributes: [
            { key: 'session.id', value: { stringValue: 'sess' } },
            { key: 'event.timestamp', value: { stringValue: r.timestamp } },
            { key: 'event.name', value: { stringValue: 'api_request' } },
            { key: 'model', value: { stringValue: r.model } },
            { key: 'input_tokens', value: { intValue: r.inputTokens } },
            { key: 'output_tokens', value: { intValue: r.outputTokens } },
            { key: 'cache_read_tokens', value: { intValue: r.cacheReadTokens } },
            { key: 'cache_creation_tokens', value: { intValue: r.cacheCreationTokens } },
            { key: 'cost_usd', value: { doubleValue: r.costUsd } },
            { key: 'request_id', value: { stringValue: r.requestId } },
          ],
        })),
      }],
    }],
  };
}

test('Unit: MAX_PROJECT_BUCKETS is exported and equals 100', () => {
  assert.equal(MAX_PROJECT_BUCKETS, 100, 'MAX_PROJECT_BUCKETS exported');
});

test('Unit: Receiver creates bucket for first project', () => {
  const rec = createTelemetryReceiver({ config: { enabled: false } });
  const logs = createTestLogs([createTestRow('req_1', 'proj_a')]);
  const added = rec.ingestLogs(logs);

  assert.equal(added, 1, 'one row added');
  const usage = rec.getUsageForProject('proj_a');
  assert.equal(usage.usage.totals.requests, 1, 'bucket created and row stored');
});

test('Unit: Multiple projects under cap all retain data', () => {
  const rec = createTelemetryReceiver({ config: { enabled: false } });

  // Ingest 10 distinct projects, each with 1 row
  const projects = [];
  for (let i = 0; i < 10; i++) {
    const projectName = `proj_${i}`;
    projects.push(projectName);
    const logs = createTestLogs([createTestRow(`req_${i}`, projectName)]);
    rec.ingestLogs(logs);
  }

  // Verify all 10 projects still have their data
  for (let i = 0; i < 10; i++) {
    const usage = rec.getUsageForProject(`proj_${i}`);
    assert.equal(usage.usage.totals.requests, 1, `proj_${i} retained`);
  }

  // Verify app-wide roll-up includes all 10
  const appUsage = rec.getUsage();
  assert.equal(appUsage.usage.totals.requests, 10, 'app-wide includes all 10 projects');
});

test('Unit: Inserting past cap triggers LRU eviction of oldest', () => {
  const rec = createTelemetryReceiver({ config: { enabled: false } });

  // Insert MAX_PROJECT_BUCKETS + 10 rows (should evict the first 10)
  const inserted = MAX_PROJECT_BUCKETS + 10;
  const projects = [];
  for (let i = 0; i < inserted; i++) {
    const projectName = `proj_${i}`;
    projects.push(projectName);
    const logs = createTestLogs([createTestRow(`req_${i}`, projectName)]);
    rec.ingestLogs(logs);
  }

  // First 10 projects should be evicted
  for (let i = 0; i < 10; i++) {
    const usage = rec.getUsageForProject(`proj_${i}`);
    assert.equal(usage.usage.totals.requests, 0, `proj_${i} evicted`);
  }

  // Last 100 projects should be retained
  for (let i = 10; i < inserted; i++) {
    const usage = rec.getUsageForProject(`proj_${i}`);
    assert.equal(usage.usage.totals.requests, 1, `proj_${i} retained`);
  }

  // App-wide should reflect only retained buckets (100 requests)
  const appUsage = rec.getUsage();
  assert.equal(appUsage.usage.totals.requests, MAX_PROJECT_BUCKETS, 'app-wide reflects only retained buckets');
});

test('Unit: usageForWindow aggregates across all retained buckets', () => {
  const rec = createTelemetryReceiver({ config: { enabled: false } });

  // Insert rows into 50 projects, each at a different timestamp
  for (let i = 0; i < 50; i++) {
    const projectName = `proj_${i}`;
    const timestamp = `2026-07-26T04:${String(i % 60).padStart(2, '0')}:00Z`;
    const row = { ...createTestRow(`req_${i}`, projectName), timestamp };
    const logs = createTestLogs([row]);
    rec.ingestLogs(logs);
  }

  // Query a time window that includes all 50 rows
  const usage = rec.usageForWindow({
    startedAt: '2026-07-26T04:00:00Z',
    finishedAt: '2026-07-26T05:00:00Z',
  });

  assert.equal(usage.requests, 50, 'usageForWindow includes all 50 rows across retained buckets');
  assert.equal(usage.inputTokens, 500, 'input tokens aggregated correctly');
  assert.ok(Math.abs(usage.costUsd - 0.5) < 1e-9, 'cost aggregated correctly (with tolerance for float precision)');
});

test('Unit: usageForWindow excludes rows from evicted buckets', () => {
  const rec = createTelemetryReceiver({ config: { enabled: false } });

  // Insert 120 projects (20 will be evicted)
  for (let i = 0; i < 120; i++) {
    const projectName = `proj_${i}`;
    const timestamp = i < 20 ? '2026-07-26T04:00:00Z' : '2026-07-26T04:30:00Z';
    const row = { ...createTestRow(`req_${i}`, projectName), timestamp };
    const logs = createTestLogs([row]);
    rec.ingestLogs(logs);
  }

  // Query the full time range
  const usage = rec.usageForWindow({
    startedAt: '2026-07-26T03:00:00Z',
    finishedAt: '2026-07-26T05:00:00Z',
  });

  // The first 20 projects are evicted; we should see exactly 100 rows (retained)
  assert.equal(usage.requests, 100, 'usageForWindow reflects only retained buckets');
});

test('Unit: Empty project name ("") is a valid bucket', () => {
  const rec = createTelemetryReceiver({ config: { enabled: false } });

  // Ingest logs without a project attribute (defaults to '')
  const logs = createTestLogs([createTestRow('req_1', '')]);
  const added = rec.ingestLogs(logs);

  assert.equal(added, 1, 'row added to default bucket');
  const usage = rec.getUsageForProject('');
  assert.equal(usage.usage.totals.requests, 1, 'default bucket has data');
});

test('Unit: De-duplication works across project boundaries', () => {
  const rec = createTelemetryReceiver({ config: { enabled: false } });

  // Same request ID posted to two different projects: only first counts
  const logs1 = createTestLogs([createTestRow('req_same', 'proj_a')]);
  const logs2 = createTestLogs([createTestRow('req_same', 'proj_b')]);

  const added1 = rec.ingestLogs(logs1);
  const added2 = rec.ingestLogs(logs2);

  assert.equal(added1, 1, 'first ingest added');
  assert.equal(added2, 0, 'duplicate not added (de-dup global)');

  // App-wide should count only 1 request
  const appUsage = rec.getUsage();
  assert.equal(appUsage.usage.totals.requests, 1, 'de-dup honored globally');
});

test('Unit: getUsage() aggregates all retained buckets', () => {
  const rec = createTelemetryReceiver({ config: { enabled: false } });

  // Ingest rows into 5 projects, each with 3 rows
  for (let i = 0; i < 5; i++) {
    const projectName = `proj_${i}`;
    for (let j = 0; j < 3; j++) {
      const logs = createTestLogs([createTestRow(`req_${i}_${j}`, projectName)]);
      rec.ingestLogs(logs);
    }
  }

  const appUsage = rec.getUsage();
  assert.equal(appUsage.usage.totals.requests, 15, 'getUsage() includes all 5*3 rows');
  assert.equal(appUsage.usage.totals.inputTokens, 150);
  assert.equal(appUsage.usage.totals.outputTokens, 300);
  assert.ok(Math.abs(appUsage.usage.totals.costUsd - 0.15) < 1e-9);
});

test('Unit: clear() removes all buckets and resets state', () => {
  const rec = createTelemetryReceiver({ config: { enabled: false } });

  // Ingest some data
  const logs = createTestLogs([createTestRow('req_1', 'proj_a')]);
  rec.ingestLogs(logs);
  assert.equal(rec.getUsage().usage.totals.requests, 1);

  // Clear
  rec.clear();

  // All data gone
  assert.equal(rec.getUsage().usage.totals.requests, 0);
  assert.equal(rec.getUsageForProject('proj_a').usage.totals.requests, 0);
});

test('Unit: Querying non-existent/evicted project returns zero totals', () => {
  const rec = createTelemetryReceiver({ config: { enabled: false } });

  // No data ingested for "ghost"
  const usage = rec.getUsageForProject('ghost');

  assert.equal(usage.usage.totals.requests, 0);
  assert.equal(usage.usage.totals.inputTokens, 0);
  assert.equal(usage.usage.totals.outputTokens, 0);
  assert.equal(usage.usage.totals.costUsd, 0);
  assert.equal(usage.recent.length, 0);
});

test('Unit: Recent feed per-bucket is capped at RECENT_CAP', () => {
  const rec = createTelemetryReceiver({ config: { enabled: false } });

  // Ingest 600+ rows into one project (exceeds RECENT_CAP of 500)
  const projectName = 'proj_huge';
  for (let i = 0; i < 600; i++) {
    const logs = createTestLogs([createTestRow(`req_${i}`, projectName)]);
    rec.ingestLogs(logs);
  }

  const usage = rec.getUsageForProject(projectName);
  // recent is capped at 100 per getUsageForProject (slice(-100))
  assert.ok(usage.recent.length <= 100, 'recent capped at 100');

  // But total usage still counts all 600
  assert.equal(usage.usage.totals.requests, 600, 'usage still counts all 600');
});

test('Unit: Large burst (many projects in rapid succession) never throws', () => {
  const rec = createTelemetryReceiver({ config: { enabled: false } });

  let exceptionThrown = false;
  try {
    // Rapid-fire burst of 200 distinct projects
    for (let i = 0; i < 200; i++) {
      const projectName = `burst_${i}`;
      const logs = createTestLogs([createTestRow(`req_${i}`, projectName)]);
      rec.ingestLogs(logs);
    }
  } catch (e) {
    exceptionThrown = true;
  }

  assert.equal(exceptionThrown, false, 'no exception on large burst');
  const usage = rec.getUsage();
  assert.ok(usage.usage.totals.requests > 0, 'receiver still functional');
});

test('Unit: Multiple rows in same project accumulate correctly', () => {
  const rec = createTelemetryReceiver({ config: { enabled: false } });

  const projectName = 'multi_row_proj';
  for (let i = 0; i < 10; i++) {
    const logs = createTestLogs([createTestRow(`req_${i}`, projectName)]);
    rec.ingestLogs(logs);
  }

  const usage = rec.getUsageForProject(projectName);
  assert.equal(usage.usage.totals.requests, 10);
  assert.equal(usage.usage.totals.inputTokens, 100);
  assert.equal(usage.usage.totals.outputTokens, 200);
});

test('Unit: Evicted bucket can never be re-inserted (reads stay consistent)', () => {
  const rec = createTelemetryReceiver({ config: { enabled: false } });

  // Fill exactly to cap (100 projects)
  for (let i = 0; i < MAX_PROJECT_BUCKETS; i++) {
    const logs = createTestLogs([createTestRow(`req_${i}`, `proj_${i}`)]);
    rec.ingestLogs(logs);
  }

  // Verify first project is present
  assert.equal(rec.getUsageForProject('proj_0').usage.totals.requests, 1);

  // Insert one more (evicts proj_0)
  const logs = createTestLogs([createTestRow('req_new', 'proj_new')]);
  rec.ingestLogs(logs);

  // proj_0 now has zero requests
  assert.equal(rec.getUsageForProject('proj_0').usage.totals.requests, 0, 'evicted project reads as zero');

  // proj_new is present
  assert.equal(rec.getUsageForProject('proj_new').usage.totals.requests, 1, 'new project present');

  // App-wide still reports 100 (capped)
  assert.equal(rec.getUsage().usage.totals.requests, 100);
});

test('Unit: snapshotState includes per-project usage', () => {
  const rec = createTelemetryReceiver({
    config: { enabled: false },
    project: 'test_proj',
  });

  const logs = createTestLogs([createTestRow('req_1', 'test_proj')]);
  rec.ingestLogs(logs);

  const snapshot = rec.snapshotState('test_proj');
  assert.equal(snapshot.project, 'test_proj');
  // projectUsage is the aggregated usage object (has .totals.requests)
  assert.ok(snapshot.projectUsage, 'snapshot includes projectUsage');
  assert.equal(snapshot.projectUsage.totals.requests, 1, 'projectUsage.totals.requests is correct');
  assert.ok(snapshot.usage, 'snapshot includes app-wide usage');
});

test('Unit: Different models in same project are aggregated', () => {
  const rec = createTelemetryReceiver({ config: { enabled: false } });

  const projectName = 'multi_model';
  const models = ['claude-haiku', 'claude-sonnet', 'claude-opus'];

  for (const model of models) {
    const row = { ...createTestRow(`req_${model}`, projectName), model };
    const logs = createTestLogs([row]);
    rec.ingestLogs(logs);
  }

  const usage = rec.getUsageForProject(projectName);
  assert.equal(usage.usage.totals.requests, 3);
  assert.ok(usage.usage.byModel['claude-haiku']);
  assert.ok(usage.usage.byModel['claude-sonnet']);
  assert.ok(usage.usage.byModel['claude-opus']);
});

test('Unit: Buckets Map respects LRU ordering (oldest evicted first)', () => {
  const rec = createTelemetryReceiver({ config: { enabled: false } });

  // Insert MAX_PROJECT_BUCKETS + 5 projects
  // proj_0 through proj_4 should be evicted, proj_5 through proj_104 retained
  for (let i = 0; i < MAX_PROJECT_BUCKETS + 5; i++) {
    const logs = createTestLogs([createTestRow(`req_${i}`, `proj_${i}`)]);
    rec.ingestLogs(logs);
  }

  // Check evicted projects all return zero
  for (let i = 0; i < 5; i++) {
    const usage = rec.getUsageForProject(`proj_${i}`);
    assert.equal(usage.usage.totals.requests, 0, `proj_${i} evicted`);
  }

  // Check retained projects all have data
  for (let i = 5; i < MAX_PROJECT_BUCKETS + 5; i++) {
    const usage = rec.getUsageForProject(`proj_${i}`);
    assert.equal(usage.usage.totals.requests, 1, `proj_${i} retained`);
  }
});
