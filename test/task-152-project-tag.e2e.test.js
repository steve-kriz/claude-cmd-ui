'use strict';

// E2E cucumber-style tests (Given/When/Then) for TASK-152:
// Per-project tag on parsed telemetry rows.
// Covers all Gherkin scenarios and edge cases.
// No real network/DB; mocks OTLP/JSON payloads.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const t = require('../lib/telemetry');

// --- Helpers ----------------------------------------------------------------

function buildOtlpLogsPayload(resourceAttrs = [], logRecords = []) {
  return {
    resourceLogs: [{
      resource: {
        attributes: resourceAttrs,
      },
      scopeLogs: [{
        logRecords,
      }],
    }],
  };
}

function apiRequestRecord(overrides = {}) {
  const attrs = Object.assign({
    request_id: 'req_test_001',
    'session.id': 'session-123',
    model: 'claude-haiku-4-5-20251001',
    input_tokens: 5,
    output_tokens: 10,
    cache_read_tokens: 100,
    cache_creation_tokens: 0,
    cost_usd: 0.001,
    duration_ms: 500,
    'event.timestamp': '2026-07-26T04:15:48.794Z',
  }, overrides);

  return {
    body: { stringValue: 'claude_code.api_request' },
    attributes: Object.entries(attrs).map(([k, v]) => {
      let valueObj;
      if (typeof v === 'string') {
        valueObj = { stringValue: v };
      } else if (typeof v === 'number') {
        valueObj = Number.isInteger(v) ? { intValue: v } : { doubleValue: v };
      } else {
        valueObj = { stringValue: String(v) };
      }
      return { key: k, value: valueObj };
    }),
  };
}

function attrStringValue(key, value) {
  return { key, value: { stringValue: value } };
}

// --- Scenario 1: A row inherits the project from its OTLP resource attribute

test('Scenario: A row inherits the project from its OTLP resource attribute', () => {
  // Given: an OTLP logs payload whose resourceLogs[0].resource.attributes
  // contains { key: "project", value: { stringValue: "C:\\projects\\alpha" } }
  // and one claude_code.api_request logRecord
  const payload = buildOtlpLogsPayload(
    [attrStringValue('project', 'C:\\projects\\alpha')],
    [apiRequestRecord()],
  );

  // When: extractApiRequests parses the payload
  const rows = t.extractApiRequests(payload);

  // Then: the returned row has project === "C:\\projects\\alpha"
  assert.equal(rows.length, 1);
  assert.equal(rows[0].project, 'C:\\projects\\alpha');

  // And: all existing fields (requestId, model, costUsd, ...) are still populated
  assert.equal(rows[0].requestId, 'req_test_001');
  assert.equal(rows[0].model, 'claude-haiku-4-5-20251001');
  assert.equal(rows[0].costUsd, 0.001);
  assert.equal(rows[0].inputTokens, 5);
  assert.equal(rows[0].outputTokens, 10);
  assert.equal(rows[0].cacheReadTokens, 100);
  assert.equal(rows[0].sessionId, 'session-123');
  assert.equal(rows[0].durationMs, 500);
});

// --- Scenario 2: A percent-encoded project value is decoded

test('Scenario: A percent-encoded project value is decoded', () => {
  // Given: a resource "project" attribute value of "C%3A%5Cprojects%5Calpha"
  // (which decodes to "C:\\projects\\alpha")
  const payload = buildOtlpLogsPayload(
    [attrStringValue('project', 'C%3A%5Cprojects%5Calpha')],
    [apiRequestRecord()],
  );

  // When: extractApiRequests parses the payload
  const rows = t.extractApiRequests(payload);

  // Then: the returned row has project === "C:\\projects\\alpha"
  assert.equal(rows.length, 1);
  assert.equal(rows[0].project, 'C:\\projects\\alpha');
});

// --- Scenario 3: Two resource blocks tag their own rows

