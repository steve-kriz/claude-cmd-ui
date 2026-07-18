'use strict';

// Unit tests for lib/slack.js exchangeOAuthCode — the ONE piece of the Slack
// OAuth flow that lives in an Electron-free, exported module and can be exercised
// directly. ALL network is stubbed via a fake https.request (see
// helpers/fake-https): no real Slack, no real outbound HTTP.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const { mock } = require('node:test');
const { makeFakeHttps } = require('./helpers/fake-https');

const slack = require('../lib/slack');

// Install a fake https.request that replies with `responder`, returning the
// `calls` log. Auto-restored by node:test after each test via mock.restoreAll,
// but we also restore explicitly in a finally for safety.
function stubHttps(responder) {
  const fake = makeFakeHttps(responder);
  mock.method(https, 'request', fake.request);
  return fake;
}

test('success: returns parsed JSON including authed_user.access_token', async () => {
  const okBody = JSON.stringify({
    ok: true,
    app_id: 'A123',
    authed_user: { id: 'U1', access_token: 'xoxp-user-token-123', scope: 'channels:history' },
    team: { id: 'T1', name: 'Acme' }
  });
  const fake = stubHttps(() => ({ statusCode: 200, body: okBody }));
  try {
    const res = await slack.exchangeOAuthCode({
      clientId: 'cid', clientSecret: 'secret', code: 'the-code', redirectUri: 'http://localhost:53701/slack/oauth/callback'
    });
    assert.equal(res.ok, true);
    assert.equal(res.authed_user.access_token, 'xoxp-user-token-123');
    assert.equal(res.team.name, 'Acme');
    assert.equal(fake.calls.length, 1, 'exactly one HTTP call made');
  } finally {
    mock.restoreAll();
  }
});

test('POSTs form-encoded to oauth.v2.access with the right params', async () => {
  const fake = stubHttps(() => ({ statusCode: 200, body: JSON.stringify({ ok: true, authed_user: { access_token: 't' } }) }));
  try {
    await slack.exchangeOAuthCode({
      clientId: 'my-client', clientSecret: 'my-secret', code: 'abc123', redirectUri: 'http://localhost:53701/slack/oauth/callback'
    });
    assert.equal(fake.calls.length, 1);
    const { options, body } = fake.calls[0];

    // Endpoint + method
    assert.equal(options.hostname, 'slack.com');
    assert.equal(options.path, '/api/oauth.v2.access');
    assert.equal(options.method, 'POST');

    // Form-encoded content type (NOT JSON, NOT a Bearer header)
    assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.ok(!('Authorization' in options.headers), 'oauth.v2.access must be unauthenticated (no Bearer)');
    assert.equal(options.headers['Content-Length'], Buffer.byteLength(body));

    // Body carries client id/secret/code/redirect_uri, form-encoded
    const form = new URLSearchParams(body);
    assert.equal(form.get('client_id'), 'my-client');
    assert.equal(form.get('client_secret'), 'my-secret');
    assert.equal(form.get('code'), 'abc123');
    assert.equal(form.get('redirect_uri'), 'http://localhost:53701/slack/oauth/callback');
  } finally {
    mock.restoreAll();
  }
});

test('Slack ok:false is surfaced with a human-readable error and no throw', async () => {
  const fake = stubHttps(() => ({ statusCode: 200, body: JSON.stringify({ ok: false, error: 'invalid_code' }) }));
  try {
    const res = await slack.exchangeOAuthCode({ clientId: 'cid', clientSecret: 'secret', code: 'bad' });
    assert.equal(res.ok, false);
    // describeError passes the raw code through for non-scope errors.
    assert.equal(res.error, 'invalid_code');
    assert.equal(fake.calls.length, 1, 'an ok:false response still means the exchange was attempted once');
  } finally {
    mock.restoreAll();
  }
});

test('missing clientId is guarded BEFORE any network call', async () => {
  const fake = stubHttps(() => ({ statusCode: 200, body: '{"ok":true}' }));
  try {
    const res = await slack.exchangeOAuthCode({ clientSecret: 'secret', code: 'c' });
    assert.equal(res.ok, false);
    assert.match(res.error, /SLACK_CLIENT_ID and SLACK_CLIENT_SECRET are required/);
    assert.equal(fake.calls.length, 0, 'no HTTP request when client id is missing');
  } finally {
    mock.restoreAll();
  }
});

test('missing clientSecret is guarded BEFORE any network call', async () => {
  const fake = stubHttps(() => ({ statusCode: 200, body: '{"ok":true}' }));
  try {
    const res = await slack.exchangeOAuthCode({ clientId: 'cid', code: 'c' });
    assert.equal(res.ok, false);
    assert.match(res.error, /SLACK_CLIENT_ID and SLACK_CLIENT_SECRET are required/);
    assert.equal(fake.calls.length, 0, 'no HTTP request when client secret is missing');
  } finally {
    mock.restoreAll();
  }
});

test('missing code is guarded BEFORE any network call', async () => {
  const fake = stubHttps(() => ({ statusCode: 200, body: '{"ok":true}' }));
  try {
    const res = await slack.exchangeOAuthCode({ clientId: 'cid', clientSecret: 'secret' });
    assert.equal(res.ok, false);
    assert.match(res.error, /Missing authorization code/);
    assert.equal(fake.calls.length, 0, 'no HTTP request when code is missing');
  } finally {
    mock.restoreAll();
  }
});

test('called with no arguments does not throw and returns a guard error', async () => {
  const res = await slack.exchangeOAuthCode();
  assert.equal(res.ok, false);
  assert.match(res.error, /required/);
});

test('a transport/connection error is caught and returned as ok:false', async () => {
  const fake = stubHttps(() => ({ error: new Error('ECONNREFUSED') }));
  try {
    const res = await slack.exchangeOAuthCode({ clientId: 'cid', clientSecret: 'secret', code: 'c' });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'ECONNREFUSED');
    assert.equal(fake.calls.length, 1);
  } finally {
    mock.restoreAll();
  }
});

test('non-JSON body from Slack is reported, not thrown', async () => {
  const fake = stubHttps(() => ({ statusCode: 502, body: '<html>gateway timeout</html>' }));
  try {
    const res = await slack.exchangeOAuthCode({ clientId: 'cid', clientSecret: 'secret', code: 'c' });
    assert.equal(res.ok, false);
    assert.match(res.error, /invalid JSON from Slack/);
    assert.equal(fake.calls.length, 1);
  } finally {
    mock.restoreAll();
  }
});
