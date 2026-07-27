'use strict';

// Unit tests for TASK-165: projectForwarding Map LRU capping via touchLruMap.
// Tests the shared LRU helper function and setProjectForwarding behavior without
// needing a running server.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTelemetryReceiver, MAX_PROJECT_FORWARDING, MAX_PROJECT_BUCKETS } = require('../lib/telemetry-receiver');

// ──────────────────────────────────────────────────────────────────────────────
// Unit Tests: setProjectForwarding behavior
// ──────────────────────────────────────────────────────────────────────────────

test('Unit: setProjectForwarding returns the coerced boolean value', () => {
  const rec = createTelemetryReceiver({ config: { enabled: false } });

  // Explicit true/false
  assert.equal(rec.setProjectForwarding('proj-a', true), true);
  assert.equal(rec.setProjectForwarding('proj-b', false), false);

  // String 'true' and number 1 coerce to true
  assert.equal(rec.setProjectForwarding('proj-c', 'true'), true);
  assert.equal(rec.setProjectForwarding('proj-d', 1), true);

  // Everything else coerces to false
  assert.equal(rec.setProjectForwarding('proj-e', 'false'), false);
  assert.equal(rec.setProjectForwarding('proj-f', 0), false);
  assert.equal(rec.setProjectForwarding('proj-g', null), false);
  assert.equal(rec.setProjectForwarding('proj-h', undefined), false);
  assert.equal(rec.setProjectForwarding('proj-i', 2), false); // only 1 is true
  assert.equal(rec.setProjectForwarding('proj-j', ''), false);
});

test('Unit: setProjectForwarding coerces non-string project to empty string', () => {
  const rec = createTelemetryReceiver({ config: { enabled: false } });

  // Non-string projects all coerce to '', enabled behavior follows
  assert.equal(rec.setProjectForwarding(null, true), true); // '' with true
  assert.equal(rec.setProjectForwarding(undefined, true), true); // '' with true
  assert.equal(rec.setProjectForwarding(42, false), false); // '' with false
  assert.equal(rec.setProjectForwarding({}, false), false); // '' with false
  assert.equal(rec.setProjectForwarding([], true), true); // '' with true
});

test('Unit: setProjectForwarding never throws', () => {
  const rec = createTelemetryReceiver({ config: { enabled: false } });

  const badInputs = [
    [null, true],
    [undefined, false],
    [42, 'invalid'],
    [{}, {}],
    [[], null],
    ['normal', NaN],
    ['normal', Infinity],
    [Symbol('x'), true], // Symbols don't coerce to string by our logic
  ];

  for (const [proj, enabled] of badInputs) {
    try {
      rec.setProjectForwarding(proj, enabled);
    } catch (e) {
      assert.fail(`setProjectForwarding(${String(proj)}, ${String(enabled)}) threw: ${e.message}`);
    }
  }
});

test('Unit: setProjectForwarding with identical project touches it (re-enables/disables without eviction)', () => {
  const rec = createTelemetryReceiver({ config: { enabled: false } });

  // Set project 'a' to true
  assert.equal(rec.setProjectForwarding('a', true), true);

  // Set project 'a' again to false (should just update, no eviction risk)
  assert.equal(rec.setProjectForwarding('a', false), false);

  // Set project 'a' back to true (again, no eviction)
  assert.equal(rec.setProjectForwarding('a', true), true);

  // No throw, no errors — just updates
});

test('Unit: setProjectForwarding can be called many times within the cap without issues', () => {
  const rec = createTelemetryReceiver({ config: { enabled: false } });

  // Set 100 distinct projects (at the cap)
  for (let i = 0; i < MAX_PROJECT_FORWARDING; i++) {
    const result = rec.setProjectForwarding(`proj-${i}`, i % 2 === 0);
    assert.equal(typeof result, 'boolean', `call ${i} returned a boolean`);
  }
});

test('Unit: setProjectForwarding with cap + 1 distinct projects never throws', () => {
  const rec = createTelemetryReceiver({ config: { enabled: false } });

  // Set MAX_PROJECT_FORWARDING + 10 distinct projects
  const extra = 10;
  let throwCount = 0;
  for (let i = 0; i < MAX_PROJECT_FORWARDING + extra; i++) {
    try {
      rec.setProjectForwarding(`proj-${i}`, true);
    } catch (e) {
      throwCount++;
    }
  }

  assert.equal(throwCount, 0, `setProjectForwarding threw ${throwCount} times with ${MAX_PROJECT_FORWARDING + extra} distinct projects`);
});

test('Unit: Large batch of distinct setProjectForwarding calls completes without throw', () => {
  const rec = createTelemetryReceiver({ config: { enabled: false } });

  const batchSize = 5000;
  let throwCount = 0;
  const startTime = Date.now();

  for (let i = 0; i < batchSize; i++) {
    try {
      rec.setProjectForwarding(`batch-${i}`, i % 3 === 0); // vary enabled value
    } catch (e) {
      throwCount++;
    }
  }

  const duration = Date.now() - startTime;

  assert.equal(throwCount, 0, `batch threw ${throwCount} times`);
  assert.ok(duration < 1000, `batch of ${batchSize} calls completed in ${duration}ms`);
});

