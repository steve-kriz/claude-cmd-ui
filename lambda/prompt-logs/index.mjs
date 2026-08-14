// AWS Lambda that stores claude-cmd-ui prompt logs AND OTEL usage/cost telemetry
// in CloudWatch Logs.
//
// PROMPT LOGS (lib/cloud-logs.js):
//   POST {endpoint}            body: { username, project, entry }
//     → writes one event to log group LOG_GROUP, stream `${username}__${project}`.
//
//   GET  {endpoint}?username=…&project=…
//     → returns { ok: true, entries: [ ...entry objects in ingest order ] }.
//
// OTEL TELEMETRY (lib/telemetry.js buildForwardPayload → the app's "store online"
// forward hop). The app POSTs its own compact `telemetry.usage.v1` summary here
// with an `Authorization: Bearer <token>` header:
//   POST {endpoint}            body: { source, schema:'telemetry.usage.v1',
//                                       generatedAt, host, sessionId, username,
//                                       project, totals, byModel, recent }
//     → writes one event to log group TELEMETRY_LOG_GROUP, stream `${host}`.
//
//   GET  {endpoint}?schema=telemetry.usage.v1&host=…
//     → returns { ok: true, entries: [ ...telemetry payloads in ingest order ] }.
//
// NATIVE OTLP (Claude Code's own OpenTelemetry exporter, and any other OTLP
// client). Claude Code posts OTLP/JSON export requests:
//   POST {endpoint}/v1/logs      body: { resourceLogs: [...] }
//   POST {endpoint}/v1/metrics   body: { resourceMetrics: [...] }
//   POST {endpoint}/v1/traces    body: { resourceSpans: [...] }   (beta)
//     → flattens the batch and dumps one CloudWatch event per log record /
//       metric data point / span, into OTLP_LOGS_LOG_GROUP,
//       OTLP_METRICS_LOG_GROUP and OTLP_TRACES_LOG_GROUP respectively.
//       Stream is `${service.name}__${host.name}` from the resource attributes.
//
//   Client config (Claude Code settings.json `env` block):
//     CLAUDE_CODE_ENABLE_TELEMETRY=1
//     OTEL_LOGS_EXPORTER=otlp
//     OTEL_METRICS_EXPORTER=otlp
//     OTEL_EXPORTER_OTLP_PROTOCOL=http/json
//     OTEL_EXPORTER_OTLP_HEADERS=x-api-key=<API_KEY>
//     OTEL_EXPORTER_OTLP_LOGS_ENDPOINT={endpoint}/v1/logs
//     OTEL_EXPORTER_OTLP_METRICS_ENDPOINT={endpoint}/v1/metrics
//   Claude Code does NOT append /v1/logs or /v1/metrics to the generic
//   OTEL_EXPORTER_OTLP_ENDPOINT, hence the per-signal endpoints above. This
//   Lambda also sniffs the body shape, so a bare endpoint still works.
//   Only http/json is supported — http/protobuf bodies are rejected with 415.
//
// The POST route auto-detects which shape it got (OTLP requests carry a
// `resourceLogs`/`resourceMetrics`/`resourceSpans` array or arrive on a /v1/*
// path; telemetry payloads carry `schema === 'telemetry.usage.v1'`) so a single
// endpoint serves all three clients.
//
// COST / USAGE METRICS (CloudWatch Embedded Metric Format). Storing the raw
// payloads above makes them retrievable; it does NOT make them graphable. So
// alongside the raw write, this Lambda publishes the SIGNAL VALUES THEMSELVES —
// dollars, tokens, durations, prompt sizes — to the CloudWatch **Metrics** API
// via PutMetricData, in namespace METRICS_NAMESPACE (default `ClaudeCmdUI`).
// Real metrics, not log lines: chart them, alarm on them, use them in metric
// math. Each source event (an api_request, a prompt, a metric data point)
// contributes its own real numbers — never batch counts. See the "CloudWatch
// metrics (PutMetricData)" section below for the metric list and dimensions.
//
// Configure via environment variables:
//   LOG_GROUP            Prompt-log CloudWatch log group. Default: /claude-cmd-ui/prompts
//   TELEMETRY_LOG_GROUP  Telemetry CloudWatch log group. Default: /claude-cmd-ui/telemetry
//   OTLP_LOGS_LOG_GROUP     Default: /claude-cmd-ui/otlp/logs
//   OTLP_METRICS_LOG_GROUP  Default: /claude-cmd-ui/otlp/metrics
//   OTLP_TRACES_LOG_GROUP   Default: /claude-cmd-ui/otlp/traces
//   AWS_REGION           Region (set automatically by Lambda)
//   API_KEY              Optional shared secret. Clients send it as `X-Api-Key: <value>`
//                        (prompt logs, OTLP) or `Authorization: Bearer <value>` (telemetry).
//   METRICS_NAMESPACE    CloudWatch namespace for the EMF metrics. Default: ClaudeCmdUI
//   METRICS_ENABLED      Set to 0/false/off/no to stop publishing metrics (raw
//                        storage is unaffected). Default: on.
//
// IAM permissions required by the Lambda execution role:
//   logs:CreateLogGroup, logs:CreateLogStream,
//   logs:PutLogEvents,   logs:GetLogEvents
// on LOG_GROUP, TELEMETRY_LOG_GROUP and the three OTLP groups (and `${…}:*`),
// PLUS cloudwatch:PutMetricData (no resource ARN; scope it with a
// `cloudwatch:namespace` condition — see the metrics section below).

import { gunzipSync } from 'node:zlib';

import {
  CloudWatchLogsClient,
  CreateLogGroupCommand,
  CreateLogStreamCommand,
  PutLogEventsCommand,
  GetLogEventsCommand
} from '@aws-sdk/client-cloudwatch-logs';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';

const LOG_GROUP = process.env.LOG_GROUP || '/claude-cmd-ui/prompts';
const TELEMETRY_LOG_GROUP = process.env.TELEMETRY_LOG_GROUP || '/claude-cmd-ui/telemetry';
const OTLP_LOGS_LOG_GROUP = process.env.OTLP_LOGS_LOG_GROUP || '/claude-cmd-ui/otlp/logs';
const OTLP_METRICS_LOG_GROUP = process.env.OTLP_METRICS_LOG_GROUP || '/claude-cmd-ui/otlp/metrics';
const OTLP_TRACES_LOG_GROUP = process.env.OTLP_TRACES_LOG_GROUP || '/claude-cmd-ui/otlp/traces';
const TELEMETRY_SCHEMA = 'telemetry.usage.v1';
const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
const API_KEY = (process.env.API_KEY || '').trim();
const METRICS_NAMESPACE = (process.env.METRICS_NAMESPACE || '').trim() || 'ClaudeCmdUI';
const METRICS_ENABLED = !/^(0|false|off|no)$/i.test((process.env.METRICS_ENABLED || '1').trim());

