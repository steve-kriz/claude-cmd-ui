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
// The POST route auto-detects which shape it got (telemetry payloads carry
// `schema === 'telemetry.usage.v1'`) so a single endpoint serves both clients.
//
// Configure via environment variables:
//   LOG_GROUP            Prompt-log CloudWatch log group. Default: /claude-cmd-ui/prompts
//   TELEMETRY_LOG_GROUP  Telemetry CloudWatch log group. Default: /claude-cmd-ui/telemetry
//   AWS_REGION           Region (set automatically by Lambda)
//   API_KEY              Optional shared secret. Clients send it as `X-Api-Key: <value>`
//                        (prompt logs) or `Authorization: Bearer <value>` (telemetry).
//
// IAM permissions required by the Lambda execution role:
//   logs:CreateLogGroup, logs:CreateLogStream,
//   logs:PutLogEvents,   logs:GetLogEvents
// on both LOG_GROUP and TELEMETRY_LOG_GROUP (and `${…}:*`).

import {
  CloudWatchLogsClient,
  CreateLogGroupCommand,
  CreateLogStreamCommand,
  PutLogEventsCommand,
  GetLogEventsCommand
} from '@aws-sdk/client-cloudwatch-logs';

const LOG_GROUP = process.env.LOG_GROUP || '/claude-cmd-ui/prompts';
const TELEMETRY_LOG_GROUP = process.env.TELEMETRY_LOG_GROUP || '/claude-cmd-ui/telemetry';
const TELEMETRY_SCHEMA = 'telemetry.usage.v1';
const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
const API_KEY = (process.env.API_KEY || '').trim();

const client = new CloudWatchLogsClient(REGION ? { region: REGION } : {});

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-Api-Key'
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
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
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
  return ok({ ok: true });
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
  return ok({ ok: true });
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
      const body = getBody(event);
      const res = isTelemetryPayload(body)
        ? await handleTelemetry(event, body)
        : await handleAdd(event);
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
