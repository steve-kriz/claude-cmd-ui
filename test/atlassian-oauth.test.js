'use strict';

// Scenario tests for the "Sign in with Atlassian" loopback OAuth flow
// (lib/atlassian-oauth.js). Mirrors test/oauth-scenarios.test.js: ALL network
// (token exchange + accessible-resources) is mocked, and a REAL 127.0.0.1
// loopback server is driven with Node's http client to prove the redirect /
// state / deny / site-resolution handling.

const { test, describe, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const oauth = require('../lib/atlassian-oauth');
const envStore = require('../lib/env-store');

let tmpDir;
let tmpEnv;
const savedEnv = {};
const TRACKED = [
  'ATLASSIAN_ACCESS_TOKEN', 'ATLASSIAN_REFRESH_TOKEN',
  'ATLASSIAN_CLOUD_ID', 'ATLASSIAN_SITE_URL', 'ATLASSIAN_SITE_NAME'
];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlassian-scn-'));
  tmpEnv = path.join(tmpDir, '.env');
  envStore.setEnvPath(tmpEnv);
  for (const k of TRACKED) { savedEnv[k] = process.env[k]; delete process.env[k]; }
});

afterEach(() => {
  mock.restoreAll();
  for (const k of TRACKED) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
});

const OK_TOKEN_RESULT = { ok: true, access_token: 'at-fresh', refresh_token: 'rt-fresh', expires_in: 3600 };
const OK_RESOURCES_RESULT = {
  ok: true,
  resources: [{ id: 'cloud-1', url: 'https://acme.atlassian.net', name: 'Acme', scopes: ['read:jira-work'] }]
};

function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

function fakeAsync(result) {
  const calls = [];
  const fn = async (...args) => { calls.push(args); return result; };
  fn.calls = calls;
  return fn;
}

function hitCallback(redirectUri, query) {
  const u = new URL(redirectUri);
  const qs = new URLSearchParams(query).toString();
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: u.hostname, port: u.port, path: u.pathname + (qs ? '?' + qs : '') },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('error', reject);
  });
}

async function startFlow({ exchange, fetchResources, envSet } = {}) {
  const port = await freePort();
  const ex = exchange || fakeAsync(OK_TOKEN_RESULT);
  const fr = fetchResources || fakeAsync(OK_RESOURCES_RESULT);
  let capturedState = null;
  let redirectUri = null;
  let openedUrl = null;
  const resultP = oauth.runOAuth({
    clientId: 'my-client',
    clientSecret: 'my-secret',
    ports: [port],
    timeoutMs: 4000,
    openBrowser: async (u) => { openedUrl = u; capturedState = new URL(u).searchParams.get('state'); },
    onStarted: (info) => { redirectUri = info.redirectUri; },
    exchange: ex,
    fetchResources: fr,
    envSet: envSet || envStore.set
  });
  await waitFor(() => capturedState && redirectUri);
  return {
    port, resultP, exchange: ex, fetchResources: fr,
    state: () => capturedState,
    redirectUri: () => redirectUri,
    openedUrl: () => openedUrl
  };
}

describe('Scenario: Starting sign-in opens the Atlassian authorize page', () => {
  test('buildAuthorizeUrl contains client_id, scope, redirect_uri, state, audience', () => {
    const url = oauth.buildAuthorizeUrl({
      clientId: 'CID-123',
      scopes: oauth.DEFAULT_SCOPES,
      redirectUri: 'http://localhost:53801/atlassian/oauth/callback',
      state: 'st-abc'
    });
    assert.ok(url.startsWith('https://auth.atlassian.com/authorize?'));
    const q = new URL(url).searchParams;
    assert.equal(q.get('client_id'), 'CID-123');
    assert.equal(q.get('scope'), oauth.DEFAULT_SCOPES);
    assert.equal(q.get('audience'), 'api.atlassian.com');
    assert.equal(q.get('redirect_uri'), 'http://localhost:53801/atlassian/oauth/callback');
    assert.equal(q.get('state'), 'st-abc');
    assert.equal(q.get('response_type'), 'code');
  });

  test('runOAuth opens the browser with a random state + loopback redirect_uri', async () => {
    const flow = await startFlow();
    const q = new URL(flow.openedUrl()).searchParams;
    assert.equal(q.get('client_id'), 'my-client');
    assert.match(q.get('redirect_uri'), new RegExp(`^http://localhost:${flow.port}/atlassian/oauth/callback$`));
    assert.match(q.get('state'), /^[0-9a-f]{32}$/);
    await hitCallback(flow.redirectUri(), { code: 'ok', state: flow.state() });
    await flow.resultP;
  });
});

