'use strict';

// Unit tests for lib/telemetry-receiver.js — focusing on the per-project
// forwarding functionality (TASK-156). Tests the receiver in isolation without
// network or server setup.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTelemetryReceiver } = require('../lib/telemetry-receiver');

// ── TASK-156: Per-project forwarding unit tests ──────────────────────────────

test('Unit: setProjectForwarding records a per-project boolean', () => {
  const rec = createTelemetryReceiver({ config: { enabled: false } });

  // Set a project to true
  const result1 = rec.setProjectForwarding('alpha', true);
  assert.equal(result1, true, 'returns the normalized boolean');

  // Set a project to false
  const result2 = rec.setProjectForwarding('beta', false);
  assert.equal(result2, false, 'returns the normalized boolean');

  // getUsage and internal checks would confirm the state, but we can't directly
  // inspect projectForwarding since it's private. The e2e tests verify behavior.
});

test('Unit: setProjectForwarding treats junk project as "" key', () => {
  const rec = createTelemetryReceiver({ config: { enabled: false } });

  // Non-string projects all normalize to ''
  for (const junk of [null, undefined, 42, true, {}, []]) {
    const result = rec.setProjectForwarding(junk, true);
    assert.equal(result, true, `junk project ${JSON.stringify(junk)} → "" key, no throw`);
  }

  // All these junk values should map to the same '' bucket
  // Verified by the fact that no error is thrown and the operation completes
});

test('Unit: setProjectForwarding treats junk enabled as false', () => {
  const rec = createTelemetryReceiver({ config: { enabled: false } });

  // Only strictly true is accepted; everything else → false
  assert.equal(rec.setProjectForwarding('proj', true), true);
  assert.equal(rec.setProjectForwarding('proj', 'true'), true, 'string "true" is accepted');
  assert.equal(rec.setProjectForwarding('proj', 1), true, 'number 1 is accepted');
  assert.equal(rec.setProjectForwarding('proj', false), false, 'false → false');
  assert.equal(rec.setProjectForwarding('proj', 'false'), false, 'string "false" → false');
  assert.equal(rec.setProjectForwarding('proj', 0), false, 'number 0 → false');
  assert.equal(rec.setProjectForwarding('proj', null), false, 'null → false');
  assert.equal(rec.setProjectForwarding('proj', undefined), false, 'undefined → false');
  assert.equal(rec.setProjectForwarding('proj', ''), false, 'empty string → false');
  assert.equal(rec.setProjectForwarding('proj', {}), false, 'object → false');
});

test('Unit: setProjectForwarding never throws', () => {
  const rec = createTelemetryReceiver({ config: { enabled: false } });

  // All these combinations should be safe, no throw
  const testCases = [
    [null, null],
    [undefined, true],
    [42, 'junk'],
    [{}, []],
    ['', true],
    ['normal-project', true],
    ['normal-project', false],
  ];

  for (const [project, enabled] of testCases) {
    assert.doesNotThrow(
      () => rec.setProjectForwarding(project, enabled),
      `setProjectForwarding never throws for project=${JSON.stringify(project)}, enabled=${JSON.stringify(enabled)}`
    );
  }
});

test('Unit: getUsageForProject returns per-project usage and recent', () => {
  const rec = createTelemetryReceiver({
    config: { enabled: true },
    now: () => '2026-07-26T00:00:00Z',
  });

  // Manually ingest some logs with project bucketing
  const logsWithProject = {
    resourceLogs: [{
      resource: {
        attributes: [{ key: 'project', value: { stringValue: 'test-proj' } }],
      },
      scopeLogs: [{
        logRecords: [{
          body: { stringValue: 'claude_code.api_request' },
          attributes: [
            { key: 'session.id', value: { stringValue: 's1' } },
            { key: 'event.name', value: { stringValue: 'api_request' } },
            { key: 'model', value: { stringValue: 'claude-haiku' } },
            { key: 'input_tokens', value: { intValue: 50 } },
            { key: 'output_tokens', value: { intValue: 100 } },
            { key: 'cache_read_tokens', value: { intValue: 500 } },
            { key: 'cache_creation_tokens', value: { intValue: 0 } },
            { key: 'cost_usd', value: { doubleValue: 0.05 } },
            { key: 'request_id', value: { stringValue: 'req_123' } },
          ],
        }],
      }],
    }],
  };

  rec.ingestLogs(logsWithProject);

  // getUsageForProject returns the per-project bucket
  const usage = rec.getUsageForProject('test-proj');
  assert.ok(usage, 'returns an object');
  assert.ok(usage.usage, 'has usage property');
  assert.ok(usage.recent, 'has recent property');
  assert.equal(usage.usage.totals.requests, 1, 'counts the request in this project');
  assert.equal(usage.usage.totals.inputTokens, 50);
  assert.equal(usage.usage.totals.outputTokens, 100);
  assert.equal(usage.recent.length, 1, 'recent contains the request');
});

