'use strict';

// Thin HTTP client for the prompt-logs Lambda. Configuration is read fresh on
// each call so the user can flip env vars without restarting Electron.
//
//   CLOUD_LOG_ENDPOINT   Full Lambda URL (Function URL or API Gateway invoke URL)
//   CLOUD_LOG_API_KEY    Optional shared secret, sent as X-Api-Key
//   CLOUD_LOG_USERNAME   Username tag for log events; defaults to the OS user

const os = require('os');
const path = require('path');

function readConfig() {
  return {
    endpoint: (process.env.CLOUD_LOG_ENDPOINT || '').trim(),
    apiKey: (process.env.CLOUD_LOG_API_KEY || '').trim(),
    username: (process.env.CLOUD_LOG_USERNAME || (os.userInfo().username || 'unknown')).trim()
  };
}

function projectFromCwd(cwd) {
  return path.basename(path.resolve(cwd || '.'));
}

function isEnabled() {
  return readConfig().endpoint.length > 0;
}

function buildHeaders(cfg) {
  const h = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) h['X-Api-Key'] = cfg.apiKey;
  return h;
}

async function postLog(cwd, entry) {
  const cfg = readConfig();
  if (!cfg.endpoint) return { ok: false, error: 'cloud logs disabled' };
  const project = projectFromCwd(cwd);
  const res = await fetch(cfg.endpoint, {
    method: 'POST',
    headers: buildHeaders(cfg),
    body: JSON.stringify({ username: cfg.username, project, entry })
  });
  if (!res.ok) throw new Error(`cloud POST failed: HTTP ${res.status}`);
  return res.json().catch(() => ({ ok: true }));
}

async function fetchLogs(cwd) {
  const cfg = readConfig();
  if (!cfg.endpoint) return { ok: false, error: 'cloud logs disabled' };
  const project = projectFromCwd(cwd);
  const url = new URL(cfg.endpoint);
  url.searchParams.set('username', cfg.username);
  url.searchParams.set('project', project);
  const res = await fetch(url.toString(), { method: 'GET', headers: buildHeaders(cfg) });
  if (!res.ok) throw new Error(`cloud GET failed: HTTP ${res.status}`);
  const data = await res.json();
  return { ok: true, entries: Array.isArray(data && data.entries) ? data.entries : [] };
}

module.exports = { isEnabled, postLog, fetchLogs, readConfig, projectFromCwd };
