'use strict';

// Unit tests for lib/tasks-settings.js — the Electron-free helpers backing the
// Tasks board's "parallel build" dropdown (TASK-019). Modelled on
// test/ticket-queue.test.js: node:test + node:assert/strict, pure require, no
// Electron/DOM/localStorage/network. resolveConcurrency (from lib/ticket-queue)
// is imported alongside so we can prove tasks-settings delegates ALL clamp/
// default behaviour to it — the single clamp authority.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  concurrencyOptions,
  readStoredConcurrency,
  buildConcurrencyCommand,
  storageKey,
} = require('../lib/tasks-settings');

const {
  resolveConcurrency,
  MAX_CONCURRENCY,
  DEFAULT_CONCURRENCY,
} = require('../lib/ticket-queue');

// ---------------------------------------------------------------------------
// concurrencyOptions — ascending [1 .. MAX_CONCURRENCY], derived from constant
// ---------------------------------------------------------------------------

test('concurrencyOptions returns exactly [1..8] ascending, length === MAX_CONCURRENCY', () => {
  assert.deepEqual(concurrencyOptions(), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(concurrencyOptions().length, MAX_CONCURRENCY);
});

test('concurrencyOptions ceiling tracks MAX_CONCURRENCY (last value + count), not a hard-coded 8', () => {
  const opts = concurrencyOptions();
  assert.equal(opts[opts.length - 1], MAX_CONCURRENCY, 'last option is the ceiling');
  assert.equal(opts.length, MAX_CONCURRENCY, 'one option per value up to the ceiling');
  // Strictly ascending with no gaps or duplicates.
  for (let i = 0; i < opts.length; i++) {
    assert.equal(opts[i], i + 1, `option ${i} is ${i + 1}`);
  }
});

// ---------------------------------------------------------------------------
// readStoredConcurrency — the full Examples table from the Gherkin
// ---------------------------------------------------------------------------

// [raw, resolved] pairs — the exact table from the ticket's Scenario Outline,
// plus the valid in-range values called for in the deliverables.
const EXAMPLES = [
  ['0', 1],
  ['-3', 1],
  ['9', 8],
  ['1000', 8],
  ['3.9', 3],
  ['', 3],
  [null, 3],
  ['abc', 3],
  ['{bad json', 3],
  ['5', 5],
  ['6', 6],
  [2, 2],
  [7, 7],
];

test('readStoredConcurrency resolves every Examples-table row correctly', () => {
  for (const [raw, expected] of EXAMPLES) {
    assert.equal(
      readStoredConcurrency(raw),
      expected,
      `readStoredConcurrency(${JSON.stringify(raw)}) should be ${expected}`,
    );
  }
});

test('readStoredConcurrency delegates to resolveConcurrency — single clamp authority', () => {
  // For every example, readStoredConcurrency(raw) must equal
  // resolveConcurrency(<parsed raw>). We parse raw the same way the helper does
  // (JSON.parse a trimmed string, else the trimmed string; blank/null pass
  // straight through) and cross-check the result.
  const parse = (raw) => {
    if (raw == null) return raw;
    if (typeof raw !== 'string') return raw;
    const trimmed = raw.trim();
    if (trimmed === '') return '';
    try {
      return JSON.parse(trimmed);
    } catch (_) {
      return trimmed;
    }
  };
  for (const [raw] of EXAMPLES) {
    assert.equal(
      readStoredConcurrency(raw),
      resolveConcurrency(parse(raw)),
      `readStoredConcurrency vs resolveConcurrency mismatch for ${JSON.stringify(raw)}`,
    );
  }
});

test('readStoredConcurrency never throws on any junk input', () => {
  const junk = [
    undefined, null, '', '   ', 'abc', '{bad json', '[', ']', '{}', '[]',
    'NaN', 'Infinity', '-Infinity', '0', '-0', '-999', '3.9', '9', '1000',
    'null', 'true', 'false', '"5"', {}, [], [3], NaN, Infinity, -Infinity,
    0, -1, 5, 8, 9, 1e9, 2.9,
  ];
  for (const v of junk) {
    let out;
    assert.doesNotThrow(() => { out = readStoredConcurrency(v); }, `threw on ${JSON.stringify(v)}`);
    assert.ok(Number.isInteger(out), `integer result for ${JSON.stringify(v)}: got ${out}`);
    assert.ok(out >= 1 && out <= MAX_CONCURRENCY, `in [1,${MAX_CONCURRENCY}] for ${JSON.stringify(v)}: got ${out}`);
  }
});

// ---------------------------------------------------------------------------
// buildConcurrencyCommand — appends a resolved --concurrency <N>
// ---------------------------------------------------------------------------

test('buildConcurrencyCommand appends --concurrency <N> for a valid value', () => {
  assert.equal(
    buildConcurrencyCommand('/orchestrate build', 5),
    '/orchestrate build --concurrency 5',
  );
});

test('buildConcurrencyCommand clamps an out-of-range value inside the command', () => {
  assert.equal(buildConcurrencyCommand('/orchestrate build', 99), '/orchestrate build --concurrency 8');
  assert.equal(buildConcurrencyCommand('/orchestrate build', 0), '/orchestrate build --concurrency 1');
  assert.equal(buildConcurrencyCommand('/orchestrate build', -4), '/orchestrate build --concurrency 1');
  assert.equal(buildConcurrencyCommand('/orchestrate build', 3.9), '/orchestrate build --concurrency 3');
  // Junk value collapses to the default inside the command.
  assert.equal(buildConcurrencyCommand('/orchestrate build', 'abc'), `/orchestrate build --concurrency ${DEFAULT_CONCURRENCY}`);
});

// ---------------------------------------------------------------------------
// storageKey — per-folder key, null when no folder open
// ---------------------------------------------------------------------------

test('storageKey builds the per-folder key and returns null with no folder', () => {
  assert.equal(storageKey('myfolder'), 'tasks:concurrency:myfolder');
  assert.equal(storageKey('C:/repo/tasks'), 'tasks:concurrency:C:/repo/tasks');
  assert.equal(storageKey(null), null);
  assert.equal(storageKey(''), null);
  assert.equal(storageKey(undefined), null);
});