const client = new CloudWatchLogsClient(REGION ? { region: REGION } : {});
// Separate service: CloudWatch Logs stores the raw records, CloudWatch Metrics
// receives the cost/usage numbers via PutMetricData.
const cloudwatch = new CloudWatchClient(REGION ? { region: REGION } : {});

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Content-Encoding,X-Api-Key,Authorization'
};

function ok(body) {
  return { statusCode: 200, headers: { 'Content-Type': 'application/json', ...CORS }, body: JSON.stringify(body) };
}
function fail(code, message) {
  return { statusCode: code, headers: { 'Content-Type': 'application/json', ...CORS }, body: JSON.stringify({ ok: false, error: message }) };
}

function sanitize(s) {
  return String(s == null ? '' : s).replace(/[^a-zA-Z0-9_.\-]/g, '_').slice(0, 256);
}
function streamName(username, project) {
  return `${sanitize(username)}__${sanitize(project)}`;
}

async function ensureGroup(group = LOG_GROUP) {
  try {
    await client.send(new CreateLogGroupCommand({ logGroupName: group }));
    console.log('[prompt-logs] created log group', group);
  } catch (e) {
    if (e.name !== 'ResourceAlreadyExistsException') {
      console.error('[prompt-logs] ensureGroup failed', group, e.name, e.message);
      throw e;
    }
  }
}
async function ensureStream(name, group = LOG_GROUP) {
  try {
    await client.send(new CreateLogStreamCommand({ logGroupName: group, logStreamName: name }));
    console.log('[prompt-logs] created log stream', group, name);
  } catch (e) {
    if (e.name !== 'ResourceAlreadyExistsException') {
      console.error('[prompt-logs] ensureStream failed', group, name, e.name, e.message);
      throw e;
    }
  }
}

function getMethod(event) {
  return (
    (event.requestContext && event.requestContext.http && event.requestContext.http.method) ||
    event.httpMethod ||
    (event.requestContext && event.requestContext.httpMethod) ||
    (event.body ? 'POST' : 'GET')
  );
}
function getQuery(event) {
  return event.queryStringParameters || event.query || {};
}
function getBody(event) {
  if (!event.body) return null;
  // OTLP exporters may gzip the body (OTEL_EXPORTER_OTLP_COMPRESSION=gzip), in
  // which case the function URL hands it to us base64-encoded.
  let raw;
  try {
    const buf = event.isBase64Encoded ? Buffer.from(event.body, 'base64') : Buffer.from(event.body, 'utf8');
    const encoding = String(headerLookup(event, 'content-encoding') || '').toLowerCase();
    raw = encoding.includes('gzip') ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');
  } catch (e) {
    console.warn('[prompt-logs] getBody decode failed', e && e.message);
    return null;
  }
  try { return JSON.parse(raw); } catch { return null; }
}
function headerLookup(event, name) {
  const h = event.headers || {};
  const lower = name.toLowerCase();
  for (const k of Object.keys(h)) if (k.toLowerCase() === lower) return h[k];
  return '';
}
function checkApiKey(event) {
  if (!API_KEY) return true;
  // Prompt-log clients send `X-Api-Key`; the app's telemetry forwarder sends the
  // same secret as `Authorization: Bearer <key>`. Accept either.
  if (String(headerLookup(event, 'x-api-key') || '').trim() === API_KEY) return true;
  const auth = String(headerLookup(event, 'authorization') || '').trim();
  const bearer = auth.replace(/^Bearer\s+/i, '').trim();
  return bearer === API_KEY;
}

async function handleAdd(event) {
  const body = getBody(event);
  if (!body || !body.username || !body.project || !body.entry) {
    console.warn('[prompt-logs] handleAdd missing fields', {
      hasBody: !!body,
      hasUsername: !!(body && body.username),
      hasProject: !!(body && body.project),
      hasEntry: !!(body && body.entry)
    });
    return fail(400, 'username, project, and entry are required');
  }
  const stream = streamName(body.username, body.project);
  console.log('[prompt-logs] handleAdd', {
    username: body.username,
    project: body.project,
    stream,
    entryKeys: Object.keys(body.entry || {}),
    entryTs: body.entry && body.entry.ts
  });
  await ensureGroup(LOG_GROUP);
  await ensureStream(stream, LOG_GROUP);

  const tsRaw = body.entry && body.entry.ts ? Date.parse(body.entry.ts) : NaN;
  const ts = Number.isFinite(tsRaw) ? tsRaw : Date.now();

  const message = JSON.stringify({ username: body.username, project: body.project, entry: body.entry });
  const put = await client.send(new PutLogEventsCommand({
    logGroupName: LOG_GROUP,
    logStreamName: stream,
    logEvents: [{ timestamp: ts, message }]
  }));
  console.log('[prompt-logs] wrote event', {
    stream,
    ts,
    bytes: message.length,
    rejected: put && put.rejectedLogEventsInfo ? put.rejectedLogEventsInfo : null
  });
  const buffer = newMetricBuffer();
  safeEmit(() => collectPromptMetrics(body, ts, buffer));
  await publishMetrics(buffer);
  return ok({ ok: true });
}

// One prompt-history entry is one prompt, so its size (and the cost/token
// figures the app back-fills onto it once telemetry correlates the request
// window) are published straight through. Use SampleCount on PromptCharacters
// for "how many prompts", Sum for "how much was asked".
function collectPromptMetrics(body, ts, buffer) {
  if (!METRICS_ENABLED) return false;
  const entry = body.entry || {};
  const prompt = typeof entry.prompt === 'string' ? entry.prompt : '';
  return collectMetrics(
    buffer,
    {
      PromptCharacters: prompt.length || undefined,
      PromptCostUsd: entry.costUsd,
      PromptInputTokens: entry.inputTokens,
      PromptOutputTokens: entry.outputTokens
    },
    {
      User: dimValue(body.username),
      Project: projectDim(body.project)
    },
    ts,
    [[], ['User'], ['Project']]
  );
}

