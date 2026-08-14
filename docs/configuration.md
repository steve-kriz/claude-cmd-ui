# Configuration & environment

## What it does and why

Claude CMD UI reads its secrets and settings from a single project-root `.env`
file and a handful of process environment variables, plus a couple of JSON state
files in Electron's per-user data directory. This doc is the single reference for
every configurable value, its default, and its purpose.

## How it works

- **`.env` reader/writer** — [`lib/env-store.js`](../lib/env-store.js) is a tiny,
  dependency-free `.env` parser/writer. At boot, `main.js` points it at
  `<appRoot>/.env` and calls `loadIntoProcessEnv()`, which seeds `process.env`
  **without clobbering** values already present in the real environment (so a
  command-line override wins). `get(key)` reads from `process.env`; `set(key,
  value)` persists to the file (atomic `.tmp`-then-rename) **and** updates
  `process.env`. Keys must match `^[A-Za-z_][A-Za-z0-9_]*$`; values needing
  quoting are quoted.
- **Renderer access** — the renderer reads/writes values through
  `api.env.get(key)` / `api.env.set(key, value)` (`env:get` / `env:set` IPC).
- **State files** — some state is JSON in Electron's `userData` dir, not `.env`:
  the open-folder list (`session.json`) and the active AWS selection
  (`status.json`).

## Usage

Create a `.env` in the project root (values are read at launch; some, like the
AWS start URL and Slack token, are also written back by the app):

```dotenv
# AWS SSO (see docs/aws-sso.md)
AWS_SSO_START_URL=https://my-org.awsapps.com/start
AWS_DEV_ACCOUNT_ID=111111111111
AWS_PROD_ACCOUNT_ID=222222222222

# Slack (see docs/slack-bridge.md)
SLACK_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_CLIENT_ID=...
SLACK_CLIENT_SECRET=...

# Optional cloud prompt-log sync (see docs/prompt-history.md)
CLOUD_LOG_ENDPOINT=https://xxxx.lambda-url.ap-southeast-2.on.aws/
CLOUD_LOG_API_KEY=...
CLOUD_LOG_USERNAME=steve

# Atlassian / Jira (see docs/jira-integration.md)
ATLASSIAN_CLIENT_ID=...
ATLASSIAN_CLIENT_SECRET=...
# ATLASSIAN_ACCESS_TOKEN / ATLASSIAN_REFRESH_TOKEN / ATLASSIAN_CLOUD_ID /
# ATLASSIAN_SITE_URL / ATLASSIAN_SITE_NAME are written automatically by
# "Sign in with Atlassian" — you normally never edit these by hand.
```

Read/write from the renderer or a Node one-off:

```js
const { value } = await window.api.env.get('SLACK_TOKEN');
await window.api.env.set('AWS_SSO_START_URL', 'https://my-org.awsapps.com/start');
```

```bash
node -e "const e=require('./lib/env-store'); console.log(e.readAll())"
```

## Environment variables

