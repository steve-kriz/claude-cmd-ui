'use strict';

// E2E / scenario-style tests for TASK-146: live cost correlation with model-family
// tie-breaker. These drive the real exported functions from lib/telemetry.js
// (usageForWindow, modelFamily) with Given/When/Then structure matching the ticket's
// Gherkin acceptance criteria. All I/O is mocked; lib/telemetry.js is pure.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const t = require('../lib/telemetry');

// --- Scenario: Short label matches full dated telemetry model ---

test('Scenario: Short label matches full dated telemetry model', () => {
  // GIVEN an api_request row inside the window with model "claude-haiku-4-5-20251001"
  const rows = [
    {
      timestamp: '2026-07-26T04:15:00Z',
      model: 'claude-haiku-4-5-20251001',
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 100,
      cacheCreationTokens: 0,
      costUsd: 0.0032705,
      durationMs: 1543,
    },
  ];

  // AND an activity whose persisted model is "claude-haiku-4-5"
  const window = {
    startedAt: '2026-07-26T04:00:00Z',
    finishedAt: '2026-07-26T05:00:00Z',
    model: 'claude-haiku-4-5',
  };

  // WHEN the modal correlates usage for that activity
  const usage = t.usageForWindow(rows, window);

  // THEN the row is included and its usage is returned (non-zero)
  assert.equal(usage.requests, 1, 'Row should be included via model-family match');
  assert.equal(usage.inputTokens, 10, 'Input tokens match the row');
  assert.equal(usage.outputTokens, 5, 'Output tokens match the row');
  assert.equal(usage.cacheReadTokens, 100, 'Cache read tokens match the row');
  assert.equal(usage.cacheCreationTokens, 0, 'Cache creation tokens match the row');
  assert.ok(Math.abs(usage.costUsd - 0.0032705) < 1e-9, 'Cost is returned (non-zero)');
  assert.equal(usage.durationMs, 1543, 'Duration matches the row');
});

// --- Scenario: Time window still bounds the match ---

test('Scenario: Time window still bounds the match', () => {
  // GIVEN a row with a matching model family but a timestamp outside the window
  const rows = [
    {
      timestamp: '2026-07-26T05:30:00Z', // Outside the window
      model: 'claude-haiku-4-5-20251001',
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.01,
    },
  ];

  // AND an activity with the same model family
  const window = {
    startedAt: '2026-07-26T04:00:00Z',
    finishedAt: '2026-07-26T05:00:00Z', // Row timestamp is after this
    model: 'claude-haiku-4-5',
  };

  // WHEN correlation runs
  const usage = t.usageForWindow(rows, window);

  // THEN the row is excluded
  assert.equal(usage.requests, 0, 'Row outside the time window should be excluded');
  assert.deepEqual(usage, t.emptyTotals(), 'Result should be all zeros');
});

// --- Scenario (edge): Genuinely different model families ---

test('Scenario (edge): Genuinely different model families', () => {
  // GIVEN the fix uses a normalized-family match
  // (verified by implementation: modelFamily() strips dated suffix)

  // AND a row whose model family differs from the activity's model
  const rows = [
    {
      timestamp: '2026-07-26T04:15:00Z',
      model: 'claude-sonnet-4-5-20251001', // Different family (sonnet vs haiku)
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.05,
    },
  ];

  // AND an activity with a different model family
  const window = {
    startedAt: '2026-07-26T04:00:00Z',
    finishedAt: '2026-07-26T05:00:00Z',
    model: 'claude-haiku-4-5', // haiku, not sonnet
  };

  // WHEN correlation runs
  const usage = t.usageForWindow(rows, window);

  // THEN the row is excluded
  assert.equal(usage.requests, 0, 'Genuinely different families should be excluded');
  assert.deepEqual(usage, t.emptyTotals(), 'Result should be all zeros');
});

// --- Scenario (edge): Empty model on either side is not a filter ---

test('Scenario (edge): Empty model on either side is not a filter', () => {
  // GIVEN a row with a dated model and empty window.model
  const rows1 = [
    {
      timestamp: '2026-07-26T04:15:00Z',
      model: 'claude-haiku-4-5-20251001',
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.01,
    },
  ];

  const window1 = {
    startedAt: '2026-07-26T04:00:00Z',
    finishedAt: '2026-07-26T05:00:00Z',
    model: '', // Empty model
  };

  // WHEN correlation runs with empty window.model
  let usage = t.usageForWindow(rows1, window1);

  // THEN the model comparison never excludes the row
  assert.equal(usage.requests, 1, 'Empty window.model should not filter rows');
  assert.equal(usage.inputTokens, 10);
  assert.equal(usage.costUsd, 0.01);

  // ALSO GIVEN a row with empty model and a window with a model
  const rows2 = [
    {
      timestamp: '2026-07-26T04:15:00Z',
      model: '', // Empty model
      inputTokens: 15,
      outputTokens: 7,
      costUsd: 0.02,
    },
  ];

  const window2 = {
    startedAt: '2026-07-26T04:00:00Z',
    finishedAt: '2026-07-26T05:00:00Z',
    model: 'claude-haiku-4-5',
  };

  // WHEN correlation runs with empty row.model
  usage = t.usageForWindow(rows2, window2);

  // THEN the model comparison never excludes the row
  assert.equal(usage.requests, 1, 'Empty row.model should not filter rows');
  assert.equal(usage.inputTokens, 15);
  assert.equal(usage.costUsd, 0.02);
});

// --- Scenario (junk-safety): modelFamily never throws on bad input ---

