'use strict';

// ===========================================================================
// Claude variables (/dev/claude-cmd-ui secret → .env) — UNIT tests.
//
// Covers the three pure transforms behind the "Claude variables ⬇" button:
//
//   envKeyFromSecretKey  human-written secret keys ("slack token", "slackToken")
//                        → the SCREAMING_SNAKE names .env actually uses.
//   envVarsFromSecret    the secret's JSON → { vars, skipped }, where every
//                        rejection is REPORTED rather than silently dropped.
//   pickDevAccount       which discovered SSO account counts as "dev".
//
// The behaviour most worth pinning down is that EVERY key in the secret comes
// back, including ones with an empty value — .env should list everything the
// secret defines, not just the keys someone has filled in. The separate question
// of whether an empty value may overwrite an existing local value belongs to
// main.js, which keeps the local value; envVarsFromSecret only reports the key.
//
// No filesystem, AWS CLI, or Electron is touched.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { __testing } = require('../lib/aws');
const { envKeyFromSecretKey, envVarsFromSecret, pickDevAccount } = __testing;

// --- envKeyFromSecretKey -----------------------------------------------------

test('envKeyFromSecretKey normalizes every spelling onto one .env key', () => {
  for (const spelling of ['slack token', 'slackToken', 'Slack-Token', 'SLACK_TOKEN', ' slack.token ']) {
    assert.equal(envKeyFromSecretKey(spelling), 'SLACK_TOKEN', `for ${JSON.stringify(spelling)}`);
  }
});

test('envKeyFromSecretKey returns keys env-store will accept', () => {
  const valid = /^[A-Za-z_][A-Za-z0-9_]*$/; // env-store.set's own guard
  for (const raw of ['atlassian.cloud id', '2fa secret', 'a--b__c', 'Anthropic  Key']) {
    const key = envKeyFromSecretKey(raw);
    assert.match(key, valid, `${JSON.stringify(raw)} produced ${JSON.stringify(key)}`);
  }
});

test('envKeyFromSecretKey yields nothing usable from junk', () => {
  for (const raw of ['', '   ', '___', '---', null, undefined]) {
    assert.equal(envKeyFromSecretKey(raw), '');
  }
});

// --- envVarsFromSecret -------------------------------------------------------

test('envVarsFromSecret maps a well-formed secret onto .env keys', () => {
  const { vars, skipped } = envVarsFromSecret(JSON.stringify({
    'slack token': 'xoxb-abc',
    slackAppToken: 'xapp-def',
    'Atlassian-Client-Id': 'client-123'
  }));
  assert.deepEqual(vars, {
    SLACK_TOKEN: 'xoxb-abc',
    SLACK_APP_TOKEN: 'xapp-def',
    ATLASSIAN_CLIENT_ID: 'client-123'
  });
  assert.deepEqual(skipped, []);
});

test('envVarsFromSecret returns keys the secret has not filled in yet', () => {
  const { vars, skipped } = envVarsFromSecret(JSON.stringify({
    TELEMETRY_FORWARD_URL: '',
    TELEMETRY_FORWARD_TOKEN: '   ',
    TELEMETRY_ENABLED: '1'
  }));
  assert.deepEqual(vars, {
    TELEMETRY_FORWARD_URL: '',
    TELEMETRY_FORWARD_TOKEN: '   ',
    TELEMETRY_ENABLED: '1'
  }, 'every key in the secret comes back, filled in or not');
  assert.deepEqual(skipped, []);
});

test('envVarsFromSecret refuses values that cannot round-trip through .env', () => {
  // env-store's parser is line-based, so a newline in a value would read back
  // as a truncated value plus a garbage line.
  const { vars, skipped } = envVarsFromSecret(JSON.stringify({ pem: 'line1\nline2', ok: 'fine' }));
  assert.deepEqual(vars, { OK: 'fine' });
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].key, 'pem');
  assert.match(skipped[0].reason, /multiple lines/);
});

test('envVarsFromSecret reports collisions instead of silently overwriting', () => {
  const { vars, skipped } = envVarsFromSecret(JSON.stringify({
    'slack token': 'first',
    'slack-token': 'second'
  }));
  assert.deepEqual(vars, { SLACK_TOKEN: 'first' }, 'first spelling wins');
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /collides/);
});

test('envVarsFromSecret stringifies structured values and skips nulls', () => {
  const { vars, skipped } = envVarsFromSecret(JSON.stringify({
    nested: { a: 1 },
    count: 42,
    flag: false,
    missing: null
  }));
  assert.equal(vars.NESTED, '{"a":1}');
  assert.equal(vars.COUNT, '42');
  assert.equal(vars.FLAG, 'false', 'false is a real value, not an absent one');
  assert.equal(vars.MISSING, undefined);
  assert.deepEqual(skipped.map((s) => s.key), ['missing']);
});

test('envVarsFromSecret rejects a secret that is not a JSON object', () => {
  assert.throws(() => envVarsFromSecret('not json'), /not valid JSON/);
  assert.throws(() => envVarsFromSecret('[1,2]'), /must be a JSON object/);
  assert.throws(() => envVarsFromSecret('"a string"'), /must be a JSON object/);
});

// --- pickDevAccount ----------------------------------------------------------

test('pickDevAccount prefers AWS_DEV_ACCOUNT_ID over the name heuristic', (t) => {
  const accounts = [
    { accountId: '111', accountName: 'ohq-prod' },
    { accountId: '222', accountName: 'ohq-dev' }
  ];
  const prev = process.env.AWS_DEV_ACCOUNT_ID;
  t.after(() => {
    if (prev === undefined) delete process.env.AWS_DEV_ACCOUNT_ID;
    else process.env.AWS_DEV_ACCOUNT_ID = prev;
  });

  process.env.AWS_DEV_ACCOUNT_ID = '111';
  assert.equal(pickDevAccount(accounts).accountId, '111', 'explicit id wins');

  delete process.env.AWS_DEV_ACCOUNT_ID;
  assert.equal(pickDevAccount(accounts).accountId, '222', 'falls back to the name match');
});

test('pickDevAccount returns null rather than guessing when no account looks like dev', (t) => {
  const prev = process.env.AWS_DEV_ACCOUNT_ID;
  t.after(() => {
    if (prev === undefined) delete process.env.AWS_DEV_ACCOUNT_ID;
    else process.env.AWS_DEV_ACCOUNT_ID = prev;
  });
  delete process.env.AWS_DEV_ACCOUNT_ID;

  assert.equal(pickDevAccount([{ accountId: '1', accountName: 'ohq-prod' }]), null);
  assert.equal(pickDevAccount([]), null);
  assert.equal(pickDevAccount(null), null);
  // "developer" must not be mistaken for the dev account.
  assert.equal(pickDevAccount([{ accountId: '3', accountName: 'developer-sandbox' }]), null);
});
