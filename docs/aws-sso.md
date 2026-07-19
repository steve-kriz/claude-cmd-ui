# AWS SSO environment switcher

## What it does and why

The AWS switcher signs you into your AWS IAM Identity Center (SSO) portal,
discovers every account you can reach, lets you pick an account + role, and
writes the resulting temporary credentials into your `~/.aws/credentials` so the
embedded terminals (and anything else using the default profile) pick them up.
It replaces the manual `aws sso login` / profile-juggling dance with a few
clicks.

## How it works

All logic is in [`lib/aws.js`](../lib/aws.js); the IPC handlers are in
[`main.js`](../main.js), and progress streams to the UI over the `aws:log` event
channel while the active selection is pushed over `aws:status`.

- **Shared SSO session** — `ensureSsoSession()` writes a
  `[sso-session claude-cmd-ui]` block into `~/.aws/config` (keyed by the start
  URL, region `ap-southeast-2`, scope `sso:account:access`). One
  `aws sso login --sso-session claude-cmd-ui` then unlocks every account.
- **Account discovery** — `listEnvironments()` gets a valid SSO token
  (`getValidSsoToken`, reusing the cached token when unexpired) and calls
  `aws sso list-accounts`, returning `{ accountId, accountName, emailAddress }[]`.
- **Role listing** — `listRolesForAccount(accountId)` calls
  `aws sso list-account-roles` for the chosen account.
- **Apply** — `applyAccountRole({ accountId, accountName, role, targetProfile })`
  ensures a `[profile sso-<account>]` (bound to the shared session, set to the
  chosen role), exports temporary credentials
  (`aws configure export-credentials`), and rewrites them into the selected
  credential profile **plus `[default]`** (`rewriteCredentials`). It persists an
  active-status object (account, role, profile, expiration) to
  `<userData>/status.json` via `writeStatus`.
- **One-time backup** — before the first credential rewrite, `backupOnce()`
  copies `~/.aws/credentials` to `credentials.bak.<timestamp>` and drops a
  `.claude-cmd-ui.backed-up` flag so it only happens once.
- **Profile picker** — `listCredentialProfiles()` parses the `[name]` headers out
  of `~/.aws/credentials` (always offering `default`) so you can choose which
  profile the keys are written to.
- **AWS CLI path** — the AWS CLI v2 is invoked at
  `C:\Program Files\Amazon\AWSCLIV2\aws.exe` (`AWS_EXE`).

## Usage

From the UI (in the Git Bash tab's sub-toolbar): click **AWS environment ▾** →
**List accounts ↻**, pick an account, pick a role if prompted, and choose the
target **Profile**. The status chip shows the active account/role/expiration and
persists across restarts. Bridge calls (see [`ipc-bridge.md`](ipc-bridge.md)):

```js
const off = window.api.aws.onLog(({ line }) => console.log(line));
const envs = await window.api.aws.listEnvironments();          // { ok, accounts }
const roles = await window.api.aws.listRoles(envs.accounts[0].accountId);
await window.api.aws.applyRole(
  envs.accounts[0].accountId, envs.accounts[0].accountName, roles.roles[0], 'default'
);
off();
const status = await window.api.aws.status();                  // persisted active selection
```

## Configuration

The SSO start URL and account IDs are read from `.env`
(see [`configuration.md`](configuration.md)):

| Variable | Purpose |
|----------|---------|
| `AWS_SSO_START_URL` | SSO portal start URL. Prompted for on first use and stored in `.env`. Required. |
| `AWS_DEV_ACCOUNT_ID` | Dev account id for the legacy `[profile sso-dev]` sync (optional). |
| `AWS_PROD_ACCOUNT_ID` | Prod account id for the legacy `production` profile (optional). |

Hardcoded in `lib/aws.js`: `AWS_EXE` (AWS CLI path), `SSO_REGION`
(`ap-southeast-2`), `SSO_SESSION_NAME` (`claude-cmd-ui`), and the credential
target profiles.

## Files written

| Path | What |
|------|------|
| `~/.aws/config` | `[sso-session claude-cmd-ui]` + a `[profile sso-<account>]` per account signed into |
| `~/.aws/credentials` | Rewrites the chosen profile and `[default]` (backed up once first) |
| `~/.aws/credentials.bak.<timestamp>` | One-time backup before the first rewrite |
| `<userData>/status.json` | The active account/role/profile/expiration for the status chip |

## Edge cases, limitations & troubleshooting

- **`AWS_SSO_START_URL` unset** → operations throw "AWS SSO start URL is not
  configured…"; the app prompts for it and saves it to `.env`.
- **Serialized AWS ops** — a module-level `inflight` promise means only one AWS
  operation runs at a time; a second waits for the first.
- **Credential rewriting is destructive** — it overwrites `[default]` (and the
  chosen profile). The one-time backup is your safety net.
- **Session-keyed token** — dynamic-flow profiles bind to
  `sso_session = claude-cmd-ui`, so the CLI needs the session-keyed cached token;
  a stale legacy-profile token triggers a fresh `aws sso login`.
- **AWS CLI v2 must be installed** at the hardcoded path.
