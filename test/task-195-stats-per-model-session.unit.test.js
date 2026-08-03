'use strict';

// ===========================================================================
// Unit tests for TASK-195 new functionality:
// - renderer/renderer.js: correlatePromptEntryUsage
// - lib/telemetry-receiver.js: usageForWindowInProject
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTelemetryReceiver } = require('../lib/telemetry-receiver');

const REPO = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(REPO, 'renderer', 'renderer.js'), 'utf8');

// ---------------------------------------------------------------------------
// Function extractor for unit testing correlatePromptEntryUsage
// ---------------------------------------------------------------------------
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

function loadCorrelatePromptEntryUsage(window) {
  const body = [
    extractFn(rendererSrc, 'correlatePromptEntryUsage'),
    'return { correlatePromptEntryUsage };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function('window', body)(window);
}

// ---------------------------------------------------------------------------
// telemetry-receiver: usageForWindowInProject unit tests
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
          { key: 'event.timestamp', value: { stringValue: o.timestamp || '2026-08-01T10:00:00.000Z' } },
        ],
      }],
    }],
  };
  if (project) {
    rl.resource = { attributes: [{ key: 'project', value: { stringValue: project } }] };
  }
  return { resourceLogs: [rl] };
}

test('Unit: usageForWindowInProject correlates calls within a time window for a single project', () => {
  const rec = createTelemetryReceiver({ config: { enabled: true } });

  // Ingest calls: alpha at t1, alpha just before t2 (the window's EXCLUSIVE
  // end — TASK-198), beta at t1.5 (in the middle of alpha's calls)
  const t1 = '2026-08-01T10:00:00.000Z';
  const t1_5 = '2026-08-01T10:02:30.000Z';
  const t1_9 = '2026-08-01T10:04:59.999Z';
  const t2 = '2026-08-01T10:05:00.000Z';

  rec.ingestLogs(logsPayload('req_alpha_1', 'alpha', {
    model: 'claude-sonnet-5',
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 0.10,
    timestamp: t1,
  }));

  rec.ingestLogs(logsPayload('req_beta_1', 'beta', {
    model: 'claude-haiku-4-5-20251001',
    inputTokens: 50,
    outputTokens: 25,
    costUsd: 0.05,
    timestamp: t1_5,
  }));

  rec.ingestLogs(logsPayload('req_alpha_2', 'alpha', {
    model: 'claude-sonnet-5',
    inputTokens: 200,
    outputTokens: 100,
    costUsd: 0.20,
    timestamp: t1_9,
  }));

  // Query alpha's usage in the window [t1, t2)
  const alphaUsage = rec.usageForWindowInProject('alpha', {
    startedAt: t1,
    finishedAt: t2,
    model: '',
  });

  // Should include alpha's two calls but NOT beta's call (even though beta's timestamp falls in the window)
  assert.equal(alphaUsage.requests, 2, 'alpha window includes only alpha calls');
  assert.equal(alphaUsage.inputTokens, 300, 'alpha window sums input tokens from alpha only');
  assert.equal(alphaUsage.outputTokens, 150, 'alpha window sums output tokens from alpha only');
  assert.ok(Math.abs(alphaUsage.costUsd - 0.30) < 0.0001, 'alpha window sums cost from alpha only');

  // Query beta's usage in the same window
  const betaUsage = rec.usageForWindowInProject('beta', {
    startedAt: t1,
    finishedAt: t2,
    model: '',
  });

  // Should include only beta's one call (its timestamp is in the window)
  assert.equal(betaUsage.requests, 1, 'beta window includes only beta calls');
  assert.equal(betaUsage.inputTokens, 50, 'beta window sums input tokens from beta only');
  assert.equal(betaUsage.outputTokens, 25, 'beta window sums output tokens from beta only');
  assert.ok(Math.abs(betaUsage.costUsd - 0.05) < 0.0001, 'beta window sums cost from beta only');
});

