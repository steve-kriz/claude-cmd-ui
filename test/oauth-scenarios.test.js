'use strict';

// Executable mapping of the ticket's Gherkin scenarios
// (tasks/TASK-001-slack-intergation.md → "## Cucumber Tests").
//
// The OAuth orchestration was extracted into an Electron-free module
// (lib/slack-oauth.js), so EVERY scenario is now runnable outside Electron with:
//   - ALL network mocked (an injected `exchange` fake — never hits Slack), and
//   - a REAL 127.0.0.1 loopback server bound to an OS-assigned port and driven
//     with Node's http client, to prove the redirect / state / deny handling.
// The token-exchange unit coverage of lib/slack.js exchangeOAuthCode lives in
// test/slack-exchange.test.js; the .env persistence round-trip lives in
// test/env-store.test.js. This file folds the flow-level scenarios together.

const { test, describe, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const oauth = require('../lib/slack-oauth');
const slack = require('../lib/slack');
const envStore = require('../lib/env-store');

let tmpDir;
let tmpEnv;
const savedEnv = {};
const TRACKED = ['SLACK_TOKEN', 'SLACK_CLIENT_ID', 'SLACK_CLIENT_SECRET'];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-scn-'));
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

// --- helpers ---------------------------------------------------------------

const OK_TOKEN_RESULT = {
  ok: true,
  authed_user: { id: 'U9', access_token: 'xoxp-fresh-token' },
  team: { id: 'T9', name: 'Widgets Inc' }
};

// An OS-assigned free loopback port so tests never collide with the app's fixed
// 53701-53705 range (or with each other when run in parallel).
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

// A fake token exchange that records calls and returns a canned result — this is
// the network boundary; the real Slack HTTP call (lib/slack.exchangeOAuthCode)
// is unit-tested separately and never invoked here.
function fakeExchange(result) {
  const calls = [];
  const fn = async (args) => { calls.push(args); return result; };
  fn.calls = calls;
  return fn;
}

// Hit the loopback callback URI Slack would redirect the user's browser to.
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

// Start runOAuth on a free port, capturing the generated state (from the URL the
// browser would open) and the redirectUri. Returns the promise + a ready() that
// resolves once both are known, so the caller can drive the callback with the
// MATCHING state.
async function startFlow({ exchange, envSet } = {}) {
  const port = await freePort();
  const ex = exchange || fakeExchange(OK_TOKEN_RESULT);
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
    envSet: envSet || envStore.set
  });
  await waitFor(() => capturedState && redirectUri);
  return {
    port, resultP, exchange: ex,
    state: () => capturedState,
    redirectUri: () => redirectUri,
    openedUrl: () => openedUrl
  };
}