test('Scenario: Two resource blocks tag their own rows', () => {
  // Given: a payload with two resourceLogs entries whose resource "project"
  // attributes are "proj-a" and "proj-b", each with one api_request record
  const payload = {
    resourceLogs: [
      {
        resource: { attributes: [attrStringValue('project', 'proj-a')] },
        scopeLogs: [{ logRecords: [apiRequestRecord({ request_id: 'req_a_001' })] }],
      },
      {
        resource: { attributes: [attrStringValue('project', 'proj-b')] },
        scopeLogs: [{ logRecords: [apiRequestRecord({ request_id: 'req_b_001' })] }],
      },
    ],
  };

  // When: extractApiRequests parses the payload
  const rows = t.extractApiRequests(payload);

  // Then: one row has project "proj-a" and the other has project "proj-b"
  assert.equal(rows.length, 2);
  const rowA = rows.find((r) => r.requestId === 'req_a_001');
  const rowB = rows.find((r) => r.requestId === 'req_b_001');
  assert.ok(rowA, 'found row with req_a_001');
  assert.ok(rowB, 'found row with req_b_001');
  assert.equal(rowA.project, 'proj-a');
  assert.equal(rowB.project, 'proj-b');
});

// --- Scenario 4 (edge): Missing resource block yields an empty project, not a throw

test('Scenario (edge): Missing resource block yields an empty project, not a throw', () => {
  // Given: an api_request record whose resourceLogs entry has no resource key
  const payload = {
    resourceLogs: [
      {
        // No 'resource' key at all
        scopeLogs: [{ logRecords: [apiRequestRecord()] }],
      },
    ],
  };

  // When: extractApiRequests parses the payload
  let rows;
  assert.doesNotThrow(() => {
    rows = t.extractApiRequests(payload);
  }, 'extractApiRequests does not throw on missing resource');

  // Then: the row has project === ""
  assert.equal(rows.length, 1);
  assert.equal(rows[0].project, '');

  // And: no exception is thrown (already verified above)
});

// --- Scenario 5 (edge): A malformed percent-encoded value falls back to the raw string

test('Scenario (edge): A malformed percent-encoded value falls back to the raw string', () => {
  // Given: a resource "project" attribute value of "100%bad%"
  // (malformed URL encoding that cannot be decoded)
  const payload = buildOtlpLogsPayload(
    [attrStringValue('project', '100%bad%')],
    [apiRequestRecord()],
  );

  // When: extractApiRequests parses the payload
  let rows;
  assert.doesNotThrow(() => {
    rows = t.extractApiRequests(payload);
  }, 'extractApiRequests does not throw on malformed encoding');

  // Then: the row's project equals the raw "100%bad%" string
  assert.equal(rows.length, 1);
  assert.equal(rows[0].project, '100%bad%');

  // And: no exception is thrown (already verified above)
});

// --- Additional edge cases --------------------------------------------------

test('Edge: requestKey does not include project (project is not part of de-dup identity)', () => {
  // The ticket specifies: requestKey(row) is UNCHANGED (still keyed on request_id / composite);
  // the `project` field does not participate in the de-dup key.
  const row1 = {
    requestId: 'req_123',
    sessionId: 'sess_1',
    timestamp: '2026-07-26T04:15:00Z',
    inputTokens: 10,
    outputTokens: 20,
    costUsd: 0.05,
    project: 'proj-a',
  };

  const row2 = {
    requestId: 'req_123',
    sessionId: 'sess_1',
    timestamp: '2026-07-26T04:15:00Z',
    inputTokens: 10,
    outputTokens: 20,
    costUsd: 0.05,
    project: 'proj-b', // Different project
  };

  // Both rows have the same requestKey because requestId is present
  // and project does not affect the key
  const key1 = t.requestKey(row1);
  const key2 = t.requestKey(row2);
  assert.equal(key1, key2, 'same requestId → same key regardless of project');
  assert.equal(key1, 'req_123');
});

test('Edge: empty project attribute value yields project ""', () => {
  const payload = buildOtlpLogsPayload(
    [attrStringValue('project', '')],
    [apiRequestRecord()],
  );

  const rows = t.extractApiRequests(payload);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].project, '');
});