async function handleList(event) {
  const qs = getQuery(event);
  const username = qs.username;
  const project = qs.project;
  if (!username || !project) {
    console.warn('[prompt-logs] handleList missing query params', { username, project });
    return fail(400, 'username and project are required');
  }
  const stream = streamName(username, project);
  console.log('[prompt-logs] handleList', { username, project, stream });

  const entries = [];
  let token;
  let pages = 0;
  let malformed = 0;
  try {
    // Walk forward through the stream. GetLogEvents returns the same forward
    // token at the tail, so we exit once the token stops moving or the page
    // comes back empty.
    while (true) {
      const res = await client.send(new GetLogEventsCommand({
        logGroupName: LOG_GROUP,
        logStreamName: stream,
        startFromHead: true,
        limit: 10000,
        nextToken: token
      }));
      pages += 1;
      const pageCount = (res.events || []).length;
      for (const e of res.events || []) {
        try {
          const parsed = JSON.parse(e.message);
          if (parsed && parsed.entry) entries.push(parsed.entry);
        } catch { malformed += 1; }
      }
      console.log('[prompt-logs] page', { stream, page: pages, pageCount, runningTotal: entries.length });
      const next = res.nextForwardToken;
      if (!next || next === token || !res.events || res.events.length === 0) break;
      token = next;
    }
  } catch (e) {
    if (e.name === 'ResourceNotFoundException') {
      console.log('[prompt-logs] stream not found (returning empty)', stream);
      return ok({ ok: true, entries: [] });
    }
    console.error('[prompt-logs] handleList failed', stream, e.name, e.message);
    throw e;
  }
  console.log('[prompt-logs] handleList done', { stream, pages, entries: entries.length, malformed });
  return ok({ ok: true, entries });
}

// --- OTEL usage/cost telemetry (lib/telemetry.js buildForwardPayload) ---------

// A telemetry forward payload is self-describing via its schema tag; fall back to
// the source+totals shape so an older/partial payload is still recognised.
function isTelemetryPayload(body) {
  return !!body && (body.schema === TELEMETRY_SCHEMA
    || (body.source === 'claude-cmd-ui' && body.totals != null && body.entry == null));
}

// One telemetry stream per host, so a machine's usage history stays together.
function telemetryStreamName(host) {
  return sanitize(host || 'unknown-host');
}

async function handleTelemetry(event, body) {
  const stream = telemetryStreamName(body.host);
  console.log('[prompt-logs] handleTelemetry', {
    schema: body.schema,
    host: body.host,
    sessionId: body.sessionId,
    username: body.username,
    project: body.project,
    stream,
    requests: body.totals && body.totals.requests,
    costUsd: body.totals && body.totals.costUsd,
    models: body.byModel ? Object.keys(body.byModel).length : 0,
    recent: Array.isArray(body.recent) ? body.recent.length : 0
  });
  await ensureGroup(TELEMETRY_LOG_GROUP);
  await ensureStream(stream, TELEMETRY_LOG_GROUP);

  const tsRaw = body.generatedAt ? Date.parse(body.generatedAt) : NaN;
  const ts = Number.isFinite(tsRaw) ? tsRaw : Date.now();

  const message = JSON.stringify(body);
  const put = await client.send(new PutLogEventsCommand({
    logGroupName: TELEMETRY_LOG_GROUP,
    logStreamName: stream,
    logEvents: [{ timestamp: ts, message }]
  }));
  console.log('[prompt-logs] wrote telemetry', {
    stream,
    ts,
    bytes: message.length,
    rejected: put && put.rejectedLogEventsInfo ? put.rejectedLogEventsInfo : null
  });
  const buffer = newMetricBuffer();
  safeEmit(() => collectTelemetryMetrics(body, ts, buffer));
  await publishMetrics(buffer);
  return ok({ ok: true });
}

// A telemetry.usage.v1 payload is a RUNNING SNAPSHOT of one session, re-sent as
// it grows, so its totals are published as cumulative `Session*` metrics (read
// with Maximum). The per-model breakdown is collected separately so the Model
// dimension carries real per-model figures rather than a blended one.
function collectTelemetryMetrics(body, ts, buffer) {
  if (!METRICS_ENABLED) return;
  const base = {
    User: dimValue(body.username),
    Project: projectDim(body.project)
  };
  const values = (t) => ({
    SessionCostUsd: t.costUsd,
    SessionInputTokens: t.inputTokens,
    SessionOutputTokens: t.outputTokens,
    SessionCacheReadTokens: t.cacheReadTokens,
    SessionCacheCreationTokens: t.cacheCreationTokens,
    SessionTotalTokens: t.totalTokens
  });

  const byModel = body.byModel && typeof body.byModel === 'object' ? body.byModel : {};
  for (const [model, totals] of Object.entries(byModel)) {
    if (!totals || typeof totals !== 'object') continue;
    // Per-model figures carry the Model dimension only; rolling them into the
    // model-free sets as well would stack several sessions' snapshots into one
    // bucket, and Maximum would then read the largest model rather than the
    // session total.
    collectMetrics(buffer, values(totals), { ...base, Model: dimValue(model) }, ts, [['Model'], ['User', 'Model']]);
  }
  // Grand totals own the model-free sets.
  const totals = body.totals && typeof body.totals === 'object' ? body.totals : null;
  if (totals) collectMetrics(buffer, values(totals), base, ts, [[], ['User'], ['Project']]);
}

async function handleTelemetryList(event) {
  const qs = getQuery(event);
  const host = qs.host;
  if (!host) {
    console.warn('[prompt-logs] handleTelemetryList missing host');
    return fail(400, 'host is required');
  }
  const stream = telemetryStreamName(host);
  console.log('[prompt-logs] handleTelemetryList', { host, stream });

  const entries = [];
  let token;
  let pages = 0;
  let malformed = 0;
  try {
    while (true) {
      const res = await client.send(new GetLogEventsCommand({
        logGroupName: TELEMETRY_LOG_GROUP,
        logStreamName: stream,
        startFromHead: true,
        limit: 10000,
        nextToken: token
      }));
      pages += 1;
      for (const e of res.events || []) {
        try {
          const parsed = JSON.parse(e.message);
          if (parsed) entries.push(parsed);
        } catch { malformed += 1; }
      }
      const next = res.nextForwardToken;
      if (!next || next === token || !res.events || res.events.length === 0) break;
      token = next;
    }
  } catch (e) {
    if (e.name === 'ResourceNotFoundException') {
      console.log('[prompt-logs] telemetry stream not found (returning empty)', stream);
      return ok({ ok: true, entries: [] });
    }
    console.error('[prompt-logs] handleTelemetryList failed', stream, e.name, e.message);
    throw e;
  }
  console.log('[prompt-logs] handleTelemetryList done', { stream, pages, entries: entries.length, malformed });
  return ok({ ok: true, entries });
}

