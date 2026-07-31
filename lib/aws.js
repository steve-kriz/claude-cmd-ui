const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

// On Windows the AWS CLI v2 installs to a fixed Program Files path that is not
// always on PATH; everywhere else we invoke `aws` from PATH (Homebrew/pkg
// installs put it there). Single resolver used by every call site below.
function resolveAwsExe(platform = process.platform) {
  return platform === 'win32'
    ? 'C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe'
    : 'aws';
}
const AWS_EXE = resolveAwsExe();
const SSO_REGION = 'ap-southeast-2';

// SSO portal URLs are often copy-pasted from the browser after a login
// redirect, which can carry a trailing SPA route fragment (`#/`), query
// string, or trailing slash. Any of those makes the value differ from the
// `startUrl` AWS CLI writes into the cached token, so the cache lookup in
// readSsoToken/readSsoAccessToken silently fails even though the token is
// valid. Normalize once here so every caller (config-file writers and cache
// readers alike) agrees on the same canonical URL.
function normalizeSsoUrl(url) {
  return url.split('#')[0].split('?')[0].replace(/\/+$/, '');
}

// Resolved at call time so the value picked up from .env (or a freshly saved
// one) is always current. Throws if it has not been configured yet.
function getSsoUrl() {
  const v = (process.env.AWS_SSO_START_URL || '').trim();
  if (!v) {
    throw new Error('AWS SSO start URL is not configured. Set AWS_SSO_START_URL in .env (the app will prompt you).');
  }
  return normalizeSsoUrl(v);
}

// Role used only as a placeholder when the profile is first created in
// ~/.aws/config so that `aws sso login` has a valid section to reference.
// The user-selected role from the picker is what ends up actually being
// used to fetch credentials.
const PLACEHOLDER_ROLE = 'global_admin';

// Account IDs are read from .env (AWS_DEV_ACCOUNT_ID / AWS_PROD_ACCOUNT_ID) so
// no real account numbers live in source. Resolved at call time via getAccount.
const PROFILES = {
  dev:  { name: 'sso-dev',    envKey: 'AWS_DEV_ACCOUNT_ID' },
  prod: { name: 'production', envKey: 'AWS_PROD_ACCOUNT_ID' }
};

// Resolve a profile's account ID from .env. Throws if it has not been set.
function getAccount(env) {
  const p = PROFILES[env];
  if (!p) throw new Error(`Unknown env: ${env}`);
  const v = (process.env[p.envKey] || '').trim();
  if (!v) {
    throw new Error(`AWS account ID is not configured. Set ${p.envKey} in .env.`);
  }
  return v;
}

const TARGET_PROFILES = ['default', 'ohq-dev'];

const AWS_DIR = path.join(os.homedir(), '.aws');
const CONFIG_PATH = path.join(AWS_DIR, 'config');
const CREDENTIALS_PATH = path.join(AWS_DIR, 'credentials');
const SSO_CACHE_DIR = path.join(AWS_DIR, 'sso', 'cache');

let inflight = null;

async function readTextSafe(file) {
  try { return await fsp.readFile(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return ''; throw e; }
}

async function atomicWrite(file, content) {
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, content, 'utf8');
  await fsp.rename(tmp, file);
}

function profileSectionRegex(headerLine) {
  return new RegExp('^' + headerLine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'm');
}

function findProfileSection(lines, profileName) {
  const headerRe = new RegExp(
    '^\\[profile ' + profileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\]\\s*$'
  );
  const start = lines.findIndex((l) => headerRe.test(l));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\[[^\]]+\]\s*$/.test(lines[i])) { end = i; break; }
  }
  return { start, end };
}

async function ensureProfile(env) {
  const { name } = PROFILES[env];
  const account = getAccount(env);
  const header = `[profile ${name}]`;
  let content = await readTextSafe(CONFIG_PATH);
  if (profileSectionRegex(header).test(content)) return;

  const block =
    `\n${header}\n` +
    `sso_start_url = ${getSsoUrl()}\n` +
    `sso_region = ${SSO_REGION}\n` +
    `sso_account_id = ${account}\n` +
    `sso_role_name = ${PLACEHOLDER_ROLE}\n` +
    `region = ap-southeast-2\n` +
    `output = json\n`;

  if (content.length && !content.endsWith('\n')) content += '\n';
  content += block;
  await fsp.mkdir(AWS_DIR, { recursive: true });
  await atomicWrite(CONFIG_PATH, content);
}