test('Scenario (junk-safety): modelFamily never throws on null/non-string/no-suffix', () => {
  // GIVEN modelFamily is called with various junk inputs

  // WHEN modelFamily encounters null
  assert.doesNotThrow(() => {
    const result = t.modelFamily(null);
    assert.equal(result, '', 'null → empty string');
  }, 'Never throws on null');

  // WHEN modelFamily encounters undefined
  assert.doesNotThrow(() => {
    const result = t.modelFamily(undefined);
    assert.equal(result, '', 'undefined → empty string');
  }, 'Never throws on undefined');

  // WHEN modelFamily encounters a number
  assert.doesNotThrow(() => {
    const result = t.modelFamily(42);
    assert.equal(result, '42', 'number → coerced to string, no suffix to strip');
  }, 'Never throws on number');

  // WHEN modelFamily encounters a string without a dated suffix
  assert.doesNotThrow(() => {
    const result = t.modelFamily('claude-haiku-4-5');
    assert.equal(result, 'claude-haiku-4-5', 'no suffix → unchanged');
  }, 'Never throws on string without suffix');

  // WHEN modelFamily encounters an empty string
  assert.doesNotThrow(() => {
    const result = t.modelFamily('');
    assert.equal(result, '', 'empty string → empty string');
  }, 'Never throws on empty string');

  // THEN modelFamily never throws
  assert.ok(true, 'All junk inputs handled safely');
});

// --- Scenario (unit): modelFamily recognizes both date formats ---

test('Scenario (unit): modelFamily strips both YYYYMMDD and YYYY-MM-DD suffix formats', () => {
  // GIVEN a model string with YYYYMMDD format (e.g., -20251001)
  const family1 = t.modelFamily('claude-haiku-4-5-20251001');

  // WHEN normalized
  assert.equal(family1, 'claude-haiku-4-5', 'YYYYMMDD suffix stripped');

  // GIVEN a model string with YYYY-MM-DD format (e.g., -2025-10-01)
  const family2 = t.modelFamily('claude-3-5-sonnet-2025-10-01');

  // WHEN normalized
  assert.equal(family2, 'claude-3-5-sonnet', 'YYYY-MM-DD suffix stripped');
});

// --- Multi-row correlation: comprehensive scenario ---

test('Scenario: Multi-row window correlation with mixed families and dates', () => {
  // GIVEN multiple rows with both dated and non-dated models, matching and non-matching families
  const rows = [
    // Matching family, in window, with dated suffix
    {
      timestamp: '2026-07-26T04:15:00Z',
      model: 'claude-haiku-4-5-20251001',
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.01,
    },
    // Matching family, in window, without dated suffix
    {
      timestamp: '2026-07-26T04:16:00Z',
      model: 'claude-haiku-4-5',
      inputTokens: 5,
      outputTokens: 2,
      costUsd: 0.005,
    },
    // Different family, in window (should be excluded)
    {
      timestamp: '2026-07-26T04:17:00Z',
      model: 'claude-sonnet-4-5-20251001',
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.1,
    },
    // Matching family, outside window (should be excluded)
    {
      timestamp: '2026-07-26T05:15:00Z',
      model: 'claude-haiku-4-5-20251001',
      inputTokens: 8,
      outputTokens: 3,
      costUsd: 0.008,
    },
    // Empty model, in window (should be included)
    {
      timestamp: '2026-07-26T04:18:00Z',
      model: '',
      inputTokens: 2,
      outputTokens: 1,
      costUsd: 0.002,
    },
  ];

  // AND an activity with model "claude-haiku-4-5"
  const window = {
    startedAt: '2026-07-26T04:00:00Z',
    finishedAt: '2026-07-26T05:00:00Z',
    model: 'claude-haiku-4-5',
  };

  // WHEN correlation runs
  const usage = t.usageForWindow(rows, window);

  // THEN exactly the matching-family and empty-model rows in the window are included
  assert.equal(usage.requests, 3, 'Three rows: 2 matching haiku + 1 empty model');
  assert.equal(usage.inputTokens, 17, '10 + 5 + 2');
  assert.equal(usage.outputTokens, 8, '5 + 2 + 1');
  assert.ok(Math.abs(usage.costUsd - 0.017) < 1e-9, '0.01 + 0.005 + 0.002');
});

// --- Scenario: Empty window model disables filter entirely ---

test('Scenario: Empty window model disables model filter (time window only)', () => {
  // GIVEN rows from different model families, all inside the time window
  const rows = [
    {
      timestamp: '2026-07-26T04:15:00Z',
      model: 'claude-haiku-4-5-20251001',
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.01,
    },
    {
      timestamp: '2026-07-26T04:16:00Z',
      model: 'claude-sonnet-4-5-20251001',
      inputTokens: 20,
      outputTokens: 10,
      costUsd: 0.02,
    },
  ];

  // AND an activity with an empty model
  const window = {
    startedAt: '2026-07-26T04:00:00Z',
    finishedAt: '2026-07-26T05:00:00Z',
    model: '', // Empty: no model filter
  };

  // WHEN correlation runs
  const usage = t.usageForWindow(rows, window);

  // THEN all rows within the time window are included regardless of family
  assert.equal(usage.requests, 2, 'Both rows included; empty model disables filter');
  assert.equal(usage.inputTokens, 30, '10 + 20');
  assert.equal(usage.outputTokens, 15, '5 + 10');
  assert.ok(Math.abs(usage.costUsd - 0.03) < 1e-9, '0.01 + 0.02');
});
