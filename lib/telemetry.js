'use strict';

// Pure, Electron-free model for the app's Claude Code telemetry / cost feature
// (token + cost visibility). Like lib/team-config.js, lib/ticket-queue.js and the
// other lib/* modules this file deliberately requires NOTHING from Electron, the
// DOM, disk, or the network so it can be unit-tested with plain `node --test`.
// Every function here is pure and TOTALLY tolerant of junk: null / partial /
// malformed / hostile input always collapses to a safe, complete value and NEVER
// throws. The main process wires the real HTTP receiver, env injection, and the
// "forward to a URL" POST around these helpers.
//
// HOW THE FEATURE WORKS (verified empirically against `claude` 2.1.212):
//   Claude Code has built-in OpenTelemetry. With CLAUDE_CODE_ENABLE_TELEMETRY=1
//   and OTEL_EXPORTER_OTLP_PROTOCOL=http/json it POSTs OTLP/JSON to
//   `<endpoint>/v1/metrics` and `<endpoint>/v1/logs`. The app runs a tiny local
//   receiver on 127.0.0.1, points `claude` at it via env vars (buildOtelEnv), and
//   reads usage from the exported data — NO OTLP collector and NO protobuf decoder
//   are needed because http/json gives plain JSON. The single richest source is the
//   `claude_code.api_request` LOG record, which carries, per API call: model,
//   input/output/cache tokens, cost_usd, duration_ms, request_id and session.id.
//   The `claude_code.token.usage` / `claude_code.cost.usage` METRICS are cumulative
//   monotonic sums, kept only as a cross-check. This module extracts both shapes.
//
//   IMPORTANT constraint (surfaced honestly to the user): Claude Code only speaks
//   OTLP — it will NOT POST plain JSON to an arbitrary REST URL. So "store online"
//   is done by the APP forwarding its own compact JSON summary (buildForwardPayload)
//   to any URL the user gives; the raw OTLP never leaves the machine.

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// The OTLP/JSON protocol id we pin so the receiver gets JSON (not protobuf).
const OTLP_PROTOCOL = 'http/json';

// Export intervals (ms). Shorter than Claude Code's defaults (60s metrics / 5s
// logs) so the in-app view updates promptly and less data is lost if a run is
// killed; still long enough to avoid meaningful overhead.
const DEFAULT_METRIC_INTERVAL_MS = 10000;
const DEFAULT_LOGS_INTERVAL_MS = 5000;

// The receiver's default loopback port. 0 asks the OS for an ephemeral port; the
// main process substitutes the real bound port into the endpoint before spawning.
const DEFAULT_PORT = 0;

// Keys that must never be copied by plain assignment during an unknown-field
// round-trip (prototype-pollution guard), mirroring lib/team-config.js.
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// Coerce to a trimmed string ('' for null/undefined/non-string).
function str(v) {
  return typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim());
}