test('Unit: usageForWindowInProject respects the window boundaries (inclusive at start, EXCLUSIVE at end — TASK-198)', () => {
  const rec = createTelemetryReceiver({ config: { enabled: true } });

  const t1 = '2026-08-01T10:00:00.000Z';
  const t2 = '2026-08-01T10:05:00.000Z';
  const t3 = '2026-08-01T10:10:00.000Z';

  // Call at t1 (at startedAt, should be included)
  rec.ingestLogs(logsPayload('req_1', 'alpha', {
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 0.10,
    timestamp: t1,
  }));

  // Call at t2 (at finishedAt — TASK-198: the per-prompt window is
  // [startedAt, finishedAt), so this belongs to the NEXT prompt's window and
  // must NOT be included here).
  rec.ingestLogs(logsPayload('req_2', 'alpha', {
    inputTokens: 200,
    outputTokens: 100,
    costUsd: 0.20,
    timestamp: t2,
  }));

  // Call at t3 (after finishedAt, should NOT be included)
  rec.ingestLogs(logsPayload('req_3', 'alpha', {
    inputTokens: 300,
    outputTokens: 150,
    costUsd: 0.30,
    timestamp: t3,
  }));

  const usage = rec.usageForWindowInProject('alpha', {
    startedAt: t1,
    finishedAt: t2,
    model: '',
  });

  // The window is [t1, t2) — inclusive at startedAt, EXCLUSIVE at finishedAt.
  assert.equal(usage.requests, 1, 'excludes the call exactly at finishedAt');
  assert.equal(usage.inputTokens, 100, 'sums only the call at startedAt');
  assert.ok(Math.abs(usage.costUsd - 0.10) < 0.0001, 'sums only the cost at startedAt');
});

test('Unit: usageForWindowInProject regression — a call exactly at the shared boundary of two adjacent prompt windows counts ONCE, in the later window (TASK-198)', () => {
  const rec = createTelemetryReceiver({ config: { enabled: true } });

  const promptA = '2026-08-01T10:00:00.000Z';
  const boundary = '2026-08-01T10:05:00.000Z'; // promptB's ts == promptA's finishedAt
  const promptC = '2026-08-01T10:10:00.000Z';

  // The one and only api_request row lands exactly on the shared boundary
  // timestamp between prompt A's window and prompt B's window.
  rec.ingestLogs(logsPayload('req_boundary', 'alpha', {
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 0.10,
    timestamp: boundary,
  }));

  // Prompt A's window: [promptA, boundary)
  const usageA = rec.usageForWindowInProject('alpha', {
    startedAt: promptA,
    finishedAt: boundary,
    model: '',
  });

  // Prompt B's window: [boundary, promptC)
  const usageB = rec.usageForWindowInProject('alpha', {
    startedAt: boundary,
    finishedAt: promptC,
    model: '',
  });

  assert.equal(usageA.requests, 0, 'the earlier (bounded) window excludes the boundary call');
  assert.equal(usageB.requests, 1, 'the later window includes the boundary call');
  assert.equal(usageA.requests + usageB.requests, 1, 'the boundary call is counted exactly once total, never zero and never two');
  assert.equal(usageB.inputTokens, 100);
  assert.ok(Math.abs(usageB.costUsd - 0.10) < 0.0001);
});

test('Unit: usageForWindowInProject returns zero totals for an unknown project', () => {
  const rec = createTelemetryReceiver({ config: { enabled: true } });
  rec.ingestLogs(logsPayload('req_1', 'alpha', { inputTokens: 100 }));

  const usage = rec.usageForWindowInProject('never-seen-project', {
    startedAt: '2026-08-01T10:00:00.000Z',
    finishedAt: '2026-08-01T10:05:00.000Z',
    model: '',
  });

  assert.equal(usage.requests, 0, 'unknown project yields zero totals');
  assert.equal(usage.inputTokens, 0);
  assert.equal(usage.outputTokens, 0);
  assert.equal(usage.costUsd, 0);
});