async function setProfileRole(env, role) {
  const { name } = PROFILES[env];
  let content = await readTextSafe(CONFIG_PATH);
  const lines = content.split(/\r?\n/);
  const section = findProfileSection(lines, name);
  if (!section) {
    await ensureProfile(env);
    content = await readTextSafe(CONFIG_PATH);
  }
  const lines2 = content.split(/\r?\n/);
  const section2 = findProfileSection(lines2, name);
  let roleSet = false;
  for (let i = section2.start + 1; i < section2.end; i++) {
    if (/^\s*sso_role_name\s*=/.test(lines2[i])) {
      lines2[i] = `sso_role_name = ${role}`;
      roleSet = true;
      break;
    }
  }
  if (!roleSet) {
    lines2.splice(section2.start + 1, 0, `sso_role_name = ${role}`);
  }
  await fsp.mkdir(AWS_DIR, { recursive: true });
  await atomicWrite(CONFIG_PATH, lines2.join('\n'));
}

function ssoCacheFile(startUrl) {
  const hash = crypto.createHash('sha1').update(startUrl).digest('hex');
  return path.join(SSO_CACHE_DIR, `${hash}.json`);
}

async function readSsoAccessToken() {
  const ssoUrl = getSsoUrl();
  const primary = ssoCacheFile(ssoUrl);
  try {
    const raw = await fsp.readFile(primary, 'utf8');
    const data = JSON.parse(raw);
    if (data && data.accessToken) return data.accessToken;
  } catch (_) { /* fall through to scan */ }

  let files = [];
  try { files = await fsp.readdir(SSO_CACHE_DIR); }
  catch (_) { throw new Error(`SSO cache directory not found: ${SSO_CACHE_DIR}`); }

  let best = null;
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const p = path.join(SSO_CACHE_DIR, f);
    try {
      const data = JSON.parse(await fsp.readFile(p, 'utf8'));
      if (!data || !data.accessToken) continue;
      if (data.startUrl && data.startUrl !== ssoUrl) continue;
      const exp = data.expiresAt ? Date.parse(data.expiresAt) : 0;
      if (!best || exp > best.exp) best = { token: data.accessToken, exp };
    } catch (_) { /* skip */ }
  }
  if (!best) throw new Error('No SSO access token found in cache after login');
  return best.token;
}

function listAccountRoles(accountId, accessToken) {
  return new Promise((resolve, reject) => {
    execFile(
      AWS_EXE,
      [
        'sso', 'list-account-roles',
        '--account-id', accountId,
        '--access-token', accessToken,
        '--region', SSO_REGION,
        '--output', 'json'
      ],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message).trim()));
        try {
          const parsed = JSON.parse(stdout);
          const roleList = Array.isArray(parsed.roleList) ? parsed.roleList : [];
          const names = roleList
            .map((r) => r.roleName)
            .filter((n) => typeof n === 'string' && n.length > 0);
          names.sort((a, b) => a.localeCompare(b));
          resolve(names);
        } catch (e) {
          reject(new Error('Failed to parse list-account-roles JSON: ' + e.message));
        }
      }
    );
  });
}

// Run the AWS CLI, streaming stdout/stderr to onLine line-by-line, and resolve
// when it exits 0. Shared by the profile-based and sso-session-based logins.
function spawnAwsStreaming(args, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(AWS_EXE, args, { windowsHide: true });
    const handleStream = (stream) => {
      let buf = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx).replace(/\r$/, '');
          buf = buf.slice(idx + 1);
          if (onLine) onLine(line);
        }
      });
      stream.on('end', () => {
        if (buf && onLine) onLine(buf);
      });
    };
    handleStream(child.stdout);
    handleStream(child.stderr);
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`aws ${args.join(' ')} exited ${code}`));
    });
  });
}

function awsSsoLogin(profileName, onLine) {
  return spawnAwsStreaming(['sso', 'login', '--profile', profileName], onLine);
}