// Coerce to a finite number, else the fallback.
function num(v, fallback) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// True only for an http(s) URL. Used to validate the user's "forward" URL and any
// passthrough endpoint. Never throws (URL parse failures return false).
function isHttpUrl(s) {
  const v = str(s);
  if (v === '') return false;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

// Normalise ANY input into a complete, valid telemetry config with a `warnings`
// list. Tolerates null/junk/partial/tampered input and never throws.
//
// Shape:
//   { enabled: bool,
//     port: int >= 0,             // receiver port (0 = ephemeral)
//     forwardUrl: string,         // '' or a valid http(s) URL
//     forwardToken: string,       // optional bearer token for the forward POST
//     forwardEnabled: bool,       // only meaningful with a valid forwardUrl
//     metricIntervalMs, logsIntervalMs: int >= 1000,
//     serviceName: string,
//     warnings: [ ... ] }
function normalizeTelemetryConfig(raw) {
  const warnings = [];
  const src = isPlainObject(raw) ? raw : {};
  if (raw != null && !isPlainObject(raw)) {
    warnings.push('telemetry config was not an object; regenerated from defaults');
  }

  const enabled = src.enabled === true || src.enabled === 'true' || src.enabled === 1;

  let port = num(src.port, DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    if (src.port != null) warnings.push(`telemetry port ${JSON.stringify(src.port)} is invalid; using an ephemeral port`);
    port = DEFAULT_PORT;
  }

  let forwardUrl = str(src.forwardUrl);
  if (forwardUrl !== '' && !isHttpUrl(forwardUrl)) {
    warnings.push('forwardUrl is not a valid http(s) URL; ignored');
    forwardUrl = '';
  }

  const forwardToken = str(src.forwardToken);
  // Forwarding can only be on with a valid destination.
  const forwardEnabled = (src.forwardEnabled === true || src.forwardEnabled === 'true')
    && forwardUrl !== '';

  let metricIntervalMs = num(src.metricIntervalMs, DEFAULT_METRIC_INTERVAL_MS);
  if (metricIntervalMs < 1000) metricIntervalMs = DEFAULT_METRIC_INTERVAL_MS;
  let logsIntervalMs = num(src.logsIntervalMs, DEFAULT_LOGS_INTERVAL_MS);
  if (logsIntervalMs < 1000) logsIntervalMs = DEFAULT_LOGS_INTERVAL_MS;

  const serviceName = str(src.serviceName) || 'claude-cmd-ui';

  return {
    enabled,
    port: Math.floor(port),
    forwardUrl,
    forwardToken,
    forwardEnabled,
    metricIntervalMs: Math.floor(metricIntervalMs),
    logsIntervalMs: Math.floor(logsIntervalMs),
    serviceName,
    warnings,
  };
}

// Build the map of OTEL_* env vars that make a spawned `claude` export telemetry
// to the local receiver at `endpoint`. Returns {} when telemetry is disabled or
// the endpoint is not a valid http URL (so a bad config silently exports nothing
// rather than mis-pointing the CLI). `endpoint` is the receiver's actual bound
// base URL, e.g. "http://127.0.0.1:41999". Pure — never reads process.env.
function buildOtelEnv(config, endpoint) {
  const cfg = normalizeTelemetryConfig(config);
  if (!cfg.enabled) return {};
  if (!isHttpUrl(endpoint)) return {};
  const env = {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_PROTOCOL: OTLP_PROTOCOL,
    OTEL_EXPORTER_OTLP_ENDPOINT: str(endpoint),
    OTEL_METRIC_EXPORT_INTERVAL: String(cfg.metricIntervalMs),
    OTEL_LOGS_EXPORT_INTERVAL: String(cfg.logsIntervalMs),
    OTEL_SERVICE_NAME: cfg.serviceName,
  };
  return env;
}

// ---------------------------------------------------------------------------
// OTLP/JSON attribute helpers
// ---------------------------------------------------------------------------

// Read a single OTLP AnyValue ({stringValue|intValue|doubleValue|boolValue}).
// OTLP/JSON encodes int64 as a STRING, so intValue may be "10" or 10 — coerce.
// Returns a string | number | boolean | null.
function anyValue(v) {
  if (!isPlainObject(v)) return null;
  if (typeof v.stringValue === 'string') return v.stringValue;
  if (v.intValue != null) { const n = Number(v.intValue); return Number.isFinite(n) ? n : null; }
  if (v.doubleValue != null) { const n = Number(v.doubleValue); return Number.isFinite(n) ? n : null; }
  if (typeof v.boolValue === 'boolean') return v.boolValue;
  return null;
}

// Turn an OTLP attributes array ([{key, value}]) into a plain { key: value } map.
function attrsToObject(attributes) {
  const out = {};
  if (!Array.isArray(attributes)) return out;
  for (const a of attributes) {
    if (!isPlainObject(a) || typeof a.key !== 'string' || UNSAFE_KEYS.has(a.key)) continue;
    out[a.key] = anyValue(a.value);
  }
  return out;
}

// ---------------------------------------------------------------------------
// OTLP/JSON — logs → per-request usage rows
// ---------------------------------------------------------------------------

// Best-effort percent-decode of a resource attribute value. OTEL_RESOURCE_
// ATTRIBUTES is transported as W3C-Baggage-style `key=value` pairs, so a value
// containing reserved characters (e.g. a Windows path with `\` or spaces) may
// arrive percent-encoded. Decode when possible; on failure (malformed escape
// sequences) fall back to the raw string as-is. Never throws.
//
// TASK-167: deliberately does NOT trim (unlike the general-purpose `str()`
// helper). TASK-153 empirically confirmed Claude Code's OTEL SDK
// (`@opentelemetry/resources` EnvDetector) already fully percent-decodes the
// `project` resource attribute before we ever see it here, so by the time
// `raw` reaches this function any incidental leading/trailing whitespace in
// the ORIGINAL project string (e.g. `tab.folder`) is plain, literal
// whitespace again — not hidden behind `%20`. Trimming it here would silently
// diverge this ingest-side key from `setProjectForwarding`'s key, which is
// sourced from the exact same `tab.folder` string with no trim anywhere in
// its path (renderer's `buildTelemetryControl` -> `setProjectConfig` ->
// `setProjectForwarding`). Coerce-to-string only; decode is a no-op when the
// value has no percent-escapes left (i.e. it was already decoded upstream).
function decodeAttrValue(v) {
  const s = typeof v === 'string' ? v : (v == null ? '' : String(v));
  if (s === '') return s;
  try {
    return decodeURIComponent(s);
  } catch (_) {
    return s;
  }
}

// Read the per-resourceLogs `project` attribute (the spawning tab's absolute
// folder path) from `resourceLogs[].resource.attributes`. Returns '' when the
// resource block is missing/malformed, the attribute is absent/empty, or its
// value is not a string. Never throws.
function resourceProject(rl) {
  const resource = isPlainObject(rl) ? rl.resource : null;
  const attrs = isPlainObject(resource) ? attrsToObject(resource.attributes) : {};
  const raw = attrs.project;
  if (typeof raw !== 'string' || raw === '') return '';
  return decodeAttrValue(raw);
}

// Extract `claude_code.api_request` records from an OTLP/JSON logs payload
// (`{ resourceLogs: [ { resource: { attributes }, scopeLogs: [ { logRecords: [...] } ] } ] }`).
// Each record is the richest per-call usage row Claude Code emits. Returns an
// array of:
//   { requestId, sessionId, model, querySource, timestamp (ISO or ''),
//     inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens,
//     costUsd, durationMs, project }
// `project` is read from the resourceLogs entry's own resource attributes (the
// spawning tab's absolute folder path), best-effort percent-decoded, and is
// NOT part of requestKey's de-dup identity. Non-api_request records are
// skipped. Never throws.
function extractApiRequests(logsJson) {
  const out = [];
  const root = isPlainObject(logsJson) ? logsJson : null;
  if (!root || !Array.isArray(root.resourceLogs)) return out;
  for (const rl of root.resourceLogs) {
    const project = resourceProject(rl);
    const scopeLogs = isPlainObject(rl) && Array.isArray(rl.scopeLogs) ? rl.scopeLogs : [];
    for (const sl of scopeLogs) {
      const recs = isPlainObject(sl) && Array.isArray(sl.logRecords) ? sl.logRecords : [];
      for (const rec of recs) {
        if (!isPlainObject(rec)) continue;
        const body = rec.body && typeof rec.body.stringValue === 'string' ? rec.body.stringValue : '';
        const attrs = attrsToObject(rec.attributes);
        const isApiRequest = body === 'claude_code.api_request'
          || attrs['event.name'] === 'api_request';
        if (!isApiRequest) continue;
        out.push({
          requestId: str(attrs.request_id),
          sessionId: str(attrs['session.id']),
          model: str(attrs.model),
          querySource: str(attrs.query_source),
          timestamp: str(attrs['event.timestamp']),
          inputTokens: num(attrs.input_tokens, 0),
          outputTokens: num(attrs.output_tokens, 0),
          cacheReadTokens: num(attrs.cache_read_tokens, 0),
          cacheCreationTokens: num(attrs.cache_creation_tokens, 0),
          costUsd: num(attrs.cost_usd, 0),
          durationMs: num(attrs.duration_ms, 0),
          project,
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// OTLP/JSON — metrics → cumulative cross-check snapshot
// ---------------------------------------------------------------------------

// Walk every numeric sum data point of a named metric in an OTLP/JSON metrics
// payload. `cb(value, attrsObject)` is invoked per data point. Never throws.
function forEachSumDataPoint(metricsJson, metricName, cb) {
  const root = isPlainObject(metricsJson) ? metricsJson : null;
  if (!root || !Array.isArray(root.resourceMetrics)) return;
  for (const rm of root.resourceMetrics) {
    const scopeMetrics = isPlainObject(rm) && Array.isArray(rm.scopeMetrics) ? rm.scopeMetrics : [];
    for (const sm of scopeMetrics) {
      const metrics = isPlainObject(sm) && Array.isArray(sm.metrics) ? sm.metrics : [];
      for (const met of metrics) {
        if (!isPlainObject(met) || met.name !== metricName) continue;
        const dps = met.sum && Array.isArray(met.sum.dataPoints) ? met.sum.dataPoints : [];
        for (const dp of dps) {
          if (!isPlainObject(dp)) continue;
          const value = num(dp.asDouble != null ? dp.asDouble : dp.asInt, NaN);
          if (!Number.isFinite(value)) continue;
          cb(value, attrsToObject(dp.attributes));
        }
      }
    }
  }
}

// Extract a cumulative cross-check snapshot from an OTLP/JSON metrics payload.
// Because claude_code.* sums are CUMULATIVE MONOTONIC, each export carries the
// running total for a (session, model[, type]) key — so callers keep the LATEST
// value per key rather than summing across exports. Returns:
//   { cost: { "<session>|<model>": usd, ... },
//     tokens: { "<session>|<model>|<type>": count, ... } }
// The caller reduces these to a grand total by last-value-wins per key.
function extractMetricSnapshot(metricsJson) {
  const cost = {};
  const tokens = {};
  forEachSumDataPoint(metricsJson, 'claude_code.cost.usage', (value, attrs) => {
    const key = `${str(attrs['session.id'])}|${str(attrs.model)}`;
    cost[key] = value;
  });
  forEachSumDataPoint(metricsJson, 'claude_code.token.usage', (value, attrs) => {
    const key = `${str(attrs['session.id'])}|${str(attrs.model)}|${str(attrs.type)}`;
    tokens[key] = value;
  });
  return { cost, tokens };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function emptyTotals() {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    durationMs: 0,
  };
}

function addRecordInto(totals, r) {
  totals.requests += 1;
  totals.inputTokens += num(r.inputTokens, 0);
  totals.outputTokens += num(r.outputTokens, 0);
  totals.cacheReadTokens += num(r.cacheReadTokens, 0);
  totals.cacheCreationTokens += num(r.cacheCreationTokens, 0);
  totals.costUsd += num(r.costUsd, 0);
  totals.durationMs += num(r.durationMs, 0);
  totals.totalTokens = totals.inputTokens + totals.outputTokens
    + totals.cacheReadTokens + totals.cacheCreationTokens;
}

// Aggregate an array of api_request rows into grand totals plus a per-model
// breakdown. Pure. Bad rows contribute 0, never NaN.
//   -> { totals: {...}, byModel: { "<model>": {...} }, models: ["<model>", ...] }
function aggregateUsage(records) {
  const list = Array.isArray(records) ? records : [];
  const totals = emptyTotals();
  const byModel = {};
  for (const r of list) {
    if (!isPlainObject(r)) continue;
    addRecordInto(totals, r);
    const model = str(r.model) || '(unknown)';
    if (!byModel[model]) byModel[model] = emptyTotals();
    addRecordInto(byModel[model], r);
  }
  return { totals, byModel, models: Object.keys(byModel).sort() };
}

// Normalize a model string to its "family" for the usageForWindow tie-breaker
// (TASK-146): strip a trailing dated build suffix — "-20251001" or
// "-2025-10-01" style — so the orchestrator's short dispatched label
// ("claude-haiku-4-5") normalizes to the same family as the full dated API
// model string OTEL rows carry ("claude-haiku-4-5-20251001"). Genuinely
// different families (e.g. "claude-sonnet" vs "claude-haiku") still differ
// after normalization. Pure, trims, never throws.
function modelFamily(model) {
  const s = str(model);
  if (s === '') return '';
  return s.replace(/-\d{4}-?\d{2}-?\d{2}$/, '');
}

// Sum the api_request rows (as from extractApiRequests) whose `timestamp` falls
// INCLUSIVELY inside `window.{startedAt, finishedAt}` — the per-ticket cost
// correlation for TASK-142. When `window.model` and a row's `model` are BOTH
// non-empty they must match on normalized model FAMILY (trimmed; a trailing
// dated build suffix like "-20251001" is stripped before comparing — TASK-146)
// so a short dispatched label matches the full dated telemetry model string;
// an empty model on either side disables the model filter (time window only).
// Pure and best-effort: bad/malformed rows, an unparseable row timestamp, a
// null/junk window, or a window with a missing/reversed startedAt/finishedAt
// all contribute nothing and NEVER throw — this returns emptyTotals() (all
// zero) rather than a fabricated figure whenever nothing can be correlated.
function usageForWindow(records, window) {
  const totals = emptyTotals();
  const list = Array.isArray(records) ? records : [];
  if (list.length === 0) return totals;
  const win = isPlainObject(window) ? window : null;
  if (!win) return totals;
  const startedAt = new Date(win.startedAt).getTime();
  const finishedAt = new Date(win.finishedAt).getTime();
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt < startedAt) return totals;
  const winModel = str(win.model);
  const winFamily = modelFamily(winModel);
  for (const r of list) {
    if (!isPlainObject(r)) continue;
    const ts = new Date(str(r.timestamp)).getTime();
    if (!Number.isFinite(ts)) continue;
    if (ts < startedAt || ts > finishedAt) continue;
    const rowModel = str(r.model);
    if (winModel !== '' && rowModel !== '' && modelFamily(rowModel) !== winFamily) continue;
    addRecordInto(totals, r);
  }
  return totals;
}

// ---------------------------------------------------------------------------
// De-dup key for a request row (the receiver may see a retried export twice).
// ---------------------------------------------------------------------------

// A stable identity for one api_request row so the receiver can de-duplicate a
// re-sent OTLP export. request_id is unique per API call; fall back to a
// composite when a record lacks one.
function requestKey(r) {
  if (!isPlainObject(r)) return '';
  const id = str(r.requestId);
  if (id !== '') return id;
  return `${str(r.sessionId)}|${str(r.timestamp)}|${num(r.inputTokens, 0)}|${num(r.outputTokens, 0)}|${num(r.costUsd, 0)}`;
}

// ---------------------------------------------------------------------------
// Forward payload — the compact JSON the APP posts to the user's "store online"
// URL (works with ANY endpoint; this is the app's own schema, not OTLP).
// ---------------------------------------------------------------------------

// Build the JSON body forwarded to the user's URL. `generatedAt` is passed in
// (callers stamp the time; this module never reads the clock). `recent` is an
// optional capped list of the latest request rows. The identity fields
// (`sessionId`, `username`, `project`) let the online store attribute a summary
// to one app run, one user, and one project folder alongside `host`; each is a
// best-effort string that collapses to '' when absent. Pure.
function buildForwardPayload(opts) {
  const o = isPlainObject(opts) ? opts : {};
  const usage = isPlainObject(o.usage) ? o.usage : aggregateUsage([]);
  const recentLimit = num(o.recentLimit, 20);
  const recent = Array.isArray(o.recent) ? o.recent.slice(-Math.max(0, recentLimit)) : [];
  return {
    source: 'claude-cmd-ui',
    schema: 'telemetry.usage.v1',
    generatedAt: str(o.generatedAt),
    host: str(o.host),
    sessionId: str(o.sessionId),
    username: str(o.username),
    project: str(o.project),
    totals: isPlainObject(usage.totals) ? usage.totals : emptyTotals(),
    byModel: isPlainObject(usage.byModel) ? usage.byModel : {},
    recent,
  };
}

module.exports = {
  OTLP_PROTOCOL,
  DEFAULT_METRIC_INTERVAL_MS,
  DEFAULT_LOGS_INTERVAL_MS,
  DEFAULT_PORT,
  isHttpUrl,
  normalizeTelemetryConfig,
  buildOtelEnv,
  anyValue,
  attrsToObject,
  decodeAttrValue,
  resourceProject,
  extractApiRequests,
  extractMetricSnapshot,
  forEachSumDataPoint,
  aggregateUsage,
  emptyTotals,
  modelFamily,
  usageForWindow,
  requestKey,
  buildForwardPayload,
};
