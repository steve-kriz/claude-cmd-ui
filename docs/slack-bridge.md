# Slack bridge

## What it does and why

The Slack bridge connects a Slack channel to the `claude` pane: messages posted
in Slack become prompts for the agent, and the agent's replies are posted back —
kept inside a single Slack thread for the session. It lets you drive and monitor
the agent from Slack (e.g. from your phone) without being at the machine.

## How it works

Three Electron-free modules plus main-process IPC and renderer UI:

- **Web API client** — [`lib/slack.js`](../lib/slack.js): `authTest`,
  `resolveChannel` (accepts `#name`, `name`, or a raw `C…/G…` id),
  `connect` (auth + resolve), `fetchHistory` (`conversations.history`),
  `fetchReplies` (`conversations.replies` — required to see thread replies),
  `postMessage` (`chat.postMessage`, optionally threaded), `openSocketUrl`
  (`apps.connections.open`), and `exchangeOAuthCode` (`oauth.v2.access`). Errors
  are humanized (e.g. `missing_scope` names the exact scope to add).
- **OAuth flow** — [`lib/slack-oauth.js`](../lib/slack-oauth.js) runs "Sign in
  with Slack" (OAuth v2): builds the authorize URL requesting user scopes,
  binds a loopback server on a fixed port range (53701–53705), catches the
  redirect, verifies the `state` (CSRF) token, exchanges the code, and writes the
  resulting user token (`xoxp-…`) into `.env` as `SLACK_TOKEN`. The Electron
  pieces (open browser, notify renderer) are injected by `main.js`.
- **Proxy decision logic** — [`lib/slack-proxy.js`](../lib/slack-proxy.js):
  `isProxyEnabled(state)` (connected + anchor thread exists) and
  `shouldDispatchIncoming(msg, state)` which accepts a message only when it has a
  `ts`, is not the bot's/your own post, hasn't been seen, is a real user message,
  and belongs to the session anchor thread. The renderer keeps a verbatim mirror.
- **Token loading** — `slack:getToken` (via `aws.getSlackToken`) reads the bot
  token from the `SLACK_TOKEN` `.env` variable (AWS Secrets Manager is no longer
  used). An `xapp-…` value is treated as the app token; the bot token must be
  `xoxb-…` (or a user `xoxp-…` from OAuth).
- **Transports** — real-time delivery uses **Socket Mode** when an app-level
  token (`SLACK_APP_TOKEN`, `xapp-…`, scope `connections:write`) is available:
  `slack:openSocket` returns a WebSocket URL the renderer connects to. Without an
  app token it falls back to **polling** `conversations.history` on an interval.

## Usage

From the UI: open the **Slack** tab, either paste a bot token or click **Sign in
with Slack**, **Connect** to a `#channel`, and toggle live listening / posting
replies. Bridge calls (see [`ipc-bridge.md`](ipc-bridge.md)):

```js
const { token, appToken } = await window.api.slack.getToken();   // from .env
const conn = await window.api.slack.connect(token, '#dev-agent'); // { ok, channelId, botUserId, ... }
const hist = await window.api.slack.fetch(token, conn.channelId, null, 50);
await window.api.slack.post(token, conn.channelId, 'Working on it…', anchorTs);

// or run the OAuth sign-in (writes SLACK_TOKEN into .env)
const off = window.api.slack.onOAuthStarted(({ redirectUri }) => console.log(redirectUri));
const res = await window.api.slack.startOAuth();
off();
```

## Configuration

Set these in `.env` (see [`configuration.md`](configuration.md)):

| Variable | Purpose |
|----------|---------|
| `SLACK_TOKEN` | Bot token (`xoxb-…`) or user token (`xoxp-…`, written by OAuth). Required to connect. |
| `SLACK_APP_TOKEN` | App-level token (`xapp-…`, scope `connections:write`) to enable Socket Mode. Optional — falls back to polling. |
| `SLACK_CLIENT_ID` | OAuth app client id (needed for "Sign in with Slack"). |
| `SLACK_CLIENT_SECRET` | OAuth app client secret. |

Bot token scopes: `channels:history`, `channels:read`, `groups:history`,
`groups:read`, `chat:write` (`DEFAULT_USER_SCOPES` for the user-token OAuth
flow). The bot must be invited to the target channel (`/invite @yourbot`). OAuth
redirect URI is `http://localhost:<53701-53705>/slack/oauth/callback` — register
it on your Slack app.

## API reference

| Channel | `window.api.slack` | Result |
|---------|---------------------|--------|
| `slack:getToken` | `getToken()` | `{ token, appToken, secretId }` |
| `slack:connect` | `connect(token, channel)` | `{ ok, channelId, channelName, botUserId, team }` |
| `slack:fetch` | `fetch(token, channel, oldest, limit)` | `{ ok, messages }` (oldest-first) |
| `slack:fetchReplies` | `fetchReplies(token, channel, ts, oldest, limit)` | `{ ok, messages }` |
| `slack:post` | `post(token, channel, text, threadTs)` | `{ ok, ts }` |
| `slack:openSocket` | `openSocket(appToken)` | `{ ok, url }` |
| `slack:startOAuth` | `startOAuth()` | `{ ok, token, team, ... }` or `{ ok:false, needsCredentials? }` |
| `slack:oauthStarted` (event) | `onOAuthStarted(cb)` | `{ redirectUri, authorizeUrl }` |

## Edge cases, limitations & troubleshooting

- **Wrong token type** — pasting an `xapp-…` into Connect is rejected ("that
  looks like an app-level token"); it belongs in `SLACK_APP_TOKEN`.
- **`missing_scope`** — the error names the exact scope to add under OAuth &
  Permissions → Bot Token Scopes; reinstall the app and reload the token.
- **Bot not in channel** — channel resolution fails with "not found, or the bot
  is not a member of it"; invite the bot.
- **OAuth needs credentials** — `startOAuth` returns `needsCredentials: true`
  when `SLACK_CLIENT_ID`/`SLACK_CLIENT_SECRET` are unset; the UI prompts and
  retries. Only one sign-in may run at a time; abandoned flows time out after
  5 minutes.
- **CSRF / state mismatch** aborts the sign-in with nothing changed.
- **Thread replies invisible to history polling** — the proxy uses
  `conversations.replies` for the anchor thread; `conversations.history` alone
  never returns thread replies.
- **Loop protection** — the bot's own posts and already-seen timestamps are
  filtered so Claude's replies don't loop back in as new prompts.
