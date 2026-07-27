'use strict';

// The app's local OTLP receiver + forwarder for Claude Code telemetry. This is
// the runtime around the pure model in lib/telemetry.js: it binds a tiny HTTP
// server on 127.0.0.1 that `claude` exports OTLP/JSON to, accumulates per-call
// usage (de-duplicated), and — when the user configures a "store online" URL —
// forwards the app's own compact JSON summary there. It uses only Node core
// (http/https) and lib/telemetry.js; it requires NOTHING from Electron, so it can
// be exercised end-to-end over a real loopback socket under `node --test`.
//
// SECURITY: the server binds LOOPBACK ONLY (127.0.0.1), accepts only POST, caps
// the request body, and never echoes request contents. It is an ingest sink for
// the local `claude` process, not a public endpoint.
//
// The forward HTTP call is injectable (`forwardRequest`) so tests never hit the
// network; the default posts JSON with an optional Bearer token and swallows all
// errors (telemetry must never crash or block the app).

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');
const tel = require('./telemetry');

const MAX_BODY_BYTES = 8 * 1024 * 1024; // reject absurd OTLP bodies
const RECENT_CAP = 500;                 // cap the in-memory recent-rows feed
const FORWARD_DEBOUNCE_MS = 4000;       // coalesce forwards after a burst of ingest
// TASK-163: `project` is read straight from each row's OTLP resource attribute,
// which is externally influenced (this is a loopback sink any local process can
// POST to). Without a cap, a buggy/hostile client posting many distinct fake
// `project` values would grow the `buckets` Map without bound. 100 is well above
// any realistic number of concurrently-open project folders.
const MAX_PROJECT_BUCKETS = 100;
// TASK-165: `projectForwarding` is keyed by the SAME externally-influenced
// `project` strings (reachable from the renderer via telemetry:setProjectConfig,
// not just OTLP rows), so it needs the identical cap/eviction treatment as
// `buckets` above. Same value, same reasoning — kept as its own constant so a
// future change to one cap doesn't silently also change the other.
const MAX_PROJECT_FORWARDING = MAX_PROJECT_BUCKETS;
const LOOPBACK = '127.0.0.1';

// TASK-165: shared LRU-capping helper. A Map preserves insertion order, so
// re-inserting a key ("touching" it) moves it to the end (most-recently-used);
// the least-recently-touched entry is always the first key. Call this
// IMMEDIATELY BEFORE `map.set(key, value)` — it deletes `key` first (a no-op
// touch if present, so touching an already-cached entry never evicts anything),
// then, only if the map is still at/over `maxSize` (i.e. `key` is a genuinely
// new entry and there's no room), evicts the single oldest entry to make room.
// Never throws.
function touchLruMap(map, key, maxSize) {
  map.delete(key);
  if (map.size >= maxSize) {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) map.delete(oldestKey);
  }
}