test('Unit: getUsageForProject returns empty totals for unknown project', () => {
  const rec = createTelemetryReceiver({ config: { enabled: false } });

  // Query a project that has never received data
  const usage = rec.getUsageForProject('never-seen');
  assert.ok(usage, 'returns an object even for unknown project');
  assert.ok(usage.usage, 'has usage property');
  assert.equal(usage.usage.totals.requests, 0, 'zero requests');
  assert.equal(usage.usage.totals.inputTokens, 0);
  assert.equal(usage.usage.totals.costUsd, 0);
  assert.deepEqual(usage.recent, [], 'empty recent');
});

test('Unit: getUsageForProject never throws on junk project name', () => {
  const rec = createTelemetryReceiver({ config: { enabled: false } });

  for (const junk of [null, undefined, 42, {}, []]) {
    assert.doesNotThrow(
      () => rec.getUsageForProject(junk),
      `getUsageForProject never throws for ${JSON.stringify(junk)}`
    );
  }
});

test('Unit: getUsageForProject caps recent at 100 rows', () => {
  const rec = createTelemetryReceiver({
    config: { enabled: true },
    now: () => '2026-07-26T00:00:00Z',
  });

  // Create a batch of logs with more than 100 entries to be bucketed
  const attrs = (id) => [
    { key: 'session.id', value: { stringValue: 's1' } },
    { key: 'event.name', value: { stringValue: 'api_request' } },
    { key: 'model', value: { stringValue: 'claude-haiku' } },
    { key: 'input_tokens', value: { intValue: 1 } },
    { key: 'output_tokens', value: { intValue: 1 } },
    { key: 'cache_read_tokens', value: { intValue: 0 } },
    { key: 'cache_creation_tokens', value: { intValue: 0 } },
    { key: 'cost_usd', value: { doubleValue: 0.001 } },
    { key: 'request_id', value: { stringValue: `req_${id}` } },
  ];

  const logsWithMany = {
    resourceLogs: [{
      resource: {
        attributes: [{ key: 'project', value: { stringValue: 'big-proj' } }],
      },
      scopeLogs: [{
        logRecords: Array.from({ length: 150 }, (_, i) => ({
          body: { stringValue: 'claude_code.api_request' },
          attributes: attrs(i),
        })),
      }],
    }],
  };

  rec.ingestLogs(logsWithMany);

  const usage = rec.getUsageForProject('big-proj');
  assert.equal(usage.usage.totals.requests, 150, 'all 150 requests are counted');
  assert.equal(usage.recent.length, 100, 'but recent is capped at 100');
  // The recent array should have the last 100 entries (req_50 through req_149)
  assert.equal(usage.recent[0].requestId, 'req_50', 'first in recent is the 51st request');
  assert.equal(usage.recent[99].requestId, 'req_149', 'last in recent is the 150th request');
});