describe('Scenario: Successful sign-in stores tokens + resolved Jira site', () => {
  test('valid code+state -> exchange -> accessible-resources -> .env saved -> server closed', async () => {
    const flow = await startFlow();
    const cb = await hitCallback(flow.redirectUri(), { code: 'valid-code', state: flow.state() });
    const result = await flow.resultP;

    assert.equal(flow.exchange.calls.length, 1);
    assert.equal(flow.exchange.calls[0][0].code, 'valid-code');
    assert.equal(flow.fetchResources.calls.length, 1);
    assert.equal(flow.fetchResources.calls[0][0], 'at-fresh');

    assert.equal(result.ok, true);
    assert.equal(result.token, 'at-fresh');
    assert.equal(result.cloudId, 'cloud-1');
    assert.equal(result.siteUrl, 'https://acme.atlassian.net');

    const written = fs.readFileSync(tmpEnv, 'utf8');
    assert.match(written, /^ATLASSIAN_ACCESS_TOKEN=at-fresh$/m);
    assert.match(written, /^ATLASSIAN_REFRESH_TOKEN=rt-fresh$/m);
    assert.match(written, /^ATLASSIAN_CLOUD_ID=cloud-1$/m);
    assert.match(written, /^ATLASSIAN_SITE_URL=https:\/\/acme\.atlassian\.net$/m);
    assert.equal(envStore.get('ATLASSIAN_ACCESS_TOKEN'), 'at-fresh');

    assert.equal(cb.status, 200);
    assert.match(cb.body, /Signed in to Atlassian/);
    await assertPortFree(flow.port);
  });
});

describe('Scenario: No accessible Jira site is found', () => {
  test('exchange succeeds but resources come back empty -> no tokens saved', async () => {
    const flow = await startFlow({ fetchResources: fakeAsync({ ok: true, resources: [] }) });
    const cb = await hitCallback(flow.redirectUri(), { code: 'valid-code', state: flow.state() });
    const result = await flow.resultP;

    assert.equal(result.ok, false);
    assert.match(result.error, /could not resolve a Jira site/);
    assert.equal(fs.existsSync(tmpEnv), false, 'no .env written when no site is resolvable');
    assert.equal(cb.status, 200);
    await assertPortFree(flow.port);
  });
});

describe('Scenario: State mismatch is rejected (CSRF protection)', () => {
  test('parseCallback with a wrong state -> { stateMismatch:true }', () => {
    assert.deepEqual(oauth.parseCallback('/atlassian/oauth/callback?state=wrong&code=x', 'abc123'), { stateMismatch: true });
  });

  test('runOAuth: wrong state -> exchange NEVER called, no tokens written, server closed', async () => {
    const flow = await startFlow();
    const cb = await hitCallback(flow.redirectUri(), { code: 'x', state: 'definitely-wrong' });
    const result = await flow.resultP;

    assert.equal(flow.exchange.calls.length, 0);
    assert.equal(result.ok, false);
    assert.match(result.error, /State mismatch/);
    assert.equal(fs.existsSync(tmpEnv), false);
    assert.equal(cb.status, 400);
    await assertPortFree(flow.port);
  });
});