// --- Native OTLP ingest -------------------------------------------------------

// CloudWatch PutLogEvents limits: 10k events and 1MB per call, 256KB per event.
// Leave headroom for the 26-byte per-event overhead the API charges.
const MAX_EVENT_BYTES = 256 * 1024 - 1024;
const MAX_BATCH_BYTES = 1024 * 1024 - 8192;
const MAX_BATCH_EVENTS = 10000;
const EVENT_OVERHEAD = 26;

// OTLP/JSON encodes 64-bit nanosecond timestamps as decimal strings, which lose
// precision through Number — go via BigInt before dividing down to millis.
function nanoToMs(nano) {
  if (nano == null) return NaN;
  try {
    if (typeof nano === 'number') return Math.floor(nano / 1e6);
    const s = String(nano).trim();
    if (!/^\d+$/.test(s)) return NaN;
    return Number(BigInt(s) / 1000000n);
  } catch { return NaN; }
}

// OTLP AnyValue → plain JS. intValue is also a string on the wire.
function anyValue(v) {
  if (v == null) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.intValue !== undefined) {
    const n = Number(v.intValue);
    return Number.isSafeInteger(n) ? n : String(v.intValue);
  }
  if (v.bytesValue !== undefined) return v.bytesValue;
  if (v.arrayValue) return (v.arrayValue.values || []).map(anyValue);
  if (v.kvlistValue) return attrsToObject(v.kvlistValue.values);
  return null;
}
function attrsToObject(attributes) {
  const out = {};
  for (const kv of attributes || []) {
    if (kv && kv.key) out[kv.key] = anyValue(kv.value);
  }
  return out;
}

// One stream per machine per service, mirroring the per-host telemetry streams.
function otlpStreamName(resource) {
  const service = resource['service.name'] || 'unknown-service';
  const host = resource['host.name'] || resource['host.id'] || '';
  return sanitize(host ? `${service}__${host}` : service);
}

function scopeOf(scope) {
  if (!scope || !scope.name) return undefined;
  return scope.version ? { name: scope.name, version: scope.version } : { name: scope.name };
}

function flattenOtlpLogs(body) {
  const out = [];
  for (const rl of body.resourceLogs || []) {
    const resource = attrsToObject(rl.resource && rl.resource.attributes);
    const stream = otlpStreamName(resource);
    for (const sl of rl.scopeLogs || []) {
      for (const rec of sl.logRecords || []) {
        const ts = nanoToMs(rec.timeUnixNano) || nanoToMs(rec.observedTimeUnixNano);
        out.push({
          stream,
          timestamp: Number.isFinite(ts) && ts > 0 ? ts : Date.now(),
          record: {
            otlp: 'logs',
            resource,
            scope: scopeOf(sl.scope),
            eventName: rec.eventName,
            severityText: rec.severityText,
            severityNumber: rec.severityNumber,
            body: anyValue(rec.body),
            attributes: attrsToObject(rec.attributes),
            traceId: rec.traceId,
            spanId: rec.spanId
          }
        });
      }
    }
  }
  return out;
}

// Unwrap whichever of the five metric shapes is populated.
function pointsOf(metric) {
  if (metric.gauge) return { kind: 'gauge', points: metric.gauge.dataPoints || [] };
  if (metric.sum) {
    return {
      kind: 'sum',
      points: metric.sum.dataPoints || [],
      isMonotonic: metric.sum.isMonotonic,
      aggregationTemporality: metric.sum.aggregationTemporality
    };
  }
  if (metric.histogram) {
    return {
      kind: 'histogram',
      points: metric.histogram.dataPoints || [],
      aggregationTemporality: metric.histogram.aggregationTemporality
    };
  }
  if (metric.exponentialHistogram) return { kind: 'exponentialHistogram', points: metric.exponentialHistogram.dataPoints || [] };
  if (metric.summary) return { kind: 'summary', points: metric.summary.dataPoints || [] };
  return { kind: 'unknown', points: [] };
}

function numeric(v) {
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  return Number.isSafeInteger(n) || Number.isFinite(n) ? n : String(v);
}

function pointValue(kind, dp) {
  if (kind === 'gauge' || kind === 'sum') {
    if (dp.asDouble !== undefined) return dp.asDouble;
    if (dp.asInt !== undefined) return numeric(dp.asInt);
    return null;
  }
  // Histograms/summaries: keep the aggregate stats, drop the bucket arrays.
  return {
    count: numeric(dp.count),
    sum: numeric(dp.sum),
    min: numeric(dp.min),
    max: numeric(dp.max)
  };
}

function flattenOtlpMetrics(body) {
  const out = [];
  for (const rm of body.resourceMetrics || []) {
    const resource = attrsToObject(rm.resource && rm.resource.attributes);
    const stream = otlpStreamName(resource);
    for (const sm of rm.scopeMetrics || []) {
      for (const metric of sm.metrics || []) {
        const { kind, points, isMonotonic, aggregationTemporality } = pointsOf(metric);
        for (const dp of points) {
          const ts = nanoToMs(dp.timeUnixNano) || nanoToMs(dp.startTimeUnixNano);
          out.push({
            stream,
            timestamp: Number.isFinite(ts) && ts > 0 ? ts : Date.now(),
            record: {
              otlp: 'metrics',
              resource,
              scope: scopeOf(sm.scope),
              name: metric.name,
              description: metric.description,
              unit: metric.unit,
              kind,
              isMonotonic,
              aggregationTemporality,
              value: pointValue(kind, dp),
              attributes: attrsToObject(dp.attributes),
              startTimeUnixNano: dp.startTimeUnixNano,
              timeUnixNano: dp.timeUnixNano
            }
          });
        }
      }
    }
  }
  return out;
}

