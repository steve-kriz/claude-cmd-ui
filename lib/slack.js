'use strict';

// Thin client for the Slack Web API used by the Slack tab. The bot token
// (xoxb-…) is loaded from the SLACK_TOKEN .env variable (see
// lib/aws.getSlackToken) and needs these scopes:
//   channels:history / groups:history   read messages from the channel
//   channels:read    / groups:read       resolve channel name → id
//   chat:write                            post Claude's replies back
//
// The bot must also be invited into the target channel (/invite @yourbot).
//
// Real-time delivery uses Socket Mode (openSocketUrl below), which additionally
// needs an app-level token (xapp-…) with the connections:write scope, plus
// Socket Mode and message events enabled on the Slack app. When that token is
// absent the caller falls back to polling conversations.history.

const https = require('https');

const SLACK_API = 'slack.com';

// Turn a failed Slack response into a human-readable message. Slack returns
// `needed`/`provided` alongside `missing_scope`, so we can name the exact scope
// to add rather than leaving the user with a bare "missing_scope".
function describeError(res, fallback) {
  const code = (res && res.error) || fallback || 'request failed';
  if (code === 'missing_scope') {
    const provided = (res && res.provided) || '(none)';
    const list = ((res && res.needed) || '').split(',').map((s) => s.trim()).filter(Boolean);
    const plural = list.length > 1;
    const scopes = list.length
      ? `the ${list.map((s) => `"${s}"`).join(' / ')} scope${plural ? 's' : ''}`
      : 'a required scope';
    return `missing_scope — the Slack bot token is missing ${scopes}. `
      + `Add ${plural ? 'them' : 'it'} under your Slack app → OAuth & Permissions → Bot Token Scopes, `
      + `then reinstall the app to the workspace and reload the token. `
      + `(Token currently has: ${provided}.)`;
  }
  return code;
}

function slackRequest(method, token, payload, useGet) {
  return new Promise((resolve) => {
    let pathName = '/api/' + method;
    let body = null;
    const headers = {
      Authorization: 'Bearer ' + token,
      Accept: 'application/json'
    };

    if (useGet) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(payload || {})) {
        if (v != null) qs.append(k, String(v));
      }
      const q = qs.toString();
      if (q) pathName += '?' + q;
    } else {
      body = JSON.stringify(payload || {});
      headers['Content-Type'] = 'application/json; charset=utf-8';
      headers['Content-Length'] = Buffer.byteLength(body);
    }

    const req = https.request(
      { hostname: SLACK_API, path: pathName, method: useGet ? 'GET' : 'POST', headers },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let json;
          try { json = JSON.parse(data); }
          catch (_) { return resolve({ ok: false, error: 'invalid JSON from Slack: ' + data.slice(0, 200) }); }
          resolve(json);
        });
      }
    );
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    if (body) req.write(body);
    req.end();
  });
}

// Verify the token and return the bot identity. The bot user id lets the
// poller skip messages the bot itself posted (so Claude's replies don't loop
// back in as new prompts).
async function authTest(token) {
  if (!token || !token.trim()) return { ok: false, error: 'A Slack bot token is required.' };
  const t = token.trim();
  if (t.startsWith('xapp-')) {
    return { ok: false, error: 'That looks like an app-level token (xapp-…), not a bot token. Connect needs the bot token (xoxb-…); put the xapp- token in SLACK_APP_TOKEN instead.' };
  }
  const res = await slackRequest('auth.test', t, {}, false);
  if (!res.ok) {
    if (res.error === 'invalid_auth') {
      return { ok: false, error: 'invalid_auth — the Slack bot token is invalid, expired, or revoked. Check the SLACK_TOKEN value in your .env file (it should start with xoxb-).' };
    }
    return { ok: false, error: describeError(res, 'auth.test failed') };
  }
  return {
    ok: true,
    botUserId: res.user_id || null,
    botUser: res.user || null,
    team: res.team || null,
    teamId: res.team_id || null,
    url: res.url || null
  };
}