describe('Scenario: User denies access', () => {
  test('parseCallback with error=access_denied -> { error, denied:true }', () => {
    const d = oauth.parseCallback('/atlassian/oauth/callback?error=access_denied&state=s', 's');
    assert.equal(d.denied, true);
    assert.match(d.error, /denied the Atlassian authorization/i);
  });

  test('runOAuth: access_denied -> no token saved, server closed', async () => {
    const flow = await startFlow();
    const cb = await hitCallback(flow.redirectUri(), { error: 'access_denied', state: flow.state() });
    const result = await flow.resultP;

    assert.equal(flow.exchange.calls.length, 0);
    assert.equal(result.ok, false);
    assert.match(result.error, /denied the Atlassian authorization/i);
    assert.equal(fs.existsSync(tmpEnv), false);
    assert.equal(cb.status, 200);
    await assertPortFree(flow.port);
  });
});

describe('Scenario: Token exchange failure is surfaced', () => {
  test('runOAuth: exchange ok:false -> error surfaced, no token saved, server closed', async () => {
    const flow = await startFlow({ exchange: fakeAsync({ ok: false, error: 'invalid_grant' }) });
    const cb = await hitCallback(flow.redirectUri(), { code: 'rejected', state: flow.state() });
    const result = await flow.resultP;

    assert.equal(flow.exchange.calls.length, 1);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'invalid_grant');
    assert.equal(fs.existsSync(tmpEnv), false);
    assert.equal(cb.status, 200);
    assert.match(cb.body, /Could not exchange the code/);
    await assertPortFree(flow.port);
  });
});

describe('AC: loopback server is always closed after the flow', () => {
  async function driveAndAssertClosed(makeQuery, exchange) {
    const flow = await startFlow({ exchange: exchange || fakeAsync(OK_TOKEN_RESULT) });
    await hitCallback(flow.redirectUri(), makeQuery(flow.state()));
    await flow.resultP;
    await assertPortFree(flow.port);
  }

  test('closed on success', () => driveAndAssertClosed((s) => ({ code: 'ok', state: s })));
  test('closed on state mismatch', () => driveAndAssertClosed(() => ({ code: 'x', state: 'wrong' })));
  test('closed on deny', () => driveAndAssertClosed((s) => ({ error: 'access_denied', state: s })));
  test('closed on exchange failure', () => driveAndAssertClosed((s) => ({ code: 'x', state: s }), fakeAsync({ ok: false, error: 'boom' })));

  test('closed on timeout (no callback ever arrives)', async () => {
    const port = await freePort();
    const result = await oauth.runOAuth({
      clientId: 'my-client', clientSecret: 'my-secret',
      ports: [port], timeoutMs: 60,
      openBrowser: async () => {},
      onStarted: () => {},
      exchange: fakeAsync(OK_TOKEN_RESULT),
      fetchResources: fakeAsync(OK_RESOURCES_RESULT),
      envSet: envStore.set
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /timed out/);
    await assertPortFree(port);
  });
});

describe('parseCallback routing (pure)', () => {
  test('non-callback path is ignored', () => {
    assert.deepEqual(oauth.parseCallback('/favicon.ico', 's'), { ignore: true });
  });
  test('matching state + code yields the code', () => {
    assert.deepEqual(oauth.parseCallback('/atlassian/oauth/callback?code=abc&state=s', 's'), { code: 'abc' });
  });
  test('missing code (but valid state) is flagged', () => {
    const d = oauth.parseCallback('/atlassian/oauth/callback?state=s', 's');
    assert.equal(d.missingCode, true);
  });
  test('a non-deny Atlassian error is surfaced', () => {
    const d = oauth.parseCallback('/atlassian/oauth/callback?error=invalid_scope&state=s', 's');
    assert.match(d.error, /Atlassian returned an error: invalid_scope/);
    assert.notEqual(d.denied, true);
  });
});

function waitFor(cond, timeoutMs = 2000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timed out'));
      setImmediate(tick);
    };
    tick();
  });
}

function assertPortFree(port) {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.once('error', (e) => reject(new Error(`port ${port} still in use after flow: ${e.code}`)));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve()));
  });
}