function exportCredentials(profileName) {
  return new Promise((resolve, reject) => {
    execFile(AWS_EXE,
      ['configure', 'export-credentials', '--profile', profileName, '--format', 'process'],
      { windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        try { resolve(JSON.parse(stdout)); }
        catch (e) { reject(new Error('Failed to parse export-credentials JSON: ' + e.message)); }
      }
    );
  });
}

function rewriteCredentialsText(original, creds, targetProfiles = TARGET_PROFILES) {
  const lines = original.split(/\r?\n/);
  const keys = {
    aws_access_key_id: creds.AccessKeyId,
    aws_secret_access_key: creds.SecretAccessKey,
    aws_session_token: creds.SessionToken
  };

  function findSection(profile) {
    const headerRe = new RegExp('^\\[' + profile + '\\]\\s*$');
    const start = lines.findIndex(l => headerRe.test(l));
    if (start === -1) return null;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^\[[^\]]+\]\s*$/.test(lines[i])) { end = i; break; }
    }
    return { start, end };
  }

  function rewriteSection(section) {
    const seen = { aws_access_key_id: false, aws_secret_access_key: false, aws_session_token: false };
    for (let i = section.start + 1; i < section.end; i++) {
      const l = lines[i];
      const m = l.match(/^(\s*)(aws_access_key_id|aws_secret_access_key|aws_session_token)(\s*=\s*).*$/);
      if (m) {
        const key = m[2];
        lines[i] = `${m[1]}${key}${m[3]}${keys[key]}`;
        seen[key] = true;
      }
    }
    const toInsert = [];
    for (const k of Object.keys(seen)) {
      if (!seen[k]) toInsert.push(`${k}=${keys[k]}`);
    }
    if (toInsert.length) {
      let insertAt = section.start + 1;
      while (insertAt < section.end && lines[insertAt].trim() === '') insertAt++;
      lines.splice(insertAt, 0, ...toInsert);
    }
  }

  for (const profile of targetProfiles) {
    let section = findSection(profile);
    if (!section) {
      if (lines.length && lines[lines.length - 1] !== '') lines.push('');
      lines.push(`[${profile}]`);
      lines.push(`aws_access_key_id=${creds.AccessKeyId}`);
      lines.push(`aws_secret_access_key=${creds.SecretAccessKey}`);
      lines.push(`aws_session_token=${creds.SessionToken}`);
      continue;
    }
    rewriteSection(section);
  }

  return lines.join('\n');
}

async function backupOnce() {
  const flag = path.join(AWS_DIR, '.claude-cmd-ui.backed-up');
  if (fs.existsSync(flag)) return;
  try {
    const original = await readTextSafe(CREDENTIALS_PATH);
    if (!original) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await fsp.writeFile(`${CREDENTIALS_PATH}.bak.${stamp}`, original, 'utf8');
    await fsp.writeFile(flag, stamp, 'utf8');
  } catch (_) { /* best-effort */ }
}

async function rewriteCredentials(creds, targetProfiles) {
  await backupOnce();
  const original = await readTextSafe(CREDENTIALS_PATH);
  const updated = rewriteCredentialsText(original, creds, targetProfiles);
  await fsp.mkdir(AWS_DIR, { recursive: true });
  await atomicWrite(CREDENTIALS_PATH, updated);
}

// Parse the profile section headers ([name]) out of ~/.aws/credentials so the
// UI can let the user pick which profile a role applies to. "default" is always
// offered even if the file does not exist yet.
async function listCredentialProfiles() {
  const content = await readTextSafe(CREDENTIALS_PATH);
  const names = [];
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^\[([^\]]+)\]\s*$/);
    if (!m) continue;
    const name = m[1].trim();
    if (name && !names.includes(name)) names.push(name);
  }
  if (!names.includes('default')) names.unshift('default');
  return names;
}

const STATUS_PATH = () => path.join(getUserDataDir(), 'status.json');
let userDataDir = null;
function setUserDataDir(dir) { userDataDir = dir; }
function getUserDataDir() {
  if (!userDataDir) throw new Error('userDataDir not initialised');
  return userDataDir;
}

