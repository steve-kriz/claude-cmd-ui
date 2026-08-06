'use strict';

// Unit tests for lib/atlassian.js — exchangeOAuthCode and fetchAccessibleResources,
// the two Electron-free network calls behind "Sign in with Atlassian". ALL
// network is stubbed via a fake https.request (see helpers/fake-https): no real
// Atlassian traffic. Mirrors test/slack-exchange.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const { mock } = require('node:test');
const { makeFakeHttps } = require('./helpers/fake-https');

const atlassian = require('../lib/atlassian');

function stubHttps(responder) {
  const fake = makeFakeHttps(responder);
  mock.method(https, 'request', fake.request);
  return fake;
}

// ── exchangeOAuthCode ───────────────────────────────────────────────────────

test('exchangeOAuthCode: success returns access_token/refresh_token', async () => {
  const fake = stubHttps(() => ({
    statusCode: 200,
    body: JSON.stringify({ access_token: 'at-123', refresh_token: 'rt-456', expires_in: 3600 })
  }));
  try {
    const res = await atlassian.exchangeOAuthCode({
      clientId: 'cid', clientSecret: 'secret', code: 'the-code',
      redirectUri: 'http://localhost:53801/atlassian/oauth/callback'
    });
    assert.equal(res.ok, true);
    assert.equal(res.access_token, 'at-123');
    assert.equal(res.refresh_token, 'rt-456');
    assert.equal(fake.calls.length, 1);
  } finally {
    mock.restoreAll();
  }
});

test('exchangeOAuthCode: POSTs JSON to /oauth/token on auth.atlassian.com', async () => {
  const fake = stubHttps(() => ({ statusCode: 200, body: JSON.stringify({ access_token: 't' }) }));
  try {
    await atlassian.exchangeOAuthCode({
      clientId: 'my-client', clientSecret: 'my-secret', code: 'abc123',
      redirectUri: 'http://localhost:53801/atlassian/oauth/callback'
    });
    assert.equal(fake.calls.length, 1);
    const { options, body } = fake.calls[0];
    assert.equal(options.hostname, 'auth.atlassian.com');
    assert.equal(options.path, '/oauth/token');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['Content-Type'], 'application/json');

    const parsed = JSON.parse(body);
    assert.equal(parsed.grant_type, 'authorization_code');
    assert.equal(parsed.client_id, 'my-client');
    assert.equal(parsed.client_secret, 'my-secret');
    assert.equal(parsed.code, 'abc123');
    assert.equal(parsed.redirect_uri, 'http://localhost:53801/atlassian/oauth/callback');
  } finally {
    mock.restoreAll();
  }
});

test('exchangeOAuthCode: a non-2xx status is surfaced as ok:false, not thrown', async () => {
  const fake = stubHttps(() => ({ statusCode: 400, body: JSON.stringify({ error: 'invalid_grant', error_description: 'code expired' }) }));
  try {
    const res = await atlassian.exchangeOAuthCode({ clientId: 'cid', clientSecret: 'secret', code: 'bad' });
    assert.equal(res.ok, false);
    assert.match(res.error, /code expired/);
    assert.equal(fake.calls.length, 1);
  } finally {
    mock.restoreAll();
  }
});

test('exchangeOAuthCode: missing clientId is guarded before any network call', async () => {
  const fake = stubHttps(() => ({ statusCode: 200, body: '{}' }));
  try {
    const res = await atlassian.exchangeOAuthCode({ clientSecret: 'secret', code: 'c' });
    assert.equal(res.ok, false);
    assert.match(res.error, /ATLASSIAN_CLIENT_ID and ATLASSIAN_CLIENT_SECRET are required/);
    assert.equal(fake.calls.length, 0);
  } finally {
    mock.restoreAll();
  }
});

test('exchangeOAuthCode: missing code is guarded before any network call', async () => {
  const fake = stubHttps(() => ({ statusCode: 200, body: '{}' }));
  try {
    const res = await atlassian.exchangeOAuthCode({ clientId: 'cid', clientSecret: 'secret' });
    assert.equal(res.ok, false);
    assert.match(res.error, /Missing authorization code/);
    assert.equal(fake.calls.length, 0);
  } finally {
    mock.restoreAll();
  }
});

test('exchangeOAuthCode: a transport/connection error is caught, not thrown', async () => {
  const fake = stubHttps(() => ({ error: new Error('ECONNREFUSED') }));
  try {
    const res = await atlassian.exchangeOAuthCode({ clientId: 'cid', clientSecret: 'secret', code: 'c' });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'ECONNREFUSED');
    assert.equal(fake.calls.length, 1);
  } finally {
    mock.restoreAll();
  }
});

test('exchangeOAuthCode: non-JSON body is reported, not thrown', async () => {
  const fake = stubHttps(() => ({ statusCode: 502, body: '<html>gateway timeout</html>' }));
  try {
    const res = await atlassian.exchangeOAuthCode({ clientId: 'cid', clientSecret: 'secret', code: 'c' });
    assert.equal(res.ok, false);
    assert.match(res.error, /invalid JSON from Atlassian/);
  } finally {
    mock.restoreAll();
  }
});

// ── fetchAccessibleResources ────────────────────────────────────────────────

test('fetchAccessibleResources: success returns the resources array', async () => {
  const resources = [{ id: 'cloud-1', url: 'https://acme.atlassian.net', name: 'Acme', scopes: ['read:jira-work'] }];
  const fake = stubHttps(() => ({ statusCode: 200, body: JSON.stringify(resources) }));
  try {
    const res = await atlassian.fetchAccessibleResources('at-123');
    assert.equal(res.ok, true);
    assert.deepEqual(res.resources, resources);
    const { options } = fake.calls[0];
    assert.equal(options.hostname, 'api.atlassian.com');
    assert.equal(options.path, '/oauth/token/accessible-resources');
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.Authorization, 'Bearer at-123');
  } finally {
    mock.restoreAll();
  }
});

test('fetchAccessibleResources: missing token is guarded before any network call', async () => {
  const fake = stubHttps(() => ({ statusCode: 200, body: '[]' }));
  try {
    const res = await atlassian.fetchAccessibleResources();
    assert.equal(res.ok, false);
    assert.match(res.error, /Missing access token/);
    assert.equal(fake.calls.length, 0);
  } finally {
    mock.restoreAll();
  }
});

test('fetchAccessibleResources: a non-2xx status is surfaced as ok:false', async () => {
  const fake = stubHttps(() => ({ statusCode: 401, body: JSON.stringify({ message: 'Unauthorized' }) }));
  try {
    const res = await atlassian.fetchAccessibleResources('expired-token');
    assert.equal(res.ok, false);
    assert.match(res.error, /Unauthorized/);
    assert.equal(fake.calls.length, 1);
  } finally {
    mock.restoreAll();
  }
});