test('Edge: missing project attribute yields project ""', () => {
  const payload = buildOtlpLogsPayload(
    [attrStringValue('other_attr', 'some_value')],
    [apiRequestRecord()],
  );

  const rows = t.extractApiRequests(payload);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].project, '');
});

test('Edge: null/undefined in resource attributes array is handled gracefully', () => {
  const payload = {
    resourceLogs: [
      {
        resource: { attributes: null }, // attributes is null
        scopeLogs: [{ logRecords: [apiRequestRecord()] }],
      },
    ],
  };

  let rows;
  assert.doesNotThrow(() => {
    rows = t.extractApiRequests(payload);
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].project, '');
});

test('Edge: resource.attributes missing entirely yields project ""', () => {
  const payload = {
    resourceLogs: [
      {
        resource: {}, // No 'attributes' key
        scopeLogs: [{ logRecords: [apiRequestRecord()] }],
      },
    ],
  };

  const rows = t.extractApiRequests(payload);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].project, '');
});

test('Edge: percent-encoding with special Windows path characters', () => {
  // Windows paths with backslash: C:\Users\steve\project
  // Percent-encoded: C%3A%5CUsers%5Csteve%5Cproject
  const payload = buildOtlpLogsPayload(
    [attrStringValue('project', 'C%3A%5CUsers%5Csteve%5Cproject')],
    [apiRequestRecord()],
  );

  const rows = t.extractApiRequests(payload);
  assert.equal(rows[0].project, 'C:\\Users\\steve\\project');
});

test('Edge: percent-encoding with spaces', () => {
  // Path with spaces: /home/user/my project
  // Percent-encoded: /home/user/my%20project
  const payload = buildOtlpLogsPayload(
    [attrStringValue('project', '/home/user/my%20project')],
    [apiRequestRecord()],
  );

  const rows = t.extractApiRequests(payload);
  assert.equal(rows[0].project, '/home/user/my project');
});

test('Edge: buildForwardPayload still emits top-level project field unchanged', () => {
  // The ticket specifies: buildForwardPayload continues to emit the top-level
  // `project` field it already emits (no schema bump; telemetry.usage.v1 unchanged).
  const payload = t.buildForwardPayload({
    project: 'my-project-folder',
    generatedAt: '2026-07-26T00:00:00Z',
  });

  assert.equal(payload.project, 'my-project-folder');
  assert.equal(payload.schema, 'telemetry.usage.v1');
});

test('Edge: Multiple api_request records from the same resourceLogs all inherit the same project', () => {
  // Multiple records in the same resourceLogs should all get the same project
  const payload = {
    resourceLogs: [
      {
        resource: { attributes: [attrStringValue('project', 'shared-project')] },
        scopeLogs: [
          {
            logRecords: [
              apiRequestRecord({ request_id: 'req_1' }),
              apiRequestRecord({ request_id: 'req_2' }),
              apiRequestRecord({ request_id: 'req_3' }),
            ],
          },
        ],
      },
    ],
  };

  const rows = t.extractApiRequests(payload);
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.project, 'shared-project');
  }
});

test('Edge: non-string project attribute (number, boolean, null) yields project ""', () => {
  // According to the ticket: "when that attribute is absent/empty/non-string
  // the row's `project` is ''".
  const payload = {
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: 'project', value: { intValue: 123 } },
          ],
        },
        scopeLogs: [{ logRecords: [apiRequestRecord()] }],
      },
    ],
  };

  const rows = t.extractApiRequests(payload);
  assert.equal(rows[0].project, '');
});

test('Scenario: resourceProject and decodeAttrValue are exported and callable', () => {
  // Verify the new helper functions are properly exported
  assert.equal(typeof t.resourceProject, 'function');
  assert.equal(typeof t.decodeAttrValue, 'function');

  // Basic smoke test of decodeAttrValue
  const decoded = t.decodeAttrValue('hello%20world');
  assert.equal(decoded, 'hello world');

  // Basic smoke test of resourceProject
  const rl = {
    resource: {
      attributes: [{ key: 'project', value: { stringValue: 'test-project' } }],
    },
  };
  const project = t.resourceProject(rl);
  assert.equal(project, 'test-project');
});
