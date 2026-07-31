'use strict';

// ===========================================================================
// normalizeSsoUrl — UNIT tests.
//
// Regression coverage for a real bug: a copy-pasted AWS_SSO_START_URL carrying
// a trailing SPA route fragment ("#/") or slash made the cached-token
// startUrl comparison in readSsoToken/readSsoAccessToken fail even though the
// cached token was valid, so `aws sso login` appeared to succeed but the app
// reported "No SSO access token found in cache after login".
//
// No filesystem, AWS CLI, or Electron is touched.
// ===========================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { __testing } = require('../lib/aws');
const { normalizeSsoUrl } = __testing;

test('UNIT: normalizeSsoUrl leaves an already-clean URL unchanged', () => {
  assert.equal(
    normalizeSsoUrl('https://d-976741486c.awsapps.com/start'),
    'https://d-976741486c.awsapps.com/start'
  );
});

test('UNIT: normalizeSsoUrl strips a trailing SPA route fragment', () => {
  assert.equal(
    normalizeSsoUrl('https://d-976741486c.awsapps.com/start#/'),
    'https://d-976741486c.awsapps.com/start'
  );
  assert.equal(
    normalizeSsoUrl('https://d-976741486c.awsapps.com/start#/device'),
    'https://d-976741486c.awsapps.com/start'
  );
});

test('UNIT: normalizeSsoUrl strips trailing slash(es)', () => {
  assert.equal(
    normalizeSsoUrl('https://d-976741486c.awsapps.com/start/'),
    'https://d-976741486c.awsapps.com/start'
  );
  assert.equal(
    normalizeSsoUrl('https://d-976741486c.awsapps.com/start///'),
    'https://d-976741486c.awsapps.com/start'
  );
});

test('UNIT: normalizeSsoUrl strips a query string', () => {
  assert.equal(
    normalizeSsoUrl('https://d-976741486c.awsapps.com/start?tab=account'),
    'https://d-976741486c.awsapps.com/start'
  );
});

test('UNIT: normalizeSsoUrl handles fragment + trailing slash combined', () => {
  assert.equal(
    normalizeSsoUrl('https://d-976741486c.awsapps.com/start/#/'),
    'https://d-976741486c.awsapps.com/start'
  );
});