async function readStatus() {
  try { return JSON.parse(await fsp.readFile(STATUS_PATH(), 'utf8')); }
  catch (_) { return { active: null, expiration: null }; }
}

async function writeStatus(status) {
  await fsp.mkdir(getUserDataDir(), { recursive: true });
  await atomicWrite(STATUS_PATH(), JSON.stringify(status, null, 2));
}

// ── Slack token (.env only) ─────────────────────────────────────────────────
// The Slack bot token is read exclusively from the SLACK_TOKEN .env variable.
// (Loading it from AWS Secrets Manager is no longer supported.) Throws with
// setup instructions when SLACK_TOKEN is missing.
async function getSlackToken() {
  let envTok = (process.env.SLACK_TOKEN || '').trim();
  let envApp = (process.env.SLACK_APP_TOKEN || '').trim();
  // Common misconfiguration: the app-level token (xapp-…) pasted into
  // SLACK_TOKEN. Slack's auth.test rejects app tokens with "invalid_auth", so
  // treat an xapp- value as the app token and leave the bot token empty.
  if (envTok.startsWith('xapp-')) {
    if (!envApp) envApp = envTok;
    envTok = '';
  }
  if (!envTok) {
    throw new Error(
      'No Slack bot token found. Set SLACK_TOKEN (the bot token, xoxb-…) in your .env file, ' +
      'then reload the token. Optionally set SLACK_APP_TOKEN (xapp-… with connections:write) ' +
      'to enable Socket Mode.'
    );
  }
  // The app-level token (xapp-…) enables Socket Mode; optional — when absent the
  // app falls back to HTTP polling.
  return { token: envTok, appToken: envApp || null, secretId: '.env' };
}

// ── Dynamic environment (account) discovery ────────────────────────────────
// Rather than the hardcoded dev/prod accounts above, these helpers ask the SSO
// portal which accounts the signed-in user can actually reach so the UI can
// render one button per account. A single shared SSO session (a [sso-session]
// block keyed by the start URL) backs every account, so signing in once unlocks
// role listing and credential export for all of them.
const SSO_SESSION_NAME = 'claude-cmd-ui';

// We keep the legacy [profile sso-dev] role in sync when the user signs into
// the dev account through the dynamic flow. The dev account ID comes from .env
// (AWS_DEV_ACCOUNT_ID); when unset, the sync is simply skipped.
function devAccountId() {
  try { return getAccount('dev'); } catch (_) { return null; }
}

async function ensureSsoSession() {
  const header = `[sso-session ${SSO_SESSION_NAME}]`;
  let content = await readTextSafe(CONFIG_PATH);
  if (profileSectionRegex(header).test(content)) return;
  const block =
    `\n${header}\n` +
    `sso_start_url = ${getSsoUrl()}\n` +
    `sso_region = ${SSO_REGION}\n` +
    `sso_registration_scopes = sso:account:access\n`;
  if (content.length && !content.endsWith('\n')) content += '\n';
  content += block;
  await fsp.mkdir(AWS_DIR, { recursive: true });
  await atomicWrite(CONFIG_PATH, content);
}

// The AWS CLI v2 caches an sso-session's token in a file keyed by the SHA-1 of
// the *session name* (whereas legacy `sso_start_url` profiles key by the SHA-1
// of the start URL). The dynamic-flow profiles are bound to `sso_session =
// claude-cmd-ui`, so `aws configure export-credentials` only accepts the
// session-keyed token — reading any other cached token (e.g. one left by the
// legacy `[profile sso-dev]` login) makes the CLI fail with
// "Token for claude-cmd-ui does not exist".
function ssoSessionCacheFile() {
  const hash = crypto.createHash('sha1').update(SSO_SESSION_NAME).digest('hex');
  return path.join(SSO_CACHE_DIR, `${hash}.json`);
}

// Read the cached SSO access token for the shared sso-session. With
// requireValid, an unexpired token is required (otherwise we return null so the
// caller triggers a fresh `aws sso login --sso-session`).
async function readSsoToken({ requireValid = false } = {}) {
  const ssoUrl = getSsoUrl();
  const now = Date.now();
  let data;
  try {
    data = JSON.parse(await fsp.readFile(ssoSessionCacheFile(), 'utf8'));
  } catch (_) { return null; } // no session token cached yet
  if (!data || !data.accessToken) return null;
  if (data.startUrl && data.startUrl !== ssoUrl) return null;
  const exp = data.expiresAt ? Date.parse(data.expiresAt) : 0;
  if (requireValid && !(exp > now)) return null;
  return { token: data.accessToken, exp };
}

