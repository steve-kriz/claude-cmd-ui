'use strict';

// Electron-free orchestration for the "Sign in with Slack" OAuth v2 flow.
//
// This module was extracted out of main.js so the browser-facing logic — the
// authorize-URL builder, the `state` (CSRF) check, the access_denied / missing
// code routing, the loopback HTTP server, and the always-close-the-server
// guarantee — can be driven from tests with mocked network and a real
// 127.0.0.1 loopback. It deliberately does NOT `require('electron')`: `http`
// and `crypto` are Node built-ins, and the Electron-specific bits (opening the
// system browser, notifying the renderer) are injected by main.js as callbacks.
//
// main.js keeps only a thin IPC shell that wires shell.openExternal in as the
// `openBrowser` injection and the real exchange / env-set functions.

const http = require('http');
const crypto = require('crypto');
const slack = require('./slack');
const envStore = require('./env-store');

// User scopes the Slack tab needs (read history + resolve channels + post).
const DEFAULT_USER_SCOPES = 'channels:history,channels:read,groups:history,groups:read,chat:write';
// A tiny fixed port range so the redirect_uri is predictable enough for the user
// to register it on their Slack app (a random OS-assigned port would change the
// URL every run). We try each in turn until one binds.
const DEFAULT_PORTS = [53701, 53702, 53703, 53704, 53705];
// Abandoned flow (user never finishes in the browser) still tears down.
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

const CALLBACK_PATH = '/slack/oauth/callback';

// Random CSRF state token echoed back by Slack and verified on the callback.
function generateState() {
  return crypto.randomBytes(16).toString('hex');
}

// Build Slack's OAuth v2 authorize URL. We want a USER token ("sign in as
// yourself"), so the requested scopes go on user_scope; the bot `scope` stays
// empty. Returns the full URL string.
function buildAuthorizeUrl({ clientId, scopes, redirectUri, state } = {}) {
  return 'https://slack.com/oauth/v2/authorize?' + new URLSearchParams({
    client_id: clientId || '',
    user_scope: scopes || DEFAULT_USER_SCOPES,
    scope: '',
    redirect_uri: redirectUri || '',
    state: state || ''
  }).toString();
}

// Minimal readable page rendered back into the user's browser after the
// redirect. Accepts an optional title so the success / cancelled / failed
// variants read the same as before the extraction.
function renderOAuthPage({ ok, title, message } = {}) {
  const heading = title || (ok ? 'Signed in to Slack' : 'Sign-in failed');
  const color = ok ? '#2eb67d' : '#e01e5a';
  return '<!doctype html><html><head><meta charset="utf-8"><title>' + heading + '</title>'
    + '<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#1a1d21;color:#e8e8e8;'
    + 'display:flex;align-items:center;justify-content:center;height:100vh;margin:0}'
    + '.card{max-width:460px;padding:32px 36px;background:#222529;border-radius:12px;text-align:center;'
    + 'box-shadow:0 8px 40px rgba(0,0,0,.4)}h1{font-size:20px;margin:0 0 10px;color:' + color + '}'
    + 'p{font-size:14px;line-height:1.6;color:#c9c9c9;margin:0}</style></head>'
    + '<body><div class="card"><h1>' + heading + '</h1><p>' + (message || '') + '</p></div></body></html>';
}

// Route a raw callback request URL to a decision WITHOUT performing any
// exchange. `reqUrl` is the incoming request's url (e.g. req.url). Returns one
// of, keyed so the primary contract is { code } | { error } | { stateMismatch }:
//   { ignore: true }                         path isn't the callback (favicon, …)
//   { stateMismatch: true }                  state missing or ≠ expected (CSRF)
//   { error, denied: true }                  Slack error=access_denied
//   { error }                                any other Slack error param
//   { error, missingCode: true }             callback arrived without a code
//   { code }                                 a usable authorization code
function parseCallback(reqUrl, expectedState) {
  let parsed;
  try { parsed = new URL(reqUrl, 'http://localhost'); }
  catch (_) { return { badRequest: true }; }

  // Ignore anything that isn't the callback (e.g. the browser's favicon probe).
  if (parsed.pathname !== CALLBACK_PATH) return { ignore: true };

  const q = parsed.searchParams;
  const returnedState = q.get('state');
  const errParam = q.get('error');
  const code = q.get('code');

  // CSRF: the state Slack echoes back must equal the one we sent.
  if (!returnedState || returnedState !== expectedState) {
    return { stateMismatch: true };
  }

  // User denied, or Slack returned an error instead of a code.
  if (errParam) {
    if (errParam === 'access_denied') {
      return { error: 'You denied the Slack authorization request. No token was saved.', denied: true };
    }
    return { error: 'Slack returned an error: ' + errParam };
  }
  if (!code) {
    return { error: 'Slack did not return an authorization code.', missingCode: true };
  }
  return { code };
}

// Bind the loopback HTTP server to the first available port in the fixed range.
function bindLoopback(ports) {
  return new Promise((resolve, reject) => {
    const list = ports && ports.length ? ports : DEFAULT_PORTS;
    const tryPort = (i) => {
      if (i >= list.length) {
        return reject(new Error('Could not bind a local port (tried ' + list.join(', ') + ') for the Slack sign-in redirect.'));
      }
      const server = http.createServer();
      server.once('error', (err) => {
        if (err && err.code === 'EADDRINUSE') tryPort(i + 1);
        else reject(err);
      });
      server.listen(list[i], '127.0.0.1', () => resolve(server));
    };
    tryPort(0);
  });
}