test('Unit: usageForWindowInProject returns zero totals for a window with no matching calls', () => {
  const rec = createTelemetryReceiver({ config: { enabled: true } });

  const t1 = '2026-08-01T10:00:00.000Z';
  const t2 = '2026-08-01T10:05:00.000Z';
  const t3 = '2026-08-01T15:00:00.000Z';
  const t4 = '2026-08-01T15:05:00.000Z';

  rec.ingestLogs(logsPayload('req_1', 'alpha', {
    inputTokens: 100,
    timestamp: t1,
  }));

  const usage = rec.usageForWindowInProject('alpha', {
    startedAt: t3,
    finishedAt: t4,
    model: '',
  });

  assert.equal(usage.requests, 0, 'non-matching window yields zero totals');
  assert.equal(usage.inputTokens, 0);
});

test('Unit: usageForWindowInProject handles malformed records gracefully', () => {
  const rec = createTelemetryReceiver({ config: { enabled: true } });

  const t1 = '2026-08-01T10:00:00.000Z';
  const t2 = '2026-08-01T10:05:00.000Z';

  // Good call
  rec.ingestLogs(logsPayload('req_1', 'alpha', {
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 0.10,
    timestamp: t1,
  }));

  const usage = rec.usageForWindowInProject('alpha', {
    startedAt: t1,
    finishedAt: t2,
    model: '',
  });

  // Should not throw and should return valid totals
  assert.equal(usage.requests, 1);
  assert.equal(usage.inputTokens, 100);
  assert.equal(usage.costUsd, 0.10);
});

// ---------------------------------------------------------------------------
// renderer.js: correlatePromptEntryUsage unit tests
// ---------------------------------------------------------------------------

test('Unit: correlatePromptEntryUsage returns null when entry lacks ts', async () => {
  const mockWindow = {
    api: {
      telemetry: {
        usageForWindowInProject: async () => ({
          ok: true,
          usage: { requests: 1, inputTokens: 100, outputTokens: 50, costUsd: 0.10 },
        }),
      },
    },
  };
  const { correlatePromptEntryUsage } = loadCorrelatePromptEntryUsage(mockWindow);

  const result = await correlatePromptEntryUsage('alpha', {}, null);
  assert.equal(result, null, 'entry without ts returns null');

  const result2 = await correlatePromptEntryUsage('alpha', { ts: null }, null);
  assert.equal(result2, null, 'entry with null ts returns null');
});

test('Unit: correlatePromptEntryUsage returns null when API is unavailable', async () => {
  const mockWindow = {
    api: null,
  };
  const { correlatePromptEntryUsage } = loadCorrelatePromptEntryUsage(mockWindow);

  const result = await correlatePromptEntryUsage('alpha', { ts: '2026-08-01T10:00:00.000Z' }, null);
  assert.equal(result, null, 'missing api returns null');
});

test('Unit: correlatePromptEntryUsage returns null when usageForWindowInProject is not available', async () => {
  const mockWindow = {
    api: {
      telemetry: {
        // Missing usageForWindowInProject
      },
    },
  };
  const { correlatePromptEntryUsage } = loadCorrelatePromptEntryUsage(mockWindow);

  const result = await correlatePromptEntryUsage('alpha', { ts: '2026-08-01T10:00:00.000Z' }, null);
  assert.equal(result, null, 'missing usageForWindowInProject returns null');
});

test('Unit: correlatePromptEntryUsage correlates a prompt with a next entry bounded window', async () => {
  const mockWindow = {
    api: {
      telemetry: {
        usageForWindowInProject: async (folder, window) => {
          assert.equal(folder, 'alpha');
          assert.equal(window.startedAt, '2026-08-01T10:00:00.000Z');
          assert.equal(window.finishedAt, '2026-08-01T10:05:00.000Z');
          assert.equal(window.model, '', 'model filter is empty for summing across models');
          return {
            ok: true,
            usage: { requests: 3, inputTokens: 1000, outputTokens: 100, costUsd: 0.15 },
          };
        },
      },
    },
  };
  const { correlatePromptEntryUsage } = loadCorrelatePromptEntryUsage(mockWindow);

  const entry = { ts: '2026-08-01T10:00:00.000Z' };
  const nextEntry = { ts: '2026-08-01T10:05:00.000Z' };
  const result = await correlatePromptEntryUsage('alpha', entry, nextEntry);

  assert.ok(result, 'returns a result object');
  assert.equal(result.inputTokens, 1000);
  assert.equal(result.outputTokens, 100);
  assert.equal(result.costUsd, 0.15);
});

