'use strict';

// Electron-free orchestration for the "Sign in with Atlassian" OAuth 2.0 (3LO)
// flow — the authorize-URL builder, the `state` (CSRF) check, the
// access_denied / missing-code routing, the loopback HTTP server, and the
// always-close-the-server guarantee — modeled directly on lib/slack-oauth.js.
// It deliberately does NOT `require('electron')`: `http`/`crypto` are Node
// built-ins, and the Electron-specific bits (opening the system browser,
// notifying the renderer) are injected by main.js as callbacks.
//
// Unlike Slack, a successful token exchange is followed by ONE more step:
// Atlassian's token is scoped to an account, not a single site, so we call
// accessible-resources to learn which Jira site (cloud id) to talk to and
// persist that alongside the tokens.

const http = require('http');
const crypto = require('crypto');
const atlassian = require('./atlassian');
const envStore = require('./env-store');

// Scopes: read Jira issues, plus offline_access so a refresh_token is issued.
const DEFAULT_SCOPES = 'read:jira-work offline_access';
// Fixed port range distinct from Slack's (53701-53705) so both flows can be
// registered as separate redirect URLs without ever colliding.
const DEFAULT_PORTS = [53801, 53802, 53803, 53804, 53805];
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

const CALLBACK_PATH = '/atlassian/oauth/callback';

function generateState() {
  return crypto.randomBytes(16).toString('hex');
}

// Build Atlassian's OAuth 2.0 (3LO) authorize URL. `prompt=consent` forces the
// consent screen every time, which is what reliably returns a refresh_token.
function buildAuthorizeUrl({ clientId, scopes, redirectUri, state } = {}) {
  return 'https://auth.atlassian.com/authorize?' + new URLSearchParams({
    audience: 'api.atlassian.com',
    client_id: clientId || '',
    scope: scopes || DEFAULT_SCOPES,
    redirect_uri: redirectUri || '',
    state: state || '',
    response_type: 'code',
    prompt: 'consent'
  }).toString();
}