function ssoLoginSession(onLine) {
  return spawnAwsStreaming(['sso', 'login', '--sso-session', SSO_SESSION_NAME], onLine);
}

// Return a currently-valid SSO access token, reusing the cached one if it is
// still good and otherwise running an interactive `aws sso login`.
async function getValidSsoToken(onLine) {
  await ensureSsoSession();
  const cached = await readSsoToken({ requireValid: true });
  if (cached && cached.token) {
    if (onLine) onLine('[claude-cmd-ui] reusing cached SSO session');
    return cached.token;
  }
  if (onLine) onLine(`[claude-cmd-ui] running aws sso login --sso-session ${SSO_SESSION_NAME}`);
  await ssoLoginSession(onLine);
  const fresh = await readSsoToken({ requireValid: true });
  if (!fresh || !fresh.token) throw new Error('No SSO access token found in cache after login');
  return fresh.token;
}

function ssoListAccounts(accessToken) {
  return new Promise((resolve, reject) => {
    execFile(
      AWS_EXE,
      ['sso', 'list-accounts', '--access-token', accessToken, '--region', SSO_REGION, '--output', 'json'],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message).trim()));
        try {
          const parsed = JSON.parse(stdout);
          const list = Array.isArray(parsed.accountList) ? parsed.accountList : [];
          const accounts = list
            .map((a) => ({
              accountId: a.accountId,
              accountName: a.accountName || a.accountId,
              emailAddress: a.emailAddress || ''
            }))
            .filter((a) => a.accountId);
          accounts.sort((a, b) => a.accountName.localeCompare(b.accountName));
          resolve(accounts);
        } catch (e) {
          reject(new Error('Failed to parse list-accounts JSON: ' + e.message));
        }
      }
    );
  });
}

// Sign in (if needed) and list every account the user can reach. Each entry is
// { accountId, accountName, emailAddress }.
async function listEnvironments(onLine) {
  if (inflight) {
    if (onLine) onLine('[claude-cmd-ui] another aws operation is in progress; waiting...');
    try { await inflight; } catch (_) { /* swallow */ }
  }
  const run = (async () => {
    if (onLine) onLine('[claude-cmd-ui] discovering AWS accounts from the SSO portal...');
    const token = await getValidSsoToken(onLine);
    const accounts = await ssoListAccounts(token);
    if (onLine) {
      onLine(`[claude-cmd-ui] found ${accounts.length} account(s): ${accounts.map((a) => a.accountName).join(', ') || '(none)'}`);
    }
    return accounts;
  })();
  inflight = run;
  try { return await run; }
  finally { if (inflight === run) inflight = null; }
}

// List the IAM roles available to the user in a specific account.
async function listRolesForAccount(accountId, onLine) {
  if (!accountId) throw new Error('accountId is required');
  if (inflight) {
    if (onLine) onLine('[claude-cmd-ui] another aws operation is in progress; waiting...');
    try { await inflight; } catch (_) { /* swallow */ }
  }
  const run = (async () => {
    const token = await getValidSsoToken(onLine);
    if (onLine) onLine(`[claude-cmd-ui] listing roles for account ${accountId}...`);
    const roles = await listAccountRoles(accountId, token);
    if (onLine) {
      if (roles.length) onLine(`[claude-cmd-ui] found roles: ${roles.join(', ')}`);
      else onLine(`[claude-cmd-ui] no roles returned for account ${accountId}`);
    }
    return { accountId, roles };
  })();
  inflight = run;
  try { return await run; }
  finally { if (inflight === run) inflight = null; }
}