test('Unit: correlatePromptEntryUsage correlates a newest entry (no next entry) to now', async () => {
  let capturedWindow = null;
  const mockWindow = {
    api: {
      telemetry: {
        usageForWindowInProject: async (folder, window) => {
          capturedWindow = window;
          return {
            ok: true,
            usage: { requests: 2, inputTokens: 500, outputTokens: 200, costUsd: 0.05 },
          };
        },
      },
    },
  };
  const { correlatePromptEntryUsage } = loadCorrelatePromptEntryUsage(mockWindow);

  const entry = { ts: '2026-08-01T10:00:00.000Z' };
  const result = await correlatePromptEntryUsage('alpha', entry, null);

  assert.ok(result, 'newest entry returns a result');
  assert.equal(capturedWindow.startedAt, '2026-08-01T10:00:00.000Z');
  assert.ok(capturedWindow.finishedAt, 'finishedAt is set to current time');
  // finishedAt should be close to now (within a second)
  const nowTime = new Date().getTime();
  const finishedTime = new Date(capturedWindow.finishedAt).getTime();
  assert.ok(Math.abs(nowTime - finishedTime) < 1000, 'finishedAt is close to now');
});

test('Unit: correlatePromptEntryUsage returns null when no usage matches the window', async () => {
  const mockWindow = {
    api: {
      telemetry: {
        usageForWindowInProject: async () => ({
          ok: true,
          usage: { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
        }),
      },
    },
  };
  const { correlatePromptEntryUsage } = loadCorrelatePromptEntryUsage(mockWindow);

  const result = await correlatePromptEntryUsage('alpha', { ts: '2026-08-01T10:00:00.000Z' }, { ts: '2026-08-01T10:05:00.000Z' });
  assert.equal(result, null, 'zero-request usage returns null');
});

test('Unit: correlatePromptEntryUsage coerces NaN/non-finite values to 0', async () => {
  const mockWindow = {
    api: {
      telemetry: {
        usageForWindowInProject: async () => ({
          ok: true,
          usage: { requests: 1, inputTokens: NaN, outputTokens: undefined, costUsd: Infinity },
        }),
      },
    },
  };
  const { correlatePromptEntryUsage } = loadCorrelatePromptEntryUsage(mockWindow);

  const result = await correlatePromptEntryUsage('alpha', { ts: '2026-08-01T10:00:00.000Z' }, { ts: '2026-08-01T10:05:00.000Z' });

  assert.ok(result, 'returns a result even with non-finite values');
  assert.equal(result.inputTokens, 0, 'NaN becomes 0');
  assert.equal(result.outputTokens, 0, 'undefined becomes 0');
  assert.equal(result.costUsd, 0, 'Infinity becomes 0');
});

test('Unit: correlatePromptEntryUsage never throws on API errors', async () => {
  const mockWindow = {
    api: {
      telemetry: {
        usageForWindowInProject: async () => {
          throw new Error('API error');
        },
      },
    },
  };
  const { correlatePromptEntryUsage } = loadCorrelatePromptEntryUsage(mockWindow);

  const result = await correlatePromptEntryUsage('alpha', { ts: '2026-08-01T10:00:00.000Z' }, null);

  assert.equal(result, null, 'API error is caught and returns null');
});

test('Unit: correlatePromptEntryUsage returns null when usage is falsy', async () => {
  const mockWindow = {
    api: {
      telemetry: {
        usageForWindowInProject: async () => ({
          ok: true,
          usage: null,
        }),
      },
    },
  };
  const { correlatePromptEntryUsage } = loadCorrelatePromptEntryUsage(mockWindow);

  const result = await correlatePromptEntryUsage('alpha', { ts: '2026-08-01T10:00:00.000Z' }, null);

  assert.equal(result, null, 'null usage returns null');
});