function flattenOtlpTraces(body) {
  const out = [];
  for (const rs of body.resourceSpans || []) {
    const resource = attrsToObject(rs.resource && rs.resource.attributes);
    const stream = otlpStreamName(resource);
    for (const ss of rs.scopeSpans || []) {
      for (const span of ss.spans || []) {
        const start = nanoToMs(span.startTimeUnixNano);
        const end = nanoToMs(span.endTimeUnixNano);
        out.push({
          stream,
          timestamp: Number.isFinite(start) && start > 0 ? start : Date.now(),
          record: {
            otlp: 'traces',
            resource,
            scope: scopeOf(ss.scope),
            name: span.name,
            kind: span.kind,
            traceId: span.traceId,
            spanId: span.spanId,
            parentSpanId: span.parentSpanId,
            startTimeUnixNano: span.startTimeUnixNano,
            endTimeUnixNano: span.endTimeUnixNano,
            durationMs: Number.isFinite(start) && Number.isFinite(end) ? end - start : undefined,
            attributes: attrsToObject(span.attributes),
            status: span.status,
            events: (span.events || []).map((e) => ({
              name: e.name,
              timeUnixNano: e.timeUnixNano,
              attributes: attrsToObject(e.attributes)
            }))
          }
        });
      }
    }
  }
  return out;
}

// PutLogEvents requires events sorted by timestamp, so sort then chunk on both
// the event-count and byte ceilings.
async function putEvents(group, stream, events) {
  if (!events.length) return { written: 0, batches: 0, rejected: [] };
  await ensureGroup(group);
  await ensureStream(stream, group);

  const sorted = events.slice().sort((a, b) => a.timestamp - b.timestamp);
  const rejected = [];
  let written = 0;
  let batches = 0;
  let batch = [];
  let bytes = 0;

  const flush = async () => {
    if (!batch.length) return;
    const put = await client.send(new PutLogEventsCommand({
      logGroupName: group,
      logStreamName: stream,
      logEvents: batch
    }));
    written += batch.length;
    batches += 1;
    if (put && put.rejectedLogEventsInfo) rejected.push(put.rejectedLogEventsInfo);
    batch = [];
    bytes = 0;
  };

  for (const ev of sorted) {
    let message = ev.message;
    let buf = Buffer.from(message, 'utf8');
    if (buf.length > MAX_EVENT_BYTES) {
      message = `${buf.subarray(0, MAX_EVENT_BYTES).toString('utf8')}…[truncated]`;
      buf = Buffer.from(message, 'utf8');
    }
    const size = buf.length + EVENT_OVERHEAD;
    if (batch.length >= MAX_BATCH_EVENTS || bytes + size > MAX_BATCH_BYTES) await flush();
    batch.push({ timestamp: ev.timestamp, message });
    bytes += size;
  }
  await flush();
  return { written, batches, rejected };
}

const OTLP_SIGNALS = {
  logs: { group: () => OTLP_LOGS_LOG_GROUP, flatten: flattenOtlpLogs },
  metrics: { group: () => OTLP_METRICS_LOG_GROUP, flatten: flattenOtlpMetrics },
  traces: { group: () => OTLP_TRACES_LOG_GROUP, flatten: flattenOtlpTraces }
};

function isOtlpBody(body) {
  if (!body) return null;
  if (Array.isArray(body.resourceLogs)) return 'logs';
  if (Array.isArray(body.resourceMetrics)) return 'metrics';
  if (Array.isArray(body.resourceSpans)) return 'traces';
  return null;
}
function otlpSignalFromPath(path) {
  const p = String(path || '').toLowerCase().replace(/\/+$/, '');
  if (p.endsWith('/v1/logs')) return 'logs';
  if (p.endsWith('/v1/metrics')) return 'metrics';
  if (p.endsWith('/v1/traces')) return 'traces';
  return null;
}

// OTLP/HTTP expects an ExportXServiceResponse body; `{}` means full success.
function otlpOk(partialSuccess) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', ...CORS },
    body: JSON.stringify(partialSuccess ? { partialSuccess } : {})
  };
}

async function handleOtlp(signal, body) {
  if (!body) {
    console.warn('[prompt-logs] otlp body missing or not JSON', { signal });
    return fail(400, 'invalid OTLP JSON body');
  }
  const { group, flatten } = OTLP_SIGNALS[signal];
  const logGroup = group();
  const items = flatten(body);
  console.log('[prompt-logs] handleOtlp', { signal, logGroup, items: items.length });

  if (!items.length) return otlpOk();

  const byStream = new Map();
  for (const item of items) {
    const list = byStream.get(item.stream) || [];
    list.push({ timestamp: item.timestamp, message: JSON.stringify(item.record) });
    byStream.set(item.stream, list);
  }

  let written = 0;
  const rejected = [];
  for (const [stream, events] of byStream) {
    const res = await putEvents(logGroup, stream, events);
    written += res.written;
    if (res.rejected.length) rejected.push({ stream, info: res.rejected });
    console.log('[prompt-logs] wrote otlp', {
      signal,
      logGroup,
      stream,
      events: res.written,
      batches: res.batches
    });
  }
  // Raw payloads are archived above; now publish the signal values themselves to
  // the CloudWatch Metrics API so cost/usage is graphable and alarmable.
  const buffer = newMetricBuffer();
  safeEmit(() => {
    if (signal === 'logs') collectOtlpLogMetrics(items, buffer);
    else if (signal === 'metrics') collectOtlpMetricMetrics(items, buffer);
  });
  const published = await publishMetrics(buffer);

  console.log('[prompt-logs] handleOtlp done', { signal, streams: byStream.size, written, published, rejected });

  // CloudWatch may drop events that are too old/too far ahead; report those back
  // to the exporter as an OTLP partial success rather than silently swallowing.
  const dropped = items.length - written;
  return otlpOk(dropped > 0 ? { rejectedDataPoints: String(dropped), errorMessage: 'rejected by CloudWatch Logs' } : null);
}