function slugForAccount(acc) {
  const slug = String(acc.accountName || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || `acct-${acc.accountId}`;
}

// The ~/.aws/config profile name we create/update for a discovered account.
function profileNameForAccount(acc) {
  return `sso-${slugForAccount(acc)}`;
}

// Pure text transform: return `content` with a [profile <name>] section that is
// bound to the shared sso-session and set to `role`. Creating the section when
// absent; when present, refreshing the role AND migrating it onto sso_session.
//
// The migration matters because profileNameForAccount can collide with a legacy
// `[profile sso-dev]` (written by ensureProfile, keyed by sso_start_url with no
// sso_session). Such a profile resolves credentials against the start-URL-keyed
// token — which getValidSsoToken never refreshes — so export-credentials fails
// with "SSO session ... has expired" even though the session token is live.
// Stripping the conflicting sso_start_url/sso_region and adding sso_session
// makes the profile use the session-keyed token instead.
function upsertAccountProfileText(content, name, accountId, role) {
  const header = `[profile ${name}]`;
  if (!profileSectionRegex(header).test(content)) {
    let out = content;
    const block =
      `\n${header}\n` +
      `sso_session = ${SSO_SESSION_NAME}\n` +
      `sso_account_id = ${accountId}\n` +
      `sso_role_name = ${role}\n` +
      `region = ap-southeast-2\n` +
      `output = json\n`;
    if (out.length && !out.endsWith('\n')) out += '\n';
    return out + block;
  }

  const lines = content.split(/\r?\n/);
  const section = findProfileSection(lines, name);
  let roleSet = false;
  let sessionSet = false;
  for (let i = section.end - 1; i > section.start; i--) {
    if (/^\s*sso_role_name\s*=/.test(lines[i])) {
      if (!roleSet) { lines[i] = `sso_role_name = ${role}`; roleSet = true; }
    } else if (/^\s*sso_session\s*=/.test(lines[i])) {
      lines[i] = `sso_session = ${SSO_SESSION_NAME}`;
      sessionSet = true;
    } else if (/^\s*sso_(start_url|region)\s*=/.test(lines[i])) {
      // Legacy start-URL binding — remove so only the sso_session drives auth.
      lines.splice(i, 1);
    }
  }
  const toInsert = [];
  if (!sessionSet) toInsert.push(`sso_session = ${SSO_SESSION_NAME}`);
  if (!roleSet) toInsert.push(`sso_role_name = ${role}`);
  if (toInsert.length) lines.splice(section.start + 1, 0, ...toInsert);
  return lines.join('\n');
}

// Ensure a [profile sso-<account>] section exists, bound to the shared SSO
// session and set to the chosen role. Returns the profile name.
async function ensureAccountProfile(acc, role) {
  const name = profileNameForAccount(acc);
  const content = await readTextSafe(CONFIG_PATH);
  const updated = upsertAccountProfileText(content, name, acc.accountId, role);
  await fsp.mkdir(AWS_DIR, { recursive: true });
  await atomicWrite(CONFIG_PATH, updated);
  return name;
}

// Sign into a discovered account with the chosen role, export the temporary
// credentials, and write them into the selected ~/.aws/credentials profile (and
// always [default]). Persists the active status for the chip.
async function applyAccountRole({ accountId, accountName, role, targetProfile }, onLine) {
  if (!accountId) throw new Error('accountId is required');
  if (!role || typeof role !== 'string') throw new Error('role is required');
  const selected = (targetProfile && String(targetProfile).trim()) || 'default';
  const targets = selected === 'default' ? ['default'] : [selected, 'default'];
  if (inflight) {
    if (onLine) onLine('[claude-cmd-ui] another aws operation is in progress; waiting...');
    try { await inflight; } catch (_) { /* swallow */ }
  }
  const run = (async () => {
    const acc = { accountId, accountName: accountName || accountId };
    await getValidSsoToken(onLine); // ensure the shared session is live
    if (onLine) onLine(`[claude-cmd-ui] setting role ${role} on the profile for ${acc.accountName}...`);
    const profileName = await ensureAccountProfile(acc, role);
    if (onLine) onLine(`[claude-cmd-ui] exporting credentials for [${profileName}]...`);
    const creds = await exportCredentials(profileName);
    if (onLine) onLine(`[claude-cmd-ui] rewriting ${targets.map((p) => `[${p}]`).join(' and ')} in ~/.aws/credentials`);
    await rewriteCredentials(creds, targets);
    // Keep the legacy [profile sso-dev] role in sync with the dynamic flow.
    if (accountId === devAccountId()) {
      try { await setProfileRole('dev', role); } catch (_) { /* best-effort */ }
    }
    const status = {
      active: acc.accountName,
      accountId,
      accountName: acc.accountName,
      role,
      profile: selected,
      profiles: targets,
      expiration: creds.Expiration
    };
    await writeStatus(status);
    if (onLine) onLine(`[claude-cmd-ui] done. ${acc.accountName} as ${role} → ${targets.join(', ')}. Expires: ${creds.Expiration}`);
    return status;
  })();
  inflight = run;
  try { return await run; }
  finally { if (inflight === run) inflight = null; }
}

async function loginAndListRoles(env, onLine) {
  if (!['dev', 'prod'].includes(env)) throw new Error(`Unknown env: ${env}`);
  if (inflight) {
    if (onLine) onLine('[claude-cmd-ui] another aws operation is in progress; waiting...');
    try { await inflight; } catch (_) { /* swallow */ }
  }
  const run = (async () => {
    const { name: profile } = PROFILES[env];
    const account = getAccount(env);
    if (onLine) onLine(`[claude-cmd-ui] ensuring profile [${profile}] exists in ~/.aws/config...`);
    await ensureProfile(env);
    if (onLine) onLine(`[claude-cmd-ui] running aws sso login --profile ${profile}`);
    await awsSsoLogin(profile, onLine);
    if (onLine) onLine(`[claude-cmd-ui] reading SSO access token from cache...`);
    const token = await readSsoAccessToken();
    if (onLine) onLine(`[claude-cmd-ui] listing roles for account ${account}...`);
    const roles = await listAccountRoles(account, token);
    if (onLine) {
      if (roles.length) onLine(`[claude-cmd-ui] found roles: ${roles.join(', ')}`);
      else onLine(`[claude-cmd-ui] no roles returned for account ${account}`);
    }
    return { env, account, roles };
  })();
  inflight = run;
  try { return await run; }
  finally { if (inflight === run) inflight = null; }
}

async function applyRole(env, role, targetProfile, onLine) {
  if (!['dev', 'prod'].includes(env)) throw new Error(`Unknown env: ${env}`);
  if (!role || typeof role !== 'string') throw new Error('role is required');
  // Which credential profile(s) the exported keys get written to. Picking
  // "default" (or nothing) only touches [default]; picking any other profile
  // updates that profile AND [default].
  const selected = (targetProfile && String(targetProfile).trim()) || 'default';
  const targets = selected === 'default' ? ['default'] : [selected, 'default'];
  if (inflight) {
    if (onLine) onLine('[claude-cmd-ui] another aws operation is in progress; waiting...');
    try { await inflight; } catch (_) { /* swallow */ }
  }
  const run = (async () => {
    const profile = PROFILES[env].name;
    if (onLine) onLine(`[claude-cmd-ui] setting sso_role_name = ${role} on [profile ${profile}]`);
    await setProfileRole(env, role);
    if (onLine) onLine(`[claude-cmd-ui] exporting credentials for [${profile}]...`);
    const creds = await exportCredentials(profile);
    if (onLine) onLine(`[claude-cmd-ui] rewriting ${targets.map((p) => `[${p}]`).join(' and ')} in ~/.aws/credentials`);
    await rewriteCredentials(creds, targets);
    const status = { active: env, role, profile: selected, profiles: targets, expiration: creds.Expiration };
    await writeStatus(status);
    if (onLine) onLine(`[claude-cmd-ui] done. Active: ${env} as ${role} → ${targets.join(', ')}. Expires: ${creds.Expiration}`);
    return status;
  })();
  inflight = run;
  try { return await run; }
  finally { if (inflight === run) inflight = null; }
}

module.exports = {
  loginAndListRoles,
  applyRole,
  listEnvironments,
  listRolesForAccount,
  applyAccountRole,
  readStatus,
  listCredentialProfiles,
  setUserDataDir,
  getSlackToken,
  __testing: { rewriteCredentialsText, resolveAwsExe, normalizeSsoUrl, upsertAccountProfileText }
};