| Variable | Default | Purpose | Feature doc |
|----------|---------|---------|-------------|
| `OPEN_DEVTOOLS` | (unset → open) | Set `0` to stop DevTools opening on launch | [app-shell](app-shell.md) |
| `AWS_SSO_START_URL` | (required for AWS) | SSO portal start URL; prompted and saved on first use | [aws-sso](aws-sso.md) |
| `AWS_DEV_ACCOUNT_ID` | (none) | Dev account id for the legacy `sso-dev` profile sync; also names the account **Claude variables ⬇** reads from | [aws-sso](aws-sso.md) |
| `AWS_PROD_ACCOUNT_ID` | (none) | Prod account id for the legacy `production` profile | [aws-sso](aws-sso.md) |
| `CLAUDE_SECRET_ID` | `/dev/claude-cmd-ui` | Secrets Manager secret the **Claude variables ⬇** button pulls into `.env` | [aws-sso](aws-sso.md) |
| `SLACK_TOKEN` | (required to connect) | Bot token `xoxb-…` or user token `xoxp-…` (OAuth writes this) | [slack-bridge](slack-bridge.md) |
| `SLACK_APP_TOKEN` | (none) | App-level token `xapp-…` to enable Socket Mode | [slack-bridge](slack-bridge.md) |
| `SLACK_CLIENT_ID` | (none) | OAuth app client id for "Sign in with Slack" | [slack-bridge](slack-bridge.md) |
| `SLACK_CLIENT_SECRET` | (none) | OAuth app client secret | [slack-bridge](slack-bridge.md) |
| `CLOUD_LOG_ENDPOINT` | (unset → disabled) | Prompt-logs Lambda URL for cloud sync | [prompt-history](prompt-history.md) |
| `CLOUD_LOG_API_KEY` | (none) | Optional shared secret sent as `X-Api-Key` | [prompt-history](prompt-history.md) |
| `CLOUD_LOG_USERNAME` | OS username | Username tag for cloud log events | [prompt-history](prompt-history.md) |
| `ATLASSIAN_CLIENT_ID` / `ATLASSIAN_CLIENT_SECRET` | (none) | OAuth 2.0 (3LO) app credentials for **Sign in with Atlassian** | [jira-integration](jira-integration.md) |
| `ATLASSIAN_ACCESS_TOKEN` | (none) | Bearer token the `jira-ba` agent uses to call the Jira REST API (OAuth writes this) | [jira-integration](jira-integration.md) |
| `ATLASSIAN_REFRESH_TOKEN` | (none) | Used to mint a new access token once the current one expires | [jira-integration](jira-integration.md) |
| `ATLASSIAN_CLOUD_ID` | (none) | Resolved Jira site (cloud id); part of every Jira REST API URL | [jira-integration](jira-integration.md) |
| `ATLASSIAN_SITE_URL` / `ATLASSIAN_SITE_NAME` | (none) | Shown in the Team tab as "Connected to `<site>`" | [jira-integration](jira-integration.md) |

Lambda-side variables (`LOG_GROUP`, `AWS_REGION`, `API_KEY`) are documented in
[prompt-history](prompt-history.md).

## Data & state files

| Path | What | Written by |
|------|------|-----------|
| `<appRoot>/.env` | Secrets/config | `lib/env-store.js` |
| `<userData>/session.json` | Open-folder list, restored on launch | app ([app-shell](app-shell.md)) |
| `<userData>/status.json` | Active AWS env/role/expiration | `lib/aws.js` ([aws-sso](aws-sso.md)) |
| `<project>/.claude-logs/logs/prompt_history.json` | Per-project prompt history | app ([prompt-history](prompt-history.md)) |
| `<project>/tasks/<status>/TASK-*.md` | Ticket files (one subfolder per status) | orchestrate ([orchestrate-workflow](orchestrate-workflow.md)) |
| `~/.aws/config`, `~/.aws/credentials` | SSO session/profiles + rewritten credentials | `lib/aws.js` ([aws-sso](aws-sso.md)) |
| `<project>/.gitignore` | Appended by the ignore menu | app ([change-viewer](change-viewer.md)) |

`<userData>` is Electron's per-user app-data directory; `<appRoot>` is the app's
install/checkout directory.

## Edge cases, limitations & troubleshooting

- **Real env wins over `.env`** — `loadIntoProcessEnv` only fills variables that
  are unset or empty, so a shell override takes precedence.
- **Config read fresh where it matters** — `lib/cloud-logs.js` re-reads its env
  on every call, so cloud-sync settings can change without restarting.
- **Invalid `.env` key** — `env-store.set` throws on a key that isn't a valid
  identifier.
- **Some values are written by the app** — `AWS_SSO_START_URL` (on first AWS use)
  and `SLACK_TOKEN` (by the OAuth flow) are persisted back into `.env`
  automatically.
- **`.env` holds secrets** — treat it accordingly and keep it out of version
  control.