// Full orchestration: bind loopback → open browser to the authorize URL → catch
// the redirect → validate state → route errors → exchange the code → persist
// the user token. The loopback server is ALWAYS torn down (success, failure,
// timeout). Electron pieces are injected:
//   openBrowser(url)  -> Promise (main.js passes shell.openExternal)
//   onStarted({ redirectUri, authorizeUrl })  optional renderer notification
//   exchange(...)     -> defaults to slack.exchangeOAuthCode (mockable in tests)
//   envSet(k, v)      -> defaults to envStore.set (mockable in tests)
async function runOAuth({
  clientId,
  clientSecret,
  ports = DEFAULT_PORTS,
  scopes = DEFAULT_USER_SCOPES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  openBrowser,
  onStarted,
  exchange = slack.exchangeOAuthCode,
  envSet = envStore.set
} = {}) {
  let server;
  try { server = await bindLoopback(ports); }
  catch (err) { return { ok: false, error: err.message }; }

  const port = server.address().port;
  const redirectUri = `http://localhost:${port}${CALLBACK_PATH}`;
  const state = generateState();
  const authorizeUrl = buildAuthorizeUrl({ clientId, scopes, redirectUri, state });

  // Let the caller show the exact redirect URI (so the user can register it on
  // their Slack app) while the browser tab is open.
  if (typeof onStarted === 'function') {
    try { onStarted({ redirectUri, authorizeUrl }); } catch (_) { /* non-fatal */ }
  }

  return await new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { server.close(); } catch (_) { /* already closing */ }
      resolve(result);
    };

    server.on('request', async (req, res) => {
      const decision = parseCallback(req.url, state);

      if (decision.badRequest) { res.writeHead(400); res.end('Bad request'); return; }
      if (decision.ignore) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }

      if (decision.stateMismatch) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(renderOAuthPage({ ok: false, title: 'Sign-in failed', message: 'The security check (state) did not match. Please start the sign-in again from the app.' }));
        finish({ ok: false, error: 'State mismatch — the sign-in response failed the CSRF security check. Nothing was changed; please try again.' });
        return;
      }

      // Missing code is a hard failure (400); a returned error param (deny, etc.)
      // is a cancellation the user can retry from (200).
      if (decision.missingCode) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(renderOAuthPage({ ok: false, title: 'Sign-in failed', message: decision.error }));
        finish({ ok: false, error: decision.error });
        return;
      }
      if (decision.error) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(renderOAuthPage({ ok: false, title: 'Sign-in cancelled', message: decision.error }));
        finish({ ok: false, error: decision.error });
        return;
      }

      // Exchange the code for a token.
      const tok = await exchange({ clientId, clientSecret, code: decision.code, redirectUri });
      if (!tok || !tok.ok) {
        const msg = (tok && tok.error) || 'oauth.v2.access failed';
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(renderOAuthPage({ ok: false, title: 'Sign-in failed', message: 'Could not exchange the code for a token: ' + msg }));
        finish({ ok: false, error: msg });
        return;
      }
      const userToken = tok.authed_user && tok.authed_user.access_token;
      if (!userToken) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(renderOAuthPage({ ok: false, title: 'Sign-in failed', message: 'Slack did not return a user token. Make sure user scopes are configured on the Slack app.' }));
        finish({ ok: false, error: 'Slack response did not include a user token (authed_user.access_token). Check that user_scope is configured on the Slack app.' });
        return;
      }

      // Persist the user token as SLACK_TOKEN so every later Slack call uses it.
      try {
        await envSet('SLACK_TOKEN', userToken);
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(renderOAuthPage({ ok: false, title: 'Almost there', message: 'Signed in, but saving the token to .env failed: ' + e.message }));
        finish({ ok: false, error: 'Token obtained but saving to .env failed: ' + e.message });
        return;
      }

      const teamName = (tok.team && tok.team.name) || null;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(renderOAuthPage({ ok: true, title: 'Signed in to Slack', message: 'You can close this tab and return to Claude CMD UI.' }));
      finish({
        ok: true,
        token: userToken,
        team: teamName,
        teamId: (tok.team && tok.team.id) || null,
        userId: (tok.authed_user && tok.authed_user.id) || null,
        redirectUri
      });
    });

    server.once('error', (e) => finish({ ok: false, error: 'Loopback server error: ' + e.message }));

    // Abandoned flow safety net.
    timer = setTimeout(() => {
      finish({ ok: false, error: 'Slack sign-in timed out (no response within 5 minutes). Please try again.' });
    }, timeoutMs);

    // Open the system browser to Slack's authorize page.
    Promise.resolve()
      .then(() => (typeof openBrowser === 'function' ? openBrowser(authorizeUrl) : undefined))
      .catch((e) => {
        finish({ ok: false, error: 'Could not open the browser: ' + e.message });
      });
  });
}

module.exports = {
  DEFAULT_USER_SCOPES,
  DEFAULT_PORTS,
  DEFAULT_TIMEOUT_MS,
  CALLBACK_PATH,
  generateState,
  buildAuthorizeUrl,
  renderOAuthPage,
  parseCallback,
  bindLoopback,
  runOAuth
};
