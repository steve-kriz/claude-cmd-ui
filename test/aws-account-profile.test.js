'use strict';

// ===========================================================================
// upsertAccountProfileText — UNIT tests.
//
// Regression coverage for a real bug: the dynamic account flow computes the
// profile name `sso-<accountName>`, which for an account literally named "dev"
// collides with the legacy `[profile sso-dev]` that ensureProfile writes. The
// legacy section is keyed by sso_start_url and has NO sso_session, so
// `aws configure export-credentials --profile sso-dev` resolved the
// start-URL-keyed token (which getValidSsoToken never refreshes) and failed
// with "The SSO session associated with this profile has expired..." even
// though the shared session token was live and "reusing cached SSO session"
// had just been logged.
//
// The fix: when the profile already exists, migrate it onto the shared
// sso-session (add sso_session, drop the conflicting sso_start_url/sso_region).
//
// No filesystem, AWS CLI, or Electron is touched.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { __testing } = require('../lib/aws');
const { upsertAccountProfileText } = __testing;

const LEGACY_SSO_DEV =
  '[default]\n' +
  'region = ap-southeast-2\n' +
  '\n' +
  '[profile sso-dev]\n' +
  'sso_start_url = https://d-976741486c.awsapps.com/start\n' +
  'sso_region = ap-southeast-2\n' +
  'sso_account_id = 058264301523\n' +
  'sso_role_name = global_admin\n' +
  'region = ap-southeast-2\n' +
  'output = json\n';

test('UNIT: migrating a legacy sso-dev profile adds sso_session', () => {
  const out = upsertAccountProfileText(LEGACY_SSO_DEV, 'sso-dev', '058264301523', 'global_admin');
  assert.match(out, /^\s*sso_session = claude-cmd-ui\s*$/m,
    'migrated profile must be bound to the shared sso-session');
});

test('UNIT: migration strips the conflicting legacy start-URL keys', () => {
  const out = upsertAccountProfileText(LEGACY_SSO_DEV, 'sso-dev', '058264301523', 'global_admin');
  assert.doesNotMatch(out, /^\s*sso_start_url\s*=/m,
    'legacy sso_start_url must be removed so only sso_session drives auth');
  assert.doesNotMatch(out, /^\s*sso_region\s*=/m,
    'legacy sso_region must be removed');
});

test('UNIT: migration refreshes the role and keeps account id', () => {
  const out = upsertAccountProfileText(LEGACY_SSO_DEV, 'sso-dev', '058264301523', 'DEV_ADMIN');
  assert.match(out, /^\s*sso_role_name = DEV_ADMIN\s*$/m);
  assert.equal((out.match(/^\s*sso_role_name\s*=/gm) || []).length, 1,
    'exactly one sso_role_name line should remain');
  assert.match(out, /sso_account_id = 058264301523/);
});

test('UNIT: migration leaves other profiles untouched', () => {
  const out = upsertAccountProfileText(LEGACY_SSO_DEV, 'sso-dev', '058264301523', 'global_admin');
  assert.match(out, /^\[default\]\s*$/m, 'the [default] section must survive');
});

test('UNIT: a fresh profile is created bound to the sso-session', () => {
  const base = '[default]\nregion = ap-southeast-2\n';
  const out = upsertAccountProfileText(base, 'sso-staging', '111122223333', 'RegionalAdmin');
  assert.match(out, /^\[profile sso-staging\]\s*$/m);
  assert.match(out, /^sso_session = claude-cmd-ui\s*$/m);
  assert.match(out, /^sso_account_id = 111122223333\s*$/m);
  assert.match(out, /^sso_role_name = RegionalAdmin\s*$/m);
  assert.doesNotMatch(out, /sso_start_url/, 'a fresh dynamic profile is session-only');
});

test('UNIT: re-applying to an already-migrated profile is idempotent', () => {
  const once = upsertAccountProfileText(LEGACY_SSO_DEV, 'sso-dev', '058264301523', 'global_admin');
  const twice = upsertAccountProfileText(once, 'sso-dev', '058264301523', 'global_admin');
  assert.equal(twice, once, 'a second migration pass must not change the config');
  assert.equal((twice.match(/^\s*sso_session\s*=/gm) || []).length, 1,
    'exactly one sso_session line should remain');
});