// --- CloudWatch metrics (PutMetricData) --------------------------------------
//
// Everything above STORES telemetry. This section MEASURES it: each ingested
// signal is published to the CloudWatch **Metrics** API as a real metric —
// `cloudwatch:PutMetricData`, not a log line CloudWatch has to parse back out.
//
// The values published are the signal values themselves — the dollars and
// tokens of that one API call, the length of that one prompt — never "N items
// were in this batch". Occurrence counts still come for free: CloudWatch's
// SampleCount statistic on `CostUsd` IS the number of API requests, and on
// `PromptLength` IS the number of prompts.
//
// Namespace: METRICS_NAMESPACE (default `ClaudeCmdUI`).
//
//   Metric                 Unit          Source                        Statistic
//   ---------------------- ------------- ----------------------------- ---------
//   CostUsd                None (USD)    claude_code.api_request log   Sum
//   InputTokens            Count         claude_code.api_request log   Sum
//   OutputTokens           Count         claude_code.api_request log   Sum
//   CacheReadTokens        Count         claude_code.api_request log   Sum
//   CacheCreationTokens    Count         claude_code.api_request log   Sum
//   TotalTokens            Count         claude_code.api_request log   Sum
//   RequestDurationMs      Milliseconds  claude_code.api_request log   Average
//   PromptLength           Count (chars) claude_code.user_prompt log   Sum/Avg
//   ToolDurationMs         Milliseconds  claude_code.tool_result log   Average
//   PromptCharacters       Count (chars) prompt-history POST entry     Sum
//   PromptCostUsd          None (USD)    prompt-history POST entry     Sum
//   PromptInputTokens      Count         prompt-history POST entry     Sum
//   PromptOutputTokens     Count         prompt-history POST entry     Sum
//   SessionCostUsd         None (USD)    telemetry.usage.v1 totals     Maximum
//   SessionInputTokens     Count         telemetry.usage.v1 totals     Maximum
//   SessionOutputTokens    Count         telemetry.usage.v1 totals     Maximum
//   SessionTotalTokens     Count         telemetry.usage.v1 totals     Maximum
//   SessionCostUsdTotal    None (USD)    claude_code.cost.usage metric Maximum
//   SessionTokensTotal     Count         claude_code.token.usage       Maximum
//   LinesOfCodeTotal       Count         claude_code.lines_of_code     Maximum
//   ActiveTimeSecondsTotal Seconds       claude_code.active_time.total Maximum
//
// The `*Total` and `Session*` metrics are CUMULATIVE running counters (Claude
// Code's claude_code.* sums are cumulative monotonic, and a telemetry.usage.v1
// payload is a running session snapshot), so graph those with **Maximum**, not
// Sum — summing re-reported cumulative values double counts. Everything derived
// from a discrete log event is a one-shot value, so those graph with **Sum**.
// Cost is therefore best tracked with `CostUsd` (Sum).
//
// Each metric is published once per dimension set: [] (fleet-wide), [User],
// [Model], [Project] and [User, Model] — a PutMetricData datum carries exactly
// one dimension list, so slicing by user AND by model means publishing both.
// Session, host and request ids are deliberately NOT dimensions: they are
// unbounded, and every distinct combination is a separately billed metric. They
// remain on the raw records archived in the OTLP/telemetry log groups.
//
// Publishing is aggregated before it is sent: all values for the same
// (metric, dimensions, minute) are collapsed into one StatisticValues datum
// carrying SampleCount/Sum/Minimum/Maximum. Standard-resolution CloudWatch
// metrics are stored at 1-minute granularity anyway, so this loses no fidelity
// — Sum, Average, Maximum and SampleCount are all still exact — while keeping a
// large OTLP batch down to a couple of API calls.
//
// Cost note: custom metrics are billed per unique series (namespace + name +
// dimension combination), plus a small per-PutMetricData-request charge. Set
// METRICS_ENABLED=0 to turn the whole section off; raw storage is unaffected.
//
// IAM: the execution role additionally needs `cloudwatch:PutMetricData`. It
// takes no resource ARN; scope it with a `cloudwatch:namespace` condition:
//   { "Effect": "Allow", "Action": "cloudwatch:PutMetricData", "Resource": "*",
//     "Condition": { "StringEquals": { "cloudwatch:namespace": "ClaudeCmdUI" } } }

// One dimension set per grouping we want to slice by. `[]` is the fleet-wide
// roll-up (a datum with no dimensions).
const DIMENSION_SETS = [[], ['User'], ['Model'], ['Project'], ['User', 'Model']];

// CloudWatch rejects metric timestamps older than 14 days or more than 2 hours
// in the future, which a replayed/backfilled export can hit.
const METRIC_MAX_PAST_MS = 14 * 24 * 60 * 60 * 1000;
const METRIC_MAX_FUTURE_MS = 2 * 60 * 60 * 1000;

// PutMetricData accepts 1000 datums per request. Cap the number of requests one
// invocation will make so a pathological batch cannot eat the function timeout;
// anything beyond the cap is dropped LOUDLY rather than silently.
const MAX_DATUMS_PER_CALL = 1000;
const MAX_PUT_CALLS = 10;

const METRIC_UNITS = {
  CostUsd: 'None',
  InputTokens: 'Count',
  OutputTokens: 'Count',
  CacheReadTokens: 'Count',
  CacheCreationTokens: 'Count',
  TotalTokens: 'Count',
  RequestDurationMs: 'Milliseconds',
  PromptLength: 'Count',
  ToolDurationMs: 'Milliseconds',
  PromptCharacters: 'Count',
  PromptCostUsd: 'None',
  PromptInputTokens: 'Count',
  PromptOutputTokens: 'Count',
  SessionCostUsd: 'None',
  SessionInputTokens: 'Count',
  SessionOutputTokens: 'Count',
  SessionCacheReadTokens: 'Count',
  SessionCacheCreationTokens: 'Count',
  SessionTotalTokens: 'Count',
  SessionCostUsdTotal: 'None',
  SessionTokensTotal: 'Count',
  LinesOfCodeTotal: 'Count',
  ActiveTimeSecondsTotal: 'Seconds'
};

const UNKNOWN_DIM = 'unknown';

// Metrics are a side effect of ingest, never a reason for it to fail: a payload
// shaped in a way this section did not anticipate must not turn an already-
// archived batch into a 500 that the exporter then retries (and duplicates).
function safeEmit(fn) {
  try {
    return fn();
  } catch (e) {
    console.error('[prompt-logs] metric emit failed', e && e.name, e && e.message);
    return 0;
  }
}

// Dimension values must be non-empty, single-line and bounded; CloudWatch caps
// them at 256 chars.
function dimValue(v) {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, 200);
  return s || UNKNOWN_DIM;
}