// Accepts a raw channel id (C…/G…) or a #name / name and resolves it to an id.
async function resolveChannel(token, channel) {
  const raw = (channel || '').trim();
  if (!raw) return { ok: false, error: 'A channel is required.' };

  // Looks like an id already — confirm it and grab the name.
  if (/^[CGD][A-Z0-9]{6,}$/.test(raw)) {
    const info = await slackRequest('conversations.info', token, { channel: raw }, true);
    if (info.ok && info.channel) {
      return { ok: true, id: info.channel.id, name: info.channel.name || raw };
    }
    // Even if info fails (e.g. missing scope) the id is usable for history/post.
    return { ok: true, id: raw, name: raw };
  }

  const wanted = raw.replace(/^#/, '').toLowerCase();
  let cursor = '';
  for (let page = 0; page < 10; page++) {
    const params = { types: 'public_channel,private_channel', limit: 1000, exclude_archived: true };
    if (cursor) params.cursor = cursor;
    const list = await slackRequest('conversations.list', token, params, true);
    if (!list.ok) return { ok: false, error: describeError(list, 'conversations.list failed') };
    const match = (list.channels || []).find((c) => (c.name || '').toLowerCase() === wanted);
    if (match) return { ok: true, id: match.id, name: match.name };
    cursor = (list.response_metadata && list.response_metadata.next_cursor) || '';
    if (!cursor) break;
  }
  return { ok: false, error: `Channel "${raw}" not found, or the bot is not a member of it.` };
}

// Connect = auth + channel resolution in one round-trip for the UI.
async function connect(token, channel) {
  const auth = await authTest(token);
  if (!auth.ok) return auth;
  const ch = await resolveChannel(token.trim(), channel);
  if (!ch.ok) return ch;
  return { ok: true, ...auth, channelId: ch.id, channelName: ch.name };
}

// Pull messages newer than `oldest` (a Slack ts string). Returns oldest-first.
async function fetchHistory(token, channel, oldest, limit) {
  const params = { channel, limit: Math.max(1, Math.min(200, Number(limit) || 50)) };
  if (oldest) { params.oldest = oldest; params.inclusive = false; }
  const res = await slackRequest('conversations.history', token, params, true);
  if (!res.ok) return { ok: false, error: describeError(res, 'conversations.history failed') };
  const messages = (res.messages || [])
    .slice()
    .sort((a, b) => Number(a.ts) - Number(b.ts));
  return { ok: true, messages };
}

async function postMessage(token, channel, text, threadTs) {
  const payload = { channel, text: text == null ? '' : String(text) };
  if (threadTs) payload.thread_ts = threadTs;
  const res = await slackRequest('chat.postMessage', token, payload, false);
  if (!res.ok) return { ok: false, error: describeError(res, 'chat.postMessage failed') };
  return { ok: true, ts: res.ts || null };
}

// Open a Socket Mode connection and return a short-lived WebSocket URL the
// renderer can connect to. Requires an app-level token (xapp-…) with the
// connections:write scope — distinct from the xoxb- bot token. The app must
// also have Socket Mode enabled with message events subscribed. The URL is
// single-use and expires quickly, so callers fetch a fresh one per connect /
// reconnect. When no app token is configured the caller falls back to polling.
async function openSocketUrl(appToken) {
  if (!appToken || !appToken.trim()) {
    return { ok: false, error: 'An app-level token (xapp-…) is required for Socket Mode.' };
  }
  const res = await slackRequest('apps.connections.open', appToken.trim(), {}, false);
  if (!res.ok) return { ok: false, error: describeError(res, 'apps.connections.open failed') };
  if (!res.url) return { ok: false, error: 'apps.connections.open returned no url' };
  return { ok: true, url: res.url };
}

module.exports = { authTest, resolveChannel, connect, fetchHistory, postMessage, openSocketUrl };