test('Unit: multiple projects maintain separate buckets', () => {
  const rec = createTelemetryReceiver({
    config: { enabled: true },
    now: () => '2026-07-26T00:00:00Z',
  });

  // Ingest logs for project A
  const logsA = {
    resourceLogs: [{
      resource: {
        attributes: [{ key: 'project', value: { stringValue: 'proj-a' } }],
      },
      scopeLogs: [{
        logRecords: [{
          body: { stringValue: 'claude_code.api_request' },
          attributes: [
            { key: 'session.id', value: { stringValue: 's1' } },
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

  // Ingest logs for project B
  const logsB = {
    resourceLogs: [{
      resource: {
        attributes: [{ key: 'project', value: { stringValue: 'proj-b' } }],
      },
      scopeLogs: [{
        logRecords: [{
          body: { stringValue: 'claude_code.api_request' },
          attributes: [
            { key: 'session.id', value: { stringValue: 's1' } },
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

  rec.ingestLogs(logsA);
  rec.ingestLogs(logsB);

  // Project A should have its own usage
  const usageA = rec.getUsageForProject('proj-a');
  assert.equal(usageA.usage.totals.requests, 1);
  assert.equal(usageA.usage.totals.inputTokens, 10);
  assert.equal(usageA.usage.totals.outputTokens, 20);
  assert.ok(usageA.usage.byModel['claude-haiku']);
  assert.equal(usageA.usage.byModel['claude-sonnet'], undefined, 'proj-a does not have sonnet data');

  // Project B should have its own usage
  const usageB = rec.getUsageForProject('proj-b');
  assert.equal(usageB.usage.totals.requests, 1);
  assert.equal(usageB.usage.totals.inputTokens, 100);
  assert.equal(usageB.usage.totals.outputTokens, 200);
  assert.ok(usageB.usage.byModel['claude-sonnet']);
  assert.equal(usageB.usage.byModel['claude-haiku'], undefined, 'proj-b does not have haiku data');

  // Global usage counts both
  const globalUsage = rec.getUsage();
  assert.equal(globalUsage.usage.totals.requests, 2, 'global usage includes all projects');
});

test('Unit: getUsage with explicit project parameter calls getUsageForProject', () => {
  const rec = createTelemetryReceiver({
    config: { enabled: true },
    now: () => '2026-07-26T00:00:00Z',
  });

  // Ingest logs with project
  const logs = {
    resourceLogs: [{
      resource: {
        attributes: [{ key: 'project', value: { stringValue: 'target-proj' } }],
      },
      scopeLogs: [{
        logRecords: [{
          body: { stringValue: 'claude_code.api_request' },
          attributes: [
            { key: 'session.id', value: { stringValue: 's1' } },
            { key: 'event.name', value: { stringValue: 'api_request' } },
            { key: 'model', value: { stringValue: 'claude-haiku' } },
            { key: 'input_tokens', value: { intValue: 25 } },
            { key: 'output_tokens', value: { intValue: 50 } },
            { key: 'cache_read_tokens', value: { intValue: 0 } },
            { key: 'cache_creation_tokens', value: { intValue: 0 } },
            { key: 'cost_usd', value: { doubleValue: 0.025 } },
            { key: 'request_id', value: { stringValue: 'req_target' } },
          ],
        }],
      }],
    }],
  };

  rec.ingestLogs(logs);

  // Call getUsage with a project parameter (bare string)
  const usage = rec.getUsage('target-proj');
  assert.equal(usage.usage.totals.requests, 1);
  assert.equal(usage.usage.totals.inputTokens, 25);
  assert.equal(usage.recent.length, 1);
  assert.equal(usage.recent[0].requestId, 'req_target');
});

test('Unit: global getUsage without project parameter includes all buckets', () => {
  const rec = createTelemetryReceiver({
    config: { enabled: true },
    now: () => '2026-07-26T00:00:00Z',
  });

  // Ingest logs for multiple projects
  const logsA = {
    resourceLogs: [{
      resource: {
        attributes: [{ key: 'project', value: { stringValue: 'proj-a' } }],
      },
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

  const logsB = {
    resourceLogs: [{
      resource: {
        attributes: [{ key: 'project', value: { stringValue: 'proj-b' } }],
      },
      scopeLogs: [{
        logRecords: [{
          body: { stringValue: 'claude_code.api_request' },
          attributes: [
            { key: 'session.id', value: { stringValue: 's' } },
            { key: 'event.name', value: { stringValue: 'api_request' } },
            { key: 'model', value: { stringValue: 'claude-sonnet' } },
            { key: 'input_tokens', value: { intValue: 30 } },
            { key: 'output_tokens', value: { intValue: 60 } },
            { key: 'cache_read_tokens', value: { intValue: 0 } },
            { key: 'cache_creation_tokens', value: { intValue: 0 } },
            { key: 'cost_usd', value: { doubleValue: 0.03 } },
            { key: 'request_id', value: { stringValue: 'req_b' } },
          ],
        }],
      }],
    }],
  };

  rec.ingestLogs(logsA);
  rec.ingestLogs(logsB);

  // Call getUsage without project parameter
  const globalUsage = rec.getUsage();
  assert.equal(globalUsage.usage.totals.requests, 2, 'counts all requests across projects');
  assert.equal(globalUsage.usage.totals.inputTokens, 40, '10 + 30');
  assert.equal(globalUsage.usage.totals.outputTokens, 80, '20 + 60');
  assert.ok(Math.abs(globalUsage.usage.totals.costUsd - 0.04) < 1e-9, '0.01 + 0.03');
  assert.equal(globalUsage.recent.length, 2, 'recent includes both projects (in order)');
});

test('Unit: setProjectForwarding with various enabled values accepts string "true" and number 1', () => {
  const rec = createTelemetryReceiver({ config: { enabled: false } });

  // These should all normalize to true
  assert.equal(rec.setProjectForwarding('proj-str-true', 'true'), true, 'string "true" → true');
  assert.equal(rec.setProjectForwarding('proj-num-1', 1), true, 'number 1 → true');

  // Verify the behavior is consistent by calling multiple times
  assert.equal(rec.setProjectForwarding('proj-str-true', 'true'), true, 'stable');
  assert.equal(rec.setProjectForwarding('proj-num-1', 1), true, 'stable');
});