// A project arrives as the spawning tab's absolute folder path. Dimension on the
// folder name (readable, low cardinality); the full path stays as a field.
function projectDim(p) {
  const s = String(p == null ? '' : p).trim().replace(/[\\/]+$/, '');
  if (!s) return UNKNOWN_DIM;
  const parts = s.split(/[\\/]/);
  return dimValue(parts[parts.length - 1] || s);
}

// Returns undefined for anything that is not genuinely a number, so a missing
// field is DROPPED rather than reported as a real 0 (Number('') and Number(null)
// are both 0, which would quietly fabricate zero-cost requests).
function metricNumber(v) {
  if (v === null || v === undefined || typeof v === 'boolean') return undefined;
  if (typeof v === 'string' && v.trim() === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return undefined;
  // Round sub-cent costs to 6dp so JSON stays compact without losing precision.
  return Math.round(n * 1e6) / 1e6;
}

// Snap to the enclosing minute — CloudWatch's standard storage resolution — so
// values from one export collapse into a single datum, and clamp to the window
// CloudWatch will accept.
function metricTimestamp(ts) {
  const now = Date.now();
  const n = Number(ts);
  const ms = (!Number.isFinite(n) || n <= 0 || n < now - METRIC_MAX_PAST_MS || n > now + METRIC_MAX_FUTURE_MS)
    ? now
    : Math.floor(n);
  return ms - (ms % 60000);
}

// The per-invocation accumulator: a Map keyed by metric + dimensions + minute,
// each entry holding the running StatisticValues for that key.
function newMetricBuffer() {
  return new Map();
}

// Record one observation of `name` against one dimension list.
function bufferValue(buffer, name, dimensions, value, timestamp) {
  const minute = metricTimestamp(timestamp);
  const key = `${name}${minute}${dimensions.map((d) => `${d.Name}=${d.Value}`).join('')}`;
  const entry = buffer.get(key);
  if (entry) {
    entry.count += 1;
    entry.sum += value;
    if (value < entry.min) entry.min = value;
    if (value > entry.max) entry.max = value;
    return;
  }
  buffer.set(key, {
    name,
    dimensions,
    minute,
    unit: METRIC_UNITS[name] || 'None',
    count: 1,
    sum: value,
    min: value,
    max: value
  });
}

// Buffer one set of metric values against every applicable dimension set.
// `fields` supplies the dimension values; a set is skipped when any of its keys
// is missing (so a model-less event does not create a bogus "unknown" model).
// Returns whether anything was recorded.
function collectMetrics(buffer, values, fields, timestamp, dimensionSets = DIMENSION_SETS) {
  if (!METRICS_ENABLED || !buffer) return false;
  const f = fields || {};
  const sets = dimensionSets
    .filter((set) => set.every((k) => typeof f[k] === 'string' && f[k]))
    .map((set) => set.map((k) => ({ Name: k, Value: f[k] })));
  if (!sets.length) return false;

  let recorded = false;
  for (const [name, raw] of Object.entries(values || {})) {
    const n = metricNumber(raw);
    if (n === undefined) continue;
    for (const dimensions of sets) bufferValue(buffer, name, dimensions, n, timestamp);
    recorded = true;
  }
  return recorded;
}

// Ship the buffer to the CloudWatch Metrics API. Never throws: metrics are a
// side effect of ingest, and a PutMetricData failure must not turn an
// already-archived batch into a 500 the exporter then retries (and duplicates).
async function publishMetrics(buffer) {
  if (!METRICS_ENABLED || !buffer || buffer.size === 0) return { datums: 0, calls: 0, dropped: 0 };

  const datums = [...buffer.values()].map((e) => ({
    MetricName: e.name,
    Dimensions: e.dimensions,
    Timestamp: new Date(e.minute),
    Unit: e.unit,
    StatisticValues: { SampleCount: e.count, Sum: e.sum, Minimum: e.min, Maximum: e.max }
  }));

  const capacity = MAX_DATUMS_PER_CALL * MAX_PUT_CALLS;
  const dropped = Math.max(0, datums.length - capacity);
  if (dropped > 0) {
    console.warn('[prompt-logs] metric datum cap hit — dropping', dropped, 'of', datums.length,
      '(raise MAX_PUT_CALLS or the function timeout)');
  }

  let calls = 0;
  let sent = 0;
  for (let i = 0; i < Math.min(datums.length, capacity); i += MAX_DATUMS_PER_CALL) {
    const chunk = datums.slice(i, i + MAX_DATUMS_PER_CALL);
    try {
      await cloudwatch.send(new PutMetricDataCommand({ Namespace: METRICS_NAMESPACE, MetricData: chunk }));
      calls += 1;
      sent += chunk.length;
    } catch (e) {
      console.error('[prompt-logs] PutMetricData failed', e && e.name, e && e.message, { datums: chunk.length });
    }
  }
  return { datums: sent, calls, dropped };
}

// Attribute readers — OTLP/JSON encodes int64 as a string, and Claude Code has
// shipped a couple of spellings for the same field over time.
function attrNum(attrs, ...names) {
  for (const name of names) {
    const n = metricNumber(attrs && attrs[name]);
    if (n !== undefined) return n;
  }
  return undefined;
}
function attrStr(attrs, ...names) {
  for (const name of names) {
    const v = attrs && attrs[name];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  }
  return '';
}

// Sum the token fields that are present; undefined when none are.
function sumTokens(parts) {
  const present = parts.filter((n) => n !== undefined);
  if (!present.length) return undefined;
  return present.reduce((a, b) => a + b, 0);
}

// Who/what a signal belongs to. Record attributes win over resource attributes;
// the app tags each OTLP resource with the spawning tab's `project` folder.
function identityOf(resource, attrs) {
  const r = resource || {};
  const a = attrs || {};
  const projectPath = attrStr(a, 'project') || attrStr(r, 'project');
  const model = attrStr(a, 'model');
  return {
    User: dimValue(
      attrStr(a, 'user.email', 'user.id', 'user.account_uuid')
      || attrStr(r, 'user.email', 'user.id', 'user.account_uuid', 'username')
    ),
    // Left undefined (not "unknown") on model-less events such as user_prompt,
    // so collectMetrics drops the Model dimension sets instead of inventing a
    // bogus "unknown" model series.
    Model: model ? dimValue(model) : undefined,
    Project: projectDim(projectPath),
    projectPath: projectPath || undefined,
    sessionId: attrStr(a, 'session.id') || attrStr(r, 'session.id') || undefined,
    organizationId: attrStr(a, 'organization.id') || undefined,
    host: attrStr(r, 'host.name', 'host.id') || undefined,
    service: attrStr(r, 'service.name') || undefined
  };
}

// Claude Code names its events in the record body ('claude_code.api_request'),
// in `eventName`, or in an `event.name` attribute ('api_request') depending on
// version. Normalise all three to the bare name.
function eventNameOf(record) {
  const body = typeof record.body === 'string' ? record.body : '';
  const raw = String(record.eventName || body || attrStr(record.attributes, 'event.name') || '').trim();
  return raw.replace(/^claude_code\./, '');
}

// Buffer the metric values carried by each flattened OTLP log record.
function collectOtlpLogMetrics(items, buffer) {
  if (!METRICS_ENABLED) return;
  for (const item of items) {
    const rec = item.record;
    const attrs = rec.attributes || {};
    const id = identityOf(rec.resource, attrs);
    const name = eventNameOf(rec);
    let values = null;

    if (name === 'api_request') {
      const input = attrNum(attrs, 'input_tokens');
      const output = attrNum(attrs, 'output_tokens');
      const cacheRead = attrNum(attrs, 'cache_read_tokens');
      const cacheCreation = attrNum(attrs, 'cache_creation_tokens');
      values = {
        CostUsd: attrNum(attrs, 'cost_usd'),
        InputTokens: input,
        OutputTokens: output,
        CacheReadTokens: cacheRead,
        CacheCreationTokens: cacheCreation,
        TotalTokens: sumTokens([input, output, cacheRead, cacheCreation]),
        RequestDurationMs: attrNum(attrs, 'duration_ms')
      };
    } else if (name === 'user_prompt') {
      values = { PromptLength: attrNum(attrs, 'prompt_length') };
    } else if (name === 'tool_result') {
      values = { ToolDurationMs: attrNum(attrs, 'duration_ms') };
    } else {
      continue;
    }

    collectMetrics(buffer, values, id, item.timestamp);
  }
}

// claude_code.* metric names → our metric name. These sums are CUMULATIVE
// monotonic running totals, so they are written through as-is and read with the
// Maximum statistic; the per-call `CostUsd` above is the summable one.
function metricNameFor(otlpName) {
  switch (otlpName) {
    case 'claude_code.cost.usage': return 'SessionCostUsdTotal';
    case 'claude_code.token.usage': return 'SessionTokensTotal';
    case 'claude_code.lines_of_code.count': return 'LinesOfCodeTotal';
    case 'claude_code.active_time.total': return 'ActiveTimeSecondsTotal';
    default: return null;
  }
}

// Publish each claude_code.* metric data point straight through as a metric.
function collectOtlpMetricMetrics(items, buffer) {
  if (!METRICS_ENABLED) return;
  for (const item of items) {
    const rec = item.record;
    const attrs = rec.attributes || {};
    const name = metricNameFor(rec.name);
    if (!name) continue;
    // Only scalar gauge/sum points carry a usable number; histogram aggregates
    // are objects and are left to the raw log group.
    if (typeof rec.value !== 'number' && typeof rec.value !== 'string') continue;
    const fields = {
      ...identityOf(rec.resource, attrs),
      // `type` splits token.usage into input/output/cacheRead/cacheCreation and
      // lines_of_code.count into added/removed.
      Type: attrStr(attrs, 'type') || undefined
    };
    // Type is a dimension here — without it the token/LOC breakdowns collapse.
    const sets = fields.Type ? DIMENSION_SETS.map((s) => [...s, 'Type']) : DIMENSION_SETS;
    collectMetrics(buffer, { [name]: rec.value }, fields, item.timestamp, sets);
  }
}

export const handler = async (event) => {
  const started = Date.now();
  const method = String(getMethod(event)).toUpperCase();
  const path =
    (event.requestContext && event.requestContext.http && event.requestContext.http.path) ||
    event.path ||
    event.rawPath ||
    '';
  console.log('[prompt-logs] invoke', {
    method,
    path,
    logGroup: LOG_GROUP,
    region: REGION,
    apiKeyConfigured: !!API_KEY,
    hasBody: !!event.body,
    bodyBytes: event.body ? event.body.length : 0,
    isBase64: !!event.isBase64Encoded,
    queryKeys: Object.keys(event.queryStringParameters || {}),
    headerKeys: Object.keys(event.headers || {})
  });
  try {
    if (!checkApiKey(event)) {
      console.warn('[prompt-logs] unauthorized', { hasHeader: !!headerLookup(event, 'x-api-key') });
      return fail(401, 'unauthorized');
    }
    if (method === 'OPTIONS') {
      console.log('[prompt-logs] OPTIONS preflight');
      return { statusCode: 204, headers: CORS, body: '' };
    }
    if (method === 'POST') {
      const pathSignal = otlpSignalFromPath(path);
      const contentType = String(headerLookup(event, 'content-type') || '').toLowerCase();
      if (pathSignal && contentType.includes('protobuf')) {
        console.warn('[prompt-logs] otlp protobuf rejected', { pathSignal, contentType });
        return fail(415, 'OTLP protobuf is not supported; set OTEL_EXPORTER_OTLP_PROTOCOL=http/json');
      }
      const body = getBody(event);
      // Body shape wins over the path so a client posting to the bare endpoint
      // (no /v1/* suffix) still lands on the right signal.
      const signal = isOtlpBody(body) || pathSignal;
      let res;
      if (signal) res = await handleOtlp(signal, body);
      else if (isTelemetryPayload(body)) res = await handleTelemetry(event, body);
      else res = await handleAdd(event);
      console.log('[prompt-logs] done', { method, status: res.statusCode, ms: Date.now() - started });
      return res;
    }
    if (method === 'GET') {
      const qs = getQuery(event);
      const res = qs && qs.schema === TELEMETRY_SCHEMA
        ? await handleTelemetryList(event)
        : await handleList(event);
      console.log('[prompt-logs] done', { method, status: res.statusCode, ms: Date.now() - started });
      return res;
    }
    console.warn('[prompt-logs] method not allowed', method);
    return fail(405, 'method not allowed');
  } catch (e) {
    console.error('[prompt-logs] handler error', e && e.name, e && e.message, e);
    return fail(500, e.message || 'internal error');
  }
};