// Default forward client: POST `payload` as JSON to `url` with an optional Bearer
// token. Resolves { ok, status } and NEVER rejects (all failures → { ok:false }).
function defaultForwardRequest({ url, token, payload, timeoutMs = 10000 }) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (_) { return resolve({ ok: false, error: 'bad-url' }); }
    const lib = u.protocol === 'https:' ? https : http;
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const headers = { 'content-type': 'application/json', 'content-length': body.length };
    if (token) headers['authorization'] = `Bearer ${token}`;
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    let req;
    try {
      req = lib.request(
        { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST', headers },
        (res) => {
          res.on('data', () => {});
          res.on('end', () => finish({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode }));
        }
      );
    } catch (_) {
      return finish({ ok: false, error: 'request-failed' });
    }
    req.on('error', () => finish({ ok: false, error: 'network' }));
    req.setTimeout(timeoutMs, () => { try { req.destroy(new Error('timeout')); } catch (_) {} finish({ ok: false, error: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

// Create a receiver. Options:
//   config          initial (raw) telemetry config → normalized internally
//   onUpdate(state) called after every ingest with { usage, metricTotals, running }
//   forwardRequest  injectable forward client (defaults to defaultForwardRequest)
//   host()          returns the machine host label for the forward payload
//   username()      returns the OS username label for the forward payload
//   sessionId       stable id for this app run's telemetry (injected for tests;
//                   defaults to a random UUID minted once per receiver instance)
//   now()           returns an ISO timestamp string (injected — this module never
//                   reads the clock itself, mirroring the lib/* purity convention)
//   log(msg, err)   optional logger
function createTelemetryReceiver(opts = {}) {
  const onUpdate = typeof opts.onUpdate === 'function' ? opts.onUpdate : () => {};
  const forwardRequest = typeof opts.forwardRequest === 'function' ? opts.forwardRequest : defaultForwardRequest;
  const hostFn = typeof opts.host === 'function' ? opts.host : () => '';
  const usernameFn = typeof opts.username === 'function' ? opts.username : () => '';
  const nowFn = typeof opts.now === 'function' ? opts.now : () => '';
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const forwardDebounceMs = Number.isFinite(opts.forwardDebounceMs) ? opts.forwardDebounceMs : FORWARD_DEBOUNCE_MS;

  // Identity for this app run. sessionId is minted once (a client can inject a
  // deterministic value in tests); activeProject is the renderer-reported name of
  // the folder the user is currently looking at (the receiver is app-global, so it
  // is set/updated at runtime rather than fixed at construction).
  const sessionId = typeof opts.sessionId === 'string' && opts.sessionId
    ? opts.sessionId
    : crypto.randomUUID();
  let activeProject = typeof opts.project === 'string' ? opts.project : '';

  let config = tel.normalizeTelemetryConfig(opts.config);
  let server = null;
  let endpoint = '';
  let running = false;
  // Log-derived rows are bucketed per project (TASK-154): each row's OWN
  // `project` field (a resource attribute, decoded in lib/telemetry.js) — NOT
  // `activeProject` — decides which bucket it lands in. Empty/unknown project
  // rows fall into the '' bucket so nothing is lost. Each bucket keeps its own
  // de-dup store AND its own capped `recent` feed.
  //   buckets: Map<project, { store: Map<requestKey, row>, recent: row[] }>
  const buckets = new Map();
  // Global de-dup identity, independent of per-project bucketing. `requestKey`
  // (lib/telemetry.js) explicitly does NOT fold `project` into the key, so the
  // same request_id posted under two different `project` tags must still be
  // counted exactly once app-wide (first write wins) — matching the
  // pre-bucketing behavior of a single global `store`. Checked BEFORE routing
  // a row into its project's bucket.
  const seenKeys = new Set();
  // App-wide chronological feed across every bucket (backward compatible with
  // the pre-bucketing single `recent` array); still capped at RECENT_CAP.
  let globalRecent = [];
  let metricSnapshot = { cost: {}, tokens: {} };
  let forwardTimer = null;
  // Per-project "store online" toggle (TASK-156): Map<project, boolean>. Read
  // by scheduleForward's per-bucket fan-out. Unknown projects default to false
  // (opt-in) — a project never forwards until explicitly enabled at least once
  // via setProjectForwarding. Independent of the app-global master switch
  // (config.forwardEnabled/forwardUrl), which still gates ALL forwarding.
  const projectForwarding = new Map();

  function getBucket(project) {
    const key = typeof project === 'string' ? project : '';
    return buckets.get(key);
  }

  // TASK-163: `buckets` is an LRU capped at MAX_PROJECT_BUCKETS via the shared
  // touchLruMap helper (TASK-165) — touching an existing bucket just reorders
  // it to most-recently-used; only a genuinely new project can trigger an
  // eviction of the least-recently-touched bucket once at cap. Eviction only
  // drops that project's rows from the in-memory buckets Map — it never
  // throws and every read path (usage(), usageForProject, etc.) simply stops
  // seeing an evicted bucket's data, same as any other capacity-bounded cache.
  function ensureBucket(project) {
    const key = typeof project === 'string' ? project : '';
    const existing = buckets.get(key);
    const bucket = existing || { store: new Map(), recent: [] };
    touchLruMap(buckets, key, MAX_PROJECT_BUCKETS);
    buckets.set(key, bucket);
    return bucket;
  }

  // Every log-derived row across every project bucket (app-wide roll-up).
  function allRows() {
    const out = [];
    for (const bucket of buckets.values()) {
      for (const r of bucket.store.values()) out.push(r);
    }
    return out;
  }

  // App-wide aggregate (all buckets combined) — kept for the legacy
  // `telemetry:getUsage` path and cross-checks.
  function usage() { return tel.aggregateUsage(allRows()); }

  // Aggregate over just ONE project's bucket. Never throws: an unknown/empty
  // project, or a project with no rows yet, yields aggregateUsage([]) (zero
  // totals) rather than throwing.
  function usageForProject(project) {
    const bucket = getBucket(project);
    return tel.aggregateUsage(bucket ? Array.from(bucket.store.values()) : []);
  }

  // Reduce the cumulative metric snapshot (latest value per key) to grand totals,
  // used only as a cross-check next to the log-derived totals.
  function metricTotals() {
    let costUsd = 0;
    for (const k of Object.keys(metricSnapshot.cost)) costUsd += Number(metricSnapshot.cost[k]) || 0;
    const byType = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    for (const k of Object.keys(metricSnapshot.tokens)) {
      const type = k.split('|')[2];
      if (type in byType) byType[type] += Number(metricSnapshot.tokens[k]) || 0;
    }
    const totalTokens = byType.input + byType.output + byType.cacheRead + byType.cacheCreation;
    return { costUsd, totalTokens, byType };
  }

  // `project` is the bucket that just changed (defaults to activeProject, the
  // "default bucket", when a caller doesn't name one — e.g. a metrics-only
  // ingest, or clear()). Always includes the app-wide `usage`/`metricTotals`
  // AND the named project's own `projectUsage` so a Stats-tab view scoped to
  // one project can read a single snapshot.
  function snapshotState(project) {
    const proj = typeof project === 'string' ? project : activeProject;
    return {
      usage: usage(),
      metricTotals: metricTotals(),
      running,
      project: proj,
      projectUsage: usageForProject(proj),
    };
  }

  function emit(project) { try { onUpdate(snapshotState(project)); } catch (_) {} }

  // TASK-156: forwarding is now PER PROJECT. The app-global master switch
  // (config.forwardEnabled + a valid config.forwardUrl) still gates ALL
  // forwarding — when it is off, nothing below ever runs. When it is on, the
  // debounced tick fans out ONE payload per project bucket, built from that
  // bucket's own usage/recent, but ONLY for a bucket that (a) has rows to send
  // and (b) has its own store-online toggle enabled via setProjectForwarding.
  // A project whose toggle is off (or never set — opt-in defaults to false) is
  // skipped even though the master switch is on.
  function scheduleForward() {
    if (!config.forwardEnabled || !config.forwardUrl) return;
    if (forwardTimer) return; // already pending
    forwardTimer = setTimeout(() => {
      forwardTimer = null;
      for (const [project, bucket] of buckets.entries()) {
        if (!bucket || bucket.store.size === 0) continue; // nothing to send
        if (projectForwarding.get(project) !== true) continue; // per-project opt-in
        const payload = tel.buildForwardPayload({
          usage: usageForProject(project),
          recent: bucket.recent,
          generatedAt: nowFn(),
          host: hostFn(),
          sessionId,
          username: usernameFn(),
          project,
        });
        Promise.resolve(forwardRequest({ url: config.forwardUrl, token: config.forwardToken, payload }))
          .then((r) => { if (!r || !r.ok) log('telemetry forward failed', r); })
          .catch((e) => log('telemetry forward threw', e));
      }
    }, forwardDebounceMs);
    if (forwardTimer && typeof forwardTimer.unref === 'function') forwardTimer.unref();
  }

  // Set (or clear) one project's "store online" toggle. Never throws: a
  // non-string `project` collapses to the '' bucket key (mirroring
  // getBucket/ensureBucket); a non-strict-true `enabled` collapses to false.
  // Unknown/never-set projects read back as false (opt-in) via the `!== true`
  // check in scheduleForward above.
  //
  // TASK-165: `project` here is caller-controlled all the way from the
  // renderer (telemetry:setProjectConfig IPC), so — same as `buckets` above —
  // `projectForwarding` is capped at MAX_PROJECT_FORWARDING via the shared
  // touchLruMap helper: setting an already-known project just re-touches it
  // (no eviction), and only a genuinely new project can evict the
  // least-recently-set entry once at cap.
  function setProjectForwarding(project, enabled) {
    const key = typeof project === 'string' ? project : '';
    const val = enabled === true || enabled === 'true' || enabled === 1;
    touchLruMap(projectForwarding, key, MAX_PROJECT_FORWARDING);
    projectForwarding.set(key, val);
    return val;
  }

  function ingestLogs(json) {
    const rows = tel.extractApiRequests(json);
    let added = 0;
    let lastProject = activeProject;
    for (const r of rows) {
      const key = tel.requestKey(r);
      if (key === '') continue;
      if (seenKeys.has(key)) continue; // de-dup GLOBALLY, across every project bucket
      const project = typeof r.project === 'string' ? r.project : '';
      const bucket = ensureBucket(project);
      seenKeys.add(key);
      bucket.store.set(key, r);
      bucket.recent.push(r);
      if (bucket.recent.length > RECENT_CAP) bucket.recent = bucket.recent.slice(-RECENT_CAP);
      globalRecent.push(r);
      lastProject = project;
      added++;
    }
    if (globalRecent.length > RECENT_CAP) globalRecent = globalRecent.slice(-RECENT_CAP);
    if (added > 0) { emit(lastProject); scheduleForward(); }
    return added;
  }

  function ingestMetrics(json) {
    const snap = tel.extractMetricSnapshot(json);
    let changed = false;
    for (const k of Object.keys(snap.cost)) { metricSnapshot.cost[k] = snap.cost[k]; changed = true; }
    for (const k of Object.keys(snap.tokens)) { metricSnapshot.tokens[k] = snap.tokens[k]; changed = true; }
    if (changed) emit(activeProject);
    return changed;
  }

  function handleRequest(req, res) {
    // Loopback-only sink: only POST is meaningful; everything else is a benign 200
    // so a stray probe never errors, but non-POST carries no body to ingest.
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    const pathname = (() => { try { return new URL(req.url, endpoint || 'http://127.0.0.1').pathname; } catch (_) { return req.url || ''; } })();
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c) => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) { aborted = true; res.writeHead(413); res.end(); try { req.destroy(); } catch (_) {} return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      let json = null;
      try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { json = null; }
      if (json) {
        try {
          if (pathname.endsWith('/v1/logs')) ingestLogs(json);
          else if (pathname.endsWith('/v1/metrics')) ingestMetrics(json);
        } catch (e) { log('telemetry ingest error', e); }
      }
      // Always 200 so the CLI exporter does not retry-storm on our parse choices.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    req.on('error', () => { try { res.writeHead(400); res.end(); } catch (_) {} });
  }

  // Start the loopback server. Resolves with the base endpoint URL. Idempotent:
  // if already running, resolves the current endpoint.
  function start() {
    if (running && server) return Promise.resolve(endpoint);
    return new Promise((resolve, reject) => {
      const srv = http.createServer(handleRequest);
      srv.on('error', (e) => { log('telemetry server error', e); reject(e); });
      srv.listen(config.port || 0, LOOPBACK, () => {
        server = srv;
        const addr = srv.address();
        const port = addr && typeof addr === 'object' ? addr.port : config.port;
        endpoint = `http://${LOOPBACK}:${port}`;
        running = true;
        resolve(endpoint);
      });
    });
  }

  function stop() {
    if (forwardTimer) { clearTimeout(forwardTimer); forwardTimer = null; }
    running = false;
    endpoint = '';
    return new Promise((resolve) => {
      if (!server) return resolve();
      const srv = server;
      server = null;
      try { srv.close(() => resolve()); } catch (_) { resolve(); }
    });
  }

  // The OTEL_* env vars a spawned `claude` needs to export to this receiver.
  // {} when disabled or not yet started (no endpoint).
  function otelEnv() { return tel.buildOtelEnv(config, endpoint); }

  function getState() {
    return {
      enabled: config.enabled,
      running,
      endpoint,
      port: server && server.address() ? server.address().port : config.port,
      forwardUrl: config.forwardUrl,
      forwardEnabled: config.forwardEnabled,
      hasToken: config.forwardToken !== '',
      sessionId,
      username: usernameFn(),
      project: activeProject,
      warnings: config.warnings,
    };
  }

  // Record the folder the user is currently focused on. TASK-154: this no
  // longer drives ATTRIBUTION (each row is now bucketed by its own `project`
  // field) — it is retained solely as the "default bucket" the receiver reads
  // from when a caller doesn't name a project (legacy no-arg getUsage(), and
  // the forward payload's default `project` label). Coerces junk to '' and
  // never throws.
  function setActiveProject(name) {
    activeProject = typeof name === 'string' ? name.trim() : '';
    return activeProject;
  }

  // Legacy/no-arg-friendly usage read. With an explicit non-empty `project` it
  // returns that project's bucket; otherwise it defaults to the `activeProject`
  // bucket, falling back to the app-wide roll-up when activeProject is itself
  // empty (e.g. before any tab reports itself). `recent` is capped like before.
  function getUsage(project) {
    const proj = (typeof project === 'string' && project !== '') ? project : activeProject;
    if (proj === '') {
      return { usage: usage(), metricTotals: metricTotals(), running, recent: globalRecent.slice(-100) };
    }
    const bucket = getBucket(proj);
    return {
      usage: usageForProject(proj),
      metricTotals: metricTotals(),
      running,
      recent: (bucket ? bucket.recent : []).slice(-100),
    };
  }

  // One project's { usage, recent } read — the per-project counterpart to
  // getUsage(). `recent` capped the same way (last 100).
  function getUsageForProject(project) {
    const bucket = getBucket(project);
    return { usage: usageForProject(project), recent: (bucket ? bucket.recent : []).slice(-100) };
  }

  // Per-ticket cost correlation (TASK-142): sum EVERY bucket's FULL de-duplicated
  // store (not the capped `recent` feed, so an older activity is still
  // correlated) against one activity's { startedAt, finishedAt, model } window.
  // Request ids are globally unique, so a time-window match is unaffected by
  // per-project bucketing (TASK-154) — this intentionally still scans ALL
  // projects' rows. Pure delegation to tel.usageForWindow — never throws,
  // returns emptyTotals() when nothing matches.
  function usageForWindow(window) {
    return tel.usageForWindow(allRows(), window);
  }

  function clear() {
    buckets.clear();
    seenKeys.clear();
    globalRecent = [];
    metricSnapshot = { cost: {}, tokens: {} };
    emit(activeProject);
  }

  // Apply a NEW (raw) config. Restarts the server when `enabled` toggles or the
  // requested port changes; otherwise updates in place (forward settings take
  // effect immediately). Resolves with the new state.
  async function setConfig(rawConfig) {
    const next = tel.normalizeTelemetryConfig(rawConfig);
    const wasEnabled = config.enabled;
    const portChanged = next.port !== config.port;
    config = next;
    if (config.enabled && (!running || portChanged)) {
      if (running) await stop();
      try { await start(); } catch (e) { log('telemetry start failed', e); }
    } else if (!config.enabled && running) {
      await stop();
    } else if (config.enabled && wasEnabled && !portChanged) {
      // config-only change (forward url/token/intervals) — nothing to restart.
    }
    return getState();
  }

  return {
    start, stop, setConfig, getState, getUsage, usageForProject, getUsageForProject,
    usageForWindow, clear, otelEnv,
    setActiveProject, setProjectForwarding,
    // exposed for tests:
    ingestLogs, ingestMetrics, handleRequest, snapshotState,
    get config() { return config; },
    get sessionId() { return sessionId; },
  };
}

module.exports = { createTelemetryReceiver, defaultForwardRequest, MAX_BODY_BYTES, MAX_PROJECT_BUCKETS, MAX_PROJECT_FORWARDING };