function renderOAuthPage({ ok, title, message } = {}) {
  const heading = title || (ok ? 'Signed in to Atlassian' : 'Sign-in failed');
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
// exchange — identical shape to lib/slack-oauth.js's parseCallback.
function parseCallback(reqUrl, expectedState) {
  let parsed;
  try { parsed = new URL(reqUrl, 'http://localhost'); }
  catch (_) { return { badRequest: true }; }

  if (parsed.pathname !== CALLBACK_PATH) return { ignore: true };

  const q = parsed.searchParams;
  const returnedState = q.get('state');
  const errParam = q.get('error');
  const code = q.get('code');

  if (!returnedState || returnedState !== expectedState) {
    return { stateMismatch: true };
  }

  if (errParam) {
    if (errParam === 'access_denied') {
      return { error: 'You denied the Atlassian authorization request. No token was saved.', denied: true };
    }
    return { error: 'Atlassian returned an error: ' + errParam };
  }
  if (!code) {
    return { error: 'Atlassian did not return an authorization code.', missingCode: true };
  }
  return { code };
}

function bindLoopback(ports) {
  return new Promise((resolve, reject) => {
    const list = ports && ports.length ? ports : DEFAULT_PORTS;
    const tryPort = (i) => {
      if (i >= list.length) {
        return reject(new Error('Could not bind a local port (tried ' + list.join(', ') + ') for the Atlassian sign-in redirect.'));
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
// the redirect → validate state → route errors → exchange the code → look up
// the accessible Jira site → persist tokens + site info. The loopback server is
// ALWAYS torn down (success, failure, timeout). Electron pieces are injected:
//   openBrowser(url)  -> Promise (main.js passes shell.openExternal)
//   onStarted({ redirectUri, authorizeUrl })  optional renderer notification
//   exchange(...)        -> defaults to atlassian.exchangeOAuthCode (mockable)
//   fetchResources(token) -> defaults to atlassian.fetchAccessibleResources
//   envSet(k, v)          -> defaults to envStore.set (mockable in tests)
async function runOAuth({
  clientId,
  clientSecret,
  ports = DEFAULT_PORTS,
  scopes = DEFAULT_SCOPES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  openBrowser,
  onStarted,
  exchange = atlassian.exchangeOAuthCode,
  fetchResources = atlassian.fetchAccessibleResources,
  envSet = envStore.set
} = {}) {
  let server;
  try { server = await bindLoopback(ports); }
  catch (err) { return { ok: false, error: err.message }; }

  const port = server.address().port;
  const redirectUri = `http://localhost:${port}${CALLBACK_PATH}`;
  const state = generateState();
  const authorizeUrl = buildAuthorizeUrl({ clientId, scopes, redirectUri, state });

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

      // Exchange the code for tokens.
      const tok = await exchange({ clientId, clientSecret, code: decision.code, redirectUri });
      if (!tok || !tok.ok) {
        const msg = (tok && tok.error) || 'Atlassian token exchange failed';
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(renderOAuthPage({ ok: false, title: 'Sign-in failed', message: 'Could not exchange the code for a token: ' + msg }));
        finish({ ok: false, error: msg });
        return;
      }
      const accessToken = tok.access_token;
      if (!accessToken) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(renderOAuthPage({ ok: false, title: 'Sign-in failed', message: 'Atlassian did not return an access token.' }));
        finish({ ok: false, error: 'Atlassian response did not include an access_token.' });
        return;
      }

      // Which Jira site can this token reach? Needed for every later Jira API
      // call ( https://api.atlassian.com/ex/jira/<cloudId>/rest/api/3/... ).
      const resourcesRes = await fetchResources(accessToken);
      const jiraSite = resourcesRes && resourcesRes.ok
        ? (resourcesRes.resources || []).find((r) => (r.scopes || []).some((s) => s.includes('jira'))) || (resourcesRes.resources || [])[0]
        : null;
      if (!resourcesRes || !resourcesRes.ok || !jiraSite) {
        const msg = (resourcesRes && resourcesRes.error) || 'No accessible Jira site was found for this account.';
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(renderOAuthPage({ ok: false, title: 'Almost there', message: 'Signed in, but could not determine your Jira site: ' + msg }));
        finish({ ok: false, error: 'Signed in but could not resolve a Jira site: ' + msg });
        return;
      }

      // Persist everything jira-ba / the app need to call the Jira REST API.
      try {
        await envSet('ATLASSIAN_ACCESS_TOKEN', accessToken);
        await envSet('ATLASSIAN_REFRESH_TOKEN', tok.refresh_token || '');
        await envSet('ATLASSIAN_CLOUD_ID', jiraSite.id || '');
        await envSet('ATLASSIAN_SITE_URL', jiraSite.url || '');
        await envSet('ATLASSIAN_SITE_NAME', jiraSite.name || '');
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(renderOAuthPage({ ok: false, title: 'Almost there', message: 'Signed in, but saving the token to .env failed: ' + e.message }));
        finish({ ok: false, error: 'Token obtained but saving to .env failed: ' + e.message });
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(renderOAuthPage({ ok: true, title: 'Signed in to Atlassian', message: 'You can close this tab and return to Claude CMD UI.' }));
      finish({
        ok: true,
        token: accessToken,
        siteUrl: jiraSite.url || null,
        siteName: jiraSite.name || null,
        cloudId: jiraSite.id || null,
        redirectUri
      });
    });

    server.once('error', (e) => finish({ ok: false, error: 'Loopback server error: ' + e.message }));

    timer = setTimeout(() => {
      finish({ ok: false, error: 'Atlassian sign-in timed out (no response within 5 minutes). Please try again.' });
    }, timeoutMs);

    Promise.resolve()
      .then(() => (typeof openBrowser === 'function' ? openBrowser(authorizeUrl) : undefined))
      .catch((e) => {
        finish({ ok: false, error: 'Could not open the browser: ' + e.message });
      });
  });
}

module.exports = {
  DEFAULT_SCOPES,
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