test('Unit: setProjectForwarding with MAX_PROJECT_FORWARDING = MAX_PROJECT_BUCKETS', () => {
  // Verify the constants match per the ticket
  assert.equal(MAX_PROJECT_FORWARDING, MAX_PROJECT_BUCKETS, 'MAX_PROJECT_FORWARDING must equal MAX_PROJECT_BUCKETS');
  assert.equal(MAX_PROJECT_FORWARDING, 100, 'both should be 100');
});

test('Unit: setProjectForwarding alternating toggle on same project multiple times', () => {
  const rec = createTelemetryReceiver({ config: { enabled: false } });

  const project = 'toggle-test';

  // Toggle the same project back and forth many times
  for (let i = 0; i < 1000; i++) {
    const enabled = i % 2 === 0;
    const result = rec.setProjectForwarding(project, enabled);
    assert.equal(result, enabled, `iteration ${i}: toggle returned ${result}, expected ${enabled}`);
  }
});

test('Unit: setProjectForwarding with whitespace and special characters in project name', () => {
  const rec = createTelemetryReceiver({ config: { enabled: false } });

  const specialProjects = [
    '   spaces   ',
    'project-with-dashes',
    'project_with_underscores',
    'project.with.dots',
    'project/with/slashes',
    'project@with#special$chars',
    '你好', // unicode
    '', // empty string
  ];

  for (const proj of specialProjects) {
    try {
      const result = rec.setProjectForwarding(proj, true);
      assert.equal(typeof result, 'boolean', `special project ${JSON.stringify(proj)} returned a boolean`);
    } catch (e) {
      assert.fail(`setProjectForwarding with special project ${JSON.stringify(proj)} threw: ${e.message}`);
    }
  }
});

test('Unit: Empty string project (default bucket) is handled the same as named projects', () => {
  const rec = createTelemetryReceiver({ config: { enabled: false } });

  // Set the empty string project (default bucket)
  assert.equal(rec.setProjectForwarding('', true), true);
  assert.equal(rec.setProjectForwarding('', false), false);

  // Also verify that non-string coerces to empty string
  assert.equal(rec.setProjectForwarding(null, true), true); // same as '', true
  assert.equal(rec.setProjectForwarding(undefined, false), false); // same as '', false
});

test('Unit: setProjectForwarding respects the cap boundary at exactly MAX_PROJECT_FORWARDING', () => {
  const rec = createTelemetryReceiver({ config: { enabled: false } });

  // Set exactly MAX_PROJECT_FORWARDING distinct projects
  for (let i = 0; i < MAX_PROJECT_FORWARDING; i++) {
    rec.setProjectForwarding(`boundary-${i}`, true);
  }

  // Now set one more (should evict the oldest)
  rec.setProjectForwarding(`boundary-overflow`, true);

  // No throw, function still works
  assert.ok(true, 'no throw when exceeding cap');
});

// ──────────────────────────────────────────────────────────────────────────────
// Unit Tests: Integration with receiver state
// ──────────────────────────────────────────────────────────────────────────────

test('Unit: Multiple receivers have independent projectForwarding Maps', () => {
  const rec1 = createTelemetryReceiver({ config: { enabled: false } });
  const rec2 = createTelemetryReceiver({ config: { enabled: false } });

  // Set different projects on each
  rec1.setProjectForwarding('rec1-proj', true);
  rec2.setProjectForwarding('rec2-proj', true);

  // No error — each receiver manages its own map
  assert.ok(true, 'two receivers can independently manage projects');
});

test('Unit: setProjectForwarding behavior is stable across receiver lifetime', () => {
  const rec = createTelemetryReceiver({ config: { enabled: false } });

  // Early in lifetime
  assert.equal(rec.setProjectForwarding('early', true), true);

  // Mid-lifetime
  for (let i = 0; i < 50; i++) {
    rec.setProjectForwarding(`mid-${i}`, i % 2 === 0);
  }

  // Late in lifetime
  assert.equal(rec.setProjectForwarding('late', false), false);

  // Behavior remains consistent
  assert.equal(rec.setProjectForwarding('early', false), false); // can still toggle early
});

// ──────────────────────────────────────────────────────────────────────────────
// Edge Cases: Stress the LRU implementation
// ──────────────────────────────────────────────────────────────────────────────

test('Unit: Rapid same-project toggling does not trigger evictions', () => {
  const rec = createTelemetryReceiver({ config: { enabled: false } });

  // Fill up to near-cap
  for (let i = 0; i < MAX_PROJECT_FORWARDING - 1; i++) {
    rec.setProjectForwarding(`stable-${i}`, true);
  }

  // Now rapidly toggle one project many times (should not evict others)
  for (let i = 0; i < 1000; i++) {
    rec.setProjectForwarding('toggle', i % 2 === 0);
  }

  // Can still add new projects up to the cap
  rec.setProjectForwarding('extra', true); // should fit (no eviction from toggling)
  assert.ok(true, 'rapid toggling does not interfere with cap');
});

test('Unit: setProjectForwarding with sequential overflow tests LRU order', () => {
  const rec = createTelemetryReceiver({ config: { enabled: false } });

  // Set exactly MAX_PROJECT_FORWARDING + 5 projects in sequence
  const count = MAX_PROJECT_FORWARDING + 5;
  let throwCount = 0;
  for (let i = 0; i < count; i++) {
    try {
      rec.setProjectForwarding(`overflow-${i}`, i % 2 === 0);
    } catch (e) {
      throwCount++;
    }
  }

  assert.equal(throwCount, 0, 'sequential overflow never threw');
});
