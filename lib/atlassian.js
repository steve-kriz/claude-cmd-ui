'use strict';

// Thin client for the two Atlassian identity endpoints the "Sign in with
// Atlassian" flow needs. This is deliberately narrow — it does NOT call the
// Jira REST API itself; the jira-ba subagent does that at dispatch time using
// the token this module helps obtain (ATLASSIAN_ACCESS_TOKEN / ATLASSIAN_CLOUD_ID
// in .env). Modeled on lib/slack.js's exchangeOAuthCode: injectable-free, plain
// https, never throws — every branch resolves a structured { ok, ... } object.

const https = require('https');

const AUTH_HOST = 'auth.atlassian.com';
const API_HOST = 'api.atlassian.com';

function postJson(host, path, payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload || {});
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Content-Length': Buffer.byteLength(body)
    };
    const req = https.request({ hostname: host, path, method: 'POST', headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(data); }
        catch (_) { return resolve({ ok: false, error: 'invalid JSON from Atlassian: ' + data.slice(0, 200) }); }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return resolve({ ok: false, error: (json && (json.error_description || json.error || json.message)) || ('request failed: ' + res.statusCode) });
        }
        resolve(Object.assign({ ok: true }, json));
      });
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.write(body);
    req.end();
  });
}

function getJson(host, path, token) {
  return new Promise((resolve) => {
    const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json' };
    const req = https.request({ hostname: host, path, method: 'GET', headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(data); }
        catch (_) { return resolve({ ok: false, error: 'invalid JSON from Atlassian: ' + data.slice(0, 200) }); }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return resolve({ ok: false, error: (json && (json.error_description || json.error || json.message)) || ('request failed: ' + res.statusCode) });
        }
        resolve({ ok: true, data: json });
      });
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.end();
  });
}

// Exchange an authorization code for an access/refresh token via Atlassian's
// OAuth 2.0 (3LO) token endpoint. Unlike Slack this is a JSON POST, not
// form-encoded. Returns { ok:true, access_token, refresh_token, expires_in, ... }
// or { ok:false, error }.
function exchangeOAuthCode({ clientId, clientSecret, code, redirectUri } = {}) {
  if (!clientId || !clientSecret) {
    return Promise.resolve({ ok: false, error: 'ATLASSIAN_CLIENT_ID and ATLASSIAN_CLIENT_SECRET are required.' });
  }
  if (!code) return Promise.resolve({ ok: false, error: 'Missing authorization code.' });
  return postJson(AUTH_HOST, '/oauth/token', {
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri || ''
  });
}

// List the Jira/Confluence sites (cloud resources) this token can reach.
// Returns { ok:true, resources: [{ id, url, name, scopes }, ...] } or
// { ok:false, error }. Filters to Jira sites (scopes include a jira scope OR
// the caller doesn't care — Jira REST calls use whichever `id` you pick).
function fetchAccessibleResources(accessToken) {
  if (!accessToken) return Promise.resolve({ ok: false, error: 'Missing access token.' });
  return getJson(API_HOST, '/oauth/token/accessible-resources', accessToken).then((res) => {
    if (!res.ok) return res;
    const resources = Array.isArray(res.data) ? res.data : [];
    return { ok: true, resources };
  });
}

module.exports = { exchangeOAuthCode, fetchAccessibleResources };