// ---------------------------------------------------------------------------
// Scenario 1: Starting sign-in opens the Slack authorize page
// ---------------------------------------------------------------------------
describe('Scenario: Starting sign-in opens the Slack authorize page', () => {
  test('buildAuthorizeUrl contains client_id, user scopes, redirect_uri, and state', () => {
    const url = oauth.buildAuthorizeUrl({
      clientId: 'CID-123',
      scopes: oauth.DEFAULT_USER_SCOPES,
      redirectUri: 'http://localhost:53701/slack/oauth/callback',
      state: 'st-abc'
    });
    assert.ok(url.startsWith('https://slack.com/oauth/v2/authorize?'));
    const q = new URL(url).searchParams;
    assert.equal(q.get('client_id'), 'CID-123');
    assert.equal(q.get('user_scope'), oauth.DEFAULT_USER_SCOPES);
    assert.equal(q.get('scope'), ''); // bot scope intentionally empty (user token)
    assert.equal(q.get('redirect_uri'), 'http://localhost:53701/slack/oauth/callback');
    assert.equal(q.get('state'), 'st-abc');
  });

  test('runOAuth opens the browser to that URL with a random state + loopback redirect_uri', async () => {
    const flow = await startFlow();
    // The browser was opened with the authorize URL before any callback arrived.
    const q = new URL(flow.openedUrl()).searchParams;
    assert.equal(q.get('client_id'), 'my-client');
    assert.equal(q.get('user_scope'), oauth.DEFAULT_USER_SCOPES);
    assert.match(q.get('redirect_uri'), new RegExp(`^http://localhost:${flow.port}/slack/oauth/callback$`));
    assert.match(q.get('state'), /^[0-9a-f]{32}$/, 'state is 16 random bytes of hex');
    // Let the flow settle (drive a success) so the server closes cleanly.
    await hitCallback(flow.redirectUri(), { code: 'ok', state: flow.state() });
    await flow.resultP;
  });

  test('generateState produces distinct 32-hex-char tokens', () => {
    const a = oauth.generateState();
    const b = oauth.generateState();
    assert.match(a, /^[0-9a-f]{32}$/);
    assert.notEqual(a, b);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Successful sign-in stores and uses the generated token
// ---------------------------------------------------------------------------
describe('Scenario: Successful sign-in stores and uses the generated token', () => {
  test('valid code+state → exchange → SLACK_TOKEN saved to .env → server closed → token reused', async () => {
    const flow = await startFlow({ exchange: fakeExchange(OK_TOKEN_RESULT) });
    const cb = await hitCallback(flow.redirectUri(), { code: 'valid-code', state: flow.state() });
    const result = await flow.resultP;

    // Exchange invoked once with the right code + redirect.
    assert.equal(flow.exchange.calls.length, 1);
    assert.equal(flow.exchange.calls[0].code, 'valid-code');
    assert.equal(flow.exchange.calls[0].redirectUri, flow.redirectUri());

    // Token persisted to SLACK_TOKEN in the .env file.
    assert.equal(result.ok, true);
    assert.equal(result.token, 'xoxp-fresh-token');
    assert.match(fs.readFileSync(tmpEnv, 'utf8'), /^SLACK_TOKEN=xoxp-fresh-token$/m);
    // Subsequent connect/fetch/post read the token from here.
    assert.equal(envStore.get('SLACK_TOKEN'), 'xoxp-fresh-token');

    // Success page rendered; loopback server released the port.
    assert.equal(cb.status, 200);
    assert.match(cb.body, /Signed in to Slack/);
    await assertPortFree(flow.port);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: Missing client credentials block the flow with guidance
// ---------------------------------------------------------------------------
describe('Scenario: Missing client credentials block the flow with guidance', () => {
  // Lib-level guard: exchangeOAuthCode refuses without creds and makes no HTTP
  // (mocked-network coverage in test/slack-exchange.test.js). The browser-gate
  // (ipcMain slack:startOAuth needsCredentials — "OAuth does not start until both
  // are set") is a thin main.js IPC check that reads envStore.get; the substance
  // it guards (no exchange without creds) is proven here.
  test('exchange refuses without client id/secret (no token produced)', async () => {
    const res = await slack.exchangeOAuthCode({ code: 'c' });
    assert.equal(res.ok, false);
    assert.match(res.error, /SLACK_CLIENT_ID and SLACK_CLIENT_SECRET are required/);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: State mismatch is rejected (CSRF protection)
// ---------------------------------------------------------------------------
describe('Scenario: State mismatch is rejected (CSRF protection)', () => {
  test('parseCallback with a wrong state → { stateMismatch:true }', () => {
    assert.deepEqual(oauth.parseCallback('/slack/oauth/callback?state=wrong&code=x', 'abc123'), { stateMismatch: true });
  });

  test('runOAuth: wrong state → exchange NEVER called, no SLACK_TOKEN written, server closed', async () => {
    const flow = await startFlow({ exchange: fakeExchange(OK_TOKEN_RESULT) });
    const cb = await hitCallback(flow.redirectUri(), { code: 'x', state: 'definitely-wrong' });
    const result = await flow.resultP;

    assert.equal(flow.exchange.calls.length, 0, 'exchange must NOT run on state mismatch');
    assert.equal(result.ok, false);
    assert.match(result.error, /State mismatch/);
    assert.equal(fs.existsSync(tmpEnv), false, 'no .env written on CSRF failure');
    assert.equal(cb.status, 400);
    await assertPortFree(flow.port);
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: User denies access
// ---------------------------------------------------------------------------
describe('Scenario: User denies access', () => {
  test('parseCallback with error=access_denied → { error, denied:true }', () => {
    const d = oauth.parseCallback('/slack/oauth/callback?error=access_denied&state=s', 's');
    assert.equal(d.denied, true);
    assert.match(d.error, /denied the Slack authorization/i);
  });

  test('runOAuth: access_denied → no token saved, actionable error, server closed', async () => {
    const flow = await startFlow({ exchange: fakeExchange(OK_TOKEN_RESULT) });
    const cb = await hitCallback(flow.redirectUri(), { error: 'access_denied', state: flow.state() });
    const result = await flow.resultP;

    assert.equal(flow.exchange.calls.length, 0, 'no exchange on deny');
    assert.equal(result.ok, false);
    assert.match(result.error, /denied the Slack authorization/i);
    assert.equal(fs.existsSync(tmpEnv), false, 'no token saved on deny');
    assert.equal(cb.status, 200); // cancellation page
    await assertPortFree(flow.port);
  });
});

// ---------------------------------------------------------------------------
// Scenario 6: Token exchange failure is surfaced
// ---------------------------------------------------------------------------
describe('Scenario: Token exchange failure is surfaced', () => {
  test('runOAuth: exchange ok:false → error surfaced, no token saved, server closed', async () => {
    const flow = await startFlow({ exchange: fakeExchange({ ok: false, error: 'invalid_grant_type' }) });
    const cb = await hitCallback(flow.redirectUri(), { code: 'rejected', state: flow.state() });
    const result = await flow.resultP;

    assert.equal(flow.exchange.calls.length, 1, 'exchange was attempted');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'invalid_grant_type');
    assert.equal(fs.existsSync(tmpEnv), false, 'no token saved on exchange failure');
    assert.equal(cb.status, 200);
    assert.match(cb.body, /Could not exchange the code/);
    await assertPortFree(flow.port);
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting AC: the loopback server is ALWAYS closed
// ---------------------------------------------------------------------------
describe('AC: loopback server is always closed after the flow', () => {
  async function driveAndAssertClosed(makeQuery, exchange) {
    const flow = await startFlow({ exchange: exchange || fakeExchange(OK_TOKEN_RESULT) });
    await hitCallback(flow.redirectUri(), makeQuery(flow.state()));
    await flow.resultP;
    await assertPortFree(flow.port);
  }

  test('closed on success', () => driveAndAssertClosed((s) => ({ code: 'ok', state: s }), fakeExchange(OK_TOKEN_RESULT)));
  test('closed on state mismatch', () => driveAndAssertClosed(() => ({ code: 'x', state: 'wrong' })));
  test('closed on deny', () => driveAndAssertClosed((s) => ({ error: 'access_denied', state: s })));
  test('closed on exchange failure', () => driveAndAssertClosed((s) => ({ code: 'x', state: s }), fakeExchange({ ok: false, error: 'boom' })));

  test('closed on timeout (no callback ever arrives)', async () => {
    const port = await freePort();
    const result = await oauth.runOAuth({
      clientId: 'my-client', clientSecret: 'my-secret',
      ports: [port], timeoutMs: 60, // fire quickly
      openBrowser: async () => {},
      onStarted: () => {},
      exchange: fakeExchange(OK_TOKEN_RESULT),
      envSet: envStore.set
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /timed out/);
    await assertPortFree(port);
  });
});

// ---------------------------------------------------------------------------
// parseCallback routing table (pure, no I/O)
// ---------------------------------------------------------------------------
describe('parseCallback routing (pure)', () => {
  test('non-callback path is ignored', () => {
    assert.deepEqual(oauth.parseCallback('/favicon.ico', 's'), { ignore: true });
  });
  test('matching state + code yields the code', () => {
    assert.deepEqual(oauth.parseCallback('/slack/oauth/callback?code=abc&state=s', 's'), { code: 'abc' });
  });
  test('missing code (but valid state) is flagged', () => {
    const d = oauth.parseCallback('/slack/oauth/callback?state=s', 's');
    assert.equal(d.missingCode, true);
  });
  test('a non-deny Slack error is surfaced', () => {
    const d = oauth.parseCallback('/slack/oauth/callback?error=invalid_scope&state=s', 's');
    assert.match(d.error, /Slack returned an error: invalid_scope/);
    assert.notEqual(d.denied, true);
  });
});

// --- small async utilities -------------------------------------------------

// Poll until `cond()` is truthy or we hit a timeout (deterministic, no sleeps).
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

// Assert a port is free again (the loopback server released it): binding
// succeeds only if nothing is still listening.
function assertPortFree(port) {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.once('error', (e) => reject(new Error(`port ${port} still in use after flow: ${e.code}`)));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve()));
  });
}
